# 变更记录 — 请求路由

> 所属模块：modules/openai-compat-router

## 变更

| 日期 | 类型 | 说明 | PRD |
|------|------|------|-----|
| 2026-05-22 | 修复 | `detectBackendType()` 新增 `/v1/messages` 和 `/messages` 后缀识别，避免 Anthropic 兼容后端被误判为 OpenAI 兼容；`sendError()` 移除硬编码 `retry-after: 3`，改为可选透传上游值；`handleAnthropicPassthrough()` 移除 `retry-after` 覆盖，依赖 `forwardResponseHeaders` 透传；`handleOpenAIConversion()` 用 `getErrorTypeFromStatus()` 确保错误类型为 Anthropic 标准格式；请求队列从互斥锁改为信号量（默认 3 并发，`ROUTER_MAX_CONCURRENT_REQUESTS` 可调）；请求队列新增 30 秒等待超时（`QUEUE_WAIT_TIMEOUT_MS`），超时自动拒绝 | [bugfix-openai-compat-router-reliability-v1](../../../prd/bugfix/remote-agent/bugfix-openai-compat-router-reliability-v1.md) |
| 2026-05-18 | 修复 | 代理 CONNECT 失败时返回 HTTP 400（不可重试）替代 HTTP 500，防止 SDK 重试循环导致 250 秒延迟；`sendError()` 对 4xx 不设置 `retry-after` | [bugfix-proxy-connect-failed-v1](../../../prd/bugfix/chat/bugfix-proxy-connect-failed-v1.md) |
| 2026-05-10 | 修复 | `fetchUpstream` 和 `fetchAnthropicUpstream` 改用 `proxyFetch`，LLM 推理请求走用户配置的网络代理 | [proxy-llm-inference-v1](../../../prd/bugfix/proxy-llm-inference-v1.md) |
| 2026-04-17 | 新功能 | 初始设计 | 无（从现有代码逆向生成） |
