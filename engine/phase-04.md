# 阶段四：04-开发实现（★ Team Agent 模式）

**目标**：按照技术方案完成全部代码编写。

**执行方式**：Team Agent 模式（详见 `engine/team-agent-strategy.md`）。

### 步骤清单（进入阶段时写入 phase_steps）

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
| step-5-6-complexity-actual | 复杂度实际值回填（Step 5.6，仅记录不改等级） | ✅ | 始终（🟢 可简写） |
| step-6-spec | Spec 合规验证 | ✅ | 🔴复杂级 + 有 ADDED 文件 |
| step-7-code-review | 代码审查 | ✅ | 始终 |
| step-fix-1-register | 缺陷登记（写入 `defects[]` + 与 05 报告对账） | — | 存在 `open` 缺陷且 `design_changed=false` |
| step-fix-2-code | 缺陷修复编码（含 csproj 注册） | — | step-fix-1-register 完成 |
| step-fix-3-build | 缺陷修复构建验证（涉后端码必须 `/t:Rebuild`） | — | step-fix-2-code 完成 |
| step-fix-4-regress | 失败用例回归（含动作链用例） | — | step-fix-3-build 完成 |
| step-fix-5-reclose | 缺陷关闭（置 `fixed`）并回 05 | — | step-fix-4-regress 通过 |

> **step-7-code-review 产出**：`04-代码审查报告.md`（可并入 `04-开发任务清单.md` 附录；标准命名见 `workflow-engine.md` §标准文件命名）。

> ⚠️ **步骤序号 ≠ 执行顺序**：step-1-5x 排在 step-1-5 之后仅为编号有序。实际执行时互审与自审**同时启动**（见 Step 1.5x 并行约定）。
>
> 进入阶段时，Agent 根据实际触发条件选择性写入 phase_steps（如无 SQL 变更则 step-0-* 设为 `not_applicable`）。
>
> ★ **缺陷修复窗口（2026-09-23 DEFECT-1 新增）**：`step-fix-*` 五步**挂本阶段**（04 是唯一免开闸的合法落盘窗口），仅在「存在 `open` 缺陷且 `design_changed=false`」时写入；收口后回 05，既有用例结果保留（`state-protocol.md` §5.3）。**禁止**自造游离步骤块。

### Step 0：数据库脚本生成与执行（涉 DML/DDL 变更时强制）

> 凡 03-技术方案 中有数据库表/数据变更（INSERT/UPDATE/DELETE/ALTER/CREATE），必须执行此步骤。

#### Step 0.1：生成 SQL 脚本文件

> 详细规则见 `project/build-verify.yaml` → `sql_generation`。

从 `project/build-verify.yaml` → `sql_generation` 读取：
- 存放路径：`sql_generation.output_dir`
- 命名格式：`sql_generation.file_naming`
- DML 包裹语法：`sql_generation.dml_wrapper.{{database.type}}`
- 文件头模板：`sql_generation.header_template`
- 可重复执行策略：`sql_generation.idempotency`
- 注释规范：`sql_generation.comment_style`

#### Step 0.2：脚本审查（★ 强制，纳入 Step 5 审查范围）

> 详细规则见 `project/build-verify.yaml` → `sql_review`。

从 `project/build-verify.yaml` → `sql_review` 读取检查清单，逐条执行。

#### Step 0.3：通过对应 MCP 执行（编码阶段开始时）

> 详细规则见 `project/build-verify.yaml` → `sql_execution`。

在 Step 1 任务清单审核通过、进入真实编码阶段后：

1. **读取脚本头"目标库"声明**
2. **按映射表选择 MCP**：从 `project/build-verify.yaml` → `sql_execution.mcp_mapping` 查找对应 MCP 服务器
3. **按编号顺序执行** `sql/` 目录下所有脚本
4. **验证执行结果**：按 `sql_execution.verify_method` 验证
5. **脚本执行成功后才开始后续编码任务**

> 若脚本目标库无对应 MCP → 暂停执行，提示用户补充 MCP 配置。
> 脚本头缺少目标库声明 → 审查不通过，退回 Step 0.2 补全。

---

### Step 1：创建开发任务清单

在 `04-开发实现/{{DOC_04_TASK_LIST}}` 自动生成任务表格（模板：`phase-04-开发任务清单.md`，优先级见启动协议 §模板解析优先级），按依赖关系排序（SQL脚本→Net→BLL→Domain→Page→Route）。

> **表格列固定 4 列**（编号/类型/文件/状态）；关键签名与验证证据写在下方的"条目块"（见模板 §1.1 示例），禁止塞进表格单元格。每个任务编号格式 `T{阶段序号}-{任务序号}`，类型取值 `ADDED`/`MODIFIED`/`DELETED`/`同步`，状态列 `⬜` 开始 → `✅` 完成。代码片段仅写关键签名或伪代码，禁止粘贴完整实现。
>
> **版式纪律**：产出文档须遵循 `engine/doc-style-guide.md`；生成后自检 `python scripts/doc_lint.py <文件>`（ERROR 必修）。

### Step 1.5：任务清单审查（★ 强制，不可跳过）

逐项对照 `03-技术方案/{{DOC_03_TECHNICAL}}`：

| 检查项 | 说明 |
|--------|------|
| 任务完整性 | 方案中所有改动文件是否都有对应任务 |
| 路径一致性 | 文件路径、类名、方法名是否与方案一致 |
| **★ 关键约束一致性（强制）** | **ADDED 类型任务**：必须核对任务描述中的**命名空间**、**继承关系**、**目录位置**是否与方案完全一致。**禁止"参照XXX模式"模糊描述，必须显式写出继承类和命名空间**。具体约定见 `project/context-conventions.md` → 二、后端类型约定 |
| 命名冲突 | MODIFIED-追加类型任务，搜索目标文件是否已存在同名方法 |
| 依赖关系 | 任务依赖图是否与方案阶段划分一致 |

审查后必须输出：**"已对照技术方案审查，共 N 项，无遗漏"** 或 **"发现遗漏 X 项，已补全"**。

方案变更时任务清单必须联动更新并重新执行审查（强制联动）。

### Step 1.5x：独立 Agent 交叉审查（★ 强制，🟡🔴）

> 主 Agent 启动独立 Agent 进行交叉审查（与自审同时启动）。

**审查内容**：逐项对照技术方案，检查任务完整性、路径一致性、关键约束一致性、命名冲突、依赖关系（与 Step 1.5 相同维度，独立执行）。

**执行流程**：
1. 主 Agent 启动独立 Agent，传入审查指令模板（详见 `engine/cross-review-protocol.md` §4.2）
   - 运行时将 `{{任务清单路径}}` / `{{技术方案路径}}` 替换为对应绝对路径
   - `{{PROJECT_ROOT}}` 替换为项目根目录绝对路径
2. 独立 Agent 读取任务清单 + 技术方案 → 输出分级审查报告（🔴致命/🟡严重/🔵轻微/💡建议）
   - ★ **派发前先组装锚点包**（待验文件/符号 → 绝对路径 → 行号，来源 = 本清单 + 03 改动范围表），并按模块/维度分片（🟡2 路×≤30 次 / 🔴2~4 路×≤40 次工具调用，口径以协议 §二-B 为准）；**审查对象仍是清单全文**，锚点包约束的是"主动探索范围"（禁止无目标全库 `rglob`）。详见 `engine/cross-review-protocol.md` §二-B / §三-A / §六
3. 主 Agent 按合并规则处理（🔴🟡→必须修复，🔵→可选，💡→记录）

**并行约定**：独立 Agent 与主 Agent 自审**同时启动**（主 Agent 先 `task` 派发独立 Agent，再立即执行自身自审），互不阻塞。⚠️ 步骤清单中的序号不代表执行顺序。

**适用复杂度**：🟡🔴（🟢 跳过）。

审查后必须输出：**"独立Agent交叉审查完成：共 N 项，🔴X 🟡Y 🔵Z 💡W（除误报外已全部处理）"**。

### Step 1.6：用户确认任务清单（★ 强制，不可跳过）

> **这是 04 阶段最后一个审查节点。通过后进入编码，不可逆。**

Agent 必须在 step-1-5-review 完成后，输出以下信息并等待用户确认：

1. 任务清单摘要（任务总数 N、后端 M 项、前端 K 项、验证 X 项）
2. 依赖关系确认（并行组是否合理）
3. ★ 如有 ADDED 类型任务，确认命名空间和继承关系

```
📋 任务清单审查完成，共 {N} 项任务：
- 后端：{M} 项（T1→T...）
- 前端：{K} 项（T...→T...）
- 验证：{X} 项（T...→T...）
依赖关系已确认无误。

请确认任务清单是否通过？确认后将进入 Team 编码阶段（不可逆）。
```

**交付标准**：用户明确表示"任务清单通过" / "确认" / "开始编码"；**清单版式自检 ERROR 0**（`python scripts/doc_lint.py <清单>`，含 `## 目录` / 相对链接 / Mermaid）。

**禁止行为**：
- ❌ Agent 在用户未确认的情况下直接创建 Team 并派发任务
- ❌ 自动审查完成后就跳到 step-3-team-code
- ❌ 将 step-1-5-review 的输出等同于用户确认

> 事故案例：2026-07-01-007 迭代中，step-1-5-review 完成后 Agent 直接创建 Team 进行代码派发，
> 跳过了用户对任务清单的人为评审环节，导致用户无法在编码前审查任务拆分的合理性。

### Step 2：创建 Team 并派发任务

**Step 2.0（★ 2026-09-24 新增，派发前执行）：挂载崩溃监控采样器**

> 崩溃**根因仍未定性**——平台抓的 cpu profile 存在 `%TEMP%\codebuddy-starvat*`，
> 会被系统清理，事后补查不到。只有编码期间挂着采样器，才可能拿到成因证据。

```powershell
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File','tools\eh-monitor.ps1','-DurationMin','180')
```

- 产物（`.codebuddy/temp/eh-monitor/`）：`samples-<ts>.csv` 进程 CPU/内存曲线、
  `events-<ts>.log` 结构化事件（HostStarvation / EH 冷启动 / hook 超时 / RSS）、
  `profiles/` 自动抢救的 cpu profile
- 提前停止：`New-Item .codebuddy/temp/eh-monitor/.stop -Force`（脚本启动时会清残留标记）
- **已实测**（2026-09-24 16:07）：该启动命令**不被门禁拦截**；
  采样显示常驻 40 个 CodeBuddy 进程、合计 **8.5GB** —— 系统级内存压力背景
- 崩溃发生后：把 `profiles/` 与 `events-*.log` 交给分析方，并回写 `project/lessons-learned.md`

> 派发前读取 `project/agent-prompt-examples.md`，按模板组装 Agent prompt。
> 并行决策算法见 `engine/team-agent-strategy.md`。
> ★ Team Agent 仅生成**业务代码**不写入业务文件，写入由主 Agent 统一执行。
> ★ **崩溃防护强制**（宿主终止会导致成员与回传产出一并丢失）：
>   同批并行 ≤3、单成员上下文 ≤15 万 token、每个成员 prompt 必含【产出落盘】段
>   （`engine/team-agent-strategy.md` §二维度五 / §七）；宿主终止后走 §八 崩溃恢复协议。

1. 根据任务依赖图，按分组批量 task 派发 Team Agent（同批 ≤3）
2. 每个 Team Agent 每完成一个文件，**先增量落盘**到 `.codebuddy/temp/team-out/<成员名>.md`，
   再输出代码内容（不调用 write_file/replace_in_file 写业务文件）
3. 主 Agent 收集所有 Agent 输出，生成统一变更预览

### Step 2.5：批量变更预览与确认（★ 强制）

> 所有 Team Agent 完成后，在写入任何文件之前执行。

主 Agent 输出统一变更预览：

```
📦 变更预览 — 共 {N} 个文件：

| 文件 | 操作 | 行数 | 说明 |
|------|:---:|:---:|------|
| back-end/.../Entity.cs | 新建 | +45 | 新增 XxxEntity |
| back-end/.../BLL.cs | 追加 | +32 | 新增 GetXxx 方法 |
| front-end/src/pages/foo.vue | 替换 | ±18 | 修改表单提交逻辑 |
```

**交付标准**：用户明确确认后，主 Agent 批量写入所有文件（此后的完整性校验/编译验证等继续按现有流程执行）。

> ★ **主 Agent 批量写入必须原子写**（2026-09-24 新增）
>
> **起因**：宿主可能在写入过程中异常终止，半截文件会被后续编译/校验当作"已完成"而漏改，
> 且崩溃恢复时无法判定完整性。
>
> **写法**（逐个文件）：`写入 <目标>.tmp` → `Move-Item <目标>.tmp <目标> -Force`，
> 全部完成后核对无 `.tmp` 残留。
>
> **实测**（2026-09-24）：`.codebuddy/temp/**` 与业务目录（`tools/`）下的
> `Move-Item` / `Copy-Item` / `Remove-Item *.tmp|*.bak` **均未被门禁拦截**，可直接用。

### Step 3：Agent 完成后更新清单

每个 Agent 完成后，立即更新 `开发任务清单.md` 对应任务的状态列：`⬜`（未开始）→ `✅`（已完成）。
**同时按 `engine/state-protocol.md` 更新 `runtime/` 状态文件。**

### Step 4：完整性校验

- 检查所有文件是否存在于指定路径
- 检查 import/using 引用是否正确
- 运行 `read_lints` 检查语法错误

### Step 4.5：后端编译单元注册（★ 强制）

> 注册规则见 `project.manifest.yaml` → `compilation_units`。

执行后输出：**"编译单元注册完成：{按实际层数输出}"**

### Step 4.6：后端构建验证（★ 强制）

> 编译命令见 `project/build-verify.yaml` → `backend.build_command`。

| 结果 | 处理 |
|------|------|
| ✅ 通过 | 继续进入 Step 5 |
| ❌ 有 error | 停止，修复后重试（最多 3 次） |
| ⚠️ warning | 记录但不阻塞；★ 但**项目若在 `build-verify.yaml` 配置了额外通过判据**（`success_criteria` 或专用判据段），**以项目判据为准**（项目判据可将某类 warning 升格为阻塞） |

输出：**"后端构建验证：{success_criteria} — 通过 ✅"**

### Step 4.7：Spec 合规验证（★ 强制，🔴复杂级 + 有 ADDED 文件时）

> 阻止"任务清单描述正确但代码写错"类问题。Step 4.6 编译通过 ≠ 代码符合 Spec。

**触发条件**：迭代为 🔴 复杂级，且任务清单中有 ADDED 类型文件。

| 检查项 | 验证方式 |
|--------|---------|
| **命名空间** | `read_file` 读取实际文件，检查 `namespace` 声明是否与 Spec 标注一致 |
| **继承关系** | 检查 `class Xxx : BaseClass` 是否与 Spec 一致（基类约定见 `project/context-conventions.md` → 二、后端类型约定） |
| **目录位置** | 检查文件所在物理目录是否与 Spec 路径一致 |
| **类名后缀** | 类名后缀规则见 `project/context-conventions.md` → 二、后端类型约定（2.2 类名后缀约定） |

**执行**：从 Spec 的「代码改动范围」表格提取 ADDED 文件，逐一打开实际文件比对。比对失败 → ❌ 阻塞，修正后重跑 Step 4.6 + Step 4.7。

输出：**"Spec 合规验证：N 项全部一致 ✅"** 或 **"发现 M 项不一致，已修正 → 重跑编译"**。

### Step 5：自动代码审查

> 详细规则见 `project/code-review-rules.md`

```
Step 5.1: 读取开发任务清单 → 提取变更文件 + 操作类型
Step 5.2: 按目录匹配规则矩阵触发条件，未改动层跳过
Step 5.3: 根据复杂度等级确定规则激活/跳过
Step 5.4: 逐条执行规则 → 记录通过/建议/问题
Step 5.5: 生成审查报告（🟢并入清单 / 🟡独立简报 / 🔴完整报告）
Step 5.6: 复杂度实际值回填（见下方 ★ Step 5.6，仅记录不改等级）
```

### ★ Step 5.6：复杂度实际值回填（记录，不改变等级）

> **目的**：04 编码完成后，实际改动（文件数 / 是否新增表或接口 / 是否跨模块）已成事实，回填 `complexity_actual` 供 05、06 参考，并为阈值校准积累数据点。

**执行**：对照 04 实际产物重算 9 因素得分，写入 `state.yaml`（字段见 `state-protocol.md`）：

```yaml
complexity_actual: "🟡"          # 实际复算等级
complexity_actual_factors:       # 实际命中因素
  - id: "new_api"
    score: 2
complexity_actual_note: "04 实际新增 4 个文件、1 个接口，与 03 复评一致"
```

**★ 时序约束（如实声明）**：
- 本步骤**不自动修改 `complexity` 等级**，也**无法追溯改变 04 已发生的审查强度**（交叉审查、Spec 合规验证等已按原等级执行完毕）。
- **价值边界**：使 05 / 06 按更贴近实际的强度执行 + 长期可测量校准。
- 若实际值与当前等级差异显著 **且 05 / 06 尚未开始**，Agent **应提示用户**是否调整 `complexity`；用户确认后才写入 `complexity_adjustments`（降级不得跨两级）。

### ★ 知识库刷新：不在 04 阶段执行（显式说明）

> **决策（2026-09-20）**：04 末尾代码**尚未经 05 测试验证**，此时刷新知识库会产出"未验证中间态快照"，
> 且带有新的 `generated_at` 时间戳，外观与"最新"无异 ⇒ **比不刷更具误导性**。
> 05 阶段可能出现新增/删除文件与类（新增 DTO、拆分工具类、补迁移脚本），04 末快照即失效。

**正确刷新点 = 06-发布上线**（代码已通过 05 测试，为最终态），详见 `engine/phase-06.md` §step-2-5-kb-refresh。

**04 阶段唯一动作**：在任务清单收尾时确认 `ADDED`/`DELETED` 项已如实登记（供 06 刷新时对照），**不执行** `gen-knowledge-base.py`。

### ★ Step 5.7：崩溃监控数据回收（2026-09-24 新增；仅当 Step 2.0 挂过采样器时执行）

> **为何必做**：宿主崩溃**根因未定性**，平台抓取的 cpu profile 存于 `%TEMP%\codebuddy-starvat*`
> 且会被系统清理 —— 本轮采样数据是唯一的成因证据来源，编码结束不导出即**证据灭失**。

| 动作 | 命令 / 位置 |
|------|------------|
| 停止采样 | `New-Item .codebuddy/temp/eh-monitor/.stop -Force`（脚本到时亦自动退出） |
| 取回事件日志 | `.codebuddy/temp/eh-monitor/events-*.log`（HostStarvation / EH 冷启动 / hook 超时 / RSS） |
| 取回资源曲线 | `.codebuddy/temp/eh-monitor/samples-*.csv` |
| 取回 cpu profile | `.codebuddy/temp/eh-monitor/profiles/`（有则交分析方） |
| 记录重派开销 | 本轮曾发生宿主终止时：记录「重派耗时 vs 首次耗时」实测值 |

★ 本轮若发生宿主终止：把 `events-*.log` 关键片段 + 重派开销**实测值**回写
`project/lessons-learned.md`，替换其中的估算口径（避免收益长期停留在估算）。

**交付标准**：所有任务 ✅ 完成，无 🔴 阻塞级审查问题，用户确认"开发完成"；**清单状态列已回填 + 版式自检 ERROR 0**（`python scripts/doc_lint.py <清单>`）

---

### ★ Step F：缺陷修复窗口（2026-09-23 DEFECT-1 新增；按需触发）

> **触发**：05 发现缺陷，且 `defects[]` 该条 `design_changed=false`（L1 实现缺陷 —— 03 技术方案仍成立）。
> **为何挂 04**：04 是唯一**免开闸**的合法落盘窗口（`gate-protocol.md` §一：`current_phase == "04"` ⇒ 写入全放行）；
> 05 阶段 `STAGE_EXEMPT_PATHS['05']` 仅放行 `docs/iterations/`，源码/工程文件写入会被拦。**选项甲已定：不新增放行面。**

**五步（SSOT = `phase-steps.md`）**：

| 步骤 | 动作 | 关键要求 |
|------|------|---------|
| step-fix-1-register | 缺陷登记 | 写入 `defects[]`（`id` / `severity` / `root_cause_level: "L1"` / `design_changed: false`）；★ 与 05 报告「缺陷记录」节按 id 对账 |
| step-fix-2-code | 修复编码 | 含 `.csproj` 的 Compile Include 注册；改动文件须落在 03 方案 / 04 清单**已列范围**内 |
| step-fix-3-build | 构建验证 | 涉后端码必须 `/t:Rebuild`（增量 Build 抓不到 CS1591/CS1573）；命令**禁 `>` / `2>&1` 重定向**（会命中危险段回落门禁） |
| step-fix-4-regress | 回归 | 失败用例 + 其动作链用例；★ 既有用例结果**不回改**，新增用例**续接编号** |
| step-fix-5-reclose | 缺陷关闭 | `defects[].status="fixed"` + `fixed_at` + `verified_by`；回 05 —— 三-C 会拦「仍有 `open` 缺陷时推进 06」 |

**禁止**：① 自造游离步骤块（历史 `phase_steps_04_d1fix`、`step-d18-*` 未被 SSOT 收录 ⇒ 审计看不见）；② 在 05 就地改码（除非用户手动开闸，且须在 `defects[].gate_window` 留痕）；③ L2 / L3 缺陷走本窗口（必须按判据回退 03 / 01）。
