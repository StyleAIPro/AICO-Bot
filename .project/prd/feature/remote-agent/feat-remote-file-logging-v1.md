# PRD [功能级] — 远程 Agent Proxy 文件日志系统

> 版本：feat-remote-file-logging-v1
> 日期：2026-05-21
> 指令人：@misakamikoto
> 归属模块：packages/remote-agent-proxy
> 优先级：P0
> 状态：draft

## 背景

当前远程 Agent Proxy 的日志机制极其原始：部署脚本通过 `nohup node dist/index.js > logs/output.log 2>&1 &` 将 stdout 重定向到单个文件，没有任何轮转、日期分割或结构化管理。一次简单的对话就会产生 50+ 行无时间戳的原始 JSON，且日志不包含用户输入内容、模型输出摘要、请求 IP 等关键信息。

相比之下，本地 Electron 端使用 `electron-log` 实现了完整的文件日志系统：
- 按日期分割：`main-YYYY-MM-DD.log`
- 用户输入元数据（provider、model、图片数量）
- 模型输出摘要块（响应预览、工具调用次数、耗时、token 用量）
- 5MB 大小限制 + 30 天自动清理

本 PRD 目标：为远程 Proxy 实现与本地同等质量的文件日志系统。

## 需求分析

### 当前问题

| # | 问题 | 影响 |
|---|------|------|
| 1 | 日志仅通过 shell 重定向到 `logs/output.log`，无日期分割 | 无法按日期查找问题，文件无限增长 |
| 2 | Node.js 进程无文件写入能力 | 无法在代码中控制日志文件路径和轮转 |
| 3 | 不记录用户输入内容 | 无法从日志还原对话上下文 |
| 4 | 不记录模型输出摘要 | 无法判断模型回复质量 |
| 5 | 不记录请求来源 IP（WebSocket 连接时有，但 chat 流程中丢失） | 无法关联特定对话与客户端 |
| 6 | `openai-compat-router` 中 47 处 `console.*` 未迁移到 logger | Router 日志无时间戳、无级别控制 |

### 设计目标

1. **日期分割日志文件**：`logs/proxy-YYYY-MM-DD.log`，自动轮转
2. **保留对话内容**：记录用户消息摘要（前 200 字符）、模型输出摘要（前 200 字符）
3. **保留请求关键信息**：客户端 IP、provider、model、token 用量、耗时
4. **日志文件管理**：大小限制 5MB/天、30 天自动清理
5. **Router 日志统一**：`openai-compat-router` 中的 console.* 迁移到 logger

## 技术方案

### 核心策略

不引入第三方日志库（保持轻量），在现有 `logger.ts` 基础上扩展文件写入能力。

### 方案详情

#### 1. 增强 `logger.ts` — 新增文件传输层

在 `packages/remote-agent-proxy/src/logger.ts` 中扩展：

**1.1 文件写入基础设施**

```typescript
import * as fs from 'fs'
import * as path from 'path'

// 日志目录（基于 DEPLOY_DIR/logs/）
let logDir = path.join(process.env.DEPLOY_DIR || '/opt/claude-deployment', 'logs')

export function setLogDir(dir: string): void {
  logDir = dir
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

// 当前日志文件句柄
let currentLogFile: string | null = null
let currentWriteStream: fs.WriteStream | null = null

function getLogFilePath(): string {
  const dateStr = new Date().toISOString().split('T')[0]
  return path.join(logDir, `proxy-${dateStr}.log`)
}

function getWriteStream(): fs.WriteStream {
  const filePath = getLogFilePath()
  if (filePath !== currentLogFile || !currentWriteStream) {
    if (currentWriteStream) currentWriteStream.end()
    currentLogFile = filePath
    currentWriteStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
  }
  return currentWriteStream
}

// 写入文件
function writeToFile(formatted: string): void {
  try {
    getWriteStream().write(formatted + '\n')
  } catch {
    // 文件写入失败不应影响服务
  }
}
```

**1.2 日志级别修改**

在现有 `log.info/warn/error/debug` 中，每个方法同时写入 console 和文件：

```typescript
export const log = {
  info(scope: string, msg: string) {
    const formatted = fmt('INFO', scope, msg)
    if (shouldLog('info')) console.log(formatted)
    writeToFile(formatted)
  },
  warn(scope: string, msg: string) {
    const formatted = fmt('WARN', scope, msg)
    if (shouldLog('warn')) console.warn(formatted)
    writeToFile(formatted)
  },
  error(scope: string, msg: string) {
    const formatted = fmt('ERROR', scope, msg)
    if (shouldLog('error')) console.error(formatted)
    writeToFile(formatted)
  },
  debug(scope: string, msg: string) {
    if (!shouldLog('debug')) return
    const formatted = fmt('DEBUG', scope, msg)
    console.log(formatted)
    // debug 级别不写入文件（减少噪音）
  },
}
```

**1.3 新增摘要日志方法**

为用户消息和模型输出提供专门的日志方法，确保写入文件（不受 LOG_LEVEL 影响）：

```typescript
/**
 * 记录对话摘要（始终写入文件，不受 LOG_LEVEL 影响）
 * 用于记录用户输入和模型输出的关键摘要信息
 */
export function logConversation(summary: string): void {
  const formatted = `${timestamp()} [INFO] [Conv] ${summary}`
  console.log(formatted)
  writeToFile(formatted)
}
```

**1.4 日志文件清理**

```typescript
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024  // 5MB
const MAX_LOG_AGE_DAYS = 30

export function cleanupOldLogs(): void {
  try {
    if (!fs.existsSync(logDir)) return
    const now = Date.now()
    const files = fs.readdirSync(logDir).filter(f => f.startsWith('proxy-') && f.endsWith('.log'))
    for (const file of files) {
      const filePath = path.join(logDir, file)
      const stat = fs.statSync(filePath)
      // 删除超过 30 天的日志
      if (now - stat.mtimeMs > MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath)
      }
      // 超过 5MB 的日志截断（保留最后 5MB）
      if (stat.size > MAX_LOG_FILE_SIZE) {
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(MAX_LOG_FILE_SIZE)
        fs.readSync(fd, buf, 0, MAX_LOG_FILE_SIZE, stat.size - MAX_LOG_FILE_SIZE)
        fs.closeSync(fd)
        fs.writeFileSync(filePath, buf)
      }
    }
  } catch {
    // 清理失败不应影响服务
  }
}
```

#### 2. `index.ts` 改动

**2.1 初始化日志目录**

在 `loadConfig()` 之后、创建 `RemoteAgentServer` 之前：

```typescript
setLogDir(path.join(deployDir, 'logs'))
cleanupOldLogs()
```

**2.2 修改启动命令兼容性**

由于 `nohup` 重定向仍然生效，日志会同时出现在 console 和文件中（console 输出被重定向到 `output.log`，文件写入创建 `proxy-YYYY-MM-DD.log`）。为避免重复：

- 保留 `nohup` 重定向（向后兼容，`output.log` 仍可用于实时查看）
- 文件日志作为持久化、可管理的补充
- `output.log` 由 shell 脚本管理（重启时覆盖或轮转）
- `proxy-YYYY-MM-DD.log` 由 Node.js 进程管理（日期分割、自动清理）

#### 3. `server.ts` 改动 — 记录用户输入和请求 IP

**3.1 在 `handleClaudeChat` 中记录用户消息摘要**

在接收到 `claude:chat` 消息时：

```typescript
// 提取用户最后一条消息的摘要
const lastUserMsg = messages.filter((m: any) => m.role === 'user').pop()
const userPreview = lastUserMsg?.content
  ? String(lastUserMsg.content).substring(0, 200).replace(/\n/g, ' ')
  : '(no user content)'

log.info(SCOPE.SERVER, `Processing chat with ${messages.length} messages for session ${shortId(sessionId)} from ${clientIp}`)
logConversation(`User input for session ${shortId(sessionId)}: ${userPreview}`)
```

**3.2 在 Chat completed 中记录模型输出摘要**

在 stream 完成时（已有 `accumulatedText` 变量），输出：

```typescript
const outputPreview = accumulatedText
  ? accumulatedText.substring(0, 200).replace(/\n/g, ' ')
  : '(empty)'
const toolCount = /* 从 stream 中统计的工具调用次数 */

log.info(SCOPE.SERVER, `Chat completed for session ${shortId(sessionId)} from ${clientIp} (${elapsed}s)`)
logConversation(
  `Model output for session ${shortId(sessionId)}: ${outputPreview} | ${toolCount} tool call(s) | ${elapsed}s`
)
```

**3.3 确保 clientIp 在整个 chat 流程中可用**

当前 `clientIp` 在 WebSocket connection 事件中获取，但在 `handleClaudeChat` 中需要从 `this.clients.get(ws)` 获取。需要确保：

```typescript
const client = this.clients.get(ws)
const clientIp = (req as any).socket?.remoteAddress || client?.ip || 'unknown'
```

并在 client state 中存储 IP（在 connection 时）：
```typescript
this.clients.set(ws, { authenticated: true, ip: clientIp, lastClientActivityAt: Date.now() })
```

#### 4. `claude-manager.ts` 改动 — 记录 token 用量和模型输出

**4.1 Token 用量日志增强**

现有的 token usage 日志已经迁移到 `log.info`，需要同时通过 `logConversation` 确保写入文件：

```typescript
log.info(SCOPE.CLAUDE_MGR, `Token usage: input=${inputTokens}, output=${outputTokens}, cache_read=${cacheRead}`)
```

这条已经在 info 级别，会自动写入文件。

**4.2 模型输出完整文本记录**

在 stream 结束时，将完整模型响应（非截断）写入 debug 级别文件：

```typescript
if (accumulatedText) {
  log.debug(SCOPE.CLAUDE_MGR, `[${shortId(sessionId)}] Full model response: ${accumulatedText}`)
}
```

注意：debug 级别不会自动写入文件。如果需要记录完整模型输出，可以用一个新选项或环境变量控制：

```typescript
// 通过 LOG_FULL_RESPONSE 环境变量控制是否记录完整模型响应
if (process.env.LOG_FULL_RESPONSE === 'true' && accumulatedText) {
  logConversation(`Full response for session ${shortId(sessionId)}: ${accumulatedText}`)
}
```

#### 5. `openai-compat-router` 日志迁移

将 `packages/remote-agent-proxy/src/openai-compat-router/` 中的 47 处 `console.*` 迁移到 logger。这些文件目前没有 import logger，需要添加。

**受影响文件（12 个）：**

| 文件 | console.* 数量 | 说明 |
|------|---------------|------|
| `server/router.ts` | 1 | 请求日志 |
| `server/request-handler.ts` | 26 | 请求处理详细日志 |
| `server/index.ts` | 3 | 服务启动日志 |
| `stream/base-stream-handler.ts` | 3 | 流处理日志 |
| `stream/sse-writer.ts` | 2 | SSE 写入日志 |
| `stream/openai-chat-stream.ts` | 2 | OpenAI 流处理 |
| `stream/openai-responses-stream.ts` | 2 | OpenAI Responses 流 |
| `interceptors/warmup.ts` | 1 | 预热拦截器 |
| `interceptors/preflight.ts` | 1 | 预检拦截器 |
| `background-tasks.ts` | 1 | 后台任务 |

迁移规则：
- `console.log` → `log.info(SCOPE.SERVER, ...)`
- `console.warn` → `log.warn(SCOPE.SERVER, ...)`
- `console.error` → `log.error(SCOPE.SERVER, ...)`
- Router 特有的 `RequestHandler` scope 可以继续使用 `[RequestHandler]` 作为 scope 参数
- 移除重复的 `[RequestHandler]`、`[Router]` 等前缀（logger 已添加 scope）

**注意**：`request-handler.ts` 中有 26 处 console.*，其中大量是响应体日志（`JSON.stringify(response).substring(0, 2000)`）。这些需要降级为 debug 级别：

```typescript
// 现有（info 级别，日志洪泛）
console.log(`[RequestHandler] Response body: ${JSON.stringify(response).substring(0, 2000)}`)

// 改为（debug 级别，默认不写入文件）
log.debug('RequestHandler', `Response body: ${JSON.stringify(response).substring(0, 500)}`)
```

#### 6. 部署脚本兼容

当前 `agent-deployer.ts` 和 `deploy-remote-agent.sh` 使用：

```bash
nohup node dist/index.js > logs/output.log 2>&1 &
```

这不会冲突。console 输出仍会被重定向到 `output.log`（可用于 `tail -f` 实时查看），同时文件传输层会写入 `proxy-YYYY-MM-DD.log`（持久化、可管理）。

**无需修改部署脚本**。

### 优化后日志文件示例

`logs/proxy-2026-05-21.log`：
```
2026-05-21 15:45:58 [INFO] [Server] Configuration loaded:
2026-05-21 15:45:58 [INFO] [Server]   Port: 8080
2026-05-21 15:45:58 [INFO] [Server]   Auth Tokens: 1 primary (open access if 0)
2026-05-21 15:45:58 [INFO] [Server] Client connected from 192.168.1.100 (no auth required)
2026-05-21 15:45:58 [INFO] [Server] Processing chat with 2 messages for session a9fcb6bb from 192.168.1.100
2026-05-21 15:45:58 [INFO] [Conv] User input for session a9fcb6bb: 请帮我写一个 Python 脚本，读取 CSV 文件并输出统计信息
2026-05-21 15:45:58 [INFO] [ClaudeMgr] streamChat: model=glm-5.1, workDir=/home/pzy
2026-05-21 15:45:59 [INFO] [ClaudeMgr] V2 session created (5ms), PID: 12345
2026-05-21 15:45:59 [INFO] [ClaudeMgr] System: Connected | Model: glm-5.1 | Tools: 36
2026-05-21 15:46:00 [INFO] [ClaudeMgr] First response in 1.2s
2026-05-21 15:46:05 [INFO] [ClaudeMgr] Token usage: input=23054, output=148, cache_read=4416
2026-05-21 15:46:05 [INFO] [Server] Chat completed for session a9fcb6bb from 192.168.1.100 (7.0s)
2026-05-21 15:46:05 [INFO] [Conv] Model output for session a9fcb6bb: 好的，这是一个读取 CSV 文件并输出统计信息的 Python 脚本... | 0 tool call(s) | 7.0s
```

（`LOG_LEVEL=debug` 时才显示 stream_event 类型、MCP servers 详情、完整响应体等）

## 涉及文件

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `packages/remote-agent-proxy/src/logger.ts` | **修改** | 新增文件传输层：日期分割文件、writeToFile、logConversation、cleanupOldLogs |
| 2 | `packages/remote-agent-proxy/src/index.ts` | **修改** | 调用 setLogDir()、cleanupOldLogs() |
| 3 | `packages/remote-agent-proxy/src/server.ts` | **修改** | 记录用户输入摘要、模型输出摘要、确保 clientIp 可用 |
| 4 | `packages/remote-agent-proxy/src/claude-manager.ts` | **修改** | 确保 token 用量和关键信息写入文件日志 |
| 5 | `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` | **修改** | console.* 迁移到 log.* |
| 6 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | **修改** | 26 处 console.* 迁移，响应体日志降级为 debug |
| 7 | `packages/remote-agent-proxy/src/openai-compat-router/server/index.ts` | **修改** | console.* 迁移 |
| 8 | `packages/remote-agent-proxy/src/openai-compat-router/stream/base-stream-handler.ts` | **修改** | console.* 迁移 |
| 9 | `packages/remote-agent-proxy/src/openai-compat-router/stream/sse-writer.ts` | **修改** | console.* 迁移 |
| 10 | `packages/remote-agent-proxy/src/openai-compat-router/stream/openai-chat-stream.ts` | **修改** | console.* 迁移 |
| 11 | `packages/remote-agent-proxy/src/openai-compat-router/stream/openai-responses-stream.ts` | **修改** | console.* 迁移 |
| 12 | `packages/remote-agent-proxy/src/openai-compat-router/interceptors/warmup.ts` | **修改** | console.* 迁移 |
| 13 | `packages/remote-agent-proxy/src/openai-compat-router/interceptors/preflight.ts` | **修改** | console.* 迁移 |
| 14 | `packages/remote-agent-proxy/src/background-tasks.ts` | **修改** | console.* 迁移 |

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `packages/remote-agent-proxy/src/logger.ts` | 理解现有 logger 实现，确定扩展点 |
| 源码文件 | `packages/remote-agent-proxy/src/index.ts` | 理解启动流程和 DEPLOY_DIR |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts` | 理解 handleClaudeChat 流程，定位用户消息提取点 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 理解 stream 流程，定位 accumulatedText 和 token 用量 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` | 理解 Router 日志点和 onLog 回调 |
| 源码文件 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 理解 26 处 console.log 分布 |
| 参考实现 | `src/main/services/log/index.ts` | 本地 electron-log 配置（日期分割、大小限制、清理） |
| 参考实现 | `src/main/services/agent/send-message-local.ts` | 本地 MODEL OUTPUT 摘要格式 |

## 验收标准

- [ ] `logger.ts` 新增文件传输层：`writeToFile()`、`setLogDir()`、`cleanupOldLogs()`
- [ ] `log.info/warn/error` 同时写入 console 和文件
- [ ] `log.debug` 仅写入 console（不写入文件）
- [ ] 日志文件路径：`{DEPLOY_DIR}/logs/proxy-YYYY-MM-DD.log`
- [ ] 新增 `logConversation()` 方法，始终写入文件，不受 `LOG_LEVEL` 影响
- [ ] 启动时自动清理 30 天以上的日志文件
- [ ] 超过 5MB 的日志文件自动截断（保留最后 5MB）
- [ ] `handleClaudeChat` 记录用户消息摘要（前 200 字符）和客户端 IP
- [ ] Chat completed 记录模型输出摘要（前 200 字符）、工具调用次数、耗时
- [ ] clientIp 在 WebSocket connection 时存入 client state，在 chat 流程中可访问
- [ ] `openai-compat-router/` 下所有 47 处 `console.*` 迁移到 `log.*`
- [ ] Router 响应体完整 JSON 降级为 debug 级别（info 级别只记录状态码和大小）
- [ ] `npm run build:proxy` 编译通过
- [ ] `npm run build` 完整构建通过

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-21 | 初始 PRD | @misakamikoto |
