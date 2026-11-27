<#
  second-model.ps1 - load or unload the small model on the second GPU (bridge/second-model.js).

    .\second-model.ps1             show its state
    .\second-model.ps1 off         unload it, freeing its GPU memory (e.g. before a game); it stays off
    .\second-model.ps1 on          load it again (10-20 s)
    .\second-model.ps1 -Idle 30    unload it after 30 minutes unused (the next message loads it); 0 = never

  It talks to the bridge on this PC, so the bridge must be running.
#>
param(
  [ValidateSet('status', 'on', 'off', 'load', 'unload')][string]$Action = 'status',
  [int]$Idle = -1
)
$ErrorActionPreference = 'Stop'
$cfgFile = Join-Path $PSScriptRoot 'bridge\config.json'
$cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
$port = if ($cfg.port) { $cfg.port } else { 8787 }
$url = "http://127.0.0.1:$port/api/second-model"
$headers = @{ Authorization = "Bearer $($cfg.accessToken)" }

$body = @{}
if ($Action -in 'on', 'load') { $body.action = 'load'; Write-Host 'Loading the small model (10-20 s)...' }
if ($Action -in 'off', 'unload') { $body.action = 'unload' }
if ($Idle -ge 0) { $body.idleMinutes = $Idle }

try {
  if ($body.Count) { $s = Invoke-RestMethod $url -Method Post -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json) -TimeoutSec 240 }
  else { $s = Invoke-RestMethod $url -Headers $headers -TimeoutSec 15 }
} catch {
  $msg = $null
  $resp = $_.Exception.Response
  if ($resp) {
    # The bridge answered with an error: show its message.
    try { $msg = ((New-Object IO.StreamReader $resp.GetResponseStream()).ReadToEnd() | ConvertFrom-Json).error } catch {}
    if (-not $msg) { $msg = "The bridge returned $([int]$resp.StatusCode)." }
  } else { $msg = "Can't reach the bridge at http://127.0.0.1:$port. Is it running?" }
  Write-Host $msg -ForegroundColor Red
  exit 1
}

$where = if ($s.gpu) { " on the $($s.gpu)" } else { '' }
$state = switch ($s.state) {
  'loaded' { 'loaded' }
  'loading' { 'loading' }
  'unloaded' { 'unloaded (stays off until you load it)' }
  'idle' { 'unloaded after being unused (the next message loads it)' }
  default { $s.state }
}
$color = if ($s.state -eq 'loaded') { 'Green' } else { 'Yellow' }
Write-Host "$($s.id)$($where): $state" -ForegroundColor $color
if ($s.idleMinutes) { Write-Host "Auto-unload: after $($s.idleMinutes) min unused" } else { Write-Host 'Auto-unload: off (stays loaded)' }
if ($s.error) { Write-Host "Last error: $($s.error)" -ForegroundColor Red }
