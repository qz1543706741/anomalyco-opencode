import type { FilePart } from "@opencode-ai/sdk"
import { DownloadError } from "@ai-sdk/provider-utils"
import { createDownload } from "ai"
import { createLogger } from "../logger"

const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024
const log = createLogger({ service: "m0.wanqing.image" })

type BunImagePipeline = {
  png(options: { compressionLevel: number }): BunImagePipeline
  webp(options: { lossless: boolean }): BunImagePipeline
  blob(): Promise<Blob>
}
const BunImage = (Bun as unknown as { Image: new (input: Uint8Array) => BunImagePipeline }).Image

export async function materializeWanqingImage(part: FilePart, useCdn: boolean): Promise<FilePart> {
  if (!remoteImage(part.url)) {
    log.debug("wanqing image already materialized", { partID: part.id, mime: part.mime })
    return part
  }
  const hostname = new URL(part.url).hostname
  if (useCdn) {
    log.info("keeping wanqing CDN image URL", { partID: part.id, hostname, mime: part.mime })
    return part
  }
  log.info("downloading wanqing CDN image", {
    partID: part.id,
    hostname,
    mime: part.mime,
    timeout_ms: IMAGE_DOWNLOAD_TIMEOUT_MS,
    max_bytes: MAX_IMAGE_DOWNLOAD_BYTES,
  })
  const downloaded = await downloadImage(part.url, MAX_IMAGE_DOWNLOAD_BYTES)
  const mime = downloaded.mediaType?.split(";")[0]?.trim() || part.mime
  if (!mime.startsWith("image/")) {
    log.warn("wanqing CDN response is not an image", { partID: part.id, hostname, mime })
    throw new Error(`Unexpected image content type: ${mime}`)
  }
  const data = await compressLosslessImage(downloaded.data, mime)
  const source = part.source ?? {
    type: "file" as const,
    path: part.url,
    text: { value: part.filename ?? "image", start: 0, end: (part.filename ?? "image").length },
  }
  log.info("materialized wanqing image", {
    partID: part.id,
    hostname,
    mime,
    downloaded_bytes: downloaded.data.byteLength,
    materialized_bytes: data.byteLength,
    saved_bytes: downloaded.data.byteLength - data.byteLength,
  })
  return { ...part, mime, source, url: `data:${mime};base64,${Buffer.from(data).toString("base64")}` }
}

export function remoteImage(url: string) {
  return url.startsWith("http://") || url.startsWith("https://")
}

async function compressLosslessImage(data: Uint8Array, mime: string) {
  const blob =
    mime === "image/png"
      ? await new BunImage(data).png({ compressionLevel: 9 }).blob()
      : mime === "image/webp"
        ? await new BunImage(data).webp({ lossless: true }).blob()
        : undefined
  if (!blob || blob.size >= data.byteLength) return data
  return new Uint8Array(await blob.arrayBuffer())
}

function downloadImage(
  url: string,
  maxBytes: number,
  retry = true,
): Promise<{ data: Uint8Array; mediaType: string | undefined }> {
  return createDownload({ maxBytes })({
    url: new URL(url),
    abortSignal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
  }).catch((error) => {
    const status = DownloadError.isInstance(error) ? error.statusCode : undefined
    const retryable = status === undefined || status === 408 || status === 429 || status >= 500
    if (retry && retryable) {
      log.warn("retrying wanqing image download", {
        hostname: new URL(url).hostname,
        status,
        error: imageDownloadError(error, url),
      })
      return downloadImage(url, maxBytes, false)
    }
    log.error("wanqing image download failed", {
      hostname: new URL(url).hostname,
      status,
      error: imageDownloadError(error, url),
    })
    throw error
  })
}

function imageDownloadError(error: unknown, url: string) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(url, "<redacted-url>")
}
