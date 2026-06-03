# PRD [功能级] -- 多 Skill 链式触发

> 版本：feature-multi-skill-chain-v1
> 日期：2026-05-28
> 指令人：@misakamikoto
> 归属模块：renderer/chat.store + main/agent/system-prompt + renderer/MessageItem
> 状态：draft
> 优先级：P2
> 影响范围：前端（chat store + MessageItem 组件）+ 后端（system prompt）

## 需求分析

### 背景

当前 AICO-Bot 只支持从用户输入中触发单个 skill。匹配逻辑在 `chat.store.ts` 的 `sendMessage()` 中（L1328-1344），对 `installedSkills` 做 `find()` 匹配第一个 `trigger_command` 前缀命中的 skill，生成单个 `skillMetadata` 附加到消息上。

LLM 天然支持同一 turn 中多次调用工具（包括 Skill 工具），但当前系统提示没有指导 LLM 进行多 skill 识别和串行调用。

### 问题

1. **显式多 skill 无法触发**：用户输入 `/doc-summary /code-review 分析这个文件`，前端只会匹配第一个 `/doc-summary`，第二个 skill 被忽略
2. **隐式多意图无法覆盖**：用户输入 `帮我分析代码质量并生成文档`，LLM 可能只调用一个 skill 或完全不用 skill
3. **前端没有链式反馈**：即使 LLM 多次调用 Skill 工具，用户看不到链式执行的进度

### 目标

1. 前端支持从用户输入中匹配多个 skill trigger，生成链式 metadata
2. 系统提示增强，指导 LLM 在适当时串行调用多个 Skill 工具
3. 消息气泡支持显示多个 skill badge

### 场景

| # | 场景 | 用户输入 | 预期行为 |
|---|------|---------|---------|
| 1 | 显式多 skill | `/doc-summary /code-review 分析这个文件` | 匹配两个 skill，生成链式 metadata，LLM 串行调用 |
| 2 | 隐式多 skill | `帮我分析代码质量并生成文档` | 前端无 trigger 匹配，LLM 根据系统提示自动识别并串行调用 |
| 3 | 混合模式 | `/code-review 帮我也生成文档` | 匹配 `/code-review`，LLM 根据上下文识别还需要 `doc-generator` |
| 4 | 单 skill（向后兼容） | `/commit` | 与现有行为完全一致 |

## 技术方案

### 核心思路

最小改动方案：LLM 已具备多次调用 Skill 工具的能力，改动集中在三处：

1. **chat.store.ts**：`sendMessage()` 中的 skill 匹配从 `find()` 改为 `filter()` 多匹配
2. **system-prompt.ts**：在 skill 指令段落增加多 skill 链式调用指导
3. **MessageItem.tsx**：消息气泡渲染支持多个 skill badge

不涉及新的 IPC 端点、不涉及新的 store、不涉及权限处理变更（`permission-handler.ts` 已对 Skill 工具逐次放行）。

### 1. chat.store.ts -- 多 skill 匹配

**文件**：`src/renderer/stores/chat.store.ts`（L1328-1344）

**当前代码**（单匹配）：
```typescript
const matchedSkill = installedSkills.find((s) => {
  if (!s.enabled || !s.spec.trigger_command) return false;
  const trigger = s.spec.trigger_command;
  if (!trimmedContent.startsWith(trigger)) return false;
  return trimmedContent.length === trigger.length || trimmedContent[trigger.length] === ' ';
});
const skillMetadata = matchedSkill
  ? {
      skillId: matchedSkill.appId,
      skillName: matchedSkill.spec.name,
      skillTrigger: matchedSkill.spec.trigger_command,
      skillDescription: matchedSkill.spec.description,
    }
  : undefined;
```

**改为**（多匹配）：
```typescript
// Match all skill triggers found in the message (supports chain like "/a /b args")
const matchedSkills = installedSkills.filter((s) => {
  if (!s.enabled || !s.spec.trigger_command) return false;
  const trigger = s.spec.trigger_command;
  // Must match at start of content or after a space following another trigger
  const index = trimmedContent.indexOf(trigger);
  if (index === -1) return false;
  if (index !== 0 && trimmedContent[index - 1] !== ' ') return false;
  // After trigger, must be end-of-string or followed by a space
  const afterTrigger = index + trigger.length;
  return (
    afterTrigger === trimmedContent.length || trimmedContent[afterTrigger] === ' '
  );
});

// Build chain metadata: single skill -> existing shape (backward compat),
// multiple skills -> new chain shape
const skillMetadata = matchedSkills.length === 1
  ? {
      skillId: matchedSkills[0].appId,
      skillName: matchedSkills[0].spec.name,
      skillTrigger: matchedSkills[0].spec.trigger_command,
      skillDescription: matchedSkills[0].spec.description,
    }
  : matchedSkills.length > 1
    ? {
        skillChain: matchedSkills.map((s) => ({
          skillId: s.appId,
          skillName: s.spec.name,
          skillTrigger: s.spec.trigger_command,
          skillDescription: s.spec.description,
        })),
      }
    : undefined;
```

**向后兼容性**：
- 单 skill 场景：metadata 形状不变（`{ skillId, skillName, skillTrigger, skillDescription }`）
- 多 skill 场景：新增 `skillChain` 数组字段
- 无 skill 场景：`undefined`，行为不变

### 2. Message 类型扩展

**文件**：`src/renderer/types/index.ts`（L414-449）

在 `Message['metadata']` 中新增 `skillChain` 字段：

```typescript
metadata?: {
    // ... existing fields ...
    /** Skill invocation marker (displayed as /skill-name tag in chat) */
    skillId?: string;
    skillName?: string;
    skillTrigger?: string;
    skillDescription?: string;
    /** Multi-skill chain: ordered list of skills to execute */
    skillChain?: Array<{
      skillId: string;
      skillName: string;
      skillTrigger: string;
      skillDescription: string;
    }>;
  };
```

### 3. MessageItem.tsx -- 多 badge 渲染

**文件**：`src/renderer/components/chat/MessageItem.tsx`（L387-404）

当前 skill badge 判断使用 `message.metadata?.skillId`，改为同时支持 `skillChain`：

```tsx
// 判断条件扩展
message.metadata?.skillId || message.metadata?.skillChain?.length ? (
  <div className="flex items-center gap-2 flex-wrap">
    {/* 渲染单个或多个 skill badge */}
    {(message.metadata.skillChain ?? [
      message.metadata.skillId
        ? {
            skillId: message.metadata.skillId,
            skillName: message.metadata.skillName!,
            skillTrigger: message.metadata.skillTrigger!,
            skillDescription: message.metadata.skillDescription!,
          }
        : null,
    ])
      .filter(Boolean)
      .map((skill, i) => (
        <Fragment key={skill.skillId}>
          {i > 0 && <span className="text-muted-foreground">→</span>}
          <div className="flex items-center gap-1">
            <Sparkles size={14} className="text-primary flex-shrink-0" />
            <span className="font-mono text-primary font-medium text-sm">
              {skill.skillTrigger || `/${skill.skillName}`}
            </span>
          </div>
        </Fragment>
      ))}
    {/* 提取剩余文本（去掉所有 trigger 后的内容） */}
    {(() => {
      const triggers = message.metadata.skillChain
        ? message.metadata.skillChain.map((s) => s.skillTrigger)
        : message.metadata.skillTrigger
          ? [message.metadata.skillTrigger]
          : [];
      let remaining = message.content;
      for (const trigger of triggers) {
        remaining = remaining.replace(trigger, '').trim();
      }
      return remaining ? <span className="whitespace-pre-wrap">{remaining}</span> : null;
    })()}
  </div>
)
```

### 4. system-prompt.ts -- 多 skill 链式调用指导

**文件**：`src/main/services/agent/system-prompt.ts`（L218 附近）

当前指令：
```
- /<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the Skill tool to execute them. IMPORTANT: Only Skill for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.
```

**改为**：
```
- /<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the Skill tool to execute them. IMPORTANT: Only Skill for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.
- **Multi-skill chaining**: When the user's message contains multiple /<skill-name> triggers (e.g., "/doc-summary /code-review analyze this file"), call the Skill tool for EACH skill sequentially in order. Complete the first skill's task, then call the next one. The user expects all skills to execute in sequence.
- **Implicit multi-skill**: When the user's request clearly spans multiple skill domains (e.g., "analyze code quality AND generate documentation"), consider calling multiple relevant Skills in sequence if appropriate skills are available. Do not force-fit a single skill if the request naturally decomposes into multiple skill calls.
```

### 5. 权限处理 -- 无需改动

`permission-handler.ts` 的 `createCanUseTool` 中，Skill 工具的检查是逐次调用的（L285-297），每次 `Skill` 工具调用独立检查 `disabledIds`，多次调用自然放行。无需任何改动。

## 数据流

### 显式多 skill 链

```
用户输入 "/doc-summary /code-review 分析这个文件"
    ↓
chat.store.ts sendMessage() — filter() 匹配到 [doc-summary, code-review]
    ↓
生成 skillMetadata = { skillChain: [{...}, {...}] }
    ↓
消息发送到主进程 agent session（content 不变，metadata 含 skillChain）
    ↓
LLM 看到用户消息 + 系统提示中的多 skill 指导
    ↓
LLM 第 1 次 Skill 调用：doc-summary
    ↓
LLM 处理 doc-summary 输出
    ↓
LLM 第 2 次 Skill 调用：code-review
    ↓
LLM 汇总两个 skill 结果，输出最终回复
```

### 单 skill（向后兼容）

```
用户输入 "/commit 修复登录bug"
    ↓
chat.store.ts — filter() 匹配到 [commit]（length === 1）
    ↓
走现有分支，metadata = { skillId, skillName, skillTrigger, skillDescription }
    ↓
MessageItem 渲染：skillId 存在 → 显示单个 badge（不变）
    ↓
LLM 调用 Skill 工具（不变）
```

## 开发前必读

### 源码文件

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `src/renderer/stores/chat.store.ts`（L1326-1470） | 理解 sendMessage 中 skill 匹配和 metadata 构建逻辑 |
| 2 | `src/main/services/agent/system-prompt.ts`（L96-280） | 理解系统提示模板结构，skill 指令段落位置 |
| 3 | `src/renderer/components/chat/MessageItem.tsx`（L385-420） | 理解消息气泡中 skill badge 渲染逻辑 |
| 4 | `src/renderer/types/index.ts`（L398-451） | 理解 Message 类型定义，metadata 字段结构 |
| 5 | `src/main/services/agent/permission-handler.ts`（L285-297） | 确认 Skill 工具权限检查为逐次独立 |
| 6 | `src/main/services/agent/sdk-config.ts`（L466-477） | 理解 disabled skills 提示构建（不影响本次改动） |
| 7 | `src/shared/skill/skill-types.ts` | 理解 SkillSpec、InstalledSkill 类型 |
| 8 | `src/renderer/hooks/slash-command/useSlashCommand.ts` | 理解斜杠命令菜单（本次不改动，但需确认不影响） |

## 涉及文件（预估）

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/renderer/stores/chat.store.ts` | 修改 | sendMessage 中 skill 匹配从 find 改为 filter，支持多 skill chain metadata |
| 2 | `src/main/services/agent/system-prompt.ts` | 修改 | skill 指令段落增加多 skill 链式调用指导（3 行追加） |
| 3 | `src/renderer/types/index.ts` | 修改 | Message.metadata 新增 skillChain 字段 |
| 4 | `src/renderer/components/chat/MessageItem.tsx` | 修改 | skill badge 渲染支持 skillChain 数组 + 链式箭头分隔 |

## 验收标准

- [ ] 显式双 skill：输入 `/skill-a /skill-b 参数`，消息气泡显示两个 badge（`/skill-a → /skill-b`），LLM 串行调用两个 Skill 工具
- [ ] 显式三+ skill：输入三个 `/skill` trigger，均被匹配并在 badge 中显示
- [ ] 隐式多 skill：输入不含 `/` 但明显多意图的内容，LLM 根据系统提示自动串行调用多个 Skill 工具
- [ ] 单 skill 向后兼容：输入 `/commit 修复bug`，行为与改动前完全一致（metadata 形状不变，badge 显示不变）
- [ ] 无 skill 向后兼容：普通消息（无 `/` 前缀），不匹配任何 skill，metadata 为 undefined
- [ ] 禁用 skill 跳过：已禁用的 skill 不出现在匹配结果中（现有 `s.enabled` 检查）
- [ ] 相同 trigger 不重复：输入中同一 trigger 出现多次只匹配一次
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 不做的事

- **不新增 IPC 端点**：多 skill 信息完全在 metadata 中传递，后端无需新通道
- **不修改 permission-handler**：已逐次独立放行
- **不修改 useSlashCommand**：斜杠菜单交互不变，多 trigger 检测在 sendMessage 中完成
- **不做前端进度条**：LLM 串行调用 Skill 工具时，流式响应中自然展示进度，无需额外 UI 组件
- **不做执行顺序配置**：显式 trigger 按出现顺序执行，隐式由 LLM 自行判断

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-28 | 初始 PRD | @misakamikoto |
