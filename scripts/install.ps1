# ============================================================
# install.ps1 — iteration-workflow 引擎安装脚本 (PowerShell)
# ============================================================
#
# 目标：自动检测 IDE 环境，安装引擎 + 领域插件 + Hook 门禁
# 支持 IDE：Claude Code / CodeBuddy / Cursor / Codex / Generic
#
# v2.0.1 — Phase E 重写（031方案 + adapter 简化 + -DryRun + 嵌套复制修复）
# adapter 简化：Step 3 仅复制 IDE 差异文件（非整个 adapter 目录）
#               Step 4 从 hooks/gate-check.mjs 单源复制（非各 IDE 独立副本）
# v2.1.0 — 038迭代：新增 Step 5 ACTIVE初始化 + Step 6模板注入验证 + Step 7多IDE冷启动微核
# v2.2.0 — 039迭代：新增 Step 0前置依赖检查 + IDE目录自动创建 + -NoBackup 备份开关
# ============================================================

param(
    [string]$Ide = $null,
    [switch]$DryRun = $false,
    [switch]$NoBackup = $false
)

# ── Step 1: 检测 IDE 环境（与 install.sh 统一优先级）────
function Detect-IDE {
    if ($Ide) { return $Ide }
    if (Test-Path ".claude")    { return "claude-code" }
    if (Test-Path ".codebuddy") { return "codebuddy" }
    if (Test-Path ".cursor")    { return "cursor" }
    if ((Test-Path ".codex") -or (Test-Path ".codex/config.toml")) { return "codex" }
    return "generic"
}

$DetectedIde = Detect-IDE

# ── 引擎源目录（基于 $PSScriptRoot，无论从哪个目录运行都能找到源文件）──
$EngineDir = (Get-Item (Split-Path $PSScriptRoot -Parent)).FullName

# ── Step 1: 确定 SKILL_TARGET 和 HOOK_TARGET ──
switch ($DetectedIde) {
    "claude-code" {
        $SkillTarget = ".claude\skills\iteration-workflow"
        $HookTarget = ".claude\hooks"
    }
    "codebuddy" {
        $SkillTarget = ".codebuddy\skills\iteration-workflow"
        $HookTarget = ".codebuddy\hooks"
    }
    "cursor" {
        $SkillTarget = ".cursor\skills\iteration-workflow"
        $HookTarget = "$HOME\.cursor\hooks"
    }
    "codex" {
        $SkillTarget = ".codex\skills\iteration-workflow"
        $HookTarget = ".codex\hooks"
    }
    default {  # generic
        $SkillTarget = ".\output\skills\iteration-workflow"
        $HookTarget = $null
    }
}

if ($DryRun) {
    Write-Host "╔══════════════════════════════════════════════════╗"
    Write-Host "║  DRY RUN — 安装预览                               ║"
    Write-Host "╚══════════════════════════════════════════════════╝"
    Write-Host ""
    Write-Host "  IDE           : $DetectedIde"
    Write-Host "  SKILL_TARGET  : $SkillTarget"
    Write-Host "  HOOK_TARGET   : $(if ($HookTarget) { $HookTarget } else { '（无 — generic 模式无 Hook）' })"
    Write-Host "  ENGINE_DIR    : $EngineDir"
    Write-Host ""
    Write-Host "  Step 2 (核心引擎):"
    Write-Host "    + engine\             → $SkillTarget\engine\"
    Write-Host "    + project\            → $SkillTarget\project\"
    Write-Host "    + domain-plugins\     → $SkillTarget\domain-plugins\"
    Write-Host "    + scripts\            → $SkillTarget\scripts\"
    Write-Host "    + SKILL.template.md   → $SkillTarget\"
    Write-Host "    + README.md LICENSE   → $SkillTarget\"
    Write-Host ""
    Write-Host "  Step 3 (IDE adapter — 简化模式：仅差异文件):"
    switch ($DetectedIde) {
        "cursor"  { Write-Host "    + adapters\cursor\rules\.cursorrules.template → $SkillTarget\rules\" }
        "generic" { Write-Host "    + adapters\generic\README.md → $SkillTarget\" }
        default   { Write-Host "    （无 IDE 差异文件，共享文件已在 Step 2 复制）" }
    }
    Write-Host ""
    Write-Host "  Step 4 (Hook 门禁):"
    if ($HookTarget) {
        Write-Host "    + hooks\gate-check.mjs → $HookTarget\"
        if ($DetectedIde -eq "claude-code" -or $DetectedIde -eq "codebuddy") {
            Write-Host "    （RUNTIME_DIR 三元表达式运行时自动检测，无需路径替换）"
        }
    } else {
        Write-Host "    （generic 模式仅 prompt 层门禁，无 Hook）"
    }
    Write-Host ""
    Write-Host "  Step 5 (ACTIVE初始化):"
    Write-Host "    > 创建 $SkillTarget\runtime\ACTIVE (如果不存在)"
    Write-Host ""
    Write-Host "  Step 6 (模板注入):"
    Write-Host "    > python scripts\inject-template.py --manifest $SkillTarget\project\project.manifest.yaml"
    Write-Host "    > 验证: 扫描 SKILL.md 中残留 {{}} 占位符"
    Write-Host ""
    if ($DetectedIde -in @("codebuddy","claude-code","cursor")) {
        Write-Host "  Step 7 (冷启动微核):"
        Write-Host "    > python scripts\setup-gate.py --ide $DetectedIde"
        Write-Host ""
    }
    Write-Host "  Step 8 (门禁自检):"
    Write-Host "    > node scripts\run-gate-tests.mjs --quick"
    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════════╗"
    Write-Host "║  DRY RUN 完成。使用无 -DryRun 参数执行实际安装。    ║"
    Write-Host "╚══════════════════════════════════════════════════╝"
    exit 0
}

# ── Step 0: 前置依赖检查 ──
$HasError = $false

Write-Host "========================================"
Write-Host " iteration-workflow engine installer"
Write-Host "========================================"
Write-Host ""

Write-Host "  [Step 0] Checking dependencies..."
Write-Host ""

# Check Python & pyyaml
try {
    $pyVersion = & python --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] Python not found. Please install Python 3.x and add to PATH."
        Write-Host "         https://www.python.org/downloads/"
        $HasError = $true
    } else {
        Write-Host "  [OK]   $pyVersion"
        # Check pyyaml
        $pyyamlCheck = & python -c "import yaml; print(yaml.__version__)" 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [FAIL] pyyaml not installed. Run: pip install pyyaml"
            $HasError = $true
        } else {
            Write-Host "  [OK]   pyyaml $pyyamlCheck"
        }
    }
} catch {
    Write-Host "  [FAIL] Python not found. Please install Python 3.x and add to PATH."
    Write-Host "         https://www.python.org/downloads/"
    $HasError = $true
}

# Check Node.js
try {
    $nodeVersion = & node --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] Node.js not found. Please install Node.js and add to PATH."
        Write-Host "         https://nodejs.org/"
        $HasError = $true
    } else {
        Write-Host "  [OK]   Node.js $nodeVersion"
    }
} catch {
    Write-Host "  [FAIL] Node.js not found. Please install Node.js and add to PATH."
    Write-Host "         https://nodejs.org/"
    $HasError = $true
}

Write-Host ""

if ($HasError) {
    Write-Host "  Dependency check failed. Please fix the issues above and re-run."
    Write-Host ""
    exit 1
}

Write-Host "  All dependencies OK. Continuing with installation..."
Write-Host ""

# ── IDE directory auto-creation (when -Ide explicitly specified) ──
if ($Ide) {
    $IdeDir = switch ($Ide) {
        "claude-code" { ".claude" }
        "codebuddy"  { ".codebuddy" }
        "cursor"     { ".cursor" }
        "codex"      { ".codex" }
        default      { $null }
    }
    if ($IdeDir -and -not (Test-Path $IdeDir)) {
        Write-Host "  [IDE] Creating $IdeDir directory (explicitly requested via -Ide $Ide)..."
        New-Item -ItemType Directory -Force -Path $IdeDir | Out-Null
        Write-Host "  [OK]  $IdeDir created."
        Write-Host ""
    }
}

# ── Backup (before overwriting) ──
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$IdeMarkers = @(".codebuddy", ".claude", ".cursor", ".codex")
$BackupRoot = $null

if (-not $NoBackup) {
    foreach ($marker in $IdeMarkers) {
        if (Test-Path $marker) {
            $BackupRoot = "$marker.backup.$Timestamp"
            Write-Host "  [Backup] Existing $marker found, backing up to $BackupRoot ..."
            # Use robocopy for reliable directory copy, but handle single-file case
            if ((Get-Item $marker) -is [System.IO.DirectoryInfo]) {
                robocopy $marker $BackupRoot /E /NFL /NDL /NJH /NJS /NP | Out-Null
            } else {
                Copy-Item $marker $BackupRoot -Recurse -Force
            }
            Write-Host "  [OK]   Backup created: $BackupRoot"
            Write-Host ""
            break
        }
    }
}

Write-Host "  IDE: $DetectedIde"
Write-Host ""

if ($DetectedIde -eq "generic") {
    Write-Host "⚠ No IDE detected. Installed to .\output\ for manual setup."
    Write-Host "   See adapters\generic\README.md for manual instructions."
}

# ── Step 2: 核心引擎 + 领域插件 ──────────────
Write-Host "[Step 2/8] Copying core engine..."
New-Item -ItemType Directory -Force -Path $SkillTarget | Out-Null
# 先删除再复制，避免更新安装时 Copy-Item -Recurse 合并导致 engine/engine/ 嵌套
@("engine","project","domain-plugins","scripts") | ForEach-Object {
    Remove-Item -Recurse -Force "$SkillTarget\$_" -ErrorAction SilentlyContinue
    Copy-Item -Recurse -Force "$EngineDir\$_" "$SkillTarget\$_"
}
Copy-Item -Force "$EngineDir\SKILL.template.md" "$SkillTarget\"
@("README.md","LICENSE","CONTRIBUTING.md") | ForEach-Object {
    $src = Join-Path $EngineDir $_
    if (Test-Path $src) { Copy-Item -Force $src "$SkillTarget\" }
}

# ── Step 3: IDE 专属 adapter（简化：仅差异文件）────
Write-Host "[Step 3/8] Installing IDE adapter..."
New-Item -ItemType Directory -Force -Path "$SkillTarget\rules" | Out-Null
switch ($DetectedIde) {
    "cursor" {
        Copy-Item -Force "$EngineDir\adapters\cursor\rules\.cursorrules.template" "$SkillTarget\rules\"
        Write-Host "  ✅ Cursor rules installed"
    }
    "generic" {
        Copy-Item -Force "$EngineDir\adapters\generic\README.md" "$SkillTarget\"
        Write-Host "  ✅ Generic adapter README installed"
    }
    default {
        Write-Host "  ✅ No IDE-specific files needed（shared files already copied）"
    }
}

# ── Step 4: Hook 安装（单源 gate-check.mjs）────
Write-Host "[Step 4/8] Installing gate hook..."
if ($HookTarget) {
    New-Item -ItemType Directory -Force -Path $HookTarget | Out-Null
    Copy-Item -Force "$EngineDir\hooks\gate-check.mjs" "$HookTarget\"
    Write-Host "  ✅ $DetectedIde Hook installed to $HookTarget"
} else {
    Write-Host "  ⚠  Generic mode: no Hook available（prompt-level gate only）"
}

# ── Step 5: ACTIVE 状态初始化 ─────────────────
Write-Host "[Step 5/8] Initializing runtime state..."
$runtimeDir = "$SkillTarget\runtime"
$activeFile = "$runtimeDir\ACTIVE"

if (Test-Path $activeFile) {
    $content = Get-Content -Path $activeFile -Raw -Encoding UTF8
    if ($content -match 'STATUS=') {
        Write-Host "  ✅ ACTIVE already initialized, skipping"
    } else {
        Write-Host "  ⚠  ACTIVE exists but format unrecognized — recreating"
        $recreate = $true
    }
} else {
    $recreate = $true
}

if ($recreate) {
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Set-Content -Path $activeFile -Value "none`nSTATUS=none PHASE=none"
    Write-Host "  ✅ ACTIVE initialized (none)"
}

# ── Step 6: 模板注入 + 占位符验证 ─────────────
Write-Host "[Step 6/8] Injecting template..."
$pythonCmd = $null
if (Get-Command python -ErrorAction SilentlyContinue) { $pythonCmd = "python" }
elseif (Get-Command python3 -ErrorAction SilentlyContinue) { $pythonCmd = "python3" }

if ($pythonCmd) {
    & $pythonCmd "$EngineDir\scripts\inject-template.py" --manifest "$SkillTarget\project\project.manifest.yaml"

    # ── 方案 B: 占位符验证 ──
    $skillMdPath = "$SkillTarget\SKILL.md"
    if (Test-Path $skillMdPath) {
        $residuals = [regex]::Matches((Get-Content $skillMdPath -Raw -Encoding UTF8), '\{\{(\w+(?:[\._-]\w+)*)\}\}') |
                     ForEach-Object { $_.Value } | Select-Object -Unique
        if ($null -ne $residuals -and @($residuals).Count -gt 0) {
            Write-Host "  ❌ Unresolved template placeholders found in SKILL.md:"
            $residuals | ForEach-Object { Write-Host "     $_" }
            Write-Host ""
            Write-Host "     This usually means inject-template.py failed silently (e.g. missing yaml module)."
            Write-Host "     Fix: pip install pyyaml && re-run install"
            exit 1
        } else {
            Write-Host "  ✅ Template injection verified（no unresolved placeholders）"
        }
    } else {
        Write-Host "  ⏭  SKILL.md not found, skipping placeholder verification"
    }
} else {
    Write-Host "  ⚠  Python not found. Skipping template injection."
    Write-Host "     Run manually: python $EngineDir\scripts\inject-template.py --manifest $SkillTarget\project\project.manifest.yaml"
}

# ── Step 7: 冷启动微核注入（多 IDE）───────────
Write-Host "[Step 7/8] Cold-start gate nucleus..."
$nucleusSupported = @("codebuddy","claude-code","cursor")
if ($DetectedIde -in $nucleusSupported) {
    if ($pythonCmd) {
        & $pythonCmd "$EngineDir\scripts\setup-gate.py" --ide $DetectedIde
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ Cold-start gate nucleus injected (or already present)"
        } else {
            Write-Host "  ⚠  setup-gate.py exited with code $LASTEXITCODE"
        }
    } else {
        Write-Host "  ⚠  Python not found, skipping cold-start gate nucleus"
    }
} else {
    Write-Host "  ⏭  Skipped（${DetectedIde}: prompt-level gate only）"
}

# ── Step 8: 门禁自检 ──────────────────────────
Write-Host "[Step 8/8] Gate self-test..."
$gateTestScript = "$EngineDir\scripts\run-gate-tests.mjs"
if (Test-Path $gateTestScript) {
    node $gateTestScript --quick
    if ($LASTEXITCODE -ne 0) { Write-Host "⚠ Self-test issues found. Review output above." }
} else {
    Write-Host "  ⚠  run-gate-tests.mjs not found（skipping self-test）"
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "✅ Installed to $SkillTarget"
Write-Host ""
Write-Host "   Next steps:"
Write-Host "   1. Edit project\project.manifest.yaml"
if ($DetectedIde -eq "generic") {
    Write-Host "   2. ⚠️  Your IDE (generic) uses prompt-level gate protection."
} else {
    Write-Host "   2. 🔒 Hook-level gate protection active ($DetectedIde)."
}
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
