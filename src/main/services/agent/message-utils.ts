/**
 * Agent Module - Message Utilities
 *
 * Utilities for building and parsing messages including:
 * - Multi-modal message construction (text + images)
 * - Canvas context formatting
 * - SDK message parsing into Thought objects
 */

import type { Thought, ImageAttachment, CanvasContext } from './types';

// ============================================
// Safe JSON Serialization
// ============================================

/**
 * JSON.stringify with circular reference protection.
 * Used when serializing SDK objects that may contain unserializable values.
 */
export function safeJsonStringify(obj: unknown, indent?: number): string {
  try {
    return JSON.stringify(obj, null, indent);
  } catch {
    return JSON.stringify(
      obj,
      (_, value) => {
        if (typeof value === 'object' && value !== null) {
          return '[Circular or unserializable]';
        }
        return value;
      },
      indent,
    );
  }
}

// ============================================
// Canvas Context Formatting
// ============================================

/**
 * Format Canvas Context for injection into user message
 * Returns empty string if no meaningful context to inject
 *
 * This provides AI awareness of what the user is currently viewing
 * in the content canvas (tabs, files, URLs, etc.)
 */
export function formatCanvasContext(canvasContext?: CanvasContext): string {
  if (!canvasContext?.isOpen || canvasContext.tabCount === 0) {
    return '';
  }

  const activeTab = canvasContext.activeTab;
  const tabsSummary = canvasContext.tabs
    .map(
      (t) =>
        `${t.isActive ? '▶ ' : '  '}${t.title} (${t.type})${t.path ? ` - ${t.path}` : ''}${t.url ? ` - ${t.url}` : ''}`,
    )
    .join('\n');

  return `<aico_bot_canvas>
Content canvas currently open in AICO-Bot:
- Total ${canvasContext.tabCount} tabs
- Active: ${activeTab ? `${activeTab.title} (${activeTab.type})` : 'None'}
${activeTab?.url ? `- URL: ${activeTab.url}` : ''}${activeTab?.path ? `- File path: ${activeTab.path}` : ''}

All tabs:
${tabsSummary}
</aico_bot_canvas>

`;
}

// ============================================
// Multi-Modal Message Building
// ============================================

/**
 * Build multi-modal message content for Claude API
 *
 * @param text - Text content of the message
 * @param images - Optional image attachments (can be base64 or URL)
 * @returns Plain text string or array of content blocks for multi-modal
 */
export function buildMessageContent(
  text: string,
  images?: (ImageAttachment | { id: string; url: string; mediaType: string })[],
): string | Array<{ type: string; [key: string]: unknown }> {
  // If no images, just return plain text
  if (!images || images.length === 0) {
    return text;
  }

  // Build content blocks array for multi-modal message
  const contentBlocks: Array<{ type: string; [key: string]: unknown }> = [];

  // Add text block first (if there's text)
  if (text.trim()) {
    contentBlocks.push({
      type: 'text',
      text: text,
    });
  }

  // Add image blocks
  for (const image of images) {
    // Check if this is an uploaded image (has URL) or base64 image
    if ('url' in image && image.url) {
      // Use URL format for images that have been uploaded
      // Check if it's a data URL or HTTP URL
      if (
        image.url.startsWith('data:') ||
        image.url.startsWith('http://') ||
        image.url.startsWith('https://')
      ) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: image.url,
          },
        });
      } else if (image.url.startsWith('file://')) {
        // File URL - use base64 fallback if we have the data
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: (image as any).data || '', // Fallback, should have data if file://
          },
        });
      }
    } else if ('data' in image && image.data) {
      // Original base64 format
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data,
        },
      });
    }
  }

  return contentBlocks;
}

// ============================================
// SDK Message Parsing
// ============================================

/**
 * Generate a unique thought ID
 */
function generateThoughtId(): string {
  return `thought-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Parse SDK message into Thought object(s)
 *
 * @param message - Raw SDK message
 * @param displayModel - The actual model name to display (user-configured model, not SDK's internal model)
 * @param hasStreamEvent - Whether any stream_event was received for this response
 *                         If true, thinking/tool_use blocks are skipped (already handled via streaming)
 *                         If false, thinking/tool_use blocks are processed as fallback
 * @returns Array of Thought objects (may be empty if no relevant content)
 */
export function parseSDKMessage(
  message: any,
  displayModel?: string,
  hasStreamEvent = false,
): Thought[] {
  const timestamp = new Date().toISOString();
  const thoughts: Thought[] = [];

  // System initialization
  if (message.type === 'system') {
    if (message.subtype === 'init') {
      // Use displayModel (user's configured model) instead of SDK's internal model
      // This ensures users see the actual model they configured, not the spoofed Claude model
      const modelName = displayModel || message.model || 'claude';
      thoughts.push({
        id: generateThoughtId(),
        type: 'system',
        content: `Connected | Model: ${modelName}`,
        timestamp,
      });
      return thoughts;
    }
    return thoughts; // Empty array
  }

  // Assistant messages (thinking, tool_use, text blocks)
  if (message.type === 'assistant') {
    // When SDK reports an error on assistant message, skip it — the subsequent result message
    // (is_error=true) is the authoritative error source and will create the error thought.
    // This avoids duplicate error entries in the thinking timeline.
    if (message.error) {
      console.log(
        `[parseSDKMessage] SDK assistant error: ${message.error}, skipping (handled by result message)`,
      );
      return thoughts; // Empty array
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        // Thinking blocks - SKIP if stream_event was received (already handled via streaming)
        // If no stream_event was received (e.g., resume session mode), process as fallback
        if (block.type === 'thinking') {
          if (hasStreamEvent) {
            continue; // Already handled via stream_event
          }
          // Fallback: create thinking thought from complete message
          // This happens when SDK doesn't send stream_event (e.g., session resume)
          thoughts.push({
            id: generateThoughtId(),
            type: 'thinking',
            content: block.thinking || '',
            timestamp,
          });
          continue;
        }
        // Tool use blocks - SKIP if stream_event was received (already handled via streaming)
        if (block.type === 'tool_use') {
          if (hasStreamEvent) {
            continue; // Already handled via stream_event
          }
          // Fallback: create tool_use thought from complete message
          thoughts.push({
            id: block.id || generateThoughtId(),
            type: 'tool_use',
            content: '',
            timestamp,
            toolName: block.name || 'Unknown',
            toolInput: block.input || {},
            isStreaming: false,
            isReady: true,
          });
          continue;
        }
        // Text blocks - send to timeline for AI intermediate responses display
        // Skip if stream_event was received (already handled via streaming, same as thinking/tool_use)
        if (block.type === 'text') {
          if (hasStreamEvent) {
            continue; // Already handled via stream_event
          }
          if (block.text) {
            thoughts.push({
              id: generateThoughtId(),
              type: 'text',
              content: block.text,
              timestamp,
            });
          }
        }
      }
    }
    return thoughts;
  }

  // User messages (tool results or command output)
  if (message.type === 'user') {
    const content = message.message?.content;

    // Handle slash command output: <local-command-stdout>...</local-command-stdout>
    // These are returned as user messages with isReplay: true
    if (typeof content === 'string') {
      const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (match) {
        thoughts.push({
          id: generateThoughtId(),
          type: 'text', // Render as text block (will show in assistant bubble)
          content: match[1].trim(),
          timestamp,
        });
        return thoughts;
      }
    }

    // Handle tool results (array content)
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const isError = block.is_error || false;
          const resultContent =
            typeof block.content === 'string' ? block.content : safeJsonStringify(block.content);

          thoughts.push({
            id: block.tool_use_id || generateThoughtId(),
            type: 'tool_result',
            content: isError ? `Tool execution failed` : `Tool execution succeeded`,
            timestamp,
            toolOutput: resultContent,
            isError,
          });
        }
      }
    }
    return thoughts;
  }

  // Final result
  // Simple approach: always use message.result regardless of is_error
  // The result field contains the actual content (success message or error details)
  if (message.type === 'result') {
    const resultContent = message.message?.result || message.result || '';
    const isError = message.is_error || false;

    if (isError) {
      console.log(
        `[parseSDKMessage] SDK result error: subtype=${message.subtype}, result=${resultContent.substring(0, 200)}`,
      );
    }

    thoughts.push({
      id: generateThoughtId(),
      type: isError ? 'error' : 'result',
      content: resultContent,
      timestamp,
      isError,
      errorCode: isError ? message.subtype : undefined,
      duration: message.duration_ms,
    });
  }

  return thoughts;
}

// ============================================
// Token Usage Extraction
// ============================================

/**
 * Extract single API call usage from assistant message
 */
export function extractSingleUsage(assistantMsg: any): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} | null {
  const msgUsage = assistantMsg.message?.usage;
  if (!msgUsage) return null;

  return {
    inputTokens: msgUsage.input_tokens || 0,
    outputTokens: msgUsage.output_tokens || 0,
    cacheReadTokens: msgUsage.cache_read_input_tokens || 0,
    cacheCreationTokens: msgUsage.cache_creation_input_tokens || 0,
  };
}

/**
 * Extract token usage from result message
 * @param configuredContextWindow - User-configured context window from AI source settings.
 *   Takes highest priority. If not set, SDK's modelUsage.contextWindow is used. Falls back to 200K.
 */
export function extractResultUsage(
  resultMsg: any,
  lastSingleUsage: ReturnType<typeof extractSingleUsage>,
  configuredContextWindow?: number,
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  contextWindow: number;
} | null {
  const modelUsage = resultMsg.modelUsage as Record<string, { contextWindow?: number }> | undefined;
  const totalCostUsd = resultMsg.total_cost_usd as number | undefined;

  // Priority: user-configured > SDK modelUsage.contextWindow > 200K fallback
  const sdkContextWindow = modelUsage
    ? Object.values(modelUsage)[0]?.contextWindow
    : undefined;
  const contextWindow = configuredContextWindow ?? sdkContextWindow ?? 200000;

  // Use last API call usage (single) + cumulative cost
  if (lastSingleUsage) {
    return {
      ...lastSingleUsage,
      totalCostUsd: totalCostUsd || 0,
      contextWindow,
    };
  }

  // Fallback: If no assistant message, use result.usage (cumulative, less accurate but has data)
  const usage = resultMsg.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;

  if (usage) {
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      totalCostUsd: totalCostUsd || 0,
      contextWindow,
    };
  }

  return null;
}
