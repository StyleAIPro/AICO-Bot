# PRD [Bug 修复级] — HyperSpace Leader 假超时误杀 Worker 会话

> 版本：bugfix-hyperspace-worker-abort-v1
> 日期：2026-05-28
> 状态：done
> 指令人：用户
> 归属模块：modules/space (features/hyper-space)
> 优先级：P0

## 问题描述

- **期望行为**：Worker 执行长时间任务时，Leader 应持续等待直到 Worker 完成或真正的网络/SDK 错误发生
- **实际行为**：Worker 执行任务期间，Leader 页面频繁报错「Claude Code process aborted by user」，Worker 随后处于掉线状态无法连接
- **复现步骤**：
  1. 创建 Hyper Space（Leader + Worker）
  2. Leader 通过 `spawn_subagent` 分派任务给 Worker
  3. Worker 开始执行较长时间的任务（如运行 Bash 命令、代码重构）
  4. 约 30 秒后 Leader 页面出现错误「Claude Code process aborted by user」
  5. Worker 变为掉线/无法连接状态

## 根因分析

### 根因 1（PRIMARY）：前端 30 秒不活跃计时器误杀 Leader 会话

**文件**：`src/renderer/stores/chat.store.ts:56-89`

前端在发送消息时启动 30 秒不活跃计时器（`INACTIVITY_TIMEOUT_MS = 30_000`）。每 5 秒检查 `lastActivityAt`，超过 30 秒无事件则调用 `api.stopGeneration()` 杀掉会话。

**问题**：当 Leader 调用 `spawn_subagent`/`wait_for_team` 或 orchestrator 自动等待 Worker 完成时，Leader 的 `processStream` 处于阻塞/等待状态，**不向前端发送任何事件**。Worker 的事件虽然到达前端但走 worker 路径，不更新父 session 的 `lastActivityAt`。

关键缺失路径：

| 事件处理器 | worker 路径是否更新 `lastActivityAt` | 代码位置 |
|-----------|--------------------------------------|---------|
| `handleAgentMessage` | **否** — line 1848 直接 return | L1797-1848 |
| `handleAgentThought` | 是 — fall-through 更新 | L2360-2387 |
| `handleAgentThoughtDelta` | 是 — fall-through 更新 | L2492-2549 |
| `handleAgentStreamAlive` | 无 worker 路径 | L2011-2025 |

但即使 `handleAgentThought` 的 fall-through 更新了 `lastActivityAt`，Worker 执行长 Bash 命令时可能连续 30+ 秒不产生任何 thought 事件（SDK 阻塞在工具执行中），计时器仍会触发。

### 根因 2（SECONDARY）：本地 session 无心跳机制

**文件**：`src/main/services/agent/send-message-remote.ts:725-727`

远程 session 有 `stream:alive` 心跳事件，定期通知前端后端仍在运行。但本地 session（Hyper Space Leader 使用 `processStream`）**完全没有心跳机制**。Leader 的 `processStream` 阻塞在 `for await` 循环中等待 SDK 消息，不会主动发送心跳。

### 根因 3（CONTRIBUTING）：`handleAgentMessage` worker 路径不更新 `lastActivityAt`

**文件**：`src/renderer/stores/chat.store.ts:1797-1848`

Worker 的 `agent:message` 事件在 line 1848 直接 return，不更新父 session 的 `lastActivityAt`。与 `handleAgentThought` 的 fall-through 行为不一致。

## 技术方案

### 策略：双重防护

1. **后端心跳**：orchestrator 在 Leader 等待 Worker 期间发送 `agent:stream-alive` 心跳
2. **前端容错**：worker 事件也更新父 session 的 `lastActivityAt`

### 步骤 1：orchestrator 添加 Leader 等待期间的心跳

**文件**：`src/main/services/agent/orchestrator.ts`

在 `executeAgentLocally` 的 while(true) 循环中，添加心跳定时器：

1. 在 while 循环开始前启动 10 秒间隔的 `setInterval`
2. 每次心跳发送 `agent:stream-alive` 事件到前端，包含 `elapsedMs` 和 `currentToolName`
3. while 循环结束时清除定时器
4. 心跳内容包括：当前等待的 Worker 数量（让前端知道 Leader 在忙）

### 步骤 2：`handleAgentMessage` worker 路径更新 `lastActivityAt`

**文件**：`src/renderer/stores/chat.store.ts`

在 `handleAgentMessage` 的 worker 路径中（line 1797-1848），在 `return` 前更新父 session 的 `lastActivityAt`。

## 开发前必读

| 分类 | 文件 | 关注点 |
|------|------|--------|
| 不活跃计时器 | `src/renderer/stores/chat.store.ts` | L56-89 `startInactivityTimer`、L1561 启动点、L1797-1848 `handleAgentMessage` worker 路径 |
| 心跳事件 | `src/renderer/stores/chat.store.ts` | L2011-2025 `handleAgentStreamAlive` — 更新 `lastActivityAt` |
| 远程心跳参考 | `src/main/services/agent/send-message-remote.ts` | L725-727 远程 session 的 `stream:alive` 处理 |
| orchestrator 主循环 | `src/main/services/agent/orchestrator.ts` | L373-760 `executeAgentLocally` while(true) 循环 |
| 会话控制 | `src/main/services/agent/control.ts` | `stopGeneration` — 被计时器调用后的中断链 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | `executeAgentLocally` 添加 Leader 等待期间心跳 |
| `src/renderer/stores/chat.store.ts` | 修改 | `handleAgentMessage` worker 路径更新 `lastActivityAt` |

## 验收标准

1. **长任务不再误杀**：Worker 执行 30 秒以上的任务时，Leader 不会出现「aborted by user」错误
2. **心跳可见**：Leader 等待 Worker 期间，前端 `lastActivityAt` 持续更新
3. **Worker 不掉线**：Worker 完成任务后结果正常注入 Leader
4. **普通对话不受影响**：非 Hyper Space 场景的行为不变
5. **类型检查通过**：`npm run typecheck` 无新增错误
6. **构建通过**：`npm run build` 无错误
