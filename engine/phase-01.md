# 阶段一：01-需求分析与设计

**前置步骤**：
1. **step-0-init-state**（仅新迭代首次进入时执行）：创建 `runtime/{ITERATION_ID}.state.yaml` + 写入 `runtime/ACTIVE` + 创建迭代目录结构 + 更新 README 迭代清单。详见 `phase-steps.md` §阶段一步骤清单。
2. 读取 `{{SPECS_DIR}}/` 下的项目上下文文件清单（详见 `project/context-conventions.md` → 一、项目上下文文件清单）获取项目上下文 + 读取 `{{KB_DIR}}/` 下的 L1/L2/L3 知识库。
   - 知识库**不存在** → 执行 `python scripts/gen-knowledge-base.py` 生成
   - 知识库**过时** → 先执行 `python scripts/gen-knowledge-base.py --check` 检测，若有"过时/缺失"项则执行 `--force` 自动刷新（`auto-generated: false` 的人工编辑文件不会被覆盖），再读取

**目标**：明确需求范围、梳理现状、识别痛点、产出需求文档。

**产出**：
- 通用需求：`01-需求分析与设计/01-需求记录.md`（模板：`phase-01-需求记录.md`，🟢简单用 `phase-01-需求文档-lite.md`，优先级见启动协议 §模板解析优先级）
- **Bug 类需求**：`01-需求分析与设计/01-需求记录.md`（模板：`bug-requirement-template.md`，优先级见启动协议 §模板解析优先级）
  - 判断标准：迭代标题含"修复"/"Bug"/"fix"关键词，或需求描述为"XX异常/XX不对/XX报错"
  - Bug 模板必须包含：根因分析、影响范围、修复方案、验证方式

> **版式纪律**：产出文档须遵循 `engine/doc-style-guide.md`（表格 ≤6 列、单元格 ≤60 字、结论前置、过程进附录）；生成后自检 `python scripts/doc_lint.py <文件>`（ERROR 必修）。

**交付标准**：用户确认需求文档无误，明确表示"需求分析完成"或"进入需求评审"；**文档版式自检 ERROR 0**（`python scripts/doc_lint.py <文档>`）

### 步骤清单（进入阶段时写入 phase_steps）

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-0-init-state | 创建 state.yaml + 写入 ACTIVE | ✅ | 新迭代（首次进入 01） |
| step-1-read-specs | 读取Spec活文档获取项目上下文 | ✅ | 始终 |
| step-1-5 | 模块范围定位（读L1总览+匹配相关L2模块） | ✅ | 始终 |
| step-1.6-dir-diff | 迭代开始目录对比（scan后端BLL+前端pages → 对比L1模块列表 → 输出+/-/~差异） | — | 始终 |
| step-2-classify | 判断需求类型（Bug类/功能类），选择对应模板 | ✅ | 始终 |
| step-2-5 | 闭环追问（5W2H七维度穷举生成问题清单） | ✅ | 始终 |
| step-2-6 | 共享语言建立（生成CONTEXT.md术语映射快照） | ✅ | 始终 |
| step-3-output | 生成01-需求记录.md | ✅ | 始终 |
| step-4-user-confirm | 用户确认需求文档 | ✅ | 始终 |

### step-1.6-dir-diff 详细说明

> 每次迭代开始时（phase-01 step-1），扫描实际目录结构与 `{{KB_DIR}}/L1-overview.md` 模块列表对比，检测模块新增/删除/重命名。

**执行流程**：
1. **Scan** 后端 `{{backend_layers.bll.dir}}/` + 前端 `{{frontend_layers.page.dir}}/` 目录，提取模块级目录清单
2. **对比** `{{KB_DIR}}/L1-overview.md` 中的模块列表
3. **输出差异**：
   - `+` 新增模块（目录存在但 L1 未收录）→ 提醒用户执行 gen-l1 更新
   - `-` 删除模块（L1 收录但目录不存在）→ 标记待清理
   - `~` 目录变化（模块名相同但文件数或子目录变化）→ 提醒 L2 wiki 可能过时
4. **★ 自动刷新知识库**（发现任一差异时强制执行）：
   ```
   python scripts/gen-knowledge-base.py --check          # 确认过时范围
   python scripts/gen-knowledge-base.py --force          # 自动刷新（含缺失的新模块）
   # 或精准刷新：--level L2 --force --module {变化模块名}
   ```
   - 自动执行，**不需等待用户确认**：`auto-generated: false` 的人工编辑内容不会被覆盖
   - 刷新后继续后续步骤（01 step-2 及 03 阶段读到的即为最新知识库）

**L1 覆盖规则**（决议F）：
- `auto-generated: true` → 可被 gen-l1 自动覆盖更新
- `auto-generated: false` → 仅人工编辑，Agent 仅输出差异建议，不覆盖
- step-1.6-dir-diff 永不自动覆盖 `auto-generated: false` 的 L1

**输出格式**：
```
🔍 目录对比结果：
+ 新增模块：ModuleName1 (path/to/dir)
- 删除模块：ModuleName2 (L1收录但目录不存在)
~ 目录变化：ModuleName3 (文件数 15→18)
→ 建议：执行 `python scripts/gen-knowledge-base.py --level L1` 更新 L1-overview.md
```

### step-2-5 详细说明：闭环追问（5W2H 框架）

> 在 step-2-classify（判断需求类型）之后、step-3-output（生成需求文档）之前执行。

**目的**：通过结构化追问消除需求理解偏差，避免需求理解不到位导致后续阶段返工。

**执行流程**：
1. Agent 按 **5W2H** 七维度穷举生成问题清单：
   - **WHO**（相关人员）：谁提出？谁执行？谁受益？
   - **WHAT**（具体内容）：要做什么？输入/输出是什么？
   - **WHY**（为什么）：为什么要做？当前痛点是什么？
   - **WHEN**（时间）：什么时候开始？截止时间？
   - **WHERE**（范围）：涉及哪些模块/页面/系统？
   - **HOW MUCH**（量级）：多大工作量？多大影响范围？
   - **HOW**（怎么做）：有哪些约束/限制？有参考实现吗？
2. 问题清单写入 `01-需求记录.md` 的「闭环追问记录」章节
3. 用户逐项确认/补充
4. 将用户答复合并到需求文档正文

**完成条件**：7 个维度每个至少 1 个问题已确认，或明确标注"不适用"。

**回退机制**：若 5W2H 追问结果改变需求类型（Bug→功能新增、🟢→🔴），回退到 step-2-classify 重新分类。

### step-2-6 详细说明：共享语言建立（生成 CONTEXT.md）

> 在 step-2-5（闭环追问）之后、step-3-output（生成需求文档）之前执行。

**目的**：在需求分析阶段就建立术语映射，避免到 06 归档阶段才发现术语不一致导致理解偏差。

**执行流程**：
1. Agent 从 `{{KB_DIR}}/L3-glossary.md` 和 Spec 活文档提取本次迭代涉及的术语
2. 生成 `{{SPECS_DIR}}/iteration-context/{ITERATION_ID}-context.md`（迭代范围子集快照）
3. 用户确认术语映射

**生成时机**：01 阶段 Agent 自动提取生成初稿。03 阶段可修正，**修正确认后写入只读声明**。04 起不可修改。

**文件位置**：`{{SPECS_DIR}}/iteration-context/{ITERATION_ID}-context.md`（相对于项目根目录）。

**模板结构**：
- 迭代目标（一句话）
- 涉及模块（后端/前端）
- 术语映射表（需求用词 → 代码命名 → 来源）
- 接口/实体/页面子集
- 来源 Spec 文件
- 只读声明（04 起不可修改）

**读取优先级**（按阶段区分，消除自循环）：
- 01 step-1/2（需求分析中）：`{{KB_DIR}}/L3-glossary.md` → Spec 活文档（CONTEXT.md 尚未生成）
- 01 step-2-6 完成之后：CONTEXT.md 已生成，后续步骤可读取
- 03+（技术方案起）：CONTEXT.md → `{{KB_DIR}}/L3-glossary.md` → Spec 活文档
