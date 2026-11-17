param(
  # Target project root. Empty = derive from this script's location (<proj>\tools\qqbot).
  # When it differs from the script's own location, the toolkit is copied there first
  # (bootstrap mode) and this script re-runs itself from the copied location.
  [string]$ProjectRoot = '',

  # Credentials (all three required together). Leave all empty to reuse an existing
  # qqbot.creds.json or to be told to run qqbot-setup.js (the manual openid step).
  [string]$AppId = '',
  [string]$Secret = '',
  [string]$OpenId = '',

  # Copy credentials from another project's qqbot.creds.json (takes priority over AppId/Secret/OpenId).
  [string]$CredsSource = '',

  # Override daemon.config.json listenPort. 0 = keep template default (18765).
  [int]$Port = 0,

  # P1 (2026-11-17) multi-project parameters, contract in 03 tech plan 4.2.
  # ServePort: write headless.serve.port. 0 = leave untouched. It is NOT part of the
  #   uniqueness gate: 19000 is shared by tools/session-hub (start-serve.ps1:15) and a
  #   conflict only costs the headless takeover fallback (D-9).
  [int]$ServePort = 0,
  # WakeTaskName: write commands.wake.taskName. Default (empty) = keep the existing value
  #   so an already-installed project keeps its task and its history (D-10). Set
  #   'QQBot-WakeTimer-<port>' for a fresh project, otherwise two projects overwrite each
  #   other's wake timer and one /Delete removes the other's (03 tech plan 2.7).
  [string]$WakeTaskName = '',
  # NoHostEntry: do not touch <hostDir>\hosts.json (host layer managed elsewhere).
  [switch]$NoHostEntry,
  # LegacyAutostart: keep the old per-project autostart registration (install-service +
  #   install-watchdog) instead of writing a host manifest entry (D-7).
  [switch]$LegacyAutostart,

  [int]$HealthWaitSec = 60,

  # P1 (D-6): -Force no longer means "take over the host". It only (a) overwrites this
  # project's hosts.json entry and (b) skips the carrier conflict probe. The old
  # singleton warning is obsolete: the host layer holds one entry per project.
  [switch]$Force,

  # Overwrite an existing daemon.config.json with a fresh copy of the example (backup kept).
  # Kept separate from -Force on purpose: taking over a host must not silently wipe
  # handoffPrompt / quietHours / stallWatcher customisations.
  [switch]$ResetConfig,

  [switch]$NoDeps,      # skip the 'ws' dependency probe / npm install
  [switch]$NoService,   # skip autostart registration for the service (install-service.ps1)
  [switch]$NoWatchdog,  # skip autostart registration for the watchdog (install-watchdog.ps1)
  [switch]$NoHook,      # skip .codebuddy/settings.json Stop-hook registration
  [switch]$NoManifest,  # skip project.manifest.yaml notifications.adapter flip
  [switch]$NoStart,     # register autostart entries but do not launch anything

  # Distribution-only mode: copy the toolkit into <ProjectRoot>\tools\qqbot, then stop.
  # Entry point for the skill installer (scripts/install.ps1 -WithQqbot), which must never
  # trigger host-level steps. Since P1 (2026-11-17) the host-level surface is owned by
  # tools/qqbot/host/install-host.ps1 (one carrier set + hosts.json), so the steps after the
  # copy are per-PROJECT again -- but an unattended install must still not register anything.
  [switch]$CopyOnly,

  [switch]$DryRun
)

# install-all.ps1 -- one-command installer for the QQ bot toolkit in a NEW project.
#
# Why this exists (2026-10-28): the toolkit is distributed as a plain directory copy
# (iteration-workflow engine repo -> <proj>\tools\qqbot) and README documented 6 manual
# steps, of which THREE were routinely missed -> the install "looked done" but had no
# watchdog, no Stop hook, and QQ notifications silently disabled (manifest default none).
# This script makes the 8-step checklist executable and idempotent.
#
# Manual step that CANNOT be automated: the QQ-platform openid, which requires sending
# a real message from your phone to the bot (see qqbot-setup.js).
#
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
# Project root is always derived from $PSScriptRoot, never a CJK literal.

$ErrorActionPreference = 'Continue'

function Say([string]$m, [string]$c = '') {
  if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m }
}
function Step([string]$n) { Write-Host ''; Write-Host "[$n]" -ForegroundColor Cyan }
function Ok([string]$m) { Say "  [OK]   $m" 'Green'; $script:OkCount++ }
function Skip([string]$m) { Say "  [SKIP] $m" 'DarkGray'; $script:SkipCount++ }
function Warn([string]$m) { Say "  [WARN] $m" 'Yellow' }
function Manual([string]$m) { Say "  [TODO] $m" 'Yellow'; $script:ManualItems += $m }

# Rewrite the FIRST "valueKey": <old> that appears after the line holding "anchorKey".
# Why line-based instead of ConvertFrom-Json -> ConvertTo-Json: a full round-trip
# reformats the whole 150-line instance config, which makes a one-value change
# unreviewable. Returns $false when the anchor is missing -- callers MUST treat that as
# "not written" (a silent no-op here would leave the port/task name at the old value).
function Set-JsonScalarAfter([string]$path, [string]$anchorKey, [string]$valueKey, [string]$newValue) {
  $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)
  $ai = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ('"' + [regex]::Escape($anchorKey) + '"\s*:')) { $ai = $i; break }
  }
  if ($ai -lt 0) { return $false }
  $pat = '^(\s*"' + [regex]::Escape($valueKey) + '"\s*:\s*)(\d+|"[^"]*")(\s*,?\s*)$'
  for ($j = $ai; $j -lt $lines.Count; $j++) {
    $m = [regex]::Match($lines[$j], $pat)
    if ($m.Success) {
      $rendered = if ($newValue -match '^\d+$') { $newValue } else { '"' + $newValue + '"' }
      $lines[$j] = $m.Groups[1].Value + $rendered + $m.Groups[3].Value
      [IO.File]::WriteAllLines($path, $lines, (New-Object System.Text.UTF8Encoding($false)))
      return $true
    }
  }
  return $false
}

$script:OkCount = 0
$script:SkipCount = 0
$script:ManualItems = @()

# -- path resolution ------------------------------------------------
$selfDir = $PSScriptRoot
if (-not $ProjectRoot) {
  $proj = (Resolve-Path (Join-Path $selfDir '..\..')).Path
} else {
  if (-not (Test-Path -LiteralPath $ProjectRoot)) {
    Say "FATAL: project root not found: $ProjectRoot" 'Red'; exit 1
  }
  $proj = (Resolve-Path -LiteralPath $ProjectRoot).Path
}
$targetQq = Join-Path $proj 'tools\qqbot'
$bootstrap = ($selfDir.TrimEnd('\') -ne $targetQq.TrimEnd('\'))

# Shared rules (process scope / port / env creds / host manifest). Dot-sourced from the
# SOURCE side so bootstrap mode has it before the copy happens.
$commonPs1 = Join-Path $selfDir '_qqbot-common.ps1'
if (Test-Path -LiteralPath $commonPs1) { . $commonPs1 }

Say '============================================================' 'Cyan'
Say ' tools/qqbot one-command installer (install-all.ps1)' 'Cyan'
Say '============================================================' 'Cyan'
Say "  source : $selfDir"
Say "  target : $targetQq"
Say "  project: $proj"
if ($DryRun) { Say '  MODE   : DRY-RUN (nothing will be written or launched)' 'Yellow' }
if ($bootstrap) { Say '  MODE   : BOOTSTRAP (copy first, then re-run in place)' 'Yellow' }

# -- toolkit copy (shared by bootstrap and -DryRun reporting) -------
function Copy-Toolkit([string]$src, [string]$dst, [bool]$dry) {
  $exDirs = @('node_modules', 'runtime')
  # Instance files + the 0010 gate negative-probe residue (test artifact, also excluded by
  # sync-skills.ps1 $ExcludeRelExact and the engine repo .gitignore -- keep the three in sync).
  $exFiles = @('daemon.config.json', 'qqbot.creds.json', 'DECOUPLING-PLAN.md', '.gate-negative-probe.txt')
  $exExt = @('.log', '.jsonl')
  $copied = 0
  $skipped = 0
  Get-ChildItem -LiteralPath $src -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart('\')
    $parts = $rel -split '\\'
    $skip = $false
    foreach ($p in $parts) { if ($exDirs -contains $p) { $skip = $true } }
    if (-not $skip -and ($exFiles -contains $_.Name)) { $skip = $true }
    if (-not $skip -and ($exExt -contains $_.Extension.ToLower())) { $skip = $true }
    if ($skip) { $skipped++; return }
    if (-not $dry) {
      $to = Join-Path $dst $rel
      $parent = Split-Path $to -Parent
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      Copy-Item -LiteralPath $_.FullName -Destination $to -Force
    }
    $copied++
  }
  return @{ copied = $copied; skipped = $skipped }
}

# -- copy-only mode (skill installer entry point, 2026-10-28) --------
# scripts/install.ps1 -WithQqbot delegates the copy here so that the exclusion list
# (instance config / creds / logs / runtime) has exactly ONE owner. A second copy of that
# list in the skill installer would drift, and the failure mode is silent: qqbot.creds.json
# (contains the secret) would be copied into the new project and could be committed.
# Everything below this block is host-level (shortcut / scheduled task / port 18765) and
# must stay out of an unattended skill install.
if ($CopyOnly) {
  Step '0/9 copy toolkit into the target project (copy-only mode)'
  if ($bootstrap) {
    $r = Copy-Toolkit $selfDir $targetQq $DryRun.IsPresent
    $verb = if ($DryRun) { 'would copy' } else { 'copied' }
    Say ("  $verb {0} file(s); {1} instance/runtime file(s) excluded (config/creds/logs/runtime)" -f $r.copied, $r.skipped)
    if (-not $DryRun) {
      $entry = Join-Path $targetQq 'install-all.ps1'
      if (-not (Test-Path -LiteralPath $entry)) {
        Say "FATAL: copy incomplete -- $entry missing" 'Red'
        exit 1
      }
      $script:OkCount++
    }
  } else {
    Skip 'source == target, nothing to copy'
  }
  Say ''
  Say '  copy-only: skipped conflict check / ws / creds / config / hook / manifest / autostart / health' 'Yellow'
  Say "  next    : powershell -NoProfile -ExecutionPolicy Bypass -File `"$targetQq\install-all.ps1`"  (run it in your project)" 'Yellow'
  exit 0
}

if ($bootstrap) {
  Step '0/9 copy toolkit into the target project'
  $r = Copy-Toolkit $selfDir $targetQq $DryRun.IsPresent
  $verb = if ($DryRun) { 'would copy' } else { 'copied' }
  Say ("  $verb {0} file(s); {1} instance/runtime file(s) excluded (config/creds/logs/runtime)" -f $r.copied, $r.skipped)
  if (-not $DryRun) { $script:OkCount++ }
  if ($DryRun) {
    Say ''
    Say "  [dry] next: powershell -File `"$targetQq\install-all.ps1`" -ProjectRoot `"$proj`" ..." 'Yellow'
    exit 0
  }
  $selfTarget = Join-Path $targetQq 'install-all.ps1'
  if (-not (Test-Path -LiteralPath $selfTarget)) {
    Say "FATAL: re-entry script missing after copy: $selfTarget" 'Red'; exit 1
  }
  $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$selfTarget`"",
                 '-ProjectRoot', "`"$proj`"", '-HealthWaitSec', "$HealthWaitSec")
  if ($AppId) { $childArgs += @('-AppId', "`"$AppId`"") }
  if ($Secret) { $childArgs += @('-Secret', "`"$Secret`"") }
  if ($OpenId) { $childArgs += @('-OpenId', "`"$OpenId`"") }
  if ($CredsSource) { $childArgs += @('-CredsSource', "`"$CredsSource`"") }
  if ($Port -gt 0) { $childArgs += @('-Port', "$Port") }
  if ($ServePort -gt 0) { $childArgs += @('-ServePort', "$ServePort") }
  if ($WakeTaskName) { $childArgs += @('-WakeTaskName', "`"$WakeTaskName`"") }
  if ($NoHostEntry) { $childArgs += '-NoHostEntry' }
  if ($LegacyAutostart) { $childArgs += '-LegacyAutostart' }
  if ($Force) { $childArgs += '-Force' }
  if ($ResetConfig) { $childArgs += '-ResetConfig' }
  if ($NoDeps) { $childArgs += '-NoDeps' }
  if ($NoService) { $childArgs += '-NoService' }
  if ($NoWatchdog) { $childArgs += '-NoWatchdog' }
  if ($NoHook) { $childArgs += '-NoHook' }
  if ($NoManifest) { $childArgs += '-NoManifest' }
  if ($NoStart) { $childArgs += '-NoStart' }
  Say ''
  Say '  re-running from the target location...'
  & powershell.exe @childArgs
  exit $LASTEXITCODE
}

# -- single-host conflict probe ------------------------------------
# Why (2026-10-28): per-project instances are singletons on one host -- the Startup
# shortcut name (CodeBuddyQQWatcher.lnk) is fixed, the watchdog task name is fixed, and
# the port is fixed. A second install therefore SILENTLY hijacks the first one: the first
# project simply stops receiving notifications. Detect it BEFORE writing anything.
# Identity is compared on <proj>\tools\qqbot (not the project root): a nested sandbox dir
# under another project would otherwise look like "the same project".
function Test-HostConflict([int]$port, [bool]$portOnly) {
  $bad = $false

  $listenPid = 0
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try {
      $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($conn) { $listenPid = [int]$conn.OwningProcess }
    } catch { $listenPid = 0 }
  }
  if ($listenPid -gt 0) {
    $pc = ''
    try { $pc = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$listenPid" -ErrorAction Stop).CommandLine } catch { $pc = '' }
    if ($pc -and $pc.IndexOf($targetQq, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Skip "port $port already served by THIS project's service (pid $listenPid)"
    } else {
      Warn "port $port is already LISTENING (pid $listenPid) -> another qqbot instance"
      Warn 'installing here would fight for the port and hijack that instance'
      $bad = $true
    }
  } else {
    Skip "port $port free"
  }
  if ($portOnly) { return $bad }

  $startupDir = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startupDir 'CodeBuddyQQWatcher.lnk'
  if (Test-Path -LiteralPath $lnk) {
    $lnkArgs = ''
    try {
      $wsh = New-Object -ComObject WScript.Shell
      $lnkArgs = [string]($wsh.CreateShortcut($lnk)).Arguments
    } catch { $lnkArgs = '' }
    if ($lnkArgs -and $lnkArgs.IndexOf($targetQq, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      Warn 'Startup shortcut CodeBuddyQQWatcher.lnk points to ANOTHER project -> it would be overwritten'
      $bad = $true
    } else {
      Skip 'Startup shortcut already points here'
    }
  } else {
    Skip 'no Startup shortcut (watchdog scheduled task is the active autostart carrier)'
  }

  $taskName = 'CodeBuddyQQWatchdog'
  $taskArgs = ''
  try { $taskArgs = [string]((Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).Actions[0].Arguments) } catch { $taskArgs = '' }
  if ($taskArgs -and $taskArgs.IndexOf($targetQq, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Warn "scheduled task $taskName points to ANOTHER project -> it would be re-pointed here"
    $bad = $true
  } elseif ($taskArgs) {
    Skip "scheduled task $taskName already points here"
  } else {
    Skip "no scheduled task $taskName yet"
  }

  # * TOOL-SELFHEAL-2 (2026-11-03): the HKCU Run key is now a third carrier, so it MUST join the
  #   singleton probe. Without this, a second project silently hijacks the first one by overwriting
  #   the Run value while the .lnk / task probes above both report "no conflict".
  $runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  foreach ($rn in @('CodeBuddyQQService', 'CodeBuddyQQWatchdog')) {
    $rv = ''
    try { $rv = [string](Get-ItemProperty -Path $runKeyPath -Name $rn -ErrorAction Stop).$rn } catch { $rv = '' }
    if (-not $rv) {
      Skip "no Run-key carrier $rn yet"
    } elseif ($rv.IndexOf($targetQq, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      Warn "Run key $rn points to ANOTHER project -> it would be overwritten"
      $bad = $true
    } else {
      Skip "Run key $rn already points here"
    }
  }
  return $bad
}

# -- 1 preflight ----------------------------------------------------
Step '1/9 preflight'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($c in @('C:\nvm4w\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'nvm4w\nodejs\node.exe'))) {
    if (Test-Path -LiteralPath $c) { $nodeExe = $c; break }
  }
}
if (-not $nodeExe) { Say 'FATAL: node not found (install Node 16+ or add it to PATH)' 'Red'; exit 1 }
Ok "node: $nodeExe"

$svcJs = Join-Path $targetQq 'qqbot-service.js'
$example = Join-Path $targetQq 'daemon.config.example.json'
if (-not (Test-Path -LiteralPath $svcJs)) { Say "FATAL: incomplete toolkit, missing $svcJs" 'Red'; exit 1 }
if (-not (Test-Path -LiteralPath $example)) { Say "FATAL: incomplete toolkit, missing $example" 'Red'; exit 1 }
Ok 'toolkit files present'

# -- 2 carrier conflict check (informational since P1) --------------
# P1 (2026-11-17, D-6): carriers are no longer per-project singletons -- the host layer
# owns them and hosts.json holds one entry per project. So a conflicting carrier is a
# WARN, not an abort; only the PORT stays a hard gate (checked at launch, exit 4).
Step '2/9 carrier conflict check (informational) / port'
$prePort = if ($Port -gt 0) { $Port } else { Get-QqbotListenPort $targetQq }
if ($Force) {
  Skip 'carrier conflict check skipped (-Force): manifest entry will be overwritten'
} elseif (Test-HostConflict -port $prePort -portOnly $false) {
  Warn 'legacy carriers point at another project. P1 does not abort here (D-6).'
  Warn 'The port is still enforced at start-service.ps1 (exit 4) and the host layer owns'
  Warn 'the carriers after install-host.ps1 -- do not run -RetireLegacy until start-all works.'
} else {
  Ok 'no conflicting carrier on this host'
}

# -- 3 ws dependency ------------------------------------------------
Step '3/9 node dependency: ws'
if ($NoDeps) {
  Skip 'skipped (-NoDeps)'
} else {
  $wsOk = $false
  Push-Location $targetQq
  try { & $nodeExe -e "require('ws')" 2>$null | Out-Null; $wsOk = ($LASTEXITCODE -eq 0) } catch { $wsOk = $false }
  Pop-Location
  if ($wsOk) {
    Skip "'ws' already resolvable"
  } elseif ($DryRun) {
    Say "  [dry] would run: npm install ws  (in $targetQq)"
  } else {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { Warn 'npm not found -> run "npm install ws" in the project root manually'; Manual 'npm install ws' }
    else {
      Push-Location $targetQq
      & $npm.Source install ws --no-audit --no-fund 2>&1 | ForEach-Object { Write-Host "    $_" }
      $code = $LASTEXITCODE
      Pop-Location
      if ($code -eq 0) {
        Push-Location $targetQq
        & $nodeExe -e "require('ws')" 2>$null | Out-Null
        $wsOk = ($LASTEXITCODE -eq 0)
        Pop-Location
        if ($wsOk) { Ok "'ws' installed" } else { Warn 'npm returned 0 but require(ws) still fails'; Manual 'npm install ws' }
      } else {
        Warn "npm install failed (exit $code)"; Manual 'npm install ws'
      }
    }
  }
}

# -- 3 credentials --------------------------------------------------
Step '4/9 credentials (qqbot.creds.json)'
$credsPath = Join-Path $targetQq 'qqbot.creds.json'
$credMissing = $false
$haveCreds = $false
if (Test-Path -LiteralPath $credsPath) {
  try {
    $cur = Get-Content -LiteralPath $credsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cur.appId -and $cur.secret) { $haveCreds = $true }
  } catch { $haveCreds = $false }
}

$wantExplicit = [bool]($AppId -and $Secret)
if ($CredsSource) {
  if (-not (Test-Path -LiteralPath $CredsSource)) {
    Say "FATAL: -CredsSource not found: $CredsSource" 'Red'; exit 1
  }
  if ($DryRun) { Say "  [dry] would copy credentials: $CredsSource -> $credsPath" }
  else {
    Copy-Item -LiteralPath $CredsSource -Destination $credsPath -Force
    Ok "credentials copied from $CredsSource"
    $haveCreds = $true
  }
} elseif ($wantExplicit) {
  if (-not $OpenId) {
    Warn 'AppId/Secret given but OpenId is empty -> creds left untouched (need all three)'
    Manual 'pass -OpenId too, or reuse -CredsSource'
    # Must count as "no credentials": otherwise step 8 would register autostart and every
    # logon would die with [FATAL] (service exits when appId/secret/openId are incomplete).
    if (-not $haveCreds) { $credMissing = $true }
  } elseif ($DryRun) {
    Say "  [dry] would write $credsPath (appId=$AppId, openId=$OpenId)"
  } else {
    $obj = [ordered]@{ appId = $AppId; secret = $Secret; openId = $OpenId }
    [IO.File]::WriteAllText($credsPath, ($obj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    Ok 'credentials written from parameters'
    $haveCreds = $true
  }
} elseif ($haveCreds) {
  Skip 'existing qqbot.creds.json reused'
} else {
  Warn 'no usable credentials yet (service exits FATAL without them, watchdog stays silent)'
  Manual 'run "node qqbot-setup.js" in tools\qqbot (needs AppID/Secret + one phone message for openid), then re-run this script'
  $credMissing = $true
}

# -- 4 daemon.config.json -------------------------------------------
Step '5/9 instance config (daemon.config.json)'
$cfgPath = Join-Path $targetQq 'daemon.config.json'
$cfgExisted = Test-Path -LiteralPath $cfgPath
if (-not $cfgExisted) {
  if ($DryRun) { Say "  [dry] would copy daemon.config.example.json -> daemon.config.json" }
  else { Copy-Item -LiteralPath $example -Destination $cfgPath -Force; Ok 'daemon.config.json created from example' }
} elseif ($ResetConfig) {
  if ($DryRun) { Say '  [dry] would back up and overwrite daemon.config.json from example' }
  else {
    $bak = "$cfgPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item -LiteralPath $cfgPath -Destination $bak -Force
    Copy-Item -LiteralPath $example -Destination $cfgPath -Force
    Ok "daemon.config.json overwritten from example (backup: $bak)"
  }
} else {
  Skip 'daemon.config.json exists (kept; use -ResetConfig to reset from example)'
}

$effPort = Get-QqbotListenPort $targetQq
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $cfgObj = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfgObj.listenPort) { $effPort = [int]$cfgObj.listenPort }
  } catch { Warn 'daemon.config.json is not valid JSON -> fix it before starting the service' }
}

if ($Port -gt 0) {
  if ($Port -gt 65535) { Say "FATAL: -Port out of range: $Port" 'Red'; exit 1 }
  if (-not (Test-Path -LiteralPath $cfgPath)) { Skip 'port override deferred (config not created in dry-run)' }
  elseif ($effPort -eq $Port) { Skip "listenPort already $Port" }
  elseif ($DryRun) { Say "  [dry] would set listenPort $effPort -> $Port in daemon.config.json" }
  else {
    $raw = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8
    $raw = $raw -replace '"listenPort"\s*:\s*\d+', "`"listenPort`": $Port"
    [IO.File]::WriteAllText($cfgPath, $raw, (New-Object System.Text.UTF8Encoding($false)))
    Ok "listenPort set to $Port"
    $effPort = $Port
  }
}
# P1: headless serve port (D-9, registered only -- 19000 is shared) and wake task name
# (D-10, must be unique per project or two projects overwrite each other's timer).
if ($ServePort -gt 0) {
  if ($ServePort -gt 65535) { Say "FATAL: -ServePort out of range: $ServePort" 'Red'; exit 1 }
  if (-not (Test-Path -LiteralPath $cfgPath)) {
    Skip 'servePort override deferred (config not created in dry-run)'
  } elseif ($DryRun) {
    Say "  [dry] would set headless.serve.port -> $ServePort in daemon.config.json"
  } elseif (Set-JsonScalarAfter $cfgPath 'serve' 'port' "$ServePort") {
    Ok "headless.serve.port set to $ServePort"
  } else {
    Warn 'anchor "serve" / "port" not found in daemon.config.json'
    Manual "set headless.serve.port=$ServePort manually"
  }
}
if ($WakeTaskName) {
  if (-not (Test-Path -LiteralPath $cfgPath)) {
    Skip 'wake task name deferred (config not created in dry-run)'
  } elseif ($DryRun) {
    Say "  [dry] would set commands.wake.taskName -> $WakeTaskName in daemon.config.json"
  } elseif (Set-JsonScalarAfter $cfgPath 'wake' 'taskName' $WakeTaskName) {
    Ok "commands.wake.taskName set to $WakeTaskName"
  } else {
    Warn 'anchor "wake" / "taskName" not found in daemon.config.json'
    Manual "set commands.wake.taskName=$WakeTaskName manually"
  }
}

if ($cfgExisted -and -not $ResetConfig) {
  # Not a blocker: the example defaults are runnable. Only headless handoff carries a
  # real cross-project risk (an inherited handoffPrompt may point at another project).
  Warn 'daemon.config.json kept as-is -> review watcher.handoffPrompt / headless.command / stallWatcher.workspaceHash before enabling headless handoff'
}

# -- 5b re-check: the effective port may differ from the pre-check one --
if ($effPort -ne $prePort) {
  Step '5b/9 port re-check after config'
  $c2 = Test-HostConflict -port $effPort -portOnly $true
  if ($c2 -and -not $Force) {
    Say ''
    Say "FATAL: port $effPort (from daemon.config.json) is owned by another instance." 'Red'
    Say '       Change listenPort, stop the other instance, or re-run with -Force.' 'Red'
    exit 1
  }
}

# -- 6 Stop hook in .codebuddy/settings.json -----------------------
Step '6/9 .codebuddy/settings.json Stop hook (done notification)'
$settingsPath = Join-Path $proj '.codebuddy\settings.json'
$hookCmd = 'node tools/qqbot/notify.qqbot.js --kind done --fallback'
if ($NoHook) {
  Skip 'skipped (-NoHook)'
} else {
  $already = $false
  $raw = ''
  if (Test-Path -LiteralPath $settingsPath) {
    $raw = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8
    if ($raw -match [regex]::Escape('notify.qqbot.js')) { $already = $true }
  }
  if ($already) {
    Skip 'notify.qqbot.js already registered'
  } elseif ($DryRun) {
    Say "  [dry] would register Stop hook: $hookCmd"
  } else {
    $hookEntry = [PSCustomObject]@{ type = 'command'; command = $hookCmd; timeout = 30 }
    $bak = $null
    if (Test-Path -LiteralPath $settingsPath) {
      $bak = "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
      Copy-Item -LiteralPath $settingsPath -Destination $bak -Force
      $json = $raw | ConvertFrom-Json
      if ($null -eq $json.hooks) { $json | Add-Member -NotePropertyName hooks -NotePropertyValue ([PSCustomObject]@{}) -Force }
      if ($null -eq $json.hooks.Stop) { $json.hooks | Add-Member -NotePropertyName Stop -NotePropertyValue @() -Force }
      $stopArr = @($json.hooks.Stop)
      if ($stopArr.Count -eq 0) {
        $json.hooks.Stop = @([PSCustomObject]@{ hooks = @($hookEntry) })
      } else {
        $stopArr[0].hooks = @($stopArr[0].hooks) + $hookEntry
        $json.hooks.Stop = $stopArr
      }
      $out = $json | ConvertTo-Json -Depth 20
      [IO.File]::WriteAllText($settingsPath, $out, (New-Object System.Text.UTF8Encoding($false)))
      # write-back self check: single-element array collapse makes the IDE silently ignore hooks
      $chk = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8
      if ($chk -notmatch [regex]::Escape('notify.qqbot.js') -or $chk -match '"Stop"\s*:\s*\{') {
        Warn "settings.json write-back looks wrong -> restore $bak manually"
        Manual "restore settings.json from $bak or add Stop hook manually: $hookCmd"
      } else {
        Ok "Stop hook registered (backup: $bak)"
      }
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $settingsPath -Parent) | Out-Null
      $obj = [ordered]@{ hooks = [ordered]@{ Stop = @([ordered]@{ hooks = @($hookEntry) }) } }
      [IO.File]::WriteAllText($settingsPath, ($obj | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
      Ok 'settings.json created with Stop hook'
    }
  }
}

# -- 6 manifest notifications.adapter ------------------------------
Step '7/9 project.manifest.yaml notifications.adapter'
$mp = Join-Path $proj '.codebuddy\skills\iteration-workflow\project\project.manifest.yaml'
if ($NoManifest) {
  Skip 'skipped (-NoManifest)'
} elseif (-not (Test-Path -LiteralPath $mp)) {
  Warn 'manifest not found -> install the iteration-workflow skill first (scripts/install.ps1)'
  Manual 'after the skill is installed, re-run this script to flip notifications.adapter to qqbot'
} else {
  $mraw = Get-Content -LiteralPath $mp -Raw -Encoding UTF8
  if ($mraw -match '(?m)^notifications:\s*\r?\n\s+adapter:\s*"?qqbot"?\s*$') {
    Skip 'notifications.adapter already "qqbot"'
  } elseif ($DryRun) {
    Say '  [dry] would set notifications.adapter = "qqbot"'
  } else {
    $lines = [System.Collections.ArrayList]::new()
    foreach ($l in ($mraw -split "`r?`n")) { [void]$lines.Add($l) }
    $ni = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^notifications:\s*$') { $ni = $i; break } }
    $msg = ''
    if ($ni -lt 0) {
      [void]$lines.Add('')
      [void]$lines.Add('notifications:')
      [void]$lines.Add('  adapter: "qqbot"')
      $msg = 'notifications block appended with adapter: qqbot'
    } else {
      $end = $lines.Count
      for ($j = $ni + 1; $j -lt $lines.Count; $j++) { if ($lines[$j] -match '^\S') { $end = $j; break } }
      $found = -1
      for ($j = $ni + 1; $j -lt $end; $j++) { if ($lines[$j] -match '^\s+adapter:') { $found = $j; break } }
      if ($found -ge 0) { $lines[$found] = '  adapter: "qqbot"' } else { $lines.Insert($ni + 1, '  adapter: "qqbot"') }
      $msg = 'notifications.adapter set to qqbot'
    }
    # Write-back MUST be outside the branches: the append path previously only printed OK
    # and never touched the file (silent no-op, found by the 2026-10-28 D-drive rehearsal).
    $bak = "$mp.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item -LiteralPath $mp -Destination $bak -Force
    [IO.File]::WriteAllText($mp, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    Ok "$msg (backup: $bak)"
  }
}

# -- 7 autostart: host manifest by default (D-7) --------------------
# Why the default flipped (2026-11-17): per-project carriers are singletons, so a second
# project used to silently hijack the first one's logon autostart. The host layer now owns
# exactly one carrier set and reads hosts.json; this script only registers the project in
# that manifest and tells the user to run start-all.ps1.
Step '8/9 autostart / host manifest entry'
if ($credMissing) {
  Skip 'deferred: no credentials yet -> autostart or a manifest entry would just fail at every logon'
  Manual 'complete step 3 (qqbot-setup.js), then re-run this script'
} elseif ($LegacyAutostart) {
  # Old behaviour, kept because rollback-host.ps1 rebuilds carriers through these two
  # installers and because a project may not want the host layer at all.
  if ($NoService) {
    Skip 'service autostart skipped (-NoService)'
  } elseif ($DryRun) {
    Say '  [dry] would run install-service.ps1 (Startup shortcut + Run key + stop old + start)'
  } else {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $targetQq 'install-service.ps1')`"")
    if ($NoStart) { $a += '-NoStart' }
    & powershell.exe @a
    if ($LASTEXITCODE -eq 0) { Ok 'service autostart registered' } else { Warn "install-service.ps1 exit $LASTEXITCODE"; Manual 'run install-service.ps1 manually' }
  }

  if ($NoWatchdog) {
    Skip 'watchdog autostart skipped (-NoWatchdog)'
  } elseif ($DryRun) {
    Say '  [dry] would run install-watchdog.ps1 (scheduled task + Run key + start)'
  } else {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $targetQq 'install-watchdog.ps1')`"")
    if ($NoStart) { $a += '-NoStart' }
    & powershell.exe @a
    if ($LASTEXITCODE -eq 0) { Ok 'watchdog autostart registered' } else { Warn "install-watchdog.ps1 exit $LASTEXITCODE"; Manual 'run install-watchdog.ps1 manually' }
  }
} else {
  $hostDir = Get-QqbotHostDir
  if ($NoHostEntry) {
    Skip 'host manifest entry skipped (-NoHostEntry)'
  } elseif (-not $hostDir) {
    Warn 'LOCALAPPDATA is empty -> cannot locate the host directory'
    Manual 'add the entry to hosts.json manually (see tools/qqbot/host/hosts.example.json)'
  } else {
    $cfgForEntry = Get-QqbotConfig $targetQq
    $entryAppId = ''
    if (Test-Path -LiteralPath $credsPath) {
      try {
        $entryAppId = [string]((Get-Content -LiteralPath $credsPath -Raw -Encoding UTF8 | ConvertFrom-Json).appId)
      } catch { $entryAppId = '' }
    }
    $entrySimulateKey = ''
    if ($cfgForEntry -and $cfgForEntry.hub) { $entrySimulateKey = [string]$cfgForEntry.hub.simulateKey }
    $entryServePort = 0
    if ($cfgForEntry -and $cfgForEntry.headless -and $cfgForEntry.headless.serve) {
      $entryServePort = [int]$cfgForEntry.headless.serve.port
    }
    $entry = [pscustomobject][ordered]@{
      project       = $proj
      port          = $effPort
      servePort     = $entryServePort
      appId         = $entryAppId
      role          = 'gateway'
      simulateKey   = $entrySimulateKey
      enabled       = $true
      startWatchdog = $true
    }
    if ($DryRun) {
      Say ("  [dry] would upsert {0}\hosts.json: project={1} port={2} servePort={3} appId={4}" -f $hostDir, $proj, $effPort, $entryServePort, $entryAppId)
    } else {
      $up = Update-QqbotHostEntry $hostDir $entry
      if ($up.Ok) {
        $verb = if ($up.Replaced) { 'entry refreshed' } else { 'entry added' }
        Ok ("host manifest {0}; {1} instance(s) in {2}" -f $verb, $up.Count, $up.Path)
      } else {
        Warn ('host manifest write failed: ' + $up.Error)
        Manual "upsert $hostDir\hosts.json for $proj manually"
      }
    }
    if (-not $entrySimulateKey) {
      Warn 'simulateKey is empty in daemon.config.json -> the host layer will warn on every start'
    }
    Say ("  next   : powershell -NoProfile -ExecutionPolicy Bypass -File `"$hostDir\start-all.ps1`"") 'Yellow'
    Say '           (starts every enabled instance in the manifest; nothing was launched here)' 'Yellow'
  }
}

# -- 8 health check ------------------------------------------------
Step '9/9 health check (GET /health)'
if ($DryRun) {
  Say "  [dry] would poll http://127.0.0.1:$effPort/health for ${HealthWaitSec}s"
} elseif ($credMissing -or $NoStart -or $NoService -or (-not $LegacyAutostart)) {
  Skip 'skipped (nothing launched in this run; the host layer starts instances via start-all.ps1)'
} else {
  $up = $false
  $deadline = (Get-Date).AddSeconds($HealthWaitSec)
  Start-Sleep -Seconds 3
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$effPort/health" -TimeoutSec 3
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) { $up = $true; break }
    } catch { }
    Start-Sleep -Seconds 3
  }
  if ($up) { Ok "service healthy on port $effPort" }
  else {
    Warn "no /health response within ${HealthWaitSec}s"
    Say '       first start may spend 1-2 min scanning logs/index -> recheck manually:' -ForegroundColor Yellow
    Say "       curl http://127.0.0.1:$effPort/health   (log: $targetQq\service.log)" -ForegroundColor Yellow
    Manual "verify /health on port $effPort"
  }
}

# -- summary -------------------------------------------------------
Say ''
Say '============================================================' 'Cyan'
Say (" summary: {0} ok / {1} skipped / {2} todo" -f $script:OkCount, $script:SkipCount, $script:ManualItems.Count) 'Cyan'
Say '============================================================' 'Cyan'
if ($script:ManualItems.Count -gt 0) {
  foreach ($m in $script:ManualItems) { Say "  TODO: $m" 'Yellow' }
  Say ''
  Say "  log    : $targetQq\service.log"
  Say "  health : http://127.0.0.1:$effPort/health"
  exit 2
}
Say "  log    : $targetQq\service.log"
Say "  health : http://127.0.0.1:$effPort/health"
Say '  next   : reply to a pending #N card in QQ to exercise the confirm loop;'
Say '           watch: tools\qqbot\watchdog.log'
exit 0
