/**
 * Preload Script - Exposes IPC to renderer
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  HealthStatusResponse,
  HealthStateResponse,
  HealthRecoveryResponse,
  HealthReportResponse,
  HealthExportResponse,
  HealthCheckResponse,
} from '../shared/types';

// Type definitions for exposed API
export interface AicoBotAPI {
  // Generic Auth (provider-agnostic)
  authGetProviders: () => Promise<IpcResponse>;
  authGetBuiltinProviders: () => Promise<IpcResponse>;
  authStartLogin: (providerType: string) => Promise<IpcResponse>;
  authCompleteLogin: (providerType: string, state: string) => Promise<IpcResponse>;
  authRefreshToken: (sourceId: string) => Promise<IpcResponse>;
  authCheckToken: (sourceId: string) => Promise<IpcResponse>;
  authLogout: (sourceId: string) => Promise<IpcResponse>;
  onAuthLoginProgress: (
    callback: (data: { provider: string; status: string }) => void,
  ) => () => void;

  // Config
  getConfig: () => Promise<IpcResponse>;
  setConfig: (updates: Record<string, unknown>) => Promise<IpcResponse>;
  validateApi: (apiKey: string, apiUrl: string, provider: string, model?: string, useProxy?: boolean) => Promise<IpcResponse>;
  fetchModels: (apiKey: string, apiUrl: string, useProxy?: boolean) => Promise<IpcResponse>;
  testProxy: (proxyUrl: string) => Promise<IpcResponse>;
  refreshAISourcesConfig: () => Promise<IpcResponse>;

  // AI Sources CRUD (atomic - backend reads from disk, never overwrites rotating tokens)
  aiSourcesSwitchSource: (sourceId: string) => Promise<IpcResponse>;
  aiSourcesSetModel: (modelId: string) => Promise<IpcResponse>;
  aiSourcesAddSource: (source: unknown) => Promise<IpcResponse>;
  aiSourcesUpdateSource: (sourceId: string, updates: unknown) => Promise<IpcResponse>;
  aiSourcesDeleteSource: (sourceId: string) => Promise<IpcResponse>;

  // Space
  getAicoBotSpace: () => Promise<IpcResponse>;
  listSpaces: () => Promise<IpcResponse>;
  createSpace: (input: { name: string; icon: string; customPath?: string }) => Promise<IpcResponse>;
  createRemoteDir: (input: { remoteServerId: string; remotePath: string }) => Promise<IpcResponse>;
  deleteSpace: (spaceId: string) => Promise<IpcResponse>;
  getSpace: (spaceId: string) => Promise<IpcResponse>;
  openSpaceFolder: (spaceId: string) => Promise<IpcResponse>;
  updateSpace: (spaceId: string, updates: { name?: string; icon?: string }) => Promise<IpcResponse>;
  getDefaultSpacePath: () => Promise<IpcResponse>;
  selectFolder: () => Promise<IpcResponse>;
  showOpenDialog: (options: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> }) => Promise<string[]>;
  updateSpacePreferences: (
    spaceId: string,
    preferences: {
      layout?: {
        artifactRailExpanded?: boolean;
        chatWidth?: number;
      };
    },
  ) => Promise<IpcResponse>;
  getSpacePreferences: (spaceId: string) => Promise<IpcResponse>;

  // Conversation
  listConversations: (spaceId: string) => Promise<IpcResponse>;
  createConversation: (spaceId: string, title?: string) => Promise<IpcResponse>;
  getConversation: (spaceId: string, conversationId: string) => Promise<IpcResponse>;
  updateConversation: (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>,
  ) => Promise<IpcResponse>;
  deleteConversation: (spaceId: string, conversationId: string) => Promise<IpcResponse>;
  addMessage: (
    spaceId: string,
    conversationId: string,
    message: { role: string; content: string },
  ) => Promise<IpcResponse>;
  updateLastMessage: (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>,
  ) => Promise<IpcResponse>;
  getMessageThoughts: (
    spaceId: string,
    conversationId: string,
    messageId: string,
  ) => Promise<IpcResponse>;
  toggleStarConversation: (
    spaceId: string,
    conversationId: string,
    starred: boolean,
  ) => Promise<IpcResponse>;
  getAgentCommands: (spaceId: string, conversationId: string) => Promise<IpcResponse>;
  listChildConversations: (spaceId: string, parentConversationId: string) => Promise<IpcResponse>;
  listAllWorkerConversations: (spaceId: string) => Promise<IpcResponse>;

  // Agent
  sendMessage: (request: {
    spaceId: string;
    conversationId: string;
    message: string;
    resumeSessionId?: string;
    images?: Array<{
      id: string;
      type: 'image';
      mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
      data: string;
      name?: string;
      size?: number;
    }>;
    aiBrowserEnabled?: boolean; // Enable AI Browser tools
    thinkingEnabled?: boolean; // Enable extended thinking mode
    canvasContext?: {
      // Canvas context for AI awareness
      isOpen: boolean;
      tabCount: number;
      activeTab: {
        type: string;
        title: string;
        url?: string;
        path?: string;
      } | null;
      tabs: Array<{
        type: string;
        title: string;
        url?: string;
        path?: string;
        isActive: boolean;
      }>;
    };
    agentId?: string; // Target agent for Hyper Space
  }) => Promise<IpcResponse>;
  stopGeneration: (conversationId?: string) => Promise<IpcResponse>;
  injectMessage: (request: {
    conversationId: string;
    content: string;
    images?: Array<{
      type: string;
      data: string;
      mediaType: string;
    }>;
    thinkingEnabled?: boolean;
    aiBrowserEnabled?: boolean;
  }) => Promise<IpcResponse>;
  approveTool: (conversationId: string) => Promise<IpcResponse>;
  rejectTool: (conversationId: string) => Promise<IpcResponse>;
  getSessionState: (conversationId: string) => Promise<IpcResponse>;
  getHyperSpaceWorkerStates: (spaceId: string) => Promise<IpcResponse>;
  ensureSessionWarm: (spaceId: string, conversationId: string) => Promise<IpcResponse>;
  testMcpConnections: () => Promise<{ success: boolean; servers: unknown[]; error?: string }>;
  answerQuestion: (data: {
    conversationId: string;
    id: string;
    answers: Record<string, string>;
  }) => Promise<IpcResponse>;
  rejectQuestion: (data: { id: string; reason?: string }) => Promise<IpcResponse>;
  resolveAgentPermission: (data: { id: string; approved: boolean; conversationId?: string }) => Promise<IpcResponse>;

  // Knowledge Base
  kbList: () => Promise<IpcResponse>;
  kbGet: (id: string) => Promise<IpcResponse>;
  kbCreate: (input: { name: string; description?: string; icon?: string }) => Promise<IpcResponse>;
  kbUpdate: (id: string, updates: Record<string, unknown>) => Promise<IpcResponse>;
  kbDelete: (id: string) => Promise<IpcResponse>;
  kbImportFiles: (kbId: string, filePaths: string[]) => Promise<IpcResponse>;
  kbImportFolder: (kbId: string, folderPath: string) => Promise<IpcResponse>;
  kbRemoveSource: (kbId: string, sourceId: string) => Promise<IpcResponse>;
  kbListSources: (kbId: string) => Promise<IpcResponse>;
  kbRefluxSources: (kbId: string, sourceIds: string[], userAccount: string) => Promise<IpcResponse>;
  kbPollRefluxStatus: (kbId: string) => Promise<IpcResponse>;
  kbSaveConversation: (kbId: string, spaceId: string, conversationId: string) => Promise<IpcResponse>;
  kbListConversations: (kbId: string) => Promise<IpcResponse>;
  kbIngest: (kbId: string, sourceId: string) => Promise<IpcResponse>;
  kbIngestAll: (kbId: string) => Promise<IpcResponse>;
  kbIngestIncremental: (kbId: string) => Promise<IpcResponse>;
  kbCancelIngest: (kbId: string) => Promise<IpcResponse>;
  kbRecompile: (kbId: string) => Promise<IpcResponse>;
  kbCompile: (kbId: string) => Promise<IpcResponse>;
  kbQuery: (kbId: string, question: string) => Promise<IpcResponse>;
  kbLint: (kbId: string) => Promise<IpcResponse>;
  kbGenerateReport: (kbId: string) => Promise<IpcResponse>;
  kbLoadReport: (kbId: string) => Promise<IpcResponse>;
  kbAudit: (kbId: string, correction: unknown) => Promise<IpcResponse>;
  kbListPages: (kbId: string) => Promise<IpcResponse>;
  kbReadPage: (kbId: string, pagePath: string) => Promise<IpcResponse>;
  kbReadSource: (kbId: string, sourceId: string) => Promise<IpcResponse>;
  kbUpdatePage: (kbId: string, pagePath: string, content: string) => Promise<IpcResponse>;
  kbGetPageLinks: (kbId: string, pagePath: string) => Promise<IpcResponse>;
  kbDeletePage: (kbId: string, pagePath: string) => Promise<IpcResponse>;
  kbOpenSourceBrowser: (kbId: string, sourceId: string) => Promise<IpcResponse>;
  kbOpenSourceDefault: (kbId: string, sourceId: string) => Promise<IpcResponse>;
  kbGetGraph: (kbId: string) => Promise<IpcResponse>;
  kbSelectFile: () => Promise<IpcResponse>;
  kbSelectFolder: () => Promise<IpcResponse>;
  onKbIngestProgress: (callback: (data: { current: number; total: number; fileName: string; sourceId?: string; completedSourceId?: string }) => void) => (() => void);
  onKbRefluxProgress: (callback: (data: { current: number; total: number; fileName: string }) => void) => (() => void);
  onKbRefluxStatusUpdate: (callback: (data: { kbId: string }) => void) => (() => void);

  compactContext: (conversationId: string) => Promise<IpcResponse>;
  continueIdleTimeout: (conversationId: string) => Promise<IpcResponse>;
  forceIdleTimeout: (conversationId: string) => Promise<IpcResponse>;

  // Event listeners
  onAgentMessage: (callback: (data: unknown) => void) => () => void;
  onAgentToolCall: (callback: (data: unknown) => void) => () => void;
  onAgentToolResult: (callback: (data: unknown) => void) => () => void;
  onAgentError: (callback: (data: unknown) => void) => () => void;
  onAgentComplete: (callback: (data: unknown) => void) => () => void;
  onAgentThinking: (callback: (data: unknown) => void) => () => void;
  onAgentThought: (callback: (data: unknown) => void) => () => void;
  onAgentThoughtDelta: (callback: (data: unknown) => void) => () => void;
  onAgentMcpStatus: (callback: (data: unknown) => void) => () => void;
  onAgentCompact: (callback: (data: unknown) => void) => () => void;
  onAgentContextUsage: (callback: (data: unknown) => void) => () => void;
  onAgentAskQuestion: (callback: (data: unknown) => void) => () => void;
  onAgentPermissionRequest: (callback: (data: unknown) => void) => () => void;
  onAgentTerminal: (callback: (data: unknown) => void) => () => void;
  onAgentTurnBoundary: (callback: (data: unknown) => void) => () => void;
  onAgentInjectionStart: (callback: (data: unknown) => void) => () => void;
  onAgentInterruptContext: (callback: (data: unknown) => void) => () => void;
  onAgentTeamMessage: (callback: (data: unknown) => void) => () => void;
  onWorkerStarted: (callback: (data: unknown) => void) => () => void;
  onWorkerCompleted: (callback: (data: unknown) => void) => () => void;

  // Artifact
  listArtifacts: (spaceId: string) => Promise<IpcResponse>;
  listArtifactsTree: (spaceId: string) => Promise<IpcResponse>;
  loadArtifactChildren: (spaceId: string, dirPath: string) => Promise<IpcResponse>;
  initArtifactWatcher: (spaceId: string) => Promise<IpcResponse>;
  onArtifactChanged: (
    callback: (data: {
      type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
      path: string;
      relativePath: string;
      spaceId: string;
      item?: unknown;
    }) => void,
  ) => () => void;
  onArtifactTreeUpdate: (
    callback: (data: {
      spaceId: string;
      updatedDirs: Array<{ dirPath: string; children: unknown[] }>;
      changes: Array<{
        type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
        path: string;
        relativePath: string;
        spaceId: string;
        item?: unknown;
      }>;
    }) => void,
  ) => () => void;
  openArtifact: (filePath: string) => Promise<IpcResponse>;
  showArtifactInFolder: (filePath: string) => Promise<IpcResponse>;
  readArtifactContent: (filePath: string) => Promise<IpcResponse>;
  saveArtifactContent: (filePath: string, content: string) => Promise<IpcResponse>;
  detectFileType: (filePath: string) => Promise<
    IpcResponse<{
      isText: boolean;
      canViewInCanvas: boolean;
      contentType:
        | 'code'
        | 'markdown'
        | 'html'
        | 'image'
        | 'pdf'
        | 'text'
        | 'json'
        | 'csv'
        | 'binary';
      language?: string;
      mimeType: string;
    }>
  >;

  // Onboarding
  writeOnboardingArtifact: (
    spaceId: string,
    filename: string,
    content: string,
  ) => Promise<IpcResponse>;
  saveOnboardingConversation: (
    spaceId: string,
    userPrompt: string,
    aiResponse: string,
  ) => Promise<IpcResponse>;

  // Remote Access
  enableRemoteAccess: (port?: number) => Promise<IpcResponse>;
  disableRemoteAccess: () => Promise<IpcResponse>;
  enableTunnel: () => Promise<IpcResponse>;
  disableTunnel: () => Promise<IpcResponse>;
  getRemoteStatus: () => Promise<IpcResponse>;
  getRemoteQRCode: (includeToken?: boolean) => Promise<IpcResponse>;
  setRemotePassword: (password: string) => Promise<IpcResponse>;
  regenerateRemotePassword: () => Promise<IpcResponse>;
  onRemoteStatusChange: (callback: (data: unknown) => void) => () => void;

  // System Settings
  getAutoLaunch: () => Promise<IpcResponse>;
  setAutoLaunch: (enabled: boolean) => Promise<IpcResponse>;
  openLogFolder: () => Promise<IpcResponse>;

  // Window
  setTitleBarOverlay: (options: { color: string; symbolColor: string }) => Promise<IpcResponse>;
  maximizeWindow: () => Promise<IpcResponse>;
  unmaximizeWindow: () => Promise<IpcResponse>;
  isWindowMaximized: () => Promise<IpcResponse<boolean>>;
  toggleMaximizeWindow: () => Promise<IpcResponse<boolean>>;
  forceRepaint: () => Promise<IpcResponse>;
  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;

  // User action logging
  logUserAction: (action: string, detail?: string) => Promise<IpcResponse>;

  // Search
  search: (
    query: string,
    scope: 'conversation' | 'space' | 'global',
    conversationId?: string,
    spaceId?: string,
  ) => Promise<IpcResponse>;
  cancelSearch: () => Promise<IpcResponse>;
  onSearchProgress: (callback: (data: unknown) => void) => () => void;
  onSearchCancelled: (callback: () => void) => () => void;

  // Updater
  checkForUpdates: () => Promise<IpcResponse>;
  installUpdate: () => Promise<IpcResponse>;
  getVersion: () => Promise<IpcResponse>;
  onUpdaterStatus: (callback: (data: unknown) => void) => () => void;

  // Browser (embedded browser for Content Canvas)
  createBrowserView: (viewId: string, url?: string) => Promise<IpcResponse>;
  destroyBrowserView: (viewId: string) => Promise<IpcResponse>;
  showBrowserView: (
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => Promise<IpcResponse>;
  hideBrowserView: (viewId: string, force?: boolean) => Promise<IpcResponse>;
  resizeBrowserView: (
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => Promise<IpcResponse>;
  navigateBrowserView: (viewId: string, url: string) => Promise<IpcResponse>;
  browserGoBack: (viewId: string) => Promise<IpcResponse>;
  browserGoForward: (viewId: string) => Promise<IpcResponse>;
  browserReload: (viewId: string) => Promise<IpcResponse>;
  browserStop: (viewId: string) => Promise<IpcResponse>;
  getBrowserState: (viewId: string) => Promise<IpcResponse>;
  captureBrowserView: (viewId: string) => Promise<IpcResponse>;
  executeBrowserJS: (viewId: string, code: string) => Promise<IpcResponse>;
  setBrowserZoom: (viewId: string, level: number) => Promise<IpcResponse>;
  toggleBrowserDevTools: (viewId: string) => Promise<IpcResponse>;
  showBrowserContextMenu: (options: {
    viewId: string;
    url?: string;
    zoomLevel: number;
  }) => Promise<IpcResponse>;
  onBrowserStateChange: (callback: (data: unknown) => void) => () => void;
  onBrowserZoomChanged: (
    callback: (data: { viewId: string; zoomLevel: number }) => void,
  ) => () => void;

  // Canvas Tab Menu
  showCanvasTabContextMenu: (options: {
    tabId: string;
    tabIndex: number;
    tabTitle: string;
    tabPath?: string;
    tabCount: number;
    hasTabsToRight: boolean;
  }) => Promise<IpcResponse>;
  onCanvasTabAction: (
    callback: (data: {
      action: 'close' | 'closeOthers' | 'closeToRight' | 'copyPath' | 'refresh';
      tabId?: string;
      tabIndex?: number;
      tabPath?: string;
    }) => void,
  ) => () => void;

  // AI Browser
  onAIBrowserActiveViewChanged: (
    callback: (data: { viewId: string; url: string | null; title: string | null }) => void,
  ) => () => void;

  // Overlay (for floating UI above BrowserView)
  showChatCapsuleOverlay: () => Promise<IpcResponse>;
  hideChatCapsuleOverlay: () => Promise<IpcResponse>;
  onCanvasExitMaximized: (callback: () => void) => () => void;

  // Git Bash (Windows only)
  getGitBashStatus: () => Promise<
    IpcResponse<{
      found: boolean;
      path: string | null;
      source: 'system' | 'app-local' | 'env-var' | null;
    }>
  >;
  installGitBash: (
    onProgress: (progress: {
      phase: 'downloading' | 'extracting' | 'configuring' | 'done' | 'error';
      progress: number;
      message: string;
      error?: string;
    }) => void,
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
  openExternal: (url: string) => Promise<void>;

  // GitHub Integration
  githubGetAuthStatusCombined: () => Promise<IpcResponse>;
  githubGetAuthStatus: () => Promise<IpcResponse>;
  githubLoginBrowser: () => Promise<IpcResponse>;
  githubLoginToken: (token: string) => Promise<IpcResponse>;
  githubLogout: () => Promise<IpcResponse>;
  githubSetupGitCredentials: () => Promise<IpcResponse>;
  githubGitConfig: (key: string, value: string) => Promise<IpcResponse>;
  githubGetGitConfig: (key: string) => Promise<IpcResponse>;
  onGithubLoginProgress: (
    callback: (data: { code?: string; url?: string; message: string }) => void,
  ) => () => void;

  // GitHub Direct PAT (no gh CLI)
  githubDirectAuthStatus: () => Promise<IpcResponse>;
  githubDirectLoginToken: (token: string) => Promise<IpcResponse>;
  githubDirectLogout: () => Promise<IpcResponse>;
  githubDirectSetupCredentials: () => Promise<IpcResponse>;

  // GitCode Integration
  gitcodeGetAuthStatus: () => Promise<IpcResponse>;
  gitcodeLoginToken: (token: string) => Promise<IpcResponse>;
  gitcodeLogout: () => Promise<IpcResponse>;

  // Bootstrap lifecycle
  getBootstrapStatus: () => Promise<
    IpcResponse<{
      extendedReady: boolean;
      extendedReadyAt: number;
    }>
  >;
  onBootstrapExtendedReady: (
    callback: (data: { timestamp: number; duration: number }) => void,
  ) => () => void;

  // Health System
  getHealthStatus: () => Promise<IpcResponse<HealthStatusResponse>>;
  getHealthState: () => Promise<IpcResponse<HealthStateResponse>>;
  triggerHealthRecovery: (
    strategyId: string,
    userConsented: boolean,
  ) => Promise<IpcResponse<HealthRecoveryResponse>>;
  generateHealthReport: () => Promise<IpcResponse<HealthReportResponse>>;
  generateHealthReportText: () => Promise<IpcResponse<string>>;
  exportHealthReport: (filePath?: string) => Promise<IpcResponse<HealthExportResponse>>;
  runHealthCheck: () => Promise<IpcResponse<HealthCheckResponse>>;

  // Apps Management
  appList: (filter?: { spaceId?: string; status?: string; type?: string }) => Promise<IpcResponse>;
  appGet: (appId: string) => Promise<IpcResponse>;
  appInstall: (input: {
    spaceId: string;
    spec: unknown;
    userConfig?: Record<string, unknown>;
  }) => Promise<IpcResponse>;
  appUninstall: (input: { appId: string; options?: { purge?: boolean } }) => Promise<IpcResponse>;
  appReinstall: (input: { appId: string }) => Promise<IpcResponse>;
  appDelete: (input: { appId: string }) => Promise<IpcResponse>;
  appPause: (appId: string) => Promise<IpcResponse>;
  appResume: (appId: string) => Promise<IpcResponse>;
  appTrigger: (appId: string) => Promise<IpcResponse>;
  appGetState: (appId: string) => Promise<IpcResponse>;
  appGetActivity: (input: {
    appId: string;
    options?: { limit?: number; offset?: number; type?: string; since?: number };
  }) => Promise<IpcResponse>;
  appGetSession: (input: { appId: string; runId: string }) => Promise<IpcResponse>;
  appRespondEscalation: (input: {
    appId: string;
    escalationId: string;
    response: { ts: number; choice?: string; text?: string };
  }) => Promise<IpcResponse>;
  appUpdateConfig: (input: {
    appId: string;
    config: Record<string, unknown>;
  }) => Promise<IpcResponse>;
  appUpdateFrequency: (input: {
    appId: string;
    subscriptionId: string;
    frequency: string;
  }) => Promise<IpcResponse>;
  appUpdateOverrides: (input: {
    appId: string;
    overrides: Record<string, unknown>;
  }) => Promise<IpcResponse>;
  appUpdateSpec: (input: {
    appId: string;
    specPatch: Record<string, unknown>;
  }) => Promise<IpcResponse>;
  appGrantPermission: (input: { appId: string; permission: string }) => Promise<IpcResponse>;
  appRevokePermission: (input: { appId: string; permission: string }) => Promise<IpcResponse>;

  // App Import / Export
  appExportSpec: (appId: string) => Promise<IpcResponse<{ yaml: string; filename: string }>>;
  appImportSpec: (input: {
    spaceId: string;
    yamlContent: string;
    userConfig?: Record<string, unknown>;
  }) => Promise<IpcResponse>;

  // App Chat
  appChatSend: (request: {
    appId: string;
    spaceId: string;
    message: string;
    thinkingEnabled?: boolean;
  }) => Promise<IpcResponse>;
  appChatStop: (appId: string) => Promise<IpcResponse>;
  appChatStatus: (appId: string) => Promise<IpcResponse>;
  appChatMessages: (input: { appId: string; spaceId: string }) => Promise<IpcResponse>;
  appChatSessionState: (appId: string) => Promise<IpcResponse>;

  // App Event Listeners
  onAppStatusChanged: (callback: (data: unknown) => void) => () => void;
  onAppActivityEntry: (callback: (data: unknown) => void) => () => void;
  onAppEscalation: (callback: (data: unknown) => void) => () => void;
  onAppNavigate: (callback: (data: unknown) => void) => () => void;

  // Notification (in-app toast)
  onNotificationToast: (callback: (data: unknown) => void) => () => void;

  // Remote Server
  remoteServer: {
    add: (server: unknown) => Promise<IpcResponse>;
    update: (server: unknown) => Promise<IpcResponse>;
    list: () => Promise<IpcResponse>;
    deploy: (serverId: string) => Promise<IpcResponse>;
    connect: (serverId: string) => Promise<IpcResponse>;
    disconnect: (serverId: string) => Promise<IpcResponse>;
    delete: (serverId: string) => Promise<IpcResponse>;
    checkAgent: (serverId: string) => Promise<IpcResponse>;
    deployAgent: (serverId: string) => Promise<IpcResponse>;
    updateAgent: (serverId: string) => Promise<IpcResponse>;
    startAgent: (serverId: string) => Promise<IpcResponse>;
    stopAgent: (serverId: string) => Promise<IpcResponse>;
    getAgentLogs: (serverId: string, lines?: number) => Promise<IpcResponse>;
    isAgentRunning: (serverId: string) => Promise<IpcResponse>;
    listTasks: (serverId: string) => Promise<IpcResponse>;
    cancelTask: (serverId: string, taskId: string) => Promise<IpcResponse>;
    getUpdateStatus: (serverId: string) => Promise<IpcResponse>;
    acknowledgeUpdate: (serverId: string) => Promise<IpcResponse>;
    deployOffline: (serverId: string, platform?: 'x64' | 'arm64') => Promise<IpcResponse>;
    checkOfflineBundle: (platform: 'x64' | 'arm64') => Promise<IpcResponse>;
  };

  // Remote Agent
  remoteAgent: {
    sendMessage: (serverId: string, message: string) => Promise<IpcResponse>;
    chat: (
      serverId: string,
      params: { sessionId?: string; content: string; attachments?: any[] },
    ) => Promise<IpcResponse>;
    fsList: (serverId: string, path?: string) => Promise<IpcResponse>;
    fsRead: (serverId: string, path: string) => Promise<IpcResponse>;
    fsWrite: (serverId: string, path: string, content: string) => Promise<IpcResponse>;
    fsDelete: (serverId: string, path: string) => Promise<IpcResponse>;
    checkConnection: (serverId: string) => Promise<IpcResponse>;
    getMessages: (serverId: string, sessionId: string) => Promise<IpcResponse>;
  };

  onRemoteAgentStream: (callback: (data: unknown) => void) => () => void;
  onRemoteAgentComplete: (callback: (data: unknown) => void) => () => void;
  onRemoteAgentError: (callback: (data: unknown) => void) => () => void;
  onRemoteAgentFsResult: (callback: (data: unknown) => void) => () => void;
  onRemoteTaskUpdate: (callback: (data: unknown) => void) => () => void;
  onRemoteServerCommandOutput: (callback: (data: unknown) => void) => () => void;
  onRemoteServerStatusChange: (callback: (data: unknown) => void) => () => void;
  onRemoteServerDeployProgress: (callback: (data: unknown) => void) => () => void;
  onRemoteServerUpdateComplete: (callback: (data: unknown) => void) => () => void;

  // Store (App Registry)
  storeListApps: (query: {
    search?: string;
    locale?: string;
    category?: string;
    type?: string;
    tags?: string[];
  }) => Promise<IpcResponse>;
  storeGetAppDetail: (slug: string) => Promise<IpcResponse>;
  storeInstall: (input: {
    slug: string;
    spaceId: string;
    userConfig?: Record<string, unknown>;
  }) => Promise<IpcResponse>;
  storeRefresh: () => Promise<IpcResponse>;
  storeCheckUpdates: () => Promise<IpcResponse>;
  storeGetRegistries: () => Promise<IpcResponse>;
  storeAddRegistry: (input: { name: string; url: string }) => Promise<IpcResponse>;
  storeRemoveRegistry: (registryId: string) => Promise<IpcResponse>;
  storeToggleRegistry: (input: { registryId: string; enabled: boolean }) => Promise<IpcResponse>;

  // Skill Management
  skillList: () => Promise<IpcResponse>;
  skillToggle: (skillId: string, enabled: boolean) => Promise<IpcResponse>;
  skillUninstall: (skillId: string) => Promise<IpcResponse>;
  skillExport: (skillId: string) => Promise<IpcResponse>;
  skillInstall: (input: {
    mode: 'market' | 'yaml';
    skillId?: string;
    yamlContent?: string;
  }) => Promise<IpcResponse>;
  skillImportSkills: (input: { sourceType: 'zip' | 'folder'; filePath: string }) => Promise<IpcResponse>;
  skillFiles: (skillId: string) => Promise<IpcResponse>;
  skillFileContent: (skillId: string, filePath: string) => Promise<IpcResponse>;
  skillFileSave: (skillId: string, filePath: string, content: string) => Promise<IpcResponse>;

  // Skill Generator
  skillAnalyzeConversations: (spaceId: string, conversationIds: string[]) => Promise<IpcResponse>;
  skillCreateTempSession: (options: { skillName: string; context: any }) => Promise<IpcResponse>;
  skillSendTempMessage: (sessionId: string, message: string) => Promise<IpcResponse>;
  skillCloseTempSession: (sessionId: string) => Promise<IpcResponse>;
  skillMarketList: (sourceId?: string, page?: number, pageSize?: number) => Promise<IpcResponse>;
  skillMarketSearch: (
    query: string,
    sourceId?: string,
    page?: number,
    pageSize?: number,
  ) => Promise<IpcResponse>;
  skillMarketSources: () => Promise<IpcResponse>;
  skillMarketResetCache: (sourceId?: string) => Promise<IpcResponse>;
  skillMarketSetActiveSource: (sourceId: string) => Promise<IpcResponse>;
  skillMarketToggleSource: (sourceId: string, enabled: boolean) => Promise<IpcResponse>;
  skillMarketAddSource: (source: {
    name: string;
    url: string;
    repos?: string[];
    description?: string;
  }) => Promise<IpcResponse>;
  skillMarketRemoveSource: (sourceId: string) => Promise<IpcResponse>;
  skillMarketDetail: (skillId: string) => Promise<IpcResponse>;
  skillMarketPushToGitHub: (
    skillId: string,
    targetRepo: string,
    targetPath?: string,
  ) => Promise<IpcResponse>;
  skillMarketListRepoDirs: (repo: string) => Promise<IpcResponse>;
  skillMarketValidateRepo: (repo: string) => Promise<IpcResponse>;
  skillMarketPushToGitCode: (
    skillId: string,
    targetRepo: string,
    targetPath?: string,
  ) => Promise<IpcResponse>;
  skillMarketListGitCodeRepoDirs: (repo: string) => Promise<IpcResponse>;
  skillMarketValidateGitCodeRepo: (repo: string) => Promise<IpcResponse>;
  skillMarketSetGitCodeToken: (token: string) => Promise<IpcResponse>;
  skillMarketPatStatus: () => Promise<IpcResponse>;
  skillNetworkProxyStatus: () => Promise<IpcResponse>;
  onSkillMarketFetchProgress: (
    callback: (data: { phase: string; current: number; total: number }) => void,
  ) => () => void;
  skillConfigGet: () => Promise<IpcResponse>;
  skillConfigUpdate: (config: { globalShared?: boolean }) => Promise<IpcResponse>;
  skillRefresh: () => Promise<IpcResponse>;
  skillGenerate: (input: {
    mode: 'conversation' | 'prompt';
    spaceId: string;
    conversationId?: string;
    name?: string;
    description?: string;
    triggerCommand?: string;
  }) => Promise<IpcResponse>;
  onSkillTempMessageChunk: (
    callback: (data: { sessionId: string; chunk: any }) => void,
  ) => () => void;
  onSkillInstallOutput: (
    callback: (data: {
      skillId: string;
      output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string };
    }) => void,
  ) => () => void;
  skillSyncToRemote: (input: { skillId: string; serverId: string }) => Promise<IpcResponse>;
  onSkillSyncOutput: (
    callback: (data: {
      skillId: string;
      serverId: string;
      output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string };
    }) => void,
  ) => () => void;
  skillSyncFromRemote: (input: { skillId: string; serverId: string }) => Promise<IpcResponse>;
  onSkillSyncFromRemoteOutput: (
    callback: (data: {
      skillId: string;
      serverId: string;
      output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string };
    }) => void,
  ) => () => void;

  // Skill Conversation (持久化会话)
  skillConversationList: (relatedSkillId?: string) => Promise<IpcResponse>;
  skillConversationGet: (conversationId: string) => Promise<IpcResponse>;
  skillConversationCreate: (title?: string, relatedSkillId?: string) => Promise<IpcResponse>;
  skillConversationDelete: (conversationId: string) => Promise<IpcResponse>;
  skillConversationSend: (
    conversationId: string,
    message: string,
    metadata?: {
      selectedConversations?: Array<{
        id: string;
        title: string;
        spaceName: string;
        messageCount: number;
        formattedContent?: string;
      }>;
      sourceWebpages?: Array<{
        url: string;
        title?: string;
        content?: string;
      }>;
    },
  ) => Promise<IpcResponse>;
  skillConversationStop: (conversationId: string) => Promise<IpcResponse>;
  skillConversationClose: (conversationId: string) => Promise<IpcResponse>;
  onSkillConversationChunk: (
    callback: (data: { conversationId: string; chunk: any }) => void,
  ) => () => void;

  // Terminal
  getTerminalWebSocketUrl: (
    spaceId: string,
    conversationId: string,
  ) => Promise<IpcResponse<{ wsUrl: string }>>;
  sendTerminalCommand: (
    spaceId: string,
    conversationId: string,
    command: string,
  ) => Promise<IpcResponse>;
  getTerminalOutput: (
    spaceId: string,
    conversationId: string,
    lines?: number,
  ) => Promise<IpcResponse<{ lines: string[] }>>;
  generateSkillFromTerminal: (spaceId: string, conversationId: string) => Promise<IpcResponse>;

  // Hyper Space (Multi-Agent Collaboration)
  createHyperSpace: (params: {
    name: string;
    icon?: string;
    agents: any[];
    orchestration?: any;
    customPath?: string;
    remoteServerId?: string;
    remotePath?: string;
    useSshTunnel?: boolean;
  }) => Promise<IpcResponse<{ space: any }>>;
  getHyperSpaceStatus: (spaceId: string) => Promise<
    IpcResponse<{
      status: string;
      leader: { id: string; status: string };
      workers: Array<{ id: string; status: string; currentTaskId?: string }>;
      pendingTasks: number;
    }>
  >;
  addAgentToHyperSpace: (spaceId: string, agent: any) => Promise<IpcResponse>;
  removeAgentFromHyperSpace: (spaceId: string, agentId: string) => Promise<IpcResponse>;
  updateHyperSpaceConfig: (spaceId: string, config: any) => Promise<IpcResponse>;
  getHyperSpaceTasks: (conversationId: string) => Promise<IpcResponse<{ tasks: any[] }>>;
}

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// Create event listener with cleanup
function createEventListener(channel: string, callback: (data: unknown) => void): () => void {
  console.log(`[Preload] Creating event listener for channel: ${channel}`);

  const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
    console.log(`[Preload] Received event on channel: ${channel}`, data);
    callback(data);
  };

  ipcRenderer.on(channel, handler);

  return () => {
    console.log(`[Preload] Removing event listener for channel: ${channel}`);
    ipcRenderer.removeListener(channel, handler);
  };
}

// Expose API to renderer
const api: AicoBotAPI = {
  // Generic Auth (provider-agnostic)
  authGetProviders: () => ipcRenderer.invoke('auth:get-providers'),
  authGetBuiltinProviders: () => ipcRenderer.invoke('auth:get-builtin-providers'),
  authStartLogin: (providerType) => ipcRenderer.invoke('auth:start-login', providerType),
  authCompleteLogin: (providerType, state) =>
    ipcRenderer.invoke('auth:complete-login', providerType, state),
  authRefreshToken: (sourceId) => ipcRenderer.invoke('auth:refresh-token', sourceId),
  authCheckToken: (sourceId) => ipcRenderer.invoke('auth:check-token', sourceId),
  authLogout: (sourceId) => ipcRenderer.invoke('auth:logout', sourceId),
  onAuthLoginProgress: (callback) =>
    createEventListener('auth:login-progress', callback as (data: unknown) => void),

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (updates) => ipcRenderer.invoke('config:set', updates),
  validateApi: (apiKey, apiUrl, provider, model?, useProxy?) =>
    ipcRenderer.invoke('config:validate-api', apiKey, apiUrl, provider, model, useProxy),
  fetchModels: (apiKey, apiUrl, useProxy?) => ipcRenderer.invoke('config:fetch-models', apiKey, apiUrl, useProxy),
  testProxy: (proxyUrl) => ipcRenderer.invoke('config:test-proxy', proxyUrl),
  refreshAISourcesConfig: () => ipcRenderer.invoke('config:refresh-ai-sources'),

  // AI Sources CRUD (atomic - backend reads from disk, never overwrites rotating tokens)
  aiSourcesSwitchSource: (sourceId) => ipcRenderer.invoke('ai-sources:switch-source', sourceId),
  aiSourcesSetModel: (modelId) => ipcRenderer.invoke('ai-sources:set-model', modelId),
  aiSourcesAddSource: (source) => ipcRenderer.invoke('ai-sources:add-source', source),
  aiSourcesUpdateSource: (sourceId, updates) =>
    ipcRenderer.invoke('ai-sources:update-source', sourceId, updates),
  aiSourcesDeleteSource: (sourceId) => ipcRenderer.invoke('ai-sources:delete-source', sourceId),

  // Space
  getAicoBotSpace: () => ipcRenderer.invoke('space:get-aico-bot'),
  listSpaces: () => ipcRenderer.invoke('space:list'),
  createSpace: (input) => ipcRenderer.invoke('space:create', input),
  createRemoteDir: (input) => ipcRenderer.invoke('space:create-dir', input),
  deleteSpace: (spaceId) => ipcRenderer.invoke('space:delete', spaceId),
  getSpace: (spaceId) => ipcRenderer.invoke('space:get', spaceId),
  openSpaceFolder: (spaceId) => ipcRenderer.invoke('space:open-folder', spaceId),
  updateSpace: (spaceId, updates) => ipcRenderer.invoke('space:update', spaceId, updates),
  getDefaultSpacePath: () => ipcRenderer.invoke('space:get-default-path'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),
  updateSpacePreferences: (spaceId, preferences) =>
    ipcRenderer.invoke('space:update-preferences', spaceId, preferences),

  // Hyper Space
  getSpacePreferences: (spaceId) => ipcRenderer.invoke('space:get-preferences', spaceId),
  getSkillSpace: () => ipcRenderer.invoke('space:get-skill-space'),
  getSkillSpaceId: () => ipcRenderer.invoke('space:get-skill-space-id'),
  isSkillSpace: (spaceId) => ipcRenderer.invoke('space:is-skill-space', spaceId),

  // Conversation
  listConversations: (spaceId) => ipcRenderer.invoke('conversation:list', spaceId),
  createConversation: (spaceId, title) => ipcRenderer.invoke('conversation:create', spaceId, title),
  getConversation: (spaceId, conversationId) =>
    ipcRenderer.invoke('conversation:get', spaceId, conversationId),
  updateConversation: (spaceId, conversationId, updates) =>
    ipcRenderer.invoke('conversation:update', spaceId, conversationId, updates),
  deleteConversation: (spaceId, conversationId) =>
    ipcRenderer.invoke('conversation:delete', spaceId, conversationId),
  addMessage: (spaceId, conversationId, message) =>
    ipcRenderer.invoke('conversation:add-message', spaceId, conversationId, message),
  updateLastMessage: (spaceId, conversationId, updates) =>
    ipcRenderer.invoke('conversation:update-last-message', spaceId, conversationId, updates),
  getMessageThoughts: (spaceId, conversationId, messageId) =>
    ipcRenderer.invoke('conversation:get-thoughts', spaceId, conversationId, messageId),
  toggleStarConversation: (spaceId, conversationId, starred) =>
    ipcRenderer.invoke('conversation:toggle-star', spaceId, conversationId, starred),
  getAgentCommands: (spaceId, conversationId) =>
    ipcRenderer.invoke('conversation:get-agent-commands', spaceId, conversationId),
  listChildConversations: (spaceId, parentConversationId) =>
    ipcRenderer.invoke('conversation:list-children', spaceId, parentConversationId),
  listAllWorkerConversations: (spaceId) =>
    ipcRenderer.invoke('conversation:list-all-workers', spaceId),

  // Agent
  sendMessage: (request) => ipcRenderer.invoke('agent:send-message', request),
  stopGeneration: (conversationId) => ipcRenderer.invoke('agent:stop', conversationId),
  injectMessage: (request) => ipcRenderer.invoke('agent:inject-message', request),
  approveTool: (conversationId) => ipcRenderer.invoke('agent:approve-tool', conversationId),
  rejectTool: (conversationId) => ipcRenderer.invoke('agent:reject-tool', conversationId),
  getSessionState: (conversationId) =>
    ipcRenderer.invoke('agent:get-session-state', conversationId),
  getHyperSpaceWorkerStates: (spaceId) =>
    ipcRenderer.invoke('hyper-space:get-worker-states', spaceId),
  ensureSessionWarm: (spaceId, conversationId) =>
    ipcRenderer.invoke('agent:ensure-session-warm', spaceId, conversationId),
  testMcpConnections: () => ipcRenderer.invoke('agent:test-mcp'),
  answerQuestion: (data) => ipcRenderer.invoke('agent:answer-question', data),
  rejectQuestion: (data) => ipcRenderer.invoke('agent:reject-question', data),
  resolveAgentPermission: (data) => ipcRenderer.invoke('agent:resolve-permission', data),

  // Knowledge Base
  kbList: () => ipcRenderer.invoke('knowledge-base:list'),
  kbGet: (id: string) => ipcRenderer.invoke('knowledge-base:get', id),
  kbCreate: (input: { name: string; description?: string; icon?: string }) =>
    ipcRenderer.invoke('knowledge-base:create', input),
  kbUpdate: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('knowledge-base:update', id, updates),
  kbDelete: (id: string) => ipcRenderer.invoke('knowledge-base:delete', id),
  kbImportFiles: (kbId: string, filePaths: string[]) =>
    ipcRenderer.invoke('knowledge-base:import-files', kbId, filePaths),
  kbImportFolder: (kbId: string, folderPath: string) =>
    ipcRenderer.invoke('knowledge-base:import-folder', kbId, folderPath),
  kbRemoveSource: (kbId: string, sourceId: string) =>
    ipcRenderer.invoke('knowledge-base:remove-source', kbId, sourceId),
  kbListSources: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:list-sources', kbId),
  kbRefluxSources: (kbId: string, sourceIds: string[], userAccount: string) =>
    ipcRenderer.invoke('knowledge-base:reflux-sources', kbId, sourceIds, userAccount),
  kbPollRefluxStatus: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:poll-reflux-status', kbId),
  kbSaveConversation: (kbId: string, spaceId: string, conversationId: string) =>
    ipcRenderer.invoke('knowledge-base:save-conversation', kbId, spaceId, conversationId),
  kbListConversations: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:list-conversations', kbId),
  kbIngest: (kbId: string, sourceId: string) =>
    ipcRenderer.invoke('knowledge-base:ingest', kbId, sourceId),
  kbIngestAll: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:ingest-all', kbId),
  kbIngestIncremental: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:ingest-incremental', kbId),
  kbCancelIngest: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:ingest-cancel', kbId),
  kbRecompile: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:recompile', kbId),
  kbCompile: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:compile', kbId),
  kbQuery: (kbId: string, question: string) =>
    ipcRenderer.invoke('knowledge-base:query', kbId, question),
  kbLint: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:lint', kbId),
  kbGenerateReport: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:generate-report', kbId),
  kbLoadReport: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:load-report', kbId),
  kbAudit: (kbId: string, correction: unknown) =>
    ipcRenderer.invoke('knowledge-base:audit', kbId, correction),
  kbListPages: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:list-pages', kbId),
  kbReadPage: (kbId: string, pagePath: string) =>
    ipcRenderer.invoke('knowledge-base:read-page', kbId, pagePath),
  kbReadSource: (kbId: string, sourceId: string) =>
    ipcRenderer.invoke('knowledge-base:read-source', kbId, sourceId),
  kbUpdatePage: (kbId: string, pagePath: string, content: string) =>
    ipcRenderer.invoke('knowledge-base:update-page', kbId, pagePath, content),
  kbGetPageLinks: (kbId: string, pagePath: string) =>
    ipcRenderer.invoke('knowledge-base:get-page-links', kbId, pagePath),
  kbDeletePage: (kbId: string, pagePath: string) =>
    ipcRenderer.invoke('knowledge-base:delete-page', kbId, pagePath),
  kbOpenSourceBrowser: (kbId: string, sourceId: string) =>
    ipcRenderer.invoke('knowledge-base:open-source-browser', kbId, sourceId),
  kbOpenSourceDefault: (kbId: string, sourceId: string) =>
    ipcRenderer.invoke('knowledge-base:open-source-default', kbId, sourceId),
  kbGetGraph: (kbId: string) =>
    ipcRenderer.invoke('knowledge-base:get-graph-data', kbId),
  kbSelectFile: () => ipcRenderer.invoke('knowledge-base:select-file'),
  kbSelectFolder: () => ipcRenderer.invoke('knowledge-base:select-folder'),
  onKbIngestProgress: (callback: (data: { current: number; total: number; fileName: string }) => void) =>
    createEventListener('knowledge-base:ingest-progress', callback),
  onKbRefluxProgress: (callback: (data: { current: number; total: number; fileName: string }) => void) =>
    createEventListener('knowledge-base:reflux-progress', callback),
  onKbRefluxStatusUpdate: (callback: (data: { kbId: string }) => void) =>
    createEventListener('knowledge-base:reflux-status-update', callback),

  compactContext: (conversationId) => ipcRenderer.invoke('agent:compact-context', conversationId),
  continueIdleTimeout: (conversationId) => ipcRenderer.invoke('agent:continue-idle-timeout', conversationId),
  forceIdleTimeout: (conversationId) => ipcRenderer.invoke('agent:force-idle-timeout', conversationId),

  // Event listeners
  onAgentMessage: (callback) => createEventListener('agent:message', callback),
  onAgentToolCall: (callback) => createEventListener('agent:tool-call', callback),
  onAgentToolResult: (callback) => createEventListener('agent:tool-result', callback),
  onAgentError: (callback) => createEventListener('agent:error', callback),
  onAgentComplete: (callback) => createEventListener('agent:complete', callback),
  onAgentThinking: (callback) => createEventListener('agent:thinking', callback),
  onAgentThought: (callback) => createEventListener('agent:thought', callback),
  onAgentThoughtDelta: (callback) => createEventListener('agent:thought-delta', callback),
  onAgentMcpStatus: (callback) => createEventListener('agent:mcp-status', callback),
  onAgentCompact: (callback) => createEventListener('agent:compact', callback),
  onAgentContextUsage: (callback) => createEventListener('agent:context-usage', callback),
  onAgentAskQuestion: (callback) => createEventListener('agent:ask-question', callback),
  onAgentPermissionRequest: (callback) => createEventListener('agent:permission-request', callback),
  onAgentTerminal: (callback) => createEventListener('agent:terminal', callback),
  onAgentTurnBoundary: (callback) => createEventListener('agent:turn-boundary', callback),
  onAgentInjectionStart: (callback) => createEventListener('agent:injection-start', callback),
  onAgentInterruptContext: (callback) => createEventListener('agent:interrupt-context', callback),
  onAgentTeamMessage: (callback) => createEventListener('agent:team-message', callback),
  onWorkerStarted: (callback) => createEventListener('worker:started', callback),
  onWorkerCompleted: (callback) => createEventListener('worker:completed', callback),

  // Artifact
  listArtifacts: (spaceId) => ipcRenderer.invoke('artifact:list', spaceId),
  listArtifactsTree: (spaceId) => ipcRenderer.invoke('artifact:list-tree', spaceId),
  loadArtifactChildren: (spaceId, dirPath) =>
    ipcRenderer.invoke('artifact:load-children', spaceId, dirPath),
  initArtifactWatcher: (spaceId) => ipcRenderer.invoke('artifact:init-watcher', spaceId),
  onArtifactChanged: (callback) =>
    createEventListener('artifact:changed', callback as (data: unknown) => void),
  onArtifactTreeUpdate: (callback) =>
    createEventListener('artifact:tree-update', callback as (data: unknown) => void),
  openArtifact: (filePath) => ipcRenderer.invoke('artifact:open', filePath),
  showArtifactInFolder: (filePath) => ipcRenderer.invoke('artifact:show-in-folder', filePath),
  readArtifactContent: (filePath) => ipcRenderer.invoke('artifact:read-content', filePath),
  saveArtifactContent: (filePath, content) =>
    ipcRenderer.invoke('artifact:save-content', filePath, content),
  detectFileType: (filePath) => ipcRenderer.invoke('artifact:detect-file-type', filePath),

  // Onboarding
  writeOnboardingArtifact: (spaceId, filename, content) =>
    ipcRenderer.invoke('onboarding:write-artifact', spaceId, filename, content),
  saveOnboardingConversation: (spaceId, userPrompt, aiResponse) =>
    ipcRenderer.invoke('onboarding:save-conversation', spaceId, userPrompt, aiResponse),

  // Remote Access
  enableRemoteAccess: (port) => ipcRenderer.invoke('remote:enable', port),
  disableRemoteAccess: () => ipcRenderer.invoke('remote:disable'),
  enableTunnel: () => ipcRenderer.invoke('remote:tunnel:enable'),
  disableTunnel: () => ipcRenderer.invoke('remote:tunnel:disable'),
  getRemoteStatus: () => ipcRenderer.invoke('remote:status'),
  getRemoteQRCode: (includeToken) => ipcRenderer.invoke('remote:qrcode', includeToken),
  setRemotePassword: (password) => ipcRenderer.invoke('remote:set-password', password),
  regenerateRemotePassword: () => ipcRenderer.invoke('remote:regenerate-password'),
  onRemoteStatusChange: (callback) => createEventListener('remote:status-change', callback),

  // System Settings
  getAutoLaunch: () => ipcRenderer.invoke('system:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('system:set-auto-launch', enabled),
  openLogFolder: () => ipcRenderer.invoke('system:open-log-folder'),

  // Window
  setTitleBarOverlay: (options) => ipcRenderer.invoke('window:set-title-bar-overlay', options),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  unmaximizeWindow: () => ipcRenderer.invoke('window:unmaximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  forceRepaint: () => ipcRenderer.invoke('window:force-repaint'),
  onWindowMaximizeChange: (callback) =>
    createEventListener('window:maximize-change', callback as (data: unknown) => void),

  // Search
  search: (query, scope, conversationId, spaceId) =>
    ipcRenderer.invoke('search:execute', query, scope, conversationId, spaceId),
  cancelSearch: () => ipcRenderer.invoke('search:cancel'),
  onSearchProgress: (callback) => createEventListener('search:progress', callback),
  onSearchCancelled: (callback) => createEventListener('search:cancelled', callback),

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('updater:get-version'),
  onUpdaterStatus: (callback) => createEventListener('updater:status', callback),

  // Browser (embedded browser for Content Canvas)
  createBrowserView: (viewId, url) => ipcRenderer.invoke('browser:create', { viewId, url }),
  destroyBrowserView: (viewId) => ipcRenderer.invoke('browser:destroy', { viewId }),
  showBrowserView: (viewId, bounds) => ipcRenderer.invoke('browser:show', { viewId, bounds }),
  hideBrowserView: (viewId, force = false) => ipcRenderer.invoke('browser:hide', { viewId, force }),
  resizeBrowserView: (viewId, bounds) => ipcRenderer.invoke('browser:resize', { viewId, bounds }),
  navigateBrowserView: (viewId, url) => ipcRenderer.invoke('browser:navigate', { viewId, url }),
  browserGoBack: (viewId) => ipcRenderer.invoke('browser:go-back', { viewId }),
  browserGoForward: (viewId) => ipcRenderer.invoke('browser:go-forward', { viewId }),
  browserReload: (viewId) => ipcRenderer.invoke('browser:reload', { viewId }),
  browserStop: (viewId) => ipcRenderer.invoke('browser:stop', { viewId }),
  getBrowserState: (viewId) => ipcRenderer.invoke('browser:get-state', { viewId }),
  captureBrowserView: (viewId) => ipcRenderer.invoke('browser:capture', { viewId }),
  executeBrowserJS: (viewId, code) => ipcRenderer.invoke('browser:execute-js', { viewId, code }),
  setBrowserZoom: (viewId, level) => ipcRenderer.invoke('browser:zoom', { viewId, level }),
  toggleBrowserDevTools: (viewId) => ipcRenderer.invoke('browser:dev-tools', { viewId }),
  showBrowserContextMenu: (options) => ipcRenderer.invoke('browser:show-context-menu', options),
  onBrowserStateChange: (callback) => createEventListener('browser:state-change', callback),
  onBrowserZoomChanged: (callback) =>
    createEventListener('browser:zoom-changed', callback as (data: unknown) => void),

  // Canvas Tab Menu (native Electron menu)
  showCanvasTabContextMenu: (options) =>
    ipcRenderer.invoke('canvas:show-tab-context-menu', options),
  onCanvasTabAction: (callback) =>
    createEventListener('canvas:tab-action', callback as (data: unknown) => void),

  // AI Browser - active view change notification from main process
  onAIBrowserActiveViewChanged: (callback) =>
    createEventListener('ai-browser:active-view-changed', callback as (data: unknown) => void),

  // Overlay (for floating UI above BrowserView)
  showChatCapsuleOverlay: () => ipcRenderer.invoke('overlay:show-chat-capsule'),
  hideChatCapsuleOverlay: () => ipcRenderer.invoke('overlay:hide-chat-capsule'),
  onCanvasExitMaximized: (callback) =>
    createEventListener('canvas:exit-maximized', callback as (data: unknown) => void),

  // Git Bash (Windows only)
  getGitBashStatus: () => ipcRenderer.invoke('git-bash:status'),
  installGitBash: async (onProgress) => {
    // Create a unique channel for this installation
    const progressChannel = `git-bash:install-progress-${Date.now()}`;

    // Set up progress listener
    const progressHandler = (_event: Electron.IpcRendererEvent, progress: unknown) => {
      onProgress(progress as Parameters<typeof onProgress>[0]);
    };
    ipcRenderer.on(progressChannel, progressHandler);

    try {
      const result = await ipcRenderer.invoke('git-bash:install', { progressChannel });
      return result as { success: boolean; path?: string; error?: string };
    } finally {
      ipcRenderer.removeListener(progressChannel, progressHandler);
    }
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // GitHub Integration
  githubGetAuthStatusCombined: () => ipcRenderer.invoke('github:auth-status-combined'),
  githubGetAuthStatus: () => ipcRenderer.invoke('github:auth-status'),
  githubLoginBrowser: () => ipcRenderer.invoke('github:login-browser'),
  githubLoginToken: (token) => ipcRenderer.invoke('github:login-token', token),
  githubLogout: () => ipcRenderer.invoke('github:logout'),
  githubSetupGitCredentials: () => ipcRenderer.invoke('github:setup-git-credentials'),
  githubGitConfig: (key, value) => ipcRenderer.invoke('github:git-config', key, value),
  githubGetGitConfig: (key) => ipcRenderer.invoke('github:get-git-config', key),
  onGithubLoginProgress: (callback) =>
    createEventListener('github:login-progress', callback as (data: unknown) => void),

  // GitHub Direct PAT (no gh CLI)
  githubDirectAuthStatus: () => ipcRenderer.invoke('github:direct-auth-status'),
  githubDirectLoginToken: (token) => ipcRenderer.invoke('github:direct-login-token', token),
  githubDirectLogout: () => ipcRenderer.invoke('github:direct-logout'),
  githubDirectSetupCredentials: () => ipcRenderer.invoke('github:direct-setup-credentials'),

  // GitCode Integration
  gitcodeGetAuthStatus: () => ipcRenderer.invoke('gitcode:auth-status'),
  gitcodeLoginToken: (token) => ipcRenderer.invoke('gitcode:login-token', token),
  gitcodeLogout: () => ipcRenderer.invoke('gitcode:logout'),

  // Bootstrap lifecycle
  getBootstrapStatus: () => ipcRenderer.invoke('bootstrap:get-status'),
  onBootstrapExtendedReady: (callback) =>
    createEventListener('bootstrap:extended-ready', callback as (data: unknown) => void),

  // Health System
  getHealthStatus: () => ipcRenderer.invoke('health:get-status'),
  getHealthState: () => ipcRenderer.invoke('health:get-state'),
  triggerHealthRecovery: (strategyId, userConsented) =>
    ipcRenderer.invoke('health:trigger-recovery', strategyId, userConsented),
  generateHealthReport: () => ipcRenderer.invoke('health:generate-report'),
  generateHealthReportText: () => ipcRenderer.invoke('health:generate-report-text'),
  exportHealthReport: (filePath) => ipcRenderer.invoke('health:export-report', filePath),
  runHealthCheck: () => ipcRenderer.invoke('health:run-check'),

  // Apps Management
  appList: (filter) => ipcRenderer.invoke('app:list', filter),
  appGet: (appId) => ipcRenderer.invoke('app:get', appId),
  appInstall: (input) => ipcRenderer.invoke('app:install', input),
  appUninstall: (input) => ipcRenderer.invoke('app:uninstall', input),
  appReinstall: (input) => ipcRenderer.invoke('app:reinstall', input),
  appDelete: (input) => ipcRenderer.invoke('app:delete', input),
  appPause: (appId) => ipcRenderer.invoke('app:pause', appId),
  appResume: (appId) => ipcRenderer.invoke('app:resume', appId),
  appTrigger: (appId) => ipcRenderer.invoke('app:trigger', appId),
  appGetState: (appId) => ipcRenderer.invoke('app:get-state', appId),
  appGetActivity: (input) => ipcRenderer.invoke('app:get-activity', input),
  appGetSession: (input) => ipcRenderer.invoke('app:get-session', input),
  appRespondEscalation: (input) => ipcRenderer.invoke('app:respond-escalation', input),
  appUpdateConfig: (input) => ipcRenderer.invoke('app:update-config', input),
  appUpdateFrequency: (input) => ipcRenderer.invoke('app:update-frequency', input),
  appUpdateOverrides: (input) => ipcRenderer.invoke('app:update-overrides', input),
  appUpdateSpec: (input) => ipcRenderer.invoke('app:update-spec', input),
  appGrantPermission: (input) => ipcRenderer.invoke('app:grant-permission', input),
  appRevokePermission: (input) => ipcRenderer.invoke('app:revoke-permission', input),

  // App Import / Export
  appExportSpec: (appId) => ipcRenderer.invoke('app:export-spec', appId),
  appImportSpec: (input) => ipcRenderer.invoke('app:import-spec', input),

  // App Chat
  appChatSend: (request) => ipcRenderer.invoke('app:chat-send', request),
  appChatStop: (appId) => ipcRenderer.invoke('app:chat-stop', appId),
  appChatStatus: (appId) => ipcRenderer.invoke('app:chat-status', appId),
  appChatMessages: (input) => ipcRenderer.invoke('app:chat-messages', input),
  appChatSessionState: (appId) => ipcRenderer.invoke('app:chat-session-state', appId),

  // App Event Listeners
  onAppStatusChanged: (callback) => createEventListener('app:status_changed', callback),
  onAppActivityEntry: (callback) => createEventListener('app:activity_entry:new', callback),
  onAppEscalation: (callback) => createEventListener('app:escalation:new', callback),
  onAppNavigate: (callback) => createEventListener('app:navigate', callback),

  // Remote Server
  remoteServer: {
    add: (server) => ipcRenderer.invoke('remote-server:add', server),
    update: (server) => ipcRenderer.invoke('remote-server:update', server),
    updateAiSource: (serverId, aiSourceId) =>
      ipcRenderer.invoke('remote-server:update-ai-source', serverId, aiSourceId),
    updateModel: (serverId, model) =>
      ipcRenderer.invoke('remote-server:update-model', serverId, model),
    list: () => ipcRenderer.invoke('remote-server:list'),
    deploy: (serverId) => ipcRenderer.invoke('remote-server:deploy', serverId),
    connect: (serverId) => ipcRenderer.invoke('remote-server:connect', serverId),
    disconnect: (serverId) => ipcRenderer.invoke('remote-server:disconnect', serverId),
    delete: (serverId) => ipcRenderer.invoke('remote-server:delete', serverId),
    checkAgent: (serverId) => ipcRenderer.invoke('remote-server:check-agent', serverId),
    deployAgent: (serverId) => ipcRenderer.invoke('remote-server:deploy-agent', serverId),
    startAgent: (serverId) => ipcRenderer.invoke('remote-server:start-agent', serverId),
    stopAgent: (serverId) => ipcRenderer.invoke('remote-server:stop-agent', serverId),
    getAgentLogs: (serverId, lines) =>
      ipcRenderer.invoke('remote-server:get-agent-logs', serverId, lines),
    isAgentRunning: (serverId) => ipcRenderer.invoke('remote-server:is-agent-running', serverId),
    updateAgent: (serverId) => ipcRenderer.invoke('remote-server:update-agent', serverId),
    listSkills: (serverId) => ipcRenderer.invoke('remote-server:list-skills', serverId),
    listSkillFiles: (serverId, skillId) =>
      ipcRenderer.invoke('remote-server:list-skill-files', serverId, skillId),
    readSkillFile: (serverId, skillId, filePath) =>
      ipcRenderer.invoke('remote-server:read-skill-file', serverId, skillId, filePath),
    listTasks: (serverId) => ipcRenderer.invoke('remote-server:list-tasks', serverId),
    subscribeTasks: (serverId) => ipcRenderer.invoke('remote-server:subscribe-tasks', serverId),
    cancelTask: (serverId, taskId) =>
      ipcRenderer.invoke('remote-server:cancel-task', serverId, taskId),
    getUpdateStatus: (serverId) => ipcRenderer.invoke('remote-server:get-update-status', serverId),
    acknowledgeUpdate: (serverId) =>
      ipcRenderer.invoke('remote-server:acknowledge-update', serverId),
    deployOffline: (serverId, platform) =>
      ipcRenderer.invoke('remote-server:deploy-offline', serverId, platform),
    checkOfflineBundle: (platform) =>
      ipcRenderer.invoke('remote-server:check-offline-bundle', platform),
    cancelOperation: (serverId) => ipcRenderer.invoke('remote-server:cancel-operation', serverId),
  },

  // Remote Agent
  remoteAgent: {
    sendMessage: (serverId, message) =>
      ipcRenderer.invoke('remote-agent:send-message', serverId, message),
    chat: (serverId, params) => ipcRenderer.invoke('remote-agent:chat', serverId, params),
    fsList: (serverId, path) => ipcRenderer.invoke('remote-agent:fs-list', serverId, path),
    fsRead: (serverId, path) => ipcRenderer.invoke('remote-agent:fs-read', serverId, path),
    fsWrite: (serverId, path, content) =>
      ipcRenderer.invoke('remote-agent:fs-write', serverId, path, content),
    fsDelete: (serverId, path) => ipcRenderer.invoke('remote-agent:fs-delete', serverId, path),
    checkConnection: (serverId) => ipcRenderer.invoke('remote-agent:check-connection', serverId),
    getMessages: (serverId, sessionId) =>
      ipcRenderer.invoke('remote-agent:get-messages', serverId, sessionId),
  },

  onRemoteAgentStream: (callback) => createEventListener('remote-agent:stream', callback),
  onRemoteAgentComplete: (callback) => createEventListener('remote-agent:complete', callback),
  onRemoteAgentError: (callback) => createEventListener('remote-agent:error', callback),
  onRemoteAgentFsResult: (callback) => createEventListener('remote-agent:fs:result', callback),
  onRemoteTaskUpdate: (callback) => createEventListener('remote-server:task-update', callback),
  onRemoteServerCommandOutput: (callback) =>
    createEventListener('remote-server:command-output', callback),
  onRemoteServerStatusChange: (callback) =>
    createEventListener('remote-server:status-change', callback),
  onRemoteServerDeployProgress: (callback) =>
    createEventListener('remote-server:deploy-progress', callback),
  onRemoteServerUpdateComplete: (callback) =>
    createEventListener('remote-server:update-complete', callback),

  // Store (App Registry)
  storeListApps: (query) => ipcRenderer.invoke('store:list-apps', query),
  storeGetAppDetail: (slug) => ipcRenderer.invoke('store:get-app-detail', slug),
  storeInstall: (input) => ipcRenderer.invoke('store:install', input),
  storeRefresh: () => ipcRenderer.invoke('store:refresh'),
  storeCheckUpdates: () => ipcRenderer.invoke('store:check-updates'),
  storeGetRegistries: () => ipcRenderer.invoke('store:get-registries'),
  storeAddRegistry: (input) => ipcRenderer.invoke('store:add-registry', input),
  storeRemoveRegistry: (registryId) => ipcRenderer.invoke('store:remove-registry', registryId),
  storeToggleRegistry: (input) => ipcRenderer.invoke('store:toggle-registry', input),

  // Skill Management
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillToggle: (skillId, enabled) => ipcRenderer.invoke('skill:toggle', { skillId, enabled }),
  skillUninstall: (skillId) => ipcRenderer.invoke('skill:uninstall', skillId),
  skillExport: (skillId) => ipcRenderer.invoke('skill:export', skillId),
  skillInstall: (input) => ipcRenderer.invoke('skill:install', input),
  skillImportSkills: (input) => ipcRenderer.invoke('skill:import-skills', input),
  skillInstallMulti: (input) => ipcRenderer.invoke('skill:install-multi', input),
  skillUninstallMulti: (input) => ipcRenderer.invoke('skill:uninstall-multi', input),
  skillSyncToRemote: (input) => ipcRenderer.invoke('skill:sync-to-remote', input),
  skillSyncFromRemote: (input) => ipcRenderer.invoke('skill:sync-from-remote', input),
  skillMarketList: (sourceId?: string, page?: number, pageSize?: number) =>
    ipcRenderer.invoke('skill:market:list', sourceId, page, pageSize),
  skillMarketSearch: (query: string, sourceId?: string, page?: number, pageSize?: number) =>
    ipcRenderer.invoke('skill:market:search', query, sourceId, page, pageSize),
  skillMarketSources: () => ipcRenderer.invoke('skill:market:sources'),
  skillMarketResetCache: (sourceId?: string) =>
    ipcRenderer.invoke('skill:market:reset-cache', sourceId),
  skillMarketSetActiveSource: (sourceId: string) =>
    ipcRenderer.invoke('skill:market:set-active', sourceId),
  skillMarketToggleSource: (sourceId, enabled) =>
    ipcRenderer.invoke('skill:market:toggle-source', { sourceId, enabled }),
  skillMarketAddSource: (source: {
    name: string;
    url: string;
    repos?: string[];
    description?: string;
  }) => ipcRenderer.invoke('skill:market:add-source', source),
  skillMarketRemoveSource: (sourceId: string) =>
    ipcRenderer.invoke('skill:market:remove-source', sourceId),
  skillMarketDetail: (skillId: string) => ipcRenderer.invoke('skill:market:detail', skillId),
  skillMarketPushToGitHub: (skillId: string, targetRepo: string, targetPath?: string) =>
    ipcRenderer.invoke('skill:market:push-to-github', skillId, targetRepo, targetPath),
  skillMarketListRepoDirs: (repo: string) =>
    ipcRenderer.invoke('skill:market:list-repo-dirs', repo),
  skillMarketValidateRepo: (repo: string) => ipcRenderer.invoke('skill:market:validate-repo', repo),
  skillMarketPushToGitCode: (skillId: string, targetRepo: string, targetPath?: string) =>
    ipcRenderer.invoke('skill:market:push-to-gitcode', skillId, targetRepo, targetPath),
  skillMarketListGitCodeRepoDirs: (repo: string) =>
    ipcRenderer.invoke('skill:market:list-gitcode-repo-dirs', repo),
  skillMarketValidateGitCodeRepo: (repo: string) =>
    ipcRenderer.invoke('skill:market:validate-gitcode-repo', repo),
  skillMarketSetGitCodeToken: (token: string) =>
    ipcRenderer.invoke('skill:market:set-gitcode-token', token),
  skillMarketPatStatus: () => ipcRenderer.invoke('skill:market:pat-status'),
  skillNetworkProxyStatus: () => ipcRenderer.invoke('skill:network:proxy-status'),
  onSkillMarketFetchProgress: (callback) =>
    createEventListener('skill:market:fetch-progress', callback as (data: unknown) => void),
  skillConfigGet: () => ipcRenderer.invoke('skill:config:get'),
  skillConfigUpdate: (config) => ipcRenderer.invoke('skill:config:update', config),
  skillRefresh: () => ipcRenderer.invoke('skill:refresh'),
  skillGenerate: (input) => ipcRenderer.invoke('skill:generate', input),
  skillFiles: (skillId) => ipcRenderer.invoke('skill:files', skillId),
  skillFileContent: (skillId, filePath) =>
    ipcRenderer.invoke('skill:file-content', skillId, filePath),
  skillFileSave: (skillId, filePath, content) =>
    ipcRenderer.invoke('skill:file-save', skillId, filePath, content),

  // Skill Generator
  skillAnalyzeConversations: (spaceId, conversationIds) =>
    ipcRenderer.invoke('skill:analyze-conversations', spaceId, conversationIds),
  skillCreateTempSession: (options) => ipcRenderer.invoke('skill:create-temp-session', options),
  skillSendTempMessage: (sessionId, message) =>
    ipcRenderer.invoke('skill:send-temp-message', sessionId, message),
  skillCloseTempSession: (sessionId) => ipcRenderer.invoke('skill:close-temp-session', sessionId),
  onSkillTempMessageChunk: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, chunk: any) => {
      callback({ sessionId, chunk });
    };
    ipcRenderer.on('skill:temp-message-chunk', handler);
    return () => {
      ipcRenderer.removeListener('skill:temp-message-chunk', handler);
    };
  },
  onSkillInstallOutput: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      skillId: string,
      output: {
        type: 'stdout' | 'stderr' | 'complete' | 'error';
        content: string;
        targetKey?: string;
      },
    ) => {
      callback({ skillId, output });
    };
    ipcRenderer.on('skill:install-output', handler);
    return () => {
      ipcRenderer.removeListener('skill:install-output', handler);
    };
  },
  onSkillUninstallOutput: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      appId: string,
      output: {
        type: 'stdout' | 'stderr' | 'complete' | 'error';
        content: string;
        targetKey?: string;
      },
    ) => {
      callback({ appId, output });
    };
    ipcRenderer.on('skill:uninstall-output', handler);
    return () => {
      ipcRenderer.removeListener('skill:uninstall-output', handler);
    };
  },
  onSkillSyncOutput: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      skillId: string,
      serverId: string,
      output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
    ) => {
      callback({ skillId, serverId, output });
    };
    ipcRenderer.on('skill:sync-output', handler);
    return () => {
      ipcRenderer.removeListener('skill:sync-output', handler);
    };
  },
  onSkillSyncFromRemoteOutput: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      skillId: string,
      serverId: string,
      output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
    ) => {
      callback({ skillId, serverId, output });
    };
    ipcRenderer.on('skill:sync-from-remote-output', handler);
    return () => {
      ipcRenderer.removeListener('skill:sync-from-remote-output', handler);
    };
  },
  skillConversationList: (relatedSkillId) =>
    ipcRenderer.invoke('skill:conversation:list', relatedSkillId),
  skillConversationGet: (conversationId) =>
    ipcRenderer.invoke('skill:conversation:get', conversationId),
  skillConversationCreate: (title, relatedSkillId) =>
    ipcRenderer.invoke('skill:conversation:create', title, relatedSkillId),
  skillConversationDelete: (conversationId) =>
    ipcRenderer.invoke('skill:conversation:delete', conversationId),
  skillConversationSend: (conversationId, message, metadata) =>
    ipcRenderer.invoke('skill:conversation:send', conversationId, message, metadata),
  skillConversationStop: (conversationId) =>
    ipcRenderer.invoke('skill:conversation:stop', conversationId),
  skillConversationClose: (conversationId) =>
    ipcRenderer.invoke('skill:conversation:close', conversationId),
  fetchWebPageContent: (url) => ipcRenderer.invoke('skill:fetch-webpage', url),
  onSkillConversationChunk: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, conversationId: string, chunk: any) => {
      callback({ conversationId, chunk });
    };
    ipcRenderer.on('skill:conversation-chunk', handler);
    return () => {
      ipcRenderer.removeListener('skill:conversation-chunk', handler);
    };
  },

  // Terminal
  getTerminalWebSocketUrl: (spaceId, conversationId) =>
    ipcRenderer.invoke('system:get-terminal-websocket-url', spaceId, conversationId),
  sendTerminalCommand: (spaceId, conversationId, command) =>
    ipcRenderer.invoke('terminal:send-command', { spaceId, conversationId, command }),
  getTerminalOutput: (spaceId, conversationId, lines) =>
    ipcRenderer.invoke('terminal:get-output', { spaceId, conversationId, lines }),
  generateSkillFromTerminal: (spaceId, conversationId) =>
    ipcRenderer.invoke('skill:generate-from-terminal', { spaceId, conversationId }),

  // Notification (in-app toast)
  onNotificationToast: (callback) => createEventListener('notification:toast', callback),

  // Terminal Agent Commands
  onTerminalAgentCommandStart: (callback) =>
    createEventListener('terminal:agent-command-start', callback),
  onTerminalAgentCommandOutput: (callback) =>
    createEventListener('terminal:agent-command-output', callback),
  onTerminalAgentCommandComplete: (callback) =>
    createEventListener('terminal:agent-command-complete', callback),

  // Hyper Space (Multi-Agent Collaboration)
  createHyperSpace: (params) => ipcRenderer.invoke('hyper-space:create', params),
  getHyperSpaceStatus: (spaceId) => ipcRenderer.invoke('hyper-space:get-status', spaceId),
  addAgentToHyperSpace: (spaceId, agent) =>
    ipcRenderer.invoke('hyper-space:add-agent', { spaceId, agent }),
  removeAgentFromHyperSpace: (spaceId, agentId) =>
    ipcRenderer.invoke('hyper-space:remove-agent', { spaceId, agentId }),
  updateHyperSpaceConfig: (spaceId, config) =>
    ipcRenderer.invoke('hyper-space:update-config', { spaceId, config }),
  getHyperSpaceTasks: (conversationId) =>
    ipcRenderer.invoke('hyper-space:get-tasks', conversationId),
  getHyperSpaceMembers: (spaceId) => ipcRenderer.invoke('hyper-space:get-members', spaceId),

  // TaskBoard API
  getTaskBoard: (spaceId) => ipcRenderer.invoke('hyper-space:get-taskboard', spaceId),
  postTask: (spaceId, input) => ipcRenderer.invoke('hyper-space:post-task', spaceId, input),
  claimTask: (spaceId, taskId) => ipcRenderer.invoke('hyper-space:claim-task', spaceId, taskId),
  updateTaskStatus: (spaceId, taskId, status, result, error) =>
    ipcRenderer.invoke('hyper-space:update-task-status', spaceId, taskId, status, result, error),

  // Persistent Mode API
  setPersistentMode: (spaceId, enabled) =>
    ipcRenderer.invoke('hyper-space:set-persistent-mode', spaceId, enabled),
  getPersistentMode: (spaceId) => ipcRenderer.invoke('hyper-space:get-persistent-mode', spaceId),

  // Permission Forwarding API
  resolvePermission: (spaceId, workerAgentId, requestId, approved) =>
    ipcRenderer.invoke(
      'hyper-space:resolve-permission',
      spaceId,
      workerAgentId,
      requestId,
      approved,
    ),

  // User action logging
  logUserAction: (action: string, detail?: string) =>
    ipcRenderer.invoke('log:user-action', action, detail),
};

contextBridge.exposeInMainWorld('aicoBot', api);

// Expose platform info for cross-platform UI adjustments
const platformInfo = {
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  isLinux: process.platform === 'linux',
};

contextBridge.exposeInMainWorld('platform', platformInfo);

// Expose basic electron IPC for overlay SPA
// This is used by the overlay window which doesn't need the full aicoBot API
const electronAPI = {
  ipcRenderer: {
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    },
    removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
      ipcRenderer.removeListener(channel, callback as (...args: unknown[]) => void);
    },
    send: (channel: string, ...args: unknown[]) => {
      ipcRenderer.send(channel, ...args);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronAPI);

// TypeScript declaration for window.aicoBot and window.platform
declare global {
  interface Window {
    aicoBot: AicoBotAPI;
    platform: {
      platform: 'darwin' | 'win32' | 'linux';
      isMac: boolean;
      isWindows: boolean;
      isLinux: boolean;
    };
    // For overlay SPA - access via contextBridge
    electron?: {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => void;
        removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
        send: (channel: string, ...args: unknown[]) => void;
      };
    };
  }
}
