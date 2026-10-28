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
# v2.3.0 — GAP-4/B：新增 Step 4b —— CodeBuddy settings.json 的 PreToolUse 幂等注册
#          （hook 文件存在 ≠ 被 IDE 执行；缺注册即静默失效，故安装时自动补齐 / 保守合并）
# v2.3.1 — GAP-4/加固②：新增 Step 7b —— MEMORY.md 注入配额自检（余量 <10% 预警 / 超限告警）
# v2.4.0 — ★ FIX-49（2026-10-15）：Detect-IDE 探测顺序反转（.codebuddy 优先）+ env 加分信号
#          + 双目录并存需显式 -Ide / -Force（防把宿主 skill 装到废弃侧）
# v2.5.0 — ★ F1/F2/F3（2026-10-26 TOOL-ENGCLOSE-1026）：
#          F1 Step 6 前用 bootstrap-manifest.py 按 IDE 推导并写回空 specs_dir
#             （否则全新 clone 必然注入失败 exit 1）；新增 -SpecsDir 覆盖入口
#          F2 Step 8 改跑「已装副本」的 run-gate-tests（跑源副本会因 hooks 布局误判而误红）
#          F3 Step 4 源缺 hooks 硬失败（原静默打 ✅）、Step 7/7b 统一以安装根为项目根
# v2.6.0 — ★ TOOL-QQBOT-DIST（2026-10-28）：新增**可选组件**分发 -WithQqbot / -ComponentsOnly
#          · 默认不装（多数项目不需要 QQ 通道），只在显式开关下拷贝引擎顶层 tools/qqbot；
#          · 只拷贝：委托 `install-all.ps1 -CopyOnly`（排除清单单一来源），**不**代跑
#            自启注册/计划任务/启动服务 —— 那三项是单机单实例（快捷方式名 / 计划任务名 /
#            端口 18765 全局唯一，第二个项目会静默顶掉第一个）。
#          · Step 2b 承载拷贝（沿用既有 7b 的「b 步不进分母」约定）⇒ 8 步文案零改动。
# ============================================================

param(
    [string]$Ide = $null,
    [switch]$DryRun = $false,
    [switch]$NoBackup = $false,
    [switch]$Force = $false,
    [string]$SpecsDir = $null,
    # 可选组件：QQ 通知通道（tools/qqbot）。默认不装，必须显式开关。
    [switch]$WithQqbot = $false,
    # 轻量后装模式：只做可选组件，跳过后 8 步（不备份 IDE 目录、不重装 engine/scripts）。
    [switch]$ComponentsOnly = $false
)

# ── Step 1: 检测 IDE 环境（与 install.sh 统一优先级 · ★ FIX-49 R24 修订）────
# ★ FIX-49（2026-10-15 · R24）：探测顺序**反转**（`.codebuddy` 优先）+ env 加分信号 +
#   双目录并存且未显式 `-Ide` ⇒ 警告并要求确认（`-Force` 才继续）——
#   动因：双目录并存仓库下旧顺序（`.claude` 优先）会把 CodeBuddy 宿主的 skill 装到废弃侧
#   （09-28 翻转后通道敞开；见 runtime/FIX-49-四件套.md §②行 27 / ①-补 复核补充）。
function Detect-IDE {
    if ($Ide) { return $Ide }
    $hasCodeBuddy = Test-Path ".codebuddy"
    $hasClaude = Test-Path ".claude"

    if ($hasCodeBuddy -and $hasClaude -and -not $Force) {
        Write-Warning "检测到 .codebuddy 与 .claude 双目录并存（未显式指定目标侧）——FIX-49（R24）要求显式确认。"
        Write-Host "  ❌ 已中止，避免把宿主 skill 装到错误一侧。请显式指定：" -ForegroundColor Red
        Write-Host "     · 装到 CodeBuddy :  -Ide codebuddy" -ForegroundColor Yellow
        Write-Host "     · 装到 Claude Code :  -Ide claude-code" -ForegroundColor Yellow
        Write-Host "     · 或接受默认（.codebuddy 优先）:  -Force" -ForegroundColor Yellow
        exit 2
    }
    # env 加分信号（shim 双 env 回退暗示 CLI 环境可能缺 ⇒ 仅作加分，不作主判据）
    if ($env:CODEBUDDY_PROJECT_DIR -and $hasCodeBuddy) { return "codebuddy" }
    if ($env:CLAUDE_PROJECT_DIR -and $hasClaude)       { return "claude-code" }
    if ($hasCodeBuddy) { return "codebuddy" }
    if ($hasClaude)    { return "claude-code" }
    if (Test-Path ".cursor")    { return "cursor" }
    if ((Test-Path ".codex") -or (Test-Path ".codex/config.toml")) { return "codex" }
    return "generic"
}

$DetectedIde = Detect-IDE

# ── 引擎源目录（基于 $PSScriptRoot，无论从哪个目录运行都能找到源文件）──
$EngineDir = (Get-Item (Split-Path $PSScriptRoot -Parent)).FullName

# ── 可选组件：QQ 通知通道（tools/qqbot）────────────────────────────────
# 动因（2026-10-28）：本脚本原本全文不含 tools/ ⇒ 新项目装完 skill **永远**拿不到
#   tools/qqbot，而缺失是**静默**的：engine/gate/notify-adapter.mjs 用 existsSync 探测
#   通知脚本、缺席即 `NOTIFY_SKIP no-script`；manifest 的 notifications.adapter 默认
#   也归一为 `none`。用户以为通知通道装好了，实际全静默且零报错。
#
# 三条硬约束（实现不得偏离）：
#   ① **默认不装**：只有显式 -WithQqbot 才拷贝；本函数不碰 manifest 的 notifications 段
#      （翻 adapter 是 install-all 第 7 步，属用户显式动作）。
#   ② **只拷贝，不代跑**：不注册自启、不建计划任务、不启动服务。快捷方式名
#      `CodeBuddyQQWatcher.lnk` / 计划任务 `CodeBuddyQQWatchdog` / 端口 18765 都是单机
#      唯一的，第二个项目跑一遍会静默顶掉第一个 —— 必须由用户在自己项目里显式执行。
#   ③ **排除清单单一来源**：委托 `install-all.ps1 -CopyOnly`，本文件不写第二份排除表。
#      历史上同一份清单已有三处（install-all / sync-skills.ps1 / 引擎 .gitignore），
#      再加第四份必然漂移，而漂移的后果是把含 secret 的 qqbot.creds.json 拷进新项目。
function Install-QqbotComponent {
    param([string]$Root)

    $srcEntry = Join-Path $EngineDir 'tools\qqbot\install-all.ps1'
    if (-not (Test-Path $srcEntry)) {
        # 与 Step 4 的 F3 同款：源不合法必须硬失败，否则「装完没有组件」被当成成功。
        Write-Host "  ❌ optional component source missing: $srcEntry"
        Write-Host "     The install source must be the engine repo (it carries the top-level tools/qqbot)."
        Write-Host "     An already-installed skill copy does NOT carry tools/ (by design)."
        exit 1
    }

    $dst = Join-Path $Root 'tools\qqbot'
    if (Test-Path (Join-Path $dst 'install-all.ps1')) {
        Write-Host "  ✅ qqbot already present: $dst（merge 拷贝，实例文件 daemon.config.json / qqbot.creds.json 不受影响）"
    }

    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $srcEntry,
              '-ProjectRoot', $Root, '-CopyOnly')
    if ($DryRun) { $argv += '-DryRun' }
    & powershell.exe @argv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ optional component copy failed (install-all.ps1 -CopyOnly exit $LASTEXITCODE)"
        exit 1
    }
    if ($DryRun) { return }

    if (-not (Test-Path (Join-Path $dst 'install-all.ps1'))) {
        Write-Host "  ❌ optional component missing after copy: $(Join-Path $dst 'install-all.ps1')"
        exit 1
    }
    Add-QqbotGitignore -Root $Root
}

# 凭证泄漏面加固：项目侧 .gitignore 通常没有 qqbot 规则，而 install-all 第 3 步会生成
#   qqbot.creds.json（含 secret）⇒ 一次 `git add .` 就把密钥提交了。幂等追加；写失败只告警
#   （不因为 .gitignore 不可写就让整次安装失败）。
function Add-QqbotGitignore {
    param([string]$Root)

    $gi = Join-Path $Root '.gitignore'
    $marker = '# tools/qqbot (credentials / instance config / runtime) -- managed by install.ps1 -WithQqbot'
    $existing = ''
    if (Test-Path $gi) { $existing = Get-Content $gi -Raw -Encoding UTF8 }
    if ($existing -and $existing.Contains($marker)) {
        Write-Host "  ✅ .gitignore already carries qqbot rules"
        return
    }
    $block = @(
        $marker,
        'tools/qqbot/daemon.config.json',
        'tools/qqbot/qqbot.creds.json',
        'tools/qqbot/*.jsonl',
        'tools/qqbot/*.log',
        'tools/qqbot/runtime/'
    ) -join "`r`n"
    $prefix = if ($existing -and $existing.Trim().Length -gt 0) { "`r`n`r`n" } else { '' }
    try {
        [IO.File]::AppendAllText($gi, $prefix + $block + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "  ✅ .gitignore: qqbot 实例文件规则已追加（qqbot.creds.json 不会入库）"
    } catch {
        Write-Host "  ⚠  .gitignore 追加失败：$($_.Exception.Message)"
        Write-Host "     Manual: 加入 tools/qqbot/qqbot.creds.json（含 secret，禁止提交）"
    }
}

# 组件状态探针（**三态**）：missing = 未分发 / staged = 已分发未启用 / enabled = 已启用
#
# 为什么必须是三态（2026-10-28）：此前只报「已安装 / 未安装」，无法回答最常见的中间态
#   「文件拷进来了，但 notifications.adapter 仍是 none」—— 而「目录在 = 已生效」正是本次
#   改造要根治的静默故障形状（notify-adapter 探测脚本存在才发，adapter 不翻则全程静默）。
#   生态侧的对应做法是把「可见/启用」与「文件是否就位」拆成两件事（声明式开关），这里同口径。
function Get-QqbotComponentState {
    if (-not (Test-Path 'tools\qqbot\install-all.ps1')) { return 'missing' }
    $mp = "$SkillTarget\project\project.manifest.yaml"
    if (Test-Path $mp) {
        $raw = Get-Content $mp -Raw -Encoding UTF8
        # 判据与 install-all 第 7 步**同款**（同一事实只认一个正则形状，避免两套判定漂移）
        if ($raw -match '(?m)^notifications:\s*\r?\n\s+adapter:\s*"?qqbot"?\s*$') { return 'enabled' }
    }
    return 'staged'
}

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
    Write-Host "    + scripts\            → $SkillTarget\scripts\"
    Write-Host "    + SKILL.template.md   → $SkillTarget\"
    Write-Host "    + README.md LICENSE   → $SkillTarget\"
    Write-Host ""
    Write-Host "  Step 2b (可选组件 —— 默认不装):"
    if ($WithQqbot) {
        Write-Host "    + tools\qqbot\        → <安装根>\tools\qqbot\   (委托 install-all.ps1 -CopyOnly)"
        Write-Host "      * 只拷贝：排除 daemon.config.json / qqbot.creds.json / *.log / *.jsonl / runtime/"
        Write-Host "      * 不做：自启注册 / 计划任务 / 启动服务 / 改 notifications.adapter（单机单实例，须你显式执行）"
        Write-Host "      * 追加 .gitignore 规则（qqbot.creds.json 含 secret，防入库）"
        Write-Host "      > 装后下一步: powershell -NoProfile -ExecutionPolicy Bypass -File tools\qqbot\install-all.ps1"
    } else {
        switch (Get-QqbotComponentState) {
            'enabled' { Write-Host "    状态: 已启用（tools\qqbot + notifications.adapter=qqbot）—— 未加 -WithQqbot，本次不动" }
            'staged'  { Write-Host "    状态: 已分发**未启用**（tools\qqbot 在，adapter 不是 qqbot）—— 启用见 tools\qqbot\install-all.ps1" }
            default   { Write-Host "    状态: 未分发 —— 需要 QQ 通知时加 -WithQqbot（后装: -WithQqbot -ComponentsOnly）" }
        }
    }
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
        if ($DetectedIde -eq "codebuddy") {
            Write-Host "    * .codebuddy\settings.json 注册 PreToolUse（幂等；缺注册 = Hook 静默失效）"
        }
    } else {
        Write-Host "    （generic 模式仅 prompt 层门禁，无 Hook）"
    }
    Write-Host ""
    Write-Host "  Step 5 (ACTIVE初始化):"
    Write-Host "    > 创建 $SkillTarget\runtime\ACTIVE (如果不存在)"
    Write-Host ""
    Write-Host "  Step 6 (模板注入):"
    Write-Host "    > 若 project.manifest.yaml 不存在，从 .template 创建"
    Write-Host "    > python scripts\inject-template.py --manifest $SkillTarget\project\project.manifest.yaml --template $SkillTarget\SKILL.template.md --output $SkillTarget\SKILL.md"
    Write-Host "    > 验证: python scripts\inject-template.py --check --compare $SkillTarget\SKILL.md"
    Write-Host ""
    if ($DetectedIde -in @("codebuddy","claude-code","cursor")) {
        Write-Host "  Step 7 (冷启动微核):"
        Write-Host "    > python scripts\setup-gate.py --ide $DetectedIde"
        Write-Host ""
    }
    if ($DetectedIde -eq "codebuddy") {
        Write-Host "  Step 7b (注入配额自检):"
        Write-Host "    > python scripts\memory_quota.py .codebuddy\memory\MEMORY.md（余量 <10% 预警）"
        Write-Host ""
    }
    Write-Host "  Step 8 (门禁自检):"
    Write-Host "    > node scripts\run-gate-tests.mjs   # 已装副本；分母应为 87（--quick 只精简明细，勿用于验收）"
    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════════╗"
    Write-Host "║  DRY RUN 完成。使用无 -DryRun 参数执行实际安装。    ║"
    Write-Host "╚══════════════════════════════════════════════════╝"
    exit 0
}

# ── 轻量组件模式（-ComponentsOnly）────────────────────────────────
# 场景：skill 早已装好，之后才想加 QQ 通知通道。若走全量安装，会先 robocopy 整个 IDE 目录
#   做备份（下方 Backup 段）再整目录替换 engine/scripts —— 代价与风险都不匹配「只加一个组件」。
# 故在此**早退**：只跑组件拷贝，不备份、不查依赖、不动 engine/scripts/manifest/hooks。
if ($ComponentsOnly) {
    if (-not $WithQqbot) {
        # 无参调用 = 组件状态探针（可随时随地查；输出三态，避免"目录在 = 已生效"的误读）
        switch (Get-QqbotComponentState) {
            'enabled' {
                Write-Host "  ✅ qqbot 已启用：tools\qqbot + notifications.adapter=qqbot"
                Write-Host "     健康/待确认: curl http://127.0.0.1:18765/health"
            }
            'staged' {
                Write-Host "  ◐  qqbot 已分发但**未启用**：tools\qqbot 在，notifications.adapter 不是 qqbot"
                Write-Host "     启用（在项目根执行）: powershell -NoProfile -ExecutionPolicy Bypass -File tools\qqbot\install-all.ps1"
                Write-Host "     （不带凭据时会返回 exit 2 + TODO 清单；openid 必须人工）"
            }
            default {
                Write-Host "  ○  qqbot 未分发。安装: scripts\install.ps1 -WithQqbot -ComponentsOnly"
                Write-Host "     （安装期一并装: 加 -WithQqbot 即可；默认不装）"
            }
        }
        exit 0
    }
    Write-Host "[components] Installing optional component: qqbot ..."
    Install-QqbotComponent -Root (Get-Location).Path
    Write-Host "  ℹ   下一步（需你在本项目执行）:"
    Write-Host "      powershell -NoProfile -ExecutionPolicy Bypass -File tools\qqbot\install-all.ps1"
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

# ── Step 2: 核心引擎（G02：领域插件层已下线，不再复制其目录）──────────────
Write-Host "[Step 2/8] Copying core engine..."
New-Item -ItemType Directory -Force -Path $SkillTarget | Out-Null
# 先删除再复制，避免更新安装时 Copy-Item -Recurse 合并导致 engine/engine/ 嵌套
# ⚠ project/ 不参与整目录替换：它存放用户已填的项目配置，删除 = 配置全丢（需手工备份恢复）。
#   这里只对缺失文件做增量补齐，已存在的一律不动。
@("engine","scripts") | ForEach-Object {
    Remove-Item -Recurse -Force "$SkillTarget\$_" -ErrorAction SilentlyContinue
    Copy-Item -Recurse -Force "$EngineDir\$_" "$SkillTarget\$_"
}
New-Item -ItemType Directory -Force -Path "$SkillTarget\project" | Out-Null
Get-ChildItem "$EngineDir\project" -File | ForEach-Object {
    $dst = Join-Path "$SkillTarget\project" $_.Name
    if (-not (Test-Path $dst)) {
        Copy-Item $_.FullName $dst
        Write-Host "  [+] project/$($_.Name) (new)"
    }
}
Copy-Item -Force "$EngineDir\SKILL.template.md" "$SkillTarget\"
@("README.md","LICENSE","CONTRIBUTING.md") | ForEach-Object {
    $src = Join-Path $EngineDir $_
    if (Test-Path $src) { Copy-Item -Force $src "$SkillTarget\" }
}

# ── Step 2b: 可选组件（默认不装）────
# 不进分母：沿用既有 `7b` 的「b 步」约定，8 处 `[Step N/8]` 文案无需联动。
# 装到**安装根** `<cwd>\tools\qqbot`（非 skill 目录内）：notify-adapter / gate 与
# install-all 的身份判定都以「项目根/tools/qqbot」为基准；放进 skill 目录 = 死副本。
if ($WithQqbot) {
    Write-Host "[Step 2b/8] Optional component: qqbot..."
    Install-QqbotComponent -Root (Get-Location).Path
    Write-Host "  ℹ   本步只拷贝。需要真正启用（ws 依赖 / 凭据 / Stop hook / notifications.adapter /"
    Write-Host "      自启 / 看门狗 / health）请在本项目执行："
    Write-Host "      powershell -NoProfile -ExecutionPolicy Bypass -File tools\qqbot\install-all.ps1"
} else {
    switch (Get-QqbotComponentState) {
        'enabled' { Write-Host "[Step 2b/8] Optional component qqbot present and enabled (not updated without -WithQqbot)" }
        'staged'  { Write-Host "[Step 2b/8] Optional component qqbot staged but NOT enabled (run tools\qqbot\install-all.ps1 to enable)" }
    }
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
    # ★ F3（2026-10-26）：源缺 hooks/ 时旧写法只让 Copy-Item 报错，随后仍打印「✅ installed」
    #   ⇒ 装出的项目没有门禁却显示成功（实测：用「已装副本」当安装源即触发，因为装完后
    #   hooks/ 只存在于 <proj>\.{ide}\hooks，skill 目录内没有）。改为硬失败。
    $hookSrc = "$EngineDir\hooks\gate-check.mjs"
    if (-not (Test-Path $hookSrc)) {
        Write-Host "  ❌ gate hook source missing: $hookSrc"
        Write-Host "     The install source must be the engine repo (it carries hooks/gate-check.mjs)."
        Write-Host "     Using an already-installed copy as the source is not supported."
        exit 1
    }
    New-Item -ItemType Directory -Force -Path $HookTarget | Out-Null
    Copy-Item -Force $hookSrc "$HookTarget\"
    Write-Host "  ✅ $DetectedIde Hook installed to $HookTarget"
} else {
    Write-Host "  ⚠  Generic mode: no Hook available（prompt-level gate only）"
}

# ── Step 4b: Hook 注册（CodeBuddy settings.json，幂等）────
# 门禁 Hook 仅"文件存在"不会被 IDE 触发：CodeBuddy 还须在 .codebuddy/settings.json 的
# hooks.PreToolUse 中注册命令。缺此注册 = Hook 静默失效（GAP-4 诊断三）。
# 策略：已注册 → 跳过；文件不存在 → 创建；存在其他配置 → 先备份再保守合并（失败则提示手工）。
if ($DetectedIde -eq "codebuddy" -and $HookTarget) {
    $settingsPath = ".codebuddy\settings.json"
    $hookCmd = "node .codebuddy/hooks/gate-check.mjs"
    $alreadyRegistered = $false
    if (Test-Path $settingsPath) {
        if ((Get-Content $settingsPath -Raw -Encoding UTF8) -match 'gate-check\.mjs') {
            $alreadyRegistered = $true
        }
    }
    if ($alreadyRegistered) {
        Write-Host "  ✅ Gate hook already registered in settings.json"
    } elseif (Test-Path $settingsPath) {
        $backup = "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $settingsPath $backup -Force
        try {
            $json = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $entry = [PSCustomObject]@{
                matcher = ".*"
                hooks   = @([PSCustomObject]@{ type = "command"; command = $hookCmd; timeout = 15 })
            }
            if ($null -eq $json.hooks) {
                $json | Add-Member -NotePropertyName hooks -NotePropertyValue ([PSCustomObject]@{ PreToolUse = @($entry) }) -Force
            } elseif ($null -eq $json.hooks.PreToolUse) {
                $json.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @($entry) -Force
            } else {
                $json.hooks.PreToolUse = @($json.hooks.PreToolUse) + $entry
            }
            $out = $json | ConvertTo-Json -Depth 20
            [IO.File]::WriteAllText([IO.Path]::GetFullPath($settingsPath), $out, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "  ✅ Gate hook merged into settings.json（backup: $backup）"
        } catch {
            Write-Host "  ❌ Failed to merge settings.json: $_"
            Write-Host "     Manual fix: add hooks.PreToolUse -> $hookCmd"
            Write-Host "     Backup kept at: $backup"
        }
    } else {
        New-Item -ItemType Directory -Force -Path ".codebuddy" | Out-Null
        $template = @'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node .codebuddy/hooks/gate-check.mjs",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
'@
        [IO.File]::WriteAllText([IO.Path]::GetFullPath($settingsPath), $template, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "  ✅ settings.json created with gate hook registration"
    }
} elseif ($HookTarget) {
    Write-Host "  ⏭  Hook registration skipped（$DetectedIde uses a different registration mechanism）"
}

# ── Step 4b-2: team-wait-guard 注册（2026-10-27 新增，幂等）────
# 团队等待硬门禁：PreToolUse 记录异步成员派发（task 且带 name）+ Stop 阻断"未核对收口"的
# 结束请求（exit 2 + stderr 回灌模型）。依据：Stop hook exit 2 语义 2026-10-27 实测成立。
# 与 Step 4b 分开：原段"已注册即整体跳过"，无法追加新条目；本段按命令串逐条补注册。
if ($DetectedIde -eq "codebuddy" -and $HookTarget -and (Test-Path $settingsPath)) {
    $wgRel  = ($SkillTarget -replace '\\', '/') + "/engine/gate/team-wait-guard.mjs"
    $wgPre  = "node $wgRel --dispatch"
    $wgStop = "node $wgRel --stop-guard"
    try {
        $raw = Get-Content $settingsPath -Raw -Encoding UTF8
        $json = $raw | ConvertFrom-Json
        $changed = $false
        if ($null -eq $json.hooks) {
            $json | Add-Member -NotePropertyName hooks -NotePropertyValue ([PSCustomObject]@{}) -Force
        }
        if ($null -eq $json.hooks.PreToolUse) {
            $json.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @() -Force
        }
        if ($null -eq $json.hooks.Stop) {
            $json.hooks | Add-Member -NotePropertyName Stop -NotePropertyValue @() -Force
        }
        if ($raw -notmatch [regex]::Escape('team-wait-guard.mjs --dispatch')) {
            $preEntry = [PSCustomObject]@{
                matcher = ".*"
                hooks   = @([PSCustomObject]@{ type = "command"; command = $wgPre; timeout = 10 })
            }
            $json.hooks.PreToolUse = @($json.hooks.PreToolUse) + $preEntry
            $changed = $true
            Write-Host "  ✅ team-wait-guard registered (PreToolUse --dispatch)"
        } else {
            Write-Host "  ✅ team-wait-guard already registered (PreToolUse)"
        }
        if ($raw -notmatch [regex]::Escape('team-wait-guard.mjs --stop-guard')) {
            $stopEntry = [PSCustomObject]@{ type = "command"; command = $wgStop; timeout = 10 }
            $stopArr = @($json.hooks.Stop)
            if ($stopArr.Count -eq 0) {
                $json.hooks.Stop = @([PSCustomObject]@{ hooks = @($stopEntry) })
            } else {
                $stopArr[0].hooks = @($stopEntry) + @($stopArr[0].hooks)
                $json.hooks.Stop = $stopArr
            }
            $changed = $true
            Write-Host "  ✅ team-wait-guard registered (Stop --stop-guard)"
        } else {
            Write-Host "  ✅ team-wait-guard already registered (Stop)"
        }
        if ($changed) {
            $backup = "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
            Copy-Item $settingsPath $backup -Force
            [IO.File]::WriteAllText([IO.Path]::GetFullPath($settingsPath), ($json | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "     (backup: $backup)"
            # 写回后自校验：单元素数组塌陷会让 IDE 读不到 hook ⇒ 静默失效，必须当场暴露
            $chk = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (@($chk.hooks.PreToolUse).Count -lt 1 -or @($chk.hooks.Stop).Count -lt 1) {
                Write-Host "  ❌ settings.json 写回后结构异常（PreToolUse/Stop 为空）——请手工恢复备份"
            }
        }
    } catch {
        Write-Host "  ❌ Failed to register team-wait-guard: $_"
        Write-Host "     Manual fix: hooks.PreToolUse += $wgPre ; hooks.Stop += $wgStop"
    }
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

# 首次安装：从模板创建 project.manifest.yaml（已存在则不覆盖，避免抹掉用户已填内容）
$manifestPath = "$SkillTarget\project\project.manifest.yaml"
$manifestTpl = "$SkillTarget\project\project.manifest.yaml.template"
if (-not (Test-Path $manifestPath) -and (Test-Path $manifestTpl)) {
    Copy-Item $manifestTpl $manifestPath -Force
    Write-Host "  ✅ Created project.manifest.yaml from template (to be filled in)"
}

# ★ F1（2026-10-26）：模板里 ★必填全空，而注入器把空串当缺键并**拒绝落盘**
#   （inject-template.py 2026-10-25 BLOCKER-1 的反腐化设计：宁可不写，也不产出 `specs_dir: /`）。
#   两者相邻 ⇒ 全新 clone 必然在下面这段注入 exit 1，永远装不上。
#   `SKILL.template.md` 只需要 SPECS_DIR / KB_DIR 两个 ① 类变量，kb_dir 模板有默认值，
#   故唯一要填的是 paths.specs_dir：这里按已探测 IDE 推导（-SpecsDir 可覆盖），仅填空值 ⇒ 幂等。
if ($pythonCmd) {
    $bsScript = "$EngineDir\scripts\bootstrap-manifest.py"
    if (Test-Path $bsScript) {
        $bsArgs = @($bsScript, '--manifest', $manifestPath, '--ide', $DetectedIde)
        if ($SpecsDir) { $bsArgs += @('--specs-dir', $SpecsDir) }
        & $pythonCmd @bsArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ❌ manifest bootstrap failed (exit $LASTEXITCODE)."
            Write-Host "     Fix: set paths.specs_dir in $manifestPath (or pass -SpecsDir <path>) and re-run."
            exit 1
        }
    } else {
        Write-Host "  ⚠  bootstrap-manifest.py not found — paths.specs_dir must be filled manually."
    }
}

if ($pythonCmd) {
    # 显式传入 template/output 绝对路径：脚本默认值是相对当前工作目录，
    # 不传会导致从项目根找不到 SKILL.template.md 而注入失败
    & $pythonCmd "$EngineDir\scripts\inject-template.py" --manifest "$manifestPath" --template "$SkillTarget\SKILL.template.md" --output "$SkillTarget\SKILL.md"

    # ★ 必须透传退出码：注入器现在会在「① 类未解析 / 未定义占位符」时 exit 1 且不写盘。
    #   历史行为是继续往下走，于是「注入失败」只体现为残留扫描报错，语义链条断裂。
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ Template injection failed (exit $LASTEXITCODE, see messages above)."
        Write-Host "     Fix: pip install pyyaml && re-run install (check manifest / template)"
        exit 1
    }

    # ── 方案 B: 占位符验证（★ 复用注入器的判据，不另写一套正则）──
    # 历史写法用本文件的 `\w` 正则把**任意** `{{...}}` 都当错误 ⇒ 与注入器的放行口径
    # （②运行时/③脚本渲染/④内容槽 允许保留）直接矛盾，且是**第三套**规则：
    # 模板哪天保留 {{ITERATION_ID}} 就会「注入通过、安装器硬失败」。
    # 现改为调 `--check --compare SKILL.md`：前者判「该解析的解析了」，后者确认**盘上文件
    # 就是本次注入结果**（防写入被截断/被占用而静默留旧文件）。退出码即结论。
    $skillMdPath = "$SkillTarget\SKILL.md"
    if (Test-Path $skillMdPath) {
        & $pythonCmd "$EngineDir\scripts\inject-template.py" --manifest "$manifestPath" --template "$SkillTarget\SKILL.template.md" --check --compare "$skillMdPath"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ❌ Template injection verification failed (exit $LASTEXITCODE)."
            Write-Host "     Fix: check project.manifest.yaml (missing/empty keys) or SKILL.template.md"
            exit 1
        }
        Write-Host "  ✅ Template injection verified（判定通过 + 产物与磁盘字节一致）"
    } else {
        Write-Host "  ❌ SKILL.md not found after injection — write step failed, refusing to continue."
        exit 1
    }
} else {
    # ★ 不再「复制模板兜底」：模板含占位符，复制即产出「看起来装好了」的腐化 SKILL.md
    #   （本迭代失效案例 3）。无 Python ⇒ 无法注入 ⇒ 明确失败，交用户装 Python 后重跑。
    Write-Host "  ❌ Python not found — cannot inject SKILL.template.md into SKILL.md."
    Write-Host "     Template placeholders would be written verbatim; refusing to produce a broken SKILL.md."
    Write-Host "     Fix: install Python 3 + pyyaml, then re-run this installer."
    Write-Host "     Manual: python $EngineDir\scripts\inject-template.py --manifest $manifestPath --template $SkillTarget\SKILL.template.md --output $SkillTarget\SKILL.md"
    exit 1
}

# ── Step 7: 冷启动微核注入（多 IDE）───────────
Write-Host "[Step 7/8] Cold-start gate nucleus..."
$nucleusSupported = @("codebuddy","claude-code","cursor")
if ($DetectedIde -in $nucleusSupported) {
    if ($pythonCmd) {
        # ★ F3（2026-10-26）：setup-gate.py 原本从**脚本自身位置**向上找 IDE 目录推项目根
        #   ⇒ 源≠安装根时会把 MEMORY.md 写到源侧。显式传安装根（cwd）消除歧义。
        & $pythonCmd "$EngineDir\scripts\setup-gate.py" --ide $DetectedIde --project-root (Get-Location).Path
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

# ── Step 7b: 工作记忆注入配额自检（GAP-4/加固②）────
# 判据：注入文件超 8000 码元时 IDE 从头部截断 ⇒ **尾部内容静默丢失**（铁律/环境/偏好首当其冲）。
Write-Host "[Step 7b/8] Memory injection quota..."
$quotaScript = "$EngineDir\scripts\memory_quota.py"
if ($DetectedIde -eq "codebuddy" -and $pythonCmd -and (Test-Path $quotaScript)) {
    # ★ F3（2026-10-26）：原来传 cwd 相对路径，而 Step 7 的基准是安装根 ⇒ 源≠cwd 时
    #   memory_quota.py 直接 FileNotFoundError traceback（非致命但吓人）。改传绝对路径。
    & $pythonCmd $quotaScript (Join-Path (Get-Location).Path '.codebuddy\memory\MEMORY.md')
    switch ($LASTEXITCODE) {
        1 { Write-Host "  ❌ Over budget — tail will be truncated. Slim MEMORY.md now." }
        2 { Write-Host "  ⚠  Margin below 10% — plan a slimming pass soon." }
        default { Write-Host "  ✅ Quota OK" }
    }
} elseif ($DetectedIde -eq "codebuddy") {
    Write-Host "  ⏭  Skipped（memory_quota.py / Python unavailable）"
}

# ── Step 8: 门禁自检 ──────────────────────────
Write-Host "[Step 8/8] Gate self-test..."
# ★ F2（2026-10-26）：必须跑**已装副本**里的 run-gate-tests。
#   跑源副本（$EngineDir\scripts\...）时：resolveHook() 首选项 SKILL_ROOT/hooks/ 会命中
#   源仓库根的 hooks/，而 IS_PROJECT_LAYOUT 旧判据只看「父目录是否叫 hooks」⇒ 误判为项目布局
#   ⇒ dirname×3 反推出错的项目根 ⇒ SHIM/HOST 组整组跳过或全误红（实测 66/60/6、68/23/45），
#   用户看到「装好了但 45 个红」。实测对照：在安装根跑已装副本 = 87/87
#   （2026-10-28 实测；81 是 GATE-PARSE-3 之前的旧基线，勿再引用）。
#   同时去掉 --quick（它只精简「已知漏洞」明细，不改分母），并先断言 hook 真的落盘。
#
# ★ Step 8 自检第三处（TOOL-QQBOT-DIST）：-WithQqbot 却装不出 tools\qqbot = 静默半装。
#   必须在这里暴露，否则用户拿到的结论是「安装成功 + 没有 QQ 通知」且无任何提示。
if ($WithQqbot -and -not (Test-Path 'tools\qqbot\install-all.ps1')) {
    Write-Host "  ❌ -WithQqbot was requested but tools\qqbot\install-all.ps1 is missing."
    Write-Host "     Refusing to report success (silent half-install)."
    exit 1
}
$gateTestScript = "$SkillTarget\scripts\run-gate-tests.mjs"
$installedHook = if ($HookTarget) { Join-Path $HookTarget 'gate-check.mjs' } else { $null }
if (-not (Test-Path $gateTestScript)) {
    Write-Host "  ⚠  run-gate-tests.mjs not found in $SkillTarget（skipping self-test）"
} elseif ($installedHook -and -not (Test-Path $installedHook)) {
    Write-Host "  ❌ Gate hook missing at $installedHook — self-test would prove nothing. Aborting."
    exit 1
} else {
    node $gateTestScript
    if ($LASTEXITCODE -ne 0) { Write-Host "⚠ Self-test issues found. Review output above." }
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
# 这一行是「可选组件」唯一的常驻提示：组件默认不装，而缺席是静默的（fail-open），
# 不打印就等于用户永远不会知道有这条通道。
if (Test-Path 'tools\qqbot\install-all.ps1') {
    Write-Host "   3. 📱 Optional QQ channel: copied → powershell -NoProfile -ExecutionPolicy Bypass -File tools\qqbot\install-all.ps1"
} else {
    Write-Host "   3. 📱 Optional QQ channel (not installed): add -WithQqbot, or run scripts\install.ps1 -WithQqbot -ComponentsOnly later."
}
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
