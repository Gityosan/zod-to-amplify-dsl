import { mkdirSync, writeFileSync } from "fs"
import { dirname } from "path"
import logUpdate from "log-update"
import { zodToAmplify } from "../converter.js"
import { loadSchema } from "./loader.js"

export interface GenerateOptions {
  inputPath: string
  outputPath: string
  dry?: boolean
  silent?: boolean
}

export async function runGenerate({
  inputPath,
  outputPath,
  dry = false,
  silent = false,
}: GenerateOptions): Promise<void> {
  if (!silent) logUpdate(`Loading schema from ${inputPath}...`)
  const models = await loadSchema(inputPath)
  const modelNames = Object.keys(models)

  if (!silent) logUpdate(`Converting ${modelNames.length} models (${modelNames.join(", ")})...`)
  const output = zodToAmplify(models)

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
