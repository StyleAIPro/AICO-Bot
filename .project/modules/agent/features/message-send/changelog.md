# 变更记录 -- 消息发送流程

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-13 | BUG-006：修复注入循环不保存用户消息导致回复错位——injection continuation 循环添加 addMessage 调用，持久化注入的 user 消息和 assistant placeholder，防止 updateLastMessage 覆盖上一个回复 — `src/main/services/agent/send-message-local.ts` | 用户 | bugfix-message-delivery-v1 |
| 2026-05-13 | BUG-005：修复生成中发送消息竞态丢失——turn-boundary handler 改用 injection-start 事件确认移除；修复空闲后新建 session 模型不读指令——新建 session 添加 continuation prefix — `src/renderer/App.tsx`, `src/main/services/agent/send-message-local.ts` | 用户 | bugfix-message-delivery-v1 |
| 2026-05-13 | BUG-004：修复中止后安全超时复用卡死会话——getOrCreateV2Session 增加 activeSessions 已 abort 检测，强制关闭卡死会话后创建新会话 — `src/main/services/agent/session-lifecycle.ts` | 用户 | bugfix-stuck-session-reuse-v1 |
| 2026-05-10 | BUG-003：修复 handleAgentComplete 竞态条件——删除 pre-await pendingMessages 快照，改在 set() 回调内读取最新值通过闭包传出；错误分支保留 pendingMessages 不清空 — `src/renderer/stores/chat.store.ts` | 用户 | bugfix-pending-message-race-v1 |
| 2026-04-17 | BUG-002：修复 SDK turn injection patch 的 `send()` 守卫条件错误（`firstResultReceived` → `_continueAfterResult`），解决第二次消息卡死问题 — `src/main/services/agent/sdk-turn-injection-patch.ts` | @zhaoyinqi | bugfix-second-message-stuck-v1 |
| 2026-04-29 | error-classifier 网络错误消息更新：从"设置环境变量"改为引导到应用内"设置 > 网络"配置代理 | 用户 | bugfix-intranet-proxy-guidance-v1 |
| 2026-04-17 | 回退中途发消息方案：移除立即 interrupt，改为等待当前任务自然完成后处理排队消息（修复 SDK 内部消息处理错误） | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 统一中途发消息：isGenerating 时立即触发 stopGeneration interrupt，由 SDK patch 消息注入机制处理排队消息 | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：getOrCreateV2Session 参数封装为 GetOrCreateSessionOptions 对象，更新 send-message、orchestrator、app-chat 全部调用方 | @moonseeker1 | 代码审计 |
| 2026-04-27 | bugfix: 普通对话 buildBaseSdkOptions 添加 additionalDisallowedTools: ['Agent', 'Task']，SDK 层面强制禁止子 Agent 创建 | @misakamikoto | bugfix-excessive-subagents-v4 |
| 2026-05-10 | bugfix: 系统提示词子 Agent 规则从"NEVER"绝对禁令改为"Do NOT proactively"条件规则，用户显式请求时必须使用子 Agent — `src/main/services/agent/system-prompt.ts` | @misakamikoto | bugfix-subagent-ignored-v1 |
