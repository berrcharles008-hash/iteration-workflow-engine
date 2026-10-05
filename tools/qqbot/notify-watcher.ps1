param(
  [string]$HistoryRoot = '',
  [int]$IdleSeconds = 30
)
# notify-watcher.ps1 -- mechanism-level fallback for CodeBuddy IDE (which has no hooks).
# Polls ALL IDE session history dirs every 5s; tracks the newest file write time across
# the most-recently-active session subdirs; when writes go idle for IdleSeconds it treats
# the round as finished and calls notify.qqbot.js to push a QQ message.
# NOTE: ASCII-only. Project root derived from $PSScriptRoot (never a CJK literal),
# because zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$notify = Join-Path $proj 'tools\qqbot\notify.qqbot.js'
$log = Join-Path $proj 'tools\qqbot\watcher.log'

function Log($m) { $t = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'; Add-Content -Path $log -Value "$t $m" -Encoding UTF8 }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($c in @('C:\nvm4w\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'nvm4w\nodejs\node.exe'))) {
    if (Test-Path $c) { $nodeExe = $c; break }
  }
}
if (-not $nodeExe) { Log 'node not found, watcher exit'; exit 1 }
Log "node = $nodeExe"

# Discover history dir(s): %LOCALAPPDATA%\CodeBuddyExtension\Data\*\CodeBuddyIDE\*\history
# There can be MANY (one per install/account); monitor ALL of them.
if ($HistoryRoot) {
  $historyDirs = @($HistoryRoot)
} else {
  $base = Join-Path $env:LOCALAPPDATA 'CodeBuddyExtension\Data'
  $historyDirs = @(Get-ChildItem -Path $base -Recurse -Directory -Filter history -ErrorAction SilentlyContinue |
                   Where-Object { $_.FullName -like '*CodeBuddyIDE*' })
  if ($historyDirs.Count -eq 0) { Log "IDE history dir not found (base=$base)"; exit 1 }
}
Log "WATCHER START historyDirs=$($historyDirs.Count) idle=$IdleSeconds"
foreach ($h in $historyDirs) { Log ("  watch: " + $h.FullName) }

$lastActivity = Get-Date
$lastNotified = Get-Date
$tick = 0
# sticky: historyRoot path -> FullName of the session dir that last produced the global newest file.
# Active session's deep writes do NOT refresh its ancestor dir mtime, so "top-N by dir mtime"
# can miss it entirely. Sticky guarantees the active session stays scanned once discovered.
$sticky = @{}

function NewestWriteTime($dirs, $full) {
  $now = Get-Date
  $max = $null
  foreach ($h in $dirs) {
    $sessions = @(Get-ChildItem -Path $h -Directory -ErrorAction SilentlyContinue)
    if ($full) {
      $pick = $sessions                                   # full scan: every session (catch switches)
    } else {
      # cheap tier: top-5 by dir mtime + the sticky session dir (always re-scanned)
      $pick = @($sessions | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
      $stPath = $sticky[$h.FullName]
      if ($stPath) {
        $stItem = Get-Item -LiteralPath $stPath -ErrorAction SilentlyContinue
        if ($stItem -and ($pick.FullName -notcontains $stPath)) { $pick += $stItem }
      }
    }
    foreach ($s in $pick) {
      if (-not $s) { continue }
      # filter future-dated files BEFORE picking newest (clock skew): a future file as global max
      # would make idle negative forever and suppress every real push.
      $ff = Get-ChildItem -Path $s.FullName -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -le $now } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($ff -and ($null -eq $max -or $ff.LastWriteTime -gt $max)) {
        $max = $ff.LastWriteTime
        $sticky[$h.FullName] = $s.FullName
      }
    }
  }
  return $max
}

while ($true) {
  Start-Sleep -Seconds 5
  $tick++
  # re-discover history dirs every ~60s (cheap: dir enumeration only)
  if ($tick % 12 -eq 0 -and -not $HistoryRoot) {
    $base = Join-Path $env:LOCALAPPDATA 'CodeBuddyExtension\Data'
    $red = @(Get-ChildItem -Path $base -Recurse -Directory -Filter history -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -like '*CodeBuddyIDE*' })
    if ($red.Count -gt 0) { $historyDirs = $red; Log ("re-discovered historyDirs=$($historyDirs.Count)") }
  }
  # full session scan: first loop + every ~2min (catches switched-to session windows)
  $full = ($tick -eq 1) -or ($tick % 24 -eq 0)
  try {
    $nw = NewestWriteTime $historyDirs $full
    if ($nw -and $nw -gt $lastActivity) { $lastActivity = $nw }
  } catch { Log "SCAN ERR: $_" }
  $idle = (Get-Date) - $lastActivity
  if ($idle.TotalSeconds -ge $IdleSeconds -and $lastActivity -gt $lastNotified) {
    try {
      $r = & $nodeExe $notify '--preset' 'idle' 2>&1 | Out-String
      Log "PUSH: $($r.Trim())"
    } catch { Log "PUSH ERR: $_" }
    $lastNotified = Get-Date
  }
}
