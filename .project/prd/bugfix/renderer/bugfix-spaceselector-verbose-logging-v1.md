# PRD: 修复 SpaceSelector 组件在本地/内网环境下频繁输出冗余日志

## 元信息

| 字段 | 值 |
|------|-----|
| 级别 | bugfix |
| 状态 | draft |
| 创建时间 | 2026-05-21 |
| 指令人 | misakamikoto |
| 模块 | renderer - 布局组件 |

## 问题描述

在内网环境下使用 AICO-Bot 时，本地日志中频繁出现 `[SpaceSelector]` 前缀的日志输出。外部网络环境下该问题不明显（远程服务器加载成功不会触发错误日志），但调试日志仍然每次渲染都会输出。

## 根因分析

问题出在 `src/renderer/components/layout/SpaceSelector.tsx` 中两处不应保留的 console 调用：

1. **第119行 `console.error`** — `useEffect` 中加载远程服务器列表，内网/本地环境下请求必然失败，导致每次组件挂载都打印错误日志。远程服务器加载失败是正常的预期行为，不应以 error 级别输出。
2. **第207-210行 `console.log`** — 每次组件渲染都会打印已加载空间列表的调试日志，属于开发调试残留，不应保留在生产代码中。

## 技术方案

### 方案：直接删除两处 console 调用

1. **删除第119行** `console.error('[SpaceSelector] Failed to load remote servers:', error)` — 远程服务器加载失败是预期行为（本地/内网环境），`getRemoteServers` 失败后 `remoteServers` 保持空数组，UI 不受影响，无需日志输出。
2. **删除第207-210行** `console.log('[SpaceSelector] Loaded spaces:', ...)` — 开发调试日志，直接移除。

无需增加条件判断或开发模式检测，两处日志对生产环境均无价值。

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/renderer/components/layout/SpaceSelector.tsx` | 修改 | 删除第119行 console.error 和第207-210行 console.log |

## 验收标准

- [ ] 删除第119行的 `console.error('[SpaceSelector] Failed to load remote servers:', error)`
- [ ] 删除第207-210行的 `console.log('[SpaceSelector] Loaded spaces:', ...)`
- [ ] 内网环境下组件挂载时控制台不再输出 `[SpaceSelector]` 相关日志
- [ ] 空间选择器功能正常：空间列表显示、切换、远程服务器名称展示均不受影响
- [ ] `npm run typecheck && npm run build` 通过

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/renderer/components/layout/SpaceSelector.tsx` | 确认日志位置和上下文逻辑 |
