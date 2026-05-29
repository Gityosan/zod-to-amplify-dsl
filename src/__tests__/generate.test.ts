import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { convert, generate } from "../generate"
import { defineModel } from "../registry"

describe("convert", () => {
  it("returns formatted TypeScript code with no warnings for valid input", async () => {
    const Todo = z.object({ id: z.string().uuid(), content: z.string() })
    const { code, warnings } = await convert({ Todo })
    expect(code).toContain("a.model({")
    expect(code).toContain("Todo:")
    expect(warnings).toEqual([])
  })

  it("emits a runnable-looking TS module (import + export)", async () => {
    const Todo = z.object({ id: z.string() })
    const { code } = await convert({ Todo })
    expect(code).toMatch(/import\s+\{\s*a\s*\}\s+from\s+"@aws-amplify\/backend"/)
    expect(code).toMatch(/export\s+\{\s*schema\s*\}/)
    expect(code).toMatch(/export\s+type\s+Schema\s*=\s*typeof\s+schema/)
  })

  it("formats the output (oxfmt produces a stable string)", async () => {
    const Todo = z.object({ id: z.string() })
    const a = await convert({ Todo })
    const b = await convert({ Todo })
    expect(a.code).toBe(b.code)
  })

  it("reports warnings for unsupported Zod types (Map → a.json())", async () => {
    const Bad = z.object({
      id: z.string(),
      data: z.map(z.string(), z.string()),
    })
    const { code, warnings } = await convert({ Bad })
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toMatchObject({ model: "Bad", field: "data" })
    expect(code).toContain("a.json()")
  })

  it("does NOT warn on z.any() / z.unknown() (intentional opt-in)", async () => {
    const M = z.object({ id: z.string(), payload: z.any() })
    const { warnings } = await convert({ M })
    expect(warnings).toEqual([])
  })

  it("preserves defineModel auth/indexes/primaryKey in generated code", async () => {
    const Doc = defineModel(
      z.object({ id: z.string(), authorId: z.string() }),
      {
        auth: [{ allow: "owner", ownerField: "authorId" }],
        indexes: [{ name: "byAuthor", pk: "authorId" }],
      }
    )
    const { code } = await convert({ Doc })
    expect(code).toContain('allow.ownerDefinedIn("authorId")')
    expect(code).toContain('index("authorId")')
    expect(code).toContain('.name("byAuthor")')
  })

  it("handles multiple models in one call", async () => {
    const Post = z.object({
      id: z.string(),
      authorId: z.string(),
      get author(): z.ZodObject<z.ZodRawShape> {
        return User
      },
    })
    const User = z.object({
      id: z.string(),
      get posts(): z.ZodArray<z.ZodObject<z.ZodRawShape>> {
        return z.array(Post)
      },
    })
    const { code } = await convert({ Post, User })
    expect(code).toContain("Post: a.model({")
    expect(code).toContain("User: a.model({")
    expect(code).toContain('a.belongsTo("User"')
    expect(code).toContain('a.hasMany("Post"')
  })
})

describe("generate - file-based pipeline", () => {
  let tmpDir: string

  beforeEach(() => {
    // Create tmp dir inside the project so jiti can resolve node_modules.
    tmpDir = mkdtempSync(join(process.cwd(), ".test-tmp-gen-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSchema(name: string, body: string): string {
    const file = join(tmpDir, name)
    writeFileSync(file, body)
    return file
  }

  it("loads input, converts, formats, and writes to outputPath", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string().uuid(), content: z.string() })
`
    )
    const outputPath = join(tmpDir, "out/resource.ts")
    const result = await generate({ inputPath, outputPath })
    expect(result.writtenTo).toBe(outputPath)
    expect(result.modelNames).toEqual(["Todo"])
    expect(result.warnings).toEqual([])
    expect(existsSync(outputPath)).toBe(true)
    const written = readFileSync(outputPath, "utf8")
    expect(written).toContain("Todo: a.model({")
    expect(written).toMatch(/import\s+\{\s*a\s*\}\s+from\s+"@aws-amplify\/backend"/)
  })

  it("creates nested output directories as needed", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
`
    )
    const outputPath = join(tmpDir, "deep/nested/dir/resource.ts")
    await generate({ inputPath, outputPath })
    expect(existsSync(outputPath)).toBe(true)
  })

  it("returns code without writing when dry=true", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
`
    )
    const outputPath = join(tmpDir, "should-not-exist.ts")
    const result = await generate({ inputPath, outputPath, dry: true })
    expect(result.writtenTo).toBeUndefined()
    expect(result.output).toContain("Todo:")
    expect(existsSync(outputPath)).toBe(false)
  })

  it("dry=true makes outputPath optional", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
`
    )
    const result = await generate({ inputPath, dry: true })
    expect(result.output).toContain("Todo:")
    expect(result.writtenTo).toBeUndefined()
  })

  it("throws when outputPath is missing and dry is false", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
`
    )
    await expect(generate({ inputPath })).rejects.toThrow(/outputPath/)
  })

  it("emits JSON metadata when json=true and rewrites .ts → .json", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string().uuid(), content: z.string() })
`
    )
    const outputPath = join(tmpDir, "out/resource.ts")
    const result = await generate({ inputPath, outputPath, json: true })
    expect(result.writtenTo).toBe(join(tmpDir, "out/resource.json"))
    expect(result.meta).toBeDefined()
    expect(result.meta?.models).toHaveLength(1)
    expect(result.meta?.models[0].name).toBe("Todo")
    expect(existsSync(result.writtenTo!)).toBe(true)
    const written = JSON.parse(readFileSync(result.writtenTo!, "utf8"))
    expect(written).toEqual(result.meta)
  })

  it("returns JSON output without writing when dry=true && json=true", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string() })
`
    )
    const result = await generate({ inputPath, dry: true, json: true })
    expect(result.writtenTo).toBeUndefined()
    expect(result.meta).toBeDefined()
    expect(() => JSON.parse(result.output)).not.toThrow()
  })

  it("propagates conversion warnings to the result", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Bad = z.object({
  id: z.string(),
  data: z.map(z.string(), z.string()),
})
`
    )
    const result = await generate({ inputPath, dry: true })
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0].model).toBe("Bad")
    expect(result.warnings[0].field).toBe("data")
  })

  it("returns all top-level model exports in modelNames", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Zebra = z.object({ id: z.string() })
export const Aardvark = z.object({ id: z.string() })
export const Monkey = z.object({ id: z.string() })
`
    )
    const result = await generate({ inputPath, dry: true })
    // jiti / ESM exposes named exports alphabetically; assert membership only.
    expect(result.modelNames.sort()).toEqual(["Aardvark", "Monkey", "Zebra"])
  })

  it("throws a helpful error when the schema file has no Zod models", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `export const foo = "not a schema"`
    )
    await expect(generate({ inputPath, dry: true })).rejects.toThrow(/No Zod models found/)
  })

  it("throws when the input file does not exist", async () => {
    await expect(
      generate({ inputPath: join(tmpDir, "missing.ts"), dry: true })
    ).rejects.toThrow()
  })

  it("end-to-end: written file has correct content and is idempotent", async () => {
    const inputPath = writeSchema(
      "schema.ts",
      `
import { z } from "zod"
export const Todo = z.object({ id: z.string(), content: z.string() })
`
    )
    const outputPath = join(tmpDir, "resource.ts")
    const first = await generate({ inputPath, outputPath })
    const firstContent = readFileSync(outputPath, "utf8")
    const second = await generate({ inputPath, outputPath })
    const secondContent = readFileSync(outputPath, "utf8")
    expect(firstContent).toBe(secondContent)
    expect(first.output).toBe(second.output)
  })
})
