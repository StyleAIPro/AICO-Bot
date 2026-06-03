# PRD [Bug 修复级] — remote-agent-proxy 未检查 Node.js 版本导致低版本用户看到晦涩 SyntaxError

> 版本：bugfix-nodejs-version-check-v1
> 日期：2026-05-29
> 指令人：@pzy
> 归属模块：modules/remote-agent（remote-agent-proxy）
> 严重程度：High

## 问题描述

- **期望行为**：用户在 Node.js 版本低于 18 的服务器上运行 `remote-agent-proxy` 时，应收到清晰的版本不兼容提示（包含当前版本和最低要求版本），并优雅退出。
- **实际行为**：用户在 Node.js <= 12 的服务器上部署 remote-agent-proxy 时，程序在模块加载阶段崩溃，抛出晦涩的 `SyntaxError: Unexpected token '.'`：
  ```
  file:///opt/claude-deployment-client-cc10dd1b47d6/dist/index.js:42
      log.info(SCOPE.SERVER, `  Auth Tokens: ${config.authTokens?.length || 0} additional${config.authToken ? ' + 1 primary' : ''} (open access if 0)`);
                                                                 ^
  SyntaxError: Unexpected token '.'
      at Loader.moduleStrategy (internal/modules/esm/translators.js:133:18)
  ```
- **复现步骤**：
  1. 准备一台安装了 Node.js 12（或更低版本）的服务器
  2. 部署 remote-agent-proxy 并执行 `node dist/index.js`
  3. 观察到 SyntaxError 崩溃，错误信息无法帮助用户理解根因

## 根因分析

1. `packages/remote-agent-proxy/tsconfig.json` 设置 `target: "ES2022"`，TypeScript 编译时保留 `?.`（optional chaining）和 `??`（nullish coalescing）等 ES2020+ 语法，不进行降级
2. 源码中约有 ~150 处 `?.` 和 ~30 处 `??` 用法
3. `package.json` 没有 `engines` 字段声明最低 Node.js 版本要求
4. Node.js <= 12 不支持 `?.`、`??`、ESM 等语法，导致在模块加载阶段直接崩溃
5. 报错发生在模块解析阶段（`Loader.moduleStrategy`），在用户代码执行之前，因此用户看到的是 V8 引擎层面的语法错误而非业务层面的版本提示

**为什么不降级 target**：
- 源码大量使用 ES2022 特性（ESM `import/export`、top-level await 等），降级 target 可能引入其他兼容问题
- remote-agent-proxy 本身依赖 Node.js 18+ 的 API（如 `node:child_process` 的 ESM 支持）
- 正确做法是在入口处做版本拦截，而非通过降级兼容低版本

## 修复方案

### 1. 入口文件添加版本检查

在 `packages/remote-agent-proxy/src/index.ts` 最顶部（所有 import 之前）添加 Node.js 版本检查代码：

```javascript
// Node.js version check — MUST be first, MUST use only ES5 syntax
var _nodeVer = process.versions.node.split('.');
var _nodeMajor = parseInt(_nodeVer[0], 10);
if (_nodeMajor < 18) {
  console.error(
    'ERROR: This application requires Node.js >= 18.0.0.' +
    '\n  Current version: ' + process.version +
    '\n  Please upgrade Node.js and try again.'
  );
  process.exit(1);
}
```

关键约束：
- **只使用 ES5 语法**（`var`、`process.versions.node`、字符串拼接），不使用 `?.`、`??`、模板字符串、`const`/`let`、箭头函数等
- 放在所有 `import` 语句之前，确保在低版本 Node.js 上模块解析失败前先执行此检查
- 使用 `process.exit(1)` 退出而非 `throw`，确保错误码非零

### 2. package.json 添加 engines 字段

在 `packages/remote-agent-proxy/package.json` 中添加：

```json
"engines": {
  "node": ">=18.0.0"
}
```

提示：`engines` 字段本身不会阻止安装/运行，但会被 `npm` / `yarn` 等工具识别，在 `npm install` 时如果设置了 `engine-strict=true` 会阻止安装。

## 影响范围

- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无

## 涉及文件

| 文件 | 变更 |
|------|------|
| `packages/remote-agent-proxy/preflight.cjs` | **新建** — CommonJS ES5 预检入口，检查 Node.js >= 18 后动态 import ESM 入口 |
| `packages/remote-agent-proxy/package.json` | 添加 `engines` 字段，`main` 改为 `preflight.cjs` |
| `src/main/services/remote/deploy/agent-runner.ts` | 非离线启动命令改用 `preflight.cjs` |
| `src/main/services/remote/deploy/agent-deployer.ts` | 离线启动命令改用 `preflight.cjs`；`createDeployPackage` 包含 `preflight.cjs` |
| `packages/remote-agent-proxy/scripts/build-offline-bundle.mjs` | 离线包包含 `preflight.cjs` |
| `package.json`（根） | electron-builder files 添加 `preflight.cjs` |

## 验收标准

- [ ] Node.js < 18 时输出清晰错误信息（包含当前版本和最低要求版本）并以 exit code 1 退出
- [ ] 版本检查代码只用 ES5 语法，在 Node.js 12 上能正常执行（不会因自身语法问题崩溃）
- [ ] `package.json` 包含 `engines` 字段声明 `"node": ">=18.0.0"`
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 开发前必读

| 文档 | 阅读目的 |
|------|----------|
| `packages/remote-agent-proxy/src/index.ts` | 了解当前入口文件结构，确认版本检查插入位置 |
| `packages/remote-agent-proxy/package.json` | 了解当前 package.json 结构，确认 engines 插入位置 |
| `packages/remote-agent-proxy/tsconfig.json` | 确认 target 为 ES2022，理解不降级的原因 |

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-29 | 初始 Bug 修复 PRD | @pzy |
