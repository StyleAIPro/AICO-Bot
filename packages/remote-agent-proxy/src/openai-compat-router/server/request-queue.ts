/**
 * Request Queue — Semaphore with wait timeout
 *
 * Limits concurrent requests per backend (keyed by backendUrl + apiKey).
 * Replaces the previous mutex (1 concurrent) with a configurable semaphore
 * to allow sub-agent parallelism while preventing rate limit saturation.
 */

interface Waiter<T> {
  fn: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
  enqueuedAt: number
}

interface QueueState {
  running: number
  waiting: Array<Waiter<unknown>>
}

const requestQueues = new Map<string, QueueState>()

const MAX_CONCURRENT_PER_KEY = Number(process.env.ROUTER_MAX_CONCURRENT_REQUESTS) || 3
const QUEUE_WAIT_TIMEOUT_MS = 30_000

/**
 * Execute a function with concurrency-limited queue protection.
 *
 * Allows up to MAX_CONCURRENT_PER_KEY concurrent requests per key.
 * Excess requests wait up to QUEUE_WAIT_TIMEOUT_MS before rejecting.
 */
export async function withRequestQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const limit = MAX_CONCURRENT_PER_KEY

  let queue = requestQueues.get(key)
  if (!queue) {
    queue = { running: 0, waiting: [] }
    requestQueues.set(key, queue)
  }

  // Concurrent slot available — execute immediately
  if (queue.running < limit) {
    queue.running++
    try {
      return await fn()
    } finally {
      releaseSlot(key, queue)
    }
  }

  // No slot available — enqueue with timeout
  return new Promise<T>((resolve, reject) => {
    queue!.waiting.push({ fn, resolve, reject, enqueuedAt: Date.now() })
  })
}

function releaseSlot(key: string, queue: QueueState): void {
  queue.running--
  drainWaiting(key, queue)
}

function drainWaiting(key: string, queue: QueueState): void {
  while (queue.waiting.length > 0 && queue.running < MAX_CONCURRENT_PER_KEY) {
    const waiter = queue.waiting.shift()!

    // Reject if waited too long
    if (Date.now() - waiter.enqueuedAt > QUEUE_WAIT_TIMEOUT_MS) {
      waiter.reject(new Error(`Request queue timeout: waited >${QUEUE_WAIT_TIMEOUT_MS / 1000}s for ${key}`))
      continue
    }

    queue.running++
    // Execute the stored function
    waiter.fn()
      .then(waiter.resolve)
      .catch(waiter.reject)
      .finally(() => releaseSlot(key, queue))
  }
}

/**
 * Generate a queue key from backend URL and API key
 */
export function generateQueueKey(backendUrl: string, apiKey: string): string {
  return `${backendUrl}:${apiKey.slice(0, 16)}`
}

/**
 * Clear all pending requests (for testing)
 */
export function clearRequestQueues(): void {
  requestQueues.clear()
}

/**
 * Get the number of pending requests (for monitoring)
 */
export function getPendingRequestCount(): number {
  return requestQueues.size
}
