param(
  # Project to deploy FROM (its tools\qqbot\host is the version source). Empty = derive it
  # when this script itself lives inside <project>\tools\qqbot\host.
  [string]$ProjectRoot = '',
  # Deploy scripts + write the manifest entry, but register no autostart carrier.
  [switch]$NoCarrier,
  # Delete the OLD per-project carriers after the host layer is verified working.
  [switch]$RetireLegacy,
  # Remove the host carrier set only (scripts and hosts.json stay on disk).
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Force
)
# install-host.ps1 -- deploy the host layer to %LOCALAPPDATA%\codebuddy-qqbot and register
# exactly ONE autostart carrier set (CodeBuddyQQHost: Startup shortcut + Run key + task).
#
# Why (2026-11-17): the old carriers were per-project and fixed-name, so installing a
# second project silently replaced the first one's logon autostart. The host layer owns
# the carriers and fans out to every project in hosts.json.
#
# Ordering rule from the tech plan 2.5: never delete a legacy carrier before the host
# layer has PROVEN it can start the project. -RetireLegacy is therefore a separate,
# explicit step, and refuses to run while the host manifest has no entry for this project.
#
# Deleting legacy carriers is name-by-name on purpose. 'CodeBuddy*' would also remove the
# session-hub and serve carriers, which are out of scope and whose loss is silent
# (the hub confirm button and the headless serve would just stop working).
#
# Exit codes (03 tech plan 4.2): 0 done / 1 environment missing / 2 completed with TODO
#
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
$ErrorActionPreference = 'Continue'

$script:OkCount = 0
$script:SkipCount = 0
$script:ManualItems = @()
function Say([string]$m, [string]$c = '') { if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m } }
function Step([string]$n) { Write-Host ''; Write-Host "[$n]" -ForegroundColor Cyan }
function Ok([string]$m) { Say "  [OK]   $m" 'Green'; $script:OkCount++ }
function Skip([string]$m) { Say "  [SKIP] $m" 'DarkGray'; $script:SkipCount++ }
function Warn([string]$m) { Say "  [WARN] $m" 'Yellow' }
function Manual([string]$m) { Say "  [TODO] $m" 'Yellow'; $script:ManualItems += $m }

# Legacy carrier names, verbatim from the tech plan 4.2. Do not add a wildcard here.
$LegacyLnk = 'CodeBuddyQQWatcher.lnk'
$LegacyRun = @('CodeBuddyQQService', 'CodeBuddyQQWatchdog')
$LegacyTask = @('CodeBuddyQQWatchdog')
$HostCarrier = 'CodeBuddyQQHost'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupDir = [System.Environment]::GetFolderPath('Startup')
# Computed inline (not via Get-QqbotHostDir): on the FIRST run the shared helper is not in
# the host directory yet, so dot-sourcing it can only happen from the source project below.
$hostDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'codebuddy-qqbot' } else { '' }

# -- path resolution --------------------------------------------------------------
$selfDir = $PSScriptRoot
if (-not $ProjectRoot) {
  # <proj>\tools\qqbot\host -> <proj>
  $maybe = Split-Path (Split-Path (Split-Path $selfDir -Parent) -Parent) -Parent
  if ($maybe -and (Test-Path -LiteralPath (Join-Path $maybe 'tools\qqbot\qqbot-service.js'))) {
    $ProjectRoot = $maybe
  }
}
if (-not $ProjectRoot) {
  Say 'FATAL: cannot tell which project to deploy from.' 'Red'
  Say '       Run with -ProjectRoot <project root>, e.g.:' 'Red'
  Say '       powershell -File <proj>\tools\qqbot\host\install-host.ps1 -ProjectRoot <proj>' 'Red'
  exit 1
}
if (-not (Test-Path -LiteralPath $ProjectRoot)) {
  Say ('FATAL: project root not found: ' + $ProjectRoot) 'Red'
  exit 1
}
$proj = (Resolve-Path -LiteralPath $ProjectRoot).Path
$srcQa = Join-Path $proj 'tools\qqbot'
$srcHost = Join-Path $srcQa 'host'
if (-not (Test-Path -LiteralPath (Join-Path $srcQa 'qqbot-service.js'))) {
  Say ('FATAL: ' + $srcQa + ' does not look like a qqbot toolkit (qqbot-service.js missing)') 'Red'
  exit 1
}
if (-not (Test-Path -LiteralPath $srcHost)) {
  Say ('FATAL: host sources missing: ' + $srcHost) 'Red'
  exit 1
}
if (-not $hostDir) {
  Say 'FATAL: LOCALAPPDATA is empty -- cannot resolve the host directory' 'Red'
  exit 1
}
# Helper comes from the SOURCE project (the host copy may not exist yet on a first run).
$srcCommon = Join-Path $srcQa '_qqbot-common.ps1'
if (-not (Test-Path -LiteralPath $srcCommon)) {
  Say ('FATAL: missing shared helper: ' + $srcCommon) 'Red'
  exit 1
}
. $srcCommon

Say '============================================================' 'Cyan'
Say ' qqbot host layer installer (install-host.ps1)' 'Cyan'
Say '============================================================' 'Cyan'
Say ('  source : ' + $srcHost)
Say ('  host   : ' + $hostDir)
Say ('  project: ' + $proj)
if ($DryRun) { Say '  MODE   : DRY-RUN (nothing will be written or registered)' 'Yellow' }

# -- uninstall: carriers only -----------------------------------------------------
function Remove-HostCarriers([bool]$dry) {
  $removed = 0
  $lnk = Join-Path $startupDir ($HostCarrier + '.lnk')
  if (Test-Path -LiteralPath $lnk) {
    if ($dry) { Say ('  [dry] would delete ' + $lnk) } else {
      try { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop; Say ('  removed ' + $lnk); $removed++ }
      catch { Warn ('cannot delete ' + $lnk + ': ' + $_.Exception.Message) }
    }
  } else { Skip ('no Startup shortcut ' + $HostCarrier + '.lnk') }
  $rv = ''
  try { $rv = [string](Get-ItemProperty -Path $runKey -Name $HostCarrier -ErrorAction Stop).$HostCarrier } catch { $rv = '' }
  if ($rv) {
    if ($dry) { Say ('  [dry] would delete Run value ' + $HostCarrier) } else {
      try { Remove-ItemProperty -Path $runKey -Name $HostCarrier -ErrorAction Stop; Say ('  removed Run value ' + $HostCarrier); $removed++ }
      catch { Warn ('cannot delete Run value ' + $HostCarrier + ': ' + $_.Exception.Message) }
    }
  } else { Skip ('no Run value ' + $HostCarrier) }
  try {
    [void](Get-ScheduledTask -TaskName $HostCarrier -ErrorAction Stop)
    if ($dry) { Say ('  [dry] would unregister task ' + $HostCarrier) } else {
      try { Unregister-ScheduledTask -TaskName $HostCarrier -Confirm:$false -ErrorAction Stop; Say ('  unregistered task ' + $HostCarrier); $removed++ }
      catch { Warn ('cannot unregister task ' + $HostCarrier + ': ' + $_.Exception.Message) }
    }
  } catch { Skip ('no scheduled task ' + $HostCarrier) }
  return $removed
}

if ($Uninstall) {
  Step 'uninstall: remove host carriers'
  $n = Remove-HostCarriers $DryRun.IsPresent
  Say ''
  Say ('  carriers removed: ' + $n)
  Say ('  kept on disk   : ' + $hostDir + ' (scripts + hosts.json)') 
  Say '  note: projects registered in hosts.json no longer start at logon.'
  Say '        Re-create per-project carriers with install-service.ps1 / install-watchdog.ps1.'
  if ($script:ManualItems.Count -gt 0) { exit 2 }
  exit 0
}

# -- 1 deploy scripts -------------------------------------------------------------
Step '1/6 deploy host scripts'
$deploy = @()
foreach ($f in (Get-ChildItem -LiteralPath $srcHost -File -Filter '*.ps1' -ErrorAction SilentlyContinue)) {
  $deploy += @{ src = $f.FullName; dst = (Join-Path $hostDir $f.Name) }
}
$deploy += @{ src = (Join-Path $srcQa '_qqbot-common.ps1'); dst = (Join-Path $hostDir '_qqbot-common.ps1') }
$exampleSrc = Join-Path $srcHost 'hosts.example.json'
if (Test-Path -LiteralPath $exampleSrc) { $deploy += @{ src = $exampleSrc; dst = (Join-Path $hostDir 'hosts.example.json') } }

foreach ($d in $deploy) {
  if (-not (Test-Path -LiteralPath $d.src)) { Warn ('source missing, skipped: ' + $d.src); continue }
  if ($DryRun) { Say ('  [dry] would copy ' + (Split-Path $d.src -Leaf)) ; continue }
  if (-not (Test-Path -LiteralPath $hostDir)) { New-Item -ItemType Directory -Force -Path $hostDir | Out-Null }
  Copy-Item -LiteralPath $d.src -Destination $d.dst -Force
}
if ($DryRun) { Say ('  [dry] ' + $deploy.Count + ' file(s)') } else { Ok ($deploy.Count.ToString() + ' file(s) deployed to ' + $hostDir) }

if (-not (Test-Path -LiteralPath (Join-Path $hostDir '_qqbot-common.ps1')) -and -not $DryRun) {
  Say 'FATAL: deploy incomplete -- _qqbot-common.ps1 missing in the host directory' 'Red'
  exit 1
}

# -- 2 baseline snapshot (before any legacy deletion) -----------------------------
Step '2/6 legacy carrier baseline'
$baselinePath = Join-Path $hostDir 'host-baseline.json'
if ($DryRun) {
  Say ('  [dry] would write ' + $baselinePath)
} else {
  $lnkExists = Test-Path -LiteralPath (Join-Path $startupDir $LegacyLnk)
  $runLines = @()
  foreach ($rn in $LegacyRun) {
    $v = ''
    try { $v = [string](Get-ItemProperty -Path $runKey -Name $rn -ErrorAction Stop).$rn } catch { $v = '' }
    $esc = $v.Replace('\', '\\').Replace('"', '\"')
    $runLines += ('      { "name": "' + $rn + '", "exists": ' + $(if ($v) { 'true' } else { 'false' }) + ', "value": "' + $esc + '" }')
  }
  $taskLines = @()
  foreach ($tn in $LegacyTask) {
    $has = $false
    try { [void](Get-ScheduledTask -TaskName $tn -ErrorAction Stop); $has = $true } catch { $has = $false }
    $taskLines += ('      { "name": "' + $tn + '", "exists": ' + $(if ($has) { 'true' } else { 'false' }) + ' }')
  }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('{')
  [void]$sb.AppendLine('  "capturedAt": "' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + '",')
  [void]$sb.AppendLine('  "project": "' + $proj.Replace('\', '\\') + '",')
  [void]$sb.AppendLine('  "startupShortcuts": [')
  [void]$sb.AppendLine('      { "name": "' + $LegacyLnk + '", "exists": ' + $(if ($lnkExists) { 'true' } else { 'false' }) + ' }')
  [void]$sb.AppendLine('  ],')
  [void]$sb.AppendLine('  "runValues": [')
  [void]$sb.AppendLine(($runLines -join (',' + [Environment]::NewLine)))
  [void]$sb.AppendLine('  ],')
  [void]$sb.AppendLine('  "scheduledTasks": [')
  [void]$sb.AppendLine(($taskLines -join (',' + [Environment]::NewLine)))
  [void]$sb.AppendLine('  ]')
  [void]$sb.AppendLine('}')
  try {
    [IO.File]::WriteAllText($baselinePath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    Ok ('baseline written: ' + $baselinePath)
  } catch {
    Warn ('baseline write failed: ' + $_.Exception.Message)
    Manual ('write the baseline manually before -RetireLegacy: ' + $baselinePath)
  }
}

# -- 3 manifest entry upsert ------------------------------------------------------
Step '3/6 hosts.json entry'
$cfg = Get-QqbotConfig $srcQa
$entryPort = Get-QqbotListenPort $srcQa
$entryServePort = 0
$entrySimulateKey = ''
if ($cfg) {
  if ($cfg.headless -and $cfg.headless.serve) { $entryServePort = [int]$cfg.headless.serve.port }
  if ($cfg.hub) { $entrySimulateKey = [string]$cfg.hub.simulateKey }
}
$entryAppId = ''
$creds = Join-Path $srcQa 'qqbot.creds.json'
if (Test-Path -LiteralPath $creds) {
  try { $entryAppId = [string]((Get-Content -LiteralPath $creds -Raw -Encoding UTF8 | ConvertFrom-Json).appId) } catch { $entryAppId = '' }
}
if (-not $entryAppId) {
  Warn 'qqbot.creds.json has no appId -> the manifest entry cannot satisfy the gateway rule'
  Manual 'finish qqbot-setup.js, then re-run install-host.ps1'
}
$entry = [pscustomobject][ordered]@{
  project       = $proj
  port          = $entryPort
  servePort     = $entryServePort
  appId         = $entryAppId
  role          = 'gateway'
  simulateKey   = $entrySimulateKey
  enabled       = $true
  startWatchdog = $true
}
if ($DryRun) {
  Say ('  [dry] would upsert ' + (Join-Path $hostDir 'hosts.json') + ' for ' + $proj)
} else {
  $up = Update-QqbotHostEntry $hostDir $entry
  if ($up.Ok) {
    $verb = if ($up.Replaced) { 'entry refreshed' } else { 'entry added' }
    Ok ('host manifest ' + $verb + '; ' + $up.Count + ' instance(s)')
  } else {
    Warn ('host manifest write failed: ' + $up.Error)
    Manual ('upsert ' + (Join-Path $hostDir 'hosts.json') + ' manually')
  }
}
if (-not $entrySimulateKey) { Warn 'simulateKey is empty (hub confirm button will not work for this project)' }

# -- 4 carriers -------------------------------------------------------------------
Step '4/6 host carriers (CodeBuddyQQHost)'
if ($NoCarrier) {
  Skip 'carrier registration skipped (-NoCarrier)'
} else {
  $startAll = Join-Path $hostDir 'start-all.ps1'
  $argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startAll + '"'

  $lnkPath = Join-Path $startupDir ($HostCarrier + '.lnk')
  if ($DryRun) {
    Say ('  [dry] would create ' + $lnkPath)
  } else {
    try {
      $wsh = New-Object -ComObject WScript.Shell
      $sc = $wsh.CreateShortcut($lnkPath)
      $sc.TargetPath = 'powershell.exe'
      $sc.Arguments = $argLine
      $sc.WorkingDirectory = $hostDir
      $sc.Description = 'CodeBuddy QQ host layer (starts every project in hosts.json)'
      $sc.Save()
      Ok ('Startup shortcut: ' + $lnkPath)
    } catch {
      Warn ('Startup shortcut failed: ' + $_.Exception.Message)
      Manual ('create the Startup shortcut manually: powershell.exe ' + $argLine)
    }
  }

  if ($DryRun) {
    Say ('  [dry] would set Run value ' + $HostCarrier)
  } elseif ($argLine.Length -ge 260) {
    Warn ('Run-key command is ' + $argLine.Length + ' chars (>=260 limit) -- NOT registered; shorten the path')
    Manual 'shorten the host path or wrap start-all.ps1 in a .cmd'
  } else {
    try {
      if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
      Set-ItemProperty -Path $runKey -Name $HostCarrier -Value $argLine -Type String -ErrorAction Stop
      Ok ('Run value: HKCU\...\Run\' + $HostCarrier)
    } catch {
      Warn ('Run value registration failed: ' + $_.Exception.Message)
      Manual ('set HKCU\...\Run\' + $HostCarrier + ' manually')
    }
  }

  if ($DryRun) {
    Say ('  [dry] would register scheduled task ' + $HostCarrier)
  } else {
    try {
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $hostDir
      $me = "$env:USERDOMAIN\$env:USERNAME"
      $tLogon = New-ScheduledTaskTrigger -AtLogOn -User $me
      $tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
      # ExecutionTimeLimit MUST be unlimited: the action starts long-lived node processes,
      # and a 5-minute limit killed the spawning instance (LastTaskResult=267014) before.
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
      $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $HostCarrier -Action $action -Trigger @($tLogon, $tRepeat) `
        -Settings $settings -Principal $principal -Force `
        -Description 'CodeBuddy QQ host layer (start-all.ps1 for every registered project)' | Out-Null
      Ok ('scheduled task: ' + $HostCarrier + ' (logon + every 5 min)')
    } catch {
      Warn ('Register-ScheduledTask failed: ' + $_.Exception.Message)
      Manual ('register task ' + $HostCarrier + ' manually (may need elevation)')
    }
  }
}

# -- 5 retire legacy carriers (name by name) --------------------------------------
Step '5/6 retire legacy carriers'
if (-not $RetireLegacy) {
  Skip 'kept (pass -RetireLegacy after verifying start-all.ps1 really starts this project)'
} else {
  Say '  reminder: the host layer must be proven working first (tech plan 2.5 step 5).'
  Say '            If start-all.ps1 does not bring the bot up, run rollback-host.ps1.'
  $lnkLegacy = Join-Path $startupDir $LegacyLnk
  if ($DryRun) {
    Say ('  [dry] would delete ' + $lnkLegacy)
    foreach ($rn in $LegacyRun) { Say ('  [dry] would delete Run value ' + $rn) }
    foreach ($tn in $LegacyTask) { Say ('  [dry] would unregister task ' + $tn) }
  } else {
    if (Test-Path -LiteralPath $lnkLegacy) {
      try { Remove-Item -LiteralPath $lnkLegacy -Force -ErrorAction Stop; Ok ('deleted ' + $lnkLegacy) }
      catch { Warn ('cannot delete ' + $lnkLegacy + ': ' + $_.Exception.Message); Manual ('delete ' + $lnkLegacy) }
    } else { Skip ('no ' + $LegacyLnk) }
    foreach ($rn in $LegacyRun) {
      $v = ''
      try { $v = [string](Get-ItemProperty -Path $runKey -Name $rn -ErrorAction Stop).$rn } catch { $v = '' }
      if (-not $v) { Skip ('no Run value ' + $rn); continue }
      try { Remove-ItemProperty -Path $runKey -Name $rn -ErrorAction Stop; Ok ('deleted Run value ' + $rn) }
      catch { Warn ('cannot delete Run value ' + $rn + ': ' + $_.Exception.Message); Manual ('delete Run value ' + $rn) }
    }
    foreach ($tn in $LegacyTask) {
      $has = $false
      try { [void](Get-ScheduledTask -TaskName $tn -ErrorAction Stop); $has = $true } catch { $has = $false }
      if (-not $has) { Skip ('no scheduled task ' + $tn); continue }
      try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction Stop; Ok ('unregistered task ' + $tn) }
      catch { Warn ('cannot unregister task ' + $tn + ': ' + $_.Exception.Message); Manual ('unregister task ' + $tn) }
    }
  }
}

# -- 6 summary --------------------------------------------------------------------
Step '6/6 summary'
Say ''
Say '============================================================' 'Cyan'
Say (" summary: {0} ok / {1} skipped / {2} todo" -f $script:OkCount, $script:SkipCount, $script:ManualItems.Count) 'Cyan'
Say '============================================================' 'Cyan'
foreach ($m in $script:ManualItems) { Say ('  TODO: ' + $m) 'Yellow' }
Say ('  hosts    : ' + (Join-Path $hostDir 'hosts.json'))
Say ('  start    : powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $hostDir 'start-all.ps1') + '"')
Say ('  rollback : powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $hostDir 'rollback-host.ps1') + '"')
if ($script:ManualItems.Count -gt 0) { exit 2 }
exit 0
