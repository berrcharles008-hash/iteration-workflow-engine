param(
  [Parameter(Mandatory=$true)][int]$Id,
  [int]$TimeoutSec = 300,
  [int]$IntervalSec = 5,
  [string]$SinceIso = ''
)
# wait-answer.ps1 -- poll the answer file that qqbot-service writes when you reply in QQ.
# Companion of ask.js ("wait-mode confirmation", plan A). Typical agent flow:
#   node tools/qqbot/ask.js --prompt "..."            -> prints #id=<n> and #ts=<ISO>
#   powershell -File tools/qqbot/wait-answer.ps1 -Id <n> -TimeoutSec 300 -SinceIso <ISO>
#     -> prints the answer JSON and exits 0, or prints {"answer":"wait-timeout"} and exits 2
#        (exit 2 = this wait slice elapsed with no answer yet; call it again to keep waiting)
#
# -SinceIso (optional, FIX-40 2026-09-29): ignore answer files whose last-write time is
#   EARLIER than this timestamp. Guards against stale same-id answer files left by earlier
#   runs (id reuse after service restart: nextId resets to 1 while old files persist), which
#   otherwise make the waiter return a days-old answer instantly. Omit the parameter to keep
#   the legacy "file exists = answered" behavior (backward compatible).
# Exit codes: 0 = answer file found (stdout = its JSON), 2 = slice timeout, 1 = bad usage
# ASCII-only source on purpose (zh-CN PowerShell reads .ps1 as the system codepage).
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$proj = Split-Path (Split-Path $scriptDir -Parent) -Parent
$file = Join-Path $proj ('.codebuddy\temp\qq-answers\' + $Id + '.json')
$sinceUtc = $null
if ($SinceIso) {
  try {
    $sinceUtc = ([datetimeoffset]::Parse($SinceIso, [System.Globalization.CultureInfo]::InvariantCulture)).UtcDateTime
  } catch {
    Write-Output ('{"id":' + $Id + ',"answer":"bad-since-iso","input":"' + $SinceIso.Replace('"','') + '"}')
    exit 1
  }
}
$deadline = (Get-Date).AddSeconds($TimeoutSec)

while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $file) {
    $useIt = $true
    if ($sinceUtc -ne $null) {
      $m = (Get-Item -LiteralPath $file).LastWriteTimeUtc
      if ($m -lt $sinceUtc) { $useIt = $false }   # stale file from an earlier run -> keep waiting
    }
    if ($useIt) {
      $raw = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
      Write-Output $raw
      exit 0
    }
  }
  Start-Sleep -Seconds $IntervalSec
}
Write-Output ('{"id":' + $Id + ',"answer":"wait-timeout"}')
exit 2
