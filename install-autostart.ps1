<#
  install-autostart.ps1 - start the bridge automatically when you log in to Windows.

    .\install-autostart.ps1            create (or update) the "Local LLM bridge" task and start it now
    .\install-autostart.ps1 -Remove    remove the task and stop the bridge

  The task runs autostart.ps1 hidden, in your own account, at every login. It doesn't need
  administrator rights. To stop the bridge without removing the task: .\stop-bridge.ps1
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'Local LLM bridge'
$root = $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  & (Join-Path $root 'stop-bridge.ps1')
  Write-Host "Removed the '$name' task." -ForegroundColor Green
  exit 0
}

$script = Join-Path $root 'autostart.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $root
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Every 5 minutes as well: while the bridge runs, these are skipped (IgnoreNew); if it has ended
# for any reason, the next one starts it again.
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atLogon, $every5) -Settings $settings -Principal $principal `
  -Description 'Starts LM Studio''s server, Tailscale Funnel and the Local LLM bridge (autostart.ps1).' -Force | Out-Null
Write-Host "Created the '$name' task: the bridge now starts when you log in." -ForegroundColor Green

Start-ScheduledTask -TaskName $name
Write-Host "Started it now. Log: $(Join-Path $root 'bridge\logs')" -ForegroundColor Green
