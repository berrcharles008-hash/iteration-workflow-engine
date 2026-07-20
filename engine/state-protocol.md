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

| 事件 | 动作 | ACTIVE 同步 |
|------|------|:--:|
| 新建迭代（01 阶段启动） | 创建文件，写入初始状态（`iteration_status: "in_progress"`, phase: "01", status: "in_progress"），初始化当前阶段的 `phase_steps` | 写入迭代ID |
| 每个阶段完成 | 更新 `current_phase` 和 `phase_status`，初始化新阶段的 `phase_steps` | — |
| 每个步骤完成（所有阶段） | 更新 `phase_steps.{step-id}.status` 为 `completed` | — |
| 步骤被跳过 | 更新 `phase_steps.{step-id}.status` 为 `skipped` + 写入 `skip_reason` | — |
| 每个任务完成（04 阶段） | `tasks_completed + 1`，从 `tasks_pending` 移除对应任务 | — |
| 对话结束前（用户发出"结束/下次继续"等信号） | 更新 `last_updated` 时间戳 + 写入 `last_session_summary` | — |
| 06 阶段归档完成 | 将 `iteration_status` 设为 `"completed"`，`current_phase` 推进到 `"07"`，写入 `last_session_summary` | —（不释放） |
| 07 阶段回顾归档完成 | `phase_status` 设为 `"completed"`，保持 `iteration_status: "completed"` | 写入 `"none"` |
| 强制跳过（paused） | `phase_status` 设为 `"paused"`，写入 `pause_reason` | 写入 `"none"` |
| 重新打开已完成迭代（回退到 04） | ★ 完整回退协议（见下方 §二-A） | 写入迭代ID |
| 出现阻塞（编译失败/审查不通过） | 向 `blockers` 追加条目 | — |
| 阻塞解除 | 从 `blockers` 移除对应条目 | — |

> **注意**：`step-0-init-state` 已纳入 `phase-steps.md` §阶段一和 `workflow-engine.md` §阶段一前置步骤，Agent 进入 01 阶段时自动执行，不可跳过。

---

### ★ 二-A：重新打开已完成迭代的完整操作协议（强制）

> **触发条件**：用户要求重新打开已归档的迭代（通常回退到 04 阶段修复遗留 Bug）。
> **根因**：此前协议 §二第 33 行描述过于简略（只写了 2 件事），Agent 执行时遗漏 phase_steps 重置、tasks 清零、rollback_checks 等关键步骤，导致 ACTIVE 指针与 state.yaml 状态不一致。
> **修复**：以下协议是**原子操作清单**，必须按顺序全部执行，缺一不可。

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
        10b. 枚举值合法性（iteration_status 必须是 "in_progress" 或 "completed"）
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
iteration_id: "2026-06-12-001-体征设备采集映射配置改造"
iteration_status: "in_progress"  # ★ 迭代整体状态：in_progress | completed（06归档时设为completed，07归档后才释放ACTIVE）
complexity: "🔴"            # 🟢 简单 | 🟡 中等 | 🔴 复杂
complexity_original: "🟡"   # ★ 初评复杂度（若被调整过，保留初评值用于追溯）
# 复杂度升降级记录（无调整时为空数组）
complexity_adjustments:
  - at_phase: "03"
    from: "🟡"
    to: "🔴"
    reason: "存储过程改造涉及 3 个 GTT 临时表和 1 个 PROC 重写，超出中等范围"
    adjusted_at: "2026-06-25T14:00"
current_phase: "04"         # "01" ~ "07"
phase_status: "in_progress" # 当前阶段状态：in_progress | completed | blocked

last_updated: "2026-06-19T19:30"

# 本次对话摘要（对话结束/06归档时写入，200字以内；下次对话 Step B 恢复时注入）
last_session_summary: "完成了 Task-1~7：新增 Entity/BLL/Web 三层文件，csproj 注册通过，编译 0 error。待完成 Task-8~9（BLL/Web 追加方法）。关键决策：SaveVitalSignsWithDevice 合并写入，不拆分事务。"

# ★ 当前阶段步骤追踪（强制，每阶段进入时初始化，每步骤完成时更新）
phase_steps:
  - id: "step-0-sql-gen"
    name: "数据库脚本生成"
    status: "completed"       # pending | completed | skipped | not_applicable
    mandatory: true
  - id: "step-0-sql-review"
    name: "脚本审查"
    status: "pending"
    mandatory: true
  - id: "step-0-sql-exec"
    name: "脚本执行"
    status: "pending"
    mandatory: true
  - id: "step-1-task-list"
    name: "任务清单生成"
    status: "pending"
    mandatory: true
# 被跳过的步骤示例：
# - id: "step-0-sql-gen"
#   name: "数据库脚本生成"
#   status: "skipped"
#   mandatory: true
#   skip_reason: "本次无数据库变更"

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

# 阻塞清单（空数组=无阻塞）
blockers: []
# 示例有阻塞时：
# blockers:
#   - id: "B-1"
#     type: "compile_error"
#     desc: "BLL/TriageVitalSignsMgr.cs 第 312 行 using 缺失"
#     created_at: "2026-06-19T20:00"
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

### 3.3 Schema 强制校验规则（★ 写入时必须执行）

> Agent 每次写入 state.yaml 时，必须在写入完成后立即执行以下校验，确保格式合规。

**必填字段检查**：以下字段必须在 state.yaml 中存在：
- `iteration_id` / `iteration_status` / `complexity` / `current_phase` / `phase_status` / `last_updated`

**枚举值校验**：

| 字段 | 允许值 |
|------|--------|
| `iteration_status` | `in_progress` / `completed` |
| `complexity` | `🟢` / `🟡` / `🔴` |
| `current_phase` | `"01"` ~ `"07"`（字符串格式） |
| `phase_status` | `in_progress` / `completed` / `blocked` / `paused` |
| `phase_steps[].status` | `pending` / `completed` / `skipped` / `not_applicable` |

**写入后自检流程**：
1. `write_to_file` 或 `replace_in_file` 写入 state.yaml
2. 立即 `read_file` 重新读取验证字段完整性和枚举值合法性
3. 若校验失败，回退到写入前内容并报告错误

**历史兼容**：已有 `.state.yaml` 不做迁移校验，新写入严格遵守。

### 3.2 阶段回退检查记录（rollback_checks）

> 当发生阶段回退（N→M, N>M）时，Agent 必须按 `workflow-engine.md` 第122-165行的回退检查协议执行，并将确认结果写入此字段。

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
```

### 5.1 生命周期中的阶段回退分支

```
阶段回退（N→M, N>M）
    │
    ├── current_phase 更新为 M，phase_status 设为 "in_progress"
    ├── phase_steps 按 M 阶段的默认步骤清单重新初始化
    ├── 所有步骤 status 设为 "pending"
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

> 强制跳过（paused）时，ACTIVE 也写入 `"none"`。重新打开已完成迭代时，ACTIVE 恢复写入迭代ID。

---

## 六、ACTIVE 指针协议（★ 2026-06-29 新增）

> 参照 Git HEAD / K8s Lease 模式：维护一个「活跃指针」文件，门禁检查从 O(n) 扫描降为 O(1) 读取。
> ACTIVE 指针是门禁检查的第一步，兜底扫描仅作为 ACTIVE 损坏/失同步时的安全保障。

### 6.1 文件格式

```
runtime/ACTIVE
```

单行文本文件，内容为：
- `{ITERATION_ID}` — 当前活跃迭代的完整ID（如 `2026-06-29-007-xxx`）
- `none` — 无活跃迭代

### 6.2 同步规则（4 个同步点）

| 事件 | ACTIVE 操作 | 触发时机 |
|------|-----------|---------|
| 新建迭代 | `echo "{ITERATION_ID}" > ACTIVE` | 01 阶段启动，state.yaml 创建后 |
| 迭代完成 | `echo "none" > ACTIVE` | 07 回顾归档时，state.yaml 重命名后 |
| 强制跳过 | `echo "none" > ACTIVE` | 用户选 3️⃣ 强制跳过，paused 写入后 |
| 重新激活 | `echo "{ITERATION_ID}" > ACTIVE` | 重新打开已完成迭代（回退到 04） |

### 6.3 门禁检查逻辑

```
门禁触发 → 读取 runtime/ACTIVE
  ├── ACTIVE 不存在 或 内容为 "none"
  │   └── 兜底扫描 runtime/*.state.yaml（检查是否有 in_progress 的迭代）
  │       ├── 无 → 确认无活跃迭代
  │       └── 有 → ACTIVE 失同步，修复 ACTIVE 重新进入
  ├── ACTIVE 内容为迭代ID
  │   └── 读取 runtime/{ID}.state.yaml
  │       ├── 不存在 → ACTIVE 损坏，回退扫描
  │       ├── 状态为 completed/paused（ACTIVE 失同步）→ 修复 ACTIVE="none"，回退扫描
  │       └── 状态为 in_progress → 正常门禁
```

### 6.4 容错原则

- **ACTIVE 优先**：门禁第一步读 ACTIVE，不扫描所有文件
- **兜底校验**：ACTIVE 损坏/不存在时回退扫描，作为安全网
- **自我修复**：发现 ACTIVE 与 state.yaml 不一致时，自动修复 ACTIVE 内容

---

## 七、多迭代并行处理

> ⚠️ ACTIVE 指针上线后，多迭代并行场景大幅简化。ACTIVE 只指向一个迭代ID，无需 `active_` 前缀机制。

若 runtime/ 下同时存在多个 `.state.yaml` 文件（历史遗留或 ACTIVE 损坏时）：

1. 优先信任 ACTIVE 指针（单文件），不扫描所有 state.yaml
2. ACTIVE 损坏时，回退按字典序排列，取最后一个 in_progress 的作为活跃迭代
3. 输出概要时列出所有迭代状态，供用户参考

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

```
function gate_check(state):
    for step in state.phase_steps:
        if step.status == "pending" and step.mandatory:
            return BLOCK(step)   // 必须执行此步骤，提示用户
        if step.status == "pending" and not step.mandatory:
            return PROCEED(step) // 可选步骤，提示但不阻塞
    return ALL_CLEAR             // 所有强制步骤已完成，可自由操作
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
