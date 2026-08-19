import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Fiber } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Permission } from "@/permission"
import { MysqlPermission } from "@/permission/mysql"
import { Question } from "@/question"
import { MysqlQuestion } from "@/question/mysql"
import { Session } from "@/session/session"
import { MysqlSession } from "@/session/mysql"
import { MysqlSessionStatus } from "@/session/status-mysql"
import { SessionStatus } from "@/session/status"
import { MysqlTodo } from "@/session/todo-mysql"
import { Todo } from "@/session/todo"
import { MessageID, PartID } from "@/session/schema"

const url = process.env.MYSQL_TEST_URL

describe.skipIf(!url)("MySQL Session service", () => {
  test("uses scoped repository for legacy Session CRUD", async () => {
    const scope = {
      userId: `session-service-${crypto.randomUUID()}`,
      generation: 1n,
      requestId: crypto.randomUUID(),
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const created = yield* sessions.create({ title: "mysql service" })
          expect((yield* sessions.list()).map((item) => item.id)).toContain(created.id)
          yield* sessions.setTitle({ sessionID: created.id, title: "mysql updated" })
          expect((yield* sessions.get(created.id)).title).toBe("mysql updated")
          const message = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: created.id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            tools: {},
          } satisfies SessionV1.User)
          const part = yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: created.id,
            messageID: message.id,
            type: "text",
            text: "",
          } satisfies SessionV1.TextPart)
          const streamed: GlobalEvent[] = []
          const listener = (event: GlobalEvent) => streamed.push(event)
          yield* Effect.acquireRelease(
            Effect.sync(() => GlobalBus.on("event", listener)),
            () => Effect.sync(() => GlobalBus.off("event", listener)),
          )
          yield* sessions.updatePartDelta({
            sessionID: created.id,
            messageID: message.id,
            partID: part.id,
            field: "text",
            delta: "streamed",
          })
          expect(
            streamed.some(
              (event) =>
                event.payload.type === "message.part.delta" && event.payload.properties.partID === part.id,
            ),
          ).toBe(true)
          expect(
            yield* sessions.getPart({ sessionID: created.id, messageID: message.id, partID: part.id }),
          ).toMatchObject({ text: "" })
          yield* sessions.updatePart({ ...part, text: "streamed" })
          expect(
            yield* sessions.getPart({ sessionID: created.id, messageID: message.id, partID: part.id }),
          ).toMatchObject({ text: "streamed" })
          const todos = yield* Todo.Service
          yield* todos.update({
            sessionID: created.id,
            todos: [{ content: "persist", status: "pending", priority: "high" }],
          })
          expect(yield* todos.get(created.id)).toEqual([{ content: "persist", status: "pending", priority: "high" }])
          const status = yield* SessionStatus.Service
          yield* status.set(created.id, { type: "busy" })
          expect(yield* status.get(created.id)).toEqual({ type: "busy" })
          const permission = yield* Permission.Service
          const permissionFiber = yield* permission
            .ask({
              sessionID: created.id,
              permission: "read",
              patterns: ["*"],
              always: [],
              metadata: {},
              ruleset: [{ permission: "read", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkScoped)
          const permissionRequest = yield* awaitFirst(() => permission.list())
          yield* permission.reply({ requestID: permissionRequest.id, reply: "once" })
          yield* Fiber.join(permissionFiber)
          expect(yield* permission.list()).toEqual([])
          const question = yield* Question.Service
          const questionFiber = yield* question
            .ask({ sessionID: created.id, questions: [{ question: "Continue?", header: "Continue", options: [] }] })
            .pipe(Effect.forkScoped)
          const questionRequest = yield* awaitFirst(() => question.list())
          yield* question.reply({ requestID: questionRequest.id, answers: [["yes"]] })
          expect(yield* Fiber.join(questionFiber)).toEqual([["yes"]])
          expect(yield* question.list()).toEqual([])
          yield* sessions.remove(created.id)
          expect((yield* sessions.list()).map((item) => item.id)).not.toContain(created.id)
        }).pipe(
          Effect.provideService(RequestScope.Current, scope),
          Effect.provide(
            LayerNode.compile(
              LayerNode.group([
                MysqlSession.node,
                MysqlTodo.node,
                MysqlSessionStatus.node,
                MysqlPermission.node,
                MysqlQuestion.node,
              ]),
            ),
          ),
        ),
      ),
    )
  })
})

function awaitFirst<A>(list: () => Effect.Effect<ReadonlyArray<A>>) {
  return Effect.gen(function* () {
    for (let index = 0; index < 100; index++) {
      const value = (yield* list())[0]
      if (value) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("Timed out waiting for pending MySQL request")
  })
}
