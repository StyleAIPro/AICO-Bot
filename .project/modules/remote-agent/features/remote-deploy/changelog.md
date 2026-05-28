# 变更记录 — remote-deploy

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-14 | `syncLocalSkillToRemote()` 从覆盖式同步改为破坏式全量更新：上传前 `rm -rf` 远程 skill 目录，消除更新后旧文件残留 | @mi-saka | bugfix-remote-skill-destructive-full-update-v1 |
| 2026-05-13 | 修复技能市场直接安装到远程服务器大文件导致 "unable to exec"：`installRemoteSkillDirect()` 文件上传和 META.json 上传从 base64 echo 改为 SFTP `writeFile()`，与 `syncLocalSkillToRemote` 保持一致 | @mi-saka | bugfix-remote-skill-direct-upload-large-file-v1 |
| 2026-05-13 | 修复密码修改后重连不自动部署：提取 `ensureAgentReady()` 函数检测文件完整性/SDK 版本/Proxy 状态并按需部署，`connectServer` 在 `detectAgentInstalled` 后调用，使所有重连场景（密码修改、手动 Connect、网络恢复）统一自动部署 | @mi-saka | bugfix-remote-server-ux-v3 |
| 2026-05-10 | 修复 SSH 断连后 UI 状态不更新：`SSHManager` 新增 `onDisconnect` 回调，`connectServer` 注册回调在断开时立即清理 `proxyRunning`/`apiReachable` 并通知 UI；`saveServers`/`loadServers` 不再持久化运行时状态字段 | @moonseeker | bugfix-remote-status-stale-v1 |
| 2026-04-27 | 修复 SSH 命令执行无超时导致部署/更新卡死：`SSHManager` 三个执行方法添加默认超时（30s/600s），`disconnect()` 改为强制断开不排队，部署流程关键调用（npm install 5min、Node.js 安装 5min、tar 解压 2-5min）添加显式超时覆盖 | @MoonSeeker | bugfix-deploy-timeout-hang-v1 |
| 2026-04-27 | 修复端口分配无总超时：`resolvePort()` 添加 2 分钟累积超时保护 | @MoonSeeker | bugfix-deploy-timeout-hang-v1 |
| 2026-04-27 | 修复离线部署无架构预检：`deployAgentCodeOffline()` 上传前执行 `uname -m` 检测 CPU 架构，选错立即报错；新增 `RemoteServer.detectedArch` 字段，UI 自动预选正确架构 | @MoonSeeker | bugfix-deploy-timeout-hang-v1 |
| 2026-04-27 | 新增操作看门狗和取消机制：`startUpdate()` 启动 10 分钟看门狗自动失败，新增 `cancelOperation()` IPC 通道和 UI 取消按钮 | @MoonSeeker | bugfix-deploy-timeout-hang-v1 |
| 2026-04-23 | 新增离线部署支持：`deployAgentCodeOffline()`、`updateAgentCodeOffline()`、`startAgentOffline()` 方法，前端 UI 新增在线/离线模式切换和平台选择 | @MoonSeeker | offline-deploy-bundle-v1 |
|------|------|--------|---------|
| 2026-04-17 | 修复 `checkAgentInstalled` 未做版本精确匹配：增加 `version === REQUIRED_SDK_VERSION` 校验，不匹配时设置 `sdkVersionMismatch: true`，UI 据此显示版本不匹配警告 | @zhaoyinqi | bugfix-sdk-version-check-v1 |
| 2026-04-17 | 修复 SDK 安装命令模板字符串未插值：3 处 npm install 单引号字符串改为反引号模板字符串，确保 `${REQUIRED_SDK_VERSION}` 正确插值，避免安装最新版而非指定版本 | @zhaoyinqi | bugfix-sdk-version-interpolation-v1 |
| 2026-04-17 | 修复 WebSocket 客户端认证 token 不一致：`createWsClient` 中 `authToken` 从 `server.password` 改为 `server.authToken`，与 Proxy 服务端保持一致 | @zhaoyinqi | bugfix-ws-auth-token-mismatch-v1 |
| 2026-04-17 | addServer 增加自动部署：检测到文件缺失或 SDK 不达标时自动部署，都 OK 时自动拉起 proxy；updateAgent/startAgent 后立即 verifyProxyHealth；健康监控 static 定时器防双实例 | @zhaoyinqi | bugfix-proxy-health-monitor-v1 |
| 2026-04-16 | updateAgent 增加快速重启路径（文件完整+SDK 匹配时只 restart），connectServer 成功后重置 autoRecoverFailures | @zhaoyinqi | bugfix-proxy-health-monitor-v1 |
| 2026-04-16 | 新增后台周期健康监控（30 秒），proxy 挂掉后自动恢复或告警提示 Update Agent | @zhaoyinqi | bugfix-proxy-health-monitor-v1 |
| 2026-04-16 | 统一 SDK Patch：构建脚本改用 `scripts/patch-sdk.mjs`（统一脚本），删除旧 `packages/remote-agent-proxy/scripts/patch-sdk.mjs` | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计：远程 Agent 代码部署与管理 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：fs/list/read/write/delete 及 updateAgent 编排逻辑从 IPC 移入 remote-deploy.service.ts | @moonseeker1 | 代码审计 |
| 2026-04-16 | 修复：多实例共享远端 proxy 时 auth token 冲突（实现 registerTokenOnRemote、proxy 多 token 支持） | @moonseeker1 | bugfix-multi-token-registration-v1 |
| 2026-04-16 | 修复：connectServer 重连后不检测代理状态，UI 错误显示"代理已停止" | @claude | bugfix-proxy-status-not-updated-after-reconnect-v1 |
| 2026-04-16 | 修复：Windows 下 createDeployPackage tar 命令因反斜杠路径失败（远程部署不可用） | @claude | bugfix-tar-path-windows-backslash-v1 |
| 2026-04-16 | 修复：startAgent pgrep 误判导致代理未启动（改用 health 端点作为权威判断，pgrep 仅用于清理僵尸进程） | @claude | bugfix-startAgent-pgrep-false-positive-v1 |
| 2026-04-16 | 统一 SDK 版本常量（`src/shared/constants/sdk.ts`），清理 0.2.87 遗留物，记录 SDK Patch 机制 | @StyleAIPro | unified-sdk-version-config-v1 |
