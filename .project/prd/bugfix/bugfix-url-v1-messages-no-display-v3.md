---
created: 2026-06-03
status: in-progress
type: bugfix
commander: mi-saka
level: bugfix
---

# Bugfix: Anthropic passthrough 路径 — 自定义模型名导致 SDK 不启用 thinking，thinking 内容不显示

> 版本：bugfix-url-v1-messages-no-display-v3
> 日期：2026-06-03
> 指令人：mi-saka
> 归属模块：modules/agent (sdk-config)
> 严重程度：High（用户明确配置 provider=anthropic + /v1/messages URL 时 thinking 内容丢失）
> 影响范围：后端凭证解析
> 状态：draft
> 前置 PRD：bugfix-url-v1-messages-no-display-v2.md

## 问题描述

### 期望行为

当用户配置 AI source 为 `provider: anthropic`，URL 为 `http://123.4.5.6:7890/v1/messages`（上游为自定义/内网模型，暴露 Anthropic 格式端点），模型的 thinking/extended thinking 内容应正确显示在对话框中。

用户明确要求保留 Anthropic 格式 URL（`/v1/messages`），不转换为 OpenAI 格式（`/v1/chat/completions`）。

### 实际行为

1. 模型的 thinking/extended thinking 内容在上游服务器日志中可见
2. 但 `process-stream.ts` 不接收 thinking 事件 → 对话框不显示 thinking 内容
3. 当 URL 为 `http://123.4.5.6:7890`（不含路径后缀）时，走 OpenAI 兼容路径，thinking 正常显示

### 复现步骤

1. 打开设置，配置 AI source URL 为 `http://123.4.5.6:7890/v1/messages`，provider 设为 `anthropic`
2. 创建/打开一个工作空间，发送一条消息
3. 观察上游服务器日志：thinking 内容有输出
4. 观察对话框：thinking 内容不显示
5. 将 URL 改为 `http://123.4.5.6:7890`，重试，thinking 正常显示

### 影响范围

- **provider=anthropic + URL 含 `/v1/messages` 后缀且上游为非 Anthropic 官方 API**：必现
- **provider=anthropic + URL 不含后缀**：不受影响（走 OpenAI 兼容路径，使用 compat model）
- **`api.anthropic.com` 相关 URL**：不受影响（使用真实模型名，SDK 认识）
- **provider=openai 或其他**：不受影响

## 根因分析

### 错误数据流（v2 修复后遗留问题）

```
用户配置 URL: http://123.4.5.6:7890/v1/messages (provider: anthropic, 自定义模型)
  → sdk-config.ts: detectNativeAnthropic() 检测到 /v1/messages 后缀 → 返回 true
  → resolveAnthropicPassthrough() 路径
  → sdkModel = credentials.model (用户自定义模型名，如 "my-custom-model")
  → SDK 子进程：自定义模型名不在 SDK 内部模型数据库中 → 不启用 thinking 参数 → 不发送 thinking API 请求
  → process-stream.ts：永远收不到 stream_event thinking 事件
  → 对话框：thinking 不显示
```

### 对比：OpenAI 兼容路径（正常工作）

```
用户配置 URL: http://123.4.5.6:7890 (provider: anthropic)
  → sdk-config.ts: detectNativeAnthropic() 无后缀 → 返回 false
  → OpenAI 兼容路径
  → sdkModel = 'claude-sonnet-4-6' (SDK 认识的 compat 模型)
  → SDK 子进程：识别 claude-sonnet-4-6 → 启用 thinking 参数 → 发送 thinking 请求
  → 路由器转发时用真实模型名替代 → 上游收到正确的模型名
  → thinking 正常显示
```

### 根因：`resolveAnthropicPassthrough()` 对非 Anthropic 官方上游使用了真实模型名

`sdk-config.ts` 中 `resolveAnthropicPassthrough()` 返回值：

```typescript
sdkModel: credentials.model || 'claude-opus-4-5-20251101',
```

SDK 使用 `sdkModel` 来决定是否启用 thinking 功能。只有当 `sdkModel` 是 SDK 内部数据库中已知的模型名（如 `claude-sonnet-4-6`）时，SDK 才会：
1. 在 API 请求中添加 `thinking` 参数
2. 发出 thinking 相关的 `stream_event`

用户的自定义模型名不在 SDK 的模型数据库中，因此 SDK 不启用 thinking。

而 OpenAI 兼容路径使用 `sdkModel: 'claude-sonnet-4-6'`（SDK 认识的 compat 模型），所以 thinking 能正常工作。

路由器的 passthrough handler 在转发前会用 `config.model` 覆盖模型名（`request-handler.ts` 第 324-327 行），因此 `sdkModel` 只影响 SDK 本地的功能开关，不影响实际发送到上游的请求。

## 技术方案

### 修复点：`src/main/services/agent/sdk-config.ts` — `resolveAnthropicPassthrough()` 使用 compat 模型名

**文件**：`src/main/services/agent/sdk-config.ts`
**函数**：`resolveAnthropicPassthrough()`（第 237-286 行）

在返回凭证前，检查上游 URL 是否为真正的 Anthropic API。对于非 Anthropic 官方上游（自定义/内网模型），使用 compat 模型名 `claude-sonnet-4-6` 以启用 SDK 的 thinking 功能。

修改后逻辑：

```typescript
// Check if upstream is the actual Anthropic API or a direct proxy.
// For internal/custom models that happen to serve /v1/messages, use a compat
// model name so the SDK enables extended thinking (the SDK only enables thinking
// for models it recognizes; custom model names aren't in its internal database).
// The router's passthrough handler overrides the model before forwarding upstream,
// so the real model name is preserved in the actual API request.
const isActualAnthropicApi =
  baseUrl.includes('api.anthropic.com') || baseUrl.includes('/anthropic');
const useCompatModel = !isActualAnthropicApi;

return {
  anthropicBaseUrl: router.baseUrl,
  anthropicApiKey,
  sdkModel: useCompatModel ? 'claude-sonnet-4-6' : (credentials.model || 'claude-opus-4-5-20251101'),
  displayModel: credentials.displayModel || credentials.model,
  contextWindow: credentials.contextWindow,
  isCompatModel: useCompatModel ? true : undefined,
};
```

**关键说明**：
- `isActualAnthropicApi` 检测 URL 是否为 Anthropic 官方 API（`api.anthropic.com` 或路径含 `/anthropic`）
- 对于非 Anthropic 官方上游：`sdkModel = 'claude-sonnet-4-6'`，`isCompatModel = true` → SDK 启用 thinking
- 对于 Anthropic 官方上游：`sdkModel` 使用真实模型名 → SDK 正常识别模型能力
- 路由器的 `handleAnthropicPassthrough()` 在转发前会用 `config.model`（真实模型名）覆盖请求中的模型名，因此上游收到的始终是真实模型名

### 不需要修改的文件

- **`src/main/openai-compat-router/server/request-handler.ts`** — `handleAnthropicPassthrough()` 的模型覆盖逻辑已正确实现（第 324-327 行），无需修改
- **`src/main/services/agent/process-stream.ts`** — thinking 事件处理逻辑正确，问题在于 SDK 不发送 thinking 事件

## 风险评估

### 无新增风险

- 路由器的 passthrough handler 已有模型名覆盖逻辑，`sdkModel` 不影响实际 API 请求
- Anthropic 官方 API URL（`api.anthropic.com`、含 `/anthropic`）仍使用真实模型名，行为不变
- `isCompatModel` 标记确保上层逻辑正确处理 compat 模型场景
- 本次修复仅影响 `resolveAnthropicPassthrough()` 的返回值，不改变路由逻辑

## 开发前必读

| 文档 | 路径 | 阅读目的 |
|------|------|----------|
| SDK 配置 | `src/main/services/agent/sdk-config.ts` | 理解 `resolveAnthropicPassthrough` 和 `detectNativeAnthropic` 凭证解析逻辑 |
| 请求处理 | `src/main/openai-compat-router/server/request-handler.ts` | 确认 passthrough 模式下的模型名覆盖逻辑（第 324-327 行） |
| v1 PRD | `.project/prd/bugfix/bugfix-url-v1-messages-no-display-v1.md` | 理解 v1 修复的背景和理由 |
| v2 PRD | `.project/prd/bugfix/bugfix-url-v1-messages-no-display-v2.md` | 理解 v2 修复的背景和理由 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | `resolveAnthropicPassthrough()` 检测非 Anthropic 官方上游时使用 compat 模型名和 `isCompatModel` 标记 |

## 验收标准

- [ ] provider=anthropic + URL 为 `http://IP:PORT/v1/messages` 时，thinking 内容正确显示在对话框中
- [ ] provider=anthropic + URL 为 `http://IP:PORT` 时，行为不变
- [ ] `api.anthropic.com` 相关 URL 仍使用真实模型名（不走 compat 路径）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

---

> **说明**：本 PRD 是 bugfix-url-v1-messages-no-display-v2.md 的延伸修复。v2 恢复了 `detectNativeAnthropic()` 中的 URL 后缀检测，使 `/v1/messages` URL 正确路由到 Anthropic passthrough 路径。但 passthrough 路径使用用户的自定义模型名作为 `sdkModel`，而 SDK 不认识自定义模型名，导致不启用 thinking 功能。v3 在 passthrough 路径中增加 compat 模型检测：对于非 Anthropic 官方上游，使用 SDK 认识的 `claude-sonnet-4-6` 作为 `sdkModel`，同时路由器在转发时仍使用真实模型名，确保 thinking 功能启用且上游请求正确。
