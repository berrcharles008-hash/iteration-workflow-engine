#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""迭代文档版式自检（Doc Lint）

规则 SSOT: engine/domain/doc-style-guide.md（十五条硬规则 D1~D15；D9~D13 早于 D14/D15 实现，
          2026-11-16 一并补登记 —— 此前 RULES 只到 D8，新规则同等"游离在元组外"）

用法:
    python scripts/doc_lint.py <文件或目录> [...]
    python scripts/doc_lint.py -q docs/iterations/2026-09-16-001-药品字典收口
    python scripts/doc_lint.py --json <文件>

豁免（单规则，写在文档任意位置）:
    <!-- doc-lint: allow D1 -->
    <!-- doc-lint: allow D1,D3 -->

退出码: 0 = 无 ERROR；1 = 存在 ERROR（必须修复）
"""

import argparse
import json
import os
import re
import sys

try:  # Windows 控制台中文/符号输出兜底
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ── 阈值（与 doc-style-guide.md §二 保持一致）──────────────
CELL_WARN, CELL_ERR = 60, 200          # D1 表格单元格字符数
LINE_WARN, LINE_ERR = 120, 300         # D2 正文单行字符数
BOLD_MIN_RATIO = 1 / 10                # D3 粗体密度上限（1 : 10 行）
CODE_WARN, CODE_ERR = 40, 80           # D5 单个代码块行数
MAX_COLS = 6                           # D6 表格列数
META_HEAD_LINES = 12                   # D7 文档头元信息块扫描范围
SUMMARY_HEAD_LINES = 60                # D8 结论摘要所在范围
TOC_MIN_LINES = 200                    # D9 超过该行数须有目录
TOC_SCAN_LINES = 80                    # D9 目录须出现在前 N 行

MERMAID_KINDS = {                      # D12 已知 Mermaid 图表类型
    'flowchart', 'graph', 'sequencediagram', 'classdiagram', 'statediagram',
    'erdiagram', 'gantt', 'pie', 'journey', 'gitgraph', 'mindmap', 'timeline',
    'quadrantchart', 'xychart-beta', 'block-beta', 'sankey-beta',
    'requirementdiagram', 'c4context',
}

# ── 字符类 ────────────────────────────────────────────────
FENCE_RE = re.compile(r'^\s*(?:```|~~~)')
TABLE_ROW_RE = re.compile(r'^\s*\|')
BOLD_RE = re.compile(r'\*\*[^*\n]+\*\*')
# ★ 只检测彩色 emoji（astral 区 U+1F000~U+1FAFF）；★☆⚡ 等装饰符号不计入 D4
EMOJI_RE = re.compile('[\U0001F000-\U0001FAFF]')
EMOJI_ALLOW = set('✅⬜⏳⚠❌🔴🟡🟢🔵\ufe0f\u200d')
SEP_CELL_RE = re.compile(r'^[:\-\s]+$')
ALLOW_RE = re.compile(r'<!--\s*doc-lint:\s*allow\s*([\dD,\s]+?)\s*-->')
LINK_TARGET_RE = re.compile(r'\]\(([^)\s]+)\)')            # D10 相对链接目标
FN_REF_RE = re.compile(r'\[\^([^\]]+)\](?!:)')              # D11 脚注引用
FN_DEF_RE = re.compile(r'^\s*\[\^([^\]]+)\]:', re.M)        # D11 脚注定义
ASCII_ART_RE = re.compile('[\u2500-\u257F\u2190-\u21FF\u25B2\u25BC\u21C4]')   # D13 制表符/箭头图

RULES = ('D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8',
         'D9', 'D10', 'D11', 'D12', 'D13', 'D14', 'D15')


class Finding(object):
    def __init__(self, level, rule, line, msg):
        self.level = level
        self.rule = rule
        self.line = line
        self.msg = msg

    def as_dict(self):
        return {'level': self.level, 'rule': self.rule, 'line': self.line, 'msg': self.msg}


LINK_RE = re.compile(r'\[([^\]]*)\]\([^)]*\)')


def split_cells(line):
    return [c.strip() for c in line.strip().strip('|').split('|')]


def strip_links(s):
    """单元格长度按"显示文本"计：Markdown 链接去掉 URL 部分。"""
    return LINK_RE.sub(r'\1', s)


# ── 迭代目录（G09 · 2026-10-25 迭代 2026-10-25-002）─────────────────────────
# 判定基准不再写死 `'/iterations/'`：三级取值
#   ① `--iterations-dir <rel>`  ② manifest `paths.docs_iterations`  ③ 缺省 `docs/iterations`
# 失效形态（旧实现）：manifest 把迭代目录改名后，自检仍只认 `docs/iterations`
#   ⇒ 新目录下的文档**零检查**（假绿），偏偏那是最该被检查的产物。
DEFAULT_ITERATIONS_DIR = 'docs/iterations'
ITER_DIR_MARKERS = ('/' + DEFAULT_ITERATIONS_DIR + '/',)


def _iter_marker(rel):
    """把相对目录归一为 `/<dir>/`（小写）—— 用于「路径是否落在迭代目录内」的包含判定。"""
    r = str(rel or '').strip().replace('\\', '/').strip('/')
    return '/' + r.lower() + '/' if r else ''


def resolve_iterations_dir(cli_value=None):
    """解析迭代目录并**重设**模块级 `ITER_DIR_MARKERS`；返回 `(dir, source)`。

    **永不抛**：manifest 不可读 / 抽键为空 / 归一后为空 ⇒ 回落缺省并打印 1 行 INFO。
    """
    global ITER_DIR_MARKERS
    chosen, source = '', 'cli'
    if cli_value:
        chosen = str(cli_value)
    else:
        source = 'manifest'
        try:
            import project_config
            cfg = project_config.read_scalars('project/project.manifest.yaml')
            chosen = (cfg.get('paths.docs_iterations') or '').strip()
        except Exception:
            chosen = ''
        if not chosen:
            source = 'default'
            print('[INFO] iterations-dir fallback=%s' % DEFAULT_ITERATIONS_DIR)
    marker = _iter_marker(chosen)
    if not marker:
        source = 'default'
        chosen = DEFAULT_ITERATIONS_DIR
        marker = _iter_marker(chosen)
        print('[INFO] iterations-dir fallback=%s' % DEFAULT_ITERATIONS_DIR)
    ITER_DIR_MARKERS = (marker,)
    return chosen, source


def is_produced_doc(path):
    """D10/D11 只检查真实产出文档（迭代文档目录）——模板与规范中的示例链接/脚注不适用。"""
    p = path.replace('\\', '/').lower()
    return any(m in p for m in ITER_DIR_MARKERS)


def is_iter_doc(path):
    """D3/D7/D8 只对迭代文档生效（引擎说明文件、示例文件不适用）。"""
    p = path.replace('\\', '/').lower()
    nm = os.path.basename(p)
    if nm.endswith('.example.md') or nm.startswith('cold-start'):
        return False
    return (any(m in p for m in ITER_DIR_MARKERS)
            or nm.startswith('phase-0') or nm.startswith('bug-requirement'))


def is_separator_row(cells):
    return bool(cells) and all((not c) or SEP_CELL_RE.match(c) for c in cells)


# ── D14/D15 验收断言（★ 2026-11-16 VERIF2 · 03 §2.4-E）───────────────────
# 为什么独立成函数而不并进 check_file 的行循环：
#   check_file 的行循环是「单行无状态」的（只有围栏状态），而 D14/D15 需要
#   ① 小节归属（heading 栈）；② 同迭代**跨文件**比对（05 的 AC-n ↔ 03 的验收断言小节）。
AC_RULE_FROM = '2026-11-16'      # 迭代目录日期前缀早于该日 ⇒ 整条规则 SKIP（存量 95 份豁免）
AC_TOKEN_RE = re.compile(r'AC-\d+')
AC_HEAD_RE = re.compile(r'^#{2,4}\s')
AC_SECTION_KEY = '验收断言'
AC_ITER_DIR_RE = re.compile(r'^\d{4}-\d{2}-\d{2}-')      # 迭代目录名形态


def _norm_iter_path(path):
    """归一为 `/x/y/` 形态，使相对路径与绝对路径都能命中 ITER_DIR_MARKERS。"""
    return '/' + path.replace('\\', '/').strip('/')


def _iter_date_prefix(path):
    """从路径里取 `docs/iterations/<YYYY-MM-DD>-.../` 的日期前缀（取不到返回 ''）。"""
    m = re.search(r'/(\d{4}-\d{2}-\d{2})-', _norm_iter_path(path) + '/')
    return m.group(1) if m else ''


def _iter_dir_of(path):
    """上溯到迭代目录（`docs/iterations/<迭代ID>`）；不在迭代目录内返回 ''。

    ★ 判据是**目录名本身**以日期开头，不能对整条路径做 `/(\\d{4}-\\d{2}-\\d{2})-` 搜索 ——
      后者的迭代段在祖先路径里恒命中，会让 `…/<迭代ID>/03-技术方案` 自己就被当成迭代目录
      （实测 2026-11-16：D14 因此把 03 主文档判成"缺小节"）。
    """
    d = os.path.dirname(os.path.abspath(path)).replace('\\', '/')
    while d:
        if AC_ITER_DIR_RE.match(os.path.basename(d)):
            return d
        nd = os.path.dirname(d)
        if nd == d:
            return ''
        d = nd
    return ''


def _find_iter_doc(iter_dir, prefix, hint):
    """在迭代目录的 `<prefix>*` 子目录里找 .md：优先文件名含 `hint` 的，否则取第一个。

    ★ 为什么必须给 hint：`03-技术方案/` 里通常还有 `03-启动交接卡.md`，按字典序
      「启」(U+542F) < 「技」(U+6280) ⇒ 不给 hint 会拿到交接卡，D14 判错文件。
    """
    try:
        subs = sorted(os.listdir(iter_dir))
    except OSError:
        return ''
    for s in subs:
        sp = os.path.join(iter_dir, s)
        if not s.startswith(prefix) or not os.path.isdir(sp):
            continue
        try:
            names = sorted(n for n in os.listdir(sp) if n.lower().endswith('.md'))
        except OSError:
            continue
        for fn in names:
            if hint in fn:
                return os.path.join(sp, fn)
        if names:
            return os.path.join(sp, names[0])
    return ''


def _scan_ac(path):
    """返回 (验收断言小节内 AC 表格数据行数, 小节内 AC 集合, 全文 AC 集合, 是否有该小节)。

    ★ 不用全文子串判小节（VERIF2 四件套 L-5）：`'## 验收断言' in text` 会被目录里那行
      `- [5. 验收断言](#5-验收断言ac-表)` 命中 ⇒ D14 恒绿。故必须围栏跳过 + heading 栈 +
      表格数据行复用 `TABLE_ROW_RE` / `is_separator_row` / `split_cells`。
    """
    rows, sec_tok, all_tok, has_sec = 0, set(), set(), False
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            lines = fh.read().split('\n')
    except OSError:
        return rows, sec_tok, all_tok, has_sec
    in_ac = in_code = False
    for ln in lines:
        if FENCE_RE.match(ln):
            in_code = not in_code
            continue
        if in_code:
            continue
        toks = AC_TOKEN_RE.findall(ln)
        all_tok.update(toks)
        if in_ac:
            sec_tok.update(toks)
        if AC_HEAD_RE.match(ln):
            in_ac = AC_SECTION_KEY in ln.lstrip('#').strip()
            if in_ac:
                has_sec = True
            continue
        if in_ac and TABLE_ROW_RE.match(ln):
            cells = split_cells(ln)
            if (not is_separator_row(cells)) and toks:
                rows += 1
    return rows, sec_tok, all_tok, has_sec


def check_ac_rules(path):
    """D14（03 侧）/ D15（05 侧）；返回 Finding 列表。

    ★ 只对「真实产出文档」生效 —— 复用 `is_produced_doc` 而不是 `is_iter_doc`：后者会把
      `engine/templates/phase-0*.md` 模板一并纳入（模板里本来就没有验收断言数据行）。
    ★ 存量豁免：迭代目录日期 < `AC_RULE_FROM` ⇒ 整条不判（95 份历史 03 不受影响）。
    ★ D15 不设「05 必须引用」：05 完全不写 AC 引用只 WARN，设 ERROR 会逼出凑数写法。
    """
    out = []
    if not is_produced_doc(_norm_iter_path(path)):
        return out
    d = _iter_date_prefix(path)
    if not d or d < AC_RULE_FROM:
        return out
    iter_dir = _iter_dir_of(path)
    if not iter_dir:
        return out
    doc03 = _find_iter_doc(iter_dir, '03-', '技术方案')
    rows03, sec03, _all03, has03 = (_scan_ac(doc03) if doc03 else (0, set(), set(), False))
    seg = os.path.basename(os.path.dirname(os.path.abspath(path)))
    me = os.path.abspath(path).replace('\\', '/').lower()
    main03 = os.path.abspath(doc03).replace('\\', '/').lower() if doc03 else ''

    if seg.startswith('03-'):
        if me != main03:
            return out      # 03 目录下的非主文档（如 03-启动交接卡.md）不承担 D14
        if not has03:
            out.append(Finding('ERROR', 'D14', 0,
                               '03 缺「%s」小节（##~#### 标题含该词）' % AC_SECTION_KEY))
        elif rows03 < 1:
            out.append(Finding('ERROR', 'D14', 0,
                               '03「%s」小节内无含 AC-n 的表格数据行' % AC_SECTION_KEY))
        return out

    if seg.startswith('05-'):
        if not has03:
            return out          # 03 缺小节已由 D14 报红，此处不重复计红
        _rows, _sec, mine, _has = _scan_ac(path)
        if not mine:
            out.append(Finding('WARN', 'D15', 0,
                               '05 未引用任何 AC-n（非义务，仅提示）'))
            return out
        for t in sorted(mine - sec03):
            out.append(Finding('ERROR', 'D15', 0,
                               '05 引用了 03 验收断言小节里不存在的 %s' % t))
    return out


def check_file(path, max_per_rule=8):
    """返回 (findings, counters)。findings 已按每规则上限截断。"""
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        lines = fh.read().split('\n')

    raw = list(lines)
    text = '\n'.join(raw)

    allowed = set()
    for m in ALLOW_RE.finditer(text):
        for r in re.split(r'[,\s]+', m.group(1).strip()):
            if r:
                allowed.add(r.upper())
    # 允许 "allow D1" 与 "allow 1" 两种写法
    allowed |= {'D' + r for r in list(allowed) if r.isdigit()}

    findings = []
    bold_pairs = 0
    total_lines = len(lines)
    in_code = False
    code_start = 0
    fence_lang = ''
    table_cols = None

    for idx, ln in enumerate(raw, start=1):
        if FENCE_RE.match(ln):
            if in_code:
                span = idx - code_start - 1
                if span > CODE_ERR:
                    findings.append(Finding('ERROR', 'D5', code_start,
                                            '代码块 %d 行（>%d）— 移入附录或只留签名' % (span, CODE_ERR)))
                elif span > CODE_WARN:
                    findings.append(Finding('WARN', 'D5', code_start,
                                            '代码块 %d 行（>%d）' % (span, CODE_WARN)))
                block = raw[code_start:idx - 1]
                if fence_lang == 'mermaid':
                    first = next((x.strip() for x in block
                                  if x.strip() and not x.strip().startswith('%%')), '')
                    kind = first.split()[0].lower() if first else ''
                    if kind not in MERMAID_KINDS:
                        findings.append(Finding('WARN', 'D12', code_start,
                                                'Mermaid 图表类型未知：%r（见 doc-style-guide §7.4）' % first[:40]))
                else:
                    art = [x for x in block if ASCII_ART_RE.search(x)]
                    if len(art) >= 3:
                        findings.append(Finding('WARN', 'D13', code_start,
                                                '疑似制表符 ASCII 图（%d 行）— 建议改 Mermaid' % len(art)))
                in_code = False
            else:
                in_code = True
                code_start = idx
                fence_lang = ln.strip().lstrip('`~').strip().lower()
            continue
        if in_code:
            continue

        # D3 粗体（代码块外）
        bold_pairs += len(BOLD_RE.findall(ln))

        # D4 emoji 白名单
        for ch in EMOJI_RE.findall(ln):
            if ch not in EMOJI_ALLOW:
                findings.append(Finding('WARN', 'D4', idx, '白名单外符号 %r — 见规范 §二' % ch))
                break

        # D10 相对链接有效性（.md 目标须存在；仅真实产出文档）
        for m in (LINK_TARGET_RE.finditer(ln) if is_produced_doc(path) else []):
            tgt = m.group(1)
            if tgt.startswith(('http://', 'https://', 'mailto:', '#')):
                continue
            file_part = tgt.split('#')[0]
            if not file_part.lower().endswith('.md') or '{{' in file_part or '<' in file_part:
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(path)), file_part))
            if not os.path.exists(target):
                findings.append(Finding('ERROR', 'D10', idx, '相对链接目标不存在：%s' % tgt))

        if TABLE_ROW_RE.match(ln):
            cells = split_cells(ln)
            if not is_separator_row(cells):
                # D6 表格列数（按表头/首个非分隔行统计）
                if table_cols is None:
                    table_cols = len(cells)
                    if table_cols > MAX_COLS:
                        findings.append(Finding('WARN', 'D6', idx,
                                                '表格 %d 列（>%d）— 拆表或改列表' % (table_cols, MAX_COLS)))
                for ci, cell in enumerate(cells):
                    n = len(strip_links(cell))
                    if n > CELL_ERR:
                        findings.append(Finding('ERROR', 'D1', idx,
                                                '表格单元格 %d 字符（>%d）— 改为缩进列表' % (n, CELL_ERR)))
                    elif n > CELL_WARN:
                        findings.append(Finding('WARN', 'D1', idx,
                                                '表格单元格 %d 字符（>%d）' % (n, CELL_WARN)))
            continue
        table_cols = None

        # D2 行宽（排除代码块 / 表格行 / 链接行）
        n = len(ln)
        if n > LINE_WARN and ('http://' not in ln and 'https://' not in ln):
            if n > LINE_ERR:
                findings.append(Finding('ERROR', 'D2', idx, '单行 %d 字符（>%d）' % (n, LINE_ERR)))
            else:
                findings.append(Finding('WARN', 'D2', idx, '单行 %d 字符（>%d）' % (n, LINE_WARN)))

    # D3 密度（仅迭代文档）
    if is_iter_doc(path) and total_lines > 0 and bold_pairs / float(total_lines) > BOLD_MIN_RATIO:
        findings.append(Finding('WARN', 'D3', 0,
                                '粗体 %d 处 / %d 行（>1:10）— 只标结论/数字/风险'
                                % (bold_pairs, total_lines)))

    # D11 脚注配对（仅真实产出文档）
    if is_produced_doc(path):
        refs = set(FN_REF_RE.findall(text))
        defs = set(m.group(1) for m in FN_DEF_RE.finditer(text))
        for r in sorted(refs - defs):
            findings.append(Finding('ERROR', 'D11', 0, '脚注 [^%s] 被引用但未定义' % r))
        for d in sorted(defs - refs):
            findings.append(Finding('WARN', 'D11', 0, '脚注 [^%s] 已定义但未被引用' % d))

    # D9 长文档目录（仅真实产出文档；模板骨架不要求）
    if (is_produced_doc(path) and total_lines > TOC_MIN_LINES
            and '## 目录' not in '\n'.join(raw[:TOC_SCAN_LINES])):
        findings.append(Finding('WARN', 'D9', 0,
                                '文档 %d 行（>%d）缺 "## 目录"（TOC）' % (total_lines, TOC_MIN_LINES)))

    if is_iter_doc(path):
        head = '\n'.join(raw[:META_HEAD_LINES])
        if '迭代 ID' not in head and '迭代ID' not in head:
            findings.append(Finding('ERROR', 'D7', 0, '文档头（前 %d 行）缺"迭代 ID"元信息块' % META_HEAD_LINES))

        if '## 结论摘要' not in '\n'.join(raw[:SUMMARY_HEAD_LINES]):
            findings.append(Finding('ERROR', 'D8', 0, '正文前 %d 行内缺 "## 结论摘要" 小节' % SUMMARY_HEAD_LINES))

    # D14 / D15 验收断言（跨文件判据，独立函数；见 check_ac_rules 的注释）
    findings.extend(check_ac_rules(path))

    # 过滤豁免 + 每规则截断
    findings = [f for f in findings if f.rule not in allowed]
    kept, overflow = [], []
    per_rule = {}
    for f in findings:
        per_rule[f.rule] = per_rule.get(f.rule, 0) + 1
        if per_rule[f.rule] <= max_per_rule:
            kept.append(f)
    for rule, cnt in sorted(per_rule.items()):
        if cnt > max_per_rule:
            overflow.append((rule, cnt - max_per_rule))

    counters = {
        'error': len([f for f in findings if f.level == 'ERROR']),
        'warn': len([f for f in findings if f.level == 'WARN']),
    }
    return kept, overflow, counters


def collect_targets(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            for root, _dirs, names in os.walk(p):
                for nm in sorted(names):
                    if nm.lower().endswith('.md'):
                        files.append(os.path.join(root, nm))
        elif os.path.isfile(p):
            files.append(p)
        else:
            sys.stderr.write('跳过（不存在）: %s\n' % p)
    return files


def to_rel(path):
    try:
        return os.path.relpath(path).replace('\\', '/')
    except Exception:
        return path


def main():
    ap = argparse.ArgumentParser(description='迭代文档版式自检（SSOT: engine/domain/doc-style-guide.md）')
    ap.add_argument('paths', nargs='+', help='待检查的文件或目录（目录递归 *.md）')
    ap.add_argument('-q', '--quiet', action='store_true', help='只输出汇总')
    ap.add_argument('--json', action='store_true', help='机器可读输出')
    ap.add_argument('--max-per-rule', type=int, default=8, help='每文件每规则最多报告条数（默认 8）')
    ap.add_argument('--iterations-dir', default='',
                    help='迭代文档目录（相对项目根）；缺省取 manifest paths.docs_iterations，再缺省 docs/iterations')
    args = ap.parse_args()

    iter_dir, iter_src = resolve_iterations_dir(args.iterations_dir)
    if not args.quiet:
        print('[INFO] iterations-dir=%s (source=%s)' % (iter_dir, iter_src))

    files = collect_targets(args.paths)
    if not files:
        sys.stderr.write('未找到待检查的 Markdown 文件。\n')
        return 1

    report = {'files': [], 'summary': {'error': 0, 'warn': 0, 'files': len(files)}}
    total_err = total_warn = 0

    for path in files:
        kept, overflow, counters = check_file(path, args.max_per_rule)
        total_err += counters['error']
        total_warn += counters['warn']
        entry = {
            'path': to_rel(path),
            'findings': [f.as_dict() for f in kept],
            'overflow': [{'rule': r, 'count': c} for r, c in overflow],
            'error': counters['error'],
            'warn': counters['warn'],
        }
        report['files'].append(entry)

        if not args.json and not args.quiet and kept:
            print('\n%s' % entry['path'])
            for f in kept:
                loc = ('L%d' % f.line) if f.line else '--'
                print('  [%-5s] %s %-4s %s' % (f.level, loc, f.rule, f.msg))
            for r, c in overflow:
                print('  ... %s 另有 %d 处（--max-per-rule 调整上限）' % (r, c))
            print('  ─ ERROR %d ｜ WARN %d' % (counters['error'], counters['warn']))

    report['summary']['error'] = total_err
    report['summary']['warn'] = total_warn

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print('\n' + '=' * 58)
        print('扫描 %d 个文件 ｜ ERROR %d ｜ WARN %d' % (len(files), total_err, total_warn))
        if total_err:
            print('ERROR 必须修复（版式 SSOT: engine/domain/doc-style-guide.md）')
        print('=' * 58)

    return 1 if total_err else 0


if __name__ == '__main__':
    sys.exit(main())
