const SENSITIVE_KEY = /authorization|api[-_]?key|token|cookie|secret|publicKey|secretKey/i

function sanitize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.map(sanitize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "<redacted>" : sanitize(item)]),
  )
}

export function createLogger(input: { service: string }) {
  const write = (level: "debug" | "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>) => {
    const args = metadata ? [`[${input.service}] ${message}`, sanitize(metadata)] : [`[${input.service}] ${message}`]
    const method = level === "debug" ? "log" : level
    console[method](...args)
  }
  return {
    debug: (message: string, metadata?: Record<string, unknown>) => write("debug", message, metadata),
    info: (message: string, metadata?: Record<string, unknown>) => write("info", message, metadata),
    warn: (message: string, metadata?: Record<string, unknown>) => write("warn", message, metadata),
    error: (message: string, metadata?: Record<string, unknown>) => write("error", message, metadata),
  }
}
