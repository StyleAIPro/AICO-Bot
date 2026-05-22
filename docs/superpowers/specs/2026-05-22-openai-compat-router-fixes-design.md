# OpenAI 兼容路由器修复设计

日期：2026-05-22
状态：draft
作者：Claude

## 背景

远程 Agent Proxy 的 OpenAI 兼容路由器（`packages/remote-agent-proxy/src/openai-compat-router/`）存在以下问题：

1. **路由识别不完善**：`detectBackendType()` 仅通过 URL 含 `/anthropic` 或 `api.anthropic.com` 判断为 Anthropic 协议。提供 `/v1/messages` 端点的 Anthropic 兼容后端（自定义路径）会被误判为 OpenAI 兼容，导致格式转换错误
2. **SDK 重试机制被干扰**：`retry-after` 被强制覆盖为 3 秒；非标准错误格式直接透传，SDK 无法识别错误类型，重试逻辑失效
3. **请求队列过度串行化**：同一 backendUrl + apiKey 的请求严格串行，子代理并行能力丧失，排队请求更容易触发限流
4. **缺少等待超时保护**：请求在队列中无限等待，可能长时间阻塞

## 修复方案

方案：A + 预留扩展（启发式识别 + 针对性修复 + 预留前端配置字段）

### 1. 路由识别修复

**文件：** `packages/remote-agent-proxy/src/claude-manager.ts`

`detectBackendType()` 新增启发式规则：

```typescript
private detectBackendType(baseUrl?: string): 'anthropic' | 'openai_compat' {
  if (process.env.REMOTE_AGENT_API_TYPE === 'anthropic_passthrough') return 'anthropic'
  if (!baseUrl) return 'anthropic'
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
  if (baseUrl.includes('/anthropic')) return 'anthropic'
  // 新增：Anthropic 标准端点识别
  if (baseUrl.endsWith('/v1/messages') || baseUrl.endsWith('/messages')) return 'anthropic'
  return 'openai_compat'
}
```

**不改动 `normalizeApiUrl` 和 `getApiTypeFromUrl`**——正确识别为 `anthropic` 后，这两个函数不会被调用。

### 2. 重试机制修复

**文件：** `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts`

核心原则：**router 是透明代理 + 格式翻译器，不干预 SDK 的重试决策**。

#### 2.1 删除 retry-after 强制覆盖

删除 `sendError()` 和 `handleAnthropicPassthrough()` 中的 `res.setHeader('retry-after', '3')`。改为透传上游的 `retry-after` 值。

#### 2.2 错误响应标准化

OpenAI 转换路径（`handleOpenAIConversion`）的错误处理改为：

```typescript
if (!upstreamResp.ok) {
  const errorText = await upstreamResp.text()
  res.status(upstreamResp.status)
  forwardResponseHeaders(upstreamResp, res)  // 透传上游所有头（含 retry-after）
  res.setHeader('Content-Type', 'application/json')

  try {
    const parsed = JSON.parse(errorText)
    if (parsed.type === 'error' && parsed.error) {
      // 已是 Anthropic 标准格式，原样返回
      res.end(errorText)
    } else {
      // 非 Anthropic 格式（OpenAI 等），包装为标准格式
      res.json({
        type: 'error',
        error: { type: mapErrorType(upstreamResp.status), message: parsed.error?.message || errorText.slice(0, 500) }
      })
    }
  } catch {
    res.json({ type: 'error', error: { type: 'api_error', message: errorText.slice(0, 500) } })
  }
}
```

新增 `mapErrorType()` 辅助函数：

```typescript
function mapErrorType(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}
```

SDK 收到标准格式错误后，能正确触发内部重试：
- 429 `rate_limit_error` → exponential backoff
- 529 `overloaded_error` → 重试
- 401 `authentication_error` → 报告 `api_retry` 事件给 proxy 层处理

### 3. 请求队列优化

**文件：** `packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts`

从互斥锁改为信号量模式，允许配置并发数。

```typescript
const requestQueues = new Map<string, { running: number; waiting: Array<{ resolve: () => void; reject: (err: Error) => void; enqueuedAt: number }> }>()

const MAX_CONCURRENT_PER_KEY = Number(process.env.ROUTER_MAX_CONCURRENT_REQUESTS) || 3
const QUEUE_WAIT_TIMEOUT_MS = 30_000  // 等待超过 30 秒放弃

export async function withRequestQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const limit = MAX_CONCURRENT_PER_KEY

  // 获取或创建队列状态
  let queue = requestQueues.get(key)
  if (!queue) {
    queue = { running: 0, waiting: [] }
    requestQueues.set(key, queue)
  }

  // 有并发余量，直接执行
  if (queue.running < limit) {
    queue.running++
    try { return await fn() }
    finally { releaseSlot(key, queue) }
  }

  // 排队等待
  return new Promise<T>((resolve, reject) => {
    queue!.waiting.push({ resolve, reject, enqueuedAt: Date.now() })
    pollQueue(key, queue!, fn)
  })
}

function pollQueue<T>(key: string, queue: QueueState, fn: () => Promise<T>): void {
  const check = () => {
    if (queue.running < MAX_CONCURRENT_PER_KEY && queue.waiting.length > 0) {
      const waiter = queue.waiting.shift()!
      // 等待超时检查
      if (Date.now() - waiter.enqueuedAt > QUEUE_WAIT_TIMEOUT_MS) {
        waiter.reject(new Error(`Request queue timeout for key ${key}`))
        check()  // 检查下一个
        return
      }
      queue.running++
      fn()
        .then(result => waiter.resolve(result as T))
        .catch(err => waiter.reject(err))
        .finally(() => { releaseSlot(key, queue); check() })
    }
  }
  // 轮询（通过 setInterval 或在 releaseSlot 中触发）
}
```

环境变量：
- `ROUTER_MAX_CONCURRENT_REQUESTS`：默认 3，每个 backendUrl + apiKey 的最大并发数

### 4. 队列等待超时

已包含在上述信号量实现中。请求排队超过 30 秒后直接拒绝，返回错误给 SDK。

### 5. 预留前端配置扩展

**不本次实现，仅预留数据结构。**

- `BackendConfig.apiType` 已支持 `'chat_completions' | 'responses' | 'anthropic_passthrough'`
- 前端 AI Source 配置中预留 `apiProtocol` 字段（`'auto' | 'anthropic' | 'openai'`）
- 远程接收后优先使用前端传来的值，无则走启发式判断

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改：`detectBackendType()` 新增规则 |
| `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 修改：删除 retry-after 覆盖，错误格式标准化 |
| `packages/remote-agent-proxy/src/openai-compat-router/server/request-queue.ts` | 重写：互斥锁 → 信号量 + 等待超时 |

## 验收标准

- [ ] URL 以 `/v1/messages` 结尾的后端被正确识别为 Anthropic 协议，走透传
- [ ] `retry-after` 透传上游原始值，不被覆盖
- [ ] 非 Anthropic 格式的错误响应被包装为标准格式，SDK 能识别并重试
- [ ] 同一后端允许 3 个并发请求（可通过环境变量调整）
- [ ] 请求排队超过 30 秒后返回超时错误
- [ ] 现有 OpenAI 兼容后端（DeepSeek、Groq、vLLM 等）不受影响
- [ ] 现有 Anthropic 透传后端（含 `/anthropic` 路径的）不受影响
