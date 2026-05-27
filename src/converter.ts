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
  // Optional wrapping a Default: z.string().default("x").optional()
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

  return "a.json()"
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
  for (const [tFieldName, tFieldSchema] of Object.entries(targetShape)) {
    const tInner = unwrap(tFieldSchema as z.ZodTypeAny)
    if (!(tInner instanceof z.ZodObject)) continue
    if (findModelName(tInner, models) !== ownerModelName) continue
    const fk = findBelongsToFk(tFieldName, ownerModelName, targetShape)
    if (fk) return fk
  }

  return lcFirst(ownerModelName) + "Id"
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

// ---- main converter ----

export function zodToAmplify(models: SchemaInput): string {
  const manyToManyPairs = detectManyToManyPairs(models)

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
      const defaultVal = extractDefault(fieldSchema as z.ZodTypeAny)
      const base = amplifyFieldType(fieldName, fieldSchema as z.ZodTypeAny)
      const required = !opt && fieldName !== "id" && defaultVal === undefined ? ".required()" : ""
      const defaultSuffix = defaultVal !== undefined ? `.default(${JSON.stringify(defaultVal)})` : ""
      lines.push(`    ${fieldName}: ${base}${required}${defaultSuffix},`)
    }

    // Relation fields
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
          const fkField = lcFirst(modelName) + "Id"
          lines.push(`    ${fieldName}: a.hasOne("${targetName}", "${fkField}"),`)
        }
      }
    }

    let chain = ""
    if (config.indexes?.length) chain += genIndexes(config.indexes)
    if (config.auth?.length) chain += genAuth(config.auth)

    lines.push(`  })${chain},`)
  }

  lines.push("})", "", "export { schema }", "", "export type Schema = typeof schema")
  return lines.join("\n")
}
