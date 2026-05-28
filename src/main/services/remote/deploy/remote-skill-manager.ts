/**
 * Remote Skill Manager - Remote skill management (list, install, sync, uninstall, read/write)
 *
 * Extracted from remote-deploy.service.ts using composition pattern.
 * All functions take (service: RemoteDeployService, ...) as first parameter.
 */

import * as fs from 'fs';
import path from 'path';
import os from 'os';
import type { SSHManager } from '../ssh/ssh-manager';
import { parse as parseYaml } from 'yaml';
import type { InstalledSkill } from '../../../../shared/skill/skill-types';
import type { SkillFileNode } from '../../../../shared/skill/skill-types';
import type { RemoteDeployService } from './remote-deploy.service';

/**
 * List skills installed on a remote server.
 * Uses a batch SSH command to minimize round-trips.
 */
export async function listRemoteSkills(service: RemoteDeployService, id: string): Promise<InstalledSkill[]> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  // Ensure SSH connection (always re-fetch manager after connectServer)
  if (!service.getSSHManager(id).isConnected()) {
    await service.connectServer(id);
  }
  const manager = service.getSSHManager(id);
  if (!manager.isConnected()) {
    throw new Error(`Failed to establish SSH connection to ${server.name}`);
  }

  // Batch-read all skill metadata in one SSH command
  // NOTE: Use regular string to avoid JS template literal interpolation of shell $vars
  // For SKILL.md: output entire file content (frontmatter + body), since system_prompt
  // lives in the markdown body, not the YAML frontmatter (Claude Code native format)
  // Scans both ~/.agents/skills/ and ~/.claude/skills/
  // For duplicates, keeps the one with the most recent directory modification time
  const batchCmd = [
    'declare -A best_mtime best_dir',
    'for skills_base in ~/.agents/skills ~/.claude/skills; do',
    '  [ -d "$skills_base" ] || continue',
    '  for dir in "$skills_base"/*/; do',
    '    [ -d "$dir" ] || continue',
    '    skill=$(basename "$dir")',
    '    mtime=$(stat -c %Y "$dir" 2>/dev/null || stat -f %m "$dir" 2>/dev/null || echo 0)',
    '    if [ -z "${best_mtime[$skill]}" ] || [ "$mtime" -gt "${best_mtime[$skill]}" ]; then',
    '      best_mtime[$skill]=$mtime',
    '      best_dir[$skill]=$dir',
    '    fi',
    '  done',
    'done',
    'for skill in "${!best_dir[@]}"; do',
    '  dir="${best_dir[$skill]}"',
    '  echo "===SKILL_START:${skill}==="',
    '  cat "$dir/META.json" 2>/dev/null || echo \'{}\'',
    '  echo "===META_END==="',
    '  echo "===SKILL_CONTENT==="',
    '  if [ -f "$dir/SKILL.md" ]; then cat "$dir/SKILL.md";',
    '  elif [ -f "$dir/SKILL.yaml" ]; then cat "$dir/SKILL.yaml";',
    '  fi',
    '  echo "===SKILL_CONTENT_END==="',
    'done',
  ].join('\n');

  console.debug(
    `[RemoteDeployService] Listing skills on ${server.name}, executing batch command...`,
  );
  const result = await manager.executeCommandFull(batchCmd);
  console.debug(
    `[RemoteDeployService] Batch command result: exitCode=${result.exitCode}, stdoutLen=${result.stdout.length}, stderrLen=${result.stderr.length}`,
  );
  const stdout = result.stdout.trim();

  if (!stdout) return [];

  const skills: InstalledSkill[] = [];
  const blocks = stdout.split('===SKILL_START:');

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Block starts with "skillId===\n...", extract the ID and skip past the header
    const skillId = block.split('===')[0].trim();
    if (!skillId) continue;

    // Find where the actual content starts (after "skillId===\n")
    const headerEnd = block.indexOf('===\n');
    const contentStart = headerEnd === -1 ? 0 : headerEnd + '===\n'.length;

    const metaEndIdx = block.indexOf('===META_END===');
    const contentEndIdx = block.indexOf('===SKILL_CONTENT_END===');
    if (metaEndIdx === -1 || contentEndIdx === -1) continue;

    const metaPart = block.substring(contentStart, metaEndIdx).trim();
    const contentPart = block
      .substring(metaEndIdx + '===META_END==='.length, contentEndIdx)
      .trim();
    // Strip the ===SKILL_CONTENT=== marker line
    const markerIdx = contentPart.indexOf('===SKILL_CONTENT===');
    const skillContent =
      markerIdx === -1
        ? contentPart
        : contentPart.substring(markerIdx + '===SKILL_CONTENT==='.length).trim();

    let enabled = true;
    let installedAt = '';
    try {
      const meta = JSON.parse(metaPart);
      enabled = meta.enabled ?? true;
      installedAt = meta.installedAt ?? '';
    } catch {
      // Ignore parse errors
    }

    if (!skillContent) continue;

    try {
      // Try parsing as SKILL.md format first (frontmatter + body)
      const frontmatterMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (frontmatterMatch) {
        // SKILL.md format: system_prompt comes from the markdown body
        const frontmatter = parseYaml(frontmatterMatch[1]) as any;
        const body = skillContent.slice(frontmatterMatch[0].length).trim();
        skills.push({
          appId: skillId,
          spec: {
            name: frontmatter.name || skillId,
            description: frontmatter.description || '',
            version: frontmatter.version || '1.0',
            author: frontmatter.author || '',
            system_prompt: body || '',
            trigger_command: frontmatter.trigger_command || '',
            tags: frontmatter.tags || [],
            type: 'skill',
          },
          enabled,
          installedAt,
        });
      } else {
        // Pure YAML format (SKILL.yaml)
        const spec = parseYaml(skillContent) as any;
        skills.push({
          appId: skillId,
          spec: {
            name: spec.name || skillId,
            description: spec.description || '',
            version: spec.version || '1.0',
            author: spec.author || '',
            system_prompt: spec.system_prompt || '',
            trigger_command: spec.trigger_command || '',
            tags: spec.tags || [],
            type: 'skill',
          },
          enabled,
          installedAt,
        });
      }
    } catch (e) {
      console.debug(
        `[RemoteDeployService] Failed to parse skill content for remote skill: ${skillId}`,
        e,
      );
    }
  }

  return skills;
}

/**
 * List files in a remote skill directory.
 * Returns a SkillFileNode tree matching the local SkillManager.getSkillFiles() interface.
 */
export async function listRemoteSkillFiles(service: RemoteDeployService, id: string, skillId: string): Promise<SkillFileNode[]> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  if (!service.getSSHManager(id).isConnected()) {
    await service.connectServer(id);
  }
  const manager = service.getSSHManager(id);
  if (!manager.isConnected()) {
    throw new Error(`Failed to establish SSH connection to ${server.name}`);
  }

  // Use find to get full recursive listing with file sizes
  // NOTE: Avoid -print0/read -d '' to prevent shell escaping issues
  // Look in both ~/.agents/skills/ and ~/.claude/skills/
  const cmd = [
    'skill_dir=""',
    'for base in ~/.agents/skills ~/.claude/skills; do',
    '  [ -d "$base/' + skillId + '" ] && skill_dir="$base/' + skillId + '" && break',
    'done',
    '[ -z "$skill_dir" ] && exit 1',
    'cd "$skill_dir"',
    'find . -not -path "./.git/*" -not -name "." | sort | while IFS= read -r item; do',
    '  if [ -z "$item" ]; then continue; fi',
    '  if [ -d "$item" ]; then',
    '    echo "DIR:${item:2}"',
    '  else',
    '    size=$(stat -c%s "$item" 2>/dev/null || echo 0)',
    '    echo "FILE:${item:2}:$size"',
    '  fi',
    'done',
  ].join('\n');

  console.debug(`[RemoteDeployService] Listing files for remote skill: ${skillId}`);
  const result = await manager.executeCommandFull(cmd);
  console.debug(
    `[RemoteDeployService] File list exitCode=${result.exitCode}, stdoutLen=${result.stdout.length}, stderr=${result.stderr.substring(0, 200)}`,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    console.debug(`[RemoteDeployService] No files found for skill: ${skillId}`);
    return [];
  }

  // Build tree from flat listing
  const nodes: SkillFileNode[] = [];

  const ensureDir = (dirPath: string): SkillFileNode => {
    const parts = dirPath.split('/');
    let current = nodes;
    let parent: SkillFileNode | undefined;
    for (const part of parts) {
      let existing = current.find((n) => n.name === part && n.type === 'directory');
      if (!existing) {
        existing = {
          name: part,
          type: 'directory',
          path: dirPath
            .split('/')
            .slice(0, parts.indexOf(part) + 1)
            .join('/'),
          children: [],
        };
        if (parent) parent.children!.push(existing);
        else current.push(existing);
      }
      parent = existing;
      current = existing.children!;
    }
    return parent!;
  };

  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('DIR:')) {
      const dirPath = line.substring(4);
      ensureDir(dirPath);
    } else if (line.startsWith('FILE:')) {
      const rest = line.substring(5);
      const lastColon = rest.lastIndexOf(':');
      const filePath = rest.substring(0, lastColon);
      const size = parseInt(rest.substring(lastColon + 1)) || 0;
      const name = filePath.split('/').pop()!;
      const ext = name.includes('.') ? name.split('.').pop() : undefined;

      // Ensure parent directories exist
      const dirParts = filePath.split('/');
      if (dirParts.length > 1) {
        const parentPath = dirParts.slice(0, -1).join('/');
        const parent = ensureDir(parentPath);
        parent.children!.push({ name, type: 'file', path: filePath, size, extension: ext });
      } else {
        nodes.push({ name, type: 'file', path: filePath, size, extension: ext });
      }
    }
  }

  // Sort: directories first, then files, alphabetically
  const sortNodes = (list: SkillFileNode[]) => {
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of list) {
      if (node.children) sortNodes(node.children);
    }
  };
  sortNodes(nodes);

  return nodes;
}

/**
 * Read a file from a remote skill directory.
 */
export async function readRemoteSkillFile(service: RemoteDeployService, id: string, skillId: string, filePath: string): Promise<string | null> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  if (!service.getSSHManager(id).isConnected()) {
    await service.connectServer(id);
  }
  const manager = service.getSSHManager(id);
  if (!manager.isConnected()) {
    throw new Error(`Failed to establish SSH connection to ${server.name}`);
  }

  const result = await manager.executeCommandFull(
    [
      'skill_dir=""',
      'for base in ~/.agents/skills ~/.claude/skills; do',
      '  [ -d "$base/' + skillId + '" ] && skill_dir="$base/' + skillId + '" && break',
      'done',
      '[ -z "$skill_dir" ] && exit 1',
      'cat "$skill_dir/' + filePath + '"',
    ].join('\n'),
  );

  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/**
 * Ensure a fresh SSH connection for a server.
 * Always disconnects and reconnects to avoid stale connections.
 */
export async function ensureFreshConnection(
  service: RemoteDeployService,
  id: string,
  serverName: string,
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
): Promise<SSHManager> {
  onOutput?.({ type: 'stdout', content: `[${serverName}] 正在连接...\n` });

  // Health-check the existing connection instead of blindly disconnecting.
  // This avoids killing in-flight operations (e.g., health monitor).
  await service.ensureSshConnectionHealthy(id);

  const manager = service.getSSHManager(id);
  if (!manager.isConnected()) {
    throw new Error(`Failed to connect to ${serverName}`);
  }
  return manager;
}

/**
 * Execute a command with timeout protection.
 * Prevents commands from hanging indefinitely on broken connections.
 */
export async function executeWithTimeout(
  _service: RemoteDeployService,
  manager: SSHManager,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Command timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    ),
  );
  return Promise.race([manager.executeCommandFull(command), timeoutPromise]);
}

/**
 * Install a skill on a remote server via SSH.
 * For GitHub/skills.sh: tries `npx skills add` first, falls back to direct upload.
 * For GitCode: always uses direct upload (npx only supports GitHub URLs).
 * Streams stdout/stderr back through onOutput callback.
 */
export async function installRemoteSkill(
  service: RemoteDeployService,
  id: string,
  skillId: string,
  remoteRepo: string,
  skillName: string,
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
  options?: {
    sourceType?: 'github' | 'gitcode' | 'skills.sh';
  },
): Promise<{ success: boolean; error?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  let manager: SSHManager;
  try {
    manager = await ensureFreshConnection(service, id, server.name, onOutput);
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` });
    return { success: false, error: err.message };
  }

  // Ensure remote skills directory exists
  onOutput?.({ type: 'stdout', content: `[${server.name}] 准备远程环境...\n` });
  try {
    const remoteHome = (await manager.executeCommand('echo $HOME')).trim();
    const remoteSkillsDir = `${remoteHome}/.agents/skills`;
    await manager.executeCommand(`mkdir -p ${remoteSkillsDir}`);
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] 准备远程环境失败: ${err.message}\n` });
    return { success: false, error: err.message };
  }

  const sourceType = options?.sourceType || 'github';

  // GitCode: skip npx (npx only supports GitHub URLs), go straight to direct upload
  if (sourceType === 'gitcode') {
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] GitCode 源，使用 Direct Upload 模式安装...\n`,
    });
    return installRemoteSkillDirect(
      service,
      id,
      skillId,
      remoteRepo,
      skillName,
      sourceType,
      onOutput,
    );
  }

  // GitHub / skills.sh: try npx first, fallback to direct upload
  const command = `cd ~ && npx --yes skills add https://github.com/${remoteRepo} --skill ${skillName} -y --global 2>&1`;
  onOutput?.({
    type: 'stdout',
    content: `[${server.name}] $ npx skills add https://github.com/${remoteRepo} --skill ${skillName} -y --global\n`,
  });

  try {
    const result = await executeWithTimeout(service, manager, command, 180000);

    if (result.stdout) {
      onOutput?.({ type: 'stdout', content: result.stdout });
    }
    if (result.stderr) {
      const filtered = result.stderr
        .split('\n')
        .filter((line) => !line.toLowerCase().includes('npm warn'))
        .join('\n')
        .trim();
      if (filtered) {
        onOutput?.({ type: 'stderr', content: filtered + '\n' });
      }
    }

    if (result.exitCode === 0) {
      onOutput?.({
        type: 'complete',
        content: `[${server.name}] ✓ Skill installed successfully!\n`,
      });
      return { success: true };
    }
    // npx failed -- fallback to direct upload
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] npx 安装失败 (exit code ${result.exitCode})，切换到 Direct Upload...\n`,
    });
  } catch (error) {
    // npx timed out or connection error -- fallback to direct upload
    const err = error as Error;
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] npx 安装异常 (${err.message})，切换到 Direct Upload...\n`,
    });
  }

  return installRemoteSkillDirect(service, id, skillId, remoteRepo, skillName, sourceType, onOutput);
}

/**
 * Download skill files from the source API on local machine, then upload to remote via SSH.
 * This works for all source types (GitHub, GitCode, skills.sh) and does not require Node.js on the remote.
 */
async function installRemoteSkillDirect(
  service: RemoteDeployService,
  id: string,
  skillId: string,
  remoteRepo: string,
  skillName: string,
  sourceType: 'github' | 'gitcode' | 'skills.sh',
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
): Promise<{ success: boolean; error?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  let manager: SSHManager;
  try {
    manager = await ensureFreshConnection(service, id, server.name, onOutput);
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` });
    return { success: false, error: err.message };
  }

  const label = sourceType === 'gitcode' ? 'GitCode' : 'GitHub';
  const tmpDir = path.join(os.tmpdir(), `aico-skill-upload-${Date.now()}`);

  try {
    // Step 1: Import adapter from skill.controller (dynamic import to avoid circular deps)
    const { GITHUB_ADAPTER, GITCODE_ADAPTER } =
      await import('../../../controllers/skill.controller');
    const adapter = sourceType === 'gitcode' ? GITCODE_ADAPTER : GITHUB_ADAPTER;

    // Step 2: Find the skill directory on the source
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] [Direct Upload] 从 ${label} 定位技能目录...\n`,
    });
    const token = await adapter.getToken();
    if (token) {
      onOutput?.({
        type: 'stdout',
        content: `  Using authenticated ${label} access\n`,
      });
    }

    const dirPath = await adapter.findSkillDirectoryPath(remoteRepo, skillName, token);
    if (!dirPath) {
      const error = `Could not find skill directory for "${skillName}" in repo ${remoteRepo}`;
      onOutput?.({ type: 'error', content: `[${server.name}] ${error}\n` });
      return { success: false, error };
    }
    onOutput?.({ type: 'stdout', content: `  Found skill at: ${dirPath}/\n` });

    // Step 3: Download all files
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] [Direct Upload] 下载技能文件...\n`,
    });
    const files = await adapter.fetchSkillDirectoryContents(remoteRepo, dirPath, token);
    if (files.length === 0) {
      const error = `No files found in skill directory: ${dirPath}`;
      onOutput?.({ type: 'error', content: `[${server.name}] ${error}\n` });
      return { success: false, error };
    }
    onOutput?.({ type: 'stdout', content: `  Downloaded ${files.length} file(s)\n` });

    // Step 4: Write to local temp directory
    await fs.promises.mkdir(tmpDir, { recursive: true });
    for (const file of files) {
      const filePath = path.join(tmpDir, file.path);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, file.content, 'utf-8');
    }

    // Step 5: Upload to remote via SFTP (binary-safe, no command length limit)
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] [Direct Upload] 上传文件到远程服务器...\n`,
    });
    const remoteHome = (await manager.executeCommand('echo $HOME')).trim();

    // Derive a short directory-safe name from skillName (same logic as local installSkillFromSource)
    const lastSegment = skillName.split('/').pop() || skillName;
    const dirName = lastSegment
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '-');

    const remoteSkillDir = `${remoteHome}/.agents/skills/${dirName}`;
    await manager.executeCommand(`rm -rf "${remoteSkillDir}"`);
    await manager.executeCommand(`mkdir -p "${remoteSkillDir}"`);

    for (const file of files) {
      const remoteFilePath = `${remoteSkillDir}/${file.path}`;
      const remoteDir = path.dirname(remoteFilePath);
      await manager.executeCommand(`mkdir -p "${remoteDir}"`);
      await manager.writeFile(remoteFilePath, Buffer.from(file.content));
      onOutput?.({ type: 'stdout', content: `  ✓ ${file.path}\n` });
    }

    // Step 6: Generate META.json on remote
    const skillMdFile = files.find(
      (f) => f.path === 'SKILL.md' || f.path.toUpperCase() === 'SKILL.MD',
    );
    const skillYamlFile = files.find(
      (f) => f.path === 'SKILL.yaml' || f.path.toUpperCase() === 'SKILL.YAML',
    );

    let metaJson = JSON.stringify({
      appId: dirName,
      enabled: true,
      installedAt: new Date().toISOString(),
    });

    if (skillMdFile) {
      const frontmatterMatch = skillMdFile.content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        try {
          const meta = parseYaml(frontmatterMatch[1]);
          metaJson = JSON.stringify({
            appId: skillId,
            spec: meta,
            enabled: true,
            installedAt: new Date().toISOString(),
          });
        } catch {
          // frontmatter parse failed, use basic meta
        }
      }
    } else if (skillYamlFile) {
      try {
        const meta = parseYaml(skillYamlFile.content);
        const spec = meta?.skill || meta;
        metaJson = JSON.stringify({
          appId: skillId,
          spec,
          enabled: true,
          installedAt: new Date().toISOString(),
        });
      } catch {
        // yaml parse failed, use basic meta
      }
    }

    await manager.writeFile(`${remoteSkillDir}/META.json`, Buffer.from(metaJson));
    onOutput?.({ type: 'stdout', content: `  ✓ META.json\n` });

    onOutput?.({
      type: 'complete',
      content: `[${server.name}] ✓ Skill installed successfully via Direct Upload (${files.length} files)!\n`,
    });
    return { success: true };
  } catch (error) {
    const err = error as Error;
    onOutput?.({
      type: 'error',
      content: `[${server.name}] Direct Upload failed: ${err.message}\n`,
    });
    return { success: false, error: err.message };
  } finally {
    // Clean up temp directory
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Sync a local skill to a remote server via SSH.
 * Reads local skill files and uploads them to ~/.agents/skills/<skillId>/ on the remote.
 */
export async function syncLocalSkillToRemote(
  service: RemoteDeployService,
  id: string,
  skillId: string,
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
): Promise<{ success: boolean; error?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  let manager: SSHManager;
  try {
    manager = await ensureFreshConnection(service, id, server.name, onOutput);
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` });
    return { success: false, error: err.message };
  }

  try {
    // Read local skill files
    const { readLocalSkillFiles } = await import('../../skill/github-skill-source.service');
    const files = await readLocalSkillFiles(skillId);
    if (files.length === 0) {
      const error = `Skill "${skillId}" not found locally or has no files`;
      onOutput?.({ type: 'error', content: `${error}\n` });
      return { success: false, error };
    }

    // Prepare remote directory
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] Syncing skill "${skillId}" (${files.length} files)...\n`,
    });
    const remoteHome = (await manager.executeCommand('echo $HOME')).trim();
    const remoteSkillDir = `${remoteHome}/.agents/skills/${skillId}`;
    await manager.executeCommand(`rm -rf "${remoteSkillDir}"`);
    await manager.executeCommand(`mkdir -p "${remoteSkillDir}"`);

    // Upload each file via SFTP (binary-safe, no command length limit)
    for (const file of files) {
      const remotePath = `${remoteSkillDir}/${file.relativePath}`;
      const remoteDir = path.dirname(remotePath);
      await manager.executeCommand(`mkdir -p '${remoteDir}'`);
      await manager.writeFile(remotePath, Buffer.from(file.content));
      onOutput?.({ type: 'stdout', content: `  ✓ ${file.relativePath}\n` });
    }

    onOutput?.({
      type: 'complete',
      content: `[${server.name}] ✓ Skill "${skillId}" synced successfully (${files.length} files)!\n`,
    });
    return { success: true };
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] Error: ${err.message}\n` });
    return { success: false, error: err.message };
  }
}

/**
 * Sync a remote skill to local machine via SSH.
 * Reads remote skill files and downloads them to ~/.agents/skills/<skillId>/ locally.
 */
export async function syncRemoteSkillToLocal(
  service: RemoteDeployService,
  id: string,
  skillId: string,
  options?: { overwrite?: boolean },
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
): Promise<{ success: boolean; error?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  let manager: SSHManager;
  try {
    manager = await ensureFreshConnection(service, id, server.name, onOutput);
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` });
    return { success: false, error: err.message };
  }

  try {
    const { getAgentsSkillsDir } = await import('../../config.service');
    const { promises: fsp } = await import('fs');

    const localSkillDir = path.join(getAgentsSkillsDir(), skillId);

    // Check if skill already exists locally
    const existsLocally = fs.existsSync(localSkillDir);
    if (existsLocally && !options?.overwrite) {
      const error = `Skill "${skillId}" already exists locally. Use overwrite option to replace.`;
      onOutput?.({ type: 'error', content: `${error}\n` });
      return { success: false, error };
    }
    if (existsLocally) {
      onOutput?.({
        type: 'stdout',
        content: `[${server.name}] Skill "${skillId}" already exists locally, will be overwritten.\n`,
      });
      await fsp.rm(localSkillDir, { recursive: true, force: true });
    }

    // List remote files
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] Discovering files for remote skill "${skillId}"...\n`,
    });

    const remoteFiles = await service.listRemoteSkillFiles(id, skillId);

    // Flatten file tree to get all file paths
    const filepaths: string[] = [];
    function collectFiles(nodes: SkillFileNode[]): void {
      for (const node of nodes) {
        if (node.type === 'file') {
          filepaths.push(node.path);
        } else if (node.children) {
          collectFiles(node.children);
        }
      }
    }
    collectFiles(remoteFiles);

    if (filepaths.length === 0) {
      const error = `Skill "${skillId}" has no files on remote server`;
      onOutput?.({ type: 'error', content: `${error}\n` });
      return { success: false, error };
    }

    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] Downloading skill "${skillId}" (${filepaths.length} files)...\n`,
    });

    // Create local directory
    await fsp.mkdir(localSkillDir, { recursive: true });

    // Build the skill directory discovery shell script (reusable prefix)
    const findSkillDirScript = [
      'skill_dir=""',
      'for base in ~/.agents/skills ~/.claude/skills; do',
      `  [ -d "$base/${skillId}" ] && skill_dir="$base/${skillId}" && break`,
      'done',
      '[ -z "$skill_dir" ] && exit 1',
    ].join('\n');

    // Download each file via SSH base64
    for (const filePath of filepaths) {
      const safePath = filePath.replace(/'/g, "'\\''");
      const cmd = `${findSkillDirScript}\ncat "$skill_dir/${safePath}" | base64 -w 0`;
      const result = await manager.executeCommandFull(cmd);

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        onOutput?.({
          type: 'stderr',
          content: `  ⚠ ${filePath}: failed to read (skipped)\n`,
        });
        continue;
      }

      const content = Buffer.from(result.stdout.trim(), 'base64').toString('utf-8');
      const localPath = path.join(localSkillDir, ...filePath.split('/'));
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      await fsp.writeFile(localPath, content, 'utf-8');
      onOutput?.({ type: 'stdout', content: `  ✓ ${filePath}\n` });
    }

    onOutput?.({
      type: 'complete',
      content: `[${server.name}] ✓ Skill "${skillId}" synced to local successfully (${filepaths.length} files)!\n`,
    });
    return { success: true };
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] Error: ${err.message}\n` });
    return { success: false, error: err.message };
  }
}

/**
 * Uninstall a skill from a remote server via SSH.
 */
export async function uninstallRemoteSkill(
  service: RemoteDeployService,
  id: string,
  skillId: string,
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
): Promise<{ success: boolean; error?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  let manager: SSHManager;
  try {
    manager = await ensureFreshConnection(service, id, server.name, onOutput);
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] ${err.message}\n` });
    return { success: false, error: err.message };
  }

  try {
    const remoteHome = (await manager.executeCommand('echo $HOME')).trim();

    onOutput?.({ type: 'stdout', content: `[${server.name}] Removing skill "${skillId}"...\n` });

    // Remove from both possible source locations
    const removeCmd = [
      `rm -rf ${remoteHome}/.agents/skills/${skillId}`,
      `rm -rf ${remoteHome}/.claude/skills/${skillId}`,
    ].join(' && ');

    const removeResult = await executeWithTimeout(service, manager, removeCmd, 30000);
    if (removeResult.exitCode !== 0) {
      const error = `[${server.name}] Failed to uninstall skill (exit code ${removeResult.exitCode})`;
      onOutput?.({ type: 'error', content: error + '\n' });
      return { success: false, error };
    }

    // Clean up symlinks in claude-config that point to deleted skill directories
    const cleanSymlinksCmd = [
      `rm -f ${remoteHome}/.agents/claude-config/skills/${skillId}`,
      `find ${remoteHome}/.agents/claude-config/.claude/skills/ -maxdepth 1 -type l ! -exec test -e {} \\; -delete 2>/dev/null || true`,
    ].join(' && ');

    const cleanResult = await executeWithTimeout(service, manager, cleanSymlinksCmd, 15000);
    if (cleanResult.exitCode !== 0) {
      onOutput?.({
        type: 'stderr',
        content: `[${server.name}] Warning: symlink cleanup returned non-zero exit code\n`,
      });
    }

    onOutput?.({
      type: 'complete',
      content: `[${server.name}] ✓ Skill "${skillId}" uninstalled successfully!\n`,
    });
    return { success: true };
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `[${server.name}] Error: ${err.message}\n` });
    return { success: false, error: err.message };
  }
}
