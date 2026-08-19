import { randomUUID } from "node:crypto"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

export class RequestScopeMiddleware extends HttpApiMiddleware.Service<
  RequestScopeMiddleware,
  { provides: RequestScope.Service }
>()("@opencode/ExperimentalHttpApiRequestScope", {
  error: InvalidRequestError,
}) {}

export const requestScopeLayer = Layer.succeed(
  RequestScopeMiddleware,
  RequestScopeMiddleware.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const needsScope =
        process.env.OPENCODE_DB_DIALECT === "mysql" &&
        (new URL(request.url, "http://localhost").pathname === "/global/event" ||
          !new URL(request.url, "http://localhost").pathname.startsWith("/global/"))
      const scope = needsScope ? yield* decode(request) : local()
      return yield* effect.pipe(
        Effect.provideService(RequestScope.Service, scope),
        Effect.provideService(RequestScope.Current, scope),
      )
    }),
  ),
)

function decode(request: HttpServerRequest.HttpServerRequest) {
  return Effect.try({
    try: () => {
      const scope = RequestScope.decode(new Headers(request.headers))
      if (requiresRun(request) && !scope.runId) throw new RequestScope.InvalidError({ header: "x-opencode-run-id" })
      return scope
    },
    catch: (cause) =>
      new InvalidRequestError({
        message: cause instanceof RequestScope.InvalidError ? `Invalid ${cause.header}` : "Invalid persistence scope",
        kind: "Header",
        field: cause instanceof RequestScope.InvalidError ? cause.header : undefined,
      }),
  })
}

function requiresRun(request: HttpServerRequest.HttpServerRequest) {
  if (request.method !== "POST") return false
  return /^\/session\/[^/]+\/(message|prompt_async|command|shell|init|summarize)$/.test(
    new URL(request.url, "http://localhost").pathname,
  )
}

function local(): RequestScope.Value {
  return { userId: "local", generation: 1n, requestId: randomUUID() }
}
