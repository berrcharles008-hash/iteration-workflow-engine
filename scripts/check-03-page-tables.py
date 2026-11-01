#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""03 方案「页面两表」完整性机检 —— 纯只读脚本，**不写任何文件**。

判什么：**有前端页面改动**的迭代，03 方案必须写
  `#### 2.3.1 ...`（列定义表）与 `#### 2.3.2 ...`（检索条件表）两节，且各自有内容。
不判什么：表的内容对不对（由 `check_spec_parity` 判「表 ⇄ 实现」，由人判「表 ⇄ 原型」）。
⇒ 本脚本与那两个**互补不替代**：它们都建立在「表存在」之上，本脚本补的正是「表在不在」。

用法（从项目根或 skill 根均可）：
    python scripts/check-03-page-tables.py                # 查当前 ACTIVE 迭代的 03
    python scripts/check-03-page-tables.py --doc <路径>   # 查指定 03 方案
    python scripts/check-03-page-tables.py --all          # 全量扫描（存量只 WARN，供统计）
    python scripts/check-03-page-tables.py --check-templates   # 断言模板侧改动仍在位（防回退）
    python scripts/check-03-page-tables.py --self-test    # 内置正/负向对照（内存变体）
    python scripts/check-03-page-tables.py --json         # 机读输出

退出码：0 = PASS / EXEMPT / SKIP（WARN 不影响退出码）；1 = 存在 ERR；2 = 用法错误
        `--strict` 时 WARN 也计 1（对齐 audit-engine.py 口径）

★ 触发面只看两张表：`### 3.2 前端`（改动文件表）与 `### 3.0`（改动点锚点表）。
  刻意**不看** §2.2 / §4 —— 那些小节里的 `.vue` / `.js` 是「联动对象 / 参考实现」，
  拿它当触发条件会把「引用别人代码的引擎类迭代」自己判红（2026-11-01 评审 R3-1 实证）。
★ 标题判据用**前缀匹配**（`#### 2.3.1`），不要求标题逐字 —— 实测历史写法有
  「2.3.1 取数条件（待作业队列，替代检索区）」「2.3.2 应摆药品明细表（列定义）」等。
★ 已知三处写法差异登记（多候选路径教训，见项目模式库 P-218）：
  ① 元信息用「影响等级」/「复杂度」/「阶段」三种键名表 🟢；② 两表标题文案不统一；
  ③ 「本页无列表/无检索区」以正文粗体「无」表达而非空表。
"""

import argparse
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
H2 = re.compile(r'^#{1,4}\s')
SEC_32 = re.compile(r'^###\s*3\.2\s*前端')
SEC_30 = re.compile(r'^###\s*3\.0')
SEC_H2_3 = re.compile(r'^##\s*3\.')
CODE_EXT = re.compile(r'\.(vue|ts|js)\b')
GREEN_ROW = re.compile(r'^\|\s*(影响等级|复杂度|阶段)\s*\|')
SEP_ROW = re.compile(r'^\|[\s:\-|]+\|$')


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
    """表体**数据行**：剔分隔行，并剔「下一行是分隔行」的表头行（否则空表会被表头行冒充成 1 行）。"""
    out = []
    for i, ln in enumerate(body):
        s = ln.strip()
        if not s.startswith('|') or SEP_ROW.match(s):
            continue
        nxt = body[i + 1].strip() if i + 1 < len(body) else ''
        if SEP_ROW.match(nxt):
            continue                      # 本行是表头，不是数据
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


def slice_h2(lines, pat):
    """切 `## x` 级小节（到下一个同级 `## ` 为止；`### ` 子节算在本节内）。"""
    for i, ln in enumerate(lines):
        if pat.match(ln):
            body = []
            for j in range(i + 1, len(lines)):
                if re.match(r'^##\s', lines[j]):
                    break
                body.append(lines[j])
            return i + 1, body
    return None, None


def has_frontend_change(lines):
    """触发面（三级，逐级回退）：§3.2 改动文件表 → §3.0 锚点表 → 整个 `## 3` 只认 .vue。

    第三级刻意**只认 .vue**：引擎/后端类迭代常在 §3 引用 `.js` / `.ts`（构建脚本、联动对象），
    把它们算作「前端改动」会把引擎迭代自己判红（2026-11-01 评审 R3-1）。
    """
    idx, body = slice_section(lines, SEC_32)
    if idx is not None:
        for s in table_rows(body):
            cells = [c.strip() for c in s.split('|')[1:-1]]
            for c in cells:
                if CODE_EXT.search(c):
                    return True, '§3.2 命中 %s' % c[:40]
        return False, '§3.2 存在但无源码文件'
    idx, body = slice_section(lines, SEC_30)
    if idx is not None:
        for s in table_rows(body):
            if re.search(r'\|\s*[^|]*\.vue\b', s):
                return True, '§3.0 锚点表命中 .vue'
        return False, '§3.0 存在但无 .vue'
    idx, body = slice_h2(lines, SEC_H2_3)
    if idx is not None:
        for s in table_rows(body):
            if re.search(r'\.vue\b', s):
                return True, '§3 节命中 .vue（无子节写法）'
        return False, '§3 节无 .vue'
    return False, '无 §3 代码改动范围（不判定）'


def judge(path):
    """返回 dict(status, errs[], warns[], notes[])。status ∈ PASS/EXEMPT/SKIP/ERR"""
    res = {'path': rel(path), 'status': 'SKIP', 'errs': [], 'warns': [], 'notes': []}
    if not os.path.exists(path):
        res['notes'].append('文件不存在 ⇒ SKIP')
        return res
    lines = read_lines(path)
    if meta_exempt(lines):
        res['status'] = 'EXEMPT'
        res['notes'].append('元信息标 🟢（极简迭代免填 §2.3 两表）')
        return res
    trig, why = has_frontend_change(lines)
    if not trig:
        res['notes'].append('无前端页面改动（%s）⇒ 免填' % why)
        return res
    res['notes'].append('触发：%s' % why)
    bad = 0
    for pat, name in ((SEC_COL, '§2.3.1 列定义表'), (SEC_FILTER, '§2.3.2 检索条件表')):
        idx, body = slice_section(lines, pat)
        if idx is None:
            res['errs'].append('缺 %s 小节（标题需以 `#### 2.3.1` / `#### 2.3.2` 开头）' % name)
            bad += 1
            continue
        rows = table_rows(body)
        if rows:
            res['notes'].append('%s：%d 行' % (name, len(rows)))
            continue
        head = [b for b in body if b.strip()][:5]
        if any('无' in b for b in head):
            res['notes'].append('%s：显式写「无」⇒ 合规' % name)
            continue
        res['errs'].append('%s 小节为空表且正文未写「无」（行 %d）' % (name, idx))
        bad += 1
    res['status'] = 'ERR' if bad else 'PASS'
    return res


TEMPLATE_CHECKS = [
    ('engine/templates/phase-04-开发任务清单.md', '逐项落地核对', '04 清单模板的「页面契约落地」条目'),
    ('engine/templates/phase-05-测试验证报告.md', '### 平台渲染验收清单', '05 模板的平台渲染验收清单节'),
    ('engine/phase-05.md', '[MECH:', '05 缺陷登记步骤的机制标记要求'),
    ('engine/phase-03.md', 'check-03-page-tables.py', '03 通过条件块的机器前置挂载点'),
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
    # 05 模板的 8 项必勾（条目数只来自已发生缺陷，不得预扩展 ⇒ 数量本身是判据）
    p05 = os.path.join(SKILL_ROOT, 'engine', 'templates', 'phase-05-测试验证报告.md')
    if not os.path.exists(p05):
        errs.append('05 模板缺失：engine/templates/phase-05-测试验证报告.md')
    else:
        n = 0
        inside = False
        for ln in read_lines(p05):
            if ln.startswith('### 平台渲染验收清单'):
                inside = True
                continue
            if inside and ln.startswith('### '):
                break
            if inside and re.match(r'^\|\s*\d+\s*\|', ln.strip()):
                n += 1
        if n != 8:
            errs.append('05 模板平台渲染清单项数 = %d（要求 8；条目须与已发生缺陷对应，不预扩展）' % n)
    return errs


SAMPLE = {
    'pass': [
        '| 项 | 值 |', '|:--|:--|', '| 影响等级 | 🟡 Normal |', '',
        '### 3.2 前端', '', '| # | 文件 | Delta | 说明 |', '|:--:|:--|:--:|:--|',
        '| 1 | `page/a.vue` | ADDED | 新页 |', '',
        '#### 2.3.1 取数条件（历史写法）', '', '| # | 列 |', '|:--:|:--|', '| 1 | 标签号 |', '',
        '#### 2.3.2 检索条件表', '', '| 条件名 | 控件 |', '|:--|:--|', '| 病区 | select |', '',
    ],
    'empty_ok': [
        '| 影响等级 | 🟡 Normal |', '',
        '### 3.2 前端', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `b.ts` |', '',
        '#### 2.3.1 列定义表', '', '**无**。本页为作业屏，不含表格。', '',
        '#### 2.3.2 检索条件表', '', '| # |', '|:--:|', '| 1 |', '',
    ],
    'skip': [
        '| 影响等级 | 🟡 Normal |', '',
        '### 3.2 前端', '', '| # | 文件 |', '|:--:|:--|', '| 1 | 无 |', '',
        '## 4. 接口设计', '', '参考 `web/x/build/y.js`（联动对象，非本迭代改动）', '',
    ],
    'exempt': [
        '| 复杂度 | 🟢 简单 |', '',
        '### 3.2 前端', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `c.vue` |', '',
    ],
    'miss_filter': [
        '| 影响等级 | 🟡 Normal |', '',
        '### 3.2 前端', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `d.vue` |', '',
        '#### 2.3.1 列定义表', '', '| # | 列 |', '|:--:|:--|', '| 1 | 标签号 |', '',
    ],
    'miss_col': [
        '| 影响等级 | 🟡 Normal |', '',
        '### 3.2 前端', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `e.vue` |', '',
        '#### 2.3.2 检索条件表', '', '| # |', '|:--:|', '| 1 |', '',
    ],
    'empty_bad': [
        '| 影响等级 | 🟡 Normal |', '',
        '### 3.2 前端', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `f.vue` |', '',
        '#### 2.3.1 列定义表', '', '| # | 列 |', '|:--:|:--|', '',
        '#### 2.3.2 检索条件表', '', '| # |', '|:--:|', '| 1 |', '',
    ],
    'anchor_only': [
        '| 影响等级 | 🟡 Normal |', '',
        '### 3.0 改动点锚点表', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `g.vue` |', '',
    ],
    'h2_fallback': [
        '| 影响等级 | 🟡 Normal |', '',
        '## 3. 代码改动范围', '', '| # | 文件 |', '|:--:|:--|', '| 1 | `page/h.vue` |', '',
        '## 4. 接口设计', '',
    ],
}

EXPECT = {
    'pass': 'PASS', 'empty_ok': 'PASS', 'skip': 'SKIP', 'exempt': 'EXEMPT',
    'miss_filter': 'ERR', 'miss_col': 'ERR', 'empty_bad': 'ERR', 'anchor_only': 'ERR',
    'h2_fallback': 'ERR',
}


def self_test():
    import tempfile
    ok = 0
    fails = []
    for name, lines in SAMPLE.items():
        fd, tmp = tempfile.mkstemp(suffix='.md', prefix='03chk-')
        os.close(fd)
        try:
            with io.open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write('\n'.join(lines) + '\n')
            got = judge(tmp)['status']
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        if got == EXPECT[name]:
            ok += 1
        else:
            fails.append('%s: 期望 %s 实得 %s' % (name, EXPECT[name], got))
    print('self-test: %d/%d 通过' % (ok, len(SAMPLE)))
    for f in fails:
        print('  [FAIL] %s' % f)
    return 0 if not fails else 1


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--doc', help='指定 03 方案路径')
    ap.add_argument('--all', action='store_true', help='全量扫描（存量只 WARN）')
    ap.add_argument('--check-templates', action='store_true', help='断言模板侧改动仍在位')
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
                print('[OK] 模板侧 %d 项断言全通过（04 条目 / 05 清单 8 项 / 05 标记 / 03 挂载点）'
                      % (len(TEMPLATE_CHECKS) + 1))
        return 1 if errs else 0

    if a.all:
        base = docs_dir()
        docs = []
        for d in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            p = os.path.join(base, d, '03-技术方案', '03-技术方案.md')
            if os.path.exists(p):
                docs.append(p)
        results = [judge(p) for p in docs]
        trig = [r for r in results if r['status'] in ('PASS', 'ERR')]
        exempt = [r for r in results if r['status'] == 'EXEMPT']
        skip = [r for r in results if r['status'] == 'SKIP']
        bad = [r for r in results if r['status'] == 'ERR']
        for r in bad:
            print('[WARN] %s' % r['path'])
            for e in r['errs']:
                print('       - %s' % e)
        print('存量统计：共 %d 份 03 ｜ 触发 %d ｜ 通过 %d ｜ 缺表 %d ｜ 极简豁免 %d ｜ 不判定 %d'
              % (len(results), len(trig), len(trig) - len(bad), len(bad), len(exempt), len(skip)))
        print('口径：存量只报 WARN（不带历史红）；新迭代由默认模式 + audit-engine A11 判 ERR。')
        if a.json:
            print(json.dumps({'mode': 'all', 'total': len(results), 'triggered': len(trig),
                              'failed': len(bad), 'exempt': len(exempt), 'skipped': len(skip),
                              'errs': [{'path': r['path'], 'errs': r['errs']} for r in bad]},
                             ensure_ascii=False))
        return 1 if (a.strict and bad) else 0

    if a.doc:
        path = a.doc if os.path.isabs(a.doc) else os.path.join(PROJECT_ROOT, a.doc)
    else:
        it = active_iteration()
        if not it:
            print('[SKIP] 无活跃迭代（ACTIVE = none）⇒ 本次不校验')
            return 0
        path = os.path.join(docs_dir(), it, '03-技术方案', '03-技术方案.md')

    res = judge(path)
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        tag = {'PASS': '[OK]', 'EXEMPT': '[EXEMPT]', 'SKIP': '[SKIP]', 'ERR': '[ERR]'}[res['status']]
        print('%s %s' % (tag, res['path']))
        for n in res['notes']:
            print('      · %s' % n)
        for e in res['errs']:
            print('      - %s' % e)
        if res['status'] == 'ERR':
            print('      修法：补 `#### 2.3.1 列定义表` / `#### 2.3.2 检索条件表` 两节并填表；'
                  '本页确无列表/检索区 ⇒ 在该节正文写「无」。极简迭代请在元信息标 🟢。')
    if res['status'] == 'ERR':
        return 1
    if a.strict and res['warns']:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
