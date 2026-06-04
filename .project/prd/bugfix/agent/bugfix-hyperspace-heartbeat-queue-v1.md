# PRD [Bug 修复级] — HyperSpace Worker 心跳消息堆积导致 LLM 调用量暴增 & Leader 超时误报

> 版本：bugfix-hyperspace-heartbeat-queue-v1
> 日期：2026-06-02
> 状态：done
> 指令人：misakamikoto
> 归属模块：modules/space (features/hyper-space, worker-management)
> 优先级：P0

## 背景

AICO-Bot 是一个 Electron 桌面应用，HyperSpace 功能允许 Leader Agent 管理 Worker Agent。Worker 每 60 秒通过 `queueInjection` 向 Leader 发送进度心跳消息，告知 Leader "Worker 仍在执行任务"。

## 问题描述

Worker 心跳消息通过 `queueInjection` 入队到 `pendingInjectionQueues`，每条心跳被 Leader 的 `while(true)` 循环消费后，会触发一次完整的 `processStream` 调用（即一轮 LLM 交互）。这导致：

1. **队列无限增长**：3 个 Worker 每 60s 各发一条心跳 = 3 条/分钟，长时间运行堆积到 500+ 条
2. **每条心跳触发一次 LLM 谮用量**：消费一条心跳 → processStream → LLM 生成回复 → 消费下一条 → ...，500 条 = 500 次 LLM 调用，严重浪费 token
3. **Leader 超时误报**：Leader 在反复消费心跳 injection 之间可能出现 30s 无事件的间隙，触发前端 `INACTIVITY_TIMEOUT_MS`（30 秒）超时
4. **stopGeneration 后队列不清理**：用户停止后，已排队的心跳仍留在队列中，下次启动时可能被消费
5. **日志污染**：每条心跳产生一条 `Queued injection message` 日志，500 条 = 500 行无意义日志

## 根因分析

### 问题 1：心跳不应走 injection 通道

**文件**：`src/main/services/agent/orchestrator.ts`

心跳消息的设计初衷是让 Leader LLM 知道 Worker 还活着。但 `queueInjection` 是为"Worker 完成任务后注入结果"设计的，每条 injection 触发一轮完整 LLM 交互。心跳消息是"无需回复"的（`[Worker 进度心跳 - 无需回复]`），不应该触发 LLM 调用。

**本地 Worker 心跳**（L2294-2321）：

```typescript
progressReportInterval = setInterval(() => {
  // ...
  summary = `[Worker 进度心跳 - 无需回复] Worker "${workerName}" 仍在执行任务，暂无新的工具调用。`;
  queueInjection(parentConvId, { content: summary });  // <- 错误：走 injection 通道
}, 60_000);
```

**远程 Worker 心跳**（L2705-2731）：

```typescript
remoteProgressInterval = setInterval(() => {
  // ...
  summary = `[Worker 进度心跳 - 无需回复] Worker "${remoteWorkerName}" (远程) 仍在执行任务，暂无新的工具调用。`;
  queueInjection(parentConvId, { content: summary });  // <- 同样错误
}, 60_000);
```

### 问题 2：injection queue 无 TTL、无上限

**文件**：`src/main/services/agent/stream-injection.ts`

`queueInjection` 直接 push 到数组，无任何限制：

```typescript
export function queueInjection(conversationId: string, options: QueueInjectionOptions): void {
  const queue = pendingInjectionQueues.get(conversationId) || [];
  queue.push({ content: truncateIfNeeded(options.content), ... });
  // 无 TTL 检查、无上限限制
}
```

### 问题 3：stopGeneration 不清理 injection 队列

**文件**：`src/main/services/agent/control.ts`

`stopGeneration` 中没有调用 `clearInjectionsForConversation`。虽然上一轮修复中 `interruptWorkersForConversation` 会清理，但只在 HyperSpace 路径中。

## 技术方案

### 方案概述

**核心思路**：心跳消息不应走 injection 通道。改为只更新 `lastActivityAt` 和渲染器状态（前端已处理 `agent:stream-alive`），不触发 LLM 交互。同时给 injection queue 添加 TTL 和容量上限保护。

### 修复点 A：心跳消息不再走 queueInjection（根本修复）

**文件**：`src/main/services/agent/orchestrator.ts`

**本地 Worker**（L2294-2321 的 `progressReportInterval`）和**远程 Worker**（L2705-2731 的 `remoteProgressInterval`）：

将心跳逻辑从 `queueInjection` 改为 `sendToRenderer`。心跳消息仅通知前端更新 WorkerPanel 状态（更新 `lastActivityAt`），不再注入 Leader 的 LLM 上下文。

具体改动：
1. 对"无新工具调用"的心跳（`[Worker 进度心跳 - 无需回复]`）：改为 `sendToRenderer('agent:stream-alive', spaceId, parentConvId, { elapsedMs, currentToolName: 'worker_${agentName}' })`，前端通过已有的 `agent:stream-alive` 事件更新 `lastActivityAt`，复用现有前端处理逻辑。**不再调用 `queueInjection`**。
2. 对"有新工具调用"的进度汇报（`[Worker 进度汇报 - 无需回复]`）：**保留**走 `queueInjection`，因为包含实际的工具使用信息，Leader LLM 需要知道。但添加 TTL 检查（见修复点 B）。

### 修复点 B：injection queue 添加 TTL 和容量保护

**文件**：`src/main/services/agent/stream-injection.ts`

1. **TTL 过期策略**：给每条 injection 添加 `queuedAt` 时间戳。消费时（`getAndClearInjection`）跳过超过 N 分钟（建议 10 分钟）的消息。心跳类消息已不走此通道，此保护是兜底。
2. **容量上限**：`queueInjection` 时检查队列长度，超过阈值（建议 30 条）时丢弃最旧的消息（FIFO 淘汰）。
3. **新增 `purgeExpiredInjections(conversationId)` 方法**：在 `stopGeneration` 和 `interruptWorkersForConversation` 中调用。

### 修复点 C：stopGeneration 清理 injection 队列

**文件**：`src/main/services/agent/control.ts`

在 `stopGeneration` 有参路径中，abort session 后调用 `clearInjectionsForConversation(conversationId)` 清理该对话的所有排队消息。

在无参路径（停止所有）中，遍历所有活跃对话清理。

### 修复点 D：前端接收心跳事件（已可复用，无需新增）

可复用已有的 `agent:stream-alive` 事件格式，心跳直接发送 `sendToRenderer('agent:stream-alive', spaceId, parentConvId, { elapsedMs, currentToolName: 'worker_${agentName}' })`，前端已有处理逻辑会更新 `lastActivityAt`。

不需要改前端代码，此修复点可省略。

## 编码注意事项

- 编辑文件后必须 re-read（Windows 行尾覆盖问题）
- TypeScript strict，禁止 `any`（用 `unknown`），纯类型导入用 `import type`
- 一 PRD 一 commit

## 开发前必读

| 分类 | 文件 | 关注点 / 阅读目的 |
|------|------|------|
| 核心修改 | `src/main/services/agent/orchestrator.ts` | 本地 Worker 心跳（L2288-2321）、远程 Worker 心跳（L2696-2731）。将无新工具调用的心跳改为 `sendToRenderer` 而非 `queueInjection` |
| Injection 队列 | `src/main/services/agent/stream-injection.ts` | `queueInjection`（L66）、`getAndClearInjection`（L84）。添加 TTL + 容量保护 |
| stop 清理 | `src/main/services/agent/control.ts` | `stopGeneration`（L25 起）。添加 `clearInjectionsForConversation` 调用 |
| 前端超时 | `src/renderer/stores/chat.store.ts` | `startInactivityTimer`（L68）、`INACTIVITY_TIMEOUT_MS`（L57）、`handleAgentStreamAlive`（L2038）。理解 `lastActivityAt` 更新机制 |
| 前端事件 | `src/renderer/api/transport.ts` | `agent:stream-alive` 事件映射（L300）。确认可复用 |

## 涉及文件（实际）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | **修复 A**：本地/远程 Worker 的"无新工具调用"心跳从 `queueInjection` 改为 `sendToRenderer('agent:stream-alive', ...)` |
| `src/main/services/agent/stream-injection.ts` | 修改 | **修复 B**：`PendingInjection` 添加 `queuedAt`；`queueInjection` 容量上限 30 条；`getAndClearInjection` 跳过过期消息（10 分钟 TTL）；新增 `purgeExpiredInjections` |
| `src/main/services/agent/control.ts` | 修改 | **修复 C**：`stopGeneration` 有参/无参路径均清理 injection 队列 |

## 验收标准（逐条可勾选）

- [x] **心跳不再走 injection 通道**："无新工具调用"的心跳消息不再通过 `queueInjection` 入队，改为 `sendToRenderer` 直接更新前端
- [x] **injection queue 有 TTL**：超过 10 分钟的 injection 消息在消费时被自动丢弃
- [x] **injection queue 有容量上限**：单对话队列超过 30 条时，丢弃最旧的消息
- [x] **stopGeneration 清理队列**：停止生成时清空该对话的所有排队消息
- [x] **日志不再被心跳刷屏**：无新工具调用的心跳不再产生 `Queued injection message` 日志
- [x] **有新工具调用的进度汇报仍走 injection**：包含工具使用信息的进度汇报继续通过 `queueInjection` 发送给 Leader
- [x] **前端 lastActivityAt 正确更新**：心跳通过 `agent:stream-alive` 更新前端计时器，不触发 30 秒超时
- [x] **非 HyperSpace 对话不受影响**：普通对话的 injection 机制不变
- [x] **类型检查通过**：`npm run typecheck` 无新增错误
- [x] **构建通过**：`npm run build` 无错误
