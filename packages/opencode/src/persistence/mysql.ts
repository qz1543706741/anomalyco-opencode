import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MysqlRepository } from "@opencode-ai/core/persistence/mysql/repository"
import { MysqlMigration } from "@opencode-ai/core/persistence/mysql/migration"
import { EffectDrizzleMysql } from "@opencode-ai/effect-drizzle-mysql"
import { Effect, Layer } from "effect"

const url = process.env.MYSQL_URL
const instanceId = process.env.INSTANCE_ID

if (process.env.OPENCODE_DB_DIALECT === "mysql" && !url) throw new Error("MYSQL_URL is required for MySQL mode")
if (process.env.OPENCODE_DB_DIALECT === "mysql" && !instanceId)
  throw new Error("INSTANCE_ID is required for MySQL mode")

const mysql = EffectDrizzleMysql.layer({ url: url ?? "mysql://unused" })
// Keep one scoped pool shared by every repository service.
const layer = Layer.merge(
  MysqlRepository.layer({ instanceId: instanceId ?? "local" }),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const client = yield* EffectDrizzleMysql.Service
      yield* MysqlMigration.check(client.pool)
      yield* Effect.promise(async () => {
        const connection = await client.pool.getConnection()
        try {
          await connection.beginTransaction()
          const now = Date.now()
          const [rows] = await connection.execute(
            `SELECT user_id, session_id FROM oc_run WHERE owner_instance_id = ?
             AND status IN ('starting', 'running', 'waiting_permission', 'waiting_question') FOR UPDATE`,
            [instanceId],
          )
          if (!Array.isArray(rows)) throw new Error("Expected rows while recovering MySQL runs")
          await connection.execute(
            `UPDATE oc_run SET status = 'interrupted', finished_at = ?, updated_at = ?
             WHERE owner_instance_id = ?
               AND status IN ('starting', 'running', 'waiting_permission', 'waiting_question')`,
            [now, now, instanceId],
          )
          for (const row of rows) {
            if (!isRunRow(row)) continue
            await connection.execute(
              `UPDATE oc_session SET status = 'interrupted', status_json = ?, updated_at = ?
               WHERE user_id = ? AND id = ?`,
              [JSON.stringify({ type: "idle" }), now, String(row.user_id), String(row.session_id)],
            )
          }
          await connection.commit()
        } catch (cause) {
          await connection.rollback()
          throw cause
        } finally {
          connection.release()
        }
      })
    }),
  ),
).pipe(Layer.provide(mysql))

export const node = LayerNode.make({ name: "MysqlPersistence", layer, deps: [] })

function isRunRow(value: unknown): value is { readonly user_id: string; readonly session_id: string } {
  return typeof value === "object" && value !== null && "user_id" in value && "session_id" in value
}

export * as MysqlPersistence from "./mysql"
