export * as FenceRepository from "./fence"

import { Context, Effect } from "effect"
import type { PersistenceError } from "../error"
import type { RequestScope } from "../scope"

export interface Interface {
  readonly claim: (
    scope: RequestScope.Value,
  ) => Effect.Effect<void, PersistenceError.StaleOwner | PersistenceError.Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/persistence/FenceRepository") {}
