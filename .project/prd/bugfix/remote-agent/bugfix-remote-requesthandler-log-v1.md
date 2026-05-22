# PRD [Bug 修复级] — 远程 Agent Proxy 补充 RequestHandler 级别日志

> 版本：bugfix-remote-requesthandler-log-v1
> 日期：2026-05-21
> 指令人：@misakamikoto
> 归属模块：packages/remote-agent-proxy
> 严重程度：P1（关键请求信息缺失）
> 状态：draft

## 问题描述

本地 AICO-Bot 日志中包含完整的 `[RequestHandler]` 字段，记录了上游 API 请求的关键信息（目标 URL、模型、API 类型、工具数量、响应状态码等）。远程服务器端的日志缺少对等信息。

### 本地日志示例（已有的 RequestHandler 信息）

```
[2026-05-21 15:14:35.124] [info]  [RequestHandler] Anthropic passthrough tools=63
[2026-05-21 15:14:35.124] [info]  [RequestHandler] POST https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true (stream=true)
[2026-05-21 15:14:35.125] [info]  [RequestHandler] Fetch Anthropic via direct: https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true (rawBody=true, useProxy=false)
[2026-05-21 15:15:33.829] [info]  [RequestHandler] Anthropic upstream response: 200
```

### 远程服务器当前日志（缺失 RequestHandler 信息）

远程服务器有两种请求路径：
1. **Anthropic 原生直传**（`backendType === 'anthropic'`）：SDK 直接调用上游 API，ClaudeManager 不记录上游 URL、API key 前缀、响应状态等 RequestHandler 级别信息
2. **OpenAI 兼容路由**（`backendType === 'openai_compat'`）：SDK 通过内部路由器，会生成 `[RequestHandler]` 日志，但当前路由器启动时未传入 `onLog` 回调，日志只写入本地 console 而不会通过 `logConversation` 写入文件

### 差距分析

| 信息 | 本地 | 远程 (anthropic) | 远程 (openai_compat) |
|------|------|------------------|---------------------|
| 上游目标 URL | `[RequestHandler] POST https://...` | 缺失 | 有（通过路由器） |
| API Key 前缀 | `[RequestHandler] Fetch ... apiKey=sk-...` | 缺失 | 有 |
| 模型名称 | `[RequestHandler] ... (stream=true)` | 仅在 streamChat 入口 | 有 |
| 工具数量 | `[RequestHandler] Anthropic passthrough tools=63` | 缺失 | 有 |
| 上游响应状态码 | `[RequestHandler] Anthropic upstream response: 200` | 缺失 | 有 |
| 请求耗时 | 隐含在首字响应时间中 | 有 | 缺失 |
| 原始请求体/响应体 | debug 级别 | 缺失 | 有 |

## 技术方案

### 核心策略

在 `claude-manager.ts` 的 `buildSdkOptions` 和 `streamChat` 关键位置补充 RequestHandler 级别日志，同时确保 OpenAI 兼容路由器的 `onLog` 回调也写入文件日志。

### 方案详情

#### 1. `claude-manager.ts` — buildSdkOptions 补充日志

在 `buildSdkOptions` 方法中，根据路由类型补充 RequestHandler 级别日志：

**1.1 Anthropic 原生直传路径（约第 1055-1069 行）**

在设置 `ANTHROPIC_BASE_URL` 之后，添加：

```typescript
} else {
  // Native Anthropic / Anthropic-compatible proxy — direct passthrough
  if (effectiveApiKey) {
    options.env.ANTHROPIC_API_KEY = effectiveApiKey
    options.env.ANTHROPIC_AUTH_TOKEN = effectiveApiKey
  }
  if (effectiveBaseUrl) {
    options.env.ANTHROPIC_BASE_URL = effectiveBaseUrl
  }
  // 新增：记录 RequestHandler 级别信息
  logConversation(
    `RequestHandler: Anthropic passthrough baseUrl=${effectiveBaseUrl || 'default'} model=${effectiveModel || 'default'} apiKey=${effectiveApiKey ? effectiveApiKey.substring(0, 8) + '...' : '(none)'}`
  )
}
```

**1.2 OpenAI 兼容路由路径（约第 1018-1054 行）**

已有日志，补充 apiKey 前缀信息：

```typescript
// 现有日志
log.info(SCOPE.CLAUDE_MGR, `Routing via OpenAI Compat Router: ${router.baseUrl} -> ${normalizedUrl} (apiType=${apiType}, model=${effectiveModel})`)
// 新增：记录完整的 RequestHandler 级别信息
logConversation(
  `RequestHandler: OpenAI compat baseUrl=${router.baseUrl} target=${normalizedUrl} apiType=${apiType} model=${effectiveModel} apiKey=${effectiveApiKey ? effectiveApiKey.substring(0, 8) + '...' : '(none)'}`
)
```

#### 2. `claude-manager.ts` — streamChat 补充上游响应信息

SDK 不暴露上游 HTTP 响应状态码（它在子进程中），但可以从 stream 事件中推断关键信息。在以下位置补充日志：

**2.1 首字响应时间已有** — 无需修改

**2.2 System init 事件 — 记录连接状态**

在 system init 事件处理中（已有 `System: Connected | Model: ...` 日志），无需额外改动。

**2.3 stream 结束时 — 记录工具数量和请求耗时**

在现有的 token usage 日志之后，添加：

```typescript
// 已有
log.info(SCOPE.CLAUDE_MGR, `Token usage: input=${inputTokens}, output=${outputTokens}, cache_read=${cacheRead}`)
// 新增
logConversation(
  `RequestHandler: stream completed status=ok model=${modelName} tokens={in:${inputTokens},out:${outputTokens},cache:${cacheRead}}`
)
```

**2.4 stream 错误时 — 记录错误信息**

在 stream 错误处理中（已有 `Stream chat error` 日志），添加：

```typescript
logConversation(
  `RequestHandler: stream error status=error model=${modelName} error=${error instanceof Error ? error.message : String(error)}`
)
```

#### 3. OpenAI 兼容路由器 — onLog 回调写入文件

当前 `setOnLogCallback` 将路由器日志转发给 WebSocket 客户端，但不写入远程文件日志。需要在 `index.ts` 中同步写入：

**3.1 修改 `index.ts` 中的 `setOnLogCallback`**

```typescript
import { logConversation, SCOPE } from './logger.js'

// Forward OpenAI Compat Router logs to all connected WebSocket clients AND file
setOnLogCallback((entry) => {
  server.forwardLogToClients(entry)
  const scope = entry.source === 'router' ? 'Router' : 'RequestHandler'
  const msg = `[${entry.source}] ${entry.message}`
  if (entry.level === 'error') log.error(scope, msg)
  else if (entry.level === 'warn') log.warn(scope, msg)
  else log.info(scope, msg)
})
```

这样路由器的 `[RequestHandler]` 日志既会通过 WebSocket 转发给本地客户端，也会写入远程文件日志。

#### 4. `server.ts` — 在 handleClaudeChat 中记录凭据信息

在接收到 claude:chat 消息时，从 options 中提取凭据信息：

```typescript
// 在 Processing chat 日志之后
const credentialsInfo = {
  apiKey: options?.apiKey ? options.apiKey.substring(0, 8) + '...' : '(none)',
  baseUrl: options?.baseUrl || 'default',
  provider: options?.provider || 'unknown',
  model: options?.model || 'default',
}
logConversation(
  `RequestHandler: incoming chat provider=${credentialsInfo.provider} model=${credentialsInfo.model} baseUrl=${credentialsInfo.baseUrl} apiKey=${credentialsInfo.apiKey} from=${clientIp}`
)
```

### 优化后远程日志示例

#### Anthropic 原生直传路径

```
2026-05-21 15:45:58 [INFO] [Server] Processing chat with 2 messages for session a9fcb6bb from 192.168.1.100
2026-05-21 15:45:58 [INFO] [Conv] User input for session a9fcb6bb: 请帮我写一个 Python 脚本
2026-05-21 15:45:58 [INFO] [Conv] RequestHandler: incoming chat provider=anthropic model=glm-5.1 baseUrl=https://open.bigmodel.cn apiKey=sk-ant-... from=192.168.1.100
2026-05-21 15:45:58 [INFO] [ClaudeMgr] streamChat: model=glm-5.1, workDir=/home/pzy
2026-05-21 15:45:58 [INFO] [Conv] RequestHandler: Anthropic passthrough baseUrl=https://open.bigmodel.cn/api/anthropic/v1/messages model=glm-5.1 apiKey=sk-ant-...
2026-05-21 15:45:59 [INFO] [ClaudeMgr] V2 session created (5ms), PID: 12345
2026-05-21 15:45:59 [INFO] [ClaudeMgr] System: Connected | Model: glm-5.1 | Tools: 36
2026-05-21 15:46:00 [INFO] [ClaudeMgr] First response in 1.2s
2026-05-21 15:46:05 [INFO] [ClaudeMgr] Token usage: input=23054, output=148, cache_read=4416
2026-05-21 15:46:05 [INFO] [Conv] RequestHandler: stream completed status=ok model=glm-5.1 tokens={in:23054,out:148,cache:4416}
2026-05-21 15:46:05 [INFO] [Server] Chat completed for session a9fcb6bb from 192.168.1.100 (7.0s)
2026-05-21 15:46:05 [INFO] [Conv] Model output for session a9fcb6bb: 好的，这是一个读取 CSV 文件... | 0 tool call(s) | 7.0s
```

#### OpenAI 兼容路由路径

```
2026-05-21 15:45:58 [INFO] [Server] Processing chat with 2 messages for session a9fcb6bb from 192.168.1.100
2026-05-21 15:45:58 [INFO] [Conv] User input for session a9fcb6bb: 请帮我写一个 Python 脚本
2026-05-21 15:45:58 [INFO] [ClaudeMgr] streamChat: model=qwen-max, workDir=/home/pzy
2026-05-21 15:45:58 [INFO] [ClaudeMgr] Routing via OpenAI Compat Router: http://127.0.0.1:9546 -> https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions (apiType=chat_completions, model=qwen-max)
2026-05-21 15:45:58 [INFO] [Conv] RequestHandler: OpenAI compat baseUrl=http://127.0.0.1:9546 target=https://dashscope.aliyuncs.com/.../chat/completions apiType=chat_completions model=qwen-max apiKey=sk-...
2026-05-21 15:45:58 [INFO] [Router] POST /v1/messages?beta=true from=127.0.0.1 content-type=application/json x-api-key=eyJ1cm... body=12.3KB
2026-05-21 15:45:58 [INFO] [RequestHandler] handleMessagesRequest apiType=chat_completions target=https://dashscope.aliyuncs.com/.../chat/completions model=qwen-max
2026-05-21 15:45:58 [INFO] [RequestHandler] wire=chat_completions tools=36
2026-05-21 15:45:58 [INFO] [RequestHandler] POST https://dashscope.aliyuncs.com/.../chat/completions (stream=true)
2026-05-21 15:46:05 [INFO] [RequestHandler] Upstream response: 200
2026-05-21 15:46:05 [INFO] [ClaudeMgr] Token usage: input=23054, output=148, cache_read=4416
2026-05-21 15:46:05 [INFO] [Conv] RequestHandler: stream completed status=ok model=qwen-max tokens={in:23054,out:148,cache:4416}
2026-05-21 15:46:05 [INFO] [Server] Chat completed for session a9fcb6bb from 192.168.1.100 (7.0s)
```

## 涉及文件

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `packages/remote-agent-proxy/src/claude-manager.ts` | **修改** | buildSdkOptions 补充 RequestHandler 级别日志；streamChat 补充完成/错误摘要 |
| 2 | `packages/remote-agent-proxy/src/server.ts` | **修改** | handleClaudeChat 记录凭据信息 |
| 3 | `packages/remote-agent-proxy/src/index.ts` | **修改** | setOnLogCallback 同步写入文件日志 |

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` | 理解 buildSdkOptions 两种路由路径、streamChat 流程、现有日志位置 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts` | 理解 handleClaudeChat 中 options 结构 |
| 源码文件 | `packages/remote-agent-proxy/src/index.ts` | 理解 setOnLogCallback 调用 |
| 参考日志 | `~/.aico-bot-dev/app-logs/main-2026-05-21.log` | 本地 [RequestHandler] 日志格式参考 |
| 依赖 PRD | `.project/prd/feature/remote-agent/feat-remote-file-logging-v1.md` | 文件日志系统（已实现 logConversation） |

## 验收标准

- [ ] Anthropic 原生直传路径：`buildSdkOptions` 记录 baseUrl、model、apiKey 前缀
- [ ] OpenAI 兼容路由路径：`buildSdkOptions` 记录 router baseUrl、target URL、apiType、model、apiKey 前缀
- [ ] stream 完成时通过 `logConversation` 记录 status、model、token 摘要
- [ ] stream 错误时通过 `logConversation` 记录 status=error 和错误信息
- [ ] `handleClaudeChat` 记录 incoming chat 的 provider、model、baseUrl、apiKey 前缀、clientIp
- [ ] `setOnLogCallback` 同时写入文件日志（Router + RequestHandler scope）
- [ ] 远程日志中出现 `[RequestHandler]` scope 的条目
- [ ] `npm run build:proxy` 编译通过
- [ ] `npm run build` 完整构建通过

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-21 | 初始 PRD | @misakamikoto |
