# PRD [Feature] — 代理请求日志增强

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-21 |
| 指令人 | @misakamikoto |
| 模块 | proxy / openai-compat-router / remote-agent-proxy |
| 状态 | draft |
| 优先级 | P0 |
| 影响范围 | 仅主进程（本地）+ 独立 Node.js 服务（远程） |

## 需求分析

### 背景

用户反馈：使用远程服务器上的模型时，日志中不显示请求头、来源 IP 等关键调试信息，导致问题排查困难。当前代理层（openai-compat-router + proxy 模块）的日志输出极为简陋，仅记录请求方法和 URL，无法满足故障定位的需求。

### 问题清单

| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| 1 | 本地 `router.ts` 中间件 | 仅记录 `[Router] ${req.method} ${req.url}`，无客户端 IP、请求头、请求体大小 | 无法判断请求来源、无法调试头信息问题 |
| 2 | 本地 `request-handler.ts` | 记录了后端 URL 和上游响应状态，但从未记录客户端 IP 和入站请求头 | 无法关联入站和出站信息 |
| 3 | 远程 `remote-agent-proxy/router.ts` | 与本地相同，仅记录 `[Router] ${req.method} ${req.url}` | 远程场景完全无法调试 |
| 4 | `proxy-fetch.ts` / `proxy-agent.ts` | **零日志**，纯网络层无任何可观测性 | 代理连接问题（超时、CONNECT 失败）无法定位 |
| 5 | openai-compat-router 和 proxy 模块使用原始 `console.log` | 未接入 `createLogger` 作用域日志体系 | 日志前缀不统一，无法按模块过滤 |
| 6 | 远程 `remote-agent-proxy` 无 `electron-log` | 只有原生 `console.log`，无文件轮转 | 远程日志只输出到 stdout，不持久化 |

### 预期效果

增强后，每个入站请求应输出类似以下格式的日志：

```
[Router] POST /v1/messages from=127.0.0.1 content-type=application/json user-agent=claude-code/1.0 x-api-key=eyJhbGci... body=12.3KB
```

每个代理出站请求应输出：

```
[Proxy] POST https://api.openai.com/v1/chat/completions via=direct timeout=30000ms
[Proxy] Response 200 OK (1.2s)
```

## 技术方案

### 核心策略

1. **中间件层增强**：在 Express 中间件中记录入站请求详情（IP、关键请求头、请求体大小）
2. **出站日志补充**：在 `proxy-fetch.ts` 关键节点添加日志（请求开始、响应到达、耗时）
3. **日志框架统一**：本地模块使用 `createLogger` 替代 `console.log`，远程 `remote-agent-proxy` 保持 `console.log`（无 electron-log 环境）
4. **安全脱敏**：请求头中的 `x-api-key`、`authorization`、`cookie` 等敏感字段只显示前 8 个字符；请求体不记录内容，只记录字节大小
5. **非阻塞**：日志通过 `console.log`/`logger.info` 同步写入，但避免序列化大对象，仅记录摘要信息

### 方案详情

#### 1. 本地 OpenAI Compat Router

##### 1.1 `router.ts` — 中间件增强

将现有：
```typescript
app.use((req, _res, next) => {
    console.log(`[Router] ${req.method} ${req.url}`);
    next();
});
```

增强为：
```typescript
const logger = createLogger('Router');

app.use((req, _res, next) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const headers = req.headers;

    // 记录关键请求头（脱敏）
    const headerParts: string[] = [];
    if (headers['content-type']) {
        headerParts.push(`content-type=${String(headers['content-type'])}`);
    }
    if (headers['user-agent']) {
        headerParts.push(`user-agent=${String(headers['user-agent']).slice(0, 60)}`);
    }
    if (headers['x-api-key']) {
        headerParts.push(`x-api-key=${String(headers['x-api-key']).slice(0, 8)}...`);
    }
    if (headers['authorization']) {
        headerParts.push(`authorization=${String(headers['authorization']).slice(0, 16)}...`);
    }

    // 请求体大小（从 rawBody 或 content-length 头获取）
    const contentLength = headers['content-length']
        ? `${(Number(headers['content-length']) / 1024).toFixed(1)}KB`
        : (req as any).rawBody
            ? `${((req as any).rawBody.length / 1024).toFixed(1)}KB`
            : 'unknown';

    logger.info(
        `${req.method} ${req.url} from=${clientIp} ${headerParts.join(' ')} body=${contentLength}`
    );
    next();
});
```

要点：
- 使用 `req.ip`（Express trust proxy 设置后）或 `req.socket.remoteAddress` 获取客户端 IP
- 敏感头（`x-api-key`、`authorization`）只显示前 8/16 字符
- `user-agent` 截断到 60 字符避免噪音
- 请求体大小优先从 `content-length` 头获取，次选 `rawBody` buffer 长度（中间件在 body parser 之后执行时 `rawBody` 已可用；注意：当前中间件在 body parser 之后，所以 `rawBody` 可用）

##### 1.2 `request-handler.ts` — 补充入站信息日志

在 `handleMessagesRequest` 入口处补充客户端信息日志（通过扩展 options 传入）：

```typescript
export async function handleMessagesRequest(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions = {},
): Promise<void> {
  const { url: backendUrl, apiType: configApiType } = config;
  console.log('[RequestHandler] handleMessagesRequest', backendUrl);
  // 新增：记录解码后的目标信息
  console.log(`[RequestHandler] apiType=${configApiType} target=${backendUrl} model=${anthropicRequest.model}`);
  // ... 后续逻辑不变
}
```

注意：`request-handler.ts` 现有的 `console.log` 在本次 PRD 中暂不全部替换为 `createLogger`（改动面过大），仅在新增日志点使用 `createLogger`。

##### 1.3 日志框架迁移（request-handler.ts 中的新增日志）

在 `request-handler.ts` 文件顶部添加：
```typescript
import { createLogger } from '../../services/log';
const logger = createLogger('RequestHandler');
```

后续新增的日志点使用 `logger.info()`，已有 `console.log` 保持不变（避免回归风险）。

#### 2. 远程 Agent Proxy

##### 2.1 `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` — 中间件增强

远程环境无 `electron-log`，使用 `console.log`。增强方式与本地相同：

```typescript
app.use((req, _res, next) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const headers = req.headers;

    const headerParts: string[] = [];
    if (headers['content-type']) {
        headerParts.push(`content-type=${String(headers['content-type'])}`);
    }
    if (headers['user-agent']) {
        headerParts.push(`user-agent=${String(headers['user-agent']).slice(0, 60)}`);
    }
    if (headers['x-api-key']) {
        headerParts.push(`x-api-key=${String(headers['x-api-key']).slice(0, 8)}...`);
    }
    if (headers['authorization']) {
        headerParts.push(`authorization=${String(headers['authorization']).slice(0, 16)}...`);
    }

    const contentLength = headers['content-length']
        ? `${(Number(headers['content-length']) / 1024).toFixed(1)}KB`
        : (req as any).rawBody
            ? `${((req as any).rawBody.length / 1024).toFixed(1)}KB`
            : 'unknown';

    console.log(
        `[Router] ${req.method} ${req.url} from=${clientIp} ${headerParts.join(' ')} body=${contentLength}`
    );
    next();
});
```

##### 2.2 远程 `request-handler.ts` — 补充目标信息日志

在 `handleMessagesRequest` 入口处补充：
```typescript
console.log(`[RequestHandler] apiType=${configApiType} target=${backendUrl} model=${anthropicRequest.model}`);
```

#### 3. Proxy 模块

##### 3.1 `proxy-fetch.ts` — 关键节点日志

在 `proxyFetch` 函数中添加请求开始和响应到达日志：

```typescript
import { createLogger } from '../log';
const logger = createLogger('Proxy');

export async function proxyFetch(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
  forceNoProxy = false,
): Promise<Response> {
  const timeout = timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const effectiveProxyUrl = forceNoProxy ? undefined : getEffectiveProxyUrl();

  // 新增：请求开始日志
  const method = init?.method || 'GET';
  logger.info(
    `${method} ${url} via=${effectiveProxyUrl ? `proxy(${effectiveProxyUrl})` : 'direct'} timeout=${timeout}ms`
  );

  const startTime = Date.now();

  if (effectiveProxyUrl) {
    const response = await fetchViaProxy(url, init, effectiveProxyUrl, timeout);
    // 新增：响应到达日志
    logger.info(`Response ${response.status} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
    return response;
  }

  // ... direct fetch 逻辑不变 ...

  // 在 native fetch 的 try 块中，response 返回前添加：
  // logger.info(`Response ${response.status} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
}
```

同样在 `fetchViaProxy` 的 CONNECT 成功/失败、curl fallback 等关键分支添加日志：

```typescript
// CONNECT 成功
logger.info(`CONNECT tunnel established to ${target.hostname} via ${proxy.hostname}`);

// 407 Negotiate/NTLM fallback
logger.info(`Proxy 407 with ${authScheme} auth, falling back to curl`);

// CONNECT 失败
logger.warn(`Proxy CONNECT failed (${res.statusCode}) to ${target.hostname}`);
```

##### 3.2 `proxy-agent.ts` — 无需改动

`proxy-agent.ts` 仅读取配置，不发起网络请求，无需添加日志。

### 安全考虑

#### 请求头脱敏规则

| 请求头 | 处理方式 | 示例输出 |
|--------|---------|---------|
| `x-api-key` | 显示前 8 字符 + `...` | `x-api-key=eyJhbGci...` |
| `authorization` | 显示前 16 字符 + `...` | `authorization=Bearer sk-ant-...` |
| `cookie` | 不记录（完全跳过） | — |
| `content-type` | 完整显示 | `content-type=application/json` |
| `user-agent` | 截断到 60 字符 | `user-agent=claude-code/1.0.0 (node/20.x)` |
| 其他头 | 不记录（减少噪音） | — |

#### 请求体处理

- **不记录请求体内容**（可能包含用户消息、工具调用等敏感数据）
- **只记录请求体大小**（通过 `content-length` 头或 `rawBody` buffer 长度）
- 格式：`body=12.3KB`

#### 与现有脱敏 hook 的兼容

`log-content-optimization-v1` PRD 已在 `src/main/index.ts` 中注册了全局脱敏 hook，会对所有日志输出中的 API Key、Bearer Token、密码等做正则替换。本次新增的日志同样受该 hook 保护，属于双重安全。远程 `remote-agent-proxy` 无该 hook，因此我们在日志生成时手动截断敏感字段。

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/openai-compat-router/openai-compat-router-v1.md` | 理解路由器架构、请求处理流程、组件职责 |
| 2 | `.project/prd/feature/logging/log-content-optimization-v1.md` | 了解现有脱敏 hook 实现，确保新增日志兼容 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `src/main/openai-compat-router/server/router.ts` | 了解当前中间件结构，确定日志增强插入点 |
| 2 | `src/main/openai-compat-router/server/request-handler.ts` | 了解请求处理入口和现有日志，确定补充日志位置 |
| 3 | `src/main/services/proxy/proxy-fetch.ts` | 了解代理请求流程（直连 / CONNECT 隧道 / curl fallback），确定日志插入点 |
| 4 | `src/main/services/proxy/proxy-agent.ts` | 确认无需改动（仅配置读取） |
| 5 | `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` | 远程路由器中间件，需同步增强 |
| 6 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 远程请求处理，需补充目标信息日志 |
| 7 | `src/main/services/log/index.ts` | 了解 `createLogger` API，确认使用方式 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | TypeScript strict、import type 等编码规范 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/openai-compat-router/server/router.ts` | 修改 | 中间件增强：添加客户端 IP、关键请求头（脱敏）、请求体大小 |
| 2 | `src/main/openai-compat-router/server/request-handler.ts` | 修改 | 入口处补充 apiType、target、model 日志；新增日志使用 createLogger |
| 3 | `src/main/services/proxy/proxy-fetch.ts` | 修改 | 关键节点日志：请求开始（方法/URL/代理/超时）、响应到达（状态码/耗时）、CONNECT 状态 |
| 4 | `packages/remote-agent-proxy/src/openai-compat-router/server/router.ts` | 修改 | 中间件增强：与本地相同（使用 console.log） |
| 5 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 修改 | 入口处补充 apiType、target、model 日志 |

## 验收标准

### 本地路由日志

- [ ] 本地路由日志包含客户端 IP（`from=127.0.0.1` 或实际 IP）
- [ ] 本地路由日志包含请求方法和 URL（已有，保持）
- [ ] 本地路由日志包含 `content-type` 请求头
- [ ] 本地路由日志包含 `user-agent` 请求头（截断到 60 字符）
- [ ] 本地路由日志包含 `x-api-key` 前缀（仅前 8 字符 + `...`）
- [ ] 本地路由日志包含 `authorization` 前缀（仅前 16 字符 + `...`）
- [ ] 本地路由日志包含请求体大小（KB 单位）

### 远程路由日志

- [ ] 远程路由日志包含同等信息（客户端 IP、关键请求头、请求体大小）

### 请求处理日志

- [ ] `handleMessagesRequest` 入口处记录 apiType、target URL、model

### 代理出站日志

- [ ] `proxyFetch` 记录请求开始信息（方法、URL、代理模式、超时）
- [ ] `proxyFetch` 记录响应到达信息（状态码、耗时秒数）
- [ ] CONNECT 隧道建立/失败有对应日志
- [ ] curl fallback（Negotiate/NTLM）有对应日志

### 安全

- [ ] API Key / Bearer Token 等敏感字段已脱敏（本地通过手动截断 + 全局脱敏 hook 双重保护）
- [ ] 请求体不记录内容，只记录大小
- [ ] `cookie` 头不记录

### 兼容性与质量

- [ ] 不影响请求处理性能（日志仅记录摘要信息，不序列化请求/响应体）
- [ ] 现有 `console.log` 日志保持不变（避免回归）
- [ ] 新增本地日志使用 `createLogger`（router.ts、proxy-fetch.ts）
- [ ] `npm run typecheck && npm run build` 通过
