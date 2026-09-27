# -*- coding: utf-8 -*-
"""
check-s1-anchors.py — S-1 映射节锚常驻审计（SLIM-5 / ST-4）
SSOT：engine/startup-protocol.md「### ★ 引擎大文件定点读映射」节（锚定义唯一源）；
本脚本为机械化兜底（SLIM-1 W-1：映射锚随后续件编辑失效的常驻审计）。
A1 引用豁免依据：startup-protocol.md S-1 映射节末行（「check-s1-anchors.py」字样）。

逻辑：
  1. 解析 S-1 映射节的 6 条文件 bullet（- **{target}**：...），抽取全部「...」标题锚；
  2. 每锚在 engine/{target}.md 中逐字查找（UTF-8 显式读取，禁裸 Get-Content 口径）；
  3. 未命中目标文件时，回扫 engine/*.md 全目录——他处命中记 WARN（跨文件引用，如
     「决策树读全」→ context-discipline.md），全目录皆无记 MISS；
  4. exit 0 = 无 MISS（WARN 不阻断）；exit 1 = 存在 MISS；exit 2 = 用法/环境错误。

用法：
  python check-s1-anchors.py                 # 审计真实 S-1 映射节
  python check-s1-anchors.py --file <path>   # 用副本映射文件做负向验证（注入伪锚 → MISS）

只读脚本，fail-open：任何解析异常输出错误并 exit 2，不阻塞调用方（调用方人工复核）。
"""
import io
import os
import re
import sys

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../iteration-workflow
ENGINE_DIR = os.path.join(SKILL_ROOT, "engine")
DEFAULT_MAP = os.path.join(SKILL_ROOT, "engine", "startup-protocol.md")
SECTION_HEADING = "### ★ 引擎大文件定点读映射"
BULLET_RE = re.compile(r"^- \*\*([A-Za-z0-9_-]+)\*\*：(.*)$")
ANCHOR_RE = re.compile(r"「([^」]+)」")


def read_text(path):
    with io.open(path, encoding="utf-8") as f:   # UTF-8 显式（防 GBK 误判，SLIM-1 教训）
        return f.read()


def parse_section(map_path):
    """返回 [(target_name, [anchor, ...]), ...]；节不存在视为环境错误。"""
    lines = read_text(map_path).splitlines()
    in_section = False
    result = []
    for line in lines:
        if line.strip() == SECTION_HEADING:
            in_section = True
            continue
        if not in_section:
            continue
        m = BULLET_RE.match(line.strip())
        if m:
            result.append((m.group(1), ANCHOR_RE.findall(m.group(2)), line.rstrip()))
        elif result and not line.startswith(("-", " ", "\t")) and line.strip():
            break   # bullet 区结束
    return result


def main():
    args = sys.argv[1:]
    map_path = DEFAULT_MAP
    if args:
        if args[0] == "--file" and len(args) >= 2:
            map_path = os.path.abspath(args[1])
        else:
            print("[ERR] 用法：check-s1-anchors.py [--file <映射文件副本>]")
            sys.exit(2)
    if not os.path.isfile(map_path):
        print("[ERR] 映射文件不存在: %s" % map_path)
        sys.exit(2)

    try:
        entries = parse_section(map_path)
    except Exception as e:   # fail-open
        print("[ERR] 解析失败（fail-open，人工复核）: %r" % e)
        sys.exit(2)
    if not entries:
        print("[ERR] 未解析到 S-1 映射节（标题: %s）" % SECTION_HEADING)
        sys.exit(2)

    # 预读 engine/ 全目录（锚回扫用）
    engine_files = {}
    for fn in sorted(os.listdir(ENGINE_DIR)):
        if fn.endswith(".md"):
            try:
                engine_files[fn] = read_text(os.path.join(ENGINE_DIR, fn))
            except Exception as e:
                print("[WARN] 引擎文件读取失败: %s (%r)" % (fn, e))

    total = warn_n = miss_n = 0
    map_base = os.path.basename(map_path)
    for target, anchors, raw_line in entries:
        target_file = target + ".md"
        target_text = engine_files.get(target_file)
        if target_text is None:
            print("[MISS] 目标文件缺失: engine/%s（映射行存在但文件不在）" % target_file)
            miss_n += len(anchors) or 1
            continue
        for anchor in anchors:
            total += 1
            # 跨文件引用锚：锚前紧邻窗口（40 字符）内标注了其他文件名（如 context-discipline §五-1「决策树读全」）
            pos = raw_line.find("「%s」" % anchor)
            if pos >= 0 and "context-discipline" in raw_line[max(0, pos - 40):pos]:
                warn_n += 1
                print("[WARN] %s ← 「%s」（映射行标注为跨文件引用，不查目标）" % (target_file, anchor))
                continue
            if anchor in target_text:
                print("[PASS] %s ← 「%s」" % (target_file, anchor))
            else:
                hit = [fn for fn, txt in engine_files.items()
                       if fn != map_base and anchor in txt]   # 排除映射文件自身（防自命中假阳性）
                if hit:
                    warn_n += 1
                    print("[WARN] %s ← 「%s」未命中目标，他处命中: %s（跨文件引用？核对映射行）"
                          % (target_file, anchor, ",".join(hit)))
                else:
                    miss_n += 1
                    print("[MISS] %s ← 「%s」engine/ 全目录无命中" % (target_file, anchor))

    print("-" * 60)
    print("合计锚 %d：PASS %d / WARN %d / MISS %d（映射文件: %s）"
          % (total, total - warn_n - miss_n, warn_n, miss_n, os.path.basename(map_path)))
    sys.exit(1 if miss_n else 0)


if __name__ == "__main__":
    main()
