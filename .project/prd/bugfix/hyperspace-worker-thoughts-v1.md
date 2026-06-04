# PRD [Bug 修复级] — HyperSpace Worker 思考过程在 WorkerView 中不可见

> 版本：bugfix-hyperspace-worker-thoughts-v1
> 日期：2026-05-28
> 状态：done
> 指令人：mi-saka
> 反馈人：mi-saka
> 归属模块：modules/space (features/hyper-space)
> 优先级：P0

## 问题描述

- **期望行为**：Worker Agent 执行任务时，用户在 WorkerView（Worker 独立 tab）中能实时看到思考过程（thinking）和流式输出（streaming content）
- **实际行为**：Worker 的思考过程经常不显示，WorkerView 为空白或仅有最终结果。在 IPC 事件乱序场景下（thought-delta 比 worker:started 先到达），所有思考过程和中间输出均丢失
- **复现步骤**：
  1. 创建一个 Hyper Space（含 Leader + 至少 1 个 Worker）
  2. 发送消息给 Leader，Leader 通过 `spawn_subagent` 分发任务到 Worker
  3. 切换到 Worker 的独立 tab（WorkerView）
  4. 观察 Worker 的思考过程区域
  5. 思考过程可能完全空白，或仅显示最终结果

## 根因分析

共 4 个相互关联的 BUG，构成 Worker 思考过程丢失链：

### BUG 1：`handleAgentThoughtDelta` 缺少 auto-create 逻辑

**文件**：`src/renderer/stores/chat.store.ts` L2366-2367

`handleAgentThought`（L2248-2268）在 `WorkerSessionState` 不存在时有 auto-create fallback——创建临时 session 并写入 thoughts。但 `handleAgentThoughtDelta`（L2366-2367）**没有**：

```typescript
const ws = newWorkerSessions.get(agentId);
if (!ws) return state; // 静默丢弃
```

**影响**：当 IPC 事件乱序导致 `thought-delta` 比 `worker:started` 或首个 `agent:thought` 先到达时，delta 被静默丢弃，整个思考过程流中断。

### BUG 2：`handleAgentThoughtDelta` 中 `thoughtIndex === -1` 无 auto-create

**文件**：`src/renderer/stores/chat.store.ts` L2369-2370

```typescript
const thoughtIndex = ws.thoughts.findIndex((t) => t.id === thoughtId);
if (thoughtIndex === -1) return state; // thought 不存在，delta 被丢弃
```

**影响**：即使 BUG 1 修复后，如果 `agent:thought`（创建 thought 对象的事件）和 `thought-delta` 之间有其他事件穿插（如多个 Worker 并发），thought 可能尚未被 `handleAgentThought` 创建，后续 delta 都会因 `findIndex === -1` 被丢弃。

### BUG 3：`applyWorkerStreamUpdate` 的 auto-create 缺少 `childConversationId`

**文件**：`src/renderer/stores/chat.store.ts` L261-278

`applyWorkerStreamUpdate` 有 auto-create fallback（当 `ws` 不存在时创建临时 WorkerSessionState），但创建的对象**不包含 `childConversationId`**：

```typescript
const workerSession = ws || {
  agentId,
  agentName: rawData.agentName || agentId,
  taskId: null,
  task: '',
  // ... 其他字段 ...
  // 缺少: childConversationId
};
```

**影响**：`WorkerTabBar.tsx`（L165）依赖 `worker.childConversationId` 触发 `loadWorkerConversation` 从磁盘加载历史消息。临时 session 缺少此字段导致：
- Worker 完成前无法加载历史消息
- Worker 完成后如果 `handleWorkerStarted` 已到达且更新了 session，则需要 `turnStartedAt` 变化触发重新加载

### BUG 4：`handleAgentThought` 的 auto-create 同样缺少 `childConversationId` 和其他必要字段

**文件**：`src/renderer/stores/chat.store.ts` L2251-2266

`handleAgentThought` 的 auto-create 创建的临时 WorkerSessionState 也缺少多个字段：

```typescript
ws = {
  agentId,
  agentName: thought.agentName || agentId,
  taskId: null,
  task: '',
  isRunning: true,
  status: 'running' as const,
  streamingContent: '',
  isStreaming: false,
  thoughts: [],
  isThinking: false,
  textBlockVersion: 0,
  error: null,
  completedAt: null,
  pendingQuestion: null,
  // 缺少: childConversationId, interactionMode, turnStartedAt, type, serverName
};
```

**影响**：与 `handleWorkerStarted`（L2807-2827）创建的完整 WorkerSessionState 相比，临时 session 缺少 `childConversationId`、`interactionMode`、`turnStartedAt` 等字段。虽然 `handleWorkerStarted` 后续会以 `isTemporarySession = existing && !existing.childConversationId` 判断并保留临时 session 的 thoughts/content，但临时阶段的字段缺失仍可能导致 UI 渲染异常。

## 技术方案

### 步骤 1：统一临时 WorkerSessionState 的创建逻辑

**文件**：`src/renderer/stores/chat.store.ts`

提取一个 `createTemporaryWorkerSession()` 辅助函数，所有 auto-create 场景（`handleAgentThought`、`handleAgentThoughtDelta`、`applyWorkerStreamUpdate`）复用同一逻辑。该函数生成的临时 session 应包含所有必要字段：

```typescript
function createTemporaryWorkerSession(
  agentId: string,
  agentName: string,
  parentConvId: string,
  extras?: Partial<WorkerSessionState>,
): WorkerSessionState {
  return {
    agentId,
    agentName,
    taskId: null,
    task: '',
    isRunning: true,
    status: 'running',
    streamingContent: '',
    isStreaming: false,
    thoughts: [],
    isThinking: false,
    textBlockVersion: 0,
    error: null,
    completedAt: null,
    pendingQuestion: null,
    // BUG 3/4 修复：补充缺失字段
    childConversationId: `${parentConvId}:agent-${agentId}`,
    interactionMode: 'delegation',
    turnStartedAt: 0,  // handleWorkerStarted 后会更新为 Date.now()
    ...extras,
  };
}
```

### 步骤 2：`handleAgentThoughtDelta` 添加 auto-create + thought 占位

**文件**：`src/renderer/stores/chat.store.ts` L2365-2370

替换两处 `return state` 为 auto-create 逻辑：

```typescript
// 原代码 L2366-2367
const ws = newWorkerSessions.get(agentId);
if (!ws) return state;

// 修改为
let ws = newWorkerSessions.get(agentId);
if (!ws) {
  const parentConvId = baseConvId(conversationId);
  ws = createTemporaryWorkerSession(
    agentId,
    data.agentName || agentId,
    parentConvId,
  );
  newWorkerSessions.set(agentId, ws);
}

// 原代码 L2369-2370
const thoughtIndex = ws.thoughts.findIndex((t) => t.id === thoughtId);
if (thoughtIndex === -1) return state;

// 修改为
let thoughtIndex = ws.thoughts.findIndex((t) => t.id === thoughtId);
if (thoughtIndex === -1) {
  // 创建占位 thought，后续 delta 会填充内容
  const placeholder: Thought = {
    id: thoughtId,
    content: '',
    isStreaming: true,
    createdAt: new Date().toISOString(),
  };
  ws = { ...ws, thoughts: [...ws.thoughts, placeholder] };
  newWorkerSessions.set(agentId, ws);
  thoughtIndex = ws.thoughts.length - 1;
}
```

### 步骤 3：用辅助函数替换 `handleAgentThought` 和 `applyWorkerStreamUpdate` 的 auto-create

**文件**：`src/renderer/stores/chat.store.ts`

- **L2251-2266**（`handleAgentThought`）：将手动创建的临时 session 替换为 `createTemporaryWorkerSession(agentId, thought.agentName || agentId, baseConvId(conversationId))`
- **L261-278**（`applyWorkerStreamUpdate`）：将手动创建的临时 session 替换为 `createTemporaryWorkerSession(agentId, rawData.agentName || agentId, parentConvId)`

### 步骤 4：`applyWorkerStreamUpdate` auto-create 时保留已有内容

**文件**：`src/renderer/stores/chat.store.ts` L260-278

当前 auto-create 直接覆盖，但场景可能是：`handleAgentThought` 已创建了临时 session（含 thoughts），然后 `applyWorkerStreamUpdate` 也需要 auto-create。需确保：

```typescript
const existing = newWorkerSessions.get(agentId);
const workerSession = existing || createTemporaryWorkerSession(
  agentId,
  rawData.agentName || agentId,
  parentConvId,
);
// 如果 existing 存在且缺少 childConversationId（早期临时 session），补充设置
if (existing && !existing.childConversationId) {
  workerSession.childConversationId = `${parentConvId}:agent-${agentId}`;
}
```

## 开发前必读

### 模块设计文档

| 文档 | 阅读目的 |
|------|---------|
| `.project/modules/space/design.md` | Space 模块整体架构，Worker 生命周期管理 |
| `.project/modules/space/features/hyper-space/design.md` | HyperSpace 多 Agent 协作设计，事件路由流程 |

### 源码文件

| 文件 | 阅读目的 |
|------|---------|
| `src/renderer/stores/chat.store.ts` L190-215 | `WorkerSessionState` 类型定义，确认所有字段 |
| `src/renderer/stores/chat.store.ts L2240-2290` | `handleAgentThought` 的 auto-create 逻辑 |
| `src/renderer/stores/chat.store.ts L2354-2400` | `handleAgentThoughtDelta` 当前实现（核心修改区） |
| `src/renderer/stores/chat.store.ts L235-300` | `applyWorkerStreamUpdate` 函数 |
| `src/renderer/stores/chat.store.ts L2772-2850` | `handleWorkerStarted` 完整 session 创建逻辑 |
| `src/renderer/components/chat/WorkerTabBar.tsx L155-193` | WorkerView 如何依赖 `childConversationId` 加载历史 |
| `src/main/services/agent/orchestrator.ts` | `executeLocally` 事件路由，理解 `rendererConversationId` 传递 |
| `src/main/services/agent/process-stream.ts` | `emit()` 函数，理解事件发送顺序 |

### 编码规范

| 文档 | 阅读目的 |
|------|---------|
| `docs/Development-Standards-Guide.md` | TypeScript strict、函数组件规范 |
| `docs/vibecoding-doc-standard.md` | 文档更新规范 |

## 涉及文件（预估）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer/stores/chat.store.ts` | 修改 | 提取 `createTemporaryWorkerSession` 辅助函数；`handleAgentThoughtDelta` 添加 auto-create + thought 占位；`handleAgentThought` 和 `applyWorkerStreamUpdate` 使用统一辅助函数 |

### BUG 5（追加）：`handleWorkerStarted` 到达时清空 Worker 已有思考过程

**文件**：`src/renderer/stores/chat.store.ts` ~L2840

`handleWorkerStarted` 使用 `isTemporarySession = existing && !existing.childConversationId` 判断是否保留已有内容。但 `createTemporaryWorkerSession`（BUG 1-4 修复中新增）总是设置 `childConversationId`，导致 `isTemporarySession` 始终为 `false`，`thoughts: []` 无条件覆盖清空已有思考过程。

**影响**：Worker 思考过程先显示、后消失。

**修复**：`thoughts` 和 `streamingContent` 改为始终保留已有值：

```typescript
thoughts: existing?.thoughts || [],
streamingContent: existing?.streamingContent || '',
```

## 验收标准

- [x] Worker 思考过程在 WorkerView 中实时显示（含流式 delta）
- [x] IPC 事件乱序时（thought-delta 早于 worker:started），思考过程不丢失
- [x] `applyWorkerStreamUpdate` 的临时 session 包含 `childConversationId`，WorkerView 能触发历史加载
- [x] Worker 思考过程不会在显示后消失（`handleWorkerStarted` 保留已有 thoughts）
- [ ] Worker 完成后，切换到 Worker tab 能看到历史思考过程（需人工验证）
- [ ] 多个 Worker 并发执行时，各自思考过程独立显示、互不干扰（需人工验证）
- [x] 主会话的思考过程不受影响（无回归）
- [x] 构建通过：`npm run typecheck && npm run build`
