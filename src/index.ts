export { defineModel } from "./registry"
export { defineConfig } from "./types"
export { convert, generate } from "./generate"

export type { SchemaInput } from "./converter"
export type { ConvertResult, GenerateOptions, GenerateResult } from "./generate"
export type {
  ModelConfig,
  AuthRule,
  IndexDef,
  Operation,
  ZodAmplifyConfig,
  ConversionWarning,
} from "./types"
