#!/usr/bin/env python3
"""gen-knowledge-base.py - L1/L2/L3 knowledge base auto-generator.

Scans existing project code directories into three knowledge layers:
  L1: Project module overview (module table + file matrix)
  L2: Module-level Wiki (file list + symbol index + business placeholder)
  L3: Glossary (code naming reverse-lookup)

Output directory: docs/knowledge-base/ (separated from frozen requirements/)

Usage:
  python gen-knowledge-base.py                    # Generate all (L1->L2->L3)
  python gen-knowledge-base.py --level L1         # Generate L1 only
  python gen-knowledge-base.py --level L2         # Generate L2 only
  python gen-knowledge-base.py --level L3         # Generate L3 only
  python gen-knowledge-base.py --check            # Check status (missing/stale), no write
  python gen-knowledge-base.py --force            # Refresh stale auto-generated files
  python gen-knowledge-base.py --module M1        # Restrict L2 to specific module

--check output meaning:
  Missing: target module/file does not exist
  Stale:   exists but content differs from current code (added/removed files,
           new classes) -> refresh with --force

Content fingerprint (★ 2026-09-20):
  The Stale checks above compare *sets* only (module names / file paths /
  class names) -- changes inside existing files are invisible to them.
  A per-file (mtime_ns, size) fingerprint of the scanned .vue/.js/.cs files
  (same directories as the L2 scan; page companion .ts/.less are NOT covered)
  is cached in runtime/kb-fingerprint.json and reported by --check.
  It is a filesystem fingerprint, not a content hash: touch/rebuild gives a
  false positive; same-nanosecond rewrite of identical length a false negative.
  Baseline is rebuilt only by a FULL run (--level all, no --module) that
  actually wrote KB files -- partial refreshes keep the previous baseline.

Coverage rules (decision F):
  auto-generated: true  -> refreshable via --force
  auto-generated: false -> manually edited, NEVER overwritten
"""

import os
import re
import sys
import json
import argparse
import datetime
from pathlib import Path

# --- Path constants ---

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
TEMPLATE_DIR = SKILL_DIR / "engine" / "templates"


def find_manifest_root():
    """Find the directory containing project/project.manifest.yaml (the skill dir)."""
    candidate = SKILL_DIR
    for _ in range(5):
        manifest = candidate / "project" / "project.manifest.yaml"
        if manifest.exists():
            return candidate
        candidate = candidate.parent
    return None


# Directory containing the manifest (skill dir), used to locate the manifest.
MANIFEST_ROOT = find_manifest_root()

# Actual project workspace root; resolved by load_manifest() from
# manifest's project.workspace_root field.
PROJECT_ROOT = None


# --- Minimal YAML field extractor (no PyYAML dependency) ---


def _extract_yaml_block(content, key):
    """Extract a top-level block. Tolerates inline comments after 'key:'."""
    pattern = re.compile(
        r'^' + re.escape(key) + r':[ \t]*(?:#[^\n]*)?\n((?:(?:[ \t]+.*)?\n)*)',
        re.MULTILINE
    )
    m = pattern.search(content)
    if m:
        return m.group(1)
    return ''


def _extract_yaml_value(content_or_block, key):
    """Extract 'key: value', handling quotes and inline comments."""
    pattern = re.compile(
        r'^[ \t]*' + re.escape(key) + r':[ \t]*(.+?)[ \t]*$',
        re.MULTILINE
    )
    m = pattern.search(content_or_block)
    if not m:
        return None
    val = m.group(1).strip()
    # Quoted value: take quoted content as-is
    qm = re.match(r'^(["\'])(.*?)\1', val)
    if qm:
        return qm.group(2)
    # Unquoted value with inline comment: strip after '#'
    if '#' in val:
        val = val.split('#')[0].strip()
    return val if val else None


def _extract_subblock(parent_block, key):
    """Extract a nested block. Tolerates inline comments after 'key:'."""
    pattern = re.compile(
        r'^[ \t]*' + re.escape(key) + r':[ \t]*(?:#[^\n]*)?\n((?:(?:[ \t]+.*)?\n)*)',
        re.MULTILINE
    )
    m = pattern.search(parent_block)
    if m:
        return m.group(1)
    return ''



def _yaml_scalar(raw):
    """Strip quotes / inline comments from one scalar YAML value. Never raises."""
    if raw is None:
        return ""
    val = str(raw).strip()
    qm = re.match(r'^(["\'])(.*?)\1', val)
    if qm:
        return qm.group(2).strip()
    if '#' in val:
        val = val.split('#')[0].strip()
    return val


def _yaml_inline_list(raw):
    """Parse ``["a", "b"]`` / ``[a, b]`` into ['a', 'b']; invalid -> []."""
    if raw is None:
        return []
    m = re.match(r'^\[(.*)\]$', str(raw).strip(), re.DOTALL)
    if not m:
        return []
    items = []
    for part in m.group(1).split(','):
        s = _yaml_scalar(part)
        if s:
            items.append(s)
    return items


def _slice_list_block(block, key):
    """Slice the YAML *list* sub-block of ``key`` out of a parent block.

    ``_extract_subblock`` only understands mapping children; a list value
    (``frontend_projects:`` followed by ``- key: ...`` items) is swallowed or
    missed. This helper returns the raw lines whose indent is deeper than the
    key line. Absent key -> returns the block unchanged (caller may already
    pass the isolated sub-block).
    """
    lines = (block or "").split("\n")
    out = []
    inside = False
    base = 0
    found = False
    for ln in lines:
        if not inside:
            mt = re.match(r'^([ \t]*)' + re.escape(key) + r'[ \t]*:[ \t]*$', ln)
            if mt:
                base = len(mt.group(1))
                inside = True
                found = True
            continue
        if not ln.strip():
            out.append(ln)
            continue
        ind = len(ln) - len(ln.lstrip())
        if ind <= base:
            break
        out.append(ln)
    if not found:
        return block or ""
    return "\n".join(out)


def _parse_frontend_projects(block):
    """Parse ``paths.frontend_projects`` list by line scanning (no PyYAML).

    Expected shape (as measured in project.manifest.yaml)::

        frontend_projects:
          - key: "ecic_critical_illness_center"
            src: "front-end/ecic_critical_illness_center/src"
            center: ""

    Returns [{"key": str, "src": str, "center": str}] with ``src`` still the
    raw relative string (load_manifest resolves it to a Path). Any parse
    failure degrades to [] -- never raises.
    """
    block = _slice_list_block(block, "frontend_projects")
    items = []
    cur = None
    for line in (block or "").split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if re.match(r'^[ \t]*-[ \t]*$', line):
            cur = {}
            items.append(cur)
            continue
        m_item = re.match(r'^[ \t]*-[ \t]+([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$', line)
        if m_item:
            cur = {}
            items.append(cur)
            cur[m_item.group(1)] = _yaml_scalar(m_item.group(2))
            continue
        m_kv = re.match(r'^[ \t]+([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$', line)
        if m_kv and cur is not None:
            cur[m_kv.group(1)] = _yaml_scalar(m_kv.group(2))

    projects = []
    for it in items:
        src = (it.get("src") or "").strip()
        if not src:
            continue
        key = (it.get("key") or "").strip() or Path(src).name
        projects.append({
            "key": key,
            "src": src,
            "center": (it.get("center") or "").strip(),
        })
    return projects


def _parse_centers(block):
    """Parse the root-level ``centers`` section.

    Returns {"order": [...], "aliases": {...}, "tokens": {...}} or None when
    the section is absent (caller then degrades to a single partition).
    Line scanning only: order failure -> [], aliases/tokens failure -> {}.
    NOTE: _extract_subblock('aliases') also swallows the following
    ``tokens:`` sub-tree (same indent level), so container keys and
    ``[...]`` values are filtered out on purpose.
    """
    if not (block or "").strip():
        return None

    order = _yaml_inline_list(_extract_yaml_value(block, "order"))

    aliases = {}
    for line in _extract_subblock(block, "aliases").split("\n"):
        m = re.match(r'^[ \t]+([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$', line)
        if not m:
            continue
        key, raw = m.group(1), m.group(2).strip()
        if key in ("order", "aliases", "tokens") or raw.startswith("["):
            continue
        val = _yaml_scalar(raw)
        if val:
            aliases[key] = val

    tokens = {}
    for line in _extract_subblock(block, "tokens").split("\n"):
        m = re.match(r'^[ \t]+([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$', line)
        if not m:
            continue
        key = m.group(1)
        if key in ("order", "aliases", "tokens"):
            continue
        tokens[key] = [t for t in _yaml_inline_list(m.group(2)) if t]

    if not order:
        order = list(tokens.keys())
    for k in tokens.keys():
        if k not in order:
            order.append(k)

    if not order and not aliases and not tokens:
        return None
    return {"order": order, "aliases": aliases, "tokens": tokens}


def load_manifest():
    global PROJECT_ROOT

    if MANIFEST_ROOT is None:
        safe_print("[FAIL] project.manifest.yaml not found")
        sys.exit(1)

    manifest_path = MANIFEST_ROOT / "project" / "project.manifest.yaml"
    if not manifest_path.exists():
        safe_print(f"[FAIL] {manifest_path} not found")
        sys.exit(1)

    raw = manifest_path.read_text(encoding="utf-8")

    project_block = _extract_yaml_block(raw, "project")
    workspace_root = _extract_yaml_value(project_block, "workspace_root")

    paths_block = _extract_yaml_block(raw, "paths")
    frontend_root = _extract_yaml_value(paths_block, "frontend_root")
    backend_root = _extract_yaml_value(paths_block, "backend_root")
    specs_dir = _extract_yaml_value(paths_block, "specs_dir")
    kb_dir = _extract_yaml_value(paths_block, "kb_dir") or "docs/knowledge-base"

    # T1-2: multi-frontend scan surface + center partitions (both optional).
    # NOTE: pass the whole ``paths`` block -- ``frontend_projects`` is a YAML
    # *list* and _extract_subblock only understands mapping children.
    fe_projects_raw = _parse_frontend_projects(paths_block)
    centers_raw = _parse_centers(_extract_yaml_block(raw, "centers"))

    fe_block = _extract_yaml_block(raw, "frontend_layers")
    fe_page_sub = _extract_subblock(fe_block, "page")
    fe_page_dir = _extract_yaml_value(fe_page_sub, "dir")
    fe_page_pattern = _extract_yaml_value(fe_page_sub, "file_pattern")
    fe_page_module_map = _extract_yaml_value(fe_page_sub, "module_map")
    fe_bll_sub = _extract_subblock(fe_block, "bll")
    fe_bll_dir = _extract_yaml_value(fe_bll_sub, "dir")

    be_block = _extract_yaml_block(raw, "backend_layers")
    be_entity_sub = _extract_subblock(be_block, "entity")
    be_entity_dir = _extract_yaml_value(be_entity_sub, "dir")
    be_interface_sub = _extract_subblock(be_block, "interface")
    be_interface_dir = _extract_yaml_value(be_interface_sub, "dir")
    be_bll_sub = _extract_subblock(be_block, "bll")
    be_bll_dir = _extract_yaml_value(be_bll_sub, "dir")
    be_webapi_sub = _extract_subblock(be_block, "webapi")
    be_webapi_dir = _extract_yaml_value(be_webapi_sub, "dir")

    ws = Path(workspace_root) if workspace_root else MANIFEST_ROOT

    # Update global PROJECT_ROOT to the workspace root (not skill dir)
    # so that relative_to(PROJECT_ROOT) works for actual project files
    PROJECT_ROOT = ws

    def resolve(rel_path):
        if not rel_path:
            return None
        return ws / rel_path

    frontend_projects = []
    for item in fe_projects_raw:
        src_path = resolve(item["src"])
        if src_path is None:
            continue
        frontend_projects.append({
            "key": item["key"],
            "src": src_path,
            "center": item["center"],
        })

    return {
        "workspace_root": ws,
        "frontend_root": resolve(frontend_root),
        "backend_root": resolve(backend_root),
        "specs_dir": resolve(specs_dir),
        "kb_dir": resolve(kb_dir),
        "fe_page_dir": resolve(fe_page_dir) if fe_page_dir else None,
        "fe_page_pattern": fe_page_pattern,
        "fe_module_map": _parse_module_map(fe_page_module_map),
        "fe_bll_dir": resolve(fe_bll_dir) if fe_bll_dir else None,
        "be_entity_dir": resolve(be_entity_dir) if be_entity_dir else None,
        "be_interface_dir": resolve(be_interface_dir) if be_interface_dir else None,
        "be_bll_dir": resolve(be_bll_dir) if be_bll_dir else None,
        "be_webapi_dir": resolve(be_webapi_dir) if be_webapi_dir else None,
        "frontend_projects": frontend_projects,
        "centers": centers_raw,
    }

def load_terms():
    """读取三段术语表；**永不抛**（缺文件 ⇒ 空表降级）。"""
    empty = ({}, {}, set())
    try:
        import project_config
    except Exception as e:                                     # pragma: no cover
        sys.stderr.write('[INFO] project_config 不可用 ⇒ 术语表降级为空：%s\n' % e)
        return empty
    path = project_config.SKILL_ROOT / 'project' / 'kb-terms.yaml'
    errors = []
    business = dict(project_config.read_pairs(path, 'business', errors))
    tech = dict(project_config.read_pairs(path, 'tech', errors))
    noise = set(project_config.read_bare(path, 'noise', errors))
    sys.stderr.write('[INFO] kb-terms: business=%d tech=%d noise=%d\n'
                     % (len(business), len(tech), len(noise)))
    if not business and not tech and not noise:
        sys.stderr.write('[WARN] kb-terms 三段皆空 ⇒ 全部类名将落「未映射」清单\n')
    return business, tech, noise


BUSINESS_TERMS, TECH_TERMS, TECH_NOISE = load_terms()


def pascalcase_split(name):
    """Split PascalCase into parts. E.g. PivasOrderMgr -> ['Pivas','Order','Mgr']"""
    parts = re.findall(r'[A-Z][a-z0-9]*|[A-Z]+(?=[A-Z]|$)', name)
    merged = []
    i = 0
    while i < len(parts):
        chunk = parts[i]
        while i + 1 < len(parts) and len(parts[i+1]) == 1 and parts[i+1].isupper():
            chunk += parts[i+1]
            i += 1
        merged.append(chunk)
        i += 1
    return merged


# --- Code scanners ---

def _is_build_artifact(file_path):
    """Check if file is under obj/ or bin/ or is AssemblyInfo.cs."""
    parts_lower = [p.lower() for p in file_path.parts]
    if "obj" in parts_lower or "bin" in parts_lower or "node_modules" in parts_lower:
        return True
    if file_path.name == "AssemblyInfo.cs":
        return True
    return False


def scan_cs_files(directory):
    """Scan .cs files: extract classes and methods.

    Skips build artifacts (obj/, bin/, AssemblyInfo.cs).
    """
    results = []
    if not directory or not directory.exists():
        return results
    for cs_file in sorted(directory.rglob("*.cs")):
        if _is_build_artifact(cs_file):
            continue
        try:
            content = cs_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        rel_path = str(cs_file.relative_to(PROJECT_ROOT)).replace("\\", "/")
        ns_match = re.search(r'namespace\s+([\w.]+)', content)
        namespace = ns_match.group(1) if ns_match else ""
        classes = []
        class_positions = []  # (position, name) for method ownership
        for m in re.finditer(
            r'(?:public|internal|abstract|sealed)?\s*(?:abstract\s+)?'
            r'(class|interface|struct)\s+(\w+)', content
        ):
            kind = m.group(1)
            cname = m.group(2)
            # Skip unnamed/utility class names (_ from Dos.ORM Field containers, etc.)
            if not re.match(r'^[A-Za-z]', cname):
                continue
            # Skip private nested implementation classes
            prefix = content[max(0, m.start() - 12):m.start()]
            if "private" in prefix:
                continue
            classes.append({
                "name": cname,
                "type": {"class": "Class", "interface": "Interface", "struct": "Struct"}[kind],
                "namespace": namespace
            })
            class_positions.append((m.start(), cname))
        methods = []
        class_positions.sort(key=lambda x: x[0])
        for m in re.finditer(
            r'public\s+(?:virtual\s+|override\s+|static\s+)?'
            r'(?:[\w<>\.\[\]]+)\s+(\w+)\s*\(([^)]*)\)', content
        ):
            mname = m.group(1)
            if any(mname == c["name"] for c in classes):
                continue
            if mname in ("get", "set", "Get", "Set"):
                continue
            # Owning class = nearest class declared before the method
            owning = None
            for pos, cname in class_positions:
                if pos < m.start():
                    owning = cname
                else:
                    break
            methods.append({
                "name": mname, "class": owning or "",
                "signature": m.group(2).strip()[:80]
            })
        results.append({
            "path": rel_path, "classes": classes,
            "methods": methods, "namespace": namespace
        })
    return results


def _fe_file_type(file_path, ext=None):
    """Map a frontend file to its KB ``type`` value (downstream filter-safe).

    .vue -> Page (M{n}Module) / Component ; .js -> JS ; .ts -> TS ; .less -> Less
    """
    suffix = (ext or file_path.suffix or "").lower()
    if suffix == ".vue":
        return "Page" if re.match(r'M\d+Module', file_path.stem) else "Component"
    if suffix == ".js":
        return "JS"
    if suffix == ".ts":
        return "TS"
    if suffix == ".less":
        return "Less"
    return suffix.lstrip(".").upper() or "File"


def scan_fe_files(projects, exts=(".vue", ".ts", ".less")):
    """Scan several frontend projects into one flat file list.

    Args:
      projects: [{"key": str, "src": Path|str, "center": str}] from manifest.
      exts:     extensions to collect (default excludes .js on purpose;
                scan_js_files passes (".js",) explicitly).

    Returns [{"path","name","type","project","center"}].
    ``path`` is always PROJECT_ROOT-relative with '/' separators (same rule as
    scan_vue_files), NOT relative to each project src -- L2/root_dirs and the
    fingerprint all key off that form.

    Skips build artifacts (_is_build_artifact) and ``*.d.ts`` by FILE NAME
    (a .d.ts file's suffix is still .ts, so an extension test cannot work).
    """
    results = []
    ext_list = tuple(e.lower() for e in (exts or ()) if e)
    if not ext_list:
        return results

    for proj in projects or []:
        if not isinstance(proj, dict):
            continue
        src = proj.get("src")
        if not src:
            continue
        try:
            src_path = Path(src)
        except Exception:
            continue
        if not src_path.exists() or not src_path.is_dir():
            continue
        key = proj.get("key") or src_path.name
        center = (proj.get("center") or "").strip()
        for ext in ext_list:
            for fe_file in sorted(src_path.rglob("*" + ext)):
                if not fe_file.is_file():
                    continue
                if fe_file.name.lower().endswith(".d.ts"):
                    continue
                if _is_build_artifact(fe_file):
                    continue
                try:
                    rel_path = str(fe_file.relative_to(PROJECT_ROOT)).replace("\\", "/")
                except Exception:
                    rel_path = str(fe_file).replace("\\", "/")
                results.append({
                    "path": rel_path,
                    "name": fe_file.stem,
                    "type": _fe_file_type(fe_file, ext),
                    "project": key,
                    "center": center,
                })
    return results


def scan_vue_files(directory):
    """Scan .vue files: extract component names. Skips node_modules/dist.

    Thin wrapper over scan_fe_files (single project = the given directory);
    the returned dict shape stays {"path","name","type"} -- extra keys are
    stripped so every pre-existing consumer sees the same objects as before.
    """
    results = []
    if not directory:
        return results
    src = Path(directory)
    if not src.exists():
        return results
    for item in scan_fe_files([{"key": src.name, "src": src, "center": ""}],
                              exts=(".vue",)):
        results.append({"path": item["path"], "name": item["name"], "type": item["type"]})
    return results


def scan_js_files(directory):
    """Scan .js files (frontend bll/store layer). Skips node_modules/dist.

    Thin wrapper over scan_fe_files; ``exts=(".js",)`` is mandatory -- the
    default ext set does not contain .js.
    """
    results = []
    if not directory:
        return results
    src = Path(directory)
    if not src.exists():
        return results
    for item in scan_fe_files([{"key": src.name, "src": src, "center": ""}],
                              exts=(".js",)):
        results.append({"path": item["path"], "name": item["name"], "type": "JS"})
    return results




def _backend_extra_dirs(config):
    """Backend scan dirs besides BLL: Inf root + Web.

    Inf root (parent of Inf/Entity) covers Entity/IMgr/Dtos/Queries/
    Util/Consts/Enums/Logging in one pass. Falls back to entity/interface
    dirs when the Inf root is missing.
    """
    dirs = []
    be_entity = config.get("be_entity_dir")
    if be_entity:
        inf_root = be_entity.parent  # .../Inf
        if inf_root.exists():
            dirs.append(inf_root)
    if not dirs:
        for key in ["be_entity_dir", "be_interface_dir"]:
            d = config.get(key)
            if d and d.exists():
                dirs.append(d)
    be_webapi = config.get("be_webapi_dir")
    if be_webapi and be_webapi.exists():
        dirs.append(be_webapi)
    return dirs


# --- Auto-generated flag check ---


def _norm_center_key(value):
    """Normalize a center key / token: lowercase, drop '_' and '-'."""
    if not value:
        return ""
    return re.sub(r'[_-]', '', str(value).strip().lower())


def _resolve_center_key(centers, key):
    """Alias / normalization -> canonical center key; unknown -> None."""
    if not centers or not key:
        return None
    key = str(key).strip()
    aliases = centers.get("aliases") or {}
    known = list(centers.get("order") or [])
    for k in (centers.get("tokens") or {}).keys():
        if k not in known:
            known.append(k)
    for k in aliases.keys():
        if k not in known:
            known.append(k)

    if key in aliases:
        return aliases[key] or key
    if key in known:
        return key
    nk = _norm_center_key(key)
    for cand in known:
        if _norm_center_key(cand) == nk:
            return aliases.get(cand, cand)
    for cand, tgt in aliases.items():
        if _norm_center_key(cand) == nk:
            return tgt
    return None


def _classify_center(rel_path, project, centers, classes=None):
    """Five-level center classification; first hit wins.

    Levels: project binding > path segments > file name > class names > "common".

    Args:
      rel_path: PROJECT_ROOT-relative path (either separator accepted).
      project:  dict with a "center" field, or a plain str binding, or None
                (backend files / unbound frontend files).
      centers:  config["centers"]. **None => returns "project" (degraded)**.
      classes:  class names, used only for backend ``.cs`` files (may be None).

    Returns:
      A canonical key from ``centers.order``; no hit => ``"common"``.
      Degraded mode returns the literal ``"project"`` -- that value is a
      LOGICAL label used for grouping and for the center column only; it is
      never joined into a filesystem path (no ``kb/project/`` ever appears).

    Matching: values are normalized (lowercase, '_' and '-' removed) and a
    token hits when it is a substring of a normalized dir segment / file name
    / stem / class name. Within one level, ``centers.order`` decides the
    winner (earlier key wins on token conflicts).
    """
    if not centers:
        return "project"

    # --- Level 1: explicit project binding ---
    binding = ""
    if isinstance(project, dict):
        binding = project.get("center") or ""
    elif isinstance(project, str):
        binding = project
    binding = str(binding).strip()
    if binding:
        return _resolve_center_key(centers, binding) or binding

    norm_path = str(rel_path or "").replace("\\", "/").strip().strip("/")
    if not norm_path:
        return "common"
    parts = [p for p in norm_path.split("/") if p]
    dir_parts = parts[:-1]
    file_name = parts[-1] if parts else ""
    stem = Path(file_name).stem if file_name else ""

    order = list(centers.get("order") or [])
    tokens_map = centers.get("tokens") or {}
    for key in tokens_map.keys():
        if key not in order:
            order.append(key)
    ordered = []
    for key in order:
        toks = [_norm_center_key(t) for t in (tokens_map.get(key) or []) if str(t).strip()]
        if toks:
            ordered.append((key, toks))

    norm_dirs = [_norm_center_key(p) for p in dir_parts]
    norm_file = _norm_center_key(file_name)
    norm_stem = _norm_center_key(stem)
    norm_classes = [_norm_center_key(c) for c in (classes or []) if c]

    def _hit(norm_value, norm_tokens):
        return any(t and t in norm_value for t in norm_tokens)

    # --- Level 2: directory segments ---
    for key, toks in ordered:
        if any(_hit(seg, toks) for seg in norm_dirs):
            return key

    # --- Level 3: file name / stem ---
    for key, toks in ordered:
        if _hit(norm_file, toks) or _hit(norm_stem, toks):
            return key

    # --- Level 4: class names (backend .cs only) ---
    if norm_classes and norm_path.lower().endswith(".cs"):
        for key, toks in ordered:
            if any(_hit(cn, toks) for cn in norm_classes):
                return key

    # --- Level 5: fallback ---
    return "common"


def scan_all_sources(config):
    """One scan pass -> one flat source list for the whole knowledge base.

    Frontend: ``scan_fe_files(config["frontend_projects"])`` -- all projects,
    all of .vue/.ts/.less (falls back to the legacy page/bll scan with the
    same item keys when the manifest declares no frontend_projects).
    Backend: the pre-existing surface -- scan_cs_files(be_bll_dir) plus every
    dir from _backend_extra_dirs(config).

    Every element carries ``center`` (from _classify_center) and ``kind``
    ("fe"/"be"). Frontend items keep {"path","name","type","project"};
    backend items keep {"path","classes","methods","namespace"}.
    ``center == "project"`` (degraded mode) is a logical label only.
    """
    centers = config.get("centers")
    sources = []

    # --- Frontend ---
    projects = config.get("frontend_projects") or []
    if projects:
        for item in scan_fe_files(projects):
            entry = dict(item)
            entry["center"] = _classify_center(entry["path"], entry.get("center"), centers)
            entry["kind"] = "fe"
            sources.append(entry)
    else:
        legacy = list(scan_vue_files(config.get("fe_page_dir")))
        legacy.extend(scan_js_files(config.get("fe_bll_dir")))
        for item in legacy:
            entry = dict(item)
            entry["project"] = ""
            entry["center"] = _classify_center(entry["path"], None, centers)
            entry["kind"] = "fe"
            sources.append(entry)

    # --- Backend: whole backend_root (100% coverage) ---
    # The legacy surface (BLL + Inf + Web/Api) misses 17 .cs files living in
    # Web/* and Console/*, which would cap AC-1 at 1306/1323.
    be_root = config.get("backend_root")
    if be_root and Path(be_root).exists():
        be_raw = list(scan_cs_files(Path(be_root)))
    else:
        be_raw = list(scan_cs_files(config.get("be_bll_dir")))
        for scan_dir in _backend_extra_dirs(config):
            be_raw.extend(scan_cs_files(scan_dir))
    seen = set()
    for fd in be_raw:
        if fd["path"] in seen:
            continue
        seen.add(fd["path"])
        entry = dict(fd)
        entry["center"] = _classify_center(
            entry["path"], None, centers,
            [c["name"] for c in (fd.get("classes") or [])])
        entry["kind"] = "be"
        sources.append(entry)

    return sources

def _is_auto_generated(file_path):
    """Check if a file's frontmatter has auto-generated: true."""
    if not file_path.exists():
        return False
    content = file_path.read_text(encoding="utf-8")
    m = re.search(r'auto-generated:\s*(true|false)', content)
    if m:
        return m.group(1).strip().lower() == "true"
    return False


# --- L1 generation ---

def _pick_main_vue(vue_files):
    """Pick the representative .vue file for one module group (generic rules).

    Priority (no project-specific names -- applicable to any Vue project):
      1. file stem equals its own parent dir name  (order_receive/order_receive.vue)
      2. stem free of auxiliary words              (render / component / snippet / cell)
      3. shortest stem, then lexicographic         (stable fallback, never fails)
    """
    def _rank(p):
        stem = p.stem.lower()
        same_as_dir = (stem == p.parent.name.lower())
        aux = any(w in stem for w in ("render", "component", "snippet", "cell"))
        return (0 if same_as_dir else 1, 1 if aux else 0, len(p.stem), p.stem)

    return sorted(vue_files, key=_rank)[0]


def _report_module_dir_coverage(config):
    """Advisory coverage check (check mode only): page dirs vs module_map.

    Generic and config-driven: runs only when a module_map is configured.
    Reports [WARN] for every top-level page dir missing from the map (the
    signal that a dir was added/renamed without updating the manifest) and
    for every map entry whose dir no longer exists. Never changes exit code.
    """
    fe_page_dir = config.get("fe_page_dir")
    module_map = config.get("fe_module_map") or {}
    if not fe_page_dir or not fe_page_dir.exists() or not module_map:
        return
    mapped = set(module_map.keys())
    actual = sorted(d.name for d in fe_page_dir.iterdir() if d.is_dir())
    unmapped = [d for d in actual if d not in mapped]
    missing = sorted(mapped - set(actual))
    if unmapped:
        safe_print(f"  [WARN] page dirs not covered by module_map ({len(unmapped)}): "
                   + ", ".join(unmapped))
        safe_print("         -> add to frontend_layers.page.module_map, "
                   "otherwise they fall into 'Shared'")
    if missing:
        safe_print(f"  [WARN] module_map entries without matching dir ({len(missing)}): "
                   + ", ".join(missing))
        safe_print("         -> remove stale entries from frontend_layers.page.module_map")
    if not unmapped and not missing:
        safe_print(f"  [OK] module_map covers all {len(actual)} page dirs")


def _scan_l1_modules(config):
    """Scan front-end pages and back-end *Mgr classes for L1.

    Returns (fe_modules, be_modules). Shared by generate_l1 and stale check.

    T2-1: the frontend surface is no longer ``fe_page_dir.rglob("*.vue")`` --
    it consumes ``scan_all_sources(config)`` so that every project listed in
    ``frontend_projects`` (not just the first) and every ``.ts`` / ``.less``
    (plus ``.js`` from the BLL layer) reach L1.  Module keys still come from
    ``_fe_module_match`` so L1 and L2 can never disagree on the module list.

    Each module dict additionally carries ``center`` (partition key, from the
    same classification the L2 grouping uses).  The rest of the shape is
    unchanged on purpose: ``_detect_stale_l1`` only reads ``name``.
    """
    centers = config.get("centers")
    sources = scan_all_sources(config)
    src_center = {s["path"]: s.get("center") for s in sources}

    # --- Frontend modules: one flat scan, grouped by module key ---
    fe_re = _build_fe_name_regex(config.get("fe_page_pattern"))
    groups = {}
    for item in sources:
        if item.get("kind") != "fe":
            continue
        key = _fe_module_match(item["path"], item["name"], fe_re,
                               config.get("fe_module_map")) or "Shared"
        grp = groups.setdefault(key, {
            "name": key, "dir": None, "main_file": None, "file_count": 0,
            "center": None, "_files": []})
        grp["file_count"] += 1
        grp["_files"].append(item)

    for grp in groups.values():
        files = grp.pop("_files")
        main = _pick_main_vue([Path(f["path"]) for f in files])
        main_rel = str(main).replace("\\", "/")
        main_item = next((f for f in files if f["path"] == main_rel), files[0])
        grp["main_file"] = main_item["path"].rsplit("/", 1)[-1]
        grp["dir"] = "/".join(main_item["path"].split("/")[:-1]) or "."
        grp["center"] = (main_item.get("center")
                         or src_center.get(main_item["path"])
                         or _classify_center(main_item["path"], None, centers))
        sibling_dir = (PROJECT_ROOT / grp["dir"] / grp["name"].lower()
                       if PROJECT_ROOT else None)
        if sibling_dir is not None and sibling_dir.is_dir():
            grp["file_count"] += sum(
                1 for _ in sibling_dir.rglob("*") if _.is_file())
    fe_modules = list(groups.values())

    def _m_sort_key(item):
        m = re.match(r'M(\d+)', item["name"])
        return (0, int(m.group(1)), "") if m else (1, 0, item["name"])
    fe_modules.sort(key=_m_sort_key)

    # Backend modules: *Mgr classes under BLL (group by class name prefix)
    be_modules = []
    be_bll_dir = config.get("be_bll_dir")
    if be_bll_dir and be_bll_dir.exists():
        cs_files = [f for f in be_bll_dir.rglob("*.cs")
                    if not _is_build_artifact(f)]
        module_groups = {}
        for cs in cs_files:
            try:
                content = cs.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            m = re.search(r'class\s+(\w+Mgr)\b', content)
            if m:
                mgr_name = m.group(1)
                mod_name = mgr_name.replace("Mgr", "")
                if mod_name not in module_groups:
                    module_groups[mod_name] = {
                        "name": mod_name, "mgr_class": mgr_name,
                        "files": [], "namespace": "", "center": None
                    }
                ns_match = re.search(r'namespace\s+([\w.]+)', content)
                if ns_match and not module_groups[mod_name]["namespace"]:
                    module_groups[mod_name]["namespace"] = ns_match.group(1)
                rel = str(cs.relative_to(PROJECT_ROOT)).replace("\\", "/")
                if module_groups[mod_name]["center"] is None:
                    module_groups[mod_name]["center"] = (
                        src_center.get(rel)
                        or _classify_center(rel, None, centers))
                module_groups[mod_name]["files"].append(rel)
        be_modules = list(module_groups.values())
        for mod in be_modules:
            mod["file_count"] = len(mod["files"])
            mod["dir"] = str(be_bll_dir.relative_to(PROJECT_ROOT)).replace("\\", "/")
        be_modules.sort(key=lambda x: x["name"])

    return fe_modules, be_modules


def _detect_stale_l1(config, l1_path):
    """Detect stale L1: module list mismatch vs current scan.

    Returns (is_stale, reason).
    """
    if not l1_path.exists():
        return False, ""
    content = l1_path.read_text(encoding="utf-8")
    fe_modules, be_modules = _scan_l1_modules(config)
    expected = set(m["name"] for m in fe_modules) | set(m["name"] for m in be_modules)

    # Recorded module names: data-table rows `| N | Name | ...`
    recorded = set()
    for m in re.finditer(r'^\| \d+ \| ([A-Za-z]\w*?) \|', content, re.MULTILINE):
        recorded.add(m.group(1))

    added = expected - recorded
    removed = recorded - expected
    reasons = []
    if added:
        reasons.append(f"+{len(added)} 新模块（{', '.join(sorted(added)[:3])}）")
    if removed:
        reasons.append(f"-{len(removed)} 已删模块（{', '.join(sorted(removed)[:3])}）")
    if reasons:
        return True, ", ".join(reasons)
    return False, ""


def _l1_center_summary(fe_modules, be_modules, centers):
    """Per-partition module/file totals for L1 (T2-1).

    Degraded mode (``centers is None``) returns "" so the template line it
    replaces stays an empty line -> byte-identical output.
    """
    if not centers:
        return ""
    keys = list(centers.get("order") or [])
    for mods in (fe_modules, be_modules):
        for m in mods:
            c = m.get("center")
            if c and c not in keys:
                keys.append(c)
    rows = []
    tot_mod = tot_fe = tot_be = 0
    for key in keys:
        fe = [m for m in fe_modules if m.get("center") == key]
        be = [m for m in be_modules if m.get("center") == key]
        n_fe = sum(int(m.get("file_count") or 0) for m in fe)
        n_be = sum(int(m.get("file_count") or 0) for m in be)
        mods = len(fe) + len(be)
        tot_mod += mods
        tot_fe += n_fe
        tot_be += n_be
        rows.append(f"| {key} | {len(fe)} | {n_fe} | {len(be)} | {n_be} "
                    f"| {mods} | {n_fe + n_be} |\n")
    rows.append(f"| **合计** | | | | | {tot_mod} | {tot_fe + tot_be} |\n")
    return ("**分区汇总**（按模块归属统计；分区取自 manifest `centers`。"
            "注意：模块粒度由文件名/目录命名约定决定，未拆分子模块的项目其前端会整体落 `common`）\n\n"
            "| 分区 | 前端模块 | 前端文件 | 后端模块 | 后端文件 | 合计模块 | 合计文件 |\n"
            "|------|---------|---------|---------|---------|---------|---------|\n"
            + "".join(rows) + "\n")


def generate_l1(config, check_only=False, force=False):
    kb_dir = config["kb_dir"]
    l1_path = kb_dir / "L1-overview.md"

    if l1_path.exists():
        auto = _is_auto_generated(l1_path)
        if not auto:
            # Manually edited file: never overwritten (decision F)
            if check_only:
                safe_print(f"  [INFO] L1 已存在（人工编辑）: {l1_path}")
            else:
                safe_print(f"  [SKIP] L1 已存在（人工编辑，不覆盖）")
            return True
        if check_only:
            is_stale, reason = _detect_stale_l1(config, l1_path)
            if is_stale:
                safe_print(f"  [INFO] L1 已存在（auto-generated），过时: {reason}")
                safe_print(f"         → 刷新: python scripts/gen-knowledge-base.py --level L1 --force")
            else:
                safe_print(f"  [INFO] L1 已存在（auto-generated），最新")
            return True
        if not force:
            safe_print(f"  [SKIP] L1 已存在（auto-generated），使用 --force 覆盖")
            return True

    fe_modules, be_modules = _scan_l1_modules(config)

    # Extract real WebApi class names (map anchor -> class name)
    be_webapi_classes = {}
    be_webapi_dir = config.get("be_webapi_dir")
    be_anchor_set = set(m["name"] for m in be_modules)
    if be_webapi_dir and be_webapi_dir.exists() and be_anchor_set:
        for fd in scan_cs_files(be_webapi_dir):
            for cls in fd["classes"]:
                anchor = _module_anchor_match(cls["name"], be_anchor_set)
                if anchor and anchor not in be_webapi_classes:
                    be_webapi_classes[anchor] = cls["name"]

    if check_only:
        safe_print(f"  [WARN] L1 缺失: {l1_path}")
        safe_print(f"         前端模块 {len(fe_modules)} 个，后端模块 {len(be_modules)} 个")
        return False

    template_path = TEMPLATE_DIR / "L1-overview.example.md"
    if not template_path.exists():
        safe_print(f"[FAIL] 模板不存在: {template_path}")
        return False
    template = template_path.read_text(encoding="utf-8")
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    def _rows_or_empty(rows, ncols):
        rows = rows.strip()
        if rows:
            return rows
        return "| " + " | ".join(["-"] * ncols) + " |"

    centers = config.get("centers")
    has_center = bool(centers)
    # T2-1: 中心列通过「行尾追加」条件化 -> 退化模式与改前逐字节一致
    fe_rows = _rows_or_empty("".join(
        f"| {i} | {m['name']} | {m['dir']} | {m['main_file']} | {m['file_count']} |"
        + (f" {m.get('center') or '-'} |\n" if has_center else "\n")
        for i, m in enumerate(fe_modules, 1)
    ), 6 if has_center else 5)
    be_rows = _rows_or_empty("".join(
        f"| {i} | {m['name']} | {m['dir']} | {m.get('namespace', '')} | {m['file_count']} |"
        + (f" {m.get('center') or '-'} |\n" if has_center else "\n")
        for i, m in enumerate(be_modules, 1)
    ), 6 if has_center else 5)
    fe_names = [m["name"] for m in fe_modules]
    be_names = [m["name"] for m in be_modules]

    def _name_sort_key(x):
        m = re.match(r'M(\d+)$', x)
        if m:
            return (0, int(m.group(1)), "")
        return (1, 0, x)

    all_names = sorted(set(fe_names + be_names), key=_name_sort_key)
    matrix_rows = ""
    for name in all_names:
        fe_entry = next((m["main_file"] for m in fe_modules if m["name"] == name), "-")
        be_mgr = next((m["mgr_class"] for m in be_modules if m["name"] == name), "-")
        be_api = be_webapi_classes.get(name, "-")
        matrix_rows += f"| {name} | {fe_entry} | {be_mgr} | {be_api} |\n"
    matrix_rows = _rows_or_empty(matrix_rows, 4)

    output = template
    output = output.replace("{{GENERATED_AT}}", now)
    output = output.replace("{{FRONTEND_MODULE_ROWS}}", fe_rows)
    output = output.replace("{{BACKEND_MODULE_ROWS}}", be_rows)
    output = output.replace("{{MODULE_FILE_MATRIX}}", matrix_rows)
    # T2-1: 中心列 + 分区汇总（退化模式三者为空串 -> 输出不变）
    output = output.replace("{{L1_CENTER_COL}}", " | 中心" if has_center else "")
    output = output.replace("{{L1_CENTER_SEP}}", "|--------" if has_center else "")
    output = output.replace("{{L1_CENTER_SUMMARY}}",
                            _l1_center_summary(fe_modules, be_modules, centers))

    l1_path.parent.mkdir(parents=True, exist_ok=True)
    l1_path.write_text(output, encoding="utf-8")
    _inc_written()
    safe_print(f"  [OK] L1 生成: {l1_path}（前端 {len(fe_modules)} 模块, 后端 {len(be_modules)} 模块）")
    return True


# --- L2 generation ---

def _extract_module_name(class_name):
    """Strip common suffixes to get module name."""
    for suffix in ["Mgr", "Entity", "Dto", "Service", "Controller", "WebApi"]:
        if class_name.endswith(suffix):
            return class_name[:-len(suffix)]
    return class_name


_MODULE_SUFFIXES = [
    "Mgr", "Web", "WebApi", "Entity", "Dto", "Query", "Queries",
    "Service", "Orchestrator", "Reader", "Factory", "Registry",
    "Mappers", "Adapter", "Gateway", "Options", "Metrics",
    "Checks", "Log", "Binder", "Model", "Item", "Detail", "Base",
]


def _module_anchor_match(class_name, anchors):
    """Match a class name to a business module anchor.

    Anchor source: *Mgr classes extracted from BLL layer.
    Returns anchor name or None (None -> Infra/shared bucket).
    """
    candidates = [class_name]
    # Strip leading I (interface)
    if class_name.startswith("I") and len(class_name) > 1 and class_name[1].isupper():
        candidates.append(class_name[1:])
    # Strip known suffixes
    for suffix in _MODULE_SUFFIXES:
        for cand in list(candidates):
            if cand.endswith(suffix) and len(cand) > len(suffix):
                candidates.append(cand[:-len(suffix)])
                if cand.startswith("I") and cand[1:2].isupper():
                    candidates.append(cand[1:-len(suffix)])
    # 1. Exact match
    for cand in candidates:
        if cand in anchors:
            return cand
    # 2. Prefix match (longest anchor first)
    for cand in candidates:
        for anchor in sorted(anchors, key=len, reverse=True):
            if cand.startswith(anchor):
                return anchor
    return None


def _parse_module_map(raw):
    """Parse "dir=ModuleKey,dir=ModuleKey" into {dir_name: module_key}.

    Generic by design: the manifest carries the project-specific names
    (frontend_layers.page.module_map); this function only knows the
    "dir=Key" wire format. Empty/invalid input -> {} (no behavior change).

    Validation is advisory -- warnings only, never raises; a fully valid map
    parses exactly as before:
      * malformed entry (no '=', empty key/value) -> skipped + [WARN]
      * duplicate dir -> FIRST value kept + [WARN] (was: silent overwrite)
      * value not shaped like a module key (letters + digits, e.g. M1/S1)
        -> kept as-is + [WARN]
    """
    mapping = {}
    if not raw:
        return mapping
    for pair in str(raw).split(","):
        pair = pair.strip()
        if not pair:
            continue
        if "=" not in pair:
            safe_print(f"[WARN] module_map: entry '{pair}' has no '=' -> skipped")
            continue
        key, val = pair.split("=", 1)
        key, val = key.strip(), val.strip()
        if not key or not val:
            safe_print(f"[WARN] module_map: entry '{pair}' has empty key/value -> skipped")
            continue
        if key in mapping:
            safe_print(f"[WARN] module_map: duplicate dir '{key}' "
                       f"(kept '{mapping[key]}', ignored '{val}')")
            continue
        if not re.match(r'^[A-Za-z]+\d+$', val):
            safe_print(f"[WARN] module_map: value '{val}' for dir '{key}' does not "
                       f"look like a module key (e.g. M1 / S1) -> kept as-is")
        mapping[key] = val
    return mapping


def _build_fe_name_regex(file_pattern):
    """Compile manifest frontend file_pattern into a name-matching regex.

    'M{模块序号}Module.vue' -> r'M\\d+Module$'
    Empty/invalid pattern -> r'M\\d+Module$' (conventional fallback).
    """
    if not file_pattern:
        return re.compile(r'M\d+Module$')
    esc = re.escape(file_pattern)
    esc = re.sub(r'\\\{[^}]*?\\\}', r'\\d+', esc)   # {…} placeholder -> \d+
    esc = re.sub(r'\\\.vue$', '', esc)              # strip .vue suffix
    try:
        return re.compile(esc + '$')
    except re.error:
        return re.compile(r'M\d+Module$')


def _fe_module_match(file_path, name, fe_re=None, module_map=None):
    """Match a frontend file to a module key (e.g. M3..M11 / Shared).

    Priority: explicit manifest dir->module map (Priority 0) ->
              file name matches configured file_pattern ->
              dir name m{n}[_suffix] -> shared.

    Note (FIX-10): module dirs are often named ``m1_order_receive`` /
    ``m10_quality_report`` (digit followed by a descriptive suffix), so the
    directory regex must NOT require ``/`` or end-of-string right after the
    digits -- it only needs to anchor on the leading ``m``.

    Note (migration): the explicit map comes from
    ``frontend_layers.page.module_map`` and makes module detection
    deterministic (no reliance on legacy ``m{n}_`` dir prefixes).

    Note (T1-5): map keys may now be composite ``parent/child`` two-segment
    paths. They are tried BEFORE single-segment keys (more specific first);
    maps without any '/' key take the original code path verbatim.
    """
    if fe_re is None:
        fe_re = re.compile(r'M\d+Module$')

    # Priority 0: explicit dir -> module map from manifest.
    if module_map:
        norm = str(file_path).replace("\\", "/")
        segs = norm.split("/")
        # 0a: composite "parent/child" keys (skipped when none exist, so
        #     legacy single-segment maps behave exactly as before).
        if any("/" in str(k).strip("/") for k in module_map.keys()):
            for i in range(len(segs) - 1):
                if not segs[i] or not segs[i + 1]:
                    continue
                pair = segs[i] + "/" + segs[i + 1]
                if pair in module_map:
                    return module_map[pair]
        # 0b: single-segment keys (original behaviour)
        for part in segs:
            if part in module_map:
                return module_map[part]

    if fe_re.match(name):
        # Key: strip conventional suffix for stable cross-layer naming
        return re.sub(r'Module$', '', name)
    dm = re.search(r'/m(\d+)[^/]*(?:/|$)', file_path, re.IGNORECASE)
    if dm:
        return 'M' + dm.group(1)
    if '/shared/' in file_path:
        return "Shared"
    return None


def _build_l2_groups(config, center=None, sources=None):
    """Scan code and group files into L2 modules.

    Args:
      center:  partition key (a ``centers.order`` entry or an alias). None =>
               no partition (pre-change behaviour).
      sources: output of ``scan_all_sources(config)``. When given it
               **short-circuits** the legacy scan below -- that scan only
               covers fe_page_dir/.vue and fe_bll_dir/.js, so the extra
               frontend projects and every .ts/.less would never reach L2.

    Returns dict: {module_map, fe_mod_map, all_mods}.
    Shared by generate_l2 and stale detection (check mode).

    Scope note: because ``sources`` is filtered by center first, the Infra
    and Shared buckets only ever contain files of THIS partition -- they are
    never merged across partitions.
    """
    center_key = _resolve_center_key(config.get("centers"), center) if center else None
    if sources is None and center_key is not None:
        sources = scan_all_sources(config)

    if sources is not None:
        # --- Unified-source mode: consume the flat list, filtered by center ---
        bll_prefix = None
        be_bll_dir = config.get("be_bll_dir")
        if be_bll_dir is not None and PROJECT_ROOT is not None:
            try:
                bll_prefix = str(Path(be_bll_dir).relative_to(PROJECT_ROOT)
                                 ).replace("\\", "/").rstrip("/") + "/"
            except Exception:
                bll_prefix = None

        be_all = []
        fe_all = []
        for item in sources:
            if center_key is not None and item.get("center") != center_key:
                continue
            if "classes" in item:
                be_all.append(item)
            else:
                fe_all.append(item)

        if bll_prefix is None:
            be_cs_bll = list(be_all)
        else:
            be_cs_bll = [fd for fd in be_all if str(fd["path"]).startswith(bll_prefix)]
    else:
        # --- Legacy mode: unchanged scan surface (byte-identical output) ---
        be_cs_bll = scan_cs_files(config.get("be_bll_dir"))
        be_all = list(be_cs_bll)
        for scan_dir in _backend_extra_dirs(config):
            be_all.extend(scan_cs_files(scan_dir))
        fe_vue = scan_vue_files(config.get("fe_page_dir"))
        fe_js = scan_js_files(config.get("fe_bll_dir"))
        fe_all = fe_vue + fe_js

    # --- Module anchors ---
    # Backend anchors: business modules extracted from any *Mgr class in BLL
    # (generic: no project-specific name prefix assumed)
    be_anchors = set()
    for fd in be_cs_bll:
        for cls in fd["classes"]:
            nm = cls["name"]
            if nm.endswith("Mgr") and len(nm) > len("Mgr"):
                be_anchors.add(nm[:-len("Mgr")])  # OrderMgr -> Order

    # --- Group backend files by anchor (unmatched -> Infra bucket) ---
    module_map = {}
    infra_bucket = {"files": [], "classes": [], "methods": [], "root_dirs": set()}

    def _bucket_add(bucket, fd):
        bucket["classes"].extend({**c, "file": fd["path"]} for c in fd["classes"])
        bucket["methods"].extend({**m, "file": fd["path"]} for m in fd["methods"])
        for c in fd["classes"]:
            entry = {"path": fd["path"], "type": c["type"], "class": c["name"]}
            if entry not in bucket["files"]:
                bucket["files"].append(entry)
        bucket["root_dirs"].add(str(Path(fd["path"]).parent).replace("\\", "/"))

    for fd in be_all:
        mod = None
        for cls in fd["classes"]:
            mod = _module_anchor_match(cls["name"], be_anchors)
            if mod:
                break
        if mod is None:
            mod = _module_anchor_match(Path(fd["path"]).stem, be_anchors)
        if mod:
            bucket = module_map.setdefault(
                mod, {"files": [], "classes": [], "methods": [], "root_dirs": set()})
        else:
            bucket = infra_bucket
        _bucket_add(bucket, fd)

    if infra_bucket["files"]:
        module_map["Infra"] = infra_bucket

    # --- Group frontend files by module (unmatched -> Shared bucket) ---
    fe_re = _build_fe_name_regex(config.get("fe_page_pattern"))
    fe_mod_map = {}
    fe_shared = []
    for v in fe_all:
        key = _fe_module_match(v["path"], v["name"], fe_re, config.get("fe_module_map"))
        if key:
            fe_mod_map.setdefault(key, []).append(v)
        else:
            fe_shared.append(v)
    if fe_shared:
        fe_mod_map["Shared"] = fe_shared

    all_mods = sorted(set(list(module_map.keys()) + list(fe_mod_map.keys())))
    return {
        "module_map": module_map,
        "fe_mod_map": fe_mod_map,
        "all_mods": all_mods,
    }


def _parse_l2_file_list(l2_file):
    """Parse file paths recorded in an L2 wiki's file-list tables.

    Returns set of file paths. Rows look like:
      | 1 | <后端根>/.../XxxOrder.cs | Class | XxxOrder | |
      | 1 | <前端根>/src/components/xxx/Xxx.vue | Component | |
    """
    if not l2_file.exists():
        return set()
    content = l2_file.read_text(encoding="utf-8")
    paths = set()
    for m in re.finditer(r'^\| \d+ \| ([^|]+?) \|', content, re.MULTILINE):
        p = m.group(1).strip()
        # T2-5: .ts/.less 同属 L2 文件清单口径（与 scan_fe_files 默认 exts 对齐）
        if p.endswith((".cs", ".vue", ".js", ".ts", ".less")) and "/" in p:
            paths.add(p)
    return paths


def _detect_stale_l2(l2_dir, groups, only=None):
    """Detect stale L2 module files: current file set != recorded file set.

    Returns list of (module, reason). `only` limits to given module names.
    """
    module_map = groups["module_map"]
    fe_mod_map = groups["fe_mod_map"]
    all_mods = only if only is not None else groups["all_mods"]

    stale = []
    for mod in all_mods:
        mod_file = l2_dir / f"{mod}.md"
        if not mod_file.exists():
            continue
        # Expected file set from current scan
        expected = set(f["path"] for f in module_map.get(mod, {}).get("files", []))
        expected |= set(f["path"] for f in fe_mod_map.get(mod, []))
        # Recorded file set from the L2 wiki
        recorded = _parse_l2_file_list(mod_file)
        if expected == recorded:
            continue
        added = expected - recorded
        removed = recorded - expected
        reasons = []
        if added:
            reasons.append(f"+{len(added)} 新文件")
        if removed:
            reasons.append(f"-{len(removed)} 已删文件")
        stale.append((mod, ", ".join(reasons)))
    return stale


def generate_l2(config, check_only=False, force=False, module_filter=None, center=None):
    """Generate L2 module wikis, optionally scoped to one center partition.

    T2-3:
      * ``config["centers"]`` absent (degraded single partition) -> ``l2_dir``
        stays ``kb_dir/L2-modules`` and the L1 auto-generation block below is
        untouched (AC-3: byte-identical to the pre-change run).
      * centers present + ``center`` given -> only that partition is handled:
        ``l2_dir`` becomes ``kb_dir/<center>/L2-modules``; the root-level
        ``L1-overview.md`` is neither written nor auto-generated (hint only).
    """
    kb_dir = config["kb_dir"]
    centers = config.get("centers")

    if centers is not None and not center:
        # 全量运行：L2 只存在于分区目录 => 逐分区各跑一次（不写根级 L2）
        all_ok = True
        for _key in (centers.get("order") or []):
            if not generate_l2(config, check_only=check_only, force=force,
                               module_filter=module_filter, center=_key):
                all_ok = False
        return all_ok

    center_key = None
    if centers is not None and center:
        center_key = _resolve_center_key(centers, center)
        if not center_key:
            safe_print(f"  [WARN] 未知分区 '{center}' ⇒ 退回根级 L2（可用: "
                       + ", ".join(centers.get("order") or []) + "）")

    if centers is None or not center_key:
        l2_dir = kb_dir / "L2-modules"
    else:
        l2_dir = kb_dir / center_key / "L2-modules"

    # Ensure L1 exists first (skip auto-generation in check mode)
    l1_path = kb_dir / "L1-overview.md"
    if center_key:
        # Partition mode: root L1 is the global overview, not partition-owned.
        if not l1_path.exists():
            safe_print("  [INFO] 分区模式：不生成根级 L1-overview.md"
                       "（如需全局概览请先跑 --level L1）")
    else:
        if not l1_path.exists():
            if check_only:
                safe_print("  [INFO] L1 不存在（check 模式下跳过自动生成）")
            else:
                safe_print("  [INFO] L1 不存在，先执行 L1 生成")
                if not generate_l1(config, check_only=False, force=force):
                    return False

    # Scan and group files into modules (partition mode consumes one flat scan)
    sources = scan_all_sources(config) if center_key else None
    groups = _build_l2_groups(config, center=center_key, sources=sources)
    module_map = groups["module_map"]
    fe_mod_map = groups["fe_mod_map"]
    all_mods = groups["all_mods"]
    if module_filter:
        all_mods = [m for m in all_mods if module_filter.lower() in m.lower()]

    if check_only:
        existing = [m for m in all_mods if (l2_dir / f"{m}.md").exists()]
        missing = [m for m in all_mods if not (l2_dir / f"{m}.md").exists()]
        stale = _detect_stale_l2(l2_dir, groups, only=existing)
        safe_print(f"  [INFO] L2 现状: {l2_dir}")
        safe_print(f"         已存在 {len(existing)} 个，缺失 {len(missing)} 个，过时 {len(stale)} 个")
        if missing:
            safe_print(f"         缺失: {', '.join(missing[:10])}"
                       + ("..." if len(missing) > 10 else ""))
        for mod, reason in stale:
            safe_print(f"         过时: {mod}（{reason}）")
        if missing or stale:
            safe_print(f"         → 刷新: python scripts/gen-knowledge-base.py --level L2 --force"
                       + (f" --module {stale[0][0]}" if stale and not missing else ""))
        return False

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    template_path = TEMPLATE_DIR / "L2-module.example.md"
    if not template_path.exists():
        safe_print(f"[FAIL] 模板不存在: {template_path}")
        return False
    template = template_path.read_text(encoding="utf-8")

    generated = 0
    for mod_name in all_mods:
        mod_file = l2_dir / f"{mod_name}.md"
        if mod_file.exists():
            auto = _is_auto_generated(mod_file)
            if not auto:
                safe_print(f"  [SKIP] L2/{mod_name}.md 已存在（人工编辑，不覆盖）")
                continue
            if not force:
                safe_print(f"  [SKIP] L2/{mod_name}.md 已存在（auto-generated），使用 --force 覆盖")
                continue

        be = module_map.get(mod_name, {"files": [], "classes": [], "methods": [], "root_dirs": set()})
        fe = fe_mod_map.get(mod_name, [])

        def _rows_or_empty(rows, ncols):
            rows = rows.strip()
            if rows:
                return rows
            return "| " + " | ".join(["-"] * ncols) + " |"

        be_file_rows = _rows_or_empty("".join(
            f"| {i} | {f['path']} | {f['type']} | {f.get('class', '')} | |\n"
            for i, f in enumerate(be["files"], 1)
        ), 5)
        be_class_rows = _rows_or_empty("".join(
            f"| {c['name']} | {c['file']} | {c['type']} | {c.get('namespace', '')} |\n"
            for c in be["classes"]
        ), 4)
        be_method_rows = ""
        for i, m in enumerate(be["methods"][:50], 1):
            be_method_rows += f"| {m['name']} | {m.get('class', '')} | {m['file']} | ({m.get('signature', '')}) |\n"
        if len(be["methods"]) > 50:
            be_method_rows += f"| ... | 还有 {len(be['methods']) - 50} 个 | | |\n"
        be_method_rows = _rows_or_empty(be_method_rows, 4)

        fe_file_rows = _rows_or_empty("".join(
            f"| {i} | {f['path']} | {f['type']} | |\n"
            for i, f in enumerate(fe, 1)
        ), 4)
        fe_comp_rows = _rows_or_empty("".join(
            f"| {f['name']} | {f['path']} | {f['type']} |\n"
            for f in fe if f["type"] in ("Page", "Component")
        ), 3)

        fe_dirs = set(str(Path(f["path"]).parent).replace("\\", "/") for f in fe)
        all_root_dirs = sorted(set(be["root_dirs"]) | fe_dirs)
        root_dirs_str = "".join(f"  - {rd}\n" for rd in all_root_dirs)
        if not root_dirs_str:
            root_dirs_str = "  (none)\n"

        out = template
        out = out.replace("{{MODULE_NAME}}", mod_name)
        out = out.replace("{{GENERATED_AT}}", now)
        out = out.replace("{{ROOT_DIRS}}", root_dirs_str.rstrip())
        out = out.replace("{{BACKEND_FILE_ROWS}}", be_file_rows)
        out = out.replace("{{BACKEND_CLASS_ROWS}}", be_class_rows)
        out = out.replace("{{BACKEND_METHOD_ROWS}}", be_method_rows)
        out = out.replace("{{FRONTEND_FILE_ROWS}}", fe_file_rows)
        out = out.replace("{{FRONTEND_COMPONENT_ROWS}}", fe_comp_rows)

        mod_file.parent.mkdir(parents=True, exist_ok=True)
        mod_file.write_text(out, encoding="utf-8")
        _inc_written()
        generated += 1

    if center_key:
        scanned = len([s for s in (sources or []) if s.get("center") == center_key])
        safe_print(f"  分区={center_key} 扫描={scanned} 文件 写入={generated} 个 L2")
    safe_print(f"  [OK] L2 生成: {l2_dir}（{generated} 个模块文件）")
    return True


# --- L3 generation ---

def _compute_l3_mappings(config):
    """Collect backend class names and compute L3 term mappings.

    Returns (biz_mapped, tech_mapped, unmapped).
    Shared by generate_l3 and stale detection (check mode).
    """
    all_classes = set()
    scan_dirs = []
    be_bll = config.get("be_bll_dir")
    if be_bll and be_bll.exists():
        scan_dirs.append(be_bll)
    scan_dirs.extend(_backend_extra_dirs(config))
    for dir_path in scan_dirs:
        for cs_data in scan_cs_files(dir_path):
            for cls in cs_data["classes"]:
                all_classes.add(cls["name"])

    biz_mapped = []      # (class_name, code_part, business_term)
    tech_mapped = []     # (code_part, tech_term)
    unmapped = []        # (class_name, code_part)
    seen_biz = set()
    seen_tech = set()
    seen_unmapped = set()

    for class_name in sorted(all_classes):
        for code_part in pascalcase_split(class_name):
            if code_part in BUSINESS_TERMS:
                key = (code_part, BUSINESS_TERMS[code_part])
                if key not in seen_biz:
                    seen_biz.add(key)
                    biz_mapped.append((class_name, code_part, BUSINESS_TERMS[code_part]))
            elif code_part in TECH_TERMS:
                if code_part not in seen_tech:
                    seen_tech.add(code_part)
                    tech_mapped.append((code_part, TECH_TERMS[code_part]))
            else:
                if len(code_part) > 2 and code_part not in TECH_NOISE \
                        and code_part not in seen_unmapped:
                    seen_unmapped.add(code_part)
                    unmapped.append((class_name, code_part))
    return biz_mapped, tech_mapped, unmapped


def _detect_stale_l3(config, l3_path):
    """Detect stale L3: new classes not recorded in the existing file.

    Compares expected class names (from current scan + mapping rules)
    against recorded class names (business table col4 + unmapped col2).
    Returns (is_stale, reason).
    """
    if not l3_path.exists():
        return False, ""
    content = l3_path.read_text(encoding="utf-8")
    biz_mapped, _, unmapped = _compute_l3_mappings(config)

    expected = set(cn for cn, _, _ in biz_mapped) | set(cn for cn, _ in unmapped)

    recorded = set()
    sec = None
    for line in content.split("\n"):
        if line.startswith("## 一、"):
            sec = "biz"
        elif line.startswith("## 二、"):
            sec = None
        elif line.startswith("## 四、"):
            sec = "unmapped"
        elif line.startswith("## 五、"):
            sec = None
        elif sec == "biz":
            m = re.match(r'\| \d+ \| [^|]+ \| `[^`]+` \| ([A-Za-z]\w*) \|', line)
            if m:
                recorded.add(m.group(1))
        elif sec == "unmapped":
            m = re.match(r'\| ([A-Za-z]\w*) \| ([A-Za-z]\w*) \|', line)
            if m:
                recorded.add(m.group(2))

    added = expected - recorded
    if added:
        sample = ", ".join(sorted(added)[:3])
        more = "..." if len(added) > 3 else ""
        return True, f"+{len(added)} 新类（如 {sample}{more}）"
    return False, ""


def generate_l3(config, check_only=False, force=False):
    kb_dir = config["kb_dir"]
    l3_path = kb_dir / "L3-glossary.md"

    if l3_path.exists():
        auto = _is_auto_generated(l3_path)
        if not auto:
            # Manually edited file: never overwritten (decision F)
            if check_only:
                safe_print(f"  [INFO] L3 已存在（人工编辑）: {l3_path}")
            else:
                safe_print(f"  [SKIP] L3 已存在（人工编辑，不覆盖）")
            return True
        if check_only:
            is_stale, reason = _detect_stale_l3(config, l3_path)
            if is_stale:
                safe_print(f"  [INFO] L3 已存在（auto-generated），过时: {reason}")
                safe_print(f"         → 刷新: python scripts/gen-knowledge-base.py --level L3 --force")
            else:
                safe_print(f"  [INFO] L3 已存在（auto-generated），最新")
            return True
        if not force:
            safe_print(f"  [SKIP] L3 已存在（auto-generated），使用 --force 覆盖")
            return True

    biz_mapped, tech_mapped, unmapped = _compute_l3_mappings(config)

    if check_only:
        safe_print(f"  [WARN] L3 缺失: {l3_path}")
        safe_print(f"         业务术语映射 {len(biz_mapped)} 个，技术模式 {len(tech_mapped)} 个，"
                   f"未映射 {len(unmapped)} 个")
        return False

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # ★ 2026-09-23：反向入口 —— 与 docs/iterations/INDEX.md 的「代码命名反查见 L3」构成双向指针。
    #   本页管「业务术语 <-> 代码命名」；需求/评审编号（AC-/CV-/Tn-/D-n-n）的定位见编号反查索引。
    #   路径按 kb_dir 推导（不写死字面量），与 INDEX.md 的实际落点保持一致。
    try:
        _idx_rel = os.path.relpath(
            (kb_dir.parent / "iterations" / "INDEX.md").resolve(), l3_path.parent.resolve()
        ).replace(os.sep, "/")
    except Exception:                                    # noqa: BLE001
        _idx_rel = "../iterations/INDEX.md"

    lines = [
        "# L3 术语映射表 -- 代码命名反查",
        "",
        "> 本文件由 `scripts/gen-knowledge-base.py --level L3` 自动生成（方案B：代码反查）。",
        "> 仅含已实现代码中的术语映射，Spec 中规划但未编码的概念需人工补充。",
        f"> **编号反查入口**：「需求/评审编号（`AC-` / `CV-` / `Tn-` / `D-n-n`）→ 文件」见 "
        f"[`{_idx_rel}`]({_idx_rel})（由 `tools/gen_doc_index.py` 生成，含定义候选与引用分布）。",
        "",
        "<!--",
        "auto-generated: true",
        f"generated_at: {now}",
        "generator: gen-knowledge-base.py",
        "-->",
        "",
        "## 一、业务术语 <-> 代码 映射表",
        "",
        "| # | 业务术语 | 代码片段 | 完整代码命名 |",
        "|:--:|---------|---------|------------|",
    ]
    for i, (cn, cp, bt) in enumerate(biz_mapped, 1):
        lines.append(f"| {i} | {bt} | `{cp}` | {cn} |")

    lines += [
        "",
        "## 二、命名模式说明（技术词）",
        "",
        "> 以下为技术性命名约定，非业务术语，供阅读代码时参照。",
        "",
        "| 代码片段 | 含义 |",
        "|---------|------|",
    ]
    for cp, tt in sorted(tech_mapped):
        lines.append(f"| `{cp}` | {tt} |")

    lines += [
        "",
        "## 三、按模块分组（模块 -> 业务术语）",
        "",
        "| 模块 | 业务术语关键词 |",
        "|------|--------------|",
    ]
    mod_terms = {}
    for cn, cp, bt in biz_mapped:
        mod = _extract_module_name(cn)
        # Strip leading I (interface prefix) for cleaner module names
        if mod.startswith("I") and len(mod) > 1 and mod[1].isupper():
            mod = mod[1:]
        mod_terms.setdefault(mod, set()).add(bt)
    for mod in sorted(mod_terms.keys()):
        terms = ", ".join(sorted(mod_terms[mod]))
        lines.append(f"| {mod} | {terms} |")

    lines += [
        "",
        "## 四、未映射代码片段（待人工补充）",
        "",
        "| 代码片段 | 出现于 |",
        "|---------|--------|",
    ]
    for cn, cp in sorted(unmapped, key=lambda x: x[1]):
        lines.append(f"| {cp} | {cn} |")
    if not unmapped:
        lines.append("| - | - |")

    lines += [
        "",
        "## 五、从业务需求定位代码",
        "",
        "> 人工填写：业务需求 -> 代码路径映射",
        "",
        "| 业务需求 | -> 定位路径 |",
        "|---------|-----------|",
        "| (待人工补充) | |",
        "",
        "## 变更记录",
        "",
        "| 日期 | 操作 | 说明 |",
        "|------|------|------|",
        f"| {now} | auto-gen | 初始生成（代码反查） |",
        "",
    ]

    l3_path.parent.mkdir(parents=True, exist_ok=True)
    l3_path.write_text("\n".join(lines), encoding="utf-8")
    _inc_written()
    safe_print(f"  [OK] L3 生成: {l3_path}"
               f"（业务术语 {len(biz_mapped)} 个, 技术模式 {len(tech_mapped)} 个, "
               f"待补充 {len(unmapped)} 个）")
    return True


# --- Content fingerprint (★ stale detection beyond file-set diff) ---
#
# Why: the *_detect_stale_* checks above only compare *sets*
# (module names / file paths / class names). Iterations that only change code
# *inside* existing files (method signatures, interfaces, columns) are reported
# as "up to date" forever -- the KB then silently drifts from reality.
# The fingerprint records (mtime, size) per scanned file, so any content change
# becomes visible to --check.

FINGERPRINT_VERSION = 2   # v2: 3 个前端工程 + .ts/.less + backend_root 全量

# ★ 本次运行实际写入的 KB 文件数 —— 指纹基线只在「确有写入 + 全量运行」时重建；
#   否则一次空跑（全部 SKIP）会用当前代码状态覆盖基线，抹掉"待刷新"信号。
_WRITTEN_KB_FILES = 0


def _inc_written(n=1):
    global _WRITTEN_KB_FILES
    _WRITTEN_KB_FILES += n


def _fingerprint_path():
    """Cache location: runtime/ (gate ALWAYS_ALLOW) -- writable in any phase."""
    if MANIFEST_ROOT is None:
        return None
    return MANIFEST_ROOT / "runtime" / "kb-fingerprint.json"


def _collect_fingerprint_files(config):
    """Files covered by the L1/L2/L3 scans (os.stat only -- no content read).

    T2-6: the surface now equals ``scan_all_sources`` -- all
    ``frontend_projects[].src`` (no longer just the first page dir) with
    ``.vue/.ts/.less/.js`` and the whole ``backend_root`` (falls back to the
    legacy BLL + extra dirs).  ``*.d.ts`` is excluded **by file name** (its
    suffix is still ``.ts``, so an extension test cannot express it).

    Robustness: unreadable dirs (rglob) and paths outside the project root
    (relative_to) are skipped with a single warning instead of raising.
    """
    dirs = []
    for proj in (config.get("frontend_projects") or []):
        src = proj.get("src") if isinstance(proj, dict) else None
        if not src:
            continue
        p = Path(src)
        if p.exists() and p not in dirs:
            dirs.append(p)
    d = config.get("fe_bll_dir")
    if d and d.exists() and Path(d) not in dirs:
        dirs.append(Path(d))
    if not dirs:
        for key in ("fe_page_dir", "fe_bll_dir"):
            d = config.get(key)
            if d and d.exists() and Path(d) not in dirs:
                dirs.append(Path(d))

    be_root = config.get("backend_root")
    if be_root and Path(be_root).exists():
        dirs.append(Path(be_root))
    else:
        d = config.get("be_bll_dir")
        if d and d.exists() and Path(d) not in dirs:
            dirs.append(Path(d))
        dirs.extend(_backend_extra_dirs(config))

    pats = (".vue", ".ts", ".less", ".js", ".cs")
    seen = set()
    files = []
    warned = False
    for d in dirs:
        try:
            candidates = sorted(Path(d).rglob("*"))
        except OSError as e:
            safe_print(f"  [WARN] 指纹采集跳过不可读目录 {d}: {e}")
            continue
        for f in candidates:
            try:
                if not f.is_file() or f.suffix.lower() not in pats:
                    continue
                if f.name.lower().endswith(".d.ts"):
                    continue
                if _is_build_artifact(f):
                    continue
                rel = str(f.relative_to(PROJECT_ROOT)).replace("\\", "/")
            except (OSError, ValueError) as e:
                if not warned:
                    safe_print(f"  [WARN] 指纹采集跳过越界/不可读项（示例 {f}: {e}）")
                    warned = True
                continue
            if rel in seen:
                continue
            seen.add(rel)
            files.append((rel, f))
    return files


def _compute_fingerprint(config):
    fp = {}
    for rel, f in _collect_fingerprint_files(config):
        try:
            st = f.stat()
        except OSError:
            continue
        # ★ nanosecond mtime: int(st.st_mtime) truncates to seconds and would miss
        #   rewrites of identical length within the same second.
        fp[rel] = [int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))), st.st_size]
    return fp


def _load_fingerprint():
    """Return (files, state); state in {'ok', 'missing', 'invalid'}.

    'invalid' (corrupt JSON / version mismatch) is reported to the user rather
    than being silently presented as a first run.
    """
    p = _fingerprint_path()
    if not p or not p.exists():
        return None, "missing"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None, "invalid"
    if not isinstance(data, dict) or data.get("version") != FINGERPRINT_VERSION:
        return None, "invalid"
    files = data.get("files")
    return (files, "ok") if isinstance(files, dict) else (None, "invalid")


def _fingerprint_scopes(config):
    """rel path -> center key for every fingerprint-covered file (T2-8).

    唯一判定口径：``_merge_center_fingerprint`` / ``_diff_fingerprint`` /
    ``_report_fingerprint`` 全部只调用本函数。

    Authoritative source = ``scan_all_sources()`` (与 L2 分组同一判定)。
    扫描面覆盖不到但仍进指纹的文件（无任何类的 .cs、只声明 .vue/.ts/.less
    的工程里的 .js）用 ``_classify_center`` 补齐 => 映射是全量的。
    退化模式（无 ``centers``）返回 None => 不过滤。
    """
    centers = config.get("centers")
    if centers is None:
        return None
    scopes = {}
    for s in scan_all_sources(config):
        scopes[s["path"]] = s.get("center")

    binding_of = {}
    for proj in (config.get("frontend_projects") or []):
        src = proj.get("src") if isinstance(proj, dict) else None
        if not src:
            continue
        try:
            prefix = str(Path(src).relative_to(PROJECT_ROOT)).replace("\\", "/")
        except Exception:
            prefix = str(src).replace("\\", "/")
        prefix = prefix.rstrip("/")
        if prefix:
            binding_of[prefix] = proj.get("center")

    for rel, _f in _collect_fingerprint_files(config):
        if rel in scopes:
            continue
        binding, best = None, -1
        for prefix, c in binding_of.items():
            if (rel == prefix or rel.startswith(prefix + "/")) and len(prefix) > best:
                best, binding = len(prefix), c
        scopes[rel] = _classify_center(rel, binding, centers)
    return scopes


def _save_fingerprint(config, center=None):
    """Rebuild the whole baseline (center=None) or merge one partition (T2-7)."""
    if center:
        return _merge_center_fingerprint(config, center)
    p = _fingerprint_path()
    if not p:
        return False
    payload = {
        "version": FINGERPRINT_VERSION,
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "files": _compute_fingerprint(config),
    }
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return True
    except Exception as e:
        safe_print(f"  [WARN] 指纹写入失败: {e}")
        return False


def _merge_center_fingerprint(config, center=None):
    """Merge ONE partition into the existing baseline (T2-7).

    Semantics: overwrite this partition's keys, **delete this partition's keys
    that no longer exist** (so ``--center X --check`` can still report
    ``-N 已删除``), leave every other partition untouched.

    invalid 守卫: 基线缺失/损坏/版本不符时绝不落盘 —— 把局部状态合并到一个
    陌生基线之上，等于替其它分区"销账"。
    """
    p = _fingerprint_path()
    if not p:
        return False
    old, state = _load_fingerprint()
    if state != "ok":
        safe_print("  [FAIL] 指纹基线无效（缺失/损坏/版本不符）"
                   " => 请先执行一次全量生成重建指纹基线")
        return False

    centers = config.get("centers")
    center_key = _resolve_center_key(centers, center) if (centers and center) else None
    scopes = _fingerprint_scopes(config)
    if center_key is None or scopes is None:
        in_scope = lambda rel: True
    else:
        in_scope = lambda rel: scopes.get(rel) == center_key

    current = _compute_fingerprint(config)
    merged = {k: v for k, v in (old or {}).items() if not in_scope(k)}
    covered = 0
    for k, v in current.items():
        if in_scope(k):
            merged[k] = v
            covered += 1
    dropped = sum(1 for k in (old or {}) if in_scope(k) and k not in current)

    payload = {
        "version": FINGERPRINT_VERSION,
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "files": merged,
    }
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        safe_print(f"  [WARN] 指纹写入失败: {e}")
        return False
    safe_print(f"  [OK] 指纹分区已合并: 分区={center_key or '(全部)'} "
               f"覆盖={covered} 移除={dropped} 总键={len(merged)}")
    return True


def _diff_fingerprint(config, center=None):
    """Compare current files vs cached fingerprint.

    ``center`` restricts the comparison to one partition using the **same**
    predicate as ``_merge_center_fingerprint`` (``_fingerprint_scopes``), so a
    partition-scoped check can never disagree with a partition-scoped merge.

    Returns (added, removed, changed, state). Malformed cache values are treated
    as "changed" (never raise -- --check must stay read-only and safe).
    """
    current = _compute_fingerprint(config)
    cached, state = _load_fingerprint()
    if state != "ok":
        return None, None, None, state

    scopes = _fingerprint_scopes(config) if center else None
    if center and scopes is not None:
        center_key = _resolve_center_key(config.get("centers"), center) or center
        cur_keys = {k for k in current if scopes.get(k) == center_key}
        old_keys = {k for k in cached if scopes.get(k) == center_key}
    else:
        cur_keys, old_keys = set(current), set(cached)

    added = sorted(cur_keys - old_keys)
    removed = sorted(old_keys - cur_keys)
    changed = []
    for k in sorted(cur_keys & old_keys):
        old = cached.get(k)
        if not (isinstance(old, (list, tuple)) and len(old) == 2):
            changed.append(k)
            continue
        if list(current[k]) != list(old):
            changed.append(k)
    return added, removed, changed, state


def _report_fingerprint(config, center=None):
    """Print the fingerprint diff (check mode). Returns True when changed."""
    added, removed, changed, state = _diff_fingerprint(config, center=center)
    if state == "missing":
        safe_print("  [INFO] 文件指纹：无基线（首次全量生成后自动建立），跳过比对")
        return False
    if state == "invalid":
        safe_print("  [WARN] 文件指纹基线无效（文件损坏或版本不符）⇒ 已跳过比对，"
                   "请执行一次全量生成以重建")
        return False
    total = len(added) + len(removed) + len(changed)
    if total == 0:
        safe_print("  [INFO] 文件指纹：与上次全量刷新一致（mtime_ns + size 无变化）")
        return False
    scope = f"（分区 {center}）" if center else ""
    safe_print(f"  [INFO] 文件指纹{scope}：{total} 处变更"
               f"（+{len(added)} 新增 / -{len(removed)} 删除 / ~{len(changed)} 修改）")
    for p in (removed + changed + added)[:5]:
        safe_print(f"         ~ {p}")
    safe_print("         → 刷新: python scripts/gen-knowledge-base.py --level all --force")
    return True


# --- Safe print ---

def safe_print(*args, **kwargs):
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        safe_args = []
        for a in args:
            if isinstance(a, str):
                safe_args.append(a.encode('ascii', errors='replace').decode('ascii'))
            else:
                safe_args.append(a)
        print(*safe_args, **kwargs)


def _report_partition_reconciliation(config):
    """Per-partition file counts + partition-vs-total check (AC-6 / T2-10).

    Returns True when every scanned source lands in a declared partition and
    the partition counts add up to the full scan. Degraded mode (no
    ``centers``) is a no-op.
    """
    centers = config.get("centers")
    if not centers:
        safe_print("  [INFO] 分区对账：manifest 未声明 centers（退化单分区）=> 跳过")
        return True

    counts = {}
    for s in scan_all_sources(config):
        c = s.get("center")
        counts[c] = counts.get(c, 0) + 1

    order = list(centers.get("order") or [])
    keys = list(order)
    for c in counts:
        if c not in keys:
            keys.append(c)

    total = 0
    unknown = []
    for k in keys:
        n = counts.get(k, 0)
        total += n
        if k not in order:
            unknown.append(k)
        safe_print(f"         分区={k} 文件={n}")
    overall = sum(counts.values())
    safe_print(f"         合计={total} 全量={overall}")

    ok = True
    if unknown:
        safe_print(f"  [FAIL] 存在未声明的分区键: {unknown}")
        ok = False
    if total != overall:
        safe_print("  [FAIL] 分区对账不一致")
        ok = False
    if ok:
        safe_print("  [OK] 分区对账一致（每个文件唯一归属，合计 == 全量）")
    return ok


# --- Main ---

def main():
    parser = argparse.ArgumentParser(
        description="L1/L2/L3 knowledge base auto-generator"
    )
    parser.add_argument("--level", choices=["L1", "L2", "L3", "all"],
                        default="all", help="Which level to generate")
    parser.add_argument("--check", action="store_true",
                        help="Check status only, no write")
    parser.add_argument("--force", action="store_true",
                        help="Overwrite auto-generated: true files")
    parser.add_argument("--module", type=str, default=None,
                        help="Generate L2 for specific module only (fuzzy match)")
    parser.add_argument("--center", type=str, default=None,
                        help="Partition key/alias from manifest 'centers' "
                             "(scoped L2 + scoped fingerprint)")
    args = parser.parse_args()

    safe_print("=" * 60)
    safe_print("gen-knowledge-base.py -- L1/L2/L3 knowledge base generator")

    config = load_manifest()
    # T2-8: --center 一律先归一为 centers.order 的规范键（别名/大小写/下划线）
    center_key = None
    if args.center:
        centers = config.get("centers")
        if not centers:
            safe_print(f"[FAIL] manifest 未声明 centers => --center '{args.center}' 不可用")
            return 2
        center_key = _resolve_center_key(centers, args.center)
        if not center_key:
            safe_print(f"[FAIL] 未知中心 '{args.center}'"
                       f"（可用: {', '.join(centers.get('order') or [])}）")
            return 2
        args.center = center_key
    kb_dir = config["kb_dir"]
    safe_print(f"Project root: {PROJECT_ROOT}")
    safe_print(f"Output dir:  {kb_dir}")
    safe_print(f"Level: {args.level}, check={args.check}, force={args.force}")
    if args.module:
        safe_print(f"Module filter: {args.module}")
    if center_key:
        safe_print(f"Center filter: {center_key}")
    safe_print("=" * 60)

    if args.check:
        safe_print("\n[CHECK MODE] 检查知识库现状：")
    else:
        safe_print("\n[GENERATE] 生成知识库：")

    level = args.level
    rc = 0
    if level in ("L1", "all"):
        if center_key:
            # AC-7: 分区刷新不改写、也不自动生成根级 L1-overview.md
            safe_print("\n--- L1: 项目模块总览 ---")
            safe_print("  [SKIP] 分区刷新不改写根级 L1-overview.md（AC-7）")
        else:
            safe_print("\n--- L1: 项目模块总览 ---")
            generate_l1(config, check_only=args.check, force=args.force)
            if args.check:
                _report_module_dir_coverage(config)

    if level in ("L2", "all"):
        safe_print("\n--- L2: 模块级 Wiki ---")
        generate_l2(config, check_only=args.check, force=args.force,
                    module_filter=args.module, center=center_key)
        # T2-10 (AC-6): 全量 --check 追加分区对账，不一致则退出码非 0
        if (args.check and level == "all"
                and not args.module and not center_key):
            if not _report_partition_reconciliation(config):
                rc = 1

    if level in ("L3", "all"):
        if center_key:
            safe_print("\n--- L3: 术语映射表 ---")
            safe_print("  [SKIP] L3 仅全量重建（--center 分区刷新不重建术语映射）")
        else:
            safe_print("\n--- L3: 术语映射表 ---")
            generate_l3(config, check_only=args.check, force=args.force)

    # ★ 文件指纹：检出"既有文件被改动"（集合比对之外的第二信号）
    #   check：仅报告（不写文件）；生成：仅在**确有写入**且为**全量**时重建基线。
    fp_changed = False
    full_run = (args.level == "all") and not args.module and not center_key
    if args.check:
        safe_print("\n--- 文件指纹（mtime_ns + size 变更检测）---")
        if full_run:
            fp_changed = _report_fingerprint(config)
        elif center_key:
            fp_changed = _report_fingerprint(config, center=center_key)
        else:
            safe_print("  [INFO] 部分检查（--level / --module）⇒ 跳过指纹比对，避免越界提示")
    else:
        safe_print("\n--- 文件指纹 ---")
        if _WRITTEN_KB_FILES <= 0:
            safe_print("  [SKIP] 本次未写入任何知识库文件 ⇒ 指纹基线保持不变（不掩盖待刷新信号）")
        elif center_key:
            if _save_fingerprint(config, center=center_key):
                safe_print(f"  [OK] 指纹分区已合并: 分区={center_key}")
        elif not full_run:
            safe_print("  [SKIP] 部分刷新（--level / --module）⇒ 指纹基线保持不变，待全量刷新重建")
        elif _save_fingerprint(config):
            safe_print("  [OK] 指纹基线已更新: runtime/kb-fingerprint.json")

    safe_print("\n" + "=" * 60)
    if args.check:
        safe_print("[CHECK] 检查完成。缺失/过时的文件可用以下命令刷新：")
        safe_print("  python scripts/gen-knowledge-base.py                    # 生成缺失的")
        safe_print("  python scripts/gen-knowledge-base.py --force            # 刷新过时的(auto-generated)")
        safe_print("  python scripts/gen-knowledge-base.py --level L2 --force --module Xxx  # 单模块刷新")
        if fp_changed:
            safe_print("  ★ 文件指纹检出变更 ⇒ 即使 L1/L2/L3 报「最新」，也应执行全量 --force 重建")
    else:
        safe_print("[DONE] 生成完成。")
        safe_print("  - auto-generated: true 的文件可被 --force 覆盖刷新")
        safe_print("  - auto-generated: false 的文件永不覆盖（★ 文件级判定，非分节）")
        safe_print("    ⇒ 该文件将整体失去自动刷新能力；分节保留人工内容当前不支持")
        safe_print("  - 建议人工补充 L2 业务语义段 + L3 未映射术语")
    safe_print("=" * 60)
    return rc


if __name__ == "__main__":
    sys.exit(main())
