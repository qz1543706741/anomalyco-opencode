import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventRepository } from "@opencode-ai/core/persistence/port/event"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import type { Definition, Payload } from "@opencode-ai/schema/event"
import { Effect, Layer, PubSub, Stream } from "effect"
import { GlobalBus } from "@/bus/global"
import { MysqlPersistence } from "@/persistence/mysql"
import { EventV2Bridge } from "./event-v2-bridge"

const layer = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const repository = yield* EventRepository.Service
    const all = yield* PubSub.unbounded<Payload>()
    const typed = new Map<string, PubSub.PubSub<Payload>>()
    const listeners: EventV2.Subscriber[] = []

    const channel = (definition: Definition) =>
      Effect.gen(function* () {
        const existing = typed.get(definition.type)
        if (existing) return existing
        const created = yield* PubSub.unbounded<Payload>()
        typed.set(definition.type, created)
        return created
      })

    const notify = Effect.fn("MysqlEventV2Bridge.notify")(function* (event: Payload, userId: string) {
      yield* Effect.forEach(listeners, (listener) => listener(event), { discard: true })
      const selected = typed.get(event.type)
      if (selected) yield* PubSub.publish(selected, event)
      yield* PubSub.publish(all, event)
      GlobalBus.emit("event", {
        userId,
        payload: { id: event.id, type: event.type, properties: event.data },
      })
    })

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.commit)
          return yield* Effect.die("MySQL Event bridge does not accept SQLite projection commit hooks")
        const scope = yield* RequestScope.require.pipe(Effect.orDie)
        const base = {
          id: options?.id ?? EventV2.ID.create(),
          type: definition.type,
          data,
          metadata: { ...options?.metadata, userId: scope.userId },
          ...(options?.location ? { location: options.location } : {}),
        } as Payload
        const durable = definition.durable
        if (!durable) {
          yield* notify(base, scope.userId)
          return base as never
        }
        const aggregateID = (data as Record<string, unknown>)[durable.aggregate]
        if (typeof aggregateID !== "string")
          return yield* Effect.die(`Expected string aggregate field ${durable.aggregate}`)
        const committed = yield* repository
          .append(scope, {
            id: base.id,
            aggregateId: aggregateID,
            type: EventV2.versionedType(definition.type, durable.version),
            data: data as Record<string, unknown>,
          })
          .pipe(Effect.orDie)
        const event = {
          ...base,
          durable: { aggregateID, seq: committed.seq, version: durable.version },
        } as Payload
        yield* notify(event, scope.userId)
        return event as never
      })

    const service: EventV2.Interface = {
      publish,
      subscribe: (definition) =>
        Stream.unwrap(channel(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))) as never,
      all: () => Stream.fromPubSub(all),
      durable: (input) =>
        Stream.fromPubSub(all).pipe(Stream.filter((event) => event.durable?.aggregateID === input.aggregateID)),
      listen: (listener) =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        }),
      project: (definition, projector) =>
        Effect.sync(() => {
          void definition
          listeners.push(projector as EventV2.Subscriber)
        }),
      replay: () => Effect.die("MySQL Event replay is not exposed through legacy bridge"),
      replayAll: () => Effect.die("MySQL Event replay is not exposed through legacy bridge"),
      remove: (aggregateID) =>
        Effect.gen(function* () {
          const scope = yield* RequestScope.require.pipe(Effect.orDie)
          yield* repository.remove(scope, aggregateID).pipe(Effect.orDie)
        }),
      claim: () => Effect.void,
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* PubSub.shutdown(all)
        yield* Effect.forEach(typed.values(), PubSub.shutdown, { discard: true })
      }),
    )
    return EventV2Bridge.Service.of(service)
  }),
)

export const node = LayerNode.make({ service: EventV2Bridge.Service, layer, deps: [MysqlPersistence.node] })

export * as MysqlEventV2Bridge from "./event-v2-bridge-mysql"
