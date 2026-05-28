# PRD [Feature] — 远程代理日志回传至本地

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-21 |
| 指令人 | @misakamikoto |
| 模块 | openai-compat-router / remote-agent-proxy / remote-ws |
| 状态 | draft |
| 优先级 | P0 |
| 影响范围 | 远程代理包 + 本地 WebSocket 客户端 |

## 需求分析

### 背景

用户反馈：使用远程服务器上的模型时，远程 agent proxy 的 OpenAI Compat Router 日志（请求头、IP、请求体大小等）只输出到远程服务器的 stdout，本地 AICO-Bot 日志中完全看不到这些信息，导致远程问题排查困难。

当前远程代理（`packages/remote-agent-proxy`）的 Express Router 和 Request Handler 已在上一轮 PRD（`feat-proxy-request-logging-v1.md`）中增强了日志输出，但这些日志仅通过 `console.log` 输出到远程服务器的终端。远程部署场景下，用户无法直接访问远程服务器终端，日志信息的断层使得问题定位变得困难。

### 问题清单

| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| 1 | 远程 `router.ts` 中间件 | 增强后的入站请求日志（IP、请求头、请求体大小）仅输出到远程 stdout | 本地完全不可见，无法排查远程请求问题 |
| 2 | 远程 `request-handler.ts` | apiType、target URL、model 等诊断信息仅输出到远程 stdout | 本地完全不可见，无法确认请求是否被正确路由 |
| 3 | 远程 server.ts | WebSocket 服务与 Express Router 完全隔离，无日志桥接机制 | Router 的日志无法通过已有的 WebSocket 通道传递给本地 |
| 4 | 本地 `ws-types.ts` | `ServerMessage.type` 联合中无 `'log'` 类型 | 即使远程发送日志消息，本地也无法识别和处理 |
| 5 | 本地 `remote-ws-client.ts` | `handleMessage()` switch 中无 `'log'` case | 收到未知类型只打印 `Unknown message type` |

### 预期效果

增强后，远程 Router 的关键请求日志应自动回传到本地 AICO-Bot 日志中。本地日志输出示例：

```
[agent:remote] [remote-log] [Router] POST /v1/messages from=192.168.1.100 content-type=application/json user-agent=claude-code/1.0 x-api-key=eyJhbGci... body=12.3KB
[agent:remote] [remote-log] [RequestHandler] apiType=chat_completions target=https://api.openai.com/v1/chat/completions model=gpt-4o
```

用户无需 SSH 登录远程服务器即可在本地日志中看到远程代理的诊断信息。

## 技术方案

### 核心策略

**通过 `onLog` 回调桥接 Router 日志到 WebSocket**

1. **不使用 EventEmitter**：直接在 `RouterOptions` 中添加 `onLog` 回调，比创建独立的 EventBus 更简单直接
2. **仅转发 Router 级别日志**：只转发入站请求详情（中间件日志）和请求处理入口日志（`handleMessagesRequest`），不转发高频的 heartbeat/keepalive
3. **断连静默丢弃**：WebSocket 断开时日志直接丢弃，不做缓存（避免内存泄漏和重连后日志风暴）
4. **脱敏数据传输**：回传的数据已在上一轮 PRD 中脱敏（`x-api-key` 前 8 字符、`authorization` 前 16 字符等），无需额外处理

### 方案详情

#### 1. 远程侧：`RouterOptions` 扩展 + `onLog` 回调

##### 1.1 扩展 `RouterOptions` 接口

在 `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` 中扩展：

```typescript
/** 远程日志条目 */
export interface LogEntry {
  /** 日志级别 */
  level: 'info' | 'warn' | 'error'
  /** 日志消息（已脱敏） */
  message: string
  /** 日志来源（用于本地侧过滤和归类） */
  source: 'router' | 'request-handler'
}

export interface RouterOptions {
  debug?: boolean
  timeoutMs?: number
  /** 日志回调：Router 中间件和 RequestHandler 调用此函数将日志回传给 WebSocket 层 */
  onLog?: (entry: LogEntry) => void
}
```

##### 1.2 `router.ts` 中间件调用 `onLog`

将现有中间件从纯 `console.log` 改为同时调用 `onLog`：

```typescript
export function createApp(options: RouterOptions = {}): Express {
  const app = express()
  const { debug = false, timeoutMs, onLog } = options

  // ... body parser 不变 ...

  // Request logging middleware
  app.use((req, _res, next) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
    const logMsg = `[Router] ${req.method} ${req.url} from=${clientIp} ${formatRemoteSanitizedHeaders(req)} body=${formatRemoteBodySize(req)}`
    console.log(logMsg)
    // 回传给 WebSocket 层
    onLog?.({ level: 'info', message: logMsg, source: 'router' })
    next()
  })

  // ... 后续路由不变 ...
}
```

##### 1.3 `request-handler.ts` 调用 `onLog`

将 `RequestHandlerOptions` 扩展，添加 `onLog` 回调：

```typescript
export interface RequestHandlerOptions {
  debug?: boolean
  timeoutMs?: number
  sdkHeaders?: Record<string, string>
  queryString?: string
  rawBody?: Buffer
  requestModified?: boolean
  /** 日志回调（透传自 RouterOptions） */
  onLog?: (entry: LogEntry) => void
}
```

在 `handleMessagesRequest` 入口处：

```typescript
export async function handleMessagesRequest(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions = {}
): Promise<void> {
  const { url: backendUrl, apiType: configApiType } = config
  const { onLog } = options

  const logMsg = `[RequestHandler] handleMessagesRequest apiType=${configApiType} target=${backendUrl} model=${anthropicRequest.model}`
  console.log(logMsg)
  onLog?.({ level: 'info', message: logMsg, source: 'request-handler' })

  // ... 后续逻辑不变 ...
}
```

##### 1.4 透传 `onLog` 到 `handleMessagesRequest`

在 `router.ts` 的 `/v1/messages` 路由中：

```typescript
await handleMessagesRequest(anthropicRequest, decodedConfig, res, {
  debug, timeoutMs, sdkHeaders, queryString, rawBody,
  onLog  // 透传 onLog 回调
})
```

#### 2. 远程侧：类型定义

在 `packages/remote-agent-proxy/src/types.ts` 的 `ServerMessage.type` 联合中添加 `'log'`：

```typescript
export interface ServerMessage {
  type: 'auth:success' | 'auth:failed' |
         // ... 现有类型 ...
         'log' |  // 远程日志回传
         'stream:alive'
  sessionId?: string
  generationId?: string
  data?: any
}
```

`data` 字段承载 `LogEntry` 结构：

```typescript
{
  level: 'info' | 'warn' | 'error'
  message: string
  source: 'router' | 'request-handler'
}
```

#### 3. 远程侧：`server.ts` 接入 `onLog` 并转发 WebSocket

##### 3.1 创建 Express App 时传入 `onLog`

在 `RemoteAgentServer` 中，当 OpenAI Compat Router 被使用时（通过 `createApp` 创建），需要将 `onLog` 回调传入。但当前 `server.ts` 并未直接创建 Express App — Router 是由入口文件（`index.ts` 或 `openai-compat-router/index.ts`）独立创建的。

**核心设计决策**：`onLog` 回调需要在 Router 创建时传入，而 Router 的创建位于入口文件。`server.ts` 作为 WebSocket 服务，需要暴露一个回调注册接口。

**方案**：在 `RemoteAgentServer` 类上添加一个静态/实例方法，供入口文件注册 `onLog` 回调：

```typescript
// server.ts — RemoteAgentServer 类内新增
private logCallback: ((entry: { level: string; message: string; source: string }) => void) | null = null

/**
 * 注册日志回调，由入口文件在创建 Express App 时调用。
 * 回调将日志条目转发给所有已连接的、已认证的 WebSocket 客户端。
 */
setOnLogCallback(callback: (entry: { level: string; message: string; source: string }) => void): void {
  this.logCallback = callback
}

/**
 * 向所有已连接的、已认证的 WebSocket 客户端广播日志消息。
 * 使用 broadcastToAllClients 确保所有连接都能收到。
 * WebSocket 断开时静默丢弃（broadcastToAllClients 内部已处理）。
 */
private forwardLogToClients(entry: { level: string; message: string; source: string }): void {
  this.broadcastToAllClients({
    type: 'log',
    data: entry
  })
}
```

然后在 `setOnLogCallback` 中包装回调：

```typescript
setOnLogCallback(callback: (entry: { level: string; message: string; source: string }) => void): void {
  this.logCallback = (entry) => {
    callback(entry)  // 先调用原始回调（如果有其他订阅者）
    this.forwardLogToClients(entry)  // 再转发给 WebSocket 客户端
  }
}
```

##### 3.2 入口文件注册回调

在 `packages/remote-agent-proxy/src/index.ts`（或 `openai-compat-router/index.ts`，具体取决于 Router 的创建位置）中：

```typescript
import { createApp, type LogEntry } from './openai-compat-router/server/router.js'
import { RemoteAgentServer } from './server.js'

// 创建 WebSocket 服务
const wsServer = new RemoteAgentServer(config)

// 创建 Express App，传入 onLog 回调
const app = createApp({
  debug: true,
  onLog: (entry: LogEntry) => {
    wsServer.forwardLogToClients(entry)
  }
})
```

**注意**：`forwardLogToClients` 需要从 `private` 改为 `public`，或者使用 `setOnLogCallback` 方法。推荐直接暴露 `forwardLogToClients` 为 public 方法，更简洁。

##### 3.3 节流保护

为防止日志洪泛（大量并发请求时），添加简易节流：

```typescript
private lastLogForwardAt = 0
private static readonly LOG_THROTTLE_MS = 100 // 最少 100ms 间隔

private forwardLogToClients(entry: { level: string; message: string; source: string }): void {
  // error/warn 级别不节流
  if (entry.level !== 'error' && entry.level !== 'warn') {
    const now = Date.now()
    if (now - this.lastLogForwardAt < RemoteAgentServer.LOG_THROTTLE_MS) {
      return // 丢弃（仍是 info 级别，不影响功能）
    }
    this.lastLogForwardAt = now
  }
  this.broadcastToAllClients({ type: 'log', data: entry })
}
```

#### 4. 本地侧：类型定义

在 `src/main/services/remote/ws/ws-types.ts` 的 `ServerMessage.type` 联合中添加 `'log'`：

```typescript
export interface ServerMessage {
  type:
    | 'auth:success'
    | 'auth:failed'
    // ... 现有类型 ...
    | 'stream:alive'
    | 'log'  // 远程日志回传
  sessionId?: string;
  generationId?: string;
  data?: any;
}
```

#### 5. 本地侧：消息处理

在 `src/main/services/remote/ws/remote-ws-client.ts` 的 `handleMessage()` switch 中添加 `'log'` case：

```typescript
case 'log':
  // 远程代理日志回传，emit 给消费者
  this.emit('log', { data: message.data });
  break;
```

注意：`log` 事件**不放入 `blockedTypes` 列表**（interrupted session 过滤列表）。日志是服务器级别的诊断信息，不属于特定会话的事件流，不应被中断逻辑过滤。

#### 6. 本地侧：事件消费

在 `src/main/services/agent/send-message-remote.ts` 中通过 `addHandler` 接收远程日志：

```typescript
// 接收远程代理日志回传
addHandler('log', (data) => {
  const entry = data.data
  if (!entry) return
  const level = entry.level || 'info'
  const source = entry.source || 'unknown'
  const message = entry.message || ''
  // 使用 [remote-log] 前缀便于本地日志中识别来源
  const prefix = `[remote-log] [${source}]`
  if (level === 'error') {
    log.error(`${prefix} ${message}`)
  } else if (level === 'warn') {
    log.warn(`${prefix} ${message}`)
  } else {
    log.info(`${prefix} ${message}`)
  }
})
```

### 数据流

```
远程 Express Router (router.ts 中间件)
  │ onLog({ level, message, source })
  ▼
远程 server.ts (forwardLogToClients)
  │ broadcastToAllClients({ type: 'log', data: entry })
  ▼
WebSocket 消息
  │ { type: 'log', data: { level, message, source } }
  ▼
本地 remote-ws-client.ts (handleMessage)
  │ this.emit('log', { data })
  ▼
本地 send-message-remote.ts (addHandler)
  │ log.info('[remote-log] [router] ...')
  ▼
本地 AICO-Bot 日志输出
```

### 断连处理

- **WebSocket 已连接**：日志正常转发
- **WebSocket 未连接**：`broadcastToAllClients` 遍历 clients Map，如果没有已连接的客户端，循环不执行，日志静默丢弃
- **WebSocket 发送失败**：`sendMessage` 内部已有 try/catch，失败时仅 `console.error`，不影响 Router 正常工作
- **重连后**：不会补发断连期间的日志（无缓存），这是设计预期

### 带宽评估

- 单条日志约 200-300 字节（JSON 序列化后）
- 节流间隔 100ms → 最高 10 条/秒 → 约 2-3 KB/s
- WebSocket 帧有 perMessageDeflate 压缩（threshold=1024），实际带宽更低
- 对现有流式响应（thought delta、tool call 等）的带宽影响可忽略

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/openai-compat-router/openai-compat-router-v1.md` | 理解路由器架构和 Express Router 与 WebSocket 服务的隔离关系 |
| 2 | `.project/prd/feature/logging/feat-proxy-request-logging-v1.md` | 上一轮 PRD，了解已增强的日志内容和脱敏规则 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `packages/remote-agent-proxy/src/types.ts` | ServerMessage 类型联合定义，需添加 `'log'` |
| 2 | `packages/remote-agent-proxy/src/server.ts` | WebSocket 服务核心类，需添加 `forwardLogToClients` 方法；重点理解 `broadcastToAllClients`、`sendEvent` 的实现 |
| 3 | `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` | Express Router 创建函数，需扩展 `RouterOptions` 接口添加 `onLog` 并在中中间件中调用 |
| 4 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 请求处理器，需扩展 `RequestHandlerOptions` 添加 `onLog` 并在入口日志中调用 |
| 5 | `packages/remote-agent-proxy/src/index.ts` | 入口文件，需在创建 Express App 时传入 `onLog` 回调并连接到 WebSocket 服务 |
| 6 | `src/main/services/remote/ws/ws-types.ts` | 本地 ServerMessage 类型联合定义，需添加 `'log'` |
| 7 | `src/main/services/remote/ws/remote-ws-client.ts` | 本地 WebSocket 客户端，需在 `handleMessage` switch 中添加 `'log'` case |
| 8 | `src/main/services/agent/send-message-remote.ts` | 本地远程消息处理，需通过 `addHandler('log', ...)` 接收并记录远程日志 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | TypeScript strict、import type、接口命名等规范 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` | 修改 | 扩展 `RouterOptions` 添加 `onLog`；中间件和路由中调用 `onLog`；导出 `LogEntry` 类型 |
| 2 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 修改 | 扩展 `RequestHandlerOptions` 添加 `onLog`；入口日志中调用 `onLog` |
| 3 | `packages/remote-agent-proxy/src/types.ts` | 修改 | `ServerMessage.type` 联合添加 `'log'` |
| 4 | `packages/remote-agent-proxy/src/server.ts` | 修改 | 添加 `forwardLogToClients` public 方法（含节流） |
| 5 | `packages/remote-agent-proxy/src/index.ts` | 修改 | 创建 Express App 时传入 `onLog` 回调，连接到 `server.forwardLogToClients` |
| 6 | `src/main/services/remote/ws/ws-types.ts` | 修改 | `ServerMessage.type` 联合添加 `'log'` |
| 7 | `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | `handleMessage` switch 添加 `'log'` case，emit `'log'` 事件 |
| 8 | `src/main/services/agent/send-message-remote.ts` | 修改 | 通过 `addHandler('log', ...)` 接收远程日志，使用 `createLogger('agent:remote')` 记录 |

## 验收标准

### 远程侧日志生成

- [ ] `router.ts` 中间件在记录入站请求日志时同时调用 `onLog` 回调
- [ ] `request-handler.ts` 在记录 apiType/target/model 日志时同时调用 `onLog` 回调
- [ ] `onLog` 回调的 `LogEntry` 包含 `level`、`message`、`source` 三个字段
- [ ] 日志消息中敏感信息已脱敏（x-api-key 前 8 字符、authorization 前 16 字符）— 由上一轮 PRD 保证

### 远程侧 WebSocket 转发

- [ ] `server.ts` 提供 `forwardLogToClients` public 方法
- [ ] `forwardLogToClients` 通过 `broadcastToAllClients` 向所有已连接客户端发送 `{ type: 'log', data: entry }`
- [ ] `forwardLogToClients` 对 `info` 级别日志有 100ms 节流保护
- [ ] `error`/`warn` 级别日志不受节流限制
- [ ] 入口文件（`index.ts`）在创建 Express App 时正确传入 `onLog` 回调

### 本地侧消息处理

- [ ] `ws-types.ts` 的 `ServerMessage.type` 包含 `'log'`
- [ ] `remote-ws-client.ts` 的 `handleMessage` 正确处理 `'log'` 类型并 emit `'log'` 事件
- [ ] `log` 事件不被 interrupted session 过滤逻辑拦截

### 本地侧日志消费

- [ ] `send-message-remote.ts` 通过 `addHandler('log', ...)` 接收远程日志
- [ ] 远程日志在本地以 `[remote-log] [source] message` 格式输出
- [ ] `error` 级别日志使用 `log.error()`，`warn` 使用 `log.warn()`，`info` 使用 `log.info()`

### 断连与健壮性

- [ ] WebSocket 无客户端连接时，日志静默丢弃（不报错、不堆积）
- [ ] WebSocket 发送失败时不影响 Router 正常请求处理
- [ ] 重连后不会补发断连期间的日志

### 质量保障

- [ ] `npm run typecheck && npm run build` 通过
- [ ] 不影响现有 WebSocket 消息的处理流程
- [ ] 不引入新的依赖

## 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-05-21 | 初稿 |
