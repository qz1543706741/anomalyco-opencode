export * as EventRepository from "./event"

import { Context, Effect } from "effect"
import type { PersistenceError } from "../error"
import type { RequestScope } from "../scope"

export interface AppendInput {
  readonly id: string
  readonly aggregateId: string
  readonly type: string
  readonly data: Record<string, unknown>
}

export interface Committed {
  readonly id: string
  readonly aggregateId: string
  readonly seq: number
}

export interface Interface {
  readonly append: (
    scope: RequestScope.Value,
    input: AppendInput,
  ) => Effect.Effect<Committed, PersistenceError.StaleOwner | PersistenceError.Unavailable>
  readonly remove: (
    scope: RequestScope.Value,
    aggregateId: string,
  ) => Effect.Effect<void, PersistenceError.StaleOwner | PersistenceError.Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/persistence/EventRepository") {}
