import { wrapIpcHandle } from './ipc-logger';
/**
 * Space IPC Handlers
 */

import { ipcMain, dialog } from 'electron';
import {
  getAicoBotSpace,
  listSpaces,
  createSpace,
  deleteSpace,
  getSpaceWithPreferences,
  openSpaceFolder,
  updateSpace,
  updateSpacePreferences,
  getSpacePreferences,
  getOrCreateSkillSpace,
  getSkillSpaceId,
  isSkillSpace,
} from '../services/space.service';
import { getSpacesDir } from '../services/config.service';
import { remoteDeployService } from '../services/remote/deploy/remote-deploy.service';
import { acquireConnection, releaseConnection, type RemoteWsClientConfig } from '../services/remote/ws/remote-ws-client';
import sshTunnelService from '../services/remote/ssh/ssh-tunnel.service';
import { decryptString } from '../services/auth/secure-storage.service';

// Import types for preferences
interface SpaceLayoutPreferences {
  artifactRailExpanded?: boolean;
  chatWidth?: number;
}

interface SpacePreferences {
  layout?: SpaceLayoutPreferences;
}

/**
 * Create a temporary remote WS connection for one-off operations (stat, mkdir).
 * Handles SSH tunnel establishment if needed.
 * Caller must call the returned cleanup function when done.
 */
async function createTempRemoteClient(
  serverId: string,
  callerId: string,
): Promise<{ statPath: (path: string) => Promise<{ exists: boolean; isDirectory: boolean; error?: string }>; mkdir: (path: string) => Promise<{ success: boolean; error?: string }>; cleanup: () => void }> {
  const server = remoteDeployService.getServer(serverId);
  if (!server) throw new Error('Remote server not found');

  let useSshTunnel = false;
  let port = server.assignedPort || 30000;

  // Check if SSH tunnel is needed — try direct connection first
  const decryptedPassword = decryptString(server.password || '');
  if (server.sshPort && server.username && decryptedPassword) {
    try {
      const tunnelPort = await sshTunnelService.establishTunnel({
        spaceId: '__temp__',
        serverId,
        host: server.host,
        port: server.sshPort || 22,
        username: server.username,
        password: decryptedPassword,
        localPort: 0, // Let OS assign a free port
        remotePort: port,
      });
      useSshTunnel = true;
      port = tunnelPort;
    } catch (err) {
      console.warn('[SpaceIPC] SSH tunnel failed, trying direct connection:', err);
    }
  }

  const wsConfig: RemoteWsClientConfig = {
    serverId,
    host: useSshTunnel ? 'localhost' : server.host,
    port,
    authToken: server.authToken || '',
    useSshTunnel,
  };

  const client = await acquireConnection(serverId, wsConfig, callerId);

  return {
    statPath: (path: string) => client.statPath(path),
    mkdir: (path: string) => client.mkdir(path),
    cleanup: () => {
      releaseConnection(serverId, callerId);
    },
  };
}

export function registerSpaceHandlers(): void {
  // Get AICO-Bot temp space
  wrapIpcHandle('space:get-aico-bot', async () => {
    try {
      const space = getAicoBotSpace();
      console.log('[SpaceIPC] space:get-aico-bot response: id=%s', space?.id);
      return { success: true, data: space };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[SpaceIPC] space:get-aico-bot error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // List all spaces
  wrapIpcHandle('space:list', async () => {
    try {
      const spaces = listSpaces();
      console.log('[SpaceIPC] space:list response: count=%d', spaces.length);
      return { success: true, data: spaces };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[SpaceIPC] space:list error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Create a new space
  wrapIpcHandle(
    'space:create',
    async (
      _event,
      input: {
        name: string;
        icon: string;
        customPath?: string;
        claudeSource?: 'local' | 'remote';
        remoteServerId?: string;
        remotePath?: string;
        systemPrompt?: string;
      },
    ) => {
      try {
        console.info(`[event] createSpace: name=${input.name}`);
        // Validate remote server readiness: SDK installed + Bot Proxy running
        if (input.claudeSource === 'remote' && input.remoteServerId) {
          const server = remoteDeployService.getServer(input.remoteServerId);
          if (!server) {
            return { success: false, error: 'Remote server not found' };
          }
          if (!server.sdkInstalled) {
            return {
              success: false,
              error: `Remote server "${server.name}" is not ready: SDK is not installed. Please deploy the agent first.`,
            };
          }
          if (!server.proxyRunning) {
            return {
              success: false,
              error: `Remote server "${server.name}" is not ready: Bot Proxy is not running. Please update the agent first.`,
            };
          }

          // Check remote directory existence (blocking)
          if (input.remotePath) {
            const { statPath, cleanup } = await createTempRemoteClient(
              input.remoteServerId,
              `space-create-check-${Date.now()}`,
            );
            try {
              const stat = await statPath(input.remotePath);
              if (stat.error) {
                return { success: false, error: 'REMOTE_DIR_CHECK_FAILED', data: { remotePath: input.remotePath, detail: stat.error } };
              }
              if (!stat.exists) {
                return { success: false, error: 'REMOTE_DIR_NOT_FOUND', data: { remotePath: input.remotePath } };
              }
              if (!stat.isDirectory) {
                return { success: false, error: 'REMOTE_DIR_NOT_DIRECTORY', data: { remotePath: input.remotePath } };
              }
            } finally {
              cleanup();
            }
          }
        }

        const space = createSpace(input);
        return { success: true, data: space };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Create directory on remote server (used when remotePath doesn't exist)
  wrapIpcHandle(
    'space:create-dir',
    async (
      _event,
      input: { remoteServerId: string; remotePath: string },
    ) => {
      try {
        const server = remoteDeployService.getServer(input.remoteServerId);
        if (!server) {
          return { success: false, error: 'Remote server not found' };
        }

        const { mkdir, cleanup } = await createTempRemoteClient(
          input.remoteServerId,
          `space-create-dir-${Date.now()}`,
        );
        try {
          const result = await mkdir(input.remotePath);
          return { success: result.success, error: result.error };
        } finally {
          cleanup();
        }
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Delete a space
  wrapIpcHandle('space:delete', async (_event, spaceId: string) => {
    console.info(`[event] deleteSpace: spaceId=${spaceId}`);
    try {
      const result = await deleteSpace(spaceId);
      return { success: result.success, error: result.error };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Get a specific space (with preferences for UI)
  wrapIpcHandle('space:get', async (_event, spaceId: string) => {
    try {
      const space = getSpaceWithPreferences(spaceId);
      return { success: true, data: space };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Open space folder
  wrapIpcHandle('space:open-folder', async (_event, spaceId: string) => {
    try {
      const result = openSpaceFolder(spaceId);
      return { success: true, data: result };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Update space
  wrapIpcHandle(
    'space:update',
    async (_event, spaceId: string, updates: { name?: string; icon?: string }) => {
      console.info(`[event] updateSpace: spaceId=${spaceId}, keys=${Object.keys(updates).join(',')}`);
      try {
        const space = updateSpace(spaceId, updates);
        return { success: true, data: space };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Get default space path
  wrapIpcHandle('space:get-default-path', async () => {
    try {
      const spacesDir = getSpacesDir();
      return { success: true, data: spacesDir };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Select folder dialog (for custom space location)
  wrapIpcHandle('dialog:select-folder', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Space Location',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Select Folder',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: null };
      }

      return { success: true, data: result.filePaths[0] };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(
    'dialog:open',
    async (_event, options: Electron.OpenDialogOptions) => {
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog(options);
      return result.filePaths;
    },
  );

  // Update space preferences (layout settings)
  wrapIpcHandle(
    'space:update-preferences',
    async (_event, spaceId: string, preferences: Partial<SpacePreferences>) => {
      try {
        const space = updateSpacePreferences(spaceId, preferences);
        return { success: true, data: space };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Get space preferences
  wrapIpcHandle('space:get-preferences', async (_event, spaceId: string) => {
    try {
      const preferences = getSpacePreferences(spaceId);
      return { success: true, data: preferences };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Get or create skill space
  wrapIpcHandle('space:get-skill-space', async () => {
    try {
      const space = getOrCreateSkillSpace();
      console.log('[SpaceIPC] space:get-skill-space response: id=%s', space?.id);
      return { success: true, data: space };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[SpaceIPC] space:get-skill-space error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Get skill space ID
  wrapIpcHandle('space:get-skill-space-id', async () => {
    try {
      const spaceId = getSkillSpaceId();
      return { success: true, data: spaceId };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Check if space is skill space
  wrapIpcHandle('space:is-skill-space', async (_event, spaceId: string) => {
    try {
      const result = isSkillSpace(spaceId);
      return { success: true, data: result };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });
}
