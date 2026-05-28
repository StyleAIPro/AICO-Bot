---
timestamp: 2026-05-15
status: done
author: moonseeker
---

# PRD: 修复 Agent 对话网络超时无错误提示

## 元信息

- 模块: chat
- 优先级: P0
- 影响范围: 仅前端（chat.store + i18n）
- 级别: bugfix
- 指令人: misakamikoto

## 需求分析

### 背景

用户在内网使用 BOT 时，如果全局网络代理已开启但不可达（或 AI 源网络不通），SDK 子进程会卡在网络连接上无法返回任何数据。当前前端没有超时检测机制，`isGenerating=true` 会一直保持，用户只能看到"思考中"动画，无法得知发生了什么，也无法停止。

### 问题

1. 前端无生成过程中的不活跃超时检测
2. SDK 子进程网络卡住时，前端永远不会收到 `agent:error` 或 `agent:complete` 事件
3. 后端 `session-health.ts` 的卡住检测阈值为 45 分钟，且不通知前端
4. 用户只能关闭重开或刷新页面来恢复

### 影响范围

- 内网用户 + 网络代理配置不当
- AI 源不可达（DNS 解析失败、端口不通等）
- 任何导致 SDK 子进程网络层卡住的场景

## 技术方案

在 `chat.store.ts` 中实现前端不活跃超时检测：

1. SessionState 新增 `lastActivityAt` 字段，记录最后收到后端事件的时间
2. 每次收到后端事件（thought、context-usage、stream-alive 等）时刷新
3. 启动定时器，每 10s 检查一次：如果 `isGenerating && lastActivityAt` 存在且超过 30s 无活动，自动触发超时错误并停止生成

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| Store 定义 | `src/renderer/stores/chat.store.ts` | SessionState、handleAgentError、sendMessage |
| 事件接收 | `src/renderer/App.tsx` | agent 事件绑定位置 |
| API 层 | `src/renderer/api/index.ts` | stopGeneration 调用 |

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `src/renderer/stores/chat.store.ts` | 修改：新增不活跃超时检测 |
| `src/renderer/i18n/locales/zh-CN.json` | 修改：新增超时错误提示 |
| `src/renderer/i18n/locales/en.json` | 修改：新增超时错误提示 |
| `src/renderer/i18n/locales/de.json` | 修改：新增超时错误提示 |
| `src/renderer/i18n/locales/es.json` | 修改：新增超时错误提示 |
| `src/renderer/i18n/locales/fr.json` | 修改：新增超时错误提示 |
| `src/renderer/i18n/locales/ja.json` | 修改：新增超时错误提示 |
| `src/renderer/i18n/locales/zh-TW.json` | 修改：新增超时错误提示 |

## 验收标准

- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] 构建通过（`npm run build`）
- [ ] 网络正常时，不影响正常对话流程（30s 内有事件就不会触发超时）
- [ ] 网络卡住时，30s 后自动显示超时错误提示
- [ ] 超时后自动停止生成，用户可继续发送新消息
- [ ] i18n 提取翻译通过（`npm run i18n`）
