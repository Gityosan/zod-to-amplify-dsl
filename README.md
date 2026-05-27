# zod-to-amplify-dsl

Convert [Zod v4](https://zod.dev) schemas to [AWS Amplify Gen 2](https://docs.amplify.aws/gen2/) TypeScript DSL.

## Install

```bash
pnpm add zod-to-amplify-dsl
```

## Usage

### CLI

```bash
# Generate from schema.ts → amplify/data/resource.ts (defaults)
npx zod-to-amplify

# Specify paths
npx zod-to-amplify -i src/schema.ts -o amplify/data/resource.ts

# Preview without writing
npx zod-to-amplify --dry

# Watch mode
npx zod-to-amplify watch -i src/schema.ts
```

### Config file

Create `zod-amplify.config.ts` in your project root:

```typescript
import { defineConfig } from "zod-to-amplify-dsl"

export default defineConfig({
  input: "src/schema.ts",
  output: "amplify/data/resource.ts",
})
```

### Schema file

```typescript
// src/schema.ts
import { z } from "zod"
import { defineModel } from "zod-to-amplify-dsl"

export const Post = defineModel(
  z.object({
    id: z.string(),
    title: z.string(),
    content: z.string().optional(),
    status: z.enum(["DRAFT", "PUBLISHED"]),
    author: z.lazy(() => User),
    comments: z.array(z.lazy(() => Comment)),
  }),
  {
    auth: [{ allow: "owner" }, { allow: "public", operations: ["read"] }],
    indexes: [{ name: "byStatus", pk: "status" }],
  }
)

export const User = z.object({
  id: z.string(),
  email: z.string().email(),
  posts: z.array(z.lazy(() => Post)),
})

export const Comment = z.object({
  id: z.string(),
  body: z.string(),
  postId: z.string(),
  post: z.lazy(() => Post),
})
```

### Programmatic API

```typescript
import { zodToAmplify } from "zod-to-amplify-dsl"
import { z } from "zod"

const Post = z.object({ id: z.string(), title: z.string() })
const { code, warnings } = zodToAmplify({ Post })
```

## Supported Zod types

| Zod type | Amplify type |
|---|---|
| `z.string()` | `a.string()` |
| `z.string().email()` | `a.email()` |
| `z.string().url()` | `a.url()` |
| `z.string().ip()` | `a.ipAddress()` |
| `z.string().datetime()` | `a.datetime()` |
| `z.number()` | `a.float()` |
| `z.number().int()` | `a.integer()` |
| `z.boolean()` | `a.boolean()` |
| `z.date()` | `a.date()` |
| `z.enum([...])` | `a.enum([...])` |
| `z.array(Model)` | `a.hasMany()` / `a.manyToMany()` |
| `z.lazy(() => Model)` | `a.hasOne()` / `a.belongsTo()` |
| other | `a.json()` (with warning) |

Auto-managed fields (`createdAt`, `updatedAt`) are emitted without `.required()`.

## `defineModel` options

```typescript
defineModel(schema, {
  primaryKey: ["tenantId", "id"],          // composite PK → .identifier([...])
  indexes: [{ name: "byEmail", pk: "email", sk: "createdAt" }],
  auth: [
    { allow: "owner", ownerField: "userId" },
    { allow: "public", operations: ["read"] },
    { allow: "groups", groups: ["admin"], operations: ["create", "update", "delete"] },
  ],
})
```

## License

MIT
