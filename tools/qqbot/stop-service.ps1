param(
  [int]$TimeoutSec = 12,
  [string]$Reason = 'manual-stop'
)
# stop-service.ps1 -- graceful stop of THIS project's merged QQ service.
# 1) POST /shutdown  -> service sends the "offline" notice to QQ, writes stoppedAt, exits
# 2) wait up to $TimeoutSec; if still alive -> Stop-Process -Force (hard kill => no offline
#    notice; the watchdog will report it as an abnormal exit)
#
# P1 multi-project isolation (2026-11-17): the port now comes from daemon.config.json and
# every process match is scoped to <qaDir>\qqbot-service.js. The old version hardcoded
# 18765 and killed '*qqbot-service.js*' globally, i.e. stopping project A also stopped
# project B (pain point #3). Foreign processes are printed, never killed.
#
# ASCII-only output; project root derived from $PSScriptRoot.
$ErrorActionPreference = 'Continue'
$qaDir = $PSScriptRoot
. (Join-Path $qaDir '_qqbot-common.ps1')

$port = Get-QqbotListenPort $qaDir

$procs = Get-QqbotProcs $qaDir 'qqbot-service.js'
if ($procs.Scoped.Count -eq 0) {
  Write-Host 'no service process for this project (nothing to stop)'
  foreach ($d in $procs.UnscopedDetail) { Write-Host ('  [not this project, not touched] ' + $d) }
  exit 0
}

try {
  $uri = 'http://127.0.0.1:' + $port + '/shutdown?reason=' + [System.Uri]::EscapeDataString($Reason)
  $r = Invoke-RestMethod -Method POST -Uri $uri -TimeoutSec 5
  Write-Host ('shutdown requested: ' + ($r | ConvertTo-Json -Compress))
} catch {
  Write-Host ('POST /shutdown failed (service not answering on ' + $port + '): ' + $_.Exception.Message)
}

for ($i = 1; $i -le $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  $procs = Get-QqbotProcs $qaDir 'qqbot-service.js'
  if ($procs.Scoped.Count -eq 0) {
    Write-Host ('service stopped gracefully after ' + $i + 's')
    exit 0
  }
}

$procs = Get-QqbotProcs $qaDir 'qqbot-service.js'
foreach ($x in $procs.Scoped) {
  Stop-Process -Id $x.ProcessId -Force
  Write-Host ('force-killed pid ' + $x.ProcessId + ' (no offline notice; watchdog will flag it)')
}
foreach ($d in $procs.UnscopedDetail) { Write-Host ('  [not this project, not touched] ' + $d) }
exit 0
