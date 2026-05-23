/**
 * Agent Module - Remote Send Message
 *
 * Remote message execution logic including:
 * - WebSocket connection to remote-agent-proxy
 * - SSH tunnel establishment
 * - MCP Bridge setup for remote tool calls
 * - Full streaming response handling
 * - Session persistence and resumption
 */

import type { BrowserWindow } from 'electron';
import { getConfig } from '../config.service';
import {
  getConversation,
  saveSessionId,
  addMessage,
  updateLastMessage,
} from '../conversation.service';
import { getRemoteDeployService } from '../../ipc/remote-server';
import {
  type RemoteWsClientConfig,
  registerActiveClient,
  unregisterActiveClient,
  acquireConnection,
  releaseConnection,
} from '../remote/ws/remote-ws-client';
import {
  type FileChangesSummary,
  extractFileChangesSummaryFromThoughts,
} from '../../../shared/file-changes';
import { decryptString } from '../auth/secure-storage.service';
import sshTunnelService from '../remote/ssh/ssh-tunnel.service';
import type { AgentRequest } from './types';
import {
  sendToRenderer,
} from './helpers';
import { createLogger } from '../log';
import {
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
} from './session-manager';
import { AicoBotMcpBridge } from '../remote/ws/aico-bot-mcp-bridge';
import { terminalGateway } from '../terminal/terminal-gateway';
import { SkillManager } from '../skill/skill-manager';

const log = createLogger('agent:remote');

/**
 * Execute remote message (via WebSocket to remote-agent-proxy)
 *
 * Features:
 * - Full message history for multi-turn conversations
 * - Session persistence and resumption
 * - Tool calls with approval flow
 * - Terminal output streaming
 * - Image attachments support
 */
export async function executeRemoteMessage(
  mainWindow: BrowserWindow | null,
  request: AgentRequest,
  serverId: string,
  remotePath: string,
  useSshTunnel?: boolean, // Use SSH port forwarding (localhost:8080) instead of direct connection
  systemPrompt?: string, // Custom system prompt for the space
): Promise<void> {
  log.debug(' ===== FUNCTION START =====');
  log.debug(' serverId=', serverId, 'remotePath=', remotePath, 'useSshTunnel=', useSshTunnel);
  const deployService = getRemoteDeployService();
  const server = deployService.getServer(serverId);

  if (!server) {
    throw new Error(`Remote server not found: ${serverId}`);
  }

  if (server.status !== 'connected') {
    throw new Error(`Remote server is not connected: ${server.name}`);
  }

  const {
    spaceId,
    conversationId,
    message,
    images,
    thinkingEnabled,
    aiBrowserEnabled,
    resumeSessionId,
  } = request;

  log.info(
    `Executing on server: ${serverId}, path: ${remotePath}, useSshTunnel=${useSshTunnel}, message: ${message.substring(0, 50)}...`,
  );

  // Get API key and model config
  // Server card credentials (claudeApiKey/claudeBaseUrl/claudeModel) are redundant when
  // aiSourceId is not set — they become stale after global AI source switches and silently
  // override the current config. Always resolve from AI source directly.
  const config = getConfig();
  const sourceId = server.aiSourceId || config.aiSources?.currentId;
  const currentSource = sourceId
    ? config.aiSources?.sources?.find((s) => s.id === sourceId)
    : undefined;
  const apiKeyRaw = currentSource?.apiKey || config.api?.apiKey;
  const apiKey = apiKeyRaw ? decryptString(apiKeyRaw) : undefined;
  const baseUrl = currentSource?.apiUrl;
  const model =
    currentSource?.model || config.api?.model || 'claude-sonnet-4-6';
  log.info(`Using model: ${model}`);

  // Get conversation for message history and session ID
  const conversation = getConversation(spaceId, conversationId);

  // Add user message to conversation (with images if provided)
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images || [],
  });

  // Add assistant placeholder for streaming response
  addMessage(spaceId, conversationId, {
    role: 'assistant',
    content: '',
    toolCalls: [],
  });

  // CRITICAL: sessionState must be declared here (before try block) so it's accessible in catch block
  // It will be initialized inside the try block after abortController is created
  let sessionState: { thoughts: any[]; streamingContent?: string; isRemote?: boolean } | undefined;

  // SDK session IDs — declared before try so they're accessible in catch for saving on interrupt.
  let sdkSessionId: string | undefined;
  const resumeOrConversationSessionId = resumeSessionId || getConversation(spaceId, conversationId)?.sessionId;

  // CRITICAL: Declare these variables before try block so they're accessible in catch block
  // These need to be accessible in catch block for content persistence on abort
  let streamingContent = '';
  const streamChunks: string[] = [];
  const thoughts: any[] = [];
  const terminalOutputs: any[] = [];
  const toolCalls: any[] = [];
  const eventCleanups: Array<() => void> = []; // Event handler cleanup for pooled connections

  // WebSocket MCP Bridge — initialized early so it's accessible in catch block for cleanup
  let mcpBridge: AicoBotMcpBridge | null = null;

  // Generation ID — unique per message turn, used to filter events on shared WebSocket.
  // Without this, events from previous turns' handlers leak into the current turn
  // because all turns share the same sessionId (= conversationId) on the pooled connection.
  const generationId = `gen-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  log.info(`[${conversationId}] Generation ID: ${generationId}`);

  // Event match helpers.
  //
  // Remote event routing has two separate concerns:
  // 1. Session routing: does this event belong to the current conversation?
  // 2. Turn routing: does this event belong to the current generation/stream turn?
  //
  // generationId is still necessary for data-plane stream isolation because a pooled
  // WebSocket can carry late events from the previous turn on the same conversation.
  // However, control-plane events such as AskUserQuestion must not depend on an exact
  // generationId match — they are resolved by their own stable ids on the proxy.
  //
  // Uses a getter-like closure to avoid referencing effectiveSessionId before it is assigned.
  let effectiveSessionId: string;
  const matchesSession = (data: any) => data.sessionId === effectiveSessionId;
  const matchesTurn = (data: any) =>
    matchesSession(data) &&
    (data.generationId === undefined || data.generationId === generationId);

  try {
    // ── Phase 1: SSH tunnel establishment ──

    // SSH tunnel establishment (only if required)
    const sshTunnelPromise = (async (): Promise<number> => {
      let tunnelPort = server.assignedPort;
      if (useSshTunnel) {
        log.info(`Establishing SSH tunnel to ${server.host}:${server.assignedPort}...`);
        const decryptedPassword = decryptString(server.password || '');
        tunnelPort = await sshTunnelService.establishTunnel({
          spaceId,
          serverId,
          host: server.host,
          port: server.sshPort || 22,
          username: server.username,
          password: decryptedPassword,
          localPort: server.assignedPort,
          remotePort: server.assignedPort,
        });
        log.info(`SSH tunnel established on local port ${tunnelPort}`);
      }
      return tunnelPort;
    })().catch((err: Error) => {
      log.error('Failed to establish SSH tunnel:', err);
      throw new Error(`SSH tunnel failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    const localTunnelPort = await sshTunnelPromise;

    // Additional variables for SDK session management
    // sdkSessionId is declared before try block (for catch access)
    // CRITICAL: effectiveSessionId always equals conversationId for consistent session
    // lookup on remote server. sdkSessionId (SDK's internal session ID) is only used
    // for the --resume parameter. This prevents session key mismatch across turns.
    effectiveSessionId = conversationId;

    // ── Phase 2: Agent check/start + WebSocket connection (both depend on tunnel, independent of each other) ──

    // Helper: check remote agent is running (no auto-start)
    const checkAndStartAgent = async (): Promise<void> => {
      log.info(`Checking if remote agent is running...`);
      const isAgentRunning = await checkRemoteAgentRunning(serverId);
      log.debug(`Agent running status:`, isAgentRunning);

      if (!isAgentRunning) {
        throw new Error(
          `Remote agent proxy is not running on server "${server.name || serverId}". Please deploy and start the agent first.`,
        );
      }
      log.info(`Agent is already running`);
    };

    // Build WebSocket config (depends only on tunnel port, already available)
    const wsConfig: RemoteWsClientConfig = {
      serverId,
      host: useSshTunnel ? 'localhost' : server.host,
      port: useSshTunnel ? localTunnelPort : server.assignedPort,
      authToken: server.authToken || '',
      useSshTunnel,
      apiKey: apiKey || undefined,
      baseUrl: currentSource?.apiUrl || undefined,
      model: model || undefined,
    };
    log.info(`Creating WebSocket client with config:`, {
      useSshTunnel: wsConfig.useSshTunnel,
      host: wsConfig.host,
      port: wsConfig.port,
    });

    // sessionId is the SDK session ID for resumption (if available from a previous turn)
    const sessionId = resumeOrConversationSessionId;

    // OPTIMIZATION: Run agent check and WebSocket connection in parallel.
    // Both only depend on the SSH tunnel being ready — they don't depend on each other.
    // acquireConnection just establishes the WebSocket to proxy; actual chat messages
    // are sent after both tasks complete.
    const [_, client] = await Promise.all([
      checkAndStartAgent(),
      acquireConnection(serverId, wsConfig, conversationId),
    ]);

    // Register this client for interrupt support
    // CRITICAL: Use conversationId (not effectiveSessionId) for consistent lookup in stopGeneration
    // This ensures the client can be found regardless of session resumption
    registerActiveClient(conversationId, client);

    // CRITICAL: Also register to activeSessions so stopGeneration can find this remote session
    // Without this, stopGeneration would skip the remote interrupt logic (it's inside if(session) block)
    const abortController = new AbortController();
    sessionState = createSessionState(spaceId, conversationId, abortController);
    sessionState.isRemote = true; // Mark this as a remote session
    sessionState.thoughts = thoughts; // Share reference (avoid array copies on every thought event)
    registerActiveSession(conversationId, sessionState);
    log.info(`Registered remote session to activeSessions for: ${conversationId}`);

    // ============================================
    // WebSocket MCP Bridge Setup
    // Register local MCP tools so remote Claude can call them
    // ============================================
    mcpBridge = new AicoBotMcpBridge();
    const mcpToolDefs = mcpBridge.collectTools(spaceId, !!aiBrowserEnabled);
    const mcpCapabilities = mcpBridge.getCapabilities();
    log.debug(
      `MCP Bridge: ${mcpToolDefs.length} tools, capabilities: ${JSON.stringify(mcpCapabilities)}`,
    );

    // Event handler cleanup - required for pooled connections to prevent stale handlers
    const addHandler = (event: string, handler: (...args: any[]) => void) => {
      client.on(event, handler);
      eventCleanups.push(() => client.off(event, handler));
    };

    // Control-plane dedupe guards.
    // These events are resolved by stable ids on the proxy/client path and should not
    // be executed twice if the same frame is replayed or observed across reconnects.
    const handledMcpToolCallIds = new Set<string>();
    const handledQuestionIds = new Set<string>();

    // Handle incoming MCP tool calls from remote proxy
    addHandler('mcp:tool:call', async (data) => {
      // MCP tool calls are control-plane events. Route by session and dedupe by callId.
      // A strict generationId match can incorrectly drop them and deadlock the remote
      // SDK waiting for a tool response. We still log generation mismatch for diagnosis.
      if (!matchesSession(data)) {
        return;
      }
      const { callId, toolName, arguments: toolArgs } = data.data;
      if (!callId) {
        log.warn(`MCP tool call missing callId for tool=${toolName || 'unknown'}`);
        return;
      }
      if (handledMcpToolCallIds.has(callId)) {
        log.debug(`Ignoring duplicate MCP tool call: ${toolName} (callId=${callId})`);
        return;
      }
      handledMcpToolCallIds.add(callId);
      if (data.generationId && data.generationId !== generationId) {
        log.warn(
          `MCP tool call generation mismatch accepted: expected=${generationId}, actual=${data.generationId}, callId=${callId}, tool=${toolName}`,
        );
      }
      log.debug(`MCP tool call received: ${toolName} (callId=${callId})`);
      try {
        const result = await mcpBridge.handleToolCall(toolName, toolArgs);
        client.sendMcpToolResult(effectiveSessionId, callId, result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`MCP tool call error (${toolName}):`, errorMessage);
        client.sendMcpToolError(effectiveSessionId, callId, errorMessage);
      }
    });

    // Register event handlers for streaming response
    // Variables already declared above

    // SDK session ID event - capture for session resumption
    addHandler('claude:session', (data) => {
      if (matchesTurn(data)) {
        const receivedSdkSessionId = data.data?.sdkSessionId;
        if (receivedSdkSessionId) {
          sdkSessionId = receivedSdkSessionId;
          log.debug(`Captured SDK session_id: ${sdkSessionId}`);
        }
      }
    });

    // Tool call events - format matches frontend ToolCall interface
    // Track pending Bash commands (toolId -> commandId) for remote agent
    const remoteToolCommands = new Map<string, string>();
    // Track active commandId for terminal output streaming (only one Bash command runs at a time)
    let activeBashCommandId: string | null = null;
    // Accumulate terminal output for each commandId (to be used when tool:result arrives)
    const commandOutputBuffer = new Map<string, string>();

    // Helper function to get accumulated output for a command
    const getCommandOutput = (commandId: string): string => {
      return commandOutputBuffer.get(commandId) || '';
    };

    // Helper function to accumulate output for a command
    const accumulateCommandOutput = (commandId: string, output: string) => {
      const existing = commandOutputBuffer.get(commandId) || '';
      commandOutputBuffer.set(commandId, existing + output);
    };

    addHandler('tool:call', (data) => {
      if (matchesTurn(data)) {
        const toolData = data.data;
        log.debug(`Tool call received:`, {
          name: toolData.name,
          status: toolData.status,
          id: toolData.id,
          input: toolData.input ? JSON.stringify(toolData.input).substring(0, 200) : 'empty',
        });
        toolCalls.push(toolData);

        // Intercept Bash tool calls for terminal panel
        if (toolData.name === 'Bash' && toolData.input?.command) {
          const command = toolData.input.command as string;
          const toolId = toolData.id as string;
          log.debug(`Bash command intercepted: ${command}`);

          // Generate commandId and store for later update
          const commandId = `agent-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          remoteToolCommands.set(toolId, commandId);
          // Set as active command for terminal output streaming
          activeBashCommandId = commandId;

          // Notify Terminal Gateway about agent command
          terminalGateway.onAgentCommand(
            spaceId,
            conversationId,
            command,
            '', // Output will come via terminal:output
            'running',
            undefined,
            commandId,
          );
        } else if (toolData.name === 'Bash') {
          log.warn(
            `Bash tool call received but input.command is missing:`,
            JSON.stringify(toolData.input),
          );
        }

        // Send in format expected by handleAgentToolCall
        sendToRenderer('agent:tool-call', spaceId, conversationId, {
          id: toolData.id,
          name: toolData.name,
          status: toolData.status || 'running',
          input: toolData.input || {},
          requiresApproval: false,
        });
      }
    });

    addHandler('tool:result', (data) => {
      if (matchesTurn(data)) {
        const toolData = data.data;
        // Try to get tool name from toolData, or look it up from remoteToolCommands map
        // The name field may be empty in some SDK responses, but we can infer it from the tool ID
        const toolName = toolData.name || (remoteToolCommands.has(toolData.id) ? 'Bash' : '');
        log.debug(
          `Tool result received, name=${toolData.name}, inferredName=${toolName}, output.length=${toolData.output?.length || 0}`,
        );

        // Notify Terminal Gateway about Bash command completion
        // Check both explicit name and inferred name (for remote commands tracked in remoteToolCommands)
        if (toolName === 'Bash') {
          const exitCode = toolData.exit_code !== undefined ? (toolData.exit_code as number) : 0;
          const toolId = toolData.id as string;
          const commandId = remoteToolCommands.get(toolId);

          if (commandId) {
            // Get accumulated terminal output (SDK's tool_result block may have empty content
            // while actual output was streamed via terminal:output events)
            const accumulatedOutput = getCommandOutput(commandId);
            // Use accumulated output if toolData.output is empty
            const finalOutput = toolData.output || accumulatedOutput;

            log.debug(
              `Updating Bash command ${commandId}, toolData.output.length=${toolData.output?.length || 0}, accumulated.length=${accumulatedOutput.length}, finalOutput.length=${finalOutput.length}`,
            );

            // Also send the command string (in case it wasn't preserved from tool:call)
            const commandString = (toolData.input?.command as string) || '';

            terminalGateway.onAgentCommand(
              spaceId,
              conversationId,
              commandString, // Command string from tool input
              finalOutput, // Use accumulated output if SDK output is empty
              'completed',
              exitCode,
              commandId, // Use stored commandId to update existing command
            );
            remoteToolCommands.delete(toolId);
            // Clear active command ID and output buffer
            if (activeBashCommandId === commandId) {
              activeBashCommandId = null;
            }
            commandOutputBuffer.delete(commandId);
          } else {
            log.warn(`No commandId found for tool ${toolId}`);
          }
        }

        sendToRenderer('agent:tool-result', spaceId, conversationId, {
          toolId: toolData.id,
          result: toolData.output || '',
          isError: false,
        });
      }
    });

    addHandler('tool:error', (data) => {
      if (matchesTurn(data)) {
        const toolData = data.data;
        log.error(`Tool error:`, toolData);
        sendToRenderer('agent:tool-result', spaceId, conversationId, {
          toolId: toolData.id,
          result: toolData.error || 'Tool execution failed',
          isError: true,
        });
      }
    });

    // Terminal output events
    addHandler('terminal:output', (data) => {
      if (matchesTurn(data)) {
        const output = data.data;
        log.debug(
          `terminal:output received: content.length=${output.content?.length || 0}, activeBashCommandId=${activeBashCommandId}`,
        );
        terminalOutputs.push(output);
        sendToRenderer('agent:terminal', spaceId, conversationId, output);

        // Accumulate output for the active command (to be saved when command completes)
        // This is critical because SDK's tool_result block may have empty content
        // while actual output is streamed via terminal:output events
        if (activeBashCommandId) {
          accumulateCommandOutput(activeBashCommandId, output.content || '');

          // Forward to Terminal Gateway for streaming to frontend
          terminalGateway.streamOutput(
            conversationId,
            activeBashCommandId, // Use tracked commandId for proper output association
            output.content || '',
            true, // isStream
          );
        } else {
          log.warn(`terminal:output received but no activeBashCommandId set`);
        }
      }
    });

    // Streaming text events - use agent:message format expected by frontend
    addHandler('claude:stream', (data) => {
      if (matchesTurn(data)) {
        const text = data.data?.text || data.data?.content || '';
        streamChunks.push(text);
        streamingContent = streamChunks.join('');
        // CRITICAL: Also update sessionState for error handling (preserve content on interrupt)
        sessionState.streamingContent = streamingContent;
        // Send in the format expected by handleAgentMessage
        sendToRenderer('agent:message', spaceId, conversationId, {
          delta: text,
          isStreaming: true,
          isComplete: false,
        });
      }
    });

    // Context usage events - real-time token usage updates during streaming
    addHandler('claude:context-usage', (data) => {
      if (data.sessionId === effectiveSessionId) {
        sendToRenderer('agent:context-usage', spaceId, conversationId, {
          type: 'context-usage',
          ...data.data,
        });
      }
    });

    // Thought events - for thinking process display (aligned with local agent:thought)
    addHandler('thought', (data) => {
      if (matchesTurn(data)) {
        const thoughtData = data.data;
        log.debug(`Thought received: type=${thoughtData.type}, id=${thoughtData.id}`);

        // Store thought for final message
        thoughts.push(thoughtData);
        // sessionState.thoughts already points to the same array (no copy needed)

        // Send to renderer in the same format as local agent:thought
        // Spread agentId/agentName to top level so handleAgentThought can route to worker session
        sendToRenderer('agent:thought', spaceId, conversationId, {
          thought: thoughtData,
          ...(thoughtData.agentId && { agentId: thoughtData.agentId }),
          ...(thoughtData.agentName && { agentName: thoughtData.agentName }),
        });
      }
    });

    // Thought delta events - for streaming updates (aligned with local agent:thought-delta)
    addHandler('thought:delta', (data) => {
      if (matchesTurn(data)) {
        const deltaData = data.data;

        // Debug: Log tool result deltas
        if (deltaData.isToolResult || deltaData.toolResult) {
          log.debug(`Received thought:delta with toolResult for thought ${deltaData.thoughtId}`);
        }

        // Send to renderer in the same format as local agent:thought-delta
        sendToRenderer('agent:thought-delta', spaceId, conversationId, deltaData);

        // Update stored thought content/properties if applicable
        const thought = thoughts.find((t) => t.id === deltaData.thoughtId);
        if (thought) {
          // Update content (for thinking/text)
          if (deltaData.content) {
            thought.content = deltaData.content;
          }
          // Update tool result (for tool_use with result)
          if (deltaData.toolResult) {
            thought.toolResult = deltaData.toolResult;
            log.debug(`Updated toolResult for thought ${deltaData.thoughtId}`);
          }
          // Update tool input (when complete)
          if (deltaData.toolInput) {
            thought.toolInput = deltaData.toolInput;
          }
          // Update streaming state
          if (deltaData.isComplete !== undefined) {
            thought.isStreaming = !deltaData.isComplete;
          }
          // Update ready state (for tool_use)
          if (deltaData.isReady !== undefined) {
            thought.isReady = deltaData.isReady;
          }
          // sessionState.thoughts already points to the same array (no copy needed)
        }
      }
    });

    // MCP status events - forward to renderer (aligned with local agent:mcp-status)
    addHandler('mcp:status', (data) => {
      if (matchesTurn(data)) {
        log.debug(`MCP status received:`, data.data);
        // Import broadcastMcpStatus from mcp-manager
        import('./mcp-manager')
          .then(({ broadcastMcpStatus }) => {
            broadcastMcpStatus(data.data.servers);
          })
          .catch((err) => log.error(' Failed to import broadcastMcpStatus:', err));
      }
    });

    // Compact boundary events - context compression notification
    addHandler('compact:boundary', (data) => {
      if (matchesTurn(data)) {
        log.debug(`Compact boundary received:`, data.data);
        sendToRenderer('agent:compact', spaceId, conversationId, {
          type: 'compact',
          trigger: data.data.trigger,
          preTokens: data.data.preTokens,
        });
      }
    });

    // Subagent worker lifecycle events (from SDK Agent tool usage)
    addHandler('worker:started', (data) => {
      if (matchesTurn(data)) {
        log.debug(`Worker started: ${data.data.agentId} - ${data.data.agentName}`);
        sendToRenderer('worker:started', spaceId, conversationId, data.data);
      }
    });

    addHandler('worker:completed', (data) => {
      if (matchesTurn(data)) {
        log.debug(`Worker completed: ${data.data.agentId}`);
        sendToRenderer('worker:completed', spaceId, conversationId, data.data);
      }
    });

    // AskUserQuestion forwarding - remote Claude asks user a question.
    // This is a control-plane event: route by session only, dedupe by question id.
    addHandler('ask:question', (data) => {
      if (!matchesSession(data)) {
        return;
      }
      const questionId = data.data?.id;
      if (!questionId) {
        log.warn('AskUserQuestion missing id');
        return;
      }
      if (handledQuestionIds.has(questionId)) {
        log.debug(`Ignoring duplicate AskUserQuestion: id=${questionId}`);
        return;
      }
      handledQuestionIds.add(questionId);
      if (data.generationId && data.generationId !== generationId) {
        log.warn(
          `AskUserQuestion generation mismatch accepted: expected=${generationId}, actual=${data.generationId}, questionId=${questionId}`,
        );
      }
      log.debug(
        `AskUserQuestion: id=${questionId}, questions=${data.data.questions?.length || 0}`,
      );
      sendToRenderer('agent:ask-question', spaceId, conversationId, data.data);
    });

    // Permission request forwarding - remote Claude asks user to approve a destructive command
    addHandler('permission:request', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.debug(
          `Permission request: id=${data.data.id}, tool=${data.data.toolName}`,
        );
        // [DIAG-1.7] Log permission forwarding to renderer
        console.log(`[DIAG][RemotePermission] Forwarding permission:request to renderer: id=${data.data.id}, tool=${data.data.toolName}`)
        sendToRenderer('agent:permission-request', spaceId, conversationId, {
          id: data.data.id,
          toolName: data.data.toolName,
          toolInput: data.data.toolInput,
          timestamp: Date.now(),
        });
      }
    });

    // Auth retry notification from remote proxy
    addHandler('auth_retry', (data) => {
      if (matchesTurn(data)) {
        log.info(`Auth retry in progress (remote): ${data.data?.attempt}/${data.data?.maxRetries}`);
        sendToRenderer('agent:auth-retry', spaceId, conversationId, data.data);
      }
    });

    // API warning — non-fatal API errors (429, 500, overloaded) forwarded from proxy
    // Show as a system thought in the thinking process timeline (same pattern as local auth retry)
    addHandler('claude:api-warning', (data) => {
      if (matchesTurn(data)) {
        const warningData = data.data;
        log.warn(`API warning (remote): ${warningData?.error}`);
        const warningThought: any = {
          id: `thought-api-warning-${Date.now()}`,
          type: 'system',
          content: warningData?.isAuthRetry
            ? `API 错误 (${warningData.errorStatus}): ${warningData.error} — 正在重试认证...`
            : `API 错误 (${warningData.errorStatus}): ${warningData.error}`,
          timestamp: new Date().toISOString(),
        };
        sessionState.thoughts.push(warningThought);
        sendToRenderer('agent:thought', spaceId, conversationId, {
          thought: warningThought,
        });
      }
    });

    // Text block start signal - for proper text block reset in frontend
    addHandler('text:block-start', (data) => {
      if (matchesTurn(data)) {
        sendToRenderer('agent:message', spaceId, conversationId, {
          type: 'message',
          content: '',
          isComplete: false,
          isStreaming: false,
          isNewTextBlock: true,
        });
      }
    });

    // Stream alive heartbeat from server — forward to renderer
    addHandler('stream:alive', (data) => {
      if (data.sessionId === effectiveSessionId) {
        sendToRenderer('agent:stream-alive', spaceId, conversationId, data.data);
      }
    });

    // Remote proxy log forwarding — record in local logs
    addHandler('log', (data) => {
      const entry = data.data;
      if (!entry) return;
      const level = entry.level || 'info';
      const source = entry.source || 'unknown';
      const message = entry.message || '';
      const prefix = `[remote-log] [${source}]`;
      if (level === 'error') {
        log.error(`${prefix} ${message}`);
      } else if (level === 'warn') {
        log.warn(`${prefix} ${message}`);
      } else {
        log.info(`${prefix} ${message}`);
      }
    });

    // Idle timeout — forward to renderer for user decision
    addHandler('idle:timeout', (data) => {
      if (data.sessionId === effectiveSessionId) {
        log.warn(`Idle timeout for session ${effectiveSessionId}: ${data.idleMinutes}min`);
        sendToRenderer('agent:idle-timeout', spaceId, conversationId, {
          idleMinutes: data.idleMinutes,
        });
      }
    });

    // ============================================
    // Proxy Orchestrator Events (Phase 2)
    // These events come from the remote proxy's independent Hyper-Space orchestrator.
    // They are forwarded to the local agent orchestrator for injection into leader sessions.
    // ============================================

    addHandler('proxy:report', (data) => {
      if (matchesTurn(data)) {
        const eventData = data.data;
        log.debug(`Proxy report: from=${eventData.workerName}, type=${eventData.reportType}`);
        // Forward to local orchestrator for injection into the leader's session
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.reportToLeader(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:report:', err));
      }
    });

    addHandler('proxy:announce', (data) => {
      if (matchesTurn(data)) {
        const eventData = data.data;
        log.debug(`Proxy announce: worker=${eventData.workerName}, status=${eventData.status}`);
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.sendAnnouncement(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:announce:', err));
      }
    });

    addHandler('proxy:question', (data) => {
      if (matchesTurn(data)) {
        const eventData = data.data;
        log.debug(`Proxy question: from=${eventData.workerName}, target=${eventData.target}`);
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.sendAgentMessage(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:question:', err));
      }
    });

    addHandler('proxy:message', (data) => {
      if (matchesTurn(data)) {
        const eventData = data.data;
        log.debug(`Proxy message: from=${eventData.workerName}, to=${eventData.recipient}`);
        import('./orchestrator')
          .then(({ getAgentOrchestrator }) => {
            const orchestrator = getAgentOrchestrator();
            orchestrator.broadcastAgentMessage(eventData);
          })
          .catch((err) => log.error(' Failed to handle proxy:message:', err));
      }
    });

    // ============================================
    // Proxy App Status Events (Phase 3/4)
    // Remote proxy sends app status changes when a digital human is
    // created, triggered, paused, or completes a run.
    // ============================================

    addHandler('proxy:app:status', (data) => {
      const eventData = data.data;
      if (eventData._eventType === 'app:status') {
        log.debug(`Proxy app status: ${eventData.name} -> ${eventData.status}`);
        // Forward to renderer for UI display (status card in chat)
        sendToRenderer('app:status_changed', spaceId, conversationId, {
          appId: eventData.appId,
          name: eventData.name,
          status: eventData.status,
          lastRunAt: eventData.lastRunAt,
          lastRunOutcome: eventData.lastRunOutcome,
          lastErrorMessage: eventData.lastErrorMessage,
          activityEntries: eventData.activityEntries,
          isRemote: true,
        });
      } else {
        // Regular proxy:report event that contains app data
        // Already handled by proxy:report handler above
      }
    });

    // Register MCP tools with remote proxy (only once per connection lifetime)
    // registerMcpTools() internally checks send() return value and only sets
    // the flag when the message is actually sent successfully.
    if (mcpToolDefs.length > 0 && !client.mcpToolsRegistered) {
      const sent = client.registerMcpTools(mcpToolDefs, mcpCapabilities);
      if (sent) {
        log.info(`Registered ${mcpToolDefs.length} MCP tools with pooled connection`);
      } else {
        log.warn(
          `Failed to register ${mcpToolDefs.length} MCP tools — connection not ready, will retry on next message`,
        );
      }
    }

    // Build message payload - incremental when resuming a session
    // When sdkSessionId exists, the remote SDK already has full conversation context.
    // We only send the current user message (incremental) to reduce payload size.
    const sdkSessionIdForResume = sdkSessionId || sessionId;
    const isResumingSession = !!sdkSessionIdForResume;

    // Helper: build user message content with optional images
    const buildUserMessage = (text: string, imgs?: any[]): any => {
      const content: any[] = [{ type: 'text', text }];
      if (imgs && imgs.length > 0) {
        for (const image of imgs) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: image.data,
            },
          });
        }
      }
      return {
        role: 'user',
        content: content.length === 1 ? content[0].text : content,
      };
    };

    let messagesToSend: Array<{ role: string; content: any }>;

    if (isResumingSession) {
      // Session resumption: remote SDK has full conversation context
      // Only send the current user message (incremental)
      messagesToSend = [buildUserMessage(message, images)];
      log.info(
        `Sending incremental message (session resumption, sdkSessionId=${sdkSessionIdForResume})`,
      );
    } else {
      // First message: send full history (remote SDK has no context yet)
      log.debug(`Building full message history for conversation ${conversationId}...`);

      const messageHistory: Array<{ role: string; content: any }> = [];

      if (conversation && conversation.messages) {
        // Filter out the last assistant placeholder message we just added
        const messagesForHistory = conversation.messages.slice(0, -1);

        for (const msg of messagesForHistory) {
          const content: any[] = [];
          if (msg.content) content.push({ type: 'text', text: msg.content });
          if (msg.images && msg.images.length > 0) {
            for (const image of msg.images) {
              content.push({
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.data },
              });
            }
          }
          messageHistory.push({
            role: msg.role,
            content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
          });
        }
      }

      messageHistory.push(buildUserMessage(message, images));
      messagesToSend = messageHistory;
      log.info(`Sending full history: ${messageHistory.length} messages (new session)`);
    }

    // CRITICAL: effectiveSessionId stays as conversationId throughout.
    // The server uses this as the key for its sessions Map.
    log.info(
      `Sending chat request to remote Claude (sessionId=${effectiveSessionId}, sdkSessionId=${sdkSessionIdForResume || 'new'}, workDir=${remotePath})...`,
    );

    const response = await client.sendChatWithStream(
      effectiveSessionId, // Conversation ID for WebSocket routing
      messagesToSend,
      {
        generationId, // Unique per turn — server echoes in all events
        apiKey,
        baseUrl: baseUrl || undefined,
        model,
        maxTokens: config.agent?.maxTokens || 8192,
        system: systemPrompt || undefined, // Custom system prompt from space config
        maxThinkingTokens: thinkingEnabled ? 10240 : undefined,
        workDir: remotePath, // CRITICAL: Pass workDir from Space config
        sdkSessionId: sdkSessionIdForResume, // Pass SDK session ID for resumption
        contextWindow: currentSource?.contextWindow, // Context window for compression and display
        permissionMode: (config.permissions?.trustMode ?? false) ? 'full' : 'partial',
        allowSubAgentSkills: SkillManager.getInstance().getInstalledSkills()
          .filter(s => s.spec.allow_sub_agents)
          .map(s => s.spec.name),
      },
    );

    log.info(`Received response from remote Claude: ${response.content?.substring(0, 100)}...`);

    // Send final message content (the streaming already sent deltas)
    // response is { content: string, tokenUsage?: any }
    sendToRenderer('agent:message', spaceId, conversationId, {
      content: streamingContent || response.content,
      isComplete: true,
      isStreaming: false,
    });

    // Send completion event with tokenUsage
    sendToRenderer('agent:complete', spaceId, conversationId, {
      tokenUsage: response.tokenUsage,
    });

    // Extract file changes summary for immediate display (aligned with local conversation)
    let metadata: { fileChanges?: FileChangesSummary } | undefined;
    if (thoughts.length > 0) {
      try {
        const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts);
        if (fileChangesSummary) {
          metadata = { fileChanges: fileChangesSummary };
          log.info(
            `File changes: ${fileChangesSummary.totalFiles} files, +${fileChangesSummary.totalAdded} -${fileChangesSummary.totalRemoved}`,
          );
        }
      } catch (error) {
        log.error(`Failed to extract file changes:`, error);
      }
    }

    // Update the assistant message with the response
    // Note: Don't include toolCalls in final message - tools are already shown in thinking process
    // Instead, show file changes summary (aligned with local space behavior)
    // response is { content: string, tokenUsage?: any }
    updateLastMessage(spaceId, conversationId, {
      content: streamingContent || response.content,
      // toolCalls is intentionally NOT included - tools are displayed in thinking process
      terminalOutputs: terminalOutputs.length > 0 ? terminalOutputs : undefined,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
      metadata,
      tokenUsage: response.tokenUsage,
    });

    // Save session ID for future resumption
    // Use the latest captured SDK session ID if available.
    const sessionToSave = sdkSessionId || sessionId;
    if (sessionToSave) {
      saveSessionId(spaceId, conversationId, sessionToSave);
      log.info(`Session ID saved: ${sessionToSave}`);
    }

    log.info(`Remote Claude execution completed`);

    // Clean up event handlers and release pooled connection
    for (const cleanup of eventCleanups) cleanup();
    unregisterActiveClient(conversationId);
    mcpBridge?.dispose();
    releaseConnection(serverId, conversationId);

    // CRITICAL: Unregister active session after completion
    // This ensures that getSessionState returns isActive: false after completion,
    // preventing frontend from incorrectly restoring isGenerating state on refresh
    unregisterActiveSession(conversationId);
    log.info(`Unregistered active session: ${conversationId}`);
  } catch (error) {
    log.error(' Execute error:', error);
    const err = error as Error;

    // Check if this is an abort/stop action (user intentionally stopped)
    // Also check for AbortError name (standard abort signal)
    // Use case-insensitive matching for 'interrupt' to match 'Interrupted by user'
    const isAbort =
      err.name === 'AbortError' ||
      err.message?.includes('aborted') ||
      err.message?.toLowerCase().includes('interrupt');

    // CRITICAL: Use sessionState for content/thoughts - it's updated in real-time by event handlers
    // This ensures we have the latest accumulated content even if interrupt happened mid-stream
    // Note: sessionState may be undefined if error occurred before it was initialized
    const accumulatedContent = sessionState?.streamingContent || streamingContent;
    const accumulatedThoughts =
      (sessionState?.thoughts?.length ?? 0) > 0 ? sessionState!.thoughts : thoughts;

    // Always persist already generated content and thoughts
    // This ensures content survives after stop and page refresh
    const hasContent = accumulatedContent.length > 0;
    const hasThoughts = accumulatedThoughts.length > 0;

    if (hasContent || hasThoughts) {
      log.debug(
        `Persisting on abort: ${accumulatedContent.length} chars, ${accumulatedThoughts.length} thoughts`,
      );
    }

    // CRITICAL: Update the assistant message with accumulated content and thoughts
    // This is the same logic as the normal completion path
    updateLastMessage(spaceId, conversationId, {
      content: accumulatedContent, // Keep already generated content
      terminalOutputs: terminalOutputs.length > 0 ? terminalOutputs : undefined,
      thoughts: hasThoughts ? accumulatedThoughts : undefined, // Keep already generated thoughts
      error: isAbort ? undefined : err.message, // Only show error if not user-initiated abort
    });

    // CRITICAL: Send completion event to notify frontend to stop streaming and reload
    // This ensures the frontend knows the generation is complete and can display the final content
    sendToRenderer('agent:complete', spaceId, conversationId, {});

    // Save SDK session ID even on interrupt for future resumption.
    // Without this, the next sendMessageRemote call starts a fresh session, losing all context.
    if (sdkSessionId || resumeOrConversationSessionId) {
      const sessionToSave = (sdkSessionId || resumeOrConversationSessionId)!;
      saveSessionId(spaceId, conversationId, sessionToSave);
      log.info(`Session ID saved (on ${isAbort ? 'interrupt' : 'error'}): ${sessionToSave}`);
    }

    // Clean up event handlers and release pooled connection on error too
    for (const cleanup of eventCleanups) {
      try {
        cleanup();
      } catch (err) {
        log.error('Cleanup error:', err);
      }
    }
    unregisterActiveClient(conversationId);
    try {
      releaseConnection(serverId, conversationId);
    } catch (err) {
      log.error('Release connection error:', err);
    }

    // CRITICAL: Unregister active session on error too
    // This ensures that getSessionState returns isActive: false after error,
    // preventing frontend from incorrectly restoring isGenerating state on refresh
    unregisterActiveSession(conversationId);
    log.info(`Unregistered active session on error: ${conversationId}`);

    // Clean up MCP bridge
    mcpBridge?.dispose();

    // Don't throw if user intentionally stopped
    if (!isAbort) {
      throw err;
    }
  }
}

/**
 * Check if remote agent is running
 */
async function checkRemoteAgentRunning(serverId: string): Promise<boolean> {
  const deployService = getRemoteDeployService();
  const server = deployService.getServer(serverId);

  if (!server) {
    return false;
  }

  // Ensure SSH connection is established before checking
  try {
    await deployService.ensureSshConnection(serverId);
  } catch {
    return false;
  }

  const manager = deployService.getSSHManagerForServer(serverId);
  if (!manager) {
    return false;
  }

  try {
    // Check 1: Check if the node process is running from the deployment directory
    const processResult = await manager.executeCommandFull(
      `pgrep -f "node.*dist/index.js" || echo "NO_PROCESS"`,
    );
    if (processResult.stdout.includes('NO_PROCESS')) {
      return false;
    }

    // Check 2: Check if the port is listening
    const portResult = await manager.executeCommandFull(
      `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${server.assignedPort}" || echo "NOT_LISTENING"`,
    );

    return !portResult.stdout.includes('NOT_LISTENING');
  } catch {
    return false;
  }
}
