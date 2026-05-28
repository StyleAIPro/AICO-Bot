import { wrapIpcHandle } from './ipc-logger';
/**
 * Remote Server IPC Handlers
 * Manages remote server configurations and deployments
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import type { RemoteServerConfigInput } from '../services/remote/deploy';
import { remoteDeployService as deployService } from '../services/remote/deploy/remote-deploy.service';
import type { RemoteServer } from '../../shared/types';
import { getMainWindow, onMainWindowChange } from '../services/window.service';

let mainWindow: BrowserWindow | null = null;

// Subscribe to window changes
onMainWindowChange((window) => {
  mainWindow = window;
});

// Subscribe to status changes
deployService.onStatusChange((serverId, config) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-server:status-change', {
      serverId,
      config,
    });
  }
});

// Subscribe to command output events
deployService.onCommandOutput((serverId, type, content) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-server:command-output', {
      serverId,
      type,
      content,
      timestamp: Date.now(),
    });
  }
});

// Subscribe to deploy progress events
deployService.onDeployProgress((serverId, stage, message, progress) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-server:deploy-progress', {
      serverId,
      stage,
      message,
      progress,
      timestamp: Date.now(),
    });
  }
});

/**
 * Register IPC handlers for remote server and remote agent operations
 */
export function registerRemoteServerHandlers(): void {
  console.log('[IPC] Registering remote server handlers');

  // ===== Remote Server Handlers =====

  wrapIpcHandle('remote-server:add', async (_event, input: RemoteServerConfigInput) => {
    console.log('[IPC] remote-server:add - Adding server:', input.name);
    console.log('[IPC] remote-server:add - Full input:', JSON.stringify(input));
    try {
      const result = await deployService.addServer(input);
      console.log('[IPC] remote-server:add - Added server ID:', result.id, 'sshConnected:', result.sshConnected);
      if (result.sshConnected) {
        return { success: true, data: { id: result.id } };
      } else {
        return {
          success: true,
          data: { id: result.id, partial: true, error: result.error, authError: result.authError },
        };
      }
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:add - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:list', async () => {
    try {
      const servers = deployService.getServers();
      return { success: true, data: servers };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:list - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:get', async (_event, id: string) => {
    try {
      const server = deployService.getServer(id);
      if (!server) {
        return { success: false, error: 'Server not found' };
      }
      return { success: true, data: server };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:get - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(
    'remote-server:update',
    async (_event, server: Partial<RemoteServer> & { id: string }) => {
      const { id, ...updates } = server;
      console.log(
        '[IPC] remote-server:update - Updating server:',
        id,
        'updates:',
        Object.keys(updates),
      );
      try {
        // Update the server config
        deployService.updateServer(id, updates);
        const updatedServer = deployService.getServer(id);

        // If API key or base URL changed and agent is running, restart it
        if (
          updates.claudeApiKey !== undefined ||
          updates.claudeBaseUrl !== undefined ||
          updates.claudeModel !== undefined
        ) {
          console.log(
            '[IPC] remote-server:update - API config changed, checking if agent needs restart...',
          );
          try {
            // Check if agent is running and restart it with new config
            await deployService.restartAgentWithNewConfig(id);
          } catch (restartErr) {
            console.warn('[IPC] remote-server:update - Failed to restart agent:', restartErr);
            // Don't fail the update if restart fails
          }
        }

        return { success: true, data: updatedServer };
      } catch (error: unknown) {
        const err = error as Error;
        console.error('[IPC] remote-server:update - Failed:', err.message);
        return { success: false, error: err.message };
      }
    },
  );

  wrapIpcHandle(
    'remote-server:update-ai-source',
    async (_event, serverId: string, aiSourceId: string) => {
      console.log(
        `[IPC] remote-server:update-ai-source - serverId=${serverId}, aiSourceId=${aiSourceId}`,
      );
      try {
        await deployService.updateServerAiSource(serverId, aiSourceId);
        return { success: true };
      } catch (error: unknown) {
        const err = error as Error;
        console.error('[IPC] remote-server:update-ai-source - Failed:', err.message);
        return { success: false, error: err.message };
      }
    },
  );

  wrapIpcHandle('remote-server:update-model', async (_event, serverId: string, model: string) => {
    console.log(`[IPC] remote-server:update-model - serverId=${serverId}, model=${model}`);
    try {
      await deployService.updateServerModel(serverId, model);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:update-model - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:delete', async (_event, id: string) => {
    console.log('[IPC] remote-server:delete - Removing server:', id);
    try {
      await deployService.removeServer(id);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:delete - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:deploy', async (_event, serverId: string) => {
    console.info(`[event] remoteDeploy: serverId=${serverId}`);
    try {
      await deployService.deployToServer(serverId);
      const server = deployService.getServer(serverId);
      return { success: true, data: server };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:deploy - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:connect', async (_event, serverId: string) => {
    console.info(`[event] remoteConnect: serverId=${serverId}`);
    try {
      await deployService.connectServer(serverId);
      const server = deployService.getServer(serverId);
      return { success: true, data: server };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:connect - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:disconnect', async (_event, serverId: string) => {
    console.info(`[event] remoteDisconnect: serverId=${serverId}`);
    try {
      deployService.disconnectServer(serverId);
      const server = deployService.getServer(serverId);
      return { success: true, data: server };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:disconnect - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:execute', async (_event, id: string, command: string) => {
    console.log('[IPC] remote-server:execute - Executing command on server:', id);
    try {
      const output = await deployService.executeCommand(id, command);
      return { success: true, data: { output } };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:execute - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // ===== Remote Agent Handlers =====

  wrapIpcHandle('remote-agent:send-message', async (_event, serverId: string, message: any) => {
    console.log(
      '[IPC] remote-agent:sendMessage - Sending message to agent:',
      serverId,
      message.type,
    );
    try {
      const response = await deployService.sendAgentMessage(serverId, message);
      return { success: true, data: response };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-agent:sendMessage - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Send chat message to remote agent via WebSocket and return response with tokenUsage
  wrapIpcHandle(
    'remote-agent:chat',
    async (
      _event,
      serverId: string,
      params: { sessionId?: string; content: string; attachments?: any[] },
    ) => {
      console.log('[IPC] remote-agent:chat - Sending chat to agent:', serverId, params.sessionId);
      try {
        const response = await deployService.sendAgentChat(serverId, params);
        return { success: true, data: response };
      } catch (error: unknown) {
        const err = error as Error;
        console.error('[IPC] remote-agent:chat - Failed:', err.message);
        return { success: false, error: err.message };
      }
    },
  );

  wrapIpcHandle('remote-agent:fs-list', async (_event, serverId: string, directory?: string) => {
    try {
      const files = await deployService.listRemoteFiles(serverId, directory);
      return { success: true, data: { files } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  wrapIpcHandle('remote-agent:fs-read', async (_event, serverId: string, path: string) => {
    try {
      const content = await deployService.readRemoteFile(serverId, path);
      return { success: true, data: { content } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  wrapIpcHandle(
    'remote-agent:fs-write',
    async (_event, serverId: string, path: string, content: string) => {
      try {
        await deployService.writeRemoteFile(serverId, path, content);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  );

  wrapIpcHandle('remote-agent:fs-delete', async (_event, serverId: string, path: string) => {
    try {
      await deployService.deleteRemoteFile(serverId, path);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  console.log('[IPC] Remote server handlers registered');

  // Test connection handler
  wrapIpcHandle('remote-server:test-connection', async (_event, serverId: string) => {
    console.log('[IPC] remote-server:test-connection - Testing connection:', serverId);
    try {
      const server = deployService.getServer(serverId);
      if (!server) {
        return { success: false, error: 'Server not found' };
      }
      if (server.status !== 'connected') {
        return { success: false, error: 'Server not connected' };
      }
      return { success: true, data: server };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:test-connection - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-agent:check-connection', async (_event, serverId: string) => {
    console.log('[IPC] remote-agent:check-connection - Checking connection:', serverId);
    try {
      // TODO: Implement actual connection check
      return { success: true, data: { connected: true } };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-agent:check-connection - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Get messages handler
  wrapIpcHandle(
    'remote-agent:get-messages',
    async (_event, serverId: string, sessionId: string) => {
      console.log('[IPC] remote-agent:get-messages - Getting messages:', serverId, sessionId);
      try {
        // For now, return empty array since remote agent doesn't persist messages
        // The UI will show messages from the current session only
        // TODO: Implement message persistence for remote agent sessions
        return { success: true, data: [] };
      } catch (error: unknown) {
        const err = error as Error;
        console.error('[IPC] remote-agent:get-messages - Failed:', err.message);
        return { success: false, error: err.message };
      }
    },
  );

  // ===== Background Task Handlers =====

  // Subscribe to task updates via WebSocket push (called when entering remote space)
  wrapIpcHandle('remote-server:subscribe-tasks', async (_event, serverId: string) => {
    try {
      deployService.subscribeToTaskUpdates(serverId);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:subscribe-tasks - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:list-tasks', async (_event, serverId: string) => {
    try {
      const tasks = await deployService.listRemoteTasks(serverId);
      return { success: true, data: tasks };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:list-tasks - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle('remote-server:cancel-task', async (_event, serverId: string, taskId: string) => {
    try {
      const ok = await deployService.cancelRemoteTask(serverId, taskId);
      return { success: true, data: { success: ok } };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:cancel-task - Failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

// Check if claude-agent-sdk is installed on remote server
wrapIpcHandle('remote-server:check-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:check-agent - Checking agent installation:', serverId);
  try {
    const result = await deployService.checkAgentInstalled(serverId);
    return { success: true, data: result };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:check-agent - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Deploy agent to remote server (offline only)
wrapIpcHandle('remote-server:deploy-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:deploy-agent - Deploying agent (offline):', serverId);
  try {
    const server = deployService.getServer(serverId);
    const platform = server?.detectedArch as 'x64' | 'arm64' | undefined;
    if (!platform) {
      throw new Error('无法检测服务器 CPU 架构，离线部署需要 x86_64 或 aarch64');
    }
    if (!deployService.isOfflineBundleAvailable(platform)) {
      throw new Error(`离线部署包不存在 (linux-${platform})。请先执行 npm run build:offline-bundle 构建。`);
    }
    await deployService.deployAgentCodeOffline(serverId, platform);
    return { success: true, data: { message: 'Agent deployed successfully (offline)' } };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:deploy-agent - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Start agent server on remote server
wrapIpcHandle('remote-server:start-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:start-agent - Starting agent:', serverId);
  try {
    await deployService.startAgent(serverId);
    return { success: true, data: { message: 'Agent started successfully' } };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:start-agent - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Stop agent server on remote server
wrapIpcHandle('remote-server:stop-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:stop-agent - Stopping agent:', serverId);
  try {
    await deployService.stopAgent(serverId);
    return { success: true, data: { message: 'Agent stopped successfully' } };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:stop-agent - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Get agent server logs
wrapIpcHandle(
  'remote-server:get-agent-logs',
  async (_event, serverId: string, lines: number = 100) => {
    console.log('[IPC] remote-server:get-agent-logs - Getting logs:', serverId);
    try {
      const logs = await deployService.getAgentLogs(serverId, lines);
      return { success: true, data: { logs } };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:get-agent-logs - Failed:', err.message);
      return { success: false, error: err.message };
    }
  },
);

// Check if agent server is running
wrapIpcHandle('remote-server:is-agent-running', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:is-agent-running - Checking status:', serverId);
  try {
    const running = await deployService.isAgentRunning(serverId);
    return { success: true, data: { running } };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:is-agent-running - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Force update agent code and restart (for deploying new features)
wrapIpcHandle('remote-server:update-agent', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:update-agent - Updating agent code:', serverId);
  deployService.startUpdate(serverId);

  const sendCompleteEvent = (success: boolean, data?: unknown, error?: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-server:update-complete', {
        serverId,
        success,
        data,
        error,
      });
    }
    try {
      const { Notification } = require('electron');
      const server = deployService.getServer(serverId);
      const serverName = server?.name || serverId;
      new Notification({
        title: success ? 'Agent 更新完成' : 'Agent 更新失败',
        body: success
          ? `${serverName} 已成功更新`
          : `${serverName} 更新失败: ${error || '未知错误'}`,
      }).show();
    } catch {
      /* Notification may not be available */
    }
  };

  try {
    // Delegate to deployService.updateAgent() which has fast-path logic:
    // - If remote files + SDK are intact → just stop + start (no upload)
    // - Otherwise → full update (stop + upload + npm install + start)
    const result = await deployService.updateAgent(serverId);

    console.log('[IPC] remote-server:update-agent - Update complete', result);
    sendCompleteEvent(true, result);
    return { success: true, data: result };
  } catch (error) {
    const msg = (error as Error).message;
    deployService.failUpdate(serverId, msg);
    sendCompleteEvent(false, undefined, msg);
    return { success: false, error: msg };
  }
});

// Query update operation state (for restoring UI after tab switch)
wrapIpcHandle('remote-server:get-update-status', async (_event, serverId: string) => {
  const status = deployService.getUpdateStatus(serverId);
  return { success: true, data: status };
});

// Acknowledge an update result (UI has shown it, clear stored state)
wrapIpcHandle('remote-server:acknowledge-update', async (_event, serverId: string) => {
  deployService.acknowledgeUpdate(serverId);
  return { success: true };
});

// Deploy agent using embedded offline bundle (no remote network needed)
wrapIpcHandle(
  'remote-server:deploy-offline',
  async (_event, serverId: string, platform?: 'x64' | 'arm64') => {
    console.log(
      '[IPC] remote-server:deploy-offline - Deploying offline to:',
      serverId,
      'platform:',
      platform,
    );
    deployService.startUpdate(serverId);

    const sendCompleteEvent = (success: boolean, data?: unknown, error?: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('remote-server:update-complete', {
          serverId,
          success,
          data,
          error,
        });
      }
      try {
        const { Notification } = require('electron');
        const server = deployService.getServer(serverId);
        const serverName = server?.name || serverId;
        new Notification({
          title: success ? '离线部署完成' : '离线部署失败',
          body: success
            ? `${serverName} 已成功离线部署`
            : `${serverName} 离线部署失败: ${error || '未知错误'}`,
        }).show();
      } catch {
        /* Notification may not be available */
      }
    };

    try {
      await deployService.deployAgentCodeOffline(serverId, platform);
      deployService.completeUpdate(serverId);
      sendCompleteEvent(true);
      return { success: true };
    } catch (error) {
      const msg = (error as Error).message;
      deployService.failUpdate(serverId, msg);
      sendCompleteEvent(false, undefined, msg);
      return { success: false, error: msg };
    }
  },
);

// Check if offline deployment bundle is available
wrapIpcHandle(
  'remote-server:check-offline-bundle',
  async (_event, platform: 'x64' | 'arm64' = 'x64') => {
    const available = deployService.isOfflineBundleAvailable(platform);
    const bundlePath = deployService.getOfflineBundlePath(platform);
    return { success: true, data: { available, path: bundlePath } };
  },
);

wrapIpcHandle('remote-server:list-skills', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:list-skills - Listing skills on server:', serverId);
  try {
    const skills = await deployService.listRemoteSkills(serverId);
    return { success: true, data: skills };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:list-skills - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

wrapIpcHandle(
  'remote-server:list-skill-files',
  async (_event, serverId: string, skillId: string) => {
    console.log(
      '[IPC] remote-server:list-skill-files - Listing files on server:',
      serverId,
      'skill:',
      skillId,
    );
    try {
      const files = await deployService.listRemoteSkillFiles(serverId, skillId);
      return { success: true, data: files };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:list-skill-files - Failed:', err.message);
      return { success: false, error: err.message };
    }
  },
);

wrapIpcHandle(
  'remote-server:read-skill-file',
  async (_event, serverId: string, skillId: string, filePath: string) => {
    console.log(
      '[IPC] remote-server:read-skill-file - Reading file on server:',
      serverId,
      'skill:',
      skillId,
      'file:',
      filePath,
    );
    try {
      const content = await deployService.readRemoteSkillFile(serverId, skillId, filePath);
      return { success: true, data: content };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:read-skill-file - Failed:', err.message);
      return { success: false, error: err.message };
    }
  },
);

// Per-PC Isolation: scan for orphan deployments
wrapIpcHandle('remote-server:cleanup-scan', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:cleanup-scan - Scanning for orphan deployments:', serverId);
  try {
    const result = await deployService.cleanupOrphanDeployments(serverId);
    return { success: true, data: result };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:cleanup-scan - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Per-PC Isolation: delete an inactive deployment
wrapIpcHandle(
  'remote-server:delete-deployment',
  async (_event, serverId: string, clientId: string) => {
    console.log('[IPC] remote-server:delete-deployment - Deleting deployment:', serverId, clientId);
    try {
      await deployService.deleteDeployment(serverId, clientId);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[IPC] remote-server:delete-deployment - Failed:', err.message);
      return { success: false, error: err.message };
    }
  },
);

// Cancel an in-flight deploy/update operation
wrapIpcHandle('remote-server:cancel-operation', async (_event, serverId: string) => {
  console.log('[IPC] remote-server:cancel-operation - Cancelling operation for:', serverId);
  try {
    deployService.cancelOperation(serverId);
    return { success: true };
  } catch (error: unknown) {
    const err = error as Error;
    console.error('[IPC] remote-server:cancel-operation - Failed:', err.message);
    return { success: false, error: err.message };
  }
});

export function getRemoteDeployService(): RemoteDeployService {
  return deployService;
}
