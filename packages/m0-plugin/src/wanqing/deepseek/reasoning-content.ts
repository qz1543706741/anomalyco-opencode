import { createLogger } from "../../logger"
import type { DeepseekAdapter } from "./types"

const log = createLogger({ service: "plugin.wanqing.deepseek.reasoning-content" })

/**
 * deepseek `reasoning_content` handling is opposite across the two regimes:
 *
 * - Non-thinking (legacy deepseek-reasoner replay): feeding `reasoning_content`
 *   back on the next turn returns 400, so it must be stripped.
 * - Thinking enabled (deepseek-v4 via wanqing): the gateway *requires* the prior
 *   `reasoning_content` to be passed back — stripping it returns 400
 *   ("The `reasoning_content` in the thinking mode must be passed back to the API").
 *
 * thinking-config runs before this adapter and sets `extra_body.thinking.type`,
 * so gate on that: keep when thinking is enabled, strip otherwise.
 * See https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
export function createReasoningContentAdapter(): DeepseekAdapter {
  return {
    prepareRequest(body) {
      if (body.extra_body?.thinking?.type === "enabled") return

      let stripped = 0
      for (const msg of body.messages ?? []) {
        if (msg.reasoning_content !== undefined) {
          delete msg.reasoning_content
          stripped++
        }
      }
      if (stripped)
        log.info("stripped reasoning_content from deepseek request messages", { model: body.model, stripped })
    },
  }
}
