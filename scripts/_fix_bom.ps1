$utf8bom = New-Object System.Text.UTF8Encoding($true)
# ★ 2026-10-28：**只对 .ps1 加 BOM**，不再包含 install.sh。
#   动因：BOM 是给 Windows PowerShell 5.1 读中文用的（无 BOM 时按系统代码页解码 ⇒ 乱码）；
#   POSIX shell 不需要，且会把它当命令 → 每次执行都先报一行
#   `scripts/install.sh: line 1: ﻿#!/bin/bash: not found`（`set -e` 尚未生效故不中断，
#   但 `./install.sh` 直跑与日志判读都被污染）。原列表两文件同处理属于误伤。
$files = @(
    "$PSScriptRoot\install.ps1"
)
foreach ($f in $files) {
    if (Test-Path $f) {
        $content = Get-Content $f -Raw -Encoding UTF8
        [System.IO.File]::WriteAllText($f, $content, $utf8bom)
        Write-Host "BOM added: $f"
    } else {
        Write-Host "NOT FOUND: $f"
    }
}
