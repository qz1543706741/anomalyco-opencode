# OpenCode Web UI 与 Server 通信架构文档

> 本文档描述 `packages/app`（Web UI）与 opencode server 之间的通信机制，供自建 Web UI 复用通信逻辑参考。

---

## 1. 通信协议总览

Web UI 使用两种协议与 server 通信：

| 协议 | 用途 | 传输方式 | 端点 |
|------|------|---------|------|
| HTTP REST | 请求/响应式 API 调用（session CRUD、提交 prompt、配置等） | 原生 `fetch` | `/session/*`、`/config`、`/provider` 等 |
| SSE (Server-Sent Events) | 实时事件流（session 状态变更、消息增量、权限请求等） | `fetch` + `ReadableStream` 解析 | `/global/event` |

---

## 2. Server URL 发现与配置

### 2.1 URL 确定逻辑

参考 `packages/app/src/entry.tsx:99-105`：

```ts
const getCurrentUrl = () => {
  // 部署在 opencode.ai 域名下时，默认连接 localhost:4096
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  // 开发模式：从环境变量读取
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  // 生产同源部署：使用 location.origin
  return location.origin
}
```

### 2.2 持久化

- 默认 server URL 存储在 `localStorage`，key 为 `opencode.settings.dat:defaultServerUrl`
- 优先读 localStorage，回退到 `getCurrentUrl()`

### 2.3 鉴权

- URL query param `?auth_token=xxx` 在启动时解析，通过 `authFromToken()` 解码为 `username`/`password`
- token 读取后立即从 URL 中移除
- 每个请求通过 HTTP Basic Auth header 携带鉴权信息
- 参考 `packages/app/src/utils/server.ts:19-42`

---

## 3. SDK 客户端创建

### 3.1 客户端工厂

参考 `packages/app/src/utils/server.ts:19-42`：

```ts
export function createSdkForServer({ server, ...config }) {
  const auth = server.password
    ? { Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}` }
    : undefined

  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...auth },
    baseUrl: server.url,
  })
}
```

### 3.2 底层实现

- SDK 由 OpenAPI spec 自动生成，位于 `packages/sdk/js`
- 底层使用原生 `fetch` API，无 axios 依赖
- 客户端创建链路：
  1. `createSdkForServer()` → 设置 baseUrl + auth headers
  2. `createOpencodeClient()` (`packages/sdk/js/src/v2/client.ts:50`) → 包装生成客户端，注入自定义 fetch（禁用 timeout）
  3. `createClient()` (`packages/sdk/js/src/v2/gen/client/client.gen.ts`) → 创建含 get/post/put/patch/delete + sse 方法的 Client 对象
  4. 每个方法内部构建 Request → 运行请求拦截器 → `fetch()` → 运行响应拦截器 → 解析响应

### 3.3 请求拦截器

参考 `packages/sdk/js/src/v2/client.ts:32-47`：

- 将 `x-opencode-directory` 和 `x-opencode-workspace` header 重写为 GET 请求的 query param（避免 preflight）

### 3.4 Directory 作用域

- 每个 SDK 客户端可通过 `x-opencode-directory` header 限定到特定项目目录
- 同一个 server URL 可以服务多个项目目录
- 参考 `packages/app/src/context/sdk.tsx`

---

## 4. SSE 事件流

### 4.1 连接建立

参考 `packages/app/src/context/server-sdk.tsx:96-110`：

```ts
const events = await eventSdk.global.event({
  signal: attempt.signal,
  onSseError: (error) => { ... },
})
for await (const event of events.stream) {
  // 处理事件
}
```

- 连接到 `/global/event` SSE 端点
- 底层用 `fetch` 获取 `text/event-stream` 响应，通过 `ReadableStream` + `TextDecoderStream` 逐帧解析
- SSE 客户端实现：`packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts`
- 支持 `Last-Event-ID` header 实现断点续传（客户端侧已实现，服务端尚未使用）

### 4.2 事件处理流水线

```
SSE Stream
  → 事件入队 (queue)
  → 事件合并 (coalesce)
    ├─ lsp.updated: 同 directory 同事件替换
    ├─ message.part.updated: 同 directory+message+part 替换
    └─ message.part.delta: 同 message+part+field 的 delta 拼接
  → 16ms flush timer 批量触发
  → SolidJS batch() 中 emitter.emit(directory, payload)
  → 各模块通过 event listener 消费
```

参考 `packages/app/src/context/server-sdk.tsx:30-128`

### 4.3 关键参数

| 参数 | 值 | 说明 |
|------|----|------|
| FLUSH_FRAME_MS | 16ms | 事件批量 flush 间隔（约一帧） |
| STREAM_YIELD_MS | 8ms | 流处理 yield 阈值，超过则让出主线程 |
| RECONNECT_DELAY_MS | 250ms | 重连延迟 |
| HEARTBEAT_TIMEOUT_MS | 15000ms | 心跳超时，超时则 abort 当前连接并重连 |

### 4.4 重连机制

参考 `packages/app/src/context/server-sdk.tsx:152-220`：

```
start()
  → generation++ (防止旧重连循环)
  → while (!aborted && started && generation === active):
      → 新建 AbortController (attempt)
      → eventSdk.global.event({ signal: attempt.signal })
      → for await (event of stream): 处理事件
      → 异常/断开 → finally 清理
      → wait(250ms) → 重连
```

- 每次重连创建独立的 `AbortController`
- `generation` 计数器防止旧重连循环干扰新连接
- `start()` 被重复调用时会 await 前一个 run，避免并发连接

### 4.5 心跳与可见性

参考 `packages/app/src/context/server-sdk.tsx:127-167`：

- **心跳**：每收到一个事件重置 15 秒定时器，超时则 abort 当前连接触发重连
- **服务端心跳**：server 每 15 秒发送 `": heartbeat\n\n"` SSE 注释保持连接
- **`pagehide`**：调用 `stop()`，完全停止 SSE 流
- **`pageshow`**：仅当 `event.persisted` 为 true（bfcache 恢复）时重启
- **`visibilitychange`**：页面重新可见且距上次事件 > 15 秒时，abort 当前连接触发重连

### 4.6 事件类型

SSE 事件 payload 结构：`{ directory: string, payload: Event }`

主要事件类型：

| 事件类型 | 说明 |
|----------|------|
| `session.created` / `session.updated` / `session.deleted` | Session 生命周期 |
| `session.diff` / `session.status` | Session 状态变更 |
| `message.updated` / `message.removed` | 消息变更 |
| `message.part.updated` / `message.part.removed` | 消息部件变更 |
| `message.part.delta` | 消息部件增量（流式输出） |
| `permission.asked` / `permission.replied` | 权限请求与回复 |
| `question.asked` / `question.replied` / `question.rejected` | 问题请求与回复 |
| `todo.updated` | Todo 列表更新 |
| `server.connected` / `server.heartbeat` | 连接状态 |
| `lsp.updated` | LSP 状态更新 |

---

## 5. HTTP 数据同步

### 5.1 TanStack Query 缓存层

参考 `packages/app/src/context/server-sync.tsx`：

- 使用 `@tanstack/solid-query` 做 HTTP 请求的缓存、去重、后台刷新
- Bootstrap 查询：global config、projects、providers、path
- Directory bootstrap：sessions、agents、config、session status、project、path、VCS、commands、references、permissions、questions、MCP

### 5.2 Session 数据管理

参考 `packages/app/src/context/server-session.tsx`：

- 内存 store 管理 session info、messages、parts、permissions、questions、todos、diffs
- `resolve()` — 通过 HTTP 获取 session info，带请求去重和 generation 竞态处理
- `loadMessages()` — 通过 HTTP 分页拉取消息
- `apply()` — SSE 事件 reducer，处理实时事件更新 store
- `optimistic.add()` / `optimistic.remove()` — 乐观更新，先显示后与 server 事件对账
- LRU 缓存淘汰：`SESSION_CACHE_LIMIT = 40`，保护活跃 session 不被淘汰

### 5.3 关键 HTTP 端点

#### 全局端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/global/health` | GET | 健康检查 |
| `/global/event` | GET (SSE) | 全局事件流 |
| `/global/config` | GET/PUT | 全局配置 |
| `/global/dispose` | POST | 释放所有实例 |
| `/global/upgrade` | POST | 升级 opencode |

#### Session 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/session` | GET/POST | 列出/创建 session |
| `/session/{id}` | GET/PATCH/DELETE | 获取/更新/删除 session |
| `/session/{id}/message` | GET | 分页获取消息（`x-next-cursor` header） |
| `/session/{id}/message/{msgId}` | GET/DELETE | 获取/删除消息 |
| `/session/{id}/prompt_async` | POST | 异步提交 prompt |
| `/session/{id}/command` | POST | 执行 slash command |
| `/session/{id}/shell` | POST | Shell 模式提交 |
| `/session/{id}/abort` | POST | 中止 session |
| `/session/{id}/diff` | GET | 获取文件 diff |
| `/session/{id}/todo` | GET | 获取 todos |
| `/session/{id}/fork` | POST | Fork session |
| `/session/{id}/children` | GET | 获取子 session |
| `/session/{id}/revert` / `unrevert` | POST | 撤销/恢复 |
| `/session/status` | GET | 所有 session 状态 |

#### 权限与问题

| 端点 | 方法 | 说明 |
|------|------|------|
| `/permission` | GET | 列出权限请求 |
| `/permission/{id}/reply` | POST | 回复权限请求 |
| `/question` | GET | 列出问题 |
| `/question/{id}/reply` | POST | 回复问题 |
| `/question/{id}/reject` | POST | 拒绝问题 |

#### 其他

| 端点 | 方法 | 说明 |
|------|------|------|
| `/provider` | GET | 列出 provider |
| `/provider/auth` | GET | Provider 鉴权 |
| `/project` | GET | 列出项目 |
| `/project/current` | GET | 当前项目 |
| `/vcs` / `/vcs/status` / `/vcs/diff` | GET | VCS 信息 |
| `/mcp` | GET | MCP 状态 |
| `/mcp/{name}/connect` / `disconnect` | POST | MCP 连接管理 |
| `/lsp` | GET | LSP 状态 |
| `/command` | GET | 列出可用命令 |
| `/agent` | GET | 列出可用 agent |
| `/config` | GET | 目录配置 |
| `/path` | GET | 文件系统路径 |
| `/file` / `/file/content` | GET | 文件列表/内容 |
| `/find/file` / `/find/symbol` / `/find/text` | GET | 搜索文件/符号/文本 |

---

## 6. Session 连接生命周期

### 6.1 核心原则

**Session 执行在服务端进程内运行，与客户端连接完全解耦。**

- Session 执行由 `SessionExecution`（进程级、Session-ID 维度）驱动
- SSE 断开不影响任何 session 的执行
- 事件持久化到 SQLite，客户端重连后可重新拉取

### 6.2 客户端生命周期

```
页面加载
  → 确定 server URL (entry.tsx)
  → 创建 SDK 客户端 (server-sdk.tsx)
  → 建立 SSE 连接 (server-sdk.tsx:96)
  → ServerSync 启动 bootstrap 查询 (server-sync.tsx)
  → UI 渲染

页面关闭/导航
  → pagehide → stop() → SSE 断开
  → session 继续在 server 运行

重新打开
  → 重新建立 SSE 连接
  → HTTP 拉取最新 session 状态和历史消息
  → 继续接收实时事件
```

### 6.3 Session 执行流程（服务端）

```
用户提交 prompt
  → POST /session/{id}/prompt_async
  → SessionV2.prompt() 持久化 session_input 行
  → SessionExecution.wake(sessionID) [advisory]
  → SessionRunCoordinator.drain()
  → SessionRunner.run() → llm.stream() 调用
  → 工具执行 → 继续推理循环
  → 事件实时持久化 + 通过 SSE 推送
```

### 6.4 中断与恢复

| 操作 | 客户端调用 | 服务端行为 |
|------|-----------|-----------|
| 中止 | `POST /session/{id}/abort` | `SessionExecution.interrupt()` → 中断 fiber，标记工具为失败 |
| 恢复 | `POST /session/{id}/resume` | `SessionExecution.resume()` → 加入或启动新的 drain |
| 唤醒 | 提交新 prompt 时自动触发 | `SessionExecution.wake()` → 如果空闲则启动 drain，如果忙碌则合并（coalesce） |

---

## 7. Background Agent 机制

### 7.1 概述

主 Agent 通过 `task` 工具派发子 Agent，支持前台（阻塞）和后台（异步）两种模式。

### 7.2 前台模式

```
主 Session → task 工具 (foreground)
  → 创建子 Session (parentID = 主session)
  → 阻塞等待子 Session 完成
  → 子 Session 结果返回给主 Session 的 LLM
```

### 7.3 后台模式

```
主 Session → task 工具 (background=true)
  → 创建子 Session (parentID = 主session)
  → BackgroundJob.start() 异步启动
  → task 工具立即返回，主 Session 继续运行
  → ...子 Session 独立运行...
  → 子 Session 完成
  → ops.prompt(父session, 结果文本)  ← 服务端注入
  → SessionExecution.wake(父session)
  → 父 Session drain 读取新 input，LLM 继续推理
```

**关键点：Background agent 的结果通过服务端注入回父 session，不需要客户端参与。Web UI 通过 SSE 收到注入的消息事件并更新界面。**

### 7.4 实验性标志

Background agent 需要 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` 环境变量启用。

### 7.5 前台转后台

前台子 Agent 可通过 `POST /experimental/session/{id}/background` 提升为后台执行。

---

## 8. 自建 Web UI 通信实现指南

### 8.1 最小实现清单

1. **Server URL 配置**
   - 实现 URL 发现逻辑（同源 / 环境变量 / localStorage 持久化）
   - 可选：支持 `?auth_token=` query param 鉴权

2. **HTTP 客户端**
   - 使用原生 `fetch` 包装 REST API 调用
   - 支持 Basic Auth header
   - 支持 `x-opencode-directory` header（或 query param）限定目录作用域
   - 建议使用 TanStack Query（或等效方案）管理请求缓存

3. **SSE 事件流**
   - 连接 `/global/event` 端点
   - 实现 `fetch` + `ReadableStream` 的 SSE 帧解析（`\n\n` 分隔，`data:`/`event:`/`id:` 字段）
   - 实现重连循环：250ms 延迟 + generation 计数器防竞态
   - 实现心跳超时：15 秒无事件则重连
   - 实现页面可见性处理：`visibilitychange` 触发重连
   - 实现事件合并：`message.part.delta` 同 message+part+field 的 delta 拼接

4. **Session 数据层**
   - HTTP 拉取 session 列表、session 详情、消息分页
   - SSE 事件 reducer：将事件应用到内存 store
   - 乐观更新：用户提交 prompt 后先本地显示，收到 server 事件后对账

### 8.2 推荐架构

```
┌─────────────────────────────────────┐
│           Web UI (自建)             │
│                                     │
│  ┌─────────┐    ┌────────────────┐ │
│  │ HTTP    │    │ SSE 事件流      │ │
│  │ Client  │    │ /global/event   │ │
│  │ (fetch) │    │ (fetch+stream)  │ │
│  └────┬────┘    └───────┬─────────┘ │
│       │                 │           │
│  ┌────▼─────────────────▼─────────┐ │
│  │    数据同步层 (Query Cache)     │ │
│  │  ┌────────────┬──────────────┐  │ │
│  │  │ HTTP 请求   │ SSE 事件     │  │ │
│  │  │ 缓存/去重   │ Reducer      │  │ │
│  │  └────────────┴──────────────┘  │ │
│  └────────────────┬────────────────┘ │
│                   │                  │
│            ┌──────▼──────┐            │
│            │  UI 组件    │            │
│            └─────────────┘            │
└─────────────────────────────────────┘
         │              │
    HTTP REST       SSE
         │              │
┌────────▼──────────────▼──────────────┐
│       opencode server (port 4096)     │
│  /global/*  /session/*  /config ...    │
└───────────────────────────────────────┘
```

### 8.3 复用 opencode SDK（推荐）

如果自建 Web UI 是 JavaScript/TypeScript 项目，可直接复用生成的 SDK：

```bash
# SDK 包路径
packages/sdk/js
```

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
  headers: {
    Authorization: `Basic ${btoa("opencode:password")}`,
  },
})

// HTTP 调用
const sessions = await client.session.list()
const session = await client.session.create({ body: { agent: "build" } })
await client.session.promptAsync({ path: { sessionID }, body: { prompt } })

// SSE 事件流
const events = await client.global.event({})
for await (const event of events.stream) {
  console.log(event.payload.type, event.directory)
}
```

SDK 自动生成的端点定义共 188 个，覆盖全部 API 能力。

### 8.4 自行实现 SSE 解析（非 JS 项目）

参考 `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts`，核心逻辑：

```python
# 伪代码
response = fetch("GET", f"{server_url}/global/event", headers={...})
buffer = ""
for chunk in response.body:  # ReadableStream
    buffer += chunk.decode("utf-8")
    while "\n\n" in buffer:
        frame, buffer = buffer.split("\n\n", 1)
        event = parse_sse_frame(frame)
        if event:
            yield event

def parse_sse_frame(frame):
    event_type = None
    data = ""
    event_id = None
    for line in frame.split("\n"):
        if line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("data:"):
            data += line[5:].strip()
        elif line.startswith("id:"):
            event_id = line[3:].strip()
        # 忽略 retry: 和注释行 (: heartbeat)
    if data:
        return { "type": event_type, "data": json.loads(data), "id": event_id }
    return None
```

重连时携带 `Last-Event-ID` header 以支持断点续传（服务端尚未实现，但 header 已预留）。

---

## 10. 云端部署通信方案

> 当 opencode server 部署在云端（而非用户本地）时，前端直接与云端 server 通信。本节描述此场景下的通信方案设计。

### 10.1 与本地部署的核心差异

| 维度 | 本地部署 | 云端部署 |
|------|---------|---------|
| Server URL | `http://localhost:4096` | `https://your-domain.com` |
| 传输层 | HTTP，无 TLS | 必须 HTTPS/TLS |
| 鉴权 | 可选 Basic Auth | 必须鉴权（防公网未授权访问） |
| 网络中间层 | 无 | 通常有反向代理 / 负载均衡 / CDN |
| SSE 长连接 | 直连，无超时风险 | 代理层可能缓冲或超时断连 |
| 文件系统 | server 直接访问用户本地代码 | server 访问云端文件系统（代码需在云端或需上传） |
| CORS | 同源或 localhost，无跨域 | 前端域名与 server 域名不同，需配置 CORS |

### 10.2 部署拓扑

#### 方案 A：单实例直连

```
┌──────────┐     HTTPS + SSE      ┌──────────────────────┐
│  Web UI  │ ───────────────────→ │  opencode server     │
│ (浏览器)  │                      │  (云端单实例)         │
│          │ ←─────────────────── │  port 4096 (内网)    │
└──────────┘                      └──────────────────────┘
        │
        └─ 通过 Nginx 反向代理接入
```

- 适用于单用户 / 小团队场景
- 前端静态资源可由 Nginx 直接托管，或独立部署在 CDN
- server 监听 `127.0.0.1:4096`，Nginx 转发外部流量

#### 方案 B：多实例 + 网关（预留扩展）

```
┌──────────┐     HTTPS      ┌──────────┐    ┌──────────────────────┐
│  Web UI  │ ──────────────→│  网关 /   │───→│  opencode instance 1 │
│ (浏览器)  │                │  负载均衡  │───→│  opencode instance 2 │
│          │ ←──────────────│          │───→│  opencode instance N │
└──────────┘   SSE 长连接    └──────────┘    └──────────────────────┘
```

- 适用于多用户 / 多项目场景
- 网关按用户/项目路由到对应 server 实例
- **SSE 长连接需要 sticky session**（同一 session 的事件流必须连到同一实例）
- 网关必须支持 SSE 透传（不缓冲、不超时）

### 10.3 反向代理配置（Nginx 示例）

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # 前端静态资源（可选：如果前端和 server 同域部署）
    location / {
        root /var/www/webui;
        try_files $uri $uri/ /index.html;
    }

    # opencode server API
    location /global/ {
        proxy_pass http://127.0.0.1:4096;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 关键配置
        proxy_buffering off;           # 禁用缓冲，事件必须实时透传
        proxy_cache off;               # 禁用缓存
        proxy_read_timeout 86400s;     # 长连接超时设为 24h，避免代理提前断开
        chunked_transfer_encoding on;
    }

    location /session/ {
        proxy_pass http://127.0.0.1:4096;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;       # 普通 API 请求超时 5 分钟（LLM 响应可能较慢）
    }

    # 其他 API 端点
    location ~ ^/(provider|project|config|agent|command|vcs|mcp|lsp|path|file|find|permission|question)/ {
        proxy_pass http://127.0.0.1:4096;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**关键 SSE 配置项说明**：

| 配置 | 值 | 原因 |
|------|----|------|
| `proxy_buffering off` | 必须 | Nginx 默认缓冲响应体，会导致 SSE 事件积压不推送 |
| `proxy_cache off` | 必须 | 禁止缓存 SSE 响应 |
| `proxy_read_timeout 86400s` | 必须 | Nginx 默认 60 秒超时会断开空闲 SSE 连接 |
| `chunked_transfer_encoding on` | 推荐 | 确保 chunked 传输正常工作 |

### 10.4 鉴权方案

#### 方案 A：Basic Auth（复用现有机制）

最简单，直接复用 opencode server 内置的 Basic Auth：

```bash
# server 启动时设置密码
OPENCODE_SERVER_PASSWORD=your-password opencode serve --hostname 0.0.0.0 --port 4096 --cors https://your-domain.com
```

前端创建客户端时携带 Basic Auth header（同本地部署方案）：

```ts
const client = createOpencodeClient({
  baseUrl: "https://your-domain.com",
  headers: {
    Authorization: `Basic ${btoa("opencode:your-password")}`,
  },
})
```

**适用场景**：内部工具、单团队使用。缺点是密码固定，无用户级区分。

#### 方案 B：JWT / OAuth（网关层鉴权）

在反向代理或 API 网关层实现用户鉴权，验证通过后将用户身份注入请求：

```
浏览器 → 网关（验证 JWT）
  → 通过：注入 x-opencode-user-id header，转发到 server
  → 拒绝：返回 401
```

```nginx
# Nginx + JWT 验证示例
location /global/ {
    access_by_lua_block {
        local auth_header = ngx.var.http_Authorization
        if not auth_header or not string.match(auth_header, "^Bearer ") then
            ngx.exit(ngx.HTTP_UNAUTHORIZED)
        end
        -- 验证 JWT，提取用户 ID 注入 header
        ngx.req.set_header("x-opencode-user-id", user_id)
    }
    proxy_pass http://127.0.0.1:4096;
    # ... SSE 配置同上
}
```

**适用场景**：多用户 SaaS、需要用户级权限控制。

#### 方案 C：API Key

在网关层验证 API Key，适合内部工具或 CI/CD 场景：

```
浏览器 → 网关（验证 X-API-Key header）
  → 通过：转发到 server
  → 拒绝：返回 401
```

**适用场景**：内部工具、自动化集成。

### 10.5 文件系统处理

opencode 的文件操作（读/写/搜索/LSP）在 server 端执行。云端部署时，用户代码的位置决定了文件操作方案：

#### 场景 A：代码在云端（推荐）

代码存储在云端服务器的文件系统上（如云盘、EBS、NAS）。

- server 通过 `x-opencode-directory` header 定位项目目录
- 所有文件操作直接在云端文件系统上执行
- 无需额外改造，与本地部署行为一致

```
Web UI → HTTPS → 云端 server → 直接读写云端文件系统
                              → /home/user/projects/my-app
```

#### 场景 B：代码在 Git 仓库

server 在创建 session 前，先 clone 代码到云端临时目录：

```
Web UI → POST /session (directory: /tmp/clone/{repo})
  → server 先执行 git clone 到 /tmp/clone/{repo}
  → 后续文件操作在 clone 目录上执行
  → session 结束后清理临时目录
```

**注意**：需要在 server 侧增加 git clone 前置步骤，或通过自定义 slash command 实现。

#### 场景 C：代码在用户本地

最复杂的场景。前端需要将文件上传到云端 server，或通过某种同步通道保持一致性。

```
方案 C1：前端打包上传
  Web UI → 用户选择本地项目目录
  → 前端将项目文件打包上传到 server
  → server 解压到临时目录
  → session 在临时目录上运行
  → 结果变更可下载回本地

方案 C2：前端代理文件操作（不推荐）
  Web UI → 文件操作请求拦截
  → 读操作：从用户本地 File System Access API 读取，上传到 server
  → 写操作：server 返回变更，前端写回本地
  → 此方案需要大量改造，不推荐
```

**推荐**：优先采用场景 A（代码在云端），其次场景 B（Git 仓库）。

### 10.6 SSE 长连接公网注意事项

公网环境下 SSE 长连接面临的问题与对策：

| 问题 | 原因 | 对策 |
|------|------|------|
| 代理缓冲 | Nginx 默认 `proxy_buffering on` | `proxy_buffering off` |
| 连接超时 | Nginx `proxy_read_timeout` 默认 60s | 设为 `86400s`（24h） |
| CDN 缓存 | CDN 可能缓存 SSE 响应 | CDN 层禁用 `/global/event` 缓存，或 CDN 不代理此路径 |
| 负载均衡断连 | LB 健康检查可能关闭空闲连接 | 确保服务端 15s 心跳不被 LB 误判 |
| 移动网络切换 | 手机网络切换基站时连接断开 | 客户端已有重连机制（250ms 延迟） |
| HTTP/2 流复用 | HTTP/2 下 SSE 与普通请求复用同一 TCP 连接 | 部分代理对 HTTP/2 SSE 支持不佳，必要时降级为 HTTP/1.1 |
| 浏览器连接数限制 | 浏览器对同一域名最多 6 个连接（HTTP/1.1） | 使用 HTTP/2（多路复用无此限制），或 SSE 走独立子域名 |

**服务端心跳**：server 每 15 秒发送 `": heartbeat\n\n"` SSE 注释，保持连接活跃。云端部署时确保代理层不过滤 SSE 注释行。

### 10.7 CORS 配置

当前端域名与 server 域名不同时，需要配置 CORS。

**server 侧启动参数**：

```bash
opencode serve \
  --hostname 0.0.0.0 \
  --port 4096 \
  --cors https://app.your-domain.com
```

**server 侧配置文件**（`opencode.json`）：

```json
{
  "server": {
    "cors": ["https://app.your-domain.com"]
  }
}
```

**现有 CORS 规则**（参考 `packages/server/src/cors.ts`）：

- `undefined` origin（非浏览器请求）：允许
- `http://localhost:*` / `http://127.0.0.1:*`：允许
- `https://*.opencode.ai`：允许
- `--cors` 参数指定的额外 origin：允许
- 同源请求（origin host = request host）：允许

**自建 Web UI 需要确保**：前端域名被加入 server 的 CORS 允许列表。

### 10.8 云端部署完整架构示例

```
┌───────────────────────────────────────────────────┐
│  用户浏览器                                        │
│  https://app.your-domain.com                       │
│                                                   │
│  ┌─────────┐    ┌──────────────┐                  │
│  │ HTTP    │    │ SSE 事件流    │                  │
│  │ Client  │    │ /global/event │                  │
│  │ (fetch) │    │ (fetch+stream)│                  │
│  └────┬────┘    └──────┬───────┘                  │
└───────┼────────────────┼──────────────────────────┘
        │ HTTPS          │ HTTPS (SSE, proxy_buffering off)
        │                │
┌───────▼────────────────▼──────────────────────────┐
│  Nginx 反向代理                                    │
│  ─ proxy_buffering off (SSE)                      │
│  ─ proxy_read_timeout 86400s (SSE)               │
│  ─ CORS: Allow-Origin: https://app.your-domain.com│
│  ─ Auth: JWT 验证 → 注入 x-opencode-user-id       │
└───────┬────────────────┬──────────────────────────┘
        │                │
┌───────▼────────────────▼──────────────────────────┐
│  opencode server (127.0.0.1:4096)                  │
│  ─ OPENCODE_SERVER_PASSWORD=set                    │
│  ─ 代码在云端: /home/user/projects/                │
│  ─ Session 执行 + 事件持久化 (SQLite)              │
│  ─ SSE 心跳: 15s                                   │
└───────────────────────────────────────────────────┘
```

### 10.9 前端改造要点

从本地部署迁移到云端部署，前端需要调整的关键点：

| 改动点 | 本地部署 | 云端部署 | 代码位置 |
|--------|---------|---------|---------|
| Server URL | `http://localhost:4096` | `https://api.your-domain.com` | `entry.tsx` URL 发现逻辑 |
| 鉴权 | 可选 | 必选（Basic Auth / JWT / API Key） | `utils/server.ts` + 请求拦截器 |
| CORS | 同源，无需配置 | 跨域，server 侧需配置 `--cors` | server 启动参数 |
| SSE 超时容忍 | 直连，无中间层 | 代理可能延迟，重连参数可调大 | `server-sdk.tsx` RECONNECT_DELAY_MS |
| 文件操作 | server 直接访问本地文件 | server 访问云端文件系统 | 无需前端改动 |
| Directory 选择 | 本地 OS 文件选择器 | server 端目录浏览 API | `directory-picker.tsx` |

---

## 9. 关键文件索引

| 文件 | 说明 |
|------|------|
| `packages/app/src/entry.tsx` | Web 入口，server URL 发现与鉴权 |
| `packages/app/src/utils/server.ts` | SDK 客户端工厂函数 |
| `packages/app/src/context/server-sdk.tsx` | SSE 连接管理、事件合并、重连 |
| `packages/app/src/context/server-sync.tsx` | HTTP 数据同步层（TanStack Query） |
| `packages/app/src/context/server-session.tsx` | Session 数据管理与事件 reducer |
| `packages/app/src/context/platform.tsx` | 平台抽象（web/desktop） |
| `packages/app/src/context/global.tsx` | Per-server 上下文管理 |
| `packages/app/src/context/sdk.tsx` | Directory 作用域 SDK 客户端 |
| `packages/sdk/js/src/v2/client.ts` | SDK 客户端创建与拦截器 |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | 自动生成的 API 端点定义（188 个） |
| `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts` | SSE 客户端解析实现 |
| `packages/core/src/session.ts` | Session V2 核心（prompt/interrupt/resume） |
| `packages/core/src/session/execution/local.ts` | Session 执行本地实现 |
| `packages/core/src/session/run-coordinator.ts` | Session 运行协调器 |
| `packages/core/src/session/runner/llm.ts` | LLM 调用循环 |
| `packages/core/src/event.ts` | 事件系统（持久化 + PubSub） |
| `packages/core/src/background-job.ts` | Background Job 注册表 |
| `packages/opencode/src/tool/task.ts` | Task 工具（子 Agent 派发） |
| `packages/server/src/handlers/event.ts` | SSE 服务端 handler |
| `packages/server/src/handlers/session.ts` | Session HTTP handler |
| `packages/server/src/cors.ts` | CORS 允许规则 |
| `packages/server/src/auth.ts` | 服务端 Basic Auth 配置 |
| `packages/server/src/location.ts` | Directory 作用域中间件 |
| `packages/app/src/context/server.tsx` | ServerConnection 类型定义（Http/Sidecar/Ssh） |
| `packages/app/src/components/directory-picker-policy.ts` | 目录选择策略（本地 vs 服务端） |
