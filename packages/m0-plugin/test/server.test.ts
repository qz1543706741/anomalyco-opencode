import { expect, test } from "bun:test"
import { createProviderObservability } from "../src/provider-observability"
import { M0Plugin } from "../src/server"

function pluginInput(log: (entry: unknown) => Promise<unknown> = async () => ({})) {
  return { client: { app: { log } } } as never
}

test("modules can be disabled independently", async () => {
  const entries: unknown[] = []
  const hooks = await M0Plugin(
    pluginInput(async (entry) => {
      entries.push(entry)
      return {}
    }),
    { wanqing: false, langfuse: false, messageTransform: false },
  )
  expect(hooks.config).toBeFunction()
  expect(hooks["chat.params"]).toBeFunction()
  expect(entries).toEqual([
    {
      body: {
        service: "m0.plugin",
        level: "info",
        message: "@m0/opencode-plugin initialized",
        extra: { wanqing: false, langfuse: false, messageTransform: false },
      },
    },
  ])
  await hooks.dispose?.()
})

test("isolates provider observation listener failures", async () => {
  const observability = createProviderObservability()
  let received = false
  observability.subscribe(() => {
    throw new Error("listener failed")
  })
  observability.subscribe(() => {
    received = true
  })
  observability.emit({
    providerID: "wanqing",
    reqID: "request",
    method: "POST",
    url: "https://wanqing.invalid",
    status: 200,
    responseHeaders: {},
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(received).toBe(true)
})

test("runs Wanqing params before Langfuse observes final params", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.text())
      return Response.json({ success: true })
    },
  })
  try {
    const hooks = await M0Plugin(pluginInput(), {
      langfuse: {
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
        baseUrl: server.url.toString(),
      },
    })
    await hooks.config?.({
      provider: {
        wanqing: {
          name: "Wanqing",
          models: { model: { name: "GPT Test", limit: { context: 1000, output: 100 } } },
        },
      },
    } as never)
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "session", projectID: "project", title: "Session" } },
      } as never,
    })
    await hooks["chat.message"]?.(
      { sessionID: "session", messageID: "user" } as never,
      { message: {}, parts: [{ type: "text", text: "question" }] } as never,
    )
    const output = { temperature: 1, topP: 1, topK: 1, maxOutputTokens: 10, options: {} }
    await hooks["chat.params"]?.(
      {
        sessionID: "session",
        agent: "agent",
        model: { id: "model", providerID: "wanqing" },
        message: { id: "user" },
        messages: [{ role: "user", content: "question" }],
      } as never,
      output,
    )
    expect(output.maxOutputTokens).toBe(100)
    await hooks.dispose?.()
    expect(requests.join("\n")).toContain('"maxTokens":100')
  } finally {
    server.stop(true)
  }
})
