import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectionRepository } from "@opencode-ai/core/persistence/port/projection"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { Effect, Layer, Schema } from "effect"
import { MysqlPersistence } from "@/persistence/mysql"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"

const layer = Layer.effect(
  SessionStatus.Service,
  Effect.gen(function* () {
    const projections = yield* ProjectionRepository.Service
    const events = yield* EventV2Bridge.Service
    const list = Effect.fn("MysqlSessionStatus.list")(function* () {
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      return new Map(
        Array.from(yield* projections.listStatus(scope).pipe(Effect.orDie), ([id, status]) => [
          SessionID.make(id),
          Schema.decodeUnknownSync(SessionStatus.Info)(status),
        ]),
      )
    })
    return SessionStatus.Service.of({
      get: Effect.fn("MysqlSessionStatus.get")(function* (sessionID) {
        return (yield* list()).get(sessionID) ?? { type: "idle" }
      }),
      list,
      set: Effect.fn("MysqlSessionStatus.set")(function* (sessionID, status, outcome) {
        const scope = yield* RequestScope.require.pipe(Effect.orDie)
        const id = EventV2.ID.create()
        const data = { sessionID, status }
        yield* projections
          .setStatus(
            scope,
            sessionID,
            status,
            { id, aggregateId: sessionID, type: SessionStatus.Event.Status.type, data },
            outcome,
          )
          .pipe(Effect.orDie)
        yield* events.publish(SessionStatus.Event.Status, data, { id })
        if (status.type === "idle") yield* events.publish(SessionStatus.Event.Idle, { sessionID })
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: SessionStatus.Service,
  layer,
  deps: [MysqlPersistence.node, EventV2Bridge.node],
})

export * as MysqlSessionStatus from "./status-mysql"
