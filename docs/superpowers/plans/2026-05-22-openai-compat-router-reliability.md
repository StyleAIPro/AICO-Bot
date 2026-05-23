# OpenAI 兼容路由器可靠性修复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复远程 Agent Proxy 的 OpenAI 兼容路由器在路由识别、SDK 重试、请求队列和超时保护方面的可靠性问题

**架构：** 三处独立修改：1) `detectBackendType()` 新增 `/v1/messages` 启发式规则；2) `request-handler.ts` 移除 retry-after 覆盖并标准化错误格式；3) `request-queue.ts` 从互斥锁重写为信号量模式。三处互相独立，可按任意顺序实现。

**技术栈：** TypeScript, Express, Node.js 原生 fetch

---

### 任务 1：路由识别 — detectBackendType() 新增 /v1/messages 规则

**文件：**
- 修改：`packages/remote-agent-proxy/src/claude-manager.ts:783-793`

- [ ] **步骤 1：修改 detectBackendType() 新增启发式规则**

在 `packages/remote-agent-proxy/src/claude-manager.ts` 的 `detectBackendType()` 方法中，在 `if (baseUrl.includes('/anthropic'))` 之后、`return 'openai_compat'` 之前，新增两条规则：

```typescript
private detectBackendType(baseUrl?: string): 'anthropic' | 'openai_compat' {
  // Explicit override via env var (e.g., for Anthropic-compatible proxies)
  if (process.env.REMOTE_AGENT_API_TYPE === 'anthropic_passthrough') return 'anthropic'
  // No custom URL = default Anthropic
  if (!baseUrl) return 'anthropic'
  // Known Anthropic URLs (including Dashscope Claude-as-a-Service /apps/anthropic)
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
  if (baseUrl.includes('/anthropic')) return 'anthropic'
  // Anthropic standard endpoint: /v1/messages or /messages
  if (baseUrl.endsWith('/v1/messages') || baseUrl.endsWith('/messages')) return 'anthropic'
  // Everything else is treated as OpenAI-compatible
  return 'openai_compat'
}
```

**注意事项：** `endsWith` 而非 `includes`——避免误匹配（如 `https://my-api.com/v1/messages-proxy` 不应匹配）。

- [ ] **步骤 2：验证构建通过**

运行：`cd packages/remote-agent-proxy && npx tsc --noEmit`（如果项目没有独立 tsconfig，用根目录 `npm run typecheck`）
预期：无类型错误

- [ ] **步骤 3：Commit**

```bash
git add packages/remote-agent-proxy/src/claude-manager.ts
git commit -m "fix(router): detectBackendType 识别 /v1/messages 端点为 Anthropic 协议

- 新增 /v1/messages 和 /messages 后缀匹配
- 避免 Anthropic 兼容后端被误判为 OpenAI 兼容
- PRD: .project/prd/bugfix/remote-agent/bugfix-openai-compat-router-reliability-v1.md"
```

---

### 任务 2：重试机制 — 移除 retry-after 覆盖 + 错误格式标准化

**文件：**
- 修改：`packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts`

此任务分两个子步骤：先删除 retry-after 覆盖，再标准化错误格式。

- [ ] **步骤 1：sendError() 移除 retry-after 强制覆盖**

修改 `sendError()` 函数（约 line 112-128），删除 `res.setHeader('retry-after', '3')` 行。函数变为：

```typescript
function sendError(
  res: ExpressResponse,
  errorType: string,
  message: string
): void {
  const status = ERROR_STATUS_MAP[errorType] || 500
  console.log(`[RequestHandler] Sending error: HTTP ${status} ${errorType} - ${message.slice(0, 100)}`)

  res.status(status)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('request-id', `req_${Date.now()}`)
  res.json({
    type: 'error',
    error: { type: errorType, message }
  })
}
```

- [ ] **步骤 2：handleAnthropicPassthrough() 移除 retry-after 覆盖**

修改 `handleAnthropicPassthrough()` 中约 line 298-300 的错误处理块，删除 `res.setHeader('retry-after', '3')` 行。变为：

```typescript
    if (!upstreamResp.ok) {
      const errorText = await upstreamResp.text().catch(() => '')
      console.error(`[RequestHandler] Anthropic error ${upstreamResp.status}: ${errorText.slice(0, 200)}`)

      res.status(upstreamResp.status)
      forwardResponseHeaders(upstreamResp, res)
      res.end(errorText)
      return
    }
```

**说明：** `forwardResponseHeaders()` 已经透传上游所有响应头（包括 `retry-after`），无需额外设置。

- [ ] **步骤 3：handleOpenAIConversion() 错误响应标准化**

修改 `handleOpenAIConversion()` 中约 line 422-456 的错误处理块。当前 `getUpstreamError()` 已经能把 OpenAI 格式和 Anthropic 格式的错误解析为 `{ type, message }`，但返回的 `type` 可能是上游的原始值（如 `"rate_limit_exceeded"`），不是 Anthropic 标准类型。需要用已有的 `getErrorTypeFromStatus()` 覆盖为标准类型。

将 `getUpstreamError()` 的返回值中的 `type` 替换为基于 HTTP 状态码的标准 Anthropic 错误类型：

找到约 line 425-426：

```typescript
        const { type: errorType, message: errorMessage } = getUpstreamError(upstreamResp.status, errorText)
        console.error(`[RequestHandler] Provider error ${upstreamResp.status}: ${errorText.slice(0, 200)}`)
```

替换为：

```typescript
        const { message: errorMessage } = getUpstreamError(upstreamResp.status, errorText)
        const errorType = getErrorTypeFromStatus(upstreamResp.status)
        console.error(`[RequestHandler] Provider error ${upstreamResp.status} (${errorType}): ${errorText.slice(0, 200)}`)
```

同样修改 retry 分支中约 line 449-450 的同样模式：

```typescript
            const { message: retryErrorMessage } = getUpstreamError(upstreamResp.status, retryErrorText)
            const retryErrorType = getErrorTypeFromStatus(upstreamResp.status)
            console.error(`[RequestHandler] Provider error ${upstreamResp.status} (${retryErrorType}): ${retryErrorText.slice(0, 200)}`)
```

**说明：** `getErrorTypeFromStatus()` 已经在此文件中定义（line 78-80），并且 `STATUS_ERROR_MAP`（line 64-73）已包含完整的 429→`rate_limit_error`、529→`overloaded_error`、401→`authentication_error` 映射。无需新增函数，只需用已有的映射确保 type 是标准值。

- [ ] **步骤 4：sendError() 中透传上游 retry-after（当可用时）**

`sendError()` 目前无法接收上游的 retry-after 值。需要给 `sendError()` 增加可选的 `retryAfter` 参数：

```typescript
function sendError(
  res: ExpressResponse,
  errorType: string,
  message: string,
  retryAfter?: string
): void {
  const status = ERROR_STATUS_MAP[errorType] || 500
  console.log(`[RequestHandler] Sending error: HTTP ${status} ${errorType} - ${message.slice(0, 100)}`)

  res.status(status)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('request-id', `req_${Date.now()}`)
  if (retryAfter) {
    res.setHeader('retry-after', retryAfter)
  }
  res.json({
    type: 'error',
    error: { type: errorType, message }
  })
}
```

**不要修改其他调用 `sendError()` 的地方**——它们在超时和内部错误场景中没有上游 retry-after，不传即可。

- [ ] **步骤 5：在 handleOpenAIConversion 的错误分支透传上游 retry-after**

在 `handleOpenAIConversion()` 的第一个错误分支（约 line 422-455），从上游响应中提取 `retry-after`：

```typescript
      if (!upstreamResp.ok) {
        const errorText = await upstreamResp.text().catch(() => '')
        const { message: errorMessage } = getUpstreamError(upstreamResp.status, errorText)
        const errorType = getErrorTypeFromStatus(upstreamResp.status)
        const retryAfter = upstreamResp.headers.get('retry-after') || undefined
        console.error(`[RequestHandler] Provider error ${upstreamResp.status} (${errorType}): ${errorText.slice(0, 200)}`)

        // Check if upstream requires stream=true, retry if needed
        const errorLower = errorText?.toLowerCase() || ''
        const requiresStream = errorLower.includes('stream must be set to true') ||
                               (errorLower.includes('non-stream') && errorLower.includes('not supported'))

        if (requiresStream && !wantStream) {
          console.warn('[RequestHandler] Upstream requires stream=true, retrying...')

          // Retry with stream enabled
          wantStream = true
          const retryRequest = apiType === 'responses'
            ? convertAnthropicToOpenAIResponses({ ...anthropicRequest, stream: true }).request
            : convertAnthropicToOpenAIChat({ ...anthropicRequest, stream: true }).request

          // Re-apply provider adapter to retry request (reuse same headers)
          applyProviderAdapter(backendUrl, retryRequest as unknown as Record<string, unknown>, requestHeaders)

          upstreamResp = await fetchUpstream(backendUrl, apiKey, retryRequest, timeoutMs, undefined, requestHeaders)

          if (!upstreamResp.ok) {
            const retryErrorText = await upstreamResp.text().catch(() => '')
            const { message: retryErrorMessage } = getUpstreamError(upstreamResp.status, retryErrorText)
            const retryErrorType = getErrorTypeFromStatus(upstreamResp.status)
            const retryAfterRetry = upstreamResp.headers.get('retry-after') || undefined
            console.error(`[RequestHandler] Provider error ${upstreamResp.status} (${retryErrorType}): ${retryErrorText.slice(0, 200)}`)
            return sendError(res, retryErrorType, retryErrorMessage, retryAfterRetry)
          }
        } else {
          return sendError(res, errorType, errorMessage, retryAfter)
        }
      }
```

- [ ] **步骤 6：验证构建通过**

运行：`npm run typecheck`
预期：无类型错误

- [ ] **步骤 7：Commit**

```bash
git add packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts
git commit -m "fix(router): 移除 retry-after 强制覆盖，错误类型标准化透传上游值

- sendError() 移除硬编码 retry-after=3，改为可选透传
- handleAnthropicPassthrough() 移除 retry-after 覆盖，依赖 forwardResponseHeaders
- handleOpenAIConversion() 用 getErrorTypeFromStatus 确保标准错误类型
- 上游 retry-after 透传给 SDK，让 SDK 自行决定退避策略
- PRD: .project/prd/bugfix/remote-agent/bugfix-openai-compat-router-reliability-v1.md"
```

---

### 任务 3：请求队列 — 互斥锁重写为信号量

**文件：**
- 重写：`packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts`

- [ ] **步骤 1：重写 request-queue.ts 为信号量模式**

将 `packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts` 完整替换为：

```typescript
/**
 * Request Queue — Semaphore with wait timeout
 *
 * Limits concurrent requests per backend (keyed by backendUrl + apiKey).
 * Replaces the previous mutex (1 concurrent) with a configurable semaphore
 * to allow sub-agent parallelism while preventing rate limit saturation.
 */

interface QueueState {
  running: number
  waiting: Array<{
    resolve: (value: void) => void
    reject: (reason: Error) => void
    enqueuedAt: number
  }>
}

const requestQueues = new Map<string, QueueState>()

const MAX_CONCURRENT_PER_KEY = Number(process.env.ROUTER_MAX_CONCURRENT_REQUESTS) || 3
const QUEUE_WAIT_TIMEOUT_MS = 30_000

/**
 * Execute a function with concurrency-limited queue protection.
 *
 * Allows up to MAX_CONCURRENT_PER_KEY concurrent requests per key.
 * Excess requests wait up to QUEUE_WAIT_TIMEOUT_MS before rejecting.
 */
export async function withRequestQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const limit = MAX_CONCURRENT_PER_KEY

  let queue = requestQueues.get(key)
  if (!queue) {
    queue = { running: 0, waiting: [] }
    requestQueues.set(key, queue)
  }

  // Concurrent slot available — execute immediately
  if (queue.running < limit) {
    queue.running++
    try {
      return await fn()
    } finally {
      releaseSlot(key, queue)
    }
  }

  // No slot available — enqueue with timeout
  return new Promise<T>((resolve, reject) => {
    queue!.waiting.push({
      resolve: resolve as (value: void) => void,
      reject,
      enqueuedAt: Date.now(),
    })
  })
}

function releaseSlot(key: string, queue: QueueState): void {
  queue.running--
  drainWaiting(key, queue)
}

function drainWaiting(key: string, queue: QueueState): void {
  while (queue.waiting.length > 0 && queue.running < MAX_CONCURRENT_PER_KEY) {
    const waiter = queue.waiting.shift()!

    // Reject if waited too long
    if (Date.now() - waiter.enqueuedAt > QUEUE_WAIT_TIMEOUT_MS) {
      waiter.reject(new Error(`Request queue timeout: waited >${QUEUE_WAIT_TIMEOUT_MS / 1000}s for ${key}`))
      continue
    }

    queue.running++
    // Execute the caller's fn outside of drainWaiting — but we need fn here.
    // Since withRequestQueue wraps fn in a Promise, we resolve the waiter's promise
    // and the actual fn execution happens in the caller's await chain.
    //
    // Wait — this design is wrong. We need the fn reference.
    // Let's fix: store fn + waiter together in the waiting list.
    waiter.resolve()
  }
}
```

**等等——上面的设计有 bug**：`drainWaiting` 无法获取 `fn` 来执行。需要将 `fn` 和 waiter 一起存储。以下是正确的完整实现：

```typescript
/**
 * Request Queue — Semaphore with wait timeout
 *
 * Limits concurrent requests per backend (keyed by backendUrl + apiKey).
 * Replaces the previous mutex (1 concurrent) with a configurable semaphore
 * to allow sub-agent parallelism while preventing rate limit saturation.
 */

interface Waiter<T> {
  fn: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
  enqueuedAt: number
}

interface QueueState {
  running: number
  waiting: Array<Waiter<unknown>>
}

const requestQueues = new Map<string, QueueState>()

const MAX_CONCURRENT_PER_KEY = Number(process.env.ROUTER_MAX_CONCURRENT_REQUESTS) || 3
const QUEUE_WAIT_TIMEOUT_MS = 30_000

/**
 * Execute a function with concurrency-limited queue protection.
 *
 * Allows up to MAX_CONCURRENT_PER_KEY concurrent requests per key.
 * Excess requests wait up to QUEUE_WAIT_TIMEOUT_MS before rejecting.
 */
export async function withRequestQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const limit = MAX_CONCURRENT_PER_KEY

  let queue = requestQueues.get(key)
  if (!queue) {
    queue = { running: 0, waiting: [] }
    requestQueues.set(key, queue)
  }

  // Concurrent slot available — execute immediately
  if (queue.running < limit) {
    queue.running++
    try {
      return await fn()
    } finally {
      releaseSlot(key, queue)
    }
  }

  // No slot available — enqueue with timeout
  return new Promise<T>((resolve, reject) => {
    queue!.waiting.push({ fn, resolve, reject, enqueuedAt: Date.now() })
  })
}

function releaseSlot(key: string, queue: QueueState): void {
  queue.running--
  drainWaiting(key, queue)
}

function drainWaiting(key: string, queue: QueueState): void {
  while (queue.waiting.length > 0 && queue.running < MAX_CONCURRENT_PER_KEY) {
    const waiter = queue.waiting.shift()!

    // Reject if waited too long
    if (Date.now() - waiter.enqueuedAt > QUEUE_WAIT_TIMEOUT_MS) {
      waiter.reject(new Error(`Request queue timeout: waited >${QUEUE_WAIT_TIMEOUT_MS / 1000}s for ${key}`))
      continue
    }

    queue.running++
    // Execute the stored function
    waiter.fn()
      .then(waiter.resolve)
      .catch(waiter.reject)
      .finally(() => releaseSlot(key, queue))
  }
}

/**
 * Generate a queue key from backend URL and API key
 */
export function generateQueueKey(backendUrl: string, apiKey: string): string {
  return `${backendUrl}:${apiKey.slice(0, 16)}`
}

/**
 * Clear all pending requests (for testing)
 */
export function clearRequestQueues(): void {
  requestQueues.clear()
}

/**
 * Get the number of pending requests (for monitoring)
 */
export function getPendingRequestCount(): number {
  return requestQueues.size
}
```

**关键设计决策：**
- `fn` 和 waiter 一起存储在 waiting list 中，`drainWaiting` 可以直接执行
- `releaseSlot` 触发 `drainWaiting`，自动激活等待中的请求
- 超时检查在 `drainWaiting` 时执行，而非定时器，减少开销
- `generateQueueKey`、`clearRequestQueues`、`getPendingRequestCount` 接口不变，调用方无需修改

- [ ] **步骤 2：验证构建通过**

运行：`npm run typecheck`
预期：无类型错误

- [ ] **步骤 3：Commit**

```bash
git add packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts
git commit -m "fix(router): 请求队列从互斥锁改为信号量，支持并发和等待超时

- 默认允许 3 个并发请求（ROUTER_MAX_CONCURRENT_REQUESTS 可调）
- 排队等待超过 30 秒自动拒绝（QUEUE_WAIT_TIMEOUT_MS）
- releaseSlot 时自动触发等待队列 drain
- 保持 generateQueueKey/clearRequestQueues/getPendingRequestCount 接口不变
- PRD: .project/prd/bugfix/remote-agent/bugfix-openai-compat-router-reliability-v1.md"
```

---

### 任务 4：构建验证 + 文档更新

**文件：**
- 修改：`.project/modules/openai-compat-router/features/request-routing/changelog.md`

- [ ] **步骤 1：运行完整构建验证**

```bash
npm run typecheck && npm run build
```
预期：全部通过

- [ ] **步骤 2：更新功能 changelog**

在 `.project/modules/openai-compat-router/features/request-routing/changelog.md` 追加：

```markdown
## 2026-05-22 — 路由器可靠性修复

- `detectBackendType()` 新增 `/v1/messages` 和 `/messages` 后缀识别，避免 Anthropic 兼容后端被误判为 OpenAI 兼容
- `sendError()` 移除硬编码 `retry-after: 3`，改为可选透传上游值
- `handleAnthropicPassthrough()` 移除 `retry-after` 覆盖，依赖 `forwardResponseHeaders` 透传
- `handleOpenAIConversion()` 用 `getErrorTypeFromStatus()` 确保错误类型为 Anthropic 标准格式
- 请求队列从互斥锁改为信号量（默认 3 并发，`ROUTER_MAX_CONCURRENT_REQUESTS` 可调）
- 请求队列新增 30 秒等待超时（`QUEUE_WAIT_TIMEOUT_MS`），超时自动拒绝
```

- [ ] **步骤 3：Commit**

```bash
git add .project/modules/openai-compat-router/features/request-routing/changelog.md
git commit -m "docs(router): 更新 request-routing changelog"
```

---

### 任务 5：PRD 状态更新

- [ ] **步骤 1：将 PRD 状态改为 done**

修改 `.project/prd/bugfix/remote-agent/bugfix-openai-compat-router-reliability-v1.md`：

```yaml
**状态**: done
```

并确认验收标准全部打勾。

- [ ] **步骤 2：Commit**

```bash
git add .project/prd/bugfix/remote-agent/bugfix-openai-compat-router-reliability-v1.md
git commit -m "docs(prd): openai-compat-router-reliability 标记为 done"
```
