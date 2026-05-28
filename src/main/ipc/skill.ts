import { wrapIpcHandle } from './ipc-logger';
/**
 * Skill IPC Handlers
 *
 * Exposes Skill management operations to the renderer process.
 *
 * Channels:
 *   skill:list              List installed skills
 *   skill:get-detail        Get skill detail by ID
 *   skill:install           Install a skill
 *   skill:uninstall         Uninstall a skill
 *   skill:toggle            Enable/disable a skill
 *   skill:export            Export a skill as YAML
 *   skill:generate          Generate a skill from conversation
 *   skill:market:list       List skills from market
 *   skill:market:search     Search skills in market
 *   skill:market:detail     Get market skill detail
 *   skill:config:get        Get skill library config
 *   skill:config:update     Update skill library config
 *   skill:refresh           Refresh installed skills list
 */

import { ipcMain } from 'electron';
import * as skillController from '../controllers/skill.controller';
import type { ConversationService } from '../services/conversation.service';

export function registerSkillHandlers(conversationService: ConversationService): void {
  // Initialize controller with dependencies
  skillController.initialize(conversationService);

  // ── skill:list ─────────────────────────────────────────────────────────
  wrapIpcHandle('skill:list', async () => {
    return skillController.listInstalledSkills();
  });

  // ── skill:get-detail ───────────────────────────────────────────────────
  wrapIpcHandle('skill:get-detail', async (_event, skillId: string) => {
    return skillController.getSkillDetail(skillId);
  });

  // ── skill:install ──────────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:install',
    async (
      event,
      input: {
        mode: 'market' | 'yaml';
        skillId?: string;
        yamlContent?: string;
      },
    ) => {
      if (input.mode === 'market' && input.skillId) {
        console.info(`[event] installSkill: skillId=${input.skillId}, mode=market`);
        // 流式输出回调
        const onOutput = (data: {
          type: 'stdout' | 'stderr' | 'complete' | 'error';
          content: string;
        }) => {
          event.sender.send('skill:install-output', input.skillId, data);
        };
        return skillController.installSkillFromMarket(input.skillId, onOutput);
      } else if (input.mode === 'yaml' && input.yamlContent) {
        console.info(`[event] installSkill: mode=yaml`);
        return skillController.installSkillFromYaml(input.yamlContent);
      }
      return {
        success: false,
        error: 'Invalid install parameters',
      };
    },
  );

  // ── skill:import-skills ────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:import-skills',
    async (event, input: { sourceType: 'zip' | 'folder'; filePath: string }) => {
      console.log('[IPC:skill:import-skills] received:', JSON.stringify(input));
      const onOutput = (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
        console.log('[IPC:skill:import-skills] onOutput:', data.type, data.content);
        event.sender.send('skill:install-output', 'import-skills', data);
      };
      try {
        const result = await skillController.importSkills(input.sourceType, input.filePath, onOutput);
        console.log('[IPC:skill:import-skills] controller result:', JSON.stringify(result));
        return result;
      } catch (err) {
        console.error('[IPC:skill:import-skills] error:', err);
        throw err;
      }
    },
  );

  // ── skill:uninstall ────────────────────────────────────────────────────
  wrapIpcHandle('skill:uninstall', async (_event, skillId: string) => {
    console.info(`[event] uninstallSkill: skillId=${skillId}`);
    return skillController.uninstallSkill(skillId);
  });

  // ── skill:install-multi ────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:install-multi',
    async (
      event,
      input: {
        skillId: string;
        targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>;
      },
    ) => {
      const onOutput = (
        targetKey: string,
        data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
      ) => {
        event.sender.send('skill:install-output', input.skillId, { ...data, targetKey });
      };
      return skillController.installSkillMultiTarget(input.skillId, input.targets, onOutput);
    },
  );

  // ── skill:uninstall-multi ──────────────────────────────────────────────
  wrapIpcHandle(
    'skill:uninstall-multi',
    async (
      event,
      input: {
        appId: string;
        targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>;
      },
    ) => {
      const onOutput = (
        targetKey: string,
        data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
      ) => {
        event.sender.send('skill:uninstall-output', input.appId, { ...data, targetKey });
      };
      return skillController.uninstallSkillMultiTarget(input.appId, input.targets, onOutput);
    },
  );

  // ── skill:sync-to-remote ───────────────────────────────────────────────
  wrapIpcHandle(
    'skill:sync-to-remote',
    async (event, input: { skillId: string; serverId: string }) => {
      const onOutput = (data: {
        type: 'stdout' | 'stderr' | 'complete' | 'error';
        content: string;
      }) => {
        event.sender.send('skill:sync-output', input.skillId, input.serverId, data);
      };
      return skillController.syncLocalSkillToRemote(input.skillId, input.serverId, onOutput);
    },
  );

  // ── skill:sync-from-remote ─────────────────────────────────────────────
  wrapIpcHandle(
    'skill:sync-from-remote',
    async (event, input: { skillId: string; serverId: string }) => {
      const onOutput = (data: {
        type: 'stdout' | 'stderr' | 'complete' | 'error';
        content: string;
      }) => {
        event.sender.send('skill:sync-from-remote-output', input.skillId, input.serverId, data);
      };
      return skillController.syncRemoteSkillToLocal(input.skillId, input.serverId, onOutput);
    },
  );

  // ── skill:toggle ───────────────────────────────────────────────────────
  wrapIpcHandle('skill:toggle', async (_event, input: { skillId: string; enabled: boolean }) => {
    return skillController.toggleSkill(input.skillId, input.enabled);
  });

  // ── skill:export ───────────────────────────────────────────────────────
  wrapIpcHandle('skill:export', async (_event, skillId: string) => {
    return skillController.exportSkill(skillId);
  });

  // ── skill:generate ─────────────────────────────────────────────────────
  // Note: spaceId is kept for conversation lookup, not for installation location
  wrapIpcHandle(
    'skill:generate',
    async (
      _event,
      input: {
        mode: 'conversation' | 'prompt';
        spaceId: string;
        conversationId?: string;
        name?: string;
        description?: string;
        triggerCommand?: string;
      },
    ) => {
      if (input.mode === 'conversation') {
        return skillController.generateSkillFromConversation(input.spaceId, input.conversationId);
      } else if (input.mode === 'prompt' && input.name && input.description) {
        return skillController.generateSkillFromPrompt({
          spaceId: input.spaceId,
          conversationId: input.conversationId,
          name: input.name,
          description: input.description,
          triggerCommand: input.triggerCommand || '',
        });
      }
      return {
        success: false,
        error: 'Invalid generate parameters',
      };
    },
  );

  // ── skill:market:list ──────────────────────────────────────────────────
  wrapIpcHandle('skill:market:list', async (_event, page?: number, pageSize?: number) => {
    return skillController.listMarketSkills(page, pageSize);
  });

  // ── skill:market:search ────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:market:search',
    async (_event, query: string, page?: number, pageSize?: number) => {
      return skillController.searchMarketSkills(query, page, pageSize);
    },
  );

  // ── skill:market:detail ────────────────────────────────────────────────
  wrapIpcHandle('skill:market:detail', async (_event, skillId: string) => {
    return skillController.getMarketSkillDetail(skillId);
  });

  // ── skill:market:sources ────────────────────────────────────────────────
  wrapIpcHandle('skill:market:sources', async () => {
    return skillController.getMarketSources();
  });

  // ── skill:market:add-source ─────────────────────────────────────────────
  wrapIpcHandle(
    'skill:market:add-source',
    async (
      _event,
      source: { name: string; url: string; repos?: string[]; description?: string },
    ) => {
      return skillController.addMarketSource(source);
    },
  );

  // ── skill:market:remove-source ──────────────────────────────────────────
  wrapIpcHandle('skill:market:remove-source', async (_event, sourceId: string) => {
    return skillController.removeMarketSource(sourceId);
  });

  // ── skill:market:toggle-source ──────────────────────────────────────────
  wrapIpcHandle(
    'skill:market:toggle-source',
    async (_event, input: { sourceId: string; enabled: boolean }) => {
      return skillController.toggleMarketSource(input.sourceId, input.enabled);
    },
  );

  // ── skill:market:set-active ─────────────────────────────────────────────
  wrapIpcHandle('skill:market:set-active', async (_event, sourceId: string) => {
    return skillController.setActiveMarketSource(sourceId);
  });

  // ── skill:config:get ───────────────────────────────────────────────────
  wrapIpcHandle('skill:config:get', async () => {
    return skillController.getSkillConfig();
  });

  // ── skill:config:update ────────────────────────────────────────────────
  wrapIpcHandle('skill:config:update', async (_event, config: Record<string, unknown>) => {
    return skillController.updateSkillConfig(config);
  });

  // ── skill:refresh ──────────────────────────────────────────────────────
  wrapIpcHandle('skill:refresh', async () => {
    return skillController.refreshSkills();
  });

  // ── skill:files ────────────────────────────────────────────────────────
  wrapIpcHandle('skill:files', async (_event, skillId: string) => {
    return skillController.getSkillFiles(skillId);
  });

  // ── skill:file-content ─────────────────────────────────────────────────
  wrapIpcHandle('skill:file-content', async (_event, skillId: string, filePath: string) => {
    return skillController.getSkillFileContent(skillId, filePath);
  });

  // ── skill:file-save ────────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:file-save',
    async (_event, skillId: string, filePath: string, content: string) => {
      return skillController.saveSkillFileContent(skillId, filePath, content);
    },
  );

  // ── skill:analyze-conversations ───────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:analyze-conversations',
    async (_event, spaceId: string, conversationIds: string[]) => {
      return skillController.analyzeConversations(spaceId, conversationIds);
    },
  );

  // ── skill:create-temp-session ───────────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:create-temp-session',
    async (
      event,
      options: {
        skillName: string;
        context: any;
      },
    ) => {
      // Set up streaming callback for initial message response
      // Use skill:temp-message-chunk event (same as send-temp-message) for consistency
      const onChunk = (sessionId: string, chunk: any) => {
        event.sender.send('skill:temp-message-chunk', sessionId, chunk);
      };
      return skillController.createTempAgentSession({
        ...options,
        onChunk,
      });
    },
  );

  // ── skill:send-temp-message ───────────────────────────────────────────────────────
  wrapIpcHandle('skill:send-temp-message', async (event, sessionId: string, message: string) => {
    // Set up streaming callback
    const onChunk = (chunk: string) => {
      event.sender.send('skill:temp-message-chunk', sessionId, chunk);
    };
    return skillController.sendTempAgentMessage(sessionId, message, onChunk);
  });

  // ── skill:close-temp-session ────────────────────────────────────────────────────────
  wrapIpcHandle('skill:close-temp-session', async (_event, sessionId: string) => {
    return skillController.closeTempAgentSession(sessionId);
  });

  // ============================================
  // Skill Conversation (持久化会话)
  // ============================================

  // ── skill:conversation:list ────────────────────────────────────────────────────────
  wrapIpcHandle('skill:conversation:list', async (_event, relatedSkillId?: string) => {
    return skillController.listSkillConversations(relatedSkillId);
  });

  // ── skill:conversation:get ──────────────────────────────────────────────────────────
  wrapIpcHandle('skill:conversation:get', async (_event, conversationId: string) => {
    return skillController.getSkillConversation(conversationId);
  });

  // ── skill:conversation:create ───────────────────────────────────────────────────────
  wrapIpcHandle(
    'skill:conversation:create',
    async (_event, title?: string, relatedSkillId?: string) => {
      return skillController.createSkillConversation(title, relatedSkillId);
    },
  );

  // ── skill:conversation:delete ───────────────────────────────────────────────────────
  wrapIpcHandle('skill:conversation:delete', async (_event, conversationId: string) => {
    return skillController.deleteSkillConversation(conversationId);
  });

  // ── skill:conversation:send ─────────────────────────────────────────────────────────
  // 注意：现在使用标准的 agent:* IPC 事件发送流式数据（与主对话框相同）
  wrapIpcHandle(
    'skill:conversation:send',
    async (
      _event,
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
    ) => {
      return skillController.sendSkillConversationMessage(conversationId, message, metadata);
    },
  );

  // ── skill:conversation:stop ─────────────────────────────────────────────────────────
  wrapIpcHandle('skill:conversation:stop', async (_event, conversationId: string) => {
    return skillController.stopSkillGeneration(conversationId);
  });

  // ── skill:conversation:close ────────────────────────────────────────────────────────
  wrapIpcHandle('skill:conversation:close', async (_event, conversationId: string) => {
    return skillController.closeSkillConversation(conversationId);
  });

  // ── skill:fetch-webpage ────────────────────────────────────────────────────────────
  // 获取网页内容（用于从网页创建技能）
  wrapIpcHandle('skill:fetch-webpage', async (_event, url: string) => {
    return skillController.fetchWebPageContent(url);
  });

  // ── skill:market:push-to-github ────────────────────────────────────────────────
  // 推送本地技能到 GitHub 仓库（通过 PR）
  wrapIpcHandle(
    'skill:market:push-to-github',
    async (_event, skillId: string, targetRepo: string, targetPath?: string) => {
      return skillController.pushSkillToGitHub(skillId, targetRepo, targetPath);
    },
  );

  // ── skill:market:list-repo-dirs ────────────────────────────────────────────────
  // 列出 GitHub 仓库 skills/ 目录下的子目录
  wrapIpcHandle('skill:market:list-repo-dirs', async (_event, repo: string) => {
    return skillController.listRepoDirectories(repo);
  });

  // ── skill:market:validate-repo ─────────────────────────────────────────────────
  // 验证 GitHub 仓库是否可用作技能源
  wrapIpcHandle('skill:market:validate-repo', async (_event, repo: string) => {
    return skillController.validateGitHubRepo(repo);
  });

  // ── GitCode skill operations ────────────────────────────────────────────────

  wrapIpcHandle(
    'skill:market:push-to-gitcode',
    async (_event, skillId: string, targetRepo: string, targetPath?: string) => {
      return skillController.pushSkillToGitCode(skillId, targetRepo, targetPath);
    },
  );

  wrapIpcHandle('skill:market:list-gitcode-repo-dirs', async (_event, repo: string) => {
    return skillController.listGitCodeRepoDirectories(repo);
  });

  wrapIpcHandle('skill:market:validate-gitcode-repo', async (_event, repo: string) => {
    return skillController.validateGitCodeRepo(repo);
  });

  wrapIpcHandle('skill:market:set-gitcode-token', async (_event, token: string) => {
    return skillController.setGitCodeToken(token);
  });

  // ── skill:market:pat-status ──────────────────────────────────────
  wrapIpcHandle('skill:market:pat-status', async () => {
    try {
      const { getGitHubToken } = await import('../services/auth/github-auth.service');
      const { getGitCodeToken } = await import('../services/config.service');
      return {
        success: true,
        data: {
          github: !!getGitHubToken(),
          gitcode: !!getGitCodeToken(),
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ── skill:network:proxy-status ──────────────────────────────────
  wrapIpcHandle('skill:network:proxy-status', async () => {
    try {
      const { getConfig } = await import('../services/config.service');
      const config = getConfig();
      const network = config.network || {};
      return {
        success: true,
        data: {
          enabled: !!network.enabled,
          proxyUrl: network.proxyUrl || '',
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  console.log('[SkillIPC] Skill handlers registered');
}
