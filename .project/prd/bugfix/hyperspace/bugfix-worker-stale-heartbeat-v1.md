---
title: "Bugfix: Worker 任务完成后残留进度心跳导致 Leader 回复无关内容"
level: bugfix
priority: P2
module: modules/agent (orchestrator)
status: done
author: misakamikoto
timestamp: 2026-05-30
---

# Bugfix: Worker 任务完成后残留进度心跳导致 Leader 回复无关内容

## Bug 描述

HyperSpace Worker 任务完成后，60 秒进度心跳仍在运行，残留的注入消息被 Leader 当作正常消息处理，导致 Leader LLM 回复"残留心跳，忽略。如有新任务请随时指示。"等无关内容。Worker 应在任务完成后立即停止任务级心跳，只保持连接级心跳。

## 复现步骤

1. Leader 分配任务给 Worker
2. Worker 执行任务，进度心跳正常运行
3. Worker 任务完成，`processStream` 返回
4. 60 秒内，残留的 `progressReportInterval` 再次 tick
5. 残留心跳注入 Leader 会话
6. Leader LLM 回复无关内容

## 根因分析

### 核心问题：progressReportInterval 清理时机滞后 + 注入队列无任务过滤

**文件**：`src/main/services/agent/orchestrator.ts`

#### 缺陷 1：进度心跳清理在 finally 块，而非任务完成时

本地 Worker 的 `progressReportInterval`（L2201-2234）每 60 秒调用 `queueInjection(parentConvId, { content: summary })` 注入进度消息。该 interval 在 `finally` 块（L2364）清除。但 Worker 任务在 `processStream` 返回时就已完成（L2299），`finally` 在后续清理代码执行后才运行。存在时间窗口：最后一次 interval tick 可能发生在任务完成之后、finally 之前。

远程 Worker 同样存在此问题：`remoteProgressInterval`（L2613-2639）在 `finally`（L2749）清除。

#### 缺陷 2：注入队列无任务元数据

`stream-injection.ts` 的 `queueInjection` 是简单 FIFO 队列，无 taskId 标签。Leader 的 while 循环消费队列时（L669-696）无法区分"任务完成后的残留心跳"和"正常消息"。

#### 缺陷 3：任务完成后无队列清理

Worker 任务完成时（`sendAnnouncement` L1754-1798），从 `pendingAnnouncements` 中移除任务，但不清理该 Worker 已排入队列的残留心跳注入。

## 技术方案

### 策略：任务完成时即时清除进度 interval + 标记并过滤残留注入

#### 修改 1：提前清除 progressReportInterval（本地 Worker）

**文件**：`src/main/services/agent/orchestrator.ts`

在本地 Worker `executeOnSingleAgent` 的 `processStream` 返回后（L2299 附近），立即 `clearInterval(progressReportInterval)`，而不是等 finally 块。同样对 `workerHeartbeatInterval` 可以提前清除。

```typescript
// 在 processStream 返回后、sendAnnouncement 之前
if (progressReportInterval) { clearInterval(progressReportInterval); progressReportInterval = null; }
if (workerHeartbeatInterval) { clearInterval(workerHeartbeatInterval); workerHeartbeatInterval = null; }
```

#### 修改 2：提前清除 remoteProgressInterval（远程 Worker）

在远程 Worker `executeRemotely` 的 stream 结束后（L2686 附近），立即清除 `remoteProgressInterval`。

#### 修改 3：为注入消息添加 taskId 标签

**文件**：`src/main/services/agent/stream-injection.ts`

修改 `InjectionMessage` 类型，添加可选 `taskId` 字段：

```typescript
interface InjectionMessage {
  content: string;
  taskId?: string;  // 关联的任务 ID，用于过滤残留消息
  type?: 'progress' | 'announcement' | 'result';  // 注入类型
}
```

#### 修改 4：Leader 消费队列时过滤已完成任务的残留心跳

**文件**：`src/main/services/agent/orchestrator.ts`

在 Leader 的 while 循环消费注入时（L669-696），检查注入消息的 taskId。如果该 task 已完成（不在 `pendingAnnouncements` 中且 task status 为 completed/failed），跳过该注入。

```typescript
// 在 getAndClearInjection 后
if (injection.taskId && injection.type === 'progress') {
  const task = this.tasks.get(injection.taskId);
  if (task && (task.status === 'completed' || task.status === 'failed')) {
    log.debug(`Skipping stale progress heartbeat for completed task ${injection.taskId}`);
    continue;
  }
}
```

### 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | 本地 Worker（L2301-2304）和远程 Worker（L2691-2693）任务完成后立即 clearInterval progressReportInterval，不再等 finally 块 |

## 验收标准

- [ ] Worker 任务完成后不再产生进度心跳注入
- [ ] Leader 不再回复"残留心跳，忽略"等无关内容
- [ ] 任务完成后 Worker 连接保持正常（WebSocket/SSH 不中断）
- [ ] 现有正常进度心跳行为不受影响
- [x] typecheck 通过（无新增错误）
- [x] build 通过

## 开发前必读

| 文档/源码 | 阅读目的 |
|-----------|---------|
| `src/main/services/agent/orchestrator.ts` | 核心：本地/远程 Worker 的 progressReportInterval、executeOnSingleAgent/executeRemotely 的完成处理、Leader while 循环的注入消费 |
| `src/main/services/agent/stream-injection.ts` | 注入队列的数据结构和操作 |
| `.project/prd/bugfix/hyperspace/bugfix-worker-hard-timeout-v2.md` | 前次修复，了解 processStreamTimeout 定时器泄漏的解决方案 |

## 元信息

```
timestamp: 2026-05-30
status: draft
author: misakamikoto
优先级: P2
归属模块: modules/agent (orchestrator)
```
