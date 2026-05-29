import logUpdate from "log-update"
import { generate } from "../generate"

export interface CliGenerateOptions {
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
}: CliGenerateOptions): Promise<void> {
  if (!silent) logUpdate(`Loading schema from ${inputPath}...`)

  const result = await generate({ inputPath, outputPath, dry, json })

  if (result.warnings.length > 0) {
    if (!silent) logUpdate.clear()
    for (const w of result.warnings) {
      console.warn(`⚠  ${w.model}.${w.field}: ${w.zodType} → a.json() (unsupported Zod type)`)
    }
  }

  if (dry) {
    if (!silent) logUpdate.done()
    console.log(result.output)
    return
  }

  if (!silent) logUpdate.done()
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ✓ ${result.modelNames.length} models → ${result.writtenTo}`)
}
