---
timestamp: 2026-05-13
status: done
assignee: mi-saka
priority: P0/P1
---

# Bugfix: 远程服务器管理 UX 三连修复

## 问题描述

在设置页 → 远程服务器管理模块中存在三个 bug，影响用户日常操作流程。

### Bug 1 (P1): 删除服务器后列表不实时刷新

删除远程服务器后，服务器列表不会立即更新，仍显示已删除的服务器。必须退出设置界面重新进入才能看到更新后的列表。

**复现步骤**：
1. 进入设置页 → 远程服务器
2. 点击删除某个服务器
3. 确认删除
4. 服务器仍显示在列表中（实际已被删除）

### Bug 2 (P1): 添加服务器密码错误时无明确提示

添加服务器时，如果输入了错误的密码，SSH 认证失败后 UI 没有明确的错误提示告诉用户"密码错误"。用户无法区分是密码错误还是网络问题还是服务器不可达。

**复现步骤**：
1. 点击"添加服务器"
2. 填写正确的主机、端口、用户名
3. 故意输入错误的密码
4. 提交
5. 无明显错误提示（只有进度卡片中一行小字）

### Bug 3 (P0): 密码修改后重新连接卡在 "Checking proxy service..."

密码输入错误导致连接失败后，通过编辑功能将密码修改为正确的，再尝试连接或部署，UI 卡在 "Checking proxy service..." 一直不动。必须删除此服务器重新创建才能恢复。

**复现步骤**：
1. 添加服务器（密码错误）→ SSH 连接失败 → 服务器已保存但状态 error
2. 编辑该服务器，将密码修改为正确密码，保存
3. 点击"Deploy"或"Connect"
4. UI 卡在 "Checking proxy service..." 无响应

## 根因分析

### Bug 1 根因：IPC handler 未 await removeServer

`remote-server.ts:181` 中，`removeServer(id)` 是 `async` 函数，但没有被 `await`：

```typescript
// remote-server.ts:178-188
wrapIpcHandle('remote-server:delete', async (_event, id: string) => {
  deployService.removeServer(id);  // <-- async 函数未 await！
  return { success: true };
});
```

`removeServer()`（`server-manager.ts:491-518`）内部调用 `disconnectServer(id)` 和 `saveServers(service)`，这两个都是异步操作。由于没有 `await`，IPC handler 在 `removeServer` 完成**之前**就返回了 `{ success: true }`。

前端 `handleDeleteServer()`（`RemoteServersPage.tsx:360-373`）在收到 `success: true` 后调用 `loadServers()`，但此时 `saveServers()` 可能还没执行完，所以 `loadServers()` 读到的仍是旧数据（包含已删除的服务器）。

### Bug 2 根因：SSH 认证错误信息未被识别和增强

当前 `addServer()`（`server-manager.ts:319-328`）在 catch 块中捕获 SSH 连接异常，通过 `emitDeployProgress` 发送错误消息，同时返回 `{ sshConnected: false, error: errorMsg }`。

IPC handler（`remote-server.ts:64-80`）将此信息作为 `{ partial: true, error: errorMsg }` 返回。前端（`RemoteServersPage.tsx:283-294`）显示 notification toast。

问题在于：
1. SSH 认证失败时，`ssh2` 库的错误消息通常是英文技术文本（如 "All configured authentication methods failed"），普通用户不易理解
2. 错误消息没有针对"密码错误"场景做专门识别和本地化
3. notification toast 的 warning 级别不够醒目，且持续时间有限

### Bug 3 根因：SSH Manager 连接状态未在密码更新后清理

当密码错误导致 SSH 连接失败后，`SSHManager` 实例被缓存但处于异常状态：

1. **SSHManager 复用问题**：`getSSHManager()`（`server-manager.ts:528-535`）返回缓存的 SSHManager 实例。密码错误后 `_ready = false`，但 manager 对象仍在 `sshManagers` Map 中。

2. **Operation Lock 残留**：SSH 连接失败时，`SSHManager.connect()` 的 `error`/`close` 事件仅设置 `_ready = false`，但不会重置 `_operationLock` 或 `_forceDisconnected`。如果密码错误导致连接建立过程中失败（如 `ready` 事件未触发），可能有 pending 的 `_operationLock`。

3. **updateServer 不清理 SSH 连接**：`updateServer()`（`server-manager.ts:351-418`）只更新内存中的配置数据，不清理或断开现有的 SSH 连接。密码更新后，SSH Manager 内部缓存的 `this.config` 仍是旧密码。

4. **connectServer 中的 detectAgentInstalled 卡住**：即使 SSH 用新密码重连成功，`connectServer()`（第 714 行）调用 `detectAgentInstalled()`，其中 `executeCommandFull()` 使用 `withLock()` 会等待可能被卡住的 `_operationLock`，导致 UI 永久阻塞在 "Checking proxy service..." 阶段。

## 技术方案

### Bug 1 修复：IPC handler await removeServer

**文件：`src/main/ipc/remote-server.ts`**

```typescript
// 修改前
deployService.removeServer(id);

// 修改后
await deployService.removeServer(id);
```

确保 `removeServer()` 内部的 `disconnectServer()` 和 `saveServers()` 执行完毕后再返回 IPC 响应。

### Bug 2 修复：增强密码错误的识别和提示

**文件：`src/main/services/remote/deploy/server-manager.ts`**

在 `addServer()` 的 catch 块中，增加 SSH 认证错误的识别：

```typescript
catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  // 识别 SSH 认证相关错误
  const isAuthError = /authentication|auth|password|permission denied|keyboard-interactive/i.test(errorMsg);
  service.emitDeployProgress(
    id,
    'error',
    isAuthError ? `Authentication failed: ${errorMsg}` : `Connection failed: ${errorMsg}`,
    0,
  );
  await service.updateServer(id, { status: 'error', error: errorMsg });
  return { id, sshConnected: false, error: errorMsg, authError: isAuthError };
}
```

**文件：`src/main/ipc/remote-server.ts`**

IPC handler 传递 `authError` 标记：

```typescript
if (result.sshConnected) {
  return { success: true, data: { id: result.id } };
} else {
  return {
    success: true,
    data: { id: result.id, partial: true, error: result.error, authError: result.authError },
  };
}
```

**文件：`src/renderer/pages/RemoteServersPage.tsx`**

前端根据 `authError` 标记显示不同的提示：

```typescript
if (data?.partial) {
  const isAuthError = data.authError === true;
  useNotificationStore.getState().show({
    title: isAuthError
      ? t('Authentication failed')
      : t('Server added but connection failed'),
    body: data.error
      ? t('Connection failed: {{error}}. Please check your credentials and retry.', { error: data.error })
      : t('Connection failed. Please check your credentials and retry.'),
    variant: isAuthError ? 'error' : 'warning',
    duration: isAuthError ? 0 : 8000,  // 认证错误不自动消失
  });
}
```

### Bug 3 修复：密码更新时清理 SSH Manager

**文件：`src/main/services/remote/deploy/server-manager.ts`**

修改 `updateServer()` 函数，当检测到密码字段更新时，清理旧的 SSH Manager 并断开现有连接：

```typescript
export async function updateServer(
  service: RemoteDeployService,
  id: string,
  updates: Partial<...>,
): Promise<void> {
  // ... 现有逻辑 ...

  // 当 SSH 凭据（密码）被更新时，清理旧的 SSH Manager
  // 确保后续连接使用新凭据
  const passwordChanged = (
    (updates.password && updates.password !== server.ssh?.password) ||
    (updates.ssh?.password && updates.ssh.password !== server.ssh?.password)
  );

  if (passwordChanged) {
    const manager = (service as any).sshManagers.get(id);
    if (manager) {
      console.debug(`[RemoteDeployService] Password changed, disconnecting old SSH manager for ${server.name}`);
      manager.disconnect();
      (service as any).sshManagers.delete(id);
    }
  }

  (service as any).servers.set(id, { ...server, ...processedUpdates });
  await saveServers(service);
  // ...
}
```

**文件：`src/main/services/remote/ssh/ssh-manager.ts`**

确保 `connect()` 在 error 和 close 事件中正确清理 `_forceDisconnected` 和 `_operationLock`：

```typescript
this.client.on('error', (err) => {
  this._ready = false;
  this._forceDisconnected = false;  // 确保不阻塞后续操作
  this._operationLock = Promise.resolve();  // 释放可能被卡住的 operation lock
  console.error('[SSHManager] Connection error:', err);
  reject(err);
});

this.client.on('close', (reason) => {
  this._ready = false;
  this._forceDisconnected = false;
  this._operationLock = Promise.resolve();
  console.log('[SSHManager] Connection closed, reason:', reason);
  this.client = null;
  this.sftp = null;
  this._onDisconnectCallback?.();
});
```

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解远程服务器管理的整体架构和 IPC 通道定义 |
| 功能设计文档 | `.project/modules/remote-agent/features/remote-deploy/design.md` | 理解 addServer/updateServer/removeServer 的设计意图 |
| 功能 changelog | `.project/modules/remote-agent/features/remote-deploy/changelog.md` | 了解最近变更，特别是 SSH 超时和状态同步相关改动 |
| 功能 bugfix | `.project/modules/remote-agent/features/remote-deploy/bugfix.md` | 了解已知问题（特别是 SSH 命令超时、操作锁死锁等），避免重复踩坑 |
| 源码文件 | `src/main/services/remote/deploy/server-manager.ts` | addServer/updateServer/removeServer/connectServer 的核心实现，Bug 1/3 的主修改文件 |
| 源码文件 | `src/main/services/remote/ssh/ssh-manager.ts` | SSHManager 的 connect/disconnect/error 处理，Bug 3 的核心修改文件 |
| 源码文件 | `src/main/ipc/remote-server.ts` | IPC handler 层，Bug 1/2 需要修改 handler 的返回值处理 |
| 源码文件 | `src/renderer/pages/RemoteServersPage.tsx` | 前端 UI 层，Bug 1/2 需要修改错误提示逻辑 |
| 源码文件 | `src/main/services/remote/deploy/agent-runner.ts` | detectAgentInstalled 中的 "Checking proxy service..." 逻辑，理解 Bug 3 的卡住位置 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC handler try/catch 等编码规范 |

## 涉及文件

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/main/ipc/remote-server.ts` | 修改 | Bug 1: await removeServer; Bug 2: 传递 authError 标记 |
| `src/main/services/remote/deploy/server-manager.ts` | 修改 | Bug 2: addServer 识别认证错误; Bug 3: updateServer 清理 SSH Manager |
| `src/main/services/remote/ssh/ssh-manager.ts` | 修改 | Bug 3: error/close 事件中清理 _forceDisconnected 和 _operationLock |
| `src/renderer/pages/RemoteServersPage.tsx` | 修改 | Bug 2: 根据 authError 显示不同的错误提示 |
| `src/renderer/components/settings/RemoteServersSection.tsx` | 修改 | Bug 2: 设置页 partial 不重连 + error 状态不自动重连 |

## 验收标准

### Bug 1：删除服务器后列表实时刷新

- [ ] 删除服务器后，列表立即移除该服务器（无需退出重进）
- [ ] 删除操作返回前，后端 `saveServers()` 已执行完毕
- [ ] 删除有活跃 SSH 连接的服务器时，远程清理正常执行后列表才刷新
- [ ] 删除无活跃 SSH 连接的服务器时，列表立即刷新

### Bug 2：密码错误时明确提示

- [ ] 添加服务器密码错误时，UI 显示明确的错误 notification（variant: error，不自动消失）
- [ ] 错误提示标题区分"认证失败"和"连接失败"
- [ ] 错误提示包含具体的 SSH 错误信息
- [ ] 密码正确时添加服务器行为不受影响（无额外提示）
- [ ] 非 SSH 认证原因的连接失败（如网络不通），显示 warning 级别提示而非 error

### Bug 3：密码修改后可正常重新连接

- [ ] 密码错误导致连接失败后，编辑密码为正确值并保存
- [ ] 保存密码后点击 "Deploy" 或 "Connect"，不再卡在 "Checking proxy service..."
- [ ] 密码正确的情况下，SSH 连接成功，后续检测和部署流程正常完成
- [ ] 旧的 SSH Manager 实例在密码更新后被正确清理和断开
- [ ] SSH 连接失败（error/close 事件）后，`_operationLock` 和 `_forceDisconnected` 被正确重置，不阻塞后续操作
