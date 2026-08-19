import { createLogger } from "../../logger"
import type { GeminiAdapter } from "./types"

const log = createLogger({ service: "plugin.wanqing.gemini.thought-signature" })

/**
 * Gemini requires every assistant tool_call to carry the thought_signature it
 * emitted, otherwise the validator rejects the turn. We capture signatures from
 * streamed responses into a cache, then replay them on subsequent requests
 * (falling back to a skip token when none is known).
 */
export function createThoughtSignatureAdapter(): GeminiAdapter {
  const cache = new Map<string, string>()

  return {
    prepareRequest(body) {
      let reused = 0
      let fallback = 0
      let skipped = 0

      for (const msg of body.messages ?? []) {
        if (msg.role !== "assistant") continue
        if (!Array.isArray(msg.tool_calls)) continue

        for (const toolCall of msg.tool_calls) {
          if (toolCall.extra_content?.google?.thought_signature) {
            skipped++
            continue
          }

          const cached = toolCall.id ? cache.get(toolCall.id) : undefined
          toolCall.extra_content = {
            google: {
              thought_signature: cached ?? "skip_thought_signature_validator",
            },
          }
          if (cached) reused++
          else fallback++
        }
      }

      if (reused || fallback || skipped) {
        log.info("prepared thought signatures for request", { reused, fallback, skipped, cacheSize: cache.size })
      }
    },

    async extractFromStream(body) {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      const toolCallIDs = new Map<string, string>()
      let buffer = ""

      let chunks = 0
      let stored = 0
      let parseErrors = 0

      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break

          chunks++
          buffer += decoder.decode(part.value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue

            try {
              const parsed = JSON.parse(line.slice(6)) as {
                choices?: Array<{
                  index?: number
                  delta?: {
                    tool_calls?: Array<{
                      index?: number
                      id?: string
                      extra_content?: {
                        google?: {
                          thought_signature?: string
                        }
                      }
                    }>
                  }
                }>
              }
              for (const choice of parsed.choices ?? []) {
                for (const [position, toolCall] of (choice.delta?.tool_calls ?? []).entries()) {
                  const key = `${choice.index ?? 0}:${toolCall.index ?? position}`
                  if (toolCall.id) toolCallIDs.set(key, toolCall.id)
                  const signature = toolCall.extra_content?.google?.thought_signature
                  const toolCallID = toolCall.id ?? toolCallIDs.get(key)
                  if (signature && toolCallID) {
                    cache.set(toolCallID, signature)
                    stored++
                    log.info("stored thought signature", {
                      toolCallID,
                      signatureLength: signature.length,
                      cacheSize: cache.size,
                    })
                  }
                }
              }
            } catch (error) {
              parseErrors++
              log.warn("failed to parse thought signature stream line", {
                error: error instanceof Error ? error.message : String(error),
                lineLength: line.length,
              })
            }
          }
        }
      } catch (error) {
        log.warn("failed while reading thought signature stream", {
          error: error instanceof Error ? error.message : String(error),
          chunks,
          stored,
          parseErrors,
        })
        return
      }

      log.info("finished thought signature extraction", { chunks, stored, parseErrors, cacheSize: cache.size })
    },
  }
}
