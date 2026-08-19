import { createLogger } from "../../logger"
import { WANQING_ONLINE_REASONING_PROVIDER_ID, type GeminiAdapter } from "./types"

const log = createLogger({ service: "plugin.wanqing.gemini.thinking-config" })

// Inject thinking_config only when the wanqing-online-reasoning provider is in use.
export function createThinkingConfigAdapter(): GeminiAdapter {
  return {
    prepareRequest(body, ctx) {
      if (ctx.providerID !== WANQING_ONLINE_REASONING_PROVIDER_ID) return
      body.extra_body = {
        ...body.extra_body,
        google: {
          ...body.extra_body?.google,
          thinking_config: {
            include_thoughts: true,
            thinking_level: "high",
          },
        },
      }
      log.info("injected thinking_config", { providerID: ctx.providerID })
    },
  }
}

// Gemini accepts an OpenAPI 3.0 subset. Anything outside this whitelist is dropped or transformed.
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "default",
  "anyOf",
  "propertyOrdering",
  "additionalProperties",
])

const GEMINI_FORMAT_WHITELIST: Record<string, Set<string>> = {
  string: new Set(["enum", "date-time"]),
  integer: new Set(["int32", "int64"]),
  number: new Set(["float", "double"]),
}

const sanitizeLog = createLogger({ service: "plugin.wanqing.gemini.schema-sanitizer" })

export function createSchemaSanitizerAdapter(): GeminiAdapter {
  return {
    prepareRequest(body) {
      let count = 0
      for (const item of body.tools ?? []) {
        if (item.function?.parameters) {
          item.function.parameters = sanitizeGeminiSchema(item.function.parameters)
          count++
        }
      }
      if (count) sanitizeLog.info("sanitized tool schemas", { count })
    },
  }
}

export function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema)
  if (!isRecord(value)) return value

  const notes: string[] = []
  const result: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue
    if (key === "properties" && isRecord(item)) {
      // properties values are nested schemas keyed by arbitrary property names — preserve keys.
      result[key] = Object.fromEntries(Object.entries(item).map(([name, sub]) => [name, sanitizeGeminiSchema(sub)]))
    } else {
      result[key] = sanitizeGeminiSchema(item)
    }
  }

  // type: ["string","null"] -> type: "string" + nullable: true
  if (Array.isArray(result.type)) {
    const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string")
    const nonNull = types.filter((t) => t !== "null")
    if (types.includes("null")) result.nullable = true
    result.type = nonNull[0]
  }

  // const -> enum (string) or description note
  if ("const" in value) {
    const constant = (value as Record<string, unknown>).const
    if (typeof constant === "string") {
      if (!("enum" in result)) result.enum = [constant]
    } else if (constant !== undefined) {
      notes.push(`Must equal ${JSON.stringify(constant)}.`)
    }
  }

  // enum must be array of strings; non-string enums -> description note
  if (Array.isArray(result.enum) && result.enum.some((item) => typeof item !== "string")) {
    notes.push(`Must be one of ${JSON.stringify(result.enum)}.`)
    delete result.enum
  }

  // exclusiveMinimum/Maximum boolean form -> drop, note
  for (const bound of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (bound in value && typeof (value as Record<string, unknown>)[bound] !== "number") {
      notes.push(`${bound} constraint dropped.`)
    }
  }

  // format whitelist per type
  if (typeof result.type === "string" && typeof result.format === "string") {
    const allowed = GEMINI_FORMAT_WHITELIST[result.type]
    if (!allowed || !allowed.has(result.format)) delete result.format
  }

  // composition keywords Gemini does not accept (oneOf/not/allOf) -> describe
  for (const key of ["oneOf", "not", "allOf", "$ref", "$defs", "definitions"] as const) {
    if (key in value) notes.push(`(${key} constraint omitted)`)
  }

  if (notes.length) {
    const note = notes.join(" ")
    result.description = typeof result.description === "string" ? `${result.description} ${note}` : note
  }

  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
