---
timestamp: 2026-05-18
status: in-progress
author: misakamikoto
---

# PRD: 修复内网代理不通时对话无错误反馈（SDK 重试 250 秒问题）

## 元信息

- 模块: chat
- 优先级: P1
- 影响范围: 全栈（后端路由器 + 前端）
- 级别: bugfix
- 指令人: misakamikoto

## 需求分析

### 背景

在内网环境使用 AICO-Bot 时，如果系统级网络代理已开启（无论是否在 AICO-Bot 中勾选「使用网络代理」），AI 模型都无法正常对话——这是内网环境下代理路由不通的正常现象。但**关键问题**是：用户界面看不到任何报错信息，只会看到模型一直处于「思考中」状态，无法得知发生了什么。

具体场景：

1. **勾选了「使用网络代理」**：路由器通过 `proxyFetch()` 显式走代理 CONNECT，代理不通时 CONNECT 失败
2. **未勾选「使用网络代理」**：路由器调用原生 `fetch()` 连接上游 API，但系统级代理（Windows 代理设置或 `HTTP_PROXY` 环境变量）仍然介入，同样导致 CONNECT 失败

两种情况的最终表现完全一致：用户看到「思考中」但永远等不到回复。

### 问题

1. **根因**：`proxy-fetch.ts` 在代理 CONNECT 握手失败时抛出 `new Error('Proxy CONNECT failed (...)')` 普通错误
2. **传播链**：`request-handler.ts` 的 `catch` 块捕获此错误后，调用 `sendError(res, 'api_error', message)` 返回 HTTP 500 + `retry-after: 3`
3. **SDK 行为**：Anthropic SDK 对 HTTP 500 默认执行指数退避重试（maxRetries=2），每次重试都重新发起代理 CONNECT（10s 超时），总计约 250 秒
4. **用户感知**：用户看到「思考中」动画持续约 250 秒，无任何错误提示，体验极差
5. **本质**：代理 CONNECT 失败是**配置/网络问题**，不是 API 暂时性故障，SDK 不应该重试

### 影响范围

- **内网用户**：系统代理开启但代理路由不通，不论是否勾选「使用网络代理」
- **代理配置不当的用户**：代理服务器不可达、返回非 200 状态码、连接超时
- **两种路由模式均受影响**：Anthropic passthrough 和 OpenAI conversion

## 技术方案

### 核心思路

在代理 CONNECT 失败时，让 OpenAI Compat Router 返回 **HTTP 4xx**（非重试）状态码，而非 HTTP 500，使 SDK 立即停止重试并向上抛出错误。

### 实现步骤

#### 1. 创建自定义错误类 `ProxyConnectError`

在 `proxy-fetch.ts` 中新增自定义错误类，用于标识代理 CONNECT 阶段的失败：

```typescript
export class ProxyConnectError extends Error {
  constructor(
    public readonly statusCode: number | null,
    public readonly targetUrl: string,
    public readonly proxyHost: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProxyConnectError';
  }
}
```

在以下位置抛出 `ProxyConnectError` 替代普通 `Error`：

- `fetchViaProxy()` 中 CONNECT 响应非 200 时的 reject（第 303 行）
- `fetchViaProxy()` 中代理连接超时的 reject（第 271-275 行，`connectTimer` 回调）
- `fetchViaProxy()` 中 `proxyReq.on('error')` 的 reject（第 376 行，当有代理 URL 时）

对于 `fetchViaCurl()` 和 `proxyReq.on('error')`（无代理时的纯网络错误），保持原有行为（普通 Error），因为它们不一定是代理配置问题。

#### 2. 修改 `request-handler.ts` 错误处理

在 `handleAnthropicPassthrough()` 和 `handleOpenAIConversion()` 的 `catch` 块中，检测 `ProxyConnectError`：

```typescript
import { ProxyConnectError } from '../../services/proxy/proxy-fetch';

// 在 catch 块中：
if (error instanceof ProxyConnectError) {
  console.error(`[RequestHandler] Proxy CONNECT failed: ${error.message}`);
  return sendError(res, 'invalid_request_error', `Proxy connection failed: ${error.message}`);
}
```

关键改动：
- 错误类型从 `api_error`（→ HTTP 500）改为 `invalid_request_error`（→ HTTP 400）
- HTTP 400 在 Anthropic SDK 中是**非重试状态码**，SDK 会立即抛出错误
- **移除** `retry-after` header（或在 `sendError` 中对 4xx 不设置该 header），避免 SDK 被误导

#### 3. 调整 `sendError()` 函数

修改 `sendError()` 使其对 4xx 错误不设置 `retry-after` header：

```typescript
function sendError(res: ExpressResponse, errorType: string, message: string): void {
  const status = ERROR_STATUS_MAP[errorType] || 500;
  // Only set retry-after for 5xx (server/overload) errors — 4xx are non-retryable
  if (status >= 500) {
    res.setHeader('retry-after', '3');
  }
  // ... rest unchanged
}
```

#### 4. `send-message-local.ts` 无需改动

现有的代理错误增强逻辑（第 781-798 行）已能正确匹配 `Proxy CONNECT failed` 模式。修复后 SDK 会立即将错误传到主进程，该增强逻辑仍然生效。

#### 5. i18n（可选）

如果需要在前端区分"代理配置错误"和"API 服务器错误"，可新增 i18n key。但当前方案中错误消息已由 `send-message-local.ts` 的增强逻辑处理为用户友好文本，暂不需要新增 i18n。

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 代理连接实现 | `src/main/services/proxy/proxy-fetch.ts` | CONNECT 隧道实现、错误抛出点、`ProxyConnectError` 新增位置 |
| 请求处理器 | `src/main/openai-compat-router/server/request-handler.ts` | `sendError()` 函数、`catch` 块中代理错误的识别与处理 |
| 错误增强逻辑 | `src/main/services/agent/send-message-local.ts` | 第 781-798 行代理错误增强，确认无需改动 |
| SDK 重试行为 | `src/main/services/agent/stream-processor.ts` | 理解 SDK 错误传播路径 |
| 前置修复 | `.project/prd/bugfix/chat/bugfix-agent-network-timeout-feedback-v1.md` | 理解前一个修复的上下文和局限 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、错误处理规范 |

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `src/main/services/proxy/proxy-fetch.ts` | 修改：新增 `ProxyConnectError` 类，CONNECT 失败时抛出该类 |
| `src/main/openai-compat-router/server/request-handler.ts` | 修改：catch 中识别 `ProxyConnectError`，返回 400 而非 500；`sendError()` 对 4xx 不设置 `retry-after` |

## 验收标准

- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] 构建通过（`npm run build`）
- [ ] 代理 CONNECT 失败时，SDK 不再重试，立即返回错误（从 ~250s 降至 ~10s）
- [ ] 代理正常工作时，不影响正常对话流程
- [ ] 非代理网络错误（如 ECONNREFUSED、ETIMEDOUT）仍走原有逻辑
- [ ] `sendError()` 对 4xx 错误不设置 `retry-after` header
- [ ] `sendError()` 对 5xx 错误仍设置 `retry-after` header（行为不变）
- [ ] 错误消息在前端仍然显示为用户友好的代理错误提示
