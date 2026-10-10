#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""state-apply 回归测试（PERF-1 · T1~T10）

用法（从项目根执行）:
  python {IDE}/skills/iteration-workflow/scripts/run-state-tests.py

机制: 在 `runtime/state-apply-tests/` 下重建隔离根（双 IDE 副本 + ACTIVE + 种子 state），
      对 `state-apply.py` 逐用例断言；不触碰真实 state。

用例:
  T1  summary 全链路（version+1 / 双副本 MD5 一致 / ACTIVE Line2 含 UPDATED）
  T2  幂等（重复命令零写入、version 不变）
  T3  锁未过期 → 拒绝（rc=2）
  T4  锁 TTL 过期（>60s）→ 自动清理并继续（rc=0）
  T5  phase-advance 缺 --confirm-by → 拒绝（rc=2）
  T6  phase-advance 正向（phase_confirm 块 + phase_history 追加 + current_phase 变更）
  T7  patch 键不存在 → 拒绝（rc=2）
  T8  校验失败 → 回滚（rc=1，version 与内容复原）
  T9  STATE_FORCE_WRITE=1 跳过锁（rc=0）
  T10 自留痕（write-claims.jsonl / gate-audit.log 各追加一行）

退出码: 0 = 全部通过；1 = 存在失败。
"""
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import time

SELF = pathlib.Path(__file__).resolve()
SCRIPTS = SELF.parent
SKILL = SCRIPTS.parent
APPLY = SCRIPTS / 'state-apply.py'
PROJECT = SELF.parents[4]
TESTROOT = SKILL / 'runtime' / 'state-apply-tests'
IID = 'TEST-STATE-APPLY'
REL = pathlib.Path('skills') / 'iteration-workflow' / 'runtime'

SEED = '''# 迭代状态文件 — 由 Agent 自动维护，勿手动修改关键字段
version: 1
iteration_id: "{iid}"
iteration_status: "in_progress"
started_at: "2026-10-03T10:00"
complexity: "🟡"
current_phase: "04"
phase_status: "in_progress"
last_updated: "2026-10-03T10:00"
last_session_summary: "seed"

phase_history:
  - phase: "01"
    status: "completed"
    completed_at: "2026-10-03T10:10"

phase_steps:
  - id: "step-A"
    name: "A"
    mandatory: true
    status: "pending"
  - id: "step-B"
    name: "B"
    mandatory: true
    status: "completed"

tasks_total: 2
tasks_completed: 0
tasks_pending:
  - id: "Task-1"
    file: "x.cs"
    op: "新增"
    desc: "d"

blockers: []
defects: []
rollback_checks: []
'''

RESULTS = []


def say(msg=''):
    print(msg)


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    say('  {} {}  {}'.format('PASS' if cond else 'FAIL', name, detail if not cond else ''))


def canon_state():
    return TESTROOT / '.claude' / REL / (IID + '.state.yaml')


def mirror_state():
    return TESTROOT / '.codebuddy' / REL / (IID + '.state.yaml')


def setup():
    """重建隔离根 + 种子 state + ACTIVE"""
    if TESTROOT.exists():
        shutil.rmtree(TESTROOT, ignore_errors=True)
    for ide in ('.claude', '.codebuddy'):
        d = TESTROOT / ide / REL
        d.mkdir(parents=True, exist_ok=True)
        (d / (IID + '.state.yaml')).write_text(SEED.format(iid=IID), encoding='utf-8', newline='')
        (d / 'ACTIVE').write_text(IID + '\nSTATUS=in_progress PHASE=04 TASKS=0/2 BLOCKERS=0\n',
                                  encoding='utf-8', newline='')


def run(cmd, extra_env=None):
    env = dict(os.environ)
    env['STATE_APPLY_ROOT'] = str(TESTROOT)
    env.update(extra_env or {})
    p = subprocess.run([sys.executable, str(APPLY)] + cmd, capture_output=True, cwd=str(PROJECT), env=env)
    out = (p.stdout or b'').decode('utf-8', 'replace') + (p.stderr or b'').decode('utf-8', 'replace')
    return p.returncode, out


def read(p):
    return p.read_text(encoding='utf-8')


def md5(p):
    return hashlib.md5(p.read_bytes()).hexdigest()


def version_of(p):
    for ln in read(p).splitlines():
        if ln.startswith('version:'):
            return int(ln.split(':')[1].strip())
    return -1


def main():
    say('=== state-apply 回归测试（T1~T10）===')
    if not APPLY.exists():
        say('找不到 state-apply.py')
        return 1

    # T1 全链路
    setup()
    rc, out = run(['summary', '--text', 'T1 写入'])
    cs, ms = canon_state(), mirror_state()
    ok = rc == 0 and version_of(cs) == 2 and 'T1 写入' in read(cs) and md5(cs) == md5(ms)
    active_line2 = read(TESTROOT / '.claude' / REL / 'ACTIVE').splitlines()[1]
    ok = ok and 'UPDATED=' in active_line2
    check('T1 summary 全链路', ok, 'rc={} v={} line2={}'.format(rc, version_of(cs), active_line2))

    # T2 幂等
    rc1, _ = run(['step-complete', '--id', 'step-A'])
    v1 = version_of(cs)
    rc2, out2 = run(['step-complete', '--id', 'step-A'])
    ok = rc1 == 0 and rc2 == 0 and version_of(cs) == v1 and '无需变更' in out2
    check('T2 幂等零写入', ok, 'rc1={} rc2={} v={}'.format(rc1, rc2, version_of(cs)))

    # T3 锁未过期 → 拒绝
    setup()
    lock = TESTROOT / '.claude' / REL / (IID + '.lock')
    lock.mkdir(parents=True, exist_ok=True)
    rc, out = run(['summary', '--text', 'T3'])
    check('T3 锁占用拒绝', rc == 2 and '锁定' in out, 'rc={}'.format(rc))

    # T4 锁 TTL 过期 → 自动清理
    setup()
    lock = TESTROOT / '.claude' / REL / (IID + '.lock')
    lock.mkdir(parents=True, exist_ok=True)
    old = time.time() - 90
    os.utime(lock, (old, old))
    rc, out = run(['summary', '--text', 'T4'])
    check('T4 锁 TTL 恢复', rc == 0 and version_of(cs) == 2, 'rc={} v={}'.format(rc, version_of(cs)))

    # T5 phase-advance 负向
    setup()
    rc, out = run(['phase-advance', '--to', '05'])
    check('T5 缺 confirm-by 拒绝', rc == 2 and '拒绝' in out, 'rc={}'.format(rc))

    # T6 phase-advance 正向
    setup()
    rc, out = run(['phase-advance', '--to', '05', '--confirm-by', 'ide', '--quote', '用户确认'])
    t = read(cs)
    ok = rc == 0 and 'current_phase: "05"' in t and 'phase_confirm:' in t and 'to: "05"' in t and '  - phase: "04"' in t
    check('T6 phase-advance 正向', ok, 'rc={}'.format(rc))

    # T7 patch 键不存在 → 拒绝
    setup()
    pj = TESTROOT / '_bad_key.json'
    pj.write_text('{"no_such_key": "x"}', encoding='utf-8')
    rc, out = run(['patch', '--file', str(pj)])
    check('T7 patch 未知键拒绝', rc == 2 and '拒绝' in out, 'rc={}'.format(rc))

    # T8 校验失败回滚
    setup()
    pj = TESTROOT / '_bad_enum.json'
    pj.write_text('{"complexity": "X"}', encoding='utf-8')
    rc, out = run(['patch', '--file', str(pj)])
    ok = rc == 1 and version_of(cs) == 1 and md5(cs) == md5(ms) and '"🟡"' in read(cs)
    check('T8 校验失败双侧回滚', ok, 'rc={} v={}'.format(rc, version_of(cs)))

    # T9 STATE_FORCE_WRITE 跳过锁
    setup()
    lock = TESTROOT / '.claude' / REL / (IID + '.lock')
    lock.mkdir(parents=True, exist_ok=True)
    rc, out = run(['summary', '--text', 'T9'], {'STATE_FORCE_WRITE': '1'})
    check('T9 FORCE 跳过锁', rc == 0 and version_of(cs) == 2, 'rc={}'.format(rc))

    # T10 自留痕
    setup()
    wc_before = (TESTROOT / '.claude' / REL / 'write-claims.jsonl')
    ga_before = (TESTROOT / '.claude' / REL / 'gate-audit.log')
    n_wc0 = len(read(wc_before).splitlines()) if wc_before.exists() else 0
    n_ga0 = len(read(ga_before).splitlines()) if ga_before.exists() else 0
    run(['summary', '--text', 'T10'])
    n_wc1 = len(read(wc_before).splitlines()) if wc_before.exists() else 0
    n_ga1 = len(read(ga_before).splitlines()) if ga_before.exists() else 0
    ok = n_wc1 == n_wc0 + 1 and n_ga1 == n_ga0 + 1 and 'STATE_APPLY' in read(ga_before)
    check('T10 自留痕', ok, 'wc {}->{} ga {}->{}'.format(n_wc0, n_wc1, n_ga0, n_ga1))

    fails = [r for r in RESULTS if not r[1]]
    say('')
    say('RESULT: {} passed / {} failed (of {})'.format(len(RESULTS) - len(fails), len(fails), len(RESULTS)))
    if fails:
        for n, _, d in fails:
            say('  FAILED: {}  {}'.format(n, d))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
