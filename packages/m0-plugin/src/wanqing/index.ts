import type { Config, Hooks } from "@opencode-ai/plugin"
import { createLogger } from "../logger"
import type { ModelCatalog } from "../model-catalog"
import type { ProviderObservability } from "../provider-observability"
import type { ComposedAdapter } from "./adapter"
import { createDeepseekAdapter } from "./deepseek"
import { createGeminiAdapter } from "./gemini"
import { createGptAdapter } from "./gpt"
import { materializeWanqingImage, remoteImage } from "./image"
import { createModelMatcher } from "./model-matcher"

const DEFAULT_PROVIDER_IDS = ["wanqing", "wanqing-online-reasoning"]
const DEFAULT_ANTHROPIC_BETA = "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
const SESSION_HEADER = "x-m0-session-id"
const MESSAGE_HEADER = "x-m0-message-id"
const CALL_HEADER = "x-m0-call-key"
const SENSITIVE_HEADER = /authorization|api[-_]?key|token|cookie/i

export type WanqingPluginOptions = {
  providerIDs?: string[]
  anthropicBeta?: string
  fetch?: typeof globalThis.fetch
}

type RequestBody = { model?: string } & Record<string, unknown>
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Family = {
  name: string
  matches: (modelID: unknown) => boolean
  adapter: ComposedAdapter<RequestBody>
}

function redactHeaders(headers: Headers) {
  return Object.fromEntries(
    Array.from(headers.entries(), ([key, value]) => [key, SENSITIVE_HEADER.test(key) ? "<redacted>" : value]),
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function createWanqingHooks(
  catalog: ModelCatalog,
  observability: ProviderObservability,
  options: WanqingPluginOptions = {},
) {
  const log = createLogger({ service: "m0.wanqing" })
  const providerIDs = options.providerIDs?.length ? options.providerIDs : DEFAULT_PROVIDER_IDS
  const matcher = createModelMatcher(catalog.displayNames)
  const installed = new Map<string, { baseFetch: Fetch; wrapper: Fetch }>()
  const families: Family[] = [
    { name: "gemini", matches: matcher.isGeminiModel, adapter: createGeminiAdapter() },
    { name: "gpt", matches: matcher.isGptModel, adapter: createGptAdapter() },
    { name: "deepseek", matches: matcher.isDeepseekModel, adapter: createDeepseekAdapter() },
  ]

  function adapt(providerID: string, init: RequestInit) {
    if (init.method !== "POST" || typeof init.body !== "string") return []
    const body = (() => {
      try {
        return JSON.parse(init.body) as RequestBody
      } catch (error) {
        log.warn("failed to parse request body", { providerID, error })
      }
    })()
    if (!body) return []
    // Responses API body（@ai-sdk/openai，如 GPT 5.5）用 `input` 而非 `messages`。family
    // adapter 全为 chat/completions 设计，对其应完全跳过，避免未来演进误伤 Responses 请求。
    if ("input" in body && !("messages" in body)) return []
    const matched = families.filter((family) => family.matches(body.model))
    const headers = new Headers(init.headers)
    for (const family of matched) {
      family.adapter.prepareRequest(body, { providerID })
      family.adapter.prepareHeaders(headers, { providerID })
    }
    if (matched.length) init.body = JSON.stringify(body)
    init.headers = headers
    return matched
  }

  function createFetch(providerID: string, baseFetch: Fetch): Fetch {
    return async (input, init) => {
      const request = { ...init }
      if (input instanceof Request) {
        request.method ??= input.method
        request.headers ??= input.headers
        if (request.body === undefined && !["GET", "HEAD"].includes(request.method)) {
          request.body = await input.clone().text()
        }
      }
      const matched = (() => {
        try {
          return adapt(providerID, request)
        } catch (error) {
          log.warn("request adapter failed", { providerID, error })
          return []
        }
      })()
      const streamConsumers = matched.filter((family) => family.adapter.hasStreamConsumer)
      const streamTransformers = matched.filter((family) => family.adapter.hasStreamTransformer)
      const headers = new Headers(request.headers)
      const sessionID = headers.get(SESSION_HEADER) ?? undefined
      const userMsgID = headers.get(MESSAGE_HEADER) ?? undefined
      const callKey = headers.get(CALL_HEADER) ?? undefined
      headers.delete(SESSION_HEADER)
      headers.delete(MESSAGE_HEADER)
      headers.delete(CALL_HEADER)
      request.headers = headers
      const reqID = crypto.randomUUID()
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const common = {
        providerID,
        reqID,
        sessionID,
        userMsgID,
        callKey,
        method: request.method ?? "GET",
        url,
        requestHeaders: redactHeaders(headers),
      }

      let response
      try {
        response = await baseFetch(input, request)
      } catch (error) {
        observability.emit({
          ...common,
          status: 0,
          responseHeaders: {},
          error: errorMessage(error),
        })
        throw error
      }

      observability.emit({
        ...common,
        status: response.status,
        responseHeaders: redactHeaders(response.headers),
      })
      if (!response.ok || !response.body || (!streamConsumers.length && !streamTransformers.length)) return response

      let body: ReadableStream<Uint8Array> = response.body
      for (const family of streamConsumers) {
        const [consumer, caller] = body.tee()
        body = caller
        void family.adapter
          .extractFromStream(consumer)
          .catch((error) => log.warn("stream adapter failed", { providerID, family: family.name, error }))
      }
      for (const family of streamTransformers) {
        try {
          body = family.adapter.transformStream(body)
        } catch (error) {
          log.warn("stream transform failed", { providerID, family: family.name, error })
        }
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
  }

  const hooks: Hooks = {
    async config(config: Config) {
      for (const providerID of providerIDs) {
        const provider = config.provider?.[providerID]
        if (!provider) continue
        provider.options ??= {}
        const current = provider.options.fetch
        const previous = installed.get(providerID)
        if (previous && current === previous.wrapper) continue
        const baseFetch =
          options.fetch ??
          (typeof current === "function" ? (current as Fetch) : undefined) ??
          (globalThis.fetch as Fetch)
        const wrapper = createFetch(providerID, baseFetch)
        installed.set(providerID, { baseFetch, wrapper })
        provider.options.fetch = wrapper
      }
    },
    async "chat.params"(input, output) {
      if (!providerIDs.includes(input.model.providerID)) return
      const limit = catalog.get(input.model.id)?.maxOutputTokens
      if (!limit || output.maxOutputTokens === limit) return
      output.maxOutputTokens = limit
    },
    async "experimental.chat.image.transform"(input, output) {
      if (!providerIDs.includes(input.model.providerID)) return
      const useCdn = catalog.get(input.model.modelID)?.imageUseCdn ?? false
      log.info("applying wanqing image policy", {
        providerID: input.model.providerID,
        modelID: input.model.modelID,
        partID: output.part.id,
        image_use_cdn: useCdn,
        source: remoteImage(output.part.url) ? "remote" : "inline",
      })
      output.part = await materializeWanqingImage(output.part, useCdn)
    },
    async "chat.headers"(input, output) {
      if (!providerIDs.includes(input.model.providerID)) return
      output.headers[SESSION_HEADER] = input.sessionID
      output.headers[MESSAGE_HEADER] = input.message.id
      if (!matcher.isClaudeModel(input.model.id)) return
      const beta = options.anthropicBeta ?? DEFAULT_ANTHROPIC_BETA
      const key = Object.keys(output.headers).find((key) => key.toLowerCase() === "anthropic-beta") ?? "anthropic-beta"
      const current = output.headers[key]
      if (current?.includes("interleaved-thinking")) return
      output.headers[key] = current ? `${current},${beta}` : beta
    },
  }

  return { hooks, providerIDs }
}
