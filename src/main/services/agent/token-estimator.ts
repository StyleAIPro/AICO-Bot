/**
 * Agent Module - Token Estimator (Main Process)
 *
 * Provides context token estimation for the main process:
 * - Pre-send estimation: estimate context tokens before sending to API
 * - Event builder: construct agent:context-usage events with estimated data
 * - Dynamic system prompt estimation: accounts for actual system prompt length
 */

import { estimateTokenCount } from '../../../shared/utils/token-estimator';
import { getConversation } from '../conversation.service';
import { buildSystemPrompt, PRE_APPROVED_TOOLS, type SystemPromptContext } from './system-prompt';

const SYSTEM_PROMPT_OVERHEAD = 3000;

/** SDK 内置 claude_code 预设的估算 token 数（skills、tool schemas 等） */
const SDK_PRESET_OVERHEAD = 2000;
/** 每个内置工具定义的估算 token 数 */
const BUILTIN_TOOL_TOKENS = 200;
/** 每个 MCP 工具定义的估算 token 数 */
const MCP_TOOL_TOKENS = 350;
/** AI Browser 提示的估算 token 数 */
const AI_BROWSER_OVERHEAD = 1500;
/** 项目配置（CLAUDE.md 等）的估算 token 数 */
const PROJECT_CONFIG_OVERHEAD = 1000;

/**
 * 估算当前系统提示的实际 token 数
 *
 * 包含：buildSystemPrompt() 输出、SDK 内置预设、工具定义、MCP 工具、项目配置
 */
export function estimateSystemPromptTokens(
  context: SystemPromptContext,
  mcpToolCount: number,
  hasAIBrowser: boolean,
): number {
  const systemPrompt = buildSystemPrompt(context);
  let tokens = estimateTokenCount(systemPrompt);
  tokens += SDK_PRESET_OVERHEAD;

  if (hasAIBrowser) {
    tokens += AI_BROWSER_OVERHEAD;
  }

  tokens += PRE_APPROVED_TOOLS.length * BUILTIN_TOOL_TOKENS;
  tokens += mcpToolCount * MCP_TOOL_TOKENS;
  tokens += PROJECT_CONFIG_OVERHEAD;

  return tokens;
}

export function estimateContextTokens(
  spaceId: string,
  conversationId: string,
  systemPromptTokens?: number,
): number {
  const conversation = getConversation(spaceId, conversationId);
  if (!conversation) return systemPromptTokens ?? SYSTEM_PROMPT_OVERHEAD;

  const messages = conversation.messages || [];
  let totalTokens = systemPromptTokens ?? SYSTEM_PROMPT_OVERHEAD;

  for (const msg of messages) {
    totalTokens += 4;
    totalTokens += estimateTokenCount(msg.content || '');

    if (msg.thoughts && Array.isArray(msg.thoughts)) {
      for (const thought of msg.thoughts) {
        if (thought.content) {
          totalTokens += estimateTokenCount(thought.content);
        }
        if (thought.toolOutput) {
          totalTokens += estimateTokenCount(thought.toolOutput);
        }
      }
    }
  }

  return totalTokens;
}

export function buildEstimatedContextUsage(
  estimatedTokens: number,
  contextWindow: number,
): Record<string, unknown> {
  return {
    type: 'context-usage',
    isEstimate: true as const,
    estimatedTokens,
    inputTokens: estimatedTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow,
  };
}
