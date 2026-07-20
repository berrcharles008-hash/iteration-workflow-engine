---
name: iteration-workflow
description: |
  迭代开发工作流 Skill。覆盖7个标准阶段：01-需求分析与设计、
  02-需求评审、03-技术方案、04-开发实现（Team Agent模式）、05-测试验证、06-发布上线、07-迭代回顾。
version: "2.0.0"
---

## 文件加载优先级

> engine-local/ 优先于根目录（引擎文件），同名文件以 engine-local/ 为准。

| 优先级 | 目录 | 内容 |
|:----:|------|------|
| 1 | `engine-local/` | 项目级覆盖 |
| 2 | 根目录（核心协议文件） | 通用引擎（git subtree 管理） |
| 3 | `project/` | 项目配置 |
| 4 | `runtime/` | 运行时状态 |

### 启动读取顺序

```
1. 读 startup-protocol.md Step A-D（通用启动流程）
2. 读 engine-local/startup-protocol-step-e.md Step E（每日工作日志）
3. 模板路径：优先 engine-local/templates/{文件名}，不存在则读 templates/{文件名}
```

## ★ 门禁规则（一句话摘要）

**任何代码修改前必须先过门禁。** 门禁协议完整规则见 `gate-protocol.md`。

## ★ 启动协议（摘要）

| 步骤 | 动作 | 详址 |
|------|------|------|
| Step A | 读取 project/project.manifest.yaml | startup-protocol.md Step A |
| Step A.5 | 自检本地配置文件，引导创建缺失文件 | startup-protocol.md Step A.5 |
| Step B | 检查 runtime/ 恢复迭代状态 | startup-protocol.md Step B |
| Step C | 复杂度评估 | complexity-scoring.md |
| Step D | 进入对应阶段执行 | workflow-engine.md |
| Step E | 写入每日工作日志 | engine-local/startup-protocol-step-e.md |

## 七阶段概览

| 阶段 | 产出 | 关键动作 |
|------|------|---------|
| 01-需求分析 | 需求文档.md | 读 Spec 活文档 → 与用户确认需求 |
| 02-需求评审 | 评审记录.md | reviewer 视角审阅 → 提问题 → 用户决议 |
| 03-技术方案 | 技术方案设计.md | 代码探索 → 方案 → Delta标记 → 命名冲突预检 |
| 04-开发实现 | 开发任务清单.md + 代码 | 清单生成 → 自动审查 → 用户确认 → Team Agent |
| 05-测试验证 | 测试报告.md | 构建验证 → 用例生成 → 自动执行 |
| 06-发布上线 | 上线记录.md | 编译 → 部署 → Spec 活文档更新 |
| 07-迭代回顾 | 迭代回顾报告.md | 总结反思 → 问题清单 → 模式沉淀 |

## 关键原则

0. **★ 修改门禁强制**：任何代码修改前，必须先通过门禁检查。
1. **阶段不可跳过**：必须按 01→07 顺序执行。
2. **文档驱动**：每个阶段的产出文档是下一阶段的输入。
3. **任务清单是唯一真相源**：进度完全由任务清单的勾选状态决定。
4. **命名冲突预检强制**：涉及在已有代码中新增符号时，执行命名冲突扫描。
5. **★ 图优先原则**：优先使用 Mermaid 图表嵌入文档。

> 完整流程定义见 `workflow-engine.md`，门禁规则见 `gate-protocol.md`。
