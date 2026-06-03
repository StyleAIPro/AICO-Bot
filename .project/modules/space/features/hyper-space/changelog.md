# 变更记录 — hyper-space

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计：Hyper Space 多智能体工作空间管理 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：hyper-space IPC handler 变为薄代理，updateTeamConfig/getMembers 业务逻辑移入 orchestrator | @moonseeker1 | 代码审计 |
| 2026-06-02 | 新增 `interruptWorkersForConversation`：点击停止可中断所有 Worker（abort SDK session + disconnect 远程 WebSocket + fail running tasks）；deleteSpace/deleteConversation 自动销毁 team | @misakamikoto | Bug 修复 |
