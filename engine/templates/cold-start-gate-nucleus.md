<!-- NUCLEUS-BEGIN v1.9 -->
<!-- cold-start-gate-nucleus v1.9 · SSOT: engine/gate-protocol.md · 钩子失效时的 Prompt 层兜底
     v1.9：内联决策树 / 阻断模板 / 说明头已删（判据由 hooks/gate-check.mjs 硬编码，拦截消息自含引导）；
     保留四要素 = 判据 + 豁免 + 逃生口 + SSOT 指针。历史见仓库提交记录。 -->

## ★ 修改门禁（最高优先级）

写/删前读 `{{IDE_DIR}}/skills/iteration-workflow/runtime/ACTIVE` → `{ID}.state.yaml` 的 `current_phase`：
**仅 04 放行**（删除/移动类另需命中 `delete_allow`）；01-03 只许迭代目录 + `{{IDE_DIR}}/memory/`；其余一律拦。
豁免：`runtime/` · `{{IDE_DIR}}/memory/`（工作记忆写入/维护与迭代状态无关）。
逃生口：`GATE_BYPASS=1` 或 `{{IDE_DIR}}/hooks/.gate-bypass`（用完即删 + `gate-audit.log` 留痕）。
完整决策树与阻断话术见 `engine/gate-protocol.md`；hook 生效时为确定性硬拦（Write/Edit/Bash）。
<!-- NUCLEUS-END -->
