# stop-hub.ps1 -- graceful stop of the multi-project session-hub.
# 1) POST /shutdown (loopback-only) -> server flushes audit and exits
# 2) wait up to $TimeoutSec; if still alive -> force-kill the process owning the port
# ★ 2026-11-18: process match by PORT OWNER (the hub no longer lives under a
#   path containing "session-hub"; the old *session-hub*server.js* wildcard would
#   miss %LOCALAPPDATA%\codebuddy-hub\server.js).
# ASCII-only output.
param(
  [int]$TimeoutSec = 8,
  [string]$Reason = 'manual-stop'
)
$ErrorActionPreference = 'Continue'
$hub = $PSScriptRoot
$port = 18766
$cfgFile = Join-Path $hub 'hub.config.json'
if (Test-Path $cfgFile) {
  try {
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
  } catch {}
}

function Get-HubPid {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}

$pid0 = Get-HubPid
if (-not $pid0) { Write-Host ('nothing listening on ' + $port + ' -- already stopped'); exit 0 }

try {
  $uri = 'http://127.0.0.1:' + $port + '/shutdown?reason=' + [System.Uri]::EscapeDataString($Reason)
  $r = Invoke-RestMethod -Method POST -Uri $uri -TimeoutSec 5
  Write-Host ('shutdown requested: ' + ($r | ConvertTo-Json -Compress))
} catch {
  Write-Host ('POST /shutdown failed: ' + $_.Exception.Message)
}

for ($i = 1; $i -le $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  if (-not (Get-HubPid)) { Write-Host ('session-hub stopped gracefully after ' + $i + 's'); exit 0 }
}

$pid1 = Get-HubPid
if ($pid1) {
  Stop-Process -Id $pid1 -Force
  Write-Host ('force-killed pid ' + $pid1)
}
exit 0
