# PRD: 本地上下文估算与实时显示 v2

| 字段 | 值 |
|------|------|
| 级别 | feature |
| 状态 | done |
| 创建时间 | 2026-06-01 |
| 指令人 | mi-saka |
| 前置 PRD | `feature-local-context-estimation-v1.md`（基础双轨机制，已实现） |
| 归属模块 | agent + renderer/chat |

## 需求分析

### 背景

v1 已实现了基础的双轨 token 用量系统：本地估算 + API 精确数据覆盖，核心流程可用。但在实际使用中发现以下不足：

1. **本地估算精度不够**：`estimateContextTokens()` 仅估算对话历史字符数 + 固定 3000 token 的 SYSTEM_PROMPT_OVERHEAD，未考虑系统提示实际长度、工具定义字符数、MCP 工具定义、项目配置（CLAUDE.md 等）的实际大小。当系统提示很长（如启用了 AI Browser、GitHub Search）时，估算值可能低估 2000-5000 token。
2. **流式估算基准不包含发送前累积值**：当前 `estimatedStreamingTokens` 从 0 开始累加，但流式阶段应基于发送前估算值（`estimateContextTokens` 返回值）继续累加，否则用户看到的值会从一个小数跳到正确的 API 值。
4. **工具调用结果未纳入估算**：流式过程中，工具执行完成后工具结果（tool_result）的字符数未累加到本地估算，导致多轮工具调用后估算值持续偏低。

### 预期效果（v2 增量）

- 本地估算精度提升至与实际 token 数偏差 10% 以内（v1 目标 15%）
- 上下文窗口优先级明确：用户配置 > API 获取 > 默认 200K
- 流式过程中估算值平滑递增，不会出现大幅跳变
- 工具调用结果计入本地估算，多轮工具调用场景估算更准确
- 每次模型输出完成后，累计值自动更新

## v1 已实现内容（不复述）

以下功能已在 v1 中完成，本 PRD 不再涉及：

- `src/shared/utils/token-estimator.ts` - 纯字符估算器（英文/代码 4字符=1token，CJK 1字符=2token）
- `src/main/services/agent/token-estimator.ts` - `estimateContextTokens()` + `buildEstimatedContextUsage()`
- `src/main/services/agent/send-message-local.ts` 516-522 行 - 发送前估算
- `src/main/services/agent/process-stream.ts` 553-570 行 - 流式估算（500ms 节流）
- `src/renderer/stores/chat.store.ts` - `handleAgentContextUsage()` 双轨合并，`contextUsageSource` 区分 `api` | `estimate`
- `src/renderer/components/chat/TokenUsageIndicator.tsx` - `isEstimate` 属性 + `~` 前缀
- `src/renderer/components/chat/InputArea.tsx` 698 行 - `ContextUsageDisplay` + `isEstimate` 前缀 + 阈值颜色

## 技术方案（v2 增量）

### 1. 增强本地估算器 — 完整上下文估算

**文件**：`src/main/services/agent/token-estimator.ts`

**问题**：当前 `estimateContextTokens()` 仅使用固定 `SYSTEM_PROMPT_OVERHEAD = 3000`，不考虑系统提示实际长度。

**改动**：

1. 新增函数 `estimateSystemPromptTokens()`，动态计算系统提示的 token 数：

```typescript
/**
 * 估算当前系统提示的实际 token 数
 *
 * 包含：
 * 1. buildSystemPrompt() 生成的完整系统提示文本
 * 2. AI Browser 提示（如启用）
 * 3. SDK 内置的 claude_code 预设提示（约 1000-2000 token）
 * 4. 工具定义（allowedTools + disallowedTools + MCP 工具的 JSON schema）
 *
 * @param context - SystemPromptContext（workDir、modelInfo 等）
 * @param mcpToolCount - MCP 工具数量（每个工具约 200-500 token）
 * @param hasAIBrowser - 是否启用了 AI Browser
 * @returns 估算的系统提示 token 数
 */
export function estimateSystemPromptTokens(
  context: SystemPromptContext,
  mcpToolCount: number,
  hasAIBrowser: boolean,
): number {
  // 1. 基础系统提示：直接计算 buildSystemPrompt() 输出的字符数
  const systemPrompt = buildSystemPrompt(context);
  let tokens = estimateTokenCount(systemPrompt);

  // 2. SDK 内置 claude_code 预设（skills、tool schemas 等）
  tokens += 2000;

  // 3. AI Browser 提示（额外 1000-2000 token）
  if (hasAIBrowser) {
    tokens += 1500;
  }

  // 4. 工具定义：PRE_APPROVED_TOOLS（约 200 token/个）+ MCP 工具（约 350 token/个）
  const builtinToolCount = PRE_APPROVED_TOOLS.length;
  tokens += builtinToolCount * 200;
  tokens += mcpToolCount * 350;

  // 5. 项目配置（CLAUDE.md 等通过 SDK 的 additionalDirectories 自动加载，约 500-3000 token）
  tokens += 1000;

  return tokens;
}
```

2. 修改 `estimateContextTokens()` 接受可选的 `systemPromptTokens` 参数：

```typescript
export function estimateContextTokens(
  spaceId: string,
  conversationId: string,
  systemPromptTokens?: number,
): number {
  const conversation = getConversation(spaceId, conversationId);
  if (!conversation) return systemPromptTokens ?? SYSTEM_PROMPT_OVERHEAD;

  const messages = conversation.messages || [];
  // 使用动态计算的系统提示 token 数，回退到固定值
  let totalTokens = systemPromptTokens ?? SYSTEM_PROMPT_OVERHEAD;

  for (const msg of messages) {
    totalTokens += 4;
    totalTokens += estimateTokenCount(msg.content || '');

    if (msg.thoughts && Array.isArray(msg.thoughts)) {
      for (const thought of msg.thoughts) {
        if (thought.content) {
          totalTokens += estimateTokenCount(thought.content);
        }
        if (thought.toolOutput) {
          totalTokens += estimateTokenCount(thought.toolOutput);
        }
      }
    }
  }

  return totalTokens;
}
```

**调用方变更**（`send-message-local.ts`）：在发送前估算时，先调用 `estimateSystemPromptTokens()` 获取动态值，再传入 `estimateContextTokens()`：

```typescript
// Pre-send estimation with dynamic system prompt tokens
const systemPromptTokens = estimateSystemPromptTokens(
  { workDir, modelInfo: displayModel, ghSearchStatus },
  mcpToolCount,
  aiBrowserEnabled,
);
const estimatedTokens = estimateContextTokens(spaceId, conversationId, systemPromptTokens);
```

### 2. 上下文窗口优先级：用户配置 > API 获取 > 默认 200K

无需新增文件。上下文窗口优先级已在现有代码中部分实现（`message-utils.ts` 的 `extractResultUsage()`），v2 仅确保各处 fallback 链一致：

**优先级链**：
1. **用户配置**：`AISource.contextWindow`（用户在 AI Source 设置中手动配置的值）
2. **API 获取**：SDK `result.modelUsage.contextWindow`（API 返回的模型上下文窗口）
3. **默认值**：`200000`（200K）

**涉及位置**：

- `sdk-config.ts` 中 `resolveCredentialsForSdk()` 返回的 `contextWindow`：优先使用 `credentials.contextWindow`（用户配置），否则为 `undefined`（由下游使用 API 值或默认值）
- `process-stream.ts` 中 `params.contextWindow`：传入用户配置值或 API 返回值
- `message-utils.ts` 中 `extractResultUsage()`：已实现 `configuredContextWindow > sdkContextWindow > 200000` 优先级链
- `InputArea.tsx` 中 `ContextUsageDisplay` 的 fallback：保持 `200000`

### 3. 流式估算基准修正 — 基于发送前估算值累加

**文件**：`src/main/services/agent/process-stream.ts`

**问题**：当前 `estimatedStreamingTokens` 从 0 开始累加流式文本，导致流式阶段显示的值远小于实际值。应从发送前估算的基准值开始累加。

**改动**：

在 `ProcessStreamParams` 中新增字段：

```typescript
export interface ProcessStreamParams {
  // ... 现有字段 ...

  /** 发送前估算的上下文 token 基准值（用于流式累加起点） */
  estimatedContextBaseline?: number;
}
```

在 `processStream()` 函数中，初始化流式估算时使用基准值：

```typescript
// 修改前（约第 329 行）：
let estimatedStreamingTokens = 0;

// 修改后：
let estimatedStreamingTokens = params.estimatedContextBaseline || 0;
```

**调用方变更**（`send-message-local.ts`）：将发送前估算值传入 `processStream`：

```typescript
const streamResult = await processStream({
  // ... 现有参数 ...
  contextWindow: contextWindowForEstimate,
  estimatedContextBaseline: estimatedTokens,  // 新增：基于发送前估算值累加
});
```

### 4. 工具调用结果纳入流式估算

**文件**：`src/main/services/agent/process-stream.ts`

**问题**：当前流式估算仅累加 `text_delta` 文本，工具调用完成后的 `tool_result` 未计入。多轮工具调用场景下估算值持续偏低。

**改动**：

在处理 `tool_result` 类型 thought 的分支中（约第 885 行附近），追加工具结果的 token 估算：

```typescript
// 在 tool_result thought 处理中（现有代码约第 885-1012 行之间）
// 在 sessionState.thoughts.push(thought) 或 toolResult 合并后添加：

// 将工具结果字符数累加到本地估算
if (!receivedApiUsage && thought.toolOutput) {
  estimatedStreamingTokens += estimateTokenCount(thought.toolOutput);
  // 立即发送估算更新（不用等 500ms 节流，因为工具结果是离散事件）
  emit('agent:context-usage', {
    type: 'context-usage',
    isEstimate: true,
    estimatedTokens: estimatedStreamingTokens,
    inputTokens: estimatedStreamingTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow: params.contextWindow || 200000,
  });
}
```

### 5. 模型输出完成后累计值持久显示

**问题**：当前模型输出结束后，如果 API 不返回 token usage，前端 `currentContextUsage` 保留的是流式阶段的 `estimatedStreamingTokens`（仅包含流式文本，从 0 开始累加），导致显示值远低于实际。下一轮开始时 `currentContextUsage` 被重置为 `null`，显示 `--/200K`。

**改动涉及 3 处**：

#### 5a. 流结束后发送完整的本地估算（`process-stream.ts`）

在 `agent:complete` 事件发送前，如果没有收到 API usage，重新估算完整上下文并发送：

```typescript
// 在 emit('agent:complete', ...) 之前：
if (!receivedApiUsage) {
  // 发送最终的完整本地估算（而非仅流式文本累加值）
  emit('agent:context-usage', {
    type: 'context-usage',
    isEstimate: true,
    estimatedTokens: estimatedStreamingTokens,  // 基于基准值的完整累加
    inputTokens: estimatedStreamingTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow: params.contextWindow || 200000,
  });
}
```

#### 5b. `handleAgentComplete` 保留本地估算值（`chat.store.ts`）

当 `tokenUsage` 为 null 时，不清空 `currentContextUsage`，而是保留最后的本地估算：

```typescript
// handleAgentComplete 中，在 if (tokenUsage) 块之后添加 else：
if (tokenUsage) {
  // ... 现有逻辑（API 数据覆盖） ...
} else {
  // 无 API 数据：保留最后的本地估算值（来自 agent:context-usage 的 isEstimate 事件）
  // currentContextUsage 已经通过 handleAgentContextUsage 更新，无需额外操作
  // 但确保 contextUsageSource 保持 'estimate'
  set((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(conversationId);
    if (!session || session.contextUsageSource === 'api') return state;
    // 保持现有估算值，仅标记 contextUsageSource
    newSessions.set(conversationId, {
      ...session,
      contextUsageSource: 'estimate',
    });
    return { sessions: newSessions };
  });
}
```

#### 5c. 新一轮开始时不立即清空估算值（`chat.store.ts`）

当前在 `handleAgentStart`（约 1458 行）将 `currentContextUsage` 重置为 `null`，导致新一轮发送前短暂显示 `--/200K`。改为保留上一轮的值直到新的估算值到来：

```typescript
// 修改前：
currentContextUsage: null,
contextUsageSource: null,

// 修改后：保留上一轮的估算值，直到新的 agent:context-usage 事件覆盖
// 不再重置为 null，让上一轮的值持续显示到新估算到达
```

### 6. 前端显示优化（保持现有位置）

现有 `ContextUsageDisplay` 和 `TokenUsageIndicator` 已支持 `isEstimate` 属性和 `~` 前缀。无需大改，主要改动在 store 层面的数据持久化逻辑（见第 5 节）。

## 涉及文件（v2 增量）

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/main/services/agent/token-estimator.ts` | 修改 | 新增 `estimateSystemPromptTokens()` 动态系统提示估算；`estimateContextTokens()` 接受可选 `systemPromptTokens` 参数 |
| 2 | `src/main/services/agent/process-stream.ts` | 修改 | `ProcessStreamParams` 新增 `estimatedContextBaseline` 字段；流式估算从基准值开始累加；`tool_result` 纳入估算；流结束前发送最终估算 |
| 3 | `src/main/services/agent/send-message-local.ts` | 修改 | 发送前调用 `estimateSystemPromptTokens()` 获取动态值；传入 `estimatedContextBaseline` 到 `processStream` |
| 4 | `src/renderer/stores/chat.store.ts` | 修改 | `handleAgentComplete` 无 API 数据时保留本地估算值；`handleAgentStart`/连续生成/错误恢复时均不清空 `currentContextUsage` |

## 开发前必读

### v1 源码（已实现，必须先理解）

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `src/shared/utils/token-estimator.ts` | 理解现有字符估算器实现（`estimateTokenCount`、`estimateMessagesTokens`），v2 不修改此文件 |
| 2 | `src/main/services/agent/token-estimator.ts` | 理解现有 `estimateContextTokens()` 和 `buildEstimatedContextUsage()`，v2 在此基础上增强 |
| 3 | `src/main/services/agent/process-stream.ts` 553-570 行 | 理解现有流式估算逻辑（500ms 节流），v2 修改基准值和工具结果纳入 |
| 4 | `src/main/services/agent/send-message-local.ts` 516-522 行 | 理解现有发送前估算调用点，v2 增加动态系统提示估算 |
| 5 | `src/renderer/stores/chat.store.ts` 2613 行 | 理解现有 `handleAgentContextUsage()` 双轨合并逻辑，v2 不修改 |
| 6 | `src/renderer/components/chat/InputArea.tsx` 698 行 | 理解现有 `ContextUsageDisplay` 实现，v2 仅小改 fallback 值 |
| 7 | `src/renderer/components/chat/TokenUsageIndicator.tsx` | 理解现有 `isEstimate` 属性处理，v2 不修改 |

### v2 新增依赖的源码

| # | 文件 | 阅读目的 |
|---|------|---------|
| 8 | `src/main/services/agent/system-prompt.ts` | 理解 `buildSystemPrompt()` 和 `SYSTEM_PROMPT_TEMPLATE` 的结构，用于动态系统提示估算 |
| 9 | `src/main/services/agent/sdk-config.ts` | 理解 `resolveCredentialsForSdk()` 中 `contextWindow` 的处理方式，确认用户配置优先级 |
| 10 | `src/shared/types/ai-sources.ts` | 理解 `AISource` 类型中 `contextWindow` 字段的定义 |
| 11 | `src/main/services/agent/message-utils.ts` | 理解 `extractSingleUsage` 和 `extractResultUsage` 的实现，确认 API usage 提取逻辑和 contextWindow 优先级链 |

### 设计文档

| # | 文档 | 阅读目的 |
|---|------|---------|
| 12 | `.project/modules/agent/features/stream-processing/design.md` | 流式处理架构，确认估算插入点不影响现有流程 |
| 13 | `.project/prd/feature/feature-local-context-estimation-v1.md` | 理解 v1 PRD 中的设计和验收标准 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 14 | `CLAUDE.md` | 项目铁律：`src/shared/` 禁止导入 Node/Electron、TypeScript strict |

## 验收标准

### 功能验收

- [ ] 即使 API 不返回 usage 数据，UI 仍能实时显示上下文用量（估算值带 `~` 前缀）— 继承自 v1
- [ ] 发送消息前自动估算当前上下文用量并更新 UI — 继承自 v1
- [ ] 流式响应过程中，上下文用量从发送前估算值开始平滑递增（不再从 0 开始）
- [ ] 工具调用完成后，工具结果字符数纳入本地估算，多轮工具调用估算更准确
- [ ] 模型输出结束后，如果无 API 数据，累计估算值持续显示（不会变为 `--/200K`）
- [ ] 新一轮对话开始时，上一轮的估算值保持显示，直到新估算值到达（无闪烁）
- [ ] API 返回精确值后，覆盖本地估算值（`~` 前缀消失）— 继承自 v1
- [ ] 上下文窗口优先级正确：用户配置 > API 获取 > 默认 200K
- [ ] 空会话首次发送前显示的估算值包含动态系统提示 token（而非固定 3000）

### 精度验收

- [ ] 本地估算与实际 token 数偏差在 10% 以内（v2 目标，v1 为 15%）
- [ ] 纯英文/代码文本估算偏差 < 10%
- [ ] 纯中文文本估算偏差 < 15%
- [ ] 混合中英文文本估算偏差 < 12%

### 兼容性验收

- [ ] 远程会话和 Hyper Space 场景不回归
- [ ] Anthropic Claude 模型 API 精确值正常覆盖估算值
- [ ] 非 Anthropic 模型（OpenAI 兼容路由）无 API usage 时，估算值全程显示
- [ ] 用户手动配置 `contextWindow` 时优先使用用户值，API 返回值次之，最后才用默认 200K

### 工程验收

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 所有新增函数有 JSDoc 注释

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-06-01 | v2 PRD：增强估算精度 + 流式基准修正 + 工具结果纳入 + 上下文窗口优先级（用户配置>API>200K） | 用户 |
| 2026-05-30 | v1 PRD：基础双轨机制（本地估算 + API 覆盖） | 用户 |
