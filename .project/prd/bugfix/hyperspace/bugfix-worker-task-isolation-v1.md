# PRD: Worker 任务间状态隔离——修复新任务混入旧任务输出

## 元信息

```
级别: bugfix
优先级: P1
归属模块: modules/agent (orchestrator + frontend chat store)
timestamp: 2026-05-30
status: done
author: misakamikoto
```

## Bug 描述

HyperSpace Worker 完成任务 A 后，Leader 下发新任务 B，任务 B 的思考过程和模型输出会混入任务 A 的同一个"思考过程框"和输出区域，影响用户阅读。每个任务应该有独立的、干净的显示区域。

## 根因分析

### 根因 1：executeOnSingleAgent 不发送 worker:started/worker:completed 事件

**文件**：`src/main/services/agent/orchestrator.ts` L338-369, L555-566

`executeOnSingleAgent` 调用 `executeAgentLocally`（Leader 路径），其内部的 `processStream` 不发送 `worker:started`/`worker:completed` 事件，也不传 `workerInfo` 参数。只有 `executeLocally`（subtask 路径，L2186, L2246）才发送这些事件和参数。

**后果**：前端 `handleWorkerStarted`（本应在新任务开始时重置状态）不被调用，Worker 面板状态从不清理。

### 根因 2：handleWorkerStarted 保留旧任务的 thoughts 和 streamingContent

**文件**：`src/renderer/stores/chat.store.ts` L2932, L2937

```typescript
streamingContent: existing?.streamingContent || '',  // 保留旧内容
thoughts: existing?.thoughts || [],                    // 保留旧思考
```

设计目的是处理 IPC 时序问题（thought 事件可能在 worker:started 之前到达）。但当同一 Worker 被复用执行第二个任务时，`existing` 仍包含任务 A 的全部思考内容，直接带入任务 B。

### 根因 3：handleWorkerCompleted 不清理 thoughts/streamingContent

**文件**：`src/renderer/stores/chat.store.ts` L3006-3018

使用 `...ws` spread 操作保留所有旧字段，包括 `thoughts` 和 `streamingContent`。

### 根因 4：childConversationId 不含任务标识

**文件**：`src/main/services/agent/orchestrator.ts` L410

```typescript
const childConversationId = `${conversationId}:agent-${agent.id}`;
```

没有 taskId 或时间戳组件，所有任务共用同一 conversationId，消息历史不断累积。

## 技术方案

### 策略：Worker 新任务时重置前端状态 + 后端发送生命周期事件

#### 修改 1：executeOnSingleAgent 发送 worker:started/worker:completed

**文件**：`src/main/services/agent/orchestrator.ts`

在 `executeOnSingleAgent` 的 `executeAgentLocally` 调用前后，发送 `worker:started` 和 `worker:completed` 事件。但这个方法被 Leader 也调用，需要区分。

更好的方案：在 `executeAgentLocally` 的 `processStream` 中传入 `workerInfo`（当调用者是 Worker 时），并在 `onComplete` 回调后、while 循环 break 前发送 `worker:completed`。

实际上，看代码流程：
- `send-message-local.ts` 对 HyperSpace 路由调用 `executeOnSingleAgent`
- `executeOnSingleAgent` 调用 `executeAgentLocally`
- `executeAgentLocally` 是 Leader 的 while 循环（含 processStream + waitForCompletion）
- Worker 的执行路径是 `executeSubtask` -> `executeLocally`

所以问题出在 Leader 的 `executeAgentLocally` 中的 `processStream` 没有 `workerInfo`。但 Leader 不需要 `workerInfo`——它是 Leader。

重新分析：问题场景是 Leader 派发任务给 Worker，Worker 通过 `executeSubtask` -> `executeLocally` 执行。Worker 完成后，Leader 再次派发新任务给同一 Worker，Worker 再次通过 `executeSubtask` -> `executeLocally` 执行。

在 `executeLocally` 中（L2186）有 `sendToRenderer('worker:started', ...)` 和（L2302）有 `sendToRenderer('worker:completed', ...)`。所以 worker:started/worker:completed 事件是有发送的。

核心问题在前端：`handleWorkerStarted` 收到新任务的 worker:started 时，保留了旧任务的 `thoughts` 和 `streamingContent`。

#### 修改 2（核心修复）：handleWorkerStarted 区分"新任务"和"IPC 时序补充"

**文件**：`src/renderer/stores/chat.store.ts`

当 `handleWorkerStarted` 被调用时，检查 `existing` 的 `taskId` 是否与新 `taskId` 不同。如果不同，说明是同一 Worker 执行新任务，应清空 `thoughts` 和 `streamingContent`：

```typescript
const isNewTask = existing && existing.taskId && existing.taskId !== taskId;
newWorkerSessions.set(agentId, {
  agentId,
  agentName: agentName || agentId,
  taskId: taskId || null,
  task: task || '',
  isRunning: true,
  status: 'running',
  streamingContent: isNewTask ? '' : (existing?.streamingContent || ''),
  isStreaming: false,
  thoughts: isNewTask ? [] : (existing?.thoughts || []),
  isThinking: false,
  textBlockVersion: 0,
  error: null,
  completedAt: null,
  ...existing, // 其他字段保留（如历史消息等）
  turnStartedAt: Date.now(),
});
```

#### 修改 3：handleWorkerCompleted 清理 streamingContent

**文件**：`src/renderer/stores/chat.store.ts`

在 `handleWorkerCompleted` 中，将 `streamingContent` 设为空字符串（保留 thoughts 供用户回顾，但清理流式内容）：

```typescript
newWorkerSessions.set(agentId, {
  ...ws,
  isRunning: false,
  status: status || 'completed',
  error: error || null,
  isStreaming: false,
  isThinking: false,
  streamingContent: '',  // 清理流式内容
  completedAt: Date.now(),
});
```

### 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/stores/chat.store.ts` | 修改 | handleWorkerStarted 区分新任务 vs IPC 时序；handleWorkerCompleted 清理 streamingContent |

## 验收标准

- [ ] Worker 完成任务 A 后，收到任务 B 时，前端显示全新的空白思考过程框
- [ ] 任务 B 的模型输出不会拼接在任务 A 的输出之后
- [ ] 用户仍然可以查看任务 A 的历史输出（如有需要）
- [ ] IPC 时序问题（thought 在 worker:started 之前到达）不受影响
- [ ] typecheck 通过
- [ ] build 通过

## 开发前必读

| 文档/源码 | 阅读目的 |
|-----------|---------|
| `src/renderer/stores/chat.store.ts` | 核心：handleWorkerStarted（L2925-2947）、handleWorkerCompleted（L3006-3018）|
| `src/main/services/agent/orchestrator.ts` | executeLocally（L2186 worker:started、L2302 worker:completed）|
| `src/main/services/agent/persistent-worker.ts` | Worker 主循环，理解任务复用流程 |
