import type { Server } from "node:http"

/**
 * Bun's `node:http` compatibility layer never emits "close" on the `ServerResponse` when a client
 * disconnects; it only emits it on the `IncomingMessage`. `NodeHttpServer.makeHandler` listens on the
 * response to interrupt the request fiber, so on Bun a disconnected streaming client leaves its fiber
 * running forever and its scope finalizers never run, leaking every subscription the handler acquired.
 * Destroying the response restores the "close" event on both runtimes.
 */
export function bridgeClientDisconnect(server: Server) {
  if (typeof Bun === "undefined") return server
  server.on("request", (request, response) => {
    // Bun also emits request "close" once the request body is consumed, with `request.destroyed`
    // already true, so only the socket state distinguishes a real disconnect from a slow handler
    // that has not written its response yet.
    request.on("close", () => {
      if (!request.socket || (request.socket.destroyed && !request.socket.writable)) response.destroy()
    })
  })
  return server
}
