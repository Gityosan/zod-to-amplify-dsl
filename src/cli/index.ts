import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { defineCommand, runMain } from "citty"
import logUpdate from "log-update"
import { zodToAmplify } from "../converter.js"
import { loadAmplifyConfig } from "./config.js"
import { loadSchema } from "./loader.js"

const main = defineCommand({
  meta: {
    name: "zod-to-amplify",
    description: "Convert Zod schemas to AWS Amplify Gen 2 DSL",
    version: "0.1.0",
  },
  args: {
    input: {
      type: "positional",
      description: "TypeScript file exporting Zod models",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path (default: amplify/data/resource.ts)",
    },
    dry: {
      type: "boolean",
      description: "Print output without writing to disk",
      default: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd()

    try {
      logUpdate("Loading config...")
      const fileConfig = await loadAmplifyConfig(cwd)

      const inputPath = resolve(cwd, args.input ?? fileConfig.input ?? "schema.ts")
      const outputPath = resolve(cwd, args.output ?? fileConfig.output ?? "amplify/data/resource.ts")

      logUpdate(`Loading schema from ${inputPath}...`)
      const models = await loadSchema(inputPath)
      const modelNames = Object.keys(models)

      logUpdate(`Converting ${modelNames.length} models (${modelNames.join(", ")})...`)
      const output = zodToAmplify(models)

      if (args.dry) {
        logUpdate.done()
        console.log(output)
        return
      }

      logUpdate(`Writing to ${outputPath}...`)
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, output, "utf8")

      logUpdate.done()
      console.log(`✓ ${modelNames.length} models → ${outputPath}`)
    } catch (err) {
      logUpdate.clear()
      console.error("✗", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  },
})

runMain(main)
