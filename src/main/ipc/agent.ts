import { wrapIpcHandle } from './ipc-logger';
/**
 * Agent IPC Handlers
 */

import { ipcMain } from 'electron';
import {
  sendMessage,
  stopGeneration,
  getSessionState,
  ensureSessionWarm,
  testMcpConnections,
  resolveQuestion,
  rejectQuestion,
  rejectAllQuestions,
  resolvePermission,
  rejectAllPermissions,
  compactContext,
} from '../services/agent';
import { getMainWindow } from '../services/window.service';
import { queueInjection } from '../services/agent/stream-processor';
import { getRemoteWsClient } from '../services/remote/ws/remote-ws-client';

export function registerAgentHandlers(): void {
  // Send message to agent (with optional images for multi-modal, optional thinking mode)
  wrapIpcHandle(
    'agent:send-message',
    async (
      _event,
      request: {
        spaceId: string;
        conversationId: string;
        message: string;
        resumeSessionId?: string;
        images?: Array<{
          id: string;
          type: 'image';
          mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
          data: string;
          name?: string;
          size?: number;
        }>;
        thinkingEnabled?: boolean; // Enable extended thinking mode
        aiBrowserEnabled?: boolean; // Enable AI Browser
        agentId?: string; // Target agent for Hyper Space
      },
    ) => {
      try {
        const inputLines = [
          '================================================================================',
          `[USER INPUT] conversationId=${request.conversationId} | spaceId=${request.spaceId}`,
          `  Message: "${request.message}" (${request.message.length} chars)`,
        ];
        if (request.images?.length) {
          inputLines.push(`  Images: ${request.images.length} attachment(s)`);
        }
        const modes: string[] = [];
        if (request.thinkingEnabled) modes.push('thinking=on');
        if (request.aiBrowserEnabled) modes.push('aiBrowser=on');
        if (request.resumeSessionId) modes.push(`resume=${request.resumeSessionId.substring(0, 8)}`);
        if (request.agentId) modes.push(`agent=${request.agentId}`);
        if (modes.length) inputLines.push(`  Mode: ${modes.join(', ')}`);
        inputLines.push('--------------------------------------------------------------------------------');
        console.info(inputLines.join('\n'));
        await sendMessage(getMainWindow(), request);
        return { success: true };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Stop generation for a specific conversation (or all if not specified)
  // Note: abortController.abort() is synchronous and takes effect immediately.
  // The interrupt/drain cleanup runs in the background and should not block the IPC response.
  wrapIpcHandle('agent:stop', async (_event, conversationId?: string) => {
    console.info(`[event] stopGeneration: conversationId=${conversationId || 'all'}`);
    try {
      // Fire-and-forget: abort is already synchronous via abortController.abort()
      // interrupt/drain may hang, so don't await — let it run in background
      stopGeneration(conversationId).catch((err) => {
        console.error(`[IPC] agent:stop background error:`, err);
      });
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Inject message at turn boundary (for turn-level message injection)
  wrapIpcHandle(
    'agent:inject-message',
    async (
      _event,
      request: {
        conversationId: string;
        content: string;
        images?: Array<{
          type: string;
          data: string;
          mediaType: string;
        }>;
        thinkingEnabled?: boolean;
        aiBrowserEnabled?: boolean;
      },
    ) => {
      try {
        console.log(
          `[IPC] agent:inject-message called for conversationId=${request.conversationId}`,
        );
        queueInjection(request.conversationId, {
          content: request.content,
          images: request.images,
          thinkingEnabled: request.thinkingEnabled,
          aiBrowserEnabled: request.aiBrowserEnabled,
        });
        return { success: true };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Approve/reject tool execution - no-op (all permissions auto-allowed)
  wrapIpcHandle('agent:approve-tool', async () => ({ success: true }));
  wrapIpcHandle('agent:reject-tool', async () => ({ success: true }));

  // Get current session state for recovery after refresh
  wrapIpcHandle('agent:get-session-state', async (_event, conversationId: string) => {
    try {
      const state = getSessionState(conversationId);
      return { success: true, data: state };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Warm up V2 session - call when switching conversations to prepare for faster message sending
  wrapIpcHandle(
    'agent:ensure-session-warm',
    async (_event, spaceId: string, conversationId: string) => {
      try {
        // Async initialization, non-blocking IPC call
        ensureSessionWarm(spaceId, conversationId).catch((error: unknown) => {
          console.error('[IPC] ensureSessionWarm error:', error);
        });
        return { success: true };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Answer a pending AskUserQuestion
  wrapIpcHandle(
    'agent:answer-question',
    async (
      _event,
      data: {
        conversationId: string;
        id: string;
        answers: Record<string, string>;
      },
    ) => {
      try {
        // Check if this is a remote session — forward answer via WebSocket
        const remoteClient = getRemoteWsClient(data.conversationId);
        if (remoteClient && remoteClient.isConnected()) {
          remoteClient.send({
            type: 'ask:answer',
            sessionId: data.conversationId,
            payload: { id: data.id, answers: data.answers },
          });
          return { success: true };
        }

        // Local session — resolve the pending question directly
        const resolved = resolveQuestion(data.id, data.answers);
        if (!resolved) {
          return { success: false, error: 'No pending question found for this ID' };
        }
        return { success: true };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Resolve a pending tool permission request (approve/deny from UI)
  wrapIpcHandle(
    'agent:resolve-permission',
    async (_event, data: { id: string; approved: boolean; conversationId?: string }) => {
      try {
        // Check if this is a remote session — forward via WebSocket
        if (data.conversationId) {
          const remoteClient = getRemoteWsClient(data.conversationId);
          if (remoteClient && remoteClient.isConnected()) {
            remoteClient.send({
              type: data.approved ? 'tool:approve' : 'tool:reject',
              sessionId: data.conversationId,
              payload: { toolId: data.id, approved: data.approved },
            });
            return { success: true };
          }
        }

        // Local session — resolve directly
        const resolved = resolvePermission(data.id, data.approved);
        if (!resolved) {
          return { success: false, error: 'No pending permission found for this ID' };
        }
        return { success: true };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Reject a pending AskUserQuestion (renderer cannot handle it)
  wrapIpcHandle(
    'agent:reject-question',
    async (
      _event,
      data: {
        id: string;
        reason?: string;
      },
    ) => {
      try {
        const rejected = rejectQuestion(data.id, data.reason || 'Rejected by renderer');
        if (!rejected) {
          return { success: false, error: 'No pending question found for this ID' };
        }
        return { success: true };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Test MCP server connections
  wrapIpcHandle('agent:test-mcp', async () => {
    try {
      const result = await testMcpConnections(getMainWindow());
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, servers: [], error: err.message };
    }
  });

  // Manually trigger context compression for a conversation
  wrapIpcHandle('agent:compact-context', async (_event, conversationId: string) => {
    try {
      const result = await compactContext(conversationId);
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Continue waiting after idle timeout warning
  wrapIpcHandle('agent:continue-idle-timeout', async (_event, conversationId: string) => {
    try {
      const client = getRemoteWsClient(conversationId);
      if (client) {
        client.continueIdleTimeout(conversationId);
        return { success: true };
      }
      return { success: false, error: 'No active remote stream session' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Force disconnect after idle timeout warning
  wrapIpcHandle('agent:force-idle-timeout', async (_event, conversationId: string) => {
    try {
      const client = getRemoteWsClient(conversationId);
      if (client) {
        client.forceIdleTimeoutDisconnect(conversationId);
        return { success: true };
      }
      return { success: false, error: 'No active remote stream session' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });
}
