import type { Config } from "@opencode-ai/plugin"

export type ModelCatalog = ReturnType<typeof createModelCatalog>

export function createModelCatalog() {
  const models = new Map<string, { displayName: string; maxOutputTokens?: number; imageUseCdn: boolean }>()
  const displayNames = new Map<string, string>()

  return {
    update(config: Config) {
      models.clear()
      displayNames.clear()
      for (const provider of Object.values(config.provider ?? {})) {
        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          const displayName = typeof model.name === "string" && model.name.trim() ? model.name : modelID
          const maxOutputTokens =
            typeof model.limit?.output === "number" && Number.isFinite(model.limit.output) && model.limit.output > 0
              ? model.limit.output
              : undefined
          const imageUseCdn = model.options?.imageUseCdn === true || model.options?.image_use_cdn === true
          models.set(modelID, { displayName, maxOutputTokens, imageUseCdn })
          displayNames.set(modelID, displayName)
        }
      }
    },
    get(modelID: string) {
      return models.get(modelID)
    },
    displayNames,
  }
}
