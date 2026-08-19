import {
  bigint,
  double,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"

export const SchemaMigrationTable = mysqlTable("oc_schema_migration", {
  version: varchar({ length: 64 }).primaryKey(),
  checksum: varchar({ length: 64 }).notNull(),
  applied_at: bigint({ mode: "number" }).notNull(),
  binary_version: varchar({ length: 64 }).notNull(),
})

export const UserFenceTable = mysqlTable("oc_user_fence", {
  user_id: varchar({ length: 128 }).primaryKey(),
  generation: bigint({ mode: "bigint", unsigned: true }).notNull(),
  owner_instance_id: varchar({ length: 128 }).notNull(),
  updated_at: bigint({ mode: "number" }).notNull(),
})

export const ProjectTable = mysqlTable("oc_project", {
  id: varchar({ length: 64 }).primaryKey(),
  name: varchar({ length: 255 }),
  directory: varchar({ length: 2048 }).notNull(),
  created_at: bigint({ mode: "number" }).notNull(),
  updated_at: bigint({ mode: "number" }).notNull(),
})

export const SessionTable = mysqlTable(
  "oc_session",
  {
    id: varchar({ length: 64 }).primaryKey(),
    user_id: varchar({ length: 128 }).notNull(),
    owner_generation: bigint({ mode: "bigint", unsigned: true }).notNull(),
    project_id: varchar({ length: 64 }).notNull(),
    workspace_id: varchar({ length: 64 }),
    parent_id: varchar({ length: 64 }),
    slug: varchar({ length: 255 }).notNull(),
    directory: varchar({ length: 2048 }).notNull(),
    path: varchar({ length: 2048 }),
    title: varchar({ length: 512 }).notNull(),
    version: varchar({ length: 64 }).notNull(),
    share_url: varchar({ length: 2048 }),
    summary_json: json(),
    metadata_json: json(),
    cost: double().notNull().default(0),
    tokens_input: bigint({ mode: "number" }).notNull().default(0),
    tokens_output: bigint({ mode: "number" }).notNull().default(0),
    tokens_reasoning: bigint({ mode: "number" }).notNull().default(0),
    tokens_cache_read: bigint({ mode: "number" }).notNull().default(0),
    tokens_cache_write: bigint({ mode: "number" }).notNull().default(0),
    revert_json: json(),
    permission_json: json(),
    agent: varchar({ length: 255 }),
    model_json: json(),
    status: varchar({ length: 32 }).notNull(),
    status_json: json(),
    compacting_at: bigint({ mode: "number" }),
    archived_at: bigint({ mode: "number" }),
    created_at: bigint({ mode: "number" }).notNull(),
    updated_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    index("oc_session_user_updated_id_idx").on(table.user_id, table.updated_at, table.id),
    index("oc_session_parent_idx").on(table.user_id, table.parent_id),
  ],
)

export const RunTable = mysqlTable(
  "oc_run",
  {
    id: varchar({ length: 64 }).notNull(),
    user_id: varchar({ length: 128 }).notNull(),
    session_id: varchar({ length: 64 }).notNull(),
    owner_generation: bigint({ mode: "bigint", unsigned: true }).notNull(),
    owner_instance_id: varchar({ length: 128 }).notNull(),
    trigger_request_id: varchar({ length: 64 }).notNull(),
    status: varchar({ length: 32 }).notNull(),
    error_code: varchar({ length: 128 }),
    error_json: json(),
    heartbeat_at: bigint({ mode: "number" }),
    finished_at: bigint({ mode: "number" }),
    started_at: bigint({ mode: "number" }).notNull(),
    updated_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.id] }),
    index("oc_run_active_idx").on(table.user_id, table.session_id, table.owner_generation, table.status),
  ],
)

export const SessionInputTable = mysqlTable(
  "oc_session_input",
  {
    id: varchar({ length: 64 }).notNull(),
    user_id: varchar({ length: 128 }).notNull(),
    owner_generation: bigint({ mode: "bigint", unsigned: true }).notNull(),
    session_id: varchar({ length: 64 }).notNull(),
    run_id: varchar({ length: 64 }).notNull(),
    request_id: varchar({ length: 64 }).notNull(),
    prompt: json().notNull(),
    payload_hash: varchar({ length: 64 }).notNull(),
    delivery: varchar({ length: 16 }).notNull(),
    admitted_seq: int({ unsigned: true }).notNull(),
    promoted_seq: int({ unsigned: true }),
    created_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.id] }),
    uniqueIndex("oc_session_input_request_idx").on(table.user_id, table.request_id),
    uniqueIndex("oc_session_input_admitted_idx").on(table.user_id, table.session_id, table.admitted_seq),
  ],
)

export const EventSequenceTable = mysqlTable(
  "oc_event_sequence",
  {
    user_id: varchar({ length: 128 }).notNull(),
    aggregate_id: varchar({ length: 64 }).notNull(),
    seq: int().notNull(),
    owner_generation: bigint({ mode: "bigint", unsigned: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.aggregate_id] })],
)

export const EventTable = mysqlTable(
  "oc_event",
  {
    id: varchar({ length: 64 }).notNull(),
    user_id: varchar({ length: 128 }).notNull(),
    aggregate_id: varchar({ length: 64 }).notNull(),
    seq: int({ unsigned: true }).notNull(),
    type: varchar({ length: 128 }).notNull(),
    data: json().notNull(),
    owner_generation: bigint({ mode: "bigint", unsigned: true }).notNull(),
    created_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.id] }),
    uniqueIndex("oc_event_aggregate_seq_idx").on(table.user_id, table.aggregate_id, table.seq),
  ],
)

export const MessageTable = mysqlTable(
  "oc_message",
  {
    id: varchar({ length: 64 }).primaryKey(),
    session_id: varchar({ length: 64 }).notNull(),
    user_id: varchar({ length: 128 }).notNull(),
    seq: bigint({ mode: "number", unsigned: true }).notNull(),
    data_json: json().notNull(),
    created_at: bigint({ mode: "number" }).notNull(),
    updated_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("oc_message_session_seq_idx").on(table.session_id, table.seq),
    index("oc_message_session_created_id_idx").on(table.user_id, table.session_id, table.created_at, table.id),
  ],
)

export const PartTable = mysqlTable(
  "oc_part",
  {
    id: varchar({ length: 64 }).primaryKey(),
    message_id: varchar({ length: 64 }).notNull(),
    session_id: varchar({ length: 64 }).notNull(),
    user_id: varchar({ length: 128 }).notNull(),
    position: bigint({ mode: "number", unsigned: true }).notNull(),
    data_json: json().notNull(),
    created_at: bigint({ mode: "number" }).notNull(),
    updated_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("oc_part_message_position_idx").on(table.message_id, table.position),
    index("oc_part_session_id_idx").on(table.user_id, table.session_id, table.id),
  ],
)

export const TodoTable = mysqlTable(
  "oc_todo",
  {
    session_id: varchar({ length: 64 }).notNull(),
    user_id: varchar({ length: 128 }).notNull(),
    position: int({ unsigned: true }).notNull(),
    content: text().notNull(),
    status: varchar({ length: 32 }).notNull(),
    priority: varchar({ length: 32 }).notNull(),
    created_at: bigint({ mode: "number" }).notNull(),
    updated_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("oc_todo_user_session_idx").on(table.user_id, table.session_id),
  ],
)

export const SessionMessageTable = mysqlTable(
  "oc_session_message",
  {
    id: varchar({ length: 64 }).primaryKey(),
    session_id: varchar({ length: 64 }).notNull(),
    user_id: varchar({ length: 128 }).notNull(),
    type: varchar({ length: 128 }).notNull(),
    seq: bigint({ mode: "number", unsigned: true }).notNull(),
    data_json: json().notNull(),
    created_at: bigint({ mode: "number" }).notNull(),
    updated_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("oc_session_message_session_seq_idx").on(table.session_id, table.seq),
    index("oc_session_message_type_seq_idx").on(table.user_id, table.session_id, table.type, table.seq),
  ],
)

export const SessionContextEpochTable = mysqlTable("oc_session_context_epoch", {
  session_id: varchar({ length: 64 }).primaryKey(),
  user_id: varchar({ length: 128 }).notNull(),
  baseline: text().notNull(),
  baseline_seq: bigint({ mode: "number", unsigned: true }).notNull(),
  snapshot_json: json().notNull(),
  updated_at: bigint({ mode: "number" }).notNull(),
})

function requestTable(name: "oc_permission_request" | "oc_question_request") {
  return mysqlTable(
    name,
    {
      id: varchar({ length: 64 }).primaryKey(),
      session_id: varchar({ length: 64 }).notNull(),
      user_id: varchar({ length: 128 }).notNull(),
      status: varchar({ length: 32 }).notNull(),
      payload_json: json().notNull(),
      response_json: json(),
      owner_generation: bigint({ mode: "bigint", unsigned: true }).notNull(),
      created_at: bigint({ mode: "number" }).notNull(),
      updated_at: bigint({ mode: "number" }).notNull(),
    },
    (table) => [index(`${name}_pending_idx`).on(table.user_id, table.status, table.created_at)],
  )
}

export const PermissionRequestTable = requestTable("oc_permission_request")
export const QuestionRequestTable = requestTable("oc_question_request")

export const RequestDedupTable = mysqlTable(
  "oc_request_dedup",
  {
    user_id: varchar({ length: 128 }).notNull(),
    request_id: varchar({ length: 64 }).notNull(),
    operation: varchar({ length: 64 }).notNull(),
    payload_hash: varchar({ length: 64 }).notNull(),
    response: json().notNull(),
    created_at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.request_id, table.operation] })],
)
