# PRD — 聊天界面上下文使用量实时显示

> 时间：2026-05-14
> 状态：in-progress
> 级别：feature
> 指令人：@misakamikoto

## 需求分析

### 需求描述

在 AICO-Bot 聊天界面 InputToolbar 的「压缩」按钮旁边，实时显示当前对话的上下文使用量信息。显示格式为 `已用K / 最大K (百分比%)`，让用户随时了解上下文窗口的使用情况。

### 用户价值

- **感知上下文余量**：用户无需 hover 消息底部的 TokenUsageIndicator，即可在输入框旁直接看到上下文用量
- **预防上下文溢出**：百分比和颜色预警让用户在接近上限时主动压缩，避免被强制截断
- **辅助模型选择**：显示最大上下文长度，帮助用户了解当前模型的上下文能力

## 技术方案

### 整体思路

现有代码中已存在以下基础：
1. **后端**：`process-stream.ts` 在每轮 assistant 消息时提取 `lastSingleUsage`，在 result 消息时构建完整的 `tokenUsage`（含 `contextWindow`），并通过 `agent:complete` 事件发送到渲染器
2. **组件**：`TokenUsageIndicator.tsx` 已实现完整的 token 用量计算和 tooltip 展示逻辑
3. **类型**：渲染器 `TokenUsage` 接口已包含 `inputTokens`、`outputTokens`、`contextWindow` 等字段

本需求需要：
1. 新增 IPC 事件 `agent:context-usage`，在 assistant 消息时实时推送中间 token 用量（不含 `contextWindow`，仅含 `inputTokens` 等）
2. 在 chat store 中维护每会话的最新上下文使用信息（`currentContextUsage`）
3. 在 `handleAgentComplete` 中从 `tokenUsage` 提取最终上下文信息（含 `contextWindow`）
4. 在 `InputToolbar` 中新增 `ContextUsageDisplay` 组件，显示 `125K / 200K (62.5%)` 格式

### 数据流

```
后端 (process-stream.ts)           渲染器 (chat.store.ts)          组件 (InputToolbar)
─────────────────────           ──────────────────────          ───────────────────
assistant 消息 ──►               ──► 更新 currentContextUsage ──► 显示用量（无 contextWindow）
  lastSingleUsage                 (inputTokens 等单项数据)
  emit('agent:context-usage')

result 消息 ──►                  ──► handleAgentComplete ────► 显示完整用量
  tokenUsage                       中提取 inputTokens +             (含 contextWindow)
  emit('agent:complete')           contextWindow
```

### 详细设计

#### 1. 新增 IPC 事件 `agent:context-usage`

**触发时机**：`process-stream.ts` 中，每次收到 assistant 消息并成功提取 `lastSingleUsage` 后（约 line 796 之后），新增一次 `emit` 调用。

**事件数据**：
```typescript
{
  type: 'context-usage',
  inputTokens: number;      // 当前 API 调用的 input tokens
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
```

**注意**：此阶段无 `contextWindow`（需等 result 消息才能确定），前端使用上一次已知的 `contextWindow`，若无则默认 200K。

**后端修改**（`src/main/services/agent/process-stream.ts`，约 line 796）：
```typescript
if (sdkMessage.type === 'assistant') {
  const usage = extractSingleUsage(sdkMessage);
  if (usage) {
    lastSingleUsage = usage;
    // 实时推送上下文使用量到前端
    emit('agent:context-usage', {
      type: 'context-usage',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    });
  }
}
```

#### 2. IPC 通道注册（3 个文件）

新增事件需要注册到 IPC/Preload/Transport 三层：

| 文件 | 修改内容 |
|------|----------|
| `src/preload/index.ts` | 新增 `onAgentContextUsage` 方法（参考 `onAgentComplete`） |
| `src/renderer/api/transport.ts` | `methodMap` 新增 `'agent:context-usage': 'onAgentContextUsage'` |
| `src/renderer/api/index.ts` | 导出 `api.onAgentContextUsage` |

#### 3. Chat Store 扩展

**新增状态**（`SessionState` 接口）：
```typescript
// 当前上下文使用信息（实时更新）
currentContextUsage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;  // 上次已知或默认 200K
} | null;
```

**新增事件处理器**：
```typescript
handleAgentContextUsage: (data: AgentEventBase & {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}) => void;
```

**逻辑**：
- 收到 `agent:context-usage` 时，保留上一次已知的 `contextWindow`，更新其余字段
- 收到 `agent:complete` 时，从 `tokenUsage` 中提取所有字段（含 `contextWindow`）
- 切换会话时，`currentContextUsage` 通过 `initializeSession` 重置为 null

**`handleAgentComplete` 修改**：
当前签名 `handleAgentComplete: (data: AgentEventBase) => void` 需改为接收 `AgentCompleteEvent`（含 `tokenUsage`），并在其中更新 `currentContextUsage`。

#### 4. App.tsx 事件绑定

新增 `api.onAgentContextUsage` 监听，绑定到 `handleAgentContextUsage`（参考现有 `onAgentComplete` 绑定模式）。

#### 5. InputToolbar 中的 ContextUsageDisplay

**显示位置**：`InputToolbar` 左侧区域，压缩按钮之后（即压缩按钮右侧）。

**组件设计**：直接在 `InputToolbar` 内实现（不单独建组件，逻辑简单），或提取为 `ContextUsageDisplay` 小组件。

**显示格式**：`125K / 200K (62.5%)`
- 无数据时显示 `-- / 200K (--%)`
- 使用 `TokenUsageIndicator` 中的 `formatTokens()` 函数（提取为共享工具函数）

**颜色预警**：
| 使用率 | 颜色 |
|--------|------|
| < 60% | `text-muted-foreground/50`（默认灰色） |
| 60% - 80% | `text-amber-500/80` |
| >= 80% | `text-red-500/80` |

**样式**：与现有工具栏按钮一致 —— `text-xs cursor-default select-none`，不使用按钮交互（纯展示），hover 显示 tooltip。

**Tooltip**：复用 `TokenUsageIndicator` 的 tooltip 内容（或简化版，仅显示 input/output/cache 分项），可选实现。

**Props 传递链**：
```
ChatView → InputArea → InputToolbar (新增 props: contextUsage)
```

`InputAreaProps` 新增：
```typescript
contextUsage?: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
} | null;
```

`ChatView` 从 `chat.store.ts` 获取当前会话的 `contextUsage`，传递给 `InputArea`。

#### 6. `formatTokens` 工具函数提取

将 `TokenUsageIndicator.tsx` 中的 `formatTokens` 函数提取到 `src/renderer/utils/format.ts`（或已有工具文件），供两个组件共用。`TokenUsageIndicator` 改为导入。

#### 7. 远程模式适配

`sendToRenderer` 已同时发送 IPC 和 WebSocket 广播，因此后端无需额外适配。前端 `transport.ts` 的 `methodMap` 注册即可。远程 WebSocket 客户端已有通用事件路由。

### 不做的事

- 不修改 `agent:complete` 事件的数据结构（只在前端侧增加读取）
- 不在生成中实时更新每一帧（仅在 assistant 消息节点更新，频率足够）
- 不单独新建组件文件（内联在 InputToolbar 即可，如实现需要再提取）

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|----------|
| 模块设计文档 | `.project/modules/chat/chat-ui-v1.md` | 理解 Chat UI 模块架构、组件树、store 接口 |
| 源码文件 | `src/main/services/agent/process-stream.ts`（lines 295-310, 791-797, 1234-1238, 1339-1345） | 理解 token 用量提取时机和 emit 模式 |
| 源码文件 | `src/main/services/agent/message-utils.ts`（lines 340-427） | 理解 `extractSingleUsage()` 和 `extractResultUsage()` 返回结构 |
| 源码文件 | `src/main/services/agent/types.ts`（lines 244-258） | `TokenUsage` 和 `SingleCallUsage` 接口定义 |
| 源码文件 | `src/renderer/types/index.ts`（lines 620-652） | 渲染器 `TokenUsage` 接口和 `AgentCompleteEvent` |
| 源码文件 | `src/renderer/stores/chat.store.ts`（lines 112-139, 422, 1903-1960） | SessionState 结构、handleAgentComplete 实现 |
| 源码文件 | `src/renderer/components/chat/InputArea.tsx`（lines 660-810） | InputToolbar props 和按钮布局 |
| 源码文件 | `src/renderer/components/chat/TokenUsageIndicator.tsx` | 现有 token 用量组件，复用 formatTokens 和计算逻辑 |
| 源码文件 | `src/renderer/App.tsx`（lines 300-310, 463） | 事件绑定模式 |
| 源码文件 | `src/preload/index.ts`（line 850, 1117） | Preload 事件注册模式 |
| 源码文件 | `src/renderer/api/transport.ts`（lines 286-328） | methodMap 和 onEvent 机制 |
| 源码文件 | `src/renderer/api/index.ts`（lines 1-20） | api 导出模式 |

## 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/main/services/agent/process-stream.ts` | 修改 | 新增 `agent:context-usage` emit（assistant 消息后） |
| `src/preload/index.ts` | 修改 | 新增 `onAgentContextUsage` 事件监听 |
| `src/renderer/api/transport.ts` | 修改 | methodMap 新增 `agent:context-usage` |
| `src/renderer/api/index.ts` | 修改 | 导出 `api.onAgentContextUsage` |
| `src/renderer/stores/chat.store.ts` | 修改 | SessionState 新增 `currentContextUsage`，新增 handler，修改 `handleAgentComplete` |
| `src/renderer/App.tsx` | 修改 | 绑定 `api.onAgentContextUsage` 事件 |
| `src/renderer/components/chat/InputArea.tsx` | 修改 | 新增 `contextUsage` prop，InputToolbar 新增用量显示 |
| `src/renderer/components/chat/ChatView.tsx` | 修改 | 从 store 获取 `contextUsage` 传给 InputArea |
| `src/renderer/components/chat/TokenUsageIndicator.tsx` | 修改 | 提取 `formatTokens` 到共享位置 |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增上下文用量相关翻译 key |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增上下文用量相关翻译 key |

## 验收标准

- [ ] InputToolbar 压缩按钮右侧显示上下文用量，格式为 `125K / 200K (62.5%)`
- [ ] 无 token 数据时显示默认状态 `-- / 200K`
- [ ] 每轮 assistant 消息时实时更新用量（不含 contextWindow 时使用上一次已知值或默认 200K）
- [ ] 对话完成时更新 contextWindow 为最终值
- [ ] 使用率 >= 80% 时文字变为红色预警，60%-80% 为橙色
- [ ] 切换对话时用量显示重置
- [ ] 压缩上下文后，下一轮 assistant 消息用量应明显下降
- [ ] `npm run typecheck && npm run build` 通过
- [ ] `npm run i18n` 无新增用户可见文本遗漏（纯数字/百分比无需翻译 key）
