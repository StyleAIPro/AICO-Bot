# PRD [Bug 修复级] — 获取远程模型列表时 name 字段使用了非模型标识符，导致显示和标识混乱

> 版本：bugfix-fetch-model-by-id-v1
> 日期：2026-05-14
> 状态：done
> 指令人：@misakamikoto
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-provider
> 优先级：P0

## 问题描述

- **期望行为**：获取远程模型列表时，每个模型应使用实际底层模型标识符（如 `gpt-4o`、`deepseek-chat`）作为模型名称，不需要额外的别名/显示名
- **实际行为**：`fetchModelsFromApi` 将 `name` 字段 fallback 到 `m.owned_by`（如 `"openai"`），导致 `model.name` 与 `model.id` 差异巨大，下拉列表中显示的模型名称没有实际意义

## 问题根因

**文件**：`src/main/services/ai-sources/api-validator.service.ts` 第 92 行

```typescript
.map((m: any) => ({ id: m.id, name: m.name || m.owned_by || m.id }));
```

对于 OpenAI 标准 `/v1/models` 响应，模型对象通常为 `{ id: "gpt-4o", object: "model", owned_by: "openai" }`，不含 `name` 字段。当前逻辑 fallback 到 `m.owned_by`，导致 `name` = `"openai"`。

`m.owned_by` 是 API 提供商的组织名（如 `"openai"`、`"anthropic"`），不是模型标识符。用它作为 `name` 毫无意义，且下拉列表中所有模型都会显示相同的 `name`（都是 `"openai"`），用户无法区分不同模型。

## 技术方案

修改 `fetchModelsFromApi` 中 4 种响应格式的 name 提取逻辑，统一将 fallback 从 `m.owned_by` 改为 `m.id`：

```typescript
// 当前（Bug）：
.map((m: any) => ({ id: m.id, name: m.name || m.owned_by || m.id }));

// 修复后：
.map((m: any) => ({ id: m.id, name: m.name || m.id }));
```

当 API 未返回 `name` 字段时，使用 `id` 作为 `name`，确保 `model.name` 始终是有效的模型标识符。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 相关 PRD | `.project/prd/bugfix/ai-sources/bugfix-model-fetch-and-validate-v1.md` | 了解 fetchModelsFromApi 的 name 提取逻辑（`m.owned_by` fallback 的来源） |
| 源码 | `src/main/services/ai-sources/api-validator.service.ts`（第 48-143 行） | **核心修改文件**：`fetchModelsFromApi()` 中 4 种响应格式的 name 提取逻辑 |
| 源码 | `src/shared/types/ai-sources.ts`（第 103-107 行） | 理解 `ModelOption` 接口定义（`id` / `name` 语义） |
| 源码 | `src/renderer/components/settings/ProviderSelector.tsx`（第 714-720 行） | 理解下拉列表如何显示 model.name 和 model.id |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、编码规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/ai-sources/api-validator.service.ts` | 修改 | 调整 `fetchModelsFromApi` 中 4 种响应格式的 name 提取，移除 `m.owned_by` fallback |

## 验收标准

- [x] **获取模型后 name 正确**：点击 "Fetch Models" 后，`model.name` 优先使用 API 返回的 `name`，其次使用 `model.id`，不再出现 `name = "openai"` 等组织名
- [x] **下拉列表显示正确**：模型下拉列表中每个模型显示的是模型标识符（如 `gpt-4o`）而非组织名（如 `openai`）
- [x] **回归测试 — 保存和使用**：获取模型后保存 Source，`source.model` 仍为正确的模型 ID，API 调用正常
- [x] **回归测试 — 内置 Provider**：未 Fetch 时使用内置默认模型列表，行为不变
- [x] `npm run typecheck` 通过（已有无关错误，本次改动无新增）
- [x] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-14 | 初始 Bug 修复 PRD | @misakamikoto |
