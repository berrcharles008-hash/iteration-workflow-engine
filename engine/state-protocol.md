# 迭代状态文件协议

> 解决问题：对话重启后 Agent 不知道当前进度，需用户重新说明。
> 核心机制：每次任务完成/阶段推进后，将状态写入 `runtime/` 目录的 YAML 文件；新对话启动时优先读取该文件恢复上下文。

---

## 一、文件位置与命名

```
runtime/{ITERATION_ID}.state.yaml
```

示例：`runtime/2026-06-12-001-体征设备采集映射配置改造.state.yaml`

ITERATION_ID 格式：`YYYY-MM-DD-NNN-中文简述`（与 docs/iterations/ 目录名一致）

---

## 二、写入时机（强制）

| 事件 | 动作 | ACTIVE 同步 | Line 2 同步 |
|------|------|:--:|:--:|
| 新建迭代（01 阶段启动） | 创建文件，写入初始状态（`iteration_status: "in_progress"`, phase: "01", status: "in_progress"），**写入 `started_at`（立项时刻，`YYYY-MM-DDTHH:MM` 本地时）**【METRICS-AUTO 2026-09-25；★START-PRECISE 2026-10-01 起要求精确到分 —— 同日多迭代（同日第二个及以后）**必须**写时分，否则度量侧按「同日起点不可分」把轮数并入同日先者】，初始化当前阶段的 `phase_steps` | 写入迭代ID | STATUS+PHASE+TASKS+BLOCKERS |
| 每个阶段完成 | 更新 `current_phase` 和 `phase_status`，初始化新阶段的 `phase_steps`，**追加 `phase_history` 条目：`completed_at` 必须 ISO 带时分（`YYYY-MM-DDTHH:mm` 本地时，允许尾随秒/时区后缀）【PHASE-METRICS 2026-09-25】；跳过的阶段写 `skipped: true` + `skipped_at`（同格式）** | — | PHASE |
| 每个步骤完成（所有阶段） | 更新 `phase_steps.{step-id}.status` 为 `completed` | — | — |
| 步骤被跳过 | 更新 `phase_steps.{step-id}.status` 为 `skipped` + 写入 `skip_reason` | — | — |
| 每个任务完成（04 阶段） | `tasks_completed + 1`，从 `tasks_pending` 移除对应任务 | — | TASKS |
| 多 Story：某 Story 步骤完成（04 阶段） | 更新 `stories[{id}].dev_steps[{step}].status` 为 `completed` | — | — |
| 多 Story：某 Story 任务完成（04 阶段） | 更新 `stories[{id}].tasks_completed + 1`，从 `tasks_pending` 移除 | — | TASKS（Σ 聚合） |
| 多 Story：某 Story 全部完成 | `stories[{id}].status` 设为 `"completed"`，写入 `completed_at` | — | — |
| 多 Story：某 Story 废弃 | `stories[{id}].status` 设为 `"abandoned"`，自动跳过其剩余 `dev_steps`/`tasks` | — | — |
| 对话结束前（用户发出"结束/下次继续"等信号） | 更新 `last_updated` 时间戳 + 写入 `last_session_summary` | — | — |
| 06 阶段归档完成 | 将 `iteration_status` 设为 `"completed"`，`current_phase` 推进到 `"07"`，**写入 `ended_at`（当日日期）**【METRICS-AUTO 2026-09-25】，写入 `last_session_summary` | —（不释放） | STATUS+PHASE |
| 07 阶段回顾归档完成 | `phase_status` 设为 `"completed"`，保持 `iteration_status: "completed"` | 写入 `"none"` | STATUS=none |
| 强制跳过（paused） | `phase_status` 设为 `"paused"`，写入 `pause_reason` | 写入 `"none"` | STATUS=none |
| 迭代废弃/取消 | `iteration_status` 设为 `"abandoned"`，写入 `abandon_reason` 和 `abandoned_at` + `last_session_summary`，**补写 `ended_at` = `abandoned_at` 日期**【METRICS-AUTO 2026-09-25】；`phase_steps` 中所有 `pending` 强制步骤 → `skipped` + `skip_reason: "迭代废弃"`；`tasks_pending` 保留并标注 `tasks_status: "abandoned"`；`phase_status` 保持原值不动 | ACTIVE 写入 `"none"` | STATUS=none |
| 重新打开已完成迭代（回退到 04） | ★ 完整回退协议（见下方 §二-A） | 写入迭代ID | STATUS+PHASE+TASKS+BLOCKERS |
| 出现阻塞（编译失败/审查不通过） | 向 `blockers` 追加条目 | — | BLOCKERS |
| 阻塞解除 | 从 `blockers` 移除对应条目 | — | BLOCKERS |
| 缺陷登记（05 阶段分诊 / 修复窗口开启） | 向 `defects` 追加条目（`status: "open"` + `root_cause_level` + `design_changed`） | —（★ 不进 Line 2，理由见 §三 defects 注） | — |
| 缺陷关闭（回归通过） | `defects[].status` 置 `"fixed"`，写入 `fixed_at` + `verified_by` | — | — |

> **多 Story 并行 · 04 阶段完成聚合公式（★ 写入时机补充）**：当 state.yaml 含 `stories` 数组且 `current_phase == "04"` 时，04 阶段完成的判定为——**Sprint 级 `phase_steps` 全部结清 AND 所有 `stories[].status ∈ {completed, abandoned}`**。被 `abandoned` 的 Story 不阻塞 Sprint 推进，但其剩余 `dev_steps`/`tasks` 自动视为跳过。

> **注意**：`step-0-init-state` 已纳入 `phase-steps.md` §阶段一和 `workflow-engine.md` §阶段一前置步骤，Agent 进入 01 阶段时自动执行，不可跳过。

---

### ★ 二-A：重新打开已完成迭代的完整操作协议（强制）

> **触发条件**：用户要求重新打开已归档的迭代（通常回退到 04 阶段修复遗留 Bug）。
> **根因**：此前协议 §二第 33 行描述过于简略（只写了 2 件事），Agent 执行时遗漏 phase_steps 重置、tasks 清零、rollback_checks 等关键步骤，导致 ACTIVE 指针与 state.yaml 状态不一致。
> **修复**：以下协议是**原子操作清单**，必须按顺序全部执行，缺一不可。

**★ abandoned 禁止重新打开（硬约束）**：

> `iteration_status == "abandoned"` 的迭代不可恢复。废弃原因见 `abandon_reason` 字段。若需重启此需求，请创建新迭代。

```
若 state.iteration_status == "abandoned" → 🛑 BLOCK：
    ╔══════════════════════════════════════════════════╗
    ║  🛑 该迭代已标记为废弃，不可重新打开            ║
    ║                                                  ║
    ║  废弃原因：{abandon_reason}                      ║
    ║  废弃时间：{abandoned_at}                        ║
    ║                                                  ║
    ║  如需重启此需求，请创建新迭代。                  ║
    ╚══════════════════════════════════════════════════╝
```

**操作步骤（按顺序执行，全部完成才算重新打开成功）：**

```
Step 1: 更新 iteration_status → "in_progress"
Step 2: 更新 current_phase → "04"
Step 3: 更新 phase_status → "in_progress"
Step 4: 更新 last_session_summary（描述重新打开原因和待办）
Step 5: 重置 phase_steps
        5a. 从 phase-steps.md 获取 04 阶段默认步骤清单
        5b. 无 SQL 变更 → step-0-sql-gen/review/exec 设为 "not_applicable"
        5c. 无新增 C# 文件 → step-4-csproj 设为 "not_applicable"
        5d. 🟢 简单需求 → step-6-spec 设为 "not_applicable"
        5e. 其余强制步骤设为 "pending"
Step 6: 重置任务进度 → tasks_total: 0, tasks_completed: 0, tasks_pending: []
Step 7: 更新 phase_history
        7a. 保留所有历史条目
        7b. 04~07 阶段的 status 改为 "completed_then_rolled_back"
Step 8: 写入 rollback_checks
        8a. rollback_from: "07"（或当前实际阶段）
        8b. rollback_to: "04"
        8c. rollback_reason: 用户给出的重新打开原因
        8d. rollback_at: 当前 ISO 时间戳
        8e. consistency_checks: 检查 01~06 各阶段文档是否需要更新
Step 9: 写入 ACTIVE 文件 → echo "{ITERATION_ID}" > runtime/ACTIVE
Step 10: 写入后自检（§三.3 校验规则）
        10a. 必填字段存在性
        10b. 枚举值合法性（iteration_status 必须是 "in_progress" / "completed" / "abandoned"；abandoned 不可 reopen 见 §二-A guard）
        10c. phase_steps 完整性（04 阶段所有步骤都有）
        10d. ACTIVE 与 state.yaml iteration_id 一致
```

**自检失败处理**：任一校验失败 → 回退到写入前内容 → 报告错误 → 修正后重试。

**⚠️ 禁止行为**：
- 禁止只更新 iteration_status + current_phase 就停止（这是 P-017 同类事故）
- 禁止跳过 phase_steps 重置（会导致门禁认为所有步骤已完成）
- 禁止跳过 rollback_checks 记录（违反 §三.2 阶段回退检查协议）

---

## 三、文件格式

```yaml
# 迭代状态文件 — 由 Agent 自动维护，勿手动修改关键字段
version: 5                      # ★ 并发控制版本号（整数自增），每次写入 +1。用于乐观锁冲突检测
iteration_id: "2026-06-12-001-体征设备采集映射配置改造"
iteration_status: "in_progress"  # ★ 迭代整体状态：in_progress | completed | abandoned（06归档时设为completed，07归档后才释放ACTIVE；废弃时设为abandoned）
# ★ 可选度量字段（2026-09-25 METRICS-AUTO 新增，仿 complexity_actual 先例）：
# started_at = 01 立项时刻；ended_at = 06 归档当日日期（废弃时补写 = abandoned_at 日期）
# ★ START-PRECISE（2026-10-01）：started_at 写 "YYYY-MM-DDTHH:MM"（本地时、精确到分）。
#   同日多迭代（同日第二个及以后）**必须**带时分 —— 否则度量侧按「同日起点不可分」把该迭代轮数并入同日先者
#   （实测 2026-09-30-002 / 2026-10-01-002 曾因此显示 0 轮）。纯日期写法仍兼容（按当日 00:00 锚定）。
# 不在 §3.3 必填清单内（缺失不视为校验失败）；缺省视为旧版，度量窗口推导走兜底口径
started_at: "2026-06-12T14:30"
ended_at: "2026-06-19"
complexity: "🔴"            # 🟢 简单 | 🟡 中等 | 🔴 复杂
complexity_original: "🟡"   # ★ 初评复杂度（若被调整过，保留初评值用于追溯）
# 复杂度升降级记录（无调整时为空数组）
complexity_adjustments:
  - at_phase: "03"
    from: "🟡"
    to: "🔴"
    reason: "存储过程改造涉及 3 个 GTT 临时表和 1 个 PROC 重写，超出中等范围"
    adjusted_at: "2026-06-25T14:00"
# ★ 可选字段（2026-09-16 新增，04 阶段 Step 5.6 回填）：实际复算等级，仅记录与校准用
# 不改变 complexity；★ 不在 §3.3 必填清单内（缺失不视为校验失败）
complexity_actual: "🟡"
complexity_actual_factors:
  - id: "new_api"
    score: 2
complexity_actual_note: "04 实际新增 4 个文件、1 个接口，与 03 复评一致"
current_phase: "04"         # "01" ~ "07"
phase_status: "in_progress" # 当前阶段状态：in_progress | completed | blocked

last_updated: "2026-06-19T19:30"

# 本次对话摘要（对话结束/06归档时写入，200字以内；下次对话 Step B 恢复时注入）
last_session_summary: "完成了 Task-1~7：新增 Entity/BLL/Web 三层文件，csproj 注册通过，编译 0 error。待完成 Task-8~9（BLL/Web 追加方法）。关键决策：SaveVitalSignsWithDevice 合并写入，不拆分事务。"

# 仅 iteration_status == "paused" 时存在：
pause_reason: ""
# 仅 iteration_status == "abandoned" 时存在：
abandon_reason: "需求取消，客户不再需要此功能"
abandoned_at: "2026-07-23T10:00"

# ★ 当前阶段步骤追踪（强制，每阶段进入时初始化，每步骤完成时更新）
phase_steps:
  - id: "step-0-sql-gen"
    name: "数据库脚本生成"
    status: "completed"       # pending | completed | skipped | not_applicable
    mandatory: true
  - id: "step-1-task-list"
    name: "任务清单生成"
    status: "pending"
    mandatory: true
# 跳过示例：status: "skipped" + skip_reason: "本次无数据库变更"（规则见 §8.4）

# 04 阶段任务进度（其他阶段可留空）
tasks_total: 12
tasks_completed: 7
tasks_pending:
  - id: "Task-8"
    file: "BLL/TriageVitalSignsMgr.cs"
    op: "追加"
    desc: "新增 SaveVitalSignsWithDevice 方法"
  - id: "Task-9"
    file: "Web/TriageVitalSigns.cs"
    op: "追加"
    desc: "新增 SaveVitalSignsWithDevice API 方法"

# ★ 多 Story 并行（仅 04 阶段使用；单 Story 迭代可省略此字段）
# 聚合型：top-level 的 tasks_total/tasks_completed 为各 Story 之和（向后兼容旧 reader，见 §3.3 一致性校验）
stories:
  - story_id: "STORY-A"
    title: "体征设备采集映射改造"
    status: "in_progress"      # in_progress | completed | blocked | abandoned
    completed_at: ""           # 仅 status == "completed" 或 "abandoned" 时写入 ISO 时间戳
    # Story 级 04 执行步骤（代码新建/替换类）；Sprint 级步骤留在 top-level phase_steps
    dev_steps:
      - id: "step-4-csproj"
        name: "编译单元注册"
        status: "completed"
        mandatory: true
      - id: "step-5-build"
        name: "构建验证"
        status: "pending"
        mandatory: true
    tasks_total: 4
    tasks_completed: 3
    tasks_pending:
      - id: "Task-8"
        file: "BLL/TriageVitalSignsMgr.cs"
        op: "追加"
        desc: "新增 SaveVitalSignsWithDevice 方法"
    blockers: []
  # 多 Story 时逐 Story 追加同构条目

# 阻塞清单（空数组=无阻塞）
blockers: []
# 有阻塞时示例：- id: "B-1" / type: "compile_error" / desc: "BLL/TriageVitalSignsMgr.cs 第 312 行 using 缺失" / created_at: "2026-06-19T20:00"

# ★ 缺陷台账（2026-09-23 DEFECT-1 新增；空数组 = 无缺陷记录）
#   用途：缺陷的**跨阶段唯一台账** —— 与 05 报告「五、缺陷记录」节按 id 双向对账。
#   ★ 与 blockers 的分工：blockers = 阻塞（编译失败 / 审查不通过 / 环境不可达，会挡住阶段推进）；
#     defects = 缺陷（不必然阻塞，但存在 open 时**禁止推进 06**，见 gate-protocol.md §三-C）。
#   ★ 为何不进 ACTIVE Line 2：Line 2 格式变更会波及宿主 agent 配置与既有解析；
#     缺陷状态以本文件为 SSOT，查询读 `defects[]`（缺失 = 无缺陷，向后兼容旧 state.yaml）。
defects: []
# 有缺陷时示例（枚举值见 §3.3「枚举值校验」表）：
# defects:
#   - id: "D-1"
#     desc: "列表页保存后首屏空表（$refs 未就绪致回填静默跳过）"
#     severity: "P1"
#     root_cause_level: "L1"         # L1 实现缺陷 | L2 方案缺陷（03 需变更）| L3 需求缺陷
#     design_changed: false          # ★ 登记时由用户确认；true ⇒ 必须走 L2/L3 回退协议，不得走修复窗口
#     status: "open"
#     opened_at: "2026-09-23T10:00"
#     # fixed_at（fixed 时写入）/ fix_files（实际改动文件，审计回溯用；可空）/ verified_by（回归验证人 user/agent）/ gate_window（用户手动开闸就地修复留痕，如 "bypass 10:00~10:40"）——fixed ⇒ fixed_at、L2/L3 ⇒ rollback_checks 见 §3.3 缺陷台账校验，其余详见 phase-04 Step F
```

### 3.1 阶段完成历史（phase_history）

```yaml
# 阶段完成历史（含跳过记录）
phase_history:
  - phase: "01"
    completed_at: "2026-06-12T10:00"
  - phase: "02"
    skipped: true
    skip_reason: "🟢简单需求跳过评审"
    skipped_at: "2026-06-12T11:00"
  - phase: "03"
    completed_at: "2026-06-15T14:30"
```

#### review_gate（评审门禁）

> 解决问题：评审记录（Markdown）中有"通过/不通过"复选框，但没有写入 state.yaml 的结构化状态。评审不通过时，Agent 仍可推进到下一阶段。
> 核心机制：每个阶段完成时，将评审结果写入 `phase_history` 对应条目的 `review_gate` 字段；阶段转换前检查该字段，拒绝不通过的评审。

**适用阶段**：02（需求评审）、03（技术方案评审）

**Schema**：

```yaml
phase_history:
  - phase: "02"
    completed_at: "2026-06-15T14:30"
    review_gate:
      result: "passed"                      # passed | conditionally_passed | rejected
      assessed_at: "2026-06-15T14:30"
      # 仅 rejected 时有：
      rejection_reason: "需求范围不明确，缺少异常路径定义"
  - phase: "03"
    completed_at: "2026-06-15T14:30"
    review_gate:
      result: "passed"                      # passed | rejected
      assessed_at: "2026-06-15T14:30"
      # 仅 rejected 时有：
      rejection_reason: "数据流断裂：BLL 层缺少 Save 方法签名"
```

| 阶段 | 允许值 | 说明 |
|------|--------|------|
| 02 | `passed` / `conditionally_passed` / `rejected` | 对应评审记录模板的三个复选框 |
| 03 | `passed` / `rejected` | 自主审查 + 用户确认，无条件通过概念 |

**向后兼容**：`review_gate` 为可选字段。现有 state.yaml 若无此字段，视为"不强制执行 gate"（即允许阶段转换）。

**阶段转换检查规则**：从 M 阶段推进到 M+1 阶段时（M 为 02 或 03），必须检查 `phase_history[M].review_gate.result`：

```
result = "passed"           → 允许推进
result = "conditionally_passed"（仅 02） → 允许推进
result = "rejected"         → BLOCK，输出：
    ╔══════════════════════════════════════╗
    ║  🛑 评审未通过，不能进入下一阶段      ║
    ║                                      ║
    ║  阶段：{M}                          ║
    ║  原因：{rejection_reason}            ║
    ║                                      ║
    ║  请选择：                            ║
    ║  1️⃣ 重新执行评审                     ║
    ║  2️⃣ 强制跳过（需记录 override_reason）║
    ╚══════════════════════════════════════╝

override 写法：
    review_gate:
      result: "rejected"
      overridden_by: "user"
      override_reason: "用户理由"
      overridden_at: "2026-06-15T15:00"
```

> **写入校验规则**（阶段推进时强制）：每次从 M 阶段推进到 M+1 阶段时，Agent 必须确认 `phase_history` 包含 `01` 到 `M` 之间的所有阶段（含 skipped 的）。若发现缺失，先补齐再推进。

### 3.2 阶段回退检查记录（rollback_checks）

> 当发生阶段回退（N→M, N>M）时，Agent 必须按 `workflow-engine.md` 的「阶段回退文档同步门禁」（第 136-178 行）执行，并将确认结果写入此字段。
> ★ 2026-09-23 修正引用漂移：原写「第122-165行」，实际内容已移至 136-178 行。

```yaml
# 阶段回退检查记录（无回退时为空数组）
rollback_checks:
  - rollback_from: "05"
    rollback_to: "03"
    rollback_reason: "SQL参数化方案变更"
    rollback_at: "2026-06-29T14:12"
    consistency_checks:
      - document: "03-技术方案"
        needs_update: true
        confirmed_by: "user"
      - document: "02-需求评审"
        needs_update: false
        confirmed_by: "user"
      - document: "01-需求记录"
        needs_update: false
        confirmed_by: "user"
```

> **字段说明**：
> - `rollback_from`/`rollback_to`：回退的起止阶段
> - `rollback_reason`：回退原因
> - `consistency_checks`：M 到 N-1 各阶段文档的确认结果
> - `needs_update`：该文档是否需要同步更新
> - `confirmed_by`：确认者（user 表示用户显式确认）

### 3.3 Schema 强制校验规则（★ 写入时必须执行）

> Agent 每次写入 state.yaml 时，必须在写入完成后立即执行以下校验，确保格式合规。
> ★ 已脚本化（SLIM-4 · 2026-09-25）：写入后执行 `python {IDE}/skills/iteration-workflow/scripts/validate-state.py`（省略路径 = 经 ACTIVE 解析最新 in_progress state；脚本 ERR ⇒ 按下方自检 3 步回退，WARN 不回退）。
> 脚本与本文规则不一致时**以本文为准**并登记 AUDIT；★ 双向对账项（05 报告 vs `defects[].id`）不在脚本覆盖内，仍由 Agent 执行 ⇒ **脚本 exit 0 ≠ 本节全过**。

**必填字段检查**：以下字段必须在 state.yaml 中存在：
- `version` / `iteration_id` / `iteration_status` / `complexity` / `current_phase` / `phase_status` / `last_updated`

> ★ `started_at` / `ended_at` 为可选度量字段（2026-09-25 METRICS-AUTO 新增）：**不在必填清单内**，缺失不视为校验失败；旧版 state 无此字段属正常态（向后兼容，同 §review_gate 先例）。
> ★ START-PRECISE（2026-10-01）：该字段存在时，`started_at` 应写 `YYYY-MM-DDTHH:MM`（本地时）；**同日第二个及以后的迭代必须带时分**（否则度量侧判「同日起点不可分」，轮数并入同日先者）。纯日期写法仅由 `validate-state.py` 报 [R7] WARN（**不阻断**，兼容历史 state 不回溯）。
> ★ `phase_confirm` 为可选留痕段（2026-10-01 RESUME-3 批次 3 新增）：**不在必填清单内**（观测期向后兼容，同上先例）；`current_phase` 变更时须随写（见 §3.3 枚举区「阶段推进留痕」与 `gate-protocol.md` §三-B）。

> ★ `phase_history` 条目存在时，其 `completed_at` / `skipped_at` 须**包含式匹配** `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`（允许尾随 `:ss` / 时区后缀，禁止全串匹配）【PHASE-METRICS 2026-09-25】；纯日期视为校验 WARN（**不阻断**，兼容历史 12 state 不回溯；实施后新迭代抽查 WARN=0）。`entered_at` 不引入——阶段起点 = 上一**实做**阶段 `completed_at`，首阶段 = `started_at`；skipped 条目不参与阶段窗界链（仅作注记）。

**枚举值校验**：

| 字段 | 允许值 |
|------|--------|
| `iteration_status` | `in_progress` / `completed` / `abandoned` |
| `complexity` | `🟢` / `🟡` / `🔴` |
| `current_phase` | `"01"` ~ `"07"`（字符串格式） |
| `phase_status` | `in_progress` / `completed` / `blocked` / `paused` |
| `phase_steps[].status` | `pending` / `completed` / `skipped` / `not_applicable` |
| `stories[].status` | `in_progress` / `completed` / `blocked` / `abandoned` |
| `stories[].dev_steps[].status` | `pending` / `completed` / `skipped` / `not_applicable` |
| `defects[].status` | `open` / `fixed` / `deferred` |
| `defects[].severity` | `P0` / `P1` / `P2` |
| `defects[].root_cause_level` | `L1` / `L2` / `L3` |
| `defects[].design_changed` | `true` / `false`（布尔） |

**阶段推进留痕（★ 2026-10-01 RESUME-3 批次 3 新增）**：

| 字段 | 允许值 |
|------|--------|
| `phase_confirm.from` / `phase_confirm.to` | `"01"` ~ `"07"`（字符串，`to` = `from` + 1） |
| `phase_confirm.by` | `qq#N`（QQ 确认门登记已消费）/ `ide`（本会话通过语）/ `handoff`（headless 继承 `PIVAS_HANDOFF_OWNER`）/ `bypass`（逃生口） |
| `phase_confirm.at` | ISO 时间戳（`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}` 包容式匹配，同 `phase_history` 口径） |
| `phase_confirm.quote` | 自由文本（`by: "ide"` 时**必填** = 用户通过语原文；其他取值可省） |

- 触发时机：`current_phase` 变更的**同一次写入**必须含 `phase_confirm`（执行条款见 `gate-protocol.md` §三-B「确认留痕」）；
- **可选字段（观测期向后兼容）**：缺失不视为校验失败（同 `review_gate` legacy 先例）；`by:"ide"` 无 `quote` 视为**无效留痕**（07 回顾审计项）；
- 观测期 `gate-check.mjs` 对 current_phase 变更**仅通知不拦截**（fail-open）；强制化（fail-closed）另行拍板（RESUME-3 批次 3 路线 I → G1）。

**缺陷台账校验（★ 2026-09-23 DEFECT-1 新增）**：
- `defects` 为**可选字段**（缺失 = 无缺陷，向后兼容旧 state.yaml）；存在时每条须通过上表枚举校验，且 `id` 唯一；
- `status == "fixed"` ⇒ 必须有 `fixed_at`；`root_cause_level ∈ {L2, L3}` ⇒ 必须有对应阶段的 `rollback_checks` 条目；
- ★ **双向对账**：05 报告「缺陷记录」节须与 `defects[].id` 一一对应（报告有、台账无 ⇒ 校验失败）。

**开闸对账校验（★ 2026-10-02 E-1 新增 · 方案 α 核心）**：

> 依据：迭代 `2026-10-01-002` 03 方案 α —— 不新增写权限，改为把「开闸就地修复」的**留痕纪律机械化**。

- 缺陷条目含 `gate_window`（= 用户手动开闸、Agent 在窗口内改码）⇒ **`fix_files` 必填**且为非空列表，
  每条须为**项目内相对路径**（禁 `..`、盘符、绝对路径）——"窗口内改了哪些文件"必须可机器对账；
- `status == "fixed"` 且含 `gate_window` ⇒ **`verified_by` 必填**（回归验证人 `user` / `agent`）；
- 机械化执行：`scripts/validate-state.py` 的 **[R8]**（本规则与脚本**同源**，改一处须同步另一处）。

**多 Story 一致性校验（★ 聚合型）**：
- 若 state.yaml 含 `stories` 数组，则 `tasks_total` == Σ `stories[].tasks_total`，`tasks_completed` == Σ `stories[].tasks_completed`（top-level 为各 Story 之和，向后兼容旧 reader）
- `stories[].status == "abandoned"` 时，其 `dev_steps` 中仍为 `pending` 的步骤视为自动跳过，不计入 04 完成门禁
- **向后兼容**：无 `stories` 字段的旧 state.yaml 按单 Story 处理，现有逻辑零改动

**写入后自检流程**：
1. `write_to_file` 或 `replace_in_file` 写入 state.yaml
2. 立即执行校验：**优先跑 `validate-state.py` 脚本**；脚本不可用（PyYAML 缺失等）时降级 `read_file` 人工校验（fail-open）
3. 若校验失败，回退到写入前内容并报告错误

**历史兼容**：已有 `.state.yaml` 不做迁移校验，新写入严格遵守。

---

## 四、读取规则（SKILL.md Step B 中执行）

### 4.1 检测逻辑

```
检查 runtime/ 目录是否存在 *.state.yaml 文件：
  ├── 存在一个或多个 → 取文件名字典序最后一个（最新迭代）
  │     → 读取内容 → 执行 Step B.2（恢复并输出摘要）
  └── 不存在 → 继续 Step C（新迭代流程）
```

### 4.2 步骤门禁恢复（★ Agent 恢复后必须立即执行）

读取 `phase_steps` 后，逐一检查当前阶段所有强制步骤的状态：

```
phase_steps 扫描结果：
  ✅ step-0-sql-gen      [completed] 数据库脚本生成
  ❌ step-0-sql-review   [pending]   脚本审查 [强制]
  ❌ step-0-sql-exec     [pending]   脚本执行 [强制]
  ❌ step-1-task-list    [pending]   任务清单审查 [强制]
```

**门禁规则**：
- 第一个 `status: pending` 的强制步骤 = **当前应该进行的步骤**
- Agent 必须从该步骤开始，不得跳过
- 若用户请求跳过，Agent 必须在 state.yaml 中写入 `skip_reason`

### 4.3 恢复输出格式（Agent 必须按此格式输出）

```
✅ 已从 runtime/ 恢复迭代状态：
- 迭代：2026-06-12-001-体征设备采集映射配置改造
- 当前阶段：04-开发实现（进行中）
- 步骤进度：
  ✅ Step 0.1 脚本生成
  ✅ Step 0.2 脚本审查
  ❌ Step 0.3 脚本执行 ← 当前步骤（强制）
  ⏳ Step 1   任务清单审查
- 任务进度：7/12 完成
- 待完成任务：Task-8（BLL/TriageVitalSignsMgr.cs 追加），Task-9（Web/TriageVitalSigns.cs 追加）
- 阻塞：无
- 上次摘要：完成了 Task-1~7，编译 0 error。关键决策：SaveVitalSignsWithDevice 合并写入，不拆分事务。

继续上次进度，是否从 Step 0.3 开始？

> **多 Story 并行恢复输出（压缩格式）**：04 阶段含 `stories` 时，恢复输出采用「Sprint 概要 + 逐 Story 摘要行」，**不逐步骤展开**；用户追问某 Story 当前步骤时再展开其 `dev_steps` 明细：
> ```
> ✅ 已从 runtime/ 恢复迭代状态（多 Story Sprint）：
> - 迭代：2026-06-12-001-xxx
> - 当前阶段：04-开发实现（进行中）
> - Sprint 级步骤：✅ 任务清单  ✅ Spec 更新
> - Story 进度：
>   ✅ STORY-A  3/4 任务完成（in_progress）
>   ⏳ STORY-B  0/0 任务完成（in_progress）← 当前步骤：step-4-csproj
>   🛑 STORY-C  1/2 任务完成（blocked：编译失败）
> - 阻塞：STORY-C 编译错误
> 追问「STORY-B 当前步骤」可展开其 dev_steps 明细。
> ```
```

> **写入规则**：`last_session_summary` 由 Agent 在以下时机生成并写入（100~200 字）：
> 1. 用户发出"结束/下次继续"等信号时：总结本次对话完成了什么、遗留了什么、有哪些关键决策
> 2. 06 阶段归档时：总结整个迭代的核心交付、遇到的主要问题、采用的解决方案
>
> **读取规则**：Step B 恢复状态时，若存在 `last_session_summary`，必须在恢复摘要中展示（如上格式）。

---

## 五、状态文件生命周期

```
01 阶段启动 → 创建 state.yaml（iteration_status = "in_progress"）+ ACTIVE 写入迭代ID
    ↓
每阶段/任务完成 → 更新 state.yaml
    ↓
06 阶段归档完成 → iteration_status = "completed"，current_phase = "07"
    ↓
07 阶段回顾归档完成 → phase_status = "completed"，ACTIVE 写入 "none"，
                       将 state.yaml 重命名为 {ITERATION_ID}.state.archived.yaml

  [废弃分支] 任何阶段 → 用户明确要求废弃迭代
    ├── iteration_status = "abandoned"
    ├── 写入 abandon_reason + abandoned_at + last_session_summary
    ├── phase_steps 中所有 pending 强制步骤 → skipped（skip_reason: "迭代废弃"）
    ├── tasks_pending 保留，标注 tasks_status: "abandoned"
    ├── ACTIVE 写入 "none"
    └── state.yaml 保留不重命名（知识留存）
```

### 5.1 生命周期中的阶段回退分支

> ★ **2026-09-23 DEFECT-1 收敛**：本节原写「所有步骤 status 设为 `pending`」，与 §5.2 的「仅重置未完成项、已完成但不适用的改写为 `not_applicable`」**互相冲突** ⇒ 实测执行因此走了第三条路（自造游离步骤块，未进 SSOT）。**重置语义的唯一真相源 = §5.2**。

```
阶段回退（N→M, N>M）
    │
    ├── current_phase 更新为 M，phase_status 设为 "in_progress"
    ├── phase_steps 按 §5.2 规则重置（★ 不是一律置 pending）
    ├── 因缺陷回退 ⇒ 走 [phase-steps.md](phase-steps.md) 的 step-fix-* 修复窗口并写入 phase_steps
    ├── 回退前已完成的用例结果**保留**（见 §5.3）
    ├── rollback_checks 记录一致性检查结果
    └── 进入 M 阶段正常流程
```

### 5.2 阶段回退 phase_steps 重置实现

阶段回退（N→M, N>M）时，按以下逻辑处理：

```
回退到阶段 M 时：
  1. 遍历 phase_steps，将所有 status != "completed" 的设为 "pending"
  2. 对 status == "completed" 且 mandatory=true 的步骤，
     检查是否在 M 阶段适用（不适用的设为 "not_applicable"）
  3. 补充 M 阶段特有但当前 phase_steps 中缺失的步骤
     （从 [phase-steps.md](phase-steps.md) 获取 M 阶段的默认步骤清单）
  4. 更新 current_phase="M", phase_status="in_progress"
  5. rollback_checks 记录一致性检查结果
```

### 5.3 缺陷修复窗口与用例资产保留（★ 2026-09-23 DEFECT-1 新增；★ 2026-10-02 α 口径修订）

> 依据：真实回退记录（12 条 05→04）显示实践**已在用**「修复窗口」，但步骤 ID 自造、未进 SSOT ⇒ 审计与一致性检查看不见。
> ★ **2026-10-02 修订（迭代 `2026-10-01-002` · 方案 α · 用户 QQ#7 裁定）**：**维持「不新增放行面」**
>   （原选项甲），并把「05 就地修」**正规化 + 对账机械化**：
>   - **04 侧窗口**：`step-fix-1-register` ~ `-5-reclose` —— **唯一免开闸**的落盘窗口；
>   - **05 侧窗口**：`step-fix-05-1-register` ~ `-4-reclose`（SSOT = `phase-steps.md` §阶段五）——
>     仅 **L1 且不涉后端码**的小修，须**用户开闸**，且 `defects[].gate_window` 与 `fix_files` **成对**留痕
>     （机器校验 = §3.3「开闸对账校验」/ `validate-state.py [R8]`）；涉后端码 / 需 `/t:Rebuild` ⇒ 必须回 04。

- **窗口步骤（SSOT = [phase-steps.md](phase-steps.md)）**：
  ① 04 侧：`step-fix-1-register` → `-2-code` → `-3-build` → `-4-regress` → `-5-reclose`；
  ② 05 侧：`step-fix-05-1-register` → `-2-code` → `-3-regress` → `-4-reclose`；
  ★ **禁止**再用游离自造步骤块（历史 `phase_steps_04_d1fix`、`step-d18-*` 均未被 SSOT 收录）。
- **收口后回 05**：不回退既有用例结果 —— 新增用例**续接编号**，已跑结果**原样保留**（审计留痕）。
- **推进拦截**：`defects[]` 存在 `status: "open"` ⇒ 禁止推进 06（见 `gate-protocol.md` §三-C）。
- **例外通道留痕**：若用户选择手动开闸在 05 就地修复（非协议路径），须在 `defects[].gate_window` 记录窗口时间，并在 05 报告注明"开闸窗口内改码"。

---

> 强制跳过（paused）时，ACTIVE 也写入 `"none"`。重新打开已完成迭代时，ACTIVE 恢复写入迭代ID。

---

## 六、ACTIVE 指针协议（★ 2026-06-29 新增）

> 参照 Git HEAD / K8s Lease 模式：维护一个「活跃指针」文件，门禁检查从 O(n) 扫描降为 O(1) 读取。
> ACTIVE 指针是门禁检查的第一步，兜底扫描仅作为 ACTIVE 损坏/失同步时的安全保障。

### 6.1 文件格式

```
runtime/ACTIVE
```

**双行文本文件**（★ 2026-07-24 v2 升级，解决轻量查询需扫描多个 yaml 的问题）：

```
第1行: {ITERATION_ID}     ← 活跃迭代ID，或 "none"（无活跃迭代）
第2行: STATUS={status} PHASE={phase} TASKS={done}/{total} BLOCKERS={count}
```

示例（活跃迭代）：
```
2026-07-23-020-S1门禁自动化回归测试矩阵
STATUS=in_progress PHASE=04 TASKS=5/8 BLOCKERS=0
```

示例（无活跃迭代）：
```
none
STATUS=none
```

**第2行字段说明**：
| 字段 | 来源 | 取值 |
|------|------|------|
| `STATUS` | `state.yaml.iteration_status` | `in_progress` / `completed` / `abandoned` / `none` |
| `PHASE` | `state.yaml.current_phase` | `"01"` ~ `"07"`；无迭代时为 `-` |
| `TASKS` | `state.yaml.tasks_completed/tasks_total` | `X/Y` 格式；无任务时为 `0/0` |
| `BLOCKERS` | `state.yaml.blockers` 数组长度 | 整数 |
| `UPDATED` | 写入时刻（`scripts/state-apply.py` 自动写入；人工/文件工具写 ACTIVE 时建议同步该字段） | `YYYY-MM-DDTHH:MM`（缺省时迭代看板显示为 `—`） |

> **向下兼容**：第2行不存在（旧格式单行）→ Agent 回退读 state.yaml（当前行为，无退化）。第2行存在但怀疑过时 → 轻量校验（见 §6.5）。

### 6.2 同步规则（★ 2026-07-24 v2 扩展为双行同步）

| 事件 | Line 1 操作 | Line 2 操作 | 触发时机 |
|------|------------|------------|---------|
| 新建迭代 | 写入 `{ITERATION_ID}` | 写入 `STATUS=in_progress PHASE=01 TASKS=0/0 BLOCKERS=0` | 01 阶段启动，state.yaml 创建后 |
| 每阶段推进 | — | 更新 `PHASE={new_phase}` | `current_phase` 变更时 |
| 每任务完成 | — | 更新 `TASKS={done}/{total}` | `tasks_completed` 或 `tasks_total` 变更时 |
| 出现/解除阻塞 | — | 更新 `BLOCKERS={count}` | `blockers` 数组长度变更时 |
| 06 归档完成 | —（不释放） | 更新 `STATUS=completed PHASE=07` | iteration_status → completed |
| 07 回顾归档完成 | 写入 `none` | 写入 `STATUS=none` | state.yaml 重命名后 |
| 强制跳过（paused） | 写入 `none` | 写入 `STATUS=none` | paused 写入后 |
| 迭代废弃 | 写入 `none` | 写入 `STATUS=none` | abandoned 写入后 |
| 重新激活 | 写入 `{ITERATION_ID}` | 从 state.yaml 提取当前状态写入 | 回退到 04 时 |

> **写入顺序**：先写 Line 1，再写 Line 2。Line 2 是"尽力同步"（best-effort），不是强一致性约束——state.yaml 始终是 SSOT。

### 6.3 门禁检查逻辑（★ 确定性——每个分支终点可被 Agent 机械执行）

> **★ 门禁只读 Line 1**：门禁检查逻辑不依赖 Line 2（状态摘要）。Line 2 仅用于轻量状态查询（SKILL.md §第一优先级），门禁代码（gate-check.mjs）只取 ACTIVE 第 1 行作为迭代 ID。

```
门禁触发 → 读取 runtime/ACTIVE 第 1 行
  ├── ACTIVE 不存在 或 第 1 行为 "none"
  │   └── 兜底扫描 runtime/*.state.yaml（排除 *.archived.yaml）
  │       ├── 0 个 in_progress → 确认无活跃迭代 → 门禁判定：无活跃迭代
  │       ├── 1 个 in_progress → ACTIVE 写入该迭代ID → 进入正常门禁
  │       └── N 个 in_progress (N>1)
  │           ├── 按 mtime（最近修改时间）排序，选最新的
  │           ├── ACTIVE 写入该迭代ID
  │           ├── 输出警告："发现{N}个进行中迭代，已选择最新修改的{ID}；其余{IDs}可能为遗留"
  │           └── 进入正常门禁
  ├── ACTIVE 内容为迭代ID
  │   └── 读取 runtime/{ID}.state.yaml
  │       ├── 不存在 → ACTIVE 损坏
  │       │   ├── 修复 ACTIVE = "none"（覆盖写入，非删除文件，与 §6.2 风格一致）
  │       │   └── 回退到"ACTIVE 不存在"分支（重新兜底扫描）
│       ├── iteration_status = "completed"
│       │   ├── 修复 ACTIVE = "none"
│       │   ├── 快速扫描是否有其他 in_progress 的迭代（交叉校验，防罕见失同步）
│       │   │   ├── 无 → 确认无活跃迭代
│       │   │   └── 有 → 输出警告："ACTIVE 指向已完成迭代{ID}，但发现进行中的{ID2}；已切换 ACTIVE"
│       │   │       └── ACTIVE 写入 {ID2}（覆盖）
│       │   └── 门禁判定：无活跃迭代（或已切换到 {ID2}）
│       ├── iteration_status = "abandoned"
│       │   ├── 修复 ACTIVE = "none"
│       │   └── 输出提示："迭代{ID}已废弃（原因：{abandon_reason}），无活跃迭代。如需重启需求请创建新迭代。"
│       ├── phase_status = "paused" 或 "blocked"
  │       ├── 修复 ACTIVE = "none"
  │       └── 输出提示："迭代{ID}已暂停/阻塞（原因：{reason}），无活跃迭代"
  │       └── iteration_status = "in_progress" → 正常门禁
```

> **排序规则**：mtime（文件修改时间）优先于字典序。mtime 真实反映最近操作时间，字典序仅作为同 mtime 时的次级排序依据。

### 6.4 容错原则

- **ACTIVE 优先**：门禁第一步读 ACTIVE，不扫描所有文件
- **兜底校验**：ACTIVE 损坏/不存在时回退扫描，作为安全网
- **自我修复**：发现 ACTIVE 与 state.yaml 不一致时，自动修复 ACTIVE 内容
- **确定性优先**：每个分支路径的终点必须是明确的、Agent 不需自行判断即可执行的操作（具体行为见 §6.3 门禁检查逻辑）
- **mtime 优先于字典序**：多迭代歧义时，按文件修改时间判断活跃度，不以文件名排序作为主依据
- **损坏即归一**：ACTIVE 内容不可信时（指向不存在文件 / 指向非 in_progress 状态），统一通过写入 `none` 清理（与 §6.2 同步规则风格一致），再走"ACTIVE 不存在"分支统一重建

### 6.5 轻量状态查询与一致性校验（★ 2026-07-24 新增）

> 解决问题：用户问"当前迭代状态"时，Agent 只读 ACTIVE 即可回答，不需搜索/列出 `*.yaml` 文件。Line 2 提供关键字段摘要。

#### 6.5.1 Agent 查询流程（SKILL.md §第一优先级 → 本协议）

```
用户问迭代状态 → 读取 runtime/ACTIVE（完整文件，2行）
  ├── Line 2 非空且符合格式 `STATUS=... PHASE=... TASKS=... BLOCKERS=...`
  │   └── ★ 直接解析 Line 2 回答，禁止 search/list/读其他文件
  ├── Line 2 为空（旧格式单行）
  │   ├── Line 1 为 "none" → 回答 "无活跃迭代"
  │   └── Line 1 为迭代ID → 仅读取 state.yaml 一次（不是扫描目录）
  └── Line 2 存在但怀疑过时（Agent 可根据对话上下文判断）
      └── 轻量交叉校验：读 state.yaml 仅取 `iteration_status` 和 `current_phase` 字段
          ├── 一致 → 使用 Line 2 回答
          └── 不一致 → 用 state.yaml 数据回答 + 同步修复 Line 2
```

#### 6.5.2 禁止行为

- ❌ 禁止 `search_file *.yaml` 扫描 runtime 目录
- ❌ 禁止 `list_dir runtime/` 列出所有 state 文件
- ❌ 禁止读取 README / docs / engine 目录下的任何文件
- ❌ 禁止加载 Skill 的完整引擎文件

#### 6.5.3 回答格式（Agent 必须按此格式输出）

```
当前迭代：{迭代ID简述}
状态：{STATUS} | 阶段：{PHASE} | 任务：{TASKS} | 阻塞：{BLOCKERS}
```

> 示例：`当前迭代：S1门禁自动化回归测试矩阵 | 状态：in_progress | 阶段：04-开发实现 | 任务：5/8 | 阻塞：0`

---

## 七、多迭代并行处理

> 多迭代并行的完整行为已纳入 [§6.3 门禁检查逻辑](#63-门禁检查逻辑--确定性每个分支终点可被-agent-机械执行)——各分支的扫描规则、排序规则（mtime 优先）、多 in_progress 时的选择策略均在该节定义。本节不再重复。

---

## 八、phase_steps 字段协议

### 8.1 生命周期

```
阶段进入 → 初始化 phase_steps（根据 workflow-engine 定义的步骤列表）
    ↓
每步骤完成 → status: completed
每步骤跳过 → status: skipped + skip_reason
每步骤不适用 → status: not_applicable
    ↓
阶段完成 → phase_steps 归档到 phase_history（可选）
```

### 8.2 步骤状态枚举

| status | 含义 | 后续行为 |
|--------|------|---------|
| `pending` | 未开始 | Agent 必须从第一个 pending 的强制步骤开始 |
| `completed` | 已完成 | 跳过，检查下一个 |
| `skipped` | 用户显式跳过 | 记录 skip_reason，不阻塞后续步骤 |
| `not_applicable` | 本轮不适用 | 自动跳过（如无SQL变更 step-0-* 均设为 not_applicable） |

### 8.3 门禁检查逻辑（Agent 伪代码）

> ★ 本伪代码 = gate-protocol.md §三-C「步骤结清门禁」的机械化算法（含多 Story 聚合）；行为契约（处置选项①②③ / defects 第一步 / 06→07 说明）以 gate-protocol.md §三-C 为准。

```
function gate_check(state):
    // 单 Story 或 Sprint 级阶段：原逻辑
    if not state.stories or state.current_phase != "04":
        for step in state.phase_steps:
            if step.status == "pending" and step.mandatory:
                return BLOCK(step)
            if step.status == "pending" and not step.mandatory:
                return PROCEED(step)
        return ALL_CLEAR

    // 多 Story + 04 阶段：聚合门禁
    // 1) Sprint 级 04 步骤优先
    for step in state.phase_steps:
        if step.status == "pending" and step.mandatory:
            return BLOCK(step)
        if step.status == "pending" and not step.mandatory:
            return PROCEED(step)
    // 2) 逐 Story 检查（abandoned 自动跳过）
    for story in state.stories:
        if story.status == "abandoned":
            continue
        for step in story.dev_steps:
            if step.status == "pending" and step.mandatory:
                return BLOCK(step, story_id=story.story_id)
            if step.status == "pending" and not step.mandatory:
                return PROCEED(step, story_id=story.story_id)
        if story.tasks_completed < story.tasks_total:
            return BLOCK(task_of=story.story_id)  // 回到该 Story 的 tasks
    // 3) 全部结清（completed + abandoned）
    return ALL_CLEAR
```


### 8.4 跳过覆盖规则

用户可跳过强制步骤，但需显式确认：
1. Agent 提示："{step.name} 为强制步骤，确认跳过？"
2. 用户回复跳过理由
3. Agent 写入 `status: skipped, skip_reason: "用户理由"`
4. 不阻塞后续步骤

### 8.5 各阶段默认步骤清单

> 各阶段的步骤定义详见 `phase-steps.md`（步骤清单唯一真相源）。进入阶段时 Agent 从 phase-steps.md 提取本阶段的步骤列表写入 `phase_steps`。

### 8.6 每日工作日志协议（Step E）独立说明

> **独立协议**：每日工作日志写入（`.claude/memory/YYYY-MM-DD.md`）是**独立于 state.yaml 的强制动作**，定义在 `startup-protocol-step-e.md`。不管 state.yaml 是否触发更新，每次对话结束前都必须写入日志。详见 Step E 完整规则。

详细协议见 [startup-protocol-step-e.md](startup-protocol-step-e.md)。

---

## 九、并发控制协议（★ 2026-07-22 新增，2026-07-22 v2 修复）

> 解决问题：两个 Agent 会话同时写入同一 state.yaml 时，后写入的覆盖先写入的，导致 `phase_steps`、`task_progress` 等数据损坏。
> 核心机制：乐观锁（版本号）+ 原子目录锁（`mkdir`），双层保障。
> **v2 修复（2026-07-22）**：① 锁创建由文件→`mkdir`（原子操作，消除 TOCTOU）；② 定义 canonical RUNTIME_DIR（防双目录锁互不感知）；③ 新增 TTL 自动过期（60s）；④ 新增 STATE_FORCE_WRITE 逃生口。

### 9.0 Canonical RUNTIME_DIR（★ 单一路径）

> 问题：`.claude/skills/.../runtime/` 和 `.codebuddy/skills/.../runtime/` 两个目录各存各的锁，Claude Code 和 CodeBuddy 的锁互不感知。

**必须使用单一 canonical 路径**，检测逻辑（与 `gate-check.mjs` 一致）：

```
RUNTIME_DIR = exists(PROJECT_DIR/.claude/skills/iteration-workflow/runtime/)
            ? PROJECT_DIR/.claude/skills/iteration-workflow/runtime/
            : PROJECT_DIR/.codebuddy/skills/iteration-workflow/runtime/
```

- 所有锁文件、state.yaml 读写均以 `$RUNTIME_DIR` 为准
- 无论从哪个工具（Claude Code / CodeBuddy）进入，都写同一份锁和状态

### 9.1 版本号（乐观锁）

- `state.yaml` 顶层字段 `version: N`（整数，初始值 1，每次写入 +1）
- **读取时记录**：Agent 读取 state.yaml 后，记录当前 `version`
- **写入时比对**：重新读取 state.yaml，若 `version` != 记录的版本号 → 冲突，拒绝写入
- **写入成功后**：新 state.yaml 的 `version` = 旧版本号 + 1

#### 向后兼容

- 现有 state.yaml 无 `version` 字段 → 等价于 `version: 0`
- 第一次按新协议写入时，设置 `version: 1`
- `phase-steps.md` 中 `step-0-init-state` 创建新 state.yaml 时初始 `version: 1`

### 9.2 原子目录锁（`mkdir`）

> v2 修复 #1：原有的"检查锁是否存在 → 创建锁文件"两步不是原子操作，存在 TOCTOU 竞态窗口。
> **`mkdir` 在文件系统层是原子操作**：路径不存在 → 创建成功（获得锁）；路径已存在 → 失败（锁被占用）。两个 Agent 同时调用只有一个成功。

#### 锁规格

| 属性 | 值 |
|------|-----|
| 路径 | `$RUNTIME_DIR/{ITERATION_ID}.lock/`（**目录**，非文件） |
| 内容 | `$RUNTIME_DIR/{ITERATION_ID}.lock/pid`（文件，含 PID + 时间戳） |
| 创建 | `mkdir(lock_dir)` — 原子，成功=获得锁，失败(E_EXIST)=锁被占用 |
| 释放 | `rmdir(lock_dir)` 或 `rm -rf(lock_dir)`（删除目录及其内容） |
| TTL | **60 秒**（锁目录 mtime 超过 60s 视为过期，自动覆盖） |

#### 获取锁流程

```
Agent 准备写入 state.yaml:
  ├── Step 0: 逃生口检查
  │   ├── 环境变量 STATE_FORCE_WRITE=1 → 跳过全部锁/版本号检查，直接写入
  │   └── 否则 → 进入 Step 1
  ├── Step 1: 尝试 mkdir 创建 $RUNTIME_DIR/{ITERATION_ID}.lock/
  │   ├── mkdir 成功 → 写入 lock_dir/pid（"PID:{pid} TS:{ISO_TIMESTAMP}"），进入 Step 2
  │   └── mkdir 失败（E_EXIST，目录已存在）→ 检查 TTL：
  │       ├── lock 目录 mtime < now - 60s → 锁过期，删除旧锁目录 → 重试 mkdir
  │       │   ├── mkdir 成功 → 覆盖旧锁，写入新 pid，进入 Step 2
  │       │   └── mkdir 仍失败 → 进入等待重试（下面的分支）
  │       ├── lock 目录 mtime >= now - 60s → 锁有效，等待 1s 后重试 mkdir，最多 3 次
  │       │   ├── 3次内 mkdir 成功 → 写入 pid，进入 Step 2
  │       │   └── 3次后仍失败 → BLOCK，报告：
  │       │       ╔══════════════════════════════════════════╗
  │       │       ║  🛑 state.yaml 被锁定                     ║
  │       │       ║                                          ║
  │       │       ║  锁持有者 PID: {pid}，时间: {ts}          ║
  │       │       ║  lock 目录: {lock_dir}                   ║
  │       │       ║                                          ║
  │       │       ║  可能原因：                               ║
  │       │       ║  • 另一 Agent 正在写入（正常，等它完成）  ║
  │       │       ║  • Agent 崩溃后锁残留（60s 后自动过期）   ║
  │       │       ║                                          ║
  │       │       ║  请选择：                                ║
  │       │       ║  1️⃣ 等待（锁将在 60s TTL 后自动释放）    ║
  │       │       ║  2️⃣ 手动删除 {lock_dir} 后重试            ║
  │       │       ║  3️⃣ 设置 STATE_FORCE_WRITE=1 强制写入    ║
  │       │       ╚══════════════════════════════════════════╝
  ├── Step 2: 重新读取 state.yaml，记录当前 version
  │   ├── version == 写入前记录的版本号 → 进入 Step 3
  │   └── version != 写入前记录的版本号 → 冲突，释放锁目录，报告：
  │       ╔══════════════════════════════════════════╗
  │       ║  🛑 并发修改冲突                           ║
  │       ║                                          ║
  │       ║  state.yaml 版本号已从 {old_v} 变为 {new_v}║
  │       ║  其他进程已修改此文件。                    ║
  │       ║                                          ║
  │       ║  当前最新数据已保留，请重新执行本步骤。     ║
  │       ╚══════════════════════════════════════════╝
  ├── Step 3: 写入 state.yaml（version = 旧版本号 + 1）
  ├── Step 4: 写入后自检（§三.3 校验规则）
  └── Step 5: 释放锁（删除 $RUNTIME_DIR/{ITERATION_ID}.lock/ 整个目录）
```

### 9.3 完整写入流程（Agent 伪代码）

```
function write_state_yaml(iteration_id, new_content):
    runtime_dir = get_canonical_runtime_dir()  // §9.0
    lock_dir = f"{runtime_dir}/{iteration_id}.lock"
    state_path = f"{runtime_dir}/{iteration_id}.state.yaml"
    LOCK_TTL_SEC = 60

    // ★ 逃生口
    if env.STATE_FORCE_WRITE == "1":
        write_file(state_path, new_content)
        return

    // 读当前状态
    old_state = read_yaml(state_path)
    old_version = old_state.version or 0

    // 获取锁（mkdir 原子操作）
    for retry in 1..3:
        try:
            mkdir(lock_dir)                    // 原子！成功=获得锁
            write_file(f"{lock_dir}/pid", f"PID:{pid} TS:{now()}")
            break
        catch E_EXIST:
            lock_mtime = stat(lock_dir).mtime
            if now() - lock_mtime > LOCK_TTL_SEC:
                // TTL 过期，强制覆盖
                rmdir_rf(lock_dir)             // 递归删除旧锁目录
                try:
                    mkdir(lock_dir)
                    write_file(f"{lock_dir}/pid", f"PID:{pid} TS:{now()}")
                    break
                catch E_EXIST:
                    // 覆盖时另一个 Agent 抢先了，继续重试
                    pass
            if retry == 3:
                pid_content = read_file(f"{lock_dir}/pid")
                return BLOCK_LOCK_STALE(pid_content)
        sleep(1s)

    // 乐观锁检查
    current = read_yaml(state_path)
    if current.version != old_version:
        rmdir_rf(lock_dir)
        return BLOCK_VERSION_CONFLICT(old_version, current.version)

    // 写入 state.yaml
    new_content.version = old_version + 1
    write_file(state_path, new_content)

    // 自检
    validate_schema(state_path)

    // ★ 同步 ACTIVE Line 2（在锁内，与 state.yaml 写入属同一事务）
    if state_changed_fields includes (iteration_status/current_phase/tasks_completed/tasks_total/blockers):
        sync_active_line2(state_path, runtime_dir)  // 见 §6.2

    // 释放锁
    rmdir_rf(lock_dir)
```

### 9.4 逃生口

| 方式 | 作用 | 使用场景 |
|------|------|---------|
| `STATE_FORCE_WRITE=1` 环境变量 | 跳过锁 + 版本号检查，直接写入 | 锁残留且确认无并发写入时 |
| 手动删除 `$RUNTIME_DIR/{ITERATION_ID}.lock/` | 清除残留锁目录 | Agent 崩溃后清理 |

> 逃生口设计遵循与 `GATE_BYPASS` 相同的原则：显式、可审计、非静默。

### 9.5 v2 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-07-22 | 初始版本：乐观锁 + 文件锁（方案C） |
| v2 | 2026-07-22 | 修复 #1 锁创建非原子性（文件→`mkdir`）；修复 #2 双 runtime 目录（§9.0 canonical RUNTIME_DIR）；新增 TTL 60s 自动过期；新增 STATE_FORCE_WRITE 逃生口 |

---

### 9.6 脚本通道（`scripts/state-apply.py` · ★ 2026-10-03 PERF-1 新增）

> **依据**：PERF-1 实测 —— 状态更新的耗时单位是**模型 step 数**（一次更新实测 2 个 step ≈ 105s；写入载荷生成占所在 step 11%~62%）。
> §9.1~9.4 的手工串行步骤保留为**降级/复杂路径**；**意图式命令**把「读 state」的职责移入脚本，使简单更新压到 **1 个 step**。

**命令（幂等）**：

| 命令 | 语义 |
|------|------|
| `summary --text "…"` | `last_session_summary` + `last_updated` |
| `step-complete --id <id>` / `step-skip --id <id> --reason "…"` | `phase_steps[]` 状态跃迁 |
| `task-done [--id <id>]` | `tasks_completed+1` + 从 `tasks_pending` 移除 |
| `phase-advance --to <NN> --confirm-by <qq#N\|ide\|handoff\|bypass> [--quote "…"] [--gate-result …]` | 旧阶段入 `phase_history` + `current_phase` 推进 + `phase_confirm`（**缺 confirm 参数 ⇒ 拒绝**；`by=ide` 时 `--quote` 必填） |
| `blocker-add/rm` · `defect-add/close` | `blockers[]` / `defects[]` |
| `patch --file <json>` | 顶层标量覆盖（**仅已存在键**；逃生口） |

**单次调用内部保证**（与 §9.1~9.4 等价）：加锁（mkdir + TTL 60s）→ 读 canonical → **幂等检查** → 文本级改字段 → `version+1` / `last_updated` → 变更前重读比对（乐观锁）→ 备份 `runtime/snapshots/` → **双副本写** → 两侧 ACTIVE Line2（含 `UPDATED`）→ **单源校验**（同进程执行 `scripts/validate-state.py`；失败 ⇒ state + ACTIVE **双侧回滚**）→ 自留痕 → 释放锁。
环境变量：`STATE_FORCE_WRITE=1`（逃生口，跳过锁与版本比对）、`STATE_APPLY_ROOT`（演练/隔离根）、`STATE_APPLY_SESSION`（留痕 session）。

**审计等价性（★ 评审硬要求）**：命令通道不经文件工具 ⇒ 文件通道的相位守卫 / S8 留痕告警**不触发**，由脚本自留痕**等价替代**：① `gate-audit.log` 记 `STATE_APPLY` tag（cmd / iter / version 变迁）；② `write-claims.jsonl` 追加同构条目；③ `phase-advance` 强制 `phase_confirm` 参数（等价 S8）。

**不覆盖**（仍走 §二-A 手工协议或文件工具）：重新打开 10 步协议、归档重命名、多 Story 全量重置、`stories[]` 深层结构。

**回归**：`scripts/run-state-tests.py`（T1~T10：全链路 / 幂等 / 锁占用 / TTL 恢复 / confirm 负向 / advance 正向 / patch 未知键 / 校验失败双侧回滚 / FORCE / 自留痕），隔离根 `runtime/state-apply-tests/` 执行，不触碰真实 state。
