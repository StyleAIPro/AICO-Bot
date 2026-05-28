/**
 * WebSocket Client for Remote Agent Communication
 * Handles bi-directional communication with remote agent proxy servers.
 *
 * Split modules:
 * - ws-types.ts: Type definitions (ClientMessage, ServerMessage, etc.)
 * - ws-connection-pool.ts: Connection pool management
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createLogger } from '../../log';
import type { RemoteWsClientConfig, ClientMessage, ServerMessage } from './ws-types';
import { disconnectAllPooledConnections } from './ws-connection-pool';

const log = createLogger('remote-ws');

// Re-export types
export type {
  RemoteWsClientConfig,
  ClientMessage,
  ServerMessage,
  ToolCallData,
  TerminalOutputData,
} from './ws-types';

// Re-export connection pool
export {
  acquireConnection,
  releaseConnection,
  removePooledConnection,
  getPoolStats,
} from './ws-connection-pool';

export class RemoteWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: RemoteWsClientConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 3000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongTime: number | null = null;
  private readonly pongTimeoutMs = 90 * 1000;
  private authenticated = false;
  public readonly sessionId: string | null = null;
  private interruptedSessions = new Set<string>();
  private shouldReconnect = true;
  private _mcpToolsRegistered = false;
  private sessionlessFsBusy = false;
  private sessionlessFsQueue: Array<() => void> = [];

  get mcpToolsRegistered(): boolean {
    return this._mcpToolsRegistered;
  }
  set mcpToolsRegistered(value: boolean) {
    this._mcpToolsRegistered = value;
  }

  private activeStreamSessions = new Map<
    string,
    {
      resolve: (value: { content: string; tokenUsage?: any }) => void;
      reject: (reason: Error) => void;
      cleanup: () => void;
    }
  >();
  private pendingIdleTimeouts = new Map<string, {
    continueWaiting: () => void;
    forceDisconnect: () => void;
  }>();

  constructor(config: RemoteWsClientConfig, sessionId?: string) {
    super();
    this.config = config;
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      log.debug(`[${this.config.serverId}] Already connecting or connected`);
      if (this.ws.readyState === WebSocket.OPEN && !this.authenticated) {
        log.debug(`[${this.config.serverId}] Connected but not authenticated, sending auth...`);
        return this.sendAuthAndWait();
      }
      return;
    }

    this.shouldReconnect = true;
    this.authenticated = false;
    this._mcpToolsRegistered = false;
    this.interruptedSessions.clear();

    return new Promise<void>((resolve, reject) => {
      const host = this.config.useSshTunnel ? 'localhost' : this.config.host;
      const port = this.config.port;
      const wsUrl = `ws://${host}:${port}/agent`;
      const connectionMode = this.config.useSshTunnel
        ? `SSH tunnel (localhost:${port})`
        : `direct (${host}:${port})`;
      const connectionStartTime = Date.now();

      log.info(`[${this.config.serverId}] Connecting to ${wsUrl} via ${connectionMode}`);
      log.debug(
        `[${this.config.serverId}] Auth token: ${this.config.authToken ? this.config.authToken.substring(0, 10) + '...' : 'none'}`,
      );

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.authToken}`,
        },
        perMessageDeflate: {
          threshold: 1024,
        },
      });

      let settled = false;
      const settle = (result: 'resolve' | 'reject', error?: Error) => {
        if (settled) return;
        settled = true;
        if (result === 'resolve') {
          resolve();
        } else {
          reject(error!);
        }
      };

      this.ws.on('upgrade', (req) => {
        log.debug(`[${this.config.serverId}] WebSocket upgrade: ${req.url}`);
      });

      this.ws.on('open', () => {
        const duration = Date.now() - connectionStartTime;
        log.info(`[${this.config.serverId}] WebSocket open after ${duration}ms`);
        this.reconnectAttempts = 0;
        this.emit('connected');

        if (this.authenticated) {
          log.info(`[${this.config.serverId}] Already authenticated via header`);
          settle('resolve');
          return;
        }

        log.debug(`[${this.config.serverId}] Sending auth message...`);
        this.send({ type: 'auth', payload: { token: this.config.authToken } });

        log.debug(`[${this.config.serverId}] Waiting for auth confirmation...`);
        const authTimeout = setTimeout(() => {
          if (!this.authenticated) {
            const err = new Error(
              `Authentication timed out — the remote proxy may not be running or the auth token is invalid. ` +
                `Ensure the agent is started and the token is registered on the remote server.`,
            );
            log.error(`[${this.config.serverId}] ${err.message}`);
            settle('reject', err);
          }
        }, 10000);

        this.once('authenticated', () => {
          clearTimeout(authTimeout);
          log.info(`[${this.config.serverId}] Authenticated`);
          settle('resolve');
        });
        this.once('authFailed', (data: any) => {
          clearTimeout(authTimeout);
          const err = new Error(`Authentication failed: ${data?.message || 'Invalid token'}`);
          log.error(`[${this.config.serverId}] ${err.message}`);
          settle('reject', err);
        });
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        log.error(`[${this.config.serverId}] WebSocket error:`, err);
        log.error(`[${this.config.serverId}] Error code: ${err?.code}, message: ${err?.message}`);
        this.emit('error', err);
        settle('reject', err instanceof Error ? err : new Error(String(err)));
      });

      this.ws.on('close', (event) => {
        const duration = Date.now() - connectionStartTime;
        const wasClean = event.code === 1000;
        const reason = event.reason || 'unknown';
        log.info(
          `[${this.config.serverId}] Disconnected - code: ${event.code}, reason: ${reason}, wasClean: ${wasClean}`,
        );
        log.debug(`[${this.config.serverId}] Disconnect duration: ${duration}ms`);
        this.authenticated = false;
        this.stopPing();

        if (!settled) {
          let errorMessage: string;
          const closeCode = event.code ?? 1006;
          if (closeCode === 1008) {
            errorMessage = `Authentication rejected by remote proxy (invalid token). Ensure the token is registered on the remote server.`;
          } else if (closeCode === 1006) {
            errorMessage = `Remote proxy connection lost abruptly. The agent process may have crashed or is not running on port ${port}.`;
          } else {
            errorMessage = `WebSocket disconnected (code: ${closeCode}, reason: ${reason}). The remote process may still be running.`;
          }
          log.error(`[${this.config.serverId}] ${errorMessage}`);
          settle('reject', new Error(errorMessage));
        }

        if (this.activeStreamSessions.size > 0) {
          log.warn(
            `[${this.config.serverId}] WebSocket closed with ${this.activeStreamSessions.size} ` +
              `active stream(s). Rejecting all pending promises.`,
          );
          for (const [sessionId, pending] of Array.from(this.activeStreamSessions.entries())) {
            pending.cleanup();
            pending.reject(
              new Error(
                `WebSocket disconnected (code: ${event.code ?? 1006}) while stream ${sessionId} was active. ` +
                  `The remote process may still be running.`,
              ),
            );
          }
        }

        this.emit('disconnected', { code: event.code, reason });
        this.scheduleReconnect();
      });

      const timeout = setTimeout(() => {
        log.debug(`[${this.config.serverId}] Connection timeout after 30000ms`);
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          log.warn(`[${this.config.serverId}] Closing due to timeout`);
          this.ws.close(1000, 'Connection timeout');
          settle(
            'reject',
            new Error(
              'Connection timeout after 30s — check that the remote agent is running and the SSH tunnel is working.',
            ),
          );
        }
      }, 30000);

      this.ws.once('open', () => {
        clearTimeout(timeout);
        this.startPing();
      });

      this.once('authenticated', () => {
        clearTimeout(timeout);
      });
    });
  }

  private async sendAuthAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const authTimeout = setTimeout(() => {
        reject(new Error('Authentication timed out'));
      }, 5000);

      this.once('authenticated', () => {
        clearTimeout(authTimeout);
        resolve();
      });
      this.once('authFailed', (data: any) => {
        clearTimeout(authTimeout);
        reject(new Error(`Authentication failed: ${data?.message || 'Invalid token'}`));
      });

      this.send({ type: 'auth', payload: { token: this.config.authToken } });
    });
  }

  private handleMessage(data: Buffer): void {
    try {
      const message: ServerMessage = JSON.parse(data.toString());

      if (message.sessionId && this.interruptedSessions.has(message.sessionId)) {
        const blockedTypes = [
          'claude:stream',
          'claude:usage',
          'claude:context-usage',
          'thought',
          'thought:delta',
          'tool:call',
          'tool:delta',
          'tool:result',
          'tool:error',
          'terminal:output',
          'mcp:status',
          'mcp:tool:call',
          'text:block-start',
        ];
        if (blockedTypes.includes(message.type as string)) {
          log.debug(`[${this.config.serverId}] Blocking event for interrupted session ${message.sessionId}: ${message.type}`);
          return;
        }
      }

      switch (message.type) {
        case 'auth:success':
          this.authenticated = true;
          log.info(`[${this.config.serverId}] Authenticated`);
          this.emit('authenticated');
          break;

        case 'auth:failed':
          this.authenticated = false;
          log.error(`[${this.config.serverId}] Authentication failed:`, message.data);
          this.emit('authFailed', message.data);
          this.disconnect();
          break;

        case 'claude:stream':
          this.emit('claude:stream', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'claude:usage':
          this.emit('claude:usage', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'claude:context-usage':
          this.emit('claude:context-usage', { sessionId: message.sessionId, data: message.data });
          break;

        case 'claude:complete':
          this.emit('claude:complete', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'claude:error':
          log.error(`[${this.config.serverId}] Claude error:`, message.data);
          this.emit('claude:error', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'claude:api-warning':
          log.warn(`[${this.config.serverId}] API warning:`, message.data);
          this.emit('claude:api-warning', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'claude:session':
          log.debug(
            `[${this.config.serverId}] Received SDK session_id:`,
            message.data?.sdkSessionId,
          );
          this.emit('claude:session', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'tool:call':
          this.emit('tool:call', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'tool:delta':
          this.emit('tool:delta', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'tool:result':
          this.emit('tool:result', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'tool:error':
          log.error(`[${this.config.serverId}] Tool error:`, message.data);
          this.emit('tool:error', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'terminal:output':
          this.emit('terminal:output', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'thought':
          this.emit('thought', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'thought:delta':
          this.emit('thought:delta', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'stream:alive':
          this.emit('stream:alive', { sessionId: message.sessionId, data: message.data });
          break;

        case 'mcp:status':
          this.emit('mcp:status', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'mcp:tool:call':
          this.emit('mcp:tool:call', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'mcp:tool:response':
          log.debug(`[${this.config.serverId}] Received mcp:tool:response (acknowledged)`);
          break;

        case 'compact:boundary':
          this.emit('compact:boundary', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'text:block-start':
          this.emit('text:block-start', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'fs:result':
          this.emit('fs:result', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'fs:error':
          log.error(`[${this.config.serverId}] FS error:`, message.data);
          this.emit('fs:error', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'pong':
          this.lastPongTime = Date.now();
          break;

        case 'ping':
          // Server-initiated heartbeat ping — respond with pong
          this.send({ type: 'pong' } as any);
          break;

        case 'task:update':
          this.emit('task:update', message.data);
          break;

        case 'task:list':
          this.emit('task:list', message.data);
          break;

        case 'task:get':
          this.emit('task:get', message.data);
          break;

        case 'task:cancel':
          this.emit('task:cancel', message.data);
          break;

        case 'task:spawn':
          this.emit('task:spawn', message.data);
          break;

        case 'worker:started':
          this.emit('worker:started', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'worker:completed':
          this.emit('worker:completed', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'ask:question':
          this.emit('ask:question', { sessionId: message.sessionId, generationId: message.generationId, data: message.data });
          break;

        case 'permission:request':
          this.emit('permission:request', { sessionId: message.sessionId, data: message.data });
          break;

        case 'log':
          this.emit('log', { data: message.data });
          break;

        default:
          log.warn(`[${this.config.serverId}] Unknown message type:`, message.type);
      }
    } catch (error) {
      log.error(`[${this.config.serverId}] Failed to parse message:`, error);
    }
  }

  private send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn(`[${this.config.serverId}] Cannot send message - not connected`);
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      log.debug(`[${this.config.serverId}] Message sent: ${message.type}`);
      return true;
    } catch (error) {
      log.error(`[${this.config.serverId}] Failed to send message:`, error);
      return false;
    }
  }

  sendClaudeMessage(sessionId: string, message: string): boolean {
    return this.send({
      type: 'claude:chat',
      sessionId,
      payload: {
        messages: [{ role: 'user', content: message }],
        stream: true,
      },
    });
  }

  sendChatWithStream(
    sessionId: string,
    messages: any[],
    options: any = {},
  ): Promise<{ content: string; tokenUsage?: any }> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      let fullContent = '';
      let tokenUsage: any = null;
      let isComplete = false;
      const genId = options.generationId;

      const IDLE_TIMEOUT_MS = options.timeoutMs || 60 * 60 * 1000;
      const CHECK_INTERVAL_MS = 60 * 1000;

      let timeoutTimer: NodeJS.Timeout | null = null;
      let lastActivityTime = Date.now();

      // Initial response timeout - prevent hanging if proxy crashes silently
      const INITIAL_TIMEOUT_MS = 30 * 1000;
      let initialTimeoutSettled = false;

      const initialTimeout = setTimeout(() => {
        if (initialTimeoutSettled) return;
        initialTimeoutSettled = true;

        cleanup();
        reject(new Error(
          `Remote proxy not responding after ${INITIAL_TIMEOUT_MS / 1000}s. ` +
          `The agent may have crashed or the connection is blocked.`
        ));
      }, INITIAL_TIMEOUT_MS);

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        clearTimeout(initialTimeout);

        this.off('claude:stream', streamHandler);
        this.off('claude:usage', usageHandler);
        this.off('claude:complete', completeHandler);
        this.off('claude:error', errorHandler);
        this.off('thought', activityHandler);
        this.off('thought:delta', activityHandler);
        this.off('terminal:output', activityHandler);
        this.activeStreamSessions.delete(sessionId);
      };

      const resetTimeout = () => {
        // Clear initial timeout on first activity
        if (!initialTimeoutSettled) {
          clearTimeout(initialTimeout);
          initialTimeoutSettled = true;
        }

        lastActivityTime = Date.now();
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        const checkTimeout = () => {
          const elapsed = Date.now() - lastActivityTime;
          if (elapsed >= IDLE_TIMEOUT_MS && !isComplete) {
            if (timeoutTimer) {
              clearTimeout(timeoutTimer);
              timeoutTimer = null;
            }
            // Emit idle:timeout event instead of immediately rejecting
            // Let the user decide whether to continue waiting or force disconnect
            const doForceDisconnect = () => {
              this.off('claude:stream', streamHandler);
              this.off('claude:usage', usageHandler);
              this.off('claude:complete', completeHandler);
              this.off('claude:error', errorHandler);
              this.off('thought', activityHandler);
              this.off('thought:delta', activityHandler);
              this.off('terminal:output', activityHandler);
              this.off('tool:call', activityHandler);
              this.off('tool:result', activityHandler);
              this.off('stream:alive', activityHandler);
              this.activeStreamSessions.delete(sessionId);
              this.pendingIdleTimeouts.delete(sessionId);
              reject(
                new Error(
                  `Chat timeout - no activity for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes (user forced)`,
                ),
              );
            };
            const doContinueWaiting = () => {
              resetTimeout();
              this.pendingIdleTimeouts.delete(sessionId);
            };
            this.pendingIdleTimeouts.set(sessionId, {
              continueWaiting: doContinueWaiting,
              forceDisconnect: doForceDisconnect,
            });
            this.emit('idle:timeout', {
              sessionId,
              idleMinutes: Math.round(IDLE_TIMEOUT_MS / 60000),
            });
          } else if (!isComplete) {
            timeoutTimer = setTimeout(checkTimeout, CHECK_INTERVAL_MS);
          }
        };
        timeoutTimer = setTimeout(checkTimeout, CHECK_INTERVAL_MS);
      };

      const matchesGeneration = (data: any) => {
        if (data.sessionId !== sessionId) return false;
        // Old server doesn't echo generationId — accept for backward compat
        if (data.generationId === undefined) return true;
        // Client didn't request generationId — accept all
        if (!genId) return true;
        return data.generationId === genId;
      };

      const streamHandler = (data: any) => {
        if (matchesGeneration(data)) {
          resetTimeout();
          const text = data.data?.text || data.data?.content || '';
          chunks.push(text);
          fullContent = chunks.join('');
          this.emit('stream', { sessionId, generationId: genId, content: fullContent, delta: text });
        }
      };

      const usageHandler = (data: any) => {
        if (matchesGeneration(data)) {
          resetTimeout();
          tokenUsage = data.data;
          log.debug(`[${this.config.serverId}] Received token usage:`, tokenUsage);
        }
      };

      const completeHandler = (data: any) => {
        if (matchesGeneration(data)) {
          isComplete = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          this.off('claude:stream', streamHandler);
          this.off('claude:usage', usageHandler);
          this.off('claude:complete', completeHandler);
          this.off('claude:error', errorHandler);
          this.off('thought', activityHandler);
          this.off('thought:delta', activityHandler);
          this.off('terminal:output', activityHandler);
          this.off('tool:call', activityHandler);
          this.off('tool:result', activityHandler);
          this.off('stream:alive', activityHandler);
          this.activeStreamSessions.delete(sessionId);
          this.pendingIdleTimeouts.delete(sessionId);
          resolve({ content: fullContent, tokenUsage });
        }
      };

      const errorHandler = (data: any) => {
        if (matchesGeneration(data)) {
          isComplete = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          this.off('claude:stream', streamHandler);
          this.off('claude:usage', usageHandler);
          this.off('claude:complete', completeHandler);
          this.off('claude:error', errorHandler);
          this.off('thought', activityHandler);
          this.off('thought:delta', activityHandler);
          this.off('terminal:output', activityHandler);
          this.off('tool:call', activityHandler);
          this.off('tool:result', activityHandler);
          this.off('stream:alive', activityHandler);
          this.activeStreamSessions.delete(sessionId);
          this.pendingIdleTimeouts.delete(sessionId);
          reject(new Error(data.data?.error || 'Chat failed'));
        }
      };

      const activityHandler = (data: any) => {
        if (matchesGeneration(data)) {
          resetTimeout();
          if (data.type === 'stream:alive') {
            this.emit('stream:alive', data);
          }
        }
      };

      this.on('claude:stream', streamHandler);
      this.on('claude:usage', usageHandler);
      this.on('claude:complete', completeHandler);
      this.on('claude:error', errorHandler);
      this.on('thought', activityHandler);
      this.on('thought:delta', activityHandler);
      this.on('terminal:output', activityHandler);
      this.on('tool:call', activityHandler);
      this.on('tool:result', activityHandler);
      this.on('stream:alive', activityHandler);

      this.activeStreamSessions.set(sessionId, { resolve, reject, cleanup });
      this.interruptedSessions.delete(sessionId);

      const sent = this.send({
        type: 'claude:chat',
        sessionId,
        payload: {
          generationId: genId,
          messages,
          options: { ...options, stream: true },
        },
      });

      if (!sent) {
        cleanup();
        reject(new Error('Failed to send chat request'));
        return;
      }

      resetTimeout();
    });
  }

  continueIdleTimeout(sessionId: string): void {
    const pending = this.pendingIdleTimeouts.get(sessionId);
    if (pending) {
      pending.continueWaiting();
    }
  }

  forceIdleTimeoutDisconnect(sessionId: string): void {
    const pending = this.pendingIdleTimeouts.get(sessionId);
    if (pending) {
      pending.forceDisconnect();
    }
  }

  listFs(path?: string): boolean {
    return this.send({ type: 'fs:list', payload: { path } });
  }

  readFile(path: string): boolean {
    return this.send({ type: 'fs:read', payload: { path } });
  }

  writeFile(path: string, content: string): boolean {
    return this.send({ type: 'fs:write', payload: { path, content } });
  }

  deleteFile(path: string): boolean {
    return this.send({ type: 'fs:delete', payload: { path } });
  }

  uploadFile(path: string, content: Buffer): boolean {
    return this.send({
      type: 'fs:upload',
      payload: { path, content: content.toString('base64') },
    });
  }

  downloadFile(path: string): boolean {
    return this.send({ type: 'fs:download', payload: { path } });
  }

  /**
   * Check if a path exists on the remote server and whether it's a directory.
   * Does NOT require an SDK session — uses session-less fs:stat.
   */
  statPath(path: string): Promise<{ exists: boolean; isDirectory: boolean; error?: string }> {
    return this.enqueueSessionlessFsRequest(
      () =>
        new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('fs:result', handler);
        reject(new Error('fs:stat request timed out (10s)'));
      }, 10_000);

      // fs:result event emits { sessionId, data } wrapper
      const handler = (wrapped: any) => {
        clearTimeout(timeout);
        this.off('fs:result', handler);
        resolve(wrapped.data);
      };

      this.once('fs:result', handler);
      if (!this.send({ type: 'fs:stat', payload: { path } })) {
        clearTimeout(timeout);
        this.off('fs:result', handler);
        reject(new Error('Failed to send fs:stat request'));
      }
        }),
    );
  }

  /**
   * Create a directory on the remote server (recursive).
   * Does NOT require an SDK session — uses session-less fs:mkdir.
   */
  mkdir(path: string): Promise<{ success: boolean; error?: string }> {
    return this.enqueueSessionlessFsRequest(
      () =>
        new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('fs:result', handler);
        reject(new Error('fs:mkdir request timed out (10s)'));
      }, 10_000);

      // fs:result event emits { sessionId, data } wrapper
      const handler = (wrapped: any) => {
        clearTimeout(timeout);
        this.off('fs:result', handler);
        resolve(wrapped.data);
      };

      this.once('fs:result', handler);
      if (!this.send({ type: 'fs:mkdir', payload: { path } })) {
        clearTimeout(timeout);
        this.off('fs:result', handler);
        reject(new Error('Failed to send fs:mkdir request'));
      }
        }),
    );
  }

  private enqueueSessionlessFsRequest<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const GLOBAL_TIMEOUT_MS = 15 * 1000; // 15 秒全局超时
      let globalTimeout: NodeJS.Timeout | null = null;

      const run = () => {
        this.sessionlessFsBusy = true;
        if (globalTimeout) clearTimeout(globalTimeout);
        operation()
          .then(resolve, reject)
          .finally(() => {
            const next = this.sessionlessFsQueue.shift();
            if (next) {
              next();
            } else {
              this.sessionlessFsBusy = false;
            }
          });
      };

      // 设置全局超时
      globalTimeout = setTimeout(() => {
        if (!this.sessionlessFsBusy) {
          // 如果还没开始执行，直接 reject
          reject(new Error('Sessionless FS request queue timed out (15s)'));
          return;
        }
        // 如果正在执行，已过超时时间，无需额外操作（单个请求已有 10s 超时）
      }, GLOBAL_TIMEOUT_MS);

      if (this.sessionlessFsBusy) {
        this.sessionlessFsQueue.push(run);
      } else {
        run();
      }
    });
  }

  approveToolCall(sessionId: string, toolId: string, result?: string): boolean {
    const payload: any = { toolId };
    if (result !== undefined) {
      payload.result = result;
    }
    return this.send({ type: 'tool:approve', sessionId, payload });
  }

  rejectToolCall(sessionId: string, toolId: string, reason?: string): boolean {
    return this.send({ type: 'tool:reject', sessionId, payload: { toolId, reason } });
  }

  registerMcpTools(
    tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, any>;
      serverName: string;
    }>,
    capabilities: { aiBrowser: boolean; ghSearch: boolean; version?: number },
  ): boolean {
    const sent = this.send({
      type: 'mcp:tools:register',
      payload: { tools, capabilities },
    });
    if (sent) {
      this._mcpToolsRegistered = true;
    }
    return sent;
  }

  sendMcpToolResult(sessionId: string, callId: string, result: any): boolean {
    return this.send({
      type: 'mcp:tool:response',
      sessionId,
      payload: { callId, toolResult: result },
    });
  }

  sendMcpToolError(sessionId: string, callId: string, error: string): boolean {
    return this.send({
      type: 'mcp:tool:error',
      sessionId,
      payload: { callId, toolError: error },
    });
  }

  listTasks(): boolean {
    return this.send({ type: 'task:list', payload: {} });
  }

  cancelTask(taskId: string): boolean {
    return this.send({ type: 'task:cancel', payload: { id: taskId } });
  }

  spawnTask(command: string, cwd?: string): boolean {
    return this.send({ type: 'task:spawn', payload: { command, cwd } });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      log.debug(`[${this.config.serverId}] Skipping reconnect - intentional disconnect`);
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.warn(`[${this.config.serverId}] Max reconnection attempts reached`);
      this.emit('reconnectFailed');
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    log.debug(
      `[${this.config.serverId}] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect().catch((err) => {
        log.error(`[${this.config.serverId}] Reconnect failed:`, err);
      });
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.lastPongTime = Date.now();
    this.pingTimer = setInterval(() => {
      if (this.lastPongTime && Date.now() - this.lastPongTime > this.pongTimeoutMs) {
        log.warn(
          `[${this.config.serverId}] Pong timeout (${this.pongTimeoutMs / 1000}s) — ` +
            `server is not responding. Closing connection.`,
        );
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(4001, 'Pong timeout — server unresponsive');
        }
        return;
      }
      this.send({ type: 'ping' });
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.authenticated;
  }

  isReconnecting(): boolean {
    return this.reconnectTimer !== null;
  }

  waitForReconnect(timeoutMs: number = 15000): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.isConnected()) {
        resolve(true);
        return;
      }
      if (!this.reconnectTimer) {
        resolve(false);
        return;
      }

      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onAuthenticated = () => {
        cleanup();
        resolve(true);
      };

      const onReconnectFailed = () => {
        cleanup();
        resolve(false);
      };

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        this.off('authenticated', onAuthenticated);
        this.off('reconnectFailed', onReconnectFailed);
      };

      this.once('authenticated', onAuthenticated);
      this.once('reconnectFailed', onReconnectFailed);
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.cancelReconnect();
    this.stopPing();

    if (this.ws) {
      log.debug(`[${this.config.serverId}] Disconnecting`);
      this.ws.close();
      this.ws = null;
    }

    this.emit('close');
  }

  async interrupt(sessionId: string): Promise<boolean> {
    log.info(`[${this.config.serverId}] Interrupt requested for session: ${sessionId}`);

    const sendMessages = async () => {
      if (this.isConnected()) {
        try {
          const interruptMessage = { type: 'claude:interrupt', sessionId };
          this.ws!.send(JSON.stringify(interruptMessage));
          log.debug(`[${this.config.serverId}] Interrupt message sent to remote server`);

          // Don't send close:session — keep the SDK session alive on the server
          // so the next message can reuse it and preserve conversation context.
          return true;
        } catch (error) {
          log.error(`[${this.config.serverId}] Failed to send messages:`, error);
        }
      }
      return false;
    };

    const sent = await sendMessages();

    if (!sent) {
      log.debug(
        `[${this.config.serverId}] Not connected, attempting quick reconnect to send interrupt...`,
      );
      const previousShouldReconnect = this.shouldReconnect;
      this.shouldReconnect = true;

      let reconnected = false;
      try {
        const connected = await Promise.race<boolean>([
          this.connect().then(() => true).catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        reconnected = connected && this.isConnected();
        if (!reconnected && this.isReconnecting()) {
          reconnected = await this.waitForReconnect(5000);
        }
      } finally {
        this.shouldReconnect = previousShouldReconnect;
      }

      if (reconnected && (await sendMessages())) {
        log.debug(`[${this.config.serverId}] Messages sent after reconnect`);
      } else {
        log.warn(
          `[${this.config.serverId}] Reconnect failed, could not send interrupt to remote server`,
        );
      }
    }

    log.debug(`[${this.config.serverId}] Waiting 300ms for queued events to process...`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    this.interruptedSessions.add(sessionId);
    log.debug(`[${this.config.serverId}] Session ${sessionId} marked as interrupted`);

    const target = this.activeStreamSessions.get(sessionId);
    if (target) {
      log.debug(`[${this.config.serverId}] Rejecting active stream for session: ${sessionId}`);
      target.cleanup();
      target.reject(new Error('Interrupted by user'));
    }

    return true;
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }
}

// ============================================
// Client Manager
// ============================================

const activeClients = new Map<string, RemoteWsClient>();
const clientSessionIds = new Map<RemoteWsClient, Set<string>>();
const clientCloseHandlers = new Map<RemoteWsClient, () => void>();

export function registerActiveClient(sessionId: string, client: RemoteWsClient): void {
  activeClients.set(sessionId, client);
  let sessionIds = clientSessionIds.get(client);
  if (!sessionIds) {
    sessionIds = new Set();
    clientSessionIds.set(client, sessionIds);
  }
  sessionIds.add(sessionId);

  if (!clientCloseHandlers.has(client)) {
    const closeHandler = () => {
      const ids = clientSessionIds.get(client);
      if (ids) {
        for (const id of ids) {
          activeClients.delete(id);
          log.info(`Unregistered client for session: ${id}`);
        }
      }
      clientSessionIds.delete(client);
      clientCloseHandlers.delete(client);
    };
    clientCloseHandlers.set(client, closeHandler);
    client.once('close', closeHandler);
  }

  log.info(`Registered active client for session: ${sessionId}`);
}

export function getRemoteWsClient(sessionId: string): RemoteWsClient | undefined {
  return activeClients.get(sessionId);
}

export function unregisterActiveClient(sessionId: string): void {
  const client = activeClients.get(sessionId);
  activeClients.delete(sessionId);
  if (client) {
    const sessionIds = clientSessionIds.get(client);
    if (sessionIds) {
      sessionIds.delete(sessionId);
      if (sessionIds.size === 0) {
        clientSessionIds.delete(client);
        const closeHandler = clientCloseHandlers.get(client);
        if (closeHandler) {
          client.off('close', closeHandler);
          clientCloseHandlers.delete(client);
        }
      }
    }
  }
  log.info(`Unregistered client for session: ${sessionId}`);
}

export function disconnectAllClients(): void {
  const uniqueClients = new Set(activeClients.values());
  activeClients.clear();
  clientSessionIds.clear();
  for (const [client, closeHandler] of Array.from(clientCloseHandlers.entries())) {
    client.off('close', closeHandler);
  }
  clientCloseHandlers.clear();

  for (const client of Array.from(uniqueClients)) {
    client.disconnect();
  }
  disconnectAllPooledConnections();
  log.info('All active clients and pooled connections disconnected');
}
