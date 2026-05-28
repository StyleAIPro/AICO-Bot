/**
 * Skill 管理器 - 核心服务
 * 负责技能的加载、安装、卸载、启用/禁用
 *
 * 存储结构：
 * - 全局 skills: ~/.agents/skills/
 * - Claude 原生 skills: ~/.claude/skills/
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { existsSync, createReadStream, createWriteStream, mkdirSync } from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as yauzl from 'yauzl';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  SkillSpec,
  InstalledSkill,
  SkillLibraryConfig,
  SkillFileNode,
} from '../../shared/skill/skill-types';
import { getAgentsSkillsDir, getClaudeSkillsDir, getAllSkillsDirs } from '../config.service';

export interface ImportSkillsResult {
  installed: string[];
  skipped: string[];
  errors: string[];
}

export class SkillManager {
  private static instance: SkillManager;
  private skillsDirs: string[];
  private configPath: string;

  // 禁用的技能 ID 集合（供 permission-handler 和 system prompt 查询）
  private disabledSkillIds: Set<string> = new Set();

  /** 获取所有已禁用的技能 ID */
  getDisabledSkillIds(): ReadonlySet<string> {
    return this.disabledSkillIds;
  }

  /** 获取全局单例的禁用技能集合（供跨模块访问） */
  static getGlobalDisabledSkillIds(): ReadonlySet<string> {
    return SkillManager.instance?.disabledSkillIds ?? new Set();
  }

  // 已安装的技能缓存
  private installedSkills: Map<string, InstalledSkill> = new Map();

  // 技能来源目录映射 (skillId -> skillsDir)
  private skillDirMap: Map<string, string> = new Map();

  // 技能配置
  private config: SkillLibraryConfig = {};

  private constructor() {
    this.skillsDirs = getAllSkillsDirs();
    this.configPath = path.join(getAgentsSkillsDir(), '..', 'skill-config.json');
  }

  static getInstance(): SkillManager {
    if (!SkillManager.instance) {
      SkillManager.instance = new SkillManager();
    }
    return SkillManager.instance;
  }

  /**
   * 初始化技能管理器
   */
  async initialize(): Promise<void> {
    // 确保所有技能目录存在
    for (const dir of this.skillsDirs) {
      await fs.mkdir(dir, { recursive: true });
    }

    // 加载配置
    await this.loadConfig();

    // 加载已安装的 skills
    await this.loadSkills();

    console.log(
      '[SkillManager] Initialized with',
      this.installedSkills.size,
      'skills from',
      this.skillsDirs.length,
      'directories',
    );
  }

  /**
   * 加载配置
   */
  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(content);
    } catch {
      // 配置文件不存在，使用默认配置
      await this.saveConfig();
    }
  }

  /**
   * 保存配置
   */
  private async saveConfig(): Promise<void> {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      console.error('[SkillManager] Failed to save config:', error);
    }
  }

  /**
   * 加载已安装的 skills（从所有搜索目录）
   * 同名 skill 取修改时间最新的版本
   */
  private async loadSkills(): Promise<void> {
    this.installedSkills.clear();
    this.skillDirMap.clear();

    // 临时收集所有候选 skill，按名称分组
    const candidates = new Map<string, { dir: string; mtime: number; skill: InstalledSkill }>();

    for (const skillsDir of this.skillsDirs) {
      console.debug('[SkillManager] Loading skills from:', skillsDir);

      try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        console.debug('[SkillManager] Found', entries.length, 'entries in', skillsDir);

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          // Recognize .disabled-<name> directories (hidden by refreshSkillDirectories)
          const isHidden = entry.name.startsWith('.disabled-');
          const skillId = isHidden ? entry.name.slice('.disabled-'.length) : entry.name;

          const skillDir = path.join(skillsDir, entry.name);
          try {
            const stat = await fs.stat(skillDir);
            const mtime = stat.mtimeMs;

            const skill = await this.loadSkillFromDir(skillDir, skillId);
            if (!skill) {
              console.debug('[SkillManager] Failed to parse skill:', skillId);
              continue;
            }

            const existing = candidates.get(skillId);
            if (!existing || mtime > existing.mtime) {
              candidates.set(skillId, { dir: skillsDir, mtime, skill });
              console.debug(
                '[SkillManager] Candidate skill:',
                skillId,
                'from',
                skillsDir,
                'mtime:',
                new Date(mtime).toISOString(),
                existing ? '(replacing older version)' : '',
              );
            } else {
              console.debug(
                '[SkillManager] Skipping older duplicate skill:',
                skillId,
                'from',
                skillsDir,
                'mtime:',
                new Date(mtime).toISOString(),
              );
            }
          } catch (error) {
            console.error(`[SkillManager] Failed to load skill ${skillId}:`, error);
          }
        }
      } catch (error) {
        console.error('[SkillManager] Failed to load skills from', skillsDir, ':', error);
      }
    }

    // 将最终候选写入缓存
    this.disabledSkillIds.clear();
    for (const [skillId, candidate] of candidates) {
      // 修复 .disabled- 目录状态与 META.json 不一致的情况
      if (candidate.skill.enabled) {
        for (const skillsDir of this.skillsDirs) {
          const staleDir = path.join(skillsDir, `.disabled-${skillId}`);
          const normalDir = path.join(skillsDir, skillId);
          if (existsSync(staleDir)) {
            if (!existsSync(normalDir)) {
              // 只有 .disabled- 目录且技能已启用 → 恢复目录名
              fs.rename(staleDir, normalDir).catch(() => {});
            } else {
              // 同时存在 .disabled- 和正常目录 → 删除残留
              fs.rm(staleDir, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      }
      this.installedSkills.set(skillId, candidate.skill);
      this.skillDirMap.set(skillId, candidate.dir);
      if (!candidate.skill.enabled) {
        this.disabledSkillIds.add(skillId);
      }
      console.debug('[SkillManager] Loaded skill:', skillId, 'from', candidate.dir);
    }
  }

  /**
   * 从目录加载 skill（优先 SKILL.md，回退 SKILL.yaml）
   * SKILL.md 是 Claude Code 原生格式（YAML frontmatter + markdown body）
   * SKILL.yaml 是 AICO-Bot 自有格式
   */
  private async loadSkillFromDir(
    skillDir: string,
    skillId: string,
  ): Promise<InstalledSkill | null> {
    const mdFile = path.join(skillDir, 'SKILL.md');
    const yamlFile = path.join(skillDir, 'SKILL.yaml');

    // 读取 META.json
    const metaFile = path.join(skillDir, 'META.json');
    let meta: Partial<InstalledSkill> = {};
    try {
      const metaContent = await fs.readFile(metaFile, 'utf-8');
      meta = JSON.parse(metaContent);
    } catch {
      // meta 文件不存在，使用默认值
    }

    // 优先尝试 SKILL.md (Claude Code 原生格式)
    try {
      const mdContent = await fs.readFile(mdFile, 'utf-8');
      const spec = this.parseSkillMd(mdContent, skillId);
      if (spec) {
        return {
          appId: skillId,
          spec,
          enabled: meta.enabled ?? true,
          installedAt: meta.installedAt ?? new Date().toISOString(),
        };
      }
    } catch {
      // SKILL.md 不存在，尝试 SKILL.yaml
    }

    // 回退到 SKILL.yaml (AICO-Bot 格式)
    try {
      const yamlContent = await fs.readFile(yamlFile, 'utf-8');
      const spec = parseYaml(yamlContent) as SkillSpec;
      return {
        appId: skillId,
        spec,
        enabled: meta.enabled ?? true,
        installedAt: meta.installedAt ?? new Date().toISOString(),
      };
    } catch {
      // SKILL.yaml 也不存在
    }

    return null;
  }

  /**
   * 解析 SKILL.md 格式（Claude Code 原生格式）
   * 格式：YAML frontmatter + markdown body
   */
  private parseSkillMd(content: string, skillId: string): SkillSpec | null {
    // 解析 YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
      // 没有 frontmatter，使用默认值
      return {
        name: skillId,
        type: 'skill',
        description: `Skill: ${skillId}`,
        system_prompt: content,
        version: '1.0',
        author: 'Unknown',
        trigger_command: `/${skillId}`,
      };
    }

    try {
      const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>;
      const body = content.slice(frontmatterMatch[0].length).trim();

      return {
        name: (frontmatter.name as string) || skillId,
        type: 'skill',
        description: (frontmatter.description as string) || '',
        system_prompt: body || content,
        version: (frontmatter.version as string) || '1.0',
        author: (frontmatter.author as string) || 'Unknown',
        trigger_command: (frontmatter.trigger_command as string) || `/${skillId}`,
        tags: frontmatter.tags as string[] | undefined,
      };
    } catch {
      // YAML frontmatter 存在但解析失败，回退到默认值（与无 frontmatter 相同）
      return {
        name: skillId,
        type: 'skill',
        description: `Skill: ${skillId}`,
        system_prompt: content,
        version: '1.0',
        author: 'Unknown',
        trigger_command: `/${skillId}`,
      };
    }
  }

  /**
   * 获取所有已安装的 skills
   */
  getInstalledSkills(): InstalledSkill[] {
    // 返回所有技能（包括禁用的），让前端显示状态
    return Array.from(this.installedSkills.values());
  }

  /**
   * 获取技能目录下的文件结构
   */
  async getSkillFiles(skillId: string): Promise<SkillFileNode[]> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const skillDir = path.join(baseDir, skillId);

    try {
      return await this.buildFileTree(skillDir, '');
    } catch (error) {
      console.error('[SkillManager] Failed to get skill files:', error);
      return [];
    }
  }

  /**
   * 递归构建文件树
   */
  private async buildFileTree(dirPath: string, relativePath: string): Promise<SkillFileNode[]> {
    const nodes: SkillFileNode[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // 递归获取子目录内容
          const children = await this.buildFileTree(entryPath, entryRelativePath);
          nodes.push({
            name: entry.name,
            type: 'directory',
            path: entryRelativePath,
            children,
          });
        } else {
          // 获取文件信息
          const stats = await fs.stat(entryPath);
          nodes.push({
            name: entry.name,
            type: 'file',
            path: entryRelativePath,
            size: stats.size,
            extension: path.extname(entry.name).toLowerCase(),
          });
        }
      }

      // 排序：目录在前，然后按名称排序
      return nodes.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return [];
    }
  }

  /**
   * 读取技能文件内容
   */
  async getSkillFileContent(skillId: string, filePath: string): Promise<string | null> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const fullPath = path.join(baseDir, skillId, filePath);

    try {
      // 安全检查：确保路径在技能目录内
      const normalizedPath = path.normalize(fullPath);
      const skillDir = path.join(baseDir, skillId) + path.sep;
      if (!normalizedPath.startsWith(skillDir)) {
        console.error('[SkillManager] Invalid file path:', filePath);
        return null;
      }

      const content = await fs.readFile(normalizedPath, 'utf-8');
      return content;
    } catch (error) {
      console.error('[SkillManager] Failed to read file:', filePath, error);
      return null;
    }
  }

  /**
   * 保存技能文件内容
   */
  async saveSkillFileContent(skillId: string, filePath: string, content: string): Promise<boolean> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const fullPath = path.join(baseDir, skillId, filePath);

    try {
      // 安全检查：确保路径在技能目录内
      const normalizedPath = path.normalize(fullPath);
      const skillDir = path.join(baseDir, skillId) + path.sep;
      if (!normalizedPath.startsWith(skillDir)) {
        console.error('[SkillManager] Invalid file path:', filePath);
        return false;
      }

      // 确保目录存在
      const dir = path.dirname(normalizedPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(normalizedPath, content, 'utf-8');
      return true;
    } catch (error) {
      console.error('[SkillManager] Failed to save file:', filePath, error);
      return false;
    }
  }

  /**
   * 安装 skill（安装到主目录 ~/.agents/skills/）
   */
  async installSkill(
    spec: SkillSpec,
    skillData: {
      systemPrompt: string;
      triggerCommand?: string;
    },
  ): Promise<string> {
    const skillId = spec.name.toLowerCase().replace(/\s+/g, '-');
    const primaryDir = this.skillsDirs[0];
    const skillDir = path.join(primaryDir, skillId);

    // 创建技能目录
    await fs.mkdir(skillDir, { recursive: true });

    // 构建完整的 skill spec
    const fullSpec: SkillSpec = {
      ...spec,
      type: 'skill',
      system_prompt: skillData.systemPrompt,
      trigger_command: skillData.triggerCommand || `/${skillId}`,
      version: spec.version || '1.0',
      author: spec.author || 'User',
    };

    // 写入 SKILL.yaml
    const yamlContent = stringifyYaml(fullSpec);
    await fs.writeFile(path.join(skillDir, 'SKILL.yaml'), yamlContent, 'utf-8');

    // 写入 META.json
    const meta: InstalledSkill = {
      appId: skillId,
      spec: fullSpec,
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(skillDir, 'META.json'), JSON.stringify(meta, null, 2), 'utf-8');

    // 更新缓存
    this.installedSkills.set(skillId, meta);
    this.skillDirMap.set(skillId, primaryDir);
    console.log('[SkillManager] Installed skill:', skillId);

    return skillId;
  }

  /**
   * 卸载 skill
   */
  async uninstallSkill(skillId: string): Promise<boolean> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const skillDir = path.join(baseDir, skillId);

    try {
      // 删除技能目录
      await fs.rm(skillDir, { recursive: true, force: true });

      // 从缓存中移除
      this.installedSkills.delete(skillId);
      this.skillDirMap.delete(skillId);
      console.log('[SkillManager] Uninstalled skill:', skillId);
      return true;
    } catch (error) {
      console.error('[SkillManager] Failed to uninstall skill:', error);
      return false;
    }
  }

  /**
   * 启用/禁用 skill
   */
  async toggleSkill(skillId: string, enabled: boolean): Promise<boolean> {
    const skill = this.installedSkills.get(skillId);
    if (!skill) {
      return false;
    }

    skill.enabled = enabled;
    this.installedSkills.set(skillId, skill);

    if (enabled) {
      this.disabledSkillIds.delete(skillId);
    } else {
      this.disabledSkillIds.add(skillId);
    }

    // 更新 META.json
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    let skillDir = path.join(baseDir, skillId);
    // Directory may have been renamed to .disabled-<name> by hideDisabledSkillsInSource
    if (!existsSync(skillDir)) {
      const hiddenDir = path.join(baseDir, `.disabled-${skillId}`);
      if (existsSync(hiddenDir)) {
        skillDir = hiddenDir;
      }
    }
    const metaFile = path.join(skillDir, 'META.json');
    await fs.writeFile(metaFile, JSON.stringify(skill, null, 2), 'utf-8');

    console.log(`[SkillManager] Toggled skill ${skillId} enabled:`, enabled);
    return true;
  }

  /**
   * 获取 skill 详情
   */
  getSkill(skillId: string): InstalledSkill | undefined {
    return this.installedSkills.get(skillId);
  }

  /**
   * 获取 skill 所在的基础目录
   */
  getSkillBaseDir(skillId: string): string {
    return this.skillDirMap.get(skillId) || this.skillsDirs[0];
  }

  /**
   * 获取所有 skills 搜索目录
   */
  getSkillsDirs(): string[] {
    return [...this.skillsDirs];
  }

  /**
   * 导出 skill 为 YAML
   */
  async exportSkill(skillId: string): Promise<string | null> {
    const skill = this.getSkill(skillId);
    if (!skill) {
      return null;
    }

    return stringifyYaml(skill.spec);
  }

  /**
   * 从 YAML 导入 skill
   */
  async importSkill(yamlContent: string): Promise<string> {
    const spec = parseYaml(yamlContent) as SkillSpec;

    // 验证 spec
    if (!spec.name || !spec.system_prompt) {
      throw new Error('Invalid skill spec: missing name or system_prompt');
    }

    // 安装 skill
    return this.installSkill(spec, {
      systemPrompt: spec.system_prompt,
      triggerCommand: spec.trigger_command,
    });
  }

  /**
   * 更新配置
   */
  async updateConfig(config: Partial<SkillLibraryConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    await this.saveConfig();
  }

  /**
   * 获取配置
   */
  getConfig(): SkillLibraryConfig {
    return this.config;
  }

  /**
   * 刷新技能列表
   */
  async refresh(): Promise<void> {
    await this.loadSkills();
    console.log('[SkillManager] Refreshed skills');
  }

  /**
   * 从目录批量导入技能（核心方法）
   * 递归扫描所有子目录，找到含 SKILL.md 或 SKILL.yaml 的目录视为一个技能
   */
  async installFromDirectory(
    dirPath: string,
    onProgress?: (message: string) => void,
  ): Promise<ImportSkillsResult> {
    const result: ImportSkillsResult = { installed: [], skipped: [], errors: [] };

    console.log('[SkillManager:installFromDirectory] dirPath:', dirPath);
    const targetDir = this.skillsDirs[0];
    console.log('[SkillManager:installFromDirectory] targetDir:', targetDir);

    // 递归查找所有含 SKILL.md 或 SKILL.yaml 的目录
    const skillDirs = await this.findSkillDirs(dirPath);
    console.log('[SkillManager:installFromDirectory] found skill dirs:', skillDirs.map(d => d.skillName));

    if (skillDirs.length === 0) {
      result.errors.push('No directories containing SKILL.md or SKILL.yaml found');
      return result;
    }

    for (const { skillName, srcPath } of skillDirs) {
      const destPath = path.join(targetDir, skillName);
      const tmpDest = path.join(targetDir, `.installing-${skillName}`);

      try {
        // 先复制到临时目录，成功后再替换旧技能（避免复制失败丢技能）
        await this.copyDirRecursive(srcPath, tmpDest);

        if (existsSync(destPath)) {
          await fs.rm(destPath, { recursive: true, force: true });
        }
        await fs.rename(tmpDest, destPath);

        result.installed.push(skillName);
        onProgress?.(`Installed: ${skillName}`);
      } catch (err) {
        // 清理临时目录
        await fs.rm(tmpDest, { recursive: true, force: true }).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${skillName}: ${msg}`);
        onProgress?.(`Failed: ${skillName} - ${msg}`);
      }
    }

    await this.refresh();

    onProgress?.(
      `Done. Installed: ${result.installed.length}, Skipped: ${result.skipped.length}, Errors: ${result.errors.length}`,
    );

    return result;
  }

  /**
   * 递归查找所有含 SKILL.md 或 SKILL.yaml 的目录
   */
  private async findSkillDirs(
    dirPath: string,
    maxDepth: number = 3,
  ): Promise<Array<{ skillName: string; srcPath: string }>> {
    const found: Array<{ skillName: string; srcPath: string }> = [];

    async function scan(currentDir: string, depth: number) {
      if (depth > maxDepth) return;
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      const subDirs = entries.filter((e) => e.isDirectory());

      for (const dir of subDirs) {
        const fullPath = path.join(currentDir, dir.name);
        const hasSkillMd = existsSync(path.join(fullPath, 'SKILL.md'));
        const hasSkillYaml = existsSync(path.join(fullPath, 'SKILL.yaml'));

        if (hasSkillMd || hasSkillYaml) {
          found.push({ skillName: dir.name, srcPath: fullPath });
        } else {
          // 不是技能目录，继续向下递归
          await scan(fullPath, depth + 1);
        }
      }
    }

    await scan(dirPath, 0);
    return found;
  }

  /**
   * 从 ZIP 文件导入技能
   * 使用 yauzl 直接从 ZIP 流式提取，不走 temp 目录。
   */
  async installFromZip(
    filePath: string,
    onProgress?: (message: string) => void,
  ): Promise<ImportSkillsResult> {
    console.log('[SkillManager:installFromZip] filePath:', filePath);
    const result: ImportSkillsResult = { installed: [], skipped: [], errors: [] };
    const targetDir = this.skillsDirs[0];

    onProgress?.(`Extracting ZIP: ${path.basename(filePath)}...`);

    try {
      // 第一遍：找到所有含 SKILL.md 的目录及其在 ZIP 中的前缀
      const skillFileMap = new Map<string, { prefix: string; entries: string[] }>();

      await new Promise<void>((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true }, (openErr, zip) => {
          if (openErr) { reject(openErr); return; }

          zip.on('entry', (entry) => {
            const parts = entry.fileName.split('/').filter(Boolean);
            const fileName = parts[parts.length - 1];

            if (fileName === 'SKILL.md' || fileName === 'SKILL.yaml') {
              if (parts.length >= 2) {
                const skillName = parts[parts.length - 2];
                const prefix = parts.slice(0, parts.length - 1).join('/') + '/';
                if (!skillFileMap.has(skillName)) {
                  skillFileMap.set(skillName, { prefix, entries: [] });
                }
              }
            }

            zip.readEntry();
          });

          zip.on('end', resolve);
          zip.on('error', reject);
          zip.readEntry();
        });
      });

      // 第二遍：收集每个技能目录下的所有文件
      await new Promise<void>((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true }, (openErr, zip) => {
          if (openErr) { reject(openErr); return; }

          zip.on('entry', (entry) => {
            for (const [, data] of skillFileMap) {
              if (entry.fileName.startsWith(data.prefix)) {
                data.entries.push(entry.fileName);
                break;
              }
            }
            zip.readEntry();
          });

          zip.on('end', resolve);
          zip.on('error', reject);
          zip.readEntry();
        });
      });

      const validSkills = [...skillFileMap.entries()].map(([name, data]) => ({
        name,
        prefix: data.prefix,
        entries: data.entries,
      }));

      console.log('[SkillManager:installFromZip] found skills:', validSkills.map(s => `${s.name}(${s.entries.length} files)`));

      if (validSkills.length === 0) {
        result.errors.push('No directories containing SKILL.md found in ZIP');
        return result;
      }

      // 逐个提取技能
      for (const { name: skillName, prefix, entries: skillEntries } of validSkills) {
        const destPath = path.join(targetDir, skillName);
        const tmpDest = path.join(targetDir, `.installing-${skillName}`);

        try {
          await fs.rm(tmpDest, { recursive: true, force: true }).catch(() => {});
          mkdirSync(tmpDest, { recursive: true });

          const entrySet = new Set(skillEntries);

          // 重新打开 ZIP 提取该技能的文件
          await new Promise<void>((resolve, reject) => {
            yauzl.open(filePath, { lazyEntries: true }, (openErr, zip) => {
              if (openErr) { reject(openErr); return; }
              let pending = skillEntries.length;
              if (pending === 0) { resolve(); return; }
              const done = () => { if (--pending === 0) resolve(); };

              zip.on('entry', (entry) => {
                if (!entrySet.has(entry.fileName)) {
                  zip.readEntry();
                  return;
                }

                const relativePath = entry.fileName.slice(prefix.length);
                const destFilePath = path.join(tmpDest, relativePath);

                if (/\/$/.test(entry.fileName)) {
                  mkdirSync(destFilePath, { recursive: true });
                  done();
                  zip.readEntry();
                  return;
                }

                mkdirSync(path.dirname(destFilePath), { recursive: true });

                zip.openReadStream(entry, (streamErr, readStream) => {
                  if (streamErr) {
                    console.error(`[SkillManager] readStream error: ${entry.fileName}`, streamErr);
                    done();
                    zip.readEntry();
                    return;
                  }
                  const writeStream = createWriteStream(destFilePath);
                  readStream.pipe(writeStream);
                  readStream.on('end', () => {
                    writeStream.close();
                    done();
                    zip.readEntry();
                  });
                  readStream.on('error', (e) => {
                    console.error(`[SkillManager] read error: ${entry.fileName}`, e);
                    writeStream.close();
                    done();
                    zip.readEntry();
                  });
                });
              });

              zip.on('end', resolve);
              zip.on('error', reject);
              zip.readEntry();
            });
          });

          if (existsSync(destPath)) {
            await fs.rm(destPath, { recursive: true, force: true });
          }
          await fs.rename(tmpDest, destPath);

          result.installed.push(skillName);
          onProgress?.(`Installed: ${skillName}`);
        } catch (err) {
          await fs.rm(tmpDest, { recursive: true, force: true }).catch(() => {});
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${skillName}: ${msg}`);
          onProgress?.(`Failed: ${skillName} - ${msg}`);
        }
      }

      await this.refresh();
      onProgress?.(
        `Done. Installed: ${result.installed.length}, Skipped: ${result.skipped.length}, Errors: ${result.errors.length}`,
      );

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SkillManager:installFromZip] failed:', msg, err);
      return { installed: [], skipped: [], errors: [`ZIP processing failed: ${msg}`] };
    }
  }

  /**
   * 递归复制目录（处理 symlink）
   * extract-zip 在 Windows 上会创建 symlink，fs.copyFile 无法处理，
   * 所以用 fs.cpSync 并解析 symlink 到实际文件。
   */
  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    fsSync.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: false });
  }
}
