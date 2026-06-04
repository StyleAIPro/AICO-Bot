# 变更记录 — space-crud

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-23 | 清理 `space.store.ts` 中 `listSpaces` 的 3 行调试残留日志（response.data type/raw/JSON），保留摘要日志 — `space.store.ts` — PRD: `.project/prd/bugfix/renderer/bugfix-remove-debug-logs-v1.md` | misakamikoto | bugfix-remove-debug-logs-v1 |
| 2026-05-10 | 创建远程空间时校验工作目录是否存在：IPC `space:create` handler 通过 WebSocket 连接远程服务器检查 remotePath，不存在则返回 `REMOTE_DIR_NOT_FOUND` 让前端弹出确认对话框；新增 `space:create-dir` IPC 通道支持自动创建远程目录 — `space.ts`、`HomePage.tsx`、`space.store.ts`、`preload/index.ts`、`api/index.ts` — PRD: `.project/prd/bugfix/space/bugfix-remote-space-dir-check-v1.md` | @moonseeker | bugfix-remote-space-dir-check-v1 |
| 2026-04-16 | 初始设计：Space CRUD 全生命周期管理 | @moonseeker1 | 新功能 |
| 2026-04-17 | BUG-001 修复：Windows 删除空间 EBUSY 错误 — 增加重试次数和退避延迟（500ms/1s/2s），配合 session-manager 异步等待子进程退出 | @zhaoyinqi | BUG修复 |
