export { defineModel, getModelConfig } from "./registry"
export { zodToAmplify, zodToAmplifyMeta } from "./converter"
export type { SchemaInput } from "./converter"
export type {
  ModelConfig,
  AuthRule,
  IndexDef,
  Operation,
  ZodAmplifyConfig,
  ConversionWarning,
  ConversionResult,
  FieldMeta,
  RelationFieldMeta,
  ModelSummary,
  CustomTypeSummary,
  SchemaSummary,
} from "./types"
export { defineConfig } from "./types"
