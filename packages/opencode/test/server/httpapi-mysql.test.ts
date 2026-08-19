import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const url = process.env.MYSQL_TEST_URL
const port = 42_000 + Math.floor(Math.random() * 1_000)
const base = `http://127.0.0.1:${port}`
const userId = `http-${crypto.randomUUID()}`
let server: ReturnType<typeof Bun.spawn> | undefined

describe.skipIf(!url)("MySQL HttpApi", () => {
  beforeAll(async () => {
    server = Bun.spawn(
      ["bun", "--conditions=browser", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        env: {
          ...process.env,
          MYSQL_URL: url!,
          OPENCODE_DB_DIALECT: "mysql",
          OPENCODE_DB: ":memory:",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
        },
        stdout: "ignore",
        stderr: "inherit",
      },
    )
    for (let index = 0; index < 150; index++) {
      try {
        if ((await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(500) })).ok) return
      } catch {
        // Server is still starting.
      }
      await Bun.sleep(100)
    }
    server.kill()
    await server.exited
    throw new Error("MySQL server failed to start")
  }, 30_000)

  afterAll(async () => {
    server?.kill(9)
    await server?.exited
  }, 30_000)

  test("persists scoped Session, Message, and Part while closing the V2 SQLite path", async () => {
    const createdResponse = await fetch(`${base}/session`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "mysql http integration" }),
    })
    expect(createdResponse.status).toBe(200)
    const created = (await createdResponse.json()) as { id: string }
    const eventResponse = await fetch(`${base}/event`, { headers: headers() })
    expect(eventResponse.status).toBe(200)
    const eventReader = eventResponse.body!.getReader()

    try {
      const promptResponse = await fetch(`${base}/session/${created.id}/message`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          noReply: true,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4o" },
          parts: [{ type: "text", text: "mysql persisted" }],
        }),
      })
      expect(promptResponse.status).toBe(200)
      const prompted = (await promptResponse.json()) as { info: { id: string } }

      expect(await readUntil(eventReader, "message.part.updated")).toContain(created.id)

      const messagesResponse = await fetch(`${base}/session/${created.id}/message`, { headers: headers() })
      expect(messagesResponse.status).toBe(200)
      const messages = (await messagesResponse.json()) as Array<{
        info: { id: string }
        parts: Array<{ text?: string }>
      }>
      expect(
        messages.some(
          (item) => item.info.id === prompted.info.id && item.parts.some((part) => part.text === "mysql persisted"),
        ),
      ).toBeTrue()

      const otherResponse = await fetch(`${base}/session`, {
        headers: { ...headers(), "x-opencode-user-id": `other-${crypto.randomUUID()}` },
      })
      expect(((await otherResponse.json()) as Array<{ id: string }>).some((item) => item.id === created.id)).toBeFalse()

      const disabled = await fetch(`${base}/api/session`, { headers: headers() })
      expect(disabled.status).toBe(503)
      expect(await disabled.json()).toMatchObject({ code: "CAPABILITY_DISABLED" })
    } finally {
      await eventReader.cancel()
      const removed = await fetch(`${base}/session/${created.id}`, { method: "DELETE", headers: headers() })
      expect(removed.status).toBe(200)
    }
  }, 30_000)
})

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, type: string) {
  const timeout = AbortSignal.timeout(10_000)
  const timedOut = new Promise<never>((_, reject) =>
    timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }),
  )
  const decoder = new TextDecoder()
  let content = ""
  while (!timeout.aborted) {
    const result = await Promise.race([reader.read(), timedOut])
    if (result.done) break
    content += decoder.decode(result.value, { stream: true })
    if (content.includes(type)) return content
  }
  throw new Error(`Timed out waiting for ${type}`)
}

function headers() {
  return {
    "content-type": "application/json",
    "x-opencode-user-id": userId,
    "x-opencode-owner-generation": "1",
    "x-request-id": crypto.randomUUID(),
    "x-opencode-run-id": crypto.randomUUID(),
  }
}
