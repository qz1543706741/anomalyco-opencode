import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { SessionID, MessageID } from "./schema"

export interface Interface {
  readonly admit: (input: {
    readonly sessionID: SessionID
    readonly messageID: MessageID
    readonly prompt: unknown
    readonly delivery: "steer" | "queue"
  }) => Effect.Effect<{ readonly runId?: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAdmission") {}

const layer = Layer.succeed(Service, Service.of({ admit: () => Effect.succeed({}) }))

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as SessionAdmission from "./admission"
