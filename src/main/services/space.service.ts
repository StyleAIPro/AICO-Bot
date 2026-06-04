/**
 * Space Service - Manages workspaces/spaces
 *
 * Architecture:
 * - spaces-index.json (v3) stores space registration info (name/icon/path/timestamps)
 * - Preferences are NOT stored in the index — they live in per-space meta.json
 * - Module-level registry Map is the in-memory working copy of the index
 * - AICO-Bot temp space is unified into the registry (no special branches)
 * - Lazy-loaded on first access; auto-migrates from v1/v2 formats if needed
 * - Mutations (create/update/delete) update both memory and disk atomically
 * - listSpaces() is pure memory read — zero disk I/O after startup
 * - getSpace() is pure memory read — zero disk I/O (no preferences)
 * - getSpaceWithPreferences() loads preferences from meta.json on demand (for IPC/UI only)
 * - listSpaces() validates paths in batch; invalid entries are cleaned up
 */

import { shell } from 'electron';
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  renameSync,
} from 'fs';
import { getAicoBotDir, getTempSpacePath, getSpacesDir } from './config.service';
import { v4 as uuidv4 } from 'uuid';
import type {
  AgentConfig,
  OrchestrationConfig,
  SpaceType,
  CreateHyperSpaceInput,
} from '../../shared/types/hyper-space';
import { createOrchestrationConfig } from '../../shared/types/hyper-space';
import { agentOrchestrator } from './agent/orchestrator';
import { closeSessionsBySpaceId } from './agent/session-manager';
import { destroySpaceCache } from './file-watcher/artifact-cache.service';

// Re-export config helper for backward compatibility with existing imports
export { getSpacesDir } from './config.service';

// ============================================================================
// Types
// ============================================================================

interface Space {
  id: string;
  name: string;
  icon: string;
  path: string;
  isTemp: boolean;
  createdAt: string;
  updatedAt: string;
  preferences?: SpacePreferences;
  workingDir?: string; // Project directory for custom spaces (agent cwd, artifacts, file explorer)

  // Remote Claude support
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
  remotePath?: string;
  useSshTunnel?: boolean; // Use SSH port forwarding instead of direct WebSocket connection
  systemPrompt?: string; // Custom system prompt for remote spaces

  // Hyper Space support
  spaceType?: SpaceType;
  agents?: AgentConfig[];
  orchestration?: OrchestrationConfig;
}

interface SpaceLayoutPreferences {
  artifactRailExpanded?: boolean;
  chatWidth?: number;
}

interface SpacePreferences {
  layout?: SpaceLayoutPreferences;
}

interface SpaceMeta {
  id: string;
  name: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
  preferences?: SpacePreferences;
  workingDir?: string; // Project directory for custom spaces

  // Remote Claude support
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
  remotePath?: string;
  useSshTunnel?: boolean; // Use SSH port forwarding instead of direct WebSocket connection
  systemPrompt?: string; // Custom system prompt for remote spaces

  // Hyper Space support
  spaceType?: SpaceType;
  agents?: AgentConfig[];
  orchestration?: OrchestrationConfig;
}

// ============================================================================
// Space Index (v3) — id -> space registration info (no preferences)
// ============================================================================

interface SpaceIndexEntry {
  path: string;
  name: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
  workingDir?: string;
  isTemp?: boolean; // true only for aico-bot-temp (not persisted to disk)

  // Remote Claude support
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
  remotePath?: string;
  useSshTunnel?: boolean; // Use SSH port forwarding instead of direct WebSocket connection
  systemPrompt?: string; // Custom system prompt for remote spaces

  // Hyper Space support
  spaceType?: SpaceType;
  agents?: AgentConfig[];
  orchestration?: OrchestrationConfig;
}

interface SpaceIndexV3 {
  version: 3;
  spaces: Record<string, SpaceIndexEntry>;
}

// Module-level registry: in-memory working copy of spaces-index.json
let registry: Map<string, SpaceIndexEntry> | null = null;

/** For testing only — reset the in-memory registry so the next read reloads from disk */
export function _resetSpaceRegistry(): void {
  registry = null;
}

function getSpaceIndexPath(): string {
  return join(getAicoBotDir(), 'spaces-index.json');
}

/**
 * Get the registry Map (lazy-loaded).
 * First call loads from disk and auto-migrates v1/v2 formats if needed.
 */
function getRegistry(): Map<string, SpaceIndexEntry> {
  if (!registry) {
    registry = loadSpaceIndex();
  }
  return registry;
}

/**
 * Build a SpaceIndexEntry from a SpaceMeta + path (for migration only).
 */
function metaToEntry(meta: SpaceMeta, spacePath: string): SpaceIndexEntry {
  return {
    path: spacePath,
    name: meta.name,
    icon: meta.icon,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    workingDir: meta.workingDir,
    // Include remote Claude fields
    claudeSource: meta.claudeSource,
    remoteServerId: meta.remoteServerId,
    remotePath: meta.remotePath,
    useSshTunnel: meta.useSshTunnel,
    systemPrompt: meta.systemPrompt,
    // Include Hyper Space fields
    spaceType: meta.spaceType,
    agents: meta.agents,
    orchestration: meta.orchestration,
  };
}

/**
 * Load space index from disk. Handles v3 (direct), v2 (migration), v1/missing (full scan).
 * Always registers aico-bot-temp into the returned map.
 */
function loadSpaceIndex(): Map<string, SpaceIndexEntry> {
  const indexPath = getSpaceIndexPath();
  const map = new Map<string, SpaceIndexEntry>();

  // Try to read existing file
  let raw: Record<string, unknown> | null = null;
  if (existsSync(indexPath)) {
    try {
      raw = JSON.parse(readFileSync(indexPath, 'utf-8'));
    } catch {
      console.warn('[Space] spaces-index.json corrupted, will rebuild');
    }
  }

  // v3: direct load
  if (raw && raw.version === 3 && raw.spaces && typeof raw.spaces === 'object') {
    const spaces = raw.spaces as Record<string, SpaceIndexEntry>;
    for (const [id, entry] of Object.entries(spaces)) {
      if (entry && typeof entry.path === 'string' && typeof entry.name === 'string') {
        map.set(id, entry);
      }
    }
    console.log(`[Space] Index v3 loaded: ${map.size} spaces`);
    registerAicoBotTemp(map);
    return map;
  }

  // v2: one-time migration (read each meta.json once)
  if (raw && raw.version === 2 && raw.spaces && typeof raw.spaces === 'object') {
    console.log('[Space] Migrating space index v2 -> v3...');
    const v2Spaces = raw.spaces as Record<string, { path: string }>;
    for (const [id, v2Entry] of Object.entries(v2Spaces)) {
      if (!v2Entry || typeof v2Entry.path !== 'string') continue;
      const meta = tryReadMeta(v2Entry.path);
      if (meta) {
        map.set(id, metaToEntry(meta, v2Entry.path));
      }
    }
    persistIndex(map);
    console.log(`[Space] Index v3 migration complete: ${map.size} spaces`);
    registerAicoBotTemp(map);
    return map;
  }

  // v1 or missing: one-time migration via full scan
  console.log('[Space] Migrating space index to v3 (full scan)...');
  const oldCustomPaths: string[] = Array.isArray((raw as Record<string, unknown>)?.customPaths)
    ? (raw as { customPaths: string[] }).customPaths
    : [];

  // Scan default spaces directory
  const spacesDir = getSpacesDir();
  if (existsSync(spacesDir)) {
    try {
      for (const dir of readdirSync(spacesDir)) {
        const spacePath = join(spacesDir, dir);
        try {
          if (!statSync(spacePath).isDirectory()) continue;
        } catch {
          continue;
        }
        const meta = tryReadMeta(spacePath);
        if (meta) {
          map.set(meta.id, metaToEntry(meta, spacePath));
        }
      }
    } catch (error) {
      console.error('[Space] Error scanning spaces directory:', error);
    }
  }

  // Scan old custom paths
  for (const customPath of oldCustomPaths) {
    if (existsSync(customPath)) {
      const meta = tryReadMeta(customPath);
      if (meta && !map.has(meta.id)) {
        map.set(meta.id, metaToEntry(meta, customPath));
      }
    }
  }

  // Persist v3 format
  persistIndex(map);
  console.log(`[Space] Index v3 migration complete: ${map.size} spaces`);
  registerAicoBotTemp(map);
  return map;
}

/**
 * Register aico-bot-temp into the registry (in-memory only, never persisted to index).
 */
function registerAicoBotTemp(map: Map<string, SpaceIndexEntry>): void {
  const tempPath = getTempSpacePath();
  const now = new Date().toISOString();
  map.set('aico-bot-temp', {
    path: tempPath,
    name: 'AICO Space',
    icon: 'sparkles',
    createdAt: now,
    updatedAt: now,
    isTemp: true,
  });
}

/**
 * Try to read SpaceMeta from a path. Returns null on any failure.
 */
function tryReadMeta(spacePath: string): SpaceMeta | null {
  const metaPath = join(spacePath, '.aico-bot', 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Persist the registry Map to disk as v3 (atomic write via tmp + rename).
 * Excludes aico-bot-temp (isTemp entries are memory-only).
 */
function persistIndex(map: Map<string, SpaceIndexEntry>): void {
  // Filter out aico-bot-temp before persisting
  const persistable: Record<string, SpaceIndexEntry> = {};
  for (const [id, entry] of map) {
    if (!entry.isTemp) {
      persistable[id] = entry;
    }
  }

  const data: SpaceIndexV3 = {
    version: 3,
    spaces: persistable,
  };
  const indexPath = getSpaceIndexPath();
  const tmpPath = indexPath + '.tmp';
  try {
    // Ensure parent directory exists
    const dir = getAicoBotDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, indexPath);
  } catch (error) {
    console.error('[Space] Failed to persist index:', error);
    // Clean up tmp file if rename failed
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

// ============================================================================
// Core Space Functions
// ============================================================================

/**
 * Build a Space object from a registry entry (without preferences).
 */
function entryToSpace(id: string, entry: SpaceIndexEntry): Space {
  return {
    id,
    name: entry.name,
    icon: entry.icon,
    path: entry.path,
    isTemp: !!entry.isTemp,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    workingDir: entry.workingDir,
    claudeSource: entry.claudeSource || 'local',
    remoteServerId: entry.remoteServerId,
    remotePath: entry.remotePath || '/home',
    useSshTunnel: entry.useSshTunnel || false, // Default to false for old spaces
    systemPrompt: entry.systemPrompt,
    // Hyper Space fields
    spaceType: entry.spaceType || (entry.claudeSource === 'remote' ? 'remote' : 'local'),
    agents: entry.agents,
    orchestration: entry.orchestration,
  };
}

/**
 * Build a Space object with preferences loaded from meta.json.
 */
function entryToSpaceWithPreferences(id: string, entry: SpaceIndexEntry): Space {
  const space = entryToSpace(id, entry);
  const meta = tryReadMeta(entry.path);
  if (meta?.preferences) {
    space.preferences = meta.preferences;
  }
  // Load remote configuration
  space.claudeSource = meta.claudeSource || entry.claudeSource || 'local';
  space.remoteServerId = meta.remoteServerId || entry.remoteServerId;
  space.remotePath = meta.remotePath || entry.remotePath || '/home';
  space.useSshTunnel = meta.useSshTunnel ?? entry.useSshTunnel ?? false; // Default to false
  space.systemPrompt = meta.systemPrompt || entry.systemPrompt;
  return space;
}

/**
 * Get AICO-Bot temp space. Delegates to unified getSpace().
 */
export function getAicoBotSpace(): Space {
  return getSpace('aico-bot-temp')!;
}

/**
 * Get a specific space by ID. Pure memory read from registry — zero disk I/O.
 * Does NOT include preferences. Use getSpaceWithPreferences() if you need them.
 */
export function getSpace(spaceId: string): Space | null {
  const entry = getRegistry().get(spaceId);
  if (!entry) return null;
  return entryToSpace(spaceId, entry);
}

/**
 * Get a specific space with preferences loaded from meta.json (single disk read).
 * Use this only when preferences are needed (IPC/UI layer).
 */
export function getSpaceWithPreferences(spaceId: string): Space | null {
  const entry = getRegistry().get(spaceId);
  if (!entry) return null;
  return entryToSpaceWithPreferences(spaceId, entry);
}

/**
 * List all spaces. Pure memory read — zero disk I/O.
 * Validates paths in batch; removes invalid entries.
 * Does NOT include preferences (not needed for dropdown display).
 */
export function listSpaces(): Space[] {
  const spaces: Space[] = [];
  const invalidIds: string[] = [];

  for (const [id, entry] of getRegistry()) {
    if (entry.isTemp) continue; // aico-bot-temp is returned via getAicoBotSpace()
    if (isSkillSpace(id)) continue; // skill space is hidden from the list

    if (!existsSync(entry.path)) {
      invalidIds.push(id);
      continue;
    }
    spaces.push(entryToSpace(id, entry));
  }

  // Batch cleanup invalid entries
  if (invalidIds.length > 0) {
    for (const id of invalidIds) {
      console.warn(`[Space] Space ${id} path invalid, removing from index`);
      getRegistry().delete(id);
    }
    persistIndex(getRegistry());
  }

  spaces.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  console.log('[Space] listSpaces: count=%d', spaces.length);
  return spaces;
}

/**
 * Get all valid space paths (for security checks).
 * Pure memory read from registry — zero disk I/O.
 */
export function getAllSpacePaths(): string[] {
  const paths: string[] = [];

  for (const [, entry] of getRegistry()) {
    paths.push(entry.path);
    if (entry.workingDir) {
      paths.push(entry.workingDir);
    }
  }

  return paths;
}

/**
 * Create a new space. Registers in both memory and disk index.
 */
export function createSpace({
  name,
  icon,
  customPath,
  claudeSource = 'local',
  remoteServerId,
  remotePath = '/home',
  useSshTunnel = false,
  systemPrompt,
}: {
  name: string;
  icon: string;
  customPath?: string;
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
  remotePath?: string;
  useSshTunnel?: boolean; // Use SSH port forwarding instead of direct WebSocket connection
  systemPrompt?: string; // Custom system prompt for remote spaces
}): Space {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Data always stored centrally under ~/.aico-bot/spaces/{id}/
  const spacePath = join(getSpacesDir(), id);

  // customPath is stored as workingDir (agent cwd, artifact root, file explorer)
  const workingDir = customPath || undefined;

  // Create directories
  mkdirSync(spacePath, { recursive: true });
  mkdirSync(join(spacePath, '.aico-bot'), { recursive: true });
  mkdirSync(join(spacePath, '.aico-bot', 'conversations'), { recursive: true });

  // Create meta file
  const meta: SpaceMeta = {
    id,
    name,
    icon,
    createdAt: now,
    updatedAt: now,
    workingDir,
    claudeSource,
    remoteServerId,
    remotePath,
    useSshTunnel,
    systemPrompt,
  };

  writeFileSync(join(spacePath, '.aico-bot', 'meta.json'), JSON.stringify(meta, null, 2));

  // Register in index (memory + disk)
  const entry: SpaceIndexEntry = {
    path: spacePath,
    name,
    icon,
    createdAt: now,
    updatedAt: now,
    workingDir,
    claudeSource,
    remoteServerId,
    remotePath,
    useSshTunnel,
    systemPrompt,
  };
  getRegistry().set(id, entry);
  persistIndex(getRegistry());

  console.log(
    `[Space] Created space ${id}: path=${spacePath}${workingDir ? `, workingDir=${workingDir}` : ''}${claudeSource === 'remote' ? `, claudeSource=${claudeSource}, remoteServerId=${remoteServerId}, remotePath=${remotePath}${useSshTunnel ? ', useSshTunnel=true' : ''}` : ''}`,
  );

  return entryToSpace(id, entry);
}

/**
 * Delete a space. Removes from both memory and disk index.
 * Returns an object with success status and optional error message.
 */
export async function deleteSpace(spaceId: string): Promise<{ success: boolean; error?: string }> {
  const entry = getRegistry().get(spaceId);
  if (!entry) return { success: false, error: 'Space not found' };
  if (entry.isTemp) return { success: false, error: 'Cannot delete temp space' };

  const spacePath = entry.path;
  const spacesDir = getSpacesDir();
  const isCentralized = spacePath.startsWith(spacesDir);

  // Close any active sessions belonging to this space before deleting files.
  // This is async — it waits for SDK subprocesses to fully exit so that
  // Windows releases all file handles on the space directory.
  await closeSessionsBySpaceId(spaceId);

  // Destroy HyperSpace team and interrupt all workers for this space
  try {
    const { agentOrchestrator } = require('./agent/orchestrator');
    const team = agentOrchestrator.getTeamBySpace(spaceId);
    if (team) {
      await agentOrchestrator.interruptWorkersForConversation(team.conversationId);
      await agentOrchestrator.destroyTeam(team.id);
    }
  } catch (e) {
    console.error(`[Space] Failed to destroy HyperSpace team for ${spaceId}:`, e);
  }

  // Stop file watcher to release directory handles (Windows EBUSY fix)
  await destroySpaceCache(spaceId);

  // Attempt deletion with retries using exponential backoff.
  // On Windows, file handles may still be releasing even after subprocess exit.
  const retryDelays = [0, 500, 1000, 2000];
  let lastError: any = null;

  for (const delay of retryDelays) {
    if (delay > 0) {
      console.log(`[Space] Retrying delete for ${spaceId} (attempt after ${delay}ms)...`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      if (isCentralized) {
        rmSync(spacePath, { recursive: true, force: true });
      } else {
        const spaceDataDir = join(spacePath, '.aico-bot');
        if (existsSync(spaceDataDir)) {
          rmSync(spaceDataDir, { recursive: true, force: true });
        }
      }
      // Success
      getRegistry().delete(spaceId);
      persistIndex(getRegistry());
      return { success: true };
    } catch (error: any) {
      const code = error?.code || '';
      lastError = error;
      // Only retry on lock/permission errors
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break;
    }
  }

  console.error(`[Space] Failed to delete space ${spaceId} after ${retryDelays.length} attempts:`, lastError);

  let errorMessage: string;
  const code = lastError?.code || '';
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    errorMessage =
      'Failed to delete space. Some files may be in use. Please close any active sessions and try again.';
  } else if (code === 'ENOTEMPTY') {
    errorMessage = 'Failed to delete space. Directory is not empty.';
  } else {
    errorMessage = `Failed to delete space: ${lastError?.message || 'Unknown error'}`;
  }
  return { success: false, error: errorMessage };
}

/**
 * Open space folder in file explorer.
 */
export function openSpaceFolder(spaceId: string): boolean {
  const entry = getRegistry().get(spaceId);
  if (!entry) return false;

  if (entry.isTemp) {
    const artifactsPath = join(entry.path, 'artifacts');
    if (existsSync(artifactsPath)) {
      shell.openPath(artifactsPath);
      return true;
    }
  } else {
    // Open workingDir (project folder) if available, otherwise data path
    const targetPath = entry.workingDir || entry.path;
    shell.openPath(targetPath);
    return true;
  }

  return false;
}

/**
 * Update space metadata. Updates registry (memory + disk) and meta.json.
 */
export function updateSpace(
  spaceId: string,
  updates: { name?: string; icon?: string },
): Space | null {
  const entry = getRegistry().get(spaceId);
  if (!entry || entry.isTemp) return null;

  try {
    // Update registry entry in memory
    if (updates.name) entry.name = updates.name;
    if (updates.icon) entry.icon = updates.icon;
    entry.updatedAt = new Date().toISOString();

    // Persist index
    persistIndex(getRegistry());

    // Write meta.json — read existing to preserve preferences
    const existingMeta = tryReadMeta(entry.path);
    const meta: SpaceMeta = {
      id: spaceId,
      name: entry.name,
      icon: entry.icon,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      preferences: existingMeta?.preferences,
      workingDir: entry.workingDir,
    };
    writeFileSync(join(entry.path, '.aico-bot', 'meta.json'), JSON.stringify(meta, null, 2));

    return entryToSpaceWithPreferences(spaceId, entry);
  } catch (error) {
    console.error('[Space] Failed to update space:', error);
    return null;
  }
}

/**
 * Update space preferences (layout settings, etc.).
 * Only writes meta.json — does NOT write index (preferences are not in the index).
 */
export function updateSpacePreferences(
  spaceId: string,
  preferences: Partial<SpacePreferences>,
): Space | null {
  const entry = getRegistry().get(spaceId);
  if (!entry) return null;

  const metaPath = join(entry.path, '.aico-bot', 'meta.json');

  try {
    // Ensure .aico-bot directory exists
    const spaceDataDir = join(entry.path, '.aico-bot');
    if (!existsSync(spaceDataDir)) {
      mkdirSync(spaceDataDir, { recursive: true });
    }

    // Read existing meta to get current preferences
    const existingMeta = tryReadMeta(entry.path);
    const currentPrefs: SpacePreferences = existingMeta?.preferences || {};

    // Deep merge preferences
    if (preferences.layout) {
      currentPrefs.layout = {
        ...currentPrefs.layout,
        ...preferences.layout,
      };
    }

    // Write meta.json with merged preferences
    const meta: SpaceMeta = {
      id: spaceId,
      name: entry.name,
      icon: entry.icon,
      createdAt: entry.createdAt,
      updatedAt: entry.isTemp ? entry.updatedAt : new Date().toISOString(),
      preferences: currentPrefs,
      workingDir: entry.workingDir,
    };

    // Update updatedAt in registry for non-temp spaces
    if (!entry.isTemp) {
      entry.updatedAt = meta.updatedAt;
    }

    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.log(`[Space] Updated preferences for ${spaceId}:`, preferences);

    // Return space with freshly merged preferences
    const space = entryToSpace(spaceId, entry);
    space.preferences = currentPrefs;
    return space;
  } catch (error) {
    console.error('[Space] Failed to update space preferences:', error);
    return null;
  }
}

/**
 * Get space preferences only. Reads from meta.json on demand.
 */
export function getSpacePreferences(spaceId: string): SpacePreferences | null {
  const entry = getRegistry().get(spaceId);
  if (!entry) return null;

  const meta = tryReadMeta(entry.path);
  return meta?.preferences || null;
}

// ============================================================================
// Onboarding Functions
// ============================================================================

export function writeOnboardingArtifact(
  spaceId: string,
  fileName: string,
  content: string,
): boolean {
  const space = getSpace(spaceId);
  if (!space) {
    console.error(`[Space] writeOnboardingArtifact: Space not found: ${spaceId}`);
    return false;
  }

  try {
    const artifactsDir = space.isTemp
      ? join(space.path, 'artifacts')
      : space.workingDir || space.path;

    mkdirSync(artifactsDir, { recursive: true });

    const filePath = join(artifactsDir, fileName);
    writeFileSync(filePath, content, 'utf-8');

    console.log(`[Space] writeOnboardingArtifact: Saved ${fileName} to ${filePath}`);
    return true;
  } catch (error) {
    console.error(`[Space] writeOnboardingArtifact failed:`, error);
    return false;
  }
}

export function saveOnboardingConversation(
  spaceId: string,
  userMessage: string,
  aiResponse: string,
): string | null {
  const space = getSpace(spaceId);
  if (!space) {
    console.error(`[Space] saveOnboardingConversation: Space not found: ${spaceId}`);
    return null;
  }

  try {
    const { v4: uuidv4 } = require('uuid');
    const conversationId = uuidv4();
    const now = new Date().toISOString();

    const conversationsDir = space.isTemp
      ? join(space.path, 'conversations')
      : join(space.path, '.aico-bot', 'conversations');

    mkdirSync(conversationsDir, { recursive: true });

    const conversation = {
      id: conversationId,
      title: 'Welcome to AICO-Bot',
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: uuidv4(),
          role: 'user',
          content: userMessage,
          timestamp: now,
        },
        {
          id: uuidv4(),
          role: 'assistant',
          content: aiResponse,
          timestamp: now,
        },
      ],
    };

    const filePath = join(conversationsDir, `${conversationId}.json`);
    writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8');

    console.log(`[Space] saveOnboardingConversation: Saved to ${filePath}`);
    return conversationId;
  } catch (error) {
    console.error(`[Space] saveOnboardingConversation failed:`, error);
    return null;
  }
}

// ============================================================================
// Hyper Space Functions
// ============================================================================

/**
 * Create a Hyper Space with multi-agent configuration
 */
export function createHyperSpace(params: CreateHyperSpaceInput): Space | null {
  try {
    const { name, icon, customPath, agents, orchestration } = params;

    // Validate at least one leader
    const leaders = agents?.filter((a) => a.role === 'leader') || [];
    if (leaders.length === 0) {
      console.error('[Space] Hyper Space requires at least one leader agent');
      return null;
    }

    // Create the base space first
    const id = uuidv4();
    const now = new Date().toISOString();

    // Data always stored centrally under ~/.aico-bot/spaces/{id}/
    const spacePath = join(getSpacesDir(), id);

    // customPath is stored as workingDir
    const workingDir = customPath || undefined;

    // Create directories
    mkdirSync(spacePath, { recursive: true });
    mkdirSync(join(spacePath, '.aico-bot'), { recursive: true });
    mkdirSync(join(spacePath, '.aico-bot', 'conversations'), { recursive: true });

    // Build orchestration config
    const orchestrationConfig = createOrchestrationConfig(orchestration);

    // Create meta file with Hyper Space fields
    const meta: SpaceMeta = {
      id,
      name,
      icon,
      createdAt: now,
      updatedAt: now,
      workingDir,
      claudeSource: 'local', // Hyper spaces use local orchestrator
      spaceType: 'hyper',
      agents,
      orchestration: orchestrationConfig,
    };

    writeFileSync(join(spacePath, '.aico-bot', 'meta.json'), JSON.stringify(meta, null, 2));

    // Register in index (memory + disk)
    const entry: SpaceIndexEntry = {
      path: spacePath,
      name,
      icon,
      createdAt: now,
      updatedAt: now,
      workingDir,
      claudeSource: 'local',
      spaceType: 'hyper',
      agents,
      orchestration: orchestrationConfig,
    };
    getRegistry().set(id, entry);
    persistIndex(getRegistry());

    console.log(
      `[Space] Created Hyper Space ${id}: path=${spacePath}` +
        `${workingDir ? `, workingDir=${workingDir}` : ''}` +
        `with ${agents?.length || 0} agents`,
    );

    // Create agent team in orchestrator
    agentOrchestrator.createTeam({
      spaceId: id,
      conversationId: '', // Will be set when conversation starts
      agents: agents || [],
      config: orchestration,
    });

    return entryToSpace(id, entry);
  } catch (error) {
    console.error('[Space] Failed to create Hyper Space:', error);
    return null;
  }
}

/**
 * Update Hyper Space agents
 */
export function updateHyperSpaceAgents(spaceId: string, agents: AgentConfig[]): Space | null {
  const entry = getRegistry().get(spaceId);
  if (!entry || entry.spaceType !== 'hyper') {
    return null;
  }

  try {
    // Validate at least one leader
    const leaders = agents.filter((a) => a.role === 'leader');
    if (leaders.length === 0) {
      console.error('[Space] Hyper Space requires at least one leader agent');
      return null;
    }

    // Update entry
    entry.agents = agents;
    entry.updatedAt = new Date().toISOString();

    // Persist index
    persistIndex(getRegistry());

    // Update meta.json
    const existingMeta = tryReadMeta(entry.path);
    const meta: SpaceMeta = {
      ...existingMeta,
      id: spaceId,
      name: entry.name,
      icon: entry.icon,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      preferences: existingMeta?.preferences,
      workingDir: entry.workingDir,
      spaceType: 'hyper',
      agents,
    };
    writeFileSync(join(entry.path, '.aico-bot', 'meta.json'), JSON.stringify(meta, null, 2));

    console.log(`[Space] Updated Hyper Space ${spaceId} agents: ${agents.length} agents`);

    return entryToSpaceWithPreferences(spaceId, entry);
  } catch (error) {
    console.error('[Space] Failed to update Hyper Space agents:', error);
    return null;
  }
}

/**
 * Get Hyper Space status
 */
export function getHyperSpaceStatus(spaceId: string): {
  isHyper: boolean;
  teamStatus?: ReturnType<typeof agentOrchestrator.getTeamStatus>;
} {
  const entry = getRegistry().get(spaceId);
  if (!entry) {
    return { isHyper: false };
  }

  const isHyper = entry.spaceType === 'hyper';

  if (!isHyper) {
    return { isHyper: false };
  }

  const team = agentOrchestrator.getTeamBySpace(spaceId);
  if (!team) {
    return { isHyper: true, teamStatus: null };
  }

  return {
    isHyper: true,
    teamStatus: agentOrchestrator.getTeamStatus(team.id),
  };
}

// ============================================================================
// Skill Space Functions
// ============================================================================

// 固定的技能空间 ID
const SKILL_SPACE_ID = 'aico-bot-skill-creator';

/**
 * 获取或创建技能专用空间
 * 这是一个隐藏空间，用于技能生成器的会话
 * 路径固定为 ~/.agents/skills
 */
export function getOrCreateSkillSpace(): Space {
  const registry = getRegistry();

  // 检查是否已存在
  const existingEntry = registry.get(SKILL_SPACE_ID);
  if (existingEntry && existsSync(existingEntry.path)) {
    return entryToSpace(SKILL_SPACE_ID, existingEntry);
  }

  // 创建新的技能空间
  const now = new Date().toISOString();

  // 使用 ~/.agents/skills 作为工作目录（这是技能存放的位置）
  const skillsDir = join(getAicoBotDir(), '..', '.agents', 'skills');
  // 空间数据存储在 ~/.aico-bot/spaces/aico-bot-skill-creator/
  const spacePath = join(getSpacesDir(), SKILL_SPACE_ID);

  // 创建目录
  mkdirSync(spacePath, { recursive: true });
  mkdirSync(join(spacePath, '.aico-bot'), { recursive: true });
  mkdirSync(join(spacePath, '.aico-bot', 'conversations'), { recursive: true });

  // 确保技能目录存在
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  // 创建 meta 文件
  const meta: SpaceMeta = {
    id: SKILL_SPACE_ID,
    name: 'Skill Creator',
    icon: 'wand-2',
    createdAt: now,
    updatedAt: now,
    workingDir: skillsDir, // 技能目录作为工作目录
    claudeSource: 'local',
  };

  writeFileSync(join(spacePath, '.aico-bot', 'meta.json'), JSON.stringify(meta, null, 2));

  // 注册到索引（内存 + 磁盘）
  const entry: SpaceIndexEntry = {
    path: spacePath,
    name: 'Skill Creator',
    icon: 'wand-2',
    createdAt: now,
    updatedAt: now,
    workingDir: skillsDir,
    claudeSource: 'local',
  };

  registry.set(SKILL_SPACE_ID, entry);
  persistIndex(registry);

  console.log(`[Space] Created skill space: path=${spacePath}, workingDir=${skillsDir}`);

  return entryToSpace(SKILL_SPACE_ID, entry);
}

/**
 * 获取技能空间 ID
 */
export function getSkillSpaceId(): string {
  return SKILL_SPACE_ID;
}

/**
 * 检查是否是技能空间
 */
export function isSkillSpace(spaceId: string): boolean {
  return spaceId === SKILL_SPACE_ID;
}
