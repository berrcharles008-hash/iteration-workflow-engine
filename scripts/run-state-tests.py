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
  T16 M1 artifact_baseline：baseline-set 写入 / 未变即拒（只读：mtime 不变、无锁残留）/ 变化与新增放行
  T17 M1 基线缺失：默认 SKIP 不阻断（rc=0）；--require-baseline 才拒（rc=1）
  T18 F1 engine_baseline：五键块 + 7 逻辑键 / 二次 ALREADY FROZEN（at 不刷新）/ --require-frozen / --force refroze
  T19 F1 四分类：改一行 ⇒ 变化 1；还原 ⇒ 变化 0；新增 ⇒ 新增 1；删除 ⇒ 消失 1（每例重建夹具）
  T20 F1 负向：无块 ⇒ SKIP(no baseline) rc=0；缺 validate-artifacts.py ⇒ rc=2；--repo 非 git ⇒ anchored:false
  T21 D-1 防回归：连续两步 skip 各自落 skip_reason（旧窗口判据漏插第 2 步）
  T22 REQ-007 A1：phase-advance --to 07 随动置 iteration_status=completed（--to 05 不动）
  T23 REQ-008 step-reset：in_progress/skipped 回落 pending；completed 默认拒、--force+reason 才放行
  T24 REQ-008 phase-finish：仅 07 可执行；写 07 completed + phase_status/iteration_status=completed，幂等
  T25 REQ-008 patch --allow-new：白名单 7 键可新建（紧随 last_updated）；块/数组键与锚缺失一律拒
  T26 REQ-008 事件契约：step_reset / phase_finished / self_heal 三条 detail 形态

退出码: 0 = 全部通过；1 = 存在失败。
"""
import hashlib
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

# ★ 2026-11-20 F1 同批：Windows GBK 控制台无法编码 `⇒` 等字符 ⇒ UnicodeEncodeError 中断
#   （state-apply.py 早有同款防护，本脚本漏配 —— 实测 36 例收口跑崩溃于输出阶段）。
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

SELF = pathlib.Path(__file__).resolve()
SCRIPTS = SELF.parent
SKILL = SCRIPTS.parent
APPLY = SCRIPTS / 'state-apply.py'
SYNC = SCRIPTS / 'sync-runtime.py'
# 项目根：实例内是 `parents[4]`；引擎源仓库（少一级 `<项目根>/.codebuddy`）只有 4 级 ⇒ 取到盘的根，
# 本值只用于子进程 cwd，不参与判据（★ 2026-11-19：原写法在引擎仓库里直接 IndexError，回归跑不起来）
PROJECT = SELF.parents[4] if len(SELF.parents) > 4 else SELF.parents[-1]
TESTROOT = SKILL / 'runtime' / 'state-apply-tests'
IID = 'TEST-STATE-APPLY'
REL = pathlib.Path('skills') / 'iteration-workflow' / 'runtime'
# ★ FIX-49 v2.4：canonical 侧 = `.codebuddy`（脚本自身位置 `parents[3]` 解析所得；
#   夹具与应用**同侧**，否则 T1~T22 整组红）；另一侧 = `.claude`（仅作"零触碰"对照物）。
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


def setup(state=None):
    """重建隔离根 + 种子 state + ACTIVE。

    ★ REQ-008（2026-11-22）：`state` 可传自定义全文 —— T23~T26 需要 `in_progress`/`skipped`
    步骤、07 态、`self_evolve` 块、`phase_history: []`、缺锚等现有 SEED 构造不出的形态。
    """
    body = state if state is not None else SEED.format(iid=IID)
    if TESTROOT.exists():
        shutil.rmtree(TESTROOT, ignore_errors=True)
    for ide in ('.' + CANON_IDE, '.' + OTHER_IDE):
        d = TESTROOT / ide / REL
        d.mkdir(parents=True, exist_ok=True)
        (d / (IID + '.state.yaml')).write_text(body, encoding='utf-8', newline='')
        (d / 'ACTIVE').write_text(IID + '\nSTATUS=in_progress PHASE=04 TASKS=0/2 BLOCKERS=0\n',
                                  encoding='utf-8', newline='')


def seed_state(extra='', **kw):
    """在 SEED 上覆写顶层标量 / `phase_steps` 全量替换 / 末尾追加块（T23~T26 夹具构造器）。

    · 标量：`key=value`（bool → true/false，数值裸写，其余加双引号）
    · `steps=[('id','status'), …]` ⇒ 整体替换 phase_steps 块
    · `extra` ⇒ 原样拼到文末（造 `self_evolve:` 一类块）
    """
    steps = kw.pop('steps', None)
    s = SEED.format(iid=IID)
    for k, v in kw.items():
        if isinstance(v, bool):
            sv = 'true' if v else 'false'
        elif isinstance(v, (int, float)):
            sv = str(v)
        else:
            sv = '"%s"' % v
        s = re.sub(r'(?m)^%s:.*$' % re.escape(k), '%s: %s' % (k, sv), s)
    if steps is not None:
        blk = []
        for sid, st in steps:
            blk += ['  - id: "%s"' % sid, '    name: "%s"' % sid,
                    '    mandatory: true', '    status: "%s"' % st]
        s = re.sub(r'(?ms)^phase_steps:\n(?:  .*\n)+', 'phase_steps:\n' + '\n'.join(blk) + '\n', s)
    if extra:
        s = s.rstrip('\n') + '\n' + extra.rstrip('\n') + '\n'
    return s


def block_text(text, key):
    """取顶层块 `key:` 原文（含块头，到下一个顶层键为止）—— 用于「块内其余行不变」断言。"""
    out, on = [], False
    for ln in text.split('\n'):
        if ln.startswith(key + ':'):
            on = True
            out.append(ln)
            continue
        if on:
            if ln.startswith(' ') or ln.strip() == '':
                out.append(ln)
            else:
                break
    return '\n'.join(out)


def setup_freeze_fixture():
    """★ F1 夹具（仅 T18/T19/T20 首行调用，**不进** setup()，避免拖慢 T1~T22）。

    · 两侧都造（`.codebuddy` 与 `.claude`）：canon 若解析成另一侧仍能扫到同一批逻辑键；
    · **不造 git 仓库** ⇒ `resolve_engine_repo()` 得 (None, None, False) ⇒ 走 `anchored:false` 分支；
    · 预期扫描 7 个逻辑键：engine/×2 + scripts/×1 + project/×1 + hooks/×1 + skill/×2
      （hooks 在 `<ROOT>/<.ide>/hooks/` 下，**不在** skill 根内 —— frozen_pairs 的根位口径）。
    """
    setup()
    for ide in ('.' + CANON_IDE, '.' + OTHER_IDE):
        sroot = TESTROOT / ide / REL.parent            # = skills/iteration-workflow
        for sub in ('engine', 'scripts', 'project'):
            (sroot / sub).mkdir(parents=True, exist_ok=True)
        (TESTROOT / ide / 'hooks').mkdir(parents=True, exist_ok=True)
        for name, txt in (('engine/a.md', '# a\n'), ('engine/b.md', '# b\n'),
                          ('scripts/x.py', 'print(1)\n'),
                          ('project/project.manifest.yaml', 'name: fixture\n'),
                          ('SKILL.md', '# SKILL\n'), ('SKILL.template.md', '# TPL\n')):
            (sroot / name).write_text(txt, encoding='utf-8', newline='')
        (TESTROOT / ide / 'hooks' / 'gate-check.mjs').write_text(
            '// gate\n', encoding='utf-8', newline='')


def frun(cmd):
    """freeze 用例统一入口：显式钉住本侧，保证 scan 恒落 `<TESTROOT>/.codebuddy`（不随宿主漂移）。"""
    return run(cmd, {'STATE_APPLY_SIDE': CANON_IDE})


def run(cmd, extra_env=None):
    env = dict(os.environ)
    env['STATE_APPLY_ROOT'] = str(TESTROOT)
    # ★ FIX-49：清继承的宿主身份源 —— 否则父进程环境（IDE 会话）会改写 SIDE 解析，
    #   用例不可复现。纯靠脚本自身位置层解析（= CANON_IDE）或用例显式注入。
    for k in ('GATE_HOST_IDE', 'CODEBUDDY_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'STATE_APPLY_SIDE',
              # ★ 2026-11-20 F1：真机若设了 IWF_ENGINE_SRC，freeze-set 会把它当引擎源解析 ⇒
              #   commit 随机器而变、anchored 恒 true ⇒ T18/T20 的 anchored:false 分支永远测不到。
              'IWF_ENGINE_SRC'):
        env.pop(k, None)
    # ★ 2026-11-19：引擎**源仓库**里 `state-apply.py` 的位置不含 `.codebuddy`/`.claude` 层
    #   ⇒ 四级解析必失败（fail-closed rc=2），整套用例在仓库内跑不起来。此处仅在"自身位置层
    #   不可用"时显式注入本侧；T12b 的 fail-closed 用例用独立 subprocess（不走本函数），不受影响。
    if not ({'.codebuddy', '.claude'} & {p.name for p in APPLY.parents}):
        env['STATE_APPLY_SIDE'] = CANON_IDE
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
    say('=== state-apply 回归测试（T1~T26 · ★ FIX-49 v2.4：canonical=本宿主侧 + 单写）===')
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

    # ── T16~T17（★ M1 · 2026-11-19）：artifact_baseline（prepare）+ artifact-check（finish）──
    # SEED 的 current_phase="04" ⇒ 阶段目录 `04-开发实现/`（manifest dir_prefix="04-"）
    stage_dir = TESTROOT / 'docs' / 'iterations' / IID / '04-开发实现'
    stage_file = stage_dir / '04-开发任务清单.md'
    lock_c = TESTROOT / ('.' + CANON_IDE) / REL / (IID + '.lock')

    setup()
    stage_dir.mkdir(parents=True, exist_ok=True)
    stage_file.write_text('# 旧骨架\n\n## 1. 任务拆解\n没写。\n', encoding='utf-8')
    rc, out = run(['baseline-set'])
    body = read(cs)
    blk_ok = 'artifact_baseline:' in body and 'phase: "04"' in body
    check('T16a baseline-set 写入 artifact_baseline', rc == 0 and blk_ok,
          'rc={} blk={}'.format(rc, blk_ok))

    mt0 = os.stat(cs).st_mtime_ns
    rc, out = run(['artifact-check'])
    mt1 = os.stat(cs).st_mtime_ns
    check('T16b 未变即拒 + 只读（mtime 不变 / 无锁残留）',
          rc == 1 and '未变' in out and mt0 == mt1 and not lock_c.exists(),
          'rc={} mtime_same={} nolock={}'.format(rc, mt0 == mt1, not lock_c.exists()))

    stage_file.write_text('# 本阶段重写\n\n## 1. 任务拆解\n真的写了任务。\n', encoding='utf-8')
    rc1, out1 = run(['artifact-check'])
    (stage_dir / '04-附录.md').write_text('# 附录\n本阶段新增。\n', encoding='utf-8')
    rc2, out2 = run(['artifact-check'])
    check('T16c 变化 / 新增放行', rc1 == 0 and '变化 1' in out1 and rc2 == 0 and '新增 1' in out2,
          'rc1={} rc2={}'.format(rc1, rc2))

    setup()
    stage_dir.mkdir(parents=True, exist_ok=True)      # 目录在、基线不在 ⇒ 只考基线缺失分支
    rc, out = run(['artifact-check'])
    rc2, out2 = run(['artifact-check', '--require-baseline'])
    check('T17 基线缺失 fail-open / --require-baseline 拒',
          rc == 0 and '基线缺失' in out and rc2 == 1 and '基线缺失' in out2,
          'rc={} rc2={}'.format(rc, rc2))

    # ── T18~T20（★ F1 · 2026-11-20）：engine_baseline（freeze-set / freeze-check / freeze-restore）──
    # 夹具无 git 仓库 ⇒ resolve_engine_repo() = (None, None, False) ⇒ freeze-set 走 anchored:false 分支
    eng_rel = REL.parent                              # skills/iteration-workflow

    setup_freeze_fixture()
    rc, out = frun(['freeze-set', '--phase', '04'])
    body = read(cs)
    n_path = body.count('\n    - path: "')
    five = ('\n  at: "' in body and '\n  phase: "04"' in body and '\n  source:' in body
            and '\n  scope:' in body and '\n  files:' in body)
    hook_ok = 'hooks/gate-check.mjs' in body and 'skill/SKILL.template.md' in body
    ok = rc == 0 and 'BASELINE SET' in out and five and hook_ok and n_path == 7
    check('T18a freeze-set 五键块 + 7 逻辑键（AC-1）', ok,
          'rc={} five={} hook={} files={}'.format(rc, five, hook_ok, n_path))

    at0 = [ln for ln in body.splitlines() if ln.startswith('  at: "')]
    md0 = md5(cs)
    rc, out = frun(['freeze-set', '--phase', '04'])
    at1 = [ln for ln in read(cs).splitlines() if ln.startswith('  at: "')]
    ok = rc == 0 and 'ALREADY FROZEN' in out and at1 == at0 and md5(cs) == md0
    check('T18b 二次 ALREADY FROZEN + at 不刷新（AC-3 零写入）', ok,
          'rc={} at_same={} md5_same={}'.format(rc, at1 == at0, md5(cs) == md0))

    mt0 = os.stat(cs).st_mtime_ns
    rc1, out1 = frun(['freeze-check'])
    rc2, out2 = frun(['freeze-restore', '--dry-run'])
    mt1 = os.stat(cs).st_mtime_ns
    ok = (rc1 == 0 and rc2 == 0 and mt0 == mt1 and not lock_c.exists()
          and '变化 0 ｜ 新增 0 ｜ 消失 0' in out1 and '待还原 0 个' in out2)
    check('T18c freeze-check / freeze-restore --dry-run 只读（AC-8）', ok,
          'rc1={} rc2={} mtime_same={} nolock={}'.format(rc1, rc2, mt0 == mt1, not lock_c.exists()))

    am = TESTROOT / ('.' + CANON_IDE) / eng_rel / 'engine' / 'a.md'
    am.write_text(read(am) + 'drift\n', encoding='utf-8', newline='')
    rc_s, out_s = frun(['freeze-check'])
    rc_h, out_h = frun(['freeze-check', '--require-frozen'])
    ok = rc_s == 0 and '变化 1' in out_s and rc_h == 1 and '漂移' in out_h
    check('T18d --require-frozen 漂移 ⇒ rc=1；不带 ⇒ rc=0（AC-7）', ok,
          'rc={} rc_req={}'.format(rc_s, rc_h))

    rc, out = frun(['freeze-set', '--phase', '04', '--force'])
    body3 = read(cs)
    n3 = body3.count('\n    - path: "')
    ok = (rc == 0 and 'BASELINE SET' in out and 'refroze' in body3
          and 'c=1 a=0 m=0' in body3 and n3 == 7)
    check('T18e --force 覆盖 ⇒ events 记 refroze 计数（AC-13）', ok,
          'rc={} refroze={} files={}'.format(rc, 'refroze' in body3, n3))

    # T19 四分类（★ P-006：断言只取本轮相对增量，不硬编码扫描总数）
    setup_freeze_fixture()
    frun(['freeze-set', '--phase', '04'])
    eng = TESTROOT / ('.' + CANON_IDE) / REL.parent / 'engine'
    orig_a = read(eng / 'a.md')
    (eng / 'a.md').write_text(orig_a + ' 改一行\n', encoding='utf-8', newline='')
    rc, out = frun(['freeze-check'])
    check('T19a 内容改写一行 ⇒ 变化 1（AC-4）',
          rc == 0 and '变化 1 ｜ 新增 0 ｜ 消失 0' in out, 'rc={}'.format(rc))

    setup_freeze_fixture()
    frun(['freeze-set', '--phase', '04'])
    eng = TESTROOT / ('.' + CANON_IDE) / REL.parent / 'engine'
    orig_a = read(eng / 'a.md')
    (eng / 'a.md').write_text(orig_a + ' 改一行\n', encoding='utf-8', newline='')
    (eng / 'a.md').write_text(orig_a, encoding='utf-8', newline='')
    rc, out = frun(['freeze-check'])
    check('T19b 还原原文 ⇒ 变化 0（AC-4 归零）',
          rc == 0 and '变化 0 ｜ 新增 0 ｜ 消失 0' in out, 'rc={}'.format(rc))

    setup_freeze_fixture()
    frun(['freeze-set', '--phase', '04'])
    (TESTROOT / ('.' + CANON_IDE) / REL.parent / 'engine' / 'c.md').write_text(
        '# c\n', encoding='utf-8', newline='')
    rc, out = frun(['freeze-check'])
    check('T19c 新增 engine/c.md ⇒ 新增 1（AC-5）',
          rc == 0 and '变化 0 ｜ 新增 1 ｜ 消失 0' in out, 'rc={}'.format(rc))

    setup_freeze_fixture()
    frun(['freeze-set', '--phase', '04'])
    (TESTROOT / ('.' + CANON_IDE) / REL.parent / 'engine' / 'b.md').unlink()
    rc, out = frun(['freeze-check'])
    check('T19d 删除 engine/b.md ⇒ 消失 1（AC-5）',
          rc == 0 and '变化 0 ｜ 新增 0 ｜ 消失 1' in out, 'rc={}'.format(rc))

    # T20 三态负向（AC-6 / AC-9 / AC-12）——★ 改名/恢复必须 try/finally，失败也要复原
    setup_freeze_fixture()
    rc, out = frun(['freeze-check'])
    check('T20a 无基线 ⇒ SKIP(no baseline) rc=0（AC-6）',
          rc == 0 and 'SKIP(no baseline)' in out, 'rc={}'.format(rc))

    setup_freeze_fixture()
    helper = SCRIPTS / 'validate-artifacts.py'
    hidden = SCRIPTS / '_validate-artifacts.py.t20bak'
    ok, det = False, 'rename failed'
    try:
        helper.rename(hidden)
        rc, out = frun(['freeze-set', '--phase', '04'])
        ok = (rc == 2 and 'no validate-artifacts.py' in out
              and 'engine_baseline:' not in read(cs) and version_of(cs) == 1)
        det = 'rc={} v={}'.format(rc, version_of(cs))
    finally:
        if hidden.exists():
            hidden.replace(helper)               # 覆盖式复原，失败不残留
    check('T20b 缺 validate-artifacts.py ⇒ freeze-set rc=2 且零写入（AC-9）', ok, det)

    setup_freeze_fixture()
    nogit = TESTROOT / '_t20_nogit'
    nogit.mkdir(parents=True, exist_ok=True)
    rc, out = frun(['freeze-set', '--phase', '04', '--repo', str(nogit)])
    body = read(cs)
    ok = (rc == 0 and '引擎版本未锚定' in out
          and '\n    anchored: false' in body and '\n    commit: null' in body)
    check('T20c --repo 非 git 目录 ⇒ anchored:false + WARN 未锚定（AC-12）', ok,
          'rc={}'.format(rc))

    # T21 连续 skip（★ 2026-11-20 D-1 防回归：旧判据窗口含前邻居 ⇒ 第 2 步 skip_reason 漏插）
    setup()
    run(['step-skip', '--id', 'step-A', '--reason', 'R-A'])
    rc1, out1 = run(['step-skip', '--id', 'step-B', '--reason', 'R-B'])
    body = read(cs)
    n_reason = body.count('skip_reason:')
    ok = rc1 == 0 and n_reason == 2 and 'R-A' in body and 'R-B' in body
    check('T21 连续两步 skip 各自落 skip_reason（D-1 防回归）', ok,
          'rc={} n_reason={}'.format(rc1, n_reason))

    # T22（★ REQ-007 A1 · 2026-11-20）：phase-advance --to 07 随动置 iteration_status=completed
    setup()
    rc1, _ = run(['phase-advance', '--to', '05', '--confirm-by', 'ide', '--quote', 'T22 通过'])
    s5 = read(cs)
    rc2, _ = run(['phase-advance', '--to', '07', '--confirm-by', 'ide', '--quote', 'T22 通过'])
    s7 = read(cs)
    ok = (rc1 == 0 and rc2 == 0
          and 'iteration_status: "in_progress"' in s5
          and 'iteration_status: "completed"' in s7
          and 'iteration_status → completed（--to 07 随动）' in s7)
    check('T22 phase-advance --to 07 随动 iteration_status=completed（REQ-007 A1）', ok,
          'rc1={} rc2={}'.format(rc1, rc2))

    # T23（★ REQ-008 · 2026-11-22）：step-reset 单步重置（AC-1~AC-4）
    setup(seed_state(steps=[('step-A', 'in_progress'), ('step-B', 'completed')]))
    b1 = block_text(read(cs), 'phase_steps').split('\n')
    rc, out = run(['step-reset', '--step', 'step-A'])
    b2 = block_text(read(cs), 'phase_steps').split('\n')
    diff = [(x, y) for x, y in zip(b1, b2) if x != y]
    ok = (rc == 0 and len(b1) == len(b2) and len(diff) == 1
          and diff[0][1].strip() == 'status: "pending"')
    check('T23a step-reset in_progress→pending（块内仅目标行变，AC-1）', ok,
          'rc={} diff={}'.format(rc, diff[:2]))

    setup(seed_state(steps=[('step-A', 'pending'), ('step-B', 'completed')]))
    v0 = version_of(cs)
    rc_b, _ = run(['step-reset', '--step', 'step-B'])
    ok = rc_b == 2 and version_of(cs) == v0
    check('T23b completed 无 --force ⇒ rc=2 且 version 不变（AC-2）', ok,
          'rc={} v={}'.format(rc_b, version_of(cs)))

    rc_c, _ = run(['step-reset', '--step', 'step-B', '--force'])
    ok = rc_c == 2 and version_of(cs) == v0
    check('T23c --force 缺 --reason ⇒ rc=2 零写入（AC-3）', ok, 'rc={}'.format(rc_c))

    setup(seed_state(steps=[('step-A', 'completed'), ('step-B', 'completed')]))
    rc_d, out_d = run(['step-reset', '--step', 'step-A', '--force', '--reason', 'R23'])
    ok = (rc_d == 0 and 'reason=R23' in read(cs)
          and 'WARN: downstream completed=' in out_d and 'step-B' in out_d)
    check('T23d --force+reason ⇒ rc=0，事件含 reason，下游 WARN（AC-3）', ok,
          'rc={}'.format(rc_d))

    setup(seed_state(steps=[('step-A', 'pending')]))
    v0 = version_of(cs)
    rc_e, _ = run(['step-reset', '--step', 'step-A'])
    ok = rc_e == 0 and version_of(cs) == v0
    check('T23e 已 pending 再 reset ⇒ rc=0 且 version 不变（AC-4 幂等先 return）', ok,
          'rc={} v={}'.format(rc_e, version_of(cs)))

    m0 = md5(cs)
    rc_f1, _ = run(['step-reset'])
    rc_f2, _ = run(['step-reset', '--step', 'no-such'])
    ok = rc_f1 == 2 and rc_f2 == 2 and md5(cs) == m0
    check('T23f 缺 --step / id 不存在 ⇒ rc=2 零写入（AC-1）', ok,
          'rc={}/{}'.format(rc_f1, rc_f2))

    setup(seed_state(steps=[('step-A', 'skipped')]))
    rc_g, _ = run(['step-reset', '--step', 'step-A'])
    ok = rc_g == 0 and 'from=skipped' in read(cs)
    check('T23g skipped 亦回落 pending（from=skipped）', ok, 'rc={}'.format(rc_g))

    # T24（★ REQ-008）：phase-finish 07 完成登记（AC-5 / AC-6）
    setup(seed_state(current_phase='07', phase_status='in_progress'))
    rc, _ = run(['phase-finish'])
    body = read(cs)
    ok = (rc == 0 and 'phase: "07"' in body and 'phase_status: "completed"' in body
          and 'iteration_status: "completed"' in body
          and 'detail: "phase=07 status_fixed=true"' in body)
    check('T24a 07 登记 + phase_status/iteration_status=completed（AC-5）', ok,
          'rc={}'.format(rc))

    v0 = version_of(cs)
    rc2, _ = run(['phase-finish'])
    ok = rc2 == 0 and version_of(cs) == v0
    check('T24b 重复调用幂等 rc=0 且 version 不变（AC-5）', ok,
          'rc={} v={}'.format(rc2, version_of(cs)))

    setup(seed_state(current_phase='06'))
    m0 = md5(cs)
    rc3, _ = run(['phase-finish'])
    ok = rc3 == 2 and md5(cs) == m0
    check('T24c current_phase!=07 ⇒ rc=2 零写入（AC-6）', ok, 'rc={}'.format(rc3))

    s_no_ph = re.sub(r'(?ms)^phase_history:\n(?:  .*\n)+', '', seed_state(current_phase='07'))
    setup(s_no_ph)
    m0 = md5(cs)
    rc4, out4 = run(['phase-finish'])
    ok = rc4 == 2 and md5(cs) == m0 and 'phase_history' in out4
    check('T24d phase_history 块缺失 ⇒ rc=2 零写入（兜底拒绝）', ok, 'rc={}'.format(rc4))

    s_inline = re.sub(r'(?ms)^phase_history:\n(?:  .*\n)+', 'phase_history: []\n',
                      seed_state(current_phase='07'))
    setup(s_inline)
    rc5, _ = run(['phase-finish'])
    ok = rc5 == 0 and 'phase: "07"' in read(cs)
    check('T24e phase_history: [] ⇒ inline 分支追加成功', ok, 'rc={}'.format(rc5))

    # T25（★ REQ-008）：patch --allow-new 白名单新建 + 块键守卫（AC-7 / AC-12）
    setup()
    pj = TESTROOT / '_t25new.json'
    pj.write_text('{"complexity_actual": "T25"}', encoding='utf-8')
    rc, _ = run(['patch', '--allow-new', '--file', str(pj)])
    body = read(cs)
    ok = (rc == 0 and 'complexity_actual: "T25"' in body
          and body.index('complexity_actual:') > body.index('last_updated:'))
    check('T25a complexity_actual 新建成功且紧随 last_updated（AC-7）', ok, 'rc={}'.format(rc))

    setup()
    pj2 = TESTROOT / '_t25bad.json'
    pj2.write_text('{"some_new_key": "x"}', encoding='utf-8')
    v0, m0 = version_of(cs), md5(cs)
    rc2, out2 = run(['patch', '--allow-new', '--file', str(pj2)])
    ok = rc2 == 2 and version_of(cs) == v0 and md5(cs) == m0 and '白名单' in out2
    check('T25b 非白名单新键 ⇒ rc=2 零写入（AC-7）', ok, 'rc={}'.format(rc2))

    setup(seed_state(extra='self_evolve:\n  last_executed: "2026-11-01"\n  patterns_written: []'))
    pj3 = TESTROOT / '_t25blk.json'
    pj3.write_text('{"self_evolve": "x"}', encoding='utf-8')
    v0, m0 = version_of(cs), md5(cs)
    rc3, out3 = run(['patch', '--allow-new', '--file', str(pj3)])
    ok = rc3 == 2 and version_of(cs) == v0 and md5(cs) == m0 and '块/数组' in out3
    check('T25c 块键 self_evolve 即使 --allow-new 也拒绝（AC-12）', ok, 'rc={}'.format(rc3))

    s_no_anchor = re.sub(r'(?m)^last_updated:.*$\n', '', seed_state())
    setup(s_no_anchor)
    pj4 = TESTROOT / '_t25anchor.json'
    pj4.write_text('{"complexity_actual": "x"}', encoding='utf-8')
    m0 = md5(cs)
    rc4, out4 = run(['patch', '--allow-new', '--file', str(pj4)])
    ok = rc4 == 2 and md5(cs) == m0 and 'last_updated' in out4
    check('T25d 锚 last_updated 缺失 ⇒ rc=2 零写入（拒绝而非兜底）', ok, 'rc={}'.format(rc4))

    # T26（★ REQ-008）：新事件记账契约（AC-8）
    setup(seed_state(steps=[('step-A', 'in_progress')]))
    run(['step-reset', '--step', 'step-A'])
    body = read(cs)
    ok = ('event: "step_reset"' in body
          and 'detail: "step=step-A from=in_progress reason=(none)"' in body)
    check('T26a step_reset 事件 + detail 契约（AC-8）', ok, '')

    setup(seed_state(current_phase='07'))
    run(['phase-finish'])
    body = read(cs)
    ok = ('event: "phase_finished"' in body
          and 'detail: "phase=07 status_fixed=true"' in body)
    check('T26b phase_finished 事件 + detail 契约（AC-8）', ok, '')

    run(['self-heal', '--class', 'compile', '--attempt', '2', '--subject', 'x.cs:1'])
    body = read(cs)
    rc, _ = run(['self-heal', '--class', 'bogus', '--subject', 'y'])
    ok = ('event: "self_heal"' in body
          and 'detail: "class=compile attempt=2/3 subject=x.cs:1"' in body and rc == 2)
    check('T26c self_heal 事件契约 + 非白名单 class 拒绝（AC-8）', ok, 'rc={}'.format(rc))

    # T27（★ #29）：set-block 块键整块写入通道（幂等 / 拒绝护栏）
    setup()
    pj27a = TESTROOT / '_t27a.json'
    pj27a.write_text('{"self_evolve": {"last_executed": "2026-11-22", "patterns_written": []}}', encoding='utf-8')
    rc, out = run(['set-block', '--file', str(pj27a)])
    body = read(cs)
    ok = (rc == 0 and version_of(cs) == 2
          and 'self_evolve:' in body
          and '  last_executed: "2026-11-22"' in body
          and '  patterns_written: []' in body)
    check('T27a set-block 写入新块（self_evolve）且 version+1', ok, 'rc={}'.format(rc))

    v0 = version_of(cs)
    rc2, out2 = run(['set-block', '--file', str(pj27a)])
    ok = rc2 == 0 and version_of(cs) == v0 and '无需变更' in out2
    check('T27b set-block 幂等零写入（version 不变）', ok, 'rc={}'.format(rc2))

    pj27c = TESTROOT / '_t27c.json'
    pj27c.write_text('{"self_evolve": "x"}', encoding='utf-8')
    v0 = version_of(cs)
    rc3, out3 = run(['set-block', '--file', str(pj27c)])
    ok = rc3 == 2 and version_of(cs) == v0 and '值必须是对象' in out3
    check('T27c set-block 标量键拒绝 rc=2（零写入）', ok, 'rc={}'.format(rc3))

    pj27d = TESTROOT / '_t27d.json'
    pj27d.write_text('{"self_evolve": {"last_executed": {"nested": true}}}', encoding='utf-8')
    v0 = version_of(cs)
    rc4, out4 = run(['set-block', '--file', str(pj27d)])
    ok = rc4 == 2 and version_of(cs) == v0 and '不支持' in out4
    check('T27d set-block 嵌套对象拒绝 rc=2（零写入）', ok, 'rc={}'.format(rc4))

    pj27e = TESTROOT / '_t27e.json'
    pj27e.write_text('{"phase_steps": {"a": "b"}}', encoding='utf-8')
    v0 = version_of(cs)
    rc5, out5 = run(['set-block', '--file', str(pj27e)])
    ok = rc5 == 2 and version_of(cs) == v0 and '黑名单' in out5
    check('T27e set-block 黑名单键拒绝 rc=2（零写入）', ok, 'rc={}'.format(rc5))

    # ── T28：缺块自愈 + defect-add --status（2026-11-24 · 迭代 2026-11-24-002 D-1/D-2 实需）──
    #   背景：该迭代 state 由**手工最小模板**建出，无 `blockers:`/`defects:` ⇒ `defect-add` 直接
    #   拒绝；而 `set-block` 又把这两键列入黑名单 ⇒ 缺陷台账没有合法写入通道（实测撞墙）。
    #   修法 = `append_list` 在 `missing` 时自建块（本次改动），本组即该分支的回归。
    _no_blocks = SEED.format(iid=IID).replace('blockers: []\n', '').replace('defects: []\n', '')
    setup(state=_no_blocks)
    cs = canon_state()
    _t0 = read(cs)
    check('T28a 夹具本身缺 blockers/defects 块',
          'blockers:' not in _t0 and 'defects:' not in _t0)
    v0 = version_of(cs)
    rc1, _ = run(['defect-add', '--id', 'D-9', '--desc', '缺块自愈', '--severity', 'P1', '--level', 'L1'])
    _t1 = read(cs)
    ok = rc1 == 0 and 'defects:' in _t1 and 'D-9' in _t1 and version_of(cs) == v0 + 1
    check('T28b 缺 defects 块 ⇒ defect-add 自建块并写入（validate 通过）', ok,
          'rc={} v={}'.format(rc1, version_of(cs)))
    rc2, _ = run(['blocker-add', '--id', 'B-9', '--desc', '占位阻塞', '--type', 'compile'])
    _t2 = read(cs)
    ok = rc2 == 0 and 'blockers:' in _t2 and 'B-9' in _t2
    check('T28c 缺 blockers 块 ⇒ blocker-add 自建块并写入', ok, 'rc={}'.format(rc2))
    rc3, _ = run(['blocker-rm', '--id', 'B-9'])
    # ★ 只断言「列表项已消失且块回落 inline empty」—— `events[]` 的 detail 会留 `B-9` 字样，
    #   用整文件 `'B-9' not in text` 会假红（首跑实测）。
    _t3 = read(cs)
    ok = rc3 == 0 and re.search(r'- id: "B-9"', _t3) is None and 'blockers: []' in _t3
    check('T28d 自建块内条目可正常移除（回落 `blockers: []`）', ok, 'rc={}'.format(rc3))
    rc4, _ = run(['defect-add', '--id', 'D-10', '--desc', '转下轮', '--severity', 'P1', '--level', 'L1',
                  '--status', 'deferred'])
    ok = rc4 == 0 and re.search(r'- id: "D-10".*?status: "deferred"', read(cs), re.S) is not None
    check('T28e defect-add --status deferred（承接下轮）', ok, 'rc={}'.format(rc4))
    v0 = version_of(cs)
    rc5, _ = run(['defect-add', '--id', 'D-11', '--desc', 'x', '--status', 'fixed'])
    ok = rc5 == 2 and version_of(cs) == v0 and 'D-11' not in read(cs)
    check('T28f --status fixed 拒绝 rc=2（零写入，fixed 只走 defect-close）', ok, 'rc={}'.format(rc5))
    rc6, _ = run(['defect-close', '--id', 'D-9', '--verified-by', 'agent'])
    _t6 = read(cs)
    ok = (rc6 == 0 and _t6.count('defects:') == 1
          and re.search(r'- id: "D-9".*?status: "fixed".*?fixed_at:', _t6, re.S) is not None)
    check('T28g 自建块内 defect-close 生效且块头不重复', ok, 'rc={}'.format(rc6))

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
