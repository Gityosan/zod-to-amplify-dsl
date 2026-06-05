import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import logUpdate from "log-update"
import { format } from "oxfmt"
import { zodToAmplify, zodToAmplifyMeta } from "../converter"
import { loadSchema } from "./loader"

/** Place the generated storage file next to the data output: a "data/resource.ts"
 *  output yields "storage/resource.ts"; anything else gets a "storage.resource.ts" sibling. */
export function deriveStoragePath(outputPath: string): string {
  if (outputPath.endsWith("data/resource.ts")) {
    return outputPath.slice(0, -"data/resource.ts".length) + "storage/resource.ts"
  }
  return resolve(dirname(outputPath), "storage.resource.ts")
}

/** Pure comparison used by --check: which of the expected files are missing or stale. */
export function findStaleFiles(
  files: { path: string; content: string }[]
): { path: string; status: "missing" | "stale" }[] {
  const result: { path: string; status: "missing" | "stale" }[] = []
  for (const f of files) {
    if (!existsSync(f.path)) result.push({ path: f.path, status: "missing" })
    else if (readFileSync(f.path, "utf8") !== f.content) result.push({ path: f.path, status: "stale" })
  }
  return result
}

export interface GenerateOptions {
  inputPath: string
  outputPath: string
  storagePath: string
  storageName?: string
  dry?: boolean
  silent?: boolean
  json?: boolean
  /** Verify generated output matches what's on disk; exit non-zero on drift. */
  check?: boolean
}

/** Compare expected file contents to disk. Reports drift and exits 1 when any
 *  file is missing or stale, exits 0 when everything is up to date. */
function runCheck(files: { path: string; content: string }[]): never {
  const stale = findStaleFiles(files)
  logUpdate.done()
  if (stale.length === 0) {
    console.log(`✓ ${files.length} file(s) up to date`)
    process.exit(0)
  }
  for (const f of stale) {
    console.error(`✗ ${f.path} is ${f.status === "stale" ? "out of date" : "missing"}`)
  }
  console.error(`\n${stale.length} file(s) out of date. Run the generator to update them.`)
  process.exit(1)
}

export async function runGenerate({
  inputPath,
  outputPath,
  storagePath,
  storageName,
  dry = false,
  silent = false,
  json = false,
  check = false,
}: GenerateOptions): Promise<void> {
  if (!silent) logUpdate(`Loading schema from ${inputPath}...`)
  const models = await loadSchema(inputPath)
  const modelNames = Object.keys(models)

  if (json) {
    if (!silent) logUpdate(`Generating metadata for ${modelNames.length} models...`)
    const meta = zodToAmplifyMeta(models)
    const output = JSON.stringify(meta, null, 2)
    const jsonPath = outputPath.replace(/\.ts$/, ".json")

    if (check) runCheck([{ path: jsonPath, content: output }])

    if (dry) {
      if (!silent) logUpdate.done()
      console.log(output)
      return
    }

    if (!silent) logUpdate(`Writing to ${jsonPath}...`)
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, output, "utf8")
    if (!silent) logUpdate.done()
    const ts = new Date().toLocaleTimeString()
    console.log(`[${ts}] ✓ ${modelNames.length} models → ${jsonPath}`)
    return
  }

  if (!silent) logUpdate(`Converting ${modelNames.length} models (${modelNames.join(", ")})...`)
  const { code, warnings, storage } = zodToAmplify(models, { storageName })

  if (!silent) logUpdate(`Formatting...`)
  const { code: formatted, errors: fmtErrors } = await format("resource.ts", code, {})
  const output = fmtErrors.length === 0 ? formatted : code

  let storageOutput: string | undefined
  if (storage) {
    const { code: fmt, errors } = await format("resource.ts", storage, {})
    storageOutput = errors.length === 0 ? fmt : storage
  }

  if (warnings.length > 0) {
    if (!silent) logUpdate.clear()
    for (const w of warnings) {
      console.warn(`⚠  ${w.model}.${w.field}: ${w.zodType} → a.json() (unsupported Zod type)`)
    }
  }

  if (check) {
    const files = [{ path: outputPath, content: output }]
    if (storageOutput) files.push({ path: storagePath, content: storageOutput })
    runCheck(files)
  }

  if (dry) {
    if (!silent) logUpdate.done()
    console.log(output)
    if (storageOutput) {
      console.log(`\n// ---- ${storagePath} ----\n`)
      console.log(storageOutput)
    }
    return
  }

  if (!silent) logUpdate(`Writing to ${outputPath}...`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, output, "utf8")

  if (storageOutput) {
    if (!silent) logUpdate(`Writing storage to ${storagePath}...`)
    mkdirSync(dirname(storagePath), { recursive: true })
    writeFileSync(storagePath, storageOutput, "utf8")
  }

  if (!silent) logUpdate.done()
  const ts = new Date().toLocaleTimeString()
  const storageNote = storageOutput ? ` (+ storage → ${storagePath})` : ""
  console.log(`[${ts}] ✓ ${modelNames.length} models → ${outputPath}${storageNote}`)
}
