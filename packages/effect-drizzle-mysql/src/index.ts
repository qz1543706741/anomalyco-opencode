export * as EffectDrizzleMysql from "."

import { drizzle } from "drizzle-orm/mysql2"
import { Context, Effect, Layer, Schema } from "effect"
import { createPool } from "mysql2/promise"
import type { Pool } from "mysql2/promise"

export interface Config {
  readonly url: string
  readonly connectionLimit?: number
  readonly maxIdle?: number
  readonly idleTimeout?: number
  readonly connectTimeout?: number
}

const makeClient = (pool: Pool) => drizzle({ client: pool })

export interface Interface {
  readonly pool: Pool
  readonly db: ReturnType<typeof makeClient>
}

export class ConnectionError extends Schema.TaggedErrorClass<ConnectionError>()("Mysql.ConnectionError", {
  cause: Schema.Defect(),
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/effect-drizzle-mysql") {}

export const make = (config: Config) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const pool = createPool({
          uri: config.url,
          waitForConnections: true,
          connectionLimit: config.connectionLimit ?? 10,
          maxIdle: config.maxIdle ?? 2,
          idleTimeout: config.idleTimeout ?? 60_000,
          connectTimeout: config.connectTimeout ?? 3_000,
          supportBigNumbers: true,
          bigNumberStrings: true,
          enableKeepAlive: true,
        })
        return { pool, db: makeClient(pool) }
      },
      catch: (cause) => new ConnectionError({ cause }),
    }),
    (client) => Effect.promise(() => client.pool.end()),
  )

export const layer = (config: Config) => Layer.effect(Service, make(config))
