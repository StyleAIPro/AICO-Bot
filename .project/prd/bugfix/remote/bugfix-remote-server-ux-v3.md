---
timestamp: 2026-05-13
status: done
assignee: @mi-saka
priority: P1
parent: bugfix-remote-server-ux-v2.md
---

# Bugfix: 密码修改后重连不自动部署 Agent

## 问题描述

v2 PRD 修复了密码修改后 error 状态未重置的问题，使 `loadServers()` 自动重连逻辑可以正常触发。但遗留一个问题：密码修改后服务器重连成功，Agent 状态检测完成，但不会自动部署。

**复现步骤**：
1. 添加服务器（密码错误）-> 状态为 error
2. 编辑服务器，将密码修改为正确密码，保存
3. v2 修复后：error 状态重置为 disconnected -> 自动重连成功 -> Agent 状态检测完成
4. 服务器显示 connected，但 Agent 未部署，proxy 未启动
5. 必须手动点击 "Deploy" 按钮才能部署

**期望行为**：与首次添加服务器一致 -- 检测到 Agent 未部署时自动部署。

## 根因分析

`server-manager.ts` 中两个函数的职责差异：

- **`addServer()`**（第 133-335 行）：连接 SSH -> 检测 Agent 状态 -> 自动部署离线包 -> 启动 proxy -> 完成
- **`connectServer()`**（第 628-760 行）：连接 SSH -> 检测 Agent 状态（仅 `detectAgentInstalled` 更新 `proxyRunning`/`sdkInstalled` 等字段）-> 完成，**不部署**

密码修改后 v2 修复通过 `loadServers()` 自动重连触发的是 `connectServer()`（第 739-746 行 `detectAgentInstalled`），该函数只读取 Agent 状态，不触发部署。而 `addServer()` 中的部署逻辑（第 208-315 行）没有被 `connectServer()` 调用。

## 技术方案

从 `addServer()` 中提取 Agent 部署就绪逻辑为独立函数 `ensureAgentReady()`，在 `connectServer()` 检测 Agent 状态后调用。

**新增函数 `ensureAgentReady(service, id)`**：

从 `addServer()` 第 208-315 行提取以下逻辑：
1. `checkDeployFilesIntegrity()` + `checkRemoteSdkVersion()` 检测部署状态
2. 如果文件缺失、版本过旧或 SDK 不匹配 -> 执行离线部署 + 启动 proxy
3. 如果文件和 SDK 正常 -> 确保 proxy 运行（启动或重启）
4. 部署失败不抛异常，只更新状态（与 `addServer` 中现有行为一致）

**修改 `connectServer()`**：

在 `detectAgentInstalled(id)` 之后（约第 746 行），调用 `ensureAgentReady(service, id)`。用 try/catch 包裹，确保部署失败不影响连接本身。

**`addServer()` 改造**：

`addServer()` 中原有的部署逻辑（第 208-315 行）替换为调用 `ensureAgentReady(service, id)`，保持行为一致。对已部署且 proxy 运行中的 Agent，`ensureAgentReady` 是 no-op（仅做检测）。

**修改文件：`src/main/services/remote/deploy/server-manager.ts`**

```typescript
// 新增：确保 Agent 已部署且 proxy 运行中
// 从 addServer 提取，connectServer 也可复用
async function ensureAgentReady(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) return;

  try {
    service.emitDeployProgress(id, 'detect', 'Detecting remote agent...', 55);

    const deployCheck = await service.checkDeployFilesIntegrity(id);
    const sdkOk = await (service as any).checkRemoteSdkVersion(id);

    if (!deployCheck.filesOk || deployCheck.needsUpdate || !sdkOk) {
      const reasons: string[] = [];
      if (!deployCheck.filesOk) reasons.push('files missing');
      if (deployCheck.needsUpdate && deployCheck.filesOk) reasons.push('version outdated');
      if (!sdkOk) reasons.push('SDK mismatch');

      service.emitDeployProgress(id, 'deploy', `Deploying (${reasons.join(', ')})...`, 60);
      await service.updateServer(id, { status: 'deploying' });

      try {
        const latestServer = (service as any).servers.get(id);
        const platform = latestServer?.detectedArch as 'x64' | 'arm64' | undefined;
        if (!platform) throw new Error('Cannot detect server CPU architecture');
        if (!(service as any).isOfflineBundleAvailable(platform)) {
          throw new Error(`Offline bundle not found (linux-${platform})`);
        }
        await service.deployAgentCodeOffline(id, platform);
        await service.updateServer(id, { status: 'connected' });
        await (service as any).verifyProxyHealth(id);
        service.emitDeployProgress(id, 'complete', 'Agent deployed', 100);
      } catch (deployError) {
        console.error(`[RemoteDeployService] ensureAgentReady deploy failed:`, deployError);
        await service.updateServer(id, {
          status: 'connected',
          error: `Auto-deploy failed: ${(deployError as Error).message}`,
        });
        service.emitDeployProgress(id, 'complete', `Deploy failed: ${(deployError as Error).message}`, 100);
      }
    } else {
      // Files and SDK OK -- ensure proxy is running
      const currentServer = (service as any).servers.get(id);
      if (currentServer?.proxyRunning && currentServer.assignedPort) {
        try {
          await service.stopAgent(id);
          await service.startAgent(id);
          await (service as any).verifyProxyHealth(id);
        } catch (restartError) {
          console.debug(`[RemoteDeployService] Proxy restart failed:`, restartError);
        }
      } else {
        try {
          await service.startAgent(id);
          await (service as any).verifyProxyHealth(id);
        } catch (startError) {
          console.debug(`[RemoteDeployService] Proxy start failed:`, startError);
        }
      }
    }
  } catch (detectError) {
    // Detection failure should not block connection
    console.debug(`[RemoteDeployService] ensureAgentReady detection failed:`, detectError);
  }
}
```

```typescript
// connectServer() 中 detectAgentInstalled 之后新增（约第 746 行）
try {
  await detectAgentInstalled(id);
  // 新增：自动部署/启动 Agent（与 addServer 行为一致）
  await ensureAgentReady(service, id);
} catch (detectError) {
  console.debug(`[RemoteDeployService] Agent detection/ready failed:`, detectError);
}
```

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 父 PRD | `.project/prd/bugfix/remote/bugfix-remote-server-ux-v2.md` | 理解 v2 密码修改重连修复的上下文 |
| 祖 PRD | `.project/prd/bugfix/remote/bugfix-remote-server-ux-v1.md` | 理解 v1 SSH Manager 缓存清理修复 |
| 源码文件 | `src/main/services/remote/deploy/server-manager.ts` | addServer 部署逻辑（第 208-315 行）和 connectServer 检测逻辑（第 738-746 行），本次修改的唯一文件 |
| 功能设计文档 | `.project/modules/remote-agent/features/remote-deploy/design.md` | 理解部署流程的设计意图 |

## 涉及文件

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/main/services/remote/deploy/server-manager.ts` | 修改 | 新增 ensureAgentReady()；connectServer 调用它；addServer 复用它 |

## 验收标准

- [ ] 密码修改后保存，服务器自动重连成功并自动部署 Agent（与首次添加行为一致）
- [ ] Agent 已部署且 proxy 正常运行时，`ensureAgentReady` 是 no-op（不重复部署）
- [ ] 离线部署包不存在时，部署失败不影响 SSH 连接，状态显示 connected + error 信息
- [ ] `detectAgentInstalled` 或部署检测失败时不阻塞连接（try/catch 兜底）
- [ ] `addServer()` 首次添加服务器行为不变（自动部署仍正常）
- [ ] `connectServer()` 手动连接（非密码修改重连）也能自动部署
- [ ] typecheck 和 build 通过：`npm run typecheck && npm run build`
