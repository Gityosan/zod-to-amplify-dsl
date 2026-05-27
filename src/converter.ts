import { z } from "zod"
import { getModelConfig } from "./registry.js"
import type { AuthRule, IndexDef, ModelConfig } from "./types.js"

export type SchemaInput = Record<string, z.ZodObject<z.ZodRawShape>>

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
  if (schema instanceof z.ZodOptional) return true
  if (schema instanceof z.ZodDefault) return true
  if (schema instanceof z.ZodNullable) return true
  return false
}

// ---- model lookup ----

function findModelName(
  candidate: z.ZodTypeAny,
  models: SchemaInput
): string | undefined {
  const inner = unwrap(candidate)
  return Object.entries(models).find(([, s]) => s === inner)?.[0]
}

// ---- field type mapping ----

type CheckEntry = { format?: string; isInt?: boolean }
type DefWithChecks = { checks?: CheckEntry[] }

function amplifyFieldType(fieldName: string, schema: z.ZodTypeAny): string {
  if (fieldName === "id") return "a.id()"

  const inner = unwrap(schema)

  if (inner instanceof z.ZodString) {
    const formats = ((inner._def as DefWithChecks).checks ?? [])
      .map((c) => c.format)
      .filter(Boolean) as string[]
    if (formats.includes("datetime")) return "a.datetime()"
    if (formats.includes("email")) return "a.email()"
    if (formats.includes("url")) return "a.url()"
    if (formats.includes("uuid") || fieldName.endsWith("Id")) return "a.id()"
    return "a.string()"
  }

  if (inner instanceof z.ZodNumber) {
    const isInt = ((inner._def as DefWithChecks).checks ?? []).some((c) => c.isInt)
    return isInt ? "a.integer()" : "a.float()"
  }

  if (inner instanceof z.ZodBoolean) return "a.boolean()"
  if (inner instanceof z.ZodDate) return "a.datetime()"

  if (inner instanceof z.ZodEnum) {
    // Zod v4 changed ZodEnum's type parameter; cast through unknown
    const opts = (inner as unknown as { options: readonly string[] }).options
    return `a.enum([${opts.map((o) => `"${o}"`).join(", ")}])`
  }

  // Non-relational arrays/objects fall back to JSON
  return "a.json()"
}

// ---- relation detection ----

type RelationKind = "hasMany" | "hasOne" | "belongsTo"

interface Relation {
  kind: RelationKind
  targetModel: string
  fkField: string
}

/**
 * Find the FK field for a belongsTo relation.
 * Priority: {fieldName}Id > {targetModelName}Id
 */
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

/**
 * Find the FK for a hasMany or hasOne relation.
 * Looks at the target model's shape for a back-reference and its FK.
 * Falls back to {ownerModelName}Id.
 */
function findHasManyFk(
  ownerModelName: string,
  targetModelName: string,
  models: SchemaInput
): string {
  const targetSchema = models[targetModelName]
  if (!targetSchema) return lcFirst(ownerModelName) + "Id"

  const targetShape = targetSchema.shape

  for (const [tFieldName, tFieldSchema] of Object.entries(targetShape)) {
    const tInner = unwrap(tFieldSchema as z.ZodTypeAny)
    if (!(tInner instanceof z.ZodObject)) continue
    if (findModelName(tInner, models) !== ownerModelName) continue

    // Found back-reference field; check its FK
    const fk = findBelongsToFk(tFieldName, ownerModelName, targetShape)
    if (fk) return fk
  }

  return lcFirst(ownerModelName) + "Id"
}

function detectRelation(
  fieldName: string,
  fieldSchema: z.ZodTypeAny,
  ownerModelName: string,
  ownerShape: z.ZodRawShape,
  models: SchemaInput
): Relation | null {
  const inner = unwrap(fieldSchema)

  // z.array(SomeModel) → hasMany; FK lives on target side
  if (inner instanceof z.ZodArray) {
    const targetName = findModelName(inner.element as z.ZodTypeAny, models)
    if (!targetName) return null
    const fkField = findHasManyFk(ownerModelName, targetName, models)
    return { kind: "hasMany", targetModel: targetName, fkField }
  }

  // SomeModel (single) → belongsTo or hasOne
  const targetName = findModelName(inner, models)
  if (!targetName) return null

  const fk = findBelongsToFk(fieldName, targetName, ownerShape)
  if (fk) return { kind: "belongsTo", targetModel: targetName, fkField: fk }

  // No FK on this side → hasOne; FK lives on target side
  const fkField = lcFirst(ownerModelName) + "Id"
  return { kind: "hasOne", targetModel: targetName, fkField }
}

// ---- code generation helpers ----

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
      const ops =
        rule.operations?.length
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

// ---- main converter ----

export function zodToAmplify(models: SchemaInput): string {
  const lines: string[] = [
    'import { a } from "@aws-amplify/backend"',
    "",
    "const schema = a.schema({",
  ]

  for (const [modelName, schema] of Object.entries(models)) {
    const config: ModelConfig = getModelConfig(schema) ?? {}
    const shape = schema.shape

    lines.push(`  ${modelName}: a.model({`)

    // Scalar fields first
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const inner = unwrap(fieldSchema as z.ZodTypeAny)

      // Skip relation fields
      if (inner instanceof z.ZodObject && findModelName(inner, models)) continue
      if (inner instanceof z.ZodArray && findModelName(inner.element as z.ZodTypeAny, models)) continue

      const opt = isOptionalField(fieldSchema as z.ZodTypeAny)
      const base = amplifyFieldType(fieldName, fieldSchema as z.ZodTypeAny)
      const required = opt || fieldName === "id" ? "" : ".required()"
      lines.push(`    ${fieldName}: ${base}${required},`)
    }

    // Relation fields
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const relation = detectRelation(
        fieldName,
        fieldSchema as z.ZodTypeAny,
        modelName,
        shape,
        models
      )
      if (!relation) continue
      lines.push(
        `    ${fieldName}: a.${relation.kind}("${relation.targetModel}", "${relation.fkField}"),`
      )
    }

    // Chain .secondaryIndexes and .authorization
    let chain = ""
    if (config.indexes?.length) chain += genIndexes(config.indexes)
    if (config.auth?.length) chain += genAuth(config.auth)

    lines.push(`  })${chain},`)
  }

  lines.push("})", "", "export { schema }", "", "export type Schema = typeof schema")
  return lines.join("\n")
}
