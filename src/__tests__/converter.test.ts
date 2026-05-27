import { describe, it, expect } from "vitest"
import { z } from "zod"
import { zodToAmplify, type SchemaInput } from "../converter.js"
import { defineModel } from "../registry.js"

// Helper: extract code string from ConversionResult
const code = (models: SchemaInput) => zodToAmplify(models).code
const warns = (models: SchemaInput) => zodToAmplify(models).warnings

describe("zodToAmplify - scalar fields", () => {
  it("maps basic scalar types", () => {
    const Note = z.object({
      id: z.string().uuid(),
      title: z.string(),
      views: z.number().int(),
      rating: z.number(),
      published: z.boolean(),
      status: z.enum(["draft", "published"]),
    })

    const out = code({ Note })

    expect(out).toContain("id: a.id(),")
    expect(out).toContain("title: a.string().required(),")
    expect(out).toContain("views: a.integer().required(),")
    expect(out).toContain("rating: a.float().required(),")
    expect(out).toContain("published: a.boolean().required(),")
    expect(out).toContain('status: a.enum(["draft", "published"]).required(),')
  })

  it("marks optional fields without .required()", () => {
    const Article = z.object({
      id: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
    })

    const out = code({ Article })

    expect(out).toContain("title: a.string().required(),")
    expect(out).toContain("subtitle: a.string(),")
    expect(out).not.toContain("subtitle: a.string().required()")
  })

  it("maps string format checks", () => {
    const Contact = z.object({
      id: z.string(),
      email: z.string().email(),
      website: z.string().url(),
    })

    const out = code({ Contact })

    expect(out).toContain("email: a.email().required(),")
    expect(out).toContain("website: a.url().required(),")
  })

  it("maps FK-named string fields to a.id()", () => {
    const Comment = z.object({
      id: z.string(),
      postId: z.string(),
    })

    expect(code({ Comment })).toContain("postId: a.id().required(),")
  })
})

describe("zodToAmplify - Amplify auto fields (createdAt / updatedAt)", () => {
  it("createdAt and updatedAt never get .required()", () => {
    const Event = z.object({
      id: z.string(),
      name: z.string(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    })

    const out = code({ Event })

    expect(out).toContain("createdAt: a.datetime(),")
    expect(out).toContain("updatedAt: a.datetime(),")
    expect(out).not.toContain("createdAt: a.datetime().required()")
    expect(out).not.toContain("updatedAt: a.datetime().required()")
    // Non-auto field still gets .required()
    expect(out).toContain("name: a.string().required(),")
  })
})

describe("zodToAmplify - custom primary key", () => {
  it("emits .identifier() from defineModel primaryKey config", () => {
    const Order = defineModel(
      z.object({ tenantId: z.string(), orderId: z.string(), total: z.number() }),
      { primaryKey: ["tenantId", "orderId"] }
    )

    const out = code({ Order })

    expect(out).toContain('.identifier(["tenantId", "orderId"])')
  })
})

describe("zodToAmplify - unknown type warnings", () => {
  it("returns a warning for unsupported Zod types (falls back to a.json())", () => {
    const Mixed = z.object({
      id: z.string(),
      meta: z.record(z.string()),
    })

    const result = zodToAmplify({ Mixed })

    expect(result.code).toContain("meta: a.json().required(),")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ model: "Mixed", field: "meta" })
  })

  it("returns no warnings when all types are supported", () => {
    const Clean = z.object({ id: z.string(), name: z.string() })

    expect(warns({ Clean })).toHaveLength(0)
  })
})

describe("zodToAmplify - relations via getter syntax", () => {
  it("detects hasMany from z.array(Model) getter", () => {
    const Post = z.object({ id: z.string(), title: z.string() })
    const User = z.object({
      id: z.string(),
      get posts() {
        return z.array(Post)
      },
    })

    expect(code({ User, Post })).toContain('posts: a.hasMany("Post", "userId"),')
  })

  it("detects belongsTo when FK field exists", () => {
    const User = z.object({ id: z.string(), name: z.string() })
    const Post = z.object({
      id: z.string(),
      userId: z.string(),
      get author() {
        return User
      },
    })

    expect(code({ User, Post })).toContain('author: a.belongsTo("User", "userId"),')
  })

  it("detects hasOne when no FK on this side", () => {
    const Profile = z.object({ id: z.string(), bio: z.string() })
    const User = z.object({
      id: z.string(),
      get profile() {
        return Profile
      },
    })

    expect(code({ User, Profile })).toContain('profile: a.hasOne("Profile", "userId"),')
  })

  it("handles bidirectional relation (User ↔ Post)", () => {
    const Post: z.ZodObject<any> = z.object({
      id: z.string(),
      authorId: z.string(),
      get author(): z.ZodObject<any> {
        return User
      },
    })
    const User: z.ZodObject<any> = z.object({
      id: z.string(),
      get posts(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Post)
      },
    })

    const out = code({ User, Post })

    expect(out).toContain('posts: a.hasMany("Post", "authorId"),')
    expect(out).toContain('author: a.belongsTo("User", "authorId"),')
  })
})

describe("zodToAmplify - secondary indexes from registry", () => {
  it("generates .secondaryIndexes() from defineModel config", () => {
    const Post = defineModel(
      z.object({ id: z.string(), authorId: z.string(), createdAt: z.string().datetime() }),
      { indexes: [{ name: "byAuthor", pk: "authorId", sk: "createdAt" }] }
    )

    expect(code({ Post })).toContain(
      '.secondaryIndexes(index => [index("authorId").sortKeys(["createdAt"]).name("byAuthor")])'
    )
  })

  it("generates index without sort key", () => {
    const Item = defineModel(
      z.object({ id: z.string(), category: z.string() }),
      { indexes: [{ name: "byCategory", pk: "category" }] }
    )

    expect(code({ Item })).toContain(
      '.secondaryIndexes(index => [index("category").name("byCategory")])'
    )
  })
})

describe("zodToAmplify - auth rules from registry", () => {
  it("generates owner auth", () => {
    const Note = defineModel(
      z.object({ id: z.string(), content: z.string() }),
      { auth: [{ allow: "owner" }] }
    )
    expect(code({ Note })).toContain(".authorization(allow => [allow.owner()])")
  })

  it("generates owner with custom ownerField", () => {
    const Post = defineModel(
      z.object({ id: z.string(), authorId: z.string() }),
      { auth: [{ allow: "owner", ownerField: "authorId" }] }
    )
    expect(code({ Post })).toContain(
      '.authorization(allow => [allow.owner().ownerDefinedIn("authorId")])'
    )
  })

  it("generates public auth with operations", () => {
    const Article = defineModel(
      z.object({ id: z.string(), body: z.string() }),
      { auth: [{ allow: "public", operations: ["read"] }] }
    )
    expect(code({ Article })).toContain(
      '.authorization(allow => [allow.publicApiKey().to(["read"])])'
    )
  })

  it("generates groups auth", () => {
    const Doc = defineModel(
      z.object({ id: z.string(), content: z.string() }),
      { auth: [{ allow: "groups", groups: ["admin", "editor"] }] }
    )
    expect(code({ Doc })).toContain(
      '.authorization(allow => [allow.groups(["admin", "editor"])])'
    )
  })

  it("combines multiple auth rules", () => {
    const Post = defineModel(
      z.object({ id: z.string(), body: z.string() }),
      { auth: [{ allow: "owner" }, { allow: "public", operations: ["read"] }] }
    )
    expect(code({ Post })).toContain(
      '.authorization(allow => [allow.owner(), allow.publicApiKey().to(["read"])])'
    )
  })
})

describe("zodToAmplify - output structure", () => {
  it("generates valid import and exports", () => {
    const Todo = z.object({ id: z.string(), done: z.boolean() })
    const out = code({ Todo })

    expect(out).toContain('import { a } from "@aws-amplify/backend"')
    expect(out).toContain("const schema = a.schema({")
    expect(out).toContain("export { schema }")
    expect(out).toContain("export type Schema = typeof schema")
  })

  it("full example from conversation", () => {
    const Post = defineModel(
      z.object({
        id: z.string().uuid(),
        authorId: z.string(),
        title: z.string().max(200),
        status: z.enum(["draft", "published"]),
        createdAt: z.string().datetime(),
        get author(): z.ZodObject<any> {
          return User
        },
      }),
      {
        indexes: [
          { name: "byAuthor", pk: "authorId", sk: "createdAt" },
          { name: "byStatus", pk: "status", sk: "createdAt" },
        ],
        auth: [{ allow: "owner", ownerField: "authorId" }],
      }
    )
    const User = defineModel(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        get posts(): z.ZodArray<z.ZodObject<any>> {
          return z.array(Post)
        },
      }),
      { auth: [{ allow: "owner" }] }
    )

    const out = code({ User, Post })

    expect(out).toContain('posts: a.hasMany("Post", "authorId"),')
    expect(out).toContain('author: a.belongsTo("User", "authorId"),')
    expect(out).toContain('index("authorId").sortKeys(["createdAt"]).name("byAuthor")')
    expect(out).toContain('index("status").sortKeys(["createdAt"]).name("byStatus")')
    expect(out).toContain('.ownerDefinedIn("authorId")')
  })
})

describe("zodToAmplify - ZodDefault fields", () => {
  it("emits .default() and no .required() for fields with defaults", () => {
    const Article = z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["draft", "published"]).default("draft"),
      views: z.number().int().default(0),
      featured: z.boolean().default(false),
    })

    const out = code({ Article })

    expect(out).toContain('status: a.enum(["draft", "published"]).default("draft"),')
    expect(out).toContain("views: a.integer().default(0),")
    expect(out).toContain("featured: a.boolean().default(false),")
    expect(out).not.toContain('status: a.enum(["draft", "published"]).required()')
  })

  it("handles string default", () => {
    const Config = z.object({ id: z.string(), region: z.string().default("us-east-1") })
    expect(code({ Config })).toContain('region: a.string().default("us-east-1"),')
  })

  it("does not emit .default() for optional fields without a default", () => {
    const Item = z.object({ id: z.string(), note: z.string().optional() })
    const out = code({ Item })
    expect(out).toContain("note: a.string(),")
    expect(out).not.toContain(".default(")
  })
})

describe("zodToAmplify - manyToMany", () => {
  it("detects mutual hasMany and emits a.manyToMany on both sides", () => {
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

    const out = code({ Post, Tag })

    expect(out).toContain('tags: a.manyToMany("Tag", { relationName: "PostTag" }),')
    expect(out).toContain('posts: a.manyToMany("Post", { relationName: "PostTag" }),')
    expect(out).not.toContain("a.hasMany")
    expect(out).not.toContain("a.belongsTo")
  })

  it("uses alphabetical sort for relationName regardless of definition order", () => {
    const Z: z.ZodObject<any> = z.object({
      id: z.string(),
      get as(): z.ZodArray<z.ZodObject<any>> {
        return z.array(A)
      },
    })
    const A: z.ZodObject<any> = z.object({
      id: z.string(),
      get zs(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Z)
      },
    })

    expect(code({ A, Z })).toContain('{ relationName: "AZ" }')
  })

  it("unilateral hasMany stays as hasMany (not manyToMany)", () => {
    const Comment = z.object({ id: z.string(), body: z.string() })
    const Post = z.object({
      id: z.string(),
      get comments(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Comment)
      },
    })

    const out = code({ Post, Comment })

    expect(out).toContain('a.hasMany("Comment"')
    expect(out).not.toContain("manyToMany")
  })

  it("manyToMany coexists with regular hasMany in the same model", () => {
    const Tag: z.ZodObject<any> = z.object({
      id: z.string(),
      get posts(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Post)
      },
    })
    const Comment = z.object({ id: z.string(), body: z.string() })
    const Post: z.ZodObject<any> = z.object({
      id: z.string(),
      get tags(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Tag)
      },
      get comments(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Comment)
      },
    })

    const out = code({ Post, Tag, Comment })

    expect(out).toContain('tags: a.manyToMany("Tag", { relationName: "PostTag" }),')
    expect(out).toContain('a.hasMany("Comment"')
  })
})
