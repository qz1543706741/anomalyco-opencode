import { createLogger } from "../../logger"
import type { GeminiAdapter } from "./types"

const log = createLogger({ service: "plugin.wanqing.gemini.reasoning-stream" })

/**
 * Gemini (via wanqing-online-reasoning) emits reasoning as
 * `delta.extra_content.google.thought`, which the OpenAI-compatible AI SDK does
 * not recognize. Rewrite each SSE line so the reasoning surfaces as
 * `delta.reasoning_content`:
 *
 * - `thought === true` + string `content`: the content *is* the thought, so move
 *   it to `reasoning_content` and null out `content`.
 * - `thought` is a non-empty string: copy it into `reasoning_content`.
 *
 * Lines already carrying `reasoning_content` are left untouched, as are
 * non-thought deltas and the terminal `[DONE]` sentinel.
 */
export function rewriteReasoningSseLine(line: string): string {
  const carriageReturn = line.endsWith("\r") ? "\r" : ""
  const content = carriageReturn ? line.slice(0, -1) : line
  const match = content.match(/^(\s*data:\s*)(.*)$/)
  const data = match?.[2]
  if (!match || data === undefined || data === "[DONE]") return line

  try {
    const payload = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: unknown
          extra_content?: { google?: { thought?: unknown } }
          reasoning_content?: unknown
        }
      }>
    }
    let changed = false
    for (const choice of payload.choices ?? []) {
      const delta = choice.delta
      if (!delta) continue
      const thought = delta?.extra_content?.google?.thought
      if (delta.reasoning_content !== undefined) continue
      if (thought === true && typeof delta.content === "string" && delta.content.length > 0) {
        delta.reasoning_content = delta.content
        delta.content = null
      } else if (typeof thought === "string" && thought.length > 0) {
        delta.reasoning_content = thought
      } else {
        continue
      }
      changed = true
    }
    if (!changed) return line
    return `${match[1]}${JSON.stringify(payload)}${carriageReturn}`
  } catch (error) {
    log.warn("failed to rewrite reasoning stream line", {
      error: error instanceof Error ? error.message : String(error),
      lineLength: line.length,
    })
    return line
  }
}

export function createReasoningStreamAdapter(): GeminiAdapter {
  return {
    transformStream(stream) {
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buffered = ""
      return stream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            buffered += decoder.decode(chunk, { stream: true })
            const lines = buffered.split("\n")
            buffered = lines.pop() ?? ""
            if (lines.length > 0) {
              controller.enqueue(encoder.encode(`${lines.map(rewriteReasoningSseLine).join("\n")}\n`))
            }
          },
          flush(controller) {
            buffered += decoder.decode()
            if (buffered) controller.enqueue(encoder.encode(rewriteReasoningSseLine(buffered)))
          },
        }),
      )
    },
  }
}
