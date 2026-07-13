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
if [ -n "$COPILOT_TOKEN" ]; then
    export COPILOT_GITHUB_TOKEN="$COPILOT_TOKEN"
    echo "🔑 Auth token set via COPILOT_GITHUB_TOKEN"
fi

# ── Run ───────────────────────────────────────────────────────────────────────
# Priority: ADDRESS (feasibility-report mode) > COPILOT_PROMPT > interactive.
if [ -n "$ADDRESS" ]; then
    echo "🏠 ADU feasibility run for: $ADDRESS"
    mkdir -p /workspace/reports

    # ── Telemetry run context (works with NO Azure; ships to App Insights only if
    #    APPLICATIONINSIGHTS_CONNECTION_STRING is set). Shared runId across all child procs.
    export MOLE_RUN_ID="${MOLE_RUN_ID:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo run-$$-$(date +%s))}"
    export MOLE_ADDRESS="$ADDRESS"
    export MOLE_TELEMETRY_DIR="${MOLE_TELEMETRY_DIR:-/workspace/reports/telemetry}"
    echo "📈 Telemetry runId=$MOLE_RUN_ID → $MOLE_TELEMETRY_DIR/$MOLE_RUN_ID.jsonl"
    node /workspace/tools/telemetry.mjs run_start start tool=entrypoint 2>/dev/null || true

    PROMPT="You have been invoked to produce an NH ADU feasibility report. \
Follow the instructions in AGENTS.md exactly. The target address is: \"$ADDRESS\". \
Collect data with tools/collect.mjs and tools/vgsi.cjs, apply NH + Manchester law, and \
write the report to reports/ then print a short summary. Work autonomously; do not ask questions."
    copilot --allow-all-tools --prompt "$PROMPT"
    RC=$?

    if [ "$RC" -eq 0 ]; then
        node /workspace/tools/telemetry.mjs run_end ok exitCode=0 2>/dev/null || true
    else
        node /workspace/tools/telemetry.mjs run_end error exitCode="$RC" 2>/dev/null || true
    fi
    exit "$RC"
elif [ -n "$COPILOT_PROMPT" ]; then
    echo "▶  Running with prompt: $COPILOT_PROMPT"
    exec copilot --allow-all-tools --prompt "$COPILOT_PROMPT"
else
    echo "▶  Starting interactive Copilot CLI..."
    exec copilot
fi
