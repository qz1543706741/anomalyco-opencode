export * as ProjectionRepository from "./projection"

import { Context, Effect } from "effect"
import type { PersistenceError } from "../error"
import type { RequestScope } from "../scope"
import type { EventRepository } from "./event"

export interface RecordValue {
  readonly id: string
  readonly sessionId: string
  readonly data: unknown
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PartValue extends RecordValue {
  readonly messageId: string
  readonly position: number
}

export interface TodoValue {
  readonly content: string
  readonly status: string
  readonly priority: string
}

export interface PendingValue extends RecordValue {
  readonly status: string
  readonly response?: unknown
}

export interface SessionMessageValue extends RecordValue {
  readonly type: string
  readonly seq: number
}

export interface ContextEpochValue {
  readonly baseline: string
  readonly baselineSeq: number
  readonly snapshot: unknown
  readonly updatedAt: number
}

export interface WriteValue<A> {
  readonly value: A
  readonly event: EventRepository.AppendInput
}

type Error = PersistenceError.StaleOwner | PersistenceError.SessionNotFound | PersistenceError.Unavailable

export interface Interface {
  readonly messages: (scope: RequestScope.Value, sessionId: string) => Effect.Effect<ReadonlyArray<RecordValue>, Error>
  readonly putMessage: (scope: RequestScope.Value, input: WriteValue<RecordValue>) => Effect.Effect<void, Error>
  readonly putPart: (scope: RequestScope.Value, input: WriteValue<PartValue>) => Effect.Effect<void, Error>
  readonly parts: (
    scope: RequestScope.Value,
    sessionId: string,
    messageId: string,
  ) => Effect.Effect<ReadonlyArray<PartValue>, Error>
  readonly removeMessage: (
    scope: RequestScope.Value,
    sessionId: string,
    messageId: string,
    event: EventRepository.AppendInput,
  ) => Effect.Effect<void, Error>
  readonly removePart: (
    scope: RequestScope.Value,
    sessionId: string,
    messageId: string,
    partId: string,
    event: EventRepository.AppendInput,
  ) => Effect.Effect<void, Error>
  readonly replaceTodos: (
    scope: RequestScope.Value,
    sessionId: string,
    values: ReadonlyArray<TodoValue>,
    event: EventRepository.AppendInput,
  ) => Effect.Effect<void, Error>
  readonly todos: (scope: RequestScope.Value, sessionId: string) => Effect.Effect<ReadonlyArray<TodoValue>, Error>
  readonly appendSessionMessage: (scope: RequestScope.Value, value: SessionMessageValue) => Effect.Effect<void, Error>
  readonly sessionMessages: (
    scope: RequestScope.Value,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<SessionMessageValue>, Error>
  readonly putContextEpoch: (
    scope: RequestScope.Value,
    sessionId: string,
    value: ContextEpochValue,
  ) => Effect.Effect<void, Error>
  readonly getContextEpoch: (
    scope: RequestScope.Value,
    sessionId: string,
  ) => Effect.Effect<ContextEpochValue | undefined, Error>
  readonly setStatus: (
    scope: RequestScope.Value,
    sessionId: string,
    status: unknown,
    event: EventRepository.AppendInput,
    outcome?: "completed" | "failed" | "interrupted" | "aborted",
  ) => Effect.Effect<void, Error>
  readonly listStatus: (
    scope: RequestScope.Value,
  ) => Effect.Effect<ReadonlyMap<string, unknown>, PersistenceError.Unavailable>
  readonly createPending: (
    scope: RequestScope.Value,
    kind: "permission" | "question",
    value: RecordValue,
    event: EventRepository.AppendInput,
  ) => Effect.Effect<void, Error>
  readonly resolvePending: (
    scope: RequestScope.Value,
    kind: "permission" | "question",
    id: string,
    status: "replied" | "rejected",
    response?: unknown,
    event?: EventRepository.AppendInput,
  ) => Effect.Effect<void, Error>
  readonly listPending: (
    scope: RequestScope.Value,
    kind: "permission" | "question",
  ) => Effect.Effect<ReadonlyArray<PendingValue>, PersistenceError.Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/persistence/ProjectionRepository") {}
