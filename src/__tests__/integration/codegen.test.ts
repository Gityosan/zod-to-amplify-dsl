/**
 * Integration tests: verify that generated TypeScript code type-checks
 * against @aws-amplify/data-schema.
 *
 * Strategy:
 *  1. Generate code via zodToAmplify()
 *  2. Replace `import { a } from "@aws-amplify/backend"` with
 *     `import { a } from "@aws-amplify/data-schema"` (same API, no 1GB AWS SDK)
 *  3. Write to src/__tests__/tmp/ (gitignored, inside project so node_modules resolves)
 *  4. Run `tsc --noEmit` and assert no errors
 */
import { describe, it, afterAll } from "vitest"
import { execSync } from "child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { zodToAmplify } from "../../converter"
import { defineModel } from "../../registry"

const TMP = join(import.meta.dirname, "../tmp")
const PROJECT_ROOT = join(import.meta.dirname, "../../../")

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "preserve",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["*.ts"],
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function typecheck(label: string, models: Parameters<typeof zodToAmplify>[0]) {
  const { code } = zodToAmplify(models)
  const src = code.replace(
    'import { a } from "@aws-amplify/backend"',
    'import { a } from "@aws-amplify/data-schema"',
  )

  mkdirSync(TMP, { recursive: true })
  const file = join(TMP, `${label}.ts`)
  const tsconf = join(TMP, `${label}.tsconfig.json`)
  writeFileSync(file, src, "utf8")
  writeFileSync(tsconf, TSCONFIG, "utf8")

  try {
    execSync(`node_modules/.bin/tsc --project ${tsconf}`, {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
    })
  } catch (err: unknown) {
    const msg =
      err instanceof Error && "stderr" in err
        ? String((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr)
        : String(err)
    throw new Error(`tsc failed for "${label}":\n${msg}`)
  }
}

describe("generated code type-checks against @aws-amplify/data-schema", () => {
  it("scalar fields: string, number, boolean, email, url, phone, ipAddress, datetime, enum", () => {
    const Contact = z.object({
      id: z.string().uuid(),
      name: z.string(),
      email: z.string().email(),
      website: z.string().url(),
      phone: z.string().e164(),
      ip: z.string().ipv4(),
      createdAt: z.string().datetime(),
      age: z.number().int(),
      score: z.number(),
      active: z.boolean(),
      role: z.enum(["admin", "user"]),
      notes: z.string().optional(),
    })
    typecheck("scalars", { Contact })
  })

  it("hasMany / belongsTo relations", () => {
    const Post: z.ZodObject<any> = z.object({
      id: z.string().uuid(),
      title: z.string(),
      authorId: z.string(),
      get author(): z.ZodObject<any> {
        return User
      },
    })
    const User: z.ZodObject<any> = z.object({
      id: z.string().uuid(),
      name: z.string(),
      get posts(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Post)
      },
    })
    typecheck("relations-hasMany-belongsTo", { User, Post })
  })

  it("manyToMany relation", () => {
    const Tag: z.ZodObject<any> = z.object({
      id: z.string(),
      name: z.string(),
      get posts(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Post)
      },
    })
    const Post: z.ZodObject<any> = z.object({
      id: z.string(),
      title: z.string(),
      get tags(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Tag)
      },
    })
    typecheck("relations-manyToMany", { Post, Tag })
  })

  it("scalar arrays", () => {
    const M = z.object({
      id: z.string(),
      tags: z.array(z.string()),
      scores: z.array(z.number().int()),
      flags: z.array(z.boolean()).optional(),
    })
    typecheck("scalar-arrays", { M })
  })

  it("a.customType for nested objects", () => {
    const Address = z.object({ street: z.string(), city: z.string(), zip: z.string().optional() })
    const User = z.object({ id: z.string(), name: z.string(), address: Address })
    typecheck("custom-type", { User })
  })

  it("a.customType array (ref().array())", () => {
    const Point = z.object({ lat: z.number(), lng: z.number() })
    const Route = z.object({ id: z.string(), waypoints: z.array(Point) })
    typecheck("custom-type-array", { Route })
  })

  it("ZodDefault, ZodLiteral, ZodUnion enum", () => {
    const M = z.object({
      id: z.string(),
      status: z.enum(["draft", "published"]).default("draft"),
      kind: z.union([z.literal("A"), z.literal("B")]),
      flag: z.literal(true),
      meta: z.any(),
    })
    typecheck("default-literal-union", { M })
  })

  it("indexes and auth from defineModel", () => {
    const Post = defineModel(
      z.object({
        id: z.string().uuid(),
        authorId: z.string(),
        title: z.string(),
        createdAt: z.string().datetime(),
      }),
      {
        indexes: [{ name: "byAuthor", pk: "authorId", sk: "createdAt" }],
        auth: [
          { allow: "owner", ownerField: "authorId" },
          { allow: "public", operations: ["read"] },
        ],
      },
    )
    typecheck("indexes-auth", { Post })
  })

  it("custom primary key", () => {
    const Order = defineModel(
      z.object({ tenantId: z.string(), orderId: z.string(), total: z.number() }),
      { primaryKey: ["tenantId", "orderId"] },
    )
    typecheck("custom-pk", { Order })
  })

  it("queryField, disableOperations, and field-level auth", () => {
    const Post = defineModel(
      z.object({
        id: z.string().uuid(),
        category: z.string(),
        secret: z.string(),
        createdAt: z.string().datetime(),
      }),
      {
        indexes: [
          { name: "byCategory", pk: "category", sk: "createdAt", queryField: "listByCategory" },
        ],
        disabledOperations: ["delete", "subscriptions"],
        auth: [{ allow: "authenticated" }],
        fieldAuth: { secret: [{ allow: "owner" }] },
      },
    )
    typecheck("index-disableops-fieldauth", { Post })
  })

  it("record and tuple map to a.json()", () => {
    const M = z.object({
      id: z.string(),
      meta: z.record(z.string(), z.unknown()),
      pair: z.tuple([z.string(), z.number()]),
    })
    typecheck("record-tuple-json", { M })
  })

  it("date / time / datetime scalars", () => {
    const Event = z.object({
      id: z.string(),
      day: z.iso.date(),
      startsAt: z.iso.time(),
      when: z.iso.datetime(),
      epoch: z.string().date(),
    })
    typecheck("date-time", { Event })
  })

  it("expanded auth rules: authenticated/guest/group/custom/multipleOwners/providers", () => {
    const M = defineModel(
      z.object({ id: z.string(), authorId: z.string(), editors: z.array(z.string()) }),
      {
        auth: [
          { allow: "owner", ownerField: "authorId", provider: "oidc" },
          { allow: "multipleOwners", ownersField: "editors", operations: ["read", "update"] },
          { allow: "authenticated", provider: "identityPool", operations: ["read"] },
          { allow: "guest", operations: ["read"] },
          { allow: "group", group: "admin" },
          { allow: "groups", groups: ["a", "b"], provider: "oidc" },
          { allow: "custom" },
          { allow: "public", operations: ["read"] },
        ],
      },
    )
    typecheck("auth-expanded", { M })
  })

  it("field-level .validate() for string and numeric fields", () => {
    const M = z.object({
      id: z.string(),
      title: z.string().min(1).max(100),
      slug: z.string().regex(/^[a-z-]+$/),
      score: z.number().min(0).max(10),
      ratio: z.number().gt(0).lt(1),
      count: z.number().int().min(0).default(0),
    })
    typecheck("field-validation", { M })
  })
})
