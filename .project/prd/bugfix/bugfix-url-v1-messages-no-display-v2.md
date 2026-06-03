---
created: 2026-06-02
status: done
type: bugfix
commander: mi-saka
level: bugfix
---

# Bugfix: v1 回归修复 — provider 为 anthropic 时 /v1/messages URL 被错误路由到 OpenAI 兼容路径

> 版本：bugfix-url-v1-messages-no-display-v2
> 日期：2026-06-02
> 指令人：mi-saka
> 归属模块：modules/agent (sdk-config)
> 严重程度：High（v1 回归：用户明确配置 provider=anthropic + /v1/messages URL 时请求失败）
> 影响范围：后端凭证解析
> 状态：draft
> 前置 PRD：bugfix-url-v1-messages-no-display-v1.md

## 问题描述

### 期望行为

当用户配置 AI source 为 `provider: anthropic`，URL 为 `http://123.4.5.6:7890/v1/messages`（上游确实是原生 Anthropic API），请求应以 Anthropic 原生格式发送到 `/v1/messages`，模型输出正确显示。

### 实际行为（v1 回归）

v1 修复移除了 `detectNativeAnthropic()` 中的 URL 路径后缀检测后，此场景下：

1. `detectNativeAnthropic()` 返回 `false`
2. 请求进入 OpenAI 兼容路径
3. `normalizeApiUrl()` 将 URL 转为 `http://123.4.5.6:7890/v1/chat/completions`
4. 请求以 OpenAI 格式发出，上游 Anthropic API 不认识该端点 → 输出为空或报错

### 复现步骤

1. 打开设置，配置 AI source URL 为 `http://123.4.5.6:7890/v1/messages`，provider 设为 `anthropic`（上游确实是 Anthropic 原生 API）
2. 创建/打开一个工作空间，发送一条消息
3. 观察到请求被发送到 `/v1/chat/completions`，上游返回错误或无输出

### 影响范围

- **provider=anthropic + URL 含 `/v1/messages` 后缀且上游为原生 Anthropic**：必现（v1 回归）
- **provider=anthropic + URL 不含后缀**：不受影响
- **`api.anthropic.com` 相关 URL**：不受影响（hostname 检测正确）
- **provider=openai 或其他**：不受影响（`detectNativeAnthropic()` 不会被调用）

## 根因分析

### 错误数据流（v1 回归）

```
用户配置 URL: http://123.4.5.6:7890/v1/messages (provider: anthropic, 上游为原生 Anthropic)
  → sdk-config.ts: detectNativeAnthropic() 无后缀检测，hostname 非 api.anthropic.com → 返回 false
  → OpenAI 兼容路径
  → normalizeApiUrl(url, 'openai') → http://123.4.5.6:7890/v1/chat/completions
  → encodeBackendConfig({ apiType: 'chat_completions' })
  → 请求以 OpenAI 格式发到 /v1/chat/completions → 上游 Anthropic API 不认识 → 失败
```

### 根因：`detectNativeAnthropic()` v1 过度删除

v1 修复（bugfix-url-v1-messages-no-display-v1.md）为了解决「OpenAI 兼容代理暴露 `/v1/messages` 路径」的问题，删除了全部 4 个 URL 后缀检测条件。但这一修复忽略了以下安全保证：

- `detectNativeAnthropic()` **只在 `credentials.provider === 'anthropic'` 时被调用**（sdk-config.ts 第 158 行）
- 用户明确配置 provider 为 `anthropic`，说明上游就是 Anthropic 格式
- 当 provider 为 `openai` 或其他值时，此函数根本不会被调用，不会影响 OpenAI 兼容代理

因此，URL 路径后缀在 provider 已确认为 `anthropic` 的前提下是**可靠的判断信号**，不应被删除。

## 技术方案

### 修复点：`src/main/services/agent/sdk-config.ts` — 恢复 URL 路径后缀检测

**文件**：`src/main/services/agent/sdk-config.ts`
**函数**：`detectNativeAnthropic()`（第 221-228 行）

加回 v1 删除的 URL 路径后缀检测条件。

修改前（当前 v1 代码）：

```typescript
function detectNativeAnthropic(baseUrl?: string): boolean {
  if (!baseUrl) return true;
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.includes('api.anthropic.com')) return true;
  if (normalized.includes('/anthropic')) return true;
  return false;
}
```

修改后：

```typescript
function detectNativeAnthropic(baseUrl?: string): boolean {
  if (!baseUrl) return true;
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.includes('api.anthropic.com')) return true;
  if (normalized.includes('/anthropic')) return true;
  // 当 provider 已确认为 anthropic 时，URL 路径后缀也是可靠信号
  if (normalized.endsWith('/v1/messages') || normalized.endsWith('/v1/message') ||
      normalized.endsWith('/messages') || normalized.endsWith('/message')) return true;
  return false;
}
```

### 不需要修改的文件

**`src/main/openai-compat-router/utils/url.ts`** — v1 加的后缀剥离逻辑保留即可。这些剥离逻辑只在 provider 为非 anthropic 时生效（OpenAI 兼容路径），与本次修复不冲突。

## 风险评估

### 无新增风险

加回后缀检测不会引入 v1 要解决的问题，因为：

- `detectNativeAnthropic()` 只在 `provider === 'anthropic'` 时被调用
- v1 场景（OpenAI 兼容代理暴露 `/v1/messages`）的 provider 不会是 `anthropic`，因此此函数不会被调用
- 用户明确选了 `anthropic` provider + 配了 `/v1/messages` URL，就等于告诉系统「上游是 Anthropic 格式」

## 开发前必读

| 文档 | 路径 | 阅读目的 |
|------|------|----------|
| SDK 配置 | `src/main/services/agent/sdk-config.ts` | 理解 `detectNativeAnthropic` 和调用上下文（第 158 行 provider 判断） |
| URL 工具 | `src/main/openai-compat-router/utils/url.ts` | 确认 v1 加的后缀剥离逻辑保留 |
| v1 PRD | `.project/prd/bugfix/bugfix-url-v1-messages-no-display-v1.md` | 理解 v1 修复的背景和理由 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | `detectNativeAnthropic()` 加回 4 个 endsWith 条件（第 227 行后） |

## 验收标准

- [ ] provider=anthropic + URL 为 `http://IP:PORT/v1/messages` 时，请求走 Anthropic passthrough 路径，输出正确显示
- [ ] provider=anthropic + URL 为 `http://IP:PORT` 时，行为不变
- [ ] `api.anthropic.com` 相关 URL 仍走 Anthropic passthrough 路径
- [ ] provider=openai + URL 含 `/v1/messages` 时，仍走 OpenAI 兼容路径（v1 修复不受影响）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

---

> **说明**：本 PRD 是 bugfix-url-v1-messages-no-display-v1.md 的回归修复。v1 为了解决 OpenAI 兼容代理暴露 `/v1/messages` 的问题，过度删除了 `detectNativeAnthropic()` 中的后缀检测条件，导致 provider 已确认为 anthropic 的合法场景也被误路由到 OpenAI 兼容路径。v2 恢复后缀检测，安全性由调用端的 provider 判断保证。
