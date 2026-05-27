import { mkdirSync, writeFileSync } from "fs"
import { dirname } from "path"
import logUpdate from "log-update"
import { format } from "oxfmt"
import { zodToAmplify, zodToAmplifyMeta } from "../converter"
import { loadSchema } from "./loader"

export interface GenerateOptions {
  inputPath: string
  outputPath: string
  dry?: boolean
  silent?: boolean
  json?: boolean
}

export async function runGenerate({
  inputPath,
  outputPath,
  dry = false,
  silent = false,
  json = false,
}: GenerateOptions): Promise<void> {
  if (!silent) logUpdate(`Loading schema from ${inputPath}...`)
  const models = await loadSchema(inputPath)
  const modelNames = Object.keys(models)

  if (json) {
    if (!silent) logUpdate(`Generating metadata for ${modelNames.length} models...`)
    const meta = zodToAmplifyMeta(models)
    const output = JSON.stringify(meta, null, 2)

    if (dry) {
      if (!silent) logUpdate.done()
      console.log(output)
      return
    }

    const jsonPath = outputPath.replace(/\.ts$/, ".json")
    if (!silent) logUpdate(`Writing to ${jsonPath}...`)
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, output, "utf8")
    if (!silent) logUpdate.done()
    const ts = new Date().toLocaleTimeString()
    console.log(`[${ts}] ✓ ${modelNames.length} models → ${jsonPath}`)
    return
  }

  if (!silent) logUpdate(`Converting ${modelNames.length} models (${modelNames.join(", ")})...`)
  const { code, warnings } = zodToAmplify(models)

  if (!silent) logUpdate(`Formatting...`)
  const { code: formatted, errors: fmtErrors } = await format("resource.ts", code, {})
  const output = fmtErrors.length === 0 ? formatted : code

  if (warnings.length > 0) {
    if (!silent) logUpdate.clear()
    for (const w of warnings) {
      console.warn(`⚠  ${w.model}.${w.field}: ${w.zodType} → a.json() (unsupported Zod type)`)
    }
  }

  if (dry) {
    if (!silent) logUpdate.done()
    console.log(output)
    return
  }

  if (!silent) logUpdate(`Writing to ${outputPath}...`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, output, "utf8")

  if (!silent) logUpdate.done()
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ✓ ${modelNames.length} models → ${outputPath}`)
}
