# Bugfix: 中止后发送新消息复用卡死会话导致 0s 思考 + 旧输入延续

## 元信息

- **时间**：2026-05-13
- **状态**：draft
- **指令人**：用户
- **PRD 级别**：bugfix

## 问题描述

用户点击停止后，若 SDK 子进程未在 5 秒内响应 `interrupt()`，`processStream` 会卡死在 `for await` 循环中。前端 10 秒安全超时后解除 `isGenerating` 限制，用户可发送新消息。此时后端旧会话仍在 `v2Sessions` 中，新 `sendMessage` 复用旧会话，产生两个并发 stream 消费者竞争同一子进程 stdout。旧 `processStream` 最终恢复后调用 `closeV2Session()`，杀死新消息正在使用的会话，导致：

1. **思考过程 0s**：`for await` 循环因会话关闭立即结束，无思考事件
2. **延续旧输入**：SDK 子进程在新消息写入后被强制终止，或以不一致的内部状态处理新消息

### 现象

- 思考过程显示 0s
- Agent 未读取最新输入，表现为延续之前的对话内容

### 触发条件

1. 发送消息后点击停止
2. SDK 子进程未在 5 秒内响应 `interrupt()`（偶发，取决于子进程状态）
3. 前端 10 秒安全超时触发后发送新消息

### 根因分析

**文件**：`src/main/services/agent/session-lifecycle.ts`（`getOrCreateV2Session` 函数）

`getOrCreateV2Session()` 复用已有会话时（第 220-277 行），仅检查：
- transport 是否 ready（`isSessionTransportReady`）
- session 的 `closed` 标志
- credentials/config 是否变更

**不检查** `activeSessions` 中是否存在已 abort 但卡住的请求。当旧 `processStream` 卡死时：
- `v2Sessions` 中旧会话仍存在且 transport 看似 ready
- `activeSessions` 中旧条目的 `abortController.signal.aborted === true`
- 新 `sendMessage` 的 `getOrCreateV2Session` 直接复用旧会话
- 两个 `processStream` 并发消费同一 stream → 旧恢复后 `closeV2Session()` 杀死新会话

**时序**：
```
t=0s    停止 → abort + interrupt(5s timeout) + invalidateSession(延迟)
t=0~?s  processStream 卡在 for await (无新 SDK 消息到达，abort 检查无法触发)
t=10s   前端安全超时 → isGenerating=false
t=10s+  新 sendMessage → getOrCreateV2Session → 复用旧会话 → 两个 stream 并发
t=?s    旧 processStream 恢复 → closeV2Session → 新会话被杀 → 0s 思考
```

## 技术方案

**改动范围**：仅修改 `src/main/services/agent/session-lifecycle.ts` 中 `getOrCreateV2Session` 函数（~10 行）

在 `getOrCreateV2Session` 函数开头，找到已有会话后，增加对 `activeSessions` 的检查：

```typescript
const existing = v2Sessions.get(conversationId);
if (existing) {
  // [NEW] 检测已 abort 但卡住的旧请求（安全超时场景）
  // 当旧 processStream 卡在 for await 循环中时，v2Sessions 仍有该会话，
  // 但 activeSessions 中的旧条目 abortController 已触发。
  // 此时必须强制关闭旧会话，否则新 sendMessage 会复用卡死的会话。
  const stuckActive = activeSessions.get(conversationId);
  if (stuckActive && stuckActive.abortController.signal.aborted) {
    console.log(
      `[Agent][${conversationId}] Previous request aborted but stuck, force-closing session`,
    );
    activeSessions.delete(conversationId);
    closeV2SessionForRebuild(conversationId);
    // Fall through to create new session
  } else if (!isSessionTransportReady(existing.session)) {
    // ... 原有 transport 检查逻辑
```

**为什么这是最小影响修复**：
- 仅修改 1 个文件 1 个函数
- 仅在 `activeSessions` 中存在且 abort 已触发时生效（精确匹配 bug 场景）
- 正常多轮对话不受影响：无 `activeSessions` 条目
- 正常中止不受影响：`processStream` 正常退出后 `unregisterActiveSession` 已清理 `activeSessions`
- 中止后正常发消息不受影响：同上，`handleAgentComplete` 已在安全超时前触发
- 不新增 IPC 通道、不修改前端、不修改数据结构

**安全性分析**：
- `activeSessions.delete` 在 `closeV2SessionForRebuild` 之前执行，避免 `closeV2SessionForRebuild` 内部可能的 `activeSessions` 检查干扰
- 当旧 `processStream` 最终恢复并调用 `unregisterActiveSession` 时，`activeSessions` 中已无该 conversationId（已被新请求覆盖），`unregisterActiveSession` 的 `pendingInvalidations` 检查也不会匹配（新请求未触发 invalidate），所以是 no-op

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码 | `src/main/services/agent/session-lifecycle.ts` (214-280) | 理解 getOrCreateV2Session 的完整复用/重建逻辑 |
| 源码 | `src/main/services/agent/session-lifecycle.ts` (562-644) | 理解 invalidateSession / unregisterActiveSession 的延迟关闭机制 |
| 源码 | `src/main/services/agent/control.ts` (25-94) | 理解 stopGeneration 中 abort + interrupt + invalidate 的执行顺序 |
| 源码 | `src/renderer/stores/chat.store.ts` (1461-1487) | 理解安全超时的触发条件和行为 |
| 源码 | `src/main/services/agent/process-stream.ts` (378-386) | 理解 for await 循环中 abort 检查为何依赖新消息到达 |
| Bug记录 | `.project/modules/agent/features/message-send/bugfix.md` | 理解已有的消息发送 bug 修复，避免回归 |

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/main/services/agent/session-lifecycle.ts` | 修改 — getOrCreateV2Session 增加卡死会话检测（~10 行） |
| `.project/modules/agent/features/message-send/bugfix.md` | 修改 — 新增 BUG-004 记录 |
| `.project/modules/agent/features/message-send/changelog.md` | 修改 — 新增变更行 |

## 验收标准

- [ ] 正常多轮对话（不中止）行为不变
- [ ] 正常中止后发消息（interrupt 在 5s 内成功）行为不变
- [ ] **中止后安全超时触发（interrupt 超时）再发消息**：新消息创建新会话，不复用旧会话
- [ ] 上述场景下 Agent 正常处理新消息，思考时间 > 0s
- [ ] `npm run typecheck` 通过
