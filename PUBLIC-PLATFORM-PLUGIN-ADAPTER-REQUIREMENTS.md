# M0 插件功能对应的 OpenCode 改动

## 1. 记录真实 LLM 输入

### 功能需求

Langfuse需要记录本轮真正发送给模型的完整输入，包括 system prompt、历史消息、当前消息和压缩后的上下文。

### OpenCode改动

#### `packages/plugin/src/index.ts`

在 `Hooks["chat.params"]` 输入中增加：

```ts
messages?: unknown[]
```

#### `packages/opencode/src/session/llm/request.ts`

在 OpenCode完成最终消息组装后，将 `messages` 传给 `chat.params`：

```text
组装最终 messages
  → chat.params
  → Provider转换
  → 发起模型请求
```

插件由此直接读取真实模型输入，不再重新查询 Session或复制 OpenCode消息组装逻辑。

---

## 2. 支持按模型处理图片输入

### 功能需求

Wanqing不同模型需要不同图片传输方式：

- 保留远程 CDN URL。
- 下载远程图片并转换为 data URL。

处理需要发生在 OpenCode `image.normalize` 前，并覆盖用户图片和 Tool Result图片。

### OpenCode改动

#### `packages/plugin/src/index.ts`

新增图片预处理 Hook：

```ts
"experimental.chat.image.transform"?: (
  input: {
    model: {
      providerID: string
      modelID: string
    }
  },
  output: {
    part: Extract<Part, { type: "file" }>
  },
) => Promise<void>
```

插件通过修改 `output.part` 返回处理后的图片。

#### `packages/opencode/src/session/prompt.ts`

用户图片保存前增加 Hook：

```text
用户图片 FilePart
  → experimental.chat.image.transform
  → image.normalize
  → 保存 Message/Part
```

`image.normalize` 和 resize fallback都使用插件返回的 `transformed.part`。

#### `packages/opencode/src/session/processor.ts`

Tool Result图片保存前增加相同 Hook：

```text
Tool Result attachment
  → experimental.chat.image.transform
  → image.normalize
  → completeToolCall
```

每张图片单独处理；非图片 attachment保持原逻辑。

---

## 3. 支持从私有 registry安装插件

### 功能需求

M0插件作为独立 npm Server Plugin发布：

```json
{
  "exports": {
    "./server": "./dist/server.js"
  }
}
```

插件只有 `./server` export，不提供 root entrypoint，并从公司私有 registry安装。

### OpenCode改动

#### `packages/core/src/npm.ts`

调整 `Npm.add()`：

1. 安装到 OpenCode缓存目录时，从平台启动目录读取 `.npmrc`。
2. package directory存在时允许安装成功。
3. 不再要求 package必须提供 root `main`、root index或 `exports["."]`。
4. 后续仍由 Plugin Loader解析 `exports["./server"]`。

该改动只在平台运行时动态安装插件时需要；镜像预装插件时不需要。

## 改动文件汇总

```text
packages/plugin/src/index.ts
packages/opencode/src/session/llm/request.ts
packages/opencode/src/session/prompt.ts
packages/opencode/src/session/processor.ts
packages/core/src/npm.ts
```
