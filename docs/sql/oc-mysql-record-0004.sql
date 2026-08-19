-- OpenCode MySQL 持久化：补记 0004_drop_foreign_keys 迁移记录
-- 适用集群：生产 28029（分片 mysql-12580-20250819）与 staging 27736（分片 mysql-47627-20250714），库均为 ai_code
--
-- 背景：两个环境的 oc_* 表均由工单手工建立，本就不含外键，已满足 0004 的目标状态。
-- 源码 packages/core/src/persistence/mysql/migration/0004_drop_foreign_keys.ts 会按 information_schema
-- 实际存在的外键动态生成 ALTER，在线上解析结果为空、不执行任何 DDL，但仍会插入一行迁移记录。
--
-- 本工单提前补记该行，使应用启动时发现 version 已存在而直接跳过，从而：
--   1. 保持 oc_schema_migration 全部由工单管理，binary_version 统一为 manual-ddl；
--   2. 避免应用在生产库执行任何 DDL 语句。
--
-- ⚠️ checksum 必须逐字保持。其值等于 sha256(statements.join("\n"))，算法见 migration.ts 的 migrate()。
-- 若后续修改 0004_drop_foreign_keys.ts 的 statements 数组，此值即失效，应用启动会报
-- Migration checksum mismatch for 0004_drop_foreign_keys 并拒绝启动。
--
-- 纯 DML，不改表结构，无锁表风险。

USE `ai_code`;

INSERT INTO oc_schema_migration (version, checksum, applied_at, binary_version) VALUES
  ('0004_drop_foreign_keys', '2f0a79a00acaac89f7f4e5e616a4b4d0098e943f9fbe77278772fb9b92307e36', UNIX_TIMESTAMP() * 1000, 'manual-ddl');
