# PRD [功能级] -- 本地上下文 Token 估算（双轨机制）

> 版本：feature-local-context-estimation-v1
> 日期：2026-05-30
> 指令人：mi-saka
> 归属模块：agent + renderer/chat
> 状态：in-progress

## 需求分析

### 背景

AICO-Bot 当前通过 Claude SDK API 返回的 `usage` 字段获取 token 用量，经 `process-stream.ts` 中的 `extractSingleUsage` / `extractResultUsage` 解析后通过 `agent:context-usage` IPC 事件发送到渲染进程。`ContextUsageDisplay`（输入区域工具栏）和 `TokenUsageIndicator`（每条消息）依赖这些 API 精确值来展示上下文用量。

### 问题

1. **部分模型不返回 usage 数据**：非 Anthropic 模型（如 GLM、DeepSeek）、自定义 API 端点可能不返回 `input_tokens` / `output_tokens` 字段，导致 UI 无法显示任何上下文用量信息
2. **无法预判**：token 数据只能在 API 请求完成后获取，无法在发送消息前估算当前上下文大小，无法提前预警
3. **无法实时追踪**：流式响应过程中，只有 `message_start` 和 `message_delta` 事件携带 usage（且部分模型不提供），用户在长时间生成期间无法看到上下文增长

### 预期效果

- 即使 API 完全不返回 usage 数据，UI 仍能实时显示上下文用量（估算值带 `~` 前缀区分）
- 发送消息前自动估算当前上下文 token 数并更新 UI
- 流式响应过程中，每收到一个文本块就追加到本地累积文本并重新估算，上下文用量实时递增
- API 返回精确值后，用精确值覆盖估算值（记账和费用计算用精确值）
- 输入区域工具栏显示阈值颜色变化：>= 70% 淡黄色、>= 85% 橙色、>= 95% 红色

## 技术方案

### 架构概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          双轨 Token 用量系统                                  │
│                                                                             │
│  ┌─────────────────────┐          ┌─────────────────────────────┐           │
│  │  本地估算轨道（新增）  │          │  API 精确轨道（现有，保持）     │           │
│  │                     │          │                             │           │
│  │  estimateTokenCount │          │  extractSingleUsage         │           │
│  │  (纯本地 JS 计算)    │          │  extractResultUsage         │           │
│  └────────┬────────────┘          └──────────┬──────────────────┘           │
│           │                                  │                              │
│  ┌────────▼──────────────────────────────────▼──────────────────┐           │
│  │              agent:context-usage 事件（扩展）                   │           │
│  │   新增字段：estimatedTokens, isEstimate                        │           │
│  └────────┬─────────────────────────────────────────────────────┘           │
│           │                                                                  │
│  ┌────────▼─────────────────────────────────────────────────────┐           │
│  │              chat.store (双轨合并)                             │           │
│  │  currentContextUsage — 实时显示用（优先精确值，回退估算值）         │           │
│  │  estimatedContextTokens — 本地估算值（独立字段）                  │           │
│  └────────┬─────────────────────────────────────────────────────┘           │
│           │                                                                  │
│  ┌────────▼─────────────────────────────────────────────────────┐           │
│  │              UI 层                                             │           │
│  │  ContextUsageDisplay — 显示 "~12K / 200K (6%)"               │           │
│  │  TokenUsageIndicator — 消息级别：优先精确值，无精确值用估算值      │           │
│  └─────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1. 本地 Token 估算核心函数

**文件**：`src/shared/utils/token-estimator.ts`

```typescript
/**
 * 本地 Token 估算模块
 *
 * 基于字符规则的轻量级 token 估算，纯 JS 计算，无外部依赖。
 * 参考 Claude Code 的估算策略：
 * - 英文/代码/符号：4 字符 ≈ 1 token
 * - 中文/中日韩字符：1 字符 ≈ 2 token
 * - 空白符/换行一并计入
 *
 * 估算精度目标：与实际 token 数偏差在 15% 以内。
 */

/**
 * 判断字符是否为 CJK（中日韩）字符
 * Unicode 范围覆盖：
 * - CJK Unified Ideographs: U+4E00..U+9FFF
 * - CJK Unified Ideographs Extension A-H
 * - CJK Compatibility Ideographs
 * - Hiragana, Katakana
 */
function isCJKCharacter(char: string): boolean {
  const code = char.codePointAt(0);
  if (!code) return false;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
    (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
    (code >= 0x2a700 && code <= 0x2b73f) || // CJK Extension C
    (code >= 0x2b740 && code <= 0x2b81f) || // CJK Extension D
    (code >= 0x2b820 && code <= 0x2ceaf) || // CJK Extension E
    (code >= 0x3040 && code <= 0x309f) ||   // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) ||   // Katakana
    (code >= 0xf900 && code <= 0xfaff)      // CJK Compatibility Ideographs
  );
}

/**
 * 估算文本的 token 数量
 *
 * @param text - 要估算的文本
 * @returns 估算的 token 数量（向上取整）
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const char of text) {
    if (isCJKCharacter(char)) {
      tokens += 2;
    } else {
      tokens += 0.25; // 4 字符 ≈ 1 token
    }
  }
  return Math.ceil(tokens);
}

/**
 * 估算消息内容数组的 token 总量
 * 支持纯文本和多模态消息内容块
 *
 * @param messages - 消息内容数组，每项包含 role 和 content
 * @returns 估算的 token 总量
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let total = 0;
  for (const msg of messages) {
    // role 标记本身也消耗 token（如 <|role|>user</|role|>）
    total += 4; // 每条消息的元数据开销
    total += estimateTokenCount(msg.content);
  }
  return total;
}
```

**设计要点**：

- 放在 `src/shared/utils/` 下，主进程和渲染进程均可引用（遵循 `src/shared/` 禁止导入 Node/Electron 的规则）
- 纯函数，无副作用，易于单元测试
- 使用 `for...of` 逐字符遍历，确保 CJK 字符检测准确

### 2. 主进程估算模块

**文件**：`src/main/services/agent/token-estimator.ts`

```typescript
/**
 * Agent Module - Token Estimator
 *
 * 在主进程中提供上下文 token 估算能力：
 * - 发送前估算：拼接完整上下文文本并估算
 * - 流式中更新：每收到文本块就追加估算
 * - 完成后校准：API 精确值覆盖估算值
 */

import { estimateTokenCount, estimateMessagesTokens } from '../../../shared/utils/token-estimator';
import { getConversation } from '../conversation.service';
import type { TokenUsage } from './types';

/**
 * 估算当前会话的完整上下文 token 数
 *
 * 拼接内容：
 * 1. 会话历史中所有 user/assistant 消息文本
 * 2. 系统提示（约 500-2000 token 的固定开销）
 * 3. 工具定义（约 2000-5000 token 的固定开销）
 * 4. CLAUDE.md + 记忆文件（通过对话历史已包含）
 *
 * @param spaceId - 空间 ID
 * @param conversationId - 会话 ID
 * @returns 估算的上下文 token 数
 */
export function estimateContextTokens(
  spaceId: string,
  conversationId: string,
): number {
  const conversation = getConversation(spaceId, conversationId);
  if (!conversation) return 0;

  const messages = conversation.messages || [];
  let totalTokens = 0;

  // 系统提示和工具定义的固定开销估算
  totalTokens += 3000; // 系统提示约 1000-2000 token + 工具定义约 2000-5000 token

  for (const msg of messages) {
    // 每条消息的元数据开销（role 标记、时间戳等）
    totalTokens += 4;
    totalTokens += estimateTokenCount(msg.content || '');

    // 思考内容和工具调用结果也计入上下文
    if (msg.thoughts && Array.isArray(msg.thoughts)) {
      for (const thought of msg.thoughts) {
        totalTokens += estimateTokenCount(thought.content || '');
        if (thought.toolOutput) {
          totalTokens += estimateTokenCount(thought.toolOutput);
        }
      }
    }
  }

  return totalTokens;
}

/**
 * 估算流式中新增文本的 token 数并更新累计估算值
 *
 * @param previousEstimate - 之前的累计估算 token 数
 * @param newText - 新增的文本增量
 * @returns 更新后的累计估算 token 数
 */
export function estimateStreamingTokens(
  previousEstimate: number,
  newText: string,
): number {
  return previousEstimate + estimateTokenCount(newText);
}

/**
 * 构建估算值的 context-usage 事件数据
 *
 * @param estimatedTokens - 估算的 token 数
 * @param contextWindow - 上下文窗口大小
 * @returns context-usage 事件数据对象
 */
export function buildEstimatedContextUsage(
  estimatedTokens: number,
  contextWindow: number,
): {
  type: 'context-usage';
  estimatedTokens: number;
  isEstimate: true;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
} {
  return {
    type: 'context-usage',
    estimatedTokens,
    isEstimate: true,
    // 将估算值填入 inputTokens 字段（兼容现有 UI 逻辑）
    inputTokens: estimatedTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow,
  };
}
```

### 3. 发送前估算（send-message-local.ts 修改）

**修改文件**：`src/main/services/agent/send-message-local.ts`

在 `sendMessage` 函数中，发送消息前（`v2Session.send()` 调用前），新增上下文估算逻辑：

```typescript
// === 新增：发送前本地估算 ===
import { estimateContextTokens, buildEstimatedContextUsage } from './token-estimator';

// 在 sendMessage 函数中，v2Session.send() 调用前添加：

// 发送前估算当前上下文 token 数
const estimatedTokens = estimateContextTokens(spaceId, conversationId);
const contextWindowForEstimate = resolvedCredentials.contextWindow || 200000;
sendToRenderer('agent:context-usage', spaceId, conversationId, 
  buildEstimatedContextUsage(estimatedTokens, contextWindowForEstimate)
);
console.log(
  `[Agent][${conversationId}] Pre-send estimation: ~${estimatedTokens} tokens / ${contextWindowForEstimate} context window`
);
```

**位置**：在 `v2Session.send(messageContent)` 调用之前（大约在当前代码第 510 行附近），在 `markSessionRequestStart(conversationId)` 之后。

### 4. 流式中估算更新（process-stream.ts 修改）

**修改文件**：`src/main/services/agent/process-stream.ts`

在 `ProcessStreamParams` 中新增字段：

```typescript
export interface ProcessStreamParams {
  // ... 现有字段 ...
  /** 是否启用本地 token 估算（默认 true）。当 API 返回精确值时自动关闭估算。 */
  enableLocalEstimation?: boolean;
}
```

在流式文本增量处理中，追加本地估算逻辑。具体修改点：

1. **新增流式估算状态变量**（在 `processStream` 函数开头）：

```typescript
// 本地 token 估算状态
let enableEstimation = params.enableLocalEstimation !== false; // 默认启用
let estimatedInputTokens = 0; // 估算的累计输入 token 数
let receivedApiUsage = false; // 是否已收到 API 精确 usage
```

2. **文本增量时追加估算**（在 `content_block_delta` + `text_delta` 处理中，约第 520 行附近）：

```typescript
// 追加本地估算
if (enableEstimation && !receivedApiUsage) {
  estimatedInputTokens += estimateTokenCount(delta);
  // 每收到 50 个字符左右发送一次估算更新（避免过于频繁）
  if (estimatedInputTokens % 20 < 2) { // 粗略节流
    emit('agent:context-usage', buildEstimatedContextUsage(
      estimatedInputTokens,
      params.contextWindow || 200000,
    ));
  }
}
```

3. **收到 API 精确 usage 时关闭估算**（在 `message_start` / `message_delta` 的 usage 提取逻辑中，约第 773-810 行）：

```typescript
// 收到 API 精确 usage，关闭本地估算
if (usage.input_tokens > 0) {
  receivedApiUsage = true;
  // ... 现有精确值发送逻辑保持不变 ...
}
```

4. **message_start 事件中初始化估算基准**（在 `content_block_start` + `text` 处理中）：

```typescript
// 如果是第一个文本块且未收到 API usage，用估算值发送初始 context-usage
if (enableEstimation && !receivedApiUsage && estimatedInputTokens === 0) {
  // 初始估算值通过 send-message-local.ts 的发送前估算已发送
  // 这里开始追加流式内容
}
```

### 5. agent:context-usage 事件扩展

**现有事件格式**（保持向后兼容）：

```typescript
{
  type: 'context-usage',
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
}
```

**新增字段**（向后兼容，默认值 false/undefined）：

```typescript
{
  type: 'context-usage',
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  // 新增字段
  isEstimate?: boolean;          // true 表示这是本地估算值，false/undefined 表示 API 精确值
  estimatedTokens?: number;      // 本地估算的 token 数（仅在 isEstimate=true 时有值）
}
```

### 6. chat.store.ts 状态扩展

**修改文件**：`src/renderer/stores/chat.store.ts`

在 `ConversationSessionState` 中新增字段：

```typescript
// ConversationSessionState 新增：
estimatedContextTokens: number | null;  // 本地估算的上下文 token 数（独立于 API 精确值）
contextUsageSource: 'api' | 'estimate' | null;  // 当前 contextUsage 的数据来源
```

在 `createSession` 默认值中：

```typescript
estimatedContextTokens: null,
contextUsageSource: null,
```

修改 `handleAgentContextUsage` 方法，支持双轨合并：

```typescript
handleAgentContextUsage: (data) => {
  const {
    conversationId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    contextWindow: passedContextWindow,
    isEstimate,       // 新增
    estimatedTokens,  // 新增
  } = data;

  set((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(conversationId);
    if (!session) return state;

    const updates: Partial<ConversationSessionState> = {
      lastActivityAt: Date.now(),
    };

    if (isEstimate) {
      // 本地估算值：更新独立字段，如果当前无 API 精确值则也更新 currentContextUsage
      updates.estimatedContextTokens = estimatedTokens ?? null;
      updates.contextUsageSource = session.contextUsageSource === 'api' ? 'api' : 'estimate';
      
      // 仅当当前没有 API 精确值时，用估算值填充 currentContextUsage（驱动 UI 显示）
      if (session.contextUsageSource !== 'api') {
        updates.currentContextUsage = {
          inputTokens: inputTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: passedContextWindow ?? session.currentContextUsage?.contextWindow ?? 200000,
        };
        updates.contextUsageSource = 'estimate';
      }
    } else {
      // API 精确值：直接更新 currentContextUsage，标记来源为 api
      updates.currentContextUsage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        contextWindow: passedContextWindow ?? session.currentContextUsage?.contextWindow ?? 200000,
      };
      updates.contextUsageSource = 'api';
    }

    newSessions.set(conversationId, { ...session, ...updates });
    return { sessions: newSessions };
  });
},
```

### 7. ContextUsageDisplay 显示变更

**修改文件**：`src/renderer/components/chat/InputArea.tsx`

修改 `ContextUsageDisplay` 组件：

```typescript
function ContextUsageDisplay({
  contextUsage,
  isEstimate = false,
}: {
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
  } | null;
  isEstimate?: boolean;
}) {
  if (!contextUsage) {
    return (
      <span className="text-xs text-muted-foreground/30 cursor-default select-none pl-1">
        -- / 200K
      </span>
    );
  }

  const contextUsed =
    contextUsage.inputTokens +
    contextUsage.outputTokens +
    contextUsage.cacheReadTokens +
    contextUsage.cacheCreationTokens;
  const contextWindow = contextUsage.contextWindow > 0 ? contextUsage.contextWindow : 200000;
  const usagePercent = Math.round((contextUsed / contextWindow) * 100);

  // 阈值颜色：70% 淡黄、85% 橙色、95% 红色
  const colorClass =
    usagePercent >= 95
      ? 'text-red-500/80'
      : usagePercent >= 85
        ? 'text-orange-500/80'
        : usagePercent >= 70
          ? 'text-amber-400/80'
          : 'text-muted-foreground/50';

  const prefix = isEstimate ? '~' : '';

  return (
    <span className={`text-xs cursor-default select-none pl-1 ${colorClass}`}>
      {prefix}{formatTokens(contextUsed)} / {formatTokens(contextWindow)} ({usagePercent}%)
    </span>
  );
}
```

在 `InputToolbar` 中传入 `isEstimate` 属性（从 `contextUsageSource` 获取）：

```typescript
<ContextUsageDisplay
  contextUsage={contextUsage}
  isEstimate={contextUsageSource === 'estimate'}
/>
```

### 8. TokenUsageIndicator 双模式支持

**修改文件**：`src/renderer/components/chat/TokenUsageIndicator.tsx`

新增 `isEstimate` 属性：

```typescript
interface TokenUsageIndicatorProps {
  tokenUsage: TokenUsage;
  previousCost?: number;
  className?: string;
  warningThreshold?: number;
  criticalThreshold?: number;
  isEstimate?: boolean;  // 新增：是否为估算值
}
```

在显示 `formatTokens(contextUsed)` 时添加 `~` 前缀：

```typescript
{isEstimate && <span className="text-muted-foreground/40">~</span>}
{formatTokens(contextUsed)}
```

在 tooltip 的 "Used / limit" 行也添加标识：

```typescript
<span className="text-foreground">
  {isEstimate ? '~' : ''}{formatTokens(contextUsed)} / {formatTokens(contextWindow)}
</span>
```

### 9. IPC 通道变更

**无需新增 IPC 通道**。复用现有的 `agent:context-usage` 事件通道，仅扩展事件数据字段（向后兼容）。

| 通道 | 方向 | 变更 |
|------|------|------|
| `agent:context-usage` | main → renderer | 扩展：新增 `isEstimate`、`estimatedTokens` 可选字段 |

### 10. ChatView 传参变更

**修改文件**：`src/renderer/components/chat/ChatView.tsx`

从 session 中额外解构 `contextUsageSource`，传给 `InputArea`：

```typescript
const {
  // ... 现有解构 ...
  currentContextUsage,
  contextUsageSource,  // 新增
} = session;

// InputArea 调用处：
<InputArea
  // ... 现有 props ...
  contextUsage={currentContextUsage}
  contextUsageSource={contextUsageSource}  // 新增
/>
```

`InputAreaProps` 接口新增：

```typescript
contextUsageSource?: 'api' | 'estimate' | null;
```

### 11. 边界条件与错误处理

| 场景 | 处理方式 |
|------|---------|
| API 完全不返回 usage | 全程使用本地估算值，UI 显示 `~` 前缀 |
| API 部分返回 usage（仅 message_start） | 收到精确值后切换为 API 轨道，估算值不再更新 UI |
| 空会话（无历史消息） | 估算结果约 3000 token（系统提示+工具定义固定开销） |
| 超长对话（大量历史） | 估算性能无问题（纯字符串遍历），但 `estimateContextTokens` 仅在发送前调用一次 |
| 会话恢复（sessionId resume） | 恢复后首次发送前估算包含完整历史，结果准确 |
| 远程会话（remote） | 远程会话走 `send-message-remote.ts`，同样在发送前估算；流式中的估算由远程 proxy 返回 |
| Hyper Space（多 agent） | 每个 agent 的会话独立估算，互不干扰 |
| 图片/多模态消息 | 图片按固定 1000 token/张 估算（不解析像素） |
| 流式中断/中止 | 估算值保留在 store 中，不回滚（与现有 API usage 行为一致） |

## 涉及文件

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/shared/utils/token-estimator.ts` | 新增 | 共享的本地 token 估算核心函数（`estimateTokenCount`、`estimateMessagesTokens`），主进程和渲染进程均可引用 |
| 2 | `src/main/services/agent/token-estimator.ts` | 新增 | 主进程 token 估算模块：发送前估算（`estimateContextTokens`）、流式中估算（`estimateStreamingTokens`）、事件构建（`buildEstimatedContextUsage`） |
| 3 | `src/main/services/agent/send-message-local.ts` | 修改 | 发送消息前调用 `estimateContextTokens` 并发送 `agent:context-usage` 估算事件 |
| 4 | `src/main/services/agent/process-stream.ts` | 修改 | 流式文本增量时追加本地估算；收到 API 精确 usage 后关闭估算；`ProcessStreamParams` 新增 `enableLocalEstimation` 字段 |
| 5 | `src/renderer/stores/chat.store.ts` | 修改 | `ConversationSessionState` 新增 `estimatedContextTokens`、`contextUsageSource` 字段；`handleAgentContextUsage` 支持双轨合并逻辑 |
| 6 | `src/renderer/components/chat/InputArea.tsx` | 修改 | `ContextUsageDisplay` 支持 `isEstimate` 属性显示 `~` 前缀；阈值颜色调整（70%/85%/95%）；`InputAreaProps` 新增 `contextUsageSource` |
| 7 | `src/renderer/components/chat/TokenUsageIndicator.tsx` | 修改 | 新增 `isEstimate` 属性，估算值时显示 `~` 前缀 |
| 8 | `src/renderer/components/chat/ChatView.tsx` | 修改 | 从 session 解构 `contextUsageSource` 并传递给 `InputArea` |
| 9 | `src/renderer/i18n/locales/*.json` | 修改 | 新增估算相关国际化文本（如 `~` 前缀的 tooltip 说明） |

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `.project/modules/agent/features/stream-processing/design.md` | 理解流式处理架构、token usage 追踪机制、`agent:context-usage` 事件触发时机 |
| 2 | `.project/modules/agent/features/stream-processing/changelog.md` | 了解流式处理最近变更（usage 提取、compact 事件等），避免回归 |
| 3 | `.project/modules/chat/chat-ui-v1.md` | 理解聊天模块整体架构、组件树、chat.store 中 `currentContextUsage` 的使用方式 |
| 4 | `.project/modules/chat/features/input-area/design.md` | 理解输入框组件设计、ContextUsageDisplay 组件的工作方式 |

### 源码文件

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 5 | `src/main/services/agent/process-stream.ts` | 理解流式 token usage 的完整提取流程（`extractSingleUsage`、`extractResultUsage`、`agent:context-usage` 发送时机），确定本地估算插入点 |
| 6 | `src/main/services/agent/message-utils.ts` | 理解 `extractSingleUsage` 和 `extractResultUsage` 的实现细节，了解精确 usage 数据结构 |
| 7 | `src/main/services/agent/send-message-local.ts` | 理解消息发送主流程、会话创建时机、上下文拼接方式，确定发送前估算插入点 |
| 8 | `src/renderer/stores/chat.store.ts` | 理解 `handleAgentContextUsage`、`handleAgentComplete` 中 `currentContextUsage` 的更新逻辑，确定双轨合并插入点 |
| 9 | `src/renderer/components/chat/InputArea.tsx` | 理解 `ContextUsageDisplay` 组件的实现细节、`contextUsage` prop 的传递链路 |
| 10 | `src/renderer/components/chat/TokenUsageIndicator.tsx` | 理解每条消息的 token 用量展示逻辑，确定 `isEstimate` 属性的显示方式 |
| 11 | `src/renderer/components/chat/ChatView.tsx` | 理解 `currentContextUsage` 从 store 到 InputArea 的传递方式 |
| 12 | `src/main/services/agent/types.ts` | 理解 `TokenUsage`、`SingleCallUsage` 类型定义 |
| 13 | `src/main/services/agent/send-message-remote.ts` | 理解远程会话的 `agent:context-usage` 事件转发逻辑，确认远程场景兼容性 |

### 编码规范

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 14 | `docs/Development-Standards-Guide.md` | 编码规范（TypeScript strict、禁止 any、纯类型导入用 `import type`、命名规范） |
| 15 | `CLAUDE.md` | 项目铁律、IPC 通道常量化、shared 模块禁止导入 Node/Electron |

## 验收标准

- [ ] 即使 API 不返回 usage 数据，UI 仍能实时显示上下文用量（估算值带 `~` 前缀）
- [ ] 发送消息前自动估算当前上下文用量并更新 UI（`ContextUsageDisplay` 显示估算值）
- [ ] 流式响应过程中，上下文用量实时递增（估算值随文本块增长）
- [ ] API 返回精确值后，消息级别 `tokenUsage` 记录精确值，不使用估算值
- [ ] 输入区域工具栏实时显示 `"~12K / 200K (6%)"` 格式（估算值带 `~` 前缀）
- [ ] API 精确值到达后，`~` 前缀消失，显示精确值
- [ ] 估算阈值颜色变化正常：>= 70% 淡黄色、>= 85% 橙色、>= 95% 红色
- [ ] 空会话首次发送前显示估算值（约 3K，含系统提示和工具定义开销）
- [ ] 远程会话和 Hyper Space 场景不回归（不因估算逻辑影响现有功能）
- [ ] `TokenUsageIndicator`（每条消息级别）优先显示 API 精确值，无精确值时显示估算值并带 `~` 前缀
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 单元测试：`estimateTokenCount` 对纯英文/纯中文/混合文本的估算偏差在 15% 以内

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-30 | 初始 PRD | 用户 |
