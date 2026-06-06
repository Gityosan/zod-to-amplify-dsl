import { describe, it, expect, afterAll } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { deriveStoragePath, findStaleFiles } from "../cli/generate"
import { loadSchema } from "../cli/loader"

const TMP = join(import.meta.dirname, "tmp-cli")

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function tmpFile(name: string, content: string): string {
  mkdirSync(TMP, { recursive: true })
  const p = join(TMP, name)
  writeFileSync(p, content, "utf8")
  return p
}

describe("deriveStoragePath", () => {
  it("maps a data/resource.ts output to a sibling storage/resource.ts", () => {
    expect(deriveStoragePath("amplify/data/resource.ts")).toBe("amplify/storage/resource.ts")
    expect(deriveStoragePath("/abs/amplify/data/resource.ts")).toBe(
      "/abs/amplify/storage/resource.ts",
    )
  })

  it("falls back to a storage.resource.ts sibling for other output paths", () => {
    const out = deriveStoragePath("/abs/gen/schema.ts")
    expect(out.endsWith("storage.resource.ts")).toBe(true)
    expect(dirname(out)).toBe("/abs/gen")
  })
})

describe("findStaleFiles", () => {
  it("reports nothing when content matches", () => {
    const p = tmpFile("match.ts", "hello")
    expect(findStaleFiles([{ path: p, content: "hello" }])).toEqual([])
  })

  it("flags a file whose content differs as stale", () => {
    const p = tmpFile("stale.ts", "old")
    expect(findStaleFiles([{ path: p, content: "new" }])).toEqual([{ path: p, status: "stale" }])
  })

  it("flags a non-existent file as missing", () => {
    const p = join(TMP, "does-not-exist.ts")
    expect(findStaleFiles([{ path: p, content: "x" }])).toEqual([{ path: p, status: "missing" }])
  })
})

describe("loadSchema", () => {
  it("collects models from named exports and a default-export object", async () => {
    const p = tmpFile(
      "schema-ok.ts",
      `import { z } from "zod"
export const A = z.object({ id: z.string() })
export default { B: z.object({ id: z.string() }) }
`,
    )
    const models = await loadSchema(p)
    expect(Object.keys(models).sort()).toEqual(["A", "B"])
  })

  it("throws a helpful error when no Zod models are exported", async () => {
    const p = tmpFile("schema-empty.ts", `export const notAModel = 42\n`)
    await expect(loadSchema(p)).rejects.toThrow(/No Zod models found/)
  })
})
