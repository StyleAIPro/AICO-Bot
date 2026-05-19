# 技能库 ZIP 上传导入 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在技能库页面添加 ZIP 上传按钮，支持从 ZIP 压缩包批量导入技能，兼容本地 Electron 和远程 Web 两种模式。

**架构：** 后端新增 `installFromZip()` 方法（解压 ZIP → 扫描子目录 → 复制到技能目录 → 刷新缓存）。前端通过 IPC（Electron）或 HTTP multipart（Web）调用。复用现有 `skill:install-output` 事件流反馈进度。

**技术栈：** `extract-zip`（ZIP 解压）、`multer`（HTTP multipart 上传）、Express 路由、Electron IPC

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `package.json` | 修改 | 添加 `extract-zip`、`@types/multer`、`multer` 依赖 |
| `src/main/services/skill/skill-manager.ts` | 修改 | 新增 `installFromZip(filePath)` 核心解压+安装方法 |
| `src/main/controllers/skill.controller.ts` | 修改 | 新增 `installFromZip()` 控制器方法 |
| `src/main/ipc/skill.ts` | 修改 | 新增 `skill:install-from-zip` IPC handle |
| `src/preload/index.ts` | 修改 | 暴露 `skillInstallFromZip` + 类型定义 |
| `src/main/http/routes/index.ts` | 修改 | 新增 `POST /api/skills/install-from-zip` HTTP 端点 |
| `src/renderer/api/index.ts` | 修改 | 新增 `skillInstallFromZip()` 双模式 API |
| `src/renderer/components/skill/SkillLibrary.tsx` | 修改 | 添加上传按钮 + 双模式文件选择 + 进度监听 |
| `src/renderer/i18n/locales/zh-CN.json` 等 | 修改 | 新增 `Upload ZIP` 等翻译 key |

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

### 任务 2：后端核心 — SkillManager.installFromZip()

**文件：**
- 修改：`src/main/services/skill/skill-manager.ts`

- [ ] **步骤 1：添加 import**

在文件顶部 import 区域添加（第 12 行 `import { existsSync } from 'fs';` 之后）：

```ts
import * as os from 'os';
import * as crypto from 'crypto';
import extractZip from 'extract-zip';
```

- [ ] **步骤 2：定义返回类型接口**

在 `SkillManager` class 之前的文件中（约第 21 行之前）添加：

```ts
export interface ZipInstallResult {
  installed: string[];
  skipped: string[];
  errors: string[];
}
```

- [ ] **步骤 3：实现 installFromZip 方法**

在 `refresh()` 方法之后（第 606 行之后）添加：

```ts
/**
 * 从 ZIP 文件安装技能
 * ZIP 结构：一级子目录各为一个技能，必须包含 SKILL.md 或 SKILL.yaml
 */
async installFromZip(
  filePath: string,
  onProgress?: (message: string) => void,
): Promise<ZipInstallResult> {
  const result: ZipInstallResult = { installed: [], skipped: [], errors: [] };

  // 1. 创建临时目录
  const tmpDir = path.join(os.tmpdir(), `aico-skill-zip-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    onProgress?.(`Extracting ZIP: ${path.basename(filePath)}...`);

    // 2. 解压 ZIP 到临时目录
    await extractZip(filePath, { dir: tmpDir });

    // 3. 扫描一级子目录
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    const subDirs = entries.filter((e) => e.isDirectory());

    if (subDirs.length === 0) {
      result.errors.push('ZIP contains no subdirectories');
      return result;
    }

    const targetDir = this.skillsDirs[0]; // ~/.agents/skills/

    // 4. 逐个处理子目录
    for (const subDir of subDirs) {
      const skillName = subDir.name;
      const srcPath = path.join(tmpDir, skillName);
      const hasSkillMd = existsSync(path.join(srcPath, 'SKILL.md'));
      const hasSkillYaml = existsSync(path.join(srcPath, 'SKILL.yaml'));

      if (!hasSkillMd && !hasSkillYaml) {
        result.skipped.push(skillName);
        onProgress?.(`Skipped (no SKILL.md/SKILL.yaml): ${skillName}`);
        continue;
      }

      const destPath = path.join(targetDir, skillName);

      try {
        // 5. 同名覆盖：先删除旧目录
        if (existsSync(destPath)) {
          await fs.rm(destPath, { recursive: true, force: true });
        }

        // 6. 复制目录到目标位置
        await this.copyDirRecursive(srcPath, destPath);

        result.installed.push(skillName);
        onProgress?.(`Installed: ${skillName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${skillName}: ${msg}`);
        onProgress?.(`Failed: ${skillName} - ${msg}`);
      }
    }

    // 7. 刷新缓存
    await this.refresh();

    onProgress?.(
      `Done. Installed: ${result.installed.length}, Skipped: ${result.skipped.length}, Errors: ${result.errors.length}`,
    );

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`ZIP extraction failed: ${msg}`);
    return result;
  } finally {
    // 8. 清理临时目录
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

读取 `skill-manager.ts` 确认新增代码未被截断或覆盖。

- [ ] **步骤 5：Commit**

```bash
git add src/main/services/skill/skill-manager.ts
git commit -m "feat(skill): 添加 installFromZip 方法 — 解压 ZIP 批量安装技能"
```

---

### 任务 3：后端 Controller

**文件：**
- 修改：`src/main/controllers/skill.controller.ts`

- [ ] **步骤 1：添加 import**

在文件顶部 import 区域（约第 4 行 `import { SkillManager }` 之后）添加 `ZipInstallResult` 类型导入：

```ts
import type { ZipInstallResult } from '../services/skill/skill-manager';
```

- [ ] **步骤 2：添加 ensureInitialized 辅助函数（如不存在）**

如果文件中没有 `ensureInitialized` 函数，在第一个 controller 函数之前添加：

```ts
async function ensureInitialized(): Promise<void> {
  const manager = SkillManager.getInstance();
  if (manager.getInstalledSkills().length === 0) {
    await manager.initialize();
  }
}
```

如果已有该函数则跳过此步骤。

- [ ] **步骤 3：实现 installFromZip 控制器方法**

在 `installSkillFromYaml()` 方法之后添加：

```ts
export async function installFromZip(
  filePath: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; data?: ZipInstallResult; error?: string }> {
  try {
    await ensureInitialized();
    const skillManager = SkillManager.getInstance();

    const result = await skillManager.installFromZip(filePath, (message) => {
      onOutput?.({ type: 'stdout', content: message });
    });

    // 安装后同步 SDK 状态
    await syncSkillStateToSdk();

    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export async function installFromZipBuffer(
  zipBuffer: Buffer,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; data?: ZipInstallResult; error?: string }> {
  try {
    await ensureInitialized();
    const skillManager = SkillManager.getInstance();

    // 将 Buffer 写入临时文件
    const *os = await import('os');
    const *path = await import('path');
    const *fs = await import('fs/promises');
    const *crypto = await import('crypto');
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

> **注意**：`installFromZipBuffer` 中 `import('os')` 等不应使用 `const *`，而是在文件顶部已有 import 的前提下直接使用 `os`、`path`、`fs`、`crypto`。请检查文件顶部已有的 import 语句，如果已有这些模块的 import，则直接使用。如果没有，在文件顶部添加。

**实际写法应为**（根据现有 import 调整）：

```ts
export async function installFromZipBuffer(
  zipBuffer: Buffer,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; data?: ZipInstallResult; error?: string }> {
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

确保 `os`、`path`、`fs`、`crypto` 已在文件顶部 import 中。

- [ ] **步骤 4：Re-read 确认文件完整性**

- [ ] **步骤 5：Commit**

```bash
git add src/main/controllers/skill.controller.ts
git commit -m "feat(skill): 添加 installFromZip / installFromZipBuffer 控制器方法"
```

---

### 任务 4：IPC 通道

**文件：**
- 修改：`src/main/ipc/skill.ts`

- [ ] **步骤 1：添加 IPC handler**

在现有的 `skill:install` handler（约第 42-71 行）之后添加：

```ts
wrapIpcHandle(
  'skill:install-from-zip',
  async (event, input: { filePath: string }) => {
    const onOutput = (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
      event.sender.send('skill:install-output', 'zip-upload', data);
    };
    return skillController.installFromZip(input.filePath, onOutput);
  },
);
```

- [ ] **步骤 2：Re-read 确认文件完整性**

- [ ] **步骤 3：Commit**

```bash
git add src/main/ipc/skill.ts
git commit -m "feat(skill): 添加 skill:install-from-zip IPC 通道"
```

---

### 任务 5：Preload 暴露

**文件：**
- 修改：`src/preload/index.ts`

- [ ] **步骤 1：添加类型定义**

在现有的 Skill Management 类型块（约第 562-574 行，`skillInstall` 之后）添加：

```ts
skillInstallFromZip: (filePath: string) => Promise<IpcResponse>;
```

- [ ] **步骤 2：添加 IPC invoke 实现**

在现有的 skill IPC invoke 块（约第 1144-1152 行，`skillInstall` 之后）添加：

```ts
skillInstallFromZip: (filePath: string) => ipcRenderer.invoke('skill:install-from-zip', { filePath }),
```

- [ ] **步骤 3：Re-read 确认文件完整性**

- [ ] **步骤 4：Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(skill): preload 暴露 skillInstallFromZip 方法"
```

---

### 任务 6：HTTP 端点（远程 Web 模式）

**文件：**
- 修改：`src/main/http/routes/index.ts`

- [ ] **步骤 1：添加 multer import**

在文件顶部 import 区域（约第 1-51 行）添加：

```ts
import multer from 'multer';
```

- [ ] **步骤 2：创建 multer 实例（memory storage，50MB 限制）**

在 skill routes 区域之前（约第 1530 行）添加：

```ts
// ===== Multer for file uploads (memory storage, 50MB limit) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
```

- [ ] **步骤 3：添加 POST /api/skills/install-from-zip 路由**

在现有的 skill routes 块（约第 1535-1564 行，`app.get('/api/skills/config', ...)` 之后）添加：

```ts
app.post(
  '/api/skills/install-from-zip',
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    try {
      const result = await skillController.installFromZipBuffer(req.file.buffer);
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
git commit -m "feat(skill): 添加 POST /api/skills/install-from-zip HTTP 端点"
```

---

### 任务 7：渲染器 API 层

**文件：**
- 修改：`src/renderer/api/index.ts`

- [ ] **步骤 1：添加 skillInstallFromZip API 方法**

在现有的 `skillInstall` 方法（约第 2369-2378 行）之后添加：

```ts
skillInstallFromZip: async (file: File): Promise<
  ApiResponse<{ installed: string[]; skipped: string[]; errors: string[] }>
> => {
  if (isElectron()) {
    // Electron 模式：通过 IPC 传递文件路径
    // 需要先通过 dialog 获取文件路径（在前端处理）
    throw new Error('Use window.aicoBot.skillInstallFromZip(filePath) directly in Electron mode');
  }
  // 远程 Web 模式：HTTP multipart 上传
  const formData = new FormData();
  formData.append('file', file);
  return httpRequest('POST', '/api/skills/install-from-zip', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
},
```

> **注意**：需要检查 `httpRequest` 函数签名是否支持第三个 options 参数和 FormData body。如果不支持，需要适配。查看 `httpRequest` 的实际签名后调整。

**如果 `httpRequest` 不支持 FormData**，替代方案为：

```ts
skillInstallFromZip: async (file: File): Promise<
  ApiResponse<{ installed: string[]; skipped: string[]; errors: string[] }>
> => {
  if (isElectron()) {
    throw new Error('Use window.aicoBot.skillInstallFromZip(filePath) directly in Electron mode');
  }
  const formData = new FormData();
  formData.append('file', file);
  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}/api/skills/install-from-zip`, {
    method: 'POST',
    body: formData,
  });
  return response.json();
},
```

需根据实际 `httpRequest` 和 `getBaseUrl` 的签名来决定使用哪种写法。

- [ ] **步骤 2：Re-read 确认文件完整性**

- [ ] **步骤 3：Commit**

```bash
git add src/renderer/api/index.ts
git commit -m "feat(skill): 添加 skillInstallFromZip 渲染器 API"
```

---

### 任务 8：前端 SkillLibrary 上传按钮

**文件：**
- 修改：`src/renderer/components/skill/SkillLibrary.tsx`

- [ ] **步骤 1：添加 PackagePlus 图标 import**

在现有 lucide-react import 行（约第 12-14 行）中添加 `PackagePlus`：

```ts
import { Book, ToggleLeft, ToggleRight, Trash2, Download, FileCode, FolderOpen,
         Folder, ChevronRight, ChevronDown, FileText, X, Loader2, RefreshCw,
         Server, HardDrive, GripVertical, Github, ExternalLink, Upload, PackagePlus } from 'lucide-react';
```

> 注意：`Upload` 已经在 import 中，但 `Upload` 的语义与"上传文件"有歧义（也被"同步到服务器"按钮使用）。使用 `PackagePlus` 图标更清晰（ZIP 包 + 加号）。或者如果 `Upload` 未被其他按钮使用，可以直接用 `Upload`。检查实际代码中 `Upload` 图标是否已被使用。

- [ ] **步骤 2：添加状态变量**

在组件内的 `useState` 区域（搜索现有 `const [installOutput` 或类似状态）添加：

```ts
const [zipUploading, setZipUploading] = useState(false);
```

- [ ] **步骤 3：添加隐藏的 file input ref**

在现有 ref 声明区域添加：

```ts
const zipInputRef = useRef<HTMLInputElement>(null);
```

- [ ] **步骤 4：添加 handleZipUpload 处理函数**

在 `handleExport` 函数附近添加：

```ts
const handleZipUpload = useCallback(async () => {
  if (zipUploading) return;

  if (isElectron()) {
    // Electron 模式：使用 dialog 选择文件
    try {
      const filePath = await window.aicoBot.showOpenDialog({
        title: 'Select ZIP file',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        properties: ['openFile'],
      });

      if (!filePath || !filePath[0]) return;

      setZipUploading(true);
      const result = await window.aicoBot.skillInstallFromZip(filePath[0]);

      if (result?.success && result.data) {
        const { installed, skipped, errors } = result.data;
        // 通知 toast（根据项目现有的 toast 方式实现）
        if (installed.length > 0) {
          console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
        }
        if (skipped.length > 0) {
          console.warn(`Skipped ${skipped.length} skills: ${skipped.join(', ')}`);
        }
        if (errors.length > 0) {
          console.error(`Errors: ${errors.join('; ')}`);
        }
        refreshSkills();
      }
    } catch (err) {
      console.error('ZIP upload failed:', err);
    } finally {
      setZipUploading(false);
    }
  } else {
    // 远程 Web 模式：触发 file input
    zipInputRef.current?.click();
  }
}, [zipUploading, refreshSkills]);
```

- [ ] **步骤 5：添加 handleZipFileChange 处理函数（Web 模式）**

```ts
const handleZipFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  setZipUploading(true);
  try {
    const result = await api.skillInstallFromZip(file);

    if (result?.success && result.data) {
      const { installed, skipped, errors } = result.data;
      if (installed.length > 0) {
        console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
      }
      if (skipped.length > 0) {
        console.warn(`Skipped ${skipped.length} skills: ${skipped.join(', ')}`);
      }
      if (errors.length > 0) {
        console.error(`Errors: ${errors.join('; ')}`);
      }
      refreshSkills();
    }
  } catch (err) {
    console.error('ZIP upload failed:', err);
  } finally {
    setZipUploading(false);
    // 重置 input，允许选择相同文件
    if (zipInputRef.current) {
      zipInputRef.current.value = '';
    }
  }
}, [refreshSkills]);
```

- [ ] **步骤 6：在刷新按钮旁添加上传按钮 JSX**

找到刷新按钮的 JSX 位置（约第 481-489 行），在刷新按钮的 `<div>` 中添加上传按钮：

```tsx
<div className="flex items-center gap-2">
  <button
    onClick={handleZipUpload}
    disabled={zipUploading}
    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:opacity-50"
  >
    {zipUploading ? (
      <Loader2 className="w-3 h-3 animate-spin" />
    ) : (
      <PackagePlus className="w-3 h-3" />
    )}
    {t('Upload ZIP')}
  </button>
  <button
    onClick={handleRefresh}
    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
  >
    <RefreshCw className="w-3 h-3" />
    {t('Refresh')}
  </button>
</div>
```

- [ ] **步骤 7：添加隐藏的 file input（仅 Web 模式）**

在上传按钮附近（同一组件的 JSX return 中）添加：

```tsx
<input
  ref={zipInputRef}
  type="file"
  accept=".zip"
  className="hidden"
  onChange={handleZipFileChange}
/>
```

- [ ] **步骤 8：检查 isElectron 的导入和使用**

确认文件中已有 `isElectron` 的导入或使用。如果没有，需要从 `../../api` 导入：

```ts
import { api, isElectron } from '../../api';
```

同时确认 `window.aicoBot.showOpenDialog` 在 preload 中已暴露。如果没有，需要在 preload 中添加。

- [ ] **步骤 9：Re-read 确认文件完整性**

- [ ] **步骤 10：Commit**

```bash
git add src/renderer/components/skill/SkillLibrary.tsx
git commit -m "feat(skill): 技能库列表头部添加 ZIP 上传按钮"
```

---

### 任务 9：Preload 补充 — showOpenDialog 暴露

**文件：**
- 修改：`src/preload/index.ts`

- [ ] **步骤 1：检查 showOpenDialog 是否已暴露**

搜索 `showOpenDialog`。如果已在 preload 中暴露（类型定义 + ipcRenderer.invoke），跳过此任务。

如果未暴露，在类型定义区域添加：

```ts
showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<string[] | null>;
```

在 IPC invoke 区域添加：

```ts
showOpenDialog: (options) => ipcRenderer.invoke('dialog:open-file', options),
```

同时在 `src/main/ipc/` 中添加对应的 handle（如果不存在）。

> **注意**：项目可能已有通用的 dialog IPC。先搜索确认再决定是否需要新建。

- [ ] **步骤 2：Commit（如有改动）**

```bash
git add src/preload/index.ts src/main/ipc/
git commit -m "feat(skill): preload 暴露 showOpenDialog 用于 ZIP 文件选择"
```

---

### 任务 10：国际化

**文件：**
- 修改：`src/renderer/i18n/locales/*.json`（所有语言文件）

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

打开 `src/renderer/i18n/locales/zh-CN.json`，搜索 `Upload ZIP`，确认翻译为"上传 ZIP"或更合适的中文文本。如果翻译不准确，手动修改。

- [ ] **步骤 4：Commit**

```bash
git add src/renderer/i18n/
git commit -m "chore(i18n): 添加 Upload ZIP 翻译"
```

---

### 任务 11：类型检查 + 构建验证

- [ ] **步骤 1：运行 TypeScript 类型检查**

```bash
cd E:/Project/AICO-Bot
npm run typecheck
```

预期：PASS，无错误。如果有错误，逐一修复。

- [ ] **步骤 2：运行构建**

```bash
npm run build
```

预期：PASS，构建成功。

- [ ] **步骤 3：修复所有问题后 Commit（如有修复）**

```bash
git add -A
git commit -m "fix(skill): 修复 ZIP 上传功能的类型和构建问题"
```

---

### 任务 12：Re-read 验证所有修改文件

- [ ] **步骤 1：逐个 re-read 所有修改的文件**

按以下顺序读取并确认：
1. `src/main/services/skill/skill-manager.ts` — `installFromZip()` 和 `copyDirRecursive()` 完整
2. `src/main/controllers/skill.controller.ts` — `installFromZip()` 和 `installFromZipBuffer()` 完整
3. `src/main/ipc/skill.ts` — `skill:install-from-zip` handler 完整
4. `src/preload/index.ts` — 类型和 invoke 完整
5. `src/main/http/routes/index.ts` — multer + POST 路由完整
6. `src/renderer/api/index.ts` — `skillInstallFromZip()` 完整
7. `src/renderer/components/skill/SkillLibrary.tsx` — 按钮和处理函数完整

- [ ] **步骤 2：最终 Commit**

如果所有文件都正确，不需要额外 commit。
