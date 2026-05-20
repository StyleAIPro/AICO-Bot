/**
 * Input Area - Enhanced message input with bottom toolbar
 *
 * Layout (following industry standard - Qwen, ChatGPT, Baidu):
 * ┌──────────────────────────────────────────────────────┐
 * │ [Image previews]                                     │
 * │ ┌──────────────────────────────────────────────────┐ │
 * │ │ Textarea                                         │ │
 * │ └──────────────────────────────────────────────────┘ │
 * │ [+] [⚛]─────────────────────────────────  [Send] │
 * │      Bottom toolbar: always visible, expandable     │
 * └──────────────────────────────────────────────────────┘
 *
 * Features:
 * - Auto-resize textarea
 * - Keyboard shortcuts (Enter to send, Shift+Enter newline)
 * - Image paste/drop support with compression
 * - Extended thinking mode toggle (theme-colored)
 * - Bottom toolbar for future extensibility
 */

import type { KeyboardEvent, ForwardedRef } from 'react';
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  ClipboardEvent,
  DragEvent,
  useImperativeHandle,
  forwardRef,
} from 'react';
import {
  Plus,
  ImagePlus,
  Loader2,
  AlertCircle,
  CheckCircle,
  Atom,
  Globe,
  Boxes,
  Clock,
  X,
  Crown,
  Wrench,
  Cloud,
  Monitor,
  BookOpen,
  Check,
} from 'lucide-react';
import { useOnboardingStore } from '../../stores/onboarding.store';
import { useAIBrowserStore } from '../../stores/ai-browser.store';
import { useKnowledgeBaseStore } from '../../stores/knowledge-base.store';
import { useSpaceStore } from '../../stores/space.store';
import { useChatStore } from '../../stores/chat.store';
import { getOnboardingPrompt } from '../onboarding/onboardingData';
import { ImageAttachmentPreview } from './ImageAttachmentPreview';
import type { ImageAttachment } from '../../types';
import { useTranslation } from '../../i18n';
import { api } from '../../api';
import { useMentionSystem, type AgentMember } from '../../hooks/useMentionSystem';
import { useImageAttachments, MAX_IMAGES } from '../../hooks/useImageAttachments';
import { useSlashCommand, type SlashCommandExecutionResult } from '../../hooks/slash-command';
import { useInputHistory } from '../../hooks/useInputHistory';
import { SlashCommandMenu } from './SlashCommandMenu';

interface InputAreaProps {
  onSend: (
    content: string,
    images?: ImageAttachment[],
    thinkingEnabled?: boolean,
    aiBrowserEnabled?: boolean,
    agentId?: string,
  ) => void;
  onStop: () => void;
  onClearPending?: () => void; // Clear pending messages
  isGenerating: boolean;
  isStopping?: boolean; // True when user clicked stop, waiting for cleanup
  pendingCount?: number; // Number of messages waiting in queue
  placeholder?: string;
  isCompact?: boolean;
  spaceId?: string;
  conversationId?: string;
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
  } | null;
}

export interface InputAreaRef {
  appendContent: (newContent: string) => void;
  setContent: (newContent: string) => void;
}

function InputAreaInternal(
  {
    onSend,
    onStop,
    onClearPending,
    isGenerating,
    isStopping = false,
    pendingCount = 0,
    placeholder,
    isCompact = false,
    spaceId,
    conversationId,
    contextUsage,
  }: InputAreaProps,
  ref: ForwardedRef<InputAreaRef>,
) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false); // Extended thinking mode

  // Clear input when switching conversations
  useEffect(() => {
    setContent('');
  }, [conversationId]);
  const [showAttachMenu, setShowAttachMenu] = useState(false); // Attachment menu visibility
  const [showKbMenu, setShowKbMenu] = useState(false); // Knowledge base menu visibility
  const [isCompacting, setIsCompacting] = useState(false); // Context compression in progress
  const [compactResult, setCompactResult] = useState<'success' | 'error' | null>(null); // Compression result notification

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  // AI Browser state
  const { enabled: aiBrowserEnabled, setEnabled: setAIBrowserEnabled } = useAIBrowserStore();

  // Knowledge base state
  const {
    knowledgeBases,
    activeKnowledgeBaseIds,
    toggleActiveKb,
    loadKnowledgeBases,
  } = useKnowledgeBaseStore();

  // Space state - to determine if this is a local, remote, or hyper space
  const currentSpaceId = useSpaceStore((state) => state.currentSpace?.id);
  const currentSpaceRemoteServerId = useSpaceStore((state) => state.currentSpace?.remoteServerId);
  const currentSpaceType = useSpaceStore((state) => {
    if (!state.currentSpace) return null;
    return {
      isTemp: state.currentSpace.isTemp,
      claudeSource: state.currentSpace.claudeSource,
      spaceType: state.currentSpace.spaceType,
    };
  });
  const isHyperSpace = currentSpaceType?.spaceType === 'hyper';

  // ===== Hooks =====

  // Mention system (@ autocomplete for Hyper Space agents)
  const {
    targetAgentIds,
    setTargetAgentIds,
    showMentionPopup,
    mentionPopupRef,
    filteredMembers,
    selectedMentionIndex,
    handleTextChange: handleMentionTextChange,
    selectAgent,
    handleMentionKeyDown,
  } = useMentionSystem({
    spaceId,
    isHyperSpace,
    content,
    setContent,
    textareaRef,
  });

  // Image attachments (paste/drop/file-input with compression)
  const {
    images,
    isDragOver,
    isProcessingImages,
    imageError,
    fileInputRef,
    removeImage,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileInputChange,
    clearImages,
    hasImages,
  } = useImageAttachments();

  // Slash command system (/ autocomplete)
  const handleCommandResult = useCallback(
    (result: SlashCommandExecutionResult) => {
      // Clear input
      setContent('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      // Inject command result as message into chat UI (both DB + store cache)
      const spaceId = currentSpaceId;
      if (spaceId && conversationId) {
        const prefix = result.success ? '/ ' : '/! ';
        const messageContent = `${prefix}${result.message}`;
        const now = new Date().toISOString();

        // 1. Persist to DB
        api
          .addMessage(spaceId, conversationId, {
            role: 'user',
            content: messageContent,
          })
          .catch(console.error);

        // 2. Update chat store cache so UI refreshes immediately
        // Use the store object directly (not the hook result) for setState
        useChatStore.setState((state) => {
          const conversation = state.conversationCache.get(conversationId);
          if (!conversation) return {};
          const newMessage = {
            id: `slash-cmd-${Date.now()}`,
            role: 'user' as const,
            content: messageContent,
            timestamp: now,
          };
          const newCache = new Map(state.conversationCache);
          newCache.set(conversationId, {
            ...conversation,
            messages: [...conversation.messages, newMessage],
          });
          return { conversationCache: newCache };
        });
      }
    },
    [currentSpaceId, conversationId],
  );

  const {
    showCommandMenu,
    commandMenuRef,
    matchedCommands,
    selectedIndex,
    isExecuting,
    handleTextChange: handleSlashTextChange,
    handleSlashKeyDown,
    selectMenuItem,
  } = useSlashCommand({
    content,
    setContent,
    textareaRef,
    onExecuteCommand: handleCommandResult,
    claudeSource: currentSpaceType?.claudeSource,
    remoteServerId: currentSpaceRemoteServerId,
  });

  // Input history (arrow key navigation through user messages)
  const { handleHistoryKeyDown, handleHistoryInputChange, resetHistory } = useInputHistory({
    conversationId,
    content,
    setContent,
    textareaRef,
  });

  // Initialize AI Browser based on space type
  useEffect(() => {
    if (!spaceId || !currentSpaceType) return;

    const isLocalSpace =
      currentSpaceType.isTemp ||
      currentSpaceType.claudeSource === 'local' ||
      currentSpaceType.claudeSource === undefined;
    const shouldBeEnabled = isLocalSpace;

    console.log(
      `[InputArea] Space changed: ${spaceId}, isLocal=${isLocalSpace}, claudeSource=${currentSpaceType.claudeSource}, enabling AI Browser: ${shouldBeEnabled}`,
    );
    setAIBrowserEnabled(shouldBeEnabled);
  }, [spaceId, currentSpaceType?.isTemp, currentSpaceType?.claudeSource]);

  // Expose methods to parent components via ref
  useImperativeHandle(
    ref,
    () => ({
      appendContent: (newContent: string) => {
        setContent((prev) => {
          const separator = prev.trim() ? '\n\n' : '';
          return prev + separator + newContent;
        });
        // Focus and move cursor to end
        setTimeout(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            textareaRef.current.value.length,
            textareaRef.current.value.length,
          );
        }, 50);
      },
      setContent: (newContent: string) => {
        setContent(newContent);
        setTimeout(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            textareaRef.current.value.length,
            textareaRef.current.value.length,
          );
        }, 50);
      },
    }),
    [],
  );

  // Close attachment menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(event.target as Node)) {
        setShowAttachMenu(false);
      }
    };

    if (showAttachMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showAttachMenu]);

  // Close KB menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-kb-menu]')) {
        setShowKbMenu(false);
      }
    };
    if (showKbMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showKbMenu]);

  // Load knowledge bases on first render
  useEffect(() => {
    if (knowledgeBases.length === 0) {
      loadKnowledgeBases();
    }
  }, []);

  // Onboarding state
  const { isActive: isOnboarding, currentStep } = useOnboardingStore();
  const isOnboardingSendStep = isOnboarding && currentStep === 'send-message';

  // In onboarding send step, show prefilled prompt
  const onboardingPrompt = getOnboardingPrompt(t);
  const displayContent = isOnboardingSendStep ? onboardingPrompt : content;

  // Handle image button click (from attachment menu)
  const handleImageButtonClick = () => {
    setShowAttachMenu(false);
    fileInputRef.current?.click();
  };

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [displayContent]);

  // Focus on mount
  useEffect(() => {
    if (!isGenerating && !isOnboardingSendStep) {
      textareaRef.current?.focus();
    }
  }, [isGenerating, isOnboardingSendStep]);

  // Handle send
  // Note: Messages are now queued if already generating (handled in store)
  const handleSend = () => {
    const textToSend = isOnboardingSendStep ? onboardingPrompt : content.trim();
    const hasContent = textToSend || images.length > 0;

    // Only check isProcessingImages, not isGenerating (queuing is handled in store)
    if (hasContent && !isProcessingImages) {
      resetHistory(); // Reset history browsing on send
      onSend(
        textToSend,
        images.length > 0 ? images : undefined,
        thinkingEnabled,
        aiBrowserEnabled,
        targetAgentIds.length > 0 ? targetAgentIds.join(',') : undefined,
      );

      if (!isOnboardingSendStep) {
        setContent('');
        clearImages(); // Clear images after send
        setTargetAgentIds([]); // Clear target agents
        // Don't reset thinkingEnabled - user might want to keep it on
        // Reset height
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      }
    }
  };

  // Detect mobile device (touch + narrow screen)
  const isMobile = () => {
    return 'ontouchstart' in window && window.innerWidth < 768;
  };

  // Handle key press - include mention popup and slash command navigation
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Let mention system handle keys first (returns true if consumed)
    if (handleMentionKeyDown(e)) return;
    // Let slash command system handle keys (returns true if consumed)
    if (handleSlashKeyDown(e)) return;
    // Let input history handle arrow keys (returns true if consumed)
    if (handleHistoryKeyDown(e)) return;

    // Mobile: Enter for newline, send via button only
    // PC: Enter to send, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      handleSend();
    }
    // Esc to stop
    if (e.key === 'Escape' && isGenerating) {
      e.preventDefault();
      onStop();
    }
  };

  // In onboarding mode, can always send (prefilled content)
  // Can send if has text OR has images (and not processing images)
  // Note: isGenerating is not checked here - queuing is handled in store
  const canSend =
    isOnboardingSendStep || ((content.trim().length > 0 || hasImages) && !isProcessingImages);

  // Handle context compression
  const handleCompactContext = async () => {
    if (!conversationId || isCompacting) return;

    setIsCompacting(true);
    setCompactResult(null);
    try {
      const result = await api.compactContext(conversationId);
      if (result.success) {
        console.log('[InputArea] Context compacted successfully');
        setCompactResult('success');
      } else {
        console.error('[InputArea] Failed to compact context:', result.error);
        setCompactResult('error');
      }
    } catch (error) {
      console.error('[InputArea] Error compacting context:', error);
      setCompactResult('error');
    } finally {
      setIsCompacting(false);
      // Auto-dismiss notification after 3 seconds
      setTimeout(() => setCompactResult(null), 3000);
    }
  };

  return (
    <div
      className={`
      border-t border-border/50 bg-background/80 backdrop-blur-sm
      transition-[padding] duration-300 ease-out
      ${isCompact ? 'px-3 py-2' : 'px-4 py-3'}
    `}
    >
      <div className={isCompact ? '' : 'max-w-3xl mx-auto'}>
        {/* Compact result notification */}
        {compactResult === 'success' && (
          <div
            className="mb-2 p-3 rounded-xl bg-green-500/10 border border-green-500/20
            flex items-center gap-2 animate-fade-in"
          >
            <CheckCircle size={16} className="text-green-500 flex-shrink-0" />
            <span className="text-sm text-green-500">{t('Context compressed successfully')}</span>
          </div>
        )}
        {compactResult === 'error' && (
          <div
            className="mb-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20
            flex items-center gap-2 animate-fade-in"
          >
            <AlertCircle size={16} className="text-destructive mt-0.5 flex-shrink-0" />
            <span className="text-sm text-destructive">
              {t('Failed to compress context. Please try sending a message first.')}
            </span>
          </div>
        )}
        {/* Error toast notification */}
        {imageError && (
          <div
            className="mb-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20
            flex items-start gap-2 animate-fade-in"
          >
            <AlertCircle size={16} className="text-destructive mt-0.5 flex-shrink-0" />
            <span className="text-sm text-destructive flex-1">{imageError.message}</span>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />

        {/* Input container */}
        <div
          className={`
            relative flex flex-col rounded-2xl transition-all duration-200
            ${
              isFocused
                ? 'ring-1 ring-primary/30 bg-card shadow-sm'
                : 'bg-secondary/50 hover:bg-secondary/70'
            }
            ${isGenerating ? 'opacity-60' : ''}
            ${isDragOver ? 'ring-2 ring-primary/50 bg-primary/5' : ''}
          `}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Image preview area */}
          {hasImages && <ImageAttachmentPreview images={images} onRemove={removeImage} />}

          {/* Image processing indicator */}
          {isProcessingImages && (
            <div className="px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground border-b border-border/30">
              <Loader2 size={14} className="animate-spin" />
              <span>{t('Processing image...')}</span>
            </div>
          )}

          {/* Drag overlay */}
          {isDragOver && (
            <div
              className="absolute inset-0 flex items-center justify-center
              bg-primary/5 rounded-2xl border-2 border-dashed border-primary/30
              pointer-events-none z-10"
            >
              <div className="flex flex-col items-center gap-2 text-primary/70">
                <ImagePlus size={24} />
                <span className="text-sm font-medium">{t('Drop to add images')}</span>
              </div>
            </div>
          )}

          {/* Textarea area */}
          <div className="px-3 pt-3 pb-1 relative">
            <textarea
              ref={textareaRef}
              value={displayContent}
              onChange={(e) => {
                handleMentionTextChange(e);
                handleSlashTextChange(e);
                handleHistoryInputChange();
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder={placeholder || t('Type a message, let AICO-Bot help you...')}
              disabled={isOnboardingSendStep || isExecuting}
              readOnly={isOnboardingSendStep}
              rows={1}
              className={`w-full bg-transparent resize-none
                focus:outline-none text-foreground placeholder:text-muted-foreground/50
                disabled:cursor-not-allowed min-h-[24px]
                ${isOnboardingSendStep ? 'cursor-default' : ''}`}
              style={{ maxHeight: '200px' }}
            />

            {/* @ Mention Popup */}
            {showMentionPopup && (
              <div
                ref={mentionPopupRef}
                className="absolute bottom-full left-0 mb-2 py-1 bg-popover border border-border
                  rounded-lg shadow-lg min-w-[200px] max-h-[250px] overflow-y-auto z-50"
              >
                {agentMembers.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {t('No agents available')}
                  </div>
                ) : filteredMembers.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {mentionQuery ? t('No matching agents') : t('No agents available')}
                  </div>
                ) : (
                  filteredMembers.map((member, index) => (
                    <button
                      key={member.id}
                      onClick={() => selectAgent(member)}
                      className={`w-full px-3 py-2 flex items-center gap-2 text-sm
                        transition-colors ${
                          index === selectedMentionIndex
                            ? 'bg-primary/10 text-primary'
                            : 'text-foreground hover:bg-secondary'
                        }`}
                    >
                      {/* Role Icon */}
                      {member.role === 'leader' ? (
                        <Crown className="w-4 h-4 text-purple-500 flex-shrink-0" />
                      ) : (
                        <Wrench className="w-4 h-4 text-blue-500 flex-shrink-0" />
                      )}

                      {/* Type Icon */}
                      {member.type === 'remote' ? (
                        <Cloud className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                      ) : (
                        <Monitor className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      )}

                      {/* Name */}
                      <span className="flex-1 text-left">{member.name}</span>

                      {/* Capabilities */}
                      {member.capabilities && member.capabilities.length > 0 && (
                        <span className="text-xs text-muted-foreground truncate max-w-[100px]">
                          {member.capabilities.slice(0, 2).join(', ')}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Slash Command Menu */}
            {showCommandMenu && (
              <SlashCommandMenu
                ref={commandMenuRef}
                items={matchedCommands}
                selectedIndex={selectedIndex}
                onSelect={selectMenuItem}
              />
            )}
          </div>

          {/* Bottom toolbar - always visible, industry standard layout */}
          <InputToolbar
            isGenerating={isGenerating}
            isStopping={isStopping}
            pendingCount={pendingCount}
            onClearPending={onClearPending}
            isOnboarding={isOnboardingSendStep}
            isProcessingImages={isProcessingImages}
            thinkingEnabled={thinkingEnabled}
            onThinkingToggle={() => setThinkingEnabled(!thinkingEnabled)}
            aiBrowserEnabled={aiBrowserEnabled}
            onAIBrowserToggle={() => setAIBrowserEnabled(!aiBrowserEnabled)}
            showAttachMenu={showAttachMenu}
            onAttachMenuToggle={() => setShowAttachMenu(!showAttachMenu)}
            onImageClick={handleImageButtonClick}
            imageCount={images.length}
            maxImages={MAX_IMAGES}
            attachMenuRef={attachMenuRef}
            canSend={canSend}
            onSend={handleSend}
            onStop={onStop}
            onCompactContext={handleCompactContext}
            isCompacting={isCompacting}
            showKbMenu={showKbMenu}
            onKbMenuToggle={() => setShowKbMenu(!showKbMenu)}
            knowledgeBases={knowledgeBases}
            activeKnowledgeBaseIds={activeKnowledgeBaseIds}
            onToggleKb={toggleActiveKb}
            activeCount={activeKnowledgeBaseIds.length}
            contextUsage={contextUsage}
          />
        </div>
      </div>
    </div>
  );
}

export const InputArea = forwardRef<InputAreaRef, InputAreaProps>(InputAreaInternal);

function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

function ContextUsageDisplay({
  contextUsage,
}: {
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
  } | null;
}) {
  if (!contextUsage) {
    return (
      <span className="text-xs text-muted-foreground/30 cursor-default select-none pl-1">
        -- / 200K
      </span>
    );
  }

  const contextUsed =
    contextUsage.inputTokens +
    contextUsage.outputTokens +
    contextUsage.cacheReadTokens +
    contextUsage.cacheCreationTokens;
  const contextWindow = contextUsage.contextWindow > 0 ? contextUsage.contextWindow : 200000;
  const usagePercent = Math.round((contextUsed / contextWindow) * 100);

  const colorClass =
    usagePercent >= 80 ? 'text-red-500/80' : usagePercent >= 60 ? 'text-amber-500/80' : 'text-muted-foreground/50';

  return (
    <span className={`text-xs cursor-default select-none pl-1 ${colorClass}`}>
      {formatTokens(contextUsed)} / {formatTokens(contextWindow)} ({usagePercent}%)
    </span>
  );
}

/**
 * Input Toolbar - Bottom action bar
 * Extracted as a separate component for maintainability and future extensibility
 *
 * Layout: [+attachment] ──────────────────── [⚛ thinking] [send]
 */
interface InputToolbarProps {
  isGenerating: boolean;
  isStopping: boolean;
  pendingCount: number;
  onClearPending?: () => void;
  isOnboarding: boolean;
  isProcessingImages: boolean;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  aiBrowserEnabled: boolean;
  onAIBrowserToggle: () => void;
  showAttachMenu: boolean;
  onAttachMenuToggle: () => void;
  onImageClick: () => void;
  imageCount: number;
  maxImages: number;
  attachMenuRef: React.RefObject<HTMLDivElement | null>;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
  onCompactContext: () => void;
  isCompacting: boolean;
  showKbMenu: boolean;
  onKbMenuToggle: () => void;
  knowledgeBases: Array<{ id: string; name: string }>;
  activeKnowledgeBaseIds: string[];
  onToggleKb: (kbId: string) => void;
  activeCount: number;
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
  } | null;
}

function InputToolbar({
  isGenerating,
  isStopping,
  pendingCount,
  onClearPending,
  isOnboarding,
  isProcessingImages,
  thinkingEnabled,
  onThinkingToggle,
  aiBrowserEnabled,
  onAIBrowserToggle,
  showAttachMenu,
  onAttachMenuToggle,
  onImageClick,
  imageCount,
  maxImages,
  attachMenuRef,
  canSend,
  onSend,
  onStop,
  onCompactContext,
  isCompacting,
  showKbMenu,
  onKbMenuToggle,
  knowledgeBases,
  activeKnowledgeBaseIds,
  onToggleKb,
  activeCount,
  contextUsage,
}: InputToolbarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-2 pb-2 pt-1">
      {/* Left section: attachment button + thinking toggle + compact button */}
      <div className="flex items-center gap-1">
        {/* Attachment menu */}
        {!isGenerating && !isOnboarding && (
          <div className="relative" ref={attachMenuRef}>
            <button
              onClick={onAttachMenuToggle}
              disabled={isProcessingImages}
              className={`w-8 h-8 flex items-center justify-center rounded-lg
                transition-all duration-150
                ${
                  showAttachMenu
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50'
                }
                ${isProcessingImages ? 'opacity-50 cursor-not-allowed' : ''}
              `}
              title={t('Add attachment')}
            >
              <Plus
                size={18}
                className={`transition-transform duration-200 ${showAttachMenu ? 'rotate-45' : ''}`}
              />
            </button>

            {/* Attachment menu dropdown */}
            {showAttachMenu && (
              <div
                className="absolute bottom-full left-0 mb-2 py-1.5 bg-popover border border-border
                rounded-xl shadow-lg min-w-[160px] z-20 animate-fade-in"
              >
                <button
                  onClick={onImageClick}
                  disabled={imageCount >= maxImages}
                  className={`w-full px-3 py-2 flex items-center gap-3 text-sm
                    transition-colors duration-150
                    ${
                      imageCount >= maxImages
                        ? 'text-muted-foreground/40 cursor-not-allowed'
                        : 'text-foreground hover:bg-muted/50'
                    }
                  `}
                >
                  <ImagePlus size={16} className="text-muted-foreground" />
                  <span>{t('Add image')}</span>
                  {imageCount > 0 && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {imageCount}/{maxImages}
                    </span>
                  )}
                </button>
                {/* Future extensibility: add more options here */}
              </div>
            )}
          </div>
        )}

        {/* AI Browser toggle */}
        {!isGenerating && !isOnboarding && (
          <button
            onClick={onAIBrowserToggle}
            className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg
              transition-colors duration-200 relative
              ${
                aiBrowserEnabled
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
              }
            `}
            title={
              aiBrowserEnabled ? t('AI Browser enabled (click to disable)') : t('Enable AI Browser')
            }
          >
            <Globe size={15} />
            <span className="text-xs">{t('Browser')}</span>
            {/* Active indicator dot */}
            {aiBrowserEnabled && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-primary rounded-full" />
            )}
          </button>
        )}

        {/* Thinking mode toggle - always show full label, no expansion */}
        {!isGenerating && !isOnboarding && (
          <button
            onClick={onThinkingToggle}
            className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg
              transition-colors duration-200
              ${
                thinkingEnabled
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
              }
            `}
            title={thinkingEnabled ? t('Disable Deep Thinking') : t('Enable Deep Thinking')}
          >
            <Atom size={15} />
            <span className="text-xs">{t('Deep Thinking')}</span>
          </button>
        )}

        {/* Context compression button - triggers manual context compaction */}
        {!isGenerating && !isOnboarding && (
          <button
            onClick={onCompactContext}
            disabled={isCompacting}
            className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg
              transition-colors duration-200
              ${
                isCompacting
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
              }
              ${isCompacting ? 'cursor-not-allowed' : ''}
            `}
            title={isCompacting ? t('Compressing context...') : t('Compress context (free memory)')}
          >
            {isCompacting ? <Loader2 size={15} className="animate-spin" /> : <Boxes size={15} />}
            <span className="text-xs">{t('Compress')}</span>
          </button>
        )}

        {/* Knowledge base selector */}
        {!isGenerating && !isOnboarding && (
          <div className="relative" data-kb-menu>
            <button
              onClick={onKbMenuToggle}
              className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg
                transition-colors duration-200 relative
                ${
                  activeCount > 0
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : showKbMenu
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
                }
              `}
              title="本地知识库"
            >
              <BookOpen size={15} />
              <span className="text-xs">本地知识库</span>
              {activeCount > 0 && (
                <span className="ml-0.5 min-w-[16px] h-4 flex items-center justify-center px-1 rounded-full bg-emerald-500 text-white text-[10px] leading-none">
                  {activeCount}
                </span>
              )}
            </button>

            {showKbMenu && (
              <div
                className="absolute bottom-full left-0 mb-2 py-1.5 bg-popover border border-border
                  rounded-xl shadow-lg min-w-[200px] max-h-[300px] overflow-y-auto z-20 animate-fade-in"
              >
                {knowledgeBases.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                    暂无知识库
                  </div>
                ) : (
                  knowledgeBases.map((kb) => {
                    const isActive = activeKnowledgeBaseIds.includes(kb.id);
                    return (
                      <button
                        key={kb.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleKb(kb.id);
                        }}
                        className={`w-full px-3 py-2 flex items-center gap-2.5 text-sm transition-colors
                          ${isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground hover:bg-muted/50'}
                        `}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors
                          ${isActive ? 'bg-emerald-500 border-emerald-500' : 'border-muted-foreground/30'}
                        `}>
                          {isActive && <Check size={12} className="text-white" />}
                        </div>
                        <BookOpen size={14} className="flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">{kb.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* Context usage indicator */}
        <ContextUsageDisplay contextUsage={contextUsage} />
      </div>

      {/* Right section: pending indicator + action button */}
      <div className="flex items-center gap-2">
        {/* Pending messages indicator with cancel button */}
        {isGenerating && pendingCount > 0 && (
          <div
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary/10 text-primary text-xs"
            title={t('{{count}} message(s) queued', { count: pendingCount })}
          >
            <Clock size={12} className="animate-pulse" />
            <span>{pendingCount}</span>
            {onClearPending && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClearPending();
                }}
                className="ml-1 p-0.5 rounded hover:bg-primary/20 transition-colors"
                title={t('Cancel pending messages')}
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        {isGenerating ? (
          isStopping ? (
            // Stopping state: show spinner, disable click
            <div
              className="w-8 h-8 flex items-center justify-center
                bg-muted/50 text-muted-foreground rounded-lg cursor-not-allowed"
              title={t('Stopping...')}
            >
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : (
            // Normal stop button
            <button
              onClick={onStop}
              className="w-8 h-8 flex items-center justify-center
                bg-destructive/10 text-destructive rounded-lg
                hover:bg-destructive/20 active:bg-destructive/30
                transition-all duration-150"
              title={t('Stop generation (Esc)')}
            >
              <div className="w-3 h-3 border-2 border-current rounded-sm" />
            </button>
          )
        ) : (
          <button
            data-onboarding="send-button"
            onClick={onSend}
            disabled={!canSend}
            className={`
              w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-200
              ${
                canSend
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                  : 'bg-muted/50 text-muted-foreground/40 cursor-not-allowed'
              }
            `}
            title={thinkingEnabled ? t('Send (Deep Thinking)') : t('Send')}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
