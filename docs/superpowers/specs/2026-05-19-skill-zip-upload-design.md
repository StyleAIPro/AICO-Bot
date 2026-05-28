# 技能库导入（ZIP / 文件夹） — 设计规格

## 概述

在技能库页面（SkillLibrary）的列表头部添加导入按钮，用户可以上传 ZIP 压缩包或选择文件夹来批量导入技能。核心安装逻辑统一：扫描目录中的一级子目录，验证后复制到技能目录。

## 需求

- **触发方式**：点击按钮后可选择 ZIP 文件或文件夹
- **ZIP 模式**：解压 ZIP 到临时目录 → 扫描子目录 → 安装 → 清理临时目录
- **文件夹模式**：直接扫描所选文件夹的子目录 → 安装
- **安装逻辑**：统一为"扫描一级子目录 → 验证 SKILL.md/SKILL.yaml → 复制到 `~/.agents/skills/`" → 同名覆盖 → 刷新缓存
- **支持模式**：本地 Electron（dialog 选文件/文件夹）+ 远程 Web（HTTP 文件上传）
- **进度反馈**：复用现有 `skill:install-output` 事件流
- **结果提示**：安装完成后 toast 提示

## 技术方案

### 1. 后端核心（统一 load 逻辑）

#### skill-manager.ts — 拆分为两层

**`installFromDirectory(dirPath)`** — 核心方法，处理任意目录：
1. 扫描一级子目录
2. 验证每个子目录包含 `SKILL.md` 或 `SKILL.yaml`
3. 逐个复制到 `~/.agents/skills/<子目录名>/`（同名覆盖）
4. 刷新缓存
5. 返回 `{ installed: string[], skipped: string[], errors: string[] }`

**`installFromZip(filePath)`** — 壳方法，调用 `installFromDirectory`：
1. 创建临时目录
2. 用 `extract-zip` 解压 ZIP 到临时目录
3. 调用 `installFromDirectory(tmpDir)`
4. 清理临时目录

两者共用同一套"扫描+验证+复制"逻辑。

### 2. 前端改动

#### SkillLibrary.tsx

在左侧面板刷新按钮旁新增"导入"按钮，点击后弹出选择菜单：
- **从 ZIP 文件导入**
- **从文件夹导入**（仅 Electron 模式）

Electron 模式使用 `dialog.showOpenDialog`（文件模式 / 目录模式）。
远程 Web 模式仅支持 ZIP 上传（浏览器无法选择文件夹上传目录结构）。

### 3. IPC 通道

新增 `skill:import-skills` handle，接收 `{ sourceType: 'zip' | 'folder', filePath: string }`。

### 4. HTTP 端点（远程模式）

`POST /api/skills/import-from-zip` — multipart 上传 ZIP 文件。

### 5. Preload

新增 `skillImportSkills(input)` 方法，内部根据 `sourceType` 调用对应 dialog。

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer/components/skill/SkillLibrary.tsx` | 修改 | 添加导入按钮 + ZIP/文件夹选择 + 进度监听 |
| `src/main/services/skill/skill-manager.ts` | 修改 | 新增 `installFromDirectory()` + `installFromZip()` |
| `src/main/controllers/skill.controller.ts` | 修改 | 新增 `importSkills()` 控制器方法 |
| `src/main/ipc/skill.ts` | 修改 | 新增 `skill:import-skills` IPC handle |
| `src/main/http/routes/index.ts` | 修改 | 新增 POST `/api/skills/import-from-zip` |
| `src/preload/index.ts` | 修改 | 暴露 `skillImportSkills` + `showOpenDialog` |
| `src/renderer/api/index.ts` | 修改 | 新增 `skillImportFromZip()` API 方法 |
| `package.json` | 修改 | 新增 `extract-zip` 依赖 |

## 依赖

- `extract-zip` — ZIP 解压库

## 验收标准

- [ ] 技能库列表头部显示"导入"按钮
- [ ] 点击按钮出现菜单：从 ZIP 文件导入 / 从文件夹导入
- [ ] Electron 模式：选择 ZIP 文件后自动解压安装
- [ ] Electron 模式：选择文件夹后直接扫描安装
- [ ] 远程 Web 模式：仅显示 ZIP 上传选项
- [ ] ZIP / 文件夹中含多个技能子目录时，全部自动安装
- [ ] 子目录缺少 SKILL.md/SKILL.yaml 时跳过并提示
- [ ] 同名技能覆盖安装，不报错
- [ ] 安装过程中有进度反馈
- [ ] 安装完成后自动刷新技能列表 + toast 提示
- [ ] 安装失败的技能在结果中列出，不影响其他技能
- [ ] `npm run typecheck && npm run build` 通过
- [ ] `npm run i18n` 通过
