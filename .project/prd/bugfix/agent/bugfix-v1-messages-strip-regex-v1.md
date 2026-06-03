---
timestamp: 2026-06-01
status: done
level: bugfix
module: agent
priority: P1
commander: "@mi-saka"
version: v1
---

# Bugfix: sdk-config.ts strip 正则无法匹配 /v1/messages 导致双重路径

## 根因分析

`sdk-config.ts` 中有两处使用了错误的正则 `/\/v\/?messages$/` 来 strip URL 中的 `/v1/messages` 后缀：

1. **`resolveAnthropicPassthrough` 函数** (line 246-250)
2. **PROXY_ANTHROPIC=false 直连路径** (line 165-169)

正则 `/\/v\/?messages$/` 匹配 `/v/messages` 或 `/vmessages`，但**不匹配** `/v1/messages`——因为 `v` 后面是数字 `1`，不是 `/` 也不是 `m`。

### 复现路径

当用户配置 baseUrl 为 `http://host:port/v1/messages` 时：

1. `detectNativeAnthropic` 正确识别为 Anthropic（`endsWith('/v1/messages')` → true）
2. 进入 `resolveAnthropicPassthrough`，strip 正则链执行：
   - `/\/v\/?messages$/` → 不匹配 `/v1/messages`
   - `/\/v\/?message$/` → 不匹配
   - `/\/messages$/` → 匹配，只剥掉 `/messages`，留下 `/v1`
3. 代码重新拼接 `cleanUrl + '/v1/messages'`
4. **结果**：`http://host:port/v1/v1/messages` → 404

PROXY_ANTHROPIC=false 的直连路径同理：SDK 将 ANTHROPIC_BASE_URL 设为 `http://host:port/v1`，SDK 自动追加 `/v1/messages`，同样产生 `/v1/v1/messages`。

### 根因定位

两处 strip 逻辑的正则字符类缺失数字匹配：

```typescript
// 当前（错误）—— 只匹配 /v/messages 或 /vmessages
.replace(/\/v\/?messages$/, '')
.replace(/\/v\/?message$/, '')

// 应为（正确）—— 匹配 /v1/messages, /v2/messages, /v/messages 等所有变体
.replace(/\/v\d*\/?messages$/, '')
.replace(/\/v\d*\/?message$/, '')
```

## 技术方案

将两处 strip 正则中的 `v` 改为 `v\d*`，使其匹配 `v` 后跟任意数量数字的所有变体（`v1`、`v2`、`v` 等）。

### 修改点 1：`resolveAnthropicPassthrough` (line 246-250)

```typescript
// Before
const cleanUrl = baseUrl.replace(/\/+$/, '')
    .replace(/\/v\/?messages$/, '')
    .replace(/\/v\/?message$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/message$/, '');

// After
const cleanUrl = baseUrl.replace(/\/+$/, '')
    .replace(/\/v\d*\/?messages$/, '')
    .replace(/\/v\d*\/?message$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/message$/, '');
```

### 修改点 2：PROXY_ANTHROPIC=false 直连路径 (line 165-169)

```typescript
// Before
const cleanBase = (credentials.baseUrl || '').replace(/\/+$/, '')
    .replace(/\/v\/?messages$/, '')
    .replace(/\/v\/?message$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/message$/, '');

// After
const cleanBase = (credentials.baseUrl || '').replace(/\/+$/, '')
    .replace(/\/v\d*\/?messages$/, '')
    .replace(/\/v\d*\/?message$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/message$/, '');
```

### 验证用例

| 输入 URL | 期望 cleanUrl |
|----------|--------------|
| `http://host:port/v1/messages` | `http://host:port` |
| `http://host:port/v1/message` | `http://host:port` |
| `http://host:port/v2/messages` | `http://host:port` |
| `http://host:port/v/messages` | `http://host:port` |
| `http://host:port/vmessages` | `http://host:port` |
| `http://host:port/messages` | `http://host:port` |
| `http://host:port/v1` | `http://host:port/v1`（不误剥） |
| `http://host:port` | `http://host:port`（无变化） |
| `http://host:port/api/v1/messages` | `http://host:port/api` |

## 涉及文件

| 文件 | 变更说明 |
|------|---------|
| `src/main/services/agent/sdk-config.ts` | 修复两处 strip 正则，`v` → `v\d*` |

## 开发前必读

| 文档 | 阅读目的 |
|------|---------|
| `.project/modules/openai-compat-router/openai-compat-router-v1.md` | 理解路由器整体设计，确认 passthrough 模式下 URL 处理链路 |
| `.project/modules/openai-compat-router/features/request-routing/changelog.md` | 确认路由变更历史，避免引入回归 |
| `.project/modules/agent/features/message-send/changelog.md` | 确认消息发送链路中 baseUrl 的使用方式 |

## 验收标准

- [ ] `resolveAnthropicPassthrough` 中 strip 正则改为 `/\/v\d*\/?messages$/`
- [ ] PROXY_ANTHROPIC=false 直连路径中 strip 正则同步修改
- [ ] 输入 `http://host:port/v1/messages` 不再产生 `/v1/v1/messages` 双重路径
- [ ] 输入 `http://host:port/v2/messages` 同样正确 strip
- [ ] 输入不含 `/v*/messages` 后缀的 URL 不受影响
- [ ] `npm run typecheck` 通过
- [ ] 打包构建通过（tar.xz + exe）

## 变更记录

| 时间 | 内容 |
|------|------|
| 2026-06-01 | 初稿 |
