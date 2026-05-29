import { z } from "zod"
import type { ModelConfig } from "./types"

type Registry = ReturnType<typeof z.registry<ModelConfig>>

// Use globalThis so the same registry is shared across jiti module boundaries.
// When jiti loads user schemas, they import defineModel from our package,
// which would normally create a separate module instance. globalThis ensures
// both sides of the boundary read from and write to the exact same registry.
declare global {
  // eslint-disable-next-line no-var
  var __ZOD_AMPLIFY_REGISTRY__: Registry | undefined
}

function getRegistry(): Registry {
  if (!globalThis.__ZOD_AMPLIFY_REGISTRY__) {
    globalThis.__ZOD_AMPLIFY_REGISTRY__ = z.registry<ModelConfig>()
  }
  return globalThis.__ZOD_AMPLIFY_REGISTRY__
}

export function defineModel<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  config: ModelConfig<z.infer<T>>
): T {
  getRegistry().add(schema, config as ModelConfig)
  return schema
}

export function getModelConfig(schema: z.ZodObject<z.ZodRawShape>): ModelConfig | undefined {
  return getRegistry().get(schema)
}
