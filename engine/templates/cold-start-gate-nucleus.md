<!-- NUCLEUS-BEGIN v1.8 -->
<!-- cold-start-gate-nucleus v1.8 · 规则源 gate-protocol.md · 注入 setup-gate.py --ide {codebuddy|claude-code|cursor}
     v1.8 要点：`{IDE}/memory/` 工作记忆写入/维护**与迭代状态无关**（含 ACTIVE=none 一律放行，FIX-11）；
     v1.7 要点：04 阶段写入放行；删除/移动类走「清单锚定」（仅 state.yaml 的 delete_allow + 工程豁免）；拦截/放行均留痕 gate-audit.log；
     hook 实测硬拦（本微核仅兜底 hook 不可用环境）；阶段判据以 state.yaml 为准；改本模板前先查 gate-protocol.md；历史见仓库提交记录。 -->

## ★ 修改门禁铁律（最高优先级）

> P-042：门禁规则绝不内联完整决策树（Agent 会"理解意图"后自行绕过）。
> P-043：委托链（MEMORY.md→SKILL.md→gate-protocol.md）在 Skill 未加载时断裂 ⇒ 冷启动须有微核。

**定位**：支持 PreToolUse 的宿主（CodeBuddy IDE / Claude Code CLI）由 `{{IDE_DIR}}/hooks/gate-check.mjs`
**确定性硬拦**（2026-09-14 实测：写入非豁免路径被拒绝，退出码 2）。本微核仅覆盖 **hook 不可用**的环境
（其他 IDE / `settings.json` 缺失 / 新 clone / hook 未注册）。

### 层 1：冷启动检查（write / replace / delete 前强制执行）

1. 读 `{{IDE_DIR}}/skills/iteration-workflow/runtime/ACTIVE`，第 1 行 = 迭代 ID
2. ★ 阶段以 `runtime/{ID}.state.yaml` 的 `current_phase` 为准 —— `ACTIVE` 的 `PHASE` 字段可能陈旧，**勿单独采信**
3. ★ 删除/移动类操作（Delete 工具 / Bash 删除段）额外读 `state.yaml` 的 `delete_allow`；豁免 `runtime/`、`{IDE}/temp`+`{IDE}/memory/`、`node_modules/`、`dist/`、`obj/`、`bin/`、`*.bak*` 等

| 条件 | 动作 |
|------|------|
| 无活跃迭代 / 格式异常 | 🔴 阻断，等用户回复（**例外**：`{IDE}/memory/` 工作记忆写入/维护一律放行） |
| `current_phase = 04` | 🟡 写入放行；**删除/移动类**须在 `state.yaml` 的 `delete_allow`（＝任务清单 DELETED/ADDED 项）内，否则硬拦 |
| `current_phase` ∈ 01/02/03 | 🟡 仅放行 `{IDE}/skills/iteration-workflow/`、`docs/iterations/`、`{IDE}/memory/`、`runtime/`；越界即阻断 |
| 其他（00/05/06/07） | 🔴 阻断 |

**阻断输出要点**（原样告知用户；不得省略、不得替用户回答、不得跳过等待）：
- 无活跃迭代 → 所有代码修改必须经过迭代工作流；请选择 1️⃣ 新建迭代（推荐）2️⃣ 并入已有迭代
- 04 阶段删除被拦 → `迭代：{ID} 阶段：04`；目标 `{path}` 未在 `delete_allow` 登记 ⇒ 1️⃣ 清单增补 DELETED 项后登记（需你确认）2️⃣ 走逃生口（留痕）
- 非 04 → `迭代：{ID} 当前阶段：{PHASE}`；代码修改仅在 04-开发实现 阶段允许；1️⃣ 推进到 04 2️⃣ 独立新建迭代
- 末尾一律附：**等待用户回复。Agent 不得自行判断或跳过。**

### 层 2：完整门禁（Skill 加载后生效）

以 `{{IDE_DIR}}/skills/iteration-workflow/engine/gate-protocol.md` 决策树为准，层 1 退化为不执行。

### 逃生口

`GATE_BYPASS=1` 环境变量 或 `{{IDE_DIR}}/hooks/.gate-bypass` 标记文件（用完即删，`auditBypass()` 留痕）。

<!-- NUCLEUS-END -->
