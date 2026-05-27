import { z } from "zod"
import type { ModelConfig } from "./types.js"

// Use globalThis so the same map is shared across jiti module boundaries.
// When jiti loads user schemas, they import defineModel from our package,
// which would normally create a separate module instance. globalThis ensures
// both sides of the boundary write to and read from the exact same WeakMap.
const REGISTRY_KEY = "zod-amplify:model-registry"

function registry(): WeakMap<object, ModelConfig> {
  const g = globalThis as Record<string, unknown>
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new WeakMap<object, ModelConfig>()
  return g[REGISTRY_KEY] as WeakMap<object, ModelConfig>
}

export function defineModel<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  config: ModelConfig<z.infer<T>>
): T {
  registry().set(schema, config as ModelConfig)
  return schema
}

export function getModelConfig(schema: z.ZodObject<z.ZodRawShape>): ModelConfig | undefined {
  return registry().get(schema)
}
