#!/usr/bin/env python3
"""inspect-context.py —— M4 证据探测（只读；不改项目、不写业务区）

用途：为 build-stage-prompt.py 提供「这个项目具备什么证据」的确定性快照。
      M4 的依据：规则该不该注入由**证据**决定，不由人猜。

输出（stdout JSON，键序固定 ⇒ 同项目连跑两次逐字一致）：
  ok / project_root / git / instructions / manifests
  / path_parts{声明项: bool} / extensions{".cs": N} / dependencies[] / scan{files,truncated}

设计约束（勿擅自放宽）：
  · 单次 os.walk 完成全部采集，剪枝 + 文件数上限，避免大仓拖死会话
  · 忽略 .git/node_modules/dist/obj/bin/__pycache__/runtime 等；不忽略 .codebuddy（path_parts 要用）
  · fail-open：异常也输出 JSON 并 exit 0，由调用方决定降级
用法：python inspect-context.py [项目根] [--path-parts a,b] [--exts .cs,.vue] [--max-files N]
"""
import argparse
import fnmatch
import json
import os
import subprocess
import sys
from pathlib import Path

IGNORED_DIRS = {
    ".git", "node_modules", "dist", "build", "obj", "bin", "__pycache__",
    ".venv", "venv", "runtime", "vendor", "target", ".next", "coverage",
}
MANIFEST_NAMES = (
    "package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml",
    "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "Makefile",
)
MANIFEST_GLOBS = ("*.sln", "*.csproj", "*.vbproj")
INSTRUCTION_NAMES = ("AGENTS.md", "CLAUDE.md", ".cursorrules", "CODEBUDDY.md", ".github/copilot-instructions.md")
MAX_DEPTH = 6


def git_info(root: Path) -> dict:
    try:
        r = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                           text=True, capture_output=True, check=False, timeout=10)
    except Exception:
        return {"is_repository": False, "root": None}
    if r.returncode != 0:
        return {"is_repository": False, "root": None}
    detected = Path(r.stdout.strip())
    try:
        same = detected.resolve() == root.resolve()
    except Exception:
        same = False
    return {"is_repository": True, "root": str(detected), "current_directory_is_root": same}


def walk_project(root: Path, exts: set, max_files: int):
    dirs, ext_counts, manifests = set(), {}, set()
    files_seen, truncated = 0, False
    for current, subdirs, filenames in os.walk(root):
        cp = Path(current)
        try:
            rel = cp.relative_to(root)
        except ValueError:
            continue
        depth = len(rel.parts)
        subdirs[:] = sorted(d for d in subdirs if d not in IGNORED_DIRS and depth < MAX_DEPTH)
        if rel.parts:
            dirs.add(rel.as_posix())
        for name in sorted(filenames):
            files_seen += 1
            if files_seen > max_files:
                truncated = True
                break
            suffix = os.path.splitext(name)[1].lower()
            if not exts or suffix in exts:
                ext_counts[suffix] = ext_counts.get(suffix, 0) + 1
            if name in MANIFEST_NAMES or any(fnmatch.fnmatch(name, g) for g in MANIFEST_GLOBS):
                manifests.add((rel / name).as_posix() if rel.parts else name)
        if truncated:
            break
    return dirs, ext_counts, sorted(manifests), files_seen, truncated


def path_part_hit(dirs: set, part: str) -> bool:
    part = part.strip("/").replace("\\", "/")
    if not part:
        return False
    for d in dirs:
        if d == part or d.startswith(part + "/") or part in d.split("/"):
            return True
    return False


def read_dependencies(root: Path, manifests) -> list:
    deps = set()
    for rel in manifests:
        name = os.path.basename(rel).lower()
        path = root / rel
        try:
            if name == "package.json":
                data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
                for key in ("dependencies", "devDependencies", "peerDependencies"):
                    sec = data.get(key) or {}
                    if isinstance(sec, dict):
                        deps.update(str(k).lower() for k in sec)
            elif name == "requirements.txt":
                for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#"):
                        deps.add(line.split("==")[0].split(">=")[0].split("[")[0].strip().lower())
            elif name.endswith((".csproj", ".vbproj")):
                text = path.read_text(encoding="utf-8", errors="ignore")
                for chunk in text.split('PackageReference'):
                    if 'Include="' in chunk:
                        deps.add(chunk.split('Include="', 1)[1].split('"', 1)[0].lower())
            elif name == "pom.xml":
                text = path.read_text(encoding="utf-8", errors="ignore")
                for chunk in text.split("<artifactId>"):
                    if "</artifactId>" in chunk:
                        deps.add(chunk.split("</artifactId>", 1)[0].strip().lower())
        except Exception:
            continue
    return sorted(d for d in deps if d)


def inspect_project(root: Path, path_parts, exts, max_files: int = 20000) -> dict:
    dirs, ext_counts, manifests, files_seen, truncated = walk_project(root, set(exts or ()), max_files)
    return {
        "ok": True,
        "project_root": str(root),
        "git": git_info(root),
        "instructions": [n for n in INSTRUCTION_NAMES if (root / n).is_file()],
        "manifests": manifests,
        "path_parts": {p: path_part_hit(dirs, p) for p in sorted(path_parts or [])},
        "extensions": {k: ext_counts[k] for k in sorted(ext_counts)},
        "dependencies": read_dependencies(root, manifests),
        "scan": {"files": files_seen, "truncated": truncated, "max_depth": MAX_DEPTH},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="M4 证据探测（只读）")
    ap.add_argument("project_root", nargs="?", default=".", type=Path)
    ap.add_argument("--path-parts", default="")
    ap.add_argument("--exts", default="")
    ap.add_argument("--max-files", type=int, default=20000)
    args = ap.parse_args()
    root = args.project_root.resolve()
    if not root.is_dir():
        print(json.dumps({"ok": False, "error": "project_root not a directory", "project_root": str(root)}, ensure_ascii=False, indent=2))
        return 0
    parts = [p.strip() for p in args.path_parts.split(",") if p.strip()]
    exts = [e.strip() if e.strip().startswith(".") else "." + e.strip() for e in args.exts.split(",") if e.strip()]
    try:
        out = inspect_project(root, parts, exts, args.max_files)
    except Exception as exc:  # fail-open
        out = {"ok": False, "error": str(exc), "project_root": str(root)}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
