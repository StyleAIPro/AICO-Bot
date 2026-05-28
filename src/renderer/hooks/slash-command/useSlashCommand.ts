/**
 * useSlashCommand - Slash command interaction hook
 *
 * Follows the same design pattern as useMentionSystem:
 * - Detect line-start / prefix
 * - Show filtered command popup (registered commands only)
 * - Keyboard navigation (ArrowUp/Down, Tab complete, Enter execute, Esc close)
 * - Text replacement and cursor positioning
 *
 * Behavior:
 * - Registered commands (/skill list, etc.) → intercepted, executed locally
 * - Non-registered / prefixed text (e.g. /doc-summary) → NOT intercepted, sent to AI as normal message
 */

import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from '../../i18n';
import i18next from 'i18next';
import { slashCommandRegistry } from './slash-command-registry';
import { executeSlashCommand } from './slash-command-executor';
import type { SlashCommandMenuItem, SlashCommandMatch, SlashCommandExecutionResult } from './types';
import { useSkillStore } from '../../stores/skill/skill.store';

interface UseSlashCommandOptions {
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onExecuteCommand?: (result: SlashCommandExecutionResult) => void;
  claudeSource?: 'local' | 'remote';
  remoteServerId?: string;
}

interface UseSlashCommandResult {
  showCommandMenu: boolean;
  commandMenuRef: React.RefObject<HTMLDivElement | null>;
  matchedCommands: SlashCommandMenuItem[];
  selectedIndex: number;
  isExecuting: boolean;
  handleTextChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSlashKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  selectMenuItem: (item: SlashCommandMenuItem) => void;
}

export function useSlashCommand({
  content,
  setContent,
  textareaRef,
  onExecuteCommand,
  claudeSource,
  remoteServerId,
}: UseSlashCommandOptions): UseSlashCommandResult {
  const { t } = useTranslation();
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [matchedCommands, setMatchedCommands] = useState<SlashCommandMenuItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentMatch, setCurrentMatch] = useState<SlashCommandMatch>({ type: 'none' });

  const commandMenuRef = useRef<HTMLDivElement>(null);

  const installedSkills = useSkillStore((s) => s.installedSkills);
  const loadInstalledSkills = useSkillStore((s) => s.loadInstalledSkills);
  const remoteSkills = useSkillStore((s) => s.remoteSkills);
  const loadRemoteSkills = useSkillStore((s) => s.loadRemoteSkills);

  const isRemote = claudeSource === 'remote' && !!remoteServerId;
  const skills = isRemote ? (remoteSkills[remoteServerId!] ?? []) : installedSkills;

  useEffect(() => {
    if (isRemote && remoteServerId) {
      loadRemoteSkills(remoteServerId);
    } else {
      loadInstalledSkills();
    }
  }, [isRemote, remoteServerId, loadInstalledSkills, loadRemoteSkills]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (commandMenuRef.current && !commandMenuRef.current.contains(event.target as Node)) {
        setShowCommandMenu(false);
      }
    };

    if (showCommandMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showCommandMenu]);

  // Reset selection when matched commands change
  useEffect(() => {
    setSelectedIndex(0);
  }, [matchedCommands.length]);

  /**
   * Handle text change - detect / prefix and update menu
   */
  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPosition = e.target.selectionStart;

      const match = slashCommandRegistry.parseInput(newValue, cursorPosition);
      setCurrentMatch(match);

      if (match.type === 'none') {
        setShowCommandMenu(false);
        setMatchedCommands([]);
        return;
      }

      if (match.type === 'command') {
        const allCommands = slashCommandRegistry.getAllCommands();
        const query = match.query ?? '';
        const filtered = allCommands.filter((cmd) =>
          cmd.name.toLowerCase().includes(query.toLowerCase()),
        );
        const commandItems: SlashCommandMenuItem[] = filtered.map((cmd) => ({
          type: 'command' as const,
          label: t(cmd.labelKey),
          description: t(cmd.descriptionKey),
          icon: cmd.icon,
          command: cmd,
          insertText: `/${cmd.name} `,
        }));

        // Merge installed skills into menu
        const enabledSkills = skills.filter((s) => s.enabled);
        const filteredSkills = enabledSkills.filter((s) => {
          const name = s.spec.name.toLowerCase();
          const trigger = s.spec.trigger_command?.toLowerCase() ?? '';
          const q = query.toLowerCase();
          return name.includes(q) || trigger.includes(q);
        });
        const skillItems: SlashCommandMenuItem[] = filteredSkills.map((skill) => {
          const triggerCmd = skill.spec.trigger_command || `/${skill.spec.name}`;
          return {
            type: 'skill' as const,
            label: triggerCmd,
            description: skill.spec.description,
            icon: 'Sparkles',
            skill,
            insertText: `${triggerCmd} `,
          };
        });

        const items = [...commandItems, ...skillItems];
        setMatchedCommands(items);
        setShowCommandMenu(items.length > 0);
      } else if (match.type === 'subcommand' && match.command?.subcommands) {
        const query = match.query ?? '';
        const filtered = match.command.subcommands.filter((sc) =>
          sc.name.toLowerCase().includes(query.toLowerCase()),
        );
        const items: SlashCommandMenuItem[] = filtered.map((sc) => ({
          type: 'subcommand' as const,
          label: sc.name,
          description: t(sc.descriptionKey),
          icon: match.command!.icon,
          command: match.command!,
          subcommand: sc,
          insertText: `/${match.command!.name} ${sc.name} `,
        }));
        setMatchedCommands(items);
        setShowCommandMenu(items.length > 0);
      } else if (match.type === 'argument') {
        setShowCommandMenu(false);
        setMatchedCommands([]);
      }
    },
    [t, skills],
  );

  /**
   * Select a menu item (insert text, update cursor)
   */
  const selectMenuItem = useCallback(
    (item: SlashCommandMenuItem) => {
      if (!textareaRef.current || currentMatch.commandStart === undefined) return;

      const textarea = textareaRef.current;
      const beforeText = content.substring(0, currentMatch.commandStart);
      const afterText = content.substring(
        currentMatch.commandStart + (currentMatch.matchedText?.length ?? 0),
      );

      const newValue = beforeText + item.insertText + afterText;
      setContent(newValue);

      const newCursorPos = currentMatch.commandStart + item.insertText.length;
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);

      setShowCommandMenu(false);
    },
    [textareaRef, content, setContent, currentMatch],
  );

  /**
   * Execute the command currently in the input
   */
  const executeCurrentCommand = useCallback(async () => {
    if (isExecuting) return;

    const trimmedContent = content.trim();
    if (!trimmedContent.startsWith('/')) return;

    setIsExecuting(true);
    try {
      const result = await executeSlashCommand(trimmedContent);
      onExecuteCommand?.(result);
    } finally {
      setIsExecuting(false);
    }
  }, [content, isExecuting, onExecuteCommand]);

  /**
   * Handle keyboard events - returns true if consumed
   *
   * Rules:
   * - Registered commands (e.g. /skill list) → intercepted, executed locally
   * - Non-registered / prefixed text (e.g. /doc-summary) → NOT intercepted, sent to AI normally
   */
  const handleSlashKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (e.nativeEvent.isComposing) return false;

      if (showCommandMenu) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setSelectedIndex((prev) => (prev < matchedCommands.length - 1 ? prev + 1 : 0));
            return true;

          case 'ArrowUp':
            e.preventDefault();
            setSelectedIndex((prev) => (prev > 0 ? prev - 1 : matchedCommands.length - 1));
            return true;

          case 'Tab':
            e.preventDefault();
            if (matchedCommands.length > 0) {
              selectMenuItem(matchedCommands[selectedIndex]);
            }
            return true;

          case 'Enter': {
            if (currentMatch.type === 'argument') {
              e.preventDefault();
              executeCurrentCommand();
              return true;
            }
            if (matchedCommands.length > 0) {
              e.preventDefault();
              selectMenuItem(matchedCommands[selectedIndex]);
              return true;
            }
            break;
          }

          case 'Escape':
            e.preventDefault();
            setShowCommandMenu(false);
            setMatchedCommands([]);
            return true;
        }
      }

      // Not in menu mode - check if input is a registered slash command
      if (!showCommandMenu && e.key === 'Enter') {
        const trimmedContent = content.trim();
        if (!trimmedContent.startsWith('/')) return false;

        // Only intercept REGISTERED commands; let everything else through to the AI
        const commandName = trimmedContent.substring(1).split(/\s+/)[0];
        const registeredCommand = slashCommandRegistry.getCommand(commandName);

        if (!registeredCommand) {
          return false;
        }

        e.preventDefault();

        const match = slashCommandRegistry.parseInput(content, content.length);

        if (match.type === 'argument' && match.command && match.subcommand) {
          const args = trimmedContent.substring(1).split(/\s+/).slice(2);
          const requiredArgs = match.subcommand.arguments.filter((a) => a.required);
          const restArgs = match.subcommand.arguments.filter((a) => a.type === 'rest');
          const neededArgs = restArgs.length > 0 ? 1 : requiredArgs.length;

          // No required args (e.g. /skill list) → always execute
          // Has required args → check they're provided
          if (neededArgs === 0 || (args.length >= neededArgs && args[0])) {
            executeCurrentCommand();
            return true;
          }
          onExecuteCommand?.({
            success: false,
            message: i18next.t('Missing required argument: {{arg}}', {
              arg: match.subcommand.arguments.find((a) => a.required)?.name ?? 'arg',
            }),
          });
          return true;
        }

        // Command with no subcommands
        if (match.type === 'command' && match.command && !match.command.subcommands?.length) {
          executeCurrentCommand();
          return true;
        }

        // Command has subcommands but none specified
        executeCurrentCommand();
        return true;
      }

      return false;
    },
    [
      showCommandMenu,
      matchedCommands,
      selectedIndex,
      selectMenuItem,
      currentMatch,
      content,
      executeCurrentCommand,
      onExecuteCommand,
    ],
  );

  return {
    showCommandMenu,
    commandMenuRef,
    matchedCommands,
    selectedIndex,
    isExecuting,
    handleTextChange,
    handleSlashKeyDown,
    selectMenuItem,
  };
}
