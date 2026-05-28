/**
 * Hyper Space Types
 *
 * Types for multi-agent collaboration between local and remote agents.
 * Inspired by OpenClaw's subagent system.
 */

// ============================================
// Agent Configuration
// ============================================

/**
 * Agent role in a Hyper Space
 */
export type AgentRole = 'leader' | 'worker';

/**
 * Configuration for a single agent in a Hyper Space
 */
export interface AgentConfig {
  /** Unique identifier for this agent */
  id: string;

  /** Display name */
  name: string;

  /** Agent type: local or remote */
  type: 'local' | 'remote';

  /** Role in the team: leader or worker */
  role: AgentRole;

  // Remote agent specific fields
  /** Remote server ID (only for remote agents) */
  remoteServerId?: string;

  /** Working directory on remote server */
  remotePath?: string;

  /** Use SSH tunnel for connection */
  useSshTunnel?: boolean;

  // Capability and configuration
  /** Capability tags for task routing */
  capabilities?: string[];

  /** Local working directory */
  workingDir?: string;

  /** Model override for this agent */
  model?: string;

  /** Enable thinking mode */
  thinkingEnabled?: boolean;

  /** Custom system prompt addition */
  systemPromptAddition?: string;

  // Hyper Space v2 fields
  /** Independent conversation ID for this agent's own chat view */
  conversationId?: string;

  /** Environment credentials for remote agents (included in shared system prompt) */
  environment?: {
    ip?: string;
    username?: string;
    password?: string;
    port?: number;
  };
}

// ============================================
// Orchestration Configuration
// ============================================

/**
 * Task routing strategy
 */
export type RoutingStrategy = 'capability' | 'round-robin' | 'least-loaded' | 'manual';

/**
 * Result aggregation strategy
 */
export type AggregationStrategy = 'concat' | 'summarize' | 'vote';

/**
 * Execution mode for multi-agent tasks
 */
export type ExecutionMode = 'parallel' | 'sequential' | 'adaptive';

/**
 * Task routing configuration
 */
export interface RoutingConfig {
  /** How to route tasks to agents */
  strategy: RoutingStrategy;

  /** Default agent for manual routing */
  defaultAgentId?: string;
}

/**
 * Result aggregation configuration
 */
export interface AggregationConfig {
  /** How to combine results from multiple agents */
  strategy: AggregationStrategy;

  /** Agent ID responsible for summarizing (if strategy is 'summarize') */
  summarizerAgentId?: string;
}

/**
 * Announcement configuration (inspired by OpenClaw's auto-announce)
 */
export interface AnnounceConfig {
  /** Enable automatic completion announcements */
  enabled: boolean;

  /** Timeout in milliseconds to wait for agent completion */
  timeout?: number;

  /** Number of retries on failure */
  retries?: number;
}

/**
 * Full orchestration configuration for a Hyper Space
 */
export interface OrchestrationConfig {
  /** How to execute tasks across agents */
  mode: ExecutionMode;

  /** Task routing configuration */
  routing: RoutingConfig;

  /** Result aggregation configuration */
  aggregation: AggregationConfig;

  /** Completion announcement configuration */
  announce: AnnounceConfig;
}

// ============================================
// Space Types Extension
// ============================================

/**
 * Space type: local, remote, or hyper
 */
export type SpaceType = 'local' | 'remote' | 'hyper';

/**
 * Extended Space interface with Hyper Space support
 */
export interface HyperSpace {
  id: string;
  name: string;
  icon: string;
  path: string;
  isTemp: boolean;
  createdAt: string;
  updatedAt: string;
  preferences?: SpacePreferences;
  workingDir?: string;

  // Space type (new field for hyper space)
  spaceType: SpaceType;

  // Legacy fields (for backward compatibility)
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
  remotePath?: string;
  useSshTunnel?: boolean;

  // Hyper Space specific fields
  /** Agents in this Hyper Space */
  agents?: AgentConfig[];

  /** Orchestration configuration */
  orchestration?: OrchestrationConfig;
}

/**
 * Space preferences (existing interface)
 */
export interface SpacePreferences {
  layout?: {
    artifactRailExpanded?: boolean;
    chatWidth?: number;
  };
}

// ============================================
// Subagent Task Types
// ============================================

/**
 * Subagent task status
 */
export type SubagentTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Represents a task assigned to a subagent
 */
export interface SubagentTask {
  /** Unique task ID */
  id: string;

  /** Parent conversation ID */
  parentConversationId: string;

  /** Target agent ID */
  agentId: string;

  /** Task description */
  task: string;

  /** Current status */
  status: SubagentTaskStatus;

  /** Task result (when completed) */
  result?: string;

  /** Error message (when failed) */
  error?: string;

  /** When task was started */
  startedAt?: number;

  /** When task completed */
  completedAt?: number;
}

/**
 * Worker context captured when Leader stream is interrupted.
 * Passed to frontend via agent:error event so that "continue" can include worker state.
 */
export interface InterruptWorkerContext {
  /** Workers still running when the interruption occurred */
  runningWorkers: Array<{
    taskId: string;
    agentId: string;
    agentName: string;
    task: string;
    startedAt?: number;
  }>;
  /** Workers that completed but whose results were not yet consumed by the Leader */
  completedWorkers: Array<{
    taskId: string;
    agentId: string;
    agentName: string;
    result?: string;
    error?: string;
  }>;
}

/**
 * Announcement message from subagent
 */
export interface SubagentAnnouncement {
  /** Type identifier */
  type: 'agent:announce';

  /** Task ID */
  taskId: string;

  /** Agent ID that completed */
  agentId: string;

  /** Completion status */
  status: 'completed' | 'failed';

  /** Result content */
  result?: string;

  /** Short summary */
  summary?: string;

  /** Timestamp */
  timestamp: number;
}

// ============================================
// Create Space Input Extension
// ============================================

/**
 * Extended input for creating a Hyper Space
 */
export interface CreateHyperSpaceInput {
  name: string;
  icon: string;
  customPath?: string;

  // Hyper Space specific
  spaceType?: SpaceType;
  agents?: AgentConfig[];
  orchestration?: Partial<OrchestrationConfig>;

  // Legacy fields (for backward compatibility)
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
  remotePath?: string;
  useSshTunnel?: boolean;
}

// ============================================
// Default Configuration
// ============================================

/**
 * Default orchestration configuration
 */
export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  mode: 'adaptive',
  routing: {
    strategy: 'capability',
  },
  aggregation: {
    strategy: 'summarize',
  },
  announce: {
    enabled: true,
    timeout: 300000, // 5 minutes
    retries: 2,
  },
};

/**
 * Create default orchestration config with overrides
 */
export function createOrchestrationConfig(
  partial?: Partial<OrchestrationConfig>,
): OrchestrationConfig {
  if (!partial) return { ...DEFAULT_ORCHESTRATION_CONFIG };

  return {
    mode: partial.mode ?? DEFAULT_ORCHESTRATION_CONFIG.mode,
    routing: {
      ...DEFAULT_ORCHESTRATION_CONFIG.routing,
      ...partial.routing,
    },
    aggregation: {
      ...DEFAULT_ORCHESTRATION_CONFIG.aggregation,
      ...partial.aggregation,
    },
    announce: {
      ...DEFAULT_ORCHESTRATION_CONFIG.announce,
      ...partial.announce,
    },
  };
}
