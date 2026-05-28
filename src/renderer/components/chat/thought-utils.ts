/**
 * Thought Utilities - Shared utilities for thought display components
 *
 * Provides consistent styling, icons, labels and formatting for thought items
 * across ThoughtProcess (real-time) and CollapsedThoughtProcess (history) components.
 */

import {
  Lightbulb,
  Braces,
  CheckCircle2,
  MessageSquare,
  Info,
  XCircle,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { getToolIcon } from '../icons/ToolIcons';
import type { Thought } from '../../types';
import type { WorkerSessionState } from '../../stores/chat.store';

// i18n static keys for extraction (DO NOT REMOVE)
void function _i18nThoughtKeys(t: (k: string) => string) {
  t('Thinking'); t('Tool call'); t('Tool result'); t('System'); t('Error'); t('Complete')
}

// ============================================
// Text Utilities
// ============================================

/**
 * Truncate text with ellipsis if exceeds max length
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 1) + '…';
}

// ============================================
// Thought Type Styling
// ============================================

/**
 * Get icon component for thought type
 *
 * @param type - Thought type
 * @param toolName - Optional tool name for tool_use type (uses tool-specific icon)
 * @returns LucideIcon component
 */
export function getThoughtIcon(type: Thought['type'], toolName?: string): LucideIcon {
  switch (type) {
    case 'thinking':
      return Lightbulb;
    case 'tool_use':
      return toolName ? getToolIcon(toolName) : Braces;
    case 'tool_result':
      return CheckCircle2;
    case 'text':
      return MessageSquare;
    case 'system':
      return Info;
    case 'error':
      return XCircle;
    case 'result':
      return Sparkles;
    default:
      return Zap;
  }
}

/**
 * Get Tailwind color class for thought type
 *
 * @param type - Thought type
 * @param isError - Override to show error color
 * @returns Tailwind color class string
 */
export function getThoughtColor(type: Thought['type'], isError?: boolean): string {
  // Tool errors use amber (warning) instead of red (destructive) because
  // they are internal AI feedback, not user-facing errors
  if (isError) return 'text-amber-500';

  switch (type) {
    case 'thinking':
      return 'text-blue-400';
    case 'tool_use':
      return 'text-amber-400';
    case 'tool_result':
      return 'text-green-400';
    case 'text':
      return 'text-foreground';
    case 'system':
      return 'text-muted-foreground';
    case 'error':
      return 'text-destructive';
    case 'result':
      return 'text-primary';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Get display label for thought type
 *
 * @param type - Thought type
 * @returns Display label string (English, not translated)
 */
export function getThoughtLabelKey(type: Thought['type']): string {
  switch (type) {
    case 'thinking':
      return 'Thinking';
    case 'tool_use':
      return 'Tool call';
    case 'tool_result':
      return 'Tool result';
    case 'text':
      return 'AI';
    case 'system':
      return 'System';
    case 'error':
      return 'Error';
    case 'result':
      return 'Complete';
    default:
      return 'AI';
  }
}

// ============================================
// Tool Input Formatting
// ============================================

/**
 * Format tool input into human-readable summary
 *
 * Transforms raw tool parameters into friendly descriptions:
 * - Read: shows file path
 * - Bash: shows command
 * - WebFetch: shows domain name
 * - etc.
 *
 * @param toolName - Name of the tool
 * @param toolInput - Tool input parameters
 * @returns Human-readable summary string
 */
export function getToolFriendlyFormat(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  if (!toolInput) return '';

  switch (toolName) {
    case 'Bash':
      return typeof toolInput.command === 'string' ? toolInput.command : '';

    case 'Read':
      return typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

    case 'Write':
      return typeof toolInput.file_path === 'string' ? `${toolInput.file_path} (new)` : '';

    case 'Edit':
      return typeof toolInput.file_path === 'string' ? `${toolInput.file_path} (edit)` : '';

    case 'Grep': {
      const pattern = typeof toolInput.pattern === 'string' ? `"${toolInput.pattern}"` : '';
      const path = typeof toolInput.path === 'string' ? ` in ${toolInput.path}` : '';
      return `Search ${pattern}${path}`;
    }

    case 'Glob':
      return typeof toolInput.pattern === 'string' ? `Match ${toolInput.pattern}` : '';

    case 'WebFetch': {
      if (typeof toolInput.url === 'string') {
        try {
          return new URL(toolInput.url).hostname.replace('www.', '');
        } catch {
          return toolInput.url;
        }
      }
      return '';
    }

    case 'WebSearch':
      return typeof toolInput.query === 'string' ? `Search: ${toolInput.query}` : '';

    case 'Agent':
    case 'Task':
      return typeof toolInput.description === 'string'
        ? toolInput.description
        : typeof toolInput.prompt === 'string'
          ? toolInput.prompt
          : '';

    case 'NotebookEdit':
      return typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : '';

    default:
      // Fallback: show first non-empty string value
      for (const value of Object.values(toolInput)) {
        if (typeof value === 'string' && value.length > 0) {
          return truncateText(value, 80);
        }
      }
      return '';
  }
}

// ============================================
// Action Summary for Pulse Task Cards
// ============================================

/**
 * Get human-friendly action summary from thoughts array.
 * Searches from the end to find the most recent action.
 * Used by Pulse task cards and _computePulseItems.
 */
export function getActionSummary(thoughts: Thought[]): string {
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const th = thoughts[i];
    if (th.type === 'tool_use' && th.toolName) {
      // Tool still streaming params
      if (th.isStreaming || !th.isReady) {
        return th.toolName;
      }
      const formatted = getToolFriendlyFormat(th.toolName, th.toolInput);
      if (formatted) return truncateText(formatted, 40);
      return th.toolName;
    }
    if (th.type === 'thinking') {
      return 'Thinking...';
    }
  }
  return '';
}

/**
 * Count completed tool steps from thoughts array.
 * A step is "completed" when a tool_use thought has a toolResult attached.
 */
export function getStepCounts(thoughts: Thought[]): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const th of thoughts) {
    if (th.type === 'tool_use') {
      total++;
      if (th.toolResult) completed++;
    }
  }
  return { completed, total };
}

// ============================================
// Subagent Thought Grouping
// ============================================

/**
 * A group in the thought timeline — a main agent thought optionally
 * followed by a batch of subagent thoughts.
 */
export interface ThoughtGroup {
  /** The main agent's thought */
  main: Thought;
  /** Subagent thoughts grouped under this main thought (display-only) */
  subagentThoughts?: Thought[];
}

/**
 * Group main thoughts with their subagent thoughts.
 *
 * This is a DISPLAY-ONLY operation — it does NOT modify the main agent's
 * session memory or persisted thoughts. Worker thoughts remain in their
 * isolated WorkerSessionState and are only injected into the display list
 * for easier reading and analysis.
 *
 * Each main thought that has a matched worker gets a `ThoughtGroup` with
 * the worker's display thoughts as `subagentThoughts`. The UI can then
 * render these in a collapsible container (default collapsed).
 *
 * @param thoughts - Main agent's thought array (already filtered)
 * @param workerMatchMap - Map from thought.id to WorkerSessionState
 *                         (same as returned by useWorkerMatching)
 * @returns Array of ThoughtGroups for rendering
 */
export function groupSubagentThoughts(
  thoughts: Thought[],
  workerMatchMap: Map<string, WorkerSessionState>,
): ThoughtGroup[] {
  // Separate main thoughts (no agentId) and inline subagent thoughts (has agentId)
  // Sub-agent thoughts are dual-written to main session.thoughts with agentId tags.
  const mainThoughts: Thought[] = [];
  const inlineSubagentMap = new Map<string, Thought[]>();
  for (const th of thoughts) {
    if ((th as any).agentId) {
      const group = inlineSubagentMap.get((th as any).agentId) || [];
      group.push(th);
      inlineSubagentMap.set((th as any).agentId, group);
    } else {
      mainThoughts.push(th);
    }
  }

  const filterSubagentThoughts = (ths: Thought[]): Thought[] =>
    ths
      .filter((th) => {
        if (th.type === 'result') return false;
        if (th.type === 'tool_result') return false;
        if (th.toolName === 'TodoWrite') return false;
        return true;
      });

  // Assign inline subagent groups to Agent/Task tool_use thoughts by positional order
  const orderedAgentIds = Array.from(inlineSubagentMap.keys());
  const assignedInlineIds = new Set<string>();
  let inlineIdx = 0;
  for (const th of mainThoughts) {
    if (
      th.type === 'tool_use' &&
      (th.toolName === 'Agent' || th.toolName === 'Task') &&
      inlineIdx < orderedAgentIds.length
    ) {
      assignedInlineIds.add(orderedAgentIds[inlineIdx]);
      inlineIdx++;
    }
  }

  return mainThoughts.map((thought) => {
    const group: ThoughtGroup = { main: thought };

    // Priority 1: match from workerSessions (live worker data)
    const worker = workerMatchMap.get(thought.id);
    if (worker && worker.thoughts.length > 0) {
      const workerDisplayThoughts = filterSubagentThoughts(worker.thoughts)
        .map((wThought) => ({
          ...wThought,
          agentId: worker.agentId,
          agentName: worker.agentName,
        }));
      if (workerDisplayThoughts.length > 0) {
        group.subagentThoughts = workerDisplayThoughts;
      }
      return group;
    }

    // Priority 2: match from inline agentId (dual-write fallback)
    const agentId = (thought as any).agentId;
    if (agentId && inlineSubagentMap.has(agentId)) {
      const displayThoughts = filterSubagentThoughts(inlineSubagentMap.get(agentId) || []);
      if (displayThoughts.length > 0) {
        group.subagentThoughts = displayThoughts;
      }
      return group;
    }

    // Priority 3: positional match for Agent/Task tool_use without agentId on the thought itself
    if (
      thought.type === 'tool_use' &&
      (thought.toolName === 'Agent' || thought.toolName === 'Task')
    ) {
      const nextAgentId = orderedAgentIds.find(id => !assignedInlineIds.has(id));
      if (nextAgentId) {
        const displayThoughts = filterSubagentThoughts(inlineSubagentMap.get(nextAgentId) || []);
        if (displayThoughts.length > 0) {
          group.subagentThoughts = displayThoughts;
          assignedInlineIds.add(nextAgentId);
        }
      }
    }

    return group;
  });
}

/**
 * Group thoughts using inline agentId tags (for historical display after restart).
 *
 * Unlike `groupSubagentThoughts()` which requires live workerSessions, this function
 * works purely from persisted data where subagent thoughts have agentId/agentName tags.
 *
 * Logic:
 * 1. Separate thoughts into main (no agentId) and subagent (has agentId)
 * 2. Group subagent thoughts by agentId
 * 3. For each main Agent/Task tool_use thought, attach the matching subagent group
 *    (matched by positional order)
 */
export function groupSubagentThoughtsFromPersisted(thoughts: Thought[]): ThoughtGroup[] {
  // Separate main and subagent thoughts
  const mainThoughts: Thought[] = [];
  const subagentGroups = new Map<string, Thought[]>(); // agentId -> thoughts

  for (const thought of thoughts) {
    if (thought.agentId) {
      const group = subagentGroups.get(thought.agentId) || [];
      group.push(thought);
      subagentGroups.set(thought.agentId, group);
    } else {
      mainThoughts.push(thought);
    }
  }

  // If no subagent thoughts, return simple groups
  if (subagentGroups.size === 0) {
    return mainThoughts.map((t) => ({ main: t }));
  }

  // Match subagent groups to main Agent/Task tool_use thoughts by positional order
  const assignedAgentIds = new Set<string>();
  const agentToolThoughts: Thought[] = []; // Track Agent/Task thoughts in order
  const agentToolIndices: number[] = []; // Their indices in mainThoughts

  for (let i = 0; i < mainThoughts.length; i++) {
    const t = mainThoughts[i];
    if (t.type === 'tool_use' && (t.toolName === 'Agent' || t.toolName === 'Task')) {
      agentToolThoughts.push(t);
      agentToolIndices.push(i);
    }
  }

  // Get ordered list of subagent groups (by first thought timestamp)
  const orderedGroups = Array.from(subagentGroups.entries()).sort(([, a], [, b]) => {
    const timeA = a[0] ? new Date(a[0].timestamp).getTime() : 0;
    const timeB = b[0] ? new Date(b[0].timestamp).getTime() : 0;
    return timeA - timeB;
  });

  // Match by positional order: first Agent tool_use -> first subagent group, etc.
  for (let i = 0; i < Math.min(agentToolThoughts.length, orderedGroups.length); i++) {
    const [agentId] = orderedGroups[i];
    assignedAgentIds.add(agentId);
  }

  // Build result groups
  const result: ThoughtGroup[] = mainThoughts.map((thought, index) => {
    const group: ThoughtGroup = { main: thought };

    // If this is an Agent/Task tool_use, find matching subagent group
    if (
      thought.type === 'tool_use' &&
      (thought.toolName === 'Agent' || thought.toolName === 'Task')
    ) {
      const toolIdx = agentToolIndices.indexOf(index);
      if (toolIdx !== -1 && toolIdx < orderedGroups.length) {
        const [agentId, subThoughts] = orderedGroups[toolIdx];
        // Filter subagent thoughts for display (same filter as groupSubagentThoughts)
        const displayThoughts = subThoughts.filter((th) => {
          if (th.type === 'result') return false;
          if (th.type === 'tool_result') return false;
          if (th.toolName === 'TodoWrite') return false;
          return true;
        });
        if (displayThoughts.length > 0) {
          group.subagentThoughts = displayThoughts;
        }
        assignedAgentIds.add(agentId);
      }
    }

    return group;
  });

  // Append any unmatched subagent thoughts as standalone groups at the end
  for (const [agentId, subThoughts] of orderedGroups) {
    if (!assignedAgentIds.has(agentId)) {
      const displayThoughts = subThoughts.filter((th) => {
        if (th.type === 'result') return false;
        if (th.type === 'tool_result') return false;
        if (th.toolName === 'TodoWrite') return false;
        return true;
      });
      if (displayThoughts.length > 0) {
        result.push({
          main: displayThoughts[0],
          subagentThoughts: displayThoughts.length > 1 ? displayThoughts.slice(1) : undefined,
        });
      }
    }
  }

  return result;
}
