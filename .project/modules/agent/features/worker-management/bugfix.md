# Bug 记录 -- 持久化 Worker 与任务板

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 0 |
| Minor | 0 |

## 已修复

### BUG-001：mailbox writeMailboxFileAtomic 非原子写入 + 并发数据丢失

- **修复日期**：2026-05-28
- **严重程度**：Critical
- **文件**：`src/main/services/agent/mailbox.ts`
- **问题**：`writeMailboxFileAtomic` 使用 `writeFileSync` 而非 `renameSync`，不是原子操作。`postMessage`/`pollMessages` 无文件锁，并发读写会丢消息。
- **修复**：改用 `renameSync`（NTFS 原子）；新增 `writeMailboxWithRetry` 通过 mtime 检测并发写入并重试。

### BUG-002：消息大小无限制导致邮箱膨胀/卡死

- **修复日期**：2026-05-28
- **严重程度**：Major
- **文件**：`src/main/services/agent/mailbox.ts`, `src/main/services/agent/stream-injection.ts`, `src/main/services/agent/orchestrator.ts`
- **问题**：整个消息管道无大小验证，Worker 返回大结果可能导致 mailbox 文件膨胀、SDK 消息缓冲区溢出。
- **修复**：mailbox 消息 100KB 限制、注入消息 200KB 限制、Worker result 50KB 限制，超出自动截断。

### BUG-003：mailbox 文件无限增长

- **修复日期**：2026-05-28
- **严重程度**：Major
- **文件**：`src/main/services/agent/mailbox.ts`
- **问题**：消息只追加不修剪，broadcast 消息不断积累导致文件越来越大。
- **修复**：新增 `pruneMessages` 自动修剪，保留最近 100 条，同时修正 `lastReadIndex` 游标。

### BUG-004：pollMessages 静默吞掉错误

- **修复日期**：2026-05-28
- **严重程度**：Major
- **文件**：`src/main/services/agent/mailbox.ts`, `src/main/services/agent/persistent-worker.ts`
- **问题**：`pollMessages` 出错时返回空数组，mailbox 损坏后 Worker 永远收不到消息且无任何提示。
- **修复**：`pollMessages` 现在抛出异常；`persistent-worker` 增加 try/catch 包裹 poll 调用 + 定期 mailbox 健康检查。

### BUG-005：processStream 无超时保护

- **修复日期**：2026-05-28
- **严重程度**：Major
- **文件**：`src/main/services/agent/orchestrator.ts`
- **问题**：Leader 的 while(true) 循环中 `processStream` 无超时，SDK 进程挂起时整个 Leader 循环永久阻塞。
- **修复**：`Promise.race` 包裹 `processStream` + 30 分钟超时，超时后 abort 并继续循环。

### BUG-006：spawn_subagent 错误不通知 Leader

- **修复日期**：2026-05-28
- **严重程度**：Major
- **文件**：`src/main/services/agent/hyper-space-mcp.ts`
- **问题**：`executeAllTasks` 是 fire-and-forget，错误只 console.error，Leader 收到"任务已派发"但实际可能立即失败。
- **修复**：catch 中通过 `injectMessageToSession` 通知 Leader 任务执行失败。

### BUG-007：executeLocally 未注册 activeSession 导致 Worker 被静默杀死

- **修复日期**：2026-05-28
- **严重程度**：Critical
- **文件**：`src/main/services/agent/orchestrator.ts`
- **问题**：`executeLocally` 未调用 `registerActiveSession`，导致：`invalidateAllSessions()` 无条件关闭 Worker session、健康检查无法检测 Worker 状态、`stopGeneration()` 无法中断 Worker。Worker 端完全无回显。
- **修复**：`executeLocally` 中添加 `registerActiveSession` + 完成时 `unregisterActiveSession`；Worker `processStream` 添加 30 分钟超时保护。

### BUG-008：handleAgentThoughtDelta 丢失 Worker 思考过程

- **修复日期**：2026-05-28
- **严重程度**：Major
- **文件**：`src/renderer/stores/chat.store.ts`
- **问题**：`handleAgentThoughtDelta` 缺少 auto-create（L2382），且 `thoughtIndex === -1` 时直接 return（L2385）。IPC 事件乱序时（thought-delta 早于 worker:started 或 agent:thought），所有思考过程和流式输出被静默丢弃。此外所有 auto-create 逻辑缺少 `childConversationId`，导致 WorkerView 无法加载历史消息。
- **修复**：提取 `createTemporaryWorkerSession` 辅助函数统一 3 处 auto-create；`handleAgentThoughtDelta` 添加 auto-create + thought 占位；所有临时 session 包含 `childConversationId`。

### BUG-009：worker:started 到达时清空 Worker 已有思考过程

- **修复日期**：2026-05-28
- **严重程度**：Critical
- **文件**：`src/renderer/stores/chat.store.ts`
- **问题**：`handleWorkerStarted` 用 `isTemporarySession = existing && !existing.childConversationId` 判断是否保留已有内容。但 `createTemporaryWorkerSession` 总是设置 `childConversationId`，导致 `isTemporarySession` 始终为 `false`，`thoughts: []` 无条件覆盖清空已有思考过程。
- **修复**：`thoughts` 和 `streamingContent` 改为始终保留已有值。

### BUG-010：Leader 中断恢复丢失 Worker 上下文

- **修复日期**：2026-05-28
- **严重程度**：Major
- **文件**：`src/main/services/agent/orchestrator.ts`, `src/renderer/stores/chat.store.ts`, `src/shared/types/hyper-space.ts`
- **问题**：Leader 流中断后点击「继续」只发送纯文本 `"continue"`，不含 Worker 任务状态。大任务场景下 Leader LLM 完全丢失上下文，不知道 Worker 在执行什么、哪些已完成。
- **修复**：orchestrator 中断时收集 Worker 上下文（running + completed）通过 `agent:interrupt-context` 事件传递到前端；前端保存到 session state；`continueAfterInterrupt` 恢复时将 Worker 状态注入消息；同时预消费遗留 injection 队列。
