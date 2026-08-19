export const version = "0004_drop_foreign_keys"

// Production KDB forbids foreign keys, so line environments were built without them and ON DELETE
// CASCADE never applies. Databases built by earlier migrations still carry the constraints, which
// hides orphan-row regressions that only surface in production. Dropping them keeps every
// environment on the same shape. Cascades are replaced by explicit deletes in
// MysqlSessionRepository.remove and removeMessage.
//
// These statements declare the intent and anchor the recorded checksum. They are not executed
// directly: line environments already have no foreign keys, so a blind DROP would fail with
// ER_CANT_DROP_FIELD_OR_KEY. `plan` below resolves what the database actually has.
export const statements = [
  `ALTER TABLE oc_event DROP FOREIGN KEY oc_event_sequence_fk`,
  `ALTER TABLE oc_message DROP FOREIGN KEY oc_message_session_fk`,
  `ALTER TABLE oc_part DROP FOREIGN KEY oc_part_message_fk, DROP FOREIGN KEY oc_part_session_fk`,
  `ALTER TABLE oc_permission_request DROP FOREIGN KEY oc_permission_session_fk`,
  `ALTER TABLE oc_question_request DROP FOREIGN KEY oc_question_session_fk`,
  `ALTER TABLE oc_run DROP FOREIGN KEY oc_run_session_fk`,
  `ALTER TABLE oc_session DROP FOREIGN KEY oc_session_project_fk`,
  `ALTER TABLE oc_session_context_epoch DROP FOREIGN KEY oc_context_epoch_session_fk`,
  `ALTER TABLE oc_session_input DROP FOREIGN KEY oc_session_input_run_fk, DROP FOREIGN KEY oc_session_input_session_fk`,
  `ALTER TABLE oc_session_message DROP FOREIGN KEY oc_session_message_session_fk`,
  `ALTER TABLE oc_todo DROP FOREIGN KEY oc_todo_session_fk`,
] as const

export const query = `SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND TABLE_NAME LIKE 'oc\\_%'
  ORDER BY TABLE_NAME, CONSTRAINT_NAME`

// One ALTER per table, because MySQL rejects several ALTER statements against the same table.
export function plan(rows: readonly { readonly table_name: string; readonly constraint_name: string }[]) {
  const byTable = new Map<string, string[]>()
  for (const row of rows) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.constraint_name])
  return [...byTable].map(
    ([table, constraints]) =>
      `ALTER TABLE ${table} ${constraints.map((constraint) => `DROP FOREIGN KEY ${constraint}`).join(", ")}`,
  )
}
