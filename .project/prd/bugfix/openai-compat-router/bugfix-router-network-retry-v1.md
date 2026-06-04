# Bugfix: Router 层网络错误重试

**版本**: v1
**模块**: openai-compat-router / request-routing
**功能**: Anthropic 直通模式网络错误重试
**日期**: 2026-06-02
**状态**: done
**指令人**: misakamikoto
**优先级**: P1
**类型**: bugfix

## 问题描述

Router 层（openai-compat-router）对上游 Anthropic API 的请求在网络不稳定时，遇到 "fetch failed"、ECONNRESET、ETIMEDOUT 等网络错误直接返回 HTTP 500 `api_error` 给 Claude SDK，没有在 Router 层重试。SDK 收到 500 后内部重试（最多 10 次），每次重试间隔较长（指数退避），导致用户感知延迟很大（可达 30-60 秒）。

上游代理（Tailscale 内网地址 100.102.191.165:1090）不稳定，连接经常 50-60 秒才响应，有时直接断开。这类瞬时网络故障在 Router 层快速重试即可恢复，无需让 SDK 层以完整请求链路重试。

## 问题根因

### 1. `handleAnthropicPassthrough()` 的 catch 块不区分错误类型

文件 `src/main/openai-compat-router/server/request-handler.ts` 第 423-437 行：

```typescript
catch (error: any) {
  if (error?.name === 'AbortError') {
    // ... 超时处理
    return sendError(res, 'timeout_error', 'Request timed out');
  }
  if (error instanceof ProxyConnectError) {
    // ... 代理配置错误（不可重试）
    return sendError(res, 'invalid_request_error', `Proxy connection failed: ${error.message}`);
  }
  // 网络错误也走这个分支 — 直接返回 500 api_error
  console.error('[RequestHandler] Anthropic passthrough error:', error?.message || error);
  return sendError(res, 'api_error', error?.message || 'Internal error');
}
```

`fetchAnthropicUpstream()` 内部调用 `proxyFetch()`，当网络层抛出 "fetch failed"、ECONNRESET、ETIMEDOUT 等错误时，这些错误全部落入最后一个 catch-all 分支，返回 HTTP 500 `api_error`。SDK 收到 500 后认为服务端异常，触发内部重试。

### 2. SDK 层重试代价高

SDK 层的重试需要重新走完整链路：
- 重新构建请求（含完整 messages 历史、工具定义）
- 重新通过 Router 层（含拦截器、队列、代理配置）
- 每次重试的退避间隔由 SDK 内部管理（通常 3-15 秒甚至更长）
- 最多重试 10 次，用户可能等 30-60 秒才看到结果

而 Router 层重试只需重新发起一次 HTTP fetch，代价极低（1-2 秒即可完成）。

### 3. 现有 `error-classifier.ts` 已有网络错误识别能力

文件 `src/main/services/agent/error-classifier.ts` 定义了 `NETWORK_ERROR_CODES`（ECONNREFUSED、ETIMEDOUT、ECONNRESET 等）和 `NETWORK_ERROR_KEYWORDS`（"fetch failed"、"socket hang up" 等），但这些仅用于用户错误提示分类，未在 Router 层用于重试决策。

## 技术方案

### 核心思路

在 `handleAnthropicPassthrough()` 的 catch 块中，区分可重试的网络错误和不可重试的逻辑错误。对网络错误进行快速重试（Router 层重试），避免 SDK 层的高代价重试。

### 1. 新增网络错误判断函数

在 `request-handler.ts` 中新增辅助函数：

```typescript
/**
 * 判断错误是否为可重试的瞬时网络错误。
 * 包括：fetch failed、ECONNRESET、ETIMEDOUT、ENOTFOUND、socket hang up 等。
 * 不包括：AbortError（超时/用户取消）、ProxyConnectError（代理配置错误）。
 */
function isRetryableNetworkError(error: unknown): boolean {
  const err = error as Error | null;
  if (!err) return false;

  const message = err.message || '';
  const code = (err as NodeJS.ErrnoException)?.code || '';

  // Node.js 错误码
  const RETRYABLE_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EPIPE',
    'EHOSTUNREACH',
    'EAI_AGAIN',
  ]);

  if (RETRYABLE_CODES.has(code)) return true;

  // 消息关键词匹配
  const RETRYABLE_KEYWORDS = [
    'fetch failed',
    'socket hang up',
    'connect ETIMEDOUT',
    'network',
    'EPROTO',
  ];

  return RETRYABLE_KEYWORDS.some((kw) => message.includes(kw));
}
```

### 2. 在 `handleAnthropicPassthrough()` 的 catch 块增加重试逻辑

在现有的 `AbortError` 和 `ProxyConnectError` 分支之后，新增网络错误重试分支：

```typescript
catch (error: unknown) {
  // 1. 超时/用户取消 — 不可重试
  if (isAbortError(error)) {
    return sendError(res, 'timeout_error', 'Request timed out');
  }

  // 2. 代理配置错误 — 不可重试
  if (error instanceof ProxyConnectError) {
    return sendError(res, 'invalid_request_error', `Proxy connection failed: ${error.message}`);
  }

  // 3. 可重试的网络错误 — Router 层快速重试
  if (isRetryableNetworkError(error)) {
    const maxRetries = 2; // 最多重试 2 次（共 3 次尝试）
    let lastError = error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 4000); // 1s, 2s
      console.log(
        `[RequestHandler] Network error (attempt ${attempt}/${maxRetries}), ` +
        `retrying in ${delayMs}ms: ${(lastError as Error).message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      try {
        const retryResp = await fetchAnthropicUpstream(
          targetUrl, apiKey, fetchBody, timeoutMs, sdkHeaders, customHeaders, useProxy,
        );
        console.log(`[RequestHandler] Network retry ${attempt} result: ${retryResp.status}`);

        if (retryResp.ok) {
          // 重试成功 — 走正常响应处理（stream / non-stream）
          // ...（复用现有的响应处理逻辑）
          return;
        }
        // 重试得到 HTTP 响应但非 2xx — 不再重试，返回给 SDK
        const errorText = await retryResp.text().catch(() => '');
        res.status(retryResp.status);
        forwardResponseHeaders(retryResp, res);
        res.end(errorText);
        return;
      } catch (retryError: unknown) {
        lastError = retryError;
        if (!isRetryableNetworkError(retryError)) {
          // 非 network error — 不再重试
          break;
        }
      }
    }
    // 所有重试耗尽 — 返回 500 让 SDK 做最终兜底
    console.error(`[RequestHandler] All ${maxRetries} retries exhausted`);
    return sendError(res, 'api_error', (lastError as Error)?.message || 'Network error after retries');
  }

  // 4. 其他未知错误 — 不可重试
  return sendError(res, 'api_error', (error as Error)?.message || 'Internal error');
}
```

### 3. 重试参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 最大重试次数 | 2 次（共 3 次尝试） | 覆盖大多数瞬时网络故障 |
| 退避策略 | 1s、2s（指数退避，上限 4s） | 快速重试，不过度等待 |
| 总最大等待 | ~3s（不含请求本身时间） | 用户几乎无感 |
| 每次请求超时 | 沿用 `timeoutMs`（默认 30 分钟） | 单次 fetch 超时不受影响 |

### 4. 可重试 vs 不可重试错误分类

| 类型 | 可重试 | 说明 |
|------|--------|------|
| fetch failed | 是 | 网络层连接失败 |
| ECONNRESET | 是 | 连接被远端重置 |
| ETIMEDOUT | 是 | 连接超时 |
| ECONNREFUSED | 是 | 目标拒绝连接（服务可能正在重启） |
| ENOTFOUND | 是 | DNS 解析失败（可能是瞬时 DNS 故障） |
| socket hang up | 是 | 连接意外断开 |
| EPIPE | 是 | 管道破裂 |
| AbortError | 否 | 超时或用户主动取消 |
| ProxyConnectError | 否 | 代理配置错误，重试无意义 |
| HTTP 4xx | 否 | 客户端错误（认证、参数等），重试无意义 |
| HTTP 429 | N/A | 已有独立重试逻辑，不受影响 |
| HTTP 5xx | N/A | 非 catch 场景，在 ok 检查中处理 |

### 5. 幂等性考虑

Anthropic Messages API 的请求是**非幂等**的（每次调用都会消耗 token），但：
- 网络错误（catch 块）意味着请求**根本没到达上游**，或上游响应**未完整返回**
- 对于 fetch failed / ECONNRESET 等错误，TCP 连接未建立成功，请求体不可能被上游处理
- 对于 ETIMEDOUT，请求可能已到达上游但响应丢失，存在极小概率的重复执行风险，但 Anthropic API 的 `api_retry` 系统事件（SDK 层）已处理了重复结果去重
- Router 层重试 2 次的额外风险可接受，远小于 SDK 层 10 次重试的风险

### 6. Body 可用性

`fetchBody` 变量在重试时始终可用：
- 如果使用 `rawBody`（Buffer），Buffer 可以多次使用
- 如果使用 `anthropicRequest`（对象），每次重试都会 `JSON.stringify`，对象未被消费
- 这与 429 重试逻辑使用同一变量，已有先例

### 7. 对现有 429 重试的影响

429 重试逻辑在 `upstreamResp.ok` 检查中（第 320-380 行），网络错误重试在 catch 块中（第 423-437 行）。两者互不干扰：
- 429 重试：fetch 成功返回 HTTP Response，但 status = 429
- 网络错误重试：fetch 抛出异常，无 HTTP Response

### 8. `handleOpenAIConversion()` 的考虑

OpenAI 转换模式（`handleOpenAIConversion()`）的 catch 块（第 620-635 行）也有类似问题，但：
- OpenAI 兼容后端（DeepSeek、Groq、Ollama 等）通常是本地或稳定服务
- 网络不稳定主要影响 Anthropic 上游（Tailscale 内网代理）
- 本 PRD 仅修复 `handleAnthropicPassthrough()`，OpenAI 转换模式可作为后续优化

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/openai-compat-router/server/request-handler.ts` | 逻辑修改 | 新增 `isRetryableNetworkError()` 辅助函数；`handleAnthropicPassthrough()` catch 块增加网络错误重试分支 |
| `.project/modules/openai-compat-router/features/request-routing/bugfix.md` | 文档更新 | 记录本次 bugfix |
| `.project/modules/openai-compat-router/features/request-routing/changelog.md` | 文档更新 | 记录本次变更 |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/openai-compat-router/openai-compat-router-v1.md` | 理解路由器整体架构和组件职责 |
| 功能设计文档 | `.project/modules/openai-compat-router/features/request-routing/design.md` | 理解请求路由子系统的设计和 429 重试逻辑 |
| 功能设计文档 | `.project/modules/openai-compat-router/features/stream-pipeline/design.md` | 理解流式管道如何与重试交互 |
| 前置 PRD | `.project/prd/bugfix/remote-agent/bugfix-openai-compat-router-reliability-v1.md` | 理解上一次路由器可靠性修复（retry-after 透传、错误标准化） |
| 源码文件 | `src/main/openai-compat-router/server/request-handler.ts` | **核心修改文件** — `handleAnthropicPassthrough()` 的错误处理和 429 重试逻辑 |
| 源码文件 | `src/main/services/proxy/proxy-fetch.ts` | 理解 `proxyFetch()` 的错误类型（AbortError、ProxyConnectError、普通网络错误） |
| 源码文件 | `src/main/services/agent/error-classifier.ts` | 参考已有的网络错误分类逻辑（`NETWORK_ERROR_CODES`、`NETWORK_ERROR_KEYWORDS`） |
| 源码文件 | `src/main/services/agent/process-stream.ts` | 理解 SDK 层的 `api_retry` 系统事件处理（第 1128-1166 行），确认 Router 层重试不会干扰 |
| 功能变更记录 | `.project/modules/openai-compat-router/features/request-routing/changelog.md` | 了解请求路由的历史变更，避免引入回归 |

## 验收标准

- [ ] 网络错误（fetch failed、ECONNRESET、ETIMEDOUT 等）时 Router 层自动重试最多 2 次，总退避约 3 秒
- [ ] 可重试错误（网络错误）和不可重试错误（AbortError、ProxyConnectError、其他）正确区分
- [ ] 现有 429 重试逻辑（`handleAnthropicPassthrough` 第 326-380 行）不受影响
- [ ] 重试成功后正确处理响应（streaming 和 non-streaming 两种模式）
- [ ] 重试耗尽后返回 HTTP 500 `api_error`，SDK 层可继续兜底重试
- [ ] `rawBody`（Buffer）和 `anthropicRequest`（对象）两种 body 格式在重试时均可正常使用
- [ ] 重试日志清晰（包含 attempt 次数、延迟、错误信息），便于排查
- [ ] `npm run typecheck` 通过（修改文件零新增错误）
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-06-02 | 初始 PRD | misakamikoto |
