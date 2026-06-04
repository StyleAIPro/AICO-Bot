# PRD [Bug 修复级] — HyperSpace 子 Agent 任务无法取消

> 版本：bugfix-hyperspace-task-cancel-v1
> 日期：2026-05-27
> 状态：draft
> 指令人：mi-saka
> 反馈人：mi-saka
> 归属模块：modules/space (features/hyper-space)
> 优先级：P0

## 问题描述

- **期望行为**：用户在 Hyper Space 中分发任务到子 Agent（Worker）后，点击停止按钮应能取消/中断所有正在运行的 Worker 任务，Leader 和 Worker 都应停止执行，UI 立即恢复到可交互状态
- **实际行为**：点击停止按钮只能中断 Leader Agent，Worker Agent 继续在后台运行（可能持续数分钟甚至 30 分钟超时），用户无法停止、无法取消
- **复现步骤**：
  1. 创建一个 Hyper Space（含 Leader + 至少 1 个 Worker）
  2. 发送消息给 Leader，Leader 通过 `spawn_subagent` 分发任务到 Worker
  3. Worker 开始执行任务（UI 上 WorkerPanel 显示 running 状态）
  4. 点击聊天输入区的停止按钮
  5. 观察到 Leader 停止响应，但 Worker Panel 中 Worker 仍然显示 running
  6. Worker 在后台继续执行直到自然完成或 30 分钟超时

## 根因分析

共有 6 个相互关联的 BUG，构成一条完整的取消链缺失：

### BUG 1：子 Agent 的 AbortController 无法被 stopGeneration() 触达

**文件**：`src/main/services/agent/control.ts`

`stopGeneration()` 通过 `activeSessions.get(conversationId)` 查找 session。子 Agent 的 session 注册在子 conversationId 下（格式如 `conv-123:agent-worker-1`），而 `stopGeneration()` 接收的是父 conversationId（`conv-123`）。两者不匹配，`stopGeneration` 永远找不到子 Agent 的 session，因此无法调用其 `abortController.abort()`。

**证据**：
```typescript
// control.ts:40 — 只按 conversationId 查找
const session = activeSessions.get(conversationId);
// 子 Agent 注册在 "conv-123:agent-worker-1"，而传入的是 "conv-123"
```

### BUG 2：executeAllTasks() 是 fire-and-forget，无取消机制

**文件**：`src/main/services/agent/hyper-space-mcp.ts:123`

`spawn_subagent` 工具调用 `agentOrchestrator.executeAllTasks(team.id).catch(...)` 后立即返回文本结果给 Leader。没有存储返回的 Promise 引用，没有创建取消令牌（AbortController / AbortSignal），没有暴露任何取消接口。

```typescript
// hyper-space-mcp.ts:123 — fire-and-forget
agentOrchestrator.executeAllTasks(team.id).catch((err) => {
  console.error(`[HyperSpaceMcp] Task execution error:`, err);
});
```

### BUG 3：没有 hyper-space 的取消 IPC 通道

**文件**：`src/main/ipc/hyper-space.ts`

Hyper Space IPC handler 中没有任何 cancel/stop/abort 处理器。现有的 `hyper-space:*` 通道涵盖创建、状态查询、任务分发、TaskBoard 管理等，但完全没有"停止"类操作。前端也没有对应的 API 方法。

### BUG 4：waitForCompletion() 未传入 AbortSignal

**文件**：`src/main/services/agent/orchestrator.ts:650-656`

Leader 调用 `waitForCompletion()` 等待 Worker 完成时，没有传入 `signal` 参数。即使 Leader 被用户停止，`waitForCompletion` 仍会阻塞直到所有 Worker 完成或 30 分钟超时。

```typescript
// orchestrator.ts:650-656 — 没有 signal 参数
const completedTasks = await this.waitForCompletion({
  conversationId,
  timeout: 30 * 60 * 1000,
});
```

注意：`waitForCompletion()` 方法本身已支持 `signal?: AbortSignal` 参数（第 1737 行），但调用方没有传入。

### BUG 5：远程子 Agent 无 abort 机制

**文件**：`src/main/services/agent/orchestrator.ts` — `executeRemotely()`

`executeRemotely()` 方法通过 WebSocket 向远程服务器发送任务，但没有创建 AbortController 或保存取消引用。`stopGeneration()` 中查找远程客户端时用父 conversationId，找不到子 Agent 的远程 WebSocket 连接。

### BUG 6：前端缺少取消入口

**文件**：`src/renderer/components/chat/WorkerPanel.tsx`、`src/renderer/components/space/AgentPanel.tsx`、`src/renderer/components/space/TaskBoardPanel.tsx`

- `WorkerPanel`：只显示状态（running/completed/failed），没有停止/取消按钮
- `AgentPanel`：只有添加/删除 Agent 功能，没有停止运行中 Agent 的按钮
- `TaskBoardPanel`：只有查看/发布任务功能，没有取消任务的操作
- `InputArea` 的停止按钮只调用 `api.stopGeneration(conversationId)`，只传父 conversationId

## 技术方案

### 步骤 1：orchestrator 存储子 Agent AbortController 并提供批量取消方法

**文件**：`src/main/services/agent/orchestrator.ts`

1.1 在 `AgentOrchestrator` 类中新增 `workerAbortControllers` Map，键为子 conversationId，值为 AbortController：

```typescript
/** 存储子 Agent 的 AbortController，用于批量取消 */
private workerAbortControllers = new Map<string, AbortController>();
```

1.2 在 `executeLocally()` 和 `executeRemotely()` 方法中，创建 AbortController 后立即存入 Map：

```typescript
// executeLocally 中创建 abortController 后
this.workerAbortControllers.set(childConversationId, abortController);

// executeRemotely 中创建 abortController 后（需新增）
this.workerAbortControllers.set(childConversationId, abortController);
```

1.3 在任务完成/失败/中止的清理逻辑中从 Map 中删除对应条目。

1.4 新增 `stopAllWorkers(params)` 方法：

```typescript
/**
 * 停止指定团队/会话的所有正在运行的 Worker
 * @returns 被停止的 Worker 数量
 */
stopAllWorkers(params: {
  spaceId?: string;
  conversationId?: string; // 父 conversationId
  teamId?: string;
}): number {
  // 根据 spaceId 找到 team
  // 遍历 team.workers，找到所有 running 状态的 worker
  // 对每个 worker，通过其 childConversationId 查找 AbortController 并 abort
  // 同时 abort 对应的远程 WebSocket 连接（如有）
  // 更新所有相关 task 状态为 'cancelled'
  // 清理 pendingAnnouncements
  // 返回被停止的数量
}
```

1.5 新增 `stopWorker(agentId)` 方法，用于停止单个 Worker：

```typescript
stopWorker(agentId: string): boolean { ... }
```

1.6 新增 `createAbortSignalForTeam(teamId)` 工厂方法，创建一个可同时中止所有 Worker 的共享 AbortSignal：

```typescript
createAbortSignalForTeam(teamId: string): AbortSignal { ... }
```

### 步骤 2：control.ts stopGeneration 级联取消 HyperSpace Workers

**文件**：`src/main/services/agent/control.ts`

2.1 在 `stopGeneration(conversationId)` 中增加 HyperSpace 检测逻辑：

```typescript
if (conversationId) {
  // ... 现有的停止 Leader session 逻辑 ...

  // 级联停止 HyperSpace Workers
  try {
    const { agentOrchestrator } = await import('./orchestrator');
    const stoppedCount = agentOrchestrator.stopAllWorkers({ conversationId });
    if (stoppedCount > 0) {
      console.log(`[Agent][control.ts] Stopped ${stoppedCount} HyperSpace workers`);
    }
  } catch (e) {
    console.error(`[Agent][control.ts] Failed to stop HyperSpace workers:`, e);
  }
}
```

2.2 在无参 `stopGeneration()` 中同样级联停止所有 HyperSpace Workers。

### 步骤 3：waitForCompletion 传入 AbortSignal

**文件**：`src/main/services/agent/orchestrator.ts`

3.1 修改 `orchestrator.ts:650-656` 处的 `waitForCompletion` 调用，传入 AbortSignal：

```typescript
const abortSignal = this.createAbortSignalForTeam(team.id);
const completedTasks = await this.waitForCompletion({
  conversationId,
  timeout: 30 * 60 * 1000,
  signal: abortSignal,
});
```

3.2 确保 `stopAllWorkers` 触发 abort 后，`waitForCompletion` 的 cancelled 分支正确 reject 并被上层 try/catch 捕获，不会导致未处理异常。

### 步骤 4：新增 hyper-space:stop-workers IPC handler

**文件**：`src/main/ipc/hyper-space.ts`

4.1 新增 `hyper-space:stop-workers` IPC handler：

```typescript
/**
 * Stop all running workers for a Hyper Space
 */
wrapIpcHandle('hyper-space:stop-workers', async (_event, spaceId: string) => {
  try {
    const stoppedCount = agentOrchestrator.stopAllWorkers({ spaceId });
    return { success: true, stoppedCount };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});
```

4.2 新增 `hyper-space:stop-worker` IPC handler（停止单个 Worker）：

```typescript
wrapIpcHandle('hyper-space:stop-worker', async (_event, agentId: string) => {
  try {
    const stopped = agentOrchestrator.stopWorker(agentId);
    return { success: true, stopped };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});
```

4.3 新增 `hyper-space:cancel-tasks` IPC handler（取消指定会话的待执行任务）：

```typescript
wrapIpcHandle('hyper-space:cancel-tasks', async (_event, conversationId: string) => {
  try {
    // 取消 pending 状态的任务，更新为 cancelled
    const cancelledCount = agentOrchestrator.cancelPendingTasks(conversationId);
    return { success: true, cancelledCount };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});
```

4.4 在 orchestrator 中新增 `cancelPendingTasks(conversationId)` 方法。

### 步骤 5：远程子 Agent abort 支持

**文件**：`src/main/services/agent/orchestrator.ts` — `executeRemotely()`

5.1 在 `executeRemotely()` 中创建 AbortController 并存入 `workerAbortControllers` Map。

5.2 在远程 WebSocket 连接过程中，将 AbortSignal 传入相关异步操作（如 SSH 隧道建立、`client.sendChatWithStream()` 等），确保 abort 时能中断等待。

5.3 `stopAllWorkers()` 中检测远程 Worker 时，通过 `getRemoteWsClient()` 找到对应子会话的远程客户端并发送停止指令。需要维护一个 `remoteClientByChildConvId` 的映射（或在现有映射基础上支持子 conversationId 查找）。

### 步骤 6：前端 WorkerPanel 增加停止按钮

**文件**：`src/renderer/components/chat/WorkerPanel.tsx`

6.1 在 WorkerPanel 的 header 区域（展开/收起按钮旁）增加一个停止按钮，仅当 `worker.status === 'running'` 时显示：

```tsx
{isRunning && onStopWorker && (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onStopWorker(worker.agentId);
    }}
    className="p-1 rounded hover:bg-destructive/20 text-destructive/70 hover:text-destructive transition-colors"
    title={t('Stop worker')}
  >
    <Square size={12} />
  </button>
)}
```

6.2 新增 `onStopWorker?: (agentId: string) => void` prop。

### 步骤 7：前端 AgentPanel 增加停止按钮

**文件**：`src/renderer/components/space/AgentPanel.tsx`

7.1 在 AgentPanel 的 Worker 列表项中，当 Worker 处于激活态（`activatedAgentIds` 包含该 agent）时，显示停止按钮。

7.2 点击停止按钮调用 `api.stopHyperSpaceWorker(agentId)`。

### 步骤 8：前端 TaskBoard 增加任务取消操作

**文件**：`src/renderer/components/space/TaskBoardPanel.tsx`

8.1 对 `in_progress` 状态的任务增加"取消"操作按钮。

8.2 对 `posted` / `claimed` 状态的任务增加"取消"操作按钮。

8.3 点击后调用 `api.cancelHyperSpaceTasks(conversationId)` 或更新任务状态为 `cancelled`。

### 步骤 9：Preload + Renderer API 暴露

**文件**：`src/preload/index.ts`、`src/renderer/api/index.ts`、`src/renderer/api/transport.ts`

9.1 在 `src/preload/index.ts` 中新增 IPC 调用：

```typescript
stopHyperSpaceWorkers: (spaceId: string) =>
  ipcRenderer.invoke('hyper-space:stop-workers', spaceId),
stopHyperSpaceWorker: (agentId: string) =>
  ipcRenderer.invoke('hyper-space:stop-worker', agentId),
cancelHyperSpaceTasks: (conversationId: string) =>
  ipcRenderer.invoke('hyper-space:cancel-tasks', conversationId),
```

9.2 在 `src/renderer/api/index.ts` 中新增对应的 API 方法。

9.3 在 `src/renderer/api/transport.ts` 的 `onEvent()` 中新增 methodMap 条目。

### 步骤 10：前端 InputArea 停止按钮增强

**文件**：`src/renderer/components/chat/InputArea.tsx`、`src/renderer/stores/chat.store.ts`

10.1 `chat.store.ts` 的 `stopGeneration` action 中，检测当前 Space 是否为 HyperSpace，如果是则额外调用 `api.stopHyperSpaceWorkers(spaceId)`。

10.2 前端收到 Worker 停止确认事件后，更新对应 Worker 的 session state。

## 开发前必读

### 模块设计文档

| 文档 | 路径 | 阅读目的 |
|------|------|---------|
| Space 管理模块 | `.project/modules/space/space-management-v1.md` | 理解 HyperSpace 在 Space 模块中的定位和 IPC 接口 |
| HyperSpace 功能设计 | `.project/modules/space/features/hyper-space/design.md` | 理解 HyperSpace 创建、Agent 管理、任务分发流程 |
| HyperSpace 变更记录 | `.project/modules/space/features/hyper-space/changelog.md` | 了解最近变更，避免回归 |
| HyperSpace Bug 记录 | `.project/modules/space/features/hyper-space/bugfix.md` | 了解已知问题 |
| API 文档 — Space | `.project/api/space.md` | 理解现有 Space IPC/HTTP 接口 |

### 源码文件

| 文件 | 阅读目的 |
|------|---------|
| `src/main/services/agent/orchestrator.ts` | 核心编排器，理解 executeLocally/executeRemotely/waitForCompletion/executeAllTasks 的实现 |
| `src/main/services/agent/hyper-space-mcp.ts` | MCP 工具定义，理解 spawn_subagent 的 fire-and-forget 调用模式 |
| `src/main/services/agent/control.ts` | 理解 stopGeneration 的现有实现和 activeSessions 查找机制 |
| `src/main/services/agent/send-message-local.ts` | 理解 HyperSpace 路由和消息发送流程 |
| `src/main/services/agent/session-manager.ts` | 理解 activeSessions/v2Sessions 的注册/注销机制 |
| `src/main/ipc/hyper-space.ts` | 现有 HyperSpace IPC handler，新增 stop 类 handler |
| `src/renderer/components/chat/WorkerPanel.tsx` | Worker 状态面板，新增停止按钮 |
| `src/renderer/components/space/AgentPanel.tsx` | Agent 列表面板，新增停止按钮 |
| `src/renderer/components/space/TaskBoardPanel.tsx` | 任务看板，新增取消操作 |
| `src/renderer/components/chat/InputArea.tsx` | 输入区域停止按钮，增强为级联停止 |
| `src/renderer/stores/chat.store.ts` | stopGeneration action，增强为级联停止 |
| `src/shared/types/hyper-space.ts` | 共享类型，可能需要新增 cancelled 状态 |
| `src/preload/index.ts` | Preload 暴露层，新增 IPC 调用 |
| `src/renderer/api/index.ts` | 渲染器 API，新增停止方法 |
| `src/renderer/api/transport.ts` | 双模式传输层，新增 methodMap |
| `src/main/services/remote/ws/remote-ws-client.ts` | 远程 WebSocket 客户端，理解远程会话中止机制 |

### API 文档

| 文档 | 阅读目的 |
|------|---------|
| `.project/api/space.md` | 理解现有 HyperSpace API 接口（create、get-status 等） |

### 编码规范

| 文档 | 阅读目的 |
|------|---------|
| `docs/Development-Standards-Guide.md` | TypeScript strict、IPC handler try/catch + `{ success, data/error }` 格式、组件规范 |
| `docs/vibecoding-doc-standard.md` | 文档更新规范、PRD 状态流转 |

## 涉及文件（预估）

### 后端（主进程）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | 新增 workerAbortControllers Map、stopAllWorkers()、stopWorker()、createAbortSignalForTeam()、cancelPendingTasks() |
| `src/main/services/agent/control.ts` | 修改 | stopGeneration 级联停止 HyperSpace Workers |
| `src/main/services/agent/hyper-space-mcp.ts` | 修改 | executeAllTasks 存储取消引用 |
| `src/main/ipc/hyper-space.ts` | 修改 | 新增 stop-workers、stop-worker、cancel-tasks IPC handler |

### 前端（渲染进程）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer/components/chat/WorkerPanel.tsx` | 修改 | 新增停止按钮 |
| `src/renderer/components/space/AgentPanel.tsx` | 修改 | 新增停止按钮 |
| `src/renderer/components/space/TaskBoardPanel.tsx` | 修改 | 新增取消任务操作 |
| `src/renderer/components/chat/InputArea.tsx` | 修改 | （可选）停止按钮 UI 增强 |
| `src/renderer/stores/chat.store.ts` | 修改 | stopGeneration action 级联停止 Workers |

### 共享层 / Preload / API

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/shared/types/hyper-space.ts` | 修改 | 可能新增 `cancelled` 任务状态 |
| `src/preload/index.ts` | 修改 | 暴露新 IPC 方法 |
| `src/renderer/api/index.ts` | 修改 | 新增 API 方法 |
| `src/renderer/api/transport.ts` | 修改 | 新增 methodMap |

## 验收标准

- [ ] **基础取消**：在 Hyper Space 中分发任务后点击停止按钮，所有 Worker 立即停止，UI 恢复到可交互状态
- [ ] **单个 Worker 停止**：WorkerPanel 中运行中的 Worker 显示停止按钮，点击后该 Worker 停止，其他 Worker 不受影响
- [ ] **AgentPanel 停止**：AgentPanel 中激活态 Worker 显示停止按钮，点击后停止
- [ ] **TaskBoard 取消**：TaskBoard 中 in_progress/posted/claimed 状态的任务可以取消
- [ ] **waitForCompletion 中断**：用户停止 Leader 后，waitForCompletion 不再阻塞等待 30 分钟，立即返回
- [ ] **远程 Worker 取消**：远程 Worker 能被正确停止（WebSocket 连接中断、远程 Agent 停止执行）
- [ ] **状态一致性**：取消后，Worker 状态正确更新为 cancelled/failed，TaskBoard 任务状态同步更新
- [ ] **无回归**：普通（非 HyperSpace）会话的停止按钮行为不变
- [ ] **无残留进程**：取消后无孤儿进程/连接残留
- [ ] **构建通过**：`npm run typecheck && npm run build` 通过
- [ ] **国际化**：新增用户可见文本通过 `npm run i18n` 提取翻译

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-27 | 初始 PRD | 用户 |
