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

### BUG-011：Leader 30 秒假超时误杀 Worker 会话

- **修复日期**：2026-05-28
- **严重程度**：Critical
- **文件**：`src/main/services/agent/orchestrator.ts`, `src/renderer/stores/chat.store.ts`
- **问题**：Leader 等待 Worker 执行期间不发送前端事件，30 秒不活跃计时器触发后调用 `stopGeneration()` 杀掉 Leader 会话，导致 Worker 掉线。根因：本地 session 无心跳机制 + `handleAgentMessage` worker 路径不更新 `lastActivityAt`。
- **修复**：orchestrator 在 `executeAgentLocally` while 循环期间每 10 秒发送 `agent:stream-alive` 心跳；`handleAgentMessage` worker 路径更新父 session 的 `lastActivityAt`。

### BUG-012：Leader 因 activeSessions key 不匹配 + onComplete 过早注销被 idle 清理杀死

- **修复日期**：2026-05-29
- **严重程度**：Critical
- **文件**：`src/main/services/agent/orchestrator.ts`
- **问题**：双重根因。(A) `executeAgentLocally` 用 childConversationId 存 V2 session，却用 parent conversationId 注册 `activeSessions`，`invalidateAllSessions` 的在途保护失效。(B) `onComplete` 在每轮 `processStream` 结束时注销 `activeSessions`，但 orchestrator while 循环可能还在 `waitForCompletion` 中等 worker（30+ 分钟），此时 `activeSessions` 为空 → session-health 的 30 分钟 idle cleanup 命中 → `cleanupSession` → SDK `close()` 5 秒后 `abort()`。与 BUG-011（前端计时器）是不同根因路径。
- **修复**：(A) 追加 `registerActiveSession(childConversationId, sessionState)` 双 key 注册。(B) 将 `unregisterActiveSession` 从 `onComplete` 移到 while 循环的 `finally` 块，确保整个生命周期（含 `waitForCompletion`）期间 activeSessions 始终有效。

### BUG-013：processStreamTimeout 定时器泄漏导致 Leader 等待 Worker 时 30 分钟被 SDK abort

- **修复日期**：2026-05-29
- **严重程度**：Critical
- **文件**：`src/main/services/agent/orchestrator.ts`
- **问题**：`executeAgentLocally` 的 `Promise.race` 中 `processStreamTimeout`（30 分钟）的 `setTimeout` 返回值未保存。当 `processStream` 正常返回（Leader turn 结束）后进入 `waitForCompletion` 等待 Worker 时，该定时器仍在事件循环中泄漏。约 30 分钟后定时器触发，产生未处理的 promise rejection，且可能通过 `abortController` 链路导致 SDK 子进程被杀（"Claude Code process aborted by user"）。
- **修复**：保存 `setTimeout` 返回值到 `psTimeoutId`，`processStream` 正常返回后立即 `clearTimeout`，超时路径也清除。

### BUG-014：Worker 任务完成后残留进度心跳导致 Leader 回复无关内容

- **修复日期**：2026-05-30
- **严重程度**：Major
- **文件**：`src/main/services/agent/orchestrator.ts`
- **问题**：本地/远程 Worker 的 `progressReportInterval`（60s）在 `finally` 块中清除，但任务在 `processStream` 返回时就已完成。最后 60 秒窗口内的 interval tick 可能在任务完成后仍注入"进度心跳"消息到 Leader 队列，导致 Leader LLM 回复"残留心跳，忽略"等无关内容。
- **修复**：在本地 Worker（L2301-2304）和远程 Worker（L2691-2693）任务完成后立即 `clearInterval(progressReportInterval)`，不再等 `finally` 块。

### BUG-015：Worker 新旧任务混在同一个思考过程框和对话框中

- **修复日期**：2026-05-30
- **严重程度**：Major
- **文件**：`src/renderer/stores/chat.store.ts`
- **问题**：`handleWorkerStarted` 保留旧任务的 `thoughts` 和 `streamingContent`（为处理 IPC 时序问题），但同一 Worker 执行新任务时（taskId 不同），旧状态未被清空，导致新任务的思考过程和输出混入旧任务面板。`handleWorkerCompleted` 使用 `...ws` spread 保留所有旧字段包括 `streamingContent`。
- **修复**：(A) `handleWorkerStarted` 新增 `isNewTask` 判断（比较 `existing.taskId !== taskId`），新任务时清空 `thoughts`、`streamingContent`、`textBlockVersion`。(B) `handleWorkerCompleted` 显式将 `streamingContent` 设为空字符串。
