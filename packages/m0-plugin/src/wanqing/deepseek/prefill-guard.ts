import { createLogger } from "../../logger"
import type { DeepseekAdapter } from "./types"

const log = createLogger({ service: "plugin.wanqing.deepseek.prefill-guard" })

const CONTINUE_PROMPT = "Continue."

/**
 * Bedrock-hosted deepseek rejects assistant message prefill:
 *   ValidationException: This model does not support assistant message prefill.
 *   The conversation must end with a user message.
 * Consecutive assistant messages are already collapsed upstream by the shared
 * merge-assistant adapter; here we only append a minimal user turn when the
 * conversation still ends on an assistant message. Bedrock-specific, so deepseek-only.
 */
export function createPrefillGuardAdapter(): DeepseekAdapter {
  return {
    prepareRequest(body) {
      const messages = body.messages
      if (!messages?.length) return
      if (messages.at(-1)?.role !== "assistant") return
      messages.push({ role: "user", content: CONTINUE_PROMPT })
      log.info("appended user turn to satisfy bedrock prefill rule", { model: body.model })
    },
  }
}
