import { defineConfig } from "tsdown"

export default defineConfig([
  // Library entry: emits dist/index.js + type declarations
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    outDir: "dist",
  },
  // CLI entry: no types, prepend shebang
  {
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
  },
])
