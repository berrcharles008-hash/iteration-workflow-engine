param(
  # ★ FIX-25：默认 0 = 不传 --idle，由 daemon.config.json 的 watcher.idleSeconds(90) 单一来源决定
  #   （旧默认 30 会覆盖配置 ⇒ 出现「配置 90、实际 30」的漂移）
  [int]$IdleSeconds = 0,
  [switch]$KeepLegacy,
  [switch]$NoStart
)
# install-service.ps1 -- register the merged QQ service as a per-user logon autostart.
# - Reuses the SAME startup shortcut name (CodeBuddyQQWatcher.lnk) by overwriting it,
#   so no delete is needed and the old watcher autostart entry is fully replaced.
# - By default it also stops the legacy processes (notify-watcher.ps1 / qqbot-daemon.js)
#   to avoid double-push and port 18765 conflicts. Use -KeepLegacy to skip that.
# ASCII-only; project root derived from $PSScriptRoot.
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$startPs1 = Join-Path $proj 'tools\qqbot\start-service.ps1'
$workDir = Join-Path $proj 'tools\qqbot'
$startup = [System.Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'CodeBuddyQQWatcher.lnk'

if (-not (Test-Path $startPs1)) { Write-Host "missing: $startPs1"; exit 1 }

if (-not $KeepLegacy) {
  $legacy = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -like '*notify-watcher.ps1*' -or $_.CommandLine -like '*qqbot-daemon.js*' })
  foreach ($p in $legacy) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Write-Host ("stopped legacy pid " + $p.ProcessId)
    } catch {
      Write-Host ("stop failed pid " + $p.ProcessId + " : " + $_.Exception.Message)
    }
  }
  if ($legacy.Count -eq 0) { Write-Host 'no legacy process found (ok)' }
}

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startPs1`" -IdleSeconds $IdleSeconds"
$sc.WorkingDirectory = $workDir
$sc.Description = 'CodeBuddy QQ service (merged: idle watcher + QQ confirm)'
$sc.Save()
Write-Host "autostart registered (overwrote same-name shortcut): $lnk"

# ★ TOOL-SELFHEAL-2 (2026-11-03): third autostart carrier = HKCU\...\Run value.
#   Why (measured on THIS host): three separate incidents (10-22 / 10-29 / 11-03) wiped BOTH the
#   Startup-folder shortcuts AND the scheduled tasks. The same sweeps left all 11 entries under
#   HKCU\...\Run untouched (OneDrive / BaiduNetdisk / Cleaner One Pro / WorkBuddy / 360 sesvc / ...).
#   So the sweeper enumerates the Startup folder and the task store, not the Run key.
#   This value is REDUNDANT with the .lnk above, not a replacement: whichever survives brings the
#   service back. A double start is harmless -- start-service.ps1 skips when the service is running.
#   Silent failure mode if this block is dropped: the shortcut becomes the only carrier again, and a
#   single sweep puts us back to "the bot's soul is offline" with zero visible symptom.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'CodeBuddyQQService'
$runCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startPs1`" -IdleSeconds $IdleSeconds"
try {
  if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
  # Run values are capped at 260 chars (CreateProcess command line). Project paths are short today;
  # if this ever overflows, autostart silently stops working at logon -- hence the explicit check.
  if ($runCmd.Length -ge 260) {
    Write-Host ("WARN: Run-key command is " + $runCmd.Length + " chars (>=260 limit) -- NOT registered; shorten the path or use a wrapper .cmd") -ForegroundColor Yellow
  } else {
    Set-ItemProperty -Path $runKey -Name $runName -Value $runCmd -Type String -ErrorAction Stop
    Write-Host "autostart registered (Run key): HKCU\...\Run\$runName"
  }
} catch {
  Write-Host ("WARN: Run-key registration failed: " + $_.Exception.Message)
}

if (-not $NoStart) {
  # ★ FIX-34 收尾（2026-09-19）：先停**当前合并服务**（node + qqbot-service.js），
  #   否则 start-service.ps1 的 guard 判定「already running」⇒ skip start ⇒ 旧代码继续跑
  #   （FIX-33 事故遗留缺口：install 报成功但服务从未真正换代码）。
  $svcRunning = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*qqbot-service.js*' })
  foreach ($p in $svcRunning) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Write-Host ("stopped running service pid " + $p.ProcessId)
    } catch {
      Write-Host ("stop failed pid " + $p.ProcessId + " : " + $_.Exception.Message)
    }
  }
  if ($svcRunning.Count -eq 0) { Write-Host 'no running service found (ok)' }

  Start-Process -FilePath powershell.exe `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startPs1`" -IdleSeconds $IdleSeconds" `
    -WindowStyle Hidden
  Write-Host 'service launch requested'
}
Write-Host "log: $workDir\service.log"
Write-Host "health: http://127.0.0.1:18765/health"
Write-Host "uninstall autostart: delete the shortcut above"
