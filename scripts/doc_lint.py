#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""迭代文档版式自检（Doc Lint）

规则 SSOT: engine/doc-style-guide.md（八条硬规则 D1~D8）

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

RULES = ('D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8')


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


def is_produced_doc(path):
    """D10/D11 只检查真实产出文档（docs/iterations/）——模板与规范中的示例链接/脚注不适用。"""
    return '/iterations/' in path.replace('\\', '/').lower()


def is_iter_doc(path):
    """D3/D7/D8 只对迭代文档生效（引擎说明文件、示例文件不适用）。"""
    p = path.replace('\\', '/').lower()
    nm = os.path.basename(p)
    if nm.endswith('.example.md') or nm.startswith('cold-start'):
        return False
    return ('/iterations/' in p) or nm.startswith('phase-0') or nm.startswith('bug-requirement')


def is_separator_row(cells):
    return bool(cells) and all((not c) or SEP_CELL_RE.match(c) for c in cells)


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
    ap = argparse.ArgumentParser(description='迭代文档版式自检（SSOT: engine/doc-style-guide.md）')
    ap.add_argument('paths', nargs='+', help='待检查的文件或目录（目录递归 *.md）')
    ap.add_argument('-q', '--quiet', action='store_true', help='只输出汇总')
    ap.add_argument('--json', action='store_true', help='机器可读输出')
    ap.add_argument('--max-per-rule', type=int, default=8, help='每文件每规则最多报告条数（默认 8）')
    args = ap.parse_args()

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
            print('ERROR 必须修复（版式 SSOT: engine/doc-style-guide.md）')
        print('=' * 58)

    return 1 if total_err else 0


if __name__ == '__main__':
    sys.exit(main())
