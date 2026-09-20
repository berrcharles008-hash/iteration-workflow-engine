# 阶段六：06-发布上线

**目标**：阶段1自动部署到开发测试服务器，阶段2手动发布到客户服务器。

> 详细部署步骤见 `project/deploy-config.yaml`。

### 阶段1：发布到开发测试服务器（Agent 自动执行）

按 `deploy-config.yaml` 中 `environments` 列表依次执行每个环境的 `steps`。

环境不满足时列出命令清单，提示用户在内网机器执行。

### 阶段2：发布到客户服务器（⚠️ 非 Skill 闭环，属外部约束）

> **非闭环说明**：客户服务器部署 / 运维动作受运维隔离现实约束，不在 Skill 流程闭环内，由运维手动执行。此非流程缺陷，不计入阶段完成度考核。
> 
> 06 阶段通过结构化部署清单（由 step-1.2 捕获备份基线 + step-1.5 生成执行清单）将客户部署的"准备"工作纳入 Skill 产出，但清单的实际执行仍属外部运维范畴。若 `stage2_manual.enabled==false`，相关步骤标记为 `not_applicable`，不产生噪声。

当 `stage2_manual.enabled==true` 时，Agent 按以下流程生成部署清单：
1. 从 step-1 构建输出捕获文件清单，生成 `backup_manifest.yaml`（备份基线）
2. 从 04-开发实现/04-任务清单.md 提取变更文件路径（fallback: git diff → 用户手动提供）
3. 结合部署模板填充上线记录"阶段2：客户服务器部署"章节
4. 回滚方案基于备份清单自动生成具体恢复命令（非泛化占位符）
5. 用户/运维按清单执行并反馈每步结果，Agent 写入上线记录

### Spec 活文档更新（★ 强制）

归档时更新 `{{SPECS_DIR}}/` 下的活文档：
- ADDED 条目 → 新增行
- MODIFIED 条目 → 更新行
- REMOVED 条目 → 移除行
- 更新每个 spec 文件头部的"最后更新"日期和迭代编号

### ★ step-2-5-kb-refresh：知识库刷新（✅ 强制，**无条件**）

> **决策（2026-09-20）**：刷新点由"04 末"改为**本步骤**，且**去掉原"若新增/删除模块或类"的前置条件**。
>
> **理由**：04 末代码未经 05 测试 ⇒ 刷出的是"未验证中间态"（详见 `phase-04.md` §知识库刷新：不在 04 阶段执行）。
> 06 位于 05 测试通过之后，代码即**最终态**；且 06 门禁已放行 `docs/knowledge-base/`（FIX-12②），无需开闸。

**执行时机**：step-2-spec-update（Spec 活文档回写）之后、**step-3-archive 之前**。

```bash
python scripts/gen-knowledge-base.py --check     # ① 先看陈旧范围（含内容指纹比对）
python scripts/gen-knowledge-base.py --force     # ② 无条件全量刷新
```

- **无条件执行**：不因"本迭代无模块/类增删"而跳过（`--force` 会重写 `generated_at`，使知识库始终标注最近一次刷新的时点）
- 仅覆盖 `auto-generated: true` 的文件；`auto-generated: false` 的人工编辑段（L2 业务语义 / L3 术语补充）不会被覆盖
- `--check` 若报"最新"仍须执行 `--force`（保证时间戳与最终态对齐）
- 门禁：06 阶段放行 `docs/knowledge-base/`；Bash 走命令风险分级（`python …` 按纯读放行，★ 2026-09-20 实测可执行）
  ⇒ 若被判危险命令而拦，按 `gate-protocol.md` 逃生口流程处理

### 对话摘要写入

将本次迭代摘要写入 `runtime/{ITERATION_ID}.state.yaml` 的 `last_session_summary` 字段（100~200字），内容包含：核心交付、主要问题及解法、关键技术决策。

### 迭代状态归档（step-3-archive）

1. 将 `runtime/{ITERATION_ID}.state.yaml` 的 `iteration_status` 设为 `"completed"`，`current_phase` 设为 `"07"`。
2. 将 `runtime/ACTIVE` Line 2 写为 `STATUS=completed PHASE=07`（**不修改** Line 1，保留迭代 ID）。

> ★ **ACTIVE 指针禁止释放**：06 归档时不得将 ACTIVE Line 1 写为 `"none"`。ACTIVE 释放在 07-迭代回顾 完成后执行。
> 
> 若 06 阶段提前释放 ACTIVE，07 阶段会被静默跳过（历史案例：迭代 025）。
> 
> ACTIVE 同步规则详见 `state-protocol.md` §6.2（第 531 行）。

> 💡 **恢复指引**：若 ACTIVE 已被误释放为 `"none"`，执行以下步骤恢复：
> 1. ACTIVE Line 1 写回迭代 ID（如 `"025"`）
> 2. ACTIVE Line 2 写回 `STATUS=completed PHASE=07`
> 3. state.yaml 确认 `iteration_status: completed` 且 `current_phase: "07"`
> 4. 恢复后继续执行 07-迭代回顾

**产出**：`06-发布上线/06-发布上线记录.md`（模板：`phase-06-发布上线记录.md`，🟢简单用 `phase-06-上线记录-lite.md`，优先级见启动协议 §模板解析优先级）

> **版式纪律**：产出文档须遵循 `engine/doc-style-guide.md`（结论摘要前置、命令与结果用代码块/列表，不塞表格）；生成后自检 `python scripts/doc_lint.py <文件>`（ERROR 必修）。

**交付标准**：阶段1部署完成，测试服务器验证通过，用户确认"上线完成"；**文档版式自检 ERROR 0**（`python scripts/doc_lint.py <文档>`）

### 步骤清单（进入阶段时写入 phase_steps）

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-1-deploy-stage1 | 发布到开发测试服务器 | ✅ | 始终 |
| step-2-spec-update | Spec活文档更新 | ✅ | 始终 |
| step-2-5-kb-refresh | 知识库刷新（无条件 `--force`，代码已为最终态） | ✅ | 始终 |
| step-3-archive | 迭代状态归档（推进到07） | ✅ | 始终 |
| step-4-archive-check | 归档检查：检查 `10-临时/` 是否清空，未清空则分类移出 | ✅ | 始终 |
| 3.5 | ★ 归档完成自检 | ✅ | step-3-archive 写入完成后立即执行，三项全通过 |

### ★ step-3.5 归档完成自检（强制）

> step-3-archive 写入完成后立即执行以下自检，全部通过才算 06 阶段完成。

| # | 检查项 | 验证方式 |
|---|--------|---------|
| 1 | `iteration_status` 已设为 `"completed"`？ | 读 state.yaml，确认 `iteration_status: completed` |
| 2 | `current_phase` 已设为 `"07"`？ | 读 state.yaml，确认 `current_phase: "07"` |
| 3 | ACTIVE 仍指向本迭代且状态正确？ | 读 ACTIVE，确认 Line 1 = 迭代 ID，Line 2 = `STATUS=completed PHASE=07` |

> 全部通过 → 06 阶段完成，推进到 07。
> 任一不通过 → 回退修复对应项，修复后重新自检，不得跳过。
> 若 ACTIVE Line 1 已误写为 `"none"` → 按上方「恢复指引」恢复后再推进。
