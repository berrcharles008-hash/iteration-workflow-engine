# log-confirm.ps1 -- append one "QQ-side confirmation" record.
# Executed by qqbot-service.js when you reply 确认#N (gateCommand).
# Context comes from environment variables set by the service (no command-line
# interpolation, so the prompt text cannot inject commands):
#   QQ_CONFIRM_ID / QQ_CONFIRM_KIND / QQ_CONFIRM_PROMPT
# Working directory = project root (service sets cwd); output goes to
# tools/qqbot/gate-confirmations.log
# ASCII-only on purpose (zh-CN PowerShell reads .ps1 as the system codepage).
$ErrorActionPreference = 'Continue'
$dir = Split-Path $PSScriptRoot -Parent
$log = Join-Path $dir 'gate-confirmations.log'
$line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' | #' + $env:QQ_CONFIRM_ID + ' | ' + $env:QQ_CONFIRM_KIND + ' | ' + $env:QQ_CONFIRM_PROMPT
Add-Content -Path $log -Value $line -Encoding UTF8
# stdout 保持 ASCII：子进程输出按系统代码页编码、服务按 UTF-8 解码，
# 中文若走 stdout 会在 service.log 的 [EXEC OUT] 行显示为乱码（文件内容不受影响）。
Write-Output ('logged: #' + $env:QQ_CONFIRM_ID + ' kind=' + $env:QQ_CONFIRM_KIND)
