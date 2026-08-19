import { afterEach, describe, expect, mock, test } from "bun:test"
import { materializeWanqingImage } from "../src/wanqing/image"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("m0 wanqing image materialization", () => {
  test("materializes unstable CDN images and preserves stable ones", async () => {
    const part = {
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "file" as const,
      mime: "image/png",
      url: "https://cdn.example.com/image.png",
    }
    const bytes = await Bun.file(new URL("./fixtures/large-image.png", import.meta.url)).bytes()
    const fetchImage = mock()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response(Uint8Array.from(bytes).buffer, { headers: { "content-type": "image/png" } }))
    globalThis.fetch = fetchImage as unknown as typeof fetch

    expect(await materializeWanqingImage(part, true)).toEqual(part)
    const result = await materializeWanqingImage(part, false)
    const compressed = Buffer.from(result.url.slice(result.url.indexOf(",") + 1), "base64")
    expect(compressed.byteLength).toBeLessThan(bytes.byteLength)
    expect(result.source).toEqual({
      type: "file",
      path: part.url,
      text: { value: "image", start: 0, end: 5 },
    })
    expect(fetchImage).toHaveBeenCalledTimes(2)
  })
})
