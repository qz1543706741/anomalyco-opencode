import { composeAdapters } from "../adapter"
import { createMergeAssistantAdapter } from "../merge-assistant"
import { createCompletionTokensAdapter } from "./completion-tokens"
import type { GptRequestBody } from "./types"

export type { GptAdapter, GptRequestBody } from "./types"

export function createGptAdapter() {
  return composeAdapters<GptRequestBody>([
    createCompletionTokensAdapter(),
    createMergeAssistantAdapter<GptRequestBody>(),
  ])
}
