import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { EffectDrizzleMysql } from "@opencode-ai/effect-drizzle-mysql"
import { MysqlMigration } from "@opencode-ai/core/persistence/mysql/migration"
import { MysqlRepository } from "@opencode-ai/core/persistence/mysql/repository"
import { FenceRepository } from "@opencode-ai/core/persistence/port/fence"
import { ProjectionRepository } from "@opencode-ai/core/persistence/port/projection"
import { SessionRepository } from "@opencode-ai/core/persistence/port/session"

const url = process.env.MYSQL_TEST_URL
const userId = `test-${randomUUID()}`
let migrated = false

describe.skipIf(!url)("MySQL persistence", () => {
  const mysql = EffectDrizzleMysql.layer({ url: url! })
  const repositories = MysqlRepository.layer({ instanceId: "mysql-test" }).pipe(Layer.provide(mysql))

  test("migrates, scopes sessions, deduplicates admission, and fences stale owners", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* EffectDrizzleMysql.Service
          yield* MysqlMigration.migrate(client.pool)
          yield* MysqlMigration.check(client.pool)
          migrated = true
        }).pipe(Effect.provide(mysql)),
      ),
    )
    const sessionId = randomUUID()
    const inputId = randomUUID()
    const requestId = randomUUID()
    const runId = randomUUID()
    const scope = { userId, generation: 10n, requestId, runId }
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionRepository.Service
        const fence = yield* FenceRepository.Service
        const projections = yield* ProjectionRepository.Service
        const created = yield* sessions.create(scope, {
          id: sessionId,
          title: "mysql spike",
          slug: "mysql-spike",
          version: "test",
          event: (value) => ({
            id: randomUUID(),
            aggregateId: value.id,
            type: "session.created.1",
            data: { sessionID: value.id },
          }),
        })
        expect(created.userId).toBe(userId)
        expect((yield* sessions.list(scope)).map((item) => item.id)).toContain(sessionId)
        expect(yield* sessions.get({ ...scope, userId: `${userId}-other` }, sessionId)).toBeUndefined()
        const now = Date.now()
        const messageId = randomUUID()
        yield* projections.putMessage(scope, {
          value: { id: messageId, sessionId, data: { role: "user" }, createdAt: now, updatedAt: now },
          event: { id: randomUUID(), aggregateId: sessionId, type: "message.updated.1", data: { messageId } },
        })
        const partId = randomUUID()
        yield* projections.putPart(scope, {
          value: {
            id: partId,
            messageId,
            sessionId,
            position: 0,
            data: { type: "text", text: "hello" },
            createdAt: now,
            updatedAt: now,
          },
          event: { id: randomUUID(), aggregateId: sessionId, type: "message.part.updated.1", data: { partId } },
        })
        expect((yield* projections.messages(scope, sessionId)).map((item) => item.id)).toEqual([messageId])
        expect((yield* projections.parts(scope, sessionId, messageId)).map((item) => item.id)).toEqual([partId])
        expect(
          yield* projections.messages({ ...scope, userId: `${userId}-other` }, sessionId).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "Persistence.SessionNotFound",
        })
        yield* projections.replaceTodos(
          scope,
          sessionId,
          [{ content: "persist", status: "pending", priority: "high" }],
          { id: randomUUID(), aggregateId: sessionId, type: "todo.updated", data: {} },
        )
        expect(yield* projections.todos(scope, sessionId)).toEqual([
          { content: "persist", status: "pending", priority: "high" },
        ])
        const sessionMessageId = randomUUID()
        yield* projections.appendSessionMessage(scope, {
          id: sessionMessageId,
          sessionId,
          type: "user",
          seq: 0,
          data: { text: "hello" },
          createdAt: now,
          updatedAt: now,
        })
        expect((yield* projections.sessionMessages(scope, sessionId)).map((item) => item.id)).toEqual([
          sessionMessageId,
        ])
        yield* projections.putContextEpoch(scope, sessionId, {
          baseline: "base",
          baselineSeq: 0,
          snapshot: { sources: [] },
          updatedAt: now,
        })
        expect(yield* projections.getContextEpoch(scope, sessionId)).toMatchObject({ baseline: "base", baselineSeq: 0 })
        yield* projections.setStatus(
          scope,
          sessionId,
          { type: "busy" },
          {
            id: randomUUID(),
            aggregateId: sessionId,
            type: "session.status",
            data: { type: "busy" },
          },
        )
        expect((yield* projections.listStatus(scope)).get(sessionId)).toEqual({ type: "busy" })
        const permissionId = randomUUID()
        yield* projections.createPending(
          scope,
          "permission",
          { id: permissionId, sessionId, data: { permission: "read" }, createdAt: now, updatedAt: now },
          { id: randomUUID(), aggregateId: sessionId, type: "permission.asked", data: { permissionId } },
        )
        expect((yield* projections.listPending(scope, "permission")).map((item) => item.id)).toEqual([permissionId])
        yield* projections.resolvePending(scope, "permission", permissionId, "replied", { reply: "once" })
        expect(yield* projections.listPending(scope, "permission")).toEqual([])
        const admitted = yield* sessions.admit(scope, {
          id: inputId,
          sessionId,
          prompt: { text: "hello" },
          delivery: "steer",
          eventId: randomUUID(),
        })
        const retried = yield* sessions.admit(scope, {
          id: inputId,
          sessionId,
          prompt: { text: "hello" },
          delivery: "steer",
          eventId: randomUUID(),
        })
        expect(retried).toEqual(admitted)
        yield* fence.claim({ ...scope, generation: 11n })
        expect(yield* Effect.flip(fence.claim(scope))).toMatchObject({
          _tag: "Persistence.StaleOwner",
        })
      }).pipe(Effect.provide(repositories)),
    )
  })

  test("removes every session-scoped row without relying on foreign key cascade", async () => {
    const sessionId = randomUUID()
    const scope = { userId, generation: 20n, requestId: randomUUID(), runId: randomUUID() }
    const now = Date.now()
    const messageId = randomUUID()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* EffectDrizzleMysql.Service
          yield* MysqlMigration.migrate(client.pool)
          migrated = true
          const sessions = yield* SessionRepository.Service
          const projections = yield* ProjectionRepository.Service
          yield* sessions.create(scope, {
            id: sessionId,
            title: "cascade",
            slug: "cascade",
            version: "test",
            event: (value) => ({
              id: randomUUID(),
              aggregateId: value.id,
              type: "session.created.1",
              data: { sessionID: value.id },
            }),
          })
          yield* projections.putMessage(scope, {
            value: { id: messageId, sessionId, data: { role: "user" }, createdAt: now, updatedAt: now },
            event: { id: randomUUID(), aggregateId: sessionId, type: "message.updated.1", data: { messageId } },
          })
          yield* projections.putPart(scope, {
            value: {
              id: randomUUID(),
              messageId,
              sessionId,
              position: 0,
              data: { type: "text", text: "hello" },
              createdAt: now,
              updatedAt: now,
            },
            event: { id: randomUUID(), aggregateId: sessionId, type: "message.part.updated.1", data: {} },
          })
          yield* projections.appendSessionMessage(scope, {
            id: randomUUID(),
            sessionId,
            type: "user",
            seq: 0,
            data: { text: "hello" },
            createdAt: now,
            updatedAt: now,
          })
          yield* projections.replaceTodos(scope, sessionId, [{ content: "x", status: "pending", priority: "high" }], {
            id: randomUUID(),
            aggregateId: sessionId,
            type: "todo.updated",
            data: {},
          })
          yield* projections.putContextEpoch(scope, sessionId, {
            baseline: "base",
            baselineSeq: 0,
            snapshot: { sources: [] },
            updatedAt: now,
          })
          for (const kind of ["permission", "question"] as const)
            yield* projections.createPending(
              scope,
              kind,
              { id: randomUUID(), sessionId, data: {}, createdAt: now, updatedAt: now },
              { id: randomUUID(), aggregateId: sessionId, type: `${kind}.asked`, data: {} },
            )
          yield* sessions.admit(scope, {
            id: randomUUID(),
            sessionId,
            prompt: { text: "hello" },
            delivery: "steer",
            eventId: randomUUID(),
          })
          yield* sessions.remove(scope, sessionId, (value) => ({
            id: randomUUID(),
            aggregateId: value.id,
            type: "session.deleted.1",
            data: { sessionID: value.id },
          }))
          // Production MySQL forbids foreign keys, so nothing may survive on cascade alone.
          for (const table of [
            "oc_part",
            "oc_message",
            "oc_session_message",
            "oc_session_input",
            "oc_run",
            "oc_todo",
            "oc_session_context_epoch",
            "oc_permission_request",
            "oc_question_request",
          ]) {
            const rows = yield* Effect.promise(() =>
              client.pool
                .execute(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ? AND session_id = ?`, [
                  scope.userId,
                  sessionId,
                ])
                .then(([result]) => result as { total: number }[]),
            )
            expect({ table, total: Number(rows[0]!.total) }).toEqual({ table, total: 0 })
          }
        }).pipe(Effect.provide(Layer.merge(repositories, mysql))),
      ),
    )
  })

  afterAll(async () => {
    if (!url || !migrated) return
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* EffectDrizzleMysql.Service
          yield* Effect.promise(async () => {
            await client.pool.execute("DELETE FROM oc_request_dedup WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_permission_request WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_question_request WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_part WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_message WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_session_message WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_todo WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_session_context_epoch WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_session_input WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_event WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_event_sequence WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_run WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_session WHERE user_id = ?", [userId])
            await client.pool.execute("DELETE FROM oc_user_fence WHERE user_id = ?", [userId])
          })
        }).pipe(Effect.provide(mysql)),
      ),
    )
  })
})
