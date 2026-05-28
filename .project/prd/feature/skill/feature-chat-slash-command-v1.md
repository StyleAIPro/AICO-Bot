# PRD [功能级] -- 聊天输入框技能快速选择菜单

> 版本：feature-chat-slash-command-v1
> 日期：2026-05-14 20:30
> 指令人：@misakamikoto
> 归属模块：renderer/chat + renderer/hooks/slash-command
> 状态：in-progress
> 优先级：P1
> 影响范围：前端（chat UI + slash-command 系统）

## 需求分析

### 背景

AICO-Bot 的斜杠命令框架（`slash-command-framework-v1`）已实现并落地，当前支持在输入框中输入 `/` 时弹出已注册的斜杠命令菜单（如 `/skill list`、`/skill install` 等）。这些命令在本地执行后以内联系统消息形式反馈在聊天区域。

但当前的 `/` 菜单**只显示管理类命令**（如 `/skill list`、`/skill enable`），**不显示已安装的技能列表**。在 Claude Code 中，用户输入 `/` 时可以直接看到所有已安装的技能（如 `/review`、`/simplify` 等），选择后技能的系统提示词会注入到当前对话中，UI 上以 `/skill-name` 标记样式显示而非提示词原文。

### 问题

1. **技能发现性差**：用户在聊天场景中无法快速查看和调用已安装技能，必须记住 `/skill list` 命令或切换到技能页面
2. **技能调用路径长**：用户想使用某个技能时，需要输入 `/skill list` 查看列表 -> 记住技能名 -> 在下一轮对话中手动输入技能触发命令（如 `/code-commit`）
3. **与 Claude Code 体验不一致**：Claude Code 的斜杠菜单直接展示可用技能，AICO-Bot 目前缺少这一核心交互

### 用户场景

1. 用户在输入框输入 `/`，弹出菜单同时显示管理命令和已安装技能列表
2. 用户输入 `/rev` 进行模糊搜索，菜单过滤显示匹配的技能（如 `/review`）
3. 用户通过上下键在菜单中导航，选中某个技能后按 Enter
4. 选中技能后，输入框显示 `/skill-name`，用户可继续输入补充说明后按 Enter 发送
5. 消息发送到 Agent 时，技能的系统提示词（`system_prompt`）会被注入到 Agent 的上下文中
6. 聊天列表中该用户消息以 `/skill-name` 的特殊标记样式显示（类似 Claude Code 的斜杠命令标记），而非展示完整的提示词内容

### 预期效果

- 输入 `/` 时弹出菜单，分两个区域显示：**已注册命令**（现有 `/skill` 等）和 **已安装技能**（如 `/review`、`/simplify`）
- 支持模糊搜索过滤
- 支持键盘上下键导航、Enter 选中、Tab 补全、Esc 关闭
- 选中技能后输入框显示 `/skill-name`，作为普通消息发送（非命令拦截）
- 技能的 `system_prompt` 通过消息元数据传递给后端，后端在 SDK 配置中注入
- 聊天列表中以特殊标记样式渲染该消息：显示 `/skill-name` + 技能描述，而非消息原文

## 技术方案

### 整体设计

本方案扩展现有斜杠命令框架，在 `useSlashCommand` hook 的菜单中增加「已安装技能」分组。选中技能后不走命令执行路径（`executeSlashCommand`），而是走普通消息发送路径，通过消息元数据标记技能信息，后端根据元数据注入技能系统提示词。

```
用户输入 "/" → useSlashCommand 检测
    ↓
SlashCommandMenu 显示两个分组：
    1. 命令（现有 /skill 等）
    2. 技能（已安装技能列表）
    ↓
用户选中技能（如 /review）→ 输入框替换为 "/review"
    ↓
用户按 Enter 发送（不拦截，走普通 sendMessage 路径）
    ↓
消息携带 metadata: { skillId, skillName }
    ↓
后端 sendMessage 检测到 skillId → 在 systemPrompt 中注入技能的 system_prompt
    ↓
前端 MessageItem 渲染：检测到 skillId → 显示 /skill-name 标记样式
```

### 1. 扩展 SlashCommandMenuItem 类型

**文件**：`src/renderer/hooks/slash-command/types.ts`

新增 `skill` 类型的菜单项：

```typescript
export interface SlashCommandMenuItem {
  type: 'command' | 'subcommand' | 'skill'; // 新增 'skill'
  label: string;
  description: string;
  icon?: string;
  command?: SlashCommand;        // 命令类型
  subcommand?: SlashCommandSubcommand; // 子命令类型
  skill?: InstalledSkill;        // 技能类型（新增）
  insertText: string;
}
```

### 2. 扩展 useSlashCommand hook 加载已安装技能

**文件**：`src/renderer/hooks/slash-command/useSlashCommand.ts`

#### 2.1 加载已安装技能列表

在 hook 中调用 `useSkillStore` 获取已安装技能（仅 `enabled: true`），在 `handleTextChange` 中当 `match.type === 'command'` 且 `query` 不为空或为空时，同时搜索已注册命令和已安装技能：

```typescript
import { useSkillStore } from '../../stores/skill/skill.store';

// 在 hook 内部
const installedSkills = useSkillStore((state) => state.installedSkills);
const loadInstalledSkills = useSkillStore((state) => state.loadInstalledSkills);

// 初始化时加载技能列表
useEffect(() => {
  loadInstalledSkills();
}, [loadInstalledSkills]);
```

#### 2.2 修改 handleTextChange 合并技能到菜单

当 `match.type === 'command'` 时（即 `/` 后输入中），将已安装技能也加入匹配列表：

```typescript
if (match.type === 'command') {
  const allCommands = slashCommandRegistry.getAllCommands();
  const query = match.query ?? '';

  // 已注册命令（现有逻辑）
  const filteredCommands = allCommands.filter((cmd) =>
    cmd.name.toLowerCase().includes(query.toLowerCase()),
  );
  const commandItems: SlashCommandMenuItem[] = filteredCommands.map((cmd) => ({
    type: 'command' as const,
    label: t(cmd.labelKey),
    description: t(cmd.descriptionKey),
    icon: cmd.icon,
    command: cmd,
    insertText: `/${cmd.name} `,
  }));

  // 已安装技能（新增逻辑）
  const enabledSkills = installedSkills.filter((s) => s.enabled);
  const filteredSkills = enabledSkills.filter((s) =>
    s.spec.name.toLowerCase().includes(query.toLowerCase()) ||
    (s.spec.trigger_command && s.spec.trigger_command.toLowerCase().includes(query.toLowerCase())),
  );
  const skillItems: SlashCommandMenuItem[] = filteredSkills.map((skill) => ({
    type: 'skill' as const,
    label: skill.spec.trigger_command || `/${skill.spec.name}`,
    description: skill.spec.description,
    icon: 'Sparkles', // 技能使用 Sparkles 图标
    skill,
    insertText: `${skill.spec.trigger_command || `/${skill.spec.name}`} `,
  }));

  // 合并：命令在前，技能在后
  const items = [...commandItems, ...skillItems];
  setMatchedCommands(items);
  setShowCommandMenu(items.length > 0);
}
```

#### 2.3 修改 Enter 键处理逻辑

当选中的是技能类型菜单项且已填入文本时，**不拦截 Enter 键**，让消息走普通发送路径：

```typescript
// 在 handleSlashKeyDown 中，当菜单显示且 Enter 时：
case 'Enter': {
  if (currentMatch.type === 'argument') {
    e.preventDefault();
    executeCurrentCommand();
    return true;
  }
  if (matchedCommands.length > 0) {
    const selectedItem = matchedCommands[selectedIndex];
    if (selectedItem.type === 'skill') {
      // 技能选中后：插入文本 + 不拦截 Enter（走普通发送路径）
      e.preventDefault();
      selectMenuItem(selectedItem);
      return true;
    }
    // 非技能命令：保持现有行为（补全/执行）
    e.preventDefault();
    selectMenuItem(selectedItem);
    return true;
  }
  break;
}
```

**关键点**：技能选中后输入框内容变为 `/skill-name ...`，用户再次按 Enter 发送时，`handleSlashKeyDown` 中不应拦截。当前已有的逻辑是：如果输入内容不是已注册命令，则不拦截（`return false`），让 `handleSend` 正常执行。技能的 trigger_command（如 `/review`）不是已注册的 slash command，所以会自动走普通发送路径。

### 3. 修改 SlashCommandMenu 组件支持技能分组

**文件**：`src/renderer/components/chat/SlashCommandMenu.tsx`

在菜单中分两个区域显示：「命令」和「技能」，技能项使用不同图标：

```typescript
import { Wrench, Sparkles } from 'lucide-react';

// 在渲染时，根据 item.type 区分：
// type === 'skill' 时显示 Sparkles 图标
// 其他显示 Wrench 或空白图标
```

分组标题：当同时有命令和技能时，显示分组标题行（如「Commands」和「Skills」）。

### 4. 消息发送时携带技能元数据

**文件**：`src/renderer/stores/chat.store.ts`

修改 `sendMessage` 函数，检测消息内容是否以技能 trigger_command 开头。如果是，则在 `Message` 对象中添加 `metadata.skillId` 和 `metadata.skillName`：

```typescript
sendMessage: async (content, images, aiBrowserEnabled, thinkingEnabled, agentId) => {
  // ... 现有逻辑 ...

  // 检测是否为技能触发消息
  const { installedSkills } = useSkillStore.getState();
  const trimmedContent = content.trim();
  const matchedSkill = installedSkills.find(
    (s) => s.enabled && s.spec.trigger_command &&
      trimmedContent.startsWith(s.spec.trigger_command) &&
      (trimmedContent.length === s.spec.trigger_command!.length ||
       trimmedContent[s.spec.trigger_command!.length] === ' '),
  );

  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    images,
    metadata: matchedSkill ? {
      skillId: matchedSkill.appId,
      skillName: matchedSkill.spec.name,
      skillTrigger: matchedSkill.spec.trigger_command,
      skillDescription: matchedSkill.spec.description,
    } : undefined,
  };

  // 发送 API 调用时也携带 skillId
  await api.sendMessage({
    spaceId: currentSpaceId,
    conversationId,
    message: content,
    images,
    aiBrowserEnabled,
    thinkingEnabled,
    canvasContext: buildCanvasContext(),
    agentId: agentId || 'leader',
    skillId: matchedSkill?.appId,  // 新增字段
  });
};
```

### 5. 后端接收 skillId 并注入系统提示词

**文件**：`src/main/services/agent/send-message-local.ts`

在 `sendMessage` 函数中，检查请求参数中的 `skillId`，如果存在则从 `SkillManager` 获取技能的 `system_prompt` 并追加到系统提示词中：

```typescript
// 在构建 sdkOptions 的 systemPrompt.append 部分
if (params.skillId) {
  const skill = SkillManager.getInstance().getSkill(params.skillId);
  if (skill?.spec.system_prompt) {
    systemPromptAppend += `\n\n## Active Skill: ${skill.spec.name}\n\n${skill.spec.system_prompt}`;
  }
}
```

**文件**：`src/main/services/agent/send-message-remote.ts`

远程发送路径也需传递 `skillId`，由远程 proxy 在 stream-processor 中处理技能提示词注入。

### 6. 前端 MessageItem 技能标记渲染

**文件**：`src/renderer/components/chat/MessageItem.tsx`

当用户消息包含 `metadata.skillId` 时，以特殊标记样式渲染（而非普通文本）：

```typescript
// 在用户消息内容渲染区域
{isUser && message.metadata?.skillId ? (
  <div className="flex items-center gap-2">
    <Sparkles size={16} className="text-primary flex-shrink-0" />
    <span className="font-mono text-primary font-medium">
      {message.metadata.skillTrigger || `/${message.metadata.skillName}`}
    </span>
    {message.metadata.skillDescription && (
      <span className="text-xs text-muted-foreground">
        {message.metadata.skillDescription}
      </span>
    )}
    {/* 如果用户在技能命令后还有补充文字，显示补充文字 */}
    {message.content !== message.metadata.skillTrigger && (
      <span className="text-sm text-foreground">
        {message.content.substring((message.metadata.skillTrigger?.length ?? 0)).trim()}
      </span>
    )}
  </div>
) : isUser ? (
  <span className="whitespace-pre-wrap">{message.content}</span>
) : (
  // ... 现有 assistant 渲染逻辑
)}
```

### 7. Message 类型扩展

**文件**：`src/renderer/types/index.ts`

在 `Message.metadata` 中新增技能相关字段：

```typescript
metadata?: {
  fileChanges?: FileChangesSummary;
  // ... 现有字段 ...
  // 技能标记（新增）
  skillId?: string;
  skillName?: string;
  skillTrigger?: string;
  skillDescription?: string;
};
```

### 8. IPC / API 层变更

**文件**：`src/main/ipc/agent.ts` / `src/preload/index.ts` / `src/renderer/api/transport.ts`

`sendMessage` IPC 通道的参数类型新增可选字段 `skillId?: string`。这需要同步修改：

1. **`src/shared/constants/`** — `agent:sendMessage` 参数类型
2. **`src/preload/index.ts`** — `sendMessage` 参数
3. **`src/main/ipc/agent.ts`** — handler 参数解构
4. **`src/renderer/api/transport.ts`** — `sendMessage` 调用

### 数据流总结

```
用户输入 "/" → useSlashCommand 弹出菜单（命令 + 技能）
    ↓
用户选中技能 "/review" → 输入框显示 "/review"
    ↓
用户输入补充文字 "/review 检查这个 PR"
    ↓
Enter 发送 → chat.store.sendMessage()
    ↓
检测到 "/review" 匹配已安装技能 → userMessage.metadata = { skillId, skillName, ... }
    ↓
UI 立即显示标记样式消息（/review + "检查这个 PR"）
    ↓
api.sendMessage({ message: "/review 检查这个 PR", skillId: "xxx" })
    ↓
后端 sendMessage → 检测 skillId → 注入技能 system_prompt 到 SDK 配置
    ↓
SDK 发送给 LLM（含技能系统提示词）
```

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/chat/chat-ui-v1.md` | 理解 Chat UI 模块架构、组件树、InputArea 集成方式 |
| 2 | `.project/modules/skill/skill-system-v1.md` | 理解技能系统架构、InstalledSkill 类型、SkillManager 接口 |
| 3 | `.project/prd/feature/slash-command-framework-v1.md` | 理解现有斜杠命令框架的完整设计（parseInput、菜单、键盘导航） |

### 源码文件

| # | 文件 | 阅读目的 |
|---|------|---------|
| 4 | `src/renderer/hooks/slash-command/useSlashCommand.ts` | 理解现有 hook 逻辑：菜单显示/隐藏、键盘导航、命令拦截规则 |
| 5 | `src/renderer/hooks/slash-command/types.ts` | 理解 SlashCommandMenuItem、SlashCommandMatch 类型定义 |
| 6 | `src/renderer/hooks/slash-command/slash-command-registry.ts` | 理解 parseInput 的匹配逻辑，确保技能匹配不冲突 |
| 7 | `src/renderer/hooks/slash-command/slash-command-executor.ts` | 理解命令执行路径，确保技能不走此路径 |
| 8 | `src/renderer/components/chat/SlashCommandMenu.tsx` | 理解菜单渲染逻辑，扩展分组显示 |
| 9 | `src/renderer/components/chat/InputArea.tsx` | 理解 hook 集成方式和 handleKeyDown 分发逻辑 |
| 10 | `src/renderer/components/chat/MessageItem.tsx` | 理解用户消息渲染逻辑，新增技能标记样式 |
| 11 | `src/renderer/stores/chat.store.ts` | 理解 sendMessage 函数：消息构建、API 调用参数 |
| 12 | `src/renderer/stores/skill/skill.store.ts` | 理解 installedSkills 状态和 loadInstalledSkills 方法 |
| 13 | `src/shared/skill/skill-types.ts` | 理解 InstalledSkill、SkillSpec 类型（含 system_prompt、trigger_command） |
| 14 | `src/main/services/agent/send-message-local.ts` | 理解本地消息发送逻辑和 systemPrompt 构建 |
| 15 | `src/main/services/agent/sdk-config.ts` | 理解 SDK 配置中 systemPrompt 的 append 机制 |
| 16 | `src/renderer/types/index.ts` | 理解 Message 类型定义，确认 metadata 字段结构 |
| 17 | `src/renderer/api/index.ts` | 理解 sendMessage API 调用参数 |

### 编码规范

| # | 文件 | 阅读目的 |
|---|------|---------|
| 18 | `docs/Development-Standards-Guide.md` | TypeScript strict、禁止 any、纯类型导入、i18n t() 使用 |
| 19 | `docs/vibecoding-doc-standard.md` | 文档管理规范 |

## 涉及文件（实际）

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/renderer/hooks/slash-command/types.ts` | 修改 | SlashCommandMenuItem 新增 `type: 'skill'`、`skill` 字段，`command` 改为可选 |
| 2 | `src/renderer/hooks/slash-command/useSlashCommand.ts` | 修改 | 导入 useSkillStore，加载已安装技能，handleTextChange 合并技能到菜单 |
| 3 | `src/renderer/components/chat/SlashCommandMenu.tsx` | 修改 | 分组显示 Commands/Skills，技能使用 Sparkles 图标 |
| 4 | `src/renderer/stores/chat.store.ts` | 修改 | sendMessage 检测技能触发，userMessage.metadata 添加技能信息 |
| 5 | `src/renderer/components/chat/MessageItem.tsx` | 修改 | 用户消息含 skillId 时渲染为 Sparkles + /skill-name 标记样式 |
| 6 | `src/renderer/types/index.ts` | 修改 | Message.metadata 新增 skillId/skillName/skillTrigger/skillDescription |
| 7 | `.project/modules/chat/features/input-area/changelog.md` | 修改 | 追加变更记录 |
| 8 | `.project/modules/chat/features/message-render/changelog.md` | 修改 | 追加变更记录 |

> 注：后端不需要修改。SDK 通过 `additionalDirectories` 自动发现技能并加载 `system_prompt`，用户发送 `/skill-name` 消息后 SDK 自行识别调用。

## 验收标准

### 菜单交互

- [ ] 输入 `/` 时菜单同时显示已注册命令和已安装技能（分两个区域）
- [ ] 仅显示 `enabled: true` 的技能
- [ ] 输入 `/rev` 时菜单过滤显示匹配的技能（如 `/review`）
- [ ] 上下键可在命令和技能之间导航
- [ ] Tab 键补全技能名称到输入框
- [ ] Esc 键关闭菜单
- [ ] 点击菜单外部关闭菜单
- [ ] 没有已安装技能时，菜单仅显示命令（不显示空的技能分组）
- [ ] 没有匹配结果时显示「无匹配命令」

### 技能选中与发送

- [ ] 选中技能后输入框显示技能的 trigger_command（如 `/review`）
- [ ] 选中技能后再次按 Enter 时消息正常发送（不拦截）
- [ ] 消息发送时 API 调用携带正确的 skillId
- [ ] 用户可在技能命令后输入补充文字（如 `/review 检查这个文件`）

### 消息渲染

- [ ] 携带 skillId 的用户消息以标记样式显示（Sparkles 图标 + 技能名 + 描述）
- [ ] 标记消息中仍显示用户输入的补充文字
- [ ] 不携带 skillId 的普通用户消息保持原有渲染方式不变
- [ ] 历史消息中技能标记样式正确回显（从 DB 加载后 metadata 保留）

### 后端技能注入

- [ ] 发送携带 skillId 的消息时，后端正确注入技能的 system_prompt 到 SDK 配置
- [ ] 技能的 system_prompt 作为本轮对话的额外系统提示词生效
- [ ] 不携带 skillId 的普通消息不注入额外系统提示词

### 兼容性

- [ ] 现有 `/skill` 命令及其子命令功能不受影响
- [ ] 现有 `@mention` 系统不受影响
- [ ] 输入历史翻阅功能不受影响
- [ ] 远程 Web 模式下技能菜单正常（通过 HTTP API 获取技能列表）
- [ ] 所有用户可见文本使用 `t()` 国际化

### 代码质量

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `npm run i18n` 无新增未翻译 key

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-14 | 初始 PRD | @misakamikoto |
