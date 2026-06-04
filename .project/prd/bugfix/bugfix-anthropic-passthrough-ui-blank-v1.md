---
created: 2026-06-01
status: done
type: bugfix
commander: misakamikoto
---

# Bugfix: Anthropic 兼容内网模型输出不显示在对话框

> 版本：bugfix-anthropic-passthrough-ui-blank-v1
> 日期：2026-06-01
> 指令人：misakamikoto
> 归属模块：modules/agent (process-stream)
> 严重程度：High（Anthropic 兼容内网模型完全无法使用）
> 影响范围：后端 + 前端显示
> 状态：draft

## 问题描述

### 期望行为

当用户配置 AI source 为 Anthropic 兼容内网模型（URL 如 `http://123.4.5.6:7890/v1/messages`）时，模型输出应正确显示在对话框中。

### 实际行为

模型输出在日志中可见（`agent:thought` 事件含 `type: 'result'` 及完整内容），但对话框中不显示任何内容，呈现空白状态。

### 复现步骤

1. 打开设置，配置 AI source URL 为 `http://123.4.5.6:7890/v1/messages`，provider 设为 `anthropic`
2. 创建/打开一个工作空间，发送一条消息
3. 观察日志：`agent:thought` 事件中可看到 `type: 'result'` 及完整模型输出
4. 观察对话框：显示为空，无任何内容

### 影响范围

- **Anthropic 兼容内网模型**：必现
- **标准 Anthropic API**：不受影响（标准 API SSE 格式正确，`content_block_delta` 正常发出）
- **OpenAI 兼容模型**：不受影响（走不同路由路径）
- **影响功能**：所有通过 Anthropic passthrough 路径的 AI 模型推理

## 根因分析

### 数据流

```
用户配置 AI source URL (http://123.4.5.6:7890/v1/messages, provider: anthropic)
  → sdk-config.ts: detectNativeAnthropic() 检测到 URL 以 /v1/messages 结尾 → 返回 true
  → resolveAnthropicPassthrough() 路径
  → OpenAI Compat Router: handleAnthropicPassthrough() 透传到上游端点
  → SSE 流直接管道回 SDK
  → SDK 解析响应后发出消息给 process-stream.ts 处理
```

### 根因：finalContent 计算遗漏 result thought 内容

在 `process-stream.ts` 的流结束处理中（第 1371 行）：

```typescript
const finalContent = lastTextContent || currentStreamingText || '';
```

当上游 Anthropic 兼容端点的 SSE 格式与标准 Anthropic API 不完全一致时（可能缺少 `content_block_delta` 的 `text_delta` 类型事件），SDK 可能不发出 `stream_event` 类型的消息，或者只发出非 text 类型的 stream event。此时：

1. `lastTextContent` 为空（没有收到 text_delta 累积文本）
2. `currentStreamingText` 为空
3. **但 `parseSDKMessage()` 解析 result 消息时，result thought 的 `content` 字段包含完整的模型输出**
4. `StreamResult.finalContent` 为空字符串
5. 后端保存的最终消息为空
6. `handleAgentComplete` 重新加载后端数据后，前端展示空消息

### 次要问题

result thought 的 `content` 虽然包含完整模型输出，但在第 1371 行 `finalContent` 的计算中完全被忽略了。该行只看 `lastTextContent` 和 `currentStreamingText`，不考虑 result thought 的内容。

虽然第 1099-1101 行在处理 result thought 时已将 `thought.content` 赋值给 `lastTextContent`：

```typescript
if (!lastTextContent && thought.content) {
  lastTextContent = thought.content;
}
```

但这仅在 result thought 处理分支内执行。如果该分支在流事件循环中的执行顺序或条件导致 `lastTextContent` 未能被更新，或者后续逻辑覆盖了该值，`finalContent` 仍然为空。为提高鲁棒性，`finalContent` 的计算应显式包含 result thought 内容作为最终 fallback。

## 技术方案

### 修复点 1：`process-stream.ts` 第 1371 行 — finalContent 增加 result thought fallback

**文件**：`src/main/services/agent/process-stream.ts`

在流结束处理中，`finalContent` 的计算需要考虑 result thought 的内容作为最终 fallback：

```typescript
// 修改前（第 1371 行）
const finalContent = lastTextContent || currentStreamingText || '';

// 修改后
const resultThoughtContent = sessionState.thoughts.find((t: Thought) => t.type === 'result')?.content || '';
const finalContent = lastTextContent || currentStreamingText || resultThoughtContent || '';
```

这确保即使 `lastTextContent` 和 `currentStreamingText` 均为空，只要 result thought 中有内容，就会被用作最终输出。

### 修复点 2（确认无需修改）：`process-stream.ts` 第 1088-1101 行

result thought 处理逻辑已正确：

- 第 1090 行：`const finalContent = lastTextContent || thought.content;` — 发送给前端的消息使用累积文本或 result 内容
- 第 1099-1101 行：当 `lastTextContent` 为空且 `thought.content` 非空时，更新 `lastTextContent`

该分支逻辑正确，无需修改。修复点 1 作为额外保障，确保即使此分支未正确更新 `lastTextContent`，最终 fallback 仍然有效。

### 不需要修改的部分

- **`sdk-config.ts`**：`detectNativeAnthropic()` 和 `resolveAnthropicPassthrough()` 路由逻辑正确，无需修改
- **OpenAI Compat Router**：`handleAnthropicPassthrough()` 透传逻辑正确，SSE 流正常管道回 SDK
- **前端 `chat.store.ts`**：`handleAgentMessage` 和 `handleAgentComplete` 逻辑正确，问题在于后端传入的内容为空
- **`message-utils.ts`**：`parseSDKMessage()` 正确解析 result thought 的 content

## 风险评估

### 风险 1：result thought 内容优先级（低风险）

将 `resultThoughtContent` 作为最低优先级 fallback，不会影响正常流程。当 `lastTextContent` 或 `currentStreamingText` 非空时，`resultThoughtContent` 不会被使用。

**缓解**：fallback 顺序为 `lastTextContent > currentStreamingText > resultThoughtContent`，确保标准流程不受影响。

### 风险 2：result thought 可能包含非文本内容（低风险）

某些场景下 result thought 的 `content` 可能包含工具调用结果等非用户预期内容。

**缓解**：在 Anthropic passthrough 场景下，result thought 的 `content` 就是模型最终输出文本，无工具调用。且此修改仅在 `lastTextContent` 和 `currentStreamingText` 均为空时生效，说明没有收到任何 text block，此时使用 result thought 内容是正确的降级策略。

## 开发前必读

| 文档 | 路径 | 阅读目的 |
|------|------|----------|
| process-stream 流处理 | `src/main/services/agent/process-stream.ts` | 理解流事件处理和 finalContent 计算 |
| 消息解析工具 | `src/main/services/agent/message-utils.ts` | 理解 parseSDKMessage 逻辑 |
| SDK 配置 | `src/main/services/agent/sdk-config.ts` | 理解 detectNativeAnthropic 和 resolveAnthropicPassthrough |
| Anthropic 透传处理 | `src/main/openai-compat-router/server/request-handler.ts` | 理解 handleAnthropicPassthrough |
| Chat Store | `src/renderer/stores/chat.store.ts` | 理解 handleAgentMessage 和 handleAgentComplete |
| AI Source Manager | `src/main/services/ai-sources/manager.ts` | 理解 getBackendConfig URL 处理 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/process-stream.ts` | 修改 | 第 1371 行 `finalContent` 计算增加 result thought 内容作为 fallback |

## 验收标准

- [ ] 配置 Anthropic 兼容内网模型 URL 后，模型输出正确显示在对话框
- [ ] 标准 Anthropic API 不受影响
- [ ] OpenAI 兼容模型不受影响
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
