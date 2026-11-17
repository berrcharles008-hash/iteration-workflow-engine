# _qqbot-common.ps1 -- single implementation of the multi-project isolation rules (P1).
#
# Why this file exists (2026-11-17): the same rules used to be copy-pasted as
# '*qqbot-service.js*' wildcard process matches into five project scripts. On a host
# that runs two projects each wildcard matched BOTH instances, so stopping project A
# silently killed project B (pain point #3) and a second install hijacked the first.
# Every project script dot-sources this file; no script may re-implement the rules.
#
# Contract (03 tech plan 4.3): process ownership is decided by the FULL path of the
# script, never by the bare file name.
#   hit  = normalized command line contains <normalized qaDir>\<scriptName>
#   norm = replace '/' with '\' -> TrimEnd('\') -> ToLowerInvariant()
# Scoped processes are ours; Unscoped ones belong to somebody else and must NEVER be
# killed -- they are printed only.
#
# ASCII-only on purpose: zh-CN PowerShell reads .ps1 as the system codepage unless BOM.
# Dot-source only: no output, no side effects, never throws (a broken config must not
# abort the caller before it can print a useful message).

function ConvertTo-PathKey([string]$p) {
  if (-not $p) { return '' }
  return ($p.Replace('/', '\').TrimEnd('\')).ToLowerInvariant()
}

function Get-QqbotConfig([string]$qaDir) {
  if (-not $qaDir) { return $null }
  $f = Join-Path $qaDir 'daemon.config.json'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  try { return (Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Get-QqbotListenPort([string]$qaDir) {
  $c = Get-QqbotConfig $qaDir
  if ($c -and $c.listenPort) { return [int]$c.listenPort }
  return 18765
}

# Three scopes on purpose (D-4): scanning only Process+User misses the case where a
# parent shell exports QQ_BOT_* and then launches the service, which is exactly the
# cross-project credential leak this gate exists for.
function Get-QqbotEnvCredHits() {
  $hits = @()
  foreach ($n in @('QQ_BOT_APPID', 'QQ_BOT_SECRET', 'QQ_BOT_OPENID')) {
    foreach ($s in @('Process', 'User', 'Machine')) {
      if ([Environment]::GetEnvironmentVariable($n, $s)) { $hits += ($n + '(' + $s + ')') }
    }
  }
  return $hits
}

# Returns @{ Scoped; Unscoped; UnscopedDetail }.
# -AnyProcess: legacy helpers (notify-watcher.ps1) run under powershell.exe, not node;
# the default node* filter would silently find nothing and leave the legacy process
# alive. Only the process NAME filter changes -- the path ownership rule does not.
function Get-QqbotProcs([string]$qaDir, [string]$scriptName, [switch]$AnyProcess) {
  $empty = @{ Scoped = @(); Foreign = @(); Unscoped = @(); UnscopedDetail = @() }
  if (-not $qaDir -or -not $scriptName) { return $empty }
  $suffix = '\' + $scriptName.ToLowerInvariant()
  $key = (ConvertTo-PathKey $qaDir) + $suffix
  $needle = '*' + $scriptName + '*'
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
           Where-Object {
             $_.CommandLine -and $_.CommandLine -like $needle -and
             ($AnyProcess -or $_.Name -like 'node*')
           })
  $scoped = @()
  $foreign = @()
  $unscoped = @()
  $detail = @()
  foreach ($p in $all) {
    $norm = ConvertTo-PathKey ([string]$p.CommandLine)
    if ($norm.Contains($key)) {
      $scoped += $p
    } elseif ($norm.Contains($suffix)) {
      # Another project's process, and its command line PROVES it (absolute path present).
      # This is the normal multi-project state, not an ambiguity: ignoring it is safe, and
      # treating it as "owner unknown" would stop a second project from ever starting.
      $foreign += $p
    } else {
      # No path at all in the command line (legacy `node qqbot-service.js`) -> ownership
      # genuinely unknown -> the caller must warn and refuse to start a duplicate.
      $unscoped += $p
      $cli = [string]$p.CommandLine
      if ($cli.Length -gt 80) { $cli = $cli.Substring(0, 80) + '...' }
      $detail += ('pid ' + $p.ProcessId + ' | ' + $cli)
    }
  }
  return @{ Scoped = $scoped; Foreign = $foreign; Unscoped = $unscoped; UnscopedDetail = $detail }
}

# Owning pid of a LISTEN socket, 0 when free/unknown. Why not `netstat` parsing: the
# gate has to distinguish "our own service already up" from "another project owns the
# port", so the caller needs the pid to read that process' command line.
function Get-QqbotPortOwnerPid([int]$port) {
  if ($port -le 0) { return 0 }
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return 0 }
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch { return 0 }
  return 0
}

function Get-QqbotProcCommandLine([int]$procId) {
  if ($procId -le 0) { return '' }
  try {
    return [string](Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId) -ErrorAction Stop).CommandLine
  } catch { return '' }
}

# Per-project instance tag appended to the service command line.
#
# Why needed (measured 2026-11-17): qqbot-watchdog.js turns QQBOT_WD_PROC_MATCH into a
# PowerShell -like pattern after stripping every char outside [\w.\-]
# (qqbot-watchdog.js:160). An absolute path therefore degrades to 'ESJYL...qqbot-service.js'
# and NEVER matches, which makes the watchdog believe the service is dead and restart it
# in a loop. The tag is pure ASCII, survives that sanitizer, and is unique per qaDir.
# qqbot-service.js ignores unknown argv entries (parseArgs only consumes known flags),
# so appending it changes no behaviour -- and qqbot-service.js stays untouched.
function Get-QqbotInstanceTag([string]$qaDir) {
  $key = ConvertTo-PathKey $qaDir
  if (-not $key) { return '' }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  try {
    $hash = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))
    $hex = -join ($hash[0..3] | ForEach-Object { $_.ToString('x2') })
    return ('--inst-' + $hex)
  } catch { return '' } finally { $md5.Dispose() }
}

function Get-QqbotHostDir() {
  if (-not $env:LOCALAPPDATA) { return '' }
  return (Join-Path $env:LOCALAPPDATA 'codebuddy-qqbot')
}

# Upsert one instance into <hostDir>\hosts.json.
#
# Two writers exist by design (install-all step 8 writes the entry, install-host is the
# host-layer owner), so the merge rule lives here and ONLY here: read, replace the record
# whose normalized project path matches, keep every other record untouched, write back as
# UTF-8 without BOM. A missing file is created, never silently skipped (a manifest that
# exists but lost a sibling entry is undetectable later).
# JSON is assembled by hand because ConvertTo-Json collapses a single-element array into
# an object, which would break the start-all contract (instances[] is always an array).
function Update-QqbotHostEntry([string]$hostDir, $entry, [switch]$WhatIf) {
  $res = @{ Ok = $false; Created = $false; Replaced = $false; Count = 0; Path = ''; Error = '' }
  if (-not $hostDir) { $res.Error = 'host dir is empty (LOCALAPPDATA missing?)'; return $res }
  if (-not $entry -or -not $entry.project) { $res.Error = 'entry.project is required'; return $res }
  $file = Join-Path $hostDir 'hosts.json'
  $res.Path = $file

  $instances = @()
  if (Test-Path -LiteralPath $file) {
    try {
      $doc = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($doc -and $null -ne $doc.instances) { $instances = @($doc.instances) }
    } catch {
      $res.Error = 'hosts.json is not valid JSON: ' + $_.Exception.Message
      return $res
    }
  } else {
    $res.Created = $true
  }

  $key = ConvertTo-PathKey ([string]$entry.project)
  $out = New-Object System.Collections.ArrayList
  $replaced = $false
  foreach ($i in $instances) {
    if ((ConvertTo-PathKey ([string]$i.project)) -eq $key) {
      if (-not $replaced) { [void]$out.Add($entry); $replaced = $true }
      # duplicate records for the same project collapse into one (idempotency)
    } else {
      [void]$out.Add($i)
    }
  }
  if (-not $replaced) { [void]$out.Add($entry) }
  $res.Replaced = $replaced
  $res.Count = $out.Count

  if ($WhatIf) { $res.Ok = $true; return $res }

  if (-not (Test-Path -LiteralPath $hostDir)) {
    New-Item -ItemType Directory -Force -Path $hostDir | Out-Null
  }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('{')
  [void]$sb.AppendLine('  "version": 1,')
  [void]$sb.AppendLine('  "instances": [')
  for ($n = 0; $n -lt $out.Count; $n++) {
    $line = ($out[$n] | ConvertTo-Json -Depth 5 -Compress)
    $sep = if ($n -lt ($out.Count - 1)) { ',' } else { '' }
    [void]$sb.AppendLine('    ' + $line + $sep)
  }
  [void]$sb.AppendLine('  ]')
  [void]$sb.AppendLine('}')
  try {
    [IO.File]::WriteAllText($file, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    $res.Ok = $true
  } catch {
    $res.Error = 'write failed: ' + $_.Exception.Message
  }
  return $res
}
