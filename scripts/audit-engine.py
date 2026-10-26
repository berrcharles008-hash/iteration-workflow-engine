#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Engine 一致性审计（A1~A6）—— 纯读脚本，**不写任何文件**。

用法：
    python scripts/audit-engine.py                  # 审计本 skill 实例
    python scripts/audit-engine.py --src <DIR>      # 追加 A6 回流水位检查（DIR = 引擎仓库根，含 engine/ 与 scripts/）
    python scripts/audit-engine.py --strict         # WARN 也计入退出码

退出码：0 = 无 ERR；1 = 有 ERR（--strict 下含 WARN）

维度：
    A1 孤儿文件      engine/*.md 与 scripts/* 至少被「加载路径」（engine/scripts/根级 md）引用
    A2 步骤 ID 闭环  phase-steps ↔ complexity-scoring / phase-0X / SKILL / cross-review
    A3 产出物名      标准命名表声明的产出名须在对应 phase-0X.md 出现
    A4 引用存在      引擎层反引号内的跨文件引用目标须存在
    A5 治理文档时效  a 内容日期（>7 天） b 联动（引擎已改） c mtime 与内容日期背离（>3 天）
    A6 回流水位      项目侧 skill ↔ 源仓库（缺路径则 SKIP）
    A8 等待点指针    含"等待用户"类确认表述的 engine md 须挂 `waiting-protocol.md` 指针（★ E4，RESUME-3 批次 1）
    A10 通用性自检   a 项目 token / c 派生表对账 / d 落点存在性（★ 2026-10-24 批次 0；b/e 依赖批次 2 ⇒ 显式 SKIP）

规范页：engine/consistency-checklist.md
"""

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# ── 配置 ────────────────────────────────────────────────────
SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEXT_EXTS = ('.md', '.py', '.mjs', '.json', '.yaml', '.yml', '.ps1', '.sh')

# ★ 核心文件（`engine/evolution-safety.md` §一 的清单**以本常量为准**，避免双源漂移）
# ★ E-3（2026-10-01-002）：实现已由 HOOK-SLIM-1 迁至 `engine/gate/gate-check.mjs`，
#   `hooks/gate-check.mjs` 降为转发 shim（skill 内该文件已不存在）⇒ 改列真实实现。
CORE_FILES = [
    'engine/gate/gate-check.mjs',
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
# ★ W-1（2026-10-02 迭代 2026-10-01-002）：显式登记 3 项实测外部/宿主侧目标（A4 原报 3 条 WARN）：
#   `gen_doc_index.py`  = 项目级工具（`tools/gen_doc_index.py`，实测存在）
#   `wait-answer.ps1`   = 项目级工具（`tools/qqbot/wait-answer.ps1`，实测存在）
#   `probe-readonly-gate.mjs` = 本 skill 的**运行时产物**，随宿主侧落盘（★ 复核 R19 修正：本仓实测在 `.codebuddy` 侧 runtime/ —— 原注释写 `.claude` 与实测相反）
EXTERNAL_TARGETS = {
    'gate-check.mjs', 'gate-notify.json', 'MEMORY.md', 'state.yaml',
    # ★ FIX-49（2026-10-15）：`settings.json` = **宿主侧**文件（`{IDE}/settings.json` 的 Stop 链），
    #   随 state-protocol.md §9.0「宿主共享点清单」首次被引用（A4 原报 1 条 WARN）⇒ 显式登记。
    'settings.json',
    'gen_doc_index.py', 'wait-answer.ps1', 'probe-readonly-gate.mjs',
    'backup_manifest.yaml', 'CONTEXT.md', 'L1-overview.md', 'L2-module.md',
    'L3-glossary.md', 'AGENTS.md', 'CLAUDE.md', 'oracle_server.py',
    'gen_entity.py', 'run_ddl.py', 'package.json',
    # ★ 2026-10-05 tools/qqbot 入库（引擎顶层 tools/qqbot）：waiting-protocol/phase-04
    #   引用的可选工具脚本，登记以免 A4 误报（文件现随 tools/qqbot 分发，实测存在）
    'poll-answer.js', 'ask.js', 'notify.qqbot.js', 'notify-enqueue.js',
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
# ★ W-2（2026-10-02 迭代 2026-10-01-002）：显式「按需刷新」口径 —— 文档首部含本标记 ⇒ 跳过 A5-a/A5-b。
#   依据（用户 2026-10-01 拍板 Q5）：`runtime/SESSION-HANDOFF.md` 的定位是**交接快照**（按需刷新），
#   不是低频治理规范；不声明则每迭代都会复报同一条 WARN（该文件实测连续多期报警）。
A5_ON_DEMAND_MARK = 'A5-ON-DEMAND'

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


# ── A4b {IDE} 类令牌近形笔误（★ E-6，2026-09-30-001）────────
# 背景：`{IDE}`（单花括号 = 运行时变量）无机械校验，写错不报错；渲染层 `{{IDE_DIR}}` 须双花括号。
# 策略：只对**已知变量集的近形**报 WARN（不做全量白名单，避免误伤模板占位符如 {角色名}/{业务名}）。
VAR_TYPO_PATTERNS = [
    (re.compile(r'(?<!\{)\{IDE_DIR\}(?!\})'), '{IDE_DIR} 单花括号 —— 运行时变量应为 {IDE}；渲染层应为 {{IDE_DIR}}'),
    (re.compile(r'(?<!\{)\{IDEDIR\}(?!\})'), '{IDEDIR} —— 疑似 {IDE_DIR} 笔误'),
    # 注：`{ID}` 已**有意排除** —— 流程图中作通用占位符（如 `runtime/{ID}.state.yaml`）属合法写法，
    #     逐处判定为 WARN 会淹没信号（实测 11 处全为流程图用法）；只保留无歧义的近形。
    (re.compile(r'(?<!\{)\{ITERATIONID\}(?!\})'), '{ITERATIONID} —— 疑似 {ITERATION_ID} 笔误'),
    (re.compile(r'(?<!\{)\{PROJECTROOT\}(?!\})'), '{PROJECTROOT} —— 疑似 {PROJECT_ROOT} 笔误'),
    (re.compile(r'(?<!\{)\{KBDIR\}(?!\})'), '{KBDIR} —— 疑似 {KB_DIR} 笔误'),
]


def a4b_var_typos():
    hits = []
    scanned = 0
    for dirpath, _dirs, files in os.walk(os.path.join(SKILL_ROOT, 'engine')):
        for fn in files:
            if not fn.endswith('.md'):
                continue
            p = os.path.join(dirpath, fn)
            try:
                txt = open(p, encoding='utf-8').read()
            except Exception:
                continue
            scanned += 1
            for rx, desc in VAR_TYPO_PATTERNS:
                for m in rx.finditer(txt):
                    line = txt.count('\n', 0, m.start()) + 1
                    rel = os.path.relpath(p, SKILL_ROOT).replace('\\', '/')
                    hits.append('%s:%d %s' % (rel, line, desc))
    if hits:
        for h in hits[:10]:
            warn('A4b', h)
        if len(hits) > 10:
            warn('A4b', '另有 %d 处（略）' % (len(hits) - 10))
    else:
        ok('A4b', '{IDE}/{{IDE_DIR}} 类令牌无近形笔误（扫描 %d 个 engine md）' % scanned)


# ── A8 等待点指针完备（★ E4，RESUME-3 批次 1，2026-10-01）────
# （编号 A7 已被规范页"状态字段登记闭环"（人工核）占用 ⇒ 机械维度顺延为 A8）
# 背景：确认门等待机制曾只挂在 phase-04（2026-09-30 真实迭代确认门主动登记 0 次，
#       10-01 04→05 由离机指令穿透 §三-B 且事后无审计痕迹）。
# 规则：engine/**（含 templates/）中含"等待用户"类确认表述的 md，必须含
#       `waiting-protocol.md` 引用（指针行），否则 ERR（文档级防漏挂；
#       防"执行漏跑"属批次 3 强制层，不在此覆盖）。
WAIT_POINT_RE = re.compile(
    r'等待用户(?:明确)?(?:确认|选择|拍板)'   # 等待用户确认/等待用户明确确认/等待用户选择/拍板
    r'|用户确认[“”\'"][^”"\'"]{2,12}[”"\'"]'  # 用户确认"测试通过"/"评审通过"等
    r'|待用户拍板|须用户确认')
WAIT_PROTO_REF = 'waiting-protocol.md'


def a8_wait_points():
    hits = []
    scanned = 0
    eng = os.path.join(SKILL_ROOT, 'engine')
    for dirpath, _dirs, files in os.walk(eng):
        for fn in files:
            if not fn.endswith('.md'):
                continue
            p = os.path.join(dirpath, fn)
            try:
                txt = open(p, encoding='utf-8').read()
            except Exception:
                continue
            scanned += 1
            if WAIT_POINT_RE.search(txt) and WAIT_PROTO_REF not in txt:
                rel = os.path.relpath(p, SKILL_ROOT).replace('\\', '/')
                line = txt.count('\n', 0, WAIT_POINT_RE.search(txt).start()) + 1
                hits.append('%s:%d' % (rel, line))
    if hits:
        for h in hits:
            err('A8', '%s 含确认等待表述但未挂 `%s` 指针' % (h, WAIT_PROTO_REF))
    else:
        ok('A8', '等待点指针完备（扫描 %d 个 engine md）' % scanned)


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
        if A5_ON_DEMAND_MARK in text:
            ok('A5', '%s 声明「按需刷新」（%s）⇒ 跳过时效/联动判定' % (g, A5_ON_DEMAND_MARK))
            continue
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
    # ★ 2026-10-10（回流实测）：--src 必须传**引擎仓库根**（其下应有 engine/ 与 scripts/）。
    #   历史多次误传上级目录（如 D:\sj-skills）⇒ 每条都判「源仓库缺失」，产出恒定 42 项**假水位**。
    if not os.path.isdir(os.path.join(src_dir, 'engine')) and not os.path.isdir(os.path.join(src_dir, 'scripts')):
        err('A6', '源仓库路径疑似传了上级目录（应传引擎仓库根，含 engine/ 与 scripts/）: %s' % src_dir)
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


# ── A10 通用性自检（★ 2026-10-24 迭代 2026-10-24-001 · 批次 0）───────────
#
# 设计要点（为什么这样写，而非"照抄一遍公式"）：
#   ① 黑名单 token **全部从 manifest 派生**，脚本内不写死任何项目 token ——
#      否则检查器自己就是新的硬编码源（会自命中，且换项目即失效）。
#   ② 期望三表由本脚本**独立**算（自带二级 YAML 解析）；node 的 `--print` 只当**被检对象**。
#      两侧同源会「一起错也绿」= 循环自证（3 路评审 R-06）。
#   ③ 级别口径（D1/D2）：命中登记基线 ⇒ WARN（逐条带文件:行 + 批次号）；
#      未登记 ⇒ ERR；A10_ALLOW ⇒ 不报，仅计数。`--strict` 语义不变。
#   ④ A10-b/A10-e 已于批次 2（2026-10-25）实检上线：b = engine 内占位符全在 schema 内
#      + 协议表成员与 schema 一致（双判据；schema SSOT = inject-template.py 五常量）；
#      e = `inject-template --check --compare SKILL.md` 逐字节一致（模板漂移即红）。
#      两者均为 ERR —— 静默 SKIP 会让读输出的人以为已实现（2026-10-25 前的实际形态）。
A10_SCAN_DIRS = ('engine', 'scripts')
A10_SCAN_EXTS = ('.md', '.py', '.mjs', '.sh', '.ps1', '.json', '.yaml', '.yml')
# ★ C 项（2026-10-26）：原写法只认「## 变更记录」这种裸标题，实测漏掉 4 个**编号式**标题
#   （`## 五、变更记录` · `## 六、历史事故记录` · L1/L2 模板的 `## 四/五、变更记录`）
#   ⇒ 这些节的正文被当成「实现常量/项目词命中」计入，与「跳历史节」的口径不一致。
#   方向：漏跳 = 多计 = 偏松（不产生假红），但会把基线抬虚高。
#   前缀覆盖两种序数写法：中文顿号（`五、`）与阿拉伯（`5.` / `5、`）；`\s*` 提到组外，
#   使 `## 五、 变更记录`（顿号后再跟空格）同样命中。
A10_HISTORY_RE = re.compile(r'^#{2,3}\s*(?:[一二三四五六七八九十百]+、|\d+[、.])?\s*(变更记录|历史|修订记录|Changelog)', re.I)
A10_MANIFEST = os.path.join(SKILL_ROOT, 'project', 'project.manifest.yaml')

# 登记基线：键 = 台账 G 编号，值 = 批次号。命中 ⇒ WARN，明细仍逐条列出（判据 #1 要可定位）
# ★ 2026-10-25（迭代 2026-10-25-003 · D6）：G02/G16/G17/G18 结案后条目已移除。
#   注意：这 4 项在 A10_HIT_MAP 里**没有**映射行（该表只映射 G03/G06/G07/G08/G10/G13），
#   故删条目对行为零影响 ⇒ 属**记账动作**；结案判据以「A10-a 未登记命中 = 0」为准，不是「回归即 ERR」。
A10_BASELINE = {
    'G01': '1A', 'G03': '1A', 'G04': '2', 'G05': '2',
    'G06': '4', 'G07': '3', 'G08': '3', 'G09': '3', 'G10': '1A',
    'G11': '3', 'G12': '1B', 'G13': '5', 'G14': '2', 'G15': '2',
    'G19': '2',
}

# 逐条豁免（≤10）：5 条均为 G03「旧名兼容一版」的正当提及；旧名删除窗口开启时一并清理
A10_ALLOW = {
    ('engine/gate/exempt-tables.mjs', 'T2'),            # LEGACY_HANDOFF_ENV（唯一代码字面量）
    ('engine/templates/cold-start-gate-nucleus.md', 'T2'),
    ('engine/gate-protocol.md', 'T2'),
    ('engine/state-protocol.md', 'T2'),
    ('scripts/run-gate-tests.mjs', 'T2'),               # 判据 #6「旧名仍放行」的回归用例本身
}

# 命中 → G 编号（**自上而下首个匹配**；未命中 ⇒ UNREG ⇒ ERR）
A10_HIT_MAP = [
    ('scripts/memory_quota.py', ('T1', 'T2', 'T6'), 'G08'),
    ('scripts/gen-knowledge-base.py', ('T1', 'T2', 'T6'), 'G07'),
    ('scripts/run-gate-tests.mjs', ('T4', 'T5'), 'G10'),
    # ★ 2026-10-24：三张豁免表已迁出 gate-check ⇒ 该目录不再有「业务根字面量数据」；
    #   命中只可能来自注释里的举例，按 G06（正文混入项目内容）归类。G01 修好后自然 0 命中。
    ('engine/gate/**', ('T4', 'T5'), 'G06'),
    ('engine/gate/**', ('T2',), 'G03'),
    ('engine/templates/**', ('T1', 'T2', 'T6'), 'G06'),
    ('*', ('T1', 'T2', 'T6'), 'G06'),
    ('*', ('T3', 'T4', 'T5'), 'G13'),
]

A10_STAT = {'a_hits': 0, 'a_base': 0, 'a_allow': 0, 'a_err': 0, 'a_t7': 0,
            'b': 'SKIP', 'e': 'SKIP', 'f1': 'SKIP', 'f2': 'SKIP',
            'c': 'SKIP', 'd_total': 0, 'd_missing': 0}
A10_BASELINE_PATH = ''      # 由 --a10-baseline / 环境变量注入（引擎内**不写死**迭代路径）
A10_DERIVE_MJS = os.path.join(SKILL_ROOT, 'engine', 'gate', 'derive-exempt.mjs')


def _a10_unquote(raw):
    """去引号 + 去行内注释（`#` 仅在引号外且前为空白时才算注释）。"""
    s = str(raw or '')
    out, q = [], None
    for i, ch in enumerate(s):
        if q:
            if ch == q:
                q = None
            out.append(ch)
            continue
        if ch in ('"', "'"):
            q = ch
            out.append(ch)
            continue
        if ch == '#' and (i == 0 or s[i - 1].isspace()):
            break
        out.append(ch)
    v = ''.join(out).strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        v = v[1:-1]
    return v.strip()


def _a10_load_manifest():
    """本脚本**自己的**二级 YAML 解析（不依赖 node 侧实现 —— 见设计要点 ②）。"""
    if not os.path.isfile(A10_MANIFEST):
        return {}
    try:
        with open(A10_MANIFEST, encoding='utf-8') as f:
            text = f.read().replace('\ufeff', '')
    except Exception:
        return {}
    cfg, section = {}, None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m = re.match(r'^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$', line)
        if not m:
            continue
        indent, key, val = len(m.group(1)), m.group(2), _a10_unquote(m.group(3))
        if indent == 0:
            if val:
                cfg[key] = val
                section = None
            else:
                section = key
        elif indent <= 2 and section:
            cfg[section + '.' + key] = val
    return cfg


def _a10_tokens(cfg):
    """黑名单 token（全部来自 manifest；空则返回 [] ⇒ A10-a SKIP，不静默通过）。"""
    sn = (cfg.get('project.short_name') or '').strip()
    name = (cfg.get('project.name') or '').strip()
    ws = (cfg.get('project.workspace_root') or '').strip().replace('\\', '/')
    fe = (cfg.get('paths.frontend_root') or '').strip().replace('\\', '/')
    be = (cfg.get('paths.backend_root') or '').strip().replace('\\', '/')
    out = []
    if ws:
        out.append(('T3', ws))
        seg = ws.split('/')
        if len(seg) >= 2:
            out.append(('T3', seg[0] + '/' + seg[1] + '/'))   # 盘符 + 一级目录（本机路径特征）
    if name:
        out.append(('T6', name))
    for tid, root in (('T4', fe), ('T5', be)):
        head = root.split('/')[0]
        if head:
            out.append((tid, head + '/'))
    if sn:
        out.append(('T2', sn.upper()))
        out.append(('T1', sn))
    # T7（2026-10-25 新增 · G06）：技术栈/业务专名黑名单由 manifest 提供（audit.doc_deny_tokens）。
    # 为什么不写死在本脚本：词表落进引擎 = 把某个项目的技术栈固化进引擎，与 G06 目标自相矛盾。
    # 假绿守卫：_a10_load_manifest 对缩进/键名错误是**静默丢弃**，缺键时下面的 T1/T4/T5 仍非空
    # ⇒ `not tokens` 兜底永不触发 ⇒ 必须在此显式 warn（R2 唯一假绿入口）。
    deny = (cfg.get('audit.doc_deny_tokens') or '').strip()
    if not deny:
        warn('A10-a', 'audit.doc_deny_tokens 缺失/为空 ⇒ T7 未生效（文档层去项目化不可机检）')
    for tok in [t.strip() for t in deny.split(',') if t.strip()]:
        out.append(('T7', tok))
    # 优先级：路径类（最具体）→ 项目名 → 业务根 → 大写短名 → 短名 → T7（仅文档，末位）
    order = {'T3': 0, 'T6': 1, 'T4': 2, 'T5': 3, 'T2': 4, 'T1': 5, 'T7': 9}
    return sorted(out, key=lambda x: order.get(x[0], 9))


def _a10_match(tid, val, text):
    if not val:
        return False
    if tid in ('T1', 'T2'):
        # 边界只挡字母数字：`PIVAS_HANDOFF_OWNER` / `pivas_admixture_center` 都必须算命中
        # （下划线是项目 token 的常见连接符，若把它当边界会整体漏检 —— 实测 allow=0 即此因）
        return re.search(r'(?<![A-Za-z0-9])' + re.escape(val) + r'(?![A-Za-z0-9])',
                         text, 0 if tid == 'T2' else re.I) is not None
    return val.lower() in text.lower()


def _a10_iter_files():
    for sub in A10_SCAN_DIRS:
        base = os.path.join(SKILL_ROOT, sub)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in ('__pycache__', '.git')]
            for fn in sorted(filenames):
                if fn.endswith(A10_SCAN_EXTS) and not fn.endswith('.bak'):
                    yield os.path.join(dirpath, fn)


def _a10_g_of(rel, tid):
    for glob, tids, g in A10_HIT_MAP:
        if tid in tids and fnmatch.fnmatch(rel, glob):
            return g
    return None


def _a10a():
    cfg = _a10_load_manifest()
    tokens = _a10_tokens(cfg)
    if not tokens:
        skip('A10-a', 'manifest 缺 short_name/workspace_root ⇒ 无黑名单可扫（不静默通过）')
        return
    code_exts = ('.py', '.mjs', '.sh', '.ps1')
    buckets = {}          # G 编号 -> ['file:line', ...]
    first_sample = {}     # G 编号 -> 首个命中行摘要
    for p in _a10_iter_files():
        rel = os.path.relpath(p, SKILL_ROOT).replace('\\', '/')
        is_code = p.endswith(code_exts)
        try:
            with open(p, encoding='utf-8') as f:
                lines = f.read().splitlines()
        except Exception:
            continue
        in_hist = False
        for ln, line in enumerate(lines, 1):
            if A10_HISTORY_RE.match(line.strip()):
                in_hist = True
                continue
            if in_hist and re.match(r'^#{1,3}\s', line):
                in_hist = False
            if in_hist or not line.strip():
                continue
            norm = line.replace('\\', '/')
            for tid, val in tokens:
                # T7（文档层项目专名）**独立计数**，不参与下面「首个命中即 break」的桶归属：
                # 若参与，凡已被 T1~T6 或 A10_ALLOW 覆盖的行都会被短路 ⇒ 行内项目词永不计入
                # ⇒ 「T7 命中 = 0」恒绿（2026-10-25-003 迭代交叉审查 🔴2 实证）。
                if tid == 'T7':
                    if not p.endswith('.md') or not _a10_match(tid, val, norm):
                        continue
                    A10_STAT['a_t7'] += 1
                    err('A10-a', 'T7 未登记命中 %s:%d token=%s（文档层去项目化未完成）%s'
                        % (rel, ln, val, line.strip()[:60]))
                    break
                # 业务根（T4/T5）只在**代码**里算硬编码：文档里的通用占位路径（形如
                # "<业务根>/.../XxxMgr.cs"）是模板示例，capability-map 明文要求项目侧
                # 文件以文字给出 ⇒ 按硬编码报会产生大量假阳性、淹没真信号。
                if tid in ('T4', 'T5') and not is_code:
                    continue
                if not _a10_match(tid, val, norm):
                    continue
                A10_STAT['a_hits'] += 1
                if (rel, tid) in A10_ALLOW:
                    A10_STAT['a_allow'] += 1
                    break
                g = _a10_g_of(rel, tid)
                if g and g in A10_BASELINE:
                    A10_STAT['a_base'] += 1
                    buckets.setdefault(g, []).append('%s:%d' % (rel, ln))
                    first_sample.setdefault(g, line.strip()[:70])
                else:
                    A10_STAT['a_err'] += 1
                    err('A10-a', '未登记命中 %s:%d token=%s（补 A10_HIT_MAP 或修硬编码）%s'
                        % (rel, ln, tid, line.strip()[:80]))
                break
    # 按 G 聚合输出：同一条基线问题常有几十处，逐行刷屏会淹没 ERR 与其它维度
    for g in sorted(buckets):
        items = buckets[g]
        show = ', '.join(items[:3]) + (' …' if len(items) > 3 else '')
        warn('A10-a', '%s·批次%s 命中 %d 处（已登记基线）：%s｜样例: %s'
             % (g, A10_BASELINE[g], len(items), show, first_sample.get(g, '')))


def _a10_expected(cfg):
    """独立算期望三表（顺序必须与 exempt-tables.mjs 逐一对应；见 03 附录 E）。"""
    def dir_of(key, default):
        v = (cfg.get(key) or '').strip()
        return (v if v else default).replace('\\', '/').rstrip('/') + '/'
    docs = dir_of('paths.docs_iterations', 'docs/iterations')
    kb = dir_of('paths.kb_dir', 'docs/knowledge-base')
    specs = dir_of('paths.specs_dir', 'requirements')
    self_ref = ['.codebuddy/skills/iteration-workflow/', '.claude/skills/iteration-workflow/',
                '.cursor/skills/iteration-workflow/', '.codex/skills/iteration-workflow/']
    mem = ['.codebuddy/memory/', '.claude/memory/']
    feas = 'feasibility/'
    files = ['skills/iteration-workflow/project/lessons-learned.md']
    rt = ['ACTIVE', '*.state.yaml']
    return {
        'exemptPaths': self_ref + [docs, kb] + mem,
        'exemptPathsMdOnly': [specs + 'iteration-context/'],
        'stageExempt': {
            '05': {'dirs': [docs, kb], 'mdDirs': [specs]},
            '06': {'dirs': [docs, kb], 'mdDirs': [specs, feas], 'files': list(files)},
            '07': {'dirs': [docs], 'files': list(files)},
            'NONE': {'dirs': [docs], 'mdDirs': [specs, feas], 'runtimeFiles': list(rt)},
        },
    }


def _a10_run_print(env_extra=None):
    """跑 `derive-exempt.mjs --print` → dict；任何异常/非 JSON/超时 ⇒ None（调用方 SKIP）。"""
    if not os.path.isfile(A10_DERIVE_MJS):
        return None
    env = dict(os.environ)
    env.update(env_extra or {})
    try:
        cp = subprocess.run(['node', A10_DERIVE_MJS, '--print'],
                            capture_output=True, timeout=20, env=env)
        out = (cp.stdout or b'').decode('utf-8', 'replace').strip()
        if not out:
            return None
        return json.loads(out.splitlines()[-1])
    except Exception:
        return None


def _a10_variant_ok():
    """变异沙箱：换一份**取值不同**的 manifest，派生必须跟着变（防「直接回显 literal」）。"""
    tmp = tempfile.mkdtemp(prefix='iwf-a10-variant-')
    try:
        mf = os.path.join(tmp, 'project', 'project.manifest.yaml')
        os.makedirs(os.path.dirname(mf), exist_ok=True)
        with open(mf, 'w', encoding='utf-8') as f:
            f.write('project:\n  short_name: "acme"\n'
                    'paths:\n  docs_iterations: "iterations-custom"\n'
                    '  specs_dir: "reqs"\n  kb_dir: "kb-custom"\n')
        out = _a10_run_print({'GATE_TEST_RUNTIME_DIR': tmp, 'GATE_MANIFEST_PATH': mf})
        if not out:
            return None
        tables = out.get('tables') or {}
        got = 'iterations-custom/' in (tables.get('exemptPaths') or [])
        changed = (out.get('diff') or {}).get('equal') is False
        return bool(got and changed)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _a10c():
    if not shutil.which('node'):
        skip('A10-c', 'node 不可用 ⇒ 跳过（不报 ERR）')
        A10_STAT['c'] = 'SKIP'
        return
    cfg = _a10_load_manifest()
    if not cfg:
        warn('A10-c', 'manifest 缺失/不可读 ⇒ 派生回落现值，无法对账')
        A10_STAT['c'] = 'WARN'
        return
    out = _a10_run_print()
    if not out:
        skip('A10-c', 'derive-exempt.mjs 无输出 / 超时 / 非 JSON ⇒ 跳过')
        A10_STAT['c'] = 'SKIP'
        return
    if out.get('schema') != 1:
        err('A10-c', '输出契约版本非 1（schema=%r）⇒ 契约破坏' % (out.get('schema'),))
    exp = _a10_expected(cfg)
    tables = out.get('tables') or {}
    literal = out.get('literal') or {}
    for k in ('exemptPaths', 'exemptPathsMdOnly', 'stageExempt'):
        if exp[k] != tables.get(k):
            err('A10-c', '%s 与独立期望不一致（派生实现与契约不符）' % k)
        if tables.get(k) != literal.get(k):
            detail = (out.get('diff') or {}).get(k) or {}
            err('A10-c', '%s 派生≠现值（等价性破坏；diff=%s）'
                % (k, json.dumps(detail, ensure_ascii=False)[:160]))
    if (out.get('diff') or {}).get('equal') is not True:
        err('A10-c', 'diff.equal 非真 —— shadow 期「零差异」前提被破坏')
    if A10_BASELINE_PATH and os.path.isfile(A10_BASELINE_PATH):
        try:
            with open(A10_BASELINE_PATH, encoding='utf-8') as f:
                base = json.load(f)
            for k in ('exemptPaths', 'exemptPathsMdOnly', 'stageExempt'):
                if literal.get(k) != base.get(k):
                    err('A10-c', '%s 与冻结基线不一致（改动了现值 ⇒ 放行面变更）' % k)
        except Exception as e:
            warn('A10-c', '冻结基线不可解析：%r' % (e,))
    else:
        warn('A10-c', '未提供冻结基线（--a10-baseline）⇒ 跳过「与改码前逐项一致」断言')
    v = _a10_variant_ok()
    if v is False:
        err('A10-c', '变异沙箱失败：换 manifest 后派生未变 ⇒ 疑似回显字面量')
    elif v is None:
        warn('A10-c', '变异沙箱跳过（node 无输出）')
    A10_STAT['c'] = 'OK'


def _a10d():
    """落点存在性：capability-map 落点 + README/CONTRIBUTING 相对链接。
    解析顺序 = skill 根 → engine/ → scripts/ → project/ → 文档同目录（契约目录集合，
    不做全库 basename 匹配 —— 那会与 A4 重复且假阴性，见 P-188）。"""
    docs = [os.path.join(SKILL_ROOT, 'engine', 'capability-map.md'),
            os.path.join(SKILL_ROOT, 'README.md'),
            os.path.join(SKILL_ROOT, 'CONTRIBUTING.md')]
    tok_re = re.compile(r'`([A-Za-z0-9_./-]+\.(?:md|py|mjs|json|yaml|yml|ps1|sh))`')
    link_re = re.compile(r'\]\(([^)#?\s]+)\)')
    bases = ['engine', 'scripts', 'project', '.']
    missing = 0
    for d in docs:
        if not os.path.isfile(d):
            continue
        ddir = os.path.dirname(d)
        try:
            with open(d, encoding='utf-8') as f:
                lines = f.read().splitlines()
        except Exception:
            continue
        for ln, line in enumerate(lines, 1):
            cands = [(m.group(1), False) for m in tok_re.finditer(line)]
            cands += [(m.group(1), True) for m in link_re.finditer(line)]
            for target, is_link in cands:
                if target.startswith(('http', '#', '{{', '{IDE}')):
                    continue
                A10_STAT['d_total'] += 1
                paths = [os.path.join(SKILL_ROOT, target), os.path.join(ddir, target)]
                paths += [os.path.join(SKILL_ROOT, b, target) for b in bases]
                if not any(os.path.isfile(p) for p in paths):
                    missing += 1
                    err('A10-d', '%s:%d %s（%s）'
                        % (os.path.relpath(d, SKILL_ROOT).replace('\\', '/'), ln, target,
                           '相对链接' if is_link else '落点'))
    A10_STAT['d_missing'] = missing
    if missing == 0 and A10_STAT['d_total'] > 0:
        ok('A10-d', '落点/相对链接 %d 个全部存在' % A10_STAT['d_total'])


# ── A10-f：文档内实现符号耦合（批次 5 · 2026-10-25 上线 · G18）──────────────
#
# 为什么分两档（双档是刻意设计，不是偷懒）：
#   f-1 **调用形态**（反引号内 `name()` ∩ gate 实现已定义函数）—— 文档点名门禁内部函数 ⇒
#       重构即失真（改函数名后文档照旧描述，读者按文档找不到实现）。这一类可全量改写 ⇒ ERR，首版豁免为空。
#   f-2 **常量形态**（反引号内 UPPER_SNAKE ∩ gate 顶层 const）—— 实测 31 处是「文档必须点名豁免表」
#       的既有事实，全量改写等于重写门禁文档且语义收益低 ⇒ 改**计数守门**：只拦「新增」，不逼存量。
#   放弃的两个极端：①「出现即报」宽口径实测 164 处（多为 `{{占位符}}` 名）⇒ 噪声淹没信号；
#   ②「实现有同名就放行」不可证伪（永远绿）。
#
# 已知盲区（显式化，别把 f=OK 读成「全解耦」）：
#   ① `A10F_DEF_RE` 只认 `function name`（门禁实现统一风格）；箭头函数赋值/类方法解析不到 ⇒ 符号域缩小。
#   ② 只认「反引号 + 零参调用 + 同行闭合」，围栏内代码块、带参调用（`f(x)`）不在检测面。
#   ③ f-2 超基线才 ERR ⇒ 基线段（=A10F_CONST_BASELINE）内是 WARN，属**允许**的既有耦合。
#   符号域解析失败 ⇒ err（**不用 skip**：skip 不进退出码，等于判据失效却绿灯）。
A10F_ALLOW = {}                 # (相对路径, 函数名) → 理由；首版为空（2026-10-25）
# f-2 实测基线（本实现口径）：**17 处**。口径 = engine/**/*.md + 反引号闭合 +
# **跳过「变更记录/历史」节**（与 A10-a 同口径）；03 方案记的 31 是未跳历史节的裸数，不用它当基线
# （基线取实测值才「只拦新增」，取大值等于放行等量新增）。
# ★ 沿革（2026-10-26 · C 项）：首版取 22（2026-10-25）；此后 G02/G06/G13/G16/G17/G18 收口把实测
#   打到 17，而基线没跟着降 ⇒ 差额 5 处可静默新增（正是本段注释警告的「取大值=放行新增」）。
#   本轮随「编号式变更记录标题」口径修正**同批重测 = 17**，基线一并下收到实测值。
#   注：C 项的正则修正本身**不改变**命中数（那 4 个编号式节内没有常量形态命中）；
#   逐条明细见 runtime/temp/const-before.txt / const-after.txt。
# 重测方法（别只看汇总 PASS）：从项目根跑
#   `python {IDE}/skills/iteration-workflow/runtime/temp/probe_a10_const.py`
#   ——它 import 本文件的 regex/迭代器/符号表，打印每一处命中及行号。
A10F_CONST_BASELINE = 17
A10F_GATE_DIR = os.path.join(SKILL_ROOT, 'engine', 'gate')
A10F_DEF_RE = re.compile(r'function\s+([A-Za-z_$][A-Za-z0-9_$]*)')
A10F_CONST_RE = re.compile(r'^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*=', re.M)
A10F_USE_RE = re.compile(r'`([A-Za-z_$][A-Za-z0-9_$]*)\(\)`')
A10F_CONST_USE_RE = re.compile(r'`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`')


def _a10f_symbols():
    """只读解析 gate 实现（不 import）：返回 (函数名集合, 常量名集合)。

    不 import 的理由：审计脚本 import 门禁模块会带来 side-effect（门禁启动即建锁/写日志），
    且会把两者版本耦合成「改门禁必须改审计」。
    """
    fns, consts = set(), set()
    try:
        for fn in sorted(os.listdir(A10F_GATE_DIR)):
            if not fn.endswith('.mjs'):
                continue
            with open(os.path.join(A10F_GATE_DIR, fn), encoding='utf-8') as f:
                text = f.read()
            fns |= set(A10F_DEF_RE.findall(text))
            consts |= set(A10F_CONST_RE.findall(text))
    except Exception:
        pass
    return fns, consts


def _a10f():
    fns, consts = _a10f_symbols()
    if not fns:
        err('A10-f', 'engine/gate 未解析到函数定义 ⇒ 判据失效（检查目录/编码）')
        A10_STAT['f1'] = 'ERR'
        return
    f1_hits, f2_hits = [], []
    for p in _a10_iter_files():
        if not p.endswith('.md'):
            continue
        rel = os.path.relpath(p, SKILL_ROOT).replace('\\', '/')
        in_hist = False
        try:
            with open(p, encoding='utf-8') as f:
                lines = f.read().splitlines()
        except Exception:
            continue
        for ln, line in enumerate(lines, 1):
            if A10_HISTORY_RE.match(line.strip()):
                in_hist = True
                continue
            if in_hist and re.match(r'^#{1,3}\s', line):
                in_hist = False
            if in_hist:
                continue
            for name in A10F_USE_RE.findall(line):
                if name in fns:
                    f1_hits.append((rel, ln, name))
            for name in A10F_CONST_USE_RE.findall(line):
                if name in consts:
                    f2_hits.append((rel, ln, name))
    bad = 0
    for rel, ln, name in f1_hits:
        if (rel, name) in A10F_ALLOW:
            warn('A10-f', '已登记实现符号 %s:%d %s()' % (rel, ln, name))
        else:
            bad += 1
            err('A10-f', '实现符号未登记 %s:%d %s()（改职责描述，或补 A10F_ALLOW + 理由）'
                % (rel, ln, name))
    A10_STAT['f1'] = 'ERR' if bad else 'OK'
    if not f1_hits:
        ok('A10-f', '文档内实现符号调用形态 0 处')
    n2 = len(f2_hits)
    # 用 const=N/31 而非「基线 31」：A10-a 的 baseline=31 是另一回事（基线命中行数），同串并列会误读
    if n2 > A10F_CONST_BASELINE:
        A10_STAT['f2'] = 'ERR'
        err('A10-f', '实现常量形态 %d 处 > 基线 %d（新增耦合）' % (n2, A10F_CONST_BASELINE))
    else:
        A10_STAT['f2'] = 'OK'
        warn('A10-f', '实现常量形态 const=%d/%d（不阻塞）: %s'
             % (n2, A10F_CONST_BASELINE,
                ', '.join('%s:%d' % (r, l) for r, l, _ in f2_hits[:3])))


# ── A10-b / A10-e：占位符 schema 与注入产物实检（批次 2 · 2026-10-25 上线）────
#
# 为什么 b 要拆成两条判据：
#   ① 只管「engine 里出现的占位符都在 schema 内」—— 防漏注册（新写的 <NEW_THING> 未登记）。
#   ② 管「协议表与 schema 一致」—— schema 加了成员而文档没写（或反之）会让读文档的人按过期
#      口径理解。历史痛点是「文档一套、正则一套、判据一套」，② 就是把这一刀机器化。
#   ② 的比对方式是**解析 §2.4 表格的成员集合**，不靠人工维护第二份清单（否则又是两处真值源）。
A10_INJECT = os.path.join(SKILL_ROOT, 'scripts', 'inject-template.py')
A10_PROTOCOL_DOC = os.path.join(SKILL_ROOT, 'engine', 'template-injection.md')
# ★ 占位符正则**不在这里写**：从 `--schema-dump` 的 `placeholder_re` 取（SSOT = 注入器）。
#   历史上这里是第三份拷贝且更窄（漏 `-`），含连字符的占位符在注入侧报错、在判据① 里看不见
#   ⇒ 判据洞（2026-10-25 step-7 审查 V-4）。`scan-placeholders.py` 走 import 复用，这里走 JSON。
A10_PH_RE = None

A10_SCHEMA_CLASSES = (('①a', 'alias'), ('①b', 'path_style'),
                      ('②', 'runtime_vars'), ('③', 'script_rendered'),
                      ('④', 'content_slot'))


def _a10_py():
    return sys.executable or 'python'


def _a10_schema():
    """跑 `inject-template.py --schema-dump` 取五类 schema；失败返回 None（已 err）。"""
    if not os.path.isfile(A10_INJECT):
        err('A10-b', '找不到 schema SSOT：scripts/inject-template.py')
        return None
    try:
        # 双保险：① 给子进程注入 PYTHONIOENCODING=utf-8（否则它按控制台编码输出 GBK，
        #   中文诊断会退化成替换字符）；② errors='replace' 兜住 reader 线程——
        #   硬按 utf-8 解码会在子线程抛 UnicodeDecodeError，只打栈不改退出码，属静默半失效。
        env = dict(os.environ, PYTHONIOENCODING='utf-8')
        r = subprocess.run([_a10_py(), A10_INJECT, '--schema-dump'],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=120, env=env)
    except Exception as exc:
        err('A10-b', '--schema-dump 执行异常: %s' % exc)
        return None
    if r.returncode != 0:
        err('A10-b', '--schema-dump exit=%d：%s'
            % (r.returncode, ((r.stderr or r.stdout or '').strip())[:200]))
        return None
    try:
        return json.loads(r.stdout)
    except Exception as exc:
        err('A10-b', '--schema-dump 输出非 JSON: %s' % exc)
        return None


def _a10_schema_members(schema):
    """schema → {类键: 成员集合}（alias 取映射来源名，不取展平目标）。"""
    return {
        'alias': set(schema.get('alias') or {}),
        'path_style': set(schema.get('path_style') or []),
        'runtime_vars': set(schema.get('runtime_vars') or []),
        'script_rendered': set(schema.get('script_rendered') or []),
        'content_slot': set(schema.get('content_slot') or []),
    }


def _a10_parse_doc_schema(path):
    """解析 template-injection.md §2.4 表 → {类键: (声明数量字符串, 成员集合)}。"""
    if not os.path.isfile(path):
        return None
    try:
        lines = open(path, encoding='utf-8').read().splitlines()
    except Exception:
        return None
    start = None
    for i, ln in enumerate(lines):
        if ln.strip().startswith('### 2.4'):
            start = i
            break
    if start is None:
        return None
    out = {}
    for ln in lines[start + 1:]:
        s = ln.strip()
        if s.startswith('#'):
            break
        if not s.startswith('|'):
            continue
        cells = [c.strip() for c in s.split('|')[1:-1]]
        if len(cells) < 3:
            continue
        for prefix, key in A10_SCHEMA_CLASSES:
            if cells[0].startswith(prefix):
                toks = [t.strip() for t in re.findall(r'`([^`]+)`', cells[2])]
                # bare = 未写成 <...> 的裸 token（④ 类要求带尖括号；`key` 是示例 token 本身，豁免）
                bare = {t for t in toks if not (t.startswith('<') and t.endswith('>'))}
                out[key] = (cells[1], {t.strip('<>') for t in toks}, bare)
    return out or None


def _a10b():
    schema = _a10_schema()
    if schema is None:
        A10_STAT['b'] = 'ERR'
        return
    members_map = _a10_schema_members(schema)
    known = set()
    for ms in members_map.values():
        known |= ms

    # 正则取自 SSOT；缺了就判 ERR —— 绝不允许「没有正则 ⇒ 0 命中 ⇒ 通过」这种假绿
    pat_src = schema.get('placeholder_re')
    if not pat_src:
        err('A10-b', '--schema-dump 缺 placeholder_re，无法判定占位符（拒绝以 0 命中蒙过）')
        A10_STAT['b'] = 'ERR'
        return
    global A10_PH_RE
    A10_PH_RE = re.compile(pat_src)

    # 判据①：engine/**/*.md 内出现的占位符必须全部在 schema 内
    unk, total, unread = [], 0, []
    eng = os.path.join(SKILL_ROOT, 'engine')
    for dirpath, _dn, fns in os.walk(eng):
        for fn in sorted(fns):
            if not fn.endswith('.md'):
                continue
            p = os.path.join(dirpath, fn)
            relp = os.path.relpath(p, SKILL_ROOT).replace('\\', '/')
            try:
                lines = open(p, encoding='utf-8').read().splitlines()
            except Exception as exc:
                # 不许静默跳过：读不出的文件其占位符全部逃过判据① ⇒ 判据可被「编码坏掉」蒙过
                unread.append('%s（%s）' % (relp, exc))
                continue
            for ln, line in enumerate(lines, 1):
                for m in A10_PH_RE.finditer(line):
                    total += 1
                    if m.group(1) not in known:
                        unk.append('%s:%d %s'
                                   % (os.path.relpath(p, SKILL_ROOT).replace('\\', '/'),
                                      ln, m.group(0)))
    if unk:
        for u in unk[:12]:
            err('A10-b', '未在 schema 内的占位符 %s' % u)
    else:
        ok('A10-b', 'engine 内占位符 %d 处全部落在五类 schema 内' % total)
    if unread:
        for u in unread[:6]:
            err('A10-b', '读取失败 ⇒ 该文件占位符未参与判定（禁静默跳过）: %s' % u)

    # 判据②：协议表成员 == schema 成员（双向 + 数量列 + ④ 写法）
    doc = _a10_parse_doc_schema(A10_PROTOCOL_DOC)
    if doc is None:
        err('A10-b', '无法解析 engine/template-injection.md §2.4 五类 schema 表')
        A10_STAT['b'] = 'ERR'
        return
    bad = bool(unk) or bool(unread)
    for key, ms in members_map.items():
        if key not in doc:
            err('A10-b', '协议表缺类 %s' % key)
            bad = True
            continue
        num, dm, bare = doc[key]
        if key == 'content_slot' and (bare - {'key'}):
            # ④ 内容槽必须写成 <...>：裸写会与真占位符混淆，让 --verify 无法收口
            # （`key` 是示例 token 本身，豁免）
            err('A10-b', '协议表 ④ 内容槽须写成 <...>，实际裸写 %d 项：%s'
                % (len(bare - {'key'}), ', '.join(sorted(bare - {'key'})[:6])))
            bad = True
        missing = sorted(ms - dm)
        extra = sorted(dm - ms)
        if missing:
            err('A10-b', '协议表 %s 缺成员 %d 项：%s' % (key, len(missing), ', '.join(missing[:6])))
            bad = True
        if extra:
            err('A10-b', '协议表 %s 多出未注册成员 %d 项：%s'
                % (key, len(extra), ', '.join(extra[:6])))
            bad = True
        try:
            if int(num) != len(ms):
                err('A10-b', '协议表 %s 数量列 %s ≠ schema 实际 %d' % (key, num, len(ms)))
                bad = True
        except ValueError:
            err('A10-b', '协议表 %s 数量列非数字：%s' % (key, num))
            bad = True
    A10_STAT['b'] = 'ERR' if bad else 'OK'
    if not bad:
        ok('A10-b', '协议表与 schema 一致（5 类 / %d 项）' % len(known))


def _a10e():
    skill_md = os.path.join(SKILL_ROOT, 'SKILL.md')
    tpl = os.path.join(SKILL_ROOT, 'SKILL.template.md')
    man = os.path.join(SKILL_ROOT, 'project', 'project.manifest.yaml')
    if not os.path.isfile(A10_INJECT):
        err('A10-e', '找不到 scripts/inject-template.py')
        A10_STAT['e'] = 'ERR'
        return
    for p, what in ((skill_md, 'SKILL.md'), (tpl, 'SKILL.template.md'),
                    (man, 'project.manifest.yaml')):
        if not os.path.isfile(p):
            err('A10-e', '%s 不存在，无法比对' % what)
            A10_STAT['e'] = 'ERR'
            return
    try:
        r = subprocess.run([_a10_py(), A10_INJECT, '--manifest', man, '--template', tpl,
                            '--check', '--compare', skill_md],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=180,
                           env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    except Exception as exc:
        err('A10-e', '--check --compare 执行异常: %s' % exc)
        A10_STAT['e'] = 'ERR'
        return
    if r.returncode == 0:
        A10_STAT['e'] = 'OK'
        ok('A10-e', '注入产物与 SKILL.md 逐字节一致')
    else:
        A10_STAT['e'] = 'ERR'
        err('A10-e', '注入产物与 SKILL.md 不一致（模板漂移，inject exit=%d）' % r.returncode)
        # 明细另起行打出来（不塞进一级消息）：中文经控制台编码往返可能有损，定位靠行 + 退出码
        for line in [l for l in (r.stdout or '').strip().splitlines() if l.strip()][-4:]:
            print('    | %s' % line)


def a10_check():
    _a10b()
    _a10e()
    _a10a()
    _a10c()
    _a10d()
    _a10f()          # ★ 在此直接调用，**不要**另注册到 main() 的维度表（否则双跑、计数翻倍）
    ok('A10', '结论: a=hits=%d baseline=%d allow=%d err=%d t7=%d | b=%s | c=%s | d=%d/%d | e=%s | f1=%s f2=%s'
       % (A10_STAT['a_hits'], A10_STAT['a_base'], A10_STAT['a_allow'], A10_STAT['a_err'],
          A10_STAT['a_t7'], A10_STAT['b'], A10_STAT['c'],
          A10_STAT['d_total'] - A10_STAT['d_missing'], A10_STAT['d_total'], A10_STAT['e'],
          A10_STAT['f1'], A10_STAT['f2']))
    # 全子检 SKIP 时不得"绿灯通过"（3 路评审 R-12）
    if (A10_STAT['a_hits'] == 0 and A10_STAT['c'] == 'SKIP' and A10_STAT['d_total'] == 0):
        warn('A10', 'a/c/d 全部未产生有效结论（SKIP/零输入）—— 请核查 manifest 与 node 可用性')


# ── main ────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description='Engine 一致性审计（纯读）')
    ap.add_argument('--src', default=os.environ.get('IWF_ENGINE_SRC', ''),
                    help='引擎仓库根目录（含 engine/ 与 scripts/；A6 回流水位；缺省读 IWF_ENGINE_SRC）')
    ap.add_argument('--strict', action='store_true', help='WARN 也计入退出码')
    ap.add_argument('--a10-baseline', default=os.environ.get('A10_BASELINE_SNAPSHOT', ''),
                    help='A10-c 的冻结基线 JSON（改码前三表快照；缺省读 A10_BASELINE_SNAPSHOT，'
                         '引擎内**不写死**迭代路径）')
    args = ap.parse_args()

    global A10_BASELINE_PATH
    A10_BASELINE_PATH = args.a10_baseline or ''

    print('=== Engine 一致性审计 · %s ===' % TODAY.isoformat())
    print('skill root: %s' % SKILL_ROOT)
    print('')

    for name, fn in (('A1', a1_orphan), ('A2', a2_step_ids), ('A3', a3_doc_names),
                     ('A4', a4_refs), ('A4b', a4b_var_typos), ('A8', a8_wait_points),
                     ('A10', a10_check), ('A5', a5_gov_docs)):
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
