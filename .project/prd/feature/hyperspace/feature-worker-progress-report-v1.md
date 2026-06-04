---
timestamp: 2026-05-29
status: done
author: misakamikoto
---

# HyperSpace Worker 定时向 Leader 汇报进展

## 需求分析

### 问题

HyperSpace 多 Agent 协作中，Leader 向 Worker 派发任务后进入等待状态。当前机制下，Worker 在执行期间**不会主动汇报进度**，仅在完成时通过 `announce_completion` 或 `report_to_leader` MCP 工具向 Leader 发送消息。

这导致以下问题：

1. **Leader LLM 误判为"无响应"**：Worker 执行耗时任务（如代码重构、多文件搜索）时，Leader 长时间未收到任何反馈，LLM 会主动生成催促消息，例如：
   - "你的机器状态检查任务还在进行中吗？如果已经收集到部分信息，请先返回已有结果。"
   - "请确认你是否还在执行这个任务。"
2. **催促消息打断 Worker 正常执行**：这些催促消息作为 injection 进入 Leader 的 processStream 循环后，Leader LLM 可能再次催促或做出错误决策（如重复派发任务），浪费 token 并可能引起 Worker 状态混乱。
3. **用户体验差**：用户在 UI 上看到 Leader 在无意义地催促，而非安静等待结果。

### 根因

- **executeLocally**（Worker 执行路径）中，`processStream` 的 thought/tool_use 事件仅转发到前端 UI 展示（通过 `rendererConversationId` + `workerInfo`），**不会回传给 Leader 的 session**。
- Leader 的 `executeAgentLocally` 中虽有 10 秒心跳（`agent:stream-alive`）防止前端 30 秒假超时，但这只是 UI 层面的保活，**Leader LLM 本身看不到任何 Worker 活动**。
- Leader 系统提示词中写了 "Workers will automatically announce completion to you"，但没有提到中间进度汇报的预期时间窗口，导致 LLM 在等待数分钟后自行判断 Worker 可能已卡住。

### 期望行为

1. Worker 执行任务期间，每 **60 秒** 自动向 Leader 汇报一次执行进度摘要。
2. 进度摘要包含：Worker 当前正在执行的操作（如正在调用的工具/命令）、已完成的步骤概要。
3. Leader LLM 收到进度汇报后知道 Worker 仍在工作，**不主动发送催促消息**。
4. 如果 Worker 超过 **3 分钟** 未汇报进度（异常情况），Leader 才发送催促消息。
5. 现有 Worker 完成汇报（`announce_completion`）和主动汇报（`report_to_leader`）机制不受影响。

## 技术方案

### 总体思路

在 Worker 的 `executeLocally` 中拦截 `processStream` 产生的 thought 和 tool_use 事件，每 60 秒做一次摘要，通过 `queueInjection()` 注入到 Leader 的 processStream 循环中。Leader LLM 收到进度信息后自然不会催促。

同时修改 Leader 系统提示词，告知 LLM Worker 会定期汇报进度，超过 3 分钟无汇报才需要催促。

### 步骤 1：Worker 进度拦截器

在 `executeLocally`（约 L2075）的 `processStream` 调用前，创建一个**进度追踪器**：

```typescript
// 在 executeLocally 内部，processStream 调用之前

interface WorkerProgressTracker {
  lastReportTime: number;       // 上次汇报时间
  recentThoughts: Thought[];    // 近期 thought 事件（用于摘要）
  recentToolUses: string[];     // 近期 tool_use 名称（用于摘要）
  reportIntervalMs: number;     // 汇报间隔（默认 60_000）
}
```

由于 `processStream` 内部直接处理 SDK 事件流，thought/tool_use 信息会在 `onComplete` 回调和 `sessionState.thoughts` 中累积。我们无法在 `processStream` 内部直接拦截单个事件——需要换一种方式。

**方案选择**：利用 `processStream` 的 `rendererConversationId` 转发机制。Worker 的 thought 事件会通过 `sendToRenderer('agent:thought', ...)` 发送到前端。我们可以在 `executeLocally` 中订阅一个周期性定时器，每 60 秒读取 `sessionState.thoughts` 的最新内容，做摘要后通过 `queueInjection` 发给 Leader。

具体实现：

```typescript
// 在 executeLocally 中，workerHeartbeatInterval 之后添加：

const REPORT_INTERVAL_MS = 60_000;  // 60 秒汇报间隔
let progressTracker = {
  lastReportTime: Date.now(),
  reportedThoughtCount: 0,  // 已汇报过的 thought 数量
};

const progressReportInterval = setInterval(() => {
  const thoughts = sessionState.thoughts;
  const newThoughts = thoughts.slice(progressTracker.reportedThoughtCount);

  if (newThoughts.length === 0) {
    // 没有新 thought，只发送简短心跳
    const heartbeatMsg = `[Worker 进度心跳] Worker "${agent.config.name || agent.id}" 仍在执行任务，暂无新的工具调用。`;
    queueInjection(subtask.parentConversationId, { content: heartbeatMsg });
  } else {
    // 有新 thought，生成摘要
    const toolUses = newThoughts
      .filter(t => t.type === 'tool_use')
      .map(t => t.toolName || 'unknown');
    const completedSteps = newThoughts.filter(t => t.type === 'tool_result').length;

    let summary = `[Worker 进度汇报] Worker "${agent.config.name || agent.id}":\n`;
    if (toolUses.length > 0) {
      summary += `- 当前操作: ${[...new Set(toolUses)].join(', ')}\n`;
    }
    summary += `- 已完成工具调用: ${completedSteps}\n`;
    summary += `- 总步骤数: ${thoughts.length}`;

    queueInjection(subtask.parentConversationId, { content: summary });
  }

  progressTracker.reportedThoughtCount = thoughts.length;
  progressTracker.lastReportTime = Date.now();
}, REPORT_INTERVAL_MS);
```

**清理**：在 `finally` 块中清除定时器：

```typescript
} finally {
  if (workerHeartbeatInterval) clearInterval(workerHeartbeatInterval);
  if (progressReportInterval) clearInterval(progressReportInterval);
}
```

### 步骤 2：远程 Worker 进度汇报

对于远程 Worker（`executeRemotely`），流事件通过 WebSocket 传输。在 `claude:stream` 和 `thought` 事件处理器中已有 `agent.lastHeartbeat` 更新。

同样添加一个定时器，利用已累积的 `thoughts` 数组做摘要：

```typescript
// 在 executeRemotely 的 client.on('thought', ...) 之后添加
// 类似的 progressReportInterval 定时器
```

### 步骤 3：修改 Leader 系统提示词

在 `buildLeaderSystemPrompt`（约 L3140）中的 "Important Rules" 部分添加：

```
13. **Workers report progress automatically** - Every 60 seconds, workers will send a progress update showing what they are currently doing. You do NOT need to check on them or send reminders unless a worker has been silent for more than 3 minutes (no progress update for 3+ minutes).
```

同时在 "Communication Tools" 部分更新 `check_subagent_status` 说明：

```
- `check_subagent_status` - Check task progress (use only if a worker has been silent for 3+ minutes)
```

### 步骤 4：Leader 等待中的进度感知

当前 Leader 的 `executeAgentLocally` 中有 `while(true)` 循环处理 injection。Worker 的进度汇报通过 `queueInjection` 注入后，会被 Leader 的 processStream 自动消费（作为 turn-level continuation）。

关键点：Leader 的 `while(true)` 循环在等待 Worker 时，processStream 会因 injection 而继续生成，Leader LLM 看到进度汇报后不会主动催促。这是现有机制的自然延伸，无需额外的催促抑制逻辑。

但需要确保：进度 injection 不会导致 Leader 做出不必要的响应（如回复"收到"）。可以在进度消息前缀中明确标记 `[Worker 进度汇报 - 无需回复]`，让 Leader LLM 理解这只是信息通知。

### 步骤 5：Leader 催促阈值

在 Leader 系统提示词中明确 3 分钟阈值，让 LLM 自行判断是否需要催促。这比在代码层面硬编码催促逻辑更灵活，因为：
- LLM 可以根据任务复杂度判断 3 分钟是否合理
- 如果 Worker 已有部分进度汇报但间隔稍长，LLM 可以更智能地决策

## 开发前必读

| 文档/源码 | 阅读目的 |
|-----------|---------|
| `src/main/services/agent/orchestrator.ts` | `executeLocally`（Worker 本地执行，L2075）、`executeRemotely`（远程 Worker）、`executeAgentLocally`（Leader 执行，L375）、`buildLeaderSystemPrompt`（Leader 提示词，L3140）、`reportToLeader`（L3792） |
| `src/main/services/agent/process-stream.ts` | processStream 核心逻辑，理解 thought/tool_use 事件如何在 sessionState 中累积 |
| `src/main/services/agent/stream-injection.ts` | `queueInjection` 注入机制，理解消息如何从 Worker 进入 Leader 的 processStream |
| `src/main/services/agent/session-manager.ts` | `createSessionState` 返回的 sessionState 结构，thoughts 数组的生命周期 |
| `src/main/services/agent/types.ts` | `Thought` 类型定义（type, toolName, content 等字段） |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | `executeLocally` 添加进度定时器、`executeRemotely` 添加进度定时器、`buildLeaderSystemPrompt` 添加进度汇报规则 |
| `src/main/services/agent/process-stream.ts` | 无变更 | 仅理解 thought 累积机制 |

> 注：预计仅修改 `orchestrator.ts` 一个文件。进度追踪逻辑完全在 `executeLocally` / `executeRemotely` 内部完成，利用已有的 `sessionState.thoughts` + `queueInjection` 基础设施。

## 验收标准

- [x] Worker 执行任务期间每 60 秒自动向 Leader 汇报进度
- [x] 进度汇报包含 Worker 当前正在执行的操作摘要（工具名称、完成步骤数）
- [x] Leader 收到进度汇报后不发送催促消息
- [x] Worker 超过 3 分钟未汇报进度时 Leader 发送催促
- [x] 进度汇报消息标记为 `[Worker 进度汇报 - 无需回复]`，Leader LLM 不产生无意义回复
- [x] 现有 Worker 完成汇报（`announce_completion`）机制不受影响
- [x] 现有 Worker 主动汇报（`report_to_leader`）机制不受影响
- [x] Worker 异常退出时进度定时器被正确清理（`finally` 块）
- [x] 远程 Worker（`executeRemotely`）也支持定时进度汇报
- [x] typecheck 通过（无新增错误）
- [x] build 通过
