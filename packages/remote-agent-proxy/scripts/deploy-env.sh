#!/usr/bin/env bash
# AICO-Bot Offline Deploy - Environment Setup
# Sets up Node.js from bundled binary, configures PATH and SDK symlink.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find bundled Node.js binary
for node_dir in "$DEPLOY_DIR"/node-v*; do
  if [ -d "$node_dir/bin" ]; then
    export PATH="$node_dir/bin:$PATH"
    echo "[deploy-env] Node.js: $(node --version) (bundled)"
    break
  fi
done

# Ensure npm/npx from bundled Node.js are in PATH
export PATH="$DEPLOY_DIR/node_modules/.bin:$PATH"

# Create global SDK symlink so claude CLI can find the SDK
# This is needed because @anthropic-ai/claude-agent-sdk's ProcessTransport
# resolves the SDK from global node_modules.
GLOBAL_NODE_MODULES="/usr/local/lib/node_modules"
if [ -d "$DEPLOY_DIR/node_modules/@anthropic-ai" ] && [ ! -L "$GLOBAL_NODE_MODULES/@anthropic-ai" ]; then
  echo "[deploy-env] Creating global SDK symlink..."
  sudo mkdir -p "$GLOBAL_NODE_MODULES" 2>/dev/null || true
  sudo ln -sf "$DEPLOY_DIR/node_modules/@anthropic-ai" "$GLOBAL_NODE_MODULES/@anthropic-ai" 2>/dev/null || {
    # Fallback: create in user-local global
    USER_GLOBAL="$(npm root -g 2>/dev/null || echo "$HOME/.npm-global/lib/node_modules")"
    mkdir -p "$USER_GLOBAL" 2>/dev/null || true
    ln -sf "$DEPLOY_DIR/node_modules/@anthropic-ai" "$USER_GLOBAL/@anthropic-ai" 2>/dev/null || true
    echo "[deploy-env] Created SDK symlink at $USER_GLOBAL/@anthropic-ai"
  }
fi

# Fix vendor binary permissions (ripgrep, etc.)
# npm pack strips execute permissions; these must be restored on deployment.
VENDOR_BIN_DIR="$DEPLOY_DIR/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep"
if [ -d "$VENDOR_BIN_DIR" ]; then
  chmod +x "$VENDOR_BIN_DIR"/*/rg 2>/dev/null || true
  echo "[deploy-env] Restored execute permission for vendor binaries"
fi

echo "[deploy-env] Environment ready. DEPLOY_DIR=$DEPLOY_DIR"
