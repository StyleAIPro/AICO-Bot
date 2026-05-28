# PRD [Bug 修复级] — HyperSpace Leader 中断恢复丢失 Worker 上下文

> 版本：bugfix-hyperspace-leader-interrupt-context-v1
> 日期：2026-05-28
> 状态：done
> 指令人：用户
> 归属模块：modules/space (features/hyper-space)
> 优先级：P0

## 问题描述

- **期望行为**：Leader 在分发 Worker 任务后，如果 Leader 的流被中断（超时、SDK 错误等），用户点击「继续」时，Leader 应知道之前在执行什么任务、哪些 Worker 仍在运行、哪些已完成，从而无缝恢复工作。
- **实际行为**：Leader 页面频繁出现「模型响应已中断」（`Model response interrupted`）。点击「继续」后发送的是纯文本 `"continue"`，Leader LLM 不知道之前在做什么、Worker 们在跑什么任务。大任务场景下完全丢失上下文，导致重复执行已完成的任务或忽略正在运行的 Worker。
- **复现步骤**：
  1. 创建一个 Hyper Space（Leader + 至少 1 个 Worker）
  2. 发送任务给 Leader，Leader 通过 `spawn_subagent` 分派任务到 Worker
  3. Worker 开始执行较长时间的任务（如代码重构、大规模分析）
  4. Leader 在等待 Worker 结果期间，流因超时/SDK 错误被中断
  5. UI 显示「模型响应已中断」，点击「继续」
  6. Leader 收到 `"continue"` 消息，不知道 Worker 正在运行什么任务

## 根因分析

问题出在 Leader 中断恢复流程中，缺乏 Worker 上下文传递：

### 根因 1：中断时 Worker 状态未附加到错误信息

**文件**：`src/main/services/agent/process-stream.ts:1409-1438`

当 Leader 的 `processStream` 被中断时，`agent:error` 事件只包含 `errorType: 'interrupted'` 和通用错误消息。不包含任何关于正在运行的 Worker 的信息（任务 ID、任务描述、Worker 状态）。

```typescript
emit('agent:error', {
  type: 'error',
  errorType: 'interrupted',
  error: errorMessage,
  // 缺失: worker 状态上下文
});
```

### 根因 2：`continueAfterInterrupt` 发送纯文本无上下文

**文件**：`src/renderer/stores/chat.store.ts:1668-1691`

`continueAfterInterrupt()` 清除错误状态后调用 `state.sendMessage('continue')`。这是一个纯文本消息，不携带任何 Hyper Space 的 Worker 状态信息。

```typescript
continueAfterInterrupt: (conversationId: string) => {
  // 只清除 error 状态
  set((state) => { ... session.error = null; session.errorType = null; });
  // 发送纯文本 "continue" — 无 Worker 上下文
  state.sendMessage('continue');
},
```

### 根因 3：`sendMessageLocal` 对 Hyper Space 的 "continue" 无特殊处理

**文件**：`src/main/services/agent/send-message-local.ts:140-248`

Hyper Space 的消息路由通过 `executeOnSingleAgent()` → `executeAgentLocally()` 执行。收到 `"continue"` 消息时，orchestrator 不知道这是一个中断恢复场景，不会注入当前 Worker 状态。

`executeAgentLocally()` 的 `while(true)` 循环在首次调用时从 `task` 参数获取任务内容（line 503: `let currentMessageContent = task`）。但 "continue" 作为 `task` 传入时，Leader LLM 只看到 `"continue"` 而非 Worker 状态。

### 根因 4：Worker 结果可能已经到达但未消费

**文件**：`src/main/services/agent/orchestrator.ts:602-630`

当 Leader 流中断退出 `executeAgentLocally` 的 while 循环时，`stream-injection.ts` 中的 injection 队列可能仍有未消费的 Worker 完成通知。新的 "continue" 消息启动新的 `executeAgentLocally` 调用，不会检查并消费这些遗留 injection。

## 技术方案

### 策略：两层恢复机制

1. **中断时保存上下文**：Leader 流中断时，收集当前 Worker 任务状态并传递到前端
2. **恢复时注入上下文**：点击「继续」时，将 Worker 状态注入到发送给 Leader LLM 的消息中

### 步骤 1：扩展 `agent:error` 事件，携带 Worker 上下文

**文件**：`src/main/services/agent/orchestrator.ts`

在 `executeAgentLocally` 的 catch/finally 中，当流被中断且存在活跃 Worker 时，收集 Worker 上下文：

```typescript
interface InterruptWorkerContext {
  /** 正在运行的 Worker 任务列表 */
  runningWorkers: Array<{
    taskId: string;
    agentId: string;
    agentName: string;
    task: string;       // 任务描述
    startedAt?: number;
  }>;
  /** 已完成但未消费的 Worker 结果 */
  completedWorkers: Array<{
    taskId: string;
    agentId: string;
    agentName: string;
    result?: string;
    error?: string;
  }>;
}
```

在 `executeAgentLocally` 中，当 processStream 返回 `isInterrupted=true` 且存在 `pendingAnnouncements` 或活跃 tasks 时：
1. 遍历 `this.tasks` 收集 status=running 的任务
2. 检查 injection 队列中是否有已完成但未消费的结果
3. 将此上下文通过 `agent:error` 事件传递到前端

**修改位置**：`orchestrator.ts` 的 `executeAgentLocally` 方法，在 `processStream` 调用后的中断处理逻辑中。

### 步骤 2：前端保存中断时的 Worker 上下文

**文件**：`src/renderer/stores/chat.store.ts`

在 `handleAgentError` 中，当收到 `errorType: 'interrupted'` 且事件包含 `workerContext` 时，保存到 session state：

```typescript
interface SessionState {
  // ... 现有字段
  interruptWorkerContext?: InterruptWorkerContext;
}
```

### 步骤 3：`continueAfterInterrupt` 注入 Worker 上下文

**文件**：`src/renderer/stores/chat.store.ts`

修改 `continueAfterInterrupt`：

```typescript
continueAfterInterrupt: (conversationId: string) => {
  const state = get();
  const session = state.sessions.get(conversationId);

  // 构建带上下文的 continue 消息
  let continueMessage = 'continue';

  if (session?.interruptWorkerContext) {
    const ctx = session.interruptWorkerContext;
    const parts: string[] = ['[System: Conversation was interrupted. Resuming with current worker status:]'];

    if (ctx.runningWorkers.length > 0) {
      parts.push('\n**Still running:**');
      for (const w of ctx.runningWorkers) {
        parts.push(`- Worker "${w.agentName}" (task: ${w.task.slice(0, 200)})`);
      }
    }

    if (ctx.completedWorkers.length > 0) {
      parts.push('\n**Completed since interruption:**');
      for (const w of ctx.completedWorkers) {
        const summary = w.result?.slice(0, 500) || w.error || 'No result';
        parts.push(`- Worker "${w.agentName}": ${summary}`);
      }
    }

    parts.push('\nPlease continue based on the above worker status.');
    continueMessage = parts.join('\n');
  }

  // 清除 error 和 worker context
  set((state) => { ... session.error = null; session.errorType = null; session.interruptWorkerContext = undefined; });
  state.sendMessage(continueMessage);
},
```

### 步骤 4：后端 `sendMessageLocal` 恢复遗留 injection

**文件**：`src/main/services/agent/send-message-local.ts`

在 Hyper Space 路由分支中，当消息包含 Worker 恢复上下文（通过消息内容中的 `[System: Conversation was interrupted]` 标记识别，或通过新增参数），在调用 `executeOnSingleAgent` 前：
1. 检查 injection 队列中是否有该 conversationId 的未消费 injection
2. 如果有，将其内容附加到发送给 Leader 的消息中

**替代方案**：在 orchestrator 的 `executeOnSingleAgent` 入口处增加一个检查：如果存在该 conversationId 的 pending injection 或 pending announcements，自动将它们附加到 `task` 参数中。

### 步骤 5：IPC 事件扩展

**涉及文件**：`src/shared/types/` 相关类型定义

`agent:error` 事件 payload 扩展可选的 `workerContext` 字段。

## 开发前必读

| 分类 | 文件 | 关注点 |
|------|------|--------|
| 流中断检测 | `src/main/services/agent/process-stream.ts` | L72 `isInterrupted` 标记、L1409-1438 中断错误消息生成 |
| Orchestrator 主循环 | `src/main/services/agent/orchestrator.ts` | L490-760 `executeAgentLocally` while(true) 循环、L602-630 injection 消费、L662-748 等待未完成 Worker |
| 中断恢复前端 | `src/renderer/stores/chat.store.ts` | L1668-1691 `continueAfterInterrupt`、L1868-1950 `handleAgentError` |
| 中断 UI | `src/renderer/components/chat/InterruptedBubble.tsx` | 完整组件 |
| Worker 任务类型 | `src/shared/types/hyper-space.ts` | L200-233 `SubagentTask` 接口 |
| Injection 队列 | `src/main/services/agent/stream-injection.ts` | `queueInjection`/`getAndClearInjection`/`hasPendingInjection` |
| 消息发送 | `src/main/services/agent/send-message-local.ts` | L140-248 Hyper Space 路由分支 |
| Mailbox 通信 | `src/main/services/agent/mailbox.ts` | Worker 消息管道 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | 中断时收集 Worker 上下文 + 恢复时消费遗留 injection |
| `src/main/services/agent/process-stream.ts` | 修改 | 扩展 StreamResult/错误事件以携带 Worker 上下文 |
| `src/renderer/stores/chat.store.ts` | 修改 | 保存 Worker 上下文到 session、增强 `continueAfterInterrupt` |
| `src/shared/types/hyper-space.ts` | 修改 | 新增 `InterruptWorkerContext` 接口 |

## 验收标准

1. **基础恢复**：Leader 中断后点击「继续」，消息中包含正在运行的 Worker 任务描述，Leader 能识别并继续等待/处理
2. **遗留 injection 消费**：如果 Worker 在中断期间完成了任务，其结果在恢复时被注入给 Leader
3. **多 Worker 场景**：多个 Worker 同时运行时，所有 Worker 的状态都包含在恢复上下文中
4. **无 Worker 场景不受影响**：普通对话（无 Hyper Space）的中断恢复行为不变
5. **类型检查通过**：`npm run typecheck` 无错误
6. **构建通过**：`npm run build` 无错误
