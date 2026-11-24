#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""05 报告「平台渲染验收清单」完整性机检 —— 纯只读脚本，**不写任何文件**。

判什么：**页面型迭代**的 05 报告必须含 `### 平台渲染验收清单` 节，且 8 项逐项有结论
        （`✅` / `❌` / `N/A` + 证据；整节全 `⬜` = 没验，判 ERR）。

触发面（满足其一；★ 2026-11-16 扩面，原口径只有 a）：
  a) 03 方案含 `#### 2.3.1` / `#### 2.3.2` 小节（列定义表 / 检索条件表）；
  b) 03 方案含 U3 断点 / U6 布局包 / 布局预览 / 静态 HTML 预览 —— UI 重排类迭代
     常常**没有**两表（页面已存在，只改版式），旧口径下这类迭代渲染验收整条绕过。

不判什么：勾得对不对（由人判「清单 ⇄ 实际界面」）；不判条目内容是否适配本页形态。

豁免：03 元信息标 🟢 极简迭代 ⇒ EXEMPT；无 03 方案 / 05 报告未产出 ⇒ SKIP（不判红）。

用法（从项目根或 skill 根均可）：
    python scripts/check-05-render-list.py                  # 查当前 ACTIVE 迭代
    python scripts/check-05-render-list.py --iter <目录名>   # 查指定迭代
    python scripts/check-05-render-list.py --all            # 全量扫描（存量只 WARN，供统计）
    python scripts/check-05-render-list.py --check-templates # 断言模板/挂载点仍在位（防回退）
    python scripts/check-05-render-list.py --self-test      # 内置正/负向对照（临时目录）
    python scripts/check-05-render-list.py --json           # 机读输出

退出码：0 = PASS / EXEMPT / SKIP（WARN 不影响退出码）；1 = 存在 ERR；2 = 用法错误
        `--strict` 时 WARN 也计 1（对齐 audit-engine.py 口径）

★ 与 `check-03-page-tables.py` 的分工：那个判「03 两表在不在」，本脚本判「05 渲染验收填没填」。
  两者**互补不替代**：两表齐备而 05 不验渲染，是 2026-11 实测 45% 漏检率的直接成因。
★ 审计侧挂载 = `audit-engine.py` A13（ERR 同级，2026-11-16 用户拍板）；挂载点被删 ⇒ A13 报 ERR。
"""

import argparse
import glob
import io
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(HERE)
PROJECT_ROOT = os.path.abspath(os.path.join(SKILL_ROOT, '..', '..', '..'))

SEC_COL = re.compile(r'^####\s*2\.3\.1')
SEC_FILTER = re.compile(r'^####\s*2\.3\.2')
SEC_RENDER = re.compile(r'^###\s*平台渲染验收清单')
H2 = re.compile(r'^#{1,4}\s')
SEP_ROW = re.compile(r'^\|[\s:\-|]+\|$')
GREEN_ROW = re.compile(r'^\|\s*(影响等级|复杂度|阶段)\s*\|')
# 计入「已填」的结论标记。★ 刻意**不含** `⬜` 与 `⏳`：
#   渲染清单是必勾（不是待办清单）,`⏳ 待手测` 等于没验 —— 这正是
#   2026-11-10-002 整节待办却以 defects=0 收口的形态，不能让它通过。
#   `⚠️ 部分` 计入（显式结论 + 已知缺口，11-03-001 实测写法）。
DONE_MARK = re.compile(r'✅|❌|⏭|⚠️|⚠|N/A|\bNA\b|不适用')

# 布局包关键词（触发面 b）。`\bU3\b` 防 U30/U31 之类误命中。
UI_KEYS = (
    (re.compile(r'\bU3\b'), 'U3 断点'),
    (re.compile(r'\bU6\b'), 'U6 布局包'),
    (re.compile(r'布局预览'), '布局预览'),
    (re.compile(r'UI-布局'), 'UI-布局'),
    (re.compile(r'静态\s*HTML\s*预览'), '静态 HTML 预览'),
)

MIN_ITEMS = 8               # 列表页基线 1~8；上限不设（条目随已发生缺陷增长，见模板 ② 组）


def rel(p):
    try:
        return os.path.relpath(p, PROJECT_ROOT).replace('\\', '/')
    except Exception:
        return p


def docs_dir():
    """迭代文档根：优先取 manifest 的 paths.docs_iterations，缺键回落 docs/iterations。"""
    mf = os.path.join(SKILL_ROOT, 'project', 'project.manifest.yaml')
    try:
        with io.open(mf, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                m = re.match(r'^\s*docs_iterations:\s*"?([^"\s#]+)"?', line)
                if m:
                    return os.path.join(PROJECT_ROOT, m.group(1).replace('\\', '/'))
    except Exception:
        pass
    return os.path.join(PROJECT_ROOT, 'docs', 'iterations')


def active_iteration():
    p = os.path.join(SKILL_ROOT, 'runtime', 'ACTIVE')
    try:
        with io.open(p, 'r', encoding='utf-8-sig', errors='replace') as f:
            first = (f.readline() or '').strip()
        return None if (not first or first.lower() == 'none') else first
    except Exception:
        return None


def read_lines(path):
    with io.open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read().splitlines()


def meta_exempt(lines):
    for ln in lines[:40]:
        if GREEN_ROW.match(ln) and '\U0001F7E2' in ln:      # 🟢
            return True
    return False


def table_rows(body):
    """表体**数据行**：剔分隔行，并剔「下一行是分隔行」的表头行。"""
    out = []
    for i, ln in enumerate(body):
        s = ln.strip()
        if not s.startswith('|') or SEP_ROW.match(s):
            continue
        nxt = body[i + 1].strip() if i + 1 < len(body) else ''
        if SEP_ROW.match(nxt):
            continue
        out.append(s)
    return out


def slice_section(lines, pat):
    for i, ln in enumerate(lines):
        if pat.match(ln):
            body = []
            for j in range(i + 1, len(lines)):
                if H2.match(lines[j]):
                    break
                body.append(lines[j])
            return i + 1, body
    return None, None


def trigger(lines03):
    """返回 (是否触发, 原因, kind)。kind ∈ 'tables' / 'ui' / ''。

    kind 决定 🟢 能否豁免：两表（tables）可由 🟢 省掉填写；
    **布局包（ui）不豁免** —— 出了 U3/U6/布局预览就说明确实改了页面版式，
    复杂度标 🟢 只是改动量小，不等于不用验渲染。2026-11-16 实测：
    11-09-005 / 11-10-002 两个 UI 重排迭代正是靠 🟢 把渲染验收整条绕过的。
    """
    for pat, name in ((SEC_COL, '§2.3.1 列定义表'), (SEC_FILTER, '§2.3.2 检索条件表')):
        idx, _ = slice_section(lines03, pat)
        if idx is not None:
            return True, '%s 存在' % name, 'tables'
    text = '\n'.join(lines03)
    for pat, name in UI_KEYS:
        if pat.search(text):
            return True, '布局包命中 %s' % name, 'ui'
    return False, '无 §2.3 两表、无 U3/U6 布局包', ''


def find_05(iter_dir):
    hits = sorted(glob.glob(os.path.join(iter_dir, '05-测试验证', '05-*.md')))
    hits = [h for h in hits if os.path.isfile(h)]
    return hits[0] if hits else None


def judge(iter_dir):
    """返回 dict(status, iteration, path, errs[], warns[], notes[])。status ∈ PASS/EXEMPT/SKIP/ERR"""
    res = {'iteration': os.path.basename(os.path.normpath(iter_dir)),
           'path': '', 'status': 'SKIP', 'errs': [], 'warns': [], 'notes': []}
    p03 = os.path.join(iter_dir, '03-技术方案', '03-技术方案.md')
    if not os.path.isfile(p03):
        res['notes'].append('无 03-技术方案.md ⇒ SKIP')
        return res
    lines03 = read_lines(p03)
    trig, why, kind = trigger(lines03)
    if meta_exempt(lines03) and kind != 'ui':
        res['status'] = 'EXEMPT'
        res['notes'].append('03 元信息标 🟢（极简迭代）⇒ 免填渲染清单（★ 布局包类不豁免）')
        return res
    if not trig:
        res['notes'].append('非页面型迭代（%s）⇒ 免填' % why)
        return res
    res['notes'].append('触发：%s%s' % (why, '（🟢 不豁免：已出布局包）' if kind == 'ui' else ''))

    p05 = find_05(iter_dir)
    if not p05:
        res['notes'].append('05 报告未产出（05 未开始）⇒ SKIP')
        return res
    res['path'] = rel(p05)
    lines05 = read_lines(p05)

    idx, body = slice_section(lines05, SEC_RENDER)
    if idx is None:
        res['status'] = 'ERR'
        res['errs'].append('缺 `### 平台渲染验收清单` 节（触发面：%s）' % why)
        return res

    text = '\n'.join(body)
    if 'N/A（无前端页面改动' in text or 'N/A(无前端页面改动' in text:
        res['status'] = 'ERR'
        res['errs'].append('触发了渲染验收却整节写「N/A（无前端页面改动）」（行 %d）' % idx)
        return res

    rows = table_rows(body)
    filled = 0
    pending = []
    for s in rows:
        if DONE_MARK.search(s):
            filled += 1
        else:
            pending.append(s)
    res['notes'].append('清单结论：已填 %d 项 / 未填 %d 项' % (filled, len(pending)))
    if not rows:
        res['status'] = 'ERR'
        res['errs'].append('平台渲染验收清单节内无表格数据行（行 %d）' % idx)
        return res
    if pending:
        res['status'] = 'ERR'
        res['errs'].append('有 %d/%d 行未给结论（⬜ / ⏳ 计未验）：%s'
                           % (len(pending), len(rows), pending[0][:70]))
        return res
    if filled < MIN_ITEMS:
        res['status'] = 'ERR'
        res['errs'].append('平台渲染验收清单仅 %d 项（要求 ≥%d：列表页基线 1~8 不得删减）'
                           % (filled, MIN_ITEMS))
        return res
    res['status'] = 'PASS'
    return res


TEMPLATE_CHECKS = [
    ('engine/templates/phase-05-测试验证报告.md', '### 平台渲染验收清单', '05 模板的渲染清单节名'),
    ('engine/flow/phase-05.md', 'check-05-render-list.py', '05 通过条件块的机器挂载点'),
]


def check_templates():
    errs = []
    for relp, needle, desc in TEMPLATE_CHECKS:
        p = os.path.join(SKILL_ROOT, relp.replace('/', os.sep))
        if not os.path.exists(p):
            errs.append('%s：文件缺失 %s' % (desc, relp))
            continue
        txt = '\n'.join(read_lines(p))
        if needle not in txt:
            errs.append('%s：未命中 `%s`' % (desc, needle))
    return errs


# ── self-test 用的内存变体（落临时目录，跑完即删）─────────────────────
SAMPLE_03_TABLES = [
    '| 影响等级 | 🟡 Normal |', '',
    '#### 2.3.1 列定义表', '', '| # | 列 |', '|:--:|:--|', '| 1 | 标签号 |', '',
    '#### 2.3.2 检索条件表', '', '| # | 条件 |', '|:--:|:--|', '| 1 | 病区 |', '',
]
SAMPLE_03_UI = [
    '| 影响等级 | 🟡 Normal |', '',
    '### 2.2 UI 布局方案（U1~U7）', '',
    'U3 断点：1280 / 1440 / 1920；U6 布局包见 `UI-布局预览.html`。', '',
]
SAMPLE_03_NONE = [
    '| 影响等级 | 🟡 Normal |', '',
    '## 3. 代码改动范围', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `BLL/A.cs` |', '',
]
SAMPLE_03_EXEMPT = [
    '| 复杂度 | 🟢 简单 |', '',
    '#### 2.3.1 列定义表', '', '| # | 列 |', '|:--:|:--|', '| 1 | c |', '',
]
ROWS_OK = ['| %d | 项%d | 形态 | ✅ | 证据 |' % (i, i) for i in range(1, 9)]
ROWS_BLANK = ['| %d | 项%d | 形态 | ⬜ |  |' % (i, i) for i in range(1, 9)]
ROWS_HALF = ['| %d | 项%d | 形态 | %s | 证据 |' % (i, i, '✅' if i <= 3 else '⬜')
             for i in range(1, 9)]
# 12 项（8 列表页基线 + 4 非列表形态）⇒ 上限不设，全填即 PASS
ROWS_12 = ['| %d | 项%d | 形态 | ✅ | 证据 |' % (i, i) for i in range(1, 13)]


def _mk_05(rows):
    return (['## 三、详细结果', '', '### 平台渲染验收清单（★ 必勾）', '',
             '| # | 验收项 | 失效形态 | 结论 | 证据 |', '|:--:|:--|:--|:--:|:--|']
            + rows + ['', '### 后端真库冒烟', ''])


SAMPLE = {
    'pass_tables': (SAMPLE_03_TABLES, _mk_05(ROWS_OK), 'PASS'),
    'pass_ui': (SAMPLE_03_UI, _mk_05(ROWS_OK), 'PASS'),
    # 条目扩到 12 项仍应 PASS（上限不设，2026-11-16 加非列表形态 4 项）
    'pass_extended': (SAMPLE_03_TABLES, _mk_05(ROWS_12), 'PASS'),
    # 全填但少于 8 项 ⇒ ERR（列表页基线不得删减）
    'err_below_min': (SAMPLE_03_TABLES, _mk_05(ROWS_OK[:5]), 'ERR'),
    'err_no_section': (SAMPLE_03_TABLES, ['## 三、详细结果', ''], 'ERR'),
    'err_all_blank': (SAMPLE_03_TABLES, _mk_05(ROWS_BLANK), 'ERR'),
    'err_partial': (SAMPLE_03_UI, _mk_05(ROWS_HALF), 'ERR'),
    'err_na_escape': (SAMPLE_03_TABLES,
                      ['## 三、详细结果', '', '### 平台渲染验收清单', '',
                       'N/A（无前端页面改动）', ''], 'ERR'),
    'skip_non_page': (SAMPLE_03_NONE, _mk_05(ROWS_OK), 'SKIP'),
    'exempt_green': (SAMPLE_03_EXEMPT, _mk_05(ROWS_BLANK), 'EXEMPT'),
    # 🟢 不得成为布局包迭代的绕过通道（2026-11-16 实证：11-09-005 / 11-10-002）
    'err_ui_green_backdoor': (
        ['| 复杂度 | 🟢 简单 |', '| 影响等级 | 🟡 Normal |', '',
         'U6 布局包见 `UI-布局预览.html`。', ''],
        ['## 三、详细结果', ''], 'ERR'),
    # ⚠️ 部分 是显式结论，须计入「已填」（11-03-001 第 5 项实测写法）
    'pass_partial_warn': (
        SAMPLE_03_TABLES,
        _mk_05(['| %d | 项%d | 形态 | %s | 证据 |' % (i, i, '⚠️ 部分' if i == 5 else '✅')
                for i in range(1, 9)]), 'PASS'),
}


def self_test():
    import shutil
    import tempfile
    ok = 0
    fails = []
    for name, (l03, l05, expect) in SAMPLE.items():
        root = tempfile.mkdtemp(prefix='05render-')
        try:
            it = os.path.join(root, '2099-01-01-001-样例')
            os.makedirs(os.path.join(it, '03-技术方案'))
            os.makedirs(os.path.join(it, '05-测试验证'))
            with io.open(os.path.join(it, '03-技术方案', '03-技术方案.md'),
                         'w', encoding='utf-8', newline='\n') as f:
                f.write('\n'.join(l03) + '\n')
            with io.open(os.path.join(it, '05-测试验证', '05-测试验证报告.md'),
                         'w', encoding='utf-8', newline='\n') as f:
                f.write('\n'.join(l05) + '\n')
            got = judge(it)['status']
        finally:
            shutil.rmtree(root, ignore_errors=True)
        if got == expect:
            ok += 1
        else:
            fails.append('%s: 期望 %s 实得 %s' % (name, expect, got))
    # 05 未产出 ⇒ SKIP（单独构造，不建 05 目录）
    root = tempfile.mkdtemp(prefix='05render-')
    try:
        it = os.path.join(root, '2099-01-01-002-无05')
        os.makedirs(os.path.join(it, '03-技术方案'))
        with io.open(os.path.join(it, '03-技术方案', '03-技术方案.md'),
                     'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(SAMPLE_03_TABLES) + '\n')
        got = judge(it)['status']
    finally:
        shutil.rmtree(root, ignore_errors=True)
    if got == 'SKIP':
        ok += 1
    else:
        fails.append('skip_no_05: 期望 SKIP 实得 %s' % got)
    total = len(SAMPLE) + 1
    print('self-test: %d/%d 通过' % (ok, total))
    for f in fails:
        print('  [FAIL] %s' % f)
    return 0 if not fails else 1


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--iter', help='指定迭代目录名')
    ap.add_argument('--all', action='store_true', help='全量扫描（存量只 WARN）')
    ap.add_argument('--check-templates', action='store_true', help='断言模板/挂载点仍在位')
    ap.add_argument('--self-test', action='store_true', help='内置正/负向对照')
    ap.add_argument('--json', action='store_true', help='机读输出')
    ap.add_argument('--strict', action='store_true', help='WARN 也计入退出码')
    a = ap.parse_args()

    if a.self_test:
        return self_test()

    if a.check_templates:
        errs = check_templates()
        if a.json:
            print(json.dumps({'mode': 'check-templates', 'errs': errs}, ensure_ascii=False))
        else:
            if errs:
                print('[ERR] 模板侧改动缺失（防回退断言）：')
                for e in errs:
                    print('      - %s' % e)
            else:
                print('[OK] 模板侧 %d 项断言全通过（05 节名 / phase-05 挂载点）' % len(TEMPLATE_CHECKS))
        return 1 if errs else 0

    if a.all:
        base = docs_dir()
        results = []
        for d in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            p = os.path.join(base, d)
            if os.path.isdir(p):
                results.append(judge(p))
        trig = [r for r in results if r['status'] in ('PASS', 'ERR')]
        exempt = [r for r in results if r['status'] == 'EXEMPT']
        skip = [r for r in results if r['status'] == 'SKIP']
        bad = [r for r in results if r['status'] == 'ERR']
        for r in bad:
            print('[WARN] %s' % r['iteration'])
            for e in r['errs']:
                print('       - %s' % e)
        print('存量统计：共 %d 个迭代 ｜ 触发 %d ｜ 通过 %d ｜ 缺节/未填 %d ｜ 极简豁免 %d ｜ 不判定 %d'
              % (len(results), len(trig), len(trig) - len(bad), len(bad), len(exempt), len(skip)))
        print('口径：存量只报 WARN（不带历史红）；新迭代由默认模式 + audit-engine A13 判 ERR。')
        if a.json:
            print(json.dumps({'mode': 'all', 'total': len(results), 'triggered': len(trig),
                              'failed': len(bad), 'exempt': len(exempt), 'skipped': len(skip),
                              'errs': [{'iteration': r['iteration'], 'errs': r['errs']} for r in bad]},
                             ensure_ascii=False))
        return 1 if (a.strict and bad) else 0

    if a.iter:
        iter_dir = os.path.join(docs_dir(), a.iter)
    else:
        it = active_iteration()
        if not it:
            print('[SKIP] 无活跃迭代（ACTIVE = none）⇒ 本次不校验')
            return 0
        iter_dir = os.path.join(docs_dir(), it)

    res = judge(iter_dir)
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        tag = {'PASS': '[OK]', 'EXEMPT': '[EXEMPT]', 'SKIP': '[SKIP]', 'ERR': '[ERR]'}[res['status']]
        print('%s %s' % (tag, res['iteration']))
        if res['path']:
            print('      · 报告：%s' % res['path'])
        for n in res['notes']:
            print('      · %s' % n)
        for e in res['errs']:
            print('      - %s' % e)
        if res['status'] == 'ERR':
            print('      修法：在 05 报告补 `### 平台渲染验收清单` 节，按模板 8 项逐项填 '
                  '`✅/❌/N/A` + 证据；确无前端页面改动的迭代应在 03 元信息标 🟢 或走豁免。')
    if res['status'] == 'ERR':
        return 1
    if a.strict and res['warns']:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
