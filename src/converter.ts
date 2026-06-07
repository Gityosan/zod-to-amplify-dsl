import { z } from "zod"
import { getModelConfig, getStorageConfig } from "./registry"
import type {
  AuthRule,
  ConversionResult,
  ConversionWarning,
  CustomTypeSummary,
  FieldMeta,
  IndexDef,
  ModelConfig,
  ModelSummary,
  RelationFieldMeta,
  SchemaSummary,
  StorageAccessRule,
  StorageFieldConfig,
  StoragePathSummary,
} from "./types"

export type SchemaInput = Record<string, z.ZodObject<z.ZodRawShape>>

type CustomTypeMap = Map<z.ZodObject<z.ZodRawShape>, string>

// Amplify manages these fields automatically; never add .required()
const AMPLIFY_AUTO_FIELDS = new Set(["createdAt", "updatedAt"])

// Secure-by-default access when a storageField() omits `access`: signed-in users
// may read/write/delete, guests get nothing.
const DEFAULT_STORAGE_ACCESS: StorageAccessRule[] = [
  { allow: "authenticated", to: ["read", "write", "delete"] },
]

// Default name passed to defineStorage({ name }).
const DEFAULT_STORAGE_NAME = "media"

/** storageField() may be registered on the raw field schema (when .optional()
 *  is applied after) or on the unwrapped inner schema; check both. */
function resolveStorageConfig(
  fieldSchema: z.ZodTypeAny,
  inner: z.ZodTypeAny,
): StorageFieldConfig | undefined {
  return getStorageConfig(fieldSchema) ?? getStorageConfig(inner)
}

// ---- type unwrapping ----

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional) return unwrap(schema.unwrap() as z.ZodTypeAny)
  if (schema instanceof z.ZodNullable) return unwrap(schema.unwrap() as z.ZodTypeAny)
  if (schema instanceof z.ZodDefault) return unwrap(schema._def.innerType as z.ZodTypeAny)
  if (schema instanceof z.ZodLazy) return unwrap(schema._def.getter() as z.ZodTypeAny)
  return schema
}

function isOptionalField(schema: z.ZodTypeAny): boolean {
  return (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
}

function extractDefault(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodDefault) {
    return (schema._def as { defaultValue: unknown }).defaultValue
  }
  if (schema instanceof z.ZodOptional) return extractDefault(schema.unwrap() as z.ZodTypeAny)
  return undefined
}

// ---- model lookup ----

function findModelName(candidate: z.ZodTypeAny, models: SchemaInput): string | undefined {
  const inner = unwrap(candidate)
  return Object.entries(models).find(([, s]) => s === inner)?.[0]
}

// ---- custom type collection ----

function collectCustomTypes(models: SchemaInput): CustomTypeMap {
  const result: CustomTypeMap = new Map()
  const usedNames = new Set<string>(Object.keys(models))

  function processShape(shape: z.ZodRawShape) {
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      let obj: z.ZodObject<z.ZodRawShape> | null = null
      if (inner instanceof z.ZodObject) {
        obj = inner as z.ZodObject<z.ZodRawShape>
      } else if (inner instanceof z.ZodArray) {
        const elem = unwrap(inner.element as z.ZodTypeAny)
        if (elem instanceof z.ZodObject) obj = elem as z.ZodObject<z.ZodRawShape>
      }
      if (!obj) continue
      if (Object.values(models).some((m) => m === obj)) continue
      if (result.has(obj)) continue
      const base = capitalize(fieldName)
      let name = base
      let i = 2
      while (usedNames.has(name)) name = base + i++
      usedNames.add(name)
      result.set(obj, name)
      processShape(obj.shape)
    }
  }

  for (const schema of Object.values(models)) processShape(schema.shape)
  return result
}

// ---- schema-level enum collection ----

interface SchemaEnumCollection {
  entries: Map<string, readonly string[]> // enumName → values
  byValuesKey: Map<string, string> // JSON(sorted values) → enumName
}

function extractEnumValues(inner: z.ZodTypeAny): string[] | null {
  if (inner instanceof z.ZodEnum) {
    return [...(inner as unknown as { options: readonly string[] }).options]
  }
  if (inner instanceof z.ZodLiteral) {
    const v = (inner._def as { values?: unknown[] }).values?.[0]
    if (typeof v === "string") return [v]
  }
  if (inner instanceof z.ZodUnion) {
    const opts = (inner as unknown as { options: z.ZodTypeAny[] }).options ?? []
    const strs = opts.map((o) => {
      if (!(o instanceof z.ZodLiteral)) return null
      const v = (o._def as { values?: unknown[] }).values?.[0]
      return typeof v === "string" ? v : null
    })
    if (strs.every((v) => v !== null)) return strs as string[]
  }
  return null
}

function collectSchemaEnums(models: SchemaInput, customTypes: CustomTypeMap): SchemaEnumCollection {
  const entries = new Map<string, readonly string[]>()
  const byValuesKey = new Map<string, string>()
  const usedNames = new Set<string>([...Object.keys(models), ...customTypes.values()])

  function processField(fieldName: string, schema: z.ZodTypeAny) {
    const inner = unwrap(schema)

    // Handle direct enum or array-of-enum
    const directValues = extractEnumValues(inner)
    if (directValues) register(fieldName, directValues)
    else if (inner instanceof z.ZodArray) {
      const elemValues = extractEnumValues(unwrap(inner.element as z.ZodTypeAny))
      if (elemValues) register(fieldName, elemValues)
    }
  }

  function register(fieldName: string, values: string[]) {
    const key = JSON.stringify(values.slice().sort())
    if (byValuesKey.has(key)) return
    const base = capitalize(fieldName)
    let name = base
    let i = 2
    while (usedNames.has(name)) name = base + i++
    usedNames.add(name)
    byValuesKey.set(key, name)
    entries.set(name, values)
  }

  for (const schema of Object.values(models)) {
    for (const [fieldName, fieldSchema] of Object.entries(schema.shape)) {
      processField(fieldName, fieldSchema as z.ZodTypeAny)
    }
  }
  for (const [ctSchema] of customTypes) {
    for (const [fieldName, fieldSchema] of Object.entries(ctSchema.shape)) {
      processField(fieldName, fieldSchema as z.ZodTypeAny)
    }
  }
  return { entries, byValuesKey }
}

// ---- field type mapping ----

type CheckEntry = { format?: string; isInt?: boolean }
type DefWithChecks = { type?: string; format?: string; checks?: CheckEntry[] }

// Zod v4 integer number-format identifiers (z.int()/z.int32()/...). Float formats
// (float32/float64) are excluded so they map to a.float().
const INT_FORMATS = new Set(["safeint", "int32", "uint32", "int64", "uint64"])

/** supportsDefault: whether this type supports .default() chaining (a.ref() does not) */
function amplifyFieldType(
  fieldName: string,
  schema: z.ZodTypeAny,
  customTypes: CustomTypeMap = new Map(),
  enumsByValues: Map<string, string> = new Map(),
): { type: string; unknown?: string; supportsDefault: boolean } {
  if (fieldName === "id") return { type: "a.id()", supportsDefault: true }

  const inner = unwrap(schema)

  // Storage fields hold the S3 key; always a plain string regardless of inner type.
  if (resolveStorageConfig(schema, inner)) return { type: "a.string()", supportsDefault: true }

  // Dedicated Zod v4 ISO classes (z.iso.date()/time()/datetime()) — these are not
  // ZodString subclasses and carry no format check, so match them by type first.
  if (inner instanceof z.ZodISODateTime) return { type: "a.datetime()", supportsDefault: true }
  if (inner instanceof z.ZodISODate) return { type: "a.date()", supportsDefault: true }
  if (inner instanceof z.ZodISOTime) return { type: "a.time()", supportsDefault: true }

  // Zod v4 top-level string formats (z.email(), z.url(), z.uuid(), z.ipv4()...) are
  // dedicated subclasses that are NOT `instanceof z.ZodString`; they store the format
  // in `_def.format`. The v3-style `z.string().email()` keeps it in `_def.checks[]`.
  // Match both: ZodString instances and any def whose `type` is "string".
  const strDef = inner._def as DefWithChecks
  if (inner instanceof z.ZodString || strDef.type === "string") {
    const formats = [strDef.format, ...(strDef.checks ?? []).map((c) => c.format)].filter(
      Boolean,
    ) as string[]
    if (formats.includes("datetime")) return { type: "a.datetime()", supportsDefault: true }
    if (formats.includes("date")) return { type: "a.date()", supportsDefault: true }
    if (formats.includes("time")) return { type: "a.time()", supportsDefault: true }
    if (formats.includes("email")) return { type: "a.email()", supportsDefault: true }
    if (formats.includes("url")) return { type: "a.url()", supportsDefault: true }
    if (formats.includes("e164")) return { type: "a.phone()", supportsDefault: true }
    if (formats.includes("uuid") || fieldName.endsWith("Id"))
      return { type: "a.id()", supportsDefault: true }
    if (formats.includes("ipv4") || formats.includes("ipv6"))
      return { type: "a.ipAddress()", supportsDefault: true }
    return { type: "a.string()", supportsDefault: true }
  }

  if (inner instanceof z.ZodNumber) {
    // v3: `z.number().int()` records `isInt`/a `safeint` check; v4: `z.int()`/`z.int32()`
    // are number-format subclasses carrying the format in `_def.format` with no checks.
    const checks = (strDef.checks ?? []) as CheckEntry[]
    const isInt =
      INT_FORMATS.has(strDef.format ?? "") ||
      checks.some((c) => c.isInt || INT_FORMATS.has(c.format ?? ""))
    return { type: isInt ? "a.integer()" : "a.float()", supportsDefault: true }
  }

  if (inner instanceof z.ZodBoolean) return { type: "a.boolean()", supportsDefault: true }
  if (inner instanceof z.ZodDate) return { type: "a.datetime()", supportsDefault: true }

  // Enum types → always use a.ref() to schema-level enum (a.enum() has no .required()/.default())
  const enumValues = extractEnumValues(inner)
  if (enumValues !== null) {
    const key = JSON.stringify(enumValues.slice().sort())
    const enumName = enumsByValues.get(key)
    if (enumName) return { type: `a.ref("${enumName}")`, supportsDefault: false }
    // fallback (shouldn't happen if collectSchemaEnums was called first)
    return { type: "a.json()", unknown: "enum", supportsDefault: true }
  }

  // Scalar or custom-type array
  if (inner instanceof z.ZodArray) {
    const elemInner = unwrap(inner.element as z.ZodTypeAny)
    if (elemInner instanceof z.ZodObject) {
      const name = customTypes.get(elemInner as z.ZodObject<z.ZodRawShape>)
      if (name) return { type: `a.ref("${name}").array()`, supportsDefault: false }
      return { type: "a.json()", unknown: "object[]", supportsDefault: true }
    }
    // Array of enum
    const elemEnumVals = extractEnumValues(elemInner)
    if (elemEnumVals !== null) {
      const key = JSON.stringify(elemEnumVals.slice().sort())
      const enumName = enumsByValues.get(key)
      if (enumName) return { type: `a.ref("${enumName}").array()`, supportsDefault: false }
    }
    // Recurse with empty fieldName to avoid id/FK heuristics on element
    const elemResult = amplifyFieldType("", elemInner, customTypes, enumsByValues)
    return {
      type: `${elemResult.type}.array()`,
      unknown: elemResult.unknown,
      supportsDefault: false,
    }
  }

  // Non-model object → custom type reference
  if (inner instanceof z.ZodObject) {
    const name = customTypes.get(inner as z.ZodObject<z.ZodRawShape>)
    if (name) return { type: `a.ref("${name}")`, supportsDefault: false }
    return { type: "a.json()", unknown: "object", supportsDefault: true }
  }

  // z.any() / z.unknown() → intentional JSON, no warning
  if (inner instanceof z.ZodAny || inner instanceof z.ZodUnknown) {
    return { type: "a.json()", supportsDefault: true }
  }

  // record / tuple are JSON-serializable structures → intentional JSON, no warning.
  // (map / set / bigint fall through to the warning fallback below since they
  //  have no faithful Amplify/JSON representation.)
  if (inner instanceof z.ZodRecord || inner instanceof z.ZodTuple) {
    return { type: "a.json()", supportsDefault: true }
  }

  // Literal(number/boolean) stays as scalar
  if (inner instanceof z.ZodLiteral) {
    const value = (inner._def as { values?: unknown[] }).values?.[0]
    if (typeof value === "number")
      return { type: Number.isInteger(value) ? "a.integer()" : "a.float()", supportsDefault: true }
    if (typeof value === "boolean") return { type: "a.boolean()", supportsDefault: true }
    return { type: "a.json()", unknown: "literal", supportsDefault: true }
  }

  // Unknown → fall back to a.json()
  const zodType = (inner._def as { type?: string }).type ?? inner.constructor?.name ?? "unknown"
  return { type: "a.json()", unknown: zodType, supportsDefault: true }
}

// ---- validation extraction ----

// Amplify's .validate() is only available on a.string()/a.integer()/a.float()
// (FieldTypeToValidationBuilder is `never` for every other field type).
const VALIDATABLE_TYPES = new Set(["a.string()", "a.integer()", "a.float()"])

/** A single Amplify validation call, e.g. "minLength(2)" or `matches("^a$")`. */
type ValidationCall = string

function checkDef(c: unknown): Record<string, unknown> | undefined {
  const wrapped = (c as { _zod?: { def?: Record<string, unknown> } })._zod?.def
  return wrapped ?? (c as Record<string, unknown> | undefined)
}

/** Extract Amplify-expressible validation calls from a Zod string/number.
 *  Deduped by method name — Amplify rejects duplicate operators on one field. */
function extractValidations(inner: z.ZodTypeAny): ValidationCall[] {
  const byMethod = new Map<string, ValidationCall>()
  const set = (method: string, arg: string) => byMethod.set(method, `${method}(${arg})`)

  const idef = inner._def as { type?: string; checks?: unknown[] }
  if (inner instanceof z.ZodString || idef.type === "string") {
    for (const c of idef.checks ?? []) {
      const def = checkDef(c)
      if (!def) continue
      if (def.check === "min_length") set("minLength", String(def.minimum))
      else if (def.check === "max_length") set("maxLength", String(def.maximum))
      else if (def.check === "string_format") {
        if (def.format === "regex") {
          const src = (def.pattern as RegExp | undefined)?.source
          if (src) set("matches", JSON.stringify(src))
        } else if (def.format === "starts_with") set("startsWith", JSON.stringify(def.prefix))
        else if (def.format === "ends_with") set("endsWith", JSON.stringify(def.suffix))
      }
    }
  } else if (inner instanceof z.ZodNumber) {
    for (const c of (inner._def as { checks?: unknown[] }).checks ?? []) {
      const def = checkDef(c)
      if (!def || def.value === undefined) continue
      if (def.check === "greater_than") set(def.inclusive ? "gte" : "gt", String(def.value))
      else if (def.check === "less_than") set(def.inclusive ? "lte" : "lt", String(def.value))
    }
  }
  return [...byMethod.values()]
}

/** `.validate(v => v.minLength(2).maxLength(10))` for validatable scalar types. */
function renderValidate(calls: ValidationCall[]): string {
  return calls.length ? `.validate((v) => v.${calls.join(".")})` : ""
}

/** Inline comment fallback for constraints we can't express as .validate()
 *  (e.g. minLength on an a.email() field). */
function renderValidationComment(calls: ValidationCall[]): string {
  return calls.length ? ` // zod: ${calls.join(", ")}` : ""
}

// ---- manyToMany detection ----

function buildHasManyMap(models: SchemaInput): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>()
  for (const [modelName, schema] of Object.entries(models)) {
    const fields = new Map<string, string>()
    for (const [fieldName, fieldSchema] of Object.entries(schema.shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      if (!(inner instanceof z.ZodArray)) continue
      const targetName = findModelName(inner.element as z.ZodTypeAny, models)
      if (targetName) fields.set(fieldName, targetName)
    }
    map.set(modelName, fields)
  }
  return map
}

function detectManyToManyPairs(models: SchemaInput): Set<string> {
  const hasManyMap = buildHasManyMap(models)
  const pairs = new Set<string>()
  for (const [modelA, fields] of hasManyMap) {
    for (const [, modelB] of fields) {
      const bFields = hasManyMap.get(modelB)
      if (bFields && [...bFields.values()].includes(modelA)) {
        pairs.add([modelA, modelB].sort().join(":"))
      }
    }
  }
  return pairs
}

// ---- FK resolution ----

function findBelongsToFk(
  fieldName: string,
  targetModelName: string,
  ownerShape: z.ZodRawShape,
): string | undefined {
  const byFieldName = fieldName + "Id"
  if (byFieldName in ownerShape) return byFieldName
  const byTargetName = lcFirst(targetModelName) + "Id"
  if (byTargetName in ownerShape) return byTargetName
  return undefined
}

function findHasManyFk(
  ownerModelName: string,
  targetModelName: string,
  models: SchemaInput,
): string {
  const targetSchema = models[targetModelName]
  if (!targetSchema) return lcFirst(ownerModelName) + "Id"
  const targetShape = targetSchema.shape

  for (const [tFieldName, tFieldSchema] of Object.entries(targetShape)) {
    const tInner = unwrap(tFieldSchema as z.ZodTypeAny)
    if (!(tInner instanceof z.ZodObject)) continue
    if (findModelName(tInner, models) !== ownerModelName) continue
    const fk = findBelongsToFk(tFieldName, ownerModelName, targetShape)
    if (fk) return fk
  }

  const conventional = lcFirst(ownerModelName) + "Id"
  if (conventional in targetShape) return conventional

  const fkCandidates: string[] = []
  for (const [fname, fschema] of Object.entries(targetShape)) {
    if (fname === "id" || !fname.endsWith("Id")) continue
    const fInner = unwrap(fschema as z.ZodTypeAny)
    if (fInner instanceof z.ZodString) fkCandidates.push(fname)
  }
  if (fkCandidates.length === 1) return fkCandidates[0]

  return conventional
}

// ---- code generation helpers ----

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

function genAuth(rules: AuthRule[]): string {
  // operations → `.to([...])`
  const to = (ops?: AuthRule["operations"]) =>
    ops?.length ? `.to([${ops.map((o) => `"${o}"`).join(", ")}])` : ""
  // optional trailing provider argument
  const prov = (p?: string) => (p ? `, "${p}"` : "")

  const parts = rules.map((rule): string => {
    switch (rule.allow) {
      case "owner":
        return rule.ownerField
          ? `allow.ownerDefinedIn("${rule.ownerField}"${prov(rule.provider)})${to(rule.operations)}`
          : `allow.owner(${rule.provider ? `"${rule.provider}"` : ""})${to(rule.operations)}`
      case "multipleOwners":
        return `allow.ownersDefinedIn("${rule.ownersField}"${prov(rule.provider)})${to(rule.operations)}`
      case "public":
        return `allow.publicApiKey()${to(rule.operations)}`
      case "guest":
        return `allow.guest()${to(rule.operations)}`
      case "authenticated":
        return `allow.authenticated(${rule.provider ? `"${rule.provider}"` : ""})${to(rule.operations)}`
      case "group":
        return `allow.group("${rule.group}"${prov(rule.provider)})${to(rule.operations)}`
      case "groups":
        return `allow.groups([${rule.groups.map((g) => `"${g}"`).join(", ")}]${prov(rule.provider)})${to(rule.operations)}`
      case "custom":
        return `allow.custom(${rule.provider ? `"${rule.provider}"` : ""})${to(rule.operations)}`
    }
  })
  return `.authorization(allow => [${parts.join(", ")}])`
}

function genIndexes(indexes: IndexDef[]): string {
  const parts = indexes.map((idx) => {
    const sk = idx.sk ? `.sortKeys(["${idx.sk}"])` : ""
    const qf = idx.queryField ? `.queryField("${idx.queryField}")` : ""
    return `index("${idx.pk}")${sk}.name("${idx.name}")${qf}`
  })
  return `.secondaryIndexes(index => [${parts.join(", ")}])`
}

function genPrimaryKey(fields: string[]): string {
  return `.identifier([${fields.map((f) => `"${f}"`).join(", ")}])`
}

function genDisableOperations(ops: string[]): string {
  return `.disableOperations([${ops.map((o) => `"${o}"`).join(", ")}])`
}

// ---- junction model generation (replaces a.manyToMany) ----

function genJunctionModels(manyToManyPairs: Set<string>): string[] {
  const lines: string[] = []
  for (const pairKey of manyToManyPairs) {
    const [modelA, modelB] = pairKey.split(":")
    const junctionName = modelA + modelB
    const fkA = lcFirst(modelA) + "Id"
    const fkB = lcFirst(modelB) + "Id"
    lines.push(`  ${junctionName}: a.model({`)
    lines.push(`    ${fkA}: a.id().required(),`)
    lines.push(`    ${fkB}: a.id().required(),`)
    lines.push(`    ${lcFirst(modelA)}: a.belongsTo("${modelA}", "${fkA}"),`)
    lines.push(`    ${lcFirst(modelB)}: a.belongsTo("${modelB}", "${fkB}"),`)
    lines.push(`  }),`)
  }
  return lines
}

// ---- storage (S3) collection & generation ----

/** Walk every model + custom-type field, collect storageField() configs and
 *  group them by S3 path (merging/deduping access rules across fields). */
function collectStoragePaths(
  models: SchemaInput,
  customTypes: CustomTypeMap,
): StoragePathSummary[] {
  const byPath = new Map<string, StorageAccessRule[]>()
  const order: string[] = []

  function add(cfg: StorageFieldConfig) {
    const rules = cfg.access?.length ? cfg.access : DEFAULT_STORAGE_ACCESS
    if (!byPath.has(cfg.path)) {
      byPath.set(cfg.path, [])
      order.push(cfg.path)
    }
    const existing = byPath.get(cfg.path)!
    const seen = new Set(existing.map((r) => JSON.stringify(r)))
    for (const rule of rules) {
      const key = JSON.stringify(rule)
      if (!seen.has(key)) {
        seen.add(key)
        existing.push(rule)
      }
    }
  }

  function processShape(shape: z.ZodRawShape) {
    for (const [, fieldSchema] of Object.entries(shape)) {
      const cfg = resolveStorageConfig(
        fieldSchema as z.ZodTypeAny,
        unwrap(fieldSchema as z.ZodTypeAny),
      )
      if (cfg) add(cfg)
    }
  }

  for (const schema of Object.values(models)) processShape(schema.shape)
  for (const [ctSchema] of customTypes) processShape(ctSchema.shape)

  return order.map((path) => ({ path, access: byPath.get(path)! }))
}

function genStorageAccessRule(rule: StorageAccessRule): string {
  const to = `.to([${rule.to.map((a) => `"${a}"`).join(", ")}])`
  switch (rule.allow) {
    case "guest":
      return `allow.guest${to}`
    case "authenticated":
      return `allow.authenticated${to}`
    case "owner":
      // Amplify expresses per-user ownership on storage via the identity entity.
      return `allow.entity("identity")${to}`
    case "groups":
      return `allow.groups([${rule.groups.map((g) => `"${g}"`).join(", ")}])${to}`
  }
}

/** Produce the contents of the separate amplify/storage/resource.ts file. */
function genStorageResource(paths: StoragePathSummary[], name: string): string {
  const lines: string[] = [
    'import { defineStorage } from "@aws-amplify/backend"',
    "",
    "export const storage = defineStorage({",
    `  name: "${name}",`,
    "  access: (allow) => ({",
  ]
  for (const { path, access } of paths) {
    lines.push(`    "${path}": [`)
    for (const rule of access) lines.push(`      ${genStorageAccessRule(rule)},`)
    lines.push("    ],")
  }
  lines.push("  }),", "})", "")
  return lines.join("\n")
}

// ---- main converter ----

export function zodToAmplify(
  models: SchemaInput,
  options: { storageName?: string } = {},
): ConversionResult {
  const customTypes = collectCustomTypes(models)
  const schemaEnums = collectSchemaEnums(models, customTypes)
  const manyToManyPairs = detectManyToManyPairs(models)
  const storagePaths = collectStoragePaths(models, customTypes)
  const warnings: ConversionWarning[] = []

  const lines: string[] = [
    'import { a } from "@aws-amplify/backend"',
    "",
    "const schema = a.schema({",
  ]

  for (const [modelName, schema] of Object.entries(models)) {
    const config: ModelConfig = getModelConfig(schema) ?? {}
    const shape = schema.shape

    lines.push(`  ${modelName}: a.model({`)

    // Scalar + custom-type fields
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      if (inner instanceof z.ZodObject && findModelName(inner, models)) continue
      if (inner instanceof z.ZodArray && findModelName(inner.element as z.ZodTypeAny, models))
        continue

      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const isAutoField = AMPLIFY_AUTO_FIELDS.has(fieldName)
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const {
        type: base,
        unknown: unknownType,
        supportsDefault,
      } = amplifyFieldType(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        customTypes,
        schemaEnums.byValuesKey,
      )

      if (unknownType) warnings.push({ model: modelName, field: fieldName, zodType: unknownType })

      const required =
        !opt && !isAutoField && fieldName !== "id" && defaultVal === undefined ? ".required()" : ""
      const defaultSuffix =
        supportsDefault && defaultVal !== undefined ? `.default(${JSON.stringify(defaultVal)})` : ""
      // If default was dropped due to ref type, note it in a comment
      const droppedDefault =
        !supportsDefault && defaultVal !== undefined
          ? ` // zod: default(${JSON.stringify(defaultVal)})`
          : ""
      const storageCfg = resolveStorageConfig(fieldSchema as z.ZodTypeAny, inner)
      const storageComment = storageCfg ? ` // zod: storage(path="${storageCfg.path}")` : ""
      const validations = inner instanceof z.ZodArray ? [] : extractValidations(inner)
      const canValidate = VALIDATABLE_TYPES.has(base)
      const validateSuffix = canValidate ? renderValidate(validations) : ""
      const validationComment = canValidate ? "" : renderValidationComment(validations)
      const fieldAuth = config.fieldAuth?.[fieldName]
      const authSuffix = fieldAuth?.length ? genAuth(fieldAuth) : ""

      lines.push(
        `    ${fieldName}: ${base}${defaultSuffix}${validateSuffix}${required}${authSuffix},${storageComment || droppedDefault || validationComment}`,
      )
    }

    // Model relation fields
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)

      if (inner instanceof z.ZodArray) {
        const targetName = findModelName(inner.element as z.ZodTypeAny, models)
        if (!targetName) continue
        const pairKey = [modelName, targetName].sort().join(":")
        if (manyToManyPairs.has(pairKey)) {
          // Amplify Gen 2 has no a.manyToMany(); use hasMany → junction model
          const junctionName = pairKey.replace(":", "")
          const fkField = lcFirst(modelName) + "Id"
          lines.push(`    ${fieldName}: a.hasMany("${junctionName}", "${fkField}"),`)
        } else {
          const fkField = findHasManyFk(modelName, targetName, models)
          lines.push(`    ${fieldName}: a.hasMany("${targetName}", "${fkField}"),`)
        }
        continue
      }

      if (inner instanceof z.ZodObject) {
        const targetName = findModelName(inner, models)
        if (!targetName) continue
        const fk = findBelongsToFk(fieldName, targetName, shape)
        if (fk) {
          lines.push(`    ${fieldName}: a.belongsTo("${targetName}", "${fk}"),`)
        } else {
          lines.push(`    ${fieldName}: a.hasOne("${targetName}", "${lcFirst(modelName)}Id"),`)
        }
      }
    }

    let chain = ""
    if (config.primaryKey?.length) chain += genPrimaryKey(config.primaryKey)
    if (config.indexes?.length) chain += genIndexes(config.indexes)
    if (config.disabledOperations?.length) chain += genDisableOperations(config.disabledOperations)
    if (config.auth?.length) chain += genAuth(config.auth)

    lines.push(`  })${chain},`)
  }

  // Junction models for manyToMany pairs
  lines.push(...genJunctionModels(manyToManyPairs))

  // Custom type definitions
  for (const [ctSchema, typeName] of customTypes) {
    lines.push(`  ${typeName}: a.customType({`)
    for (const [fieldName, fieldSchema] of Object.entries(ctSchema.shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const {
        type: base,
        unknown: unknownType,
        supportsDefault,
      } = amplifyFieldType(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        customTypes,
        schemaEnums.byValuesKey,
      )
      if (unknownType) warnings.push({ model: typeName, field: fieldName, zodType: unknownType })
      const required = !opt && fieldName !== "id" && defaultVal === undefined ? ".required()" : ""
      const defaultSuffix =
        supportsDefault && defaultVal !== undefined ? `.default(${JSON.stringify(defaultVal)})` : ""
      const droppedDefault =
        !supportsDefault && defaultVal !== undefined
          ? ` // zod: default(${JSON.stringify(defaultVal)})`
          : ""
      const storageCfg = resolveStorageConfig(fieldSchema as z.ZodTypeAny, inner)
      const storageComment = storageCfg ? ` // zod: storage(path="${storageCfg.path}")` : ""
      const validations = inner instanceof z.ZodArray ? [] : extractValidations(inner)
      const canValidate = VALIDATABLE_TYPES.has(base)
      const validateSuffix = canValidate ? renderValidate(validations) : ""
      const validationComment = canValidate ? "" : renderValidationComment(validations)
      lines.push(
        `    ${fieldName}: ${base}${defaultSuffix}${validateSuffix}${required},${storageComment || droppedDefault || validationComment}`,
      )
    }
    lines.push(`  }),`)
  }

  // Schema-level enum definitions
  for (const [enumName, values] of schemaEnums.entries) {
    lines.push(`  ${enumName}: a.enum([${values.map((v) => `"${v}"`).join(", ")}]),`)
  }

  lines.push("})", "", "export { schema }", "", "export type Schema = typeof schema")

  const storage =
    storagePaths.length > 0
      ? genStorageResource(storagePaths, options.storageName ?? DEFAULT_STORAGE_NAME)
      : undefined

  return { code: lines.join("\n"), warnings, storage }
}

// ---- JSON metadata output ----

export function zodToAmplifyMeta(models: SchemaInput): SchemaSummary {
  const customTypes = collectCustomTypes(models)
  const schemaEnums = collectSchemaEnums(models, customTypes)
  const manyToManyPairs = detectManyToManyPairs(models)
  const storagePaths = collectStoragePaths(models, customTypes)
  const warnings: ConversionWarning[] = []
  const modelSummaries: ModelSummary[] = []

  for (const [modelName, schema] of Object.entries(models)) {
    const config: ModelConfig = getModelConfig(schema) ?? {}
    const shape = schema.shape
    const fields: Record<string, FieldMeta> = {}
    const relations: Record<string, RelationFieldMeta> = {}

    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      if (inner instanceof z.ZodObject && findModelName(inner, models)) continue
      if (inner instanceof z.ZodArray && findModelName(inner.element as z.ZodTypeAny, models))
        continue

      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const isAutoField = AMPLIFY_AUTO_FIELDS.has(fieldName)
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const {
        type: base,
        unknown: unknownType,
        supportsDefault,
      } = amplifyFieldType(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        customTypes,
        schemaEnums.byValuesKey,
      )
      if (unknownType) warnings.push({ model: modelName, field: fieldName, zodType: unknownType })

      const required = !opt && !isAutoField && fieldName !== "id" && defaultVal === undefined
      const validations = inner instanceof z.ZodArray ? [] : extractValidations(inner)
      const hint = validations.length ? validations.join(", ") : undefined

      fields[fieldName] = {
        amplifyType: base,
        required,
        default: supportsDefault ? defaultVal : undefined,
        array: inner instanceof z.ZodArray,
        validationHint: hint,
        storagePath: resolveStorageConfig(fieldSchema as z.ZodTypeAny, inner)?.path,
      }
    }

    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      if (inner instanceof z.ZodArray) {
        const targetName = findModelName(inner.element as z.ZodTypeAny, models)
        if (!targetName) continue
        const pairKey = [modelName, targetName].sort().join(":")
        if (manyToManyPairs.has(pairKey)) {
          const junctionName = pairKey.replace(":", "")
          relations[fieldName] = {
            kind: "manyToMany",
            target: targetName,
            fk: lcFirst(modelName) + "Id",
            relationName: junctionName,
          }
        } else {
          relations[fieldName] = {
            kind: "hasMany",
            target: targetName,
            fk: findHasManyFk(modelName, targetName, models),
          }
        }
      }
      if (inner instanceof z.ZodObject) {
        const targetName = findModelName(inner, models)
        if (!targetName) continue
        const fk = findBelongsToFk(fieldName, targetName, shape)
        relations[fieldName] = fk
          ? { kind: "belongsTo", target: targetName, fk }
          : { kind: "hasOne", target: targetName, fk: lcFirst(modelName) + "Id" }
      }
    }

    modelSummaries.push({
      name: modelName,
      fields,
      relations,
      primaryKey: config.primaryKey,
      indexes: config.indexes as IndexDef[] | undefined,
      auth: config.auth,
      fieldAuth: config.fieldAuth as Record<string, AuthRule[]> | undefined,
      disabledOperations: config.disabledOperations,
    })
  }

  const customTypeSummaries: CustomTypeSummary[] = []
  for (const [ctSchema, typeName] of customTypes) {
    const fields: Record<string, FieldMeta> = {}
    for (const [fieldName, fieldSchema] of Object.entries(ctSchema.shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const {
        type: base,
        unknown: unknownType,
        supportsDefault,
      } = amplifyFieldType(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        customTypes,
        schemaEnums.byValuesKey,
      )
      if (unknownType) warnings.push({ model: typeName, field: fieldName, zodType: unknownType })
      const required = !opt && fieldName !== "id" && defaultVal === undefined
      const validations = inner instanceof z.ZodArray ? [] : extractValidations(inner)
      const hint = validations.length ? validations.join(", ") : undefined
      fields[fieldName] = {
        amplifyType: base,
        required,
        default: supportsDefault ? defaultVal : undefined,
        array: inner instanceof z.ZodArray,
        validationHint: hint,
        storagePath: resolveStorageConfig(fieldSchema as z.ZodTypeAny, inner)?.path,
      }
    }
    customTypeSummaries.push({ name: typeName, fields })
  }

  return {
    models: modelSummaries,
    customTypes: customTypeSummaries,
    warnings,
    storage: storagePaths,
  }
}
