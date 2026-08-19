import { composeAdapters } from "../adapter"
import { createMergeAssistantAdapter } from "../merge-assistant"
import { createReasoningStreamAdapter } from "./reasoning-stream"
import { createSchemaSanitizerAdapter, createThinkingConfigAdapter } from "./request-adapters"
import { createThoughtSignatureAdapter } from "./thought-signature"
import type { GeminiRequestBody } from "./types"

export type { GeminiAdapter, GeminiRequestBody } from "./types"

export function createGeminiAdapter() {
  return composeAdapters<GeminiRequestBody>([
    createThinkingConfigAdapter(),
    createSchemaSanitizerAdapter(),
    createThoughtSignatureAdapter(),
    createReasoningStreamAdapter(),
    createMergeAssistantAdapter<GeminiRequestBody>(),
  ])
}
