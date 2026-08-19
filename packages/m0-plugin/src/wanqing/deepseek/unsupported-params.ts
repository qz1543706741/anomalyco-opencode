import { createLogger } from "../../logger"
import type { DeepseekAdapter, DeepseekRequestBody } from "./types"

const log = createLogger({ service: "plugin.wanqing.deepseek.unsupported-params" })

// deepseek-reasoner rejects these sampling params.
const UNSUPPORTED_PARAMS = [
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
] as const satisfies readonly (keyof DeepseekRequestBody)[]

export function createUnsupportedParamsAdapter(): DeepseekAdapter {
  return {
    prepareRequest(body) {
      const stripped: string[] = []
      for (const key of UNSUPPORTED_PARAMS) {
        if (body[key] !== undefined) {
          delete body[key]
          stripped.push(key)
        }
      }
      if (stripped.length) log.info("stripped unsupported params", { model: body.model, stripped })
    },
  }
}
