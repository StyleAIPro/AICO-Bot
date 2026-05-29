/**
 * Extended Services - Deferred Loading
 *
 * These services are loaded AFTER the window is visible.
 * They use lazy initialization - actual initialization happens on first use.
 *
 * GUIDELINES:
 *   - DEFAULT location for all new features
 *   - Services here do NOT block startup
 *   - Use lazy initialization pattern for heavy modules
 *
 * CURRENT SERVICES:
 *   - Background: Process keep-alive, system tray, daemon browser (automation infra)
 *   - Onboarding: First-time user guide (only needed once)
 *   - Remote: Remote access feature (optional)
 *   - Browser: Embedded browser for Content Canvas (V2 feature)
 *   - AIBrowser: AI browser automation tools (V2 feature)
 *   - Overlay: Floating UI elements (optional)
 *   - Search: Global search (optional)
 *   - Performance: Developer monitoring tools (dev only)
 *   - GitBash: Windows Git Bash setup (Windows optional)
 *   - Platform: Store, Scheduler, EventBus, Memory (automation infrastructure)
 *   - Apps: AppManager, AppRuntime (automation App lifecycle)
 */

import { registerOnboardingHandlers } from '../ipc/onboarding';
import { registerRemoteHandlers } from '../ipc/remote';
import { registerRemoteServerHandlers } from '../ipc/remote-server';
import { registerBrowserHandlers } from '../ipc/browser';
import { registerAIBrowserHandlers, cleanupAIBrowserHandlers } from '../ipc/ai-browser';
import { registerOverlayHandlers, cleanupOverlayHandlers } from '../ipc/overlay';
import { initializeSearchHandlers, cleanupSearchHandlers } from '../ipc/search';
import { registerGitBashHandlers, initializeGitBashOnStartup } from '../ipc/git-bash';
import { registerGitHubHandlers } from '../ipc/github';
import { registerGitCodeHandlers } from '../ipc/gitcode';
import { cleanupAllCaches } from '../services/file-watcher/artifact-cache.service';
import { registerKnowledgeBaseHandlers } from '../ipc/knowledge-base';
import { setKnowledgeBaseService } from '../services/knowledge-base';
import { markExtendedServicesReady } from './state';
import { getMainWindow, sendToRenderer } from '../services/window.service';
import { initializeHealthSystem, setSessionCleanupFn } from '../services/health';
import { closeAllV2Sessions } from '../services/agent/session-manager';
import { registerHealthHandlers } from '../ipc/health';
import { initBackground, shutdownBackground, getBackgroundService } from '../platform/background';
import { initStore, shutdownStore } from '../platform/store';
import type { DatabaseManager } from '../platform/store';
import { initScheduler, shutdownScheduler } from '../platform/scheduler';
import {
  initEventBus,
  shutdownEventBus,
  FileWatcherSource,
  WebhookSource,
} from '../platform/event-bus';
import type { WebhookSecretResolver } from '../platform/event-bus';
import { initMemory } from '../platform/memory';
import { registerStoreHandlers } from '../ipc/store';
import { registerSkillHandlers } from '../ipc/skill';
import { registerHyperSpaceHandlers } from '../ipc/hyper-space';
import { cleanupOldLogs } from '../services/log';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app } from 'electron';
import { initRegistryService, shutdownRegistryService } from '../store';
import * as watcherHost from '../services/file-watcher/watcher-host.service';
import { getExpressApp } from '../http/server';
import { getAccessToken } from '../http/auth';
import { initTerminalGateway, shutdownTerminalGateway } from '../services/terminal';
import { initTerminalHistory, shutdownTerminalHistory } from '../services/terminal';
import { getMcpProxy, stopMcpProxy } from '../services/mcp-proxy';

// Module-level reference to db for cleanup
let platformDb: DatabaseManager | null = null;

/**
 * Start the MCP Proxy Server.
 * Exposes aico-bot-apps and gh-search tools via HTTP for remote Claude sessions.
 */
async function startMcpProxy(): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    console.log('[Bootstrap] MCP Proxy: No access token available, skipping startup');
    return;
  }
  const proxy = await getMcpProxy(token);
  console.log(`[Bootstrap] MCP Proxy started on port ${proxy.getPort()}`);
}

/**
 * Normalize a webhook path for matching.
 * Strips leading/trailing slashes and lowercases for consistent comparison.
 */
function normalizeWebhookPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '').toLowerCase();
}

/**
 * Initialize platform (store, scheduler, event-bus, memory) and apps
 * (manager, runtime) modules. Runs asynchronously after extended services
 * are registered, so it does not block startup or the UI.
 *
 * Initialization order (per architecture §8B):
 *   Phase 0: initStore()
 *   Phase 1 (parallel): initScheduler, initEventBus, initMemory
 *   Phase 2: initAppManager
 *   Phase 3: initAppRuntime  (wires everything together)
 *
 * scheduler.start() and eventBus.start() are called after all sources
 * are registered, ensuring no events are missed.
 */
async function initPlatformAndApps(): Promise<void> {
  console.log('[Bootstrap] Platform+Apps initialization starting...');
  const t0 = performance.now();

  // ── Phase 0: Store ──────────────────────────────────────────────────────
  const db = await initStore();
  platformDb = db;

  // Knowledge Base: Wire database connection
  setKnowledgeBaseService(db);

  // ── Phase 1: Platform services (parallel) ───────────────────────────────
  const [scheduler, eventBus, memory, terminalHistory] = await Promise.all([
    initScheduler({ db }),
    Promise.resolve(initEventBus()), // synchronous -- wrapped for uniform parallel pattern
    initMemory(),
    initTerminalHistory(db),
  ]);

  // Wire terminal history store to gateway
  const { terminalGateway } = await import('../services/terminal/terminal-gateway');
  terminalGateway.setHistoryStore(terminalHistory);

  // Get the background service singleton (already initialized by initBackground())
  const background = getBackgroundService();
  if (!background) {
    throw new Error(
      '[Bootstrap] BackgroundService not available -- initBackground() must be called first',
    );
  }

  // ── Wire event-bus sources ──────────────────────────────────────────────
  // FileWatcherSource: bridges watcher-host fs events into the event bus.
  // Uses addFsEventsHandler() (multi-subscriber) so artifact-cache is not displaced.
  // Note: Scheduler events are handled directly by apps/runtime via scheduler.onJobDue(),
  // so no ScheduleBridgeSource is needed (only one subscriber can register at a time).
  const fileWatcherSource = new FileWatcherSource(watcherHost);
  eventBus.registerSource(fileWatcherSource);

  // ── Start timer loops AFTER all wiring is complete ──────────────────────
  scheduler.start();
  eventBus.start();

  const dt = performance.now() - t0;
  console.log(`[Bootstrap] Platform initialized in ${dt.toFixed(1)}ms`);
}

/**
 * Initialize extended services after window is visible
 *
 * Window reference is managed by window.service.ts, no need to pass here.
 *
 * These services are loaded asynchronously and do not block the UI.
 * Heavy modules use lazy initialization - they only fully initialize
 * when their features are first accessed.
 */
export function initializeExtendedServices(): void {
  const start = performance.now();
  console.log('[Bootstrap] Extended services starting...');

  // Get main window for services that still need it directly
  const mainWindow = getMainWindow();

  // === EXTENDED SERVICES ===
  // These services are loaded after the window is visible.
  // New features should be added here by default.

  // Onboarding: First-time user guide, only needed once
  registerOnboardingHandlers();

  // Remote: Remote access feature, optional functionality
  registerRemoteHandlers();

  // Remote Servers: Remote server management
  registerRemoteServerHandlers();

  // Browser: Embedded BrowserView for Content Canvas
  // Note: BrowserView is created lazily when Canvas is opened
  registerBrowserHandlers(mainWindow);

  // AI Browser: AI automation tools (V2 feature)
  // Uses lazy initialization - heavy modules loaded on first tool call
  registerAIBrowserHandlers();

  // Overlay: Floating UI elements (chat capsule, etc.)
  // Already implements lazy initialization internally
  registerOverlayHandlers(mainWindow);

  // Search: Global search functionality
  initializeSearchHandlers();

  // GitBash: Windows Git Bash detection and setup
  registerGitBashHandlers();

  // GitHub: Authentication and git configuration
  registerGitHubHandlers();

  // GitCode: Authentication
  registerGitCodeHandlers();

  // Health: System health monitoring and recovery
  // Register IPC handlers for health queries from renderer
  registerHealthHandlers();

  // Background: Process keep-alive, system tray, daemon browser
  // Provides infrastructure for automation Apps to keep the process alive
  // and access a shared hidden BrowserWindow with stealth injection
  const backgroundService = initBackground();
  backgroundService.initTray();

  // Store: IPC handlers for App Store registry operations
  registerStoreHandlers();

  // Hyper Space: Multi-agent collaboration IPC handlers
  registerHyperSpaceHandlers();

  // Knowledge Base: Personal wiki management
  registerKnowledgeBaseHandlers();

  // Skill: IPC handlers for Skill management
  // Requires only ConversationService
  import('../services/conversation.service')
    .then(({ getConversationService }) => {
      const conversationService = getConversationService();
      if (conversationService) {
        registerSkillHandlers(conversationService);
        console.log('[Bootstrap] Skill handlers registered');
      } else {
        console.warn('[Bootstrap] Skill handlers deferred - ConversationService not ready');
      }
    })
    .catch((err) => {
      console.error('[Bootstrap] Skill handlers registration failed:', err);
    });

  // Terminal Gateway: WebSocket server for shared terminal
  // Allows frontend to receive agent commands and send user commands
  initTerminalGateway();

  // Windows-specific: Initialize Git Bash in background
  if (process.platform === 'win32') {
    initializeGitBashOnStartup()
      .then((status) => {
        console.log('[Bootstrap] Git Bash status:', status);
      })
      .catch((err) => {
        console.error('[Bootstrap] Git Bash initialization failed:', err);
      });
  }

  // Initialize health system asynchronously (non-blocking)
  // This runs startup checks and starts fallback polling
  setSessionCleanupFn(closeAllV2Sessions);
  initializeHealthSystem()
    .then(() => {
      console.log('[Bootstrap] Health system initialized');
    })
    .catch((err) => {
      console.error('[Bootstrap] Health system initialization failed:', err);
    });

  // Platform + Apps: Store, Scheduler, EventBus, Memory, AppManager, AppRuntime
  // Must complete before signaling extended-ready to renderer (knowledge base, etc. depend on it).
  initPlatformAndApps()
    .then(() => {
      // Mark state as ready (for Pull-based queries from renderer)
      markExtendedServicesReady();

      // Notify renderer that extended services are ready (Push-based)
      sendToRenderer('bootstrap:extended-ready', {
        timestamp: Date.now(),
        duration: duration,
      });
      console.log('[Bootstrap] Sent bootstrap:extended-ready to renderer');
    })
    .catch((err) => {
      console.error('[Bootstrap] Platform+Apps initialization failed:', err);
      // Still mark ready so the renderer doesn't hang
      markExtendedServicesReady();
      sendToRenderer('bootstrap:extended-ready', {
        timestamp: Date.now(),
        duration: duration,
      });
    });

  // MCP Proxy Server: Exposes built-in MCP tools (aico-bot-apps, gh-search) via HTTP
  // for remote Claude sessions to connect through SSH tunnels.
  // Non-blocking startup -- starts in background.
  startMcpProxy().catch((err) => {
    console.error('[Bootstrap] MCP Proxy initialization failed:', err);
  });

  const duration = performance.now() - start;
  console.log(`[Bootstrap] Extended services registered in ${duration.toFixed(1)}ms`);

  // Cleanup old log files in background (non-blocking)
  const isDev = process.env.NODE_ENV === 'development';
  const logDir = isDev
    ? join(homedir(), '.aico-bot-dev', 'app-logs')
    : join(app.getPath('userData'), 'app-logs');
  cleanupOldLogs(logDir).catch(() => {});
}

/**
 * Cleanup extended services on app shutdown
 *
 * Called during window-all-closed to properly release resources.
 */
export async function cleanupExtendedServices(): Promise<void> {
  // Store: Shutdown registry service
  shutdownRegistryService();

  // MCP Proxy: Stop the HTTP server
  await stopMcpProxy();

  // Platform: Shutdown event bus and scheduler (stop timers)
  shutdownEventBus();
  await shutdownScheduler().catch((err) =>
    console.error('[Bootstrap] Scheduler shutdown error:', err),
  );

  // Platform: Close database connections
  if (platformDb) {
    await shutdownStore(platformDb).catch((err) =>
      console.error('[Bootstrap] Store shutdown error:', err),
    );
    platformDb = null;
  }

  // Background: Shutdown daemon browser, clear keep-alive, destroy tray
  shutdownBackground();

  // AI Browser: Cleanup MCP server and browser context
  cleanupAIBrowserHandlers();

  // Overlay: Cleanup overlay BrowserView
  cleanupOverlayHandlers();

  // Search: Cancel any ongoing searches
  cleanupSearchHandlers();

  // Terminal History: Flush pending writes before gateway shutdown
  shutdownTerminalHistory();

  // Terminal Gateway: Close WebSocket server
  shutdownTerminalGateway();

  // Artifact Cache: Close file watchers and clear caches
  await cleanupAllCaches();

  console.log('[Bootstrap] Extended services cleaned up');
}
