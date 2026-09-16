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

Coverage rules (decision F):
  auto-generated: true  -> refreshable via --force
  auto-generated: false -> manually edited, NEVER overwritten
"""

import os
import re
import sys
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
    }


# --- Term mapping tables (PascalCase reverse-lookup) ---

# Business domain terms: these appear in the L3 business mapping table.
BUSINESS_TERMS = {
    "Order": "医嘱", "Admixture": "混合调配", "Label": "标签", "Batch": "批次",
    "Check": "核对", "Delivery": "配送", "DeliveryHandover": "配送交接",
    "Audit": "审核", "Drug": "药品", "Solution": "溶媒", "IV": "静脉输液",
    "Pivas": "静配中心", "Ward": "病区", "Nurse": "护士",
    "NurseStation": "护士工作站", "Pharmacist": "药师",
    "QualityControl": "质控", "QC": "质控", "Production": "生产",
    "Dashboard": "看板", "Receive": "接收", "Print": "打印", "Scan": "扫描",
    "Plan": "用药计划", "Sync": "同步", "His": "医院信息系统(HIS)",
    "Patient": "患者", "Prescription": "处方", "Dose": "剂量",
    "Frequency": "频次", "Route": "给药途径", "Report": "报表",
    "Stat": "统计", "Monitor": "监测", "User": "用户", "Role": "角色",
    "Menu": "菜单", "Permission": "权限", "Status": "状态",
    "Dict": "数据字典", "Record": "记录",
}

# Technical naming patterns: listed separately as a naming-convention reference.
TECH_TERMS = {
    "Mgr": "管理器（BLL 业务类后缀）", "Manager": "管理器", "Service": "服务",
    "Dto": "数据传输对象", "Entity": "实体", "Model": "模型",
    "Query": "查询", "Queries": "查询集", "Config": "配置",
    "Result": "结果", "Base": "基类", "Guid": "全局唯一标识",
    "Item": "明细项", "Detail": "明细", "Web": "接口层", "WebApi": "Web 接口",
    "BLL": "业务逻辑层", "Inf": "基础设施层", "Component": "组件",
    "Store": "状态存储", "Const": "常量", "Exception": "异常",
    "Helper": "辅助类", "SoftDelete": "软删除", "Adapter": "适配器",
    "Sys": "系统", "Param": "参数",
}

# Technical noise: excluded from the "unmapped, needs manual input" list.
TECH_NOISE = {
    "Adapter", "Gateway", "Options", "Registry", "Factory", "Log",
    "Consts", "Codes", "Error", "Framework", "Bootstrapper", "Checks",
    "Smoke", "Orchestrator", "Read", "Only", "Non", "Std", "Oracle",
    "Meta", "Mapper", "Paged", "Sql", "Binder", "Parameter", "Metrics",
    "Diagnostics", "Assembly", "Info", "Interface", "Operation",
    "Add", "Update", "Delete", "Remove", "Get", "Set", "Save", "Find",
    "Count", "Total", "Time", "Date",
}


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


def scan_vue_files(directory):
    """Scan .vue files: extract component names. Skips node_modules/dist."""
    results = []
    if not directory or not directory.exists():
        return results
    for vue_file in sorted(directory.rglob("*.vue")):
        if _is_build_artifact(vue_file):
            continue
        rel_path = str(vue_file.relative_to(PROJECT_ROOT)).replace("\\", "/")
        name = vue_file.stem
        comp_type = "Page" if re.match(r'M\d+Module', name) else "Component"
        results.append({"path": rel_path, "name": name, "type": comp_type})
    return results


def scan_js_files(directory):
    """Scan .js files (frontend bll/store layer). Skips node_modules/dist."""
    results = []
    if not directory or not directory.exists():
        return results
    for js_file in sorted(directory.rglob("*.js")):
        if _is_build_artifact(js_file):
            continue
        rel_path = str(js_file.relative_to(PROJECT_ROOT)).replace("\\", "/")
        results.append({"path": rel_path, "name": js_file.stem, "type": "JS"})
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
    """
    # Frontend modules: recursive scan under {page_dir}.
    #
    # FIX-10: originally this only globbed "{page_dir}/*Module.vue" (flat,
    # one module = one file). Projects that nest pages as
    # "pages/pivas/m1_order_receive/drug_list.vue" produced 0 modules.
    # Now we reuse the same module key resolution as L2 (_fe_module_match),
    # so L1 and L2 can never disagree about the module list.
    fe_modules = []
    fe_page_dir = config.get("fe_page_dir")
    if fe_page_dir and fe_page_dir.exists():
        fe_re = _build_fe_name_regex(config.get("fe_page_pattern"))
        groups = {}
        for vue_file in sorted(fe_page_dir.rglob("*.vue")):
            if _is_build_artifact(vue_file):
                continue
            rel_path = str(vue_file.relative_to(PROJECT_ROOT)).replace("\\", "/")
            key = _fe_module_match(rel_path, vue_file.stem, fe_re,
                                   config.get("fe_module_map")) or "Shared"
            grp = groups.setdefault(key, {
                "name": key, "dir": None, "main_file": None, "file_count": 0,
                "_vue": []})
            grp["file_count"] += 1
            grp["_vue"].append(vue_file)

        # Pick the representative .vue per group (see _pick_main_vue) instead
        # of "first in scan order" -- a group may hold auxiliary components.
        for grp in groups.values():
            main = _pick_main_vue(grp["_vue"])
            del grp["_vue"]
            grp["main_file"] = main.name
            grp["dir"] = str(main.parent.relative_to(
                PROJECT_ROOT)).replace("\\", "/")
            # Legacy layout: a sibling dir named after the module
            # (e.g. m3/ next to M3Module.vue) also counts.
            sibling_dir = main.parent / grp["name"].lower()
            if sibling_dir.exists():
                grp["file_count"] += sum(
                    1 for _ in sibling_dir.rglob("*") if _.is_file())
        fe_modules = list(groups.values())
        # Sort by M-number (M3 < M4 < ... < M11)
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
                        "files": [], "namespace": ""
                    }
                ns_match = re.search(r'namespace\s+([\w.]+)', content)
                if ns_match and not module_groups[mod_name]["namespace"]:
                    module_groups[mod_name]["namespace"] = ns_match.group(1)
                module_groups[mod_name]["files"].append(
                    str(cs.relative_to(PROJECT_ROOT)).replace("\\", "/")
                )
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

    fe_rows = _rows_or_empty("".join(
        f"| {i} | {m['name']} | {m['dir']} | {m['main_file']} | {m['file_count']} |\n"
        for i, m in enumerate(fe_modules, 1)
    ), 5)
    be_rows = _rows_or_empty("".join(
        f"| {i} | {m['name']} | {m['dir']} | {m.get('namespace', '')} | {m['file_count']} |\n"
        for i, m in enumerate(be_modules, 1)
    ), 5)
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

    l1_path.parent.mkdir(parents=True, exist_ok=True)
    l1_path.write_text(output, encoding="utf-8")
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
    """
    if fe_re is None:
        fe_re = re.compile(r'M\d+Module$')

    # Priority 0 (NEW): explicit dir -> module map from manifest.
    # Deterministic: relies on configuration, not on path naming conventions.
    # NOTE: local var ``norm`` is used by this branch only; the branches
    # below keep using ``file_path`` verbatim (zero side effects).
    if module_map:
        norm = str(file_path).replace("\\", "/")
        for part in norm.split("/"):
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


def _build_l2_groups(config):
    """Scan code and group files into L2 modules.

    Returns dict: {module_map, fe_mod_map, all_mods}.
    Shared by generate_l2 and stale detection (check mode).
    """
    be_cs_bll = scan_cs_files(config.get("be_bll_dir"))
    be_all = list(be_cs_bll)
    for scan_dir in _backend_extra_dirs(config):
        be_all.extend(scan_cs_files(scan_dir))
    fe_vue = scan_vue_files(config.get("fe_page_dir"))
    fe_js = scan_js_files(config.get("fe_bll_dir"))

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
    for v in fe_vue + fe_js:
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
      | 1 | back-end/.../PivasOrder.cs | Class | PivasOrder | |
      | 1 | pivas-prototype/src/components/m8/X.vue | Component | |
    """
    if not l2_file.exists():
        return set()
    content = l2_file.read_text(encoding="utf-8")
    paths = set()
    for m in re.finditer(r'^\| \d+ \| ([^|]+?) \|', content, re.MULTILINE):
        p = m.group(1).strip()
        if p.endswith((".cs", ".vue", ".js")) and "/" in p:
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


def generate_l2(config, check_only=False, force=False, module_filter=None):
    kb_dir = config["kb_dir"]
    l2_dir = kb_dir / "L2-modules"

    # Ensure L1 exists first (skip auto-generation in check mode)
    l1_path = kb_dir / "L1-overview.md"
    if not l1_path.exists():
        if check_only:
            safe_print("  [INFO] L1 不存在（check 模式下跳过自动生成）")
        else:
            safe_print("  [INFO] L1 不存在，先执行 L1 生成")
            if not generate_l1(config, check_only=False, force=force):
                return False

    # Scan and group files into modules
    groups = _build_l2_groups(config)
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
                # Manually edited file: never overwritten (decision F)
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

        # root_dirs = backend dirs + frontend dirs (consumed by phase-03 step-1.2)
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
        generated += 1

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
    lines = [
        "# L3 术语映射表 -- 代码命名反查",
        "",
        "> 本文件由 `scripts/gen-knowledge-base.py --level L3` 自动生成（方案B：代码反查）。",
        "> 仅含已实现代码中的术语映射，Spec 中规划但未编码的概念需人工补充。",
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
    safe_print(f"  [OK] L3 生成: {l3_path}"
               f"（业务术语 {len(biz_mapped)} 个, 技术模式 {len(tech_mapped)} 个, "
               f"待补充 {len(unmapped)} 个）")
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
    args = parser.parse_args()

    safe_print("=" * 60)
    safe_print("gen-knowledge-base.py -- L1/L2/L3 knowledge base generator")

    config = load_manifest()
    kb_dir = config["kb_dir"]
    safe_print(f"Project root: {PROJECT_ROOT}")
    safe_print(f"Output dir:  {kb_dir}")
    safe_print(f"Level: {args.level}, check={args.check}, force={args.force}")
    if args.module:
        safe_print(f"Module filter: {args.module}")
    safe_print("=" * 60)

    if args.check:
        safe_print("\n[CHECK MODE] 检查知识库现状：")
    else:
        safe_print("\n[GENERATE] 生成知识库：")

    level = args.level
    if level in ("L1", "all"):
        safe_print("\n--- L1: 项目模块总览 ---")
        generate_l1(config, check_only=args.check, force=args.force)
        if args.check:
            _report_module_dir_coverage(config)

    if level in ("L2", "all"):
        safe_print("\n--- L2: 模块级 Wiki ---")
        generate_l2(config, check_only=args.check, force=args.force,
                    module_filter=args.module)

    if level in ("L3", "all"):
        safe_print("\n--- L3: 术语映射表 ---")
        generate_l3(config, check_only=args.check, force=args.force)

    safe_print("\n" + "=" * 60)
    if args.check:
        safe_print("[CHECK] 检查完成。缺失/过时的文件可用以下命令刷新：")
        safe_print("  python scripts/gen-knowledge-base.py                    # 生成缺失的")
        safe_print("  python scripts/gen-knowledge-base.py --force            # 刷新过时的(auto-generated)")
        safe_print("  python scripts/gen-knowledge-base.py --level L2 --force --module Xxx  # 单模块刷新")
    else:
        safe_print("[DONE] 生成完成。")
        safe_print("  - 自动生成段可被 --force 覆盖刷新")
        safe_print("  - 人工编辑段（auto-generated: false）不会被覆盖")
        safe_print("  - 建议人工补充 L2 业务语义段 + L3 未映射术语")
    safe_print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
