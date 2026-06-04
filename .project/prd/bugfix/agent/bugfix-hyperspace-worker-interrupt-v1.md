# PRD [Bug 修复级] — HyperSpace Worker 任务无法中断 & 团队删除无法断连

> 版本：bugfix-hyperspace-worker-interrupt-v1
> 日期：2026-06-02
> 状态：done
> 指令人：misakamikoto
> 归属模块：modules/space (features/hyper-space, worker-management)
> 优先级：P0

## 背景：与已有 PRD 的关系

- **`hyperspace-task-cancel-v1.md`（draft）**：覆盖了前后端完整的取消方案，含 10 个步骤，但用户明确只需后端改动，前端已有停止/删除按钮逻辑。
- **`hyperspace-worker-abort-v2.md`（done）**：修复的是「API 配置变化导致 Leader 在途会话被误杀」，根因是 `activeSessions` key 不匹配。与本 PRD 修复的「点击停止无法中断 Worker / 删除空间无法断连团队」是不同的问题。

**本 PRD 聚焦后端**，不涉及前端 UI 修改（前端已有停止按钮、删除对话/空间按钮，调用链路完整）。

## 问题描述

- **期望行为**：
  1. 用户在 HyperSpace 中点击「停止」按钮，Leader 和所有正在运行的 Worker 都应立即停止，UI 恢复可交互。
  2. 用户删除当前 HyperSpace 空间或删除当前对话时，该 team 组的所有连接（SDK session、WebSocket、SSH tunnel）都应被断开清理。

- **实际行为**：
  1. 点击「停止」只能中断 Leader Agent，Worker Agent（无论本地还是远程）继续在后台运行，直到自然完成或超时（最长 30 分钟）。用户无法停止、无法取消。
  2. 删除 HyperSpace 空间或删除对话时，`closeSessionsBySpaceId()` 会关闭 SDK session，但 orchestrator 的 team 资源（pendingAnnouncements、mailbox、taskboard、persistent worker loops）未被清理；Worker 可能继续执行或处于僵死状态。

- **复现步骤**：
  1. 创建 HyperSpace（Leader + 至少 1 个 Worker）。
  2. Leader 通过 `spawn_subagent` 分发任务到 Worker。
  3. Worker 开始执行（UI 上 WorkerPanel 显示 running）。
  4a. 点击停止按钮 -> Leader 停止，Worker 继续运行。
  4b. 或删除该 HyperSpace 空间 -> Worker 仍在后台执行。
  5. Worker 在后台持续占用资源直到自然完成。

## 根因分析

### BUG 1：Worker 的 AbortController 无法被 stopGeneration() 触达

**文件**：`src/main/services/agent/control.ts`

`stopGeneration()` 通过 `activeSessions.get(conversationId)` 查找 session。这里 `conversationId` 是**父会话 ID**（如 `conv-123`），而 Worker 的 session 注册在**子会话 ID**（如 `conv-123:agent-worker-1`）下。

**证据**：
```typescript
// control.ts:40 — 只按传入的 conversationId 查找
const session = activeSessions.get(conversationId);
```

虽然 `executeAgentLocally` 中注册了双 key（L496 parent + L503 child），但 `stopGeneration` 只命中 parent key 对应的 sessionState，child key 对应的**同一个** sessionState 共享同一个 `abortController`，所以 abort 理论上能传到 Worker。

**但问题在于**：Worker 在 `executeLocally`（subtask 路径，L2183）和 `executeAgentRemotely`（remote 路径）中注册的 `activeSessions` 和 `AbortController` 是**独立创建**的，与 Leader 的 sessionState 完全不同。`stopGeneration(parentConversationId)` 只能找到 Leader 的 session，Worker 的 session 以 `childConversationId` 为 key 存在但不会被查找。

**结论**：`stopGeneration` 只 abort 了 Leader 的 session，Worker 的 SDK session/远程 WebSocket 连接完全不受影响。

### BUG 2：executeAllTasks 是 fire-and-forget，无取消机制

**文件**：`src/main/services/agent/hyper-space-mcp.ts:123`

```typescript
// hyper-space-mcp.ts:123 — fire-and-forget，没有保存 Promise 或 AbortController
agentOrchestrator.executeAllTasks(team.id).catch((err) => {
  console.error(`[HyperSpaceMcp] Task execution error:`, err);
});
```

`executeAllTasks` 在 `dispatchAndExecute`（L2880-2906）和 `executeAllTasks`（L2823-2860）中执行，内部用 `Promise.all` 并行执行所有 subtask。但没有存储 AbortController 或 Promise 引用，无法从外部取消。

### BUG 3：waitForCompletion 未传入 AbortSignal

**文件**：`src/main/services/agent/orchestrator.ts:744`

```typescript
// orchestrator.ts:744 — Leader 等待 Worker，没有 signal 参数
const completedTasks = await this.waitForCompletion({
  conversationId,
});
```

`waitForCompletion` 本身已支持 `signal?: AbortSignal` 参数（L1877），但调用方从未传入。即使用户点了停止，`waitForCompletion` 仍会阻塞直到所有 Worker 完成或 2 小时绝对超时。

### BUG 4：deleteSpace 未清理 orchestrator team 资源

**文件**：`src/main/services/space.service.ts:547-559`

```typescript
export async function deleteSpace(spaceId: string): Promise<{ success: boolean; error?: string }> {
  // ...
  await closeSessionsBySpaceId(spaceId);  // 只关闭 SDK session
  await destroySpaceCache(spaceId);        // 只清理文件 watcher
  // 没有调用 agentOrchestrator.destroyTeam() 或中断 Worker
}
```

`deleteSpace` 调用了 `closeSessionsBySpaceId` 关闭 V2 session，但没有：
- 调用 `agentOrchestrator.destroyTeam()` 清理 team 资源（pendingAnnouncements、mailbox、taskboard）
- 停止 persistent worker loops
- 中断正在运行的 Worker（远程 WebSocket 断连、本地 abort）

### BUG 5：远程 Worker 的 WebSocket 连接无法被 stopGeneration 触达

**文件**：`src/main/services/agent/control.ts:106`

```typescript
const remoteClient = getRemoteWsClient(conversationId);
```

`getRemoteWsClient` 用 `conversationId`（父 ID）查找远程客户端。但 Worker 的远程 WebSocket 客户端注册在 `childConversationId` 下（orchestrator.ts L955），与父 ID 不匹配。所以 `stopGeneration` 找不到 Worker 的远程连接，无法发送 interrupt。

## 技术方案

### 方案概述

新增 `interruptWorkersForConversation(conversationId: string)` 方法到 `AgentOrchestrator`，在 `stopGeneration` 和 `deleteSpace`/`deleteConversation` 的调用链中被触发，负责：
1. 找到该 conversation 关联的所有正在运行的 Worker
2. abort 每个 Worker 的 SDK session / 远程 WebSocket
3. 清理 pendingAnnouncements、injection queue
4. 标记所有 running tasks 为 failed

### 修复点 A：orchestrator 新增 interruptWorkersForConversation

**文件**：`src/main/services/agent/orchestrator.ts`（约 L1205，`destroyTeam` 方法之前）

新增公开方法：

```typescript
/**
 * Interrupt all workers associated with a conversation.
 * Called by stopGeneration and deleteSpace/deleteConversation paths.
 * Aborts SDK sessions, disconnects remote WebSockets, fails running tasks,
 * and clears pending announcements.
 */
async interruptWorkersForConversation(conversationId: string): Promise<void> {
```

逻辑：
1. 通过 `getTeamByConversation(conversationId)` 找到 team。
2. 遍历 team.workers，对 status === 'running' 的 Worker：
   - 本地 Worker：构造 `childConversationId = ${conversationId}:agent-${worker.id}`，从 `activeSessions` 获取 sessionState 并调用 `abortController.abort()`；从 `v2Sessions` 获取 V2 session 并调用 `interrupt()` + `invalidateSession()`。
   - 远程 Worker：构造 `childConversationId`，通过 `getRemoteWsClient(childConversationId)` 获取远程客户端并调用 `interrupt()` + `disconnect()`。
3. 将所有 status === 'running' 的 task 更新为 'failed'（reason: 'User cancelled'）。
4. 清理 `pendingAnnouncements` 中该 conversation 的条目。
5. 调用 `clearInjectionsForConversation(conversationId)` 清理 injection queue。

### 修复点 B：stopGeneration 调用 interruptWorkersForConversation

**文件**：`src/main/services/agent/control.ts`（约 L48，`session.abortController.abort()` 之后）

在现有 abort Leader session 逻辑之后，新增：

```typescript
// After aborting the Leader session, also interrupt all HyperSpace workers
try {
  const { agentOrchestrator } = await import('./orchestrator');
  await agentOrchestrator.interruptWorkersForConversation(conversationId);
} catch (e) {
  console.error(`[Agent] Failed to interrupt workers for ${conversationId}:`, e);
}
```

位置在 `session.abortController.abort()` (L48) 之后、V2 session interrupt (L60) 之前。这样即使 Leader 的 session 已经被 abort，Worker 也会被正确中断。

### 修复点 C：deleteSpace 调用 destroyTeam + interruptWorkers

**文件**：`src/main/services/space.service.ts`（约 L559，`closeSessionsBySpaceId` 之后）

在 `closeSessionsBySpaceId(spaceId)` 之后新增：

```typescript
// Destroy the HyperSpace team and interrupt all workers
try {
  const team = agentOrchestrator.getTeamBySpace(spaceId);
  if (team) {
    await agentOrchestrator.interruptWorkersForConversation(team.conversationId);
    await agentOrchestrator.destroyTeam(team.id);
  }
} catch (e) {
  console.error(`[Space] Failed to destroy HyperSpace team for ${spaceId}:`, e);
}
```

### 修复点 D：deleteConversation 调用 interruptWorkers

**文件**：`src/main/services/conversation.service.ts`（约 L1093，`closeV2Session` 之后）

在 `closeV2Session(conversationId)` 之后新增：

```typescript
// Interrupt HyperSpace workers associated with this conversation
try {
  const { agentOrchestrator } = require('./agent/orchestrator');
  await agentOrchestrator.interruptWorkersForConversation(conversationId);
} catch (_) {
  // Not a HyperSpace conversation, ignore
}
```

### 关键约束

1. **不能破坏现有 Leader session 管理逻辑**：`stopGeneration` 中 Leader 的 abort/interrupt 逻辑保持不变。
2. **Worker 的 childConversationId 格式固定**：`${parentConversationId}:agent-${agentId}`，代码中多处使用此约定。
3. **interruptWorkersForConversation 必须容错**：conversationId 可能不属于任何 HyperSpace team（普通对话），方法应静默返回而非抛异常。
4. **远程 Worker 中断后需要清理 SSH tunnel**：`executeRemotely` 的 finally 块已经处理了 tunnel 清理，不需要额外处理。
5. **`destroyTeam` 已有清理逻辑**：stop persistent workers、fail running tasks、clear pendingAnnouncements、clear injections、destroy mailbox/taskboard。新增的 `interruptWorkersForConversation` 负责中断 SDK session / WebSocket，`destroyTeam` 负责资源清理，两者互补。
6. **TypeScript strict，禁止 `any`**（用 `unknown`），纯类型导入用 `import type`。

### 编码注意事项

- **编辑文件后必须 re-read**（Windows 行尾覆盖问题）。
- 一 PRD 一 commit，commit message 引用本 PRD 路径。
- `interruptWorkersForConversation` 是 async 方法，调用方需 await。

## 开发前必读

| 分类 | 文件 | 关注点 / 阅读目的 |
|------|------|------|
| 核心新增 | `src/main/services/agent/orchestrator.ts` | **新增 `interruptWorkersForConversation` 方法的位置**：约 L1205（`destroyTeam` 之前）。需理解 Worker 的 childConversationId 格式（L410/L2123/L2421）、`activeSessions` 的注册方式（L496-503 leader 路径 / L2183 subtask 路径）、远程 Worker 的 WebSocket client 注册（L955）。**理解两个执行路径**：`executeAgentLocally`（Leader/@mention，L375）和 `executeLocally`（subtask delegation，L2102）的 session 注册差异。 |
| 调用点 B | `src/main/services/agent/control.ts` | `stopGeneration`（L25 起）：在 L48 `abortController.abort()` 之后插入 `interruptWorkersForConversation` 调用。理解 `conversationId` 此时为父 ID（前端传入）。 |
| 调用点 C | `src/main/services/space.service.ts` | `deleteSpace`（L547）：在 L559 `closeSessionsBySpaceId` 之后插入 team 销毁逻辑。理解 spaceId 到 teamId 的映射（`agentOrchestrator.getTeamBySpace`）。 |
| 调用点 D | `src/main/services/conversation.service.ts` | `deleteConversation`（L1090）：在 L1093 `closeV2Session` 之后插入 Worker 中断逻辑。需改为 async（当前是 sync）。 |
| Worker Session | `src/main/services/agent/session-lifecycle.ts` | `activeSessions`（L44）、`v2Sessions`（L50）的 key 格式。`closeV2Session`（L471）、`invalidateSession`（L585）的使用。`closeSessionsBySpaceId`（L514）已按 spaceId 清理所有 session（含 Worker 的 child session）。 |
| 远程中断 | `src/main/services/agent/control.ts` | 远程客户端中断逻辑（L106-131）：`getRemoteWsClient(conversationId)` → `interrupt()` → `disconnect()`。需对每个 Worker 的 childConversationId 分别调用。 |
| 已有清理 | `src/main/services/agent/orchestrator.ts` | `destroyTeam`（L1206）：已有 stop persistent workers、fail running tasks、clear pendingAnnouncements、clear injections、destroy mailbox/taskboard 逻辑。理解可复用的部分。 |
| Injection | `src/main/services/agent/stream-injection.ts` | `clearInjectionsForConversation`（L106）：按 conversationId 清理 injection queue。 |
| 持久化 Worker | `src/main/services/agent/persistent-worker.ts` | `PersistentWorkerLoop.stop()`（L95）：通过 `shutdownRequested` 标记 + `workerAbortController.abort()` 停止循环。`destroyTeam` 已调用 `stopPersistentWorkers`。 |
| 前端调用链 | `src/renderer/components/chat/ChatView.tsx` | `handleStop`（L248-251）：调用 `stopGeneration(currentConversation.id)`。**只读，不改。** |
| 前端 Store | `src/renderer/stores/chat.store.ts` | `stopGeneration`（L1599）：调用 `api.stopGeneration(targetId)` 并设置 `isStopping` 状态。**只读，不改。** |

## 涉及文件（实际）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | **修复 A**：新增 `interruptWorkersForConversation(conversationId)` 公开方法（约 85 行），负责查找 Worker 并中断 SDK session / 远程 WebSocket / 失败任务 / 清理注入。 |
| `src/main/services/agent/control.ts` | 修改 | **修复 B**：在 `stopGeneration` 有参和无参路径中均调用 `interruptWorkersForConversation`。 |
| `src/main/services/space.service.ts` | 修改 | **修复 C**：在 `deleteSpace` 中 `closeSessionsBySpaceId` 之后调用 `interruptWorkersForConversation` + `destroyTeam`。 |
| `src/main/ipc/conversation.ts` | 修改 | **修复 D**：在 `conversation:delete` IPC handler 中调用 `interruptWorkersForConversation` + `destroyTeam`。 |
| `src/main/http/routes/index.ts` | 修改 | **修复 D（HTTP 路径）**：在 HTTP DELETE 路由中同样调用 worker 中断 + team 销毁。 |

## 验收标准（逐条可勾选）

- [x] **停止按钮能中断 Worker**：HyperSpace 中 Leader 分发任务给 Worker 后，点击停止按钮，Leader 和所有 Worker 均在 5 秒内停止执行，UI 恢复可交互。
- [x] **本地 Worker 被中断**：本地 Worker 的 SDK session 被正确 abort + interrupt，`activeSessions` 和 `v2Sessions` 中的 child session 被清理或标记为 invalidation。
- [x] **远程 Worker 被中断**：远程 Worker 的 WebSocket 连接收到 interrupt 消息后断开，SSH tunnel 正常清理。
- [x] **running tasks 被标记 failed**：被中断的 Worker 对应的 subtask status 更新为 'failed'，不残留 'running' 状态。
- [x] **删除 HyperSpace 空间能断连团队**：删除 HyperSpace 空间时，所有 Worker 连接被断开，team 资源（mailbox、taskboard、pendingAnnouncements、injection queue）被完全清理。
- [x] **删除对话能中断 Worker**：删除当前对话时，关联的 Worker 被中断（如果有 team 的话）。
- [x] **非 HyperSpace 对话不受影响**：普通对话/远程对话的停止、删除行为完全不变。
- [x] **无资源泄漏**：中断后 `activeSessions`、`v2Sessions`、`persistentWorkers`、`pendingAnnouncements`、`injection queue` 无残留。
- [x] **类型检查通过**：`npm run typecheck` 无新增错误，未引入 `any`。
- [x] **构建通过**：`npm run build` 无错误。
