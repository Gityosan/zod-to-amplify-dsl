# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **More authorization rules** — `defineModel` `auth` now supports
  `authenticated`, `guest`, `group` (single), `multipleOwners`
  (`ownersDefinedIn`), and `custom` (Lambda authorizer), in addition to the
  existing `owner`/`public`/`groups`. Owner/group rules accept an optional
  `provider` (`userPools`/`oidc`), `authenticated` also accepts `identityPool`,
  and every rule accepts `operations` (`.to([...])`). `Operation` widened to the
  full AppSync set (`create`/`read`/`update`/`delete`/`get`/`list`/`sync`/`listen`/`search`).
- **Date/time scalars** — `z.iso.date()` / `z.string().date()` → `a.date()`,
  `z.iso.time()` / `z.string().time()` → `a.time()`, and `z.iso.datetime()` now
  maps to `a.datetime()` (alongside the existing `z.string().datetime()`).
- **CLI `--check`** — regenerate in memory and compare against the committed
  output (including the generated storage file); writes nothing and exits 1 when
  any file is missing or stale. Useful as a CI guard.
- **Secondary index `queryField`** — `IndexDef` accepts `queryField` →
  `.queryField("...")`.
- **Field-level authorization** — `defineModel` `fieldAuth` maps per-field auth
  rules to `field.authorization(allow => [...])` (reuses the model auth rule shapes).
- **`disableOperations`** — `defineModel` `disabledOperations` →
  `.disableOperations([...])`.
- **`z.record()` / `z.tuple()`** now map to `a.json()` without a warning
  (intentional JSON). `z.map()` / `z.set()` / `z.bigint()` still warn.

- **MCP server** — new `zod-to-amplify mcp` subcommand starts a stdio
  [MCP](https://modelcontextprotocol.io) server exposing read-only tools
  `usage` (how-to guide, no args), `convert_schema` and `schema_summary` (both
  take a `schemaPath`). Register it with an MCP client via
  `npx -y zod-to-amplify-dsl mcp`. Adds a dependency on `@modelcontextprotocol/sdk`.

### Fixed

- `zodToAmplifyMeta` now surfaces `fieldAuth` and `disabledOperations` on each
  model summary (previously only the code generator emitted them).

### Changed

- **Field validation** — Zod constraints on `string`/`integer`/`float` fields now
  generate real Amplify `.validate()` chains instead of being emitted only as
  comments. `min`/`max` (string) → `minLength`/`maxLength`, `regex` → `matches`,
  `startsWith`/`endsWith` preserved; `min`/`max` (number) → `gte`/`lte`, `gt`/`lt`
  → `gt`/`lt`. Constraints on non-validatable types (e.g. `a.email()`) remain
  inline comments. `SchemaSummary` `validationHint` now reflects the same calls.

### Added

- **Storage (S3) fields** — `storageField(schema, { path, access? })` marks a string
  field as an S3 key. The field maps to `a.string()`, and a separate
  `amplify/storage/resource.ts` with a matching `defineStorage` is generated.
  - Access rules merged/de-duplicated per `path`; `allow` kinds map to
    `allow.guest` / `allow.authenticated` / `allow.entity("identity")` (owner) /
    `allow.groups([...])`. Defaults to authenticated read/write/delete when omitted.
  - New config options `storageOutput` and `storageName`; CLI writes the storage
    file (and prints it under `--dry`) only when a `storageField()` is used.
  - `zodToAmplify(models, { storageName })` now returns an optional `storage` string;
    `zodToAmplifyMeta` exposes `storage` paths and a per-field `storagePath`.

## [0.1.0] - 2026-06-01

Initial release. Converts [Zod v4](https://zod.dev) schemas to
[AWS Amplify Gen 2](https://docs.amplify.aws/gen2/) TypeScript DSL
(`@aws-amplify/data-schema` v1.x).

### Added

- **Programmatic API**
  - `zodToAmplify(models)` — generate Amplify DSL code with conversion warnings.
  - `zodToAmplifyMeta(models)` — emit a JSON-serializable `SchemaSummary`.
  - `defineModel(schema, options)` — attach `primaryKey`, `indexes`, and `auth` metadata.
  - `defineConfig(config)` — typed config helper for `zod-amplify.config.ts`.
- **CLI** (`zod-to-amplify`)
  - generate (default), `watch`, and `init` subcommands.
  - Flags: `--input`/`-i`, `--output`/`-o`, `--dry`, `--json`, and `--force` (for `init`).
  - Config loading via `zod-amplify.config.ts` (CLI flags take precedence).
- **Type mapping**
  - Scalars: string/number/boolean/date and string formats
    (`uuid`→`a.id()`, `email`, `url`, `e164`→`a.phone()`, `ipv4`/`ipv6`→`a.ipAddress()`, `datetime`).
  - `z.any()` / `z.unknown()` → `a.json()` (no warning); other unsupported types → `a.json()` with a warning.
  - Enums, literals, and literal unions hoisted to schema level and referenced via `a.ref()`.
  - Optional / `default` / nullable handling.
  - Scalar arrays (`z.array(...)` → `.array().required()`).
  - Nested non-model objects → `a.customType()`.
- **Relations**
  - `hasMany` / `belongsTo` / `hasOne` inference from getter/`z.lazy` references and FK fields.
  - Automatic junction model generation for mutual array references (manyToMany).
- **Model options** — composite primary keys (`.identifier`), secondary indexes, and
  authorization rules (`owner`, `ownerDefinedIn`, `publicApiKey`, `groups`).
- **Validation comments** — Zod constraints without an Amplify equivalent
  (e.g. `min`/`max`/`minLength`) preserved as inline comments.
- **Auto-managed fields** — `createdAt` / `updatedAt` emitted without `.required()`.

[Unreleased]: https://github.com/Gityosan/zod-to-amplify-dsl/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Gityosan/zod-to-amplify-dsl/releases/tag/v0.1.0
