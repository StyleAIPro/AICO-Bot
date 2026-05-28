# PRD -- Bugfix: 远程 Agent 同一会话长任务超时处理

> 版本：bugfix-remote-session-timeout-v1
> 日期：2026-05-13
> 状态：in-progress
> 指令人：@mi-saka
> 优先级：P1
> 影响范围：全栈（前端 + 后端 `packages/remote-agent-proxy/` + 主进程 `src/main/`）
> 类型：bugfix

## 问题描述

### 现象

在远程服务器上使用 Claude Code Agent 时，同一会话中的任务如果执行时间过长，会导致前端显示明确的超时错误提示，用户无法继续使用该会话。

### 触发条件

1. 用户在远程服务器上创建一个会话，执行任务
2. 在同一会话中发送后续消息时，远程 Agent 执行的工具调用耗时过长（如大型代码分析、长时间编译、Docker 拉取镜像等）
3. 前端收到超时错误，显示明确的错误提示

### 影响范围

- 远程 Agent 用户的正常使用体验
- 长时间运行的自动化任务（如 CI/CD、代码审计、大型重构）
- 同一会话的多轮对话连续性

## 根因分析

通过代码分析，远程会话超时涉及多个层面的超时机制，各层之间存在不一致：

### 1. WebSocket 客户端空闲超时（主进程端）

**文件**：`src/main/services/remote/ws/remote-ws-client.ts`

```typescript
// sendChatWithStream() 中的空闲超时
const IDLE_TIMEOUT_MS = options.timeoutMs || 30 * 60 * 1000; // 默认 30 分钟
const CHECK_INTERVAL_MS = 60 * 1000; // 每 60 秒检查一次
```

- `sendChatWithStream` 设置了 30 分钟的空闲超时
- 只有 `claude:stream`、`thought`、`thought:delta`、`terminal:output` 事件会重置空闲计时器
- 但长时间运行的工具调用（如 `Bash` 执行大命令）期间，SDK 可能不会发送任何中间事件
- 工具调用本身有 `tool:call` 事件，但工具**执行过程中**没有事件产出，因此不会重置超时
- `tool:result` 事件到来时才重置，但如果工具执行超过 30 分钟，会触发超时

### 2. WebSocket 心跳超时（双向）

**文件**：
- 客户端：`remote-ws-client.ts` — `pongTimeoutMs = 90 * 1000`（90 秒）
- 服务端：`packages/remote-agent-proxy/src/server.ts` — `HEARTBEAT_TIMEOUT_MS = 90 * 1000`（90 秒）

心跳超时 90 秒，与空闲超时无关（心跳走独立的 ping/pong 通道），不会直接导致任务超时。

### 3. 服务端 SDK 会话空闲超时

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

```typescript
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2 小时
```

- 服务端的 SDK 会话空闲超时为 2 小时
- 但这是**会话级别**的空闲，与单次请求超时无关
- 当前**没有**单次请求/单次 stream 的超时保护

### 4. 服务端 SDK API 超时

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

```typescript
options.env.API_TIMEOUT_MS = '3000000' // 50 分钟
```

- API 超时设为 50 分钟，通过环境变量传递给 SDK 子进程
- 这个值合理，但**客户端的 30 分钟空闲超时比它短**
- 如果 SDK 的单次 API 调用（如 extended thinking 或大型工具调用）耗时超过 30 分钟但不足 50 分钟，客户端会先超时断开

### 5. 首事件超时（仅限被中断的会话）

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

```typescript
private static readonly FIRST_EVENT_TIMEOUT_MS = 30_000 // 30 秒
```

- 仅在被中断过的会话重用时才生效（`sessionInfo?.interrupted` 检查）
- 检测会话损坏（中断后 stream 卡死），不是通用超时

### 6. 前端错误展示

**文件**：`src/renderer/stores/chat.store.ts`

```typescript
handleAgentError: (data) => {
  // 设置 session.error = error, isGenerating = false, isStreaming = false
  // 添加 error thought 到 thoughts 数组
}
```

- 前端的 `handleAgentError` 正确处理了错误展示
- 超时错误消息 "Chat timeout - no activity for 30 minutes" 会被直接展示给用户
- 但错误消息是英文的，且没有提供恢复建议

### 根因总结

| 层级 | 超时值 | 问题 |
|------|--------|------|
| 客户端空闲超时 | 30 分钟 | 工具执行期间无事件，不重置超时 |
| 服务端 API 超时 | 50 分钟 | 比客户端空闲超时长，客户端先超时 |
| 服务端会话空闲 | 2 小时 | 不影响单次请求超时 |
| 首事件超时 | 30 秒 | 仅限被中断会话，非通用 |

**核心问题**：客户端 30 分钟空闲超时在长时间工具执行期间被触发，因为工具执行过程中没有中间事件来重置计时器。服务端 SDK 可能在正常工作（工具执行中），但客户端已因"无活动"而超时。

## 技术方案

### 方案概述

在三个层面增加超时保护，确保长时间任务不会误超时，同时保留真正的超时检测能力：

1. **客户端层**：增加 `tool:call` 事件对空闲超时的重置能力，并提高默认空闲超时
2. **服务端层**：增加单次 stream 全局超时，防止 SDK 无限挂起
3. **前端层**：优化超时错误提示，提供恢复建议

### 1. 客户端层修改（`src/main/services/remote/ws/remote-ws-client.ts`）

#### 1.1 `tool:call` 事件重置空闲超时

在 `sendChatWithStream()` 中，添加 `tool:call` 和 `tool:result` 事件监听，用于重置空闲计时器：

```typescript
// 当前只监听了 claude:stream, thought, thought:delta, terminal:output
// 需要额外添加：
this.on('tool:call', toolActivityHandler);
this.on('tool:result', toolActivityHandler);
```

这样，当远程 Agent 开始执行工具（`tool:call`）或工具返回结果（`tool:result`）时，空闲计时器会被重置。

#### 1.2 提高默认空闲超时

将默认空闲超时从 30 分钟提高到 60 分钟，与服务端 API 超时（50 分钟）保持协调：

```typescript
// 之前
const IDLE_TIMEOUT_MS = options.timeoutMs || 30 * 60 * 1000;
// 之后
const IDLE_TIMEOUT_MS = options.timeoutMs || 60 * 60 * 1000; // 60 分钟
```

### 2. 服务端层修改（`packages/remote-agent-proxy/src/server.ts`）

#### 2.1 增加 stream 全局超时

在 `handleClaudeChat()` 的 stream 循环外层添加全局超时保护：

```typescript
// 在 for await 循环之前设置全局超时
const STREAM_GLOBAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 小时绝对上限
const globalTimer = setTimeout(() => {
  // 发送超时错误到客户端
  this.sendMessage(ws, {
    type: 'claude:error',
    sessionId,
    data: { error: 'Stream global timeout (2 hours) - task may be stuck' }
  });
  // 中断 stream
  this.claudeManager.forceAbortStreamIterator(sessionId);
}, STREAM_GLOBAL_TIMEOUT_MS);
```

#### 2.2 在 `sendChatWithStream` 的 timeout reject 中发送结构化错误

修改客户端超时 reject 消息，使其包含结构化信息以便前端区分超时类型：

```typescript
reject(new Error(
  `Chat timeout - no activity for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes`
));
```

### 3. 前端层修改（`src/renderer/stores/chat.store.ts`）

#### 3.1 超时错误 i18n 化

在 `handleAgentError` 中识别超时错误，使用国际化的错误提示：

```typescript
// 检测超时错误
const isTimeoutError = error.includes('timeout') || error.includes('超时');
const displayError = isTimeoutError
  ? t('agent.error.remoteTimeout', { minutes: '30' }) // "远程任务超时：{{minutes}} 分钟无活动。请检查远程服务器状态后重试。"
  : error;
```

#### 3.2 超时错误显示恢复建议

对于超时错误，在 error thought 中附带恢复建议：
- 提示用户检查远程服务器状态
- 建议用户发送新消息继续对话（会话上下文已保留）

## 开发前必读

| 分类 | 文档 | 阅读目的 |
|------|------|----------|
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解远程 Agent 模块整体架构和组件职责 |
| 模块设计文档 | `.project/modules/remote-agent/features/websocket-client/design.md` | 理解 WebSocket 客户端连接、心跳、流式消息机制 |
| 功能 changelog | `.project/modules/remote-agent/features/websocket-client/changelog.md` | 了解 WebSocket 客户端最近变更（双向心跳、连接池联动等） |
| 源码文件 | `src/main/services/remote/ws/remote-ws-client.ts` | 核心修改目标：空闲超时逻辑和 tool:call 事件处理 |
| 源码文件 | `src/main/services/agent/send-message-remote.ts` | 理解远程消息发送流程和事件注册 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts` | 服务端消息处理和 stream 全局超时添加位置 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 理解 SDK 会话管理和 API 超时配置 |
| 源码文件 | `src/renderer/stores/chat.store.ts` | 前端错误处理和超时提示优化 |
| 源码文件 | `src/main/services/remote/ws/ws-types.ts` | WebSocket 消息类型定义 |
| 已有 PRD | `.project/prd/bugfix/remote/bugfix-interrupted-session-lock-v1.md` | 参考同类远程 bugfix 的解决方案 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 常量化、i18n 规范 |

## 涉及文件

### 后端（主进程）

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | `sendChatWithStream()` 增加 tool:call/tool:result 事件重置超时、默认超时从 30 分钟提高到 60 分钟 |

### 后端（远程 Agent Proxy）

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `packages/remote-agent-proxy/src/server.ts` | 修改 | `handleClaudeChat()` 增加 2 小时 stream 全局超时保护 |

### 前端

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/renderer/stores/chat.store.ts` | 修改 | `handleAgentError()` 超时错误识别和 i18n 化提示 |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增超时错误英文提示文案 |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增超时错误中文提示文案 |

## 验收标准

- [ ] **基础功能**：远程会话中执行超过 30 分钟的工具调用任务，不再出现误超时
- [ ] **空闲检测**：远程 Agent 真正无响应（进程崩溃、网络断开）时，仍能在超时后正确报错
- [ ] **超时重置**：工具调用开始（`tool:call`）和工具返回结果（`tool:result`）时，空闲计时器正确重置
- [ ] **服务端全局超时**：stream 全局超时（2 小时）在极端情况下生效，发送 `claude:error` 到客户端
- [ ] **前端提示**：超时错误显示中文国际化提示，包含恢复建议（检查服务器状态、重新发送消息）
- [ ] **多语言**：超时错误提示在所有 7 种语言中正确显示
- [ ] **构建通过**：`npm run typecheck && npm run build` 全部通过
- [ ] **国际化**：`npm run i18n` 提取和翻译无报错
