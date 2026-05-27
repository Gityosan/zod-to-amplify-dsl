import { watch } from "fs"
import { resolve } from "path"
import logUpdate from "log-update"
import { defineCommand, runMain } from "citty"
import { loadAmplifyConfig } from "./config.js"
import { runGenerate } from "./generate.js"

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

async function resolveArgs(
  args: { input?: string; output?: string },
  cwd: string
) {
  const fileConfig = await loadAmplifyConfig(cwd)
  return {
    inputPath: resolve(cwd, args.input ?? fileConfig.input ?? "schema.ts"),
    outputPath: resolve(cwd, args.output ?? fileConfig.output ?? "amplify/data/resource.ts"),
  }
}

// ---- watch subcommand ----

const watchCmd = defineCommand({
  meta: { name: "watch", description: "Watch schema file and regenerate on changes" },
  args: { input: inputArg, output: outputArg },
  async run({ args }) {
    const cwd = process.cwd()
    const { inputPath, outputPath } = await resolveArgs(args, cwd)

    // Initial run
    try {
      await runGenerate({ inputPath, outputPath })
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
          await runGenerate({ inputPath, outputPath, silent: true })
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
  subCommands: { watch: watchCmd },
  args: {
    input: inputArg,
    output: outputArg,
    dry: {
      type: "boolean" as const,
      description: "Print output without writing to disk",
      default: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    try {
      logUpdate("Loading config...")
      const { inputPath, outputPath } = await resolveArgs(args, cwd)
      await runGenerate({ inputPath, outputPath, dry: args.dry })
    } catch (err) {
      logUpdate.clear()
      console.error("✗", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  },
})

runMain(main)
