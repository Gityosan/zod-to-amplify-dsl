import { z } from "zod"
import { getModelConfig } from "./registry"
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
} from "./types"

export type SchemaInput = Record<string, z.ZodObject<z.ZodRawShape>>

type CustomTypeMap = Map<z.ZodObject<z.ZodRawShape>, string>

// Amplify manages these fields automatically; never add .required()
const AMPLIFY_AUTO_FIELDS = new Set(["createdAt", "updatedAt"])

// ---- type unwrapping ----

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  // Casts needed because Zod v4 internal types ($ZodType) differ from public types
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

function findModelName(
  candidate: z.ZodTypeAny,
  models: SchemaInput
): string | undefined {
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
      if (Object.values(models).some((m) => m === obj)) continue // skip model refs
      if (result.has(obj)) continue

      const base = capitalize(fieldName)
      let name = base
      let i = 2
      while (usedNames.has(name)) name = base + i++
      usedNames.add(name)
      result.set(obj, name)

      processShape(obj.shape) // recurse into nested custom types
    }
  }

  for (const schema of Object.values(models)) processShape(schema.shape)
  return result
}

// ---- field type mapping ----

type CheckEntry = { format?: string; isInt?: boolean }
type DefWithChecks = { checks?: CheckEntry[] }
type InternalBag = { minimum?: number; maximum?: number; format?: string }
type NumberCheckDef = { check?: string; value?: number }

function amplifyFieldType(
  fieldName: string,
  schema: z.ZodTypeAny,
  customTypes: CustomTypeMap = new Map()
): { type: string; unknown?: string } {
  if (fieldName === "id") return { type: "a.id()" }

  const inner = unwrap(schema)

  if (inner instanceof z.ZodString) {
    const formats = ((inner._def as DefWithChecks).checks ?? [])
      .map((c) => c.format)
      .filter(Boolean) as string[]
    if (formats.includes("datetime")) return { type: "a.datetime()" }
    if (formats.includes("email")) return { type: "a.email()" }
    if (formats.includes("url")) return { type: "a.url()" }
    if (formats.includes("e164")) return { type: "a.phone()" }
    if (formats.includes("uuid") || fieldName.endsWith("Id")) return { type: "a.id()" }
    if (formats.includes("ipv4") || formats.includes("ipv6")) return { type: "a.ipAddress()" }
    return { type: "a.string()" }
  }

  if (inner instanceof z.ZodNumber) {
    const isInt = ((inner._def as DefWithChecks).checks ?? []).some((c) => c.isInt)
    return { type: isInt ? "a.integer()" : "a.float()" }
  }

  if (inner instanceof z.ZodBoolean) return { type: "a.boolean()" }
  if (inner instanceof z.ZodDate) return { type: "a.datetime()" }

  if (inner instanceof z.ZodEnum) {
    // Zod v4 changed ZodEnum's type parameter; cast through unknown
    const opts = (inner as unknown as { options: readonly string[] }).options
    return { type: `a.enum([${opts.map((o) => `"${o}"`).join(", ")}])` }
  }

  if (inner instanceof z.ZodLiteral) {
    const value = (inner._def as { values?: unknown[] }).values?.[0]
    if (typeof value === "string") return { type: `a.enum([${JSON.stringify(value)}])` }
    if (typeof value === "number") return { type: Number.isInteger(value) ? "a.integer()" : "a.float()" }
    if (typeof value === "boolean") return { type: "a.boolean()" }
    return { type: "a.json()", unknown: "literal" }
  }

  if (inner instanceof z.ZodUnion) {
    const options = (inner as unknown as { options: z.ZodTypeAny[] }).options ?? []
    const stringLiterals = options
      .filter(
        (o) =>
          o instanceof z.ZodLiteral &&
          typeof (o._def as { values?: unknown[] }).values?.[0] === "string"
      )
      .map((o) => JSON.stringify((o._def as unknown as { values: unknown[] }).values[0]))
    if (stringLiterals.length === options.length) {
      return { type: `a.enum([${stringLiterals.join(", ")}])` }
    }
    return { type: "a.json()", unknown: "union" }
  }

  // Scalar or custom-type array
  if (inner instanceof z.ZodArray) {
    const elemInner = unwrap(inner.element as z.ZodTypeAny)
    if (elemInner instanceof z.ZodObject) {
      const name = customTypes.get(elemInner as z.ZodObject<z.ZodRawShape>)
      if (name) return { type: `a.ref("${name}").array()` }
      return { type: "a.json()", unknown: "object[]" }
    }
    // Recurse with empty fieldName to avoid id/FK heuristics on element
    const elemResult = amplifyFieldType("", elemInner, customTypes)
    return { type: `${elemResult.type}.array()`, unknown: elemResult.unknown }
  }

  // Non-model object → custom type reference
  if (inner instanceof z.ZodObject) {
    const name = customTypes.get(inner as z.ZodObject<z.ZodRawShape>)
    if (name) return { type: `a.ref("${name}")` }
    return { type: "a.json()", unknown: "object" }
  }

  // z.any() / z.unknown() → intentional JSON, no warning
  if (inner instanceof z.ZodAny || inner instanceof z.ZodUnknown) {
    return { type: "a.json()" }
  }

  // Unknown type → fall back to a.json() and report
  const zodType = (inner._def as { type?: string }).type ?? inner.constructor?.name ?? "unknown"
  return { type: "a.json()", unknown: zodType }
}

// ---- validation comment extraction ----

function extractValidationComment(inner: z.ZodTypeAny): string {
  const parts: string[] = []

  if (inner instanceof z.ZodString) {
    const bag = (inner as unknown as { _zod?: { bag?: InternalBag } })._zod?.bag
    if (bag?.minimum !== undefined) parts.push(`minLength(${bag.minimum})`)
    if (bag?.maximum !== undefined) parts.push(`maxLength(${bag.maximum})`)
  }

  if (inner instanceof z.ZodNumber) {
    const checks = (inner._def as { checks?: unknown[] }).checks ?? []
    for (const ch of checks) {
      const def = (ch as { _zod?: { def?: NumberCheckDef } })._zod?.def
      if (def?.check === "greater_than" && def.value !== undefined) parts.push(`min(${def.value})`)
      if (def?.check === "less_than" && def.value !== undefined) parts.push(`max(${def.value})`)
    }
  }

  return parts.length > 0 ? ` // zod: ${parts.join(", ")}` : ""
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
  ownerShape: z.ZodRawShape
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
  models: SchemaInput
): string {
  const targetSchema = models[targetModelName]
  if (!targetSchema) return lcFirst(ownerModelName) + "Id"
  const targetShape = targetSchema.shape

  // 1. Look for back-reference object field + associated FK
  for (const [tFieldName, tFieldSchema] of Object.entries(targetShape)) {
    const tInner = unwrap(tFieldSchema as z.ZodTypeAny)
    if (!(tInner instanceof z.ZodObject)) continue
    if (findModelName(tInner, models) !== ownerModelName) continue
    const fk = findBelongsToFk(tFieldName, ownerModelName, targetShape)
    if (fk) return fk
  }

  // 2. Prefer conventionally-named FK if it exists directly
  const conventional = lcFirst(ownerModelName) + "Id"
  if (conventional in targetShape) return conventional

  // 3. Fall back to any single *Id string field (excluding primary "id")
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
  const parts = rules.map((rule) => {
    if (rule.allow === "owner") {
      const field = rule.ownerField ? `.ownerDefinedIn("${rule.ownerField}")` : ""
      return `allow.owner()${field}`
    }
    if (rule.allow === "public") {
      if (rule.operations?.length) {
        return `allow.publicApiKey().to([${rule.operations.map((o) => `"${o}"`).join(", ")}])`
      }
      return "allow.publicApiKey()"
    }
    if (rule.allow === "groups") {
      const ops = rule.operations?.length
        ? `.to([${rule.operations.map((o) => `"${o}"`).join(", ")}])`
        : ""
      return `allow.groups([${rule.groups.map((g) => `"${g}"`).join(", ")}])${ops}`
    }
    return ""
  })
  return `.authorization(allow => [${parts.join(", ")}])`
}

function genIndexes(indexes: IndexDef[]): string {
  const parts = indexes.map((idx) => {
    const sk = idx.sk ? `.sortKeys(["${idx.sk}"])` : ""
    return `index("${idx.pk}")${sk}.name("${idx.name}")`
  })
  return `.secondaryIndexes(index => [${parts.join(", ")}])`
}

function genPrimaryKey(fields: string[]): string {
  return `.identifier([${fields.map((f) => `"${f}"`).join(", ")}])`
}

function genFieldLines(
  shape: z.ZodRawShape,
  modelName: string,
  customTypes: CustomTypeMap,
  warnings: ConversionWarning[],
  isAutoManaged: (name: string) => boolean
): string[] {
  const lines: string[] = []
  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    const inner = unwrap(fieldSchema as z.ZodTypeAny)
    const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
    const isAutoField = isAutoManaged(fieldName)
    const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
    const { type: base, unknown: unknownType } = amplifyFieldType(
      fieldName,
      fieldSchema as z.ZodTypeAny,
      customTypes
    )

    if (unknownType) {
      warnings.push({ model: modelName, field: fieldName, zodType: unknownType })
    }

    const required =
      !opt && !isAutoField && fieldName !== "id" && defaultVal === undefined ? ".required()" : ""
    const defaultSuffix =
      defaultVal !== undefined ? `.default(${JSON.stringify(defaultVal)})` : ""
    const validationComment =
      inner instanceof z.ZodArray ? "" : extractValidationComment(inner)

    lines.push(`    ${fieldName}: ${base}${required}${defaultSuffix},${validationComment}`)
  }
  return lines
}

// ---- main converter ----

export function zodToAmplify(models: SchemaInput): ConversionResult {
  const customTypes = collectCustomTypes(models)
  const manyToManyPairs = detectManyToManyPairs(models)
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

    // Scalar + custom-type fields (everything that isn't a model relation)
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      if (inner instanceof z.ZodObject && findModelName(inner, models)) continue
      if (inner instanceof z.ZodArray && findModelName(inner.element as z.ZodTypeAny, models)) continue

      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const isAutoField = AMPLIFY_AUTO_FIELDS.has(fieldName)
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const { type: base, unknown: unknownType } = amplifyFieldType(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        customTypes
      )

      if (unknownType) {
        warnings.push({ model: modelName, field: fieldName, zodType: unknownType })
      }

      const required =
        !opt && !isAutoField && fieldName !== "id" && defaultVal === undefined ? ".required()" : ""
      const defaultSuffix =
        defaultVal !== undefined ? `.default(${JSON.stringify(defaultVal)})` : ""
      const validationComment =
        inner instanceof z.ZodArray ? "" : extractValidationComment(inner)

      lines.push(`    ${fieldName}: ${base}${required}${defaultSuffix},${validationComment}`)
    }

    // Model relation fields
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)

      if (inner instanceof z.ZodArray) {
        const targetName = findModelName(inner.element as z.ZodTypeAny, models)
        if (!targetName) continue
        const pairKey = [modelName, targetName].sort().join(":")
        if (manyToManyPairs.has(pairKey)) {
          const relationName = [modelName, targetName].sort().join("")
          lines.push(
            `    ${fieldName}: a.manyToMany("${targetName}", { relationName: "${relationName}" }),`
          )
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
    if (config.auth?.length) chain += genAuth(config.auth)

    lines.push(`  })${chain},`)
  }

  // Custom type definitions (no model features — just fields)
  for (const [ctSchema, typeName] of customTypes) {
    lines.push(`  ${typeName}: a.customType({`)
    lines.push(
      ...genFieldLines(ctSchema.shape, typeName, customTypes, warnings, () => false)
    )
    lines.push(`  }),`)
  }

  lines.push("})", "", "export { schema }", "", "export type Schema = typeof schema")
  return { code: lines.join("\n"), warnings }
}

// ---- JSON metadata output ----

export function zodToAmplifyMeta(models: SchemaInput): SchemaSummary {
  const customTypes = collectCustomTypes(models)
  const manyToManyPairs = detectManyToManyPairs(models)
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
      if (inner instanceof z.ZodArray && findModelName(inner.element as z.ZodTypeAny, models)) continue

      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const isAutoField = AMPLIFY_AUTO_FIELDS.has(fieldName)
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const { type: base, unknown: unknownType } = amplifyFieldType(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        customTypes
      )
      if (unknownType) warnings.push({ model: modelName, field: fieldName, zodType: unknownType })

      const required = !opt && !isAutoField && fieldName !== "id" && defaultVal === undefined
      const hint = inner instanceof z.ZodArray
        ? undefined
        : extractValidationComment(inner).replace(/^ \/\/ zod: /, "") || undefined

      fields[fieldName] = { amplifyType: base, required, default: defaultVal, array: inner instanceof z.ZodArray, validationHint: hint }
    }

    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)

      if (inner instanceof z.ZodArray) {
        const targetName = findModelName(inner.element as z.ZodTypeAny, models)
        if (!targetName) continue
        const pairKey = [modelName, targetName].sort().join(":")
        if (manyToManyPairs.has(pairKey)) {
          relations[fieldName] = { kind: "manyToMany", target: targetName, relationName: [modelName, targetName].sort().join("") }
        } else {
          relations[fieldName] = { kind: "hasMany", target: targetName, fk: findHasManyFk(modelName, targetName, models) }
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
    })
  }

  const customTypeSummaries: CustomTypeSummary[] = []
  for (const [ctSchema, typeName] of customTypes) {
    const fields: Record<string, FieldMeta> = {}
    for (const [fieldName, fieldSchema] of Object.entries(ctSchema.shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)
      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const { type: base, unknown: unknownType } = amplifyFieldType(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        customTypes
      )
      if (unknownType) warnings.push({ model: typeName, field: fieldName, zodType: unknownType })

      const required = !opt && fieldName !== "id" && defaultVal === undefined
      const hint = inner instanceof z.ZodArray
        ? undefined
        : extractValidationComment(inner).replace(/^ \/\/ zod: /, "") || undefined

      fields[fieldName] = { amplifyType: base, required, default: defaultVal, array: inner instanceof z.ZodArray, validationHint: hint }
    }
    customTypeSummaries.push({ name: typeName, fields })
  }

  return { models: modelSummaries, customTypes: customTypeSummaries, warnings }
}
