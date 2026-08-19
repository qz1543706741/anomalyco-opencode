# M0 Wanqing 与 Langfuse 插件独立化技术方案

## 1. 背景

当前 M0 fork 在 `packages/opencode/src/plugin/@m0` 内维护 Wanqing Provider 与 Langfuse 插件。两者可以使用 OpenCode 插件 Hook，但仍直接依赖 OpenCode 私有实现：

- `@/util/log`
- `@/util/kconf`
- `@/bus/global`
- Wanqing `fetch` 请求/响应适配、curl transport 和 `wanqing.http` 私有事件

直接把实现移动到 `packages/plugin/src` 会把 M0 业务逻辑、Langfuse 依赖和 KConf 约定放进公共 `@opencode-ai/plugin` SDK，并产生错误依赖方向。`packages/plugin` 应继续只提供插件协议、Hook 类型和公共工具。

本方案把 Wanqing 与 Langfuse 合并进一个可独立构建、测试和发布的 `@m0/opencode-plugin` npm 包。包内保持模块隔离，由单一 `server()` 组合 Hooks、共享模型配置快照并统一管理生命周期。OpenCode 核心只增加 Langfuse 所需的最小公共 Hook 数据，不依赖 M0 包。

## 2. 目标与非目标

### 2.1 目标

1. 新建 `@m0/opencode-plugin`。
2. 包内包含 Wanqing、Langfuse 两个可独立启停模块。
3. 包只能依赖公开包和标准运行时 API，禁止导入 `packages/opencode/src`。
4. 支持通过 OpenCode `plugin` 配置按 npm 包或本地文件加载。
5. Wanqing 保留 Provider `fetch` 包装层和 Gemini/GPT/DeepSeek 适配，但底层不使用 `curl-fetch`。
6. Langfuse 不订阅私有 `GlobalBus`。
7. 保留当前 Langfuse LLM、工具、Session 追踪和敏感媒体脱敏能力。
8. 任一模块失败不得阻断另一模块、OpenCode 启动或模型调用。
9. npm 依赖解析、插件安装和发布全部使用 `https://npm.corp.kuaishou.com/`，禁止公网 registry fallback。

### 2.2 非目标

本次只删除 curl transport 及其专属行为：

- `curl-fetch.ts`
- curl 子进程、Header parser、redirect/abort 兼容层
- `--max-time`、`--keepalive-time`、response-header timeout 等 curl 参数
- `CHARLES_PROXY`、自定义 TLS 绕过和 `M0_WANQING_VERBOSE` curl verbose

继续保留：

- Gemini tool schema 请求体清洗
- 连续 assistant message 请求体合并
- Gemini/DeepSeek thinking 参数注入
- DeepSeek 不支持参数删除
- GPT completion token 适配
- Gemini thought signature 流解析
- Wanqing HTTP 状态和脱敏 Header metadata

Provider `fetch` 包装层仍是最终请求体和流响应适配点。底层 transport 调用配置中原有 `provider.options.fetch`；不存在时调用原生 `globalThis.fetch`。

## 3. 设计结论

### 3.1 包边界

```text
packages/
  plugin/                         # @opencode-ai/plugin：公共协议，不放 M0 实现
  m0-plugin/                      # @m0/opencode-plugin
    src/
      server.ts
      logger.ts
      model-catalog.ts
      provider-observability.ts
      wanqing/
        index.ts
        adapter.ts
        model-matcher.ts
        merge-assistant.ts
        deepseek/
        gemini/
        gpt/
      langfuse/
        index.ts
        bridge.ts
        sdk/
    test/
  opencode/
```

根目录已有 `packages/*` workspace 配置，新包无需修改 workspace glob。

### 3.2 依赖方向

```text
@m0/opencode-plugin ──▶ @opencode-ai/plugin
                     ├─▶ @opencode-ai/sdk
                     └─▶ langfuse

opencode core ──▶ @opencode-ai/plugin
```

禁止以下依赖：

```text
@opencode-ai/plugin ──X──▶ @m0/*
@m0/* ──X──▶ opencode/src/*
```

### 3.3 单包组合方式

根 `server()` 创建共享 `ModelCatalog` 和 `ProviderObservability`，再创建 Wanqing 和 Langfuse Hooks。禁止模块互相导入：

```text
server.ts ──▶ model-catalog.ts
         ├─▶ provider-observability.ts
         ├─▶ wanqing/index.ts
         └─▶ langfuse/index.ts
```

插件 options 支持模块级启停：

```ts
type M0PluginOptions = {
  wanqing?: false | WanqingPluginOptions
  langfuse?: false | LangfusePluginOptions
}
```

根 `server()` 显式组合重叠 Hook，不建设通用 Hook 框架。执行顺序固定：

1. `config`：先更新共享 ModelCatalog，再通知模块。
2. `chat.params`：先执行 Wanqing token limit，再执行 Langfuse，使 trace 记录最终参数。
3. `dispose`：分别关闭已启用模块；单个模块失败不跳过其他模块清理。

其余 Hook 直接转发给唯一拥有者。Wanqing 与 Langfuse 不互相导入；Provider HTTP metadata 只经过根 server 创建的 `ProviderObservability`。不使用 OpenCode `GlobalBus`。

组合代码保持显式，模块自己吸收非关键观测错误：

```ts
export const M0Plugin: Plugin = async (input, options) => {
  const catalog = createModelCatalog()
  const providerObservability = createProviderObservability()
  const wanqing =
    options?.wanqing === false ? undefined : createWanqingHooks(catalog, providerObservability, options?.wanqing)
  const langfuse =
    options?.langfuse === false
      ? undefined
      : await createLangfuseHooks(catalog, providerObservability, options?.langfuse)

  return {
    async config(config) {
      catalog.update(config)
      await wanqing?.config?.(config)
      await langfuse?.config?.(config)
    },
    async "chat.params"(hookInput, output) {
      await wanqing?.["chat.params"]?.(hookInput, output)
      await langfuse?.["chat.params"]?.(hookInput, output)
    },
    async dispose() {
      await Promise.allSettled([wanqing?.dispose?.(), langfuse?.dispose?.()])
    },
  }
}
```

实际返回值补齐各模块拥有的其他 Hook。Langfuse 初始化、事件上报和 flush 失败只记录脱敏错误，不向模型执行链抛出。Wanqing `config` Hook 安装 fetch wrapper，模型请求仍通过原有 fetch 或原生 fetch 发出。

## 4. 公共插件 API 最小改动

### 4.1 `chat.params` 增加最终消息输入

目标仓库当前 `chat.params` 输入不包含最终发送给模型的 `messages`。Langfuse 若通过 SDK client 重新读取 Session，只能得到持久化消息，不能保证与 system 注入、workflow 分支和 Provider 转换后的模型输入一致。

在 `packages/plugin/src/index.ts` 增加可选字段：

```ts
"chat.params"?: (
  input: {
    sessionID: string
    agent: string
    model: Model
    provider: ProviderContext
    message: UserMessage
    messages?: unknown[]
  },
  output: {
    temperature: number
    topP: number
    topK: number
    maxOutputTokens: number | undefined
    options: Record<string, any>
  },
) => Promise<void>
```

在 `packages/opencode/src/session/llm/request.ts` 触发 Hook 时传入已经组装完成的 `messages`：

```ts
yield* input.plugin.trigger(
  "chat.params",
  {
    sessionID: input.sessionID,
    agent: input.agent.name,
    model: input.model,
    provider: input.provider,
    message: input.user,
    messages,
  },
  params,
)
```

字段保持可选，现有插件无需修改，属于向后兼容扩展。

### 4.2 不新增 OpenCode 插件事件总线

Langfuse 使用已有公开 Hook：

- `event`
- `chat.message`
- `chat.params`
- `tool.execute.before`
- `tool.execute.after`
- `dispose`

不把 `GlobalBus` 暴露给插件，不新增 OpenCode 公共事件类型。Wanqing HTTP metadata 使用 `@m0/opencode-plugin` 内部 `ProviderObservability`，只连接同一插件实例内模块。

## 5. Wanqing 插件设计

### 5.1 保留职责

迁移后的 Wanqing 模块负责：

1. 识别 `wanqing`、`wanqing-online-reasoning` Provider。
2. 从 OpenCode 已解析配置中读取模型名称和 `limit.output`。
3. 在 `chat.params` 中限制 `maxOutputTokens`。
4. 对 Claude 模型在 `chat.headers` 中补充 `anthropic-beta`。
5. 在 Provider `fetch` 包装层适配 Gemini、GPT、DeepSeek 请求体。
6. 解析需要消费的流响应数据，例如 Gemini thought signature。
7. 通过共享 ProviderObservability 上报 HTTP metadata。

模块不直接访问 KConf。M0 启动层仍负责把 KConf 转成 OpenCode Provider 配置；根插件从最终配置更新共享 ModelCatalog，避免重复获取、环境判断和配置源分叉。

### 5.2 配置模型

```ts
type WanqingPluginOptions = {
  providerIDs?: string[]
  anthropicBeta?: string
  fetch?: typeof globalThis.fetch
}
```

默认值：

```ts
const DEFAULT_PROVIDER_IDS = ["wanqing", "wanqing-online-reasoning"]
const DEFAULT_ANTHROPIC_BETA =
  "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
```

根插件 `config` Hook 更新共享模型索引：

```ts
Map<modelID, {
  displayName: string
  maxOutputTokens?: number
}>
```

数据来源：

```text
config.provider[providerID].models[modelID].name
config.provider[providerID].models[modelID].limit.output
```

### 5.3 Hook 行为

`chat.params`：

- Provider 不匹配：不处理。
- 模型无有效 output limit：不处理。
- 当前 `maxOutputTokens` 与限制一致：不处理。
- 否则设置为配置限制。

`chat.headers`：

- Provider 不匹配：不处理。
- 模型不是 Claude：不处理。
- 已包含 `interleaved-thinking`：不重复添加。
- 否则追加默认 `anthropic-beta`。

`config`：

- 保存每个 Wanqing Provider 当前已有的 `provider.options.fetch`。
- 用适配 wrapper 替换 Provider fetch。
- wrapper 底层优先调用插件 options `fetch`，其次调用原有 Provider fetch，最后调用 `globalThis.fetch`。
- 禁止 wrapper 递归调用自身。

底层选择顺序：

```ts
const baseFetch = options.fetch ?? provider.options.fetch ?? globalThis.fetch
provider.options.fetch = (input, init) => wanqingFetch(baseFetch, providerID, input, init)
```

### 5.4 请求与响应适配

`wanqingFetch` 保留现有 adapter pipeline：

1. 复制 `RequestInit`，解析 JSON body。
2. 按 model matcher 选择 Gemini、GPT、DeepSeek adapter。
3. 依次执行 `prepareRequest` 和 `prepareHeaders`。
4. 删除仅用于进程内关联的 `x-m0-*` Header。
5. 调用 `baseFetch`。
6. 对成功且有 body 的响应使用 `ReadableStream.tee()`，让 stream consumer 提取 metadata。
7. 返回语义等价 Response 给 AI SDK。

不再保留 `WanqingFetchInit` 的 `proxy`、`tls`、`verbose` 扩展。传给底层的是标准 `RequestInit`。

### 5.5 内部关联 Header

允许写入以下进程内关联 Header：

```text
x-m0-session-id
x-m0-message-id
x-m0-call-key
```

约束：

- 仅 Wanqing Provider 写入。
- fetch wrapper 必须在调用 `baseFetch` 前删除。
- HTTP 日志和 ProviderObservability payload 不得包含原始内部 Header。
- Langfuse 禁用时不需要写入 `x-m0-call-key`。
- 测试必须断言三个 Header 不会到达模拟远端。

单包内不再发送 `wanqing.http` GlobalBus 事件。fetch wrapper 直接调用共享 ProviderObservability：

```ts
providerObservability.emit({
  providerID,
  sessionID,
  userMsgID,
  callKey,
  status,
  requestHeaders,
  responseHeaders,
  error,
})
```

Langfuse 模块通过共享对象订阅；模块间无直接 import。

### 5.6 文件迁移

以下文件继续迁移：

```text
adapter.ts
merge-assistant.ts
deepseek/*
gemini/request-adapters.ts
gemini/thought-signature.ts
gpt/*
model-matcher.ts
```

只删除：

```text
curl-fetch.ts
```

所有迁移文件删除 `@/util/log` 依赖，改用包内脱敏 logger。现有 adapter 单元测试继续迁移。

`wanqing-curl-fetch.test.ts` 不迁移；替换为 baseFetch 委托、Header 删除、adapter pipeline 和 stream tee 测试。

## 6. Langfuse 插件设计

### 6.1 状态归属

所有状态放进 Langfuse 模块实例，由根 `server()` 创建，不使用模块级可变单例：

```ts
type State = {
  sessions: Map<string, SessionMeta>
  rounds: Map<string, RoundState>
  roundBySession: Map<string, string>
  queryByMessage: Map<string, string>
  toolBridge: PromiseBridge<string>
  llmBridge: PromiseBridge<UsageMetadataResult>
}
```

这样可避免测试、热重载和多 OpenCode Instance 之间共享追踪状态。

### 6.2 配置

```ts
type LangfusePluginOptions = {
  publicKey?: string
  secretKey?: string
  baseUrl?: string
  defaultTags?: string[]
  agentName?: string
  toolMaxRetries?: number
}
```

解析顺序：

1. 插件 options
2. 当前兼容环境变量
3. 缺少 public/secret key 时返回空 Hooks

兼容环境变量：

```text
M0_KLangfuse_PUBLIC_KEY
M0_KLangfuse_SECRET_KEY
M0_USER_ID
USER
```

日志必须继续掩码 public key 和 secret key，禁止记录原始密钥。

### 6.3 模型显示名

使用共享 ModelCatalog 从最终 Provider 配置读取：

```text
config.provider[*].models[modelID].name
```

不直接调用 KConf。配置缺失时回退到 `model.id`。

### 6.4 Event 迁移

把原 `GlobalBus.on("event")` 处理改成公开 `event` Hook：

```ts
return {
  async event(input) {
    await handleSessionEvent(input.event)
  },
}
```

继续处理插件已有的标准事件：

- Session 创建/更新
- Message 更新
- Message Part 更新
- Assistant 完成和错误

删除：

- `ensureGlobalEventSubscription`
- `globalEventSubscribed`
- `wanqing.http` 分支

### 6.5 Provider HTTP metadata

保留 `handleWanqingHttp` 和 `httpTraceByCallKey` 语义，但输入来源改为共享 ProviderObservability：

```ts
const unsubscribe = providerObservability.subscribe((event) => handleWanqingHttp(event))
```

有 `callKey` 时把 HTTP metadata 合并进对应 generation；没有 `callKey` 时记录独立 `provider_http` event。`dispose` 调用 `unsubscribe()`。

该通道是 `@m0/opencode-plugin` 包内对象，不属于 OpenCode 公共 API，也不经过 `GlobalBus`。

### 6.6 LLM 追踪

`chat.params` 使用新增的 `input.messages`：

1. 转换为 Langfuse 可展示的 OpenAI message 形态。
2. 对媒体 URL 和内联数据脱敏。
3. 创建当前 Provider turn 的 PromiseBridge。
4. 在 Assistant 完成事件中 resolve usage/output。
5. 在 Assistant 错误事件中 reject。

Langfuse 启用时，`chat.headers` 给 Wanqing Provider 注入 `x-m0-call-key`。Wanqing fetch wrapper 读取后立即删除，再调用底层 fetch。该 Header 不得发送到远端。

### 6.7 工具追踪

继续通过：

- `tool.execute.before`
- `tool.execute.after`

关联 `sessionID` 和 `callID`。目标仓库当前 Hook 没有 tool override 信息，本次记录实际收到的 `input.tool` 和 `output.args`，不扩展公共协议。

### 6.8 dispose

`dispose` 必须：

1. 结束或标记未完成 round。
2. reject 未完成 PromiseBridge，防止悬空 Promise。
3. flush/shutdown Langfuse client。
4. 取消 ProviderObservability 订阅。
5. 清空所有 Map。

插件不得注册 OpenCode 私有 EventEmitter listener，因此无需手动解绑 GlobalBus。

## 7. npm 包结构

### 7.1 内网 Registry

目标仓库根目录新增 `.npmrc`：

```ini
registry=https://npm.corp.kuaishou.com/
```

该配置覆盖 workspace 安装、插件包构建依赖和 OpenCode 运行时 npm 插件安装。不要在子包重复配置 registry。

约束：

- 禁止配置 `registry.npmjs.org`、`registry.yarnpkg.com` 或公网 fallback。
- 仓库只提交 registry 地址，不提交用户名、密码、cookie 或 token。
- 开发机认证使用用户级 npm 配置；CI 认证通过 secret 注入。
- 发布命令显式携带内网 registry，避免调用者本地配置覆盖发布目标。
- 发布前确认 `langfuse`、`@opencode-ai/plugin`、`@opencode-ai/sdk` 所需版本已存在于内网 registry；缺失时先完成内部镜像或发布。

发布命令：

```bash
npm publish --registry=https://npm.corp.kuaishou.com/
```

验证命令：

```bash
npm view langfuse version --registry=https://npm.corp.kuaishou.com/
npm view @opencode-ai/plugin version --registry=https://npm.corp.kuaishou.com/
npm view @opencode-ai/sdk version --registry=https://npm.corp.kuaishou.com/
npm view @m0/opencode-plugin@0.1.0 version --registry=https://npm.corp.kuaishou.com/
```

### 7.2 Package manifest

单包使用显式 server entry：

```json
{
  "name": "@m0/opencode-plugin",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist"],
  "exports": {
    "./server": "./dist/server.js"
  },
  "publishConfig": {
    "registry": "https://npm.corp.kuaishou.com/"
  },
  "engines": {
    "opencode": ">=1.18.1 <2"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.18.1 <2",
    "@opencode-ai/sdk": ">=1.18.1 <2"
  }
}
```

包声明直接运行时依赖 `langfuse`。Langfuse 模块禁用或缺少密钥时延迟加载该依赖，减少无观测场景启动成本。禁止依赖 `opencode` 包。

默认导出符合 V1 插件描述符：

```ts
export default {
  id: "@m0/opencode-plugin",
  server: M0Plugin,
}
```

## 8. 加载配置

本地开发先用 file plugin：

```json
{
  "plugin": ["file:///absolute/path/to/packages/m0-plugin"]
}
```

发布后改为固定 npm 版本：

```json
{
  "plugin": ["@m0/opencode-plugin@0.1.0"]
}
```

需要独立关闭模块时使用带 options 的 spec：

```json
{
  "plugin": [
    [
      "@m0/opencode-plugin@0.1.0",
      {
        "wanqing": {},
        "langfuse": false
      }
    ]
  ]
}
```

生产环境禁止使用 `latest`，避免 OpenCode 与插件 API 漂移。运行时安装继承仓库或部署环境 `.npmrc`，必须解析到内网 registry。

## 9. 实施阶段

### 阶段 A：公共 API

1. 给 `chat.params` 输入增加 `messages?: unknown[]`。
2. 在 LLM request 调用点传入最终 messages。
3. 补类型和 Hook 触发测试。

交付条件：现有插件无需修改，OpenCode typecheck 和相关 Session 测试通过。

### 阶段 B：M0 包骨架与 Wanqing 模块

1. 新建单包、server descriptor、共享 ModelCatalog 和 ProviderObservability。
2. 实现模块级 options 与显式 Hook 组合。
3. 迁移模型匹配、token limit、Anthropic beta 和全部请求/响应 adapter。
4. 改为从共享 ModelCatalog 读取模型配置。
5. fetch wrapper 改为调用已有 Provider fetch 或 `globalThis.fetch`。
6. 删除 `curl-fetch.ts`、curl 参数和 GlobalBus emit。
7. 迁移 adapter、stream consumer 和 fetch wrapper 测试。

交付条件：配置加载成功，Provider fetch 被可组合 wrapper 包装；Gemini/GPT/DeepSeek adapter 生效；底层无 curl 子进程。

### 阶段 C：Langfuse 模块

1. 迁移 SDK、Bridge、脱敏和 tracker 逻辑。
2. 私有 GlobalBus 改成公开 `event` Hook。
3. KConf 模型名改成共享 ModelCatalog。
4. Wanqing HTTP trace 改接共享 ProviderObservability，保留 call-key 关联。
5. 模块全局状态改成实例状态。
6. 实现 dispose flush。

交付条件：LLM、tool、Session trace 正常；插件禁用或缺密钥时 OpenCode 正常运行。

### 阶段 D：发布与切换

1. 在目标仓库根目录增加内网 `.npmrc`。
2. 确认直接依赖和 peer dependency 所需版本在内网 registry 可解析。
3. 生成单一 tarball，使用真实打包产物测试。
4. 发布 `0.1.0` 到 `https://npm.corp.kuaishou.com/`。
5. 从内网 registry 安装已发布版本并完成冒烟测试。
6. 产品配置锁定精确版本。
7. 观察一轮发布后再删除旧 builtin 实现。

## 10. 测试方案

### 10.1 Wanqing

- Provider 不匹配时无修改。
- `limit.output` 正确写入 `maxOutputTokens`。
- 缺失或非法 limit 时保持原值。
- Claude 模型追加 Anthropic beta。
- 已有 beta 不重复追加。
- Provider 已有 fetch 被保留为 wrapper 底层 transport。
- Provider 无 fetch 时调用 `globalThis.fetch`。
- Gemini schema、thinking config 和 thought signature 适配保持有效。
- GPT、DeepSeek adapter 保持有效。
- 不启动 curl 子进程，不使用 curl 专属参数。
- `x-m0-*` Header 在调用底层 fetch 前全部删除。
- HTTP metadata 经 ProviderObservability 发送，不经 GlobalBus。

### 10.2 Langfuse

- 缺少密钥时返回空 Hooks。
- 用户身份顺序：`M0_USER_ID`、`USER`、M0 配置回退。
- 模型名来自最终 Provider config。
- LLM input 媒体数据脱敏。
- Assistant 成功、失败都能结束 generation。
- tool before/after 正确配对。
- 多 Session 并发不串 trace。
- dispose 后无 pending bridge 和实例状态。
- 不注册 GlobalBus listener。
- `x-m0-call-key` 只进入 Wanqing wrapper，不到达远端。
- Provider HTTP metadata 正确合并进对应 generation。

### 10.3 打包与加载

- 从 `packages/m0-plugin` 运行 `bun typecheck`。
- 从 `packages/m0-plugin` 运行 `bun test`。
- 对 tarball 做内容检查，确保 `dist/server.js` 和依赖完整。
- 用 file spec 加载真实构建产物。
- 用 tarball spec 验证打包内容和入口。
- 用内网 registry 的已发布精确版本验证安装加载。
- 在空临时目录安装，确认所有 transitive dependencies 都从内网 registry 获取。
- 检查 `.npmrc`、lockfile 和发布配置不存在公网 registry host。
- 验证不兼容 `engines.opencode` 时给出明确错误。
- 分别验证 Wanqing、Langfuse 单模块关闭。
- 验证 Wanqing `chat.params` 先于 Langfuse 执行。

测试不得从仓库根目录运行。

## 11. 风险与控制

| 风险 | 影响 | 控制 |
|---|---|---|
| curl 切换为已有或原生 fetch 后 transport 语义变化 | 超时、重定向、abort 或流错误表现变化 | 对 Request 输入、redirect、abort、gzip、流中断做原生 fetch 契约测试 |
| fetch wrapper 重复安装或递归 | 请求栈溢出或 adapter 重复执行 | config 阶段缓存原始 baseFetch，wrapper 使用实例标记并保证幂等 |
| Langfuse Event 到达顺序变化 | generation 无法结束或关联错误 | 保留 message ID queue，并增加并发和乱序测试 |
| 单包内模块故障互相影响 | Wanqing 或 Langfuse 连带失效 | 模块初始化、Hook 和 dispose 隔离错误；模块级开关支持快速降级 |
| 外部插件安装失败 | 观测或 Provider 定制缺失 | 固定版本、预装缓存、缺失时清晰告警 |
| 内网 registry 缺少依赖版本 | 安装或发布失败 | 发布前逐项执行 `npm view --registry`，缺失依赖先走内部镜像或发布流程 |
| 内网 registry 认证失效 | CI 或生产无法安装 | token 由 secret 注入，发布和部署任务增加认证探测，不在仓库保存凭证 |
| 调用者本地 registry 覆盖 | 误发公网或从公网拉包 | 仓库根 `.npmrc` 固定 registry，发布命令显式传 `--registry` |
| OpenCode 与插件 API 版本漂移 | 加载或 Hook 类型错误 | `engines.opencode` 和 peer range 双重限制 |
| 密钥通过配置泄露 | 安全风险 | 优先环境变量，日志强制掩码，禁止输出完整 options |
| 目标工作树存在未提交改动 | 方案实施时混入无关变更 | 新建独立短分支或 worktree，按阶段提交 |

## 12. 回滚方案

1. 保留旧 builtin 实现一个发布周期。
2. 切换由配置控制，不在首个版本删除旧代码。
3. 单模块异常时先通过 `wanqing: false` 或 `langfuse: false` 降级。
4. 整包异常时移除唯一 `plugin` spec，恢复 builtin 注册。
5. npm 包版本固定；回滚只需恢复上一版本 spec。
6. 公共 `chat.params.messages` 为可选字段，无需回滚即可兼容旧插件。

## 13. 验收标准

满足以下条件才能删除旧 builtin：

- 单包无 `@/`、`opencode/src`、`GlobalBus` 导入。
- Wanqing 与 Langfuse 模块不互相导入，交互只经过根 server、共享 ModelCatalog 和 ProviderObservability。
- Wanqing fetch wrapper 保留 Gemini/GPT/DeepSeek 请求与响应适配。
- 底层 transport 使用已有 Provider fetch 或 `globalThis.fetch`，包内无 `curl-fetch` 和 curl 子进程。
- 到达远端的请求不包含 `x-m0-session-id`、`x-m0-message-id`、`x-m0-call-key`。
- Provider HTTP metadata 不经过 GlobalBus，并能关联到 Langfuse generation。
- Langfuse 能记录完整模型输入、输出、usage 和工具调用。
- Langfuse 缺密钥或服务不可用不阻断模型调用。
- 多 Session 并发测试通过。
- tarball 安装和 npm spec 加载测试通过。
- `@m0/opencode-plugin`、直接依赖和 peer dependency 均可从 `https://npm.corp.kuaishou.com/` 解析。
- 干净环境安装过程中无公网 registry 请求。
- 仓库和发布配置不包含 registry 认证凭证。
- OpenCode 核心只包含通用 `chat.params.messages` API 扩展，不包含 M0 实现或依赖。

## 14. 推荐提交拆分

```text
feat(plugin): expose messages to chat params hook
feat(plugin): add m0 plugin package and wanqing module
feat(plugin): add langfuse module to m0 plugin
test(plugin): cover packaged m0 plugin loading
chore(plugin): configure internal npm registry
chore(opencode): switch m0 plugins to npm packages
```

每个提交可独立 typecheck 和测试。旧 builtin 删除放在最后单独提交，便于回滚。
