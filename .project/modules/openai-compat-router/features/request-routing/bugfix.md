# Bug 记录 — 请求路由

> 所属模块：modules/openai-compat-router

## Bug 列表

| ID | 状态 | 描述 | 修复 | PRD |
|----|------|------|------|-----|
| BF-003 | 已修复 | 网络错误（fetch failed、ECONNRESET 等）直接返回 500 给 SDK，Router 层无重试，导致 SDK 层高代价重试 30-60 秒 | `request-handler.ts` 新增 `isRetryableNetworkError()` + catch 块网络错误快速重试（最多 2 次，1s/2s 指数退避） | [bugfix-router-network-retry-v1](../../../../prd/bugfix/openai-compat-router/bugfix-router-network-retry-v1.md) |
