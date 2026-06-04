# Changelog

## [Unreleased]

### Changed
- GitCode API 对齐全面优化（17 项问题）：Base URL 修正 `api.gitcode.com`、速率限制放宽 1s→200ms、raw 端点替代 base64、技能详情并行获取、getMarketSkillDetail 30s 超时保护、token 从 URL 移到 header、递归扫描 deadline 20s、pushSkillAsMR 失败清理分支、请求计数修正、代码去重 — `gitcode-skill-source.service.ts`、`gitcode-auth.service.ts`、`skill.controller.ts`、`skill-market-service.ts` — PRD: `prd/refactor/skill/refactor-gitcode-api-alignment-v1.md`

### Added
- 远程技能 Direct Upload 安装：GitCode 技能可直接安装到远程服务器（本机 API 下载→SSH 上传），GitHub npx 失败时自动 fallback — `src/main/services/remote-deploy/remote-deploy.service.ts`、`src/main/controllers/skill.controller.ts` — PRD: `prd/feature/skill/feature-direct-remote-skill-install-v1.md`
- 离线部署包集成 gh CLI：构建时自动下载 linux-x64/arm64 gh 二进制并打包进 tar.xz，远程部署后 gh 命令自动可用 — `packages/remote-agent-proxy/scripts/build-offline-bundle.mjs`、`deploy-env.sh`、`agent-deployer.ts` — PRD: `prd/feature/remote-deploy/feature-gh-cli-offline-bundle-v1.md`
- BUG-001: 远程 Direct Upload 安装目录名错误（使用完整市场 ID 做目录名而非从 skillName 派生短 ID，导致技能被装到 `~/.agents/skills/gitcode:Ascend/agent-skill:skills/commit/` 而非 `~/.agents/skills/commit/`） — `src/main/services/remote-deploy/remote-deploy.service.ts` — PRD: `prd/bugfix/skill/bugfix-remote-skill-dir-name-v1.md`

### Fixed
- BUG-008: 安装超时后级联失败（超时后 pending API 请求不被取消，持续消耗 rate limiter 配额；downloadSkill 被重复调用） — `src/main/controllers/skill.controller.ts`、`src/main/services/skill/gitcode-skill-source.service.ts`、`src/main/services/skill/github-skill-source.service.ts` — PRD: `prd/bugfix/skill/bugfix-install-timeout-cascading-v1.md`
- BUG-009: 多文件 Skill 安装超时（60s 超时不够 + 递归下载非必要目录 + 1s rate limit 过于保守） — `src/main/controllers/skill.controller.ts`、`src/main/services/skill/gitcode-skill-source.service.ts`、`src/main/services/skill/github-skill-source.service.ts` — PRD: `prd/bugfix/skill/bugfix-skill-download-too-slow-v1.md`
- BUG-010: 分类目录被误显示为 Skill（listSkillsFromRepo 未过滤无 SKILL.md 的目录） — `src/main/services/skill/gitcode-skill-source.service.ts`、`src/main/services/skill/github-skill-source.service.ts` — PRD: `prd/bugfix/skill/bugfix-non-skill-dirs-shown-v1.md`
- BUG-006: GitCode 技能安装长时间挂起（downloadSkill 无进度回调 + getSkillDetail 失败路径大小写不匹配 + findSkillDirectoryPath fallback 递归深度过大 + 无整体超时） — `src/main/services/skill/skill-market-service.ts`、`src/main/services/skill/gitcode-skill-source.service.ts`、`src/main/controllers/skill.controller.ts` — PRD: `prd/bugfix/skill/bugfix-skill-install-hang-v1.md`
- BUG-001: Worker 内部 SDK 子 agent 产生多余 Worker Tab（复杂任务时 Worker 调用 Agent/Task 工具，stream-processor 无条件发送 worker:started 到前端） — `src/main/services/agent/stream-processor.ts` — PRD: `prd/bugfix/agent/bugfix-excessive-subagents-v2`
- 远程模式错误信息不显示：catch 块补充 `agent:error` 事件 + `agent:error`/`agent:complete` 发送顺序调整 + `handleAgentComplete` 保护已有 error + 子 Agent 错误详情保留 — PRD: `prd/bugfix/agent/bugfix-agent-error-log-truncation-v1.md`
- BUG-001: Hyper Space Leader 创建过多子 Agent（声明 N 个实际创建 N+2，SDK 内置 Agent/Task 工具与 spawn_subagent 冲突） — `src/main/services/agent/sdk-config.ts`、`src/main/services/agent/orchestrator.ts`、`src/main/services/agent/system-prompt.ts` — PRD: `prd/bugfix/agent/bugfix-excessive-subagents-v1`
- BUG-001: GitCode 技能获取全面失败（rate limiter 失效 + 无超时 + getSkills()/searchSkills() 吞没错误 + 缓存空结果 + UI 无错误展示 + 代理不刷新） — `src/main/services/skill/gitcode-skill-source.service.ts`、`src/main/services/skill/skill-market-service.ts`、`src/renderer/components/skill/SkillMarket.tsx` — modules/skill/features/skill-market/bugfix.md — PRD: `prd/bugfix/skill/bugfix-gitcode-skill-fetch-v1.md`
- BUG-003: 技能市场 UX 精修（GitCode 顺序获取进度均匀化 + 前端源选择同步后端 activeSourceId + GitHub 恢复并行获取减少请求延迟） — `src/main/services/skill/gitcode-skill-source.service.ts`、`src/main/services/skill/github-skill-source.service.ts`、`src/renderer/stores/skill/skill.store.ts`、`src/renderer/components/skill/SkillMarket.tsx` — modules/skill/features/skill-market/bugfix.md — PRD: `prd/bugfix/skill/bugfix-skill-market-ux-v1.md`
- BUG-004: 技能市场 GitHub/GitCode 平台隔离（`githubRepo`/`githubPath` → `remoteRepo`/`remotePath` 类型重命名 + Push 流程平台校验 + i18n 硬编码修复 + Controller 返回值统一） — `src/shared/skill/skill-types.ts`、`src/main/services/skill/`、`src/main/controllers/skill.controller.ts`、`src/renderer/api/index.ts`、`src/renderer/stores/skill/skill.store.ts`、`src/renderer/components/skill/SkillMarket.tsx`、`src/renderer/components/skill/SkillLibrary.tsx` — modules/skill/features/skill-market/bugfix.md — PRD: `prd/refactor/skill/refactor-skill-market-platform-isolation-v1.md`
- BUG-003: SDK 安装命令模板字符串未插值导致安装错误版本（3 处 npm install 单引号字符串未插值 `${REQUIRED_SDK_VERSION}`，远程安装了最新版而非指定版本） — `src/main/services/remote-deploy/remote-deploy.service.ts` — modules/remote-agent/features/remote-deploy/bugfix.md — PRD: `prd/bugfix/remote-deploy/bugfix-sdk-version-interpolation-v1.md`
- BUG-004: checkAgentInstalled 未做版本精确匹配导致 UI 状态错误（只检查 SDK 是否安装不检查版本号，安装错误版本后 UI 仍显示绿色正常） — `src/main/services/remote-deploy/remote-deploy.service.ts` — modules/remote-agent/features/remote-deploy/bugfix.md — PRD: `prd/bugfix/remote-deploy/bugfix-sdk-version-check-v1.md`
- BUG-002: 远程 WebSocket 认证 token 不一致导致连接失败（`createWsClient` 中 `authToken` 使用 `server.password` 而非 `server.authToken`） — `src/main/services/remote-deploy/remote-deploy.service.ts` — modules/remote-agent/features/remote-deploy/bugfix.md — PRD: `prd/bugfix/remote-deploy/bugfix-ws-auth-token-mismatch-v1.md`
- BUG-003: Windows 删除空间 EBUSY (resource busy or locked) — `closeSessionsBySpaceId()` 改为 async 等待 SDK 子进程退出，`deleteSpace()` 增加重试次数和退避延迟 — `src/main/services/agent/session-manager.ts`、`src/main/services/space.service.ts` — PRD: `prd/bugfix/space/bugfix-space-delete-ebusy-v1.md`
- BUG-002: 第二条消息卡死在思考状态（SDK turn injection patch 的 `send()` 守卫条件 `firstResultReceived` → `_continueAfterResult`） — `src/main/services/agent/sdk-turn-injection-patch.ts` — PRD: `prd/bugfix/agent/bugfix-second-message-stuck-v1.md`
- 远程 Proxy 中途发消息 interrupt + SDK 注入导致 SDK 内部错误，改为纯队列存储等待 streamChat 自然完成 — PRD: `prd/bugfix/remote-agent/bugfix-remote-queue-interrupt-v1`
- 中途发消息 interrupt + SDK patch 消息注入导致 SDK 内部消息处理错误，回退为排队等待自然完成方案 — PRD: `prd/module/agent/unified-sdk-patch-v1`
- BUG-001: 停止生成按钮导致无限加载（drain 循环窃取 stream 消息 + 前端缺少安全超时） — `src/main/services/agent/control.ts`、`src/renderer/stores/chat.store.ts` — modules/agent/features/stream-processing/bugfix.md
- BUG-001: 远程 Proxy 健康状态不实时更新 — `src/main/services/remote-deploy/remote-deploy.service.ts`、`src/renderer/components/settings/RemoteServersSection.tsx` — modules/remote-agent/features/remote-deploy/bugfix.md
- BUG-001: AskUserQuestion 工具导致 Bot 卡死 — `src/main/services/agent/permission-handler.ts`、`src/renderer/stores/chat.store.ts`
- BUG-001: MAX_IMAGES 未定义导致 InputArea 崩溃 — `src/renderer/hooks/useImageAttachments.ts`、`src/renderer/components/chat/InputArea.tsx`
- BUG-001: sessionId 未定义导致 sendMessage 崩溃 — `src/main/services/agent/session-manager.ts`
- BUG-001: dev/packaged 多实例共享远端 proxy 时 auth token 冲突（401 认证失败） — `packages/remote-agent-proxy/src/server.ts`、`src/main/services/remote-deploy/remote-deploy.service.ts`
- BUG-001: connectServer 重连后不检测代理状态，UI 错误显示"Bot 代理已停止" — `src/main/services/remote-deploy/remote-deploy.service.ts`
- BUG-001: Windows 下 tar 命令因反斜杠路径失败导致远程部署不可用 — `src/main/services/remote-deploy/remote-deploy.service.ts`
- BUG-001: startAgent pgrep 误判代理已运行导致更新后代理未启动 — `src/main/services/remote-deploy/remote-deploy.service.ts`
- BUG-001: 更新 AI 源配置后主题被重置为浅色 — `src/renderer/hooks/useAISources.ts`、`src/renderer/components/settings/AISourcesSection.tsx` — modules/ai-sources/features/source-manager/bugfix.md

### Added
- 统一 SDK 版本常量管理（`src/shared/constants/sdk.ts` → `CLAUDE_AGENT_SDK_VERSION`），清理 0.2.87 遗留 patch/tgz，记录 SDK Patch 机制到 remote-deploy 设计文档 — PRD: `prd/bugfix/remote-agent/unified-sdk-version-config-v1`
- 统一 SDK Patch 脚本（`scripts/patch-sdk.mjs`），10 个补丁覆盖选项转发 + 轮级消息注入，本地和远端共用 — PRD: `prd/module/agent/unified-sdk-patch-v1`
- 本地启动时执行 SDK Patch（`src/main/bootstrap/essential.ts`），确保选项转发（cwd/systemPrompt 等）生效
- 统一中途发消息流程：本地和远端均在 isGenerating 时将消息入队等待自然完成，由 handleAgentComplete 检测队列后发送下一条（补丁 7-11 保留但不再用于此流程）
- 文档模块：skill（3 功能）、terminal（2 功能）、health（2 功能）、ai-sources（2 功能）、settings（3 功能）、onboarding（2 功能） — `.project/modules/`
- 文档模块：openai-compat-router（4 功能：protocol-conversion, stream-pipeline, request-routing, interceptors） — `.project/modules/openai-compat-router/`
- 功能文档：chat/canvas、chat/search、chat/artifact、ai-browser/electron-browser-view — `.project/modules/chat/features/`、`.project/modules/ai-browser/features/`
- 填充 6 个现有模块的「功能列表」表 — `.project/modules/*/`
- Remote Agent 独立详解文档（架构全景、通信协议、部署架构、消息流、故障排查） — `docs/remote-agent-guide.md`

### Refactored
- 技能市场 GitHub/GitCode 平台隔离：`RemoteSkillItem.githubRepo`/`githubPath` → `remoteRepo`/`remotePath`（10+ 文件），Push 流程根据 source type 路由到正确 API，Controller 返回值 `mrUrl` → `prUrl` 统一 — PRD: `prd/refactor/skill/refactor-skill-market-platform-isolation-v1.md`
- 删除 analytics 模块代码（6 文件），移除 Baidu Tongji SDK 和 `initAnalytics` 启动调用 — `src/main/services/analytics/`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/index.html`
- 删除 perf 模块代码（7 文件），移除性能监控 IPC/API/store — `src/main/services/perf/`、`src/main/ipc/perf.ts`、`src/renderer/stores/perf.store.ts`、`src/renderer/lib/perf-collector.ts`
- 删除 notify-channels 代码（7 文件）和 notification IPC/设置 UI，精简 notification.service.ts 仅保留系统通知 — `src/main/services/notify-channels/`、`src/main/services/notification.service.ts`、`src/main/apps/runtime/`
- 提取 git-bash 业务逻辑到 service 层（状态检测、安装流程、跳过/完成），IPC handler 仅做转发 — `src/main/ipc/git-bash.ts`、`src/main/services/git-bash.service.ts`
- 提取 remote-deploy fs/update 编排到 service 层（listRemoteFiles、readRemoteFile、writeRemoteFile、deleteRemoteFile、updateAgent） — `src/main/ipc/remote-server.ts`、`src/main/services/remote-deploy/remote-deploy.service.ts`
- 提取浏览器上下文菜单构建到独立 service（buildBrowserContextMenu、buildCanvasTabContextMenu），IPC handler 动态导入 — `src/main/ipc/browser.ts`、`src/main/services/browser-menu.service.ts`
- config IPC handler 瘀为薄代理：getDecryptedConfig()、saveConfigAndNotify() 移入 config.service — `src/main/ipc/config.ts`、`src/main/services/config.service.ts`
- hyper-space IPC handler 瘀为薄代理：updateTeamConfig() 深合并、getTeamMembers() 双源成员列表移入 orchestrator — `src/main/ipc/hyper-space.ts`、`src/main/services/agent/orchestrator.ts`
- chat.store 移除直接 canvasLifecycle 依赖，改用 useCanvasStore.getState()，消除重复 buildCanvasContext — `src/renderer/stores/chat.store.ts`
- RemoteServersSection 4 个 window.electron.ipcRenderer 事件迁移至 api 层（preload 暴露 + transport methodMap + api 导出） — `src/preload/index.ts`、`src/renderer/api/transport.ts`、`src/renderer/api/index.ts`、`src/renderer/components/settings/RemoteServersSection.tsx`
- 提取 useWorkerTabs hook（worker tab 构建、未读追踪、tab 切换）— `src/renderer/hooks/useWorkerTabs.ts`、`src/renderer/components/chat/ChatView.tsx`
- 提取 useSearchNavigation hook（搜索结果滚动定位、DOM 高亮、重试逻辑）— `src/renderer/hooks/useSearchNavigation.ts`
- 提取 useMentionSystem hook（@mention 自动补全、键盘导航、光标定位、targetAgentIds 同步）— `src/renderer/hooks/useMentionSystem.ts`、`src/renderer/components/chat/InputArea.tsx`
- 提取 useImageAttachments hook（图片粘贴/拖拽/文件选择、压缩、验证、错误自动清除）— `src/renderer/hooks/useImageAttachments.ts`
- 提取 useAISources hook（CRUD 编排：switch/add/update/delete source + UI 状态管理）— `src/renderer/hooks/useAISources.ts`、`src/renderer/components/settings/AISourcesSection.tsx`
- queueInjection 参数对象化（QueueInjectionOptions） — `src/main/services/agent/stream-processor.ts`、`src/main/ipc/agent.ts`、`src/main/services/agent/orchestrator.ts`
- createHyperSpaceMcpServer 参数对象化（HyperSpaceMcpOptions）— `src/main/services/agent/hyper-space-mcp.ts`、`src/main/services/agent/orchestrator.ts`
- emitHealthEvent 参数对象化（EmitHealthEventOptions），更新全部 9 个调用方 — `src/main/services/health/health-checker/event-listener.ts`、`src/main/services/health/orchestrator.ts`
- getOrCreateV2Session 参数对象化（GetOrCreateSessionOptions）— `src/main/services/agent/session-manager.ts`、`src/main/services/agent/send-message.ts`、`src/main/services/agent/orchestrator.ts`、`src/main/apps/runtime/app-chat.ts`
- 移除 agent-command.store.ts 中未实现的死代码（window.aicoBot.saveFile/showMessage）— `src/renderer/stores/agent-command.store.ts`

---

## [2.0.2] - 2026-04-14

### Added
- OpenAI 兼容路由，支持通过 OpenAI 格式接入多种模型 — `src/main/services/agent/`
- Worker 持久化机制，Hyper Space 工作进程跨会话保持 — `src/main/apps/runtime/`
- 任务看板（Taskboard），可视化追踪多 Agent 任务状态 — `src/renderer/pages/`
- 多客户端隔离，不同远程客户端独立会话空间 — `src/main/services/remote-ws/`
- GitCode 技能源，支持从 GitCode 平台安装技能 — `src/main/services/ai-sources/`
- GitHub/GitCode PR 推送与 MR 创建诊断改进 — `src/main/services/github-auth.service.ts`、`src/main/services/gitcode-auth.service.ts`
- GitHub 直接 PAT 认证（无需 gh CLI） — `src/main/services/github-auth.service.ts`
- Worker 子会话支持，工作 Agent 拥有独立对话上下文 — `src/main/services/agent/`
- 终端与思考过程 UI 改进 — `src/renderer/components/`
- 结构化日志与 WebSocket 连接池 — `src/main/services/remote-ws/`
- 远程模型选择优化，重构 ProviderSelector，改进 API 配置流程 — `src/renderer/components/`、`src/main/services/agent/`

### Changed
- 重构远程模型选择器组件，统一模型配置入口 — `src/renderer/components/`

### Fixed
- GitCode 技能安装/推送兼容性问题 — `src/main/services/ai-sources/`
- 内网环境下 GitCode/GitHub API 请求的 HTTPS 代理支持 — `src/main/services/github-auth.service.ts`、`src/main/services/gitcode-auth.service.ts`
- resolveLocalizedText 缺失 i18n 字段导致的崩溃问题，增加 null 保护 — `src/renderer/i18n/`
- 开发模式下 DevTools 以独立窗口打开 — `src/main/`
- 对话导出功能，修复空间删除和剪贴板问题 — `src/renderer/pages/`

---

## [2.0.1] - 2026-04-10

### Added
- 多目录技能支持 — `src/main/services/skill/`
- 对话导出功能 — `src/renderer/pages/`
- 自定义远程空间系统提示词 — `src/main/services/remote-deploy/`
- 使用 ConfirmDialog 替换原生弹窗 — `src/renderer/components/`
- 首页空间创建拆分为 Local/Remote/Hyper 按钮入口 — `src/renderer/pages/HomePage.tsx`
- 远程技能管理与 MCP 代理 — `src/main/services/skill/`、`src/main/services/mcp-proxy/`
- GitHub 回退机制用于技能安装，改进市场 UI — `src/main/services/ai-sources/`
- Token 白名单机制，支持多 PC 远程认证 — `src/main/services/remote-deploy/`
- GitHub 集成与 Pulse TaskCard — `src/main/components/`
- Windows DWM 清理优化，使用原生 Win32 API — `src/main/services/win32-hwnd-cleanup.ts`
- 页面过渡动画与 UI 精调 — `src/renderer/`
- Windows 开发指南文档 — `docs/`

### Changed
- 项目从 Halo 更名为 AICO-Bot — 全局
- 移除技能同步与迁移功能 — `src/main/services/skill/`

### Fixed
- 终端事件泄漏与输出重复 — `src/main/services/terminal/`
- BrowserView 在 Windows 上阻塞点击的问题 — `src/main/services/browser-view.service.ts`
- 远程部署产物中 Windows 不兼容路径的处理 — `src/main/services/remote-deploy/`
- 防止过期的 onExit 监听器关闭替换会话 — `src/main/services/agent/`
- 移除错误放置的 agent config 目录，添加 gitignore 规则 — 项目根目录
- Leader 通过 spawn_subagent 正确委派任务给 Worker — `src/main/apps/`

---

## [2.0.0] - 2026-04-08

### Added
- Hyper Space 多 Agent 编排系统，包含完整的类型定义 — `src/main/apps/`
- Hyper Space 编排器与 Worker 管理 — `src/main/apps/manager/`
- Hyper Space MCP 工具与 IPC 基础设施 — `src/main/apps/`、`src/main/ipc/`
- Hyper Space MCP 代理到远程 Agent — `src/main/services/mcp-proxy/`
- 远程 Agent 增量代码更新部署 — `src/main/services/remote-deploy/`
- Hyper Space UI 组件 — `src/renderer/pages/`
- Hyper Space 多 Agent 集成到聊天 UI — `src/renderer/stores/`
- 空间类型标识与批量服务器操作 — `src/renderer/pages/`
- Hyper Space 国际化翻译与依赖更新 — `src/renderer/i18n/`
- SDK turn injection 补丁，支持消息注入 — `src/main/services/agent/`
- 回合级消息注入实现 — `src/main/services/agent/`
- 生成过程中的消息排队机制 — `src/main/services/agent/`
- SDK 升级，改进流式传输与思考过程 UI，增强远程部署 — `src/main/services/agent/`
- Hyper Space 独立 Agent 对话重新设计 — `src/main/apps/`

### Fixed
- 增加 turn-boundary 等待时间并正确跟踪注入标志 — `src/main/services/agent/`
- 当 hasStreamEvent 为 true 时跳过文本思考累积 — `src/main/services/agent/`
- Windows 兼容性改进：终端、SSH 隧道、构建脚本 — `src/main/services/terminal/`、`src/main/services/remote-ssh/`
- 远程服务器终端输出持久化改进 — `src/main/services/remote-ws/`
- Skill Generator 重命名为 Skill Editor — `src/renderer/pages/skill/`

---

[Unreleased]: https://github.com/StyleAIPro/AICO-Bot/compare/v2.0.2...HEAD
[2.0.2]: https://github.com/StyleAIPro/AICO-Bot/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/StyleAIPro/AICO-Bot/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/StyleAIPro/AICO-Bot/releases/tag/v2.0.0
