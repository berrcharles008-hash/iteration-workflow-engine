param(
  [int]$IdleSeconds = 0,
  [string]$ExtraArgs = ''
)
# start-service.ps1 -- launch the merged QQ service (watcher + confirm) in background.
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
# Project root is derived from $PSScriptRoot (never a CJK literal).
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$svc = Join-Path $proj 'tools\qqbot\qqbot-service.js'
$workDir = Join-Path $proj 'tools\qqbot'

if (-not (Test-Path $svc)) { Write-Host "service not found: $svc"; exit 1 }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($c in @('C:\nvm4w\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'nvm4w\nodejs\node.exe'))) {
    if (Test-Path $c) { $nodeExe = $c; break }
  }
}
if (-not $nodeExe) { Write-Host 'node not found (install Node or add it to PATH)'; exit 1 }

# guard: skip if an instance is already running
# ★ FIX-33（2026-09-19）：加 Name 过滤 —— 原判定只匹配 CommandLine，会把「命令行/脚本文本里
#   提到 qqbot-service.js 的 powershell 包装进程」误判为服务实例 ⇒ 重启被静默跳过
#   （实测：install-service 报 "service launch requested"，但服务实际未换代码仍跑旧版）。
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*qqbot-service.js*' })
if ($running.Count -gt 0) {
  $pids = ($running | ForEach-Object { $_.ProcessId }) -join ','
  Write-Host "already running: pid $pids (skip start)"
  exit 0
}

$argList = @($svc)
if ($IdleSeconds -gt 0) { $argList += @('--idle', "$IdleSeconds") }
if ($ExtraArgs) { $argList += $ExtraArgs.Split(' ') }

Start-Process -FilePath $nodeExe -ArgumentList $argList -WorkingDirectory $workDir -WindowStyle Hidden
Write-Host "qqbot-service launched (node: $nodeExe)"
Write-Host "log: $workDir\service.log"
Write-Host "health: http://127.0.0.1:18765/health"
