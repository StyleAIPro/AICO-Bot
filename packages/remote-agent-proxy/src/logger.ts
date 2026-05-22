/**
 * Remote Agent Proxy Logger
 *
 * Provides timestamped, leveled logging with unified scope prefixes.
 * Writes to both console and date-rotated log files.
 * Controlled via LOG_LEVEL env var (default: 'info').
 */

import * as fs from 'fs'
import * as path from 'path'

const LOG_LEVEL = process.env.LOG_LEVEL || 'info'

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function shouldLog(level: string): boolean {
  return (LEVEL_ORDER[level] ?? 1) >= (LEVEL_ORDER[LOG_LEVEL] ?? 1)
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function fmt(level: string, scope: string, msg: string): string {
  return `${timestamp()} [${level}] [${scope}] ${msg}`
}

// ── File transport ──────────────────────────────────────────────

let logDir = path.join(process.env.DEPLOY_DIR || '/opt/claude-deployment', 'logs')
let currentLogFilePath: string | null = null
let currentWriteStream: fs.WriteStream | null = null

const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024  // 5MB
const MAX_LOG_AGE_DAYS = 30

export function setLogDir(dir: string): void {
  logDir = dir
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

function getLogFilePath(): string {
  const dateStr = new Date().toISOString().split('T')[0]
  return path.join(logDir, `proxy-${dateStr}.log`)
}

function getWriteStream(): fs.WriteStream {
  const filePath = getLogFilePath()
  if (filePath !== currentLogFilePath || !currentWriteStream) {
    if (currentWriteStream) currentWriteStream.end()
    currentLogFilePath = filePath
    currentWriteStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
  }
  return currentWriteStream
}

function writeToFile(formatted: string): void {
  try {
    getWriteStream().write(formatted + '\n')
  } catch {
    // File write failure should not affect service
  }
}

/** Delete log files older than 30 days, truncate files larger than 5MB */
export function cleanupOldLogs(): void {
  try {
    if (!fs.existsSync(logDir)) return
    const now = Date.now()
    const files = fs.readdirSync(logDir).filter(f => f.startsWith('proxy-') && f.endsWith('.log'))
    for (const file of files) {
      const filePath = path.join(logDir, file)
      const stat = fs.statSync(filePath)
      if (now - stat.mtimeMs > MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath)
        continue
      }
      if (stat.size > MAX_LOG_FILE_SIZE) {
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(MAX_LOG_FILE_SIZE)
        fs.readSync(fd, buf, 0, MAX_LOG_FILE_SIZE, stat.size - MAX_LOG_FILE_SIZE)
        fs.closeSync(fd)
        fs.writeFileSync(filePath, buf)
      }
    }
  } catch {
    // Cleanup failure should not affect service
  }
}

// ── Logger API ──────────────────────────────────────────────────

export const log = {
  info(scope: string, msg: string) {
    const formatted = fmt('INFO', scope, msg)
    if (shouldLog('info')) console.log(formatted)
    writeToFile(formatted)
  },
  warn(scope: string, msg: string) {
    const formatted = fmt('WARN', scope, msg)
    if (shouldLog('warn')) console.warn(formatted)
    writeToFile(formatted)
  },
  error(scope: string, msg: string) {
    const formatted = fmt('ERROR', scope, msg)
    if (shouldLog('error')) console.error(formatted)
    writeToFile(formatted)
  },
  debug(scope: string, msg: string) {
    if (!shouldLog('debug')) return
    const formatted = fmt('DEBUG', scope, msg)
    console.log(formatted)
    // debug does not write to file to reduce noise
  },
}

/**
 * Log a conversation summary that always writes to file (unaffected by LOG_LEVEL).
 * Used for user input and model output summaries.
 */
export function logConversation(summary: string): void {
  const formatted = `${timestamp()} [INFO] [Conv] ${summary}`
  console.log(formatted)
  writeToFile(formatted)
}

/** Abbreviate a UUID to first 8 chars */
export function shortId(id?: string): string {
  return id ? id.substring(0, 8) : '???????'
}

export const SCOPE = {
  SERVER: 'Server',
  CLAUDE_MGR: 'ClaudeMgr',
  MCP: 'MCP',
  DIAG: 'DIAG',
} as const
