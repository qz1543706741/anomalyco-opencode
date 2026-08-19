import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectionRepository } from "@opencode-ai/core/persistence/port/projection"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { Effect, Layer, Schema } from "effect"
import { MysqlPersistence } from "@/persistence/mysql"
import { Todo } from "./todo"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"

const layer = Layer.effect(
  Todo.Service,
  Effect.gen(function* () {
    const projections = yield* ProjectionRepository.Service
    const events = yield* EventV2Bridge.Service
    return Todo.Service.of({
      update: Effect.fn("MysqlTodo.update")(function* (input) {
        const scope = yield* RequestScope.require.pipe(Effect.orDie)
        const id = EventV2.ID.create()
        yield* projections
          .replaceTodos(scope, input.sessionID, input.todos, {
            id,
            aggregateId: input.sessionID,
            type: Todo.Event.Updated.type,
            data: input,
          })
          .pipe(Effect.orDie)
        yield* events.publish(Todo.Event.Updated, input, { id })
      }),
      get: Effect.fn("MysqlTodo.get")(function* (sessionID) {
        const scope = yield* RequestScope.require.pipe(Effect.orDie)
        return Schema.decodeUnknownSync(Schema.Array(Todo.Info))(
          yield* projections.todos(scope, sessionID).pipe(Effect.orDie),
        ) as DeepMutable<ReadonlyArray<Todo.Info>>
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Todo.Service, layer, deps: [MysqlPersistence.node, EventV2Bridge.node] })

export * as MysqlTodo from "./todo-mysql"
