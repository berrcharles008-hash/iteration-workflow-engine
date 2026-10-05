# start-watchdog.ps1 -- start the heartbeat watchdog in the background (skip if already running).
# ★ FIX-38: watchdog only NOTIFIES (never restarts the service).
# ASCII-only; project root derived from $PSScriptRoot.
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot

$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*qqbot-watchdog.js*' })
if ($running.Count -gt 0) {
  Write-Host ('watchdog already running pid ' + $running[0].ProcessId)
  exit 0
}

Start-Process -FilePath 'node' -ArgumentList 'qqbot-watchdog.js' -WorkingDirectory $dir -WindowStyle Hidden
Write-Host 'watchdog launch requested'
Write-Host ('log: ' + (Join-Path $dir 'watchdog.log'))
