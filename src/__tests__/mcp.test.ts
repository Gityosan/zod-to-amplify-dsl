import { describe, it, expect, afterAll } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "../mcp/server"

const TMP = join(import.meta.dirname, "tmp-mcp")

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function tmpSchema(name: string, content: string): string {
  mkdirSync(TMP, { recursive: true })
  const p = join(TMP, name)
  writeFileSync(p, content, "utf8")
  return p
}

/** Connect an in-memory client to a fresh server instance. */
async function connectClient() {
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe("MCP server", () => {
  it("lists the convert_schema and schema_summary tools", async () => {
    const client = await connectClient()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(["convert_schema", "schema_summary"])
    await client.close()
  })

  it("convert_schema returns generated Amplify DSL", async () => {
    const schemaPath = tmpSchema(
      "blog.ts",
      `import { z } from "zod"
export const Post = z.object({ id: z.string().uuid(), title: z.string() })
`,
    )
    const client = await connectClient()
    const res = await client.callTool({ name: "convert_schema", arguments: { schemaPath } })
    const text = (res.content as { type: string; text: string }[])[0].text
    expect(text).toContain("const schema = a.schema({")
    expect(text).toContain("title: a.string().required(),")
    expect(res.isError).toBeFalsy()
    await client.close()
  })

  it("schema_summary returns JSON metadata", async () => {
    const schemaPath = tmpSchema(
      "todo.ts",
      `import { z } from "zod"
export const Todo = z.object({ id: z.string(), done: z.boolean() })
`,
    )
    const client = await connectClient()
    const res = await client.callTool({ name: "schema_summary", arguments: { schemaPath } })
    const text = (res.content as { type: string; text: string }[])[0].text
    const meta = JSON.parse(text)
    expect(meta.models[0].name).toBe("Todo")
    await client.close()
  })

  it("returns an error result for a missing schema file", async () => {
    const client = await connectClient()
    const res = await client.callTool({
      name: "convert_schema",
      arguments: { schemaPath: join(TMP, "nope.ts") },
    })
    expect(res.isError).toBe(true)
    await client.close()
  })
})
