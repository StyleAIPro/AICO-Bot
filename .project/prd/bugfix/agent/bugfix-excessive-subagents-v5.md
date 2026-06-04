# PRD [Bug 修复级] — 硬性阻断子 Agent 创建（v5：canUseTool 层拦截）

## 元信息
级别: bugfix
优先级: P0
归属模块: modules/agent (permission-handler + sdk-config + remote proxy)
timestamp: 2026-05-30
status: done
author: misakamikoto
前序 PRD: `.project/prd/bugfix/agent/bugfix-excessive-subagents-v4.md`

## Bug 描述

### 期望行为

无论本地/远程模式，普通对话和 Hyper Space Leader 均不应创建子 Agent。所有任务直接使用现有工具（Read、Write、Edit、Grep、Glob、Bash、Skill）执行。仅 Hyper Space Worker 在需要任务分解时允许使用 Agent 工具。

### 实际行为

v4 通过 `disallowedTools: ['Agent', 'Task']` 尝试硬阻断，但子 Agent 仍然被创建。

### 复现步骤

1. 打开任意工作空间（本地或远程）
2. 发送包含搜索、检查、分析等指令的消息
3. 观察到 Bot 仍然创建子 Agent

## 根因分析

### v4 方案失败原因：`disallowedTools` 对 Agent 工具无效

v4 在以下位置添加了 `additionalDisallowedTools: ['Agent', 'Task']`：
- `send-message-local.ts`（两处 `buildBaseSdkOptions` 调用）
- `session-lifecycle.ts`（一处调用）
- `orchestrator.ts`（Leader 角色条件传递）

这些调用最终通过 `sdk-config.ts` 的 `buildBaseSdkOptions` 合并为：
```typescript
disallowedTools: ['WebFetch', 'WebSearch', ...(params.additionalDisallowedTools ?? [])],
```

**然而，`disallowedTools` 对 `Agent` 工具不生效。** 原因如下：

1. **SDK 内部工具解析机制**：Claude Code SDK 的 `os()` 函数（工具解析器）对 `Agent` 工具有特殊处理。常规工具通过 allowlist/denylist 过滤，但 `Agent` 工具由 `agentDefinitions` 子系统管理，独立于常规工具列表。

2. **`disallowedTools` 仅影响权限上下文**：SDK 的 `disallowedTools` 选项只修改了工具的权限上下文（`canUseTool` 回调的默认判断），并未从实际的工具 schema 中移除 `Agent` 工具。模型仍然能看到 Agent 工具的定义并尝试调用。

3. **`canUseTool` 无兜底拦截**：AICO-Bot 的 `createCanUseTool()`（`permission-handler.ts`）中没有任何针对 Agent/Task 工具的检查逻辑。当模型调用 Agent 工具时，代码走到最后的 "All other tools: auto-allow" 分支直接放行。

### 对比：远程代理已有 canUseTool 拦截

远程代理的 `streamChat` 方法中，`canUseTool` 回调已有 Agent/Task 拦截逻辑（第 1847-1857 行）：
```typescript
if (toolName === 'Agent' || toolName === 'Task') {
  if (activeSkillAllowsSubAgents) {
    return { behavior: 'allow' as const, updatedInput: input };
  }
  return { behavior: 'deny' as const, message: 'Sub-agent creation is not allowed...' };
}
```

但本地模式的 `createCanUseTool` 缺少此拦截——这是 v4 遗漏的核心缺口。

### 同时：远程代理 `buildSdkOptions` 缺少 `disallowedTools`

远程代理的 `buildSdkOptions` 方法（第 980-995 行）有注释 `// Explicitly disable WebFetch, WebSearch, Agent and Task tools`，但实际代码中**没有设置 `disallowedTools` 属性**。`streamChatForApp` 方法同样缺少。虽然远程代理有 `canUseTool` 拦截，但：
- `canUseTool` 仅在 `onAskUserQuestion || onPermissionRequest` 存在时才创建
- 当两者都不存在时，`canUseTool` 为 `undefined`，Agent/Task 工具无任何拦截

## 技术方案

### 策略：canUseTool 层硬拦截 + disallowedTools 双保险

**核心修复**：在 `canUseTool` 回调中添加 Agent/Task 工具的显式拦截。这是唯一可靠的阻断点，因为 SDK 的 `disallowedTools` 对 Agent 工具无效。

**双保险**：同时在 `disallowedTools` 中保留 Agent/Task（虽然无效，但未来 SDK 版本可能修复此行为）。

### Change 1：本地 `createCanUseTool` 添加 Agent/Task 拦截

**文件**: `src/main/services/agent/permission-handler.ts`

在 `CanUseToolDeps` 接口中添加 `allowSubagents` 参数：
```typescript
interface CanUseToolDeps {
  sendToRenderer: SendToRendererFn;
  spaceId: string;
  conversationId: string;
  agentId?: string;
  agentName?: string;
  trustMode?: boolean;
  allowSubagents?: boolean;  // <-- 新增
}
```

在 `createCanUseTool` 返回的函数**最顶部**（Skill 检查之前），添加 Agent/Task 拦截：
```typescript
// Block Agent/Task tools to prevent unwanted subagent spawning
// unless explicitly allowed (Worker context)
if (!deps?.allowSubagents) {
  const BLOCKED_TOOLS = new Set(['Agent', 'Task']);
  if (BLOCKED_TOOLS.has(toolName)) {
    console.log(`[PermissionHandler] Blocked tool: ${toolName} (subagent creation disabled)`);
    return {
      behavior: 'deny' as const,
      message: '子 Agent 创建已禁用。请直接使用现有工具（Read, Write, Edit, Grep, Glob, Bash, Skill）完成任务。',
    };
  }
}
```

**注意**：此检查必须在 `!deps` 的 auto-allow 分支之前执行。当 `deps` 为 `undefined` 时，`deps?.allowSubagents` 为 `false`，仍然执行拦截。

需要重构 `!deps` 分支，将 Agent/Task 检查提前：
```typescript
export function createCanUseTool(deps?: CanUseToolDeps): CanUseToolFn {
  return async (toolName, input, options): Promise<PermissionResult> => {
    // Block Agent/Task tools (highest priority — applies even without deps)
    if (!deps?.allowSubagents && (toolName === 'Agent' || toolName === 'Task')) {
      console.log(`[PermissionHandler] Blocked tool: ${toolName} (subagent creation disabled)`);
      return {
        behavior: 'deny' as const,
        message: '子 Agent 创建已禁用。请直接使用现有工具（Read, Write, Edit, Grep, Glob, Bash, Skill）完成任务。',
      };
    }

    // Skill tool: block disabled skills
    if (toolName === 'Skill') { ... }

    // AskUserQuestion: send to UI
    if (toolName === 'AskUserQuestion') { ... }

    // No deps (e.g., MCP health check): auto-allow
    if (!deps) {
      return { behavior: 'allow' as const, updatedInput: input };
    }

    // ... rest of checks
  };
}
```

### Change 2：调用方传递 `allowSubagents` 参数

**文件**: `src/main/services/agent/sdk-config.ts`

在 `buildBaseSdkOptions` 的 `canUseTool` 创建中传递 `allowSubagents`：
```typescript
canUseTool: createCanUseTool({
  sendToRenderer,
  spaceId,
  conversationId,
  agentId,
  agentName,
  trustMode,
  allowSubagents: params.allowSubagents,  // <-- 新增
}),
```

在 `BaseSdkOptionsParams` 接口中添加：
```typescript
/** Whether to allow Agent/Task tool usage (only for Worker context) */
allowSubagents?: boolean;
```

**各调用方的 `allowSubagents` 值**：

| 调用方 | 文件 | `allowSubagents` |
|--------|------|------------------|
| 普通对话 #1 | `send-message-local.ts:336` | `false` |
| 普通对话 #2（凭证刷新） | `send-message-local.ts:739` | `false` |
| 会话恢复 | `session-lifecycle.ts:437` | `false` |
| Hyper Space Worker | `orchestrator.ts:458` | `true` |
| Hyper Space Leader | `orchestrator.ts:458` | `false`（已有 `additionalDisallowedTools`，但 canUseTool 也要拦） |

### Change 3：远程代理 `buildSdkOptions` 添加 `disallowedTools`

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`

在 `buildSdkOptions` 方法的 options 对象中添加：
```typescript
const options: any = {
  model: effectiveModel || 'claude-sonnet-4-6',
  cwd: effectiveWorkDir,
  systemPrompt: { ... },
  permissionMode: 'default',
  extraArgs: {},
  allowedTools: [...PRE_APPROVED_TOOLS],
  disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],  // <-- 添加（之前只有注释没有实际代码）
  includePartialMessages: true,
  maxTurns: 50,
}
```

### Change 4：远程代理 `streamChatForApp` 添加 `disallowedTools`

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`

在 `streamChatForApp` 的 `sdkOptions` 中添加：
```typescript
const sdkOptions: any = {
  model: this.model || 'claude-sonnet-4-6',
  cwd: workDir,
  systemPrompt: options.system || '',
  permissionMode: 'bypassPermissions',
  extraArgs: { 'dangerously-skip-permissions': null },
  allowedTools: [...PRE_APPROVED_TOOLS],
  disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],  // <-- 新增
  includePartialMessages: true,
  maxTurns: 10,
  ...
}
```

### Change 5：远程代理 `canUseTool` 确保 Agent/Task 无条件拦截

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`

当前远程代理的 `canUseTool` 中 Agent/Task 拦截已有，但它依赖于 `onAskUserQuestion || onPermissionRequest` 条件。当两者都不存在时，整个 `canUseTool` 回调为 `undefined`。

修改为：**始终创建 `canUseTool` 回调**（至少包含 Agent/Task 拦截逻辑）：
```typescript
const canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
  // Agent/Task: always deny (remote proxy never needs subagents)
  if (toolName === 'Agent' || toolName === 'Task') {
    log.info(SCOPE.CLAUDE_MGR, `${toolName} denied: sub-agents blocked in remote proxy`)
    return {
      behavior: 'deny' as const,
      message: 'Sub-agent creation is not allowed. Please complete the task directly using available tools (Read, Write, Edit, Grep, Glob, Bash, Skill).',
    }
  }

  // AskUserQuestion, Bash, Skill, etc. — only if callbacks provided
  if (onAskUserQuestion || onPermissionRequest) {
    // ... 现有逻辑
  }

  return { behavior: 'allow' as const, updatedInput: input }
}
```

## 涉及文件

| 文件 | 变更类型 | 变更描述 |
|------|----------|----------|
| `src/main/services/agent/permission-handler.ts` | 修改 | `CanUseToolDeps` 添加 `allowSubagents` 参数；`createCanUseTool` 顶部添加 Agent/Task 拦截 |
| `src/main/services/agent/sdk-config.ts` | 修改 | `BaseSdkOptionsParams` 添加 `allowSubagents`；`buildBaseSdkOptions` 传递给 `createCanUseTool` |
| `src/main/services/agent/send-message-local.ts` | 修改 | 两处 `buildBaseSdkOptions` 调用添加 `allowSubagents: false` |
| `src/main/services/agent/session-lifecycle.ts` | 修改 | 一处调用添加 `allowSubagents: false` |
| `src/main/services/agent/orchestrator.ts` | 修改 | Worker 调用添加 `allowSubagents: true`；Leader 调用添加 `allowSubagents: false` |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | `buildSdkOptions` 添加 `disallowedTools`；`streamChatForApp` 添加 `disallowedTools`；`streamChat` 的 `canUseTool` 改为始终创建 |
| `src/main/services/agent/system-prompt.ts` | 无修改 | v4 已有正确的全面禁令，无需变更 |

## 验收标准

- [ ] **本地普通对话不创建子 Agent**：发送搜索、检查、分析、测试等任务指令，确认模型直接使用 Read/Grep/Glob/Bash 等工具执行
- [ ] **远程普通对话不创建子 Agent**：在远程工作空间重复上述测试
- [ ] **Hyper Space Leader 不创建子 Agent**：确认 canUseTool 拦截生效
- [ ] **Hyper Space Worker 可正常创建子 Agent**：`allowSubagents: true` 时 Agent/Task 工具正常放行
- [ ] **远程 App Runtime 不创建子 Agent**：`streamChatForApp` 的 disallowedTools 生效
- [ ] **`[PermissionHandler] Blocked tool: Agent` 日志可见**：本地模式调用 Agent 工具时控制台输出拦截日志
- [ ] **类型检查通过**：`npm run typecheck`
- [ ] **构建通过**：`npm run build`

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|----------|----------|
| 模块设计 | `.project/modules/agent/agent-core-v1.md` | 理解 Agent 模块整体架构 |
| 功能设计 | `.project/modules/agent/features/message-send/design.md` | 理解消息发送流程和 SDK 选项构建 |
| 功能设计 | `.project/modules/agent/features/tool-orchestration/design.md` | 理解工具编排机制和权限检查链路 |
| 功能设计 | `.project/modules/agent/features/worker-management/design.md` | 理解 Worker 管理和 Leader/Worker 角色区分 |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-excessive-subagents-v4.md` | 理解 v4 的 disallowedTools 方案及失败原因 |
| 源码文件 | `src/main/services/agent/permission-handler.ts` | 核心修改点：添加 Agent/Task 拦截 |
| 源码文件 | `src/main/services/agent/sdk-config.ts` | 修改 buildBaseSdkOptions 传递 allowSubagents |
| 源码文件 | `src/main/services/agent/send-message-local.ts` | 两处调用添加 allowSubagents: false |
| 源码文件 | `src/main/services/agent/session-lifecycle.ts` | 一处调用添加 allowSubagents: false |
| 源码文件 | `src/main/services/agent/orchestrator.ts` | Worker/Leader 调用区分 allowSubagents |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 添加 disallowedTools + 确保 canUseTool 始终创建 |
| 源码文件 | `src/main/services/agent/system-prompt.ts` | v4 已修复，无需修改但需确认内容正确 |
