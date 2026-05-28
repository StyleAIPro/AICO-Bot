/**
 * Slash command type definitions
 *
 * Defines the core types for the slash command framework,
 * including command registration, matching, menu items, and execution results.
 */

/**
 * Slash command argument definition
 */
export interface SlashCommandArgument {
  /** Argument name, e.g. 'skillId' */
  name: string;
  /** Argument type */
  type: 'string' | 'enum' | 'rest';
  /** Whether required */
  required: boolean;
  /** i18n key for description */
  descriptionKey: string;
  /** Enum values (when type === 'enum') */
  enumValues?: string[];
  /** i18n key for input placeholder */
  placeholderKey?: string;
}

/**
 * Slash command definition
 */
export interface SlashCommand {
  /** Command name, e.g. 'skill' (without /) */
  name: string;
  /** i18n key for command label */
  labelKey: string;
  /** i18n key for command description */
  descriptionKey: string;
  /** Lucide-react icon name */
  icon?: string;
  /** Subcommands */
  subcommands?: SlashCommandSubcommand[];
  /** Direct arguments (when no subcommands) */
  arguments?: SlashCommandArgument[];
  /** Execution type: local = frontend, ipc = via api layer */
  execution: 'local' | 'ipc';
}

/**
 * Slash command subcommand definition
 */
export interface SlashCommandSubcommand {
  /** Subcommand name, e.g. 'install' */
  name: string;
  /** i18n key for subcommand label */
  labelKey: string;
  /** i18n key for subcommand description */
  descriptionKey: string;
  /** Subcommand arguments */
  arguments: SlashCommandArgument[];
  /** Execution type */
  execution: 'local' | 'ipc';
}

/**
 * Slash command match result (returned by parseInput)
 */
export interface SlashCommandMatch {
  /** Match type */
  type: 'command' | 'subcommand' | 'argument' | 'none';
  /** Matched command */
  command?: SlashCommand;
  /** Matched subcommand */
  subcommand?: SlashCommandSubcommand;
  /** Current query text for filtering */
  query?: string;
  /** Matched text (for autocomplete replacement) */
  matchedText?: string;
  /** Command start position in text (for replacement) */
  commandStart?: number;
  /** Current argument index being filled */
  argumentIndex?: number;
}

/**
 * Menu item for SlashCommandMenu rendering
 */
export interface SlashCommandMenuItem {
  type: 'command' | 'subcommand' | 'skill';
  label: string;
  description: string;
  icon?: string;
  command?: SlashCommand;
  subcommand?: SlashCommandSubcommand;
  skill?: import('../../../shared/skill/skill-types').InstalledSkill;
  /** Text to insert/replace when selected */
  insertText: string;
}

/**
 * Command execution result
 */
export interface SlashCommandExecutionResult {
  success: boolean;
  /** Result message (displayed in chat) */
  message: string;
  /** Structured data (optional, for rich rendering) */
  data?: unknown;
  /** Error message */
  error?: string;
}
