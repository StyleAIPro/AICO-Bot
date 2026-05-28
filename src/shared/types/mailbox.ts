/**
 * Mailbox Types for Multi-Agent Group Chat
 *
 * Provides durable, asynchronous, cross-process messaging between agents.
 * Messages are stored as JSON files on disk, enabling communication even
 * when agents are not actively streaming.
 */

// ============================================
// Message Types
// ============================================

/**
 * All possible mailbox message types.
 * Protocol messages (task_*, permission_*, idle_*, shutdown_*)
 * are handled by specialized logic; chat/direct are user-facing.
 */
export type MailboxMessageType =
  | 'chat' // Group chat message (broadcast)
  | 'direct' // Direct message to a specific agent
  | 'task_assignment' // Task posted to the shared TaskBoard
  | 'task_claimed' // Worker claims a task
  | 'task_progress' // Worker reports intermediate progress
  | 'task_completed' // Worker completes a task
  | 'task_failed' // Worker failed a task
  | 'permission_request' // Worker needs user/leader approval
  | 'permission_response' // Approval/denial response
  | 'idle_notification' // Worker announces it is idle and available
  | 'shutdown_request' // Coordinator asks worker to shut down
  | 'shutdown_approved'; // Worker confirms shutdown

/**
 * Optional payload for structured protocol messages.
 * Not all fields are used by every message type.
 */
export interface MailboxPayload {
  // Task-related fields
  taskId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  requiredCapabilities?: string[];
  title?: string;
  description?: string;

  // Permission-related fields
  toolName?: string;
  toolInput?: Record<string, unknown>;
  approved?: boolean;
  permissionRequestId?: string;

  // Task completion
  result?: string;
  error?: string;

  // Idle notification
  idleReason?: 'available' | 'interrupted' | 'failed';
  completedTaskId?: string;
  completedStatus?: 'completed' | 'failed';
  failureReason?: string;

  // Shutdown
  reason?: string;

  // Target server (for NPU cluster routing)
  targetServerId?: string;
}

/**
 * A message in the mailbox system.
 * Stored as JSON in per-agent mailbox files.
 */
export interface MailboxMessage {
  /** Unique message ID (UUID) */
  id: string;

  /** Message type determining routing and handling */
  type: MailboxMessageType;

  /** Sender agent ID ('user' for messages from the human user) */
  senderId: string;

  /** Human-readable sender name */
  senderName: string;

  /** Recipient agent ID (absent = broadcast to all) */
  recipientId?: string;

  /** Message content (plain text, may contain markdown) */
  content: string;

  /** Unix timestamp in milliseconds */
  timestamp: number;

  /** Type-specific structured payload */
  payload?: MailboxPayload;
}

// ============================================
// Mailbox File Structure
// ============================================

/**
 * On-disk format for a per-agent mailbox file.
 * Each agent has one mailbox file: mailboxes/{agentId}.json
 */
export interface MailboxFile {
  /** Agent ID this mailbox belongs to */
  agentId: string;

  /** Team ID this mailbox belongs to */
  teamId: string;

  /** Read cursor: agent has read up to this message index */
  lastReadIndex: number;

  /** Ordered array of messages */
  messages: MailboxMessage[];
}

// ============================================
// Utility Types
// ============================================

/**
 * Whether a mailbox message is a structured protocol message
 * that should be handled by specialized logic (not shown as chat).
 */
export function isProtocolMessage(msg: MailboxMessage): boolean {
  return (
    msg.type === 'task_assignment' ||
    msg.type === 'task_claimed' ||
    msg.type === 'task_progress' ||
    msg.type === 'task_completed' ||
    msg.type === 'permission_request' ||
    msg.type === 'permission_response' ||
    msg.type === 'idle_notification' ||
    msg.type === 'shutdown_request' ||
    msg.type === 'shutdown_approved'
  );
}

/**
 * Create a new empty mailbox file for an agent.
 */
export function createEmptyMailboxFile(agentId: string, teamId: string): MailboxFile {
  return {
    agentId,
    teamId,
    lastReadIndex: -1,
    messages: [],
  };
}
