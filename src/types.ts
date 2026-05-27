export interface ZodAmplifyConfig {
  input?: string
  output?: string
}

export function defineConfig(config: ZodAmplifyConfig): ZodAmplifyConfig {
  return config
}

export type IndexDef<T extends Record<string, unknown> = Record<string, unknown>> = {
  name: string
  pk: keyof T & string
  sk?: keyof T & string
}

export type Operation = "read" | "create" | "update" | "delete"

export type AuthRule =
  | { allow: "owner"; ownerField?: string }
  | { allow: "public"; operations?: Operation[] }
  | { allow: "groups"; groups: string[]; operations?: Operation[] }

export type ModelConfig<T extends Record<string, unknown> = Record<string, unknown>> = {
  indexes?: IndexDef<T>[]
  auth?: AuthRule[]
}
