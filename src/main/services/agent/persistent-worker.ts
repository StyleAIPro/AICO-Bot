/**
 * Persistent Worker Loop for Multi-Agent Group Chat
 *
 * Transforms workers from task-scoped (one task then exit) to persistent
 * (continuous loop, poll for messages/tasks from mailbox and TaskBoard).
 *
 * The worker stays alive between tasks, auto-claims from the TaskBoard,
 * responds to chat messages, and notifies when idle.
 *
 * @module persistent-worker
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../log';
import type { MailboxMessage } from '../../../shared/types/mailbox';
import type { TaskBoardTask } from '../../../shared/types/taskboard';
import { mailboxService } from './mailbox';
import { taskboardService } from './taskboard';
import type { AgentInstance, AgentTeam } from './orchestrator';

const log = createLogger('persistent-worker');

// ============================================
// Configuration
// ============================================

/** Default polling interval in milliseconds */
const DEFAULT_POLL_INTERVAL = 3000;

/** Maximum wait time for new messages before re-checking TaskBoard */
const MAX_IDLE_WAIT = 30000;

/** Shutdown timeout: how long to wait for worker to confirm shutdown */
const SHUTDOWN_TIMEOUT = 30000;

// ============================================
// Persistent Worker Loop
// ============================================

export interface PersistentWorkerConfig {
  /** Polling interval for mailbox messages (ms) */
  pollInterval?: number;

  /** Whether to auto-claim tasks from TaskBoard when idle */
  autoClaimTasks?: boolean;
}

/**
 * A persistent worker that runs a continuous loop.
 * Unlike task-scoped workers, this worker stays alive between tasks,
 * polls the mailbox for new messages, and auto-claims tasks from the TaskBoard.
 */
export class PersistentWorkerLoop {
  private running = false;
  private shutdownRequested = false;
  private workerAbortController: AbortController | null = null;

  constructor(
    private agent: AgentInstance,
    private team: AgentTeam,
    private config: PersistentWorkerConfig = {},
  ) {}

  /**
   * Start the persistent worker loop.
   * This is an async fire-and-forget call — it returns immediately
   * and the loop runs in the background.
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn(`Worker ${this.agent.id} is already running`);
      return;
    }

    this.running = true;
    this.shutdownRequested = false;
    this.workerAbortController = new AbortController();
    this.agent.status = 'running';

    log.info(`Starting persistent worker: ${this.agent.config.name || this.agent.id}`);

    // Run the main loop (don't await — fire and forget)
    this.mainLoop().catch((err) => {
      if (!this.shutdownRequested) {
        log.error(`Persistent worker ${this.agent.id} crashed:`, err);
        this.agent.status = 'error';
      }
    });
  }

  /**
   * Gracefully stop the persistent worker.
   * Posts a shutdown request and waits for confirmation.
   */
  async stop(timeout: number = SHUTDOWN_TIMEOUT): Promise<void> {
    if (!this.running) return;

    log.info(`Requesting shutdown for worker: ${this.agent.id}`);
    this.shutdownRequested = true;

    // Post shutdown request to worker's mailbox
    mailboxService.postMessage(this.team.spaceId, this.agent.id, {
      type: 'shutdown_request',
      senderId: 'orchestrator',
      senderName: 'Orchestrator',
      content: 'Please shut down gracefully. Save any work and confirm.',
      payload: { reason: 'Team is being destroyed' },
    });

    // Abort any active session
    if (this.workerAbortController) {
      this.workerAbortController.abort();
    }

    // Wait for the loop to finish naturally
    const startTime = Date.now();
    while (this.running && Date.now() - startTime < timeout) {
      await this.sleep(500);
    }

    if (this.running) {
      log.warn(`Worker ${this.agent.id} did not shut down within ${timeout}ms, forcing stop`);
      this.running = false;
    }

    this.agent.status = 'idle';
    log.info(`Worker ${this.agent.id} stopped`);
  }

  /**
   * Check if the worker is currently running.
   */
  isActive(): boolean {
    return this.running && !this.shutdownRequested;
  }

  // ============================================
  // Main Loop
  // ============================================

  private async mainLoop(): Promise<void> {
    const pollInterval = this.config.pollInterval || DEFAULT_POLL_INTERVAL;
    const autoClaim = this.config.autoClaimTasks !== false; // default true
    let healthCheckCounter = 0;
    const HEALTH_CHECK_INTERVAL = 10; // Check mailbox health every N poll cycles (~30s)

    // Send initial idle notification
    this.notifyIdle('available');

    while (!this.shutdownRequested) {
      try {
        // Step 1: Poll mailbox for new messages
        let messages: MailboxMessage[] = [];
        try {
          messages = mailboxService.pollMessages(this.agent.id, this.team.spaceId);
        } catch (pollErr) {
          log.error(
            `Worker ${this.agent.id}: mailbox poll failed, may be corrupted`,
            pollErr,
          );
          // Continue loop — don't crash the worker on mailbox errors
        }

        // Step 1b: Periodic mailbox health check
        healthCheckCounter++;
        if (healthCheckCounter >= HEALTH_CHECK_INTERVAL) {
          healthCheckCounter = 0;
          if (!mailboxService.isMailboxHealthy(this.agent.id, this.team.spaceId)) {
            log.error(
              `Worker ${this.agent.id}: mailbox file is corrupted! ` +
                `Messages may be lost. Manual intervention may be required.`,
            );
          }
        }

        if (messages.length > 0) {
          // Process each message
          for (const msg of messages) {
            if (this.shutdownRequested) break;

            const handled = await this.handleMessage(msg);
            if (!handled) {
              log.debug(`Worker ${this.agent.id}: unhandled message type: ${msg.type}`);
            }
          }

          // If we processed messages, continue immediately (don't wait)
          continue;
        }

        // Step 2: Auto-claim tasks from TaskBoard when idle
        if (autoClaim && this.agent.status === 'idle') {
          const claimedTask = this.tryClaimTask();
          if (claimedTask) {
            log.info(`Worker ${this.agent.id} auto-claimed task: "${claimedTask.title}"`);
            // Execute the claimed task
            await this.executeTask(claimedTask);
            continue;
          }
        }

        // Step 3: No messages, no tasks — idle wait
        if (this.agent.status !== 'idle') {
          this.agent.status = 'idle';
          this.notifyIdle('available');
        }

        // Wait before next poll cycle
        await this.sleep(pollInterval);
      } catch (err) {
        if (this.shutdownRequested) break;
        log.error(`Persistent worker ${this.agent.id} loop error:`, err);
        await this.sleep(pollInterval * 2); // Back off on error
      }
    }

    // Post shutdown confirmation
    mailboxService.postMessage(this.team.spaceId, this.team.leader.id, {
      type: 'shutdown_approved',
      senderId: this.agent.id,
      senderName: this.agent.config.name || this.agent.id,
      content: `Worker ${this.agent.config.name || this.agent.id} has shut down.`,
    });

    this.running = false;
    this.agent.status = 'idle';
    log.info(`Persistent worker ${this.agent.id} exited main loop`);
  }

  // ============================================
  // Message Handling
  // ============================================

  /**
   * Handle a single mailbox message.
   * Returns true if the message was handled.
   */
  private async handleMessage(msg: MailboxMessage): Promise<boolean> {
    log.debug(`Worker ${this.agent.id} received: ${msg.type} from ${msg.senderName}`);

    switch (msg.type) {
      case 'chat':
      case 'direct':
        // A chat message addressed to this worker — execute it
        if (msg.recipientId && msg.recipientId !== this.agent.id) {
          return false; // Not for us
        }
        this.agent.status = 'running';
        await this.executeTask({
          id: uuidv4(),
          title: `Message from ${msg.senderName}`,
          description: msg.content,
          status: 'in_progress',
          priority: 'normal',
          requiredCapabilities: [],
          postedBy: msg.senderId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          retryCount: 0,
          maxRetries: 0,
          parentConversationId: this.team.conversationId,
        });
        return true;

      case 'task_assignment':
        // A task posted to the TaskBoard that matches our capabilities
        if (msg.payload?.taskId) {
          const task = taskboardService.claimTask(
            msg.payload.taskId,
            this.agent.id,
            this.agent.config.name,
            this.team.spaceId,
          );
          if (task) {
            await this.executeTask(task);
            return true;
          }
        }
        return false;

      case 'shutdown_request':
        // Graceful shutdown requested
        log.info(`Worker ${this.agent.id}: shutdown requested`);
        this.shutdownRequested = true;
        return true;

      case 'permission_response':
        // Handled by the permission forwarder — not processed here
        return false;

      default:
        return false;
    }
  }

  // ============================================
  // Task Execution
  // ============================================

  /**
   * Execute a task using the orchestrator's executeOnSingleAgent.
   * This delegates to the existing agent execution infrastructure.
   */
  private async executeTask(task: TaskBoardTask): Promise<void> {
    this.agent.status = 'running';
    this.agent.currentTaskId = task.id;

    // Update TaskBoard status
    taskboardService.updateTaskStatus(
      task.id,
      'in_progress',
      undefined,
      undefined,
      this.team.spaceId,
    );

    try {
      // Delegate to orchestrator's existing execution method
      const { agentOrchestrator } = await import('./orchestrator');
      const orchestrator = agentOrchestrator;

      await orchestrator.executeOnSingleAgent({
        team: this.team,
        agent: this.agent,
        task: task.description,
        conversationId: this.team.conversationId,
      });

      // Mark task as completed
      taskboardService.updateTaskStatus(
        task.id,
        'completed',
        'Task completed by worker',
        undefined,
        this.team.spaceId,
      );

      // Broadcast completion to mailbox
      mailboxService.broadcastMessage(
        this.team.spaceId,
        {
          type: 'task_completed',
          senderId: this.agent.id,
          senderName: this.agent.config.name || this.agent.id,
          content: `Completed task: "${task.title}"`,
          payload: { taskId: task.id },
        },
        this.agent.id,
      );

      log.info(`Worker ${this.agent.id} completed task: "${task.title}"`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Mark task as failed
      taskboardService.updateTaskStatus(task.id, 'failed', undefined, errorMsg, this.team.spaceId);

      // Broadcast failure
      mailboxService.broadcastMessage(
        this.team.spaceId,
        {
          type: 'task_completed',
          senderId: this.agent.id,
          senderName: this.agent.config.name || this.agent.id,
          content: `Failed task: "${task.title}" - ${errorMsg}`,
          payload: { taskId: task.id, error: errorMsg },
        },
        this.agent.id,
      );

      log.error(`Worker ${this.agent.id} failed task "${task.title}":`, error);
    } finally {
      this.agent.status = 'idle';
      this.agent.currentTaskId = undefined;
      this.notifyIdle('available');
    }
  }

  // ============================================
  // Task Board Integration
  // ============================================

  /**
   * Try to claim an unclaimed task from the TaskBoard.
   * Returns the claimed task or null if no suitable task found.
   */
  private tryClaimTask(): TaskBoardTask | null {
    try {
      const unclaimed = taskboardService.getUnclaimedTasks(this.team.spaceId);
      if (unclaimed.length === 0) return null;

      // Filter by our capabilities
      const agentCaps = this.agent.config.capabilities || [];
      let candidates = unclaimed;

      if (unclaimed.some((t) => t.requiredCapabilities.length > 0)) {
        // Only filter by capabilities if at least one task has requirements
        candidates = unclaimed.filter((t) => {
          if (t.requiredCapabilities.length === 0) return true;
          return t.requiredCapabilities.every((cap) =>
            agentCaps.some((ac) => ac.toLowerCase() === cap.toLowerCase()),
          );
        });
      }

      // Prefer high priority tasks
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      candidates.sort(
        (a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2),
      );

      // Claim the first candidate
      if (candidates.length > 0) {
        const task = candidates[0];
        return taskboardService.claimTask(
          task.id,
          this.agent.id,
          this.agent.config.name,
          this.team.spaceId,
        );
      }

      return null;
    } catch (err) {
      log.error(`Worker ${this.agent.id}: error checking TaskBoard:`, err);
      return null;
    }
  }

  // ============================================
  // Helpers
  // ============================================

  /**
   * Post an idle notification to the team mailbox.
   */
  private notifyIdle(reason: 'available' | 'interrupted' | 'failed'): void {
    try {
      mailboxService.broadcastMessage(
        this.team.spaceId,
        {
          type: 'idle_notification',
          senderId: this.agent.id,
          senderName: this.agent.config.name || this.agent.id,
          content: `Worker ${this.agent.config.name || this.agent.id} is now idle and available for tasks.`,
          payload: {
            idleReason: reason,
            capabilities: this.agent.config.capabilities,
          },
        },
        this.agent.id, // Don't send to self
      );
    } catch (err) {
      log.error(`Worker ${this.agent.id}: error posting idle notification:`, err);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
