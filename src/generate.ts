import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { format } from "oxfmt"
import { zodToAmplify, zodToAmplifyMeta, type SchemaInput } from "./converter"
import { loadSchema } from "./loader"
import type { ConversionWarning, SchemaSummary } from "./types"

export interface ConvertResult {
  code: string
  warnings: ConversionWarning[]
}

/**
 * Convert in-memory Zod models to formatted Amplify Gen 2 DSL TypeScript code.
 * Wraps `zodToAmplify` with oxfmt formatting. If formatting fails, the unformatted
 * code is returned.
 */
export async function convert(models: SchemaInput): Promise<ConvertResult> {
  const { code, warnings } = zodToAmplify(models)
  const { code: formatted, errors } = await format("resource.ts", code, {})
  return { code: errors.length === 0 ? formatted : code, warnings }
}

export interface GenerateOptions {
  /** Path to a TypeScript file exporting Zod models. */
  inputPath: string
  /** Path to write the generated file. Required unless `dry` is true. */
  outputPath?: string
  /** If true, skip writing to disk. */
  dry?: boolean
  /** If true, emit JSON metadata (`SchemaSummary`) instead of TypeScript code. */
  json?: boolean
}

export interface GenerateResult {
  /** Final output string (formatted TypeScript or JSON). */
  output: string
  /** Absolute output path if written; undefined when `dry`. */
  writtenTo?: string
  warnings: ConversionWarning[]
  modelNames: string[]
  /** JSON metadata when `json: true`. */
  meta?: SchemaSummary
}

/**
 * Load a Zod schema file, convert it to Amplify DSL (or JSON metadata),
 * format, and optionally write to disk. This is the same pipeline the CLI runs.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { inputPath, outputPath, dry = false, json = false } = options

  if (!dry && !outputPath) {
    throw new Error("generate(): `outputPath` is required when `dry` is false.")
  }

  const models = await loadSchema(inputPath)
  const modelNames = Object.keys(models)

  if (json) {
    const meta = zodToAmplifyMeta(models)
    const output = JSON.stringify(meta, null, 2)
    if (dry) {
      return { output, warnings: meta.warnings, modelNames, meta }
    }
    const jsonPath = outputPath!.replace(/\.ts$/, ".json")
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, output, "utf8")
    return { output, writtenTo: jsonPath, warnings: meta.warnings, modelNames, meta }
  }

  const { code, warnings } = await convert(models)

  if (dry) {
    return { output: code, warnings, modelNames }
  }

  mkdirSync(dirname(outputPath!), { recursive: true })
  writeFileSync(outputPath!, code, "utf8")
  return { output: code, writtenTo: outputPath, warnings, modelNames }
}
