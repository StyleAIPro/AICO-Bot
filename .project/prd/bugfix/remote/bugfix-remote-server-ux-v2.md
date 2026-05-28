---
timestamp: 2026-05-13
status: done
assignee: @mi-saka
priority: P1
parent: bugfix-remote-server-ux-v1.md
---

# Bugfix: 密码修改后服务器 error 状态未重置导致无法自动重连

## 问题描述

v1 PRD（`bugfix-remote-server-ux-v1.md`）Bug 3 修复了密码修改后 SSHManager 缓存清理问题，但遗留一个状态未重置的问题。

用户修改错误密码为正确密码并保存后，服务器状态仍为 `error`。前端 `loadServers()` 中的自动重连逻辑只处理 `status === 'disconnected'` 的服务器，不会重连 `error` 状态的服务器。导致用户修改密码后仍必须删除重建服务器才能连接。

**复现步骤**：
1. 添加服务器（密码错误）-> 服务器保存，状态为 error
2. 编辑服务器，将密码修改为正确密码，保存
3. 服务器状态仍为 error，自动重连不会触发
4. 必须删除服务器重新创建

## 根因分析

三个环节共同导致此问题：

1. **`server-manager.ts` 的 `updateServer()`**：v1 修复已在密码变更时销毁旧 SSHManager（第 427-435 行），但没有重置服务器状态。密码变更后服务器仍保持 `error` 状态。

2. **`RemoteServersSection.tsx` 的 `loadServers()`**：自动重连过滤条件为 `s.status === 'disconnected'`（第 451 行），这是 v1 修复中故意排除 `error` 状态以防止连接失败后无限重连循环。但密码修改后的服务器仍为 `error` 状态，被过滤掉了。

3. **`handleEditServer()` 保存后**：只调用 `loadServers()`（第 709 行），不主动触发重连。

**核心矛盾**：v1 排除 error 状态是为了防止循环重连，但密码修改场景下 error 状态应该被清除。

## 技术方案

在 `updateServer()` 中，当检测到密码变更且当前服务器状态为 `error` 时，将状态重置为 `disconnected`。

这样 `loadServers()` 的自动重连逻辑（`status === 'disconnected'` 过滤）可以正常触发，无需修改前端重连逻辑，也不会引入 error 状态的无限重连循环（因为只有密码变更时才会重置状态）。

**修改文件：`src/main/services/remote/deploy/server-manager.ts`**

在 `updateServer()` 函数中，密码变更清理 SSHManager 之后、`saveServers()` 之前，添加状态重置逻辑：

```typescript
// 现有密码变更处理（第 427-435 行）
const newPassword = processedUpdates.ssh?.password ?? updates.ssh?.password;
if (newPassword && originalPassword !== undefined && newPassword !== originalPassword) {
  const manager = (service as any).sshManagers.get(id);
  if (manager) {
    console.debug(`[RemoteDeployService] Password changed, destroying old SSH manager for ${server.name}`);
    manager.disconnect();
    (service as any).sshManagers.delete(id);
  }
}

// 新增：密码变更且当前状态为 error 时，重置为 disconnected
// 这样 loadServers() 的自动重连逻辑可以正常触发
const currentServer = (service as any).servers.get(id);
if (currentServer?.status === 'error') {
  (service as any).servers.set(id, { ...currentServer, status: 'disconnected', error: undefined });
  console.debug(`[RemoteDeployService] Password changed, reset error status to disconnected for ${server.name}`);
}
```

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 父 PRD | `.project/prd/bugfix/remote/bugfix-remote-server-ux-v1.md` | 理解 v1 Bug 3 的修复内容和遗留问题 |
| 源码文件 | `src/main/services/remote/deploy/server-manager.ts` | updateServer() 中密码变更处理逻辑，本次修改的唯一文件 |
| 源码文件 | `src/renderer/components/settings/RemoteServersSection.tsx` | loadServers() 自动重连过滤条件，理解为什么选择在后端重置状态而非修改前端 |

## 涉及文件

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/main/services/remote/deploy/server-manager.ts` | 修改 | updateServer() 密码变更时将 error 状态重置为 disconnected |

## 验收标准

- [ ] 添加服务器（密码错误）后服务器状态为 error
- [ ] 编辑该服务器，将密码修改为正确密码，保存后服务器状态自动重置为 disconnected
- [ ] 保存后 `loadServers()` 自动重连逻辑触发，服务器自动连接成功
- [ ] 密码未变更的 updateServer 调用不影响 error 状态（不会误重置）
- [ ] 非 error 状态的服务器密码变更不受影响（如 connected 状态的密码修改）
- [ ] typecheck 和 build 通过：`npm run typecheck && npm run build`
