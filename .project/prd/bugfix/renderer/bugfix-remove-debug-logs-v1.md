# PRD: 清理前端控制台调试残留日志

## 元信息

| 字段 | 值 |
|------|-----|
| 级别 | bugfix |
| 优先级 | P1 |
| 状态 | in-progress |
| 创建时间 | 2026-05-23 |
| 指令人 | misakamikoto |
| 模块 | renderer - 日志系统 |

## 问题描述

在内网环境下，本地浏览器控制台存在两类冗余日志，严重影响开发调试可读性：

1. **`[SpaceStore] listSpaces: response.data` 系列日志（3 行）**：每次 `listSpaces` 调用都会打印 `response.data` 的类型、原始值和 JSON 字符串，属于调试残留。
2. **`[App] Received agent:message event` 日志（1 行）**：每次收到 `agent:message` 事件都会打印完整 data，这是模型流式输出过程的事件，频率极高（每个 token delta 都会触发），属于调试残留。

> **备注**：`App.tsx` 中还存在 `[App] Received agent:tool-call event`（第 289 行）和 `[App] Received agent:tool-result event`（第 294 行）两处类似的调试日志，但不在本次修复范围内，如需清理可后续单独处理。

## 根因分析

### 问题 1：SpaceStore 调试日志

**位置**：`src/renderer/stores/space.store.ts` 第 80-85 行

```typescript
console.log('[SpaceStore] listSpaces: response.data type:', typeof response.data);
console.log('[SpaceStore] listSpaces: response.data:', response.data);
console.log(
  '[SpaceStore] listSpaces: response.data JSON:',
  JSON.stringify(response.data, null, 2),
);
```

**根因**：开发阶段为调试 listSpaces 接口返回值而临时添加的 console.log，遗忘未清理。第 75-79 行已有合理的日志（打印 success 状态和 count），这 3 行属于冗余的详细输出。

### 问题 2：App agent:message 调试日志

**位置**：`src/renderer/App.tsx` 第 284 行

```typescript
console.log('[App] Received agent:message event:', data);
```

**根因**：开发阶段为调试 agent 消息事件流而临时添加的 console.log。`agent:message` 事件是模型流式输出的核心事件，每个内容 delta（分词/字符片段）都会触发一次，在长对话中可产生数千行日志，严重淹没其他有价值的调试信息。

## 技术方案

### 方案：直接删除调试残留 console.log

**变更 1 — `src/renderer/stores/space.store.ts`**

删除第 80-85 行的 3 个 `console.log`：
- `console.log('[SpaceStore] listSpaces: response.data type:', ...)` 
- `console.log('[SpaceStore] listSpaces: response.data:', ...)`
- `console.log('[SpaceStore] listSpaces: response.data JSON:', ...)`

保留第 75-79 行的合理日志（success 状态 + count），该日志对调试有意义且输出量可控。

**变更 2 — `src/renderer/App.tsx`**

删除第 284 行的 `console.log('[App] Received agent:message event:', data)`。

保留 `handleAgentMessage(data)` 调用，仅移除日志打印，不影响任何业务逻辑。

### 不变更项

- `space.store.ts` 第 75-79 行的 `listSpaces` 摘要日志（合理日志，保留）
- `space.store.ts` 第 93 行的 `console.error`（错误日志，保留）
- `App.tsx` 第 289、294 行的 tool-call / tool-result 日志（不在本次范围）

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/renderer/stores/space.store.ts` | 修改 | 删除 3 个 console.log（response.data type/raw/JSON） |
| `src/renderer/App.tsx` | 修改 | 删除 1 个 console.log（agent:message event） |
| `.project/modules/space/features/space-crud/changelog.md` | 修改 | 追加变更记录 |

## 验收标准

- [ ] `space.store.ts` 第 80-85 行的 3 个 `console.log` 已删除
- [ ] `App.tsx` 第 284 行的 `console.log` 已删除
- [ ] 第 75-79 行的 `listSpaces` 摘要日志保留不变
- [ ] 列表空间功能正常：空间列表显示、切换不受影响
- [ ] Agent 消息接收功能正常：对话流式输出不受影响
- [ ] 内网环境下，控制台不再输出 `[SpaceStore] listSpaces: response.data` 相关日志
- [ ] 对话过程中，控制台不再高频输出 `[App] Received agent:message event` 日志
- [ ] `npm run typecheck && npm run build` 通过

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/renderer/stores/space.store.ts` | 确认第 80-85 行日志上下文，确认删除不会影响后续逻辑 |
| 源码文件 | `src/renderer/App.tsx` | 确认第 284 行日志上下文，确认删除不影响 handleAgentMessage 调用 |
| 模块文档 | `.project/modules/space/features/space-crud/design.md` | 理解 listSpaces 在空间 CRUD 中的职责 |
| 模块文档 | `.project/modules/space/features/space-crud/changelog.md` | 了解 space-crud 最近变更 |
| 已有 PRD | `.project/prd/bugfix/renderer/bugfix-spaceselector-verbose-logging-v1.md` | 参考同类日志清理 PRD 的处理方式 |
