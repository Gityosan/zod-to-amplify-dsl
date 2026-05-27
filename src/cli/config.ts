import { loadConfig } from "c12"
import type { ZodAmplifyConfig } from "../types.js"

export async function loadAmplifyConfig(cwd: string): Promise<ZodAmplifyConfig> {
  const { config } = await loadConfig<ZodAmplifyConfig>({
    name: "zod-amplify",
    cwd,
    defaults: {},
  })
  return config
}
