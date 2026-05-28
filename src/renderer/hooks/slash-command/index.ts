/**
 * Slash command framework - module entry
 *
 * Re-exports all public types and functions.
 */

export type {
  SlashCommand,
  SlashCommandSubcommand,
  SlashCommandArgument,
  SlashCommandMatch,
  SlashCommandMenuItem,
  SlashCommandExecutionResult,
} from './types';
export { slashCommandRegistry } from './slash-command-registry';
export { executeSlashCommand } from './slash-command-executor';
export { useSlashCommand } from './useSlashCommand';
