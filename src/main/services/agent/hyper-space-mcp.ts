/**
 * Hyper Space MCP Server
 *
 * Provides tools for multi-agent collaboration in Hyper Spaces.
 * Inspired by OpenClaw's subagent system.
 *
 * Leader tools:
 * - spawn_subagent: Create a subagent task for parallel execution
 * - check_subagent_status: Check status of a spawned task
 * - wait_for_team: Wait for all pending tasks to complete
 *
 * Worker tools:
 * - announce_completion: Signal task completion to parent agent
 * - report_to_leader: Send intermediate progress updates to the leader
 * - ask_question: Ask the leader or user a question when needing more info
 *
 * Shared tools:
 * - list_team_members: Get detailed information about team members
 * - send_message: Send a message to another agent
 * - broadcast_message: Broadcast to all agents
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { agentOrchestrator } from './orchestrator';
import { taskboardService } from './taskboard';
import { getRemoteDeployService } from '../../ipc/remote-server';
import type { SubagentAnnouncement } from '../../../shared/types/hyper-space';
import type { TaskBoardTask } from '../../../shared/types/taskboard';

// ============================================
// Helpers
// ============================================

/** Build a standard text content response. */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Get remote server name by ID */
function getRemoteServerName(serverId: string): string {
  const deployService = getRemoteDeployService();
  const server = deployService.getServer(serverId);
  return server?.name || `Unknown Server (${serverId})`;
}

// ============================================
// Leader Tool Factories
// ============================================

/**
 * Create spawn_subagent tool
 * Allows leaders to spawn subagent tasks for parallel execution
 */
function createSpawnSubagentTool(spaceId: string, conversationId: string) {
  return tool(
    'spawn_subagent',
    'Spawn a subagent task for parallel execution in a Hyper Space. ' +
      'The task will be routed to an appropriate worker agent based on capabilities or targetAgentId. ' +
      'Use this to distribute work across multiple agents for faster completion. ' +
      'Returns a task ID that can be used to check status and retrieve results.',
    {
      task: z.string().describe('The task description for the subagent to execute'),
      targetAgentId: z
        .string()
        .optional()
        .describe(
          'The ID of the specific worker to assign this task to. ' +
            'Use list_team_members to see available agent IDs. ' +
            'If not specified, the task will be routed automatically based on capabilities.',
        ),
      capabilities: z
        .array(z.string())
        .optional()
        .describe(
          'Required capabilities for the subagent (e.g., ["npu", "hardware"]). ' +
            'Used to route to appropriate worker when targetAgentId is not specified.',
        ),
      priority: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe('Task priority (default: normal)'),
    },
    async (params: {
      task: string;
      targetAgentId?: string;
      capabilities?: string[];
      priority?: 'low' | 'normal' | 'high';
    }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (!team) {
          return textResult(
            'No Hyper Space team found. spawn_subagent can only be used in Hyper Spaces.',
            true,
          );
        }

        // Dispatch the task (with optional target agent)
        const tasks = await agentOrchestrator.dispatchTask({
          teamId: team.id,
          task: params.task,
          conversationId,
          targetAgentId: params.targetAgentId,
        });

        if (tasks.length === 0) {
          return textResult('No available workers to handle the task.', true);
        }

        const task = tasks[0];
        const targetAgent = team.workers.find((w) => w.id === task.agentId);
        const agentName = targetAgent?.config.name || task.agentId;
        const agentLocation =
          targetAgent?.config.type === 'remote'
            ? `remote server (${targetAgent.config.remoteServerId})`
            : 'local machine';

        // Start execution in background
        agentOrchestrator.executeAllTasks(team.id).catch((err) => {
          console.error(`[HyperSpaceMcp] Task execution error:`, err);
          // Notify the leader about the execution failure via injection
          const errorMsg = err instanceof Error ? err.message : String(err);
          agentOrchestrator.injectMessageToSession(
            spaceId,
            conversationId,
            `[Subagent Error] Task ${task.id} (agent: ${agentName}) failed to start:\n${errorMsg}`,
          ).catch((injectErr) => {
            console.error(`[HyperSpaceMcp] Failed to notify leader of error:`, injectErr);
          });
        });

        return textResult(
          `Subagent task spawned successfully.\n\n` +
            `Task ID: ${task.id}\n` +
            `Agent: ${agentName} (${agentLocation})\n` +
            `Status: ${task.status}\n\n` +
            `**IMPORTANT**: Do NOT poll for results. The worker will automatically announce completion.\n` +
            `Continue with other work if needed, or wait for the announcement.`,
        );
      } catch (e) {
        return textResult(`Error spawning subagent: ${(e as Error).message}`, true);
      }
    },
  );
}

/**
 * Create check_subagent_status tool
 * Allows leaders to check the status of a spawned task
 */
function createCheckSubagentStatusTool(spaceId: string, conversationId: string) {
  return tool(
    'check_subagent_status',
    'Check the status of a spawned subagent task. ' +
      'Returns current status (pending/running/completed/failed) and results if completed. ' +
      'NOTE: Prefer waiting for automatic announcements instead of polling.',
    {
      taskId: z.string().describe('The task ID returned by spawn_subagent'),
    },
    async (params: { taskId: string }) => {
      try {
        const task = agentOrchestrator.getTask(params.taskId);
        if (!task) {
          return textResult(`Task ${params.taskId} not found.`, true);
        }

        let result =
          `Task Status: ${task.status}\n` +
          `Task ID: ${task.id}\n` +
          `Agent: ${task.agentId}\n` +
          `Started: ${new Date(task.startedAt).toISOString()}`;

        if (task.status === 'completed' && task.result) {
          result += `\n\nResult:\n${task.result}`;
        } else if (task.status === 'failed' && task.error) {
          result += `\n\nError: ${task.error}`;
        }

        return textResult(result);
      } catch (e) {
        return textResult(`Error checking task status: ${(e as Error).message}`, true);
      }
    },
  );
}

/**
 * Create wait_for_team tool
 * Wait for all pending tasks in the team to complete
 */
function createWaitForTeamTool(spaceId: string, conversationId: string) {
  return tool(
    'wait_for_team',
    'Wait for all pending tasks in the Hyper Space team to complete. ' +
      'Returns aggregated results from all completed tasks. ' +
      'Use this to coordinate multi-agent work when you need all results before proceeding.',
    {
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 300000 = 5 min)'),
      aggregationStrategy: z
        .enum(['concat', 'summarize', 'vote'])
        .optional()
        .describe('How to aggregate results (default: summarize)'),
    },
    async (params: { timeout?: number; aggregationStrategy?: 'concat' | 'summarize' | 'vote' }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true,
          );
        }

        // Wait for completion
        const tasks = await agentOrchestrator.waitForCompletion({
          conversationId,
          timeout: params.timeout || 300000,
        });

        // Aggregate results
        const strategy = params.aggregationStrategy || 'summarize';
        const aggregated = agentOrchestrator.aggregateResults(tasks, strategy);

        return textResult(
          `## Team Tasks Completed\n\n` +
            `Total tasks: ${tasks.length}\n` +
            `Completed: ${tasks.filter((t) => t.status === 'completed').length}\n` +
            `Failed: ${tasks.filter((t) => t.status === 'failed').length}\n\n` +
            `### Aggregated Results (${strategy})\n\n` +
            aggregated,
        );
      } catch (e) {
        return textResult(`Error waiting for team: ${(e as Error).message}`, true);
      }
    },
  );
}

// ============================================
// Worker Tool Factories
// ============================================

/**
 * Create announce_completion tool
 * Allows workers to signal task completion to parent agent
 */
function createAnnounceCompletionTool(spaceId: string, conversationId: string) {
  return tool(
    'announce_completion',
    'Signal task completion to the parent agent in a Hyper Space. ' +
      'Use this when you have finished your assigned task and want to report results. ' +
      'This triggers the announcement system and marks the task as complete.',
    {
      taskId: z.string().describe('Your assigned task ID'),
      status: z.enum(['completed', 'failed']).describe('Task completion status'),
      result: z.string().optional().describe('Task result or output (for completed tasks)'),
      error: z.string().optional().describe('Error message (for failed tasks)'),
      summary: z.string().optional().describe('Brief summary of the result (max 200 chars)'),
    },
    async (params: {
      taskId: string;
      status: 'completed' | 'failed';
      result?: string;
      error?: string;
      summary?: string;
    }) => {
      try {
        const task = agentOrchestrator.getTask(params.taskId);
        if (!task) {
          return textResult(`Task ${params.taskId} not found.`, true);
        }

        // Create and send announcement
        const announcement: SubagentAnnouncement = {
          type: 'agent:announce',
          taskId: params.taskId,
          agentId: task.agentId,
          status: params.status,
          result: params.result,
          summary: params.summary || (params.result ? params.result.substring(0, 200) : undefined),
          timestamp: Date.now(),
        };

        await agentOrchestrator.sendAnnouncement(announcement);

        return textResult(
          `Announcement sent successfully.\n` + `Task ${params.taskId} marked as ${params.status}.`,
        );
      } catch (e) {
        return textResult(`Error sending announcement: ${(e as Error).message}`, true);
      }
    },
  );
}

// ============================================
// Worker Tool Factories (continued)
// ============================================

/**
 * Create report_to_leader tool
 * Allows workers to proactively send intermediate progress updates to the leader.
 * Unlike announce_completion (which signals task end), this is for mid-task reporting:
 * progress updates, intermediate results, questions, or requests for guidance.
 * The message will be injected into the leader's active session.
 */
function createReportToLeaderTool(
  spaceId: string,
  conversationId: string,
  workerId?: string,
  workerName?: string,
) {
  return tool(
    'report_to_leader',
    'Send an intermediate progress update or message to the team leader. ' +
      'Use this to report progress, share intermediate findings, ask for guidance, ' +
      'or flag issues during task execution. The leader will receive your message ' +
      'in real-time. Unlike announce_completion, this does NOT end your task — ' +
      'continue working after reporting.',
    {
      message: z
        .string()
        .describe(
          'The message to send to the leader. Include relevant details, progress, findings, or questions.',
        ),
      type: z
        .enum(['progress', 'finding', 'question', 'error', 'info'])
        .optional()
        .describe(
          'Type of report (default: "progress"). Use: "progress" for status updates, ' +
            '"finding" for intermediate results, "question" when you need guidance, ' +
            '"error" for problems encountered, "info" for general information.',
        ),
    },
    async (params: {
      message: string;
      type?: 'progress' | 'finding' | 'question' | 'error' | 'info';
    }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true,
          );
        }

        // Identify the calling worker: prefer explicit context over find(running)
        let resolvedWorkerId = workerId || 'unknown';
        let resolvedWorkerName = workerName || 'Worker';
        if (!workerId) {
          // Fallback: find running worker (less reliable for concurrent execution)
          const runningWorker = team.workers.find((w) => w.status === 'running');
          resolvedWorkerId = runningWorker?.id || 'unknown';
          resolvedWorkerName = runningWorker?.config.name || 'Worker';
        }
        const reportType = params.type || 'progress';

        // Format the report message
        const typeLabels: Record<string, string> = {
          progress: 'Progress Update',
          finding: 'Finding',
          question: 'Question',
          error: 'Error Report',
          info: 'Information',
        };

        const reportMessage = `[${typeLabels[reportType]}] Worker "${resolvedWorkerName}" reports:\n\n${params.message}`;

        // Inject into leader's session via the orchestrator's injection system
        await agentOrchestrator.reportToLeader({
          spaceId,
          conversationId,
          workerId: resolvedWorkerId,
          workerName: resolvedWorkerName,
          content: reportMessage,
          reportType,
        });

        return textResult(
          `Report sent to leader successfully.\n` +
            `Type: ${reportType}\n` +
            `Continue working on your task. The leader will process your report.`,
        );
      } catch (e) {
        return textResult(`Error reporting to leader: ${(e as Error).message}`, true);
      }
    },
  );
}

// ============================================
// Shared Tool Factories
// ============================================

/**
 * Create ask_question tool
 * Allows workers to ask the leader or user a question when they need more information
 */
function createAskQuestionTool(
  spaceId: string,
  conversationId: string,
  workerId?: string,
  workerName?: string,
) {
  return tool(
    'ask_question',
    'Ask the leader or user a question when you need more information to complete your task. ' +
      'Use this when you are missing critical context, need clarification on requirements, ' +
      'or encounter an ambiguous situation. The question will be shown in the chat UI and ' +
      'the leader will see it. You should continue working on what you can while waiting.',
    {
      question: z.string().describe('Your question to the leader or user'),
      target: z
        .enum(['leader', 'user'])
        .optional()
        .describe(
          'Who to ask (default: "leader"). Use "user" to direct the question to the end user.',
        ),
      options: z
        .array(z.string())
        .optional()
        .describe('Optional list of suggested answers the recipient can choose from'),
    },
    async (params: { question: string; target?: 'leader' | 'user'; options?: string[] }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true,
          );
        }

        // Identify the calling worker: prefer explicit context over find(running)
        let resolvedWorkerId = workerId || 'unknown';
        let resolvedWorkerName = workerName || 'Worker';
        if (!workerId) {
          const runningWorker = team.workers.find((w) => w.status === 'running');
          resolvedWorkerId = runningWorker?.id || 'unknown';
          resolvedWorkerName = runningWorker?.config.name || 'Worker';
        }

        // Send question to leader via sendAgentMessage (injects into leader's session)
        const questionMsg =
          `[Question from ${resolvedWorkerName}]\n${params.question}` +
          (params.options?.length
            ? '\n\nSuggested options: ' + params.options.map((o, i) => `${i + 1}. ${o}`).join(' | ')
            : '');

        await agentOrchestrator.sendAgentMessage({
          teamId: team.id,
          spaceId,
          conversationId,
          recipientId: team.leader.id,
          recipientName: team.leader.config.name || 'Leader',
          content: questionMsg,
          summary: `${resolvedWorkerName} asks: ${params.question.substring(0, 80)}`,
        });

        const targetLabel = params.target === 'user' ? 'user (via leader)' : 'leader';

        return textResult(
          `Question sent to ${targetLabel}.\n` +
            `Question: ${params.question}\n\n` +
            `Continue working on other parts of your task if possible. ` +
            `The response will be delivered to you via a message from the leader.`,
        );
      } catch (e) {
        return textResult(`Error sending question: ${(e as Error).message}`, true);
      }
    },
  );
}

/**
 * Create list_team_members tool
 * List all agents in the current Hyper Space team
 */
function createListTeamMembersTool(spaceId: string, conversationId: string) {
  return tool(
    'list_team_members',
    'List all agents (leader and workers) in the current Hyper Space team. ' +
      'Shows their ID, name, type (local/remote), remote server info, capabilities, and status. ' +
      'Use this to understand who is available for collaboration.',
    {},
    async () => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true,
          );
        }

        let result = '## Hyper Space Team Members\n\n';
        result += `**Team ID:** ${team.id}\n`;
        result += `**Status:** ${team.status}\n\n`;

        // Leader info
        result += `### Leader\n`;
        result += `| Property | Value |\n`;
        result += `|----------|-------|\n`;
        result += `| ID | \`${team.leader.id}\` |\n`;
        result += `| Name | ${team.leader.config.name || 'Unnamed'} |\n`;
        result += `| Type | ${team.leader.config.type} |\n`;
        if (team.leader.config.type === 'remote' && team.leader.config.remoteServerId) {
          result += `| Remote Server | ${getRemoteServerName(team.leader.config.remoteServerId)} |\n`;
          result += `| Remote Path | ${team.leader.config.remotePath || '/home'} |\n`;
        }
        result += `| Status | ${team.leader.status} |\n`;
        if (team.leader.config.capabilities?.length) {
          result += `| Capabilities | ${team.leader.config.capabilities.join(', ')} |\n`;
        }
        result += '\n';

        // Workers info
        result += `### Workers (${team.workers.length})\n\n`;
        if (team.workers.length === 0) {
          result += 'No workers in team.\n';
        } else {
          for (const worker of team.workers) {
            result += `#### ${worker.config.name || worker.id}\n`;
            result += `| Property | Value |\n`;
            result += `|----------|-------|\n`;
            result += `| ID | \`${worker.id}\` |\n`;
            result += `| Type | ${worker.config.type} |\n`;
            if (worker.config.type === 'remote' && worker.config.remoteServerId) {
              result += `| Remote Server | ${getRemoteServerName(worker.config.remoteServerId)} |\n`;
              result += `| Remote Path | ${worker.config.remotePath || '/home'} |\n`;
            }
            result += `| Status | ${worker.status} |\n`;
            if (worker.config.capabilities?.length) {
              result += `| Capabilities | ${worker.config.capabilities.join(', ')} |\n`;
            }
            if (worker.currentTaskId) {
              result += `| Current Task | ${worker.currentTaskId} |\n`;
            }
            result += '\n';
          }
        }

        result += `---\n`;
        result += `**Tip:** Use \`send_message\` to communicate with specific team members.\n`;
        result += `Use their ID (e.g., \`${team.workers[0]?.id || 'worker-1'}\`) as the recipient.\n`;

        return textResult(result);
      } catch (e) {
        return textResult(`Error listing team members: ${(e as Error).message}`, true);
      }
    },
  );
}

/**
 * Create send_message tool
 * Send a message to another agent in the team
 */
function createSendMessageTool(spaceId: string, conversationId: string) {
  return tool(
    'send_message',
    'Send a message to another agent in the Hyper Space team. ' +
      'Use this to communicate with teammates, ask questions, delegate tasks, or share results. ' +
      'The message will be visible in the chat UI and delivered to the recipient. ' +
      'IMPORTANT: This is for inter-agent communication within the team, not for responding to the user.',
    {
      recipient: z
        .string()
        .describe(
          'The ID of the agent to send the message to (e.g., "worker-1", "leader"). ' +
            'Use list_team_members to see all available agent IDs.',
        ),
      content: z.string().describe('The message content to send'),
      summary: z
        .string()
        .optional()
        .describe('A brief summary of the message (max 100 chars) for display in the chat UI'),
      requires_response: z
        .boolean()
        .optional()
        .describe('Whether you expect a response from the recipient (default: true)'),
    },
    async (params: {
      recipient: string;
      content: string;
      summary?: string;
      requires_response?: boolean;
    }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true,
          );
        }

        // Find recipient agent
        let recipientAgent = team.leader;
        if (params.recipient !== 'leader' && params.recipient !== team.leader.id) {
          recipientAgent =
            team.workers.find(
              (w) => w.id === params.recipient || w.config.name === params.recipient,
            ) || null;
        }

        if (!recipientAgent) {
          const availableIds = [team.leader.id, ...team.workers.map((w) => w.id)].join(', ');
          return textResult(
            `Agent "${params.recipient}" not found in team.\n` +
              `Available agents: ${availableIds}\n` +
              `Use list_team_members to see all agents.`,
            true,
          );
        }

        // Send message via orchestrator (this will emit an event and show in chat)
        const messageId = await agentOrchestrator.sendAgentMessage({
          teamId: team.id,
          spaceId,
          conversationId,
          recipientId: recipientAgent.id,
          recipientName: recipientAgent.config.name || recipientAgent.id,
          content: params.content,
          summary: params.summary,
        });

        const responseNote =
          params.requires_response !== false
            ? '\n\nThe recipient will process your message and may respond.'
            : '\n\nNo response expected (requires_response=false).';

        return textResult(
          `Message sent successfully to ${recipientAgent.config.name || recipientAgent.id}.\n` +
            `Message ID: ${messageId}${responseNote}`,
        );
      } catch (e) {
        return textResult(`Error sending message: ${(e as Error).message}`, true);
      }
    },
  );
}

/**
 * Create broadcast_message tool
 * Send a message to all agents in the team
 */
function createBroadcastMessageTool(spaceId: string, conversationId: string) {
  return tool(
    'broadcast_message',
    'Send a message to ALL agents in the Hyper Space team. ' +
      'Use this for announcements, status updates, or when you need input from everyone. ' +
      'The message will be visible in the chat UI and delivered to all team members.',
    {
      content: z.string().describe('The message content to broadcast'),
      summary: z
        .string()
        .optional()
        .describe('A brief summary of the message (max 100 chars) for display in the chat UI'),
    },
    async (params: { content: string; summary?: string }) => {
      try {
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (!team) {
          return textResult(
            'No Hyper Space team found. This tool can only be used in Hyper Spaces.',
            true,
          );
        }

        // Broadcast message via orchestrator
        const messageIds = await agentOrchestrator.broadcastAgentMessage({
          teamId: team.id,
          spaceId,
          conversationId,
          content: params.content,
          summary: params.summary,
        });

        return textResult(
          `Message broadcast to ${messageIds.length} team members.\n` +
            `Recipients: Leader (${team.leader.config.name || team.leader.id})` +
            (team.workers.length > 0
              ? `, Workers: ${team.workers.map((w) => w.config.name || w.id).join(', ')}`
              : ''),
        );
      } catch (e) {
        return textResult(`Error broadcasting message: ${(e as Error).message}`, true);
      }
    },
  );
}

// ============================================
// TaskBoard Tool Factories (Shared)
// ============================================

/**
 * Create post_task tool for posting tasks to the shared TaskBoard.
 * Available to both leaders and workers.
 */
function createPostTaskTool(
  spaceId: string,
  conversationId: string,
  agentId?: string,
  agentName?: string,
) {
  return tool(
    'post_task',
    'Post a task to the shared team TaskBoard. Other team members can see and claim it. ' +
      'Use this to delegate work to teammates without specifying who should do it.',
    {
      title: z.string().describe('Short title for the task'),
      description: z.string().describe('Detailed description of what needs to be done'),
      priority: z
        .enum(['low', 'normal', 'high', 'urgent'])
        .optional()
        .describe('Task priority (default: normal)'),
      requiredCapabilities: z
        .array(z.string())
        .optional()
        .describe(
          'Required capabilities for the task (e.g. ["NPU操作", "模型训练"]). ' +
            'Used to route to the right worker.',
        ),
      targetServerId: z.string().optional().describe('Target NPU server ID for the task'),
    },
    async (params: {
      title: string;
      description: string;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      requiredCapabilities?: string[];
      targetServerId?: string;
    }) => {
      try {
        const task = taskboardService.postTask(spaceId, {
          title: params.title,
          description: params.description,
          priority: params.priority,
          requiredCapabilities: params.requiredCapabilities,
          targetServerId: params.targetServerId,
          postedBy: agentId || 'leader',
          parentConversationId: conversationId,
        });

        // Also broadcast to mailbox so all agents are notified
        const { mailboxService } = await import('./mailbox');
        if (mailboxService.isInitialized(spaceId)) {
          mailboxService.broadcastMessage(
            spaceId,
            {
              type: 'task_assignment',
              senderId: agentId || 'leader',
              senderName: agentName || 'Leader',
              content: `New task posted: "${params.title}"`,
              payload: {
                taskId: task.id,
                priority: params.priority,
                requiredCapabilities: params.requiredCapabilities,
              },
            },
            agentId, // Don't send to self
          );
        }

        return textResult(
          `Task posted to the shared TaskBoard.\n\n` +
            `Task ID: ${task.id}\n` +
            `Title: ${task.title}\n` +
            `Priority: ${task.priority}\n` +
            `Status: ${task.status}\n\n` +
            `Other team members can now see and claim this task.`,
        );
      } catch (e) {
        return textResult(`Error posting task: ${(e as Error).message}`, true);
      }
    },
  );
}

/**
 * Create list_tasks tool for viewing tasks on the shared TaskBoard.
 */
function createListTasksTool(spaceId: string) {
  return tool(
    'list_tasks',
    'List tasks on the shared team TaskBoard. Shows task status, assignments, and priorities. ' +
      'Use this to see what work is available or check on task progress.',
    {
      status: z
        .enum(['posted', 'claimed', 'in_progress', 'completed', 'failed'])
        .optional()
        .describe('Filter by status. If not specified, shows all tasks.'),
    },
    async (params: { status?: TaskBoardTask['status'] }) => {
      try {
        const tasks = taskboardService.getTasks(
          spaceId,
          params.status ? { status: params.status } : undefined,
        );

        if (tasks.length === 0) {
          return textResult('No tasks found on the TaskBoard.');
        }

        let result = `## Shared TaskBoard (${tasks.length} tasks)\n\n`;
        result += `| # | Title | Status | Priority | Assigned To | Posted By |\n`;
        result += `|---|-------|--------|----------|-------------|----------|\n`;

        for (const task of tasks) {
          const assigned = task.claimedByName || task.claimedBy || '-';
          result += `| 1 | ${task.title} | ${task.status} | ${task.priority} | ${assigned} | ${task.postedBy} |\n`;
        }

        result += `\n---\nUse \`claim_task\` to claim a posted task, or \`post_task\` to add a new one.`;

        return textResult(result);
      } catch (e) {
        return textResult(`Error listing tasks: ${(e as Error).message}`, true);
      }
    },
  );
}

/**
 * Create claim_task tool for workers to claim a task from the board.
 */
function createClaimTaskTool(
  spaceId: string,
  conversationId: string,
  workerId?: string,
  workerName?: string,
) {
  return tool(
    'claim_task',
    'Claim a task from the shared team TaskBoard. Use this to pick up available work. ' +
      'Once claimed, the task is yours to complete. Other workers will see it as assigned.',
    {
      taskId: z.string().describe('The ID of the task to claim (from list_tasks)'),
    },
    async (params: { taskId: string }) => {
      try {
        const task = taskboardService.claimTask(
          params.taskId,
          workerId || 'unknown',
          workerName,
          spaceId,
        );

        if (!task) {
          return textResult(
            `Could not claim task ${params.taskId}. It may already be claimed or not found.`,
            true,
          );
        }

        return textResult(
          `Task claimed successfully.\n\n` +
            `Task ID: ${task.id}\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `You are now responsible for this task. Work on it and use announce_completion when done.`,
        );
      } catch (e) {
        return textResult(`Error claiming task: ${(e as Error).message}`, true);
      }
    },
  );
}

// ============================================
// Tool Builders by Role
// ============================================

/**
 * Build leader-specific tools for task delegation
 */
function buildLeaderTools(spaceId: string, conversationId: string) {
  return [
    // Task delegation tools (LEADER ONLY)
    createSpawnSubagentTool(spaceId, conversationId),
    createCheckSubagentStatusTool(spaceId, conversationId),
    createWaitForTeamTool(spaceId, conversationId),

    // Team management tools
    createListTeamMembersTool(spaceId, conversationId),

    // TaskBoard tools (SHARED)
    createPostTaskTool(spaceId, conversationId),
    createListTasksTool(spaceId),
    createClaimTaskTool(spaceId, conversationId),

    // Communication tools
    createSendMessageTool(spaceId, conversationId),
    createBroadcastMessageTool(spaceId, conversationId),
  ];
}

/**
 * Build worker-specific tools
 */
function buildWorkerTools(
  spaceId: string,
  conversationId: string,
  workerId?: string,
  workerName?: string,
) {
  return [
    // Completion reporting (WORKER ONLY)
    createAnnounceCompletionTool(spaceId, conversationId),

    // Intermediate reporting (WORKER ONLY)
    createReportToLeaderTool(spaceId, conversationId, workerId, workerName),

    // Question asking (WORKER ONLY)
    createAskQuestionTool(spaceId, conversationId, workerId, workerName),

    // Team info
    createListTeamMembersTool(spaceId, conversationId),

    // TaskBoard tools (SHARED)
    createPostTaskTool(spaceId, conversationId, workerId, workerName),
    createListTasksTool(spaceId),
    createClaimTaskTool(spaceId, conversationId, workerId, workerName),

    // Communication tools
    createSendMessageTool(spaceId, conversationId),
    createBroadcastMessageTool(spaceId, conversationId),
  ];
}

// ============================================
// Export SDK MCP Server
// ============================================

/**
 * Create Hyper Space SDK MCP Server.
 * Provides tools for multi-agent collaboration.
 *
 * @param spaceId - The current space ID
 * @param conversationId - The current conversation ID
 * @param agentRole - The role of the agent ('leader' or 'worker')
 * @param workerId - Optional worker ID (for accurate identification in worker tools)
 * @param workerName - Optional worker name (for accurate identification in worker tools)
 */
export interface HyperSpaceMcpOptions {
  agentRole?: 'leader' | 'worker';
  workerId?: string;
  workerName?: string;
}

export function createHyperSpaceMcpServer(
  spaceId: string,
  conversationId: string,
  options: HyperSpaceMcpOptions = {},
) {
  const { agentRole = 'leader', workerId, workerName } = options;
  // Select tools based on agent role
  const tools =
    agentRole === 'leader'
      ? buildLeaderTools(spaceId, conversationId)
      : buildWorkerTools(spaceId, conversationId, workerId, workerName);

  return createSdkMcpServer({
    name: 'hyper-space',
    version: '1.0.0',
    tools,
  });
}
