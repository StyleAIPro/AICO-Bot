---
timestamp: 2026-05-13
status: done
assignee: @mi-saka
priority: P1
---

# Feature: 技能更新改为全量安装（先删除后下载）

## 问题描述

当前从技能市场安装已安装的同名技能时，系统采用增量更新策略：仅覆盖新版本中存在的文件，旧版本中已删除的文件会残留在磁盘上成为孤立文件。这可能导致旧版文件干扰新版技能运行。

**期望行为**：安装已存在的技能时，先删除旧版技能目录，再下载新版全部文件，实现全量更新。

## 根因分析

当前安装逻辑在三个位置均只做 `mkdir -p` + 覆盖写入，不清理旧文件：

| 路径 | 函数 | 文件 | 行为 |
|------|------|------|------|
| 本地安装 | `installSkillFromSource()` | `skill.controller.ts:162` | `mkdir` + 逐文件 `writeFile`，不删旧目录 |
| 远程安装 | `installRemoteSkillDirect()` | `remote-skill-manager.ts:568` | `mkdir -p` + SFTP 写入，不删旧目录 |
| 本地 YAML 安装 | `SkillManager.installSkill()` | `skill-manager.ts:443` | `mkdir` + 写 YAML/META，不删旧目录 |

而 `syncRemoteSkillToLocal()`（`remote-skill-manager.ts:745-757`）已正确实现了"先删后装"模式，可作为参考。

## 技术方案

在三个安装函数中，创建目录前先检查目录是否存在，存在则先删除。

### 修改 1：本地安装 `installSkillFromSource()`

**文件**：`src/main/controllers/skill.controller.ts`（第 162 行前）

```typescript
// 修改前
await nodeFs.mkdir(skillDir, { recursive: true });

// 修改后
if (nodeFs.existsSync(skillDir)) {
  onOutput?.({ type: 'stdout', content: `  Removing existing skill directory...\n` });
  await nodeFs.rm(skillDir, { recursive: true, force: true });
}
await nodeFs.mkdir(skillDir, { recursive: true });
```

### 修改 2：远程安装 `installRemoteSkillDirect()`

**文件**：`src/main/services/remote/deploy/remote-skill-manager.ts`（第 568 行前）

```typescript
// 修改前
await manager.executeCommand(`mkdir -p "${remoteSkillDir}"`);

// 修改后
await manager.executeCommand(`rm -rf "${remoteSkillDir}"`);
await manager.executeCommand(`mkdir -p "${remoteSkillDir}"`);
```

远程场景无需检查是否存在，`rm -rf` 对不存在的路径是 no-op。

## 开发前必读

| 分类 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 源码文件 | `src/main/controllers/skill.controller.ts` | `installSkillFromSource()` 第 80-246 行，本地安装核心逻辑 |
| 源码文件 | `src/main/services/remote/deploy/remote-skill-manager.ts` | `installRemoteSkillDirect()` 第 478-645 行，远程安装核心逻辑；`syncRemoteSkillToLocal()` 第 745-757 行作为"先删后装"参考实现 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` | `installSkill()` 第 431-474 行，理解 YAML 安装路径（本次不修改，仅了解） |

## 涉及文件

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/main/controllers/skill.controller.ts` | 修改 | `installSkillFromSource()` 创建目录前先删除已存在的旧目录 |
| `src/main/services/remote/deploy/remote-skill-manager.ts` | 修改 | `installRemoteSkillDirect()` 创建目录前先 `rm -rf` 旧目录 |

## 验收标准

- [ ] 从技能市场安装已存在的技能时，旧版文件被完全清除（无孤立文件残留）
- [ ] 首次安装新技能时行为不变（目录不存在，跳过删除）
- [ ] 本地安装和远程安装均实现全量更新
- [ ] 安装后技能功能正常运行（META.json、SKILL.md 等文件完整）
- [ ] `npm run typecheck && npm run build` 通过
