# PRD [Bug 修复级] — 全面禁止普通对话创建子 Agent

> 版本：bugfix-excessive-subagents-v4
> 日期：2026-04-27
> 状态：done
> 指令人：@misakamikoto
> 归属模块：modules/agent
> 严重程度：Critical
> 前序 PRD：
> - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v1.md`（已 done — Leader 禁用 Agent/Task 工具）
> - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v2.md`（in-progress — Worker 内部子 Agent 不创建多余 Tab）
> - `.project/prd/bugfix/agent/bugfix-excessive-subagents-v3.md`（in-progress — build/test/lint 提示词禁令）
> - `.project/prd/bugfix/agent/bugfix-subagent-disallowlist-gaps-v1.md`（in-progress — disallowlist 遗漏修复）

## 问题描述

### 期望行为

无论本地/远程模式，无论是否启用子 Agent 开关，Bot 在普通对话中**不应对任何任务创建子 Agent**。所有任务（搜索、检查、分析、探索、验证、编译、测试、lint 等）均应直接使用现有工具（Read、Write、Edit、Grep、Glob、Bash、Skill）执行。子 Agent 功能仅应在 Hyper Space Worker 内部有条件使用。

### 实际行为

Bot 在普通对话中频繁为搜索、检查、测试、分析等简单任务创建无用子 Agent，导致：
- 对话响应变慢（子 Agent 启动开销）
- 前端显示多余 Tab（用户困惑）
- Token 消耗增加（子 Agent 上下文独立）
- 本地模式和远程模式均出现此问题

### 复现步骤

1. 打开任意工作空间（本地或远程）
2. 发送包含搜索、检查、分析等指令的消息，例如：
   - "搜索项目中所有使用 useState 的文件"
   - "检查一下这段代码有没有问题"
   - "分析一下这个模块的架构"
3. 观察到 Bot 创建子 Agent 来执行这些简单任务
4. 前端出现多余的子 Agent Tab

### 影响范围

- **本地模式**：受影响
- **远程模式**：受影响
- **Hyper Space 模式**：Leader 已被 v1 禁用，Worker 可能仍受提示词影响
- **普通对话模式**：受影响（主要影响场景，占 99% 的对话）
- **App Runtime**：受影响（SUB_AGENT_INSTRUCTIONS 仍然鼓励子 Agent 使用）

## 根因分析

经过全面代码审查，发现以下 **6 个遗漏点**，构成"软禁令 + 硬禁止不完整"的系统性问题：

### Gap 1：系统提示词仍然鼓励 Task/Agent 使用

**文件**: `src/main/services/agent/system-prompt.ts`

| 行号 | 问题 |
|------|------|
| 174 | `"When doing file search, consider using the Task tool for codebase exploration."` — 主动鼓励使用 Task 工具 |
| 175 | `"You may use the Task tool when appropriate. Use it sparingly"` — 允许使用并仅"建议"少用 |
| 180-188 | 提供了使用 `Task` 工具 + `subagent_type=Explore` 的示例，进一步引导模型创建子 Agent |

**结论**: 提示词中存在与 v3 禁令相矛盾的内容，模型会被这些鼓励性语句引导创建子 Agent。

### Gap 2：系统提示词禁令仅覆盖 build/test/lint

**文件**: `src/main/services/agent/system-prompt.ts`

| 行号 | 问题 |
|------|------|
| 179 | `"NEVER spawn a sub-agent (Task tool) for compilation, testing, linting, or type-checking tasks"` — 禁令范围过窄 |

**结论**: 禁令未覆盖搜索（search）、检查（check）、分析（analyze）、探索（explore）、验证（verify）、调查（investigate）、审查（review）等任务类型。模型可自由为这些"简单"任务创建子 Agent。

### Gap 3：普通对话（非 Hyper Space）无硬性阻断

**文件**: `src/main/services/agent/sdk-config.ts`、`src/main/services/agent/send-message.ts`

| 文件 | 行号 | 问题 |
|------|------|------|
| `sdk-config.ts` | 590 | `disallowedTools: ['WebFetch', 'WebSearch']` — 默认仅禁用网络工具 |
| `send-message.ts` | 366-380 | `buildBaseSdkOptions` 调用未传递 `additionalDisallowedTools` |

**结论**: 99% 的用户对话走 `send-message.ts` 的普通流程，该流程未向 `disallowedTools` 添加 `['Agent', 'Task']`。仅 Hyper Space Leader 通过 `orchestrator.ts` 获取了此禁令（v1 修复）。系统提示词禁令是"软"的，模型可以忽略；`disallowedTools` 是"硬"的，SDK 层面强制执行。

### Gap 4：远程 App Runtime `streamChatForApp` 缺少 disallowedTools

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`

| 行号 | 问题 |
|------|------|
| 925 | `disallowedTools: ['WebFetch', 'WebSearch']` — 缺少 `Agent` 和 `Task` |
| 2936 | 同上，`streamChatForApp` 中同样缺少 |

**结论**: 远程代理中 App Runtime 的两个入口点均未禁用 Agent/Task 工具，远程 App 可自由创建子 Agent。

### Gap 5：App Runtime `prompt.ts` 的 SUB_AGENT_INSTRUCTIONS 仍然活跃

**文件**: `src/main/apps/runtime/prompt.ts`

| 行号 | 问题 |
|------|------|
| 87-102 | `SUB_AGENT_INSTRUCTIONS` 常量 — 指示 Agent 使用 Task 工具委托浏览器任务 |
| 165-168 | `buildAppSystemPrompt` 中在 `usesAIBrowser` 为 true 时仍然追加此指令 |

**结论**: 即使 Agent/Task 工具被禁用，系统提示词仍告诉模型应该使用 Task 工具，造成行为不一致。更重要的是，如果未来 Agent/Task 工具未被禁用（如某些 Worker 场景），模型会被引导创建不必要的浏览器子 Agent。

### Gap 6：远程代理 fallback 提示词禁令范围过窄

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`

| 行号 | 问题 |
|------|------|
| 448 | `"NEVER spawn a sub-agent for build, test, lint, or type-check commands"` — 与主系统提示词同样的窄范围问题 |

**结论**: 远程代理的 fallback 提示词仅禁令 build/test/lint，未覆盖 search/check/analyze 等任务。

## 修复方案

### 策略：硬阻断 + 全面提示词禁令

**原则**: 在 AICO-Bot 中，子 Agent 不应在普通对话流程中被创建。Task/Agent 工具应通过 `disallowedTools` 对所有非 Worker 场景完全禁用。

理由：
- 硬阻断（`disallowedTools`）由 SDK 强制执行，模型**无法绕过**
- 系统提示词规则是"软"的，模型经常忽略
- 用户期望直接高效的执行，而非委托开销

### Change 1：普通对话添加 additionalDisallowedTools（核心修复）

**文件**: `src/main/services/agent/send-message.ts`
**位置**: 约 366-380 行 `buildBaseSdkOptions` 调用处
**变更**: 在 `buildBaseSdkOptions` 参数中添加 `additionalDisallowedTools: ['Agent', 'Task']`

```typescript
const sdkOptions = buildBaseSdkOptions({
  credentials: resolvedCredentials,
  workDir,
  electronPath,
  spaceId,
  conversationId,
  abortController,
  stderrHandler: (data: string) => {
    console.error(`[Agent][${conversationId}] CLI stderr:`, data);
    stderrBuffer += data;
  },
  mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
  maxTurns: config.agent?.maxTurns,
  contextWindow: resolvedCredentials.contextWindow,
  additionalDisallowedTools: ['Agent', 'Task'], // <-- 新增
});
```

**效果**: SDK 将 `disallowedTools` 从 `['WebFetch', 'WebSearch']` 扩展为 `['WebFetch', 'WebSearch', 'Agent', 'Task']`，模型在普通对话中完全无法调用 Task/Agent 工具。

### Change 2：Leader 的 additionalDisallowedTools 无需变更

**文件**: `src/main/services/agent/orchestrator.ts`
**位置**: 约 467 行
**变更**: 无需修改

**说明**: `orchestrator.ts` 已在 Leader 角色时传递 `additionalDisallowedTools: ['Agent', 'Task']`（v1 修复），与新方案一致。由于 `sdk-config.ts` 的 `buildBaseSdkOptions` 会将 `additionalDisallowedTools` 合并到 `disallowedTools` 中，Leader 不会重复添加。

### Change 3：Worker 保持不变

**文件**: `src/main/services/agent/orchestrator.ts`
**位置**: 约 454-468 行
**变更**: 无需修改

**说明**: Worker 角色不传递 `additionalDisallowedTools`，因此 Agent/Task 工具保持可用。这是设计意图——Worker 内部可能需要使用子 Agent 进行任务分解。

### Change 4：全面重写系统提示词中的 Task/Agent 规则

**文件**: `src/main/services/agent/system-prompt.ts`
**位置**: 约 173-188 行
**变更**:
1. **删除**第 174 行（鼓励使用 Task 进行代码搜索）
2. **删除**第 175 行（鼓励适当使用 Task）
3. **替换**第 179 行（窄范围禁令）为全面禁令
4. **删除**第 180-188 行（Task + Explore 示例）

替换后的内容：

```typescript
## File and Code Operations
- /<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the Skill tool to execute them. IMPORTANT: Only Skill for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.
- You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially instead. Never use placeholders or guess missing parameters in tool calls.
- Use specialized tools instead of bash commands when possible, as this provides a better user experience. For file operations, use dedicated tools: Read for reading files instead of cat/head/tail, Edit for editing instead of sed/awk, and Write for creating files instead of cat with heredoc or echo redirection. Reserve bash tools exclusively for actual system commands and terminal operations that require shell execution. NEVER use bash echo or other command-line tools to communicate thoughts, explanations, or instructions to the user. Output all communication directly in your response text instead.
- NEVER spawn a sub-agent (Task/Agent tool). Always perform all tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill). No task is too complex for direct execution — including search, codebase exploration, analysis, verification, review, compilation, testing, linting, and any other operations.
```

**效果**:
- 移除所有鼓励使用 Task/Agent 工具的语句
- 将禁令范围从 build/test/lint 扩展到所有任务类型
- 移除 Explore 子 Agent 示例（避免引导模型使用）

### Change 5：远程 App Runtime 添加 disallowedTools

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`
**位置**: 第 925 行和第 2936 行
**变更**: 在两处 `disallowedTools` 数组中添加 `'Agent'` 和 `'Task'`

```typescript
// 第 925 行 (streamChat)
disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],

// 第 2936 行 (streamChatForApp)
disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],
```

### Change 6：移除 App Runtime 的 SUB_AGENT_INSTRUCTIONS

**文件**: `src/main/apps/runtime/prompt.ts`
**位置**: 第 87-102 行和第 165-168 行
**变更**:
1. **删除**第 87-102 行：`SUB_AGENT_INSTRUCTIONS` 常量定义
2. **删除**第 165-168 行：`buildAppSystemPrompt` 中追加 SUB_AGENT_INSTRUCTIONS 的逻辑

删除的代码（第 165-168 行）：
```typescript
// 6. Sub-agent instructions (only if App uses AI Browser)
if (options.usesAIBrowser) {
  sections.push(SUB_AGENT_INSTRUCTIONS);
}
```

**效果**: App Runtime 不再在系统提示词中引导 Agent 使用 Task 工具。

### Change 7：扩展远程代理 fallback 提示词禁令范围

**文件**: `packages/remote-agent-proxy/src/claude-manager.ts`
**位置**: 第 448 行
**变更**: 将窄范围禁令替换为全面禁令，与主系统提示词保持一致

```typescript
// 替换前：
- NEVER spawn a sub-agent for build, test, lint, or type-check commands. Always run these directly via Bash (e.g., npm run build, npm test, cargo build).

// 替换后：
- NEVER spawn a sub-agent (Task/Agent tool). Always perform all tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill). No task is too complex for direct execution.
```

## 影响范围评估

| 场景 | 修复前 | 修复后 | 影响 |
|------|--------|--------|------|
| 普通对话（本地） | 可创建子 Agent | 禁用 Agent/Task | 正面 — 消除多余子 Agent |
| 普通对话（远程） | 可创建子 Agent | 禁用 Agent/Task | 正面 — 消除多余子 Agent |
| Hyper Space Leader | 已禁用（v1） | 已禁用（不变） | 无变化 |
| Hyper Space Worker | 可创建子 Agent | 可创建子 Agent（不变） | 无变化 |
| App Runtime | 可创建子 Agent | 禁用 Agent/Task | 正面 — App 直接执行 |
| 远程 fallback | 仅禁 build/test/lint | 全面禁用 | 正面 — 与主系统一致 |

**风险评估**:
- **风险极低**: 普通对话中几乎不存在"必须"使用子 Agent 的场景。Read、Grep、Glob、Bash 等工具足以覆盖所有操作。
- **Worker 不受影响**: Hyper Space Worker 的子 Agent 能力保持不变，复杂任务分解仍然可用。
- **向后兼容**: 此为限制性变更（减少功能），不引入新行为，不会破坏现有工作流。

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|----------|----------|
| 模块设计 | `.project/modules/agent/agent-core-v1.md` | 理解 Agent 模块整体架构 |
| 功能设计 | `.project/modules/agent/features/message-send/design.md` | 理解消息发送流程和 SDK 选项构建 |
| 功能设计 | `.project/modules/agent/features/tool-orchestration/design.md` | 理解工具编排机制和 disallowedTools 传递链路 |
| 功能设计 | `.project/modules/agent/features/worker-management/design.md` | 理解 Worker 管理和 Leader/Worker 角色区分 |
| 功能变更日志 | `.project/modules/agent/features/message-send/changelog.md` | 了解消息发送最近变更 |
| 功能变更日志 | `.project/modules/agent/features/tool-orchestration/changelog.md` | 了解工具编排最近变更 |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-excessive-subagents-v1.md` | 理解 v1 的 Leader 禁用方案 |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-excessive-subagents-v3.md` | 理解 v3 的提示词禁令方案 |
| 前序 PRD | `.project/prd/bugfix/agent/bugfix-subagent-disallowlist-gaps-v1.md` | 理解 disallowlist 遗漏分析 |
| 源码文件 | `src/main/services/agent/system-prompt.ts` | 修改系统提示词，移除鼓励语句，扩展禁令 |
| 源码文件 | `src/main/services/agent/send-message.ts` | 添加 additionalDisallowedTools |
| 源码文件 | `src/main/services/agent/sdk-config.ts` | 理解 buildBaseSdkOptions 的 additionalDisallowedTools 合并逻辑 |
| 源码文件 | `src/main/services/agent/orchestrator.ts` | 确认 Leader/Worker 的 disallowedTools 传递（无需修改，但需验证） |
| 源码文件 | `src/main/apps/runtime/prompt.ts` | 删除 SUB_AGENT_INSTRUCTIONS |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 添加 disallowedTools + 扩展提示词禁令 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 TypeScript strict、命名规范等 |

## 涉及文件

| 文件 | 变更类型 | 变更描述 |
|------|----------|----------|
| `src/main/services/agent/send-message-local.ts` | 修改 | 两处 `buildBaseSdkOptions` 调用添加 `additionalDisallowedTools: ['Agent', 'Task']` |
| `src/main/services/agent/session-lifecycle.ts` | 修改 | `buildBaseSdkOptions` 调用添加 `additionalDisallowedTools: ['Agent', 'Task']` |
| `src/main/services/agent/system-prompt.ts` | 修改 | 移除 Task/Agent 鼓励语句（174-175、180-188 行），扩展禁令范围（179 行） |
| `src/main/apps/runtime/prompt.ts` | 修改 | 删除 `SUB_AGENT_INSTRUCTIONS` 常量（87-102 行）及其使用（165-168 行） |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | 移除 `userRequestedSubAgent` regex 自动放行，提示词禁令扩展为全面禁止，`canUseTool` 仅保留 skill 级放行 |

## 验收标准

- [ ] **普通对话（本地）不创建子 Agent**：发送搜索、检查、分析、测试等任务指令，确认模型直接使用 Read/Grep/Glob/Bash 等工具执行，不调用 Task/Agent
- [ ] **普通对话（远程）不创建子 Agent**：在远程工作空间重复上述测试
- [ ] **Hyper Space Leader 不创建子 Agent**：确认 v1 修复仍然有效
- [ ] **Hyper Space Worker 可正常创建子 Agent**：确认 Worker 的子 Agent 能力未被破坏
- [ ] **App Runtime 不创建子 Agent**：使用 AI Browser 的 App 不应尝试使用 Task 工具
- [ ] **远程 fallback 提示词禁令生效**：远程代理 fallback 场景不创建子 Agent
- [ ] **系统提示词无 Task/Agent 鼓励语句**：检查生成的系统提示词，确认不包含 "consider using the Task tool"、"subagent_type=Explore" 等引导性内容
- [ ] **类型检查通过**：`npm run typecheck`
- [ ] **Lint 通过**：`npm run lint`
- [ ] **构建通过**：`npm run build`

## 变更

| 日期 | 变更内容 |
|------|----------|
| 2026-04-27 | 初稿创建 |
