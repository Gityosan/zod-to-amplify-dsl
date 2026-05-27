import { createJiti } from "jiti"
import { resolve } from "path"
import { z } from "zod"
import type { SchemaInput } from "../converter.js"

export async function loadSchema(inputPath: string): Promise<SchemaInput> {
  const jiti = createJiti(import.meta.url)
  const mod = (await jiti.import(resolve(inputPath))) as Record<string, unknown>

  // Merge named exports and default export (if default is a plain object)
  const candidates: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(mod)) {
    if (key === "default") {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        Object.assign(candidates, val)
      }
    } else {
      candidates[key] = val
    }
  }

  const models: SchemaInput = {}
  for (const [key, val] of Object.entries(candidates)) {
    if (val instanceof z.ZodObject) {
      models[key] = val as z.ZodObject<z.ZodRawShape>
    }
  }

  if (Object.keys(models).length === 0) {
    throw new Error(
      `No Zod models found in "${inputPath}".\n` +
        `Export your models as named exports or as export default { ... }.`
    )
  }

  return models
}
