#!/bin/bash
# ============================================================
# install.sh — iteration-workflow 引擎安装脚本 (Bash)
# ============================================================
#
# ★ Phase A 占位 — 完整逻辑将在 Phase C 实现
#
# 目标：自动检测 IDE 环境，安装引擎 + 领域插件 + Hook 门禁
# 支持 IDE：Claude Code / CodeBuddy / Cursor / Codex / Generic
#
# 完整方案参见：031-开源化方案评审调整/03-技术方案.md §1.2
# 核心逻辑：
#   1. detect_ide（优先级: --ide > .claude > .codebuddy > .cursor > .codex > generic）
#   2. 复制 engine/project/domain-plugins/scripts 到目标
#   3. 安装 IDE 专属 adapter（manifest + hooks）
#   4. Hook 路径替换（sed 动态适配）
#   5. 模板注入（inject-template.py）
#   6. 冷启动微核（setup-gate.py，仅 CodeBuddy）
#   7. 门禁自检（run-gate-tests.mjs --quick）
#
# ============================================================

set -e

echo "========================================"
echo " iteration-workflow engine installer"
echo "========================================"
echo ""
echo "⚠️  install.sh 当前为占位版本。"
echo "    完整安装逻辑将在 Phase C 实现。"
echo "    方案详见：031-开源化方案评审调整/03-技术方案.md §1.2"
echo ""
echo "现阶段请参考 adapters/generic/README.md 手动安装。"
echo ""

exit 0
