# Bugfix: contextWindow 优先级逻辑修正

## 元信息

| 字段 | 值 |
|------|-----|
| 时间 | 2026-05-14 |
| 状态 | done |
| 级别 | bugfix |
| 指令人 | @misakamikoto |
| 模块 | agent (消息处理)、settings (UI) |

## 需求分析

当前 `extractResultUsage` 中 contextWindow 的优先级逻辑存在两个问题：

1. **取较大值逻辑不合理**：当用户手动配置了 contextWindow（例如 200K），而 SDK 返回的 `modelUsage.contextWindow` 更大（例如 1M），代码会使用 SDK 的值而非用户配置。这与"用户配置优先"的设计意图矛盾——用户可能因为成本或模型实际能力限制，有意设置较小的值。
2. **UI 文案误导**：Context Window 输入框的帮助文本为"留空使用默认值 (200K)"，暗示 200K 是正常默认值，但实际上在大多数情况下 SDK 会返回模型的真实上下文窗口大小，200K 只是兜底值。用户会误以为不配置就是 200K。

## 问题根因

`extractResultUsage`（`src/main/services/agent/message-utils.ts` lines 381-394）中的逻辑：

```typescript
let contextWindow = configuredContextWindow ?? 200000;
if (modelUsage?.contextWindow) {
  const sdkContextWindow = Object.values(modelUsage)[0]?.contextWindow;
  if (!configuredContextWindow && sdkContextWindow) {
    contextWindow = sdkContextWindow;
  } else if (
    configuredContextWindow &&
    sdkContextWindow &&
    sdkContextWindow > configuredContextWindow
  ) {
    contextWindow = sdkContextWindow;  // BUG: 用户配置被 SDK 值覆盖
  }
}
```

`else if` 分支在 SDK 值大于用户配置时，用 SDK 值覆盖了用户配置。这违反了"用户配置优先"原则。

## 技术方案

### 1. 修改 `extractResultUsage` 优先级逻辑

将 lines 378-394 替换为严格三级优先级：

```typescript
// Priority: user-configured > SDK modelUsage.contextWindow > hardcoded 200K fallback
const sdkContextWindow = modelUsage
  ? Object.values(modelUsage)[0]?.contextWindow
  : undefined;
const contextWindow = configuredContextWindow ?? sdkContextWindow ?? 200000;
```

- 移除"取较大值"逻辑
- 用户配置的值始终优先，不会被 SDK 值覆盖
- 无用户配置时使用 SDK 返回值（模型真实上下文）
- 仅在两者都缺失时回退到 200K

### 2. 修改 UI 帮助文本

将 i18n key 从"留空使用默认值 (200K)"改为"留空自动检测"语义：

| 语言 | 原文 | 改为 |
|------|------|------|
| en | `Model context window size. Leave empty to use default (200K). Used for automatic compression threshold.` | `Model context window size. Leave empty for auto-detection. Used for automatic compression threshold.` |
| zh-CN | `模型上下文窗口大小。留空使用默认值 (200K)。用于自动压缩阈值计算。` | `模型上下文窗口大小。留空自动检测。用于自动压缩阈值计算。` |

其他语言（zh-TW、ja、fr、es、de）的 key 也需同步更新翻译值（当前为空字符串，同样需要替换 key 文本为新的英文 key）。

### 3. 更新注释

更新 `extractResultUsage` 上方函数注释（约 line 357-361），移除关于"取较大值"的描述，改为严格优先级说明。

### 4. `sdk-config.ts` 无需修改

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境变量仅在用户配置了 contextWindow 时设置（line 634），逻辑正确：无配置时不传，由 CLI 自行决定。此行为不受本次修改影响。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/agent/message-utils.ts`（lines 355-427） | 理解 `extractResultUsage` 当前实现，确认修改范围 |
| 源码文件 | `src/renderer/components/settings/ProviderSelector.tsx`（lines 755-777） | 理解 contextWindow 输入框和帮助文本位置 |
| 源码文件 | `src/renderer/i18n/locales/en.json`、`zh-CN.json` | 确认 i18n key 及当前翻译 |
| 源码文件 | `src/main/services/agent/sdk-config.ts`（lines 631-634） | 确认 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 设置逻辑无需修改 |
| 源码文件 | `src/main/services/agent/process-stream.ts`（line 1242） | 确认 `extractResultUsage` 调用方式不变 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/message-utils.ts` | 修改 | 重写 `extractResultUsage` 中 contextWindow 优先级逻辑 + 更新注释 |
| `src/renderer/components/settings/ProviderSelector.tsx` | 修改 | 更新 contextWindow 输入框帮助文本 |
| `src/renderer/i18n/locales/en.json` | 修改 | 更新英文翻译 key |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 更新中文翻译 |

## 验收标准

- [x] 用户手动配置了 contextWindow → UI 和 token 用量显示使用用户配置的值，不被 SDK 返回值覆盖
- [x] 用户未配置 contextWindow 且 SDK 返回了 `modelUsage.contextWindow` → 使用 SDK 返回的值
- [x] 用户未配置且 SDK 未返回 → 兜底使用 200K
- [x] contextWindow 输入框帮助文本显示"留空自动检测"而非"留空使用默认值 (200K)"（en + zh-CN）
- [x] `npm run typecheck && npm run build` 通过
- [x] `npm run i18n` 通过（如有新用户可见文本）
