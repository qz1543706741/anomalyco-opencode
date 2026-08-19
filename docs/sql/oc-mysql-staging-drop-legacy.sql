-- OpenCode MySQL 持久化：清理 staging 的 legacy 备份表
-- 集群 27736 / 分片 mysql-47627-20250714 / 库 ai_code
--
-- 背景：工单 909536 把 staging 由应用 migrate 建出的「带外键」旧表改名为 *_legacy_20260731 留存，
-- 并按生产结构重建了无外键新表。现已完成验证：
--   - 生产 28029 与 staging 27736 的 141 列 / 71 索引结构逐字一致，外键均为 0；
--   - 两端 oc_schema_migration 均为 4 条 manual-ddl，checksum 与源码实算值匹配；
--   - staging 新建会话读写正常，9 张 Session 作用域子表孤儿记录均为 0。
-- 故 legacy 备份不再需要，本工单予以清理，释放约 230MB（oc_event 136MB + oc_part 72MB + oc_session_input 19MB）。
--
-- 已确认 13 个外键全部闭环在 legacy 表内部，无任何一条引用当前在用的新表，删除不影响线上数据。
-- 下方顺序按外键依赖拓扑排列：先删引用方，再删被引用方，避免 ER_ROW_IS_REFERENCED。
--
-- ⚠️ 不可逆：KDB 的 DROP 会转为 rename 并保留 7 天，逾期物理删除。执行后 staging 历史会话数据
-- （264 个会话 / 30260 条 event 等测试数据）将无法恢复。

USE `ai_code`;

-- 第 1 层：仅作为引用方，无其他表引用它们
DROP TABLE oc_part_legacy_20260731;

DROP TABLE oc_session_input_legacy_20260731;

DROP TABLE oc_session_message_legacy_20260731;

DROP TABLE oc_todo_legacy_20260731;

DROP TABLE oc_session_context_epoch_legacy_20260731;

DROP TABLE oc_permission_request_legacy_20260731;

DROP TABLE oc_question_request_legacy_20260731;

DROP TABLE oc_event_legacy_20260731;

-- 第 2 层：被第 1 层引用，现已无引用方
DROP TABLE oc_message_legacy_20260731;

DROP TABLE oc_run_legacy_20260731;

DROP TABLE oc_event_sequence_legacy_20260731;

-- 第 3 层：被第 2 层引用
DROP TABLE oc_session_legacy_20260731;

-- 第 4 层：被 oc_session_legacy 引用
DROP TABLE oc_project_legacy_20260731;

-- 无外键关联的独立备份表
DROP TABLE oc_user_fence_legacy_20260731;

DROP TABLE oc_request_dedup_legacy_20260731;

DROP TABLE oc_schema_migration_legacy_20260731;
