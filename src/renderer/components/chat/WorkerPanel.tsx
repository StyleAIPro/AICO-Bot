/**
 * WorkerPanel — Displays a Hyper Space worker's real-time work status
 *
 * Shows each active/completed worker as an isolated panel with:
 * - Worker name and status indicator
 * - Task description
 * - ThoughtProcess (collapsible thinking/tool call timeline)
 * - StreamingBubble (real-time response content)
 * - Completion/error status
 */

import { useState, useRef, useEffect } from 'react';
import { ThoughtProcess } from './ThoughtProcess';
import { MarkdownRenderer } from './MarkdownRenderer';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import type { Thought } from '../../types';
import type { WorkerSessionState } from '../../stores/chat.store';
import { useTranslation } from '../../i18n';
import { Wrench, CheckCircle2, XCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

interface WorkerPanelProps {
  worker: WorkerSessionState;
  onAnswerQuestion?: (answers: Record<string, string>) => void;
}

export function WorkerPanel({ worker, onAnswerQuestion }: WorkerPanelProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isThoughtExpanded, setIsThoughtExpanded] = useState(true);

  const isRunning = worker.status === 'running';
  const isCompleted = worker.status === 'completed';
  const isFailed = worker.status === 'failed';

  return (
    <div className="rounded-xl border border-border/50 bg-card/30 overflow-hidden mb-3 animate-fade-in">
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/20 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* Status icon */}
        {isRunning ? (
          <Loader2 size={14} className="text-blue-500 animate-spin" />
        ) : isCompleted ? (
          <CheckCircle2 size={14} className="text-green-500" />
        ) : isFailed ? (
          <XCircle size={14} className="text-red-500" />
        ) : (
          <Wrench size={14} className="text-blue-500" />
        )}

        {/* Worker name */}
        <Wrench size={12} className="text-blue-400" />
        <span className="text-xs font-medium text-foreground/90">{worker.agentName}</span>

        {/* Task description (truncated) */}
        <span className="text-xs text-muted-foreground/70 truncate flex-1 ml-1">
          {worker.task.length > 60 ? worker.task.substring(0, 60) + '...' : worker.task}
        </span>

        {/* Expand/collapse */}
        {isExpanded ? (
          <ChevronDown size={12} className="text-muted-foreground/50" />
        ) : (
          <ChevronRight size={12} className="text-muted-foreground/50" />
        )}
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="px-3 pb-3 border-t border-border/20">
          {/* Task description */}
          <div className="mt-2 mb-2">
            <p className="text-xs text-muted-foreground/80 leading-relaxed whitespace-pre-wrap">
              {worker.task}
            </p>
          </div>

          {/* Thought process */}
          {(worker.thoughts.length > 0 || worker.isThinking) && (
            <div className="mb-2">
              <button
                className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-foreground/80 transition-colors mb-1"
                onClick={() => setIsThoughtExpanded(!isThoughtExpanded)}
              >
                {isThoughtExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <span>{t('Thought process')}</span>
                <span className="opacity-50">({worker.thoughts.length})</span>
              </button>
              {isThoughtExpanded && (
                <ThoughtProcess thoughts={worker.thoughts} isThinking={worker.isThinking} isWorkerView />
              )}
            </div>
          )}

          {/* Streaming content */}
          {worker.streamingContent && (
            <div className="mt-2 rounded-lg bg-background/50 px-3 py-2">
              <div className="break-words leading-relaxed text-sm">
                <MarkdownRenderer content={worker.streamingContent} mode="streaming" />
                {worker.isStreaming && (
                  <span className="inline-block w-0.5 h-4 ml-0.5 bg-primary streaming-cursor align-middle" />
                )}
              </div>
            </div>
          )}

          {/* AskUserQuestion card — worker needs user input */}
          {worker.pendingQuestion &&
            worker.pendingQuestion.status === 'active' &&
            onAnswerQuestion && (
              <div className="mt-2">
                <AskUserQuestionCard
                  pendingQuestion={worker.pendingQuestion}
                  onAnswer={onAnswerQuestion}
                />
              </div>
            )}

          {/* Error */}
          {worker.error && (
            <div className="mt-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
              <p className="text-xs text-red-400">{worker.error}</p>
            </div>
          )}

          {/* Completion status */}
          {isCompleted && !worker.error && worker.streamingContent && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-green-500/70">
              <CheckCircle2 size={12} />
              <span>{t('Task completed')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * WorkerPanelsContainer — Renders all active worker panels for a conversation
 */
export function WorkerPanelsContainer({
  workerSessions,
  onAnswerQuestion,
}: {
  workerSessions: Map<string, WorkerSessionState>;
  onAnswerQuestion?: (agentId: string, answers: Record<string, string>) => void;
}) {
  if (workerSessions.size === 0) return null;

  // Only show delegation-mode workers inline in main conversation.
  // Mention-mode workers display their output directly in the main streaming content,
  // so showing a WorkerPanel would duplicate the content.
  const workers = Array.from(workerSessions.values()).filter(
    (w) => w.interactionMode !== 'mention',
  );

  if (workers.length === 0) return null;

  return (
    <div className="flex flex-col gap-0">
      {workers.map((worker) => (
        <WorkerPanel
          key={worker.agentId}
          worker={worker}
          onAnswerQuestion={
            worker.pendingQuestion?.status === 'active' && onAnswerQuestion
              ? (answers) => onAnswerQuestion(worker.agentId, answers)
              : undefined
          }
        />
      ))}
    </div>
  );
}
