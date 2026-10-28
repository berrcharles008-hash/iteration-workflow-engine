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
#     -> TOOL-ANSWERKIND (2026-10-20): an answer file is NOT an authorization.
#        exit 4 = answered but NOT authorized (defer-ide / cancel / timeout). Read the JSON 'hint';
#        do NOT advance the phase, do NOT write phase_confirm -- end the turn and let the user decide in the IDE.
#        Why: 2026-10-20 the user replied option D "decide in IDE" (answer ide), the agent read it as
#        "user already approved in the IDE" and advanced 01->02 and 02->03 with a self-written quote.
#
# -SinceIso (optional, FIX-40 2026-09-29): ignore answer files whose last-write time is
#   EARLIER than this timestamp. Guards against stale same-id answer files left by earlier
#   runs (id reuse after service restart: nextId resets to 1 while old files persist), which
#   otherwise make the waiter return a days-old answer instantly. Omit the parameter to keep
#   the legacy "file exists = answered" behavior (backward compatible).
# Exit codes: 0 = authorized answer (stdout = its JSON), 4 = answered but NOT authorized,
#             2 = slice timeout, 1 = bad usage
#             (NOT 3: request-confirm.js already uses 3 = registered but delivery unconfirmed.)
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
      # TOOL-ANSWERKIND (2026-10-20): see header. answerKind/allowed are written by qqbot-service.js;
      #   legacy answer files (no 'allowed' property) fall back to the table below (old 'ide' = NOT authorized).
      $allowed = $false
      $kind = ''
      try {
        $obj = $raw | ConvertFrom-Json
        $kind = [string]$obj.answerKind
        if ($obj.PSObject.Properties.Name -contains 'allowed') {
          $allowed = [bool]$obj.allowed
        } else {
          switch ([string]$obj.answer) {
            'confirm' { $allowed = $true; $kind = 'approve' }
            'choice'  { $allowed = $true; $kind = 'approve' }
            'text'    { $allowed = $true; $kind = 'free-text' }
            default   { $allowed = $false; if (-not $kind) { $kind = [string]$obj.answer } }
          }
        }
      } catch { $allowed = $false }
      if (-not $allowed) {
        Write-Output ('[NO-AUTH] answerKind=' + $kind + ' :: NOT an authorization. Do NOT advance the phase, do NOT write phase_confirm; end the turn and wait for the user in the IDE.')
        exit 4
      }
      exit 0
    }
  }
  Start-Sleep -Seconds $IntervalSec
}
Write-Output ('{"id":' + $Id + ',"answer":"wait-timeout"}')
exit 2
