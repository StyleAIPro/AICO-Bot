/**
 * apps/spec Zod Schemas
 *
 * Single source of truth for all App Spec type definitions.
 * TypeScript types are derived via z.infer<> -- never hand-written separately.
 *
 * Design principles:
 * - Zod schemas define both structure AND validation rules
 * - Shared types (src/shared/apps/spec-types.ts) re-export z.infer<> types
 * - Optional fields use .optional() consistently, never .nullable()
 * - Discriminated unions for source-type-specific configs
 */

import { z } from 'zod';

// ============================================
// Primitives and Reusable Schemas
// ============================================

/**
 * Non-empty trimmed string -- used for required name/description fields.
 */
const nonEmptyString = z.string().trim().min(1, 'Must not be empty');

/**
 * Semver-like version string. Loose validation -- "1.0", "1.0.0", "0.1-beta" all ok.
 */
const versionString = z.string().trim().min(1, 'Version must not be empty');

/**
 * Duration string: "30m", "2h", "1d", "10s", etc.
 */
const durationString = z
  .string()
  .regex(/^\d+[smhd]$/, 'Duration must be a number followed by s/m/h/d (e.g. "30m", "2h", "1d")');

/**
 * Cron expression string. Basic validation only -- full cron parsing is left to
 * the scheduler module.
 */
const cronString = z.string().trim().min(5, 'Cron expression too short');

// ============================================
// App Type
// ============================================

export const AppTypeSchema = z.enum(['mcp', 'skill', 'automation', 'extension']);

// ============================================
// Filter Rules
// ============================================

export const FilterOpSchema = z.enum([
  'eq',
  'neq',
  'contains',
  'matches',
  'gt',
  'lt',
  'gte',
  'lte',
]);

export const FilterRuleSchema = z.object({
  /** Payload field path, e.g. "price_change_percent" or "payload.extension" */
  field: nonEmptyString,
  /** Comparison operator */
  op: FilterOpSchema,
  /** Value to compare against */
  value: z.unknown(),
});

// ============================================
// Input Definition (config_schema items)
// ============================================

export const InputTypeSchema = z.enum([
  'url',
  'text',
  'string',
  'number',
  'select',
  'boolean',
  'email',
]);

export const SelectOptionSchema = z.object({
  label: nonEmptyString,
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const InputDefSchema = z
  .object({
    /** Unique key for this config field */
    key: nonEmptyString,
    /** Display label for the UI */
    label: nonEmptyString,
    /** Field type -- determines UI widget */
    type: InputTypeSchema,
    /** Description / help text */
    description: z.string().optional(),
    /** Whether the field is required (default: false) */
    required: z.boolean().optional(),
    /** Default value */
    default: z.unknown().optional(),
    /** Placeholder text */
    placeholder: z.string().optional(),
    /** Options for select type */
    options: z.array(SelectOptionSchema).optional(),
  })
  .refine(
    (data) => {
      // select type must have options
      if (data.type === 'select' && (!data.options || data.options.length === 0)) {
        return false;
      }
      return true;
    },
    { message: 'Select type requires at least one option', path: ['options'] },
  );

// ============================================
// Memory Schema
// ============================================

export const MemoryFieldSchema = z.object({
  type: nonEmptyString,
  description: z.string().optional(),
});

export const MemorySchemaSchema = z.record(z.string(), MemoryFieldSchema);

// ============================================
// Subscription Source Configs (discriminated by source type)
// ============================================

export const ScheduleSourceConfigSchema = z
  .object({
    /** Interval duration, e.g. "30m", "2h" */
    every: durationString.optional(),
    /** Cron expression, e.g. "0 8 * * *" */
    cron: cronString.optional(),
  })
  .refine((data) => Boolean(data.every) || Boolean(data.cron), {
    message: 'Schedule source requires either "every" or "cron"',
  });

export const FileSourceConfigSchema = z.object({
  /** Glob pattern to watch, e.g. "src/**\/*.ts" */
  pattern: z.string().optional(),
  /** Directory to watch */
  path: z.string().optional(),
});

export const WebhookSourceConfigSchema = z.object({
  /** Webhook path (under /hooks/), e.g. "github" */
  path: z.string().optional(),
  /** Secret for HMAC verification */
  secret: z.string().optional(),
});

export const WebpageSourceConfigSchema = z.object({
  /** What to watch on the page: "price-element", "full-page", CSS selector, etc. */
  watch: z.string().optional(),
  /** CSS selector to focus on */
  selector: z.string().optional(),
  /** URL to watch (may be overridden by config_key reference) */
  url: z.string().optional(),
});

export const RssSourceConfigSchema = z.object({
  /** RSS feed URL */
  url: z.string().optional(),
});

export const CustomSourceConfigSchema = z.record(z.string(), z.unknown());

// ============================================
// Subscription Definition
// ============================================

export const SubscriptionSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('schedule'),
    config: ScheduleSourceConfigSchema,
  }),
  z.object({
    type: z.literal('file'),
    config: FileSourceConfigSchema,
  }),
  z.object({
    type: z.literal('webhook'),
    config: WebhookSourceConfigSchema,
  }),
  z.object({
    type: z.literal('webpage'),
    config: WebpageSourceConfigSchema,
  }),
  z.object({
    type: z.literal('rss'),
    config: RssSourceConfigSchema,
  }),
  z.object({
    type: z.literal('custom'),
    config: CustomSourceConfigSchema,
  }),
]);

export const FrequencyDefSchema = z.object({
  /** Default check interval */
  default: durationString,
  /** Minimum interval (user cannot go faster) */
  min: durationString.optional(),
  /** Maximum interval (user cannot go slower) */
  max: durationString.optional(),
});

export const SubscriptionDefSchema = z.object({
  /** Unique ID within this spec (auto-generated if omitted) */
  id: z.string().optional(),
  /** Event source definition */
  source: SubscriptionSourceSchema,
  /** Frequency bounds (overrides schedule source's own interval for UI adjustment) */
  frequency: FrequencyDefSchema.optional(),
  /** Reference to a config_schema key whose value provides dynamic source input */
  config_key: z.string().optional(),
});

// ============================================
// MCP Dependency Declaration
// ============================================

export const McpDependencySchema = z.object({
  /** MCP server identifier */
  id: nonEmptyString,
  /** Human-readable reason for this dependency (shown during install) */
  reason: z.string().optional(),
  /** Whether this MCP is bundled within the app package */
  bundled: z.boolean().optional(),
});

// ============================================
// MCP Server Config (for type=mcp apps)
// ============================================

export const McpServerConfigSchema = z.object({
  /** Command to start the MCP server */
  command: nonEmptyString,
  /** Command arguments */
  args: z.array(z.string()).optional(),
  /** Environment variables */
  env: z.record(z.string(), z.string()).optional(),
  /** Working directory */
  cwd: z.string().optional(),
});

// ============================================
// Output Config
// ============================================

export const OutputNotifySchema = z.object({
  /** Send system desktop notification (default: true) */
  system: z.boolean().optional(),
});

export const OutputConfigSchema = z.object({
  /** Notification configuration for completed runs */
  notify: OutputNotifySchema.optional(),
  /** Output format template string */
  format: z.string().optional(),
});

// ============================================
// Skill Dependency Declaration
// ============================================

export const SkillDependencySchema = z.union([
  z.string(), // backward-compatible: just a skill name
  z.object({
    id: nonEmptyString,
    reason: z.string().optional(),
    bundled: z.boolean().optional(),
  }),
]);

// ============================================
// Requires Block
// ============================================

export const RequiresSchema = z.object({
  /** MCP server dependencies */
  mcps: z.array(McpDependencySchema).optional(),
  /** Skill dependencies (by name/id or structured declaration) */
  skills: z.array(SkillDependencySchema).optional(),
});

// ============================================
// Escalation Config
// ============================================

export const EscalationConfigSchema = z.object({
  /** Whether AI is allowed to escalate to user (default: true for automation) */
  enabled: z.boolean().optional(),
  /** Timeout in hours before an unanswered escalation auto-fails (default: 24) */
  timeout_hours: z.number().positive().optional(),
});

// ============================================
// Store Metadata (for registry distribution)
// ============================================

export const StoreMetadataSchema = z
  .object({
    /** URL-safe unique identifier (single-file: filename, bundle: directory name) */
    slug: z
      .string()
      .regex(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        'Slug must be lowercase alphanumeric with optional internal hyphens',
      )
      .optional(),
    /** Primary category for store navigation */
    category: z.string().optional(),
    /** Free-form tags for discovery */
    tags: z.array(z.string()).default([]),
    /** Primary locale (BCP 47) */
    locale: z.string().optional(),
    /** Minimum client version required */
    min_app_version: z.string().optional(),
    /** License identifier (SPDX) */
    license: z.string().optional(),
    /** Project homepage URL */
    homepage: z.string().url().optional(),
    /** Source repository URL */
    repository: z.string().url().optional(),
    /** Install provenance: which registry this app was installed from */
    registry_id: z.string().optional(),
  })
  .optional();

// ============================================
// Full App Spec Schema
// ============================================

/**
 * Base schema with all fields that are common across all app types.
 * Type-specific refinements are applied after base parsing.
 */
export const AppSpecBaseSchema = z.object({
  /** Spec format version (default "1", for forward compatibility) */
  spec_version: z.string().default('1'),

  /** App display name */
  name: nonEmptyString,

  /** App version */
  version: versionString,

  /** App author */
  author: nonEmptyString,

  /** App description */
  description: nonEmptyString,

  /** App type -- determines runtime behavior */
  type: AppTypeSchema,

  /** Icon identifier or URL */
  icon: z.string().optional(),

  /**
   * Core system prompt -- the "soul" of the app.
   * Required for skill and automation types.
   */
  system_prompt: z.string().optional(),

  /** Dependency declarations */
  requires: RequiresSchema.optional(),

  /**
   * Subscription definitions (only meaningful for type=automation).
   * Presence of this field is what makes an app "active" in the background.
   */
  subscriptions: z.array(SubscriptionDefSchema).optional(),

  /** Rule-based event filters (zero LLM cost pre-filtering) */
  filters: z.array(FilterRuleSchema).optional(),

  /** Memory schema -- what the AI should track in its memory file */
  memory_schema: MemorySchemaSchema.optional(),

  /** User configuration schema -- rendered as a form during install */
  config_schema: z.array(InputDefSchema).optional(),

  /** Output configuration */
  output: OutputConfigSchema.optional(),

  /** Permission declarations */
  permissions: z.array(z.string()).optional(),

  /**
   * Whether this skill is allowed to create sub-agents (Agent/Task tools).
   */
  allow_sub_agents: z.boolean().optional(),

  /**
   * MCP server configuration (only for type=mcp).
   * This is the standard Claude Code MCP server config format.
   */
  mcp_server: McpServerConfigSchema.optional(),

  /** Escalation behavior configuration (type=automation) */
  escalation: EscalationConfigSchema.optional(),

  /** Optional model recommendation from the spec author (informational only, not used at runtime) */
  recommended_model: z.string().optional(),

  /** Store/registry metadata (for distribution and discovery) */
  store: StoreMetadataSchema,

  /**
   * Locale-specific display text overrides.
   * Keys are BCP 47 locale tags (e.g. "zh-CN", "ja").
   * Only affects display text (name, description, config_schema labels/descriptions/placeholders/options).
   * system_prompt and runtime behavior are never overridden by i18n.
   */
  i18n: z
    .record(
      z.string(),
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        config_schema: z
          .record(
            z.string(),
            z.object({
              label: z.string().optional(),
              description: z.string().optional(),
              placeholder: z.string().optional(),
              /** Map of option value (as string) → translated label */
              options: z.record(z.string(), z.string()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/**
 * Full AppSpec schema with cross-field refinements.
 */
export const AppSpecSchema = AppSpecBaseSchema.superRefine((data, ctx) => {
  // type=automation requires system_prompt
  if (data.type === 'automation' && !data.system_prompt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Automation apps require a system_prompt',
      path: ['system_prompt'],
    });
  }

  // type=skill requires system_prompt
  if (data.type === 'skill' && !data.system_prompt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Skill apps require a system_prompt',
      path: ['system_prompt'],
    });
  }

  // type=mcp requires mcp_server
  if (data.type === 'mcp' && !data.mcp_server) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'MCP apps require a mcp_server configuration',
      path: ['mcp_server'],
    });
  }

  // subscriptions only allowed for type=automation
  if (data.subscriptions && data.subscriptions.length > 0 && data.type !== 'automation') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Subscriptions are only allowed for type=automation (got type=${data.type})`,
      path: ['subscriptions'],
    });
  }

  // memory_schema only allowed for type=automation
  if (
    data.memory_schema &&
    Object.keys(data.memory_schema).length > 0 &&
    data.type !== 'automation'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `memory_schema is only allowed for type=automation (got type=${data.type})`,
      path: ['memory_schema'],
    });
  }

  // mcp_server only allowed for type=mcp
  if (data.mcp_server && data.type !== 'mcp') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `mcp_server is only allowed for type=mcp (got type=${data.type})`,
      path: ['mcp_server'],
    });
  }

  // Validate subscription IDs are unique
  if (data.subscriptions && data.subscriptions.length > 1) {
    const ids = data.subscriptions.map((s, i) => s.id || `sub_${i}`);
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      if (seen.has(ids[i])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate subscription id: "${ids[i]}"`,
          path: ['subscriptions', i, 'id'],
        });
      }
      seen.add(ids[i]);
    }
  }

  // Validate config_key references exist in config_schema
  if (data.subscriptions && data.config_schema) {
    const configKeys = new Set(data.config_schema.map((c) => c.key));
    for (let i = 0; i < data.subscriptions.length; i++) {
      const sub = data.subscriptions[i];
      if (sub.config_key && !configKeys.has(sub.config_key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `config_key "${sub.config_key}" not found in config_schema`,
          path: ['subscriptions', i, 'config_key'],
        });
      }
    }
  }
});

// ============================================
// Derived TypeScript Types
// ============================================

export type AppType = z.infer<typeof AppTypeSchema>;
export type FilterOp = z.infer<typeof FilterOpSchema>;
export type FilterRule = z.infer<typeof FilterRuleSchema>;
export type InputType = z.infer<typeof InputTypeSchema>;
export type SelectOption = z.infer<typeof SelectOptionSchema>;
export type InputDef = z.infer<typeof InputDefSchema>;
export type MemoryField = z.infer<typeof MemoryFieldSchema>;
export type SubscriptionSource = z.infer<typeof SubscriptionSourceSchema>;
export type FrequencyDef = z.infer<typeof FrequencyDefSchema>;
export type SubscriptionDef = z.infer<typeof SubscriptionDefSchema>;
export type McpDependency = z.infer<typeof McpDependencySchema>;
export type SkillDependency = z.infer<typeof SkillDependencySchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type Requires = z.infer<typeof RequiresSchema>;
export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;
export type StoreMetadata = z.infer<typeof StoreMetadataSchema>;
export type AppSpec = z.infer<typeof AppSpecSchema>;

// i18n derived types (re-exported for convenience)
export type I18nConfigFieldOverride = NonNullable<
  NonNullable<AppSpec['i18n']>[string]['config_schema']
>[string];
export type I18nLocaleBlock = NonNullable<AppSpec['i18n']>[string];
