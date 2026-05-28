/**
 * Agent Runner - Agent start/stop/restart, system prompt sync, remote command execution, log retrieval
 *
 * Extracted from remote-deploy.service.ts using composition pattern.
 * All functions take (service: RemoteDeployService, ...) as first parameter.
 */

import type { SSHManager } from '../ssh/ssh-manager';
import { SYSTEM_PROMPT_TEMPLATE } from '../../agent/system-prompt';
import { acquireConnection, releaseConnection, removePooledConnection } from '../ws/remote-ws-client';
import { getDeployPath, REQUIRED_SDK_VERSION, AGENT_CHECK_COMMAND } from './agent-deployer';
import type { RemoteDeployService } from './remote-deploy.service';
import { getConfig } from '../../config.service';
import { decryptString } from '../../auth/secure-storage.service';

/**
 * Register this instance's auth token with a running remote proxy.
 * Called when the proxy is already running (started by another instance, e.g. dev + packaged).
 */
export async function registerTokenOnRemote(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  const port = server.assignedPort;
  if (!port) {
    console.debug('[RemoteDeployService] No port assigned, cannot register token');
    return;
  }

  const healthPort = port + 1;
  const token = server.authToken;
  if (!token) {
    console.debug('[RemoteDeployService] No auth token, skipping registration');
    return;
  }

  try {
    // Register token via health port HTTP endpoint
    const tokenB64 = Buffer.from(JSON.stringify({ token })).toString('base64');
    const cmd = `echo '${tokenB64}' | base64 -d | curl --noproxy '*' -s -X POST -H "Content-Type: application/json" -d @- http://localhost:${healthPort}/tokens`;
    const result = await manager.executeCommandFull(cmd);

    try {
      const response = JSON.parse(result.stdout || '{}');
      if (response.success) {
        console.debug(
          `[RemoteDeployService] Token registered on remote proxy (total tokens: ${response.totalTokens}, new: ${response.added})`,
        );
      } else {
        console.debug(
          '[RemoteDeployService] Token registration returned failure:',
          response.error,
        );
      }
    } catch {
      console.debug(
        '[RemoteDeployService] Could not parse token registration response, proxy may be running old version',
      );
    }
  } catch (error) {
    console.error('[RemoteDeployService] Token registration error:', error);
  }

  // Persist token to tokens.json for survival across proxy restarts
  const deployPath = getDeployPath(server);
  const tokenB64 = Buffer.from(token).toString('base64');
  const persistCmd = `node -e "const fs=require('fs');const p='${deployPath}/tokens.json';let t=[];try{t=JSON.parse(fs.readFileSync(p,'utf8'));}catch{}const tk=Buffer.from('${tokenB64}','base64').toString();if(!t.includes(tk)){t.push(tk);fs.writeFileSync(p,JSON.stringify(t,null,2));}"`;
  await manager.executeCommand(persistCmd).catch((e: Error) => {
    console.debug('[RemoteDeployService] Failed to persist token to tokens.json:', e);
  });
}

/**
 * Start the agent on the remote server
 */
export async function startAgent(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  const deployPath = getDeployPath(server);
  const port = server.assignedPort;

  // Ensure logs directory exists
  await manager.executeCommand(`mkdir -p ${deployPath}/logs`);

  // Read and display build info before starting
  try {
    const versionJsonResult = await manager.executeCommandFull(
      `cat ${deployPath}/dist/version.json 2>/dev/null || echo ""`,
    );
    if (versionJsonResult.stdout.trim()) {
      const buildInfo = JSON.parse(versionJsonResult.stdout);
      const buildInfoMsg = [
        '========================================',
        'Remote Agent Build Info:',
        `  Version: ${buildInfo.version || 'unknown'}`,
        `  Build Time: ${buildInfo.buildTime || buildInfo.buildTimestamp || 'unknown'}`,
        `  Node: ${buildInfo.nodeVersion || 'unknown'}`,
        `  Platform: ${buildInfo.platform || 'unknown'} (${buildInfo.arch || 'unknown'})`,
        '========================================',
      ].join('\n');
      console.debug('[RemoteDeployService] Remote agent build info:');
      console.debug(buildInfoMsg);
      service.emitCommandOutput(id, 'output', buildInfoMsg);
    }
  } catch (e) {
    console.debug('[RemoteDeployService] Could not read remote build info:', e);
  }

  // Check if proxy is healthy via health endpoint (authoritative)
  const healthPort = (port || 8080) + 1;
  let proxyHealthy = false;
  try {
    const healthResult = await manager.executeCommandFull(
      `curl --noproxy '*' -s --connect-timeout 3 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`,
    );
    const healthData = JSON.parse(healthResult.stdout || '{}');
    proxyHealthy = healthData.status === 'ok';
  } catch {
    // proxyHealthy remains false
  }

  if (proxyHealthy) {
    console.debug(
      '[RemoteDeployService] Agent already running and healthy, skipping start (proxy supports multiple connections)',
    );
    await registerTokenOnRemote(service, id);
    return;
  }

  // Proxy not healthy -- check if a stale process exists and clean it up
  const checkResult = await manager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" || echo "not running"`,
  );

  if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
    // Process exists -- verify it's actually healthy via health endpoint
    const healthPortLocal = port + 1;
    const healthCheck = await manager.executeCommandFull(
      `curl --noproxy '*' -s --connect-timeout 2 http://localhost:${healthPortLocal}/health 2>/dev/null || echo '{}'`,
    );
    try {
      const healthData = JSON.parse(healthCheck.stdout || '{}');
      if (healthData.status === 'ok') {
        console.debug('[RemoteDeployService] Agent already running and healthy, skipping start');
        return;
      }
    } catch {
      // Health check failed -- process is zombie, kill and restart
    }
    console.debug(
      '[RemoteDeployService] Agent process exists but unhealthy, killing and restarting...',
    );
    await service.stopAgent(id);
  }

  // Start the agent server with environment variables
  const escapeEnvValue = (value: string | undefined): string => {
    if (!value) return "''";
    return `'${value.replace(/'/g, "'\\''")}'`;
  };

  const envVars = [
    `REMOTE_AGENT_PORT=${port}`,
    `REMOTE_AGENT_AUTH_TOKEN=${escapeEnvValue(server.authToken)}`,
    server.workDir ? `REMOTE_AGENT_WORK_DIR=${escapeEnvValue(server.workDir)}` : null,
    `IS_SANDBOX=1`,
    `DEPLOY_DIR=${deployPath}`,
  ]
    .filter(Boolean)
    .join(' ');

  const indexPath = `${deployPath}/dist/index.js`;

  console.debug(
    `[RemoteDeployService] Starting agent with env: PORT=${port}, WORK_DIR=${server.workDir || '(not set, will use per-session workDir)'}, DEPLOY_DIR=${deployPath}`,
  );

  const startCommand = `nohup env PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" ${envVars} node ${indexPath} > ${deployPath}/logs/output.log 2>&1 &`;
  await manager.executeCommand(startCommand);

  // Wait a moment for the process to start
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Check if it's running by checking the port (try both ss and netstat)
  const verifyResult = await manager.executeCommandFull(
    `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${port}" || echo "NOT_RUNNING"`,
  );

  if (verifyResult.stdout.includes('NOT_RUNNING')) {
    // Check the logs for error
    let logOutput = '';
    try {
      const logResult = await manager.executeCommandFull(
        `tail -50 ${deployPath}/logs/output.log 2>&1 || echo "No log file"`,
      );
      logOutput = logResult.stdout || logResult.stderr || 'No logs available';
      console.error('[RemoteDeployService] Agent startup failed. Logs:', logOutput);
      service.emitCommandOutput(id, 'error', `Agent startup logs:\n${logOutput}`);
    } catch (e) {
      console.error('[RemoteDeployService] Failed to read logs:', e);
    }

    // Also check if node process is running at all
    const processCheck = await manager.executeCommandFull(
      `ps aux | grep -E "node.*${deployPath}" | grep -v grep || echo "NO_PROCESS"`,
    );
    console.debug('[RemoteDeployService] Process check:', processCheck.stdout);

    // Self-repair: if logs indicate missing dependencies, run npm install and retry once
    const missingDepPattern = /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/;
    if (missingDepPattern.test(logOutput)) {
      console.debug(
        '[RemoteDeployService] Startup failed due to missing dependencies, attempting self-repair...',
      );
      service.emitCommandOutput(id, 'output', '检测到依赖缺失，自动修复中...');

      // Stop any leftover process
      await manager.executeCommand(`pkill -f "node.*${deployPath}" || true`);

      // Run npm install
      service.emitCommandOutput(id, 'output', '执行 npm install...');
      const repairResult = await manager.executeCommandStreaming(
        `cd ${deployPath} && export PATH="/usr/local/bin:$PATH" && npm install --legacy-peer-deps 2>&1`,
        (type, data) => {
          const lines = data.split('\n').filter((line: string) => line.trim());
          for (const line of lines) {
            service.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line);
          }
        },
      );

      if (repairResult.exitCode !== 0) {
        throw new Error(
          `Failed to start agent - dependency repair failed. Logs: ${logOutput.slice(0, 500)}`,
        );
      }

      service.emitCommandOutput(id, 'success', '✓ 依赖修复完成，重新启动 agent...');

      // Retry start
      await manager.executeCommand(startCommand);
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const retryResult = await manager.executeCommandFull(
        `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${port}" || echo "NOT_RUNNING"`,
      );

      if (retryResult.stdout.includes('NOT_RUNNING')) {
        let retryLog = '';
        try {
          const retryLogResult = await manager.executeCommandFull(
            `tail -30 ${deployPath}/logs/output.log 2>&1 || echo ""`,
          );
          retryLog = retryLogResult.stdout || '';
        } catch {}

        throw new Error(
          `Failed to start agent after dependency repair. Logs: ${retryLog.slice(0, 500)}`,
        );
      }

      console.debug(
        `[RemoteDeployService] Agent started after self-repair on: ${server.name}, port ${port}`,
      );
      return;
    }

    throw new Error(
      `Failed to start agent process - port ${port} not listening. Logs: ${logOutput.slice(0, 500)}`,
    );
  }

  console.debug(`[RemoteDeployService] Agent started on: ${server.name}, port ${port}`);
}

/**
 * Stop the agent on the remote server
 */
export async function stopAgent(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  // Disconnect pooled WebSocket connections BEFORE stopping the agent.
  // This prevents "socket hang up" errors from propagating when the
  // remote agent process is killed while connections are still active.
  removePooledConnection(id);

  const manager = service.getSSHManager(id);

  // Ensure SSH connection is established before executing command
  if (!manager.isConnected()) {
    await service.connectServer(id);
  }

  // Kill any node process running from the deployment directory
  const deployPath = getDeployPath(server);
  await manager.executeCommand(`pkill -f "node.*${deployPath}" || true`);

  console.debug(`[RemoteDeployService] Agent stopped on: ${server.name}`);
}

/**
 * Restart agent with new configuration (e.g., updated API key)
 * This only restarts the agent process, doesn't redeploy code
 */
export async function restartAgentWithNewConfig(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  console.debug(`[RemoteDeployService] Restarting agent with new config for: ${server.name}`);

  // Check if agent is currently running
  const manager = service.getSSHManager(id);
  const deployPath = getDeployPath(server);
  const checkResult = await manager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" || echo "not running"`,
  );

  if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
    // Agent is running, restart it with new config
    console.debug(`[RemoteDeployService] Agent is running, restarting with new config...`);
    await service.stopAgent(id);
    await service.startAgent(id);
    console.debug(`[RemoteDeployService] Agent restarted with new config`);
  } else {
    console.debug(`[RemoteDeployService] Agent not running, no restart needed`);
  }
}

/**
 * Restart remote agent proxy if it is currently running.
 * Used after skill uninstall to ensure the proxy reloads its skill list.
 */
export async function restartAgentIfRunning(
  service: RemoteDeployService,
  id: string,
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  const manager = service.getSSHManager(id);
  const deployPath = getDeployPath(server);
  const checkResult = await manager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" || echo "not running"`,
  );

  if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] Restarting agent proxy to reload skills...\n`,
    });
    await service.stopAgent(id);
    await service.startAgent(id);
    onOutput?.({ type: 'stdout', content: `[${server.name}] Agent proxy restarted.\n` });
  } else {
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] Agent proxy not running, skip restart.\n`,
    });
  }
}

/**
 * This uploads the template with placeholders intact.
 * The remote server will replace placeholders at runtime with its own values.
 */
export async function syncSystemPrompt(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);

  try {
    // Create config directory if not exists
    const deployPath = getDeployPath(server);
    await manager.executeCommand(`mkdir -p ${deployPath}/config`);

    // Write system prompt template to file
    // The template uses ${VAR} placeholders that will be replaced at runtime by the remote server
    const remotePath = `${deployPath}/config/system-prompt.txt`;

    // Use base64 encoding to safely transfer the prompt template
    const base64Content = Buffer.from(SYSTEM_PROMPT_TEMPLATE).toString('base64');
    const uploadCommand = `echo "${base64Content}" | base64 -d > ${remotePath}`;

    await manager.executeCommand(uploadCommand);

    console.debug(`[RemoteDeployService] System prompt template synced to ${remotePath}`);
  } catch (error) {
    console.error('[RemoteDeployService] Failed to sync system prompt:', error);
    throw error;
  }
}

/**
 * Get agent server logs
 */
export async function getAgentLogs(service: RemoteDeployService, id: string, lines: number = 100): Promise<string> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  try {
    const deployPath = getDeployPath(server);
    const logPath = `${deployPath}/logs/output.log`;
    const result = await manager.executeCommandFull(`tail -${lines} ${logPath}`);
    return result.stdout;
  } catch (error) {
    console.error('[RemoteDeployService] Failed to get agent logs:', error);
    throw error;
  }
}

/**
 * Get the local agent package version and build info
 */
export function getLocalAgentVersion(_service: RemoteDeployService): { version?: string; buildTime?: string; buildTimestamp?: string } | null {
  try {
    const { getRemoteAgentProxyPath } = require('./agent-deployer');
    const packageDir = getRemoteAgentProxyPath();
    const distDir = require('path').join(packageDir, 'dist');

    // First try to read version.json (generated by build script)
    const versionJsonPath = require('path').join(distDir, 'version.json');
    const fs = require('fs');
    if (fs.existsSync(versionJsonPath)) {
      const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
      return {
        version: versionJson.version,
        buildTime: versionJson.buildTime,
        buildTimestamp: versionJson.buildTimestamp,
      };
    }

    // Fallback to reading package.json
    const packageJsonPath = require('path').join(packageDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      return {
        version: packageJson.version,
        buildTime: packageJson.buildTime,
        buildTimestamp: packageJson.buildTimestamp,
      };
    }
    return null;
  } catch (error) {
    console.error('[RemoteDeployService] Failed to read local agent version:', error);
    return null;
  }
}

/**
 * Check if agent server is running
 */
export async function isAgentRunning(service: RemoteDeployService, id: string): Promise<boolean> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  try {
    // Check if the WebSocket port is listening
    const port = server.assignedPort;
    const result = await manager.executeCommandFull(
      `ss -tln | grep ":${port}" || echo "NOT_RUNNING"`,
    );
    return !result.stdout.includes('NOT_RUNNING');
  } catch {
    return false;
  }
}

/**
 * Execute a command on the remote server
 */
export async function executeCommand(service: RemoteDeployService, id: string, command: string): Promise<string> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  if (server.status !== 'connected') {
    await service.connectServer(id);
  }

  const manager = service.getSSHManager(id);
  return manager.executeCommand(command);
}

// ===== Remote file operations =====

/**
 * List remote files via `ls -la`, parsed into structured FileInfo objects
 */
export async function listRemoteFiles(
  service: RemoteDeployService,
  id: string,
  directory?: string,
): Promise<
  Array<{
    name: string;
    isDirectory: boolean;
    size: number;
    modifiedTime: Date;
  }>
> {
  const dir = directory || '/opt/remote-agent-proxy';
  const output = await service.executeCommand(id, `ls -la "${dir}"`);
  const lines = output.trim().split('\n').slice(1); // Skip total line
  return lines
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const name = parts[parts.length - 1];
      const isDir = line.startsWith('d');
      return {
        name,
        isDirectory: isDir,
        size: parseInt(parts[4] || '0', 10),
        modifiedTime: new Date(),
      };
    })
    .filter((f) => f.name !== '.' && f.name !== '..');
}

/**
 * Read a remote file via SSH
 */
export async function readRemoteFile(service: RemoteDeployService, id: string, filePath: string): Promise<string> {
  return service.executeCommand(id, `cat "${filePath}"`);
}

/**
 * Write content to a remote file via SSH (single-quote escaped)
 */
export async function writeRemoteFile(service: RemoteDeployService, id: string, filePath: string, content: string): Promise<void> {
  const escapedContent = content.replace(/'/g, "'\\''");
  await service.executeCommand(id, `echo '${escapedContent}' > "${filePath}"`);
}

/**
 * Delete a remote file/directory via SSH
 */
export async function deleteRemoteFile(service: RemoteDeployService, id: string, filePath: string): Promise<void> {
  await service.executeCommand(id, `rm -rf "${filePath}"`);
}

// ===== Agent update orchestration =====

/**
 * Full agent update: stop --> deploy code --> verify --> return version info
 *
 * This orchestrates the multi-step update that was previously in the IPC handler.
 */
export async function updateAgent(service: RemoteDeployService, id: string): Promise<{
  message: string;
  remoteVersion: string;
  remoteBuildTime?: string;
  localVersion: string;
  localBuildTime?: string;
}> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);
  console.debug(`[RemoteDeploy] Updating agent for ${id}...`);

  // Check remote environment: files, version freshness, and SDK independently
  const deployCheck = await service.checkDeployFilesIntegrity(id);
  const sdkOk = await (service as any).checkRemoteSdkVersion(id);
  const needsCodeDeploy = !deployCheck.filesOk || deployCheck.needsUpdate;

  console.debug(
    `[RemoteDeploy] Detection for ${server.name}: files=${deployCheck.filesOk}, needsUpdate=${deployCheck.needsUpdate}, sdk=${sdkOk}`,
  );

  // Stop agent first (regardless of what needs updating)
  await service.stopAgent(id);

  // Deploy only what's needed (offline only)
  if (needsCodeDeploy || !sdkOk) {
    const reasons: string[] = [];
    if (!deployCheck.filesOk) reasons.push('files missing');
    if (deployCheck.needsUpdate && deployCheck.filesOk) reasons.push('version outdated');
    if (!sdkOk) reasons.push('SDK mismatch');

    service.emitDeployProgress(id, 'update', `Deploying (${reasons.join(', ')})...`);

    // Offline deploy handles both code and SDK — no need for separate SDK install
    if (needsCodeDeploy || !sdkOk) {
      const platform = server.detectedArch as 'x64' | 'arm64' | undefined;
      if (!platform) {
        throw new Error('无法检测服务器 CPU 架构，离线部署需要 x86_64 或 aarch64');
      }
      if (!service.isOfflineBundleAvailable(platform)) {
        throw new Error(`离线部署包不存在 (linux-${platform})。请先执行 npm run build:offline-bundle 构建。`);
      }
      console.debug(`[RemoteDeploy] Deploying via offline bundle (${reasons.join(', ')})...`);
      await service.deployAgentCodeOffline(id, platform);
    }
  } else {
    console.debug(`[RemoteDeploy] Files and SDK OK for ${server.name}, restarting agent only`);
    service.emitDeployProgress(id, 'update', 'Files and SDK verified, restarting agent...');
  }

  // Start proxy (or let deployAgentCode's internal start handle it)
  // deployAgentCode internally calls startAgent, so only call if we didn't deploy code
  if (!needsCodeDeploy) {
    await service.startAgent(id);
  }

  // Immediately verify proxy health
  await (service as any).verifyProxyHealth(id);

  const localVersionInfo = service.getLocalAgentVersion();
  const result = {
    message:
      needsCodeDeploy || !sdkOk
        ? 'Agent updated and restarted successfully'
        : 'Agent restarted (files and SDK already up to date)',
    remoteVersion: REQUIRED_SDK_VERSION,
    localVersion: localVersionInfo?.version || 'unknown',
    localBuildTime: localVersionInfo?.buildTime,
  };

  console.debug(`[RemoteDeploy] Agent update complete for ${id}`, result);
  service.completeUpdate(id, result);
  return result;
}

/**
 * Verify proxy health immediately after starting agent.
 * Updates proxyRunning on the server config so the UI reflects the real state
 * without waiting for the background health monitor cycle.
 */
export async function verifyProxyHealth(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server || !server.assignedPort) return;

  const manager = (service as any).sshManagers.get(id);
  if (!manager?.isConnected()) return;

  // Wait briefly for proxy to initialize
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const healthPort = server.assignedPort + 1;
  const healthCmd = `curl --noproxy '*' -s --connect-timeout 3 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`;
  try {
    const healthResult = await manager.executeCommandFull(healthCmd);
    const healthData = JSON.parse(healthResult.stdout || '{}');
    const isOk = healthData.status === 'ok';
    await service.updateServer(id, { proxyRunning: isOk });
    console.debug(`[RemoteDeploy] Immediate health check for ${server.name}: proxyRunning=${isOk}`);
  } catch {
    await service.updateServer(id, { proxyRunning: false });
    console.debug(`[RemoteDeploy] Immediate health check failed for ${server.name}`);
  }
}

/**
 * Check if the remote SDK version matches the required version.
 */
export async function checkRemoteSdkVersion(service: RemoteDeployService, id: string): Promise<boolean> {
  const server = (service as any).servers.get(id);
  if (!server) return false;

  const manager = (service as any).sshManagers.get(id);
  if (!manager?.isConnected()) return false;

  try {
    const result = await manager.executeCommandFull(AGENT_CHECK_COMMAND);
    const stdout = result.stdout.trim();
    const installed =
      stdout.includes('@anthropic-ai/claude-agent-sdk') && !stdout.includes('NOT_INSTALLED');
    if (!installed) return false;

    const versionMatch = stdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/);
    const version = versionMatch ? versionMatch[1] : '';
    return version === REQUIRED_SDK_VERSION;
  } catch {
    return false;
  }
}

/**
 * Get the SSH manager for a server (for streaming execution)
 */
export function getSSHManagerForServer(service: RemoteDeployService, id: string): SSHManager | undefined {
  const server = (service as any).servers.get(id);
  if (!server) {
    return undefined;
  }
  if (server.status !== 'connected') {
    return undefined;
  }
  return service.getSSHManager(id);
}

/**
 * Send a message to the agent via SSH (for operations not yet supported by WebSocket)
 */
export async function sendAgentMessage(service: RemoteDeployService, id: string, message: any): Promise<any> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  // For now, this is a placeholder
  // In the full implementation, this would use WebSocket client
  console.debug(`[RemoteDeployService] Sending message to agent:`, message.type);

  return {
    type: 'response',
    success: true,
  };
}

/**
 * Send a chat message to the remote agent via WebSocket
 * Returns response with tokenUsage for display in chat UI
 */
export async function sendAgentChat(
  service: RemoteDeployService,
  id: string,
  params: { sessionId?: string; content: string; attachments?: any[] },
): Promise<{
  response: string;
  sessionId?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCostUsd: number;
    contextWindow: number;
  };
}> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const effectiveSessionId = params.sessionId || `session-${Date.now()}`;
  const callerId = `remote-agent:chat:${effectiveSessionId}`;
  const wsClient = await getOrCreateWsClient(service, id, server, callerId);
  const attachmentLines =
    params.attachments
      ?.filter((attachment: any) => attachment?.type === 'file' && attachment?.path)
      .map((attachment: any) => `- ${attachment.name || attachment.path}: ${attachment.path}`) || [];
  const userContent =
    attachmentLines.length > 0
      ? `${params.content}\n\nAttached remote files:\n${attachmentLines.join('\n')}`
      : params.content;

  try {
    // Send chat message with streaming
    const result = await wsClient.sendChatWithStream(
      effectiveSessionId,
      [{ role: 'user', content: userContent }],
    );

    return {
      response: result.content,
      sessionId: effectiveSessionId,
      tokenUsage: result.tokenUsage
        ? {
            inputTokens: result.tokenUsage.inputTokens || 0,
            outputTokens: result.tokenUsage.outputTokens || 0,
            cacheReadTokens: result.tokenUsage.cacheReadTokens || 0,
            cacheCreationTokens: result.tokenUsage.cacheCreationTokens || 0,
            totalCostUsd: result.tokenUsage.totalCostUsd || 0,
            contextWindow: result.tokenUsage.contextWindow || 200000,
          }
        : undefined,
    };
  } catch (error) {
    console.error(`[RemoteDeployService] Failed to send chat to agent:`, error);
    throw error;
  } finally {
    releaseConnection(id, callerId);
  }
}

/**
 * Subscribe to real-time task updates from a remote server.
 * Forwards task:update events to the main window via IPC.
 */
export function subscribeToTaskUpdates(service: RemoteDeployService, serverId: string): () => void {
  const { BrowserWindow } = require('electron');
  const server = (service as any).servers.get(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const callerId = `remote-agent:tasks-subscribe:${serverId}`;
  let released = false;
  let connectionReleased = false;
  let activeClient: any;
  let activeHandler: ((data: any) => void) | undefined;
  const releaseOnce = () => {
    if (connectionReleased) {
      return;
    }
    connectionReleased = true;
    releaseConnection(serverId, callerId);
  };

  void getOrCreateWsClient(service, serverId, server, callerId)
    .then((wsClient) => {
      activeClient = wsClient;
      const handler = (data: any) => {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send('remote-server:task-update', { serverId, data });
        }
      };
      activeHandler = handler;
      wsClient.on('task:update', handler);
      if (released) {
        wsClient.off('task:update', handler);
        releaseOnce();
      }
    })
    .catch((error) => {
      console.error(`[RemoteDeployService] Failed to subscribe to task updates:`, error);
    });

  return () => {
    released = true;
    if (activeClient && activeHandler) {
      activeClient.off('task:update', activeHandler);
      releaseOnce();
    }
  };
}

/**
 * List background tasks on a remote server
 */
export function listRemoteTasks(service: RemoteDeployService, serverId: string): Promise<any[]> {
  const server = (service as any).servers.get(serverId);
  if (!server) {
    return Promise.reject(new Error(`Server not found: ${serverId}`));
  }

  const callerId = `remote-agent:list-tasks:${Date.now()}`;
  return getOrCreateWsClient(service, serverId, server, callerId).then(
    (wsClient) =>
      new Promise((resolve, _reject) => {
        const finish = (result: any[]) => {
          wsClient.off('task:list', handler);
          clearTimeout(timeout);
          releaseConnection(serverId, callerId);
          resolve(result);
        };
        const handler = (data: any) => {
          finish(data);
        };
        const timeout = setTimeout(() => {
          finish([]);
        }, 5000);
        wsClient.on('task:list', handler);
        if (!wsClient.listTasks()) {
          finish([]);
        }
      }),
  );
}

/**
 * Cancel a background task on a remote server
 */
export function cancelRemoteTask(service: RemoteDeployService, serverId: string, taskId: string): Promise<boolean> {
  const server = (service as any).servers.get(serverId);
  if (!server) {
    return Promise.reject(new Error(`Server not found: ${serverId}`));
  }

  const callerId = `remote-agent:cancel-task:${taskId}:${Date.now()}`;
  return getOrCreateWsClient(service, serverId, server, callerId).then(
    (wsClient) =>
      new Promise((resolve, _reject) => {
        const finish = (result: boolean) => {
          wsClient.off('task:cancel', handler);
          clearTimeout(timeout);
          releaseConnection(serverId, callerId);
          resolve(result);
        };
        const handler = (data: any) => {
          finish(data?.success ?? false);
        };
        const timeout = setTimeout(() => {
          finish(false);
        }, 5000);
        wsClient.on('task:cancel', handler);
        if (!wsClient.cancelTask(taskId)) {
          finish(false);
        }
      }),
  );
}

/**
 * Get or create WebSocket client for a server
 */
export async function getOrCreateWsClient(
  _service: RemoteDeployService,
  id: string,
  server: any,
  callerId: string = `remote-agent:${id}`,
): Promise<any> {
  // Resolve API credentials -- server card aiSourceId takes precedence, then global AI source
  const config = getConfig();
  const sourceId = server.aiSourceId || config.aiSources?.currentId;
  const currentSource = sourceId
    ? config.aiSources?.sources?.find((s: any) => s.id === sourceId)
    : undefined;

  // Resolve from AI source directly (server card values are stale after global switches)
  const apiKeyRaw = currentSource?.apiKey || config.api?.apiKey;
  const apiKey = apiKeyRaw ? decryptString(apiKeyRaw) : undefined;
  const baseUrl = currentSource?.apiUrl;
  const model = currentSource?.model || config.api?.model;

  // Create new WebSocket client
  const wsConfig = {
    serverId: id,
    host: server.ssh.host,
    port: server.assignedPort, // Prefer per-PC assigned port
    useSshTunnel: false, // TODO: Support SSH tunneling
    authToken: server.authToken || '',
    // Bind server card API credentials to this connection (per-PC isolation)
    apiKey,
    baseUrl: baseUrl || undefined,
    model: model || undefined,
  };

  return acquireConnection(id, wsConfig, callerId);
}

// ===== Agent installed check =====

/**
 * Lightweight detection of claude-agent-sdk on remote server
 * Unlike checkAgentInstalled(), this does NOT emit terminal output
 * Used for quick auto-detection when adding/connecting to a server
 */
export async function detectAgentInstalled(service: RemoteDeployService, id: string): Promise<{ installed: boolean; version?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);

  // Only connect if not already connected
  if (!manager.isConnected()) {
    await service.connectServer(id);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!manager.isConnected()) {
    return { installed: false };
  }

  try {
    // Level 1: Check SDK installation with version match
    service.emitDeployProgress(id, 'detect', 'Checking SDK installation...', 60);
    const result = await manager.executeCommandFull(AGENT_CHECK_COMMAND);
    const stdout = result.stdout.trim();
    let installed =
      stdout.includes('@anthropic-ai/claude-agent-sdk') && !stdout.includes('NOT_INSTALLED');

    let version: string | undefined;
    let versionMatched = false;
    if (installed) {
      const versionMatch = stdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/);
      version = versionMatch ? versionMatch[1] : 'unknown';
      versionMatched = version === REQUIRED_SDK_VERSION;
    }

    // Level 1.5: Fallback -- check file existence directly
    // npm list -g may not find packages installed via cp (offline deploy)
    if (!installed) {
      const deployPath = getDeployPath(server);
      const fallbackCheck = await manager.executeCommandFull(
        `cat $(npm root -g 2>/dev/null)/@anthropic-ai/claude-agent-sdk/package.json 2>/dev/null | grep '"version"' || ` +
          `cat ${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json 2>/dev/null | grep '"version"' || ` +
          `echo ""`,
      );
      const versionLine = fallbackCheck.stdout.trim();
      const fbVersionMatch = versionLine.match(/"version":\s*"([\d.]+)"/);
      if (fbVersionMatch) {
        version = fbVersionMatch[1];
        versionMatched = version === REQUIRED_SDK_VERSION;
        installed = true;
        console.debug(
          `[RemoteDeployService] SDK found via file existence check, version=${version}`,
        );
      }
    }

    // Level 2: Check if proxy is running via health endpoint
    let proxyRunning = false;
    if (server.assignedPort) {
      service.emitDeployProgress(id, 'detect', 'Checking proxy service...', 75);
      try {
        const port = server.assignedPort;
        const healthPort = port + 1;
        const healthCmd = `curl --noproxy '*' -s --connect-timeout 3 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`;
        const healthResult = await manager.executeCommandFull(healthCmd);
        try {
          const healthData = JSON.parse(healthResult.stdout || '{}');
          proxyRunning = healthData.status === 'ok';
        } catch {
          proxyRunning = false;
        }
      } catch {
        proxyRunning = false;
      }
    }

    // Update server config with full detection results
    // Note: sdkInstalled=false when version mismatch -- treated as not properly installed
    const sdkOk = installed && versionMatched;
    await service.updateServer(id, {
      sdkInstalled: sdkOk,
      sdkVersion: version,
      sdkVersionMismatch: installed && !versionMatched,
      proxyRunning,
    });

    console.debug(
      `[RemoteDeployService] detectAgentInstalled for ${server.name}: installed=${installed}, version=${version}, required=${REQUIRED_SDK_VERSION}, matched=${versionMatched}, proxyRunning=${proxyRunning}`,
    );

    service.emitDeployProgress(id, 'complete', 'Detection complete', 100);
    return { installed: sdkOk, version };
  } catch (error) {
    console.error(`[RemoteDeployService] detectAgentInstalled failed for ${server.name}:`, error);
    service.emitDeployProgress(id, 'error', 'Detection failed', 0);
    return { installed: false };
  }
}

/**
 * Check if claude-agent-sdk is installed on remote server
 */
export async function checkAgentInstalled(
  service: RemoteDeployService,
  id: string,
): Promise<{ installed: boolean; version?: string; buildTime?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  console.debug(
    `[RemoteDeployService] Starting SDK check for ${server.name}, current status: ${server.status}`,
  );

  // Get the SSH manager first
  const manager = service.getSSHManager(id);

  // Check if SSH connection is actually established
  console.debug(`[RemoteDeployService] Checking SSH connection state: ${manager.isConnected()}`);

  // Only connect if not already connected
  if (!manager.isConnected()) {
    console.debug(`[RemoteDeployService] Not connected, connecting to ${server.name}...`);
    await service.connectServer(id);
    // Wait for connection to stabilize
    console.debug(`[RemoteDeployService] Waiting for SSH connection to stabilize...`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // Verify connection is ready
  console.debug(
    `[RemoteDeployService] Verifying SSH connection state after connect: ${manager.isConnected()}`,
  );
  if (!manager.isConnected()) {
    throw new Error(`Failed to establish SSH connection to server: ${server.name}`);
  }

  try {
    // First, test connection with a simple pwd command
    console.debug(
      `[RemoteDeployService] Testing SSH connection to ${server.name} with pwd command...`,
    );
    service.emitCommandOutput(id, 'command', 'pwd');
    const testResult = await manager.executeCommandFull('pwd');
    console.debug(`[RemoteDeployService] pwd result: ${testResult.stdout}`);
    if (testResult.stdout.trim()) {
      service.emitCommandOutput(id, 'output', testResult.stdout.trim());
    }

    // Check if claude-agent-sdk is installed (try fast local check first, then fallback to npm list -g)
    console.debug(`[RemoteDeployService] Checking for claude-agent-sdk...`);

    let installed = false;
    let version: string | undefined;

    // Fast path 1: Check local node_modules first (for offline deployments)
    const deployPath = getDeployPath(server);
    const localSdkCheckCmd = `test -f "${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json" && cat "${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json" | grep -oP '"version"\\s*:\\s*"\\K[^"]+' || echo ""`;

    console.debug(`[RemoteDeployService] Trying fast local SDK check...`);
    service.emitCommandOutput(
      id,
      'command',
      `检查本地 SDK: ${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk`,
    );

    try {
      const localResult = await manager.executeCommandFull(localSdkCheckCmd, { timeout: 5000 });
      const localVersion = localResult.stdout.trim();
      if (localVersion) {
        version = localVersion;
        installed = true;
        console.debug(`[RemoteDeployService] Found SDK locally: version ${version}`);
        service.emitCommandOutput(id, 'success', `SDK 在本地部署路径找到 (版本: ${version})`);
      }
    } catch (error) {
      console.debug(`[RemoteDeployService] Local SDK check failed:`, error);
    }

    // Fallback: If not found locally, try npm list -g (slower but catches globally installed SDK)
    if (!installed) {
      console.debug(`[RemoteDeployService] Local check failed, trying npm list -g...`);
      service.emitCommandOutput(id, 'command', AGENT_CHECK_COMMAND);
      try {
        const result = await manager.executeCommandFull(AGENT_CHECK_COMMAND, { timeout: 10000 });
        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();

        console.debug(
          `[RemoteDeployService] npm list output: stdout="${stdout}", stderr="${stderr}"`,
        );

        if (stdout) {
          service.emitCommandOutput(id, 'output', stdout);
        }
        if (stderr && !stderr.includes('npm WARN')) {
          service.emitCommandOutput(id, 'error', stderr);
        }

        // npm list -g returns:
        // - If installed: "/path/to/node_modules/@anthropic-ai/claude-agent-sdk@x.y.z"
        // - If not installed: empty string or "empty string"
        if (
          stdout.includes('@anthropic-ai/claude-agent-sdk') &&
          !stdout.includes('NOT_INSTALLED')
        ) {
          installed = true;
          // Parse version from output like: "/path/node_modules/@anthropic-ai/claude-agent-sdk@0.1.0"
          const versionMatch = stdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/);
          version = versionMatch ? versionMatch[1] : 'unknown';
        }
      } catch (npmError) {
        console.debug(`[RemoteDeployService] npm list -g timed out or failed:`, npmError);
        service.emitCommandOutput(id, 'warning', 'npm list -g 检查超时，可能是权限问题');
      }
    }

    const statusMessage = installed
      ? `claude-agent-sdk is installed (version: ${version})`
      : 'claude-agent-sdk is not installed';

    service.emitCommandOutput(id, 'success', statusMessage);
    console.debug(
      `[RemoteDeployService] Agent check for ${server.name}: installed=${installed}, version=${version}`,
    );

    // Update server config with SDK status (only mark installed if version matches exactly)
    const versionMatched = installed && version === REQUIRED_SDK_VERSION;
    await service.updateServer(id, {
      sdkInstalled: versionMatched,
      sdkVersion: version,
      sdkVersionMismatch: installed && !versionMatched,
    });

    // Also read the deployed package.json to get build timestamp
    let buildTime: string | undefined;
    try {
      const deployPathInner = getDeployPath(server);
      const packageJsonResult = await manager.executeCommandFull(
        `cat ${deployPathInner}/package.json 2>/dev/null || echo ""`,
      );
      if (packageJsonResult.stdout.trim()) {
        const remotePackageJson = JSON.parse(packageJsonResult.stdout);
        if (remotePackageJson.buildTime) {
          buildTime = remotePackageJson.buildTime;
          console.debug(`[RemoteDeployService] Remote agent build time: ${buildTime}`);
        }
        if (remotePackageJson.version && !version) {
          // Use package.json version as fallback
          version = remotePackageJson.version;
        }
      }
    } catch (pkgError) {
      console.debug('[RemoteDeployService] Failed to read remote package.json:', pkgError);
    }

    return { installed, version, buildTime };
  } catch (error) {
    console.error(`[RemoteDeployService] Failed to check agent on ${server.name}:`, error);
    throw error;
  }
}

/**
 * Deploy agent SDK to remote server via SCP
 */
export async function deployAgentSDK(service: RemoteDeployService, id: string): Promise<void> {
  // [DEPRECATED] Online SDK install removed — offline deploy handles SDK via file copy
  throw new Error('在线 SDK 安装已移除，请使用离线部署');
}
