/**
 * AICO-Bot - Electron Main Process
 * The main entry point for the Electron application
 */

// ========================================
// V8 HEAP SIZE (MUST be the very first thing)
// ========================================
// Knowledge base extraction processes large documents via LLM, which can exceed
// the default ~2GB V8 heap limit. Set 4GB before anything else runs.
import v8 from 'node:v8';
v8.setFlagsFromString('--max-old-space-size=4096 --expose-gc');

// ========================================
// LOGGING INITIALIZATION (must be first)
// ========================================
// Initialize electron-log before any other code to capture all logs
// This replaces console.log/warn/error globally with electron-log
// Logs are written to: ~/Library/Logs/AICO-Bot/ (macOS), %USERPROFILE%\AppData\Roaming\AICO-Bot\logs (Windows)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import log from 'electron-log/main.js';
import { initLogger, createLogResolvePath } from './services/log';

// ESM compat shims — electron-vite bundles main process as ESM where
// CJS globals (__dirname, __filename, require) are not available natively.
// Since all main process code is bundled into a single file, these are available everywhere.
const _require = createRequire(import.meta.url);
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
if (typeof __dirname === 'undefined') {
  (globalThis as any).__dirname = _dirname;
  (globalThis as any).__filename = _filename;
}
if (typeof require === 'undefined') {
  (globalThis as any).require = _require;
}

const isDev = process.env.NODE_ENV === 'development';

// Initialize logging system (configures electron-log transports + console replacement)
initLogger({
  logDir: isDev ? join(homedir(), '.aico-bot-dev', 'app-logs') : '',
  isDev,
});

// Handle EPIPE errors gracefully (must be registered BEFORE electron-log's errorHandler)
// electron-log's startCatching() registers its own uncaughtException handler that shows
// an Electron error dialog. By registering our EPIPE filter first, we intercept EPIPE
// errors before they reach electron-log's handler, preventing unwanted error popups.
process.on('uncaughtException', (error) => {
  // Check for EPIPE errors in multiple ways (error code, message, syscall)
  const isEpipe =
    error.message?.includes('EPIPE') ||
    (error as any).code === 'EPIPE' ||
    (error as any).syscall === 'write';

  if (isEpipe) {
    log.warn('[Main] Ignored EPIPE error:', error.message);
    return;
  }

  // Ignore network errors from remote agent connections during update/restart
  const isNetError =
    error.message?.includes('socket hang up') ||
    error.message?.includes('ECONNRESET') ||
    (error as any).code === 'ECONNRESET';

  if (isNetError) {
    log.warn('[Main] Ignored network error:', error.message);
    return;
  }
  // Non-EPIPE/ECONNRESET errors: fall through to electron-log's handler (registered below via startCatching).
  // Node.js calls all registered uncaughtException handlers in order — no need to re-throw.
});

// Handle unhandled promise rejections from network errors during agent update/restart.
// electron-log's startCatching() also catches unhandledRejection and may show a dialog.
// Register our filter first to prevent unwanted error popups for expected network errors.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : reason ? new Error(String(reason)) : null;
  if (!err) return;

  const isNetError =
    err.message?.includes('socket hang up') ||
    err.message?.includes('ECONNRESET') ||
    err.message?.includes('WebSocket disconnected') ||
    (err as any).code === 'ECONNRESET' ||
    (err as any).code === 'EPIPE';

  if (isNetError) {
    log.warn('[Main] Ignored unhandled network rejection:', err.message);
    return;
  }
});

// Catch unhandled errors and log them (after EPIPE filter is in place)
log.errorHandler.startCatching();

// Fix PATH for macOS GUI apps
// GUI apps don't inherit shell environment variables (.zshrc, .bash_profile, etc.)
// This ensures tools like git, node, npm are discoverable
// Executed after page load to avoid blocking startup
// Note: fix-path is ESM-only, loaded dynamically to support both CJS and ESM builds

import { app, shell, BrowserWindow, Menu } from 'electron';

// GPU compatibility: Disable hardware acceleration on Windows to prevent blank window issues
// Some Windows GPU configurations cause the GPU process to crash, resulting in a white/blank screen
// Using both disableHardwareAcceleration() and disable-gpu switch for maximum compatibility
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

// Anti-fingerprinting: Disable automation detection features in Chromium
// This prevents websites from detecting the app as an automated browser
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// Memory: Increase V8 heap to 4GB and expose GC for manual collection
// Knowledge base extraction processes large documents via LLM, generating
// multi-MB response strings that can exhaust the default ~2GB heap
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096 --expose-gc');

// Single instance lock: Prevent multiple instances of the application
// Must be called before app.whenReady()
// Skip in development mode and E2E tests to allow multiple instances
const gotTheLock =
  !app.isPackaged || process.env.AICO_BOT_E2E_TEST ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, exit immediately
  // Use app.exit() instead of app.quit() to terminate synchronously
  // This prevents any further initialization code from executing
  app.exit(0);
}

// Handle second-instance event (when user tries to launch another instance)
// Note: This event only fires on the primary instance
app.on('second-instance', () => {
  // Focus the existing window when a second instance is launched
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  // Restore from hidden state if needed
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  // Restore from minimized state
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  // Bring to front
  mainWindow.focus();

  // On macOS, also show in dock
  if (process.platform === 'darwin') {
    app.dock?.show();
  }
});

import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import {
  initializeEssentialServices,
  initializeExtendedServices,
  cleanupExtendedServices,
} from './bootstrap';
import { initializeApp } from './services/config.service';
import { flushAllPendingIndexWrites } from './services/conversation.service';
import { disableRemoteAccess } from './services/remote/access/remote.service';
import { stopOpenAICompatRouter } from './openai-compat-router';
import { manualCheckForUpdates } from './services/updater.service';
import { registerProtocols } from './services/protocol.service';
import { setMainWindow } from './services/window.service';
import {
  initInstanceId,
  shutdownHealthSystem,
  onRendererCrash,
  onRendererUnresponsive,
} from './services/health';
import { getBackgroundService } from './platform/background';

let mainWindow: BrowserWindow | null = null;
let isAppQuitting = false;
let recentRecoveryWindowStart = 0;
let recoveryAttempts = 0;

function recoverRenderer(reason: string): void {
  if (isAppQuitting) {
    return;
  }

  const now = Date.now();
  if (now - recentRecoveryWindowStart > 60000) {
    recentRecoveryWindowStart = now;
    recoveryAttempts = 0;
  }

  recoveryAttempts += 1;
  console.warn(
    `[Main] Renderer issue detected (${reason}). Attempting recovery #${recoveryAttempts}`,
  );

  if (recoveryAttempts > 3) {
    console.error('[Main] Renderer failed repeatedly. Relaunching app for a clean state.');
    app.relaunch();
    app.exit(0);
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.reloadIgnoringCache();
      mainWindow.show();
      return;
    } catch (error) {
      console.error('[Main] Failed to reload renderer, recreating window:', error);
      try {
        mainWindow.destroy();
      } catch (destroyError) {
        console.error('[Main] Failed to destroy corrupted window:', destroyError);
      }
      mainWindow = null;
    }
  }

  createWindow();
}

/**
 * Create application menu with Check for Updates option
 */
function createAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Check for Updates...',
                click: () => manualCheckForUpdates(),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    // File menu
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        {
          label: 'Cut',
          click: (_menuItem, focusedWindow) => {
            focusedWindow?.webContents?.cut();
          },
        },
        {
          label: 'Copy',
          click: (_menuItem, focusedWindow) => {
            focusedWindow?.webContents?.copy();
          },
        },
        {
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          click: (_menuItem, focusedWindow) => {
            focusedWindow?.webContents?.paste();
          },
        },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const },
            ]
          : [
              { role: 'delete' as const },
              { type: 'separator' as const },
              { role: 'selectAll' as const },
            ]),
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    // Help menu (Windows: includes Check for Updates)
    {
      role: 'help' as const,
      submenu: [
        ...(!isMac
          ? [
              {
                label: 'Check for Updates...',
                click: () => manualCheckForUpdates(),
              },
              { type: 'separator' as const },
            ]
          : []),
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://github.com/openkursar/hello-halo');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  // Platform-specific window options
  const isMac = process.platform === 'darwin';

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // macOS: hiddenInset for traffic lights in content area
    // Windows/Linux: hidden + titleBarOverlay for native buttons overlay
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // Fine-tuned for visual alignment with 40px header
    trafficLightPosition: isMac ? { x: 15, y: 11 } : undefined,
    // Windows/Linux: native window controls overlay in content area
    titleBarOverlay: !isMac
      ? {
          color: '#0a0a0a',
          symbolColor: '#ffffff',
          height: 40,
        }
      : undefined,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    console.log('[Main] ready-to-show event fired');
    mainWindow?.maximize();
    mainWindow?.show();
  });

  // Fix PATH after page loads (avoid blocking startup)
  mainWindow.webContents.on('did-finish-load', async () => {
    if (process.platform !== 'win32') {
      // Dynamic import for ESM-only fix-path module
      const { default: fixPath } = await import('fix-path');
      fixPath();
    }
  });

  mainWindow.on('unresponsive', () => {
    onRendererUnresponsive();
    recoverRenderer('unresponsive');
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    onRendererCrash({ reason: details.reason });
    recoverRenderer(`render-process-gone:${details.reason}`);
  });

  mainWindow.on('closed', () => {
    setMainWindow(null);
    mainWindow = null;
  });

  // Notify all subscribers about the new window
  setMainWindow(mainWindow);

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // Open DevTools in development (skip during E2E to avoid viewport interference)
  // Register BEFORE loadURL so the listener is guaranteed to catch the event.
  // Use did-finish-load instead of dom-ready — more reliable, fires once after full load.
  if (is.dev && !process.env.AICO_BOT_E2E_TEST) {
    let devToolsOpened = false;
    const openDevTools = () => {
      if (devToolsOpened || mainWindow?.isDestroyed()) return;
      devToolsOpened = true;
      mainWindow?.webContents.openDevTools({ mode: 'detach', activate: true });
    };
    mainWindow.webContents.on('did-finish-load', openDevTools);
    // Fallback: if did-finish-load was missed (race), retry after 2s
    setTimeout(openDevTools, 2000);
  }

  // Load the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Initialize application
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.aico-bot.app');

  // Register custom protocols (aico-bot-file://, etc.)
  registerProtocols();

  // Default open or close DevTools by F12 in development
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Initialize app data directories
  await initializeApp();

  // Set production log directory (app.getPath requires app ready)
  if (!isDev) {
    log.transports.file.resolvePathFn = createLogResolvePath(
      join(app.getPath('userData'), 'app-logs')
    );
  }

  // Initialize health system instance ID (synchronous, <1ms)
  // Must be called before any subprocess is spawned
  initInstanceId();

  // Create application menu
  createAppMenu();

  // Create window first
  createWindow();

  // ========================================
  // PHASED INITIALIZATION
  // ========================================
  // See src/main/bootstrap/index.ts for architecture documentation

  // Phase 1: Essential Services (synchronous, required for first screen)
  // These services are needed for the initial UI render
  // Window reference is managed by window.service.ts
  initializeEssentialServices();

  // Phase 2: Extended Services (deferred until window is visible)
  // This ensures Extended initialization NEVER affects startup speed
  if (mainWindow) {
    // Wait for window to actually show before loading Extended services
    // This guarantees 100% that startup is not affected
    mainWindow.once('ready-to-show', () => {
      // Additional delay to ensure first paint is complete
      // requestIdleCallback equivalent for Node.js
      setImmediate(() => {
        initializeExtendedServices();
      });
    });
  }

  app.on('activate', function () {
    // On macOS, re-show the window when clicking dock icon
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      app.dock?.show();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

let hasShutdown = false;
const SHUTDOWN_TIMEOUT_MS = 5000;
async function shutdownServices(): Promise<void> {
  if (hasShutdown) {
    return;
  }
  hasShutdown = true;

  // Flush pending conversation index writes before shutdown
  flushAllPendingIndexWrites();

  // Shutdown health system first (marks clean exit)
  shutdownHealthSystem();

  await disableRemoteAccess().catch(console.error);
  await stopOpenAICompatRouter().catch(console.error);
  await cleanupExtendedServices().catch(console.error);
}

async function shutdownServicesWithTimeout(timeoutMs: number): Promise<void> {
  const shutdownPromise = shutdownServices().catch(console.error);
  await Promise.race([
    shutdownPromise,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn(`[Main] Shutdown timeout after ${timeoutMs}ms, forcing quit`);
        resolve();
      }, timeoutMs);
    }),
  ]);
}

app.on('before-quit', () => {
  isAppQuitting = true;
  shutdownServicesWithTimeout(SHUTDOWN_TIMEOUT_MS).catch(console.error);
});

app.on('window-all-closed', () => {
  // If the user explicitly requested quit (Cmd+Q, menu quit, tray quit),
  // always honour it — never let keep-alive block an intentional quit.
  // before-quit sets isAppQuitting=true *synchronously* before windows close,
  // so this check is race-free.
  if (!isAppQuitting) {
    // Check if the background service wants to keep the process alive
    // (e.g., automation Apps are running in the background)
    try {
      const bgService = getBackgroundService();
      if (bgService?.shouldKeepAlive()) {
        console.log(
          '[Main] All windows closed, but keep-alive reasons exist. Staying alive via tray.',
        );
        // On macOS, hide the dock icon when running in background
        if (process.platform === 'darwin') {
          app.dock?.hide();
        }
        return;
      }
    } catch (err) {
      // shouldKeepAlive() must never prevent quit — treat errors as "no keep-alive"
      console.error('[Main] shouldKeepAlive() threw, proceeding with quit:', err);
    }
  }

  if (process.platform !== 'darwin') {
    shutdownServicesWithTimeout(SHUTDOWN_TIMEOUT_MS)
      .catch(console.error)
      .finally(() => app.quit());
  }
});

// Export mainWindow for IPC handlers
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
