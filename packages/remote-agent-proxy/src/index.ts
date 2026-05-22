#!/usr/bin/env node

import { config as configDotenv } from 'dotenv'
import { RemoteAgentServer } from './server.js'
import type { RemoteServerConfig } from './types.js'
import { setOnLogCallback } from './openai-compat-router/server/index.js'
import { log, SCOPE, setLogDir, cleanupOldLogs } from './logger.js'
import * as path from 'path'
import * as fs from 'fs'

// Load .env file from deployment directory
// DEPLOY_DIR is set by the start command to enable per-PC isolation
const deployDir = process.env.DEPLOY_DIR || '/opt/claude-deployment'
const deployPath = path.join(deployDir, '.env')
configDotenv({ path: deployPath })

function loadConfig(): RemoteServerConfig {
  const config: RemoteServerConfig = {
    port: parseInt(process.env.REMOTE_AGENT_PORT || process.env.PORT || '8080'),
    authToken: process.env.REMOTE_AGENT_AUTH_TOKEN || process.env.AUTH_TOKEN,
    workDir: process.env.REMOTE_AGENT_WORK_DIR || process.env.WORK_DIR,
    pathToClaudeCodeExecutable: process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE
  }

  // Load additional tokens from tokens.json in deploy directory
  const tokensJsonPath = path.join(deployDir, 'tokens.json')
  try {
    if (fs.existsSync(tokensJsonPath)) {
      const content = fs.readFileSync(tokensJsonPath, 'utf-8')
      const tokens = JSON.parse(content)
      if (Array.isArray(tokens)) {
        config.authTokens = tokens
      }
      config.tokensJsonPath = tokensJsonPath
    }
  } catch (error) {
    log.warn(SCOPE.SERVER, `Failed to load tokens.json: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Support comma-separated tokens env var
  if (process.env.REMOTE_AGENT_AUTH_TOKENS) {
    const extraTokens = process.env.REMOTE_AGENT_AUTH_TOKENS.split(',').map(t => t.trim()).filter(Boolean)
    config.authTokens = [...(config.authTokens || []), ...extraTokens]
  }

  log.info(SCOPE.SERVER, 'Configuration loaded:')
  log.info(SCOPE.SERVER, `  Port: ${config.port}`)
  log.info(SCOPE.SERVER, `  Auth Tokens: ${config.authTokens?.length || 0} additional${config.authToken ? ' + 1 primary' : ''} (open access if 0)`)
  log.info(SCOPE.SERVER, `  Deploy Dir: ${deployDir}`)
  log.info(SCOPE.SERVER, `  Tokens file: ${tokensJsonPath}`)
  log.info(SCOPE.SERVER, `  Work Dir: ${config.workDir || 'default'}`)
  log.info(SCOPE.SERVER, `  Claude Code Path: ${config.pathToClaudeCodeExecutable || 'not set (SDK mode)'}`)

  return config
}

/**
 * Migrate skills from ~/.claude/skills/ to ~/.agents/skills/ if not already present.
 * This runs on every startup so that skills placed in Claude's default directory
 * are automatically picked up by AICO-Bot.
 */
function migrateClaudeSkills(): void {
  const home = process.env.HOME || '/root'
  const claudeSkillsDir = path.join(home, '.claude', 'skills')
  const agentsSkillsDir = path.join(home, '.agents', 'skills')

  if (!fs.existsSync(claudeSkillsDir)) return

  if (!fs.existsSync(agentsSkillsDir)) {
    fs.mkdirSync(agentsSkillsDir, { recursive: true })
  }

  try {
    const entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const srcPath = path.join(claudeSkillsDir, entry.name)
        const destPath = path.join(agentsSkillsDir, entry.name)
        if (!fs.existsSync(destPath)) {
          fs.cpSync(srcPath, destPath, { recursive: true })
          log.info(SCOPE.SERVER, `Migrated Claude skill: ${entry.name}`)
        }
      }
    }
  } catch (error) {
    log.error(SCOPE.SERVER, `Failed to migrate Claude skills: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function main(): void {
  migrateClaudeSkills()
  const config = loadConfig()

  // Initialize file logging
  setLogDir(path.join(deployDir, 'logs'))
  cleanupOldLogs()

  const server = new RemoteAgentServer(config)

  // Forward OpenAI Compat Router logs to all connected WebSocket clients AND file
  setOnLogCallback((entry) => {
    server.forwardLogToClients(entry)
    const scope = entry.source === 'router' ? 'Router' : 'RequestHandler'
    const msg = `[${entry.source}] ${entry.message}`
    if (entry.level === 'error') log.error(scope, msg)
    else if (entry.level === 'warn') log.warn(scope, msg)
    else log.info(scope, msg)
  })

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    log.info(SCOPE.SERVER, 'Shutting down server...')
    server.close()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    log.info(SCOPE.SERVER, 'Shutting down server...')
    server.close()
    process.exit(0)
  })
}

main()
