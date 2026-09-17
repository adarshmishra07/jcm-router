#!/usr/bin/env bash
# Points Claude Code at the local router by setting env.ANTHROPIC_BASE_URL in
# ~/.claude/settings.json. Touches no other key. Safe to run twice.
set -euo pipefail

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
STATE_DIR="${ROUTER_STATE_DIR:-$HOME/.claude-router}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v jq >/dev/null 2>&1; then
  echo "env-on: jq is required. Install it with: brew install jq" >&2
  exit 1
fi
if [ ! -f "$SETTINGS" ]; then
  echo "env-on: $SETTINGS does not exist. Start Claude Code once, or set CLAUDE_SETTINGS to the right path." >&2
  exit 1
fi

if [ -z "${PORT:-}" ] && [ -f "$ROOT/.env" ]; then
  PORT="$(grep -E '^PORT=' "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d "\"' " || true)"
fi
PORT="${PORT:-8787}"
BASE_URL="http://localhost:$PORT"

mkdir -p "$STATE_DIR/backup"
BACKUP="$STATE_DIR/backup/settings.json.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$BACKUP"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
jq --arg url "$BASE_URL" '.env = ((.env // {}) + {ANTHROPIC_BASE_URL: $url})' "$SETTINGS" >"$TMP"
if ! jq -e . "$TMP" >/dev/null 2>&1; then
  echo "env-on: the rewritten settings file is not valid JSON. Nothing was changed. Backup: $BACKUP" >&2
  exit 1
fi
mv "$TMP" "$SETTINGS"
trap - EXIT

echo "env-on: set env.ANTHROPIC_BASE_URL to $BASE_URL in $SETTINGS"
echo "        backup: $BACKUP"
echo "        restart Claude Code for it to pick this up."
