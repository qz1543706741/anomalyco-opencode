import { createLogger } from "../logger"
import type { ChatMessage, MessageBody, RequestAdapter } from "./adapter"

const log = createLogger({ service: "plugin.wanqing.merge-assistant" })

// DeepSeek/OpenAI-compatible chat schema types message content as a string
// (https://api-docs.deepseek.com/api/create-chat-completion). Reduce any content to text:
// strings pass through; block arrays contribute their text parts; everything else is dropped.
function toText(c: unknown): string {
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n\n")
  }
  return ""
}

function mergeContent(a: unknown, b: unknown): string {
  return [toText(a), toText(b)].filter(Boolean).join("\n\n")
}

/**
 * Collapse runs of consecutive assistant messages into one. Back-to-back assistant turns
 * violate the strict user/assistant alternation Bedrock-hosted models require and stem from
 * an upstream defect (duplicate assistant summaries). Safe for every family, so it runs for
 * all of them; the Bedrock-only "must end with user" rule is handled separately by the
 * deepseek prefill guard.
 */
export function createMergeAssistantAdapter<TBody extends MessageBody>(): RequestAdapter<TBody> {
  return {
    prepareRequest(body) {
      const messages = body.messages
      if (!messages?.length) return

      const merged: ChatMessage[] = []
      let count = 0
      for (const msg of messages) {
        const prev = merged.at(-1)
        if (msg.role === "assistant" && prev?.role === "assistant") {
          prev.content = mergeContent(prev.content, msg.content)
          if (msg.tool_calls?.length) prev.tool_calls = [...(prev.tool_calls ?? []), ...msg.tool_calls]
          count++
          continue
        }
        merged.push(msg)
      }

      if (!count) return
      body.messages = merged as TBody["messages"]
      log.info("merged consecutive assistant messages", { model: body.model, count })
    },
  }
}
