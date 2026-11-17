param(
  # Manifest path. Default = <this dir>\hosts.json (the deployed host location).
  [string]$Config = '',
  # Start only the instances whose project path contains this fragment (case-insensitive).
  [string]$Only = '',
  [switch]$DryRun,
  [switch]$NoWatchdog
)
# start-all.ps1 -- host layer: start every enabled qqbot instance listed in hosts.json.
#
# Why a host layer exists (2026-11-17): per-project autostart carriers are singletons, so
# a second project used to silently replace the first one's logon startup. The host layer
# owns exactly ONE carrier set and fans out to every project listed here.
#
# Exit codes (03 tech plan 4.2): 0 all started / 1 validation failed / 2 partial failure
# / 3 env credentials present (whole batch refused). Nothing is started when validation
# fails -- "start nothing" must never look like success.
#
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
$ErrorActionPreference = 'Continue'
$hostDir = $PSScriptRoot
$common = Join-Path $hostDir '_qqbot-common.ps1'
if (-not (Test-Path -LiteralPath $common)) {
  Write-Host "FATAL: missing shared helper: $common (run install-host.ps1 from a project)" -ForegroundColor Red
  Write-Host 'Without it the process/port rules would have to be re-implemented here, which is'
  Write-Host 'exactly the drift this file is supposed to prevent.'
  exit 1
}
. $common

if (-not $Config) { $Config = Join-Path $hostDir 'hosts.json' }
if (-not (Test-Path -LiteralPath $Config)) {
  Write-Host ("FATAL: host manifest not found: " + $Config) -ForegroundColor Red
  Write-Host 'Create it from the example (one entry per project):'
  Write-Host ('  copy "' + (Join-Path $hostDir 'hosts.example.json') + '" "' + $Config + '"')
  Write-Host 'or let a project register itself: tools\qqbot\install-all.ps1 (step 8),'
  Write-Host 'then re-run: install-host.ps1 -ProjectRoot <project>'
  exit 1
}
Write-Host ("manifest: " + $Config)

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
if ([int]$doc.version -ne 1) {
  Write-Host ('FATAL: unsupported hosts.json version ' + $doc.version + ' (this script understands 1)') -ForegroundColor Red
  exit 1
}
$instances = @($doc.instances)
if ($instances.Count -eq 0) {
  Write-Host 'FATAL: instances[] is empty -- treated as a missing manifest, not as "start nothing"' -ForegroundColor Red
  exit 1
}

# ---- validation: report EVERY problem, then refuse the whole batch --------------
$problems = @()
$warns = @()
$seenProj = @{}
$seenPort = @{}
$seenServe = @{}
$gatewayByApp = @{}
foreach ($i in $instances) {
  $proj = [string]$i.project
  if (-not $proj) { $problems += 'an instance has no "project"'; continue }
  if (-not [IO.Path]::IsPathRooted($proj)) {
    $problems += ('project is not an absolute path: ' + $proj)
    continue
  }
  $key = ConvertTo-PathKey $proj
  if ($seenProj.ContainsKey($key)) {
    $problems += ('duplicate project (after path normalization): ' + $proj)
  } else {
    $seenProj[$key] = 1
  }
  if (-not (Test-Path -LiteralPath $proj)) { $problems += ('project directory not found: ' + $proj) }

  $port = 0
  if ($null -eq $i.port) {
    $problems += ('port missing for ' + $proj)
  } else {
    $port = [int]$i.port
    if ($port -lt 1 -or $port -gt 65535) {
      $problems += ('port out of range for ' + $proj + ': ' + $port)
    } elseif ($seenPort.ContainsKey($port)) {
      $problems += ('duplicate port ' + $port + ' (' + $proj + ')')
    } else {
      $seenPort[$port] = 1
    }
  }

  $role = [string]$i.role
  if ($role -ne 'gateway') {
    $problems += ('role must be "gateway" for now, got "' + $role + '" (' + $proj + ')')
  }
  $app = [string]$i.appId
  if (-not $app) {
    $problems += ('appId missing for ' + $proj)
  } elseif ($role -eq 'gateway') {
    if ($gatewayByApp.ContainsKey($app)) { $gatewayByApp[$app] = [int]$gatewayByApp[$app] + 1 } else { $gatewayByApp[$app] = 1 }
  }

  if ([string]::IsNullOrEmpty([string]$i.simulateKey)) {
    $warns += ('simulateKey is empty (' + $proj + ') -> the hub confirm button will not work for it')
  }
  # servePort is registered only, never a uniqueness gate: 19000 is shared by
  # tools/session-hub (start-serve.ps1:15) and a clash only costs the headless fallback.
  if ($null -ne $i.servePort) {
    $sp = [int]$i.servePort
    if ($seenServe.ContainsKey($sp)) {
      $warns += ('servePort ' + $sp + ' used by more than one instance (shared with session-hub, allowed)')
    } else {
      $seenServe[$sp] = 1
    }
  }
}
foreach ($app in $gatewayByApp.Keys) {
  if ([int]$gatewayByApp[$app] -gt 1) {
    $problems += ('appId ' + $app + ' has ' + $gatewayByApp[$app] + ' gateway instances (exactly 1 allowed)')
  }
}
foreach ($w in $warns) { Write-Host ('[WARN] ' + $w) -ForegroundColor Yellow }
if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host 'FATAL: hosts.json failed validation -- nothing was started:' -ForegroundColor Red
  foreach ($p in $problems) { Write-Host ('  - ' + $p) -ForegroundColor Red }
  exit 1
}
Write-Host ('validation ok: ' + $instances.Count + ' instance(s)')

# ---- env credential gate: refuse the whole batch (03 tech plan 4.4) ------------
$hits = @(Get-QqbotEnvCredHits)
if ($hits.Count -gt 0) {
  if ($env:QQBOT_ALLOW_ENV_CREDS -eq '1') {
    Write-Host ('[WARN] env creds allowed by switch: ' + ($hits -join ', ')) -ForegroundColor Yellow
  } else {
    Write-Host ('[FATAL] env creds detected: ' + ($hits -join ', ')) -ForegroundColor Red
    Write-Host 'Refusing to start ANY instance: the variables would override qqbot.creds.json and'
    Write-Host 'can point several projects at the same bot account.'
    Write-Host 'Fix: remove QQ_BOT_* from Process/User/Machine, or set QQBOT_ALLOW_ENV_CREDS=1.'
    exit 3
  }
}

# ---- start -------------------------------------------------------------------
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
  $qa = Join-Path $proj 'tools\qqbot'
  $startPs1 = Join-Path $qa 'start-service.ps1'
  if (-not (Test-Path -LiteralPath $startPs1)) {
    Write-Host ('[FAIL] ' + $proj + ' -> missing ' + $startPs1) -ForegroundColor Red
    $fail++
    continue
  }
  if ($DryRun) {
    Write-Host ('  [dry] powershell -File "' + $startPs1 + '"')
    if ($i.startWatchdog -ne $null -and -not $NoWatchdog) {
      Write-Host ('  [dry] powershell -File "' + (Join-Path $qa 'start-watchdog.ps1') + '"')
    }
    continue
  }
  Write-Host ''
  Write-Host ('-- ' + $proj + ' (port ' + $i.port + ')') -ForegroundColor Cyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startPs1
  $rc = $LASTEXITCODE
  if ($rc -eq 0) { $ok++ } else { Write-Host ('[FAIL] start-service.ps1 exit ' + $rc) -ForegroundColor Red; $fail++ }

  $wd = $true
  if ($null -ne $i.startWatchdog) { $wd = [bool]$i.startWatchdog }
  if (-not $NoWatchdog -and $wd) {
    $wdPs1 = Join-Path $qa 'start-watchdog.ps1'
    if (Test-Path -LiteralPath $wdPs1) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wdPs1
      $wrc = $LASTEXITCODE
      if ($wrc -ne 0) { Write-Host ('[FAIL] start-watchdog.ps1 exit ' + $wrc) -ForegroundColor Red; $fail++ }
    } else {
      Write-Host ('[SKIP] no start-watchdog.ps1 in ' + $qa) -ForegroundColor Yellow
      $skip++
    }
  }
}

Write-Host ''
Write-Host ('summary: ' + $ok + ' started / ' + $skip + ' skipped / ' + $fail + ' failed')
if ($fail -gt 0) { exit 2 }
exit 0
