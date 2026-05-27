import { defineConfig } from "tsdown"

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  },
  {
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    banner: { js: "#!/usr/bin/env node" },
  },
])
