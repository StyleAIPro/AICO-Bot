# 技能库导入（ZIP / 文件夹） 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在技能库页面添加导入按钮，支持从 ZIP 压缩包或文件夹批量导入技能，核心安装逻辑统一为"扫描子目录 → 验证 → 复制"，兼容本地 Electron 和远程 Web 两种模式。

**架构：** `SkillManager` 拆为两层——`installFromDirectory(dirPath)` 是核心方法（扫描+验证+复制），`installFromZip(filePath)` 是壳方法（解压后调用前者）。前端通过 IPC（Electron）或 HTTP multipart（Web）调用，按钮支持 ZIP 和文件夹两种来源。

**技术栈：** `extract-zip`（ZIP 解压）、`multer`（HTTP multipart 上传）、Express 路由、Electron IPC

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `package.json` | 修改 | 添加 `extract-zip`、`@types/multer`、`multer` 依赖 |
| `src/main/services/skill/skill-manager.ts` | 修改 | 新增 `installFromDirectory()` 核心 + `installFromZip()` 壳方法 |
| `src/main/controllers/skill.controller.ts` | 修改 | 新增 `importSkills()` + `importFromZipBuffer()` 控制器方法 |
| `src/main/ipc/skill.ts` | 修改 | 新增 `skill:import-skills` IPC handle |
| `src/preload/index.ts` | 修改 | 暴露 `skillImportSkills` + `showOpenDialog` |
| `src/main/http/routes/index.ts` | 修改 | 新增 `POST /api/skills/import-from-zip` HTTP 端点 |
| `src/renderer/api/index.ts` | 修改 | 新增 `skillImportFromZip()` API 方法 |
| `src/renderer/components/skill/SkillLibrary.tsx` | 修改 | 添加导入按钮 + 下拉菜单 + ZIP/文件夹选择 |
| `src/renderer/i18n/locales/*.json` | 修改 | 新增翻译 key |

---

### 任务 1：安装依赖

**文件：**
- 修改：`package.json`

- [ ] **步骤 1：安装 extract-zip 和 multer**

```bash
cd E:/Project/AICO-Bot
npm install extract-zip multer
npm install -D @types/multer @types/extract-zip
```

- [ ] **步骤 2：验证安装成功**

运行：`npm ls extract-zip multer`
预期：显示两个包的版本号，无错误

- [ ] **步骤 3：Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: 添加 extract-zip 和 multer 依赖"
```

---

### 任务 2：后端核心 — SkillManager

**文件：**
- 修改：`src/main/services/skill/skill-manager.ts`

- [ ] **步骤 1：添加 import**

在文件顶部 import 区域（第 12 行 `import { existsSync } from 'fs';` 之后）添加：

```ts
import * as os from 'os';
import * as crypto from 'crypto';
import extractZip from 'extract-zip';
```

- [ ] **步骤 2：定义返回类型接口**

在 `SkillManager` class 之前（约第 21 行之前）添加：

```ts
export interface ImportSkillsResult {
  installed: string[];
  skipped: string[];
  errors: string[];
}
```

- [ ] **步骤 3：实现 installFromDirectory 核心方法 + installFromZip 壳方法**

在 `refresh()` 方法之后（第 606 行之后）添加：

```ts
/**
 * 从目录批量导入技能（核心方法）
 * 扫描一级子目录，每个含 SKILL.md 或 SKILL.yaml 的子目录视为一个技能
 */
async installFromDirectory(
  dirPath: string,
  onProgress?: (message: string) => void,
): Promise<ImportSkillsResult> {
  const result: ImportSkillsResult = { installed: [], skipped: [], errors: [] };

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const subDirs = entries.filter((e) => e.isDirectory());

  if (subDirs.length === 0) {
    result.errors.push('Directory contains no subdirectories');
    return result;
  }

  const targetDir = this.skillsDirs[0]; // ~/.agents/skills/

  for (const subDir of subDirs) {
    const skillName = subDir.name;
    const srcPath = path.join(dirPath, skillName);
    const hasSkillMd = existsSync(path.join(srcPath, 'SKILL.md'));
    const hasSkillYaml = existsSync(path.join(srcPath, 'SKILL.yaml'));

    if (!hasSkillMd && !hasSkillYaml) {
      result.skipped.push(skillName);
      onProgress?.(`Skipped (no SKILL.md/SKILL.yaml): ${skillName}`);
      continue;
    }

    const destPath = path.join(targetDir, skillName);

    try {
      if (existsSync(destPath)) {
        await fs.rm(destPath, { recursive: true, force: true });
      }

      await this.copyDirRecursive(srcPath, destPath);

      result.installed.push(skillName);
      onProgress?.(`Installed: ${skillName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${skillName}: ${msg}`);
      onProgress?.(`Failed: ${skillName} - ${msg}`);
    }
  }

  await this.refresh();

  onProgress?.(
    `Done. Installed: ${result.installed.length}, Skipped: ${result.skipped.length}, Errors: ${result.errors.length}`,
  );

  return result;
}

/**
 * 从 ZIP 文件导入技能（壳方法）
 * 解压到临时目录后调用 installFromDirectory
 */
async installFromZip(
  filePath: string,
  onProgress?: (message: string) => void,
): Promise<ImportSkillsResult> {
  const tmpDir = path.join(os.tmpdir(), `aico-skill-zip-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    onProgress?.(`Extracting ZIP: ${path.basename(filePath)}...`);
    await extractZip(filePath, { dir: tmpDir });
    return this.installFromDirectory(tmpDir, onProgress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { installed: [], skipped: [], errors: [`ZIP extraction failed: ${msg}`] };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 递归复制目录
 */
private async copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcEntry = path.join(src, entry.name);
    const destEntry = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await this.copyDirRecursive(srcEntry, destEntry);
    } else {
      await fs.copyFile(srcEntry, destEntry);
    }
  }
}
```

- [ ] **步骤 4：Re-read 确认文件完整性**

读取 `skill-manager.ts` 确认新增代码未被截断。

- [ ] **步骤 5：Commit**

```bash
git add src/main/services/skill/skill-manager.ts
git commit -m "feat(skill): 添加 installFromDirectory + installFromZip — 批量导入技能"
```

---

### 任务 3：后端 Controller

**文件：**
- 修改：`src/main/controllers/skill.controller.ts`

- [ ] **步骤 1：添加 import**

在文件顶部 import 区域添加：

```ts
import type { ImportSkillsResult } from '../services/skill/skill-manager';
```

检查文件顶部是否已有 `os`、`path`、`fs`、`crypto` 的 import。如果没有，添加：

```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
```

- [ ] **步骤 2：确认 ensureInitialized 和 syncSkillStateToSdk 已存在**

搜索这两个函数。如果存在则跳过，如果不存在则需要添加（参考设计文档中的代码）。

- [ ] **步骤 3：实现 importSkills 控制器方法**

在 `installSkillFromYaml()` 方法之后添加：

```ts
/**
 * 从文件路径导入技能（支持 ZIP 和文件夹）
 */
export async function importSkills(
  sourceType: 'zip' | 'folder',
  filePath: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; data?: ImportSkillsResult; error?: string }> {
  try {
    await ensureInitialized();
    const skillManager = SkillManager.getInstance();

    const onProgress = (message: string) => {
      onOutput?.({ type: 'stdout', content: message });
    };

    let result: ImportSkillsResult;
    if (sourceType === 'zip') {
      result = await skillManager.installFromZip(filePath, onProgress);
    } else {
      result = await skillManager.installFromDirectory(filePath, onProgress);
    }

    await syncSkillStateToSdk();

    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * 从 ZIP Buffer 导入技能（用于 HTTP 上传）
 */
export async function importFromZipBuffer(
  zipBuffer: Buffer,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; data?: ImportSkillsResult; error?: string }> {
  try {
    await ensureInitialized();
    const skillManager = SkillManager.getInstance();

    const tmpFile = path.join(os.tmpdir(), `aico-skill-upload-${crypto.randomUUID()}.zip`);
    await fs.writeFile(tmpFile, zipBuffer);

    try {
      const result = await skillManager.installFromZip(tmpFile, (message) => {
        onOutput?.({ type: 'stdout', content: message });
      });

      await syncSkillStateToSdk();

      return { success: true, data: result };
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
```

- [ ] **步骤 4：Re-read 确认文件完整性**

- [ ] **步骤 5：Commit**

```bash
git add src/main/controllers/skill.controller.ts
git commit -m "feat(skill): 添加 importSkills / importFromZipBuffer 控制器方法"
```

---

### 任务 4：IPC 通道

**文件：**
- 修改：`src/main/ipc/skill.ts`

- [ ] **步骤 1：添加 IPC handler**

在现有的 `skill:install` handler（约第 42-71 行）之后添加：

```ts
wrapIpcHandle(
  'skill:import-skills',
  async (event, input: { sourceType: 'zip' | 'folder'; filePath: string }) => {
    const onOutput = (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
      event.sender.send('skill:install-output', 'import-skills', data);
    };
    return skillController.importSkills(input.sourceType, input.filePath, onOutput);
  },
);
```

- [ ] **步骤 2：Re-read 确认文件完整性**

- [ ] **步骤 3：Commit**

```bash
git add src/main/ipc/skill.ts
git commit -m "feat(skill): 添加 skill:import-skills IPC 通道"
```

---

### 任务 5：Preload 暴露

**文件：**
- 修改：`src/preload/index.ts`

- [ ] **步骤 1：添加 skillImportSkills 类型定义**

在现有的 Skill Management 类型块（约第 562-574 行，`skillInstall` 之后）添加：

```ts
skillImportSkills: (input: { sourceType: 'zip' | 'folder'; filePath: string }) => Promise<IpcResponse>;
```

- [ ] **步骤 2：添加 showOpenDialog 类型定义**

在类型定义区域（搜索 `selectFolder` 附近）添加：

```ts
showOpenDialog: (options: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties: Array<'openFile' | 'openDirectory'> }) => Promise<string[]>;
```

- [ ] **步骤 3：添加 IPC invoke 实现**

在现有的 skill IPC invoke 块（`skillInstall` 之后）添加：

```ts
skillImportSkills: (input) => ipcRenderer.invoke('skill:import-skills', input),
```

在 `selectFolder` invoke 附近添加：

```ts
showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),
```

- [ ] **步骤 4：Re-read 确认文件完整性**

- [ ] **步骤 5：Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(skill): preload 暴露 skillImportSkills + showOpenDialog"
```

---

### 任务 6：IPC 主进程 handle（dialog:open）

**文件：**
- 修改：`src/main/ipc/`（找到 `selectFolder` 的 handle 所在文件）

- [ ] **步骤 1：找到 selectFolder 的 handle 位置**

搜索 `dialog:select-folder` 的 wrapIpcHandle，确认它在哪个文件。

- [ ] **步骤 2：在同一个文件中添加 dialog:open handle**

```ts
wrapIpcHandle(
  'dialog:open',
  async (_event, options: Electron.OpenDialogOptions) => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog(options);
    return result.filePaths;
  },
);
```

- [ ] **步骤 3：Re-read 确认文件完整性**

- [ ] **步骤 4：Commit**

```bash
git add src/main/ipc/
git commit -m "feat(skill): 添加 dialog:open IPC handle 通用文件选择"
```

---

### 任务 7：HTTP 端点（远程 Web 模式）

**文件：**
- 修改：`src/main/http/routes/index.ts`

- [ ] **步骤 1：添加 multer import**

在文件顶部 import 区域添加：

```ts
import multer from 'multer';
```

- [ ] **步骤 2：创建 multer 实例**

在 skill routes 区域之前添加：

```ts
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
```

- [ ] **步骤 3：添加 POST /api/skills/import-from-zip 路由**

在现有的 skill routes 块之后添加：

```ts
app.post(
  '/api/skills/import-from-zip',
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    try {
      const result = await skillController.importFromZipBuffer(req.file.buffer);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Upload processing failed',
      });
    }
  },
);
```

- [ ] **步骤 4：Re-read 确认文件完整性**

- [ ] **步骤 5：Commit**

```bash
git add src/main/http/routes/index.ts
git commit -m "feat(skill): 添加 POST /api/skills/import-from-zip HTTP 端点"
```

---

### 任务 8：渲染器 API 层

**文件：**
- 修改：`src/renderer/api/index.ts`

- [ ] **步骤 1：添加 skillImportFromZip API 方法**

在现有的 `skillInstall` 方法之后添加：

```ts
skillImportFromZip: async (file: File): Promise<
  ApiResponse<{ installed: string[]; skipped: string[]; errors: string[] }>
> => {
  if (isElectron()) {
    throw new Error('Use window.aicoBot.skillImportSkills directly in Electron mode');
  }
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${getBaseUrl()}/api/skills/import-from-zip`, {
    method: 'POST',
    body: formData,
  });
  return response.json();
},
```

> **注意**：需确认 `getBaseUrl()` 在该文件中可用。如果不可用，查看 `httpRequest` 函数是如何获取 base URL 的，并使用相同方式。

- [ ] **步骤 2：Re-read 确认文件完整性**

- [ ] **步骤 3：Commit**

```bash
git add src/renderer/api/index.ts
git commit -m "feat(skill): 添加 skillImportFromZip 渲染器 API"
```

---

### 任务 9：前端 SkillLibrary 导入按钮

**文件：**
- 修改：`src/renderer/components/skill/SkillLibrary.tsx`

- [ ] **步骤 1：添加所需图标 import**

在 lucide-react import 中添加 `PackagePlus`（如果未存在）和 `FolderInput`：

```ts
import { ..., PackagePlus, FolderInput } from 'lucide-react';
```

- [ ] **步骤 2：添加状态变量**

在 `useState` 区域添加：

```ts
const [importing, setImporting] = useState(false);
const [importMenuOpen, setImportMenuOpen] = useState(false);
```

- [ ] **步骤 3：添加隐藏的 file input ref（Web 模式 ZIP 上传用）**

```ts
const zipInputRef = useRef<HTMLInputElement>(null);
```

- [ ] **步骤 4：添加 handleImportFromZip 处理函数**

```ts
const handleImportFromZip = useCallback(async () => {
  setImportMenuOpen(false);
  if (importing) return;

  if (isElectron()) {
    try {
      const filePaths = await window.aicoBot.showOpenDialog({
        title: 'Select ZIP file',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        properties: ['openFile'],
      });

      if (!filePaths || filePaths.length === 0) return;

      setImporting(true);
      const result = await window.aicoBot.skillImportSkills({
        sourceType: 'zip',
        filePath: filePaths[0],
      });

      if (result?.success && result.data) {
        const { installed, skipped, errors } = result.data;
        if (installed.length > 0) {
          console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
        }
        if (skipped.length > 0) {
          console.warn(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
        }
        if (errors.length > 0) {
          console.error(`Errors: ${errors.join('; ')}`);
        }
        refreshSkills();
      }
    } catch (err) {
      console.error('Import from ZIP failed:', err);
    } finally {
      setImporting(false);
    }
  } else {
    zipInputRef.current?.click();
  }
}, [importing, refreshSkills]);
```

- [ ] **步骤 5：添加 handleImportFromFolder 处理函数（仅 Electron）**

```ts
const handleImportFromFolder = useCallback(async () => {
  setImportMenuOpen(false);
  if (importing) return;

  try {
    const dirPaths = await window.aicoBot.showOpenDialog({
      title: 'Select folder containing skills',
      properties: ['openDirectory'],
    });

    if (!dirPaths || dirPaths.length === 0) return;

    setImporting(true);
    const result = await window.aicoBot.skillImportSkills({
      sourceType: 'folder',
      filePath: dirPaths[0],
    });

    if (result?.success && result.data) {
      const { installed, skipped, errors } = result.data;
      if (installed.length > 0) {
        console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
      }
      if (skipped.length > 0) {
        console.warn(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
      }
      if (errors.length > 0) {
        console.error(`Errors: ${errors.join('; ')}`);
      }
      refreshSkills();
    }
  } catch (err) {
    console.error('Import from folder failed:', err);
  } finally {
    setImporting(false);
  }
}, [importing, refreshSkills]);
```

- [ ] **步骤 6：添加 handleZipFileChange 处理函数（Web 模式）**

```ts
const handleZipFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  setImporting(true);
  try {
    const result = await api.skillImportFromZip(file);

    if (result?.success && result.data) {
      const { installed, skipped, errors } = result.data;
      if (installed.length > 0) {
        console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
      }
      if (skipped.length > 0) {
        console.warn(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
      }
      if (errors.length > 0) {
        console.error(`Errors: ${errors.join('; ')}`);
      }
      refreshSkills();
    }
  } catch (err) {
    console.error('Import from ZIP failed:', err);
  } finally {
    setImporting(false);
    if (zipInputRef.current) {
      zipInputRef.current.value = '';
    }
  }
}, [refreshSkills]);
```

- [ ] **步骤 7：替换刷新按钮旁的 JSX 为带下拉菜单的导入按钮**

找到刷新按钮的 JSX 位置（约第 481-489 行），替换为：

```tsx
<div className="flex items-center gap-2">
  {/* 导入按钮 + 下拉菜单 */}
  <div className="relative">
    <button
      onClick={() => setImportMenuOpen(!importMenuOpen)}
      disabled={importing}
      className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:opacity-50"
    >
      {importing ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <PackagePlus className="w-3 h-3" />
      )}
      {t('Import')}
    </button>
    {importMenuOpen && (
      <div className="absolute left-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg py-1 z-50 min-w-[160px]">
        <button
          onClick={handleImportFromZip}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent text-left"
        >
          <PackagePlus className="w-3 h-3" />
          {t('From ZIP File')}
        </button>
        {isElectron() && (
          <button
            onClick={handleImportFromFolder}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent text-left"
          >
            <FolderInput className="w-3 h-3" />
            {t('From Folder')}
          </button>
        )}
      </div>
    )}
  </div>
  {/* 刷新按钮 */}
  <button
    onClick={handleRefresh}
    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
  >
    <RefreshCw className="w-3 h-3" />
    {t('Refresh')}
  </button>
</div>
{/* 隐藏的 file input（Web 模式 ZIP 上传用） */}
<input
  ref={zipInputRef}
  type="file"
  accept=".zip"
  className="hidden"
  onChange={handleZipFileChange}
/>
```

- [ ] **步骤 8：添加点击外部关闭菜单**

在组件中添加一个 effect 来关闭菜单：

```ts
useEffect(() => {
  if (!importMenuOpen) return;
  const handler = () => setImportMenuOpen(false);
  document.addEventListener('click', handler);
  return () => document.removeEventListener('click', handler);
}, [importMenuOpen]);
```

同时在导入按钮的 `onClick` 中阻止冒泡：

```tsx
<button
  onClick={(e) => { e.stopPropagation(); setImportMenuOpen(!importMenuOpen); }}
  ...
>
```

- [ ] **步骤 9：检查 isElectron 的导入**

确认文件中已有 `isElectron` 的导入。如果没有，从 `../../api` 导入：

```ts
import { api, isElectron } from '../../api';
```

- [ ] **步骤 10：Re-read 确认文件完整性**

- [ ] **步骤 11：Commit**

```bash
git add src/renderer/components/skill/SkillLibrary.tsx
git commit -m "feat(skill): 技能库添加导入按钮 — 支持 ZIP 和文件夹"
```

---

### 任务 10：国际化

**文件：**
- 修改：`src/renderer/i18n/locales/*.json`

- [ ] **步骤 1：运行 i18n 提取**

```bash
cd E:/Project/AICO-Bot
npm run i18n:extract
```

- [ ] **步骤 2：运行 i18n 翻译**

```bash
npm run i18n:translate
```

- [ ] **步骤 3：手动检查中文翻译**

确认 `Import`、`From ZIP File`、`From Folder` 翻译正确（如"导入"、"从 ZIP 文件"、"从文件夹"）。

- [ ] **步骤 4：Commit**

```bash
git add src/renderer/i18n/
git commit -m "chore(i18n): 添加 Import / From ZIP File / From Folder 翻译"
```

---

### 任务 11：类型检查 + 构建验证

- [ ] **步骤 1：TypeScript 类型检查**

```bash
cd E:/Project/AICO-Bot
npm run typecheck
```

预期：PASS。如有错误，逐一修复。

- [ ] **步骤 2：构建验证**

```bash
npm run build
```

预期：PASS。如有错误，逐一修复。

- [ ] **步骤 3：Commit（如有修复）**

```bash
git add -A
git commit -m "fix(skill): 修复导入功能的类型和构建问题"
```

---

### 任务 12：Re-read 验证

- [ ] **步骤 1：逐个 re-read 所有修改文件**

1. `src/main/services/skill/skill-manager.ts` — `installFromDirectory()` + `installFromZip()` + `copyDirRecursive()` 完整
2. `src/main/controllers/skill.controller.ts` — `importSkills()` + `importFromZipBuffer()` 完整
3. `src/main/ipc/skill.ts` — `skill:import-skills` handler 完整
4. `src/preload/index.ts` — 类型 + invoke 完整
5. `src/main/http/routes/index.ts` — multer + POST 路由完整
6. `src/renderer/api/index.ts` — `skillImportFromZip()` 完整
7. `src/renderer/components/skill/SkillLibrary.tsx` — 按钮 + 下拉菜单 + 处理函数完整

- [ ] **步骤 2：更新设计规格为 done（如有 PRD 流程）**
