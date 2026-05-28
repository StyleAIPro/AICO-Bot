/**
 * WorkerTabBar — Tab bar for switching between main chat and Worker views in Hyper Space
 *
 * Displayed between the message area and input area.
 * Shows a main group-chat tab + one tab per worker.
 * Click a worker tab to see that worker's independent conversation view.
 * Click the main tab to switch back to the group chat.
 *
 * Layout:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ [Group Chat] [🔧 Worker 1 ●] [🔧 Worker 2 ✓]              │
 * └─────────────────────────────────────────────────────────────┘
 */

import { Wrench, Cloud, Monitor, X, Loader2, CheckCircle2, MessageSquare } from 'lucide-react';
import { ThoughtProcess } from './ThoughtProcess';
import { MarkdownRenderer } from './MarkdownRenderer';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { MessageItem } from './MessageItem';
import type { WorkerSessionState } from '../../stores/chat.store';
import { useChatStore } from '../../stores/chat.store';
import type { Message } from '../../types';
import { useTranslation } from '../../i18n';
import { useEffect, useState } from 'react';

export interface WorkerTab {
  id: string; // 'main' or agentId
  name: string; // Display name
  role: 'leader' | 'worker';
  type?: 'local' | 'remote';
  status: 'idle' | 'running' | 'completed' | 'failed';
  workerSession?: WorkerSessionState;
}

interface WorkerTabBarProps {
  tabs: WorkerTab[];
  activeTabId: string;
  onTabChange: (tabId: string) => void;
  unreadWorkers?: Set<string>;
}

export function WorkerTabBar({ tabs, activeTabId, onTabChange, unreadWorkers }: WorkerTabBarProps) {
  // Don't show the tab bar if only the main tab exists (no workers spawned)
  if (tabs.length <= 1) return null;

  return (
    <div className="flex items-center gap-1 px-4 py-1.5 border-t border-border/30 bg-background/50 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = activeTabId === tab.id;
        const isWorker = tab.role === 'worker';
        const isRunning = tab.status === 'running';
        const hasUnread = isWorker && unreadWorkers?.has(tab.id);

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
              transition-all duration-150 whitespace-nowrap flex-shrink-0
              ${
                isActive
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : hasUnread
                    ? 'text-foreground bg-secondary/40 border border-border/50'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50 border border-transparent'
              }
            `}
          >
            {/* Main tab: group chat icon */}
            {!isWorker && (
              <MessageSquare
                size={12}
                className={isActive ? 'text-primary' : 'text-muted-foreground/60'}
              />
            )}

            {/* Worker tab: wrench icon */}
            {isWorker && (
              <Wrench size={12} className={isActive ? 'text-blue-500' : 'text-blue-400/60'} />
            )}

            {/* Name — show server name for remote workers */}
            {isWorker && tab.type === 'remote' && tab.workerSession?.serverName ? (
              <span>{tab.workerSession.serverName}</span>
            ) : (
              <span>{tab.name}</span>
            )}

            {/* Type indicator for remote workers */}
            {isWorker && tab.type === 'remote' && <Cloud size={10} className="opacity-40" />}
            {isWorker && tab.type === 'local' && <Monitor size={10} className="opacity-40" />}

            {/* Running indicator */}
            {isWorker && isRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            )}

            {/* Completed indicator */}
            {isWorker && tab.status === 'completed' && !isRunning && (
              <CheckCircle2 size={11} className="text-green-500/70" />
            )}

            {/* Failed indicator */}
            {isWorker && tab.status === 'failed' && <X size={11} className="text-red-500/70" />}

            {/* Unread badge — worker finished while user was on another tab */}
            {hasUnread && !isActive && <span className="ml-0.5 w-2 h-2 rounded-full bg-blue-500" />}

            {/* Pending question indicator — worker needs user input */}
            {isWorker && tab.workerSession?.pendingQuestion?.status === 'active' && !isActive && (
              <span
                className="ml-0.5 w-2 h-2 rounded-full bg-amber-500 animate-pulse"
                title={t('Waiting for your response')}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * WorkerView — Full independent conversation view for a single worker
 *
 * Shows the worker's task, thought process, and streaming response.
 * Rendered in place of the main message list when a worker tab is active.
 */
interface WorkerViewProps {
  worker: WorkerSessionState;
  spaceId?: string;
  isCompact?: boolean;
  onAnswerQuestion?: (answers: Record<string, string>) => void;
}

export function WorkerView({
  worker,
  spaceId,
  isCompact = false,
  onAnswerQuestion,
}: WorkerViewProps) {
  const { t } = useTranslation();
  const loadWorkerConversation = useChatStore((s) => s.loadWorkerConversation);
  const conversationCache = useChatStore((s) => s.conversationCache);
  const isRunning = worker.status === 'running';
  const isCompleted = worker.status === 'completed';
  const isFailed = worker.status === 'failed';

  const contentWidthClass = isCompact ? '' : 'max-w-3xl mx-auto w-full';

  // Load persisted messages for this worker's child conversation
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyMessages, setHistoryMessages] = useState<Message[]>([]);

  // When a new turn starts (turnStartedAt changes), reset history to force reload.
  // The child conversation on disk accumulates all turns — reloading shows full history.
  const turnStartedAt = worker.turnStartedAt || 0;
  useEffect(() => {
    setHistoryLoaded(false);
    setHistoryMessages([]);
  }, [turnStartedAt]);

  useEffect(() => {
    if (worker.childConversationId && !historyLoaded) {
      // Check cache first
      const cached = conversationCache.get(worker.childConversationId!);
      if (cached?.messages?.length) {
        // Filter out empty placeholder messages and system messages
        setHistoryMessages(cached.messages.filter((m) => m.content && m.content.trim().length > 0));
        setHistoryLoaded(true);
      } else if (spaceId) {
        // Load from backend
        loadWorkerConversation(spaceId, worker.childConversationId!).then((success) => {
          if (success) {
            const conv = conversationCache.get(worker.childConversationId!);
            if (conv?.messages?.length) {
              setHistoryMessages(
                conv.messages.filter((m) => m.content && m.content.trim().length > 0),
              );
            }
          }
          setHistoryLoaded(true);
        });
      }
    }
  }, [
    worker.childConversationId,
    spaceId,
    historyLoaded,
    loadWorkerConversation,
    conversationCache,
  ]);

  return (
    <div className={`flex-1 flex flex-col h-full overflow-y-auto ${isCompact ? 'px-3' : 'px-4'}`}>
      <div className={`py-6 ${contentWidthClass}`}>
        {/* Worker header */}
        <div className="flex items-center gap-2 mb-4">
          <Wrench size={14} className="text-blue-400" />
          <span className="text-sm font-medium">{worker.agentName}</span>
          {worker.type === 'remote' && worker.serverName && (
            <span className="text-xs text-muted-foreground/60 flex items-center gap-1">
              <Cloud size={10} />
              {worker.serverName}
            </span>
          )}
          {worker.type === 'local' && (
            <span className="text-xs text-muted-foreground/60 flex items-center gap-1">
              <Monitor size={10} />
              Local
            </span>
          )}
          {isRunning ? (
            <Loader2 size={14} className="text-blue-500 animate-spin ml-1" />
          ) : isCompleted ? (
            <CheckCircle2 size={14} className="text-green-500 ml-1" />
          ) : isFailed ? (
            <X size={14} className="text-red-500 ml-1" />
          ) : null}
        </div>

        {/* Task description */}
        <div className="mb-4 p-3 rounded-lg bg-secondary/30 border border-border/20">
          <p className="text-xs text-muted-foreground/60 mb-1">{t('Task')}</p>
          <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
            {worker.task}
          </p>
        </div>

        {/* Historical messages from persisted child conversation */}
        {historyMessages.length > 0 && (
          <div className="space-y-3 mb-4">
            {historyMessages.map((msg, idx) => (
              <MessageItem key={msg.id || idx} message={msg} previousCost={0} hideThoughts={true} />
            ))}
          </div>
        )}

        {/* Thought process — always expanded in worker view so users can see all steps */}
        {(worker.thoughts.length > 0 || worker.isThinking) && (
          <div className="mb-4">
            <ThoughtProcess
              thoughts={worker.thoughts}
              isThinking={worker.isThinking}
              defaultExpanded
              isWorkerView
            />
          </div>
        )}

        {/* Streaming/response content */}
        {worker.streamingContent && (
          <div className="rounded-2xl px-4 py-3 message-assistant">
            <div className="break-words leading-relaxed">
              <MarkdownRenderer
                content={worker.streamingContent}
                mode={isRunning ? 'streaming' : 'static'}
              />
              {worker.isStreaming && (
                <span className="inline-block w-0.5 h-5 ml-0.5 bg-primary streaming-cursor align-middle" />
              )}
            </div>
          </div>
        )}

        {/* AskUserQuestion card — worker needs user input */}
        {worker.pendingQuestion &&
          worker.pendingQuestion.status === 'active' &&
          onAnswerQuestion && (
            <div className="mt-4">
              <AskUserQuestionCard
                pendingQuestion={worker.pendingQuestion}
                onAnswer={onAnswerQuestion}
              />
            </div>
          )}

        {/* Empty state while waiting for worker to start */}
        {!worker.streamingContent &&
          worker.thoughts.length === 0 &&
          isRunning &&
          !historyMessages.length && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground/50">
              <Loader2 size={24} className="animate-spin mb-3 text-blue-400/40" />
              <p className="text-sm">{t('Worker is processing...')}</p>
            </div>
          )}

        {/* Error */}
        {worker.error && (
          <div className="mt-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
            <p className="text-xs text-red-400">{worker.error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
