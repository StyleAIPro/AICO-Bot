# Bug 记录 -- 权限处理与转发

## BUG-001: AskUserQuestion 工具导致 Bot 卡死
- **日期**：2026-04-16
- **严重程度**：Critical
- **发现人**：@moonseeker1
- **问题**：Agent 调用 AskUserQuestion 后 Bot 永久卡住，用户无法看到问题卡片，只能手动停止
- **根因**：
  1. `permission-handler.ts` 的 pending promise 无超时机制，被丢弃后永远等待
  2. `chat.store.ts` 的 `isGenerating` 守卫静默丢弃问题，不通知主进程
  3. 缺少 renderer → main 的 reject IPC 通道
- **修复**：增加 5 分钟超时、放宽守卫、增加 reject IPC 通道
- **PRD**：`prd/bugfix-ask-user-question-hang-v1.md`
- **影响文档**：
  - [x] design.md — 异常流程补充超时和 reject 通道
  - [ ] api/ — 新增 IPC 通道需同步

---

## BUG-002: 高风险操作未触发权限确认弹窗
- **日期**：2026-05-11
- **严重程度**：Critical
- **发现人**：@mi-saka
- **问题**：Agent 执行 Bash 删除命令、Write/Edit 文件操作时不弹出权限确认弹窗，直接执行。本地和远程 Agent 模式均受影响。
- **根因**：`system-prompt.ts` 的 `DEFAULT_ALLOWED_TOOLS` 包含 Bash/Write/Edit 等高风险工具，该列表被传给 SDK 的 `allowedTools` 选项。SDK 将 `allowedTools` 中的工具视为预授权，自动放行不触发 `canUseTool` 回调，导致 `permission-handler.ts` 的权限检查逻辑从未执行。
- **修复**：
  1. 拆分 `DEFAULT_ALLOWED_TOOLS` 为 `AVAILABLE_TOOLS`（系统提示词用）和 `PRE_APPROVED_TOOLS`（仅 Read/Glob/Grep，SDK 预授权用）
  2. `ToolPermissionCard` 增加 Write/Edit 内容/diff 预览
  3. `resolve-permission` IPC handler 增加远程 WebSocket 转发
  4. MCP 工具添加日志记录
- **PRD**：`.project/prd/bugfix/agent/bugfix-permission-allowed-tools-v1.md`
- **影响文档**：
  - [x] changelog.md

---

## BUG-004: 远程 Agent 权限系统完全失效
- **日期**：2026-05-11
- **严重程度**：Critical
- **发现人**：@mi-saka
- **问题**：远程 Agent（remote-agent-proxy）执行任意破坏性命令时不弹出权限确认，直接执行。用户无法在本地 UI 介入确认。
- **根因**：远程代理三层权限绕过：`permissionMode: 'bypassPermissions'`、`dangerously-skip-permissions` extraArg、`canUseTool` 对所有工具无条件放行；且无权限请求转发到本地 UI 的 WebSocket 协议。
- **修复**：
  1. `claude-manager.ts`：`permissionMode` 改 `'default'`，移除 `dangerously-skip-permissions`，拆分 `PRE_APPROVED_TOOLS`
  2. `claude-manager.ts`：实现 `isDestructiveBashCommand()` 破坏性命令检测，扩展 `canUseTool` 回调
  3. `server.ts`：新增 `pendingPermissions` 注册表和 `onPermissionRequest` 回调，扩展 `tool:approve` handler
  4. `ws-types.ts` / `types.ts`：新增 `permission:request` / `permission:response` 消息类型
  5. `send-message-remote.ts`：新增 `permission:request` handler 转发到本地渲染进程
- **PRD**：`.project/prd/bugfix/agent/bugfix-remote-permission-bypass-v1.md`
- **影响文档**：
  - [x] changelog.md

---

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 5 |

---

## BUG-005: 远程 Agent 权限 Deny 按钮不生效

- **日期**：2026-05-12
- **严重程度**：Critical
- **发现人**：@mi-saka
- **问题**：用户在远程 Agent 权限确认弹窗中点击 Deny 后，命令仍然被执行。远程代理的 `tool:approve` handler 硬编码 `approved = message.type === 'tool:approve'`（永远为 true），完全忽略 `payload.approved` 字段。
- **根因**：
  1. `server.ts` 第 534 行：`const approved = message.type === 'tool:approve'`，由于本地 IPC handler 始终发送 `tool:approve` 类型，此值永远为 true
  2. `agent.ts` 第 204-208 行：无论用户 Allow/Deny 都发送 `type: 'tool:approve'`，未发送 `tool:reject`
- **修复**：
  1. `server.ts`：改为 `const approved = (message.payload as any)?.approved !== false`
  2. `agent.ts`：`type: data.approved ? 'tool:approve' : 'tool:reject'`
- **PRD**：`.project/prd/bugfix/agent/bugfix-remote-permission-ui-v1.md`
- **影响文档**：
  - [x] changelog.md

---

## BUG-006: 远程 Agent 会话复用时权限回调丢失

- **日期**：2026-05-12
- **严重程度**：Critical
- **发现人**：@mi-saka
- **问题**：远程 Agent 在首次创建会话时权限系统正常，但会话复用时（同一 conversationId 后续消息），`canUseTool` 回调被忽略，SDK 子进程回退到内置终端权限提示，用户被迫去远程服务器终端输入确认命令。
- **根因**：
  1. `SessionConfig` 接口缺少 `permissionMode` 字段，`needsSessionRebuild` 无法检测权限模式变化
  2. `getOrCreateSession()` 会话复用路径直接 `return existing.session`，不注入新的 `canUseTool` 回调
  3. SDK V2 Session 不支持动态更新 `canUseTool`（创建时序列化传递给 CLI 子进程）
- **修复**：
  1. `SessionConfig` 增加 `permissionMode` 字段
  2. `needsSessionRebuild()` 增加 `permissionMode` 检查
  3. 所有 `storedConfig` / `requestConfig` 构建位置包含 `permissionMode: 'default'`
  4. 会话复用路径：有 `canUseTool` 时强制重建会话（含 `activeSessions` 进行中防护）
  5. Resume 路径同样增加 `canUseTool` 检查
- **PRD**：`.project/prd/bugfix/agent/bugfix-remote-permission-session-reuse-v1.md`
- **影响文档**：
  - [x] changelog.md

---

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 6 |
| Major | 0 |
| Minor | 0 |

---

## BUG-007: SDK disallowedTools 对 Agent 工具无效导致子 Agent 乱创建

- **日期**：2026-05-30
- **严重程度**：Critical
- **发现人**：@misakamikoto
- **问题**：v4 通过 `disallowedTools: ['Agent', 'Task']` 尝试禁止子 Agent 创建，但 Agent 工具仍被模型调用。本地、远程、普通对话和 Hyper Space Leader 均受影响。
- **根因**：
  1. SDK 的 `disallowedTools` 只影响权限上下文，不影响 Agent 工具的实际 schema 呈现（Agent 由 `agentDefinitions` 子系统管理，独立于常规工具列表）
  2. `permission-handler.ts` 的 `createCanUseTool()` 无 Agent/Task 检查，走到 "All other tools: auto-allow" 分支
  3. 远程代理 `buildSdkOptions` 有注释 "disable Agent" 但无实际 `disallowedTools` 属性
  4. 远程代理 `canUseTool` 仅在 `onAskUserQuestion || onPermissionRequest` 存在时创建，两者都不存在时 Agent/Task 无任何拦截
- **修复**：
  1. `permission-handler.ts`：`createCanUseTool` 顶部添加 Agent/Task 拦截，新增 `allowSubagents` 参数控制
  2. `sdk-config.ts`：`BaseSdkOptionsParams` 添加 `allowSubagents` 并传递给 `createCanUseTool`
  3. `send-message-local.ts` / `session-lifecycle.ts`：传递 `allowSubagents: false`
  4. `orchestrator.ts`：Leader 传 `allowSubagents: false`，Worker 传 `allowSubagents: true`
  5. `claude-manager.ts`：添加 `disallowedTools: ['Agent', 'Task']`；`canUseTool` 改为始终创建（Agent/Task 拦截优先于其他逻辑）；`streamChatForApp` 添加 `canUseTool` 拦截
- **PRD**：`.project/prd/bugfix/agent/bugfix-excessive-subagents-v5.md`
- **影响文档**：
  - [x] changelog.md
