export interface ZodAmplifyConfig {
  input?: string
  output?: string
  /** Where to write the generated defineStorage file. Defaults to a sibling
   *  "storage/resource.ts" next to the data output, or "<dir>/storage.resource.ts". */
  storageOutput?: string
  /** name passed to defineStorage({ name }). Defaults to "media". */
  storageName?: string
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
  primaryKey?: (keyof T & string)[]
  indexes?: IndexDef<T>[]
  auth?: AuthRule[]
}

// ---- storage (S3) field config ----

/** Actions accepted by Amplify Gen 2 storage access rules (allow.*.to([...])). */
export type StorageAction = "read" | "get" | "list" | "write" | "delete"

export type StorageAccessRule =
  | { allow: "guest"; to: StorageAction[] }
  | { allow: "authenticated"; to: StorageAction[] }
  | { allow: "owner"; to: StorageAction[] }
  | { allow: "groups"; groups: string[]; to: StorageAction[] }

/** Marks a Zod string field as an S3 key managed by Amplify Storage.
 *  The data model keeps the S3 key as a.string(); the file itself lives in
 *  the bucket described by the generated defineStorage. */
export interface StorageFieldConfig {
  /** S3 path/prefix this field's objects live under, e.g. "media/posts/*". */
  path: string
  /** Access rules for {@link path}. Defaults to authenticated read/write/delete. */
  access?: StorageAccessRule[]
}

/** One resolved S3 path with its merged access rules (grouped across fields). */
export interface StoragePathSummary {
  path: string
  access: StorageAccessRule[]
}

export interface ConversionWarning {
  model: string
  field: string
  zodType: string
}

export interface ConversionResult {
  code: string
  warnings: ConversionWarning[]
  /** Generated defineStorage file content, or undefined when no field uses storageField(). */
  storage?: string
}

// ---- JSON metadata types (zodToAmplifyMeta) ----

export interface FieldMeta {
  amplifyType: string
  required: boolean
  default?: unknown
  array: boolean
  validationHint?: string
  /** Set when the field is a storageField(); holds its S3 path. */
  storagePath?: string
}

export interface RelationFieldMeta {
  kind: "hasMany" | "belongsTo" | "hasOne" | "manyToMany"
  target: string
  fk?: string
  relationName?: string
}

export interface ModelSummary {
  name: string
  fields: Record<string, FieldMeta>
  relations: Record<string, RelationFieldMeta>
  primaryKey?: string[]
  indexes?: IndexDef[]
  auth?: AuthRule[]
}

export interface CustomTypeSummary {
  name: string
  fields: Record<string, FieldMeta>
}

export interface SchemaSummary {
  models: ModelSummary[]
  customTypes: CustomTypeSummary[]
  warnings: ConversionWarning[]
  /** S3 paths collected from storageField() usage, grouped and merged. */
  storage: StoragePathSummary[]
}
