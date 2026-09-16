#!/usr/bin/env python3
"""setup-gate.py — 多 IDE 冷启动门禁微核注入脚本

将 cold-start-gate-nucleus 注入到目标 IDE 的配置文件，
为 Agent IDE 提供冷启动门禁保护。

支持 IDE：
  - CodeBuddy (.codebuddy/memory/MEMORY.md)
  - Claude Code (CLAUDE.md)
  - Cursor (.cursorrules)

用法：
  python setup-gate.py                  # 自动检测并注入（幂等）
  python setup-gate.py --ide cursor     # 指定目标 IDE
  python setup-gate.py --check          # 仅检测，不写入
  python setup-gate.py --force          # 强制重新注入（覆盖旧版本）
"""

import os
import re
import sys
import hashlib
import shutil
import time
from pathlib import Path


# ─── 配置 ───────────────────────────────────────────────

NUCLEUS_TEMPLATE = "cold-start-gate-nucleus.md"
NUCLEUS_MARKER_PREFIX = "cold-start-gate-nucleus"   # 版本无关：只匹配前缀
NUCLEUS_VERSION = "v1.0"                              # 默认值；启动时由模板动态覆盖

# ⚠ 禁止再用「注释文字」当微核边界！v1.3 及以前用 GATE_MARKER 判定微核结束，
#   实际命中的是模板头部说明注释（位于正文之前）→ 只删注释头、正文整段残留，
#   且只剥第一份 ⇒ 每跑一次 --force 多叠一份微核（FIX-4 根因）。
#   v1.4+ 一律用 NUCLEUS-BEGIN / NUCLEUS-END 显式边界标记。
NUCLEUS_BEGIN_RE = re.compile(
    r"[^\S\n]*<!--\s*NUCLEUS-BEGIN.*?NUCLEUS-END\s*-->[^\S\n]*\n?", re.S)
# 兜底：v1.3 及更早注入的旧微核没有边界标记 → 从起始注释块删到首个 '---' 分隔线
LEGACY_NUCLEUS_RE = re.compile(
    r"<!--(?:(?!-->).)*?cold-start-gate-nucleus.*?(?:\n[^\S\n]*---[^\S\n]*\n|\Z)", re.S)
# 剥离后正文开头可能残留 '---' 分隔线（历史注入遗留，且常被空行隔开），清掉以免每次 force 累积
LEADING_SEP_RE = re.compile(r"\A(?:\s*---\s*(?:\n|\Z))+")

# IDE 映射：ide_dir 用于 {{IDE_DIR}} 占位符替换 + 技能路径探测
#          target   用于确定微核注入的目标文件（项目根目录相对路径）
IDE_MAP = {
    "codebuddy":   {"ide_dir": ".codebuddy", "target": ".codebuddy/memory/MEMORY.md", "desc": "CodeBuddy IDE"},
    "claude-code": {"ide_dir": ".claude",    "target": "CLAUDE.md",        "desc": "Claude Code (CLAUDE.md)"},
    "cursor":      {"ide_dir": ".cursor",    "target": ".cursorrules",     "desc": "Cursor (.cursorrules)"},
}

SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = SCRIPT_DIR.parent / "engine" / "templates"
TEMPLATE_PATH = TEMPLATE_DIR / NUCLEUS_TEMPLATE


def _read_template_version() -> str:
    """从模板文件动态读取版本号（如 'cold-start-gate-nucleus v1.1' → 'v1.1'）。
    解析失败则返回初始值 NUCLEUS_VERSION。"""
    global NUCLEUS_VERSION
    if not TEMPLATE_PATH.exists():
        return NUCLEUS_VERSION
    try:
        for line in TEMPLATE_PATH.read_text(encoding="utf-8").split("\n"):
            if "cold-start-gate-nucleus" in line:
                for token in line.strip().split():
                    if token.startswith("v") and token[1:2].isdigit():
                        NUCLEUS_VERSION = token.rstrip(" -->").rstrip(":")
                        return NUCLEUS_VERSION
    except Exception:
        pass
    return NUCLEUS_VERSION


# ─── 环境检测 ───────────────────────────────────────────

def detect_environment(ide_hint=None):
    """检测 IDE 环境，返回 (ide_key, target_path, ide_dir)
    
    Args:
        ide_hint: 指定的 IDE key，如 "codebuddy"/"claude-code"/"cursor"。
                  None 时自动检测（优先 CodeBuddy → Claude Code → Cursor）。

    Returns:
        (ide_key, target_path, ide_dir) 或 (None, None, None)
    """
    # 找到项目根目录（包含任意 IDE 目录的目录）
    candidate = SCRIPT_DIR
    project_root = None
    for _ in range(5):
        if (candidate / ".codebuddy").is_dir() or \
           (candidate / ".claude").is_dir() or \
           (candidate / ".cursor").is_dir():
            project_root = candidate
            break
        candidate = candidate.parent

    if project_root is None:
        # Fallback: use cwd
        project_root = Path.cwd()

    if ide_hint:
        info = IDE_MAP.get(ide_hint)
        if not info:
            return None, None, None
        target_path = project_root / info["target"]
        return ide_hint, target_path, info["ide_dir"]

    # 自动检测：按优先级 CodeBuddy → Claude Code → Cursor
    for key, info in IDE_MAP.items():
        if (project_root / info["ide_dir"]).is_dir():
            target_path = project_root / info["target"]
            return key, target_path, info["ide_dir"]

    # 无任何 IDE 目录，默认回退到 CodeBuddy
    target_path = project_root / "MEMORY.md"
    return "codebuddy", target_path, ".codebuddy"


# ─── 检查 ───────────────────────────────────────────────

def has_nucleus(target_path: Path) -> bool:
    """检查目标文件是否已包含微核段（按前缀匹配，版本无关）"""
    if not target_path.exists():
        return False
    content = target_path.read_text(encoding="utf-8")
    return NUCLEUS_MARKER_PREFIX in content


def get_nucleus_version(target_path: Path) -> str:
    """Get version of injected nucleus, or None if not present"""
    if not target_path.exists():
        return None
    content = target_path.read_text(encoding="utf-8")
    for line in content.split("\n"):
        if "cold-start-gate-nucleus" in line:
            parts = line.strip().split()
            for p in parts:
                if p.startswith("v"):
                    return p.rstrip(" -->")
    return None


# ─── 模板渲染 ───────────────────────────────────────────

def render_template(ide_dir: str) -> str:
    """读取模板并替换 {{IDE_DIR}} 占位符"""
    raw = TEMPLATE_PATH.read_text(encoding="utf-8")
    return raw.replace("{{IDE_DIR}}", ide_dir)


# ─── 微核剥离 / 计数 ─────────────────────────────────────

def count_nucleus_blocks(content: str) -> int:
    """统计微核份数（v1.4+ 边界标记 与 旧版版本注释，取较大者以防漏报）"""
    return max(len(NUCLEUS_BEGIN_RE.findall(content)),
               content.count(NUCLEUS_MARKER_PREFIX))


def strip_nucleus(content: str):
    """剥离全部微核段，返回 (clean_content, removed_count, mode)

    mode: "marker" = v1.4+ 显式边界；"legacy" = 旧版启发式兜底；"none" = 未发现
    """
    cleaned, n = NUCLEUS_BEGIN_RE.subn("", content)
    if n:
        return cleaned, n, "marker"
    cleaned, n = LEGACY_NUCLEUS_RE.subn("", content)
    if n:
        return cleaned, n, "legacy"
    return content, 0, "none"


# ─── 注入 ───────────────────────────────────────────────

def inject_nucleus(target_path: Path, ide_dir: str) -> bool:
    """Inject nucleus template into target file (preserve existing content)"""
    if not TEMPLATE_PATH.exists():
        safe_print(f"[FAIL] Template not found: {TEMPLATE_PATH}")
        return False

    nucleus_content = render_template(ide_dir)

    if target_path.exists():
        existing = target_path.read_text(encoding="utf-8")
        # 如果已有内容，追加到末尾（用分隔线隔开）
        new_content = nucleus_content + "\n\n---\n\n" + existing
    else:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        new_content = nucleus_content

    target_path.write_text(new_content, encoding="utf-8")
    return True


def force_inject(target_path: Path, ide_dir: str) -> bool:
    """Force re-injection (remove ALL old nucleus blocks, write fresh)

    v1.4+：按 NUCLEUS-BEGIN / NUCLEUS-END 显式边界全量剥离；
    旧版（无标记）：走 LEGACY_NUCLEUS_RE 启发式兜底并告警。
    v1.7+（GAP-2 A+）：正文只归一化开头（不再 strip 尾部）；写入前做「正文零变化」校验 +
    自动备份到 {ide_dir}/temp —— 保证手工维护过的正文不会被 --force 意外改写。
    """
    if not TEMPLATE_PATH.exists():
        safe_print(f"[FAIL] Template not found: {TEMPLATE_PATH}")
        return False

    nucleus_content = render_template(ide_dir)

    if target_path.exists():
        existing = target_path.read_text(encoding="utf-8")
        clean, removed, mode = strip_nucleus(existing)
        if removed > 1:
            safe_print(f"[WARN] Removed {removed} nucleus blocks (mode={mode}) — "
                       f"file was polluted by the pre-v1.4 --force bug.")
        elif removed == 1:
            safe_print(f"[INFO] Removed 1 nucleus block (mode={mode}).")
        else:
            safe_print(f"[WARN] No nucleus block found in {target_path.name}; "
                       f"prepending a fresh one.")
        if mode == "legacy":
            safe_print(f"[WARN] Legacy nucleus (no NUCLEUS-BEGIN marker) stripped "
                       f"heuristically — please eyeball {target_path.name}.")
        # ★ A+（GAP-2）：正文保护 —— 只归一化**开头**（去空白 + 前置分隔线），
        #   尾部与内部原样保留（旧版 clean.strip() 会改动正文首尾空白）
        body = LEADING_SEP_RE.sub("", clean.lstrip())
        new_content = nucleus_content + "\n\n---\n\n" + body if body else nucleus_content

        # ★ A+：正文零变化校验 —— 对新内容重新剥离微核，正文须与 body 完全一致
        recheck, re_removed, _ = strip_nucleus(new_content)
        recheck_body = LEADING_SEP_RE.sub("", recheck.lstrip())
        if re_removed != 1 or recheck_body != body:
            safe_print(f"[FAIL] Body integrity check failed — aborting; "
                       f"{target_path.name} left untouched.")
            return False

        # ★ A+：写入前自动备份（优先 {ide_dir}/temp，回退同目录）
        ts = time.strftime("%Y%m%d-%H%M%S")
        temp_dir = Path(ide_dir) / "temp"
        backup_dir = temp_dir if temp_dir.is_dir() else target_path.parent
        try:
            backup = backup_dir / (target_path.name + f".bak-force-{ts}")
            shutil.copy2(target_path, backup)
            safe_print(f"[INFO] Backup: {backup}（确认无误后可删）")
        except Exception as e:
            safe_print(f"[WARN] Backup failed ({e}); continue without backup.")
    else:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        new_content = nucleus_content

    target_path.write_text(new_content, encoding="utf-8")
    return True


def compute_template_hash() -> str:
    """计算模板文件的 SHA256"""
    if not TEMPLATE_PATH.exists():
        return "TEMPLATE_NOT_FOUND"
    content = TEMPLATE_PATH.read_bytes()
    return hashlib.sha256(content).hexdigest()[:16]


# ─── 主流程 ─────────────────────────────────────────────

def safe_print(*args, **kwargs):
    """Print with encoding-safe fallback for Windows GBK consoles."""
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        # Fallback: strip non-ASCII characters
        safe_args = []
        for a in args:
            if isinstance(a, str):
                safe_args.append(a.encode('ascii', errors='replace').decode('ascii'))
            else:
                safe_args.append(a)
        print(*safe_args, **kwargs)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Inject cold-start gate nucleus (multi-IDE)")
    parser.add_argument("--ide", choices=list(IDE_MAP.keys()),
                        help="Target IDE (default: auto-detect)")
    parser.add_argument("--check", action="store_true", help="Check only, no write")
    parser.add_argument("--force", action="store_true", help="Force re-injection")
    args = parser.parse_args()

    ide_key, target_path, ide_dir = detect_environment(ide_hint=args.ide)

    if ide_key is None:
        safe_print(f"[FAIL] Unknown IDE: {args.ide}")
        safe_print(f"       Supported: {', '.join(IDE_MAP.keys())}")
        return 1

    # 在做任何检查/注入前，先从模板同步最新版本号，避免日志中显示过时版本
    _read_template_version()

    already_has = has_nucleus(target_path)
    current_ver = get_nucleus_version(target_path)
    template_hash = compute_template_hash()
    ide_desc = IDE_MAP[ide_key]["desc"]

    safe_print(f"IDE : {ide_desc}")
    safe_print(f"Target: {target_path}")
    safe_print(f"Template: {TEMPLATE_PATH} (SHA256: {template_hash})")

    hint_cmd = f" --ide {ide_key}" if args.ide else ""

    # ⚠ --check 必须早于下面的 already_has 早退，否则永远走不到份数校验
    if args.check:
        if not already_has:
            safe_print(f"[WARN] Injection needed: {target_path.name} lacks cold-start gate nucleus")
            safe_print(f"       Run 'python setup-gate.py{hint_cmd}' to inject.")
            return 1
        blocks = count_nucleus_blocks(target_path.read_text(encoding="utf-8"))
        if blocks > 1:
            safe_print(f"[WARN] Multiple nucleus blocks detected: {blocks} (expected 1)")
            safe_print(f"       Caused by the pre-v1.4 --force bug. Keep one copy manually, or run")
            safe_print(f"       'python setup-gate.py{hint_cmd} --force' (v1.4+ removes all).")
            return 1
        safe_print(f"[OK] Check passed: nucleus present ({current_ver}, 1 block)")
        return 0

    if already_has and not args.force:
        safe_print(f"[OK] Nucleus already injected ({current_ver}), no action needed.")
        safe_print(f"     Use --force to re-inject.")
        return 0

    if args.force and already_has:
        safe_print(f"[FORCE] Re-injecting ({current_ver} -> {NUCLEUS_VERSION})...")
        success = force_inject(target_path, ide_dir)
    else:
        safe_print(f"[INJECT] Writing cold-start gate nucleus ({NUCLEUS_VERSION})...")
        success = inject_nucleus(target_path, ide_dir)

    if success:
        safe_print(f"[OK] Injection successful! {target_path.name} now contains cold-start gate nucleus.")
        safe_print(f"     Version: {NUCLEUS_VERSION}  Hash: {template_hash}")
        if has_nucleus(target_path):
            safe_print(f"     Verify: nucleus confirmed in {target_path.name}")
        else:
            safe_print(f"     [WARN] Post-injection verification failed, check {target_path.name}")
            return 2
        return 0
    else:
        safe_print(f"[FAIL] Injection failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
