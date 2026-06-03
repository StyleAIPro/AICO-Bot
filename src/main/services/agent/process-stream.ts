/**
 * Agent Module - Core Stream Processor
 *
 * Core stream processing logic for V2 SDK session message streams.
 * Handles:
 * - Token-level streaming (text, thinking, tool_use blocks)
 * - Thought accumulation and tool result merging
 * - Session ID capture and MCP status broadcasting
 * - Token usage tracking
 * - Stream end handling with interrupt/error detection
 *
 * This module is caller-agnostic: both the main conversation agent
 * (send-message.ts) and the automation app runtime (execute.ts) use it,
 * providing caller-specific behavior via StreamCallbacks.
 */

import { is } from '@electron-toolkit/utils';
import type { Thought, ToolCall, TokenUsage, SingleCallUsage, SessionState } from './types';
import { sendToRenderer } from './helpers';
import { estimateTokenCount } from '../../../shared/utils/token-estimator';
import {
  parseSDKMessage,
  extractSingleUsage,
  extractResultUsage,
  safeJsonStringify,
} from './message-utils';
import { broadcastMcpStatus } from './mcp-manager';
import { markSessionActivity } from './session-manager';
import { terminalGateway } from '../terminal/terminal-gateway';
import { getSpace } from '../space.service';
import { hasPendingInjection } from './stream-injection';
import {
  findSubagentByToolUseId,
  processSubagentStreamEvent,
  type SubagentState,
} from './subagent-tracker';

// Unified fallback error suffix - guides user to check logs
const FALLBACK_ERROR_HINT = 'Check logs in Settings > System > Logs.';

// ============================================
// Types
// ============================================

/**
 * Callbacks for caller-specific behavior (storage, JSONL writing, etc.)
 *
 * The stream processor handles all streaming logic and renderer events.
 * Callers provide callbacks for their specific needs:
 * - Main agent: persists to conversation.service, saves session ID
 * - Automation: writes to JSONL via session-store
 */
export interface StreamCallbacks {
  /** Called once when stream finishes — caller handles storage */
  onComplete(result: StreamResult): void;
  /** Called for each raw SDK message (for JSONL persistence in automation) */
  onRawMessage?(sdkMessage: any): void;
}

/**
 * Result returned when stream processing finishes.
 * Contains all data needed by callers for post-stream handling.
 */
export interface StreamResult {
  /** Final text content (last text block or streaming fallback) */
  finalContent: string;
  /** Accumulated thoughts (thinking, tool_use, tool_result, text, error, etc.) */
  thoughts: Thought[];
  /** Token usage from the result message */
  tokenUsage: TokenUsage | null;
  /** Captured session ID (from system/result messages, for session persistence) */
  capturedSessionId?: string;
  /** Whether the stream was interrupted (no result message or error_during_execution) */
  isInterrupted: boolean;
  /** Whether the user aborted via AbortController */
  wasAborted: boolean;
  /** Whether an error thought was received (e.g., rate limit, auth failure) */
  hasErrorThought: boolean;
  /** The error thought itself, if any */
  errorThought?: Thought;
  /** Whether the session hit the SDK's maxTurns limit (error_max_turns subtype) */
  reachedMaxTurns: boolean;
  /** Whether there's a pending injection message to continue the conversation */
  hasPendingInjection: boolean;
  /** Whether a 401 authentication_failed retry was detected during streaming */
  needsAuthRetry: boolean;
}

/**
 * Parameters for processStream.
 * All data needed to process a V2 SDK session stream.
 */
export interface ProcessStreamParams {
  /** The V2 SDK session (already created by caller) */
  v2Session: any;
  /** Session state (holds thoughts array — shared with session-manager) */
  sessionState: SessionState;
  /** Space ID for renderer event routing */
  spaceId: string;
  /** Conversation ID for renderer event routing (can be virtual like "app-chat:{appId}") */
  conversationId: string;
  /** Already-prepared message content (string or multi-modal content blocks) */
  messageContent: string | Array<{ type: string; [key: string]: unknown }>;
  /** Display model name for thought parsing (user's configured model, not SDK internal) */
  displayModel: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** Timestamp of send start (for timing logs) */
  t0: number;
  /** Strategy callbacks for caller-specific behavior */
  callbacks: StreamCallbacks;
  /** Redirect renderer events to a different conversationId (for Hyper Space worker subtasks) */
  rendererConversationId?: string;
  /** Suppress the agent:complete event and isComplete message at end of stream (for worker subtasks) */
  suppressComplete?: boolean;
  /** Worker agent info — when set, all renderer events include agentId/agentName for worker panel routing */
  workerInfo?: { agentId: string; agentName: string };
  /** User-configured context window size (from AI source settings). Used for accurate token usage display. */
  contextWindow?: number;
  /** Pre-send estimated context token baseline (streaming estimation starts from this value instead of 0) */
  estimatedContextBaseline?: number;
}

// ============================================
// Stream Processor
// ============================================

/**
 * Process the message stream from a V2 SDK session.
 *
 * This is the core streaming engine shared by both the main conversation agent
 * and the automation app runtime. It handles:
 * - Sending the message to the session
 * - Processing all stream_event types (thinking, text, tool_use blocks with deltas)
 * - Processing non-stream SDK messages (assistant, user, system, result)
 * - Emitting renderer events via sendToRenderer for real-time UI updates
 * - Token usage tracking (per-call and cumulative)
 * - Session ID capture from system/result messages
 * - MCP status broadcasting
 * - Stream end handling with the complete interrupt/error truth table
 *
 * @param params - All parameters needed for stream processing
 * @returns StreamResult with final content, thoughts, token usage, and status flags
 */
export async function processStream(params: ProcessStreamParams): Promise<StreamResult> {
  const {
    v2Session,
    sessionState,
    spaceId,
    conversationId,
    messageContent,
    displayModel,
    abortController,
    t0,
    callbacks,
  } = params;

  // For worker subtasks, redirect renderer events to the parent conversation
  const rendererConvId = params.rendererConversationId || conversationId;

  // For worker subtasks, tag all events with agent identification so frontend can route to worker panels
  const workerTag = params.workerInfo
    ? { agentId: params.workerInfo.agentId, agentName: params.workerInfo.agentName }
    : undefined;

  /** Local sendToRenderer wrapper that injects worker tag when present */
  const emit = (channel: string, data: Record<string, unknown>): void => {
    if (workerTag) {
      sendToRenderer(channel, spaceId, rendererConvId, { ...data, ...workerTag });
    } else {
      sendToRenderer(channel, spaceId, rendererConvId, data);
    }
  };

  // ========== Subagent event handlers (local functions) ==========
  /**
   * Handle a stream_event that belongs to a subagent (has parent_tool_use_id).
   * Looks up the SubagentState, or buffers the event if it arrived before task_started.
   */
  const handleSubagentStreamEvent = (
    parentToolUseId: string,
    event: any,
    sdkMessage: any,
  ): void => {
    const state = findSubagentByToolUseId(parentToolUseId, subagentStates, toolUseIdToTaskId);
    if (state) {
      if (!state.isComplete) {
        processSubagentStreamEvent(state, event, sdkMessage, spaceId, rendererConvId, sessionState);
      }
    } else {
      // Subagent stream events may arrive before task_started — buffer them
      let buffer = pendingSubagentEvents.get(parentToolUseId);
      if (!buffer) {
        buffer = [];
        pendingSubagentEvents.set(parentToolUseId, buffer);
      }
      buffer.push({ event, sdkMessage });
    }
  };

  /**
   * Handle a non-stream message (user/assistant) that belongs to a subagent.
   * Processes tool_result from user messages to merge into subagent tool_use thoughts.
   */
  const handleSubagentNonStreamEvent = (parentToolUseId: string, sdkMessage: any): void => {
    const state = findSubagentByToolUseId(parentToolUseId, subagentStates, toolUseIdToTaskId);
    if (!state || state.isComplete) return;

    const { toolIdToThoughtId, agentId, agentName } = state;
    const workerEmit = (channel: string, data: Record<string, unknown>): void => {
      sendToRenderer(channel, spaceId, rendererConvId, { ...data, agentId, agentName });
    };

    // Handle user messages containing tool_result blocks
    if (sdkMessage.type === 'user') {
      const content = sdkMessage.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolUseId = block.tool_use_id;
            const toolUseThoughtId = toolIdToThoughtId.get(toolUseId);
            if (toolUseThoughtId) {
              const resultContent =
                typeof block.content === 'string'
                  ? block.content
                  : safeJsonStringify(block.content);
              workerEmit('agent:thought-delta', {
                thoughtId: toolUseThoughtId,
                toolResult: {
                  output: resultContent,
                  isError: block.is_error || false,
                  timestamp: new Date().toISOString(),
                },
                isToolResult: true,
              });
              // Also merge tool result into persisted thought in sessionState
              const persistedThought = sessionState.thoughts.find((t) => t.id === toolUseThoughtId);
              if (persistedThought) {
                persistedThought.toolResult = {
                  output: resultContent,
                  isError: block.is_error || false,
                  timestamp: new Date().toISOString(),
                };
              }
            }
          }
        }
      }
    }

    // Handle assistant messages (fallback for non-streaming mode)
    if (sdkMessage.type === 'assistant' && !sdkMessage.error) {
      const content = sdkMessage.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'thinking' && block.thinking) {
            const thought: Thought = {
              id: `thought-sub-fallback-${Date.now()}`,
              type: 'thinking',
              content: block.thinking,
              timestamp: new Date().toISOString(),
              agentId,
              agentName,
            };
            workerEmit('agent:thought', { thought });
            sessionState.thoughts.push(thought);
          } else if (block.type === 'tool_use' && block.id) {
            const thoughtId = `thought-sub-fallback-tool-${Date.now()}`;
            toolIdToThoughtId.set(block.id, thoughtId);
            const thought: Thought = {
              id: thoughtId,
              type: 'tool_use',
              content: '',
              timestamp: new Date().toISOString(),
              toolName: block.name || 'Unknown',
              toolInput: block.input || {},
              isStreaming: false,
              isReady: true,
              agentId,
              agentName,
            };
            workerEmit('agent:thought', { thought });
            sessionState.thoughts.push(thought);
          } else if (block.type === 'text' && block.text) {
            const thought: Thought = {
              id: `thought-sub-fallback-text-${Date.now()}`,
              type: 'text',
              content: block.text,
              timestamp: new Date().toISOString(),
              agentId,
              agentName,
            };
            workerEmit('agent:thought', { thought });
            sessionState.thoughts.push(thought);
          }
        }
      }
    }
  };

  // Accumulate ALL text blocks as the final reply
  // When Claude produces multiple text blocks (e.g. one before tool calls, one after),
  // we concatenate them all so the final message contains the complete response.
  // Intermediate text blocks are still added to thoughts for the thought process timeline.
  let lastTextContent = '';
  let capturedSessionId: string | undefined;

  // Token usage tracking
  // lastSingleUsage: Last API call usage (single call, represents current context size)
  let lastSingleUsage: SingleCallUsage | null = null;
  let tokenUsage: TokenUsage | null = null;

  // Token-level streaming state
  let currentStreamingText = ''; // Accumulates text_delta tokens
  let isStreamingTextBlock = false; // True when inside a text content block
  let hadFirstStreamTextBlock = false; // Reset lastTextContent on first streaming text block to discard pre-stream text (e.g., "Set model to X" from setModel)

  // Track if SDK reported error_during_execution (for interrupted detection)
  let hadErrorDuringExecution = false;
  // Track if SDK reported error_max_turns (session hit the configured maxTurns limit)
  let hadMaxTurnsReached = false;
  // Track if we received a result message (for detecting stream interruption)
  let receivedResult = false;
  // Track if any stream_event was received (for fallback handling in parseSDKMessage)
  let hasStreamEvent = false;
  // Track if pending injection was detected at turn boundary (for turn-level message injection)
  let hadPendingInjection = false;
  // Track if SDK detected 401 authentication_failed retry (for auto-recovery)
  let detectedAuthRetry = false;

  // Local token estimation state — start from pre-send baseline instead of 0
  let estimatedStreamingTokens = params.estimatedContextBaseline || 0;
  let receivedApiUsage = false;
  let lastEstimateEmitTime = 0;

  // Streaming block state - track active blocks by index for delta/stop correlation
  // Key: block index, Value: { type, thoughtId, content/partialJson }
  const streamingBlocks = new Map<
    number,
    {
      type: 'thinking' | 'text' | 'tool_use';
      thoughtId: string;
      content: string; // For thinking: accumulated thinking text, for text: accumulated text, for tool_use: accumulated partial JSON
      toolName?: string;
      toolId?: string;
    }
  >();

  // Tool ID to Thought ID mapping - for merging tool_result into tool_use
  const toolIdToThoughtId = new Map<string, string>();

  // Tool ID to Terminal Command ID mapping - for updating terminal output
  const toolIdToCommandId = new Map<string, string>();

  // ========== SDK Subagent (Agent tool) tracking ==========
  // When Claude spawns a subagent via the Agent tool, the SDK emits events with
  // parent_tool_use_id set to the Agent tool_use block's ID. We detect these
  // and route them into the existing WorkerSessionState pipeline (worker:started,
  // worker:completed, agent:thought with agentId), which already has full
  // frontend support (NestedWorkerTimeline in ThoughtProcess.tsx).
  const subagentStates = new Map<string, SubagentState>();
  const toolUseIdToTaskId = new Map<string, string>();
  // Buffer for subagent events that arrive before task_started (timing issue)
  const pendingSubagentEvents = new Map<string, Array<{ event: any; sdkMessage: any }>>();

  const t1 = Date.now();
  console.log(`[Agent][${conversationId}] Sending message to V2 session...`);

  // Send message to V2 session and stream response
  // For multi-modal messages, we need to send as SDKUserMessage
  if (typeof messageContent === 'string') {
    v2Session.send(messageContent);
  } else {
    // Multi-modal message: construct SDKUserMessage
    const userMessage = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: messageContent,
      },
    };
    v2Session.send(userMessage as any);
  }

  // Stream messages from V2 session
  for await (const sdkMessage of v2Session.stream()) {
    // Mark activity - session is still receiving data (prevents false timeout)
    markSessionActivity(conversationId);

    // Handle abort - check this session's controller
    if (abortController.signal.aborted) {
      console.log(`[Agent][${conversationId}] Aborted`);
      break;
    }

    // Notify caller of raw SDK message (for JSONL persistence in automation)
    if (callbacks.onRawMessage) {
      callbacks.onRawMessage(sdkMessage);
    }

    // Handle stream_event for token-level streaming (text only)
    if (sdkMessage.type === 'stream_event') {
      const event = (sdkMessage as any).event;
      if (!event) continue;

      // Mark that we received stream_event (for fallback handling in parseSDKMessage)
      hasStreamEvent = true;

      // ========== Route subagent stream events ==========
      // SDK sets parent_tool_use_id on events from spawned subagents (Agent tool).
      // Route them to the subagent's isolated state instead of the parent's.
      const parentToolUseId = (sdkMessage as any).parent_tool_use_id as string | null;
      if (parentToolUseId) {
        handleSubagentStreamEvent(parentToolUseId, event, sdkMessage as any);
        continue;
      }

      // DEBUG: Log all stream events with timestamp (ms since send)
      const elapsed = Date.now() - t1;
      // For message_start, log the full event to see if it contains content structure hints
      if (event.type === 'message_start') {
        if (is.dev) {
          console.log(
            `[Agent][${conversationId}] 🔴 +${elapsed}ms message_start FULL:`,
            JSON.stringify(event),
          );
        }
      } else {
        // console.log(`[Agent][${conversationId}] 🔴 +${elapsed}ms stream_event:`, JSON.stringify({
        //   type: event.type,
        //   index: event.index,
        //   content_block: event.content_block,
        //   delta: event.delta
        // }))
      }

      // Text block started
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        isStreamingTextBlock = true;
        currentStreamingText = event.content_block.text || '';

        // Reset pre-stream text on first streaming text block.
        // Before stream events arrive, SDK may emit assistant messages from internal flows
        // (e.g., "Set model to X" from setModel) that get accumulated into lastTextContent
        // via the non-streaming fallback path (hasStreamEvent=false).
        // Only reset on the first text block; subsequent blocks accumulate normally.
        if (!hadFirstStreamTextBlock) {
          lastTextContent = '';
          hadFirstStreamTextBlock = true;
        }

        const blockIndex = event.index ?? 0;

        // Track text block for delta correlation (same pattern as thinking/tool_use)
        const thoughtId = `thought-text-${Date.now()}-${blockIndex}`;
        streamingBlocks.set(blockIndex, {
          type: 'text',
          thoughtId,
          content: currentStreamingText,
        });

        // Create text thought for ThoughtProcess timeline display
        const textThought: Thought = {
          id: thoughtId,
          type: 'text',
          content: currentStreamingText,
          timestamp: new Date().toISOString(),
          isStreaming: true,
        };
        sessionState.thoughts.push(textThought);
        emit('agent:thought', { thought: textThought });

        // 🔑 Send precise signal for new text block (fixes truncation bug)
        // This is 100% reliable - comes directly from SDK's content_block_start event
        emit('agent:message', {
          type: 'message',
          content: '',
          isComplete: false,
          isStreaming: false,
          isNewTextBlock: true, // Signal: new text block started
        });
      }

      // ========== Thinking block streaming ==========
      // Thinking block started - send empty thought immediately
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        const blockIndex = event.index ?? 0;
        const thoughtId = `thought-thinking-${Date.now()}-${blockIndex}`;

        // Track this block for delta correlation
        streamingBlocks.set(blockIndex, {
          type: 'thinking',
          thoughtId,
          content: '',
        });

        // Create and send streaming thought immediately
        const thought: Thought = {
          id: thoughtId,
          type: 'thinking',
          content: '',
          timestamp: new Date().toISOString(),
          isStreaming: true,
        };

        // Reset accumulated text — only text AFTER the last thinking block
        // should become the final message content
        lastTextContent = '';

        // Add to session state
        sessionState.thoughts.push(thought);

        // Send to renderer for immediate display
        emit('agent:thought', { thought });
      }

      // Thinking delta - append to thought content
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const blockIndex = event.index ?? 0;
        const blockState = streamingBlocks.get(blockIndex);

        if (blockState && blockState.type === 'thinking') {
          const delta = event.delta.thinking || '';
          blockState.content += delta;

          // Send delta to renderer for incremental update
          emit('agent:thought-delta', {
            thoughtId: blockState.thoughtId,
            delta,
            content: blockState.content, // Also send full content for fallback
          });
        }
      }

      // Text delta - accumulate locally, send delta to frontend
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        isStreamingTextBlock
      ) {
        const delta = event.delta.text || '';
        currentStreamingText += delta;

        // Also update sessionState for recovery after page refresh
        sessionState.streamingContent = currentStreamingText;

        // Send delta to ThoughtProcess timeline (same pattern as thinking_delta)
        const blockIndex = event.index ?? 0;
        const textBlockState = streamingBlocks.get(blockIndex);
        if (textBlockState && textBlockState.type === 'text') {
          textBlockState.content += delta;
          emit('agent:thought-delta', {
            thoughtId: textBlockState.thoughtId,
            delta,
            content: textBlockState.content, // Full accumulated content for fallback
          });
        }

        // Send delta immediately without throttling
        emit('agent:message', {
          type: 'message',
          delta,
          isComplete: false,
          isStreaming: true,
        });

        // Local token estimation: accumulate streaming tokens
        if (!receivedApiUsage) {
          estimatedStreamingTokens += estimateTokenCount(delta);
          const now = Date.now();
          if (now - lastEstimateEmitTime > 500) {
            lastEstimateEmitTime = now;
            emit('agent:context-usage', {
              type: 'context-usage',
              isEstimate: true,
              estimatedTokens: estimatedStreamingTokens,
              inputTokens: estimatedStreamingTokens,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              contextWindow: params.contextWindow || 200000,
            });
          }
        }
      }

      // ========== Tool use block streaming ==========
      // Tool use block started - send thought with tool name immediately
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const blockIndex = event.index ?? 0;
        const toolId = event.content_block.id || `tool-${Date.now()}`;
        const toolName = event.content_block.name || 'Unknown';
        const thoughtId = `thought-tool-${Date.now()}-${blockIndex}`;

        // Track this block for delta correlation
        streamingBlocks.set(blockIndex, {
          type: 'tool_use',
          thoughtId,
          content: '', // Will accumulate partial JSON
          toolName,
          toolId,
        });

        // Create and send streaming tool thought immediately
        const thought: Thought = {
          id: thoughtId,
          type: 'tool_use',
          content: '',
          timestamp: new Date().toISOString(),
          toolName,
          toolInput: {}, // Empty initially, will be populated on stop
          isStreaming: true,
          isReady: false, // Params not complete yet
        };

        // Add to session state
        sessionState.thoughts.push(thought);

        // Send to renderer for immediate display (shows tool name, "准备中...")
        emit('agent:thought', { thought });
      }

      // Tool use input JSON delta - accumulate partial JSON
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const blockIndex = event.index ?? 0;
        const blockState = streamingBlocks.get(blockIndex);

        if (blockState && blockState.type === 'tool_use') {
          const partialJson = event.delta.partial_json || '';
          blockState.content += partialJson;

          // Send delta to renderer (for progress indication, not for parsing)
          emit('agent:thought-delta', {
            thoughtId: blockState.thoughtId,
            delta: partialJson,
            isToolInput: true, // Flag: this is tool input JSON, not thinking text
          });
        }
      }

      // ========== Block stop handling ==========
      // content_block_stop - finalize streaming blocks
      if (event.type === 'content_block_stop') {
        const blockIndex = event.index ?? 0;
        const blockState = streamingBlocks.get(blockIndex);

        if (blockState) {
          if (blockState.type === 'thinking') {
            // Thinking block complete - send final state
            emit('agent:thought-delta', {
              thoughtId: blockState.thoughtId,
              content: blockState.content,
              isComplete: true, // Signal: thinking is complete
            });

            // Update session state thought
            const thought = sessionState.thoughts.find(
              (t: Thought) => t.id === blockState.thoughtId,
            );
            if (thought) {
              thought.content = blockState.content;
              thought.isStreaming = false;
            }

            console.log(
              `[Agent][${conversationId}] Thinking block complete, length: ${blockState.content.length}`,
            );
          } else if (blockState.type === 'tool_use') {
            // Tool use block complete - parse JSON and send final state
            let toolInput: Record<string, unknown> = {};
            try {
              if (blockState.content) {
                toolInput = JSON.parse(blockState.content);
              }
            } catch (e) {
              console.error(`[Agent][${conversationId}] Failed to parse tool input JSON:`, e);
            }

            // Generate commandId for tracking terminal commands (for Bash commands)
            const commandId = `agent-${Date.now()}-${Math.random().toString(36).substring(7)}`;

            // Record mapping for merging tool_result later
            if (blockState.toolId) {
              toolIdToThoughtId.set(blockState.toolId, blockState.thoughtId);
              toolIdToCommandId.set(blockState.toolId, commandId);
              console.debug(
                `[Agent][${conversationId}] Stored mappings for tool ${blockState.toolId}: thought=${blockState.thoughtId}, command=${commandId}`,
              );
            }

            // Send complete signal with parsed input
            emit('agent:thought-delta', {
              thoughtId: blockState.thoughtId,
              toolInput,
              isComplete: true, // Signal: tool params are complete
              isReady: true, // Tool is ready for execution
              isToolInput: true, // Flag: this is tool input completion (triggers isReady update in frontend)
            });

            // Update session state thought
            const thought = sessionState.thoughts.find(
              (t: Thought) => t.id === blockState.thoughtId,
            );
            if (thought) {
              thought.toolInput = toolInput;
              thought.isStreaming = false;
              thought.isReady = true;
            }

            // Send tool-call event for tool approval/tracking
            // This replaces the event that was previously sent from parseSDKMessage
            const toolCall: ToolCall = {
              id: blockState.toolId || blockState.thoughtId,
              name: blockState.toolName || '',
              status: 'running',
              input: toolInput,
            };
            emit('agent:tool-call', toolCall as unknown as Record<string, unknown>);

            if (is.dev) {
              console.log(
                `[Agent][${conversationId}] Tool block complete [${blockState.toolName}], input: ${JSON.stringify(toolInput).substring(0, 100)}`,
              );
            }

            // Notify Terminal Gateway for Bash commands (local mode)
            if (blockState.toolName === 'Bash' && toolInput.command) {
              const command = toolInput.command as string;
              const toolId = blockState.toolId || '';
              console.debug(
                `[Agent][${conversationId}] Bash command intercepted for terminal: ${command}`,
              );

              // Retrieve the commandId that was already generated and stored in the mapping
              const commandId = toolIdToCommandId.get(toolId);
              if (commandId) {
                console.log(
                  `[Agent][${conversationId}] Using existing commandId ${commandId} for tool ${toolId}`,
                );
              }

              // Get cwd from space for prompt display
              const space = getSpace(spaceId);
              const cwd = space?.workingDir;

              terminalGateway.onAgentCommand(
                spaceId,
                conversationId,
                command,
                '', // Output will come via tool_result
                'running',
                undefined,
                commandId, // Pass the generated commandId
                cwd,
              );
            }
          }

          // Clean up tracking state
          streamingBlocks.delete(blockIndex);
        }

        // Handle text block finalization in streamingBlocks
        if (blockState && blockState.type === 'text') {
          // Send completion signal to ThoughtProcess timeline
          emit('agent:thought-delta', {
            thoughtId: blockState.thoughtId,
            content: blockState.content,
            isComplete: true, // Signal: text block is complete
          });

          // Update session state thought
          const textThought = sessionState.thoughts.find(
            (t: Thought) => t.id === blockState.thoughtId,
          );
          if (textThought) {
            textThought.content = blockState.content;
            textThought.isStreaming = false;
          }

          console.log(
            `[Agent][${conversationId}] Text block complete (streaming), length: ${blockState.content.length}`,
          );
        }

        // Handle text block stop (existing logic)
        if (isStreamingTextBlock) {
          isStreamingTextBlock = false;
          // Accumulate this text block into the running total for final message
          // (append with newline separator between blocks)
          lastTextContent = lastTextContent
            ? lastTextContent + '\n\n' + currentStreamingText
            : currentStreamingText;
          // Send final content of THIS block to frontend (for streaming display)
          // Note: streamingContent remains per-block; full concatenation happens at finalContent
          emit('agent:message', {
            type: 'message',
            content: currentStreamingText,
            isComplete: false,
            isStreaming: false,
          });
          // Update sessionState for recovery after page refresh
          sessionState.streamingContent = currentStreamingText;
          console.log(
            `[Agent][${conversationId}] Text block completed, total accumulated: ${lastTextContent.length} chars`,
          );
        }
      }

      // ========== Extract token usage from stream events ==========
      // message_start provides early input_tokens; message_delta provides final usage
      if (event.type === 'message_start' && event.message?.usage) {
        const usage = event.message.usage;
        if (usage.input_tokens > 0) {
          receivedApiUsage = true;
          lastSingleUsage = {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
          };
          emit('agent:context-usage', {
            type: 'context-usage',
            inputTokens: lastSingleUsage.inputTokens,
            outputTokens: lastSingleUsage.outputTokens,
            cacheReadTokens: lastSingleUsage.cacheReadTokens,
            cacheCreationTokens: lastSingleUsage.cacheCreationTokens,
            contextWindow: params.contextWindow,
          });
        }
      }
      if (event.type === 'message_delta' && event.usage) {
        const usage = event.usage;
        if (usage.input_tokens > 0) {
          receivedApiUsage = true;
          lastSingleUsage = {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
          };
          emit('agent:context-usage', {
            type: 'context-usage',
            inputTokens: lastSingleUsage.inputTokens,
            outputTokens: lastSingleUsage.outputTokens,
            cacheReadTokens: lastSingleUsage.cacheReadTokens,
            cacheCreationTokens: lastSingleUsage.cacheCreationTokens,
            contextWindow: params.contextWindow,
          });
        }
      }

      continue; // stream_event handled, skip normal processing
    }

    // ========== Route subagent non-stream events ==========
    // Subagent user messages (tool_results) and assistant messages also carry
    // parent_tool_use_id. Route them to the subagent's isolated state.
    const msgParentToolUseId = (sdkMessage as any).parent_tool_use_id as string | null;
    if (msgParentToolUseId) {
      handleSubagentNonStreamEvent(msgParentToolUseId, sdkMessage);
      continue;
    }

    // DEBUG: Log all SDK messages with timestamp
    const elapsed = Date.now() - t1;
    console.debug(
      `[Agent] SDK messages [${conversationId}] 🔵 +${elapsed}ms ${sdkMessage.type}:`,
      safeJsonStringify(sdkMessage, 2),
    );

    // Extract single API call usage from assistant message (represents current context size)
    if (sdkMessage.type === 'assistant') {
      const usage = extractSingleUsage(sdkMessage);
      if (usage) {
        receivedApiUsage = true;
        lastSingleUsage = usage;
        emit('agent:context-usage', {
          type: 'context-usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          contextWindow: params.contextWindow,
        });
      }
    }

    // Parse SDK message into Thought(s) and send to renderer
    // Pass credentials.model to display the user's actual configured model
    // Pass hasStreamEvent to avoid duplicate processing of thinking/tool_use blocks
    // If hasStreamEvent is true, thinking/tool_use blocks are skipped (already handled via streaming)
    // If hasStreamEvent is false, thinking/tool_use blocks are processed as fallback
    const thoughts = parseSDKMessage(sdkMessage, displayModel, hasStreamEvent);

    // Process all returned thoughts
    for (const thought of thoughts) {
      // Handle tool_result specially - merge into corresponding tool_use thought
      if (thought.type === 'tool_result') {
        const toolUseThoughtId = toolIdToThoughtId.get(thought.id);
        if (toolUseThoughtId) {
          // Found corresponding tool_use - merge result into it
          const toolResult = {
            output: thought.toolOutput || '',
            isError: thought.isError || false,
            timestamp: thought.timestamp,
          };

          // Update backend session state
          const toolUseThought = sessionState.thoughts.find(
            (t: Thought) => t.id === toolUseThoughtId,
          );
          if (toolUseThought) {
            toolUseThought.toolResult = toolResult;

            // Notify Terminal Gateway for Bash command completion (local mode)
            if (toolUseThought.toolName === 'Bash' && toolUseThought.toolInput?.command) {
              const command = toolUseThought.toolInput.command as string;
              console.log(
                `[Agent][${conversationId}] Bash command completed for terminal: ${command}`,
              );

              // Get cwd from space for prompt display
              const space = getSpace(spaceId);
              const cwd = space?.workingDir;

              // Retrieve the stored commandId to update the existing command
              const commandId = toolIdToCommandId.get(thought.id);
              if (commandId) {
                console.log(
                  `[Agent][${conversationId}] Found commandId ${commandId} for tool ${thought.id}, updating command`,
                );
                terminalGateway.onAgentCommand(
                  spaceId,
                  conversationId,
                  command,
                  toolResult.output,
                  toolResult.isError ? 'error' : 'completed',
                  toolResult.isError ? 1 : 0,
                  commandId, // Pass stored commandId to update existing command
                  cwd,
                );
              } else {
                console.warn(
                  `[Agent][${conversationId}] No commandId found for tool ${thought.id}, creating new command`,
                );
                terminalGateway.onAgentCommand(
                  spaceId,
                  conversationId,
                  command,
                  toolResult.output,
                  toolResult.isError ? 'error' : 'completed',
                  toolResult.isError ? 1 : 0,
                  cwd,
                );
              }
            }
          }

          // Send thought-delta to merge result into tool_use on frontend
          emit('agent:thought-delta', {
            thoughtId: toolUseThoughtId,
            toolResult,
            isToolResult: true, // Flag: this is a tool result merge
          });

          // Still send tool-result event for any listeners
          emit('agent:tool-result', {
            type: 'tool_result',
            toolId: thought.id,
            result: thought.toolOutput || '',
            isError: thought.isError || false,
          });

          // Accumulate tool result tokens into local estimation
          if (!receivedApiUsage && thought.toolOutput) {
            estimatedStreamingTokens += estimateTokenCount(thought.toolOutput);
            emit('agent:context-usage', {
              type: 'context-usage',
              isEstimate: true,
              estimatedTokens: estimatedStreamingTokens,
              inputTokens: estimatedStreamingTokens,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              contextWindow: params.contextWindow || 200000,
            });
          }

          // Send turn-boundary event for message injection opportunity
          // This allows frontend to inject pending user messages at natural boundaries
          emit('agent:turn-boundary', {
            toolName: toolUseThought?.toolName,
            toolId: thought.id,
            timestamp: Date.now(),
          });

          // Wait briefly for frontend to respond with injection request
          // This gives the IPC round-trip time to complete (150ms for local, 300ms for remote)
          const WAIT_FOR_INJECTION_MS = 300;
          await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_INJECTION_MS));

          // Check if frontend queued an injection during the wait
          if (hasPendingInjection(conversationId)) {
            console.debug(`[Agent][${conversationId}] Injection detected at turn boundary!`);
            // Set flag to tell the outer loop to continue with new message
            hadPendingInjection = true;
            // Don't break - let the stream complete naturally with the result message
          }

          console.debug(
            `[Agent][${conversationId}] Tool result merged into thought ${toolUseThoughtId}`,
          );
        } else {
          // No mapping found - fall back to separate thought (shouldn't happen normally)
          sessionState.thoughts.push(thought);
          emit('agent:thought', { thought });
          emit('agent:tool-result', {
            type: 'tool_result',
            toolId: thought.id,
            result: thought.toolOutput || '',
            isError: thought.isError || false,
          });
          // Also send turn-boundary for consistency
          emit('agent:turn-boundary', {
            toolId: thought.id,
            timestamp: Date.now(),
          });

          // Wait briefly for frontend to respond with injection request
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (hasPendingInjection(conversationId)) {
            console.debug(
              `[Agent][${conversationId}] Injection detected at turn boundary (fallback)`,
            );
          }

          console.debug(
            `[Agent][${conversationId}] Tool result fallback (no mapping): ${thought.id}`,
          );
        }
      } else {
        // Non tool_result thoughts - handle normally
        // Accumulate thought in backend session (Single Source of Truth)
        sessionState.thoughts.push(thought);

        // Send ALL thoughts to renderer for real-time display in thought process area
        // This includes text blocks - they appear in the timeline during generation
        emit('agent:thought', { thought });

        // Handle specific thought types
        if (thought.type === 'text') {
          // When hasStreamEvent=true, text content was already handled by
          // content_block_delta/stop events (accumulated into lastTextContent
          // at line ~600 and streamed via agent:message). Skip here to avoid
          // doubling lastTextContent and emitting redundant agent:message.
          if (hasStreamEvent) continue;

          // Accumulate ALL text blocks for final message (append with newline separator)
          lastTextContent = lastTextContent
            ? lastTextContent + '\n\n' + thought.content
            : thought.content;

          // Send streaming update - frontend shows this during generation
          emit('agent:message', {
            type: 'message',
            content: thought.content,
            isComplete: false,
          });
        } else if (thought.type === 'thinking') {
          // Reset accumulated text on thinking block (non-streaming fallback)
          // Only text AFTER the last thinking block should be the final message content
          lastTextContent = '';
        } else if (thought.type === 'tool_use') {
          // Populate toolIdToThoughtId for non-streaming fallback path
          // (streaming path populates this in content_block_stop handler)
          // Without this, subsequent tool_result thoughts can't merge into tool_use
          if (!hasStreamEvent && thought.toolInput) {
            toolIdToThoughtId.set(thought.id, thought.id);
            toolIdToCommandId.set(thought.id, `agent-fallback-${Date.now()}`);
          }

          // Send tool call event
          const toolCall: ToolCall = {
            id: thought.id,
            name: thought.toolName || '',
            status: 'running',
            input: thought.toolInput || {},
          };
          emit('agent:tool-call', toolCall as unknown as Record<string, unknown>);
        } else if (thought.type === 'error') {
          // SDK reported an error (rate_limit, authentication_failed, etc.)
          // Send error to frontend - user should see the actual error from provider
          console.log(`[Agent][${conversationId}] Error thought received: ${thought.content}`);
          emit('agent:error', {
            type: 'error',
            error: thought.content,
            errorCode: thought.errorCode, // Preserve error code for debugging
          });
        } else if (thought.type === 'result') {
          // Final result - use accumulated text blocks as the final reply
          const finalContent = lastTextContent || thought.content;
          if (!params.suppressComplete) {
            emit('agent:message', {
              type: 'message',
              content: finalContent,
              isComplete: true,
            });
          }
          // Fallback: if no text block was received, use result content for persistence
          if (!lastTextContent && thought.content) {
            lastTextContent = thought.content;
          }
          // Note: updateLastMessage is called after loop to include tokenUsage
          console.log(
            `[Agent][${conversationId}] Result thought received, ${sessionState.thoughts.length} thoughts accumulated`,
          );
        }
      }
    }

    // Capture session ID and MCP status from system/result messages
    // Use type assertion for SDK message properties that may vary
    const msg = sdkMessage as Record<string, unknown>;
    if (sdkMessage.type === 'system') {
      const subtype = msg.subtype as string | undefined;

      // ========== API retry events (auth recovery) ==========
      // When the SDK encounters a 401 authentication_failed, it emits api_retry system events.
      // Detect these so the caller can rebuild the session with fresh credentials and retry.
      if (subtype === 'api_retry') {
        const errorStatus = msg.error_status as number | undefined;
        const error = msg.error as string | undefined;
        const attempt = msg.attempt as number | undefined;
        const maxRetries = msg.max_retries as number | undefined;
        if (errorStatus === 401 && error === 'authentication_failed') {
          detectedAuthRetry = true;
          console.warn(
            `[Agent][${conversationId}] SDK auth retry detected: attempt=${attempt ?? '?'}/${maxRetries ?? '?'}, ` +
              `error_status=${errorStatus}, error=${error} — will refresh credentials after SDK finishes retrying`,
          );
          // Show a transient system thought so user knows recovery is in progress
          const authRetryThought: Thought = {
            id: `thought-auth-retry-${Date.now()}`,
            type: 'system',
            content: `Auth retry (${attempt ?? '?'}/${maxRetries ?? '?'}) — will refresh credentials`,
            timestamp: new Date().toISOString(),
          };
          sessionState.thoughts.push(authRetryThought);
          emit('agent:thought', { thought: authRetryThought });
        } else {
          // Forward non-401 API errors (429, 500, overloaded, etc.) to user
          console.warn(
            `[Agent][${conversationId}] API error: status=${errorStatus}, error=${error}, attempt=${attempt ?? '?'}/${maxRetries ?? '?'}`,
          );
          const apiErrorThought: Thought = {
            id: `thought-api-warning-${Date.now()}`,
            type: 'system',
            content: `API 错误 (${errorStatus ?? '?'}): ${error ?? 'unknown'}`,
            timestamp: new Date().toISOString(),
          };
          sessionState.thoughts.push(apiErrorThought);
          emit('agent:thought', { thought: apiErrorThought });
        }
        continue;
      }

      // ========== Subagent lifecycle events ==========
      // task_started: SDK spawned a subagent (Agent tool). Create a virtual worker session.
      if (subtype === 'task_started') {
        const taskId = msg.task_id as string;
        const toolUseId = msg.tool_use_id as string | undefined;
        const description = (msg.description as string) || 'Subagent task';
        const agentId = `subagent-${taskId}`;
        const agentName = `Agent: ${description.length > 40 ? description.substring(0, 40) + '...' : description}`;

        const state: SubagentState = {
          taskId,
          toolUseId,
          agentId,
          agentName,
          description,
          status: 'running',
          isComplete: false,
          streamingBlocks: new Map(),
          toolIdToThoughtId: new Map(),
        };
        subagentStates.set(taskId, state);
        if (toolUseId) toolUseIdToTaskId.set(toolUseId, taskId);

        // When a Worker uses SDK Agent/Task tool internally, don't create an extra
        // Worker Tab — the Worker already has its own tab. Only send worker:started
        // for subagents spawned by the Leader (or non-Hyper-Space sessions).
        if (!workerTag) {
          sendToRenderer('worker:started', spaceId, rendererConvId, {
            agentId,
            agentName,
            taskId,
            task: description,
            type: 'local',
          });
        }
        console.log(
          `[Agent][${conversationId}] Subagent started: ${taskId} - ${description.substring(0, 80)}${workerTag ? ' (internal to worker, tab suppressed)' : ''}`,
        );

        // Flush any buffered events that arrived before task_started
        const buffered = pendingSubagentEvents.get(toolUseId || taskId);
        if (buffered) {
          pendingSubagentEvents.delete(toolUseId || taskId);
          for (const { event: bufferedEvent, sdkMessage: bufferedMsg } of buffered) {
            if (!state.isComplete) {
              processSubagentStreamEvent(
                state,
                bufferedEvent,
                bufferedMsg,
                spaceId,
                rendererConvId,
                sessionState,
              );
            }
          }
        }

        continue;
      }

      // task_notification: Subagent completed or failed.
      if (subtype === 'task_notification') {
        const notifTaskId = msg.task_id as string;
        const notifStatus = msg.status as string;
        const subagentState = subagentStates.get(notifTaskId);

        if (subagentState) {
          subagentState.status = notifStatus === 'completed' ? 'completed' : 'failed';
          subagentState.isComplete = true;

          if (notifStatus === 'failed') {
            // Capture actual error detail for cleanup fallback (BUG-003 fix)
            const errorDetail =
              (msg.error as string) || (msg.summary as string) || 'Subagent task failed';
            subagentState.lastError = errorDetail;
          }

          if (!workerTag) {
            sendToRenderer('worker:completed', spaceId, rendererConvId, {
              agentId: subagentState.agentId,
              agentName: subagentState.agentName,
              taskId: notifTaskId,
              result: (msg.summary as string) || '',
              error: notifStatus === 'failed' ? subagentState.lastError : undefined,
              status: notifStatus === 'completed' ? ('completed' as const) : ('failed' as const),
            });
          }
          console.log(`[Agent][${conversationId}] Subagent ${notifTaskId} ${notifStatus}`);
        }
        continue;
      }

      // task_progress: Periodic progress summary (optional, informational only)
      if (subtype === 'task_progress') {
        const progressState = subagentStates.get(msg.task_id as string);
        if (progressState && !progressState.isComplete) {
          const summary = (msg.summary as string) || '';
          if (summary) {
            // Emit as a system thought to show progress in the sub-timeline
            const thought: Thought = {
              id: `thought-subagent-progress-${Date.now()}`,
              type: 'system',
              content: summary,
              timestamp: new Date().toISOString(),
            };
            const workerEmit = (channel: string, data: Record<string, unknown>): void => {
              sendToRenderer(channel, spaceId, rendererConvId, {
                ...data,
                agentId: progressState.agentId,
                agentName: progressState.agentName,
              });
            };
            workerEmit('agent:thought', { thought });
          }
        }
        continue;
      }

      const sessionIdFromMsg =
        msg.session_id || (msg.message as Record<string, unknown>)?.session_id;
      if (sessionIdFromMsg) {
        capturedSessionId = sessionIdFromMsg as string;
        console.debug(`[Agent][${conversationId}] Captured session ID:`, capturedSessionId);
      }

      // Handle compact_boundary - context compression notification
      if (subtype === 'compact_boundary') {
        const compactMetadata = msg.compact_metadata as
          | { trigger: 'manual' | 'auto'; pre_tokens: number }
          | undefined;
        if (compactMetadata) {
          console.debug(
            `[Agent][${conversationId}] Context compressed: trigger=${compactMetadata.trigger}, pre_tokens=${compactMetadata.pre_tokens}`,
          );
          // Send compact notification to renderer
          emit('agent:compact', {
            type: 'compact',
            trigger: compactMetadata.trigger,
            preTokens: compactMetadata.pre_tokens,
          });
        }
      }

      // Extract MCP server status from system init message
      // SDKSystemMessage includes mcp_servers: { name: string; status: string }[]
      const mcpServers = msg.mcp_servers as Array<{ name: string; status: string }> | undefined;
      if (mcpServers && mcpServers.length > 0) {
        if (is.dev) {
          console.log(`[Agent][${conversationId}] MCP server status:`, JSON.stringify(mcpServers));
        }
        // Broadcast MCP status to frontend (global event, not conversation-specific)
        broadcastMcpStatus(mcpServers);
      }

      // Also capture tools list if available
      const tools = msg.tools as string[] | undefined;
      if (tools) {
        console.debug(`[Agent][${conversationId}] Available tools: ${tools.length}`);
      }
    } else if (sdkMessage.type === 'result') {
      receivedResult = true; // Mark that we received a result message
      if (!capturedSessionId) {
        const sessionIdFromMsg =
          msg.session_id || (msg.message as Record<string, unknown>)?.session_id;
        capturedSessionId = sessionIdFromMsg as string;
      }

      // Check for error_during_execution (interrupted) vs real errors
      // Note: Real API errors (is_error=true) are already handled by parseSDKMessage above
      // which creates an error thought and triggers agent:error via the thought.type === 'error' branch
      const isError = (sdkMessage as any).is_error === true;
      if (isError) {
        const errors = (sdkMessage as any).errors as unknown[] | undefined;
        console.log(
          `[Agent][${conversationId}] ⚠️ SDK error (is_error=${isError}, errors=${errors?.length || 0}): ${((sdkMessage as any).result || '').substring(0, 200)}`,
        );
      } else if ((sdkMessage as any).subtype === 'error_during_execution') {
        // Mark as interrupted - will be used for empty response handling
        hadErrorDuringExecution = true;
        console.log(
          `[Agent][${conversationId}] SDK result subtype=error_during_execution but is_error=false, errors=[] - marked as interrupted`,
        );
      } else if ((sdkMessage as any).subtype === 'error_max_turns') {
        // Session hit the configured maxTurns limit - this is a graceful SDK termination,
        // not an error. Track it so we can show a clear message instead of "empty response".
        hadMaxTurnsReached = true;
        console.log(
          `[Agent][${conversationId}] SDK result subtype=error_max_turns, num_turns=${(sdkMessage as any).num_turns} - session reached turn limit`,
        );
      }

      // Extract token usage from result message
      tokenUsage = extractResultUsage(msg, lastSingleUsage, params.contextWindow);
      if (tokenUsage) {
        console.debug(`[Agent][${conversationId}] Token usage (single API):`, tokenUsage);
      }
    }
  }

  // ========== Stream End Handling ==========

  //
  // Error conditions (truth table):
  // | Case | hasContent | isInterrupted | hasErrorThought | wasAborted | reachedMaxTurns | Send error?      |
  // |------|------------|---------------|-----------------|------------|-----------------|------------------|
  // | 1a   | yes        | -             | -               | yes        | -               | stopped by user  |
  // | 1b   | yes        | yes           | -               | no         | -               | interrupted      |
  // | 2    | yes        | no            | -               | no         | -               | no               |
  // | 3    | no         | yes           | no              | no         | -               | interrupted      |
  // | 4    | no         | no            | no              | no         | no              | empty response   |
  // | 5    | no         | -             | yes             | -          | -               | no               |
  // | 6    | no         | -             | -               | yes        | -               | no               |
  // | 7    | no         | no            | no              | no         | yes             | max turns notice |

  // Merge content: prefer lastTextContent (all accumulated text blocks), fallback to currentStreamingText,
  // final fallback to result thought content (handles Anthropic passthrough where SSE lacks text_delta)
  const resultThoughtContent =
    sessionState.thoughts.find((t: Thought) => t.type === 'result')?.content || '';
  const finalContent = lastTextContent || currentStreamingText || resultThoughtContent || '';
  const wasAborted = abortController.signal.aborted;

  // Finalize subagent thoughts for persistence: remove streaming state
  sessionState.thoughts.forEach((thought) => {
    if (thought.agentId) {
      thought.isStreaming = false;
      if (thought.type === 'tool_use') {
        thought.isReady = true;
      }
    }
  });

  // Clean up any active subagents that didn't complete (interrupted/aborted streams)
  subagentStates.forEach((state, taskId) => {
    if (!state.isComplete) {
      const errorDetail = state.lastError || (wasAborted ? 'Stopped by user' : 'Stream interrupted');
      sendToRenderer('worker:completed', spaceId, rendererConvId, {
        agentId: state.agentId,
        agentName: state.agentName,
        taskId,
        result: '',
        error: errorDetail,
        status: 'failed',
      });
      console.debug(`[Agent][${conversationId}] Subagent ${taskId} cleaned up (stream ended)`);
    }
  });

  const hasErrorThought = sessionState.thoughts.some((t: Thought) => t.type === 'error');
  // Two independent interrupt reasons: SDK reported error_during_execution, or stream ended unexpectedly
  const isInterrupted = !receivedResult || hadErrorDuringExecution;

  // Find the error thought for callers
  const errorThought = hasErrorThought
    ? sessionState.thoughts.find((t: Thought) => t.type === 'error')
    : undefined;

  // Log content source for debugging
  if (finalContent) {
    const contentSource = lastTextContent ? 'lastTextContent' : 'currentStreamingText (fallback)';
    console.debug(
      `[Agent][${conversationId}] Stream content from ${contentSource}: ${finalContent.length} chars`,
    );
  } else {
    console.debug(`[Agent][${conversationId}] No content from stream`);
  }
  if (hasErrorThought) {
    console.debug(`[Agent][${conversationId}] Error thought present: ${errorThought?.content}`);
  }

  // Build the result object
  // Check for pending injection - either detected at turn boundary or queued at end
  // Use hadPendingInjection (set at turn boundary) for accurate turn-level detection
  const hasPendingInjectionFlag = hadPendingInjection || hasPendingInjection(conversationId);

  const result: StreamResult = {
    finalContent,
    thoughts: sessionState.thoughts,
    tokenUsage,
    capturedSessionId,
    isInterrupted,
    wasAborted,
    hasErrorThought,
    errorThought,
    reachedMaxTurns: hadMaxTurnsReached,
    hasPendingInjection: hasPendingInjectionFlag,
    needsAuthRetry: detectedAuthRetry,
  };

  // Notify caller for storage handling
  callbacks.onComplete(result);

  // If there's a pending injection, DON'T send complete event yet
  // The caller will handle continuation and send complete later
  if (hasPendingInjectionFlag) {
    console.debug(`[Agent][${conversationId}] Pending injection detected - deferring agent:complete`);
    return result;
  }

  // Send error BEFORE complete to prevent race condition:
  // handleAgentComplete is async (awaits backend reload), and its final set()
  // would overwrite error:null if error arrived after complete.
  const getInterruptedErrorMessage = (): string | null => {
    if (finalContent) {
      if (wasAborted) return null;
      return isInterrupted ? 'Model response interrupted unexpectedly.' : null;
    } else {
      if (hasErrorThought || wasAborted) return null;
      if (hadMaxTurnsReached) return 'Reached the maximum turn limit. Send a message to continue.';
      return isInterrupted
        ? 'Model response interrupted unexpectedly.'
        : `Unexpected empty response. ${FALLBACK_ERROR_HINT}`;
    }
  };

  const errorMessage = getInterruptedErrorMessage();
  if (errorMessage) {
    const reason = hadMaxTurnsReached
      ? 'max_turns'
      : isInterrupted
        ? hadErrorDuringExecution
          ? 'error_during_execution'
          : 'stream interrupted'
        : 'empty response';
    console.log(
      `[Agent][${conversationId}] Sending interrupted error (${reason}, content: ${finalContent ? 'yes' : 'no'})`,
    );
    emit('agent:error', {
      type: 'error',
      errorType: 'interrupted',
      error: errorMessage,
    });
  } else if (wasAborted) {
    console.debug(`[Agent][${conversationId}] User stopped - no error sent`);
  }

  // Send final local estimation if no API usage was received
  // This ensures the UI has a context value even for non-Anthropic models
  if (!receivedApiUsage && !params.suppressComplete && estimatedStreamingTokens > 0) {
    emit('agent:context-usage', {
      type: 'context-usage',
      isEstimate: true,
      estimatedTokens: estimatedStreamingTokens,
      inputTokens: estimatedStreamingTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: params.contextWindow || 200000,
    });
  }

  // Always send complete event to unblock frontend
  // (unless suppressed for worker subtasks in Hyper Space)
  if (!params.suppressComplete) {
    emit('agent:complete', {
      type: 'complete',
      duration: 0,
      tokenUsage,
    });
  }

  return result;
}
