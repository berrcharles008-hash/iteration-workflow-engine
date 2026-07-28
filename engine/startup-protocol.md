# 启动协议

> 从 SKILL.md 提取。定义每次对话加载 Skill 后的初始化流程（Step A-D）。

---

## Step A：加载项目配置（必须第一步）

读取 `project/project.manifest.yaml`，提取所有路径和技术栈信息。

**完成后立即输出运行时变量表**（此输出不可省略）：

```
✅ 运行时变量已加载：
- PROJECT_ROOT    = {workspace_root 的值}
- FRONTEND_ROOT   = {PROJECT_ROOT}/{paths.frontend_root}
- BACKEND_SLN     = {PROJECT_ROOT}/{paths.backend_solution}
- ITERATIONS_DIR  = {PROJECT_ROOT}/{paths.docs_iterations}
- SPECS_DIR       = {PROJECT_ROOT}/{paths.specs_dir}
```

> 后续所有步骤读取 engine/ 或 project/ 文件时，Agent 在内存中将 `{{占位符}}` 替换为以上具体值（变量注入协议详见 `engine/template-injection.md`），**绝不输出占位符字符串本身**。

---

## Step A.5：本地配置文件自检

> 解决首次 clone 后 `project/lessons-learned.md` 和 `project/review-models.json` 缺失的问题。
> 通过引擎自检 → 提示用户 → 从模板自动创建，避免开发者翻阅文档才知道要建什么。
>
> P-045：冷启动门禁微核存在于 `MEMORY.md`（项目文件），Skill 安装到新项目时静默缺失。
> 本步增加第三项自检，覆盖 CodeBuddy IDE 环境下的微核注入。

自检在 Step A 完成之后、Step B 之前执行。

### 检查逻辑

```
目标文件列表：
  1. {PROJECT_ROOT}/.claude/skills/iteration-workflow/project/lessons-learned.md
  2. {PROJECT_ROOT}/.claude/skills/iteration-workflow/project/review-models.json
  3. {PROJECT_ROOT}/.codebuddy/memory/MEMORY.md ← [仅 CodeBuddy IDE]

遍历目标文件：
  ├── 文件存在 → ✅ 跳过，继续下一个
  └── 文件不存在 → 加入"待创建"列表

第 3 项（MEMORY.md）特殊处理：
  └── 先判断环境：.codebuddy/memory/ 目录是否存在？
      ├── 否 → 非 CodeBuddy IDE（Claude Code CLI 等）
      │         → 静默跳过（Hook 层已提供硬拦截）
      └── 是 → CodeBuddy IDE → 执行正常检测
                ├── 文件存在 → 检查是否含微核段（版本标记）
                │   ├── 已含且版本匹配 → ✅ 静默通过
                │   └── 不含或版本过旧 → 加入"待注入"列表
                └── 文件不存在 → 加入"待创建并注入"列表

待创建列表为空？
  ├── 是 → 静默通过，继续 Step B
  └── 否 → 输出提示框，询问用户：
```

### 提示框模板

```
╔══════════════════════════════════════════════════════════════╗
║  检测到以下本地文件尚未创建：                                ║
║                                                              ║
║  ① project/lessons-learned.md                               ║
║     ── 项目级模式库，记录事故复盘经验沉淀                    ║
║  ② project/review-models.json                               ║
║     ── 外部审查模型 API 配置                                 ║
║  ③ .codebuddy/memory/MEMORY.md [CodeBuddy IDE 专属]         ║
║     ── 冷启动门禁微核，保护无 Hook 环境下的代码修改          ║
║                                                              ║
║  是否现在创建默认模板？[Y/n]                                 ║
║  （创建后请根据项目实际调整内容，文件不纳入 Git 跟踪）       ║
║  跳过不阻塞流程，后续可随时手动创建                          ║
╚══════════════════════════════════════════════════════════════╝
```

**微核过期提示**（当 MEMORY.md 已存在但微核版本过旧时）：

```
╔══════════════════════════════════════════════════════════════╗
║  ⚠️  冷启动门禁微核版本过旧                                  ║
║                                                              ║
║  当前版本: {old_version}  模板版本: {new_version}            ║
║  门禁规则可能已更新，建议同步微核段。                        ║
║                                                              ║
║  是否更新微核到最新版本？[Y/n]                               ║
║  （跳过不阻塞流程，但可能缺少最新的门禁保护）                ║
╚══════════════════════════════════════════════════════════════╝
```

### 用户响应处理

**用户确认（Y）**：
1. 检查 `engine/templates/project-lessons-learned.example.md` 是否存在
   - 存在 → 复制到 `project/lessons-learned.md`
   - 不存在 → 提示跳过（引擎模板缺失，需手动创建）
2. 检查 `engine/templates/review-models.example.json` 是否存在
   - 存在 → 复制到 `project/review-models.json`
   - 不存在 → 提示跳过（引擎模板缺失，需手动创建）
3. **[P-045 新增]** 检查 `engine/templates/cold-start-gate-nucleus.md` 是否存在
   - 仅当环境为 CodeBuddy IDE 时执行
   - MEMORY.md 不存在 → 创建 MEMORY.md 并写入微核模板内容
   - MEMORY.md 存在但无微核 → 追加微核段到文件顶部（保留原有内容）
   - 微核版本过旧 → 替换旧版微核段（保留其他内容不变）
   - 模板不存在 → 提示"引擎模板缺失，请运行 setup-gate.py 手动注入"
4. 输出结果摘要：
   ```
   ✅ project/lessons-learned.md 已创建
   ✅ project/review-models.json 已创建
   ✅ .codebuddy/memory/MEMORY.md 冷启动微核已注入
   ⚠ 请根据项目实际编辑内容后使用
   ```
5. 继续 Step B

**用户拒绝（N）**：
- 跳过自检，继续 Step B
- **下次 Skill 加载仍会检测缺失文件**（不设永久跳过标记）

### 与 Step A 的关系

| 步骤 | 用途 | 触发条件 |
|:----:|------|---------|
| Step A | 加载项目配置 | 每次 Skill 加载 |
| **Step A.5** | **创建缺失的本地文件** | **文件不存在时（初次使用）** |
| Step B | 恢复迭代状态 | 每次 Skill 加载 |

> Step A.5 是**自检向导**，不是门禁。用户拒绝后不阻塞流程，后续仍可手动创建。
> 第 3 项（冷启动微核）也可通过 `python scripts/setup-gate.py` 独立执行。

---

## Step B：恢复或新建迭代状态

检查 `runtime/` 目录：

### B.1 存在 `.state.yaml` 文件

→ 读取最新文件（按字典序最后一个，忽略 `.archived.yaml`）
→ 按 `engine/state-protocol.md` 第四节格式输出恢复摘要
→ ★ 执行迭代门禁检查（强制，不可跳过）：

```
├── 若当前迭代 iteration_status = "abandoned" → 同 completed 跳过 Step C（不阻塞），提示：
│       ⚠️ 迭代「{ITERATION_ID}」已废弃（{abandon_reason}），不阻塞新迭代创建。
│       如需重启此需求请创建新迭代。
├── 若当前迭代 iteration_status ≠ "completed" 且 iteration_status ≠ "abandoned" 且用户请求包含「新迭代/新开迭代/下一个迭代/开始新需求/计入新的迭代」→ 触发门禁 BLOCK
│   按 [迭代门禁协议](workflow-engine.md#迭代门禁协议) 输出选项：
│   1️⃣ 继续当前迭代  2️⃣ 归档当前迭代  3️⃣ 强制跳过（需说明理由）
│   等待用户选择，不得自作主张跳进新迭代
├── 若当前迭代 iteration_status = "completed" 或用户请求与开新迭代无关
│   → 跳过 Step C，正常响应用户操作
└── 若阶段状态为 paused（曾被强制跳过）→ 提示恢复
```

### B.2 不存在 `.state.yaml` 文件

→ 继续 Step C

### B.3：ACTIVE 双副本一致性校验（★ 强制）

> 解决问题：`.claude/` 和 `.codebuddy/` 双目录下的 ACTIVE 可能因 sync 延迟或手动操作而不同步。

**校验逻辑**（不阻塞流程，仅输出警告）：

```
1. 读取 .claude/skills/iteration-workflow/runtime/ACTIVE
2. 读取 .codebuddy/skills/iteration-workflow/runtime/ACTIVE
3. 双文件都存在：
   ├── 内容一致 → 静默通过
   └── 内容不一致 → 输出警告，以 .codebuddy 为准
4. 仅 .codebuddy 存在：
   └── 同步到 .claude 端
5. 仅 .claude 存在：
   └── 同步到 .codebuddy 端
6. 双文件都不存在（首次使用）：
   └── 静默通过，等 01 阶段启动时创建
```

**不一致警告格式**：
```
⚠️ ACTIVE 指针双副本不一致：
  .claude/runtime/ACTIVE     → {内容}
  .codebuddy/runtime/ACTIVE  → {内容}
  已以 .codebuddy 为准，请检查 sync 脚本是否正常运行。
```

> **变更记录（2026-07-23 S4.1）**：新增 Step B.3 ACTIVE 双副本一致性校验，不阻塞流程。

---

## Step C：复杂度评估（新迭代时执行）

读取 `engine/complexity-scoring.md`，按 11 因素评分算法评估当前需求，输出：
- 评分详情（每个因素得分）
- 最终等级（🟢/🟡/🔴）
- 对应执行深度说明

等待用户确认等级后继续。

---

## Step D：进入对应阶段

按照 `engine/workflow-engine.md` 执行用户指令对应的阶段。

---

---

## 模板解析优先级（★ 强制）

> 本规则是模板路径的**唯一权威来源**——各 phase 文件只引用模板文件名（如 `phase-01-需求记录.md`），不指定目录前缀。实际路径由本规则按下面的优先级 + 映射表解析。新增/重命名模板时，必须同步更新下方映射表和 `engine/templates/` 目录。

### "同名"定义

文件名完整一致，**不区分大小写**。例如 `phase-01-需求记录.md` 与 `Phase-01-需求记录.md` 视为同一文件。

> **跨平台兼容**：Agent 在检查 `project/templates/` 下是否存在模板时，**必须先用 `list_files` 列出目录内容**，然后做不区分大小写的文件名比对——不能仅依赖 `read_file` 的报错来判断。Windows（NTFS）大小写不敏感，Linux/macOS 大小写敏感，直接 `read_file` 在不同 OS 下行为不一致。

### 模板文件名映射表（★ 唯一来源，集中维护）

| 阶段 | 标准模板 | Lite 版 | Bug 专用 | phase 文件引用 |
|:--:|---------|:--:|:--:|:--:|
| 01 | `phase-01-需求记录.md` | `phase-01-需求文档-lite.md` | `bug-requirement-template.md` | phase-01.md |
| 02 | `phase-02-需求评审.md` | — | — | phase-02.md |
| 03 | `phase-03-技术方案.md` | — | — | phase-03.md |
| 04 | `phase-04-开发任务清单.md` | — | — | phase-04.md |
| 05 | `phase-05-测试验证报告.md` | `phase-05-测试报告-lite.md` | — | phase-05.md |
| 06 | `phase-06-发布上线记录.md` | `phase-06-上线记录-lite.md` | — | phase-06.md |
| 07 | `phase-07-迭代回顾报告.md` | `phase-07-迭代回顾-lite.md` | — | phase-07.md |

> **注意**：`bug-requirement-template.md` 不以 `phase-0X-` 开头，但同样适用以下所有优先级规则。映射表是模板文件名的唯一权威来源——新增/重命名模板必须同步更新此表。

### 解析优先级

```
1. project/templates/{模板文件名}  ← 项目自定义（最高优先级）
2. engine/templates/{模板文件名}   ← 引擎默认（兜底）
```

### Few-Shot 执行示例（★ Agent 模板加载时强制遵循）

以下是 Agent 加载阶段模板时的**标准工具调用序列**。**所有场景均先 `list_files` 获取目录清单，再做不区分大小写匹配——不直接 `read_file` 拼接路径**。模板文件名（如 `phase-01-需求记录.md`）从映射表获取，**禁止自行拼接 `engine/templates/` 或 `project/templates/` 前缀**。

**场景 A：正常覆盖（project 模板存在且有效）**

```
Step 1：列出 project/templates/ 目录，获取文件清单
  list_files("project/templates/")

Step 2：在文件清单中不区分大小写匹配目标模板文件名（如 "phase-01-需求记录.md"）
  → 匹配到 → 从清单中取实际文件名，读取 project 模板
  read_file("project/templates/" + 实际文件名)

Step 3：验证模板有效性（★ 强制）
  IF content 为 null / 空字符串 / 仅含空白字符:
    → 视为无效，跳转到 Step 4（fallback 到 engine）
  IF content 不含任何二级标题（##）:
    → 视为可能损坏，输出警告但继续使用（不阻塞）
  ELSE:
    → 模板有效，使用 project 模板，跳过 Step 4
```

**场景 B：fallback（project 模板不存在或无效）**

```
Step 3（续）：project 模板无效
  → 输出："project/templates/{文件名} 不存在或为空，回退到引擎默认模板"

Step 4：fallback 到 engine 默认模板（同样先 list_files，不直接拼路径）
  list_files("engine/templates/")
  → 在文件清单中不区分大小写匹配目标模板文件名
  → 从清单中取实际文件名，读取 engine 模板
  read_file("engine/templates/" + 实际文件名)
  → 使用 engine 默认模板
```

**场景 C：Bug 需求模板（特殊命名）**

```
目标模板：bug-requirement-template.md（从映射表获取）
  Step 1：list_files("project/templates/") 做不区分大小写匹配
    匹配到 → 验证有效性 → 有效则使用 project 版本
    不存在/无效 → 进入 Step 2
  Step 2：list_files("engine/templates/") 做不区分大小写匹配
    → 使用 engine 版本（engine 模板必然存在，否则为配置错误）
```

**场景 D：Lite 模板（复杂度选择）**

```
Agent 根据复杂度选择了 Lite 模板（文件名从映射表获取，如 "phase-05-测试报告-lite.md"）：
  Step 1：list_files("project/templates/") 做不区分大小写匹配
    匹配到 → 验证有效性（同场景A Step 3） → 有效则使用 project 版本
    不存在/无效 → 输出提示 → 进入 Step 2
  Step 2：list_files("engine/templates/") 做不区分大小写匹配
    → 使用 engine 版本（engine 模板必然存在，否则为配置错误）
```

### 模板有效性规则（★ 防止空模板静默失败）

| 检查项 | 判定 | 动作 |
|--------|:--:|------|
| 文件不在 list 清单中（含大小写差异完全不匹配） | 不存在 | → fallback 到 engine |
| 文件存在但内容为空（read_file 返回空字符串） | 无效 | → fallback 到 engine |
| 文件存在但仅含空白字符 | 无效 | → fallback 到 engine |
| 文件存在、内容非空但不含任何 `## ` 标题 | 可能损坏 | → ⚠️ 输出警告，继续使用（不阻塞） |
| 文件存在、内容非空且含至少一个 `## ` 标题 | 有效 | → ✅ 使用 |

### 禁止事项

- **禁止**在任何 phase 文件（phase-01~07.md）中直接使用 `engine/templates/` 或 `project/templates/` 前缀——只能引用模板文件名本身
- **禁止**仅用 `read_file` 判断模板是否存在（跨平台大小写风险）——无论 project 还是 engine，都必须先 `list_files` 做不区分大小写比对，再从清单中取实际文件名拼接路径
- **禁止**在 project 模板不存在或无效时跳过 fallback——必须加载 engine 默认模板

> **变更记录**：
> - 2026-07-23 S3.2：新增模板覆盖优先级规则
> - 2026-07-24 S6（方案 D'）：增强 Few-Shot 示例 + 映射表 + "同名"定义 + 不区分大小写匹配 + 空模板健壮性 + SKILL.md/phase 文件解耦
> - 2026-07-24 S6.1（方案 D''）：修复 D' 双审发现的 3 个 🔴——Few-Shot 全部场景统一先 list_files 后 read_file + 禁止事项对称覆盖 project/engine + phase-03/04 补全模板引用行

---

## 引擎与配置文件索引

> 以下为 Skill 全部资源文件清单。启动加载遵循"最小核心"原则：
> 核心必读仅 4 个文件，其余全部惰性加载（按需读取）。

### 核心必读（启动时加载，4 个）

| 文件 | 用途 | 读取时机 |
|------|------|---------|
| `project/project.manifest.yaml` | 项目路径和技术栈 | Step A（变量注入基础） |
| `runtime/ACTIVE` | 活跃迭代指针 | Step B（状态恢复） |
| `SKILL.md` | Skill 入口：路由表 + 门禁摘要 + 命令分级 | 每次 Skill 加载 |
| `engine/startup-protocol.md` | 启动流程框架（Step A→D） | 每次 Skill 加载（含本索引） |

### 惰性加载（按触发条件读取）

| 文件 | 用途 | 触发条件 |
|------|------|---------|
| `engine/template-injection.md` | 变量注入协议 | 创建文档时（需注入 `{{占位符}}`） |
| `engine/templates/project-lessons-learned.example.md` | 项目级模式库模板 | Step A.5（文件不存在时） |
| `engine/templates/review-models.example.json` | 外部审查模型配置模板 | Step A.5（文件不存在时） |
| `engine/state-protocol.md` | 状态读写规则 | 写入/校验 `runtime/*.state.yaml` 时 |
| `engine/complexity-scoring.md` | 复杂度评估算法（11 因素评分） | Step C（新迭代创建时） |
| `engine/workflow-engine.md` | 七阶段流程入口 + 横向规则 | Step D（进入具体阶段时） |
| `engine/phase-01.md` ~ `phase-07.md` | 各阶段详细定义 | 进入对应阶段时读取 |
| `project/context-conventions.md` | 项目上下文约定（spec 清单 + 后端类型约定） | 01 阶段读取 specs 或 04 阶段编码时 |
| `project/deploy-config.yaml` | 部署配置 | 06 阶段 |
| `project/build-verify.yaml` | 构建验证命令 | 04 阶段 Step 4.6 或 05 阶段 Step 0 |
| `project/agent-prompt-examples.md` | Agent prompt 示例 | 04 阶段 Team Agent 派发前 |
| `engine/startup-protocol-step-e.md` | 每日工作日志写入 | 对话结束前 |
| `engine/gate-protocol.md` | 修改门禁协议 + 影响等级 + 回滚方案模板 | SKILL.md 门禁摘要（已摘要，按需深入） |
| `engine/naming-conflict-check.md` | 命名冲突预检规则 | 03 方案输出前（自主审查 L1） |
| `engine/delta-marking.md` | 代码改动 Delta 标记体系 | 03 阶段（标注 ADDED/MODIFIED） |
| `engine/team-agent-strategy.md` | Team Agent 四维并行决策算法 | 04 阶段 Team 编码时 |
| `engine/lessons-learned.md` | 事故案例库 + 自动复盘机制 | 07 阶段回顾 或 发生事故时 |
| `project/coding-conventions.md` | 项目编码规范（L5 层级） | 04 阶段编码 + 代码审查时 |
| `project/code-review-rules.md` | 代码审查规则矩阵 | 04 阶段 Step 5（代码审查时） |
| 阶段文档模板（`engine/templates/` 或 `project/templates/`） | 模板文件，优先级见 §模板解析优先级 | 各阶段产出文档时 |
