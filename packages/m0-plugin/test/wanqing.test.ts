import { describe, expect, test } from "bun:test"
import type { Config, Hooks } from "@opencode-ai/plugin"
import { createModelCatalog } from "../src/model-catalog"
import { createProviderObservability, type ProviderHttpEvent } from "../src/provider-observability"
import { createWanqingHooks } from "../src/wanqing"
import { createDeepseekAdapter } from "../src/wanqing/deepseek"
import type { DeepseekRequestBody } from "../src/wanqing/deepseek/types"
import { createSchemaSanitizerAdapter } from "../src/wanqing/gemini/request-adapters"
import { createGeminiAdapter } from "../src/wanqing/gemini"
import type { GeminiRequestBody } from "../src/wanqing/gemini/types"
import { createGptAdapter } from "../src/wanqing/gpt"
import type { GptRequestBody } from "../src/wanqing/gpt/types"
import { createMergeAssistantAdapter } from "../src/wanqing/merge-assistant"

function config(
  name: string,
  output = 8192,
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return {
    provider: {
      wanqing: {
        name: "Wanqing",
        options: fetch ? { fetch } : {},
        models: {
          model: {
            name,
            limit: { context: 100_000, output },
          },
        },
      },
    },
  } as unknown as Config
}

function chatInput() {
  return {
    sessionID: "session",
    agent: "agent",
    model: { id: "model", providerID: "wanqing" },
    provider: { source: "config", info: {}, options: {} },
    message: { id: "message" },
  } as unknown as Parameters<NonNullable<Hooks["chat.params"]>>[0]
}

describe("Wanqing plugin", () => {
  test("applies model limit and Claude beta", async () => {
    const catalog = createModelCatalog()
    catalog.update(config("Claude Sonnet", 4096))
    const wanqing = createWanqingHooks(catalog, createProviderObservability())
    const output = { temperature: 1, topP: 1, topK: 1, maxOutputTokens: 2048, options: {} }
    await wanqing.hooks["chat.params"]!(chatInput(), output)
    expect(output.maxOutputTokens).toBe(4096)

    const headers = { headers: {} as Record<string, string> }
    await wanqing.hooks["chat.headers"]!(chatInput(), headers)
    expect(headers.headers["anthropic-beta"]).toContain("interleaved-thinking")
    expect(headers.headers["x-m0-session-id"]).toBe("session")
    expect(headers.headers["x-m0-message-id"]).toBe("message")
  })

  test("leaves unmatched providers and invalid limits unchanged", async () => {
    const catalog = createModelCatalog()
    catalog.update(config("Claude Sonnet", -1))
    const hooks = createWanqingHooks(catalog, createProviderObservability()).hooks
    const output = { temperature: 1, topP: 1, topK: 1, maxOutputTokens: 2048, options: {} }
    const input = {
      ...chatInput(),
      model: { ...chatInput().model, providerID: "other" },
    } as Parameters<NonNullable<Hooks["chat.params"]>>[0]
    await hooks["chat.params"]!(input, output)
    expect(output.maxOutputTokens).toBe(2048)

    const headers = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(input, headers)
    expect(headers.headers).toEqual({})
  })

  test("does not duplicate case-insensitive Anthropic beta", async () => {
    const catalog = createModelCatalog()
    catalog.update(config("Claude Sonnet"))
    const hooks = createWanqingHooks(catalog, createProviderObservability()).hooks
    const headers = { headers: { "Anthropic-Beta": "existing,interleaved-thinking" } as Record<string, string> }
    await hooks["chat.headers"]!(chatInput(), headers)
    expect(headers.headers["Anthropic-Beta"]).toBe("existing,interleaved-thinking")
    expect(headers.headers["anthropic-beta"]).toBeUndefined()
  })

  test("delegates to existing fetch, strips internal headers, adapts body, and tees stream", async () => {
    let remoteHeaders = new Headers()
    let remoteBody = ""
    const baseFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      remoteHeaders = new Headers(init?.headers)
      remoteBody = String(init?.body)
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "x-response": "ok" } })
    }
    const cfg = config("Gemini 2.5 Pro", 8192, baseFetch)
    const catalog = createModelCatalog()
    catalog.update(cfg)
    const observability = createProviderObservability()
    const events: ProviderHttpEvent[] = []
    observability.subscribe((event) => {
      events.push(event)
    })
    const wanqing = createWanqingHooks(catalog, observability)
    await wanqing.hooks.config!(cfg)
    const wrapped = cfg.provider?.wanqing?.options?.fetch as typeof baseFetch
    const response = await wrapped("https://wanqing.invalid/v1/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-m0-session-id": "session",
        "x-m0-message-id": "message",
        "x-m0-call-key": "call",
      },
      body: JSON.stringify({
        model: "model",
        tools: [{ function: { parameters: { type: "object", properties: { value: { const: 1 } } } } }],
      }),
    })

    expect(await response.text()).toBe("data: [DONE]\n\n")
    expect(remoteHeaders.has("x-m0-session-id")).toBe(false)
    expect(remoteHeaders.has("x-m0-message-id")).toBe(false)
    expect(remoteHeaders.has("x-m0-call-key")).toBe(false)
    expect(JSON.parse(remoteBody).tools[0].function.parameters.properties.value).toEqual({
      description: "Must equal 1.",
    })
    expect(events[0]).toMatchObject({
      providerID: "wanqing",
      sessionID: "session",
      userMsgID: "message",
      callKey: "call",
      status: 200,
    })
  })

  test("config wrapping is idempotent", async () => {
    const baseFetch = async () => new Response("ok")
    const cfg = config("GPT-5", 8192, baseFetch)
    const catalog = createModelCatalog()
    catalog.update(cfg)
    const hooks = createWanqingHooks(catalog, createProviderObservability()).hooks
    await hooks.config!(cfg)
    const first = cfg.provider?.wanqing?.options?.fetch
    await hooks.config!(cfg)
    expect(cfg.provider?.wanqing?.options?.fetch).toBe(first)
  })

  test("leaves Responses API body untouched by chat/completions adapters", async () => {
    let remoteBody = ""
    const baseFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      remoteBody = String(init?.body)
      return new Response("ok")
    }
    const cfg = config("GPT 5.5", 8192, baseFetch)
    const catalog = createModelCatalog()
    catalog.update(cfg)
    const hooks = createWanqingHooks(catalog, createProviderObservability()).hooks
    await hooks.config!(cfg)
    const wrapped = cfg.provider?.wanqing?.options?.fetch as typeof baseFetch
    // Responses body: `input` + `max_output_tokens`, no `messages`/`max_tokens`.
    const responsesBody = {
      model: "model",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 123,
      reasoning: { effort: "high" },
    }
    await wrapped("https://wanqing.invalid/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody),
    })
    expect(JSON.parse(remoteBody)).toEqual(responsesBody)
  })

  test("strips internal headers from Request input", async () => {
    let remoteHeaders = new Headers()
    const baseFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      remoteHeaders = new Headers(init?.headers)
      return new Response("ok")
    }
    const cfg = config("GPT-5", 8192, baseFetch)
    const catalog = createModelCatalog()
    catalog.update(cfg)
    const hooks = createWanqingHooks(catalog, createProviderObservability()).hooks
    await hooks.config!(cfg)
    const wrapped = cfg.provider?.wanqing?.options?.fetch as typeof baseFetch
    await wrapped(
      new Request("https://wanqing.invalid/v1/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-m0-session-id": "session",
          "x-m0-message-id": "message",
          "x-m0-call-key": "call",
        },
        body: JSON.stringify({ model: "model" }),
      }),
    )
    expect(remoteHeaders.has("x-m0-session-id")).toBe(false)
    expect(remoteHeaders.has("x-m0-message-id")).toBe(false)
    expect(remoteHeaders.has("x-m0-call-key")).toBe(false)
  })

  test("uses native fetch redirect, gzip, abort, and stream semantics", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/redirect") return Response.redirect(new URL("/final", request.url), 302)
        if (path === "/gzip") {
          return new Response(Bun.gzipSync(new TextEncoder().encode("compressed")), {
            headers: { "content-encoding": "gzip" },
          })
        }
        return new Response("redirected")
      },
    })
    try {
      const cfg = config("GPT-5")
      const catalog = createModelCatalog()
      catalog.update(cfg)
      const hooks = createWanqingHooks(catalog, createProviderObservability()).hooks
      await hooks.config!(cfg)
      const wrapped = cfg.provider?.wanqing?.options?.fetch as typeof globalThis.fetch

      expect(await (await wrapped(new URL("/redirect", server.url))).text()).toBe("redirected")
      expect(await (await wrapped(new URL("/gzip", server.url))).text()).toBe("compressed")

      const controller = new AbortController()
      controller.abort()
      await expect(wrapped(new URL("/final", server.url), { signal: controller.signal })).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })

  test("propagates base fetch stream interruption", async () => {
    const baseFetch = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"))
            controller.error(new Error("broken stream"))
          },
        }),
      )
    const cfg = config("GPT-5", 8192, baseFetch)
    const catalog = createModelCatalog()
    catalog.update(cfg)
    const hooks = createWanqingHooks(catalog, createProviderObservability()).hooks
    await hooks.config!(cfg)
    const wrapped = cfg.provider?.wanqing?.options?.fetch as typeof baseFetch
    await expect((await wrapped("https://wanqing.invalid")).text()).rejects.toThrow("broken stream")
  })

  test("preserves Gemini schema, DeepSeek thinking, and assistant merge adapters", () => {
    const gemini: GeminiRequestBody = {
      tools: [{ function: { parameters: { type: "object", properties: { version: { const: 1 } } } } }],
    }
    createSchemaSanitizerAdapter().prepareRequest?.(gemini, { providerID: "wanqing" })
    expect(gemini.tools?.[0]?.function?.parameters).toEqual({
      type: "object",
      properties: { version: { description: "Must equal 1." } },
    })

    const deepseek: DeepseekRequestBody = {
      model: "model",
      temperature: 0.5,
      messages: [
        { role: "assistant", content: "one" },
        { role: "assistant", content: "two" },
      ],
    }
    createMergeAssistantAdapter<DeepseekRequestBody>().prepareRequest?.(deepseek, { providerID: "wanqing" })
    createDeepseekAdapter().prepareRequest(deepseek, { providerID: "wanqing" })
    expect(deepseek.messages).toEqual([
      { role: "assistant", content: "one\n\ntwo" },
      { role: "user", content: "Continue." },
    ])
    expect(deepseek.extra_body).toEqual({ thinking: { type: "enabled" } })
    expect(deepseek.temperature).toBeUndefined()
  })

  test("preserves GPT token and Gemini thought-signature adapters", async () => {
    const gpt: GptRequestBody = { model: "model", max_tokens: 123 }
    createGptAdapter().prepareRequest(gpt, { providerID: "wanqing" })
    expect(gpt).toEqual({ model: "model", max_completion_tokens: 123 })

    const gemini = createGeminiAdapter()
    await gemini.extractFromStream(
      new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ id: "tool-1", extra_content: { google: { thought_signature: "signature" } } }],
              },
            },
          ],
        })}\n\n`,
      ).body!,
    )
    const body: GeminiRequestBody = {
      messages: [{ role: "assistant", tool_calls: [{ id: "tool-1" }] }],
    }
    gemini.prepareRequest(body, { providerID: "wanqing-online-reasoning" })
    expect(body.messages?.[0]?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe("signature")
    expect(body.extra_body?.google?.thinking_config).toEqual({
      include_thoughts: true,
      thinking_level: "high",
    })
  })

  test("preserves Gemini thought signatures split across stream deltas", async () => {
    const gemini = createGeminiAdapter()
    await gemini.extractFromStream(
      new Response(
        [
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 4, id: "tool-1" }] } }],
          })}`,
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 4, extra_content: { google: { thought_signature: "split-signature" } } }],
                },
              },
            ],
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
      ).body!,
    )
    const body: GeminiRequestBody = {
      messages: [{ role: "assistant", tool_calls: [{ id: "tool-1" }] }],
    }
    gemini.prepareRequest(body, { providerID: "wanqing-online-reasoning" })
    expect(body.messages?.[0]?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe("split-signature")
  })

  test("rewrites Gemini thought deltas into reasoning_content", async () => {
    const gemini = createGeminiAdapter()
    const frame = {
      choices: [
        {
          delta: {
            content: "先分析布局",
            extra_content: { google: { thought: true, thought_signature: "sig-1" } },
          },
        },
      ],
    }
    const source = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`
    const output = await new Response(gemini.transformStream(new Response(source).body!)).text()

    expect(output).toContain('"reasoning_content":"先分析布局"')
    expect(output).toContain('"content":null')
    expect(output).toContain('"thought_signature":"sig-1"')
    expect(output).toContain("data: [DONE]")
  })

  test("maps string thought deltas and leaves plain content untouched", async () => {
    const gemini = createGeminiAdapter()
    const source = [
      `data: ${JSON.stringify({ choices: [{ delta: { extra_content: { google: { thought: "推理" } } } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文" } }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n")
    const output = await new Response(gemini.transformStream(new Response(source).body!)).text()

    expect(output).toContain('"reasoning_content":"推理"')
    expect(output).toContain('"content":"正文"')
  })
})
