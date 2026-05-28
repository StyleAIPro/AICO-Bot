# 变更记录 — AI 源管理器

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-15 | 修复：恢复 AI 源独立代理开关 UI（d94b2d0 重构时误移除） | @MoonSeeker | bugfix-restore-use-proxy-ui-v1 |
| 2026-05-11 | 修复：模型选择框下拉列表中新旧名称并存的数据残留问题 | @mi-saka | bugfix-model-name-stale-v1 |
| 2026-05-11 | 修复：远程空间模型选择框和服务器卡片在 AI Source 模型名称编辑后不同步的显示问题 | @mi-saka | bugfix-model-name-sync-v1 |
| 2026-04-16 | 初始设计 | @mi-saka1 | 新功能 |
| 2026-04-16 | 重构：提取 useAISources hook | @mi-saka1 | 代码审计 |
| 2026-04-16 | 修复：useAISources 改用 updateConfig 避免主题重置 | @mi-saka1 | bugfix-theme-reset-on-config-update-v1 |
