-- OpenCode MySQL 持久化：生产环境初始化建表（集群 28029 AiCodeM0 / 库 ai_code）
-- 目标 schema 版本：0003_runtime_facades（等价于 0001_mysql_spike + 0002_full_repository + 0003_runtime_facades）
-- 来源：packages/core/src/persistence/mysql/migration/*.ts
--
-- 相对源码 migration 的 KDB 平台适配（审核硬性要求）：
--   1. 表级显式 COLLATE=utf8mb4_general_ci
--   2. 所有列必须有 COMMENT
--   3. 禁用外键：源码中所有 CONSTRAINT ... FOREIGN KEY 已删除，级联删除改由 SessionRepository 显式处理
--   4. 唯一索引统一 uniq_ 前缀，普通索引统一 idx_ 前缀

USE `ai_code`;

-- 1) schema 版本表：应用启动时 MysqlMigration.check 读取本表最新 version
CREATE TABLE oc_schema_migration (
  version VARCHAR(64) NOT NULL COMMENT '迁移版本号',
  checksum VARCHAR(64) NOT NULL COMMENT '迁移语句 sha256 校验和',
  applied_at BIGINT NOT NULL COMMENT '应用时间，毫秒时间戳',
  binary_version VARCHAR(64) NOT NULL COMMENT '执行迁移的二进制版本',
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode schema 迁移记录';

-- 2) owner fencing：Gateway owner 切换时推进 generation
CREATE TABLE oc_user_fence (
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  generation BIGINT UNSIGNED NOT NULL COMMENT '当前 owner 代数',
  owner_instance_id VARCHAR(128) NOT NULL COMMENT '当前 owner 容器实例 ID',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 用户 owner fencing';

-- 3) 项目
CREATE TABLE oc_project (
  id VARCHAR(64) NOT NULL COMMENT '项目 ID',
  name VARCHAR(255) NULL COMMENT '项目名称',
  directory VARCHAR(2048) NOT NULL COMMENT '项目根目录，云模式为虚拟值',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 项目';

-- 4) 会话主表
CREATE TABLE oc_session (
  id VARCHAR(64) NOT NULL COMMENT '会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID，所有查询必须带此条件做隔离',
  owner_generation BIGINT UNSIGNED NOT NULL COMMENT '写入时的 owner 代数，用于 fencing',
  project_id VARCHAR(64) NOT NULL COMMENT '所属项目 ID',
  workspace_id VARCHAR(64) NULL COMMENT '所属工作区 ID',
  parent_id VARCHAR(64) NULL COMMENT '父会话 ID，子会话非空',
  slug VARCHAR(255) NOT NULL DEFAULT '' COMMENT '会话短标识',
  directory VARCHAR(2048) NOT NULL COMMENT '会话工作目录',
  path VARCHAR(2048) NULL COMMENT '会话相对路径',
  title VARCHAR(512) NOT NULL COMMENT '会话标题',
  version VARCHAR(64) NOT NULL DEFAULT '' COMMENT '创建会话的 OpenCode 版本',
  share_url VARCHAR(2048) NULL COMMENT '分享链接',
  summary_json JSON NULL COMMENT '会话摘要 JSON',
  metadata_json JSON NULL COMMENT '会话元数据 JSON',
  cost DOUBLE NOT NULL DEFAULT 0 COMMENT '累计费用',
  tokens_input BIGINT NOT NULL DEFAULT 0 COMMENT '累计输入 token 数',
  tokens_output BIGINT NOT NULL DEFAULT 0 COMMENT '累计输出 token 数',
  tokens_reasoning BIGINT NOT NULL DEFAULT 0 COMMENT '累计推理 token 数',
  tokens_cache_read BIGINT NOT NULL DEFAULT 0 COMMENT '累计缓存读取 token 数',
  tokens_cache_write BIGINT NOT NULL DEFAULT 0 COMMENT '累计缓存写入 token 数',
  revert_json JSON NULL COMMENT '回滚点信息 JSON',
  permission_json JSON NULL COMMENT '会话级权限配置 JSON',
  agent VARCHAR(255) NULL COMMENT '当前使用的 agent 名称',
  model_json JSON NULL COMMENT '当前模型信息 JSON',
  status VARCHAR(32) NOT NULL COMMENT '会话状态，持久化状态投影',
  status_json JSON NULL COMMENT '会话状态明细 JSON',
  compacting_at BIGINT NULL COMMENT '上下文压缩开始时间，毫秒时间戳',
  archived_at BIGINT NULL COMMENT '归档时间，毫秒时间戳',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (id),
  KEY idx_oc_session_user_updated_id (user_id, updated_at, id),
  KEY idx_oc_session_parent (user_id, parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 会话主表';

-- 5) run 生命周期
CREATE TABLE oc_run (
  id VARCHAR(64) NOT NULL COMMENT 'run ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  owner_generation BIGINT UNSIGNED NOT NULL COMMENT '写入时的 owner 代数',
  owner_instance_id VARCHAR(128) NOT NULL DEFAULT '' COMMENT '执行该 run 的容器实例 ID',
  trigger_request_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '触发该 run 的请求 ID',
  status VARCHAR(32) NOT NULL COMMENT 'run 状态：starting/running/waiting_permission/waiting_question/interrupted 等',
  error_code VARCHAR(128) NULL COMMENT '失败错误码',
  error_json JSON NULL COMMENT '失败详情 JSON',
  heartbeat_at BIGINT NULL COMMENT '最近心跳时间，毫秒时间戳',
  finished_at BIGINT NULL COMMENT '结束时间，毫秒时间戳',
  started_at BIGINT NOT NULL COMMENT '开始时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (user_id, id),
  KEY idx_oc_run_active (user_id, session_id, owner_generation, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode run 生命周期';

-- 6) 事件序列
CREATE TABLE oc_event_sequence (
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  aggregate_id VARCHAR(64) NOT NULL COMMENT '聚合根 ID',
  seq INT NOT NULL COMMENT '当前最大事件序号',
  owner_generation BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '写入时的 owner 代数',
  PRIMARY KEY (user_id, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 事件序号游标';

-- 7) 事件
CREATE TABLE oc_event (
  id VARCHAR(64) NOT NULL COMMENT '事件 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  aggregate_id VARCHAR(64) NOT NULL COMMENT '聚合根 ID',
  seq INT UNSIGNED NOT NULL COMMENT '聚合内单调递增事件序号',
  type VARCHAR(128) NOT NULL COMMENT '事件类型',
  data JSON NOT NULL COMMENT '事件载荷 JSON',
  owner_generation BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '写入时的 owner 代数',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  PRIMARY KEY (user_id, id),
  UNIQUE KEY uniq_oc_event_aggregate_seq (user_id, aggregate_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 事件溯源';

-- 8) 会话输入（准入-提升两阶段）
CREATE TABLE oc_session_input (
  id VARCHAR(64) NOT NULL COMMENT '输入记录 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  owner_generation BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '写入时的 owner 代数',
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  run_id VARCHAR(64) NOT NULL COMMENT '关联 run ID',
  request_id VARCHAR(64) NOT NULL COMMENT '客户端请求 ID，用于幂等',
  prompt JSON NOT NULL COMMENT 'prompt 载荷 JSON',
  payload_hash VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'prompt 载荷哈希，用于检测同 requestId 冲突',
  delivery VARCHAR(16) NOT NULL COMMENT '投递模式：steer 或 queue',
  admitted_seq INT UNSIGNED NOT NULL COMMENT '准入序号',
  promoted_seq INT UNSIGNED NULL COMMENT '提升为可见用户消息的序号，未提升为 NULL',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  PRIMARY KEY (user_id, id),
  UNIQUE KEY uniq_oc_session_input_request (user_id, request_id),
  UNIQUE KEY uniq_oc_session_input_admitted (user_id, session_id, admitted_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 会话输入准入队列';

-- 9) 请求幂等去重
CREATE TABLE oc_request_dedup (
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  request_id VARCHAR(64) NOT NULL COMMENT '客户端请求 ID',
  operation VARCHAR(64) NOT NULL COMMENT '操作名',
  payload_hash VARCHAR(64) NOT NULL COMMENT '请求载荷哈希',
  response JSON NOT NULL COMMENT '首次响应结果 JSON，重试直接返回',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  PRIMARY KEY (user_id, request_id, operation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 请求幂等去重';

-- 10) 消息
CREATE TABLE oc_message (
  id VARCHAR(64) NOT NULL COMMENT '消息 ID',
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  seq BIGINT UNSIGNED NOT NULL COMMENT '会话内单调递增消息序号',
  data_json JSON NOT NULL COMMENT '消息内容 JSON',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (id),
  UNIQUE KEY uniq_oc_message_session_seq (session_id, seq),
  KEY idx_oc_message_session_created_id (user_id, session_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 消息';

-- 11) 会话消息流
CREATE TABLE oc_session_message (
  id VARCHAR(64) NOT NULL COMMENT '会话消息 ID',
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  type VARCHAR(128) NOT NULL COMMENT '消息类型',
  seq BIGINT UNSIGNED NOT NULL COMMENT '会话内单调递增序号',
  data_json JSON NOT NULL COMMENT '消息内容 JSON',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (id),
  UNIQUE KEY uniq_oc_session_message_session_seq (session_id, seq),
  KEY idx_oc_session_message_type_seq (user_id, session_id, type, seq),
  KEY idx_oc_session_message_created_id (user_id, session_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 会话消息流';

-- 12) 消息分段
CREATE TABLE oc_part (
  id VARCHAR(64) NOT NULL COMMENT '分段 ID',
  message_id VARCHAR(64) NOT NULL COMMENT '所属消息 ID',
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  position BIGINT UNSIGNED NOT NULL COMMENT '消息内分段位置',
  data_json JSON NOT NULL COMMENT '分段内容 JSON',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (id),
  UNIQUE KEY uniq_oc_part_message_position (message_id, position),
  KEY idx_oc_part_session_id (user_id, session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 消息分段';

-- 13) 会话级 Todo
CREATE TABLE oc_todo (
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  position INT UNSIGNED NOT NULL COMMENT '列表内位置',
  content TEXT NOT NULL COMMENT 'Todo 内容',
  status VARCHAR(32) NOT NULL COMMENT '状态：pending/in_progress/completed',
  priority VARCHAR(32) NOT NULL COMMENT '优先级',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (session_id, position),
  KEY idx_oc_todo_user_session (user_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 会话级 Todo';

-- 14) 上下文分代快照
CREATE TABLE oc_session_context_epoch (
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  baseline TEXT NOT NULL COMMENT '上下文 baseline 内容',
  baseline_seq BIGINT UNSIGNED NOT NULL COMMENT 'baseline 对应的消息序号',
  snapshot_json JSON NOT NULL COMMENT '上下文快照 JSON',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (session_id),
  KEY idx_oc_context_epoch_user (user_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 上下文分代快照';

-- 15) 权限请求
CREATE TABLE oc_permission_request (
  id VARCHAR(64) NOT NULL COMMENT '权限请求 ID',
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  status VARCHAR(32) NOT NULL COMMENT '状态：pending/approved/rejected',
  payload_json JSON NOT NULL COMMENT '请求载荷 JSON',
  response_json JSON NULL COMMENT '响应结果 JSON',
  owner_generation BIGINT UNSIGNED NOT NULL COMMENT '写入时的 owner 代数',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (id),
  KEY idx_oc_permission_pending (user_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 权限请求';

-- 16) 问答请求
CREATE TABLE oc_question_request (
  id VARCHAR(64) NOT NULL COMMENT '问答请求 ID',
  session_id VARCHAR(64) NOT NULL COMMENT '所属会话 ID',
  user_id VARCHAR(128) NOT NULL COMMENT '用户 ID',
  status VARCHAR(32) NOT NULL COMMENT '状态：pending/answered/rejected',
  payload_json JSON NOT NULL COMMENT '请求载荷 JSON',
  response_json JSON NULL COMMENT '响应结果 JSON',
  owner_generation BIGINT UNSIGNED NOT NULL COMMENT '写入时的 owner 代数',
  created_at BIGINT NOT NULL COMMENT '创建时间，毫秒时间戳',
  updated_at BIGINT NOT NULL COMMENT '更新时间，毫秒时间戳',
  PRIMARY KEY (id),
  KEY idx_oc_question_pending (user_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='OpenCode 问答请求';

-- 17) 标记三个迁移已应用
-- checksum = sha256(statements.join("\n"))，与 migration.ts 的计算一致，必须逐字保持；
-- 否则应用启动时会报 Migration checksum mismatch。
INSERT INTO oc_schema_migration (version, checksum, applied_at, binary_version) VALUES
  ('0001_mysql_spike', '2a8d9b28d0d23596c9272031ef4f964df28a65443df6b4cfefcdbbdf57e7099b', UNIX_TIMESTAMP() * 1000, 'manual-ddl'),
  ('0002_full_repository', '29dd2456d817a79bdddeb0065852fcb70afaf03e9161c54596c51bcbb607539f', UNIX_TIMESTAMP() * 1000, 'manual-ddl'),
  ('0003_runtime_facades', 'b8c017ad06c055c1db540c5eff44729e42ef734701ed65bed02a280633291652', UNIX_TIMESTAMP() * 1000, 'manual-ddl');
