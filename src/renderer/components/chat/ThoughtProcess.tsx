/**
 * ThoughtProcess - Displays agent reasoning process in real-time
 * Shows thinking, tool usage, and intermediate results as they happen
 *
 * TodoWrite is rendered separately at the bottom (above "processing...")
 * to keep it always visible and avoid duplicate renders
 */

import { useState, useRef, useEffect, useMemo, memo, useCallback, type RefObject } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Braces,
  Copy,
  Check,
  Wrench,
} from 'lucide-react';
import { TodoCard, parseTodoInput } from '../tool/TodoCard';
import { ToolResultViewer } from './tool-result';
import {
  truncateText,
  getThoughtIcon,
  getThoughtColor,
  getThoughtLabelKey,
  getToolFriendlyFormat,
  groupSubagentThoughts,
  type ThoughtGroup,
} from './thought-utils';
import { useSmartScroll } from '../../hooks/useSmartScroll';
import { useLazyVisible } from '../../hooks/useLazyVisible';
import type { Thought } from '../../types';
import type { WorkerSessionState } from '../../stores/chat.store';
import { useTranslation } from '../../i18n';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ThoughtProcessProps {
  thoughts: Thought[];
  isThinking: boolean;
  workerSessions?: Map<string, WorkerSessionState>;
  defaultExpanded?: boolean;
  /** When true, thoughts are already a sub-agent's own — skip groupSubagentThoughts */
  isWorkerView?: boolean;
}

// i18n static keys for extraction (DO NOT REMOVE)
void function _i18nActionKeys(t: (k: string) => string) {
  t('Generating {{tool}}...'); t('Reading {{file}}...'); t('Writing {{file}}...');
  t('Editing {{file}}...'); t('Searching {{pattern}}...'); t('Matching {{pattern}}...');
  t('Executing {{command}}...'); t('Fetching {{url}}...'); t('Searching {{query}}...');
  t('Updating tasks...'); t('Executing {{task}}...'); t('Waiting for user response...');
  t('Processing...'); t('Thinking...'); t('steps');
}

// Get human-friendly action summary for collapsed header (isThinking=true only)
// Shows what the agent is currently doing with key details (filename, command, etc.)
function getActionSummaryData(thoughts: Thought[]): {
  key: string;
  params?: Record<string, string>;
} {
  // Search from end to find the most recent action
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const th = thoughts[i];
    if (th.type === 'tool_use' && th.toolName) {
      // If tool is still streaming (not ready), show generating
      if (th.isStreaming || !th.isReady) {
        return { key: 'Generating {{tool}}...', params: { tool: th.toolName } };
      }
      const input = th.toolInput;
      switch (th.toolName) {
        case 'Read':
          return {
            key: 'Reading {{file}}...',
            params: { file: extractFileName(input?.file_path) },
          };
        case 'Write':
          return {
            key: 'Writing {{file}}...',
            params: { file: extractFileName(input?.file_path) },
          };
        case 'Edit':
          return {
            key: 'Editing {{file}}...',
            params: { file: extractFileName(input?.file_path) },
          };
        case 'Grep':
          return {
            key: 'Searching {{pattern}}...',
            params: { pattern: extractSearchTerm(input?.pattern) },
          };
        case 'Glob':
          return {
            key: 'Matching {{pattern}}...',
            params: { pattern: extractSearchTerm(input?.pattern) },
          };
        case 'Bash':
          return {
            key: 'Executing {{command}}...',
            params: { command: extractCommand(input?.command) },
          };
        case 'WebFetch':
          return { key: 'Fetching {{url}}...', params: { url: extractUrl(input?.url) } };
        case 'WebSearch':
          return {
            key: 'Searching {{query}}...',
            params: { query: extractSearchTerm(input?.query) },
          };
        case 'TodoWrite':
          return { key: 'Updating tasks...' };
        case 'Agent':
        case 'Task':
          return {
            key: 'Executing {{task}}...',
            params: { task: extractSearchTerm(input?.description || input?.prompt) },
          };
        case 'NotebookEdit':
          return {
            key: 'Editing {{file}}...',
            params: { file: extractFileName(input?.notebook_path) },
          };
        case 'AskUserQuestion':
          return { key: 'Waiting for user response...' };
        default:
          return { key: 'Processing...' };
      }
    }
    // If most recent is thinking, show thinking status
    if (th.type === 'thinking') {
      return { key: 'Thinking...' };
    }
  }
  return { key: 'Thinking...' };
}

// Extract filename from path (e.g., "/foo/bar/config.json" -> "config.json")
function extractFileName(path: unknown): string {
  if (typeof path !== 'string' || !path) return 'file';
  const name = path.split(/[/\\]/).pop() || path;
  return truncateText(name, 20);
}

// Extract command summary (e.g., "npm install lodash --save" -> "npm install...")
function extractCommand(cmd: unknown): string {
  if (typeof cmd !== 'string' || !cmd) return 'command';
  // Get first part of command (before first space or first 20 chars)
  const firstPart = cmd.split(' ').slice(0, 2).join(' ');
  return truncateText(firstPart, 20);
}

// Extract search term or pattern
function extractSearchTerm(term: unknown): string {
  if (typeof term !== 'string' || !term) return '...';
  return truncateText(term, 15);
}

// Extract domain from URL
function extractUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return 'page';
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return truncateText(domain, 20);
  } catch {
    return truncateText(url, 20);
  }
}

// Timer display component to isolate re-renders
function TimerDisplay({
  startTime,
  isThinking,
}: {
  startTime: number | null;
  isThinking: boolean;
}) {
  const [elapsedTime, setElapsedTime] = useState(0);
  const requestRef = useRef<number>();

  useEffect(() => {
    if (!startTime) return;

    const animate = () => {
      setElapsedTime((Date.now() - startTime) / 1000);

      if (isThinking) {
        requestRef.current = requestAnimationFrame(animate);
      }
    };

    if (isThinking) {
      requestRef.current = requestAnimationFrame(animate);
    } else {
      // If not thinking, just update once to show ©∫final time
      setElapsedTime((Date.now() - startTime) / 1000);
    }

    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [isThinking, startTime]);

  return <span>{elapsedTime.toFixed(1)}s</span>;
}

// Nested worker thought timeline — renders inside a Task tool_use entry
function NestedWorkerTimeline({ worker }: { worker: WorkerSessionState }) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Filter worker thoughts for display (same logic as parent ThoughtProcess)
  const displayThoughts = useMemo(() => {
    return worker.thoughts.filter((th) => {
      if (th.type === 'result') return false;
      if (th.type === 'tool_result') return false;
      if (th.toolName === 'TodoWrite') return false;
      return true;
    });
  }, [worker.thoughts]);

  // Calculate duration from first thought to completedAt (or now if still running)
  const duration = useMemo(() => {
    if (worker.thoughts.length === 0) return null;
    const start = new Date(worker.thoughts[0].timestamp).getTime();
    const end = worker.completedAt || Date.now();
    return ((end - start) / 1000).toFixed(1);
  }, [worker.thoughts, worker.completedAt]);

  if (displayThoughts.length === 0 && !worker.isThinking && !worker.streamingContent) return null;

  return (
    <div className="border-t border-border/20">
      {/* Sub-agent header */}
      <button
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <Wrench size={11} className="text-blue-400" />
        <span className="text-[11px] font-medium text-blue-400">{worker.agentName}</span>
        {worker.isThinking && <Loader2 size={10} className="text-blue-400 animate-spin" />}
        {worker.status === 'completed' && <CheckCircle2 size={10} className="text-green-400" />}
        {worker.status === 'failed' && <AlertTriangle size={10} className="text-amber-500" />}
        <span className="text-[10px] text-muted-foreground/50 flex-1 truncate">
          {worker.task.length > 60 ? worker.task.substring(0, 60) + '...' : worker.task}
        </span>
        <ChevronDown
          size={10}
          className={`text-muted-foreground/40 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Collapsed: summary line */}
      {!isExpanded && (
        <div className="flex items-center gap-2 px-3 pb-1.5 text-[10px] text-muted-foreground/50">
          {displayThoughts.length > 0 && (
            <span>
              {displayThoughts.length} {t('steps')}
            </span>
          )}
          {duration && <span>{duration}s</span>}
          {worker.status === 'completed' && <CheckCircle2 size={9} className="text-green-400/60" />}
          {worker.status === 'failed' && <AlertTriangle size={9} className="text-amber-500/60" />}
          {worker.isThinking && <Loader2 size={9} className="text-blue-400/60 animate-spin" />}
        </div>
      )}

      {isExpanded && (
        <div className="max-h-[250px] overflow-auto scrollbar-overlay">
          {/* Worker thought items — simplified timeline */}
          {displayThoughts.map((th, idx) => {
            const thColor = getThoughtColor(th.type, th.isError);
            const thIcon = getThoughtIcon(th.type, th.toolName);
            const hasResult = th.type === 'tool_use' && th.toolResult;
            const thContent =
              th.type === 'tool_use'
                ? getToolFriendlyFormat(th.toolName || '', th.toolInput)
                : th.type === 'tool_result'
                  ? th.toolOutput || ''
                  : th.content;

            return (
              <div key={th.id || idx} className="flex gap-2 px-3 py-1">
                <div className="flex flex-col items-center mt-0.5">
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center bg-primary/5 ${thColor}`}
                  >
                    {hasResult ? (
                      th.toolResult!.isError ? (
                        <AlertTriangle size={10} />
                      ) : (
                        <CheckCircle2 size={10} />
                      )
                    ) : (
                      <thIcon size={10} />
                    )}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-medium ${thColor}`}>
                      {(() => {
                        const l = getThoughtLabelKey(th.type);
                        return l === 'AI' ? l : t(l);
                      })()}
                      {th.toolName && ` - ${th.toolName}`}
                    </span>
                  </div>
                  {thContent && (
                    <div className="text-[10px] text-muted-foreground/60 whitespace-pre-wrap break-words mt-0.5 line-clamp-3">
                      {thContent}
                    </div>
                  )}
                  {hasResult && th.toolResult!.output && (
                    <div className="mt-1">
                      <ToolResultViewer
                        toolName={th.toolName || ''}
                        toolInput={th.toolInput}
                        output={th.toolResult!.output}
                        isError={th.toolResult!.isError}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Worker streaming content / final output */}
      {worker.streamingContent && (
        <div className="mx-3 my-1.5 rounded bg-background/50 px-2.5 py-1.5">
          <div className="text-[11px] break-words leading-relaxed text-foreground/80">
            <MarkdownRenderer content={worker.streamingContent} mode="streaming" />
            {worker.isStreaming && (
              <span className="inline-block w-0.5 h-3.5 ml-0.5 bg-primary streaming-cursor align-middle" />
            )}
          </div>
        </div>
      )}

      {/* Worker error */}
      {worker.error && (
        <div className="mx-3 my-1.5 rounded bg-red-500/10 border border-red-500/20 px-2.5 py-1.5">
          <p className="text-[10px] text-red-400">{worker.error}</p>
        </div>
      )}
    </div>
  );
}

// Match Task tool_use thoughts to worker sessions by description
function useWorkerMatching(
  thoughts: Thought[],
  workerSessions?: Map<string, WorkerSessionState>,
): Map<string, WorkerSessionState> {
  return useMemo(() => {
    const matchMap = new Map<string, WorkerSessionState>();
    if (!workerSessions || workerSessions.size === 0) return matchMap;

    const workers = Array.from(workerSessions.values());
    const matchedWorkers = new Set<string>();

    // First pass: match by description (most reliable)
    for (const thought of thoughts) {
      if (
        thought.type !== 'tool_use' ||
        (thought.toolName !== 'Task' && thought.toolName !== 'Agent')
      )
        continue;
      const desc = thought.toolInput?.description;
      if (!desc) continue;

      for (const worker of workers) {
        if (matchedWorkers.has(worker.agentId)) continue;
        // Match if worker task contains the description or vice versa
        if (
          worker.task &&
          (worker.task === desc || worker.task.includes(desc) || desc.includes(worker.task))
        ) {
          matchMap.set(thought.id, worker);
          matchedWorkers.add(worker.agentId);
          break;
        }
      }
    }

    // Second pass: match remaining Task tool_use by order
    const unmatchedTasks = thoughts.filter(
      (th) =>
        th.type === 'tool_use' &&
        (th.toolName === 'Task' || th.toolName === 'Agent') &&
        !matchMap.has(th.id),
    );
    const unmatchedWorkers = workers.filter((w) => !matchedWorkers.has(w.agentId));

    for (let i = 0; i < Math.min(unmatchedTasks.length, unmatchedWorkers.length); i++) {
      matchMap.set(unmatchedTasks[i].id, unmatchedWorkers[i]);
    }

    return matchMap;
  }, [thoughts, workerSessions]);
}

// Individual thought item (for non-special tools)
const ThoughtItem = memo(function ThoughtItem({
  thought,
  isLast,
  matchedWorker,
}: {
  thought: Thought;
  isLast: boolean;
  matchedWorker?: WorkerSessionState;
}) {
  const [showRawJson, setShowRawJson] = useState(false);
  const [isContentExpanded, setIsContentExpanded] = useState(false); // For thinking/text content expand
  const [isToolExpanded, setIsToolExpanded] = useState(true); // For tool_use container expand
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();
  const color = getThoughtColor(thought.type, thought.isError);
  const Icon = getThoughtIcon(thought.type, thought.toolName);

  // Determine content and display mode based on thought type and streaming state
  const isStreaming = thought.isStreaming ?? false;
  const isToolReady = thought.isReady ?? true; // Default true for backward compatibility
  const hasToolResult = thought.type === 'tool_use' && thought.toolResult;
  const isToolRunning = thought.type === 'tool_use' && isToolReady && !hasToolResult; // Tool ready but no result yet

  // For tool_use: show friendly format when ready, "Generating..." when streaming
  // For thinking: show content directly with streaming placeholder
  let displayContent = '';
  let needsTruncate = false;
  const maxPreviewLength = 150;

  if (thought.type === 'tool_use') {
    if (!isToolReady) {
      displayContent = '...';
    } else {
      displayContent = getToolFriendlyFormat(thought.toolName || '', thought.toolInput);
    }
    needsTruncate = displayContent.length > maxPreviewLength;
  } else if (thought.type === 'thinking') {
    displayContent = thought.content || (isStreaming ? '...' : '');
    needsTruncate = displayContent.length > maxPreviewLength;
  } else if (thought.type === 'tool_result') {
    displayContent = thought.toolOutput || '';
    needsTruncate = displayContent.length > maxPreviewLength;
  } else {
    displayContent = thought.content || '';
    needsTruncate = displayContent.length > maxPreviewLength;
  }

  // Always truncate content - use JSON button to see full content
  const truncatedContent = needsTruncate
    ? displayContent.substring(0, maxPreviewLength)
    : displayContent;

  // Status indicator for tool_use - now includes execution status
  const getToolStatus = () => {
    if (thought.type !== 'tool_use') return null;
    if (!isToolReady) return { label: t('Generating'), color: 'text-amber-400', icon: 'loading' };
    if (hasToolResult) {
      return thought.toolResult!.isError
        ? { label: t('Hint'), color: 'text-amber-500', icon: 'warning' }
        : { label: t('Done'), color: 'text-green-400', icon: 'success' };
    }
    return { label: t('Running'), color: 'text-blue-400', icon: 'running' };
  };
  const toolStatus = getToolStatus();

  // Copy tool call + result combined content
  const handleCopyTool = useCallback(async () => {
    if (thought.type !== 'tool_use') return;
    const parts: string[] = [];
    const input = thought.toolInput
      ? getToolFriendlyFormat(thought.toolName || '', thought.toolInput)
      : '';
    const rawInput = thought.toolInput ? JSON.stringify(thought.toolInput, null, 2) : '';
    if (input) parts.push(`[${thought.toolName}] ${input}`);
    if (rawInput && rawInput !== '{}') parts.push(`Input:\n${rawInput}`);
    if (thought.toolResult?.output) parts.push(`Output:\n${thought.toolResult.output}`);
    if (parts.length > 0) {
      try {
        await navigator.clipboard.writeText(parts.join('\n\n'));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  }, [thought.type, thought.toolName, thought.toolInput, thought.toolResult]);

  // Auto-expand tool container when result arrives
  useEffect(() => {
    if (hasToolResult) setIsToolExpanded(true);
  }, [hasToolResult]);

  return (
    <div className="flex gap-3 group animate-fade-in">
      {/* Timeline line */}
      <div className="flex flex-col items-center">
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center ${
            thought.isError || thought.toolResult?.isError
              ? 'bg-amber-500/20'
              : isStreaming
                ? 'bg-primary/20'
                : 'bg-primary/10'
          } ${thought.toolResult?.isError ? 'text-amber-500' : color}`}
        >
          {hasToolResult ? (
            thought.toolResult!.isError ? (
              <AlertTriangle size={14} />
            ) : (
              <CheckCircle2 size={14} />
            )
          ) : (
            <Icon size={14} />
          )}
        </div>
        {!isLast && <div className="w-0.5 flex-1 bg-border/30 mt-1" />}
      </div>

      {/* Content */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`text-xs font-medium ${thought.toolResult?.isError ? 'text-amber-500' : color}`}
          >
            {(() => {
              const label = getThoughtLabelKey(thought.type);
              return label === 'AI' ? label : t(label);
            })()}
            {thought.toolName && ` - ${thought.toolName}`}
          </span>
          {/* Subagent indicator — small badge when thought has agent tag */}
          {thought.agentName && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-400 font-semibold border border-purple-500/20">
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-purple-400">
                <circle cx="4" cy="4" r="4" fill="currentColor" />
              </svg>
              {thought.agentName.length > 35
                ? thought.agentName.substring(0, 35) + '…'
                : thought.agentName}
            </span>
          )}
          {toolStatus && <span className={`text-xs ${toolStatus.color}`}>{toolStatus.label}</span>}
          {/* Time - hidden on mobile */}
          <span className="hidden sm:inline text-xs text-muted-foreground/50">
            {new Date(thought.timestamp).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
          {/* Duration - hidden on mobile */}
          {thought.duration && (
            <span className="hidden sm:inline text-xs text-muted-foreground/40">
              ({(thought.duration / 1000).toFixed(1)}s)
            </span>
          )}
        </div>

        {/* ---- tool_use: unified container for input + result ---- */}
        {thought.type === 'tool_use' && isToolReady && (
          <div
            className={`mt-1 rounded-lg border overflow-hidden transition-colors ${
              hasToolResult
                ? thought.toolResult!.isError
                  ? 'border-amber-500/30 bg-amber-500/5'
                  : 'border-border/30 bg-muted/20'
                : 'border-border/30 bg-muted/20'
            }`}
          >
            {/* Toolbar */}
            <div
              className={`flex items-center justify-between px-2.5 py-[3px] border-b text-[10px] ${
                hasToolResult
                  ? thought.toolResult!.isError
                    ? 'border-amber-500/20 bg-amber-500/10 text-amber-600/60'
                    : 'border-border/20 bg-muted/30 text-muted-foreground/60'
                  : 'border-border/20 bg-muted/30 text-muted-foreground/60'
              }`}
            >
              <span className="flex items-center gap-1.5">
                {isToolRunning && <Loader2 size={10} className="animate-spin" />}
                {isToolRunning
                  ? t('Executing...')
                  : hasToolResult
                    ? t('Completed')
                    : t('Tool call')}
              </span>
              <div className="flex items-center gap-0.5">
                {/* Copy button */}
                {thought.toolInput && Object.keys(thought.toolInput).length > 0 && (
                  <button
                    onClick={handleCopyTool}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-foreground transition-colors"
                    title={t('Copy')}
                  >
                    {copied ? (
                      <>
                        <Check size={10} className="text-green-400" />
                        <span className="hidden sm:inline text-green-400">{t('Copied')}</span>
                      </>
                    ) : (
                      <>
                        <Copy size={10} />
                        <span className="hidden sm:inline">{t('Copy')}</span>
                      </>
                    )}
                  </button>
                )}
                {/* Raw JSON toggle */}
                {thought.toolInput && Object.keys(thought.toolInput).length > 0 && (
                  <button
                    onClick={() => setShowRawJson(!showRawJson)}
                    className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors ${
                      showRawJson
                        ? 'bg-primary/20 text-primary'
                        : 'hover:bg-white/10 hover:text-foreground'
                    }`}
                    title={showRawJson ? t('Hide raw JSON') : t('Show raw JSON')}
                  >
                    <Braces size={10} />
                  </button>
                )}
                {/* Expand/Collapse container */}
                <button
                  onClick={() => setIsToolExpanded(!isToolExpanded)}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-foreground transition-colors"
                >
                  {isToolExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                </button>
              </div>
            </div>

            {/* Content (collapsible) */}
            {isToolExpanded && (
              <div>
                {/* Tool input - friendly format */}
                {displayContent && (
                  <div className="px-3 py-2 text-[11px] text-foreground/80 whitespace-pre-wrap break-words">
                    {isContentExpanded || !needsTruncate
                      ? displayContent
                      : truncatedContent + '...'}
                    {needsTruncate && (
                      <button
                        onClick={() => setIsContentExpanded(!isContentExpanded)}
                        className="ml-1 text-primary/60 hover:text-primary"
                      >
                        {isContentExpanded ? t('Collapse') : t('Expand')}
                      </button>
                    )}
                  </div>
                )}

                {/* Raw JSON display */}
                {showRawJson && thought.toolInput && (
                  <pre className="mx-3 mb-2 p-2 rounded bg-background/50 text-[10px] text-muted-foreground overflow-x-auto">
                    {JSON.stringify(thought.toolInput, null, 2)}
                  </pre>
                )}

                {/* Divider + Tool result */}
                {hasToolResult && thought.toolResult!.output && (
                  <div className="border-t border-border/20">
                    <ToolResultViewer
                      toolName={thought.toolName || ''}
                      toolInput={thought.toolInput}
                      output={thought.toolResult!.output}
                      isError={thought.toolResult!.isError}
                    />
                  </div>
                )}

                {/* Running indicator (no result yet) */}
                {isToolRunning && !matchedWorker && (
                  <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/50">
                    <Loader2 size={10} className="animate-spin" />
                    <span>{t('Waiting for result...')}</span>
                  </div>
                )}
              </div>
            )}

            {/* Nested worker thoughts for Task tool_use */}
            {matchedWorker && <NestedWorkerTimeline worker={matchedWorker} />}
          </div>
        )}

        {/* ---- non-tool_use: original content display (thinking, text, tool_result, etc.) ---- */}
        {thought.type !== 'tool_use' && (
          <div className="flex items-end gap-3">
            {/* Content - takes available space */}
            <div className="flex-1 min-w-0">
              {displayContent && (
                <div
                  className={`text-sm ${
                    thought.type === 'thinking'
                      ? 'text-muted-foreground/70 italic'
                      : 'text-foreground/80'
                  } whitespace-pre-wrap break-words`}
                >
                  {isContentExpanded || !needsTruncate ? displayContent : truncatedContent + '...'}
                  {needsTruncate && (
                    <button
                      onClick={() => setIsContentExpanded(!isContentExpanded)}
                      className="ml-1 text-primary/60 hover:text-primary not-italic"
                    >
                      {isContentExpanded ? t('Collapse') : t('Expand')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* tool_use streaming (not ready yet) - minimal display */}
        {thought.type === 'tool_use' && !isToolReady && (
          <div className="text-sm text-muted-foreground/50">...</div>
        )}
      </div>
    </div>
  );
});

// Lazy wrapper: defers rendering of ThoughtItem until it enters the scroll viewport.
// Once visible, stays rendered permanently (no unmount on scroll-away).
// Estimated height placeholder prevents layout jumps.
const THOUGHT_ITEM_ESTIMATED_HEIGHT = 60;

function LazyThoughtItem({
  thought,
  isLast,
  scrollContainerRef,
  eager = false,
  matchedWorker,
}: {
  thought: Thought;
  isLast: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  eager?: boolean;
  matchedWorker?: WorkerSessionState;
}) {
  const [ref, isVisible] = useLazyVisible('200px', scrollContainerRef, eager);

  if (isVisible) {
    return <ThoughtItem thought={thought} isLast={isLast} matchedWorker={matchedWorker} />;
  }

  return <div ref={ref} style={{ minHeight: THOUGHT_ITEM_ESTIMATED_HEIGHT }} />;
}

/**
 * Collapsible subagent thought group.
 * Default collapsed — user clicks to expand.
 * Shows a summary line (step count + duration) when collapsed.
 */
const SubagentThoughtGroup = memo(function SubagentThoughtGroup({
  group,
  scrollContainerRef,
  isLastGroup,
}: {
  group: ThoughtGroup;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  isLastGroup: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { t } = useTranslation();

  const subThoughts = group.subagentThoughts;
  if (!subThoughts || subThoughts.length === 0) {
    // No subagent thoughts — just render the main thought normally
    return (
      <LazyThoughtItem
        thought={group.main}
        isLast={isLastGroup && !group.main.type} // will be overridden
        scrollContainerRef={scrollContainerRef}
        eager
      />
    );
  }

  const agentName = subThoughts[0]?.agentName || '';
  const truncatedName = agentName.length > 40 ? agentName.substring(0, 40) + '...' : agentName;

  // Calculate duration from first to last subagent thought
  const duration = useMemo(() => {
    if (subThoughts.length < 2) return null;
    const start = new Date(subThoughts[0].timestamp).getTime();
    const end = new Date(subThoughts[subThoughts.length - 1].timestamp).getTime();
    return ((end - start) / 1000).toFixed(1);
  }, [subThoughts]);

  return (
    <>
      {/* Main thought */}
      <LazyThoughtItem
        thought={group.main}
        isLast={false}
        scrollContainerRef={scrollContainerRef}
        eager
      />

      {/* Collapsible subagent container */}
      <div className="ml-1 my-1 rounded-lg border border-purple-500/20 bg-purple-500/[0.04] overflow-hidden">
        {/* Expand/collapse header */}
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-purple-500/5 transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <ChevronDown
            size={12}
            className={`text-purple-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-[11px] font-medium text-purple-400 truncate">
              {truncatedName}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground/50 flex-1">
            {subThoughts.length} {t('steps')}
            {duration && ` · ${duration}s`}
          </span>
          {group.main.isThinking && <Loader2 size={10} className="text-purple-400 animate-spin" />}
        </button>

        {/* Subagent thoughts — rendered lazily */}
        {isExpanded && (
          <div className="border-t border-purple-500/10 max-h-[400px] overflow-auto scrollbar-overlay">
            {subThoughts.map((th, idx) => (
              <div key={th.id} className="ml-3 pl-2 border-l border-purple-500/15">
                <ThoughtItem thought={th} isLast={idx === subThoughts.length - 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
});

export function ThoughtProcess({
  thoughts,
  isThinking,
  workerSessions,
  defaultExpanded,
  isWorkerView = false,
}: ThoughtProcessProps) {
  // Start collapsed (or expanded if defaultExpanded is set), auto-expand when streaming starts
  const [isExpanded, setIsExpanded] = useState(defaultExpanded ?? false);
  const [hasAutoExpanded, setHasAutoExpanded] = useState(defaultExpanded ?? false);
  const [isMaximized, setIsMaximized] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  // Auto-expand when isThinking becomes true (streaming started)
  // Only do this once per session to avoid annoying user who manually collapsed
  useEffect(() => {
    if (isThinking && !hasAutoExpanded && thoughts.length > 0) {
      setIsExpanded(true);
      setHasAutoExpanded(true);
    }
  }, [isThinking, hasAutoExpanded, thoughts.length]);

  // Reset auto-expand flag when thoughts are cleared (new session)
  useEffect(() => {
    if (thoughts.length === 0) {
      setHasAutoExpanded(false);
    }
  }, [thoughts.length]);

  // Calculate elapsed time from first thought's timestamp
  // This is more reliable than tracking component mount time
  const startTime = useMemo(() => {
    if (thoughts.length > 0) {
      return new Date(thoughts[0].timestamp).getTime();
    }
    return null;
  }, [thoughts.length > 0 ? thoughts[0]?.timestamp : null]);

  // Get latest todo data (only render one TodoCard at bottom)
  const latestTodos = useMemo(() => {
    // Find all TodoWrite tool calls and get the latest one
    const todoThoughts = thoughts.filter(
      (t) => t.type === 'tool_use' && t.toolName === 'TodoWrite' && t.toolInput,
    );
    if (todoThoughts.length === 0) return null;

    const latest = todoThoughts[todoThoughts.length - 1];
    return parseTodoInput(latest.toolInput!);
  }, [thoughts]);

  // Match Task tool_use thoughts to worker sessions
  const workerMatchMap = useWorkerMatching(thoughts, workerSessions);

  // Filter + group subagent thoughts.
  // Each main thought that has subagent activity gets a ThoughtGroup with
  // subagentThoughts. The UI renders these in collapsible containers (default collapsed).
  // This is DISPLAY ONLY — subagent thoughts remain in their isolated WorkerSessionState
  // and are NOT added to the main session's memory or persistence.
  const thoughtGroups = useMemo((): ThoughtGroup[] => {
    const filtered = thoughts.filter((t) => {
      if (t.type === 'result') return false;
      if (t.type === 'tool_result') return false; // Merged into tool_use
      // Exclude TodoWrite tool_use (shown separately at bottom)
      if (t.toolName === 'TodoWrite') return false;
      return true;
    });
    // Worker view: thoughts already belong to this sub-agent, no grouping needed
    if (isWorkerView) {
      return filtered.map((t) => ({ main: t }));
    }
    return groupSubagentThoughts(filtered, workerMatchMap);
  }, [thoughts, workerMatchMap, isWorkerView]);

  // Smart auto-scroll: only scrolls when user is at bottom
  // Stops auto-scroll when user scrolls up to read history
  const { handleScroll } = useSmartScroll({
    containerRef: contentRef,
    threshold: 50,
    deps: [thoughts, isExpanded],
  });

  // Don't render if no thoughts and not thinking
  if (thoughts.length === 0 && !isThinking) {
    return null;
  }

  // Only count system-level errors (type: 'error'), not tool execution failures (tool_result with isError)
  // Tool failures are normal during agent investigation and should not affect overall status
  const errorCount = thoughts.filter((t) => t.type === 'error').length;

  // Check if there's content to show in the scrollable area
  const hasDisplayContent = thoughtGroups.length > 0;

  return (
    <div className="animate-fade-in mb-4">
      <div
        className={`
          relative rounded-xl border overflow-hidden transition-all duration-300
          ${
            isThinking
              ? 'border-primary/40 bg-primary/5'
              : errorCount > 0
                ? 'border-destructive/30 bg-destructive/5'
                : 'border-border/50 bg-card/30'
          }
        `}
      >
        {/* Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
        >
          {/* Status indicator */}
          {isThinking ? (
            <Loader2 size={16} className="text-primary animate-spin" />
          ) : (
            <CheckCircle2
              size={16}
              className={errorCount > 0 ? 'text-destructive' : 'text-primary'}
            />
          )}

          {/* Title: action summary when thinking, "Thought process" when done */}
          <span
            className={`text-sm font-medium ${isThinking ? 'text-primary' : 'text-foreground'}`}
          >
            {isThinking
              ? (() => {
                  const data = getActionSummaryData(thoughts);
                  return t(data.key, data.params);
                })()
              : t('Thought process')}
          </span>

          {/* Stats: only show elapsed time when thinking is complete */}
          {!isThinking && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
              <TimerDisplay startTime={startTime} isThinking={isThinking} />
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Expand icon */}
          <ChevronDown
            size={16}
            className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          />
        </button>

        {/* Content */}
        {isExpanded && (
          <div className="border-t border-border/30 thought-content">
            {/* Scrollable thought items */}
            {hasDisplayContent && (
              <div
                ref={contentRef}
                onScroll={handleScroll}
                className={`px-4 pt-3 ${isMaximized ? 'max-h-[80vh]' : 'max-h-[300px]'} overflow-auto scrollbar-overlay transition-all duration-200`}
              >
                {thoughtGroups.map((group, index) => {
                  const isLastGroup =
                    index === thoughtGroups.length - 1 && !latestTodos && !isThinking;
                  const hasSubagents = group.subagentThoughts && group.subagentThoughts.length > 0;

                  if (hasSubagents) {
                    // Render as collapsible group
                    return (
                      <SubagentThoughtGroup
                        key={group.main.id}
                        group={group}
                        scrollContainerRef={contentRef}
                        isLastGroup={isLastGroup}
                      />
                    );
                  }

                  // No subagents — render normally
                  return (
                    <LazyThoughtItem
                      key={group.main.id}
                      thought={group.main}
                      isLast={isLastGroup}
                      scrollContainerRef={contentRef}
                      eager={index >= thoughtGroups.length - 3}
                    />
                  );
                })}
              </div>
            )}

            {/* TodoCard - fixed at bottom, only one instance */}
            {latestTodos && latestTodos.length > 0 && (
              <div className={`px-4 ${hasDisplayContent ? 'pt-2' : 'pt-3'} pb-3`}>
                <TodoCard todos={latestTodos} isAgentActive={isThinking} />
              </div>
            )}

            {/* Maximize toggle - bottom right, heuristic: show when likely to overflow */}
            {(thoughtGroups.length > 8 || isMaximized) && (
              <div className="flex justify-end px-4 pb-2">
                <button
                  onClick={() => setIsMaximized(!isMaximized)}
                  className="flex items-center gap-0.5 px-1 py-px rounded text-xs text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                  title={isMaximized ? t('Compact view') : t('Full view')}
                >
                  {isMaximized ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {isMaximized ? 'Compact' : 'Full'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
