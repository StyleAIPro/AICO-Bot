# CLAUDE.md

## 项目概述

AICO-Bot：Electron 桌面应用，将 Claude Code AI Agent 封装为可视化跨平台界面。2.x 含 Digital Humans 自动化平台。

## 铁律（违反即错）

1. **无 PRD 拒绝工作** — 收到任何需求，先加载 `aico-dev-workflow` skill 执行完整流程
2. **PRD 用 subagent 写**，主 agent 开发时读取
3. **编码前必读** PRD「开发前必读」所有文档
4. **一 PRD 一 commit**，引用 PRD 路径，禁止堆叠无关变更
5. **每次编辑文件后必须 re-read**（Windows 行尾覆盖问题）
6. **编码结束后必须打包** — tar.xz（`resources/offline-bundles/`）+ exe（跳过签名），详见 `aico-dev-workflow` skill

## 编码规范

- TypeScript strict，禁止 `any`（用 `unknown`），纯类型导入用 `import type`
- IPC 通道常量化（`src/shared/constants/`），handler 必须 try/catch + `{ success, data/error }`
- Preload 禁止暴露原始 `ipcRenderer`
- React 只用函数组件，Zustand 按功能拆分 store
- 命名：文件夹 kebab-case，组件 PascalCase，接口不加 `I` 前缀
- UI 禁止硬编码文本（用 `t()`），Tailwind 用 CSS 变量主题色

## 常用命令

```bash
npm run dev              # 开发（端口 8081，~/.aico-bot-dev）
npm run build            # 构建（out/）
npm run build:mac/win/linux
npm run prepare          # 下载当前平台二进制
npm run typecheck
npm run i18n
npm run release:win      # 需 GH_TOKEN
```

**Windows 打包**：Node 20 + Python 3 + VS Build Tools 2022 → `npm install` → `npm run prepare` → `npm run build:win`

> **Remote Agent Proxy**：`packages/remote-agent-proxy/` 的 `dist/`、`package.json`、`scripts/` 必须在 `build.files` 中，否则远程部署报 `MODULE_NOT_FOUND`。

## 架构

```
React UI ◄─IPC─► Main 进程 ◄──► Claude Code SDK
                     │
               ~/.aico-bot/
```

**关键目录**：`src/main/services/`（`agent/` `remote/` `auth/` `ai-sources/` `ai-browser/`）、`src/renderer/`（`stores/chat.store.ts` `api/`）、`src/shared/`（禁止导入 Node/Electron）

**双模式 API**：`transport.ts` 检测 `window.aicoBot` → IPC 或 HTTP+WebSocket

**新增 IPC 端点改 3 处**：`preload/index.ts` → `api/transport.ts` → `api/index.ts`

**路径别名**：`@/` renderer · `@main/` main · `@shared` shared

## SDK / 远程

```typescript
{ model: credentials.sdkModel, cwd: workDir,
  permissionMode: 'bypassPermissions', includePartialMessages: true }
```

远程触发：`space.claudeSource === 'remote'`；会话恢复：`sdkSessionId`

## 配置

- `product.json` — 构建与认证 Provider
- `~/.aico-bot[-dev]/` — 用户/开发数据
- `.env.local` — `AICO_BOT_TEST_*`（i18n）、`GH_TOKEN`（发布）

<!-- superpowers-zh:begin (do not edit between these markers) -->
# Superpowers-ZH 中文增强版

本项目已安装 superpowers-zh 技能框架（20 个 skills）。

## 核心规则

1. **收到任务时先检查匹配 skill** — 哪怕只有 1% 可能性也要检查
2. **设计先于编码** — 先用 brainstorming skill 做需求分析
3. **测试先于实现** — 写代码前先写测试（TDD）
4. **验证先于完成** — 声称完成前必须运行验证命令

## 可用 Skills（位于 `.claude/skills/`）

| Skill | 触发时机 |
|-------|---------|
| **aico-dev-workflow** | **收到任何需求/Bug/重构时** |
| brainstorming | 任何创造性工作之前 |
| dispatching-parallel-agents | 2 个以上可独立进行的任务 |
| executing-plans | 有书面计划需在独立会话执行时 |
| finishing-a-development-branch | 实现完成需决定如何集成时 |
| subagent-driven-development | 当前会话执行含独立任务的计划时 |
| systematic-debugging | 遇到 bug、测试失败或异常行为时 |
| test-driven-development | 实现功能或修复 bug 前 |
| using-git-worktrees | 开始隔离的功能开发前 |
| verification-before-completion | 宣称完成/提交/PR 前 |
| writing-plans | 多步骤任务动手前 |
| workflow-runner | 运行 .yaml 工作流或多角色协作时 |
| requesting-code-review | 完成任务/合并前验证 |
| receiving-code-review | 收到审查反馈后实施前 |
| mcp-builder | 构建 MCP 服务器时 |
| using-superpowers | 开始任何对话时 |
| writing-skills | 创建/编辑/验证 skill 时 |
| chinese-code-review | 仅显式 `/chinese-code-review` 时 |
| chinese-commit-conventions | 仅显式 `/chinese-commit-conventions` 时 |
| chinese-documentation | 仅显式 `/chinese-documentation` 时 |
| chinese-git-workflow | 仅显式 `/chinese-git-workflow` 时 |

使用 `Skill` 工具加载对应 skill，**不要用 Read 工具读取 SKILL.md**。
<!-- superpowers-zh:end -->