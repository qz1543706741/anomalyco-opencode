import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { PersistenceError } from "@opencode-ai/core/persistence/error"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      if (error instanceof PersistenceError.StaleOwner)
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { code: "STALE_OWNER", message: "Owner generation is stale", current: error.current.toString() },
            { status: 409 },
          ),
        )
      if (error instanceof PersistenceError.IdempotencyConflict)
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { code: "IDEMPOTENCY_CONFLICT", message: "Request id was reused with a different payload" },
            { status: 409 },
          ),
        )
      if (error instanceof PersistenceError.RunIdRequired)
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { code: "RUN_ID_REQUIRED", message: "x-opencode-run-id is required" },
            { status: 400 },
          ),
        )
      if (error instanceof PersistenceError.SessionNotFound)
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe({ code: "NOT_FOUND", message: "Session not found" }, { status: 404 }),
        )
      if (error instanceof PersistenceError.Unavailable)
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { code: "PERSISTENCE_UNAVAILABLE", message: "MySQL persistence is unavailable" },
            { status: 503 },
          ),
        )
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      const ref = `err_${crypto.randomUUID().slice(0, 8)}`

      return Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            new NamedError.Unknown({
              message: "Unexpected server error. Check server logs for details.",
              ref,
            }).toObject(),
            { status: 500 },
          ),
        ),
      )
    }),
  ),
).layer
