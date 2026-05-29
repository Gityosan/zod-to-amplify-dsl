import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { loadSchema } from "../loader"

const REGISTRY_PATH = resolve(import.meta.dirname, "..", "registry.ts")

describe("loadSchema", () => {
  let tmpDir: string

  beforeEach(() => {
    // Create tmp dir inside the project so jiti can resolve node_modules (zod, etc.)
    tmpDir = mkdtempSync(join(process.cwd(), ".test-tmp-loader-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("loads named ZodObject exports as models", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
export const User = z.object({ id: z.string(), name: z.string() })
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models).sort()).toEqual(["Todo", "User"])
  })

  it("loads default-exported plain object of models", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
const Todo = z.object({ id: z.string() })
const User = z.object({ id: z.string() })
export default { Todo, User }
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models).sort()).toEqual(["Todo", "User"])
  })

  it("merges named exports with default-export object", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const User = z.object({ id: z.string() })
const Todo = z.object({ id: z.string() })
export default { Todo }
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models).sort()).toEqual(["Todo", "User"])
  })

  it("ignores non-ZodObject exports (primitives, functions, ZodString)", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
export const helperString = "not a schema"
export const numberThing = 42
export function fn() { return null }
export const stringSchema = z.string()
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models)).toEqual(["Todo"])
  })

  it("ignores default-exported non-objects (arrays, functions, null)", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
export default [1, 2, 3]
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models)).toEqual(["Todo"])
  })

  it("throws a helpful error when no Zod models are found", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(file, `export const foo = "no models"`)
    await expect(loadSchema(file)).rejects.toThrow(/No Zod models found/)
  })

  it("throws when the input file does not exist", async () => {
    await expect(loadSchema(join(tmpDir, "missing.ts"))).rejects.toThrow()
  })

  it("loads schemas wrapped via defineModel", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
import { defineModel } from "${REGISTRY_PATH}"
export const Todo = defineModel(
  z.object({ id: z.string(), content: z.string() }),
  { auth: [{ allow: "owner" }] }
)
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models)).toEqual(["Todo"])
  })

  it("loads schemas with circular getter-based relations", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  get author(): z.ZodObject<any> { return User },
})
export const User = z.object({
  id: z.string(),
  get posts(): z.ZodArray<z.ZodObject<any>> { return z.array(Post) },
})
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models).sort()).toEqual(["Post", "User"])
  })

  it("loads schemas via z.lazy() as an alternative to getter syntax", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const Node: any = z.object({
  id: z.string(),
  parent: z.lazy(() => Node).optional(),
})
`
    )
    const models = await loadSchema(file)
    expect(Object.keys(models)).toEqual(["Node"])
  })

  it("resolves a relative input path against cwd", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
`
    )
    const prev = process.cwd()
    try {
      process.chdir(tmpDir)
      const models = await loadSchema("./schema.ts")
      expect(Object.keys(models)).toEqual(["Todo"])
    } finally {
      process.chdir(prev)
    }
  })

  it("returns a SchemaInput whose values are ZodObject instances", async () => {
    const file = join(tmpDir, "schema.ts")
    writeFileSync(
      file,
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
`
    )
    const models = await loadSchema(file)
    const Todo = models.Todo
    expect(Todo).toBeDefined()
    expect("shape" in Todo).toBe(true)
    expect(Object.keys(Todo.shape)).toContain("id")
  })
})
