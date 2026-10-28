param(
  [switch]$NoStart,
  [switch]$Uninstall,
  [string]$TaskName = 'CodeBuddyQQWatchdog',
  [int]$RepeatMinutes = 5
)
# install-watchdog.ps1 -- register the heartbeat/service watchdog as a per-user logon autostart.
# ★ FIX-38: the watchdog used to only NOTIFY (never restarted the service).
# ★ TOOL-SELFHEAL (2026-10-28): autostart moved from the Startup-folder shortcut to a
#   SCHEDULED TASK (logon trigger + repeat every N minutes + restart-on-failure).
#   Why: a .lnk is an unobservable autostart carrier and this machine already lost/regressed
#   CodeBuddyQQWatchdog.lnk once (2026-10-23 incident). The repeated trigger also doubles as
#   "restart the watchdog itself if it died" -- start-watchdog.ps1 skips when already running.
#   The legacy shortcut is removed on purpose to avoid a double start.
# Uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1 -Uninstall
# ASCII-only; project root derived from $PSScriptRoot.
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$startPs1 = Join-Path $proj 'tools\qqbot\start-watchdog.ps1'
$workDir = Join-Path $proj 'tools\qqbot'
$startup = [System.Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CodeBuddyQQWatchdog.lnk'
$me = "$env:USERDOMAIN\$env:USERNAME"

function Remove-LegacyShortcut {
  if (Test-Path $lnk) {
    try {
      Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop
      Write-Host "removed legacy startup shortcut: $lnk"
    } catch {
      Write-Host ("WARN: cannot remove legacy shortcut: " + $_.Exception.Message)
    }
  } else {
    Write-Host 'no legacy startup shortcut (ok)'
  }
}

if ($Uninstall) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "scheduled task removed: $TaskName"
  } catch {
    Write-Host ("no scheduled task to remove (" + $TaskName + "): " + $_.Exception.Message)
  }
  Remove-LegacyShortcut
  exit 0
}

if (-not (Test-Path $startPs1)) { Write-Host "missing: $startPs1"; exit 1 }

# 1) kill the legacy carrier first -- otherwise a .lnk plus the task = two watchdogs
Remove-LegacyShortcut

# 2) register the scheduled task
$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startPs1`""
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $workDir
  $tLogon = New-ScheduledTaskTrigger -AtLogOn -User $me
  # -RepetitionDuration 3650d instead of TimeSpan::MaxValue (MaxValue is rejected on some builds)
  $tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  # ExecutionTimeLimit MUST be unlimited (TOOL-SELFHEAL, 2026-10-28 measured):
  #   the action spawns the long-lived node watchdog via start-watchdog.ps1. With a 5-minute limit the
  #   task instance that spawned it was terminated at the limit (LastTaskResult=267014) -- the node only
  #   survived by escaping the task job object. That is implicit OS behaviour; if it ever stops holding,
  #   the watchdog would be killed and respawned every 5 minutes (= flapping instead of self-healing).
  #   Unlimited => the instance lives exactly as long as the watchdog, and the repeat trigger resumes
  #   as soon as the watchdog exits (that is our self-heal path).
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($tLogon, $tRepeat) `
    -Settings $settings -Principal $principal -Force `
    -Description 'CodeBuddy QQ service watchdog (port probe + limited auto-restart)' | Out-Null
  $registered = $true
  Write-Host "scheduled task registered: $TaskName (logon + every $RepeatMinutes min, restart-on-failure 3x/1min)"
} catch {
  Write-Host ("Register-ScheduledTask failed: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'falling back to schtasks /SC ONLOGON (no repetition => dead watchdog is NOT auto-restarted)'
  schtasks /Create /TN $TaskName /TR "powershell.exe $arg" /SC ONLOGON /F
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'schtasks fallback failed too (creating a task may require elevation on this host)' -ForegroundColor Red
    exit 1
  }
  $registered = $true
  Write-Host "scheduled task registered (fallback): $TaskName"
}

if (-not $registered) { exit 1 }

# 3) show what was registered
try {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop |
    Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host
} catch {
  schtasks /Query /TN $TaskName
}

# 4) run it now (the task body = start-watchdog.ps1, which skips when already running)
if (-not $NoStart) {
  try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Host 'watchdog launch requested (via scheduled task)'
  } catch {
    Write-Host ("start via task failed: " + $_.Exception.Message + " -- starting directly")
    Start-Process -FilePath powershell.exe `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startPs1`"" `
      -WindowStyle Hidden
    Write-Host 'watchdog launch requested (direct)'
  }
}
Write-Host "log: $workDir\watchdog.log"
Write-Host "uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1 -Uninstall"
