/**
 * AICO-Bot - Main App Component
 */

import { useEffect, useRef, useState, Suspense, lazy } from 'react';
import { useAppStore } from './stores/app.store';
import { useChatStore } from './stores/chat.store';
import { useOnboardingStore } from './stores/onboarding.store';
import { initAIBrowserStoreListeners } from './stores/ai-browser.store';
import { useSpaceStore } from './stores/space.store';
import { useSearchStore } from './stores/search.store';
import { useAppsStore } from './stores/apps.store';
import { useAppsPageStore } from './stores/apps-page.store';
import { SplashScreen } from './components/splash/SplashScreen';
import { SetupFlow } from './components/setup/SetupFlow';
import { GitBashSetup } from './components/setup/GitBashSetup';
import { SearchPanel } from './components/search/SearchPanel';
import { SearchHighlightBar } from './components/search/SearchHighlightBar';
import { OnboardingOverlay } from './components/onboarding';
import { UpdateNotification } from './components/updater/UpdateNotification';
import { NotificationToast } from './components/notification/NotificationToast';
import { useNotificationStore } from './stores/notification.store';
import { api } from './api';
import { useTranslation } from './i18n';
import type {
  AgentEventBase,
  Thought,
  ToolCall,
  AicoBotConfig,
  AgentErrorType,
  Question,
  TokenUsage,
} from './types';
import { hasAnyAISource } from './types';

// Lazy load heavy page components for better initial load performance
// These pages contain complex components (chat, markdown, code highlighting, etc.)
const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const SpacePage = lazy(() => import('./pages/SpacePage').then((m) => ({ default: m.SpacePage })));
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AppsPage = lazy(() => import('./pages/AppsPage').then((m) => ({ default: m.AppsPage })));
const SkillPage = lazy(() =>
  import('./pages/skill/SkillPage').then((m) => ({ default: m.SkillPage })),
);
const RemoteServersPage = lazy(() =>
  import('./pages/RemoteServersPage').then((m) => ({ default: m.RemoteServersPage })),
);
const RemoteAgentChatPage = lazy(() =>
  import('./pages/RemoteAgentChatPage').then((m) => ({ default: m.RemoteAgentChatPage })),
);
const KnowledgePage = lazy(() =>
  import('./pages/KnowledgePage').then((m) => ({ default: m.KnowledgePage })),
);

// Page loading fallback - minimal spinner that matches app style
function PageLoader() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    </div>
  );
}

// Theme colors for titleBarOverlay
const THEME_COLORS = {
  light: { color: '#ffffff', symbolColor: '#1a1a1a' },
  dark: { color: '#0a0a0a', symbolColor: '#ffffff' },
};

// Apply theme to document and sync to localStorage (for anti-flash on reload)
function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement;

  // Save to localStorage for anti-flash script
  try {
    localStorage.setItem('aico-bot-theme', theme);
  } catch (e) {
    /* ignore */
  }

  let isDark: boolean;
  if (theme === 'system') {
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('light', !isDark);
  } else {
    isDark = theme === 'dark';
    root.classList.toggle('light', theme === 'light');
  }

  // Update titleBarOverlay colors (Windows/Linux only)
  const colors = isDark ? THEME_COLORS.dark : THEME_COLORS.light;
  api.setTitleBarOverlay(colors).catch(() => {
    // Ignore errors - may not be supported on current platform
  });
}

export default function App() {
  const { t } = useTranslation();
  const {
    view,
    config,
    initialize,
    setMcpStatus,
    setView,
    setConfig,
    completeDeferredGitBashCheck,
  } = useAppStore();
  const {
    handleAgentMessage,
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentError,
    handleAgentStreamAlive,
    handleAgentIdleTimeout,
    handleAgentComplete,
    handleAgentThought,
    handleAgentThoughtDelta,
    handleAgentCompact,
    handleAgentContextUsage,
    handleAskQuestion,
    handlePermissionRequest,
    resolveToolPermission,
    handleHyperSpaceProgress,
    handleAgentTeamMessage,
    handleWorkerStarted,
    handleWorkerCompleted,
    currentSpaceId,
    setCurrentSpace: setChatCurrentSpace,
    loadConversations,
    selectConversation,
  } = useChatStore();
  const { initialize: initializeOnboarding } = useOnboardingStore();
  const {
    isSearchOpen,
    closeSearch,
    isHighlightBarVisible,
    hideHighlightBar,
    goToPreviousResult,
    goToNextResult,
    openSearch,
  } = useSearchStore();

  // Apps system real-time event handlers
  const { handleStatusChanged, handleNewActivityEntry, handleNewEscalation } = useAppsStore();
  const { setInitialAppId } = useAppsPageStore();

  // For search result navigation
  const {
    spaces,
    aicoBotSpace,
    setCurrentSpace: setSpaceStoreCurrentSpace,
    refreshCurrentSpace,
  } = useSpaceStore();

  // Initialize app on mount - wait for backend extended services to be ready
  // Uses Pull+Push pattern for reliable initialization:
  // - Pull: Query status immediately (handles HMR, error recovery - 0ms delay)
  // - Push: Listen for event (normal startup flow)
  // - Timeout: Fallback protection if something goes wrong
  useEffect(() => {
    let initialized = false;
    const startTime = Date.now();
    console.log('[App] Mounted, initializing with Pull+Push pattern...');

    const doInit = async (trigger: 'query' | 'event' | 'timeout') => {
      if (initialized) return;
      initialized = true;

      const waitTime = Date.now() - startTime;
      console.log(`[App] Starting initialization (trigger: ${trigger}, waited: ${waitTime}ms)`);

      await initialize();
      // Initialize onboarding after app config is loaded
      await initializeOnboarding();
    };

    // 1. Pull: Query current status immediately
    // This handles HMR reload and error recovery scenarios where event was already sent
    api
      .getBootstrapStatus()
      .then((status) => {
        if (status.extendedReady) {
          console.log('[App] Bootstrap status: already ready, initializing immediately');
          doInit('query');
        } else {
          console.log('[App] Bootstrap status: not ready, waiting for event...');
        }
      })
      .catch((err) => {
        console.warn('[App] Failed to query bootstrap status:', err);
      });

    // 2. Push: Listen for extended services ready event from main process
    // This is the normal startup flow for fresh app launch
    const unsubscribe = api.onBootstrapExtendedReady((data) => {
      console.log('[App] Received bootstrap:extended-ready', data);
      if (!initialized) {
        // Normal path: extended services ready before timeout
        doInit('event');
      } else {
        // Timeout already fired and initialize() ran. Extended services are now ready,
        // so complete any deferred checks (e.g. git-bash on Windows) that failed
        // because IPC handlers weren't registered yet during the timeout-triggered init.
        console.log('[App] Extended ready after timeout, completing deferred checks...');
        completeDeferredGitBashCheck();
      }
    });

    // 3. Timeout: Fallback protection if something goes wrong
    // Reduced to 5s since we now have Pull mechanism as primary fast path
    const fallbackTimeout = setTimeout(() => {
      if (!initialized) {
        console.warn('[App] Bootstrap timeout after 5000ms, force initializing...');
        doInit('timeout');
      }
    }, 5000);

    return () => {
      unsubscribe();
      clearTimeout(fallbackTimeout);
    };
  }, [initialize, initializeOnboarding, completeDeferredGitBashCheck]);

  // Theme switching
  useEffect(() => {
    // Default to 'light' before config loads, then use config value
    const theme = config?.appearance?.theme || 'light';
    applyTheme(theme);

    // Listen for system theme changes when using 'system' mode
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => applyTheme('system');
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [config?.appearance?.theme]);

  // Connect WebSocket for remote mode
  useEffect(() => {
    if (api.isRemoteMode()) {
      console.log('[App] Remote mode detected, connecting WebSocket...');
      api.connectWebSocket();
    }
  }, []);

  // Initialize AI Browser IPC listeners for active view sync
  useEffect(() => {
    console.log('[App] Initializing AI Browser store listeners');
    const cleanup = initAIBrowserStoreListeners();
    return cleanup;
  }, []);

  // Register agent event listeners (global - handles events for all conversations)
  useEffect(() => {
    console.log('[App] Registering agent event listeners');

    // Primary thought listener - handles all agent reasoning events
    const unsubThought = api.onAgentThought((data) => {
      console.log('[App] Received agent:thought event:', data);
      handleAgentThought(data as AgentEventBase & { thought: Thought });
    });

    // Thought delta listener - handles incremental updates to streaming thoughts
    const unsubThoughtDelta = api.onAgentThoughtDelta((data) => {
      // Don't log every delta to reduce noise
      handleAgentThoughtDelta(
        data as AgentEventBase & {
          thoughtId: string;
          delta?: string;
          content?: string;
          toolInput?: Record<string, unknown>;
          isComplete?: boolean;
          isReady?: boolean;
          isToolInput?: boolean;
        },
      );
    });

    // Message events (with session IDs)
    const unsubMessage = api.onAgentMessage((data) => {
      console.log('[App] Received agent:message event:', data);
      handleAgentMessage(data as AgentEventBase & { content: string; isComplete: boolean });
    });

    const unsubToolCall = api.onAgentToolCall((data) => {
      console.log('[App] Received agent:tool-call event:', data);
      handleAgentToolCall(data as AgentEventBase & ToolCall);
    });

    const unsubToolResult = api.onAgentToolResult((data) => {
      console.log('[App] Received agent:tool-result event:', data);
      handleAgentToolResult(
        data as AgentEventBase & { toolId: string; result: string; isError: boolean },
      );
    });

    const unsubError = api.onAgentError((data) => {
      console.log('[App] Received agent:error event:', data);
      handleAgentError(data as AgentEventBase & { error: string; errorType?: AgentErrorType });
    });

    const unsubComplete = api.onAgentComplete((data) => {
      console.log('[App] Received agent:complete event:', data);
      handleAgentComplete(data as AgentEventBase & { tokenUsage?: TokenUsage | null });
    });

    const unsubCompact = api.onAgentCompact((data) => {
      console.log('[App] Received agent:compact event:', data);
      handleAgentCompact(
        data as AgentEventBase & { trigger: 'manual' | 'auto'; preTokens: number },
      );
    });

    const unsubContextUsage = api.onAgentContextUsage((data) => {
      handleAgentContextUsage(
        data as AgentEventBase & {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          contextWindow?: number;
        },
      );
    });

    const unsubStreamAlive = api.onAgentStreamAlive((data) => {
      handleAgentStreamAlive(data as AgentEventBase & { elapsedMs: number; currentToolName?: string; currentToolElapsedMs?: number });
    });

    const unsubIdleTimeout = api.onAgentIdleTimeout((data) => {
      handleAgentIdleTimeout(data as AgentEventBase & { idleMinutes: number });
    });

    // AskUserQuestion - AI needs user input to continue
    const unsubAskQuestion = api.onAgentAskQuestion((data) => {
      console.log('[App] Received agent:ask-question event:', data);
      handleAskQuestion(
        data as AgentEventBase & {
          id: string;
          questions: Question[];
          agentId?: string;
          agentName?: string;
        },
      );
    });

    // Tool permission request - AI needs user approval for high-risk operations
    const unsubPermissionRequest = api.onAgentPermissionRequest((data) => {
      console.log('[App] Received agent:permission-request event:', data);
      handlePermissionRequest(
        data as AgentEventBase & {
          id: string;
          toolName: string;
          toolInput: Record<string, unknown>;
          timestamp: number;
        },
      );
    });

    // MCP status updates (global - not per-conversation)
    const unsubMcpStatus = api.onAgentMcpStatus((data) => {
      console.log('[App] Received agent:mcp-status event:', data);
      const event = data as { servers: Array<{ name: string; status: string }>; timestamp: number };
      if (event.servers) {
        setMcpStatus(event.servers as any, event.timestamp);
      }
    });

    // Hyper Space progress updates (subagent progress)
    const unsubHyperProgress = api.onHyperSpaceProgress((data) => {
      console.log('[App] Received agent:hyper-progress event:', data);
      // Handle Hyper Space progress - subagent is making progress
      // This can be used to show real-time feedback in the UI
      handleHyperSpaceProgress(data);
    });

    // Agent team messages (inter-agent communication)
    const unsubTeamMessage = api.onAgentTeamMessage((data) => {
      console.log('[App] Received agent:team-message event:', data);
      handleAgentTeamMessage(
        data as AgentEventBase & {
          id: string;
          type: 'agent_message';
          recipientId: string;
          recipientName: string;
          content: string;
          summary: string;
          timestamp: number;
        },
      );
    });

    // Turn boundary - check for pending messages and inject if any
    // NOTE: We do NOT remove from pendingMessages here — that's done in the
    // agent:injection-start handler (reliable backend confirmation). If injection
    // fails (IPC too slow for 300ms window), handleAgentComplete will pick up
    // the message from pendingMessages as fallback.
    const unsubTurnBoundary = api.onAgentTurnBoundary((data) => {
      console.log('[App] Received agent:turn-boundary event:', data);
      const event = data as AgentEventBase & {
        toolName?: string;
        toolId: string;
        timestamp: number;
      };
      // Get pending messages from chat store and inject if any
      const state = useChatStore.getState();
      const session = state.getSession(event.conversationId);
      const pendingMessages = session.pendingMessages || [];

      if (pendingMessages.length > 0) {
        const firstMessage = pendingMessages[0];
        console.log(
          `[App] Found ${pendingMessages.length} pending message(s), injecting first one`,
        );

        // Inject the message to backend (fire-and-forget — removal happens in injection-start handler)
        api
          .injectMessage({
            conversationId: event.conversationId,
            content: firstMessage.content,
            images: firstMessage.images,
            thinkingEnabled: firstMessage.thinkingEnabled,
            aiBrowserEnabled: firstMessage.aiBrowserEnabled,
          })
          .catch((err) => {
            console.error('[App] Error injecting message:', err);
          });
      }
    });

    // Injection start - reliable confirmation that backend picked up the injection.
    // Only at this point do we remove from pendingMessages, avoiding the race condition
    // where removePendingMessage runs before handleAgentComplete checks.
    const unsubInjectionStart = api.onAgentInjectionStart((data) => {
      const event = data as AgentEventBase & { content: string };
      console.log('[App] Received agent:injection-start event:', event.conversationId);
      const state = useChatStore.getState();
      const session = state.getSession(event.conversationId);
      const pendingMessages = session?.pendingMessages || [];

      // Find and remove the matching pending message by content
      const matchIdx = pendingMessages.findIndex((m) => m.content === event.content);
      if (matchIdx !== -1) {
        console.log('[App] Removing injected message from pending queue (confirmed by backend)');
        state.removePendingMessage(event.conversationId, pendingMessages[matchIdx].id);
      }
    });

    // Worker lifecycle events (Hyper Space)
    const unsubWorkerStarted = api.onWorkerStarted((data) => {
      console.log('[App] Received worker:started event:', data);
      handleWorkerStarted(data as any);
    });

    const unsubWorkerCompleted = api.onWorkerCompleted((data) => {
      console.log('[App] Received worker:completed event:', data);
      handleWorkerCompleted(data as any);
    });

    return () => {
      unsubThought();
      unsubThoughtDelta();
      unsubMessage();
      unsubToolCall();
      unsubToolResult();
      unsubError();
      unsubComplete();
      unsubCompact();
      unsubContextUsage();
      unsubStreamAlive();
      unsubIdleTimeout();
      unsubAskQuestion();
      unsubPermissionRequest();
      unsubMcpStatus();
      unsubHyperProgress();
      unsubTeamMessage();
      unsubTurnBoundary();
      unsubInjectionStart();
      unsubWorkerStarted();
      unsubWorkerCompleted();
    };
  }, [
    handleAgentMessage,
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentError,
    handleAgentStreamAlive,
    handleAgentIdleTimeout,
    handleAgentComplete,
    handleAgentThought,
    handleAgentThoughtDelta,
    handleAgentCompact,
    handleAgentContextUsage,
    handleAskQuestion,
    handlePermissionRequest,
    resolveToolPermission,
    handleHyperSpaceProgress,
    handleAgentTeamMessage,
    handleWorkerStarted,
    handleWorkerCompleted,
    setMcpStatus,
  ]);

  // Register Apps system real-time event listeners
  // These run globally so events are captured even when AppsPage is not mounted
  useEffect(() => {
    console.log('[App] Registering app event listeners');

    const unsubStatus = api.onAppStatusChanged((data) => {
      const { appId, state } = data as { appId: string; state: unknown };
      handleStatusChanged(appId, state as Parameters<typeof handleStatusChanged>[1]);
    });

    const unsubActivity = api.onAppActivityEntry((data) => {
      const { appId, entry } = data as { appId: string; entry: unknown };
      handleNewActivityEntry(appId, entry as Parameters<typeof handleNewActivityEntry>[1]);
    });

    const unsubEscalation = api.onAppEscalation((data) => {
      const { appId, entryId, question, choices } = data as {
        appId: string;
        entryId: string;
        question: string;
        choices: string[];
      };
      handleNewEscalation(appId, entryId, question, choices);
    });

    // Deep navigation: notification click → navigate to specific App's Activity Thread
    const unsubNavigate = api.onAppNavigate((data) => {
      const { appId } = data as { appId: string };
      if (appId) {
        console.log(`[App] Notification deep navigation: appId=${appId}`);
        setInitialAppId(appId);
        setView('apps');
      }
    });

    return () => {
      unsubStatus();
      unsubActivity();
      unsubEscalation();
      unsubNavigate();
    };
  }, [handleStatusChanged, handleNewActivityEntry, handleNewEscalation, setInitialAppId, setView]);

  // Register in-app toast listener (notification:toast from main process)
  const showToast = useNotificationStore((s) => s.show);
  useEffect(() => {
    const unsub = api.onNotificationToast((data) => {
      const { title, body, variant, duration, appId } = data as {
        title: string;
        body?: string;
        variant?: 'default' | 'success' | 'warning' | 'error';
        duration?: number;
        appId?: string;
      };
      showToast({
        title,
        body,
        variant: variant ?? 'default',
        duration: duration ?? 6000,
        // If appId is provided, add a "View" action for deep navigation
        ...(appId
          ? {
              action: {
                label: t('View'),
                onClick: () => {
                  setInitialAppId(appId);
                  setView('apps');
                },
              },
            }
          : {}),
      });
    });
    return () => {
      unsub();
    };
  }, [showToast, setInitialAppId, setView, t]);

  // Handle search keyboard shortcuts with debouncing for navigation
  // Use ref to maintain debounce timer across renders
  const navigationDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingNavigationRef = useRef<(() => void) | null>(null);

  const debouncedNavigate = (callback: () => void) => {
    // Clear previous timeout
    if (navigationDebounceTimerRef.current) {
      clearTimeout(navigationDebounceTimerRef.current);
    }

    // Store the pending navigation
    pendingNavigationRef.current = callback;

    // Set new timeout - debounce for 300ms
    navigationDebounceTimerRef.current = setTimeout(() => {
      console.log('[App] Executing debounced keyboard navigation');
      pendingNavigationRef.current?.();
      pendingNavigationRef.current = null;
      navigationDebounceTimerRef.current = null;
    }, 300);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle when highlight bar is visible
      if (!isHighlightBarVisible) return;

      const isMac =
        typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

      // Esc - Close highlight bar (no debounce needed)
      if (e.key === 'Escape') {
        e.preventDefault();
        hideHighlightBar();
        return;
      }

      // Arrow up - Navigate to earlier result (with debounce)
      // Note: In time-sorted results (newest first), earlier = higher index
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        debouncedNavigate(() => {
          console.log('[App] Keyboard: navigating to earlier result');
          goToNextResult(); // goToNextResult increases index = earlier in time
        });
        return;
      }

      // Arrow down - Navigate to more recent result (with debounce)
      // Note: In time-sorted results (newest first), more recent = lower index
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        debouncedNavigate(() => {
          console.log('[App] Keyboard: navigating to more recent result');
          goToPreviousResult(); // goToPreviousResult decreases index = more recent in time
        });
        return;
      }

      // Ctrl+K / Cmd+K - Open search to edit (no debounce needed)
      const metaKey = isMac ? e.metaKey : e.ctrlKey;
      if (metaKey && e.key === 'k' && !e.shiftKey) {
        e.preventDefault();
        openSearch();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHighlightBarVisible, hideHighlightBar, goToPreviousResult, goToNextResult, openSearch]);

  // Handle search result navigation from highlight bar
  // This handles the complete navigation flow when user clicks [↑][↓] or uses arrow keys
  useEffect(() => {
    const handleNavigateToResult = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        messageId: string;
        spaceId: string;
        conversationId: string;
        query: string;
        resultIndex: number;
      }>;

      const { messageId, spaceId, conversationId, query } = customEvent.detail;

      console.log(
        `[App] search:navigate-to-result event - space=${spaceId}, conv=${conversationId}, msg=${messageId}`,
      );

      try {
        // Step 1: If switching spaces, update both stores
        if (spaceId !== currentSpaceId) {
          console.log(`[App] Switching to space: ${spaceId}`);

          // Find the space object
          let targetSpace = null;
          if (spaceId === 'aico-bot-temp' && aicoBotSpace) {
            targetSpace = aicoBotSpace;
          } else {
            targetSpace = spaces.find((s) => s.id === spaceId);
          }

          if (!targetSpace) {
            console.error(`[App] Space not found: ${spaceId}`);
            return;
          }

          // Update spaceStore
          console.log(`[App] Updating space to: ${targetSpace.name}`);
          setSpaceStoreCurrentSpace(targetSpace);
          refreshCurrentSpace(); // Load full space data (preferences) from backend

          // Update chatStore
          setChatCurrentSpace(spaceId);

          // Give state time to update
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        // Step 2: Load conversations if needed
        console.log(`[App] Loading conversations for space: ${spaceId}`);
        await loadConversations(spaceId);

        // Step 3: Select conversation
        console.log(`[App] Selecting conversation: ${conversationId}`);
        await selectConversation(conversationId);

        // Step 4: Dispatch navigation event for ChatView to handle
        // ChatView uses Virtuoso scrollToIndex to bring the message into viewport,
        // then applies DOM highlighting — no need to pre-check DOM existence here.
        // Small delay to let conversation data load and MessageList mount.
        setTimeout(() => {
          console.log(`[App] Dispatching navigate-to-message for: ${messageId}`);
          const navEvent = new CustomEvent('search:navigate-to-message', {
            detail: {
              messageId,
              query,
            },
          });
          window.dispatchEvent(navEvent);
        }, 300);
      } catch (error) {
        console.error(`[App] Error navigating to result:`, error);
      }
    };

    window.addEventListener('search:navigate-to-result', handleNavigateToResult);
    return () => window.removeEventListener('search:navigate-to-result', handleNavigateToResult);
  }, [
    currentSpaceId,
    spaces,
    aicoBotSpace,
    setSpaceStoreCurrentSpace,
    refreshCurrentSpace,
    setChatCurrentSpace,
    loadConversations,
    selectConversation,
  ]);

  // Handle Git Bash setup completion
  const handleGitBashSetupComplete = async (installed: boolean) => {
    console.log('[App] Git Bash setup completed, installed:', installed);

    // Save skip preference if not installed
    if (!installed) {
      await api.setConfig({ gitBash: { skipped: true, installed: false, path: null } });
    }

    // Continue with normal initialization - sync config to store
    const response = await api.getConfig();
    if (response.success && response.data) {
      const loadedConfig = response.data as AicoBotConfig;
      setConfig(loadedConfig); // Sync config to store (was missing, causing empty apiKey in settings)
      // Show setup if first launch or no AI source configured
      if (loadedConfig.isFirstLaunch || !hasAnyAISource(loadedConfig.aiSources)) {
        setView('setup');
      } else {
        setView('home');
      }
    } else {
      setView('setup');
    }
  };

  // Render based on current view
  // Heavy pages (HomePage, SpacePage, SettingsPage) are lazy-loaded for better initial performance
  const renderView = () => {
    switch (view) {
      case 'splash':
        return <SplashScreen />;
      case 'gitBashSetup':
        return <GitBashSetup onComplete={handleGitBashSetupComplete} />;
      case 'setup':
        return <SetupFlow />;
      case 'home':
        return (
          <Suspense fallback={<PageLoader />}>
            <HomePage />
          </Suspense>
        );
      case 'space':
        return (
          <Suspense fallback={<PageLoader />}>
            <SpacePage />
          </Suspense>
        );
      case 'settings':
        return (
          <Suspense fallback={<PageLoader />}>
            <SettingsPage />
          </Suspense>
        );
      case 'apps':
        return (
          <Suspense fallback={<PageLoader />}>
            <AppsPage />
          </Suspense>
        );
      case 'skill':
        return (
          <Suspense fallback={<PageLoader />}>
            <SkillPage />
          </Suspense>
        );
      case 'remoteServers':
        return (
          <Suspense fallback={<PageLoader />}>
            <RemoteServersPage />
          </Suspense>
        );
      case 'knowledgeBase':
        return (
          <Suspense fallback={<PageLoader />}>
            <KnowledgePage />
          </Suspense>
        );
      case 'remoteChat':
        return (
          <Suspense fallback={<PageLoader />}>
            <RemoteAgentChatPage />
          </Suspense>
        );
      default:
        return <SplashScreen />;
    }
  };

  return (
    <div className="h-full w-full overflow-hidden bg-background">
      {renderView()}
      {/* Search panel - full screen edit mode */}
      <SearchPanel isOpen={isSearchOpen} onClose={closeSearch} />
      {/* Search highlight bar - floating navigation mode */}
      <SearchHighlightBar />
      {/* Onboarding overlay - renders on top of everything */}
      <OnboardingOverlay />
      {/* Update notification listener - pushes toasts into notification store */}
      <UpdateNotification />
      {/* Unified in-app toast notifications */}
      <NotificationToast />
    </div>
  );
}
