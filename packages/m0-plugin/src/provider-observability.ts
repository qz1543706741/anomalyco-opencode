import { createLogger } from "./logger"

export type ProviderHttpEvent = {
  providerID: string
  reqID: string
  sessionID?: string
  userMsgID?: string
  callKey?: string
  method: string
  url: string
  status: number
  requestHeaders?: Record<string, string>
  responseHeaders: Record<string, string>
  error?: string
}

export type ProviderObservability = ReturnType<typeof createProviderObservability>

export function createProviderObservability() {
  const log = createLogger({ service: "m0.provider-observability" })
  const listeners = new Set<(event: ProviderHttpEvent) => void | Promise<void>>()
  return {
    emit(event: ProviderHttpEvent) {
      for (const listener of listeners) {
        Promise.resolve()
          .then(() => listener(event))
          .catch((error) => log.warn("listener failed", { error }))
      }
    },
    subscribe(listener: (event: ProviderHttpEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
