# PRD [功能级] — 扩展 Skill 导入支持多种压缩包格式

> 版本：feature-archive-skill-import-v1
> 日期：2026-06-03
> 指令人：用户
> 归属模块：modules/skill
> 状态：done
> 优先级：P1

## 需求

### 背景

AICO-Bot 技能系统支持通过本地文件导入 Skill，当前实现仅支持 `.zip` 格式的压缩包。用户在从其他渠道获取 Skill 时，压缩包格式多种多样（rar、7z、tar.gz、tgz、tar.bz2、tar.xz 等），仅支持 zip 限制了用户的使用便利性。

### 问题

1. `installFromZip` 方法硬编码使用 `yauzl` 库，仅能处理 zip 格式
2. 前端文件选择器 filter 限制为 `['zip']`，用户无法选取其他格式文件
3. Web 模式 `<input accept=".zip">` 限制了上传文件类型
4. HTTP 路由 `/api/skills/import-from-zip` 路径和 multer 无文件类型过滤，但命名具有误导性
5. `sourceType` 类型为 `'zip' | 'folder'`，无法表达其他压缩格式
6. Preload 类型定义同样限制为 `'zip' | 'folder'`
7. i18n 中 "Select ZIP file"、"From ZIP File" 等硬编码文案需要更新

### 预期效果

用户在 SkillLibrary 界面点击「导入」时，可以从文件选择器中选择任意常见压缩包格式（zip、rar、7z、tar.gz、tgz、tar.bz2、tar.xz），系统自动识别格式并正确解压导入。Web 模式 HTTP 上传同理。

## 技术方案

### 方案选型

| 方案 | 支持格式 | 原生依赖 | 跨平台 | 维护性 | 推荐度 |
|------|---------|---------|--------|--------|--------|
| **A. decompress** | zip, tar, tar.gz, tar.bz2, tar.xz | 无 | 好 | 高 | 核心方案 |
| B. node-unrar-js + 7zip-bin | rar + 7z | 需要原生二进制 | 一般 | 中 | 补充方案 |
| C. libarchive 主方案 | 全格式 | 需要 native binding | 差 | 中 | 不推荐 |
| D. 7za 统一方案 | 全格式 | 需要外部二进制 | 一般 | 中 | 备选 |

**推荐方案**：以 `decompress` 作为核心解压引擎处理 zip/tar/tar.gz/tar.bz2/tar.xz（覆盖 90%+ 场景），对 rar 和 7z 格式以不支持的格式提示用户转为 zip 后导入（Phase 1）。若未来有需求可引入 `7zip-bin` + `child_process` 扩展 rar/7z 支持（Phase 2）。

理由：
- `decompress` 是纯 JS 实现，无 native addon 编译问题，跨平台兼容性最佳
- `decompress` 内部使用 `yauzl`（zip）和 `tar-stream`（tar 系列），与当前 zip 方案自然过渡
- tar.gz/tgz/tar.bz2/tar.xz 是 tar + 压缩的组合，`decompress` 全部支持
- rar 是私有格式，`node-unrar-js` 需要加载 UnRAR DLL，跨平台打包复杂度高
- 7z 格式相对少见，投入产出比不高

### 架构概览

```
改前：                                  改后：
SkillLibrary UI                        SkillLibrary UI
  ↓ (sourceType: 'zip')                  ↓ (sourceType: 'archive')
IPC: skill:import-skills               IPC: skill:import-skills
  ↓                                      ↓
skill.controller.ts                    skill.controller.ts
  ↓ (sourceType === 'zip')               ↓ (sourceType === 'archive')
skill-manager.ts                       skill-manager.ts
  ↓ installFromZip (yauzl)               ↓ installFromArchive (decompress)

HTTP: POST /api/skills/import-from-zip  HTTP: POST /api/skills/import-from-archive
  ↓                                      ↓
multer → importFromZipBuffer            multer → importFromArchiveBuffer
  ↓                                      ↓
tmp.zip → installFromZip                tmp.<ext> → installFromArchive
```

### 1. 安装依赖

```bash
npm install decompress
npm install -D @types/decompress
```

`decompress` 依赖链：
- `decompress` -> `decompress-unzip`（底层用 `yauzl`）+ `decompress-tar`（底层用 `tar-stream`）
- 自动处理 `.tar.gz`、`.tgz`、`.tar.bz2`、`.tar.xz`（通过内置的 gunzip/bunzip2/lzma 解压 + tar 解包）

### 2. 核心解压方法 — `installFromArchive()`

**文件**：`src/main/services/skill/skill-manager.ts`

**新增方法** `installFromArchive(filePath: string, onProgress?)`：

- **输入**：
  - `filePath: string` — 压缩包文件路径
  - `onProgress?: (message: string) => void` — 进度回调
- **输出**：`Promise<ImportSkillsResult>`（复用现有类型）

**实现逻辑**：

1. 从 `filePath` 提取文件扩展名，生成临时解压目录 `os.tmpdir()/aico-skill-extract-{uuid}/`
2. 调用 `decompress(filePath, tmpDir)` 将压缩包完整解压到临时目录
3. 在临时目录中扫描含 `SKILL.md` 或 `SKILL.yaml` 的子目录（复用现有 `scanForSkillDirs` 逻辑）
4. 对每个找到的 skill 目录，通过 `copyDirRecursive` 复制到 `this.skillsDirs[0]`（复用现有方法）
5. 清理临时目录
6. 调用 `this.refresh()` 刷新缓存
7. 返回 `ImportSkillsResult`

**关键变更**：保留 `installFromZip` 方法不删除（向后兼容），新增 `installFromArchive` 作为统一入口。后续可标记 `installFromZip` 为 `@deprecated`。

**扩展名检测工具方法** `getArchiveType(fileName: string)`：

```typescript
type ArchiveType = 'zip' | 'tar.gz' | 'tgz' | 'tar.bz2' | 'tar.xz' | 'rar' | '7z' | 'unknown';

function getArchiveType(fileName: string): ArchiveType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tar.gzip')) return 'tar.gz';
  if (lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.tar.bz2')) return 'tar.bz2';
  if (lower.endsWith('.tar.xz')) return 'tar.xz';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.rar')) return 'rar';
  if (lower.endsWith('.7z')) return '7z';
  return 'unknown';
}
```

**不支持的格式处理**：rar/7z 返回错误提示，引导用户转换格式。

### 3. Controller 层变更

**文件**：`src/main/controllers/skill.controller.ts`

#### 3a. `importSkills()` 签名变更

```typescript
// 改前
export async function importSkills(
  sourceType: 'zip' | 'folder',
  filePath: string,
  ...
)

// 改后
export async function importSkills(
  sourceType: 'archive' | 'folder',  // 'archive' 替代 'zip'
  filePath: string,
  ...
)
```

内部逻辑变更：`sourceType === 'archive'` 时调用 `skillManager.installFromArchive(filePath, onProgress)`，不再调用 `installFromZip`。

#### 3b. `importFromZipBuffer()` 重命名

重命名为 `importFromArchiveBuffer(buffer: Buffer, originalFileName: string)`：

- 需要接收 `originalFileName` 参数用于确定文件扩展名
- 写临时文件时保留原始扩展名：`path.join(os.tmpdir(), 'aico-skill-upload-${uuid}${ext}')`
- 调用 `installFromArchive` 替代 `installFromZip`

#### 3c. 向后兼容

保留 `importFromZipBuffer` 函数签名作为 wrapper 调用 `importFromArchiveBuffer(buffer, 'upload.zip')`，防止其他调用方中断。标记为 `@deprecated`。

### 4. IPC Handler 变更

**文件**：`src/main/ipc/skill.ts`

```typescript
// 改前
wrapIpcHandle(
  'skill:import-skills',
  async (event, input: { sourceType: 'zip' | 'folder'; filePath: string }) => { ... }
);

// 改后
wrapIpcHandle(
  'skill:import-skills',
  async (event, input: { sourceType: 'archive' | 'folder'; filePath: string }) => { ... }
);
```

### 5. HTTP 路由变更

**文件**：`src/main/http/routes/index.ts`

#### 5a. 路由路径重命名

```
改前：POST /api/skills/import-from-zip
改后：POST /api/skills/import-from-archive
```

#### 5b. 向后兼容路由

保留 `/api/skills/import-from-zip` 作为旧路由，内部转发到新 handler。

#### 5c. multer 文件大小限制

当前已设置 `limits: { fileSize: 50 * 1024 * 1024 }`（50MB），无需变更。

### 6. Preload 类型变更

**文件**：`src/preload/index.ts`

```typescript
// 改前
skillImportSkills: (input: { sourceType: 'zip' | 'folder'; filePath: string }) => Promise<IpcResponse>;

// 改后
skillImportSkills: (input: { sourceType: 'archive' | 'folder'; filePath: string }) => Promise<IpcResponse>;
```

### 7. Renderer API 变更

**文件**：`src/renderer/api/index.ts`

#### 7a. 方法重命名

```typescript
// 改前
skillImportFromZip: async (file: File) => { ... }

// 改后
skillImportFromArchive: async (file: File) => {
  if (isElectron()) {
    throw new Error('Use window.aicoBot.skillImportSkills directly in Electron mode');
  }
  const formData = new FormData();
  formData.append('file', file);
  const token = getAuthToken();
  const response = await fetch(`${getRemoteServerUrl()}/api/skills/import-from-archive`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  return response.json();
},
```

保留 `skillImportFromZip` 作为 wrapper 调用 `skillImportFromArchive`，标记 `@deprecated`。

### 8. 前端 UI 变更

**文件**：`src/renderer/components/skill/SkillLibrary.tsx`

#### 8a. Electron 模式文件选择器

```typescript
// 改前
const filePaths = await window.aicoBot.showOpenDialog({
  title: t('Select ZIP file'),
  filters: [{ name: 'ZIP', extensions: ['zip'] }],
  properties: ['openFile'],
});

// 改后
const filePaths = await window.aicoBot.showOpenDialog({
  title: t('Select Archive File'),
  filters: [{
    name: 'Archive',
    extensions: ['zip', 'tar.gz', 'tgz', 'tar.bz2', 'tar.xz'],
  }],
  properties: ['openFile'],
});
```

IPC 调用参数变更：

```typescript
// 改前
await window.aicoBot.skillImportSkills({ sourceType: 'zip', filePath });

// 改后
await window.aicoBot.skillImportSkills({ sourceType: 'archive', filePath });
```

#### 8b. Web 模式文件输入

```html
<!-- 改前 -->
<input accept=".zip" />

<!-- 改后 -->
<input accept=".zip,.tar.gz,.tgz,.tar.bz2,.tar.xz" />
```

Web 模式上传调用变更：

```typescript
// 改前
const result = await api.skillImportFromZip(file);

// 改后
const result = await api.skillImportFromArchive(file);
```

#### 8c. 菜单文案变更

```typescript
// 改前
{t('From ZIP File')}

// 改后
{t('From Archive File')}
```

### 9. i18n 变更

**所有语言文件**需要新增/修改以下 key：

| Key | en (默认) | zh-CN |
|-----|----------|-------|
| `Select Archive File` | `Select Archive File` | `选择压缩包文件` |
| `From Archive File` | `From Archive File` | `从压缩包导入` |
| `Unsupported archive format` | `Unsupported archive format: {{ext}}. Please use zip, tar.gz, tgz, tar.bz2, or tar.xz.` | `不支持的压缩格式: {{ext}}。请使用 zip、tar.gz、tgz、tar.bz2 或 tar.xz。` |
| `Extracting archive` | `Extracting archive: {{name}}...` | `正在解压: {{name}}...` |

同时保留旧 key（`Select ZIP file`、`From ZIP File`）以防其他引用。

## 开发前必读

| 分类 | 文档路径 | 说明 |
|------|---------|------|
| 模块设计 | `.project/modules/skill/skill-system-v1.md` | Skill 模块整体架构 |
| 模块设计 | `.project/modules/skill/features/skill-source/design.md` | 技能源管理设计 |
| 核心逻辑 | `src/main/services/skill/skill-manager.ts` | `installFromZip` 当前实现（行 708-876）、`ImportSkillsResult` 接口（行 26）、`copyDirRecursive`（行 883） |
| Controller | `src/main/controllers/skill.controller.ts` | `importSkills`（行 612）、`importFromZipBuffer`（行 652） |
| IPC | `src/main/ipc/skill.ts` | `skill:import-skills` handler（行 74） |
| HTTP | `src/main/http/routes/index.ts` | multer 配置（行 1550）、`POST /api/skills/import-from-zip`（行 1583） |
| Preload | `src/preload/index.ts` | `skillImportSkills` 类型定义（行 615） |
| Renderer API | `src/renderer/api/index.ts` | `skillImportFromZip`（行 2384） |
| UI | `src/renderer/components/skill/SkillLibrary.tsx` | `handleImportFromZip`（行 387）、`handleZipFileChange`（行 484）、file input（行 956） |
| i18n | `src/renderer/i18n/locales/*.json` | "Select ZIP file"、"From ZIP File" 等相关 key |
| npm | `decompress` npm 包文档 | https://www.npmjs.com/package/decompress — 支持格式及 API |

## 涉及文件（实际）

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `package.json` | 新增依赖 | 添加 `decompress` 及 `@types/decompress` |
| 2 | `src/main/services/skill/skill-manager.ts` | 新增方法 | `installFromArchive()`、`getArchiveType()`，保留 `installFromZip` |
| 3 | `src/main/controllers/skill.controller.ts` | 修改签名+新增 | `importSkills` 签名变更 `'zip'` -> `'archive'`；新增 `importFromArchiveBuffer`；旧方法标 deprecated |
| 4 | `src/main/ipc/skill.ts` | 修改类型 | `sourceType` 从 `'zip' \| 'folder'` 改为 `'archive' \| 'folder'` |
| 5 | `src/main/http/routes/index.ts` | 新增路由+保留旧路由 | 新增 `POST /api/skills/import-from-archive`，保留旧路由兼容 |
| 6 | `src/preload/index.ts` | 修改类型 | `skillImportSkills` 的 `sourceType` 类型变更 |
| 7 | `src/renderer/api/index.ts` | 新增方法+保留旧方法 | 新增 `skillImportFromArchive()`，旧方法标 deprecated |
| 8 | `src/renderer/components/skill/SkillLibrary.tsx` | 修改 UI | 文件选择器 filter 扩展、accept 扩展、IPC 参数变更、文案变更 |
| 9 | `src/renderer/i18n/locales/en.json` | 新增 key | `Select Archive File`、`From Archive File` |
| 10 | `src/renderer/i18n/locales/zh-CN.json` | 新增 key | `Select Archive File`（选择压缩包文件）、`From Archive File`（从压缩包导入） |
| 11 | `src/renderer/i18n/locales/zh-TW.json` | 新增 key | `Select Archive File`、`From Archive File` |
| 12 | `src/renderer/i18n/locales/ja.json` | 新增 key | `Select Archive File`、`From Archive File` |
| 13 | `src/renderer/i18n/locales/de.json` | 新增 key | `Select Archive File`、`From Archive File` |
| 14 | `src/renderer/i18n/locales/fr.json` | 新增 key | `Select Archive File`、`From Archive File` |
| 15 | `src/renderer/i18n/locales/es.json` | 新增 key | `Select Archive File`、`From Archive File` |

## 验收标准

### 功能验收

1. **ZIP 导入**：选择 `.zip` 文件导入 Skill，行为与改前完全一致（回归测试）
2. **tar.gz/tgz 导入**：选择 `.tar.gz` 或 `.tgz` 文件，正确解压并安装包含 `SKILL.md` 的 skill 目录
3. **tar.bz2 导入**：选择 `.tar.bz2` 文件，正确解压并安装
4. **tar.xz 导入**：选择 `.tar.xz` 文件，正确解压并安装
5. **不支持的格式**：选择 `.rar` 或 `.7z` 文件时，返回明确的错误提示，引导用户转格式
6. **Electron 模式**：文件选择器 filter 列出所有支持的扩展名，可以选择并导入
7. **Web 模式**：`<input>` accept 属性列出所有支持的扩展名，可以选择并上传
8. **向后兼容**：旧的 `POST /api/skills/import-from-zip` 路由仍然可用
9. **无 SKILL.md**：压缩包内无 `SKILL.md`/`SKILL.yaml` 时返回正确错误信息
10. **多 Skill**：一个压缩包内包含多个 skill 目录时全部正确安装

### 非功能验收

11. **跨平台**：Windows/Mac/Linux 上均能正常解压所有支持的格式
12. **类型安全**：`sourceType` 类型变更后全链路 TypeScript 无编译错误
13. **i18n**：所有新增文案已添加到所有语言文件，无 missing key
14. **不支持的格式提示**：rar/7z 格式给出明确提示文案

### 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-06-03 | 初始 PRD | 用户 |
| 2026-06-03 | 编码完成，typecheck + build 通过 | Claude |
