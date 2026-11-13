<#
  claude-local.ps1 - start Claude Code using the local model on your PC (LM Studio, through the bridge).

  The first run asks for the bridge address and access token and saves them to
  %APPDATA%\claude-local\config.json. Your normal `claude` command is not changed:
  everything is set only for this one Claude Code session.

  Usage (anything the script doesn't recognise is passed to claude as is):
    claude-local                         interactive Claude Code, core coding tools only
    claude-local -p "fix the failing test"
    claude-local --continue
    claude-local --all-tools             every Claude Code tool (~16k tokens of setup instead of ~4.4k)
    claude-local --context 32768         tell Claude Code a smaller context than the loaded model's
    claude-local --max-output 12000      longest reply, thinking included (default 8192)
    claude-local --setup                 change the saved address or token

  If PowerShell blocks the script, run claude-local.cmd instead, or:
    powershell -ExecutionPolicy Bypass -File claude-local.ps1
#>

$ErrorActionPreference = 'Stop'
$cfgDir = Join-Path $env:APPDATA 'claude-local'
$cfgFile = Join-Path $cfgDir 'config.json'
$coreTools = 'Bash,Edit,Glob,Grep,Read,Write'

# --- our own options (double-dash, so they never clash with claude's short flags) ---
$setup = $false; $allTools = $false; $context = 0; $maxOutput = 8192
$pass = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '--setup'      { $setup = $true }
    '--all-tools'  { $allTools = $true }
    '--context'    { $i++; $context = [int]$args[$i] }
    '--max-output' { $i++; $maxOutput = [int]$args[$i] }
    default        { $pass.Add([string]$args[$i]) }
  }
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "Claude Code isn't installed. Install it from https://claude.com/claude-code first." -ForegroundColor Red
  exit 1
}

# --- saved settings ---
$cfg = $null
if ((Test-Path $cfgFile) -and -not $setup) { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json }
if (-not $cfg) {
  $default = 'http://127.0.0.1:8787'
  try { Invoke-RestMethod "$default/health" -TimeoutSec 2 | Out-Null } catch { $default = '' }
  Write-Host "Set up claude-local" -ForegroundColor Cyan
  $prompt = if ($default) { "Bridge address [$default]" } else { 'Bridge address (e.g. https://your-pc.your-tailnet.ts.net)' }
  $url = Read-Host $prompt
  if (-not $url) { $url = $default }
  $secure = Read-Host 'Access token (from bridge\config.json)' -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  $cfg = [pscustomobject]@{ bridge = $url.TrimEnd('/'); token = $token }
  New-Item -ItemType Directory -Force $cfgDir | Out-Null
  $cfg | ConvertTo-Json | Set-Content $cfgFile -Encoding utf8
  Write-Host "Saved to $cfgFile" -ForegroundColor Green
}
$bridge = $cfg.bridge.TrimEnd('/')

# --- ask the bridge which model is loaded and how big its context is ---
Write-Host "Connecting to $bridge ..." -ForegroundColor DarkGray
try {
  $info = Invoke-RestMethod "$bridge/api/claude-code?load=1" -Headers @{ Authorization = "Bearer $($cfg.token)" } -TimeoutSec 240
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 401) { Write-Host 'The bridge rejected the access token. Run: claude-local --setup' -ForegroundColor Red }
  else { Write-Host "Couldn't reach the bridge at $bridge. Is the PC on and start.ps1 running? ($($_.Exception.Message))" -ForegroundColor Red }
  exit 1
}
$model = ''; $ctx = 0
foreach ($line in ($info -split "`n")) {
  if ($line -match '^MODEL=(.*)$') { $model = $Matches[1].Trim() }
  if ($line -match '^CONTEXT=(\d+)') { $ctx = [int]$Matches[1] }
}
if (-not $model) { Write-Host 'The bridge has no model available in LM Studio.' -ForegroundColor Red; exit 1 }
if ($context) { $ctx = $context }
if (-not $ctx) { $ctx = 32768; Write-Host "Couldn't read the model's context size; assuming $ctx." -ForegroundColor Yellow }

# --- point this Claude Code session at the bridge ---
$env:ANTHROPIC_BASE_URL = $bridge
$env:ANTHROPIC_AUTH_TOKEN = $cfg.token
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
foreach ($v in 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
               'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL') {
  Set-Item "Env:$v" $model
}
# The model's real context window, so auto-compact happens before it overflows.
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "$ctx"
# Claude Code keeps room for one full reply plus ~13k free before it compacts, so a smaller
# reply cap leaves more room for work: 8192 -> compacts at about ctx - 21k (34k of 55k).
$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = "$maxOutput"
if ($ctx - $maxOutput - 13000 -lt 10000) {
  Write-Host ("A {0:N0}-token context leaves Claude Code almost no room before it compacts. It works best with 32k or more." -f $ctx) -ForegroundColor Yellow
}
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

$toolArgs = if ($allTools) { @() } else { @('--tools', $coreTools) }
Write-Host ("Claude Code -> {0} ({1:N0}-token context{2})" -f $model, $ctx, $(if ($allTools) { ', all tools' } else { ', core tools' })) -ForegroundColor Cyan
& claude @toolArgs @pass
exit $LASTEXITCODE
