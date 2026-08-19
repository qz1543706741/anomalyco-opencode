export * as RequestScope from "./scope"

import { Context, Effect, Schema } from "effect"

export interface Value {
  readonly userId: string
  readonly generation: bigint
  readonly requestId: string
  readonly runId?: string
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("RequestScope.Invalid", {
  header: Schema.String,
}) {}

export class Service extends Context.Service<Service, Value>()("@opencode/persistence/RequestScope") {}

export const Current = Context.Reference<Value | undefined>("@opencode/persistence/RequestScopeCurrent", {
  defaultValue: () => undefined,
})

export const require = Effect.gen(function* () {
  const scope = yield* Current
  if (!scope) return yield* new InvalidError({ header: "x-opencode-user-id" })
  return scope
})

export function decode(headers: Headers): Value {
  const userId = headers.get("x-opencode-user-id")?.trim()
  if (!userId || userId.length > 128) throw new InvalidError({ header: "x-opencode-user-id" })
  const generation = headers.get("x-opencode-owner-generation")
  if (!generation || !/^[1-9]\d*$/.test(generation)) throw new InvalidError({ header: "x-opencode-owner-generation" })
  const requestId = headers.get("x-request-id")
  if (!requestId || !uuid(requestId)) throw new InvalidError({ header: "x-request-id" })
  const runId = headers.get("x-opencode-run-id") ?? undefined
  if (runId && !uuid(runId)) throw new InvalidError({ header: "x-opencode-run-id" })
  return { userId, generation: BigInt(generation), requestId, runId }
}

function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
