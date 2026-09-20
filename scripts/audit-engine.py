#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Engine 一致性审计（A1~A6）—— 纯读脚本，**不写任何文件**。

用法：
    python scripts/audit-engine.py                  # 审计本 skill 实例
    python scripts/audit-engine.py --src <DIR>      # 追加 A6 回流水位检查（源仓库目录）
    python scripts/audit-engine.py --strict         # WARN 也计入退出码

退出码：0 = 无 ERR；1 = 有 ERR（--strict 下含 WARN）

维度：
    A1 孤儿文件      engine/*.md 与 scripts/* 至少被「加载路径」（engine/scripts/根级 md）引用
    A2 步骤 ID 闭环  phase-steps ↔ complexity-scoring / phase-0X / SKILL / cross-review
    A3 产出物名      标准命名表声明的产出名须在对应 phase-0X.md 出现
    A4 引用存在      引擎层反引号内的跨文件引用目标须存在
    A5 治理文档时效  a 内容日期（>7 天） b 联动（引擎已改） c mtime 与内容日期背离（>3 天）
    A6 回流水位      项目侧 skill ↔ 源仓库（缺路径则 SKIP）

规范页：engine/consistency-checklist.md
"""

import argparse
import os
import re
import sys
from datetime import date

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# ── 配置 ────────────────────────────────────────────────────
SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEXT_EXTS = ('.md', '.py', '.mjs', '.json', '.yaml', '.yml', '.ps1', '.sh')

# ★ 核心文件（`engine/evolution-safety.md` §一 的清单**以本常量为准**，避免双源漂移）
CORE_FILES = [
    'hooks/gate-check.mjs',
    'engine/gate-protocol.md',
    'engine/state-protocol.md',
    'SKILL.md',
]

# A1：允许「有意孤立」的文件（登记于此）
ORPHAN_ALLOW = set()

# A1：不参与孤儿检测
ORPHAN_SKIP = {'__init__.py'}

# A2：完整步骤 ID（要求「数字 + 至少一个 -段」；★ 借此前缀式简写如 `step-1` 不再误报）
STEP_ID_RE = re.compile(r'\bstep-[0-9]+x?(?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9.]*)+')
# A2：表格行内的步骤 ID（★ 同样要求「+」：`step-1.1` 这类漏斗**子步骤**不属阶段步骤，不参与闭环判定）
TABLE_ID_RE = re.compile(r'^\|\s*(step-[0-9]+x?(?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9.]*)+)\s*\|')
# A2：历史说明行标记 —— 同一行内提及旧 ID 用于说明更名/迁移时不算「未登记」
HIST_HINT_RE = re.compile(r'更名|原写|原名|已统一|历史|移除|迁移|废弃|曾用|旧')

# A4：预期不在本 skill 内的引用目标（hook / 运行时产物 / 项目与知识库文档）
EXTERNAL_TARGETS = {
    'gate-check.mjs', 'gate-notify.json', 'MEMORY.md', 'state.yaml',
    'backup_manifest.yaml', 'CONTEXT.md', 'L1-overview.md', 'L2-module.md',
    'L3-glossary.md', 'AGENTS.md', 'CLAUDE.md', 'oracle_server.py',
    'gen_entity.py', 'run_ddl.py', 'package.json',
    # 迭代阶段产出物（无 `NN-` 前缀的写法 —— 运行时才生成，不在 skill 内）
    '开发任务清单.md', '需求分析.md', '需求记录.md', '需求评审.md',
    '技术方案.md', '测试验证报告.md', '发布上线记录.md',
    '迭代回顾.md', '迭代回顾报告.md', 'Phase-01-需求记录.md',
}
PLACEHOLDER_RE = re.compile(r'(?:^|[^A-Za-z])(NN|NNN|0X|YYYY|MM|DD|XXX)(?:[^A-Za-z]|$)')

# A5：治理文档（元层规范 —— 低频更新正常，长期不动 = 脱节）
GOV_DOCS = [
    'engine/evolution-safety.md',
    'engine/consistency-checklist.md',
    'runtime/SESSION-HANDOFF.md',
]
GOV_STALE_DAYS = 7          # A5-a：内容日期距今超过此值 ⇒ WARN
GOV_DRIFT_DAYS = 3          # A5-c：mtime 与内容日期背离超过此值 ⇒ WARN

# A4：迭代阶段文档前缀（运行时产物，不在 skill 内）
STAGE_DOC_RE = re.compile(r'^(?:\d{2}-|[Pp]hase-\d{2}-)')

TODAY = date.today()
RESULTS = []                # (level, dim, msg)  level ∈ OK/WARN/ERR/SKIP


def ok(dim, msg):
    RESULTS.append(('OK', dim, msg))


def warn(dim, msg):
    RESULTS.append(('WARN', dim, msg))


def err(dim, msg):
    RESULTS.append(('ERR', dim, msg))


def skip(dim, msg):
    RESULTS.append(('SKIP', dim, msg))


def read(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except Exception:
        return ''


def rel(path):
    try:
        return os.path.relpath(path, SKILL_ROOT).replace('\\', '/')
    except Exception:
        return path


def strip_change_log(text):
    """剔除「变更记录 / 历史」段 —— 其中旧 ID、旧日期属留痕，不参与一致性判定。"""
    out = []
    skipping = False
    for line in text.splitlines():
        if re.match(r'^#{2,3}\s*(变更记录|历史|修订记录|Changelog)', line.strip()):
            skipping = True
            continue
        if skipping and re.match(r'^#{1,3}\s', line):
            skipping = False
        if not skipping:
            out.append(line)
    return '\n'.join(out)


def _add(pool, p, skip_rel):
    r = rel(p)
    if r == skip_rel or r.endswith('.bak'):
        return
    pool[r] = read(p)


def collect_texts(skip_rel=None, scope='engine'):
    """收集引用池。

    scope='engine' ⇒ 仅「引擎加载路径」：`engine/**` · `scripts/**` · 根级 `*.md`
        ★ **不含 `runtime/` 与 `project/`** —— 它们是运行状态 / 项目实例数据，
          其中提到某文件名 **不等于** 该文件被接入加载路径（否则 A1 假阴性：
          审计工单里写一句"某某.md 已停摆"，就会让该文件被误判为"已接入"）。
    scope='all'    ⇒ skill 根下全部文本。
    """
    pool = {}
    if scope == 'all':
        walk_roots = [SKILL_ROOT]
    else:
        walk_roots = [os.path.join(SKILL_ROOT, s) for s in ('engine', 'scripts')]
    for wr in walk_roots:
        for dirpath, dirnames, filenames in os.walk(wr):
            dirnames[:] = [d for d in dirnames if d not in ('__pycache__', '.git')]
            for fn in filenames:
                if fn.endswith(TEXT_EXTS):
                    _add(pool, os.path.join(dirpath, fn), skip_rel)
    if scope != 'all':
        for fn in sorted(os.listdir(SKILL_ROOT)):
            p = os.path.join(SKILL_ROOT, fn)
            if os.path.isfile(p) and fn.endswith(TEXT_EXTS):
                _add(pool, p, skip_rel)
    return pool


# ── A1 孤儿文件 ─────────────────────────────────────────────
def a1_orphan():
    cands = []
    eng = os.path.join(SKILL_ROOT, 'engine')
    for fn in sorted(os.listdir(eng)):
        p = os.path.join(eng, fn)
        if os.path.isfile(p) and fn.endswith('.md'):
            cands.append('engine/' + fn)
    sc = os.path.join(SKILL_ROOT, 'scripts')
    for fn in sorted(os.listdir(sc)):
        if fn.endswith('.py') and fn not in ORPHAN_SKIP:
            cands.append('scripts/' + fn)

    found = 0
    for c in cands:
        base = os.path.basename(c)
        if base in ORPHAN_ALLOW:
            ok('A1', '%s（已登记为有意孤立）' % c)
            continue
        hit = []
        for r, text in collect_texts(skip_rel=c, scope='engine').items():
            if base in text:
                hit.append(r)
                if len(hit) >= 2:
                    break
        if hit:
            found += 1
        else:
            warn('A1', '孤儿文件（引擎加载路径内无任何引用）: %s —— 接入某加载路径或登记 ORPHAN_ALLOW' % c)
    ok('A1', '候选 %d 个，已接入 %d 个' % (len(cands), found))


# ── A2 步骤 ID 闭环 ─────────────────────────────────────────
def _table_ids(text):
    """抽取「表格第 2 列为 step-ID」的行（正式登记形态）。"""
    ids = set()
    for line in text.splitlines():
        m = TABLE_ID_RE.match(line.strip())
        if m:
            ids.add(m.group(1))
    return ids


def a2_step_ids():
    ps = read(os.path.join(SKILL_ROOT, 'engine', 'phase-steps.md'))
    if not ps:
        err('A2', 'phase-steps.md 不可读')
        return
    authoritative = _table_ids(strip_change_log(ps))
    if not authoritative:
        err('A2', 'phase-steps.md 未解析出步骤 ID（表格格式可能已变）')
        return

    targets = ['engine/phase-%02d.md' % i for i in range(1, 8)] + [
        'engine/complexity-scoring.md',
        'engine/cross-review-protocol.md',
        'SKILL.md',
    ]
    bad_total = 0
    for t in targets:
        text = strip_change_log(read(os.path.join(SKILL_ROOT, t)))
        bad = set()
        for line in text.splitlines():
            ids = set(STEP_ID_RE.findall(line))
            if not ids:
                continue
            # ★ 前缀简写（如 `step-1-5` 之于 `step-1-5-review`）视为引用，不算未登记
            unknown = [i for i in ids if i not in authoritative
                       and not any(a.startswith(i + '-') for a in authoritative)]
            if not unknown:
                continue
            # ★ 历史说明行：提及旧 ID 用于说明更名/迁移（如"step-1x-cross-review 更名为 step-1x-review"）
            if HIST_HINT_RE.search(line):
                continue
            bad.update(unknown)
        if bad:
            bad_total += len(bad)
            err('A2', '%s 出现未登记步骤 ID: %s' % (t, ', '.join(sorted(bad))))
    for i in range(1, 8):
        t = 'engine/phase-%02d.md' % i
        missing = sorted(x for x in _table_ids(strip_change_log(read(os.path.join(SKILL_ROOT, t))))
                         if x not in authoritative)
        if missing:
            bad_total += len(missing)
            err('A2', '%s 步骤表含权威表（phase-steps.md）未登记的 ID: %s' % (t, ', '.join(missing)))
    if bad_total == 0:
        ok('A2', '步骤 ID 闭环（权威 %d 个，%d 个文件全部命中）' % (len(authoritative), len(targets)))


# ── A3 产出物名 ─────────────────────────────────────────────
def a3_doc_names():
    we = read(os.path.join(SKILL_ROOT, 'engine', 'workflow-engine.md'))
    if not we:
        err('A3', 'workflow-engine.md 不可读')
        return
    table = {}
    for line in we.splitlines():
        m = re.match(r'^\|\s*0?(\d)\s*\|\s*`([^`]+\.md)`\s*\|', line.strip())
        if m:
            table.setdefault(m.group(1), set()).add(m.group(2))
    if not table:
        warn('A3', 'workflow-engine.md 未解析出标准命名表')
        return
    bad = 0
    for stage, names in sorted(table.items()):
        ph = read(os.path.join(SKILL_ROOT, 'engine', 'phase-%s.md' % stage.zfill(2)))
        if not ph:
            continue
        for n in sorted(names):
            # 允许不带 `NN-` 前缀的写法
            if n not in ph and n.split('-', 1)[-1] not in ph and n[:-3] not in ph:
                warn('A3', '标准表声明的产出名 %s（阶段 %s）未在 phase-%s.md 出现'
                     % (n, stage, stage.zfill(2)))
                bad += 1
    if bad == 0:
        ok('A3', '标准命名表 %d 个阶段、%d 个产出名均在各 phase 文件出现'
           % (len(table), sum(len(v) for v in table.values())))


# ── A4 引用存在（引擎层） ───────────────────────────────────
def a4_refs():
    pool = collect_texts(scope='engine')
    ref_re = re.compile(
        r'`([A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5\-./]*\.'
        r'(?:md|py|mjs|json|yaml|yml|ps1|sh))`')
    on_disk = set()
    for dirpath, dirnames, filenames in os.walk(SKILL_ROOT):
        dirnames[:] = [d for d in dirnames if d not in ('__pycache__', '.git')]
        for fn in filenames:
            on_disk.add(fn)

    missing = {}
    for r, text in pool.items():
        for m in ref_re.finditer(text):
            name = m.group(1)
            base = os.path.basename(name)
            if name.startswith(('http', '{{', '{IDE}')):
                continue
            if (STAGE_DOC_RE.match(base) or base in EXTERNAL_TARGETS
                    or base.endswith('.state.yaml') or PLACEHOLDER_RE.search(base)):
                continue
            if base in on_disk or name in pool:
                continue
            missing.setdefault(base, set()).add(r)
    if missing:
        for base, srcs in sorted(missing.items()):
            warn('A4', '引用目标未在本 skill 内找到: %s（出现于 %s）'
                 % (base, ', '.join(sorted(srcs)[:3])))
    else:
        ok('A4', '引擎层跨文件引用目标均存在（扫描 %d 个文件）' % len(pool))


# ── A5 治理文档时效 ─────────────────────────────────────────
def a5_gov_docs():
    if not GOV_DOCS:
        skip('A5', '未配置治理文档')
        return
    for g in GOV_DOCS:
        p = os.path.join(SKILL_ROOT, g)
        if not os.path.isfile(p):
            err('A5', '%s 不存在' % g)
            continue
        text = read(p)
        best = None
        for y, mo, d in re.findall(r'(20\d{2})-(\d{2})-(\d{2})', text):
            try:
                dt = date(int(y), int(mo), int(d))
            except ValueError:
                continue
            if dt > TODAY:
                continue
            if best is None or dt > best:
                best = dt
        if best is None:
            warn('A5', '%s 未找到任何日期，无法判定时效' % g)
        else:
            age = (TODAY - best).days
            if age > GOV_STALE_DAYS:
                warn('A5', '%s 内容日期 %s（%d 天前）> 阈值 %d 天 —— 规范可能已脱节'
                     % (g, best.isoformat(), age, GOV_STALE_DAYS))
            else:
                ok('A5', '%s 内容日期 %s（%d 天）' % (g, best.isoformat(), age))
            mt = date.fromtimestamp(os.path.getmtime(p))
            drift = abs((mt - best).days)
            if drift > GOV_DRIFT_DAYS:
                warn('A5', '%s 记账背离：mtime %s vs 内容日期 %s（差 %d 天）—— 疑似「改了未更新变更记录」'
                     % (g, mt.isoformat(), best.isoformat(), drift))
        # A5-b 联动（★ 排除「同批改动」：仅统计 24 小时之后的 engine 变更，
        #   否则"本次同批改了规范又改了 phase 文件"会被误报成"引擎已改、规范未跟"）
        newer = 0
        mt_ts = os.path.getmtime(p)
        eng = os.path.join(SKILL_ROOT, 'engine')
        for dirpath, dirnames, filenames in os.walk(eng):
            dirnames[:] = [d for d in dirnames if d not in ('__pycache__',)]
            for fn in filenames:
                try:
                    if os.path.getmtime(os.path.join(dirpath, fn)) - mt_ts > 86400:
                        newer += 1
                except OSError:
                    pass
        if newer > 0:
            warn('A5', '%s 联动：自其 mtime 以来 engine/ 有 %d 个文件更新 —— 引擎已改、规范未跟' % (g, newer))
        else:
            ok('A5', '%s 联动：其后无 engine/ 变更' % g)


# ── A6 回流水位 ─────────────────────────────────────────────
def a6_reflux(src_dir):
    if not src_dir:
        skip('A6', '未提供源仓库路径（--src 或环境变量 IWF_ENGINE_SRC）⇒ 跳过')
        return
    if not os.path.isdir(src_dir):
        skip('A6', '源仓库目录不存在: %s' % src_dir)
        return
    diffs = []
    for sub in ('engine', 'scripts'):
        d = os.path.join(SKILL_ROOT, sub)
        s = os.path.join(src_dir, sub)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(('.md', '.py')):
                continue
            b = os.path.join(s, fn)
            if not os.path.isfile(b):
                diffs.append('%s/%s（源仓库缺失）' % (sub, fn))
                continue
            # 源仓库为模板形态（含 {{…}} 占位）⇒ 宽松比对：剥掉占位符标记后再看
            ta = re.sub(r'\{\{[^}]*\}\}', '', read(os.path.join(d, fn)))
            tb = re.sub(r'\{\{[^}]*\}\}', '', read(b))
            if ta.strip() != tb.strip():
                diffs.append('%s/%s' % (sub, fn))
    if diffs:
        warn('A6', '与源仓库不一致 %d 项：%s' % (len(diffs), ', '.join(diffs[:12])))
    else:
        ok('A6', '与源仓库一致')


# ── main ────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description='Engine 一致性审计（纯读）')
    ap.add_argument('--src', default=os.environ.get('IWF_ENGINE_SRC', ''),
                    help='源仓库目录（A6 回流水位；缺省读 IWF_ENGINE_SRC）')
    ap.add_argument('--strict', action='store_true', help='WARN 也计入退出码')
    args = ap.parse_args()

    print('=== Engine 一致性审计 · %s ===' % TODAY.isoformat())
    print('skill root: %s' % SKILL_ROOT)
    print('')

    for name, fn in (('A1', a1_orphan), ('A2', a2_step_ids), ('A3', a3_doc_names),
                     ('A4', a4_refs), ('A5', a5_gov_docs)):
        try:
            fn()
        except Exception as e:
            err(name, '维度执行异常: %r' % (e,))
    try:
        a6_reflux(args.src)
    except Exception as e:
        err('A6', '维度执行异常: %r' % (e,))

    order = {'ERR': 0, 'WARN': 1, 'OK': 2, 'SKIP': 3}
    for lvl, dim, msg in sorted(RESULTS, key=lambda x: (x[1], order[x[0]])):
        print('[%-4s] %s  %s' % (lvl, dim, msg))

    n_err = sum(1 for r in RESULTS if r[0] == 'ERR')
    n_warn = sum(1 for r in RESULTS if r[0] == 'WARN')
    n_ok = sum(1 for r in RESULTS if r[0] == 'OK')
    print('')
    print('--- 汇总：ERR %d / WARN %d / OK %d ---' % (n_err, n_warn, n_ok))
    if n_err:
        print('⇒ 存在 ERR：确定性不一致，请修复后重跑')
    elif n_warn:
        print('⇒ 无 ERR；WARN 为提示项（可登记 runtime/TOOLING-TODO.md 后延后处置）')
    else:
        print('⇒ 全部通过')
    return 1 if (n_err or (args.strict and n_warn)) else 0


if __name__ == '__main__':
    sys.exit(main())
