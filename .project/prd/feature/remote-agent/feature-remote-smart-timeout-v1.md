---
timestamp: 2026-05-14
status: done
module: remote-agent
level: feature
requester: user
---

# PRD [Feature] -- 远程 Agent 智能超时机制

## 需求分析

### 背景

当前远程 Agent 有两层超时机制：
1. **客户端空闲超时**：`remote-ws-client.ts` 的 `sendChatWithStream()` 中 `IDLE_TIMEOUT_MS = 60 分钟`，仅通过 `claude:stream`、`thought`、`thought:delta`、`terminal:output`、`tool:call`、`tool:result` 事件重置
2. **服务端全局超时**：`server.ts` 的 `handleClaudeChat()` 中 `STREAM_GLOBAL_TIMEOUT_MS = 2 小时`，定时器到期后 `forceAbortStreamIterator`，不发送错误通知

### 问题清单

| # | 问题 | 影响 |
|---|------|------|
| 1 | 长任务（几十小时 Docker 构建、大规模编译）被 2 小时全局超时强制中断 | 任务中断，丢失进度 |
| 2 | 单个工具执行 > 60 分钟（大编译、Docker 构建）即使 `tool:call` 重置了计时器，服务端 2 小时硬上限仍不可逾越 | 与 #1 同 |
| 3 | Agent 真正卡死（SDK 进程崩溃但 WebSocket TCP 存活），用户要等 60 分钟才能感知 | 用户体验差，浪费时间 |
| 4 | WebSocket ping/pong（90 秒）只证明 TCP 连接存活，不证明 Agent 在工作 | 超时检测不精准 |
| 5 | 空闲超时触发时直接 reject Promise，无用户决策机会 | "一刀切"断开 |

### 目标

将超时机制从"一刀切断开"改为"智能检测 + 主动通知 + 用户决策"三层架构：

1. **服务端心跳**：Proxy 在 stream 循环中定期发送 `stream:alive` 消息，证明 Agent 在工作
2. **进程存活检测**：SDK 子进程死亡时立即通知客户端，不等空闲超时
3. **超时警告**：客户端空闲超时触发时改为弹窗警告，由用户决定继续等待或强制中断

## 问题根因

| 层级 | 当前值 | 根因 |
|------|--------|------|
| 客户端空闲超时 | 60 分钟 | 工具执行期间 `tool:call` 重置了计时器，但无法区分"Agent 在工作"和"Agent 卡在工具执行中" |
| 服务端全局超时 | 2 小时（硬编码） | 不可配置、不可重置，无提前通知 |
| WebSocket 心跳 | 90 秒 ping/pong | 只检测 TCP 连通性，不检测 Agent 进程状态 |
| 超时触发 | 直接 reject | 无用户决策环节 |

## 技术方案

### 整体架构

```
远程服务器 (server.ts)              本地客户端 (remote-ws-client.ts)       前端 (chat.store.ts)
───────────────────────────       ──────────────────────────────       ─────────────────────
SDK stream 循环                    WebSocket 消息处理                    Zustand store
                                     │
每 5 分钟发送 ──────────────────► 收到 stream:alive                    │
  stream:alive                      → 重置空闲计时器                     ├─ 更新 agentElapsedTime
  (附带工具名、已执行时长)           → emit 'stream:alive'               └─ UI 显示 "Agent 已执行 XX 分钟"
                                     │
SDK 子进程死亡                      收到 claude:error                    │
  → 检测 transport 状态              (进程崩溃通知)                       ├─ handleAgentError()
  → 发送 claude:error               → reject Promise                    └─ 显示错误
                                     │
                                     空闲超时触发                         │
                                     → emit 'idle:timeout'              ├─ 弹窗提示
                                     → 等待用户决策                        ├─ "继续等待" / "强制中断"
                                     ← 用户选择                            └─ 通过 IPC 回传决策
                                       │
                                       ├─ 继续等待 → 重置计时器
                                       └─ 强制中断 → reject Promise
```

### 第一层：服务端 `stream:alive` 心跳

#### 1.1 新增 `stream:alive` 消息类型

**文件：`packages/remote-agent-proxy/src/types.ts`**

在 `ServerMessage.type` 联合类型中新增 `'stream:alive'`：

```typescript
export interface ServerMessage {
  type: 'auth:success' | 'auth:failed' |
         // ... 现有类型 ...
         'stream:alive' |  // 新增：服务端 stream 活跃心跳
         // ...
  sessionId?: string
  data?: any
}
```

新增 `StreamAliveData` 接口：

```typescript
export interface StreamAliveData {
  /** stream 已持续时长（毫秒） */
  elapsedMs: number
  /** 当前正在执行的工具名（如果有） */
  currentToolName?: string
  /** 当前工具已执行时长（毫秒，如果有） */
  currentToolElapsedMs?: number
}
```

**文件：`src/main/services/remote/ws/ws-types.ts`**

在 `ServerMessage.type` 联合类型中同步新增 `'stream:alive'`。

#### 1.2 服务端在 stream 循环中发送心跳

**文件：`packages/remote-agent-proxy/src/server.ts`**

在 `handleClaudeChat()` 的 `for await` 循环外层（与 `globalTimer` 同级），新增 `aliveTimer`：

```typescript
// 在 globalTimer 声明附近新增
let aliveTimer: ReturnType<typeof setInterval> | undefined
const streamStartTime = Date.now()
const ALIVE_INTERVAL_MS = 5 * 60 * 1000 // 每 5 分钟发送一次

// 跟踪当前执行的工具名（通过 onToolCall 回调更新）
let currentToolName: string | undefined
let currentToolStartTime: number | undefined

// 在 for await 循环开始前启动心跳定时器
aliveTimer = setInterval(() => {
  const elapsed = Date.now() - streamStartTime
  const aliveData: StreamAliveData = {
    elapsedMs: elapsed,
    currentToolName,
    currentToolElapsedMs: currentToolStartTime ? Date.now() - currentToolStartTime : undefined,
  }
  this.sendMessage(ws, {
    type: 'stream:alive',
    sessionId,
    data: aliveData,
  })
  console.log(`[RemoteAgentServer] stream:alive for ${sessionId} — ${Math.round(elapsed / 60000)}min, tool=${currentToolName || 'none'}`)
}, ALIVE_INTERVAL_MS)
```

更新 `onToolCall` 回调以跟踪当前工具名：

```typescript
const onToolCall = (tool: ToolCall) => {
  // 更新当前工具跟踪
  if (tool.status === 'running' || tool.status === 'started') {
    currentToolName = tool.name
    currentToolStartTime = Date.now()
  } else if (tool.status === 'result' || tool.status === 'error') {
    currentToolName = undefined
    currentToolStartTime = undefined
  }
  // ... 现有代码不变 ...
}
```

在 finally 块中清理：

```typescript
finally {
  if (globalTimer) clearTimeout(globalTimer)
  if (aliveTimer) clearInterval(aliveTimer)  // 新增
  // ... 现有代码不变 ...
}
```

#### 1.3 客户端处理 `stream:alive` 消息

**文件：`src/main/services/remote/ws/remote-ws-client.ts`**

在 `handleMessage()` 的 switch 中新增 `case 'stream:alive'`：

```typescript
case 'stream:alive':
  this.emit('stream:alive', { sessionId: message.sessionId, data: message.data });
  break;
```

在 `sendChatWithStream()` 中监听 `stream:alive` 事件并重置空闲计时器：

```typescript
// 在现有事件监听器注册区域新增
this.on('stream:alive', activityHandler);

// 在清理区域也新增
this.off('stream:alive', activityHandler);
```

#### 1.4 主进程转发到渲染进程

**文件：`src/main/services/agent/send-message-remote.ts`**

新增 `stream:alive` 事件转发：

```typescript
// 在事件注册区域新增
addHandler('stream:alive', (data) => {
  if (data.sessionId === effectiveSessionId) {
    sendToRenderer('agent:stream-alive', spaceId, conversationId, data.data);
  }
});
```

#### 1.5 前端显示 Agent 执行时长

**文件：`src/renderer/stores/chat.store.ts`**

新增 `handleAgentStreamAlive` 方法：

```typescript
handleAgentStreamAlive: (data: AgentEventBase & {
  elapsedMs: number;
  currentToolName?: string;
  currentToolElapsedMs?: number;
}) => {
  const { conversationId, elapsedMs, currentToolName, currentToolElapsedMs } = data;
  set((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(conversationId);
    if (!session) return state;
    newSessions.set(conversationId, {
      ...session,
      agentElapsedTime: elapsedMs,
      agentCurrentTool: currentToolName || null,
    });
    return { sessions: newSessions };
  });
};
```

**文件：`src/renderer/components/chat/WorkerPanel.tsx` 或相关组件**

在 Agent 执行状态区域显示 "Agent 已执行 XX 分钟"（当 `agentElapsedTime > 0` 时显示）。当 `agentCurrentTool` 存在时，显示 "正在执行: {toolName}"。

### 第二层：服务端进程存活检测

#### 2.1 利用现有 `transport.onExit` 机制

当前 `claude-manager.ts` 已经在创建 session 时通过 `registerSessionExitListener()` 注册了 `transport.onExit` 回调。当 SDK 子进程死亡时，回调会被触发并调用 `cleanupSession()`。

但问题是：`cleanupSession()` 只清理服务端状态，**不通知客户端**。客户端只能等到空闲超时（60 分钟）才会感知。

#### 2.2 改造：进程退出时通知客户端

**文件：`packages/remote-agent-proxy/src/claude-manager.ts`**

新增可选回调参数到 session 创建：

```typescript
// 新增类属性
private sessionExitCallbacks: Map<string, (reason: string) => void> = new Map()

// 新增方法：注册 session 退出回调
registerSessionExitCallback(conversationId: string, callback: (reason: string) => void): void {
  this.sessionExitCallbacks.set(conversationId, callback)
}

// 新增方法：取消注册
unregisterSessionExitCallback(conversationId: string): void {
  this.sessionExitCallbacks.delete(conversationId)
}
```

修改 `registerSessionExitListener()` 的调用处，在进程退出时触发回调：

```typescript
// 在 registerSessionExitListener 调用的 onExit 回调中
const onExit = (error: Error | undefined) => {
  const errorMsg = error ? `: ${error.message}` : ''
  console.log(`[ClaudeManager][${conversationId}] Process exited${errorMsg}`)

  // 触发外部回调通知客户端
  const exitCallback = this.sessionExitCallbacks.get(conversationId)
  if (exitCallback) {
    exitCallback(error ? error.message : 'SDK process exited unexpectedly')
    this.sessionExitCallbacks.delete(conversationId)
  }

  // 现有的 cleanupSession 逻辑...
}
```

**文件：`packages/remote-agent-proxy/src/server.ts`**

在 `handleClaudeChat()` 中注册退出回调：

```typescript
// 在 stream 开始前注册
this.claudeManager.registerSessionExitCallback(sessionId, (reason: string) => {
  console.error(`[RemoteAgentServer] SDK process died for session ${sessionId}: ${reason}`)
  this.sendMessage(ws, {
    type: 'claude:error',
    sessionId,
    data: { error: `SDK process crashed: ${reason}`, isProcessDeath: true }
  })
})

// 在 finally 块中取消注册
finally {
  // ...
  this.claudeManager.unregisterSessionExitCallback(sessionId)
  // ...
}
```

#### 2.3 `ChatOptions` 新增 `timeoutMs` 和 `globalTimeoutMs`

**文件：`packages/remote-agent-proxy/src/types.ts`**

```typescript
export interface ChatOptions {
  // ... 现有字段 ...
  /** 客户端空闲超时（毫秒），0 = 无限，默认由客户端决定 */
  timeoutMs?: number
  /** 服务端 stream 全局超时（毫秒），0 = 无限，默认 2 小时 */
  globalTimeoutMs?: number
}
```

**文件：`packages/remote-agent-proxy/src/server.ts`**

修改全局超时为可配置：

```typescript
// 之前
const STREAM_GLOBAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// 之后
const STREAM_GLOBAL_TIMEOUT_MS = options?.globalTimeoutMs ?? 2 * 60 * 60 * 1000;
const globalTimeoutEnabled = STREAM_GLOBAL_TIMEOUT_MS > 0;

if (globalTimeoutEnabled) {
  globalTimer = setTimeout(() => {
    console.error(`[RemoteAgentServer] Stream global timeout (${STREAM_GLOBAL_TIMEOUT_MS / 60000}min) for session ${sessionId}`)
    // 发送超时通知（而非静默 abort）
    this.sendMessage(ws, {
      type: 'claude:error',
      sessionId,
      data: { error: `Stream global timeout (${Math.round(STREAM_GLOBAL_TIMEOUT_MS / 60000)} minutes)`, isGlobalTimeout: true }
    })
    this.claudeManager.forceAbortStreamIterator(sessionId)
  }, STREAM_GLOBAL_TIMEOUT_MS)
}
```

### 第三层：超时改为警告而非断开

#### 3.1 客户端超时触发时 emit 警告事件（而非直接 reject）

**文件：`src/main/services/remote/ws/remote-ws-client.ts`**

修改 `sendChatWithStream()` 中的超时处理逻辑：

```typescript
// 之前的超时处理（在 checkTimeout 内）
if (elapsed >= IDLE_TIMEOUT_MS && !isComplete) {
  // ... 直接 reject ...
  reject(new Error(`Chat timeout - no activity for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes`));
}

// 之后的超时处理
if (elapsed >= IDLE_TIMEOUT_MS && !isComplete) {
  // 清理超时定时器（不再自动 reject）
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }

  // 发送空闲超时警告事件，让上层（send-message-remote.ts）决定如何处理
  this.emit('idle:timeout', {
    sessionId,
    idleMinutes: Math.round(IDLE_TIMEOUT_MS / 60000),
    elapsedMinutes: Math.round((Date.now() - streamStartTime) / 60000),
  });

  // 不立即 reject — 等待上层通过 resolve/reject 或继续等待决策
  // 使用 Promise.race 等待用户决策或下一个活动事件

  // 启动"等待用户决策"定时器，默认再等 10 分钟
  const DECISION_TIMEOUT_MS = 10 * 60 * 1000;
  const decisionTimer = setTimeout(() => {
    // 用户 10 分钟内未做决策，保持等待（因为 stream:alive 可能仍在到达）
    // 重新启动空闲检查循环
    resetTimeout();
  }, DECISION_TIMEOUT_MS);

  // 暴露"继续等待"方法给上层调用
  pendingIdleTimeout = {
    continueWaiting: () => {
      clearTimeout(decisionTimer);
      resetTimeout(); // 重置空闲计时器，重新开始计时
    },
    forceDisconnect: () => {
      clearTimeout(decisionTimer);
      // 执行与之前相同的清理逻辑
      this.off('claude:stream', streamHandler);
      this.off('claude:usage', usageHandler);
      this.off('claude:complete', completeHandler);
      this.off('claude:error', errorHandler);
      this.off('thought', activityHandler);
      this.off('thought:delta', activityHandler);
      this.off('terminal:output', activityHandler);
      this.off('tool:call', activityHandler);
      this.off('tool:result', activityHandler);
      this.off('stream:alive', activityHandler);
      this.activeStreamSessions.delete(sessionId);
      reject(new Error(`Chat timeout - no activity for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes (user forced)`));
    },
  };
}
```

修改 `sendChatWithStream` 的返回类型，使其也支持返回 `pendingIdleTimeout` 控制对象：

由于 `sendChatWithStream` 返回 `Promise`，无法直接暴露控制对象。改为在类级别存储：

```typescript
// 新增类属性
private pendingIdleTimeouts = new Map<string, {
  continueWaiting: () => void;
  forceDisconnect: () => void;
}>();

// 新增公共方法
continueIdleTimeout(sessionId: string): void {
  const pending = this.pendingIdleTimeouts.get(sessionId);
  if (pending) {
    pending.continueWaiting();
    this.pendingIdleTimeouts.delete(sessionId);
  }
}

forceIdleTimeoutDisconnect(sessionId: string): void {
  const pending = this.pendingIdleTimeouts.get(sessionId);
  if (pending) {
    pending.forceDisconnect();
    this.pendingIdleTimeouts.delete(sessionId);
  }
}
```

#### 3.2 主进程处理 `idle:timeout` 事件，转发到前端

**文件：`src/main/services/agent/send-message-remote.ts`**

新增 `idle:timeout` 事件处理：

```typescript
addHandler('idle:timeout', async (data) => {
  if (data.sessionId === effectiveSessionId) {
    log.warn(`Idle timeout for session ${effectiveSessionId}: ${data.idleMinutes}min idle, ${data.elapsedMinutes}min total`);
    sendToRenderer('agent:idle-timeout', spaceId, conversationId, {
      idleMinutes: data.idleMinutes,
      elapsedMinutes: data.elapsedMinutes,
    });
  }
});
```

#### 3.3 新增 IPC 通道：用户决策回传

**文件：`src/shared/constants/ipc-channels.ts`（或相应的常量文件）**

```typescript
// 新增
REMOTE_CONTINUE_IDLE_TIMEOUT = 'remote:continue-idle-timeout',
REMOTE_FORCE_IDLE_TIMEOUT = 'remote:force-idle-timeout',
```

**文件：`src/main/ipc/remote-server.ts`（或相应 IPC handler 文件）**

新增两个 IPC handler：

```typescript
ipcMain.handle(REMOTE_CONTINUE_IDLE_TIMEOUT, async (_event, conversationId: string) => {
  const client = getRemoteWsClient(conversationId);
  if (client) {
    client.continueIdleTimeout(conversationId);
  }
});

ipcMain.handle(REMOTE_FORCE_IDLE_TIMEOUT, async (_event, conversationId: string) => {
  const client = getRemoteWsClient(conversationId);
  if (client) {
    client.forceIdleTimeoutDisconnect(conversationId);
  }
});
```

**文件：`src/preload/index.ts`**

暴露新的 IPC 方法到 `window.aicoBot`。

**文件：`src/renderer/api/transport.ts`**

在 `methodMap` 中添加新的 IPC 通道映射。

**文件：`src/renderer/api/index.ts`**

导出新的 API 方法。

#### 3.4 前端弹窗交互

**文件：`src/renderer/stores/chat.store.ts`**

新增 `idleTimeout` 状态到 SessionState：

```typescript
// 在 SessionState 接口中新增
idleTimeout?: {
  idleMinutes: number;
  elapsedMinutes: number;
  triggeredAt: number;
} | null;
```

新增 `handleAgentIdleTimeout` 方法：

```typescript
handleAgentIdleTimeout: (data: AgentEventBase & {
  idleMinutes: number;
  elapsedMinutes: number;
}) => {
  const { conversationId, idleMinutes, elapsedMinutes } = data;
  set((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(conversationId);
    if (!session) return state;
    newSessions.set(conversationId, {
      ...session,
      idleTimeout: {
        idleMinutes,
        elapsedMinutes,
        triggeredAt: Date.now(),
      },
    });
    return { sessions: newSessions };
  });
};
```

新增 `resolveIdleTimeout` 和 `forceIdleTimeout` 方法：

```typescript
resolveIdleTimeout: async (conversationId: string) => {
  await api.continueIdleTimeout(conversationId);
  set((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(conversationId);
    if (!session) return state;
    newSessions.set(conversationId, { ...session, idleTimeout: null });
    return { sessions: newSessions };
  });
},

forceIdleTimeout: async (conversationId: string) => {
  await api.forceIdleTimeout(conversationId);
  set((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(conversationId);
    if (!session) return state;
    newSessions.set(conversationId, { ...session, idleTimeout: null });
    return { sessions: newSessions };
  });
},
```

**文件：前端 UI 组件（弹窗）**

当 `session.idleTimeout` 不为 null 时，在聊天区域显示警告弹窗：

```
┌──────────────────────────────────────────────────┐
│  ⚠ Agent 无活动                                    │
│                                                    │
│  Agent 已有 {idleMinutes} 分钟无活动               │
│  （总执行时间 {elapsedMinutes} 分钟）               │
│                                                    │
│  Agent 可能卡死。你可以：                           │
│                                                    │
│  [继续等待]              [强制中断]                  │
│                                                    │
└──────────────────────────────────────────────────┘
```

- **继续等待**：调用 `resolveIdleTimeout`，重置空闲计时器
- **强制中断**：调用 `forceIdleTimeout`，断开 stream

#### 3.5 i18n 文案

**文件：`src/renderer/i18n/locales/en.json`** 和 **`zh-CN.json`**（及其他语言文件）

新增以下 key：

```json
{
  "agent.idleTimeout.title": "Agent Inactive",
  "agent.idleTimeout.description": "Agent has been inactive for {{idleMinutes}} minutes (total: {{elapsedMinutes}} minutes). The Agent may be stuck.",
  "agent.idleTimeout.continueWaiting": "Continue Waiting",
  "agent.idleTimeout.forceStop": "Force Stop",
  "agent.elapsedTime": "Agent has been running for {{minutes}} minutes",
  "agent.currentTool": "Currently executing: {{toolName}}"
}
```

中文：

```json
{
  "agent.idleTimeout.title": "Agent 无活动",
  "agent.idleTimeout.description": "Agent 已有 {{idleMinutes}} 分钟无活动（总执行时间 {{elapsedMinutes}} 分钟）。Agent 可能卡死。",
  "agent.idleTimeout.continueWaiting": "继续等待",
  "agent.idleTimeout.forceStop": "强制中断",
  "agent.elapsedTime": "Agent 已执行 {{minutes}} 分钟",
  "agent.currentTool": "正在执行：{{toolName}}"
}
```

### 服务端全局超时改为可配置

**文件：`packages/remote-agent-proxy/src/server.ts`**

`STREAM_GLOBAL_TIMEOUT_MS` 从硬编码改为从 `ChatOptions.globalTimeoutMs` 读取：

```typescript
// 之前
const STREAM_GLOBAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
globalTimer = setTimeout(() => { ... }, STREAM_GLOBAL_TIMEOUT_MS);

// 之后
const STREAM_GLOBAL_TIMEOUT_MS = options?.globalTimeoutMs ?? 2 * 60 * 60 * 1000;
if (STREAM_GLOBAL_TIMEOUT_MS > 0) {
  globalTimer = setTimeout(() => {
    // 先发送超时错误通知
    this.sendMessage(ws, {
      type: 'claude:error',
      sessionId,
      data: { error: `Stream global timeout (${Math.round(STREAM_GLOBAL_TIMEOUT_MS / 60000)} minutes)`, isGlobalTimeout: true }
    });
    this.claudeManager.forceAbortStreamIterator(sessionId)
  }, STREAM_GLOBAL_TIMEOUT_MS);
}
```

`globalTimeoutMs = 0` 表示无全局超时（用于超长任务）。

## 开发前必读

| 分类 | 文档 | 阅读目的 |
|------|------|----------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解远程 Agent 模块整体架构和组件职责 |
| 功能 design.md | `.project/modules/remote-agent/features/websocket-client/design.md` | 理解 WebSocket 客户端连接、心跳、流式消息机制 |
| 功能 changelog | `.project/modules/remote-agent/features/websocket-client/changelog.md` | 了解 WebSocket 客户端最近变更（双向心跳、空闲超时等） |
| 已有 PRD | `.project/prd/feature/remote-agent/feature-bidirectional-heartbeat-v1.md` | 理解现有双向心跳机制的实现细节，避免冲突 |
| 已有 PRD | `.project/prd/bugfix/remote/bugfix-remote-session-timeout-v1.md` | 理解当前超时机制的实现，这是本次改进的基础 |
| 源码文件 | `src/main/services/remote/ws/remote-ws-client.ts` | 核心修改目标：空闲超时逻辑改造、新增 idle:timeout 事件 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts` | 服务端：stream:alive 心跳、进程退出通知、全局超时可配置化 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | SDK 进程管理、sessionExitCallback 机制、transport.onExit |
| 源码文件 | `packages/remote-agent-proxy/src/types.ts` | 新增 StreamAliveData 接口、ChatOptions 扩展 |
| 源码文件 | `src/main/services/remote/ws/ws-types.ts` | 新增 stream:alive 消息类型 |
| 源码文件 | `src/main/services/agent/send-message-remote.ts` | 新增 stream:alive 和 idle:timeout 事件转发 |
| 源码文件 | `src/renderer/stores/chat.store.ts` | 前端状态管理：handleAgentStreamAlive、handleAgentIdleTimeout |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 常量化、i18n 规范 |

## 涉及文件

### 后端（远程 Agent Proxy）

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `packages/remote-agent-proxy/src/types.ts` | 修改 | 新增 `StreamAliveData` 接口；`ServerMessage.type` 新增 `'stream:alive'`；`ChatOptions` 新增 `timeoutMs`、`globalTimeoutMs` |
| `packages/remote-agent-proxy/src/server.ts` | 修改 | `handleClaudeChat()` 新增 `aliveTimer`（5 分钟 stream:alive 心跳）、`onToolCall` 跟踪当前工具名、注册 `sessionExitCallback`、全局超时可配置 + 提前通知 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | 新增 `sessionExitCallbacks` Map、`registerSessionExitCallback()`、`unregisterSessionExitCallback()` 方法；`registerSessionExitListener()` 调用处触发外部回调 |

### 后端（Electron 主进程）

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | `handleMessage()` 新增 `stream:alive` case；`sendChatWithStream()` 空闲超时改为 emit `idle:timeout` 事件（不再直接 reject）；新增 `pendingIdleTimeouts` Map、`continueIdleTimeout()`、`forceIdleTimeoutDisconnect()` 公共方法 |
| `src/main/services/remote/ws/ws-types.ts` | 修改 | `ServerMessage.type` 新增 `'stream:alive'` |
| `src/main/services/agent/send-message-remote.ts` | 修改 | 新增 `stream:alive` 和 `idle:timeout` 事件转发到渲染进程 |

### 前端

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/renderer/stores/chat.store.ts` | 修改 | SessionState 新增 `agentElapsedTime`、`agentCurrentTool`、`idleTimeout` 字段；新增 `handleAgentStreamAlive`、`handleAgentIdleTimeout`、`resolveIdleTimeout`、`forceIdleTimeout` 方法 |
| `src/renderer/components/chat/WorkerPanel.tsx` 或新建 `IdleTimeoutDialog.tsx` | 修改/新增 | Agent 执行时长显示；空闲超时警告弹窗 UI |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增超时相关 i18n 文案 |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增超时相关 i18n 文案 |
| 其他 5 个语言文件 | 修改 | 新增超时相关 i18n 文案 |

### IPC / Preload / API 层

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/shared/constants/` (IPC 通道常量) | 修改 | 新增 `REMOTE_CONTINUE_IDLE_TIMEOUT`、`REMOTE_FORCE_IDLE_TIMEOUT` 通道 |
| `src/preload/index.ts` | 修改 | 暴露新的 IPC 方法 |
| `src/renderer/api/transport.ts` | 修改 | 在 `methodMap` 中添加新通道映射 |
| `src/renderer/api/index.ts` | 修改 | 导出 `continueIdleTimeout`、`forceIdleTimeout` API 方法 |

## 验收标准

### 第一层：stream:alive 心跳

- [ ] 服务端每 5 分钟发送 `stream:alive` 消息，附带 `elapsedMs`、`currentToolName`、`currentToolElapsedMs`
- [ ] 客户端收到 `stream:alive` 后正确重置空闲计时器
- [ ] 前端显示 "Agent 已执行 XX 分钟" 和 "正在执行: {toolName}"
- [ ] 工具执行期间 `currentToolName` 正确显示，工具完成后清空
- [ ] stream 结束后 `aliveTimer` 被清理

### 第二层：进程存活检测

- [ ] SDK 子进程崩溃时，客户端在秒级收到 `claude:error` 通知（而非等 60 分钟）
- [ ] 错误消息包含 `isProcessDeath: true` 标志，前端可区分进程崩溃和普通错误
- [ ] 进程正常退出时也触发通知（非只有崩溃）
- [ ] `sessionExitCallback` 在 finally 块中被正确清理，无内存泄漏

### 第三层：超时警告

- [ ] 客户端空闲超时触发时不再直接 reject，改为 emit `idle:timeout` 事件
- [ ] 前端显示警告弹窗，提示 "XX 分钟无活动"，显示"继续等待"和"强制中断"按钮
- [ ] 点击"继续等待"后空闲计时器重置，Agent 继续执行
- [ ] 点击"强制中断"后 stream 被终止，前端恢复正常状态
- [ ] 10 分钟内用户未做决策时，自动继续等待（因为 `stream:alive` 可能在重置计时器）

### 全局超时可配置

- [ ] `ChatOptions.globalTimeoutMs` 可从客户端传入，默认仍为 2 小时
- [ ] `globalTimeoutMs = 0` 时无全局超时限制
- [ ] 全局超时触发时先发送 `claude:error` 通知客户端（而非静默 abort）

### 通用

- [ ] 现有功能不受影响：正常 stream、中断、重连、断连恢复
- [ ] `npm run typecheck && npm run build` 全部通过
- [ ] `npm run i18n` 提取和翻译无报错
- [ ] 超时相关文案在所有 7 种语言中正确显示
