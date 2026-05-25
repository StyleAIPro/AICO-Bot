/**
 * Agent Module - SDK Subagent Tracking
 *
 * Tracks SDK subagent (Agent tool) lifecycle and stream events.
 * When Claude spawns a subagent via the Agent tool, the SDK emits events with
 * parent_tool_use_id set to the Agent tool_use block's ID. We detect these
 * and route them into the existing WorkerSessionState pipeline (worker:started,
 * worker:completed, agent:thought with agentId), which already has full
 * frontend support (NestedWorkerTimeline in ThoughtProcess.tsx).
 */

import type { Thought, SessionState } from './types';
import { sendToRenderer } from './helpers';

// ============================================
// Types
// ============================================

export interface SubagentState {
  taskId: string;
  toolUseId?: string;
  agentId: string;
  agentName: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  isComplete: boolean;
  lastError?: string;
  // Per-subagent streaming block state (isolated from parent's streamingBlocks)
  streamingBlocks: Map<
    number,
    {
      type: 'thinking' | 'text' | 'tool_use';
      thoughtId: string;
      content: string;
      toolName?: string;
      toolId?: string;
    }
  >;
  // Per-subagent tool ID to thought ID mapping (isolated from parent's)
  toolIdToThoughtId: Map<string, string>;
}

// ============================================
// Subagent Lookup
// ============================================

/**
 * Look up a SubagentState by parentToolUseId (the Agent tool's tool_use block ID).
 * Checks both the toolUseIdToTaskId map and direct scan of subagentStates.
 */
export function findSubagentByToolUseId(
  toolUseId: string,
  states: Map<string, SubagentState>,
  mapping: Map<string, string>,
): SubagentState | undefined {
  // Fast path: use the mapping
  const taskId = mapping.get(toolUseId);
  if (taskId) return states.get(taskId);
  // Slow path: scan all states (for events that arrived before task_started)
  let found: SubagentState | undefined;
  states.forEach((s) => {
    if (s.toolUseId === toolUseId) found = s;
  });
  if (found) return found;
  return undefined;
}

// ============================================
// Subagent Stream Event Processing
// ============================================

/**
 * Process a single stream_event for a subagent (called from handleSubagentStreamEvent
 * or when flushing buffered events). Handles thinking, text, and tool_use blocks
 * with their deltas and stops, emitting thoughts/deltas to the frontend.
 */
export function processSubagentStreamEvent(
  state: SubagentState,
  event: any,
  _sdkMessage: any,
  spaceId: string,
  rendererConvId: string,
  sessionState: SessionState,
): void {
  const { streamingBlocks, toolIdToThoughtId, agentId, agentName } = state;
  const blockIndex = event.index ?? 0;

  const workerEmit = (channel: string, data: Record<string, unknown>): void => {
    sendToRenderer(channel, spaceId, rendererConvId, { ...data, agentId, agentName });
  };

  // Thinking block started
  if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
    const thoughtId = `thought-thinking-sub-${state.taskId}-${blockIndex}-${Date.now()}`;
    streamingBlocks.set(blockIndex, { type: 'thinking', thoughtId, content: '' });
    const thought: Thought = {
      id: thoughtId,
      type: 'thinking',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
      agentId,
      agentName,
    };
    workerEmit('agent:thought', { thought });
    return;
  }

  // Thinking delta
  if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
    const blockState = streamingBlocks.get(blockIndex);
    if (blockState && blockState.type === 'thinking') {
      const delta = event.delta.thinking || '';
      blockState.content += delta;
      workerEmit('agent:thought-delta', {
        thoughtId: blockState.thoughtId,
        delta,
        content: blockState.content,
      });
    }
    return;
  }

  // Tool use block started
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const toolId = event.content_block.id || `sub-tool-${Date.now()}`;
    const toolName = event.content_block.name || 'Unknown';
    const thoughtId = `thought-tool-sub-${state.taskId}-${blockIndex}-${Date.now()}`;
    streamingBlocks.set(blockIndex, { type: 'tool_use', thoughtId, content: '', toolName, toolId });
    const thought: Thought = {
      id: thoughtId,
      type: 'tool_use',
      content: '',
      timestamp: new Date().toISOString(),
      toolName,
      toolInput: {},
      isStreaming: true,
      isReady: false,
      agentId,
      agentName,
    };
    workerEmit('agent:thought', { thought });
    return;
  }

  // Tool use input JSON delta
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    const blockState = streamingBlocks.get(blockIndex);
    if (blockState && blockState.type === 'tool_use') {
      blockState.content += event.delta.partial_json || '';
      workerEmit('agent:thought-delta', {
        thoughtId: blockState.thoughtId,
        delta: event.delta.partial_json || '',
        isToolInput: true,
      });
    }
    return;
  }

  // Block stop — persist completed subagent thought to sessionState
  if (event.type === 'content_block_stop') {
    const blockState = streamingBlocks.get(blockIndex);
    if (!blockState) return;

    if (blockState.type === 'thinking') {
      workerEmit('agent:thought-delta', {
        thoughtId: blockState.thoughtId,
        content: blockState.content,
        isComplete: true,
      });
      // Persist completed thinking thought
      sessionState.thoughts.push({
        id: blockState.thoughtId,
        type: 'thinking',
        content: blockState.content,
        timestamp: new Date().toISOString(),
        agentId,
        agentName,
      });
    } else if (blockState.type === 'tool_use') {
      let toolInput: Record<string, unknown> = {};
      try {
        if (blockState.content) toolInput = JSON.parse(blockState.content);
      } catch (e) {
        console.error(`[Subagent] Failed to parse tool input JSON:`, e);
      }
      if (blockState.toolId) {
        toolIdToThoughtId.set(blockState.toolId, blockState.thoughtId);
      }
      workerEmit('agent:thought-delta', {
        thoughtId: blockState.thoughtId,
        toolInput,
        isComplete: true,
        isReady: true,
        isToolInput: true,
      });
      // Persist completed tool_use thought
      sessionState.thoughts.push({
        id: blockState.thoughtId,
        type: 'tool_use',
        content: '',
        timestamp: new Date().toISOString(),
        toolName: blockState.toolName,
        toolInput,
        agentId,
        agentName,
      });
    } else if (blockState.type === 'text') {
      // Persist completed text thought
      sessionState.thoughts.push({
        id: blockState.thoughtId,
        type: 'text',
        content: blockState.content,
        timestamp: new Date().toISOString(),
        agentId,
        agentName,
      });
    }

    streamingBlocks.delete(blockIndex);
    return;
  }

  // Text block started
  if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
    const thoughtId = `thought-text-sub-${state.taskId}-${blockIndex}-${Date.now()}`;
    streamingBlocks.set(blockIndex, {
      type: 'text',
      thoughtId,
      content: event.content_block.text || '',
    });
    const thought: Thought = {
      id: thoughtId,
      type: 'text',
      content: event.content_block.text || '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
      agentId,
      agentName,
    };
    workerEmit('agent:thought', { thought });
    workerEmit('agent:message', {
      type: 'message',
      content: '',
      isComplete: false,
      isStreaming: false,
      isNewTextBlock: true,
    });
    return;
  }

  // Text delta
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    const delta = event.delta.text || '';
    const blockState = streamingBlocks.get(blockIndex);
    if (blockState && blockState.type === 'text') {
      blockState.content += delta;
      workerEmit('agent:thought-delta', {
        thoughtId: blockState.thoughtId,
        delta,
        content: blockState.content,
      });
      workerEmit('agent:message', {
        type: 'message',
        delta,
        isComplete: false,
        isStreaming: true,
      });
    }
    return;
  }
}
