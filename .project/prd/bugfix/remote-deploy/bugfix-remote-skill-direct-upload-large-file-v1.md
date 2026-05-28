---
timestamp: 2026-05-13
status: done
assignee: @mi-saka
priority: P1
parent: skill-sync-wrong-server-v1.md
---

# Bugfix: 技能市场直接安装到服务器 — 大文件导致 "unable to exec" 或服务器掉线

## 问题描述

在技能市场中将技能直接安装到远程服务器时，如果技能包含大文件（~96KB 以上），服务器会直接掉线或报错 "unable to exec"。小文件技能安装正常。

**复现步骤**：
1. 进入技能市场，选择一个包含大文件的技能
2. 安装目标选择远程服务器
3. 点击安装
4. 上传过程中服务器断开连接，或报错 "unable to exec"

**注意**：技能库页面的"同步到服务器"功能已在 `skill-sync-wrong-server-v1.md` 中修复，不存在此问题。

## 根因分析

`installRemoteSkillDirect()`（`remote-skill-manager.ts` 第 570-582 行）使用 base64 echo 方式上传文件到远程服务器：

```typescript
const base64Content = Buffer.from(file.content).toString('base64');
await executeWithTimeout(
  service,
  manager,
  `echo "${base64Content}" | base64 -d > "${remoteFilePath}"`,
  30000,
);
```

`executeCommand` 通过 SSH exec 通道发送 shell 命令。Linux 的 `MAX_ARG_STRLEN` 通常为 128KB。base64 编码会使数据膨胀约 33%，因此原始文件 ~96KB 时 base64 编码后就会超出限制。SSH 服务器直接拒绝执行命令，返回 "unable to exec" 错误。

同一个问题之前在 `syncLocalSkillToRemote()` 中出现过，已在 `skill-sync-wrong-server-v1.md` 中修复为使用 SFTP `writeFile()`。但 `installRemoteSkillDirect()` 是后续新增的"Direct Upload"功能，编写时未同步修复，仍然使用 base64 echo 方式。

**两条路径对比**：

| 路径 | 函数 | 上传方式 | 状态 |
|------|------|---------|------|
| 同步到服务器 | `syncLocalSkillToRemote()` | SFTP `writeFile()` | 已修复 |
| 市场直接安装 | `installRemoteSkillDirect()` | base64 echo | **未修复** |

此外，META.json 上传（第 628-634 行）也使用相同的 base64 echo 方式，虽然 META.json 通常较小不易触发，但应统一修复。

## 技术方案

将 `installRemoteSkillDirect()` 中的文件上传和 META.json 上传从 base64 echo 方式改为 SFTP `writeFile()`，与 `syncLocalSkillToRemote()` 保持一致。

**修改文件：`src/main/services/remote/deploy/remote-skill-manager.ts`**

### 修改 1：文件上传改用 SFTP（第 570-582 行）

```typescript
// 修改前
for (const file of files) {
  const remoteFilePath = `${remoteSkillDir}/${file.path}`;
  const remoteDir = path.dirname(remoteFilePath);
  await manager.executeCommand(`mkdir -p "${remoteDir}"`);
  const base64Content = Buffer.from(file.content).toString('base64');
  await executeWithTimeout(
    service,
    manager,
    `echo "${base64Content}" | base64 -d > "${remoteFilePath}"`,
    30000,
  );
  onOutput?.({ type: 'stdout', content: `  ✓ ${file.path}\n` });
}

// 修改后
for (const file of files) {
  const remoteFilePath = `${remoteSkillDir}/${file.path}`;
  const remoteDir = path.dirname(remoteFilePath);
  await manager.executeCommand(`mkdir -p "${remoteDir}"`);
  await manager.writeFile(remoteFilePath, Buffer.from(file.content));
  onOutput?.({ type: 'stdout', content: `  ✓ ${file.path}\n` });
}
```

### 修改 2：META.json 上传改用 SFTP（第 628-634 行）

```typescript
// 修改前
const metaBase64 = Buffer.from(metaJson).toString('base64');
await executeWithTimeout(
  service,
  manager,
  `echo "${metaBase64}" | base64 -d > "${remoteSkillDir}/META.json"`,
  30000,
);

// 修改后
await manager.writeFile(`${remoteSkillDir}/META.json`, Buffer.from(metaJson));
```

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 父 PRD | `.project/prd/bugfix/remote-deploy/skill-sync-wrong-server-v1.md` | 理解同样的 base64 echo 问题的根因和修复方式 |
| 源码文件 | `src/main/services/remote/deploy/remote-skill-manager.ts` | `installRemoteSkillDirect()` 第 478-657 行，本次修改的唯一文件；同时参考已修复的 `syncLocalSkillToRemote()` 第 704-708 行的 SFTP 写法 |
| 源码文件 | `src/main/services/remote/ssh/ssh-manager.ts` | `writeFile()` 方法实现（第 386-402 行），理解 SFTP 写入流程 |
| 功能设计 | `.project/prd/feature/skill/feature-direct-remote-skill-install-v1.md` | Direct Upload 功能的原始设计意图 |

## 涉及文件

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/main/services/remote/deploy/remote-skill-manager.ts` | 修改 | `installRemoteSkillDirect()` 文件上传和 META.json 上传从 base64 echo 改为 SFTP writeFile |

## 验收标准

- [ ] 包含大文件（>96KB）的技能能从技能市场直接安装到远程服务器（不再报 "unable to exec"）
- [ ] 小文件技能的安装不受影响
- [ ] META.json 正确上传到远程服务器
- [ ] 服务器连接在安装过程中保持稳定（不掉线）
- [ ] `syncLocalSkillToRemote()` 同步功能不受影响（回归验证）
- [ ] `npm run typecheck && npm run build` 通过
