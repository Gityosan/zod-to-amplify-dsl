import type { z } from "zod"

export type ScalarFieldKey<T extends z.ZodRawShape> = {
  [K in keyof T]: ReturnType<T[K]["_def"]["typeName"] extends never ? never : () => z.ZodTypeAny> extends z.ZodObject<any>
    ? never
    : K
}[keyof T] & string

export type IndexDef<T extends z.ZodRawShape = z.ZodRawShape> = {
  name: string
  pk: keyof T & string
  sk?: keyof T & string
}

export type Operation = "read" | "create" | "update" | "delete"

export type AuthRule =
  | { allow: "owner"; ownerField?: string }
  | { allow: "public"; operations?: Operation[] }
  | { allow: "groups"; groups: string[]; operations?: Operation[] }

export type ModelConfig<T extends z.ZodRawShape = z.ZodRawShape> = {
  indexes?: IndexDef<T>[]
  auth?: AuthRule[]
}
