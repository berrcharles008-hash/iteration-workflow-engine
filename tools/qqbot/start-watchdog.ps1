param(
  # D-5 escape hatch: start even when a qqbot-watchdog.js process with NO path in its
  # command line exists (owner unknown). Default = rather start nothing than twice.
  [switch]$AllowUnscoped
)
# start-watchdog.ps1 -- start the heartbeat watchdog in the background (skip if running).
# FIX-38: the watchdog used to only NOTIFY (never restarted the service).
# TOOL-SELFHEAL: it probes <listenPort>/health and auto-restarts ONLY when no service
#   process exists; a half-dead process (alive but port dead) is alert-only, never killed.
#
# P1 multi-project isolation (2026-11-17). Two defects fixed here:
#   1. the guard matched '*qqbot-watchdog.js*' for every project on the host;
#   2. the process was started as `node qqbot-watchdog.js` (relative name), so its own
#      command line carried NO path. Any path-scoped rule therefore judged the live
#      watchdog as "owner unknown" and started a second one on every logon (03 tech plan
#      F2). It is now launched by absolute path.
# The watchdog itself is deliberately NOT modified: it already accepts QQBOT_WD_PORT and
# QQBOT_WD_PROC_MATCH, so the launcher passes them instead.
#
# ASCII-only; project root derived from $PSScriptRoot.
$ErrorActionPreference = 'Continue'
$qaDir = $PSScriptRoot
. (Join-Path $qaDir '_qqbot-common.ps1')

$wd = Join-Path $qaDir 'qqbot-watchdog.js'
if (-not (Test-Path -LiteralPath $wd)) { Write-Host "watchdog not found: $wd"; exit 1 }

$port = Get-QqbotListenPort $qaDir
$tag = Get-QqbotInstanceTag $qaDir

$procs = Get-QqbotProcs $qaDir 'qqbot-watchdog.js'
if ($procs.Scoped.Count -gt 0) {
  Write-Host ('watchdog already running pid ' + $procs.Scoped[0].ProcessId)
  exit 0
}
if ($procs.Foreign.Count -gt 0) {
  Write-Host ('note: ' + $procs.Foreign.Count + ' qqbot-watchdog.js process(es) belong to other projects (ignored)')
}
if ($procs.Unscoped.Count -gt 0) {
  Write-Host '[WARN] qqbot-watchdog.js process(es) without a project path in the command line:' -ForegroundColor Yellow
  foreach ($d in $procs.UnscopedDetail) { Write-Host ('       ' + $d) -ForegroundColor Yellow }
  if (-not $AllowUnscoped) {
    Write-Host 'Skipping start: ownership unknown (starting another one would double-heal the service).'
    Write-Host 'Restart it once via this script after killing the old process, or re-run with -AllowUnscoped.'
    exit 0
  }
  Write-Host '[WARN] continuing because -AllowUnscoped was given' -ForegroundColor Yellow
}

# Migration hint (03 tech plan 2.5 step 3): a service started BEFORE this change carries
# no instance tag. The watchdog scopes its process match to the tag, so it would see
# "no service" and try to restart it forever. Restart the service once after deploying.
$svcProcs = Get-QqbotProcs $qaDir 'qqbot-service.js'
if ($tag -and $svcProcs.Scoped.Count -gt 0) {
  $untagged = @($svcProcs.Scoped | Where-Object { -not ([string]$_.CommandLine).Contains($tag) })
  if ($untagged.Count -gt 0) {
    Write-Host '[WARN] running service has no instance tag (started before the P1 change).' -ForegroundColor Yellow
    Write-Host '       Restart it (stop-service.ps1 then start-service.ps1) or the watchdog will'
    Write-Host '       consider the service dead and keep asking to restart it.'
  }
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($c in @('C:\nvm4w\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'nvm4w\nodejs\node.exe'))) {
    if (Test-Path $c) { $nodeExe = $c; break }
  }
}
if (-not $nodeExe) { $nodeExe = 'node' }

# Child inherits these two variables. QQBOT_WD_PROC_MATCH must stay inside [\w.-] because
# the watchdog strips everything else before building its -like pattern.
if ($tag) { $env:QQBOT_WD_PROC_MATCH = $tag }
$env:QQBOT_WD_PORT = "$port"

Start-Process -FilePath $nodeExe -ArgumentList @($wd) -WorkingDirectory $qaDir -WindowStyle Hidden
Write-Host ('watchdog launch requested (port ' + $port + ', match "' + $env:QQBOT_WD_PROC_MATCH + '")')
Write-Host ('log: ' + (Join-Path $qaDir 'watchdog.log'))
