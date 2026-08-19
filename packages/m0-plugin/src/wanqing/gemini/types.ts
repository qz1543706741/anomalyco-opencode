import type { RequestAdapter } from "../adapter"

export type GeminiRequestBody = {
  max_tokens?: number
  extra_body?: {
    google?: {
      thinking_config?: {
        include_thoughts?: boolean
        thinking_budget?: number
        thinking_level?: string
      }
    }
  }
  messages?: Array<{
    role?: string
    tool_calls?: Array<{
      id?: string
      extra_content?: {
        google?: {
          thought_signature?: string
        }
      }
    }>
  }>
  tools?: Array<{
    function?: {
      parameters?: unknown
    }
  }>
}

export type GeminiAdapter = RequestAdapter<GeminiRequestBody>

export const WANQING_ONLINE_REASONING_PROVIDER_ID = "wanqing-online-reasoning"
