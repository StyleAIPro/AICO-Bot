/**
 * Express Router
 *
 * Defines API routes for the OpenAI compatibility layer
 */

import express, { type Express, type Request, type Response } from 'express'
import type { AnthropicRequest } from '../types'
import { decodeBackendConfig } from '../utils'
import { handleMessagesRequest, handleCountTokensRequest } from './request-handler'
import { log, SCOPE } from '../../logger.js'

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  message: string
  source: 'router' | 'request-handler'
}

export interface RouterOptions {
  debug?: boolean
  timeoutMs?: number
  onLog?: (entry: LogEntry) => void
}

function formatRemoteBodySize(req: Request): string {
  const cl = req.headers['content-length']
  if (cl) return `${(Number(cl) / 1024).toFixed(1)}KB`
  const raw = (req as any).rawBody as Buffer | undefined
  if (raw) return `${(raw.length / 1024).toFixed(1)}KB`
  return 'unknown'
}

function formatRemoteSanitizedHeaders(req: Request): string {
  const h = req.headers
  const parts: string[] = []
  if (h['content-type']) parts.push(`content-type=${String(h['content-type'])}`)
  if (h['user-agent']) parts.push(`user-agent=${String(h['user-agent']).slice(0, 60)}`)
  if (h['x-api-key']) parts.push(`x-api-key=${String(h['x-api-key']).slice(0, 8)}...`)
  if (h['authorization']) parts.push(`authorization=${String(h['authorization']).slice(0, 16)}...`)
  return parts.join(' ')
}

/**
 * Create and configure the Express application
 */
export function createApp(options: RouterOptions = {}): Express {
  const app = express()
  const { debug = false, timeoutMs, onLog } = options

  // Body parser with large limit for images
  // verify callback captures the raw body buffer before JSON parsing,
  // enabling zero-cost forwarding when interceptors don't modify the request.
  app.use(express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf
    }
  }))

  // Request logging middleware (production-level)
  app.use((req, _res, next) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
    const logMsg = `${req.method} ${req.url} from=${clientIp} ${formatRemoteSanitizedHeaders(req)} body=${formatRemoteBodySize(req)}`
    log.info('Router', logMsg)
    onLog?.({ level: 'info', message: logMsg, source: 'router' })
    next()
  })

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Main messages endpoint
  app.post('/v1/messages', async (req: Request, res: Response) => {
    const anthropicRequest = (req.body || {}) as AnthropicRequest

    // Extract API key from header
    const rawKey = req.headers['x-api-key']
    const rawKeyStr = Array.isArray(rawKey) ? rawKey[0] : rawKey

    if (!rawKeyStr) {
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'x-api-key is required' }
      })
    }

    // Decode backend configuration from API key
    const decodedConfig = decodeBackendConfig(String(rawKeyStr))
    if (!decodedConfig) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid x-api-key format. Expect base64(JSON.stringify({ url, key, model?, apiType? }))'
        }
      })
    }

    // Handle the request
    // Forward all SDK headers for transparent passthrough, excluding hop-by-hop
    // headers and those that will be overridden by fetchAnthropicUpstream.
    // Upstream may validate any header at any time — we must not silently drop them.
    const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'x-api-key'])
    const sdkHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key) && value) {
        sdkHeaders[key] = Array.isArray(value) ? value[0] : value
      }
    }
    const queryString = req.url.includes('?') ? req.url.split('?')[1] : undefined

    const rawBody = (req as any).rawBody as Buffer | undefined

    await handleMessagesRequest(anthropicRequest, decodedConfig, res, {
      debug, timeoutMs, sdkHeaders, queryString, rawBody, onLog
    })
  })

  // Token counting endpoint
  app.post('/v1/messages/count_tokens', (req: Request, res: Response) => {
    const { messages, system } = (req.body || {}) as { messages?: unknown; system?: unknown }
    const result = handleCountTokensRequest(messages, system)
    res.json(result)
  })

  return app
}
