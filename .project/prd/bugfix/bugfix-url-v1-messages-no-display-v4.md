---
created: 2026-06-04
status: confirmed
type: bugfix
commander: mi-saka
level: bugfix
---

# Bugfix: 非 anthropic provider 的 /v1/messages URL 被错误路由到 OpenAI compat 路径

> 版本：bugfix-url-v1-messages-no-display-v4
> 日期：2026-06-04
> 指令人：mi-saka
> 归属模块：modules/agent (sdk-config)
> 严重程度：P0（API 完全不可用，fetch failed）
> 影响范围：后端凭证解析
> 前置 PRD：bugfix-url-v1-messages-no-display-v3.md

## 问题描述

### 期望行为

当用户配置 AI source 为 OAuth provider（如 gitcode），URL 为 `https://12.34.56.7:890/apiaccess/modelgateway/v1/messages`（Anthropic 格式端点），系统应识别 URL 的 `/v1/messages` 后缀，走 Anthropic passthrough 路径，正确转发请求到上游，消息正常显示。

### 实际行为

1. 用户配置 gitcode OAuth provider，URL 为 `https://12.34.56.7:890/apiaccess/modelgateway/v1/messages`
2. `detectNativeAnthropic()` 正确识别 `/v1/messages` 后缀，返回 `true`
3. 但 `resolveCredentialsForSdk()` 第 158 行的判断条件要求 `credentials.provider === 'anthropic'`，而 OAuth provider 的 `provider` 值为 `'oauth'`，条件不满足
4. 代码跳过 Anthropic passthrough，走入 OpenAI compat 路径
5. `normalizeApiUrl()` 将 URL 处理后拼接 `/chat/completions`，最终请求发送到 `https://12.34.56.7:890/apiaccess/modelgateway/v1/messages/chat/completions`
6. 上游不认识该路径，返回错误 → `fetch failed`
7. 用户看到 API 完全不可用

日志表现：
```
[RequestHandler] wire=chat_completions tools=62
[RequestHandler] POST https://12.34.56.7:890/apiaccess/modelgateway/v1/messages /chat/completions (stream=true)
[RequestHandler] Fetch upstream via direct: https://12.34.56.7:890/apiaccess/modelgateway/v1/messages /chat/completions (useProxy=true)
[RequestHandler] Internal error: fetch failed
```

### 复现步骤

1. 打开设置，添加一个 OAuth provider（如 gitcode）
2. 配置 URL 为 `https://12.34.56.7:890/apiaccess/modelgateway/v1/messages`（上游为 Anthropic 格式端点）
3. 完成 OAuth 登录授权
4. 创建/打开一个工作空间，选择该 AI source
5. 发送一条消息
6. 观察：消息发送失败，日志显示请求被发送到错误的 `/chat/completions` 路径

### 影响范围

- **OAuth provider + URL 以 `/v1/messages` 结尾**：必现，API 完全不可用
- **provider=openai + URL 以 `/v1/messages` 结尾**：理论上同样受影响（同样跳过 passthrough）
- **provider=anthropic + 任意 URL**：不受影响（v3 修复已覆盖）
- **OAuth/OpenAI provider + 非 `/v1/messages` URL**：不受影响（走正常的 OpenAI compat 路径）

## 根因分析

### 数据流

```
用户配置: gitcode OAuth provider, URL=https://12.34.56.7:890/apiaccess/modelgateway/v1/messages
  → helpers.ts 第 224-225 行: authType === 'oauth' → provider = 'oauth'
  → sdk-config.ts 第 156 行: detectNativeAnthropic(baseUrl) → 检测到 /v1/messages → 返回 true
  → sdk-config.ts 第 158 行: credentials.provider === 'anthropic' && isNativeAnthropic
     → provider === 'oauth' ≠ 'anthropic' → 条件为 false → 跳过 Anthropic passthrough
  → 进入 OpenAI compat 路径（第 181-215 行）
  → normalizeApiUrl() 处理 URL，拼接 /chat/completions
  → 最终 URL: https://12.34.56.7:890/apiaccess/modelgateway/v1/messages/chat/completions
  → 上游不认识该路径 → fetch failed
```

### provider 如何确定

在 `helpers.ts` 第 222-230 行：

```typescript
let provider: 'anthropic' | 'openai' | 'oauth';
if (currentSource?.authType === 'oauth') {
  provider = 'oauth';          // ← gitcode 等走这里
} else if (currentSource?.provider === 'anthropic') {
  provider = 'anthropic';      // ← Anthropic 直连走这里
} else {
  provider = 'openai';         // ← 其他走这里
}
```

所有 OAuth 认证的 AI source（gitcode、及其他第三方 OAuth provider），无论其后端是什么格式，`provider` 都被标记为 `'oauth'`。

### 根因

`sdk-config.ts` 第 158 行使用 `credentials.provider === 'anthropic'` 作为路由 Anthropic passthrough 的必要条件。但 URL 格式才是判断上游协议的可靠信号——如果 URL 以 `/v1/messages` 结尾，说明上游暴露的是 Anthropic 格式 API，应走 Anthropic passthrough 路径。provider 标签（由认证方式决定）不应覆盖 URL 格式的路由信号。

## 技术方案

### 修复点

**文件**：`src/main/services/agent/sdk-config.ts`
**函数**：`resolveCredentialsForSdk()`
**位置**：第 158 行

将：
```typescript
if (credentials.provider === 'anthropic' && isNativeAnthropic) {
```

改为：
```typescript
if (isNativeAnthropic) {
```

**理由**：`detectNativeAnthropic()` 已经由 URL 格式判断出上游是否为 Anthropic 格式。如果返回 `true`，无论 `provider` 标签是什么，都应走 Anthropic passthrough 路径。URL 格式是比 provider 标签更可靠的路由信号。

### 不需要修改的文件

- **`src/main/openai-compat-router/server/request-handler.ts`** — `handleAnthropicPassthrough()` 已正确实现，无需修改
- **`src/main/services/agent/helpers.ts`** — provider 判断逻辑（OAuth → `'oauth'`）不变，这是认证层面的正确行为
- **`src/main/openai-compat-router/url.ts`** — `normalizeApiUrl` 不变

## 风险评估

### 低风险

1. **`detectNativeAnthropic(undefined)` 返回 `true`** — 理论上 `provider=openai` + 无 URL 的场景会误入 passthrough。但实际上：
   - 无 URL 时，`credentials.baseUrl` 为 `undefined`，`detectNativeAnthropic(undefined)` 返回 `true`
   - 此场景走 passthrough 后，`resolveAnthropicPassthrough()` 会使用默认值 `https://api.anthropic.com`，但 API key 不对会报认证错误而非 `fetch failed`
   - 实际使用中，`provider=openai` + 无 URL 几乎不存在（OpenAI provider 必须配置 URL）

2. **`api.anthropic.com` 和 `/anthropic` 检测** — 只有真正的 Anthropic 格式 URL 才会匹配，不会误判

3. **`/v1/messages` 后缀检测** — 这是明确的 Anthropic 协议信号，不会与 OpenAI 格式 URL 冲突

4. **v3 修复不退化** — `provider=anthropic` 时 `detectNativeAnthropic` 仍然返回正确结果，v3 的 compat 模型逻辑在 `resolveAnthropicPassthrough()` 中完整保留

## 开发前必读

| 文档 | 路径 | 阅读目的 |
|------|------|----------|
| SDK 配置 | `src/main/services/agent/sdk-config.ts` | 理解 `resolveCredentialsForSdk`、`detectNativeAnthropic`、`resolveAnthropicPassthrough` 凭证解析逻辑 |
| Provider 判断 | `src/main/services/agent/helpers.ts` | 理解 `provider` 如何从 `authType` 确定（第 222-230 行） |
| v1 PRD | `.project/prd/bugfix/bugfix-url-v1-messages-no-display-v1.md` | 理解 v1 修复的背景：detectNativeAnthropic 和 passthrough 路径 |
| v2 PRD | `.project/prd/bugfix/bugfix-url-v1-messages-no-display-v2.md` | 理解 v2 修复的背景：URL 后缀检测恢复 |
| v3 PRD | `.project/prd/bugfix/bugfix-url-v1-messages-no-display-v3.md` | 理解 v3 修复的背景：非 Anthropic 官方上游使用 compat 模型名 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | `resolveCredentialsForSdk()` 第 158 行：去掉 `credentials.provider === 'anthropic'` 条件，仅保留 `isNativeAnthropic` 判断 |

## 验收标准

- [ ] provider=oauth（如 gitcode）+ URL 以 /v1/messages 结尾时，走 Anthropic passthrough 路径，请求成功
- [ ] provider=openai + URL 以 /v1/messages 结尾时，走 Anthropic passthrough 路径
- [ ] provider=anthropic + api.anthropic.com URL 仍正常工作
- [ ] provider=anthropic + 自定义 /v1/messages URL 仍正常工作（v3 修复不退化）
- [ ] provider=openai + OpenAI 格式 URL 仍走 chat_completions 路径
- [ ] npm run typecheck 通过
- [ ] npm run build 通过

---

> **说明**：本 PRD 是 bugfix-url-v1-messages-no-display-v3.md 的延伸修复。v1 建立了 Anthropic passthrough 路径；v2 恢复了 `detectNativeAnthropic()` 的 URL 后缀检测；v3 在 passthrough 路径中为非 Anthropic 官方上游增加了 compat 模型名以支持 thinking。v4 修复了一个遗留问题：passthrough 路径的入口条件同时要求 `provider === 'anthropic'`，导致 OAuth provider（如 gitcode）即使 URL 明确指向 Anthropic 格式端点也无法进入 passthrough 路径。修复方式是仅依赖 URL 格式（`isNativeAnthropic`）作为路由判断依据。
