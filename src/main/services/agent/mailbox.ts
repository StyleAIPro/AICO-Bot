/**
 * Mailbox Service for Multi-Agent Group Chat
 *
 * Provides durable, file-based messaging between agents.
 * Messages are stored as JSON files in ~/.aico-bot/spaces/{spaceId}/mailboxes/.
 *
 * Uses write-then-rename atomic pattern for writes (safe on NTFS)
 * and a cursor-based polling approach for reads.
 *
 * @module mailbox
 */

import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  renameSync,
  statSync,
} from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getSpacesDir } from '../config.service';
import { createLogger } from '../log';
import type {
  MailboxMessage,
  MailboxFile,
  MailboxMessageType,
  MailboxPayload,
} from '../../../shared/types/mailbox';
import { createEmptyMailboxFile, isProtocolMessage } from '../../../shared/types/mailbox';

const log = createLogger('mailbox');

// ============================================
// Constants
// ============================================

/** Maximum message content size in bytes (100KB) */
const MAX_MAILBOX_MESSAGE_SIZE = 100 * 1024;

/** Maximum injection content size in bytes (200KB — SDK messages need more room) */
export const MAX_INJECTION_CONTENT_SIZE = 200 * 1024;

/** Maximum worker result size in bytes (50KB) */
export const MAX_RESULT_SIZE = 50 * 1024;

/** Maximum number of messages to retain in a mailbox before pruning */
const MAX_MAILBOX_MESSAGES = 100;

/** Number of retry attempts for stale file reads (detects concurrent writes) */
const STALE_READ_RETRIES = 3;

/** Delay between stale read retries (ms) */
const STALE_READ_RETRY_DELAY = 50;

// ============================================
// Mailbox Service
// ============================================

/**
 * Manages file-based mailboxes for agent messaging.
 *
 * Each agent in a Hyper Space has its own mailbox file.
 * Messages are appended atomically and read with a cursor.
 */
export class MailboxService {
  /** Track initialized space IDs to avoid duplicate init */
  private initializedSpaces: Set<string> = new Set();

  /** Track agent IDs per space for broadcast support */
  private spaceAgents: Map<string, Set<string>> = new Map();

  /**
   * Initialize mailboxes for all agents in a team.
   * Creates the mailboxes directory and one file per agent.
   */
  initialize(spaceId: string, teamId: string, agentIds: string[]): void {
    const mailboxesDir = this.getMailboxesDir(spaceId);

    // Create directory if it doesn't exist
    if (!existsSync(mailboxesDir)) {
      mkdirSync(mailboxesDir, { recursive: true });
      log.info(`Created mailboxes directory: ${mailboxesDir}`);
    }

    // Create mailbox file for each agent
    for (const agentId of agentIds) {
      const filePath = this.getMailboxPath(spaceId, agentId);
      if (!existsSync(filePath)) {
        const mailbox = createEmptyMailboxFile(agentId, teamId);
        this.writeMailboxFile(filePath, mailbox);
        log.debug(`Created mailbox for agent: ${agentId}`);
      }
    }

    // Track agents for broadcast support
    this.spaceAgents.set(spaceId, new Set(agentIds));
    this.initializedSpaces.add(spaceId);

    log.info(`Initialized mailboxes for space ${spaceId}: ${agentIds.length} agents`);
  }

  /**
   * Destroy all mailboxes for a space.
   * Removes the entire mailboxes directory.
   */
  destroy(spaceId: string): void {
    const mailboxesDir = this.getMailboxesDir(spaceId);

    try {
      if (existsSync(mailboxesDir)) {
        rmSync(mailboxesDir, { recursive: true, force: true });
        log.info(`Destroyed mailboxes for space: ${spaceId}`);
      }
    } catch (err) {
      log.error(`Failed to destroy mailboxes for space ${spaceId}:`, err);
    }

    this.spaceAgents.delete(spaceId);
    this.initializedSpaces.delete(spaceId);
  }

  /**
   * Post a message to a specific agent's mailbox.
   * Uses atomic write-then-rename pattern with retry for concurrent write detection.
   * Enforces message size limits and auto-prunes old messages.
   */
  postMessage(
    spaceId: string,
    recipientId: string,
    message: Omit<MailboxMessage, 'id' | 'timestamp'>,
  ): string {
    const messageId = uuidv4();
    const fullMessage: MailboxMessage = {
      ...message,
      id: messageId,
      timestamp: Date.now(),
    };

    // Enforce message size limit — truncate content if too large
    this.enforceMessageSize(fullMessage);

    const filePath = this.getMailboxPath(spaceId, recipientId);

    if (!existsSync(filePath)) {
      log.warn(`Mailbox file not found for ${recipientId}, skipping post`);
      return messageId;
    }

    try {
      this.writeMailboxWithRetry(filePath, (mailbox) => {
        mailbox.messages.push(fullMessage);
        this.pruneMessages(mailbox);
      });

      log.debug(`Posted ${message.type} message to ${recipientId}: ${messageId}`);
    } catch (err) {
      log.error(`Failed to post message to ${recipientId}:`, err);
    }

    return messageId;
  }

  /**
   * Broadcast a message to all agents in a space.
   * Optionally excludes one agent (e.g., the sender).
   */
  broadcastMessage(
    spaceId: string,
    message: Omit<MailboxMessage, 'id' | 'timestamp'>,
    excludeAgentId?: string,
  ): string[] {
    const agentIds = this.spaceAgents.get(spaceId);
    if (!agentIds) {
      log.warn(`No agents tracked for space ${spaceId}, cannot broadcast`);
      return [];
    }

    const messageIds: string[] = [];

    for (const agentId of agentIds) {
      if (agentId === excludeAgentId) continue;
      if (agentId === message.senderId) continue; // Don't send to self

      const id = this.postMessage(spaceId, agentId, message);
      messageIds.push(id);
    }

    log.debug(`Broadcast ${message.type} to ${messageIds.length} agents in space ${spaceId}`);
    return messageIds;
  }

  /**
   * Poll for unread messages from an agent's mailbox.
   * Returns messages after the agent's lastReadIndex cursor.
   * Updates the cursor after reading.
   * Throws on mailbox corruption instead of silently returning empty.
   */
  pollMessages(agentId: string, spaceId: string): MailboxMessage[] {
    const filePath = this.getMailboxPath(spaceId, agentId);

    if (!existsSync(filePath)) {
      return [];
    }

    let unread: MailboxMessage[] = [];

    this.writeMailboxWithRetry(filePath, (mailbox) => {
      const startIndex = mailbox.lastReadIndex + 1;

      if (startIndex < mailbox.messages.length) {
        unread = mailbox.messages.slice(startIndex);
        mailbox.lastReadIndex = mailbox.messages.length - 1;
      }
    });

    if (unread.length > 0) {
      log.debug(`${agentId} polled ${unread.length} new messages`);
    }

    return unread;
  }

  /**
   * Check if the mailbox file for an agent is healthy (readable + valid JSON).
   * For use by health check mechanisms.
   */
  isMailboxHealthy(agentId: string, spaceId: string): boolean {
    const filePath = this.getMailboxPath(spaceId, agentId);
    if (!existsSync(filePath)) return true; // Not created yet — not unhealthy

    try {
      this.readMailboxFile(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the count of unread messages for an agent.
   */
  getUnreadCount(agentId: string, spaceId: string): number {
    const filePath = this.getMailboxPath(spaceId, agentId);

    if (!existsSync(filePath)) {
      return 0;
    }

    try {
      const mailbox = this.readMailboxFile(filePath);
      return mailbox.messages.length - 1 - mailbox.lastReadIndex;
    } catch (err) {
      log.error(`Failed to get unread count for ${agentId}:`, err);
      return 0;
    }
  }

  /**
   * Get all messages from an agent's mailbox (for debugging/admin).
   * Does NOT update the read cursor.
   */
  getAllMessages(agentId: string, spaceId: string): MailboxMessage[] {
    const filePath = this.getMailboxPath(spaceId, agentId);

    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const mailbox = this.readMailboxFile(filePath);
      return mailbox.messages;
    } catch (err) {
      log.error(`Failed to read all messages for ${agentId}:`, err);
      return [];
    }
  }

  /**
   * Get all chat-visible messages (non-protocol) from an agent's mailbox.
   */
  getChatMessages(agentId: string, spaceId: string): MailboxMessage[] {
    return this.getAllMessages(agentId, spaceId).filter((msg) => !isProtocolMessage(msg));
  }

  /**
   * Add a new agent to an existing space's mailbox system.
   */
  addAgent(spaceId: string, teamId: string, agentId: string): void {
    const agents = this.spaceAgents.get(spaceId);
    if (agents) {
      agents.add(agentId);
    }

    const filePath = this.getMailboxPath(spaceId, agentId);
    if (!existsSync(filePath)) {
      const mailbox = createEmptyMailboxFile(agentId, teamId);
      this.writeMailboxFile(filePath, mailbox);
      log.info(`Added mailbox for agent: ${agentId} in space ${spaceId}`);
    }
  }

  /**
   * Remove an agent's mailbox from a space.
   */
  removeAgent(spaceId: string, agentId: string): void {
    const agents = this.spaceAgents.get(spaceId);
    if (agents) {
      agents.delete(agentId);
    }

    const filePath = this.getMailboxPath(spaceId, agentId);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        log.info(`Removed mailbox for agent: ${agentId} in space ${spaceId}`);
      }
    } catch (err) {
      log.error(`Failed to remove mailbox for ${agentId}:`, err);
    }
  }

  /**
   * Check if a space's mailbox system is initialized.
   */
  isInitialized(spaceId: string): boolean {
    return this.initializedSpaces.has(spaceId);
  }

  /**
   * Get all agent IDs tracked for a space.
   */
  getAgentIds(spaceId: string): string[] {
    const agents = this.spaceAgents.get(spaceId);
    return agents ? Array.from(agents) : [];
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Get the mailboxes directory path for a space.
   */
  private getMailboxesDir(spaceId: string): string {
    return join(getSpacesDir(), spaceId, 'mailboxes');
  }

  /**
   * Get the mailbox file path for a specific agent.
   */
  private getMailboxPath(spaceId: string, agentId: string): string {
    // Sanitize agentId for use as filename (replace problematic chars)
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return join(this.getMailboxesDir(spaceId), `${safeAgentId}.json`);
  }

  /**
   * Read and parse a mailbox file with error recovery.
   * If JSON parsing fails, tries the .tmp file as a recovery source.
   */
  private readMailboxFile(filePath: string): MailboxFile {
    const raw = readFileSync(filePath, 'utf-8');
    try {
      return JSON.parse(raw) as MailboxFile;
    } catch (parseErr) {
      log.error(`JSON parse error for ${filePath}, attempting recovery from .tmp`);

      // Try recovering from .tmp file (check old naming convention)
      const tmpPath = `${filePath}.tmp`;
      try {
        if (existsSync(tmpPath)) {
          const tmpRaw = readFileSync(tmpPath, 'utf-8');
          const recovered = JSON.parse(tmpRaw) as MailboxFile;
          log.info(`Recovered mailbox from .tmp file for ${filePath}`);
          this.writeMailboxFileAtomic(filePath, recovered);
          unlinkSync(tmpPath);
          return recovered;
        }
      } catch {
        log.error(`Recovery from .tmp also failed for ${filePath}`);
      }

      // Recovery failed — throw with context
      throw new Error(
        `Mailbox file corrupted (${filePath}): ${(parseErr as Error).message}. ` +
          `Manual recovery may be needed.`,
      );
    }
  }

  /**
   * Write a mailbox file atomically using rename.
   * On NTFS, rename within the same directory is atomic.
   */
  private writeMailboxFileAtomic(filePath: string, mailbox: MailboxFile): void {
    const tmpPath = `${filePath}.tmp.${Date.now()}`;

    try {
      writeFileSync(tmpPath, JSON.stringify(mailbox, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {}
      throw err;
    }
  }

  /**
   * Read-modify-write with stale detection.
   * Records the file's mtime before reading; after reading, checks if another
   * process wrote to the file in between. If so, retries.
   */
  private writeMailboxWithRetry(
    filePath: string,
    modifier: (mailbox: MailboxFile) => void,
  ): void {
    for (let attempt = 0; attempt < STALE_READ_RETRIES; attempt++) {
      const mtimeBefore = this.getFileMtime(filePath);
      const mailbox = this.readMailboxFile(filePath);
      const mtimeAfter = this.getFileMtime(filePath);

      if (mtimeAfter !== mtimeBefore) {
        if (attempt < STALE_READ_RETRIES - 1) {
          log.warn(`Detected concurrent write to ${filePath}, retrying (${attempt + 1}/${STALE_READ_RETRIES})`);
          // Brief delay to let the other writer finish
          const start = Date.now();
          while (Date.now() - start < STALE_READ_RETRY_DELAY) { /* spin */ }
          continue;
        }
        log.warn(`Concurrent write detected on ${filePath}, proceeding with last read`);
      }

      modifier(mailbox);
      this.writeMailboxFileAtomic(filePath, mailbox);
      return;
    }
  }

  /**
   * Get file modification time, or 0 if file doesn't exist.
   */
  private getFileMtime(filePath: string): number {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Truncate message content if it exceeds the size limit.
   */
  private enforceMessageSize(message: MailboxMessage): void {
    const contentSize = Buffer.byteLength(message.content || '', 'utf-8');
    if (contentSize > MAX_MAILBOX_MESSAGE_SIZE) {
      log.warn(
        `Message to ${message.recipientId || '?'} too large (${contentSize} bytes), truncating`,
      );
      message.content =
        (message.content || '').slice(0, MAX_MAILBOX_MESSAGE_SIZE) +
        `\n\n[... truncated, original size: ${contentSize} bytes]`;
    }
  }

  /**
   * Prune old messages from mailbox, keeping the most recent ones.
   * Updates lastReadIndex to avoid pointing to deleted messages.
   */
  private pruneMessages(mailbox: MailboxFile): void {
    if (mailbox.messages.length <= MAX_MAILBOX_MESSAGES) return;

    const pruneCount = mailbox.messages.length - MAX_MAILBOX_MESSAGES;
    const removedStart = mailbox.messages.length - MAX_MAILBOX_MESSAGES;

    log.debug(
      `Pruning ${pruneCount} old messages from mailbox (total was ${mailbox.messages.length})`,
    );

    mailbox.messages.splice(0, pruneCount);

    // Adjust cursor so it doesn't point past the new array bounds
    // or into the deleted region
    if (mailbox.lastReadIndex >= mailbox.messages.length) {
      mailbox.lastReadIndex = mailbox.messages.length - 1;
    } else if (mailbox.lastReadIndex < removedStart) {
      // Cursor was in the deleted region — point to the first remaining message
      mailbox.lastReadIndex = 0;
    }
  }

  /**
   * Manually compact a mailbox (for admin/debug use).
   */
  compactMailbox(agentId: string, spaceId: string): number {
    const filePath = this.getMailboxPath(spaceId, agentId);
    if (!existsSync(filePath)) return 0;

    let prunedCount = 0;
    this.writeMailboxWithRetry(filePath, (mailbox) => {
      const before = mailbox.messages.length;
      this.pruneMessages(mailbox);
      prunedCount = before - mailbox.messages.length;
    });

    if (prunedCount > 0) {
      log.info(`Compacted mailbox for ${agentId}: pruned ${prunedCount} messages`);
    }
    return prunedCount;
  }

  /**
   * Write a mailbox file (non-atomic, for initial creation).
   */
  private writeMailboxFile(filePath: string, mailbox: MailboxFile): void {
    writeFileSync(filePath, JSON.stringify(mailbox, null, 2), 'utf-8');
  }

}

// ============================================
// Singleton Export
// ============================================

/** Global mailbox service instance */
export const mailboxService = new MailboxService();
