/**
 * Proxy-aware fetch wrapper
 *
 * All main-process outgoing HTTP requests should use this function
 * instead of native fetch, so proxy settings are applied automatically.
 *
 * Implementation: uses Node.js native `https`/`http` modules with manual
 * CONNECT tunnel for HTTPS proxies. This avoids undici.ProxyAgent which
 * requires node:sqlite (unavailable in Electron's bundled Node).
 *
 * For proxies that require Negotiate/NTLM (Windows SSPI) authentication,
 * falls back to curl.exe subprocess which handles the auth handshake natively.
 */

import https from 'node:https';
import http from 'node:http';
import type net from 'node:net';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { getEffectiveProxyUrl } from './proxy-agent';
import { createLogger } from '../log';

const logger = createLogger('Proxy');

/**
 * Custom error for proxy CONNECT handshake failures.
 * Distinguished from transient network errors so the router can return
 * a non-retryable HTTP status (400) instead of 500, preventing the SDK
 * from entering a retry loop that wastes ~250 seconds.
 */
export class ProxyConnectError extends Error {
  readonly name = 'ProxyConnectError';

  constructor(
    public readonly statusCode: number | null,
    public readonly targetUrl: string,
    public readonly proxyHost: string,
    message: string,
  ) {
    super(message);
  }
}

/** Default timeout for fetch calls (ms). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Timeout for the CONNECT handshake phase with the proxy (ms). */
const CONNECT_PHASE_TIMEOUT_MS = 10_000;

/**
 * In-memory cache of proxy origins that require Negotiate/NTLM auth.
 * After the first 407 detection, subsequent requests to the same proxy
 * skip the wasted CONNECT round-trip and go directly to curl.
 */
const negotiateProxyCache = new Set<string>();

/**
 * Extract a normalized origin key from a proxy URL for cache lookup.
 * Strips credentials and path, returns "hostname:port".
 */
function extractProxyOrigin(proxyUrl: string): string {
  const proxy = new URL(proxyUrl);
  const port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
  return `${proxy.hostname}:${port}`;
}

/**
 * Check if a 407 proxy response indicates Negotiate or NTLM auth challenge.
 * Returns 'negotiate', 'ntlm', or null.
 */
function detectProxyAuthChallenge(headers: http.IncomingHttpHeaders): 'negotiate' | 'ntlm' | null {
  const proxyAuth = headers['proxy-authenticate'];
  if (!proxyAuth) return null;

  const challenges: string[] = Array.isArray(proxyAuth) ? proxyAuth : [proxyAuth];
  for (const challenge of challenges) {
    const lower = challenge.toLowerCase();
    if (lower.startsWith('negotiate')) return 'negotiate';
    if (lower.startsWith('ntlm')) return 'ntlm';
  }
  return null;
}

/**
 * Parse raw HTTP response text (from `curl -i`) into a Web Response object.
 * Splits on the first blank line (`\r\n\r\n` or `\n\n`) to separate headers from body.
 */
function parseCurlResponse(rawOutput: string): Response {
  // curl -i may output multiple HTTP responses during auth negotiation
  // (e.g., 407 challenge followed by 200 OK). Find the LAST response.
  const lastHttpIndex = rawOutput.lastIndexOf('HTTP/');
  const responseText = lastHttpIndex !== -1 ? rawOutput.substring(lastHttpIndex) : rawOutput;

  let headerEnd = responseText.indexOf('\r\n\r\n');
  let body: string;
  let headerSection: string;

  if (headerEnd !== -1) {
    headerSection = responseText.substring(0, headerEnd);
    body = responseText.substring(headerEnd + 4);
  } else {
    headerEnd = responseText.indexOf('\n\n');
    if (headerEnd !== -1) {
      headerSection = responseText.substring(0, headerEnd);
      body = responseText.substring(headerEnd + 2);
    } else {
      headerSection = responseText;
      body = '';
    }
  }

  const headerLines = headerSection.split(/\r?\n/);
  if (headerLines.length === 0) {
    return new Response(body, { status: 0, statusText: 'Empty curl response' });
  }

  const statusLine = headerLines[0];
  const statusMatch = statusLine.match(/^HTTP\/[\d.]+ (\d{3})(?: (.*))?$/i);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const statusText = statusMatch?.[2] || '';

  const headers = new Headers();
  for (let i = 1; i < headerLines.length; i++) {
    const line = headerLines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const name = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (name) {
        headers.append(name, value);
      }
    }
  }

  return new Response(body, { status, statusText, headers });
}

/**
 * Execute a request via curl.exe subprocess with SSPI (Negotiate/NTLM) auth.
 * Used as fallback when a proxy returns 407 with Negotiate/NTLM challenge.
 */
function fetchViaCurl(
  targetUrl: string,
  init: RequestInit | undefined,
  proxyUrl: string,
  authScheme: 'negotiate' | 'ntlm',
  timeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const connectTimeout = Math.floor(timeoutMs / 1000);
    const args: string[] = [
      '-s',
      '-i',
      '--connect-timeout',
      String(connectTimeout),
      '--max-time',
      String(connectTimeout),
      '-k',
      '--ssl-no-revoke',
      '-x',
      proxyUrl,
    ];

    // SSPI auth — -u : tells curl to use Windows credentials automatically
    if (authScheme === 'negotiate') {
      args.push('--negotiate', '-u', ':');
    } else {
      args.push('--ntlm', '-u', ':');
    }

    // HTTP method
    const method = init?.method || 'GET';
    if (method !== 'GET') {
      args.push('-X', method);
    }

    // Custom headers
    if (init?.headers) {
      const hdrs = init.headers as Record<string, string>;
      for (const [key, value] of Object.entries(hdrs)) {
        if (typeof value === 'string') {
          args.push('-H', `${key}: ${value}`);
        }
      }
    }

    // Request body
    if (init?.body) {
      const bodyStr = Buffer.isBuffer(init.body)
        ? init.body.toString('utf-8')
        : typeof init.body === 'string'
          ? init.body
          : String(init.body);
      args.push('-d', bodyStr);
    }

    // Target URL (always last)
    args.push(targetUrl);

    const proc = spawn('curl.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs + 5000,
    });

    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`curl.exe failed to start: ${err.message}`));
    });

    proc.on('close', (code: number) => {
      if (code !== 0) {
        const errMsg = stderrBuf.trim() || `curl exited with code ${code}`;
        reject(new Error(`Proxy (SSPI) request failed: ${errMsg}`));
        return;
      }
      if (!stdoutBuf) {
        reject(new Error('Proxy (SSPI) request returned empty response'));
        return;
      }
      try {
        resolve(parseCurlResponse(stdoutBuf));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to parse curl response: ${msg}`));
      }
    });
  });
}

/**
 * Make an HTTP/HTTPS request through an HTTP proxy using CONNECT tunneling.
 * Falls back to curl.exe when the proxy requires Negotiate/NTLM authentication.
 */
function fetchViaProxy(
  targetUrl: string,
  init?: RequestInit,
  proxyUrl: string,
  timeoutMs: number,
): Promise<Response> {
  // If this proxy is known to require SSPI auth, skip CONNECT and use curl directly
  const proxyOrigin = extractProxyOrigin(proxyUrl);
  if (negotiateProxyCache.has(proxyOrigin)) {
    logger.info(`Proxy ${proxyOrigin} requires SSPI auth, using curl directly`);
    return fetchViaCurl(targetUrl, init, proxyUrl, 'negotiate', timeoutMs);
  }

  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    const isHttps = target.protocol === 'https:';
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s: ${targetUrl}`));
    }, timeoutMs);

    // If external signal already aborted, bail out immediately
    if (init?.signal?.aborted) {
      clearTimeout(timeout);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const proxyHeaders: Record<string, string> = {
      Host: `${target.hostname}:${target.port || (isHttps ? 443 : 80)}`,
    };
    if (proxy.username) {
      proxyHeaders['Proxy-Authorization'] =
        `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
    }

    const proxyReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || (isHttps ? 443 : 80)}`,
      headers: proxyHeaders,
    });

    const req = proxyReq;

    // Shorter timeout for the CONNECT handshake phase
    const connectTimer = setTimeout(() => {
      req.destroy();
      reject(
        new ProxyConnectError(
          null,
          targetUrl,
          `${proxy.hostname}:${proxy.port || 80}`,
          `Proxy connection timed out after ${CONNECT_PHASE_TIMEOUT_MS / 1000}s: ${proxy.hostname}:${proxy.port || 80}`,
        ),
      );
    }, CONNECT_PHASE_TIMEOUT_MS);

    proxyReq.on('connect', (res: http.IncomingMessage, socket: net.Socket, _head: Buffer) => {
      // Check CONNECT response — proxy must return 200 to establish tunnel
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        clearTimeout(connectTimer);

        // Detect Negotiate/NTLM auth challenge and fall back to curl
        if (res.statusCode === 407) {
          const authScheme = detectProxyAuthChallenge(res.headers);
          if (authScheme) {
            negotiateProxyCache.add(proxyOrigin);
            logger.info(`Proxy 407 with ${authScheme} auth, falling back to curl`);
            // Drain the 407 response body, then delegate to curl
            res.on('data', () => {});
            res.on('end', () => {
              fetchViaCurl(targetUrl, init, proxyUrl, authScheme, timeoutMs)
                .then(resolve)
                .catch(reject);
            });
            return;
          }
        }

        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        logger.warn(`Proxy CONNECT failed (${res.statusCode}) to ${target.hostname}`);
        res.on('end', () => {
          reject(
            new ProxyConnectError(
              res.statusCode ?? null,
              targetUrl,
              `${proxy.hostname}:${proxy.port || 80}`,
              `Proxy CONNECT failed (${res.statusCode}): ${body.trim() || targetUrl}`,
            ),
          );
        });
        return;
      }

      clearTimeout(connectTimer);
      logger.info(`CONNECT tunnel established to ${target.hostname} via ${proxy.hostname}`);

      if (isHttps) {
        // Merge any early data from the tunnel into the TLS socket
        const tlsReq = https.request(
          {
            host: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: init?.method || 'GET',
            headers: init?.headers as Record<string, string>,
            socket,
            agent: false,
            rejectUnauthorized: false,
          },
          (tlsRes) => {
            clearTimeout(timeout);
            resolve(convertNodeResponse(tlsRes));
          },
        );
        tlsReq.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
        if (init?.body) {
          const bodyData = Buffer.isBuffer(init.body)
            ? init.body
            : typeof init.body === 'string'
              ? init.body
              : String(init.body);
          tlsReq.write(bodyData);
        }
        tlsReq.end();
      } else {
        const httpReq = http.request(
          {
            host: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: init?.method || 'GET',
            headers: init?.headers as Record<string, string>,
            socket,
            agent: false,
          },
          (httpRes) => {
            clearTimeout(timeout);
            resolve(convertNodeResponse(httpRes));
          },
        );
        httpReq.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
        if (init?.body) {
          const bodyData = Buffer.isBuffer(init.body)
            ? init.body
            : typeof init.body === 'string'
              ? init.body
              : String(init.body);
          httpReq.write(bodyData);
        }
        httpReq.end();
      }
    });

    proxyReq.on('error', (err: Error) => {
      clearTimeout(timeout);
      clearTimeout(connectTimer);
      reject(
        new ProxyConnectError(
          null,
          targetUrl,
          `${proxy.hostname}:${proxy.port || 80}`,
          err.message,
        ),
      );
    });

    // Forward external AbortSignal
    const onExternalAbort = () => {
      clearTimeout(timeout);
      clearTimeout(connectTimer);
      req.destroy();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    init?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    // Clean up timers and external signal listener when the request settles
    proxyReq.on('close', () => {
      clearTimeout(timeout);
      clearTimeout(connectTimer);
      init?.signal?.removeEventListener('abort', onExternalAbort);
    });

    proxyReq.end();
  });
}

/**
 * Convert a Node.js http.IncomingMessage to a Web Response-like object.
 */
function convertNodeResponse(nodeRes: http.IncomingMessage): Response {
  const status = nodeRes.statusCode || 200;
  const statusText = nodeRes.statusMessage || '';
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeRes.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.append(key, value);
      }
    }
  }

  // Collect body chunks
  const chunks: Buffer[] = [];
  nodeRes.on('data', (chunk: Buffer) => chunks.push(chunk));

  return new Response(
    new ReadableStream({
      start(controller) {
        nodeRes.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        nodeRes.on('end', () => controller.close());
        nodeRes.on('error', (err: Error) => controller.error(err));
      },
    }),
    { status, statusText, headers },
  );
}

/**
 * Fetch through a specific proxy URL (for testing).
 * Bypasses config — always routes through the given proxyUrl.
 */
export async function proxyFetchWithUrl(
  url: string,
  init: RequestInit | undefined,
  proxyUrl: string,
  timeoutMs: number,
): Promise<Response> {
  return fetchViaProxy(url, init, proxyUrl, timeoutMs);
}

/**
 * Fetch with automatic proxy support.
 * When a proxy is configured and enabled, routes through the proxy.
 * Otherwise, uses native fetch (direct connection).
 *
 * @param forceNoProxy - If true, skip proxy and use direct connection even if proxy is configured.
 */
export async function proxyFetch(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
  forceNoProxy = false,
): Promise<Response> {
  const timeout = timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const effectiveProxyUrl = forceNoProxy ? undefined : getEffectiveProxyUrl();
  const method = init?.method || 'GET';
  const startTime = Date.now();

  logger.info(
    `${method} ${url} via=${effectiveProxyUrl ? `proxy(${effectiveProxyUrl})` : 'direct'} timeout=${timeout}ms`,
  );

  if (effectiveProxyUrl) {
    const response = await fetchViaProxy(url, init, effectiveProxyUrl, timeout);
    logger.info(`Response ${response.status} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
    return response;
  }

  // No proxy — use native fetch with timeout
  // When forceNoProxy, temporarily set NO_PROXY=* to bypass any env-var proxies
  // (equivalent to curl --noproxy "*")
  const prevNoProxy = process.env.NO_PROXY;
  const prevNoProxyLower = process.env.no_proxy;
  if (forceNoProxy) {
    process.env.NO_PROXY = '*';
    process.env.no_proxy = '*';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // If external signal already aborted, bail out immediately
  if (init?.signal?.aborted) {
    clearTimeout(timer);
    if (forceNoProxy) restoreNoProxy();
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  // Forward external signal to our internal controller
  const onExternalAbort = () => controller.abort();
  init?.signal?.addEventListener('abort', onExternalAbort, { once: true });

  function restoreNoProxy() {
    if (prevNoProxy !== undefined) process.env.NO_PROXY = prevNoProxy;
    else delete process.env.NO_PROXY;
    if (prevNoProxyLower !== undefined) process.env.no_proxy = prevNoProxyLower;
    else delete process.env.no_proxy;
  }

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    logger.info(`Response ${response.status} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout / 1000}s: ${url}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', onExternalAbort);
    if (forceNoProxy) restoreNoProxy();
  }
}
