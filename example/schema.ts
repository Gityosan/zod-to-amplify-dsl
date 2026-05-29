// A small blog domain: User → Post → Comment, plus tag enums.
// Demonstrates the everyday surface area: relations, defineModel options,
// optional/default fields, scalar enum arrays, and validation hints.

import { z } from "zod"
import { defineModel } from "../src/index.js"

export const Post: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    authorId: z.string(),
    title: z.string().min(1).max(200),
    body: z.string(),
    status: z.enum(["draft", "published", "archived"]).default("draft"),
    tags: z.array(z.enum(["tech", "life", "news"])),
    views: z.number().int().default(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),

    // belongsTo — author resolves via authorId
    get author(): z.ZodObject<any> {
      return User
    },
    // hasMany — Comment.postId is inferred as the FK
    get comments(): z.ZodArray<z.ZodObject<any>> {
      return z.array(Comment)
    },
  }),
  {
    indexes: [
      { name: "byAuthor", pk: "authorId", sk: "createdAt" },
      { name: "byStatus", pk: "status", sk: "createdAt" },
    ],
    auth: [
      { allow: "owner", ownerField: "authorId" },
      { allow: "public", operations: ["read"] },
    ],
  }
)

export const User: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    name: z.string().min(1),
    email: z.email(),
    bio: z.string().optional(),
    role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
    get posts(): z.ZodArray<z.ZodObject<any>> {
      return z.array(Post)
    },
  }),
  {
    auth: [
      { allow: "owner" },
      { allow: "public", operations: ["read"] },
    ],
  }
)

export const Comment: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    postId: z.string(),
    authorId: z.string(),
    body: z.string().min(1).max(1000),
    createdAt: z.iso.datetime(),
    // belongsTo via postId
    get post(): z.ZodObject<any> {
      return Post
    },
    // belongsTo via authorId
    get author(): z.ZodObject<any> {
      return User
    },
  }),
  {
    indexes: [{ name: "byPost", pk: "postId", sk: "createdAt" }],
    auth: [
      { allow: "owner", ownerField: "authorId" },
      { allow: "public", operations: ["read"] },
    ],
  }
)
