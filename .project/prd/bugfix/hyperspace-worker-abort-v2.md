# PRD [Bug 修复级] — HyperSpace Leader 因配置变化误杀 Worker 会话（第二条根因）

> 版本：bugfix-hyperspace-worker-abort-v2
> 日期：2026-05-29
> 状态：done
> 指令人：misakamikoto
> 归属模块：modules/space (features/hyper-space, worker-management)
> 优先级：P0

## 背景：与 v1 的关系（必读）

本 PRD 与已完成的 [`hyperspace-worker-abort-v1.md`](./hyperspace-worker-abort-v1.md) 修复的是**同一症状（Leader 报「Claude Code process aborted by user」、Worker 掉线）的两条完全不同的根因路径**。

- **v1（已 done）**：根因是**前端 30 秒不活跃计时器误杀**——Leader 等待 Worker 期间不向前端发事件，前端计时器超时调用 `stopGeneration`。v1 的修复是**后端心跳 + 前端 worker 事件更新 `lastActivityAt`**（commit `a80c761`，orchestrator 心跳 + 前端 `lastActivityAt`）。
- **v2（本次）**：根因是**后端「API 配置变化 → 会话失效」链路中的 conversationId key 不匹配**，导致 Leader 在途会话的「在途保护」失效而被直接关闭。

**关键结论：v1 的心跳修复对本 bug 无效。** v1 解决的是「前端误判超时」，v2 解决的是「后端配置变化事件直接关闭在途会话」。两者触发源、调用链、修复点均不同。

## 问题描述

- **期望行为**：HyperSpace 中 Leader 分派任务给 Worker 后，在 Worker 执行期间，即使后台 API/AI Sources 配置发生变化，Leader 的在途会话也应受「在途保护」，**延迟**到本轮请求结束后再重建，而非被立即关闭。Leader 应持续等待直到 Worker 完成或发生真实错误。
- **实际行为**：Leader 分发任务后，**过一段不固定的时间**（取决于配置何时变化）报错 `Error: Claude Code process aborted by user`，堆栈底部为 `Timeout._onTimeout (sdk.mjs:64) -> AbortController.abort`。日志示例：`agent:send-message -> fail 887958ms`（约 14.8 分钟）。Worker 随后处于掉线/无法连接状态。
- **复现步骤**：
  1. 创建 Hyper Space（Leader + 若干 Worker）。
  2. Leader 分派任务给 Worker（典型场景：让 Leader 去**检查各个 Worker 的配置情况**），Leader 进入 `processStream` 的 `for await` 等待 Worker 阶段。
  3. 在 Leader 等待期间，触发任意 API/AI Sources 配置变化（`aiSources` 签名变更——例如切换/编辑 AI 源、改 apiKey/apiUrl/provider）。
  4. 配置变化触发 `invalidateAllSessions()`，由于 key 不匹配，Leader 的子会话「在途保护」失效，被立即 `cleanupSession`。
  5. SDK `close()` 的 5 秒宽限定时器到期后触发 `abortController.abort()`，Leader 报 `Claude Code process aborted by user`，Worker 掉线。
- **不固定时间特征**：报错由「配置变化事件」驱动而非固定周期，所以「过一段时间」（毫秒级到十几分钟不等）才报错，且只在配置变化时复现。

## 根因分析

### 触发源：API 配置变化 → invalidateAllSessions

- `src/main/services/config.service.ts:947-948`：`getAiSourcesSignature(newConfig.aiSources)` 计算新签名，与 `previousAiSourcesSignature`（L897）比较得到 `aiSourcesChanged`。
- `src/main/services/config.service.ts:957-974`：当 `apiChanged || aiSourcesChanged` 且存在订阅者时，通过 `setTimeout` 异步调用全部 `apiConfigChangeHandlers`。
- `src/main/services/agent/session-lifecycle.ts:676-678`：模块加载时通过 `onApiConfigChange(() => { invalidateAllSessions(); })` 注册回调。
- 因为是**配置变化事件驱动**（而非固定周期），所以报错时间不固定。

### 核心 Bug：conversationId key 不匹配（`executeAgentLocally`）

位于 `src/main/services/agent/orchestrator.ts` 的 `executeAgentLocally` 方法（L375 起）：

1. **V2 session 以 childConversationId 为 key 存储**：
   - L410：`const childConversationId = \`${conversationId}:agent-${agent.id}\`;`
   - L484：`getOrCreateV2Session(spaceId, childConversationId, {...})` —— `v2Sessions` Map 以 **childConversationId** 为 key。
2. **activeSessions 却以 parent conversationId 为 key 注册**：
   - L495-496：`const sessionState = createSessionState(spaceId, conversationId, abortController);` 后 `registerActiveSession(conversationId, sessionState);` —— `activeSessions` 以 **parent conversationId** 为 key。

→ 两个 Map 的 key 不一致：`v2Sessions` 用 child，`activeSessions` 用 parent。

### 失效链：在途保护被绕过

- `invalidateAllSessions()`（`session-lifecycle.ts:601-622`）遍历 `v2Sessions.keys()`（全是 **childConversationId**），用 `activeSessions.has(convId)`（L612）判断「请求是否在途、是否需延迟关闭」。
- 由于 key 不匹配，`activeSessions.has(childConversationId)` **恒为 false** → 跳过 `pendingInvalidations.add` 的延迟分支 → 直接执行 `cleanupSession(childConversationId, 'API config change')`（L618）。
- `cleanupSession`（`session-health.ts:305-329`）调用 `info.session.close()`（L317）释放 FD。

### SDK close() → 5 秒后 abort

- SDK 的 `close()`（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:64`，已 minify）逻辑为：`this.inputStream.done(); setTimeout(() => { if (!signal.aborted) abortController.abort() }, B2)`，其中宽限期 `B2 = 5000`（5 秒）。
- 此时 Leader 仍阻塞在 `processStream` 的 `for await (... v2Session.stream())` 中等待 Worker，5 秒后宽限定时器触发 `abortController.abort()`。
- SDK transport 的 process error handler（`sdk.mjs:59` 附近）因 `signal.aborted` 设置 `exitError = "Claude Code process aborted by user"` → `processStream` 抛出 → orchestrator catch 报 `Hyper Space execution error` → 发送 `agent:error` → 前端 `handleAgentError`。

### 为何专属 executeAgentLocally

orchestrator 中另一条本地执行路径（`registerActiveSession(childConversationId, sessionState)`，约 L2155）用的注册 key 与 `v2Sessions` 一致（均为 childConversationId），因此 `invalidateAllSessions` 的 `activeSessions.has(convId)` 能命中，在途保护生效，**不受本 bug 影响**。

**本 bug 仅存在于 `executeAgentLocally`（Leader / @mention worker 路径）。**

### 同样受 key 不匹配影响的次生问题

- `session-health.ts:388-395` 的 **Check 4（idle 清理）**：用 `activeSessions.has(convId)` 跳过在途会话。由于 convId 是 childConversationId 而 activeSessions 注册的是 parent，Leader 长时间等待 Worker 时该会话也可能被误判为 idle（30 分钟后）而清理。修复同一 key 对齐问题后此风险一并解除。

## 技术方案（最小修复 — 双重修复）

### 修复点 A：activeSessions key 对齐

让 `executeAgentLocally` 中 `activeSessions` 的注册 key 与 `v2Sessions` 的 key（childConversationId）对齐，使 `invalidateAllSessions` / session-health Check 4 的在途保护对该会话生效。

- **双 key 注册**：在 L503 追加 `registerActiveSession(childConversationId, sessionState)`，parent key 保留（`stopGeneration` 依赖它）。

### 修复点 B：onComplete 过早注销 activeSessions（真正根因）

`onComplete` 回调在每轮 `processStream` 结束时触发。当 `hasPendingInjection=false` 时，原代码在此处注销 `activeSessions`。然而 orchestrator while 循环可能还要进入 `waitForCompletion`（等 worker 完成，可阻塞 30+ 分钟）。注销后 `activeSessions` 为空 → 30 分钟后 session-health idle cleanup 命中 → `cleanupSession` → SDK abort。

- **修复**：将 `unregisterActiveSession` 从 `onComplete` 移到 while 循环的 `finally` 块，确保整个 while 循环生命周期（含 `waitForCompletion`）期间 activeSessions 始终有效。
- max-injection-cycles 退出点的冗余注销也删除（finally 块统一处理）。
- catch 块保留注销（覆盖 session 创建前就抛异常的边界情况）。

### 关键约束

1. **不能删除 parent key 注册**：`stopGeneration` 用 parent conversationId 查 `activeSessions`。
2. **不要改动 parent conversationId 的路由逻辑**（processStream 事件路由、injection、pendingAnnouncements 等）。
3. **`unregisterActiveSession` 触发 `pendingInvalidations` 清理是符合预期的**（child key 注销时会 `closeV2Session(child)`，正是正确的 session）。

### 编码注意事项

- **编辑文件后必须 re-read**（Windows 行尾覆盖问题）。
- TypeScript strict，禁止 `any`（用 `unknown`），纯类型导入用 `import type`。
- 一 PRD 一 commit，commit message 引用本 PRD 路径。

## 开发前必读

| 分类 | 文件 | 关注点 / 阅读目的 |
|------|------|------|
| 核心修复点 | `src/main/services/agent/orchestrator.ts` | `executeAgentLocally`（L375 起）：childConversationId 生成（L410）、V2 session 创建（L484）、`registerActiveSession(conversationId, ...)`（L496）、`unregisterActiveSession(conversationId)` 退出点（L608/655/692/805）。**这是要改的方法，需精确定位双 key 注册/注销点。** |
| 失效链 | `src/main/services/agent/session-lifecycle.ts` | `invalidateAllSessions`（L601-622，遍历 `v2Sessions.keys()` + `activeSessions.has` 判断）、`invalidateSession`（L584-594）、`registerActiveSession`/`unregisterActiveSession`（L647-661）、`pendingInvalidations`（L56）、`onApiConfigChange` 注册（L676-678）。**理解 key 匹配如何决定「延迟关闭 vs 立即清理」。** |
| close 调用点 | `src/main/services/agent/session-health.ts` | `cleanupSession`（L305-329，L317 `info.session.close()`）、`startSessionCleanup` 的 Check 4（L388-398，`activeSessions.has` 跳过 idle）。**确认关闭与 idle 清理同样依赖 activeSessions key。** |
| 约束来源 | `src/main/services/agent/control.ts` | `stopGeneration`（L25 起，L40 `activeSessions.get(conversationId)`、L48 `abort()`）。**确认停止生成依赖 parent key，因此必须保留 parent 注册。** |
| 触发源 | `src/main/services/config.service.ts` | `getAiSourcesSignature`（L754）、API 配置变化判定与通知（L947-974）。**理解 bug 由配置变化事件驱动、时间不固定的原因。** |
| 参考路径 | `src/main/services/agent/orchestrator.ts` | 不受影响的本地路径 `registerActiveSession(childConversationId, ...)`（约 L2155）及其注销点（约 L2227/2259/2304）。**作为「正确 key 对齐」的对照样例。** |

## 涉及文件（实际）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/orchestrator.ts` | 修改 | **修复 A**：L503 追加 `registerActiveSession(childConversationId, sessionState)` 双 key 注册。**修复 B**：L613-619 删除 `onComplete` 中的 `unregisterActiveSession` 并替换为注释说明；L665/702 删除 max-injection 退出路径的冗余注销；L812-816 finally 块添加统一注销（parent+child）；L818-823 catch 块保留双 key 注销。 |

## 验收标准（逐条可勾选）

- [x] **配置变化期间 Leader 不被误 abort**：Leader 分发任务并进入等待 Worker 阶段时，触发 API/AI Sources 配置变化（`aiSources` 签名变更），Leader **不再**报 `Claude Code process aborted by user`；该会话被加入 `pendingInvalidations` 延迟到本轮结束后重建。
- [x] **Worker 不掉线**：上述场景下 Worker 正常完成任务，结果正常注入 Leader，Worker 不进入掉线/无法连接状态。
- [x] **停止生成仍正常**：前端对该 HyperSpace 会话点击「停止生成」时，`stopGeneration(parentConversationId)` 仍能命中 `activeSessions` 并成功 `abort`，生成被正确中止。
- [x] **idle 误清理不再发生**：Leader 长时间（>30 分钟）等待 Worker 期间，session-health Check 4 不再将其误判为 idle 而清理。
- [x] **普通会话不受影响**：非 HyperSpace 的普通对话、远程会话、以及 orchestrator 另一条 `registerActiveSession(childConversationId, ...)` 路径行为均不变。
- [x] **无 activeSessions / pendingInvalidations 泄漏**：所有退出路径（含正常结束、max injection cycles、异常 catch）执行后，`activeSessions` 中 parent 与 child 两个 key 均被清理，`pendingInvalidations` 无残留。
- [x] **类型检查通过**：`npm run typecheck` 无新增错误，未引入 `any`。
- [x] **构建通过**：`npm run build` 无错误。
