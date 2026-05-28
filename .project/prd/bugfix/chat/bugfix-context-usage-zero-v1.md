# Bugfix: 模型思考过程中上下文用量永远为 0

## 元信息

| 字段 | 值 |
|------|-----|
| 时间 | 2026-05-14 |
| 状态 | done |
| 级别 | bugfix |
| 指令人 | @misakamikoto |
| 模块 | agent (流式处理)、chat (前端显示) |

## 需求分析

AICO-Bot 聊天界面 InputToolbar 中的 `ContextUsageDisplay` 组件存在两个问题：

1. **模型思考过程中，已使用上下文大小永远显示为 0** -- 用户发消息后，在整个 Agent 响应过程中（思考、工具调用、文本生成），上下文用量一直显示 0，直到对话结束才可能更新。
2. **对话结束后，最大上下文长度有时会回退到 200K** -- 用户配置了非 200K 的 contextWindow，但对话结束后显示回退到了 200K。

## 问题根因

### 问题 1：已使用上下文永远为 0

**根本原因**：当前 token 使用量数据仅从 `assistant` 类型 SDK 消息中提取。

**数据提取路径分析**（`process-stream.ts` line 792-804）：

```
SDK 消息流:
  stream_event (message_start)     → 包含 BetaMessage.usage (input_tokens) → ❌ 未提取
  stream_event (content_block_*)   → 内容块事件 → ✅ 正确处理
  stream_event (message_delta)     → 包含 BetaMessageDeltaUsage (完整 token 数据) → ❌ 未提取
  stream_event (message_stop)      → 结束事件 → ✅ 忽略
  assistant 消息                   → extractSingleUsage(msg.message.usage) → ⚠️ 仅此处提取
  result 消息                      → extractResultUsage() → ⚠️ 仅此处提取
```

**关键发现**：SDK 的 `stream_event` 消息中存在两个可靠的数据来源：

1. **`message_start` 事件**：`event.message.usage`（类型 `BetaUsage`），包含 `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`。这是 Anthropic API 标准流式响应中**第一个**携带 usage 信息的事件。

2. **`message_delta` 事件**：`event.usage`（类型 `BetaMessageDeltaUsage`），包含完整的 `input_tokens`、`output_tokens` 等。这是 API 响应**结束时**携带的最终 token 计数。

当前代码**完全忽略了**这两个来源，仅依赖 `assistant` 类型消息中的 `msg.message.usage`（`extractSingleUsage`，line 792-804）。

**为何 `assistant` 消息的 usage 为空**：
- Anthropic 原生 API：`assistant` 消息的 `message.usage` 通常有值
- OpenAI 兼容 API 转发（许多第三方提供商使用）：`assistant` 消息**不包含 usage 字段**，因为 OpenAI 协议将 usage 放在最终 chunk 中，而非中间消息中
- 因此当使用非 Anthropic 原生 API 时，`extractSingleUsage()` 始终返回 null

**影响链路**：
```
extractSingleUsage() → null
→ lastSingleUsage 不更新（保持 null）
→ agent:context-usage 事件不触发
→ 前端 chat.store.ts handleAgentContextUsage 不被调用
→ currentContextUsage 保持 null 或初始值
→ ContextUsageDisplay 显示 0
```

### 问题 2：最大上下文回退到 200K

**根本原因**：当 `extractResultUsage()` 返回的 `tokenUsage` 中 `contextWindow` 为 200K（因为 `configuredContextWindow` 和 `sdkContextWindow` 都未设置），前端 `handleAgentComplete`（chat.store.ts line 1957-1963）的逻辑会错误地用 200K 覆盖已有值。

**具体场景**：
1. 第一轮对话：`extractResultUsage` 返回 `contextWindow: 200000`（无用户配置 + SDK 未返回）
2. `handleAgentComplete` 中条件 `tokenUsage.contextWindow !== 200000 || !session.currentContextUsage`
3. `session.currentContextUsage` 在第一轮可能为 null → 条件为 true → 设置 `contextWindow: 200000`
4. 第二轮对话：如果 SDK 返回了正确的 `modelUsage.contextWindow`（例如 1M），可以覆盖
5. 但如果 SDK 仍返回空，则 `contextWindow` 保持 200K，即使用户实际配置了其他值

**另一个场景**（边缘情况）：
- `extractResultUsage` 返回 null（`lastSingleUsage` 为 null 且 `resultMsg.usage` 不存在）
- `handleAgentComplete` 跳过 context usage 更新
- `currentContextUsage` 保持之前的状态（包括 contextWindow）
- 这个场景下 contextWindow 不会回退，但如果之前的 `agent:context-usage` 也未触发（问题 1），则 `currentContextUsage` 从未被设置

## 技术方案

### 方案 1：从 `stream_event` 的 `message_delta` 提取 token usage（主要修复）

在 `process-stream.ts` 的 `stream_event` 处理分支中，增加对 `message_delta` 事件的 usage 提取：

```typescript
// 在 stream_event 处理块中（line 394 continue 之前）
if (event.type === 'message_delta' && event.usage) {
  const usage = event.usage;
  const singleUsage = {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
  };

  // 仅在有有效 input_tokens 时更新（避免 0 覆盖有效数据）
  if (singleUsage.inputTokens > 0) {
    lastSingleUsage = singleUsage;
    emit('agent:context-usage', {
      type: 'context-usage',
      inputTokens: singleUsage.inputTokens,
      outputTokens: singleUsage.outputTokens,
      cacheReadTokens: singleUsage.cacheReadTokens,
      cacheCreationTokens: singleUsage.cacheCreationTokens,
      contextWindow: params.contextWindow,
    });
  }
}
```

**优势**：
- `message_delta` 是 API 响应结束时的事件，此时所有 token 计数已确定
- `BetaMessageDeltaUsage` 包含完整的 token 数据（input/output/cache）
- 即使 OpenAI 兼容 API 转发也会在流结束时包含 usage chunk

### 方案 2（补充）：从 `message_start` 提取初始 usage（优化）

```typescript
if (event.type === 'message_start' && event.message?.usage) {
  const usage = event.message.usage;
  // message_start 只包含 input tokens，output 还未生成
  // 但可以用来提供早期的上下文大小指示
  if (usage.input_tokens > 0) {
    emit('agent:context-usage', {
      type: 'context-usage',
      inputTokens: usage.input_tokens || 0,
      outputTokens: 0, // 尚未生成
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      contextWindow: params.contextWindow,
    });
  }
}
```

**注意**：`message_start` 的 usage 中 `input_tokens` 是已确认的，但 `output_tokens` 还为 0。此步骤为可选优化。

### 方案 3：前端 `handleAgentComplete` contextWindow 保护逻辑修复

在 `chat.store.ts` 的 `handleAgentComplete`（line 1957-1963）中，增加对 `params.contextWindow`（从 `agent:context-usage` 事件传递）的保护：

当前逻辑：
```typescript
const newContextWindow =
  tokenUsage.contextWindow !== 200000 || !session.currentContextUsage
    ? tokenUsage.contextWindow
    : existingContextWindow;
```

问题：当 `tokenUsage.contextWindow === 200000` 且 `session.currentContextUsage` 不存在时，会用 200K 覆盖。

修改为：
```typescript
const newContextWindow =
  // 如果 SDK 返回了非默认值（说明是真实模型数据），使用它
  tokenUsage.contextWindow !== 200000
    ? tokenUsage.contextWindow
    // 否则保留已有的 contextWindow（来自 agent:context-usage 事件）
    : (session.currentContextUsage?.contextWindow ?? tokenUsage.contextWindow);
```

**关键差异**：当 `tokenUsage.contextWindow === 200000` 时，优先保留 `session.currentContextUsage?.contextWindow`（可能来自用户配置），而不是无条件使用 200K。

### 数据提取优先级（修复后）

```
stream_event message_start  → event.message.usage → 提取 input_tokens（早期指示）
                              ↓
stream_event message_delta  → event.usage → 提取完整 token 数据（最终值）
                              ↓ (如果 message_delta 也没有数据)
assistant 消息              → extractSingleUsage → 保留作为 fallback
                              ↓
result 消息                 → extractResultUsage → 最终汇总
```

### `lastSingleUsage` 更新策略

- **`message_delta` 的 usage 优先级最高**：这是 API 调用结束时的完整 token 计数
- 仅在 `inputTokens > 0` 时更新 `lastSingleUsage`，避免 0 覆盖有效数据
- 保留 `assistant` 消息的 `extractSingleUsage` 作为 fallback

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/process-stream.ts` | 修改 | 在 stream_event 处理中增加 `message_delta`/`message_start` 的 usage 提取 |
| `src/renderer/stores/chat.store.ts` | 修改 | `handleAgentComplete` 中 contextWindow 保护逻辑修正 |

## 开发前必读

| 文件 | 阅读目的 |
|------|---------|
| `src/main/services/agent/process-stream.ts` | 理解 stream_event 处理分支、token 提取位置、emit 逻辑 |
| `src/main/services/agent/message-utils.ts` | 理解 `extractSingleUsage` 和 `extractResultUsage` 的实现 |
| `src/main/services/agent/types.ts` | 理解 `SingleCallUsage`、`TokenUsage` 类型定义 |
| `src/renderer/stores/chat.store.ts` | 理解 `handleAgentContextUsage` 和 `handleAgentComplete` 中 contextWindow 的处理逻辑 |
| `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` | 理解 `BetaRawMessageDeltaEvent`、`BetaMessageDeltaUsage`、`BetaRawMessageStartEvent` 的类型定义 |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | 理解 `SDKPartialAssistantMessage`（stream_event）的类型定义 |

## 验收标准

- [ ] 使用 Anthropic 原生 API 时，模型思考过程中上下文用量能实时更新（非 0）
- [ ] 使用 OpenAI 兼容 API 时，模型思考过程中上下文用量能实时更新（非 0）
- [ ] 多轮对话中，`message_delta` 事件的 usage 数据正确更新 `lastSingleUsage`
- [ ] `message_start` 事件的 input_tokens 能提供早期上下文大小指示（可选优化）
- [ ] 对话结束后，contextWindow 不会错误回退到 200K（当用户配置了非 200K 值时）
- [ ] `lastSingleUsage` 不会被 0 值覆盖有效数据（guard: `inputTokens > 0`）
- [ ] `npm run typecheck && npm run build` 通过
