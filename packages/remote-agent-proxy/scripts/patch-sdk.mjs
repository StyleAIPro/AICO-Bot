#!/usr/bin/env node
/**
 * Patch @anthropic-ai/claude-agent-sdk for AICO-Bot.
 *
 * Unified patch script serving both local (Electron main process) and remote
 * (remote-agent-proxy) environments.
 *
 * Why: The SDK's unstable_v2_createSession hardcodes many options instead of
 * forwarding them from the caller. This script patches the minified SDK to
 * forward these options (cwd, systemPrompt, maxThinkingTokens, etc.).
 *
 * IMPORTANT: Minified variable names change between SDK versions. When
 * upgrading the SDK, all patch patterns must be re-verified against the new
 * sdk.mjs. See .project/modules/agent/features/sdk-patch/design.md.
 *
 * Run: node scripts/patch-sdk.mjs
 *      (called automatically by bootstrap and build scripts)
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

// Resolve SDK path
const sdkPath = join(
  rootDir,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'sdk.mjs',
)

// Fix ripgrep binary permissions — npm packages ship without +x,
// which breaks Grep tool on Linux/macOS remote servers.
// Windows is unaffected (no Unix permission bits).
if (existsSync(sdkPath)) {
  try {
    const rgDir = join(rootDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep')
    if (existsSync(rgDir)) {
      for (const entry of readdirSync(rgDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const rgBin = join(rgDir, entry.name, 'rg')
          if (existsSync(rgBin)) {
            chmodSync(rgBin, 0o755)
          }
        }
      }
      console.log('[patch-sdk] Fixed ripgrep binary permissions (chmod 755)')
    }
  } catch {
    // Non-critical — Windows or permission issues, silently skip
  }
}

if (!existsSync(sdkPath)) {
  console.log('[patch-sdk] SDK not found, skipping patch')
  process.exit(0)
}

let sdk = readFileSync(sdkPath, 'utf-8')

// Check if already patched
if (sdk.includes('[PATCHED] AICO-Bot SDK patch applied')) {
  console.log('[patch-sdk] Already patched, skipping')
  process.exit(0)
}

let patchCount = 0

// === PATCH 1: Remove ALL CLAUDE_CODE_ENTRYPOINT assignments ===
// Minifier uses different variable names every build.
// Pattern: <var>.CLAUDE_CODE_ENTRYPOINT="sdk-ts";
const entryRe = /[a-zA-Z][A-Za-z0-9_]*\.CLAUDE_CODE_ENTRYPOINT="sdk-ts";/g
const entryMatches = [...sdk.matchAll(entryRe)]
if (entryMatches.length >= 1) {
  sdk = sdk.replace(entryRe, '')
  patchCount++
  console.log(
    `[patch-sdk] Patched: Removed CLAUDE_CODE_ENTRYPOINT (${entryMatches.length} occurrence(s))`,
  )
} else {
  console.warn(
    '[patch-sdk] WARNING: Could not find CLAUDE_CODE_ENTRYPOINT',
  )
}

// === PATCH 2: Remove CLAUDE_AGENT_SDK_VERSION ===
const verMatch = sdk.match(/process\.env\.CLAUDE_AGENT_SDK_VERSION="[^"]+";/)
if (verMatch) {
  sdk = sdk.replace(verMatch[0], '')
  patchCount++
  console.log('[patch-sdk] Patched: Removed CLAUDE_AGENT_SDK_VERSION')
} else {
  console.warn('[patch-sdk] WARNING: Could not find CLAUDE_AGENT_SDK_VERSION')
}

// === PATCH 3: ProcessTransport constructor — Forward all options ===
// NOTE: This pattern is version-specific. Update when upgrading SDK.
// Minified variable names change between SDK builds:
//   0.2.104: mX→aX, env:J→Y, g1()→c1()
const oldMxCtor =
  'new aX({abortController:this.abortController,pathToClaudeCodeExecutable:X,env:Y,executable:$.executable??(c1()?"bun":"node"),executableArgs:$.executableArgs??[],extraArgs:{},thinkingConfig:void 0,maxTurns:void 0,maxBudgetUsd:void 0,model:$.model,fallbackModel:void 0,permissionMode:$.permissionMode??"default",allowDangerouslySkipPermissions:!1,continueConversation:!1,resume:$.resume,settingSources:[],allowedTools:$.allowedTools??[],disallowedTools:$.disallowedTools??[],mcpServers:{},strictMcpConfig:!1,canUseTool:!!$.canUseTool,hooks:!!$.hooks,includePartialMessages:!1,forkSession:!1,resumeSessionAt:void 0})'

if (sdk.includes(oldMxCtor)) {
  const newMxCtor =
    'new aX({abortController:this.abortController,pathToClaudeCodeExecutable:X,' +
    'cwd:$.cwd,' +
    'stderr:$.stderr,' +
    'env:Y,' +
    'executable:$.executable??(c1()?"bun":"node"),' +
    'executableArgs:$.executableArgs??[],' +
    'extraArgs:$.extraArgs??{},' +
    'thinkingConfig:void 0,' +
    'maxTurns:$.maxTurns??void 0,' +
    'maxBudgetUsd:$.maxBudgetUsd??void 0,' +
    'model:$.model,' +
    'fallbackModel:$.fallbackModel??void 0,' +
    'permissionMode:$.permissionMode??"default",' +
    'allowDangerouslySkipPermissions:$.allowDangerouslySkipPermissions??!1,' +
    'continueConversation:$.continueConversation??!1,' +
    'resume:$.resume,' +
    'settingSources:$.settingSources??[],' +
    'allowedTools:$.allowedTools??[],' +
    'disallowedTools:$.disallowedTools??[],' +
    'mcpServers:$.mcpServers??{},' +
    'strictMcpConfig:$.strictMcpConfig??!1,' +
    'canUseTool:!!$.canUseTool,' +
    'hooks:!!$.hooks,' +
    'includePartialMessages:$.includePartialMessages??!0,' +
    'forkSession:$.forkSession??!1,' +
    'resumeSessionAt:$.resumeSessionAt??void 0,' +
    'sandbox:$.sandbox,' +
    'additionalDirectories:$.additionalDirectories??void 0})'

  sdk = sdk.replace(oldMxCtor, newMxCtor)
  patchCount++
  console.log(
    '[patch-sdk] Patched: Forwarded cwd + all options to ProcessTransport',
  )
} else {
  console.warn(
    '[patch-sdk] WARNING: Could not find ProcessTransport constructor (SDK version may differ)',
  )
}

// === PATCH 4: Pass initConfig (systemPrompt) to Query ===
// NOTE: This pattern is version-specific. Update when upgrading SDK.
//   0.2.104: lX→sX
const oldQueryCtor =
  'this.query=new sX(Q,!1,$.canUseTool,$.hooks,this.abortController,new Map)'

if (sdk.includes(oldQueryCtor)) {
  const sp =
    'typeof $.systemPrompt==="string"?$.systemPrompt:($.systemPrompt?.append??"")'
  const newQueryCtor =
    'const _sp=' +
    sp +
    ';' +
    'const _ic={systemPrompt:_sp,appendSystemPrompt:$.systemPrompt?.type==="preset"?$.systemPrompt.append:void 0,agents:$.agents};' +
    'this.query=new sX(Q,!1,$.canUseTool,$.hooks,this.abortController,new Map,void 0,_ic)'

  sdk = sdk.replace(oldQueryCtor, newQueryCtor)
  patchCount++
  console.log('[patch-sdk] Patched: Pass systemPrompt via initConfig to Query')
} else {
  console.warn(
    '[patch-sdk] WARNING: Could not find Query constructor (SDK version may differ)',
  )
}

// === PATCH 5: Add runtime control methods to Session ===
// NOTE: This pattern is version-specific. Update when upgrading SDK.
//   0.2.104: UI→B2
const oldClose =
  'close(){if(this.closed)return;this.closed=!0,this.inputStream.done(),setTimeout(()=>{if(!this.abortController.signal.aborted)this.abortController.abort()},B2).unref()}async[Symbol.asyncDispose](){this.close()}}'

if (sdk.includes(oldClose)) {
  const newMethods =
    'async interrupt(){return this.query.interrupt()}' +
    'async setModel($){return this.query.setModel($)}' +
    'async setMaxThinkingTokens($){return this.query.setMaxThinkingTokens($)}' +
    'async setPermissionMode($){return this.query.setPermissionMode($)}' +
    'get pid(){return this.query?.transport?.process?.pid}' +
    oldClose

  sdk = sdk.replace(oldClose, newMethods)
  patchCount++
  console.log(
    '[patch-sdk] Patched: Added interrupt/setModel/setMaxThinkingTokens/setPermissionMode/pid to Session',
  )
} else {
  console.warn(
    '[patch-sdk] WARNING: Could not find close method in Session class (SDK version may differ)',
  )
}

// Add patch marker AFTER shebang (shebang must stay on line 1)
const shebangMatch = sdk.match(/^#!\/usr\/bin\/env node\n([\s\S]*)/)
if (shebangMatch) {
  sdk =
    '#!/usr/bin/env node\n// [PATCHED] AICO-Bot SDK patch applied\n' +
    shebangMatch[1]
} else {
  sdk = '// [PATCHED] AICO-Bot SDK patch applied\n' + sdk
}

writeFileSync(sdkPath, sdk)
console.log(`[patch-sdk] Applied ${patchCount} patch(es) to ${sdkPath}`)
