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
| step-6-spec | Spec 合规验证 | ✅ | 🔴复杂级 + 有 ADDED 文件 |
| step-7-code-review | 代码审查 | ✅ | 始终 |

> ⚠️ **步骤序号 ≠ 执行顺序**：step-1-5x 排在 step-1-5 之后仅为编号有序。实际执行时互审与自审**同时启动**（见 Step 1.5x 并行约定）。
>
> 进入阶段时，Agent 根据实际触发条件选择性写入 phase_steps（如无 SQL 变更则 step-0-* 设为 `not_applicable`）。

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

> **模板已升级为三列格式**（编号/类型/文件路径/代码片段/验证步骤/状态）。每个任务编号格式 `T{阶段序号}-{任务序号}`，类型取值 `ADDED`/`MODIFIED`/`DELETED`/`同步`，状态列 `⬜` 开始 → `✅` 完成。代码片段仅写关键签名或伪代码，禁止粘贴完整实现。

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

**交付标准**：用户明确表示"任务清单通过" / "确认" / "开始编码"。

**禁止行为**：
- ❌ Agent 在用户未确认的情况下直接创建 Team 并派发任务
- ❌ 自动审查完成后就跳到 step-3-team-code
- ❌ 将 step-1-5-review 的输出等同于用户确认

> 事故案例：2026-07-01-007 迭代中，step-1-5-review 完成后 Agent 直接创建 Team 进行代码派发，
> 跳过了用户对任务清单的人为评审环节，导致用户无法在编码前审查任务拆分的合理性。

### Step 2：创建 Team 并派发任务

> 派发前读取 `project/agent-prompt-examples.md`，按模板组装 Agent prompt。
> 并行决策算法见 `engine/team-agent-strategy.md`。
> ★ Team Agent 仅生成代码不写入文件，写入由主 Agent 统一执行。

1. 根据任务依赖图，按分组批量 task 派发 Team Agent
2. 每个 Team Agent 完成代码生成后，输出代码内容（不调用 write_file/replace_in_file）
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
| ⚠️ warning | 记录但不阻塞 |

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
```

**交付标准**：所有任务 ✅ 完成，无 🔴 阻塞级审查问题，用户确认"开发完成"
