# zod-to-amplify-dsl

[Zod v4](https://zod.dev) スキーマを [AWS Amplify Gen 2](https://docs.amplify.aws/gen2/) TypeScript DSL に変換するツールです。

> [English README](./README.md)

> **対象バージョン**: Amplify Gen 2 — [`@aws-amplify/data-schema`](https://www.npmjs.com/package/@aws-amplify/data-schema) **v1.x** 向けのコードを生成します。
> Amplify Gen 1（GraphQL SDL / `@model` ディレクティブ）には対応していません。

---

## インストール

```bash
npm add zod-to-amplify-dsl
# または
pnpm add zod-to-amplify-dsl
```

---

## クイックスタート

```bash
npx zod-to-amplify init   # schema.ts と zod-amplify.config.ts を生成
npx zod-to-amplify --dry  # 変換結果をプレビュー（ファイルに書かない）
npx zod-to-amplify        # amplify/data/resource.ts に出力
```

---

## CLI

```
zod-to-amplify [options]
zod-to-amplify watch [options]
zod-to-amplify init [--force]
```

### `zod-to-amplify`（生成）

| フラグ | 短縮 | デフォルト | 説明 |
|---|---|---|---|
| `--input <file>` | `-i` | `schema.ts` | Zod モデルをエクスポートする TypeScript ファイル |
| `--output <file>` | `-o` | `amplify/data/resource.ts` | 出力先ファイル |
| `--dry` | | false | ファイルに書かずに stdout へ出力 |
| `--check` | | false | 出力がディスク上のファイルと一致するか検証し、差分があれば exit 1（CI 向け） |
| `--json` | | false | TypeScript の代わりに JSON メタデータを出力 |

> `--check` はメモリ上で再生成し、コミット済みファイル（生成される storage ファイルを含む）
> と比較します。ファイルは書き込まず、欠落や陳腐化があれば非ゼロ終了します。スキーマ編集後に
> 再生成し忘れていないかを CI でガードするのに便利です。

### `zod-to-amplify watch`

generate と同じフラグ。入力ファイルを監視し、保存のたびに再生成します。

### `zod-to-amplify init`

カレントディレクトリに `schema.ts` と `zod-amplify.config.ts` を作成します。

| フラグ | 説明 |
|---|---|
| `--force` | 既存ファイルを上書き |

### `zod-to-amplify mcp`

stdio 経由で [MCP](https://modelcontextprotocol.io) サーバを起動し、AI エージェントが
コンバータをツールとして実行できるようにします。MCP クライアントには `npx` で登録します。

```jsonc
{
  "mcpServers": {
    "zod-to-amplify": {
      "command": "npx",
      "args": ["-y", "zod-to-amplify-dsl", "mcp"]
    }
  }
}
```

公開するツール(読み取り専用 — ファイルは書き込みません):

| ツール | 入力 | 返り値 |
|---|---|---|
| `usage` | _(なし)_ | スキーマファイルの書き方とツールの使い方ガイド |
| `convert_schema` | `{ schemaPath }` | 生成された Amplify DSL（storage コード・警告をコメントとして付加） |
| `schema_summary` | `{ schemaPath }` | JSON サマリ（`zodToAmplifyMeta`） |

`schemaPath` は Zod モデルをエクスポートする `.ts` ファイルで、サーバの作業ディレクトリ
基準で解決されます。

---

## 設定ファイル

プロジェクトルートに `zod-amplify.config.ts` を作成します（省略可 — CLI フラグが優先されます）。

```typescript
import { defineConfig } from "zod-to-amplify-dsl"

export default defineConfig({
  input: "src/schema.ts",
  output: "amplify/data/resource.ts",
  // storageOutput: "amplify/storage/resource.ts", // 既定: `output` の隣に生成
  // storageName: "media",                         // defineStorage({ name })
})
```

---

## スキーマファイル

入力ファイルから Zod モデルをエクスポートします。モデル間の循環参照・前方参照には**ゲッター構文**を使います。

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

    // リレーション：循環参照を避けるためゲッター構文を使う
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

// 双方向の z.array() → 中間テーブル（PostTag）が自動生成される
export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  get posts(): z.ZodArray<z.ZodObject<any>> { return z.array(Post) },
})
```

> `z.lazy(() => Model)` もゲッター構文の代わりに使えます。

---

## プログラマティック API

### `zodToAmplify(models)`

`{ code: string, warnings: ConversionWarning[] }` を返します。

```typescript
import { z } from "zod"
import { zodToAmplify } from "zod-to-amplify-dsl"

const Post = z.object({ id: z.string(), title: z.string() })
const { code, warnings } = zodToAmplify({ Post })

if (warnings.length > 0) {
  console.warn("非対応の型:", warnings)
}
console.log(code)
```

### `zodToAmplifyMeta(models)`

JSON シリアライズ可能な `SchemaSummary` を返します。ツール連携や検証に便利です。

```typescript
import { zodToAmplifyMeta } from "zod-to-amplify-dsl"

const meta = zodToAmplifyMeta({ Post, User })
// meta.models[].fields, .relations, .primaryKey, .indexes, .auth
// meta.customTypes[].fields
// meta.warnings
// meta.storage  → [{ path, access }]
```

---

## ストレージ（S3）フィールド

Amplify Gen 2 にはファイル/画像のネイティブなデータ型がありません。ファイル本体は
S3 に保存し、データモデルには **S3 キー** だけを持たせます。文字列フィールドを
`storageField()` でラップすると、そのフィールドは `data/resource.ts` 内では
`a.string()` になり、対応する `defineStorage` を含む `amplify/storage/resource.ts`
が別ファイルとして生成されます。

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

生成される `data/resource.ts`（抜粋）:

```typescript
Post: a.model({
  id: a.id(),
  coverImage: a.string(), // zod: storage(path="media/posts/*")
})
```

生成される `amplify/storage/resource.ts`:

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

**補足**

- `access` は省略可能です。省略時は安全側の既定値
  `allow.authenticated.to(["read", "write", "delete"])`（guest アクセスなし）になります。
- 同じ `path` を共有するフィールドのアクセスルールはマージ・重複排除されます。
- allow の種類は次のように対応します: `guest` → `allow.guest`、`authenticated` →
  `allow.authenticated`、`owner` → `allow.entity("identity")`、`groups` →
  `allow.groups([...])`。
- 出力先: `data/resource.ts` を出力する場合はその隣に `storage/resource.ts` を生成します。
  設定ファイルの `storageOutput`（バケット名は `storageName`）で上書きできます。
  `storageField()` が1つも無い場合、ストレージファイルは生成されません。

---

## 型マッピング

### スカラー型

| Zod | Amplify | 備考 |
|---|---|---|
| `z.string()` | `a.string()` | |
| `z.string().uuid()` | `a.id()` | フィールド名が `*Id` の場合も同様 |
| `z.string().email()` | `a.email()` | |
| `z.string().url()` | `a.url()` | |
| `z.string().e164()` | `a.phone()` | E.164 電話番号 |
| `z.string().ipv4()` / `.ipv6()` | `a.ipAddress()` | |
| `z.iso.datetime()` / `z.string().datetime()` | `a.datetime()` | |
| `z.iso.date()` / `z.string().date()` | `a.date()` | 日付のみ |
| `z.iso.time()` / `z.string().time()` | `a.time()` | 時刻のみ |
| `z.number()` | `a.float()` | |
| `z.number().int()` | `a.integer()` | |
| `z.boolean()` | `a.boolean()` | |
| `z.date()` | `a.datetime()` | |
| `z.any()` / `z.unknown()` | `a.json()` | 意図的な使用 — 警告なし |
| `z.record()` / `z.tuple()` | `a.json()` | 意図的な使用 — 警告なし |
| `z.map()` / `z.set()` / `z.bigint()` | `a.json()` | 警告あり（忠実に表現できない） |
| その他 | `a.json()` | 警告あり |

### 列挙型（スキーマレベルにホイスト）

Amplify の `a.enum()` はモデルフィールドに直接使えません。すべての列挙型はスキーマレベルに自動的にホイストされ、`a.ref()` で参照されます。

| Zod | 生成されるフィールド | スキーマレベルのエントリ |
|---|---|---|
| `z.enum(["A", "B"])` | `field: a.ref("Field").required()` | `Field: a.enum(["A", "B"])` |
| `z.literal("active")` | `status: a.ref("Status").required()` | `Status: a.enum(["active"])` |
| `z.union([z.literal("A"), z.literal("B")])` | `kind: a.ref("Kind").required()` | `Kind: a.enum(["A", "B"])` |

`.default()` 付きの列挙型は、非対応のチェーンの代わりにコメントを出力します。

```typescript
// Zod: status: z.enum(["draft", "published"]).default("draft")
// 生成結果:
status: a.ref("Status"), // zod: default("draft")
```

### オプション・デフォルト

| Zod | Amplify |
|---|---|
| `z.string().optional()` | `a.string()`（`.required()` なし） |
| `z.string().default("x")` | `a.string().default("x")` |
| `z.string().nullable()` | `a.string()`（optional として扱う） |

### スカラー配列

| Zod | Amplify |
|---|---|
| `z.array(z.string())` | `a.string().array().required()` |
| `z.array(z.number().int())` | `a.integer().array().required()` |
| `z.array(z.enum([...]))` | `a.ref("Name").array().required()` |

### ネストしたオブジェクト（customType）

モデル以外の `z.object()` フィールドは `a.customType()` として生成されます。

```typescript
const Address = z.object({ street: z.string(), city: z.string() })
const User = z.object({ id: z.string(), address: Address })
```

生成結果：
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

### リレーション

| パターン | Amplify |
|---|---|
| `get posts() { return z.array(Post) }` | `a.hasMany("Post", "userId")` |
| `get author() { return User }` + FK フィールド `userId` | `a.belongsTo("User", "userId")` |
| `get profile() { return Profile }`（この側に FK なし） | `a.hasOne("Profile", "userId")` |
| 双方向の `z.array()` | `a.hasMany("中間テーブル", "fkId")` + 中間テーブル自動生成 |

**manyToMany** — Amplify Gen 2 には `a.manyToMany()` が存在しません。両モデルが互いに `z.array()` で参照し合う場合、中間テーブルが自動生成されます。

```typescript
// 入力: Post.tags ↔ Tag.posts
// 生成結果:
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

## `defineModel` オプション

```typescript
defineModel(zodSchema, {
  // 複合プライマリキー → .identifier([...])
  primaryKey: ["tenantId", "orderId"],

  // セカンダリインデックス → .secondaryIndexes(...)
  indexes: [
    { name: "byAuthor", pk: "authorId" },
    { name: "byAuthorDate", pk: "authorId", sk: "createdAt" },
    // queryField → カスタムリストクエリ: .queryField("listByAuthor")
    { name: "byAuthor2", pk: "authorId", queryField: "listByAuthor" },
  ],

  // 認可ルール → .authorization(...)
  auth: [
    { allow: "owner" },
    { allow: "owner", ownerField: "authorId" },  // カスタム所有者フィールド
    { allow: "public", operations: ["read"] },
    { allow: "groups", groups: ["admin", "editor"], operations: ["create", "update"] },
  ],

  // フィールド単位の認可 → field.authorization(allow => [...])
  fieldAuth: {
    ssn: [{ allow: "owner" }],
  },

  // 生成オペレーションの無効化 → .disableOperations([...])
  disabledOperations: ["delete", "subscriptions"],
})
```

`disabledOperations` が受け付ける値: `queries`, `mutations`, `subscriptions`, `list`,
`get`, `create`, `update`, `delete`, `onCreate`, `onUpdate`, `onDelete`。

認可ルールのマッピング：

| ルール | 生成結果 |
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
| `{ allow: "custom" }` | `allow.custom()`（Lambda 認可） |

すべてのルールは `operations`（`.to([...])` にマップ）を受け付けます。owner/group 系は
任意の `provider`（`"userPools"` | `"oidc"`）を、`authenticated` は加えて `"identityPool"`
を受け付けます。例: `{ allow: "authenticated", provider: "oidc", operations: ["read"] }`
→ `allow.authenticated("oidc").to(["read"])`。

---

## フィールドバリデーション

`string` / `integer` / `float` フィールドの Zod 制約は、Amplify の
[フィールドレベル `.validate()`](https://docs.amplify.aws/react/build-a-backend/data/field-level-validation/)
チェーンとして生成されます。

```typescript
// z.string().min(1).max(200)  →
title: a.string().validate((v) => v.minLength(1).maxLength(200)).required(),

// z.string().regex(/^[a-z-]+$/)  →
slug: a.string().validate((v) => v.matches("^[a-z-]+$")).required(),

// z.number().min(0).max(100)  → 以上/以下は gte/lte
score: a.float().validate((v) => v.gte(0).lte(100)).required(),

// z.number().gt(0).lt(1)  → 超過/未満は gt/lt
ratio: a.float().validate((v) => v.gt(0).lt(1)).required(),
```

マッピング: `min`/`max`（文字列）→ `minLength`/`maxLength`、`regex` → `matches`、
`startsWith`/`endsWith` → 同名、`min`/`max`（数値）→ `gte`/`lte`、`gt`/`lt` → `gt`/`lt`。

Amplify の `.validate()` は `a.string()` / `a.integer()` / `a.float()` のみ対応です。
それ以外の型（例: 長さ制約付きの `a.email()`）では、制約はインラインコメントとして保持されます。

```typescript
email: a.email().required(), // zod: maxLength(50)
```

---

## 自動管理フィールド

`createdAt` と `updatedAt` は Amplify が自動管理します。Zod スキーマの定義に関わらず `.required()` なしで生成されます。

```typescript
createdAt: a.datetime(),
updatedAt: a.datetime(),
```

---

## ライセンス

MIT
