# Bug 记录 -- 消息发送流程

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 4 |
| Minor | 0 |

## BUG-003: handleAgentComplete 竞态条件导致排队消息丢失

- **严重程度**：Major
- **发现时间**：2026-05-10
- **状态**：已修复
- **触发条件**：AI 完成回答后，在 `await api.getConversation()` 期间用户快速发送新消息
- **现象**：UI 显示用户消息 + 空白思考框，消息永不发送，session 卡死在 `isGenerating: true`
- **根因**：`handleAgentComplete` 在 `await` 之前预拍 `pendingMessages` 快照（空数组），`await` 期间新排入的消息不在快照中，导致发送判断跳过
- **修复**：删除预拍快照，改在 `set()` 回调内读取最新 `pendingMessages` 并通过闭包变量传出；错误分支不再清空 `pendingMessages`
- **PRD**：`bugfix-pending-message-race-v1`

## BUG-004: 中止后安全超时复用卡死会话导致 0s 思考 + 旧输入延续

- **严重程度**：Major
- **发现时间**：2026-05-13
- **状态**：已修复
- **触发条件**：用户点击停止 → SDK 子进程未在 5s 内响应 interrupt → 前端 10s 安全超时触发 → 用户发送新消息
- **现象**：思考过程显示 0s，Agent 未读取最新输入，表现为延续之前的对话内容
- **根因**：`getOrCreateV2Session` 复用已有会话时不检查 `activeSessions` 中是否存在已 abort 但卡住的旧请求。旧 `processStream` 卡在 `for await` 循环中，v2Sessions 中旧会话 transport 仍看似 ready，新 sendMessage 直接复用 → 两个并发 stream 消费者 → 旧恢复后 `closeV2Session()` 杀死新会话
- **修复**：`getOrCreateV2Session` 开头增加 `activeSessions` 检查，若存在已 abort 的条目则先 `activeSessions.delete` + `closeV2SessionForRebuild`，再 fall through 创建新会话
- **PRD**：`bugfix-stuck-session-reuse-v1`

## BUG-006: 回复错位（off-by-one）— 三重修复

- **严重程度**：Major
- **发现时间**：2026-05-13
- **状态**：已修复
- **触发条件**：用户在 Agent 生成过程中发送新消息
- **现象**：导出/刷新后，每条 assistant 回复显示在下一条 user 消息下方（off-by-one）。例如用户依次发送 "容器"、"加法"、"你好"，但 docker 结果出现在 "加法" 下方，5050 出现在 "你好" 下方
- **根因（三层）**：
  1. **注入循环缺少 addMessage**：`send-message-local.ts` 注入 continuation 循环未将注入的 user 消息和 assistant placeholder 持久化到 DB，`updateLastMessage` 更新上一个 placeholder 导致覆盖
  2. **注入续接缺少 continuation prefix**：注入续接的 `processStream` 发送消息给 SDK 时，非 Claude 模型看到上一条空回复后忽略当前消息，回复上一条（如 "加法" 发过去但模型回复 docker 结果）
  3. **auto-stop 中断后缺少 continuation prefix**：auto-stop 中断当前生成后，`isNewSession=false`（session 复用），continuation prefix 不生效，模型同样回复上一条消息
- **修复**：
  1. 注入循环中添加 `addMessage(user)` + `addMessage(assistant_empty)`，与正常 `sendMessage` 路径一致
  2. 注入续接的 `injectionContent` 添加 continuation prefix
  3. `sendMessage` 检测上一条 assistant 回复为空时（`hadEmptyPreviousResponse`），扩展 continuation prefix 条件为 `isNewSession || hadEmptyPreviousResponse`
- **PRD**：bugfix-message-delivery-v1（Bug 3）

## BUG-005: 生成中发送消息丢失 + 空闲后重建会话模型不读新指令

- **严重程度**：Major
- **发现时间**：2026-05-13
- **状态**：已修复
- **触发条件**：
  - Bug A：生成过程中发送消息，且 IPC round-trip 超过后端 300ms 注入窗口
  - Bug B：对话空闲超过 30 分钟后发送新消息，使用非 Claude 模型
- **现象**：
  - Bug A：消息静默丢失，模型不回复
  - Bug B：模型回复系统介绍（"你好！我是 AICO-Bot..."），未处理用户指令
- **根因**：
  - Bug A：`App.tsx` turn-boundary handler 中 `.then(removePendingMessage)` 的异步删除与后端 300ms 等待窗口存在竞态条件——IPC 返回后删除了 pendingMessages，但后端已错过注入窗口
  - Bug B：新建 session 通过 `resume` 恢复历史后，非 Claude 模型将 resume 视为"新对话开始"，忽略用户消息
- **修复**：
  - Bug A：删除 `.then(removePendingMessage)`，改为监听已有的 `agent:injection-start` 事件（后端确认信号）来安全移除，注入失败时 handleAgentComplete 兜底发送
  - Bug B：新建 session 时在 SDK 消息前添加 continuation prefix，提示模型这是对话延续
- **PRD**：`bugfix-message-delivery-v1`
