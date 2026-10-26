#!/usr/bin/env python3
"""scan-placeholders.py — engine/ 占位符扫描 · 分类 · 归零自检

为什么需要它：`{{}}` 一词多义（manifest 变量 / 运行时变量 / 脚本渲染 / 文档语法示例），
没有分类就无法判「未定义」——A10-b 只能整块 SKIP。本脚本消费 `inject-template.py`
的五类 schema（import，**不另抄一份定义**），把 engine/ 里出现的每个占位符落到具体类别，
从而把「未归类」变成一个可归零的判据。

分类口径（SSOT = `scripts/inject-template.py` 顶部五常量）：
  ①a alias     短名别名，需映射到 manifest 展平键
  ①b path      含 '.' 的 manifest 路径
  ②  runtime   运行时变量（Agent 动态确定）
  ③  script    脚本渲染
  ④  slot      文档语法示例（须改写为 <...>，不进入产物）
  未归类        = 不在以上任何一类 ⇒ `--verify` 失败

用法:
  python scripts/scan-placeholders.py                 # 扫描 + 写 CSV
  python scripts/scan-placeholders.py --verify        # 未归类 0 项 ⇒ exit 0
  python scripts/scan-placeholders.py --csv out.csv   # 自定义输出
  python scripts/scan-placeholders.py --include-scripts  # 连带 scripts/**（噪声更多）

CSV 口径：**每(类别 × 占位符名) 一行**，列 `class,name,count,files`；
`files` = `相对路径:次数`，多项以 `;` 连接。

基线（实测，勿抄旧数）：schema 共 **51** 项 —— ①a 5 / ①b 10 / ② 5 / ③ 23 / ④ 8。
engine 内实际出现的种类：**43**（④ 内容槽 8 项已于 2026-10-25 改写为 `<...>` ⇒ 不再出现在扫描结果里）。
`--include-scripts` 会额外看到注入器 dry-run 打印模板里的 1 处自指（预期噪声，不在任何判据链上）；
注释里请勿写占位符字面量 —— 会被本脚本当成未归类扫出来（D-1 就是这么来的）。
"""

import argparse
import collections
import csv
import importlib.util
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(SCRIPT_DIR)
DEFAULT_CSV = os.path.join(SKILL_ROOT, 'runtime', 'metrics', 'placeholder-scan.csv')


def load_schema_module():
    """按路径加载 inject-template.py（文件名含连字符，无法直接 import 名字）。

    fail-closed：加载失败直接 exit 2 —— 宁可红，不要用「扫到 0 个占位符」的假绿
    掩盖 schema 不存在（这正是本迭代要治的静默失败形态）。
    """
    path = os.path.join(SCRIPT_DIR, 'inject-template.py')
    if not os.path.isfile(path):
        print('[ERROR] 找不到 schema 源: %s' % path)
        sys.exit(2)
    spec = importlib.util.spec_from_file_location('inject_template', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def iter_files(include_scripts):
    """默认只扫 engine/**/*.md；--include-scripts 追加 scripts/**。"""
    roots = [(os.path.join(SKILL_ROOT, 'engine'), ('.md',))]
    if include_scripts:
        roots.append((os.path.join(SKILL_ROOT, 'scripts'),
                      ('.py', '.mjs', '.sh', '.ps1')))
    for root, exts in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in sorted(filenames):
                if fn.endswith(exts):
                    yield os.path.join(dirpath, fn)


def scan(mod, include_scripts):
    """返回 (rows, stats)。

    rows  = [(class, name, count, files_str)]
    stats = {'occ': 总数, 'kinds': 种类数, 'files': 文件数, 'unclassified': [(file, line, name)]}
    """
    agg = collections.defaultdict(lambda: {'count': 0, 'files': collections.Counter()})
    unclassified = []
    total = 0
    files_hit = set()

    for path in iter_files(include_scripts):
        rel = os.path.relpath(path, SKILL_ROOT).replace('\\', '/')
        try:
            with open(path, encoding='utf-8') as f:
                lines = f.read().splitlines()
        except Exception as exc:                      # 编码异常不应静默跳过整文件
            print('[WARN] 读取失败，已跳过: %s（%s）' % (rel, exc))
            continue
        for ln, line in enumerate(lines, 1):
            for m in mod.PLACEHOLDER_RE.finditer(line):
                name = m.group(1)
                total += 1
                files_hit.add(rel)
                cls = mod.classify(name)
                if cls is None:
                    unclassified.append((rel, ln, name))
                    cls = 'unclassified'
                slot = agg[(cls, name)]
                slot['count'] += 1
                slot['files'][rel] += 1

    def cls_order(cls):
        return {'alias': 0, 'path': 1, 'runtime': 2, 'script': 3, 'slot': 4}.get(cls, 9)

    rows = []
    for (cls, name), info in sorted(agg.items(), key=lambda kv: (cls_order(kv[0][0]), kv[0][1])):
        files_str = ';'.join('%s:%d' % (p, c) for p, c in sorted(info['files'].items()))
        rows.append((cls, name, info['count'], files_str))

    kinds = len({name for _cls, name in agg})
    return rows, {'occ': total, 'kinds': kinds, 'files': len(files_hit),
                  'unclassified': unclassified, 'rows': rows}


def write_csv(rows, target):
    parent = os.path.dirname(os.path.abspath(target))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    with open(target, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['class', 'name', 'count', 'files'])
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description='engine/ 占位符扫描与归类自检（纯读，除 CSV 外不写盘）')
    # 本脚本是**人工/回归用**的可读投影；A10-b 的机器判据走 audit-engine（它消费
    # `inject-template.py --schema-dump`，不调用本脚本）。措辞写清，避免两处口径互相冒充。
    ap.add_argument('--verify', action='store_true',
                    help='未归类 0 项 ⇒ exit 0（回归用；不写 CSV）')
    ap.add_argument('--csv', default=DEFAULT_CSV, help='CSV 输出路径（默认 runtime/metrics/）')
    ap.add_argument('--include-scripts', action='store_true',
                    help='连带扫描 scripts/**（默认只扫 engine/**/*.md）')
    ap.add_argument('--no-csv', action='store_true', help='只打印不落 CSV')
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(errors='replace')
    except Exception:
        pass

    mod = load_schema_module()
    rows, st = scan(mod, args.include_scripts)

    counts = collections.Counter(cls for cls, _n, _c, _f in rows)
    print('=== 占位符扫描 · engine/%s ===' % ('** + scripts/**' if args.include_scripts else '**/*.md'))
    print('种类 %d / 出现 %d 处 / 文件 %d 个' % (st['kinds'], st['occ'], st['files']))
    print('五类计数: alias=%d path=%d runtime=%d script=%d slot=%d'
          % (counts.get('alias', 0), counts.get('path', 0), counts.get('runtime', 0),
             counts.get('script', 0), counts.get('slot', 0)))

    # --verify 是判据语境：不得顺手改 runtime/metrics/（判据应可重复执行且无副作用）
    if not args.no_csv and not args.verify:
        write_csv(rows, args.csv)
        print('CSV: %s（%d 行 data）' % (args.csv, len(rows)))

    if st['unclassified']:
        print('')
        print('[ERROR] 未归类占位符 %d 处：' % len(st['unclassified']))
        for rel, ln, name in st['unclassified'][:60]:
            print('   %s:%d  {{%s}}' % (rel, ln, name))
        if len(st['unclassified']) > 60:
            print('   ...（其余 %d 处省略）' % (len(st['unclassified']) - 60))
        if args.verify:
            sys.exit(1)
    else:
        print('[OK] 未归类占位符 0 处（五类 schema 全覆盖）')

    sys.exit(0)


if __name__ == '__main__':
    main()
