param(
  [switch]$NoStart
)
# install-watchdog.ps1 -- register the heartbeat watchdog as a per-user logon autostart.
# ★ FIX-38: the watchdog only NOTIFIES on abnormal service exit (never restarts it).
# Creates/overwrites the shortcut CodeBuddyQQWatchdog.lnk in the Startup folder (no admin needed).
# ASCII-only; project root derived from $PSScriptRoot.
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$startPs1 = Join-Path $proj 'tools\qqbot\start-watchdog.ps1'
$workDir = Join-Path $proj 'tools\qqbot'
$startup = [System.Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CodeBuddyQQWatchdog.lnk'

if (-not (Test-Path $startPs1)) { Write-Host "missing: $startPs1"; exit 1 }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startPs1`""
$sc.WorkingDirectory = $workDir
$sc.Description = 'CodeBuddy QQ service heartbeat watchdog (notify-only)'
$sc.Save()
Write-Host "autostart registered: $lnk"

if (-not $NoStart) {
  Start-Process -FilePath powershell.exe `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startPs1`"" `
    -WindowStyle Hidden
  Write-Host 'watchdog launch requested'
}
Write-Host "log: $workDir\watchdog.log"
Write-Host "uninstall autostart: delete the shortcut above"
