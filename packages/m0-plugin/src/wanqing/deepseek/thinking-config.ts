import { createLogger } from "../../logger"
import type { DeepseekAdapter } from "./types"

const log = createLogger({ service: "plugin.wanqing.deepseek.thinking-config" })

/**
 * deepseek-v4 reasoning is opted in via vendor extra_body. Mirrors the gemini
 * thinking-config adapter: thinking enabled + max effort on both reasoning and
 * output. Matched by model, so no providerID gate.
 */
export function createThinkingConfigAdapter(): DeepseekAdapter {
  return {
    prepareRequest(body) {
      body.extra_body = {
        ...body.extra_body,
        thinking: { type: "enabled" },
      }
      body.reasoning_effort = "max"
      body.output_config = { effort: "max" }
      log.info("injected thinking_config", body)
    },
  }
}
