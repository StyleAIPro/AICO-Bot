---
created: 2026-06-01
status: done
type: bugfix
commander: misakamikoto
---

# Bugfix: handleAgentComplete 中 nextPendingMessage 未定义

> 版本：bugfix-next-pending-message-undefined-v1
> 日期：2026-06-01
> 指令人：@misakamikoto
> 归属模块：modules/agent
> 严重程度：Critical
> 所属功能：features/message-send

## 问题描述

- **期望行为**：AI 完成回复后，如果有排队消息（pendingMessages），应自动发送下一条；如果没有排队消息，正常完成对话并保留 UI 状态
- **实际行为**：当存在 pendingMessages 时，`handleAgentComplete` 执行到第 2309 行抛出 `ReferenceError: nextPendingMessage is not defined`，catch 块捕获错误后清空 session 状态（包括 `streamingContent` 和 `thoughts`），导致 UI 显示为空白
- **复现步骤**：
  1. 在任意空间中发送消息
  2. AI 回复过程中快速发送第二条消息（消息被排入 pendingMessages）
  3. AI 完成第一条回复后，`handleAgentComplete` 执行
  4. 控制台报 `ReferenceError: nextPendingMessage is not defined`
  5. UI 被清空，排队消息丢失

## 根因分析

**文件**：`src/renderer/stores/chat.store.ts` — `handleAgentComplete` 函数

### 变量作用域链分析

| 行号 | 代码 | 变量 | 作用域 |
|------|------|------|--------|
| 2149 | `const pendingMessages = sessionBeforeComplete.pendingMessages \|\| [];` | `pendingMessages` | `handleAgentComplete` 函数级（外部） |
| 2245 | `const remainingPending = currentSession.pendingMessages \|\| [];` | `remainingPending` | `set()` 回调内部 |
| 2250 | `const nextMessage = remainingPending[0];` | `nextMessage` | `set()` 回调内部 |
| 2309 | `if (nextPendingMessage)` | `nextPendingMessage` | **不存在** |
| 2322 | `nextMessage.content` | `nextMessage` | `set()` 回调内部（外部不可访问） |

### 错误触发链

1. 第 2149 行正确捕获了待处理消息快照 `pendingMessages`
2. 第 2245-2250 行在 `set()` 回调**内部**定义了 `remainingPending` 和 `nextMessage`，这两个变量的作用域仅限 `set()` 的箭头函数内部
3. 第 2309 行（`set()` 回调外部）引用了 **从未定义的** `nextPendingMessage` 变量
4. 当 `pendingMessages.length > 0` 时，第 2309 行立即抛出 `ReferenceError: nextPendingMessage is not defined`
5. 第 2332 行的 `catch` 块捕获该错误，执行第 2340-2354 行的状态清空逻辑
6. `streamingContent` 被清空、`thoughts` 被清空（`[]`）、`pendingMessages` 被清空（`[]`）
7. UI 显示为空白

### 当 pendingMessages 为空时为何不出错

当 `pendingMessages` 为空数组时，`set()` 回调内走 `else` 分支（第 2273 行），不会设置 `hasPendingMessages`。但第 2309 行的 `nextPendingMessage` 仍然不存在——只是 JS 引擎在执行到 `if (nextPendingMessage)` 前不会报错…… **不对**，`if (nextPendingMessage)` 会直接抛 ReferenceError，无论 `pendingMessages` 是否为空。

**修正**：经再次分析，`nextPendingMessage` 在第 2309 行被求值时，由于该变量从未在任何可达作用域中声明，无论 `pendingMessages` 是否为空都会抛出 `ReferenceError`。这意味着 `handleAgentComplete` 在所有情况下都会进入 catch 块，所有对话完成后 UI 都会被清空。

## 技术方案

修复第 2309 行和第 2322-2328 行，使用已在函数级作用域捕获的 `pendingMessages` 数组：

### 修改前（第 2307-2330 行）

```typescript
// If there were pending messages, send the first one now
// Use nextPendingMessage captured from inside set() (current state, not stale snapshot)
if (nextPendingMessage) {
  // Build canvas context (uses module-level buildCanvasContext)

  // Send the pending message — backend addMessage() writes to DB,
  // next handleAgentComplete reload brings correct ordering.
  // Do NOT add to cache here — that caused off-by-one display bug
  // where the user message appeared under the previous response.
  // Send with CURRENT KB selection (not stale snapshot)
  const { useKnowledgeBaseStore } = await import('./knowledge-base.store');
  const currentKbIds = useKnowledgeBaseStore.getState().activeKnowledgeBaseIds;
  await api.sendMessage({
    spaceId,
    conversationId,
    message: nextMessage.content,
    images: nextMessage.images,
    aiBrowserEnabled: nextMessage.aiBrowserEnabled,
    thinkingEnabled: nextMessage.thinkingEnabled,
    canvasContext: buildCanvasContext(),
    agentId: nextMessage.agentId || 'leader',
    activeKnowledgeBases: currentKbIds.length > 0 ? currentKbIds : undefined,
  });
}
```

### 修改后

```typescript
// If there were pending messages, send the first one now
// Use pendingMessages captured before set() (function-level scope)
if (pendingMessages.length > 0) {
  const nextPendingMessage = pendingMessages[0];

  // Build canvas context (uses module-level buildCanvasContext)

  // Send the pending message — backend addMessage() writes to DB,
  // next handleAgentComplete reload brings correct ordering.
  // Do NOT add to cache here — that caused off-by-one display bug
  // where the user message appeared under the previous response.
  // Send with CURRENT KB selection (not stale snapshot)
  const { useKnowledgeBaseStore } = await import('./knowledge-base.store');
  const currentKbIds = useKnowledgeBaseStore.getState().activeKnowledgeBaseIds;
  await api.sendMessage({
    spaceId,
    conversationId,
    message: nextPendingMessage.content,
    images: nextPendingMessage.images,
    aiBrowserEnabled: nextPendingMessage.aiBrowserEnabled,
    thinkingEnabled: nextPendingMessage.thinkingEnabled,
    canvasContext: buildCanvasContext(),
    agentId: nextPendingMessage.agentId || 'leader',
    activeKnowledgeBases: currentKbIds.length > 0 ? currentKbIds : undefined,
  });
}
```

### 关键改动

1. **第 2309 行**：`if (nextPendingMessage)` → `if (pendingMessages.length > 0)`，使用函数级作用域已有的 `pendingMessages` 变量
2. **第 2309 行后新增**：`const nextPendingMessage = pendingMessages[0];`，在 `if` 块内声明变量
3. **第 2322-2328 行**：`nextMessage.xxx` → `nextPendingMessage.xxx`，统一使用新声明的变量

### 安全性分析

使用第 2149 行的 `pendingMessages` 快照而非 `set()` 回调内的 `remainingPending` 是安全的：

- `pendingMessages` 是在 `set()` 之前捕获的快照
- `set()` 回调内已将 `pendingMessages` 更新为 `restMessages`（即 `remainingPending.slice(1)`）
- `set()` 是同步的，执行完毕后状态已更新
- 后续的 `api.sendMessage` 会触发新的 `handleAgentComplete`，届时会读取更新后的 `pendingMessages`（即 `restMessages`）
- 这与之前的 `bugfix-pending-message-race-v1` 的修复方向一致：使用可靠的快照而非可能过期的内部状态

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码 | `src/renderer/stores/chat.store.ts` (2147-2358) | 理解 handleAgentComplete 中 pendingMessages 处理的完整逻辑 |
| 源码 | `src/renderer/stores/chat.store.ts` (1220-1294) | 理解 sendMessage 如何写入 pendingMessages |
| 功能设计 | `.project/modules/agent/features/message-send/design.md` | 理解消息发送流程设计 |
| Bug记录 | `.project/modules/agent/features/message-send/bugfix.md` | 查看历史 Bug 记录，避免回归 |
| Bug记录 | `.project/modules/agent/features/message-send/changelog.md` | 查看历史变更记录 |
| 前序修复 | `.project/prd/bugfix/agent/bugfix-pending-message-race-v1.md` | 理解之前的 pendingMessages 竞态修复 |

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/renderer/stores/chat.store.ts` | 修改 — 第 2309 行条件判断改用 `pendingMessages.length > 0`；第 2309 行后新增 `const nextPendingMessage = pendingMessages[0]`；第 2322-2328 行 `nextMessage` 统一改为 `nextPendingMessage` |

## 验收标准

- [ ] `handleAgentComplete` 不再抛出 ReferenceError
- [ ] 有 pendingMessages 时能正确发送下一条消息
- [ ] 无 pendingMessages 时正常完成对话
- [ ] `npm run typecheck` 中 chat.store.ts 无新增错误
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-06-01 | 初始 Bug 修复 PRD | @misakamikoto |
