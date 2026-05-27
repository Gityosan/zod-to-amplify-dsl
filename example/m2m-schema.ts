import { z } from "zod"

export const Tag: z.ZodObject<any> = z.object({
  id: z.string(),
  name: z.string(),
  get posts(): z.ZodArray<z.ZodObject<any>> {
    return z.array(Post)
  },
})

export const Post: z.ZodObject<any> = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["draft", "published"]).default("draft"),
  get tags(): z.ZodArray<z.ZodObject<any>> {
    return z.array(Tag)
  },
})
