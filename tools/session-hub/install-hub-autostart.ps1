# install-hub-autostart.ps1 -- register the multi-project session-hub as a per-user logon autostart.
# Creates/overwrites the shortcut CodeBuddySessionHub.lnk in the Startup folder (no admin needed).
# ★ 2026-11-18: hub moved to %LOCALAPPDATA%\codebuddy-hub -- the shortcut now points at
#   this directory's start-hub.ps1 (no parent-of-parent project derivation). ASCII-only.
param(
  [switch]$NoStart
)
$ErrorActionPreference = 'Continue'
$hub = $PSScriptRoot
$startPs1 = Join-Path $hub 'start-hub.ps1'
$startup = [System.Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CodeBuddySessionHub.lnk'

if (-not (Test-Path $startPs1)) { Write-Host ('missing: ' + $startPs1); exit 1 }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startPs1`""
$sc.WorkingDirectory = $hub
$sc.Description = 'CodeBuddy session-hub (multi-project, port 18766)'
$sc.Save()
Write-Host ('autostart registered: ' + $lnk)

if (-not $NoStart) {
  Start-Process -FilePath powershell.exe `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startPs1`"" `
    -WindowStyle Hidden
  Write-Host 'hub launch requested'
}
Write-Host 'uninstall autostart: delete the shortcut above'
