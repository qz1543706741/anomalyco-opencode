export type AdapterContext = {
  providerID: string
}

// OpenAI-style chat message shared across families (gemini/gpt/deepseek all send this shape).
export type ChatMessage = {
  role?: string
  content?: unknown
  tool_calls?: unknown[]
}

export type MessageBody = {
  model?: string
  messages?: ChatMessage[]
}

export type RequestAdapter<TBody> = {
  prepareRequest?(body: TBody, ctx: AdapterContext): void
  prepareHeaders?(headers: Headers, ctx: AdapterContext): void
  extractFromStream?(stream: ReadableStream<Uint8Array>): Promise<void>
  transformStream?(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>
}

export type ComposedAdapter<TBody> = {
  prepareRequest(body: TBody, ctx: AdapterContext): void
  prepareHeaders(headers: Headers, ctx: AdapterContext): void
  extractFromStream(stream: ReadableStream<Uint8Array>): Promise<void>
  transformStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>
  hasStreamConsumer: boolean
  hasStreamTransformer: boolean
}

export function composeAdapters<TBody>(adapters: RequestAdapter<TBody>[]): ComposedAdapter<TBody> {
  const consumers = adapters.filter(
    (a): a is Required<Pick<RequestAdapter<TBody>, "extractFromStream">> => !!a.extractFromStream,
  )
  const transformers = adapters.filter(
    (a): a is Required<Pick<RequestAdapter<TBody>, "transformStream">> => !!a.transformStream,
  )
  return {
    hasStreamConsumer: consumers.length > 0,
    hasStreamTransformer: transformers.length > 0,
    prepareRequest(body, ctx) {
      for (const adapter of adapters) adapter.prepareRequest?.(body, ctx)
    },
    prepareHeaders(headers, ctx) {
      for (const adapter of adapters) adapter.prepareHeaders?.(headers, ctx)
    },
    async extractFromStream(stream) {
      if (consumers.length === 0) return
      if (consumers.length === 1) return consumers[0].extractFromStream(stream)

      let current = stream
      const pending: Promise<void>[] = []
      for (let i = 0; i < consumers.length - 1; i++) {
        const [a, b] = current.tee()
        pending.push(consumers[i].extractFromStream(a))
        current = b
      }
      pending.push(consumers[consumers.length - 1].extractFromStream(current))
      await Promise.all(pending)
    },
    transformStream(stream) {
      let current = stream
      for (const transformer of transformers) current = transformer.transformStream(current)
      return current
    },
  }
}
