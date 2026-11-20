#!/usr/bin/env bash
# claude-remote - let the Local LLM website run Claude Code sessions on this computer.
# For macOS and Linux.
#
# Run it in the folder you want to work in (or pass --root for other folders). It connects out to
# your PC's bridge, so nothing needs to be opened on this computer, and stays running until you
# press Ctrl+C. Sessions can only work inside the allowed folders, and every command or file
# change waits for your approval on the website (unless you pick "Allow file changes").
#
# Needs: Node.js 18.14+, Claude Code (the `claude` command), and claude-local set up once
# (it saves the bridge address and token that this reuses).
#
# Usage:
#   claude-remote                          allow the current folder
#   claude-remote --root ~/code --root ~/work
#   claude-remote --name laptop            how it appears on the website (default: computer name)
#   claude-remote --update                 download the latest version first
set -euo pipefail
REPO="https://raw.githubusercontent.com/wesleyhuhuhu/Notepad/main/host"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed. Install it from https://nodejs.org (version 18.14 or newer)." >&2
  exit 1
fi

# Use the copy next to this script when it's a checkout of the repo; otherwise keep one in ~/.local/share.
here="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
if [ -f "$here/../host/claude-remote.mjs" ]; then
  DIR="$(cd "$here/../host" && pwd)"
  managed_copy=0
else
  DIR="${XDG_DATA_HOME:-$HOME/.local/share}/claude-remote"
  managed_copy=1
fi

update=0
pass=()
for a in "$@"; do
  if [ "$a" = "--update" ]; then update=1; else pass+=("$a"); fi
done

if [ "$managed_copy" -eq 1 ] && { [ "$update" -eq 1 ] || [ ! -f "$DIR/claude-remote.mjs" ]; }; then
  echo "Downloading claude-remote to $DIR ..." >&2
  mkdir -p "$DIR"
  for f in claude-remote.mjs package.json; do
    curl -fsSL "$REPO/$f" -o "$DIR/$f"
  done
fi
if [ "$update" -eq 1 ] || [ ! -d "$DIR/node_modules/@anthropic-ai/claude-agent-sdk" ]; then
  echo "Installing the Claude Agent SDK (one time) ..." >&2
  # --omit=optional skips the SDK's own copy of Claude Code: your installed `claude` is used.
  (cd "$DIR" && npm install --omit=optional --no-audit --no-fund)
fi

exec node "$DIR/claude-remote.mjs" ${pass[@]+"${pass[@]}"}
