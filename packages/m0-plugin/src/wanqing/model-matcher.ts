/**
 * Resolve model_id -> display_name and match models by family.
 *
 * Wanqing routes by opaque model_id, so family detection (gemini, gpt, ...)
 * relies on the kconf display_name rather than the id itself.
 */
export function createModelMatcher(displayNames: Map<string, string>) {
  function displayName(modelID: unknown): string | undefined {
    return typeof modelID === "string" ? displayNames.get(modelID) : undefined
  }

  function matches(modelID: unknown, keyword: string): boolean {
    return displayName(modelID)?.toLowerCase().includes(keyword) ?? false
  }

  return {
    isGeminiModel: (modelID: unknown) => matches(modelID, "gemini"),
    isGptModel: (modelID: unknown) => matches(modelID, "gpt"),
    isDeepseekModel: (modelID: unknown) => matches(modelID, "deepseek"),
    isClaudeModel: (modelID: unknown) => matches(modelID, "claude"),
  }
}
