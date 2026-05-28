/**
 * Shared App Spec Types
 *
 * Pure TypeScript type definitions for the App Spec system.
 * These types are used by both the main process and the renderer process.
 *
 * IMPORTANT: This file must NOT import any Node.js or Electron APIs.
 * It is included in the renderer (web) tsconfig.
 *
 * All types here are manually mirrored from the Zod-derived types in
 * src/main/apps/spec/schema.ts. They must be kept in sync. When the Zod
 * schema changes, update these types accordingly.
 *
 * Why manual mirror instead of re-export?
 * - The renderer tsconfig does not include src/main/
 * - Importing from src/main/ would pull in Node.js types
 * - Zod schemas (runtime code) should not be bundled into the renderer
 */

// ============================================
// App Type
// ============================================

export type AppType = 'mcp' | 'skill' | 'automation' | 'extension';

// ============================================
// Filter Rules
// ============================================

export type FilterOp = 'eq' | 'neq' | 'contains' | 'matches' | 'gt' | 'lt' | 'gte' | 'lte';

export interface FilterRule {
  field: string;
  op: FilterOp;
  value: unknown;
}

// ============================================
// Input Definition (config_schema items)
// ============================================

export type InputType = 'url' | 'text' | 'string' | 'number' | 'select' | 'boolean' | 'email';

export interface SelectOption {
  label: string;
  value: string | number | boolean;
}

export interface InputDef {
  key: string;
  label: string;
  type: InputType;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: SelectOption[];
}

// ============================================
// Memory Schema
// ============================================

export interface MemoryField {
  type: string;
  description?: string;
}

export type MemorySchema = Record<string, MemoryField>;

// ============================================
// Subscription Source Configs
// ============================================

export interface ScheduleSourceConfig {
  every?: string;
  cron?: string;
}

export interface FileSourceConfig {
  pattern?: string;
  path?: string;
}

export interface WebhookSourceConfig {
  path?: string;
  secret?: string;
}

export interface WebpageSourceConfig {
  watch?: string;
  selector?: string;
  url?: string;
}

export interface RssSourceConfig {
  url?: string;
}

export type CustomSourceConfig = Record<string, unknown>;

// ============================================
// Subscription Source (discriminated union)
// ============================================

export type SubscriptionSourceType = 'schedule' | 'file' | 'webhook' | 'webpage' | 'rss' | 'custom';

export type SubscriptionSource =
  | { type: 'schedule'; config: ScheduleSourceConfig }
  | { type: 'file'; config: FileSourceConfig }
  | { type: 'webhook'; config: WebhookSourceConfig }
  | { type: 'webpage'; config: WebpageSourceConfig }
  | { type: 'rss'; config: RssSourceConfig }
  | { type: 'custom'; config: CustomSourceConfig };

// ============================================
// Frequency Definition
// ============================================

export interface FrequencyDef {
  default: string;
  min?: string;
  max?: string;
}

// ============================================
// Subscription Definition
// ============================================

export interface SubscriptionDef {
  id?: string;
  source: SubscriptionSource;
  frequency?: FrequencyDef;
  config_key?: string;
}

// ============================================
// MCP Dependency Declaration
// ============================================

export interface McpDependency {
  id: string;
  reason?: string;
  bundled?: boolean;
}

// ============================================
// Skill Dependency Declaration
// ============================================

export type SkillDependency =
  | string
  | {
      id: string;
      reason?: string;
      bundled?: boolean;
    };

// ============================================
// MCP Server Config (for type=mcp)
// ============================================

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// ============================================
// Output Notify Config
// ============================================

export interface OutputNotifyConfig {
  /** Send system desktop notification (default: true) */
  system?: boolean;
}

// ============================================
// Output Config
// ============================================

export interface OutputConfig {
  notify?: OutputNotifyConfig;
  format?: string;
}

// ============================================
// Requires Block
// ============================================

export interface Requires {
  mcps?: McpDependency[];
  skills?: SkillDependency[];
}

// ============================================
// Escalation Config
// ============================================

export interface EscalationConfig {
  enabled?: boolean;
  timeout_hours?: number;
}

// ============================================
// Store Metadata (for registry distribution)
// ============================================

export interface StoreMetadata {
  slug?: string;
  category?: string;
  tags?: string[];
  locale?: string;
  min_app_version?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  /** Install provenance: registry identifier used for update checks */
  registry_id?: string;
}

// ============================================
// i18n — Localization Overrides
// ============================================

/**
 * Per-field display text overrides for a single locale.
 * All fields are optional — only the overridden fields need to be provided.
 */
export interface I18nConfigFieldOverride {
  /** Translated field label */
  label?: string;
  /** Translated help text */
  description?: string;
  /** Translated placeholder */
  placeholder?: string;
  /**
   * Translated option labels, keyed by option value (as string).
   * Only values explicitly listed are overridden; others fall back to canonical labels.
   * Example: { "en-US": "English", "zh-CN": "中文" }
   */
  options?: Record<string, string>;
}

/**
 * Locale-specific display text overrides for a single BCP 47 locale.
 * Used as a value in the AppSpec `i18n` record.
 */
export interface I18nLocaleBlock {
  /** Translated app display name */
  name?: string;
  /** Translated app description */
  description?: string;
  /**
   * Per-field overrides, keyed by config_schema[].key.
   * Only fields that need translation need to be listed.
   */
  config_schema?: Record<string, I18nConfigFieldOverride>;
}

// ============================================
// Full App Spec
// ============================================

export interface AppSpec {
  spec_version: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: AppType;
  icon?: string;
  system_prompt?: string;
  requires?: Requires;
  subscriptions?: SubscriptionDef[];
  filters?: FilterRule[];
  memory_schema?: MemorySchema;
  config_schema?: InputDef[];
  output?: OutputConfig;
  permissions?: string[];
  /** Whether this skill is allowed to create sub-agents (Agent/Task tools) */
  allow_sub_agents?: boolean;
  mcp_server?: McpServerConfig;
  escalation?: EscalationConfig;
  /** Optional model recommendation from the spec author (informational only, not used at runtime) */
  recommended_model?: string;
  /** Store/registry metadata (for distribution and discovery) */
  store?: StoreMetadata;
  /**
   * Locale-specific display text overrides.
   * Keys are BCP 47 locale tags (e.g. "zh-CN", "ja").
   * Only affects display text (name, description, config_schema labels).
   * system_prompt and runtime behavior are never overridden by i18n.
   */
  i18n?: Record<string, I18nLocaleBlock>;
}

// ============================================
// Validation Issue (for error display in UI)
// ============================================

export interface ValidationIssue {
  path: string;
  message: string;
  received?: unknown;
}
