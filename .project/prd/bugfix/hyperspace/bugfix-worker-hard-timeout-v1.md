---
timestamp: 2026-05-29
status: done
author: misakamikoto
---

# 修复 HyperSpace Worker 任务硬超时误杀

> 版本：bugfix-worker-hard-timeout-v1
> 优先级：P0
> 归属模块：modules/agent (orchestrator)

## 需求分析

### 问题描述

Leader 向 Worker 派发复杂任务时（如系统状态检查、NPU 任务、多步骤 shell 命令序列），Worker 执行时间超过硬编码超时限制，导致任务被 Leader 判定为超时并终止等待。Leader 日志显示"两台 Worker 都因超时失败了"，但实际上 Worker 仍在正常执行。

### 影响

1. **任务丢失**：Worker 已经在执行中或即将完成的工作被丢弃，用户需要重新派发
2. **用户体验差**：长时间任务被强制终止后，Leader 返回"超时"错误消息，用户无法获得任何有效结果
3. **信任度下降**：HyperSpace 的并行协作能力因超时限制而无法用于真正复杂的任务

### 复现步骤

1. 创建 Hyper Space（Leader + 2 个 Worker）
2. Leader 通过 `spawn_subagent` 派发耗时任务（如"检查系统状态"，需运行多个 shell 命令）
3. Worker 开始执行，任务本身需要 30 秒以上
4. Leader 的 `waitForCompletion` 或 stall detection 判定超时，拒绝继续等待
5. Leader 日志显示 Worker 超时失败，实际 Worker 仍在正常执行

## 根因分析

当前系统中存在**两层超时机制**，均可能误杀正常运行的 Worker：

### 超时层 1：`waitForCompletion` 的绝对超时 + 心跳超时

**文件**：`src/main/services/agent/orchestrator.ts:1844-1923`

`waitForCompletion` 使用双超时策略：

```typescript
const timeout = params.timeout || 30 * 60 * 1000;           // 绝对超时：30 分钟
const heartbeatTimeout = params.heartbeatTimeout || 5 * 60 * 1000; // 心跳超时：5 分钟
```

调用处（`orchestrator.ts:721`）：

```typescript
const completedTasks = await this.waitForCompletion({
  conversationId,
  timeout: 30 * 60 * 1000,
  // 未传 heartbeatTimeout，使用默认 5 分钟
});
```

**问题**：`heartbeatTimeout` 默认 5 分钟。如果 Worker 在执行期间**不更新 `agent.lastHeartbeat`**（当前本地 Worker 的 `processStream` 没有主动更新此字段），则 5 分钟后 Leader 判定心跳超时并 reject，导致"Worker 超时"错误。

### 超时层 2：`stallConfig` 心跳超时

**文件**：`src/main/services/agent/orchestrator.ts:156-160`

```typescript
private stallConfig: StallDetectionConfig = {
  heartbeatTimeout: 5 * 60 * 1000,  // 5 分钟
  maxTaskDuration: 60 * 60 * 1000,  // 1 小时
  checkInterval: 30000,              // 30 秒
};
```

`checkForStalledTasks()` 每 30 秒扫描一次所有 running 状态的任务：

```typescript
// orchestrator.ts:2852-2866
if (agent.lastHeartbeat) {
  const timeSinceHeartbeat = now - agent.lastHeartbeat;
  if (timeSinceHeartbeat > this.stallConfig.heartbeatTimeout) {
    isStalled = true;
    // 标记任务为 failed，agent.status = 'error'
  }
}
```

**问题**：如果本地 Worker 从未更新 `lastHeartbeat`（或更新间隔超过 5 分钟），stall detection 会将任务标记为 failed 并将 agent 状态设为 error。

### 核心缺陷：本地 Worker 缺少心跳上报机制

**文件**：`src/main/services/agent/orchestrator.ts:527-535`

当前只有 Leader 在等待 Worker 期间发送前端心跳（`agent:stream-alive`，10 秒间隔，commit a80c761 添加），这是**前端保活心跳**，防止前端 30 秒不活跃计时器误杀 Leader 会话。

但 **Worker 侧没有向 orchestrator 上报心跳**的机制。`agent.lastHeartbeat` 字段需要在 Worker 的 `processStream` 执行期间被定期更新，否则 stall detection 和 `waitForCompletion` 的心跳超时都会触发。

### 前次修复（a80c761）的局限

commit a80c761 解决了**前端 30 秒不活跃计时器**误杀 Leader 会话的问题，但未解决 orchestrator 后端侧的超时判定问题。本次 PRD 解决的是同一个问题域的另一面。

## 技术方案

### 策略概述

取消硬超时机制，改用**纯心跳保活**判断 Worker 是否存活。只要 Worker 持续发送心跳，Leader 就一直等待任务结果。仅在心跳真正停止时才判定 Worker 掉线。

### 步骤 1：Worker 执行期间定期更新 `agent.lastHeartbeat`

**文件**：`src/main/services/agent/orchestrator.ts`

在 `executeAgentLocally` 方法的 `processStream` 调用中，利用已有的 `onComplete` 回调之外新增**流中心跳回调**：

1.1 在 `processStream` 的 `callbacks` 中新增 `onActivity` 回调（或复用已有的事件机制），每当 `processStream` 收到任何 SDK 消息（thought、tool_use、text delta 等）时触发。

1.2 在回调中更新对应 agent 的 `lastHeartbeat`：

```typescript
// executeAgentLocally 内部
agent.lastHeartbeat = Date.now();
```

1.3 对于本地 Worker，`processStream` 已经在处理 SDK 事件流。可以在 `processStream` 的内部循环中添加心跳更新逻辑。具体方案：

- **方案 A（推荐）**：在 `processStream` 中已有的 `markActivity` 机制（`src/main/services/agent/process-stream.ts:378`）基础上，增加一个 `onHeartbeat` 回调参数，让 orchestrator 在收到回调时更新 `agent.lastHeartbeat`。
- **方案 B**：在 orchestrator 的 `executeAgentLocally` 中启动一个定时器（与已有的 Leader 前端心跳定时器类似），每 10 秒更新一次 `agent.lastHeartbeat`。

推荐方案 A，因为它是事件驱动的，能更精确地反映 Worker 的真实活跃状态。

### 步骤 2：`waitForCompletion` 取消绝对超时，仅保留心跳超时

**文件**：`src/main/services/agent/orchestrator.ts:1844-1923`

2.1 修改 `waitForCompletion` 方法，移除绝对超时判定逻辑：

```typescript
// 删除以下代码块：
if (timeSinceStart > timeout) {
  reject(new Error(
    `[Orchestrator] Absolute timeout (${timeout / 1000}s) waiting for ${pending.size} subagent(s)`,
  ));
  return;
}
```

2.2 仅保留心跳超时判定，并将默认值从 5 分钟提升至 10 分钟（给 SDK 工具调用更多缓冲）：

```typescript
const heartbeatTimeout = params.heartbeatTimeout || 10 * 60 * 1000; // 10 分钟
```

2.3 心跳超时的含义变为：如果 Worker 在 10 分钟内没有任何活动（SDK 事件流完全静止），才判定为掉线。

2.4 保留 `timeout` 参数但仅作为**最终安全上限**（例如 2 小时），防止因代码 bug 导致的永久阻塞：

```typescript
const absoluteMaxTimeout = params.timeout || 2 * 60 * 60 * 1000; // 2 小时硬上限
```

### 步骤 3：`stallConfig` 调整心跳超时阈值

**文件**：`src/main/services/agent/orchestrator.ts:156-160`

3.1 将 `stallConfig.heartbeatTimeout` 从 5 分钟提升至 10 分钟：

```typescript
private stallConfig: StallDetectionConfig = {
  heartbeatTimeout: 10 * 60 * 1000,  // 10 分钟（与 waitForCompletion 心跳超时一致）
  maxTaskDuration: 2 * 60 * 60 * 1000, // 2 小时（最终安全上限）
  checkInterval: 30000,                // 30 秒（不变）
};
```

3.2 `checkForStalledTasks` 中标记 stalled 时，先验证 Worker 的 session 是否真的不活跃（而非仅依赖 `lastHeartbeat`）：

```typescript
// 在 checkForStalledTasks 中增加二次确认
if (timeSinceHeartbeat > this.stallConfig.heartbeatTimeout) {
  // 检查 Worker 的 session 是否还在运行
  const workerSession = v2Sessions.get(childConversationId);
  if (!workerSession || !isSessionTransportReady(workerSession.session)) {
    isStalled = true; // 确认掉线
  }
  // 如果 session 仍然存活，可能是心跳更新缺失，只记录警告不标记 stalled
}
```

### 步骤 4：远程 Worker 心跳上报

**文件**：`src/main/services/agent/orchestrator.ts` — `executeRemotely` 部分

4.1 远程 Worker 通过 WebSocket 接收 SDK 事件流。在远程消息处理回调中，每次收到消息时更新 `agent.lastHeartbeat`。

4.2 远程 Worker 如果有 `stream:alive` 心跳事件（参见 `send-message-remote.ts:725-727`），也应更新 `agent.lastHeartbeat`。

### 步骤 5：Leader 等待期间的前端进度反馈

**文件**：`src/main/services/agent/orchestrator.ts:527-535`

5.1 增强已有的 Leader 前端心跳（commit a80c761 添加的 `agent:stream-alive`），在心跳数据中包含 Worker 活跃状态摘要：

```typescript
const heartbeatInterval = setInterval(() => {
  // 收集 Worker 活跃信息
  const pending = this.pendingAnnouncements.get(conversationId);
  const workerStatus = pending
    ? Array.from(pending).map(taskId => {
        const task = this.tasks.get(taskId);
        const worker = task ? this.getWorkerById(task.agentId) : null;
        return {
          agentId: task?.agentId,
          agentName: worker?.config.name,
          lastHeartbeatAgo: worker?.lastHeartbeat
            ? Math.round((Date.now() - worker.lastHeartbeat) / 1000) + 's'
            : 'never',
        };
      })
    : [];

  sendToRenderer('agent:stream-alive', spaceId, conversationId, {
    elapsedMs: Date.now() - heartbeatStart,
    currentToolName: 'waiting_for_workers',
    pendingWorkers: workerStatus,
  });
}, 10_000);
```

### 异常处理：Worker 真正掉线

当心跳超时触发时（10 分钟无任何活动），系统应当：

1. 将任务标记为 `failed`，错误原因为 `heartbeat_timeout`
2. 将 agent 状态设为 `error`
3. 从 `pendingAnnouncements` 中移除该任务（防止 `waitForCompletion` 永久等待）
4. 通过 Leader 注入通知用户 Worker 掉线
5. 不影响其他仍在正常运行的 Worker

## 开发前必读

| 文档/源码 | 阅读目的 |
|-----------|---------|
| `src/main/services/agent/orchestrator.ts` | 核心：`waitForCompletion`（L1844-1923）、`executeAgentLocally`（L373-806）、`stallConfig`（L156-160）、`checkForStalledTasks`（L2837-2902） |
| `src/main/services/agent/persistent-worker.ts` | Worker 生命周期管理，理解 Worker 主循环和任务执行流程 |
| `src/main/services/agent/mailbox.ts` | 消息收发机制，理解 Worker 通信方式 |
| `src/main/services/agent/session-lifecycle.ts` | 会话管理，理解 session 创建/复用/清理 |
| `src/main/services/agent/hyper-space-mcp.ts` | HyperSpace MCP 协议，理解 `spawn_subagent` 和 `wait_for_team` 工具 |
| `src/main/services/agent/process-stream.ts` | 流处理核心，理解 `processStream` 中的 `markActivity` 机制（L378） |
| `.project/prd/bugfix/hyperspace-worker-abort-v1.md` | 前次修复（a80c761），了解前端 30 秒不活跃计时器问题的解决方案 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | Worker 心跳上报（10s interval）、`waitForCompletion` 移除绝对超时改为 2h 安全上限+10min 心跳超时、`stallConfig` 阈值提升至 10min/2h、stall detection 增加 session 存活二次确认、Leader 心跳 interval 同步更新 `agent.lastHeartbeat` |

## 验收标准

- [x] Leader 派发耗时 >30s 的任务不再超时误杀
- [x] Leader 派发耗时 >5min 的任务不再超时误杀（只要 Worker 心跳正常）
- [x] Worker 真正掉线（心跳停止 10 分钟）时 Leader 能正确识别并报告
- [x] Worker 执行任务期间 `agent.lastHeartbeat` 持续更新
- [x] stall detection 不再误判正常运行的 Worker 为 stalled
- [x] 现有短任务行为不受影响
- [x] 多 Worker 场景下，单个 Worker 超时不影响其他 Worker
- [x] typecheck 通过（无新增错误）
- [x] build 通过
