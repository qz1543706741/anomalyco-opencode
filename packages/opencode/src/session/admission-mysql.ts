import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionRepository } from "@opencode-ai/core/persistence/port/session"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { Effect, Layer } from "effect"
import { MysqlPersistence } from "@/persistence/mysql"
import { SessionAdmission } from "./admission"

const layer = Layer.effect(
  SessionAdmission.Service,
  Effect.gen(function* () {
    const sessions = yield* SessionRepository.Service
    return SessionAdmission.Service.of({
      admit: Effect.fn("MysqlSessionAdmission.admit")(function* (input) {
        const scope = yield* RequestScope.require.pipe(Effect.orDie)
        const result = yield* sessions
          .admit(scope, {
            id: input.messageID,
            sessionId: input.sessionID,
            prompt: input.prompt,
            delivery: input.delivery,
            eventId: EventV2.ID.create(),
          })
          .pipe(Effect.orDie)
        return { runId: result.runId }
      }),
    })
  }),
)

export const node = LayerNode.make({ service: SessionAdmission.Service, layer, deps: [MysqlPersistence.node] })

export * as MysqlSessionAdmission from "./admission-mysql"
