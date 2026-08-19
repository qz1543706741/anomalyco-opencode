export * as MysqlMigration from "./migration"

import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise"
import { InstallationVersion } from "../../installation/version"
import { PersistenceError } from "../error"
import { statements as spikeStatements, version as spikeVersion } from "./migration/0001_spike"
import { statements as repositoryStatements, version as repositoryVersion } from "./migration/0002_full_repository"
import { statements as facadeStatements, version as facadeVersion } from "./migration/0003_runtime_facades"
import {
  plan as foreignKeyPlan,
  query as foreignKeyQuery,
  statements as foreignKeyStatements,
  version as foreignKeyVersion,
} from "./migration/0004_drop_foreign_keys"

const migrations = [
  { version: spikeVersion, statements: spikeStatements },
  { version: repositoryVersion, statements: repositoryStatements },
  { version: facadeVersion, statements: facadeStatements },
  { version: foreignKeyVersion, statements: foreignKeyStatements },
] as const

export const latest = foreignKeyVersion

export const migrate = Effect.fn("MysqlMigration.migrate")((pool: Pool) =>
  withConnection(pool, async (connection) => {
    const [lock] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('opencode-schema-migrate', 60) AS acquired")
    if (Number(lock[0]?.acquired) !== 1) throw new Error("Timed out acquiring MySQL migration lock")
    try {
      await connection.query(`CREATE TABLE IF NOT EXISTS oc_schema_migration (
        version VARCHAR(64) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at BIGINT NOT NULL,
        binary_version VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      for (const migration of migrations) {
        const checksum = createHash("sha256").update(migration.statements.join("\n")).digest("hex")
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT checksum FROM oc_schema_migration WHERE version = ?",
          [migration.version],
        )
        if (rows[0]?.checksum && rows[0].checksum !== checksum)
          throw new Error(`Migration checksum mismatch for ${migration.version}`)
        if (rows.length > 0) continue
        // 0004 declares its intent as fixed statements for checksum stability, but must execute only
        // the drops this database actually has.
        const executable =
          migration.version === foreignKeyVersion
            ? foreignKeyPlan(
                await connection
                  .query<RowDataPacket[]>(foreignKeyQuery)
                  .then(([found]) => found as { table_name: string; constraint_name: string }[]),
              )
            : migration.statements
        for (const statement of executable) await connection.query(statement)
        await connection.execute(
          "INSERT INTO oc_schema_migration (version, checksum, applied_at, binary_version) VALUES (?, ?, ?, ?)",
          [migration.version, checksum, Date.now(), InstallationVersion],
        )
      }
    } finally {
      await connection.query("SELECT RELEASE_LOCK('opencode-schema-migrate')")
    }
  }),
)

// Line environments were built by hand at 0003 and already have no foreign keys, so they satisfy
// 0004 semantically even before the row is backfilled. Accept both until that backfill ships.
export const check = Effect.fn("MysqlMigration.check")(function* (
  pool: Pool,
  minimum = facadeVersion,
  maximum = foreignKeyVersion,
) {
  const actual = yield* queryVersion(pool)
  if (actual < minimum || actual > maximum)
    return yield* new PersistenceError.SchemaVersionMismatch({ actual, minimum, maximum })
})

function queryVersion(pool: Pool) {
  return Effect.tryPromise({
    try: async () => {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT version FROM oc_schema_migration ORDER BY applied_at DESC, version DESC LIMIT 1",
      )
      return String(rows[0]?.version ?? "missing")
    },
    catch: (cause) => new PersistenceError.Unavailable({ cause }),
  })
}

function withConnection(pool: Pool, run: (connection: PoolConnection) => Promise<void>) {
  return Effect.tryPromise({
    try: async () => {
      const connection = await pool.getConnection()
      try {
        await run(connection)
      } finally {
        connection.release()
      }
    },
    catch: (cause) => new PersistenceError.Unavailable({ cause }),
  })
}
