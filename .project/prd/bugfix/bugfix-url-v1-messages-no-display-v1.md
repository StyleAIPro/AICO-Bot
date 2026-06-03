---
created: 2026-06-01
status: confirmed
type: bugfix
commander: mi-saka
level: bugfix
---

# Bugfix: URL 含 /v1/messages 后缀时模型输出不显示

> 版本：bugfix-url-v1-messages-no-display-v1
> 日期：2026-06-01
> 指令人：mi-saka
> 归属模块：modules/agent (sdk-config) + openai-compat-router (url)
> 严重程度：High（用户配置带 /v1/messages 后缀的 URL 时完全无法使用）
> 影响范围：后端凭证解析 + URL 归一化
> 状态：confirmed

## 问题描述

### 期望行为

当用户配置 AI source 为 Anthropic provider，URL 为 `http://123.4.5.6:7890/v1/messages` 时，模型输出应正确显示在对话框中。

### 实际行为

模型输出在日志中可见但不会显示在对话框中。将 URL 改为 `http://123.4.5.6:7890`（去掉 `/v1/messages` 后缀）则正常工作。

### 复现步骤

1. 打开设置，配置 AI source URL 为 `http://123.4.5.6:7890/v1/messages`，provider 设为 `anthropic`
2. 创建/打开一个工作空间，发送一条消息
3. 观察日志：模型有输出，但对话框为空
4. 将 URL 改为 `http://123.4.5.6:7890`，重试，输出正常显示

### 影响范围

- **URL 含 `/v1/messages` 后缀的 Anthropic provider**：必现
- **标准 Anthropic API（`api.anthropic.com`）**：不受影响（hostname 检测正确）
- **URL 不含后缀的 OpenAI 兼容模型**：不受影响
- **影响功能**：所有配置了 Anthropic 风格路径后缀但实际为 OpenAI 兼容的内网模型

## 根因分析

### 错误数据流

```
用户配置 URL: http://123.4.5.6:7890/v1/messages (provider: anthropic)
  → sdk-config.ts: detectNativeAnthropic() 检测到 URL 以 /v1/messages 结尾 → 返回 true
  → resolveAnthropicPassthrough() 路径
  → encodeBackendConfig({ apiType: 'anthropic_passthrough' })
  → OpenAI Compat Router: handleAnthropicPassthrough() 透传模式
  → 上游返回 OpenAI 格式 SSE，但透传模式原样转发给 SDK
  → SDK 无法解析 OpenAI 格式 SSE → 界面不显示任何内容
```

### 正确数据流（URL 为 `http://123.4.5.6:7890` 时）

```
用户配置 URL: http://123.4.5.6:7890 (provider: anthropic)
  → sdk-config.ts: detectNativeAnthropic() 无 /v1/messages 后缀，hostname 非 api.anthropic.com → 返回 false
  → OpenAI 兼容路径
  → normalizeApiUrl(url, 'openai') → 加 /v1/chat/completions 后缀
  → encodeBackendConfig({ apiType: 'chat_completions' })
  → OpenAI Compat Router: 正确转换 SSE 格式 → SDK 正常解析 → 界面显示
```

### 根因：`detectNativeAnthropic()` 的 URL 后缀检测过于宽泛

`sdk-config.ts` 第 227-228 行：

```typescript
if (normalized.endsWith('/v1/messages') || normalized.endsWith('/v1/message') ||
    normalized.endsWith('/messages') || normalized.endsWith('/message')) return true;
```

这 4 个条件假设「URL 以 Anthropic API 路径结尾 = 原生 Anthropic 后端」，但实际场景中，许多 OpenAI 兼容的内网代理（如 OneAPI、NewAPI）会暴露 `/v1/messages` 路径。URL 后缀不能作为判断后端类型的可靠依据——只有 hostname（`api.anthropic.com`）或明确包含 `/anthropic` 的路径才是可靠信号。

### 次要问题：`normalizeApiUrl()` 和 `normalizeModelsUrl()` 未剥离 Anthropic 风格后缀

`url.ts` 中 `normalizeApiUrl()` 的 OpenAI 处理逻辑只剥离 `/chat` 后缀（第 42-44 行），不剥离 `/v1/messages` 等后缀。`normalizeModelsUrl()` 的 `suffixes` 数组（第 66 行）也不包含这些后缀。

当 `detectNativeAnthropic()` 修复后，带 `/v1/messages` 后缀的 URL 会进入 OpenAI 兼容路径，此时 `normalizeApiUrl()` 和 `normalizeModelsUrl()` 需要正确剥离这些后缀才能生成正确的目标 URL。

## 技术方案

### 修复点 1：`src/main/services/agent/sdk-config.ts` — 移除 URL 后缀检测

**文件**：`src/main/services/agent/sdk-config.ts`
**函数**：`detectNativeAnthropic()`（第 221-230 行）

移除基于 URL 路径后缀的 4 个条件，仅保留可靠的 hostname 检测和路径包含检测。

修改前：

```typescript
function detectNativeAnthropic(baseUrl?: string): boolean {
  if (!baseUrl) return true;
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.includes('api.anthropic.com')) return true;
  if (normalized.includes('/anthropic')) return true;
  if (normalized.endsWith('/v1/messages') || normalized.endsWith('/v1/message') ||
      normalized.endsWith('/messages') || normalized.endsWith('/message')) return true;
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
  return false;
}
```

### 修复点 2：`src/main/openai-compat-router/utils/url.ts` — `normalizeApiUrl()` 剥离 Anthropic 风格后缀

**文件**：`src/main/openai-compat-router/utils/url.ts`
**函数**：`normalizeApiUrl()`（第 26-52 行）

在 OpenAI provider 的处理逻辑中（`/chat` 剥离之前），增加对 Anthropic 风格路径后缀的剥离。

修改前：

```typescript
// Strip incomplete path suffix
if (normalized.endsWith('/chat')) {
  normalized = normalized.slice(0, -5);
}
```

修改后：

```typescript
// Strip Anthropic-style path suffixes (user may paste /v1/messages URL for an OpenAI-compat proxy)
const anthropicSuffixes = ['/v1/messages', '/v1/message', '/messages', '/message'];
for (const suffix of anthropicSuffixes) {
  if (normalized.endsWith(suffix)) {
    normalized = normalized.slice(0, -suffix.length);
    break;
  }
}

// Strip incomplete path suffix
if (normalized.endsWith('/chat')) {
  normalized = normalized.slice(0, -5);
}
```

处理流程示例：

- `http://123.4.5.6:7890/v1/messages` → 剥离 `/v1/messages` → `http://123.4.5.6:7890` → host-only → 加 `/v1` → 加 `/chat/completions` → `http://123.4.5.6:7890/v1/chat/completions`

### 修复点 3：`src/main/openai-compat-router/utils/url.ts` — `normalizeModelsUrl()` 增加后缀

**文件**：`src/main/openai-compat-router/utils/url.ts`
**函数**：`normalizeModelsUrl()`（第 61-84 行）

在 `suffixes` 数组中增加 Anthropic 风格路径后缀，确保模型列表请求 URL 也正确生成。

修改前：

```typescript
const suffixes = ['/chat/completions', '/completions', '/responses', '/chat'];
```

修改后：

```typescript
const suffixes = ['/chat/completions', '/completions', '/responses', '/v1/messages', '/v1/message', '/messages', '/message', '/chat'];
```

注意 `/v1/messages` 和 `/v1/message` 放在 `/messages` 和 `/message` 前面，确保长后缀优先匹配（避免 `/v1/messages` 被错误地只剥离 `/messages` 剩下 `/v1`）。

## 风险评估

### 风险 1：某些 Anthropic 后端 URL 可能不含 `api.anthropic.com` 或 `/anthropic`（低风险）

移除后缀检测后，如果用户配置了一个非标准 hostname 的原生 Anthropic 代理（如 `http://my-proxy.example.com/v1/messages`），`detectNativeAnthropic()` 会返回 `false`，走 OpenAI 兼容路径。

**缓解**：此类代理通常会在 URL 中包含 `/anthropic` 路径段（如 `/anthropic/v1/messages`），已被 `includes('/anthropic')` 条件覆盖。对于极少数不含 `/anthropic` 的代理，用户可通过去掉后缀（只配 host）来正确路由。

### 风险 2：`normalizeApiUrl()` 后缀剥离顺序（无风险）

`anthropicSuffixes` 从长到短排列，`for` 循环使用 `break` 确保只剥离一个匹配的后缀。由于 `/v1/messages` 比 `/messages` 长，如果 URL 以 `/v1/messages` 结尾，会优先匹配并完整剥离。

## 开发前必读

| 文档 | 路径 | 阅读目的 |
|------|------|----------|
| SDK 配置 | `src/main/services/agent/sdk-config.ts` | 理解 `detectNativeAnthropic` 和 `resolveAnthropicPassthrough` 凭证解析逻辑 |
| URL 工具 | `src/main/openai-compat-router/utils/url.ts` | 理解 `normalizeApiUrl` 和 `normalizeModelsUrl` URL 归一化逻辑 |
| 请求路由 | `src/main/openai-compat-router/server/request-handler.ts` | 理解请求路由和 passthrough 模式选择 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | `detectNativeAnthropic()` 移除 URL 后缀检测（删除 4 个 endsWith 条件） |
| `src/main/openai-compat-router/utils/url.ts` | 修改 | `normalizeApiUrl()` 增加 Anthropic 后缀剥离；`normalizeModelsUrl()` 增加后缀 |

## 验收标准

- [ ] URL 配置为 `http://IP:PORT/v1/messages` 时，模型输出正确显示在对话框中
- [ ] URL 配置为 `http://IP:PORT` 时，行为不变，仍然正常工作
- [ ] `api.anthropic.com` 相关 URL 仍走 Anthropic passthrough 路径
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
