<#
  stop-bridge.ps1 - stop the bridge started by the login task (and its Claude Code host).
  It starts again at the next login, or with: Start-ScheduledTask -TaskName 'Local LLM bridge'
#>
Stop-ScheduledTask -TaskName 'Local LLM bridge' -ErrorAction SilentlyContinue
# The task's PowerShell window may leave the bridge running, so stop it by what it runs.
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'bridge[\\/]server\.js') -or
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'autostart\.ps1|start\.ps1.*-KeepRunning')
}
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Stopped $(@($procs).Count) process(es)." -ForegroundColor Green
