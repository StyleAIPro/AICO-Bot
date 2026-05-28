/**
 * Chat View - Main chat interface
 * Uses session-based state for multi-conversation support
 * Supports onboarding mode with mock AI response
 * Features smart auto-scroll via react-virtuoso (stops when user reads history)
 *
 * Layout modes:
 * - Full width (isCompact=false): Centered content with max-width
 * - Compact mode (isCompact=true): Sidebar-style when Canvas is open
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSpaceStore } from '../../stores/space.store';
import { useChatStore } from '../../stores/chat.store';
import type { WorkerSessionState } from '../../stores/chat.store';
import { useOnboardingStore } from '../../stores/onboarding.store';
import { useAIBrowserStore } from '../../stores/ai-browser.store';
import { useKnowledgeBaseStore } from '../../stores/knowledge-base.store';
import { MessageList } from './MessageList';
import type { MessageListHandle } from './MessageList';
import { InputArea, type InputAreaRef } from './InputArea';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { WorkerTabBar, WorkerView, type WorkerTab } from './WorkerTabBar';
import { TaskBoardPanel } from '../space/TaskBoardPanel';
import { Sparkles } from '../icons/ToolIcons';
import {
  ONBOARDING_ARTIFACT_NAME,
  getOnboardingAiResponse,
  getOnboardingHtmlArtifact,
  getOnboardingPrompt,
} from '../onboarding/onboardingData';
import { api } from '../../api';
import type { ImageAttachment } from '../../types';
import { useTranslation } from '../../i18n';
import { useWorkerTabs } from '../../hooks/useWorkerTabs';
import { useSearchNavigation } from '../../hooks/useSearchNavigation';

interface ChatViewProps {
  isCompact?: boolean;
}

export function ChatView({ isCompact = false }: ChatViewProps) {
  const { t } = useTranslation();
  const { currentSpace } = useSpaceStore();
  const {
    getCurrentConversation,
    getCurrentSession,
    sendMessage,
    stopGeneration,
    continueAfterInterrupt,
    answerQuestion,
    answerWorkerQuestion,
    resolveToolPermission,
    clearPendingMessages,
  } = useChatStore();

  // Onboarding state
  const {
    isActive: isOnboarding,
    currentStep,
    nextStep,
    setMockAnimating,
    setMockThinking,
    isMockAnimating,
    isMockThinking,
  } = useOnboardingStore();

  // Mock onboarding state
  const [mockUserMessage, setMockUserMessage] = useState<string | null>(null);
  const [mockAiResponse, setMockAiResponse] = useState<string | null>(null);
  const [mockStreamingContent, setMockStreamingContent] = useState<string>('');

  // Clear mock state when onboarding completes
  useEffect(() => {
    if (!isOnboarding) {
      setMockUserMessage(null);
      setMockAiResponse(null);
      setMockStreamingContent('');
    }
  }, [isOnboarding]);

  // Load knowledge bases on mount so KB context is available in chat
  useEffect(() => {
    useKnowledgeBaseStore.getState().loadKnowledgeBases();
  }, []);

  // MessageList ref for scroll control (Virtuoso-based)
  const messageListRef = useRef<MessageListHandle>(null);

  // InputArea ref for appending content from terminal
  const inputAreaRef = useRef<InputAreaRef>(null);

  // Listen for terminal append events
  useEffect(() => {
    const handleAppendTerminalContent = (event: Event) => {
      const customEvent = event as CustomEvent<{ content: string }>;
      const { content } = customEvent.detail;
      if (content && inputAreaRef.current) {
        inputAreaRef.current.appendContent(content);
      }
    };

    window.addEventListener('append-terminal-content', handleAppendTerminalContent);
    return () => window.removeEventListener('append-terminal-content', handleAppendTerminalContent);
  }, []);

  // Scroll-to-bottom button visibility — driven by Virtuoso's atBottomStateChange
  const [showScrollButton, setShowScrollButton] = useState(false);
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom);
  }, []);

  // Handle search result navigation - scroll to message and highlight search term
  // With Virtuoso, we first scroll the target message into view by index,
  // then apply DOM-based highlighting once it's rendered.
  const displayMessagesRef = useRef<{ id: string }[]>([]);
  useSearchNavigation(messageListRef, displayMessagesRef);

  // Get current conversation and its session state
  const currentConversation = getCurrentConversation();
  const { isLoadingConversation } = useChatStore();
  const session = getCurrentSession();
  const {
    isGenerating,
    isStopping,
    streamingContent,
    isStreaming,
    thoughts,
    isThinking,
    compactInfo,
    currentContextUsage,
    error,
    errorType,
    textBlockVersion,
    pendingQuestion,
    pendingToolPermission,
    pendingMessages,
  } = session;
  const pendingCount = pendingMessages?.length || 0;

  // ===== Hyper Space Worker Tab System =====
  const [taskBoardVisible, setTaskBoardVisible] = useState(false);
  const spaceName = currentSpace?.name || 'Chat';

  const {
    activeTabId,
    tabs,
    unreadWorkers,
    activeWorkerSession,
    isViewingWorker,
    handleTabChange,
  } = useWorkerTabs({ spaceName, isGenerating });

  // workerSessions still needed for MessageList and WorkerView props
  const workerSessions = useChatStore((s) => {
    const convId = s.getCurrentSpaceState().currentConversationId;
    return convId ? s.sessions.get(convId)?.workerSessions : undefined;
  });

  const onboardingPrompt = getOnboardingPrompt(t);
  const onboardingResponse = getOnboardingAiResponse(t);
  const onboardingHtml = getOnboardingHtmlArtifact(t);

  // Handle mock onboarding send
  const handleOnboardingSend = useCallback(async () => {
    if (!currentSpace) return;

    // Step 1: Show user message immediately
    setMockUserMessage(onboardingPrompt);

    // Step 2: Start "thinking" phase (2.5 seconds) - no spotlight during this time
    setMockThinking(true);
    setMockAnimating(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setMockThinking(false);

    // Step 3: Stream mock AI response
    const response = onboardingResponse;
    for (let i = 0; i <= response.length; i++) {
      setMockStreamingContent(response.slice(0, i));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    // Step 4: Complete response
    setMockAiResponse(response);
    setMockStreamingContent('');

    // Step 5: Write the actual HTML file to disk BEFORE stopping animation
    // This ensures the file exists when ArtifactRail tries to load it
    try {
      await api.writeOnboardingArtifact(currentSpace.id, ONBOARDING_ARTIFACT_NAME, onboardingHtml);

      // Also save the conversation to disk
      await api.saveOnboardingConversation(currentSpace.id, onboardingPrompt, onboardingResponse);

      // Small delay to ensure file system has synced
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (err) {
      console.error('Failed to write onboarding artifact:', err);
    }

    // Step 6: Animation done
    // Note: Don't call nextStep() here - it's already called by Spotlight's handleHoleClick
    // We just need to stop the animation so the Spotlight can show the artifact
    setMockAnimating(false);
  }, [
    currentSpace,
    onboardingHtml,
    onboardingPrompt,
    onboardingResponse,
    setMockAnimating,
    setMockThinking,
  ]);

  // AI Browser state
  const { enabled: aiBrowserEnabled } = useAIBrowserStore();

  // Handle send (with optional images for multi-modal messages, optional thinking mode, optional agentId)
  const handleSend = async (
    content: string,
    images?: ImageAttachment[],
    thinkingEnabled?: boolean,
    aiBrowserEnabledFromInput?: boolean,
    agentId?: string,
  ) => {
    // In onboarding mode, intercept and play mock response
    if (isOnboarding && currentStep === 'send-message') {
      handleOnboardingSend();
      return;
    }

    // Can send if has text OR has images
    // Note: isGenerating check removed - messages are now queued in store
    if (!content.trim() && (!images || images.length === 0)) return;

    // Use aiBrowserEnabled from parameter if provided, otherwise use store value
    const useAiBrowser = aiBrowserEnabledFromInput ?? aiBrowserEnabled;
    // If no explicit agentId from @mention, use the activeAgentId from AgentPanel
    const effectiveAgentId = agentId ?? useChatStore.getState().activeAgentId ?? undefined;
    // Get active knowledge base IDs from store
    const activeKnowledgeBases = useKnowledgeBaseStore.getState().activeKnowledgeBaseIds;
    // Pass both AI Browser, thinking state, and knowledge base IDs to sendMessage
    await sendMessage(content, images, useAiBrowser, thinkingEnabled, effectiveAgentId, activeKnowledgeBases.length > 0 ? activeKnowledgeBases : undefined);
  };

  // Handle stop - stops the current conversation's generation
  const handleStop = async () => {
    if (currentConversation) {
      await stopGeneration(currentConversation.id);
    }
  };

  // Handle clear pending messages
  const handleClearPending = () => {
    if (currentConversation) {
      clearPendingMessages(currentConversation.id);
    }
  };

  // Combine real messages with mock onboarding messages
  const realMessages = currentConversation?.messages || [];
  const displayMessages = mockUserMessage
    ? [
        ...realMessages,
        {
          id: 'onboarding-user',
          role: 'user' as const,
          content: mockUserMessage,
          timestamp: new Date().toISOString(),
        },
        ...(mockAiResponse
          ? [
              {
                id: 'onboarding-ai',
                role: 'assistant' as const,
                content: mockAiResponse,
                timestamp: new Date().toISOString(),
              },
            ]
          : []),
      ]
    : realMessages;

  // Keep displayMessagesRef in sync for search navigation
  displayMessagesRef.current = displayMessages;

  const displayStreamingContent = mockStreamingContent || streamingContent;
  const displayIsGenerating = isMockAnimating || isGenerating;
  const displayIsThinking = isMockThinking || isThinking;
  const displayIsStreaming = isStreaming; // Only real streaming (not mock)
  const hasMessages = displayMessages.length > 0 || displayStreamingContent || displayIsThinking;

  // Track previous compact state for smooth transitions
  const prevCompactRef = useRef(isCompact);
  const isTransitioningLayout = prevCompactRef.current !== isCompact;

  useEffect(() => {
    prevCompactRef.current = isCompact;
  }, [isCompact]);

  return (
    <div
      className={`
        flex-1 flex flex-col h-full
        transition-[padding] duration-300 ease-out
        ${isCompact ? 'bg-background/50' : 'bg-background'}
      `}
    >
      {/* Messages area wrapper - relative for button positioning */}
      <div className="flex-1 relative overflow-hidden">
        {/* Virtuoso manages its own scroll container */}
        <div
          className={`
            h-full
            transition-[padding] duration-300 ease-out
            ${isCompact ? 'px-3' : 'px-4'}
          `}
        >
          {isViewingWorker && activeWorkerSession ? (
            // Worker independent conversation view
            <WorkerView
              worker={activeWorkerSession}
              spaceId={currentSpace?.id}
              isCompact={isCompact}
              onAnswerQuestion={
                activeWorkerSession.pendingQuestion?.status === 'active'
                  ? (answers) => {
                      const convId = currentConversation?.id;
                      if (convId) answerWorkerQuestion(convId, activeTabId, answers);
                    }
                  : undefined
              }
            />
          ) : isLoadingConversation ? (
            <LoadingState />
          ) : !hasMessages ? (
            <EmptyState isTemp={currentSpace?.isTemp || false} isCompact={isCompact} />
          ) : (
            <MessageList
              ref={messageListRef}
              messages={displayMessages}
              streamingContent={displayStreamingContent}
              isGenerating={displayIsGenerating}
              isStreaming={displayIsStreaming}
              thoughts={thoughts}
              isThinking={displayIsThinking}
              compactInfo={compactInfo}
              error={error}
              errorType={errorType}
              onContinue={
                currentConversation
                  ? () => continueAfterInterrupt(currentConversation.id)
                  : undefined
              }
              isCompact={isCompact}
              textBlockVersion={textBlockVersion}
              pendingQuestion={pendingQuestion}
              onAnswerQuestion={
                currentConversation
                  ? (answers) => answerQuestion(currentConversation.id, answers)
                  : undefined
              }
              pendingToolPermission={pendingToolPermission}
              onResolveToolPermission={
                currentConversation
                  ? (approved) => resolveToolPermission(currentConversation.id, approved)
                  : undefined
              }
              onAtBottomStateChange={handleAtBottomStateChange}
              workerSessions={workerSessions}
              onAnswerWorkerQuestion={(agentId, answers) =>
                answerWorkerQuestion(currentConversation?.id || '', agentId, answers)
              }
            />
          )}
        </div>

        {/* Scroll to bottom button - positioned outside scroll container */}
        <ScrollToBottomButton
          visible={showScrollButton && hasMessages && !isViewingWorker}
          onClick={() => messageListRef.current?.scrollToBottom('auto')}
        />
      </div>

      {/* Worker Tab Bar — shown between messages and input when workers are active */}
      <WorkerTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={handleTabChange}
        unreadWorkers={unreadWorkers}
      />

      {/* Input area — available on both main tab and worker tabs */}
      {/* TaskBoard toggle button - only for Hyper Space */}
      {currentSpace?.spaceType === 'hyper' && (
        <div className="flex items-center justify-end px-4 pt-1">
          <button
            onClick={() => setTaskBoardVisible(!taskBoardVisible)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${
              taskBoardVisible
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {taskBoardVisible ? 'Hide' : 'Show'} TaskBoard
          </button>
        </div>
      )}

      {/* TaskBoard Panel */}
      {currentSpace?.spaceType === 'hyper' && (
        <TaskBoardPanel spaceId={currentSpace.id} visible={taskBoardVisible} />
      )}

      {/* On worker tabs: handleSend auto-injects activeAgentId so messages route to the selected worker */}
      <InputArea
        ref={inputAreaRef}
        onSend={handleSend}
        onStop={handleStop}
        onClearPending={handleClearPending}
        isGenerating={isGenerating}
        isStopping={isStopping}
        pendingCount={pendingCount}
        placeholder={
          isCompact
            ? t('Continue conversation...')
            : currentSpace?.isTemp
              ? t('Say something to AICO-Bot...')
              : t('Continue conversation...')
        }
        isCompact={isCompact}
        spaceId={currentSpace?.id}
        conversationId={currentConversation?.id}
        contextUsage={currentContextUsage}
      />
    </div>
  );
}

// Loading state component
function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col items-center justify-center">
      <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      <p className="mt-3 text-sm text-muted-foreground">{t('Loading conversation...')}</p>
    </div>
  );
}

// Empty state component - adapts to compact mode
function EmptyState({ isTemp, isCompact = false }: { isTemp: boolean; isCompact?: boolean }) {
  const { t } = useTranslation();
  // Compact mode shows minimal UI
  if (isCompact) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-4">
        <Sparkles className="w-8 h-8 text-primary/70" />
        <p className="mt-4 text-sm text-muted-foreground">{t('Continue the conversation here')}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8">
      {/* Icon */}
      <Sparkles className="w-12 h-12 text-primary" />

      {/* Title - concise and warm */}
      <h2 className="mt-6 text-xl font-medium">AICO-Bot</h2>
      <p className="mt-2 text-muted-foreground">{t('Not just chat, help you get things done')}</p>

      {/* Powered by badge - simplified */}
      <div className="mt-8 px-3 py-1.5 rounded-full border border-border">
        <span className="text-xs text-muted-foreground">Powered by Claude Code</span>
      </div>
    </div>
  );
}
