import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"
import { EffectDrizzleMysql } from "@opencode-ai/effect-drizzle-mysql"
import { MysqlMigration } from "@opencode-ai/core/persistence/mysql/migration"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

const MigrateCommand = effectCmd({
  command: "migrate",
  describe: "apply MySQL schema migrations",
  instance: false,
  handler: Effect.fn("Cli.db.migrate")(() =>
    Effect.scoped(
      Effect.gen(function* () {
        if (process.env.OPENCODE_DB_DIALECT !== "mysql") throw new Error("OPENCODE_DB_DIALECT=mysql is required")
        const url = required("MYSQL_URL")
        const mysql = yield* EffectDrizzleMysql.make({
          url,
          connectionLimit: number("MYSQL_POOL_MAX", 10),
          maxIdle: 2,
          idleTimeout: 60_000,
          connectTimeout: number("MYSQL_ACQUIRE_TIMEOUT_MS", 3_000),
        }).pipe(Effect.orDie)
        yield* MysqlMigration.migrate(mysql.pool).pipe(Effect.orDie)
        console.log(`MySQL schema migrated to ${MysqlMigration.latest}`)
      }),
    ),
  ),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(MigrateCommand).command(QueryCommand).command(PathCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})

function number(name: string, fallback: number) {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
