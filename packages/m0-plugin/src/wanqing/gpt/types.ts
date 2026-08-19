import type { ChatMessage, RequestAdapter } from "../adapter"

export type GptRequestBody = {
  model?: string
  max_tokens?: unknown
  max_completion_tokens?: unknown
  messages?: ChatMessage[]
}

export type GptAdapter = RequestAdapter<GptRequestBody>
