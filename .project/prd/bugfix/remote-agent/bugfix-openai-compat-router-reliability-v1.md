# Bugfix: OpenAI 兼容路由器可靠性修复

**版本**: v1
**模块**: remote-agent / openai-compat-router
**功能**: 远端 Agent 代理路由
**日期**: 2026-05-22
**状态**: draft
**指令人**: MoonSeeker

## 问题描述

Code review 发现远程 Agent Proxy 的 OpenAI 兼容路由器存在多个可靠性问题：

1. **路由识别边缘遗漏**：`detectBackendType()` 通过 URL 含 `/anthropic` 或 `api.anthropic.com` 判断 Anthropic 协议，但 Anthropic 标准端点 `/v1/messages` 不含 `/anthropic` 关键词，会被误判为 OpenAI 兼容，导致格式转换错误
2. **SDK 重试机制被干扰**：`retry-after` 被 router 强制覆盖为 3 秒，上游退避策略被忽略；非 Anthropic 格式的错误直接透传，SDK 无法识别错误类型（`rate_limit_error` / `overloaded_error`），内部重试失效
3. **请求队列过度串行化**：同一后端的请求严格串行排队，子代理并行能力丧失，排队请求更易触发限流
4. **缺少等待超时保护**：请求在队列中可无限等待，无超时机制

## 问题根因

### 1. 启发式规则不完整

前一个 PRD（`bugfix-api-type-passthrough-removal-v1`）将 apiType 检测从前端移到远端，但 `detectBackendType()` 的 URL 模式匹配不完整：

```typescript
// 当前：只认这两种
if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
if (baseUrl.includes('/anthropic')) return 'anthropic'
// 遗漏：/v1/messages 端点（Anthropic 标准协议标识）
```

任何提供 `/v1/messages` 端点但 URL 不含 `/anthropic` 的后端（自定义代理、自建服务）都会被错误路由到 OpenAI 转换路径。

### 2. router 层干预了 SDK 决策

- `sendError()` 和 `handleAnthropicPassthrough()` 中 `res.setHeader('retry-after', '3')` 覆盖了上游的退避时间
- OpenAI 转换路径的错误响应不保证是 Anthropic 标准格式（`{ type: 'error', error: { type, message } }`），SDK 收到非标准格式时直接抛异常，不触发重试

### 3. 请求队列设计过于保守

`request-queue.ts` 用 Promise 链实现互斥锁，同一 backendUrl + apiKey 同时只允许 1 个请求。子代理 spawn 多个并行请求时全部排队。

## 修复方案

### 核心思路

**router 是透明代理 + 格式翻译器，不干预 SDK 的重试和调度决策。** 只做两件事：格式翻译和错误标准化。

### 1. 路由识别修复

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`

`detectBackendType()` 新增规则：

```typescript
private detectBackendType(baseUrl?: string): 'anthropic' | 'openai_compat' {
  if (process.env.REMOTE_AGENT_API_TYPE === 'anthropic_passthrough') return 'anthropic'
  if (!baseUrl) return 'anthropic'
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
  if (baseUrl.includes('/anthropic')) return 'anthropic'
  if (baseUrl.endsWith('/v1/messages') || baseUrl.endsWith('/messages')) return 'anthropic'
  return 'openai_compat'
}
```

正确识别后不进入 `normalizeApiUrl()` 和 `getApiTypeFromUrl()`，无需修改这两个函数。

### 2. 重试机制修复

**文件**: `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts`

#### 2.1 删除 retry-after 强制覆盖

移除 `sendError()` 和 `handleAnthropicPassthrough()` 中的 `res.setHeader('retry-after', '3')`，改为透传上游值。

#### 2.2 错误响应标准化

`handleOpenAIConversion()` 的错误分支统一转换为 Anthropic 标准格式：

```typescript
if (!upstreamResp.ok) {
  const errorText = await upstreamResp.text()
  res.status(upstreamResp.status)
  forwardResponseHeaders(upstreamResp, res)  // 透传上游头（含 retry-after）
  res.setHeader('Content-Type', 'application/json')
  // 标准化为 Anthropic 格式，确保 SDK 能识别
}
```

新增 `mapErrorType()` 辅助函数（401→`authentication_error`、429→`rate_limit_error`、529→`overloaded_error`、5xx→`api_error`）。

### 3. 请求队列优化

**文件**: `packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts`

从互斥锁改为信号量模式：

- 默认允许 3 个并发请求（`ROUTER_MAX_CONCURRENT_REQUESTS` 环境变量可调）
- 排队等待超过 30 秒自动拒绝（`QUEUE_WAIT_TIMEOUT_MS`）
- `releaseSlot()` 时自动触发等待队列中的下一个请求

### 4. 预留扩展（不实现）

- `BackendConfig.apiType` 已支持三值，数据结构无需改动
- 前端 AI Source 预留 `apiProtocol` 字段（`'auto' | 'anthropic' | 'openai'`），本次不实现 UI

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/claude-manager.ts` | 逻辑修改 | `detectBackendType()` 新增 `/v1/messages` 识别规则 |
| `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 逻辑修改 | 删除 retry-after 覆盖，错误响应标准化 |
| `packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts` | 重写 | 互斥锁 → 信号量 + 等待超时 |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/openai-compat-router/openai-compat-router-v1.md` | 理解路由器整体架构和组件职责 |
| 功能设计文档 | `.project/modules/openai-compat-router/features/request-routing/design.md` | 理解请求路由子系统的设计 |
| 功能设计文档 | `.project/modules/openai-compat-router/features/stream-pipeline/design.md` | 理解流式管道如何与重试交互 |
| 前置 PRD | `.project/prd/bugfix/remote-agent/bugfix-api-type-passthrough-removal-v1.md` | 理解 apiType 检测从前期移到远端的背景 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | `detectBackendType()` 和 `buildSdkOptions()` 路由分支 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | `sendError()`、`handleAnthropicPassthrough()`、`handleOpenAIConversion()` 的错误处理 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts` | 当前互斥锁实现 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/server/api-type.ts` | `getApiTypeFromUrl()` 推断逻辑 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/utils/url.ts` | `normalizeApiUrl()` 归一化规则 |

## 验收标准

- [ ] URL 以 `/v1/messages` 结尾的后端被正确识别为 Anthropic 协议，走透传（不进入 OpenAI 转换路径）
- [ ] URL 以 `/messages` 结尾的后端被正确识别为 Anthropic 协议
- [ ] `retry-after` 透传上游原始值，不被覆盖为 3
- [ ] 非 Anthropic 格式的错误响应（如 OpenAI 格式）被包装为 `{ type: 'error', error: { type, message } }` 标准格式
- [ ] 429 错误映射为 `rate_limit_error`，SDK 能识别并执行 backoff 重试
- [ ] 401 错误映射为 `authentication_error`，SDK 能触发 `api_retry` 事件
- [ ] 同一后端允许 3 个并发请求（`ROUTER_MAX_CONCURRENT_REQUESTS` 环境变量可调）
- [ ] 请求排队超过 30 秒后返回超时错误，SDK 收到可识别的错误响应
- [ ] 现有 OpenAI 兼容后端（DeepSeek、Groq、vLLM、Ollama）不受影响
- [ ] 现有 Anthropic 透传后端（含 `/anthropic` 路径的）不受影响
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-22 | 初始 PRD | MoonSeeker |
