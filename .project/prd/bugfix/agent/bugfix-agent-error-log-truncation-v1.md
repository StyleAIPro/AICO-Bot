# Bugfix: Agent 错误信息丢失/截断

## 元信息

- **时间**：2026-05-25
- **状态**：done
- **指令人**：@misakamikoto
- **PRD 级别**：bugfix

## 问题描述

用户报告：日志中的报错信息会在中途被截断，导致无法分析问题。具体表现为：
1. 远程模式下 Agent 执行出错时，前端 UI 没有错误提示，用户无法知道发生了什么错误
2. 间歇性丢失错误信息（错误闪现后消失）
3. 子 Agent 失败时，错误信息被替换为通用字符串，无法分析具体原因

## 根因分析

### BUG-001（HIGH）：远程模式错误不发送 `agent:error` 事件

**文件**：`src/main/services/agent/send-message-remote.ts`（line 1018-1097 catch 块）

**现象**：远程模式下，当非 abort 错误发生时，catch 块中只发送了 `agent:complete` 事件（line 1059），没有发送 `agent:error` 事件。虽然通过 `updateLastMessage()` 将错误信息写入了消息的 `error` 字段（line 1054），但前端 `handleAgentComplete` 会从后端重新加载会话数据并清除 session 级别的 `error` 状态（line 2161: `error: null`），导致 UI 上无法展示会话级错误提示。

**本地模式对比**：本地模式在 `process-stream.ts`（line 1425-1441）中，中断/空响应场景会发送 `agent:error` 事件；SDK 内部错误通过 `error_during_execution` 标记处理后也会发送 `agent:error` 事件。远程模式的 catch 块缺少这一逻辑。

**影响**：远程 Agent 执行出错时（如网络断开、SDK 崩溃、代理配置错误等），前端 UI 没有错误提示，用户无法知道发生了什么错误。

### BUG-002（MEDIUM）：`handleAgentComplete` 与 `handleAgentError` 竞态条件

**文件**：`src/main/services/agent/process-stream.ts`（line 1398-1444）和 `src/renderer/stores/chat.store.ts`（line 1984）

**现象**：`agent:complete` 事件在 `agent:error` 事件之前发送（process-stream.ts 中 line 1401 发 complete，line 1437 发 error）。`handleAgentComplete` 是异步的（await `api.getConversation()`），在这段 await 期间，`handleAgentError` 可能已经设置了 session 的 `error` 状态。但当 `handleAgentComplete` 的 await 结束后，最终的 `set()` 调用会覆盖 session 状态，包括将 `error` 设为 `null`（line 2161）。

**关键代码路径**：
1. `process-stream.ts` line 1401: `emit('agent:complete', ...)` -- 发送完成事件
2. `process-stream.ts` line 1437: `emit('agent:error', ...)` -- 发送错误事件（在 complete 之后）
3. `chat.store.ts` line 2069: `await api.getConversation(...)` -- 异步等待后端数据
4. `chat.store.ts` line 2161: `error: null` -- 覆盖了 handleAgentError 设置的错误

**影响**：间歇性丢失错误信息。当 `handleAgentComplete` 的 await 耗时较长时（网络延迟、后端负载高），`handleAgentError` 设置的错误会被后续的 `set()` 覆盖。

### BUG-003（LOW）：子 Agent 错误信息被替换为通用字符串

**文件**：`src/main/services/agent/process-stream.ts`（line 1332-1345）

**现象**：流结束时清理未完成的子 Agent（subagent），错误信息被替换为通用的 `'Stream interrupted'`（非 abort 场景）或 `'Stopped by user'`（abort 场景）。子 Agent 实际的错误信息（如 MCP 工具失败、权限错误、网络超时等）被丢弃。

**当前代码**：
```typescript
subagentStates.forEach((state, taskId) => {
  if (!state.isComplete) {
    sendToRenderer('worker:completed', spaceId, rendererConvId, {
      // ...
      error: wasAborted ? 'Stopped by user' : 'Stream interrupted',
      status: 'failed',
    });
  }
});
```

**影响**：无法分析子 Agent 失败的具体原因。用户只能看到"Stream interrupted"而不知道实际是 MCP 连接失败、工具超时还是其他错误。

## 技术方案

### 修复 BUG-001：远程模式 catch 块补充 `agent:error` 事件

**方案**：在 `send-message-remote.ts` 的 catch 块中，非 abort 错误时，在发送 `agent:complete` 之前，先发送 `agent:error` 事件，携带原始错误信息。

**修改位置**：`src/main/services/agent/send-message-remote.ts`（约 line 1054-1059 之间）

**具体改动**：
1. 在 `updateLastMessage()` 之后、`sendToRenderer('agent:complete', ...)` 之前，对非 abort 错误增加 `agent:error` 事件发送
2. 错误类型根据 `err` 的特征判断：网络错误用 `'network'`，超时用 `'timeout'`，其他用 `'runtime'`
3. 错误信息使用 `error-classifier.ts` 中的 `extractNetworkErrorHint()` 等工具提取可读的错误描述

```typescript
// 在 sendToRenderer('agent:complete', ...) 之前添加：
if (!isAbort) {
  const errorType = classifyRemoteError(err);
  sendToRenderer('agent:error', spaceId, conversationId, {
    type: 'error',
    errorType,
    error: err.message || 'Unknown remote agent error',
  });
}
```

### 修复 BUG-002：调整事件发送顺序 + 保护错误状态

**方案**：两处修改配合解决竞态问题：

1. **调整 process-stream.ts 中的事件顺序**：在发送 `agent:complete` 之前先发送 `agent:error`（如果有错误），让前端先处理错误状态
   - 修改位置：`src/main/services/agent/process-stream.ts`（line 1398-1444）
   - 将 `emit('agent:error', ...)` 移到 `emit('agent:complete', ...)` 之前

2. **handleAgentComplete 中保护已设置的错误状态**：在 `set()` 回调中，不清空 `error` 字段如果 `handleAgentError` 已经设置了错误。通过检查当前 session 的 error 状态来决定是否覆盖
   - 修改位置：`src/renderer/stores/chat.store.ts`（line 2161）
   - 将 `error: null` 改为条件判断：仅当 session 当前没有 error 时才清空，或者使用 `error: session.error` 保留已有错误

**注意**：BUG-001 修复后，远程模式也会发送 `agent:error` 事件。如果只修复事件顺序（方案 2 的第 1 点），远程模式仍缺少 `agent:error`，因此两个修复需要同时实施。

### 修复 BUG-003：保留子 Agent 实际错误信息

**方案**：在子 Agent 清理时，检查 `subagentStates` 中是否已有错误信息（来自 `worker:error` 或 SDK 错误事件），优先使用实际错误信息，仅在确实没有错误详情时才使用通用字符串。

**修改位置**：`src/main/services/agent/process-stream.ts`（line 1332-1345）

**具体改动**：
1. 在 `subagentStates` 中增加 `lastError` 字段，在收到子 Agent 的错误事件时记录
2. 清理时优先使用 `state.lastError`，fallback 到通用字符串
3. 在子 Agent 事件路由（`parent_tool_use_id` 匹配）中，对 `error` 类型事件记录到 `subagentStates`

```typescript
subagentStates.forEach((state, taskId) => {
  if (!state.isComplete) {
    const errorDetail = state.lastError || (wasAborted ? 'Stopped by user' : 'Stream interrupted');
    sendToRenderer('worker:completed', spaceId, rendererConvId, {
      // ...
      error: errorDetail,
      status: 'failed',
    });
  }
});
```

**需要额外确认**：检查 `subagentStates` 的类型定义（`process-stream.ts` 内部的 `SubagentState`），确认是否已有错误信息字段，如果没有则需要扩展类型。

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/agent/agent-core-v1.md` | 理解 Agent 模块整体架构、事件通道定义 |
| 功能设计 | `.project/modules/agent/features/message-send/design.md` | 理解消息发送流程（本地/远程）和异常处理 |
| 功能设计 | `.project/modules/agent/features/stream-processing/design.md` | 理解流式处理核心逻辑、子 Agent 清理机制 |
| 功能设计 | `.project/modules/remote-agent/features/websocket-client/design.md` | 理解远程 WebSocket 消息路由和错误传播 |
| 源码 | `src/main/services/agent/send-message-remote.ts` (1018-1097) | 理解远程模式 catch 块的完整逻辑 |
| 源码 | `src/main/services/agent/process-stream.ts` (1320-1447) | 理解流结束处理、子 Agent 清理、事件发送顺序 |
| 源码 | `src/renderer/stores/chat.store.ts` (1842-1925) | 理解 handleAgentError 的完整逻辑 |
| 源码 | `src/renderer/stores/chat.store.ts` (1984-2195) | 理解 handleAgentComplete 的完整逻辑和竞态条件 |
| 源码 | `src/main/services/agent/error-classifier.ts` | 理解错误分类工具函数 |
| Bug 记录 | `.project/modules/agent/features/message-send/changelog.md` | 了解最近变更，避免回归 |
| Bug 记录 | `.project/modules/agent/features/stream-processing/changelog.md` | 了解最近变更，特别是 bugfix-remote-duplicate-subagent-v1 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 通道规范 |

## 涉及文件

- `src/main/services/agent/send-message-remote.ts` -- BUG-001：catch 块补充 `agent:error` 事件发送 + 导入 `classifyError`
- `src/main/services/agent/process-stream.ts` -- BUG-002：调整 `agent:error`/`agent:complete` 事件发送顺序；BUG-003：子 Agent 清理保留实际错误信息
- `src/main/services/agent/subagent-tracker.ts` -- BUG-003：`SubagentState` 添加 `lastError` 字段
- `src/renderer/stores/chat.store.ts` -- BUG-002：`handleAgentComplete` 的 `set()` 回调中保护错误状态不被覆盖
- `.project/modules/agent/features/message-send/changelog.md` -- 新增变更行
- `.project/modules/agent/features/stream-processing/changelog.md` -- 新增变更行
- `.project/changelog/CHANGELOG.md` -- 新增变更行

## 验收标准

- [x] 远程模式下 Agent 执行出错时，前端 UI 显示错误提示（BUG-001）
- [x] 远程模式 abort（用户主动停止）时，不显示错误提示（保持现有行为）
- [x] 本地模式中断/错误场景下，错误信息不再被 `handleAgentComplete` 覆盖丢失（BUG-002）
- [x] 子 Agent 失败时，Worker Tab 显示实际错误信息而非"Stream interrupted"（BUG-003）
- [x] 子 Agent 被用户主动停止时，仍显示"Stopped by user"（保持现有行为）
- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过
