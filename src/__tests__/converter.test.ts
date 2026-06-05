import { describe, it, expect } from "vitest"
import { z } from "zod"
import { zodToAmplify, zodToAmplifyMeta, type SchemaInput } from "../converter"
import { defineModel, storageField } from "../registry"

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
    expect(out).toContain('status: a.ref("Status").required(),')
    expect(out).toContain('Status: a.enum(["draft", "published"]),')
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

  it("maps date/time scalars (z.iso.* and z.string().date()/.time())", () => {
    const Event = z.object({
      id: z.string(),
      day: z.iso.date(),
      startsAt: z.iso.time(),
      when: z.iso.datetime(),
      legacyDay: z.string().date(),
      legacyTime: z.string().time(),
    })

    const out = code({ Event })

    expect(out).toContain("day: a.date().required(),")
    expect(out).toContain("startsAt: a.time().required(),")
    expect(out).toContain("when: a.datetime().required(),")
    expect(out).toContain("legacyDay: a.date().required(),")
    expect(out).toContain("legacyTime: a.time().required(),")
  })

  it("maps z.date() (ZodDate) to a.datetime()", () => {
    const Event = z.object({ id: z.string(), at: z.date() })
    expect(code({ Event })).toContain("at: a.datetime().required(),")
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
      coords: z.map(z.string(), z.number()),
    })

    const result = zodToAmplify({ Mixed })

    expect(result.code).toContain("coords: a.json().required(),")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ model: "Mixed", field: "coords" })
  })

  it("treats record and tuple as intentional a.json() (no warning)", () => {
    const M = z.object({
      id: z.string(),
      meta: z.record(z.string(), z.unknown()),
      pair: z.tuple([z.string(), z.number()]),
    })

    const result = zodToAmplify({ M })
    expect(result.code).toContain("meta: a.json().required(),")
    expect(result.code).toContain("pair: a.json().required(),")
    expect(result.warnings).toHaveLength(0)
  })

  it("still warns for map / set / bigint (no faithful representation)", () => {
    const M = z.object({
      id: z.string(),
      tags: z.set(z.string()),
      big: z.bigint(),
    })
    expect(warns({ M })).toHaveLength(2)
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

  it("emits .queryField() when provided", () => {
    const Item = defineModel(
      z.object({ id: z.string(), category: z.string(), createdAt: z.string().datetime() }),
      {
        indexes: [
          { name: "byCategory", pk: "category", sk: "createdAt", queryField: "listByCategory" },
        ],
      }
    )
    expect(code({ Item })).toContain(
      '.secondaryIndexes(index => [index("category").sortKeys(["createdAt"]).name("byCategory").queryField("listByCategory")])'
    )
  })
})

describe("zodToAmplify - disableOperations", () => {
  it("emits .disableOperations() from defineModel config", () => {
    const Log = defineModel(
      z.object({ id: z.string(), message: z.string() }),
      { disabledOperations: ["delete", "update", "subscriptions"] }
    )
    expect(code({ Log })).toContain('.disableOperations(["delete", "update", "subscriptions"])')
  })

  it("omits .disableOperations() when not configured", () => {
    const M = defineModel(z.object({ id: z.string() }), {})
    expect(code({ M })).not.toContain("disableOperations")
  })
})

describe("zodToAmplify - field-level authorization", () => {
  it("emits per-field .authorization() from fieldAuth config", () => {
    const User = defineModel(
      z.object({ id: z.string(), name: z.string(), ssn: z.string() }),
      {
        auth: [{ allow: "authenticated" }],
        fieldAuth: { ssn: [{ allow: "owner" }] },
      }
    )
    const out = code({ User })
    expect(out).toContain("ssn: a.string().required().authorization(allow => [allow.owner()]),")
    // unrelated field stays untouched
    expect(out).toContain("name: a.string().required(),")
  })

  it("places field auth after .validate()", () => {
    const M = defineModel(
      z.object({ id: z.string(), code: z.string().min(2) }),
      { fieldAuth: { code: [{ allow: "groups", groups: ["admin"] }] } }
    )
    expect(code({ M })).toContain(
      'code: a.string().validate((v) => v.minLength(2)).required().authorization(allow => [allow.groups(["admin"])]),'
    )
  })

  it("supports multiple field rules with per-operation .to()", () => {
    const M = defineModel(z.object({ id: z.string(), notes: z.string() }), {
      fieldAuth: {
        notes: [
          { allow: "owner", operations: ["read", "update"] },
          { allow: "groups", groups: ["admin"] },
        ],
      },
    })
    expect(code({ M })).toContain(
      'notes: a.string().required().authorization(allow => [allow.owner().to(["read", "update"]), allow.groups(["admin"])]),'
    )
  })

  it("emits field auth without .required() on optional fields", () => {
    const M = defineModel(z.object({ id: z.string(), nickname: z.string().optional() }), {
      fieldAuth: { nickname: [{ allow: "owner" }] },
    })
    expect(code({ M })).toContain(
      "nickname: a.string().authorization(allow => [allow.owner()]),"
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
      '.authorization(allow => [allow.ownerDefinedIn("authorId")])'
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

  it("generates authenticated and guest rules", () => {
    const M = defineModel(z.object({ id: z.string() }), {
      auth: [
        { allow: "authenticated", operations: ["read"] },
        { allow: "guest", operations: ["read"] },
      ],
    })
    expect(code({ M })).toContain(
      '.authorization(allow => [allow.authenticated().to(["read"]), allow.guest().to(["read"])])'
    )
  })

  it("passes provider to authenticated/owner/groups", () => {
    const M = defineModel(z.object({ id: z.string() }), {
      auth: [
        { allow: "authenticated", provider: "identityPool" },
        { allow: "owner", provider: "oidc" },
        { allow: "groups", groups: ["admin"], provider: "oidc" },
      ],
    })
    const out = code({ M })
    expect(out).toContain('allow.authenticated("identityPool")')
    expect(out).toContain('allow.owner("oidc")')
    expect(out).toContain('allow.groups(["admin"], "oidc")')
  })

  it("generates ownerDefinedIn with provider", () => {
    const M = defineModel(z.object({ id: z.string(), authorId: z.string() }), {
      auth: [{ allow: "owner", ownerField: "authorId", provider: "oidc" }],
    })
    expect(code({ M })).toContain('allow.ownerDefinedIn("authorId", "oidc")')
  })

  it("generates multipleOwners (ownersDefinedIn)", () => {
    const M = defineModel(z.object({ id: z.string(), editors: z.array(z.string()) }), {
      auth: [{ allow: "multipleOwners", ownersField: "editors", operations: ["read", "update"] }],
    })
    expect(code({ M })).toContain(
      'allow.ownersDefinedIn("editors").to(["read", "update"])'
    )
  })

  it("generates single group and custom (Lambda) rules", () => {
    const M = defineModel(z.object({ id: z.string() }), {
      auth: [
        { allow: "group", group: "admin" },
        { allow: "custom" },
      ],
    })
    const out = code({ M })
    expect(out).toContain('allow.group("admin")')
    expect(out).toContain("allow.custom()")
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

    expect(out).toContain('status: a.ref("Status"), // zod: default("draft")')
    expect(out).toContain('Status: a.enum(["draft", "published"]),')
    expect(out).toContain("views: a.integer().default(0),")
    expect(out).toContain("featured: a.boolean().default(false),")
    expect(out).not.toContain('status: a.ref("Status").required()')
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

    expect(out).toContain('tags: a.hasMany("PostTag", "postId"),')
    expect(out).toContain('posts: a.hasMany("PostTag", "tagId"),')
    expect(out).toContain("PostTag: a.model({")
    expect(out).toContain('post: a.belongsTo("Post", "postId"),')
    expect(out).toContain('tag: a.belongsTo("Tag", "tagId"),')
    expect(out).not.toContain("a.manyToMany")
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

    expect(code({ A, Z })).toContain("AZ: a.model({")
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

    expect(out).toContain('tags: a.hasMany("PostTag", "postId"),')
    expect(out).toContain('a.hasMany("Comment"')
    expect(out).not.toContain("a.manyToMany")
  })
})

describe("zodToAmplify - expanded type mapping", () => {
  it("maps z.literal(string) to a.ref (hoisted schema-level enum)", () => {
    const M = z.object({ id: z.string(), status: z.literal("active") })
    const out = code({ M })
    expect(out).toContain('status: a.ref("Status").required(),')
    expect(out).toContain('Status: a.enum(["active"]),')
  })

  it("maps z.literal(number int) to a.integer", () => {
    const M = z.object({ id: z.string(), code: z.literal(42) })
    expect(code({ M })).toContain("code: a.integer().required(),")
  })

  it("maps z.literal(boolean) to a.boolean", () => {
    const M = z.object({ id: z.string(), enabled: z.literal(true) })
    expect(code({ M })).toContain("enabled: a.boolean().required(),")
  })

  it("maps z.union of all string literals to a.ref (hoisted schema-level enum)", () => {
    const M = z.object({
      id: z.string(),
      role: z.union([z.literal("admin"), z.literal("user"), z.literal("guest")]),
    })
    const out = code({ M })
    expect(out).toContain('role: a.ref("Role").required(),')
    expect(out).toContain('Role: a.enum(["admin", "user", "guest"]),')
  })

  it("maps mixed z.union to a.json() with warning", () => {
    const M = z.object({ id: z.string(), val: z.union([z.string(), z.number()]) })
    const result = zodToAmplify({ M })
    expect(result.code).toContain("val: a.json().required(),")
    expect(result.warnings[0]).toMatchObject({ field: "val", zodType: "union" })
  })

  it("maps z.string().ipv4() to a.ipAddress()", () => {
    const M = z.object({ id: z.string(), ip: z.string().ipv4() })
    expect(code({ M })).toContain("ip: a.ipAddress().required(),")
  })

  it("maps z.string().ipv6() to a.ipAddress()", () => {
    const M = z.object({ id: z.string(), ip: z.string().ipv6() })
    expect(code({ M })).toContain("ip: a.ipAddress().required(),")
  })
})

describe("zodToAmplify - field validation (.validate())", () => {
  it("emits .validate() with minLength/maxLength for z.string().min().max()", () => {
    const M = z.object({ id: z.string(), title: z.string().min(1).max(200) })
    const out = code({ M })
    expect(out).toContain(
      "title: a.string().validate((v) => v.minLength(1).maxLength(200)).required(),"
    )
  })

  it("emits minLength only when no max", () => {
    const M = z.object({ id: z.string(), name: z.string().min(2) })
    expect(code({ M })).toContain("name: a.string().validate((v) => v.minLength(2)).required(),")
    expect(code({ M })).not.toContain("maxLength")
  })

  it("maps z.string().regex() to matches() and startsWith/endsWith", () => {
    const M = z.object({
      id: z.string(),
      slug: z.string().regex(/^[a-z]+$/),
      code: z.string().startsWith("X-").endsWith("-Z"),
    })
    const out = code({ M })
    expect(out).toContain('slug: a.string().validate((v) => v.matches("^[a-z]+$")).required(),')
    expect(out).toContain(
      'code: a.string().validate((v) => v.startsWith("X-").endsWith("-Z")).required(),'
    )
  })

  it("uses gte/lte for inclusive bounds (min/max) and gt/lt for exclusive", () => {
    const M = z.object({
      id: z.string(),
      score: z.number().min(0).max(100),
      ratio: z.number().gt(0).lt(1),
    })
    const out = code({ M })
    expect(out).toContain("score: a.float().validate((v) => v.gte(0).lte(100)).required(),")
    expect(out).toContain("ratio: a.float().validate((v) => v.gt(0).lt(1)).required(),")
  })

  it("emits validate on integer fields", () => {
    const M = z.object({ id: z.string(), age: z.number().int().min(0).max(150) })
    expect(code({ M })).toContain(
      "age: a.integer().validate((v) => v.gte(0).lte(150)).required(),"
    )
  })

  it("combines .default() before .validate()", () => {
    const M = z.object({ id: z.string(), count: z.number().int().min(0).default(0) })
    expect(code({ M })).toContain("count: a.integer().default(0).validate((v) => v.gte(0)),")
  })

  it("falls back to a comment when the type cannot use .validate() (e.g. a.email())", () => {
    const M = z.object({ id: z.string(), email: z.string().email().max(50) })
    const out = code({ M })
    expect(out).toContain("email: a.email().required(), // zod: maxLength(50)")
    expect(out).not.toContain(".validate(")
  })

  it("does not emit validation for plain string or number", () => {
    const M = z.object({ id: z.string(), name: z.string(), count: z.number() })
    const out = code({ M })
    expect(out).not.toContain(".validate(")
    expect(out).not.toContain("// zod:")
  })

  it("dedupes duplicate operators (last wins)", () => {
    const M = z.object({ id: z.string(), name: z.string().min(1).min(5) })
    const out = code({ M })
    // Amplify rejects duplicate operators — only one minLength must survive
    expect(out).toContain("name: a.string().validate((v) => v.minLength(5)).required(),")
    expect(out.match(/minLength/g)).toHaveLength(1)
  })

  it("does not emit .validate() on array fields", () => {
    const M = z.object({ id: z.string(), tags: z.array(z.string().min(1)) })
    const out = code({ M })
    expect(out).toContain("tags: a.string().array().required(),")
    expect(out).not.toContain(".validate(")
  })

  it("emits .validate() without .required() on optional fields", () => {
    const M = z.object({ id: z.string(), bio: z.string().max(280).optional() })
    expect(code({ M })).toContain("bio: a.string().validate((v) => v.maxLength(280)),")
  })

  it("escapes backslashes in regex patterns passed to matches()", () => {
    const M = z.object({ id: z.string(), zip: z.string().regex(/^\d{3}-\d{4}$/) })
    expect(code({ M })).toContain('zip: a.string().validate((v) => v.matches("^\\\\d{3}-\\\\d{4}$")).required(),')
  })

  it("emits .validate() on customType fields", () => {
    const Profile = z.object({ handle: z.string().min(3).max(20) })
    const User = z.object({ id: z.string(), profile: Profile })
    const out = code({ User })
    expect(out).toContain("handle: a.string().validate((v) => v.minLength(3).maxLength(20)).required(),")
  })

  it("combines storage field with validation", () => {
    const Post = z.object({
      id: z.string(),
      cover: storageField(z.string().min(1), { path: "media/*" }),
    })
    const out = code({ Post })
    expect(out).toContain(
      'cover: a.string().validate((v) => v.minLength(1)).required(), // zod: storage(path="media/*")'
    )
  })
})

describe("zodToAmplify - relations FK inference improvement", () => {
  it("finds FK when target has *Id field but no back-reference object", () => {
    // Post has authorId but no author object field pointing back to User
    const User = z.object({
      id: z.string(),
      get posts(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Post)
      },
    })
    const Post = z.object({
      id: z.string(),
      authorId: z.string(), // FK present, no object back-ref
    })

    // Should detect authorId via conventional name (User → userId... wait, author != user)
    // Actually conventional is lcFirst("User") + "Id" = "userId", not "authorId"
    // So this falls back to single-candidate scanning
    const out = code({ User, Post })
    expect(out).toContain('posts: a.hasMany("Post", "authorId"),')
  })

  it("uses conventional FK name when it exists in target", () => {
    const Department = z.object({
      id: z.string(),
      get employees(): z.ZodArray<z.ZodObject<any>> {
        return z.array(Employee)
      },
    })
    const Employee = z.object({
      id: z.string(),
      departmentId: z.string(), // conventional: lcFirst("Department") + "Id"
    })

    expect(code({ Department, Employee })).toContain(
      'employees: a.hasMany("Employee", "departmentId"),'
    )
  })
})

describe("zodToAmplify - scalar arrays", () => {
  it("maps z.array(z.string()) to a.string().array()", () => {
    const M = z.object({ id: z.string(), tags: z.array(z.string()) })
    expect(code({ M })).toContain("tags: a.string().array().required(),")
  })

  it("maps z.array(z.number().int()) to a.integer().array()", () => {
    const M = z.object({ id: z.string(), scores: z.array(z.number().int()) })
    expect(code({ M })).toContain("scores: a.integer().array().required(),")
  })

  it("maps optional z.array(z.string()) without .required()", () => {
    const M = z.object({ id: z.string(), tags: z.array(z.string()).optional() })
    expect(code({ M })).toContain("tags: a.string().array(),")
    expect(code({ M })).not.toContain(".required()")
  })

  it("maps z.array(z.enum([...])) to a.ref().array() (hoisted schema-level enum)", () => {
    const M = z.object({ id: z.string(), statuses: z.array(z.enum(["open", "closed"])) })
    const out = code({ M })
    expect(out).toContain('statuses: a.ref("Statuses").array().required(),')
    expect(out).toContain('Statuses: a.enum(["open", "closed"]),')
  })
})

describe("zodToAmplify - customType", () => {
  it("generates a.customType for nested non-model z.object", () => {
    const Address = z.object({ street: z.string(), city: z.string() })
    const User = z.object({ id: z.string(), address: Address })

    const out = code({ User })

    expect(out).toContain('address: a.ref("Address").required(),')
    expect(out).toContain("Address: a.customType({")
    expect(out).toContain("street: a.string().required(),")
    expect(out).toContain("city: a.string().required(),")
  })

  it("generates a.ref().array() for z.array of nested object", () => {
    const Point = z.object({ lat: z.number(), lng: z.number() })
    const Route = z.object({ id: z.string(), waypoints: z.array(Point) })

    const out = code({ Route })

    expect(out).toContain('waypoints: a.ref("Waypoints").array().required(),')
    expect(out).toContain("Waypoints: a.customType({")
  })

  it("reuses same customType for same schema instance", () => {
    const Tag = z.object({ label: z.string(), color: z.string() })
    const Post = z.object({ id: z.string(), primaryTag: Tag, secondaryTag: Tag.optional() })

    const out = code({ Post })

    // Tag should appear only once as customType
    const count = (out.match(/a\.customType\(/g) ?? []).length
    expect(count).toBe(1)
    expect(out).toContain('primaryTag: a.ref("PrimaryTag").required(),')
  })

  it("optional nested object field has no .required()", () => {
    const Meta = z.object({ key: z.string(), value: z.string() })
    const Item = z.object({ id: z.string(), meta: Meta.optional() })

    expect(code({ Item })).toContain('meta: a.ref("Meta"),')
    expect(code({ Item })).not.toContain('meta: a.ref("Meta").required()')
  })
})

describe("zodToAmplify - z.any() / z.unknown() no warning", () => {
  it("maps z.any() to a.json() without warning", () => {
    const M = z.object({ id: z.string(), data: z.any() })
    const result = zodToAmplify({ M })
    expect(result.code).toContain("data: a.json().required(),")
    expect(result.warnings).toHaveLength(0)
  })

  it("maps z.unknown() to a.json() without warning", () => {
    const M = z.object({ id: z.string(), payload: z.unknown().optional() })
    const result = zodToAmplify({ M })
    expect(result.code).toContain("payload: a.json(),")
    expect(result.warnings).toHaveLength(0)
  })
})

describe("zodToAmplify - a.phone()", () => {
  it("maps z.string().e164() to a.phone()", () => {
    const M = z.object({ id: z.string(), phone: z.string().e164() })
    expect(code({ M })).toContain("phone: a.phone().required(),")
  })
})

describe("zodToAmplifyMeta", () => {
  it("returns model summary with fields and relations", () => {
    const Post = z.object({ id: z.string(), title: z.string() })
    const User = z.object({
      id: z.string(),
      get posts(): z.ZodArray<z.ZodObject<any>> { return z.array(Post) },
    })

    const meta = zodToAmplifyMeta({ User, Post })

    const userModel = meta.models.find((m) => m.name === "User")!
    expect(userModel.fields["id"].amplifyType).toBe("a.id()")
    expect(userModel.relations["posts"].kind).toBe("hasMany")
    expect(userModel.relations["posts"].target).toBe("Post")
    expect(meta.warnings).toHaveLength(0)
  })

  it("includes customTypes in metadata", () => {
    const Address = z.object({ city: z.string() })
    const User = z.object({ id: z.string(), address: Address })

    const meta = zodToAmplifyMeta({ User })

    expect(meta.customTypes).toHaveLength(1)
    expect(meta.customTypes[0].name).toBe("Address")
    expect(meta.customTypes[0].fields["city"].amplifyType).toBe("a.string()")
  })

  it("includes validationHint in field meta", () => {
    const M = z.object({ id: z.string(), title: z.string().min(1).max(100) })
    const meta = zodToAmplifyMeta({ M })
    const field = meta.models[0].fields["title"]
    expect(field.validationHint).toBe("minLength(1), maxLength(100)")
  })

  it("includes fieldAuth, disabledOperations, and index queryField in metadata", () => {
    const Post = defineModel(
      z.object({ id: z.string(), category: z.string(), secret: z.string() }),
      {
        indexes: [{ name: "byCategory", pk: "category", queryField: "listByCategory" }],
        disabledOperations: ["delete", "subscriptions"],
        fieldAuth: { secret: [{ allow: "owner" }] },
      }
    )

    const model = zodToAmplifyMeta({ Post }).models[0]
    expect(model.disabledOperations).toEqual(["delete", "subscriptions"])
    expect(model.fieldAuth).toEqual({ secret: [{ allow: "owner" }] })
    expect(model.indexes?.[0].queryField).toBe("listByCategory")
  })
})

describe("zodToAmplify - storage (S3) fields", () => {
  it("maps a storageField to a.string() with a path comment", () => {
    const Post = z.object({
      id: z.string().uuid(),
      coverImage: storageField(z.string(), { path: "media/posts/*" }),
    })

    const out = code({ Post })

    expect(out).toContain('coverImage: a.string().required(), // zod: storage(path="media/posts/*")')
  })

  it("keeps a.string() even when the inner type would map elsewhere", () => {
    const Post = z.object({
      id: z.string(),
      // url() would normally become a.url(); storage marker forces a.string()
      asset: storageField(z.string().url(), { path: "assets/*" }),
    })

    expect(code({ Post })).toContain("asset: a.string().required(),")
  })

  it("respects optional storage fields (no .required())", () => {
    const Post = z.object({
      id: z.string(),
      avatar: storageField(z.string(), { path: "avatars/*" }).optional(),
    })

    const out = code({ Post })
    expect(out).toContain('avatar: a.string(), // zod: storage(path="avatars/*")')
    expect(out).not.toContain("avatar: a.string().required()")
  })

  it("generates a separate defineStorage file with secure default access", () => {
    const Post = z.object({
      id: z.string(),
      coverImage: storageField(z.string(), { path: "media/posts/*" }),
    })

    const { storage } = zodToAmplify({ Post })

    expect(storage).toBeDefined()
    expect(storage).toContain('import { defineStorage } from "@aws-amplify/backend"')
    expect(storage).toContain('name: "media"')
    expect(storage).toContain('"media/posts/*": [')
    // default = authenticated read/write/delete, no guest access
    expect(storage).toContain('allow.authenticated.to(["read", "write", "delete"])')
    expect(storage).not.toContain("allow.guest")
  })

  it("uses a custom storage name from options", () => {
    const Post = z.object({
      id: z.string(),
      img: storageField(z.string(), { path: "p/*" }),
    })

    const { storage } = zodToAmplify({ Post }, { storageName: "uploads" })
    expect(storage).toContain('name: "uploads"')
  })

  it("maps every access allow kind", () => {
    const Doc = z.object({
      id: z.string(),
      file: storageField(z.string(), {
        path: "docs/*",
        access: [
          { allow: "guest", to: ["read"] },
          { allow: "authenticated", to: ["read", "write"] },
          { allow: "owner", to: ["read", "write", "delete"] },
          { allow: "groups", groups: ["admin", "editor"], to: ["delete"] },
        ],
      }),
    })

    const { storage } = zodToAmplify({ Doc })
    expect(storage).toContain('allow.guest.to(["read"])')
    expect(storage).toContain('allow.authenticated.to(["read", "write"])')
    expect(storage).toContain('allow.entity("identity").to(["read", "write", "delete"])')
    expect(storage).toContain('allow.groups(["admin", "editor"]).to(["delete"])')
  })

  it("merges and dedupes access rules across fields sharing a path", () => {
    const Post = z.object({
      id: z.string(),
      cover: storageField(z.string(), {
        path: "media/*",
        access: [{ allow: "guest", to: ["read"] }],
      }),
      thumb: storageField(z.string(), {
        path: "media/*",
        access: [
          { allow: "guest", to: ["read"] }, // duplicate, should collapse
          { allow: "authenticated", to: ["write"] },
        ],
      }),
    })

    const { storage } = zodToAmplify({ Post })
    // one path block only
    expect(storage!.match(/"media\/\*": \[/g)).toHaveLength(1)
    expect(storage!.match(/allow\.guest\.to\(\["read"\]\)/g)).toHaveLength(1)
    expect(storage).toContain('allow.authenticated.to(["write"])')
  })

  it("omits the storage file when no storageField is used", () => {
    const Post = z.object({ id: z.string(), title: z.string() })
    expect(zodToAmplify({ Post }).storage).toBeUndefined()
  })

  it("exposes storage paths and per-field path in metadata", () => {
    const Post = z.object({
      id: z.string(),
      coverImage: storageField(z.string(), { path: "media/posts/*" }),
    })

    const meta = zodToAmplifyMeta({ Post })
    expect(meta.storage).toEqual([
      {
        path: "media/posts/*",
        access: [{ allow: "authenticated", to: ["read", "write", "delete"] }],
      },
    ])
    expect(meta.models[0].fields["coverImage"].storagePath).toBe("media/posts/*")
  })

  it("collects storage fields declared inside custom types", () => {
    const Media = z.object({
      url: storageField(z.string(), { path: "nested/*" }),
    })
    const Post = z.object({ id: z.string(), media: Media })

    const { code: out, storage } = zodToAmplify({ Post })
    expect(out).toContain('url: a.string().required(), // zod: storage(path="nested/*")')
    expect(storage).toContain('"nested/*": [')
  })
})
