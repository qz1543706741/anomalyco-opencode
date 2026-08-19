import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectionRepository } from "@opencode-ai/core/persistence/port/projection"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Deferred, Effect, Layer, Schema } from "effect"
import { MysqlPersistence } from "@/persistence/mysql"
import { Permission } from "."
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"

interface PendingEntry {
  readonly info: PermissionV1.Request
  readonly deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

const layer = Layer.effect(
  Permission.Service,
  Effect.gen(function* () {
    const projections = yield* ProjectionRepository.Service
    const events = yield* EventV2Bridge.Service
    const pending = new Map<PermissionV1.ID, PendingEntry>()
    const approved: PermissionV1.Rule[] = []

    const list = Effect.fn("MysqlPermission.list")(function* () {
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      return (yield* projections.listPending(scope, "permission").pipe(Effect.orDie)).map((value) =>
        Schema.decodeUnknownSync(PermissionV1.Request)(value.data),
      )
    })

    const ask = Effect.fn("MysqlPermission.ask")(function* (input: PermissionV1.AskInput) {
      const { ruleset, ...request } = input
      let needsAsk = false
      for (const pattern of request.patterns) {
        const rule = Permission.evaluate(request.permission, pattern, ruleset, approved)
        if (rule.action === "deny")
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((item) => item.permission === request.permission),
          })
        if (rule.action === "ask") needsAsk = true
      }
      if (!needsAsk) return yield* Effect.void
      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = { ...request, id }
      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      const now = Date.now()
      const eventId = EventV2.ID.create()
      yield* projections
        .createPending(
          scope,
          "permission",
          { id, sessionId: info.sessionID, data: info, createdAt: now, updatedAt: now },
          { id: eventId, aggregateId: info.sessionID, type: Permission.Event.Asked.type, data: info },
        )
        .pipe(Effect.orDie)
      yield* events.publish(Permission.Event.Asked, info, { id: eventId })
      pending.set(id, { info, deferred })
      return yield* Deferred.await(deferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id)
          }),
        ),
      )
    })

    const reply = Effect.fn("MysqlPermission.reply")(function* (input: PermissionV1.ReplyInput) {
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      const info = (yield* list()).find((item) => item.id === input.requestID)
      if (!info) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
      const eventId = EventV2.ID.create()
      const event = { sessionID: info.sessionID, requestID: info.id, reply: input.reply }
      yield* projections
        .resolvePending(
          scope,
          "permission",
          input.requestID,
          input.reply === "reject" ? "rejected" : "replied",
          input,
          { id: eventId, aggregateId: info.sessionID, type: Permission.Event.Replied.type, data: event },
        )
        .pipe(Effect.orDie)
      yield* events.publish(Permission.Event.Replied, event, { id: eventId })
      const local = pending.get(input.requestID)
      if (input.reply === "reject" && local)
        yield* Deferred.fail(
          local.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )
      if (input.reply !== "reject" && local) yield* Deferred.succeed(local.deferred, undefined)
      if (input.reply !== "always") return yield* Effect.void
      approved.push(
        ...info.always.map((pattern) => ({ permission: info.permission, pattern, action: "allow" as const })),
      )
      return yield* Effect.void
    })

    return Permission.Service.of({ ask, reply, list })
  }),
)

export const node = LayerNode.make({
  service: Permission.Service,
  layer,
  deps: [MysqlPersistence.node, EventV2Bridge.node],
})

export * as MysqlPermission from "./mysql"
