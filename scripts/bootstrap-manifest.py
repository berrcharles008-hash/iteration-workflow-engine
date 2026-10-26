#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bootstrap project.manifest.yaml before template injection (F1, 2026-10-26).

Why this exists
---------------
`install.ps1` / `install.sh` create `project/project.manifest.yaml` from
`project.manifest.yaml.template` on first install. In the template every
required key is empty, and the installer runs `inject-template.py` right after
that. The injector treats an empty string as a missing key on purpose
(2026-10-25 BLOCKER-1: refuse to write `specs_dir: /`), so a fresh clone could
never finish Step 6: it always exited 1 with

    ① 类占位符未解析（schema 要求解析，但 manifest 缺展平键 PATHS_SPECS_DIR）

This script fills **only** `paths.specs_dir`, and **only when it is empty**:

  * `SKILL.template.md` needs exactly two class-1 variables -- `{{SPECS_DIR}}`
    and `{{KB_DIR}}`; `kb_dir` already has a template default, `specs_dir`
    does not.  So `specs_dir` is the single blocker.
  * The default is derived from the detected IDE (`.codebuddy/specs`,
    `.claude/specs`, `.cursor/specs`, `.codex/specs`) instead of hard-coding
    one IDE's directory, matching the engine's existing `{{IDE_DIR}}` idea.
  * A concrete path is written (not a token): `paths.specs_dir` is machine
    consumed by `engine/gate/exempt-tables.mjs`, `scripts/audit-engine.py` and
    `scripts/gen-knowledge-base.py`; a `{{...}}` token there would silently
    shift the gate's md-only allow surface.
  * The edit is line-level: comments, key order and formatting are preserved.
  * Idempotent: a non-empty value is never touched (`kept`).

Exit codes: 0 = filled or already valid / 1 = refused (missing manifest, no
`paths:` block, no `specs_dir` key, or an explicitly empty `--specs-dir`).
Messages are ASCII on purpose: Windows PowerShell 5.1 decodes child-process
stdout as ANSI, so non-ASCII text from Python turns into mojibake in install
logs.
"""
from __future__ import annotations

import argparse
import io
import re
import sys
from pathlib import Path

IDE_SPECS_DEFAULT = {
    'codebuddy': '.codebuddy/specs',
    'claude-code': '.claude/specs',
    'cursor': '.cursor/specs',
    'codex': '.codex/specs',
}

SPECS_LINE_RE = re.compile(r'^(?P<indent>\s*)specs_dir:(?P<rest>.*)$')
TOP_LEVEL_RE = re.compile(r'^[A-Za-z_][\w-]*:')
PATHS_RE = re.compile(r'^paths:\s*(?:#.*)?$')


def split_comment(rest: str) -> tuple[str, str]:
    """Split a YAML scalar from its trailing comment, ignoring '#' inside quotes."""
    quote = None
    for i, ch in enumerate(rest):
        if ch in ('"', "'"):
            if quote == ch:
                quote = None
            elif quote is None:
                quote = ch
        elif ch == '#' and quote is None:
            return rest[:i], rest[i:]
    return rest, ''


def strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1].strip()
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description='Fill paths.specs_dir in project.manifest.yaml when it is empty.',
    )
    parser.add_argument('--manifest', required=True, help='path to project.manifest.yaml')
    parser.add_argument('--ide', required=True, choices=sorted(IDE_SPECS_DEFAULT),
                        help='detected IDE, used to derive the default specs dir')
    parser.add_argument('--specs-dir', default=None,
                        help='explicit override (wins over the derived default)')
    parser.add_argument('--dry-run', action='store_true', help='report the plan, write nothing')
    args = parser.parse_args(argv)

    path = Path(args.manifest)
    if not path.is_file():
        print('[ERROR] manifest not found: %s' % path)
        return 1

    if args.specs_dir is not None and not args.specs_dir.strip():
        # Never let an explicitly empty override slip through: it is the exact
        # state the injector refuses, so fail here with a clear message instead.
        print('[ERROR] --specs-dir is empty; refusing to write an empty paths.specs_dir')
        return 1

    raw = path.read_bytes()
    had_bom = raw.startswith(b'\xef\xbb\xbf')
    text = raw.decode('utf-8-sig')
    newline = '\r\n' if '\r\n' in text else '\n'
    lines = text.split(newline)

    paths_start = None
    for i, line in enumerate(lines):
        if PATHS_RE.match(line):
            paths_start = i
            break
    if paths_start is None:
        print('[ERROR] no top-level "paths:" block in %s' % path)
        return 1

    block_end = len(lines)
    for j in range(paths_start + 1, len(lines)):
        if TOP_LEVEL_RE.match(lines[j]):
            block_end = j
            break

    target = None
    for k in range(paths_start + 1, block_end):
        if SPECS_LINE_RE.match(lines[k]):
            target = k
            break
    if target is None:
        print('[ERROR] "paths.specs_dir" key not found in %s (template drift?)' % path)
        return 1

    m = SPECS_LINE_RE.match(lines[target])
    assert m is not None
    indent = m.group('indent')
    value_raw, comment = split_comment(m.group('rest'))
    current = strip_quotes(value_raw)

    if current:
        print('[OK] paths.specs_dir already set (%s) -- left untouched' % current)
        return 0

    value = (args.specs_dir or IDE_SPECS_DEFAULT[args.ide]).strip().rstrip('/')
    if not value:
        print('[ERROR] resolved specs_dir is empty; refusing to write')
        return 1

    # Keep the inline comment readable: the original template has padding spaces
    # before '#', but split_comment() cuts right at '#', so re-add one space.
    separator = ' ' if comment else ''
    new_line = '%sspecs_dir: "%s"%s%s' % (indent, value, separator, comment)
    if args.dry_run:
        print('[DRY] would set paths.specs_dir = %s' % value)
        return 0

    lines[target] = new_line
    out = newline.join(lines)
    payload = out.encode('utf-8')
    if had_bom:
        payload = b'\xef\xbb\xbf' + payload
    with io.open(path, 'wb') as fh:
        fh.write(payload)

    print('[OK] paths.specs_dir was empty -- filled with "%s" (derived from ide=%s)' % (value, args.ide))
    if not (Path.cwd() / value).is_dir():
        print('[NOTE] directory does not exist yet: %s -- create it or edit the manifest' % value)
    return 0


if __name__ == '__main__':
    sys.exit(main())
