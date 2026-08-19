import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectionRepository } from "@opencode-ai/core/persistence/port/projection"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { Deferred, Effect, Layer, Schema } from "effect"
import { MysqlPersistence } from "@/persistence/mysql"
import { Question } from "."
import { QuestionID } from "./schema"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"

interface PendingEntry {
  readonly info: Question.Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Question.Answer>, Question.RejectedError>
}

const layer = Layer.effect(
  Question.Service,
  Effect.gen(function* () {
    const projections = yield* ProjectionRepository.Service
    const events = yield* EventV2Bridge.Service
    const pending = new Map<QuestionID, PendingEntry>()

    const list = Effect.fn("MysqlQuestion.list")(function* () {
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      return (yield* projections.listPending(scope, "question").pipe(Effect.orDie)).map((value) =>
        Schema.decodeUnknownSync(Question.Request)(value.data),
      )
    })

    const ask: Question.Interface["ask"] = Effect.fn("MysqlQuestion.ask")(function* (input) {
      const id = QuestionID.ascending()
      const info: Question.Request = { id, ...input }
      const deferred = yield* Deferred.make<ReadonlyArray<Question.Answer>, Question.RejectedError>()
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      const now = Date.now()
      const eventId = EventV2.ID.create()
      yield* projections
        .createPending(
          scope,
          "question",
          { id, sessionId: info.sessionID, data: info, createdAt: now, updatedAt: now },
          { id: eventId, aggregateId: info.sessionID, type: Question.Event.Asked.type, data: info },
        )
        .pipe(Effect.orDie)
      yield* events.publish(Question.Event.Asked, info, { id: eventId })
      pending.set(id, { info, deferred })
      return yield* Deferred.await(deferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id)
          }),
        ),
      )
    })

    const reply: Question.Interface["reply"] = Effect.fn("MysqlQuestion.reply")(function* (input) {
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      const info = (yield* list()).find((item) => item.id === input.requestID)
      if (!info) return yield* new Question.NotFoundError({ requestID: input.requestID })
      const eventId = EventV2.ID.create()
      const event = { sessionID: info.sessionID, requestID: info.id, answers: input.answers }
      yield* projections
        .resolvePending(scope, "question", input.requestID, "replied", input.answers, {
          id: eventId,
          aggregateId: info.sessionID,
          type: Question.Event.Replied.type,
          data: event,
        })
        .pipe(Effect.orDie)
      yield* events.publish(Question.Event.Replied, event, { id: eventId })
      const local = pending.get(input.requestID)
      if (local) yield* Deferred.succeed(local.deferred, input.answers)
      return yield* Effect.void
    })

    const reject: Question.Interface["reject"] = Effect.fn("MysqlQuestion.reject")(function* (requestID) {
      const scope = yield* RequestScope.require.pipe(Effect.orDie)
      const info = (yield* list()).find((item) => item.id === requestID)
      if (!info) return yield* new Question.NotFoundError({ requestID })
      const eventId = EventV2.ID.create()
      const event = { sessionID: info.sessionID, requestID: info.id }
      yield* projections
        .resolvePending(scope, "question", requestID, "rejected", undefined, {
          id: eventId,
          aggregateId: info.sessionID,
          type: Question.Event.Rejected.type,
          data: event,
        })
        .pipe(Effect.orDie)
      yield* events.publish(Question.Event.Rejected, event, { id: eventId })
      const local = pending.get(requestID)
      if (local) yield* Deferred.fail(local.deferred, new Question.RejectedError())
      return yield* Effect.void
    })

    return Question.Service.of({ ask, reply, reject, list })
  }),
)

export const node = LayerNode.make({
  service: Question.Service,
  layer,
  deps: [MysqlPersistence.node, EventV2Bridge.node],
})

export * as MysqlQuestion from "./mysql"
