#!/usr/bin/env python3
"""setup-gate.py — 冷启动门禁微核注入脚本

将 cold-start-gate-nucleus 注入到项目 .codebuddy/memory/MEMORY.md，
为 CodeBuddy IDE 提供冷启动门禁保护。

环境感知：
  - CodeBuddy IDE（.codebuddy/memory/ 目录存在）→ 执行注入
  - Claude Code CLI（无 .codebuddy/memory/）→ 跳过，输出提示

用法：
  python setup-gate.py              # 检测并注入（幂等）
  python setup-gate.py --check      # 仅检测，不写入
  python setup-gate.py --force      # 强制重新注入（覆盖旧版本）
"""

import os
import sys
import hashlib
from pathlib import Path


# ─── 配置 ───────────────────────────────────────────────

NUCLEUS_TEMPLATE = "cold-start-gate-nucleus.md"
NUCLEUS_MARKER_PREFIX = "cold-start-gate-nucleus"   # 版本无关：只匹配前缀
NUCLEUS_VERSION = "v1.0"                              # 默认值；启动时由模板动态覆盖
GATE_MARKER = "当 gate-protocol.md 门禁规则更新时"

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

def detect_environment():
    """检测当前 IDE 环境，返回 (is_codebuddy, memory_dir_path)
    
    从脚本位置向上查找项目根目录（包含 .codebuddy/ 的目录），
    而非依赖 cwd（脚本可能从任意位置运行）。
    """
    # Walk up from script dir to find project root (dir containing .codebuddy/)
    candidate = SCRIPT_DIR
    for _ in range(5):
        if (candidate / ".codebuddy").is_dir():
            memory_dir = candidate / ".codebuddy" / "memory"
            return True, memory_dir
        candidate = candidate.parent
    # Fallback: try cwd
    cwd = Path.cwd()
    memory_dir = cwd / ".codebuddy" / "memory"
    return memory_dir.is_dir(), memory_dir


# ─── 检查 ───────────────────────────────────────────────

def has_nucleus(memory_md_path: Path) -> bool:
    """检查 MEMORY.md 是否已包含微核段（按前缀匹配，版本无关）"""
    if not memory_md_path.exists():
        return False
    content = memory_md_path.read_text(encoding="utf-8")
    return NUCLEUS_MARKER_PREFIX in content


def get_nucleus_version(memory_md_path: Path) -> str:
    """Get version of injected nucleus, or None if not present"""
    if not memory_md_path.exists():
        return None
    content = memory_md_path.read_text(encoding="utf-8")
    for line in content.split("\n"):
        if "cold-start-gate-nucleus" in line:
            parts = line.strip().split()
            for p in parts:
                if p.startswith("v"):
                    return p.rstrip(" -->")
    return None


def compute_template_hash() -> str:
    """计算模板文件的 SHA256"""
    if not TEMPLATE_PATH.exists():
        return "TEMPLATE_NOT_FOUND"
    content = TEMPLATE_PATH.read_bytes()
    return hashlib.sha256(content).hexdigest()[:16]


# ─── 注入 ───────────────────────────────────────────────

def inject_nucleus(memory_md_path: Path) -> bool:
    """Inject nucleus template into MEMORY.md (preserve existing content)"""
    if not TEMPLATE_PATH.exists():
        safe_print(f"[FAIL] Template not found: {TEMPLATE_PATH}")
        return False

    nucleus_content = TEMPLATE_PATH.read_text(encoding="utf-8")

    if memory_md_path.exists():
        existing = memory_md_path.read_text(encoding="utf-8")
        # 如果已有内容，追加到末尾（用分隔线隔开）
        new_content = nucleus_content + "\n\n---\n\n" + existing
    else:
        memory_md_path.parent.mkdir(parents=True, exist_ok=True)
        new_content = nucleus_content

    memory_md_path.write_text(new_content, encoding="utf-8")
    return True


def force_inject(memory_md_path: Path) -> bool:
    """Force re-injection (remove old nucleus, write fresh)"""
    if not TEMPLATE_PATH.exists():
        safe_print(f"[FAIL] Template not found: {TEMPLATE_PATH}")
        return False

    nucleus_content = TEMPLATE_PATH.read_text(encoding="utf-8")

    if memory_md_path.exists():
        existing = memory_md_path.read_text(encoding="utf-8")
        # Remove old nucleus block: from "cold-start-gate-nucleus" marker
        # through the gate-protocol reminder comment line (inclusive).
        # Handles both single-line and multi-line comment formats.
        lines = existing.split("\n")
        new_lines = []
        in_old_nucleus = False
        nucleus_start_found = False
        for line in lines:
            if "cold-start-gate-nucleus" in line and not nucleus_start_found:
                in_old_nucleus = True
                nucleus_start_found = True
                continue
            if in_old_nucleus and GATE_MARKER in line:
                in_old_nucleus = False
                continue
            if in_old_nucleus:
                continue
            new_lines.append(line)
        # Remove trailing blank lines/separtors left by removal
        clean = "\n".join(new_lines).strip()
        new_content = nucleus_content + "\n\n" + clean if clean else nucleus_content
    else:
        memory_md_path.parent.mkdir(parents=True, exist_ok=True)
        new_content = nucleus_content

    memory_md_path.write_text(new_content, encoding="utf-8")
    return True


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
    parser = argparse.ArgumentParser(description="Inject cold-start gate nucleus into MEMORY.md")
    parser.add_argument("--check", action="store_true", help="Check only, no write")
    parser.add_argument("--force", action="store_true", help="Force re-injection")
    args = parser.parse_args()

    is_codebuddy, memory_dir = detect_environment()

    if not is_codebuddy:
        safe_print("[INFO] Non-CodeBuddy IDE environment (.codebuddy/memory/ not found)")
        safe_print("       Gate protection provided by Claude Code CLI PreToolUse Hook.")
        safe_print("       Nucleus injection not needed. Skipping.")
        return 0

    # 在做任何检查/注入前，先从模板同步最新版本号，避免日志中显示过时版本
    _read_template_version()

    memory_md_path = memory_dir / "MEMORY.md"
    already_has = has_nucleus(memory_md_path)
    current_ver = get_nucleus_version(memory_md_path)

    template_hash = compute_template_hash()

    safe_print(f"Env : CodeBuddy IDE")
    safe_print(f"Target: {memory_md_path}")
    safe_print(f"Template: {TEMPLATE_PATH} (SHA256: {template_hash})")

    if already_has and not args.force:
        safe_print(f"[OK] Nucleus already injected ({current_ver}), no action needed.")
        safe_print(f"     Use --force to re-inject.")
        return 0

    if args.check:
        if already_has:
            safe_print(f"[OK] Check passed: nucleus present ({current_ver})")
        else:
            safe_print(f"[WARN] Injection needed: MEMORY.md lacks cold-start gate nucleus")
            safe_print(f"       Run 'python setup-gate.py' to inject.")
        return 0 if already_has else 1

    if args.force and already_has:
        safe_print(f"[FORCE] Re-injecting ({current_ver} -> {NUCLEUS_VERSION})...")
        success = force_inject(memory_md_path)
    else:
        safe_print(f"[INJECT] Writing cold-start gate nucleus ({NUCLEUS_VERSION})...")
        success = inject_nucleus(memory_md_path)

    if success:
        safe_print(f"[OK] Injection successful! MEMORY.md now contains cold-start gate nucleus.")
        safe_print(f"     Version: {NUCLEUS_VERSION}  Hash: {template_hash}")
        if has_nucleus(memory_md_path):
            safe_print(f"     Verify: nucleus confirmed in MEMORY.md")
        else:
            safe_print(f"     [WARN] Post-injection verification failed, check MEMORY.md")
            return 2
        return 0
    else:
        safe_print(f"[FAIL] Injection failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
