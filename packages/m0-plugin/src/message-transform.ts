import type { Hooks } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { createLogger } from "./logger"

const MAX_CONTEXT_IMAGES = 4
const MAX_LOG_TEXT = 1000
const log = createLogger({ service: "m0.message-transform" })

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasAnthropicSignature(metadata: Record<string, unknown> | undefined) {
  if (!isRecord(metadata?.anthropic)) return false
  return metadata.anthropic.signature != null
}

function hasAnthropicSignedReasoning(parts: Part[]) {
  return parts.some((part) => part.type === "reasoning" && hasAnthropicSignature(part.metadata))
}

export function summarizeLLMMessages(messages: unknown[] | undefined) {
  return (messages ?? []).map((message) => summarizeLogValue(message, 0))
}

function summarizeLogValue(value: unknown, depth: number, preserveURLs = false): unknown {
  if (typeof value === "string") return summarizeLogText(value, preserveURLs)
  if (!value || typeof value !== "object") return value
  if (depth >= 8) return "<max-depth>"
  if (ArrayBuffer.isView(value)) return `<binary bytes=${value.byteLength}>`
  if (value instanceof ArrayBuffer) return `<binary bytes=${value.byteLength}>`
  if (Array.isArray(value))
    return [
      ...value.slice(0, 100).map((item) => summarizeLogValue(item, depth + 1, preserveURLs)),
      ...(value.length > 100 ? [`<${value.length - 100} items omitted>`] : []),
    ]

  const media = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(media).map(([key, item]) => [
      key,
      key === "data" && typeof item === "string" && ["file", "image", "media"].includes(String(media.type))
        ? `<inline-media chars=${item.length}>`
        : summarizeLogValue(
            item,
            depth + 1,
            preserveURLs || (media.type === "tool-result" && media.toolName === "get_screenshot" && key === "output"),
          ),
    ]),
  )
}

function summarizeLogText(value: string, preserveURLs = false) {
  if (/^data:[^;,]+(?:;[^,]+)*,/.test(value)) return `<inline-data-url chars=${value.length}>`
  if (value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) return `<base64 chars=${value.length}>`
  const imageCDN = value.match(/^\[Image CDN: (https?:\/\/.+)\]$/)
  if (imageCDN) return `[Image CDN: <url:${imageCDN[1]}>]`
  if (preserveURLs) return value.replace(/https?:\/\/[^\s"')\]}]+/g, (url) => `<url:${url}>`)
  const sanitized = value.replace(/https?:\/\/[^\s"')\]}]+/g, (url) => {
    try {
      return `<url:${new URL(url).hostname}>`
    } catch {
      return "<url>"
    }
  })
  if (sanitized.length <= MAX_LOG_TEXT) return sanitized
  return sanitized.slice(0, MAX_LOG_TEXT) + `<${sanitized.length - MAX_LOG_TEXT} chars omitted>`
}

export function createMessageTransformHooks(): Hooks {
  return {
    async "experimental.chat.messages.transform"(_, output) {
      const images = output.messages
        .flatMap((msg) => msg.parts)
        .flatMap((part) => {
          if (part.type === "file") return [part]
          if (part.type === "tool" && part.state.status === "completed" && !part.state.time.compacted)
            return part.state.attachments ?? []
          return []
        })
        .filter((attachment) => attachment.mime.startsWith("image/"))
      const recentImages = new Set(images.slice(-MAX_CONTEXT_IMAGES).map((attachment) => attachment.id))
      if (images.length > 0)
        log.debug("image attachment LRU scan", {
          messages: output.messages.length,
          images: images.length,
          retained: recentImages.size,
          evicted: Math.max(0, images.length - recentImages.size),
          limit: MAX_CONTEXT_IMAGES,
        })

      for (const msg of output.messages) {
        if (msg.info.role === "user") {
          const evicted = msg.parts.filter(
            (part) => part.type === "file" && part.mime.startsWith("image/") && !recentImages.has(part.id),
          )
          if (evicted.length === 0) continue
          const evictedIDs = new Set(evicted.map((part) => part.id))
          msg.parts = msg.parts.flatMap((part) => {
            if (part.type !== "file" || !evictedIDs.has(part.id)) return [part]
            const cdn =
              part.url.startsWith("http://") || part.url.startsWith("https://")
                ? part.url
                : part.source?.type === "file" &&
                    (part.source.path.startsWith("http://") || part.source.path.startsWith("https://"))
                  ? part.source.path
                  : undefined
            if (!cdn) return []
            return [
              {
                id: part.id,
                sessionID: part.sessionID,
                messageID: part.messageID,
                type: "text" as const,
                text: `[Image CDN: ${cdn}]`,
                synthetic: true,
              },
            ]
          })
          log.info("evicted historical user images", {
            sessionID: msg.info.sessionID,
            messageID: msg.info.id,
            evicted: evicted.length,
            retained: recentImages.size,
            limit: MAX_CONTEXT_IMAGES,
            placeholder: "image_cdn",
          })
          continue
        }
        if (msg.info.role !== "assistant") continue
        if (!hasAnthropicSignedReasoning(msg.parts))
          msg.parts = msg.parts.filter((part) => !(part.type === "text" && part.text === ""))

        for (const part of msg.parts) {
          if (part.type !== "tool" || part.state.status !== "completed" || part.state.time.compacted) continue
          const evicted = (part.state.attachments ?? []).filter(
            (attachment) => attachment.mime.startsWith("image/") && !recentImages.has(attachment.id),
          )
          if (evicted.length === 0) continue
          part.state.attachments = (part.state.attachments ?? []).filter((attachment) => !evicted.includes(attachment))
          log.info("evicted historical tool images", {
            sessionID: msg.info.sessionID,
            messageID: msg.info.id,
            callID: part.callID,
            tool: part.tool,
            evicted: evicted.length,
            retained: recentImages.size,
            limit: MAX_CONTEXT_IMAGES,
            placeholder: "tool_output_cdn",
          })
        }
      }
    },
  }
}
