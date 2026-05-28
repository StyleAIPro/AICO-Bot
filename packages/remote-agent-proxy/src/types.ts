export interface RemoteServerConfig {
  port: number
  authToken?: string
  authTokens?: string[]
  tokensJsonPath?: string
  workDir?: string
  maxThinkingTokens?: number
  pathToClaudeCodeExecutable?: string
}

export interface ClientMessage {
  type: 'auth' | 'claude:chat' | 'fs:list' | 'fs:read' | 'fs:write' | 'fs:upload' | 'fs:delete' | 'fs:stat' | 'fs:mkdir' | 'ping' | 'pong' | 'tool:approve' | 'tool:reject' | 'claude:interrupt' | 'close:session' |
        'agent:spawn' | 'agent:steer' | 'agent:kill' | 'agent:list' |  // Hyper Space agent management
        'mcp:tools:register' | 'mcp:tool:response' | 'mcp:tool:error' |  // WebSocket MCP Bridge
        'task:list' | 'task:get' | 'task:cancel' | 'task:spawn' |  // Background task management
        'ask:answer'  // AskUserQuestion response from client
  sessionId?: string
  payload?: {
    messages?: any[]
    options?: ChatOptions & { workDir?: string }
    stream?: boolean
    path?: string
    content?: string
    token?: string
    toolId?: string
    reason?: string
    result?: string   // Tool execution result (for tool:approve with hyper-space tools)
    // Agent management payloads
    task?: string
    capabilities?: string[]            // Agent capabilities (for agent:spawn)
    agentId?: string
    instruction?: string
    // WebSocket MCP Bridge payloads
    tools?: AicoBotMcpToolDef[]                    // Tool definitions for mcp:tools:register
    aicoBotMcpCapabilities?: AicoBotMcpCapabilities     // Capability flags for mcp:tools:register
    callId?: string                    // MCP tool call ID for mcp:tool:call / mcp:tool:error
    toolResult?: AicoBotMcpToolResult     // Tool execution result for mcp:tool:call
    toolError?: string                 // Tool execution error for mcp:tool:error
    // Background task payloads
    id?: string                        // Task ID for task:get / task:cancel
    command?: string                   // Command for task:spawn
    cwd?: string                       // Working directory for task:spawn
    // AskUserQuestion payloads
    answers?: Record<string, string>   // User answers for ask:answer
  }
}

/**
 * Extended chat options with workDir support
 */
export interface ChatOptions {
  maxTokens?: number
  system?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  maxThinkingTokens?: number
  workDir?: string  // Dynamic working directory from client
  hyperSpaceTools?: HyperSpaceToolsConfig  // Enable Hyper Space MCP tools for remote workers
  aicoBotMcpUrl?: string   // AICO-Bot MCP proxy base URL (e.g., http://127.0.0.1:3848/mcp)
  aicoBotMcpToken?: string // Auth token for AICO-Bot MCP proxy
  permissionMode?: 'full' | 'partial'  // Permission mode from client settings
  /** Skill names that are allowed to create sub-agents */
  allowSubAgentSkills?: string[]
  /** Server-side stream global timeout (ms), 0 = unlimited, default 2h */
  globalTimeoutMs?: number
}

/**
 * Hyper Space tools configuration for remote workers.
 * When present, the proxy creates an MCP server with proxy tools
 * that delegate execution to the AICO-Bot client via WebSocket.
 */
export interface HyperSpaceToolsConfig {
  spaceId: string
  conversationId: string        // Parent (leader's) conversation ID
  workerId: string
  workerName: string
  teamId: string
}

export interface ServerMessage {
  type: 'auth:success' | 'auth:failed' |
         'claude:stream' | 'claude:complete' | 'claude:error' | 'claude:session' | 'claude:usage' | 'claude:context-usage' |
         'fs:result' | 'fs:error' | 'pong' |
         'tool:call' | 'tool:delta' | 'tool:result' | 'tool:error' |
         'terminal:output' |
         'thought' | 'thought:delta' |  // Thinking process events
         'mcp:status' |  // MCP server status
         'compact:boundary' |  // Context compression notification
         'text:block-start' |  // Text block start signal
         'worker:started' | 'worker:completed' |  // Subagent worker lifecycle
         'agent:spawned' | 'agent:status' | 'agent:killed' | 'agent:list' | 'agent:error' |  // Hyper Space agent management
         'mcp:tool:call' |  // WebSocket MCP Bridge: proxy asks AICO-Bot to execute a tool
         'mcp:tool:response' |  // WebSocket MCP Bridge: AICO-Bot returns tool result
         'task:update' | 'task:list' | 'task:get' | 'task:cancel' | 'task:spawn' |  // Background task management
         'ask:question' |  // AskUserQuestion forwarding to client
         'permission:request' |  // Destructive command permission request to client
         'auth_retry' |  // Auth retry notification (401 auto-recovery)
         'stream:alive' |  // Stream alive heartbeat
         'log'  // Remote log forwarding to local client
  sessionId?: string
  generationId?: string
  data?: any
}

// ============================================
// Hyper Space Agent Types
// ============================================

/**
 * Agent spawn request payload
 */
export interface AgentSpawnPayload {
  task: string
  capabilities?: string[]
  agentType?: 'leader' | 'worker'
  systemPrompt?: string
}

/**
 * Agent spawned response data
 */
export interface AgentSpawnedData {
  agentId: string
  taskId: string
  role: 'leader' | 'worker'
  status: 'starting' | 'running' | 'idle'
}

/**
 * Agent status response data
 */
export interface AgentStatusData {
  agentId: string
  status: 'idle' | 'running' | 'completed' | 'error'
  currentTaskId?: string
  lastHeartbeat?: number
  progress?: number  // 0-100
}

/**
 * Agent list response data
 */
export interface AgentListData {
  agents: Array<{
    id: string
    role: 'leader' | 'worker'
    status: string
    currentTaskId?: string
    lastHeartbeat?: number
  }>
}

/**
 * Agent error response data
 */
export interface AgentErrorData {
  agentId?: string
  error: string
  code?: string
}

export interface FileInfo {
  name: string
  isDirectory: boolean
  size: number
  modifiedTime: Date
}

// Tool call data structures
export interface ToolCallData {
  id: string
  name: string
  input: any
  status: 'started' | 'running' | 'delta' | 'result' | 'error'
  output?: any
  error?: string
}

export interface TerminalOutputData {
  content: string
  type: 'stdout' | 'stderr'
}

export interface StreamAliveData {
  /** Stream elapsed time (ms) */
  elapsedMs: number
  /** Currently executing tool name (if any) */
  currentToolName?: string
  /** Current tool elapsed time (ms, if any) */
  currentToolElapsedMs?: number
}

// Thought data structures (aligned with local Thought type)
export interface ThoughtData {
  id: string
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'result' | 'system'
  content?: string
  timestamp: string
  // For tool_use
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  // For streaming state
  isStreaming?: boolean
  isReady?: boolean
  // For error
  errorCode?: string
}

export interface ThoughtDeltaData {
  thoughtId: string
  delta?: string
  content?: string
  isComplete?: boolean
  // For tool_use
  toolInput?: Record<string, unknown>
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  isReady?: boolean
  isToolInput?: boolean
  isToolResult?: boolean
}

// ============================================
// WebSocket MCP Bridge Types
// ============================================

/**
 * Serialized MCP tool definition for transmission over WebSocket.
 * The handler function is NOT included — it stays on the AICO-Bot side.
 */
export interface AicoBotMcpToolDef {
  name: string
  description: string
  /** Zod raw shape, serialized as plain object (Zod types erased at runtime) */
  inputSchema: Record<string, any>
  /** Source MCP server name: 'ai-browser' | 'gh-search' | user-configured server name */
  serverName: string
}

/**
 * MCP capability flags advertised by the AICO-Bot client.
 */
export interface AicoBotMcpCapabilities {
  aiBrowser: boolean
  ghSearch: boolean
  version?: number
}

/**
 * MCP tool call request from remote proxy to AICO-Bot.
 */
export interface AicoBotMcpToolCallData {
  /** Unique ID for matching request/response */
  callId: string
  /** Source MCP server name */
  serverName: string
  /** Tool name (e.g. 'browser_click') */
  toolName: string
  /** Tool input arguments */
  arguments: Record<string, unknown>
}

/**
 * MCP tool call result from AICO-Bot to remote proxy.
 * Matches the MCP CallToolResult shape.
 */
export interface AicoBotMcpToolResult {
  content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}
