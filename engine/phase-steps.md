# 七阶段步骤清单（集中维护）

> 从 `workflow-engine.md` 提取。本文件是所有阶段步骤清单的**唯一真相源（Single Source of Truth）**。
> 进入阶段时 Agent 从本文件提取对应阶段的步骤，写入 `state.yaml` 的 `phase_steps`。
> 回退阶段时从本文件获取默认步骤清单（见 [state-protocol.md](state-protocol.md) §5.2）。

---

## 阶段一：01-需求分析与设计

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-0-init-state | 创建 state.yaml + 写入 ACTIVE | ✅ | 新迭代（首次进入 01） |
| step-1-read-specs | 读取Spec活文档获取项目上下文 | ✅ | 始终 |
| step-2-classify | 判断需求类型（Bug类/功能类），选择对应模板 | ✅ | 始终 |
| step-3-output | 生成01-需求记录.md | ✅ | 始终 |
| step-4-user-confirm | 用户确认需求文档 | ✅ | 始终 |

### step-0-init-state 详细说明

> **根因修复**：此前协议 `state-protocol.md` §二规定了"新建迭代必须创建 state.yaml + ACTIVE"，但执行流程文件中未将其列为阶段步骤，导致 Agent 遗漏。
> 
> 执行要求：
> 1. 创建 `runtime/{ITERATION_ID}.state.yaml`，写入 `iteration_id`、`iteration_status: "in_progress"`、`current_phase: "01"`、`phase_status: "in_progress"`、初始 `phase_steps`、`phase_history`、`blockers: []`
> 2. 写入 `runtime/ACTIVE` → `{ITERATION_ID}`
> 3. 创建 `docs/iterations/{ITERATION_ID}/` 目录结构（01-07 子目录）
> 4. 更新 `docs/iterations/README.md` 迭代清单

---

## 阶段二：02-需求评审

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-1-review | Agent以reviewer视角审阅，提出问题 | ✅ | 始终 |
| step-1x-review | 外部模型审查（优先）+ 降级Agent审查 | 🔴 | 🔴（强制）🟡（可选）🟢（跳过） |
| step-2-user-resolve | 用户逐项确认或驳回问题 | ✅ | 始终 |
| step-3-output | 生成02-需求评审.md | ✅ | 始终 |
| step-4-review-gate | 写入评审门禁结果到 state.yaml | ✅ | 始终 |
| step-5-user-confirm | 用户确认"评审通过" | ✅ | 始终 |

**step-4-review-gate 执行要求**：
- 读取 `02-需求评审/02-需求评审.md` 的结论复选框
- 映射到 `review_gate.result`：
  - "通过（无修改意见）" → `"passed"`
  - "通过（有修改意见，已记录）" → `"conditionally_passed"`
  - "不通过，需重新设计" → `"rejected"` + `rejection_reason`
- 写入当前迭代 `phase_history` 中 phase "02" 条目的 `review_gate` 字段

---

## 阶段三：03-技术方案

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-1-explore | 代码探索 | — | 按需 |
| step-2-output | 产出技术方案文档 | ✅ | 始终 |
| step-3-self-review | 自主审查L1/L2（关键符号验证） | ✅ | 始终 |
| step-3x-cross-review | 独立Agent交叉审查L1/L2 | ✅ | 🟡🔴 |
| step-4-review-gate | 评审边界与通过标准检查（4项） | ✅ | 始终 |
| step-5-fix-verify | 修复验证（3项） | ✅ | 审查发现问题后 |
| step-5-review-gate-result | 写入评审门禁结果到 state.yaml | ✅ | 始终 |
| step-6-user-confirm | 用户确认方案通过 | ✅ | 始终 |

**step-5-review-gate-result 执行要求**：
- 在 step-5-fix-verify 完成后（或跳过时）、step-6-user-confirm 之前执行
- 读取 03 方案评审结论（4 项检查 + 自主审查）
- 映射到 `review_gate.result`：
  - 4 项检查全部通过 → `"passed"`
  - 任一检查发现致命问题 → `"rejected"` + `rejection_reason`
- 写入当前迭代 `phase_history` 中 phase "03" 条目的 `review_gate` 字段

---

## 阶段四：04-开发实现

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-0-sql-gen | 数据库脚本生成 | ✅ | 03-技术方案中有 DDL/DML 变更 |
| step-0-sql-review | 脚本审查 | ✅ | step-0-sql-gen 完成 |
| step-0-sql-exec | 脚本执行 | ✅ | step-0-sql-review 通过 |
| step-1-task-list | 任务清单生成 | ✅ | 始终 |
| step-1-5-review | 任务清单审查（自审） | ✅ | 始终 |
| step-1-5x-cross-review | 独立Agent交叉审查任务清单 | ✅ | 🟡🔴 |
| step-1-6-user-confirm | 用户确认任务清单通过 | ✅ | 始终 |
| step-3-team-code | Team 编码 | — | step-1-6-user-confirm 完成 |
| step-4-csproj | csproj 注册 | ✅ | 有新增/删除 C# 文件 |
| step-5-build | 编译验证 | ✅ | 有 C# 变更 |
| step-6-spec | Spec 合规验证 | ✅ | 🔴复杂级 + 有 ADDED 文件 |
| step-7-code-review | 代码审查 | ✅ | 始终 |

> 进入阶段时，Agent 根据实际触发条件选择性写入 phase_steps（如无 SQL 变更则 step-0-* 设为 `not_applicable`）。

---

## 阶段五：05-测试验证

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-0-frontend-build | 前端构建验证 | ✅ | 涉前端变更 |
| step-1-generate-cases | 自动生成测试用例 | ✅ | 始终 |
| step-2-user-review | 用户审核用例 | — | 可选 |
| step-3-execute | 自动执行【自动】用例 | ✅ | 始终 |
| step-4-output | 生成测试报告 | ✅ | 始终 |

---

## 阶段六：06-发布上线

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-1-deploy-stage1 | 发布到开发测试服务器 | ✅ | 始终 |
| step-2-spec-update | Spec活文档更新 | ✅ | 始终 |
| step-3-archive | 迭代状态归档（推进到07） | ✅ | 始终 |
| step-4-archive-check | 归档检查：检查 `10-临时/` 是否清空，未清空则分类移出 | ✅ | 始终 |

---

## 阶段七：07-迭代回顾

| 步骤ID | 步骤名称 | 强制 | 🟢 | 🟡 | 🔴 |
|--------|---------|:--:|:--:|:--:|:--:|
| step-1-summary | 迭代总结（做了什么/做对了什么/可改进什么） | ✅ | 精简 | 标准 | 完整 |
| step-2-issues | 问题清单（本次迭代遇到的问题） | ✅ | 精简 | 标准 | 完整 |
| step-3-patterns | 模式沉淀（写入 lessons-learned 模式库） | — | 跳过 | 按需 | ✅ |
| step-4-actions | 行动项（改进措施落实到人） | — | 跳过 | ✅ | ✅ |
| step-5-lessons | 正向模式提炼 | ✅ | ✅ | ✅ | ✅ |
| step-6-archive | 回顾归档（更新 state.yaml 完成 07，释放 ACTIVE） | ✅ | ✅ | ✅ | ✅ |

---
## 步骤编号约定

使用了 `step-Xx-` 字母后缀编号策略，`x` 表示交叉审查（cross-review）：

| 编号 | 含义 |
|------|------|
| `step-1x` | 与 02 阶段 step-1（Agent 自审）并行 |
| `step-3x` | 与 03 阶段 step-3（自审）并行 |
| `step-1-5x` | 与 04 阶段 step-1-5（任务清单自审）并行 |

详细行为定义见 [cross-review-protocol.md](cross-review-protocol.md)。

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-07-08 | 1.0 | 从 workflow-engine.md 提取，成为步骤清单唯一真相源（对应迭代 012 P2-6） |
| 2026-07-12 | 1.1 | 新增 step-1x-pre-review（02可选）/ step-3x-cross-review（03强制🟡🔴）/ step-1-5x-cross-review（04强制🟡🔴），支持独立Agent交叉审查协议。详细行为定义见 `engine/cross-review-protocol.md` |
| 2026-07-18 | 1.2 | 02 阶段 step-1x-review 升级：🔴 复杂级强制（外部模型优先），🟡 可选。`step-1x-cross-review` 更名为 `step-1x-review` 以反映外部模型路由优先级 |
| 2026-07-19 | 1.3 | 补充步骤编号约定文档；合并项目侧补充步骤到各阶段表格 |
