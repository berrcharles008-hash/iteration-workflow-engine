param(
  [int]$TimeoutSec = 12,
  [string]$Reason = 'manual-stop'
)
# stop-service.ps1 -- graceful stop of the merged QQ service (★ FIX-38).
# 1) POST /shutdown  -> service sends the "offline" notice to QQ, writes stoppedAt, exits
# 2) wait up to $TimeoutSec; if still alive -> Stop-Process -Force (hard kill => no offline notice;
#    the watchdog will report it as an abnormal exit)
# ASCII-only output; project root derived from $PSScriptRoot.
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$proj = Split-Path (Split-Path $dir -Parent) -Parent

try {
  $uri = 'http://127.0.0.1:18765/shutdown?reason=' + [System.Uri]::EscapeDataString($Reason)
  $r = Invoke-RestMethod -Method POST -Uri $uri -TimeoutSec 5
  Write-Host ('shutdown requested: ' + ($r | ConvertTo-Json -Compress))
} catch {
  Write-Host ('POST /shutdown failed (service not running?): ' + $_.Exception.Message)
}

for ($i = 1; $i -le $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  $p = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*qqbot-service.js*' })
  if ($p.Count -eq 0) { Write-Host ('service stopped gracefully after ' + $i + 's'); exit 0 }
}

$p = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*qqbot-service.js*' })
foreach ($x in $p) {
  Stop-Process -Id $x.ProcessId -Force
  Write-Host ('force-killed pid ' + $x.ProcessId + ' (no offline notice; watchdog will flag it)')
}
exit 0
