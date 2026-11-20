<#
  claude-remote.ps1 - let the Local LLM website run Claude Code sessions on this computer.

  Run it in the folder you want to work in (or pass --root for other folders). It connects out to
  your PC's bridge, so nothing needs to be opened on this computer, and stays running until you
  close it or press Ctrl+C. Sessions can only work inside the allowed folders, and every command
  or file change waits for your approval on the website (unless you pick "Allow file changes").

  Needs: Node.js 18.14+, Claude Code (the `claude` command), and claude-local set up once
  (it saves the bridge address and token that this reuses).

  Usage:
    claude-remote                          allow the current folder
    claude-remote --root D:\code --root C:\work
    claude-remote --name laptop            how it appears on the website (default: computer name)
    claude-remote --update                 download the latest version first
#>

$ErrorActionPreference = 'Stop'
$repo = 'https://raw.githubusercontent.com/wesleyhuhuhu/Notepad/main/host'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is needed. Install it from https://nodejs.org (version 18.14 or newer).' -ForegroundColor Red
  exit 1
}

# Use the copy next to this script when it's a checkout of the repo; otherwise keep one in AppData.
$local = Join-Path (Split-Path -Parent $PSCommandPath) '..\host'
$dir = if (Test-Path (Join-Path $local 'claude-remote.mjs')) { (Resolve-Path $local).Path } else { Join-Path $env:LOCALAPPDATA 'claude-remote' }

$update = $args -contains '--update'
$pass = @($args | Where-Object { $_ -ne '--update' })

if ($update -or -not (Test-Path (Join-Path $dir 'claude-remote.mjs'))) {
  if ($dir -eq (Join-Path $env:LOCALAPPDATA 'claude-remote')) {
    Write-Host "Downloading claude-remote to $dir ..." -ForegroundColor DarkGray
    New-Item -ItemType Directory -Force $dir | Out-Null
    foreach ($f in 'claude-remote.mjs', 'package.json') {
      Invoke-WebRequest "$repo/$f" -OutFile (Join-Path $dir $f) -UseBasicParsing
    }
  }
}
if ($update -or -not (Test-Path (Join-Path $dir 'node_modules\@anthropic-ai\claude-agent-sdk'))) {
  Write-Host 'Installing the Claude Agent SDK (one time) ...' -ForegroundColor DarkGray
  Push-Location $dir
  try {
    # --omit=optional skips the SDK's own copy of Claude Code: your installed `claude` is used.
    & npm install --omit=optional --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'npm install failed' }
  } finally { Pop-Location }
}

& node (Join-Path $dir 'claude-remote.mjs') @pass
exit $LASTEXITCODE
