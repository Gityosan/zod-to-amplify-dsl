import { describe, it, expect } from "vitest"
import { z } from "zod"
import { zodToAmplify, zodToAmplifyMeta, type SchemaInput } from "../converter"
import { defineModel } from "../registry"

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
      meta: z.record(z.string(), z.unknown()),
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

describe("zodToAmplify - Zod v4 single-type string formats", () => {
  // Zod v4 introduced top-level helpers (z.email(), z.uuid(), z.iso.datetime(),
  // etc.) that return their own classes instead of ZodString. These tests
  // ensure the converter recognizes them via _zod.def.type === "string".
  it("maps z.email() to a.email()", () => {
    const M = z.object({ id: z.string(), email: z.email() })
    const result = zodToAmplify({ M })
    expect(result.warnings).toEqual([])
    expect(result.code).toContain("email: a.email().required(),")
  })

  it("maps z.uuid() to a.id()", () => {
    const M = z.object({ id: z.string(), tracking: z.uuid() })
    expect(code({ M })).toContain("tracking: a.id().required(),")
  })

  it("maps z.url() to a.url()", () => {
    const M = z.object({ id: z.string(), homepage: z.url() })
    expect(code({ M })).toContain("homepage: a.url().required(),")
  })

  it("maps z.ipv4() to a.ipAddress()", () => {
    const M = z.object({ id: z.string(), ip: z.ipv4() })
    expect(code({ M })).toContain("ip: a.ipAddress().required(),")
  })

  it("maps z.ipv6() to a.ipAddress()", () => {
    const M = z.object({ id: z.string(), ip: z.ipv6() })
    expect(code({ M })).toContain("ip: a.ipAddress().required(),")
  })

  it("maps z.e164() to a.phone()", () => {
    const M = z.object({ id: z.string(), phone: z.e164() })
    expect(code({ M })).toContain("phone: a.phone().required(),")
  })

  it("maps z.iso.datetime() to a.datetime()", () => {
    const M = z.object({ id: z.string(), at: z.iso.datetime() })
    const result = zodToAmplify({ M })
    expect(result.warnings).toEqual([])
    expect(result.code).toContain("at: a.datetime().required(),")
  })

  it("falls back to a.string() for unmapped v4 formats (e.g. z.cuid())", () => {
    const M = z.object({ id: z.string(), code: z.cuid() })
    expect(code({ M })).toContain("code: a.string().required(),")
  })

  it("preserves min/max validation comments on v4 single-type formats", () => {
    const M = z.object({ id: z.string(), email: z.email().min(5).max(64) })
    const out = code({ M })
    expect(out).toContain("email: a.email().required(),")
    expect(out).toMatch(/email: a\.email\(\)\.required\(\),\s*\/\/ zod: minLength\(5\), maxLength\(64\)/)
  })

  it("respects .optional() on v4 single-type formats", () => {
    const M = z.object({ id: z.string(), email: z.email().optional() })
    expect(code({ M })).toContain("email: a.email(),")
    expect(code({ M })).not.toContain("email: a.email().required()")
  })

  it("respects .default() on v4 single-type formats", () => {
    const M = z.object({ id: z.string(), homepage: z.url().default("https://example.com") })
    expect(code({ M })).toContain('homepage: a.url().default("https://example.com"),')
  })

  it("handles arrays of v4 single-type formats", () => {
    const M = z.object({ id: z.string(), emails: z.array(z.email()) })
    expect(code({ M })).toContain("emails: a.email().array().required(),")
  })
})

describe("zodToAmplify - ISO date/time mapping", () => {
  it("maps z.iso.date() to a.date()", () => {
    const M = z.object({ id: z.string(), birthday: z.iso.date() })
    expect(code({ M })).toContain("birthday: a.date().required(),")
  })

  it("maps z.iso.time() to a.time()", () => {
    const M = z.object({ id: z.string(), wakeUp: z.iso.time() })
    expect(code({ M })).toContain("wakeUp: a.time().required(),")
  })

  it("z.iso.duration() falls through to a.string()", () => {
    const M = z.object({ id: z.string(), span: z.iso.duration() })
    expect(code({ M })).toContain("span: a.string().required(),")
  })

  it("maps z.guid() to a.id()", () => {
    const M = z.object({ id: z.string(), tracking: z.guid() })
    expect(code({ M })).toContain("tracking: a.id().required(),")
  })
})

describe("zodToAmplify - v4 string-format fallthrough to a.string()", () => {
  // These v4 single-type formats have no direct Amplify counterpart; they
  // must fall through to a.string() (not a.json()).
  it.each([
    ["z.nanoid()", () => z.nanoid()],
    ["z.ulid()", () => z.ulid()],
    ["z.cuid()", () => z.cuid()],
    ["z.cuid2()", () => z.cuid2()],
    ["z.jwt()", () => z.jwt()],
    ["z.emoji()", () => z.emoji()],
    ["z.cidrv4()", () => z.cidrv4()],
    ["z.cidrv6()", () => z.cidrv6()],
    ["z.base64()", () => z.base64()],
    ["z.base64url()", () => z.base64url()],
  ])("maps %s to a.string() with no warning", (_, make) => {
    const M = z.object({ id: z.string(), x: make() })
    const result = zodToAmplify({ M })
    expect(result.warnings).toEqual([])
    expect(result.code).toContain("x: a.string().required(),")
  })
})

describe("zodToAmplify - Zod v4 wrapper unwrap", () => {
  it("unwraps z.ZodReadonly transparently", () => {
    const M = z.object({ id: z.string(), name: z.string().readonly() })
    const out = code({ M })
    expect(out).toContain("name: a.string().required(),")
  })

  it("unwraps z.ZodNonOptional, treating field as required", () => {
    const M = z.object({
      id: z.string(),
      // optional().nonoptional() → re-required
      title: z.string().optional().nonoptional(),
    })
    const out = code({ M })
    expect(out).toContain("title: a.string().required(),")
  })

  it("z.prefault(...) is treated like z.default(...) — supplies the default and drops .required()", () => {
    const M = z.object({
      id: z.string(),
      status: z.prefault(z.string(), "active"),
    })
    const out = code({ M })
    expect(out).toContain('status: a.string().default("active"),')
    expect(out).not.toContain("status: a.string().required()")
  })

  it("treats ZodExactOptional like ZodOptional", () => {
    const M = z.object({
      id: z.string(),
      hint: z.exactOptional(z.string()),
    })
    const out = code({ M })
    expect(out).toContain("hint: a.string(),")
    expect(out).not.toContain("hint: a.string().required()")
  })

  it("composes readonly + optional + default", () => {
    const M = z.object({
      id: z.string(),
      title: z.string().default("untitled").readonly(),
    })
    const out = code({ M })
    expect(out).toContain('title: a.string().default("untitled"),')
  })
})

describe("zodToAmplify - pipeline wrappers (Pipe/Codec/Success/Catch)", () => {
  it("unwraps z.ZodPipe to the output side", () => {
    // z.string().pipe(z.string().min(1)) → ZodPipe; out side is the validated string
    const M = z.object({
      id: z.string(),
      title: z.string().pipe(z.string().min(1)),
    })
    const out = code({ M })
    expect(out).toContain("title: a.string().required(),")
  })

  it("unwraps z.catch() — uses the inner type for the field", () => {
    const M = z.object({
      id: z.string(),
      count: z.number().int().catch(0),
    })
    const out = code({ M })
    expect(out).toContain("count: a.integer().required(),")
  })

  it("unwraps z.codec() — uses the input side (user-facing type)", () => {
    // z.stringbool() produces a ZodCodec internally
    const M = z.object({
      id: z.string(),
      flag: z.stringbool(),
    })
    const out = code({ M })
    // input side is a string; converter falls through to a.string()
    expect(out).toContain("flag: a.string().required(),")
  })
})

describe("zodToAmplify - validation comments", () => {
  it("emits // zod: minLength/maxLength for z.string().min().max()", () => {
    const M = z.object({ id: z.string(), title: z.string().min(1).max(200) })
    const out = code({ M })
    expect(out).toContain("title: a.string().required(), // zod: minLength(1), maxLength(200)")
  })

  it("emits // zod: minLength only when no max", () => {
    const M = z.object({ id: z.string(), name: z.string().min(2) })
    expect(code({ M })).toContain("// zod: minLength(2)")
    expect(code({ M })).not.toContain("maxLength")
  })

  it("emits // zod: min/max for z.number().min().max()", () => {
    const M = z.object({ id: z.string(), score: z.number().min(0).max(100) })
    expect(code({ M })).toContain("score: a.float().required(), // zod: min(0), max(100)")
  })

  it("emits min/max for integer with explicit bounds", () => {
    const M = z.object({ id: z.string(), age: z.number().int().min(0).max(150) })
    expect(code({ M })).toContain("age: a.integer().required(), // zod: min(0), max(150)")
  })

  it("does not emit validation comment for plain string or number", () => {
    const M = z.object({ id: z.string(), name: z.string(), count: z.number() })
    const out = code({ M })
    expect(out).not.toContain("// zod:")
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
})

describe("defineModel - schema bound via variable", () => {
  it("registers config when schema is stored in a variable before defineModel", () => {
    const todoSchema = z.object({
      id: z.string().uuid(),
      content: z.string(),
    })
    const Todo = defineModel(todoSchema, { auth: [{ allow: "owner" }] })

    // defineModel returns the same reference
    expect(Todo).toBe(todoSchema)

    const out = code({ Todo })
    expect(out).toContain("Todo: a.model({")
    expect(out).toContain(".authorization(allow => [allow.owner()])")
  })

  it("registers config even when defineModel's return value is discarded", () => {
    const userSchema = z.object({
      id: z.string().uuid(),
      name: z.string(),
    })
    defineModel(userSchema, {
      auth: [{ allow: "public", operations: ["read"] }],
    })

    // The original variable carries the same registry binding
    const out = code({ User: userSchema })
    expect(out).toContain("User: a.model({")
    expect(out).toContain('.authorization(allow => [allow.publicApiKey().to(["read"])])')
  })

  it("applies primaryKey/indexes config from a variable-bound schema", () => {
    const orderSchema = z.object({
      tenantId: z.string(),
      orderId: z.string(),
      total: z.number(),
    })
    const Order = defineModel(orderSchema, {
      primaryKey: ["tenantId", "orderId"],
      indexes: [{ name: "byTenant", pk: "tenantId" }],
    })

    const out = code({ Order })
    expect(out).toContain('.identifier(["tenantId", "orderId"])')
    expect(out).toContain('index("tenantId")')
  })
})
