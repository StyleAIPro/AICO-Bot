/**
 * Agent Module - SDK Configuration Builder
 *
 * Pure functions for building SDK configuration.
 * Centralizes all SDK-related configuration logic to ensure consistency
 * between send-message.ts and session-manager.ts.
 */

import path from 'path';
import os from 'os';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { app } from 'electron';
import {
  ensureOpenAICompatRouter,
  encodeBackendConfig,
  normalizeApiUrl,
} from '../../openai-compat-router';
import type { ApiCredentials } from './types';
import { inferOpenAIWireApi } from './helpers';
import { buildSystemPrompt, AVAILABLE_TOOLS, PRE_APPROVED_TOOLS } from './system-prompt';
import { createCanUseTool } from './permission-handler';
import { sendToRenderer } from './helpers';
import { SkillManager } from '../skill/skill-manager';

// ============================================
// Configuration
// ============================================

/**
 * When true, Anthropic requests route through the local router for interceptor
 * coverage (warmup, preflight, etc.) with zero-conversion passthrough.
 * When false, Anthropic requests go directly to the API via the SDK's built-in
 * HTTP client — no router, no interceptors, no overhead.
 *
 * Toggle this to A/B test proxy overhead vs direct SDK performance.
 * OpenAI/OAuth providers always route through the router regardless of this flag.
 */
const PROXY_ANTHROPIC = true;

// ============================================
// Types
// ============================================

/**
 * Resolved credentials ready for SDK use.
 * This is the output of credential resolution process.
 */
export interface ResolvedSdkCredentials {
  /** Base URL for Anthropic API (may be OpenAI compat router) */
  anthropicBaseUrl: string;
  /** API key for Anthropic API (may be encoded backend config) */
  anthropicApiKey: string;
  /** Model to pass to SDK (may be fake Claude model for compat) */
  sdkModel: string;
  /** User's actual configured model name (for display) */
  displayModel: string;
  /** Context window size in tokens (for compression threshold calculation) */
  contextWindow?: number;
  /** Whether sdkModel is a fake placeholder (setModel should be skipped) */
  isCompatModel?: boolean;
}

/**
 * Parameters for building SDK environment variables
 */
export interface SdkEnvParams {
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  /** User-configured context window size (tokens). Passed as CLAUDE_CODE_AUTO_COMPACT_WINDOW
   *  to the CLI subprocess so its autocompact threshold matches the displayed context. */
  contextWindow?: number;
  /** Display model name for sub-agent model override */
  displayModel?: string;
  /** SDK model name for sub-agent model override */
  sdkModel?: string;
}

/**
 * Parameters for building base SDK options
 */
export interface BaseSdkOptionsParams {
  /** Resolved SDK credentials */
  credentials: ResolvedSdkCredentials;
  /** Working directory for the agent */
  workDir: string;
  /** Path to headless Electron binary */
  electronPath: string;
  /** Space ID */
  spaceId: string;
  /** Conversation ID */
  conversationId: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** Optional stderr handler (for error accumulation) */
  stderrHandler?: (data: string) => void;
  /** Optional MCP servers configuration */
  mcpServers?: Record<string, any> | null;
  /** Maximum tool call turns per message (from config) */
  maxTurns?: number;
  /** Context window size in tokens (for compression threshold calculation) */
  contextWindow?: number;
  /** Optional agent ID for Hyper Space worker routing */
  agentId?: string;
  /** Optional agent name for Hyper Space worker routing */
  agentName?: string;
  /** Additional tools to disallow (merged with the default disallowedTools list) */
  additionalDisallowedTools?: string[];
  /** Whether to allow Agent/Task tool usage (only for Hyper Space Worker context) */
  allowSubagents?: boolean;
  /** Permission trust mode: true = full permissions (skip destructive checks) */
  trustMode?: boolean;
  /** GitHub search environment status for dynamic system prompt */
  ghSearchStatus?: {
    patConfigured: boolean;
    proxyEnabled: boolean;
  };
}

// ============================================
// Credential Resolution
// ============================================

/**
 * Resolve API credentials for SDK use.
 *
 * This function handles the complexity of different providers:
 * - Anthropic: Routed through OpenAI compat router (PROXY_ANTHROPIC=true)
 * - OpenAI/OAuth: Route through OpenAI compat router with encoded config
 *
 * Important: The model is encoded into the apiKey (ANTHROPIC_API_KEY env var)
 * at session creation time. Model changes require session rebuild — they cannot
 * be switched dynamically via setModel(). See config.service.ts getAiSourcesSignature().
 *
 * @param credentials - Raw API credentials from getApiCredentials()
 * @returns Resolved credentials ready for SDK
 */
export async function resolveCredentialsForSdk(
  credentials: ApiCredentials,
): Promise<ResolvedSdkCredentials> {
  const displayModel = credentials.displayModel || credentials.model;

  // Detect whether the backend is native Anthropic or OpenAI-compatible
  // Mirrors remote ClaudeManager.detectBackendType() logic
  const isNativeAnthropic = detectNativeAnthropic(credentials.baseUrl);

  // Route based on URL format, not provider label — OAuth/OpenAI providers may
  // point to Anthropic-format endpoints (e.g. /v1/messages). The URL is the
  // authoritative signal for which wire format the upstream speaks.
  if (isNativeAnthropic) {
    // Native Anthropic — passthrough with zero conversion
    if (PROXY_ANTHROPIC) {
      return resolveAnthropicPassthrough(credentials);
    }
    // Direct path (PROXY_ANTHROPIC = false)
    // SDK appends /v1/messages to base URL — strip if user included it
    const cleanBase = (credentials.baseUrl || '').replace(/\/+$/, '')
      .replace(/\/v\d*\/?messages$/, '')
      .replace(/\/v\d*\/?message$/, '')
      .replace(/\/messages$/, '')
      .replace(/\/message$/, '');
    return {
      anthropicBaseUrl: cleanBase,
      anthropicApiKey: credentials.apiKey,
      sdkModel: credentials.model || 'claude-opus-4-5-20251101',
      displayModel,
      contextWindow: credentials.contextWindow,
    };
  }

  // OpenAI-compatible backend (non-Anthropic provider, or Anthropic provider
  // pointing to a non-Anthropic URL like IP:port) — route through compat router
  const router = await ensureOpenAICompatRouter({ debug: false });

  // Auto-append /v1/chat/completions for bare host URLs (e.g., 192.168.1.100:8080)
  const normalizedUrl = normalizeApiUrl(credentials.baseUrl || '', 'openai');

  const apiType =
    credentials.apiType ||
    (credentials.provider === 'oauth'
      ? 'chat_completions'
      : inferOpenAIWireApi(credentials.baseUrl));

  const anthropicApiKey = encodeBackendConfig({
    url: normalizedUrl,
    key: credentials.apiKey,
    model: credentials.model,
    headers: credentials.customHeaders,
    apiType,
    forceStream: credentials.forceStream,
    filterContent: credentials.filterContent,
    useProxy: credentials.useProxy,
  });

  console.log(
    `[SDK Config] ${credentials.provider} provider: routing via ${router.baseUrl}, apiType=${apiType}`,
  );

  return {
    anthropicBaseUrl: router.baseUrl,
    anthropicApiKey,
    sdkModel: 'claude-sonnet-4-6',
    displayModel,
    contextWindow: credentials.contextWindow,
    isCompatModel: true,
  };
}

/**
 * Detect whether the backend URL is a native Anthropic API.
 * Mirrors remote ClaudeManager.detectBackendType() logic.
 */
function detectNativeAnthropic(baseUrl?: string): boolean {
  if (!baseUrl) return true;
  // Normalize trailing slash for consistent matching
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.includes('api.anthropic.com')) return true;
  if (normalized.includes('/anthropic')) return true;
  if (normalized.endsWith('/v1/messages') || normalized.endsWith('/v1/message') ||
      normalized.endsWith('/messages') || normalized.endsWith('/message')) return true;
  return false;
}

/**
 * Resolve Anthropic credentials via local router passthrough (experimental).
 * Isolated from the main path — only called for native Anthropic backends
 * when PROXY_ANTHROPIC = true.
 */
async function resolveAnthropicPassthrough(
  credentials: ApiCredentials,
): Promise<ResolvedSdkCredentials> {
  const router = await ensureOpenAICompatRouter({ debug: false });

  // 确保 baseUrl 存在，如果不存在则使用默认值
  const baseUrl = credentials.baseUrl || 'https://api.anthropic.com';
  // SDK appends /v1/messages to ANTHROPIC_BASE_URL automatically.
  // Strip these suffixes if user included them to avoid duplication.
  const cleanUrl = baseUrl.replace(/\/+$/, '')
    .replace(/\/v\d*\/?messages$/, '')
    .replace(/\/v\d*\/?message$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/message$/, '');
  const configUrl = cleanUrl + '/v1/messages';

  const anthropicApiKey = encodeBackendConfig({
    url: configUrl,
    key: credentials.apiKey,
    model: credentials.model,
    headers: credentials.customHeaders,
    apiType: 'anthropic_passthrough',
    forceStream: credentials.forceStream,
    filterContent: credentials.filterContent,
    useProxy: credentials.useProxy,
  });

  // Check if upstream is the actual Anthropic API or a direct proxy.
  // For internal/custom models that happen to serve /v1/messages, use a compat
  // model name so the SDK enables extended thinking (the SDK only enables thinking
  // for models it recognizes; custom model names aren't in its internal database).
  // The router's passthrough handler overrides the model before forwarding upstream,
  // so the real model name is preserved in the actual API request.
  const isActualAnthropicApi =
    baseUrl.includes('api.anthropic.com') || baseUrl.includes('/anthropic');
  const useCompatModel = !isActualAnthropicApi;

  console.log(
    `[SDK Config] Anthropic passthrough: routing via ${router.baseUrl}${useCompatModel ? ' (compat model for thinking support)' : ''}`,
  );

  return {
    anthropicBaseUrl: router.baseUrl,
    anthropicApiKey,
    sdkModel: useCompatModel ? 'claude-sonnet-4-6' : (credentials.model || 'claude-opus-4-5-20251101'),
    displayModel: credentials.displayModel || credentials.model,
    contextWindow: credentials.contextWindow,
    isCompatModel: useCompatModel ? true : undefined,
  };
}

// ============================================
// Sandbox Settings (written to settings.json)
// ============================================

/**
 * Sandbox configuration
 *
 * Sandbox is enabled primarily for performance optimization (skips some runtime checks).
 * Network and filesystem access are intentionally permissive - the goal is not strict
 * security isolation, but rather to enable SDK's internal optimizations.
 *
 * Note: Do NOT add `network.allowedDomains` config unless you actually need domain filtering.
 * Setting this array (even to ['*']) triggers SDK's network proxy infrastructure, which:
 *   - Starts HTTP + SOCKS proxy servers (performance overhead)
 *   - Routes all network requests through the proxy (added latency)
 *   - Has a bug where '*' wildcard is not properly handled (causes false blocks)
 *
 * Security note: SDK has built-in filesystem restrictions (e.g., protecting AICO-Bot config files)
 * that are separate from these sandbox settings.
 */
const SANDBOX_CONFIG = {
  enabled: false,
  autoAllowBashIfSandboxed: true,
  // No network config → proxy servers won't start → no performance overhead
};
let sandboxSettingsWritten = false;

/**
 * Merge skill directories from multiple sourceDirs into targetDir.
 * For duplicate skill names, the one with the most recent modification time wins.
 * Creates individual junctions in targetDir pointing to the winning source directories.
 */

function mergeSkillsDirs(sourceDirs: string[], targetDir: string): void {
  // Collect candidates: skillName -> { sourcePath, mtime }
  const candidates = new Map<string, { sourcePath: string; mtime: number }>();

  for (const sourceDir of sourceDirs) {
    try {
      if (!existsSync(sourceDir)) continue;
      const entries = readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.disabled-')) continue;
        const sourcePath = path.join(sourceDir, entry.name);
        try {
          // Skip disabled skills (META.json.enabled === false)
          const metaPath = path.join(sourcePath, 'META.json');
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            if (meta.enabled === false) continue;
          } catch {
            // META.json missing or invalid — not a fatal error, proceed
          }

          const stat = statSync(sourcePath);
          const mtime = stat.mtimeMs;
          const existing = candidates.get(entry.name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(entry.name, { sourcePath, mtime });
          }
        } catch {
          // stat failed, skip
        }
      }
    } catch (err) {
      console.warn('[SDK Config] Failed to read source dir:', sourceDir, err);
    }
  }

  // Clean up existing entries in targetDir that no longer have a source.
  // Must handle both junctions (symlinks) and real directories — unlinkSync
  // only works for the former; rmSync is needed for the latter.
  try {
    if (existsSync(targetDir)) {
      const existingEntries = readdirSync(targetDir, { withFileTypes: true });
      for (const entry of existingEntries) {
        // On Windows, junctions are reported as symlinks (not directories)
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const targetPath = path.join(targetDir, entry.name);
        const shouldRemove = entry.name.startsWith('.disabled-') || !candidates.has(entry.name);
        if (!shouldRemove) continue;
        try {
          const st = lstatSync(targetPath);
          if (st.isSymbolicLink()) {
            unlinkSync(targetPath);
          } else {
            rmSync(targetPath, { recursive: true, force: true });
          }
          console.debug(`[SDK Config] Removed stale entry: ${entry.name}`);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  // Create/update junctions for all winning candidates
  for (const [name, { sourcePath }] of candidates) {
    const targetPath = path.join(targetDir, name);
    // Remove existing link/dir to recreate with the winning source
    try {
      const st = lstatSync(targetPath);
      if (st.isSymbolicLink()) {
        unlinkSync(targetPath);
      } else {
        rmSync(targetPath, { recursive: true, force: true });
      }
    } catch {
      // doesn't exist, proceed to create
    }
    try {
      symlinkSync(sourcePath, targetPath, 'junction');
      console.debug(`[SDK Config] Linked skill: ${name} -> ${sourcePath}`);
    } catch (err) {
      console.warn(`[SDK Config] Failed to link skill ${name}:`, err);
    }
  }
}

/**
 * Ensure sandbox config exists in CLAUDE_CONFIG_DIR/settings.json.
 *
 * By writing sandbox to the userSettings file, the CLI reads it natively
 * without needing --settings flag. This avoids the CLI writing a temp file
 * to $TMPDIR and chokidar watching the entire tmpdir (which crashes on
 * macOS due to Unix socket files like CloudClient).
 *
 * Runs once per process lifetime — subsequent calls are no-ops.
 */
function ensureSandboxSettings(configDir: string): void {
  if (sandboxSettingsWritten) return;
  mkdirSync(configDir, { recursive: true });
  const settingsPath = path.join(configDir, 'settings.json');
  try {
    let settings: Record<string, any> = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
    let dirty = false;
    if (JSON.stringify(settings.sandbox) !== JSON.stringify(SANDBOX_CONFIG)) {
      settings.sandbox = SANDBOX_CONFIG;
      dirty = true;
    }
    if (settings.skipWebFetchPreflight !== true) {
      settings.skipWebFetchPreflight = true;
      dirty = true;
    }
    if (dirty) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.error('[SDK Config] Failed to write sandbox settings:', err);
  }
  sandboxSettingsWritten = true;
}

// ============================================
// Environment Variables
// ============================================

/**
 * Prefixes to strip from inherited env before spawning CC subprocess.
 * Prevents leaked vars (ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, CLAUDE_CODE_SSE_PORT, etc.)
 * from overriding AICO-Bot's explicit configuration.
 */
const AI_SDK_ENV_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'CLAUDE_'];

/**
 * Specific env vars to strip from inherited env before spawning CC subprocess.
 * These are vars that don't match the prefix patterns but should still be removed.
 */
const AI_SDK_ENV_VARS_TO_STRIP = ['CLAUDECODE'];

/**
 * Immediately refresh the merged skill directories by re-executing mergeSkillsDirs.
 * Called after toggleSkill to ensure configSkillsDir junctions are up-to-date,
 * without waiting for the next SDK session creation.
 */
export function refreshSkillDirectories(): void {
  const agentsDir = path.join(os.homedir(), '.agents');
  const skillsDir = path.join(agentsDir, 'skills');
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const configSkillsDir = path.join(agentsDir, 'claude-config', 'skills');
  mergeSkillsDirs([skillsDir, claudeSkillsDir], configSkillsDir);
  hideDisabledSkillsInSource(skillsDir);
  hideDisabledSkillsInSource(claudeSkillsDir);
}

/**
 * Build a system prompt section listing disabled skills.
 * This tells the LLM not to use or invoke these skills, providing natural-language
 * enforcement on top of the code-level canUseTool deny.
 */
function buildDisabledSkillsPrompt(): string {
  const disabledIds = SkillManager.getGlobalDisabledSkillIds();
  if (disabledIds.size === 0) return '';
  const list = Array.from(disabledIds).map((id) => `/${id}`).join(', ');
  return (
    `\n\nIMPORTANT: The following skills are DISABLED and must NOT be used or invoked under any circumstances: ${list}. ` +
    `Do not call the Skill tool for these commands. Ignore any system-reminder that lists them as available.\n`
  );
}

/**
 * Hide disabled skills in a source directory by renaming to .disabled-<name>.
 * This prevents the SDK's project walk-up (from cwd upward) from discovering
 * disabled skills in ~/.claude/skills/ which bypasses the managed configSkillsDir.
 */
function hideDisabledSkillsInSource(sourceDir: string): void {
  if (!existsSync(sourceDir)) return;
  try {
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(sourceDir, entry.name);

      if (!entry.name.startsWith('.disabled-')) {
        // Check if this skill is disabled → hide it
        const metaPath = path.join(sourcePath, 'META.json');
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          if (meta.enabled === false) {
            const hiddenPath = path.join(sourceDir, `.disabled-${entry.name}`);
            if (!existsSync(hiddenPath)) {
              renameSync(sourcePath, hiddenPath);
              console.debug(`[SDK Config] Hidden disabled skill: ${entry.name}`);
            }
          }
        } catch {
          // META.json missing or invalid, skip
        }
      } else {
        // .disabled-<name> → check if it should be restored
        const metaPath = path.join(sourcePath, 'META.json');
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          if (meta.enabled !== false) {
            const originalName = entry.name.slice('.disabled-'.length);
            const restoredPath = path.join(sourceDir, originalName);
            if (!existsSync(restoredPath)) {
              renameSync(sourcePath, restoredPath);
              console.debug(`[SDK Config] Restored enabled skill: ${originalName}`);
            }
          }
        } catch {
          // META.json missing, skip
        }
      }
    }
  } catch (err) {
    console.warn('[SDK Config] Failed to hide disabled skills in:', sourceDir, err);
  }
}

/**
 * Copy of process.env with all AI SDK variables removed.
 */
export function getCleanUserEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (AI_SDK_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
    // Also strip specific vars that don't match prefixes
    if (AI_SDK_ENV_VARS_TO_STRIP.includes(key)) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Build env for CC subprocess.
 * Inherits user env (PATH, HOME, SSH, proxy, etc.) for toolchain compat,
 * strips AI SDK vars, then sets exactly what CC needs.
 */
export function buildSdkEnv(params: SdkEnvParams): Record<string, string | number> {
  const env: Record<string, string | number | undefined> = {
    ...getCleanUserEnv(),

    // Electron: run as Node.js process
    ELECTRON_RUN_AS_NODE: 1,
    ELECTRON_NO_ATTACH_CONSOLE: 1,

    // API credentials
    ANTHROPIC_API_KEY: params.anthropicApiKey,
    ANTHROPIC_BASE_URL: params.anthropicBaseUrl,

    // AICO-Bot's unified config dir at ~/.agents/
    // Skills are stored in ~/.agents/skills/ and ~/.claude/skills/
    // SDK config in ~/.agents/claude-config/
    CLAUDE_CONFIG_DIR: (() => {
      const agentsDir = path.join(os.homedir(), '.agents');
      const configDir = path.join(agentsDir, 'claude-config');
      const skillsDir = path.join(agentsDir, 'skills');
      const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
      const configSkillsDir = path.join(configDir, 'skills');

      // Ensure directories exist
      if (!existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
      }
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true });
      }
      if (!existsSync(claudeSkillsDir)) {
        mkdirSync(claudeSkillsDir, { recursive: true });
      }

      // Setup configSkillsDir to merge skills from both source directories
      // SDK looks for skills in $CLAUDE_CONFIG_DIR/skills/
      // We need to make both ~/.agents/skills/ and ~/.claude/skills/ visible
      if (!existsSync(configSkillsDir)) {
        // First time: create a real directory and link each skill individually
        mkdirSync(configSkillsDir, { recursive: true });
        console.debug('[SDK Config] Created skills directory:', configSkillsDir);
      }

      // If configSkillsDir is a junction (legacy), remove it and recreate as real dir
      const configSkillsStat = existsSync(configSkillsDir) ? lstatSync(configSkillsDir) : null;
      if (configSkillsStat && configSkillsStat.isSymbolicLink()) {
        try {
          unlinkSync(configSkillsDir);
          mkdirSync(configSkillsDir, { recursive: true });
          console.debug('[SDK Config] Replaced legacy junction with directory:', configSkillsDir);
        } catch (err) {
          console.warn('[SDK Config] Failed to replace legacy junction:', err);
        }
      }

      // Merge skills from both directories into configSkillsDir
      // For duplicates, the one with the most recent modification time wins
      mergeSkillsDirs([skillsDir, claudeSkillsDir], configSkillsDir);

      // Create .claude/skills junction inside configDir for SDK project-level skill discovery.
      // The SDK in "bare" mode (SDK subprocess) only loads skills from <add-dir>/.claude/skills/,
      // NOT from the user-level configDir/skills/. By creating this junction and passing configDir
      // as an additionalDirectory, the CLI discovers our merged skills through the project path.
      const dotClaudeDir = path.join(configDir, '.claude');
      const dotClaudeSkillsDir = path.join(dotClaudeDir, 'skills');
      if (!existsSync(dotClaudeDir)) {
        mkdirSync(dotClaudeDir, { recursive: true });
      }
      if (!existsSync(dotClaudeSkillsDir)) {
        try {
          symlinkSync(configSkillsDir, dotClaudeSkillsDir, 'junction');
          console.debug('[SDK Config] Created .claude/skills junction ->', configSkillsDir);
        } catch (err) {
          console.warn('[SDK Config] Failed to create .claude/skills junction:', err);
        }
      }

      ensureSandboxSettings(configDir);
      return configDir;
    })(),

    // Localhost bypasses proxy (for OpenAI compat router)
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',

    // Disable non-essential traffic
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_COST_WARNINGS: '1',
    CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK: '1',

    // Performance: skip warmup calls + raise V8 heap ceiling
    CLAUDE_CODE_REMOTE: 'true',

    // Context window: tell CLI subprocess the real context window so autocompact
    // triggers at the correct threshold (default ~200K, user may configure 1M+).
    // Without this, CLI uses its internal model DB default and compresses too early.
    ...(params.contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: params.contextWindow } : {}),

    // Performance: skip file snapshot I/O (AICO-Bot doesn't expose /rewind)
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',

    // Windows: pass through Git Bash path (set by git-bash.service during startup)
    // This was stripped by getCleanUserEnv() along with all CLAUDE_* vars
    ...(process.env.CLAUDE_CODE_GIT_BASH_PATH
      ? { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH }
      : {}),
  };

  // Override sub-agent model to inherit parent session model.
  // Built-in agents like "Explore" hardcode model: "haiku", which the SDK resolves
  // to claude-haiku-4-5-20251001. Locally the OpenAI Compat Router replaces this with
  // BackendConfig.model (request-handler.ts:375), but setting this env var explicitly
  // ensures consistency and avoids unnecessary round-trips through the router for model
  // substitution. Highest priority in SDK's Ik6() model resolution function.
  const subagentModel = params.displayModel || params.sdkModel;
  if (subagentModel) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;
  }

  return env as Record<string, string | number>;
}

// ============================================
// SDK Options Builder
// ============================================

/**
 * Build base SDK options.
 *
 * This constructs the common SDK options used by both sendMessage and ensureSessionWarm.
 * Does NOT include dynamic configurations like AI Browser or Thinking mode.
 *
 * @param params - SDK options parameters
 * @returns Base SDK options object
 */
export function buildBaseSdkOptions(params: BaseSdkOptionsParams): Record<string, any> {
  const {
    credentials,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    abortController,
    stderrHandler,
    mcpServers,
    contextWindow,
    agentId,
    agentName,
    trustMode,
  } = params;

  console.log(
    `[SDK Config] buildBaseSdkOptions: workDir="${workDir}", spaceId="${spaceId}", contextWindow=${contextWindow || 'default'}`,
  );

  // Build environment variables
  const env = buildSdkEnv({
    anthropicApiKey: credentials.anthropicApiKey,
    anthropicBaseUrl: credentials.anthropicBaseUrl,
    contextWindow,
    displayModel: credentials.displayModel,
    sdkModel: credentials.sdkModel,
  });

  // Build base options
  const sdkOptions: Record<string, any> = {
    model: credentials.sdkModel,
    cwd: workDir,
    abortController,
    env,
    stderr:
      stderrHandler ||
      ((data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data);
      }),
    // Use SDK's 'claude_code' preset (includes skills injection) with AICO-Bot customizations appended
    systemPrompt: {
      type: 'preset' as const,
      append: buildDisabledSkillsPrompt() + buildSystemPrompt({ workDir, modelInfo: credentials.displayModel, ghSearchStatus: params.ghSearchStatus }),
    },
    maxTurns: params.maxTurns ?? 50,
    allowedTools: [...PRE_APPROVED_TOOLS],
    // Explicitly disable WebFetch and WebSearch - use ai-browser and gh-search instead
    disallowedTools: ['WebFetch', 'WebSearch', ...(params.additionalDisallowedTools ?? [])],
    // Enable both 'user' and 'project' setting sources for skill loading.
    // The SDK in bare mode (Y9() check) only loads skills via the project path
    // (<add-dir>/.claude/skills/), not the user path. We pass configDir as an
    // additionalDirectory and create a .claude/skills junction inside it.
    settingSources: ['user', 'project'],
    additionalDirectories: [String(env.CLAUDE_CONFIG_DIR)],
    permissionMode: 'default' as const,
    canUseTool: createCanUseTool({
      sendToRenderer,
      spaceId,
      conversationId,
      agentId,
      agentName,
      trustMode,
      allowSubagents: params.allowSubagents,
    }),
    // Requires SDK patch: enable token-level streaming (stream_event)
    includePartialMessages: true,
    executable: electronPath,
    executableArgs: ['--no-warnings'],
    // Sandbox config is written to CLAUDE_CONFIG_DIR/settings.json (see ensureSandboxSettings)
    // instead of passing via SDK's sandbox option → --settings flag → tmpdir temp file.
    // This avoids CLI creating a temp file and chokidar watching the entire tmpdir.

    // Context compaction is controlled via CLAUDE_CODE_AUTO_COMPACT_WINDOW env var
    // (set in buildSdkEnv). The SDK's compactThreshold/modelContextWindow options are
    // NOT part of SDKSessionOptions and are silently ignored.
  };

  // Add MCP servers if provided
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    // createSdkMcpServer() returns objects with a live McpServer instance that
    // contains circular references. The SDK internally JSON.stringify's the
    // options during initialization. Add a toJSON method to each config so
    // serialization skips the non-serializable instance.
    for (const config of Object.values(mcpServers)) {
      const obj = config as any;
      if (obj.instance != null && typeof obj.toJSON !== 'function') {
        obj.toJSON = () => {
          const { instance, ...rest } = obj;
          return rest;
        };
      }
    }
    sdkOptions.mcpServers = mcpServers;
  }

  console.log(
    `[SDK Config] SDK options: systemPrompt=${JSON.stringify(sdkOptions.systemPrompt)?.slice(0, 80)}, settingSources=${JSON.stringify(sdkOptions.settingSources)}, additionalDirs=${JSON.stringify(sdkOptions.additionalDirectories)}, CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`,
  );

  return sdkOptions;
}
