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
  phase-advance --to <NN> --confirm-by <by> [--quote "…"]
                                            [--gate-result passed|conditionally_passed|rejected]
                                            旧阶段入 phase_history + current_phase 推进
                                            + phase_confirm（缺 confirm ⇒ 拒绝）
  blocker-add --id <B-n> --desc "…" [--type <t>]
  blocker-rm  --id <B-n>
  defect-add  --id <D-n> --desc "…" [--severity P0|P1|P2] [--level L1|L2|L3]
                                     [--design-changed true|false]
  defect-close --id <D-n> [--verified-by user|agent]
  patch --file <json>                       顶层标量覆盖（仅已存在键；逃生口）

每次调用内部完成:
  加锁(§9 mkdir 原子锁+TLL 60s) → 读 canonical(.claude 优先) → 幂等检查 → 文本级改字段
  → version+1 / last_updated → 变更前重读比对(乐观锁) → 备份 → 双副本写
  → 两侧 ACTIVE Line2 同步(STATUS/PHASE/TASKS/BLOCKERS/UPDATED) → 单源校验(runpy validate-state.py)
  → 失败回滚(state+ACTIVE 双侧) → 自留痕(write-claims.jsonl + gate-audit.log STATE_APPLY) → 释放锁

环境变量:
  STATE_FORCE_WRITE=1   跳过锁与版本比对（逃生口）
  STATE_APPLY_ROOT      演练/隔离根（默认 = 上溯 4 级项目根）
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

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

SELF = pathlib.Path(__file__).resolve()
RUNTIME_SELF = SELF.parents[1] / 'runtime'          # <IDE>/skills/iteration-workflow/runtime
VALIDATE = SELF.parent / 'validate-state.py'        # 单源校验脚本（同目录）
ROOT = pathlib.Path(os.environ.get('STATE_APPLY_ROOT') or SELF.parents[4])
SNAPSHOTS = RUNTIME_SELF / 'snapshots'
LOG = RUNTIME_SELF / 'state-apply.log'
SESSION = os.environ.get('STATE_APPLY_SESSION') or ('pid-' + str(os.getpid()))

ALLOWED_CONFIRM_BY = ('qq#', 'ide', 'handoff', 'bypass')


def rt(ide):
    return ROOT / ('.' + ide) / 'skills' / 'iteration-workflow' / 'runtime'


def say(msg=''):
    print(msg)


def log(msg):
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
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

    canon = 'claude' if (rt('claude') / 'ACTIVE').exists() else 'codebuddy'
    mirror = 'codebuddy' if canon == 'claude' else 'claude'
    iid = os.environ.get('STATE_APPLY_STATE') or active_id(canon)
    if iid in ('', 'none'):
        say('无活跃迭代（ACTIVE=none/缺失）→ 拒绝')
        return 2
    spath = rt(canon) / (iid + '.state.yaml')
    mpath = rt(mirror) / (iid + '.state.yaml')
    if not spath.exists():
        say('canonical state 不存在: ' + str(spath))
        return 2

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

        else:
            say('未知命令: ' + cmd + '（-h 查看用法）')
            return 2

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

        SNAPSHOTS.mkdir(exist_ok=True)
        bak = SNAPSHOTS / ('state-apply-{}-{}.state.yaml.bak'.format(
            datetime.datetime.now().strftime('%Y%m%d-%H%M%S'), iid))
        write_text(bak, orig, crlf)
        m_orig = read_text(mpath).replace('\r\n', '\n') if mpath.exists() else None
        apath_c, apath_m = rt(canon) / 'ACTIVE', rt(mirror) / 'ACTIVE'
        ab_c = ab_m = None
        if apath_c.exists():
            with open(apath_c, 'rb') as f:
                ab_c = f.read()
        if apath_m.exists():
            with open(apath_m, 'rb') as f:
                ab_m = f.read()

        write_text(spath, new, crlf)
        if m_orig is not None:
            write_text(mpath, new, crlf)
        sync_active_line2(canon, new, stamp)
        sync_active_line2(mirror, new, stamp)

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
            if m_orig is not None:
                write_text(mpath, m_orig, crlf)
            if ab_c is not None:
                with open(apath_c, 'wb') as f:
                    f.write(ab_c)
            if ab_m is not None:
                with open(apath_m, 'wb') as f:
                    f.write(ab_m)
            say('❌ validate-state.py 校验失败（rc={}），已回滚 state + ACTIVE 双侧；输出：'.format(vrc))
            say(vbuf.getvalue()[-800:])
            return 1

        trail(canon, iid, cmd, ' | '.join(changed[:3]), ver, ver + 1, spath)
        say('✅ {} 完成（{}）'.format(cmd, iid))
        for c in changed:
            say('  · ' + c)
        say('  双副本: {} + {} | ACTIVE Line2 已同步 | validate exit 0 | 留痕: write-claims + STATE_APPLY | 备份: {}'.format(
            canon, mirror, bak.name))
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
