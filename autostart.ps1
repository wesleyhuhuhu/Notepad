<#
  autostart.ps1 - what the "Local LLM bridge" login task runs (see install-autostart.ps1).

  Waits for the network after you log in, then runs start.ps1 so that LM Studio's server, the
  model, Tailscale Funnel and the bridge are all running, and keeps the bridge running: if it
  stops, it starts again. Everything it prints goes to bridge\logs\bridge-<date>.log (the access
  token is not printed). Logs older than 14 days are deleted.
#>
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logDir = Join-Path $root 'bridge\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
Get-ChildItem $logDir -Filter 'bridge-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -ErrorAction SilentlyContinue
$log = Join-Path $logDir ('bridge-{0:yyyy-MM-dd}.log' -f (Get-Date))

function Log($msg) { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" | Out-File $log -Append -Encoding utf8 }

# Only one copy: if a bridge already answers on this PC, there's nothing to do.
try {
  Invoke-RestMethod 'http://127.0.0.1:8787/health' -TimeoutSec 3 | Out-Null
  Log 'A bridge is already running; not starting another.'
  exit 0
} catch {}

# Right after login the network and Tailscale may still be starting.
for ($i = 0; $i -lt 30; $i++) {
  if ((& tailscale status 2>$null) -and $LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}

Log 'Starting LM Studio server, model, Funnel and bridge'
& (Join-Path $root 'start.ps1') -KeepRunning -Quiet *>&1 | ForEach-Object { "$_" } | Out-File $log -Append -Encoding utf8
