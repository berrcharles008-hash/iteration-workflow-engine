param(
  [string]$Config = '',
  # Stop only the instances whose project path contains this fragment (case-insensitive).
  [string]$Only = '',
  [switch]$DryRun
)
# stop-all.ps1 -- host layer: stop every enabled qqbot instance listed in hosts.json.
#
# Each stop goes through that project's own stop-service.ps1, which is scoped to
# <project>\tools\qqbot\qqbot-service.js. Nothing here matches on the bare script name, so
# stopping project A can never take project B down (that was pain point #3 before P1).
#
# Exit codes (03 tech plan 4.2): 0 all stopped / 1 manifest unusable / 2 partial failure
#
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
$ErrorActionPreference = 'Continue'
$hostDir = $PSScriptRoot
$common = Join-Path $hostDir '_qqbot-common.ps1'
if (-not (Test-Path -LiteralPath $common)) {
  Write-Host "FATAL: missing shared helper: $common" -ForegroundColor Red
  exit 1
}
. $common

if (-not $Config) { $Config = Join-Path $hostDir 'hosts.json' }
if (-not (Test-Path -LiteralPath $Config)) {
  Write-Host ("FATAL: host manifest not found: " + $Config) -ForegroundColor Red
  Write-Host 'Create it from hosts.example.json (see start-all.ps1 for the full instructions).'
  exit 1
}
try {
  $doc = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Write-Host ('FATAL: hosts.json is not valid JSON: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
if ($null -eq $doc -or $null -eq $doc.version) {
  Write-Host 'FATAL: hosts.json has no "version" field' -ForegroundColor Red
  exit 1
}
$instances = @($doc.instances)
if ($instances.Count -eq 0) {
  Write-Host 'FATAL: instances[] is empty' -ForegroundColor Red
  exit 1
}
Write-Host ("manifest: " + $Config + " (" + $instances.Count + ' instance(s))')

$ok = 0
$fail = 0
$skip = 0
foreach ($i in $instances) {
  $proj = [string]$i.project
  if ($Only -and ($proj.ToLowerInvariant().IndexOf($Only.ToLowerInvariant()) -lt 0)) { continue }
  if ($i.enabled -ne $null -and -not [bool]$i.enabled) {
    Write-Host ('[SKIP] ' + $proj + ' (enabled=false)')
    $skip++
    continue
  }
  $stopPs1 = Join-Path (Join-Path $proj 'tools\qqbot') 'stop-service.ps1'
  if (-not (Test-Path -LiteralPath $stopPs1)) {
    Write-Host ('[FAIL] ' + $proj + ' -> missing ' + $stopPs1) -ForegroundColor Red
    $fail++
    continue
  }
  if ($DryRun) {
    Write-Host ('  [dry] powershell -File "' + $stopPs1 + '"')
    continue
  }
  Write-Host ''
  Write-Host ('-- ' + $proj) -ForegroundColor Cyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopPs1
  $rc = $LASTEXITCODE
  if ($rc -eq 0) { $ok++ } else { Write-Host ('[FAIL] stop-service.ps1 exit ' + $rc) -ForegroundColor Red; $fail++ }
}

Write-Host ''
Write-Host ('summary: ' + $ok + ' stopped / ' + $skip + ' skipped / ' + $fail + ' failed')
if ($fail -gt 0) { exit 2 }
exit 0
