# 技能库 ZIP 上传导入 — 设计规格

## 概述

在技能库页面（SkillLibrary）的列表头部添加 ZIP 上传按钮，用户可以上传包含多个技能的 ZIP 压缩包，自动解压安装到技能库中。支持本地 Electron 模式和远程 Web 模式。

## 需求

- **触发方式**：点击按钮选择 ZIP 文件，上传后自动安装全部技能
- **ZIP 结构**：ZIP 内包含多个一级子目录，每个子目录是一个独立技能（必须包含 `SKILL.md` 或 `SKILL.yaml`）
- **安装行为**：解压后直接复制目录到 `~/.agents/skills/`，同名技能覆盖安装
- **支持模式**：本地 Electron（dialog 选文件）+ 远程 Web（HTTP 文件上传）
- **进度反馈**：复用现有 `skill:install-output` 事件流展示安装进度
- **结果提示**：安装完成后 toast 提示安装了 N 个技能

## 技术方案

### 1. 前端改动

#### SkillLibrary.tsx

在左侧面板刷新按钮旁新增"上传 ZIP"按钮：

- Electron 模式：调用 preload 的 `dialog.showOpenDialog({ filters: [{ name: 'ZIP', extensions: ['zip'] }] })` 选择文件，获取文件路径后通过 IPC 调用 `skill:install-from-zip`
- 远程 Web 模式：渲染 `<input type="file" accept=".zip">` 隐藏 input，通过 `api.skillInstallFromZip(file)` 上传到 HTTP 端点
- 上传中：按钮禁用 + 显示加载状态
- 完成后：监听输出事件 → 自动 `refresh()` → toast 提示

### 2. IPC 通道

新增 `skill:install-from-zip` handle（`src/main/ipc/skill.ts`）：

```
请求：{ filePath: string }
响应：{ success: true, data: { installed: string[], skipped: string[], errors: string[] } }
```

通过 `BrowserWindow` 发送 `skill:install-output` 事件报告进度。

### 3. 后端核心

#### skill-manager.ts — 新增 `installFromZip(filePath: string)`

1. 创建临时目录（`os.tmpdir()` + 随机后缀）
2. 使用 `extract-zip` 解压 ZIP 到临时目录
3. 扫描临时目录的一级子目录
4. 对每个子目录验证：必须包含 `SKILL.md` 或 `SKILL.yaml`，否则跳过并记录
5. 逐个复制到 `~/.agents/skills/<子目录名>/`（同名覆盖）
6. 清理临时目录
7. 调用 `refresh()` 刷新缓存
8. 返回 `{ installed: string[], skipped: string[], errors: string[] }`

#### skill.controller.ts — 新增 `installFromZip`

包装 Manager 调用，通过 `BrowserWindow` 发送进度事件。

### 4. HTTP 端点（远程模式）

在 `src/main/http/routes/` 中新增 `POST /api/skills/install-from-zip`：

- 接收 multipart form-data，字段名 `file`
- 文件大小限制：50MB
- 保存上传文件到临时目录 → 调用 Manager 的 `installFromZip()` → 清理 → 返回结果

### 5. API 层

在 `src/renderer/api/index.ts` 新增：

```typescript
skillInstallFromZip(file: File): Promise<{ installed: string[], skipped: string[], errors: string[] }>
```

### 6. 国际化

新增按钮文本 key，运行 `npm run i18n`。

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer/components/skill/SkillLibrary.tsx` | 修改 | 添加上传按钮 + 双模式文件选择 + 进度监听 |
| `src/main/services/skill/skill-manager.ts` | 修改 | 新增 `installFromZip()` 方法 |
| `src/main/controllers/skill.controller.ts` | 修改 | 新增 `installFromZip` 控制器方法 |
| `src/main/ipc/skill.ts` | 修改 | 新增 `skill:install-from-zip` IPC handle |
| `src/main/http/routes/` 相关文件 | 修改 | 新增 POST `/api/skills/install-from-zip` |
| `src/renderer/api/index.ts` | 修改 | 新增 `skillInstallFromZip()` API 方法 |
| `package.json` | 修改 | 新增 `extract-zip` 依赖 |

## 依赖

- `extract-zip` — 轻量 ZIP 解压库（~100KB，专门用于解压 ZIP 到目录）

## 验收标准

- [ ] 技能库列表头部显示"上传 ZIP"按钮
- [ ] Electron 模式：点击按钮弹出文件选择器，仅允许 .zip 文件
- [ ] 远程 Web 模式：点击按钮弹出文件选择器，选择 ZIP 后上传
- [ ] ZIP 中含多个技能子目录时，全部自动安装
- [ ] 子目录缺少 SKILL.md/SKILL.yaml 时跳过并提示
- [ ] 同名技能覆盖安装，不报错
- [ ] 安装过程中有进度反馈
- [ ] 安装完成后自动刷新技能列表 + toast 提示
- [ ] 安装失败的技能在结果中列出，不影响其他技能
- [ ] `npm run typecheck && npm run build` 通过
- [ ] `npm run i18n` 通过（新文本已翻译）
