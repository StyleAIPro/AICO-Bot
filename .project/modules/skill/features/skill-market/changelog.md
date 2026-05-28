# 变更记录 — 技能市场

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-13 | 技能安装改为全量更新：`installSkillFromSource()` 和 `installRemoteSkillDirect()` 创建目录前先删除旧目录，避免旧版孤立文件残留 | @mi-saka | feature-skill-full-update-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-18 | 修复 GitCode 技能获取全面失败（rate limiter、超时、错误传播、代理缓存） | @MoonSeeker | BUG-001 |
| 2026-04-18 | 添加 asyncPool 并发控制，Promise.all 改为批次加载（并发上限 3） | @MoonSeeker | BUG-001 |
| 2026-04-18 | 综合修复 7 项问题（进度报告、死代码、preload 重复、skills.sh master 回退、GitCode validateRepo、参数透传 bug、竞态条件） | @MoonSeeker | bugfix-skill-market-cleanup-v1 |
| 2026-04-18 | UX 精修：GitCode 顺序获取进度均匀、前端源选择同步后端、GitHub 恢复并行获取 | @MoonSeeker | bugfix-skill-market-ux-v1 |
| 2026-04-18 | 平台隔离：`githubRepo`/`githubPath` → `remoteRepo`/`remotePath`、Push 流程平台校验、i18n 修复、Controller 返回值统一 | @MoonSeeker | refactor-skill-market-platform-isolation-v1 |
| 2026-04-18 | Bug 修复：Push 按钮文案动态化 + 同名仓库 select value 唯一性修复 + SkillDetail prop 传递修复 | @MoonSeeker | bugfix-skill-push-ui-and-repo-routing-v1 |
| 2026-04-24 | 修复安装超时级联失败：AbortSignal 从安装层透传到 gitcodeFetch，超时时取消所有 pending 请求；installSkillMultiTarget 去重 downloadSkill | 用户 | bugfix-install-timeout-cascading-v1 |
| 2026-04-24 | 修复安装超时定时器未清除：Promise.race + setTimeout 改为 clearTimeout 模式，安装完成后不再误报超时 | 用户 | bugfix-install-timeout-always-fires-v1 |
| 2026-04-24 | 修复 GitCode 技能安装长时间挂起：downloadSkill 添加进度回调 + getSkillDetail 失败时缓存路径兜底 + installSkillFromMarket 60s 整体超时 | 用户 | bugfix-skill-install-hang-v1 |
| 2026-04-24 | 修复多文件 skill 安装超时：安装超时 60s → 120s + SKIP_DIRS 跳过非必要目录 + 文件下载 skipRateLimit | 用户 | bugfix-skill-download-too-slow-v1 |
| 2026-04-24 | 修复分类目录误显示为 skill：listSkillsFromRepo 中 SKILL.md 不存在时跳过该目录，不再创建默认条目 | 用户 | bugfix-non-skill-dirs-shown-v1 |
| 2026-04-25 | 远程安装支持 GitCode Direct Upload：installRemoteSkill 新增 sourceType 参数，GitCode 源走本机 API 下载→SSH 上传，GitHub npx 失败时自动 fallback 到 Direct Upload | 用户 | feature-direct-remote-skill-install-v1 |
| 2026-04-26 | GitCode API 对齐全面优化：修正 Base URL（api.gitcode.com）、放宽速率限制（1s→200ms）、raw 端点替代 base64、并行获取技能详情、30s 超时保护、token 从 URL 移到 header、递归扫描 deadline、代码去重 | @MoonSeeker | refactor-gitcode-api-alignment-v1 |
| 2026-04-29 | PAT 缺失引导：安装流程 PAT 预检 early return + npx fallback PAT 预检 + 新增 `skill:market:pat-status` IPC 主动检测 + 技能市场主动预警横幅 + 中英文 i18n | 用户 | bugfix-pat-missing-imported-repo-v1 |
| 2026-04-29 | 内网代理引导：error-classifier 网络错误消息更新为引导到应用内"设置 > 网络" + skill-market-service GitHub/GitCode 网络错误同步更新 + 新增 `skill:network:proxy-status` IPC + 技能市场网络错误横幅区分"未配置代理"/"代理连接失败" + 中英文 i18n | 用户 | bugfix-intranet-proxy-guidance-v1 |
| 2026-05-04 | 远程 Skill 卸载完善：uninstallRemoteSkill 增加 symlink 清理 + 卸载后自动重启 proxy 重载 skill 列表 + SkillMarket 远程卸载增加确认对话框 + SkillLibrary 远程视图增加卸载按钮 | @MoonSeeker | feature-remote-skill-uninstall-v1 |
