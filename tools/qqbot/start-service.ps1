param(
  [int]$IdleSeconds = 0,
  [string]$ExtraArgs = '',
  # D-5 escape hatch: force a start even when a qqbot-service.js process with NO path in
  # its command line exists (owner unknown). Default is "rather start nothing than twice".
  [switch]$AllowUnscoped
)
# start-service.ps1 -- launch the merged QQ service (watcher + confirm) in background.
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
# Project root is derived from $PSScriptRoot (never a CJK literal).
#
# P1 multi-project isolation (2026-11-17). Three changes vs the single-instance version:
#   1. the "already running" guard is scoped to THIS project's <qaDir>\qqbot-service.js
#      (the old '*qqbot-service.js*' wildcard also matched another project's service);
#   2. two fail-closed gates run before anything is spawned: env credentials (exit 3) and
#      port ownership (exit 4). qqbot-service.js only logs EADDRINUSE and keeps running,
#      which produces a WS double-login plus duplicated pushes (qqbot-watchdog.js:13-14),
#      so the check has to happen here -- service.js is deliberately untouched;
#   3. the service is started with an absolute script path plus a per-project instance tag
#      so the watchdog can scope its own process match (see _qqbot-common.ps1).
$ErrorActionPreference = 'Continue'
$qaDir = $PSScriptRoot
$proj = Split-Path (Split-Path $qaDir -Parent) -Parent
$svc = Join-Path $qaDir 'qqbot-service.js'
$workDir = $qaDir

$common = Join-Path $qaDir '_qqbot-common.ps1'
if (-not (Test-Path -LiteralPath $common)) {
  Write-Host "FATAL: missing shared helper: $common" -ForegroundColor Red
  exit 1
}
. $common

if (-not (Test-Path $svc)) { Write-Host "service not found: $svc"; exit 1 }

$port = Get-QqbotListenPort $qaDir

# ---- gate 1: env credentials (fail-closed, D-4) --------------------------------
$hits = @(Get-QqbotEnvCredHits)
if ($hits.Count -gt 0) {
  if ($env:QQBOT_ALLOW_ENV_CREDS -eq '1') {
    Write-Host ('[WARN] env creds allowed by switch: ' + ($hits -join ', ')) -ForegroundColor Yellow
  } else {
    Write-Host ('[FATAL] env creds detected: ' + ($hits -join ', ')) -ForegroundColor Red
    Write-Host 'Fix: remove user/machine-level QQ_BOT_* (credentials must come from qqbot.creds.json)'
    Write-Host 'Escape hatch (temporary): set QQBOT_ALLOW_ENV_CREDS=1'
    exit 3
  }
}

# ---- gate 2: port ownership (exit 4) -----------------------------------------
# A listener belonging to THIS project is not a conflict: report and stop cleanly so the
# autostart carriers stay harmless on a second logon.
$ownerPid = Get-QqbotPortOwnerPid $port
if ($ownerPid -gt 0) {
  $ownerCmd = Get-QqbotProcCommandLine $ownerPid
  $ownKey = (ConvertTo-PathKey $qaDir) + '\qqbot-service.js'
  if ($ownerCmd -and (ConvertTo-PathKey $ownerCmd).Contains($ownKey)) {
    Write-Host "already running: pid $ownerPid (listening on $port) (skip start)"
    exit 0
  }
  Write-Host ("[FATAL] port $port is already LISTENING by pid $ownerPid which is NOT this project") -ForegroundColor Red
  Write-Host 'Refusing to start: EADDRINUSE does not stop qqbot-service.js, it would keep running'
  Write-Host 'and fight for the port (WS double-login + duplicated QQ pushes).'
  Write-Host ('Owner command line: ' + $ownerCmd)
  Write-Host 'Fix: change listenPort in daemon.config.json, or stop the other instance.'
  exit 4
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($c in @('C:\nvm4w\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'nvm4w\nodejs\node.exe'))) {
    if (Test-Path $c) { $nodeExe = $c; break }
  }
}
if (-not $nodeExe) { Write-Host 'node not found (install Node or add it to PATH)'; exit 1 }

# P3 hardening (2026-10-05): missing 'ws' used to cause a silent half-dead service
# (HTTP + QQ both down while heartbeat kept running, so the watchdog never alerted).
# Fail fast at launch instead. Node resolves 'ws' from cwd upward, so probe from $workDir.
Push-Location $workDir
& $nodeExe -e "require('ws')" 2>$null
$wsProbe = $LASTEXITCODE
Pop-Location
if ($wsProbe -ne 0) {
  Write-Host "FATAL: dependency 'ws' is not resolvable from $workDir" -ForegroundColor Red
  Write-Host "Fix: run 'npm install ws' in the project root (or in tools\qqbot), then retry." -ForegroundColor Red
  exit 1
}

# ---- guard: scoped "already running" ----------------------------------------
# FIX-33 (2026-09-19): the Name filter stays -- without it a powershell wrapper whose
#   command line merely mentions the script name counts as an instance and the restart is
#   silently skipped. That incident is why the match is name+command-line, and P1 adds the
#   path scope on top.
$procs = Get-QqbotProcs $qaDir 'qqbot-service.js'
if ($procs.Scoped.Count -gt 0) {
  $pids = ($procs.Scoped | ForEach-Object { $_.ProcessId }) -join ','
  Write-Host "already running: pid $pids (skip start)"
  exit 0
}
if ($procs.Foreign.Count -gt 0) {
  Write-Host ('note: ' + $procs.Foreign.Count + ' qqbot-service.js process(es) belong to other projects (ignored)')
}
if ($procs.Unscoped.Count -gt 0) {
  Write-Host '[WARN] qqbot-service.js process(es) found whose command line carries no project path:' -ForegroundColor Yellow
  foreach ($d in $procs.UnscopedDetail) { Write-Host ('       ' + $d) -ForegroundColor Yellow }
  if (-not $AllowUnscoped) {
    Write-Host 'Skipping start: ownership unknown (a second instance could double-login the bot).'
    Write-Host 'If you are sure those processes are gone/foreign, re-run with -AllowUnscoped.'
    exit 0
  }
  Write-Host '[WARN] continuing because -AllowUnscoped was given' -ForegroundColor Yellow
}

$argList = @($svc)
$tag = Get-QqbotInstanceTag $qaDir
if ($tag) { $argList += $tag }
if ($IdleSeconds -gt 0) { $argList += @('--idle', "$IdleSeconds") }
if ($ExtraArgs) { $argList += $ExtraArgs.Split(' ') }

Start-Process -FilePath $nodeExe -ArgumentList $argList -WorkingDirectory $workDir -WindowStyle Hidden
Write-Host "qqbot-service launched (node: $nodeExe)"
Write-Host "log: $workDir\service.log"
Write-Host "health: http://127.0.0.1:$port/health"
