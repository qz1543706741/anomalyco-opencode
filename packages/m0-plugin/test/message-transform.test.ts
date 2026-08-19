import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk"
import { createMessageTransformHooks, summarizeLLMMessages } from "../src/message-transform"

const sessionID = "session"

function assistantInfo(id: string): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID: "parent",
    modelID: "model",
    providerID: "provider",
    mode: "",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
}

function userInfo(id: string): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "agent",
    model: { providerID: "provider", modelID: "model" },
  }
}

function basePart(messageID: string, id: string) {
  return {
    id,
    sessionID,
    messageID,
  }
}

async function transform(messages: Parameters<Required<Hooks>["experimental.chat.messages.transform"]>[1]["messages"]) {
  const hooks = createMessageTransformHooks()
  await hooks["experimental.chat.messages.transform"]?.({}, { messages })
  return messages
}

describe("m0 message transform plugin", () => {
  test("logs original image CDN placeholders without exposing other URLs or image payloads", () => {
    const base64 = "a".repeat(300)
    const messages = summarizeLLMMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "docs: https://docs.example.com/private?token=redacted" },
          { type: "text", text: "[Image CDN: https://cdn.example.com/image.png?token=original]" },
          { type: "file", mediaType: "image/png", data: base64 },
          { type: "image", image: `data:image/png;base64,${base64}` },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "get_screenshot",
            output: {
              type: "text",
              value: '{"1:7":"https://cdn.example.com/screenshot.png?token=original"}',
            },
          },
        ],
      },
    ])
    const output = JSON.stringify(messages)

    expect(output).toContain("docs: <url:docs.example.com>")
    expect(output).toContain("[Image CDN: <url:https://cdn.example.com/image.png?token=original>]")
    expect(output).toContain("<url:https://cdn.example.com/screenshot.png?token=original>")
    expect(output).toContain("<inline-media chars=300>")
    expect(output).toContain("<inline-data-url chars=322>")
    expect(output).not.toContain("token=redacted")
    expect(output).not.toContain(base64)
  })

  test("removes empty assistant text parts", async () => {
    const messages = await transform([
      {
        info: assistantInfo("assistant"),
        parts: [
          { ...basePart("assistant", "empty"), type: "text", text: "" },
          { ...basePart("assistant", "text"), type: "text", text: "hello" },
        ],
      },
    ])

    expect(messages[0].parts).toEqual([{ ...basePart("assistant", "text"), type: "text", text: "hello" }])
  })

  test("preserves assistant empty text when Anthropic signed reasoning is present", async () => {
    const messages = await transform([
      {
        info: assistantInfo("assistant"),
        parts: [
          {
            ...basePart("assistant", "reasoning"),
            type: "reasoning",
            text: "thinking",
            metadata: { anthropic: { signature: "sig" } },
            time: { start: 0 },
          },
          { ...basePart("assistant", "empty"), type: "text", text: "" },
        ],
      },
    ])

    expect(messages[0].parts).toHaveLength(2)
  })

  test("leaves user empty text parts alone", async () => {
    const messages = await transform([
      {
        info: userInfo("user"),
        parts: [{ ...basePart("user", "empty"), type: "text", text: "" }],
      },
    ])

    expect(messages[0].parts).toHaveLength(1)
  })

  test("removes older tool attachments while preserving CDN output", async () => {
    const messages = await transform(
      Array.from({ length: 5 }, (_, index) => ({
        info: assistantInfo(`assistant-${index}`),
        parts: [
          {
            ...basePart(`assistant-${index}`, `tool-${index}`),
            type: "tool" as const,
            callID: `call-${index}`,
            tool: "get_screenshot",
            state: {
              status: "completed" as const,
              input: { nodeId: `${index}:1` },
              output: JSON.stringify({ [`${index}:1`]: `https://cdn.example.com/image-${index}.png` }),
              title: "Screenshot",
              metadata: {},
              time: { start: index, end: index + 1 },
              attachments: [
                {
                  ...basePart(`assistant-${index}`, `image-${index}`),
                  type: "file" as const,
                  mime: "image/png",
                  filename: `image-${index}.png`,
                  url: `data:image/png;base64,aW1hZ2Ut${index}`,
                },
              ],
            },
          },
        ],
      })),
    )
    const oldest = messages[0].parts[0]
    const latest = messages[4].parts[0]
    const attachments = messages
      .flatMap((message) => message.parts)
      .flatMap((part) =>
        part.type === "tool" && part.state.status === "completed" ? (part.state.attachments ?? []) : [],
      )

    expect(attachments).toHaveLength(4)
    expect(oldest).toMatchObject({
      state: {
        output: '{"0:1":"https://cdn.example.com/image-0.png"}',
        attachments: [],
      },
    })
    expect(latest).toMatchObject({
      state: {
        output: '{"4:1":"https://cdn.example.com/image-4.png"}',
        attachments: [{ filename: "image-4.png" }],
      },
    })
  })

  test("shares image limit with user attachments across turns", async () => {
    const messages = await transform(
      Array.from({ length: 5 }, (_, index) => ({
        info: userInfo(`user-${index}`),
        parts: [
          {
            ...basePart(`user-${index}`, `image-${index}`),
            type: "file" as const,
            mime: "image/png",
            url: `data:image/png;base64,aW1hZ2Ut${index}`,
            source: {
              type: "file" as const,
              path: `https://cdn.example.com/user-${index}.png`,
              text: { value: "image", start: 0, end: 5 },
            },
          },
        ],
      })),
    )
    const images = messages.flatMap((message) => message.parts).filter((part) => part.type === "file")

    expect(images).toHaveLength(4)
    expect(messages[0].parts).toEqual([
      {
        ...basePart("user-0", "image-0"),
        type: "text",
        text: "[Image CDN: https://cdn.example.com/user-0.png]",
        synthetic: true,
      },
    ])
  })
})
