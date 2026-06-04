/**
 * Agent Deployer - Agent code deployment, update, SDK deploy, offline deployment
 *
 * Extracted from remote-deploy.service.ts using composition pattern.
 * All functions take (service: RemoteDeployService, ...) as first parameter.
 */

import { app } from 'electron';
import * as fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { CLAUDE_AGENT_SDK_VERSION } from '../../../../shared/constants/sdk';
import type { RemoteDeployService } from './remote-deploy.service';

const DEPLOY_AGENT_PATH_FALLBACK = '/opt/claude-deployment';
const DEPLOY_AGENT_PATH_DEV = '/opt/claude-deployment-dev';
const REQUIRED_SDK_VERSION = CLAUDE_AGENT_SDK_VERSION;
const AGENT_CHECK_COMMAND =
  'npm list -g @anthropic-ai/claude-agent-sdk 2>/dev/null || echo "NOT_INSTALLED"';

// Re-export constants needed by other modules
export { REQUIRED_SDK_VERSION, AGENT_CHECK_COMMAND };

/**
 * Escape a value for use in shell environment variable
 * Handles special characters like quotes, spaces, etc.
 */
export function escapeEnvValue(value: string): string {
  // If the value contains no special characters, return as-is
  if (/^[a-zA-Z0-9_\-./:@]+$/.test(value)) {
    return value;
  }
  // Otherwise, wrap in single quotes and escape any existing single quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Get the path to the remote-agent-proxy package
 * Works in both development and production modes
 */
export function getRemoteAgentProxyPath(): string {
  // In development mode, use the project root
  // In production mode, use the app resources path
  if (app.isPackaged) {
    // Production: resources are in app.asar/packages
    // Use app.getAppPath() which returns the path to app.asar in production
    const appPath = app.getAppPath();
    return path.join(appPath, 'packages', 'remote-agent-proxy');
  } else {
    // Development: use the project root
    const projectRoot = app.getAppPath();
    return path.join(projectRoot, 'packages', 'remote-agent-proxy');
  }
}

/**
 * Get the deploy path for a server.
 * Uses per-PC path if clientId is set, falls back to dev/packaged-specific path.
 */
export function getDeployPath(server: { deployPath?: string }): string {
  if (server.deployPath) return server.deployPath;
  // Dev and packaged use separate remote paths to avoid conflicts
  return app.isPackaged ? DEPLOY_AGENT_PATH_FALLBACK : DEPLOY_AGENT_PATH_DEV;
}

/**
 * Create a tar.gz deployment package containing dist/, patches/, scripts/, and package.json.
 * Returns the path to the temporary tar.gz file.
 *
 * When running from a packaged Electron app, packageDir points inside app.asar.
 * The system `tar` command cannot traverse into asar archives, so we detect this
 * case and copy the needed files to a temporary staging directory first.
 */
export async function createDeployPackage(
  _service: RemoteDeployService,
  packageDir: string,
): Promise<string> {
  const { execSync } = require('child_process');
  const tmpDir = os.tmpdir();
  const packagePath = path.join(tmpDir, `aico-bot-deploy-${Date.now()}.tar.gz`);
  const distDir = path.join(packageDir, 'dist');

  if (!fs.existsSync(distDir)) {
    throw new Error(
      `Remote agent proxy not built. Run 'npm run build' first. (looked at: ${distDir})`,
    );
  }

  // Determine which subdirectories to include alongside package.json and dist/
  const includes: string[] = ['package.json', 'dist', 'preflight.cjs'];
  if (fs.existsSync(path.join(packageDir, 'patches'))) {
    includes.push('patches');
  }
  if (fs.existsSync(path.join(packageDir, 'scripts'))) {
    includes.push('scripts');
  }

  // Detect asar path -- system tar cannot enter app.asar directories.
  // Copy to a temp staging dir so tar can operate on real filesystem paths.
  let stagingDir: string | null = null;
  if (packageDir.includes('.asar')) {
    stagingDir = fs.mkdtempSync(path.join(tmpDir, 'aico-agent-staging-'));
    for (const name of includes) {
      const src = path.join(packageDir, name);
      const dst = path.join(stagingDir, name);
      copyRecursiveSync(src, dst);
    }
    // Use staging dir as the tar base
    packageDir = stagingDir;
  }

  // Normalize all paths to forward slashes for the tar command.
  const normalizedPackagePath = packagePath.replace(/\\/g, '/');
  const normalizedPackageDir = packageDir.replace(/\\/g, '/');
  const tarArgs = `-czf "${normalizedPackagePath}" -C "${normalizedPackageDir}" ${includes.join(' ')}`;

  // --force-local is only supported by GNU tar (Git Bash); Windows built-in tar (bsdtar) does not.
  // Try with --force-local first (for GNU tar), retry without it (for bsdtar).
  try {
    try {
      execSync(`tar --force-local ${tarArgs}`, { stdio: 'pipe' });
    } catch {
      execSync(`tar ${tarArgs}`, { stdio: 'pipe' });
    }
  } catch (err) {
    // Clean up staging dir on failure
    if (stagingDir) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
    throw new Error(`Failed to create deployment package: ${err}`);
  }

  // Clean up staging dir on success
  if (stagingDir) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
  }

  return packagePath;
}

/**
 * Recursively copy a file or directory.
 * Handles both regular files and directories (including nested ones).
 */
export function copyRecursiveSync(src: string, dst: string): void {
  const stat = fs.statSync(src);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyRecursiveSync(path.join(src, entry.name), path.join(dst, entry.name));
    }
  }
}

/**
 * Compute MD5 hash of a local file
 */
export function computeMd5(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Upload a file with post-upload MD5 verification and automatic retry.
 * Checks remote disk space before upload, then compares local/remote MD5 checksums.
 */
async function uploadWithVerify(
  manager: import('../ssh/ssh-manager').SSHManager,
  localPath: string,
  remotePath: string,
  options?: {
    maxRetries?: number;
    onAttempt?: (attempt: number, maxRetries: number) => void;
  },
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 3;
  const localSize = fs.statSync(localPath).size;
  const localMd5 = computeMd5(localPath);

  // Pre-upload: check remote disk space
  const requiredSpace = localSize + 100 * 1024 * 1024; // 100MB buffer
  try {
    const dfResult = await manager.executeCommandFull(
      `df -B1 $(dirname ${remotePath}) 2>/dev/null | tail -1 | awk '{print $4}'`,
    );
    const availableSpace = parseInt(dfResult.stdout.trim(), 10);
    if (!isNaN(availableSpace) && availableSpace < requiredSpace) {
      throw new Error(
        `远端磁盘空间不足: 需要 ${(requiredSpace / 1024 / 1024).toFixed(0)}MB, 可用 ${(availableSpace / 1024 / 1024).toFixed(0)}MB`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('远端磁盘空间不足')) throw err;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    options?.onAttempt?.(attempt, maxRetries);

    await manager.uploadFile(localPath, remotePath);

    // Post-upload: verify file size first (quick check)
    try {
      const statResult = await manager.stat(remotePath);
      if (statResult.size !== localSize) {
        console.warn(
          `[uploadWithVerify] Size mismatch (attempt ${attempt}/${maxRetries}): local=${localSize}, remote=${statResult.size}`,
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
        continue;
      }
    } catch {
      throw new Error(`上传校验失败: 无法获取远端文件状态 (${remotePath})`);
    }

    // Post-upload: verify MD5 checksum (integrity check)
    try {
      const md5Result = await manager.executeCommandFull(`md5sum ${remotePath} 2>/dev/null`);
      const remoteMd5 = md5Result.stdout.trim().split(/\s+/)[0];
      if (remoteMd5 === localMd5) {
        console.log(`[uploadWithVerify] MD5 verified: ${localMd5}`);
        return;
      }
      console.warn(
        `[uploadWithVerify] MD5 mismatch (attempt ${attempt}/${maxRetries}): local=${localMd5}, remote=${remoteMd5}`,
      );
    } catch {
      console.warn(`[uploadWithVerify] md5sum not available, falling back to size check`);
      console.log(`[uploadWithVerify] Size verified: ${localSize} bytes`);
      return;
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }

  throw new Error(
    `上传校验失败: MD5 不匹配，已重试 ${maxRetries} 次。本地: ${localMd5}`,
  );
}

/**
 * Recursively list all files in a directory, returning POSIX-style relative paths.
 * Always uses forward slashes even on Windows, since remote servers are Linux.
 * e.g. ['index.js', 'proxy-apps/index.js', 'proxy-apps/manager.js']
 */
export function readdirRecursive(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of readdirRecursive(path.join(dir, entry.name))) {
        results.push(`${entry.name}/${sub}`);
      }
    } else {
      results.push(entry.name);
    }
  }
  return results;
}

/**
 * Check if all dependencies listed in local package.json are resolvable on the remote server.
 * Returns comma-separated list of missing package names, or null if all present.
 */
export async function checkRemoteDependencies(
  _service: RemoteDeployService,
  id: string,
  manager: any,
  localPackageJsonPath: string,
): Promise<string | null> {
  const server = (_service as any).servers.get(id);
  if (!server) return null;
  const deployPath = getDeployPath(server);
  try {
    const pkg = JSON.parse(fs.readFileSync(localPackageJsonPath, 'utf-8'));
    const deps = Object.keys(pkg.dependencies || {});
    if (deps.length === 0) return null;

    // Build a shell one-liner that probes each dependency via node -e "require.resolve()"
    const checks = deps
      .map(
        (name: string) =>
          `node -e "require.resolve('${name}')" 2>/dev/null || echo "MISSING:${name}"`,
      )
      .join(' && ');

    const result = await manager.executeCommandFull(
      `cd ${deployPath} && (${checks}) 2>/dev/null`,
    );

    const missing = (result.stdout || '').match(/MISSING:(\S+)/g);
    if (missing && missing.length > 0) {
      const names = missing.map((m: string) => m.replace('MISSING:', ''));
      console.debug(`[RemoteDeployService] Missing dependencies on remote: ${names.join(', ')}`);
      return names.join(', ');
    }
    return null;
  } catch (e) {
    // If check itself fails (e.g., SSH error), be conservative and trigger npm install
    console.debug('[RemoteDeployService] Dependency check failed, will run npm install:', e);
    return 'check-error';
  }
}

/**
 * Deploy to a server (full deployment including agent code and system prompt)
 * This deploys the complete agent package including:
 * - SDK installation
 * - Agent code upload
 * - System prompt sync
 * - Auto restart agent to apply changes
 */
export async function deployToServer(service: RemoteDeployService, id: string): Promise<void> {
  // Online deploy removed — use offline deploy (deployAgentCodeOffline) instead
  const server = (service as any).servers.get(id);
  const platform = server?.detectedArch as 'x64' | 'arm64' | undefined;
  if (!platform) {
    throw new Error('无法检测服务器 CPU 架构，离线部署需要 x86_64 或 aarch64');
  }
  if (!isOfflineBundleAvailable(service, platform)) {
    throw new Error(`离线部署包不存在 (linux-${platform})。请先执行 npm run build:offline-bundle 构建。`);
  }
  await service.deployAgentCodeOffline(id, platform);
}

/**
 * Deploy agent code to the remote server
 * Uploads the pre-built remote-agent-proxy package from packages/remote-agent-proxy/dist
 */
export async function deployAgentCode(service: RemoteDeployService, id: string): Promise<void> {
  // [DEPRECATED] Online deploy removed — use deployAgentCodeOffline instead
  throw new Error('在线部署已移除，请使用离线部署');
}

/**
 * Fast update: upload all files as a single tar.gz package, skip full environment setup.
 * Falls back to offline deploy if this is the first deployment.
 */
export async function updateAgentCode(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);

  // Ensure SSH connection
  if (!manager.isConnected()) {
    service.emitDeployProgress(id, 'connect', `正在连接到 ${server.name}...`, 5);
    await service.connectServer(id);
    const connectedManager = service.getSSHManager(id);
    if (!connectedManager.isConnected()) {
      throw new Error(`Failed to establish SSH connection to ${server.name}`);
    }
  }

  // Check if this is the first deployment or a broken deployment.
  // Verify both version.json exists AND npm/node are functional -- a partial
  // previous deployment may have uploaded files but never installed Node.js.
  const deployPath = getDeployPath(server);
  const firstDeployCheck = await manager.executeCommandFull(
    `test -f ${deployPath}/version.json && export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && command -v npm >/dev/null 2>&1 && echo "DEPLOYED" || echo "NOT_DEPLOYED"`,
  );

  if (!firstDeployCheck.stdout.includes('DEPLOYED')) {
    service.emitCommandOutput(id, 'output', '首次部署或环境不完整，执行离线部署...');
    service.emitDeployProgress(id, 'prepare', '首次部署中...', 10);
    const platform = server.detectedArch as 'x64' | 'arm64' | undefined;
    if (!platform) {
      throw new Error('无法检测服务器 CPU 架构，离线部署需要 x86_64 或 aarch64');
    }
    if (!isOfflineBundleAvailable(service, platform)) {
      throw new Error(`离线部署包不存在 (linux-${platform})。请先执行 npm run build:offline-bundle 构建。`);
    }
    return deployAgentCodeOffline(service, id, platform);
  }

  // --- Incremental update path ---
  service.emitCommandOutput(id, 'command', '增量更新模式 (跳过环境初始化)');

  // Ensure remote directories exist (in case of partial/broken previous deployment)
  service.emitCommandOutput(id, 'output', '正在检查远程目录...');
  await manager.executeCommand(`mkdir -p ${deployPath}/dist`);
  await manager.executeCommand(`mkdir -p ${deployPath}/patches`);
  await manager.executeCommand(`mkdir -p ${deployPath}/config`);
  await manager.executeCommand(`mkdir -p ${deployPath}/logs`);
  await manager.executeCommand(`mkdir -p ${deployPath}/scripts`);

  // Detect npm path: SSH exec runs non-login/non-interactive shell,
  // so .bashrc/.profile are not sourced and npm may not be in PATH.
  const npmPathDetect = await manager.executeCommandFull(
    `export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && which npm 2>/dev/null || echo ""`,
  );
  const npmCmd = npmPathDetect.stdout.trim();

  if (!npmCmd) {
    // npm not found -- environment incomplete, fall back to offline deploy
    service.emitCommandOutput(id, 'output', 'npm 未找到，回退到离线部署...');
    service.emitDeployProgress(id, 'prepare', '环境不完整，执行离线部署...', 10);
    const platform = server.detectedArch as 'x64' | 'arm64' | undefined;
    if (!platform) {
      throw new Error('无法检测服务器 CPU 架构，离线部署需要 x86_64 或 aarch64');
    }
    if (!isOfflineBundleAvailable(service, platform)) {
      throw new Error(`离线部署包不存在 (linux-${platform})。请先执行 npm run build:offline-bundle 构建。`);
    }
    return deployAgentCodeOffline(service, id, platform);
  }

  const npmPathPrefix = `export PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" && `;

  // --- Package and upload all files as a single tar.gz ---
  const packageDir = getRemoteAgentProxyPath();
  const patchesDir = path.join(packageDir, 'patches');

  service.emitDeployProgress(id, 'upload', '正在打包部署文件...', 10);
  const packagePath = await createDeployPackage(service, packageDir);

  // Connection health check before upload (prevents failures after tab switch)
  await service.ensureSshConnectionHealthy(id);

  service.emitDeployProgress(id, 'upload', '正在上传部署包...', 20);
  const updatedManager = service.getSSHManager(id);
  const remotePackageName = `agent-update-${Date.now()}.tar.gz`;
  const remotePackagePath = `${deployPath}/${remotePackageName}`;
  await uploadWithVerify(updatedManager, packagePath, remotePackagePath);

  service.emitDeployProgress(id, 'upload', '正在解压部署包...', 35);
  await manager.executeCommand(
    `cd ${deployPath} && tar -xzf ${remotePackageName} && rm -f ${remotePackageName}`,
    { timeoutMs: 120_000 },
  );
  service.emitCommandOutput(id, 'success', '✓ 部署包已上传并解压');

  // Run patch-sdk.mjs to fix ripgrep permissions and apply SDK patches.
  // This must run on every deploy (not just when npm install runs),
  // because fast updates skip npm install/postinstall.
  service.emitCommandOutput(id, 'output', '正在执行 SDK 补丁脚本...');
  await manager.executeCommand(
    `cd ${deployPath} && ${npmPathPrefix}node scripts/patch-sdk.mjs 2>&1 || true`,
    { timeoutMs: 30_000 },
  );

  // Clean up local temp package
  try {
    fs.unlinkSync(packagePath);
  } catch {}

  // 2. Check if npm install is needed (compare package.json md5)
  service.emitDeployProgress(id, 'install', '正在检查依赖变更...', 40);
  const packageJsonPath = path.join(packageDir, 'package.json');
  const localPkgMd5 = computeMd5(packageJsonPath);
  const remotePkgMd5Result = await manager.executeCommandFull(
    `md5sum ${deployPath}/package.json 2>/dev/null | awk '{print $1}' || echo ""`,
  );

  if (localPkgMd5 !== remotePkgMd5Result.stdout.trim()) {
    // package.json changed --> npm install needed
    service.emitCommandOutput(id, 'output', 'package.json 已变更，执行 npm install...');
    service.emitDeployProgress(id, 'install', '正在安装依赖 (npm install)...', 45);

    // Connection health check before long-running npm install
    await service.ensureSshConnectionHealthy(id);

    const installResult = await manager.executeCommandStreaming(
      `cd ${deployPath} && ${npmPathPrefix}npm install --legacy-peer-deps 2>&1`,
      (type, data) => {
        const lines = data.split('\n').filter((line: string) => line.trim());
        for (const line of lines) {
          service.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line);
        }
      },
    );

    if (installResult.exitCode !== 0) {
      service.emitCommandOutput(
        id,
        'error',
        `npm install 失败: ${installResult.stderr || installResult.stdout}`,
      );
      throw new Error(`npm install failed: ${installResult.stderr || installResult.stdout}`);
    }
    service.emitCommandOutput(id, 'success', '✓ 依赖安装完成');
  } else {
    // package.json unchanged -- verify node_modules integrity before skipping npm install
    const depsMissing = await checkRemoteDependencies(service, id, manager, packageJsonPath);
    if (depsMissing) {
      service.emitCommandOutput(id, 'output', `检测到缺失依赖: ${depsMissing}，执行 npm install...`);
      service.emitDeployProgress(id, 'install', '正在修复依赖 (npm install)...', 45);

      const repairResult = await manager.executeCommandStreaming(
        `cd ${deployPath} && ${npmPathPrefix}npm install --legacy-peer-deps 2>&1`,
        (type, data) => {
          const lines = data.split('\n').filter((line: string) => line.trim());
          for (const line of lines) {
            service.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line);
          }
        },
      );

      if (repairResult.exitCode !== 0) {
        service.emitCommandOutput(
          id,
          'error',
          `npm install 失败: ${repairResult.stderr || repairResult.stdout}`,
        );
        throw new Error(`npm install failed: ${repairResult.stderr || repairResult.stdout}`);
      }
      service.emitCommandOutput(id, 'success', '✓ 依赖修复完成');
    } else {
      service.emitCommandOutput(id, 'output', 'package.json 未变更，依赖完整，跳过 npm install');
    }
  }

  // 3. Check if global SDK needs updating
  service.emitDeployProgress(id, 'install', '正在检查 SDK 版本...', 55);
  const localVersionInfo = service.getLocalAgentVersion();
  if (localVersionInfo?.version) {
    const remoteVersionResult = await manager.executeCommandFull(
      `${npmPathPrefix}${AGENT_CHECK_COMMAND} | grep -oP 'claude-agent-sdk@\\K[^\\s]+' || echo ""`,
    );
    const remoteSdkVersion = remoteVersionResult.stdout.trim();
    if (remoteSdkVersion && remoteSdkVersion !== REQUIRED_SDK_VERSION) {
      service.emitCommandOutput(
        id,
        'output',
        `SDK 版本变更: ${remoteSdkVersion} → ${REQUIRED_SDK_VERSION}`,
      );
      service.emitDeployProgress(id, 'install', '正在更新 SDK...', 57);
      // Connection health check before SDK install
      await service.ensureSshConnectionHealthy(id);
      await manager.executeCommandStreaming(
        `${npmPathPrefix}npm install -g @anthropic-ai/claude-agent-sdk@${REQUIRED_SDK_VERSION} 2>&1`,
        (type, data) => {
          const lines = data.split('\n').filter((line: string) => line.trim());
          for (const line of lines) {
            service.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line);
          }
        },
      );
    } else {
      service.emitCommandOutput(id, 'output', 'SDK 版本未变更，跳过全局安装');
    }
  }

  // 4. Upload local patched SDK (if changed)
  // Only upload sdk.mjs when a patch file exists -- uploading an unpatched sdk.mjs
  // from a different version would cause protocol mismatch with the remote CLI.
  service.emitDeployProgress(id, 'sdk', '正在检查 SDK 补丁...', 65);
  const projectRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const localSdkPath = path.join(
    projectRoot,
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
  );
  const remoteSdkPath = `${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk`;
  const localSdkFile = path.join(localSdkPath, 'sdk.mjs');

  const hasPatch =
    fs.existsSync(patchesDir) &&
    fs.readdirSync(patchesDir).some((f: string) => f.endsWith('.patch'));

  if (hasPatch && fs.existsSync(localSdkFile)) {
    const localSdkMd5 = computeMd5(localSdkFile);
    const remoteSdkMd5Result = await manager.executeCommandFull(
      `md5sum ${remoteSdkPath}/sdk.mjs 2>/dev/null | awk '{print $1}' || echo ""`,
    );
    if (localSdkMd5 !== remoteSdkMd5Result.stdout.trim()) {
      // Connection health check before SDK file upload
      await service.ensureSshConnectionHealthy(id);
      await manager.executeCommand(`mkdir -p ${remoteSdkPath}`);
      await manager.uploadFile(localSdkFile, `${remoteSdkPath}/sdk.mjs`);
      service.emitCommandOutput(id, 'output', 'SDK 补丁已更新');
    } else {
      service.emitCommandOutput(id, 'output', 'SDK 补丁未变更，跳过上传');
    }
  } else if (!hasPatch) {
    service.emitCommandOutput(id, 'output', '无 SDK 补丁，使用远程 npm 安装版本');
  }

  // 5. Sync system prompt
  service.emitDeployProgress(id, 'sync', '正在同步系统提示词...', 75);
  // Connection health check before sync operations
  await service.ensureSshConnectionHealthy(id);
  await service.syncSystemPrompt(id);

  // 6. Restart agent to apply changes (same logic as deployAgentCode)
  service.emitDeployProgress(id, 'restart', '检查 Agent 状态...', 90);
  // Connection health check before restart operations
  await service.ensureSshConnectionHealthy(id);
  try {
    const healthPort = (server.assignedPort || 8080) + 1;
    const checkHealthCmd = `curl --noproxy '*' -s --connect-timeout 2 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`;
    const healthCheck = await manager.executeCommandFull(checkHealthCmd);

    let hasActiveSessions = false;
    let agentRunning = false;
    let activeSessionCount = 0;

    try {
      const healthData = JSON.parse(healthCheck.stdout || '{}');
      if (healthData.status === 'ok') {
        agentRunning = true;
        activeSessionCount = healthData.activeSessions || 0;
        hasActiveSessions = activeSessionCount > 0;
      }
    } catch (e) {
      agentRunning = false;
    }

    if (hasActiveSessions) {
      service.emitCommandOutput(
        id,
        'output',
        `⚠️ 检测到 ${activeSessionCount} 个活跃会话，跳过重启以避免中断`,
      );
      service.emitCommandOutput(id, 'output', '提示：代码已更新，将在所有会话完成后手动重启生效');
    } else if (agentRunning) {
      await service.stopAgent(id);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await service.startAgent(id);
      service.emitCommandOutput(id, 'success', '✓ Agent 重启成功');
    } else {
      await service.startAgent(id);
      service.emitCommandOutput(id, 'success', '✓ Agent 已启动');
    }
  } catch (restartError) {
    service.emitCommandOutput(id, 'error', `⚠️ Agent 重启失败：${restartError}`);
    // Don't throw - the code was deployed successfully
  }

  service.emitDeployProgress(id, 'complete', '✓ 更新完成!', 100);
  service.emitCommandOutput(id, 'success', '========================================');
  service.emitCommandOutput(id, 'success', '增量更新完成!');
  service.emitCommandOutput(id, 'success', '========================================');
}

/**
 * Recursively upload a directory to remote server with incremental sync.
 * Only uploads files whose md5 differs from the remote copy.
 */
export async function uploadDirectoryRecursive(
  _service: RemoteDeployService,
  manager: any,
  localDir: string,
  remoteDir: string,
  stats?: { uploaded: number; skipped: number },
): Promise<void> {
  if (!stats) stats = { uploaded: 0, skipped: 0 };
  const entries = fs.readdirSync(localDir, { withFileTypes: true });

  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;

    if (entry.isDirectory()) {
      // Create remote directory and recurse
      await manager.executeCommand(`mkdir -p ${remotePath}`);
      await uploadDirectoryRecursive(_service, manager, localPath, remotePath, stats);
    } else if (entry.isFile()) {
      // Compare md5 with remote, only upload if changed
      const localMd5 = computeMd5(localPath);
      const remoteMd5Result = await manager.executeCommandFull(
        `md5sum ${remotePath} 2>/dev/null | awk '{print $1}' || echo ""`,
      );
      const remoteMd5 = remoteMd5Result.stdout.trim();

      if (localMd5 !== remoteMd5) {
        await manager.uploadFile(localPath, remotePath);
        stats.uploaded++;
      } else {
        stats.skipped++;
      }
    }
  }
}

/**
 * Get the path to an embedded offline deployment bundle.
 * In production: process.resourcesPath/offline-bundles/
 * In development: project root/resources/offline-bundles/
 */
export function getOfflineBundlePath(
  _service: RemoteDeployService,
  platform: 'x64' | 'arm64',
): string | null {
  const bundleDir = app.isPackaged
    ? path.join(process.resourcesPath, 'offline-bundles')
    : path.join(app.getAppPath(), 'resources', 'offline-bundles');

  // Try both .tar.xz and .tar.gz extensions
  const baseName = `aico-bot-offline-linux-${platform}`;
  for (const ext of ['.tar.gz', '.tar.xz']) {
    const bundlePath = path.join(bundleDir, `${baseName}${ext}`);
    if (fs.existsSync(bundlePath)) {
      return bundlePath;
    }
  }
  return null;
}

/**
 * Check if offline deployment bundles are available.
 */
export function isOfflineBundleAvailable(service: RemoteDeployService, platform: 'x64' | 'arm64'): boolean {
  return getOfflineBundlePath(service, platform) !== null;
}

/**
 * Deploy agent code using an embedded offline bundle.
 * No network access required on the remote server (except Claude API at runtime).
 */
export async function deployAgentCodeOffline(service: RemoteDeployService, id: string, _platform?: 'x64' | 'arm64'): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  service.emitCommandOutput(id, 'command', '========================================');
  service.emitCommandOutput(id, 'command', '离线部署 (Offline Deploy)');
  service.emitCommandOutput(id, 'command', '========================================');

  // Ensure SSH connection
  const manager = service.getSSHManager(id);
  if (!manager.isConnected()) {
    service.emitDeployProgress(id, 'connect', `正在连接到 ${server.name}...`, 5);
    await service.connectServer(id);
  }

  await service.ensureSshConnectionHealthy(id);

  // Auto-detect remote server architecture (use cached, or detect now)
  let platform = server.detectedArch;
  if (!platform) {
    service.emitDeployProgress(id, 'prepare', '正在检测远端服务器架构...', 8);
    service.emitCommandOutput(id, 'command', '$ uname -m');
    try {
      const archResult = (await manager.executeCommand('uname -m', { timeoutMs: 10_000 })).trim();
      platform = archResult === 'x86_64' ? 'x64' : archResult === 'aarch64' ? 'arm64' : undefined;
      if (!platform) {
        throw new Error(`不支持的 CPU 架构: ${archResult}，仅支持 x86_64 和 aarch64`);
      }
    } catch {
      throw new Error('无法检测远端服务器 CPU 架构（uname -m 超时），请检查 SSH 连接');
    }
    // Cache detected architecture
    await service.updateServer(id, { detectedArch: platform });
  }

  service.emitCommandOutput(id, 'command', `目标平台: linux-${platform} (自动检测)`);

  // Locate offline bundle
  const bundlePath = getOfflineBundlePath(service, platform);
  if (!bundlePath) {
    throw new Error(
      `离线部署包不存在 (linux-${platform})。请先执行 npm run build:offline-bundle 构建。`,
    );
  }

  const bundleSize = fs.statSync(bundlePath).size;
  service.emitCommandOutput(
    id,
    'output',
    `离线包: ${path.basename(bundlePath)} (${(bundleSize / 1024 / 1024).toFixed(1)} MB)`,
  );

  const deployPath = getDeployPath(server);

  try {
    // Step 2: Upload offline bundle (skip if already deployed with same version)
    service.emitDeployProgress(id, 'upload', '正在检查远端部署状态...', 20);
    const remoteVersionResult = await manager.executeCommandFull(
      `cat ${deployPath}/dist/version.json 2>/dev/null || echo ""`,
    );
    let skipUpload = false;
    let remoteTimestamp = '';
    let localTimestamp = '';
    try {
      const remoteVersion = JSON.parse(remoteVersionResult.stdout);
      remoteTimestamp = remoteVersion.buildTimestamp || '';
      const localVersionContent = fs.readFileSync(
        path.join(getRemoteAgentProxyPath(), 'dist', 'version.json'),
        'utf-8',
      );
      const localVersion = JSON.parse(localVersionContent);
      localTimestamp = localVersion.buildTimestamp || '';
      if (remoteTimestamp && remoteTimestamp === localTimestamp) {
        skipUpload = true;
        // [DIAG-1.8] Improve deployment log with version comparison context
        service.emitCommandOutput(id, 'output', `远端版本: ${remoteTimestamp}, 本地版本: ${localTimestamp} — 版本一致，跳过上传`);
        service.emitCommandOutput(id, 'output', `如需强制更新，请先执行 npm run build:offline-bundle 重新构建`);
      } else if (remoteTimestamp || localTimestamp) {
        // [DIAG-1.8] Version mismatch
        service.emitCommandOutput(id, 'output', `远端版本: ${remoteTimestamp || '(无)'}, 本地版本: ${localTimestamp || '(无)'} — 版本不一致，开始上传`);
      }
    } catch {
      // version.json missing or unparseable -- proceed with upload
      service.emitCommandOutput(id, 'output', `远端版本: (无或解析失败), 本地版本: ${localTimestamp || '(无)'} — 开始上传`);
    }

    if (!skipUpload) {
      // Create remote directories before upload
      service.emitDeployProgress(id, 'prepare', '正在创建远程目录...', 10);
      await manager.executeCommand(`mkdir -p ${deployPath}`);
      await manager.executeCommand(`mkdir -p ${deployPath}/dist`);
      await manager.executeCommand(`mkdir -p ${deployPath}/logs`);
      await manager.executeCommand(`mkdir -p ${deployPath}/data`);
      await manager.executeCommand(`mkdir -p ${deployPath}/config`);
      await manager.executeCommand(`mkdir -p ~/.agents/skills`);
      await manager.executeCommand(`mkdir -p ~/.agents/claude-config`);

      service.emitDeployProgress(id, 'upload', '正在上传离线部署包...', 20);
      service.emitCommandOutput(id, 'command', `$ SFTP upload ${path.basename(bundlePath)}`);
      const remoteBundlePath = `${deployPath}/aico-bot-offline.tar.gz`;
      await uploadWithVerify(manager, bundlePath, remoteBundlePath, {
        onAttempt: (attempt, maxRetries) => {
          if (attempt > 1) {
            service.emitCommandOutput(id, 'output', `上传校验失败，第 ${attempt}/${maxRetries} 次重试...`);
          }
        },
      });
      service.emitCommandOutput(id, 'output', `上传校验通过: ${(fs.statSync(bundlePath).size / 1024 / 1024).toFixed(1)}MB`);
      service.emitCommandOutput(id, 'success', '✓ 离线包上传完成');
    }

    // Step 3: Extract (skip if version already matches)
    if (!skipUpload) {
      service.emitDeployProgress(id, 'extract', '正在解压离线部署包...', 35);
      service.emitCommandOutput(id, 'command', '$ tar -xzf aico-bot-offline.tar.gz');
      // Detect archive format and extract accordingly
      const detectCmd = `cd ${deployPath} && file aico-bot-offline.tar.gz 2>/dev/null | grep -q XZ && echo "XZ" || echo "GZ"`;
      const archiveType = await manager.executeCommandFull(detectCmd);
      const tarFlag = archiveType.stdout.trim() === 'XZ' ? '-xJf' : '-xzf';
      const extractCmd = `cd ${deployPath} && tar ${tarFlag} aico-bot-offline.tar.gz && rm -f aico-bot-offline.tar.gz`;
      // Offline bundle can be large (~200MB+), allow up to 5 minutes
      await manager.executeCommand(extractCmd, { timeoutMs: 300_000 });

      // Fix file permissions: SFTP upload can strip execute bits
      await manager.executeCommand(`chmod +x ${deployPath}/node-v*/bin/* 2>/dev/null || true`);
      service.emitCommandOutput(id, 'success', '✓ 解压完成');
    } else {
      service.emitDeployProgress(id, 'extract', '版本一致，跳过解压', 35);
    }

    // Fix ripgrep binary permissions (always run, even when skipping upload/extract)
    // npm packages ship rg without execute bit; without this the Grep tool fails with EACCES.
    await manager.executeCommand(
      `chmod +x ${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/*/rg 2>/dev/null || true`,
    );

    // Step 4: Configure environment (bundled Node.js + SDK symlink)
    service.emitDeployProgress(id, 'env', '正在配置运行环境...', 50);

    // Find bundled Node.js binary path
    const findNodeResult = await manager.executeCommandFull(
      `ls -d ${deployPath}/node-v*/bin/node 2>/dev/null || echo "NOT_FOUND"`,
    );
    const bundledNodePath = findNodeResult.stdout.trim();

    if (!bundledNodePath || bundledNodePath === 'NOT_FOUND') {
      throw new Error('离线包中未找到 Node.js 二进制文件');
    }

    // Verify bundled Node.js works
    const nodeVersionResult = await manager.executeCommandFull(`${bundledNodePath} --version`);
    service.emitCommandOutput(id, 'output', `Bundled Node.js: ${nodeVersionResult.stdout.trim()}`);

    // Install SDK into npm global node_modules so `npm list -g` can find it
    // Only copy claude-agent-sdk, preserve existing claude-code CLI
    service.emitCommandOutput(id, 'output', '正在安装 SDK 到全局目录...');
    // First detect the actual npm global prefix
    const npmRootResult = await manager.executeCommandFull(
      `export PATH="/usr/local/bin:/usr/local/node-v*/bin:/usr/bin:/bin:$PATH" && npm root -g 2>/dev/null`,
    );
    const globalNpmRoot =
      (npmRootResult.stdout || '').trim().split('\n').pop()?.trim() ||
      '/usr/local/lib/node_modules';
    service.emitCommandOutput(id, 'output', `npm global root: ${globalNpmRoot}`);

    await manager.executeCommand(
      `mkdir -p "${globalNpmRoot}/@anthropic-ai" && ` +
        `rm -rf "${globalNpmRoot}/@anthropic-ai/claude-agent-sdk" && ` +
        `cp -r "${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk" "${globalNpmRoot}/@anthropic-ai/claude-agent-sdk"`,
    );

    // Verify the copy succeeded
    const verifyResult = await manager.executeCommandFull(
      `test -f "${globalNpmRoot}/@anthropic-ai/claude-agent-sdk/package.json" && echo "OK" || echo "FAIL"`,
    );
    if (verifyResult.stdout.trim() !== 'OK') {
      service.emitCommandOutput(
        id,
        'error',
        '⚠ SDK 复制到全局目录失败，但离线部署的 node_modules 中仍可用',
      );
    } else {
      service.emitCommandOutput(id, 'success', '✓ SDK 已安装到全局目录');
    }
    service.emitCommandOutput(id, 'success', '✓ 环境配置完成');

    // Step 5: Generate .env config + sync system prompt
    service.emitDeployProgress(id, 'config', '正在生成配置...', 60);
    await service.syncSystemPrompt(id);

    // Step 6: Stop existing agent if running
    try {
      await service.stopAgent(id);
    } catch {
      // Ignore if not running
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 7: Start agent using bundled Node.js
    service.emitDeployProgress(id, 'start', '正在启动 Agent...', 75);
    await startAgentOffline(service, id, deployPath);

    // Verify proxy health so UI immediately reflects the running status
    await (service as any).verifyProxyHealth(id);

    service.emitDeployProgress(id, 'complete', '✓ 离线部署完成!', 100);
    service.emitCommandOutput(id, 'success', '========================================');
    service.emitCommandOutput(id, 'success', '离线部署成功完成!');
    service.emitCommandOutput(id, 'success', '========================================');

    // Mark SDK as installed -- offline bundle includes the SDK,
    // and npm list -g may not detect it (installed via cp, not npm install)
    await service.updateServer(id, {
      sdkInstalled: true,
      sdkVersion: REQUIRED_SDK_VERSION,
      sdkVersionMismatch: false,
    });
  } catch (error) {
    service.emitDeployProgress(id, 'error', `离线部署失败: ${error}`, 0);
    service.emitCommandOutput(id, 'error', `✗ 离线部署失败: ${error}`);

    // No online fallback — rethrow the error
    throw error;
  }
}

/**
 * Update agent code using offline bundle (incremental -- only dist/).
 * Falls back to full offline deploy if remote has no existing deployment.
 */
export async function updateAgentCodeOffline(service: RemoteDeployService, id: string, platform?: 'x64' | 'arm64'): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);

  // Ensure SSH connection
  if (!manager.isConnected()) {
    await service.connectServer(id);
  }

  await service.ensureSshConnectionHealthy(id);

  const deployPath = getDeployPath(server);

  // Check if remote already has an offline deployment
  const checkResult = await manager.executeCommandFull(
    `test -f ${deployPath}/deploy-env.sh && echo "OFFLINE_DEPLOYED" || echo "NOT_DEPLOYED"`,
  );

  if (!checkResult.stdout.includes('OFFLINE_DEPLOYED')) {
    service.emitCommandOutput(id, 'output', '远端无离线部署，执行完整离线部署...');
    return deployAgentCodeOffline(service, id, platform);
  }

  // Incremental update: only upload dist/
  service.emitCommandOutput(id, 'command', '离线增量更新 (仅 dist/)');

  const packageDir = getRemoteAgentProxyPath();
  const localDistDir = path.join(packageDir, 'dist');

  if (!fs.existsSync(localDistDir)) {
    throw new Error(`Local dist directory not found: ${localDistDir}. Run npm run build first.`);
  }

  // Compare version
  const remoteVersionResult = await manager.executeCommandFull(
    `cat ${deployPath}/dist/version.json 2>/dev/null || echo ""`,
  );
  let remoteTimestamp = '';
  try {
    const remoteVersion = JSON.parse(remoteVersionResult.stdout);
    remoteTimestamp = remoteVersion.buildTimestamp || '';
  } catch {
    // Ignore parse errors
  }

  let localTimestamp = '';
  try {
    const localVersion = JSON.parse(
      fs.readFileSync(path.join(localDistDir, 'version.json'), 'utf-8'),
    );
    localTimestamp = localVersion.buildTimestamp || '';
  } catch {
    // Ignore parse errors
  }

  if (remoteTimestamp && remoteTimestamp === localTimestamp) {
    // [DIAG-1.8] Improve update log with version comparison context
    service.emitCommandOutput(id, 'output', `远端版本: ${remoteTimestamp}, 本地版本: ${localTimestamp} — 版本一致，无需更新`);
    service.emitCommandOutput(id, 'output', `如需强制更新，请先执行 npm run build:offline-bundle 重新构建`);
    return;
  } else if (remoteTimestamp || localTimestamp) {
    // [DIAG-1.8] Version mismatch in update
    service.emitCommandOutput(id, 'output', `远端版本: ${remoteTimestamp || '(无)'}, 本地版本: ${localTimestamp || '(无)'} — 版本不一致，开始增量更新`);
  }

  // Stop agent before updating
  service.emitDeployProgress(id, 'update', '正在停止 Agent...', 10);
  try {
    await service.stopAgent(id);
  } catch {
    // Ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Upload dist/ with incremental sync
  service.emitDeployProgress(id, 'upload', '正在上传 dist/ 更新...', 30);

  const uploadStats = { uploaded: 0, skipped: 0 };
  const distEntries = fs.readdirSync(localDistDir, { withFileTypes: true });
  for (const entry of distEntries) {
    const localPath = path.join(localDistDir, entry.name);
    const remotePath = `${deployPath}/dist/${entry.name}`;

    if (entry.isDirectory()) {
      await manager.executeCommand(`mkdir -p ${remotePath}`);
      await uploadDirectoryRecursive(service, manager, localPath, remotePath, uploadStats);
    } else if (entry.isFile()) {
      const localMd5 = computeMd5(localPath);
      const remoteMd5Result = await manager.executeCommandFull(
        `md5sum ${remotePath} 2>/dev/null | awk '{print $1}' || echo ""`,
      );
      const remoteMd5 = remoteMd5Result.stdout.trim();

      if (localMd5 !== remoteMd5) {
        await manager.uploadFile(localPath, remotePath);
        uploadStats.uploaded++;
      } else {
        uploadStats.skipped++;
      }
    }
  }

  service.emitCommandOutput(
    id,
    'output',
    `上传完成: ${uploadStats.uploaded} 个文件更新, ${uploadStats.skipped} 个文件跳过`,
  );

  // Sync system prompt
  service.emitDeployProgress(id, 'sync', '正在同步系统提示词...', 70);
  await service.syncSystemPrompt(id);

  // Restart agent using bundled Node.js
  service.emitDeployProgress(id, 'start', '正在重启 Agent...', 85);
  await startAgentOffline(service, id, deployPath);

  // Verify proxy health so UI immediately reflects the running status
  await (service as any).verifyProxyHealth(id);

  service.emitDeployProgress(id, 'complete', '✓ 离线增量更新完成!', 100);
  service.emitCommandOutput(id, 'success', '离线增量更新成功!');
}

/**
 * Start agent using bundled Node.js from offline deployment.
 */
async function startAgentOffline(service: RemoteDeployService, id: string, deployPath: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  const port = server.assignedPort;
  if (!port) {
    throw new Error('No port assigned');
  }

  // Find bundled Node.js
  const findNodeResult = await manager.executeCommandFull(
    `ls -d ${deployPath}/node-v*/bin/node 2>/dev/null || echo "NOT_FOUND"`,
  );
  const bundledNodePath = findNodeResult.stdout.trim();
  if (!bundledNodePath || bundledNodePath === 'NOT_FOUND') {
    throw new Error('Bundled Node.js not found in offline deployment');
  }

  const bundledNodeDir = path.dirname(path.dirname(bundledNodePath));

  const envVars = [
    `REMOTE_AGENT_PORT=${port}`,
    `REMOTE_AGENT_AUTH_TOKEN=${escapeEnvValue(server.authToken)}`,
    server.workDir ? `REMOTE_AGENT_WORK_DIR=${escapeEnvValue(server.workDir)}` : null,
    'IS_SANDBOX=1',
    `DEPLOY_DIR=${deployPath}`,
    `PATH="${bundledNodeDir}/bin:${deployPath}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"`,
  ]
    .filter(Boolean)
    .join(' ');

  const startCommand = `nohup env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY ${envVars} ${bundledNodePath} ${deployPath}/preflight.cjs > ${deployPath}/logs/output.log 2>&1 &`;
  await manager.executeCommand(startCommand);

  // Wait for startup
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Verify port listening
  const verifyResult = await manager.executeCommandFull(
    `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${port}" || echo "NOT_RUNNING"`,
  );

  if (verifyResult.stdout.includes('NOT_RUNNING')) {
    let logOutput = '';
    try {
      const logResult = await manager.executeCommandFull(
        `tail -30 ${deployPath}/logs/output.log 2>&1 || echo ""`,
      );
      logOutput = logResult.stdout || '';
    } catch {
      // Ignore
    }
    throw new Error(`Failed to start agent. Logs: ${logOutput.slice(0, 500)}`);
  }

  service.emitCommandOutput(id, 'success', '✓ Agent 已启动 (使用 bundled Node.js)');
}
