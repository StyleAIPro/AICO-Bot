# Bug 记录 — remote-deploy

## BUG-001: Proxy 健康状态不实时更新
- **日期**：2026-04-16
- **严重程度**：Major
- **发现人**：@zhaoyinqi
- **问题**：期望 proxy 挂掉后 UI 自动更新状态并尝试恢复；实际 proxy 挂掉后 UI 一直显示绿色"Bot Proxy OK"
- **根因**：`detectAgentInstalled()` 只在部署/连接时调用，无后台周期健康检查
- **修复**：新增 `startHealthMonitor()` 30 秒周期检查，`tryAutoRecoverProxy()` 自动恢复，`checkDeployFilesIntegrity()` 文件完整性检查，UI 健康告警横幅
- **影响文档**：
  - [x] design.md
  - [ ] api/

---

## BUG-002: 远程 WebSocket 认证 token 不一致导致连接失败
- **日期**：2026-04-17
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：远程空间对话时 WebSocket 认证必然失败，远程服务器日志报 `Authentication failed via Authorization header, closing connection`
- **根因**：`createWsClient` 方法传的 `authToken` 是 `server.password`（SSH 密码），而 Proxy 启动时环境变量 `REMOTE_AGENT_AUTH_TOKEN` 用的是 `server.authToken`（随机 UUID），两端 token 不一致
- **修复**：将 `createWsClient` 中 `authToken: server.password || ''` 改为 `authToken: server.authToken`，与服务端保持一致
- **影响文档**：
  - [ ] design.md
  - [ ] api/

---

## BUG-003: SDK 安装命令模板字符串未插值导致安装错误版本
- **日期**：2026-04-17
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：远程部署时 npm 安装了最新版本（如 0.2.111）而非项目要求的 `REQUIRED_SDK_VERSION`（如 0.2.104）
- **根因**：3 处 npm install 命令使用了 JavaScript 单引号字符串（`'...'`）而非反引号模板字符串（`` `...` ``），`${REQUIRED_SDK_VERSION}` 未被插值，远程 shell 收到空版本号，npm 默认安装了最新版
- **修复**：将第 1163、1168、3250 行的单引号字符串改为反引号模板字符串，确保版本号正确插值
- **影响文档**：
  - [ ] design.md
  - [ ] api/

---

## BUG-004: checkAgentInstalled 未做版本精确匹配导致 UI 状态错误
- **日期**：2026-04-17
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：即使远程安装了错误版本的 SDK，`checkAgentInstalled` 仍返回 `sdkInstalled: true`，UI 显示绿色正常状态，误导用户
- **根因**：`checkAgentInstalled` 方法只检查 SDK 是否安装（目录是否存在 / 能否读取 package.json），不检查版本号是否与 `REQUIRED_SDK_VERSION` 一致
- **修复**：增加 `version === REQUIRED_SDK_VERSION` 精确匹配校验，不匹配时设置 `sdkVersionMismatch: true`，UI 据此显示版本不匹配警告
- **影响文档**：
  - [ ] design.md
  - [ ] api/

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 4 |
| Major | 6 |
| Minor | 0 |

### SSH 命令执行无超时导致操作卡死
- **严重程度**：Critical
- **日期**：2026-04-27
- **现象**：添加服务器、部署、更新操作在网络异常时无限卡死，UI 无响应
- **根因**：`SSHManager.executeCommand/Full/Streaming` 无超时机制，Promise 仅在 stream close 时 resolve；`_operationLock` 不可中断，`disconnect()` 排队等待形成死锁
- **修复**：三个执行方法添加默认超时（30s/600s），新增 `withTimeout()` 工具；`disconnect()` 改为 `client.destroy()` 强制断开 + 重置操作锁；部署流程关键调用添加显式超时覆盖
- **PRD**：`prd/bugfix/remote-deploy/bugfix-deploy-timeout-hang-v1.md`

### 端口分配无总超时
- **严重程度**：Major
- **日期**：2026-04-27
- **现象**：`resolvePort()` 最多 20 次端口检测，每次无超时，SSH 不稳定时累积超时达 10 分钟
- **根因**：循环内每个 `executeCommandFull` 无超时，20 次循环无总超时限制
- **修复**：添加 2 分钟累积超时保护，每次迭代前检查已用时间
- **PRD**：`prd/bugfix/remote-deploy/bugfix-deploy-timeout-hang-v1.md`

### 离线部署无架构预检
- **严重程度**：Major
- **日期**：2026-04-27
- **现象**：离线部署选错架构时，~50MB 包完整上传解压后才在 `node --version` 报 "Exec format error"
- **根因**：`deployAgentCodeOffline()` 不检测远端 CPU 架构，完全依赖用户手动选择（默认 x64）
- **修复**：上传前执行 `uname -m` 检测，不匹配立即报错；存储 `detectedArch` 到 server config，UI 自动预选
- **PRD**：`prd/bugfix/remote-deploy/bugfix-deploy-timeout-hang-v1.md`

### 操作状态无看门狗、无取消机制
- **严重程度**：Major
- **日期**：2026-04-27
- **现象**：部署/更新操作卡住后 `inProgress: true` 永久持续，用户无法取消
- **根因**：`UpdateOperationState` 无 TTL，UI 无取消按钮，IPC handler 无超时
- **修复**：`startUpdate()` 启动 10 分钟看门狗自动 `failUpdate()`；新增 `cancelOperation()` IPC + UI 取消按钮
- **PRD**：`prd/bugfix/remote-deploy/bugfix-deploy-timeout-hang-v1.md`

### remote-deploy 多实例 token 冲突
- **严重程度**：Major
- **日期**：2026-04-16
- **现象**：dev/packaged 共享远端 proxy 时后启动实例 401 认证失败
- **根因**：proxy 单 token + registerTokenOnRemote() 未实现 + WS client 用错 token
- **PRD**：`prd/bugfix/remote-agent/bugfix-multi-token-registration-v1.md`

### startAgent pgrep 误判导致代理未启动
- **严重程度**：Critical
- **日期**：2026-04-16
- **现象**：Update Agent 后 proxy 始终显示"已停止"，远端确认无 node 进程
- **根因**：startAgent 仅用 pgrep 检查进程存在性，不验证 health 端点；pgrep 匹配到非 proxy 进程时误判"已在运行"并跳过启动
- **PRD**：`prd/bugfix/remote-agent/bugfix-startAgent-pgrep-false-positive-v1.md`

### Windows 下 tar 命令因反斜杠路径失败
- **严重程度**：Critical
- **日期**：2026-04-16
- **现象**：远程部署时报错 `Cannot connect to C: resolve failed`，部署完全不可用
- **根因**：`createDeployPackage()` 拼接 tar 参数时使用 Node.js 路径（含 `\`），Git Bash tar 将 `\` 视为转义符
- **PRD**：`prd/bugfix/remote-agent/bugfix-tar-path-windows-backslash-v1.md`

### 远程服务器管理 UX 三连修复
- **严重程度**：P0/P1
- **日期**：2026-05-13
- **现象**：1) 删除服务器后列表不刷新，必须退出重进；2) 密码错误时无明确提示；3) 密码修改后卡在 "Checking proxy service..."
- **根因**：1) IPC handler 未 await removeServer；2) SSH 认证错误未被专门识别；3) 密码更新后未清理缓存的 SSHManager，`_operationLock` 残留阻塞后续操作
- **PRD**：`prd/bugfix/remote/bugfix-remote-server-ux-v1.md`

### SSH 断连后 UI 状态显示过期
- **严重程度**：Major
- **日期**：2026-05-10
- **现象**：SSH 连接断开后（网络中断、服务器宕机等），UI 仍显示 SDK 和 Bot Proxy 状态为"正常"（绿色）
- **根因**：`SSHManager` 的 `close`/`error` 事件只设 `_ready = false`，无回调通知上层；健康监控跳过已断开服务器；`sdkInstalled`/`proxyRunning` 运行时状态被持久化到配置文件
- **PRD**：`prd/bugfix/remote-deploy/bugfix-remote-status-stale-v1.md`

### connectServer 重连后代理状态未刷新
- **严重程度**：Major
- **日期**：2026-04-16
- **现象**：应用重启/重连后 UI 始终显示"Bot 代理已停止"，即使代理实际在运行
- **根因**：`connectServer()` 连接成功后不调用 `detectAgentInstalled()`，`proxyRunning` 保持旧值
- **PRD**：`prd/bugfix/remote-agent/bugfix-proxy-status-not-updated-after-reconnect-v1.md`
