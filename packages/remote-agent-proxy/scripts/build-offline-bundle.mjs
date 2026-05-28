#!/usr/bin/env node

/**
 * Build offline deployment bundle for remote-agent-proxy.
 *
 * Creates a self-contained tar.gz that includes:
 *   - dist/ (compiled JS)
 *   - node_modules/ (production-only, already SDK-patched)
 *   - scripts/ (patch-sdk.mjs etc.)
 *   - package.json
 *   - deploy-env.sh (environment setup for remote server)
 *   - Node.js binary (linux-x64 and/or linux-arm64)
 *
 * Usage:
 *   node scripts/build-offline-bundle.mjs [--platform linux --arch x64] [--platform linux --arch arm64]
 *   node scripts/build-offline-bundle.mjs              # default: linux x64 + arm64
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const projectRoot = path.join(__dirname, '..', '..', '..');
const NODE_VERSION = 'v20.18.1';
const CDN_PRIMARY = 'https://nodejs.org/dist';
const CDN_FALLBACK = 'https://npmmirror.com/mirrors/node';

/**
 * Convert Windows path to Unix path for Git Bash compatibility.
 * E.g. "E:\foo\bar" → "/e/foo/bar"
 */
const toUnixPath = (p) => {
  let result = p.replace(/\\/g, '/');
  // E:/foo → /e/foo (lowercase drive letter for Git Bash)
  result = result.replace(/^([A-Za-z]):\//, (_, letter) => `/${letter.toLowerCase()}/`);
  return result;
};

// Parse CLI arguments
const args = process.argv.slice(2);
const platforms = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' && args[i + 1]) {
    const arch = (args[i + 2] === '--arch' && args[i + 3]) ? args[i + 3] : 'x64';
    platforms.push({ platform: args[i + 1], arch });
    i += arch !== args[i + 1] ? 2 : 0; // skip arch if provided
  } else if (args[i] === '--arch' && args[i - 1] === '--platform') {
    // already handled above
  }
}

// Default platforms if none specified
if (platforms.length === 0) {
  platforms.push({ platform: 'linux', arch: 'x64' });
  platforms.push({ platform: 'linux', arch: 'arm64' });
}

const outputDir = path.join(projectRoot, 'resources', 'offline-bundles');

console.log('='.repeat(60));
console.log('Building offline deployment bundles');
console.log(`Targets: ${platforms.map(p => `${p.platform}-${p.arch}`).join(', ')}`);
console.log('='.repeat(60));

// Ensure output directory exists
fs.mkdirSync(outputDir, { recursive: true });

// ===== Step 1: Build TypeScript (must run before --production install removes tsc) =====
console.log('\n[1/6] Compiling TypeScript...');
try {
  execSync('node scripts/build-with-timestamp.js', {
    cwd: rootDir,
    stdio: 'inherit',
  });
} catch (error) {
  console.error('TypeScript build failed');
  process.exit(1);
}

// ===== Step 2: Install production dependencies only =====
console.log('\n[2/6] Installing production dependencies...');
execSync('npm install --production --legacy-peer-deps', {
  cwd: rootDir,
  stdio: 'inherit',
});

// ===== Step 3: Clean node_modules to reduce size =====
console.log('\n[3/6] Cleaning node_modules...');
const nodeModulesDir = path.join(rootDir, 'node_modules');

function cleanDirectory(dir, depth = 0) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Always preserve @anthropic-ai (SDK core)
      if (depth === 0 && entry.name === '@anthropic-ai') continue;
      // Remove known non-essential directories
      const removePatterns = [
        /^test$/i, /^tests$/i, /^__tests__$/i, /^__mocks__$/i,
        /^\.github$/i, /^\.husky$/i, /^\.vscode$/i,
        /^docs$/i, /^examples$/i, /^coverage$/i,
        /^\.nyc_output$/i, /^\.cache$/i,
      ];
      if (removePatterns.some(p => p.test(entry.name))) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        continue;
      }
      cleanDirectory(fullPath, depth + 1);
    } else {
      // Remove non-essential files
      const removeExt = ['.ts', '.map', '.md', '.markdown'];
      const removeNames = [
        '.eslintignore', '.eslintrc*', '.prettierrc*', '.prettierignore',
        'README*', 'CHANGELOG*', 'CHANGES*', 'HISTORY*', 'LICENSE*',
        'LICENCE*', 'AUTHORS*', 'CONTRIBUTORS*', '.npmignore', '.gitignore',
        'tsconfig*.json', 'jest.config*', 'vitest.config*', 'Makefile',
        '*.tgz', 'binding.gyp',
      ];
      const ext = path.extname(fullPath);
      if (removeExt.includes(ext)) {
        fs.unlinkSync(fullPath);
        continue;
      }
      const name = entry.name;
      if (removeNames.some(p => {
        if (p.includes('*')) {
          return new RegExp('^' + p.replace(/\*/g, '.*') + '$', 'i').test(name);
        }
        return name === p;
      })) {
        fs.unlinkSync(fullPath);
      }
    }
  }
}

cleanDirectory(nodeModulesDir);

// Remove well-known dev-only packages that leak into production install
const devOnlyPackages = ['typescript', '@types/node', '@types/ws', '@types/express'];
for (const pkg of devOnlyPackages) {
  const pkgPath = path.join(nodeModulesDir, pkg);
  if (fs.existsSync(pkgPath)) {
    fs.rmSync(pkgPath, { recursive: true, force: true });
  }
}

// ===== Step 4: Download Node.js binaries =====
console.log('\n[4/6] Downloading Node.js binaries...');

// Detect xz availability early (determines archive format)
function ensureTarAvailable() {
  try {
    execSync('tar --version', { stdio: 'pipe' });
  } catch {
    console.error('Error: tar command not found. Please install tar.');
    process.exit(1);
  }
}

function ensureXzAvailable() {
  try {
    execSync('xz --version', { stdio: 'pipe' });
    return true;
  } catch {
    console.warn('Warning: xz not found. Will use .tar.gz format (larger but no xz dependency).');
    return false;
  }
}

ensureTarAvailable();
const useXz = ensureXzAvailable();
const ext = useXz ? 'tar.xz' : 'tar.gz';

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading: ${url}`);
    const file = fs.createWriteStream(dest);
    let redirectCount = 0;

    function attemptDownload(currentUrl) {
      redirectCount++;
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const client = currentUrl.startsWith('https') ? https : http;
      client.get(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          attemptDownload(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${currentUrl}`));
          return;
        }
        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalSize > 0) {
            const percent = ((downloaded / totalSize) * 100).toFixed(1);
            process.stdout.write(`  Progress: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} MB / ${(totalSize / 1024 / 1024).toFixed(1)} MB)\r`);
          }
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          if (totalSize > 0) process.stdout.write('\n');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    }

    attemptDownload(url);
  });
}

function getNodeUrl(platform, arch, useXz) {
  const ext = useXz ? 'tar.xz' : 'tar.gz';
  const filename = `node-${NODE_VERSION}-${platform}-${arch}.${ext}`;
  return { filename, url: `${CDN_PRIMARY}/${NODE_VERSION}/${filename}` };
}

for (const target of platforms) {
  const { filename, url } = getNodeUrl(target.platform, target.arch, useXz);
  const cacheDir = path.join(projectRoot, '.cache', 'node-binaries');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachedPath = path.join(cacheDir, filename);

  if (fs.existsSync(cachedPath)) {
    // Verify file integrity by checking size
    const stat = fs.statSync(cachedPath);
    if (stat.size > 10 * 1024 * 1024) { // > 10MB, reasonable for Node.js binary
      console.log(`  Using cached: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    // File too small, re-download
    fs.unlinkSync(cachedPath);
  }

  try {
    await downloadFile(url, cachedPath);
  } catch (error) {
    // Try fallback mirror
    console.log(`  Primary failed, trying fallback mirror...`);
    const fallbackFilename = getNodeUrl(target.platform, target.arch, useXz).filename;
    const fallbackUrl = `${CDN_FALLBACK}/${NODE_VERSION}/${fallbackFilename}`;
    await downloadFile(fallbackUrl, cachedPath);
  }
}

console.log('  All Node.js binaries ready.');

// ===== Step 5: Build tar.gz bundles =====
console.log('\n[5/6] Building tar.gz bundles...');

for (const target of platforms) {
  const { filename: nodeFilename } = getNodeUrl(target.platform, target.arch, useXz);
  const cacheDir = path.join(projectRoot, '.cache', 'node-binaries');
  const nodeArchivePath = path.join(cacheDir, nodeFilename);

  // Create staging directory
  const stagingName = `staging-${target.platform}-${target.arch}`;
  const stagingDir = path.join(rootDir, stagingName);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  // Copy dist, scripts, package.json
  fs.cpSync(path.join(rootDir, 'dist'), path.join(stagingDir, 'dist'), { recursive: true });
  fs.cpSync(path.join(rootDir, 'scripts'), path.join(stagingDir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(stagingDir, 'package.json'));

  // Copy node_modules
  console.log(`  Copying node_modules (${target.platform}-${target.arch})...`);
  fs.cpSync(nodeModulesDir, path.join(stagingDir, 'node_modules'), { recursive: true });

  // Extract Node.js binary into staging
  const nodeExtractDir = path.join(stagingDir, `node-${NODE_VERSION}-${target.platform}-${target.arch}`);
  console.log(`  Extracting Node.js ${NODE_VERSION} ${target.platform}-${target.arch}...`);
  fs.mkdirSync(nodeExtractDir, { recursive: true });

  const tarExtractFlag = useXz ? '-xJf' : '-xzf';
  execSync(`tar ${tarExtractFlag} "${toUnixPath(nodeArchivePath)}" -C "${toUnixPath(stagingDir)}"`, { stdio: 'inherit' });

  // Copy deploy-env.sh
  const deployEnvSource = path.join(__dirname, 'deploy-env.sh');
  fs.copyFileSync(deployEnvSource, path.join(stagingDir, 'deploy-env.sh'));

  // Create output tar.gz
  const outputFile = `aico-bot-offline-${target.platform}-${target.arch}.${ext}`;
  const outputPath = path.join(outputDir, outputFile);

  console.log(`  Packaging ${outputFile}...`);

  // Use tar to create the archive
  const tarArgs = useXz
    ? `tar -cJf "${toUnixPath(outputPath)}" -C "${toUnixPath(stagingDir)}" .`
    : `tar -czf "${toUnixPath(outputPath)}" -C "${toUnixPath(stagingDir)}" .`;

  execSync(tarArgs, { stdio: 'inherit', maxBuffer: 100 * 1024 * 1024 });

  // Report size
  const stat = fs.statSync(outputPath);
  console.log(`  Created: ${outputFile} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

  // Cleanup staging
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

// ===== Step 6: Summary =====
console.log('\n[6/6] Build complete!');
console.log('-'.repeat(40));
const outputFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('aico-bot-offline'));
for (const f of outputFiles) {
  const stat = fs.statSync(path.join(outputDir, f));
  console.log(`  ${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log('-'.repeat(40));
console.log('Output directory:', outputDir);
