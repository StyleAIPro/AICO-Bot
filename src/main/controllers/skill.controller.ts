/**
 * Skill Controller
 * 处理 Skill 相关的业务逻辑
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { SkillManager } from '../services/skill/skill-manager';
import type { ImportSkillsResult } from '../services/skill/skill-manager';
import { SkillMarketService } from '../services/skill/skill-market-service';
import { SkillGeneratorService } from '../services/skill/skill-generator';
import type { ConversationService } from '../services/conversation.service';
import { remoteDeployService } from '../services/remote/deploy/remote-deploy.service';
import type { SkillGenerateOptions } from '../../shared/skill/skill-types';
import * as githubSkillSource from '../services/skill/github-skill-source.service';
import * as gitcodeSkillSource from '../services/skill/gitcode-skill-source.service';
import { invalidateAllSessions, v2Sessions } from '../services/agent/session-lifecycle';
import { refreshSkillDirectories } from '../services/agent/sdk-config';
import { clearSessionId } from '../services/conversation.service';

let skillManager: SkillManager;
let skillMarket: SkillMarketService;
let skillGenerator: SkillGeneratorService;
let initPromise: Promise<void> | null = null;

export function initialize(conversationService: ConversationService): void {
  skillManager = SkillManager.getInstance();
  skillMarket = SkillMarketService.getInstance();
  skillGenerator = SkillGeneratorService.getInstance(conversationService);

  initPromise = Promise.all([skillManager.initialize(), skillMarket.initialize()])
    .then(() => {
      // explicitly return void
    })
    .catch((err) => {
      console.error('[SkillController] Failed to initialize:', err);
    });
}

async function ensureInitialized(): Promise<void> {
  if (initPromise) {
    await initPromise;
  }
}

/**
 * Source adapter for downloading skill files from different platforms
 */
export type SkillSourceAdapter = {
  findSkillDirectoryPath: (
    repo: string,
    skillName: string,
    token?: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  fetchSkillDirectoryContents: (
    repo: string,
    dirPath: string,
    token?: string,
    signal?: AbortSignal,
  ) => Promise<Array<{ path: string; content: string }>>;
  getToken: () => string | undefined | Promise<string | undefined>;
  sourceLabel: string;
};

export const GITHUB_ADAPTER: SkillSourceAdapter = {
  findSkillDirectoryPath: githubSkillSource.findSkillDirectoryPath,
  fetchSkillDirectoryContents: githubSkillSource.fetchSkillDirectoryContents,
  getToken: githubSkillSource.getGitHubToken,
  sourceLabel: 'GitHub',
};

export const GITCODE_ADAPTER: SkillSourceAdapter = {
  findSkillDirectoryPath: gitcodeSkillSource.findSkillDirectoryPath,
  fetchSkillDirectoryContents: gitcodeSkillSource.fetchSkillDirectoryContents,
  getToken: gitcodeSkillSource.getGitCodeToken,
  sourceLabel: 'GitCode',
};

/**
 * Download skill files from a source (GitHub or GitCode) and install locally
 */
async function installSkillFromSource(
  repo: string,
  skillName: string,
  adapter: SkillSourceAdapter,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
  signal?: AbortSignal,
  knownDirPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const nodePath = await import('path');
  const nodeFs = await import('fs/promises');
  const configService = await import('../services/config.service');
  const yamlModule = await import('yaml');

  // skillName can be a full path like "skills/category/skill-name"
  const lastSegment = skillName.split('/').pop() || skillName;
  const skillId = lastSegment
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-');
  const skillDir = nodePath.join(configService.getAgentsSkillsDir(), skillId);

  console.log('[SkillController] installSkillFromSource:', {
    repo,
    skillName,
    knownDirPath,
    skillId,
    skillDir,
  });

  onOutput?.({ type: 'stdout', content: `Downloading directly from ${adapter.sourceLabel}...\n` });

  const token = await adapter.getToken();
  if (!token) {
    const sourceLabel = adapter.sourceLabel || 'source';
    const errorMsg =
      `${sourceLabel} PAT 未配置，无法安装技能。请前往 设置 > ${sourceLabel} 配置 Personal Access Token。\n\n` +
      `${sourceLabel} PAT not configured. Cannot install skill. Please go to Settings > ${sourceLabel} to configure your Personal Access Token.`;
    onOutput?.({ type: 'error', content: `  ${errorMsg}\n` });
    return { success: false, error: errorMsg };
  }

  if (token) {
    onOutput?.({
      type: 'stdout',
      content: `  Using authenticated ${adapter.sourceLabel} access\n`,
    });
  }

  // Step 1: Resolve skill directory path
  // If knownDirPath is provided (e.g., from downloadSkill's remotePath), skip
  // the expensive findSkillDirectoryPath call (which re-fetches the full tree).
  let dirPath: string | null = knownDirPath || null;
  if (!dirPath) {
    onOutput?.({ type: 'stdout', content: `  Locating skill directory...\n` });
    dirPath = await adapter.findSkillDirectoryPath(repo, skillName, token, signal);
  }

  console.log('[SkillController] resolved dirPath:', dirPath);

  if (!dirPath) {
    const error = `Could not find skill directory for "${skillName}" in repo ${repo}`;
    onOutput?.({ type: 'error', content: `  ${error}\n` });
    return { success: false, error };
  }

  onOutput?.({ type: 'stdout', content: `  Found skill at: ${dirPath}/\n` });

  // Step 2: Download all files in the directory recursively
  onOutput?.({ type: 'stdout', content: `  Downloading skill files...\n` });
  console.log('[SkillController] fetchSkillDirectoryContents:', { repo, dirPath });
  const files = await adapter.fetchSkillDirectoryContents(repo, dirPath, token, signal);

  if (files.length === 0) {
    const error = `No files found in skill directory: ${dirPath}`;
    onOutput?.({ type: 'error', content: `  ${error}\n` });
    return { success: false, error };
  }

  onOutput?.({ type: 'stdout', content: `  Downloaded ${files.length} file(s)\n` });

  try {
    // Step 3: Remove old skill directory if exists, then create fresh and write all files
    try {
      await nodeFs.access(skillDir);
      onOutput?.({ type: 'stdout', content: `  Removing existing skill directory...\n` });
      await nodeFs.rm(skillDir, { recursive: true, force: true });
    } catch {
      // directory does not exist, proceed
    }
    await nodeFs.mkdir(skillDir, { recursive: true });

    for (const file of files) {
      const filePath = nodePath.join(skillDir, file.path);
      await nodeFs.mkdir(nodePath.dirname(filePath), { recursive: true });
      await nodeFs.writeFile(filePath, file.content, 'utf-8');
      onOutput?.({ type: 'stdout', content: `    Wrote ${file.path}\n` });
    }

    // Step 4: Generate META.json from SKILL.md frontmatter if present
    const skillMdFile = files.find(
      (f) => f.path === 'SKILL.md' || f.path.toUpperCase() === 'SKILL.MD',
    );
    const skillYamlFile = files.find(
      (f) => f.path === 'SKILL.yaml' || f.path.toUpperCase() === 'SKILL.YAML',
    );

    if (skillMdFile) {
      const frontmatterMatch = skillMdFile.content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        try {
          const meta = yamlModule.parse(frontmatterMatch[1]);
          const metaJson = {
            appId: skillId,
            spec: meta,
            enabled: true,
            installedAt: new Date().toISOString(),
          };
          await nodeFs.writeFile(
            nodePath.join(skillDir, 'META.json'),
            JSON.stringify(metaJson, null, 2),
            'utf-8',
          );
        } catch {
          // frontmatter parse failed, write basic META.json
        }
      }
    } else if (skillYamlFile) {
      try {
        const meta = yamlModule.parse(skillYamlFile.content);
        const spec = meta?.skill || meta;
        const metaJson = {
          appId: skillId,
          spec,
          enabled: true,
          installedAt: new Date().toISOString(),
        };
        await nodeFs.writeFile(
          nodePath.join(skillDir, 'META.json'),
          JSON.stringify(metaJson, null, 2),
          'utf-8',
        );
      } catch {
        // yaml parse failed
      }
    }

    // If no META.json was generated, write a basic one
    const metaPath = nodePath.join(skillDir, 'META.json');
    try {
      await nodeFs.access(metaPath);
    } catch {
      const metaJson = {
        appId: skillId,
        enabled: true,
        installedAt: new Date().toISOString(),
      };
      await nodeFs.writeFile(metaPath, JSON.stringify(metaJson, null, 2), 'utf-8');
    }

    // Refresh skill list and sync to SDK
    await skillManager.refresh();
    await syncSkillStateToSdk();

    onOutput?.({
      type: 'complete',
      content: `✓ Skill installed successfully (${files.length} files via ${adapter.sourceLabel})!\n`,
    });
    return { success: true };
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `  Failed to write skill files: ${err.message}\n` });
    return { success: false, error: err.message };
  }
}

export async function listInstalledSkills() {
  try {
    await ensureInitialized();
    const skills = skillManager.getInstalledSkills();
    return { success: true, data: skills };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list skills',
    };
  }
}

export async function getSkillDetail(skillId: string) {
  try {
    await ensureInitialized();
    const skill = skillManager.getSkill(skillId);
    if (!skill) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: skill };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill detail',
    };
  }
}

export async function installSkillFromMarket(
  skillId: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; error?: string }> {
  const INSTALL_TIMEOUT = 120_000; // 120 seconds
  const abortController = new AbortController();
  const signal = abortController.signal;

  const doInstall = async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await ensureInitialized();

      console.log('[SkillController] Installing skill from market:', skillId);

      // 1. 获取技能安装信息（pass onOutput for progress feedback）
      const downloadResult = await skillMarket.downloadSkill(skillId, (data) => {
        onOutput?.(data);
      });

      if (!downloadResult.success || !downloadResult.remoteRepo || !downloadResult.skillName) {
        const error = downloadResult.error || 'Failed to download skill';
        onOutput?.({ type: 'error', content: error });
        return { success: false, error };
      }

      console.log('[SkillController] Skill info:', {
        remoteRepo: downloadResult.remoteRepo,
        skillName: downloadResult.skillName,
      });

      // 2. 根据 sourceType 选择安装方式
      const { remoteRepo: repo, skillName, sourceType } = downloadResult;

      // GitCode: 跳过 npx（npx 只支持 GitHub），直接通过 GitCode API 下载
      // skillName is remotePath (e.g., "Inference/ais-bench"), pass as knownDirPath
      // to skip the redundant findSkillDirectoryPath call.
      if (sourceType === 'gitcode') {
        return installSkillFromSource(
          repo!,
          skillName!,
          GITCODE_ADAPTER,
          onOutput,
          signal,
          skillName!,
        );
      }

      // GitHub / skills.sh: npx 安装 + GitHub fallback
      const { spawn } = await import('child_process');

      const command = 'npx';
      const args = [
        '--yes',
        'skills',
        'add',
        `https://github.com/${repo}`,
        '--skill',
        skillName,
        '-y',
        '--global',
      ];

      const fullCommand = `${command} ${args.join(' ')}`;
      console.log('[SkillController] Executing command:', fullCommand);
      onOutput?.({ type: 'stdout', content: `$ ${fullCommand}\n` });

      return new Promise((resolve) => {
        const childProcess = spawn(command, args, {
          env: { ...process.env },
          timeout: 120000, // 2 分钟超时
          shell: true, // Windows 上 npx 是 .cmd 文件，需要 shell 才能执行
        });

        let hasError = false;

        childProcess.stdout?.on('data', (data: Buffer) => {
          const content = data.toString();
          console.debug('[SkillController] stdout:', content);
          onOutput?.({ type: 'stdout', content });
        });

        childProcess.stderr?.on('data', (data: Buffer) => {
          const content = data.toString();
          // 忽略 npm 警告
          if (!content.toLowerCase().includes('npm warn')) {
            console.debug('[SkillController] stderr:', content);
            onOutput?.({ type: 'stderr', content });
          }
        });

        childProcess.on('error', (error: Error) => {
          console.error('[SkillController] Process error:', error);
          hasError = true;
          const msg = error.message;
          onOutput?.({ type: 'stderr', content: `\n✗ ${msg}\n` });
          // npx not found 或其他启动错误 -> fallback 到 GitHub 下载
          const fallbackToken = githubSkillSource.getGitHubToken();
          if (!fallbackToken) {
            onOutput?.({
              type: 'error',
              content:
                '\n✗ GitHub PAT 未配置，无法下载技能。请前往 设置 > GitHub 配置。\n\n' +
                'GitHub PAT not configured. Cannot download skill. Please go to Settings > GitHub.\n',
            });
            resolve({ success: false, error: 'GitHub PAT not configured' });
            return;
          }
          onOutput?.({ type: 'stdout', content: '\n--- Fallback: downloading from GitHub ---\n' });
          installSkillFromSource(repo!, skillName!, GITHUB_ADAPTER, onOutput)
            .then(resolve)
            .catch(() => resolve({ success: false, error: msg }));
        });

        childProcess.on('close', async (code: number) => {
          console.log('[SkillController] Process exited with code:', code);

          if (code === 0 && !hasError) {
            onOutput?.({ type: 'complete', content: '\n✓ Skill installed successfully!\n' });

            try {
              await skillManager.refresh();
              await syncSkillStateToSdk();
            } catch (refreshError) {
              console.debug('[SkillController] Failed to refresh skills:', refreshError);
            }

            resolve({ success: true });
          } else {
            // npx 执行失败（非 0 退出码） -> fallback 到 GitHub 下载
            const fallbackToken = githubSkillSource.getGitHubToken();
            if (!fallbackToken) {
              onOutput?.({
                type: 'error',
                content:
                  '\n✗ GitHub PAT 未配置，无法下载技能。请前往 设置 > GitHub 配置。\n\n' +
                  'GitHub PAT not configured. Cannot download skill. Please go to Settings > GitHub.\n',
              });
              resolve({ success: false, error: 'GitHub PAT not configured' });
              return;
            }
            onOutput?.({
              type: 'stdout',
              content: '\n--- Fallback: downloading from GitHub ---\n',
            });
            const result = await installSkillFromSource(
              repo!,
              skillName!,
              GITHUB_ADAPTER,
              onOutput,
            );
            if (result.success) {
              resolve({ success: true });
            } else {
              onOutput?.({ type: 'error', content: `\n✗ Both npx and GitHub download failed.\n` });
              resolve({ success: false, error: result.error });
            }
          }
        });
      });
    } catch (error) {
      console.error('[SkillController] Failed to install skill:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to install skill';
      onOutput?.({ type: 'error', content: errorMessage });
      return { success: false, error: errorMessage };
    }
  };

  // Apply overall timeout — abort all pending API requests on timeout
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const timeoutId = setTimeout(() => {
      const msg = 'Installation timed out (60s). Please check your network and try again.';
      console.debug('[SkillController]', msg, '- aborting pending requests');
      abortController.abort();
      onOutput?.({ type: 'error', content: msg });
      resolve({ success: false, error: msg });
    }, INSTALL_TIMEOUT);

    doInstall().then((result) => {
      clearTimeout(timeoutId);
      resolve(result);
    });
  });
}

/**
 * Install skill from market using pre-fetched download result (avoids duplicate downloadSkill).
 * Used by installSkillMultiTarget to prevent calling downloadSkill twice.
 */
async function installSkillFromMarketWithInfo(
  skillId: string,
  downloadResult: Awaited<ReturnType<SkillMarketService['downloadSkill']>>,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
  signal?: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureInitialized();

    if (!downloadResult.success || !downloadResult.remoteRepo || !downloadResult.skillName) {
      const error = downloadResult.error || 'Failed to download skill';
      onOutput?.({ type: 'error', content: error });
      return { success: false, error };
    }

    const { remoteRepo: repo, skillName, sourceType } = downloadResult;

    if (sourceType === 'gitcode') {
      return installSkillFromSource(
        repo!,
        skillName!,
        GITCODE_ADAPTER,
        onOutput,
        signal,
        skillName!,
      );
    }

    // GitHub / skills.sh: npx install + fallback
    const { spawn } = await import('child_process');

    const args = [
      '--yes',
      'skills',
      'add',
      `https://github.com/${repo}`,
      '--skill',
      skillName,
      '-y',
      '--global',
    ];

    onOutput?.({ type: 'stdout', content: `$ npx ${args.join(' ')}\n` });

    return new Promise((resolve) => {
      const child = spawn('npx', args, {
        env: { ...process.env },
        timeout: 120_000,
        shell: true,
      });

      child.stdout?.on('data', (d: Buffer) =>
        onOutput?.({ type: 'stdout', content: d.toString() }),
      );
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        if (!s.toLowerCase().includes('npm warn')) onOutput?.({ type: 'stderr', content: s });
      });

      child.on('error', (error: Error) => {
        onOutput?.({ type: 'stderr', content: `\n✗ ${error.message}\n` });
        const fallbackToken = githubSkillSource.getGitHubToken();
        if (!fallbackToken) {
          onOutput?.({
            type: 'error',
            content:
              '\n✗ GitHub PAT 未配置，无法下载技能。请前往 设置 > GitHub 配置。\n\n' +
              'GitHub PAT not configured. Cannot download skill. Please go to Settings > GitHub.\n',
          });
          resolve({ success: false, error: 'GitHub PAT not configured' });
          return;
        }
        onOutput?.({ type: 'stdout', content: '\n--- Fallback: downloading from GitHub ---\n' });
        installSkillFromSource(repo!, skillName!, GITHUB_ADAPTER, onOutput, signal)
          .then(resolve)
          .catch(() => resolve({ success: false, error: error.message }));
      });

      child.on('close', async (code: number) => {
        if (code === 0) {
          onOutput?.({ type: 'complete', content: '\n✓ Skill installed successfully!\n' });
          try {
            await skillManager.refresh();
            await syncSkillStateToSdk();
          } catch {}
          resolve({ success: true });
        } else {
          const fallbackToken = githubSkillSource.getGitHubToken();
          if (!fallbackToken) {
            onOutput?.({
              type: 'error',
              content:
                '\n✗ GitHub PAT 未配置，无法下载技能。请前往 设置 > GitHub 配置。\n\n' +
                'GitHub PAT not configured. Cannot download skill. Please go to Settings > GitHub.\n',
            });
            resolve({ success: false, error: 'GitHub PAT not configured' });
            return;
          }
          onOutput?.({ type: 'stdout', content: '\n--- Fallback: downloading from GitHub ---\n' });
          const result = await installSkillFromSource(
            repo!,
            skillName!,
            GITHUB_ADAPTER,
            onOutput,
            signal,
          );
          resolve(result.success ? { success: true } : { success: false, error: result.error });
        }
      });
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to install skill';
    onOutput?.({ type: 'error', content: errorMessage });
    return { success: false, error: errorMessage };
  }
}

export async function installSkillFromYaml(
  yamlContent: string,
): Promise<{ success: boolean; skillId?: string; error?: string }> {
  try {
    const skillId = await skillManager.importSkill(yamlContent);
    await syncSkillStateToSdk();
    return { success: true, skillId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install skill',
    };
  }
}

/**
 * 从文件路径导入技能（支持 ZIP 和文件夹）
 */
export async function importSkills(
  sourceType: 'zip' | 'folder',
  filePath: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; data?: ImportSkillsResult; error?: string }> {
  try {
    await ensureInitialized();
    const skillManager = SkillManager.getInstance();

    const onProgress = (message: string) => {
      onOutput?.({ type: 'stdout', content: message });
    };

    let result: ImportSkillsResult;
    if (sourceType === 'zip') {
      result = await skillManager.installFromZip(filePath, onProgress);
    } else {
      result = await skillManager.installFromDirectory(filePath, onProgress);
    }

    await syncSkillStateToSdk();

    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * 从 ZIP Buffer 导入技能（用于 HTTP 上传）
 */
export async function importFromZipBuffer(
  zipBuffer: Buffer,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; data?: ImportSkillsResult; error?: string }> {
  try {
    await ensureInitialized();
    const skillManager = SkillManager.getInstance();

    const tmpFile = path.join(os.tmpdir(), `aico-skill-upload-${crypto.randomUUID()}.zip`);
    await fs.writeFile(tmpFile, zipBuffer);

    try {
      const result = await skillManager.installFromZip(tmpFile, (message) => {
        onOutput?.({ type: 'stdout', content: message });
      });

      await syncSkillStateToSdk();

      return { success: true, data: result };
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export async function uninstallSkill(skillId: string) {
  try {
    const result = await skillManager.uninstallSkill(skillId);
    if (result) {
      await syncSkillStateToSdk();
    }
    return { success: result, error: result ? undefined : 'Failed to uninstall skill' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to uninstall skill',
    };
  }
}

/**
 * Install skill on local and/or specified remote servers.
 * Returns a map of target -> result status.
 */
export async function installSkillMultiTarget(
  skillId: string,
  targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>,
  onOutput?: (
    targetKey: string,
    data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
  ) => void,
): Promise<{ results: Record<string, { success: boolean; error?: string }> }> {
  const results: Record<string, { success: boolean; error?: string }> = {};
  const INSTALL_TIMEOUT = 120_000;
  const abortController = new AbortController();
  const signal = abortController.signal;

  // Step 1: Get skill info once (shared by all targets)
  let downloadResult: Awaited<ReturnType<SkillMarketService['downloadSkill']>>;

  try {
    await ensureInitialized();
    downloadResult = await skillMarket.downloadSkill(skillId);
  } catch (e) {
    console.debug('[SkillController] Failed to download skill info for multi-target install:', e);
    downloadResult = {
      success: false,
      sourceType: 'skills.sh' as const,
      error: 'Failed to get skill info',
    };
  }

  const timeoutId = setTimeout(() => {
    console.debug(
      '[SkillController] Multi-target install timed out (60s), aborting pending requests',
    );
    abortController.abort();
  }, INSTALL_TIMEOUT);

  // Step 2: Execute installations in parallel
  const tasks = targets.map(async (target) => {
    const key = target.type === 'local' ? 'local' : `remote:${target.serverId}`;

    if (target.type === 'local') {
      // Local install — use pre-fetched download result to avoid duplicate API calls
      const localOnOutput = onOutput
        ? (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
            onOutput(key, data);
          }
        : undefined;

      const result = await installSkillFromMarketWithInfo(
        skillId,
        downloadResult,
        localOnOutput,
        signal,
      );
      results[key] = result;
    } else {
      // Remote install
      const remoteRepo = downloadResult.success ? downloadResult.remoteRepo : undefined;
      const skillName = downloadResult.success ? downloadResult.skillName : undefined;

      if (!remoteRepo || !skillName) {
        onOutput?.(key, {
          type: 'error',
          content: 'Failed to get skill info for remote install\n',
        });
        results[key] = { success: false, error: 'Failed to get skill info' };
        return;
      }

      const remoteOnOutput = onOutput
        ? (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
            onOutput(key, data);
          }
        : undefined;

      try {
        const result = await remoteDeployService.installRemoteSkill(
          target.serverId,
          skillId,
          remoteRepo,
          skillName,
          remoteOnOutput,
          { sourceType: downloadResult.sourceType },
        );
        results[key] = result;
      } catch (error) {
        const err = error instanceof Error ? error.message : 'Remote install failed';
        onOutput?.(key, { type: 'error', content: `${err}\n` });
        results[key] = { success: false, error: err };
      }
    }
  });

  await Promise.all(tasks);
  clearTimeout(timeoutId);

  // Refresh local skills if local was a target
  if (targets.some((t) => t.type === 'local')) {
    try {
      await skillManager.refresh();
    } catch (e) {
      console.debug('[SkillController] Failed to refresh skills after multi-target install:', e);
    }
  }

  return { results };
}

/**
 * Uninstall skill from local and/or specified remote servers.
 */
export async function uninstallSkillMultiTarget(
  appId: string,
  targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>,
  onOutput?: (
    targetKey: string,
    data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
  ) => void,
): Promise<{ results: Record<string, { success: boolean; error?: string }> }> {
  const results: Record<string, { success: boolean; error?: string }> = {};

  const tasks = targets.map(async (target) => {
    const key = target.type === 'local' ? 'local' : `remote:${target.serverId}`;

    if (target.type === 'local') {
      try {
        const result = await skillManager.uninstallSkill(appId);
        results[key] = { success: result };
        onOutput?.(key, { type: 'complete', content: `✓ Skill "${appId}" uninstalled locally\n` });
      } catch (error) {
        const err = error instanceof Error ? error.message : 'Local uninstall failed';
        onOutput?.(key, { type: 'error', content: `✗ ${err}\n` });
        results[key] = { success: false, error: err };
      }
    } else {
      const remoteOnOutput = onOutput
        ? (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
            onOutput(key, data);
          }
        : undefined;

      try {
        const result = await remoteDeployService.uninstallRemoteSkill(
          target.serverId,
          appId,
          remoteOnOutput,
        );
        results[key] = result;

        // Restart proxy if uninstall succeeded so it reloads skill list
        if (result.success) {
          try {
            await remoteDeployService.restartAgentIfRunning(target.serverId, remoteOnOutput);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            onOutput?.(key, {
              type: 'stderr',
              content: `[remote] Warning: proxy restart failed (${msg}). Skills may not take effect until next proxy restart.\n`,
            });
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error.message : 'Remote uninstall failed';
        onOutput?.(key, { type: 'error', content: `[remote] ${err}\n` });
        results[key] = { success: false, error: err };
      }
    }
  });

  await Promise.all(tasks);

  // Refresh local skills if local was a target
  if (targets.some((t) => t.type === 'local')) {
    try {
      await skillManager.refresh();
    } catch (e) {
      console.debug('[SkillController] Failed to refresh skills after multi-target uninstall:', e);
    }
  }

  return { results };
}

/**
 * Sync a local skill to a remote server.
 */
export async function syncLocalSkillToRemote(
  skillId: string,
  serverId: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureInitialized();

    // Verify skill exists locally
    const skill = skillManager.getSkill(skillId);
    if (!skill) {
      const error = `Skill "${skillId}" not found locally`;
      onOutput?.({ type: 'error', content: `${error}\n` });
      return { success: false, error };
    }

    onOutput?.({
      type: 'stdout',
      content: `Syncing skill "${skill.spec.name}" to remote server...\n`,
    });

    const result = await remoteDeployService.syncLocalSkillToRemote(serverId, skillId, onOutput);

    if (result.success) {
      onOutput?.({
        type: 'complete',
        content: `Skill "${skill.spec.name}" synced successfully!\n`,
      });
    }

    return result;
  } catch (error) {
    const err = error instanceof Error ? error.message : 'Failed to sync skill';
    onOutput?.({ type: 'error', content: `${err}\n` });
    return { success: false, error: err };
  }
}

/**
 * Sync a remote skill to local machine.
 */
export async function syncRemoteSkillToLocal(
  skillId: string,
  serverId: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureInitialized();

    // Check if skill already exists locally
    const existingSkill = skillManager.getSkill(skillId);
    if (existingSkill) {
      onOutput?.({
        type: 'stdout',
        content: `Warning: Skill "${skillId}" ("${existingSkill.spec.name}") already exists locally and will be overwritten.\n`,
      });
    }

    onOutput?.({
      type: 'stdout',
      content: `Syncing skill "${skillId}" from remote server to local...\n`,
    });

    const result = await remoteDeployService.syncRemoteSkillToLocal(
      serverId,
      skillId,
      { overwrite: true },
      onOutput,
    );

    if (result.success) {
      // Refresh local skill cache
      await skillManager.refresh();
      onOutput?.({
        type: 'complete',
        content: `Skill "${skillId}" synced to local successfully!\n`,
      });
    }

    return result;
  } catch (error) {
    const err = error instanceof Error ? error.message : 'Failed to sync skill from remote';
    onOutput?.({ type: 'error', content: `${err}\n` });
    return { success: false, error: err };
  }
}

/**
 * Sync skill state to SDK after install/uninstall/toggle operations.
 * Ensures configSkillsDir junctions are updated and SDK sessions are invalidated.
 */
async function syncSkillStateToSdk(): Promise<void> {
  refreshSkillDirectories();
  for (const info of Array.from(v2Sessions.values())) {
    clearSessionId(info.spaceId, info.conversationId);
  }
  invalidateAllSessions();
}

export async function toggleSkill(skillId: string, enabled: boolean) {
  try {
    const result = await skillManager.toggleSkill(skillId, enabled);
    if (result) {
      await syncSkillStateToSdk();
    }
    return { success: result, error: result ? undefined : 'Failed to toggle skill' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to toggle skill',
    };
  }
}

export async function exportSkill(skillId: string) {
  try {
    const yamlContent = await skillManager.exportSkill(skillId);
    if (!yamlContent) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: yamlContent };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to export skill',
    };
  }
}

export async function generateSkillFromConversation(spaceId: string, conversationId?: string) {
  try {
    const result = await skillGenerator.generateFromConversation(spaceId, conversationId);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate skill',
    };
  }
}

export async function generateSkillFromPrompt(options: SkillGenerateOptions) {
  try {
    const result = await skillGenerator.generateFromPrompt(options);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate skill',
    };
  }
}

// Market functions
export async function listMarketSkills(page?: number, pageSize?: number) {
  try {
    console.debug('[SkillController] listMarketSkills called:', { page, pageSize });
    const result = await skillMarket.getSkills(page, pageSize);
    console.debug('[SkillController] listMarketSkills result:', {
      skillsCount: result.skills.length,
      total: result.total,
      hasMore: result.hasMore,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error('[SkillController] listMarketSkills error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch market skills',
    };
  }
}

export async function searchMarketSkills(query: string, page?: number, pageSize?: number) {
  try {
    const result = await skillMarket.searchSkills(query, page, pageSize);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to search skills',
    };
  }
}

export async function resetMarketCache(): Promise<{ success: boolean }> {
  skillMarket.resetCache();
  return { success: true };
}

// Market source management functions
export async function getMarketSources() {
  try {
    await ensureInitialized();
    const sources = skillMarket.getSources();
    const activeSourceId = skillMarket.getActiveSourceId();
    return { success: true, data: sources, activeSourceId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get market sources',
    };
  }
}

export async function addMarketSource(source: {
  name: string;
  url: string;
  repos?: string[];
  description?: string;
}) {
  try {
    await ensureInitialized();
    const newSource = await skillMarket.addSource(source);
    return { success: true, data: newSource };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add market source',
    };
  }
}

export async function removeMarketSource(sourceId: string) {
  try {
    await ensureInitialized();
    const result = await skillMarket.removeSource(sourceId);
    return {
      success: result,
      error: result
        ? undefined
        : 'Failed to remove market source (only custom sources can be removed)',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to remove market source',
    };
  }
}

export async function toggleMarketSource(sourceId: string, enabled: boolean) {
  try {
    await ensureInitialized();
    await skillMarket.toggleSource(sourceId, enabled);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to toggle market source',
    };
  }
}

export async function setActiveMarketSource(sourceId: string) {
  try {
    await ensureInitialized();
    await skillMarket.setActiveSource(sourceId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to set active market source',
    };
  }
}

export async function getMarketSkillDetail(skillId: string) {
  const DETAIL_TIMEOUT_MS = 30_000;
  try {
    const skill = await Promise.race([
      skillMarket.getSkillDetail(skillId),
      new Promise<null>((_, reject) =>
        setTimeout(
          () => reject(new Error('Skill detail fetch timed out (30s)')),
          DETAIL_TIMEOUT_MS,
        ),
      ),
    ]);
    if (!skill) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: skill };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill detail',
    };
  }
}

// Config functions
export async function getSkillConfig() {
  try {
    const config = skillManager.getConfig();
    return { success: true, data: config };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill config',
    };
  }
}

export async function updateSkillConfig(config: Partial<Record<string, unknown>>) {
  try {
    await skillManager.updateConfig(config);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update skill config',
    };
  }
}

export async function refreshSkills() {
  try {
    await ensureInitialized();
    await skillManager.refresh();
    const skills = skillManager.getInstalledSkills();
    return { success: true, data: skills };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to refresh skills',
    };
  }
}

export async function getSkillFiles(skillId: string) {
  try {
    await ensureInitialized();
    const files = await skillManager.getSkillFiles(skillId);
    return { success: true, data: files };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill files',
    };
  }
}

export async function getSkillFileContent(skillId: string, filePath: string) {
  try {
    await ensureInitialized();
    const content = await skillManager.getSkillFileContent(skillId, filePath);
    if (content === null) {
      return { success: false, error: 'File not found or cannot be read' };
    }
    return { success: true, data: content };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get file content',
    };
  }
}

export async function saveSkillFileContent(skillId: string, filePath: string, content: string) {
  try {
    await ensureInitialized();
    const success = await skillManager.saveSkillFileContent(skillId, filePath, content);
    if (!success) {
      return { success: false, error: 'Failed to save file' };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save file content',
    };
  }
}

// ============================================
// Skill Generator & Temp Agent Session
// ============================================

import { conversationAnalyzer } from '../services/skill/conversation-analyzer';
import {
  createTempAgentSession as createSdkTempSession,
  sendTempAgentMessage,
  closeTempAgentSession as closeSdkTempSession,
  getTempSessionStatus,
} from '../services/skill/temp-agent-session';
import { findSimilarSkills } from '../services/skill/similarity-calculator';

// ============================================
// Skill Conversation Service (持久化会话)
// ============================================

import * as skillConversationService from '../services/skill/skill-conversation.service';

/**
 * 列出技能生成器的所有会话
 * @param relatedSkillId 可选，按技能 ID 过滤会话
 */
export async function listSkillConversations(relatedSkillId?: string) {
  try {
    const conversations = skillConversationService.listSkillConversations(relatedSkillId);
    return { success: true, data: conversations };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list skill conversations',
    };
  }
}

/**
 * 获取技能生成器会话详情
 */
export async function getSkillConversation(conversationId: string) {
  try {
    const conversation = skillConversationService.getSkillConversation(conversationId);
    if (!conversation) {
      return { success: false, error: 'Conversation not found' };
    }
    return { success: true, data: conversation };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill conversation',
    };
  }
}

/**
 * 创建新的技能生成器会话
 * @param title 会话标题
 * @param relatedSkillId 可选，关联的技能 ID
 */
export async function createSkillConversation(title?: string, relatedSkillId?: string) {
  try {
    const conversation = skillConversationService.createSkillConversation(title, relatedSkillId);
    return { success: true, data: conversation };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create skill conversation',
    };
  }
}

/**
 * 删除技能生成器会话
 */
export async function deleteSkillConversation(conversationId: string) {
  try {
    const result = skillConversationService.deleteSkillConversation(conversationId);
    return { success: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete skill conversation',
    };
  }
}

/**
 * 发送消息到技能生成器会话
 *
 * 注意：流式事件通过标准的 agent:message, agent:thought 等 IPC 通道发送，
 * 与主对话框使用相同的事件系统。前端通过 chat.store 处理这些事件。
 */
export async function sendSkillConversationMessage(
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
) {
  try {
    // 服务现在直接使用 sendToRenderer 发送标准的 IPC 事件
    const result = await skillConversationService.sendSkillMessage(
      conversationId,
      message,
      metadata,
    );
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message',
    };
  }
}

/**
 * 停止技能生成器消息生成
 */
export async function stopSkillGeneration(conversationId: string) {
  try {
    skillConversationService.stopSkillGeneration(conversationId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop generation',
    };
  }
}

/**
 * 关闭技能生成器会话
 */
export async function closeSkillConversation(conversationId: string) {
  try {
    skillConversationService.closeSkillSession(conversationId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close skill conversation',
    };
  }
}

/**
 * 分析对话，提取技能模式
 */
export async function analyzeConversations(spaceId: string, conversationIds: string[]) {
  try {
    // 分析对话
    const analysisResult = await conversationAnalyzer.analyzeConversations(
      spaceId,
      conversationIds,
    );

    // 获取已安装的技能
    await ensureInitialized();
    const installedSkills = skillManager.getInstalledSkills();

    // 查找相似技能
    const similarSkills = findSimilarSkills(analysisResult, installedSkills, 0.5);

    // 生成建议
    const suggestedName = generateSkillName(analysisResult);
    const suggestedCommand = generateTriggerCommand(analysisResult);

    return {
      success: true,
      data: {
        analysisResult: {
          userIntent: {
            taskType: analysisResult.userIntent.taskType,
            primaryGoal: analysisResult.userIntent.primaryGoal,
            keywords: analysisResult.userIntent.keywords,
          },
          toolPattern: {
            toolSequence: analysisResult.toolPattern.toolSequence,
            successPattern: analysisResult.toolPattern.successPattern,
          },
          reusability: {
            score: analysisResult.reusability.score,
            patterns: analysisResult.reusability.patterns,
          },
        },
        similarSkills: similarSkills.map((s) => ({
          skill: s.skill,
          similarity: s.similarity,
          matchReasons: s.matchReasons,
          suggestedImprovements: s.suggestedImprovements,
        })),
        suggestedName,
        suggestedCommand,
      },
    };
  } catch (error) {
    console.error('[SkillController] Failed to analyze conversations:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze conversations',
    };
  }
}

/**
 * 创建临时 Agent 会话
 * 支持直接传入 context 或通过对话分析生成 context
 * @param onChunk 可选的流式回调,用于创建会话后自动发送初始消息
 */
export async function createTempAgentSession(options: {
  skillName: string;
  conversationIds?: string[];
  spaceIds?: string[];
  context?: {
    conversationAnalysis?: any;
    similarSkills?: any[];
    mode?: 'create' | 'optimize';
    initialPrompt?: string;
  };
  onChunk?: (chunk: StreamChunk) => void;
}) {
  try {
    // 如果直接提供了 context，直接使用
    if (options.context) {
      console.debug('[SkillController] Using provided context:', {
        hasInitialPrompt: !!options.context.initialPrompt,
        mode: options.context.mode,
      });

      const result = await createSdkTempSession({
        skillName: options.skillName,
        context: {
          conversationAnalysis: options.context.conversationAnalysis || null,
          similarSkills: options.context.similarSkills || [],
          mode: options.context.mode || 'create',
          initialPrompt: options.context.initialPrompt,
        },
        onChunk: options.onChunk,
      });
      return result;
    }

    // 如果提供了对话ID，分析这些对话（可选）
    let context: any = { mode: 'create' };

    if (options.conversationIds && options.conversationIds.length > 0 && options.spaceIds) {
      try {
        // 合并所有对话的分析结果
        const analysisResults = [];
        for (let i = 0; i < options.conversationIds.length; i++) {
          const convId = options.conversationIds[i];
          const spaceId = options.spaceIds[i];
          if (spaceId) {
            const result = await conversationAnalyzer.analyzeConversation(spaceId, convId);
            analysisResults.push(result);
          }
        }

        // 合并分析结果
        if (analysisResults.length > 0) {
          const mergedAnalysis = mergeAnalysisResults(analysisResults);

          // 查找相似技能
          const installedSkills = skillManager.getInstalledSkills();
          const similarSkills = findSimilarSkills(mergedAnalysis, installedSkills, 0.5);

          context = {
            mode: similarSkills.length > 0 ? 'optimize' : 'create',
            conversationAnalysis: mergedAnalysis,
            similarSkills,
          };
        }
      } catch (error) {
        console.debug(
          '[SkillController] Failed to analyze conversations, creating without analysis:',
          error,
        );
      }
    }

    const result = await createSdkTempSession({
      skillName: options.skillName,
      context,
      onChunk: options.onChunk,
    });
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to create temp session:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create temp session',
    };
  }
}

/**
 * 合并多个分析结果
 */
function mergeAnalysisResults(results: any[]): any {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  // 合并用户意图
  const mergedIntent = {
    taskType: results[0].userIntent.taskType,
    primaryGoal: results
      .map((r) => r.userIntent.primaryGoal)
      .filter(Boolean)
      .join('; '),
    contextInfo: [...new Set(results.flatMap((r) => r.userIntent.contextInfo || []))],
    keywords: [...new Set(results.flatMap((r) => r.userIntent.keywords || []))],
  };

  // 合并工具模式
  const mergedToolPattern = {
    toolSequence: [...new Set(results.flatMap((r) => r.toolPattern.toolSequence || []))],
    successPattern: results.map((r) => r.toolPattern.successPattern).join('\n'),
    toolStats: results.reduce((acc, r) => ({ ...acc, ...r.toolPattern.toolStats }), {}),
  };

  // 合并可复用性
  const mergedReusability = {
    score: Math.max(...results.map((r) => r.reusability.score)),
    patterns: [...new Set(results.flatMap((r) => r.reusability.patterns || []))],
    suggestions: [...new Set(results.flatMap((r) => r.reusability.suggestions || []))],
  };

  return {
    userIntent: mergedIntent,
    toolPattern: mergedToolPattern,
    reusability: mergedReusability,
    sourceConversationIds: results.flatMap((r) => r.sourceConversationIds),
  };
}

/**
 * 发送消息到临时会话
 */
export async function sendTempAgentMessageWithCallback(
  sessionId: string,
  message: string,
  onChunk: (chunk: any) => void,
) {
  try {
    const result = await sendTempAgentMessage(sessionId, message, onChunk);
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to send temp message:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message',
    };
  }
}

/**
 * 发送消息到临时会话（IPC 调用）
 * 使用 sendTempAgentMessageWithCallback 并提供 chunk 回调
 */
export async function sendTempAgentMessage(
  sessionId: string,
  message: string,
  onChunk?: (chunk: any) => void,
) {
  return sendTempAgentMessageWithCallback(sessionId, message, onChunk || (() => {}));
}

/**
 * 关闭临时会话
 */
export async function closeTempAgentSession(sessionId: string) {
  try {
    const result = await closeSdkTempSession(sessionId);
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to close temp session:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close temp session',
    };
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * 生成技能名称
 */
function generateSkillName(analysis: any): string {
  const taskType = analysis.userIntent.taskType;
  const keywords = analysis.userIntent.keywords;

  // 基于任务类型生成名称
  const typeToName: Record<string, string> = {
    'Git 操作': 'git-helper',
    构建编译: 'build-optimizer',
    运行测试: 'test-runner',
    部署发布: 'deploy-helper',
    代码审查: 'code-reviewer',
    代码重构: 'refactor-assistant',
    调试修复: 'debug-helper',
    创建生成: 'code-generator',
    搜索查询: 'search-assistant',
    分析解释: 'analyzer',
    'UI/样式': 'ui-styler',
    'API 开发': 'api-builder',
    数据库操作: 'db-assistant',
  };

  let baseName = typeToName[taskType] || 'custom-skill';

  // 如果有特定的关键词，可以添加后缀
  if (keywords.length > 0) {
    const firstKeyword = keywords[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (firstKeyword && firstKeyword !== baseName.split('-')[0]) {
      baseName = `${firstKeyword}-helper`;
    }
  }

  return baseName;
}

/**
 * 生成触发命令
 */
function generateTriggerCommand(analysis: any): string {
  const name = generateSkillName(analysis);
  return `/${name.replace(/-/g, '')}`;
}

// ============================================
// Web Page Content Fetcher
// ============================================

/**
 * 获取网页内容（用于从网页创建技能）
 * 使用 MCP web_reader 工具获取网页内容
 */
export async function fetchWebPageContent(url: string): Promise<{
  success: boolean;
  data?: { title: string; content: string };
  error?: string;
}> {
  try {
    // 动态导入 MCP 工具
    const { MCPManager } = await import('../services/agent/mcp-manager');
    const mcpManager = MCPManager.getInstance();

    // 获取 web_reader 工具
    const webReader = mcpManager.getTool('web_reader', 'webReader');
    if (!webReader) {
      // 降级：使用简单的 HTTP fetch
      return await fetchWithHttp(url);
    }

    // 调用 MCP web_reader 工具
    const result = await mcpManager.callTool('web_reader', 'webReader', {
      url,
      return_format: 'markdown',
      retain_images: false,
      no_cache: false,
    });

    if (result.isError) {
      console.error('[SkillController] MCP web_reader error:', result.content);
      // 降级：使用简单的 HTTP fetch
      return await fetchWithHttp(url);
    }

    // 解析结果
    let content = '';
    let title = new URL(url).hostname;

    if (result.content) {
      for (const item of result.content) {
        if (item.type === 'text') {
          content += item.text || '';
        }
      }
    }

    // 从内容中提取标题
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    // 限制内容长度（最多 5000 字符）
    if (content.length > 5000) {
      content = content.slice(0, 5000) + '\n\n...(内容已截断)';
    }

    return {
      success: true,
      data: { title, content },
    };
  } catch (error) {
    console.error('[SkillController] Failed to fetch webpage with MCP:', error);
    // 降级：使用简单的 HTTP fetch
    return await fetchWithHttp(url);
  }
}

/**
 * 降级方案：使用 HTTP fetch 获取网页内容
 */
async function fetchWithHttp(url: string): Promise<{
  success: boolean;
  data?: { title: string; content: string };
  error?: string;
}> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const html = await response.text();

    // 提取标题
    let title = '';
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    // 简单的 HTML to Markdown 转换
    let content = htmlToMarkdown(html);

    // 限制内容长度（最多 5000 字符）
    if (content.length > 5000) {
      content = content.slice(0, 5000) + '...(内容已截断)';
    }

    return {
      success: true,
      data: {
        title: title || new URL(url).hostname,
        content,
      },
    };
  } catch (error) {
    console.error('[SkillController] Failed to fetch webpage:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '获取网页失败',
    };
  }
}

/**
 * 简单的 HTML to Markdown 转换
 */
function htmlToMarkdown(html: string): string {
  let md = html;

  // 移除 script 和 style 标签及其内容
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  md = md.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  md = md.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  md = md.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // 转换标题
  md = md.replace(/<h1[^>]*>([^<]+)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>([^<]+)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>([^<]+)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>([^<]+)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>([^<]+)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>([^<]+)<\/h6>/gi, '###### $1\n\n');

  // 转换段落
  md = md.replace(/<p[^>]*>([^<]+)<\/p>/gi, '$1\n\n');

  // 转换链接
  md = md.replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '[$2]($1)');

  // 转换加粗和斜体
  md = md.replace(/<(strong|b)[^>]*>([^<]+)<\/(strong|b)>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>([^<]+)<\/(em|i)>/gi, '*$2*');

  // 转换代码块
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n');
  md = md.replace(/<code[^>]*>([^<]+)<\/code>/gi, '`$1`');

  // 转换列表
  md = md.replace(/<li[^>]*>([^<]+)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[ou]l[^>]*>/gi, '\n');

  // 转换换行
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 移除其他 HTML 标签
  md = md.replace(/<[^>]+>/g, '');

  // 解码 HTML 实体
  md = md.replace(/&nbsp;/g, ' ');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');

  // 清理多余空白
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.replace(/[ \t]{2,}/g, ' ');
  md = md.trim();

  return md;
}

// ── GitHub Source Operations ──────────────────────────────────────────

/**
 * Push a local skill to a GitHub repo via PR
 */
export async function pushSkillToGitHub(
  skillId: string,
  targetRepo: string,
  targetPath?: string,
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
  try {
    // Read all local skill files (not just SKILL.md)
    const files = await githubSkillSource.readLocalSkillFiles(skillId);
    if (files.length === 0) {
      return { success: false, error: `Skill "${skillId}" not found locally or has no files` };
    }

    // Get GitHub token
    const token = githubSkillSource.getGitHubToken();
    if (!token) {
      return {
        success: false,
        error: 'Not authenticated with GitHub. Please login via Settings > GitHub.',
      };
    }

    // Push all files via PR
    return await githubSkillSource.pushSkillAsPR(targetRepo, skillId, files, targetPath, token);
  } catch (error: any) {
    console.error('[SkillController] pushSkillToGitHub error:', error);
    return { success: false, error: error.message || 'Failed to push skill to GitHub' };
  }
}

/**
 * List subdirectories under skills/ in a GitHub repo
 */
export async function listRepoDirectories(
  repo: string,
): Promise<{ success: boolean; data?: string[]; error?: string }> {
  try {
    console.debug(`[SkillController] listRepoDirectories for: ${repo}`);
    const dirs = await githubSkillSource.listRepoDirectories(repo);
    console.debug(`[SkillController] listRepoDirectories result:`, dirs);
    return { success: true, data: dirs };
  } catch (error: any) {
    console.error(`[SkillController] listRepoDirectories error:`, error);
    return { success: false, error: error.message || 'Failed to list directories' };
  }
}

/**
 * Validate a GitHub repo for use as a skill source
 */
export async function validateGitHubRepo(repo: string): Promise<{
  success: boolean;
  data?: { valid: boolean; hasSkillsDir: boolean; skillCount: number };
  error?: string;
}> {
  try {
    const token = githubSkillSource.getGitHubToken();
    const result = await githubSkillSource.validateRepo(repo, token);
    return { success: true, data: result };
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to validate repository' };
  }
}

// ── GitCode operations ─────────────────────────────────────────────

export async function pushSkillToGitCode(
  skillId: string,
  targetRepo: string,
  targetPath?: string,
): Promise<{ success: boolean; prUrl?: string; error?: string; warning?: string }> {
  try {
    const files = await gitcodeSkillSource.readLocalSkillFiles(skillId);
    if (files.length === 0) {
      return { success: false, error: `Skill "${skillId}" not found locally or has no files` };
    }
    const token = gitcodeSkillSource.getGitCodeToken();
    if (!token) {
      return { success: false, error: 'GitCode token not configured. Please set it in Settings.' };
    }
    const result = await gitcodeSkillSource.pushSkillAsMR(
      targetRepo,
      skillId,
      files,
      targetPath,
      token,
    );
    // Normalize mrUrl → prUrl for consistent frontend handling
    if (result.success && result.mrUrl) {
      return { ...result, prUrl: result.mrUrl, mrUrl: undefined };
    }
    return result as any;
  } catch (error: any) {
    console.error('[SkillController] pushSkillToGitCode error:', error);
    return { success: false, error: error.message || 'Failed to push skill to GitCode' };
  }
}

export async function listGitCodeRepoDirectories(
  repo: string,
): Promise<{ success: boolean; data?: string[]; error?: string }> {
  try {
    const token = gitcodeSkillSource.getGitCodeToken();
    const dirs = await gitcodeSkillSource.listRepoDirectories(repo, undefined, token);
    return { success: true, data: dirs };
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to list directories' };
  }
}

export async function validateGitCodeRepo(repo: string): Promise<{
  success: boolean;
  data?: { valid: boolean; hasSkillsDir: boolean; skillCount: number };
  error?: string;
}> {
  try {
    const token = gitcodeSkillSource.getGitCodeToken();
    const result = await gitcodeSkillSource.validateRepo(repo, token);
    return { success: true, data: result };
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to validate repository' };
  }
}

export async function setGitCodeToken(token: string): Promise<{ success: boolean }> {
  const { setGitCodeToken: saveToken } = await import('../services/config.service');
  saveToken(token || undefined);
  return { success: true };
}
