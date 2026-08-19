import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Layer } from "effect"

export interface Interface {
  readonly toolAllowlist: ReadonlySet<string> | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RuntimeConfig") {}

export const layer = (config: Interface) => Layer.succeed(Service)(Service.of(config))

export const node = LayerNode.make({ service: Service, layer: layer({ toolAllowlist: undefined }), deps: [] })

export * as RuntimeConfig from "./runtime-config"
