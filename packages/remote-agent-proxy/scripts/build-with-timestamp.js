#!/usr/bin/env node

/**
 * Build script with timestamp
 * Compiles TypeScript and adds build timestamp to dist/version.json
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const projectRoot = path.join(__dirname, '..', '..', '..')
const distDir = path.join(rootDir, 'dist')

console.log('Building remote-agent-proxy...')

// Step 1: Compile TypeScript
try {
  const tscBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  execSync(`"${tscBin}"`, { cwd: rootDir, stdio: 'inherit' })
  console.log('TypeScript compilation successful')
} catch (error) {
  console.error('TypeScript compilation failed')
  process.exit(1)
}

// Step 2: Generate build info
const now = new Date()
const buildInfo = {
  version: '1.0.0',
  buildTimestamp: now.toISOString(),
  buildTime: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  buildTimeUTC: now.toLocaleString('en-US', { timeZone: 'UTC' }),
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch
}

// Read package.json version
try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'))
  buildInfo.version = packageJson.version
} catch (e) {
  console.warn('Could not read package.json version')
}

// Step 3: Write build info to dist/version.json
fs.writeFileSync(
  path.join(distDir, 'version.json'),
  JSON.stringify(buildInfo, null, 2) + '\n'
)

console.log('Build info written to dist/version.json:')
console.log(JSON.stringify(buildInfo, null, 2))

// Step 4: Also create a build-info.js module that can be imported
const buildInfoModule = `// Auto-generated build info
export const buildInfo = ${JSON.stringify(buildInfo, null, 2)};
export const BUILD_TIMESTAMP = '${buildInfo.buildTimestamp}';
export const BUILD_TIME = '${buildInfo.buildTime}';
export const VERSION = '${buildInfo.version}';
`

fs.writeFileSync(
  path.join(distDir, 'build-info.js'),
  buildInfoModule
)

// Step 5: Fix ESM imports in openai-compat-router dist files
// TypeScript with bundler moduleResolution doesn't add .js extensions to imports,
// but Node.js ESM requires them at runtime. This post-build step fixes:
// 1. './xxx' → './xxx.js' (if xxx.js exists)
// 2. './xxx' → './xxx/index.js' (if xxx/ is a directory with index.js)
console.log('\nFixing ESM import extensions...')
const routerDistDir = path.join(distDir, 'openai-compat-router')
if (fs.existsSync(routerDistDir)) {
  function fixImports(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const fp = path.join(dir, entry)
      if (fs.statSync(fp).isDirectory()) {
        fixImports(fp)
      } else if (entry.endsWith('.js')) {
        let content = fs.readFileSync(fp, 'utf8')
        let changed = false
        content = content.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (match, prefix, importPath, suffix) => {
          // Skip if already has extension
          if (importPath.endsWith('.js') || importPath.endsWith('.json')) return match
          // Resolve the import path relative to the current file's directory
          const resolved = path.resolve(dir, importPath)
          // Check if it's a directory with index.js (barrel export)
          if (fs.existsSync(path.join(resolved, 'index.js'))) {
            changed = true
            return `${prefix}${importPath}/index.js${suffix}`
          }
          // Check if it's a .js file
          if (fs.existsSync(resolved + '.js')) {
            changed = true
            return `${prefix}${importPath}.js${suffix}`
          }
          // Fallback: just add .js
          changed = true
          return `${prefix}${importPath}.js${suffix}`
        })
        if (changed) {
          fs.writeFileSync(fp, content)
        }
      }
    }
  }
  fixImports(routerDistDir)
  console.log('ESM import extensions fixed')
}

// Step 6: Patch SDK for remote agent usage (option forwarding + turn-level injection)
// Uses the unified patch script from project root (scripts/patch-sdk.mjs)
console.log('\nPatching SDK...')
try {
  const unifiedPatchScript = path.join(projectRoot, 'scripts', 'patch-sdk.mjs')
  execSync('node ' + unifiedPatchScript, { cwd: rootDir, stdio: 'inherit' })
} catch (error) {
  console.warn('SDK patch failed (non-fatal):', error.message)
}

console.log('\nBuild completed successfully!')
