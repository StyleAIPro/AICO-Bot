# PRD [Bug 修复级] — 远程 Agent Proxy 日志可读性优化

> 版本：bugfix-remote-log-readability-v1
> 日期：2026-05-21
> 指令人：@misakamikoto
> 反馈人：用户反馈
> 归属模块：packages/remote-agent-proxy
> 严重程度：P0（日志洪泛）/ P1（无时间戳）/ P1（前缀不统一）/ P2（关键信息缺失）
> 状态：draft

## 问题描述

远程 Agent Proxy 的日志存储在 `/opt/claude-deployment-client-<编号>/` 下，用户查看日志时发现可读性极差。一个简单的对话回复会产生 50+ 行原始 JSON 日志，难以快速定位问题。

### 真实日志示例（用户提供的）

```
[RemoteAgentServer] SDK session resumption: new session
[RemoteAgentServer] Processing chat with 2 messages for session a9fcb6bb-a115-48ca-b761-8d9431c44551
[RemoteAgentServer] Starting stream for session a9fcb6bb-a115-48ca-b761-8d9431c44551
[ClaudeManager] streamChat called with options.workDir=/home/pzy, this.workDir=/root
[ClaudeManager] streamChat called with resumeSessionId=undefined, maxThinkingTokens=undefined
[ClaudeManager] Creating aico-bot-builtin MCP server (WebSocket bridge) with 8 tools from AICO-Bot client
[DIAG][a9fcb6bb-a115-48ca-b761-8d9431c44551] canUseTool callback: function, hasPermissionRequest=true, hasAskUserQuestion=true
[DIAG][a9fcb6bb-a115-48ca-b761-8d9431c44551] Creating NEW session...
[ClaudeManager][a9fcb6bb-a115-48ca-b761-8d9431c44551] Creating new V2 session with workDir=/home/pzy...
...（大量 V2 session 创建日志）
[ClaudeManager] Event 1: type=system {"type":"system","subtype":"init","cwd":"/home/pzy","session_id":"...","tools":["Task","AskUserQuestion","Bash",...]}
[ClaudeManager] System thought: Connected | Model: glm-5.1
[ClaudeManager] Event 2: type=stream_event {"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_...","type":"message","role":"assistant","model":"glm-5.1","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}},"session_id":"...","parent_tool_use_id":null,"uuid":"..."}
[ClaudeManager] Event 3: type=stream_event {"type":"stream_event","event":{"type":"content_block_start",...}}
[ClaudeManager] Event 4: type=stream_event {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}},...}
[ClaudeManager] Text delta: 你好...
[ClaudeManager] Event 5: type=stream_event {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"！"}},...}
[ClaudeManager] Text delta: ！...
（重复 50+ 次，每个字一个 Event + 一个 Text delta）
...
[ClaudeManager] Event 50: type=stream_event ...
[ClaudeManager] Token usage: input=23054, output=148, cache_read=4416, cache_create=0
[ClaudeManager][a9fcb6bb-a115-48ca-b761-8d9431c44551] Stream wrapper cleanup complete
[RemoteAgentServer] Stream completed for session a9fcb6bb-a115-48ca-b761-8d9431c44551
[RemoteAgentServer] Chat completed for session a9fcb6bb-a115-48ca-b761-8d9431c44551
```

## 问题分析

### P0 — 流式事件日志洪泛（最大噪音源）

| # | 问题 | 影响 |
|---|------|------|
| 1 | `claude-manager.ts` 第 2058 行：每个 stream_event 都打印完整 JSON（前 50 个事件） | 一个简单回复产生 50+ 行原始 JSON，日志文件迅速膨胀 |
| 2 | `claude-manager.ts` 第 2279 行：`Text delta` 每个 token 打印一行 | 与上面的 JSON 事件重复，双倍噪音 |
| 3 | `claude-manager.ts` 第 2501 行：`system` init 日志后紧跟完整 tools 列表 JSON（第 2528 行） | 单行超长（含 30+ 个工具名） |

### P1 — 缺少时间戳

| # | 问题 | 影响 |
|---|------|------|
| 1 | 所有日志行没有时间戳（直接使用 `console.log`） | 无法判断请求耗时、事件间隔、问题发生时间 |
| 2 | 无法从日志推断性能瓶颈 | 不知道 session 创建、首个 token、完成分别花了多久 |

### P1 — 前缀不统一

| # | 问题 | 影响 |
|---|------|------|
| 1 | `[RemoteAgentServer]`、`[ClaudeManager]`、`[ClaudeManager][sessionId]`、`[DIAG][sessionId]` 四种前缀混用 | 日志难以 grep 和过滤 |
| 2 | `[DIAG]` 前缀含义不清 | 诊断级别不明确 |

### P2 — 关键信息缺失

| # | 问题 | 影响 |
|---|------|------|
| 1 | `Processing chat` 不包含客户端 IP | 无法判断请求来源 |
| 2 | `Chat completed` 不包含 token 用量摘要和总耗时 | 需要翻找前面的日志才能看到 |

## 技术方案

### 核心策略

1. **创建简易远程 logger**：在 `packages/remote-agent-proxy/src/` 中创建 `logger.ts`，提供带时间戳的分级日志输出
2. **降级流式事件日志**：`stream_event` 类型只记录事件类型名（不记录完整 JSON），降级为 debug 级别；`Text delta` 降级为 debug 级别
3. **保留关键摘要日志**：session 创建（含耗时）、token 用量、首次响应时间、错误保留在 info 级别
4. **统一前缀**：所有日志使用 `[Server]` / `[ClaudeMgr]` 两个 scope，sessionId 缩写为前 8 位
5. **添加关键信息**：客户端 IP 加入 chat/session 日志，chat completed 加入总耗时

### 方案详情

#### 1. 远程 logger 工具 (`packages/remote-agent-proxy/src/logger.ts`) — 新建

```typescript
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function formatMsg(level: string, scope: string, msg: string): string {
  return `${timestamp()} [${level}] [${scope}] ${msg}`
}

export const log = {
  info(scope: string, msg: string) { if (shouldLog('info')) console.log(formatMsg('INFO', scope, msg)) },
  warn(scope: string, msg: string) { if (shouldLog('warn')) console.warn(formatMsg('WARN', scope, msg)) },
  error(scope: string, msg: string) { if (shouldLog('error')) console.error(formatMsg('ERROR', scope, msg)) },
  debug(scope: string, msg: string) { if (shouldLog('debug')) console.log(formatMsg('DEBUG', scope, msg)) },
}

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 }
function shouldLog(level: string): boolean {
  return (LEVEL_ORDER[level as keyof typeof LEVEL_ORDER] ?? 1) >= (LEVEL_ORDER[LOG_LEVEL as keyof typeof LEVEL_ORDER] ?? 1)
}

/** 缩写 UUID（取前 8 位） */
export function shortId(id?: string): string {
  return id ? id.substring(0, 8) : '???????'
}

export const SCOPE = {
  SERVER: 'Server',
  CLAUDE_MGR: 'ClaudeMgr',
  MCP: 'MCP',
  DIAG: 'DIAG',
} as const
```

输出格式：`2026-05-21 15:45:58 [INFO] [Server] Processing chat with 2 messages`

#### 2. `claude-manager.ts` 改动

**2.1 Event 日志降级（第 2057-2060 行）**

现有代码：
```typescript
// Log ALL events for debugging (first 50 events)
if (eventCount <= 50) {
  console.log(`[ClaudeManager] Event ${eventCount}: type=${evt.type}`, JSON.stringify(evt).substring(0, 500))
}
```

改为：
```typescript
if (log.shouldLog('debug')) {
  log.debug(SCOPE.CLAUDE_MGR, `[${shortId(sessionId)}] Event ${eventCount}: type=${evt.type}`)
}
```

**2.2 Text delta 降级（第 2276-2282 行）**

现有代码：
```typescript
textCount++
if (textCount <= 5) {
  console.log(`[ClaudeManager] Text delta: ${text.substring(0, 50)}...`)
}
```

改为：
```typescript
textCount++
if (textCount === 1) {
  log.debug(SCOPE.CLAUDE_MGR, `[${shortId(sessionId)}] Text streaming started`)
}
```

**2.3 System init 日志精简（第 2493-2501 行附近）**

现有代码：
```typescript
console.log(`[ClaudeManager] System thought: ${systemThought.content}`)
// ...后面还有完整 JSON 输出
console.log(`[ClaudeManager] MCP servers: ${JSON.stringify(mcpServers)}`)
```

改为：
```typescript
log.info(SCOPE.CLAUDE_MGR, `System: Connected | Model: ${modelName} | Tools: ${toolsCount}`)
log.debug(SCOPE.CLAUDE_MGR, `MCP servers: ${mcpServers.map(s => `${s.name}(${s.status})`).join(', ')}`)
```

**2.4 其他日志迁移**

将 `claude-manager.ts` 中所有 `console.log/warn/error` 替换为 `log.info/warn/error`，统一使用 `SCOPE.CLAUDE_MGR`。sessionId 统一用 `shortId()` 缩写为前 8 位。

**2.5 新增首字响应时间追踪**

在 stream 循环开始时记录 `streamStartTime`，在第一个 `content_block_delta`（text_delta）时记录 `firstTokenTime`，在 stream 结束时输出：

```
log.info(SCOPE.CLAUDE_MGR, `First response in ${(firstTokenTime - streamStartTime) / 1000}s`)
```

#### 3. `server.ts` 改动

**3.1 添加客户端 IP**

在 WebSocket connection 事件中获取客户端 IP（`req.socket.remoteAddress`），存入 client state。在 `Processing chat` 和 `Chat completed` 日志中加入 IP。

**3.2 Chat completed 添加耗时**

在 `handleClaudeChat` 方法中，已有 `streamStartTime`（第 744 行），在 Chat completed 时输出：

```typescript
const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1)
log.info(SCOPE.SERVER, `Chat completed for session ${shortId(sessionId)} from ${clientIp} (${elapsed}s)`)
```

**3.3 所有日志迁移**

将 `server.ts` 中所有 `console.log/warn/error` 替换为 `log.*`，统一使用 `SCOPE.SERVER`。

#### 4. `index.ts` 改动

将启动日志（Configuration loaded、Migration 等）迁移到 `log.info`，使用 `SCOPE.SERVER`。

### 优化后日志示例（info 级别）

```
2026-05-21 15:45:58 [INFO] [Server] Client connected from 192.168.1.100
2026-05-21 15:45:58 [INFO] [Server] Processing chat with 2 messages for session a9fcb6bb
2026-05-21 15:45:58 [INFO] [ClaudeMgr] streamChat: model=glm-5.1, workDir=/home/pzy
2026-05-21 15:45:59 [INFO] [ClaudeMgr] V2 session created (5ms), PID: unavailable
2026-05-21 15:45:59 [INFO] [ClaudeMgr] System: Connected | Model: glm-5.1 | Tools: 36
2026-05-21 15:46:00 [INFO] [ClaudeMgr] First response in 1.2s
2026-05-21 15:46:05 [INFO] [ClaudeMgr] Token usage: input=23054, output=148, cache_read=4416
2026-05-21 15:46:05 [INFO] [Server] Chat completed for session a9fcb6bb from 192.168.1.100 (7.0s)
```

（`LOG_LEVEL=debug` 时才会显示每个 stream_event 类型和 MCP servers 详情）

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 定位所有 console.log 调用点（约 100+ 处），理解 stream 事件循环逻辑 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts` | 定位所有 console.log 调用点，理解 WebSocket 连接和 chat 处理流程 |
| 源码文件 | `packages/remote-agent-proxy/src/index.ts` | 理解启动日志流程 |
| 源码文件 | `packages/remote-agent-proxy/src/types.ts` | 理解类型定义 |

## 涉及文件

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `packages/remote-agent-proxy/src/logger.ts` | **新建** | 远程日志工具：带时间戳、分级、统一前缀 |
| 2 | `packages/remote-agent-proxy/src/claude-manager.ts` | **修改** | 所有 console.log 迁移到 log.*；stream_event 日志降级为 debug；Text delta 降级为 debug；system init 精简；新增首字响应时间 |
| 3 | `packages/remote-agent-proxy/src/server.ts` | **修改** | 所有 console.log 迁移到 log.*；添加客户端 IP；chat completed 添加耗时 |
| 4 | `packages/remote-agent-proxy/src/index.ts` | **修改** | 启动日志迁移到 log.* |

## 验收标准

- [ ] 新建 `logger.ts`，导出 `log`（info/warn/error/debug）和 `shortId()` 工具函数
- [ ] `log.info/warn/error/debug` 输出格式为 `YYYY-MM-DD HH:MM:SS [LEVEL] [SCOPE] message`
- [ ] 通过 `LOG_LEVEL` 环境变量控制日志级别（默认 `info`）
- [ ] `claude-manager.ts` 中所有 `console.log/warn/error` 迁移到 `log.*`
- [ ] `server.ts` 中所有 `console.log/warn/error` 迁移到 `log.*`
- [ ] `index.ts` 中所有 `console.log/warn/error` 迁移到 `log.*`
- [ ] stream_event 完整 JSON 日志降级为 debug 级别（info 级别只记录事件类型名）
- [ ] Text delta 日志降级为 debug 级别（info 级别只在首个 delta 时输出一行）
- [ ] system init 日志精简为 `System: Connected | Model: <model> | Tools: <N>`，完整 MCP servers 列表降为 debug
- [ ] `Processing chat` 日志包含客户端 IP
- [ ] `Chat completed` 日志包含总耗时（秒）和客户端 IP
- [ ] 所有日志 scope 统一为 `[Server]` / `[ClaudeMgr]` 两个值，sessionId 统一缩写为前 8 位
- [ ] 新增首字响应时间追踪：`First response in Xs`
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过（proxy 编译正常）

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-21 | 初始 PRD | @misakamikoto |
