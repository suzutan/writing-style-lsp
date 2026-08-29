#!/usr/bin/env bash
# Claude Code PostToolUse (Edit|Write) hook。
# 編集されたファイルに応じた検査を即時に走らせ、失敗は exit 2 で Claude へフィードバックする。
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0

case "$file" in
  *.ts | *.mjs | *.json)
    npx --no-install biome check "$file" >&2 || exit 2
    ;;
  *.md)
    if [ -f dist/cli.js ]; then
      node dist/cli.js lint "$file" --fail-on warning >&2 || exit 2
    fi
    ;;
esac
