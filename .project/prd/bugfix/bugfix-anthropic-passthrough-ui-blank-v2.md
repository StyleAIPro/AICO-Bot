---
created: 2026-06-02
status: done
type: bugfix
commander: misakamikoto
---

# Bugfix: Anthropic passthrough 流式文本恢复 — pre-stream 文本污染 lastTextContent 导致 resultThoughtContent fallback 失效 (v2 回归)

> 版本：bugfix-anthropic-passthrough-ui-blank-v2
> 日期：2026-06-02
> 指令人：misakamikoto
> 归属模块：modules/agent (process-stream)
> 严重程度：High（非标准 Anthropic 兼容 API 再次完全无法使用）
> 影响范围：后端流处理
> 前置修复：`.project/prd/bugfix/bugfix-anthropic-passthrough-ui-blank-v1.md`
> 状态：draft

## 问题描述

这是 **v1 修复的回归问题**。v1 修复在 `finalContent` 计算中增加了 `resultThoughtContent` 作为最终 fallback（第 1372-1374 行），但该 fallback 在新场景下被提前的 pre-stream 文本阻断，永远不会被执行。

### 期望行为

当使用非标准 Anthropic 兼容 API（如 `http://IP:PORT/v1/messages`，实际模型为 GLM-5.1）时，即使上游 SSE 流缺少 `content_block_delta` / `text_delta` 事件，UI 也应显示正确的模型输出（通过 `resultThoughtContent` fallback）。

### 实际行为

UI 显示 **"Set model to GLM-5.1"** —— 这是 SDK 内部 `setModel()` 流程产生的 pre-stream 文本，不是模型的实际回复。正确的回复（如 "你好！我是 AICO-Bot..."）存在于 result thought 中，但因 `lastTextContent` 被 pre-stream 文本污染而无法被 fallback 机制使用。

### 复现步骤

1. 配置 AI source URL 为非标准 Anthropic 兼容端点（如 `http://IP:PORT/v1/messages`），provider 设为 `anthropic`
2. 创建/打开一个工作空间，发送一条消息
3. 观察日志：`agent:thought` 中 `type: 'result'` 包含正确的模型输出
4. 观察对话框：显示 "Set model to GLM-5.1" 而非实际模型回复

### 影响范围

- **非标准 Anthropic 兼容 API**（SSE 缺少 `text_delta` 事件）：必现
- **标准 Anthropic API**：不受影响（SDK 不在流中发出 setModel 文本作为 assistant message，`lastTextContent` 不会被污染）
- **OpenAI 兼容模型**：不受影响（走不同路由路径）

## 根因分析

### 数据流时序

```
1. SDK 初始化 → setModel("GLM-5.1") → 发出 assistant message: { type: 'text', content: 'Set model to GLM-5.1' }
   ↓
2. parseSDKMessage() 将其解析为 text thought → 累积到 lastTextContent（此时 hasStreamEvent=false，走非流式路径）
   ↓ lastTextContent = "Set model to GLM-5.1"（被污染！）
3. 上游 SSE 到达 → content_block_start (text) → isStreamingTextBlock=true, currentStreamingText=''
   ↓
4. 无 text_delta 事件（上游格式问题） → currentStreamingText 保持 ''
   ↓
5. content_block_stop → lastTextContent = "Set model to GLM-5.1" + '\n\n' + '' = "Set model to GLM-5.1"
   ↓ lastTextContent 仍为 truthy
6. result thought 到达 → content: "你好！我是 AICO-Bot..."（正确内容）
   ↓
7. finalContent 计算（第 1374 行）：
   lastTextContent("Set model to GLM-5.1") || currentStreamingText('') || resultThoughtContent("你好！...") || ''
   = "Set model to GLM-5.1"  ← WRONG！
```

### 根因：lastTextContent 在流式阶段开始前被 pre-stream 文本污染

在 `process-stream.ts` 中，`lastTextContent` 从所有 SDK 消息（包括流式和非流式）中累积文本。

**污染路径**（第 1048-1050 行，非流式 fallback 路径）：

```typescript
// 当 hasStreamEvent=false 时，text thought 的内容被累积到 lastTextContent
lastTextContent = lastTextContent
  ? lastTextContent + '\n\n' + thought.content
  : thought.content;
```

SDK 在流式响应到达之前，通过 `setModel()` 流程发出了一条 assistant message，内容为 "Set model to GLM-5.1"。由于此时 `hasStreamEvent` 仍为 `false`，这段文本被累积到 `lastTextContent`。

**Fallback 失效**：v1 修复在第 1374 行添加了 `resultThoughtContent` fallback：

```typescript
const finalContent = lastTextContent || currentStreamingText || resultThoughtContent || '';
```

但 `lastTextContent` 已经是 "Set model to GLM-5.1"（truthy），`||` 短路求值导致 `resultThoughtContent` 永远不会被执行。

### 与 thinking block reset 的类比

第 494-496 行已有对 thinking block 的类似处理：

```typescript
// Reset accumulated text — only text AFTER the last thinking block
// should become the final message content
lastTextContent = '';
```

这确保 thinking block 之后的新文本才是最终回复内容。但对于 text block，缺少类似的 reset 机制来清除 pre-stream 文本。

### 日志证据

```
[10:30:30.109] Sending message to V2 session...
[10:30:30.114] agent:thought: { type: 'text', content: 'Set model to GLM-5.1' }      ← pre-stream 文本
[10:30:30.146] agent:thought: { type: 'system', content: 'Connected | Model: GLM-5.1' }
[10:30:38.320] agent:thought: { type: 'text', content: '', isStreaming: true }         ← 流式 text block（空）
[10:30:38.328] StreamingBubble: New text block detected: version 0 → 1
  ... 无 text_delta 事件 ...
[10:31:52.777] agent:thought: { type: 'result', content: '你好！我是 AICO-Bot...' }   ← 正确回复
[MODEL OUTPUT] Response: "Set model to GLM-5.1" (20 chars, truncated)                 ← 错误的 finalContent
```

## 技术方案

### 修复点：`process-stream.ts` — 在首个流式 text block 开始时 reset lastTextContent

**文件**：`src/main/services/agent/process-stream.ts`

#### 变更 1：添加 `hadFirstStreamTextBlock` 标志（约第 314 行，与其他流式状态变量一起）

```typescript
// 在现有流式状态变量之后添加
let hadFirstStreamTextBlock = false;
```

#### 变更 2：在 `content_block_start` (text) 处理器中添加首个 text block reset（约第 437-439 行）

```typescript
// 修改前
if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
  isStreamingTextBlock = true;
  currentStreamingText = event.content_block.text || '';
  // ...

// 修改后
if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
  isStreamingTextBlock = true;
  currentStreamingText = event.content_block.text || '';

  // Reset pre-stream text on first streaming text block.
  // Before stream events arrive, SDK may emit assistant messages from internal flows
  // (e.g., "Set model to X" from setModel) that get accumulated into lastTextContent
  // via the non-streaming fallback path (hasStreamEvent=false).
  // This pre-stream text is NOT the model's response — discard it.
  // Only reset on the first text block; subsequent blocks accumulate normally.
  if (!hadFirstStreamTextBlock) {
    lastTextContent = '';
    hadFirstStreamTextBlock = true;
  }

  // ... 其余 handler 逻辑不变
```

### 修复后的数据流

```
1. Pre-stream text "Set model to GLM-5.1" → lastTextContent = "Set model to GLM-5.1"（被污染）
2. content_block_start (text) → lastTextContent = ''（reset!），hadFirstStreamTextBlock = true
3. 无 text_delta 事件 → currentStreamingText = ''
4. content_block_stop → lastTextContent = ''（空，因为 currentStreamingText 为空）
5. result thought → content: "你好！我是 AICO-Bot..."
6. finalContent = '' || '' || "你好！..." = "你好！..."  ← 正确！
```

### 为什么只在首个 text block reset

`content_block_stop` 中的累积逻辑（第 776-781 行）：

```typescript
lastTextContent = lastTextContent
  ? lastTextContent + '\n\n' + currentStreamingText
  : currentStreamingText;
```

如果每个 text block 开始都 reset `lastTextContent`，多 text block 场景下会丢失前面 block 的内容。因此只在首个 block reset（清除 pre-stream 垃圾），后续 block 正常累积。

### 不需要修改的部分

- **`finalContent` 计算（第 1374 行）**：v1 的 `resultThoughtContent` fallback 逻辑正确，不需要修改。问题是 fallback 被污染的 `lastTextContent` 阻断。
- **`parseSDKMessage()` / `message-utils.ts`**：消息解析逻辑正确，setModel 文本被解析为 text thought 是正常行为。
- **`sdk-config.ts`**：`setModel()` 调用时机不在本修复范围内。
- **前端**：问题完全在后端 `finalContent` 计算。

## 风险评估

### 风险 1：标准 Anthropic API 流程（无风险）

标准 Anthropic API 流程中，SDK 不在流中发出 setModel 文本作为 assistant message。`lastTextContent` 不会被 pre-stream 文本污染，reset 操作清除的是空字符串，无副作用。

### 风险 2：多 text block 响应（低风险）

使用 `hadFirstStreamTextBlock` 标志确保只在首个 text block reset。后续 text block 通过 `content_block_stop` 中的累积逻辑正常追加，不受影响。

### 风险 3：与 thinking block reset 的交互（无风险）

thinking block reset（第 496 行）和本修复的 text block reset 在不同条件下触发：
- thinking block reset：每个 thinking block 开始时触发（允许多轮 thinking-text 交替）
- 本修复：仅首个流式 text block 触发一次

两者不冲突。thinking block reset 在 thinking `content_block_start` 时触发，本修复在 text `content_block_start` 时触发，时序上互不干扰。

## 开发前必读

| 文档 | 路径 | 阅读目的 |
|------|------|----------|
| v1 PRD | `.project/prd/bugfix/bugfix-anthropic-passthrough-ui-blank-v1.md` | 理解 v1 修复的 fallback 逻辑和为什么不够 |
| 流处理核心 | `src/main/services/agent/process-stream.ts` | 理解 lastTextContent 累积逻辑和修复位置 |
| 消息解析 | `src/main/services/agent/message-utils.ts` | 理解 parseSDKMessage 如何生成 text thought |
| SDK 配置 | `src/main/services/agent/sdk-config.ts` | 理解 setModel 调用时机 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/process-stream.ts` | 修改 | 添加 `hadFirstStreamTextBlock` 标志；`content_block_start` (text) 处理器中添加首个 text block reset 逻辑 |

## 验收标准

- [ ] 非标准 Anthropic 兼容 API（SSE 缺少 text_delta）→ UI 显示正确的模型回复（通过 resultThoughtContent fallback）
- [ ] 标准 Anthropic API → 行为不变
- [ ] OpenAI 兼容 API → 行为不变
- [ ] 同一响应中包含多个 text block → 所有 block 内容正确累积
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
