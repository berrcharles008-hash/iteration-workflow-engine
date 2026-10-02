<!-- NUCLEUS-BEGIN v1.15 -->
<!-- cold-start-gate-nucleus v1.15 · SSOT: engine/gate-protocol.md · 钩子失效时的 Prompt 层兜底
     v1.15（2026-10-02 · 方案 α）：01-03 补 `requirements/iteration-context/`（仅 .md，R-14）；04 补
       delete_allow 条目结构（裸路径不识别）与 Move/Copy 双端核；05 补「开闸就地修」（gate_window +
       fix_files 成对，校验 [R8]）；★ 引擎**不新增写放行面**。历史沿革见 git 记录（v1.14 GATE-5 外置项目记忆 /
       v1.13 Skill 自身可写 / v1.12 逃生口时效 / v1.11 模式库 / v1.10 阶段化豁免）。 -->

## ★ 修改门禁（最高优先级）

写/删前读 `{{IDE_DIR}}/skills/iteration-workflow/runtime/ACTIVE` → `{ID}.state.yaml` 的 `current_phase`：
**仅 04 全放行**（删除/移动类另需命中 `delete_allow`，写成 `- path: "<相对路径>"`；★ Move/Copy 同时核**目标**路径）；**01-03** 只许迭代目录 + `{{IDE_DIR}}/skills/iteration-workflow/`（Skill 自身）+ `docs/knowledge-base/`（FIX-23）+ `{{IDE_DIR}}/memory/` + `requirements/iteration-context/`（**仅 .md**，R-14）；
**05/06/07** 只许本职文档（05/07 = `docs/iterations/`；06 = `docs/iterations/` · `docs/knowledge-base/` ·
`requirements|feasibility` 的 `.md`；07 另加 `project/lessons-learned.md`）；其余一律拦（含所有 Bash 命令）。
★ **05 例外（开闸就地修）**：仅 **L1 且不涉后端码**的小修（`step-fix-05-*`，须用户开闸），`defects[].gate_window`
与 `fix_files` **必须成对**（校验 = `validate-state.py` **[R8]**）；涉后端码须回 04。
豁免：`runtime/` · `{{IDE_DIR}}/memory/` + 外置项目记忆 `~/{{IDE_DIR}}/projects/*/memory/`（**与迭代状态无关**）· 05/06/07 本职文档（上）。
逃生口：`GATE_BYPASS=1` 或 `{{IDE_DIR}}/hooks/.gate-bypass`（**用完即删** + `gate-audit.log` 留痕；
标记内可写 `ttlMinutes=N` / `expire=ISO` 自动失效，空标记=永久）；**收尾必检：标记已删**。
完整决策树与阻断话术见 `engine/gate-protocol.md`；hook 生效时为确定性硬拦（Write/Edit/Bash）。
<!-- NUCLEUS-END -->
