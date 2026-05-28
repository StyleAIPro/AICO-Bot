/**
 * Agent Orchestrator Service for Hyper Space
 *
 * Inspired by OpenClaw's subagent system, this service handles:
 * - Multi-agent team management
 * - Task distribution and routing
 * - Result aggregation
 * - Completion announcements
 *
 * @module orchestrator
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../log';

const log = createLogger('orchestrator');
import type {
  AgentConfig,
  OrchestrationConfig,
  SubagentTask,
  SubagentTaskStatus,
  SubagentAnnouncement,
  AggregationStrategy,
} from '../../../shared/types/hyper-space';
import {
  createOrchestrationConfig,
} from '../../../shared/types/hyper-space';
import { getConversation, getMessageThoughts, updateLastMessage } from '../conversation.service';
import { extractFileChangesSummaryFromThoughts } from '../../../shared/file-changes';
import type { Thought } from './types';
import { mailboxService } from './mailbox';
import { taskboardService } from './taskboard';

// ============================================
// Types
// ============================================

/**
 * Runtime state of an agent instance
 */
export interface AgentInstance {
  id: string;
  config: AgentConfig;
  status: 'idle' | 'running' | 'completed' | 'error';
  currentTaskId?: string;
  lastHeartbeat?: number;
}

/**
 * Agent team for a Hyper Space
 */
export interface AgentTeam {
  id: string;
  spaceId: string;
  conversationId: string;
  leader: AgentInstance;
  workers: AgentInstance[];
  config: OrchestrationConfig;
  status: 'idle' | 'active' | 'waiting' | 'completed' | 'error';
  createdAt: number;
  /** Number of spawn injection cycles completed (prevents infinite loops) */
  spawnCycleCount: number;
  /** Accumulated thoughts from worker agents during the current execution cycle */
  turnThoughts: Thought[];
}

/**
 * Event types emitted by the orchestrator
 */
export type OrchestratorEvent =
  | 'team:created'
  | 'team:destroyed'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'task:stalled'
  | 'announce';

/**
 * Stall detection configuration
 */
interface StallDetectionConfig {
  /** Heartbeat timeout in milliseconds (default: 60000 = 1 minute) */
  heartbeatTimeout: number;
  /** Maximum task duration in milliseconds (default: 600000 = 10 minutes) */
  maxTaskDuration: number;
  /** Check interval in milliseconds (default: 30000 = 30 seconds) */
  checkInterval: number;
}

// ============================================
// Orchestrator Service
// ============================================

/**
 * Agent Orchestrator - manages multi-agent teams and task distribution
 *
 * Usage:
 * ```typescript
 * const orchestrator = AgentOrchestrator.getInstance()
 *
 * // Create a team for a Hyper Space
 * const team = orchestrator.createTeam({
 *   spaceId: 'space-123',
 *   conversationId: 'conv-456',
 *   agents: [leaderConfig, worker1Config, worker2Config],
 *   config: orchestrationConfig
 * })
 *
 * // Dispatch a task
 * const tasks = await orchestrator.dispatchTask({
 *   teamId: team.id,
 *   task: 'Analyze the codebase structure',
 *   conversationId: 'conv-456'
 * })
 *
 * // Wait for completion
 * orchestrator.on('announce', (announcement) => {
 *   console.log(`Task ${announcement.taskId} completed by ${announcement.agentId}`)
 * })
 * ```
 */
class AgentOrchestrator extends EventEmitter {
  private static instance: AgentOrchestrator | null = null;

  /** Active teams indexed by team ID */
  private teams: Map<string, AgentTeam> = new Map();

  /** Teams indexed by space ID for quick lookup */
  private teamsBySpace: Map<string, string> = new Map();

  /** Active tasks indexed by task ID */
  private tasks: Map<string, SubagentTask> = new Map();

  /** Pending announcements waiting to be processed */
  private pendingAnnouncements: Map<string, Set<string>> = new Map();

  /** Per-worker SDK session IDs for remote session resumption. Key: childConversationId */
  private workerSessionIds: Map<string, string> = new Map();

  /** Maximum depth for nested subagents (per spawn chain, not global counter) */
  private readonly maxSpawnDepth = 50;

  /** Maximum concurrent children per agent */
  private readonly maxChildrenPerAgent = 5;

  /** Stall detection timer */
  private stallCheckInterval: NodeJS.Timeout | null = null;

  /** Stall detection configuration */
  private stallConfig: StallDetectionConfig = {
    heartbeatTimeout: 5 * 60 * 1000, // 5 minutes (up from 1 min — NPU tasks need more time)
    maxTaskDuration: 60 * 60 * 1000, // 1 hour (up from 10 min — supports long training)
    checkInterval: 30000, // 30 seconds
  };

  /** Persistent worker loops indexed by agent ID */
  private persistentWorkers: Map<string, import('./persistent-worker').PersistentWorkerLoop> =
    new Map();

  /** Whether persistent mode is enabled for a team (indexed by teamId) */
  private persistentModeTeams: Set<string> = new Set();

  private constructor() {
    super();
    this.startStallDetection();
    log.info('Service initialized');
  }

  /**
   * Get singleton instance
   */
  static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator();
    }
    return AgentOrchestrator.instance;
  }

  // ============================================
  // Team Management
  // ============================================

  /**
   * Create a new agent team for a Hyper Space
   */
  createTeam(params: {
    spaceId: string;
    conversationId: string;
    agents: AgentConfig[];
    config?: Partial<OrchestrationConfig>;
  }): AgentTeam {
    const teamId = uuidv4();

    // Validate at least one leader
    const leaders = params.agents.filter((a) => a.role === 'leader');
    if (leaders.length === 0) {
      throw new Error('[Orchestrator] Hyper Space requires at least one leader agent');
    }

    // Use first leader as primary
    const leader = this.createAgentInstance(leaders[0]);
    const workers = params.agents
      .filter((a) => a.role === 'worker')
      .map((a) => this.createAgentInstance(a));

    const config = createOrchestrationConfig(params.config);

    const team: AgentTeam = {
      id: teamId,
      spaceId: params.spaceId,
      conversationId: params.conversationId,
      leader,
      workers,
      config,
      status: 'idle',
      createdAt: Date.now(),
      spawnCycleCount: 0,
      turnThoughts: [],
    };

    this.teams.set(teamId, team);
    this.teamsBySpace.set(params.spaceId, teamId);

    // Initialize mailbox system for this team
    const allAgentIds = [leader.id, ...workers.map((w) => w.id)];
    mailboxService.initialize(params.spaceId, teamId, allAgentIds);

    // Initialize task board for this team
    taskboardService.initialize(params.spaceId, teamId);

    this.emit('team:created', { teamId, spaceId: params.spaceId });

    console.log(
      `[Orchestrator] Created team ${teamId} for space ${params.spaceId} ` +
        `with 1 leader and ${workers.length} workers (mailbox + taskboard initialized)`,
    );

    return team;
  }

  /**
   * Create an agent instance from configuration
   */
  private createAgentInstance(config: AgentConfig): AgentInstance {
    return {
      id: config.id,
      config,
      status: 'idle',
    };
  }

  /**
   * Get team by ID
   */
  getTeam(teamId: string): AgentTeam | undefined {
    return this.teams.get(teamId);
  }

  /**
   * Get team by space ID
   */
  getTeamBySpace(spaceId: string): AgentTeam | undefined {
    const teamId = this.teamsBySpace.get(spaceId);
    if (!teamId) return undefined;
    return this.teams.get(teamId);
  }

  /**
   * Get worker session states for frontend recovery after page refresh.
   * Returns status info for all workers that have been started.
   */
  getWorkerSessionStates(spaceId: string): Array<{
    agentId: string;
    agentName: string;
    status: 'running' | 'completed' | 'failed';
    type: 'local' | 'remote';
    serverName?: string;
    task?: string;
    childConversationId?: string;
  }> {
    const team = this.getTeamBySpace(spaceId);
    if (!team) return [];

    return team.workers
      .filter((w) => w.status === 'running' || w.status === 'idle' || w.status === 'error')
      .map((w) => {
        const childConvId = `${team.conversationId}:agent-${w.id}`;
        return {
          agentId: w.id,
          agentName: w.config.name || w.id,
          status:
            w.status === 'running'
              ? ('running' as const)
              : w.status === 'error'
                ? ('failed' as const)
                : ('completed' as const),
          type: (w.config.type || 'local') as 'local' | 'remote',
          serverName: w.config.serverName,
          task: undefined,
          childConversationId: childConvId,
        };
      });
  }

  /**
   * Find an agent in a team by ID or role
   * @param team - The team to search
   * @param agentIdOrRole - Agent ID or 'leader' to find the leader
   * @returns The agent instance or null if not found
   */
  findAgentInTeam(team: AgentTeam, agentIdOrRole: string): AgentInstance | null {
    // Check if looking for leader
    if (agentIdOrRole === 'leader') {
      return team.leader;
    }

    // Check workers
    const worker = team.workers.find((w) => w.id === agentIdOrRole);
    if (worker) return worker;

    // Check if leader ID matches
    if (team.leader.id === agentIdOrRole) return team.leader;

    return null;
  }

  /**
   * Execute a task on a single agent (not broadcast to all)
   * This is used for direct 1-on-1 chat with a specific agent in Hyper Space
   */
  async executeOnSingleAgent(params: {
    team: AgentTeam;
    agent: AgentInstance;
    task: string;
    conversationId: string;
    systemPrompt?: string;
  }): Promise<void> {
    log.info(` Executing on single agent ${params.agent.id}`);

    const { team, agent, task, conversationId, systemPrompt } = params;

    // Update agent status
    agent.status = 'running';
    agent.currentTaskId = conversationId;
    agent.lastHeartbeat = Date.now();

    try {
      if (agent.config.type === 'local') {
        await this.executeAgentLocally(agent, task, conversationId, systemPrompt, team.spaceId);
      } else {
        await this.executeAgentRemotely(agent, task, conversationId, systemPrompt, team.spaceId);
      }

      // Update agent status
      agent.status = 'idle';
      agent.currentTaskId = undefined;
    } catch (error) {
      agent.status = 'error';
      agent.currentTaskId = undefined;
      throw error;
    }
  }

  /**
   * Execute on a local agent
   * Uses processStream for complete thought accumulation, event forwarding, and persistence
   */
  private async executeAgentLocally(
    agent: AgentInstance,
    task: string,
    conversationId: string,
    systemPrompt: string | undefined,
    spaceId: string,
  ): Promise<void> {
    log.info(` Executing locally on agent ${agent.id}`);

    const {
      getOrCreateV2Session,
      createSessionState,
      registerActiveSession,
      unregisterActiveSession,
    } = await import('./session-manager');
    const { getConfig } = await import('../config.service');
    const { getApiCredentials } = await import('./helpers');
    const { resolveCredentialsForSdk, buildBaseSdkOptions } = await import('./sdk-config');
    const { getWorkingDir, getHeadlessElectronPath, sendToRenderer } = await import('./helpers');
    const { processStream, getAndClearInjection, hasPendingInjection } =
      await import('./stream-processor');
    const { saveSessionId, updateLastMessage } = await import('../conversation.service');
    const { extractFileChangesSummaryFromThoughts } = await import('../../../shared/file-changes');
    const { FileChangesSummary } = await import('../../../shared/file-changes');

    // Get config and credentials
    const config = getConfig();
    const credentials = await getApiCredentials(config);
    const resolvedCredentials = await resolveCredentialsForSdk(credentials);

    // Get working directory and electron path
    const workDir = getWorkingDir(spaceId);
    const electronPath = getHeadlessElectronPath();

    // Use a FIXED child conversation ID to maintain session continuity for multi-turn conversations
    const childConversationId = `${conversationId}:agent-${agent.id}`;
    log.info(`[${conversationId}] Using child conversation ID: ${childConversationId}`);

    // --- Persist worker conversation to database ---
    const { createConversationWithId, addMessage } = await import('../conversation.service');
    createConversationWithId(
      spaceId,
      childConversationId,
      `Worker: ${agent.config.name || agent.id}`,
    );
    addMessage(spaceId, childConversationId, { role: 'user', content: task });
    addMessage(spaceId, childConversationId, { role: 'assistant', content: '' });

    // Create Hyper Space MCP server with appropriate role
    // IMPORTANT: Pass the parent conversationId (not childConversationId) to MCP tools.
    // MCP tools like spawn_subagent need the parent conversationId so that:
    //   - pendingAnnouncements is keyed correctly for the leader's while loop
    //   - queueInjection targets the correct conversation for processStream detection
    //   - createSubtask stores the correct parentConversationId
    const { createHyperSpaceMcpServer } = await import('./hyper-space-mcp');
    const agentRole = agent.config.role || 'worker';
    const hyperSpaceMcp = createHyperSpaceMcpServer(spaceId, conversationId, {
      agentRole,
      workerId: agent.id,
      workerName: agent.config.name,
    });

    // Also register standard MCP servers (same as non-Hyper-Space path)
    const { getEnabledMcpServers } = await import('./helpers');
    const { createAicoBotAppsMcpServer } = await import('../../apps/conversation-mcp');
    const { createGhSearchMcpServer } = await import('../gh-search');
    const enabledMcpServers = getEnabledMcpServers(config.mcpServers || {});

    const mcpServers: Record<string, any> = { 'hyper-space': hyperSpaceMcp };
    if (enabledMcpServers) {
      Object.assign(mcpServers, enabledMcpServers);
    }
    mcpServers['aico-bot-apps'] = createAicoBotAppsMcpServer(spaceId);
    mcpServers['gh-search'] = createGhSearchMcpServer();

    const abortController = new AbortController();

    // Build SDK options
    // For Leader agents, disable the SDK built-in Agent/Task tool to prevent
    // duplicate sub-agents (Leader should only use spawn_subagent MCP tool)
    const isLeader = agent.config.role === 'leader';
    const { getGitHubToken } = await import('../config.service');
    const { getEffectiveProxyUrl } = await import('../proxy');
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir,
      electronPath,
      spaceId,
      conversationId: childConversationId,
      abortController,
      stderrHandler: (data: string) => {
        console.error(`[Agent][${childConversationId}] stderr:`, data);
      },
      mcpServers,
      contextWindow: resolvedCredentials.contextWindow,
      ...(isLeader ? { additionalDisallowedTools: ['Agent', 'Task'] } : {}),
      ghSearchStatus: {
        patConfigured: !!getGitHubToken(),
        proxyEnabled: !!getEffectiveProxyUrl(),
      },
    });

    // Apply custom system prompt if provided
    if (systemPrompt) {
      sdkOptions.systemPrompt = systemPrompt;
    }

    // Get or create session
    const workerSdkSessionId = this.workerSessionIds.get(childConversationId);
    const session = await getOrCreateV2Session(spaceId, childConversationId, {
      sdkOptions,
      sessionId: workerSdkSessionId,
      workDir,
    });

    if (!session) {
      throw new Error('Failed to create session for agent');
    }

    // Create session state for thought accumulation
    const sessionState = createSessionState(spaceId, conversationId, abortController);
    registerActiveSession(conversationId, sessionState);

    log.info(`[${childConversationId}] Session obtained, processing stream...`);

    try {
      // Use processStream in a while(true) loop to handle worker announcement injection.
      // When a worker completes, queueInjection() stores the announcement.
      // processStream returns hasPendingInjection=true at stream end if an injection is queued.
      // We pick it up and continue the loop so the Leader LLM processes the result.
      let currentMessageContent = task;
      const maxInjectionCycles = 20; // Safety limit to prevent infinite loops
      let injectionCycles = 0;

      while (true) {
        const streamResult = await processStream({
          v2Session: session,
          sessionState,
          spaceId,
          conversationId,
          rendererConversationId: conversationId, // Forward events to parent conversation
          messageContent: currentMessageContent,
          displayModel: resolvedCredentials.displayModel || 'claude-sonnet-4-6',
          abortController,
          t0: Date.now(),
          contextWindow: resolvedCredentials.contextWindow,
          callbacks: {
            onComplete: (result) => {
              // Use the result parameter directly - NOT streamResult, because
              // onComplete is called synchronously inside processStream before
              // the const assignment completes (TDZ error).
              const r = result;

              // Save session ID
              if (r.capturedSessionId) {
                saveSessionId(spaceId, conversationId, r.capturedSessionId);
                // Also save for worker session resumption
                this.workerSessionIds.set(childConversationId, r.capturedSessionId);
              }

              // Extract file changes summary from thoughts
              let metadata: { fileChanges?: FileChangesSummary } | undefined;
              if (r.thoughts.length > 0) {
                try {
                  const fileChangesSummary = extractFileChangesSummaryFromThoughts(r.thoughts);
                  if (fileChangesSummary) {
                    metadata = { fileChanges: fileChangesSummary };
                  }
                } catch (e) {
                  log.error(` Failed to extract file changes:`, e);
                }
              }

              // Persist content, thoughts, tokenUsage, metadata, error
              updateLastMessage(spaceId, conversationId, {
                content: r.finalContent,
                thoughts: r.thoughts.length > 0 ? [...r.thoughts] : undefined,
                tokenUsage: r.tokenUsage || undefined,
                metadata,
                error: r.errorThought?.content,
              });

              // Also persist to child conversation for WorkerView history
              try {
                updateLastMessage(spaceId, childConversationId, {
                  content: r.finalContent,
                  thoughts: r.thoughts.length > 0 ? [...r.thoughts] : undefined,
                  tokenUsage: r.tokenUsage || undefined,
                  metadata,
                  error: r.errorThought?.content,
                });
              } catch (e) {
                log.error(
                  ` Failed to persist @mention worker response to ${childConversationId}:`,
                  e,
                );
              }

              // Only unregister when NOT continuing with injection
              if (!r.hasPendingInjection) {
                unregisterActiveSession(conversationId);
              }
            },
          },
        });

        // Check for worker announcement injection (worker completion notification)
        if (streamResult.hasPendingInjection) {
          const injection = getAndClearInjection(conversationId);
          if (injection) {
            injectionCycles++;
            if (injectionCycles >= maxInjectionCycles) {
              log.warn(` Max injection cycles (${maxInjectionCycles}) reached, stopping`);
              unregisterActiveSession(conversationId);
              break;
            }
            log.debug(
              `[${conversationId}] Processing injected worker announcement (cycle ${injectionCycles})`,
            );

            // Use injection content as next message for the Leader
            currentMessageContent = injection.content;

            // Reset session state for next iteration
            sessionState.streamingContent = '';
            sessionState.isThinking = true;

            // Notify frontend that we're continuing with injected message
            sendToRenderer('agent:injection-start', spaceId, conversationId, {
              content: injection.content,
            });

            continue;
          }
        }

        // No pending injection. Check if there are still pending workers that
        // haven't completed yet. This handles the case where the Leader's
        // processStream ended (e.g., LLM stopped without calling wait_for_team)
        // but workers are still running. We programmatically wait for them.
        //
        // Re-check for pending injections first — a worker may have queued one
        // during the brief window between the hasPendingInjection check above
        // and reaching this point (BUG 3 fix).
        if (hasPendingInjection(conversationId)) {
          const injection = getAndClearInjection(conversationId);
          if (injection) {
            injectionCycles++;
            if (injectionCycles >= maxInjectionCycles) {
              log.warn(` Max injection cycles (${maxInjectionCycles}) reached, stopping`);
              unregisterActiveSession(conversationId);
              break;
            }
            log.debug(
              `[${conversationId}] Processing late injection (race fix, cycle ${injectionCycles})`,
            );
            currentMessageContent = injection.content;
            sessionState.streamingContent = '';
            sessionState.isThinking = true;
            const { sendToRenderer } = await import('./helpers');
            sendToRenderer('agent:injection-start', spaceId, conversationId, {
              content: injection.content,
            });
            continue;
          }
        }

        const pending = this.pendingAnnouncements.get(conversationId);
        if (pending && pending.size > 0) {
          console.log(
            `[Orchestrator][${conversationId}] No injection but ${pending.size} worker(s) still pending. ` +
              `Programmatically waiting for completion...`,
          );

          // Notify frontend that we're waiting for workers
          const { sendToRenderer } = await import('./helpers');
          sendToRenderer('agent:waiting', spaceId, conversationId, {
            pendingCount: pending.size,
          });

          // Wait for all pending workers to complete (up to 30 minutes, extended by worker heartbeats)
          try {
            const completedTasks = await this.waitForCompletion({
              conversationId,
              timeout: 30 * 60 * 1000, // 30 minutes base
            });

            // Aggregate completed results and inject as a single message
            const completedAnnouncements = completedTasks.filter(
              (t) => t.status === 'completed' && t.result,
            );
            const failedTasks = completedTasks.filter((t) => t.status === 'failed');

            if (completedAnnouncements.length > 0 || failedTasks.length > 0) {
              let aggregatedMessage = `[Auto-collected Worker Results]\n\n`;

              if (completedAnnouncements.length > 0) {
                aggregatedMessage += `**${completedAnnouncements.length} task(s) completed:**\n\n`;
                for (const task of completedAnnouncements) {
                  const worker = this.getWorkerById(task.agentId);
                  const name = worker?.config.name || task.agentId;
                  aggregatedMessage += `### Worker "${name}"\n${task.result}\n\n`;
                }
              }

              if (failedTasks.length > 0) {
                aggregatedMessage += `**${failedTasks.length} task(s) failed:**\n\n`;
                for (const task of failedTasks) {
                  const worker = this.getWorkerById(task.agentId);
                  const name = worker?.config.name || task.agentId;
                  aggregatedMessage += `### Worker "${name}"\nError: ${task.error || 'Unknown error'}\n\n`;
                }
              }

              // Deduplicate: if worker already injected via MCP tool path
              // (handleHyperSpaceToolCall queued an injection), clear the injection
              // queue so only the auto-collected result is processed.
              // This prevents the Leader from receiving the same result twice.
              const { hasPendingInjection: checkPending, getAndClearInjection: drainInjection } =
                await import('./stream-processor');
              if (checkPending(conversationId)) {
                const drained = drainInjection(conversationId);
                console.log(
                  `[Orchestrator][${conversationId}] Cleared ${drained ? 1 : 0} duplicate injection(s) ` +
                    `from MCP tool path (auto-collect takes priority)`,
                );
              }

              // Inject the aggregated results and continue the loop
              // so the Leader LLM can process them
              currentMessageContent = aggregatedMessage;
              sessionState.streamingContent = '';
              sessionState.isThinking = true;

              sendToRenderer('agent:injection-start', spaceId, conversationId, {
                content: aggregatedMessage,
              });

              console.log(
                `[Orchestrator][${conversationId}] Injected auto-collected results from ` +
                  `${completedAnnouncements.length} completed, ${failedTasks.length} failed workers`,
              );

              continue;
            }
          } catch (waitError) {
            log.error(` Error waiting for workers:`, waitError);
            // Don't break — let the leader know about the timeout
            currentMessageContent = `[Worker Timeout] Some workers did not complete within the timeout. Check their status individually.`;
            sessionState.streamingContent = '';
            sessionState.isThinking = true;
            continue;
          }
        }

        // No pending injection AND no pending workers — execution truly complete
        break;
      }

      log.debug(` Agent ${agent.id} completed, injectionCycles: ${injectionCycles}`);
    } catch (error) {
      unregisterActiveSession(conversationId);
      throw error;
    }
  }

  /**
   * Execute on a remote agent
   * Follows the same pattern as executeRemoteMessage in send-message.ts
   */
  private async executeAgentRemotely(
    agent: AgentInstance,
    task: string,
    conversationId: string,
    systemPrompt: string | undefined,
    spaceId: string,
  ): Promise<void> {
    log.info(` Executing remotely on agent ${agent.id}`);

    const { RemoteWsClient, registerActiveClient, unregisterActiveClient } =
      await import('../remote/ws/remote-ws-client');
    const { getRemoteDeployService } = await import('../../ipc/remote-server');
    const { sendToRenderer } = await import('./helpers');
    const { saveSessionId, updateLastMessage, getConversation } =
      await import('../conversation.service');
    const { getConfig } = await import('../config.service');
    const { decryptString } = await import('../auth/secure-storage.service');
    const sshTunnelService = (await import('../remote/ssh/ssh-tunnel.service')).default;
    const { extractFileChangesSummaryFromThoughts } = await import('../../../shared/file-changes');

    const remoteServerId = agent.config.remoteServerId;
    if (!remoteServerId) {
      throw new Error(`Remote agent ${agent.id} has no remoteServerId configured`);
    }

    // Get remote server info
    const deployService = getRemoteDeployService();
    const serverInfo = deployService.getServer(remoteServerId);

    if (!serverInfo) {
      throw new Error(`Remote server ${remoteServerId} not found`);
    }

    // Get API configuration — server card config takes precedence, then global AI source
    const config = getConfig();
    const currentSource = config.aiSources?.sources?.find(
      (s) => s.id === config.aiSources?.currentId,
    );
    const apiKeyRaw = serverInfo.claudeApiKey || currentSource?.apiKey || config.api?.apiKey;
    const apiKey = apiKeyRaw ? decryptString(apiKeyRaw) : undefined;
    const baseUrl = serverInfo.claudeBaseUrl || currentSource?.apiUrl;
    const model =
      serverInfo.claudeModel || currentSource?.model || config.api?.model || 'claude-sonnet-4-6';

    log.debug(` Using model: ${model}, hasApiKey: ${!!apiKey}`);

    // Use a FIXED child conversation ID to maintain session continuity for multi-turn conversations
    // Format: {mainConversationId}:agent-{agentId} (NO timestamp - same session for same agent)
    const childConversationId = `${conversationId}:agent-${agent.id}`;
    log.info(`[${conversationId}] Using child conversation ID for remote: ${childConversationId}`);

    // --- Persist worker conversation to database ---
    const { createConversationWithId: cc, addMessage: am } =
      await import('../conversation.service');
    cc(spaceId, childConversationId, `Worker: ${agent.config.name || agent.id}`);
    am(spaceId, childConversationId, { role: 'user', content: task });
    am(spaceId, childConversationId, { role: 'assistant', content: '' });

    // Get conversation for session resumption
    const conversation = getConversation(spaceId, conversationId);
    const sessionId = conversation?.sessionId;

    // Determine if SSH tunnel should be used (default: true for security)
    const useSshTunnel = agent.config.useSshTunnel ?? true;
    let localTunnelPort = serverInfo.assignedPort;

    // Establish SSH tunnel if required (same as executeRemoteMessage)
    if (useSshTunnel) {
      log.debug(` Establishing SSH tunnel to ${serverInfo.host}:${serverInfo.assignedPort}...`);

      const decryptedPassword = decryptString(serverInfo.password || '');

      try {
        localTunnelPort = await sshTunnelService.establishTunnel({
          spaceId,
          serverId: remoteServerId,
          host: serverInfo.host,
          port: serverInfo.sshPort || 22,
          username: serverInfo.username,
          password: decryptedPassword,
          localPort: serverInfo.assignedPort,
          remotePort: serverInfo.assignedPort,
        });
        log.info(` SSH tunnel established on local port ${localTunnelPort}`);
      } catch (tunnelError) {
        log.error('Failed to establish SSH tunnel:', tunnelError);
        throw new Error(
          `SSH tunnel failed: ${tunnelError instanceof Error ? tunnelError.message : String(tunnelError)}`,
        );
      }
    }

    // Create WebSocket client with proper configuration
    // Use localhost and tunnel port when SSH tunnel is enabled
    let client: InstanceType<typeof RemoteWsClient> | null = null;
    let tunnelEstablished = useSshTunnel;

    try {
      client = new RemoteWsClient(
        {
          serverId: remoteServerId,
          host: useSshTunnel ? 'localhost' : serverInfo.host,
          port: useSshTunnel ? localTunnelPort : serverInfo.assignedPort,
          authToken: serverInfo.authToken || '',
          useSshTunnel,
          apiKey: apiKey || undefined,
          baseUrl: currentSource?.apiUrl || undefined,
          model: model || undefined,
        },
        childConversationId,
      );

      // Register this client under the child conversation so worker sessions do not overwrite
      // each other when multiple remote workers run under the same parent conversation.
      registerActiveClient(childConversationId, client);

      // Variables to track streaming content and thoughts
      let streamingContent = '';
      const streamChunks: string[] = [];
      const thoughts: any[] = [];

      // =====================================================
      // Set up ALL event handlers BEFORE calling sendChatWithStream
      // This matches the pattern in executeRemoteMessage
      // =====================================================

      // SDK session ID event - for session resumption
      client.on('claude:session', (data: any) => {
        if (data.sessionId === childConversationId) {
          const receivedSdkSessionId = data.data?.sdkSessionId;
          if (receivedSdkSessionId) {
            log.debug(` Captured SDK session_id: ${receivedSdkSessionId}`);
            this.workerSessionIds.set(childConversationId, receivedSdkSessionId);
          }
        }
      });

      // Streaming text events
      client.on('claude:stream', (data: any) => {
        if (data.sessionId === childConversationId) {
          const text = data.data?.text || data.data?.content || '';
          streamChunks.push(text);
          streamingContent = streamChunks.join('');
          // Forward to renderer using MAIN conversation ID (not child)
          sendToRenderer('agent:message', spaceId, conversationId, {
            type: 'message',
            delta: text,
            isComplete: false,
            isStreaming: true,
          });
        }
      });

      // Thought events - for thinking process display
      client.on('thought', (data: any) => {
        if (data.sessionId === childConversationId) {
          const thoughtData = data.data;
          thoughts.push(thoughtData); // Accumulate for persistence
          log.debug(` Thought received: type=${thoughtData.type}, id=${thoughtData.id}`);
          // Forward to renderer
          sendToRenderer('agent:thought', spaceId, conversationId, { thought: thoughtData });
        }
      });

      // Thought delta events - for streaming updates
      client.on('thought:delta', (data: any) => {
        if (data.sessionId === childConversationId) {
          const deltaData = data.data;
          // Update accumulated thought state
          const thought = thoughts.find((t: any) => t.id === deltaData.thoughtId);
          if (thought) {
            if (deltaData.content) thought.content = deltaData.content;
            if (deltaData.toolResult) thought.toolResult = deltaData.toolResult;
            if (deltaData.toolInput) thought.toolInput = deltaData.toolInput;
            if (deltaData.isComplete !== undefined) thought.isStreaming = !deltaData.isComplete;
            if (deltaData.isReady !== undefined) thought.isReady = deltaData.isReady;
          }
          // Forward to renderer
          sendToRenderer('agent:thought-delta', spaceId, conversationId, deltaData);
        }
      });

      // Tool call events
      client.on('tool:call', (data: any) => {
        if (data.sessionId === childConversationId) {
          const toolData = data.data;
          log.debug(` Tool call received:`, {
            name: toolData.name,
            status: toolData.status,
            id: toolData.id,
          });
          sendToRenderer('agent:tool-call', spaceId, conversationId, {
            id: toolData.id,
            name: toolData.name,
            status: toolData.status || 'running',
            input: toolData.input || {},
            requiresApproval: false,
          });
        }
      });

      // Tool result events
      client.on('tool:result', (data: any) => {
        if (data.sessionId === childConversationId) {
          const toolData = data.data;
          log.debug(` Tool result received, name=${toolData.name}`);
          sendToRenderer('agent:tool-result', spaceId, conversationId, {
            toolId: toolData.id,
            result: toolData.output || '',
            isError: false,
          });
        }
      });

      // Tool error events
      client.on('tool:error', (data: any) => {
        if (data.sessionId === childConversationId) {
          const toolData = data.data;
          log.error(` Tool error:`, toolData);
          sendToRenderer('agent:tool-result', spaceId, conversationId, {
            toolId: toolData.id,
            result: toolData.error || 'Tool execution failed',
            isError: true,
          });
        }
      });

      // Terminal output events
      client.on('terminal:output', (data: any) => {
        if (data.sessionId === childConversationId) {
          const output = data.data;
          log.debug(` terminal:output received: content.length=${output.content?.length || 0}`);
          sendToRenderer('agent:terminal', spaceId, conversationId, output);
        }
      });

      // Text block start signal
      client.on('text:block-start', (data: any) => {
        if (data.sessionId === childConversationId) {
          sendToRenderer('agent:message', spaceId, conversationId, {
            type: 'message',
            content: '',
            isComplete: false,
            isStreaming: false,
            isNewTextBlock: true,
          });
        }
      });

      // Connect to remote server
      log.debug(` Connecting to remote server...`);
      await client.connect();
      tunnelEstablished = false; // After connect(), tunnel cleanup is client's responsibility
      log.debug(` Connected to remote server`);

      // Send chat request via WebSocket with streaming
      log.debug(` Sending chat request to remote Claude...`);
      const workerSdkSessionId = this.workerSessionIds.get(childConversationId);
      const response = await client.sendChatWithStream(
        childConversationId,
        [{ role: 'user', content: task }],
        {
          apiKey,
          baseUrl: baseUrl || undefined,
          model,
          maxTokens: config.agent?.maxTokens || 8192,
          system: systemPrompt,
          workDir: agent.config.remotePath || '/home',
          sdkSessionId: workerSdkSessionId || undefined,
        },
      );

      log.debug(
        ` Received response from remote Claude: ${(response.content || '').substring(0, 100)}...`,
      );

      // Use accumulated streaming content or response content
      const result = streamingContent || response.content || '';

      // Send final message content
      sendToRenderer('agent:message', spaceId, conversationId, {
        content: result,
        isComplete: true,
        isStreaming: false,
      });

      // Save the real SDK session ID so later turns can resume remote worker context.
      const latestWorkerSessionId =
        this.workerSessionIds.get(childConversationId) || workerSdkSessionId;
      if (latestWorkerSessionId) {
        saveSessionId(spaceId, conversationId, latestWorkerSessionId);
      }

      // Extract file changes summary from accumulated thoughts
      let metadata: { fileChanges?: any } | undefined;
      if (thoughts.length > 0) {
        try {
          const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts);
          if (fileChangesSummary) {
            metadata = { fileChanges: fileChangesSummary };
          }
        } catch (e) {
          log.error(` Failed to extract file changes from remote thoughts:`, e);
        }
      }

      updateLastMessage(spaceId, conversationId, {
        content: result,
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        metadata,
        tokenUsage: response.tokenUsage,
      });

      // Also persist to child conversation for WorkerView history
      try {
        updateLastMessage(spaceId, childConversationId, {
          content: result,
          thoughts: thoughts.length > 0 ? [...thoughts] : undefined,
          metadata,
          tokenUsage: response.tokenUsage,
        });
      } catch (e) {
        log.error(
          ` Failed to persist @mention remote worker response to ${childConversationId}:`,
          e,
        );
      }

      // Send completion event
      sendToRenderer('agent:complete', spaceId, conversationId, {
        result,
        timestamp: Date.now(),
      });

      log.debug(` Remote agent ${agent.id} completed, result length: ${result.length}`);
    } finally {
      // CRITICAL: Always clean up resources — WebSocket, SSH tunnel, active client registration
      if (client) {
        try {
          client.disconnect();
        } catch (_) {
          /* best effort */
        }
        try {
          unregisterActiveClient(childConversationId);
        } catch (_) {
          /* best effort */
        }
      }
      // Tear down SSH tunnel if it was established in this method and not yet cleaned up
      if (tunnelEstablished && useSshTunnel) {
        try {
          await sshTunnelService.closeTunnel(spaceId, remoteServerId);
          log.info(` SSH tunnel closed for ${remoteServerId}`);
        } catch (_) {
          log.warn(` Failed to close SSH tunnel for ${remoteServerId}`);
        }
      }
    }
  }

  /**
   * Destroy a team and clean up all resources.
   * Cascading cleanup: stop workers, remove tasks, clear injections.
   */
  async destroyTeam(teamId: string): Promise<boolean> {
    const team = this.teams.get(teamId);
    if (!team) return false;

    log.debug(` Destroying team ${teamId} — cleaning up all resources...`);

    // 1. Mark all running workers as idle (abort signals are handled by callers)
    for (const worker of team.workers) {
      if (worker.status === 'running') {
        log.debug(` Marking worker ${worker.id} as idle during team destroy`);
        worker.status = 'idle';
        worker.currentTaskId = undefined;
      }
    }

    // 2. Stop persistent workers if active
    await this.stopPersistentWorkers(teamId);

    // 3. Fail all running tasks for this team's conversation
    for (const [taskId, task] of this.tasks) {
      if (task.parentConversationId === team.conversationId && task.status === 'running') {
        this.updateTaskStatus(taskId, 'failed', undefined, 'Team destroyed');
      }
    }

    // 3. Clean up pending announcements for this conversation
    this.pendingAnnouncements.delete(team.conversationId);

    // 4. Clean up injection queues for this conversation
    try {
      const { clearInjectionsForConversation } = require('./stream-processor');
      clearInjectionsForConversation(team.conversationId);
    } catch (_) {
      // stream-processor may not export clearInjectionsForConversation yet
    }

    // 5. Clean up mailbox system for this space
    mailboxService.destroy(team.spaceId);

    // 5.5 Clean up task board
    taskboardService.destroy(team.spaceId);

    // 6. Remove from maps
    this.teams.delete(teamId);
    this.teamsBySpace.delete(team.spaceId);

    this.emit('team:destroyed', { teamId, spaceId: team.spaceId });

    log.debug(` Destroyed team ${teamId}`);
    return true;
  }

  /**
   * Add a new agent to an existing team
   */
  addAgentToTeam(teamId: string, agentConfig: AgentConfig): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;

    const instance = this.createAgentInstance(agentConfig);

    if (agentConfig.role === 'leader') {
      // Replace existing leader (only one leader supported for now)
      team.leader = instance;
    } else {
      team.workers.push(instance);
    }

    // Add mailbox for the new agent
    mailboxService.addAgent(team.spaceId, teamId, agentConfig.id);

    log.debug(` Added agent ${agentConfig.id} to team ${teamId}`);
    return true;
  }

  /**
   * Remove an agent from a team
   */
  removeAgentFromTeam(teamId: string, agentId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;

    // Cannot remove leader
    if (team.leader.id === agentId) {
      log.warn(` Cannot remove leader ${agentId} from team ${teamId}`);
      return false;
    }

    const index = team.workers.findIndex((w) => w.id === agentId);
    if (index === -1) return false;

    team.workers.splice(index, 1);

    // Remove mailbox for the removed agent
    mailboxService.removeAgent(team.spaceId, agentId);

    log.debug(` Removed agent ${agentId} from team ${teamId}`);
    return true;
  }

  // ============================================
  // Team Configuration
  // ============================================

  /**
   * Deep-merge partial orchestration config into a team's existing config.
   * Nested objects (routing, aggregation, announce) are merged individually.
   */
  updateTeamConfig(spaceId: string, updates: Partial<OrchestrationConfig>): boolean {
    const team = this.getTeamBySpace(spaceId);
    if (!team) return false;

    team.config = {
      ...team.config,
      ...updates,
      routing: { ...team.config.routing, ...updates.routing },
      aggregation: { ...team.config.aggregation, ...updates.aggregation },
      announce: { ...team.config.announce, ...updates.announce },
    };

    log.debug(`Updated config for team ${team.id} in space ${spaceId}`);
    return true;
  }

  /**
   * Get a flat members list for @ mention autocomplete.
   * Tries runtime team first, falls back to space definition on disk.
   */
  getTeamMembers(spaceId: string): Array<{
    id: string;
    name: string;
    role: 'leader' | 'worker';
    type: string;
    capabilities: string[];
  }> | null {
    const team = this.getTeamBySpace(spaceId);

    if (team) {
      return [
        {
          id: team.leader.id,
          name: team.leader.config.name,
          role: 'leader' as const,
          type: team.leader.config.type,
          capabilities: team.leader.config.capabilities,
        },
        ...team.workers.map((w) => ({
          id: w.id,
          name: w.config.name,
          role: 'worker' as const,
          type: w.config.type,
          capabilities: w.config.capabilities,
        })),
      ];
    }

    return null;
  }

  // ============================================
  // Persistent Worker Management
  // ============================================

  /**
   * Enable persistent mode for a team and start all worker loops.
   * Workers will stay alive between tasks, poll for messages, and auto-claim from TaskBoard.
   */
  async startPersistentWorkers(teamId: string): Promise<boolean> {
    const team = this.teams.get(teamId);
    if (!team) {
      log.warn(`Cannot start persistent workers: team ${teamId} not found`);
      return false;
    }

    if (this.persistentModeTeams.has(teamId)) {
      log.debug(`Persistent mode already active for team ${teamId}`);
      return true;
    }

    const { PersistentWorkerLoop } = await import('./persistent-worker');

    for (const worker of team.workers) {
      const loop = new PersistentWorkerLoop(worker, team);
      this.persistentWorkers.set(worker.id, loop as any);
      await loop.start();
    }

    this.persistentModeTeams.add(teamId);
    team.status = 'active';

    log.info(`Started ${team.workers.length} persistent workers for team ${teamId}`);
    return true;
  }

  /**
   * Stop all persistent workers for a team.
   */
  async stopPersistentWorkers(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) return;

    this.persistentModeTeams.delete(teamId);

    // Stop all persistent workers concurrently
    const stopPromises = team.workers
      .filter((w) => this.persistentWorkers.has(w.id))
      .map(async (w) => {
        const loop = this.persistentWorkers.get(w.id);
        if (loop) {
          await (loop as any).stop();
          this.persistentWorkers.delete(w.id);
        }
      });

    await Promise.allSettled(stopPromises);
    log.info(`Stopped all persistent workers for team ${teamId}`);
  }

  /**
   * Check if persistent mode is active for a team.
   */
  isPersistentMode(teamId: string): boolean {
    return this.persistentModeTeams.has(teamId);
  }

  /**
   * Check if a specific worker is running in persistent mode.
   */
  isWorkerPersistent(agentId: string): boolean {
    return (
      this.persistentWorkers.has(agentId) &&
      (this.persistentWorkers.get(agentId) as any)?.isActive()
    );
  }

  // ============================================
  // Task Dispatching
  // ============================================

  /**
   * Dispatch a task to appropriate agents based on routing strategy
   * If targetAgentId is specified, dispatch directly to that agent (bypass routing strategy)
   */
  async dispatchTask(params: {
    teamId: string;
    task: string;
    conversationId: string;
    targetAgentId?: string;
  }): Promise<SubagentTask[]> {
    const team = this.teams.get(params.teamId);
    if (!team) {
      throw new Error(`[Orchestrator] Team not found: ${params.teamId}`);
    }

    team.status = 'active';

    let tasks: SubagentTask[] = [];
    let strategy: string;

    // If a specific target agent is specified, dispatch directly to that agent
    if (params.targetAgentId) {
      const targetAgent = team.workers.find(
        (w) => w.id === params.targetAgentId || w.config.name === params.targetAgentId,
      );
      if (!targetAgent) {
        throw new Error(
          `[Orchestrator] Target agent "${params.targetAgentId}" not found in team. ` +
            `Available agents: ${team.workers.map((w) => w.id).join(', ')}`,
        );
      }
      tasks = [
        this.createSubtask({
          team,
          agent: targetAgent,
          task: params.task,
          conversationId: params.conversationId,
        }),
      ];
      strategy = 'direct-target';
      log.debug(` Dispatched task directly to agent: ${params.targetAgentId}`);
    } else {
      // Use routing strategy to find appropriate agent(s)
      strategy = team.config.routing.strategy;

      switch (strategy) {
        case 'capability':
          tasks = await this.dispatchByCapability(team, params);
          break;
        case 'round-robin':
          tasks = this.dispatchRoundRobin(team, params);
          break;
        case 'manual':
          tasks = this.dispatchToManual(team, params);
          break;
        default:
          tasks = this.dispatchToAll(team, params);
      }
    }

    // Register pending announcements (merge with existing set if any)
    const newPending = new Set(tasks.map((t) => t.id));
    log.debug(
      ` dispatchTask: conversationId=${params.conversationId}${params.conversationId.includes(':agent-') ? ' ⚠️ CHILD ID' : ' ✓ parent'}`,
    );
    const existing = this.pendingAnnouncements.get(params.conversationId);
    if (existing) {
      for (const id of newPending) {
        existing.add(id);
      }
    } else {
      this.pendingAnnouncements.set(params.conversationId, newPending);
    }

    console.log(
      `[Orchestrator] Dispatched task to ${tasks.length} agent(s) ` + `with strategy: ${strategy}`,
    );

    return tasks;
  }

  /**
   * Dispatch task based on agent capabilities
   */
  private async dispatchByCapability(
    team: AgentTeam,
    params: { task: string; conversationId: string },
  ): Promise<SubagentTask[]> {
    // TODO: Implement AI-based routing using leader agent (buildRoutingPrompt)
    const targetAgents = this.matchAgentsByCapabilities(team, params.task);

    if (targetAgents.length === 0) {
      // No capability match, dispatch to all workers
      return this.dispatchToAll(team, params);
    }

    return targetAgents.map((agent) =>
      this.createSubtask({
        team,
        agent,
        task: params.task,
        conversationId: params.conversationId,
      }),
    );
  }

  /**
   * Build routing analysis prompt for the leader
   */
  private buildRoutingPrompt(team: AgentTeam, task: string): string {
    const agentInfo = team.workers
      .map((w) => `- ${w.config.name}: ${w.config.capabilities?.join(', ') || 'general'}`)
      .join('\n');

    return `Analyze this task and determine which agent(s) should handle it.

Available agents:
${agentInfo}

Task: ${task}

Respond with a JSON array of agent IDs that should handle this task.`;
  }

  /**
   * Match agents to task based on capability keywords
   */
  private matchAgentsByCapabilities(team: AgentTeam, task: string): AgentInstance[] {
    const taskLower = task.toLowerCase();
    const matches: AgentInstance[] = [];

    for (const worker of team.workers) {
      const capabilities = worker.config.capabilities || [];
      if (capabilities.some((cap) => taskLower.includes(cap.toLowerCase()))) {
        matches.push(worker);
      }
    }

    return matches;
  }

  /**
   * Dispatch task using round-robin
   */
  private dispatchRoundRobin(
    team: AgentTeam,
    params: { task: string; conversationId: string },
  ): SubagentTask[] {
    // Find the least recently used agent
    const sortedWorkers = [...team.workers].sort(
      (a, b) => (a.lastHeartbeat || 0) - (b.lastHeartbeat || 0),
    );

    const target = sortedWorkers[0];
    if (!target) {
      return this.dispatchToAll(team, params);
    }

    return [
      this.createSubtask({
        team,
        agent: target,
        task: params.task,
        conversationId: params.conversationId,
      }),
    ];
  }

  /**
   * Dispatch to manually specified agent
   */
  private dispatchToManual(
    team: AgentTeam,
    params: { task: string; conversationId: string },
  ): SubagentTask[] {
    const defaultAgentId = team.config.routing.defaultAgentId;
    if (!defaultAgentId) {
      log.warn('No default agent specified for manual routing');
      return this.dispatchToAll(team, params);
    }

    const target = team.workers.find((w) => w.id === defaultAgentId);
    if (!target) {
      log.warn(` Default agent ${defaultAgentId} not found`);
      return this.dispatchToAll(team, params);
    }

    return [
      this.createSubtask({
        team,
        agent: target,
        task: params.task,
        conversationId: params.conversationId,
      }),
    ];
  }

  /**
   * Dispatch task to all workers in parallel
   */
  private dispatchToAll(
    team: AgentTeam,
    params: { task: string; conversationId: string },
  ): SubagentTask[] {
    return team.workers.map((worker) =>
      this.createSubtask({
        team,
        agent: worker,
        task: params.task,
        conversationId: params.conversationId,
      }),
    );
  }

  /**
   * Create a subtask for an agent
   */
  private createSubtask(params: {
    team: AgentTeam;
    agent: AgentInstance;
    task: string;
    conversationId: string;
  }): SubagentTask {
    const taskId = uuidv4();
    const now = Date.now();

    const subtask: SubagentTask = {
      id: taskId,
      parentConversationId: params.conversationId,
      agentId: params.agent.id,
      task: params.task,
      status: 'pending',
      startedAt: now,
    };

    this.tasks.set(taskId, subtask);

    // Update agent state
    params.agent.status = 'running';
    params.agent.currentTaskId = taskId;
    params.agent.lastHeartbeat = now;

    // Emit task started event
    this.emit('task:started', {
      taskId,
      agentId: params.agent.id,
      teamId: params.team.id,
    });

    return subtask;
  }

  // ============================================
  // Task Status Management
  // ============================================

  /**
   * Update task status
   */
  updateTaskStatus(
    taskId: string,
    status: SubagentTaskStatus,
    result?: string,
    error?: string,
  ): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = status;
    if (result !== undefined) task.result = result;
    if (error !== undefined) task.error = error;

    if (status === 'completed' || status === 'failed') {
      task.completedAt = Date.now();
    }

    // Emit appropriate event
    if (status === 'completed') {
      this.emit('task:completed', { taskId, result });
    } else if (status === 'failed') {
      this.emit('task:failed', { taskId, error });
    }

    return true;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): SubagentTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks for a conversation
   */
  getTasksForConversation(conversationId: string): SubagentTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.parentConversationId === conversationId);
  }

  // ============================================
  // Announcement System (Inspired by OpenClaw)
  // ============================================

  /**
   * Send completion announcement
   * Inspired by OpenClaw: announcement is injected as a user message into the parent session
   * so the leader agent receives it naturally without polling
   */
  async sendAnnouncement(announcement: SubagentAnnouncement): Promise<void> {
    console.log(
      `[Orchestrator] Announcement received: task=${announcement.taskId} ` +
        `agent=${announcement.agentId} status=${announcement.status}`,
    );

    // Guard against duplicate announcements (task already completed/failed)
    const existingTask = this.tasks.get(announcement.taskId);
    if (existingTask && (existingTask.status === 'completed' || existingTask.status === 'failed')) {
      console.warn(
        `[Orchestrator] Ignoring duplicate announcement for task ${announcement.taskId}, ` +
          `already ${existingTask.status}`,
      );
      return;
    }

    // Emit for listeners (UI updates etc.)
    this.emit('announce', announcement);

    // Remove from pending
    const task = this.tasks.get(announcement.taskId);
    if (task) {
      const pending = this.pendingAnnouncements.get(task.parentConversationId);
      if (pending) {
        pending.delete(announcement.taskId);
      }
    }

    // Update task status
    this.updateTaskStatus(
      announcement.taskId,
      announcement.status === 'completed' ? 'completed' : 'failed',
      announcement.result,
      announcement.status === 'failed' ? 'Agent reported failure' : undefined,
    );

    // Update agent status
    this.updateAgentStatus(announcement.agentId, 'idle');

    // Inject announcement into leader's session (key OpenClaw pattern)
    await this.injectAnnouncementToLeader(announcement);

    // Persist announcement to mailbox for durability and visibility
    this.persistAnnouncementToMailbox(announcement);
  }

  /**
   * Update agent status
   */
  private updateAgentStatus(agentId: string, status: AgentInstance['status']): void {
    for (const team of this.teams.values()) {
      if (team.leader.id === agentId) {
        team.leader.status = status;
        return;
      }
      const worker = team.workers.find((w) => w.id === agentId);
      if (worker) {
        worker.status = status;
        return;
      }
    }
  }

  /**
   * Get a worker agent instance by ID across all teams
   */
  private getWorkerById(agentId: string): AgentInstance | undefined {
    for (const team of this.teams.values()) {
      const worker = team.workers.find((w) => w.id === agentId);
      if (worker) return worker;
    }
    return undefined;
  }

  /**
   * Wait for all pending tasks to complete.
   * Supports heartbeat extension: if any pending worker updates its heartbeat,
   * the timeout is extended, preventing premature timeout on long-running tasks.
   * Supports cancellation via AbortSignal.
   */
  async waitForCompletion(params: {
    conversationId: string;
    timeout?: number;
    heartbeatTimeout?: number;
    signal?: AbortSignal;
  }): Promise<SubagentTask[]> {
    const timeout = params.timeout || 30 * 60 * 1000; // 30 minutes default (up from 5 min)
    const heartbeatTimeout = params.heartbeatTimeout || 5 * 60 * 1000; // 5 min per-heartbeat extension
    const startTime = Date.now();
    let lastProgressTime = startTime; // Tracks last time any worker showed activity
    let cancelled = false;

    if (params.signal) {
      params.signal.addEventListener('abort', () => {
        cancelled = true;
      });
    }

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const check = () => {
        if (cancelled) {
          reject(new Error('[Orchestrator] waitForCompletion cancelled'));
          return;
        }

        const pending = this.pendingAnnouncements.get(params.conversationId);

        if (!pending || pending.size === 0) {
          const tasks = this.getTasksForConversation(params.conversationId);
          resolve(tasks);
          return;
        }

        // Check heartbeats of pending workers — update lastProgressTime if any is alive
        const now = Date.now();
        for (const taskId of pending) {
          const task = this.tasks.get(taskId);
          if (task?.agentId) {
            const worker = this.getWorkerById(task.agentId);
            if (worker?.lastHeartbeat && worker.lastHeartbeat > lastProgressTime) {
              lastProgressTime = worker.lastHeartbeat;
              console.debug(
                `[Orchestrator] waitForCompletion: heartbeat from worker ${task.agentId}, ` +
                  `extended deadline by ${heartbeatTimeout / 1000}s`,
              );
            }
          }
        }

        // Timeout: absolute OR since last heartbeat activity
        const timeSinceStart = now - startTime;
        const timeSinceProgress = now - lastProgressTime;

        if (timeSinceStart > timeout) {
          reject(
            new Error(
              `[Orchestrator] Absolute timeout (${timeout / 1000}s) waiting for ${pending.size} subagent(s)`,
            ),
          );
          return;
        }

        if (timeSinceProgress > heartbeatTimeout) {
          reject(
            new Error(
              `[Orchestrator] Heartbeat timeout (${heartbeatTimeout / 1000}s since last worker activity) ` +
                `waiting for ${pending.size} subagent(s). Workers may be stuck.`,
            ),
          );
          return;
        }

        timer = setTimeout(check, 1000);
      };

      check();
    });
  }

  /**
   * Aggregate results from multiple tasks
   */
  aggregateResults(tasks: SubagentTask[], strategy: AggregationStrategy): string {
    const completedTasks = tasks.filter((t) => t.status === 'completed' && t.result);

    switch (strategy) {
      case 'concat':
        return completedTasks
          .map((t) => `### Agent: ${t.agentId}\n${t.result}`)
          .join('\n\n---\n\n');

      case 'summarize':
        // TODO: Use leader agent to summarize
        return this.simpleSummary(completedTasks);

      case 'vote':
        // Return the longest result (simple voting)
        const longest = completedTasks.reduce((a, b) =>
          (a.result?.length || 0) > (b.result?.length || 0) ? a : b,
        );
        return longest.result || '';

      default:
        return completedTasks.map((t) => t.result).join('\n');
    }
  }

  /**
   * Simple summary of task results
   */
  private simpleSummary(tasks: SubagentTask[]): string {
    const lines: string[] = ['## Multi-Agent Task Results\n'];

    for (const task of tasks) {
      const preview = task.result?.substring(0, 200) || '';
      lines.push(`### ${task.agentId}`);
      lines.push(preview + (preview.length >= 200 ? '...' : ''));
      lines.push('');
    }

    return lines.join('\n');
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Build subagent system prompt
   */
  buildSubagentPrompt(subtask: SubagentTask, agentConfig: AgentConfig): string {
    return `[Subagent Context]
You are running as a subagent (worker) in a multi-agent collaboration.

Task ID: ${subtask.id}
Task: ${subtask.task}

${agentConfig.systemPromptAddition || ''}

Complete this task and provide a clear, concise summary of your findings.
When done, your results will be automatically announced to the parent agent.

If you have access to the \`hyper-space\` MCP tools, you can:
- Use \`report_to_leader\` to send intermediate progress updates to the leader
- Use \`announce_completion\` to report your final result
- Use \`ask_question\` to ask the leader for clarification

If you do NOT have MCP tools (e.g., running on a remote server without them),
just complete the task normally — the orchestrator will collect your results automatically.`;
  }

  /**
   * Get team status summary
   */
  getTeamStatus(teamId: string): {
    status: AgentTeam['status'];
    leader: { id: string; status: string };
    workers: Array<{ id: string; status: string; currentTaskId?: string }>;
    pendingTasks: number;
  } | null {
    const team = this.teams.get(teamId);
    if (!team) return null;

    const pending = this.pendingAnnouncements.get(team.conversationId)?.size || 0;

    return {
      status: team.status,
      leader: {
        id: team.leader.id,
        status: team.leader.status,
      },
      workers: team.workers.map((w) => ({
        id: w.id,
        status: w.status,
        currentTaskId: w.currentTaskId,
      })),
      pendingTasks: pending,
    };
  }

  // ============================================
  // Task Execution
  // ============================================

  /**
   * Execute a subtask on the assigned agent
   * This is called after createSubtask to actually run the task
   */
  async executeSubtask(
    subtask: SubagentTask,
    agent: AgentInstance,
    team: AgentTeam,
  ): Promise<void> {
    log.debug(` Executing subtask ${subtask.id} on agent ${agent.id}`);

    // Update status to running
    this.updateTaskStatus(subtask.id, 'running');

    try {
      if (agent.config.type === 'local') {
        await this.executeLocally(subtask, agent, team);
      } else {
        await this.executeRemotely(subtask, agent, team);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(` Subtask ${subtask.id} failed:`, errorMessage);

      // Update status and send announcement
      this.updateTaskStatus(subtask.id, 'failed', undefined, errorMessage);
      await this.sendAnnouncement({
        type: 'agent:announce',
        taskId: subtask.id,
        agentId: agent.id,
        status: 'failed',
        result: undefined,
        summary: `Task failed: ${errorMessage}`,
        timestamp: Date.now(),
      });

      // Update agent status
      agent.status = 'error';
    }
  }

  /**
   * Execute a subtask on the local agent
   * Uses processStream with suppressComplete and rendererConversationId
   * for real-time thought forwarding to the parent conversation
   */
  private async executeLocally(
    subtask: SubagentTask,
    agent: AgentInstance,
    team: AgentTeam,
  ): Promise<void> {
    log.info(` Executing locally on agent ${agent.id}`);

    const { getOrCreateV2Session, createSessionState } = await import('./session-manager');
    const { getConfig } = await import('../config.service');
    const { getApiCredentials } = await import('./helpers');
    const { resolveCredentialsForSdk, buildBaseSdkOptions } = await import('./sdk-config');
    const { getWorkingDir, getHeadlessElectronPath } = await import('./helpers');
    const { processStream } = await import('./stream-processor');

    try {
      const systemPrompt = this.buildSubagentPrompt(subtask, agent.config);
      // Use stable per-agent child conversation ID for context persistence across tasks
      const childConversationId = `${subtask.parentConversationId}:agent-${agent.id}`;

      // --- Persist worker conversation to database ---
      const { createConversationWithId, addMessage, updateLastMessage } =
        await import('../conversation.service');
      createConversationWithId(
        team.spaceId,
        childConversationId,
        `Worker: ${agent.config.name || agent.id}`,
      );
      addMessage(team.spaceId, childConversationId, { role: 'user', content: subtask.task });
      addMessage(team.spaceId, childConversationId, { role: 'assistant', content: '' });

      const config = getConfig();
      const credentials = await getApiCredentials(config);
      const resolvedCredentials = await resolveCredentialsForSdk(credentials);
      const workDir = getWorkingDir(team.spaceId);
      const electronPath = getHeadlessElectronPath();
      const abortController = new AbortController();

      const { createHyperSpaceMcpServer } = await import('./hyper-space-mcp');
      // Pass parentConversationId (not childConversationId) to MCP tools so that
      // report_to_leader and announce_completion inject into the correct leader session
      const hyperSpaceMcp = createHyperSpaceMcpServer(team.spaceId, subtask.parentConversationId, {
        agentRole: 'worker',
        workerId: agent.id,
        workerName: agent.config.name,
      });

      const sdkOptions = buildBaseSdkOptions({
        credentials: resolvedCredentials,
        workDir,
        electronPath,
        spaceId: team.spaceId,
        conversationId: childConversationId,
        abortController,
        stderrHandler: (data: string) => {
          console.error(`[Subagent][${childConversationId}] stderr:`, data);
        },
        mcpServers: { 'hyper-space': hyperSpaceMcp },
        contextWindow: resolvedCredentials.contextWindow,
        agentId: agent.id,
        agentName: agent.config.name || agent.id,
      });

      sdkOptions.systemPrompt = systemPrompt;

      const workerSdkSessionId = this.workerSessionIds.get(childConversationId);
      const session = await getOrCreateV2Session(team.spaceId, childConversationId, {
        sdkOptions,
        sessionId: workerSdkSessionId,
        workDir,
      });

      if (!session) {
        throw new Error('Failed to create session for local subagent');
      }

      const sessionState = createSessionState(team.spaceId, childConversationId, abortController);

      // Notify frontend that a worker has started
      const { sendToRenderer } = await import('./helpers');
      sendToRenderer('worker:started', team.spaceId, subtask.parentConversationId, {
        agentId: agent.id,
        agentName: agent.config.name || agent.id,
        taskId: subtask.id,
        task: subtask.task,
        type: 'local',
        interactionMode: 'delegation',
      });

      // Process stream with events forwarded to parent conversation
      const streamResult = await processStream({
        v2Session: session,
        sessionState,
        spaceId: team.spaceId,
        conversationId: childConversationId,
        rendererConversationId: subtask.parentConversationId, // Forward to parent UI
        suppressComplete: true, // Don't signal parent conversation as complete
        workerInfo: { agentId: agent.id, agentName: agent.config.name || agent.id }, // Tag events for worker panel
        messageContent: subtask.task,
        displayModel: resolvedCredentials.displayModel || 'claude-sonnet-4-6',
        abortController,
        t0: Date.now(),
        contextWindow: resolvedCredentials.contextWindow,
        callbacks: {
          onComplete: (result) => {
            // Accumulate worker thoughts into team for batch persistence
            if (result.thoughts.length > 0) {
              team.turnThoughts.push(...result.thoughts);
            }
            // Save SDK session ID for future session resumption
            if (result.capturedSessionId) {
              this.workerSessionIds.set(childConversationId, result.capturedSessionId);
            }
            // Persist worker response to child conversation
            try {
              updateLastMessage(team.spaceId, childConversationId, {
                content: result.finalContent,
                thoughts: result.thoughts.length > 0 ? [...result.thoughts] : undefined,
                tokenUsage: result.tokenUsage || undefined,
              });
            } catch (e) {
              log.error(` Failed to persist worker response to ${childConversationId}:`, e);
            }
          },
        },
      });

      const result = streamResult.finalContent;

      // Notify frontend that worker has completed
      sendToRenderer('worker:completed', team.spaceId, subtask.parentConversationId, {
        agentId: agent.id,
        agentName: agent.config.name || agent.id,
        taskId: subtask.id,
        result,
        status: 'completed',
      });

      // Announce completion — skip if worker already called announce_completion MCP tool
      const localTask = this.tasks.get(subtask.id);
      if (!localTask || (localTask.status !== 'completed' && localTask.status !== 'failed')) {
        await this.sendAnnouncement({
          type: 'agent:announce',
          taskId: subtask.id,
          agentId: agent.id,
          status: 'completed',
          result,
          summary: this.summarizeResult(result),
          timestamp: Date.now(),
        });
      } else {
        log.debug(
          ` Local task ${subtask.id} already announced via MCP tool, skipping sendAnnouncement`,
        );
      }

      agent.status = 'idle';
      log.debug(` Local subtask ${subtask.id} completed`);
    } catch (error) {
      // Notify frontend that worker has failed
      const { sendToRenderer } = await import('./helpers');

      // Persist error to child conversation
      try {
        const childConversationId = `${subtask.parentConversationId}:agent-${agent.id}`;
        const {
          createConversationWithId: cc,
          addMessage: am,
          updateLastMessage: um,
        } = await import('../conversation.service');
        cc(team.spaceId, childConversationId, `Worker: ${agent.config.name || agent.id}`);
        am(team.spaceId, childConversationId, { role: 'user', content: subtask.task });
        am(team.spaceId, childConversationId, { role: 'assistant', content: '' });
        um(team.spaceId, childConversationId, {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (persistErr) {
        log.error(` Failed to persist worker error:`, persistErr);
      }

      sendToRenderer('worker:completed', team.spaceId, subtask.parentConversationId, {
        agentId: agent.id,
        agentName: agent.config.name || agent.id,
        taskId: subtask.id,
        result: '',
        error: error instanceof Error ? error.message : String(error),
        status: 'failed',
      });
      throw error;
    }
  }

  /**
   * Execute a subtask on a remote agent
   * Aligned with executeAgentRemotely for SSH tunnel, credentials, and event handling
   */
  private async executeRemotely(
    subtask: SubagentTask,
    agent: AgentInstance,
    team: AgentTeam,
  ): Promise<void> {
    log.debug(` Executing subtask ${subtask.id} remotely on agent ${agent.id}`);

    const { RemoteWsClient } = await import('../remote/ws/remote-ws-client');
    const { getRemoteDeployService } = await import('../../ipc/remote-server');
    const { sendToRenderer } = await import('./helpers');
    const { getConfig } = await import('../config.service');
    const { decryptString } = await import('../auth/secure-storage.service');
    const sshTunnelService = (await import('../remote/ssh/ssh-tunnel.service')).default;

    const remoteServerId = agent.config.remoteServerId;
    if (!remoteServerId) {
      throw new Error(`Remote agent ${agent.id} has no remoteServerId configured`);
    }

    // Get remote server info
    const deployService = getRemoteDeployService();
    const serverInfo = deployService.getServer(remoteServerId);
    if (!serverInfo) {
      throw new Error(`Remote server ${remoteServerId} not found`);
    }

    // Resolve API credentials — server card config takes precedence, then global AI source
    const config = getConfig();
    const currentSource = config.aiSources?.sources?.find(
      (s) => s.id === config.aiSources?.currentId,
    );
    const apiKeyRaw = serverInfo.claudeApiKey || currentSource?.apiKey || config.api?.apiKey;
    const apiKey = apiKeyRaw ? decryptString(apiKeyRaw) : undefined;
    const baseUrl = serverInfo.claudeBaseUrl || currentSource?.apiUrl;
    const model =
      serverInfo.claudeModel || currentSource?.model || config.api?.model || 'claude-sonnet-4-6';

    log.debug(` Remote subtask using model: ${model}, hasApiKey: ${!!apiKey}`);

    // Build subagent-specific system prompt (includes worker role context)
    const systemPrompt = this.buildSubagentPrompt(subtask, agent.config);

    // Use stable per-agent child conversation ID for context persistence across tasks
    const childConversationId = `${subtask.parentConversationId}:agent-${agent.id}`;

    // --- Persist worker conversation to database ---
    const {
      createConversationWithId,
      addMessage: addWorkerMsg,
      updateLastMessage: updateWorkerMsg,
    } = await import('../conversation.service');
    createConversationWithId(
      team.spaceId,
      childConversationId,
      `Worker: ${agent.config.name || agent.id}`,
    );
    addWorkerMsg(team.spaceId, childConversationId, { role: 'user', content: subtask.task });
    addWorkerMsg(team.spaceId, childConversationId, { role: 'assistant', content: '' });

    // Determine if SSH tunnel should be used (default: true for security)
    const useSshTunnel = agent.config.useSshTunnel ?? true;
    let localTunnelPort = serverInfo.assignedPort;

    // Establish SSH tunnel if required
    if (useSshTunnel) {
      log.debug(
        ` Establishing SSH tunnel for subtask to ${serverInfo.host}:${serverInfo.assignedPort}...`,
      );

      const decryptedPassword = decryptString(serverInfo.password || '');

      try {
        localTunnelPort = await sshTunnelService.establishTunnel({
          spaceId: team.spaceId,
          serverId: remoteServerId,
          host: serverInfo.host,
          port: serverInfo.sshPort || 22,
          username: serverInfo.username,
          password: decryptedPassword,
          localPort: serverInfo.assignedPort,
          remotePort: serverInfo.assignedPort,
        });
        log.info(` SSH tunnel established for subtask on local port ${localTunnelPort}`);
      } catch (tunnelError) {
        log.error('Failed to establish SSH tunnel for subtask:', tunnelError);
        throw new Error(
          `SSH tunnel failed: ${tunnelError instanceof Error ? tunnelError.message : String(tunnelError)}`,
        );
      }
    }

    // Create WebSocket client with proper configuration
    const client = new RemoteWsClient(
      {
        serverId: remoteServerId,
        host: useSshTunnel ? 'localhost' : serverInfo.host,
        port: useSshTunnel ? localTunnelPort : serverInfo.assignedPort,
        authToken: serverInfo.authToken || '',
        useSshTunnel,
        apiKey: apiKey || undefined,
        baseUrl: currentSource?.apiUrl || undefined,
        model: model || undefined,
      },
      childConversationId,
    );

    // Set up event handlers for streaming (forward to parent conversation for UI display)
    let streamingContent = '';
    const streamChunks2: string[] = [];
    const thoughts: any[] = []; // Accumulate thoughts for persistence
    const workerTag = { agentId: agent.id, agentName: agent.config.name || agent.id };

    // Notify frontend that a worker has started
    sendToRenderer('worker:started', team.spaceId, subtask.parentConversationId, {
      ...workerTag,
      taskId: subtask.id,
      task: subtask.task,
      type: 'remote',
      serverName: serverInfo.name || undefined,
      interactionMode: 'delegation',
    });

    // SDK session ID event - for session resumption
    client.on('claude:session', (data: any) => {
      if (data.sessionId === childConversationId) {
        const receivedSdkSessionId = data.data?.sdkSessionId;
        if (receivedSdkSessionId) {
          log.debug(` Captured SDK session_id for subtask: ${receivedSdkSessionId}`);
          this.workerSessionIds.set(childConversationId, receivedSdkSessionId);
        }
      }
    });

    client.on('claude:stream', (data: any) => {
      if (data.sessionId === childConversationId) {
        const text = data.data?.text || data.data?.content || '';
        streamChunks2.push(text);
        streamingContent = streamChunks2.join('');

        // Update worker heartbeat to prevent false-positive stall detection
        agent.lastHeartbeat = Date.now();

        // Emit progress event and forward to UI
        this.emit('subagent:progress', {
          taskId: subtask.id,
          agentId: agent.id,
          delta: text,
          total: streamingContent,
        });

        // Forward streaming text to renderer (parent conversation) with worker tag
        sendToRenderer('agent:message', team.spaceId, subtask.parentConversationId, {
          type: 'message',
          delta: text,
          isComplete: false,
          isStreaming: true,
          ...workerTag,
        });
      }
    });

    client.on('thought', (data: any) => {
      if (data.sessionId === childConversationId) {
        const thoughtData = data.data;
        thoughts.push(thoughtData); // Accumulate for persistence
        agent.lastHeartbeat = Date.now(); // Keep heartbeat alive during thinking
        sendToRenderer('agent:thought', team.spaceId, subtask.parentConversationId, {
          thought: thoughtData,
          ...workerTag,
        });
      }
    });

    client.on('thought:delta', (data: any) => {
      if (data.sessionId === childConversationId) {
        const deltaData = data.data;
        // Update accumulated thought state
        const thought = thoughts.find((t: any) => t.id === deltaData.thoughtId);
        if (thought) {
          if (deltaData.content) thought.content = deltaData.content;
          if (deltaData.toolResult) thought.toolResult = deltaData.toolResult;
          if (deltaData.toolInput) thought.toolInput = deltaData.toolInput;
          if (deltaData.isComplete !== undefined) thought.isStreaming = !deltaData.isComplete;
          if (deltaData.isReady !== undefined) thought.isReady = deltaData.isReady;
        }
        sendToRenderer('agent:thought-delta', team.spaceId, subtask.parentConversationId, {
          ...deltaData,
          ...workerTag,
        });
      }
    });

    client.on('tool:call', (data: any) => {
      if (data.sessionId === childConversationId) {
        const toolData = data.data;

        // Check if this is a hyper-space proxy tool call from remote worker
        // Hyper-space tools have isHyperSpace=true flag set by the proxy
        if (toolData?.isHyperSpace) {
          this.handleHyperSpaceToolCall(
            team,
            agent,
            subtask.parentConversationId,
            toolData,
            client,
          );
          return;
        }

        // Regular tool call — just forward to UI
        sendToRenderer('agent:tool-call', team.spaceId, subtask.parentConversationId, {
          id: toolData?.id,
          name: toolData?.name,
          status: toolData?.status || 'running',
          input: toolData?.input || {},
          requiresApproval: false,
          ...workerTag,
        });
      }
    });

    client.on('tool:result', (data: any) => {
      if (data.sessionId === childConversationId) {
        sendToRenderer('agent:tool-result', team.spaceId, subtask.parentConversationId, {
          toolId: data.data?.id,
          result: data.data?.output || '',
          isError: false,
          ...workerTag,
        });
      }
    });

    try {
      // Connect to remote server
      log.debug(` Connecting to remote server for subtask...`);
      await client.connect();
      log.debug(` Connected, sending subtask to remote agent...`);

      // Send the task with full configuration (API key, model, maxTokens, system prompt)
      // Include hyperSpaceTools config so the remote proxy creates MCP proxy tools
      const workerSdkSessionId = this.workerSessionIds.get(childConversationId);
      const response = await client.sendChatWithStream(
        childConversationId,
        [{ role: 'user', content: subtask.task }],
        {
          apiKey,
          baseUrl: baseUrl || undefined,
          model,
          maxTokens: config.agent?.maxTokens || 8192,
          system: systemPrompt,
          workDir: agent.config.remotePath || '/home',
          sdkSessionId: workerSdkSessionId || undefined,
          hyperSpaceTools: {
            spaceId: team.spaceId,
            conversationId: subtask.parentConversationId,
            workerId: agent.id,
            workerName: agent.config.name || agent.id,
            teamId: team.id,
          },
        },
      );

      // Use the accumulated streaming content or response content
      const result = streamingContent || response.content || '';

      // Persist worker response to child conversation
      try {
        updateWorkerMsg(team.spaceId, childConversationId, {
          content: result,
          thoughts: thoughts.length > 0 ? [...thoughts] : undefined,
        });
      } catch (e) {
        log.error(` Failed to persist remote worker response to ${childConversationId}:`, e);
      }

      // Disconnect
      client.disconnect();

      // Notify frontend that worker has completed
      sendToRenderer('worker:completed', team.spaceId, subtask.parentConversationId, {
        ...workerTag,
        taskId: subtask.id,
        result,
        status: 'completed',
      });

      // Announce completion — but skip if remote worker already called announce_completion
      // via MCP tool (handleHyperSpaceToolCall already processed it, preventing double injection)
      const currentTask = this.tasks.get(subtask.id);
      if (!currentTask || (currentTask.status !== 'completed' && currentTask.status !== 'failed')) {
        await this.sendAnnouncement({
          type: 'agent:announce',
          taskId: subtask.id,
          agentId: agent.id,
          status: 'completed',
          result,
          summary: this.summarizeResult(result),
          timestamp: Date.now(),
        });
      } else {
        log.debug(` Task ${subtask.id} already announced via MCP tool, skipping sendAnnouncement`);
      }

      // Accumulate worker thoughts into team for batch persistence
      if (thoughts.length > 0) {
        team.turnThoughts.push(...thoughts);
      }

      agent.status = 'idle';
      log.debug(` Remote subtask ${subtask.id} completed, result length: ${result.length}`);
    } catch (error) {
      client.disconnect();

      // Persist error to child conversation
      try {
        const {
          createConversationWithId: cc,
          addMessage: am,
          updateLastMessage: um,
        } = await import('../conversation.service');
        const childConvId = `${subtask.parentConversationId}:agent-${agent.id}`;
        cc(team.spaceId, childConvId, `Worker: ${agent.config.name || agent.id}`);
        am(team.spaceId, childConvId, { role: 'user', content: subtask.task });
        am(team.spaceId, childConvId, { role: 'assistant', content: '' });
        um(team.spaceId, childConvId, {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (persistErr) {
        log.error(` Failed to persist remote worker error:`, persistErr);
      }

      // Notify frontend that worker has failed
      sendToRenderer('worker:completed', team.spaceId, subtask.parentConversationId, {
        ...workerTag,
        taskId: subtask.id,
        result: '',
        error: error instanceof Error ? error.message : String(error),
        status: 'failed',
      });
      throw error;
    }
  }

  /**
   * Summarize a result for the announcement
   */
  private summarizeResult(result: string): string {
    const maxLen = 200;
    if (result.length <= maxLen) return result;
    return result.substring(0, maxLen) + '...';
  }

  /**
   * Persist accumulated worker thoughts to the parent conversation.
   * Called after all workers complete in executeAllTasks.
   * Merges worker thoughts with existing leader thoughts in the conversation.
   */
  private persistWorkerThoughts(team: AgentTeam): void {
    if (!team.conversationId || team.turnThoughts.length === 0) return;

    try {
      const conversation = getConversation(team.spaceId, team.conversationId);
      const lastMsg = conversation?.messages?.[conversation.messages.length - 1];
      if (!lastMsg) {
        log.warn(` No last message found for thought persistence`);
        return;
      }

      // Read existing thoughts (from leader's processStream)
      const existingThoughts = getMessageThoughts(team.spaceId, team.conversationId, lastMsg.id);

      // Merge: leader thoughts + worker thoughts
      const allThoughts = [...existingThoughts, ...team.turnThoughts];

      // Extract file changes from all thoughts
      let metadata: { fileChanges?: any } | undefined;
      try {
        const fileChangesSummary = extractFileChangesSummaryFromThoughts(allThoughts);
        if (fileChangesSummary) {
          metadata = { fileChanges: fileChangesSummary };
        }
      } catch (e) {
        log.error(` Failed to extract file changes for merged thoughts:`, e);
      }

      updateLastMessage(team.spaceId, team.conversationId, {
        thoughts: allThoughts,
        metadata,
      });

      console.log(
        `[Orchestrator] Persisted ${team.turnThoughts.length} worker thoughts ` +
          `(merged with ${existingThoughts.length} existing thoughts) to conversation ${team.conversationId}`,
      );
    } catch (e) {
      log.error(` Failed to persist worker thoughts:`, e);
    }
  }

  /**
   * Execute all pending tasks in a team
   * This is called after dispatchTask to actually run the tasks
   */
  async executeAllTasks(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      log.warn(` Team ${teamId} not found for execution`);
      return;
    }

    // Get all pending tasks for this team
    const pendingTasks = Array.from(this.tasks.values()).filter((t) => t.status === 'pending');

    log.debug(` Executing ${pendingTasks.length} pending tasks for team ${teamId}`);

    // Reset worker thoughts accumulator for this execution cycle
    team.turnThoughts = [];

    // Execute tasks in parallel based on execution mode
    if (team.config.mode === 'sequential') {
      for (const task of pendingTasks) {
        const agent = this.findAgentForTask(team, task);
        if (agent) {
          await this.executeSubtask(task, agent, team);
        }
      }
    } else {
      // Parallel execution (default)
      await Promise.all(
        pendingTasks.map(async (task) => {
          const agent = this.findAgentForTask(team, task);
          if (agent) {
            await this.executeSubtask(task, agent, team);
          }
        }),
      );
    }

    // Persist accumulated worker thoughts to parent conversation
    this.persistWorkerThoughts(team);
  }

  /**
   * Find the agent instance for a given task
   */
  private findAgentForTask(team: AgentTeam, task: SubagentTask): AgentInstance | null {
    // Check workers first
    const worker = team.workers.find((w) => w.id === task.agentId);
    if (worker) return worker;

    // Check leader
    if (team.leader.id === task.agentId) return team.leader;

    return null;
  }

  /**
   * Dispatch and execute a task in one call
   * This is the main entry point for Hyper Space task execution
   */
  async dispatchAndExecute(params: {
    spaceId: string;
    task: string;
    conversationId: string;
  }): Promise<SubagentTask[]> {
    const team = this.getTeamBySpace(params.spaceId);
    if (!team) {
      throw new Error(`[Orchestrator] No team found for space ${params.spaceId}`);
    }

    // Update team's conversation ID if not set
    if (!team.conversationId) {
      team.conversationId = params.conversationId;
    }

    // Dispatch tasks
    const tasks = await this.dispatchTask({
      teamId: team.id,
      task: params.task,
      conversationId: params.conversationId,
    });

    // Execute all tasks
    await this.executeAllTasks(team.id);

    return tasks;
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    this.stopStallDetection();
    this.teams.clear();
    this.teamsBySpace.clear();
    this.tasks.clear();
    this.pendingAnnouncements.clear();
    this.removeAllListeners();
    // Clean up all injection queues
    try {
      const { clearAllInjections } = require('./stream-processor');
      clearAllInjections();
    } catch (_) {
      /* ignore */
    }
    log.debug('Service destroyed');
  }

  // ============================================
  // Stall Detection
  // ============================================

  /**
   * Start periodic stall detection
   */
  private startStallDetection(): void {
    if (this.stallCheckInterval) return;

    this.stallCheckInterval = setInterval(() => {
      this.checkForStalledTasks();
    }, this.stallConfig.checkInterval);

    log.debug('Stall detection started');
  }

  /**
   * Stop stall detection
   */
  private stopStallDetection(): void {
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
      log.debug('Stall detection stopped');
    }
  }

  /**
   * Check for stalled tasks
   */
  private checkForStalledTasks(): void {
    const now = Date.now();

    for (const [taskId, task] of this.tasks) {
      if (task.status !== 'running') continue;

      // Find the agent for this task
      const team = this.getTeamByConversation(task.parentConversationId);
      if (!team) continue;

      const agent = this.findAgentForTask(team, task);
      if (!agent) continue;

      let isStalled = false;

      // Check for heartbeat timeout
      if (agent.lastHeartbeat) {
        const timeSinceHeartbeat = now - agent.lastHeartbeat;
        if (timeSinceHeartbeat > this.stallConfig.heartbeatTimeout) {
          isStalled = true;
          console.warn(
            `[Orchestrator] Task ${taskId} stalled — no heartbeat for ${Math.round(timeSinceHeartbeat / 1000)}s`,
          );
          this.emit('task:stalled', {
            taskId,
            agentId: agent.id,
            reason: 'heartbeat_timeout',
            elapsed: timeSinceHeartbeat,
          });
        }
      }

      // Check for max task duration
      if (!isStalled && task.startedAt) {
        const duration = now - task.startedAt;
        if (duration > this.stallConfig.maxTaskDuration) {
          isStalled = true;
          console.warn(
            `[Orchestrator] Task ${taskId} exceeded max duration (${Math.round(duration / 1000)}s)`,
          );
          this.emit('task:stalled', {
            taskId,
            agentId: agent.id,
            reason: 'max_duration',
            elapsed: duration,
          });
        }
      }

      // When stalled: clean up pending announcements so waitForCompletion won't hang
      if (isStalled) {
        const pending = this.pendingAnnouncements.get(task.parentConversationId);
        if (pending && pending.has(taskId)) {
          pending.delete(taskId);
          log.debug(` Removed stalled task ${taskId} from pendingAnnouncements`);
        }
        this.updateTaskStatus(
          taskId,
          'failed',
          undefined,
          'Task stalled: no heartbeat or exceeded max duration',
        );
        agent.status = 'error';
      }
    }
  }

  /**
   * Get team by conversation ID
   */
  private getTeamByConversation(conversationId: string): AgentTeam | undefined {
    for (const team of this.teams.values()) {
      if (team.conversationId === conversationId) {
        return team;
      }
    }
    return undefined;
  }

  /**
   * Update stall detection configuration
   */
  setStallConfig(config: Partial<StallDetectionConfig>): void {
    this.stallConfig = { ...this.stallConfig, ...config };

    // Restart stall detection with new interval if changed
    if (config.checkInterval !== undefined) {
      this.stopStallDetection();
      this.startStallDetection();
    }
  }

  // ============================================
  // Inter-Agent Messaging
  // ============================================

  /**
   * Send a message from one agent to another
   * The message will be visible in the chat UI
   * For remote recipients, the message is dispatched as a subtask
   */
  async sendAgentMessage(params: {
    teamId: string;
    spaceId: string;
    conversationId: string;
    recipientId: string;
    recipientName: string;
    content: string;
    summary?: string;
    senderId?: string;
    senderName?: string;
  }): Promise<string> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    log.debug(` Sending agent message: ${messageId} to ${params.recipientId}`);

    // Import sendToRenderer dynamically to avoid circular dependencies
    const { sendToRenderer } = await import('./helpers');

    // Emit agent message event to show in chat UI
    sendToRenderer('agent:team-message', params.spaceId, params.conversationId, {
      id: messageId,
      type: 'agent_message',
      senderId: params.senderId,
      senderName: params.senderName,
      recipientId: params.recipientId,
      recipientName: params.recipientName,
      content: params.content,
      summary: params.summary || params.content.substring(0, 100),
      timestamp: Date.now(),
    });

    // If the recipient is a remote agent, dispatch the message as a subtask
    // so it gets executed on the remote server
    const team = this.teams.get(params.teamId);
    if (team) {
      const recipient =
        team.workers.find((w) => w.id === params.recipientId) ||
        (team.leader.id === params.recipientId ? team.leader : null);

      if (recipient && recipient.config.type === 'remote') {
        log.debug(` Dispatching message to remote agent: ${params.recipientId}`);

        // Format the message as a task for the remote agent
        const taskContent = `[Message from ${params.recipientName === recipient.config.name ? 'team leader' : params.recipientName}]\n\n${params.content}`;

        // Create and execute a subtask for the remote agent (fire-and-forget)
        const subtask = this.createSubtask({
          team,
          agent: recipient,
          task: taskContent,
          conversationId: params.conversationId,
        });

        // Execute asynchronously without blocking the sender
        this.executeSubtask(subtask, recipient, team).catch((err) => {
          log.error(` Failed to deliver message to remote agent ${params.recipientId}:`, err);
        });
      }

      // If the recipient is the leader, inject the message into the leader's session
      // so the leader's LLM can actually process it (not just show in UI)
      // Skip UI notification since sendAgentMessage already sent one above
      if (recipient && recipient.id === team.leader.id) {
        await this.injectMessageToSession(
          params.spaceId,
          params.conversationId,
          params.content,
          true, // skip UI notification — already sent by sendAgentMessage
        );
      }

      // Persist message to mailbox for durability
      if (mailboxService.isInitialized(params.spaceId)) {
        mailboxService.postMessage(params.spaceId, params.recipientId, {
          type:
            params.recipientId === 'leader' || params.recipientId === team.leader.id
              ? 'direct'
              : 'direct',
          senderId: params.senderId || 'unknown',
          senderName: params.senderName || 'Unknown',
          recipientId: params.recipientId,
          content: params.content,
        });
      }
    }

    return messageId;
  }

  /**
   * Broadcast a message to all agents in the team
   */
  async broadcastAgentMessage(params: {
    teamId: string;
    spaceId: string;
    conversationId: string;
    content: string;
    summary?: string;
  }): Promise<string[]> {
    const team = this.teams.get(params.teamId);
    if (!team) {
      log.warn(` Team ${params.teamId} not found for broadcast`);
      return [];
    }

    log.debug(` Broadcasting message to team ${params.teamId}`);

    const messageIds: string[] = [];

    // Send to leader
    messageIds.push(
      await this.sendAgentMessage({
        teamId: params.teamId,
        spaceId: params.spaceId,
        conversationId: params.conversationId,
        recipientId: team.leader.id,
        recipientName: team.leader.config.name || team.leader.id,
        content: params.content,
        summary: params.summary,
      }),
    );

    // Send to all workers
    for (const worker of team.workers) {
      messageIds.push(
        await this.sendAgentMessage({
          teamId: params.teamId,
          spaceId: params.spaceId,
          conversationId: params.conversationId,
          recipientId: worker.id,
          recipientName: worker.config.name || worker.id,
          content: params.content,
          summary: params.summary,
        }),
      );
    }

    // Persist broadcast to mailbox as a single chat message
    // (individual sendAgentMessage calls also write, so we skip here
    //  since the per-agent messages are already in the mailbox)

    return messageIds;
  }

  /**
   * Get team context string for system prompts
   * This provides agents with information about their teammates and how to collaborate
   */
  async getTeamContextForPrompt(spaceId: string, currentAgentId: string): Promise<string> {
    const team = this.getTeamBySpace(spaceId);
    if (!team) {
      return '';
    }

    const isLeader = team.leader.id === currentAgentId;

    if (isLeader) {
      return await this.buildLeaderSystemPrompt(team);
    } else {
      return await this.buildWorkerSystemPrompt(team, currentAgentId);
    }
  }

  /**
   * Build system prompt for the LEADER agent
   * This is the key prompt that enables automatic task distribution
   */
  private async buildLeaderSystemPrompt(team: AgentTeam): Promise<string> {
    // Build shared team context (visible to all agents)
    const sharedContext = await this.buildSharedTeamContext(team);

    // Leader-specific instructions
    let context = '\n\n' + '='.repeat(60) + '\n';
    context += '## YOU ARE THE TEAM LEADER\n';
    context += '='.repeat(60) + '\n\n';

    context += `You are the **LEADER** of a multi-agent team. You have ${team.workers.length} worker agent(s) available to execute tasks.\n\n`;

    // ====================================================================
    // CRITICAL: Task Delegation
    // ====================================================================
    context += '### CRITICAL: Task Delegation\n\n';
    context += 'You have ONE way to delegate work:\n\n';
    context +=
      '**`spawn_subagent` (MCP tool)** — Assigns a task to a **team Worker**. The worker executes the task in its own Claude Code session on its own machine.\n';
    context +=
      '   - For **remote** workers: the task runs directly on the remote server. The worker does NOT need SSH — it is already there.\n';
    context +=
      '   - For **local** workers: the task runs on this machine as a separate Claude Code session.\n';
    context +=
      "   - Use when the task matches a Worker's **capabilities** or needs to run on a specific machine.\n\n";
    context +=
      '**RULE: NEVER use the built-in Agent/Task tool — all delegation MUST go through `spawn_subagent`. The Agent/Task tool is DISABLED for your session.**\n\n';

    // ====================================================================
    // CRITICAL: Capability-based routing
    // ====================================================================
    context += '### CRITICAL: Route Tasks by Worker Capabilities\n\n';
    context += 'You MUST match tasks to Workers based on their declared capabilities:\n\n';

    // Build a capability routing table from actual worker configs
    for (const worker of team.workers) {
      const caps = worker.config.capabilities || [];
      if (caps.length === 0) continue;
      const workerName = worker.config.name || worker.id;
      const location =
        worker.config.type === 'remote'
          ? `remote server (${worker.config.environment?.ip || worker.config.remoteServerId || 'unknown'})`
          : 'local machine';
      context += `- **${workerName}** (${location}): ${caps.join(', ')}\n`;
    }
    context += '\n';
    context +=
      'When a user request involves any of the capabilities listed above, delegate to the matching Worker via `spawn_subagent` with the correct `targetAgentId`.\n\n';

    // ====================================================================
    // TASK PLANNING — the most critical section
    // ====================================================================
    context += '### Task Planning Workflow (MUST FOLLOW):\n\n';
    context += 'When you receive a user request, follow this EXACT workflow:\n\n';
    context += '**Step 1: Analyze & Plan**\n';
    context += "- First, analyze the user's request carefully\n";
    context += '- Break it down into a step-by-step plan in your thinking\n';
    context += '- Present the plan to the user as a numbered todolist with clear descriptions\n';
    context += '- Do NOT dispatch any tasks until the plan is shown\n\n';

    context += '**Step 2: Plan Granularity Guidelines**\n';
    context +=
      '- Each subtask should be a **single, well-defined action** that one worker can complete independently\n';
    context +=
      '- A good subtask can be described in 1-2 sentences and has a clear success criterion\n';
    context +=
      '- Avoid overly broad tasks like "set up the server" — break into "install Docker", "configure network", "start the service"\n';
    context +=
      '- Avoid overly tiny tasks like "create file X" if it\'s part of a logical unit — group related file operations\n';
    context += '- A typical subtask takes one worker one execution turn to complete\n';
    context += '- If a task requires more than 3-4 steps internally, split it further\n\n';

    context += '**Step 3: Incremental Execution**\n';
    context +=
      '- Dispatch subtasks **incrementally**: assign the first step, wait for the worker to report back, review the result, then assign the next step\n';
    context +=
      '- This allows you to catch errors early and adjust the plan based on actual results\n';
    context +=
      '- Only use parallel dispatch (`spawn_subagent` multiple times) when subtasks are truly independent (no data dependencies)\n';
    context += '- Update the user on progress as each step completes\n\n';

    context += '**Step 4: Result Aggregation**\n';
    context += '- As workers report back, verify the output matches expectations\n';
    context +=
      "- If a worker's result is incomplete or incorrect, adjust the task description and retry\n";
    context += '- Once all steps are done, provide a final summary to the user\n\n';

    // How to delegate
    context += '### How to Delegate Tasks to Workers:\n\n';
    context += 'Use the `spawn_subagent` tool to assign tasks to workers.\n\n';
    context +=
      '**Recommended**: Always specify `targetAgentId` to send tasks to a specific worker:\n\n';
    context += '```json\n';
    context += '{\n';
    context += '  "task": "Check NPU device status on this server",\n';
    context += '  "targetAgentId": "' + (team.workers[0]?.id || 'worker-1') + '"\n';
    context += '}\n';
    context += '```\n\n';
    context +=
      'If you omit `targetAgentId`, the task will be routed automatically based on the routing strategy.\n\n';

    context += '**Task description best practices:**\n';
    context += '- Include clear context: what, where, and any specific requirements\n';
    context += '- Reference previous results if this step depends on earlier work\n';
    context += '- Specify the expected output format if relevant\n\n';

    // Parallel execution guidance
    context += '### Parallel Execution:\n\n';
    context +=
      '- Only dispatch tasks in parallel when they are **truly independent** (no shared files, no data dependencies)\n';
    context += '- Each worker will execute independently and report back\n';
    context += '- Match task requirements to worker capabilities for best results\n';
    context +=
      '- Use `wait_for_team` after dispatching tasks to wait for all workers to complete and collect results\n\n';

    // Important rules
    context += '### Important Rules:\n\n';
    context +=
      '1. **NEVER use the built-in Agent/Task tool** — These tools are DISABLED for your session. All task delegation MUST use `spawn_subagent` with the matching `targetAgentId`.\n';
    context +=
      '2. **Remote workers execute directly on their server** — A remote worker is already running on its server. When you assign a task to it, the worker executes commands directly there. Do NOT instruct workers to SSH anywhere.\n';
    context +=
      '3. **Match tasks to Worker capabilities** — Always check Worker capabilities before delegating. Use `list_team_members` to see available Workers and their capabilities.\n';
    context +=
      '4. **Plan first, then execute** — Always show the user your plan before dispatching any tasks\n';
    context +=
      '5. **DO NOT poll** - Do NOT use sessions_list, sessions_history, or sleep to check status\n';
    context +=
      '6. **Automatic result collection** - Workers will automatically announce completion to you. You do NOT need to call `wait_for_team` — worker results will be delivered to you automatically even if you stop generating.\n';
    context +=
      '7. **Incremental delegation** - Dispatch one step at a time unless tasks are truly parallel\n';
    context +=
      '8. **Verify results** - Check worker output quality before proceeding to the next step\n';
    context +=
      '9. **Adapt the plan** - If a step fails or produces unexpected results, adjust the plan\n';
    context += '10. **Handle failures** - If a worker fails, you can retry or report the issue\n';
    context +=
      '11. **Use `wait_for_team` optionally** - If you want to collect all results at once before processing, use `wait_for_team`. But it is not required — results will be delivered to you automatically.\n';
    context +=
      '12. **Workers can reach out to you** - Workers may send progress updates via `report_to_leader`, ask questions via `ask_question`, or contact other workers via `send_message`. Respond promptly when they need help.\n\n';

    // Communication tools
    context += '### Communication Tools:\n\n';
    context += '- `spawn_subagent` - Assign a task to a worker\n';
    context += '- `check_subagent_status` - Check task progress (use sparingly)\n';
    context += '- `list_team_members` - Get detailed team info\n';
    context += '- `send_message` - Send a message to a specific worker\n';
    context += '- `broadcast_message` - Send a message to all workers\n';
    context += '- `wait_for_team` - Wait for all pending tasks to complete (optional)\n\n';

    context += '='.repeat(60) + '\n\n';

    return sharedContext + context;
  }

  /**
   * Build shared team context — visible to ALL agents (leader and workers)
   * Includes all agent identities, capabilities, and environment credentials
   */
  private async buildSharedTeamContext(team: AgentTeam): Promise<string> {
    let context = '\n\n' + '='.repeat(60) + '\n';
    context += '## HYPER SPACE: TEAM CONTEXT\n';
    context += '='.repeat(60) + '\n\n';

    context += '### Team Members:\n\n';

    // Leader info
    const leaderCaps = team.leader.config.capabilities?.length
      ? team.leader.config.capabilities.join(', ')
      : 'general purpose';
    context += `**${team.leader.config.name || team.leader.id}** (Leader, Local)\n`;
    context += `- ID: \`${team.leader.id}\`\n`;
    context += `- Capabilities: ${leaderCaps}\n\n`;

    // Workers info
    if (team.workers.length > 0) {
      for (const worker of team.workers) {
        const capabilities = worker.config.capabilities?.length
          ? worker.config.capabilities.join(', ')
          : 'general purpose';
        const agentType = worker.config.type === 'remote' ? 'Remote' : 'Local';

        context += `**${worker.config.name || worker.id}** (Worker, ${agentType})\n`;
        context += `- ID: \`${worker.id}\`\n`;
        context += `- Capabilities: ${capabilities}\n`;

        if (worker.config.type === 'remote' && worker.config.environment) {
          const env = worker.config.environment;
          context += `- Server: ${env.ip}${env.port && env.port !== 22 ? `:${env.port}` : ''}\n`;
        } else if (worker.config.type === 'remote' && worker.config.remoteServerId) {
          // Fallback: show server ID if environment not configured
          context += `- Remote Server: ${worker.config.remoteServerId}\n`;
        }
        context += '\n';
      }
    }

    // Execution model explanation
    context += '### Execution Model:\n\n';
    context += '**IMPORTANT — Understand how workers execute tasks:**\n\n';
    context +=
      '- A **Local** worker runs on this machine. When you assign a task to a local worker, it executes commands directly on this machine using its own Claude Code session.\n';
    context +=
      '- A **Remote** worker already lives on its designated remote server. When you assign a task to a remote worker, it executes commands **directly on that remote server** — it does NOT need to SSH into anything. The remote worker has its own Claude Code session running on that server.\n';
    context +=
      '- Workers can communicate with each other and with you via `send_message`, `ask_question`, and `report_to_leader`. Workers may proactively reach out when they need help.\n\n';

    context += '='.repeat(60) + '\n\n';

    return context;
  }

  /**
   * Build system prompt for WORKER agents
   */
  private async buildWorkerSystemPrompt(team: AgentTeam, currentAgentId: string): Promise<string> {
    // Build shared team context (same context visible to all agents)
    const sharedContext = await this.buildSharedTeamContext(team);

    // Worker-specific instructions
    const currentWorker = team.workers.find((w) => w.id === currentAgentId);
    const workerName = currentWorker?.config.name || currentAgentId;

    let context = '\n\n' + '='.repeat(60) + '\n';
    context += `## YOU ARE A WORKER AGENT: ${workerName}\n`;
    context += '='.repeat(60) + '\n\n';

    // Worker responsibilities
    context += '### Your Responsibilities:\n\n';
    context +=
      '1. Execute tasks assigned by the leader — if you are a remote worker, execute directly on this server; if you are a local worker, execute on this local machine\n';
    context += '2. Report completion using `announce_completion` when done\n';
    context +=
      '3. Proactively report progress, findings, or questions to the leader using `report_to_leader`\n';
    context +=
      '4. If you encounter problems you cannot solve, ask the leader for help using `ask_question`\n';
    context += '5. You can also contact other workers directly via `send_message` if needed\n\n';

    // Communication tools
    context += '### Communication Tools:\n\n';
    context += '- `announce_completion` - Report task completion to leader (ends your task)\n';
    context +=
      '- `report_to_leader` - Send intermediate progress updates to the leader (you continue working)\n';
    context += '- `ask_question` - Ask the leader or user a question when needing clarification\n';
    context += '- `send_message` - Send a message to a specific teammate\n';
    context += '- `broadcast_message` - Send a message to all teammates\n\n';

    context +=
      '**Important**: Use `report_to_leader` during task execution to keep the leader informed. ' +
      'For example, report when you make progress, discover important findings, encounter obstacles, ' +
      'or need guidance. The leader will see your reports in real-time.\n\n';

    context += '='.repeat(60) + '\n\n';

    return sharedContext + context;
  }

  // ============================================
  // Announcement Injection (OpenClaw Pattern)
  // ============================================

  /**
   * Inject a worker's completion announcement into the leader's session.
   *
   * This is the KEY mechanism that enables push-based multi-agent collaboration:
   * Instead of the leader polling for results, the worker's completion is
   * queued via the existing turn-level injection system (queueInjection).
   *
   * This mirrors OpenClaw's "auto-announce" system where:
   * 1. Worker completes task
   * 2. Announcement is sent
   * 3. Announcement is queued as a user message into the leader's stream
   * 4. Leader's LLM naturally processes the result and continues
   */
  private async injectAnnouncementToLeader(announcement: SubagentAnnouncement): Promise<void> {
    // Find the task to get the parent conversation ID
    const task = this.tasks.get(announcement.taskId);
    if (!task) {
      log.warn(` Cannot inject announcement: task ${announcement.taskId} not found`);
      return;
    }

    const parentConversationId = task.parentConversationId;

    // Find the team for this conversation
    const team = this.getTeamByConversation(parentConversationId);
    if (!team) {
      log.warn(` Cannot inject announcement: no team for conversation ${parentConversationId}`);
      return;
    }

    // Guard against infinite spawn loops: track injection cycles per team
    team.spawnCycleCount++;
    if (team.spawnCycleCount > this.maxSpawnDepth) {
      console.warn(
        `[Orchestrator] Spawn cycle limit reached (${team.spawnCycleCount}/${this.maxSpawnDepth}). ` +
          `Dropping announcement to prevent infinite loop.`,
      );
      return;
    }

    // Build the announcement message (formatted as a user message for the leader)
    const announcementMessage = this.formatAnnouncementForLeader(announcement, team);

    await this.injectMessageToSession(team.spaceId, parentConversationId, announcementMessage);

    console.log(
      `[Orchestrator] Injected announcement into leader session: ` +
        `conversation=${parentConversationId}, task=${announcement.taskId}`,
    );
  }

  /**
   * Format an announcement as a user message for the leader agent
   */
  private formatAnnouncementForLeader(announcement: SubagentAnnouncement, team: AgentTeam): string {
    const worker = team.workers.find((w) => w.id === announcement.agentId);
    const workerName = worker?.config.name || announcement.agentId;

    let message = `[Subagent Announcement] Worker "${workerName}" reports:\n\n`;

    if (announcement.status === 'completed') {
      message += `**Status**: Completed\n`;

      if (announcement.summary) {
        message += `**Summary**: ${announcement.summary}\n`;
      }

      if (announcement.result) {
        message += `\n**Result**:\n${announcement.result}\n`;
      }
    } else {
      message += `**Status**: Failed\n`;

      if (announcement.result) {
        message += `**Error**: ${announcement.result}\n`;
      }
    }

    message += `\nTask ID: ${announcement.taskId}`;

    return message;
  }

  /**
   * Persist an announcement to the mailbox system for durability.
   * This ensures all agents can see the announcement even if they
   * were not actively streaming when it was sent.
   */
  private persistAnnouncementToMailbox(announcement: SubagentAnnouncement): void {
    const task = this.tasks.get(announcement.taskId);
    if (!task) return;

    const team = this.getTeamByConversation(task.parentConversationId);
    if (!team) return;
    if (!mailboxService.isInitialized(team.spaceId)) return;

    const worker = team.workers.find((w) => w.id === announcement.agentId);
    const workerName = worker?.config.name || announcement.agentId;

    const msgType = announcement.status === 'completed' ? 'task_completed' : 'task_failed';
    const content =
      announcement.status === 'completed'
        ? `Worker "${workerName}" completed task ${announcement.taskId}${announcement.summary ? ': ' + announcement.summary : ''}`
        : `Worker "${workerName}" failed task ${announcement.taskId}${announcement.result ? ': ' + announcement.result : ''}`;

    mailboxService.broadcastMessage(
      team.spaceId,
      {
        type: msgType,
        senderId: announcement.agentId,
        senderName: workerName,
        content,
        payload: {
          taskId: announcement.taskId,
          result: announcement.result,
          error: announcement.status === 'failed' ? announcement.result : undefined,
        },
      },
      announcement.agentId, // Don't send to self
    );
  }

  /**
   * Inject a message into the leader's active session.
   *
   * Uses the existing turn-level injection system (queueInjection from stream-processor)
   * instead of directly manipulating the session. This avoids:
   * - Session conflicts (two concurrent stream() loops on the same session)
   * - Race conditions with the leader's main stream loop
   *
   * The queued message will be picked up by processStream()'s turn-boundary
   * detection and processed in the existing while(true) loop in send-message.ts.
   */
  private async injectMessageToSession(
    spaceId: string,
    conversationId: string,
    message: string,
    skipUiNotification = false,
  ): Promise<void> {
    try {
      log.debug(
        ` injectMessageToSession: conversationId=${conversationId}${conversationId.includes(':agent-') ? ' ⚠️ CHILD ID' : ' ✓ parent'}`,
      );
      const { sendToRenderer } = await import('./helpers');

      // Show the announcement in the chat UI immediately
      // Skip if the caller already sent a UI notification (e.g., sendAgentMessage)
      if (!skipUiNotification) {
        sendToRenderer('agent:team-message', spaceId, conversationId, {
          id: `announce-${Date.now()}`,
          type: 'agent_announcement',
          content: message,
          summary: message.substring(0, 100),
          timestamp: Date.now(),
          senderId: 'system',
          senderName: 'System',
        });
      }

      // Use the existing turn-level injection system to queue the announcement
      // This will be picked up by processStream's turn-boundary detection
      const { queueInjection } = await import('./stream-processor');
      queueInjection(conversationId, { content: message });

      // NOTE: We do NOT persist the worker announcement as a user message here.
      // The injection is for the Leader's LLM to process internally.
      // The Leader's own response (after processing the injection) is what
      // gets persisted and shown to the user via processStream's onComplete.

      log.debug(` Announcement queued for injection: conversation=${conversationId}`);
    } catch (error) {
      log.error(` Error injecting message to leader session:`, error);
    }
  }

  // ============================================
  // Hyper Space Tool Call Handler (Remote Worker Proxy)
  // ============================================

  /**
   * Handle a hyper-space tool call from a remote worker.
   *
   * When a remote Claude calls a hyper-space MCP tool (e.g., report_to_leader),
   * the remote-agent-proxy sends a tool:call event to AICO-Bot via WebSocket.
   * This method receives the event, executes the tool via the orchestrator,
   * and sends the result back via tool:approve.
   *
   * This runs asynchronously — the remote Claude's MCP handler waits for the response.
   */
  private async handleHyperSpaceToolCall(
    team: AgentTeam,
    agent: AgentInstance,
    parentConversationId: string,
    toolData: any,
    client: any,
  ): Promise<void> {
    const toolName = toolData.name;
    const toolId = toolData.id;
    const toolInput = toolData.input || {};
    const workerTag = { agentId: agent.id, agentName: agent.config.name || agent.id };

    log.debug(` Hyper-space tool call from remote worker: ${toolName}`);

    // Forward the tool call to the UI so users can see what the worker is doing
    sendToRenderer('agent:tool-call', team.spaceId, parentConversationId, {
      id: toolId,
      name: toolName,
      status: 'running',
      input: toolInput,
      requiresApproval: false,
      ...workerTag,
    });

    try {
      let result: string;

      switch (toolName) {
        case 'report_to_leader': {
          // Worker reports intermediate progress to leader
          const typeLabels: Record<string, string> = {
            progress: 'Progress Update',
            finding: 'Finding',
            question: 'Question',
            error: 'Error Report',
            info: 'Information',
          };
          const reportType = (toolInput.reportType as string) || 'progress';
          const reportMessage = `[${typeLabels[reportType] || reportType}] Worker "${agent.config.name || agent.id}" reports:\n\n${toolInput.message}`;

          // Show in UI immediately
          const { sendToRenderer } = await import('./helpers');
          sendToRenderer('agent:team-message', team.spaceId, parentConversationId, {
            id: `report-${Date.now()}`,
            type: 'worker_report',
            senderId: agent.id,
            senderName: agent.config.name || agent.id,
            workerId: agent.id,
            workerName: agent.config.name || agent.id,
            content: reportMessage,
            reportType,
            summary: (toolInput.message as string).substring(0, 100),
            timestamp: Date.now(),
          });

          // Inject into leader's session
          const { queueInjection } = await import('./stream-processor');
          queueInjection(parentConversationId, { content: reportMessage });

          result = `Report sent to leader. Type: ${reportType}`;
          break;
        }

        case 'announce_completion': {
          // Worker signals task completion
          const taskId = toolInput.taskId as string;
          const status = toolInput.status as string;
          const taskResult = toolInput.result as string;
          const summary = toolInput.summary as string;

          // Update task status
          if (taskId) {
            this.updateTaskStatus(
              taskId,
              status === 'completed' ? 'completed' : 'failed',
              taskResult,
            );
          }

          // Emit announce event for listeners (same as sendAnnouncement does)
          // This was missing — without it, event listeners miss remote worker completions
          this.emit('announce', {
            type: 'agent:announce',
            taskId,
            agentId: agent.id,
            status,
            result: taskResult,
            summary: summary || (taskResult ? taskResult.substring(0, 200) : undefined),
            timestamp: Date.now(),
          });

          // Inject into leader's session
          const announcementMessage = `[Subagent Announcement] Worker "${agent.config.name || agent.id}" reports:\n\n**Status**: ${status}\n${taskResult ? `**Result**:\n${taskResult}\n` : ''}${summary ? `**Summary**: ${summary}\n` : ''}Task ID: ${taskId}`;

          const { queueInjection } = await import('./stream-processor');
          queueInjection(parentConversationId, { content: announcementMessage });

          // Also emit for UI
          const { sendToRenderer } = await import('./helpers');
          sendToRenderer('agent:team-message', team.spaceId, parentConversationId, {
            id: `announce-${Date.now()}`,
            type: 'agent_announcement',
            senderId: agent.id,
            senderName: agent.config.name || agent.id,
            content: announcementMessage,
            summary: summary || announcementMessage.substring(0, 100),
            timestamp: Date.now(),
          });

          // Remove from pending announcements
          const pending = this.pendingAnnouncements.get(parentConversationId);
          if (pending && taskId) {
            pending.delete(taskId);
          }

          // Update agent status
          agent.status = status === 'completed' ? 'idle' : 'error';

          result = `Task ${taskId} marked as ${status}. Announcement sent to leader.`;
          break;
        }

        case 'ask_question': {
          // Worker asks a question — forward to leader via injection
          const questionMsg = `[Question from ${agent.config.name || agent.id}]\n${toolInput.question}`;

          const { queueInjection } = await import('./stream-processor');
          queueInjection(parentConversationId, { content: questionMsg });

          result = `Question sent to ${toolInput.target || 'leader'}. Continue working on your task.`;
          break;
        }

        case 'send_message': {
          // Worker sends message to a teammate — forward via injection
          const msgContent = `[Message from ${agent.config.name || agent.id} to ${toolInput.recipient}]\n${toolInput.content}`;

          const { queueInjection } = await import('./stream-processor');
          queueInjection(parentConversationId, { content: msgContent });

          result = `Message sent to ${toolInput.recipient}.`;
          break;
        }

        case 'list_team_members': {
          // Return team info as a string
          let info = `## Team Members\n\n`;
          info += `### Leader: ${team.leader.config.name || team.leader.id}\n`;
          info += `### Workers:\n`;
          for (const w of team.workers) {
            info += `- ${w.config.name || w.id} (${w.config.type}, ${w.status})\n`;
          }
          result = info;
          break;
        }

        default:
          result = `Unknown hyper-space tool: ${toolName}`;
      }

      // Forward tool result to UI
      sendToRenderer('agent:tool-result', team.spaceId, parentConversationId, {
        toolId,
        result,
        isError: false,
        ...workerTag,
      });

      // Send result back to remote-agent-proxy via tool:approve
      // This resolves the MCP handler's promise, allowing Claude to continue
      client.approveToolCall(parentConversationId, toolId, result);

      log.debug(` Hyper-space tool ${toolName} completed, result sent back to remote worker`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Forward error to UI
      sendToRenderer('agent:tool-result', team.spaceId, parentConversationId, {
        toolId,
        result: errorMessage,
        isError: true,
        ...workerTag,
      });

      // Send error back to remote-agent-proxy via tool:reject
      client.rejectToolCall(parentConversationId, toolId, errorMessage);

      log.error(` Hyper-space tool ${toolName} failed:`, errorMessage);
    }
  }

  // ============================================
  // Worker Proactive Communication
  // ============================================

  /**
   * Allow a worker to proactively report to the leader during task execution.
   *
   * This is the key mechanism for mid-task worker-initiated communication:
   * - The worker calls `report_to_leader` MCP tool
   * - The report is injected into the leader's session via queueInjection
   * - The leader's while(true) injection loop picks it up and processes it
   *
   * Unlike announce_completion (which ends a task), this does NOT affect task status.
   * The worker continues working after reporting.
   */
  async reportToLeader(params: {
    spaceId: string;
    conversationId: string;
    workerId: string;
    workerName: string;
    content: string;
    reportType: string;
  }): Promise<void> {
    console.log(
      `[Orchestrator] Worker report: worker=${params.workerName} type=${params.reportType}`,
    );

    // Find the team to get the parent conversation ID (leader's conversation)
    const team = this.getTeamBySpace(params.spaceId);
    if (!team) {
      log.warn(` No team found for space ${params.spaceId}, cannot report to leader`);
      return;
    }

    const leaderConversationId = team.conversationId;

    // Show the report in the chat UI immediately
    const { sendToRenderer } = await import('./helpers');
    sendToRenderer('agent:team-message', params.spaceId, leaderConversationId, {
      id: `report-${Date.now()}`,
      type: 'worker_report',
      senderId: params.workerId,
      senderName: params.workerName,
      workerId: params.workerId,
      workerName: params.workerName,
      content: params.content,
      reportType: params.reportType,
      summary: params.content.substring(0, 100),
      timestamp: Date.now(),
    });

    // Inject into the leader's session via queueInjection
    // The leader's while(true) loop in executeAgentLocally will pick this up
    const { queueInjection } = await import('./stream-processor');
    queueInjection(leaderConversationId, { content: params.content });

    // NOTE: We do NOT persist the worker report as a user message here.
    // The Leader's LLM processes the report internally via queueInjection.
    // Only the Leader's own response (after processing) is shown to the user.

    console.log(
      `[Orchestrator] Worker report queued for leader injection: ` +
        `conversation=${leaderConversationId}, worker=${params.workerName}`,
    );
  }
}

// Export singleton
export const agentOrchestrator = AgentOrchestrator.getInstance();
export { AgentOrchestrator };
