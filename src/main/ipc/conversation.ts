import { wrapIpcHandle } from './ipc-logger';
/**
 * Conversation IPC Handlers
 */

import { ipcMain } from 'electron';
import {
  listConversations,
  createConversation,
  getConversation,
  updateConversation,
  deleteConversation,
  addMessage,
  updateLastMessage,
  getMessageThoughts,
  toggleStarConversation,
  loadAgentCommands,
  listChildConversations,
  listAllWorkerConversations,
} from '../services/conversation.service';

export function registerConversationHandlers(): void {
  // List conversations for a space
  wrapIpcHandle('conversation:list', async (_event, spaceId: string) => {
    try {
      const conversations = listConversations(spaceId);
      return { success: true, data: conversations };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Create a new conversation
  wrapIpcHandle('conversation:create', async (_event, spaceId: string, title?: string) => {
    try {
      const conversation = createConversation(spaceId, title);
      return { success: true, data: conversation };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Get a specific conversation
  wrapIpcHandle('conversation:get', async (_event, spaceId: string, conversationId: string) => {
    try {
      const conversation = getConversation(spaceId, conversationId);
      return { success: true, data: conversation };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Update a conversation
  wrapIpcHandle(
    'conversation:update',
    async (_event, spaceId: string, conversationId: string, updates: Record<string, unknown>) => {
      try {
        const conversation = updateConversation(spaceId, conversationId, updates);
        return { success: true, data: conversation };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Delete a conversation
  wrapIpcHandle('conversation:delete', async (_event, spaceId: string, conversationId: string) => {
    try {
      const result = deleteConversation(spaceId, conversationId);

      // Interrupt HyperSpace workers and destroy the team if this is a HyperSpace conversation
      try {
        const { agentOrchestrator } = require('../services/agent/orchestrator');
        await agentOrchestrator.interruptWorkersForConversation(conversationId);
        const team = agentOrchestrator.getTeamBySpace(spaceId);
        if (team && team.conversationId === conversationId) {
          await agentOrchestrator.destroyTeam(team.id);
        }
      } catch (_) {
        // Not a HyperSpace conversation — ignore
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // Add a message to a conversation
  wrapIpcHandle(
    'conversation:add-message',
    async (
      _event,
      spaceId: string,
      conversationId: string,
      message: { role: 'user' | 'assistant' | 'system'; content: string },
    ) => {
      try {
        const newMessage = addMessage(spaceId, conversationId, message);
        return { success: true, data: newMessage };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Update the last message (for saving content and thoughts)
  wrapIpcHandle(
    'conversation:update-last-message',
    async (_event, spaceId: string, conversationId: string, updates: Record<string, unknown>) => {
      try {
        const message = updateLastMessage(spaceId, conversationId, updates);
        return { success: true, data: message };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Get thoughts for a specific message (lazy loading)
  wrapIpcHandle(
    'conversation:get-thoughts',
    async (_event, spaceId: string, conversationId: string, messageId: string) => {
      try {
        const thoughts = getMessageThoughts(spaceId, conversationId, messageId);
        return { success: true, data: thoughts };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Toggle starred status on a conversation
  wrapIpcHandle(
    'conversation:toggle-star',
    async (_event, spaceId: string, conversationId: string, starred: boolean) => {
      try {
        const meta = toggleStarConversation(spaceId, conversationId, starred);
        if (meta) {
          return { success: true, data: meta };
        }
        return { success: false, error: 'Conversation not found' };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // Load agent commands for a conversation
  wrapIpcHandle(
    'conversation:get-agent-commands',
    async (_event, spaceId: string, conversationId: string) => {
      try {
        const commands = loadAgentCommands(spaceId, conversationId);
        return { success: true, data: commands };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // List child (worker) conversations for a parent conversation
  wrapIpcHandle(
    'conversation:list-children',
    async (_event, spaceId: string, parentConversationId: string) => {
      try {
        const children = listChildConversations(spaceId, parentConversationId);
        return { success: true, data: children };
      } catch (error: unknown) {
        const err = error as Error;
        return { success: false, error: err.message };
      }
    },
  );

  // List all worker conversations across all parent conversations in a space (HyperSpace)
  wrapIpcHandle('conversation:list-all-workers', async (_event, spaceId: string) => {
    try {
      const workerMap = listAllWorkerConversations(spaceId);
      // Convert Map to plain object for IPC serialization
      const data: Record<string, typeof workerMap extends Map<string, infer V> ? V : never> = {};
      for (const [parentConvId, workers] of workerMap) {
        data[parentConvId] = workers;
      }
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });
}
