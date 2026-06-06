import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { zodToAmplify, zodToAmplifyMeta } from "../converter"
import { loadSchema } from "../cli/loader"

// Keep in sync with the CLI/package version.
const VERSION = "0.1.0"

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
