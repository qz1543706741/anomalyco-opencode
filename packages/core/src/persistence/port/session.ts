export * as SessionRepository from "./session"

import { Context, Effect } from "effect"
import type { PersistenceError } from "../error"
import type { RequestScope } from "../scope"
import type { EventRepository } from "./event"

export interface Session {
  readonly id: string
  readonly userId: string
  readonly generation: bigint
  readonly projectId: string
  readonly workspaceId?: string
  readonly parentId?: string
  readonly slug: string
  readonly directory: string
  readonly path?: string
  readonly title: string
  readonly version: string
  readonly shareUrl?: string
  readonly summary?: unknown
  readonly metadata?: unknown
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly revert?: unknown
  readonly permission?: unknown
  readonly agent?: string
  readonly model?: unknown
  readonly status: string
  readonly compactingAt?: number
  readonly archivedAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateInput {
  readonly id: string
  readonly title: string
  readonly parentId?: string
  readonly slug: string
  readonly version: string
  readonly agent?: string
  readonly model?: unknown
  readonly metadata?: unknown
  readonly permission?: unknown
  readonly event: (value: Session) => EventRepository.AppendInput
}

export interface PatchInput {
  readonly title?: string
  readonly status?: string
  readonly archivedAt?: number | null
  readonly metadata?: unknown | null
  readonly permission?: unknown | null
  readonly agent?: string | null
  readonly model?: unknown | null
  readonly revert?: unknown | null
  readonly summary?: unknown | null
  readonly shareUrl?: string | null
  readonly compactingAt?: number | null
}

export interface AdmitInput {
  readonly id: string
  readonly sessionId: string
  readonly prompt: unknown
  readonly delivery: "steer" | "queue"
  readonly eventId: string
}

export interface AdmissionResult {
  readonly inputId: string
  readonly runId: string
  readonly admittedSeq: number
}

type Error = PersistenceError.StaleOwner | PersistenceError.SessionNotFound | PersistenceError.Unavailable

export interface Interface {
  readonly list: (scope: RequestScope.Value) => Effect.Effect<ReadonlyArray<Session>, PersistenceError.Unavailable>
  readonly create: (scope: RequestScope.Value, input: CreateInput) => Effect.Effect<Session, Error>
  readonly get: (
    scope: RequestScope.Value,
    sessionId: string,
  ) => Effect.Effect<Session | undefined, PersistenceError.Unavailable>
  readonly update: (
    scope: RequestScope.Value,
    sessionId: string,
    input: PatchInput,
    event: (value: Session) => EventRepository.AppendInput,
  ) => Effect.Effect<Session, Error>
  readonly remove: (
    scope: RequestScope.Value,
    sessionId: string,
    event: (value: Session) => EventRepository.AppendInput,
  ) => Effect.Effect<void, Error>
  readonly admit: (
    scope: RequestScope.Value,
    input: AdmitInput,
  ) => Effect.Effect<AdmissionResult, Error | PersistenceError.IdempotencyConflict | PersistenceError.RunIdRequired>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/persistence/SessionRepository") {}
