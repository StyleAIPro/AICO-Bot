---
timestamp: 2026-05-29
status: done
author: misakamikoto
优先级: P0
归属模块: modules/agent (orchestrator)
---

# 修复 HyperSpace Worker 硬超时误杀——processStreamTimeout 泄漏导致 Leader SDK 被终止

> 版本：bugfix-worker-hard-timeout-v2
> 优先级：P0
> 归属模块：modules/agent (orchestrator)
> 前置：bugfix-worker-hard-timeout-v1（done，修复了 waitForCompletion 的绝对超时和心跳阈值，但未触及根本原因）

## 需求分析

### 问题描述

HyperSpace Leader 向 Worker 下发任务后，约 30 分钟后报错 "Claude Code process aborted by user"。Worker 此时仍在正常执行，但 Leader 的 SDK 子进程已被强制终止。

### 影响

1. **任务前功尽弃**：Worker 已执行 30 分钟的工作因 Leader 被杀而全部丢失
2. **用户困惑**：错误信息 "aborted by user" 暗示用户主动取消，但用户并未操作
3. **HyperSpace 可靠性丧失**：任何超过 30 分钟的并行任务注定失败，严重限制 HyperSpace 的实用价值

### 复现步骤

1. 创建 Hyper Space（Leader + Worker）
2. Leader 通过 `spawn_subagent` 向 Worker 派发耗时任务（如大型代码重构，预计 30-60 分钟）
3. Worker 开始执行，Leader 进入 `waitForCompletion` 等待
4. 约 30 分钟后 Leader 日志出现 "processStream timed out after 1800s"
5. `abortController.abort()` 被调用 → SDK 子进程收到 SIGABRT → "Claude Code process aborted by user"

### 前次修复（v1）的局限

v1 修复了 `waitForCompletion` 自身的超时问题（移除绝对超时，改为 2h 安全上限 + 10min 心跳），但未触及真正的根因：**30 分钟 `processStreamTimeout` 的 `Promise.race` 计时器泄漏**。即使 `waitForCompletion` 已有心跳保活机制，外层的 `processStreamTimeout` 仍然会在 30 分钟时触发并杀死 Leader。

## 根因分析

### 缺陷定位：`orchestrator.ts` L549-644

`executeAgentLocally` 的 `while(true)` 主循环中，`Promise.race` 同时包裹了：

1. **`processStream()` 调用**（L549-622）
2. **一个 30 分钟超时 Promise**（L623-628）

```typescript
// L549-644（简化）
const streamResult = await Promise.race([
  processStream({ ... }),                                          // 分支 1
  new Promise<never>((_, reject) =>                                // 分支 2
    setTimeout(() => reject(new Error('processStream timed out after 1800s')),
               this.processStreamTimeout),                         // 30 min
  ),
]).catch(async (err) => {
  if (err.message.includes('timed out')) {
    abortController.abort();  // ← 杀死 Leader SDK 子进程
    return { ... };
  }
  throw err;
});
```

### 缺陷机制

1. **`processStream()` 自然返回**：Leader LLM 完成当前 turn（调用 `spawn_subagent` 后停止生成），SDK 的 `for await` 循环正常结束。

2. **超时计时器仍在运行**：`Promise.race` 用 `setTimeout` 创建了一个 30 分钟定时器。`processStream` 先获胜后，**`setTimeout` 创建的定时器从未被 `clearTimeout`**，它仍然在后台倒计时。

3. **`waitForCompletion()` 进入等待**：orchestrator 检测到 pending workers，在 L734 调用 `await this.waitForCompletion()`。此时已经离开了 `Promise.race` 的 `.catch` 链，但那个 30 分钟定时器仍在 Node.js 事件循环中。

4. **定时器触发**：当 Worker 执行超过 `processStreamTimeout` 减去 `processStream` 已消耗时间的剩余时间时，`reject` 被调用。虽然 `streamResult` 已被赋值，`await Promise.race` 已完成，但 `.catch` 内的 `abortController.abort()` **在微任务队列中执行**——`abortController` 仍然是 Leader SDK 进程的控制器。

5. **Leader SDK 被杀**：`abortController.abort()` → SDK 子进程收到 SIGABRT → 抛出 "Claude Code process aborted by user"。

### 错误链路图

```
processStream() 返回
  ↓
waitForCompletion() 开始等待 Worker（L734）
  ↓ （同时，后台 setTimeout 仍在倒计时）
30 分钟到达
  ↓
setTimeout reject 触发 → .catch handler 执行
  ↓
abortController.abort() → SDK 进程收到 SIGABRT
  ↓
SDK 抛出 "Claude Code process aborted by user"
  ↓
wait_for_team 的 tool permission stream 被关闭
  → "Tool permission stream closed before response received"
```

### 为什么 v1 没修到

v1 修复了 `waitForCompletion` 内部的超时逻辑（移除绝对超时，改用 10min 心跳 + 2h 安全上限），使得 `waitForCompletion` 本身不会因为 Worker 执行时间长而超时。但 `waitForCompletion` 的超时机制与外层 `processStreamTimeout` 是**独立的两个问题**：

- v1 修的：`waitForCompletion` 不会因为等待太久而 reject
- v2 需修的：外层 `processStreamTimeout` 的定时器泄漏，即使 `waitForCompletion` 愿意等，`abortController` 也会被杀

## 技术方案

### 策略：将 `processStreamTimeout` 只包裹 `processStream()`，不包裹 `waitForCompletion`

在 `while(true)` 循环中，将 `Promise.race` 的范围缩小，只包裹 `processStream()` 调用本身。`waitForCompletion()` 移到 `Promise.race` 之外独立 await。

### 具体修改

**文件**：`src/main/services/agent/orchestrator.ts`

#### 修改 1：`processStream()` 返回后清除超时计时器

在 L549-644 区域，将 `Promise.race` 改为可清除定时器的结构：

```typescript
// 修改前（L549-644）
const streamResult = await Promise.race([
  processStream({ ... }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(...), this.processStreamTimeout),
  ),
]).catch(async (err) => {
  if (err.message.includes('timed out')) {
    abortController.abort();
    return { ... };
  }
  throw err;
});

// 修改后
let timeoutId: NodeJS.Timeout | null = null;
const streamResult = await Promise.race([
  processStream({ ... }),
  new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`processStream timed out after ${this.processStreamTimeout / 1000}s`)),
      this.processStreamTimeout,
    );
  }),
]).catch(async (err: unknown) => {
  // 无论谁赢，都清除定时器
  if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  if (err instanceof Error && err.message.includes('timed out')) {
    console.error(`[Orchestrator] ${err.message}, aborting and continuing`);
    try { abortController.abort(); } catch {}
    const { hasPendingInjection } = await import('./stream-processor');
    return {
      finalContent: '',
      thoughts: [],
      tokenUsage: undefined,
      hasPendingInjection: hasPendingInjection(conversationId),
      interrupted: true,
      errorThought: undefined,
    } as unknown as Awaited<ReturnType<typeof processStream>>;
  }
  throw err;
});
// 确保 processStream 胜出时定时器也被清除
if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
```

关键变化：
- 将 `setTimeout` 返回的 `timeoutId` 保存到变量
- `processStream` 正常返回后，立即 `clearTimeout`，定时器不再泄漏到 `waitForCompletion` 阶段
- 超时分支（`processStream` 真的卡死 30 分钟）行为不变

#### 修改 2（可选优化）：在进入 `waitForCompletion` 前重置超时

由于修改 1 已清除旧定时器，`waitForCompletion` 不再受 `processStreamTimeout` 影响。`waitForCompletion` 内部已有自己的超时逻辑（10 分钟心跳 + 2 小时绝对上限），无需额外处理。

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | L549-654：`processStreamTimeout` 定时器 `setTimeout` 返回值保存到 `psTimeoutId`，`processStream` 正常返回后 `clearTimeout`，超时路径也清除 |

## 验收标准

- [ ] Leader 派发任务后等待 Worker 超过 30 分钟不再出现 "Claude Code process aborted by user"
- [ ] Worker 执行期间 Leader 保持存活（心跳正常）
- [ ] Worker 真正掉线（心跳超时 10 分钟）时 Leader 能通过 `waitForCompletion` 的心跳超时正确识别
- [ ] `processStream` 本身卡死超过 30 分钟时，超时机制仍然有效（abort + 继续）
- [ ] 现有短任务行为不受影响
- [x] typecheck 通过（orchestrator.ts 无新增错误，已有错误来自 main 合并的知识图谱功能）
- [x] build 通过

## 开发前必读

| 文档/源码 | 阅读目的 |
|-----------|---------|
| `src/main/services/agent/orchestrator.ts` | 核心：`executeAgentLocally` 的 while 循环（L549-644）、`processStreamTimeout`（L150-151）、`waitForCompletion`（L1863-1939） |
| `.project/prd/bugfix/hyperspace/bugfix-worker-hard-timeout-v1.md` | 前次修复（done），了解已修的 waitForCompletion 超时问题 |
| `src/main/services/agent/process-stream.ts` | 流处理核心，理解 `processStream` 的完成和超时行为 |
| `src/main/services/agent/hyper-space-mcp.ts` | `wait_for_team` MCP 工具实现，理解 tool permission stream 关闭的错误链路 |
