/**
 * Agent Module - Permission Handler
 *
 * Controls tool permissions using a tiered risk model:
 *
 * Risk tiers:
 * - Pre-approved (SDK allowedTools): Read, Glob, Grep, Write, Edit, Create,
 *   MultiEdit, NotebookEdit, TodoWrite — these skip canUseTool entirely
 * - Smart-inspected (Bash only): destructive commands (rm, sudo, etc.) require
 *   user confirmation; non-destructive commands auto-approve
 * - Special: Skill (disabled check), AskUserQuestion (user interaction)
 * - MCP tools: auto-allow with logging
 */

import { SkillManager } from '../skill/skill-manager';

// ============================================
// Types
// ============================================

type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput: Record<string, unknown>;
    }
  | {
      behavior: 'deny';
      message: string;
    };

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<PermissionResult>;

type SendToRendererFn = (
  channel: string,
  spaceId: string,
  conversationId: string,
  data: Record<string, unknown>,
) => void;

interface CanUseToolDeps {
  sendToRenderer: SendToRendererFn;
  spaceId: string;
  conversationId: string;
  agentId?: string;
  agentName?: string;
  trustMode?: boolean;
}

// ============================================
// Bash Destructive Command Detection
// ============================================

/**
 * Destructive command names that always require user confirmation.
 * These commands can cause irreversible data loss or system changes.
 */
const DESTRUCTIVE_COMMANDS = new Set([
  // File system destruction
  'rm',
  'rmdir',
  'shred',
  'truncate',
  // File move/copy (can overwrite targets)
  'mv',
  'cp',
  // Permission/ownership changes
  'chmod',
  'chown',
  'chgrp',
  // Process management
  'kill',
  'pkill',
  'killall',
  // System-level operations
  'sudo',
  'su',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  // Disk/partition operations
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'mkswap',
  'swapon',
  'swapoff',
  // Package managers (uninstall/purge)
  'apt-get',
  'apt',
  'yum',
  'dnf',
  'pacman',
  'brew',
]);

/**
 * Subcommands that make an otherwise safe command destructive.
 * Key = base command, Value = set of destructive subcommand prefixes.
 */
const DESTRUCTIVE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['uninstall', 'publish']),
  yarn: new Set(['remove']),
  pnpm: new Set(['remove', 'uninstall']),
  git: new Set(['push --force', 'push -f', 'clean', 'reset --hard']),
  docker: new Set(['rm', 'rmi', 'system prune', 'volume rm']),
  kubectl: new Set(['delete', 'cordon', 'drain']),
};

/**
 * Check if a Bash command is potentially destructive.
 *
 * Splits chained commands (&&, ||, ;, |) and checks each segment against
 * DESTRUCTIVE_COMMANDS and DESTRUCTIVE_SUBCOMMANDS. Also detects dangerous
 * redirects to system paths.
 */
function isDestructiveBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Split by command separators and check each segment
  const segments = trimmed.split(/\s*[;&|]\s*/).filter(Boolean);

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    if (tokens.length === 0) continue;

    // Skip env/sudo wrappers to get the real command
    let cmdIndex = 0;
    while (cmdIndex < tokens.length && ['env', 'sudo'].includes(tokens[cmdIndex])) {
      cmdIndex++;
      while (cmdIndex < tokens.length && tokens[cmdIndex].startsWith('-')) {
        cmdIndex++;
      }
    }

    if (cmdIndex >= tokens.length) continue;
    const baseCmd = tokens[cmdIndex];
    const restOfCommand = tokens.slice(cmdIndex + 1).join(' ');

    // Direct destructive command
    if (DESTRUCTIVE_COMMANDS.has(baseCmd)) {
      return true;
    }

    // Destructive subcommand (e.g., npm uninstall, git push --force)
    const subCmds = DESTRUCTIVE_SUBCOMMANDS[baseCmd];
    if (subCmds && restOfCommand) {
      for (const pattern of subCmds) {
        if (restOfCommand.startsWith(pattern)) {
          return true;
        }
      }
    }
  }

  // Dangerous redirects to system paths (e.g., echo > /etc/passwd)
  if (/>/.test(trimmed) && /\/(etc|usr|bin|sbin|boot|var|sys|proc)/.test(trimmed)) {
    return true;
  }

  return false;
}

// ============================================
// Tool Risk Classification
// ============================================

/** Only Bash requires content-level inspection for destructive commands */
const HIGH_RISK_TOOLS = new Set([
  'Bash',
]);

// ============================================
// Pending Permission Requests
// ============================================

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingPermission {
  resolve: (approved: boolean) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingPermissions = new Map<string, PendingPermission>();

export function resolvePermission(id: string, approved: boolean): boolean {
  const entry = pendingPermissions.get(id);
  if (!entry) {
    console.warn(`[PermissionHandler] No pending permission found for id: ${id}`);
    return false;
  }
  clearTimeout(entry.timeoutId);
  entry.resolve(approved);
  pendingPermissions.delete(id);
  return true;
}

export function rejectAllPermissions(): void {
  for (const [id, entry] of pendingPermissions) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error('Generation stopped'));
    pendingPermissions.delete(id);
  }
}

// ============================================
// Pending Questions Registry (AskUserQuestion)
// ============================================

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingQuestionEntry {
  conversationId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingQuestions = new Map<string, PendingQuestionEntry>();

export function resolveQuestion(id: string, answers: Record<string, string>): boolean {
  const entry = pendingQuestions.get(id);
  if (!entry) {
    console.warn(`[PermissionHandler] No pending question found for id: ${id}`);
    return false;
  }
  clearTimeout(entry.timeoutId);
  entry.resolve(answers);
  pendingQuestions.delete(id);
  return true;
}

export function rejectQuestion(id: string, reason?: string): boolean {
  const entry = pendingQuestions.get(id);
  if (!entry) return false;
  clearTimeout(entry.timeoutId);
  entry.reject(new Error(reason || 'Question cancelled'));
  pendingQuestions.delete(id);
  return true;
}

/**
 * Reject pending questions.
 * Used when stop generation is triggered or user sends a new message.
 * When conversationId is provided, only that conversation's questions are rejected.
 */
export function rejectAllQuestions(conversationId?: string): void {
  for (const [id, entry] of pendingQuestions) {
    if (conversationId && entry.conversationId !== conversationId) {
      continue;
    }
    clearTimeout(entry.timeoutId);
    entry.reject(new Error('Generation stopped'));
    pendingQuestions.delete(id);
  }
}

// ============================================
// Permission Handler Factory
// ============================================

/**
 * Create tool permission handler.
 *
 * - Bash: smart inspection — destructive commands require confirmation, others auto-approve.
 * - Skill: denies calls to disabled skills.
 * - AskUserQuestion: sends questions to UI, waits for user answers.
 * - MCP tools: auto-allow with logging.
 * - All other tools: auto-allow (including Write/Edit/Create which are pre-approved via SDK).
 */
export function createCanUseTool(deps?: CanUseToolDeps): CanUseToolFn {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    // Skill tool: block disabled skills
    if (toolName === 'Skill') {
      const disabledIds = SkillManager.getGlobalDisabledSkillIds();
      const cmd = String(input.command || input.name || input.skill || '');
      const skillName = cmd.replace(/^\/+/, '').trim();
      if (skillName && disabledIds.has(skillName)) {
        console.log(`[PermissionHandler] Blocked disabled skill: ${skillName}`);
        return {
          behavior: 'deny' as const,
          message: `The skill "${skillName}" is currently disabled by the user. Inform the user that this skill cannot be used right now and suggest alternative approaches to accomplish their goal without it.`,
        };
      }
      return { behavior: 'allow' as const, updatedInput: input };
    }

    // AskUserQuestion: send to UI and wait for answers
    if (toolName === 'AskUserQuestion') {
      if (!deps) {
        console.warn('[PermissionHandler] AskUserQuestion called without deps, auto-allowing');
        return { behavior: 'allow' as const, updatedInput: { ...input, answers: {} } };
      }

      const { sendToRenderer, spaceId, conversationId, agentId, agentName } = deps;
      const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const questions = input.questions as Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }>;

      console.log(
        `[PermissionHandler] AskUserQuestion: id=${id}, questions=${questions?.length || 0}`,
      );

      const answers = createPendingPromise<string>(
        id,
        pendingQuestions,
        QUESTION_TIMEOUT_MS,
        options.signal,
      );

      const eventData: Record<string, unknown> = { id, questions: questions || [] };
      if (agentId) eventData.agentId = agentId;
      if (agentName) eventData.agentName = agentName;
      sendToRenderer('agent:ask-question', spaceId, conversationId, eventData);

      try {
        const result = await answers;
        console.log(`[PermissionHandler] AskUserQuestion answered: id=${id}`, result);
        return {
          behavior: 'allow' as const,
          updatedInput: { ...input, answers: result },
        };
      } catch (error) {
        console.log(
          `[PermissionHandler] AskUserQuestion cancelled: id=${id}`,
          (error as Error).message,
        );
        return {
          behavior: 'deny' as const,
          message: `The user cancelled this question. Do not retry the same question. Continue with the best reasonable assumption or ask a different way.`,
        };
      }
    }

    // No deps (e.g., MCP health check): auto-allow
    if (!deps) {
      return { behavior: 'allow' as const, updatedInput: input };
    }

    // High-risk tools (Bash): smart inspection for destructive commands
    if (HIGH_RISK_TOOLS.has(toolName)) {
      // Bash: only require confirmation for destructive commands
      if (toolName === 'Bash') {
        const command = String(input.command || '');
        // Full permission mode: skip all destructive checks, auto-approve
        if (deps.trustMode) {
          return { behavior: 'allow' as const, updatedInput: input };
        }
        if (!isDestructiveBashCommand(command)) {
          console.log(`[PermissionHandler] Bash auto-approved (non-destructive): ${command.substring(0, 100)}`);
          return { behavior: 'allow' as const, updatedInput: input };
        }
        console.log(`[PermissionHandler] Bash destructive command detected: ${command.substring(0, 100)}`);
      }
      const { sendToRenderer, spaceId, conversationId } = deps;
      const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      console.log(`[PermissionHandler] Permission required: ${toolName}, id=${id}`);

      const approvalPromise = createPendingPromise<boolean>(
        id,
        pendingPermissions,
        PERMISSION_TIMEOUT_MS,
        options.signal,
      );

      sendToRenderer('agent:permission-request', spaceId, conversationId, {
        id,
        toolName,
        toolInput: input,
        timestamp: Date.now(),
      });

      try {
        const approved = await approvalPromise;
        console.log(
          `[PermissionHandler] Permission ${id}: ${approved ? 'APPROVED' : 'DENIED'} for ${toolName}`,
        );
        if (!approved) {
          return {
            behavior: 'deny' as const,
            message: `The user denied permission to execute this ${toolName} command: ${String(input.command || '').substring(0, 200)}. Explain to the user that this operation was not performed because they declined it. Briefly explain why it may carry risk, then suggest safer alternative approaches to accomplish the same goal. Ask the user which alternative they prefer.`,
          };
        }
        return { behavior: 'allow' as const, updatedInput: input };
      } catch (error) {
        console.log(
          `[PermissionHandler] Permission ${id}: cancelled for ${toolName}`,
          (error as Error).message,
        );
        return {
          behavior: 'deny' as const,
          message: `The permission request for this ${toolName} command was cancelled or timed out: ${String(input.command || '').substring(0, 200)}. The operation was not performed. Suggest safer alternative approaches to accomplish the same goal and ask the user how they would like to proceed.`,
        };
      }
    }

    // MCP tools: auto-allow with logging (most MCP tools are read-only information tools)
    if (toolName.startsWith('mcp__')) {
      console.log(`[PermissionHandler] MCP tool auto-allowed: ${toolName}`);
      return { behavior: 'allow' as const, updatedInput: input };
    }

    // All other tools: auto-allow
    return { behavior: 'allow' as const, updatedInput: input };
  };
}

// ============================================
// Helpers
// ============================================

function createPendingPromise<T>(
  id: string,
  registry: Map<string, { resolve: (v: T) => void; reject: (r?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      registry.delete(id);
      reject(new Error('Timed out (5 min)'));
    }, timeoutMs);

    registry.set(id, {
      resolve: (v) => {
        clearTimeout(timeoutId);
        resolve(v);
      },
      reject: (r) => {
        clearTimeout(timeoutId);
        reject(r);
      },
      timeoutId,
    });

    if (signal.aborted) {
      clearTimeout(timeoutId);
      registry.delete(id);
      reject(new Error('Aborted'));
    } else {
      const onAbort = () => {
        clearTimeout(timeoutId);
        registry.delete(id);
        reject(new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
