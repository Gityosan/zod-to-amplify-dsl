// Programmatic API sample — equivalent to running `npx zod-to-amplify` but
// driven from your own TS/JS code. Useful for build pipelines, codegen
// orchestration, or unit-testing your schema.
//
// Run with: npx tsx example/programmatic.ts

import { z } from "zod"
import { convert, defineModel, generate } from "../src/index.js"

// ------------------------------------------------------------------
// 1. convert(): in-memory models → formatted Amplify DSL string
// ------------------------------------------------------------------

const Todo = defineModel(
  z.object({
    id: z.uuid(),
    content: z.string().min(1),
    done: z.boolean().default(false),
    createdAt: z.iso.datetime(),
  }),
  { auth: [{ allow: "owner" }] }
)

const { code, warnings } = await convert({ Todo })

console.log("=== convert() output ===")
console.log(code)

if (warnings.length > 0) {
  console.warn("\n=== warnings ===")
  for (const w of warnings) {
    console.warn(`${w.model}.${w.field}: ${w.zodType} (unsupported)`)
  }
}

// ------------------------------------------------------------------
// 2. generate(): file-in → file-out (same pipeline as the CLI)
// ------------------------------------------------------------------

// Dry-run against the bundled example/schema.ts, print to stdout.
const dry = await generate({
  inputPath: new URL("./schema.ts", import.meta.url).pathname,
  dry: true,
})

console.log(`\n=== generate(dry) — ${dry.modelNames.length} models ===`)
console.log(`models: ${dry.modelNames.join(", ")}`)
console.log(`output bytes: ${dry.output.length}`)

// JSON metadata mode — useful for tooling, docs, validation.
const meta = await generate({
  inputPath: new URL("./schema.ts", import.meta.url).pathname,
  dry: true,
  json: true,
})

console.log("\n=== generate(json) metadata ===")
console.log(`models: ${meta.meta?.models.map((m) => m.name).join(", ")}`)
console.log(
  `customTypes: ${meta.meta?.customTypes.map((c) => c.name).join(", ") || "(none)"}`
)
