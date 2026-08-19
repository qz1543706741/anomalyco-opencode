import { describe, expect, test } from "bun:test"
import { createLangfuseHooks, resolveUserID, sanitizeLangfuseInput } from "../src/langfuse"
import { createModelCatalog } from "../src/model-catalog"
import { createProviderObservability } from "../src/provider-observability"

describe("Langfuse plugin", () => {
  test("redacts media URLs and inline data", () => {
    expect(
      sanitizeLangfuseInput([
        { type: "file", url: "file:///private/image.png", mediaType: "image/png", filename: "image.png" },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
        { type: "media", mediaType: "image/png", data: "secret-bytes" },
      ]),
    ).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        filename: "image.png",
        redacted: true,
        urlKind: "file",
      },
      {
        type: "image_url",
        mediaType: undefined,
        filename: undefined,
        redacted: true,
        urlKind: "https",
      },
      {
        type: "media",
        mediaType: "image/png",
        filename: undefined,
        redacted: true,
        dataKind: "inline",
      },
    ])
  })

  test("missing credentials returns empty hooks without loading SDK", async () => {
    const hooks = await createLangfuseHooks(createModelCatalog(), createProviderObservability(), ["wanqing"], {
      publicKey: "",
      secretKey: "",
    })
    expect(hooks).toEqual({})
  })

  test("resolves user identity in compatibility order", () => {
    const input = {
      m0UserID: "m0-user",
      systemUser: "system-user",
      config: { userInfo: { userName: "config-user", mail: "config@example.com" } },
      projectID: "project",
      sessionID: "session",
    }
    expect(resolveUserID(input)).toBe("m0-user")
    expect(resolveUserID({ ...input, m0UserID: "" })).toBe("system-user")
    expect(resolveUserID({ ...input, m0UserID: "", systemUser: "" })).toBe("config-user")
    expect(
      resolveUserID({
        ...input,
        m0UserID: "",
        systemUser: "",
        config: { userInfo: { userName: "", mail: "config@example.com" } },
      }),
    ).toBe("config@example.com")
    expect(resolveUserID({ ...input, m0UserID: "", systemUser: "", config: {}, projectID: "" })).toBe("session")
  })

  test("tracks concurrent sessions and flushes on dispose", async () => {
    const requests: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push(await request.text())
        return Response.json({ success: true })
      },
    })
    try {
      const catalog = createModelCatalog()
      catalog.update({
        provider: {
          wanqing: {
            name: "Wanqing",
            models: {
              model: { name: "Gemini Test", limit: { context: 1000, output: 100 } },
            },
          },
        },
      } as never)
      const observability = createProviderObservability()
      const hooks = await createLangfuseHooks(catalog, observability, ["wanqing"], {
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
        baseUrl: server.url.toString(),
      })
      const callKeys = new Map<string, string>()

      for (const id of ["1", "2", "3", "4"]) {
        await hooks.event?.({
          event: {
            type: "session.created",
            properties: { info: { id: `session-${id}`, projectID: "project", title: `Session ${id}` } },
          } as never,
        })
        await hooks["chat.message"]?.(
          { sessionID: `session-${id}`, messageID: `user-${id}` } as never,
          { message: {}, parts: [{ type: "text", text: `question-${id}` }] } as never,
        )
        await hooks["chat.params"]?.(
          {
            sessionID: `session-${id}`,
            agent: "agent",
            model: { id: "model", providerID: "wanqing" },
            message: { id: `user-${id}` },
            messages: [{ role: "user", content: `question-${id}` }],
          } as never,
          { temperature: 1, topP: 1, topK: 1, maxOutputTokens: 100, options: {} },
        )
        const headers = { headers: {} as Record<string, string> }
        await hooks["chat.headers"]?.(
          {
            sessionID: `session-${id}`,
            model: { id: "model", providerID: "wanqing" },
            message: { id: `user-${id}` },
          } as never,
          headers,
        )
        callKeys.set(id, headers.headers["x-m0-call-key"]!)
      }
      expect(callKeys.get("1")).toBe("user-1:0")

      observability.emit({
        providerID: "wanqing",
        reqID: "request-1",
        sessionID: "session-1",
        userMsgID: "user-1",
        callKey: callKeys.get("1"),
        method: "POST",
        url: "https://wanqing.invalid/v1/chat",
        status: 200,
        requestHeaders: { authorization: "<redacted>" },
        responseHeaders: { "x-request-id": "remote-1" },
      })
      await Promise.resolve()

      await hooks["tool.execute.before"]?.(
        { sessionID: "session-1", callID: "tool-1", tool: "read" },
        { args: { file: "README.md" } },
      )
      await hooks["tool.execute.after"]?.(
        { sessionID: "session-1", callID: "tool-1", tool: "read", args: { file: "README.md" } },
        { title: "README", output: "contents", metadata: {} },
      )

      for (const id of ["2", "1"]) {
        await hooks.event?.({
          event: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "text",
                sessionID: `session-${id}`,
                messageID: `assistant-${id}`,
                text: `answer-${id}`,
              },
            },
          } as never,
        })
        await hooks.event?.({
          event: {
            type: "message.updated",
            properties: {
              info: {
                id: `assistant-${id}`,
                sessionID: `session-${id}`,
                parentID: `user-${id}`,
                role: "assistant",
                time: { created: 1, completed: 2 },
                tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } },
              },
            },
          } as never,
        })
      }

      await hooks.event?.({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-3",
              sessionID: "session-3",
              parentID: "user-3",
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              error: { name: "ProviderAuthError", data: { message: "denied" } },
            },
          },
        } as never,
      })

      await hooks.dispose?.()
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.join("\n")).toContain("answer-1")
      expect(requests.join("\n")).toContain("answer-2")
      expect(requests.join("\n")).toContain("tool-call-read")
      expect(requests.join("\n")).toContain("Gemini Test")
      expect(requests.join("\n")).toContain("https://wanqing.invalid/v1/chat")
      expect(requests.join("\n")).toContain("ProviderAuthError")
      expect(requests.join("\n")).toContain("plugin disposed")
    } finally {
      server.stop(true)
    }
  })
})
