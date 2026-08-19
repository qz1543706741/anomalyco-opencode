import { createLogger } from "../../logger"
import type { GptAdapter } from "./types"

const log = createLogger({ service: "plugin.wanqing.gpt.completion-tokens" })

/**
 * GPT models reject `max_tokens`:
 *   Unsupported parameter: 'max_tokens' is not supported with this model.
 *   Use 'max_completion_tokens' instead.
 * Rename it on outgoing requests, preserving any caller-set max_completion_tokens.
 */
export function createCompletionTokensAdapter(): GptAdapter {
  return {
    prepareRequest(body) {
      if (body.max_tokens === undefined) return
      if (body.max_completion_tokens === undefined) body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
      log.info("renamed max_tokens to max_completion_tokens for gpt model", { model: body.model })
    },
  }
}
