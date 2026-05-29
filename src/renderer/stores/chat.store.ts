/**
 * Chat Store - Conversation and messaging state
 *
 * Architecture:
 * - spaceStates: Map<spaceId, SpaceState> - conversation metadata organized by space
 * - conversationCache: Map<conversationId, Conversation> - full conversations loaded on-demand
 * - sessions: Map<conversationId, SessionState> - runtime state per conversation (cross-space)
 * - currentSpaceId: pointer to active space
 *
 * Performance optimization:
 * - listConversations returns lightweight ConversationMeta (no messages)
 * - Full conversation loaded on-demand when selecting
 * - LRU cache for recently accessed conversations
 *
 * This allows:
 * - Fast space switching (only metadata loaded)
 * - Space switching without losing session states
 * - Multiple conversations running in parallel across spaces
 * - Clean separation of concerns
 */

import { create } from 'zustand';
import { api } from '../api';
import type {
  Conversation,
  ConversationMeta,
  Message,
  ToolCall,
  Artifact,
  Thought,
  AgentEventBase,
  ImageAttachment,
  CompactInfo,
  CanvasContext,
  AgentErrorType,
  PendingQuestion,
  ToolPermissionRequest,
  Question,
  TaskStatus,
  PulseItem,
} from '../types';
import { PULSE_READ_GRACE_PERIOD_MS } from '../types';
import { useSkillStore } from './skill/skill.store';
import { useCanvasStore } from './canvas.store';
import { getActionSummary, getStepCounts } from '../components/chat/thought-utils';
import { useTerminalStore } from './terminal.store';
import { useSpaceStore } from './space.store';
import i18n from '../i18n';

// LRU cache size limit
const CONVERSATION_CACHE_SIZE = 10;

// Store-level timer for pulseReadAt cleanup (independent of UI components)
let _pulseCleanupTimer: ReturnType<typeof setTimeout> | null = null;

// Inactivity timeout: if no backend events for this long, show error to user
const INACTIVITY_TIMEOUT_MS = 30_000;
const INACTIVITY_CHECK_INTERVAL_MS = 5_000;
let inactivityTimerId: ReturnType<typeof setInterval> | null = null;

function clearInactivityTimer() {
  if (inactivityTimerId) {
    clearInterval(inactivityTimerId);
    inactivityTimerId = null;
  }
}

function startInactivityTimer(conversationId: string) {
  clearInactivityTimer();
  inactivityTimerId = setInterval(() => {
    const session = useChatStore.getState().sessions.get(conversationId);
    if (!session?.isGenerating || !session.lastActivityAt) {
      clearInactivityTimer();
      return;
    }
    if (Date.now() - session.lastActivityAt > INACTIVITY_TIMEOUT_MS) {
      clearInactivityTimer();
      useChatStore.getState().handleAgentError({
        conversationId,
        spaceId: '',
        error: i18n.t(
          'AI response timed out: no response received for a long time. This may be a network connection issue. Please check your network proxy settings and try again.',
        ),
        errorType: undefined,
      });
      api.stopGeneration(conversationId).catch(() => {});
    }
  }, INACTIVITY_CHECK_INTERVAL_MS);
}

// Extract canvas context for AI awareness (single definition, used in sendMessage paths)
function buildCanvasContext(): CanvasContext | undefined {
  const cs = useCanvasStore.getState();
  if (!cs.isOpen || cs.tabs.length === 0) return undefined;

  const activeTab = cs.getActiveTab();
  return {
    isOpen: true,
    tabCount: cs.tabs.length,
    activeTab: activeTab
      ? {
          type: activeTab.type,
          title: activeTab.title,
          url: activeTab.url,
          path: activeTab.path,
        }
      : null,
    tabs: cs.tabs.map((t) => ({
      type: t.type,
      title: t.title,
      url: t.url,
      path: t.path,
      isActive: t.id === cs.activeTabId,
    })),
  };
}

// Per-space state (conversations metadata belong to a space)
interface SpaceState {
  conversations: ConversationMeta[]; // Lightweight metadata, no messages
  currentConversationId: string | null;
  // HyperSpace: worker conversation metadata grouped by parent conversation ID
  workerConversations: Map<string, WorkerConversationMeta[]>;
}

// Worker conversation metadata — persisted child conversation visible in sidebar
export interface WorkerConversationMeta {
  id: string; // Full child conversation ID (e.g., "uuid:agent-worker-1")
  title: string; // Worker display name
  agentId: string; // Agent identifier extracted from the ID
  parentConversationId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// Pending message in queue (waiting for current generation to complete)
interface PendingMessage {
  id: string;
  content: string;
  images?: ImageAttachment[];
  thinkingEnabled?: boolean;
  aiBrowserEnabled?: boolean;
  agentId?: string; // Target agent ID for Hyper Space
  activeKnowledgeBases?: string[]; // Active knowledge base IDs
  timestamp: number;
}

// Per-session runtime state (isolated per conversation, persists across space switches)
interface SessionState {
  isGenerating: boolean;
  isStopping: boolean; // True when user clicked stop, waiting for cleanup
  streamingContent: string;
  isStreaming: boolean; // True during token-level text streaming
  thoughts: Thought[];
  isThinking: boolean;
  pendingToolApproval: ToolCall | null;
  error: string | null;
  errorType: AgentErrorType | null; // Special error type for custom UI handling
  // Agent elapsed time and idle timeout
  agentElapsedTime: number | null;
  agentCurrentTool: string | null;
  idleTimeout: { idleMinutes: number; triggeredAt: number } | null;
  // Compact notification
  compactInfo: CompactInfo | null;
  // Current context usage (real-time update from agent:context-usage and agent:complete)
  currentContextUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
  } | null;
  // Text block version - increments on each new text block (for StreamingBubble reset)
  textBlockVersion: number;
  // Pending question from AskUserQuestion tool
  pendingQuestion: PendingQuestion | null;
  // Pending tool permission request (high-risk tools)
  pendingToolPermission: ToolPermissionRequest | null;
  // Pending messages queue - messages waiting for current generation to complete
  pendingMessages: PendingMessage[];
  // Hyper Space: Worker session states keyed by agentId
  workerSessions: Map<string, WorkerSessionState>;
  // Inactivity detection: last time a backend event was received
  lastActivityAt: number | null;
  // Worker context captured when Leader stream is interrupted (for "continue" recovery)
  interruptWorkerContext?: import('../../shared/types/hyper-space').InterruptWorkerContext;
}

// Worker session state — isolated streaming state for each active worker
export interface WorkerSessionState {
  agentId: string;
  agentName: string;
  taskId: string | null;
  task: string;
  isRunning: boolean;
  status: 'running' | 'completed' | 'failed';
  streamingContent: string;
  isStreaming: boolean;
  thoughts: Thought[];
  isThinking: boolean;
  textBlockVersion: number;
  error: string | null;
  completedAt: number | null;
  type?: 'local' | 'remote';
  serverName?: string;
  // AskUserQuestion support — set when a worker agent needs user input
  pendingQuestion: PendingQuestion | null;
  // Child conversation ID for loading persisted message history
  childConversationId?: string;
  // How the worker was triggered:
  // 'mention': User @mentioned in main conversation; output shows inline in main view
  // 'delegation': Leader spawned via spawn_subagent; output shows ONLY in worker tab
  interactionMode?: 'mention' | 'delegation';
  // Timestamp of when the current turn started — used by WorkerView to detect
  // new turns and reload multi-turn history from the child conversation
  turnStartedAt: number;
}

// Throttle state for worker streaming updates (avoids excessive set() calls per token delta)
const workerStreamThrottleMap = new Map<string, number>(); // key -> last flush timestamp
const workerStreamThrottleTimers = new Map<string, NodeJS.Timeout>();
const workerStreamPendingDeltas = new Map<
  string,
  {
    delta: string;
    content: string;
    isComplete?: boolean;
    isStreaming?: boolean;
    isNewTextBlock?: boolean;
  }
>();

/**
 * Create a temporary WorkerSessionState for auto-create scenarios.
 * Ensures all fields (including childConversationId) are properly initialized.
 */
function createTemporaryWorkerSession(
  agentId: string,
  agentName: string,
  parentConvId: string,
): WorkerSessionState {
  return {
    agentId,
    agentName,
    taskId: null,
    task: '',
    isRunning: true,
    status: 'running',
    streamingContent: '',
    isStreaming: false,
    thoughts: [],
    isThinking: false,
    textBlockVersion: 0,
    error: null,
    completedAt: null,
    childConversationId: `${parentConvId}:agent-${agentId}`,
    interactionMode: 'delegation',
    turnStartedAt: 0,
  };
}

/**
 * Flush a throttled worker stream update into the Zustand store.
 * This is called from within handleAgentMessage and has access to `set` via closure.
 */
function applyWorkerStreamUpdate(
  set: (fn: (state: any) => any) => void,
  conversationId: string,
  agentId: string,
  pending: {
    delta: string;
    content: string;
    isComplete?: boolean;
    isStreaming?: boolean;
    isNewTextBlock?: boolean;
  },
  rawData: any,
): void {
  set((state: any) => {
    const newSessions = new Map(state.sessions);
    const session = resolveSessionId(newSessions, conversationId);
    if (!session) {
      console.warn(
        `[ChatStore] applyWorkerStreamUpdate: no session for ${conversationId}, event dropped (agent=${agentId})`,
      );
      return state;
    }

    const parentConvId = baseConvId(conversationId);
    const newWorkerSessions = new Map(session.workerSessions);
    const ws = newWorkerSessions.get(agentId);
    let workerSession: WorkerSessionState;
    if (ws) {
      // If existing session was auto-created (no childConversationId), patch it
      if (!ws.childConversationId) {
        workerSession = { ...ws, childConversationId: `${parentConvId}:agent-${agentId}` };
      } else {
        workerSession = ws;
      }
    } else {
      workerSession = createTemporaryWorkerSession(
        agentId,
        rawData.agentName || agentId,
        parentConvId,
      );
    }

    const newTextBlockVersion = pending.isNewTextBlock
      ? (workerSession.textBlockVersion || 0) + 1
      : workerSession.textBlockVersion || 0;

    const newContent = pending.delta
      ? (workerSession.streamingContent || '') + pending.delta
      : pending.content || workerSession.streamingContent;

    const shouldStream = pending.isComplete ? false : (pending.isStreaming ?? false);

    newWorkerSessions.set(agentId, {
      ...workerSession,
      streamingContent: newContent,
      isStreaming: shouldStream,
      textBlockVersion: newTextBlockVersion,
    });
    newSessions.set(parentConvId, { ...session, workerSessions: newWorkerSessions });

    // For mention-mode workers, also update the main session's streaming content
    // so the worker's response appears inline in the main message list
    if (workerSession.interactionMode === 'mention' && pending.delta) {
      const mainSession = newSessions.get(parentConvId);
      if (mainSession) {
        newSessions.set(parentConvId, {
          ...mainSession,
          streamingContent: (mainSession.streamingContent || '') + pending.delta,
          isStreaming: !pending.isComplete,
        });
      }
    }

    return { sessions: newSessions };
  });
}

/**
 * Resolve the base conversationId for session lookup.
 * In Hyper Space, events from the backend carry child conversationIds like
 * "uuid:agent-leader-1" but the frontend stores sessions under the parent
 * conversationId ("uuid"). This helper strips the ":agent-*" suffix and
 * falls back to the original if no match is found.
 */
function resolveSessionId(
  sessions: Map<string, SessionState>,
  conversationId: string,
): SessionState | undefined {
  return sessions.get(conversationId) || sessions.get(conversationId.replace(/:agent-[^:]+$/, ''));
}

/** Get the base conversationId (strip :agent-* suffix for Hyper Space session key) */
function baseConvId(conversationId: string): string {
  return conversationId.replace(/:agent-[^:]+$/, '');
}

// Create empty session state
function createEmptySessionState(): SessionState {
  return {
    isGenerating: false,
    isStopping: false,
    streamingContent: '',
    isStreaming: false,
    thoughts: [],
    isThinking: false,
    pendingToolApproval: null,
    error: null,
    errorType: null,
    agentElapsedTime: null,
    agentCurrentTool: null,
    idleTimeout: null,
    compactInfo: null,
    currentContextUsage: null,
    textBlockVersion: 0,
    pendingQuestion: null,
    pendingToolPermission: null,
    pendingMessages: [],
    workerSessions: new Map(),
    lastActivityAt: null,
  };
}

// Create empty space state
function createEmptySpaceState(): SpaceState {
  return {
    conversations: [],
    currentConversationId: null,
    workerConversations: new Map(),
  };
}

interface ChatState {
  // Per-space state: Map<spaceId, SpaceState>
  spaceStates: Map<string, SpaceState>;

  // Conversation cache: Map<conversationId, Conversation>
  // Full conversations loaded on-demand, with LRU eviction
  conversationCache: Map<string, Conversation>;

  // Per-session runtime state: Map<conversationId, SessionState>
  // This persists across space switches - background tasks keep running
  sessions: Map<string, SessionState>;

  // Pulse: tracks conversations that completed while user was not viewing them
  // Map<conversationId, { spaceId: string; title: string }>
  unseenCompletions: Map<string, { spaceId: string; title: string }>;

  // Pulse: tracks read timestamps for grace period display (60s before removal)
  // Map<conversationId, { readAt: number; originalStatus: 'completed-unseen' | 'error'; spaceId: string; title: string }>
  pulseReadAt: Map<
    string,
    { readAt: number; originalStatus: 'completed-unseen' | 'error'; spaceId: string; title: string }
  >;

  // Current space pointer
  currentSpaceId: string | null;

  // Pulse: pending cross-space navigation target (set by navigateToConversation, consumed by SpacePage init)
  pendingPulseNavigation: string | null;

  // Artifacts (per space)
  artifacts: Artifact[];

  // Loading
  isLoading: boolean;
  isLoadingConversation: boolean; // Loading full conversation

  // Computed getters
  getCurrentSpaceState: () => SpaceState;
  getSpaceState: (spaceId: string) => SpaceState;
  getCurrentConversation: () => Conversation | null;
  getCurrentConversationMeta: () => ConversationMeta | null;
  getCurrentSession: () => SessionState;
  getSession: (conversationId: string) => SessionState;
  getConversations: () => ConversationMeta[];
  getCurrentConversationId: () => string | null;
  getCachedConversation: (conversationId: string) => Conversation | null;
  loadWorkerConversation: (spaceId: string, childConversationId: string) => Promise<boolean>;
  rebuildWorkerSessions: (spaceId: string, conversationId: string) => Promise<void>;

  // Space actions
  setCurrentSpace: (spaceId: string) => void;

  // Conversation actions
  loadConversations: (spaceId: string) => Promise<void>;
  preloadAllSpaceConversations: (spaceIds: string[]) => void;
  createConversation: (spaceId: string) => Promise<Conversation | null>;
  selectConversation: (conversationId: string) => void;
  deleteConversation: (spaceId: string, conversationId: string) => Promise<boolean>;
  renameConversation: (
    spaceId: string,
    conversationId: string,
    newTitle: string,
  ) => Promise<boolean>;
  toggleStarConversation: (
    spaceId: string,
    conversationId: string,
    starred: boolean,
  ) => Promise<boolean>;

  // Messaging
  sendMessage: (
    content: string,
    images?: ImageAttachment[],
    aiBrowserEnabled?: boolean,
    thinkingEnabled?: boolean,
    agentId?: string,
    activeKnowledgeBases?: string[],
  ) => Promise<void>;
  stopGeneration: (conversationId?: string) => Promise<void>;

  // Tool approval
  approveTool: (conversationId: string) => Promise<void>;
  rejectTool: (conversationId: string) => Promise<void>;

  // Error handling
  continueAfterInterrupt: (conversationId: string) => void;

  // Interrupt context handling
  handleInterruptContext: (
    conversationId: string,
    context: import('../../shared/types/hyper-space').InterruptWorkerContext,
  ) => void;

  // Clear pending messages
  clearPendingMessages: (conversationId: string) => void;
  removePendingMessage: (conversationId: string, messageId: string) => void;

  // Event handlers (called from App component) - with session IDs
  handleAgentMessage: (data: AgentEventBase & { content: string; isComplete: boolean }) => void;
  handleAgentToolCall: (data: AgentEventBase & ToolCall) => void;
  handleAgentToolResult: (
    data: AgentEventBase & { toolId: string; result: string; isError: boolean },
  ) => void;
  handleAgentError: (data: AgentEventBase & { error: string; errorType?: AgentErrorType }) => void;
  handleAgentStreamAlive: (data: AgentEventBase & { elapsedMs: number; currentToolName?: string; currentToolElapsedMs?: number }) => void;
  handleAgentIdleTimeout: (data: AgentEventBase & { idleMinutes: number }) => void;
  resolveIdleTimeout: (conversationId: string) => Promise<void>;
  forceIdleTimeout: (conversationId: string) => Promise<void>;
  handleAgentComplete: (data: AgentEventBase & { tokenUsage?: TokenUsage | null }) => void;
  handleAgentThought: (data: AgentEventBase & { thought: Thought }) => void;
  handleAgentThoughtDelta: (
    data: AgentEventBase & {
      thoughtId: string;
      delta?: string;
      content?: string;
      toolInput?: Record<string, unknown>;
      isComplete?: boolean;
      isReady?: boolean;
      isToolInput?: boolean;
      toolResult?: { output: string; isError: boolean; timestamp: string };
      isToolResult?: boolean;
    },
  ) => void;
  handleAgentCompact: (
    data: AgentEventBase & { trigger: 'manual' | 'auto'; preTokens: number },
  ) => void;
  handleAgentContextUsage: (
    data: AgentEventBase & {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      contextWindow?: number;
    },
  ) => void;

  // AskUserQuestion handlers
  handleAskQuestion: (
    data: AgentEventBase & {
      id: string;
      questions: Question[];
      agentId?: string;
      agentName?: string;
    },
  ) => void;
  answerQuestion: (conversationId: string, answers: Record<string, string>) => Promise<void>;
  answerWorkerQuestion: (
    parentConversationId: string,
    agentId: string,
    answers: Record<string, string>,
  ) => Promise<void>;

  // Hyper Space handlers
  handleHyperSpaceProgress: (data: {
    spaceId: string;
    conversationId: string;
    taskId: string;
    agentId: string;
    delta: string;
    timestamp: number;
  }) => void;

  // Worker lifecycle handlers
  handleWorkerStarted: (data: {
    spaceId: string;
    conversationId: string;
    agentId: string;
    agentName: string;
    taskId: string;
    task: string;
    type?: 'local' | 'remote';
    serverName?: string;
  }) => void;
  handleWorkerCompleted: (data: {
    spaceId: string;
    conversationId: string;
    agentId: string;
    agentName: string;
    taskId: string;
    result?: string;
    error?: string;
    status: 'completed' | 'failed';
  }) => void;

  // Agent Team Message handler
  handleAgentTeamMessage: (
    data: AgentEventBase & {
      id: string;
      type: 'agent_message';
      recipientId: string;
      recipientName: string;
      content: string;
      summary: string;
      timestamp: number;
    },
  ) => void;

  // Thoughts lazy loading
  loadMessageThoughts: (
    spaceId: string,
    conversationId: string,
    messageId: string,
  ) => Promise<Thought[]>;

  // Pulse cleanup
  cleanupPulseReadAt: () => void;

  // Derived pulse state (cached, recalculated only when pulse-relevant fields change)
  _pulseItems: PulseItem[];
  _pulseCount: number;

  // Hyper Space Agent Panel
  activeAgentId: string | null; // Currently selected agent (null = Leader)
  activatedAgentIds: Set<string>; // Agents highlighted by leader activation

  setActiveAgentId: (agentId: string | null) => void;
  activateAgent: (agentId: string) => void;
  deactivateAgent: (agentId: string) => void;

  // Cleanup
  reset: () => void;
  resetSpace: (spaceId: string) => void;
}

// Default empty states
const EMPTY_SESSION: SessionState = createEmptySessionState();
const EMPTY_SPACE_STATE: SpaceState = createEmptySpaceState();

export const useChatStore = create<ChatState>((set, get) => ({
  // Initial state
  spaceStates: new Map<string, SpaceState>(),
  conversationCache: new Map<string, Conversation>(),
  sessions: new Map<string, SessionState>(),
  unseenCompletions: new Map<string, { spaceId: string; title: string }>(),
  pulseReadAt: new Map<
    string,
    { readAt: number; originalStatus: 'completed-unseen' | 'error'; spaceId: string; title: string }
  >(),
  currentSpaceId: null,
  pendingPulseNavigation: null,
  artifacts: [],
  isLoading: false,
  isLoadingConversation: false,
  _pulseItems: [],
  _pulseCount: 0,

  // Hyper Space Agent Panel state
  activeAgentId: null,
  activatedAgentIds: new Set<string>(),

  // Get current space state
  getCurrentSpaceState: () => {
    const { spaceStates, currentSpaceId } = get();
    if (!currentSpaceId) return EMPTY_SPACE_STATE;
    return spaceStates.get(currentSpaceId) || EMPTY_SPACE_STATE;
  },

  // Get space state by ID
  getSpaceState: (spaceId: string) => {
    const { spaceStates } = get();
    return spaceStates.get(spaceId) || EMPTY_SPACE_STATE;
  },

  // Get current conversation (full, from cache)
  getCurrentConversation: () => {
    const spaceState = get().getCurrentSpaceState();
    if (!spaceState.currentConversationId) return null;
    return get().conversationCache.get(spaceState.currentConversationId) || null;
  },

  // Get current conversation metadata (lightweight)
  getCurrentConversationMeta: () => {
    const spaceState = get().getCurrentSpaceState();
    if (!spaceState.currentConversationId) return null;
    return spaceState.conversations.find((c) => c.id === spaceState.currentConversationId) || null;
  },

  // Get conversations metadata for current space
  getConversations: () => {
    return get().getCurrentSpaceState().conversations;
  },

  // Get current conversation ID
  getCurrentConversationId: () => {
    return get().getCurrentSpaceState().currentConversationId;
  },

  // Get the conversation ID that the terminal should connect to.
  // When a worker is selected (activeAgentId), returns that worker's childConversationId.
  // Otherwise returns the leader's currentConversationId.
  getActiveTerminalConversationId: (spaceId: string) => {
    const { activeAgentId, workerSessions, spaceStates } = get();
    if (activeAgentId) {
      const workerState = workerSessions.get(activeAgentId);
      if (workerState?.childConversationId) {
        return workerState.childConversationId;
      }
    }
    const spaceState = spaceStates.get(spaceId);
    return spaceState?.currentConversationId || '';
  },

  // Get cached conversation by ID
  getCachedConversation: (conversationId: string) => {
    return get().conversationCache.get(conversationId) || null;
  },

  // Get current session state (for the currently viewed conversation)
  getCurrentSession: () => {
    const spaceState = get().getCurrentSpaceState();
    if (!spaceState.currentConversationId) return EMPTY_SESSION;
    return get().sessions.get(spaceState.currentConversationId) || EMPTY_SESSION;
  },

  // Get session state for any conversation
  getSession: (conversationId: string) => {
    return get().sessions.get(conversationId) || EMPTY_SESSION;
  },

  // Set current space (called when entering a space)
  setCurrentSpace: (spaceId: string) => {
    set({ currentSpaceId: spaceId });
  },

  // Load conversations for a space (returns lightweight metadata)
  loadConversations: async (spaceId) => {
    try {
      set({ isLoading: true });

      const response = await api.listConversations(spaceId);

      if (response.success && response.data) {
        // Now receives ConversationMeta[] (lightweight, no messages)
        const conversations = response.data as ConversationMeta[];

        set((state) => {
          const newSpaceStates = new Map(state.spaceStates);
          const existingState = newSpaceStates.get(spaceId) || createEmptySpaceState();

          newSpaceStates.set(spaceId, {
            ...existingState,
            conversations,
          });

          return { spaceStates: newSpaceStates };
        });

        // For HyperSpace, also load worker conversations in the background
        const space = useSpaceStore.getState().currentSpace;
        if (space?.spaceType === 'hyper') {
          api
            .listAllWorkerConversations(spaceId)
            .then((workerRes) => {
              if (workerRes.success && workerRes.data) {
                const workerMap = workerRes.data as Record<
                  string,
                  Array<{
                    id: string;
                    title: string;
                    agentId: string;
                    createdAt: string;
                    updatedAt: string;
                    messageCount: number;
                  }>
                >;

                const newWorkerConversations = new Map<string, WorkerConversationMeta[]>();
                for (const [parentConvId, workers] of Object.entries(workerMap)) {
                  if (workers.length > 0) {
                    newWorkerConversations.set(
                      parentConvId,
                      workers.map((w) => ({
                        id: w.id,
                        title: w.title,
                        agentId: w.agentId,
                        parentConversationId: parentConvId,
                        createdAt: w.createdAt,
                        updatedAt: w.updatedAt,
                        messageCount: w.messageCount,
                      })),
                    );
                  }
                }

                if (newWorkerConversations.size > 0) {
                  set((state) => {
                    const newSpaceStates = new Map(state.spaceStates);
                    const existingState = newSpaceStates.get(spaceId);
                    if (existingState) {
                      newSpaceStates.set(spaceId, {
                        ...existingState,
                        workerConversations: newWorkerConversations,
                      });
                    }
                    return { spaceStates: newSpaceStates };
                  });
                }
              }
            })
            .catch((err) => console.error('[ChatStore] Failed to load worker conversations:', err));
        }
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  // Preload conversation metadata for all spaces (background, non-blocking).
  // Ensures PULSE can see starred conversations from spaces the user hasn't visited yet.
  preloadAllSpaceConversations: (spaceIds: string[]) => {
    const { spaceStates } = get();
    const unloaded = spaceIds.filter((id) => !spaceStates.has(id));
    if (unloaded.length === 0) return;

    // Fire-and-forget: load each unloaded space in parallel
    for (const spaceId of unloaded) {
      api
        .listConversations(spaceId)
        .then((response) => {
          if (response.success && response.data) {
            const conversations = response.data as ConversationMeta[];
            set((state) => {
              // Don't overwrite if another load already populated this space
              if (state.spaceStates.has(spaceId)) return state;
              const newSpaceStates = new Map(state.spaceStates);
              newSpaceStates.set(spaceId, {
                conversations,
                currentConversationId: null,
              });
              return { spaceStates: newSpaceStates };
            });
          }
        })
        .catch((err) => console.error(`[ChatStore] Preload failed for space ${spaceId}:`, err));
    }
  },

  // Create new conversation
  createConversation: async (spaceId) => {
    try {
      const response = await api.createConversation(spaceId);

      if (response.success && response.data) {
        const newConversation = response.data as Conversation;

        // Extract metadata for the list
        const meta: ConversationMeta = {
          id: newConversation.id,
          spaceId: newConversation.spaceId,
          title: newConversation.title,
          createdAt: newConversation.createdAt,
          updatedAt: newConversation.updatedAt,
          messageCount: newConversation.messages?.length || 0,
          preview: undefined,
        };

        set((state) => {
          const newSpaceStates = new Map(state.spaceStates);
          const existingState = newSpaceStates.get(spaceId) || createEmptySpaceState();

          // Add to conversation cache (new conversation is full)
          const newCache = new Map(state.conversationCache);
          newCache.set(newConversation.id, newConversation);

          // LRU eviction
          if (newCache.size > CONVERSATION_CACHE_SIZE) {
            const firstKey = newCache.keys().next().value;
            if (firstKey) newCache.delete(firstKey);
          }

          newSpaceStates.set(spaceId, {
            conversations: [meta, ...existingState.conversations],
            currentConversationId: newConversation.id,
          });

          return { spaceStates: newSpaceStates, conversationCache: newCache };
        });

        // Warm up V2 Session for new conversation - non-blocking
        // This ensures first message doesn't have cold start delay
        try {
          api
            .ensureSessionWarm(spaceId, newConversation.id)
            .catch((error) => console.error('[ChatStore] Session warm up failed:', error));
        } catch (error) {
          console.error('[ChatStore] Failed to trigger session warm up:', error);
        }

        // Reset knowledge base selection to all enabled KBs for new conversation
        const { useKnowledgeBaseStore } = await import('./knowledge-base.store');
        useKnowledgeBaseStore.getState().onConversationCreated(newConversation.id);

        return newConversation;
      }

      return null;
    } catch (error) {
      console.error('Failed to create conversation:', error);
      return null;
    }
  },

  // Select conversation (changes pointer, loads full conversation on-demand)
  selectConversation: async (conversationId) => {
    const { currentSpaceId, spaceStates, conversationCache } = get();
    if (!currentSpaceId) return;

    const spaceState = spaceStates.get(currentSpaceId);
    if (!spaceState) return;

    const conversationMeta = spaceState.conversations.find((c) => c.id === conversationId);
    if (!conversationMeta) return;

    // If Canvas is open, close it before switching conversations
    // This ensures clean terminal state for the new conversation
    const canvasState = useCanvasStore.getState();
    if (canvasState.isOpen) {
      canvasState.setOpen(false);
    }

    // Subscribe to conversation events (for remote mode).
    // Fire-and-forget is fine here — if this subscription races with a subsequent
    // sendMessage, sendMessage will await its own subscription with ack.
    api.subscribeToConversation(conversationId).catch(() => {});

    // Switch terminal state to the new conversation
    useTerminalStore.getState().switchConversation(conversationId);

    // Reset agent view to main when switching conversations
    set({ activeAgentId: null });

    // Restore per-conversation knowledge base selection
    const { useKnowledgeBaseStore } = await import('./knowledge-base.store');
    useKnowledgeBaseStore.getState().onConversationSwitched(conversationId);

    // Update the pointer + move unseen/error items to readAt grace period
    set((state) => {
      const newSpaceStates = new Map(state.spaceStates);
      newSpaceStates.set(currentSpaceId, {
        ...spaceState,
        currentConversationId: conversationId,
      });

      const newUnseenCompletions = new Map(state.unseenCompletions);
      const newPulseReadAt = new Map(state.pulseReadAt);
      const newSessions = new Map(state.sessions);
      const now = Date.now();

      // If this conversation had an unseen completion, move to readAt grace period
      const unseenInfo = newUnseenCompletions.get(conversationId);
      if (unseenInfo) {
        newPulseReadAt.set(conversationId, {
          readAt: now,
          originalStatus: 'completed-unseen',
          spaceId: unseenInfo.spaceId,
          title: unseenInfo.title,
        });
        newUnseenCompletions.delete(conversationId);
      }

      // If this conversation had an error session, move to readAt grace period and clear session error
      // The error is now persisted in message.error and will render from MessageItem on reload
      const session = newSessions.get(conversationId);
      if (session?.error && session.errorType !== 'interrupted') {
        // Find conversation meta for title/spaceId
        let meta: ConversationMeta | undefined;
        for (const [, ss] of state.spaceStates) {
          meta = ss.conversations.find((c) => c.id === conversationId);
          if (meta) break;
        }
        newPulseReadAt.set(conversationId, {
          readAt: now,
          originalStatus: 'error',
          spaceId: meta?.spaceId || currentSpaceId,
          title: meta?.title || 'Conversation',
        });
        // Clear session error — persisted error in message.error handles display after reload
        newSessions.set(conversationId, {
          ...session,
          error: null,
          errorType: null,
        });
      }

      return {
        spaceStates: newSpaceStates,
        unseenCompletions: newUnseenCompletions,
        pulseReadAt: newPulseReadAt,
        sessions: newSessions,
      };
    });

    // Ensure store-level cleanup is scheduled (independent of sidebar mount state)
    get().cleanupPulseReadAt();

    // Load full conversation if not in cache
    if (!conversationCache.has(conversationId)) {
      set({ isLoadingConversation: true });
      console.log(`[ChatStore] Loading full conversation: ${conversationId}`);

      try {
        const response = await api.getConversation(currentSpaceId, conversationId);
        if (response.success && response.data) {
          const fullConversation = response.data as Conversation;

          set((state) => {
            const newCache = new Map(state.conversationCache);
            newCache.set(conversationId, fullConversation);

            // LRU eviction
            if (newCache.size > CONVERSATION_CACHE_SIZE) {
              const firstKey = newCache.keys().next().value;
              if (firstKey) newCache.delete(firstKey);
            }

            return { conversationCache: newCache, isLoadingConversation: false };
          });
          console.log(
            `[ChatStore] Loaded conversation with ${fullConversation.messages?.length || 0} messages`,
          );
        } else {
          set({ isLoadingConversation: false });
        }
      } catch (error) {
        console.error('[ChatStore] Failed to load conversation:', error);
        set({ isLoadingConversation: false });
      }
    }

    // Check if this conversation has an active session and recover thoughts
    // This handles page refresh during active generation - backend still has active session
    // but frontend state was lost, so we need to restore it
    try {
      const response = await api.getSessionState(conversationId);
      if (response.success && response.data) {
        const sessionState = response.data as {
          isActive: boolean;
          thoughts: Thought[];
          streamingContent?: string;
          spaceId?: string;
        };

        // If backend reports active session, restore frontend state
        // This handles page refresh during streaming - we need to set isGenerating=true
        // so that subsequent stream events are not ignored
        // CRITICAL: Only recover if there's actual streaming content in progress
        // If isActive but no streamingContent, the conversation likely completed but backend
        // session hasn't been cleaned up yet - don't restore generating state in this case
        if (sessionState.isActive) {
          const hasThoughts = sessionState.thoughts.length > 0;
          const hasStreamingContent = (sessionState.streamingContent?.length ?? 0) > 0;
          console.log(
            `[ChatStore] Recovering active session for conversation ${conversationId}: ${hasThoughts ? `${sessionState.thoughts.length} thoughts` : 'no thoughts yet'}${hasStreamingContent ? `, ${sessionState.streamingContent!.length} chars streaming` : ''}`,
          );

          set((state) => {
            const newSessions = new Map(state.sessions);
            const existingSession = newSessions.get(conversationId) || createEmptySessionState();

            // IMPORTANT: If frontend already has an active session, preserve its state.
            // This handles the case when user switches away from a generating conversation
            // and switches back - the frontend state is accurate and shouldn't be overwritten
            // by backend state which might be stale or incomplete.
            // Only recover from backend when frontend state is missing (e.g., page refresh).
            // NOTE: We check isGenerating only (not streamingContent) because in early
            // "thinking" phase, streamingContent is empty but the session is still active.
            const frontendHasActiveSession = existingSession.isGenerating;

            // Use frontend state if available, otherwise use backend state
            const effectiveStreamingContent = frontendHasActiveSession
              ? existingSession.streamingContent
              : sessionState.streamingContent || '';
            const effectiveHasStreamingContent = (effectiveStreamingContent?.length ?? 0) > 0;

            // Determine isThinking: prefer frontend state, otherwise check if backend has thoughts
            const effectiveIsThinking = frontendHasActiveSession
              ? existingSession.isThinking
              : hasThoughts;

            // Use frontend thoughts if available, otherwise backend thoughts
            const effectiveThoughts = frontendHasActiveSession
              ? existingSession.thoughts
              : hasThoughts
                ? sessionState.thoughts
                : existingSession.thoughts;

            newSessions.set(conversationId, {
              ...existingSession,
              // CRITICAL: When backend reports isActive, keep isGenerating=true
              // This handles the "thinking" phase where no streamingContent exists yet
              isGenerating: true,
              isStreaming: effectiveHasStreamingContent,
              isThinking: effectiveIsThinking,
              thoughts: effectiveThoughts,
              // Use the effective streaming content determined above
              streamingContent: effectiveStreamingContent,
            });

            return { sessions: newSessions };
          });
        }
      }
    } catch (error) {
      console.error('[ChatStore] Failed to recover session state:', error);
    }

    // Recover worker session states for Hyper Space after page refresh
    try {
      const workerResponse = await api.getHyperSpaceWorkerStates(currentSpaceId);
      if (workerResponse.success && workerResponse.data) {
        const workerStates = workerResponse.data as Array<{
          agentId: string;
          agentName: string;
          status: 'running' | 'completed' | 'failed';
          type: 'local' | 'remote';
          serverName?: string;
          childConversationId?: string;
        }>;

        if (workerStates.length > 0) {
          set((state) => {
            const newSessions = new Map(state.sessions);
            const session = newSessions.get(conversationId);
            if (!session) return state;

            const newWorkerSessions = new Map(session.workerSessions);
            for (const ws of workerStates) {
              // Only recover if no existing worker session (i.e., after refresh)
              if (!newWorkerSessions.has(ws.agentId)) {
                newWorkerSessions.set(ws.agentId, {
                  agentId: ws.agentId,
                  agentName: ws.agentName,
                  taskId: null,
                  task: '',
                  isRunning: ws.status === 'running',
                  status: ws.status,
                  streamingContent: '',
                  isStreaming: false,
                  thoughts: [],
                  isThinking: false,
                  textBlockVersion: 0,
                  error: null,
                  completedAt: ws.status !== 'running' ? Date.now() : null,
                  type: ws.type,
                  serverName: ws.serverName,
                  pendingQuestion: null,
                  childConversationId: ws.childConversationId,
                  turnStartedAt: 0,
                });
              }
            }
            newSessions.set(conversationId, { ...session, workerSessions: newWorkerSessions });
            return { sessions: newSessions };
          });
          console.log(
            `[ChatStore] Recovered ${workerStates.length} worker session(s) after refresh`,
          );
        }
      }
    } catch (error) {
      console.error('[ChatStore] Failed to recover worker session states:', error);
    }

    // Rebuild worker session thoughts from persisted child conversations on disk.
    // This restores the full thought history (tool calls, thinking blocks, etc.)
    // for subagent workers that completed in previous sessions (e.g., after page refresh).
    // Non-blocking — runs in background so it doesn't delay conversation loading.
    get().rebuildWorkerSessions(currentSpaceId, conversationId);

    // Warm up V2 Session in background - non-blocking
    // When user sends a message, V2 Session is ready to avoid delay
    try {
      api
        .ensureSessionWarm(currentSpaceId, conversationId)
        .catch((error) => console.error('[ChatStore] Session warm up failed:', error));
    } catch (error) {
      console.error('[ChatStore] Failed to trigger session warm up:', error);
    }
  },

  // Delete conversation
  deleteConversation: async (spaceId, conversationId) => {
    try {
      const response = await api.deleteConversation(spaceId, conversationId);

      if (response.success) {
        set((state) => {
          // Clean up session state
          const newSessions = new Map(state.sessions);
          newSessions.delete(conversationId);

          // Clean up cache
          const newCache = new Map(state.conversationCache);
          newCache.delete(conversationId);

          // Clean up unseen completions
          const newUnseenCompletions = new Map(state.unseenCompletions);
          newUnseenCompletions.delete(conversationId);

          // Clean up pulse read-at grace period
          const newPulseReadAt = new Map(state.pulseReadAt);
          newPulseReadAt.delete(conversationId);

          // Update space state
          const newSpaceStates = new Map(state.spaceStates);
          const existingState = newSpaceStates.get(spaceId) || createEmptySpaceState();
          const newConversations = existingState.conversations.filter(
            (c) => c.id !== conversationId,
          );

          newSpaceStates.set(spaceId, {
            conversations: newConversations,
            currentConversationId:
              existingState.currentConversationId === conversationId
                ? newConversations[0]?.id || null
                : existingState.currentConversationId,
            workerConversations: existingState.workerConversations,
          });

          // Remove worker conversations for deleted parent
          const newWorkerConvs = new Map(existingState.workerConversations);
          newWorkerConvs.delete(conversationId);
          const updatedSpaceState = newSpaceStates.get(spaceId);
          if (updatedSpaceState) {
            newSpaceStates.set(spaceId, {
              ...updatedSpaceState,
              workerConversations: newWorkerConvs,
            });
          }

          return {
            spaceStates: newSpaceStates,
            sessions: newSessions,
            conversationCache: newCache,
            unseenCompletions: newUnseenCompletions,
            pulseReadAt: newPulseReadAt,
          };
        });

        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      return false;
    }
  },

  // Rename conversation
  renameConversation: async (spaceId, conversationId, newTitle) => {
    try {
      const response = await api.updateConversation(spaceId, conversationId, { title: newTitle });

      if (response.success) {
        set((state) => {
          // Update cache if exists
          const newCache = new Map(state.conversationCache);
          const cached = newCache.get(conversationId);
          if (cached) {
            newCache.set(conversationId, {
              ...cached,
              title: newTitle,
              updatedAt: new Date().toISOString(),
            });
          }

          // Update space state metadata
          const newSpaceStates = new Map(state.spaceStates);
          const existingState = newSpaceStates.get(spaceId);
          if (existingState) {
            newSpaceStates.set(spaceId, {
              ...existingState,
              conversations: existingState.conversations.map((c) =>
                c.id === conversationId
                  ? { ...c, title: newTitle, updatedAt: new Date().toISOString() }
                  : c,
              ),
            });
          }

          return {
            spaceStates: newSpaceStates,
            conversationCache: newCache,
          };
        });

        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to rename conversation:', error);
      return false;
    }
  },

  // Toggle star on a conversation
  toggleStarConversation: async (spaceId, conversationId, starred) => {
    try {
      const response = await api.toggleStarConversation(spaceId, conversationId, starred);
      if (response.success) {
        set((state) => {
          // Update cache if exists
          const newCache = new Map(state.conversationCache);
          const cached = newCache.get(conversationId);
          if (cached) {
            newCache.set(conversationId, { ...cached, starred: starred || undefined });
          }

          // Update space state metadata
          const newSpaceStates = new Map(state.spaceStates);
          const existingState = newSpaceStates.get(spaceId);
          if (existingState) {
            newSpaceStates.set(spaceId, {
              ...existingState,
              conversations: existingState.conversations.map((c) =>
                c.id === conversationId ? { ...c, starred: starred || undefined } : c,
              ),
            });
          }

          return { spaceStates: newSpaceStates, conversationCache: newCache };
        });
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to toggle star:', error);
      return false;
    }
  },

  // Send message (with optional images for multi-modal, optional AI Browser and thinking mode)
  // Supports queuing: if already generating, adds message to pendingMessages queue
  // agentId: target agent for Hyper Space ('leader' for default, or specific agent ID)
  sendMessage: async (content, images, aiBrowserEnabled, thinkingEnabled, agentId, activeKnowledgeBases) => {
    // Detect skill invocation from message content
    const trimmedContent = content.trim();
    const { installedSkills } = useSkillStore.getState();
    const matchedSkill = installedSkills.find((s) => {
      if (!s.enabled || !s.spec.trigger_command) return false;
      const trigger = s.spec.trigger_command;
      if (!trimmedContent.startsWith(trigger)) return false;
      // Must be exact match or followed by a space
      return trimmedContent.length === trigger.length || trimmedContent[trigger.length] === ' ';
    });
    const skillMetadata = matchedSkill
      ? {
          skillId: matchedSkill.appId,
          skillName: matchedSkill.spec.name,
          skillTrigger: matchedSkill.spec.trigger_command,
          skillDescription: matchedSkill.spec.description,
        }
      : undefined;

    const conversation = get().getCurrentConversation();
    const conversationMeta = get().getCurrentConversationMeta();
    const { currentSpaceId } = get();

    if ((!conversation && !conversationMeta) || !currentSpaceId) {
      console.error('[ChatStore] No conversation or space selected');
      return;
    }

    const conversationId = conversationMeta?.id || conversation?.id;
    if (!conversationId) return;

    // Check if currently generating - if so, queue the message and auto-stop
    // the current generation so the model can process the new message immediately.
    // Without auto-stop, responses appear one message late (off-by-one),
    // confusing users into thinking the model ignored their new instruction.
    const currentSession = get().getSession(conversationId);
    if (currentSession.isGenerating) {
      console.log('[ChatStore] Currently generating, queueing message + auto-stopping');
      const pendingMsg: PendingMessage = {
        id: `pending-${Date.now()}`,
        content,
        images,
        thinkingEnabled,
        aiBrowserEnabled,
        agentId, // Store target agent
        activeKnowledgeBases,
        timestamp: Date.now(),
      };

      // Add user message to UI immediately (even when queued)
      const userMessage: Message = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        images: images,
        metadata: skillMetadata,
      };

      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(conversationId) || createEmptySessionState();
        newSessions.set(conversationId, {
          ...session,
          pendingMessages: [...session.pendingMessages, pendingMsg],
        });

        // Update cache if conversation is loaded (so message appears in UI)
        const newCache = new Map(state.conversationCache);
        const cached = newCache.get(conversationId);
        if (cached) {
          newCache.set(conversationId, {
            ...cached,
            messages: [...cached.messages, userMessage],
            updatedAt: new Date().toISOString(),
          });
        }

        // Update metadata (messageCount)
        const newSpaceStates = new Map(state.spaceStates);
        const spaceState = newSpaceStates.get(currentSpaceId);
        if (spaceState) {
          newSpaceStates.set(currentSpaceId, {
            ...spaceState,
            conversations: spaceState.conversations.map((c) =>
              c.id === conversationId
                ? { ...c, messageCount: c.messageCount + 1, updatedAt: new Date().toISOString() }
                : c,
            ),
          });
        }

        return { spaceStates: newSpaceStates, conversationCache: newCache, sessions: newSessions };
      });

      // Auto-stop current generation so the queued message is processed next.
      // The stop triggers abort → interrupt → agent:complete → handleAgentComplete
      // picks up the pending message and sends it to the model.
      api.stopGeneration(conversationId).catch(() => {});
      return;
    }

    try {
      // Initialize/reset session state for this conversation
      set((state) => {
        const newSessions = new Map(state.sessions);
        const existingSession = state.sessions.get(conversationId);
        newSessions.set(conversationId, {
          isGenerating: true,
          isStopping: false, // Initialize stopping state
          streamingContent: '',
          isStreaming: false,
          thoughts: [],
          isThinking: true,
          pendingToolApproval: null,
          error: null,
          errorType: null,
          compactInfo: null,
          currentContextUsage: null,
          textBlockVersion: 0,
          pendingQuestion: null,
          pendingToolPermission: null,
          pendingMessages: [],
          // Clean up completed/failed worker sessions from previous rounds.
          // Keep running workers and workers with persisted childConversationId history.
          workerSessions: existingSession?.workerSessions
            ? new Map(
                [...existingSession.workerSessions].filter(
                  ([, ws]) => ws.isRunning || ws.childConversationId,
                ),
              )
            : new Map(),
          lastActivityAt: Date.now(),
        });
        return { sessions: newSessions };
      });

      // Add user message to UI immediately (update cache if exists)
      const userMessage: Message = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        images: images, // Include images in message for display
        metadata: skillMetadata,
      };

      set((state) => {
        // Update cache if conversation is loaded
        const newCache = new Map(state.conversationCache);
        const cached = newCache.get(conversationId);
        if (cached) {
          newCache.set(conversationId, {
            ...cached,
            messages: [...cached.messages, userMessage],
            updatedAt: new Date().toISOString(),
          });
        }

        // Update metadata (messageCount)
        const newSpaceStates = new Map(state.spaceStates);
        const spaceState = newSpaceStates.get(currentSpaceId);
        if (spaceState) {
          newSpaceStates.set(currentSpaceId, {
            ...spaceState,
            conversations: spaceState.conversations.map((c) =>
              c.id === conversationId
                ? { ...c, messageCount: c.messageCount + 1, updatedAt: new Date().toISOString() }
                : c,
            ),
          });
        }
        return { spaceStates: newSpaceStates, conversationCache: newCache };
      });

      // Build Canvas Context for AI awareness

      // Send to agent (with images, AI Browser state, thinking mode, and canvas context)
      // For Hyper Space: agentId routes to specific agent ('leader' or agent ID)
      // Support @all broadcast to all workers in parallel
      // Support multi-agent parallel execution when multiple agentIds are comma-separated
      if (agentId === '__all__') {
        // Broadcast to all workers: send to leader first, then all workers
        const members = await api.getHyperSpaceMembers(currentSpaceId);
        const allAgentIds = ['leader'];
        if (members.success && members.data?.members) {
          for (const m of members.data.members) {
            if (m.role === 'worker') allAgentIds.push(m.id);
          }
        }
        await Promise.all(
          allAgentIds.map((id) =>
            api.sendMessage({
              spaceId: currentSpaceId,
              conversationId,
              message: content,
              images: images,
              aiBrowserEnabled,
              thinkingEnabled,
              canvasContext: buildCanvasContext(),
              agentId: id,
              activeKnowledgeBases,
            }),
          ),
        );
      } else if (agentId && agentId.includes(',') && agentId !== 'leader') {
        const agentIds = agentId.split(',').filter(Boolean);
        // Send to all mentioned agents in parallel
        await Promise.all(
          agentIds.map((id) =>
            api.sendMessage({
              spaceId: currentSpaceId,
              conversationId,
              message: content,
              images: images,
              aiBrowserEnabled,
              thinkingEnabled,
              canvasContext: buildCanvasContext(),
              agentId: id,
              activeKnowledgeBases,
            }),
          ),
        );
      } else {
        await api.sendMessage({
          spaceId: currentSpaceId,
          conversationId,
          message: content,
          images: images, // Pass images to API
          aiBrowserEnabled, // Pass AI Browser state to API
          thinkingEnabled, // Pass thinking mode to API
          canvasContext: buildCanvasContext(), // Pass canvas context for AI awareness
          agentId: agentId || 'leader', // Pass target agent for Hyper Space
          activeKnowledgeBases, // Pass active knowledge base IDs
        });
      }

      // Start inactivity watchdog — fires error if no backend events for 30s
      startInactivityTimer(conversationId);
    } catch (error) {
      console.error('Failed to send message:', error);
      // Update session error state
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(conversationId) || createEmptySessionState();
        newSessions.set(conversationId, {
          ...session,
          error: 'Failed to send message',
          isGenerating: false,
          isThinking: false,
        });
        return { sessions: newSessions };
      });
    }
  },

  // Stop generation for a specific conversation
  stopGeneration: async (conversationId?: string) => {
    clearInactivityTimer();
    const targetId = conversationId || get().getCurrentSpaceState().currentConversationId;
    if (!targetId) return;

    // Step 1: Immediately set isStopping=true to show "stopping..." UI
    // Keep isGenerating=true so user can't send new messages during stop
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(targetId);
      if (session && session.isGenerating) {
        newSessions.set(targetId, {
          ...session,
          isStopping: true, // Show stopping state
          // Keep isGenerating=true to prevent new messages
          // Keep streamingContent and thoughts - they will be preserved
        });
      }
      return { sessions: newSessions };
    });

    // Step 2: Safety timeout — if agent:complete never arrives, force-clear isStopping.
    // This handles edge cases where the backend fails to emit completion events
    // (e.g., SDK not responding to interrupt, network issues for remote sessions).
    const STOP_SAFETY_TIMEOUT_MS = 10000;
    const safetyTimer = setTimeout(() => {
      const session = get().getSession(targetId);
      if (session?.isStopping) {
        console.warn(
          `[ChatStore] Stop timed out after ${STOP_SAFETY_TIMEOUT_MS}ms for ${targetId}, forcing cleanup`,
        );
        const spaceId = get().currentSpaceId;
        set((state) => {
          const newSessions = new Map(state.sessions);
          newSessions.set(targetId, {
            ...session,
            isStopping: false,
            isGenerating: false,
            isStreaming: false,
          });
          return { sessions: newSessions };
        });
        // Reload conversation from backend to get any partial content
        if (spaceId) {
          api.getConversation(spaceId, targetId).catch(() => {});
        }
      }
    }, STOP_SAFETY_TIMEOUT_MS);

    try {
      // Step 3: Send stop request to backend (fire-and-forget)
      // abortController.abort() is synchronous and takes effect immediately.
      // The IPC handler also returns right away without waiting for interrupt cleanup.
      // isGenerating/isStopping will be cleared when handleAgentComplete fires.
      api.stopGeneration(targetId).catch((error) => {
        console.error('Failed to stop generation:', error);
      });
    } catch (error) {
      console.error('Failed to stop generation:', error);
    }
  },

  // Approve tool for a specific conversation
  approveTool: async (conversationId: string) => {
    try {
      await api.approveTool(conversationId);
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(conversationId);
        if (session) {
          newSessions.set(conversationId, { ...session, pendingToolApproval: null });
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error('Failed to approve tool:', error);
    }
  },

  // Reject tool for a specific conversation
  rejectTool: async (conversationId: string) => {
    try {
      await api.rejectTool(conversationId);
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(conversationId);
        if (session) {
          newSessions.set(conversationId, { ...session, pendingToolApproval: null });
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error('Failed to reject tool:', error);
    }
  },

  // Continue conversation after interrupt (used by InterruptedBubble)
  // Clears error state and sends a "continue" message to AI to resume the interrupted response
  continueAfterInterrupt: (conversationId: string) => {
    // Build context-enriched continue message if worker context is available
    const currentState = get();
    const session = currentState.sessions.get(conversationId);
    let continueMessage = 'continue';

    if (session?.interruptWorkerContext) {
      const ctx = session.interruptWorkerContext;
      const parts: string[] = [
        '[System: The previous response was interrupted. Resuming with current worker status:]',
      ];

      if (ctx.runningWorkers.length > 0) {
        parts.push('\n**Still running:**');
        for (const w of ctx.runningWorkers) {
          const taskPreview = w.task.length > 200 ? w.task.slice(0, 200) + '...' : w.task;
          parts.push(`- Worker "${w.agentName}" (task: ${taskPreview})`);
        }
      }

      if (ctx.completedWorkers.length > 0) {
        parts.push('\n**Completed since interruption:**');
        for (const w of ctx.completedWorkers) {
          const summary = w.result?.slice(0, 500) || w.error || 'No result';
          parts.push(`- Worker "${w.agentName}": ${summary}`);
        }
      }

      parts.push('\nPlease continue based on the above worker status.');
      continueMessage = parts.join('\n');
    }

    // Clear error state AND worker context
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          error: null,
          errorType: null,
          interruptWorkerContext: undefined,
        });
      }
      return { sessions: newSessions };
    });

    // Send the context-enriched continue message
    const state = get();
    const spaceState = state.spaceStates.get(state.currentSpaceId || '');
    if (spaceState?.currentConversationId === conversationId) {
      state.sendMessage(continueMessage);
    }
  },

  // Save worker context received when Leader stream is interrupted
  handleInterruptContext: (
    conversationId: string,
    context: import('../../shared/types/hyper-space').InterruptWorkerContext,
  ) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          interruptWorkerContext: context,
        });
      }
      return { sessions: newSessions };
    });
  },

  // Clear pending messages for a conversation
  clearPendingMessages: (conversationId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          pendingMessages: [],
        });
      }
      return { sessions: newSessions };
    });
  },

  // Remove a specific pending message by ID
  removePendingMessage: (conversationId: string, messageId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          pendingMessages: session.pendingMessages.filter((m) => m.id !== messageId),
        });
      }
      return { sessions: newSessions };
    });
  },

  // Handle agent message - update session-specific streaming content
  // Supports both incremental (delta) and full (content) modes for backward compatibility
  // Routes to workerSession when agentId is present (Hyper Space worker)
  handleAgentMessage: (data) => {
    const { conversationId, agentId, content, delta, isStreaming, isComplete, isNewTextBlock } =
      data as AgentEventBase & {
        agentId?: string;
        agentName?: string;
        content?: string;
        delta?: string;
        isComplete?: boolean;
        isStreaming?: boolean;
        isNewTextBlock?: boolean; // Signal from content_block_start (type='text')
      };

    // Route to worker session if agentId is present
    if (agentId) {
      // Keep parent session's inactivity timer alive while worker is streaming
      set((state) => {
        const newSessions = new Map(state.sessions);
        const s = newSessions.get(conversationId);
        if (s) newSessions.set(conversationId, { ...s, lastActivityAt: Date.now() });
        return { sessions: newSessions };
      });

      // Use throttle buffer to batch worker streaming deltas into fewer set() calls.
      // This prevents excessive React re-renders when multiple workers stream concurrently.
      const throttleKey = `${conversationId}:${agentId}`;
      const THROTTLE_MS = 50;
      const now = Date.now();
      const lastUpdate = workerStreamThrottleMap.get(throttleKey) || 0;

      // Accumulate delta into a ref (outside Zustand) to avoid double-set on immediate updates
      if (!workerStreamPendingDeltas.has(throttleKey)) {
        workerStreamPendingDeltas.set(throttleKey, {
          delta: '',
          content: '',
          isComplete,
          isStreaming,
          isNewTextBlock,
        });
      }
      const pending = workerStreamPendingDeltas.get(throttleKey)!;
      if (delta) pending.delta += delta;
      if (content !== undefined) pending.content = content;
      if (isComplete !== undefined) pending.isComplete = isComplete;
      if (isStreaming !== undefined) pending.isStreaming = isStreaming;
      if (isNewTextBlock) pending.isNewTextBlock = true;

      if (now - lastUpdate < THROTTLE_MS && !isComplete) {
        // Throttled — will be flushed by the scheduled timer or next unthrottled event
        if (!workerStreamThrottleTimers.has(throttleKey)) {
          const timer = setTimeout(() => {
            workerStreamThrottleMap.delete(throttleKey);
            workerStreamThrottleTimers.delete(throttleKey);
            const p = workerStreamPendingDeltas.get(throttleKey);
            if (p) {
              workerStreamPendingDeltas.delete(throttleKey);
              applyWorkerStreamUpdate(set, conversationId, agentId, p, data as AgentEventBase);
            }
          }, THROTTLE_MS);
          workerStreamThrottleTimers.set(throttleKey, timer);
        }
        return;
      }

      // Unthrottled (first event, complete event, or throttle window expired) — flush immediately
      const existingTimer = workerStreamThrottleTimers.get(throttleKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
        workerStreamThrottleTimers.delete(throttleKey);
      }
      workerStreamThrottleMap.set(throttleKey, now);
      workerStreamPendingDeltas.delete(throttleKey);
      applyWorkerStreamUpdate(set, conversationId, agentId, pending, data as AgentEventBase);
      return;
    }

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);

      // CRITICAL: Ignore events if not generating or if stopping
      // This prevents stale events from previous requests after interrupt
      if (!session?.isGenerating || session?.isStopping) {
        console.log(
          `[ChatStore] Ignoring agent message - not generating or stopping: ${conversationId}`,
        );
        return state;
      }

      // New text block signal: increment version number
      // StreamingBubble detects version change to reset activeSnapshotLen
      const newTextBlockVersion = isNewTextBlock
        ? (session.textBlockVersion || 0) + 1
        : session.textBlockVersion || 0;

      // Incremental mode: append delta to existing content
      // Full mode: replace directly (backward compatible)
      const newContent = delta
        ? (session.streamingContent || '') + delta
        : (content ?? session.streamingContent);

      // When isComplete is true, explicitly set isStreaming to false
      // Otherwise use the provided isStreaming value or false as fallback
      const shouldStream = isComplete ? false : (isStreaming ?? false);

      newSessions.set(conversationId, {
        ...session,
        streamingContent: newContent,
        isStreaming: shouldStream,
        textBlockVersion: newTextBlockVersion,
      });
      return { sessions: newSessions };
    });
  },

  // Handle tool call for a specific conversation
  handleAgentToolCall: (data) => {
    const { conversationId, ...toolCall } = data;
    console.log(`[ChatStore] handleAgentToolCall [${conversationId}]:`, toolCall.name);

    if (toolCall.requiresApproval) {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(conversationId);

        // CRITICAL: Ignore events if not generating or if stopping
        // This prevents stale events from previous requests after interrupt
        if (!session?.isGenerating || session?.isStopping) {
          console.log(
            `[ChatStore] Ignoring agent tool call - not generating or stopping: ${conversationId}`,
          );
          return state;
        }

        newSessions.set(conversationId, {
          ...session,
          pendingToolApproval: toolCall as ToolCall,
        });
        return { sessions: newSessions };
      });
    }
  },

  // Handle tool result for a specific conversation
  handleAgentToolResult: (data) => {
    const { conversationId, toolId } = data;
    // console.log(`[ChatStore] handleAgentToolResult [${conversationId}]:`, toolId)
    // Tool results are tracked in thoughts, no additional state needed
  },

  // Handle error for a specific conversation
  handleAgentError: (data) => {
    const { conversationId, agentId, error, errorType } = data;
    clearInactivityTimer();
    console.log(
      `[ChatStore] handleAgentError [${conversationId}]${agentId ? ` agent=${agentId}` : ''}:`,
      error,
      errorType ? `(type: ${errorType})` : '',
    );

    // i18n for timeout errors
    const isTimeout = /timeout/i.test(error);
    const displayError = isTimeout
      ? i18n.t('Remote task timed out due to inactivity. The remote server may still be processing. Please check the server status and try sending a new message.')
      : error;

    // Add error thought to session (only for non-interrupted errors)
    // Interrupted errors get special UI treatment, not shown as error thought
    const errorThought: Thought = {
      id: `thought-error-${Date.now()}`,
      type: 'error',
      content: displayError,
      timestamp: new Date().toISOString(),
      isError: true,
    };

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId) || createEmptySessionState();

      // Route error to worker session if agentId is present
      if (agentId && session.workerSessions.has(agentId)) {
        const newWorkerSessions = new Map(session.workerSessions);
        const ws = newWorkerSessions.get(agentId);
        if (ws) {
          newWorkerSessions.set(agentId, {
            ...ws,
            error: displayError,
            status: 'failed' as const,
            isRunning: false,
            isThinking: false,
            isStreaming: false,
            completedAt: Date.now(),
            thoughts: [...ws.thoughts, errorThought],
          });
          newSessions.set(conversationId, { ...session, workerSessions: newWorkerSessions });
        }
        return { sessions: newSessions };
      }

      // Cancel pending questions on worker sessions too
      let updatedWorkerSessions = session.workerSessions;
      if (session.workerSessions.size > 0) {
        updatedWorkerSessions = new Map(session.workerSessions);
        for (const [wId, ws] of updatedWorkerSessions) {
          if (ws.pendingQuestion?.status === 'active') {
            updatedWorkerSessions.set(wId, {
              ...ws,
              pendingQuestion: { ...ws.pendingQuestion, status: 'cancelled' as const },
            });
          }
        }
      }

      newSessions.set(conversationId, {
        ...session,
        error: displayError,
        errorType: errorType || null,
        isGenerating: false,
        isThinking: false,
        isStopping: false, // Clear stopping state on error
        isStreaming: false, // Clear streaming state on error
        // CRITICAL FIX: Always clear thoughts on error to prevent stale data leaking to next message
        // Interrupted errors should not retain old thoughts - they will be loaded from backend if persisted
        thoughts: errorType === 'interrupted' ? [] : [...session.thoughts, errorThought],
        // Mark pending question as cancelled on error
        pendingQuestion:
          session.pendingQuestion?.status === 'active'
            ? { ...session.pendingQuestion, status: 'cancelled' as const }
            : session.pendingQuestion,
        workerSessions: updatedWorkerSessions,
      });
      return { sessions: newSessions };
    });
  },

  handleAgentStreamAlive: (data) => {
    const { conversationId, elapsedMs, currentToolName } = data;
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (!session) return state;
      newSessions.set(conversationId, {
        ...session,
        agentElapsedTime: elapsedMs,
        agentCurrentTool: currentToolName || null,
        lastActivityAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  handleAgentIdleTimeout: (data) => {
    const { conversationId, idleMinutes } = data;
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (!session) return state;
      newSessions.set(conversationId, {
        ...session,
        idleTimeout: { idleMinutes, triggeredAt: Date.now() },
      });
      return { sessions: newSessions };
    });
  },

  resolveIdleTimeout: async (conversationId: string) => {
    const { api } = await import('../api');
    await api.continueIdleTimeout(conversationId);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (!session) return state;
      newSessions.set(conversationId, { ...session, idleTimeout: null });
      return { sessions: newSessions };
    });
  },

  forceIdleTimeout: async (conversationId: string) => {
    const { api } = await import('../api');
    await api.forceIdleTimeout(conversationId);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (!session) return state;
      newSessions.set(conversationId, { ...session, idleTimeout: null });
      return { sessions: newSessions };
    });
  },

  // Handle complete - reload conversation from backend (Single Source of Truth)
  // Key: Only set isGenerating=false AFTER backend data is loaded to prevent flash
  // Also processes pending messages queue if any
  handleAgentComplete: async (data) => {
    const { spaceId, conversationId, tokenUsage } = data;
    clearInactivityTimer();
    console.log(`[ChatStore] handleAgentComplete [${conversationId}]`);

    // Update context usage with final tokenUsage
    // Only update contextWindow if tokenUsage has a non-default value (> 0 and != 200K fallback)
    // Otherwise preserve the value from agent:context-usage (which carries params.contextWindow)
    if (tokenUsage) {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(conversationId);
        if (!session) return state;

        // Preserve contextWindow from agent:context-usage events (which carry params.contextWindow)
        // Only use tokenUsage.contextWindow if SDK reported a non-default value
        const newContextWindow =
          tokenUsage.contextWindow !== 200000
            ? tokenUsage.contextWindow
            : (session.currentContextUsage?.contextWindow ?? tokenUsage.contextWindow);

        newSessions.set(conversationId, {
          ...session,
          currentContextUsage: {
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            cacheReadTokens: tokenUsage.cacheReadTokens,
            cacheCreationTokens: tokenUsage.cacheCreationTokens,
            contextWindow: newContextWindow,
          },
        });
        return { sessions: newSessions };
      });
    }

    // Check for pending messages before completing
    const sessionBeforeComplete = get().getSession(conversationId);
    const pendingMessages = sessionBeforeComplete.pendingMessages || [];

    // Check if user is currently viewing this conversation
    const state = get();
    const currentSpaceState = state.currentSpaceId
      ? state.spaceStates.get(state.currentSpaceId)
      : null;
    const isUserViewingThisConversation =
      state.currentSpaceId === spaceId &&
      currentSpaceState?.currentConversationId === conversationId;

    // Track unseen completion if user is not viewing this conversation
    if (!isUserViewingThisConversation) {
      // Find the conversation title from any space state
      let title = 'Conversation';
      for (const [, ss] of state.spaceStates) {
        const meta = ss.conversations.find((c) => c.id === conversationId);
        if (meta) {
          title = meta.title;
          break;
        }
      }
      set((s) => {
        const newUnseenCompletions = new Map(s.unseenCompletions);
        newUnseenCompletions.set(conversationId, { spaceId, title });
        return { unseenCompletions: newUnseenCompletions };
      });
    }

    // First, just stop streaming indicator but keep isGenerating=true
    // This keeps the streaming bubble visible during backend load
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          isStreaming: false,
          isThinking: false,
          // Keep isGenerating=true and streamingContent until backend loads
        });
      }
      return { sessions: newSessions };
    });

    // Reload conversation from backend (Single Source of Truth)
    // Backend has already saved the complete message with thoughts
    try {
      const response = await api.getConversation(spaceId, conversationId);
      if (response.success && response.data) {
        const updatedConversation = response.data as Conversation;

        // Extract updated metadata
        const updatedMeta: ConversationMeta = {
          id: updatedConversation.id,
          spaceId: updatedConversation.spaceId,
          title: updatedConversation.title,
          createdAt: updatedConversation.createdAt,
          updatedAt: updatedConversation.updatedAt,
          messageCount: updatedConversation.messages?.length || 0,
          preview:
            updatedConversation.messages && updatedConversation.messages.length > 0
              ? updatedConversation.messages[updatedConversation.messages.length - 1].content.slice(
                  0,
                  50,
                )
              : undefined,
          starred: updatedConversation.starred,
        };

        // Now atomically: update cache, metadata, AND clear session state
        // This prevents flash by doing all in one render
        set((state) => {
          // Update cache with fresh data
          const newCache = new Map(state.conversationCache);
          newCache.set(conversationId, updatedConversation);

          // Update metadata in space state
          const newSpaceStates = new Map(state.spaceStates);
          const currentSpaceState = newSpaceStates.get(spaceId);
          if (currentSpaceState) {
            newSpaceStates.set(spaceId, {
              ...currentSpaceState,
              conversations: currentSpaceState.conversations.map((c) =>
                c.id === conversationId ? updatedMeta : c,
              ),
            });
          }

          // Clear session state atomically with conversation update
          // Error is now persisted in message.error, so clear session-level error
          // Note: interrupted errors are sent AFTER agent:complete, so they won't be affected
          const newSessions = new Map(state.sessions);
          const currentSession = newSessions.get(conversationId);
          if (currentSession) {
            // Check if there are pending messages to send
            const remainingPending = currentSession.pendingMessages || [];
            const hasPendingMessages = remainingPending.length > 0;

            if (hasPendingMessages) {
              // Get the first pending message
              const nextMessage = remainingPending[0];
              const restMessages = remainingPending.slice(1);

              console.log(`[ChatStore] Processing pending message [${conversationId}]`);

              // Keep generating state but reset streaming content
              newSessions.set(conversationId, {
                ...currentSession,
                isStopping: false,
                isThinking: true,
                streamingContent: '',
                thoughts: [],
                compactInfo: null,
                currentContextUsage: null,
                pendingQuestion: null,
                pendingToolPermission: null,
                error: null,
                errorType: null,
                pendingMessages: restMessages,
                textBlockVersion: (currentSession.textBlockVersion || 0) + 1,
              });
            } else {
              // No pending messages, clear streaming state but preserve thoughts
              // for post-response review (including subagent collapsible groups).
              // Note: workerSessions are NOT cleared — they remain visible
              // so users can see completed worker results after the leader finishes.
              // They will be cleared on the next user message (sendMessage).
              // CRITICAL: Do NOT clear thoughts here — ThoughtProcess relies on it
              // to display subagent collapsible groups after stream completion.
              // CRITICAL: Preserve error/errorType if handleAgentError already set them
              // during the async await above — prevents race condition where error is lost.
              newSessions.set(conversationId, {
                ...currentSession,
                isGenerating: false,
                isStopping: false, // Clear stopping state
                streamingContent: '',
                isStreaming: false,
                isThinking: false, // Clear thinking status
                compactInfo: null, // Clear temporary compact notification
                pendingQuestion: null, // Clear pending question
                pendingToolPermission: null, // Clear pending tool permission
                error: currentSession.error || null, // Preserve error if already set by handleAgentError
                errorType: currentSession.errorType || null,
              });
            }
          }

          return {
            spaceStates: newSpaceStates,
            sessions: newSessions,
            conversationCache: newCache,
          };
        });
        console.log(`[ChatStore] Conversation reloaded from backend [${conversationId}]`);

        // If there were pending messages, send the first one now
        // Use nextPendingMessage captured from inside set() (current state, not stale snapshot)
        if (nextPendingMessage) {
          // Build canvas context (uses module-level buildCanvasContext)

          // Send the pending message — backend addMessage() writes to DB,
          // next handleAgentComplete reload brings correct ordering.
          // Do NOT add to cache here — that caused off-by-one display bug
          // where the user message appeared under the previous response.
          // Send with CURRENT KB selection (not stale snapshot)
          const { useKnowledgeBaseStore } = await import('./knowledge-base.store');
          const currentKbIds = useKnowledgeBaseStore.getState().activeKnowledgeBaseIds;
          await api.sendMessage({
            spaceId,
            conversationId,
            message: nextMessage.content,
            images: nextMessage.images,
            aiBrowserEnabled: nextMessage.aiBrowserEnabled,
            thinkingEnabled: nextMessage.thinkingEnabled,
            canvasContext: buildCanvasContext(),
            agentId: nextMessage.agentId || 'leader',
            activeKnowledgeBases: currentKbIds.length > 0 ? currentKbIds : undefined,
          });
        }
      }
    } catch (error) {
      console.error('[ChatStore] Failed to reload conversation:', error);
      // Even on error, must clear state to avoid stale content
      // CRITICAL: Must also clear isStopping to prevent UI stuck in "stopping" state
      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(conversationId);
        if (currentSession) {
          newSessions.set(conversationId, {
            ...currentSession,
            isGenerating: false,
            isStopping: false, // CRITICAL: Clear stopping state (fix for remote space stop button stuck)
            isThinking: false, // Clear thinking state
            streamingContent: '',
            thoughts: [], // Clear thoughts
            compactInfo: null, // Clear temporary compact notification
            currentContextUsage: null,
            pendingQuestion: null, // Clear pending question
            pendingToolPermission: null, // Clear pending tool permission
            pendingMessages: [], // Clear pending messages on error
          });
        }
        return { sessions: newSessions };
      });
    }
  },

  // Handle thought for a specific conversation
  // Routes to workerSession when agentId is present (Hyper Space worker)
  handleAgentThought: (data) => {
    const { conversationId, agentId, thought } = data as AgentEventBase & {
      agentId?: string;
      agentName?: string;
      thought: Thought;
    };
    // Route to worker session if agentId is present
    if (agentId) {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = resolveSessionId(newSessions, conversationId);
        if (!session) {
          console.warn(
            `[ChatStore] handleAgentThought (worker): no session for ${conversationId}, thought dropped (agent=${agentId})`,
          );
          return state;
        }

        const newWorkerSessions = new Map(session.workerSessions);
        let ws = newWorkerSessions.get(agentId);

        // Auto-create temporary worker session if not found yet
        // (worker:started may arrive after first agent:thought due to IPC ordering)
        if (!ws) {
          ws = createTemporaryWorkerSession(
            agentId,
            thought.agentName || agentId,
            baseConvId(conversationId),
          );
          newWorkerSessions.set(agentId, ws);
        }

        const existingIds = new Set(ws.thoughts.map((t) => t.id));
        if (existingIds.has(thought.id)) return state;

        newWorkerSessions.set(agentId, {
          ...ws,
          thoughts: [...ws.thoughts, thought],
          isThinking: true,
        });
        newSessions.set(baseConvId(conversationId), {
          ...session,
          workerSessions: newWorkerSessions,
        });
        return { sessions: newSessions };
      });
      // Fall through to also write to main session.thoughts (dual-write for sub-agent visibility)
    }

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);

      // CRITICAL: Ignore events if not generating or if stopping
      // This prevents stale events from previous requests after interrupt
      if (!session?.isGenerating || session?.isStopping) {
        console.log(
          `[ChatStore] Ignoring agent thought - not generating or stopping: ${conversationId}`,
        );
        return state;
      }

      // Check if thought with same id already exists (avoid duplicates after recovery)
      const existingIds = new Set(session.thoughts.map((t) => t.id));
      if (existingIds.has(thought.id)) {
        console.log(`[ChatStore] Skipping duplicate thought: ${thought.id}`);
        return state; // No change
      }

      newSessions.set(conversationId, {
        ...session,
        thoughts: [...session.thoughts, thought],
        isThinking: true,
        isGenerating: true, // Ensure generating state is set
        lastActivityAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  // Handle thought delta - incremental update to a streaming thought
  // Routes to workerSession when agentId is present (Hyper Space worker)
  handleAgentThoughtDelta: (data) => {
    const {
      conversationId,
      agentId,
      thoughtId,
      delta,
      content,
      toolInput,
      isComplete,
      isReady,
      isToolInput,
      toolResult,
      isToolResult,
    } = data as AgentEventBase & {
      agentId?: string;
      agentName?: string;
      thoughtId: string;
      delta?: string;
      content?: string;
      toolInput?: Record<string, unknown>;
      isComplete?: boolean;
      isReady?: boolean;
      isToolInput?: boolean;
      toolResult?: { output: string; isError: boolean; timestamp: string };
      isToolResult?: boolean;
    };
    // Don't log every delta to reduce console noise (only log on complete or toolResult)
    if (isComplete || isToolResult) {
      console.log(
        `[ChatStore] handleAgentThoughtDelta [${conversationId}]${agentId ? ` agent=${agentId}` : ''}: thought ${thoughtId} ${isToolResult ? 'toolResult merged' : 'complete'}`,
      );
    }

    // Route to worker session if agentId is present
    if (agentId) {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = resolveSessionId(newSessions, conversationId);
        if (!session) {
          console.warn(
            `[ChatStore] handleAgentThoughtDelta (worker): no session for ${conversationId}, delta dropped (agent=${agentId})`,
          );
          return state;
        }

        const newWorkerSessions = new Map(session.workerSessions);
        let ws = newWorkerSessions.get(agentId);
        if (!ws) {
          ws = createTemporaryWorkerSession(
            agentId,
            data.agentName || agentId,
            baseConvId(conversationId),
          );
          newWorkerSessions.set(agentId, ws);
        }

        let thoughtIndex = ws.thoughts.findIndex((t) => t.id === thoughtId);
        if (thoughtIndex === -1) {
          // Thought hasn't been created by handleAgentThought yet (IPC ordering).
          // Create a placeholder so deltas can accumulate.
          const placeholder: Thought = {
            id: thoughtId,
            content: '',
            isStreaming: true,
            createdAt: new Date().toISOString(),
          };
          ws = { ...ws, thoughts: [...ws.thoughts, placeholder], isThinking: true };
          newWorkerSessions.set(agentId, ws);
          thoughtIndex = ws.thoughts.length - 1;
        }

        const newThoughts = [...ws.thoughts];
        const thought = { ...newThoughts[thoughtIndex] };

        if (isToolResult && toolResult) {
          thought.toolResult = toolResult;
        } else if (isToolInput) {
          if (isComplete && toolInput) {
            thought.toolInput = toolInput;
            thought.isStreaming = false;
            thought.isReady = isReady ?? true;
          }
        } else {
          if (delta) thought.content = (thought.content || '') + delta;
          else if (content !== undefined) thought.content = content;
          if (isComplete) thought.isStreaming = false;
        }

        newThoughts[thoughtIndex] = thought;
        newWorkerSessions.set(agentId, { ...ws, thoughts: newThoughts });
        newSessions.set(baseConvId(conversationId), {
          ...session,
          workerSessions: newWorkerSessions,
        });
        return { sessions: newSessions };
      });
      // Fall through to also update main session.thoughts (dual-write for sub-agent visibility)
    }

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);

      // CRITICAL: Ignore events if not generating or if stopping
      // This prevents stale events from previous requests after interrupt
      if (!session?.isGenerating || session?.isStopping) {
        console.log(
          `[ChatStore] Ignoring agent thought delta - not generating or stopping: ${conversationId}`,
        );
        return state;
      }

      // Find the thought to update
      const thoughtIndex = session.thoughts.findIndex((t) => t.id === thoughtId);
      if (thoughtIndex === -1) {
        console.warn(`[ChatStore] Thought not found for delta: ${thoughtId}`);
        return state;
      }

      // Create updated thoughts array
      const newThoughts = [...session.thoughts];
      const thought = { ...newThoughts[thoughtIndex] };

      // Apply delta or content update
      if (isToolResult && toolResult) {
        // Tool result merge - add result to tool_use thought
        thought.toolResult = toolResult;
      } else if (isToolInput) {
        // For tool input, we just track streaming state, don't update content
        // Content will be set on completion with toolInput
        if (isComplete && toolInput) {
          thought.toolInput = toolInput;
          thought.isStreaming = false;
          thought.isReady = isReady ?? true;
        }
      } else {
        // For thinking/text content
        if (delta) {
          thought.content = (thought.content || '') + delta;
        } else if (content !== undefined) {
          thought.content = content;
        }

        if (isComplete) {
          thought.isStreaming = false;
        }
      }

      newThoughts[thoughtIndex] = thought;

      newSessions.set(conversationId, {
        ...session,
        thoughts: newThoughts,
        lastActivityAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  // Handle compact notification - context was compressed
  handleAgentCompact: (data) => {
    const { conversationId, trigger, preTokens } = data;
    console.log(
      `[ChatStore] handleAgentCompact [${conversationId}]: trigger=${trigger}, preTokens=${preTokens}`,
    );

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);

      // CRITICAL: Ignore events if not generating or if stopping
      // This prevents stale events from previous requests after interrupt
      if (!session?.isGenerating || session?.isStopping) {
        console.log(
          `[ChatStore] Ignoring agent compact - not generating or stopping: ${conversationId}`,
        );
        return state;
      }

      newSessions.set(conversationId, {
        ...session,
        compactInfo: { trigger, preTokens },
      });
      return { sessions: newSessions };
    });
  },

  handleAgentContextUsage: (data) => {
    const {
      conversationId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      contextWindow: passedContextWindow,
    } = data;

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);
      if (!session) return state;

      newSessions.set(conversationId, {
        ...session,
        currentContextUsage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          contextWindow: passedContextWindow ?? session.currentContextUsage?.contextWindow ?? 200000,
        },
        lastActivityAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  // Handle AskUserQuestion - set pending question on session
  // In Hyper Space, routes to WorkerSession when agentId is present
  handleAskQuestion: (data) => {
    const { conversationId, id, questions, agentId } = data;
    console.log(
      `[ChatStore] handleAskQuestion [${conversationId}]: id=${id}, questions=${questions?.length || 0}, agentId=${agentId || 'none'}`,
    );

    let rejected = false;
    let rejectReason = '';

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = resolveSessionId(newSessions, conversationId);

      if (!session) {
        // Session not found — reject back to main process to prevent deadlock
        console.warn(`[ChatStore] No session for ask question: ${conversationId}, rejecting`);
        rejected = true;
        rejectReason = 'Session not found';
        return state;
      }

      const resolvedConvId = baseConvId(conversationId);

      // Hyper Space worker routing: if agentId is present, route to WorkerSession
      if (agentId && session.workerSessions.has(agentId)) {
        const ws = session.workerSessions.get(agentId)!;
        if (ws.status !== 'running') {
          console.log(`[ChatStore] Ignoring ask question - worker not running: ${agentId}`);
          rejected = true;
          rejectReason = 'Worker not running';
          return state;
        }

        const newWorkerSessions = new Map(session.workerSessions);
        newWorkerSessions.set(agentId, {
          ...ws,
          pendingQuestion: { id, questions: questions || [], status: 'active' },
        });
        newSessions.set(resolvedConvId, { ...session, workerSessions: newWorkerSessions });
        return { sessions: newSessions };
      }

      // Main session routing (standard behavior)
      // Trust the main process: if it sends an ask-question event, the agent IS running.
      // Only skip if actively stopping (user clicked Stop).
      if (session?.isStopping) {
        console.log(`[ChatStore] Rejecting ask question - stopping: ${conversationId}`);
        rejected = true;
        rejectReason = 'Generation stopping';
        return state;
      }

      newSessions.set(resolvedConvId, {
        ...session,
        pendingQuestion: {
          id,
          questions: questions || [],
          status: 'active',
        },
      });
      return { sessions: newSessions };
    });

    // If the question was rejected by the guard, notify the main process
    // to prevent the permission handler promise from hanging forever
    if (rejected) {
      api.rejectQuestion({ id, reason: rejectReason }).catch((err) => {
        console.error('[ChatStore] Failed to reject question:', err);
      });
    }
  },

  // Answer a pending AskUserQuestion
  answerQuestion: async (conversationId: string, answers: Record<string, string>) => {
    const session = get().sessions.get(conversationId);
    if (!session?.pendingQuestion) {
      console.warn(`[ChatStore] No pending question for conversation: ${conversationId}`);
      return;
    }

    const { id } = session.pendingQuestion;

    try {
      await api.answerQuestion({ conversationId, id, answers });

      // Mark as answered
      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(conversationId);
        if (currentSession?.pendingQuestion) {
          newSessions.set(conversationId, {
            ...currentSession,
            pendingQuestion: {
              ...currentSession.pendingQuestion,
              status: 'answered',
              answers,
            },
          });
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error('[ChatStore] Failed to answer question:', error);
    }
  },

  // Answer a pending AskUserQuestion from a worker agent
  answerWorkerQuestion: async (
    parentConversationId: string,
    agentId: string,
    answers: Record<string, string>,
  ) => {
    const session = get().sessions.get(parentConversationId);
    if (!session) {
      console.warn(`[ChatStore] No session for worker question: ${parentConversationId}`);
      return;
    }

    const ws = session.workerSessions.get(agentId);
    if (!ws?.pendingQuestion) {
      console.warn(`[ChatStore] No pending question for worker ${agentId}`);
      return;
    }

    const { id } = ws.pendingQuestion;

    try {
      await api.answerQuestion({ conversationId: parentConversationId, id, answers });

      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(parentConversationId);
        if (!currentSession) return state;

        const newWorkerSessions = new Map(currentSession.workerSessions);
        const currentWs = newWorkerSessions.get(agentId);
        if (currentWs?.pendingQuestion) {
          newWorkerSessions.set(agentId, {
            ...currentWs,
            pendingQuestion: { ...currentWs.pendingQuestion, status: 'answered' as const, answers },
          });
          newSessions.set(parentConversationId, {
            ...currentSession,
            workerSessions: newWorkerSessions,
          });
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error('[ChatStore] Failed to answer worker question:', error);
    }
  },

  // Handle tool permission request from main agent
  handlePermissionRequest: (data) => {
    const { conversationId, id, toolName, toolInput, timestamp } = data;
    console.log(
      `[ChatStore] handlePermissionRequest [${conversationId}]: id=${id}, tool=${toolName}`,
    );

    let rejected = false;
    let rejectReason = '';

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(conversationId);

      if (!session) {
        console.warn(`[ChatStore] No session for permission request: ${conversationId}`);
        rejected = true;
        rejectReason = 'Session not found';
        return state;
      }

      if (session.isStopping) {
        console.log(`[ChatStore] Rejecting permission - stopping: ${conversationId}`);
        rejected = true;
        rejectReason = 'Generation stopping';
        return state;
      }

      newSessions.set(conversationId, {
        ...session,
        pendingToolPermission: {
          id,
          toolName,
          toolInput: toolInput || {},
          status: 'active',
          timestamp: timestamp || Date.now(),
        },
      });
      return { sessions: newSessions };
    });

    if (rejected) {
      api.resolveAgentPermission({ id, approved: false }).catch((err) => {
        console.error('[ChatStore] Failed to reject permission:', err);
      });
    }
  },

  // Resolve a pending tool permission request (approve/deny from UI)
  resolveToolPermission: async (conversationId: string, approved: boolean) => {
    const session = get().sessions.get(conversationId);
    if (!session?.pendingToolPermission) {
      console.warn(`[ChatStore] No pending tool permission for conversation: ${conversationId}`);
      return;
    }

    const { id } = session.pendingToolPermission;

    try {
      await api.resolveAgentPermission({ id, approved, conversationId });

      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(conversationId);
        if (currentSession?.pendingToolPermission) {
          newSessions.set(conversationId, {
            ...currentSession,
            pendingToolPermission: {
              ...currentSession.pendingToolPermission,
              status: approved ? 'approved' : 'denied',
            },
          });
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error('[ChatStore] Failed to resolve tool permission:', error);
    }
  },

  // Handle Hyper Space progress updates from subagents
  handleHyperSpaceProgress: (data) => {
    const { spaceId, conversationId, taskId, agentId, delta, timestamp } = data;
    console.log(
      `[ChatStore] handleHyperSpaceProgress [${conversationId}] task=${taskId}, agent=${agentId}`,
    );

    // Check if user is currently viewing this conversation
    const state = get();
    const currentSpaceState = state.spaceStates.get(spaceId);
    const isViewing = currentSpaceState?.currentConversationId === conversationId;

    if (isViewing) {
      console.log(
        `[ChatStore] Subagent ${agentId} progress on task ${taskId}: ${delta.length} chars`,
      );
    }
  },

  // Handle worker started — creates a new worker session state
  handleWorkerStarted: (data) => {
    console.log('[ChatStore] handleWorkerStarted called, raw data:', JSON.stringify(data));
    const { conversationId, agentId, agentName, taskId, task, type, serverName, interactionMode } =
      data;
    if (!conversationId) {
      console.error('[ChatStore] handleWorkerStarted: missing conversationId in data!');
      return;
    }
    if (!agentId) {
      console.error('[ChatStore] handleWorkerStarted: missing agentId in data!');
      return;
    }
    console.log(
      `[ChatStore] handleWorkerStarted [${conversationId}] agent=${agentId}, task=${task?.substring(0, 50)}`,
    );

    // Add worker to workerConversations in SpaceState for sidebar visibility
    const parentConvId = baseConvId(conversationId);
    set((state) => {
      // 1. Update session state
      const newSessions = new Map(state.sessions);
      const session = resolveSessionId(newSessions, conversationId);
      if (!session) {
        console.warn(`[ChatStore] handleWorkerStarted: no session found for ${conversationId}`);
        return state;
      }

      const newWorkerSessions = new Map(session.workerSessions);
      // Reuse existing worker session if same agent is still active (update task)
      // Also preserves content from temporary sessions created by early agent:message events
      const existing = newWorkerSessions.get(agentId);
      // Build child conversation ID for loading persisted message history
      const childConvId = `${parentConvId}:agent-${agentId}`;
      const isTemporarySession = existing && !existing.childConversationId;
      newWorkerSessions.set(agentId, {
        agentId,
        agentName: agentName || agentId,
        taskId: taskId || null,
        task: task || '',
        isRunning: true,
        status: 'running',
        streamingContent: existing?.streamingContent || '',
        isStreaming: false,
        // Always preserve existing thoughts — IPC ordering means thoughts can
        // arrive before worker:started, and createTemporaryWorkerSession now sets
        // childConversationId (making isTemporarySession always false for that path)
        thoughts: existing?.thoughts || [],
        isThinking: false,
        textBlockVersion: 0,
        error: null,
        completedAt: null,
        type: type || existing?.type || 'local',
        serverName: serverName || existing?.serverName,
        pendingQuestion: null,
        childConversationId: childConvId,
        interactionMode: interactionMode || 'delegation',
        turnStartedAt: Date.now(),
      });
      newSessions.set(parentConvId, { ...session, workerSessions: newWorkerSessions });

      // 2. Update SpaceState workerConversations for sidebar
      const spaceId = state.currentSpaceId;
      if (spaceId) {
        const newSpaceStates = new Map(state.spaceStates);
        const existingSpaceState = newSpaceStates.get(spaceId);
        if (existingSpaceState) {
          const newWorkerConvs = new Map(existingSpaceState.workerConversations);
          const existingWorkers = newWorkerConvs.get(parentConvId) || [];
          if (!existingWorkers.some((w) => w.agentId === agentId)) {
            newWorkerConvs.set(parentConvId, [
              ...existingWorkers,
              {
                id: childConvId,
                title: agentName || agentId,
                agentId,
                parentConversationId: parentConvId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                messageCount: 0,
              },
            ]);
            newSpaceStates.set(spaceId, {
              ...existingSpaceState,
              workerConversations: newWorkerConvs,
            });
          }
          return { sessions: newSessions, spaceStates: newSpaceStates };
        }
      }

      return { sessions: newSessions };
    });

    // Highlight agent in AgentPanel sidebar (foreman pattern)
    get().activateAgent(agentId);
  },

  // Handle worker completed — marks worker session as done
  handleWorkerCompleted: (data) => {
    const { conversationId, agentId, result, error, status } = data;
    console.log(
      `[ChatStore] handleWorkerCompleted [${conversationId}] agent=${agentId}, status=${status}`,
    );

    const parentConvId = baseConvId(conversationId);
    set((state) => {
      // 1. Update session state
      const newSessions = new Map(state.sessions);
      const session = resolveSessionId(newSessions, conversationId);
      if (!session) return state;

      const newWorkerSessions = new Map(session.workerSessions);
      const ws = newWorkerSessions.get(agentId);
      if (!ws) return state;

      newWorkerSessions.set(agentId, {
        ...ws,
        isRunning: false,
        status: status || 'completed',
        error: error || null,
        isStreaming: false,
        isThinking: false,
        completedAt: Date.now(),
        // Cancel pending question if still active when worker completes
        pendingQuestion:
          ws.pendingQuestion?.status === 'active'
            ? { ...ws.pendingQuestion, status: 'cancelled' as const }
            : ws.pendingQuestion,
      });
      newSessions.set(parentConvId, { ...session, workerSessions: newWorkerSessions });

      // 2. Update SpaceState workerConversations metadata (updatedAt, messageCount)
      const spaceId = state.currentSpaceId;
      if (spaceId) {
        const newSpaceStates = new Map(state.spaceStates);
        const existingSpaceState = newSpaceStates.get(spaceId);
        if (existingSpaceState) {
          const newWorkerConvs = new Map(existingSpaceState.workerConversations);
          const workers = newWorkerConvs.get(parentConvId);
          if (workers) {
            const idx = workers.findIndex((w) => w.agentId === agentId);
            if (idx !== -1) {
              const updated = [...workers];
              updated[idx] = {
                ...updated[idx],
                updatedAt: new Date().toISOString(),
                messageCount: updated[idx].messageCount + 1,
              };
              newWorkerConvs.set(parentConvId, updated);
              newSpaceStates.set(spaceId, {
                ...existingSpaceState,
                workerConversations: newWorkerConvs,
              });
              return { sessions: newSessions, spaceStates: newSpaceStates };
            }
          }
        }
      }

      return { sessions: newSessions };
    });

    // Remove activation highlight in AgentPanel sidebar
    if (agentId) get().deactivateAgent(agentId);
  },

  handleAgentTeamMessage: (data) => {
    const { spaceId, conversationId, id, recipientId, recipientName, content, summary, timestamp } =
      data;
    console.log(
      `[ChatStore] handleAgentTeamMessage [${conversationId}] to=${recipientName} (${recipientId})`,
    );

    // Add team message to the conversation cache so it appears in the message list
    set((state) => {
      const newCache = new Map(state.conversationCache);
      const cached = newCache.get(conversationId);

      if (cached) {
        const teamMessage: import('../types').Message = {
          id: id || `team-${Date.now()}`,
          role: 'assistant',
          content: `📤 **To ${recipientName}:** ${summary || content.substring(0, 100)}`,
          timestamp: new Date(timestamp).toISOString(),
          agentId: data.senderId || data.workerId,
          agentName: data.senderName || data.workerName || 'Agent',
          metadata: {
            isTeamMessage: true,
            fullContent: content,
            recipientId,
            recipientName,
          },
        };

        newCache.set(conversationId, {
          ...cached,
          messages: [...cached.messages, teamMessage],
        });

        return { conversationCache: newCache };
      }

      return state;
    });
  },

  // Load a worker's child conversation messages for history display
  loadWorkerConversation: async (
    spaceId: string,
    childConversationId: string,
  ): Promise<boolean> => {
    // Already cached
    if (get().conversationCache.has(childConversationId)) return true;

    try {
      const response = await api.getConversation(spaceId, childConversationId);
      if (response.success && response.data) {
        const conversation = response.data as Conversation;
        set((state) => {
          const newCache = new Map(state.conversationCache);
          newCache.set(childConversationId, conversation);
          return { conversationCache: newCache };
        });
        return true;
      }
      return false;
    } catch (error) {
      console.warn(`[ChatStore] Failed to load worker conversation ${childConversationId}:`, error);
      return false;
    }
  },

  // Rebuild WorkerSessionState map from persisted child conversations on disk.
  // This is called when opening a conversation after page refresh so that
  // subagent collapsible groups are restored from their persisted child conversations.
  rebuildWorkerSessions: async (spaceId: string, conversationId: string): Promise<void> => {
    try {
      // 1. List child conversations
      const childrenRes = await api.listChildConversations(spaceId, conversationId);
      if (
        !childrenRes.success ||
        !childrenRes.data ||
        !Array.isArray(childrenRes.data) ||
        childrenRes.data.length === 0
      ) {
        return;
      }

      const children = childrenRes.data as Array<{
        id: string;
        title: string;
        messageCount: number;
      }>;

      console.log(
        `[ChatStore] Rebuilding worker sessions for ${conversationId}: ${children.length} child conversations found`,
      );

      // 2. Load each child conversation and build WorkerSessionState
      const newWorkerSessions = new Map<string, WorkerSessionState>();

      for (const child of children) {
        try {
          // Load child conversation with messages
          const childRes = await api.getConversation(spaceId, child.id);
          if (!childRes.success || !childRes.data) continue;
          const childConv = childRes.data as Conversation;

          // Cache the child conversation
          set((state) => {
            const newCache = new Map(state.conversationCache);
            newCache.set(child.id, childConv);
            return { conversationCache: newCache };
          });

          // Load thoughts for each assistant message
          const assistantMessages = childConv.messages?.filter((m) => m.role === 'assistant') || [];
          const allThoughts: Thought[] = [];

          for (const msg of assistantMessages) {
            if (msg.thoughtsSummary && msg.thoughtsSummary.count > 0) {
              const thoughtsRes = await api.getMessageThoughts(spaceId, child.id, msg.id);
              if (thoughtsRes.success && thoughtsRes.data) {
                const thoughts = thoughtsRes.data as Thought[];
                allThoughts.push(...thoughts);
              }
            }
          }

          // Extract agent name from title or child conversation ID
          // Child conversation title format: typically "{task description}"
          // Agent ID can be extracted from the child conversation ID: {parentConvId}:agent-{agentId}
          const agentIdMatch = child.id.match(/:agent-(.+)$/);
          const agentId = agentIdMatch ? agentIdMatch[1] : child.id;
          const agentName = child.title || agentId;

          // Build WorkerSessionState
          newWorkerSessions.set(agentId, {
            agentId,
            agentName,
            taskId: null,
            task: '',
            isRunning: false,
            status: 'completed',
            streamingContent: '',
            isStreaming: false,
            thoughts: allThoughts,
            isThinking: false,
            textBlockVersion: 0,
            error: null,
            completedAt: childConv.updatedAt ? new Date(childConv.updatedAt).getTime() : null,
            pendingQuestion: null,
            childConversationId: child.id,
            interactionMode: 'delegation',
            turnStartedAt: 0,
          });
        } catch (error) {
          console.warn(`[ChatStore] Failed to load child conversation ${child.id}:`, error);
        }
      }

      // 3. Update session with rebuilt worker sessions
      if (newWorkerSessions.size > 0) {
        set((state) => {
          const newSessions = new Map(state.sessions);
          const session = newSessions.get(conversationId);
          if (session) {
            // Merge with existing worker sessions (if any)
            const mergedWorkers = new Map(session.workerSessions);
            for (const [agentId, ws] of newWorkerSessions) {
              if (!mergedWorkers.has(agentId)) {
                mergedWorkers.set(agentId, ws);
              }
            }
            newSessions.set(conversationId, {
              ...session,
              workerSessions: mergedWorkers,
            });
          }
          return { sessions: newSessions };
        });
        console.log(
          `[ChatStore] Rebuilt ${newWorkerSessions.size} worker sessions for ${conversationId}`,
        );
      }
    } catch (error) {
      console.error(`[ChatStore] Failed to rebuild worker sessions for ${conversationId}:`, error);
    }
  },

  // Load thoughts for a specific message (lazy loading from separated storage)
  // Returns the thoughts array and updates the conversation cache so subsequent reads are instant
  loadMessageThoughts: async (
    spaceId: string,
    conversationId: string,
    messageId: string,
  ): Promise<Thought[]> => {
    // Check if already loaded in cache
    const cached = get().conversationCache.get(conversationId);
    if (cached) {
      const msg = cached.messages.find((m) => m.id === messageId);
      if (msg && Array.isArray(msg.thoughts)) {
        console.log(
          `[ChatStore] Thoughts cache hit for ${conversationId}/${messageId}: ${msg.thoughts.length} thoughts`,
        );
        return msg.thoughts; // Already loaded
      }
    }

    console.log(`[ChatStore] Loading thoughts for ${conversationId}/${messageId}...`);
    try {
      const response = await api.getMessageThoughts(spaceId, conversationId, messageId);
      if (response.success && response.data) {
        const thoughts = response.data as Thought[];
        console.log(
          `[ChatStore] Loaded ${thoughts.length} thoughts for ${conversationId}/${messageId}, updating cache`,
        );

        // Update the conversation cache with loaded thoughts
        set((state) => {
          const newCache = new Map(state.conversationCache);
          const conversation = newCache.get(conversationId);
          if (conversation) {
            const updatedMessages = conversation.messages.map((m) =>
              m.id === messageId ? { ...m, thoughts } : m,
            );
            newCache.set(conversationId, { ...conversation, messages: updatedMessages });
          }
          return { conversationCache: newCache };
        });

        return thoughts;
      }
    } catch (error) {
      console.error(
        `[ChatStore] Failed to load thoughts for ${conversationId}/${messageId}:`,
        error,
      );
    }

    return [];
  },

  // Remove expired pulse readAt entries and schedule next cleanup
  cleanupPulseReadAt: () => {
    if (_pulseCleanupTimer) {
      clearTimeout(_pulseCleanupTimer);
      _pulseCleanupTimer = null;
    }
    const now = Date.now();
    const state = get();
    const newPulseReadAt = new Map(state.pulseReadAt);
    let changed = false;
    for (const [id, info] of newPulseReadAt) {
      if (now - info.readAt >= PULSE_READ_GRACE_PERIOD_MS) {
        newPulseReadAt.delete(id);
        changed = true;
      }
    }
    if (changed) {
      set({ pulseReadAt: newPulseReadAt });
    }
    // Schedule next cleanup if entries remain
    if (newPulseReadAt.size > 0) {
      let earliest = Infinity;
      for (const [, info] of newPulseReadAt) {
        earliest = Math.min(earliest, info.readAt);
      }
      const delay = Math.max(0, earliest + PULSE_READ_GRACE_PERIOD_MS - now);
      _pulseCleanupTimer = setTimeout(() => get().cleanupPulseReadAt(), delay);
    }
  },

  // Reset all state (use sparingly - e.g., logout)
  reset: () => {
    if (_pulseCleanupTimer) {
      clearTimeout(_pulseCleanupTimer);
      _pulseCleanupTimer = null;
    }
    set({
      spaceStates: new Map(),
      conversationCache: new Map(),
      sessions: new Map(),
      unseenCompletions: new Map(),
      pulseReadAt: new Map(),
      currentSpaceId: null,
      pendingPulseNavigation: null,
      artifacts: [],
      isLoadingConversation: false,
      _pulseItems: [],
      _pulseCount: 0,
    });
  },

  // Reset a specific space's state (use when needed)
  resetSpace: (spaceId: string) => {
    set((state) => {
      const newSpaceStates = new Map(state.spaceStates);
      newSpaceStates.delete(spaceId);
      return { spaceStates: newSpaceStates };
    });
  },

  // ===== Hyper Space Agent Panel Actions =====

  setActiveAgentId: (agentId: string | null) => {
    set({ activeAgentId: agentId });
  },

  activateAgent: (agentId: string) => {
    set((state) => {
      const newActivated = new Set(state.activatedAgentIds);
      newActivated.add(agentId);
      return { activatedAgentIds: newActivated };
    });
  },

  deactivateAgent: (agentId: string) => {
    set((state) => {
      const newActivated = new Set(state.activatedAgentIds);
      newActivated.delete(agentId);
      return { activatedAgentIds: newActivated };
    });
  },
}));

// ==========================================
// Derived Pulse State — recalculates only when pulse-relevant fields change.
// During streaming, sessions change every token (streamingContent, thoughts, etc.)
// but pulse-relevant fields (isGenerating, pendingToolApproval, error, pendingQuestion)
// stay the same. We extract a fingerprint of only these fields and skip recalculation
// when the fingerprint is unchanged.
// ==========================================

// Skill Creator space ID - this space's conversations are hidden from Pulse
const SKILL_CREATOR_SPACE_ID = 'aico-bot-skill-creator';

/**
 * Extract a pulse-relevant fingerprint from sessions.
 * Only includes fields that affect deriveTaskStatus().
 */
function _extractPulseFingerprint(sessions: Map<string, SessionState>): string {
  const parts: string[] = [];
  for (const [id, s] of sessions) {
    // Only include sessions that could produce non-idle status
    if (
      s.isGenerating ||
      s.pendingToolApproval ||
      s.error ||
      s.pendingQuestion?.status === 'active'
    ) {
      // Include action fingerprint: last tool_use toolName + isReady, and step count
      // This detects step transitions without triggering on every streaming token
      let actionFingerprint = '';
      for (let i = s.thoughts.length - 1; i >= 0; i--) {
        const th = s.thoughts[i];
        if (th.type === 'tool_use') {
          actionFingerprint = `${th.toolName || ''}:${th.isReady ? 1 : 0}`;
          break;
        }
        if (th.type === 'thinking') {
          actionFingerprint = 'thinking';
          break;
        }
      }
      const stepCount = s.thoughts.filter((t) => t.type === 'tool_use' && t.toolResult).length;
      parts.push(
        `${id}:${s.isGenerating ? 1 : 0}${s.pendingToolApproval ? 1 : 0}${s.error && s.errorType !== 'interrupted' ? 1 : 0}${s.pendingQuestion?.status === 'active' ? 1 : 0}:${actionFingerprint}:${stepCount}`,
      );
    }
  }
  return parts.join('|');
}

/**
 * Compute pulse items from state (same logic as the original usePulseItems selector).
 * Filters out skill-creator space conversations.
 */
function _computePulseItems(state: ChatState): PulseItem[] {
  const items: PulseItem[] = [];
  const addedIds = new Set<string>();

  const getSpaceName = (spaceId: string): string => {
    return spaceId === 'aico-bot-temp' ? 'AICO-Bot' : spaceId;
  };

  // Helper to check if we should skip this space
  const shouldSkipSpace = (spaceId: string): boolean => {
    return spaceId === SKILL_CREATOR_SPACE_ID;
  };

  // 1. Active sessions
  for (const [conversationId, session] of state.sessions) {
    const hasUnseen = state.unseenCompletions.has(conversationId);
    const status = deriveTaskStatus(session, hasUnseen);
    if (status === 'idle') continue;

    let meta: ConversationMeta | undefined;
    for (const [, ss] of state.spaceStates) {
      meta = ss.conversations.find((c) => c.id === conversationId);
      if (meta) break;
    }
    if (!meta) continue;

    // Skip skill-creator space
    if (shouldSkipSpace(meta.spaceId)) continue;

    // Extract progress info from session
    const currentAction = session.isGenerating ? getActionSummary(session.thoughts) : undefined;
    const { completed, total } = session.isGenerating
      ? getStepCounts(session.thoughts)
      : { completed: 0, total: 0 };
    const generatingStartedAt =
      session.thoughts.length > 0 ? new Date(session.thoughts[0].timestamp).getTime() : undefined;

    items.push({
      conversationId,
      spaceId: meta.spaceId,
      spaceName: getSpaceName(meta.spaceId),
      title: meta.title,
      status,
      starred: !!meta.starred,
      updatedAt: meta.updatedAt,
      currentAction,
      completedSteps: completed,
      totalSteps: total,
      isThinking: session.isThinking,
      generatingStartedAt,
    });
    addedIds.add(conversationId);
  }

  // 2. Unseen completions
  for (const [conversationId, info] of state.unseenCompletions) {
    if (addedIds.has(conversationId)) continue;

    // Skip skill-creator space
    if (shouldSkipSpace(info.spaceId)) continue;

    let meta: ConversationMeta | undefined;
    for (const [, ss] of state.spaceStates) {
      meta = ss.conversations.find((c) => c.id === conversationId);
      if (meta) break;
    }
    items.push({
      conversationId,
      spaceId: info.spaceId,
      spaceName: getSpaceName(info.spaceId),
      title: meta?.title || info.title,
      status: 'completed-unseen',
      starred: !!meta?.starred,
      updatedAt: meta?.updatedAt || new Date().toISOString(),
    });
    addedIds.add(conversationId);
  }

  // 3. Starred conversations
  for (const [spaceId, ss] of state.spaceStates) {
    // Skip skill-creator space
    if (shouldSkipSpace(spaceId)) continue;

    for (const conv of ss.conversations) {
      if (!conv.starred || addedIds.has(conv.id)) continue;
      items.push({
        conversationId: conv.id,
        spaceId: conv.spaceId,
        spaceName: getSpaceName(conv.spaceId),
        title: conv.title,
        status: 'idle',
        starred: true,
        updatedAt: conv.updatedAt,
      });
      addedIds.add(conv.id);
    }
  }

  // 4. Read items in grace period
  const now = Date.now();
  for (const [conversationId, info] of state.pulseReadAt) {
    if (addedIds.has(conversationId)) continue;
    if (now - info.readAt >= PULSE_READ_GRACE_PERIOD_MS) continue;

    // Skip skill-creator space
    if (shouldSkipSpace(info.spaceId)) continue;

    items.push({
      conversationId,
      spaceId: info.spaceId,
      spaceName: getSpaceName(info.spaceId),
      title: info.title,
      status: info.originalStatus,
      starred: false,
      updatedAt: new Date(info.readAt).toISOString(),
      readAt: info.readAt,
    });
    addedIds.add(conversationId);
  }

  // Sort by priority
  const priorityOrder: Record<TaskStatus, number> = {
    waiting: 0,
    generating: 1,
    'completed-unseen': 2,
    error: 3,
    idle: 4,
  };
  items.sort((a, b) => {
    const pa = priorityOrder[a.status];
    const pb = priorityOrder[b.status];
    if (pa !== pb) return pa - pb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return items;
}

/**
 * Count pulse items (same logic as the original usePulseCount selector).
 * Filters out skill-creator space conversations.
 */
function _computePulseCount(state: ChatState): number {
  let count = 0;
  const countedIds = new Set<string>();

  // Helper to get spaceId for a conversation
  const getSpaceIdForConversation = (conversationId: string): string | null => {
    for (const [spaceId, ss] of state.spaceStates) {
      if (ss.conversations.some((c) => c.id === conversationId)) {
        return spaceId;
      }
    }
    return null;
  };

  for (const [conversationId, session] of state.sessions) {
    const hasUnseen = state.unseenCompletions.has(conversationId);
    const status = deriveTaskStatus(session, hasUnseen);
    if (status !== 'idle') {
      const spaceId = getSpaceIdForConversation(conversationId);
      // Skip skill-creator space
      if (spaceId === SKILL_CREATOR_SPACE_ID) continue;
      count++;
      countedIds.add(conversationId);
    }
  }

  for (const [conversationId, info] of state.unseenCompletions) {
    // Skip skill-creator space
    if (info.spaceId === SKILL_CREATOR_SPACE_ID) continue;
    if (!countedIds.has(conversationId)) {
      count++;
      countedIds.add(conversationId);
    }
  }

  for (const [spaceId, ss] of state.spaceStates) {
    // Skip skill-creator space
    if (spaceId === SKILL_CREATOR_SPACE_ID) continue;
    for (const conv of ss.conversations) {
      if (conv.starred && !countedIds.has(conv.id)) {
        count++;
        countedIds.add(conv.id);
      }
    }
  }

  const now = Date.now();
  for (const [conversationId, info] of state.pulseReadAt) {
    // Skip skill-creator space
    if (info.spaceId === SKILL_CREATOR_SPACE_ID) continue;
    if (!countedIds.has(conversationId) && now - info.readAt < PULSE_READ_GRACE_PERIOD_MS) {
      count++;
      countedIds.add(conversationId);
    }
  }

  return count;
}

// Track previous pulse-relevant state to avoid unnecessary recalculations
let _prevPulseFingerprint = '';
let _prevUnseenSize = 0;
let _prevPulseReadAtSize = 0;
let _prevStarredFingerprint = '';

/**
 * Extract a fingerprint of starred conversations across all spaces.
 * Filters out skill-creator space conversations.
 */
function _extractStarredFingerprint(spaceStates: Map<string, SpaceState>): string {
  const parts: string[] = [];
  for (const [spaceId, ss] of spaceStates) {
    // Skip skill-creator space
    if (spaceId === SKILL_CREATOR_SPACE_ID) continue;
    for (const conv of ss.conversations) {
      if (conv.starred) {
        parts.push(`${conv.id}:${conv.title}:${conv.updatedAt}`);
      }
    }
  }
  return parts.join('|');
}

// Subscribe to store changes and recalculate pulse only when relevant fields change
useChatStore.subscribe((state) => {
  const sessionFingerprint = _extractPulseFingerprint(state.sessions);
  const unseenSize = state.unseenCompletions.size;
  const pulseReadAtSize = state.pulseReadAt.size;
  const starredFingerprint = _extractStarredFingerprint(state.spaceStates);

  if (
    sessionFingerprint === _prevPulseFingerprint &&
    unseenSize === _prevUnseenSize &&
    pulseReadAtSize === _prevPulseReadAtSize &&
    starredFingerprint === _prevStarredFingerprint
  ) {
    return; // No pulse-relevant changes
  }

  _prevPulseFingerprint = sessionFingerprint;
  _prevUnseenSize = unseenSize;
  _prevPulseReadAtSize = pulseReadAtSize;
  _prevStarredFingerprint = starredFingerprint;

  const newItems = _computePulseItems(state);
  const newCount = _computePulseCount(state);

  // Only update if values actually changed (avoid infinite loop)
  const currentItems = state._pulseItems;
  const itemsChanged =
    newItems.length !== currentItems.length ||
    newItems.some(
      (item, i) =>
        item.conversationId !== currentItems[i]?.conversationId ||
        item.status !== currentItems[i]?.status ||
        item.starred !== currentItems[i]?.starred ||
        item.title !== currentItems[i]?.title ||
        item.updatedAt !== currentItems[i]?.updatedAt ||
        item.readAt !== currentItems[i]?.readAt,
    );

  if (itemsChanged || newCount !== state._pulseCount) {
    useChatStore.setState({ _pulseItems: newItems, _pulseCount: newCount });
  }
});

/**
 * Selector: Get current session's isGenerating state
 * Use this in components that need to react to generation state changes
 */
export function useIsGenerating(): boolean {
  return useChatStore((state) => {
    const spaceState = state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId) : null;
    if (!spaceState?.currentConversationId) return false;
    const session = state.sessions.get(spaceState.currentConversationId);
    return session?.isGenerating ?? false;
  });
}

/**
 * Derive task status for a conversation from session state and unseen completions
 */
export function deriveTaskStatus(
  session: SessionState | undefined,
  hasUnseenCompletion: boolean,
): TaskStatus {
  if (session) {
    if (session.pendingToolApproval || session.pendingQuestion?.status === 'active')
      return 'waiting';
    if (session.error && session.errorType !== 'interrupted') return 'error';
    if (session.isGenerating) return 'generating';
  }
  if (hasUnseenCompletion) return 'completed-unseen';
  return 'idle';
}

/**
 * Selector: Get task status for a specific conversation
 */
export function useConversationTaskStatus(conversationId: string | undefined): TaskStatus {
  return useChatStore((state) => {
    if (!conversationId) return 'idle';
    const session = state.sessions.get(conversationId);
    const hasUnseen = state.unseenCompletions.has(conversationId);
    return deriveTaskStatus(session, hasUnseen);
  });
}

/**
 * Selector: Get task statuses for all conversations in the current space.
 * Returns a Map of conversationId -> TaskStatus, only including non-idle entries.
 * This replaces N individual useConversationTaskStatus subscriptions with a single one.
 */
export function useAllConversationStatuses(): Map<string, TaskStatus> {
  return useChatStore(
    (state) => {
      const result = new Map<string, TaskStatus>();
      const spaceState = state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId) : null;
      if (!spaceState) return result;

      for (const conv of spaceState.conversations) {
        const session = state.sessions.get(conv.id);
        const hasUnseen = state.unseenCompletions.has(conv.id);
        const status = deriveTaskStatus(session, hasUnseen);
        if (status !== 'idle') {
          result.set(conv.id, status);
        }
      }
      return result;
    },
    // Shallow equality: only re-render if the map content actually changed
    (a, b) => {
      if (a.size !== b.size) return false;
      for (const [id, status] of a) {
        if (b.get(id) !== status) return false;
      }
      return true;
    },
  );
}

/**
 * Selector: Get all Pulse items from derived state (pre-computed, not recalculated on every store update).
 * Recalculation is driven by the subscribe-based fingerprint watcher above.
 */
export function usePulseItems(): PulseItem[] {
  return useChatStore((state) => state._pulseItems);
}

/**
 * Selector: Get the count of pulse items from derived state (pre-computed).
 */
export function usePulseCount(): number {
  return useChatStore((state) => state._pulseCount);
}

/**
 * Selector: Get the dominant beacon color based on most urgent status
 * Returns: 'waiting' | 'completed' | 'generating' | 'error' | null
 */
export function usePulseBeaconStatus(): 'waiting' | 'completed' | 'generating' | 'error' | null {
  return useChatStore((state) => {
    let hasWaiting = false;
    let hasCompleted = false;
    let hasGenerating = false;
    let hasError = false;

    // Check all sessions
    for (const [conversationId, session] of state.sessions) {
      const hasUnseen = state.unseenCompletions.has(conversationId);
      const status = deriveTaskStatus(session, hasUnseen);
      if (status === 'waiting') hasWaiting = true;
      if (status === 'completed-unseen') hasCompleted = true;
      if (status === 'generating') hasGenerating = true;
      if (status === 'error') hasError = true;
    }

    // Check unseen completions
    if (state.unseenCompletions.size > 0) hasCompleted = true;

    // Priority: waiting > completed > generating > error
    if (hasWaiting) return 'waiting';
    if (hasCompleted) return 'completed';
    if (hasGenerating) return 'generating';
    if (hasError) return 'error';

    // Check if there are starred items (no beacon color for idle starred)
    for (const [, ss] of state.spaceStates) {
      if (ss.conversations.some((c) => c.starred)) return null;
    }

    return null;
  });
}

/**
 * Selector: Check if a specific space has any active (non-idle) tasks.
 * Used by SpaceSelector to show active indicators on space items.
 */
export function useSpaceHasActiveTasks(spaceId: string | undefined): boolean {
  return useChatStore((state) => {
    if (!spaceId) return false;
    const spaceState = state.spaceStates.get(spaceId);
    if (!spaceState) return false;

    for (const conv of spaceState.conversations) {
      const session = state.sessions.get(conv.id);
      const hasUnseen = state.unseenCompletions.has(conv.id);
      const status = deriveTaskStatus(session, hasUnseen);
      if (status !== 'idle') return true;
    }
    return false;
  });
}

/**
 * Selector: Check if any space OTHER THAN the current one has active tasks.
 * Used by SpaceSelector to show a global indicator on the space switch button.
 */
export function useOtherSpacesHaveActiveTasks(): boolean {
  return useChatStore((state) => {
    const currentSpaceId = state.currentSpaceId;
    for (const [spaceId, spaceState] of state.spaceStates) {
      if (spaceId === currentSpaceId) continue;
      for (const conv of spaceState.conversations) {
        const session = state.sessions.get(conv.id);
        const hasUnseen = state.unseenCompletions.has(conv.id);
        const status = deriveTaskStatus(session, hasUnseen);
        if (status !== 'idle') return true;
      }
    }
    return false;
  });
}

/** Detailed status info for a single conversation (used by ConversationItem) */
export interface ConversationStatusDetail {
  status: TaskStatus;
  currentAction: string;
  completedSteps: number;
  totalSteps: number;
  generatingStartedAt: number | undefined;
}

/**
 * Selector: Get detailed status for all conversations in the current space.
 * Returns a Map of conversationId -> ConversationStatusDetail (only non-idle).
 */
export function useConversationStatusDetails(): Map<string, ConversationStatusDetail> {
  return useChatStore(
    (state) => {
      const result = new Map<string, ConversationStatusDetail>();
      const spaceState = state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId) : null;
      if (!spaceState) return result;

      for (const conv of spaceState.conversations) {
        const session = state.sessions.get(conv.id);
        const hasUnseen = state.unseenCompletions.has(conv.id);
        const status = deriveTaskStatus(session, hasUnseen);
        if (status === 'idle') continue;

        const currentAction = session?.isGenerating ? getActionSummary(session.thoughts) : '';
        const { completed, total } = session?.isGenerating
          ? getStepCounts(session.thoughts)
          : { completed: 0, total: 0 };
        const generatingStartedAt =
          session && session.thoughts.length > 0
            ? new Date(session.thoughts[0].timestamp).getTime()
            : undefined;

        result.set(conv.id, {
          status,
          currentAction,
          completedSteps: completed,
          totalSteps: total,
          generatingStartedAt,
        });
      }
      return result;
    },
    (a, b) => {
      if (a.size !== b.size) return false;
      for (const [id, detail] of a) {
        const other = b.get(id);
        if (!other) return false;
        if (
          detail.status !== other.status ||
          detail.currentAction !== other.currentAction ||
          detail.completedSteps !== other.completedSteps ||
          detail.totalSteps !== other.totalSteps ||
          detail.generatingStartedAt !== other.generatingStartedAt
        )
          return false;
      }
      return true;
    },
  );
}
