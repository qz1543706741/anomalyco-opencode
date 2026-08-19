import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectionRepository } from "@opencode-ai/core/persistence/port/projection"
import { SessionRepository } from "@opencode-ai/core/persistence/port/session"
import { RequestScope } from "@opencode-ai/core/persistence/scope"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Slug } from "@opencode-ai/core/util/slug"
import { Effect, Layer, Option, Schema } from "effect"
import { NotFoundError } from "@/storage/storage"
import { MessageID, PartID, SessionID } from "./schema"
import { Session } from "./session"
import { MysqlPersistence } from "@/persistence/mysql"
import { EventV2Bridge } from "@/event-v2-bridge"

const layer = Layer.effect(
  Session.Service,
  Effect.gen(function* () {
    const sessions = yield* SessionRepository.Service
    const projections = yield* ProjectionRepository.Service
    const events = yield* EventV2Bridge.Service

    const scope = () => RequestScope.require.pipe(Effect.orDie)

    const requireSession = Effect.fn("MysqlSession.require")(function* (id: SessionID) {
      const value = yield* sessions.get(yield* scope(), id).pipe(Effect.orDie)
      if (!value) return yield* new NotFoundError({ message: `Session not found: ${id}` })
      return toInfo(value)
    })

    const list = Effect.fn("MysqlSession.list")(function* (input?: Session.ListInput) {
      const values = yield* sessions.list(yield* scope()).pipe(Effect.orDie)
      return values
        .filter((value) => !input?.roots || !value.parentId)
        .filter((value) => !input?.start || value.updatedAt >= input.start)
        .filter((value) => !input?.search || value.title.includes(input.search))
        .slice(0, input?.limit ?? 100)
        .map(toInfo)
    })

    const listGlobal = Effect.fn("MysqlSession.listGlobal")(function* (input?: Session.GlobalListInput) {
      return (yield* list(input)).map((value) => ({ ...value, project: null }))
    })

    const create: Session.Interface["create"] = Effect.fn("MysqlSession.create")(function* (input) {
      const id = SessionID.descending()
      const eventId = EventV2.ID.create()
      const value = yield* sessions
        .create(yield* scope(), {
          id,
          parentId: input?.parentID,
          slug: Slug.create(),
          title: input?.title ?? `${input?.parentID ? "Child" : "New"} session - ${new Date().toISOString()}`,
          version: InstallationVersion,
          agent: input?.agent,
          model: input?.model,
          metadata: input?.metadata,
          permission: input?.permission ? [...input.permission] : undefined,
          event: (created) => ({
            id: eventId,
            aggregateId: id,
            type: EventV2.versionedType(SessionV1.Event.Created.type, SessionV1.Event.Created.durable!.version),
            data: { sessionID: id, info: toInfo(created) },
          }),
        })
        .pipe(Effect.orDie)
      const info = toInfo(value)
      yield* events.publish(SessionV1.Event.Created, { sessionID: id, info }, { id: eventId })
      return info
    })

    const children = Effect.fn("MysqlSession.children")(function* (parentID: SessionID) {
      return (yield* sessions.list(yield* scope()).pipe(Effect.orDie))
        .filter((value) => value.parentId === parentID)
        .map(toInfo)
    })

    const remove: Session.Interface["remove"] = Effect.fn("MysqlSession.remove")(function* (sessionID) {
      for (const child of yield* children(sessionID)) yield* remove(child.id)
      const eventId = EventV2.ID.create()
      const info = yield* requireSession(sessionID)
      yield* sessions
        .remove(yield* scope(), sessionID, () => ({
          id: eventId,
          aggregateId: sessionID,
          type: EventV2.versionedType(SessionV1.Event.Deleted.type, SessionV1.Event.Deleted.durable!.version),
          data: { sessionID, info },
        }))
        .pipe(Effect.mapError(() => new NotFoundError({ message: `Session not found: ${sessionID}` })))
      yield* events.publish(SessionV1.Event.Deleted, { sessionID, info }, { id: eventId })
    })

    const patch = Effect.fn("MysqlSession.patch")(function* (
      sessionID: SessionID,
      input: SessionRepository.PatchInput,
    ) {
      const eventId = EventV2.ID.create()
      const value = yield* sessions
        .update(yield* scope(), sessionID, input, (updated) => ({
          id: eventId,
          aggregateId: sessionID,
          type: EventV2.versionedType(SessionV1.Event.Updated.type, SessionV1.Event.Updated.durable!.version),
          data: { sessionID, info: toInfo(updated) },
        }))
        .pipe(Effect.orDie)
      yield* events.publish(SessionV1.Event.Updated, { sessionID, info: toInfo(value) }, { id: eventId })
    })

    const messages: Session.Interface["messages"] = Effect.fn("MysqlSession.messages")(function* (input) {
      yield* requireSession(input.sessionID)
      const values = yield* projections.messages(yield* scope(), input.sessionID).pipe(Effect.orDie)
      const selected = input.limit ? values.slice(-input.limit) : values
      return yield* Effect.forEach(selected, (value) =>
        Effect.gen(function* () {
          const parts = yield* projections.parts(yield* scope(), value.sessionId, value.id).pipe(Effect.orDie)
          return decodeMutable(SessionV1.WithParts, {
            info: decodeMutable(SessionV1.Info, {
              ...record(value.data),
              id: value.id,
              sessionID: input.sessionID,
            }),
            parts: parts.map((part) =>
              decodeMutable(SessionV1.Part, {
                ...record(part.data),
                id: part.id,
                messageID: part.messageId,
                sessionID: input.sessionID,
              }),
            ),
          })
        }),
      )
    })

    const updateMessage = <T extends SessionV1.Info>(message: T) =>
      Effect.gen(function* () {
        const now = Date.now()
        const id = EventV2.ID.create()
        const data = { sessionID: message.sessionID, info: message }
        yield* projections
          .putMessage(yield* scope(), {
            value: {
              id: message.id,
              sessionId: message.sessionID,
              data: message,
              createdAt: "time" in message && message.time?.created ? message.time.created : now,
              updatedAt: now,
            },
            event: {
              id,
              aggregateId: message.sessionID,
              type: EventV2.versionedType(
                SessionV1.Event.MessageUpdated.type,
                SessionV1.Event.MessageUpdated.durable!.version,
              ),
              data,
            },
          })
          .pipe(Effect.orDie)
        yield* events.publish(SessionV1.Event.MessageUpdated, data, { id })
        return message
      })

    const updatePart = <T extends SessionV1.Part>(part: T) =>
      Effect.gen(function* () {
        const current = yield* projections.parts(yield* scope(), part.sessionID, part.messageID).pipe(Effect.orDie)
        const now = Date.now()
        const id = EventV2.ID.create()
        const data = { sessionID: part.sessionID, part: structuredClone(part), time: now }
        yield* projections
          .putPart(yield* scope(), {
            value: {
              id: part.id,
              messageId: part.messageID,
              sessionId: part.sessionID,
              position: current.find((value) => value.id === part.id)?.position ?? current.length,
              data: part,
              createdAt: current.find((value) => value.id === part.id)?.createdAt ?? now,
              updatedAt: now,
            },
            event: {
              id,
              aggregateId: part.sessionID,
              type: EventV2.versionedType(
                SessionV1.Event.PartUpdated.type,
                SessionV1.Event.PartUpdated.durable!.version,
              ),
              data,
            },
          })
          .pipe(Effect.orDie)
        yield* events.publish(SessionV1.Event.PartUpdated, data, { id })
        return part
      })

    const getPart: Session.Interface["getPart"] = Effect.fn("MysqlSession.getPart")(function* (input) {
      const parts = yield* projections.parts(yield* scope(), input.sessionID, input.messageID).pipe(Effect.orDie)
      const part = parts.find((value) => value.id === input.partID)
      return part
        ? decodeMutable(SessionV1.Part, {
            ...record(part.data),
            id: input.partID,
            messageID: input.messageID,
            sessionID: input.sessionID,
          })
        : undefined
    })

    const removeMessage = Effect.fn("MysqlSession.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const id = EventV2.ID.create()
      const data = { sessionID: input.sessionID, messageID: input.messageID }
      yield* projections
        .removeMessage(yield* scope(), input.sessionID, input.messageID, {
          id,
          aggregateId: input.sessionID,
          type: EventV2.versionedType(
            SessionV1.Event.MessageRemoved.type,
            SessionV1.Event.MessageRemoved.durable!.version,
          ),
          data,
        })
        .pipe(Effect.orDie)
      yield* events.publish(SessionV1.Event.MessageRemoved, data, { id })
      return input.messageID
    })

    const removePart = Effect.fn("MysqlSession.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      const id = EventV2.ID.create()
      const data = { sessionID: input.sessionID, messageID: input.messageID, partID: input.partID }
      yield* projections
        .removePart(yield* scope(), input.sessionID, input.messageID, input.partID, {
          id,
          aggregateId: input.sessionID,
          type: EventV2.versionedType(SessionV1.Event.PartRemoved.type, SessionV1.Event.PartRemoved.durable!.version),
          data,
        })
        .pipe(Effect.orDie)
      yield* events.publish(SessionV1.Event.PartRemoved, data, { id })
      return input.partID
    })

    const updatePartDelta = Effect.fn("MysqlSession.updatePartDelta")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* events.publish(SessionV1.Event.PartDelta, input)
    })

    const findMessage: Session.Interface["findMessage"] = Effect.fn("MysqlSession.findMessage")(
      function* (sessionID, predicate) {
        const value = (yield* messages({ sessionID })).findLast(predicate)
        return value ? Option.some(value) : Option.none()
      },
    )

    const fork = Effect.fn("MysqlSession.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const original = yield* requireSession(input.sessionID)
      const target = yield* create({ title: `${original.title} (fork)`, metadata: structuredClone(original.metadata) })
      for (const message of yield* messages({ sessionID: input.sessionID })) {
        if (input.messageID && message.info.id >= input.messageID) break
        const messageID = MessageID.ascending()
        yield* updateMessage({ ...message.info, id: messageID, sessionID: target.id })
        for (const part of message.parts)
          yield* updatePart({ ...part, id: PartID.ascending(), messageID, sessionID: target.id })
      }
      return target
    })

    return Session.Service.of({
      list,
      listGlobal,
      create,
      fork,
      touch: (sessionID) => patch(sessionID, {}),
      get: requireSession,
      setTitle: (input) => patch(input.sessionID, { title: input.title }),
      setArchived: (input) => patch(input.sessionID, { archivedAt: input.time ?? null }),
      setMetadata: (input) => patch(input.sessionID, { metadata: input.metadata }),
      setAgentModel: (input) => patch(input.sessionID, { agent: input.agent, model: input.model }),
      setPermission: (input) => patch(input.sessionID, { permission: input.permission }),
      setRevert: (input) => patch(input.sessionID, { revert: input.revert ?? null, summary: input.summary ?? null }),
      clearRevert: (sessionID) => patch(sessionID, { revert: null }),
      setSummary: (input) => patch(input.sessionID, { summary: input.summary ?? null }),
      setShare: (input) => patch(input.sessionID, { shareUrl: input.share?.url ?? null }),
      setWorkspace: () => Effect.void,
      diff: () => Effect.succeed([]),
      messages,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

function toInfo(value: SessionRepository.Session): Session.Info {
  return decodeMutable(Session.Info, {
    id: SessionID.make(value.id),
    slug: value.slug,
    projectID: ProjectV2.ID.make(value.projectId),
    ...(value.workspaceId ? { workspaceID: WorkspaceV2.ID.make(value.workspaceId) } : {}),
    directory: value.directory,
    ...(value.path ? { path: value.path } : {}),
    ...(value.parentId ? { parentID: SessionID.make(value.parentId) } : {}),
    title: value.title,
    ...(value.agent ? { agent: value.agent } : {}),
    ...(value.model ? { model: value.model } : {}),
    version: value.version,
    ...(value.summary ? { summary: value.summary } : {}),
    cost: value.cost,
    tokens: {
      input: value.tokens.input,
      output: value.tokens.output,
      reasoning: value.tokens.reasoning,
      cache: { read: value.tokens.cacheRead, write: value.tokens.cacheWrite },
    },
    ...(value.shareUrl ? { share: { url: value.shareUrl } } : {}),
    ...(value.metadata ? { metadata: value.metadata } : {}),
    ...(value.revert ? { revert: value.revert } : {}),
    ...(value.permission ? { permission: value.permission } : {}),
    time: {
      created: value.createdAt,
      updated: value.updatedAt,
      ...(value.compactingAt ? { compacting: value.compactingAt } : {}),
      ...(value.archivedAt ? { archived: value.archivedAt } : {}),
    },
  })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function decodeMutable<S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): DeepMutable<S["Type"]> {
  return Schema.decodeUnknownSync(schema)(value) as DeepMutable<S["Type"]>
}

export const node = LayerNode.make({
  service: Session.Service,
  layer,
  deps: [MysqlPersistence.node, EventV2Bridge.node],
})

export * as MysqlSession from "./mysql"
