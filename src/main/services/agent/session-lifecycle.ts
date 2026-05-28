/**
 * Agent Module - Session Lifecycle
 *
 * Manages V2 Session lifecycle including creation, reuse, cleanup,
 * and invalidation on config changes.
 *
 * V2 Session enables process reuse: subsequent messages in the same conversation
 * reuse the running CC process, avoiding process restart each time (cold start ~3-5s).
 */

import path from 'path';
import os from 'os';
import { existsSync, copyFileSync, mkdirSync, readdirSync } from 'fs';
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { getConfig, onApiConfigChange, getCredentialsGeneration } from '../config.service';
import { getConversation, discardPendingWritesForSpace } from '../conversation.service';
import type { V2SDKSession, V2SessionInfo, SessionConfig, SessionState } from './types';
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getEnabledMcpServers,
} from './helpers';
import { registerProcess, getCurrentInstanceId } from '../health';
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config';
import { createAicoBotAppsMcpServer } from '../../apps/conversation-mcp';
import {
  isSessionTransportReady,
  registerProcessExitListener,
  cleanupSession,
  startSessionCleanup,
  stopSessionCleanup,
  clearSessionHealth,
} from './session-health';

// ============================================
// Session Maps
// ============================================

/**
 * Active sessions map: conversationId -> SessionState
 * Tracks in-flight requests with abort controllers and accumulated thoughts
 */
export const activeSessions = new Map<string, SessionState>();

/**
 * V2 Sessions map: conversationId -> V2SessionInfo
 * Persistent sessions that can be reused across multiple messages
 */
export const v2Sessions = new Map<string, V2SessionInfo>();

/**
 * Sessions that should be invalidated after current in-flight request finishes
 * (e.g., model switch during streaming).
 */
const pendingInvalidations = new Set<string>();

// ============================================
// Session Migration
// ============================================

/**
 * Migrate session file from old config directory to new config directory on demand.
 *
 * Background: We changed CLI config directory from ~/.claude/ to
 * ~/Library/Application Support/aico-bot/claude-config/ (via CLAUDE_CONFIG_DIR env)
 * to isolate AICO-Bot from user's own Claude Code configuration.
 *
 * This causes historical conversations to fail because their sessionId points to
 * session files in the old directory. This function migrates session files on demand
 * when user opens a historical conversation.
 *
 * Session file path structure:
 *   $CLAUDE_CONFIG_DIR/projects/<project-dir>/<session-id>.jsonl
 *
 * Project directory naming rule (cross-platform):
 *   Replace all non-alphanumeric characters with '-' (same as Claude Code CLI)
 *   e.g., /Users/fly/Desktop/myproject -> -Users-fly-Desktop-myproject
 *   e.g., /Volumes/one_tb/code2/hello-halo -> -Volumes-one-tb-code2-hello-halo
 *
 * @param workDir - Working directory (used to compute project directory name)
 * @param sessionId - Session ID
 * @returns true if session file exists in new directory (or migration succeeded),
 *          false if not found in either directory
 */
function migrateSessionIfNeeded(workDir: string, sessionId: string): boolean {
  // 1. Compute project directory name using the same rule as Claude Code CLI:
  //    Replace all non-alphanumeric characters with '-'
  const projectDir = workDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionFile = `${sessionId}.jsonl`;

  console.log(`[Agent] Migration check: workDir="${workDir}" -> projectDir="${projectDir}"`);

  // 2. Build old and new paths
  // Note: CLAUDE_CONFIG_DIR is set to ~/.agents/claude-config/ in sdk-config.ts
  // This is the actual path where SDK writes session files
  const newConfigDir = path.join(os.homedir(), '.agents', 'claude-config');
  // Legacy path (used by original Claude Code CLI before AICO-Bot's isolation)
  const oldConfigDir = path.join(os.homedir(), '.claude');

  const newPath = path.join(newConfigDir, 'projects', projectDir, sessionFile);
  const oldPath = path.join(oldConfigDir, 'projects', projectDir, sessionFile);

  console.log(`[Agent] Checking paths:`);
  console.log(`[Agent]   New: ${newPath}`);
  console.log(`[Agent]   Old: ${oldPath}`);

  // 3. Check if already exists in new directory
  if (existsSync(newPath)) {
    console.log(`[Agent] ✓ Session file already exists in new directory: ${sessionId}`);
    return true;
  }

  // 4. Check if exists in old directory
  if (existsSync(oldPath)) {
    // 5. Ensure new project directory exists
    const newProjectDir = path.join(newConfigDir, 'projects', projectDir);
    if (!existsSync(newProjectDir)) {
      mkdirSync(newProjectDir, { recursive: true });
    }

    // 6. Copy file (not move - preserve old directory for user's own Claude Code)
    try {
      copyFileSync(oldPath, newPath);
      console.log(`[Agent] Migrated session file: ${sessionId}`);
      console.log(`[Agent]   From: ${oldPath}`);
      console.log(`[Agent]   To: ${newPath}`);
      return true;
    } catch (error) {
      console.error(`[Agent] Failed to migrate session file: ${sessionId}`, error);
      return false;
    }
  }

  // 7. Scan all project directories for the session file
  //    The SDK may compute a different projectDir (e.g., from the Electron process CWD
  //    rather than the cwd option passed to the SDK). This happens because the CLI
  //    subprocess inherits the parent process CWD and uses it as originalCwd.
  const projectsDir = path.join(newConfigDir, 'projects');
  if (existsSync(projectsDir)) {
    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === projectDir) continue;
        const candidatePath = path.join(projectsDir, entry.name, sessionFile);
        if (existsSync(candidatePath)) {
          // Found it in an unexpected project directory - copy to expected location
          const targetDir = path.join(newConfigDir, 'projects', projectDir);
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
          }
          copyFileSync(candidatePath, newPath);
          console.log(`[Agent] ✓ Found session in unexpected project dir: ${entry.name}`);
          console.log(`[Agent]   Copied from: ${candidatePath}`);
          console.log(`[Agent]   Copied to: ${newPath}`);
          return true;
        }
      }
    } catch (err) {
      console.error('[Agent] Failed to scan project directories:', err);
    }
  }

  console.log(`[Agent] ✗ Session file not found in any directory: ${sessionId}`);
  return false;
}

// ============================================
// Session Config Comparison
// ============================================

/**
 * Check if session config requires rebuild
 * Only "process-level" params need rebuild; runtime params use setXxx() methods
 */
export function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return existing.config.aiBrowserEnabled !== newConfig.aiBrowserEnabled;
}

/**
 * Close and remove an existing V2 session (internal helper for rebuild)
 */
function closeV2SessionForRebuild(conversationId: string): void {
  cleanupSession(conversationId, 'rebuild required');
}

// ============================================
// Session Creation
// ============================================

/**
 * Get or create V2 Session
 *
 * V2 Session enables process reuse: subsequent messages in the same conversation
 * reuse the running CC process, avoiding process restart each time (cold start ~3-5s).
 *
 * Note: Requires SDK patch for full parameter pass-through.
 * When sessionId is provided, CC restores conversation history from disk.
 *
 * @param spaceId - Space ID
 * @param conversationId - Conversation ID
 * @param sdkOptions - SDK options for session creation
 * @param sessionId - Optional session ID for resumption
 * @param config - Session configuration for rebuild detection
 * @param workDir - Working directory (required for session migration when sessionId is provided)
 */
export interface GetOrCreateSessionOptions {
  sdkOptions: Record<string, any>;
  sessionId?: string;
  config?: SessionConfig;
  workDir?: string;
}

export async function getOrCreateV2Session(
  spaceId: string,
  conversationId: string,
  options: GetOrCreateSessionOptions,
): Promise<V2SessionInfo['session']> {
  // Check if we have an existing session for this conversation
  const existing = v2Sessions.get(conversationId);
  if (existing) {
    // CRITICAL: Detect stuck requests from safety-timeout scenario.
    // When user clicks stop and SDK subprocess doesn't respond to interrupt() within 5s,
    // processStream gets stuck in `for await` loop (abort check only triggers on new messages).
    // Frontend's 10s safety timeout then clears isGenerating, allowing a new sendMessage.
    // The old session is still in v2Sessions with a seemingly-ready transport, so
    // getOrCreateV2Session reuses it — creating two concurrent stream consumers.
    // Fix: if activeSessions has an entry with an already-triggered abort signal, the
    // previous processStream is stuck and the session must be force-closed.
    const stuckActive = activeSessions.get(conversationId);
    if (stuckActive && stuckActive.abortController.signal.aborted) {
      console.log(
        `[Agent][${conversationId}] Previous request aborted but stuck, force-closing session`,
      );
      activeSessions.delete(conversationId);
      closeV2SessionForRebuild(conversationId);
      // Fall through to create new session
    } else if (!isSessionTransportReady(existing.session)) {
      // CRITICAL: Check if the underlying process is still alive
      // The CC subprocess may have been killed by OS (OOM, etc.) or crashed,
      // but our v2Sessions Map still holds a reference to the dead session.
      // We must check SDK's transport state (Single Source of Truth) before reusing.
      console.log(
        `[Agent][${conversationId}] Session transport not ready (process dead), recreating...`,
      );
      closeV2SessionForRebuild(conversationId);
      // Fall through to create new session
    } else if ((existing.session as any).closed) {
      // CRITICAL: Check SDK's closed flag — the session may have been closed by
      // abortController.abort() or SDK internal error without calling closeV2SessionForRebuild(),
      // leaving a stale entry with closed=true.
      console.log(`[Agent][${conversationId}] Session closed flag set, recreating...`);
      closeV2SessionForRebuild(conversationId);
      // Fall through to create new session
    } else {
      // Check if credentials have changed since session was created
      // This catches race conditions where session was created with stale credentials
      // (e.g., warm-up started before config save completed)
      const currentGen = getCredentialsGeneration();
      const needsCredentialRebuild = existing.credentialsGeneration !== currentGen;
      const needsConfigRebuild = options.config && needsSessionRebuild(existing, options.config);

      if (needsCredentialRebuild || needsConfigRebuild) {
        // If a request is in flight for this conversation, defer rebuild to avoid
        // killing the active session (same strategy as invalidateAllSessions)
        if (activeSessions.has(conversationId)) {
          const reason = needsCredentialRebuild
            ? `credentials (gen ${existing.credentialsGeneration} → ${currentGen})`
            : `config (aiBrowser: ${existing.config.aiBrowserEnabled} → ${options.config!.aiBrowserEnabled})`;
          console.log(
            `[Agent][${conversationId}] ${reason} changed but request in flight, deferring rebuild`,
          );
          pendingInvalidations.add(conversationId);
          existing.lastUsedAt = Date.now();
          return existing.session;
        }

        if (needsCredentialRebuild) {
          console.log(
            `[Agent][${conversationId}] Credentials changed (gen ${existing.credentialsGeneration} → ${currentGen}), recreating session`,
          );
        } else {
          console.log(
            `[Agent][${conversationId}] Config changed (aiBrowser: ${existing.config.aiBrowserEnabled} → ${options.config!.aiBrowserEnabled}), rebuilding session...`,
          );
        }
        closeV2SessionForRebuild(conversationId);
        // Fall through to create new session
      } else {
        // Session is alive and config is compatible, reuse it
        console.log(`[Agent][${conversationId}] Reusing existing V2 session`);
        existing.lastUsedAt = Date.now();
        return existing.session;
      }
    }
  }

  // Create new session
  // If sessionId exists, pass resume to let CC restore history from disk
  // After first message, the process stays alive and maintains context in memory
  console.log(`[Agent][${conversationId}] Creating new V2 session...`);

  // Handle session resumption with migration support
  let effectiveSessionId = options.sessionId;
  if (options.sessionId && options.workDir) {
    // Attempt to migrate session file from old config directory if needed
    const sessionExists = migrateSessionIfNeeded(options.workDir, options.sessionId);
    if (sessionExists) {
      console.log(`[Agent][${conversationId}] With resume: ${options.sessionId}`);
    } else {
      // Session file not found in either directory - start fresh conversation
      console.log(
        `[Agent][${conversationId}] Session ${options.sessionId} not found, starting fresh conversation`,
      );
      effectiveSessionId = undefined;
    }
  } else if (options.sessionId) {
    console.log(`[Agent][${conversationId}] With resume: ${options.sessionId}`);
  }
  const startTime = Date.now();

  // Requires SDK patch: resume parameter lets CC restore history from disk
  // Native SDK V2 Session doesn't support resume parameter
  if (effectiveSessionId) {
    options.sdkOptions.resume = effectiveSessionId;
  }
  // Requires SDK patch: native SDK ignores most sdkOptions parameters
  // Use 'as any' to bypass type check, actual params handled by patched SDK
  const session = (await unstable_v2_createSession(
    options.sdkOptions as any,
  )) as unknown as V2SDKSession;

  // WORKAROUND: V2 Session constructor does not register in-process SDK MCP server instances
  // into the Query layer. It only passes mcpServers to the CLI subprocess config.
  // The CLI subprocess tries to connect but finds no transport handler → all MCP servers fail.
  // Fix: manually call setMcpServers() to properly register SDK MCP server instances.
  if (options.sdkOptions.mcpServers && Object.keys(options.sdkOptions.mcpServers).length > 0) {
    try {
      const query = (session as any).query;
      if (query && typeof query.setMcpServers === 'function') {
        await query.setMcpServers(options.sdkOptions.mcpServers);
        console.log(
          `[Agent][${conversationId}] SDK MCP servers registered via setMcpServers: ${Object.keys(options.sdkOptions.mcpServers).join(', ')}`,
        );
      } else {
        console.warn(
          `[Agent][${conversationId}] V2 session has no setMcpServers method, SDK MCP servers may not work`,
        );
      }
    } catch (err) {
      console.error(`[Agent][${conversationId}] Failed to register SDK MCP servers:`, err);
    }
  }

  // Log PID for health system verification (via SDK patch)
  const pid = (session as any).pid;
  console.log(
    `[Agent][${conversationId}] V2 session created in ${Date.now() - startTime}ms, PID: ${pid ?? 'unavailable'}`,
  );

  // Register with health system for orphan detection
  const instanceId = getCurrentInstanceId();
  if (instanceId) {
    registerProcess({
      id: conversationId,
      pid: pid ?? null,
      type: 'v2-session',
      instanceId,
      startedAt: Date.now(),
    });
  }

  // Register process exit listener for immediate cleanup
  // This is event-driven (better than polling) - when process dies, we clean up immediately
  registerProcessExitListener(session, conversationId);

  // Store session with config and current credentials generation
  // Generation is used to detect stale credentials on session reuse
  v2Sessions.set(conversationId, {
    session,
    spaceId,
    conversationId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    config: options.config || { aiBrowserEnabled: false },
    credentialsGeneration: getCredentialsGeneration(),
  });

  // Start cleanup if not already running
  startSessionCleanup();

  return session;
}

// ============================================
// Session Warm-up
// ============================================

/**
 * Warm up V2 Session (called when user switches conversations)
 *
 * Pre-initialize or reuse V2 Session to avoid delay when sending messages.
 * Frontend calls this when user clicks a conversation, no need to wait for completion.
 *
 * Flow:
 * 1. User clicks conversation A -> frontend immediately calls ensureSessionWarm()
 * 2. V2 Session initializes in background (non-blocking UI)
 * 3. User finishes typing and sends -> V2 Session ready, send directly (fast)
 *
 * Important: Parameters must be identical to sendMessage for session reliability
 */
export async function ensureSessionWarm(spaceId: string, conversationId: string): Promise<void> {
  const config = getConfig();
  const workDir = getWorkingDir(spaceId);
  const conversation = getConversation(spaceId, conversationId);
  const sessionId = conversation?.sessionId;
  const electronPath = getHeadlessElectronPath();

  // Create abortController - consistent with sendMessage
  const abortController = new AbortController();

  // Get API credentials and resolve for SDK use
  const credentials = await getApiCredentials(config);
  console.log(`[Agent] Session warm using: ${credentials.provider}, model: ${credentials.model}`);

  // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
  const resolvedCredentials = await resolveCredentialsForSdk(credentials);

  // Get enabled MCP servers
  const enabledMcpServers = getEnabledMcpServers(config.mcpServers || {});

  // Build MCP servers config (must match sendMessage to avoid session rebuild)
  const mcpServers: Record<string, any> = enabledMcpServers ? { ...enabledMcpServers } : {};
  mcpServers['aico-bot-apps'] = createAicoBotAppsMcpServer(spaceId);

  // Build SDK options using shared configuration
  const sdkOptions = buildBaseSdkOptions({
    credentials: resolvedCredentials,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    abortController,
    stderrHandler: (data: string) => {
      console.error(`[Agent][${conversationId}] CLI stderr (warm):`, data);
    },
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
    maxTurns: config.agent?.maxTurns,
    contextWindow: resolvedCredentials.contextWindow,
  });

  try {
    console.log(`[Agent] Warming up V2 session: ${conversationId}`);
    await getOrCreateV2Session(spaceId, conversationId, { sdkOptions, sessionId, workDir });
    console.log(`[Agent] V2 session warmed up: ${conversationId}`);
  } catch (error) {
    console.error(`[Agent] Failed to warm up session ${conversationId}:`, error);
    // Don't throw on warm-up failure, sendMessage() will reinitialize (just slower)
  }
}

// ============================================
// Session Lifecycle
// ============================================

/**
 * Close V2 session for a conversation
 */
export function closeV2Session(conversationId: string): void {
  cleanupSession(conversationId, 'explicit close');
}

/**
 * Wait for a SDK subprocess to exit by polling its PID.
 * On Windows, file handles are not released until the process fully exits,
 * so we must wait before deleting the space directory.
 */
async function waitForSessionExit(
  conversationId: string,
  pid: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // Signal 0 = check if process exists (no-op)
      // Process still alive, wait and retry
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // Process no longer exists
      console.log(`[Agent][${conversationId}] Process ${pid} exited (${Date.now() - start}ms)`);
      return;
    }
  }
  // Timeout — force kill
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`[Agent][${conversationId}] Force killed process ${pid} after timeout`);
  } catch {
    // Process already dead
  }
}

/**
 * Close all V2 sessions belonging to a specific space (for space deletion).
 * Also aborts any in-flight requests and cleans up activeSessions entries
 * that may not have a corresponding v2Session (e.g. transient sessions).
 *
 * Returns a Promise that resolves when all subprocesses have exited,
 * ensuring file handles are released for directory deletion on Windows.
 */
export async function closeSessionsBySpaceId(spaceId: string): Promise<void> {
  const toClose: string[] = [];

  // Collect V2 sessions for this space
  for (const [convId, info] of v2Sessions) {
    if (info.spaceId === spaceId) {
      toClose.push(convId);
    }
  }

  // Also collect active sessions (in-flight requests) that belong to this space
  // but may not have a V2 session entry yet
  const activeToClean: string[] = [];
  for (const [convId, state] of activeSessions) {
    if (state.spaceId === spaceId && !toClose.includes(convId)) {
      activeToClean.push(convId);
    }
  }

  if (toClose.length > 0) {
    console.log(`[Agent] Closing ${toClose.length} session(s) for space ${spaceId}`);
    // Collect PIDs before cleanup removes session info from map
    const pids: Array<{ convId: string; pid: number }> = [];
    for (const convId of toClose) {
      const info = v2Sessions.get(convId);
      const pid = (info?.session as any)?.pid;
      if (pid) {
        pids.push({ convId, pid });
      }
      cleanupSession(convId, 'space deletion');
      activeSessions.delete(convId);
    }
    // Wait for all subprocesses to exit (Windows needs this for file handle release)
    await Promise.all(pids.map(({ convId, pid }) => waitForSessionExit(convId, pid)));
  }

  if (activeToClean.length > 0) {
    console.log(`[Agent] Aborting ${activeToClean.length} active request(s) for space ${spaceId}`);
    for (const convId of activeToClean) {
      const state = activeSessions.get(convId);
      if (state?.abortController && !state.abortController.signal.aborted) {
        state.abortController.abort();
      }
      activeSessions.delete(convId);
    }
  }

  // Discard any pending debounced conversation index writes for this space.
  // This prevents stale writes from firing after the space directory is deleted.
  discardPendingWritesForSpace(spaceId);
}

/**
 * Close all V2 sessions (for app shutdown)
 */
export function closeAllV2Sessions(): void {
  const count = v2Sessions.size;
  console.log(`[Agent] Closing all ${count} V2 sessions`);

  for (const convId of Array.from(v2Sessions.keys())) {
    cleanupSession(convId, 'app shutdown');
  }

  stopSessionCleanup();
}

/**
 * Mark a single V2 session for recreation on next use.
 * The session is closed when the current in-flight request finishes
 * (via unregisterActiveSession) or immediately if no request is in flight.
 */
export function invalidateSession(conversationId: string): void {
  if (activeSessions.has(conversationId)) {
    // Defer until the current request finishes
    pendingInvalidations.add(conversationId);
    console.log(`[Agent] Session marked for recreation (deferred): ${conversationId}`);
  } else {
    // No active request, close immediately
    closeV2Session(conversationId);
    console.log(`[Agent] Session closed for recreation: ${conversationId}`);
  }
}

/**
 * Invalidate all V2 sessions.
 * Sessions are closed immediately, but users are not interrupted.
 * New sessions will be created with updated config on next message.
 */
export function invalidateAllSessions(): void {
  const count = v2Sessions.size;
  if (count === 0) {
    console.log('[Agent] No active sessions to invalidate');
    return;
  }

  console.log(`[Agent] Invalidating ${count} sessions due to API config change`);

  for (const convId of Array.from(v2Sessions.keys())) {
    // If a request is in flight, defer closing until it finishes
    if (activeSessions.has(convId)) {
      pendingInvalidations.add(convId);
      console.log(`[Agent] Deferring session close until idle: ${convId}`);
      continue;
    }

    cleanupSession(convId, 'API config change');
  }

  console.log('[Agent] All sessions invalidated, will use new config on next message');
}

// ============================================
// Active Session State
// ============================================

/**
 * Create a new active session state
 */
export function createSessionState(
  spaceId: string,
  conversationId: string,
  abortController: AbortController,
): SessionState {
  return {
    abortController,
    spaceId,
    conversationId,
    thoughts: [],
  };
}

/**
 * Register an active session
 */
export function registerActiveSession(conversationId: string, state: SessionState): void {
  activeSessions.set(conversationId, state);
}

/**
 * Unregister an active session
 */
export function unregisterActiveSession(conversationId: string): void {
  activeSessions.delete(conversationId);

  if (pendingInvalidations.has(conversationId)) {
    pendingInvalidations.delete(conversationId);
    closeV2Session(conversationId);
  }
}

/**
 * Get an active session by conversation ID
 */
export function getActiveSession(conversationId: string): SessionState | undefined {
  return activeSessions.get(conversationId);
}

// ============================================
// Config Change Handler Registration
// ============================================

// Register for API config change notifications
// This is called once when the module loads
onApiConfigChange(() => {
  invalidateAllSessions();
});

// ============================================
// Manual Context Compression
// ============================================

/**
 * Manually trigger context compression for a conversation
 * This forces the SDK to compact the conversation history to reduce token usage
 *
 * @param conversationId - Conversation ID to compact
 * @returns true if compression was triggered, false if session not found or not supported
 */
export async function compactContext(
  conversationId: string,
): Promise<{ success: boolean; error?: string }> {
  const sessionInfo = v2Sessions.get(conversationId);
  if (!sessionInfo) {
    console.log(`[Agent][${conversationId}] No session found for manual compact`);
    return { success: false, error: 'No active session. Please send a message first.' };
  }

  try {
    console.log(`[Agent][${conversationId}] Manually compacting context...`);

    const session = sessionInfo.session;

    // Use the SDK's compact method (added via SDK patch)
    if (typeof session.compact === 'function') {
      const result = await session.compact();
      if (result.compacted) {
        console.log(`[Agent][${conversationId}] Context compacted successfully`, {
          preCompactTokenCount: result.preCompactTokenCount,
          postCompactTokenCount: result.postCompactTokenCount,
        });
        return { success: true };
      } else {
        console.log(`[Agent][${conversationId}] Compact skipped: threshold not met`);
        return {
          success: false,
          error: 'Context is not large enough to compress. The SDK auto-compacts when needed.',
        };
      }
    } else {
      // Fallback: close and recreate session to clear context
      console.log(
        `[Agent][${conversationId}] SDK compact not available, recreating session to clear context`,
      );
      cleanupSession(conversationId, 'manual compact');
      clearSessionHealth(conversationId);
      return { success: true };
    }
  } catch (error) {
    console.error(`[Agent][${conversationId}] Manual compact failed:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
