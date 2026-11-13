#!/usr/bin/env bash
# claude-local - start Claude Code using the local model on your PC (LM Studio, through the bridge).
# For macOS and Linux.
#
# The first run asks for the bridge address and access token and saves them to
# ~/.config/claude-local/config (readable only by you). Your normal `claude` command is not
# changed: everything is set only for this one Claude Code session.
#
# Usage (anything the script doesn't recognise is passed to claude as is):
#   claude-local                         interactive Claude Code, core coding tools only
#   claude-local -p "fix the failing test"
#   claude-local --continue
#   claude-local --all-tools             every Claude Code tool (~16k tokens of setup instead of ~4.4k)
#   claude-local --context 32768         tell Claude Code a smaller context than the loaded model's
#   claude-local --max-output 12000      longest reply, thinking included (default 8192)
#   claude-local --setup                 change the saved address or token
#
# Install:  mkdir -p ~/bin && cp claude-local.sh ~/bin/claude-local && chmod +x ~/bin/claude-local
set -euo pipefail

CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-local"
CFG_FILE="$CFG_DIR/config"
CORE_TOOLS="Bash,Edit,Glob,Grep,Read,Write"

setup=0; all_tools=0; context=0; max_output=8192; pass=()
while [ $# -gt 0 ]; do
  case "$1" in
    --setup) setup=1 ;;
    --all-tools) all_tools=1 ;;
    --context) shift; context="${1:-0}" ;;
    --max-output) shift; max_output="${1:-8192}" ;;
    *) pass+=("$1") ;;
  esac
  shift
done

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code isn't installed. Install it from https://claude.com/claude-code first." >&2
  exit 1
fi

BRIDGE_URL=""; TOKEN=""
if [ -f "$CFG_FILE" ] && [ "$setup" -eq 0 ]; then
  # shellcheck disable=SC1090
  . "$CFG_FILE"
fi
if [ -z "$BRIDGE_URL" ] || [ -z "$TOKEN" ]; then
  default=""
  if curl -fsS -m 2 "http://127.0.0.1:8787/health" >/dev/null 2>&1; then default="http://127.0.0.1:8787"; fi
  echo "Set up claude-local"
  if [ -n "$default" ]; then read -r -p "Bridge address [$default]: " BRIDGE_URL; BRIDGE_URL="${BRIDGE_URL:-$default}"
  else read -r -p "Bridge address (e.g. https://your-pc.your-tailnet.ts.net): " BRIDGE_URL; fi
  read -r -s -p "Access token (from bridge/config.json): " TOKEN; echo
  BRIDGE_URL="${BRIDGE_URL%/}"
  mkdir -p "$CFG_DIR"
  umask 077
  printf 'BRIDGE_URL=%q\nTOKEN=%q\n' "$BRIDGE_URL" "$TOKEN" > "$CFG_FILE"
  chmod 600 "$CFG_FILE"
  echo "Saved to $CFG_FILE"
fi
BRIDGE_URL="${BRIDGE_URL%/}"

# Ask the bridge which model is loaded and how big its context is.
echo "Connecting to $BRIDGE_URL ..." >&2
status=0
info="$(curl -sS -m 240 -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BRIDGE_URL/api/claude-code?load=1")" || status=$?
code="$(printf '%s' "$info" | tail -n 1)"
if [ "$status" -ne 0 ] || [ "$code" != "200" ]; then
  if [ "$code" = "401" ]; then echo "The bridge rejected the access token. Run: claude-local --setup" >&2
  else echo "Couldn't reach the bridge at $BRIDGE_URL. Is the PC on and start.ps1 running?" >&2; fi
  exit 1
fi
model="$(printf '%s\n' "$info" | sed -n 's/^MODEL=//p' | tr -d '\r')"
ctx="$(printf '%s\n' "$info" | sed -n 's/^CONTEXT=\([0-9]*\).*/\1/p')"
ctx="${ctx:-0}"
if [ -z "$model" ]; then echo "The bridge has no model available in LM Studio." >&2; exit 1; fi
if [ "$context" -gt 0 ] 2>/dev/null; then ctx="$context"; fi
if [ "$ctx" -eq 0 ]; then ctx=32768; echo "Couldn't read the model's context size; assuming $ctx." >&2; fi

# Point this Claude Code session at the bridge.
export ANTHROPIC_BASE_URL="$BRIDGE_URL"
export ANTHROPIC_AUTH_TOKEN="$TOKEN"
unset ANTHROPIC_API_KEY
for v in ANTHROPIC_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL \
         ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_SMALL_FAST_MODEL CLAUDE_CODE_SUBAGENT_MODEL; do
  export "$v=$model"
done
# The model's real context window, so auto-compact happens before it overflows.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$ctx"
# Claude Code keeps room for one full reply plus ~13k free before it compacts, so a smaller
# reply cap leaves more room for work: 8192 -> compacts at about ctx - 21k (34k of 55k).
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="$max_output"
if [ $(( ctx - max_output - 13000 )) -lt 10000 ]; then
  echo "A $ctx-token context leaves Claude Code almost no room before it compacts. It works best with 32k or more." >&2
fi
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

tool_args=(--tools "$CORE_TOOLS")
label="core tools"
if [ "$all_tools" -eq 1 ]; then tool_args=(); label="all tools"; fi
echo "Claude Code -> $model ($ctx-token context, $label)" >&2
exec claude ${tool_args[@]+"${tool_args[@]}"} ${pass[@]+"${pass[@]}"}
