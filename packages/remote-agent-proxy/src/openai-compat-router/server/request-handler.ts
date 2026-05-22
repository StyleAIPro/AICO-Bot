/**
 * Request Handler
 *
 * Core logic for handling API requests through the router.
 *
 * Supports two modes:
 *   1. OpenAI conversion: Anthropic -> OpenAI -> Backend -> OpenAI -> Anthropic
 *   2. Anthropic passthrough: Anthropic -> Backend -> Anthropic (zero conversion)
 *
 * Interceptors run BEFORE any format conversion, on the native Anthropic request.
 * URL is the single source of truth for OpenAI mode - no inference, no override.
 */

import type { Response as ExpressResponse } from 'express'
import type { AnthropicRequest, BackendConfig } from '../types'
import type { LogEntry } from './router'
import {
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses,
  convertOpenAIChatToAnthropic,
  convertOpenAIResponsesToAnthropic
} from '../converters'
import {
  streamOpenAIChatToAnthropic,
  streamOpenAIResponsesToAnthropic
} from '../stream'
import { getApiTypeFromUrl, isValidEndpointUrl, getEndpointUrlError, shouldForceStream } from './api-type'
import { withRequestQueue, generateQueueKey } from './request-queue'
import { runInterceptors } from '../interceptors'
import { applyProviderAdapter } from './provider-adapters'
import { log } from '../../logger.js'

export interface RequestHandlerOptions {
  debug?: boolean
  timeoutMs?: number
  /** Anthropic SDK headers from the incoming request (anthropic-version, anthropic-beta, etc.) */
  sdkHeaders?: Record<string, string>
  /** Raw query string from the incoming request URL (e.g., "beta=true") */
  queryString?: string
  /** Raw request body buffer captured before JSON parsing */
  rawBody?: Buffer
  /** Whether interceptors modified the request (set internally) */
  requestModified?: boolean
  /** Log callback for forwarding logs to WebSocket layer */
  onLog?: (entry: LogEntry) => void
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Anthropic error type to HTTP status code mapping
 */
const ERROR_STATUS_MAP: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
  timeout_error: 504
}

/**
 * HTTP status code to Anthropic error type mapping (official only)
 */
const STATUS_ERROR_MAP: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error'
}

/**
 * Get Anthropic error type from HTTP status code
 */
function getErrorTypeFromStatus(status: number): string {
  return STATUS_ERROR_MAP[status] || 'api_error'
}

/**
 * Get error type and message from upstream response
 * Priority: upstream error.type (OpenAI format) > HTTP status mapping > 'api_error'
 */
function getUpstreamError(status: number, errorText: string): { type: string; message: string } {
  try {
    const json = JSON.parse(errorText)
    // OpenAI format: { error: { type, message } }
    if (json?.error?.type) {
      return { type: json.error.type, message: json.error.message || '' }
    }
    // Anthropic format: { error: { type, message } }
    if (json?.error?.message) {
      return { type: json.error.type || getErrorTypeFromStatus(status), message: json.error.message }
    }
  } catch {
    // Not JSON, ignore
  }
  return {
    type: getErrorTypeFromStatus(status),
    message: errorText || `HTTP ${status}`
  }
}

/**
 * Send error response in Anthropic JSON format
 *
 * Returns HTTP error status code + JSON body (not SSE).
 * SDK recognizes HTTP 4xx/5xx and throws APIError immediately.
 */
function sendError(
  res: ExpressResponse,
  errorType: string,
  message: string,
  retryAfter?: string
): void {
  const status = ERROR_STATUS_MAP[errorType] || 500
  log.info('RequestHandler', `Sending error: HTTP ${status} ${errorType} - ${message.slice(0, 100)}`)

  res.status(status)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('request-id', `req_${Date.now()}`)
  if (retryAfter) {
    res.setHeader('retry-after', retryAfter)
  }
  res.json({
    type: 'error',
    error: { type: errorType, message }
  })
}

// ============================================================================
// Upstream Fetch
// ============================================================================

/**
 * Make upstream request with OpenAI-style Authorization header
 */
async function fetchUpstream(
  targetUrl: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  customHeaders?: Record<string, string>
): Promise<globalThis.Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    log.info('RequestHandler', 'Request timeout, aborting...')
    controller.abort()
  }, timeoutMs)

  try {
    // Build headers: start with custom headers, then add defaults
    // Custom headers can override Authorization if needed (e.g., OAuth providers)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(customHeaders || {}),
    }
    // Only add Authorization if not provided in custom headers
    if (!headers['Authorization']) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    return await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ?? controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Make upstream request with Anthropic-style x-api-key header.
 *
 * Header merge order (later wins):
 *   1. SDK headers (content-type, anthropic-version, anthropic-beta, etc. from the SDK's request)
 *   2. User custom headers (from provider config)
 *   3. x-api-key (replaced with real key — sdkHeaders carries the encoded config key)
 *
 * @param bodyOrBuffer - Pre-serialized Buffer (raw body) or object to JSON.stringify
 */
async function fetchAnthropicUpstream(
  targetUrl: string,
  apiKey: string,
  bodyOrBuffer: Buffer | unknown,
  timeoutMs: number,
  sdkHeaders?: Record<string, string>,
  customHeaders?: Record<string, string>
): Promise<globalThis.Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    log.info('RequestHandler', 'Anthropic passthrough timeout, aborting...')
    controller.abort()
  }, timeoutMs)

  try {
    const headers: Record<string, string> = {
      ...(sdkHeaders || {}),
      ...(customHeaders || {}),
      'x-api-key': apiKey,
    }

    return await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: Buffer.isBuffer(bodyOrBuffer) ? bodyOrBuffer : JSON.stringify(bodyOrBuffer),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================================
// Anthropic Passthrough Handler
// ============================================================================

/**
 * Headers that must NOT be forwarded from upstream response to client.
 * These are hop-by-hop or transport-level headers managed by Node/Express.
 */
const RESPONSE_HOP_BY_HOP = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'keep-alive',
])

/**
 * Forward all upstream response headers to the client, skipping hop-by-hop headers.
 * This ensures the proxy is fully transparent at the HTTP header level.
 */
function forwardResponseHeaders(upstreamResp: globalThis.Response, res: ExpressResponse): void {
  upstreamResp.headers.forEach((value, key) => {
    if (!RESPONSE_HOP_BY_HOP.has(key.toLowerCase())) {
      res.setHeader(key, value)
    }
  })
}

/**
 * Handle Anthropic passthrough request — zero format conversion.
 *
 * Proxies the Anthropic request directly to the upstream Anthropic API.
 * For streaming responses, pipes the upstream SSE body directly to the client
 * without parsing or transforming any events.
 *
 * Response headers and status codes are forwarded transparently from upstream.
 */
async function handleAnthropicPassthrough(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions
): Promise<void> {
  const { debug = false, timeoutMs = DEFAULT_TIMEOUT_MS, sdkHeaders, queryString, rawBody, requestModified } = options
  const { url: backendUrl, key: apiKey, model, headers: customHeaders } = config

  // Append SDK query string to upstream URL (e.g., ?beta=true)
  const targetUrl = queryString ? `${backendUrl}?${queryString}` : backendUrl

  // Override model if specified in config
  // This mutates the parsed object, so rawBody can't be used
  const modelOverridden = !!(model && model !== anthropicRequest.model)
  if (model) {
    anthropicRequest.model = model
  }

  const toolCount = anthropicRequest.tools?.length ?? 0
  log.info('RequestHandler', `Anthropic passthrough tools=${toolCount}`)
  log.info('RequestHandler', `POST ${targetUrl} (stream=${anthropicRequest.stream ?? false})`)

  // Use raw body buffer when neither interceptors nor model override modified the request.
  // This avoids a JSON.stringify round-trip — the upstream receives byte-identical body from SDK.
  const canUseRawBody = rawBody && !requestModified && !modelOverridden
  const fetchBody: Buffer | unknown = canUseRawBody ? rawBody : anthropicRequest

  if (debug) {
    log.debug('RequestHandler', `Raw body forwarding: ${canUseRawBody ? 'yes' : 'no (modified)'}`)
  }

  try {
    const upstreamResp = await fetchAnthropicUpstream(
      targetUrl, apiKey, fetchBody, timeoutMs, sdkHeaders, customHeaders
    )
    log.info('RequestHandler', `Anthropic upstream response: ${upstreamResp.status}`)

    // Handle errors — forward upstream response transparently (status + headers + body)
    if (!upstreamResp.ok) {
      const errorText = await upstreamResp.text().catch(() => '')
      log.error('RequestHandler', `Anthropic error ${upstreamResp.status}: ${errorText.slice(0, 200)}`)

      res.status(upstreamResp.status)
      forwardResponseHeaders(upstreamResp, res)
      res.end(errorText)
      return
    }

    // Streaming: pipe upstream body directly to client (zero parsing)
    if (anthropicRequest.stream && upstreamResp.body) {
      // Forward all upstream headers first (request-id, x-ratelimit-*, retry-after, etc.)
      forwardResponseHeaders(upstreamResp, res)
      // Override transport headers for SSE
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      // Pipe the ReadableStream directly — no parsing, no transformation
      const reader = upstreamResp.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          log.error('RequestHandler', `Anthropic stream pipe error: ${err?.message}`)
        }
      } finally {
        res.end()
      }
      return
    }

    // Non-streaming: forward JSON response as-is
    const body = await upstreamResp.text()
    if (debug) {
      log.debug('RequestHandler', `Anthropic response:\n${body.slice(0, 2000)}`)
    }
    forwardResponseHeaders(upstreamResp, res)
    res.end(body)
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      log.error('RequestHandler', 'Anthropic passthrough AbortError (timeout or client disconnect)')
      return sendError(res, 'timeout_error', 'Request timed out')
    }
    log.error('RequestHandler', `Anthropic passthrough error: ${error?.message || error}`)
    return sendError(res, 'api_error', error?.message || 'Internal error')
  }
}

// ============================================================================
// OpenAI Conversion Handler
// ============================================================================

/**
 * Handle OpenAI-compatible request — full format conversion pipeline.
 *
 * Converts Anthropic -> OpenAI, proxies to backend, converts OpenAI -> Anthropic.
 */
async function handleOpenAIConversion(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions
): Promise<void> {
  const { debug = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const { url: backendUrl, key: apiKey, model, headers: customHeaders, apiType: configApiType } = config

  // Validate URL has valid endpoint suffix
  if (!isValidEndpointUrl(backendUrl)) {
    return sendError(res, 'invalid_request_error', getEndpointUrlError(backendUrl))
  }

  // Get API type from URL suffix, or use config override (guaranteed non-null after validation)
  const apiType = configApiType === 'anthropic_passthrough' ? 'chat_completions' : (configApiType || getApiTypeFromUrl(backendUrl)!)

  // Override model if specified in config
  if (model) {
    anthropicRequest.model = model
  }

  if (debug) {
    log.debug('RequestHandler', `Backend: ${backendUrl}`)
    log.debug('RequestHandler', `API Key: ${apiKey.slice(0, 8)}...`)
    log.debug('RequestHandler', `ApiType: ${apiType}`)
  }

  // Use request queue to prevent concurrent requests
  const queueKey = generateQueueKey(backendUrl, apiKey)

  await withRequestQueue(queueKey, async () => {
    try {
      // Determine stream mode
      const forceEnvStream = shouldForceStream()
      const preferStreamByWire = apiType === 'responses' && anthropicRequest.stream === undefined
      let wantStream = forceEnvStream || config.forceStream || preferStreamByWire || anthropicRequest.stream

      // Convert request
      const requestToSend = { ...anthropicRequest, stream: wantStream }
      const openaiRequest = apiType === 'responses'
        ? convertAnthropicToOpenAIResponses(requestToSend).request
        : convertAnthropicToOpenAIChat(requestToSend).request

      const toolCount = (openaiRequest as any).tools?.length ?? 0
      log.info('RequestHandler', `wire=${apiType} tools=${toolCount}`)
      log.info('RequestHandler', `POST ${backendUrl} (stream=${wantStream ?? false})`)

      // Build headers: start with custom headers from config
      const requestHeaders: Record<string, string> = { ...(customHeaders || {}) }

      // Apply provider-specific transformations (e.g., Groq temperature fix, OpenRouter headers)
      const adapter = applyProviderAdapter(
        backendUrl,
        openaiRequest as unknown as Record<string, unknown>,
        requestHeaders
      )
      if (adapter && debug) {
        log.debug('RequestHandler', `Applied provider adapter: ${adapter.name}`)
      }

      // Make upstream request - URL is used directly, no modification
      let upstreamResp = await fetchUpstream(backendUrl, apiKey, openaiRequest, timeoutMs, undefined, requestHeaders)
      log.info('RequestHandler', `Upstream response: ${upstreamResp.status}`)

      // Handle errors - use upstream error type if available, else map from status
      if (!upstreamResp.ok) {
        const errorText = await upstreamResp.text().catch(() => '')
        const { message: errorMessage } = getUpstreamError(upstreamResp.status, errorText)
        const errorType = getErrorTypeFromStatus(upstreamResp.status)
        const retryAfter = upstreamResp.headers.get('retry-after') || undefined
        log.error('RequestHandler', `Provider error ${upstreamResp.status} (${errorType}): ${errorText.slice(0, 200)}`)

        // Check if upstream requires stream=true, retry if needed
        const errorLower = errorText?.toLowerCase() || ''
        const requiresStream = errorLower.includes('stream must be set to true') ||
                               (errorLower.includes('non-stream') && errorLower.includes('not supported'))

        if (requiresStream && !wantStream) {
          log.warn('RequestHandler', 'Upstream requires stream=true, retrying...')

          // Retry with stream enabled
          wantStream = true
          const retryRequest = apiType === 'responses'
            ? convertAnthropicToOpenAIResponses({ ...anthropicRequest, stream: true }).request
            : convertAnthropicToOpenAIChat({ ...anthropicRequest, stream: true }).request

          // Re-apply provider adapter to retry request (reuse same headers)
          applyProviderAdapter(backendUrl, retryRequest as unknown as Record<string, unknown>, requestHeaders)

          upstreamResp = await fetchUpstream(backendUrl, apiKey, retryRequest, timeoutMs, undefined, requestHeaders)

          if (!upstreamResp.ok) {
            const retryErrorText = await upstreamResp.text().catch(() => '')
            const { message: retryErrorMessage } = getUpstreamError(upstreamResp.status, retryErrorText)
            const retryErrorType = getErrorTypeFromStatus(upstreamResp.status)
            const retryAfterRetry = upstreamResp.headers.get('retry-after') || undefined
            log.error('RequestHandler', `Provider error ${upstreamResp.status} (${retryErrorType}): ${retryErrorText.slice(0, 200)}`)
            return sendError(res, retryErrorType, retryErrorMessage, retryAfterRetry)
          }
        } else {
          return sendError(res, errorType, errorMessage, retryAfter)
        }
      }

      // Handle streaming response
      if (wantStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')

        if (apiType === 'responses') {
          await streamOpenAIResponsesToAnthropic(upstreamResp.body, res, anthropicRequest.model, debug)
        } else {
          await streamOpenAIChatToAnthropic(upstreamResp.body, res, anthropicRequest.model, debug)
        }
        return
      }

      // Handle non-streaming response
      const openaiResponse = await upstreamResp.json()
      if (debug) {
        log.debug('RequestHandler', `Response body:\n${JSON.stringify(openaiResponse, null, 2)}`)
      }
      const anthropicResponse = apiType === 'responses'
        ? convertOpenAIResponsesToAnthropic(openaiResponse)
        : convertOpenAIChatToAnthropic(openaiResponse as any, anthropicRequest.model)

      res.json(anthropicResponse)
    } catch (error: any) {
      // Handle abort/timeout
      if (error?.name === 'AbortError') {
        log.error('RequestHandler', 'AbortError (timeout or client disconnect)')
        return sendError(res, 'timeout_error', 'Request timed out')
      }

      log.error('RequestHandler', `Internal error: ${error?.message || error}`)
      return sendError(res, 'api_error', error?.message || 'Internal error')
    }
  })
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Handle messages request — unified entry point for all providers.
 *
 * Flow:
 *   1. Run interceptors on Anthropic-format request (before any conversion)
 *   2. Route to appropriate handler based on apiType:
 *      - anthropic_passthrough: direct proxy, zero conversion
 *      - chat_completions/responses: full OpenAI conversion pipeline
 */
export async function handleMessagesRequest(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions = {}
): Promise<void> {
  const { url: backendUrl, apiType: configApiType } = config
  const { onLog } = options
  const logMsg = `handleMessagesRequest apiType=${configApiType} target=${backendUrl} model=${anthropicRequest.model}`
  log.info('RequestHandler', logMsg)
  onLog?.({ level: 'info', message: logMsg, source: 'request-handler' })

  // Run interceptors on Anthropic-format request (before any conversion)
  const interceptResult = await runInterceptors(
    anthropicRequest,
    { originalModel: anthropicRequest.model, res }
  )

  // If interceptor sent a response, we're done
  if (interceptResult.intercepted && 'responded' in interceptResult) {
    return
  }

  // Use potentially modified request from interceptors
  const request = interceptResult.request

  // Route based on apiType
  if (configApiType === 'anthropic_passthrough') {
    return handleAnthropicPassthrough(request, config, res, {
      ...options,
      requestModified: interceptResult.intercepted
    })
  }

  return handleOpenAIConversion(request, config, res, options)
}

/**
 * Handle token counting request (simple estimation)
 */
export function handleCountTokensRequest(
  messages: unknown,
  system: unknown
): { input_tokens: number } {
  let count = 0

  // Rough estimation: 4 characters ≈ 1 token
  if (system) {
    count += Math.ceil(JSON.stringify(system).length / 4)
  }
  if (messages) {
    count += Math.ceil(JSON.stringify(messages).length / 4)
  }

  return { input_tokens: count }
}
