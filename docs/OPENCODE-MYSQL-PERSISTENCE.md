# OpenCode MySQL 持久化独立实施方案

> 状态：MySQL 持久化实现完成并通过 staging 集成与二进制冒烟；生产发布仍需 Gateway/Redis 联调、MySQL HA/RPO 和恢复演练。  
> 关联通信方案：[`CLOUD-WEBUI-SERVER-COMMUNICATION.md`](./CLOUD-WEBUI-SERVER-COMMUNICATION.md)  
> 源码基线：`/Users/qinzhen/Desktop/github/opencode`，commit `99f638d82`（release `v1.18.1`）。实施开始前若切换 commit，必须重新执行 §16.1 影响面盘点。  
> userId 提取参考：`/Users/qinzhen/Desktop/workspace/ai-devops-server/servers/devops-server/src/modules/user/index.decorator.ts`  
> 数据模型参考：`packages/core/src/session/sql.ts`、`event/sql.ts`、`database/database.ts`，以及 `packages/opencode/src/session/status.ts`、`question/index.ts`、`permission/index.ts`。  
> 初始数据：MySQL 空库上线，不迁移历史 SQLite。

## 1. 目标

把 OpenCode 生产会话状态从容器本地 SQLite 改为公司统一 MySQL，使多个容器中的 OpenCode 进程共享数据，并满足：

- Session、Message、Part、输入队列、事件、todo、revert、compaction、permission/question 和运行状态持久化。
- `userId` 全局唯一，所有 Session/API/SSE 可按用户隔离。
- 已接受用户输入和已发布 SSE 对应状态 RPO=0。
- Gateway/OpenCode 故障后可从 MySQL 恢复已提交状态。
- Redis owner generation 变化后，旧 owner 不能继续写入。
- 保持 Web UI 可见的 OpenCode REST/SSE schema。
- 不引入 workspace、项目文件或本地文件持久化。

## 2. 边界

本方案负责：

- OpenCode 数据访问层由 SQLite 切换到 MySQL。
- MySQL schema、migration、连接池和事务。
- userId 所有权、generation fencing 和幂等。
- REST accepted、SSE publish 与 MySQL commit 的顺序。
- OpenCode 崩溃、MySQL 故障和 owner 切换后的恢复。
- 空库初始化、升级、回滚、测试和发布门禁。

本方案不负责：

- Sticky Proxy、Redis 路由和 Gateway HTTP/SSE 代理实现。
- 公司 AP 和 Cookie SSO。
- Dockerfile、容器云实例数和平台探针。
- workspace、Git、文件、LSP、Shell、PTY。
- 历史 SQLite 数据迁移、双写、回填或校验。

## 3. 已确认决策

| 项目         | 结论                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| 数据库       | 公司统一 MySQL，推荐 MySQL 8.0+                                                                       |
| 初始数据     | 空库上线，不迁移 SQLite 历史数据                                                                      |
| 生产真相     | MySQL；本地 SQLite 禁用                                                                               |
| 身份         | 单租户，`userId` 全局唯一，无 `tenantId`                                                              |
| 部署         | 多个 Gateway/OpenCode 进程共享同一 MySQL schema                                                       |
| 路由         | 同一 userId 全部 Session 属于同一 owner generation                                                    |
| RPO          | 已接受数据 RPO=0                                                                                      |
| 并发         | 每用户最多 2 个运行中顶层 Session；Redis 执行额度控制                                                 |
| 交付边界     | 在独立 OpenCode 二进制工程实现；Server 只调用二进制                                                   |
| migration    | 独立命令执行，`opencode serve` 不自动变更 schema                                                      |
| Dialect 抽象 | 业务层依赖 repository/port；SQLite 与 MySQL 各自实现查询和事务，不共享 dialect-specific query builder |
| Project 处理 | 保留 project 表，云模式插入单行虚拟 project `'cloud-virtual'`                                         |
| MySQL 驱动   | `mysql2` + `drizzle-orm/mysql2`，Effect 包装对标 `effect-drizzle-sqlite`                              |
| MySQL 实例   | staging 已就位，代理地址 `kwaiproxy.staging.mysql.internal:6032`，账号 `ai_code_47627_v1_rw`          |
| userId 来源  | Gateway 从 Cookie `coolux-userInfo-token` 解 JWT，取 `userInfo.name` 作为 `x-opencode-user-id` 注入   |
| AP SSO       | Cookie 透传已完成，Gateway 侧解 JWT 不依赖 AP 改造                                                    |
| Redis        | 容器云可提供，用于 owner generation 和并发额度                                                        |

## 4. OpenCode 与 Gateway 的持久化契约

Gateway 对所有会话请求注入：

```text
x-opencode-user-id: <global unique userId>
x-opencode-owner-generation: <positive integer>
x-request-id: <uuid>
x-opencode-run-id: <uuid, 仅会触发或加入执行的 prompt 请求必需>
```

### 4.1 userId 提取链路

Gateway 从浏览器请求的 Cookie 中提取 userId，参考 `ai-devops-server` 的 `User` 装饰器实现：

```text
Cookie: coolux-userInfo-token=<JWT>
  → jwt.verify(token, "coolux-server-token-salt-89757")
  → { userInfo: { name, displayName, nameZh, mail, avatar, department, ... } }
  → userId = userInfo.name   （工号，如 "shenyang03"）
```

| 项            | 值                                |
| ------------- | --------------------------------- |
| Cookie 名     | `coolux-userInfo-token`           |
| JWT salt      | `coolux-server-token-salt-89757`  |
| userId 字段   | `userInfo.name`                   |
| 开发环境 mock | `TEST_USER.name = "shenyang03"`   |
| 无有效 token  | 返回 400 `没有有效的用户登录信息` |

Gateway 侧完成 JWT 解码后，把 `userInfo.name` 作为 `x-opencode-user-id` header 注入到 OpenCode loopback 请求。OpenCode 只信任 loopback header，不接触 JWT 或 Cookie。浏览器传入的同名 header 必须由 Gateway 删除。

OpenCode 必须：

1. 缺少 `userId` 或 generation 的会话写请求直接拒绝。
2. Session 创建时把 userId 和 generation 与 Session 同事务提交。
3. 所有按 Session ID 的读写同时匹配 userId。
4. 所有写事务比较当前 `user_fence.generation`；小于当前值返回 `STALE_OWNER`。
5. 接收到更大 generation 时原子推进 fence，并把该用户旧 generation 的 `starting/running/waiting_*` run 标记 `interrupted`。
6. 同一个 run 内后续异步写入继续携带创建 run 时的 generation，不能读取 Redis 后自行换代。
7. `/session`、`/session/status`、permission/question 等列表查询必须在 SQL 中限定 userId。
8. `/global/event` 必须依据请求 header 在 OpenCode 内输出 user-scoped 事件流；Gateway 不承担逐帧数据库过滤。
9. HTTP 边界把可信 header 解码成 `RequestScope { userId, generation, requestId, runId? }`；业务 repository 从 scope 注入隔离条件，禁止调用方手工拼接 userId。
10. 浏览器传入的同名 header 必须由 Gateway 删除；OpenCode 仅信任 loopback Gateway。

内部错误建议：

| 场景                          | HTTP | code                      |
| ----------------------------- | ---: | ------------------------- |
| Session 不属于 userId         |  404 | `SESSION_NOT_FOUND`       |
| generation 已过期             |  409 | `STALE_OWNER`             |
| requestId 冲突且 payload 不同 |  409 | `IDEMPOTENCY_CONFLICT`    |
| MySQL 暂时不可用              |  503 | `PERSISTENCE_UNAVAILABLE` |
| schema 不兼容                 |  503 | `SCHEMA_VERSION_MISMATCH` |

## 5. 逻辑 Schema

表名前缀使用 `oc_`，字符集 `utf8mb4`，排序规则使用公司 MySQL 8 默认统一值。ID 使用 `VARCHAR(64)`；userId 使用 `VARCHAR(128)`；时间统一使用 `BIGINT` epoch milliseconds，与当前 OpenCode `Date.now()`、`DateTime.toEpochMillis()` 和 REST schema 保持一致。首期不引入 `DATETIME(3)` 转换层。

### 5.1 Schema 与 fence

#### `oc_schema_migration`

| 字段             | 约束            | 说明                            |
| ---------------- | --------------- | ------------------------------- |
| `version`        | PK, varchar(64) | migration 版本                  |
| `checksum`       | not null        | SQL 校验和                      |
| `applied_at`     | not null        | 执行时间                        |
| `binary_version` | not null        | 执行 migration 的 OpenCode 版本 |

#### `oc_user_fence`

| 字段                | 约束                      | 说明                            |
| ------------------- | ------------------------- | ------------------------------- |
| `user_id`           | PK                        | 全局唯一用户                    |
| `generation`        | bigint unsigned, not null | 当前允许写入的 owner generation |
| `owner_instance_id` | not null                  | 诊断字段，不作为授权真相        |
| `updated_at`        | not null                  | 最近推进时间                    |

generation 只能增加。推进语义：`SELECT ... FOR UPDATE`；新值小于当前值拒绝，相等继续，大于当前值更新并中断旧 run。

### 5.2 Session 投影表

#### `oc_session`

| 字段                           | 约束                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `id`                           | PK                                                                                                       |
| `user_id`                      | not null, index `(user_id, updated_at, id)`                                                              |
| `project_id`                   | not null, FK `oc_project.id`，云模式固定 `'cloud-virtual'`                                               |
| `workspace_id`                 | nullable，云模式固定 null                                                                                |
| `parent_id`                    | nullable, FK `oc_session.id`, index                                                                      |
| `directory`                    | not null，云模式固定 `'/'`                                                                               |
| `path`                         | nullable，云模式固定 null                                                                                |
| `slug`、`title`、`version`     | not null                                                                                                 |
| `agent`                        | nullable                                                                                                 |
| `model_json`                   | JSON, nullable                                                                                           |
| `metadata_json`                | JSON, nullable                                                                                           |
| `revert_json`                  | JSON, nullable                                                                                           |
| `status`                       | `idle\|starting\|running\|waiting_permission\|waiting_question\|completed\|failed\|aborted\|interrupted` |
| `owner_generation`             | bigint unsigned, not null                                                                                |
| `cost`、各 token 统计          | not null, default 0                                                                                      |
| `compacting_at`、`archived_at` | nullable                                                                                                 |
| `created_at`、`updated_at`     | not null                                                                                                 |

`project_id`、`workspace_id`、`directory`、`path` 不承载真实 workspace 语义，但保留数据库字段，避免破坏现有 Session、Location 和 Project 调用链。云模式只保存上述固定虚拟值，不保存用户文件路径。

`oc_session.status` 是持久化状态投影，替代 `packages/opencode/src/session/status.ts` 中纯内存 Map 作为生产真相。当前内存服务改为 repository-backed facade；状态变更与 `oc_run`、最终 event 在同一事务更新。

约束：父 Session 必须与子 Session 拥有相同 `user_id`。MySQL 无法通过普通 FK 完整表达时，由事务内查询和测试保证。

#### `oc_message`

| 字段                       | 约束                      |
| -------------------------- | ------------------------- |
| `id`                       | PK                        |
| `session_id`               | FK cascade, not null      |
| `user_id`                  | not null                  |
| `seq`                      | bigint unsigned, not null |
| `data_json`                | JSON, not null            |
| `created_at`、`updated_at` | not null                  |

唯一索引 `(session_id, seq)`；分页索引 `(session_id, created_at, id)`。

#### `oc_session_message`

对应现有 `SessionMessageTable`，保存事件驱动会话消息：

| 字段                       | 约束                      |
| -------------------------- | ------------------------- |
| `id`                       | PK                        |
| `session_id`、`user_id`    | not null, index           |
| `type`                     | not null                  |
| `seq`                      | bigint unsigned, not null |
| `data_json`                | JSON, not null            |
| `created_at`、`updated_at` | not null                  |

唯一索引 `(session_id, seq)`；索引 `(session_id, type, seq)` 和 `(session_id, created_at, id)`。若 OpenCode 当前版本同时维护 `session_message` 与 `message/part` 投影，二者必须在同一事务或同一事件投影事务中更新，不能出现 API 投影领先于 canonical event 的状态。

#### `oc_part`

| 字段                       | 约束                      |
| -------------------------- | ------------------------- |
| `id`                       | PK                        |
| `message_id`               | FK cascade, not null      |
| `session_id`               | FK cascade, not null      |
| `user_id`                  | not null                  |
| `position`                 | bigint unsigned, not null |
| `data_json`                | JSON, not null            |
| `created_at`、`updated_at` | not null                  |

唯一索引 `(message_id, position)`；索引 `(session_id, id)`。事务必须验证 message、session、user 三者一致。

#### `oc_todo`

主键 `(session_id, position)`；字段 `user_id,content,status,priority,created_at,updated_at`。Session 删除时 cascade。

#### `oc_session_context_epoch`

主键 `session_id`；字段 `user_id,baseline,baseline_seq,snapshot_json,updated_at`。保存 compaction/context 恢复状态。

### 5.3 输入、运行与幂等

#### `oc_session_input`

| 字段                    | 约束                                          |
| ----------------------- | --------------------------------------------- |
| `id`                    | PK                                            |
| `request_id`            | not null，unique `(user_id, request_id)`      |
| `session_id`、`user_id` | not null, index                               |
| `owner_generation`      | not null                                      |
| `prompt_json`           | JSON, not null                                |
| `payload_hash`          | not null                                      |
| `delivery`              | not null                                      |
| `admitted_seq`          | not null, unique `(session_id, admitted_seq)` |
| `promoted_seq`          | nullable, unique `(session_id, promoted_seq)` |
| `run_id`                | nullable, FK `oc_run.id`；输入加入执行后设置  |
| `created_at`            | not null                                      |

同一 userId 下 requestId + 相同 payload 重试返回首次结果；同一 userId 下 requestId + 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。不同 userId 可使用相同 requestId，查询冲突结果时不得泄露其他用户记录。

#### `oc_run`

| 字段                                        | 约束                       |
| ------------------------------------------- | -------------------------- |
| `id`                                        | PK，runId                  |
| `session_id`、`user_id`                     | not null, index            |
| `owner_generation`                          | not null                   |
| `owner_instance_id`                         | not null                   |
| `trigger_request_id`                        | not null，诊断字段，不唯一 |
| `status`                                    | not null                   |
| `error_code`、`error_json`                  | nullable                   |
| `started_at`、`heartbeat_at`、`finished_at` | 时间字段                   |

一个 `oc_run` 表示一次实际执行生命周期，不等同于一次输入请求。当前 coordinator 会让新输入 join 活跃执行，并 coalesce wake；因此多个 `oc_session_input` 可以关联同一个 run。`x-opencode-run-id` 由 Gateway 生成：Session 无活跃 run 时创建该 run；已有同 generation 活跃 run 时，新输入关联已有 run，传入 runId 只作为本次 Gateway 额度预留标识，OpenCode 返回实际 runId，Gateway 随后合并或释放重复预留。

OpenCode 从环境变量继承 `INSTANCE_ID`。每次子进程启动时，把该 `owner_instance_id` 下遗留的 `starting/running/waiting_*` run 标记 `interrupted`，不得自动重放模型调用。owner 切换时仍由更大 generation 中断旧 owner run。

**持久化改造说明**：现有 OpenCode 的 run 协调器（`run-coordinator.ts`）是通用内存调度原语——`Map<Key, Entry>` 管理活跃执行。它不携带 userId、requestId、generation，不直接承担持久化。引入 `oc_run` 是**新增业务层持久化逻辑**：

- Session execution facade：调用 coordinator 前创建或查找活跃 run，并把 input 关联实际 run。
- Execution settle：run 正常结束或失败时，同事务 update `oc_run`、`oc_session.status`、最终 event 和 `finished_at`。
- Execution interrupt：owner 切换、abort 或进程重启时，批量 update 旧 generation / 旧 instance 的活跃 run 为 `interrupted`。
- `run-coordinator.ts` 保持数据库无关；SQLite/MySQL 持久化逻辑写在 execution repository。
- 持久化逻辑写在业务层，两个 dialect 共用同一份代码，schema 定义各一套。

### 5.4 事件与序列

保留 OpenCode event-sourcing 语义：

#### `oc_event_sequence`

主键 `aggregate_id`；字段 `user_id,current_seq,owner_generation`。

#### `oc_event`

字段：`id` PK、`aggregate_id`、`user_id`、`seq`、`type`、`data_json`、`owner_generation`、`created_at`。

唯一索引 `(aggregate_id, seq)`；查询索引 `(user_id, aggregate_id, seq)` 和 `(aggregate_id, type, seq)`。

分配序列必须锁定 `oc_event_sequence` 对应行，递增和事件 insert 在同一事务。不能使用进程内计数。

### 5.5 Permission 与 Question

待回复状态必须持久化，不能只放进程内存：

- `oc_permission_request(id,session_id,user_id,status,payload_json,response_json,owner_generation,created_at,updated_at)`
- `oc_question_request(id,session_id,user_id,status,payload_json,response_json,owner_generation,created_at,updated_at)`

唯一主键 ID；索引 `(user_id,status,created_at)`。创建、回复、拒绝均先 commit，再发布 SSE。

首期工具白名单为空，这两类表通常无数据，但 schema 仍保留原始 OpenCode API 兼容能力。

**持久化改造说明**：基线 commit 同时存在两套实现：

- `packages/opencode/src/question/index.ts`、`permission/index.ts`：当前 instance HTTP REST 主调用链，使用 `InstanceState + Map + Deferred`。
- `packages/core/src/question.ts`、`permission.ts`：V2/Location 服务，供 core runner 和 `/api/*` 能力使用。

云模式若同时开放旧 REST 与 `/api/*`，两套 facade 必须调用同一个 request repository，禁止维护两份独立 pending 真相。若首期只开放一套，另一套端点必须明确返回 `CAPABILITY_DISABLED`，不能继续暴露内存实现。

引入 `oc_question_request` / `oc_permission_request` 表是**新增持久化逻辑**：

- **ask**：创建请求时，同事务 insert 对应表 `status=pending`，commit 后发布 SSE event。
- **reply / reject**：同事务 update `status=replied/rejected` + `response_json`，commit 后 resolve Deferred。
- **list**：改为从数据库读取 `status=pending` 的请求，而非内存 Map。
- **崩溃恢复**：进程重启后，从数据库查出 `status=pending` 的请求。由于关联模型调用不自动续跑，事务内把旧 instance/generation 的 pending 请求和对应 run 标记 `interrupted`；HTTP list 不再把它们作为可回复请求返回。
- 持久化逻辑写在业务层，两个 dialect 共用同一份代码，schema 定义各一套。

状态枚举固定为 `pending|replied|rejected|interrupted`。`reply/reject` 仅允许 `pending → terminal` 条件更新；重复相同回复幂等，不同回复返回冲突。数据库 commit 后再 resolve/fail 当前进程内 Deferred；若 Deferred 已不存在，数据库终态仍为真相。

### 5.6 Project 虚拟化

现有 OpenCode `SessionTable.project_id` 为 NOT NULL + FK 到 `ProjectTable`，大量上层代码依赖 project 关联（`session.ts`、`project/sql.ts`、`session/store.ts` 等）。云模式不引入真实 workspace/项目文件，但需兼容现有代码路径。

**方案：保留 project 表，插入单行虚拟 project**

```sql
-- MySQL 空库初始化时插入
INSERT INTO oc_project (id, name, directory, ...) VALUES ('cloud-virtual', 'cloud', '/', ...);
```

- 云模式所有 Session 的 `project_id` 固定为 `'cloud-virtual'`。
- 云模式所有 Session 的 `directory='/'`、`workspace_id=NULL`、`path=NULL`。
- `oc_project` 表 schema 与现有 `ProjectTable` 字段一一映射，仅底层数据库不同。
- 上层依赖 `session.project_id` 的代码无需改动，project 相关查询在云模式返回该虚拟行。
- SQLite 本地开发模式不受影响，继续使用真实 project。
- MySQL schema 中 `oc_session.project_id` 保留 NOT NULL + FK 到 `oc_project.id`，与现有约束一致。

## 6. 事务与对外可见顺序

### 6.1 创建 Session

同一事务：

1. 锁定/校验 `oc_user_fence`。
2. insert `oc_session(user_id,generation,...)`。
3. 初始化 event sequence 并写 `session.created` event。
4. commit。
5. REST 返回 Session，随后事件可发布。

### 6.2 接受 prompt

同一事务：

1. 校验 Session.userId 和 fence generation。
2. 按 requestId 查询幂等结果。
3. 分配 admitted sequence。
4. insert `oc_session_input`。
5. 查询该 Session、userId、generation 下活跃 run：无则使用 `x-opencode-run-id` insert `oc_run(status=starting)`；有则复用现有 run。
6. 把 input.run_id 关联实际 runId。
7. 更新 Session status 和 event。
8. commit 后返回 accepted，并返回实际 runId；Gateway 据此合并或释放重复并发额度预留。

MySQL commit 前不能向 Gateway 返回 2xx。

### 6.3 Message/Part 与 SSE

每一批准备发布的 Message/Part 变更：

1. 校验 fence。
2. 写入 `oc_session_message` 并 upsert `oc_message/oc_part` 投影表。
3. append event。
4. commit。
5. commit 成功后发布对应 SSE。

流式 delta 可做 20–50ms 小批量合并降低写放大，但只能发布已 commit 的批次；崩溃时最多减少中间展示频率，不能出现“浏览器已看到但数据库不存在”的内容。

现有 durable event 的 projector commit 已具备“event + projection 同事务、commit 后 notify”骨架。MySQL 实现必须保留该原子边界；非 durable UI 事件若对应业务状态，必须先转为 durable event 或提供显式 `commit` hook，不能直接 PubSub 后补写数据库。

### 6.4 Run 完成/失败/中断

同一事务更新 `oc_run`、`oc_session.status` 和最终 event。commit 后 Gateway 才释放 Redis 并发额度。Redis 释放失败由租约兜底，不回滚 MySQL 完成状态。

### 6.5 User-scoped SSE

`/global/event` 接收可信 `x-opencode-user-id` 后，只读取或订阅该 userId 关联的 event。事件投影和实时 PubSub 都必须携带 userId；无法确定 userId 的业务事件默认不发送。`server.connected`、`server.heartbeat` 可作为全局安全事件发送。文件、VCS、LSP、MCP、project 事件在云模式关闭。

## 7. 隔离级别、锁与重试

推荐：

- 事务隔离级别 `READ COMMITTED`。
- 锁等待超时 5 秒。
- 单事务目标 < 500ms；禁止在事务内调用模型、Redis、HTTP 或工具。
- 死锁、锁等待超时：仅对具有 requestId/eventId 的幂等事务最多重试 3 次，退避 50/100/200ms。
- 网络断开导致 commit 结果不确定：先按 requestId/eventId 查询，不得盲目重放。
- MySQL 不可用时 fail closed：不接受新 prompt，不发布未持久化 SSE。

所有列表和详情查询必须包含 `user_id` 条件。禁止先按 Session ID 查出数据，再仅在应用层过滤。

强制方式：

- HTTP middleware 生成不可变 `RequestScope`。
- `SessionRepository.forScope(scope)`、`EventRepository.forScope(scope)` 等 scoped port 自动添加 userId/generation 条件。
- 只有 migration、启动恢复和后台清理允许使用 unscoped admin port；这些入口不得被 HTTP handler 引用。
- Message/Part/Input/Run/Event 使用 `(user_id,id)` 或 `(user_id,session_id,...)` 唯一/外键约束，尽量让数据库拒绝跨用户关联。

## 8. 连接池

推荐每个 OpenCode 进程：

| 参数             |  默认值 |
| ---------------- | ------: |
| 最大连接         |      10 |
| 最小空闲         |       2 |
| 获取连接超时     |    3 秒 |
| 查询超时         |   10 秒 |
| 空闲连接回收     |   60 秒 |
| 连接最大生命周期 | 30 分钟 |

全局容量必须满足：`Gateway 最大实例数 × 10 + migration/运维预留` 小于 MySQL 账号连接上限。若不满足，先降低单实例连接池或提高数据库配额，不能上线后依靠连接失败限流。

### 8.1 MySQL 驱动选型

| 项              | 选择                                     | 说明                                                                              |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Node.js 驱动    | `mysql2`                                 | 社区主流，支持 Promise、连接池、TLS、`COM_STMT_PREPARE`                           |
| Drizzle dialect | `drizzle-orm/mysql2`                     | 官方支持 `mysqlTable` schema 定义，与 SQLite 的 `drizzle-orm/bun-sqlite` 对称     |
| Effect 包装     | 新建 `@opencode-ai/effect-drizzle-mysql` | 对标现有 `@opencode-ai/effect-drizzle-sqlite`，封装 Effect Layer + 连接池生命周期 |
| 连接池          | `mysql2` 内置 `createPool`               | Drizzle 的 `drizzle({ pool })` 直接消费 mysql2 pool                               |

**SQLite 行为保持兼容**：现有 `@opencode-ai/effect-drizzle-sqlite` + `drizzle-orm/bun-sqlite` 继续用于本地开发和测试；现有 SQLite schema/migration 不移动、不删除。业务查询会迁入 repository 的 SQLite 实现，但生成 SQL 和测试语义保持不变。

**禁止假设 query builder 跨 dialect 兼容**：SQLite 使用 `.get/.all/.run`、`returning`、`onConflictDoUpdate`、`transaction({ behavior: "immediate" })`；MySQL 使用异步 query result、`onDuplicateKeyUpdate`、独立 select 回读和 MySQL transaction config。两套实现共享 domain input/output 和事务语义，不共享 dialect-specific 链式调用。

**Dialect 选择**：启动时根据环境变量 `OPENCODE_DB_DIALECT`（`sqlite` / `mysql`）决定加载哪套 schema 和连接层；未设置时默认 `sqlite`，保持现有行为不变。

## 9. Migration

OpenCode 二进制提供独立命令：

```bash
/opt/opencode/bin/opencode db migrate
```

规则：

- 部署流水线在发布 Gateway 容器前只执行一次 migration Job。
- 使用 MySQL `GET_LOCK('opencode-schema-migrate', 60)` 防止并发执行。
- 每个 migration 记录 version、checksum、binary version。
- 已执行 migration checksum 变化时立即失败。
- `opencode serve` 只检查 schema 版本，不自动创建或修改表。
- 当前 SQLite `Database.layer` 会执行 PRAGMA 和 `DatabaseMigration.apply()`；改造后该逻辑只保留在 SQLite layer。MySQL serve layer 只能连接、校验 schema version 和 readiness。
- schema 版本低于二进制最低版本或高于最高兼容版本时，readiness 失败并返回 `SCHEMA_VERSION_MISMATCH`。

空库上线流程：

1. 创建空 database/schema 和最小权限账号。
2. 执行 `opencode db migrate`。
3. 执行 schema smoke test。
4. 部署 OpenCode/Gateway。
5. 创建测试用户首个 Session，验证 MySQL 记录和 SSE 顺序。

不执行 SQLite scan、import、dual-write、backfill 或历史校验。

## 10. Schema 升级与回滚

采用 expand/contract：

1. expand migration 只新增 nullable 字段、表或索引。
2. 发布同时兼容新旧 schema 的二进制。
3. 全量切换并观察。
4. 后续独立版本执行 contract，删除旧字段。

每个二进制至少兼容当前 schema 和前一 schema。应用回滚只允许回到仍兼容当前 schema 的版本；数据库 DDL 不做自动逆向回滚。破坏性 migration 前必须有备份和演练记录。

## 11. MySQL 高可用与备份前提

RPO=0 依赖公司 MySQL 提供同步或等价零数据丢失承诺。若平台主从切换可能丢失已确认事务，系统不能宣称 RPO=0。

推荐生产前提：

- Multi-AZ/主备自动切换。
- 主库事务 commit 后才向客户端确认。
- 自动备份 + binlog/PITR，保留至少 30 天。
- 每季度恢复演练。
- 推荐 RTO <= 5 分钟；切换期间 OpenCode fail closed。

Blobstore/CDN 不参与会话主链路，可用于数据库备份产物，但不是恢复真相。

## 12. 数据删除与保留

- 用户 Session 默认长期保存，不按 Gateway 或 Redis TTL 删除。
- 用户显式删除 Session：同事务删除/标记 Session。Message、Part、Todo、Input 等使用 FK cascade；Run、EventSequence/Event、Permission、Question 若无法直接建立 Session FK，则由 `SessionRepository.delete` 显式按 userId + sessionId/aggregateId 删除并记录审计 event。验收必须验证无孤儿记录。
- 建议业务数据采用 7 天软删除窗口后物理清理；若 OpenCode API 必须立即硬删除，则以 API 语义为准并记录审计事件。
- 不把 Prompt/Message 明文写入普通应用日志。
- 后续归档必须基于容量数据另立方案，首期不做分表分库。

## 13. 配置与账号权限

推荐环境变量：

| 变量                          | 说明                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `MYSQL_URL`                   | Secret 注入，包含 TLS 和连接参数                          |
| `MYSQL_POOL_MAX`              | 默认 10                                                   |
| `MYSQL_ACQUIRE_TIMEOUT_MS`    | 默认 3000                                                 |
| `MYSQL_QUERY_TIMEOUT_MS`      | 默认 10000                                                |
| `INSTANCE_ID`                 | 当前 Gateway/OpenCode 容器实例 ID，用于启动时中断遗留 run |
| `OPENCODE_SCHEMA_MIN_VERSION` | 二进制支持下限                                            |
| `OPENCODE_SCHEMA_MAX_VERSION` | 二进制支持上限                                            |

#### staging 连接信息

| 项           | 值                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 代理地址     | `kwaiproxy.staging.mysql.internal:6032`                                                                                       |
| 用户名       | `ai_code_47627_v1_rw`                                                                                                         |
| 密码         | 通过 Secret 注入                                                                                                              |
| 环境变量拼接 | `MYSQL_URL=mysql://ai_code_47627_v1_rw:<密码>@kwaiproxy.staging.mysql.internal:6032/ai_code`                                  |

> ⚠️ 密码必须通过 Secret 注入环境变量，禁止写入镜像、代码仓库或日志。上表仅用于 staging 初始化配置参考，生产环境必须使用独立账号和密码。

运行账号权限：对 `oc_*` 表执行 SELECT/INSERT/UPDATE/DELETE，不授予 DDL、CREATE USER、GRANT。migration 使用独立账号，允许必要 DDL。两类账号都由 Secret 注入，禁止写入镜像和日志。

### 13.1 Schema 上线方式：手工工单，不再自动 migrate

自 2026-07-31 起，staging（集群 27736）与生产（集群 28029）的 `oc_*` 表结构均由 KDB 手工工单建立，`oc_schema_migration.binary_version` 记为 `manual-ddl`。应用启动只做 `MysqlMigration.check`，仅校验最新 version 是否落在支持区间，不再触发 `MysqlMigration.migrate` 建表或补列。

采用该模式的原因是 KDB 平台的审核规则与 `MysqlMigration` 生成的 DDL 不兼容：

| KDB 硬性规则                       | 对 migration 的影响                                            |
| ---------------------------------- | -------------------------------------------------------------- |
| 禁止外键                           | 所有 `CONSTRAINT ... FOREIGN KEY` 必须去掉，`ON DELETE CASCADE` 随之失效 |
| 表必须显式指定 `COLLATE`           | 需补 `COLLATE=utf8mb4_general_ci`                              |
| 每列必须有 `COMMENT`               | 需为全部列补注释                                               |
| 索引名需 `idx_` / `uniq_` 前缀     | 需重命名全部索引                                               |
| 禁止 `IF [NOT] EXISTS`             | 建表语句不能带存在性判断                                       |
| 存在外键的表禁止走自动审核工单变更 | 已建出的外键无法通过工单摘除，只能 `RENAME TABLE` 旧表后重建   |

因此新增 migration 时：

1. 在 `packages/core/src/persistence/mysql/migration/` 追加迁移文件，供本地开发与测试用 `migrate` 自动建表。**新增 DDL 一律不得包含外键**，否则线上与本地结构再次分叉。
2. 按上表规则手写等价的 KDB 兼容 SQL，先用 `ks-cli kdb sql-workflow single-check` 审核到 `error_count: 0`，再 `single-submit` 提交工单。
3. SQL 末尾补 `INSERT INTO oc_schema_migration`，`checksum` 必须等于 `sha256(statements.join("\n"))`，与 `migration.ts` 的算法一致；否则应用启动报 `Migration checksum mismatch`。
4. staging 与生产各提一次工单，不能只提其中一个。

历史归档 SQL 位于 `docs/sql/`：`oc-mysql-init-prod.sql`（生产初始化，工单 909498）、`oc-mysql-staging-realign.sql`（staging 对齐生产，工单 909536）。

> ⚠️ 由于外键被禁，级联删除必须由应用承担。`MysqlSessionRepository.remove` 需显式删除全部 Session 作用域子表，`removeMessage` 需显式删除其 Part。对应验收见 §15.1，回归测试见 `packages/core/test/persistence-mysql.test.ts`。

## 14. 故障语义

| 故障                            | 行为                                                      |
| ------------------------------- | --------------------------------------------------------- |
| MySQL 在 prompt accepted 前失败 | 返回 503；请求未接受，可用相同 requestId 重试             |
| MySQL 在 SSE 发布前失败         | 不发布该事件；run 失败或等待恢复                          |
| commit 结果不确定               | 按 requestId/eventId 查询后决定返回，不盲重试             |
| OpenCode 进程崩溃               | 已 commit 数据保留；活跃 run 标记 interrupted，不自动续跑 |
| Gateway owner 切换              | 新 generation 推进 fence；旧 generation 写入返回 409      |
| Redis 丢失                      | 会话数据不丢；重建 owner 后推进 generation                |
| schema 不兼容                   | OpenCode not-ready，拒绝业务流量                          |

## 15. 验收测试

### 15.1 正确性

- Session 创建事务同时写入 userId、generation 和 created event。
- prompt 只有在 input/run commit 后返回 accepted。
- 每个 SSE Message/Part 都能在发送前从 MySQL 查询到对应状态。
- 相同 userId + requestId 重试不产生重复输入或事件；若首次请求加入已有 run，重试仍返回同一实际 runId。
- 不同 payload 复用 requestId 返回冲突。

### 15.2 用户隔离

- 所有 Session/Message/Part/List 查询包含 userId。
- 用户 A 使用用户 B Session ID 时返回 404，不泄露是否存在。
- 父子 Session userId 不一致时事务失败。
- permission/question/todo/event 同样隔离。

### 15.3 Fencing

- generation=10 owner 写入成功。
- generation 推进到 11 后，generation=10 的所有写入稳定返回 `STALE_OWNER`。
- 两个容器并发 claim 10/11/12，最终只允许最大 generation。
- 推进 generation 时旧活跃 run 被标记 interrupted。

### 15.4 故障注入

- commit 前断网：客户端未收到 accepted/SSE。
- commit 后响应前断网：相同 requestId 重试得到首次结果。
- 主从切换、死锁、连接池耗尽、查询超时均不产生重复记录。
- OpenCode 在连续 delta、permission 等待、question 等待、compaction 中崩溃后状态可解释并恢复读取。

### 15.5 性能

首期建议验收基线，容量数据出来后调整：

- Session 列表 p95 < 200ms。
- 消息分页 p95 < 200ms。
- 单批 Part commit p95 < 100ms。
- 100 个 Gateway 进程连接池不会超过 MySQL 上限。
- 每用户 2 个并发 run、多个用户并行时无全表锁和热点序列。

## 16. 实施顺序

### 16.1 Phase 0：实施前技术验证

当前基线盘点结果：7 个 `packages/core/src/**/sql.ts`、38 个 SQLite migration、111 个 `.get/.all/.run` 调用、7 个 `returning`、9 个 `onConflictDo*`。这些数字只用于说明影响面，不作为长期常量。

正式开发前必须完成：

1. 固定目标 commit；输出表、migration、数据库调用点、HTTP V1/V2 调用链清单。
2. 建立最小 `SessionRepository`、`EventRepository`、`FenceRepository` port。
3. SQLite 实现跑通现有测试，证明抽取 port 不改变本地行为。
4. MySQL 垂直 spike 跑通：创建 Session、接受 prompt、复用/创建 run、append durable event、commit 后通知。
5. 验证 MySQL 特有语义：`SELECT ... FOR UPDATE`、首次 fence 并发创建、`onDuplicateKeyUpdate`、无 `RETURNING` 回读、deadlock retry、commit 结果未知处理。
6. 验证 `opencode serve` 在 MySQL 模式不执行 DDL，schema 不兼容时 readiness 失败。
7. 确认云模式开放的 REST 家族；V1/V2 未开放端点必须明确关闭。

Phase 0 出口：上述 spike 和测试全部通过，repository 接口评审通过，本文源码基线和影响面已刷新。未通过前，不批量复制 MySQL schema、不全面替换数据库调用。

### 16.2 Repository/port 设计

上层业务只依赖 domain port，不直接接触 Drizzle table/query builder：

```typescript
export interface RequestScope {
  readonly userId: string
  readonly generation: bigint
  readonly requestId: string
  readonly runId?: string
}

export interface SessionRepository {
  readonly create: (scope: RequestScope, input: CreateSession) => Effect.Effect<Session>
  readonly get: (scope: RequestScope, sessionId: string) => Effect.Effect<Session | undefined>
  readonly admit: (scope: RequestScope, input: AdmitPrompt) => Effect.Effect<AdmissionResult>
  readonly append: (scope: RequestScope, input: SessionEventBatch) => Effect.Effect<CommittedBatch>
  readonly finishRun: (scope: RequestScope, input: FinishRun) => Effect.Effect<void>
}
```

推荐结构：

```text
packages/core/src/persistence/
├── scope.ts                    # RequestScope 与可信边界校验
├── port/                       # domain repository 接口和 DTO
│   ├── session.ts
│   ├── event.ts
│   ├── fence.ts
│   ├── request.ts              # permission/question
│   └── migration.ts
├── sqlite/                     # 使用现有 sqliteTable 和 EffectDrizzleSqlite
│   ├── session.ts
│   ├── event.ts
│   └── ...
└── mysql/                      # mysqlTable + mysql2，各自实现 SQL
    ├── schema/
    ├── session.ts
    ├── event.ts
    ├── layer.ts
    └── migration/
```

现有 `packages/core/src/**/sql.ts` 和 SQLite migration 原地保留。MySQL schema 可按业务域组织，不要求与 SQLite 文件一一复制。domain DTO 负责 JSON、时间、decimal/number 转换；禁止把 Drizzle dialect table 类型暴露到 port。

事务边界由 repository 方法定义。需要 event + projection 原子提交的流程使用同一 dialect transaction context；禁止在业务层分别调用两个 repository 后假设原子性。

### 16.3 Dialect 选择

```typescript
const dialect = process.env.OPENCODE_DB_DIALECT ?? "sqlite"
const persistenceLayer = dialect === "mysql" ? mysqlPersistenceLayer(config) : sqlitePersistenceLayer(path())
```

- 未设置时默认 SQLite。
- MySQL 模式缺少 `MYSQL_URL`、`INSTANCE_ID` 或 schema 不兼容，启动失败/not-ready。
- SQLite layer 保留 PRAGMA 和本地自动 migration。
- MySQL serve layer不执行 DDL；`opencode db migrate` 使用独立 migration layer 和账号。

### 16.4 正式开发顺序

1. 完成 port、RequestScope、SQLite 实现抽取；现有测试全绿。
2. 定义 MySQL schema、独立 migration CLI、schema compatibility check。
3. 实现 user fence、scoped Session CRUD、父子 Session 一致性。
4. 实现 SessionInput、Run 复用/关联、幂等 accepted。
5. 实现 durable Event、SessionMessage/Message/Part/Todo/Context projection 和 commit 后 notify。
6. 把 `packages/opencode` SessionStatus 改成 repository-backed facade。
7. 持久化实际开放 REST 家族的 permission/question；统一 V1/V2 repository。
8. 实现 abort、owner 切换、实例重启的 interrupted 状态机。
9. 完成隔离、幂等、故障、性能测试。
10. 空库执行 migration，完成 Gateway/Sticky Proxy 联调和发布演练。

## 17. 生产发布门禁

- Phase 0 出口全部满足，目标 commit、影响面清单和 repository 接口已冻结。
- migration 在空库和已存在上一版本 schema 上均通过。
- `opencode serve` 不自动执行 DDL。
- 本地 SQLite 在生产完全禁用。
- RPO=0 顺序、幂等、用户隔离和 generation fencing 测试通过。
- MySQL HA 能力确实满足零丢失；恢复演练通过。
- 连接池总量小于数据库连接配额。
- 回滚版本与当前 schema 兼容并演练通过。
- 通信方案的 Gateway/Sticky Proxy 端到端验收通过。
- 本地开发模式（`OPENCODE_DB_DIALECT` 未设置）默认 SQLite 行为不变，现有测试全部通过。
- MySQL 模式下虚拟 project 行存在，所有 Session 可正常创建。
- run/question/permission_request 持久化在进程崩溃重启后状态可恢复。
- HTTP handler 不能引用 unscoped admin repository；静态检查和越权测试通过。
- 云模式未开放的 V1/V2 permission/question 路径已显式关闭，不存在内存 pending 旁路。
- `x-opencode-run-id`、accepted 返回实际 runId、Gateway 重复额度合并规则已同步到关联通信方案并完成联调。
