import { composeAdapters } from "../adapter"
import { createMergeAssistantAdapter } from "../merge-assistant"
import { createPrefillGuardAdapter } from "./prefill-guard"
import { createReasoningContentAdapter } from "./reasoning-content"
import { createThinkingConfigAdapter } from "./thinking-config"
import { createUnsupportedParamsAdapter } from "./unsupported-params"
import type { DeepseekRequestBody } from "./types"

export type { DeepseekAdapter, DeepseekRequestBody } from "./types"

export function createDeepseekAdapter() {
  return composeAdapters<DeepseekRequestBody>([
    createThinkingConfigAdapter(),
    createReasoningContentAdapter(),
    createUnsupportedParamsAdapter(),
    createMergeAssistantAdapter<DeepseekRequestBody>(),
    createPrefillGuardAdapter(),
  ])
}
