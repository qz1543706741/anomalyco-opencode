# OpenCode MySQL 持久化实施记录

基线：`99f638d8293f6985726ba509da602296c4963497`

分支：`mysql-persistence`

## Phase 0 影响面

- SQLite schema：`packages/core/src/**/sql.ts` 共 7 个。
- SQLite migration：`packages/core/src/database/migration` 共 38 个。
- Core dialect-specific `.get()/.all()/.run()`：111 处。
- Core `.returning()`：7 处。
- Core `.onConflictDo*()`：9 处。
- 主要 HTTP 路径：`groups/{global,session,permission,question}.ts` → 对应 `handlers/*.ts` → Core/Opencode Session、Permission、Question service。
- 数据库直连调用仍分布于 Core Session/Event/Project/Credential/Permission，以及 Opencode Session/Status/Todo/Question/Permission/Share/Worktree。

## 已完成

- 新增通用 `@opencode-ai/effect-drizzle-mysql`，管理 mysql2 pool、Drizzle client 和 Effect scope 生命周期。
- 新增可信 header `RequestScope` 解码，并挂到 Session/Event/Permission/Question HTTP group；MySQL 模式缺失或非法 header 返回请求错误，本地 SQLite 模式保持兼容。
- 新增 Session/Event/Fence/Projection ports。Session repository 已覆盖 list/create/get/update/remove/admit；Projection repository 已覆盖 Message/Part、Todo、Status 和 Permission/Question pending 生命周期。
- 新增 MySQL 垂直 spike schema：migration、fence、虚拟 project、session、run、input、event、request dedup。
- 新增 `opencode db migrate`；只在 `OPENCODE_DB_DIALECT=mysql` 且存在 `MYSQL_URL` 时执行，使用 MySQL advisory lock 和 checksum。
- Session create/update/delete、prompt admission、run 复用、Message/Part/Todo/Status/Permission/Question 投影、canonical event append 和 generation fencing 使用 MySQL transaction；状态 commit 后才发送 SSE。
- 新增 `0002_full_repository`：补齐 Session 元数据、Run/Input/Event generation，并增加 Message、SessionMessage、Part、Todo、ContextEpoch、PermissionRequest、QuestionRequest 表。
- MySQL 集成测试覆盖 migration、Session CRUD、Message/Part、Todo、Status、Permission pending、用户隔离、prompt 幂等和 stale owner；使用 staging `ai_code` schema 已真实通过。
- 新增 `0003_runtime_facades`，持久化完整 Session status JSON；staging schema 已迁移到该版本。
- MySQL 模式替换 Session、Message/Part、Todo、Status、Permission、Question、admission 和 Event bridge；旧 Session projector 被关闭，不再写入临时 SQLite 投影。
- Prompt/Processor/Task 的 Session/Message 主链路在 MySQL 模式通过 repository-backed service 读取；本地模式保留原 SQLite 行为。
- `/event`、`/global/event` 按 userId 隔离；测试验证收到 `message.part.updated` 时对应 Message/Part 已可从 MySQL 查询。
- `/api/*` 在 MySQL 模式明确返回 `503 CAPABILITY_DISABLED`，不回退 SQLite。
- run 支持 starting/running/waiting/completed/failed/interrupted 状态；owner 推进及同 INSTANCE_ID 重启会中断遗留活跃 run。
- `opencode serve` 只检查 schema，不执行 DDL；MySQL 模式缺少 `MYSQL_URL` 或 `INSTANCE_ID` 时启动失败。
- Core 全量测试：1080 pass、2 skip、0 fail；Core/Opencode typecheck 通过；本地 HTTP 回归 26 pass。
- staging：Core repository 14 assertions、运行时 facade 8 assertions、HTTP/SSE 10 assertions 全部通过。
- darwin-arm64 二进制已构建；该二进制的 migration 与 Session/Message/HTTP staging E2E 已通过。

## 发布前外部门禁

- Gateway 必须完成可信 header、实际 runId 合并和 Redis generation 联调。
- 公司 MySQL HA 必须确认 commit acknowledgement 满足 RPO=0，并完成故障切换和 PITR 恢复演练。
- permission/question 重启后 pending 可恢复读取与回复；被中断进程中的原 Deferred 不自动续跑模型，这是当前明确的 interrupted 语义。
- MySQL 云模式暂不开放 V2 `/api/*`；开放前需为 V2 Session Core 单独完成同等 repository 迁移与验收。
- Opencode 全量测试中仍有与本改动无关的本机环境失败：公司 npm registry 覆盖 3 项、PTY 环境超时/404；相关 MySQL、prompt 和 CLI snapshot 回归均已单独通过。
