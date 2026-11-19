#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""state-apply —— 迭代状态文件「意图式写入」通道（PERF-1 正式版 · 2026-10-03）

解决问题：一次状态更新原需 2~4 个模型 step（读 state → 双副本写 → ACTIVE → 校验）。
本脚本把「读」的职责移入脚本，Agent 只发一条意图命令 ⇒ 简单更新 1 个 step 完成。

用法（从项目根执行）:
  python {IDE}/skills/iteration-workflow/scripts/state-apply.py <命令> [选项]

命令:
  summary --text "…"                        last_session_summary + last_updated
  step-complete --id <step-id>              phase_steps[].status = completed（幂等）
                                            （--id 含 user-confirm 时输出 QQ 门登记附注，仅提醒不改状态）
  step-skip --id <step-id> --reason "…"     status = skipped + skip_reason
  task-done [--id <task-id>]                tasks_completed+1，从 tasks_pending 移除
  phase-advance --to <NN> --confirm-by <by> [--quote "…"] [--quote-src <文件>]
                                           [--gate-result passed|conditionally_passed|rejected]
                                           旧阶段入 phase_history + current_phase 推进
                                           + phase_confirm（缺 confirm ⇒ 拒绝）
                                           ★ TOOL-ANSWERKIND：quote 真伪校验（见 verify_quote）
                                             --quote-src 给来源文件 ⇒ quote 必须逐字命中；
                                             quote 含 answer=/allowed= 等元数据 ⇒ 拒绝；
                                             quote 点名 ask#N 且该答案 allowed=false ⇒ 拒绝
  blocker-add --id <B-n> --desc "…" [--type <t>]
  blocker-rm  --id <B-n>
  defect-add  --id <D-n> --desc "…" [--severity P0|P1|P2] [--level L1|L2|L3]
                                     [--design-changed true|false]
  defect-close --id <D-n> [--verified-by user|agent]
  patch --file <json>                       顶层标量覆盖（仅已存在键；逃生口）
  append-steps --steps "id|name|status|mandatory;…"
                                            phase_steps **块末追加**（替代 phase-07 内联脚本；
                                            重复 id 即拒绝；status 缺省 pending / mandatory 缺省 true）
  rotate-team [--reason "…"]                 所有 in_progress 步骤回落 pending（会话/模型切换后接手）
  resume [--json]                            ★只读：返回下一步行动（不建锁/不备份/不写 state 与 ACTIVE）
  baseline-set [--phase NN]                  M1：记 artifact_baseline（阶段**开始**时调用；记当前阶段
                                            目录下全部 md 的 sha256 前 16 位）
  artifact-check [--phase NN] [--require-baseline] [--json]
                                             ★只读：基线后「新增/变化/未变」分类；**未变** = 沿用旧文件⇒拒

★ M2（2026-11-19）events[]：每次**成功**写入会在 state.yaml 末尾 `events:` 块追加一条
  （at / event / version / detail），**只增不改、不允许 Agent 手写**。它是审计旁路与
  运行健康度评分的数据源，**不是**真相源（状态字段仍是唯一真相源，不由 events 重放推导）。
  历史 state 无该块属正常态（fail-open，不回溯补齐）。

★ M1（2026-11-19）artifact_baseline：`prepare` / `finish` 的等价物（本引擎原无阶段开始/结束双钩子）。
  为什么用内容 hash 而不是 mtime：要拦的正是「把旧迭代的产物复制过来 / 阶段开始时就有同名文件、
  结束没重写」——复制会刷新 mtime，内容不变，mtime 判不出来。
  位置为什么在 state.yaml 而不是 runtime/temp：M2 已把 state 写入统一进本脚本（version + 备份 +
  events + validate 四道关），放 temp 等于再开一条无审计旁路。
  分工：**内容合同**（章节存在/非空/非占位、跨迭代复用）由 `scripts/validate-artifacts.py` 判；
  本脚本只管**基线相对变化**。两者都不通过 ⇒ 不得推进/归档。

每次调用内部完成:
  加锁(§9 mkdir 原子锁+TLL 60s) → 读 canonical(**本宿主侧**，FIX-49) → 幂等检查 → 文本级改字段
  → version+1 / last_updated → 变更前重读比对(乐观锁) → 备份 → **单写本侧**
  → 本侧 ACTIVE Line2 同步(STATUS/PHASE/TASKS/BLOCKERS/UPDATED) → 单源校验(runpy validate-state.py)
  → 失败回滚(本侧 state + ACTIVE) → 自留痕(write-claims.jsonl + gate-audit.log STATE_APPLY) → 释放锁

★ FIX-49（2026-10-15 实施 · 四件套 v2.4 · 用户裁定 R1/R9）:
  canonical = **当前宿主侧**（CodeBuddy → .codebuddy；Claude Code → .claude），宿主身份四级解析
  （STATE_APPLY_SIDE[仅测试/演练] > GATE_HOST_IDE[shim 注入] > *_PROJECT_DIR env > 脚本自身位置）；
  解析失败 = **fail-closed（rc=2）**，不做"猜一侧"兜底（R1）。
  **单写本侧**：写路径零跨侧触碰（原「双副本写 + 回落护栏 + 强制镜像」随 R3/R37 一并作废）——
  跨侧一致性 = 显式同步（`scripts/sync-runtime.py`，按"新者胜"收敛）。

环境变量:
  STATE_FORCE_WRITE=1   跳过锁与版本比对（逃生口）
  STATE_APPLY_ROOT      演练/隔离根（默认 = 上溯 4 级项目根）
  STATE_APPLY_SIDE      测试/演练显式侧名（★ R44 加固：须与 GATE_TEST_SANDBOX=1 或 STATE_APPLY_ROOT 同现）
  STATE_APPLY_STATE     覆盖迭代 ID（默认读 ACTIVE）
  STATE_APPLY_SESSION   留痕用 session id（默认 pid-<pid>）

不覆盖（仍走人工/文件工具）: reopen 10 步协议、归档重命名、多 Story 全量重置、stories[] 深层。
"""
import io
import os
import re
import sys
import time
import json
import shutil
import runpy
import datetime
import pathlib
import importlib.util

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

SELF = pathlib.Path(__file__).resolve()
VALIDATE = SELF.parent / 'validate-state.py'        # 单源校验脚本（同目录）
ROOT = pathlib.Path(os.environ.get('STATE_APPLY_ROOT') or SELF.parents[4])
# ★ 2026-11-19 修：日志与备份落点**不再**挂在脚本安装位置（原 `RUNTIME_SELF/snapshots`、
#   `RUNTIME_SELF/state-apply.log`）。原写法在隔离根（`run-state-tests.py` 的 TESTROOT 演练）里
#   仍写**真实项目**的 runtime ⇒ 实测一次回归往生产 `state-apply.log` 灌 26 行
#   `iter=TEST-STATE-APPLY`、往 `snapshots/` 留 41 个测试备份，把「写入次数」类基线永久污染。
#   现在统一走 `runtime_dir()`（= `ROOT/<IDE>/skills/iteration-workflow/runtime`，跟随 STATE_APPLY_ROOT）。
SESSION = os.environ.get('STATE_APPLY_SESSION') or ('pid-' + str(os.getpid()))

ALLOWED_CONFIRM_BY = ('qq#', 'ide', 'handoff', 'bypass')

# ★ TOOL-ANSWERKIND（2026-10-20 · 工单见 runtime/TOOL-ANSWERKIND-四件套.md §9）：phase_confirm.quote 真伪校验。
#   事故：用户 QQ 回选项 D「回 IDE 原会话拍板」，答案文件 answer=ide/defer-ide（allowed=false），
#   主 Agent 读成「IDE 已确认」，自撰 quote「用户 IDE 确认评审通过（ask#2 answer=ide @…）」，
#   旧实现只判「quote 非空」⇒ 通过，连续伪推进 01→02 / 02→03。
#   三条 fail-closed 规则（专治"把答复元数据当用户原话"）：
#     ① `--quote-src <文件>` ⇒ quote 必须逐字命中该文件（去空白后包含）；
#     ② quote 自身含 answer= / allowed= / answerKind 等元数据 ⇒ 拒绝（用户不会这么说）；
#     ③ quote 点名 ask#N / 答案#N / qq#N，而该答案文件 allowed=false ⇒ 拒绝（无授权答复不能充当确认来源）。
#   ★ 不收紧 ALLOWED_CONFIRM_BY：`by:"ide"` = 用户在本会话直接发言，是最主要的合法路径
#     （state-protocol §3.3；run-state-tests T6 断言其 rc=0），移除会逼出 bypass 滥用。
ANSWER_SIDES = ('codebuddy', 'claude')
QUOTE_META_RE = re.compile(r'(answer[A-Za-z]*\s*=|\ballowed\s*=|answerKind)', re.I)
QUOTE_ASK_RE = re.compile(r'(?:ask\s*#|答案\s*#|qq\s*#)\s*(\d+)', re.I)


def _flat(s):
    """去空白归一（中文标点/换行/缩进不参与比对，防"逐字"过脆）"""
    return re.sub(r'\s+', '', str(s or ''))


def answer_file(ans_id):
    """答案文件解析（双侧探测；FIX-49 单写本侧下两侧都可能存在）"""
    for side in ANSWER_SIDES:
        p = ROOT / ('.' + side) / 'temp' / 'qq-answers' / (str(ans_id) + '.json')
        if p.exists():
            return p
    return None


def answer_allowed(j):
    """机器判据 = allowed（与 tools/qqbot 同口径）；旧答案文件按 answer 值回退"""
    if isinstance(j, dict) and isinstance(j.get('allowed'), bool):
        return j['allowed']
    return str((j or {}).get('answer') or '') in ('confirm', 'choice', 'text')


def verify_quote(quote, quote_src):
    """quote 真伪前置校验（见本节头注释）。返回 (ok, reason)。"""
    q = _flat(quote)
    if not q:
        return True, ''
    if QUOTE_META_RE.search(quote or ''):
        return False, ('quote 含答复元数据（answer= / allowed= / answerKind）⇒ 判定为自撰，'
                       '不是用户原话；请填用户在 IDE 里的**逐字原话**')
    if quote_src:
        p = pathlib.Path(quote_src) if os.path.isabs(quote_src) else (ROOT / quote_src)
        if not p.exists():
            return False, '--quote-src 指向的文件不存在: ' + str(quote_src)
        try:
            body = _flat(p.read_text(encoding='utf-8', errors='replace'))
        except Exception as e:
            return False, '--quote-src 读取失败: ' + str(e)
        if q not in body:
            return False, 'quote 未逐字出现于 --quote-src 指定文件（去空白后不包含）'
    for m in QUOTE_ASK_RE.findall(quote or ''):
        p = answer_file(m)
        if p is None:
            continue
        try:
            j = json.loads(p.read_text(encoding='utf-8', errors='replace').lstrip('\ufeff'))
        except Exception:
            return False, 'quote 引用的答案文件无法解析: ' + str(p)
        if not answer_allowed(j):
            return False, ('quote 引用了**无授权答复** ask#' + str(m) + '（answer=' + str(j.get('answer'))
                           + ' ⇒ allowed=false）—— 无授权答复不能作为 by:ide 的确认来源')
    return True, ''


def rt(ide):
    return ROOT / ('.' + ide) / 'skills' / 'iteration-workflow' / 'runtime'


def norm_ide(v):
    """宿主侧名归一（白名单；未知值一律视为未解析）—— 与 gate-check.mjs normalizeHostIde 对称（R2/R27）"""
    s = (v or '').strip().lstrip('.')
    return s if s in ('codebuddy', 'claude') else ''


def resolve_side():
    """★ FIX-49 v2.4：宿主侧解析（四级，与门禁三级 + 测试口对称）。失败返回 ''（调用方 fail-closed）。

    ① `STATE_APPLY_SIDE` —— 测试/演练显式口（★ R44 加固：须与 `GATE_TEST_SANDBOX=1` 或
       `STATE_APPLY_ROOT` 同现才生效；否则**忽略并告警**，防生产环境残留变量静默改写 canonical）
    ② `GATE_HOST_IDE` —— hook shim 注入（shim 位置 = 宿主位置）
    ③ 环境变量 `CODEBUDDY_PROJECT_DIR` > `CLAUDE_PROJECT_DIR`
    ④ 脚本自身位置（…/<IDE>/skills/iteration-workflow/scripts/state-apply.py → parents[3]）
    """
    explicit = norm_ide(os.environ.get('STATE_APPLY_SIDE'))
    if explicit:
        if os.environ.get('GATE_TEST_SANDBOX') == '1' or os.environ.get('STATE_APPLY_ROOT'):
            return explicit
        sys.stderr.write('[state-apply][FIX-49] 忽略 STATE_APPLY_SIDE={}：该口仅限测试/演练'
                         '（须与 GATE_TEST_SANDBOX=1 或 STATE_APPLY_ROOT 同现）。\n'.format(explicit))
    inj = norm_ide(os.environ.get('GATE_HOST_IDE'))
    if inj:
        return inj
    if os.environ.get('CODEBUDDY_PROJECT_DIR'):
        return 'codebuddy'
    if os.environ.get('CLAUDE_PROJECT_DIR'):
        return 'claude'
    try:
        return norm_ide(SELF.parents[3].name)      # 片1 2a 已核：parents[3] = <IDE> 目录
    except Exception:
        return ''


def runtime_dir(ide=None):
    """本侧项目的 runtime 目录（跟随 `STATE_APPLY_ROOT`，**不**跟随脚本安装位置）。

    日志、备份、留痕一律落这里；隔离根演练时自然落进演练目录，不再污染真实项目 runtime。
    """
    return rt(ide or resolve_side() or 'codebuddy')


def say(msg=''):
    print(msg)


def log(msg):
    """写本侧 runtime 的 `state-apply.log`（见 runtime_dir 头注：不再跟随脚本安装位置）。"""
    try:
        p = runtime_dir() / 'state-apply.log'
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, 'a', encoding='utf-8') as f:
            f.write(datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S') + ' ' + msg + '\n')
    except Exception:
        pass


def trail(canon, iid, cmd, detail, v_from, v_to, spath):
    """自留痕：write-claims.jsonl（CONC 口径）+ gate-audit.log（STATE_APPLY tag）"""
    try:
        wc = rt(canon) / 'write-claims.jsonl'
        rec = {'k': 'w', 't': int(time.time() * 1000), 's': SESSION,
               'p': str(spath).replace('\\', '/'), 'tool': 'StateApply', 'cmd': cmd}
        with open(wc, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception:
        pass
    try:
        ga = rt(canon) / 'gate-audit.log'
        line = '[{}] STATE_APPLY cmd={} iter={} v={}->{} detail={}\n'.format(
            datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), cmd, iid, v_from, v_to, detail)
        with open(ga, 'a', encoding='utf-8') as f:
            f.write(line)
    except Exception:
        pass


def read_text(p):
    with open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write_text(p, s, crlf=False):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s.replace('\n', '\r\n') if crlf else s)


def active_id(ide):
    p = rt(ide) / 'ACTIVE'
    if not p.exists():
        return 'none'
    lines = read_text(p).splitlines()
    return lines[0].strip() if lines else 'none'


# ---------------------------------------------------------------- YAML 文本工具

def get_scalar(text, key, default=None):
    m = re.search(r'^' + re.escape(key) + r':\s*(.*)$', text, re.M)
    if not m:
        return default
    v = m.group(1).strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1]
    return v


def set_scalar(lines, key, value, quote=True):
    pat = re.compile(r'^' + re.escape(key) + r':\s*.*$')
    new = '{}: {}'.format(key, ('"' + value + '"') if quote else value)
    for i, ln in enumerate(lines):
        if pat.match(ln):
            lines[i] = new
            return True
    return False


def block_span(lines, key):
    """顶层映射块（key: 及其缩进子行）"""
    for i, ln in enumerate(lines):
        if re.match(r'^' + re.escape(key) + r':', ln):
            j = i + 1
            while j < len(lines) and lines[j].startswith(' '):
                j += 1
            return (i, j)
    return None


def set_block(lines, key, block_lines, anchor_after=None):
    sp = block_span(lines, key)
    if sp:
        lines[sp[0]:sp[1]] = block_lines
        return True
    if anchor_after:
        for i, ln in enumerate(lines):
            if re.match(r'^' + re.escape(anchor_after) + r':', ln):
                lines[i + 1:i + 1] = block_lines
                return True
    lines.extend(block_lines)
    return True


def list_span(lines, key, indent=2):
    """顶层列表：('inline_empty', s, e, []) | ('block', s, e, [(s,e,id)…]) | ('missing',-1,-1,[])"""
    rx = re.compile(r'^' + re.escape(key) + r':\s*(.*)$')
    for i, ln in enumerate(lines):
        m = rx.match(ln)
        if not m:
            continue
        rest = m.group(1).strip()
        if rest.startswith('['):
            return ('inline_empty', i, i + 1, [])
        pad = ' ' * indent + '- '
        items, cur = [], None
        j = i + 1
        while j < len(lines):
            ln2 = lines[j]
            if ln2.startswith(pad):
                if cur:
                    items.append(cur)
                cur = [j, j + 1, None]
            elif ln2.strip() == '' or ln2.startswith(' '):
                if cur:
                    cur[1] = j + 1
            else:
                break
            j += 1
        if cur:
            items.append(cur)
        out = []
        for a, b, _ in items:
            m2 = re.search(r'-\s+id:\s*"([^"]+)"', lines[a])
            out.append((a, b, m2.group(1) if m2 else ''))
        return ('block', i, j, out)
    return ('missing', -1, -1, [])


def append_list(lines, key, item_lines):
    kind, s, e, items = list_span(lines, key)
    if kind == 'inline_empty':
        lines[s] = key + ':'
        lines[s + 1:s + 1] = item_lines
        return True
    if kind == 'block':
        lines[e:e] = item_lines
        return True
    return False


def remove_list_item(lines, key, item_id):
    kind, s, e, items = list_span(lines, key)
    if kind != 'block':
        return False
    for a, b, iid in items:
        if iid == item_id:
            del lines[a:b]
            kind2, s2, e2, items2 = list_span(lines, key)
            if kind2 == 'block' and not items2:
                lines[s2] = key + ': []'
            return True
    return False


# ---------------- ★ M2（2026-11-19）：append-only events + 只读 resume
EVENT_OF = {
    'summary': 'session_summary',
    'step-complete': 'step_completed',
    'step-skip': 'step_skipped',
    'task-done': 'task_completed',
    'phase-advance': 'phase_advanced',
    'blocker-add': 'blocker_added',
    'blocker-rm': 'blocker_removed',
    'defect-add': 'defect_opened',
    'defect-close': 'defect_closed',
    'patch': 'state_patched',
    'append-steps': 'steps_appended',
    'rotate-team': 'workflow_team_rotated',
    'baseline-set': 'artifact_baseline_set',
}


def append_event(lines, etype, detail, stamp, ver_to):
    """块末追加一条事件；块不存在时在文件末尾建 `events:`（末尾插入 = 不打乱既有顶层顺序）。
    边界：只增不改 —— 本函数没有修改/删除路径；events 不参与状态推导（非事件溯源）。"""
    ev = ['  - at: "%s"' % stamp,
          '    event: "%s"' % etype,
          '    version: %d' % ver_to]
    if detail:
        ev.append('    detail: "' + str(detail).replace('"', '\\"')[:300] + '"')
    if not append_list(lines, 'events', ev):
        lines.append('events:')
        lines.extend(ev)
    return True


def parse_steps(lines):
    """phase_steps → [{id,name,status,mandatory}]（只读）"""
    kind, s, e, items = list_span(lines, 'phase_steps')
    out = []
    if kind != 'block':
        return out
    cur = None
    for j in range(s + 1, e):
        m = re.search(r'-\s+id:\s*"([^"]+)"', lines[j])
        if m:
            cur = {'id': m.group(1), 'name': '', 'status': '', 'mandatory': ''}
            out.append(cur)
            continue
        if cur is None:
            continue
        m2 = re.match(r'\s+(name|status|mandatory):\s*"?([^"\n]*?)"?\s*$', lines[j])
        if m2:
            cur[m2.group(1)] = m2.group(2).strip()
    return out


def cmd_resume(spath, iid, as_json=False):
    """★ 只读：返回「下一步做什么」。硬约束：不建锁、不备份、不写 state 与 ACTIVE（mtime 必须不变）。"""
    text = read_text(spath).replace('\r\n', '\n')
    lines = text.split('\n')
    status = get_scalar(text, 'iteration_status', '')
    phase = get_scalar(text, 'current_phase', '')
    pstat = get_scalar(text, 'phase_status', '')
    steps = parse_steps(lines)
    running = [x for x in steps if x['status'] == 'in_progress']
    must = [x for x in steps if x['status'] == 'pending' and x['mandatory'] == 'true']
    opt_steps = [x for x in steps if x['status'] == 'pending' and x['mandatory'] != 'true']
    blockers = []
    kind, _s, _e, items = list_span(lines, 'blockers')
    if kind == 'block':
        blockers = [x[2] for x in items if x[2]]
    events = []
    kind2, s2, e2, _ = list_span(lines, 'events')
    if kind2 == 'block':
        cur = None
        for j in range(s2 + 1, e2):
            m = re.search(r'-\s+at:\s*"([^"]+)"', lines[j])
            if m:
                cur = {'at': m.group(1)}
                events.append(cur)
                continue
            if cur is not None:
                m2 = re.match(r'\s+(event|detail):\s*"?(.*?)"?\s*$', lines[j])
                if m2:
                    cur[m2.group(1)] = m2.group(2)
    if status == 'completed':
        nxt, nkind = '迭代已结案：nothing-to-do（新工作请立项）', 'done'
    elif running:
        nxt, nkind = '继续 step %s（%s）' % (running[0]['id'], running[0]['name']), 'step'
    elif must:
        nxt, nkind = '执行 step %s（%s，mandatory）' % (must[0]['id'], must[0]['name']), 'step'
    elif opt_steps:
        nxt, nkind = '按需执行 step %s（%s）' % (opt_steps[0]['id'], opt_steps[0]['name']), 'step'
    elif phase and phase != '07' and pstat != 'completed':
        nxt, nkind = '阶段 %s 步骤已完 → phase-advance --to %02d（需用户确认）' % (phase, int(phase) + 1), 'advance'
    else:
        nxt, nkind = '阶段 %s 收尾（phase-07 归档动作）' % (phase or '?'), 'wrap'
    out = {
        'ok': True, 'iteration_id': iid, 'iteration_status': status,
        'phase': phase, 'phase_status': pstat, 'next': nxt, 'next_kind': nkind,
        'steps': {'total': len(steps),
                  'in_progress': [x['id'] for x in running],
                  'pending_mandatory': [x['id'] for x in must],
                  'pending_optional': [x['id'] for x in opt_steps]},
        'blockers': blockers, 'recent_events': events[-3:], 'readonly': True,
    }
    if as_json:
        say(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    say('迭代 %s ｜ STATUS=%s ｜ PHASE=%s(%s)' % (iid, status or '?', phase or '?', pstat or '?'))
    say('下一步：' + nxt)
    if blockers:
        say('阻塞中：' + ','.join(blockers))
    if events:
        say('最近事件：')
        for ev in events[-3:]:
            say('  · %s %s %s' % (ev.get('at', ''), ev.get('event', ''), ev.get('detail', '')))
    say('（只读：未加锁 / 未备份 / 未写 state 与 ACTIVE）')
    return 0


# ---------------- ★ M1（2026-11-19）：artifact_baseline（prepare）+ artifact-check（finish 判据）
ARTIFACT_HELPER = SELF.parent / 'validate-artifacts.py'
ARTIFACT_MANIFEST = SELF.parents[1] / 'engine' / 'templates' / 'manifest.json'
BASELINE_KEY = 'artifact_baseline'


def load_artifact_helper():
    """按路径加载 validate-artifacts.py（文件名含连字符，无法按名字 import）。失败返回 None。"""
    if not ARTIFACT_HELPER.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location('validate_artifacts', str(ARTIFACT_HELPER))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception as exc:                                  # noqa: BLE001
        log('artifact helper load failed: ' + repr(exc))
        return None


def norm_phase(v):
    s = str(v or '').strip().strip('"')
    if s.isdigit():
        s = s.zfill(2)
    return s


def scan_phase_artifacts(helper, iid, phase):
    """扫「当前迭代 · 该阶段目录」下全部 .md → ({相对项目根路径: sha16}, iter_dir, 错误说明)。

    ★ 用 `collect_phase_files`（阶段目录全量）而非合同 filenames：`04-代码审查报告.md` 这类
      合同外产物同样属阶段产出，漏记会让"未变"判定漏掉一批文件。
    """
    if not ARTIFACT_MANIFEST.exists():
        return {}, '', '内容合同缺失: ' + str(ARTIFACT_MANIFEST)
    try:
        manifest = helper.load_manifest(str(ARTIFACT_MANIFEST))
    except Exception as exc:                                  # noqa: BLE001
        return {}, '', '内容合同解析失败: ' + repr(exc)
    art = None
    for a in manifest.get('artifacts') or []:
        if str(a.get('phase') or '') == phase:
            art = a
            break
    if art is None:
        return {}, '', 'manifest 未声明阶段 ' + phase
    iterations_dir = str(manifest.get('docs_iterations_default') or 'docs/iterations').strip().strip('/')
    iter_dir = ROOT / iterations_dir / iid
    if not iter_dir.is_dir():
        return {}, str(iter_dir), '迭代目录不存在: ' + str(iter_dir)
    out = {}
    for p in helper.collect_phase_files(str(iter_dir), art):
        try:
            rel = pathlib.Path(p).resolve().relative_to(ROOT.resolve()).as_posix()
        except Exception:                                     # noqa: BLE001
            rel = pathlib.Path(p).name
        try:
            out[rel] = helper.sha256_of(p)[:16]
        except OSError:
            continue
    return out, str(iter_dir), ''


def baseline_block(phase, stamp, files):
    blk = [BASELINE_KEY + ':', '  phase: "%s"' % phase, '  set_at: "%s"' % stamp]
    if not files:
        blk.append('  files: []')
        return blk
    blk.append('  files:')
    for rel in sorted(files):
        blk += ['    - path: "%s"' % rel, '      sha: "%s"' % files[rel]]
    return blk


def parse_baseline(text):
    """解析 state 的 artifact_baseline 块；不存在返回 None（历史 state 无该块属正常态）。"""
    lines = text.replace('\r\n', '\n').split('\n')
    sp = block_span(lines, BASELINE_KEY)
    if not sp:
        return None
    out = {'phase': '', 'set_at': '', 'files': {}}
    cur = None
    for ln in lines[sp[0] + 1:sp[1]]:
        m = re.match(r'\s+phase:\s*"([^"]*)"', ln)
        if m:
            out['phase'] = m.group(1)
            continue
        m = re.match(r'\s+set_at:\s*"([^"]*)"', ln)
        if m:
            out['set_at'] = m.group(1)
            continue
        m = re.match(r'\s*-\s+path:\s*"([^"]*)"', ln)
        if m:
            cur = m.group(1)
            out['files'][cur] = ''
            continue
        m = re.match(r'\s+sha:\s*"([^"]*)"', ln)
        if m and cur:
            out['files'][cur] = m.group(1)
    return out


def cmd_artifact_check(spath, iid, phase_arg, require_baseline, as_json=False):
    """★ 只读：基线后「新增 / 变化 / 未变 / 消失」四分类。

    判据：**未变**（基线里有、内容 hash 相同）⇒ 该产物在阶段内没被重写 ⇒ 拒。
    硬约束与 resume 同：不建锁、不备份、不写 state 与 ACTIVE（mtime 必须不变）。
    """
    text = read_text(spath).replace('\r\n', '\n')
    phase = norm_phase(phase_arg or get_scalar(text, 'current_phase', ''))
    blk = parse_baseline(text)
    helper = load_artifact_helper()
    errors = []
    if helper is None:
        say('[SKIP] validate-artifacts.py 不可用（%s）⇒ 跳过基线比对' % ARTIFACT_HELPER)
        return 0
    now, iter_dir, why = scan_phase_artifacts(helper, iid, phase)
    if why:
        msg = '无法扫描阶段产物：' + why
        if require_baseline:
            errors.append(msg)
        else:
            say('[SKIP] ' + msg)
        now = {}
    new, changed, same, gone = [], [], [], []
    usable = False
    if blk is None:
        msg = '基线缺失（state 无 %s）' % BASELINE_KEY
        if require_baseline:
            errors.append(msg + ' ⇒ 阶段开始时应跑 baseline-set --phase ' + phase)
        else:
            say('[SKIP] ' + msg + '（--require-baseline 可强制）')
    elif blk['phase'] != phase:
        msg = '基线阶段 %s ≠ 当前阶段 %s（跨阶段复用无意义）' % (blk['phase'] or '?', phase)
        if require_baseline:
            errors.append(msg + ' ⇒ 重跑 baseline-set --phase ' + phase)
        else:
            say('[WARN] ' + msg)
    else:
        usable = True
        base = blk['files']
        for rel, sha in sorted(now.items()):
            if rel not in base:
                new.append(rel)
            elif base[rel] != sha:
                changed.append(rel)
            else:
                same.append(rel)
        gone = sorted(r for r in base if r not in now)
        for rel in same:
            errors.append('未变：%s（基线后内容未改动 ⇒ 该产物不是本阶段写的）' % rel)

    out = {'ok': not errors, 'iteration_id': iid, 'phase': phase,
           'baseline': None if blk is None else {'phase': blk['phase'], 'set_at': blk['set_at'],
                                                'files': len(blk['files'])},
           'iter_dir': iter_dir.replace('\\', '/'), 'new': new, 'changed': changed,
           'unchanged': same, 'gone': gone, 'errors': errors, 'readonly': True}
    if as_json:
        say(json.dumps(out, ensure_ascii=False, indent=2))
        return 1 if errors else 0
    say('阶段 %s ｜ 基线 %s ｜ 迭代 %s' % (
        phase,
        ('%s（%s，%d 文件）' % (blk['phase'], blk['set_at'], len(blk['files']))) if blk else '缺失',
        iid))
    if usable:
        say('新增 %d ｜ 变化 %d ｜ 未变 %d ｜ 消失 %d'
            % (len(new), len(changed), len(same), len(gone)))
        for rel in new:
            say('  + 新增 ' + rel)
        for rel in changed:
            say('  ~ 变化 ' + rel)
        for rel in same:
            say('  = 未变 ' + rel)
        for rel in gone:
            say('  - 消失 ' + rel)
    for e in errors:
        say('[ERROR] ' + e)
    if errors:
        say('基线比对未通过 ⇒ 不得归档/推进')
        return 1
    say('（只读：未加锁 / 未备份 / 未写 state 与 ACTIVE）')
    return 0


def find_step_status(lines, step_id):
    """定位 phase_steps 中某 step 的 status 行 → (行号, 当前值) 或 None"""
    for i, ln in enumerate(lines):
        if ln.strip() == '- id: "' + step_id + '"':
            for j in range(i + 1, min(i + 8, len(lines))):
                if re.match(r'\s*status:\s*"', lines[j]):
                    m = re.search(r'"([^"]*)"', lines[j])
                    return (j, m.group(1) if m else '?')
            return None
    return None


# ---------------------------------------------------------------- 主流程

def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ('-h', '--help'):
        say(__doc__)
        return 0 if argv else 2
    cmd, args = argv[0], argv[1:]

    # ★ FIX-49 v2.4：恒 canon = **本宿主侧**（单写；无 OTHER / 无回落 / 无镜像）
    #   · 身份解析失败 ⇒ fail-closed（R1）：不做"猜一侧"兜底，暴露注入链/环境问题。
    #   · 本侧数据缺失两态语义：α 态（本侧 runtime 全空）⇒ 正常"无活跃迭代"路径，跨侧对齐由
    #     `scripts/sync-runtime.py` 显式执行；β 态（ACTIVE 有值但 state 缺失）⇒ 上层门禁拦截
    #     （gate ③-2b 提示跑 sync）。
    canon = resolve_side()
    if canon not in ('codebuddy', 'claude'):
        msg = ('[state-apply][FIX-49] 宿主身份解析失败（STATE_APPLY_SIDE/GATE_HOST_IDE/'
               '*_PROJECT_DIR env/脚本自身位置四级均不可识别）——R1 裁定不做兜底，fail-closed（rc=2）；'
               '请排查运行环境而非"猜一侧"。\n')
        sys.stderr.write(msg)
        say(msg)
        return 2
    iid = os.environ.get('STATE_APPLY_STATE') or active_id(canon)
    if iid in ('', 'none'):
        say('无活跃迭代（ACTIVE=none/缺失）→ 拒绝')
        return 2
    spath = rt(canon) / (iid + '.state.yaml')
    if not spath.exists():
        say('canonical state 不存在: ' + str(spath))
        return 2

    # ★ M2：resume 是**只读**命令 —— 必须在 mkdir 锁之前返回，否则会留下 .lock 目录（改写文件系统）。
    if cmd == 'resume':
        return cmd_resume(spath, iid, as_json=('--json' in args))

    # ★ M1：artifact-check 同为只读（finish 判据）⇒ 同层提前返回
    if cmd == 'artifact-check':
        return cmd_artifact_check(spath, iid, opt(args, '--phase', ''),
                                  '--require-baseline' in args, as_json=('--json' in args))

    force = os.environ.get('STATE_FORCE_WRITE') == '1'
    lock = rt(canon) / (iid + '.lock')
    if not force:
        try:
            lock.mkdir()
        except FileExistsError:
            try:
                age = time.time() - lock.stat().st_mtime
            except Exception:
                age = 0
            if age > 60:
                shutil.rmtree(lock, ignore_errors=True)
                lock.mkdir()
            else:
                say('🛑 state.yaml 被锁定（{}，{}s < 60s TTL）—— 若为残留锁请手动删除'.format(lock, int(age)))
                return 2
    try:
        raw = read_text(spath)
        crlf = '\r\n' in raw
        orig = raw.replace('\r\n', '\n')
        new = orig
        stamp = datetime.datetime.now().strftime('%Y-%m-%dT%H:%M')
        ver = int(get_scalar(new, 'version', '0') or 0)
        cur_sum = get_scalar(new, 'last_session_summary', '') or ''
        changed = []
        lines = new.split('\n')

        # ---------------- 命令分发
        if cmd == 'summary':
            txt = opt(args, '--text', '')
            if not txt:
                say('summary 需要 --text "…"')
                return 2
            if txt == cur_sum:
                say('无需变更（幂等：summary 与现值相同）')
                return 0
            esc = txt.replace('\\', '\\\\').replace('"', '\\"')
            new = re.sub(r'^last_session_summary:\s*".*"\s*$',
                         'last_session_summary: "' + esc + '"', new, flags=re.M)
            changed.append('last_session_summary')

        elif cmd in ('step-complete', 'step-skip'):
            sid = opt(args, '--id', '')
            if not sid:
                say('{} 需要 --id <step-id>'.format(cmd))
                return 2
            hit = find_step_status(lines, sid)
            if hit is None:
                say('未找到 step id: ' + sid)
                return 2
            j, old = hit
            if cmd == 'step-complete':
                if 'user-confirm' in sid:
                    say('⚠ 用户确认点：按 waiting-protocol §2 须先 ask.js 登记 QQ 门再进入等待（方案 A/D/B 三选一）')
                if old == 'completed':
                    say('无需变更（幂等：{} 已是 completed）'.format(sid))
                    return 0
                lines[j] = re.sub(r'"[^"]*"', '"completed"', lines[j])
                changed.append('phase_steps[{}] {} → completed'.format(sid, old))
            else:
                reason = opt(args, '--reason', '')
                if not reason:
                    say('step-skip 需要 --reason "…"')
                    return 2
                if old == 'skipped':
                    say('无需变更（幂等：{} 已是 skipped）'.format(sid))
                    return 0
                lines[j] = re.sub(r'"[^"]*"', '"skipped"', lines[j])
                if not re.search(r'^\s*skip_reason:', '\n'.join(lines[j - 6:j + 8]), re.M):
                    lines.insert(j + 1, '    skip_reason: "' + reason.replace('"', '\\"') + '"')
                changed.append('phase_steps[{}] {} → skipped'.format(sid, old))
            new = '\n'.join(lines)

        elif cmd == 'task-done':
            tid = opt(args, '--id', None)
            kind, s, e, items = list_span(lines, 'tasks_pending')
            done_inc = True
            if kind == 'block' and items:
                target = items[0]
                if tid:
                    target = None
                    for it in items:
                        if it[2] == tid:
                            target = it
                            break
                    if target is None:
                        say('tasks_pending 中未找到 id: ' + tid)
                        return 2
                del lines[target[0]:target[1]]
                kind2, s2, e2, items2 = list_span(lines, 'tasks_pending')
                if kind2 == 'block' and not items2:
                    lines[s2] = 'tasks_pending: []'
                changed.append('tasks_pending 移除 {}'.format(target[2] or '(无 id)'))
            elif kind == 'inline_empty':
                changed.append('tasks_pending 已空（仍 +1）')
            elif tid:
                say('tasks_pending 中未找到 id: ' + tid)
                return 2
            tc = int(get_scalar('\n'.join(lines), 'tasks_completed', '0') or 0)
            set_scalar(lines, 'tasks_completed', str(tc + 1), quote=False)
            tt = get_scalar('\n'.join(lines), 'tasks_total', '0')
            changed.append('tasks_completed {} → {} / {}'.format(tc, tc + 1, tt))
            new = '\n'.join(lines)

        elif cmd == 'phase-advance':
            to = opt(args, '--to', '')
            by = opt(args, '--confirm-by', '')
            quote = opt(args, '--quote', '')
            quote_src = opt(args, '--quote-src', '')
            gate = opt(args, '--gate-result', '')
            if not re.fullmatch(r'0[1-7]', to or ''):
                say('phase-advance 需要 --to <01..07>')
                return 2
            if not by or not any(by.startswith(p) or by == p for p in ALLOWED_CONFIRM_BY):
                say('phase-advance 拒绝：--confirm-by 缺失或非法（允许 qq#N / ide / handoff / bypass）')
                return 2
            if by == 'ide' and not quote:
                say('phase-advance 拒绝：by=ide 时 --quote 必填（用户通过语原文）')
                return 2
            # ★ TOOL-ANSWERKIND：quote 必须像"用户原话"，且不得引用无授权答复（详见 verify_quote 头注释）
            okq, whyq = verify_quote(quote, quote_src)
            if not okq:
                say('phase-advance 拒绝：' + whyq)
                return 2
            old = get_scalar(new, 'current_phase', '')
            if old == to:
                say('无需变更（幂等：current_phase 已是 {}）'.format(to))
                return 0
            hist = ['  - phase: "{}"'.format(old), '    status: "completed"',
                    '    completed_at: "{}"'.format(stamp)]
            if gate:
                hist += ['    review_gate:', '      result: "{}"'.format(gate),
                         '      assessed_at: "{}"'.format(opt(args, '--gate-assessed-at', stamp))]
            if not append_list(lines, 'phase_history', hist):
                say('未找到 phase_history 列表 → 拒绝（结构异常）')
                return 2
            set_scalar(lines, 'current_phase', to)
            set_scalar(lines, 'phase_status', 'in_progress')
            conf = ['phase_confirm:', '  from: "{}"'.format(old), '  to: "{}"'.format(to),
                    '  by: "{}"'.format(by), '  at: "{}"'.format(stamp)]
            if quote:
                conf.append('  quote: "' + quote.replace('\\', '\\\\').replace('"', '\\"') + '"')
            set_block(lines, 'phase_confirm', conf, anchor_after='last_session_summary')
            new = '\n'.join(lines)
            changed.append('current_phase {} → {}（confirm by {}）'.format(old, to, by))
            changed.append('phase_history 追加 {} completed；phase_steps 未动（请按需初始化）'.format(old))

        elif cmd in ('blocker-add', 'blocker-rm'):
            bid = opt(args, '--id', '')
            if not bid:
                say('{} 需要 --id'.format(cmd))
                return 2
            if cmd == 'blocker-add':
                desc = opt(args, '--desc', '')
                if not desc:
                    say('blocker-add 需要 --desc "…"')
                    return 2
                item = ['  - id: "' + bid + '"', '    type: "' + opt(args, '--type', 'other') + '"',
                        '    desc: "' + desc.replace('"', '\\"') + '"',
                        '    created_at: "' + stamp + '"']
                if not append_list(lines, 'blockers', item):
                    say('未找到 blockers 列表 → 拒绝')
                    return 2
                new = '\n'.join(lines)
                changed.append('blockers 追加 ' + bid)
            else:
                if not remove_list_item(lines, 'blockers', bid):
                    say('blockers 中未找到 id: ' + bid)
                    return 2
                new = '\n'.join(lines)
                changed.append('blockers 移除 ' + bid)

        elif cmd in ('defect-add', 'defect-close'):
            did = opt(args, '--id', '')
            if not did:
                say('{} 需要 --id'.format(cmd))
                return 2
            if cmd == 'defect-add':
                desc = opt(args, '--desc', '')
                if not desc:
                    say('defect-add 需要 --desc "…"')
                    return 2
                sev = opt(args, '--severity', 'P2')
                lvl = opt(args, '--level', 'L1')
                dc = str(opt(args, '--design-changed', 'false')).lower()
                if sev not in ('P0', 'P1', 'P2') or lvl not in ('L1', 'L2', 'L3') or dc not in ('true', 'false'):
                    say('defect-add 参数非法（severity P0-P2 / level L1-L3 / design-changed true|false）')
                    return 2
                item = ['  - id: "' + did + '"', '    desc: "' + desc.replace('"', '\\"') + '"',
                        '    severity: "' + sev + '"', '    root_cause_level: "' + lvl + '"',
                        '    design_changed: ' + dc, '    status: "open"',
                        '    opened_at: "' + stamp + '"']
                if not append_list(lines, 'defects', item):
                    say('未找到 defects 列表 → 拒绝')
                    return 2
                new = '\n'.join(lines)
                changed.append('defects 追加 {}（{} / {}）'.format(did, sev, lvl))
            else:
                kind, s, e, items = list_span(lines, 'defects')
                if kind != 'block':
                    say('defects 列表缺失 → 拒绝')
                    return 2
                tgt = None
                for a, b, iid2 in items:
                    if iid2 == did:
                        tgt = (a, b)
                        break
                if tgt is None:
                    say('defects 中未找到 id: ' + did)
                    return 2
                a, b = tgt
                for j in range(a, b):
                    if re.match(r'\s*status:\s*"', lines[j]):
                        lines[j] = re.sub(r'"[^"]*"', '"fixed"', lines[j])
                        lines.insert(j + 1, '    fixed_at: "' + stamp + '"')
                        break
                if opt(args, '--verified-by'):
                    for j in range(a, b + 1):
                        if re.match(r'\s*fixed_at:', lines[j]):
                            lines.insert(j + 1, '    verified_by: "' + opt(args, '--verified-by') + '"')
                            break
                new = '\n'.join(lines)
                changed.append('defects[{}] → fixed'.format(did))

        elif cmd == 'patch':
            pf = opt(args, '--file', '')
            if not pf or not pathlib.Path(pf).exists():
                say('patch 需要 --file <json 路径>')
                return 2
            try:
                data = json.loads(read_text(pathlib.Path(pf)).lstrip('\ufeff'))
            except Exception as ex:
                say('patch JSON 解析失败: ' + repr(ex))
                return 2
            if not isinstance(data, dict):
                say('patch JSON 必须是对象（顶层标量键值）')
                return 2
            for k, v in data.items():
                if get_scalar(new, k, None) is None:
                    say('patch 拒绝：键不存在（仅允许覆盖已存在顶层标量）: ' + str(k))
                    return 2
                sv = str(v)
                if isinstance(v, bool):
                    sv = 'true' if v else 'false'
                set_scalar(lines, k, sv, quote=not isinstance(v, (int, float, bool)))
                changed.append('{} → {}'.format(k, sv))
            new = '\n'.join(lines)

        elif cmd == 'append-steps':
            spec = opt(args, '--steps', '')
            if not spec:
                say('append-steps 需要 --steps "id|name|status|mandatory;…"')
                return 2
            entries = []
            for chunk in spec.split(';'):
                chunk = chunk.strip()
                if not chunk:
                    continue
                parts = [p.strip() for p in chunk.split('|')]
                if len(parts) < 2 or not parts[0]:
                    say('append-steps 条目格式错误（至少 id|name）: ' + chunk)
                    return 2
                st = parts[2] if len(parts) > 2 and parts[2] else 'pending'
                md = (parts[3] if len(parts) > 3 and parts[3] else 'true').lower() in ('1', 'true', 'yes', 'y')
                if st not in ('pending', 'in_progress', 'completed', 'skipped', 'not_applicable'):
                    say('append-steps status 非法: ' + st)
                    return 2
                entries.append((parts[0], parts[1], st, md))
            if not entries:
                say('append-steps 无有效条目')
                return 2
            kind, s, e, items = list_span(lines, 'phase_steps')
            if kind == 'missing':
                say('未找到 phase_steps → 拒绝（结构异常）')
                return 2
            existing = set(x[2] for x in items if x[2])
            dup = [x[0] for x in entries if x[0] in existing]
            if dup:
                say('ABORT: step id 已存在: ' + ','.join(dup))
                return 2
            block = []
            for sid, name, st, md in entries:
                block += ['  - id: "' + sid + '"',
                          '    name: "' + name.replace('"', '\\"') + '"',
                          '    status: "' + st + '"',
                          '    mandatory: ' + ('true' if md else 'false')]
            if not append_list(lines, 'phase_steps', block):
                say('phase_steps 追加失败')
                return 2
            new = '\n'.join(lines)
            changed.append('phase_steps 块末追加 {} 条（total={}）'.format(len(entries), len(existing) + len(entries)))

        elif cmd == 'baseline-set':
            ph = norm_phase(opt(args, '--phase', '') or get_scalar(new, 'current_phase', ''))
            if not re.fullmatch(r'0[1-7]', ph or ''):
                say('baseline-set 需要 --phase <01..07>（state 无 current_phase 时必须显式给）')
                return 2
            helper = load_artifact_helper()
            if helper is None:
                say('baseline-set 拒绝：validate-artifacts.py 不可用（%s）' % ARTIFACT_HELPER)
                return 2
            files, iter_dir, why = scan_phase_artifacts(helper, iid, ph)
            if why:
                say('baseline-set 拒绝：' + why)
                return 2
            set_block(lines, BASELINE_KEY, baseline_block(ph, stamp, files),
                      anchor_after='last_session_summary')
            new = '\n'.join(lines)
            changed.append('artifact_baseline phase=%s files=%d（phase 内须有新增/变化才放行）'
                           % (ph, len(files)))

        elif cmd == 'rotate-team':
            reason = opt(args, '--reason', '')
            n = 0
            kind, s, e, items = list_span(lines, 'phase_steps')
            if kind == 'block':
                for j in range(s + 1, e):
                    if re.match(r'\s*status:\s*"in_progress"\s*$', lines[j]):
                        lines[j] = re.sub(r'"[^"]*"', '"pending"', lines[j])
                        n += 1
            new = '\n'.join(lines)
            changed.append('rotate-team: in_progress → pending（{} 条）{}'.format(
                n, ('；原因: ' + reason) if reason else ''))

        else:
            say('未知命令: ' + cmd + '（-h 查看用法）')
            return 2

        # ---------------- ★ M2：append-only 事件（只增不改；version 记为目标版本 ver+1）
        lines = new.split('\n')
        append_event(lines, EVENT_OF.get(cmd, cmd), (changed[0] if changed else ''), stamp, ver + 1)
        new = '\n'.join(lines)

        # ---------------- 通用收尾：version / last_updated / 乐观锁 / 备份 / 双写 / ACTIVE / 校验
        lines = new.split('\n')
        set_scalar(lines, 'version', str(ver + 1), quote=False)
        set_scalar(lines, 'last_updated', stamp)
        new = '\n'.join(lines)
        changed.append('version {} → {}'.format(ver, ver + 1))
        changed.append('last_updated → ' + stamp)

        if not force:
            now_v = int(get_scalar(read_text(spath).replace('\r\n', '\n'), 'version', '0') or 0)
            if now_v != ver:
                say('🛑 并发冲突：version 已从 {} 变为 {}（拒绝写入，请重跑）'.format(ver, now_v))
                return 2

        # ★ M2 加固：parents=True —— 演练/新装实例的 runtime/ 可能整体不存在，
        #   原 `mkdir(exist_ok=True)` 在父目录缺失时抛 FileNotFoundError（生产因 runtime 恒存在未暴露）
        snapdir = runtime_dir(canon) / 'snapshots'
        snapdir.mkdir(parents=True, exist_ok=True)
        bak = snapdir / ('state-apply-{}-{}.state.yaml.bak'.format(
            datetime.datetime.now().strftime('%Y%m%d-%H%M%S'), iid))
        write_text(bak, orig, crlf)
        # ★ FIX-49 v2.4（R9 方案 B）：**单写本侧** —— 跨侧文件（mpath/他侧 ACTIVE）零触碰。
        apath_c = rt(canon) / 'ACTIVE'
        ab_c = None
        if apath_c.exists():
            with open(apath_c, 'rb') as f:
                ab_c = f.read()

        write_text(spath, new, crlf)
        sync_active_line2(canon, new, stamp)

        vrc, vbuf = 0, io.StringIO()
        o_argv, o_out = sys.argv, sys.stdout
        try:
            sys.argv = [str(VALIDATE), str(spath)]
            sys.stdout = vbuf
            runpy.run_path(str(VALIDATE), run_name='__main__')
        except SystemExit as e:
            vrc = int(e.code or 0)
        except Exception as e:                        # noqa: BLE001
            vrc = 3
            vbuf.write('EXCEPTION: ' + repr(e))
        finally:
            sys.argv, sys.stdout = o_argv, o_out

        if vrc != 0:
            write_text(spath, orig, crlf)
            if ab_c is not None:
                with open(apath_c, 'wb') as f:
                    f.write(ab_c)
            say('❌ validate-state.py 校验失败（rc={}），已回滚本侧 state + ACTIVE；输出：'.format(vrc))
            say(vbuf.getvalue()[-800:])
            return 1

        trail(canon, iid, cmd, ' | '.join(changed[:3]), ver, ver + 1, spath)
        say('✅ {} 完成（{}）'.format(cmd, iid))
        for c in changed:
            say('  · ' + c)
        say('  单写本侧: {}（canonical=本宿主侧，FIX-49）| 本侧 ACTIVE Line2 已同步 | validate exit 0 | 留痕: write-claims + STATE_APPLY | 备份: {}'.format(
            canon, bak.name))
        log('{} OK iter={} {}'.format(cmd, iid, '; '.join(changed)))
        return 0
    finally:
        if not force:
            shutil.rmtree(lock, ignore_errors=True)


def sync_active_line2(ide, st_text, stamp):
    a = rt(ide) / 'ACTIVE'
    if not a.exists():
        return False

    def g(pat, d=''):
        m = re.search(pat, st_text, re.M)
        return m.group(1) if m else d

    try:
        import yaml
        data = yaml.safe_load(st_text) or {}
    except Exception:
        data = {}
    line2 = 'STATUS={} PHASE={} TASKS={}/{} BLOCKERS={} UPDATED={}'.format(
        g(r'^iteration_status:\s*"([^"]+)"'), g(r'^current_phase:\s*"([^"]+)"'),
        g(r'^tasks_completed:\s*(\d+)', '0'), g(r'^tasks_total:\s*(\d+)', '0'),
        len(data.get('blockers') or []), stamp)
    raw = read_text(a)
    crlf = '\r\n' in raw
    lines = raw.splitlines()
    if len(lines) >= 2:
        lines[1] = line2
    else:
        lines.append(line2)
    write_text(a, '\n'.join(lines) + '\n', crlf)
    return True


if __name__ == '__main__':
    sys.exit(main())
