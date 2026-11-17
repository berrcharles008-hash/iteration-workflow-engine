param(
  # Baseline snapshot written by install-host.ps1 (step 2). Default = next to this script.
  [string]$Baseline = '',
  # Allow running without a baseline (accepts a degraded rollback: carriers are rebuilt,
  # but the "what existed before" check cannot be verified).
  [switch]$Force,
  [switch]$DryRun
)
# rollback-host.ps1 -- undo the host layer (tech plan 9).
#
# Steps: delete the host carrier set (name by name) -> rebuild the per-project carriers
# through the EXISTING installers (install-service.ps1 / install-watchdog.ps1 with
# -NoStart, so nothing is launched blindly) -> verify the legacy carriers exist and every
# registered project answers /health.
#
# This script deliberately contains no carrier-creation logic of its own. Duplicating the
# lnk / Run / task code here would drift from the two installers, and the failure mode of
# that drift is silent (the bot simply stops coming back after a logon).
#
# Exit codes (03 tech plan 4.2): 0 restored and verified / 1 rollback failed
#
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
$ErrorActionPreference = 'Continue'
$hostDir = $PSScriptRoot
$script:FailCount = 0
function Say([string]$m, [string]$c = '') { if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m } }
function Step([string]$n) { Write-Host ''; Write-Host "[$n]" -ForegroundColor Cyan }
function Ok([string]$m) { Say "  [OK]   $m" 'Green' }
function Skip([string]$m) { Say "  [SKIP] $m" 'DarkGray' }
function Warn([string]$m) { Say "  [WARN] $m" 'Yellow' }
function Bad([string]$m) { Say "  [FAIL] $m" 'Red'; $script:FailCount++ }

$common = Join-Path $hostDir '_qqbot-common.ps1'
if (-not (Test-Path -LiteralPath $common)) {
  Say ('FATAL: missing shared helper: ' + $common) 'Red'
  exit 1
}
. $common

$HostCarrier = 'CodeBuddyQQHost'
$LegacyLnk = 'CodeBuddyQQWatcher.lnk'
$LegacyRun = @('CodeBuddyQQService', 'CodeBuddyQQWatchdog')
$LegacyTask = @('CodeBuddyQQWatchdog')
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupDir = [System.Environment]::GetFolderPath('Startup')

if (-not $Baseline) { $Baseline = Join-Path $hostDir 'host-baseline.json' }
$manifest = Join-Path $hostDir 'hosts.json'

Say '============================================================' 'Cyan'
Say ' qqbot host layer rollback (rollback-host.ps1)' 'Cyan'
Say '============================================================' 'Cyan'
Say ('  host     : ' + $hostDir)
Say ('  baseline : ' + $Baseline)
if ($DryRun) { Say '  MODE     : DRY-RUN (nothing will be changed)' 'Yellow' }

# -- 0 baseline gate ---------------------------------------------------------------
Step '0/5 baseline'
$projects = @()
if (Test-Path -LiteralPath $manifest) {
  try {
    $doc = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($i in @($doc.instances)) { if ($i.project) { $projects += [string]$i.project } }
  } catch { Warn ('hosts.json is not valid JSON: ' + $_.Exception.Message) }
}
if ($projects.Count -eq 0) {
  Warn 'no project could be read from hosts.json -> the carriers will be rebuilt for the baseline project only'
}
if (-not (Test-Path -LiteralPath $Baseline)) {
  if (-not $Force) {
    Say '' 
    Say ('FATAL: baseline not found: ' + $Baseline) 'Red'
    Say 'Refusing to roll back blind: the baseline records which legacy carriers existed before'
    Say 'the migration, and that is the only way to prove the rollback restored them.'
    Say 'Options: (a) restore host-baseline.json;'
    Say '         (b) re-run with -Force to accept a degraded rollback (no existence check).'
    exit 1
  }
  Warn 'baseline missing but -Force given -> degraded rollback, existence check disabled'
} else {
  Ok ('baseline: ' + $Baseline)
}

# -- 1 delete host carriers -------------------------------------------------------
Step '1/5 remove host carriers'
$lnk = Join-Path $startupDir ($HostCarrier + '.lnk')
if (Test-Path -LiteralPath $lnk) {
  if ($DryRun) { Say ('  [dry] would delete ' + $lnk) } else {
    try { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop; Ok ('deleted ' + $lnk) }
    catch { Bad ('cannot delete ' + $lnk + ': ' + $_.Exception.Message) }
  }
} else { Skip ('no ' + $HostCarrier + '.lnk') }

$rv = ''
try { $rv = [string](Get-ItemProperty -Path $runKey -Name $HostCarrier -ErrorAction Stop).$HostCarrier } catch { $rv = '' }
if ($rv) {
  if ($DryRun) { Say ('  [dry] would delete Run value ' + $HostCarrier) } else {
    try { Remove-ItemProperty -Path $runKey -Name $HostCarrier -ErrorAction Stop; Ok ('deleted Run value ' + $HostCarrier) }
    catch { Bad ('cannot delete Run value ' + $HostCarrier + ': ' + $_.Exception.Message) }
  }
} else { Skip ('no Run value ' + $HostCarrier) }

$hasTask = $false
try { [void](Get-ScheduledTask -TaskName $HostCarrier -ErrorAction Stop); $hasTask = $true } catch { $hasTask = $false }
if ($hasTask) {
  if ($DryRun) { Say ('  [dry] would unregister task ' + $HostCarrier) } else {
    try { Unregister-ScheduledTask -TaskName $HostCarrier -Confirm:$false -ErrorAction Stop; Ok ('unregistered task ' + $HostCarrier) }
    catch { Bad ('cannot unregister task ' + $HostCarrier + ': ' + $_.Exception.Message) }
  }
} else { Skip ('no scheduled task ' + $HostCarrier) }

# -- 2 rebuild per-project carriers ----------------------------------------------
Step '2/5 rebuild legacy carriers per project'
if ($projects.Count -eq 0) {
  Warn 'no project known -> skipped (add an entry to hosts.json or rebuild manually)'
} else {
  foreach ($proj in $projects) {
    $qa = Join-Path $proj 'tools\qqbot'
    $svc = Join-Path $qa 'install-service.ps1'
    $wd = Join-Path $qa 'install-watchdog.ps1'
    Say ('  -- ' + $proj)
    if (-not (Test-Path -LiteralPath $svc)) { Bad ('missing ' + $svc); continue }
    if ($DryRun) {
      Say ('  [dry] powershell -File "' + $svc + '" -NoStart')
      Say ('  [dry] powershell -File "' + $wd + '" -NoStart')
      continue
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $svc -NoStart
    if ($LASTEXITCODE -ne 0) { Bad ('install-service.ps1 exit ' + $LASTEXITCODE + ' (' + $proj + ')') } else { Ok 'service carriers rebuilt' }
    if (Test-Path -LiteralPath $wd) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wd -NoStart
      if ($LASTEXITCODE -ne 0) { Bad ('install-watchdog.ps1 exit ' + $LASTEXITCODE + ' (' + $proj + ')') } else { Ok 'watchdog carriers rebuilt' }
    } else {
      Warn ('no install-watchdog.ps1 in ' + $qa)
    }
  }
}

# -- 3 verify legacy carriers (name by name) -------------------------------------
Step '3/5 verify legacy carriers'
if (-not $DryRun) {
  $lnkLegacy = Join-Path $startupDir $LegacyLnk
  if (Test-Path -LiteralPath $lnkLegacy) { Ok ('Startup shortcut present: ' + $LegacyLnk) } else { Warn ('Startup shortcut missing: ' + $LegacyLnk) }
  foreach ($rn in $LegacyRun) {
    $v = ''
    try { $v = [string](Get-ItemProperty -Path $runKey -Name $rn -ErrorAction Stop).$rn } catch { $v = '' }
    if ($v) { Ok ('Run value present: ' + $rn) } else { Warn ('Run value missing: ' + $rn) }
  }
  foreach ($tn in $LegacyTask) {
    $has = $false
    try { [void](Get-ScheduledTask -TaskName $tn -ErrorAction Stop); $has = $true } catch { $has = $false }
    if ($has) { Ok ('scheduled task present: ' + $tn) } else { Warn ('scheduled task missing: ' + $tn) }
  }
  if (-not $Force) {
    $missing = 0
    if (-not (Test-Path -LiteralPath (Join-Path $startupDir $LegacyLnk))) { $missing++ }
    foreach ($rn in $LegacyRun) {
      $v = ''
      try { $v = [string](Get-ItemProperty -Path $runKey -Name $rn -ErrorAction Stop).$rn } catch { $v = '' }
      if (-not $v) { $missing++ }
    }
    if ($missing -gt 0) { Bad ($missing.ToString() + ' legacy carrier(s) still missing after rollback') }
  }
} else { Skip 'dry-run' }

# -- 4 health check ---------------------------------------------------------------
Step '4/5 health'
if ($DryRun) { Skip 'dry-run' } else {
  $ports = @()
  foreach ($proj in $projects) {
    $ports += (Get-QqbotListenPort (Join-Path $proj 'tools\qqbot'))
  }
  foreach ($p in ($ports | Select-Object -Unique)) {
    $up = $false
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $p + '/health') -TimeoutSec 5
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) { $up = $true }
    } catch { $up = $false }
    if ($up) { Ok ('/health 200 on ' + $p) } else { Warn ('/health not answering on ' + $p + ' (start it, then re-check)') }
  }
}

# -- 5 summary --------------------------------------------------------------------
Step '5/5 summary'
Say ''
Say '============================================================' 'Cyan'
if ($script:FailCount -gt 0) {
  Say (' rollback FAILED: ' + $script:FailCount + ' problem(s)') 'Red'
  Say '============================================================' 'Cyan'
  exit 1
}
Say ' rollback done: host carriers removed, legacy carriers rebuilt' 'Green'
Say '============================================================' 'Cyan'
Say '  next: start the services (start-service.ps1 / start-watchdog.ps1 per project),'
Say '        then send one real QQ message to prove the loop end to end.'
exit 0
