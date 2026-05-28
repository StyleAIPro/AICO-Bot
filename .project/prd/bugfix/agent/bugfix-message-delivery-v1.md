# Bugfix: 生成中发送消息丢失（竞态条件）+ 空闲后重建会话模型不读新指令

## 元信息

- **时间**：2026-05-13
- **状态**：draft
- **指令人**：用户
- **PRD 级别**：bugfix

## 问题描述

本 PRD 覆盖两个相关的消息发送 bug，均影响用户消息的可靠性送达。

---

### Bug 1：生成中发送消息丢失（竞态条件）

#### 现象

用户在 Agent 生成过程中发送新消息，消息被静默丢弃，模型不会回复该消息。

#### 触发条件

1. Agent 正在生成回答
2. 后端发出 `agent:turn-boundary` 事件
3. 前端检测到 `pendingMessages` 并调用 `api.injectMessage()`
4. IPC round-trip 耗时超过 300ms

#### 根因分析

**核心文件**：`src/renderer/App.tsx`（第 370-396 行）turn-boundary handler

**时序问题**：

```
后端 process-stream.ts                前端 App.tsx                     注入队列
──────────────────────                ──────────────                   ─────────
turn-boundary 事件 ──────────────►  收到事件
                                     injectMessage() ──IPC──►  queueInjection()
                                      |
                                      |  (.then() 等待 IPC 返回)
300ms setTimeout 到期 ◄────────────── |                    ◄── IPC 返回较慢
hasPendingInjection() = false         .then() 执行
                                      removePendingMessage() ─►  前端队列清空
                                      注入未触发，消息丢失
```

具体流程：
1. 后端 `process-stream.ts:885-904` 发出 `agent:turn-boundary` 后等待 300ms
2. 前端 `App.tsx:370-396` 收到事件，异步调用 `api.injectMessage()`（IPC round-trip）
3. `.then()` 回调中执行 `removePendingMessage()` 从前端 `pendingMessages` 删除
4. **竞态**：如果 IPC round-trip 超过 300ms，后端 `hasPendingInjection()` 在注入到达前返回 false → 后端不处理注入 → 但前端已从 `pendingMessages` 删除 → 消息丢失
5. **反向竞态**：如果 `.then()` 在 `handleAgentComplete` 检查 `pendingMessages` 之后才执行，则 `handleAgentComplete` 会兜底发送该消息 → 导致双重发送

**根本问题**：前端在 IPC 返回（异步）时就删除 `pendingMessages`，但后端的实际注入可能在更晚时刻完成或失败。前端删除时机与后端注入确认之间没有可靠的同步机制。

---

### Bug 2：空闲后重建会话模型不读新指令

#### 现象

对话空闲约 45 分钟后发送新消息，模型回复系统介绍（"你好！我是 AICO-Bot..."），未处理用户指令。Token 用量显示 20460 cache read + 仅 100 input，模型 thinking 显示 "The user is greeting me"。

#### 触发条件

1. 对话空闲超过 30 分钟（session 被健康监控清理）
2. 用户发送新消息
3. 使用非 Claude 模型（如 GLM），该模型将 `resume` 视为新对话开始

#### 根因分析

**核心文件**：`src/main/services/agent/session-health.ts`、`src/main/services/agent/session-lifecycle.ts`、`src/main/services/agent/send-message-local.ts`

1. 空闲 30 分钟后，`session-health.ts:396-398` 清理 session：`cleanupSession(convId, 'idle timeout (30 min)')`
2. 用户发新消息时，`send-message-local.ts:378` 调用 `getOrCreateV2Session()`，因 `v2Sessions` 中已无该 conversationId 的条目，创建新 session
3. 新 session 通过 `resume=sessionId` 恢复历史，SDK 从 JSONL 加载完整历史（20460 cache tokens）
4. **GLM 等非 Claude 模型**将 `resume` 后的首条消息视为"新对话开始"，忽略已加载的历史上下文，回复系统介绍

**根本问题**：新建 session（非复用）时，没有向模型明确指示"这是已有对话的延续"。对于原生 Claude 模型，resume 机制能正确恢复上下文；但对于通过 OpenAI 兼容层路由的非 Claude 模型，resume 后的首条消息被误解为新对话。

---

## 技术方案

### Bug 1 修复：基于 injection-start 事件的可靠确认

**改动范围**：`src/renderer/App.tsx`（~20 行）

**方案**：

1. **删除** `App.tsx` turn-boundary handler 中的 `.then(() => removePendingMessage())`（第 385-393 行）
2. **新增**监听 `agent:injection-start` 事件（后端 `send-message-local.ts:588` 已发射），在 handler 中按 `content` 匹配并从 `pendingMessages` 移除
3. `handleAgentComplete` 中已有的兜底逻辑不变——如果 `agent:injection-start` 未触发（注入失败），`handleAgentComplete` 会处理剩余的 `pendingMessages`

**事件流（修复后）**：

```
后端 process-stream.ts                前端 App.tsx                     注入队列
──────────────────────                ──────────────                   ─────────
turn-boundary 事件 ──────────────►  收到事件
                                     injectMessage() ──IPC──►  queueInjection()
                                      |  (不删除 pendingMessages)
300ms setTimeout 到期                 |
hasPendingInjection() = true          |                    ◄── IPC 返回
后端处理注入                           |
                                     agent:injection-start ────────► 按 content 匹配
                                                                removePendingMessage()
```

**为什么安全**：
- `agent:injection-start` 只在后端实际开始处理注入时发射，是可靠的确认信号
- 如果注入失败（IPC 超时等），`agent:injection-start` 不会发射 → `pendingMessages` 保留 → `handleAgentComplete` 兜底发送
- 不修改后端任何逻辑，仅修改前端消息移除时机

### Bug 2 修复：新建 session 时添加消息前缀

**改动范围**：`src/main/services/agent/send-message-local.ts`（~15 行）

**方案**：

在 `sendMessage()` 中，当 `getOrCreateV2Session()` 返回后检测 session 是否为新建（非复用），若是则在消息内容前添加提示前缀：

```typescript
// 在 getOrCreateV2Session 调用之前检查 session 是否已存在
const existingSession = v2Sessions.has(conversationId);
let v2Session = await getOrCreateV2Session(spaceId, conversationId, { ... });

// 检测是否新建了 session（之前不存在）
const isNewSession = !existingSession;

// ... (后续 messageContent 构建之后)

// 新建 session 时添加提示前缀，帮助模型理解这是对话延续
const finalMessageContent = isNewSession
  ? `[System Note: 这是已有对话的延续，请直接回复用户的最新消息。]\n\n${messageContent}`
  : messageContent;
```

**关键设计决策**：
- 前缀仅添加到发送给 SDK 的消息（`messageContent`），不影响前端显示（`message` 变量独立）
- `v2Sessions.has(conversationId)` 在 `getOrCreateV2Session` 调用前检查即可，因为 `getOrCreateV2Session` 内部如果发现需要重建 session 会先 `delete` 再创建
- 前缀为中文，与用户界面语言一致，模型能正确理解

**为什么安全**：
- 正常多轮对话（session 复用）不添加前缀
- 前缀仅影响 SDK 发送给模型的内容，前端显示不受影响
- 对于原生 Claude 模型，前缀无害（模型会正确理解上下文）
- 对于非 Claude 模型（GLM 等），前缀明确指示这是对话延续，避免模型误解为问候

---

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码 | `src/renderer/App.tsx` (357-398) | 理解 turn-boundary handler 和 injectMessage 调用 |
| 源码 | `src/main/services/agent/process-stream.ts` (885-904) | 理解 turn-boundary 等待和注入检测逻辑 |
| 源码 | `src/main/services/agent/stream-injection.ts` | 理解注入队列管理（queueInjection / hasPendingInjection） |
| 源码 | `src/main/services/agent/send-message-local.ts` (378-432) | 理解 session 获取和消息构建流程 |
| 源码 | `src/main/services/agent/session-lifecycle.ts` (214-296) | 理解 session 复用/新建判断逻辑 |
| 源码 | `src/main/services/agent/session-lifecycle.ts` (298-376) | 理解 session 创建流程（resume 参数处理） |
| 源码 | `src/renderer/stores/chat.store.ts` (1827-2038) | 理解 handleAgentComplete 和 pendingMessages 兜底逻辑 |
| 源码 | `src/main/services/agent/session-health.ts` (291-401) | 理解空闲 30 分钟清理逻辑 |
| Bug记录 | `.project/modules/agent/features/message-send/bugfix.md` | 理解已有的消息发送 bug 修复（BUG-003, BUG-004），避免回归 |

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/renderer/App.tsx` | 修改 — 删除 `.then(removePendingMessage)`，新增 `agent:injection-start` 事件监听 |
| `src/main/services/agent/send-message-local.ts` | 修改 — 新建 session 时添加消息前缀 |
| `.project/modules/agent/features/message-send/bugfix.md` | 修改 — 新增 BUG-005 记录 |
| `.project/modules/agent/features/message-send/changelog.md` | 修改 — 新增变更行 |

## 验收标准

### Bug 1：生成中发送消息丢失

- [ ] 正常多轮对话（不中断）行为不变
- [ ] 生成过程中发送消息：消息不丢失，模型能回复
- [ ] 快速连续发送多条消息：所有消息都被处理
- [ ] 注入失败时 `handleAgentComplete` 兜底发送，消息不丢失
- [ ] 不会出现双重发送（同一消息被处理两次）

### Bug 2：空闲后重建会话模型不读新指令

- [ ] 正常多轮对话（session 复用）不添加前缀
- [ ] 空闲后首次发消息（session 新建）添加前缀
- [ ] 中止后发消息（session 新建）添加前缀
- [ ] 添加前缀后模型正确处理用户指令（不再回复系统介绍）
- [ ] 前端显示的用户消息不包含前缀内容

### 通用

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
