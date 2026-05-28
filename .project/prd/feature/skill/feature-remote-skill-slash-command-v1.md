# PRD [功能级] -- 远程 Web 模式技能斜杠命令支持

> 版本：feature-remote-skill-slash-command-v1
> 日期：2026-05-14
> 指令人：@misakamikoto
> 归属模块：main/http + renderer/api
> 状态：in-progress
> 优先级：P1
> 影响范围：后端（HTTP 路由）+ 前端（API 适配层）

## 需求分析

### 背景

`feature-chat-slash-command-v1` 已在 Electron 模式下实现了输入 `/` 弹出技能选择菜单的功能。前端代码在 Electron 和远程 Web 模式下完全共用（同一套 `InputArea` + `useSlashCommand` hook），但远程 Web 模式下技能菜单无法正常工作。

### 问题

远程 Web 模式下 `loadInstalledSkills()` 调用 `api.skillList()`，该函数在远程模式下发送 `GET /api/skills` HTTP 请求。但后端 HTTP server（`src/main/http/routes/index.ts`）**完全没有注册 skill 相关路由**，请求返回 404，导致：

1. `installedSkills` 始终为空数组
2. `/` 菜单不显示任何技能
3. 远程用户无法使用技能快速调用功能

### 前端已有的 HTTP 适配

`src/renderer/api/index.ts` 已为所有 skill API 设计了 HTTP 适配路径：

| 方法 | 远程 HTTP |
|------|-----------|
| `skillList()` | `GET /api/skills` |
| `skillToggle()` | `POST /api/skills/toggle` |
| `skillUninstall()` | `POST /api/skills/uninstall` |
| `skillRefresh()` | `POST /api/skills/refresh` |
| `skillConfigGet()` | `GET /api/skills/config` |

### 预期效果

- 远程 Web 用户输入 `/` 弹出已安装技能列表
- 选中技能后消息以标记样式发送
- SDK 在远程服务器上自动识别 `/skill-name` 并调用

## 技术方案

### 核心思路

在 HTTP 路由中注册 `/api/skills` 系列路由，复用现有 `skillController` 的函数（与 IPC handler 相同的 controller 层）。

### 1. 注册 Skill HTTP 路由

**文件**：`src/main/http/routes/index.ts`

在 `registerApiRoutes` 函数中新增 skill 路由组。skill controller 需要 `initialize(conversationService)` 初始化，参考 IPC handler 的做法。

```typescript
import * as skillController from '../../controllers/skill.controller';
import type { ConversationService } from '../../services/conversation.service';

// 在 registerApiRoutes 中：
// ===== Skill Routes (for remote Web mode) =====
// Initialize skill controller (same as IPC handler)
skillController.initialize(conversationService);

app.get('/api/skills', async (req: Request, res: Response) => {
  const result = await skillController.listInstalledSkills();
  res.json(result);
});

app.post('/api/skills/toggle', async (req: Request, res: Response) => {
  const { skillId, enabled } = req.body;
  const result = await skillController.toggleSkill(skillId, enabled);
  res.json(result);
});

app.post('/api/skills/uninstall', async (req: Request, res: Response) => {
  const { skillId } = req.body;
  const result = await skillController.uninstallSkill(skillId);
  res.json(result);
});

app.post('/api/skills/refresh', async (req: Request, res: Response) => {
  const result = await skillController.refreshSkills();
  res.json(result);
});

app.get('/api/skills/config', async (req: Request, res: Response) => {
  const result = await skillController.getSkillConfig();
  res.json(result);
});
```

### 2. registerApiRoutes 函数签名变更

当前 `registerApiRoutes(app, mainWindow)` 需要传入 `conversationService` 参数以初始化 skillController：

```typescript
export function registerApiRoutes(
  app: Express,
  mainWindow: BrowserWindow | null,
  conversationService: ConversationService,
): void {
```

### 3. 调用处更新

搜索 `registerApiRoutes` 的调用位置，传入 `conversationService` 参数。

### 数据流

```
远程 Web 用户输入 "/" → useSlashCommand hook（共用代码）
    ↓
useEffect → api.skillList() → httpRequest('GET', '/api/skills')
    ↓
后端 HTTP 路由 → skillController.listInstalledSkills()
    ↓
返回 InstalledSkill[] → 前端 installedSkills 更新
    ↓
菜单显示已安装技能
    ↓
用户选中技能 → 发送 /skill-name 消息
    ↓
后端 sendMessage → 远程 SDK（已通过 symlink 注入技能目录）
    ↓
SDK 自动识别 /skill-name 并调用
```

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/remote-agent/remote-access-v1.md` | 理解远程访问架构、HTTP server 启动方式 |
| 2 | `.project/modules/skill/skill-system-v1.md` | 理解技能系统架构 |

### 源码文件

| # | 文件 | 阅读目的 |
|---|------|---------|
| 3 | `src/main/http/routes/index.ts` | 理解现有路由注册模式 |
| 4 | `src/main/ipc/skill.ts` | 理解 IPC handler 如何调用 skillController |
| 5 | `src/main/controllers/skill.controller.ts` | 理解 controller 层函数签名 |
| 6 | `src/renderer/api/index.ts` (skillList 等) | 理解前端 HTTP 调用路径 |
| 7 | `src/renderer/api/transport.ts` | 理解远程模式 HTTP 请求机制 |

## 涉及文件（实际）

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/main/http/routes/index.ts` | 修改 | 顶部导入 skillController，新增 /api/skills 5 条路由 |

> 注：`skillController.initialize()` 在 bootstrap 阶段已通过 `registerSkillHandlers` 调用，HTTP 路由无需再次初始化，无需修改函数签名。

## 验收标准

- [ ] 远程 Web 模式下 `GET /api/skills` 返回已安装技能列表
- [ ] 远程 Web 模式下输入 `/` 弹出已安装技能菜单
- [ ] 技能菜单显示正确的技能名称、描述、trigger_command
- [ ] 选中技能后消息正常发送，SDK 识别并调用技能
- [ ] Electron 模式下功能不受影响
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-14 | 初始 PRD | @misakamikoto |
