#!/usr/bin/env python3
"""MEMORY.md 注入配额自检（UTF-16 码元，含 CRLF）—— 常驻工具。

用法：
  python .codebuddy/skills/iteration-workflow/scripts/memory_quota.py [路径]

判据：IDE getWorkingMemoryContent() 以 JS String.length（UTF-16 码元）计，
      > 8000 时从头部截断 8000，**尾部丢失**。
退出码（★ GAP-4/加固②，2026-09-16）：
      0 = 健康（余量 >= 10%）
      2 = WARN（余量 < 10%，建议安排瘦身）
      1 = TRUNCATED（已超限，尾部必丢）
      install.ps1 的 Step 7b 依赖该分级做安装期自检。
注意：勿用 PowerShell `(Get-Content -Raw).Length` —— PS 5.1 对无 BOM UTF-8
      按 ANSI 解码，实测虚高 ~900（会误报 TRUNCATED）。
"""
import io
import sys

LIM = 8000
WARN_LIM = int(LIM * 0.9)          # 7200 = 余量 10%

p = sys.argv[1] if len(sys.argv) > 1 else '.codebuddy/memory/MEMORY.md'
s = io.open(p, encoding='utf-8', newline='').read()
n = len(s.encode('utf-16-le')) // 2

if n > LIM:
    status, code = 'TRUNCATED (tail will be lost)', 1
elif n > WARN_LIM:
    status, code = 'WARN (margin < 10%, plan a slimming pass)', 2
else:
    status, code = 'FULL', 0

print('file      :', p)
print('codeunits :', n, '/', LIM, ' margin:', LIM - n)
print('status    :', status)
sys.exit(code)
