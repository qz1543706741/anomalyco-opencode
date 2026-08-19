export * as PersistenceError from "./error"

import { Schema } from "effect"

export class StaleOwner extends Schema.TaggedErrorClass<StaleOwner>()("Persistence.StaleOwner", {
  current: Schema.BigInt,
  attempted: Schema.BigInt,
}) {}

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("Persistence.SessionNotFound", {
  sessionId: Schema.String,
}) {}

export class IdempotencyConflict extends Schema.TaggedErrorClass<IdempotencyConflict>()(
  "Persistence.IdempotencyConflict",
  { requestId: Schema.String },
) {}

export class RunIdRequired extends Schema.TaggedErrorClass<RunIdRequired>()("Persistence.RunIdRequired", {}) {}

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("Persistence.Unavailable", {
  cause: Schema.Defect(),
}) {}

export class SchemaVersionMismatch extends Schema.TaggedErrorClass<SchemaVersionMismatch>()(
  "Persistence.SchemaVersionMismatch",
  {
    actual: Schema.String,
    minimum: Schema.String,
    maximum: Schema.String,
  },
) {}
