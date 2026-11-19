#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""validate-artifacts.py — 阶段产物「内容合同」校验（M1 · 2026-11-19）

为什么需要它：`doc_lint.py` 只查版式（D1~D15），查不出「产物只是个空骨架」——
标题齐全但正文空、模板占位符原样留着、把上一迭代的报告复制过来充数，三类都能过版式自检。
本脚本补的正是这三类判据，合同本身声明在 `engine/templates/manifest.json`（唯一事实源）。

判据（按顺序，全部为 ERROR）:
  ① missing     声明的产物文件不存在（仅在**显式指定 --phase** 时判；全量巡检降为 SKIP）
  ② no-concept  合同要求的某个内容概念没有任何 2~4 级标题命中
  ③ empty       概念章节正文有效字符 < MIN_BODY_CHARS（标题齐全但没写）
  ④ placeholder 概念章节扣掉占位行后有效字符 < MIN_BODY_CHARS（整节只剩模板占位）
  ⑤ leftover    文件内残留 `{{占位符}}`（模板注入残留；正则复用 inject-template.py）
  ⑥ reuse       文件内容 sha256 与**其他迭代**目录内某文件完全相同（复制旧产物充数）

tier 口径（★ 与 complexity 对齐，不另建一套）:
  🟢 简单 ⇒ lite 档概念（首版只留「结论摘要」类最低要求）
  🟡 / 🔴 ⇒ full 档概念
  `--tier full|lite` 可强制；`--tier auto`（缺省）读 state.yaml 的 complexity。

用法:
  python scripts/validate-artifacts.py --phase 07 --root .
  python scripts/validate-artifacts.py --phase 07 --iteration 2026-11-17-002-知识库全量化 --root .
  python scripts/validate-artifacts.py --root . --json        # 全量巡检（缺失不判红）
  python scripts/validate-artifacts.py --phase 07 --allow-reuse   # 逃生口：跳过 reuse 判据

退出码: 0 = 无 ERROR（SKIP/WARN 不算失败）；1 = 存在 ERROR；2 = 环境/参数错误。
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

SELF = os.path.abspath(__file__)
SCRIPTS = os.path.dirname(SELF)
SKILL = os.path.dirname(SCRIPTS)
DEFAULT_MANIFEST = os.path.join(SKILL, 'engine', 'templates', 'manifest.json')

MIN_BODY_CHARS = 10          # 章节正文有效字符下限（只拦"基本没写"，不评价写得好不好）
MIN_FINDING_TRUNC = 8        # 每文件最多打印的 ERROR 条数
REUSE_MIN_BYTES = 200        # 小于该体积不参与跨迭代复用比对（空骨架/占位文件不具区分性）
CONCEPT_HEAD_LEVELS = (2, 3, 4)

HEAD_RE = re.compile(r'^(#{1,6})\s+(.+?)\s*$')
FENCE_RE = re.compile(r'^\s*(?:```|~~~)')
TABLE_SEP_RE = re.compile(r'^\s*\|[\s:\-|]+\|\s*$')
PLACEHOLDER_RES = (
    re.compile(r'\{\{[^{}\n]*\}\}'),                       # {{KEY}} 注入残留
    re.compile(r'^\s*[-*+]?\s*\{[^{}\n]{1,60}\}\s*$'),     # 整行只剩 {中文占位}
    re.compile(r'\bYYYY[-/]MM[-/]DD\b'),                   # 日期占位
    re.compile(r'\b(?:TODO|TBD|FIXME)\b'),
    re.compile(r'待补充|待填写|待完善|待补全'),
)
# 兜底正则：仅在 inject-template.py 不可用时使用（失败降级，不阻断主判据）
FALLBACK_PLACEHOLDER_RE = re.compile(r'\{\{([A-Za-z0-9_]+(?:[\._-][A-Za-z0-9_]+)*)\}\}')


# ── 基础工具 ───────────────────────────────────────────────
def say(msg=''):
    print(msg)


def read_lines(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        return fh.read().split('\n')


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def load_placeholder_re():
    """复用 `inject-template.py` 的占位符正则（★ 不另抄一份口径）。

    fail-open：加载失败只 WARN —— 「占位残留」是附加判据，不能因为它挂掉就让内容合同整体失效。
    """
    path = os.path.join(SCRIPTS, 'inject-template.py')
    try:
        spec = importlib.util.spec_from_file_location('inject_template', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.PLACEHOLDER_RE, ''
    except Exception as exc:                                  # noqa: BLE001
        return FALLBACK_PLACEHOLDER_RE, 'inject-template.py 不可用（%s）⇒ 占位残留用兜底正则' % exc


def load_manifest(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return json.loads(fh.read().lstrip('\ufeff'))


# ── 迭代目录 / tier 解析 ───────────────────────────────────
def find_active_iteration(root):
    """双宿主探测 ACTIVE 第一行；取不到返回 ''。"""
    for ide in ('codebuddy', 'claude'):
        p = os.path.join(root, '.' + ide, 'skills', 'iteration-workflow', 'runtime', 'ACTIVE')
        if not os.path.isfile(p):
            continue
        try:
            with open(p, 'r', encoding='utf-8', errors='replace') as fh:
                first = (fh.readline() or '').strip()
        except OSError:
            continue
        if first and first.lower() != 'none':
            return first
    return ''


def state_path_of(root, iteration):
    """探测 state（★ 含归档重命名后的形态：`<id>.state.archived.yaml`）—— 归档迭代也要能判 tier。"""
    for ide in ('codebuddy', 'claude'):
        base = os.path.join(root, '.' + ide, 'skills', 'iteration-workflow', 'runtime')
        for suffix in ('.state.yaml', '.state.archived.yaml', '.state.yaml.bak'):
            p = os.path.join(base, iteration + suffix)
            if os.path.isfile(p):
                return p
    return ''


def read_complexity(root, iteration):
    p = state_path_of(root, iteration)
    if not p:
        return ''
    try:
        for ln in read_lines(p):
            if ln.startswith('complexity:'):
                return ln.split(':', 1)[1].strip().strip('"').strip("'")
    except OSError:
        return ''
    return ''


def tier_of(complexity):
    """🟢 ⇒ lite；其余（含未知）⇒ full（宁严不松：复杂迭代漏判的代价高于轻量迭代误拦）。"""
    return 'lite' if '🟢' in (complexity or '') else 'full'


def resolve_iter_dir(root, iterations_dir, iteration):
    """`--iteration` 可给 ID 或直接给目录路径。返回 (绝对路径, 迭代ID, 错误说明)。"""
    cand = iteration or ''
    if cand and os.path.isdir(cand):
        return os.path.abspath(cand), os.path.basename(os.path.abspath(cand).rstrip('\\/')), ''
    if not cand:
        cand = find_active_iteration(root)
        if not cand:
            return '', '', '未指定 --iteration 且两侧 ACTIVE 均无活跃迭代'
    d = os.path.join(root, iterations_dir, cand)
    if not os.path.isdir(d):
        return '', cand, '迭代目录不存在: %s' % d
    return os.path.abspath(d), cand, ''


# ── 产物定位 ───────────────────────────────────────────────
def phase_dir_candidates(iter_dir, art):
    """返回该产物可能落入的子目录（按 dir_prefix 前缀匹配目录名）。"""
    prefix = (art.get('dir_prefix') or '').strip()
    out = []
    try:
        names = sorted(os.listdir(iter_dir))
    except OSError:
        return out
    for nm in names:
        p = os.path.join(iter_dir, nm)
        if not os.path.isdir(p):
            continue
        if not prefix or nm.startswith(prefix):
            out.append(p)
    return out


def find_artifact_files(iter_dir, art):
    """按 filenames 精确匹配 basename；dir_prefix 限定子目录。返回绝对路径列表（已排序）。"""
    names = set(art.get('filenames') or [])
    hits = []
    for d in phase_dir_candidates(iter_dir, art):
        for dirpath, _dirs, files in os.walk(d):
            for fn in files:
                if fn in names:
                    hits.append(os.path.join(dirpath, fn))
    return sorted(hits)


def collect_phase_files(iter_dir, art):
    """该阶段目录下**全部** .md（含合同外的产物，如 04-代码审查报告）—— baseline 用。"""
    out = []
    for d in phase_dir_candidates(iter_dir, art):
        for dirpath, _dirs, files in os.walk(d):
            for fn in files:
                if fn.lower().endswith('.md'):
                    out.append(os.path.join(dirpath, fn))
    return sorted(out)


# ── 内容合同判据 ───────────────────────────────────────────
def iter_headings(lines):
    """产出 (行号, 级别, 标题文本)；跳过代码围栏内（围栏里的 `#` 是注释不是标题）。"""
    in_code = False
    for idx, ln in enumerate(lines):
        if FENCE_RE.match(ln):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = HEAD_RE.match(ln)
        if m:
            yield idx, len(m.group(1)), m.group(2)


def concept_hit(concepts, index):
    """按概念序号检索命中标题：返回 (行号, 级别) 或 None。match 任一子串命中即算（不区分大小写）。"""
    needles = [s.lower() for s in (index['match'] or []) if s]
    if not needles:
        return None
    for idx, lvl, text in index['heads']:
        if lvl not in CONCEPT_HEAD_LEVELS:
            continue
        low = text.lower()
        if any(n in low for n in needles):
            return idx, lvl
    return None


def section_stats(lines, start, level):
    """统计 (有效字符数, 占位字符数)。区间 = 下一个同级或更高级标题之前。"""
    chars = 0
    ph_chars = 0
    for idx in range(start + 1, len(lines)):
        ln = lines[idx]
        m = HEAD_RE.match(ln)
        if m and len(m.group(1)) <= level:
            break
        s = ln.strip()
        if not s or s in ('---', '***'):
            continue
        if TABLE_SEP_RE.match(s):
            continue
        n = len(re.sub(r'\s', '', s))
        chars += n
        if any(r.search(s) for r in PLACEHOLDER_RES):
            ph_chars += n
    return chars, ph_chars


def check_file(path, concepts, placeholder_re):
    """返回 findings 列表（level/code/msg）。concepts 为空 ⇒ 该档不校验。"""
    findings = []
    try:
        lines = read_lines(path)
    except OSError as exc:
        return [{'level': 'ERROR', 'code': 'unreadable', 'msg': '读取失败: %s' % exc}]

    # ⑤ 模板占位残留（全文；★ 跳过行内代码与代码围栏 —— 产物里讨论「某个占位符」是合法内容，
    #    实测 002 的 04 有 4 处 `{{MODULE_TABLE_HEADER}}` 是在描述待改造项，不是模板残留）
    in_code = False
    for idx, ln in enumerate(lines, 1):
        if FENCE_RE.match(ln):
            in_code = not in_code
            continue
        if in_code:
            continue
        bare = re.sub(r'`[^`]*`', '', ln)
        for m in placeholder_re.finditer(bare):
            findings.append({'level': 'ERROR', 'code': 'leftover',
                             'msg': 'L%d 残留模板占位符 {{%s}}（正文裸出现，非行内代码示例）'
                                    % (idx, m.group(1))})
            break

    if not concepts:
        return findings

    heads = list(iter_headings(lines))
    for c in concepts:
        name = c.get('name') or ''
        hit = concept_hit([c], {'heads': heads, 'match': c.get('match') or [name]})
        if hit is None:
            findings.append({'level': 'ERROR', 'code': 'no-concept',
                             'msg': '缺内容概念「%s」（2~4 级标题需含：%s）'
                                    % (name, ' / '.join(c.get('match') or [name]))})
            continue
        start, level = hit
        chars, ph = section_stats(lines, start, level)
        if chars < MIN_BODY_CHARS:
            findings.append({'level': 'ERROR', 'code': 'empty',
                             'msg': '「%s」章节正文过短（有效 %d 字符 < %d）—— 标题有了但没写'
                                    % (name, chars, MIN_BODY_CHARS)})
        elif chars - ph < MIN_BODY_CHARS:
            findings.append({'level': 'ERROR', 'code': 'placeholder',
                             'msg': '「%s」章节只剩占位内容（有效 %d 字符，其中占位 %d）'
                                    % (name, chars - ph, ph)})
    return findings


# ── ⑥ 跨迭代复用检测 ───────────────────────────────────────
def build_other_index(iter_root, current_dir, targets):
    """更早的迭代目录内、体积与目标候选相同的 .md ⇒ sha256 → [相对路径]。

    先按 size 预筛再算 hash：迭代多的大项目也不必全量读盘。
    ★ 只收**早于当前迭代**的目录（按目录名字典序，`YYYY-MM-DD-NNN-名称` 天然可比）：
      否则同一个重复内容会被两边互指（老迭代也报"复制了新的"），把判据变成噪声。
    """
    sizes = set(os.path.getsize(t) for t in targets)
    index = {}
    if not os.path.isdir(iter_root):
        return index
    cur = os.path.abspath(current_dir)
    cur_name = os.path.basename(cur.rstrip('\\/'))
    for name in sorted(os.listdir(iter_root)):
        d = os.path.join(iter_root, name)
        if not os.path.isdir(d) or os.path.abspath(d) == cur:
            continue
        if name >= cur_name:            # 同代或更新的迭代不参与（无法判定谁抄谁）
            continue
        for dirpath, _dirs, files in os.walk(d):
            for fn in sorted(files):
                if not fn.lower().endswith('.md'):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    if os.path.getsize(p) < REUSE_MIN_BYTES or os.path.getsize(p) not in sizes:
                        continue
                    index.setdefault(sha256_of(p), []).append(
                        os.path.relpath(p, iter_root).replace('\\', '/'))
                except OSError:
                    continue
    return index


def check_reuse(paths, iter_root, iter_dir):
    findings = []
    targets = [p for p in paths if os.path.getsize(p) >= REUSE_MIN_BYTES]
    if not targets:
        return findings
    index = build_other_index(iter_root, iter_dir, targets)
    for p in targets:
        try:
            sha = sha256_of(p)
        except OSError:
            continue
        if sha in index:
            findings.append({'level': 'ERROR', 'code': 'reuse', 'file': p,
                             'msg': '内容与更早迭代的产物完全相同（%s）—— 复制旧报告充数需重写'
                                    % index[sha][0]})
    return findings


# ── 主流程 ─────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description='阶段产物内容合同校验（SSOT: engine/templates/manifest.json）')
    ap.add_argument('--phase', action='append', default=[],
                    help='阶段号（01~07，可重复或逗号分隔）；缺省 = 全量巡检（缺失产物只 SKIP）')
    ap.add_argument('--root', default='.', help='项目根（默认当前目录）')
    ap.add_argument('--iteration', default='', help='迭代 ID 或迭代目录绝对路径（缺省取两侧 ACTIVE）')
    ap.add_argument('--iterations-dir', default='', help='迭代文档目录（缺省取 manifest / docs/iterations）')
    ap.add_argument('--manifest', default=DEFAULT_MANIFEST, help='内容合同路径')
    ap.add_argument('--tier', choices=('auto', 'full', 'lite'), default='auto',
                    help='概念档位（auto = 按 state.yaml 的 complexity 判定）')
    ap.add_argument('--allow-reuse', action='store_true', help='跳过跨迭代复用判据（逃生口）')
    ap.add_argument('--json', action='store_true', help='机器可读输出')
    args = ap.parse_args()

    # --phase 支持 "07" / "07,08" / 多次 --phase
    phases = set()
    for raw in args.phase:
        for part in str(raw).split(','):
            part = part.strip()
            if part:
                phases.add(part if len(part) == 2 else part.zfill(2))

    if not os.path.isfile(args.manifest):
        say('[ERROR] 内容合同不存在: %s' % args.manifest)
        return 2
    try:
        manifest = load_manifest(args.manifest)
    except Exception as exc:                                  # noqa: BLE001
        say('[ERROR] 内容合同解析失败: %s（%s）' % (args.manifest, exc))
        return 2

    root = os.path.abspath(args.root)
    iterations_dir = (args.iterations_dir
                      or manifest.get('docs_iterations_default')
                      or 'docs/iterations').strip().strip('/')
    iter_dir, iter_id, err = resolve_iter_dir(root, iterations_dir, args.iteration)
    if err:
        say('[ERROR] ' + err)
        return 2

    complexity = read_complexity(root, iter_id)
    tier = args.tier if args.tier != 'auto' else tier_of(complexity)
    placeholder_re, ph_note = load_placeholder_re()
    if ph_note:
        say('[WARN] ' + ph_note)

    iter_root = os.path.dirname(iter_dir)
    explicit = bool(phases)
    report = {'iteration': iter_id, 'iteration_dir': iter_dir.replace('\\', '/'),
              'complexity': complexity, 'tier': tier, 'phases': sorted(phases),
              'files': [], 'summary': {'error': 0, 'skipped': 0, 'files': 0}}

    say('=== 产物内容合同校验 · %s · tier=%s%s ===' % (
        iter_id, tier,
        (' (complexity=%s)' % complexity) if complexity else ' (state 未找到 complexity)'))
    say('合同: %s' % os.path.basename(args.manifest))

    checked_paths = []
    for art in manifest.get('artifacts') or []:
        ph = str(art.get('phase') or '')
        if explicit and ph not in phases:
            continue
        concepts = (art.get('content_concepts') or {}).get(tier) or []
        files = find_artifact_files(iter_dir, art)
        if not files:
            lvl = 'ERROR' if explicit else 'SKIP'
            msg = '未找到产物文件（%s）' % ' / '.join(art.get('filenames') or [])
            report['files'].append({'phase': ph, 'artifact': art.get('id'), 'path': '',
                                    'status': 'missing', 'findings': [
                                        {'level': lvl, 'code': 'missing', 'msg': msg}]})
            if lvl == 'ERROR':
                report['summary']['error'] += 1
                say('[ERROR] %s  %s' % (art.get('id'), msg))
            else:
                report['summary']['skipped'] += 1
                say('[SKIP ] %s  %s' % (art.get('id'), msg))
            continue

        for path in files:
            findings = check_file(path, concepts, placeholder_re)
            if not args.allow_reuse:
                findings += check_reuse([path], iter_root, iter_dir)
            checked_paths.append(path)
            n_err = len([f for f in findings if f['level'] == 'ERROR'])
            report['summary']['files'] += 1
            report['summary']['error'] += n_err
            rel = os.path.relpath(path, root).replace('\\', '/')
            report['files'].append({
                'phase': ph, 'artifact': art.get('id'), 'path': rel,
                'status': 'error' if n_err else 'ok',
                'findings': findings,
            })
            if not findings:
                say('[OK]    %s  %d 个概念全部命中' % (rel, len(concepts)))
            else:
                say('[ERROR] %s  %d 项未过' % (rel, n_err))
                for f in findings[:MIN_FINDING_TRUNC]:
                    say('         · [%s] %s' % (f['code'], f['msg']))
                if len(findings) > MIN_FINDING_TRUNC:
                    say('         · …另有 %d 项' % (len(findings) - MIN_FINDING_TRUNC))

    say('-' * 58)
    say('文件 %d 个 ｜ ERROR %d ｜ SKIP %d ｜ tier=%s'
        % (report['summary']['files'], report['summary']['error'],
           report['summary']['skipped'], tier))
    if report['summary']['error']:
        say('内容合同未通过（SSOT: engine/templates/manifest.json）⇒ 不得归档/推进')
    if args.json:
        say(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report['summary']['error'] else 0


if __name__ == '__main__':
    sys.exit(main())
