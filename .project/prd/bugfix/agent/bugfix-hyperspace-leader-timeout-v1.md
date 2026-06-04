# PRD [Bug 修复级] — HyperSpace Worker 权限审批等待期间前端 30 秒超时

> 版本：bugfix-hyperspace-leader-timeout-v1
> 日期：2026-06-02
> 状态：done
> 指令人：misakamikoto
> 归属模块：modules/space (features/hyper-space, worker-management)
> 优先级：P0

## 背景：与已有 PRD 的关系

- **`bugfix-hyperspace-heartbeat-queue-v1.md`（done）**：Worker 心跳不再走 injection 通道，改为 `agent:stream-alive` 事件。
- **`bugfix-hyperspace-worker-interrupt-v1.md`（done）**：stopGeneration 级联中断 Worker + deleteSpace/deleteConversation 销毁 team。

以上修复是独立的，与本次超时问题无因果关系。**心跳堆积 ≠ 超时诱因**，二者是两个独立问题、同时间段并发发生。

## 问题描述

**期望行为**：Worker（远程/本地）执行 Bash 等需权限审批的命令时，等待审批期间前端不应超时。

**实际行为**：远程 Worker 执行 Bash 命令 → SDK 发起权限审批请求 → 审批等待中 SDK 不产生流式事件 → 前端 30 秒不活跃计时器触发 → `stopGeneration` → `rejectAllPermissions` → 权限被取消 → 工具返回 "permission request cancelled or timed out" → Worker 任务失败。

**日志证据**：
```
[16:25:02] handleAgentError: AI response timed out...
[16:25:02] stopGeneration: Session found: false
[16:26:53] tool-result: "The permission request for this Bash command was cancelled or timed out:
              cat /etc/ascend_install.info 2>/dev/null; echo '---'; ls /usr/local/Ascend/ 2>/dev/null.
              The operation was not performed..."
              agentId: 'worker-1780386398213', agentName: '172'
```

**时序还原**：
1. Worker "172"（远程）执行 `cat /etc/ascend_install.info; ls /usr/local/Ascend/`
2. SDK `canUseTool` 回调触发权限审批请求（`permissionMode: 'default'`）
3. 审批等待中，SDK 不产出流式事件
4. 前端 30 秒不活跃计时器到期 → `handleAgentError` → `stopGeneration`
5. `stopGeneration` 调用 `rejectAllPermissions` → Worker 的审批 Promise 被 reject
6. 工具返回 "permission request cancelled or timed out"
7. Worker 收到错误结果，尝试继续但 Agent 已被停止

## 根因分析

### 核心：Worker 权限审批等待期间无前端保活事件

**文件**：`src/main/services/agent/sdk-config.ts`

Worker SDK 使用 `permissionMode: 'default'`（L747），Bash 等危险命令需要逐个审批。审批期间 SDK 进程阻塞在 `canUseTool` 回调，不产生流式事件。

**文件**：`src/main/services/agent/orchestrator.ts`

Worker 的 `workerHeartbeatInterval`（L2297-2299）每 10 秒更新后端 `agent.lastHeartbeat`，但**不发送任何前端事件**：

```typescript
workerHeartbeatInterval = setInterval(() => {
  agent.lastHeartbeat = Date.now();
}, 10_000);
```

Worker 的 `progressReportInterval`（60 秒）在有新 thought 时走 `queueInjection`，无新 thought 时发 `agent:stream-alive`。但 **SDK 等待权限审批时不产生新 thought**，所以 60 秒内没有 `agent:stream-alive`。

**文件**：`src/renderer/stores/chat.store.ts`

前端 `INACTIVITY_TIMEOUT_MS = 30_000`（L57），每 5 秒检查 `lastActivityAt`。30 秒内无后端事件 → 超时。

### 防御性修复（已完成）：maxInjectionCycles break 发送 agent:complete

`executeAgentLocally` 的 `maxInjectionCycles`（20）达到上限 break 时，`processStream` 因 `hasPendingInjection` 为 true 而延迟了 `agent:complete`，但 break 后不再调用 `processStream`，导致前端永远收不到 `agent:complete`。已修复：两个 break 退出点（L674-684 和 L718-726）手动发送 `agent:complete` + 清理残留 injection。

这是独立的防御性修复，不影响本次超时根因。

## 技术方案

### 修复点 A：Worker 心跳间隔同时发送前端保活事件

**文件**：`src/main/services/agent/orchestrator.ts`

将 Worker 的 `workerHeartbeatInterval`（L2297-2299）从仅更新后端 `lastHeartbeat` 改为同时发送 `agent:stream-alive` 到父会话的前端：

```typescript
// 修改前（L2297-2299）：
workerHeartbeatInterval = setInterval(() => {
  agent.lastHeartbeat = Date.now();
}, 10_000);

// 修改后：
workerHeartbeatInterval = setInterval(() => {
  agent.lastHeartbeat = Date.now();
  // Keep frontend alive during permission approval wait, tool execution, etc.
  sendToRenderer('agent:stream-alive', team.spaceId, subtask.parentConversationId, {
    elapsedMs: Date.now() - workerStartTime,
    currentToolName: `worker_${workerName}`,
  });
}, 10_000);
```

这样即使 SDK 阻塞在权限审批或长时间工具执行中，前端每 10 秒收到一次 `agent:stream-alive`，`lastActivityAt` 更新，不会触发 30 秒超时。

远程 Worker 需要同样的处理。

### 编码注意事项

- 编辑文件后必须 re-read（Windows 行尾覆盖问题）
- TypeScript strict，禁止 `any`
- `sendToRenderer` 已在 `executeLocally` 方法中 import（L2286）
- 需要在 `workerHeartbeatInterval` 的 setInterval 回调中引用 `workerStartTime` 和 `workerName`，确保在 setInterval 之前声明

## 开发前必读

| 分类 | 文件 | 关注点 / 阅读目的 |
|------|------|------|
| 核心修改 | `src/main/services/agent/orchestrator.ts` | 本地 Worker `workerHeartbeatInterval`（L2297-2299）。远程 Worker 的对应心跳逻辑。 |
| SDK 权限 | `src/main/services/agent/sdk-config.ts` | `permissionMode: 'default'`（L747）、`canUseTool`（L748-756）。理解权限审批如何阻塞 SDK 流。 |
| 前端超时 | `src/renderer/stores/chat.store.ts` | `startInactivityTimer`（L68-89）、`INACTIVITY_TIMEOUT_MS`（L57）、`handleAgentStreamAlive`（L2038-2051）。 |

## 涉及文件（实际）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | **修复 A**：本地 Worker 的 `workerHeartbeatInterval` 添加 `sendToRenderer('agent:stream-alive', ...)` 保活。远程 Worker 对应的 heartbeat 逻辑添加同样保活。**防御性修复**（已完成）：`maxInjectionCycles` break 前发送 `agent:complete` + 清理 injection。 |

## 验收标准（逐条可勾选）

- [x] **maxInjectionCycles 退出发送 agent:complete**（防御性修复，已完成）
- [x] **Worker 权限审批等待不触发超时**：Worker 执行需审批的 Bash 命令时，前端每 10 秒收到 `agent:stream-alive`，不触发 30 秒超时
- [x] **Worker 长时间工具执行不触发超时**：Worker 执行耗时工具时，前端保活心跳正常工作
- [x] **本地和远程 Worker 均受保护**：两种 Worker 类型的保活逻辑一致
- [x] **非 HyperSpace 对话不受影响**：普通对话的权限审批和超时行为不变
- [x] **类型检查通过**：`npm run typecheck` 无新增错误
- [x] **构建通过**：`npm run build` 无错误
