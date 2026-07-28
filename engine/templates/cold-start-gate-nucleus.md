<!--
  cold-start-gate-nucleus v1.1
  Source: gate-protocol.md 2026-07-27
  用途：注入到 .codebuddy/memory/MEMORY.md，为 CodeBuddy IDE 提供冷启动门禁保护
  目标环境：仅 CodeBuddy IDE（Claude Code CLI 由 Hook 层保护，不需要此文件）
  注入方式：setup-gate.py 或 startup-protocol.md Step A.5 用户确认后写入
-->
<!-- 当 gate-protocol.md 门禁规则更新时，请同步检查本模板是否需要更新 -->

## ★ 修改门禁铁律（最高优先级）

> P-042 教训：门禁规则绝不能内联完整决策树（Agent "理解意图"后自行绕过）。
> P-043 教训：委托链（MEMORY.md→SKILL.md→gate-protocol.md）在 Skill 未加载时断裂。
> 本段采用双层架构：层1微核（冷启动可用）→ 层2完整门禁（Skill 加载后）。

### 层 1：冷启动门禁微核（每次文件修改前强制执行）

在 write_to_file / replace_in_file / delete_file 之前，必须先执行：

1. 读取 `.codebuddy/skills/iteration-workflow/runtime/ACTIVE`（1 个文件，~2 行）
2. 解析 Line 2 的 `STATUS` 和 `PHASE`（格式：`STATUS=xxx PHASE=xx`）

| 条件 | 动作 |
|------|------|
| STATUS=active + PHASE=04 | 🔴 输出阻断模板，**等用户回复后**执行 |
| STATUS=active + PHASE≠04 | 🟡 输出警告模板，告知"不在开发阶段（{PHASE}）"，**等用户回复后**执行 |
| STATUS=none / 不存在 / 异常格式 | 🔴 输出阻断模板，**等用户回复后**执行 |

**阻断模板 — 无活跃迭代**（STATUS=none / 不存在时）：
```
╔══════════════════════════════════════════════════╗
║  🛑 修改门禁：当前无活跃迭代                    ║
║                                                  ║
║  所有代码修改必须经过迭代工作流。                ║
║  请选择：                                        ║
║  1️⃣ 为此需求创建新迭代（推荐）                   ║
║  2️⃣ 将需求并入当前某个已有迭代                   ║
║                                                  ║
║  等待用户回复。Agent 不得自行判断或跳过。         ║
╚══════════════════════════════════════════════════╝
```

**阻断模板 — 活跃迭代开发阶段**（PHASE=04 时）：
```
╔══════════════════════════════════════════════════╗
║  🛑 修改门禁：活跃迭代处于开发阶段              ║
║                                                  ║
║  迭代：{迭代ID}  阶段：{PHASE}                   ║
║  当前处于 04-开发实现 阶段。                     ║
║  请确认本次修改是否属于当前迭代任务清单内。       ║
║                                                  ║
║  等待用户回复。Agent 不得自行判断、               ║
║  不得替用户回答、不得跳过等待直接执行修改。       ║
╚══════════════════════════════════════════════════╝
```

**警告模板**（PHASE≠04 时）：
```
╔══════════════════════════════════════════════════╗
║  ⚠️  修改门禁：当前不处于开发阶段               ║
║                                                  ║
║  迭代：{迭代ID}  当前阶段：{PHASE}               ║
║  代码修改仅在 04-开发实现 阶段允许。             ║
║  请选择：                                        ║
║  1️⃣ 推进当前迭代到 04 阶段                       ║
║  2️⃣ 将本修改作为独立需求新建迭代                 ║
║                                                  ║
║  等待用户回复。Agent 不得自行判断或跳过。         ║
╚══════════════════════════════════════════════════╝
```

### 层 2：完整门禁（Skill 加载后生效）

若 `iteration-workflow` Skill 已被加载，以
`.codebuddy/skills/iteration-workflow/engine/gate-protocol.md`
完整决策树为准，层 1 微核退化为不执行。

**注意**：`.claude/settings.json` 的 PreToolUse Hook 仅在 Claude Code CLI 中生效。
CodeBuddy IDE 不支持 PreToolUse Hook。

### 逃生口

`GATE_BYPASS=1` 环境变量 或 `.codebuddy/hooks/.gate-bypass` 标记文件。
