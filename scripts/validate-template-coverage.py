#!/usr/bin/env python3
"""
方案 D'' 模板覆盖机制自动化验证脚本
用途：验证 startup-protocol.md 模板映射表、Few-Shot 场景、禁止事项的一致性
运行：python validate-template-coverage.py --skill-dir <path>
"""

import os, re, sys, argparse

# ─── ANSI 颜色 ────────────────────────────────────────────
class C:
    R = '\033[91m'; Y = '\033[93m'; G = '\033[92m'
    C = '\033[96m'; B = '\033[1m'; X = '\033[0m'
    @staticmethod
    def disable():
        for a in ('R','Y','G','C','B','X'):
            setattr(C, a, '')

PASS = f'{C.G}[PASS]{C.X}'
FAIL = f'{C.R}[FAIL]{C.X}'
WARN = f'{C.Y}[WARN]{C.X}'


class Result:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.passes = []
    def err(self, msg): self.errors.append(msg)
    def warn(self, msg): self.warnings.append(msg)
    def ok(self, msg): self.passes.append(msg)
    def summary(self):
        total = len(self.errors) + len(self.warnings) + len(self.passes)
        print(f"\n{C.B}{'='*60}{C.X}")
        print(f"{C.B}  Results: {total} checks | ERR:{len(self.errors)} WARN:{len(self.warnings)} OK:{len(self.passes)}{C.X}")
        print(f"{C.B}{'='*60}{C.X}\n")
        for e in self.errors: print(f"  {FAIL} {e}")
        for w in self.warnings: print(f"  {WARN} {w}")
        for p in self.passes: print(f"  {PASS} {p}")
        print()
        if self.errors:
            print(f"{C.R}FAILED: {len(self.errors)} error(s) to fix{C.X}")
            return 1
        elif self.warnings:
            print(f"{C.Y}PASSED with {len(self.warnings)} warning(s){C.X}")
            return 0
        else:
            print(f"{C.G}ALL PASSED!{C.X}")
            return 0


def _clean_name(s):
    """Strip backticks, whitespace from template name cell"""
    s = s.strip().strip('`').strip()
    return s

def _is_empty_cell(s):
    """Check if cell is empty or placeholder dash"""
    s = s.strip()
    if not s: return True
    # Various dash forms used as placeholders
    if s in ('\u2014', '\u2014\u2014', '---', '\u2015', '\u2500'): return True
    return False

def parse_mapping_table(content):
    """Parse mapping table, returns {template_name: {phase, type, ref}}"""
    m = re.search(r'### .*?模板文件名映射表.*?\n\n((?:\|.*\n)+)', content, re.DOTALL)
    if not m: return {}
    table = {}
    data_started = False
    for line in m.group(1).strip().split('\n'):
        if not line.startswith('|'): continue
        # skip separator row (|:--:|...|)
        if re.match(r'^\|[\s\-:｜]+\|', line):
            data_started = True
            continue
        if not data_started: continue  # skip header row
        cols = [c.strip() for c in line.split('|')[1:-1]]
        if len(cols) < 5: continue
        phase = cols[0].strip()
        ref = cols[4].strip() if len(cols) > 4 else ''
        # standard template (col 1)
        if cols[1] and not _is_empty_cell(cols[1]):
            table[_clean_name(cols[1])] = {'phase': phase, 'type': 'standard', 'ref': ref}
        # lite template (col 2)
        if len(cols) > 2 and cols[2] and not _is_empty_cell(cols[2]):
            table[_clean_name(cols[2])] = {'phase': phase, 'type': 'lite', 'ref': ref}
        # bug template (col 3)
        if len(cols) > 3 and cols[3] and not _is_empty_cell(cols[3]):
            table[_clean_name(cols[3])] = {'phase': phase, 'type': 'bug', 'ref': ref}
    return table


# ─── R1 ──────────────────────────────────────────────────
def r1_phase_no_hardcoded(skill_dir, r):
    """Phase files must NOT contain engine/templates/ hardcoded prefix"""
    eng = os.path.join(skill_dir, 'engine')
    for i in range(1, 8):
        fn = f'phase-{i:02d}.md'
        fp = os.path.join(eng, fn)
        if not os.path.isfile(fp):
            r.warn(f'R1: {fn} not found, skipped')
            continue
        content = open(fp, encoding='utf-8').read()
        if 'engine/templates/' in content:
            lines = [str(n+1) for n, l in enumerate(content.split('\n'))
                     if 'engine/templates/' in l]
            r.err(f'R1: {fn} has engine/templates/ prefix (lines: {", ".join(lines)})')
        else:
            r.ok(f'R1: {fn} clean')


# ─── R2 ──────────────────────────────────────────────────
def r2_mapping_files_exist(skill_dir, r):
    """Every template name in mapping table must exist in engine/templates/"""
    tmpl_dir = os.path.join(skill_dir, 'engine', 'templates')
    actual = set(os.listdir(tmpl_dir)) if os.path.isdir(tmpl_dir) else set()
    mapping = parse_mapping_table(
        open(os.path.join(skill_dir, 'engine', 'startup-protocol.md'), encoding='utf-8').read())
    if not mapping:
        r.err('R2: cannot parse mapping table')
        return
    for name, info in mapping.items():
        if name in actual:
            r.ok(f'R2: "{name}" (P{info["phase"]}/{info["type"]}) exists')
        elif name.lower() in {f.lower(): f for f in actual}:
            r.warn(f'R2: "{name}" case mismatch')
        else:
            r.err(f'R2: "{name}" (P{info["phase"]}/{info["type"]}) NOT in engine/templates/')


# ─── R3 ──────────────────────────────────────────────────
def r3_mapping_phase_ref(skill_dir, r):
    """Mapping table col 5 must not be empty or 'reserved'"""
    content = open(os.path.join(skill_dir, 'engine', 'startup-protocol.md'), encoding='utf-8').read()
    pat = re.search(r'### .*?模板文件名映射表.*?\n\n((?:\|.*\n)+)', content, re.DOTALL)
    if not pat: return
    for line in pat.group(1).strip().split('\n'):
        if not line.startswith('|'): continue
        if re.match(r'^\|[\s\-:｜]+\|', line): continue
        cols = [c.strip() for c in line.split('|')[1:-1]]
        if len(cols) < 5: continue
        phase = cols[0]
        ref = cols[4] if len(cols) > 4 else ''
        if not ref or ref in ('\u2014', '\u2014\u2014', '', '（预留）', '(预留)'):
            r.err(f'R3: P{phase} phase file ref missing/reserved')
        else:
            r.ok(f'R3: P{phase} -> {ref}')


# ─── R4 ──────────────────────────────────────────────────
def r4_prohibition_symmetric(skill_dir, r):
    """Prohibition rules must symmetrically cover project AND engine"""
    content = open(os.path.join(skill_dir, 'engine', 'startup-protocol.md'), encoding='utf-8').read()
    m = re.search(r'### 禁止事项\n(.*?)(?=\n(?:>|#|---|\Z))', content, re.DOTALL)
    if not m:
        r.err('R4: prohibition section not found')
        return
    p = m.group(1)
    # L317: phase files cannot have prefix
    if 'project/templates/' in p and 'engine/templates/' in p:
        r.ok('R4: L317 covers both project/ and engine/ prefixes')
    else:
        r.err('R4: L317 does not cover both project/ and engine/')
    # L318: read_file existence check
    if 'project' in p.lower() and 'engine' in p.lower() and 'list_files' in p.lower():
        r.ok('R4: L318 symmetric - both project and engine need list_files')
    else:
        r.err('R4: L318 not symmetric across project/engine')


# ─── R5 ──────────────────────────────────────────────────
def r5_fewshot_no_hardcoded(skill_dir, r):
    """Few-Shot must not have read_file(engine/templates/...) without list_files first"""
    content = open(os.path.join(skill_dir, 'engine', 'startup-protocol.md'), encoding='utf-8').read()
    m = re.search(r'### Few-Shot 执行示例.*?(?=\n### )', content, re.DOTALL)
    if not m:
        r.err('R5: Few-Shot section not found')
        return
    lines = m.group(0).split('\n')
    prev_list = False
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if 'list_files(' in s and 'engine/templates' in s:
            prev_list = True
        if 'read_file("engine/templates/' in s or "read_file('engine/templates/" in s:
            if not prev_list:
                r.err(f'R5: Few-Shot line {i} read_file(engine/templates/) without prior list_files')
            else:
                r.ok(f'R5: Few-Shot line {i} has list_files before read_file')
            prev_list = False
    # Also check: no direct read_file string inside code blocks that's standalone
    # Count all engine/templates read_file occurrences
    engine_reads = re.findall(r'read_file\(["\']engine/templates/', m.group(0))
    if not engine_reads:
        r.ok('R5: No engine/templates/ read_file in Few-Shot (all use list_files)')


# ─── W1 ──────────────────────────────────────────────────
def w1_phase_template_refs(skill_dir, r):
    """Each phase file should have template reference line"""
    eng = os.path.join(skill_dir, 'engine')
    for i in range(1, 8):
        fn = f'phase-{i:02d}.md'
        fp = os.path.join(eng, fn)
        if not os.path.isfile(fp):
            r.warn(f'W1: {fn} not found')
            continue
        content = open(fp, encoding='utf-8').read()
        has_ref = bool(re.search(
            r'(?:模板[：:]\s*[`"\']?phase-\d{2}-|phase-\d{2}-[^`"\']+\.md)', content))
        if has_ref:
            r.ok(f'W1: {fn} has template ref')
        else:
            r.warn(f'W1: {fn} missing template ref - Agent may not know which template to load')


# ─── W2 ──────────────────────────────────────────────────
def w2_unreferenced_files(skill_dir, r):
    """Check for unreferenced files in engine/templates/"""
    tmpl_dir = os.path.join(skill_dir, 'engine', 'templates')
    actual = set(os.listdir(tmpl_dir)) if os.path.isdir(tmpl_dir) else set()
    mapping = parse_mapping_table(
        open(os.path.join(skill_dir, 'engine', 'startup-protocol.md'), encoding='utf-8').read())
    referenced = set(mapping.keys())
    unreferenced = actual - referenced
    known = {
        'cold-start-gate-nucleus.md',
        'project-lessons-learned.example.md',
        'review-models.example.json',
    }
    for f in sorted(unreferenced):
        if f in known:
            r.ok(f'W2: {f} (known non-template)')
        else:
            r.warn(f'W2: {f} unreferenced in mapping table')


# ─── W3 ──────────────────────────────────────────────────
def w3_skill_md(skill_dir, r):
    """SKILL.md template path line should route to startup protocol"""
    fp = os.path.join(skill_dir, 'SKILL.md')
    if not os.path.isfile(fp):
        r.warn('W3: SKILL.md not found')
        return
    content = open(fp, encoding='utf-8').read()
    m = re.search(r'模板路径[：:]', content)
    if not m:
        r.warn('W3: SKILL.md has no template path line')
        return
    line_start = content.rfind('\n', 0, m.start()) + 1
    line_end = content.find('\n', m.end())
    line = content[line_start:line_end]
    if 'engine/templates/' in line and '\u00a7' not in line:
        r.warn('W3: SKILL.md template path hardcodes engine/templates/')
    elif '\u00a7\u6a21\u677f\u89e3\u6790\u4f18\u5148\u7ea7' in line or '\u542f\u52a8\u534f\u8bae' in line:
        r.ok('W3: SKILL.md routes to startup protocol')
    else:
        r.warn('W3: SKILL.md template path ambiguous')


# ─── W4 ──────────────────────────────────────────────────
def w4_fallback_chain(skill_dir, r):
    """Few-Shot section must cover project -> engine fallback for all scenes"""
    content = open(os.path.join(skill_dir, 'engine', 'startup-protocol.md'), encoding='utf-8').read()
    m = re.search(r'### Few-Shot 执行示例.*?(?=\n### )', content, re.DOTALL)
    if not m:
        r.err('W4: Few-Shot section not found')
        return
    fewshot = m.group(0)
    # Count occurrences of list_files patterns
    lp_count = fewshot.count('list_files("project/templates/')
    le_count = fewshot.count('list_files("engine/templates/')
    # Also check with single quotes
    lp_count += fewshot.count("list_files('project/templates/")
    le_count += fewshot.count("list_files('engine/templates/")
    # Scene A only needs project (valid template path)
    # Scenes B/C/D need both project + engine (fallback path)
    # Expected: at least 3 project + at least 2 engine occurrences
    if lp_count >= 3 and le_count >= 2:
        r.ok(f'W4: Few-Shot has project list_files x{lp_count}, engine list_files x{le_count}')
    else:
        if lp_count < 3:
            r.warn(f'W4: Few-Shot project list_files x{lp_count} (expected >=3)')
        if le_count < 2:
            r.warn(f'W4: Few-Shot engine list_files x{le_count} (expected >=2)')


# ─── W5 ──────────────────────────────────────────────────
def w5_unified_pattern(skill_dir, r):
    """Verify unified list_files-first pattern"""
    content = open(os.path.join(skill_dir, 'engine', 'startup-protocol.md'), encoding='utf-8').read()
    if '所有场景均先' in content and 'list_files' in content:
        r.ok('W5: unified list_files-first guidance present')
    else:
        r.err('W5: missing unified list_files guidance')
    if '禁止自行拼接' in content:
        r.ok('W5: "no prefix concatenation" constraint present')
    else:
        r.warn('W5: missing "no prefix concatenation" constraint')


# ─── Main ────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description='Validate D\'\' template coverage mechanism')
    ap.add_argument('--skill-dir', required=True, help='iteration-workflow skill root dir')
    ap.add_argument('--no-color', action='store_true')
    args = ap.parse_args()
    if args.no_color:
        C.disable()

    sd = args.skill_dir
    if not os.path.isdir(sd):
        print(f"{FAIL} Directory not found: {sd}")
        sys.exit(2)

    print(f"\n{C.B}{'='*60}{C.X}")
    print(f"{C.B}  D'' Template Coverage Validator{C.X}")
    print(f"{C.B}  Skill Dir: {sd}{C.X}")
    print(f"{C.B}{'='*60}{C.X}\n")

    r = Result()

    print(f"{C.C}--- Critical Checks (R1-R5) ---{C.X}")
    r1_phase_no_hardcoded(sd, r)
    r2_mapping_files_exist(sd, r)
    r3_mapping_phase_ref(sd, r)
    r4_prohibition_symmetric(sd, r)
    r5_fewshot_no_hardcoded(sd, r)

    print(f"\n{C.C}--- Warning Checks (W1-W5) ---{C.X}")
    w1_phase_template_refs(sd, r)
    w2_unreferenced_files(sd, r)
    w3_skill_md(sd, r)
    w4_fallback_chain(sd, r)
    w5_unified_pattern(sd, r)

    sys.exit(r.summary())


if __name__ == '__main__':
    main()
