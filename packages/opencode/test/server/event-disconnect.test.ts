import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { GlobalBus } from "@/bus/global"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// Bun's `node:http` layer does not emit "close" on the ServerResponse, so without the bridge in
// `serverLayer` a disconnected SSE client never interrupts its request fiber and every subscription
// the handler acquired stays registered for the lifetime of the process.
describe("event stream disconnect", () => {
  test("releases subscriptions when clients disconnect", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    delete process.env.OPENCODE_SERVER_PASSWORD
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const directory = (await tmpdir()).path
    const before = GlobalBus.listenerCount("event")

    const controllers = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const controller = new AbortController()
        const url = new URL("/event", listener.url)
        url.searchParams.set("directory", directory)
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "x-opencode-directory": directory },
        })
        // Read the first chunk so the stream is fully established before aborting.
        const reader = response.body!.getReader()
        await reader.read()
        reader.releaseLock()
        return controller
      }),
    )
    // The handler registers its subscription on the response fiber, slightly after the first chunk.
    const deadline = Date.now() + 10_000
    while (GlobalBus.listenerCount("event") < controllers.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(GlobalBus.listenerCount("event")).toBe(before + controllers.length)

    for (const controller of controllers) controller.abort()
    await Promise.race([
      (async () => {
        while (GlobalBus.listenerCount("event") > before) await new Promise((resolve) => setTimeout(resolve, 50))
      })(),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])
    expect(GlobalBus.listenerCount("event")).toBe(before)

    await listener.stop(true)
  }, 60_000)

  test("keeps serving requests with a body after the body is consumed", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    delete process.env.OPENCODE_SERVER_PASSWORD
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const directory = (await tmpdir()).path

    // Bun emits request "close" as soon as the body is read, so the bridge must not treat a
    // consumed body as a disconnect or every POST response would be destroyed before it is written.
    const url = new URL("/session", listener.url)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(4096) }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: expect.any(String) })

    await listener.stop(true)
  }, 60_000)
})
