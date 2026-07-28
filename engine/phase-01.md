# 阶段一：01-需求分析与设计

**前置步骤**：
1. **step-0-init-state**（仅新迭代首次进入时执行）：创建 `runtime/{ITERATION_ID}.state.yaml` + 写入 `runtime/ACTIVE` + 创建迭代目录结构 + 更新 README 迭代清单。详见 `phase-steps.md` §阶段一步骤清单。
2. 读取 `{{SPECS_DIR}}/` 下的项目上下文文件清单（详见 `project/context-conventions.md` → 一、项目上下文文件清单）获取项目上下文。

**目标**：明确需求范围、梳理现状、识别痛点、产出需求文档。

**产出**：
- 通用需求：`01-需求分析与设计/01-需求记录.md`（模板：`phase-01-需求记录.md`，🟢简单用 `phase-01-需求文档-lite.md`，优先级见启动协议 §模板解析优先级）
- **Bug 类需求**：`01-需求分析与设计/01-需求记录.md`（模板：`bug-requirement-template.md`，优先级见启动协议 §模板解析优先级）
  - 判断标准：迭代标题含"修复"/"Bug"/"fix"关键词，或需求描述为"XX异常/XX不对/XX报错"
  - Bug 模板必须包含：根因分析、影响范围、修复方案、验证方式

**交付标准**：用户确认需求文档无误，明确表示"需求分析完成"或"进入需求评审"

### 步骤清单（进入阶段时写入 phase_steps）

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-0-init-state | 创建 state.yaml + 写入 ACTIVE | ✅ | 新迭代（首次进入 01） |
| step-1-read-specs | 读取Spec活文档获取项目上下文 | ✅ | 始终 |
| step-2-classify | 判断需求类型（Bug类/功能类），选择对应模板 | ✅ | 始终 |
| step-3-output | 生成01-需求记录.md | ✅ | 始终 |
| step-4-user-confirm | 用户确认需求文档 | ✅ | 始终 |
