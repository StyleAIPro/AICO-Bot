/**
 * Agent Module - Turn-Level Message Injection
 *
 * Manages the message injection queue for turn-level continuation.
 * When user sends a message during generation, it's stored here
 * and will be sent after the current stream completes.
 */

import { MAX_INJECTION_CONTENT_SIZE } from './mailbox';

// ============================================
// Constants
// ============================================

/** Maximum number of pending injections per conversation (FIFO eviction beyond this) */
const MAX_QUEUE_SIZE_PER_CONVERSATION = 30;

/** Injections older than this are discarded on dequeue (milliseconds) */
const INJECTION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ============================================
// Types
// ============================================

/**
 * Pending injection message for turn-level continuation.
 * When user sends a message during generation, it's stored here
 * and will be sent after the current stream completes.
 */
export interface PendingInjection {
  content: string;
  images?: Array<{ type: string; data: string; mediaType: string }>;
  thinkingEnabled?: boolean;
  aiBrowserEnabled?: boolean;
  /** Timestamp when this injection was queued (for TTL expiry) */
  queuedAt: number;
}

export interface QueueInjectionOptions {
  content: string;
  images?: Array<{ type: string; data: string; mediaType: string }>;
  thinkingEnabled?: boolean;
  aiBrowserEnabled?: boolean;
}

// ============================================
// Injection Queue State
// ============================================

// Map: conversationId -> PendingInjection[] (queue to prevent message loss from concurrent workers)
const pendingInjectionQueues = new Map<string, PendingInjection[]>();

// ============================================
// Injection Queue Functions
// ============================================

/**
 * Truncate content if it exceeds the maximum injection size.
 */
function truncateIfNeeded(content: string): string {
  const size = Buffer.byteLength(content, 'utf-8');
  if (size > MAX_INJECTION_CONTENT_SIZE) {
    console.warn(
      `[Agent] Injection content too large (${size} bytes, limit ${MAX_INJECTION_CONTENT_SIZE}), truncating`,
    );
    return (
      content.slice(0, MAX_INJECTION_CONTENT_SIZE) +
      `\n\n[... truncated, original size: ${size} bytes]`
    );
  }
  return content;
}

/**
 * Queue a message for turn-level injection.
 * Supports multiple pending injections per conversation (e.g., from concurrent workers).
 * Enforces capacity limit (MAX_QUEUE_SIZE_PER_CONVERSATION) with FIFO eviction.
 */
export function queueInjection(conversationId: string, options: QueueInjectionOptions): void {
  const queue = pendingInjectionQueues.get(conversationId) || [];
  queue.push({
    content: truncateIfNeeded(options.content),
    images: options.images,
    thinkingEnabled: options.thinkingEnabled,
    aiBrowserEnabled: options.aiBrowserEnabled,
    queuedAt: Date.now(),
  });

  // Enforce capacity limit: discard oldest messages beyond the limit
  if (queue.length > MAX_QUEUE_SIZE_PER_CONVERSATION) {
    const evicted = queue.splice(0, queue.length - MAX_QUEUE_SIZE_PER_CONVERSATION);
    console.warn(
      `[Agent][${conversationId}] Injection queue exceeded ${MAX_QUEUE_SIZE_PER_CONVERSATION}, evicted ${evicted.length} oldest message(s)`,
    );
  }

  pendingInjectionQueues.set(conversationId, queue);
  console.log(
    `[Agent][${conversationId}] Queued injection message (queue size: ${queue.length}): ${options.content.slice(0, 50)}...`,
  );
}

/**
 * Dequeue the next pending injection for a conversation.
 * Returns the first non-expired item, or undefined if empty/all expired.
 * Expired injections (older than INJECTION_TTL_MS) are silently discarded.
 */
export function getAndClearInjection(conversationId: string): PendingInjection | undefined {
  const queue = pendingInjectionQueues.get(conversationId);
  if (!queue || queue.length === 0) return undefined;

  // Drain expired entries from the front of the queue
  const now = Date.now();
  let expired = 0;
  while (queue.length > 0 && now - queue[0].queuedAt > INJECTION_TTL_MS) {
    queue.shift();
    expired++;
  }
  if (expired > 0) {
    console.log(
      `[Agent][${conversationId}] Discarded ${expired} expired injection(s) (TTL: ${INJECTION_TTL_MS / 1000}s)`,
    );
  }

  if (queue.length === 0) {
    pendingInjectionQueues.delete(conversationId);
    return undefined;
  }

  const injection = queue.shift()!;
  if (queue.length === 0) {
    pendingInjectionQueues.delete(conversationId);
  }
  console.log(`[Agent][${conversationId}] Dequeued injection (remaining: ${queue.length})`);
  return injection;
}

/**
 * Check if there's a pending injection for a conversation.
 */
export function hasPendingInjection(conversationId: string): boolean {
  const queue = pendingInjectionQueues.get(conversationId);
  return queue !== undefined && queue.length > 0;
}

/**
 * Clear all pending injections for a conversation (e.g., on team destroy or error).
 */
export function clearInjectionsForConversation(conversationId: string): number {
  const queue = pendingInjectionQueues.get(conversationId);
  if (!queue) return 0;
  const count = queue.length;
  pendingInjectionQueues.delete(conversationId);
  console.log(`[Agent][${conversationId}] Cleared ${count} pending injection(s)`);
  return count;
}

/**
 * Purge expired injections for a conversation without dequeuing.
 * Returns the number of purged entries.
 */
export function purgeExpiredInjections(conversationId: string): number {
  const queue = pendingInjectionQueues.get(conversationId);
  if (!queue || queue.length === 0) return 0;

  const now = Date.now();
  const before = queue.length;
  // Remove expired from front (queue is ordered by insertion time)
  while (queue.length > 0 && now - queue[0].queuedAt > INJECTION_TTL_MS) {
    queue.shift();
  }
  const purged = before - queue.length;
  if (queue.length === 0) {
    pendingInjectionQueues.delete(conversationId);
  }
  if (purged > 0) {
    console.log(`[Agent][${conversationId}] Purged ${purged} expired injection(s)`);
  }
  return purged;
}

/**
 * Clear all pending injections across all conversations (e.g., on orchestrator destroy).
 */
export function clearAllInjections(): void {
  const total = Array.from(pendingInjectionQueues.values()).reduce((sum, q) => sum + q.length, 0);
  pendingInjectionQueues.clear();
  if (total > 0) {
    console.log(`[Agent] Cleared all injections across all conversations (${total} total)`);
  }
}
