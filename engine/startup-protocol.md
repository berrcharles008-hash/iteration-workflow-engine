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

自检在 Step A 完成之后、Step B 之前执行。

### 检查逻辑

```
目标文件列表：
  1. {PROJECT_ROOT}/.claude/skills/iteration-workflow/project/lessons-learned.md
  2. {PROJECT_ROOT}/.claude/skills/iteration-workflow/project/review-models.json

遍历目标文件：
  ├── 文件存在 → ✅ 跳过，继续下一个
  └── 文件不存在 → 加入"待创建"列表

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
║                                                              ║
║  是否现在创建默认模板？[Y/n]                                 ║
║  （创建后请根据项目实际调整内容，文件不纳入 Git 跟踪）       ║
║  跳过不阻塞流程，后续可随时手动创建                          ║
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
3. 输出结果摘要：
   ```
   ✅ project/lessons-learned.md 已创建
   ✅ project/review-models.json 已创建
   ⚠ 请根据项目实际编辑内容后使用
   ```
4. 继续 Step B

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

---

## Step B：恢复或新建迭代状态

检查 `runtime/` 目录：

### B.1 存在 `.state.yaml` 文件

→ 读取最新文件（按字典序最后一个，忽略 `.archived.yaml`）
→ 按 `engine/state-protocol.md` 第四节格式输出恢复摘要
→ ★ 执行迭代门禁检查（强制，不可跳过）：

```
├── 若当前迭代 iteration_status ≠ "completed" 且用户请求包含「新迭代/新开迭代/下一个迭代/开始新需求/计入新的迭代」→ 触发门禁 BLOCK
│   按 [迭代门禁协议](workflow-engine.md#迭代门禁协议) 输出选项：
│   1️⃣ 继续当前迭代  2️⃣ 归档当前迭代  3️⃣ 强制跳过（需说明理由）
│   等待用户选择，不得自作主张跳进新迭代
├── 若当前迭代 iteration_status = "completed" 或用户请求与开新迭代无关
│   → 跳过 Step C，正常响应用户操作
└── 若阶段状态为 paused（曾被强制跳过）→ 提示恢复
```

### B.2 不存在 `.state.yaml` 文件

→ 继续 Step C

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

## 引擎与配置文件索引

> 以下为 Skill 全部资源文件清单。**启动必读**列标注 Step 的文件在启动时读取；
> 标注"按需"的文件由其他文件引用，Agent 按引用关系读取。

### 启动必读（Step A-E 读取）

| 文件 | 用途 | 读取时机 |
|------|------|---------|
| `project/project.manifest.yaml` | 项目路径和技术栈 | Step A（每次必读） |
| `engine/template-injection.md` | 变量注入协议 | Step A 完成后（注入 {{占位符}}） |
| `engine/templates/project-lessons-learned.example.md` | 项目级模式库模板 | Step A.5（文件不存在时读取） |
| `engine/templates/review-models.example.json` | 外部审查模型配置模板 | Step A.5（文件不存在时读取） |
| `engine/state-protocol.md` | 状态读写规则 | Step B + 每个任务完成后 |
| `engine/complexity-scoring.md` | 复杂度评估算法 | Step C（新迭代）|
| `engine/workflow-engine.md` | 七阶段流程详细定义 | Step D（进入阶段时读取）|
| `project/context-conventions.md` | 项目上下文约定（spec 文件清单 + 后端类型约定） | Step A 后（01/04 阶段引用） |
| `project/deploy-config.yaml` | 部署配置 | 06 阶段 |
| `project/build-verify.yaml` | 构建验证命令 | 04 阶段 Step 4.6 |
| `project/agent-prompt-examples.md` | Agent prompt 示例 | 04 阶段派发前 |
| `engine/startup-protocol-step-e.md` | 每日工作日志写入 | 每次对话结束前 |

### 按需读取（由其他文件引用）

| 文件 | 用途 | 引用来源 |
|------|------|---------|
| `engine/gate-protocol.md` | 修改门禁协议 + 影响等级 + 回滚方案模板 | SKILL.md 门禁摘要 |
| `engine/naming-conflict-check.md` | 命名冲突预检规则 | coding-conventions.md 5.1 + workflow-engine.md |
| `engine/delta-marking.md` | 代码改动 Delta 标记体系 | workflow-engine.md 03 阶段 |
| `engine/team-agent-strategy.md` | Team Agent 四维并行决策算法 | workflow-engine.md 04 阶段 |
| `engine/lessons-learned.md` | 事故案例库 + 自动复盘机制 | SKILL.md 原则 #10 + 06 阶段归档 |
| `project/coding-conventions.md` | 项目编码规范（L5 层级） | SKILL.md 原则 #6/#7/#10 |
| `project/code-review-rules.md` | 代码审查规则矩阵 | 04 阶段 Step 5 使用时读取 |
| `engine/templates/phase-0X-*.md` | 6 个阶段文档模板 | workflow-engine.md 各阶段产出 |
