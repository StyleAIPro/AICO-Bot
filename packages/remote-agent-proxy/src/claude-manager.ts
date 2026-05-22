import {
  unstable_v2_createSession,
  createSdkMcpServer,
  tool,
  type SDKSessionOptions,
  type SDKSession
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import https from 'https'
import http from 'http'
import * as fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import type { AicoBotMcpToolDef } from './types.js'

// ============================================
// Zod Schema Reconstruction
// ============================================

/**
 * Reconstruct a Zod schema from its JSON-serialized form.
 *
 * When tool definitions are sent over WebSocket (JSON), Zod class instances
 * become plain objects. The SDK's tool() + createSdkMcpServer() validate
 * inputSchema using instanceof checks, which fail on deserialized objects.
 * This function walks the serialized structure and creates real Zod types.
 */
function reconstructZod(val: any): any {
  if (val === null || val === undefined) return val

  // Detect serialized Zod type by _def.typeName
  if (val && typeof val === 'object' && val._def && typeof val._def.typeName === 'string') {
    const typeName = val._def.typeName
    switch (typeName) {
      case 'ZodString':
        return z.string()
      case 'ZodNumber': {
        let s = z.number()
        const d = val._def
        if (d.checks) {
          for (const check of d.checks) {
            switch (check.kind) {
              case 'int': s = s.int(); break
              case 'min': s = s.min(check.value); break
              case 'max': s = s.max(check.value); break
              case 'positive': s = s.positive(); break
              case 'negative': s = s.negative(); break
              case 'nonpositive': s = s.nonpositive(); break
              case 'nonnegative': s = s.nonnegative(); break
              case 'multipleOf': s = s.multipleOf(check.value); break
              case 'finite': s = s.finite(); break
            }
          }
        }
        if (d.description) s = s.describe(d.description)
        return s
      }
      case 'ZodBoolean':
        return z.boolean()
      case 'ZodOptional':
        return reconstructZod(val._def.innerType).optional()
      case 'ZodNullable':
        return reconstructZod(val._def.innerType).nullable()
      case 'ZodDefault': {
        const defaultVal = typeof val._def.defaultValue === 'function' ? val._def.defaultValue() : val._def.defaultValue
        return reconstructZod(val._def.innerType).default(defaultVal)
      }
      case 'ZodArray':
        return z.array(reconstructZod(val._def.type))
      case 'ZodObject': {
        // After JSON serialization, the shape (a function) is lost.
        // Fall back to z.record(z.string(), z.any()) which accepts any object.
        // This is safe because the SDK uses inputSchema for tool registration,
        // not runtime validation — the LLM decides what arguments to send.
        if (val._def.shape) {
          const shapeRaw = typeof val._def.shape === 'function' ? val._def.shape() : val._def.shape
          if (shapeRaw && typeof shapeRaw === 'object') {
            const shape: Record<string, any> = {}
            for (const [key, fieldVal] of Object.entries(shapeRaw)) {
              shape[key] = reconstructZod(fieldVal)
            }
            return z.object(shape)
          }
        }
        console.warn(`[ZodReconstruct] ZodObject shape lost during serialization, using z.record(z.string(), z.any())`)
        return z.record(z.string(), z.any())
      }
      case 'ZodEnum':
        return z.enum(val._def.values)
      case 'ZodLiteral':
        return z.literal(val._def.value)
      case 'ZodUnion':
        return z.union(val._def.options.map((o: any) => reconstructZod(o)))
      case 'ZodRecord':
        return z.record(reconstructZod(val._def.keyType), reconstructZod(val._def.valueType))
      case 'ZodTuple':
        return z.tuple(val._def.items.map((i: any) => reconstructZod(i)))
      case 'ZodAny':
        return z.any()
      case 'ZodUnknown':
        return z.unknown()
      case 'ZodVoid':
        return z.void()
      case 'ZodDate':
        return z.date()
      case 'ZodBigInt':
        return z.bigint()
      default:
        console.warn(`[ZodReconstruct] Unknown typeName: ${typeName}, falling back to z.any()`)
        return z.any()
    }
  }

  // Raw shape object: { fieldName: ZodType, ... }
  if (typeof val === 'object' && !Array.isArray(val)) {
    // Check if this looks like a raw Zod shape (values have _def.typeName)
    const keys = Object.keys(val)
    if (keys.length > 0 && val[keys[0]] && typeof val[keys[0]] === 'object' && val[keys[0]]._def?.typeName) {
      const shape: Record<string, any> = {}
      for (const [key, fieldVal] of Object.entries(val)) {
        shape[key] = reconstructZod(fieldVal)
      }
      return shape
    }
  }

  return val
}

/**
 * Reconstruct a Zod raw shape from its JSON-serialized form.
 * Top-level entry point: inputSchema is a Record<string, ZodType>.
 */
function reconstructZodRawShape(inputSchema: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, val] of Object.entries(inputSchema)) {
    result[key] = reconstructZod(val)
  }
  return result
}

// ============================================
// Types
// ============================================

/**
 * Internal subagent tracking state (used within streamChat)
 */
interface RemoteSubagentState {
  taskId: string
  toolUseId?: string
  agentId: string
  agentName: string
  description: string
  status: 'running' | 'completed' | 'failed'
  isComplete: boolean
  streamingBlocks: Map<number, { type: 'thinking' | 'text' | 'tool_use'; thoughtId: string; content: string; toolName?: string; toolId?: string }>
  toolIdToThoughtId: Map<string, string>
}

/**
 * Simple interface for chat messages
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Hyper Space tools configuration
 */
export interface HyperSpaceToolsConfig {
  spaceId: string
  conversationId: string
  workerId: string
  workerName: string
  teamId: string
}

export interface ChatOptions {
  maxTokens?: number
  system?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  maxThinkingTokens?: number
  workDir?: string  // Per-session working directory override
  hyperSpaceTools?: HyperSpaceToolsConfig  // Hyper Space MCP tools for remote workers
  aicoBotMcpUrl?: string   // AICO-Bot MCP proxy base URL (e.g., http://127.0.0.1:3848/mcp)
  aicoBotMcpToken?: string // Auth token for AICO-Bot MCP proxy
  contextWindow?: number   // Context window size for compression threshold and usage display
  isWorkerTask?: boolean   // When true, suppress worker:started/completed for SDK internal subagents
  permissionMode?: 'full' | 'partial'  // Permission mode: full = skip all checks, partial = check destructive commands
}

export interface ToolCall {
  id: string
  name: string
  input: any
  status: 'started' | 'running' | 'delta' | 'result' | 'error'
  output?: any
  error?: string
}

/**
 * Terminal output from V2 Session
 */
export interface TerminalOutput {
  content: string
  type: 'stdout' | 'stderr'
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  contextWindow: number
}

/**
 * Thought event (for thinking, tool_use, etc.)
 */
export interface ThoughtEvent {
  id: string
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'result' | 'system'
  content?: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  isStreaming?: boolean
  isReady?: boolean
  errorCode?: string
  agentId?: string
  agentName?: string
}

/**
 * Thought delta event (streaming updates)
 */
export interface ThoughtDeltaEvent {
  thoughtId: string
  delta?: string
  content?: string
  isComplete?: boolean
  toolInput?: Record<string, unknown>
  isReady?: boolean
  isToolInput?: boolean
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  isToolResult?: boolean
  agentId?: string
  agentName?: string
}

/**
 * MCP server status event
 */
export interface McpStatusEvent {
  servers: Array<{ name: string; status: string }>
}

/**
 * Compact boundary event (context compression)
 */
export interface CompactBoundaryEvent {
  trigger: 'manual' | 'auto'
  preTokens: number
}

/**
 * File operation result
 */
export interface FileOperation {
  type: 'read' | 'write' | 'delete' | 'list'
  path: string
  result?: any
  error?: string
}

/**
 * File info for directory listing
 */
export interface FileInfo {
  name: string
  isDirectory: boolean
  size: number
  modifiedTime: Date
}

/**
 * Session configuration for rebuild detection
 */
export interface SessionConfig {
  model?: string
  workDir?: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number  // Context window affects autocompact threshold, rebuild on change
  permissionMode?: string  // Permission mode change must trigger session rebuild
}

/**
 * V2 Session info with metadata (aligned with local session-manager.ts)
 */
export interface V2SessionInfo {
  session: SDKSession
  conversationId: string  // Use conversationId as key (aligned with local)
  createdAt: number
  lastUsedAt: number
  config: SessionConfig
  configGeneration: number  // For config change detection
  mcpToolSignature?: string  // Sorted tool names hash for MCP bridge change detection
  interrupted?: boolean  // Set when stream was aborted — session may be corrupted, skip reuse
}

/**
 * Active session state for in-flight request tracking
 */
export interface ActiveSessionState {
  conversationId: string
  abortController: AbortController
}

// ============================================
// Constants
// ============================================

/**
 * Pre-approved tools that skip the canUseTool permission callback.
 * Only safe/read-only tools + reversible file operations.
 */
const PRE_APPROVED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Create',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'Skill',
]

/** @deprecated Use PRE_APPROVED_TOOLS for SDK allowedTools */
const DEFAULT_ALLOWED_TOOLS = PRE_APPROVED_TOOLS

// ============================================
// Bash Destructive Command Detection
// (Mirrors local permission-handler.ts — keep in sync)
// ============================================

const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'shred', 'truncate',
  'mv', 'cp',
  'chmod', 'chown', 'chgrp',
  'kill', 'pkill', 'killall',
  'sudo', 'su', 'shutdown', 'reboot', 'halt', 'poweroff',
  'dd', 'mkfs', 'fdisk', 'parted', 'mkswap', 'swapon', 'swapoff',
  'apt-get', 'apt', 'yum', 'dnf', 'pacman', 'brew',
])

const DESTRUCTIVE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['uninstall', 'publish']),
  yarn: new Set(['remove']),
  pnpm: new Set(['remove', 'uninstall']),
  git: new Set(['push --force', 'push -f', 'clean', 'reset --hard']),
  docker: new Set(['rm', 'rmi', 'system prune', 'volume rm']),
  kubectl: new Set(['delete', 'cordon', 'drain']),
}

function isDestructiveBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  const segments = trimmed.split(/\s*[;&|]\s*/).filter(Boolean)
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/)
    if (tokens.length === 0) continue
    let cmdIndex = 0
    while (cmdIndex < tokens.length && ['env', 'sudo'].includes(tokens[cmdIndex])) {
      cmdIndex++
      while (cmdIndex < tokens.length && tokens[cmdIndex].startsWith('-')) cmdIndex++
    }
    if (cmdIndex >= tokens.length) continue
    const baseCmd = tokens[cmdIndex]
    const restOfCommand = tokens.slice(cmdIndex + 1).join(' ')
    if (DESTRUCTIVE_COMMANDS.has(baseCmd)) return true
    const subCmds = DESTRUCTIVE_SUBCOMMANDS[baseCmd]
    if (subCmds && restOfCommand) {
      for (const pattern of subCmds) {
        if (restOfCommand.startsWith(pattern)) return true
      }
    }
  }
  if (/>/.test(trimmed) && /\/(etc|usr|bin|sbin|boot|var|sys|proc)/.test(trimmed)) return true
  return false
}

/**
 * Session idle timeout in milliseconds (2 hours - for long-running tasks like docker pulls)
 */
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * Cleanup interval in milliseconds (1 minute)
 */
const CLEANUP_INTERVAL_MS = 60 * 1000

// ============================================
// Helper Functions (aligned with local session-manager.ts)
// ============================================

/**
 * Check if a directory is a git repository
 */
function isGitRepo(dir: string): boolean {
  try {
    // Check if .git exists in the directory or any parent
    let currentDir = dir
    while (currentDir !== path.dirname(currentDir)) {
      if (fs.existsSync(path.join(currentDir, '.git'))) {
        return true
      }
      currentDir = path.dirname(currentDir)
    }
    // Check root level
    return fs.existsSync(path.join(currentDir, '.git'))
  } catch {
    return false
  }
}

/**
 * Build system prompt for Claude Code
 * Loads from synced file if available, otherwise uses fallback
 */
function buildSystemPrompt(workDir: string, modelInfo?: string): string {
  const today = new Date().toISOString().split('T')[0]
  const isGit = isGitRepo(workDir)

  // Try to load synced system prompt from file
  const systemPromptPath = path.join('/opt/claude-deployment', 'config', 'system-prompt.txt')

  try {
    if (fs.existsSync(systemPromptPath)) {
      console.log('[ClaudeManager] Loading system prompt from:', systemPromptPath)
      let systemPrompt = fs.readFileSync(systemPromptPath, 'utf-8')

      // Replace dynamic placeholders (uppercase to match system-prompt.ts template)
      // Must match all placeholders in SYSTEM_PROMPT_TEMPLATE from system-prompt.ts
      systemPrompt = systemPrompt
        .replace(/\$\{ALLOWED_TOOLS\}/g, 'Read, Write, Edit, Grep, Glob, Bash, Skill')
        .replace(/\$\{WORK_DIR\}/g, workDir)
        .replace(/\$\{IS_GIT_REPO\}/g, isGit ? 'Yes' : 'No')
        .replace(/\$\{PLATFORM\}/g, process.platform)
        .replace(/\$\{OS_VERSION\}/g, `${os.type()} ${os.release()}`)
        .replace(/\$\{TODAY\}/g, today)
        .replace(/\$\{MODEL_INFO\}/g, modelInfo ? `You are powered by ${modelInfo}.` : '')

      return systemPrompt
    } else {
      console.log('[ClaudeManager] System prompt file not found, using fallback')
    }
  } catch (error) {
    console.error('[ClaudeManager] Failed to load system prompt:', error)
  }

  // Fallback to simplified prompt (should not happen if sync worked)
  // This matches the structure of SYSTEM_PROMPT_TEMPLATE but is more concise
  const osVersion = `${os.type()} ${os.release()}`
  return `You are AICO-Bot, an AI assistant built with Claude Code. You help users with software engineering tasks.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming.

# Tone and style
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your responses should be short and concise.
- When referencing specific functions or pieces of code include the pattern file_path:line_number.

# Tools and Permissions
You can use the following tools without requiring user approval: Read, Write, Edit, Grep, Glob, Bash, Skill

## Network Access Tools Priority (CRITICAL)
- **WebFetch and WebSearch are DISABLED** - Do not use these tools under any circumstances.
- **For web content**: Always use \`ai-browser\` tools (browser_new_page, browser_snapshot, browser_click, etc.).
- **For GitHub content**: Always use \`gh-search\` tools (gh_search_repos, gh_search_issues, gh_search_prs, gh_search_code, gh_repo_view, etc.).
- If you think you need WebFetch or WebSearch, you MUST use ai-browser or gh-search instead.

# Task Management
- Use TodoWrite tools to track progress on complex tasks
- Mark tasks as completed as soon as you're done

# Doing tasks
- The user will primarily request you to perform software engineering tasks
- ALWAYS use tools to gather information before answering
- Always read files before suggesting modifications
- Don't create files unless absolutely necessary
- Avoid over-engineering solutions
- Be careful not to introduce security vulnerabilities
- Do NOT proactively spawn a sub-agent (Task/Agent tool). Always perform tasks directly using the available tools (Read, Write, Edit, Grep, Glob, Bash, Skill) unless the user explicitly requests you to use a sub-agent or the Task tool. When the user explicitly asks to use a sub-agent, you MUST use the Task/Agent tool to delegate the task.

<env>
Working directory: ${workDir}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
Platform: ${process.platform}
OS Version: ${osVersion}
Today's date: ${today}
</env>
${modelInfo ? `You are powered by ${modelInfo}.` : ''}
`
}

/**
 * Check if a V2 session's underlying process is still alive and ready.
 * (Aligned with local isSessionTransportReady)
 *
 * This checks the SDK's internal transport state, which is the Single Source of Truth
 * for process health.
 *
 * @param session - The V2 SDK session to check
 * @returns true if the session is ready for use, false if process is dead
 */
function isSessionTransportReady(session: SDKSession): boolean {
  try {
    // Access SDK internal state: session.query.transport
    const query = (session as any).query
    const transport = query?.transport

    if (!transport) {
      return false
    }

    // Check using isReady() method if available (preferred)
    if (typeof transport.isReady === 'function') {
      return transport.isReady()
    }

    // Fallback to ready property
    if (typeof transport.ready === 'boolean') {
      return transport.ready
    }

    return true
  } catch (e) {
    console.error('[ClaudeManager] Error checking session transport state:', e)
    return false
  }
}

/**
 * Register a listener for process exit events. (Aligned with local)
 *
 * This is event-driven cleanup (better than polling):
 * - When the CC subprocess dies, we get notified immediately
 * - We then call session.close() to release resources
 *
 * @param session - The V2 SDK session
 * @param conversationId - Conversation ID for logging and cleanup
 * @param onExit - Callback when process exits
 */
function registerProcessExitListener(
  session: SDKSession,
  conversationId: string,
  onExit: (conversationId: string) => void
): void {
  try {
    const transport = (session as any).query?.transport

    if (!transport) {
      console.warn(`[ClaudeManager][${conversationId}] Cannot register exit listener: no transport`)
      return
    }

    if (typeof transport.onExit === 'function') {
      transport.onExit((error: Error | undefined) => {
        const errorMsg = error ? `: ${error.message}` : ''
        console.log(`[ClaudeManager][${conversationId}] Process exited${errorMsg}`)
        onExit(conversationId)
      })
      console.log(`[ClaudeManager][${conversationId}] Process exit listener registered`)
    } else {
      console.warn(`[ClaudeManager][${conversationId}] SDK transport.onExit not available`)
    }
  } catch (e) {
    console.error(`[ClaudeManager][${conversationId}] Failed to register exit listener:`, e)
  }
}

/**
 * Wait for an SDK session's underlying process to fully exit.
 *
 * Uses dual approach for reliability:
 * 1. Event-driven via transport.onExit (immediate)
 * 2. Polling via isSessionTransportReady (fallback every 200ms)
 *
 * @param session - The V2 SDK session
 * @param timeoutMs - Maximum time to wait (default 10s)
 */
function waitForProcessExit(session: SDKSession, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve) => {
    // If transport already not ready, process is already dead
    if (!isSessionTransportReady(session)) {
      resolve()
      return
    }

    let settled = false
    const transport = (session as any).query?.transport

    // Event-driven: listen for onExit callback
    if (transport && typeof transport.onExit === 'function') {
      transport.onExit(() => {
        if (!settled) {
          settled = true
          clearInterval(poll)
          clearTimeout(timer)
          resolve()
        }
      })
    }

    // Polling fallback: check transport readiness every 200ms
    const poll = setInterval(() => {
      if (!isSessionTransportReady(session)) {
        if (!settled) {
          settled = true
          clearInterval(poll)
          clearTimeout(timer)
          resolve()
        }
      }
    }, 200)

    // Timeout: don't block forever, resolve anyway after timeout
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        clearInterval(poll)
        console.warn('[ClaudeManager] waitForProcessExit timed out, proceeding anyway')
        resolve()
      }
    }, timeoutMs)
  })
}

/**
 * Check if session config requires rebuild
 */
function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return (
    existing.config.model !== newConfig.model ||
    existing.config.workDir !== newConfig.workDir ||
    existing.config.apiKey !== newConfig.apiKey ||
    existing.config.baseUrl !== newConfig.baseUrl ||
    existing.config.contextWindow !== newConfig.contextWindow ||
    existing.config.permissionMode !== newConfig.permissionMode
  )
}

/**
 * Compute a stable signature from MCP tool definitions.
 * Used to detect tool set changes across turns (e.g., ai-browser toggled on/off).
 * Only considers tool names and server names — description/schema changes are tolerated.
 */
function computeMcpToolSignature(toolDefs: Array<{ name: string; serverName: string }> | undefined): string | undefined {
  if (!toolDefs || toolDefs.length === 0) return undefined
  const sorted = toolDefs.map(d => `${d.serverName}:${d.name}`).sort()
  return sorted.join(',')
}

// ============================================
// Claude Manager (aligned with local session-manager.ts)
// ============================================

/**
 * Claude Manager using V2 Session for full Claude Code capabilities
 *
 * Features (aligned with local):
 * - Session persistence (conversation history)
 * - Session resumption
 * - Process reuse (fast responses)
 * - Process health check before reuse
 * - Event-driven cleanup (process exit listener)
 * - Idle timeout cleanup (30 minutes)
 * - Config change detection
 * - Active request tracking
 */
export class ClaudeManager {
  // Session maps (aligned with local)
  private sessions: Map<string, V2SessionInfo> = new Map()  // conversationId -> V2SessionInfo
  private activeSessions: Map<string, ActiveSessionState> = new Map()  // In-flight requests
  private interruptedSessions: Set<string> = new Set()  // Sessions marked for interrupt
  // Track active stream iterators for forceful interruption
  private activeStreamIterators: Map<string, { abortController: AbortController }> = new Map()
  // Pending messages queue — stores messages for sessions with active streams
  private pendingMessages: Map<string, Array<{content: string, options?: any}>> = new Map()
  // External callbacks for process exit notification
  private sessionExitCallbacks: Map<string, (reason: string) => void> = new Map()
  // Timeout for first event from stream — detects corrupted sessions that hang
  private static readonly FIRST_EVENT_TIMEOUT_MS = 30_000

  // Configuration
  private apiKey?: string
  private baseUrl?: string
  private pathToClaudeCodeExecutable?: string
  private workDir?: string
  private model?: string
  private contextWindow?: number  // Context window size for compression threshold
  private aicoBotMcpUrl?: string    // AICO-Bot MCP proxy base URL
  private aicoBotMcpToken?: string  // Auth token for AICO-Bot MCP proxy

  // OpenAI Compat Router — lazy-started local HTTP server for protocol translation
  private routerInfo: import('./openai-compat-router/types/index.js').RouterServerInfo | null = null

  // Config generation for change detection
  private configGeneration = 0

  // Cleanup interval
  private cleanupIntervalId: NodeJS.Timeout | null = null

  constructor(
    apiKey?: string,
    baseUrl?: string,
    pathToClaudeCodeExecutable?: string,
    workDir?: string,
    model?: string,
    contextWindow?: number
  ) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable
    this.workDir = workDir || process.cwd()
    this.model = model
    this.contextWindow = contextWindow

    // Start cleanup interval
    this.startCleanupInterval()
  }

  /**
   * Get current config for session creation
   */
  private getCurrentConfig(): SessionConfig {
    return {
      model: this.model,
      workDir: this.workDir,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      contextWindow: this.contextWindow
    }
  }

  /**
   * Increment config generation (call when config changes)
   */
  updateConfig(apiKey?: string, baseUrl?: string, workDir?: string, model?: string, contextWindow?: number): void {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.workDir = workDir || process.cwd()
    this.model = model
    this.contextWindow = contextWindow
    this.configGeneration++
    console.log(`[ClaudeManager] Config updated, generation: ${this.configGeneration}`)
  }

  // ============================================================================
  // OpenAI Compat Router
  // ============================================================================

  /**
   * Detect whether the backend API is native Anthropic or OpenAI-compatible.
   * Used to decide whether to route requests through the local protocol translator.
   */
  private detectBackendType(baseUrl?: string): 'anthropic' | 'openai_compat' {
    // Explicit override via env var (e.g., for Anthropic-compatible proxies)
    if (process.env.REMOTE_AGENT_API_TYPE === 'anthropic_passthrough') return 'anthropic'
    // No custom URL = default Anthropic
    if (!baseUrl) return 'anthropic'
    // Known Anthropic URLs (including Dashscope Claude-as-a-Service /apps/anthropic)
    if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
    if (baseUrl.includes('/anthropic')) return 'anthropic'
    // Anthropic standard endpoint: /v1/messages or /messages
    if (baseUrl.endsWith('/v1/messages') || baseUrl.endsWith('/messages')) return 'anthropic'
    // Everything else is treated as OpenAI-compatible
    return 'openai_compat'
  }

  /**
   * Ensure the local OpenAI Compat Router is running.
   * Lazy-started on first request when a non-Anthropic backend is detected.
   * The router listens on 127.0.0.1:0 (OS-assigned random port).
   */
  private async ensureRouter(): Promise<import('./openai-compat-router/types/index.js').RouterServerInfo> {
    if (this.routerInfo) return this.routerInfo
    const { ensureOpenAICompatRouter } = await import('./openai-compat-router/server/index.js')
    this.routerInfo = await ensureOpenAICompatRouter({ debug: false })
    console.log(`[ClaudeManager] OpenAI Compat Router started on ${this.routerInfo!.baseUrl}`)
    return this.routerInfo!
  }

  /**
   * Hyper-space MCP server creation.
   * Delegates tool execution back to AICO-Bot via WebSocket (tool:call / tool:approve).
   * Kept for backward compatibility with old AICO-Bot clients that don't support proxy orchestrator.
   */
  private createHyperSpaceMcpServerLegacy(
    config: HyperSpaceToolsConfig,
    toolExecutor: (toolId: string, toolName: string, toolInput: Record<string, unknown>) => Promise<string>
  ): any {
    const textResult = (text: string, isError = false) => ({
      content: [{ type: 'text' as const, text }],
      ...(isError ? { isError: true } : {})
    })

    const generateToolId = () => `hs-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    const { workerId, workerName, conversationId } = config

    const mcpServer = createSdkMcpServer({
      name: 'hyper-space',
      version: '1.0.0',
      tools: [
        tool('report_to_leader',
          'Send an intermediate progress update or message to the team leader.',
          { message: z.string(), type: z.string().optional() },
          async (args: any) => {
            try {
              const toolId = generateToolId()
              await toolExecutor(toolId, 'report_to_leader', { workerId, workerName, spaceId: config.spaceId, conversationId, message: args.message, reportType: args.type || 'progress' })
              return textResult(`Report sent to leader.\nType: ${args.type || 'progress'}\nContinue working on your task.`)
            } catch (e) { return textResult(`Error: ${(e as Error).message}`, true) }
          }
        ),
        tool('announce_completion',
          'Signal task completion to the team leader.',
          { taskId: z.string(), status: z.string(), result: z.string(), summary: z.string() },
          async (args: any) => {
            try {
              const toolId = generateToolId()
              await toolExecutor(toolId, 'announce_completion', { workerId, workerName, spaceId: config.spaceId, conversationId, taskId: args.taskId, status: args.status, result: args.result, summary: args.summary })
              return textResult(`Task ${args.taskId} marked as ${args.status}.\nAnnouncement sent to leader.`)
            } catch (e) { return textResult(`Error: ${(e as Error).message}`, true) }
          }
        ),
        tool('ask_question',
          'Ask the leader or user a question.',
          { question: z.string(), target: z.string().optional() },
          async (args: any) => {
            try {
              const toolId = generateToolId()
              await toolExecutor(toolId, 'ask_question', { workerId, workerName, spaceId: config.spaceId, conversationId, question: args.question, target: args.target || 'leader' })
              return textResult(`Question sent to ${args.target || 'leader'}.\nContinue working on other parts of your task.`)
            } catch (e) { return textResult(`Error: ${(e as Error).message}`, true) }
          }
        ),
        tool('send_message',
          'Send a message to another agent in the team.',
          { recipient: z.string(), content: z.string() },
          async (args: any) => {
            try {
              const toolId = generateToolId()
              await toolExecutor(toolId, 'send_message', { workerId, workerName, spaceId: config.spaceId, conversationId, recipient: args.recipient, content: args.content })
              return textResult(`Message sent to ${args.recipient}.`)
            } catch (e) { return textResult(`Error: ${(e as Error).message}`, true) }
          }
        ),
        tool('list_team_members',
          'List all agents in the Hyper Space team.',
          {},
          async () => {
            try {
              const toolId = generateToolId()
              const result = await toolExecutor(toolId, 'list_team_members', { workerId, workerName, spaceId: config.spaceId, conversationId })
              return textResult(result)
            } catch (e) { return textResult(`Error: ${(e as Error).message}`, true) }
          }
        )
      ]
    })
    return mcpServer
  }

  /**
   * Create aico-bot-builtin MCP server for tools from the AICO-Bot client.
   * Tools delegate execution to the AICO-Bot client via WebSocket (mcp:tool:call).
   *
   * Each PC's WebSocket connection provides its own set of tools.
   *
   * @param toolDefs - Serialized tool definitions from the AICO-Bot client
   * @param executeTool - Callback to execute a tool on the AICO-Bot client via WebSocket
   */
  private createAicoBotBuiltinMcpServer(
    toolDefs: AicoBotMcpToolDef[],
    executeTool: (callId: string, toolName: string, args: Record<string, unknown>) => Promise<any>
  ): any {
    const textResult = (text: string, isError = false) => ({
      content: [{ type: 'text' as const, text }],
      ...(isError ? { isError: true } : {})
    })

    const generateCallId = () => `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    // Build tool definitions from the serialized AICO-Bot tool definitions.
    // inputSchema was Zod on the AICO-Bot side but lost class identity after
    // JSON serialization over WebSocket. Reconstruct real Zod objects before
    // passing to SDK tool() which validates via instanceof checks.
    const tools = toolDefs.map(def => {
      const rawShape = reconstructZodRawShape(def.inputSchema)
      return tool(
        def.name,
        def.description,
        rawShape,
        async (args: any) => {
          try {
            const callId = generateCallId()
            console.log(`[AicoBotMcpBridge] Tool called: ${def.serverName}:${def.name}`)
            const result = await executeTool(callId, def.name, args)
            // Handle result shape — could be CallToolResult or raw string
            if (typeof result === 'string') {
              return textResult(result)
            }
            return result  // Already in CallToolResult shape
          } catch (e) {
            return textResult(`Error executing ${def.name}: ${(e as Error).message}`, true)
          }
        }
      )
    })

    return createSdkMcpServer({
      name: 'aico-bot-builtin',
      version: '1.0.0',
      tools
    })
  }

  /**
   * Build SDK options for session creation.
   *
   * For non-Anthropic backends (OpenAI-compatible APIs like Qwen, vLLM, etc.),
   * starts a local OpenAI Compat Router that translates Anthropic Messages API
   * to OpenAI Chat Completions API — identical to how local AICO-Bot handles it.
   *
   * For native Anthropic backends, passes credentials directly (no translation needed).
   *
   * @param workDir - Optional override for working directory (per-session)
   * @param customSystemPrompt - Optional custom system prompt (from client space config)
   * @param contextWindow - Optional context window size (from client AI source config)
   * @param credentials - Optional per-request credentials (from client), overrides instance config
   */
  private async buildSdkOptions(
    workDir?: string,
    customSystemPrompt?: string,
    contextWindow?: number,
    credentials?: { apiKey?: string; baseUrl?: string; model?: string }
  ): Promise<any> {
    // Resolve effective credentials: per-request overrides instance config
    const effectiveApiKey = credentials?.apiKey || this.apiKey
    const effectiveBaseUrl = credentials?.baseUrl || this.baseUrl
    const effectiveModel = credentials?.model || this.model

    const effectiveWorkDir = workDir || this.workDir || process.cwd()
    // Display the real model name in system prompt (for user-facing info)
    const basePrompt = buildSystemPrompt(effectiveWorkDir, effectiveModel)
    const systemPrompt = customSystemPrompt
      ? `${basePrompt}\n\n# Additional Instructions (from space configuration)\n\n${customSystemPrompt}`
      : basePrompt

    const options: any = {
      model: effectiveModel || 'claude-sonnet-4-6',
      cwd: effectiveWorkDir,
      // Use SDK's 'preset' type so built-in skill injection works,
      // then append AICO-Bot custom system prompt (mirrors local sdk-config.ts)
      systemPrompt: {
        type: 'preset',
        append: systemPrompt,
      },
      permissionMode: 'default',
      extraArgs: {},
      allowedTools: [...PRE_APPROVED_TOOLS],
      // Explicitly disable WebFetch, WebSearch, Agent and Task tools
      disallowedTools: ['WebFetch', 'WebSearch'],
      includePartialMessages: true,
      maxTurns: 50,
    }

    if (this.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable
    }

    // CRITICAL: Inherit process.env (especially PATH)
    // But first, strip AI SDK vars and CLAUDECODE to prevent nested session detection
    const cleanEnv = { ...process.env }
    delete cleanEnv.CLAUDECODE
    if (!cleanEnv.ANTHROPIC_AUTH_TOKEN) {
      delete cleanEnv.ANTHROPIC_AUTH_TOKEN
    }
    if (!cleanEnv.ANTHROPIC_API_KEY) {
      delete cleanEnv.ANTHROPIC_API_KEY
    }
    if (!cleanEnv.ANTHROPIC_BASE_URL) {
      delete cleanEnv.ANTHROPIC_BASE_URL
    }

    options.env = cleanEnv

    // ── Route through OpenAI Compat Router for non-Anthropic backends ──
    const backendType = this.detectBackendType(effectiveBaseUrl)

    if (backendType === 'openai_compat') {
      // Start local protocol translator (lazy, once per process lifetime)
      const router = await this.ensureRouter()

      // Encode real backend config into the API key (same as local AICO-Bot)
      const { encodeBackendConfig } = await import('./openai-compat-router/utils/config.js')
      const { getApiTypeFromUrl } = await import('./openai-compat-router/server/api-type.js')
      const { normalizeApiUrl } = await import('./openai-compat-router/utils/url.js')

      // Normalize URL: auto-append /v1/chat/completions for bare host URLs (e.g., http://IP:port)
      const normalizedUrl = normalizeApiUrl(effectiveBaseUrl || '', 'openai')

      // Determine API type from URL suffix, default to chat_completions
      const apiType = getApiTypeFromUrl(normalizedUrl) || 'chat_completions'

      const encodedConfig = encodeBackendConfig({
        url: normalizedUrl,
        key: effectiveApiKey || '',
        model: effectiveModel,
        apiType,
      })

      // CRITICAL: Must set BOTH ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN.
      // The SDK CLI subprocess reads ANTHROPIC_API_KEY as its primary credential.
      // ANTHROPIC_AUTH_TOKEN alone is insufficient — if ANTHROPIC_API_KEY is already
      // set in the process environment (e.g., from remote server .env), the SDK will
      // use the raw key instead of the encoded config.
      // This matches local AICO-Bot's approach in sdk-config.ts:381.
      options.env.ANTHROPIC_API_KEY = encodedConfig
      options.env.ANTHROPIC_AUTH_TOKEN = encodedConfig
      options.env.ANTHROPIC_BASE_URL = router.baseUrl

      // Fake Claude model — SDK sends standard Anthropic-format requests to the router,
      // which then converts to OpenAI format and replaces the model name with the real one.
      options.model = 'claude-sonnet-4-6'

      console.log(`[ClaudeManager] Routing via OpenAI Compat Router: ${router.baseUrl} -> ${normalizedUrl} (apiType=${apiType}, model=${effectiveModel})`)
    } else {
      // Native Anthropic / Anthropic-compatible proxy — direct passthrough
      // CRITICAL: Must set BOTH ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN.
      // The SDK CLI subprocess reads ANTHROPIC_API_KEY as its primary credential.
      // Same fix as openai_compat path above (see line 915-922).
      if (effectiveApiKey) {
        options.env.ANTHROPIC_API_KEY = effectiveApiKey
        options.env.ANTHROPIC_AUTH_TOKEN = effectiveApiKey
      }
      if (effectiveBaseUrl) {
        options.env.ANTHROPIC_BASE_URL = effectiveBaseUrl
      }
      // Use the real model name — /anthropic endpoints (DashScope, Zhipu, etc.)
      // accept their own model names, not substituted Claude model names.
    }

    // Important env vars
    options.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    options.env.DISABLE_AUTOUPDATER = '1'
    options.env.API_TIMEOUT_MS = '3000000'
    options.env.DISABLE_TELEMETRY = '1'
    options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

    // Override sub-agent model to inherit parent session model.
    // For openai_compat: set to the real model so the router replaces correctly.
    // For anthropic: set to the configured model so sub-agents use the same model.
    // This env var has the highest priority in SDK's Ik6() model resolution function.
    if (effectiveModel) {
      options.env.CLAUDE_CODE_SUBAGENT_MODEL = effectiveModel
    }

    // Context window: tell CLI subprocess the real context window so autocompact
    // triggers at the correct threshold (default ~200K, client may configure 1M+).
    const effectiveContextWindow = contextWindow || this.contextWindow
    if (effectiveContextWindow) {
      options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(effectiveContextWindow)
    }

    // Merge skills from ~/.agents/skills/ and ~/.claude/skills/ into configSkillsDir
    // (mirrors local sdk-config.ts mergeSkillsDirs logic, adapted for Linux 'dir' symlinks)
    const agentsDir = path.join(os.homedir(), '.agents')
    const configDir = path.join(agentsDir, 'claude-config')
    const skillsDir = path.join(agentsDir, 'skills')
    const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills')
    const configSkillsDir = path.join(configDir, 'skills')

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // Replace legacy single-dir symlink with a real directory
    try {
      const configSkillsLstat = fs.lstatSync(configSkillsDir)
      if (configSkillsLstat.isSymbolicLink()) {
        fs.unlinkSync(configSkillsDir)
        fs.mkdirSync(configSkillsDir, { recursive: true })
      }
    } catch {
      // configSkillsDir does not exist yet — create it
      fs.mkdirSync(configSkillsDir, { recursive: true })
    }

    // Collect candidates: skillName -> { sourcePath, mtime } (dedup by newest mtime)
    const candidates = new Map<string, { sourcePath: string; mtime: number }>()
    for (const sourceDir of [skillsDir, claudeSkillsDir]) {
      try {
        if (!fs.existsSync(sourceDir)) continue
        const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const sourcePath = path.join(sourceDir, entry.name)
          try {
            // Skip disabled skills (META.json.enabled === false)
            const metaPath = path.join(sourcePath, 'META.json')
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
              if (meta.enabled === false) continue
            } catch {
              // META.json missing or invalid — proceed
            }

            const stat = fs.statSync(sourcePath)
            const existing = candidates.get(entry.name)
            if (!existing || stat.mtimeMs > existing.mtime) {
              candidates.set(entry.name, { sourcePath, mtime: stat.mtimeMs })
            }
          } catch {
            // stat failed, skip
          }
        }
      } catch (err) {
        console.warn('[ClaudeManager] Failed to read source dir:', sourceDir, err)
      }
    }

    // Clean up stale symlinks in configSkillsDir
    try {
      const existingEntries = fs.readdirSync(configSkillsDir, { withFileTypes: true })
      for (const entry of existingEntries) {
        if (!entry.isDirectory()) continue
        if (!candidates.has(entry.name)) {
          try {
            fs.unlinkSync(path.join(configSkillsDir, entry.name))
            console.log(`[ClaudeManager] Removed stale skill link: ${entry.name}`)
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    // Create per-skill symlinks (use 'dir' type on Linux)
    for (const [name, { sourcePath }] of candidates) {
      const targetPath = path.join(configSkillsDir, name)
      try {
        fs.unlinkSync(targetPath)
      } catch {
        /* doesn't exist, proceed */
      }
      try {
        fs.symlinkSync(sourcePath, targetPath, 'dir')
      } catch (err) {
        console.warn(`[ClaudeManager] Failed to link skill ${name}:`, err)
      }
    }

    // Create .claude/skills symlink for SDK project-level discovery
    const dotClaudeDir = path.join(configDir, '.claude')
    const dotClaudeSkillsDir = path.join(dotClaudeDir, 'skills')
    if (!fs.existsSync(dotClaudeDir)) {
      fs.mkdirSync(dotClaudeDir, { recursive: true })
    }
    if (!fs.existsSync(dotClaudeSkillsDir)) {
      try {
        fs.symlinkSync(configSkillsDir, dotClaudeSkillsDir, 'dir')
      } catch (err) {
        console.warn('[ClaudeManager] Failed to create .claude/skills symlink:', err)
      }
    }

    options.env.CLAUDE_CONFIG_DIR = configDir
    options.settingSources = ['user', 'project']
    // Tell SDK to also scan configDir for project-level skill discovery
    // (.claude/skills/ inside configDir), mirrors local sdk-config.ts
    options.additionalDirectories = [configDir]

    // CRITICAL: IS_SANDBOX=1 is required for bypass-permissions mode when running as root
    options.env.IS_SANDBOX = '1'

    return options
  }

  /**
   * Clean up a single session (aligned with local cleanupSession)
   */
  private cleanupSession(conversationId: string, reason: string): void {
    const info = this.sessions.get(conversationId)
    if (!info) return

    console.log(`[ClaudeManager][${conversationId}] Cleaning up session: ${reason}`)

    try {
      info.session.close()
    } catch (e: any) {
      // Ignore EPIPE errors (common on Windows when process already exited)
      // Aligned with local session-manager.ts
      if (e?.code === 'EPIPE' || e?.message?.includes('EPIPE')) {
        console.log(`[ClaudeManager][${conversationId}] Session close: EPIPE (process already exited)`)
      }
    }

    this.sessions.delete(conversationId)
  }

  /**
   * Start the session cleanup interval (aligned with local)
   */
  private startCleanupInterval(): void {
    if (this.cleanupIntervalId) return

    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now()
      for (const [convId, info] of Array.from(this.sessions.entries())) {
        // Check 1: Clean up sessions with dead processes
        if (!isSessionTransportReady(info.session)) {
          this.cleanupSession(convId, 'process not ready (polling)')
          continue
        }

        // Check 2: Clean up idle sessions (skip if request in flight)
        if (this.activeSessions.has(convId)) {
          info.lastUsedAt = now
          continue
        }

        if (now - info.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
          this.cleanupSession(convId, 'idle timeout (2 hours)')
        }
      }
    }, CLEANUP_INTERVAL_MS)
  }

  /**
   * Stop the cleanup interval
   */
  private stopCleanupInterval(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId)
      this.cleanupIntervalId = null
    }
  }

  /**
   * Get or create a V2 session (aligned with local getOrCreateV2Session)
   *
   * Key features:
   * - Process health check before reuse
   * - Config change detection
   * - Active request tracking
   * - Per-session workDir support
   * - Session resumption via resume parameter (SDK patch required)
   *
   * @param conversationId - Use conversationId as key (aligned with local)
   * @param workDir - Optional working directory override for this session
   * @param resumeSessionId - Optional session ID to resume from (for conversation history)
   * @param maxThinkingTokens - Optional max thinking tokens for this session
   * @param hyperSpaceMcpServer - Optional hyper space MCP server
   * @param customSystemPrompt - Optional custom system prompt
   * @param aicoBotBuiltinMcpServer - Optional AICO-Bot built-in MCP server
   * @param contextWindow - Optional context window size for compression
   */
  async getOrCreateSession(
    conversationId: string,
    workDir?: string,
    resumeSessionId?: string,
    maxThinkingTokens?: number,
    hyperSpaceMcpServer?: any,
    customSystemPrompt?: string,
    aicoBotBuiltinMcpServer?: any,
    contextWindow?: number,
    credentials?: { apiKey?: string; baseUrl?: string; model?: string },
    canUseTool?: any,
    mcpToolSignature?: string
  ): Promise<SDKSession> {
    const effectiveWorkDir = workDir || this.workDir || process.cwd()
    const existing = this.sessions.get(conversationId)

    // CRITICAL: If workDir doesn't match and a resumeSessionId is provided,
    // skip resume — --resume inherits the original session's cwd, ignoring our cwd param.
    // A fresh session (no --resume) is the only way to change the working directory.
    const workDirChanged = existing && existing.config.workDir !== effectiveWorkDir
    const effectiveResumeId = workDirChanged ? undefined : resumeSessionId

    if (existing) {
      // CRITICAL: Check if workDir changed - if so, need to recreate session
      if (workDirChanged) {
        console.log(`[ClaudeManager][${conversationId}] WorkDir changed: ${existing.config.workDir} -> ${effectiveWorkDir}, recreating (skipping resume)...`)
        this.cleanupSession(conversationId, 'workDir changed')
        // Fall through to create new session (without resume)
      } else
      // CRITICAL: Check if process is still alive before reusing
      if (!isSessionTransportReady(existing.session)) {
        console.log(`[ClaudeManager][${conversationId}] Session transport not ready, recreating...`)
        this.cleanupSession(conversationId, 'process not ready')
        // Fall through to create new session
      } else if ((existing.session as any).closed) {
        // CRITICAL: Check SDK's closed flag — the session may have been closed by
        // abortController.abort() or SDK internal error without calling cleanupSession(),
        // leaving a stale entry in this.sessions with closed=true.
        console.log(`[ClaudeManager][${conversationId}] Session closed flag set, recreating...`)
        this.cleanupSession(conversationId, 'session closed')
        // Fall through to create new session (without resume — closed sessions can't resume)
      } else if (existing.interrupted) {
        // Session was interrupted — always rebuild.
        // Reuse after interrupt is unsafe: the SDK subprocess may still hold an
        // incomplete response from the previous turn. session.send() queues the
        // new message, but the SDK emits the stale tail of the old response first,
        // causing the client to receive wrong content.
        // resumeSessionId (from disk) restores conversation context in the new session.
        console.log(`[ClaudeManager][${conversationId}] Session interrupted, rebuilding (reuse is unsafe — stale response risk)`)
        this.cleanupSession(conversationId, 'session interrupted - rebuilding')
        // Fall through to create new session
      } else if (effectiveResumeId) {
        // OPTIMIZATION: Try to reuse existing session on resume instead of always
        // destroying and rebuilding. The SDK state corruption issue (streamInput iterator
        // conflict) doesn't always manifest — when reuse works, we save the full
        // process exit wait + MCP initialization + new session creation overhead.
        //
        // If reuse fails (SDK throws "process aborted" or similar), fall back to rebuild.
        console.log(`[ClaudeManager][${conversationId}] Resume requested, attempting session reuse...`)

        // Check if canUseTool needs injection — SDK V2 Session doesn't support
        // dynamically updating canUseTool after creation.
        if (canUseTool) {
          if (this.activeSessions.has(conversationId)) {
            console.log(`[ClaudeManager][${conversationId}] Resume: canUseTool provided but request in flight, deferring rebuild`)
            existing.lastUsedAt = Date.now()
            return existing.session
          }
          console.log(`[ClaudeManager][${conversationId}] Resume: canUseTool provided, rebuilding session to inject permission callback`)
          this.cleanupSession(conversationId, 'canUseTool injection needed (resume)')
          // Fall through to create new session (without resume — old session is destroyed)
        } else {
          existing.lastUsedAt = Date.now()

          // Update stored config to reflect current request parameters
          const storedConfig: SessionConfig = {
            ...this.getCurrentConfig(),
            workDir: effectiveWorkDir,
            ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
            ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
            ...(credentials?.model ? { model: credentials.model } : {}),
            permissionMode: 'default',
          }
          existing.config = storedConfig
          existing.configGeneration = this.configGeneration
          if (mcpToolSignature !== undefined) {
            existing.mcpToolSignature = mcpToolSignature
          }

          console.log(`[ClaudeManager][${conversationId}] Reusing existing V2 session for resume (will rebuild on failure)`)
          return existing.session
        }
      } else {
        // Build expected config from current request parameters (including per-request credentials).
        // In remote proxy mode, credentials are always per-request (never set on the manager),
        // so getCurrentConfig() returns undefined for model/apiKey/baseUrl. Comparing stored
        // config against getCurrentConfig() would always mismatch and trigger unnecessary rebuilds.
        // Instead, we compare stored config against what the current request would store.
        const requestConfig: SessionConfig = {
          ...this.getCurrentConfig(),
          workDir: effectiveWorkDir,
          ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
          ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
          ...(credentials?.model ? { model: credentials.model } : {}),
          permissionMode: 'default',
        }
        const needsRebuild = needsSessionRebuild(existing, requestConfig)
        const configChanged = existing.configGeneration !== this.configGeneration

        // Debug: Log config comparison
        if (needsRebuild || configChanged) {
          console.log(`[ClaudeManager][${conversationId}] Config check - needsRebuild: ${needsRebuild}, configChanged: ${configChanged}`)
          console.log(`[ClaudeManager][${conversationId}] Existing config:`, JSON.stringify(existing.config))
          console.log(`[ClaudeManager][${conversationId}] Request config:`, JSON.stringify(requestConfig))
          console.log(`[ClaudeManager][${conversationId}] Config generations - existing: ${existing.configGeneration}, current: ${this.configGeneration}`)
        }

        if (needsRebuild || configChanged) {
          // If request in flight, defer rebuild
          if (this.activeSessions.has(conversationId)) {
            console.log(`[ClaudeManager][${conversationId}] Config changed but request in flight, deferring rebuild`)
            existing.lastUsedAt = Date.now()
            return existing.session
          }

          console.log(`[ClaudeManager][${conversationId}] Config changed, rebuilding session`)
          this.cleanupSession(conversationId, 'config changed')
          // Fall through to create new session
        } else {
          // Session is healthy and config matches, but check if canUseTool needs injection.
          // SDK V2 Session doesn't support dynamically updating canUseTool after creation —
          // the callback is serialized and passed to the CLI subprocess at session start.
          // If canUseTool is provided now but wasn't when the session was created (or vice versa),
          // we MUST rebuild to ensure the permission callback is active.
          if (canUseTool) {
            if (this.activeSessions.has(conversationId)) {
              console.log(`[ClaudeManager][${conversationId}] canUseTool provided but request in flight, deferring rebuild`)
              existing.lastUsedAt = Date.now()
              return existing.session
            }
            console.log(`[ClaudeManager][${conversationId}] canUseTool provided, rebuilding session to inject permission callback`)
            this.cleanupSession(conversationId, 'canUseTool injection needed')
            // Fall through to create new session (with canUseTool)
          } else {
            existing.config = requestConfig
            existing.configGeneration = this.configGeneration
            console.log(`[DIAG][${conversationId}] REUSING existing session (no canUseTool)`)
            existing.lastUsedAt = Date.now()
            return existing.session
          }
        }
      }
    }

    // Create new session
    // [DIAG-1.3] Log new session creation
    console.log(`[DIAG][${conversationId}] Creating NEW session, permissionMode will be set by buildSdkOptions, canUseTool=${!!canUseTool}`)
    console.log(`[ClaudeManager][${conversationId}] Creating new V2 session with workDir=${effectiveWorkDir}...`)
    // Sync contextWindow to instance field so getCurrentConfig() and needsSessionRebuild
    // can detect changes when the user switches models with different context windows.
    if (contextWindow !== undefined && contextWindow !== this.contextWindow) {
      this.contextWindow = contextWindow
      this.configGeneration++
    }

    // options may already be built (resume path: parallelized with process exit wait)
    // or need to be built now (workDir changed, config changed, or no existing session)
    const sdkOptions = await this.buildSdkOptions(effectiveWorkDir, customSystemPrompt, contextWindow, credentials)

    // Add canUseTool for AskUserQuestion support (forwarded from streamChat)
    if (canUseTool) {
      sdkOptions.canUseTool = canUseTool
      // [DIAG-1.2] Log canUseTool set on sdkOptions
      console.log(`[DIAG][${conversationId}] canUseTool SET on sdkOptions (type=${typeof canUseTool})`)
    } else {
      // [DIAG-1.2] Log canUseTool is UNDEFINED — permission checks DISABLED
      console.log(`[DIAG][${conversationId}] canUseTool is UNDEFINED — permission checks DISABLED`)
    }

    // Add hyper-space MCP proxy server if provided
    if (hyperSpaceMcpServer) {
      // CRITICAL: createSdkMcpServer() returns objects with a live McpServer instance
      // that contains circular references. The SDK internally JSON.stringify's the
      // options during initialization. Add a toJSON method to skip the non-serializable
      // instance. (Same fix as local sdk-config.ts:462-477)
      const obj = hyperSpaceMcpServer as any
      if (obj.instance != null && typeof obj.toJSON !== 'function') {
        obj.toJSON = () => {
          const { instance, ...rest } = obj
          return rest
        }
      }
      sdkOptions.mcpServers = { 'hyper-space': hyperSpaceMcpServer }
      console.log(`[ClaudeManager][${conversationId}] Injecting hyper-space MCP proxy server`)
    }

    // Add AICO-Bot MCP proxy for built-in tools (aico-bot-apps, gh-search, ai-browser)
    // Prefer WebSocket MCP Bridge over HTTP MCP proxy
    if (aicoBotBuiltinMcpServer) {
      // WebSocket MCP Bridge (preferred): in-process MCP server that delegates via WebSocket
      const obj = aicoBotBuiltinMcpServer as any
      if (obj.instance != null && typeof obj.toJSON !== 'function') {
        obj.toJSON = () => {
          const { instance, ...rest } = obj
          return rest
        }
      }
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers || {}),
        'aico-bot-builtin': aicoBotBuiltinMcpServer,
      }
      console.log(`[ClaudeManager][${conversationId}] Injecting aico-bot-builtin MCP server (WebSocket bridge)`)
    }

    // Add background-tasks MCP server (stdio transport - spawned as child process)
    // Use the standalone background-tasks-mcp-server.js script which embeds its own TaskManager
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url))
      const serverScript = path.resolve(thisDir, 'background-tasks-mcp-server.js')
      if (fs.existsSync(serverScript)) {
        sdkOptions.mcpServers = {
          ...(sdkOptions.mcpServers || {}),
          'background-tasks': {
            type: 'stdio',
            command: process.execPath,
            args: [serverScript],
          },
        }
        console.log(`[ClaudeManager][${conversationId}] Injecting background-tasks MCP server (stdio): ${serverScript}`)
      } else {
        console.warn(`[ClaudeManager][${conversationId}] background-tasks-mcp-server.js not found at ${serverScript}, skipping`)
      }
    } catch (e) {
      console.error(`[ClaudeManager][${conversationId}] Failed to configure background-tasks MCP server:`, e)
    }

    if (this.aicoBotMcpUrl) {
      // Fallback: HTTP MCP proxy (legacy, for backward compatibility)
      const mcpConfig: any = {
        type: 'http',
        url: this.aicoBotMcpUrl,
      }
      if (this.aicoBotMcpToken) {
        mcpConfig.headers = { Authorization: `Bearer ${this.aicoBotMcpToken}` }
      }
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers || {}),
        'aico-bot-builtin': mcpConfig,
      }
      console.log(`[ClaudeManager][${conversationId}] Injecting AICO-Bot MCP proxy (HTTP fallback): ${this.aicoBotMcpUrl}`)
    }

    // CRITICAL: Requires SDK patch for resume and maxThinkingTokens support
    // Native SDK V2 Session doesn't support these parameters
    if (effectiveResumeId) {
      sdkOptions.resume = effectiveResumeId
      console.log(`[ClaudeManager][${conversationId}] Resuming session: ${effectiveResumeId}`)
    } else if (resumeSessionId) {
      console.log(`[ClaudeManager][${conversationId}] Skipping resume due to workDir change (old: ${existing?.config.workDir}, new: ${effectiveWorkDir})`)
    }
    if (maxThinkingTokens) {
      sdkOptions.maxThinkingTokens = maxThinkingTokens
      console.log(`[ClaudeManager][${conversationId}] Max thinking tokens: ${maxThinkingTokens}`)
    }

    const startTime = Date.now()

    console.log(`[ClaudeManager] Creating V2 session with options:`, {
      model: sdkOptions.model,
      cwd: sdkOptions.cwd,
      hasAuthToken: !!this.apiKey,
      baseUrl: this.baseUrl,
      permissionMode: sdkOptions.permissionMode,
      allowedTools: sdkOptions.allowedTools?.length,
      resume: !!effectiveResumeId,
      maxThinkingTokens: maxThinkingTokens
    })
    // [DIAG-1.4] Log full SDK options for permission debugging
    console.log(`[DIAG][${conversationId}] SDK options: permissionMode=${sdkOptions.permissionMode}, canUseTool=${typeof sdkOptions.canUseTool}, allowedTools=[${(sdkOptions.allowedTools || []).join(', ')}]`)

    const session = unstable_v2_createSession(sdkOptions as any) as unknown as SDKSession
    const pid = (session as any).pid
    console.log(`[ClaudeManager][${conversationId}] V2 session created in ${Date.now() - startTime}ms, PID: ${pid ?? 'unavailable'}`)

    // Register process exit listener for immediate cleanup
    // Staleness guard: skip if session was replaced by a newer one
    registerProcessExitListener(session, conversationId, (id) => {
      if (this.sessions.get(id)?.session !== session) {
        console.log(`[ClaudeManager][${id}] Process exited but session was replaced, skipping cleanup`)
        return
      }
      // Notify external listeners (e.g. server.ts) before cleanup
      const exitCallback = this.sessionExitCallbacks.get(id)
      if (exitCallback) {
        exitCallback('SDK process exited unexpectedly')
        this.sessionExitCallbacks.delete(id)
      }
      this.cleanupSession(id, 'process exited')
    })

    // Store session with metadata (use effectiveWorkDir in config)
    // Merge per-request credentials into stored config so needsSessionRebuild
    // can detect credential changes across requests.
    const storedConfig: SessionConfig = {
      ...this.getCurrentConfig(),
      workDir: effectiveWorkDir,
      ...(credentials?.apiKey ? { apiKey: credentials.apiKey } : {}),
      ...(credentials?.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      ...(credentials?.model ? { model: credentials.model } : {}),
      permissionMode: sdkOptions.permissionMode,
    }
    this.sessions.set(conversationId, {
      session,
      conversationId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      config: storedConfig,
      configGeneration: this.configGeneration,
      mcpToolSignature
    })

    return session
  }

  /**
   * Register an active session (for in-flight request tracking)
   */
  registerActiveSession(conversationId: string, abortController: AbortController): void {
    this.activeSessions.set(conversationId, {
      conversationId,
      abortController
    })
    // Update lastUsedAt to prevent idle timeout during active request
    const session = this.sessions.get(conversationId)
    if (session) {
      session.lastUsedAt = Date.now()
    }
  }

  /**
   * Unregister an active session
   */
  unregisterActiveSession(conversationId: string): void {
    this.activeSessions.delete(conversationId)
  }

  /**
   * Check if a session has an active stream (i.e., SDK is currently processing)
   */
  isActive(conversationId: string): boolean {
    return this.activeSessions.has(conversationId)
  }

  /**
   * Queue a message for a session that has an active stream.
   * Simply stores the message — does NOT interrupt or inject via SDK patch.
   * The caller (server.ts) will process pending messages after the stream completes naturally.
   */
  queueMessage(conversationId: string, content: string, options?: any): boolean {
    if (!this.activeSessions.has(conversationId)) return false

    const pending = this.pendingMessages.get(conversationId) || []
    pending.push({ content, options })
    this.pendingMessages.set(conversationId, pending)
    console.log(`[ClaudeManager][${conversationId}] Message queued (${pending.length} pending)`)
    return true
  }

  /**
   * Check if a session has pending messages in the queue
   */
  hasPendingMessages(conversationId: string): boolean {
    const pending = this.pendingMessages.get(conversationId)
    return !!pending && pending.length > 0
  }

  /**
   * Consume all pending messages for a session (get and clear)
   */
  consumePendingMessages(conversationId: string): Array<{content: string, options?: any}> {
    const pending = this.pendingMessages.get(conversationId)
    if (!pending) return []
    this.pendingMessages.delete(conversationId)
    return pending
  }

  /**
   * Clear pending messages for a session (e.g., on error or disconnect)
   */
  clearPendingMessages(conversationId: string): void {
    this.pendingMessages.delete(conversationId)
  }

  /**
   * Stream chat messages using V2 session
   *
   * IMPORTANT: Only sends the LAST user message to the V2 session.
   * The V2 session maintains its own conversation history internally via SDK patch resume.
   *
   * @param sessionId - Session/conversation ID
   * @param messages - Chat messages (only last message is sent)
   * @param options - Chat options including workDir for per-session directory
   * @param resumeSessionId - Optional SDK session ID to resume from (for conversation history)
   * @param onToolCall - Callback for tool call events
   * @param onTerminalOutput - Callback for terminal output events
   * @param onThought - Callback for thought events (thinking, tool_use start)
   * @param onThoughtDelta - Callback for thought delta events (streaming updates)
   * @param onMcpStatus - Callback for MCP server status events
   * @param onCompact - Callback for compact boundary events (context compression)
   */
  async *streamChat(
    sessionId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
    resumeSessionId?: string,
    onToolCall?: (tool: ToolCall) => void,
    onTerminalOutput?: (output: TerminalOutput) => void,
    onThought?: (thought: ThoughtEvent) => void,
    onThoughtDelta?: (delta: ThoughtDeltaEvent) => void,
    onMcpStatus?: (data: McpStatusEvent) => void,
    onCompact?: (data: CompactBoundaryEvent) => void,
    hyperSpaceToolExecutor?: (toolId: string, toolName: string, toolInput: Record<string, unknown>) => Promise<string>,
    aicoBotMcpToolExecutor?: (callId: string, toolName: string, args: Record<string, unknown>) => Promise<any>,
    aicoBotMcpToolDefs?: AicoBotMcpToolDef[],
    onAskUserQuestion?: (id: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>) => Promise<Record<string, string>>,
    onPermissionRequest?: (id: string, toolName: string, toolInput: Record<string, unknown>) => Promise<boolean>
  ): AsyncGenerator<{ type: string; data?: any }> {
    // Use async session creation with workDir from options
    console.log(`[ClaudeManager] streamChat called with options.workDir=${options.workDir || 'undefined'}, this.workDir=${this.workDir || 'undefined'}`)
    console.log(`[ClaudeManager] streamChat called with resumeSessionId=${resumeSessionId || 'undefined'}, maxThinkingTokens=${options.maxThinkingTokens || 'undefined'}`)

    // When running as a Worker task, suppress worker:started/completed events for
    // SDK internal sub-agents to avoid creating extra Worker tabs on the frontend.
    const suppressWorkerEvents = !!options.isWorkerTask

    // Update AICO-Bot MCP proxy URL from chat options (per-request, may change across turns)
    if (options.aicoBotMcpUrl) {
      this.aicoBotMcpUrl = options.aicoBotMcpUrl
      this.aicoBotMcpToken = options.aicoBotMcpToken
    }

    // Create hyper-space MCP server if configured
    let hyperSpaceMcpServer: any = undefined
    if (options.hyperSpaceTools && hyperSpaceToolExecutor) {
      console.log(`[ClaudeManager] Creating hyper-space MCP server (bridge mode) for worker ${options.hyperSpaceTools.workerName}`)
      hyperSpaceMcpServer = this.createHyperSpaceMcpServerLegacy(options.hyperSpaceTools, hyperSpaceToolExecutor)
    }

    // Create aico-bot-builtin MCP server if tools are available from the AICO-Bot client
    // This is the WebSocket MCP Bridge — tools delegate to the AICO-Bot client via WebSocket
    let aicoBotBuiltinMcpServer: any = undefined
    if (aicoBotMcpToolDefs && aicoBotMcpToolDefs.length > 0 && aicoBotMcpToolExecutor) {
      console.log(`[ClaudeManager] Creating aico-bot-builtin MCP server (WebSocket bridge) with ${aicoBotMcpToolDefs.length} tools from AICO-Bot client`)
      aicoBotBuiltinMcpServer = this.createAicoBotBuiltinMcpServer(aicoBotMcpToolDefs, aicoBotMcpToolExecutor)
    }

    // Detect MCP tool set changes — if the AICO-Bot's tool definitions changed
    // (e.g., ai-browser toggled on/off, tools updated), the existing SDK session's
    // MCP servers are stale and must be rebuilt. This cannot be hot-swapped.
    const newMcpToolSignature = computeMcpToolSignature(aicoBotMcpToolDefs)
    const existingSessionInfo = this.sessions.get(sessionId)
    if (existingSessionInfo && existingSessionInfo.mcpToolSignature !== newMcpToolSignature) {
      const wasRebuild = existingSessionInfo.mcpToolSignature !== undefined || newMcpToolSignature !== undefined
      if (wasRebuild) {
        console.log(`[ClaudeManager][${sessionId}] MCP tool set changed, rebuilding session`)
        console.log(`[ClaudeManager][${sessionId}] Old: ${existingSessionInfo.mcpToolSignature || '(none)'}`)
        console.log(`[ClaudeManager][${sessionId}] New: ${newMcpToolSignature || '(none)'}`)
        if (!this.activeSessions.has(sessionId)) {
          this.cleanupSession(sessionId, 'MCP tools changed')
        } else {
          console.log(`[ClaudeManager][${sessionId}] MCP tools changed but request in flight, deferring rebuild`)
        }
      }
    }

    // Pass client-sent credentials (apiKey/baseUrl/model) to session creation.
    // These override the server's instance-level config for per-request routing.
    const clientCredentials = (options.apiKey || options.baseUrl || options.model)
      ? { apiKey: options.apiKey, baseUrl: options.baseUrl, model: options.model }
      : undefined

    // Build canUseTool for AskUserQuestion + destructive Bash permission support
    const isFullPermission = options.permissionMode === 'full'

    // Sub-agent control: detect user intent and skill permissions
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user') as any
    const userRequestedSubAgent = lastUserMessage
      ? /子\s*agent|sub[\s-]?agent|子\s*代理|创建.*任务|spawn.*agent|create.*task|用.*agent|开.*子.*agent|parallel.*task/i.test(
          typeof lastUserMessage.content === 'string'
            ? lastUserMessage.content
            : Array.isArray(lastUserMessage.content)
              ? (lastUserMessage.content as any[]).map((c: any) => c.text || '').join('')
              : ''
        )
      : false
    const subAgentAllowedSkills = new Set((options as any).allowSubAgentSkills || [])
    let activeSkillAllowsSubAgents = false

    const canUseTool = (onAskUserQuestion || onPermissionRequest) ? async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
      // [DIAG-1.5] Log every canUseTool invocation
      console.log(`[DIAG] canUseTool INVOKED: toolName=${toolName}, input=${JSON.stringify(input).substring(0, 200)}`)

      // AskUserQuestion: forward to AICO-Bot client
      if (toolName === 'AskUserQuestion' && onAskUserQuestion) {
        const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const questions = input.questions as Array<{
          question: string; header: string
          options: Array<{ label: string; description: string }>; multiSelect: boolean
        }>
        console.log(`[ClaudeManager] AskUserQuestion: id=${id}, questions=${questions?.length || 0}`)
        const answerPromise = onAskUserQuestion(id, questions || [])
        if (opts.signal) {
          if (opts.signal.aborted) return { behavior: 'deny' as const, message: 'This operation was interrupted. Continue with a safe alternative approach.' }
          opts.signal.addEventListener('abort', () => answerPromise.catch(() => {}), { once: true })
        }
        try {
          const answers = await answerPromise
          console.log(`[ClaudeManager] AskUserQuestion answered: id=${id}`, answers)
          return { behavior: 'allow' as const, updatedInput: { ...input, answers } }
        } catch (error) {
          console.log(`[ClaudeManager] AskUserQuestion cancelled: id=${id}`, (error as Error).message)
          return { behavior: 'deny' as const, message: 'The user cancelled this question. Do not retry the same question. Continue with the best reasonable assumption or ask a different way.' }
        }
      }

      // Bash: smart destructive command detection
      if (toolName === 'Bash') {
        // Full permission mode: skip all destructive checks
        if (isFullPermission) {
          return { behavior: 'allow' as const, updatedInput: input }
        }
        if (onPermissionRequest) {
          const command = String(input.command || '')
          if (!isDestructiveBashCommand(command)) {
            return { behavior: 'allow' as const, updatedInput: input }
          }
          const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          console.log(`[ClaudeManager] Destructive Bash detected: ${command.substring(0, 100)}, requesting permission`)
          const approvalPromise = onPermissionRequest(id, toolName, input)
          if (opts.signal) {
            if (opts.signal.aborted) return { behavior: 'deny' as const, message: `The permission request for this ${toolName} command was interrupted: ${command.substring(0, 200)}. The operation was not performed. Suggest safer alternatives and ask the user how to proceed.` }
            opts.signal.addEventListener('abort', () => approvalPromise.catch(() => {}), { once: true })
          }
          try {
            const approved = await approvalPromise
            console.log(`[ClaudeManager] Permission ${id}: ${approved ? 'APPROVED' : 'DENIED'}`)
            return approved
              ? { behavior: 'allow' as const, updatedInput: input }
              : { behavior: 'deny' as const, message: `The user denied permission to execute this ${toolName} command: ${command.substring(0, 200)}. Explain that the operation was not performed because they declined it. Briefly explain why it may carry risk, then suggest safer alternative approaches. Ask the user which alternative they prefer.` }
          } catch (error) {
            console.log(`[ClaudeManager] Permission ${id}: cancelled`, (error as Error).message)
            return { behavior: 'deny' as const, message: `The permission request for this ${toolName} command was cancelled or timed out: ${command.substring(0, 200)}. The operation was not performed. Suggest safer alternative approaches and ask the user how they would like to proceed.` }
          }
        }
      }

      // Skill: track if the invoked skill allows sub-agents
      if (toolName === 'Skill') {
        const cmd = String(input.command || input.name || input.skill || '')
        const skillName = cmd.replace(/^\/+/, '').trim()
        if (skillName && subAgentAllowedSkills.has(skillName)) {
          activeSkillAllowsSubAgents = true
          console.log(`[ClaudeManager] Skill "${skillName}" allows sub-agents`)
        }
      }

      // Agent/Task: only allow if user explicitly requested or active skill requires it
      if (toolName === 'Agent' || toolName === 'Task') {
        if (userRequestedSubAgent) {
          console.log(`[ClaudeManager] ${toolName} auto-allowed: user explicitly requested sub-agent`)
          return { behavior: 'allow' as const, updatedInput: input }
        }
        if (activeSkillAllowsSubAgents) {
          console.log(`[ClaudeManager] ${toolName} auto-allowed: active skill requires sub-agents`)
          return { behavior: 'allow' as const, updatedInput: input }
        }
        console.log(`[ClaudeManager] ${toolName} denied: user did not request and no skill requires it`)
        return {
          behavior: 'deny' as const,
          message: 'Sub-agent creation is not allowed unless explicitly requested by the user or the current skill requires it. Please complete the task directly using available tools.',
        }
      }

      // All other tools: auto-allow
      return { behavior: 'allow' as const, updatedInput: input }
    } : undefined

    // [DIAG-1.1] Log canUseTool creation and type
    console.log(`[DIAG][${sessionId}] canUseTool callback: ${typeof canUseTool}, hasPermissionRequest=${!!onPermissionRequest}, hasAskUserQuestion=${!!onAskUserQuestion}`)

    let session = await this.getOrCreateSession(sessionId, options.workDir, resumeSessionId, options.maxThinkingTokens, hyperSpaceMcpServer, options.system, aicoBotBuiltinMcpServer, options.contextWindow, clientCredentials, canUseTool, newMcpToolSignature)

    // [PATCHED] Set thinking tokens dynamically on reused session
    // This is critical: when session is reused, the maxThinkingTokens from session creation
    // may not reflect the current request's needs. We must update it dynamically.
    // Aligned with local send-message.ts line 246-249
    try {
      if ((session as any).setMaxThinkingTokens) {
        // Always call setMaxThinkingTokens, pass null to disable (aligned with local)
        const thinkingTokens = options.maxThinkingTokens ?? null
        await (session as any).setMaxThinkingTokens(thinkingTokens)
        console.log(`[ClaudeManager][${sessionId}] Thinking mode: ${thinkingTokens ? `ON (${thinkingTokens} tokens)` : 'OFF'}`)
      } else {
        console.warn(`[ClaudeManager][${sessionId}] setMaxThinkingTokens not available - SDK patch may not be applied`)
      }
    } catch (e) {
      console.error(`[ClaudeManager][${sessionId}] Failed to set thinking tokens:`, e)
    }

    // Register as active session for in-flight tracking
    const abortController = new AbortController()
    this.registerActiveSession(sessionId, abortController)

    // Register this stream iterator for forceful interruption support
    this.activeStreamIterators.set(sessionId, { abortController })

    // Streaming block state - track active blocks by index for delta/stop correlation
    // Key: block index, Value: { type, thoughtId, content/partialJson }
    const streamingBlocks = new Map<number, {
      type: 'thinking' | 'tool_use'
      thoughtId: string
      content: string  // For thinking: accumulated thinking text, for tool_use: accumulated partial JSON
      toolName?: string
      toolId?: string
    }>()

    // Tool ID to Thought ID mapping - for merging tool_result into tool_use
    const toolIdToThoughtId = new Map<string, string>()
    // Tool ID to Tool Name mapping - for including tool name in tool:result events
    const toolIdToToolName = new Map<string, string>()

    // ========== SDK Subagent (Agent tool) tracking ==========
    // Mirrors the pattern in local stream-processor.ts
    const subagentStates = new Map<string, RemoteSubagentState>()
    const toolUseIdToTaskId = new Map<string, string>()
    const pendingSubagentEvents = new Map<string, Array<{ event: any; evt: any }>>()

    // Counter for generating unique thought IDs
    let counter = 0

    // Capture SDK session_id for session resumption
    let capturedSessionId: string | undefined

    // Track if any stream_event was received (for fallback handling of thinking/tool_use blocks)
    let hasStreamEvent = false

    // OPTIMIZATION: Delta buffer for batch sending
    // Instead of sending every character, buffer and flush periodically
    const DELTA_FLUSH_INTERVAL_MS = 50  // Flush every 50ms
    const DELTA_FLUSH_MIN_CHARS = 10    // Or when 10+ chars accumulated
    const deltaBuffers = new Map<string, { content: string; lastFlush: number }>()
    let deltaFlushTimer: ReturnType<typeof setInterval> | null = null

    // Flush all pending delta buffers
    const flushAllDeltaBuffers = () => {
      const now = Date.now()
      for (const [thoughtId, buffer] of deltaBuffers) {
        if (buffer.content) {
          const blockState = [...streamingBlocks.values()].find(b => b.thoughtId === thoughtId)
          if (blockState) {
            onThoughtDelta?.({
              thoughtId,
              delta: buffer.content,
              content: blockState.content
            })
          }
          buffer.content = ''
          buffer.lastFlush = now
        }
      }
    }

    // Start the flush timer
    deltaFlushTimer = setInterval(flushAllDeltaBuffers, DELTA_FLUSH_INTERVAL_MS)

    // Helper to add delta to buffer (with immediate flush for large deltas)
    const bufferDelta = (thoughtId: string, delta: string, blockState: { content: string }) => {
      if (!deltaBuffers.has(thoughtId)) {
        deltaBuffers.set(thoughtId, { content: '', lastFlush: Date.now() })
      }
      const buffer = deltaBuffers.get(thoughtId)!
      buffer.content += delta

      // Flush immediately if buffer is large enough
      if (buffer.content.length >= DELTA_FLUSH_MIN_CHARS) {
        onThoughtDelta?.({
          thoughtId,
          delta: buffer.content,
          content: blockState.content
        })
        buffer.content = ''
        buffer.lastFlush = Date.now()
      }
    }

    // Track whether the stream ended abnormally (interrupt/abort)
    let wasAborted = false
    // For first-event safety timeout (declared outside try so finally can access)
    let firstEventTimer: ReturnType<typeof setTimeout> | undefined
    const sessionInfo = this.sessions.get(sessionId)
    let eventCount = 0
    let textCount = 0

    try {
      // CRITICAL: Only send the LAST user message!
      const lastMessage = messages[messages.length - 1]
      if (!lastMessage || lastMessage.role !== 'user') {
        throw new Error('Last message must be from user')
      }

      console.log(`[ClaudeManager] Sending last user message: ${lastMessage.content.substring(0, 50)}...`)

      // DEFENSIVE: Handle race condition where close:session arrives concurrently
      // (from stopGeneration) and closes the SDK session between getOrCreateSession
      // returning and session.send() being called. Detect and rebuild.
      if ((session as any).closed) {
        console.warn(`[ClaudeManager][${sessionId}] Session closed before send (race condition), rebuilding...`)
        this.cleanupSession(sessionId, 'session closed before send (race)')
        // Recreate session — skip resume since the old session is gone
        const freshSession = await this.getOrCreateSession(
          sessionId, options.workDir, undefined,
          options.maxThinkingTokens, hyperSpaceMcpServer, options.system,
          aicoBotBuiltinMcpServer, options.contextWindow, clientCredentials,
          undefined, newMcpToolSignature
        )
        // Replace the closed session reference with the fresh one
        session = freshSession
        // Re-apply thinking tokens to the new session
        try {
          if ((session as any).setMaxThinkingTokens) {
            const thinkingTokens = options.maxThinkingTokens ?? null
            await (session as any).setMaxThinkingTokens(thinkingTokens)
          }
        } catch (e) { /* ignore */ }
      }

      await session.send(lastMessage.content)

      console.log(`[ClaudeManager] Starting stream for session ${sessionId}...`)

      // First-event safety timeout: if no event arrives within N seconds,
      // the session is likely corrupted (mid-tool-call hang). Abort and let caller rebuild.
      const isFirstEventTimeout = sessionInfo?.interrupted ? ClaudeManager.FIRST_EVENT_TIMEOUT_MS : 0
      if (isFirstEventTimeout > 0) {
        firstEventTimer = setTimeout(() => {
          console.warn(`[ClaudeManager][${sessionId}] No event in ${isFirstEventTimeout / 1000}s — session likely corrupted, aborting`)
          abortController.abort()
        }, isFirstEventTimeout)
      }

      // Wrap session.stream() with interrupt-aware iterator
      // This allows forceful exit when SDK stream is blocked
      for await (const event of this.wrapStreamWithInterrupt(session.stream(), sessionId, abortController)) {
        // CRITICAL: Check for interrupt at the start of each iteration
        // This allows the stream to exit early when user clicks stop button
        if (this.checkAndClearInterrupt(sessionId)) {
          console.log(`[ClaudeManager][${sessionId}] Interrupt detected, exiting stream loop`)
          break
        }

        eventCount++

        // Clear first-event safety timer once we receive any event
        if (eventCount === 1 && firstEventTimer) {
          clearTimeout(firstEventTimer)
          firstEventTimer = undefined
        }

        const evt = event as any

        // Log ALL events for debugging (first 50 events)
        if (eventCount <= 50) {
          console.log(`[ClaudeManager] Event ${eventCount}: type=${evt.type}`, JSON.stringify(evt).substring(0, 500))
        }

        // ========== Handle stream_event for token-level streaming ==========
        if (evt.type === 'stream_event') {
          const streamEvent = evt.event
          if (!streamEvent) continue

          // Mark that we received stream_event (for fallback handling below)
          hasStreamEvent = true

          // ========== Route subagent stream events ==========
          const parentToolUseId = evt.parent_tool_use_id as string | null
          if (parentToolUseId) {
            // Look up subagent state
            let subState: RemoteSubagentState | undefined
            const mappedTaskId = toolUseIdToTaskId.get(parentToolUseId)
            if (mappedTaskId) {
              subState = subagentStates.get(mappedTaskId)
            } else {
              subagentStates.forEach((s) => { if (s.toolUseId === parentToolUseId) subState = s })
            }

            if (subState && !subState.isComplete) {
              // Process the stream event for this subagent
              this.processSubagentStreamEventRemote(subState, streamEvent, onThought, onThoughtDelta)
            } else {
              // Buffer events that arrive before task_started
              let buffer = pendingSubagentEvents.get(parentToolUseId)
              if (!buffer) {
                buffer = []
                pendingSubagentEvents.set(parentToolUseId, buffer)
              }
              buffer.push({ event: streamEvent, evt })
            }
            continue
          }

          // ========== Text block start signal ==========
          // Send signal when text block starts (aligned with local stream-processor.ts)
          if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'text') {
            yield { type: 'text_block_start', data: {} }
          }

          // ========== Thinking block streaming ==========
          // Thinking block started - send empty thought immediately
          if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'thinking') {
            const blockIndex = streamEvent.index ?? 0
            const thoughtId = `thought-thinking-${sessionId}-${blockIndex}-${counter++}`

            // Track this block for delta correlation
            streamingBlocks.set(blockIndex, {
              type: 'thinking',
              thoughtId,
              content: ''
            })

            // Create and send streaming thought immediately
            const thought: ThoughtEvent = {
              id: thoughtId,
              type: 'thinking',
              content: '',
              timestamp: new Date().toISOString(),
              isStreaming: true
            }

            onThought?.(thought)
            console.log(`[ClaudeManager] Thinking block started: ${thoughtId}`)
            continue
          }

          // Thinking delta - append to thought content
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'thinking_delta') {
            const blockIndex = streamEvent.index ?? 0
            const blockState = streamingBlocks.get(blockIndex)

            if (blockState && blockState.type === 'thinking') {
              const delta = streamEvent.delta.thinking || ''
              blockState.content += delta

              // OPTIMIZATION: Buffer delta for batch sending instead of immediate send
              bufferDelta(blockState.thoughtId, delta, blockState)
            }
            continue
          }

          // ========== Tool use block streaming ==========
          // Tool use block started - send thought with tool name immediately
          if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
            const blockIndex = streamEvent.index ?? 0
            const toolId = streamEvent.content_block.id || `tool-${Date.now()}`
            const toolName = streamEvent.content_block.name || 'Unknown'
            const thoughtId = `thought-tool-${Date.now()}-${blockIndex}`

            // Track this block for delta correlation
            streamingBlocks.set(blockIndex, {
              type: 'tool_use',
              thoughtId,
              content: '',  // Will accumulate partial JSON
              toolName,
              toolId
            })

            // Create and send streaming tool thought immediately
            const thought: ThoughtEvent = {
              id: thoughtId,
              type: 'tool_use',
              content: '',
              timestamp: new Date().toISOString(),
              toolName,
              toolInput: {},  // Empty initially, will be populated on stop
              isStreaming: true,
              isReady: false  // Params not complete yet
            }

            onThought?.(thought)
            console.log(`[ClaudeManager] Tool use block started: ${toolName} (${thoughtId})`)
            continue
          }

          // Tool use input JSON delta - accumulate partial JSON
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'input_json_delta') {
            const blockIndex = streamEvent.index ?? 0
            const blockState = streamingBlocks.get(blockIndex)

            if (blockState && blockState.type === 'tool_use') {
              const partialJson = streamEvent.delta.partial_json || ''
              blockState.content += partialJson

              // Send delta to renderer (for progress indication)
              onThoughtDelta?.({
                thoughtId: blockState.thoughtId,
                delta: partialJson,
                isToolInput: true  // Flag: this is tool input JSON
              })
            }
            continue
          }

          // ========== Block stop handling ==========
          // content_block_stop - finalize streaming blocks
          if (streamEvent.type === 'content_block_stop') {
            const blockIndex = streamEvent.index ?? 0
            const blockState = streamingBlocks.get(blockIndex)

            if (blockState) {
              if (blockState.type === 'thinking') {
                // OPTIMIZATION: Flush any remaining buffered delta before sending complete
                const buffer = deltaBuffers.get(blockState.thoughtId)
                if (buffer && buffer.content) {
                  onThoughtDelta?.({
                    thoughtId: blockState.thoughtId,
                    delta: buffer.content,
                    content: blockState.content
                  })
                  buffer.content = ''
                }
                // Clean up delta buffer for this thought
                deltaBuffers.delete(blockState.thoughtId)

                // Thinking block complete - send final state
                onThoughtDelta?.({
                  thoughtId: blockState.thoughtId,
                  content: blockState.content,
                  isComplete: true  // Signal: thinking is complete
                })

                console.log(`[ClaudeManager] Thinking block complete, length: ${blockState.content.length}`)
              } else if (blockState.type === 'tool_use') {
                // Tool use block complete - parse JSON and send final state
                let toolInput: Record<string, unknown> = {}
                try {
                  if (blockState.content) {
                    toolInput = JSON.parse(blockState.content)
                  }
                } catch (e) {
                  console.error(`[ClaudeManager] Failed to parse tool input JSON:`, e)
                }

                // Record mapping for merging tool_result later
                if (blockState.toolId) {
                  toolIdToThoughtId.set(blockState.toolId, blockState.thoughtId)
                  // Also store tool name for tool:result event
                  if (blockState.toolName) {
                    toolIdToToolName.set(blockState.toolId, blockState.toolName)
                  }
                }

                // Send complete signal with parsed input
                onThoughtDelta?.({
                  thoughtId: blockState.thoughtId,
                  toolInput,
                  isComplete: true,  // Signal: tool params are complete
                  isReady: true,     // Tool is ready for execution
                  isToolInput: true  // Flag: this is tool input completion
                })

                // Send tool-call event for tool approval/tracking
                onToolCall?.({
                  id: blockState.toolId || blockState.thoughtId,
                  name: blockState.toolName || '',
                  status: 'running',  // Aligned with local space
                  input: toolInput
                })

                console.log(`[ClaudeManager] Tool use block complete [${blockState.toolName}], input: ${JSON.stringify(toolInput).substring(0, 100)}`)
              }

              // Clean up tracking state
              streamingBlocks.delete(blockIndex)
            }
            continue
          }

          // ========== Text delta handling ==========
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
            const text = streamEvent.delta.text || ''
            if (text) {
              textCount++
              if (textCount <= 5) {
                console.log(`[ClaudeManager] Text delta: ${text.substring(0, 50)}...`)
              }
              yield { type: 'text', data: { text } }
            }
            continue
          }

          // Skip other stream_event types - they don't need yield

          // ========== Extract token usage from stream events ==========
          if (streamEvent.type === 'message_start' && streamEvent.message?.usage) {
            const usage = streamEvent.message.usage
            if (usage.input_tokens > 0) {
              const effectiveContextWindow = options.contextWindow ?? this.contextWindow ?? 200000
              yield {
                type: 'context-usage',
                data: {
                  inputTokens: usage.input_tokens || 0,
                  outputTokens: usage.output_tokens || 0,
                  cacheReadTokens: usage.cache_read_input_tokens || 0,
                  cacheCreationTokens: usage.cache_creation_input_tokens || 0,
                  contextWindow: effectiveContextWindow,
                }
              }
            }
          }
          if (streamEvent.type === 'message_delta' && streamEvent.usage) {
            const usage = streamEvent.usage
            if (usage.input_tokens > 0) {
              const effectiveContextWindow = options.contextWindow ?? this.contextWindow ?? 200000
              yield {
                type: 'context-usage',
                data: {
                  inputTokens: usage.input_tokens || 0,
                  outputTokens: usage.output_tokens || 0,
                  cacheReadTokens: usage.cache_read_input_tokens || 0,
                  cacheCreationTokens: usage.cache_creation_input_tokens || 0,
                  contextWindow: effectiveContextWindow,
                }
              }
            }
          }

          continue
        }

        // ========== Handle non-stream events (assistant, result, etc.) ==========

        // ========== Route subagent non-stream events ==========
        const msgParentToolUseId = evt.parent_tool_use_id as string | null
        if (msgParentToolUseId) {
          let subState: RemoteSubagentState | undefined
          const mappedTaskId = toolUseIdToTaskId.get(msgParentToolUseId)
          if (mappedTaskId) {
            subState = subagentStates.get(mappedTaskId)
          } else {
            subagentStates.forEach((s) => { if (s.toolUseId === msgParentToolUseId) subState = s })
          }

          if (subState && !subState.isComplete) {
            // Handle user messages containing tool_result for subagent
            if (evt.type === 'user') {
              const content = evt.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_result') {
                    const thoughtId = subState.toolIdToThoughtId.get(block.tool_use_id)
                    if (thoughtId) {
                      const resultContent = typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content)
                      onThoughtDelta?.({
                        thoughtId,
                        toolResult: { output: resultContent, isError: block.is_error || false, timestamp: new Date().toISOString() },
                        isToolResult: true,
                        agentId: subState.agentId,
                        agentName: subState.agentName
                      })
                    }
                  }
                }
              }
            }
            // Handle assistant messages (fallback for non-streaming)
            if (evt.type === 'assistant' && !evt.error) {
              const content = evt.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'thinking' && block.thinking) {
                    onThought?.({
                      id: `thought-sub-fallback-${sessionId}-${counter++}`, type: 'thinking',
                      content: block.thinking, timestamp: new Date().toISOString(),
                      agentId: subState.agentId, agentName: subState.agentName
                    })
                  } else if (block.type === 'tool_use' && block.id) {
                    const thoughtId = `thought-sub-fallback-tool-${sessionId}-${counter++}`
                    subState.toolIdToThoughtId.set(block.id, thoughtId)
                    onThought?.({
                      id: thoughtId, type: 'tool_use', content: '',
                      timestamp: new Date().toISOString(),
                      toolName: block.name || 'Unknown', toolInput: block.input || {},
                      isStreaming: false, isReady: true,
                      agentId: subState.agentId, agentName: subState.agentName
                    })
                  } else if (block.type === 'text' && block.text) {
                    onThought?.({
                      id: `thought-sub-fallback-text-${sessionId}-${counter++}`, type: 'text',
                      content: block.text, timestamp: new Date().toISOString(),
                      agentId: subState.agentId, agentName: subState.agentName
                    })
                  }
                }
              }
            }
          }
          continue
        }

        // System events - MCP status, session_id, and compact boundary
        if (evt.type === 'system') {
          const subtype = evt.subtype as string | undefined

          // ========== API retry events (auth recovery) ==========
          // When the SDK encounters a 401 authentication_failed, it emits api_retry system events.
          // Yield auth_retry_required so the caller can rebuild the session and retry.
          if (subtype === 'api_retry') {
            const errorStatus = evt.error_status as number | undefined
            const error = evt.error as string | undefined
            if (errorStatus === 401 && error === 'authentication_failed') {
              console.warn(
                `[ClaudeManager][${sessionId}] SDK auth retry: attempt=${evt.attempt}/${evt.max_retries}, ` +
                `error_status=${errorStatus}, error=${error}`
              )
              yield { type: 'auth_retry_required', data: {
                attempt: evt.attempt,
                maxRetries: evt.max_retries,
                errorStatus,
                error
              }}
            }
            continue
          }

          // ========== Subagent lifecycle events ==========
          if (subtype === 'task_started') {
            const taskId = evt.task_id as string
            const toolUseId = evt.tool_use_id as string | undefined
            const description = (evt.description as string) || 'Subagent task'
            const agentId = `subagent-${taskId}`
            const agentName = `Agent: ${description.length > 40 ? description.substring(0, 40) + '...' : description}`

            const state: RemoteSubagentState = {
              taskId, toolUseId, agentId, agentName, description,
              status: 'running', isComplete: false,
              streamingBlocks: new Map(), toolIdToThoughtId: new Map()
            }
            subagentStates.set(taskId, state)
            if (toolUseId) toolUseIdToTaskId.set(toolUseId, taskId)

            // Yield worker:started event for the frontend (suppress when running as Worker)
            if (!suppressWorkerEvents) {
              yield { type: 'worker:started', data: { agentId, agentName, taskId, task: description, type: 'remote' } }
            }

            // Flush any buffered events that arrived before task_started
            const buffered = pendingSubagentEvents.get(toolUseId || taskId)
            if (buffered) {
              pendingSubagentEvents.delete(toolUseId || taskId)
              for (const { event: bufferedEvent } of buffered) {
                if (!state.isComplete) {
                  this.processSubagentStreamEventRemote(state, bufferedEvent, onThought, onThoughtDelta)
                }
              }
            }

            console.log(`[ClaudeManager] Subagent started: ${taskId} - ${description.substring(0, 80)}`)
            continue
          }

          if (subtype === 'task_notification') {
            const notifTaskId = evt.task_id as string
            const subagentState = subagentStates.get(notifTaskId)
            if (subagentState) {
              subagentState.status = evt.status === 'completed' ? 'completed' : 'failed'
              subagentState.isComplete = true
              if (!suppressWorkerEvents) {
                yield { type: 'worker:completed', data: {
                  agentId: subagentState.agentId, agentName: subagentState.agentName,
                  taskId: notifTaskId, result: evt.summary || '',
                  error: evt.status === 'failed' ? 'Subagent task failed' : undefined,
                  status: evt.status === 'completed' ? 'completed' : 'failed'
                }}
              }
              console.log(`[ClaudeManager] Subagent completed: ${notifTaskId} status=${evt.status}`)
            }
            continue
          }

          if (subtype === 'task_progress') {
            const progressTaskId = evt.task_id as string
            const progressState = subagentStates.get(progressTaskId)
            if (progressState && !progressState.isComplete) {
              const summary = (evt.summary as string) || 'Working...'
              onThought?.({
                id: `thought-sub-progress-${progressTaskId}-${counter++}`, type: 'system',
                content: summary, timestamp: new Date().toISOString(),
                agentId: progressState.agentId, agentName: progressState.agentName
              })
            }
            continue
          }

          // Create system thought for connection status (aligned with local message-utils.ts)
          // Shows "Connected | Model: xxx" in the thinking process
          const modelName = options.model || this.model || 'claude'
          const systemThought: ThoughtEvent = {
            id: `thought-system-${sessionId}-${counter++}`,
            type: 'system',
            content: `Connected | Model: ${modelName}`,
            timestamp: new Date().toISOString()
          }
          onThought?.(systemThought)
          console.log(`[ClaudeManager] System thought: ${systemThought.content}`)

          // Capture session_id for session resumption
          const sessionIdFromMsg = (evt as any).session_id || (evt as any).message?.session_id
          if (sessionIdFromMsg && !capturedSessionId) {
            capturedSessionId = sessionIdFromMsg as string
            console.log(`[ClaudeManager] Captured SDK session_id: ${capturedSessionId}`)
            // Yield session_id to caller for persistence
            yield { type: 'session_id', data: { sessionId: capturedSessionId } }
          }

          // Handle compact_boundary - context compression notification
          if (subtype === 'compact_boundary') {
            const compactMetadata = evt.compact_metadata as { trigger: 'manual' | 'auto'; pre_tokens: number } | undefined
            if (compactMetadata) {
              onCompact?.({
                trigger: compactMetadata.trigger,
                preTokens: compactMetadata.pre_tokens
              })
              console.log(`[ClaudeManager] Compact boundary: trigger=${compactMetadata.trigger}, pre_tokens=${compactMetadata.pre_tokens}`)
            }
          }

          // Extract MCP server status from system init message
          const mcpServers = evt.mcp_servers as Array<{ name: string; status: string }> | undefined
          if (mcpServers && mcpServers.length > 0) {
            onMcpStatus?.({ servers: mcpServers })
            console.log(`[ClaudeManager] MCP servers: ${JSON.stringify(mcpServers)}`)
          }

          continue
        }

        // Terminal output events
        if (evt.type === 'terminal_output') {
          onTerminalOutput?.({
            content: evt.content,
            type: evt.stream_type || 'stdout'
          })
          yield { type: 'terminal', data: evt }
          continue
        }

        // Assistant events - logging only (thinking/tool_use handled by stream_event)
        // Fallback: if no stream_event was received, process thinking/tool_use blocks here
        if (evt.type === 'assistant') {
          const message = evt.message
          console.log(`[ClaudeManager] Assistant event - message.content types:`, message?.content?.map((b: any) => b.type))

          // Process text blocks ALWAYS (not just fallback) - for "AI" label in thinking process
          // Text blocks show the AI's intermediate text responses in the timeline
          if (message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              // Text blocks - send to timeline for AI intermediate responses display
              // This enables the "AI" label in the thinking process
              if (block.type === 'text' && block.text) {
                const thought: ThoughtEvent = {
                  id: `thought-text-${sessionId}-${counter++}`,
                  type: 'text',
                  content: block.text,
                  timestamp: new Date().toISOString(),
                  isStreaming: false
                }
                onThought?.(thought)
                console.log(`[ClaudeManager] Text block from assistant message: ${(thought.content || '').substring(0, 100)}...`)
              }
            }
          }

          // Fallback: process thinking/tool_use blocks if no stream_event was received
          // This happens when SDK doesn't send stream_event (e.g., session resume mode)
          if (!hasStreamEvent && message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'thinking' && block.thinking) {
                const thought: ThoughtEvent = {
                  id: `thought-thinking-${sessionId}-${counter++}`,
                  type: 'thinking',
                  content: block.thinking,
                  timestamp: new Date().toISOString(),
                  isStreaming: false
                }
                onThought?.(thought)
                console.log(`[ClaudeManager] [FALLBACK] Thinking block from assistant message: ${(thought.content || '').substring(0, 100)}...`)
              } else if (block.type === 'tool_use' && block.id && block.name) {
                const thoughtId = `thought-tool-${Date.now()}-${counter++}`
                const toolId = block.id
                toolIdToThoughtId.set(toolId, thoughtId)

                const thought: ThoughtEvent = {
                  id: thoughtId,
                  type: 'tool_use',
                  content: '',
                  timestamp: new Date().toISOString(),
                  toolName: block.name,
                  toolInput: block.input || {},
                  isStreaming: false,
                  isReady: true
                }
                onThought?.(thought)
                console.log(`[ClaudeManager] [FALLBACK] Tool use block from assistant message: ${block.name}`)
              }
            }
          }
          // Note: tool_result blocks are NOT in assistant messages - they come in user messages
          continue
        }

        // User events - handle tool_result merging (SDK returns tool_result in user messages)
        if (evt.type === 'user') {
          const message = evt.message
          console.log(`[ClaudeManager] User event - checking for tool_result`)
          if (message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              // Handle tool_result blocks - merge into corresponding tool_use
              if (block.type === 'tool_result') {
                const toolUseId = block.tool_use_id
                const toolUseThoughtId = toolIdToThoughtId.get(toolUseId)

                console.log(`[ClaudeManager] Tool result found: tool_use_id=${toolUseId}, thoughtId=${toolUseThoughtId || 'not found'}`)

                if (toolUseThoughtId) {
                  // Found corresponding tool_use - merge result into it
                  const resultContent = typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content)
                  const toolResult = {
                    output: resultContent || '',
                    isError: block.is_error || false,
                    timestamp: new Date().toISOString()
                  }

                  // Send thought-delta to merge result into tool_use on frontend
                  onThoughtDelta?.({
                    thoughtId: toolUseThoughtId,
                    toolResult,
                    isToolResult: true  // Flag: this is a tool result merge
                  })

                  // Also send tool result event
                  // CRITICAL: Include tool name so local client can identify Bash commands
                  const toolName = toolIdToToolName.get(toolUseId) || ''
                  onToolCall?.({
                    id: toolUseId,
                    name: toolName,  // Include tool name for Bash command identification
                    input: {},
                    status: 'result',
                    output: resultContent
                  })

                  console.log(`[ClaudeManager] Tool result merged into thought ${toolUseThoughtId}`)
                } else {
                  // No mapping found - this can happen if tool_use wasn't streamed
                  console.log(`[ClaudeManager] Tool result no mapping: ${toolUseId}`)
                }
              }
            }
          }
          continue
        }

        // Result events
        if (evt.type === 'result') {
          console.log(`[ClaudeManager] Result event: is_error=${evt.is_error}, result=${evt.result?.substring(0, 100)}`)

          // Capture session_id from result event if not already captured
          if (!capturedSessionId) {
            const sessionIdFromMsg = (evt as any).session_id
            if (sessionIdFromMsg) {
              capturedSessionId = sessionIdFromMsg as string
              console.log(`[ClaudeManager] Captured SDK session_id from result: ${capturedSessionId}`)
              yield { type: 'session_id', data: { sessionId: capturedSessionId } }
            }
          }

          // Extract and yield token usage from result event
          // SDK result event contains usage info: { usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } }
          const usage = (evt as any).usage
          if (usage) {
            console.log(`[ClaudeManager] Token usage: input=${usage.input_tokens}, output=${usage.output_tokens}, cache_read=${usage.cache_read_input_tokens}, cache_create=${usage.cache_creation_input_tokens}`)
            // Use configured contextWindow (from ChatOptions or instance field) as authoritative value,
            // falling back to SDK's context_window or 200K
            const effectiveContextWindow = options.contextWindow ?? this.contextWindow ?? usage.context_window ?? 200000
            yield {
              type: 'usage',
              data: {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                cacheReadTokens: usage.cache_read_input_tokens || 0,
                cacheCreationTokens: usage.cache_creation_input_tokens || 0,
                totalCostUsd: usage.total_cost_usd || 0,
                contextWindow: effectiveContextWindow
              }
            }
          }

          if (evt.result && textCount === 0) {
            yield { type: 'text', data: { text: evt.result } }
          }
          break
        }

        if (evt.type === 'error') {
          const errorMsg = evt.error?.message || 'Unknown error'
          throw new Error(`Claude V2 Session error: ${errorMsg}`)
        }

        if (evt.type === 'message_stop') {
          break
        }
      }
      // First event arrived — cancel safety timeout
      if (firstEventTimer) {
        clearTimeout(firstEventTimer)
        firstEventTimer = undefined
      }
    } catch (error) {
      // Clean up first-event timer on any error
      if (firstEventTimer) {
        clearTimeout(firstEventTimer)
        firstEventTimer = undefined
      }

      // Check if this is an expected abort/interrupt
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg === 'Stream aborted' || errorMsg === 'Stream interrupted') {
        // Check if this was caused by first-event timeout (session corruption)
        if (sessionInfo?.interrupted && eventCount === 0) {
          console.warn(`[ClaudeManager][${sessionId}] First-event timeout triggered — session is corrupted, cleaning up for rebuild`)
          this.cleanupSession(sessionId, 'first-event timeout - session corrupted')
          // Throw a recognizable error so server.ts retries without resume
          throw new Error('SESSION_CORRUPTED: stream hung, needs rebuild')
        }
        // Expected interrupt — mark as aborted for cleanup, then exit gracefully
        wasAborted = true
        console.log(`[ClaudeManager][${sessionId}] Stream stopped: ${errorMsg}`)
        return
      }

      // OPTIMIZATION: Detect SDK session state corruption from reusing a session
      // across turns (streamInput iterator conflict). When this happens, cleanup
      // the session so the next message will rebuild fresh.
      // This is the fallback for the "try reuse first" optimization in getOrCreateSession.
      if (errorMsg.includes('process aborted') || errorMsg.includes('ECONNRESET') || errorMsg.includes('streamInput') || errorMsg.includes('Cannot send to closed session')) {
        console.warn(`[ClaudeManager][${sessionId}] Session reuse failed (SDK state corruption), cleaning up for next message`)
        this.cleanupSession(sessionId, 'reuse failed - SDK state corruption')
      }

      // Other errors — log and re-throw
      console.error('[ClaudeManager] Stream chat error:', error)
      throw new Error(`Claude stream error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Clean up any active subagents that didn't complete
      // Only send failure events when user explicitly stopped (wasAborted).
      // On normal completion, silently clean up — SDK doesn't guarantee all
      // task_notification events arrive before the parent's result event.
      // Sending failure here on normal completion would cause false "Stream interrupted" errors.
      for (const [taskId, state] of subagentStates) {
        if (!state.isComplete) {
          if (wasAborted && !suppressWorkerEvents) {
            yield { type: 'worker:completed', data: {
              agentId: state.agentId, agentName: state.agentName, taskId,
              result: '', error: 'Stopped by user', status: 'failed'
            }}
            console.log(`[ClaudeManager] Subagent ${taskId} marked as stopped by user`)
          } else {
            console.log(`[ClaudeManager] Subagent ${taskId} silently cleaned up (normal stream end)`)
          }
        }
      }

      // OPTIMIZATION: Clean up delta flush timer
      if (deltaFlushTimer) {
        clearInterval(deltaFlushTimer)
        deltaFlushTimer = null
      }
      // Final flush of any remaining buffered deltas
      flushAllDeltaBuffers()
      deltaBuffers.clear()

      // Always unregister active session
      this.unregisterActiveSession(sessionId)

      // Unregister stream iterator
      this.activeStreamIterators.delete(sessionId)
    }
  }

  /**
   * Send a chat message without streaming
   */
  async chat(sessionId: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const session = await this.getOrCreateSession(sessionId, options.workDir)

    const abortController = new AbortController()
    this.registerActiveSession(sessionId, abortController)

    try {
      const lastMessage = messages[messages.length - 1]
      await session.send(lastMessage.content)

      let fullResponse = ''
      for await (const event of session.stream()) {
        const evt = event as any

        if (evt.type === 'content_block_start' || evt.type === 'content_block_delta') {
          if (evt.content_block?.type === 'text') {
            if (evt.content_block?.delta?.type === 'text_delta') {
              fullResponse += evt.content_block.delta.text || ''
            } else if (evt.content_block?.text) {
              fullResponse += evt.content_block.text || ''
            }
          }
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      return fullResponse
    } catch (error) {
      console.error('[ClaudeManager] Chat error:', error)
      throw new Error(`Claude chat error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.unregisterActiveSession(sessionId)
    }
  }

  /**
   * Close a V2 session
   */
  closeSession(conversationId: string): void {
    this.cleanupSession(conversationId, 'explicit close')
  }

  /**
   * Force session rebuild for a conversation (used for auth retry recovery).
   * Closes existing session and clears it from active sessions.
   * Next getOrCreateSession() call will create a fresh session with current credentials.
   */
  forceSessionRebuild(conversationId: string): void {
    const existing = this.sessions.get(conversationId)
    if (existing) {
      console.log(`[ClaudeManager][${conversationId}] Force rebuilding session (auth retry)`)
      this.cleanupSession(conversationId, 'auth retry - credential refresh')
    }
    this.activeSessions.delete(conversationId)
  }

  /**
   * Close all sessions
   */
  closeAllSessions(): void {
    const count = this.sessions.size
    console.log(`[ClaudeManager] Closing all ${count} V2 sessions`)

    for (const convId of Array.from(this.sessions.keys())) {
      this.cleanupSession(convId, 'app shutdown')
    }

    this.stopCleanupInterval()
  }

  /**
   * Invalidate all sessions (called when config changes)
   */
  invalidateAllSessions(): void {
    const count = this.sessions.size
    if (count === 0) {
      console.log('[ClaudeManager] No active sessions to invalidate')
      return
    }

    console.log(`[ClaudeManager] Invalidating ${count} sessions due to config change`)

    for (const convId of Array.from(this.sessions.keys())) {
      // If request in flight, defer cleanup
      if (this.activeSessions.has(convId)) {
        console.log(`[ClaudeManager] Deferring session close until idle: ${convId}`)
        continue
      }
      this.cleanupSession(convId, 'config change')
    }
  }

  /**
   * Get session statistics
   */
  getStats(): { totalSessions: number; activeRequests: number } {
    return {
      totalSessions: this.sessions.size,
      activeRequests: this.activeSessions.size
    }
  }

  /**
   * Get a session by conversation ID (for interrupt)
   */
  getSession(conversationId: string): SDKSession | undefined {
    const info = this.sessions.get(conversationId)
    return info?.session
  }

  /**
   * Remove a session - called when client explicitly closes the session
   *
   * CRITICAL: This method MUST close the SDK session to prevent state pollution.
   * When a user interrupts a conversation, the SDK process may be in an inconsistent
   * state. If we don't close it properly, the next request might reuse this "dirty"
   * process, causing garbled output and tool call errors.
   */
  removeSession(conversationId: string): void {
    const info = this.sessions.get(conversationId)
    if (info) {
      // Abort any active stream iterator
      const streamInfo = this.activeStreamIterators.get(conversationId)
      if (streamInfo) {
        streamInfo.abortController.abort()
        this.activeStreamIterators.delete(conversationId)
        console.log(`[ClaudeManager][${conversationId}] Aborted active stream iterator`)
      }

      // CRITICAL: Close the SDK session to release the underlying process
      // Without this, the SDK process continues running with potentially corrupted state
      try {
        info.session.close()
        console.log(`[ClaudeManager][${conversationId}] SDK session closed`)
      } catch (e: any) {
        // Ignore EPIPE errors (process already exited)
        if (e?.code === 'EPIPE' || e?.message?.includes('EPIPE')) {
          console.log(`[ClaudeManager][${conversationId}] Session close: EPIPE (process already exited)`)
        } else {
          console.warn(`[ClaudeManager][${conversationId}] Error closing session:`, e?.message || e)
        }
      }

      this.sessions.delete(conversationId)
      console.log(`[ClaudeManager][${conversationId}] Session removed from cache`)
    }
  }

  /**
   * Mark a session as interrupted
   */
  markAsInterrupted(conversationId: string): void {
    this.interruptedSessions.add(conversationId)
    // Mark session info so getOrCreateSession() skips reuse
    // An aborted stream can leave the SDK session in a corrupted state
    // (e.g. mid-tool-call), causing session.stream() to hang indefinitely.
    const sessionInfo = this.sessions.get(conversationId)
    if (sessionInfo) {
      sessionInfo.interrupted = true
    }
    console.log(`[ClaudeManager][${conversationId}] Marked as interrupted`)
  }

  /**
   * Check if a session is marked as interrupted and clear the flag
   */
  checkAndClearInterrupt(conversationId: string): boolean {
    const wasInterrupted = this.interruptedSessions.has(conversationId)
    if (wasInterrupted) {
      this.interruptedSessions.delete(conversationId)
      console.log(`[ClaudeManager][${conversationId}] Interrupt flag cleared`)
    }
    return wasInterrupted
  }

  /**
   * Force abort an active stream iterator (for forceful interrupt)
   */
  forceAbortStreamIterator(conversationId: string): boolean {
    const iteratorInfo = this.activeStreamIterators.get(conversationId)
    if (iteratorInfo) {
      console.log(`[ClaudeManager][${conversationId}] Force aborting stream iterator`)
      iteratorInfo.abortController.abort()
      this.activeStreamIterators.delete(conversationId)
      return true
    }
    return false
  }

  /**
   * Process a stream_event for a subagent in remote sessions.
   * Mirrors processSubagentStreamEvent in local stream-processor.ts.
   */
  private processSubagentStreamEventRemote(
    state: RemoteSubagentState,
    event: any,
    onThought?: (thought: ThoughtEvent) => void,
    onThoughtDelta?: (delta: ThoughtDeltaEvent) => void
  ): void {
    const { streamingBlocks, toolIdToThoughtId, agentId, agentName } = state
    const blockIndex = event.index ?? 0

    const tag = { agentId, agentName }

    // Thinking block started
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      const thoughtId = `thought-thinking-sub-${state.taskId}-${blockIndex}-${Date.now()}`
      streamingBlocks.set(blockIndex, { type: 'thinking', thoughtId, content: '' })
      onThought?.({ id: thoughtId, type: 'thinking', content: '', timestamp: new Date().toISOString(), isStreaming: true, ...tag })
      return
    }

    // Thinking delta
    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      const blockState = streamingBlocks.get(blockIndex)
      if (blockState && blockState.type === 'thinking') {
        const delta = event.delta.thinking || ''
        blockState.content += delta
        onThoughtDelta?.({ thoughtId: blockState.thoughtId, delta, content: blockState.content, ...tag })
      }
      return
    }

    // Tool use block started
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const toolId = event.content_block.id || `sub-tool-${Date.now()}`
      const toolName = event.content_block.name || 'Unknown'
      const thoughtId = `thought-tool-sub-${state.taskId}-${blockIndex}-${Date.now()}`
      streamingBlocks.set(blockIndex, { type: 'tool_use', thoughtId, content: '', toolName, toolId })
      onThought?.({ id: thoughtId, type: 'tool_use', content: '', timestamp: new Date().toISOString(), toolName, toolInput: {}, isStreaming: true, isReady: false, ...tag })
      return
    }

    // Tool use input JSON delta
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const blockState = streamingBlocks.get(blockIndex)
      if (blockState && blockState.type === 'tool_use') {
        blockState.content += event.delta.partial_json || ''
        onThoughtDelta?.({ thoughtId: blockState.thoughtId, delta: event.delta.partial_json || '', isToolInput: true, ...tag })
      }
      return
    }

    // Block stop
    if (event.type === 'content_block_stop') {
      const blockState = streamingBlocks.get(blockIndex)
      if (!blockState) return

      if (blockState.type === 'thinking') {
        onThoughtDelta?.({ thoughtId: blockState.thoughtId, content: blockState.content, isComplete: true, ...tag })
      } else if (blockState.type === 'tool_use') {
        let toolInput: Record<string, unknown> = {}
        try { if (blockState.content) toolInput = JSON.parse(blockState.content) } catch (e) { /* ignore */ }
        if (blockState.toolId) toolIdToThoughtId.set(blockState.toolId, blockState.thoughtId)
        onThoughtDelta?.({ thoughtId: blockState.thoughtId, toolInput, isComplete: true, isReady: true, isToolInput: true, ...tag })
      } else if (blockState.type === 'text') {
        onThoughtDelta?.({ thoughtId: blockState.thoughtId, content: blockState.content, isComplete: true, ...tag })
      }
      streamingBlocks.delete(blockIndex)
      return
    }

    // Text block started
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      const thoughtId = `thought-text-sub-${state.taskId}-${blockIndex}-${Date.now()}`
      streamingBlocks.set(blockIndex, { type: 'text', thoughtId, content: event.content_block.text || '' })
      onThought?.({ id: thoughtId, type: 'text', content: event.content_block.text || '', timestamp: new Date().toISOString(), isStreaming: true, ...tag })
      return
    }

    // Text delta
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const delta = event.delta.text || ''
      const blockState = streamingBlocks.get(blockIndex)
      if (blockState && blockState.type === 'text') {
        blockState.content += delta
        onThoughtDelta?.({ thoughtId: blockState.thoughtId, delta, content: blockState.content, ...tag })
      }
      return
    }
  }

  /**
   * Wrap an async iterator with interrupt support
   * Periodically checks abort signal and interrupt flag to allow forceful exit
   */
  private async *wrapStreamWithInterrupt(
    stream: AsyncIterable<any>,
    sessionId: string,
    abortController: AbortController
  ): AsyncGenerator<any> {
    const INTERRUPT_CHECK_INTERVAL_MS = 100  // Check every 100ms
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    // Create a promise that rejects when abort is signaled
    const abortPromise = new Promise<never>((_, reject) => {
      const checkAbort = () => {
        if (abortController.signal.aborted) {
          console.log(`[ClaudeManager][${sessionId}] Abort signal detected in wrapper`)
          reject(new Error('Stream aborted'))
          return
        }
        // Also check interrupt flag
        if (this.checkAndClearInterrupt(sessionId)) {
          console.log(`[ClaudeManager][${sessionId}] Interrupt flag detected in wrapper`)
          reject(new Error('Stream interrupted'))
          return
        }
        // Schedule next check
        pollTimer = setTimeout(checkAbort, INTERRUPT_CHECK_INTERVAL_MS)
      }
      checkAbort()
    })

    try {
      const iterator = stream[Symbol.asyncIterator]()

      while (true) {
        // Race between getting next event and abort signal
        const nextEventPromise = iterator.next()

        const result = await Promise.race([
          nextEventPromise,
          abortPromise
        ])

        if (result.done) {
          break
        }

        yield result.value
      }
    } catch (error) {
      if (error instanceof Error && (error.message === 'Stream aborted' || error.message === 'Stream interrupted')) {
        // Expected abort/interrupt - re-throw for caller to handle
        throw error
      }
      // Other errors - log and re-throw
      console.error(`[ClaudeManager][${sessionId}] Stream wrapper error:`, error)
      throw error
    } finally {
      if (pollTimer) clearTimeout(pollTimer)
      console.log(`[ClaudeManager][${sessionId}] Stream wrapper cleanup complete`)
    }
  }

  /**
   * Stream chat for app execution.
   * Simplified version of streamChat() used by ProxyAppRuntime for background app runs.
   * Creates a one-shot session with the given MCP servers and system prompt.
   *
   * @param sessionId - Unique session ID for this app run
   * @param messages - Chat messages to send
   * @param options - Chat options (system prompt, max tokens)
   * @param mcpServers - MCP servers to inject (e.g., aico-bot-report)
   * @returns AsyncGenerator yielding stream chunks
   */
  async *streamChatForApp(
    sessionId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
    mcpServers?: Record<string, any>
  ): AsyncGenerator<{ type: string; data?: any }> {
    const workDir = options.workDir || this.workDir || process.cwd()

    // Build SDK options with provided MCP servers
    const sdkOptions: any = {
      model: this.model || 'claude-sonnet-4-6',
      cwd: workDir,
      systemPrompt: options.system || '',
      permissionMode: 'bypassPermissions',
      extraArgs: { 'dangerously-skip-permissions': null },
      allowedTools: [...PRE_APPROVED_TOOLS],
      disallowedTools: ['WebFetch', 'WebSearch'],
      includePartialMessages: true,
      maxTurns: 10,  // App runs should be focused, fewer turns
      ...(options.contextWindow ? { modelContextWindow: options.contextWindow } : this.contextWindow ? { modelContextWindow: this.contextWindow } : {}),
    }

    if (this.pathToClaudeCodeExecutable) {
      sdkOptions.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable
    }

    // Inject MCP servers if provided
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      sdkOptions.mcpServers = {}
      for (const [name, config] of Object.entries(mcpServers)) {
        const obj = config as any
        if (obj.instance != null && typeof obj.toJSON !== 'function') {
          obj.toJSON = () => { const { instance, ...rest } = obj; return rest }
        }
        sdkOptions.mcpServers[name] = config
      }
    }

    // Create a fresh session for this app run
    try {
      const session = await unstable_v2_createSession(sdkOptions)
      this.registerActiveSession(sessionId, new AbortController())

      // Send messages and iterate over stream
      await session.send(messages.map(m => m.content).join('\n\n'))

      for await (const event of session.stream()) {
        const evt = event as any

        if (evt.type === 'assistant_message_delta') {
          yield { type: 'text', data: { text: evt.delta?.text || '' } }
        } else if (evt.type === 'result') {
          yield { type: 'complete', data: evt }
        }
      }

      // Close the session after app run completes
      this.unregisterActiveSession(sessionId)
      await (session as any).close().catch(() => {})
    } catch (error) {
      this.unregisterActiveSession(sessionId)
      throw error
    }
  }

  // ============================================
  // File Operations (using V2 Session tools)
  // ============================================

  /**
   * List files in directory using V2 Session
   */
  async listFiles(sessionId: string, path: string): Promise<FileInfo[]> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const command = `ls -la "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      let output = ''
      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'terminal_output') {
          output += evt.content
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      const lines = output.trim().split('\n').slice(1)
      return lines.map(line => {
        const parts = line.trim().split(/\s+/)
        const name = parts[parts.length - 1]
        const isDir = line.startsWith('d')
        return {
          name,
          isDirectory: isDir,
          size: parseInt(parts[4] || '0', 10),
          modifiedTime: new Date()
        }
      }).filter(f => f.name !== '.' && f.name !== '..')
    } catch (error) {
      throw new Error(`File listing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Read file using V2 Session
   */
  async readFile(sessionId: string, path: string): Promise<string> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const command = `cat "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      let output = ''
      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'terminal_output') {
          output += evt.content
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      return output
    } catch (error) {
      throw new Error(`File read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Write file using V2 Session
   */
  async writeFile(sessionId: string, path: string, content: string): Promise<void> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const base64Content = Buffer.from(content).toString('base64')
      const command = `echo "${base64Content}" | base64 -d > "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'message_stop') {
          break
        }
      }
    } catch (error) {
      throw new Error(`File write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Delete file using V2 Session
   */
  async deleteFile(sessionId: string, path: string): Promise<void> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      const command = `rm -f "${path.replace(/"/g, '\\"')}"`
      await session.send(command)

      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'message_stop') {
          break
        }
      }
    } catch (error) {
      throw new Error(`File delete failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Execute command via V2 Session
   */
  async executeCommand(sessionId: string, command: string): Promise<string> {
    const session = await this.getOrCreateSession(sessionId)

    try {
      await session.send(command)

      let output = ''
      for await (const event of session.stream()) {
        const evt = event as any
        if (evt.type === 'terminal_output') {
          output += evt.content
        } else if (evt.type === 'message_stop') {
          break
        }
      }

      return output
    } catch (error) {
      throw new Error(`Command execution failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  registerSessionExitCallback(conversationId: string, callback: (reason: string) => void): void {
    this.sessionExitCallbacks.set(conversationId, callback)
  }

  unregisterSessionExitCallback(conversationId: string): void {
    this.sessionExitCallbacks.delete(conversationId)
  }
}
