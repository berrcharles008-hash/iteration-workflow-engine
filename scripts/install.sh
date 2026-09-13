#!/bin/bash
# ============================================================
# install.sh — iteration-workflow 引擎安装脚本 (Bash)
# ============================================================
#
# 目标：自动检测 IDE 环境，安装引擎 + 领域插件 + Hook 门禁
# 支持 IDE：Claude Code / CodeBuddy / Cursor / Codex / Generic
#
# v2.1.0 — 038迭代：新增 Step 5 ACTIVE初始化 + Step 6模板注入验证 + Step 7多IDE冷启动微核
# ============================================================

set -e

# ── 引擎源目录（基于脚本位置，可从任意目录运行）──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"

# ── 参数解析 ──────────────────────────────────────────
DRY_RUN=false
IDE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run|-n)
            DRY_RUN=true; shift ;;
        --ide)
            IDE="$2"; shift 2 ;;
        *)
            echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Step 1: 检测 IDE 环境（统一优先级矩阵）────
detect_ide() {
    if [ -n "$IDE" ]; then echo "$IDE"; return; fi

    local has_claude=false has_codebuddy=false has_cursor=false has_codex=false
    [ -d ".claude" ]    && has_claude=true
    [ -d ".codebuddy" ] && has_codebuddy=true
    ([ -d ".cursor" ] || [ -f ~/.cursor/hooks.json ]) && has_cursor=true
    ([ -d ".codex" ] || [ -f ".codex/config.toml" ] || command -v codex &>/dev/null) && has_codex=true

    if $has_claude; then echo "claude-code"; return; fi
    if $has_codebuddy; then echo "codebuddy"; return; fi
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
    echo "    + domain-plugins/     → $SKILL_TARGET/domain-plugins/"
    echo "    + scripts/            → $SKILL_TARGET/scripts/"
    echo "    + SKILL.template.md   → $SKILL_TARGET/"
    echo "    + README.md LICENSE   → $SKILL_TARGET/"
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
    echo "    $ 验证: 扫描 SKILL.md 中残留 {{}} 占位符"
    echo ""
    case $DETECTED_IDE in
        codebuddy|claude-code|cursor)
            echo "  Step 7 (冷启动微核):"
            echo "    $ python scripts/setup-gate.py --ide $DETECTED_IDE"
            echo ""
            ;;
    esac
    echo "  Step 8 (门禁自检):"
    echo "    $ node scripts/run-gate-tests.mjs --quick"
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  DRY RUN 完成。使用无 --dry-run 参数执行实际安装。  ║"
    echo "╚══════════════════════════════════════════════════╝"
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

# ── Step 2: 核心引擎 + 领域插件 ──────────────
echo "[Step 2/8] Copying core engine..."
mkdir -p "$SKILL_TARGET"
# 先删除再复制，避免更新安装时 cp -r 合并导致 engine/engine/ 嵌套
rm -rf "$SKILL_TARGET/engine" "$SKILL_TARGET/project" "$SKILL_TARGET/domain-plugins" "$SKILL_TARGET/scripts"
cp -r "$ENGINE_DIR/engine/"             "$SKILL_TARGET/engine/"
cp -r "$ENGINE_DIR/project/"            "$SKILL_TARGET/project/"
cp -r "$ENGINE_DIR/domain-plugins/"     "$SKILL_TARGET/domain-plugins/"
cp -r "$ENGINE_DIR/scripts/"            "$SKILL_TARGET/scripts/"
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

if command -v python &>/dev/null; then
    # 显式传入 template/output 绝对路径：脚本默认值是相对当前工作目录，
    # 不传会导致从项目根找不到 SKILL.template.md 而注入失败
    python "$ENGINE_DIR/scripts/inject-template.py" --manifest "$MANIFEST_PATH" --template "$SKILL_TARGET/SKILL.template.md" --output "$SKILL_TARGET/SKILL.md" && INJECTED_OK=1 || true
elif command -v python3 &>/dev/null; then
    python3 "$ENGINE_DIR/scripts/inject-template.py" --manifest "$MANIFEST_PATH" --template "$SKILL_TARGET/SKILL.template.md" --output "$SKILL_TARGET/SKILL.md" && INJECTED_OK=1 || true
else
    # 无 Python 兜底：直接复制模板，保证 SKILL.md 可用
    if [ -f "$SKILL_TARGET/SKILL.template.md" ] && [ ! -f "$SKILL_TARGET/SKILL.md" ]; then
        cp "$SKILL_TARGET/SKILL.template.md" "$SKILL_TARGET/SKILL.md"
        echo "  ✅ SKILL.md created by direct copy (Python unavailable)"
    fi
    echo "  ⚠  Python not found. Skipping template injection."
    echo "     Run manually: python $ENGINE_DIR/scripts/inject-template.py --manifest $MANIFEST_PATH --template $SKILL_TARGET/SKILL.template.md --output $SKILL_TARGET/SKILL.md"
fi

# ── 方案 B: 占位符验证 ──
if [ $INJECTED_OK -eq 1 ]; then
    SKILL_MD="$SKILL_TARGET/SKILL.md"
    if [ -f "$SKILL_MD" ]; then
        RESIDUALS=$(perl -ne 'print "$&\n" while /\{\{\w+(?:[\._-]\w+)*\}\}/g' "$SKILL_MD" 2>/dev/null | sort -u || true)
        if [ -n "$RESIDUALS" ]; then
            echo "  ❌ Unresolved template placeholders found in SKILL.md:"
            echo "$RESIDUALS" | while read -r line; do echo "     $line"; done
            echo ""
            echo "     This usually means inject-template.py failed silently (e.g. missing yaml module)."
            echo "     Fix: pip install pyyaml && re-run install"
            exit 1
        else
            echo "  ✅ Template injection verified（no unresolved placeholders）"
        fi
    else
        echo "  ⏭  SKILL.md not found, skipping placeholder verification"
    fi
fi

# ── Step 7: 冷启动微核注入（多 IDE）──────────────────────
echo "[Step 7/8] Cold-start gate nucleus..."
case $DETECTED_IDE in
    codebuddy|claude-code|cursor)
        if command -v python &>/dev/null || command -v python3 &>/dev/null; then
            PY_CMD=$(command -v python || command -v python3)
            $PY_CMD "$ENGINE_DIR/scripts/setup-gate.py" --ide "$DETECTED_IDE"
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
GATE_TEST="$ENGINE_DIR/scripts/run-gate-tests.mjs"
if [ -f "$GATE_TEST" ]; then
    node "$GATE_TEST" --quick || echo "⚠ Self-test issues found. Review output above."
else
    echo "  ⚠  run-gate-tests.mjs not found（skipping self-test）"
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
