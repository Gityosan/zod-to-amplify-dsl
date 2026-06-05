import { z } from "zod"
import { defineModel, storageField } from "../src/index.js"

export const Post: z.ZodObject<any> = defineModel(
  z.object({
    id: z.string().uuid(),
    authorId: z.string(),
    title: z.string().max(200),
    status: z.enum(["draft", "published"]),
    // S3-backed image: the model stores the key as a.string(); the file lives
    // in the bucket described by the generated amplify/storage/resource.ts.
    coverImage: storageField(z.string(), {
      path: "media/posts/*",
      access: [
        { allow: "guest", to: ["read"] },
        { allow: "owner", to: ["read", "write", "delete"] },
      ],
    }).optional(),
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

export const User: z.ZodObject<any> = defineModel(
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    get posts(): z.ZodArray<z.ZodObject<any>> {
      return z.array(Post)
    },
  }),
  {
    auth: [{ allow: "owner" }, { allow: "public", operations: ["read"] }],
  }
)
