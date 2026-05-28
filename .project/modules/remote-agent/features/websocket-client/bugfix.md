# Bug 记录 — websocket-client

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 0 |
| Minor | 0 |

## 已修复

### P0: 终止单个远程对话导致同服务器所有对话被终止（2026-05-14）

- **根因**：`interrupt()` 中 `activeStreamSessions.clear()` 和 `disconnect()` 不区分 session，`isInterrupted` 布尔标志屏蔽所有 session 事件
- **修复**：`isInterrupted` → `interruptedSessions` Set（per-session）；`interrupt()` 只拒绝目标 session；移除 `disconnect()`
- **PRD**：`.project/prd/bugfix/remote/bugfix-interrupt-kills-all-sessions-v1.md`
