export const version = "0003_runtime_facades"

export const statements = [`ALTER TABLE oc_session ADD COLUMN status_json JSON NULL AFTER status`] as const
