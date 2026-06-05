import { z } from "zod"
import type { ModelConfig, StorageFieldConfig } from "./types"

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

// ---- storage field registry ----

// Separate WeakMap, same globalThis trick as the model registry above so the
// mapping survives the jiti module boundary when user schemas import storageField.
const STORAGE_REGISTRY_KEY = "zod-amplify:storage-registry"

function storageRegistry(): WeakMap<object, StorageFieldConfig> {
  const g = globalThis as Record<string, unknown>
  if (!g[STORAGE_REGISTRY_KEY]) g[STORAGE_REGISTRY_KEY] = new WeakMap<object, StorageFieldConfig>()
  return g[STORAGE_REGISTRY_KEY] as WeakMap<object, StorageFieldConfig>
}

/** Mark a Zod string field as an S3 key backed by Amplify Storage. The data
 *  model keeps the value as a.string(); the converter emits a defineStorage
 *  entry for {@link StorageFieldConfig.path} in a separate storage file. */
export function storageField<T extends z.ZodTypeAny>(schema: T, config: StorageFieldConfig): T {
  storageRegistry().set(schema, config)
  return schema
}

export function getStorageConfig(schema: z.ZodTypeAny): StorageFieldConfig | undefined {
  return storageRegistry().get(schema)
}
