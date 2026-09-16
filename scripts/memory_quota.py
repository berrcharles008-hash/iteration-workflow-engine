#!/usr/bin/env python3
"""MEMORY.md 注入配额自检（UTF-16 码元，含 CRLF）—— 常驻工具。

用法：
  python .codebuddy/skills/iteration-workflow/scripts/memory_quota.py [路径]

判据：IDE getWorkingMemoryContent() 以 JS String.length（UTF-16 码元）计，
      > 8000 时从头部截断 8000，**尾部丢失**。
注意：勿用 PowerShell `(Get-Content -Raw).Length` —— PS 5.1 对无 BOM UTF-8
      按 ANSI 解码，实测虚高 ~900（会误报 TRUNCATED）。
"""
import io
import sys

p = sys.argv[1] if len(sys.argv) > 1 else '.codebuddy/memory/MEMORY.md'
s = io.open(p, encoding='utf-8', newline='').read()
n = len(s.encode('utf-16-le')) // 2
LIM = 8000
print('file      :', p)
print('codeunits :', n, '/', LIM, ' margin:', LIM - n)
print('status    :', 'FULL' if n <= LIM else 'TRUNCATED (tail will be lost)')
sys.exit(0 if n <= LIM else 1)
