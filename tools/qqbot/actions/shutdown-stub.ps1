# shutdown-stub.ps1 —— 「关机」链路的**替身**脚本（★ FIX-37）
#
# 用途：在不真关机的前提下验证完整链路：
#   口令「关机」→ 收到「#N 待确认 · [关机·需确认]」→ 回「确认#N」→ 服务 exec 本脚本 → 收到「✔️ 已确认…」回执
#
# 用法（tools/qqbot/daemon.config.json）：
#   "commands": {
#     "shutdown": {
#       "enabled": true,
#       "command": "powershell -NoProfile -ExecutionPolicy Bypass -File tools/qqbot/actions/shutdown-stub.ps1"
#     }
#   }
# 恢复真关机：把 command 改回 "shutdown /s /t {delay}"（或删掉该键 ⇒ 取代码内默认值）。
#
# 输出约定（与 actions/log-confirm.ps1 一致）：
#   stdout 只写 ASCII —— 子进程输出按系统代码页编码、服务按 UTF-8 解码，
#   中文字符串走 stdout 会在 service.log 的 [EXEC OUT] 行显示为乱码（文件内容不受影响）。
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'shutdown-stub.log'
$line = "[{0}] STUB: shutdown request received (QQ_CONFIRM_ID={1} KIND={2} PROMPT={3})" -f `
  (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $env:QQ_CONFIRM_ID, $env:QQ_CONFIRM_KIND, $env:QQ_CONFIRM_PROMPT
Add-Content -Path $log -Value $line -Encoding UTF8
Write-Output "shutdown-stub executed; detail logged to actions/shutdown-stub.log"
