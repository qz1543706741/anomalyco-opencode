import type { RequestAdapter } from "../adapter"

export type DeepseekMessage = {
  role?: string
  reasoning_content?: unknown
  content?: unknown
  tool_calls?: unknown[]
}

export type DeepseekRequestBody = {
  model?: string
  max_tokens?: number
  messages?: DeepseekMessage[]
  temperature?: unknown
  top_p?: unknown
  presence_penalty?: unknown
  frequency_penalty?: unknown
  logprobs?: unknown
  top_logprobs?: unknown
  reasoning_effort?: string
  output_config?: { effort?: string }
  extra_body?: {
    thinking?: { type?: string }
  }
}

export type DeepseekAdapter = RequestAdapter<DeepseekRequestBody>
