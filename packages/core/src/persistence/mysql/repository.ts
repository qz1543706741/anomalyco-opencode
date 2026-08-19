export * as MysqlRepository from "./repository"

import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise"
import { EffectDrizzleMysql } from "@opencode-ai/effect-drizzle-mysql"
import { PersistenceError } from "../error"
import { EventRepository } from "../port/event"
import { FenceRepository } from "../port/fence"
import { ProjectionRepository } from "../port/projection"
import { SessionRepository } from "../port/session"
import type { RequestScope } from "../scope"

export interface Options {
  readonly instanceId: string
}

const sessionSelect = `SELECT id, user_id, owner_generation, project_id, workspace_id, parent_id, slug,
  directory, path, title, version, share_url, summary_json, metadata_json, cost, tokens_input,
  tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert_json, permission_json,
  agent, model_json, status, compacting_at, archived_at, created_at, updated_at`

export const layer = (options: Options) => {
  const fence = Layer.effect(
    FenceRepository.Service,
    Effect.gen(function* () {
      const mysql = yield* EffectDrizzleMysql.Service
      return make(mysql.pool, options).fence
    }),
  )
  const event = Layer.effect(
    EventRepository.Service,
    Effect.gen(function* () {
      const mysql = yield* EffectDrizzleMysql.Service
      return make(mysql.pool, options).event
    }),
  )
  const session = Layer.effect(
    SessionRepository.Service,
    Effect.gen(function* () {
      const mysql = yield* EffectDrizzleMysql.Service
      return make(mysql.pool, options).session
    }),
  )
  const projection = Layer.effect(
    ProjectionRepository.Service,
    Effect.gen(function* () {
      const mysql = yield* EffectDrizzleMysql.Service
      return make(mysql.pool, options).projection
    }),
  )
  return Layer.mergeAll(fence, event, session, projection)
}

function make(pool: Pool, options: Options) {
  const fence: FenceRepository.Interface = {
    claim: Effect.fn("MysqlFenceRepository.claim")((scope) =>
      transaction(pool, (connection) => claim(connection, scope, options.instanceId), true, fenceError),
    ),
  }
  const event: EventRepository.Interface = {
    append: Effect.fn("MysqlEventRepository.append")((scope, input) =>
      transaction(
        pool,
        async (connection) => {
          await claim(connection, scope, options.instanceId)
          return appendEvent(connection, scope, input)
        },
        true,
        fenceError,
      ),
    ),
    remove: Effect.fn("MysqlEventRepository.remove")((scope, aggregateId) =>
      transaction(
        pool,
        async (connection) => {
          await claim(connection, scope, options.instanceId)
          await connection.execute("DELETE FROM oc_event WHERE user_id = ? AND aggregate_id = ?", [
            scope.userId,
            aggregateId,
          ])
          await connection.execute("DELETE FROM oc_event_sequence WHERE user_id = ? AND aggregate_id = ?", [
            scope.userId,
            aggregateId,
          ])
        },
        true,
        fenceError,
      ),
    ),
  }
  const session: SessionRepository.Interface = {
    list: Effect.fn("MysqlSessionRepository.list")((scope) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<SessionRow[]>(
          `${sessionSelect} FROM oc_session WHERE user_id = ? ORDER BY updated_at DESC, id`,
          [scope.userId],
        )
        return rows.map(decodeSession)
      }),
    ),
    create: Effect.fn("MysqlSessionRepository.create")((scope, input) =>
      transaction(
        pool,
        async (connection) => {
          await claim(connection, scope, options.instanceId)
          const now = Date.now()
          await connection.execute(
            `INSERT INTO oc_project (id, name, directory, created_at, updated_at)
             VALUES ('cloud-virtual', 'cloud', '/', ?, ?)
             ON DUPLICATE KEY UPDATE id = id`,
            [now, now],
          )
          if (input.parentId) {
            const [parents] = await connection.execute<RowDataPacket[]>(
              "SELECT id FROM oc_session WHERE user_id = ? AND id = ? FOR UPDATE",
              [scope.userId, input.parentId],
            )
            if (!parents[0]) throw new PersistenceError.SessionNotFound({ sessionId: input.parentId })
          }
          await connection.execute(
            `INSERT INTO oc_session
              (id, user_id, owner_generation, project_id, parent_id, slug, directory, title, version,
               agent, model_json, metadata_json, permission_json, status, created_at, updated_at)
             VALUES (?, ?, ?, 'cloud-virtual', ?, ?, '/', ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
            [
              input.id,
              scope.userId,
              scope.generation.toString(),
              input.parentId ?? null,
              input.slug,
              input.title,
              input.version,
              input.agent ?? null,
              input.model === undefined ? null : JSON.stringify(input.model),
              input.metadata === undefined ? null : JSON.stringify(input.metadata),
              input.permission === undefined ? null : JSON.stringify(input.permission),
              now,
              now,
            ],
          )
          const value: SessionRepository.Session = {
            id: input.id,
            userId: scope.userId,
            generation: scope.generation,
            projectId: "cloud-virtual",
            parentId: input.parentId,
            slug: input.slug,
            directory: "/",
            title: input.title,
            version: input.version,
            metadata: input.metadata,
            permission: input.permission,
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            status: "idle",
            createdAt: now,
            updatedAt: now,
          }
          await appendEvent(connection, scope, input.event(value))
          return value
        },
        true,
        fenceError,
      ),
    ),
    get: Effect.fn("MysqlSessionRepository.get")((scope, sessionId) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<SessionRow[]>(
          `${sessionSelect} FROM oc_session WHERE user_id = ? AND id = ?`,
          [scope.userId, sessionId],
        )
        return rows[0] ? decodeSession(rows[0]) : undefined
      }),
    ),
    update: Effect.fn("MysqlSessionRepository.update")((scope, sessionId, input, event) =>
      transaction(
        pool,
        async (connection) => {
          await claim(connection, scope, options.instanceId)
          const [rows] = await connection.execute<SessionRow[]>(
            `${sessionSelect} FROM oc_session WHERE user_id = ? AND id = ? FOR UPDATE`,
            [scope.userId, sessionId],
          )
          if (!rows[0]) throw new PersistenceError.SessionNotFound({ sessionId })
          const now = Date.now()
          const updates = sessionUpdates(input)
          await connection.execute(
            `UPDATE oc_session SET ${updates.columns.join(", ")}, updated_at = ? WHERE user_id = ? AND id = ?`,
            [...updates.values, now, scope.userId, sessionId],
          )
          const [updated] = await connection.execute<SessionRow[]>(
            `${sessionSelect} FROM oc_session WHERE user_id = ? AND id = ?`,
            [scope.userId, sessionId],
          )
          const value = decodeSession(updated[0]!)
          await appendEvent(connection, scope, event(value))
          return value
        },
        true,
        fenceError,
      ),
    ),
    remove: Effect.fn("MysqlSessionRepository.remove")((scope, sessionId, event) =>
      transaction(
        pool,
        async (connection) => {
          await claim(connection, scope, options.instanceId)
          const [sessions] = await connection.execute<SessionRow[]>(
            `${sessionSelect} FROM oc_session WHERE user_id = ? AND id = ? FOR UPDATE`,
            [scope.userId, sessionId],
          )
          if (!sessions[0]) throw new PersistenceError.SessionNotFound({ sessionId })
          await connection.execute("DELETE FROM oc_event WHERE user_id = ? AND aggregate_id = ?", [
            scope.userId,
            sessionId,
          ])
          await connection.execute("DELETE FROM oc_event_sequence WHERE user_id = ? AND aggregate_id = ?", [
            scope.userId,
            sessionId,
          ])
          // Production MySQL forbids foreign keys, so ON DELETE CASCADE is unavailable and every
          // session-scoped table must be deleted explicitly. Parts come before messages because
          // they were cascaded through oc_part_message_fk, and inputs before runs for oc_session_input_run_fk.
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
          ])
            await connection.execute(`DELETE FROM ${table} WHERE user_id = ? AND session_id = ?`, [
              scope.userId,
              sessionId,
            ])
          const [result] = await connection.execute("DELETE FROM oc_session WHERE user_id = ? AND id = ?", [
            scope.userId,
            sessionId,
          ])
          if (!("affectedRows" in result) || result.affectedRows === 0)
            throw new PersistenceError.SessionNotFound({ sessionId })
          await appendEvent(connection, scope, event(decodeSession(sessions[0])))
        },
        true,
        fenceError,
      ),
    ),
    admit: Effect.fn("MysqlSessionRepository.admit")((scope, input) =>
      transaction(
        pool,
        async (connection) => {
          await claim(connection, scope, options.instanceId)
          const [sessions] = await connection.execute<RowDataPacket[]>(
            "SELECT id FROM oc_session WHERE user_id = ? AND id = ? FOR UPDATE",
            [scope.userId, input.sessionId],
          )
          if (!sessions[0]) throw new PersistenceError.SessionNotFound({ sessionId: input.sessionId })
          const payloadHash = createHash("sha256")
            .update(
              stable({
                id: input.id,
                sessionId: input.sessionId,
                prompt: input.prompt,
                delivery: input.delivery,
              }),
            )
            .digest("hex")
          const [stored] = await connection.execute<RowDataPacket[]>(
            `SELECT payload_hash, response FROM oc_request_dedup
             WHERE user_id = ? AND request_id = ? AND operation = 'session.admit' FOR UPDATE`,
            [scope.userId, scope.requestId],
          )
          if (stored[0]) {
            if (stored[0].payload_hash !== payloadHash)
              throw new PersistenceError.IdempotencyConflict({ requestId: scope.requestId })
            return json<SessionRepository.AdmissionResult>(stored[0].response)
          }
          const [runs] = await connection.execute<RowDataPacket[]>(
            `SELECT id FROM oc_run
             WHERE user_id = ? AND session_id = ? AND owner_generation = ?
               AND status IN ('starting', 'running', 'waiting_permission', 'waiting_question')
             ORDER BY started_at LIMIT 1 FOR UPDATE`,
            [scope.userId, input.sessionId, scope.generation.toString()],
          )
          const runId = runs[0]?.id ? String(runs[0].id) : scope.runId
          if (!runId) throw new PersistenceError.RunIdRequired()
          const now = Date.now()
          if (!runs[0])
            await connection.execute(
              `INSERT INTO oc_run
                (id, user_id, session_id, owner_generation, owner_instance_id, trigger_request_id,
                 status, started_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
              [
                runId,
                scope.userId,
                input.sessionId,
                scope.generation.toString(),
                options.instanceId,
                scope.requestId,
                now,
                now,
              ],
            )
          const committed = await appendEvent(connection, scope, {
            id: input.eventId,
            aggregateId: input.sessionId,
            type: "session.prompt_admitted",
            data: { sessionId: input.sessionId, inputId: input.id, runId, delivery: input.delivery },
          })
          await connection.execute(
            `INSERT INTO oc_session_input
              (id, user_id, owner_generation, session_id, run_id, request_id, prompt, payload_hash,
               delivery, admitted_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              input.id,
              scope.userId,
              scope.generation.toString(),
              input.sessionId,
              runId,
              scope.requestId,
              JSON.stringify(input.prompt),
              payloadHash,
              input.delivery,
              committed.seq,
              now,
            ],
          )
          await connection.execute(
            "UPDATE oc_session SET status = 'running', updated_at = ? WHERE user_id = ? AND id = ?",
            [now, scope.userId, input.sessionId],
          )
          const result = { inputId: input.id, runId, admittedSeq: committed.seq }
          await connection.execute(
            `INSERT INTO oc_request_dedup
              (user_id, request_id, operation, payload_hash, response, created_at)
             VALUES (?, ?, 'session.admit', ?, ?, ?)`,
            [scope.userId, scope.requestId, payloadHash, JSON.stringify(result), now],
          )
          return result
        },
        true,
        admitError,
      ),
    ),
  }
  const projection = makeProjection(pool, options)
  return { fence, event, session, projection }
}

function makeProjection(pool: Pool, options: Options): ProjectionRepository.Interface {
  const write = <A>(scope: RequestScope.Value, run: (connection: PoolConnection) => Promise<A>) =>
    transaction(
      pool,
      async (connection) => {
        await claim(connection, scope, options.instanceId)
        return run(connection)
      },
      true,
      fenceError,
    )
  const requireSession = async (connection: PoolConnection, scope: RequestScope.Value, sessionId: string) => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM oc_session WHERE user_id = ? AND id = ? FOR UPDATE",
      [scope.userId, sessionId],
    )
    if (!rows[0]) throw new PersistenceError.SessionNotFound({ sessionId })
  }
  return {
    messages: Effect.fn("MysqlProjectionRepository.messages")((scope, sessionId) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<ProjectionRow[]>(
          `SELECT id, session_id, data_json, created_at, updated_at
           FROM oc_message WHERE user_id = ? AND session_id = ? ORDER BY seq`,
          [scope.userId, sessionId],
        )
        if (rows.length === 0) {
          const [sessions] = await pool.execute<RowDataPacket[]>(
            "SELECT id FROM oc_session WHERE user_id = ? AND id = ?",
            [scope.userId, sessionId],
          )
          if (!sessions[0]) throw new PersistenceError.SessionNotFound({ sessionId })
        }
        return rows.map(decodeProjection)
      }).pipe(Effect.mapError(projectionReadError)),
    ),
    putMessage: Effect.fn("MysqlProjectionRepository.putMessage")((scope, input) =>
      write(scope, async (connection) => {
        const value = input.value
        await requireSession(connection, scope, value.sessionId)
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM oc_message WHERE user_id = ? AND session_id = ? FOR UPDATE",
          [scope.userId, value.sessionId],
        )
        await connection.execute(
          `INSERT INTO oc_message (id, session_id, user_id, seq, data_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), updated_at = VALUES(updated_at)`,
          [
            value.id,
            value.sessionId,
            scope.userId,
            Number(rows[0]?.seq),
            JSON.stringify(value.data),
            value.createdAt,
            value.updatedAt,
          ],
        )
        await appendEvent(connection, scope, input.event)
      }),
    ),
    putPart: Effect.fn("MysqlProjectionRepository.putPart")((scope, input) =>
      write(scope, async (connection) => {
        const value = input.value
        await requireSession(connection, scope, value.sessionId)
        const [messages] = await connection.execute<RowDataPacket[]>(
          "SELECT id FROM oc_message WHERE user_id = ? AND session_id = ? AND id = ? FOR UPDATE",
          [scope.userId, value.sessionId, value.messageId],
        )
        if (!messages[0]) throw new PersistenceError.SessionNotFound({ sessionId: value.sessionId })
        await connection.execute(
          `INSERT INTO oc_part
             (id, message_id, session_id, user_id, position, data_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE position = VALUES(position), data_json = VALUES(data_json), updated_at = VALUES(updated_at)`,
          [
            value.id,
            value.messageId,
            value.sessionId,
            scope.userId,
            value.position,
            JSON.stringify(value.data),
            value.createdAt,
            value.updatedAt,
          ],
        )
        await appendEvent(connection, scope, input.event)
      }),
    ),
    parts: Effect.fn("MysqlProjectionRepository.parts")((scope, sessionId, messageId) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<PartRow[]>(
          `SELECT id, message_id, session_id, position, data_json, created_at, updated_at
           FROM oc_part WHERE user_id = ? AND session_id = ? AND message_id = ? ORDER BY position`,
          [scope.userId, sessionId, messageId],
        )
        return rows.map((row) => ({
          ...decodeProjection(row),
          messageId: row.message_id,
          position: Number(row.position),
        }))
      }),
    ),
    removeMessage: Effect.fn("MysqlProjectionRepository.removeMessage")((scope, sessionId, messageId, event) =>
      write(scope, async (connection) => {
        await requireSession(connection, scope, sessionId)
        // Parts were cascaded through oc_part_message_fk, which production MySQL forbids.
        await connection.execute("DELETE FROM oc_part WHERE user_id = ? AND session_id = ? AND message_id = ?", [
          scope.userId,
          sessionId,
          messageId,
        ])
        await connection.execute("DELETE FROM oc_message WHERE user_id = ? AND session_id = ? AND id = ?", [
          scope.userId,
          sessionId,
          messageId,
        ])
        await appendEvent(connection, scope, event)
      }),
    ),
    removePart: Effect.fn("MysqlProjectionRepository.removePart")((scope, sessionId, messageId, partId, event) =>
      write(scope, async (connection) => {
        await requireSession(connection, scope, sessionId)
        await connection.execute(
          "DELETE FROM oc_part WHERE user_id = ? AND session_id = ? AND message_id = ? AND id = ?",
          [scope.userId, sessionId, messageId, partId],
        )
        await appendEvent(connection, scope, event)
      }),
    ),
    replaceTodos: Effect.fn("MysqlProjectionRepository.replaceTodos")((scope, sessionId, values, event) =>
      write(scope, async (connection) => {
        await requireSession(connection, scope, sessionId)
        await connection.execute("DELETE FROM oc_todo WHERE user_id = ? AND session_id = ?", [scope.userId, sessionId])
        const now = Date.now()
        for (const [position, value] of values.entries())
          await connection.execute(
            `INSERT INTO oc_todo
               (session_id, user_id, position, content, status, priority, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [sessionId, scope.userId, position, value.content, value.status, value.priority, now, now],
          )
        await appendEvent(connection, scope, event)
      }),
    ),
    todos: Effect.fn("MysqlProjectionRepository.todos")((scope, sessionId) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<TodoRow[]>(
          `SELECT content, status, priority FROM oc_todo
           WHERE user_id = ? AND session_id = ? ORDER BY position`,
          [scope.userId, sessionId],
        )
        return rows.map((row) => ({ content: row.content, status: row.status, priority: row.priority }))
      }),
    ),
    appendSessionMessage: Effect.fn("MysqlProjectionRepository.appendSessionMessage")((scope, value) =>
      write(scope, async (connection) => {
        await requireSession(connection, scope, value.sessionId)
        await connection.execute(
          `INSERT INTO oc_session_message
             (id, session_id, user_id, type, seq, data_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            value.id,
            value.sessionId,
            scope.userId,
            value.type,
            value.seq,
            JSON.stringify(value.data),
            value.createdAt,
            value.updatedAt,
          ],
        )
      }),
    ),
    sessionMessages: Effect.fn("MysqlProjectionRepository.sessionMessages")((scope, sessionId) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<SessionMessageRow[]>(
          `SELECT id, session_id, type, seq, data_json, created_at, updated_at
           FROM oc_session_message WHERE user_id = ? AND session_id = ? ORDER BY seq`,
          [scope.userId, sessionId],
        )
        return rows.map((row) => ({ ...decodeProjection(row), type: row.type, seq: Number(row.seq) }))
      }),
    ),
    putContextEpoch: Effect.fn("MysqlProjectionRepository.putContextEpoch")((scope, sessionId, value) =>
      write(scope, async (connection) => {
        await requireSession(connection, scope, sessionId)
        await connection.execute(
          `INSERT INTO oc_session_context_epoch
             (session_id, user_id, baseline, baseline_seq, snapshot_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE baseline = VALUES(baseline), baseline_seq = VALUES(baseline_seq),
             snapshot_json = VALUES(snapshot_json), updated_at = VALUES(updated_at)`,
          [sessionId, scope.userId, value.baseline, value.baselineSeq, JSON.stringify(value.snapshot), value.updatedAt],
        )
      }),
    ),
    getContextEpoch: Effect.fn("MysqlProjectionRepository.getContextEpoch")((scope, sessionId) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<ContextEpochRow[]>(
          `SELECT baseline, baseline_seq, snapshot_json, updated_at FROM oc_session_context_epoch
           WHERE user_id = ? AND session_id = ?`,
          [scope.userId, sessionId],
        )
        const row = rows[0]
        if (!row) return undefined
        return {
          baseline: row.baseline,
          baselineSeq: Number(row.baseline_seq),
          snapshot: json(row.snapshot_json),
          updatedAt: Number(row.updated_at),
        }
      }),
    ),
    setStatus: Effect.fn("MysqlProjectionRepository.setStatus")((scope, sessionId, status, event, outcome) =>
      write(scope, async (connection) => {
        await requireSession(connection, scope, sessionId)
        const type =
          typeof status === "object" && status !== null && "type" in status ? String(status.type) : String(status)
        const now = Date.now()
        const [sessions] = await connection.execute<RowDataPacket[]>(
          "SELECT status FROM oc_session WHERE user_id = ? AND id = ? FOR UPDATE",
          [scope.userId, sessionId],
        )
        const [runs] = await connection.execute<RowDataPacket[]>(
          `SELECT id FROM oc_run WHERE user_id = ? AND session_id = ? AND owner_generation = ?
             AND status IN ('starting', 'running', 'waiting_permission', 'waiting_question') FOR UPDATE`,
          [scope.userId, sessionId, scope.generation.toString()],
        )
        const previous = String(sessions[0]?.status)
        const terminal =
          outcome ??
          (runs[0]
            ? "completed"
            : ["completed", "failed", "interrupted", "aborted"].includes(previous)
              ? previous
              : "completed")
        await connection.execute(
          "UPDATE oc_session SET status = ?, status_json = ?, updated_at = ? WHERE user_id = ? AND id = ?",
          [type === "idle" ? terminal : type, JSON.stringify(status), now, scope.userId, sessionId],
        )
        if (type === "idle")
          await connection.execute(
            `UPDATE oc_run SET status = ?, finished_at = ?, updated_at = ?
             WHERE user_id = ? AND session_id = ? AND owner_generation = ?
               AND status IN ('starting', 'running', 'waiting_permission', 'waiting_question')`,
            [terminal, now, now, scope.userId, sessionId, scope.generation.toString()],
          )
        if (type !== "idle")
          await connection.execute(
            `UPDATE oc_run SET status = 'running', updated_at = ?
             WHERE user_id = ? AND session_id = ? AND owner_generation = ?
               AND status IN ('starting', 'running')`,
            [now, scope.userId, sessionId, scope.generation.toString()],
          )
        await appendEvent(connection, scope, event)
      }),
    ),
    listStatus: Effect.fn("MysqlProjectionRepository.listStatus")((scope) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<StatusRow[]>(
          `SELECT id, status, status_json FROM oc_session WHERE user_id = ?
             AND JSON_UNQUOTE(JSON_EXTRACT(status_json, '$.type')) <> 'idle'`,
          [scope.userId],
        )
        return new Map(rows.map((row) => [row.id, nullableJson(row.status_json) ?? { type: row.status }]))
      }),
    ),
    createPending: Effect.fn("MysqlProjectionRepository.createPending")((scope, kind, value, event) =>
      write(scope, async (connection) => {
        await requireSession(connection, scope, value.sessionId)
        await connection.execute(
          `INSERT INTO ${pendingTable(kind)}
             (id, session_id, user_id, status, payload_json, owner_generation, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [
            value.id,
            value.sessionId,
            scope.userId,
            JSON.stringify(value.data),
            scope.generation.toString(),
            value.createdAt,
            value.updatedAt,
          ],
        )
        const waiting = kind === "permission" ? "waiting_permission" : "waiting_question"
        await connection.execute(
          "UPDATE oc_session SET status = ?, status_json = ?, updated_at = ? WHERE user_id = ? AND id = ?",
          [waiting, JSON.stringify({ type: "busy" }), value.updatedAt, scope.userId, value.sessionId],
        )
        await connection.execute(
          `UPDATE oc_run SET status = ?, updated_at = ?
           WHERE user_id = ? AND session_id = ? AND owner_generation = ? AND status IN ('starting', 'running')`,
          [waiting, value.updatedAt, scope.userId, value.sessionId, scope.generation.toString()],
        )
        await appendEvent(connection, scope, event)
      }),
    ),
    resolvePending: Effect.fn("MysqlProjectionRepository.resolvePending")((scope, kind, id, status, response, event) =>
      write(scope, async (connection) => {
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT session_id FROM ${pendingTable(kind)} WHERE user_id = ? AND id = ? AND status = 'pending' FOR UPDATE`,
          [scope.userId, id],
        )
        const sessionId = rows[0]?.session_id ? String(rows[0].session_id) : undefined
        if (!sessionId) throw new PersistenceError.SessionNotFound({ sessionId: id })
        const [result] = await connection.execute(
          `UPDATE ${pendingTable(kind)} SET status = ?, response_json = ?, updated_at = ?
           WHERE user_id = ? AND id = ? AND status = 'pending'`,
          [status, response === undefined ? null : JSON.stringify(response), Date.now(), scope.userId, id],
        )
        if (!("affectedRows" in result) || result.affectedRows === 0)
          throw new PersistenceError.SessionNotFound({ sessionId: id })
        const now = Date.now()
        await connection.execute(
          "UPDATE oc_session SET status = 'running', status_json = ?, updated_at = ? WHERE user_id = ? AND id = ?",
          [JSON.stringify({ type: "busy" }), now, scope.userId, sessionId],
        )
        await connection.execute(
          `UPDATE oc_run SET status = 'running', updated_at = ?
           WHERE user_id = ? AND session_id = ? AND owner_generation = ?
             AND status IN ('waiting_permission', 'waiting_question')`,
          [now, scope.userId, sessionId, scope.generation.toString()],
        )
        if (event) await appendEvent(connection, scope, event)
      }),
    ),
    listPending: Effect.fn("MysqlProjectionRepository.listPending")((scope, kind) =>
      readAttempt(async () => {
        const [rows] = await pool.execute<PendingRow[]>(
          `SELECT id, session_id, status, payload_json AS data_json, response_json, created_at, updated_at
           FROM ${pendingTable(kind)} WHERE user_id = ? AND status = 'pending' ORDER BY created_at, id`,
          [scope.userId],
        )
        return rows.map((row) => ({ ...decodeProjection(row), status: row.status, response: json(row.response_json) }))
      }),
    ),
  }
}

function pendingTable(kind: "permission" | "question") {
  return kind === "permission" ? "oc_permission_request" : "oc_question_request"
}

function projectionReadError(cause: PersistenceError.Unavailable) {
  return cause.cause instanceof PersistenceError.SessionNotFound ? cause.cause : cause
}

async function claim(connection: PoolConnection, scope: RequestScope.Value, instanceId: string) {
  const now = Date.now()
  await connection.execute(
    `INSERT INTO oc_user_fence (user_id, generation, owner_instance_id, updated_at)
     VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id`,
    [scope.userId, scope.generation.toString(), instanceId, now],
  )
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT generation FROM oc_user_fence WHERE user_id = ? FOR UPDATE",
    [scope.userId],
  )
  const current = BigInt(String(rows[0]?.generation))
  if (scope.generation < current) throw new PersistenceError.StaleOwner({ current, attempted: scope.generation })
  if (scope.generation === current) return
  await connection.execute(
    "UPDATE oc_user_fence SET generation = ?, owner_instance_id = ?, updated_at = ? WHERE user_id = ?",
    [scope.generation.toString(), instanceId, now, scope.userId],
  )
  await connection.execute(
    `UPDATE oc_run SET status = 'interrupted', updated_at = ?
     WHERE user_id = ? AND owner_generation < ?
       AND status IN ('starting', 'running', 'waiting_permission', 'waiting_question')`,
    [now, scope.userId, scope.generation.toString()],
  )
}

async function appendEvent(
  connection: PoolConnection,
  scope: RequestScope.Value,
  input: EventRepository.AppendInput,
): Promise<EventRepository.Committed> {
  const [existing] = await connection.execute<RowDataPacket[]>(
    "SELECT aggregate_id, seq, type, data FROM oc_event WHERE user_id = ? AND id = ? FOR UPDATE",
    [scope.userId, input.id],
  )
  if (existing[0]) {
    if (
      existing[0].aggregate_id !== input.aggregateId ||
      existing[0].type !== input.type ||
      stable(json(existing[0].data)) !== stable(input.data)
    )
      throw new PersistenceError.IdempotencyConflict({ requestId: input.id })
    return { id: input.id, aggregateId: input.aggregateId, seq: Number(existing[0].seq) }
  }
  await connection.execute(
    `INSERT INTO oc_event_sequence (user_id, aggregate_id, seq) VALUES (?, ?, -1)
     ON DUPLICATE KEY UPDATE aggregate_id = aggregate_id`,
    [scope.userId, input.aggregateId],
  )
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT seq FROM oc_event_sequence WHERE user_id = ? AND aggregate_id = ? FOR UPDATE",
    [scope.userId, input.aggregateId],
  )
  const seq = Number(rows[0]?.seq) + 1
  await connection.execute("UPDATE oc_event_sequence SET seq = ? WHERE user_id = ? AND aggregate_id = ?", [
    seq,
    scope.userId,
    input.aggregateId,
  ])
  await connection.execute("UPDATE oc_event_sequence SET owner_generation = ? WHERE user_id = ? AND aggregate_id = ?", [
    scope.generation.toString(),
    scope.userId,
    input.aggregateId,
  ])
  await connection.execute(
    `INSERT INTO oc_event (id, user_id, aggregate_id, seq, type, data, owner_generation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      scope.userId,
      input.aggregateId,
      seq,
      input.type,
      JSON.stringify(input.data),
      scope.generation.toString(),
      Date.now(),
    ],
  )
  return { id: input.id, aggregateId: input.aggregateId, seq }
}

function transaction<A, E>(
  pool: Pool,
  run: (connection: PoolConnection) => Promise<A>,
  retry: boolean,
  error: (cause: unknown) => E,
) {
  return Effect.tryPromise({
    try: async () => {
      for (let index = 0; ; index++) {
        const connection = await pool.getConnection()
        try {
          await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
          await connection.beginTransaction()
          const result = await run(connection)
          await connection.commit()
          return result
        } catch (cause) {
          await connection.rollback()
          if (!retry || index === 2 || !retryable(cause)) throw cause
          await Bun.sleep([50, 100, 200][index])
        } finally {
          connection.release()
        }
      }
    },
    catch: error,
  })
}

function fenceError(cause: unknown) {
  return cause instanceof PersistenceError.StaleOwner ? cause : new PersistenceError.Unavailable({ cause })
}

function admitError(cause: unknown) {
  return cause instanceof PersistenceError.StaleOwner ||
    cause instanceof PersistenceError.SessionNotFound ||
    cause instanceof PersistenceError.IdempotencyConflict ||
    cause instanceof PersistenceError.RunIdRequired
    ? cause
    : new PersistenceError.Unavailable({ cause })
}

function retryable(cause: unknown) {
  return typeof cause === "object" && cause !== null && "errno" in cause && [1205, 1213].includes(Number(cause.errno))
}

interface SessionRow extends RowDataPacket {
  readonly id: string
  readonly user_id: string
  readonly owner_generation: string
  readonly project_id: string
  readonly workspace_id: string | null
  readonly parent_id: string | null
  readonly slug: string
  readonly directory: string
  readonly path: string | null
  readonly title: string
  readonly version: string
  readonly share_url: string | null
  readonly summary_json: unknown
  readonly metadata_json: unknown
  readonly cost: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly tokens_reasoning: number
  readonly tokens_cache_read: number
  readonly tokens_cache_write: number
  readonly revert_json: unknown
  readonly permission_json: unknown
  readonly agent: string | null
  readonly model_json: unknown
  readonly status: string
  readonly compacting_at: number | null
  readonly archived_at: number | null
  readonly created_at: number
  readonly updated_at: number
}

function decodeSession(row: SessionRow): SessionRepository.Session {
  return {
    id: row.id,
    userId: row.user_id,
    generation: BigInt(row.owner_generation),
    projectId: row.project_id,
    workspaceId: row.workspace_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    slug: row.slug,
    directory: row.directory,
    path: row.path ?? undefined,
    title: row.title,
    version: row.version,
    shareUrl: row.share_url ?? undefined,
    summary: nullableJson(row.summary_json),
    metadata: nullableJson(row.metadata_json),
    cost: Number(row.cost),
    tokens: {
      input: Number(row.tokens_input),
      output: Number(row.tokens_output),
      reasoning: Number(row.tokens_reasoning),
      cacheRead: Number(row.tokens_cache_read),
      cacheWrite: Number(row.tokens_cache_write),
    },
    revert: nullableJson(row.revert_json),
    permission: nullableJson(row.permission_json),
    agent: row.agent ?? undefined,
    model: nullableJson(row.model_json),
    status: row.status,
    compactingAt: row.compacting_at === null ? undefined : Number(row.compacting_at),
    archivedAt: row.archived_at === null ? undefined : Number(row.archived_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function sessionUpdates(input: SessionRepository.PatchInput) {
  const columns: string[] = []
  const values: unknown[] = []
  const add = (column: string, value: unknown) => {
    columns.push(`${column} = ?`)
    values.push(value)
  }
  if (input.title !== undefined) add("title", input.title)
  if (input.status !== undefined) add("status", input.status)
  if (input.archivedAt !== undefined) add("archived_at", input.archivedAt)
  if (input.metadata !== undefined) add("metadata_json", encodeNullable(input.metadata))
  if (input.permission !== undefined) add("permission_json", encodeNullable(input.permission))
  if (input.agent !== undefined) add("agent", input.agent)
  if (input.model !== undefined) add("model_json", encodeNullable(input.model))
  if (input.revert !== undefined) add("revert_json", encodeNullable(input.revert))
  if (input.summary !== undefined) add("summary_json", encodeNullable(input.summary))
  if (input.shareUrl !== undefined) add("share_url", input.shareUrl)
  if (input.compactingAt !== undefined) add("compacting_at", input.compactingAt)
  if (columns.length === 0) columns.push("id = id")
  return { columns, values }
}

function encodeNullable(value: unknown) {
  return value === null ? null : JSON.stringify(value)
}

function nullableJson(value: unknown) {
  return value === null || value === undefined ? undefined : json(value)
}

interface ProjectionRow extends RowDataPacket {
  readonly id: string
  readonly session_id: string
  readonly data_json: unknown
  readonly created_at: number
  readonly updated_at: number
}

interface PendingRow extends ProjectionRow {
  readonly status: string
  readonly response_json: unknown
}

interface PartRow extends ProjectionRow {
  readonly message_id: string
  readonly position: number
}

interface SessionMessageRow extends ProjectionRow {
  readonly type: string
  readonly seq: number
}

interface ContextEpochRow extends RowDataPacket {
  readonly baseline: string
  readonly baseline_seq: number
  readonly snapshot_json: unknown
  readonly updated_at: number
}

interface TodoRow extends RowDataPacket {
  readonly content: string
  readonly status: string
  readonly priority: string
}

interface StatusRow extends RowDataPacket {
  readonly id: string
  readonly status: string
  readonly status_json: unknown
}

function decodeProjection(row: ProjectionRow): ProjectionRepository.RecordValue {
  return {
    id: row.id,
    sessionId: row.session_id,
    data: json(row.data_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function readAttempt<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new PersistenceError.Unavailable({ cause }),
  })
}

function json<A>(value: unknown) {
  return (typeof value === "string" ? JSON.parse(value) : value) as A
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
