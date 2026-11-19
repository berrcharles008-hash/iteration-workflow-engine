# install-all.ps1 -- session-hub installer/registrar (OPTIONAL COMPONENT, shared-instance type)
#
# Type: SHARED / SINGLETON (see engine/../design/optional-component-distribution.md L5).
#   One process serves N projects; the instance list lives in hub.config.json -> projects[].
#   There is NO per-project copy of the code -- a second copy would fight for the same port.
#
# Positions:
#   source   : <engine repo>/tools/session-hub        (this script)
#   instance : %LOCALAPPDATA%\codebuddy-hub           (override with -TargetDir)
#
# Modes:
#   (bare)                      -> print state, then exit 1   [L2: no guessing paths]
#   -CopyOnly                   -> code only: missing -> staged
#   -ProjectRoot X -ProjectId Y -> register/upsert ONE project into projects[], then start
#   -DryRun                     -> print plan + state, change nothing
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\session-hub\install-all.ps1 `
#       -ProjectRoot "E:\path\to\project" -ProjectId 0010 -ProjectName "Project A" `
#       -HttpKey "<write key>" -QqOrigin "http://127.0.0.1:18765" -ServePort 19000 `
#       -DocKey "<doc key>" -DocTitle "Iteration docs"
#
# Exit codes: 0 ok / 2 ok but manual TODO / 1 environment or conflict error.
# ASCII-only on purpose (no CJK literals): PS 5.1 reads BOM-less UTF-8 as ANSI.

[CmdletBinding()]
param(
  [string]$ProjectRoot = '',
  [string]$ProjectId = '',
  [string]$ProjectName = '',
  [string]$TargetDir = '',
  [string]$HttpKey = '',
  [string]$QqOrigin = '',
  [int]$ServePort = 0,
  [string]$DocKey = '',
  [string]$DocPublicUrl = '',
  [string]$DocTitle = '',
  [switch]$CopyOnly,
  [switch]$DryRun,
  [switch]$NoStart,
  [switch]$NoAutostart,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- exclusions
# SINGLE OWNER of the exclusion list (spec L2 / checklist item 3).
# Never duplicate these patterns in the skill installer or the engine .gitignore.
$EXCLUDE_DIRS = @('sessions', 'logs', 'inputs', 'dialog-archive', 'probe-out', 'node_modules', '.git', 'runtime', '.playwright-cli')
$EXCLUDE_FILES = @('hub.config.json', 'hub-audit.jsonl', '*.log', '*.bak-*')

if (-not $TargetDir) { $TargetDir = Join-Path $env:LOCALAPPDATA 'codebuddy-hub' }
$target = [IO.Path]::GetFullPath($TargetDir)
$selfDir = [IO.Path]::GetFullPath($PSScriptRoot)
$cfgFile = Join-Path $target 'hub.config.json'
$exCfgFile = Join-Path $target 'hub.config.example.json'
$todo = New-Object System.Collections.ArrayList

function Write-Head([string]$s) { Write-Host ''; Write-Host ('=== ' + $s + ' ===') }

function Get-Cfg {
  if (-not (Test-Path $cfgFile)) { return $null }
  try { return (Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Get-CfgPort($cfg) {
  if ($cfg -and $cfg.port) { return [int]$cfg.port }
  return 18766
}

function Test-HubHealth([int]$port, [string]$projId) {
  $path = '/health'
  if ($projId) { $path = '/p/' + $projId + '/health' }
  try {
    Invoke-RestMethod -Method Get -Uri ('http://127.0.0.1:' + $port + $path) -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Three-state, project-scoped (spec L5.3):
#   missing          -> no code in the instance dir
#   staged           -> code present, but this project id is NOT in projects[]
#   enabled          -> in projects[] AND /p/<id>/health returns 200
#   enabled-degraded -> in projects[] but probe failed (port conflict / not running)
function Get-StateOf([string]$projId) {
  if (-not (Test-Path (Join-Path $target 'server.js'))) { return 'missing' }
  $cfg = Get-Cfg
  if (-not $cfg) { return 'staged' }
  if (-not $projId) { return 'staged' }
  $inList = @($cfg.projects | Where-Object { [string]$_.id -eq $projId }).Count -gt 0
  if (-not $inList) { return 'staged' }
  if (Test-HubHealth (Get-CfgPort $cfg) $projId) { return 'enabled' }
  return 'enabled-degraded'
}

function Show-State([string]$projId) {
  $code = 'missing'
  if (Test-Path (Join-Path $target 'server.js')) { $code = 'present' }
  $cfg = Get-Cfg
  $cfgTxt = 'missing'
  if ($cfg) {
    $ids = @($cfg.projects | ForEach-Object { [string]$_.id }) -join ','
    $cfgTxt = 'present (port ' + (Get-CfgPort $cfg) + ', default=' + [string]$cfg.default + ', projects=' + $ids + ')'
  }
  Write-Host ('[state] target  : ' + $target)
  Write-Host ('[state] code    : ' + $code)
  Write-Host ('[state] config  : ' + $cfgTxt)
  if ($projId) { Write-Host ('[state] project : ' + $projId + ' => ' + (Get-StateOf $projId)) }
}

function Save-Cfg($cfg) {
  # UTF8 WITHOUT BOM -- node's JSON.parse chokes on a BOM.
  $json = $cfg | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($cfgFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-CopyCode([string]$src, [string]$dst) {
  if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
  $rcArgs = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS')
  $rcArgs += '/XD'
  $rcArgs += $EXCLUDE_DIRS
  $rcArgs += '/XF'
  $rcArgs += $EXCLUDE_FILES
  & robocopy @rcArgs | Out-Null
  return $LASTEXITCODE
}

# ------------------------------------------------------------------ bare run
$noArgs = (-not $CopyOnly) -and (-not $ProjectRoot) -and (-not $ProjectId) -and (-not $DryRun)
if ($noArgs) {
  Write-Head 'session-hub installer (shared-instance)'
  Show-State ''
  Write-Host ''
  Write-Host 'Nothing to do: this installer needs an explicit project (L2: it never guesses paths).'
  Write-Host ''
  Write-Host 'First install (code only):'
  Write-Host '  install-all.ps1 -CopyOnly'
  Write-Host 'Register a project:'
  Write-Host '  install-all.ps1 -ProjectRoot <abs path> -ProjectId <id> [-ProjectName <name>]'
  Write-Host 'Query state:'
  Write-Host '  install-all.ps1 -DryRun'
  exit 1
}

# --------------------------------------------------- dry query (no registration)
if ($DryRun -and (-not $CopyOnly) -and (-not $ProjectRoot) -and (-not $ProjectId)) {
  Write-Head 'dry run (query only)'
  Show-State ''
  Write-Host ''
  Write-Host 'Nothing to register. Add -ProjectRoot + -ProjectId to preview a registration.'
  exit 0
}

# ------------------------------------------------------------------- copy step
$srcDir = $selfDir
if ($srcDir -eq $target) { $srcDir = '' }

if ($srcDir -and -not (Test-Path (Join-Path $srcDir 'server.js'))) {
  Write-Host ('[fail] source does not look like session-hub (missing server.js): ' + $srcDir)
  exit 1
}

if (-not $DryRun) {
  if ($srcDir) {
    Write-Head 'copy code'
    $rc = Invoke-CopyCode $srcDir $target
    if ($rc -ge 8) { Write-Host ('[fail] robocopy rc=' + $rc); exit 1 }
    Write-Host ('[copy] ' + $srcDir + ' -> ' + $target + ' (rc=' + $rc + ')')
  } else {
    Write-Host '[copy] skip: installer already lives in the instance dir (register-only mode)'
  }
} else {
  if ($srcDir) { Write-Host ('[dry] would copy ' + $srcDir + ' -> ' + $target) }
  else { Write-Host '[dry] installer already in instance dir; no copy' }
}

if ($CopyOnly) {
  Write-Head 'done (copy only)'
  Show-State ''
  Write-Host ''
  Write-Host 'Code is staged. Register a project to reach "enabled":'
  Write-Host '  install-all.ps1 -ProjectRoot <abs path> -ProjectId <id>'
  exit 0
}

# ------------------------------------------------------------- validate inputs
if (-not $ProjectRoot) {
  Write-Host '[fail] -ProjectRoot is required for registration (use -CopyOnly to only stage code).'
  Show-State ''
  exit 1
}
if (-not $ProjectId) {
  Write-Host '[fail] -ProjectId is required for registration (e.g. -ProjectId 0010).'
  exit 1
}
if ($ProjectId -notmatch '^[A-Za-z0-9_-]{1,32}$') {
  Write-Host '[fail] -ProjectId must match ^[A-Za-z0-9_-]{1,32}$ (it becomes a URL segment /p/<id>/).'
  exit 1
}
$rootFull = [IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path $rootFull)) {
  Write-Host ('[fail] project root does not exist: ' + $rootFull)
  exit 1
}
$rootNorm = $rootFull -replace '\\', '/'
if (-not $ProjectName) { $ProjectName = Split-Path $rootFull -Leaf }

# --------------------------------------------------------- config bootstrap
$cfg = Get-Cfg
$created = $false
if (-not $cfg) {
  if (-not (Test-Path $exCfgFile)) {
    # fall back to the source-side example (first install without robocopy of examples)
    $exSrc = Join-Path $srcDir 'hub.config.example.json'
    if ($srcDir -and (Test-Path $exSrc)) { $exCfgFile = $exSrc } else {
      Write-Host ('[fail] no config template: ' + $exCfgFile)
      exit 1
    }
  }
  $cfg = Get-Content $exCfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $cfg.projects = @()
  $cfg.default = ''
  $created = $true
}

$before = (@($cfg.projects | ForEach-Object { [string]$_.id }) -join ',')
$list = @($cfg.projects)
$idx = -1
for ($i = 0; $i -lt $list.Count; $i++) {
  if ([string]$list[$i].id -eq $ProjectId) { $idx = $i; break }
}

$action = 'added'
if ($idx -ge 0) {
  $old = $list[$idx]
  if (([string]$old.root -ne $rootNorm) -and (-not $Force)) {
    Write-Host ('[fail] project id ''' + $ProjectId + ''' is already registered with a different root:')
    Write-Host ('       existing: ' + [string]$old.root)
    Write-Host ('       requested: ' + $rootNorm)
    Write-Host '       Re-run with -Force to repoint it (the old root keeps its own files).'
    exit 1
  }
  $old.name = $ProjectName
  $old.root = $rootNorm
  if ($HttpKey) { $old.httpKey = $HttpKey }
  if ($QqOrigin) {
    if (-not $old.qq) { $old | Add-Member -NotePropertyName qq -NotePropertyValue ([pscustomobject]@{}) }
    $old.qq.origin = $QqOrigin
  }
  if ($ServePort -gt 0) {
    if (-not $old.serve) { $old | Add-Member -NotePropertyName serve -NotePropertyValue ([pscustomobject]@{}) }
    $old.serve.port = $ServePort
  }
  if ($DocKey) {
    if (-not $old.doc) { $old | Add-Member -NotePropertyName doc -NotePropertyValue ([pscustomobject]@{}) }
    $old.doc.key = $DocKey
  }
  if ($DocPublicUrl) { $old.doc.publicUrl = $DocPublicUrl }
  if ($DocTitle) { $old.doc.title = $DocTitle }
  $action = 'updated'
} else {
  $newProj = [pscustomobject][ordered]@{
    id      = $ProjectId
    name    = $ProjectName
    root    = $rootNorm
    httpKey = $HttpKey
    qq      = [pscustomobject][ordered]@{
      origin            = $(if ($QqOrigin) { $QqOrigin } else { 'http://127.0.0.1:18875' })
      key               = ''
      simulateKey       = ''
      answersDir        = '.codebuddy/temp/qq-answers'
      serviceLog        = 'tools/qqbot/service.log'
      serveInstanceFile = 'tools/qqbot/runtime/serve-instance.json'
      answersLimit      = 8
      logTailLines      = 30
      healthTimeoutMs   = 2500
    }
    doc     = [pscustomobject][ordered]@{
      key        = $DocKey
      publicUrl  = $DocPublicUrl
      title      = $(if ($DocTitle) { $DocTitle } else { 'Iteration docs' })
      extraFiles = @()
    }
    serve   = [pscustomobject][ordered]@{
      port              = $(if ($ServePort -gt 0) { $ServePort } else { 19000 })
      jobPermissionMode = 'bypassPermissions'
      idleTtlMs         = 1800000
      reapIntervalMs    = 300000
      reapEnabled       = $true
    }
  }
  $cfg.projects = @($list + $newProj)
}

$defaultSet = $false
if (-not $cfg.default) { $cfg.default = $ProjectId; $defaultSet = $true }
elseif (@($cfg.projects | Where-Object { [string]$_.id -eq [string]$cfg.default }).Count -eq 0) {
  $cfg.default = $ProjectId
  $defaultSet = $true
}

$after = (@($cfg.projects | ForEach-Object { [string]$_.id }) -join ',')

if ($DryRun) {
  Write-Head 'dry run (nothing written)'
  Write-Host ('[dry] project ' + $ProjectId + ' would be ' + $action + ' (root ' + $rootNorm + ')')
  Write-Host ('[dry] projects: [' + $before + '] -> [' + $after + ']')
  if ($defaultSet) { Write-Host ('[dry] default -> ' + $ProjectId) }
  if ($HttpKey) { Write-Host '[dry] httpKey would be set (value not echoed)' }
  Show-State $ProjectId
  exit 0
}

# ------------------------------------------------------------------- persist
Write-Head 'register project'
if ((Test-Path $cfgFile) -and (-not $created)) {
  $bak = $cfgFile + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $cfgFile $bak -Force
  Write-Host ('[cfg] backup: ' + (Split-Path $bak -Leaf))
}
Save-Cfg $cfg
Write-Host ('[cfg] project ' + $ProjectId + ' ' + $action + '; projects: [' + $before + '] -> [' + $after + ']')
if ($defaultSet) { Write-Host ('[cfg] default project -> ' + $ProjectId) }

# ------------------------------------------------------- autostart + start
if (-not $NoAutostart) {
  $auto = Join-Path $target 'install-hub-autostart.ps1'
  if (Test-Path $auto) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $auto -NoStart | Out-Null
    Write-Host '[autostart] registered (CodeBuddySessionHub.lnk)'
  } else {
    Write-Host '[autostart] skip: install-hub-autostart.ps1 not found in instance dir'
    [void]$todo.Add('register autostart manually (shortcut missing)')
  }
}

if (-not $NoStart) {
  $start = Join-Path $target 'start-hub.ps1'
  if (Test-Path $start) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $start | Out-Null
    Start-Sleep -Seconds 2
  } else {
    Write-Host '[start] skip: start-hub.ps1 not found in instance dir'
  }
}

# ------------------------------------------------------------- manual TODO
$final = Get-Cfg
$mine = $null
if ($final) { $mine = @($final.projects | Where-Object { [string]$_.id -eq $ProjectId }) | Select-Object -First 1 }
if ($mine) {
  if (-not [string]$mine.httpKey) { [void]$todo.Add('write key empty -> write endpoints return 403 key-not-configured') }
  if ($mine.doc -and -not [string]$mine.doc.key) { [void]$todo.Add('doc key empty -> doc endpoints locked') }
  if ($mine.qq -and -not [string]$mine.qq.simulateKey) { [void]$todo.Add('qq.simulateKey empty -> hub reply button cannot reach qqbot') }
}

$state = Get-StateOf $ProjectId
if ($state -eq 'enabled-degraded') { [void]$todo.Add('health probe failed: port conflict or hub not running (start-hub.ps1)') }

Write-Head 'result'
Show-State $ProjectId
Write-Host ''
Write-Host ('Project "' + $ProjectId + '" is registered. Open:')
Write-Host ('  http://127.0.0.1:' + (Get-CfgPort $final) + '/p/' + $ProjectId + '/')
Write-Host 'Smoke:'
Write-Host ('  curl.exe -s http://127.0.0.1:' + (Get-CfgPort $final) + '/p/' + $ProjectId + '/health')

if ($todo.Count -gt 0) {
  Write-Host ''
  Write-Host 'Manual TODO:'
  foreach ($t in $todo) { Write-Host ('  - ' + $t) }
  exit 2
}
exit 0
