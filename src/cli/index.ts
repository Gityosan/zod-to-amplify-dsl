import { existsSync, watch, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import logUpdate from "log-update"
import { defineCommand, runMain } from "citty"
import { loadAmplifyConfig } from "./config"
import { deriveStoragePath, runGenerate } from "./generate"

const inputArg = {
  type: "string" as const,
  alias: "i",
  description: "TypeScript file exporting Zod models",
}

const outputArg = {
  type: "string" as const,
  alias: "o",
  description: "Output file path",
}

const jsonArg = {
  type: "boolean" as const,
  description: "Output JSON metadata instead of TypeScript",
  default: false,
}

async function resolveArgs(args: { input?: string; output?: string }, cwd: string) {
  const fileConfig = await loadAmplifyConfig(cwd)
  const outputPath = resolve(cwd, args.output ?? fileConfig.output ?? "amplify/data/resource.ts")
  return {
    inputPath: resolve(cwd, args.input ?? fileConfig.input ?? "schema.ts"),
    outputPath,
    storagePath: fileConfig.storageOutput
      ? resolve(cwd, fileConfig.storageOutput)
      : deriveStoragePath(outputPath),
    storageName: fileConfig.storageName,
  }
}

// ---- init subcommand ----

const STARTER_SCHEMA = `import { z } from "zod"
import { defineModel } from "zod-to-amplify-dsl"

export const Todo = defineModel(
  z.object({
    id: z.string().uuid(),
    content: z.string().min(1),
    done: z.boolean().default(false),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  {
    auth: [{ allow: "owner" }],
  }
)
`

const STARTER_CONFIG = `import { defineConfig } from "zod-to-amplify-dsl"

export default defineConfig({
  input: "schema.ts",
  output: "amplify/data/resource.ts",
})
`

const initCmd = defineCommand({
  meta: { name: "init", description: "Create starter schema.ts and zod-amplify.config.ts" },
  args: {
    force: {
      type: "boolean" as const,
      description: "Overwrite existing files",
      default: false,
    },
  },
  run({ args }) {
    const cwd = process.cwd()
    const schemaPath = resolve(cwd, "schema.ts")
    const configPath = resolve(cwd, "zod-amplify.config.ts")
    let created = 0

    if (!existsSync(schemaPath) || args.force) {
      writeFileSync(schemaPath, STARTER_SCHEMA, "utf8")
      console.log(`✓ Created ${schemaPath}`)
      created++
    } else {
      console.log(`· Skipped ${schemaPath} (already exists, use --force to overwrite)`)
    }

    if (!existsSync(configPath) || args.force) {
      writeFileSync(configPath, STARTER_CONFIG, "utf8")
      console.log(`✓ Created ${configPath}`)
      created++
    } else {
      console.log(`· Skipped ${configPath} (already exists, use --force to overwrite)`)
    }

    if (created > 0) {
      console.log(`\nRun: npx zod-to-amplify --dry`)
    }
  },
})

// ---- watch subcommand ----

const watchCmd = defineCommand({
  meta: { name: "watch", description: "Watch schema file and regenerate on changes" },
  args: { input: inputArg, output: outputArg, json: jsonArg },
  async run({ args }) {
    const cwd = process.cwd()
    const { inputPath, outputPath, storagePath, storageName } = await resolveArgs(args, cwd)

    // Initial run
    try {
      await runGenerate({ inputPath, outputPath, storagePath, storageName, json: args.json })
    } catch (err) {
      logUpdate.clear()
      console.error("✗", err instanceof Error ? err.message : err)
    }

    process.stdout.write(`Watching ${inputPath}... (Ctrl+C to stop)\n`)

    let debounce: ReturnType<typeof setTimeout> | null = null
    const watcher = watch(inputPath, () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(async () => {
        try {
          await runGenerate({
            inputPath,
            outputPath,
            storagePath,
            storageName,
            silent: true,
            json: args.json,
          })
        } catch (err) {
          console.error("✗", err instanceof Error ? err.message : err)
        }
      }, 150)
    })

    process.on("SIGINT", () => {
      watcher.close()
      process.exit(0)
    })

    // Keep process alive until Ctrl+C
    await new Promise<never>(() => {})
  },
})

// ---- main command (generate) ----

const main = defineCommand({
  meta: {
    name: "zod-to-amplify",
    description: "Convert Zod schemas to AWS Amplify Gen 2 DSL",
    version: "0.1.0",
  },
  subCommands: { watch: watchCmd, init: initCmd },
  args: {
    input: inputArg,
    output: outputArg,
    dry: {
      type: "boolean" as const,
      description: "Print output without writing to disk",
      default: false,
    },
    check: {
      type: "boolean" as const,
      description: "Verify generated output is up to date; exit 1 on drift (CI)",
      default: false,
    },
    json: jsonArg,
  },
  async run({ args }) {
    const cwd = process.cwd()
    try {
      logUpdate("Loading config...")
      const { inputPath, outputPath, storagePath, storageName } = await resolveArgs(args, cwd)
      await runGenerate({
        inputPath,
        outputPath,
        storagePath,
        storageName,
        dry: args.dry,
        check: args.check,
        json: args.json,
      })
    } catch (err) {
      logUpdate.clear()
      console.error("✗", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  },
})

runMain(main)
