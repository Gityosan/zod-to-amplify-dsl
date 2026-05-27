import { describe, it, expect, beforeEach } from "vitest"
import { z } from "zod"
import { zodToAmplify } from "../converter.js"
import { defineModel, modelRegistry } from "../registry.js"

// Reset registry between tests
beforeEach(() => {
  // z.registry() instances persist; we rely on per-test schema creation
})

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

    const output = zodToAmplify({ Note })

    expect(output).toContain("id: a.id(),")
    expect(output).toContain("title: a.string().required(),")
    expect(output).toContain("views: a.integer().required(),")
    expect(output).toContain("rating: a.float().required(),")
    expect(output).toContain("published: a.boolean().required(),")
    expect(output).toContain('status: a.enum(["draft", "published"]).required(),')
  })

  it("marks optional fields without .required()", () => {
    const Article = z.object({
      id: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
    })

    const output = zodToAmplify({ Article })

    expect(output).toContain("title: a.string().required(),")
    expect(output).toContain("subtitle: a.string(),")
    expect(output).not.toContain("subtitle: a.string().required()")
  })

  it("maps string format checks", () => {
    const Contact = z.object({
      id: z.string(),
      email: z.string().email(),
      website: z.string().url(),
      createdAt: z.string().datetime(),
    })

    const output = zodToAmplify({ Contact })

    expect(output).toContain("email: a.email().required(),")
    expect(output).toContain("website: a.url().required(),")
    expect(output).toContain("createdAt: a.datetime().required(),")
  })

  it("maps FK-named string fields to a.id()", () => {
    const Comment = z.object({
      id: z.string(),
      postId: z.string(),
    })

    const output = zodToAmplify({ Comment })

    expect(output).toContain("postId: a.id().required(),")
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

    const output = zodToAmplify({ User, Post })

    expect(output).toContain('posts: a.hasMany("Post", "userId"),')
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

    const output = zodToAmplify({ User, Post })

    expect(output).toContain('author: a.belongsTo("User", "userId"),')
  })

  it("detects hasOne when no FK on this side", () => {
    const Profile = z.object({ id: z.string(), bio: z.string() })
    const User = z.object({
      id: z.string(),
      get profile() {
        return Profile
      },
    })

    const output = zodToAmplify({ User, Profile })

    expect(output).toContain('profile: a.hasOne("Profile", "userId"),')
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

    const output = zodToAmplify({ User, Post })

    // hasMany FK is resolved from Post's belongsTo FK ("authorId"), not the default "userId"
    expect(output).toContain('posts: a.hasMany("Post", "authorId"),')
    expect(output).toContain('author: a.belongsTo("User", "authorId"),')
  })
})

describe("zodToAmplify - secondary indexes from registry", () => {
  it("generates .secondaryIndexes() from defineModel config", () => {
    const Post = defineModel(
      z.object({
        id: z.string(),
        authorId: z.string(),
        createdAt: z.string().datetime(),
      }),
      {
        indexes: [{ name: "byAuthor", pk: "authorId", sk: "createdAt" }],
      }
    )

    const output = zodToAmplify({ Post })

    expect(output).toContain(
      '.secondaryIndexes(index => [index("authorId").sortKeys(["createdAt"]).name("byAuthor")])'
    )
  })

  it("generates index without sort key", () => {
    const Item = defineModel(
      z.object({ id: z.string(), category: z.string() }),
      {
        indexes: [{ name: "byCategory", pk: "category" }],
      }
    )

    const output = zodToAmplify({ Item })

    expect(output).toContain('.secondaryIndexes(index => [index("category").name("byCategory")])')
  })
})

describe("zodToAmplify - auth rules from registry", () => {
  it("generates owner auth", () => {
    const Note = defineModel(
      z.object({ id: z.string(), content: z.string() }),
      { auth: [{ allow: "owner" }] }
    )

    const output = zodToAmplify({ Note })

    expect(output).toContain(".authorization(allow => [allow.owner()])")
  })

  it("generates owner with custom ownerField", () => {
    const Post = defineModel(
      z.object({ id: z.string(), authorId: z.string() }),
      { auth: [{ allow: "owner", ownerField: "authorId" }] }
    )

    const output = zodToAmplify({ Post })

    expect(output).toContain('.authorization(allow => [allow.owner().ownerDefinedIn("authorId")])')
  })

  it("generates public auth with operations", () => {
    const Article = defineModel(
      z.object({ id: z.string(), body: z.string() }),
      { auth: [{ allow: "public", operations: ["read"] }] }
    )

    const output = zodToAmplify({ Article })

    expect(output).toContain('.authorization(allow => [allow.publicApiKey().to(["read"])])')
  })

  it("generates groups auth", () => {
    const Doc = defineModel(
      z.object({ id: z.string(), content: z.string() }),
      { auth: [{ allow: "groups", groups: ["admin", "editor"] }] }
    )

    const output = zodToAmplify({ Doc })

    expect(output).toContain('.authorization(allow => [allow.groups(["admin", "editor"])])')
  })

  it("combines multiple auth rules", () => {
    const Post = defineModel(
      z.object({ id: z.string(), body: z.string() }),
      {
        auth: [
          { allow: "owner" },
          { allow: "public", operations: ["read"] },
        ],
      }
    )

    const output = zodToAmplify({ Post })

    expect(output).toContain(
      '.authorization(allow => [allow.owner(), allow.publicApiKey().to(["read"])])'
    )
  })
})

describe("zodToAmplify - output structure", () => {
  it("generates valid import and exports", () => {
    const Todo = z.object({ id: z.string(), done: z.boolean() })
    const output = zodToAmplify({ Todo })

    expect(output).toContain('import { a } from "@aws-amplify/backend"')
    expect(output).toContain("const schema = a.schema({")
    expect(output).toContain("export { schema }")
    expect(output).toContain("export type Schema = typeof schema")
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
      {
        auth: [{ allow: "owner" }],
      }
    )

    const output = zodToAmplify({ User, Post })

    // Spot-check key fragments
    expect(output).toContain('posts: a.hasMany("Post", "authorId"),')
    expect(output).toContain('author: a.belongsTo("User", "authorId"),')
    expect(output).toContain('index("authorId").sortKeys(["createdAt"]).name("byAuthor")')
    expect(output).toContain('index("status").sortKeys(["createdAt"]).name("byStatus")')
    expect(output).toContain('.ownerDefinedIn("authorId")')
  })
})
