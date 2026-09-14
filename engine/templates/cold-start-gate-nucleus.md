<!-- NUCLEUS-BEGIN v1.5 -->
<!-- cold-start-gate-nucleus v1.5 · 规则源 gate-protocol.md · 注入 setup-gate.py --ide {codebuddy|claude-code|cursor}
     v1.5 (2026-09-14): ① 修正 hook 表述 —— PreToolUse 在 CodeBuddy IDE 实测硬拦生效（FIX-5），
                        微核定位由"唯一防线"改为"hook 不可用时的兜底"；
                        ② 阶段判据改为以 state.yaml 为准（ACTIVE 的 PHASE 字段可能陈旧，见 FIX-6）；
                        ③ 移除三个 ASCII 阻断模板，改要点式，模板 94 → 45 行。
     v1.4 (2026-09-14): 新增 NUCLEUS-BEGIN / NUCLEUS-END 显式边界（修 --force 叠加，FIX-4）。
     v1.3 (2026-09-14): 修 ide_dir 前导双点 Bug（曾影响 codebuddy / claude-code / cursor 三个 IDE）。
     v1.2 及更早：变更历史见仓库提交记录。
     用途：注入目标 IDE 的 MEMORY.md / CLAUDE.md / .cursorrules，提供冷启动门禁兜底。 -->
<!-- 当 gate-protocol.md 门禁规则更新时，请同步检查本模板 -->

## ★ 修改门禁铁律（最高优先级）

> P-042：门禁规则绝不内联完整决策树（Agent 会"理解意图"后自行绕过）。
> P-043：委托链（MEMORY.md→SKILL.md→gate-protocol.md）在 Skill 未加载时断裂 ⇒ 冷启动须有微核。

**定位**：支持 PreToolUse 的宿主（CodeBuddy IDE / Claude Code CLI）由 `{{IDE_DIR}}/hooks/gate-check.mjs`
**确定性硬拦**（2026-09-14 实测：写入非豁免路径被拒绝，退出码 2）。本微核仅覆盖 **hook 不可用**的环境
（其他 IDE / `settings.json` 缺失 / 新 clone / hook 未注册）。

### 层 1：冷启动检查（write / replace / delete 前强制执行）

1. 读 `{{IDE_DIR}}/skills/iteration-workflow/runtime/ACTIVE`，第 1 行 = 迭代 ID
2. ★ 阶段以 `runtime/{ID}.state.yaml` 的 `current_phase` 为准 —— `ACTIVE` 的 `PHASE` 字段可能陈旧，**勿单独采信**

| 条件 | 动作 |
|------|------|
| 无活跃迭代 / 格式异常 | 🔴 阻断，等用户回复 |
| `current_phase = 04` | 🔴 阻断，先请用户确认"本次修改属于当前迭代任务清单内" |
| `current_phase` ∈ 01/02/03 | 🟡 仅放行 `{IDE}/skills/iteration-workflow/`、`docs/iterations/`、`{IDE}/memory/`、`runtime/`；越界即阻断 |
| 其他（00/05/06/07） | 🔴 阻断 |

**阻断输出要点**（原样告知用户；不得省略、不得替用户回答、不得跳过等待）：
- 无活跃迭代 → 所有代码修改必须经过迭代工作流；请选择 1️⃣ 新建迭代（推荐）2️⃣ 并入已有迭代
- 04 阶段 → `迭代：{ID} 阶段：04`；请确认本次修改是否属于当前迭代任务清单内
- 非 04 → `迭代：{ID} 当前阶段：{PHASE}`；代码修改仅在 04-开发实现 阶段允许；1️⃣ 推进到 04 2️⃣ 独立新建迭代
- 末尾一律附：**等待用户回复。Agent 不得自行判断或跳过。**

### 层 2：完整门禁（Skill 加载后生效）

以 `{{IDE_DIR}}/skills/iteration-workflow/engine/gate-protocol.md` 决策树为准，层 1 退化为不执行。

### 逃生口

`GATE_BYPASS=1` 环境变量 或 `{{IDE_DIR}}/hooks/.gate-bypass` 标记文件（用完即删，`auditBypass()` 留痕）。

<!-- NUCLEUS-END -->
