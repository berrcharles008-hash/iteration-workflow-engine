# start-serve.ps1 -- idempotent launcher for a project's `codebuddy serve` instance.
# ★ 2026-11-18: multi-project. The target project and its port come from
#   hub.config.json -> projects[].root / projects[].serve.port.
#   Usage: start-serve.ps1 [-Project 0003] [-NoWait]
# - Probes the port first; skips spawn when already alive (safe for logon autostart).
# - Upserts <root>/tools/qqbot/runtime/serve-instance.json (pid/port/tier/startedAt),
#   so the project's qqbot recycler and the hub "Web UI" link keep working.
# ASCII-only on purpose; no CJK literals.
param(
  [string]$Project = '',
  [switch]$NoWait
)
$ErrorActionPreference = 'Continue'
$hub = $PSScriptRoot
$cfgFile = Join-Path $hub 'hub.config.json'
if (-not (Test-Path $cfgFile)) { Write-Host ('missing: ' + $cfgFile); exit 1 }

$cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$pidWanted = $Project
if (-not $pidWanted) { $pidWanted = [string]$cfg.default }
$proj = $null
foreach ($p in $cfg.projects) { if ([string]$p.id -eq $pidWanted) { $proj = $p; break } }
if (-not $proj) {
  Write-Host ('project not found in config: ' + $pidWanted)
  Write-Host ('available: ' + (($cfg.projects | ForEach-Object { $_.id }) -join ', '))
  exit 1
}

$projRoot = [string]$proj.root
$port = 19000
if ($proj.serve -and $proj.serve.port) { $port = [int]$proj.serve.port }
$runtimeDir = Join-Path $projRoot 'tools\qqbot\runtime'
$instFile = Join-Path $runtimeDir 'serve-instance.json'

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($c in @('C:\nvm4w\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'nvm4w\nodejs\node.exe'))) {
    if (Test-Path $c) { $nodeExe = $c; break }
  }
}
if (-not $nodeExe) { Write-Host 'node not found (install Node or add it to PATH)'; exit 1 }

# Portability: the CLI entry path differs per install (nvm4w / npm global / custom).
# Override with CODEBUDDY_ENTRY=<.../node_modules/@tencent-ai/codebuddy-code/bin/codebuddy>.
$entry = 'C:\nvm4w\nodejs\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy'
if ($env:CODEBUDDY_ENTRY) { $entry = $env:CODEBUDDY_ENTRY }
if (-not (Test-Path $entry)) {
  Write-Host ('codebuddy entry not found: ' + $entry + ' (set CODEBUDDY_ENTRY to override)')
  exit 1
}

function Get-ServePid {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return [int]$conn.OwningProcess }
  return 0
}

function Upsert-Instance([int]$sPid) {
  if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null }
  $inst = [ordered]@{
    pid = $sPid
    port = $port
    tier = 'A'
    project = [string]$proj.id
    startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    lastUsedAt = $null
    restartCount = 0
  }
  $inst | ConvertTo-Json | Out-File -FilePath $instFile -Encoding ascii -Force
  Write-Host ('serve-instance.json upserted (pid ' + $sPid + ', project ' + $proj.id + ')')
}

$alivePid = Get-ServePid
if ($alivePid -gt 0) {
  Write-Host ('serve already alive on port ' + $port + ' (pid ' + $alivePid + ') -- skip spawn')
  Upsert-Instance $alivePid
  exit 0
}

Start-Process -FilePath $nodeExe `
  -ArgumentList @($entry, '--serve', '--port', "$port", '--auth', 'password', '--permission-mode', 'acceptEdits') `
  -WorkingDirectory $projRoot -WindowStyle Hidden
Write-Host ('serve spawn requested (project ' + $proj.id + ', port ' + $port + ', node: ' + $nodeExe + ')')

if ($NoWait) { exit 0 }

$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  $alivePid = Get-ServePid
  if ($alivePid -gt 0) { $ok = $true; break }
}
if ($ok) {
  Write-Host ('serve listening (pid ' + $alivePid + ')')
  Upsert-Instance $alivePid
} else {
  Write-Host ('serve did not open port ' + $port + ' within 30s (check codebuddy install)')
  exit 1
}
