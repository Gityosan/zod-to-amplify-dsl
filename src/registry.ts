import { z } from "zod"
import type { ModelConfig } from "./types.js"

export const modelRegistry = z.registry<ModelConfig>()

export function defineModel<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  config: ModelConfig<T["shape"]>
): T {
  modelRegistry.add(schema, config as ModelConfig)
  return schema
}
