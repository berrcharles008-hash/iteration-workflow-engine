#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync-runtime —— 跨宿主侧 runtime 同步（★ FIX-49 v2.4 · R9 方案 B · 2026-10-15）

定位：跨侧对齐的**唯一显式通道**。state-apply 已改为「单写本侧」（写路径零跨侧触碰）⇒
      宿主接力 / 首次接入（α 态）/ 副本分叉时，跑本脚本收敛。

用法（从项目根执行）:
  python {IDE}/skills/iteration-workflow/scripts/sync-runtime.py [--from <ide>] [--dry-run] [--text "<说明>"]

通用化（R9 动因）：按**目录约定**自动发现全部侧 —— 扫 `<PROJECT>/.{ide}/skills/iteration-workflow/runtime/`
      （`.[a-z]+` 且 runtime/ 存在即认）⇒ 新增宿主（codex/opencode…）**零脚本改动**
      （仅门禁 `normalizeHostIde` 白名单需加一行侧名；本脚本按目录发现）。

收敛判定（"新者胜"，规格迁移自 R37）:
  ① `--from <ide>` 显式指定源侧；
  ② 否则比较各侧 `<ACTIVE_ID>.state.yaml` 的 `version` + `last_updated` **双判**，新者为源；
  ③ 同 version 同时间但内容不同（按行尾归一后比较）⇒ **拒绝（exit 2）+ 强制双侧备份 + 人工介入**
     （MD5 仅记录/告警，不参与拒绝 —— CRLF/LF 形态差异防误判，沿 R37 取舍）；
  ④ 仅一侧有数据 ⇒ 该侧为源（α 态 / 首次接入引导场景）。

同步范围 = **镜像面白名单**（R6 语义保留）：`ACTIVE` + 当前迭代 `<ID>.state.yaml`。
     运行产物（gate-audit / write-claims / metrics / qq 通知）与归档面**永不触碰**。

写入行为：对"非源侧"逐侧复制两文件（**逐字节**，二进制拷贝）；内容相同则跳过（**幂等**，可重跑、
      中断后重跑即收敛）；目标侧 runtime 目录不存在则创建（首次接入自举）；逐侧写非原子由幂等兜底。

留痕：每次执行向**各侧** `runtime/sync-runtime.log` 追加一行
      （时间 / 源侧 / 版本从→到 / 文件数 / 说明）⇒ 可审计。

退出码：0 = 收敛完成（含"已一致无需动作"）；2 = 拒绝（并列冲突 / 参数或环境错误 / --from 非法）。
"""
import argparse
import datetime
import hashlib
import os
import pathlib
import shutil
import sys

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

SELF = pathlib.Path(__file__).resolve()
REL = pathlib.Path('skills') / 'iteration-workflow' / 'runtime'
# 演练/隔离根：与 state-apply.py 同口径（默认 = 上溯 4 级项目根；STATE_APPLY_ROOT 覆盖）
ROOT = pathlib.Path(os.environ.get('STATE_APPLY_ROOT') or SELF.parents[4])
DISCOVER_SKIP = {'worktrees'}          # .codebuddy/worktrees 之类非宿主侧目录（保留位）


def side_runtime(ide):
    return ROOT / ('.' + ide) / REL


def discover_sides():
    """按目录约定发现全部宿主侧：`<ROOT>/.{a-z}+/skills/iteration-workflow/` 存在即认。

    ★ 为何以 **skill 目录**（而非 `runtime/`）为判据：首次接入（α 态）时目标侧 skill 已安装但
      `runtime/` 尚未建 ⇒ 若要求 runtime 存在则目标侧不被发现，自举无从发生
      （本脚本对目标侧 `runtime/` 会自动 mkdir —— ③-3b「目标侧 runtime 不存在则创建」）。
    """
    out = []
    try:
        for p in sorted(ROOT.iterdir()):
            if not p.is_dir():
                continue
            name = p.name
            if not name.startswith('.') or len(name) < 2:
                continue
            ide = name[1:]
            if not ide.isalpha() or not ide.islower() or ide in DISCOVER_SKIP:
                continue
            if (p / 'skills' / 'iteration-workflow').is_dir():
                out.append((ide, p / REL))
    except Exception:
        pass
    return out


def read_text(p):
    with open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def norm_text(p):
    """行尾归一（去 CR）—— 仅用于"内容是否等价"比较；拷贝仍走二进制"""
    return read_text(p).replace('\r\n', '\n')


def md5_of(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def read_active_id(rt):
    p = rt / 'ACTIVE'
    if not p.exists():
        return ''
    try:
        lines = read_text(p).splitlines()
    except Exception:
        return ''
    return lines[0].strip() if lines else ''


def state_info(rt, iid):
    """返回 (exists, version, last_updated, path)"""
    p = rt / (iid + '.state.yaml')
    if not iid or iid == 'none' or not p.exists():
        return (False, -1, '', p)
    try:
        t = norm_text(p)
    except Exception:
        return (False, -1, '', p)
    ver, upd = -1, ''
    for ln in t.split('\n'):
        if ln.startswith('version:'):
            try:
                ver = int(ln.split(':', 1)[1].strip() or -1)
            except Exception:
                ver = -1
        elif ln.startswith('last_updated:'):
            upd = ln.split(':', 1)[1].strip().strip('"')
    return (True, ver, upd, p)


def backup_pair(a_path, b_path, tag):
    """并列冲突 ⇒ 强制双侧备份（各自落本侧 snapshots/ 下），返回备份路径清单"""
    out = []
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    for p in (a_path, b_path):
        if not p or not p.exists():
            continue
        d = p.parent / 'snapshots' / ('sync-runtime-{}-{}'.format(tag, ts))
        try:
            d.mkdir(parents=True, exist_ok=True)
            dst = d / p.name
            shutil.copyfile(str(p), str(dst))
            out.append(str(dst))
        except Exception as ex:                       # noqa: BLE001
            out.append('备份失败: {} ({})'.format(p, ex))
    return out


def append_log(sides, line):
    for _ide, rt in sides:
        try:
            rt.mkdir(parents=True, exist_ok=True)
            with open(rt / 'sync-runtime.log', 'a', encoding='utf-8', newline='') as f:
                f.write(line + '\n')
        except Exception:
            pass


def sync_file(src, dst_dir, name, dry_run):
    """逐字节复制（内容相同返回 'same'；复制返回 'copied'）"""
    src_p = src / name
    if not src_p.exists():
        return 'absent'
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst_p = dst_dir / name
    if dst_p.exists():
        try:
            if open(src_p, 'rb').read() == open(dst_p, 'rb').read():
                return 'same'
        except Exception:
            pass
    if dry_run:
        return 'would-copy'
    shutil.copyfile(str(src_p), str(dst_p))
    return 'copied'


def main():
    ap = argparse.ArgumentParser(add_help=True, description='FIX-49 跨宿主侧 runtime 同步（镜像面白名单）')
    ap.add_argument('--from', dest='src', default='', help='显式指定源侧（如 codebuddy / claude）')
    ap.add_argument('--dry-run', action='store_true', help='只报告将要做的动作，不写盘')
    ap.add_argument('--text', default='', help='留痕说明（写入各侧 sync-runtime.log）')
    args = ap.parse_args()

    sides = discover_sides()
    if not sides:
        print('未发现任何宿主侧（<ROOT>/.{ide}/skills/iteration-workflow/runtime/）: ' + str(ROOT))
        return 2
    names = [s[0] for s in sides]
    print('发现宿主侧: ' + ', '.join('.' + n for n in names) + '   （root={}）'.format(ROOT))

    # ── 候选源评估（version + last_updated 双判；R37 规格） ──
    cand = {}      # ide -> (ver, upd, iid, state_path, exists)
    for ide, rt in sides:
        iid = read_active_id(rt)
        ex, ver, upd, spath = state_info(rt, iid)
        cand[ide] = (ver, upd, iid, spath, ex)

    src = ''
    if args.src:
        if args.src not in names:
            sys.stderr.write('--from 指定的侧不在发现列表内: {}（发现: {}）\n'.format(args.src, ', '.join(names)))
            return 2
        src = args.src
    else:
        withdata = [ide for ide in names if cand[ide][4]]          # 有 ACTIVE_ID 且有 state
        if len(withdata) == 1:
            src = withdata[0]                                       # ④ 仅一侧有数据 ⇒ 该侧为源
        elif len(withdata) >= 2:
            ranked = sorted(withdata, key=lambda i: (cand[i][0], cand[i][1]), reverse=True)
            top = cand[ranked[0]]
            tied = [i for i in ranked if (cand[i][0], cand[i][1]) == (top[0], top[1])]
            if len(tied) >= 2:
                # ③ 并列 ⇒ 内容等价则视为已收敛；不同 ⇒ 拒绝 + 双侧备份
                base = tied[0]
                diffs = []
                for i in tied[1:]:
                    try:
                        if norm_text(cand[base][3]) != norm_text(cand[i][3]):
                            diffs.append(i)
                    except Exception:
                        diffs.append(i + '(读取失败)')
                if diffs:
                    print('🛑 并列冲突：version={} last_updated={} 两侧内容不同 ⇒ 拒绝（人工介入）'.format(top[0], top[1]))
                    for i in tied:
                        print('   .{}.md5={} {}'.format(i, md5_of(cand[i][3]) if cand[i][3].exists() else '-', cand[i][3]))
                    bks = backup_pair(cand[tied[0]][3], cand[tied[1]][3], 'tie')
                    for b in bks:
                        print('   备份: ' + b)
                    line = '{} REFUSE tie-diverge version={} last_updated={} sides={} text={}'.format(
                        datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), top[0], top[1], ','.join(tied), args.text)
                    if not args.dry_run:
                        append_log(sides, line)
                    return 2
            src = ranked[0]
        else:
            # 全侧均无 state（可能都是 none）⇒ 以 ACTIVE 首行非 none 者优先，否则取发现顺序首个
            print('ℹ 各侧均无 <ID>.state.yaml —— 按 ACTIVE 指针收敛（无迭代数据可比较）')
            src = names[0]

    iid = cand[src][2]
    ver_src, upd_src = cand[src][0], cand[src][1]
    print('源侧 = .{}（ACTIVE_ID={} version={} last_updated={}）'.format(src, iid or 'none', ver_src, upd_src))
    if not cand[src][4] and iid not in ('', 'none'):
        print('⚠ 源侧 ACTIVE={} 但 state 缺失（β 态）——仅同步 ACTIVE 指针'.format(iid))

    # ── 逐侧同步（镜像面白名单） ──
    targets = [(ide, rt) for ide, rt in sides if ide != src]
    if not targets:
        print('仅一个宿主侧 ⇒ 无需同步（幂等空跑）')
        return 0

    total_copied = 0
    src_rt = dict(sides)[src]
    for ide, rt in targets:
        other_id = cand[ide][2]
        if other_id and other_id != iid:
            print('⚠ 非源侧 .{} 的 ACTIVE 为 {}（≠ 源侧 {}）—— 跨宿主并发/接力场景，请人工确认后再继续'
                  .format(ide, other_id, iid or 'none'))
        r1 = sync_file(src_rt, rt, 'ACTIVE', args.dry_run)
        r2 = 'absent'
        if iid and iid != 'none':
            r2 = sync_file(src_rt, rt, iid + '.state.yaml', args.dry_run)
        print('  .{}: ACTIVE={} {}={}'.format(ide, r1, (iid + '.state.yaml') if iid else '(无 state)', r2))
        total_copied += len([x for x in (r1, r2) if x in ('copied', 'would-copy')])

    line = '{} SYNC from={} iid={} v={}->{} files={} dry_run={} text={}'.format(
        datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), src, iid or 'none', ver_src,
        ','.join('{}.{}'.format(i, cand[i][0]) for i, _ in targets), total_copied, args.dry_run, args.text)
    if not args.dry_run:
        append_log(sides, line)
        # 同步后核对（镜像面逐文件 byte 相等）
        bad = []
        for ide, rt in targets:
            for nm in ['ACTIVE'] + ([iid + '.state.yaml'] if iid and iid != 'none' else []):
                a, b = dict(sides)[src] / nm, rt / nm
                if a.exists() and (not b.exists() or open(a, 'rb').read() != open(b, 'rb').read()):
                    bad.append('.{}/{}'.format(ide, nm))
        if bad:
            sys.stderr.write('🛑 同步后核对失败: {}\n'.format(', '.join(bad)))
            return 2
        print('✅ 同步完成（源=.{}，文件动作 {} 项）—— 镜像面逐文件 byte 相等已核对'.format(src, total_copied))
    else:
        print('（--dry-run：未写盘；文件动作 {} 项）'.format(total_copied))
    return 0


if __name__ == '__main__':
    sys.exit(main())
