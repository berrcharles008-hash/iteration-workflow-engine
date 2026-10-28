# start-watchdog.ps1 -- start the heartbeat watchdog in the background (skip if already running).
# ★ FIX-38: watchdog used to only NOTIFY (never restarted the service).
# ★ TOOL-SELFHEAL: it now probes :18765/health and auto-restarts ONLY when no service process
#   exists; a half-dead process (alive but port dead) is alert-only, never killed automatically.
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
