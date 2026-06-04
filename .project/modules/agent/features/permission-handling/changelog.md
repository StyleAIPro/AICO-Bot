# 变更记录 -- 权限处理与转发

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | BUG-001 修复：增加 5 分钟超时、reject IPC 通道、放宽 isGenerating 守卫 | @moonseeker1 | BUG修复 |
| 2026-05-11 | BUG-002 修复：拆分 allowedTools 为 AVAILABLE_TOOLS/PRE_APPROVED_TOOLS，修复高风险工具绕过权限确认；ToolPermissionCard 增加 Write/Edit 内容预览；resolve-permission 增加远程 WebSocket 转发 | @mi-saka | BUG修复 |
| 2026-05-11 | BUG-003 修复：权限确认粒度优化 — Write/Edit/Create 等文件操作工具加入 PRE_APPROVED 自动放行；Bash 工具实现智能分级检测，仅破坏性命令（rm/sudo/kill 等）需确认 | @mi-saka | BUG修复 |
| 2026-05-11 | BUG-004 修复：远程 Agent 权限系统完全失效 — 远程代理 permissionMode 改 default、移除 dangerously-skip-permissions、实现破坏性 Bash 检测、新增 permission:request/response WebSocket 协议、send-message-remote 转发权限请求到本地 UI | @mi-saka | BUG修复 |
| 2026-05-12 | BUG-005 修复：远程 Agent 权限 Deny 不生效 — server.ts tool:approve handler 改为读取 payload.approved 而非硬编码 true；agent.ts IPC handler 根据 approved 值发送 tool:approve 或 tool:reject | @mi-saka | BUG修复 |
| 2026-05-12 | BUG-006 修复：远程 Agent 会话复用时权限回调丢失 — SessionConfig 增加 permissionMode 字段、needsSessionRebuild 增加 permissionMode 检查、会话复用路径有 canUseTool 时强制重建会话 | @mi-saka | BUG修复 |
| 2026-05-30 | BUG-007 修复：SDK disallowedTools 对 Agent 工具无效 — canUseTool 层硬拦截 Agent/Task 工具，新增 allowSubagents 参数控制 Worker 例外；远程代理 canUseTool 改为始终创建 + 添加 disallowedTools — PRD: `prd/bugfix/agent/bugfix-excessive-subagents-v5` | misakamikoto | bugfix-excessive-subagents-v5 |
