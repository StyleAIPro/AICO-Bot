---
timestamp: 2026-05-14
status: done
module: remote-agent
level: feature
requester: user
---

# PRD [Feature] -- 远程 Agent 上下文用量实时推送

## 需求分析

### 背景

本地 Agent 已实现上下文用量实时显示功能（`ContextUsageDisplay`，在压缩按钮右侧显示 `125K / 200K (62.5%)`），通过 `agent:context-usage` IPC 事件实时推送 token 数据到前端。但远程 Agent 代理（`packages/remote-agent-proxy/`）尚未实现此功能，导致远程空间使用时上下文用量始终显示为 `-- / 200K`。

### 问题分析

当前远程链路的 token 数据流存在 6 个缺口：

| # | 缺口位置 | 问题描述 |
|---|---------|---------|
| 1 | `claude-manager.ts` streamChat | 只从 SDK `result` 事件提取 usage，不处理 `stream_event` 中的 `message_start` 和 `message_delta` 事件 |
| 2 | `claude-manager.ts` streamChat | 没有 yield 中间 usage 数据（仅在 result 事件时 yield `usage` chunk） |
| 3 | `server.ts` handleClaudeChat | 没有 `context-usage` chunk 类型来转发中间 usage |
| 4 | `remote-ws-client.ts` | 不处理 `claude:context-usage` 消息类型 |
| 5 | `send-message-remote.ts` | 没有监听 `context-usage` 事件并转发 `agent:context-usage` 到渲染器 |
| 6 | `send-message-remote.ts` | `agent:complete` 发送空对象 `{}`，不携带 `tokenUsage` |

### 数据流（当前 vs 目标）

```
当前（❌ 断裂）:

远程代理 (claude-manager.ts)         server.ts            remote-ws-client    send-message-remote    渲染器
SDK stream_event                      │                    │                   │                     │
  message_start → ❌ 未提取           │                    │                   │                     │
  message_delta → ❌ 未提取           │                    │                   │                     │
SDK result → yield usage → 发送       │                    │                   │                     │
  claude:usage ─────────────────────► claude:usage ──────► 存储 tokenUsage ──► response.tokenUsage ──► ❌ 未推送
                                     │                    │                   │                     │
                                     │                    │                   │ agent:complete({}) ──► 无 tokenUsage

目标（✅ 完整）:

远程代理 (claude-manager.ts)         server.ts            remote-ws-client    send-message-remote    渲染器
SDK stream_event                      │                    │                   │                     │
  message_start → yield context-usage │                    │                   │                     │
  message_delta → yield context-usage │                    │                   │                     │
SDK result → yield usage ──────────► claude:usage ──────► 存储 tokenUsage    │                     │
                                     claude:context-usage ► claude:context-usage ──► agent:context-usage ──► 更新用量
                                      │                    │                   │                     │
                                      │                    │                   │ agent:complete({     ──► 最终用量
                                      │                    │                   │   tokenUsage })       │
```

### 用户价值

- 远程空间用户可实时看到上下文用量，与本地空间体验一致
- 可以及时发现上下文接近上限，主动压缩
- 不再需要在本地和远程之间体验不一致

## 技术方案

### 整体思路

在远程代理的完整链路上实现 token usage 实时推送，分为 4 层修改：

1. **远程代理层**（`packages/remote-agent-proxy/`）：提取流式 token 数据，yield 中间 usage chunk
2. **WebSocket 服务层**（`server.ts`）：转发中间 usage 消息到客户端
3. **本地客户端层**（`remote-ws-client.ts`）：处理新的 WebSocket 消息类型
4. **消息转发层**（`send-message-remote.ts`）：将远程 token 数据转为 IPC 事件推送到渲染器

### 详细设计

#### 1. `claude-manager.ts` -- 提取流式 token 数据并 yield

在 `streamChat` 的 `stream_event` 处理分支中（约 line 2132），增加对 `message_start` 和 `message_delta` 事件的 usage 提取。

**新增代码位置**：在 `stream_event` 处理块的子 agent 路由之后、`content_block_start` 处理之前，增加 usage 提取逻辑。

```typescript
// ========== Context usage from stream events ==========
// Extract usage from message_start (early indication, input_tokens only)
if (streamEvent.type === 'message_start' && streamEvent.message?.usage) {
  const usage = streamEvent.message.usage
  if (usage.input_tokens > 0) {
    const effectiveContextWindow = options.contextWindow ?? this.contextWindow ?? 200000
    yield {
      type: 'context-usage',
      data: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: 0, // Not yet generated at message_start
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        contextWindow: effectiveContextWindow
      }
    }
    console.log(`[ClaudeManager] Stream message_start usage: input=${usage.input_tokens}`)
  }
}

// Extract usage from message_delta (complete token count at API call end)
if (streamEvent.type === 'message_delta' && streamEvent.usage) {
  const usage = streamEvent.usage
  if (usage.input_tokens > 0) {
    const effectiveContextWindow = options.contextWindow ?? this.contextWindow ?? 200000
    yield {
      type: 'context-usage',
      data: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        contextWindow: effectiveContextWindow
      }
    }
    console.log(`[ClaudeManager] Stream message_delta usage: input=${usage.input_tokens}, output=${usage.output_tokens}`)
  }
}
```

**与本地 `process-stream.ts` 的对齐**：本地实现在 `stream_event` 处理中提取 `message_delta` 和 `message_start` 的 usage，远程实现与此保持一致。

#### 2. `server.ts` -- 转发 `context-usage` chunk

在 `handleClaudeChat` 的 chunk 循环中（约 line 987，`chunk.type === 'usage'` 分支之后），增加 `context-usage` chunk 处理：

```typescript
} else if (chunk.type === 'context-usage') {
  // Forward context usage to client for real-time display
  this.sendMessage(ws, {
    type: 'claude:context-usage',
    sessionId,
    data: chunk.data
  })
}
```

#### 3. `ws-types.ts` -- 新增消息类型

在 `ServerMessage.type` 联合类型中新增 `'claude:context-usage'`：

```typescript
export interface ServerMessage {
  type:
    | 'auth:success'
    | ...
    | 'claude:context-usage'  // 新增
    | 'stream:alive';
  // ...
}
```

#### 4. `remote-ws-client.ts` -- 处理 `claude:context-usage` 消息

在 WebSocket 消息路由的 `switch` 语句中（约 line 311，`case 'claude:usage'` 之后），新增：

```typescript
case 'claude:context-usage':
  this.emit('claude:context-usage', { sessionId: message.sessionId, data: message.data });
  break;
```

同时在 `sendChatWithStream` 中（约 line 553 `usageHandler` 之后），新增 `contextUsageHandler`：

```typescript
const contextUsageHandler = (data: any) => {
  if (data.sessionId === sessionId) {
    resetTimeout();
    // Emit for real-time forwarding to renderer
    this.emit('context-usage', { sessionId, data: data.data });
  }
};
```

注册和清理：在 `this.on(...)` 注册列表中添加 `this.on('claude:context-usage', contextUsageHandler)`，在所有 cleanup 路径（`completeHandler`、`errorHandler`、`doForceDisconnect`）中添加 `this.off('claude:context-usage', contextUsageHandler)`。

#### 5. `send-message-remote.ts` -- 转发到渲染器

**5a. 监听 `context-usage` 事件**（在现有 `addHandler` 块中，约 line 677 `stream:alive` handler 之后）：

```typescript
// Context usage real-time forwarding (aligned with local agent:context-usage)
addHandler('context-usage', (data) => {
  if (data.sessionId === effectiveSessionId) {
    sendToRenderer('agent:context-usage', spaceId, conversationId, {
      type: 'context-usage',
      inputTokens: data.data.inputTokens || 0,
      outputTokens: data.data.outputTokens || 0,
      cacheReadTokens: data.data.cacheReadTokens || 0,
      cacheCreationTokens: data.data.cacheCreationTokens || 0,
      contextWindow: data.data.contextWindow,
    });
  }
});
```

**5b. `agent:complete` 携带 `tokenUsage`**（约 line 898 和 line 989）：

当前：
```typescript
sendToRenderer('agent:complete', spaceId, conversationId, {});
```

修改为：
```typescript
sendToRenderer('agent:complete', spaceId, conversationId, {
  tokenUsage: response.tokenUsage || undefined,
});
```

需修改两处：正常完成（line 898）和中断完成（line 989）。中断时 `response` 不存在，使用存储的 `tokenUsage` 变量（需在作用域内保持最新值）。

### 不做的事

- 不修改前端 `chat.store.ts`、`ContextUsageDisplay` 组件 -- 前端已有完整的 `handleAgentContextUsage` 和 `handleAgentComplete` 处理逻辑，只需确保数据正确推送即可
- 不修改 `preload/index.ts`、`transport.ts`、`api/index.ts` -- `agent:context-usage` IPC 通道已在本地实现时注册完成
- 不修改 `packages/remote-agent-proxy/src/types.ts` -- `ClientMessage` 类型无需变更（消息方向为服务端到客户端）
- 不新增独立的 WebSocket 事件 -- 复用现有 `yield` + `sendMessage` 模式

## 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | streamChat 中 stream_event 分支增加 `message_start`/`message_delta` 的 usage 提取和 yield |
| `packages/remote-agent-proxy/src/server.ts` | 修改 | handleClaudeChat chunk 循环增加 `context-usage` chunk 转发 |
| `src/main/services/remote/ws/ws-types.ts` | 修改 | `ServerMessage.type` 联合类型新增 `'claude:context-usage'` |
| `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | 消息路由新增 `claude:context-usage` case，sendChatWithStream 新增 contextUsageHandler |
| `src/main/services/agent/send-message-remote.ts` | 修改 | 新增 `context-usage` addHandler，`agent:complete` 携带 tokenUsage |

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|----------|
| PRD | `.project/prd/feature/chat/feature-context-usage-display-v1.md` | 理解本地上下文用量显示的完整实现方案和数据格式 |
| PRD | `.project/prd/bugfix/chat/bugfix-context-usage-zero-v1.md` | 理解 `message_start`/`message_delta` usage 提取逻辑（已在本地方案中验证） |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（lines 2132-2360 stream_event 处理，lines 2697-2735 result 事件处理） | 理解 stream_event 分支结构和 usage yield 逻辑 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts`（lines 937-1009 handleClaudeChat chunk 循环） | 理解 chunk 类型路由和 WebSocket 消息发送模式 |
| 源码文件 | `src/main/services/remote/ws/ws-types.ts` | ServerMessage/ClientMessage 类型定义 |
| 源码文件 | `src/main/services/remote/ws/remote-ws-client.ts`（lines 305-313 消息路由，lines 474-647 sendChatWithStream） | 理解 WebSocket 消息分发和 Promise 封装模式 |
| 源码文件 | `src/main/services/agent/send-message-remote.ts`（lines 286-698 addHandler 注册，lines 863-930 response 处理和 agent:complete） | 理解远程消息转发到渲染器的模式 |
| 源码文件 | `src/main/services/agent/process-stream.ts`（lines 770-810 stream_event usage 提取） | 参考本地 `message_delta`/`message_start` 的 usage 提取实现 |
| 源码文件 | `src/renderer/stores/chat.store.ts`（lines 450-460, 2486-2510） | 理解前端 `handleAgentContextUsage` 的数据格式期望 |
| 模块文档 | `.project/modules/remote-agent/features/websocket-client/design.md` | 理解 WebSocket 客户端架构 |
| 模块文档 | `.project/modules/remote-agent/features/websocket-client/changelog.md` | 了解最近变更 |

## 验收标准

- [ ] 远程空间对话时，InputToolbar 的 ContextUsageDisplay 能实时显示上下文用量（非 `-- / 200K`）
- [ ] `message_start` 事件能提供早期 input_tokens 指示
- [ ] `message_delta` 事件能提供完整 token 计数（input + output + cache）
- [ ] 对话结束时，contextWindow 显示正确的最终值
- [ ] `agent:complete` 事件携带 `tokenUsage`，前端能正确更新最终用量
- [ ] 多轮远程对话中，上下文用量持续更新不丢失
- [ ] 与本地空间的上下文用量显示行为一致
- [ ] `npm run typecheck && npm run build` 通过
