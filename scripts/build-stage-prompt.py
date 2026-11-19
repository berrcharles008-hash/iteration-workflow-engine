#!/usr/bin/env python3
"""build-stage-prompt.py —— M4 阶段注入清单（确定性；只读，不写任何文件）

输入：engine/rules/manifest.json（唯一事实源）+ 项目证据（inspect-context.py）
输出：本阶段该注入哪些 engine 规则 md，以及"为什么命中"。
      未命中的规则**不注入**——这是 M4 对 SKILL.md 人工分级路由的核心替换。

确定性（验收硬指标）：同项目 + 同 stage + 同 request 连跑两次，输出逐字一致。
  ⇒ 一切集合输出前排序；命中理由按固定序遍历；不读 mtime、不用随机、不依赖 dict 插入序。

用法：
  python build-stage-prompt.py --stage 04 --root <项目根> [--request "本次需求原文"] [--state <state.yaml>] [--json]
  python build-stage-prompt.py --stage 04 --root . --json > runtime/temp/inject.json
退出码恒 0（fail-open：脚本不可用时调用方回退 SKILL.md 分级路由）。
"""
import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent / "engine"
MANIFEST = ENGINE / "rules" / "manifest.json"


def load_inspector():
    path = HERE / "inspect-context.py"
    spec = importlib.util.spec_from_file_location("inspect_context", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("inspect-context.py 不可加载")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def norm_stage(raw: str) -> str:
    s = str(raw or "").strip().lower().replace("phase-", "").replace("phase", "")
    if not s:
        return ""
    if not s.isdigit():
        return s
    return s.zfill(2)


def read_state_flags(path):
    flags = set()
    if not path:
        return flags
    try:
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return flags
    for m in re.finditer(r"^\s{0,2}([a-z_]+):\s*(true|yes|1)\s*$", text, re.M | re.I):
        flags.add(m.group(1).lower())
    return flags


def eval_profile(p: dict, stage: str, ctx: dict, request: str, flags: set):
    """返回 (命中bool, [理由...])；理由顺序固定，保证确定性。"""
    reasons = []
    s = p.get("signals") or {}
    if not s:
        return True, ["stage-only"]

    def any_hit(items, pool, label, fmt):
        hit = [i for i in items if str(i).lower() in pool]
        for i in sorted(hit):
            reasons.append(fmt.format(i))
        return bool(hit)

    # 1. filenames（精确名或 *.ext 通配）
    names = [n.lower() for n in s.get("filenames", [])]
    if names:
        proj = [m.lower() for m in ctx.get("manifests", [])]
        matched = []
        for n in sorted(names):
            if n.startswith("*."):
                if any(m.endswith(n[1:]) for m in proj):
                    matched.append(n)
            elif any(m == n or m.endswith("/" + n) for m in proj):
                matched.append(n)
        for m in matched:
            reasons.append("filenames:" + m)

    # 2. package_dependencies
    if s.get("package_dependencies"):
        dep_pool = set(ctx.get("dependencies", []))
        any_hit(s["package_dependencies"], dep_pool, "deps", "deps:{}")

    # 3. evidence_extensions
    ext_pool = ctx.get("extensions", {})
    for e in sorted(s.get("evidence_extensions", [])):
        e = e if e.startswith(".") else "." + e
        if ext_pool.get(e, 0) > 0:
            reasons.append("exts:%s=%d" % (e, ext_pool[e]))

    # 4. path_parts
    if s.get("path_parts"):
        pp = ctx.get("path_parts", {})
        for part in sorted(s["path_parts"]):
            if pp.get(part):
                reasons.append("path_parts:" + part)

    # 5. terms（仅请求文本）
    if s.get("terms") and request:
        low = request.lower()
        for t in sorted(s["terms"], key=lambda x: str(x).lower()):
            if str(t).lower() in low:
                reasons.append("terms:" + str(t))

    # 6. state_flag
    if s.get("state_flag") and str(s["state_flag"]).lower() in flags:
        reasons.append("state_flag:" + str(s["state_flag"]))

    return bool(reasons), reasons


def collect_signals(manifest: dict) -> tuple:
    parts, exts = set(), set()
    for p in manifest.get("profiles", []):
        s = p.get("signals") or {}
        parts.update(s.get("path_parts", []))
        exts.update(s.get("evidence_extensions", []))
    return sorted(parts), sorted(exts)


def main() -> int:
    ap = argparse.ArgumentParser(description="M4 阶段注入清单（只读）")
    ap.add_argument("--stage", required=True)
    ap.add_argument("--root", default=".", type=Path)
    ap.add_argument("--request", default="")
    ap.add_argument("--state", default="")
    ap.add_argument("--json", action="store_true", dest="as_json")
    ap.add_argument("--max-files", type=int, default=20000)
    args = ap.parse_args()

    stage = norm_stage(args.stage)
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "manifest 不可读: %s" % exc}, ensure_ascii=False))
        return 0

    stage_rules = manifest.get("stage_rules", {}).get(stage)
    if stage_rules is None:
        print(json.dumps({"ok": False, "error": "未知 stage: %s" % stage,
                          "known": sorted(manifest.get("stage_rules", {}))}, ensure_ascii=False))
        return 0

    root = args.root.resolve()
    parts, exts = collect_signals(manifest)
    try:
        ctx = load_inspector().inspect_project(root, parts, exts, args.max_files)
    except Exception as exc:  # fail-open：回退 SKILL.md 路由
        print(json.dumps({"ok": False, "error": "inspect 失败: %s" % exc}, ensure_ascii=False))
        return 0

    flags = read_state_flags(args.state)
    br = manifest.get("base_rules") or {}
    if isinstance(br, dict):
        excluded = [str(x).zfill(2) for x in br.get("exclude_stages", [])]
        base_files = [] if stage in excluded else br.get("files", [])
    else:
        base_files = br
    base = [{"file": "engine/" + f, "why": ["base"]} for f in base_files]
    always, hit, miss = [], [], []
    for f in stage_rules.get("primary", []) + stage_rules.get("always", []):
        always.append({"file": "engine/" + f, "why": ["stage"]})
    for p in manifest.get("profiles", []):
        if stage not in [str(x).zfill(2) for x in p.get("stages", [])]:
            continue
        files = p.get("files") or [p.get("file")]
        ok, reasons = eval_profile(p, stage, ctx, args.request, flags)
        target = hit if ok else miss
        for f in files:
            if not f:
                continue
            target.append({"file": "engine/" + f, "id": p.get("id"), "title": p.get("title"), "why": reasons})

    inject = base + always + hit
    if args.as_json:
        out = {
            "ok": True,
            "stage": stage,
            "project_root": str(root),
            "inject": inject,
            "base": base,
            "skipped": miss,
            "evidence": {"manifests": len(ctx.get("manifests", [])),
                         "dependencies": len(ctx.get("dependencies", [])),
                         "scanned_files": ctx.get("scan", {}).get("files", 0),
                         "truncated": ctx.get("scan", {}).get("truncated", False)},
            "fallback": "SKILL.md 分级路由（脚本不可用或结果异常时）",
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    lines = ["# 阶段 %s 注入清单" % stage, ""]
    lines.append("## 基础规则·全阶段（%d）" % len(base))
    for it in base:
        lines.append("- %s" % it["file"])
    lines.append("")
    lines.append("## 阶段必读（%d）" % len(always))
    for it in always:
        lines.append("- %s" % it["file"])
    lines.append("")
    lines.append("## 命中规则（%d）" % len(hit))
    for it in hit:
        lines.append("- %s  ← %s" % (it["file"], ", ".join(it["why"])))
    if not hit:
        lines.append("- （无）")
    lines.append("")
    lines.append("## 未命中·不注入（%d）" % len(miss))
    for it in miss:
        lines.append("- %s" % it["file"])
    lines.append("")
    lines.append("> 降级路径：脚本不可用时按 SKILL.md 分级路由读取；本清单不替代阶段主文件。")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
