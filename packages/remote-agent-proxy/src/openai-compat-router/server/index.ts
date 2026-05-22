/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * OpenAI Compat Router Server
 *
 * Starts a local HTTP server that translates between Anthropic and OpenAI API formats
 */

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RouterServerInfo, RouterOptions } from '../types'
import type { LogEntry } from './router'
import { createApp } from './router'
import { log, SCOPE } from '../../logger.js'

// Singleton state
let server: Server | null = null
let info: RouterServerInfo | null = null
let starting: Promise<RouterServerInfo> | null = null
let logCallback: ((entry: LogEntry) => void) | null = null

/**
 * Set a callback to receive log entries from the router.
 * Must be called before the router is started (before first ensureOpenAICompatRouter call).
 */
export function setOnLogCallback(callback: (entry: LogEntry) => void): void {
  logCallback = callback
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Ensure the router server is running
 *
 * Returns existing server info if already running,
 * or starts a new server if not.
 */
export async function ensureOpenAICompatRouter(
  options: RouterOptions = {}
): Promise<RouterServerInfo> {
  // Return existing server if running
  if (info && server) return info

  // Return pending startup if in progress
  if (starting) return starting

  // Start new server
  starting = new Promise<RouterServerInfo>((resolve, reject) => {
    try {
      const debug = options.debug === true
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

      const app = createApp({ debug, timeoutMs, onLog: logCallback ?? undefined })

      server = app.listen(0, '127.0.0.1', () => {
        const addr = server?.address() as AddressInfo | null

        if (!addr) {
          reject(new Error('Failed to get router address'))
          return
        }

        info = {
          port: addr.port,
          baseUrl: `http://127.0.0.1:${addr.port}`
        }

        log.info(SCOPE.SERVER, `OpenAI Compat Router started on ${info.baseUrl}`)
        resolve(info)
      })

      server.on('error', (err) => {
        log.error(SCOPE.SERVER, `OpenAI Compat Router server error: ${err}`)
        reject(err)
      })
    } catch (e) {
      reject(e)
    }
  }).finally(() => {
    starting = null
  })

  return starting
}

/**
 * Stop the router server
 */
export async function stopOpenAICompatRouter(): Promise<void> {
  if (!server) return

  const s = server
  server = null
  info = null

  await new Promise<void>((resolve) => {
    s.close(() => resolve())
  })

  log.info(SCOPE.SERVER, 'OpenAI Compat Router stopped')
}

/**
 * Get current server info (if running)
 */
export function getRouterInfo(): RouterServerInfo | null {
  return info
}

/**
 * Check if server is running
 */
export function isRouterRunning(): boolean {
  return server !== null && info !== null
}

// Re-export components
export { createApp } from './router'
export type { LogEntry } from './router'
export { handleMessagesRequest, handleCountTokensRequest } from './request-handler'
export { withRequestQueue, generateQueueKey, clearRequestQueues, getPendingRequestCount } from './request-queue'
export { shouldForceStream } from './api-type'
export { applyProviderAdapter, findAdapter } from './provider-adapters'
export type { ProviderAdapter } from './provider-adapters'
