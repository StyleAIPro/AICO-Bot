# Windows 本地开发指南

以下是在 Windows 环境下进行 AICO-Bot 本地开发、构建和打包的详细步骤。

## 目录

- [环境要求](#环境要求)
- [安装编译工具](#安装编译工具)
- [克隆与安装](#克隆与安装)
- [下载二进制依赖](#下载二进制依赖)
- [配置环境变量](#配置环境变量可选)
- [启动开发服务器](#启动开发服务器)
- [VS Code 调试](#vs-code-调试)
- [运行测试](#运行测试)
- [构建](#构建)
- [打包发布](#打包发布)
- [国际化 i18n](#国际化-i18n)
- [常见问题](#常见问题)

## 环境要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| **Node.js** | 20.x | 推荐使用 LTS 版本 |
| **npm** | 10.x | 随 Node.js 一起安装 |
| **Git** | 最新版 | 用于克隆代码 |
| **Python** | 3.x | `node-gyp` 原生模块编译需要（部分依赖如 `node-pty`、`better-sqlite3`） |
| **Visual Studio Build Tools** | 2022+ | C++ 编译工具，`node-gyp` 编译原生模块时需要 |

## 安装编译工具

原生模块（`node-pty`、`better-sqlite3`、`@parcel/watcher`）需要 C++ 编译环境。安装方式：

```powershell
# 方法一：通过 npm 安装所有必需的构建工具（推荐）
npm install -g windows-build-tools

# 方法二：手动安装
# 1. 下载安装 Visual Studio Build Tools：
#    https://visualstudio.microsoft.com/visual-cpp-build-tools/
#    安装时勾选 "使用 C++ 的桌面开发" 工作负载
#
# 2. 确保 Python 已安装并在 PATH 中
python --version
```

## 克隆与安装

```powershell
# 克隆仓库
git clone https://github.com/openkursar/hello-aico-bot.git
cd hello-aico-bot

# 安装依赖（项目 .npmrc 已配置 legacy-peer-deps=true）
npm install
```

> `npm install` 过程中会自动执行 `postinstall`（运行 `patch-package` 应用补丁）。

## 下载二进制依赖

AICO-Bot 依赖一些平台特定的二进制文件（cloudflared、gh CLI、better-sqlite3 prebuild、@parcel/watcher），需要手动下载：

```powershell
# 自动检测当前平台并下载（Windows 下自动识别为 win）
npm run prepare

# 如需为所有平台下载（用于跨平台打包）
npm run prepare:all
```

该脚本会下载以下内容到项目中：

| 文件 | 说明 |
|------|------|
| `node_modules/cloudflared/bin/cloudflared.exe` | Cloudflare 隧道客户端 |
| `node_modules/@parcel/watcher-win32-x64/` | 文件监听模块 |
| `node_modules/better-sqlite3/prebuilds/win32-x64/` | SQLite 原生模块 |
| `resources/gh/win-x64/gh.exe` | GitHub CLI |

## 配置环境变量（可选）

复制环境变量模板并按需填写：

```powershell
copy .env.example .env.local
```

编辑 `.env.local`，主要配置项：

| 变量 | 说明 | 是否必须 |
|------|------|---------|
| `AICO_BOT_TEST_API_KEY` | 测试用 API Key（E2E 测试、i18n 翻译） | 否 |
| `AICO_BOT_TEST_API_URL` | API 地址 | 否 |
| `AICO_BOT_TEST_MODEL` | 测试用模型名 | 否 |
| `GH_TOKEN` | GitHub Token（发布 Release 时需要） | 仅发布时 |
| `AICO_BOT_GA_MEASUREMENT_ID` | Google Analytics（可留空） | 否 |
| `AICO_BOT_BAIDU_SITE_ID` | 百度统计（可留空） | 否 |

## 启动开发服务器

```powershell
# 启动开发模式（使用独立的 ~/.aico-bot-dev 数据目录，避免污染正式数据）
npm run dev
# 或
npm run dev:win
```

开发模式特点：

- 开发服务器端口：`8081`
- 用户数据目录：`~/.aico-bot-dev`（与正式版 `~/.aico-bot` 隔离）
- 支持 HMR（热模块替换），修改 React 代码后页面自动刷新
- 主进程代码修改后会自动重启 Electron

## VS Code 调试

项目内置了 VS Code 调试配置（`.vscode/launch.json`）：

1. 在 VS Code 中打开项目
2. 按 `F5` 或在调试面板选择 **"Debug Main Process"**
3. 会自动启动 Electron 并附加调试器，可在主进程代码中打断点

也可使用 **"Attach to Main Process"** 配置手动附加到运行中的 Electron 进程（端口 9229）。

## 运行测试

### 单元测试

```powershell
# 运行全部测试（二进制检查 + 单元测试）
npm run test

# 仅运行单元测试
npm run test:unit

# 单元测试 watch 模式（开发时使用）
npm run test:unit:watch

# 运行单个测试文件
npx vitest run --config tests/vitest.config.ts tests/unit/services/config.test.ts

# 运行匹配名称的测试
npx vitest run --config tests/vitest.config.ts -t "should return default config"
```

### E2E 测试

E2E 测试需要先执行 `npm run build`，并在 `.env.local` 中配置有效的 API Key：

```powershell
npm run build
npm run test:e2e            # 全部 E2E 测试
npm run test:e2e:smoke      # 仅冒烟测试
npm run test:e2e:headed     # 带浏览器 UI 的 E2E 测试
```

## 构建

```powershell
# 构建 Electron 应用（输出到 out/ 目录）
npm run build

# 构建并打包 Windows 安装程序（NSIS）
npm run build:win

# 仅构建 Windows x64 架构
npm run build:win-x64
```

`npm run build` 会执行以下步骤：

1. `build:proxy` — 编译 `packages/remote-agent-proxy/` TypeScript
2. `build:patch-sdk` — 应用 SDK 补丁
3. `build:offline-bundle` — 构建离线部署包（自动嵌入 EXE）
4. `electron-vite build` — 构建主进程、预加载脚本和渲染进程

### 单独构建离线部署包

修改了 `packages/remote-agent-proxy/` 源码后，可单独重建离线部署包，无需完整构建：

```powershell
npm run build:offline-bundle
```

产物输出到 `resources/offline-bundles/`：

| 文件 | 说明 |
|------|------|
| `aico-bot-offline-linux-x64.tar.xz` | Linux x64 离线包 |
| `aico-bot-offline-linux-arm64.tar.xz` | Linux arm64 离线包 |

> **注意**：单独构建离线包不会更新 EXE 安装包。需要完整构建（`npm run build:win`）才能将新离线包嵌入安装程序。

构建产物：

| 目录 | 说明 |
|------|------|
| `out/` | electron-vite 编译输出 |
| `dist/` | electron-builder 打包输出（运行 `build:win` 后生成） |

## 打包发布

发布到 GitHub Releases 需要在 `.env.local` 中配置 `GH_TOKEN`：

```powershell
# 构建并发布 Windows 版本
npm run release:win

# 同时构建并发布多平台版本
npm run release
```

Windows 打包使用 NSIS 安装程序（`.exe`），配置说明：

- 支持自定义安装目录
- 默认非全机安装（per-user）
- 卸载时不会删除用户数据

## 国际化（i18n）

添加新的用户可见文本后，需要更新翻译文件：

```powershell
# 提取所有 t() 调用中的新文本
npm run i18n:extract

# 使用 AI 翻译（需要 .env.local 中配置 AICO_BOT_TEST_* 变量）
npm run i18n:translate

# 一步完成提取 + 翻译
npm run i18n
```

## 常见问题

### Q: `npm install` 时原生模块编译失败？

确保已安装 Visual Studio Build Tools 和 Python。运行：

```powershell
npm config set msvs_version 2022
npm install
```

### Q: 启动后白屏或界面不显示？

检查开发控制台是否有错误。可在 Electron 窗口中按 `Ctrl+Shift+I` 打开 DevTools 查看渲染进程日志。

### Q: 如何清理开发数据？

开发模式使用 `~/.aico-bot-dev` 目录存储数据。删除该目录即可重置：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.aico-bot-dev"
```

### Q: 端口 8081 被占用？

修改 `electron.vite.config.ts` 中的 `server.port` 值，或在启动命令中指定其他端口。

### Q: better-sqlite3 / node-pty 原生模块报错？

尝试重新编译原生模块：

```powershell
npx electron-rebuild
npm run prepare
```

### Q: `npm run prepare` 下载失败（网络问题）？

该脚本会自动重试（包括跳过代理重试）。如果仍然失败，可手动下载对应文件放到指定路径，或配置代理：

```powershell
# 设置代理
set HTTPS_PROXY=http://your-proxy:port
npm run prepare
```
