import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk"
import type { Hooks } from "@opencode-ai/plugin"
import { homedir } from "os"
import { join } from "path"
import { createLogger } from "../logger"
import type { ModelCatalog } from "../model-catalog"
import type { ProviderHttpEvent, ProviderObservability } from "../provider-observability"
import { PromiseBridge } from "./bridge"

const DEFAULT_BASE_URL = "https://langfuse.corp.kuaishou.com/"

export type LangfusePluginOptions = {
  publicKey?: string
  secretKey?: string
  baseUrl?: string
  defaultTags?: string[]
  agentName?: string
  toolMaxRetries?: number
}

type UsageResult = {
  usage: {
    input: number
    output: number
    total: number
    unit: "TOKENS"
  }
  usageDetails: {
    cache_read: number
    cache_write: number
  }
  output?: string
  metadata?: Record<string, unknown>
}

type Observation = {
  end(input?: Record<string, unknown>): unknown
}

type Trace = {
  generation(input: Record<string, unknown>): Observation
  span(input: Record<string, unknown>): Observation
  event(input: Record<string, unknown>): unknown
  update(input: Record<string, unknown>): unknown
}

type LangfuseClient = {
  trace(input: Record<string, unknown>): Trace
  flushAsync(): Promise<void>
  shutdown?(): void | Promise<void>
  shutdownAsync?(): Promise<void>
}

type SessionMeta = {
  projectID: string
  title: string
}

type RoundState = {
  trace: Trace
  sessionID: string
  userMsgID: string
  toolCallIDs: Set<string>
  pendingLLMKeys: string[]
  llmCallCount: number
  lastAssistantText: string
  lastTextByMsgID: Map<string, string>
  resolvedAssistantIDs: Set<string>
  latestCallKey?: string
  httpTraceByCallKey: Map<string, Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "string" ? value[key] : undefined
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function nonEmpty(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function mediaKind(url: string) {
  if (url.startsWith("data:")) return "data"
  try {
    return new URL(url).protocol.replace(":", "") || "unknown"
  } catch {
    return "unknown"
  }
}

function redactMedia(value: Record<string, unknown>) {
  const type = stringValue(value, "type")
  const imageUrl = value.image_url
  const url =
    stringValue(value, "url") ??
    stringValue(value, "image") ??
    (typeof imageUrl === "string" ? imageUrl : undefined) ??
    (isRecord(imageUrl) ? stringValue(imageUrl, "url") : undefined)
  if (!["file", "media", "image", "image_url"].includes(type ?? "")) return
  return {
    type,
    mediaType: stringValue(value, "mediaType") ?? stringValue(value, "mime"),
    filename: stringValue(value, "filename"),
    redacted: true,
    ...(url ? { urlKind: mediaKind(url) } : {}),
    ...(typeof value.data === "string" ? { dataKind: "inline" } : {}),
  }
}

export function sanitizeLangfuseInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLangfuseInput)
  if (!isRecord(value)) return value
  const redacted = redactMedia(value)
  if (redacted) return redacted
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeLangfuseInput(item)]))
}

function stringify(value: unknown) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function openaiMessages(messages: unknown) {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message): Record<string, unknown>[] => {
    if (!isRecord(message)) return []
    const role = stringValue(message, "role") ?? "user"
    const content = message.content
    if (role === "tool") {
      return (Array.isArray(content) ? content : [content]).flatMap((part) =>
        isRecord(part)
          ? [
              {
                role: "tool",
                tool_call_id: stringValue(part, "toolCallId") ?? stringValue(part, "toolCallID") ?? "",
                content: stringify(part.output ?? part.result ?? part.value),
              },
            ]
          : [],
      )
    }
    if (role !== "assistant" || !Array.isArray(content)) return [{ role, content }]

    const text: unknown[] = []
    const toolCalls: Record<string, unknown>[] = []
    for (const part of content) {
      if (!isRecord(part)) continue
      if (part.type === "tool-call") {
        toolCalls.push({
          id: stringValue(part, "toolCallId") ?? stringValue(part, "toolCallID") ?? "",
          type: "function",
          function: {
            name: stringValue(part, "toolName") ?? "",
            arguments: stringify(part.input ?? part.args ?? {}),
          },
        })
        continue
      }
      text.push(part)
    }
    return [
      {
        role,
        content: text.length === 1 && isRecord(text[0]) && text[0].type === "text" ? text[0].text : text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    ]
  })
}

function extractText(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function realTitle(title: string | null | undefined) {
  if (!title || title.startsWith("New session")) return ""
  return title
}

function usage(info: AssistantMessage): UsageResult {
  const input = safeNumber(info.tokens.input)
  const cacheRead = safeNumber(info.tokens.cache.read)
  const cacheWrite = safeNumber(info.tokens.cache.write)
  const output = safeNumber(info.tokens.output) + safeNumber(info.tokens.reasoning)
  return {
    usage: {
      input: input + cacheRead + cacheWrite,
      output,
      total: input + cacheRead + cacheWrite + output,
      unit: "TOKENS",
    },
    usageDetails: {
      cache_read: cacheRead,
      cache_write: cacheWrite,
    },
  }
}

function assistantError(info: AssistantMessage) {
  if (!info.error) return
  return new Error(`${info.error.name}: ${JSON.stringify(isRecord(info.error.data) ? info.error.data : {})}`)
}

function toolError(output: { output: string; metadata: unknown }) {
  if (!isRecord(output.metadata)) return
  if (output.metadata.success === false || "error" in output.metadata) {
    return new Error(output.output || stringify(output.metadata.error) || "tool execution failed")
  }
}

function toolCategory(tool: string) {
  if (/(read|write|edit|patch|glob|grep|ls|bash|shell|exec|run)/.test(tool)) return "compute"
  if (/(search|find|web)/.test(tool)) return "search"
  if (/(fetch|http|api)/.test(tool)) return "api"
  if (/(db|sql|query)/.test(tool)) return "database"
  return "other"
}

export function resolveUserID(input: {
  m0UserID?: string
  systemUser?: string
  config?: unknown
  projectID: string
  sessionID: string
}) {
  const userInfo = isRecord(input.config) && isRecord(input.config.userInfo) ? input.config.userInfo : undefined
  return (
    (nonEmpty(input.m0UserID) ??
      nonEmpty(input.systemUser) ??
      (userInfo ? (nonEmpty(userInfo.userName) ?? nonEmpty(userInfo.mail)) : undefined) ??
      input.projectID) ||
    input.sessionID
  )
}

async function loadUser(projectID: string, sessionID: string) {
  const envUser = process.env.M0_USER_ID?.trim() || process.env.USER?.trim()
  if (envUser) return envUser
  const config = await Bun.file(join(homedir(), ".m0", "config.json"))
    .json()
    .catch(() => undefined)
  return resolveUserID({ config, projectID, sessionID })
}

export async function createLangfuseHooks(
  catalog: ModelCatalog,
  observability: ProviderObservability,
  providerIDs: string[],
  options: LangfusePluginOptions = {},
): Promise<Hooks> {
  const log = createLogger({ service: "m0.langfuse" })
  const publicKey = options.publicKey ?? process.env.M0_KLangfuse_PUBLIC_KEY
  const secretKey = options.secretKey ?? process.env.M0_KLangfuse_SECRET_KEY
  if (!publicKey || !secretKey) return {}

  const module = (await import("langfuse")) as unknown as {
    Langfuse: new (options: Record<string, unknown>) => LangfuseClient
  }
  const client = new module.Langfuse({
    publicKey,
    secretKey,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
  })
  const sessions = new Map<string, SessionMeta>()
  const rounds = new Map<string, RoundState>()
  const roundBySession = new Map<string, string>()
  const queryByMessage = new Map<string, string>()
  const toolBridge = new PromiseBridge<string>()
  const llmBridge = new PromiseBridge<UsageResult>()
  const pending = new Set<Promise<void>>()

  function rejectRound(round: RoundState, message: string) {
    for (const callID of round.toolCallIDs) toolBridge.reject(callID, new Error(message))
    round.toolCallIDs.clear()
    for (const callKey of round.pendingLLMKeys) llmBridge.reject(callKey, new Error(message))
    round.pendingLLMKeys.length = 0
  }

  function finishRound(round: RoundState, success: boolean, answer?: string) {
    rejectRound(round, success ? "round ended" : "round failed")
    try {
      round.trace.update({
        output: { answer: answer ?? (round.lastAssistantText || (success ? "round ended" : "round failed")) },
        metadata: { success },
      })
    } catch (error) {
      log.warn("trace completion failed", { sessionID: round.sessionID, error })
    }
  }

  function startGeneration(
    round: RoundState,
    input: Parameters<NonNullable<Hooks["chat.params"]>>[0],
    output: Parameters<NonNullable<Hooks["chat.params"]>>[1],
    callKey: string,
  ) {
    const generation = round.trace.generation({
      name: `llm-generation-${input.agent}/${input.model.id}`,
      model: catalog.get(input.model.id)?.displayName ?? input.model.id,
      input: {
        messages: sanitizeLangfuseInput(openaiMessages(input.messages)),
        maxTokens: output.maxOutputTokens,
        topP: output.topP,
      },
      metadata: { call_key: callKey, call_sequence: round.llmCallCount },
    })
    const task = llmBridge
      .create(callKey)
      .then((result) => generation.end(result))
      .catch((error) =>
        generation.end({
          level: "ERROR",
          statusMessage: errorMessage(error),
          metadata: isRecord(error) && isRecord(error.metadata) ? error.metadata : undefined,
        }),
      )
      .catch((error) => log.warn("generation completion failed", { callKey, error }))
      .then(() => undefined)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  function startTool(
    round: RoundState,
    input: Parameters<NonNullable<Hooks["tool.execute.before"]>>[0],
    args: unknown,
  ) {
    const span = round.trace.span({
      name: `tool-call-${input.tool}`,
      input: { tool_name: input.tool, parameters: sanitizeLangfuseInput(args) },
      metadata: {
        call_id: input.callID,
        tool_category: toolCategory(input.tool),
        max_retries: options.toolMaxRetries ?? 1,
      },
    })
    const task = toolBridge
      .create(input.callID)
      .then((output) => span.end({ output }))
      .catch((error) => span.end({ level: "ERROR", statusMessage: errorMessage(error) }))
      .catch((error) => log.warn("tool completion failed", { callID: input.callID, error }))
      .then(() => undefined)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  async function handleProviderHttp(event: ProviderHttpEvent) {
    if (!event.userMsgID) return
    const round = rounds.get(event.userMsgID)
    if (!round) return
    const trace = {
      providerID: event.providerID,
      reqID: event.reqID,
      sessionID: event.sessionID,
      method: event.method,
      url: event.url,
      status: event.status,
      requestHeaders: event.requestHeaders,
      responseHeaders: event.responseHeaders,
      error: event.error,
    }
    if (event.callKey) {
      round.httpTraceByCallKey.set(event.callKey, trace)
      return
    }
    round.trace.event({ name: "provider_http", metadata: trace })
  }

  const unsubscribe = observability.subscribe((event) =>
    handleProviderHttp(event).catch((error) => log.warn("provider HTTP handler failed", { error })),
  )

  async function handleEvent(event: Event) {
    if (event.type === "session.created") {
      sessions.set(event.properties.info.id, {
        projectID: event.properties.info.projectID,
        title: realTitle(event.properties.info.title),
      })
      return
    }
    if (event.type === "session.updated") {
      const session = sessions.get(event.properties.info.id)
      const title = realTitle(event.properties.info.title)
      if (session && title) session.title = title
      return
    }
    if (event.type === "session.deleted") {
      const userMsgID = roundBySession.get(event.properties.info.id)
      const round = userMsgID ? rounds.get(userMsgID) : undefined
      if (round) finishRound(round, true)
      if (userMsgID) {
        rounds.delete(userMsgID)
        queryByMessage.delete(userMsgID)
      }
      roundBySession.delete(event.properties.info.id)
      sessions.delete(event.properties.info.id)
      return
    }
    if (event.type === "session.error") {
      const sessionID = event.properties.sessionID
      const userMsgID = sessionID ? roundBySession.get(sessionID) : undefined
      const round = userMsgID ? rounds.get(userMsgID) : undefined
      if (!round || !userMsgID || !sessionID) return
      finishRound(round, false, "session error")
      rounds.delete(userMsgID)
      roundBySession.delete(sessionID)
      queryByMessage.delete(userMsgID)
      return
    }
    if (event.type === "session.compacted") {
      const userMsgID = roundBySession.get(event.properties.sessionID)
      const round = userMsgID ? rounds.get(userMsgID) : undefined
      round?.trace.event({ name: "context_compacted", metadata: { sessionID: event.properties.sessionID } })
      return
    }
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.type !== "text" || !part.text) return
      const userMsgID = roundBySession.get(part.sessionID)
      const round = userMsgID ? rounds.get(userMsgID) : undefined
      if (!round) return
      round.lastAssistantText = part.text
      round.lastTextByMsgID.set(part.messageID, part.text)
      return
    }
    if (event.type !== "message.updated" || event.properties.info.role !== "assistant") return
    if (!event.properties.info.time.completed) return
    const info = event.properties.info
    const round = rounds.get(info.parentID)
    if (!round || round.resolvedAssistantIDs.has(info.id)) return
    round.resolvedAssistantIDs.add(info.id)
    const callKey = round.pendingLLMKeys.shift()
    if (!callKey) return
    const error = assistantError(info)
    const httpTrace = round.httpTraceByCallKey.get(callKey)
    round.httpTraceByCallKey.delete(callKey)
    if (error) {
      if (httpTrace) Object.assign(error, { metadata: { http_trace: httpTrace } })
      llmBridge.reject(callKey, error)
      return
    }
    const result = usage(info)
    result.output = round.lastTextByMsgID.get(info.id) ?? round.lastAssistantText
    if (httpTrace) result.metadata = { http_trace: httpTrace }
    llmBridge.resolve(callKey, result)
  }

  return {
    async event(input) {
      await handleEvent(input.event).catch((error) => log.warn("event handler failed", { error }))
    },
    async "chat.message"(input, output) {
      if (!input.messageID) return
      const session = sessions.get(input.sessionID) ?? { projectID: "", title: "" }
      sessions.set(input.sessionID, session)
      const previousID = roundBySession.get(input.sessionID)
      if (previousID && previousID !== input.messageID) {
        const previous = rounds.get(previousID)
        if (previous) finishRound(previous, true)
        rounds.delete(previousID)
        queryByMessage.delete(previousID)
      }
      queryByMessage.set(input.messageID, extractText(output.parts) || session.title)
    },
    async "chat.params"(input, output) {
      const userMsgID = input.message.id
      let round = rounds.get(userMsgID)
      if (!round) {
        const session = sessions.get(input.sessionID) ?? { projectID: "", title: "" }
        sessions.set(input.sessionID, session)
        round = {
          trace: client.trace({
            name: catalog.get(input.model.id)?.displayName ?? input.model.id,
            userId: await loadUser(session.projectID, input.sessionID),
            sessionId: input.sessionID,
            input: queryByMessage.get(userMsgID) || session.title,
            tags: [
              ...(options.defaultTags ?? []),
              `modelId:${input.model.id}`,
              `agentName:${options.agentName ?? input.agent}`,
            ],
          }),
          sessionID: input.sessionID,
          userMsgID,
          toolCallIDs: new Set(),
          pendingLLMKeys: [],
          llmCallCount: 0,
          lastAssistantText: "",
          lastTextByMsgID: new Map(),
          resolvedAssistantIDs: new Set(),
          httpTraceByCallKey: new Map(),
        }
        rounds.set(userMsgID, round)
        roundBySession.set(input.sessionID, userMsgID)
      }
      const callKey = `${userMsgID}:${round.llmCallCount++}`
      round.latestCallKey = callKey
      round.pendingLLMKeys.push(callKey)
      startGeneration(round, input, output, callKey)
    },
    async "chat.headers"(input, output) {
      if (!providerIDs.includes(input.model.providerID)) return
      const round = rounds.get(input.message.id)
      if (round?.latestCallKey) output.headers["x-m0-call-key"] = round.latestCallKey
    },
    async "tool.execute.before"(input, output) {
      const userMsgID = roundBySession.get(input.sessionID)
      const round = userMsgID ? rounds.get(userMsgID) : undefined
      if (!round || round.toolCallIDs.has(input.callID)) return
      round.toolCallIDs.add(input.callID)
      startTool(round, input, output.args)
    },
    async "tool.execute.after"(input, output) {
      const userMsgID = roundBySession.get(input.sessionID)
      const round = userMsgID ? rounds.get(userMsgID) : undefined
      if (!round) return
      round.toolCallIDs.delete(input.callID)
      const error = toolError(output)
      if (error) {
        toolBridge.reject(input.callID, error)
        return
      }
      toolBridge.resolve(input.callID, output.output)
    },
    async dispose() {
      unsubscribe()
      for (const round of rounds.values()) finishRound(round, false, "plugin disposed")
      toolBridge.rejectAll(new Error("plugin disposed"))
      llmBridge.rejectAll(new Error("plugin disposed"))
      rounds.clear()
      roundBySession.clear()
      queryByMessage.clear()
      sessions.clear()
      await Promise.allSettled(pending)
      await Promise.resolve()
        .then(() => client.flushAsync())
        .catch((error) => log.warn("flush failed", { error }))
      await Promise.resolve()
        .then(() => client.shutdownAsync?.() ?? client.shutdown?.())
        .catch((error) => log.warn("shutdown failed", { error }))
    },
  }
}
