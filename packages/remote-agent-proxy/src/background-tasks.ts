/**
 * Background Task Manager for Remote Agent Proxy
 *
 * Spawns long-running commands (docker pull, model download, training, etc.)
 * as child processes, tracks their state, and streams output.
 */

import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as crypto from 'crypto'
import { log, SCOPE } from './logger.js'

// ============================================
// Types
// ============================================

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface BackgroundTask {
  id: string
  command: string
  cwd?: string
  status: TaskStatus
  pid?: number
  startedAt: number
  completedAt?: number
  exitCode?: number
  /** Last 8KB of stdout/stderr for progress display */
  output: string
  /** Total output lines (for progress estimation) */
  outputLines: number
}

export interface TaskEvent {
  type: 'created' | 'output' | 'completed' | 'failed' | 'cancelled'
  task: BackgroundTask
}

// ============================================
// Manager
// ============================================

const MAX_OUTPUT_LENGTH = 8192
const OUTPUT_SAMPLE_INTERVAL = 2000 // ms between output event emissions

export class BackgroundTaskManager extends EventEmitter {
  private tasks = new Map<string, BackgroundTask>()
  private processes = new Map<string, ChildProcess>()
  private outputBuffers = new Map<string, string>() // un-flushed output per task
  private sampleTimers = new Map<string, NodeJS.Timeout>()

  /**
   * Spawn a command in the background. Returns the task immediately.
   * The command runs independently — Claude is NOT blocked.
   */
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

    // Use shell to support pipes, redirects, etc.
    const child = spawn('sh', ['-c', command], {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    task.pid = child.pid
    this.tasks.set(id, task)
    this.processes.set(id, child)
    this.outputBuffers.set(id, '')

    // Handle stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput(id, chunk.toString())
    })

    // Handle stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput(id, chunk.toString())
    })

    // Handle exit
    child.on('close', (code) => {
      this.flushOutput(id)
      task.exitCode = code ?? undefined
      task.completedAt = Date.now()
      task.status = code === 0 ? 'completed' : 'failed'
      this.processes.delete(id)
      this.stopSample(id)
      this.emit('update', { type: task.status, task } as TaskEvent)
    })

    // Handle spawn error
    child.on('error', (err) => {
      this.flushOutput(id)
      task.completedAt = Date.now()
      task.status = 'failed'
      task.output += `\n[spawn error] ${err.message}`
      this.processes.delete(id)
      this.stopSample(id)
      this.emit('update', { type: 'failed', task } as TaskEvent)
    })

    // Start periodic output sampling
    this.startSample(id)

    log.info(SCOPE.SERVER, `Spawned task ${id}: "${command}" (pid=${child.pid})`)
    this.emit('update', { type: 'created', task } as TaskEvent)

    return task
  }

  /** Get all tasks */
  list(): BackgroundTask[] {
    return Array.from(this.tasks.values())
  }

  /** Get a single task */
  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)
  }

  /** Cancel a running task */
  cancel(id: string): boolean {
    const proc = this.processes.get(id)
    const task = this.tasks.get(id)
    if (!proc || !task || task.status !== 'running') return false

    // Kill the process group
    try {
      process.kill(-proc.pid!, 'SIGTERM')
    } catch {
      try {
        proc.kill('SIGTERM')
      } catch {
        // Process may have already exited
      }
    }

    task.status = 'cancelled'
    task.completedAt = Date.now()
    this.processes.delete(id)
    this.stopSample(id)
    this.flushOutput(id)
    this.emit('update', { type: 'cancelled', task } as TaskEvent)
    return true
  }

  /** Remove completed/failed/cancelled tasks from memory */
  prune(): number {
    let removed = 0
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running') {
        this.tasks.delete(id)
        this.stopSample(id)
        removed++
      }
    }
    return removed
  }

  /** Clean up all tasks */
  dispose(): void {
    for (const id of this.processes.keys()) {
      this.cancel(id)
    }
    for (const timer of this.sampleTimers.values()) {
      clearInterval(timer)
    }
    this.sampleTimers.clear()
    this.tasks.clear()
    this.removeAllListeners()
  }

  // ============================================
  // Internal
  // ============================================

  private appendOutput(id: string, text: string): void {
    const task = this.tasks.get(id)
    if (!task) return

    const buf = this.outputBuffers.get(id) || ''
    this.outputBuffers.set(id, buf + text)
  }

  private flushOutput(id: string): void {
    const buf = this.outputBuffers.get(id) || ''
    if (!buf) return

    const task = this.tasks.get(id)
    if (!task) return

    task.output = (task.output + buf).slice(-MAX_OUTPUT_LENGTH)
    // Count newlines for rough progress
    task.outputLines += (buf.match(/\n/g) || []).length
    this.outputBuffers.set(id, '')
  }

  private startSample(id: string): void {
    const timer = setInterval(() => {
      this.flushOutput(id)
      const task = this.tasks.get(id)
      if (task && task.status === 'running') {
        this.emit('update', { type: 'output', task } as TaskEvent)
      }
    }, OUTPUT_SAMPLE_INTERVAL)
    this.sampleTimers.set(id, timer)
  }

  private stopSample(id: string): void {
    const timer = this.sampleTimers.get(id)
    if (timer) {
      clearInterval(timer)
      this.sampleTimers.delete(id)
    }
    this.outputBuffers.delete(id)
  }
}
