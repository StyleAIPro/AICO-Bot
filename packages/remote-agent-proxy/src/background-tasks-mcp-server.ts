/**
 * Standalone MCP Server for Background Tasks (stdio transport)
 *
 * Runs as a child process of the Claude Agent SDK.
 * Provides tools for spawning, monitoring, and cancelling
 * long-running shell commands without blocking the conversation.
 *
 * Usage (via SDK mcpServers config):
 *   { type: 'stdio', command: 'node', args: ['path/to/background-tasks-mcp-server.js'] }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { spawn, type ChildProcess } from 'child_process'
import { z } from 'zod'
import * as crypto from 'crypto'
import { log, SCOPE } from './logger.js'

// ============================================
// Types
// ============================================

type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

interface BackgroundTask {
  id: string
  command: string
  cwd?: string
  status: TaskStatus
  pid?: number
  startedAt: number
  completedAt?: number
  exitCode?: number
  output: string
  outputLines: number
}

// ============================================
// Inline BackgroundTaskManager
// ============================================

const MAX_OUTPUT_LENGTH = 8192

class TaskManager {
  private tasks = new Map<string, BackgroundTask>()
  private processes = new Map<string, ChildProcess>()
  private outputBuffers = new Map<string, string>()

  spawn(command: string, cwd?: string): BackgroundTask {
    const id = crypto.randomUUID().slice(0, 8)
    const task: BackgroundTask = {
      id,
      command,
      cwd,
      status: 'running',
      startedAt: Date.now(),
      output: '',
      outputLines: 0,
    }

    const child = spawn('sh', ['-c', command], {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    task.pid = child.pid
    this.tasks.set(id, task)
    this.processes.set(id, child)
    this.outputBuffers.set(id, '')

    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput(id, chunk.toString())
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput(id, chunk.toString())
    })

    child.on('close', (code) => {
      this.flushOutput(id)
      task.exitCode = code ?? undefined
      task.completedAt = Date.now()
      task.status = code === 0 ? 'completed' : 'failed'
      this.processes.delete(id)
    })

    child.on('error', (err) => {
      this.flushOutput(id)
      task.completedAt = Date.now()
      task.status = 'failed'
      task.output += `\n[spawn error] ${err.message}`
      this.processes.delete(id)
    })

    return task
  }

  list(): BackgroundTask[] {
    return Array.from(this.tasks.values())
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)
  }

  cancel(id: string): boolean {
    const proc = this.processes.get(id)
    const task = this.tasks.get(id)
    if (!proc || !task || task.status !== 'running') return false

    try {
      process.kill(-proc.pid!, 'SIGTERM')
    } catch {
      try { proc.kill('SIGTERM') } catch { /* already exited */ }
    }

    task.status = 'cancelled'
    task.completedAt = Date.now()
    this.processes.delete(id)
    this.flushOutput(id)
    return true
  }

  private appendOutput(id: string, text: string): void {
    const buf = this.outputBuffers.get(id) || ''
    this.outputBuffers.set(id, buf + text)
  }

  private flushOutput(id: string): void {
    const buf = this.outputBuffers.get(id) || ''
    if (!buf) return
    const task = this.tasks.get(id)
    if (!task) return
    task.output = (task.output + buf).slice(-MAX_OUTPUT_LENGTH)
    task.outputLines += (buf.match(/\n/g) || []).length
    this.outputBuffers.set(id, '')
  }

  dispose(): void {
    for (const id of this.processes.keys()) {
      this.cancel(id)
    }
    this.tasks.clear()
  }
}

// ============================================
// MCP Server Setup
// ============================================

const taskManager = new TaskManager()

const server = new McpServer(
  { name: 'background-tasks', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// BackgroundBash - spawn a command in the background
server.tool(
  'BackgroundBash',
  'Run a shell command in the background without blocking. Use this for long-running commands like docker pull, model downloads, training jobs, service startup, etc. The command runs independently and you can check its status later. Returns a task ID immediately.',
  { command: z.string().describe('The shell command to run in the background'), cwd: z.string().optional().describe('Working directory (defaults to current workDir)') },
  async ({ command, cwd }) => {
    try {
      const task = taskManager.spawn(command, cwd)
      return {
        content: [{ type: 'text' as const, text: `Background task started.\n\nTask ID: ${task.id}\nCommand: ${task.command}\nPID: ${task.pid}\n\nYou can check status later with BackgroundTaskStatus.` }]
      }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true }
    }
  }
)

// BackgroundTaskStatus - check a task
server.tool(
  'BackgroundTaskStatus',
  'Check the status and recent output of a background task.',
  { task_id: z.string().describe('The task ID returned by BackgroundBash') },
  async ({ task_id }) => {
    try {
      const task = taskManager.get(task_id)
      if (!task) return { content: [{ type: 'text' as const, text: `Task not found: ${task_id}` }], isError: true }
      const duration = task.completedAt
        ? `${((task.completedAt - task.startedAt) / 1000).toFixed(0)}s`
        : `${((Date.now() - task.startedAt) / 1000).toFixed(0)}s (running)`
      const outputPreview = task.output ? task.output.slice(-2000) : '(no output yet)'
      return {
        content: [{ type: 'text' as const, text: `Task: ${task.id}\nStatus: ${task.status}\nCommand: ${task.command}\nPID: ${task.pid}\nDuration: ${duration}\nOutput lines: ${task.outputLines}\n\nRecent output:\n${outputPreview}` }]
      }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true }
    }
  }
)

// BackgroundTaskList - list all tasks
server.tool(
  'BackgroundTaskList',
  'List all background tasks and their statuses.',
  {},
  async () => {
    try {
      const tasks = taskManager.list()
      if (tasks.length === 0) return { content: [{ type: 'text' as const, text: 'No background tasks.' }] }
      const lines = tasks.map(t => {
        const duration = t.completedAt
          ? `${((t.completedAt - t.startedAt) / 1000).toFixed(0)}s`
          : `${((Date.now() - t.startedAt) / 1000).toFixed(0)}s`
        return `[${t.status}] ${t.id} | ${duration} | ${t.command.slice(0, 80)}`
      })
      return { content: [{ type: 'text' as const, text: `Background tasks (${tasks.length}):\n${lines.join('\n')}` }] }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true }
    }
  }
)

// BackgroundTaskCancel - cancel a task
server.tool(
  'BackgroundTaskCancel',
  'Cancel a running background task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async ({ task_id }) => {
    try {
      const ok = taskManager.cancel(task_id)
      if (!ok) return { content: [{ type: 'text' as const, text: `Cannot cancel task ${task_id}. Not found or not running.` }], isError: true }
      return { content: [{ type: 'text' as const, text: `Task ${task_id} cancelled.` }] }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true }
    }
  }
)

// ============================================
// Start
// ============================================

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Graceful shutdown
  const cleanup = () => {
    taskManager.dispose()
    server.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGHUP', cleanup)
}

main().catch((err) => {
  log.error(SCOPE.SERVER, `background-tasks-mcp fatal error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
