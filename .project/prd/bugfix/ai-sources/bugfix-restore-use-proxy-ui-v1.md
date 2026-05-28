---
timestamp: 2026-05-15
status: done
author: moonseeker
---

# PRD: 恢复 AI 源独立代理开关 UI

## 元信息

- 模块: ai-sources
- 优先级: P1
- 影响范围: 仅前端（ProviderSelector UI + i18n）
- 级别: bugfix
- 指令人: moonseeker

## 需求分析

### 背景

commit `346c711` 引入了"AI 源独立代理"功能：每个 AI 源新增 `useProxy` 开关，可单独控制是否走全局网络代理。后端管道（类型定义、IPC、preload、renderer API、请求路由、代理逻辑、Agent 凭证链路）均已完整实现。

后续 commit `d94b2d0`（Agent 权限系统重构 + AI 源模型管理修复）重构 ProviderSelector 时，移除了 useProxy 的 UI 层（state 声明、checkbox 控件、参数传递），导致该功能虽有完整后端支持，但用户无法操作。

### 问题

- ProviderSelector 中无 useProxy 开关，用户无法控制单个 AI 源是否走代理
- useProxy state 和 checkbox 被移除
- handleFetchModels/handleTestConnection 不再传递 useProxy 参数
- 保存 source 时不包含 useProxy 字段
- i18n key "Use network proxy" / "uses global proxy from System settings" 被移除

## 技术方案

仅恢复 ProviderSelector.tsx 中的 UI 层和 i18n key，后端无需改动。

### ProviderSelector.tsx 修改

1. 恢复 `useProxy` state 声明（contextWindow 之后）
2. `handleSelectProvider` 中新增 source 时重置 `useProxy` 为 false
3. `handleFetchModels` 传 `useProxy` 给 `api.fetchModels`
4. 保存 source 对象时包含 `useProxy` 字段
5. `handleTestConnection` 传 `useProxy` 给 `api.validateApi`
6. Context Window 与 Notes 之间添加 useProxy checkbox UI

### i18n 修改

7 个 locale 文件各添加 2 个 key：`Use network proxy` / `uses global proxy from System settings`

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 原始实现 | `git show 346c711 -p -- src/renderer/components/settings/ProviderSelector.tsx` | useProxy UI 原始实现 |
| 当前状态 | `src/renderer/components/settings/ProviderSelector.tsx` | 了解当前代码结构 |
| 共享类型 | `src/shared/types/ai-sources.ts` | 确认 AISource.useProxy 字段存在 |
| API 层 | `src/renderer/api/index.ts` | 确认 fetchModels/validateApi 签名支持 useProxy |

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `src/renderer/components/settings/ProviderSelector.tsx` | 修改：恢复 useProxy UI |
| `src/renderer/i18n/locales/zh-CN.json` | 修改：添加 2 个 key |
| `src/renderer/i18n/locales/en.json` | 修改：添加 2 个 key |
| `src/renderer/i18n/locales/de.json` | 修改：添加 2 个 key |
| `src/renderer/i18n/locales/es.json` | 修改：添加 2 个 key |
| `src/renderer/i18n/locales/fr.json` | 修改：添加 2 个 key |
| `src/renderer/i18n/locales/ja.json` | 修改：添加 2 个 key |
| `src/renderer/i18n/locales/zh-TW.json` | 修改：添加 2 个 key |

## 验收标准

- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] 构建通过（`npm run build`）
- [ ] i18n 提取翻译通过（`npm run i18n`）
- [ ] 新建 AI 源时，useProxy checkbox 可见，默认关闭
- [ ] 编辑已有 AI 源时，useProxy 状态正确回显
- [ ] 切换 Provider 时，useProxy 重置为 false
- [ ] 保存 AI 源后，useProxy 字段正确持久化
- [ ] 获取模型和测试连接时，useProxy 参数正确传递
