---
timestamp: 2026-05-13
status: in-progress
module: agent, remote-agent
type: bugfix
assignee: misakamikoto
priority: P1
---

# Bug 修复：远程 Agent 未经用户确认自动启动子 Agent

## 问题描述

远程服务器上的 Claude 模型在执行任务时，会未经用户确认自动启动大量子 agent（如 check、verify、analyze 等），所有远程会话都存在此问题。用户没有收到任何权限确认提示，子 agent 就自动启动了。此外，子 agent 的思考过程事件被完全隔离到 Worker Tab 中，主 Agent 的思考流中看不到子 agent 的任何活动。

### 影响范围

- **本地模式**：不受影响（本地已通过 `bugfix-excessive-subagents-v4` 禁用了 Agent/Task 工具）
- **远程模式**：受影响（所有远程会话）

### 复现步骤

1. 连接到远程服务器工作空间
2. 发送任意包含任务的消息（如"检查一下代码"、"搜索项目中所有使用 useState 的文件"）
3. 观察到 Claude 自动启动多个子 agent 执行这些简单任务
4. 用户全程未收到任何权限确认提示
5. 主 Agent 的思考过程中看不到子 agent 的活动，但 UI 上已出现 Worker Tab

## 根因分析

远程代理存在 **两个独立但叠加的根因**，共同导致子 agent 可以无需确认地自动启动：

### 根因 1：`Task` 工具在 `PRE_APPROVED_TOOLS` 中，SDK 直接放行

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 340-352 行

```typescript
const PRE_APPROVED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Create', 'MultiEdit',
  'NotebookEdit', 'TodoWrite', 'Skill',
  'Task',  // <-- 问题：Task 被列为预授权，SDK 不触发 canUseTool
]
```

`PRE_APPROVED_TOOLS` 传递给 SDK 的 `allowedTools`，SDK 将 `Task` 视为已获用户批准的工具，调用时**不触发** `canUseTool` 回调，直接放行。

### 根因 2：`canUseTool` 对非 Bash/AskUserQuestion 工具无条件放行

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 1888-1889 行

```typescript
// All other tools: auto-allow
return { behavior: 'allow' as const, updatedInput: input }
```

`Agent` 工具不在 `PRE_APPROVED_TOOLS` 中，会触发 `canUseTool`，但对非 Bash/AskUserQuestion 工具直接返回 `allow`。

### 根因 3：子 Agent 事件在主思考流中不可见

当前带 `agentId` 的 thought 事件被完全隔离到 Worker Session（`chat.store.ts:2097` 中 `if (agentId) return`），不写入主 session 的 `thoughts[]`，导致用户在主 Agent 的思考过程中看不到子 agent 的活动。前端已有 `SubagentThoughtGroup` 嵌套渲染能力，但主 session 中缺少带 `agentId` 的 thought 条目。

## 技术方案

### 设计原则

| 场景 | 行为 |
|------|------|
| 用户**明确要求**创建子 agent | 放行 |
| 执行的 **Skill 配置标记**了允许子 agent | 放行 |
| 其他所有情况 | **直接拒绝**（不弹确认） |

### Change 1：从 `PRE_APPROVED_TOOLS` 移除 `Task`

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts` 第 340-352 行

```typescript
// Before
const PRE_APPROVED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Create', 'MultiEdit',
  'NotebookEdit', 'TodoWrite', 'Skill', 'Task',
]

// After
const PRE_APPROVED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Create', 'MultiEdit',
  'NotebookEdit', 'TodoWrite', 'Skill',
]
```

### Change 2：`AppSpec` 添加 `allow_sub_agents` 字段

**文件**：`src/shared/apps/spec-types.ts`

```typescript
export interface AppSpec {
  // ... 现有字段 ...
  permissions?: string[];
  /** 该 Skill 是否允许创建子 Agent */
  allow_sub_agents?: boolean;
}
```

同步在 Zod schema（`src/main/apps/spec/schema.ts`）中添加验证。

### Change 3：`ChatOptions` 添加 Skill 权限传递

**文件**：`packages/remote-agent-proxy/src/types.ts`

```typescript
export interface ChatOptions {
  // ... 现有字段 ...
  /** 允许子 agent 的 Skill 名称集合 */
  allowSubAgentSkills?: string[];
}
```

**文件**：`src/main/services/agent/send-message-remote.ts`

在构造发送给远程代理的 `options` 时，从 `SkillManager` 收集所有 `allow_sub_agents: true` 的 Skill 名称，注入 `options.allowSubAgentSkills`。

### Change 4：`canUseTool` 中按规则拒绝/放行 `Agent`/`Task`

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`（`streamChat` 方法内）

在 `canUseTool` 回调创建前，基于 `messages` 提取用户意图，基于 `options.allowSubAgentSkills` 获取 Skill 权限：

```typescript
// 用户意图检测
const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')
const userRequestedSubAgent = lastUserMessage
  ? /子\s*agent|sub[\s-]?agent|子\s*代理|创建.*任务|spawn.*agent|create.*task|用.*agent|开.*子.*agent|parallel.*task/i.test(
      typeof lastUserMessage.content === 'string'
        ? lastUserMessage.content
        : Array.isArray(lastUserMessage.content)
          ? lastUserMessage.content.map(c => c.text || '').join('')
          : ''
    )
  : false

// Skill 权限集合
const subAgentAllowedSkills = new Set(options.allowSubAgentSkills || [])
```

在 `canUseTool` 中 "auto-allow" 分支前添加：

```typescript
// Agent/Task: 按规则控制子 agent 创建
if (toolName === 'Agent' || toolName === 'Task') {
  // 规则 1：用户明确要求 → 放行
  if (userRequestedSubAgent) {
    return { behavior: 'allow' as const, updatedInput: input }
  }
  // 规则 2：Skill 配置允许 → 放行
  if (activeSkillAllowsSubAgents) {
    return { behavior: 'allow' as const, updatedInput: input }
  }
  // 规则 3：其他情况 → 拒绝
  return {
    behavior: 'deny' as const,
    message: 'Sub-agent creation is not allowed unless explicitly requested by the user or the current skill requires it. Please complete the task directly using available tools.',
  }
}
```

**Skill 执行上下文检测**：由于 SDK 不传递 Skill 上下文到 `canUseTool`，需要在 `canUseTool` 的 `Skill` 分支中记录最近调用的 Skill 名称，供后续 `Agent`/`Task` 调用查询：

```typescript
// 在 canUseTool 中
if (toolName === 'Skill') {
  const cmd = String(input.command || input.name || input.skill || '')
  const skillName = cmd.replace(/^\/+/, '').trim()
  if (skillName && subAgentAllowedSkills.has(skillName)) {
    activeSkillAllowsSubAgents = true
  }
  // ... 现有逻辑 ...
}
```

### Change 5：子 Agent 思考事件双写主 Session

**文件**：`src/renderer/stores/chat.store.ts` — `handleAgentThought`（第 2084-2148 行）和 `handleAgentThoughtDelta`（第 2215-2259 行）

在 `if (agentId)` 分支中，写入 `workerSessions` 后**不 return**，继续追加到主 session 的 `thoughts[]`。已有的 `SubagentThoughtGroup` 会自动根据 `thought.agentId` 分组嵌套渲染。

### Change 6：`ToolPermissionCard` 支持 `Agent`/`Task` 工具展示（已不需要）

由于子 agent 默认直接拒绝（不弹确认），`ToolPermissionCard` 无需新增 `Agent`/`Task` 的展示。但 `NestedWorkerTimeline` 仍需要展示子 agent 的活动（依赖 Change 5 的双写数据）。

## 开发前必读

| 分类 | 文档 | 阅读目的 |
|------|------|---------|
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-excessive-subagents-v4.md` | 理解本地模式的子 agent 禁用方案 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 340-352 行 `PRE_APPROVED_TOOLS`；第 1757-1773 行 `streamChat` 签名；第 1828-1890 行 `canUseTool`） | 核心修改目标 |
| 源码文件 | `packages/remote-agent-proxy/src/types.ts` | `ChatOptions` 类型定义，添加 `allowSubAgentSkills` |
| 源码文件 | `src/shared/apps/spec-types.ts` | `AppSpec` 类型定义，添加 `allow_sub_agents` |
| 源码文件 | `src/main/apps/spec/schema.ts` | Zod schema，添加 `allow_sub_agents` 验证 |
| 源码文件 | `src/main/services/agent/send-message-remote.ts` | 构造 options 时注入 Skill 权限信息 |
| 源码文件 | `src/renderer/stores/chat.store.ts`（第 2084-2148 行 `handleAgentThought`；第 2215-2259 行 `handleAgentThoughtDelta`） | 子 agent thought 双写逻辑 |
| 源码文件 | `src/renderer/components/chat/ThoughtProcess.tsx`（`SubagentThoughtGroup`） | 已有的嵌套渲染组件 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 规范 |

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 340-352 行） | `PRE_APPROVED_TOOLS` 移除 `Task` |
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 1830 行前） | 用户意图检测 + Skill 权限集合 + Skill 上下文跟踪变量 |
| `packages/remote-agent-proxy/src/claude-manager.ts`（第 1903 行前） | `canUseTool` 增加 Skill 上下文记录 + Agent/Task 按规则拒绝/放行 |
| `packages/remote-agent-proxy/src/types.ts` | `ChatOptions` 添加 `allowSubAgentSkills` |
| `src/shared/apps/spec-types.ts` | `AppSpec` 添加 `allow_sub_agents` |
| `src/main/apps/spec/schema.ts` | Zod schema 添加 `allow_sub_agents` |
| `src/main/services/agent/send-message-remote.ts` | 从 `SkillManager` 收集权限信息注入 `options.allowSubAgentSkills` |
| `src/renderer/stores/chat.store.ts`（`handleAgentThought`） | 移除 `if (agentId) return`，实现双写主 session.thoughts |
| `src/renderer/stores/chat.store.ts`（`handleAgentThoughtDelta`） | 移除 `if (agentId) return`，实现双写主 session.thoughts |

## 验收标准

### 子 Agent 默认禁止

- [ ] 远程模式下，模型未经用户要求、非 Skill 需求时，**不创建子 Agent**，直接拒绝
- [ ] 拒绝后模型改用直接工具（Read/Write/Edit/Grep 等）完成任务
- [ ] 不弹出权限确认卡片

### 用户明确要求

- [ ] 用户消息包含子 agent 相关关键词时（如"用子agent"、"sub-agent"等），子 agent 正常启动

### Skill 允许子 Agent

- [ ] Skill 配置 `allow_sub_agents: true` 时，该 Skill 执行过程中允许创建子 agent
- [ ] Skill 未配置或 `allow_sub_agents: false` 时，不允许创建子 agent

### 子 Agent 思考过程可见性

- [ ] 主 Agent 思考过程中可以看到子 agent 的活动（thinking、tool_use 等）
- [ ] 子 agent 的 thought 自动嵌套渲染在对应的 Agent/Task tool_use 下方
- [ ] Worker Tab 仍然正常工作
- [ ] 持久化后刷新页面，历史数据中子 agent 思考仍正确显示

### 权限系统不受影响

- [ ] 远程 Agent 的破坏性 Bash 命令权限确认仍然正常
- [ ] 远程 Agent 的 AskUserQuestion 功能不受影响
- [ ] 远程 MCP 工具调用正常

### 构建验证

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
