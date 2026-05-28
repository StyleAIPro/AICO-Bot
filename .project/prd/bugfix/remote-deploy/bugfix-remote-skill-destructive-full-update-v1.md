---
timestamp: 2026-05-14
status: done
module: remote-agent
level: bugfix
requester: user
---

# Bugfix: syncLocalSkillToRemote 覆盖式同步不删除远程旧文件，改为破坏式全量更新

## 需求分析

将远程服务器安装/更新 skill 的所有方式统一为破坏式全量更新（先 `rm -rf` 远程 skill 目录，再全量上传）。

当前代码中有三种远程 skill 部署路径：

| # | 路径 | 函数 | 当前策略 | 是否需要改 |
|---|------|------|---------|-----------|
| 1 | 市场直接安装 Direct Upload | `installRemoteSkillDirect()` | 破坏式全量（`rm -rf` + 全量上传） | 否（已在 `feature-skill-full-update-v1` 中修复） |
| 2 | 市场安装 npx | `installRemoteSkill()` | 由 npx 管理，不适用 | 否 |
| 3 | 本地同步到远程 | `syncLocalSkillToRemote()` | **覆盖式全量**（`mkdir -p` + 覆盖上传） | **是** |

路径 3 `syncLocalSkillToRemote()` 存在缺陷：它只执行 `mkdir -p` + 逐文件 SFTP 写入，不会删除远程目录中已存在但本地不存在的旧文件。当 skill 更新后删除了某些文件（重命名、重构目录结构等），远程会残留旧版文件，可能导致 Agent 读取到过期内容或触发意外行为。

## 问题根因

`feature-skill-full-update-v1` PRD 修复了 `installRemoteSkillDirect()` 的破坏式更新，但**遗漏了 `syncLocalSkillToRemote()`**。该函数在 `remote-skill-manager.ts` 第 690 行仅执行 `mkdir -p`，未在写入前清除远程旧目录。

```typescript
// remote-skill-manager.ts:690 — 当前代码
await manager.executeCommand(`mkdir -p ${remoteSkillDir}`);
```

同文件中其他路径已正确实现破坏式更新：

- `installRemoteSkillDirect()` 第 568 行：`await manager.executeCommand('rm -rf "${remoteSkillDir}"');` ✅
- `syncRemoteSkillToLocal()` 第 757 行：`await fsp.rm(localSkillDir, { recursive: true, force: true });` ✅（本地侧，逻辑一致）

## 技术方案

在 `syncLocalSkillToRemote()` 的 `mkdir -p` 之前插入 `rm -rf` 命令，与 `installRemoteSkillDirect()` 保持一致。

### 修改文件

**文件**：`src/main/services/remote/deploy/remote-skill-manager.ts`

### 修改内容

**第 690 行**，将：

```typescript
await manager.executeCommand(`mkdir -p ${remoteSkillDir}`);
```

改为：

```typescript
await manager.executeCommand(`rm -rf ${remoteSkillDir}`);
await manager.executeCommand(`mkdir -p ${remoteSkillDir}`);
```

`rm -rf` 对不存在的路径是 no-op（无报错），因此无需额外检查目录是否存在，首次同步时也能安全执行。

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 源码文件 | `src/main/services/remote/deploy/remote-skill-manager.ts` 第 652-711 行 | `syncLocalSkillToRemote()` 完整实现，本次修改的唯一位置 |
| 源码文件 | `src/main/services/remote/deploy/remote-skill-manager.ts` 第 565-570 行 | `installRemoteSkillDirect()` 的 `rm -rf` 实现作为参考 |
| 已有 PRD | `.project/prd/feature/skill/feature-skill-full-update-v1.md` | 理解"先删后装"策略的上下文，以及为何 `syncLocalSkillToRemote` 被遗漏 |
| 功能变更记录 | `.project/modules/remote-agent/features/remote-deploy/changelog.md` | 了解 remote-deploy 最近变更，避免回归 |
| 功能 bug 记录 | `.project/modules/remote-agent/features/remote-deploy/bugfix.md` | 了解已有 bug 模式 |

## 涉及文件

| # | 文件路径 | 修改类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/services/remote/deploy/remote-skill-manager.ts` | 修改 | `syncLocalSkillToRemote()` 第 690 行，`mkdir -p` 前插入 `rm -rf` |

## 验收标准

- [x] 同步本地 skill 到远程服务器时，远程旧 skill 目录被完全清除后重新上传（无旧文件残留）
- [x] 首次同步新 skill 到远程服务器时行为不变（目录不存在，`rm -rf` 为 no-op）
- [x] 同步后远程 skill 目录中的文件列表与本地完全一致（无多余文件、无缺失文件）
- [x] 技能更新后删除了某些文件的场景，远程同步后这些文件不再存在
- [x] `installRemoteSkillDirect()`（市场直接安装）不受影响（回归验证）
- [x] `npm run typecheck && npm run build` 通过（已有类型错误与本次改动无关）
