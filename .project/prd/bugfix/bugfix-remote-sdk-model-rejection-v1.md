---
created: 2026-06-02
status: done
type: bugfix
commander: misakamikoto
---

# Bugfix: 远程服务器非 Claude 模型名被 SDK 内置校验拒绝

> 版本：bugfix-remote-sdk-model-rejection-v1
> 日期：2026-06-02
> 指令人：misakamikoto
> 归属模块：packages/remote-agent-proxy (claude-manager)
> 严重程度：High（远程部署场景下所有 Anthropic 兼容非 Claude 模型完全不可用）
> 影响范围：远程 Agent Proxy
> 状态：done

## 问题描述

### 期望行为

当用户通过 SSH 隧道使用非 Claude 模型（如 "GLM-5.1"）连接远程服务器时，远程 Claude Code SDK 应正常接受请求并经由本地 OpenAI Compat Router 将请求路由到上游 API。

### 实际行为

远程服务器上的 Claude Code CLI 子进程在启动阶段即拒绝模型名 "GLM-5.1"，报错：

```
There's an issue with the selected model (GLM-5.1). It may not exist or you may not have access to it.
```

请求根本未到达上游 API，token 用量为 0。

### 复现步骤

1. 在 AICO-Bot 中配置 AI source 为 Anthropic 兼容非 Claude 模型（如 GLM-5.1），URL 以 `/v1/messages` 结尾
2. 将工作空间部署到远程服务器（通过 SSH 隧道）
3. 在远程工作空间中发送消息
4. 观察远程服务器日志：`is_error=true`，`Token usage: input=0, output=0`，模型被 SDK 拒绝

### 影响范围

- **远程部署 + Anthropic 兼容非 Claude 模型**：必现
- **远程部署 + 标准 Claude 模型**：不受影响（SDK 内置模型列表包含 Claude 模型）
- **远程部署 + OpenAI 兼容模型**：不受影响（走 `openai_compat` 分支，已有路由替换逻辑）
- **本地使用**：不受影响（本地 `sdk-config.ts` 的 `resolveAnthropicPassthrough()` 已正确走 router）

## 根因分析

### 数据流

```
本地 AICO-Bot 配置 (model=GLM-5.1, url=http://IP:1090/v1/messages)
  → 远程部署 agent-runner.ts 将配置传到远程 Proxy
  → 远程 claude-manager.ts buildSdkOptions()
  → detectBackendType() 检测 URL 以 /v1/messages 结尾 → 返回 'anthropic'
  → 'anthropic' 分支直接将真实模型名传给 SDK 子进程
  → Claude Code CLI 内置模型数据库校验 → 拒绝 "GLM-5.1"
  → 请求终止，token 用量 = 0
```

### 根因：anthropic 分支直接透传真实模型名，未走 Router

在 `packages/remote-agent-proxy/src/claude-manager.ts` 的 `buildSdkOptions()` 方法中：

1. `detectBackendType()`（第 782-797 行）根据 URL 判断后端类型，URL 以 `/v1/messages` 结尾时返回 `'anthropic'`
2. **`'anthropic'` 分支（原第 1060-1082 行）** 直接将真实 API Key、真实 URL、真实模型名传给 SDK 子进程：
   - `options.env.ANTHROPIC_API_KEY = effectiveApiKey`（真实 API Key）
   - `options.env.ANTHROPIC_BASE_URL = baseUrl`（真实 URL）
   - `options.model = effectiveModel`（真实模型 "GLM-5.1"）
3. Claude Code CLI 子进程在启动时校验模型名，其内置数据库只包含 Claude 系列模型，拒绝 "GLM-5.1"

与此同时，**`'openai_compat'` 分支（第 1022-1058 行）** 已经正确地通过本地 OpenAI Compat Router 路由，并将模型名替换为 `claude-sonnet-4-6`（第 1056 行），由 Router 在转发时替换为真实模型名。

本地 AICO-Bot 通过 `sdk-config.ts` 的 `resolveAnthropicPassthrough()` 正确处理了此场景：即使后端是 Anthropic 原生 API，仍然走 Router 的 `anthropic_passthrough` 路径（零转换透传），并将 SDK 模型设为真实模型名（因为本地 SDK 不做模型名校验）。远程场景的关键区别在于：远程 Proxy 启动的是 CLI 子进程，该子进程有模型名校验。

### 日志证据

远程服务器日志：

```
RequestHandler: Anthropic passthrough baseUrl=http://100.102.191.165:1090/v1/messages model=GLM-5.1
Creating V2 session: model=GLM-5.1, baseUrl=undefined   ← 直接透传，未走 Router
Result: is_error=true
Token usage: input=0, output=0                           ← SDK 在 API 调用前即拒绝
Model output: There's an issue with the selected model (GLM-5.1)...
```

## 技术方案

### 修复点 1：anthropic 分支改为走 Router + anthropic_passthrough

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`，`buildSdkOptions()` 方法中的 `else`（anthropic）分支（原第 1060-1082 行）

将直接透传改为通过本地 OpenAI Compat Router 的 `anthropic_passthrough` 模式路由，镜像本地 `sdk-config.ts` 中 `resolveAnthropicPassthrough()` 的实现方式。

修改前（直接透传）：

```typescript
} else {
  if (effectiveApiKey) {
    options.env.ANTHROPIC_API_KEY = effectiveApiKey
    options.env.ANTHROPIC_AUTH_TOKEN = effectiveApiKey
  }
  if (effectiveBaseUrl) {
    const baseUrl = effectiveBaseUrl.replace(...)
    options.env.ANTHROPIC_BASE_URL = baseUrl
  }
  // 使用真实模型名
}
```

修改后（Router 透传）：

```typescript
} else {
  const router = await this.ensureRouter()
  const { encodeBackendConfig } = await import('./openai-compat-router/utils/config.js')
  const baseUrl = (effectiveBaseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  const cleanUrl = baseUrl
    .replace(/\/v\d*\/?messages$/, '')
    .replace(/\/v\d*\/?message$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/message$/, '') + '/v1/messages'
  const encodedConfig = encodeBackendConfig({
    url: cleanUrl,
    key: effectiveApiKey || '',
    model: effectiveModel,
    apiType: 'anthropic_passthrough',
  })
  options.env.ANTHROPIC_API_KEY = encodedConfig
  options.env.ANTHROPIC_AUTH_TOKEN = encodedConfig
  options.env.ANTHROPIC_BASE_URL = router.baseUrl
  options.model = 'claude-sonnet-4-6'
}
```

关键变更：
- 启动本地 Router（`ensureRouter()`）
- 将上游 URL、API Key、真实模型名编码为 `encodedConfig`，通过 `ANTHROPIC_API_KEY` 传递
- `ANTHROPIC_BASE_URL` 指向本地 Router 而非真实上游
- 模型名设为 `claude-sonnet-4-6`（伪造），绕过 SDK 模型校验
- Router 的 `anthropic_passthrough` 处理器在转发时将模型名替换为真实模型名

### 修复点 2：CLAUDE_CODE_SUBAGENT_MODEL 改为假模型名

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`，第 1107 行

修改前：

```typescript
options.env.CLAUDE_CODE_SUBAGENT_MODEL = effectiveModel  // 真实模型名
```

修改后：

```typescript
options.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-sonnet-4-6'  // 假模型名
```

原因：两条路径（openai_compat 和 anthropic）现在都走 Router，Router 在转发时会替换为真实模型名。子代理也需要使用假模型名以绕过 SDK 校验。

## 风险评估

### 风险 1：标准 Anthropic API 场景（无风险）

Router 的 `anthropic_passthrough` 模式是零转换透传——请求格式不经过任何修改（除了模型名替换），SSE 响应直接管道回 SDK。标准 Claude 模型（如 claude-sonnet-4-6）在此路径下行为与直接透传完全一致。

**缓解**：`anthropic_passthrough` 已在本地 AICO-Bot 中长期使用（`sdk-config.ts` 的 `resolveAnthropicPassthrough()`），稳定性已验证。

### 风险 2：OpenAI 兼容路径（无风险）

`openai_compat` 分支未做任何修改。

### 风险 3：子代理模型覆盖（低风险）

`CLAUDE_CODE_SUBAGENT_MODEL` 从真实模型名改为 `claude-sonnet-4-6`。对于 SDK 内置的子代理（如 "Explore"），此 env var 覆盖了其硬编码的 "haiku" 模型。Router 在转发时会统一替换为 `encodedConfig` 中的真实模型名。

**缓解**：两条路径的 Router 都会在转发时从 `encodedConfig` 中读取真实模型名进行替换，子代理请求经过同样的 Router 路径，模型名会被正确替换。

## 开发前必读

| 文档 | 路径 | 阅读目的 |
|------|------|----------|
| 远程 Agent Manager | `packages/remote-agent-proxy/src/claude-manager.ts` | 理解 `detectBackendType()` 和 `buildSdkOptions()` 逻辑 |
| 本地 SDK 配置 | `src/main/services/agent/sdk-config.ts` | 理解 `resolveAnthropicPassthrough()` 本地实现 |
| 远程 Router 请求处理 | `packages/remote-agent-proxy/src/openai-compat-router/server/request-handler.ts` | 理解 `anthropic_passthrough` 处理逻辑 |
| 远程部署 | `src/main/services/remote/deploy/agent-runner.ts` | 理解模型名如何从本地传到远程 |
| 编码配置工具 | `packages/remote-agent-proxy/src/openai-compat-router/utils/config.ts` | 理解 `encodeBackendConfig()` 编码格式 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | anthropic 分支改为走 Router + `anthropic_passthrough`；`CLAUDE_CODE_SUBAGENT_MODEL` 改为假模型名 `claude-sonnet-4-6` |

## 验收标准

- [ ] 非 Claude 模型（如 GLM-5.1）配合 Anthropic 兼容 URL 在远程服务器上正常工作
- [ ] 标准 Claude 模型（如 claude-sonnet-4-6）在远程服务器上仍正常工作
- [ ] OpenAI 兼容模型在远程服务器上仍正常工作
- [ ] `packages/remote-agent-proxy` 下 `npm run build` 通过
- [ ] Remote Agent Proxy 部署成功
