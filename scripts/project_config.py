#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""project_config.py — 项目配置的 Python 侧读取器（G07/G08/G09 · 迭代 2026-10-25-002）

背景（根因）：`project/project.manifest.yaml` 与新增的 `project/kb-terms.yaml`、
`project/memory-audit.yaml` 此前只有 JS 侧消费者（`engine/gate/project-config.mjs`），
Python 侧三个脚本（`doc_lint.py` / `gen-knowledge-base.py` / `memory_quota.py`）
只能把项目词表写死在代码里 ⇒ 换项目必须改引擎源码。本模块提供**同口径**读取器。

与 `project-config.mjs` 的等价口径（五条，必须保持一致）：

1. **零依赖**：不引入 PyYAML（引擎要能整目录复制到任意项目，不假设依赖已装）。
2. **永不 throw**：文件缺失 / 读失败 / 结构怪 ⇒ 返回空表并打印可排查的绝对路径，
   由调用方降级。**配置读不到 ≠ 放行面放宽**。
3. **定位基准 = SKILL_ROOT**（``Path(__file__).resolve().parent.parent``）——
   实测项目根**没有** `project/` 目录，权威源在 skill 内。
4. **去引号 / 去行内注释**：``#`` 仅在引号外且前面是空白时才算注释起点。
5. **空串等同缺键**：``key: ""`` ⇒ 该键视为未配置。

三个导出函数的分工（避免 ``list[str]`` 承载不了 ``键: 值`` 语义而静默全落 unmapped）：

- ``read_scalars(path)`` → ``dict``（扁平点号键，如 ``paths.docs_iterations``）
- ``read_pairs(path, section)`` → ``list[tuple[str, str]]``（``- Key: 值``）
- ``read_bare(path, section)`` → ``list[str]``（``- 裸串``）
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

# ── 定位基准 ────────────────────────────────────────────────────────────────
# scripts/ 的上一级 = skill 根（<skill>/scripts/project_config.py → <skill>）
SKILL_ROOT = Path(__file__).resolve().parent.parent

# ── 解析口径（与 project-config.mjs 对齐）────────────────────────────────────
_KEY_RE = re.compile(r"^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$")
_LIST_RE = re.compile(r"^\s*-\s*(.*)$")


def _unquote(raw: str) -> str:
    """去掉行内注释与引号（与 project-config.mjs 的 unquote 同口径）。"""
    v = "" if raw is None else str(raw)
    out = []
    quote = None
    for i, ch in enumerate(v):
        if quote:
            if ch == quote:
                quote = None
            out.append(ch)
            continue
        if ch in ('"', "'"):
            quote = ch
            out.append(ch)
            continue
        if ch == "#" and (i == 0 or v[i - 1].isspace()):
            break
        out.append(ch)
    s = "".join(out).strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        s = s[1:-1]
    return s.strip()


def _read_text(path: Path) -> Optional[str]:
    """读文件；失败返回 None（**永不抛**）。"""
    try:
        return path.read_text(encoding="utf-8-sig")
    except Exception:
        return None


def _resolve(path) -> Path:
    """相对路径按 SKILL_ROOT 解析（权威源在 skill 内），绝对路径原样使用。"""
    p = Path(str(path))
    if p.is_absolute():
        return p
    return (SKILL_ROOT / p).resolve()


def _missing(path: Path, errors: Optional[List[str]], what: str) -> None:
    """缺文件（或读失败）⇒ 打印**解析后的绝对路径** + 空表降级。"""
    msg = "[INFO] {what} 缺失或不可读：{path} ⇒ 按空表降级".format(
        what=what, path=str(path))
    print(msg, file=sys.stderr)
    if errors is not None:
        errors.append(msg)


def read_scalars(path) -> Dict[str, str]:
    """读「顶级键 + 二级标量」为**扁平点号键**。

    三级及以下**有意不解析**（与 project-config.mjs 同口径：消费面不到三级）。
    列表项（``- xxx``）忽略。

    :returns: ``{ 'vcs.type': 'svn', 'paths.docs_iterations': 'docs/iterations' }``
    """
    p = _resolve(path)
    text = _read_text(p)
    if text is None:
        _missing(p, None, "标量配置")
        return {}

    cfg: Dict[str, str] = {}
    section = None
    for line in text.replace("\r\n", "\n").split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _KEY_RE.match(line)
        if not m:
            continue
        indent, key, raw = len(m.group(1)), m.group(2), m.group(3)
        if indent == 0:
            value = _unquote(raw)
            if value == "":
                section = key          # 段头
            else:
                cfg[key] = value
                section = None
            continue
        if indent <= 2 and section:
            cfg["{0}.{1}".format(section, key)] = _unquote(raw)
    return cfg


def _section_items(path, section: str, errors: Optional[List[str]]):
    """产出 (section, 列表项文本) 序列；只取 ``section`` 段下的列表项。"""
    p = _resolve(path)
    text = _read_text(p)
    if text is None:
        _missing(p, errors, "段配置")
        return []
    items: List[str] = []
    current = None
    for line in text.replace("\r\n", "\n").split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _KEY_RE.match(line)
        if m and not _LIST_RE.match(line):
            indent = len(m.group(1))
            if indent == 0:
                current = m.group(2) if _unquote(m.group(3)) == "" else None
            continue
        lm = _LIST_RE.match(line)
        if lm and current == section:
            items.append(lm.group(1).strip())
    return items


def read_pairs(path, section: str, errors: Optional[List[str]] = None) -> List[Tuple[str, str]]:
    """读 ``- Key: 值`` 形态的段，返回 ``[(键, 值), ...]``。

    - 按**首个 ASCII 冒号**切分（中文冒号不切分 ⇒ 属值的一部分）。
    - 缺冒号或值为空 ⇒ 记入 ``errors``（若传入）并跳过该条（**不静默丢弃**）。
    """
    out: List[Tuple[str, str]] = []
    for item in _section_items(path, section, errors):
        if not item:
            continue
        idx = item.find(":")
        if idx < 0:
            msg = "[WARN] {0} 段条目缺 ASCII 冒号（跳过）：{1}".format(section, item[:60])
            print(msg, file=sys.stderr)
            if errors is not None:
                errors.append(msg)
            continue
        key = item[:idx].strip()
        value = _unquote(item[idx + 1:])
        if not key or not value:
            msg = "[WARN] {0} 段条目键/值为空（跳过）：{1}".format(section, item[:60])
            print(msg, file=sys.stderr)
            if errors is not None:
                errors.append(msg)
            continue
        out.append((key, value))
    return out


def read_bare(path, section: str, errors: Optional[List[str]] = None) -> List[str]:
    """读 ``- 裸串`` 形态的段，返回 ``[裸串, ...]``。

    - 空项忽略。
    - 含**首个 ASCII 冒号**时取冒号左侧（与 read_pairs 同切分口径）；
      中文冒号不切分（``病区：护士`` 是完整裸串）。
    """
    out: List[str] = []
    for item in _section_items(path, section, errors):
        if not item:
            continue
        idx = item.find(":")
        value = item[:idx].strip() if idx >= 0 else item.strip()
        if not value:
            continue
        out.append(value)
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    """调试入口：``python project_config.py <file>`` ⇒ 打印三段解析结果。"""
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("用法: python project_config.py <yaml 路径> [section]", file=sys.stderr)
        return 2
    p = _resolve(args[0])
    print("path: {0}".format(p))
    print("scalars: {0}".format(read_scalars(p)))
    for sec in (args[1:] or ["business", "tech", "noise", "path_prefixes", "bare_prefixes"]):
        print("{0}: pairs={1} bare={2}".format(
            sec, read_pairs(p, sec, []), read_bare(p, sec, [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
