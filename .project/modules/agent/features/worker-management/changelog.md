# 变更记录 -- 持久化 Worker 与任务板

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-06-02 | Worker 心跳不再走 injection 通道（改为 `agent:stream-alive` 事件）；injection queue 添加 10 分钟 TTL + 30 条容量上限；`stopGeneration` 清理 injection 队列 — PRD: `prd/bugfix/agent/bugfix-hyperspace-heartbeat-queue-v1` | misakamikoto | bugfix-hyperspace-heartbeat-queue-v1 |
| 2026-06-02 | 新增 `interruptWorkersForConversation`：stopGeneration 级联中断所有 Worker（abort SDK + disconnect WebSocket + fail tasks）；deleteSpace/deleteConversation 自动销毁 team — PRD: `prd/bugfix/agent/bugfix-hyperspace-worker-interrupt-v1` | misakamikoto | bugfix-hyperspace-worker-interrupt-v1 |
| 2026-05-30 | 修复 Worker 新旧任务混在同一个思考过程框：handleWorkerStarted 通过 taskId 对比区分新任务 vs IPC 时序，新任务时清空 thoughts/streamingContent — PRD: `prd/bugfix/hyperspace/bugfix-worker-task-isolation-v1` | misakamikoto | bugfix-worker-task-isolation-v1 |
| 2026-05-29 | 修复 processStreamTimeout 定时器泄漏：processStream 正常返回后 clearTimeout，防止 30 分钟后误杀 Leader SDK 子进程 — PRD: `prd/bugfix/hyperspace/bugfix-worker-hard-timeout-v2` | misakamikoto | bugfix-worker-hard-timeout-v2 |
| 2026-05-29 | 修复 Leader 因 idle 清理被杀：(A) activeSessions 双 key 注册使 invalidateAllSessions 在途保护生效；(B) onComplete 注销移到 finally 块，waitForCompletion 期间不再被 30 分钟 idle cleanup 误杀 — PRD: `prd/bugfix/hyperspace-worker-abort-v2` | misakamikoto | hyperspace-worker-abort-v2 |
| 2026-05-28 | Leader 等待 Worker 期间添加 10 秒心跳防止假超时 + `handleAgentMessage` worker 路径更新 `lastActivityAt` — PRD: `prd/bugfix/hyperspace-worker-abort-v1` | 用户 | hyperspace-worker-abort-v1 |
| 2026-05-28 | Leader 中断恢复注入 Worker 上下文（running/completed 状态）+ 预消费遗留 injection 队列 — PRD: `prd/bugfix/hyperspace-leader-interrupt-context-v1` | 用户 | hyperspace-leader-interrupt-context-v1 |
| 2026-05-28 | handleWorkerStarted 保留已有 thoughts/streamingContent（不再无条件清空） — PRD: `prd/bugfix/hyperspace-worker-thoughts-v1` | 用户 | hyperspace-worker-thoughts-v1 |
| 2026-05-28 | handleAgentThoughtDelta auto-create + thought 占位；createTemporaryWorkerSession 统一 auto-create 逻辑（含 childConversationId） — PRD: `prd/bugfix/hyperspace-worker-thoughts-v1` | 用户 | hyperspace-worker-thoughts-v1 |
| 2026-05-28 | executeLocally 注册 activeSession + Worker processStream 超时保护 — PRD: `prd/bugfix/hyperspace-messaging-stuck-v1` | 用户 | hyperspace-messaging-stuck-v1 |
| 2026-05-28 | mailbox 原子写入修复（renameSync 替代 writeFileSync copy）、mtime 并发写入检测 + 重试、消息大小限制 + 截断、自动修剪（保留 100 条）、JSON 解析错误恢复、pollMessages 错误抛出、isMailboxHealthy 健康检查 — PRD: `prd/bugfix/hyperspace-messaging-stuck-v1` | 用户 | hyperspace-messaging-stuck-v1 |
| 2026-04-21 | 修复子 Agent 误报 "Stream interrupted"：streamChat 正常完成时不再发送 worker:completed failure 事件 — PRD: `prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1` | @misakamikoto | bugfix-remote-duplicate-subagent-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
