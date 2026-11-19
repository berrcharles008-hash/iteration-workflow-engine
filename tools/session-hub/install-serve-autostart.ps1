# install-serve-autostart.ps1 -- register the codebuddy serve as a per-user logon autostart.
# Creates/overwrites the shortcut CodeBuddyServe.lnk in the Startup folder (no admin needed).
# Modeled on install-hub-autostart.ps1. ASCII-only.
param(
  [switch]$NoStart
)
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$startPs1 = Join-Path $proj 'tools\session-hub\start-serve.ps1'
$workDir = Join-Path $proj 'tools\session-hub'
$startup = [System.Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CodeBuddyServe.lnk'

if (-not (Test-Path $startPs1)) { Write-Host "missing: $startPs1"; exit 1 }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startPs1`""
$sc.WorkingDirectory = $workDir
$sc.Description = 'CodeBuddy serve (port 19000, idempotent)'
$sc.Save()
Write-Host "autostart registered: $lnk"

if (-not $NoStart) {
  Start-Process -FilePath powershell.exe `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startPs1`"" `
    -WindowStyle Hidden
  Write-Host 'serve launch requested (idempotent: skips if already alive)'
}
Write-Host 'uninstall autostart: delete the shortcut above'
