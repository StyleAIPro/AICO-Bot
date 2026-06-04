# Bugfix: Leader 向 Worker 发送消息卡死

## 元信息

- **时间**：2026-05-28
- **状态**：done
- **指令人**：mi-saka
- **PRD 级别**：bugfix

## 问题描述

Leader Agent 通过 `spawn_subagent` MCP 工具将任务分配给 Worker Agent 时，可能卡死。表现为：会超时但等待时间很长，触发条件不确定，不只是消息大小的问题。

**已确认的场景**：Leader 分配任务给 Worker 时卡死（不是 Worker 返回结果时）。

## 根因分析

经过代码审查，发现以下多个相互关联的问题导致 Leader 向 Worker 发送消息时卡死：

### 问题 1：mailbox 文件写入非原子操作 + 无文件锁（CRITICAL）

**文件**: `src/main/services/agent/mailbox.ts:345-372`

`writeMailboxFileAtomic` 方法声称使用"write-then-rename 原子模式"，但实际实现是：

```typescript
writeFileSync(tmpPath, JSON.stringify(mailbox, null, 2), 'utf-8');
writeFileSync(filePath, readFileSync(tmpPath, 'utf-8'), 'utf-8'); // NOT atomic!
```

没有使用 `renameSync`，所以不是原子操作。在 Windows 上尤其危险——两个进程（Leader 和 Worker）可能同时读写同一个 mailbox 文件。

`postMessage` 和 `pollMessages` 都是 read-modify-write 模式，但没有任何文件锁：
1. Process A 读取文件 [msg1, msg2, msg3]
2. Process B 读取文件 [msg1, msg2, msg3]
3. Process A 追加 msg4，写入 [msg1, msg2, msg3, msg4]
4. Process B 追加 msg5，写入 [msg1, msg2, msg3, msg5] — msg4 丢失！

### 问题 2：消息大小无限制（HIGH）

整个消息管道没有任何大小验证：
- `MailboxMessage.content` 是无约束的 `string`
- `postMessage()` 不验证消息大小
- `queueInjection()` 不验证内容大小
- `injectMessageToSession()` 直接传递内容到 `queueInjection`
- `sendAnnouncement()` 不验证 result 大小
- Worker 完成后返回的 result 可能耗尽 mailbox 文件空间或 SDK 的消息缓冲区

### 问题 3：mailbox 文件无限增长（HIGH）

Messages 只追加不修剪。随着 `task_progress`、`idle_notification` 等广播消息积累，文件会越来越大。每次操作都要读写整个文件，最终导致 I/O 性能严重下降或 JSON 解析失败。

### 问题 4：pollMessages 静默吞掉错误（MEDIUM）

**文件**: `src/main/services/agent/mailbox.ts:202-205`, `src/main/services/agent/persistent-worker.ts:151`

`pollMessages()` 在出错时返回空数组（第 203-205 行的 catch 块）。如果 mailbox 文件损坏（因为问题 1），Worker 永远收不到消息，也不会有任何错误提示。

### 问题 5：Leader 的 while(true) 循环 processStream 无超时（MEDIUM）

**文件**: `src/main/services/agent/orchestrator.ts:504-727`

`processStream()` 调用没有显式超时。如果 SDK 进程挂起，整个 Leader 循环会永久阻塞。

### 问题 6：spawn_subagent fire-and-forget 错误被吞（MEDIUM）

**文件**: `src/main/services/agent/hyper-space-mcp.ts:123`

`executeAllTasks()` 调用不 await，错误只 `console.error`（第 123-125 行）。Leader 收到"任务已派发"的响应，但实际可能立即失败了。

### 问题 7：Windows 临时文件清理可能失败（LOW）

**文件**: `src/main/services/agent/mailbox.ts:357`

Windows 上如果杀毒软件扫描临时文件，`unlinkSync` 可能失败。临时文件可能累积。

## 技术方案

### 步骤 1：mailbox 文件操作原子化 + 文件锁

**文件**: `src/main/services/agent/mailbox.ts`

1.1 将 `writeMailboxFileAtomic` 改为真正使用 `renameSync`（NTFS 上是原子操作）：

```typescript
private writeMailboxFileAtomic(filePath: string, mailbox: MailboxFile): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(mailbox, null, 2), 'utf-8');
  renameSync(tmpPath, filePath); // 真正的原子操作
}
```

注意：`renameSync` 在 Windows 上要求源文件和目标文件在同一目录。当前的 `${filePath}.tmp` 已经满足此条件。

1.2 使用 `proper-lockfile` 或简单的文件锁机制防止并发读写。方案选择：
- **选项 A**：使用 `proper-lockfile` npm 包（生产级，支持跨平台）
- **选项 B**：实现简单的 retry-read-if-stale 模式（自定义，零依赖）

推荐选项 A，更可靠。

1.3 在 `readMailboxFile` 中增加 JSON 解析错误处理和自动恢复：
- 如果 JSON 解析失败，尝试从 `.tmp` 文件恢复
- 如果恢复失败，记录错误并返回空 mailbox（不丢弃文件，保留用于手动恢复）

### 步骤 2：消息大小限制 + 内容截断

**文件**: `src/main/services/agent/mailbox.ts`, `src/main/services/agent/stream-injection.ts`, `src/main/services/agent/orchestrator.ts`

2.1 定义消息大小常量：

```typescript
const MAX_MAILBOX_MESSAGE_SIZE = 100 * 1024; // 100KB
const MAX_INJECTION_CONTENT_SIZE = 200 * 1024; // 200KB（SDK 消息需要更大）
const MAX_RESULT_SIZE = 50 * 1024; // 50KB（Worker 返回结果）
```

2.2 在 `postMessage()` 中增加大小检查：

```typescript
const contentSize = Buffer.byteLength(JSON.stringify(fullMessage), 'utf-8');
if (contentSize > MAX_MAILBOX_MESSAGE_SIZE) {
  log.warn(`Message to ${recipientId} too large (${contentSize} bytes), truncating`);
  fullMessage.content = fullMessage.content.slice(0, MAX_MAILBOX_MESSAGE_SIZE) +
    `\n\n[... truncated, original size: ${contentSize} bytes]`;
}
```

2.3 在 `queueInjection()` 中增加大小检查和截断。

2.4 在 `sendAnnouncement()` 和 `injectMessageToSession()` 中截断过大的 result。

### 步骤 3：mailbox 消息修剪

**文件**: `src/main/services/agent/mailbox.ts`

3.1 在 `postMessage()` 中增加自动修剪逻辑：
- 保留最近 N 条消息（建议 N=100）
- 删除超出阈值的消息时，同时更新 `lastReadIndex`（避免游标指向已删除的消息）

3.2 新增 `compactMailbox()` 方法用于手动触发修剪。

### 步骤 4：pollMessages 错误暴露

**文件**: `src/main/services/agent/mailbox.ts`, `src/main/services/agent/persistent-worker.ts`

4.1 让 `pollMessages()` 在错误时抛出异常而不是静默返回空数组。或者增加返回值包含错误信息。

4.2 `persistent-worker.ts` 在 `pollMessages` 返回空数组时，偶尔检查 mailbox 文件是否可读（如每 30 秒一次健康检查）。

### 步骤 5：processStream 超时保护

**文件**: `src/main/services/agent/orchestrator.ts`

5.1 在 Leader 的 `while(true)` 循环中，为每次 `processStream()` 调用增加超时保护：
- 使用 `Promise.race` 包裹 `processStream()` 和一个超时 Promise
- 默认超时时间：30 分钟（与 `waitForCompletion` 一致）
- 超时后触发 abort 并进入下一轮循环

### 步骤 6：spawn_subagent 错误反馈

**文件**: `src/main/services/agent/hyper-space-mcp.ts`

6.1 将 `executeAllTasks()` 的结果通过事件通知 Leader：
- 成功：已有现有机制
- 失败：通过 `injectMessageToSession()` 通知 Leader 任务执行失败

## 开发前必读

### 模块设计文档

| 文档 | 路径 | 阅读目的 |
|------|------|---------|
| 持久化 Worker 与任务板 | `.project/modules/agent/features/worker-management/design.md` | 理解 mailbox 和 persistent worker 架构 |
| 持久化 Worker Bug 记录 | `.project/modules/agent/features/worker-management/bugfix.md` | 了解已知问题 |
| Worker 管理 Bug 记录 | `.project/modules/agent/features/worker-management/bugfix.md` | 了解已知问题 |
| Agent 核心模块 | `.project/modules/agent/agent-core-v1.md` | 理解 Agent 架构 |
| 流处理设计 | `.project/modules/agent/features/stream-processing/design.md` | 理解 processStream 的实现 |
| SDK Session 设计 | `.project/modules/agent/features/sdk-session/design.md` | 理解 SDK 会话管理 |

### 源码文件

| 文件 | 阅读目的 |
|------|---------|
| `src/main/services/agent/mailbox.ts` | 核心邮箱服务，修复原子写入 + 文件锁 + 消息大小 + 修剪 |
| `src/main/services/agent/orchestrator.ts` | 核心编排器，修复 processStream 超时 + 注入消息截断 |
| `src/main/services/agent/stream-injection.ts` | 消息注入队列，增加大小限制 |
| `src/main/services/agent/persistent-worker.ts` | Worker 轮询循环，增加错误暴露 |
| `src/main/services/agent/hyper-space-mcp.ts` | MCP 工具，修复 fire-and-forget 错误反馈 |
| `src/shared/types/mailbox.ts` | 邮箱类型定义 |
| `src/shared/types/hyper-space.ts` | HyperSpace 类型定义 |

### 编码规范

| 文档 | 阅读目的 |
|------|---------|
| `docs/Development-Standards-Guide.md` | TypeScript strict、IPC handler try/catch + `{ success, data/error }` 格式 |
| `docs/vibecoding-doc-standard.md` | 文档更新规范、PRD 状态流转 |

## 涉及文件（实际）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/mailbox.ts` | 修改 | 修复原子写入（renameSync）、mtime 并发检测 + 重试、消息大小限制（100KB）、自动修剪（100 条）、JSON 解析错误恢复、pollMessages 错误抛出、isMailboxHealthy 健康检查 |
| `src/main/services/agent/orchestrator.ts` | 修改 | processStream 30 分钟超时保护、Worker result 截断（50KB）、injectMessageToSession 改为 public |
| `src/main/services/agent/stream-injection.ts` | 修改 | 注入内容大小限制（200KB） |
| `src/main/services/agent/persistent-worker.ts` | 修改 | pollMessages 错误包裹 + 定期 mailbox 健康检查 |
| `src/main/services/agent/hyper-space-mcp.ts` | 修改 | executeAllTasks 失败时通过 injectMessageToSession 通知 Leader |

## 验收标准

- [x] **原子写入**：mailbox 文件写入使用 `renameSync`，不再是 write-copy 模式
- [x] **文件锁**：并发读写 mailbox 文件通过 mtime 检测 + 重试机制避免数据丢失
- [x] **消息大小限制**：超出限制的消息被截断并记录警告日志
- [x] **自动修剪**：mailbox 文件不会无限增长，超过 100 条消息时自动修剪
- [x] **错误暴露**：mailbox 文件损坏时 Worker 能检测到并报告错误
- [x] **processStream 超时**：Leader 的 processStream 不会无限阻塞（30 分钟超时）
- [x] **错误反馈**：Worker 任务执行失败时 Leader 能收到通知
- [x] **构建通过**：`npm run typecheck && npm run build` 通过（无新增 TS 错误）
- [ ] **无回归**：正常的 Leader-Worker 通信不受影响（需人工验证）
- [ ] **Windows 兼容**：所有修改在 Windows 上正常工作（需人工验证）
