param(
  [int]$IdleSeconds = 30,
  [switch]$Force
)
# install-watcher.ps1 -- LEGACY installer for notify-watcher.ps1 (one-way IDE->QQ notify).
# Superseded by the merged service (qqbot-service.js). Kept only as a manual escape hatch.
# Uses the Startup folder shortcut (no admin needed), NOT a Scheduled Task (which needs
# elevation on this machine). Launches the watcher hidden immediately too.
# NOTE: ASCII-only; project root derived from $PSScriptRoot.
#
# ★ 2026-10-23 REGRESSION GUARD (why this file now refuses to run by default)
#   This script and install-service.ps1 write the SAME shortcut name
#   (Startup\CodeBuddyQQWatcher.lnk) with DIFFERENT targets:
#     - install-service.ps1 -> start-service.ps1 -> qqbot-service.js  (merged: QQ socket + idle push)
#     - install-watcher.ps1 -> notify-watcher.ps1                     (legacy: one-way notify only)
#   Last writer wins, silently. Running this one downgrades logon autostart, so after a
#   reboot only notify-watcher + qqbot-watchdog come up; qqbot-service.js (the process
#   holding the QQ WebSocket) never starts. The symptom split is what makes it nasty:
#   outbound still works (watchdog [NOTIFY] HTTP 200, idle pushes fine) while INBOUND is
#   dead -- user replies hit the platform's "bot is offline, check its service config"
#   auto-reply, and 127.0.0.1:18765 never listens.
#   Happened for real: shortcut downgraded 2026-10-22 16:48 during a Startup-lnk restore,
#   found 2026-10-23 09:2x. Fix = run install-service.ps1 (stops legacy + overwrites the
#   same lnk + starts the service).
#   Guard failure mode: detection relies on the shortcut's Arguments string, so a shortcut
#   renamed by hand is invisible to it -- but then it no longer clobbers anything either.

$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$ps1 = Join-Path $proj 'tools\qqbot\notify-watcher.ps1'
$watchDir = Join-Path $proj 'tools\qqbot'
$startup = [System.Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CodeBuddyQQWatcher.lnk'
$ws = New-Object -ComObject WScript.Shell

# Does the merged service currently own that shortcut name?
$mergedRegistered = $false
if (Test-Path $lnk) {
  try {
    $curArgs = $ws.CreateShortcut($lnk).Arguments
    if ($curArgs -like '*start-service.ps1*') { $mergedRegistered = $true }
  } catch { }
}

if (-not $Force) {
  Write-Host '[DEPRECATED] install-watcher.ps1 is the LEGACY installer (notify-watcher.ps1).' -ForegroundColor Yellow
  Write-Host 'It writes Startup\CodeBuddyQQWatcher.lnk -- the SAME name install-service.ps1 uses'
  Write-Host 'for the merged service (qqbot-service.js). Last writer wins, so this silently'
  Write-Host 'downgrades autostart: after logon only notify-watcher + watchdog run, the QQ'
  Write-Host 'WebSocket never connects => outbound notify OK but inbound replies dead'
  Write-Host '(QQ answers "the bot is offline, check its service config"; port 18765 silent).'
  Write-Host ''
  Write-Host 'Use this instead:  powershell -File install-service.ps1'
  Write-Host 'Legacy on purpose: powershell -File install-watcher.ps1 -Force'
  exit 1
}

if ($mergedRegistered) {
  Write-Host 'REFUSED: the shortcut is already registered to the merged service.' -ForegroundColor Red
  Write-Host "  $lnk"
  Write-Host '  -> start-service.ps1 (qqbot-service.js)'
  Write-Host 'Overwriting it would leave a dead QQ socket. If you really want legacy,'
  Write-Host 'delete or rename that shortcut first, then re-run with -Force.'
  exit 2
}

$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1`" -IdleSeconds $IdleSeconds"
$sc.WorkingDirectory = $watchDir
$sc.Description = 'CodeBuddy IDE QQ notify watcher (LEGACY)'
$sc.Save()
Write-Host "Created startup shortcut: $lnk (runs at logon, no admin needed)"
Start-Process -FilePath powershell.exe -ArgumentList $sc.Arguments -WindowStyle Hidden
Write-Host "Watcher launched now. Log: $watchDir\watcher.log"
Write-Host "Remove autostart: delete the shortcut at $lnk"
