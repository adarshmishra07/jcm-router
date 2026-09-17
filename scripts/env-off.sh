#!/usr/bin/env bash
# Removes env.ANTHROPIC_BASE_URL from ~/.claude/settings.json so Claude Code talks to the
# API directly again. Touches no other key. Safe to run twice. Does not stop the proxy.
set -euo pipefail

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
STATE_DIR="${ROUTER_STATE_DIR:-$HOME/.claude-router}"

if ! command -v jq >/dev/null 2>&1; then
  echo "env-off: jq is required. Install it with: brew install jq" >&2
  exit 1
fi
if [ ! -f "$SETTINGS" ]; then
  echo "env-off: $SETTINGS does not exist. Set CLAUDE_SETTINGS to the right path." >&2
  exit 1
fi

mkdir -p "$STATE_DIR/backup"
BACKUP="$STATE_DIR/backup/settings.json.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$BACKUP"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
jq 'if has("env") then (.env |= del(.ANTHROPIC_BASE_URL)) else . end
    | if has("env") and (.env == {}) then del(.env) else . end' "$SETTINGS" >"$TMP"
if ! jq -e . "$TMP" >/dev/null 2>&1; then
  echo "env-off: the rewritten settings file is not valid JSON. Nothing was changed. Backup: $BACKUP" >&2
  exit 1
fi
mv "$TMP" "$SETTINGS"
trap - EXIT

echo "env-off: removed env.ANTHROPIC_BASE_URL from $SETTINGS"
echo "         backup: $BACKUP"
echo "         restart Claude Code for it to pick this up."
echo "         the proxy keeps running: stop it with ctrl-c on 'bun run up'."
