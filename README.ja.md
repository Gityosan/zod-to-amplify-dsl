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
| `--json` | | false | TypeScript の代わりに JSON メタデータを出力 |

### `zod-to-amplify watch`

generate と同じフラグ。入力ファイルを監視し、保存のたびに再生成します。

### `zod-to-amplify init`

カレントディレクトリに `schema.ts` と `zod-amplify.config.ts` を作成します。

| フラグ | 説明 |
|---|---|
| `--force` | 既存ファイルを上書き |

---

## 設定ファイル

プロジェクトルートに `zod-amplify.config.ts` を作成します（省略可 — CLI フラグが優先されます）。

```typescript
import { defineConfig } from "zod-to-amplify-dsl"

export default defineConfig({
  input: "src/schema.ts",
  output: "amplify/data/resource.ts",
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

CLI が行うことはすべて、通常の TS/JS 関数としても利用できます。

### `generate(options)`

フルパイプライン — スキーマファイルの読み込み・変換・oxfmt によるフォーマット・（必要なら）ディスクへの書き込み — を実行します。`zod-to-amplify` CLI がこの関数を呼んでいます。

```typescript
import { generate } from "zod-to-amplify-dsl"

// ファイルに書き込む
const result = await generate({
  inputPath: "./schema.ts",
  outputPath: "./amplify/data/resource.ts",
})
// result.writtenTo, result.warnings, result.modelNames

// dry run — フォーマット済みコードを文字列で受け取る
const { output, warnings } = await generate({
  inputPath: "./schema.ts",
  dry: true,
})

// JSON メタデータ
await generate({
  inputPath: "./schema.ts",
  outputPath: "./schema.json",
  json: true,
})
```

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `inputPath` | `string` | — | Zod モデルを export している TS ファイル（`jiti` で読み込み） |
| `outputPath` | `string` | — | `dry` が false のときは必須。`json: true` のときは `.ts` → `.json` に置換 |
| `dry` | `boolean` | `false` | ディスクに書かない。戻り値からは取得できる |
| `json` | `boolean` | `false` | TS コードの代わりに JSON メタデータ（`SchemaSummary`）を出力 |

### `convert(models)`

メモリ上の Zod モデルを、フォーマット済み Amplify Gen 2 DSL に変換します。すでにモデルオブジェクトを手元に持っている場合（テストや独自のビルドパイプライン）に便利です。

```typescript
import { z } from "zod"
import { convert, defineModel } from "zod-to-amplify-dsl"

const Todo = defineModel(
  z.object({ id: z.string().uuid(), content: z.string() }),
  { auth: [{ allow: "owner" }] },
)

const { code, warnings } = await convert({ Todo })
console.log(code)
```

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
| `z.string().datetime()` | `a.datetime()` | |
| `z.number()` | `a.float()` | |
| `z.number().int()` | `a.integer()` | |
| `z.boolean()` | `a.boolean()` | |
| `z.date()` | `a.datetime()` | |
| `z.any()` / `z.unknown()` | `a.json()` | 意図的な使用 — 警告なし |
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
  ],

  // 認可ルール → .authorization(...)
  auth: [
    { allow: "owner" },
    { allow: "owner", ownerField: "authorId" },  // カスタム所有者フィールド
    { allow: "public", operations: ["read"] },
    { allow: "groups", groups: ["admin", "editor"], operations: ["create", "update"] },
  ],
})
```

認可ルールのマッピング：

| ルール | 生成結果 |
|---|---|
| `{ allow: "owner" }` | `allow.owner()` |
| `{ allow: "owner", ownerField: "f" }` | `allow.ownerDefinedIn("f")` |
| `{ allow: "public" }` | `allow.publicApiKey()` |
| `{ allow: "public", operations: ["read"] }` | `allow.publicApiKey().to(["read"])` |
| `{ allow: "groups", groups: ["g"] }` | `allow.groups(["g"])` |

---

## バリデーションコメント

Amplify に対応する機能がない Zod のバリデーション制約は、コメントとして保持されます。

```typescript
// z.string().min(1).max(200)  →
title: a.string().required(), // zod: minLength(1), maxLength(200)

// z.number().min(0).max(100)  →
score: a.float().required(), // zod: min(0), max(100)
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
