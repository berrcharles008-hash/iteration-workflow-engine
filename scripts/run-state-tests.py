#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""state-apply 回归测试（PERF-1 · T1~T15 · ★ FIX-49 v2.4 更新）

用法（从项目根执行）:
  python {IDE}/skills/iteration-workflow/scripts/run-state-tests.py

机制: 在 `runtime/state-apply-tests/` 下重建隔离根（双 IDE 副本 + ACTIVE + 种子 state），
      对 `state-apply.py` 逐用例断言；不触碰真实 state。

★ FIX-49 v2.4（2026-10-15 实施）变更:
  · canonical 由「`.claude` 优先」改为**本宿主侧**（夹具对调：canon=`.codebuddy` = 脚本自身位置解析）
  · **单写本侧**：所有正向用例新增「**另一侧零触碰**」断言（方案 B 核心承诺，防跨侧写路径回归）
  · 新增 T12（`STATE_APPLY_SIDE` R2 口 —— 解析到 `.claude` 侧且 `.codebuddy` 零触碰）
  · 新增 T13~T15（`sync-runtime.py` 三条分支：新者胜收敛 / 并列拒绝+双侧备份 / 自举+幂等）

用例:
  T1  summary 全链路（version+1 / 本侧写入 / ACTIVE Line2 含 UPDATED / **另一侧零触碰**）
  T2  幂等（重复命令零写入、version 不变）
  T3  锁未过期 → 拒绝（rc=2）
  T4  锁 TTL 过期（>60s）→ 自动清理并继续（rc=0）
  T5  phase-advance 缺 --confirm-by → 拒绝（rc=2）
  T6  phase-advance 正向（phase_confirm 块 + phase_history 追加 + current_phase 变更）
  T7  patch 键不存在 → 拒绝（rc=2）
  T8  校验失败 → 回滚（rc=1，version 与内容复原；另一侧零触碰）
  T9  STATE_FORCE_WRITE=1 跳过锁（rc=0）
  T10 自留痕（write-claims.jsonl / gate-audit.log 各追加一行，落**本侧**）
  T11 含 estimate_* 的 state（★ 2026-10-14 #67 [R9]）：既有命令链路无损保留 + 负向回滚
      （a 链路保留 / b 枚举 `estimate_stage="02"` / c 区间 `estimate_lo > net_h` /
       d 引号陷阱 `estimate_stage: 1`（int）—— §3.3 严格口径，T3/T2 已裁定维持）
  T12 STATE_APPLY_SIDE=claude（R2/R44 口）⇒ canon 落 `.claude`，`.codebuddy` 零触碰
  T13 sync：两侧 version 分叉 ⇒ 跑 sync 后两侧逐字节一致 + 新者胜方向正确
  T14 sync：同 version 同时间但内容不同 ⇒ 拒绝（rc=2）+ 强制双侧备份 + 内容未被覆盖
  T15 sync：目标侧 runtime 不存在 ⇒ 自动创建（自举）+ 幂等重跑零 diff

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
SYNC = SCRIPTS / 'sync-runtime.py'
PROJECT = SELF.parents[4]
TESTROOT = SKILL / 'runtime' / 'state-apply-tests'
IID = 'TEST-STATE-APPLY'
REL = pathlib.Path('skills') / 'iteration-workflow' / 'runtime'
# ★ FIX-49 v2.4：canonical 侧 = `.codebuddy`（脚本自身位置 `parents[3]` 解析所得；
#   夹具与应用**同侧**，否则 T1~T10 整组红）；另一侧 = `.claude`（仅作"零触碰"对照物）。
CANON_IDE = 'codebuddy'
OTHER_IDE = 'claude'

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

# ★ 预估字段（2026-10-14 #67：01 初估 → 03 复估；[R9] 成组校验的载体，值须恒合法）
estimate_net_h: 6.5
estimate_lo: 3.8
estimate_hi: 9.3
estimate_stage: "01"
estimate_basis: "engine:1"

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


def side_state(ide):
    return TESTROOT / ('.' + ide) / REL / (IID + '.state.yaml')


def side_active(ide):
    return TESTROOT / ('.' + ide) / REL / 'ACTIVE'


def canon_state():
    return side_state(CANON_IDE)


def other_state():
    """另一侧（零触碰对照物）"""
    return side_state(OTHER_IDE)


def seed_md5():
    """种子 state 的 MD5 —— 用于断言「另一侧零触碰」"""
    return hashlib.md5(SEED.format(iid=IID).encode('utf-8')).hexdigest()


def setup():
    """重建隔离根 + 种子 state + ACTIVE"""
    if TESTROOT.exists():
        shutil.rmtree(TESTROOT, ignore_errors=True)
    for ide in ('.' + CANON_IDE, '.' + OTHER_IDE):
        d = TESTROOT / ide / REL
        d.mkdir(parents=True, exist_ok=True)
        (d / (IID + '.state.yaml')).write_text(SEED.format(iid=IID), encoding='utf-8', newline='')
        (d / 'ACTIVE').write_text(IID + '\nSTATUS=in_progress PHASE=04 TASKS=0/2 BLOCKERS=0\n',
                                  encoding='utf-8', newline='')


def run(cmd, extra_env=None):
    env = dict(os.environ)
    env['STATE_APPLY_ROOT'] = str(TESTROOT)
    # ★ FIX-49：清继承的宿主身份源 —— 否则父进程环境（IDE 会话）会改写 SIDE 解析，
    #   用例不可复现。纯靠脚本自身位置层解析（= CANON_IDE）或用例显式注入。
    for k in ('GATE_HOST_IDE', 'CODEBUDDY_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'STATE_APPLY_SIDE'):
        env.pop(k, None)
    env.update(extra_env or {})
    p = subprocess.run([sys.executable, str(APPLY)] + cmd, capture_output=True, cwd=str(PROJECT), env=env)
    out = (p.stdout or b'').decode('utf-8', 'replace') + (p.stderr or b'').decode('utf-8', 'replace')
    return p.returncode, out


def run_sync(extra_args=None, extra_env=None):
    """★ FIX-49 ③-3b：调 sync-runtime.py（隔离根 = TESTROOT）"""
    env = dict(os.environ)
    env['STATE_APPLY_ROOT'] = str(TESTROOT)
    for k in ('GATE_HOST_IDE', 'CODEBUDDY_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'STATE_APPLY_SIDE'):
        env.pop(k, None)
    env.update(extra_env or {})
    p = subprocess.run([sys.executable, str(SYNC)] + list(extra_args or []),
                       capture_output=True, cwd=str(PROJECT), env=env)
    out = (p.stdout or b'').decode('utf-8', 'replace') + (p.stderr or b'').decode('utf-8', 'replace')
    return p.returncode, out


def set_state_scalar(p, key, value):
    """测试夹具：直接改某侧 state 的顶层标量（构造分叉场景用）"""
    t = read(p)
    lines = []
    for ln in t.split('\n'):
        if ln.startswith(key + ':'):
            lines.append('{}: {}'.format(key, value))
        else:
            lines.append(ln)
    p.write_text('\n'.join(lines), encoding='utf-8', newline='')


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
    say('=== state-apply 回归测试（T1~T15 · ★ FIX-49 v2.4：canonical=本宿主侧 + 单写）===')
    if not APPLY.exists():
        say('找不到 state-apply.py')
        return 1
    if not SYNC.exists():
        say('找不到 sync-runtime.py')
        return 1

    # T1 全链路（本侧写入 + ★ 另一侧零触碰）
    setup()
    rc, out = run(['summary', '--text', 'T1 写入'])
    cs, oth = canon_state(), other_state()
    other_intact = md5(oth) == seed_md5()
    ok = rc == 0 and version_of(cs) == 2 and 'T1 写入' in read(cs) and other_intact
    active_line2 = read(side_active(CANON_IDE)).splitlines()[1]
    ok = ok and 'UPDATED=' in active_line2
    check('T1 summary 全链路（本侧写 + 另一侧零触碰）', ok,
          'rc={} v={} line2={} other_intact={}'.format(rc, version_of(cs), active_line2, other_intact))

    # T2 幂等
    rc1, _ = run(['step-complete', '--id', 'step-A'])
    v1 = version_of(cs)
    rc2, out2 = run(['step-complete', '--id', 'step-A'])
    ok = rc1 == 0 and rc2 == 0 and version_of(cs) == v1 and '无需变更' in out2
    check('T2 幂等零写入', ok, 'rc1={} rc2={} v={}'.format(rc1, rc2, version_of(cs)))

    # T3 锁未过期 → 拒绝
    setup()
    lock = TESTROOT / ('.' + CANON_IDE) / REL / (IID + '.lock')
    lock.mkdir(parents=True, exist_ok=True)
    rc, out = run(['summary', '--text', 'T3'])
    check('T3 锁占用拒绝', rc == 2 and '锁定' in out, 'rc={}'.format(rc))

    # T4 锁 TTL 过期 → 自动清理
    setup()
    lock = TESTROOT / ('.' + CANON_IDE) / REL / (IID + '.lock')
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

    # T8 校验失败回滚（本侧复原 + 另一侧零触碰）
    setup()
    pj = TESTROOT / '_bad_enum.json'
    pj.write_text('{"complexity": "X"}', encoding='utf-8')
    rc, out = run(['patch', '--file', str(pj)])
    ok = (rc == 1 and version_of(cs) == 1 and md5(cs) == seed_md5()
          and md5(other_state()) == seed_md5() and '"🟡"' in read(cs))
    check('T8 校验失败本侧回滚', ok, 'rc={} v={}'.format(rc, version_of(cs)))

    # T9 STATE_FORCE_WRITE 跳过锁
    setup()
    lock = TESTROOT / ('.' + CANON_IDE) / REL / (IID + '.lock')
    lock.mkdir(parents=True, exist_ok=True)
    rc, out = run(['summary', '--text', 'T9'], {'STATE_FORCE_WRITE': '1'})
    check('T9 FORCE 跳过锁', rc == 0 and version_of(cs) == 2, 'rc={}'.format(rc))

    # T10 自留痕（★ FIX-49：落**本侧**）
    setup()
    rt_canon = TESTROOT / ('.' + CANON_IDE) / REL
    wc_before = rt_canon / 'write-claims.jsonl'
    ga_before = rt_canon / 'gate-audit.log'
    n_wc0 = len(read(wc_before).splitlines()) if wc_before.exists() else 0
    n_ga0 = len(read(ga_before).splitlines()) if ga_before.exists() else 0
    run(['summary', '--text', 'T10'])
    n_wc1 = len(read(wc_before).splitlines()) if wc_before.exists() else 0
    n_ga1 = len(read(ga_before).splitlines()) if ga_before.exists() else 0
    other_rt = TESTROOT / ('.' + OTHER_IDE) / REL
    ok = (n_wc1 == n_wc0 + 1 and n_ga1 == n_ga0 + 1 and 'STATE_APPLY' in read(ga_before)
          and not (other_rt / 'write-claims.jsonl').exists()
          and not (other_rt / 'gate-audit.log').exists())
    check('T10 自留痕（本侧）', ok, 'wc {}->{} ga {}->{}'.format(n_wc0, n_wc1, n_ga0, n_ga1))

    # T11 estimate_*（[R9]，2026-10-14 #67）：既有命令链路上无损保留 + 负向样本回滚
    setup()
    rc, out = run(['summary', '--text', 'T11 含 estimate_* 的既有链路'])
    t = read(cs)
    keys = ('estimate_net_h', 'estimate_lo', 'estimate_hi', 'estimate_stage', 'estimate_basis')
    kept = all(k in t for k in keys)
    # ★ T11a 是**回归护栏**（合法值链路不腐化），不承担 [R9] 区分性 —— 区分性由 T11b~T11e 承担（代码审查 #6）
    ok = rc == 0 and version_of(cs) == 2 and kept and md5(other_state()) == seed_md5()
    check('T11a estimate_* 链路保留（回归护栏）', ok, 'rc={} v={} kept={}'.format(rc, version_of(cs), kept))

    pj = TESTROOT / '_bad_est_stage.json'
    pj.write_text('{"estimate_stage": "02"}', encoding='utf-8')
    rc, out = run(['patch', '--file', str(pj)])
    t = read(cs)
    ok = (rc == 1 and '[R9]' in out and version_of(cs) == 2
          and "'02'" not in t and '"02"' not in t)
    check('T11b [R9] 枚举负向回滚', ok, 'rc={} v={}'.format(rc, version_of(cs)))

    pj = TESTROOT / '_bad_est_range.json'
    pj.write_text('{"estimate_lo": 99.0}', encoding='utf-8')
    rc, out = run(['patch', '--file', str(pj)])
    ok = rc == 1 and '[R9]' in out and '区间不满足' in out and version_of(cs) == 2
    check('T11c [R9] 区间负向回滚', ok, 'rc={} v={}'.format(rc, version_of(cs)))

    # T11d 引号陷阱：patch 传 int ⇒ 落盘裸值 `estimate_stage: 1`（契约要求字符串 "01"/"03"）
    pj = TESTROOT / '_bad_est_quote.json'
    pj.write_text('{"estimate_stage": 1}', encoding='utf-8')
    rc, out = run(['patch', '--file', str(pj)])
    ok = (rc == 1 and '[R9]' in out and version_of(cs) == 2
          and 'estimate_stage: 1' not in read(cs))
    check('T11d [R9] 引号陷阱回滚', ok, 'rc={} v={}'.format(rc, version_of(cs)))

    # T11e 未登记键（键名拼错）：白名单外 estimate_* ⇒ [R9] 判红（2026-10-14 代码审查 #4 加固）
    #   构造：直接向沙箱 state 追加一个拼错的 estimate_* 键（保持 5 项合法齐全，隔离 ⑤ 单独生效）
    cs.write_text(read(cs).rstrip() + '\nestimate_note_typo: "x"\n', encoding='utf-8')
    pj = TESTROOT / '_ok_est_patch.json'
    pj.write_text('{"estimate_net_h": 2.5}', encoding='utf-8')
    rc, out = run(['patch', '--file', str(pj)])
    ok = rc == 1 and '[R9]' in out and '未登记' in out
    check('T11e [R9] 未登记键判红', ok, 'rc={}'.format(rc))

    # ── T12（★ FIX-49 新增）：宿主侧解析（R2/R44 口 + R1 fail-closed）──────────
    # T12a：STATE_APPLY_SIDE=claude（测试/演练显式口；STATE_APPLY_ROOT 已设 ⇒ R44 同现条件满足）
    setup()
    cl = side_state(OTHER_IDE)
    rc, out = run(['summary', '--text', 'T12 claude 侧'], {'STATE_APPLY_SIDE': OTHER_IDE})
    ok = (rc == 0 and version_of(cl) == 2 and 'T12 claude 侧' in read(cl)
          and md5(canon_state()) == seed_md5())
    check('T12a STATE_APPLY_SIDE=claude（R2 口）→ 写 .claude，.codebuddy 零触碰', ok,
          'rc={} v={}'.format(rc, version_of(cl)))

    # T12b：身份解析失败 ⇒ fail-closed（R1；四级全不可识别 ⇒ rc=2 + 任一侧零写入）
    #   构造：把脚本副本放到非 `.{ide}` 父目录（parents[3] 不可识别）+ 清空三个环境源
    setup()
    foreign = TESTROOT / '_idprobe' / 'd1' / 'd2' / 'd3'
    foreign.mkdir(parents=True, exist_ok=True)
    probe = foreign / 'state-apply.py'
    shutil.copyfile(str(APPLY), str(probe))
    env = dict(os.environ)
    env['STATE_APPLY_ROOT'] = str(TESTROOT)
    for k in ('GATE_HOST_IDE', 'CODEBUDDY_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'STATE_APPLY_SIDE'):
        env.pop(k, None)
    p = subprocess.run([sys.executable, str(probe), 'summary', '--text', 'T12b'],
                       capture_output=True, cwd=str(PROJECT), env=env)
    out = (p.stdout or b'').decode('utf-8', 'replace') + (p.stderr or b'').decode('utf-8', 'replace')
    ok = (p.returncode == 2 and 'FIX-49' in out and 'fail-closed' in out
          and md5(canon_state()) == seed_md5() and md5(other_state()) == seed_md5())
    check('T12b 身份解析失败 → fail-closed（R1：rc=2 + 零写入）', ok,
          'rc={} msg={}'.format(p.returncode, out.strip().splitlines()[-1][:60] if out.strip() else ''))

    # ── T13~T15（★ FIX-49 ③-3b）：sync-runtime.py 三条分支 ────────────────
    # T13 两侧 version 分叉 ⇒ 收敛（新者胜方向正确 + 逐字节一致）
    setup()
    newer = side_state(OTHER_IDE)
    set_state_scalar(newer, 'version', '5')
    set_state_scalar(newer, 'last_updated', '"2026-10-15T20:00"')
    set_state_scalar(newer, 'last_session_summary', '"T13 新侧内容"')
    rc, out = run_sync(['--text', 'T13'])
    ok = (rc == 0 and md5(canon_state()) == md5(newer)
          and version_of(canon_state()) == 5 and 'T13 新侧内容' in read(canon_state()))
    check('T13 sync 新者胜收敛（另一侧→本侧）', ok, 'rc={} v={}'.format(rc, version_of(canon_state())))

    # T14 同 version 同时间但内容不同 ⇒ 拒绝（rc=2）+ 强制双侧备份 + 内容未被覆盖
    setup()
    a, b = canon_state(), side_state(OTHER_IDE)
    for p_ in (a, b):
        set_state_scalar(p_, 'version', '3')
        set_state_scalar(p_, 'last_updated', '"2026-10-15T21:00"')
    set_state_scalar(b, 'last_session_summary', '"T14 冲突侧"')
    ma0, mb0 = md5(a), md5(b)
    rc, out = run_sync(['--text', 'T14'])
    baks = [p_ for p_ in TESTROOT.rglob(IID + '.state.yaml') if 'sync-runtime-tie-' in str(p_)]
    ok = (rc == 2 and '拒绝' in out and len(baks) == 2 and md5(a) == ma0 and md5(b) == mb0)
    check('T14 sync 并列冲突 → 拒绝 + 双侧备份', ok, 'rc={} baks={}'.format(rc, len(baks)))

    # T15 目标侧 runtime 目录不存在 ⇒ 自动创建（自举）+ 幂等重跑零 diff
    setup()
    set_state_scalar(side_state(OTHER_IDE), 'version', '2')
    shutil.rmtree(TESTROOT / ('.' + CANON_IDE) / REL, ignore_errors=True)
    rc1, out1 = run_sync(['--text', 'T15'])
    pc, pa = canon_state(), side_active(CANON_IDE)
    ok = (rc1 == 0 and pc.exists() and pa.exists()
          and md5(pc) == md5(side_state(OTHER_IDE)))
    h1 = (md5(pc), md5(pa)) if pc.exists() and pa.exists() else ('', '')
    rc2, out2 = run_sync(['--text', 'T15-again'])
    h2 = (md5(pc), md5(pa)) if pc.exists() and pa.exists() else ('', '')
    ok = ok and rc2 == 0 and h1 == h2 and h1[0] != ''
    check('T15 sync 自举创建 + 幂等重跑零 diff', ok,
          'rc1={} rc2={} exist={}'.format(rc1, rc2, pc.exists()))

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
