# zod-to-amplify-dsl

Convert [Zod v4](https://zod.dev) schemas to [AWS Amplify Gen 2](https://docs.amplify.aws/gen2/) TypeScript DSL.

> [日本語版 README はこちら](./README.ja.md)

> **Target**: Amplify Gen 2 — generates code for [`@aws-amplify/data-schema`](https://www.npmjs.com/package/@aws-amplify/data-schema) **v1.x**.
> Amplify Gen 1 (GraphQL SDL / `@model` directives) is not supported.

---

## Install

```bash
npm add zod-to-amplify-dsl
# or
pnpm add zod-to-amplify-dsl
```

---

## Quick start

```bash
npx zod-to-amplify init   # create starter schema.ts + zod-amplify.config.ts
npx zod-to-amplify --dry  # preview generated output
npx zod-to-amplify        # write to amplify/data/resource.ts
```

---

## CLI

```
zod-to-amplify [options]
zod-to-amplify watch [options]
zod-to-amplify init [--force]
```

### `zod-to-amplify` (generate)

| Flag | Alias | Default | Description |
|---|---|---|---|
| `--input <file>` | `-i` | `schema.ts` | TypeScript file exporting Zod models |
| `--output <file>` | `-o` | `amplify/data/resource.ts` | Output file path |
| `--dry` | | false | Print output to stdout without writing |
| `--json` | | false | Output JSON schema metadata instead of TypeScript |

### `zod-to-amplify watch`

Same flags as generate. Watches the input file and regenerates on every save.

### `zod-to-amplify init`

Creates `schema.ts` and `zod-amplify.config.ts` in the current directory.

| Flag | Description |
|---|---|
| `--force` | Overwrite existing files |

---

## Config file

Create `zod-amplify.config.ts` in your project root (optional — CLI flags take precedence):

```typescript
import { defineConfig } from "zod-to-amplify-dsl"

export default defineConfig({
  input: "src/schema.ts",
  output: "amplify/data/resource.ts",
  // storageOutput: "amplify/storage/resource.ts", // default: sibling of `output`
  // storageName: "media",                         // defineStorage({ name })
})
```

---

## Schema file

Export Zod models from the input file. Use **getter syntax** to define circular/forward references between models.

```typescript
// schema.ts
import { z } from "zod"
import { defineModel } from "zod-to-amplify-dsl"

export const Post = defineModel(
  z.object({
    id: z.string().uuid(),
    title: z.string().max(200),
    status: z.enum(["DRAFT", "PUBLISHED"]),
    authorId: z.string(),
    createdAt: z.string().datetime(),

    // Relations: use getter to avoid circular reference issues
    get author(): z.ZodObject<any> { return User },
    get comments(): z.ZodArray<z.ZodObject<any>> { return z.array(Comment) },
    get tags(): z.ZodArray<z.ZodObject<any>> { return z.array(Tag) },
  }),
  {
    indexes: [{ name: "byAuthor", pk: "authorId", sk: "createdAt" }],
    auth: [
      { allow: "owner", ownerField: "authorId" },
      { allow: "public", operations: ["read"] },
    ],
  }
)

export const User = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  get posts(): z.ZodArray<z.ZodObject<any>> { return z.array(Post) },
})

export const Comment = z.object({
  id: z.string(),
  body: z.string(),
  postId: z.string(),
  get post(): z.ZodObject<any> { return Post },
})

// Mutual array references → junction model (PostTag) is auto-generated
export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  get posts(): z.ZodArray<z.ZodObject<any>> { return z.array(Post) },
})
```

> `z.lazy(() => Model)` also works as an alternative to getter syntax.

---

## Programmatic API

### `zodToAmplify(models)`

Returns `{ code: string, warnings: ConversionWarning[] }`.

```typescript
import { z } from "zod"
import { zodToAmplify } from "zod-to-amplify-dsl"

const Post = z.object({ id: z.string(), title: z.string() })
const { code, warnings } = zodToAmplify({ Post })

if (warnings.length > 0) {
  console.warn("Unsupported types:", warnings)
}
console.log(code)
```

### `zodToAmplifyMeta(models)`

Returns a JSON-serializable `SchemaSummary` — useful for tooling or validation.

```typescript
import { zodToAmplifyMeta } from "zod-to-amplify-dsl"

const meta = zodToAmplifyMeta({ Post, User })
// meta.models[].fields, .relations, .primaryKey, .indexes, .auth
// meta.customTypes[].fields
// meta.warnings
// meta.storage  → [{ path, access }]
```

---

## Storage (S3) fields

Amplify Gen 2 has no native file/image data type — files live in S3 and the data
model only stores the **S3 key**. Wrap a string field with `storageField()` to
mark it: the field becomes `a.string()` in `data/resource.ts`, and a separate
`amplify/storage/resource.ts` is generated with a matching `defineStorage`.

```typescript
import { z } from "zod"
import { storageField } from "zod-to-amplify-dsl"

export const Post = z.object({
  id: z.string().uuid(),
  coverImage: storageField(z.string(), {
    path: "media/posts/*",
    access: [
      { allow: "guest", to: ["read"] },
      { allow: "owner", to: ["read", "write", "delete"] },
    ],
  }).optional(),
})
```

Generated `data/resource.ts` (excerpt):

```typescript
Post: a.model({
  id: a.id(),
  coverImage: a.string(), // zod: storage(path="media/posts/*")
})
```

Generated `amplify/storage/resource.ts`:

```typescript
import { defineStorage } from "@aws-amplify/backend"

export const storage = defineStorage({
  name: "media",
  access: (allow) => ({
    "media/posts/*": [
      allow.guest.to(["read"]),
      allow.entity("identity").to(["read", "write", "delete"]),
    ],
  }),
})
```

**Notes**

- `access` is optional. When omitted it defaults to a secure
  `allow.authenticated.to(["read", "write", "delete"])` (no guest access).
- Fields sharing the same `path` have their access rules merged and de-duplicated.
- Allow kinds map as: `guest` → `allow.guest`, `authenticated` →
  `allow.authenticated`, `owner` → `allow.entity("identity")`, `groups` →
  `allow.groups([...])`.
- Output location: a `data/resource.ts` output emits `storage/resource.ts`
  alongside it; override with `storageOutput` (and the bucket name with
  `storageName`) in the config file. The CLI writes the storage file only when at
  least one `storageField()` is present.

---

## Type mapping

### Scalars

| Zod | Amplify | Notes |
|---|---|---|
| `z.string()` | `a.string()` | |
| `z.string().uuid()` | `a.id()` | also any field named `*Id` |
| `z.string().email()` | `a.email()` | |
| `z.string().url()` | `a.url()` | |
| `z.string().e164()` | `a.phone()` | E.164 phone number |
| `z.string().ipv4()` / `.ipv6()` | `a.ipAddress()` | |
| `z.iso.datetime()` / `z.string().datetime()` | `a.datetime()` | |
| `z.iso.date()` / `z.string().date()` | `a.date()` | date only |
| `z.iso.time()` / `z.string().time()` | `a.time()` | time only |
| `z.number()` | `a.float()` | |
| `z.number().int()` | `a.integer()` | |
| `z.boolean()` | `a.boolean()` | |
| `z.date()` | `a.datetime()` | |
| `z.any()` / `z.unknown()` | `a.json()` | intentional — no warning |
| other | `a.json()` | with warning |

### Enums (hoisted to schema level)

Amplify's `a.enum()` cannot be used inline in model fields. All enum types are hoisted to the schema level and referenced via `a.ref()`.

| Zod | Generated field | Schema-level entry |
|---|---|---|
| `z.enum(["A", "B"])` | `field: a.ref("Field").required()` | `Field: a.enum(["A", "B"])` |
| `z.literal("active")` | `status: a.ref("Status").required()` | `Status: a.enum(["active"])` |
| `z.union([z.literal("A"), z.literal("B")])` | `kind: a.ref("Kind").required()` | `Kind: a.enum(["A", "B"])` |

Enums with `.default()` emit a comment instead of the unsupported chain:

```typescript
// Zod: status: z.enum(["draft", "published"]).default("draft")
// Generated:
status: a.ref("Status"), // zod: default("draft")
```

### Optional / default

| Zod | Amplify |
|---|---|
| `z.string().optional()` | `a.string()` (no `.required()`) |
| `z.string().default("x")` | `a.string().default("x")` |
| `z.string().nullable()` | `a.string()` (nullable treated as optional) |

### Scalar arrays

| Zod | Amplify |
|---|---|
| `z.array(z.string())` | `a.string().array().required()` |
| `z.array(z.number().int())` | `a.integer().array().required()` |
| `z.array(z.enum([...]))` | `a.ref("Name").array().required()` |

### Nested objects (customType)

Non-model `z.object()` fields are emitted as `a.customType()`:

```typescript
const Address = z.object({ street: z.string(), city: z.string() })
const User = z.object({ id: z.string(), address: Address })
```

Generated:
```typescript
User: a.model({
  id: a.id(),
  address: a.ref("Address").required(),
}),
Address: a.customType({
  street: a.string().required(),
  city: a.string().required(),
}),
```

### Relations

| Pattern | Amplify |
|---|---|
| `get posts() { return z.array(Post) }` | `a.hasMany("Post", "userId")` |
| `get author() { return User }` + FK field `userId` | `a.belongsTo("User", "userId")` |
| `get profile() { return Profile }` (no FK on this side) | `a.hasOne("Profile", "userId")` |
| Mutual `z.array()` on both sides | `a.hasMany("AJunctionModel", "fkId")` + auto junction model |

**manyToMany** — Amplify Gen 2 has no `a.manyToMany()`. When both models have `z.array()` pointing at each other, a junction model is automatically generated:

```typescript
// Input: Post.tags ↔ Tag.posts
// Generated:
Post: a.model({ tags: a.hasMany("PostTag", "postId"), ... }),
Tag:  a.model({ posts: a.hasMany("PostTag", "tagId"), ... }),
PostTag: a.model({
  postId: a.id().required(),
  tagId: a.id().required(),
  post: a.belongsTo("Post", "postId"),
  tag: a.belongsTo("Tag", "tagId"),
}),
```

---

## `defineModel` options

```typescript
defineModel(zodSchema, {
  // Composite primary key → .identifier([...])
  primaryKey: ["tenantId", "orderId"],

  // Secondary indexes → .secondaryIndexes(...)
  indexes: [
    { name: "byAuthor", pk: "authorId" },
    { name: "byAuthorDate", pk: "authorId", sk: "createdAt" },
  ],

  // Authorization rules → .authorization(...)
  auth: [
    { allow: "owner" },
    { allow: "owner", ownerField: "authorId" },   // custom owner field
    { allow: "public", operations: ["read"] },
    { allow: "groups", groups: ["admin", "editor"], operations: ["create", "update"] },
  ],
})
```

Auth mapping:

| Rule | Generated |
|---|---|
| `{ allow: "owner" }` | `allow.owner()` |
| `{ allow: "owner", ownerField: "f" }` | `allow.ownerDefinedIn("f")` |
| `{ allow: "multipleOwners", ownersField: "f" }` | `allow.ownersDefinedIn("f")` |
| `{ allow: "public" }` | `allow.publicApiKey()` |
| `{ allow: "public", operations: ["read"] }` | `allow.publicApiKey().to(["read"])` |
| `{ allow: "guest" }` | `allow.guest()` |
| `{ allow: "authenticated" }` | `allow.authenticated()` |
| `{ allow: "group", group: "g" }` | `allow.group("g")` |
| `{ allow: "groups", groups: ["g"] }` | `allow.groups(["g"])` |
| `{ allow: "custom" }` | `allow.custom()` (Lambda authorizer) |

All rules accept `operations` (mapped to `.to([...])`). Owner/group rules accept an
optional `provider` (`"userPools"` | `"oidc"`); `authenticated` also accepts
`"identityPool"`. Example: `{ allow: "authenticated", provider: "oidc", operations: ["read"] }`
→ `allow.authenticated("oidc").to(["read"])`.

---

## Field validation

Zod constraints on `string` / `integer` / `float` fields are emitted as Amplify
[field-level `.validate()`](https://docs.amplify.aws/react/build-a-backend/data/field-level-validation/)
chains:

```typescript
// z.string().min(1).max(200)  →
title: a.string().validate((v) => v.minLength(1).maxLength(200)).required(),

// z.string().regex(/^[a-z-]+$/)  →
slug: a.string().validate((v) => v.matches("^[a-z-]+$")).required(),

// z.number().min(0).max(100)  → inclusive bounds use gte/lte
score: a.float().validate((v) => v.gte(0).lte(100)).required(),

// z.number().gt(0).lt(1)  → exclusive bounds use gt/lt
ratio: a.float().validate((v) => v.gt(0).lt(1)).required(),
```

Mapping: `min`/`max` (string) → `minLength`/`maxLength`, `regex` → `matches`,
`startsWith`/`endsWith` → same; `min`/`max` (number) → `gte`/`lte`, `gt`/`lt` → `gt`/`lt`.

Amplify only allows `.validate()` on `a.string()`, `a.integer()`, and `a.float()`.
For other types (e.g. `a.email()` with a length constraint) the constraints are
preserved as an inline comment instead:

```typescript
email: a.email().required(), // zod: maxLength(50)
```

---

## Auto-managed fields

`createdAt` and `updatedAt` are managed by Amplify. They are emitted without `.required()` regardless of the Zod schema:

```typescript
createdAt: a.datetime(),
updatedAt: a.datetime(),
```

---

## License

MIT
