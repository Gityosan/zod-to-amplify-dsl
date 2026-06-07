import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { zodToAmplify, zodToAmplifyMeta } from "../converter"
import { loadSchema } from "../cli/loader"

// Keep in sync with the CLI/package version.
const VERSION = "0.1.0"

const USAGE_GUIDE = `# zod-to-amplify-dsl — MCP usage

This server converts **Zod v4** schemas into **AWS Amplify Gen 2** data schema
TypeScript. You write a schema file, then call a tool with its path.

## Tools
- \`usage\` — this guide (no arguments).
- \`convert_schema { schemaPath }\` — returns the generated \`a.schema({ ... })\`
  TypeScript (storage code + warnings appended as comments).
- \`schema_summary { schemaPath }\` — returns a JSON summary of models, fields,
  relations, auth, indexes and storage paths.

The tools are **read-only**: they never write files. You author the schema
file; \`schemaPath\` is resolved relative to the server's working directory.

## Writing a schema file
Export Zod models as named exports (or \`export default { ... }\`). Wrap a model
with \`defineModel\` to attach model options.

\`\`\`ts
import { z } from "zod"
import { defineModel, storageField } from "zod-to-amplify-dsl"

export const Post = defineModel(
  z.object({
    id: z.uuid(),                        // -> a.id()
    title: z.string().min(1).max(200),   // -> a.string().validate(v => v.minLength(1).maxLength(200))
    status: z.enum(["draft", "published"]), // hoisted to a schema-level a.enum()
    authorId: z.string(),                // *Id string -> a.id()
    cover: storageField(z.string(), {    // S3 key; emits a separate defineStorage
      path: "media/posts/*",
      access: [{ allow: "guest", to: ["read"] }, { allow: "owner", to: ["read", "write", "delete"] }],
    }).optional(),
    createdAt: z.iso.datetime(),         // -> a.datetime()
    get author() { return User },        // belongsTo (FK authorId found) — use a getter for refs
  }),
  {
    indexes: [{ name: "byAuthor", pk: "authorId", sk: "createdAt", queryField: "listByAuthor" }],
    auth: [{ allow: "owner", ownerField: "authorId" }, { allow: "public", operations: ["read"] }],
    fieldAuth: { title: [{ allow: "authenticated" }] },
    disabledOperations: ["subscriptions"],
  },
)

export const User = z.object({
  id: z.uuid(),
  email: z.email(),                      // -> a.email()
  get posts() { return z.array(Post) },  // hasMany (mutual arrays -> manyToMany junction)
})
\`\`\`

## Conventions
- **Relations**: use a getter (or \`z.lazy\`) returning a model. Object ref =>
  belongsTo when a matching \`<name>Id\` field exists, else hasOne. \`z.array(Model)\`
  => hasMany. Models that reference each other with arrays => a junction model.
- **Auth allow kinds**: owner, multipleOwners, public, guest, authenticated,
  group, groups, custom. All accept \`operations\`; owner/group accept \`provider\`.
- **Scalars**: string formats map to a.email/url/phone/id/ipAddress/date/time/
  datetime; number -> a.float (a.integer with .int()); z.record/z.tuple -> a.json.
- **Validation** (string/integer/float): min/max/regex/startsWith/endsWith become
  \`.validate(...)\`; other types keep a \`// zod:\` comment.

## Workflow
1. Call \`usage\` (this) if unsure of conventions.
2. Write the schema \`.ts\` file.
3. Call \`convert_schema { schemaPath }\`; write the returned code to
   \`amplify/data/resource.ts\` (and any storage block to \`amplify/storage/resource.ts\`).
`

const schemaPathInput = {
  schemaPath: z
    .string()
    .describe(
      "Path to a TypeScript file that exports Zod models (named exports or `export default { ... }`). Absolute, or relative to the server's working directory.",
    ),
}

/** Run a tool body, turning thrown errors into an MCP error result instead of
 *  crashing the server (e.g. when the schema file is missing or invalid). */
async function safeTool(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: await run() }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true }
  }
}

/** Build the MCP server exposing the converter as read-only tools. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "zod-to-amplify-dsl", version: VERSION })

  server.registerTool(
    "usage",
    {
      title: "How to use this server",
      description:
        "Explain how to write a Zod schema file for this converter and how to call the other " +
        "tools. Call this first if you are unsure of the conventions. Takes no arguments.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => ({ content: [{ type: "text", text: USAGE_GUIDE }] }),
  )

  server.registerTool(
    "convert_schema",
    {
      title: "Convert Zod schema to Amplify DSL",
      description:
        "Load a TypeScript file exporting Zod models and return the generated AWS Amplify Gen 2 " +
        "data schema (a.schema({ ... })). Any generated storage (defineStorage) code and conversion " +
        "warnings are appended as comments.",
      inputSchema: schemaPathInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ schemaPath }) =>
      safeTool(async () => {
        const { code, warnings, storage } = zodToAmplify(await loadSchema(schemaPath))
        const parts = [code]
        if (storage) parts.push(`\n// ---- amplify/storage/resource.ts ----\n${storage}`)
        if (warnings.length > 0) {
          parts.push(
            "\n// warnings:\n" +
              warnings
                .map((w) => `//   ${w.model}.${w.field}: ${w.zodType} -> a.json()`)
                .join("\n"),
          )
        }
        return parts.join("\n")
      }),
  )

  server.registerTool(
    "schema_summary",
    {
      title: "Summarize Zod schema as JSON",
      description:
        "Load a TypeScript file exporting Zod models and return a JSON summary (models, fields, " +
        "relations, auth, indexes, storage paths, and warnings) produced by zodToAmplifyMeta.",
      inputSchema: schemaPathInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ schemaPath }) =>
      safeTool(async () => JSON.stringify(zodToAmplifyMeta(await loadSchema(schemaPath)), null, 2)),
  )

  return server
}

/** Start the MCP server over stdio (used by the `zod-to-amplify mcp` subcommand). */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdout is reserved for the JSON-RPC stream; diagnostics go to stderr.
  console.error("zod-to-amplify-dsl MCP server running on stdio")
}
