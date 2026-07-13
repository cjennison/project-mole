#!/bin/bash
# Entrypoint for the MOLE agent worker container. Seeds Copilot CLI config (trust + auth) so the
# CLI can run non-interactively on the operator's token, then starts the queue worker.
set -e

COPILOT_HOME="${COPILOT_HOME:-/root/.copilot}"
mkdir -p "$COPILOT_HOME"

# ── MCP config (Playwright browser + GitHub) ──────────────────────────────────
if [ ! -f "$COPILOT_HOME/mcp-config.json" ] && [ -f /etc/copilot/mcp.json ]; then
    cp /etc/copilot/mcp.json "$COPILOT_HOME/mcp-config.json" || true
fi

# ── Auth: accept the PAT from any of the common env names, export the ones the CLI reads ──
PAT="${COPILOT_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-${MOLE_COPILOT_PAT:-}}}}"
if [ -n "$PAT" ]; then
    export COPILOT_GITHUB_TOKEN="$PAT"
    export GITHUB_TOKEN="$PAT"
    export GH_TOKEN="$PAT"
    echo "🔑 Copilot auth token configured"
else
    echo "⚠️  No PAT provided (COPILOT_GITHUB_TOKEN); Copilot CLI will fall back to deterministic mode"
fi

# ── Trust /workspace + record the login so non-interactive runs don't prompt ──
COPILOT_USER="${COPILOT_USER:-cjennison}" node - <<'JS'
const fs = require('fs');
const file = process.env.COPILOT_HOME + '/config.json';
let cfg = {};
if (fs.existsSync(file)) { try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
cfg.trustedFolders = Array.from(new Set([...(cfg.trustedFolders || []), '/workspace']));
if (process.env.COPILOT_GITHUB_TOKEN) {
    const user = process.env.COPILOT_USER;
    cfg.lastLoggedInUser = { host: 'https://github.com', login: user };
    cfg.loggedInUsers = cfg.loggedInUsers || [];
    if (!cfg.loggedInUsers.find(u => u.login === user)) cfg.loggedInUsers.push({ host: 'https://github.com', login: user });
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log('✅ Copilot config ready for', process.env.COPILOT_USER);
JS

cd /workspace
echo "▶  Starting MOLE agent worker (model=${MOLE_AGENT_MODEL:-claude-opus-4.8})…"
exec node /workspace/worker/worker.mjs
