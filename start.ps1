<#
  Starts everything needed to use your local model from the website:
    1. LM Studio's local server (port 1234)
    2. Loads a model if none is loaded
    3. Tailscale Funnel -> public HTTPS URL that forwards to the bridge
    4. The bridge (runs in this window; Ctrl+C to stop)

  Usage:
    .\start.ps1                       # uses "model" from bridge\config.json, or whatever is loaded
    .\start.ps1 -Model qwen3.8-27b-heretic-abliterated-uncensored@iq4_xs
    .\start.ps1 -NoFunnel             # local only, no internet access
    .\start.ps1 -ContextLength 16384  # cap the context, e.g. while a game is using the GPU
                                      # (default: the model's own LM Studio settings)
#>
param(
  [string]$Model = "",
  [int]$ContextLength = 0,
  [switch]$NoFunnel
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bridge = Join-Path $root 'bridge'
$configPath = Join-Path $bridge 'config.json'

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# Read config (server.js creates it with a token on first run; do the same here so we can print the link)
if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $bridge 'config.example.json') $configPath
}
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not $cfg.accessToken) {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $cfg | Add-Member -NotePropertyName accessToken -NotePropertyValue $token -Force
  $cfg | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding utf8
  Info "Generated a new access token in bridge\config.json"
}
$port = if ($cfg.port) { [int]$cfg.port } else { 8787 }
if (-not $Model -and $cfg.model) { $Model = $cfg.model }
if (-not $ContextLength -and $cfg.contextLength) { $ContextLength = [int]$cfg.contextLength }
# Extra lms load arguments. With no -ContextLength, LM Studio's saved settings for the model apply.
$loadArgs = @('-y')
if ($ContextLength) {
  $loadArgs += @('--context-length', "$ContextLength")
  # Tell the bridge too, so it keeps the model at or below this size.
  $env:BRIDGE_CONTEXT_LENGTH = "$ContextLength"
}
$ctxLabel = if ($ContextLength) { "context $ContextLength" } else { "LM Studio's saved settings" }

# 1. LM Studio server
Info "Starting LM Studio server"
& lms server start 2>&1 | Out-Host

# 2. Make sure a model is loaded
$loaded = @()
try {
  $models = (Invoke-RestMethod -Uri 'http://127.0.0.1:1234/api/v0/models' -TimeoutSec 10).data
  $loaded = @($models | Where-Object { $_.state -eq 'loaded' -and $_.type -ne 'embeddings' } | ForEach-Object { $_.id })
} catch { Write-Warning "Could not query LM Studio models: $($_.Exception.Message)" }

if ($Model -and ($loaded -notcontains $Model)) {
  Info "Loading $Model ($ctxLabel)"
  & lms load $Model @loadArgs 2>&1 | Out-Host
} elseif (-not $loaded.Count) {
  Info "No model loaded. Loading the first one LM Studio offers (pass -Model to choose)"
  $first = ($models | Where-Object { $_.type -ne 'embeddings' } | Select-Object -First 1).id
  if ($first) { & lms load $first @loadArgs 2>&1 | Out-Host }
  else { Write-Warning "No models downloaded in LM Studio." }
} else {
  Info "Model already loaded: $($loaded -join ', ')"
}

# 3. Public URL via Tailscale Funnel
if (-not $NoFunnel) {
  Info "Exposing bridge port $port with Tailscale Funnel"
  & tailscale funnel --bg $port 2>&1 | Out-Host
  $dns = ((& tailscale status --json) | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
  $publicUrl = "https://$dns"
  Write-Host ""
  Write-Host "Public bridge URL: $publicUrl" -ForegroundColor Green
  Write-Host "Access token:      $($cfg.accessToken)" -ForegroundColor Green
  if ($cfg.siteUrl) {
    Write-Host "One-click link:    $($cfg.siteUrl)#bridge=$([uri]::EscapeDataString($publicUrl))&token=$([uri]::EscapeDataString($cfg.accessToken))" -ForegroundColor Green
  }
  Write-Host "(Stop public access later with: tailscale funnel --https=443 off)"
  Write-Host ""
}

# 4. Bridge (foreground)
Info "Starting bridge (Ctrl+C to stop)"
& node (Join-Path $bridge 'server.js')
