#!/bin/bash
set -e

COPILOT_HOME="${COPILOT_HOME:-/root/.copilot}"
mkdir -p "$COPILOT_HOME"

# ── MCP config ────────────────────────────────────────────────────────────────
if [ ! -f "$COPILOT_HOME/mcp.json" ]; then
    echo "🔧 Seeding default MCP config..."
    cp /etc/copilot/mcp.json "$COPILOT_HOME/mcp.json"
fi

# ── Trust /workspace ──────────────────────────────────────────────────────────
# Copilot CLI requires the working directory to be in trustedFolders.
node - <<'JS'
const fs = require('fs');
const file = process.env.COPILOT_HOME + '/config.json';
let cfg = {};
if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
}
const user = process.env.COPILOT_USER || 'cjennison';
cfg.trustedFolders = cfg.trustedFolders || [];
if (!cfg.trustedFolders.includes('/workspace')) cfg.trustedFolders.push('/workspace');
if (process.env.COPILOT_TOKEN) {
    cfg.lastLoggedInUser = { host: 'https://github.com', login: user };
    cfg.loggedInUsers = cfg.loggedInUsers || [];
    if (!cfg.loggedInUsers.find(u => u.login === user)) {
        cfg.loggedInUsers.push({ host: 'https://github.com', login: user });
    }
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log('✅ Config ready for', user);
JS

# ── Auth ──────────────────────────────────────────────────────────────────────
# Copilot CLI accepts the token via COPILOT_GITHUB_TOKEN env var.
# COPILOT_TOKEN is our input variable; export it under the name Copilot expects.
if [ -n "$COPILOT_TOKEN" ]; then
    export COPILOT_GITHUB_TOKEN="$COPILOT_TOKEN"
    echo "🔑 Auth token set via COPILOT_GITHUB_TOKEN"
fi

# ── Run Copilot CLI ───────────────────────────────────────────────────────────
if [ -n "$COPILOT_PROMPT" ]; then
    echo "▶  Running with prompt: $COPILOT_PROMPT"
    exec copilot --prompt "$COPILOT_PROMPT"
else
    echo "▶  Starting interactive Copilot CLI..."
    exec copilot
fi
