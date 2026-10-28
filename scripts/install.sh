#!/bin/bash
# ============================================================
# install.sh — iteration-workflow 引擎安装脚本 (Bash)
# ============================================================
#
# 目标：自动检测 IDE 环境，安装引擎 + 领域插件 + Hook 门禁
# 支持 IDE：Claude Code / CodeBuddy / Cursor / Codex / Generic
#
# v2.1.0 — 038迭代：新增 Step 5 ACTIVE初始化 + Step 6模板注入验证 + Step 7多IDE冷启动微核
# v2.2.0 — ★ FIX-49（2026-10-15）：detect_ide 探测顺序反转（.codebuddy 优先）+ env 加分信号
#          + 双目录并存需显式 --ide / --force（防把宿主 skill 装到废弃侧）
# v2.5.0 — ★ F1/F2/F3（2026-10-26 TOOL-ENGCLOSE-1026）：Step 6 前引导填空 specs_dir（F1）·
#          Step 8 改跑已装副本（F2）· Step 4 源缺 hooks 硬失败 / Step 7 传安装根（F3）· 新增 --specs-dir
# ============================================================

set -e

# ── 引擎源目录（基于脚本位置，可从任意目录运行）──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"

# ── 参数解析 ──────────────────────────────────────────
DRY_RUN=false
IDE=""
FORCE=false
# ★ F1（2026-10-26）：覆盖 bootstrap-manifest.py 的推导默认值（空 ⇒ 按 IDE 推导）
SPECS_DIR=""
# ★ TOOL-QQBOT-DIST（2026-10-28）：可选组件开关。qqbot 是 Windows-only
#   （启动文件夹快捷方式 / schtasks 计划任务 / shutdown.exe / GBK 解码），POSIX 侧
#   故意**不实现拷贝**：装一份跑不起来的工具包比不装更糟（用户会以为已启用）。
#   这里只做「接受参数 + 明示」，避免 `--with-qqbot` 被判 Unknown option 直接退出。
WITH_QQBOT=false
COMPONENTS_ONLY=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run|-n)
            DRY_RUN=true; shift ;;
        --ide)
            IDE="$2"; shift 2 ;;
        --force)
            FORCE=true; shift ;;
        --specs-dir)
            SPECS_DIR="$2"; shift 2 ;;
        --with-qqbot)
            WITH_QQBOT=true; shift ;;
        --components-only)
            COMPONENTS_ONLY=true; shift ;;
        *)
            echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Step 1: 检测 IDE 环境（统一优先级矩阵 · ★ FIX-49 R24 修订）────
# ★ FIX-49（2026-10-15 · R24）：探测顺序**反转**（`.codebuddy` 优先）+ env 加分信号 +
#   双目录并存且未显式 `--ide` ⇒ 警告并要求确认（`--force` 才继续）——
#   动因：双目录并存仓库下旧顺序（`.claude` 优先）会把 CodeBuddy 宿主的 skill 装到废弃侧
#   （09-28 翻转后通道敞开；见 runtime/FIX-49-四件套.md §②行 27 / ①-补 复核补充）。
detect_ide() {
    if [ -n "$IDE" ]; then echo "$IDE"; return; fi

    local has_claude=false has_codebuddy=false has_cursor=false has_codex=false
    [ -d ".claude" ]    && has_claude=true
    [ -d ".codebuddy" ] && has_codebuddy=true
    ([ -d ".cursor" ] || [ -f ~/.cursor/hooks.json ]) && has_cursor=true
    ([ -d ".codex" ] || [ -f ".codex/config.toml" ] || command -v codex &>/dev/null) && has_codex=true

    if $has_codebuddy && $has_claude && [ "$FORCE" != true ]; then
        echo "❌ 检测到 .codebuddy 与 .claude 双目录并存（未显式指定目标侧）——" >&2
        echo "   FIX-49（R24）要求显式确认，避免把宿主 skill 装到错误一侧：" >&2
        echo "     · 装到 CodeBuddy : --ide codebuddy      · 装到 Claude Code : --ide claude-code" >&2
        echo "     · 或接受默认（.codebuddy 优先）: --force" >&2
        exit 2
    fi
    if [ -n "$CODEBUDDY_PROJECT_DIR" ] && $has_codebuddy; then echo "codebuddy"; return; fi
    if [ -n "$CLAUDE_PROJECT_DIR" ] && $has_claude; then echo "claude-code"; return; fi
    if $has_codebuddy; then echo "codebuddy"; return; fi
    if $has_claude; then echo "claude-code"; return; fi
    if $has_cursor; then echo "cursor"; return; fi
    if $has_codex; then echo "codex"; return; fi
    echo "generic"
}

DETECTED_IDE=$(detect_ide)
SKILL_TARGET=""
HOOK_TARGET=""

case $DETECTED_IDE in
    claude-code)
        SKILL_TARGET=".claude/skills/iteration-workflow"
        HOOK_TARGET=".claude/hooks"
        ;;
    codebuddy)
        SKILL_TARGET=".codebuddy/skills/iteration-workflow"
        HOOK_TARGET=".codebuddy/hooks"
        ;;
    cursor)
        SKILL_TARGET=".cursor/skills/iteration-workflow"
        HOOK_TARGET="$HOME/.cursor/hooks"
        ;;
    codex)
        SKILL_TARGET=".codex/skills/iteration-workflow"
        HOOK_TARGET=".codex/hooks"
        ;;
    generic)
        SKILL_TARGET="./output/skills/iteration-workflow"
        HOOK_TARGET=""
        ;;
esac

if $DRY_RUN; then
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  DRY RUN — 安装预览                               ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""
    echo "  IDE           : $DETECTED_IDE"
    echo "  SKILL_TARGET  : $SKILL_TARGET"
    echo "  HOOK_TARGET   : ${HOOK_TARGET:-（无 — generic 模式无 Hook）}"
    echo "  ENGINE_DIR    : $ENGINE_DIR"
    echo ""
    echo "  Step 2 (核心引擎):"
    echo "    + engine/             → $SKILL_TARGET/engine/"
    echo "    + project/            → $SKILL_TARGET/project/"
    echo "    + scripts/            → $SKILL_TARGET/scripts/"
    echo "    + SKILL.template.md   → $SKILL_TARGET/"
    echo "    + README.md LICENSE   → $SKILL_TARGET/"
    echo ""
    echo "  Step 2b (可选组件 — 默认不装):"
    if $WITH_QQBOT; then
        echo "    ⏭  qqbot 仅支持 Windows —— 本脚本不拷贝（请用 scripts/install.ps1 -WithQqbot）"
    else
        echo "    状态: 不安装（需要时在 Windows 上执行 install.ps1 -WithQqbot）"
    fi
    echo ""
    echo "  Step 3 (IDE adapter — 简化模式：仅差异文件):"
    case $DETECTED_IDE in
        cursor)
            echo "    + adapters/cursor/rules/.cursorrules.template → $SKILL_TARGET/rules/"
            ;;
        generic)
            echo "    + adapters/generic/README.md → $SKILL_TARGET/"
            ;;
        *)
            echo "    （无 IDE 差异文件，共享文件已在 Step 2 复制）"
            ;;
    esac
    echo ""
    echo "  Step 4 (Hook 门禁):"
    if [ -n "$HOOK_TARGET" ]; then
        echo "    + hooks/gate-check.mjs → $HOOK_TARGET/"
        if [ "$DETECTED_IDE" = "claude-code" ] || [ "$DETECTED_IDE" = "codebuddy" ]; then
            echo "    （RUNTIME_DIR 三元表达式无需 sed 替换 — 运行时自动检测）"
        fi
    else
        echo "    （generic 模式仅 prompt 层门禁，无 Hook）"
    fi
    echo ""
    echo "  Step 5 (ACTIVE初始化):"
    echo "    $ mkdir -p $SKILL_TARGET/runtime && echo 'none\nSTATUS=none PHASE=none' > ACTIVE"
    echo ""
    echo "  Step 6 (模板注入 + 验证):"
    echo "    $ 若 project.manifest.yaml 不存在，从 .template 创建"
    echo "    $ python scripts/inject-template.py --manifest $SKILL_TARGET/project/project.manifest.yaml --template $SKILL_TARGET/SKILL.template.md --output $SKILL_TARGET/SKILL.md"
    echo "    $ 验证: python scripts/inject-template.py --check --compare $SKILL_TARGET/SKILL.md"
    echo ""
    case $DETECTED_IDE in
        codebuddy|claude-code|cursor)
            echo "  Step 7 (冷启动微核):"
            echo "    $ python scripts/setup-gate.py --ide $DETECTED_IDE"
            echo ""
            ;;
    esac
    echo "  Step 8 (门禁自检):"
    echo "    $ node scripts/run-gate-tests.mjs   # 已装副本；分母应为 87（--quick 只精简明细，勿用于验收）"
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  DRY RUN 完成。使用无 --dry-run 参数执行实际安装。  ║"
    echo "╚══════════════════════════════════════════════════╝"
    exit 0
fi

# ── 轻量组件模式（--components-only）──────────────────────────────
# 对称 install.ps1 的同名开关，但本平台无组件可装 ⇒ 只报状态并退出（不进入后 8 步，
# 因为「只查/只装组件」不应触发备份与 engine/scripts 整替）。
if $COMPONENTS_ONLY; then
    if [ -f "tools/qqbot/install-all.ps1" ]; then
        echo "  ✅ qqbot 已安装: tools/qqbot"
    else
        echo "  ○  qqbot 未安装（Windows-only 组件；请在 Windows 上执行 scripts/install.ps1 -WithQqbot -ComponentsOnly）"
    fi
    exit 0
fi

echo "========================================"
echo " iteration-workflow engine installer"
echo "========================================"
echo "  IDE: $DETECTED_IDE"
echo ""

if [ "$DETECTED_IDE" = "generic" ]; then
    echo "⚠ No IDE detected. Installed to ./output/ for manual setup."
    echo "   See adapters/generic/README.md for manual instructions."
fi

# ── Step 2: 核心引擎（G02：领域插件层已下线，不再复制其目录）──────────────
echo "[Step 2/8] Copying core engine..."
mkdir -p "$SKILL_TARGET"
# 先删除再复制，避免更新安装时 cp -r 合并导致 engine/engine/ 嵌套
# ⚠ project/ 不参与整目录替换（对齐 install.ps1 Step 2 的既有语义）：它存放用户已填的项目配置，
#   而引擎仓库的 project/ 只有 *.template（project.manifest.yaml 由本脚本 Step 6 从模板生成）——
#   先 rm 就再没有源可补，Step 6 只会拿空模板回填 ⇒ 升级安装把用户配置**静默重置成待填空表**
#   （安装照常打印成功，用户以为只是升级了引擎）。故这里只对缺失条目做增量补齐，已存在的一律不动。
rm -rf "$SKILL_TARGET/engine" "$SKILL_TARGET/scripts"
cp -r "$ENGINE_DIR/engine/"             "$SKILL_TARGET/engine/"
cp -r "$ENGINE_DIR/scripts/"            "$SKILL_TARGET/scripts/"
mkdir -p "$SKILL_TARGET/project"
# 用 -e 判存在（同时覆盖文件与子目录）；无匹配时 glob 原样返回 ⇒ 首个 -e 即跳过
for _pj in "$ENGINE_DIR"/project/*; do
    [ -e "$_pj" ] || continue
    _pname="$(basename "$_pj")"
    if [ ! -e "$SKILL_TARGET/project/$_pname" ]; then
        cp -r "$_pj" "$SKILL_TARGET/project/$_pname"
        echo "  [+] project/$_pname (new)"
    fi
done
cp "$ENGINE_DIR/SKILL.template.md"      "$SKILL_TARGET/"
cp "$ENGINE_DIR/README.md" "$ENGINE_DIR/LICENSE" "$ENGINE_DIR/CONTRIBUTING.md" "$SKILL_TARGET/" 2>/dev/null || true

# ── Step 3: IDE 专属 adapter（简化：仅复制差异文件）────
echo "[Step 3/8] Installing IDE adapter..."
mkdir -p "$SKILL_TARGET/rules"
case $DETECTED_IDE in
    cursor)
        cp "$ENGINE_DIR/adapters/cursor/rules/.cursorrules.template" "$SKILL_TARGET/rules/"
        echo "  ✅ Cursor rules installed"
        ;;
    generic)
        cp "$ENGINE_DIR/adapters/generic/README.md" "$SKILL_TARGET/"
        echo "  ✅ Generic adapter README installed"
        ;;
    claude-code|codebuddy|codex)
        # 无 IDE 差异文件，共享文件已在 Step 2 复制
        echo "  ✅ No IDE-specific files needed（shared files already copied）"
        ;;
esac

# ── Step 4: Hook 安装（单源 gate-check.mjs）────
echo "[Step 4/8] Installing gate hook..."
if [ -n "$HOOK_TARGET" ]; then
    # ★ F3（2026-10-26）：源缺 hooks/ 时旧写法只让 cp 报错，随后仍打印「✅ installed」
    #   ⇒ 装出的项目没有门禁却显示成功。改为硬失败（安装源必须是引擎仓库）。
    if [ ! -f "$ENGINE_DIR/hooks/gate-check.mjs" ]; then
        echo "  ❌ gate hook source missing: $ENGINE_DIR/hooks/gate-check.mjs"
        echo "     The install source must be the engine repo (it carries hooks/gate-check.mjs)."
        exit 1
    fi
    mkdir -p "$HOOK_TARGET"
    cp "$ENGINE_DIR/hooks/gate-check.mjs" "$HOOK_TARGET/"
    
    # RUNTIME_DIR 三元表达式在 gate-check.mjs 中已同时检查 .claude 和 .codebuddy
    # 无需 sed 替换（运行时自动检测）
    
    case $DETECTED_IDE in
        cursor)
            echo "⚠ Cursor Hook installed to $HOOK_TARGET (user-level)."
            echo "  Update ~/.cursor/hooks.json to reference this script."
            ;;
        codex)
            echo "  ✅ Codex Hook installed to $HOOK_TARGET"
            ;;
        *)
            echo "  ✅ $DETECTED_IDE Hook installed to $HOOK_TARGET"
            ;;
    esac
else
    echo "  ⚠  Generic mode: no Hook available（prompt-level gate only）"
fi

# ── Step 5: ACTIVE 状态初始化 ────────────────────────
echo "[Step 5/8] Initializing runtime state..."
RUNTIME_DIR="$SKILL_TARGET/runtime"
ACTIVE_FILE="$RUNTIME_DIR/ACTIVE"

if [ -f "$ACTIVE_FILE" ]; then
    if grep -q 'STATUS=' "$ACTIVE_FILE" 2>/dev/null; then
        echo "  ✅ ACTIVE already initialized, skipping"
    else
        echo "  ⚠  ACTIVE exists but format unrecognized — recreating"
        recreate=true
    fi
else
    recreate=true
fi

if [ "${recreate:-false}" = true ]; then
    mkdir -p "$RUNTIME_DIR"
    printf "none\nSTATUS=none PHASE=none" > "$ACTIVE_FILE"
    echo "  ✅ ACTIVE initialized (none)"
fi

# ── Step 6: 模板注入 + 占位符验证 ─────────────────────
echo "[Step 6/8] Injecting template..."
INJECTED_OK=0
MANIFEST_PATH="$SKILL_TARGET/project/project.manifest.yaml"
MANIFEST_TPL="$SKILL_TARGET/project/project.manifest.yaml.template"

# 首次安装：从模板创建 project.manifest.yaml（已存在则不覆盖，避免抹掉用户已填内容）
if [ ! -f "$MANIFEST_PATH" ] && [ -f "$MANIFEST_TPL" ]; then
    cp "$MANIFEST_TPL" "$MANIFEST_PATH"
    echo "  ✅ Created project.manifest.yaml from template (to be filled in)"
fi

# ★ F1（2026-10-26）：模板 ★必填全空，而注入器把空串当缺键并**拒绝落盘**
#   （inject-template.py 2026-10-25 BLOCKER-1 的反腐化设计）⇒ 两者相邻使全新 clone 必然装不上。
#   SKILL.template.md 只需要 SPECS_DIR / KB_DIR，kb_dir 有默认值 ⇒ 只需填 paths.specs_dir。
#   按已探测 IDE 推导，仅填空值（幂等），--specs-dir 可覆盖。
case "$DETECTED_IDE" in
    codebuddy|claude-code|cursor|codex)
        PY_BOOTSTRAP="$(command -v python || command -v python3 || true)"
        if [ -n "$PY_BOOTSTRAP" ] && [ -f "$ENGINE_DIR/scripts/bootstrap-manifest.py" ]; then
            # set -e 下必须捕获退出码（`|| rc=$?`），否则会在此处静默中断而不打印原因
            rc=0
            if [ -n "$SPECS_DIR" ]; then
                "$PY_BOOTSTRAP" "$ENGINE_DIR/scripts/bootstrap-manifest.py" --manifest "$MANIFEST_PATH" --ide "$DETECTED_IDE" --specs-dir "$SPECS_DIR" || rc=$?
            else
                "$PY_BOOTSTRAP" "$ENGINE_DIR/scripts/bootstrap-manifest.py" --manifest "$MANIFEST_PATH" --ide "$DETECTED_IDE" || rc=$?
            fi
            if [ $rc -ne 0 ]; then
                echo "  ❌ manifest bootstrap failed."
                echo "     Fix: set paths.specs_dir in $MANIFEST_PATH (or pass --specs-dir <path>) and re-run."
                exit 1
            fi
        else
            echo "  ⚠  bootstrap-manifest.py / python not available — paths.specs_dir must be filled manually."
        fi
        ;;
    *)
        echo "  ⏭  manifest bootstrap skipped（generic 模式无 IDE 推导）"
        ;;
esac

if command -v python &>/dev/null; then
    # 显式传入 template/output 绝对路径：脚本默认值是相对当前工作目录，
    # 不传会导致从项目根找不到 SKILL.template.md 而注入失败。
    # ★ 必须透传退出码：历史写法 `... && INJECTED_OK=1 || true` 使 INJECTED_OK 恒为 0
    #   ⇒ 下方占位符验证分支（`if [ $INJECTED_OK -eq 1 ]`）永不执行 ⇒ 注入失败被静默吞掉。
    if python "$ENGINE_DIR/scripts/inject-template.py" --manifest "$MANIFEST_PATH" --template "$SKILL_TARGET/SKILL.template.md" --output "$SKILL_TARGET/SKILL.md"; then
        INJECTED_OK=1
    else
        echo "  ❌ Template injection failed (see messages above)."
        echo "     Fix: pip install pyyaml && re-run install (check manifest / template)"
        exit 1
    fi
elif command -v python3 &>/dev/null; then
    if python3 "$ENGINE_DIR/scripts/inject-template.py" --manifest "$MANIFEST_PATH" --template "$SKILL_TARGET/SKILL.template.md" --output "$SKILL_TARGET/SKILL.md"; then
        INJECTED_OK=1
    else
        echo "  ❌ Template injection failed (see messages above)."
        echo "     Fix: pip install pyyaml && re-run install (check manifest / template)"
        exit 1
    fi
else
    # ★ 不再「复制模板兜底」：模板含占位符，复制即产出「看起来装好了」的腐化 SKILL.md
    #   （本迭代失效案例 3：用户得到 89 处未解析占位符的产物却以为安装成功）。
    #   无 Python ⇒ 无法注入 ⇒ 明确失败，交用户装 Python 后重跑。
    echo "  ❌ Python not found — cannot inject SKILL.template.md into SKILL.md."
    echo "     Template placeholders would be written verbatim; refusing to produce a broken SKILL.md."
    echo "     Fix: install Python 3 + pyyaml, then re-run this installer."
    echo "     Manual: python $ENGINE_DIR/scripts/inject-template.py --manifest $MANIFEST_PATH --template $SKILL_TARGET/SKILL.template.md --output $SKILL_TARGET/SKILL.md"
    exit 1
fi

# ── 方案 B: 占位符验证（★ 复用注入器的判据，不另写一套正则）──
# 历史写法是 `perl ... 2>/dev/null | sort -u || true`：三重吞噬 —— 新引入 perl 依赖、
# 吞掉 stderr、`|| true` 抹平退出码 ⇒ 无 perl 的机器上 RESIDUALS 恒空、打印「✅ verified」
# 假绿。且它把**任意** `{{...}}` 都当错误，与注入器放行 ②③④ 的口径冲突（第二套规则）。
# 现改为调 `--check --compare`：前者判「该解析的解析了」，后者确认盘上文件就是本次注入结果。
if [ $INJECTED_OK -eq 1 ]; then
    SKILL_MD="$SKILL_TARGET/SKILL.md"
    PY_INJECT="$(command -v python || command -v python3)"
    if [ ! -f "$SKILL_MD" ]; then
        echo "  ❌ SKILL.md not found after injection — write step failed, refusing to continue."
        exit 1
    fi
    if "$PY_INJECT" "$ENGINE_DIR/scripts/inject-template.py" --manifest "$MANIFEST_PATH" --template "$SKILL_TARGET/SKILL.template.md" --check --compare "$SKILL_MD"; then
        echo "  ✅ Template injection verified（判定通过 + 产物与磁盘字节一致）"
    else
        rc=$?
        echo "  ❌ Template injection verification failed (exit $rc)."
        echo "     Fix: check project.manifest.yaml (missing/empty keys) or SKILL.template.md"
        exit 1
    fi
fi

# ── Step 7: 冷启动微核注入（多 IDE）──────────────────────
echo "[Step 7/8] Cold-start gate nucleus..."
case $DETECTED_IDE in
    codebuddy|claude-code|cursor)
        if command -v python &>/dev/null || command -v python3 &>/dev/null; then
            PY_CMD=$(command -v python || command -v python3)
            # ★ F3（2026-10-26）：显式传安装根，避免「源≠安装根」时把 MEMORY.md 写到源侧
            $PY_CMD "$ENGINE_DIR/scripts/setup-gate.py" --ide "$DETECTED_IDE" --project-root "$(pwd)"
            if [ $? -eq 0 ]; then
                echo "  ✅ Cold-start gate nucleus injected (or already present)"
            else
                echo "  ⚠  setup-gate.py exited with code $?"
            fi
        else
            echo "  ⚠  Python not found, skipping cold-start gate nucleus"
        fi
        ;;
    *)
        echo "  ⏭  Skipped（$DETECTED_IDE: prompt-level gate only）"
        ;;
esac

# ── Step 8: 门禁自检 ──────────────────────────────────
echo "[Step 8/8] Gate self-test..."
# ★ F2（2026-10-26）：必须跑**已装副本**里的 run-gate-tests。
#   跑源副本（$ENGINE_DIR/scripts/...）时 resolveHook() 首选项 SKILL_ROOT/hooks/ 会命中源仓库根的
#   hooks/，旧布局判据只看「父目录是否叫 hooks」⇒ 误判为项目布局 ⇒ dirname×3 反推出错的项目根
#   ⇒ SHIM/HOST 组整组跳过或全误红（实测 66/60/6、68/23/45）。实测对照：已装副本 = 81/81。
#   同时去掉 --quick（只精简「已知漏洞」明细，不改分母），并先断言 hook 已落盘。
GATE_TEST="$SKILL_TARGET/scripts/run-gate-tests.mjs"
if [ ! -f "$GATE_TEST" ]; then
    echo "  ⚠  run-gate-tests.mjs not found in $SKILL_TARGET（skipping self-test）"
elif [ -n "$HOOK_TARGET" ] && [ ! -f "$HOOK_TARGET/gate-check.mjs" ]; then
    echo "  ❌ Gate hook missing at $HOOK_TARGET/gate-check.mjs — self-test would prove nothing. Aborting."
    exit 1
else
    node "$GATE_TEST" || echo "⚠ Self-test issues found. Review output above."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Installed to $SKILL_TARGET"
echo ""
echo "   Next steps:"
echo "   1. Edit project/project.manifest.yaml"
if [ "$DETECTED_IDE" = "generic" ]; then
    echo "   2. ⚠️  Your IDE (generic) uses prompt-level gate protection."
    echo "      The gate will only work when the agent loads this Skill."
    echo "      Verify: open a new session and type '修改一个文件' to test."
else
    echo "   2. 🔒 Hook-level gate protection active ($DETECTED_IDE)."
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
