# start-hub.ps1 -- launch the session-hub server in background.
# ASCII-only on purpose.
#
# Instance dir = where this script lives. session-hub is a SHARED-INSTANCE component:
# it is NOT inside a project tree; it serves N projects listed in
# hub.config.json -> projects[]. There is no parent-of-parent project derivation.
#
# Idempotent: skips the launch when something already LISTENs on the configured port.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File start-hub.ps1
$ErrorActionPreference = 'Continue'
$hub = $PSScriptRoot
$svc = Join-Path $hub 'server.js'
if (-not (Test-Path $svc)) { Write-Host ('server not found: ' + $svc); exit 1 }

$cfgFile = Join-Path $hub 'hub.config.json'
$port = 18766
if (Test-Path $cfgFile) {
  try {
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
  } catch {}
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($c in @('C:\nvm4w\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'nvm4w\nodejs\node.exe'))) {
    if (Test-Path $c) { $nodeExe = $c; break }
  }
}
if (-not $nodeExe) { Write-Host 'node not found (install Node or add it to PATH)'; exit 1 }

# guard: skip if an instance is already listening.
# The old GCI wildcard (*session-hub*server.js*) cannot match the instance dir
# (%LOCALAPPDATA%\codebuddy-hub), so probe the PORT instead -- same criterion as stop-hub.ps1.
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Host ('already running on port ' + $port + ' (pid ' + [int]$conn.OwningProcess + ') -- skip start')
  exit 0
}

Start-Process -FilePath $nodeExe -ArgumentList @($svc) -WorkingDirectory $hub -WindowStyle Hidden
Write-Host ('session-hub launched (node: ' + $nodeExe + ', dir: ' + $hub + ')')
Write-Host ('health: http://127.0.0.1:' + $port + '/health')
Write-Host ('ui:     http://127.0.0.1:' + $port + '/')
