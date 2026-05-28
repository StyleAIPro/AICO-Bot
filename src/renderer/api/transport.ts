/**
 * Transport Layer - Abstracts IPC vs HTTP communication
 * Automatically selects the appropriate transport based on environment
 */

// Detect if running in Electron (has window.aicoBot via preload)
export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'aicoBot' in window;
}

// Detect if running as remote web client
export function isRemoteClient(): boolean {
  return !isElectron();
}

// Get the remote server URL (for remote clients)
export function getRemoteServerUrl(): string {
  // In remote mode, use the current origin
  return window.location.origin;
}

// Get stored auth token
export function getAuthToken(): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('aico_bot_remote_token');
  }
  return null;
}

// Set auth token
export function setAuthToken(token: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('aico_bot_remote_token', token);
  }
}

// Clear auth token
export function clearAuthToken(): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.removeItem('aico_bot_remote_token');
  }
  return null;
}

/**
 * HTTP Transport - Makes API calls to remote server
 */
export async function httpRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ success: boolean; data?: T; error?: string }> {
  const token = getAuthToken();
  const url = `${getRemoteServerUrl()}${path}`;

  console.log(`[HTTP] ${method} ${path} - token: ${token ? 'present' : 'missing'}`);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Handle 401 - token expired or invalid, redirect to login
    if (response.status === 401) {
      console.warn(
        `[HTTP] ${method} ${path} - 401 Unauthorized, clearing token and redirecting to login`,
      );
      clearAuthToken();
      // Clear the auth cookie
      document.cookie = 'aico_bot_authenticated=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      // Reload page - server will show login page
      window.location.reload();
      return { success: false, error: 'Token expired, please login again' };
    }

    const data = await response.json();
    console.log(`[HTTP] ${method} ${path} - status: ${response.status}, success: ${data.success}`);

    if (!response.ok) {
      console.warn(`[HTTP] ${method} ${path} - error:`, data.error);
    }

    return data;
  } catch (error) {
    console.error(`[HTTP] ${method} ${path} - exception:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

/**
 * WebSocket connection for real-time events (remote mode)
 */
let wsConnection: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const wsEventListeners = new Map<string, Set<(data: unknown) => void>>();

// Pending subscribe acknowledgments: conversationId -> { resolve, timer }
const pendingSubscribeAcks = new Map<
  string,
  {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

// Timeout for subscribe acknowledgment (ms)
const SUBSCRIBE_ACK_TIMEOUT_MS = 3000;

export function connectWebSocket(): void {
  if (!isRemoteClient()) return;
  if (wsConnection?.readyState === WebSocket.OPEN) return;

  const token = getAuthToken();
  if (!token) {
    console.warn('[WS] No auth token, cannot connect');
    return;
  }

  const wsUrl = `${getRemoteServerUrl().replace('http', 'ws')}/ws`;
  console.log('[WS] Connecting to:', wsUrl);

  wsConnection = new WebSocket(wsUrl);

  wsConnection.onopen = () => {
    console.log('[WS] Connected');
    // Authenticate
    wsConnection?.send(JSON.stringify({ type: 'auth', payload: { token } }));
  };

  wsConnection.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);

      if (message.type === 'auth:success') {
        console.log('[WS] Authenticated');
        return;
      }

      if (message.type === 'subscribe:success') {
        const conversationId = message.payload?.conversationId;
        console.log(`[WS] Subscribe ack received for ${conversationId}`);
        const pending = pendingSubscribeAcks.get(conversationId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve();
          pendingSubscribeAcks.delete(conversationId);
        }
        return;
      }

      if (message.type === 'event') {
        // Dispatch to registered listeners
        const listeners = wsEventListeners.get(message.channel);
        if (listeners) {
          for (const callback of listeners) {
            callback(message.data);
          }
        }
      }
    } catch (error) {
      console.error('[WS] Failed to parse message:', error);
    }
  };

  wsConnection.onclose = () => {
    console.log('[WS] Disconnected');
    wsConnection = null;

    // Clean up any pending subscribe acks so callers don't hang
    for (const [, pending] of pendingSubscribeAcks) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    pendingSubscribeAcks.clear();

    // Attempt to reconnect after 3 seconds
    if (isRemoteClient() && getAuthToken()) {
      wsReconnectTimer = setTimeout(connectWebSocket, 3000);
    }
  };

  wsConnection.onerror = (error) => {
    console.error('[WS] Error:', error);
  };
}

export function disconnectWebSocket(): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  // Clean up pending subscribe acks
  for (const [, pending] of pendingSubscribeAcks) {
    clearTimeout(pending.timer);
    pending.resolve();
  }
  pendingSubscribeAcks.clear();

  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }
}

/**
 * Subscribe to conversation events and wait for server acknowledgment.
 * Returns a Promise that resolves when the server confirms the subscription,
 * or after SUBSCRIBE_ACK_TIMEOUT_MS if the ack never arrives (safety net).
 *
 * If called multiple times for the same conversationId before ack arrives,
 * the second call piggybacks on the first pending ack (both callers resolve).
 */
export function subscribeToConversation(conversationId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // Already waiting for ack on this conversation — piggyback on the existing ack.
    // Still send a new subscribe frame to ensure the server has it (the previous
    // frame may still be in the TCP buffer and not processed yet).
    if (pendingSubscribeAcks.has(conversationId)) {
      const existing = pendingSubscribeAcks.get(conversationId)!;
      const originalResolve = existing.resolve;
      // When the ack arrives, resolve both callers
      existing.resolve = () => {
        originalResolve();
        resolve();
      };
      // Re-send subscribe frame to guarantee server-side registration
      if (wsConnection?.readyState === WebSocket.OPEN) {
        wsConnection.send(
          JSON.stringify({
            type: 'subscribe',
            payload: { conversationId },
          }),
        );
      }
      return;
    }

    // If WebSocket is not connected, resolve immediately
    // (will re-subscribe on reconnect via selectConversation)
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
      resolve();
      return;
    }

    // Set up timeout fallback — proceed even if ack never arrives
    const timer = setTimeout(() => {
      console.warn(`[WS] Subscribe ack timeout for ${conversationId}, proceeding anyway`);
      pendingSubscribeAcks.delete(conversationId);
      resolve();
    }, SUBSCRIBE_ACK_TIMEOUT_MS);

    pendingSubscribeAcks.set(conversationId, { resolve, timer });

    wsConnection.send(
      JSON.stringify({
        type: 'subscribe',
        payload: { conversationId },
      }),
    );
  });
}

export function unsubscribeFromConversation(conversationId: string): void {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: 'unsubscribe',
        payload: { conversationId },
      }),
    );
  }
}

/**
 * Register event listener (works for both IPC and WebSocket)
 */
export function onEvent(channel: string, callback: (data: unknown) => void): () => void {
  if (isElectron()) {
    // Use IPC in Electron
    const methodMap: Record<string, keyof typeof window.aicoBot> = {
      'agent:message': 'onAgentMessage',
      'agent:tool-call': 'onAgentToolCall',
      'agent:tool-result': 'onAgentToolResult',
      'agent:error': 'onAgentError',
      'agent:complete': 'onAgentComplete',
      'agent:thought': 'onAgentThought',
      'agent:thought-delta': 'onAgentThoughtDelta',
      'agent:mcp-status': 'onAgentMcpStatus',
      'agent:compact': 'onAgentCompact',
      'agent:context-usage': 'onAgentContextUsage',
      'agent:stream-alive': 'onAgentStreamAlive',
      'agent:idle-timeout': 'onAgentIdleTimeout',
      'agent:ask-question': 'onAgentAskQuestion',
      'agent:permission-request': 'onAgentPermissionRequest',
      'agent:turn-boundary': 'onAgentTurnBoundary',
      'agent:injection-start': 'onAgentInjectionStart',
      'remote:status-change': 'onRemoteStatusChange',
      'browser:state-change': 'onBrowserStateChange',
      'browser:all-views-hidden': 'onBrowserAllViewsHidden',
      'browser:zoom-changed': 'onBrowserZoomChanged',
      'canvas:tab-action': 'onCanvasTabAction',
      'ai-browser:active-view-changed': 'onAIBrowserActiveViewChanged',
      'artifact:tree-update': 'onArtifactTreeUpdate',
      'app:status_changed': 'onAppStatusChanged',
      'app:activity_entry:new': 'onAppActivityEntry',
      'app:escalation:new': 'onAppEscalation',
      'app:navigate': 'onAppNavigate',
      'notification:toast': 'onNotificationToast',
      // Terminal agent command events
      'terminal:agent-command-start': 'onTerminalAgentCommandStart',
      'terminal:agent-command-output': 'onTerminalAgentCommandOutput',
      'terminal:agent-command-complete': 'onTerminalAgentCommandComplete',
      'worker:started': 'onWorkerStarted',
      'worker:completed': 'onWorkerCompleted',
      'remote-server:command-output': 'onRemoteServerCommandOutput',
      'remote-server:status-change': 'onRemoteServerStatusChange',
      'remote-server:deploy-progress': 'onRemoteServerDeployProgress',
      'remote-server:update-complete': 'onRemoteServerUpdateComplete',
      'skill:market:fetch-progress': 'onSkillMarketFetchProgress',
    };

    const method = methodMap[channel];
    if (method && typeof window.aicoBot[method] === 'function') {
      return (window.aicoBot[method] as (cb: (data: unknown) => void) => () => void)(callback);
    }

    return () => {};
  } else {
    // Use WebSocket in remote mode
    if (!wsEventListeners.has(channel)) {
      wsEventListeners.set(channel, new Set());
    }
    wsEventListeners.get(channel)!.add(callback);

    return () => {
      wsEventListeners.get(channel)?.delete(callback);
    };
  }
}
