import type { Config, Hooks, Plugin } from "@opencode-ai/plugin"
import { createLangfuseHooks, type LangfusePluginOptions } from "./langfuse"
import { createLogger } from "./logger"
import { createMessageTransformHooks } from "./message-transform"
import { createModelCatalog } from "./model-catalog"
import { createProviderObservability } from "./provider-observability"
import { createWanqingHooks, type WanqingPluginOptions } from "./wanqing"

export type M0PluginOptions = {
  wanqing?: false | WanqingPluginOptions
  langfuse?: false | LangfusePluginOptions
  messageTransform?: false
}

const log = createLogger({ service: "m0.plugin" })

async function invoke(name: string, task: (() => Promise<void>) | undefined) {
  if (!task) return
  await Promise.resolve()
    .then(task)
    .catch((error) => log.warn(`${name} failed`, { error }))
}

export const M0Plugin: Plugin = async (input, rawOptions) => {
  const options = rawOptions as M0PluginOptions | undefined
  const catalog = createModelCatalog()
  const observability = createProviderObservability()
  const wanqing = (() => {
    if (options?.wanqing === false) return
    try {
      return createWanqingHooks(catalog, observability, options?.wanqing)
    } catch (error) {
      log.warn("wanqing initialization failed", { error })
    }
  })()
  const langfuse =
    options?.langfuse === false
      ? undefined
      : await createLangfuseHooks(catalog, observability, wanqing?.providerIDs ?? [], options?.langfuse).catch(
          (error) => {
            log.warn("langfuse initialization failed", { error })
            return undefined
          },
        )
  const messageTransform = options?.messageTransform === false ? undefined : createMessageTransformHooks()

  await input.client.app
    .log({
      body: {
        service: "m0.plugin",
        level: "info",
        message: "@m0/opencode-plugin initialized",
        extra: {
          wanqing: !!wanqing,
          langfuse: !!langfuse,
          messageTransform: !!messageTransform,
        },
      },
    })
    .catch((error) => log.warn("failed to write initialization log", { error }))

  const hooks: Hooks = {
    async config(config: Config) {
      try {
        catalog.update(config)
      } catch (error) {
        log.warn("model catalog update failed", { error })
      }
      await invoke("wanqing config", wanqing?.hooks.config ? () => wanqing.hooks.config!(config) : undefined)
      await invoke("langfuse config", langfuse?.config ? () => langfuse.config!(config) : undefined)
    },
    async event(input) {
      await invoke("langfuse event", langfuse?.event ? () => langfuse.event!(input) : undefined)
    },
    async "chat.message"(input, output) {
      await invoke(
        "langfuse chat.message",
        langfuse?.["chat.message"] ? () => langfuse["chat.message"]!(input, output) : undefined,
      )
    },
    async "chat.params"(input, output) {
      await invoke(
        "wanqing chat.params",
        wanqing?.hooks["chat.params"] ? () => wanqing.hooks["chat.params"]!(input, output) : undefined,
      )
      await invoke(
        "langfuse chat.params",
        langfuse?.["chat.params"] ? () => langfuse["chat.params"]!(input, output) : undefined,
      )
      await invoke(
        "message-transform chat.params",
        messageTransform?.["chat.params"] ? () => messageTransform["chat.params"]!(input, output) : undefined,
      )
    },
    async "experimental.chat.image.transform"(input, output) {
      await invoke(
        "wanqing experimental.chat.image.transform",
        wanqing?.hooks["experimental.chat.image.transform"]
          ? () => wanqing.hooks["experimental.chat.image.transform"]!(input, output)
          : undefined,
      )
    },
    async "experimental.chat.messages.transform"(input, output) {
      await invoke(
        "message-transform experimental.chat.messages.transform",
        messageTransform?.["experimental.chat.messages.transform"]
          ? () => messageTransform["experimental.chat.messages.transform"]!(input, output)
          : undefined,
      )
    },
    async "chat.headers"(input, output) {
      await invoke(
        "wanqing chat.headers",
        wanqing?.hooks["chat.headers"] ? () => wanqing.hooks["chat.headers"]!(input, output) : undefined,
      )
      await invoke(
        "langfuse chat.headers",
        langfuse?.["chat.headers"] ? () => langfuse["chat.headers"]!(input, output) : undefined,
      )
    },
    async "tool.execute.before"(input, output) {
      await invoke(
        "langfuse tool.execute.before",
        langfuse?.["tool.execute.before"] ? () => langfuse["tool.execute.before"]!(input, output) : undefined,
      )
    },
    async "tool.execute.after"(input, output) {
      await invoke(
        "langfuse tool.execute.after",
        langfuse?.["tool.execute.after"] ? () => langfuse["tool.execute.after"]!(input, output) : undefined,
      )
    },
    async dispose() {
      await Promise.allSettled([
        Promise.resolve().then(() => wanqing?.hooks.dispose?.()),
        Promise.resolve().then(() => langfuse?.dispose?.()),
      ])
    },
  }
  return hooks
}

export default {
  id: "@m0/opencode-plugin",
  server: M0Plugin,
}
