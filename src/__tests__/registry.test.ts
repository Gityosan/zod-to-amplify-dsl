import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineModel, getModelConfig } from "../registry"
import type { ModelConfig } from "../types"

describe("registry - defineModel", () => {
  it("returns the exact same schema reference passed in", () => {
    const schema = z.object({ id: z.string() })
    const result = defineModel(schema, {})
    expect(result).toBe(schema)
  })

  it("registers the config so getModelConfig retrieves it", () => {
    const schema = z.object({ id: z.string() })
    const config: ModelConfig = { auth: [{ allow: "owner" }] }
    defineModel(schema, config)
    expect(getModelConfig(schema)).toEqual(config)
  })

  it("stores the config by reference (no clone)", () => {
    const schema = z.object({ id: z.string() })
    const config: ModelConfig = { auth: [{ allow: "owner" }] }
    defineModel(schema, config)
    expect(getModelConfig(schema)).toBe(config)
  })

  it("overwrites the config when defineModel is called twice on the same schema", () => {
    const schema = z.object({ id: z.string() })
    defineModel(schema, { auth: [{ allow: "owner" }] })
    defineModel(schema, { auth: [{ allow: "public" }] })
    expect(getModelConfig(schema)?.auth?.[0]).toEqual({ allow: "public" })
  })

  it("keeps configs isolated between distinct schema instances", () => {
    const a = z.object({ id: z.string() })
    const b = z.object({ id: z.string() })
    defineModel(a, { auth: [{ allow: "owner" }] })
    defineModel(b, { auth: [{ allow: "public" }] })
    expect(getModelConfig(a)?.auth?.[0]).toEqual({ allow: "owner" })
    expect(getModelConfig(b)?.auth?.[0]).toEqual({ allow: "public" })
  })

  it("works when the schema is bound to a variable before defineModel is called", () => {
    const todoSchema = z.object({ id: z.string(), content: z.string() })
    const Todo = defineModel(todoSchema, { auth: [{ allow: "owner" }] })
    expect(Todo).toBe(todoSchema)
    expect(getModelConfig(todoSchema)).toBe(getModelConfig(Todo))
    expect(getModelConfig(Todo)?.auth?.[0]).toEqual({ allow: "owner" })
  })

  it("registers config even when the return value is discarded", () => {
    const schema = z.object({ id: z.string() })
    defineModel(schema, { auth: [{ allow: "owner" }] })
    expect(getModelConfig(schema)?.auth?.[0]).toEqual({ allow: "owner" })
  })

  it("treats schemas reused via .extend() as distinct entries", () => {
    const base = defineModel(z.object({ id: z.string() }), {
      auth: [{ allow: "public" }],
    })
    const extended = defineModel(base.extend({ extra: z.string() }), {
      auth: [{ allow: "owner" }],
    })
    expect(getModelConfig(base)?.auth?.[0]).toEqual({ allow: "public" })
    expect(getModelConfig(extended)?.auth?.[0]).toEqual({ allow: "owner" })
    expect(base).not.toBe(extended)
  })

  it("accepts an empty config object", () => {
    const schema = z.object({ id: z.string() })
    defineModel(schema, {})
    expect(getModelConfig(schema)).toEqual({})
  })

  it("preserves all ModelConfig fields verbatim (primaryKey / indexes / auth)", () => {
    const Order = z.object({
      tenantId: z.string(),
      orderId: z.string(),
      createdAt: z.string(),
    })
    const config: ModelConfig<{ tenantId: string; orderId: string; createdAt: string }> = {
      primaryKey: ["tenantId", "orderId"],
      indexes: [{ name: "byTenant", pk: "tenantId", sk: "createdAt" }],
      auth: [
        { allow: "owner", ownerField: "tenantId" },
        { allow: "groups", groups: ["admin"], operations: ["read"] },
      ],
    }
    defineModel(Order, config)
    const stored = getModelConfig(Order)
    expect(stored?.primaryKey).toEqual(["tenantId", "orderId"])
    expect(stored?.indexes).toEqual([{ name: "byTenant", pk: "tenantId", sk: "createdAt" }])
    expect(stored?.auth).toHaveLength(2)
  })
})

describe("registry - getModelConfig", () => {
  it("returns undefined for an unregistered schema", () => {
    const schema = z.object({ id: z.string() })
    expect(getModelConfig(schema)).toBeUndefined()
  })

  it("returns undefined for a structurally identical but distinct schema instance", () => {
    const a = z.object({ id: z.string() })
    const b = z.object({ id: z.string() })
    defineModel(a, { auth: [{ allow: "owner" }] })
    expect(getModelConfig(b)).toBeUndefined()
  })

  it("returns the same reference on repeated calls", () => {
    const schema = z.object({ id: z.string() })
    defineModel(schema, { auth: [{ allow: "owner" }] })
    expect(getModelConfig(schema)).toBe(getModelConfig(schema))
  })
})

describe("registry - globalThis singleton (jiti boundary)", () => {
  it("lazily creates the global registry on first defineModel call", async () => {
    delete globalThis.__ZOD_AMPLIFY_REGISTRY__
    expect(globalThis.__ZOD_AMPLIFY_REGISTRY__).toBeUndefined()
    defineModel(z.object({ id: z.string() }), {})
    expect(globalThis.__ZOD_AMPLIFY_REGISTRY__).toBeDefined()
  })

  it("does not recreate the registry on subsequent operations", () => {
    defineModel(z.object({ id: z.string() }), {})
    const ref1 = globalThis.__ZOD_AMPLIFY_REGISTRY__
    defineModel(z.object({ id: z.string() }), {})
    getModelConfig(z.object({ id: z.string() }))
    const ref2 = globalThis.__ZOD_AMPLIFY_REGISTRY__
    expect(ref2).toBe(ref1)
  })

  it("recovers if the registry slot is cleared between calls", () => {
    const a = z.object({ id: z.string() })
    defineModel(a, { auth: [{ allow: "owner" }] })
    delete globalThis.__ZOD_AMPLIFY_REGISTRY__
    // Previous registration is lost (different registry instance now),
    // but the API must still work without throwing.
    expect(getModelConfig(a)).toBeUndefined()
    const b = z.object({ id: z.string() })
    defineModel(b, { auth: [{ allow: "public" }] })
    expect(getModelConfig(b)?.auth?.[0]).toEqual({ allow: "public" })
  })
})

describe("registry - type-level safety", () => {
  it("infers primaryKey keys from the schema's inferred shape", () => {
    const Order = z.object({ tenantId: z.string(), orderId: z.string() })
    defineModel(Order, { primaryKey: ["tenantId", "orderId"] })
    // @ts-expect-error "notAKey" is not a key of Order
    defineModel(Order, { primaryKey: ["notAKey"] })
  })

  it("infers index pk/sk keys from the schema's inferred shape", () => {
    const Post = z.object({ authorId: z.string(), createdAt: z.string() })
    defineModel(Post, { indexes: [{ name: "byAuthor", pk: "authorId", sk: "createdAt" }] })
    // @ts-expect-error "missing" is not a key of Post
    defineModel(Post, { indexes: [{ name: "bad", pk: "missing" }] })
  })

  it("rejects unknown auth.allow values", () => {
    const Doc = z.object({ id: z.string() })
    // @ts-expect-error "everyone" is not a valid allow rule
    defineModel(Doc, { auth: [{ allow: "everyone" }] })
  })
})
