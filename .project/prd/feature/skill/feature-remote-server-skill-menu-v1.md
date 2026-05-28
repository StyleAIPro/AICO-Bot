# PRD [功能级] -- 远程空间斜杠菜单显示远程服务器技能

> 版本：feature-remote-server-skill-menu-v1
> 日期：2026-05-14
> 指令人：@misakamikoto
> 归属模块：renderer/hooks/slash-command
> 状态：in-progress
> 优先级：P1
> 影响范围：前端（useSlashCommand hook）

## 需求分析

### 背景

`feature-chat-slash-command-v1` 实现了输入 `/` 弹出技能选择菜单，但 `useSlashCommand` hook 始终加载**本地**已安装技能（`useSkillStore.installedSkills`）。

### 问题

当用户使用远程空间（`claudeSource === 'remote'`）时：
1. `/` 菜单显示的是**本地**机器的技能，而非远程服务器上的技能
2. SDK 运行在远程服务器上，使用的是远程服务器的技能目录（`~/.agents/skills/`）
3. 菜单中的技能与实际可用的技能不一致，用户选中一个本地有但远程没有的技能会导致调用失败

### 预期效果

- 本地空间：`/` 菜单显示本地已安装技能（现有行为不变）
- 远程空间：`/` 菜单显示远程服务器上已安装的技能
- 切换空间时自动更新技能列表

## 技术方案

### 核心思路

`useSlashCommand` hook 需要感知当前空间的 `claudeSource` 和 `remoteServerId`：
- 本地空间 → 使用 `installedSkills`（现有逻辑）
- 远程空间 → 使用 `remoteSkills[serverId]`（通过 `loadRemoteSkills` 加载）

### 修改文件

**文件**：`src/renderer/hooks/slash-command/useSlashCommand.ts`

#### 1. 新增参数

`UseSlashCommandOptions` 新增可选的 `claudeSource` 和 `remoteServerId`：

```typescript
interface UseSlashCommandOptions {
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onExecuteCommand?: (result: SlashCommandExecutionResult) => void;
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
}
```

#### 2. 根据 claudeSource 选择技能源

```typescript
const installedSkills = useSkillStore((s) => s.installedSkills);
const loadInstalledSkills = useSkillStore((s) => s.loadInstalledSkills);
const remoteSkills = useSkillStore((s) => s.remoteSkills);
const loadRemoteSkills = useSkillStore((s) => s.loadRemoteSkills);

const isRemote = claudeSource === 'remote' && !!remoteServerId;
const skills = isRemote ? (remoteSkills[remoteServerId!] ?? []) : installedSkills;

useEffect(() => {
  if (isRemote && remoteServerId) {
    loadRemoteSkills(remoteServerId);
  } else {
    loadInstalledSkills();
  }
}, [isRemote, remoteServerId, loadInstalledSkills, loadRemoteSkills]);
```

#### 3. handleTextChange 使用 skills 变量

将 `handleTextChange` 中所有 `installedSkills` 引用替换为 `skills`。

### 调用处更新

**文件**：`src/renderer/components/chat/InputArea.tsx`

传入 `claudeSource` 和 `remoteServerId`：

```typescript
const { useSlashCommand } = useSlashCommand({
  content,
  setContent,
  textareaRef,
  onExecuteCommand: handleCommandResult,
  claudeSource: currentSpaceType?.claudeSource,
  remoteServerId: currentSpace?.remoteServerId,
});
```

## 涉及文件（实际）

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/renderer/hooks/slash-command/useSlashCommand.ts` | 修改 | 新增 claudeSource/remoteServerId 参数，根据模式选择本地/远程技能 |
| 2 | `src/renderer/components/chat/InputArea.tsx` | 修改 | 读取 currentSpaceRemoteServerId 并传入 hook |

## 验收标准

- [ ] 本地空间：`/` 菜单显示本地已安装技能
- [ ] 远程空间：`/` 菜单显示远程服务器的技能
- [ ] 切换空间时技能列表自动更新
- [ ] 远程技能列表加载失败时菜单不显示技能（不报错）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-14 | 初始 PRD | @misakamikoto |
