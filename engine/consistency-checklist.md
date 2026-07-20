# Engine 文件一致性检查清单

> **用途**：对 engine/ 目录下所有文件进行交叉验证的固定检查清单。
> **使用方式**：每次扫描严格按照此清单逐项检查，不随意增减检查项。
> **收敛性保证**：清单穷举后，修复完成则扫描必然通过（0 问题）。

---

## 前置参考数据（清单执行前锁定）

### 标准文件命名表（来源：workflow-engine.md §标准文件命名）

| 阶段 | 标准文件名 | 适用范围 |
|------|-----------|:--:|
| 01 | `01-需求记录.md` | 全部 |
| 02 | `02-需求评审.md` | 🟡🔴 |
| 03 | `03-技术方案.md` | 🟡🔴 |
| 04 | `04-开发任务清单.md` | 全部 |
| 04 | `04-代码审查报告.md` | 全部 |
| 05 | `05-测试验证报告.md` | 🟡🔴 |
| 06 | `06-发布上线记录.md` | 🟡🔴 |
| 07 | `07-迭代回顾报告.md` | 🟡🔴（🟢追加到01末尾） |

### 阶段目录名

| 阶段 | 目录名 |
|:--:|------|
| 01 | `01-需求分析与设计/` |
| 02 | `02-需求评审/` |
| 03 | `03-技术方案/` |
| 04 | `04-开发实现/` |
| 05 | `05-测试验证/` |
| 06 | `06-发布上线/` |
| 07 | `07-迭代回顾/` |

### 步骤ID清单（来源：phase-steps.md）

| 阶段 | 步骤ID |
|:--:|------|
| 01 | step-0-init-state, step-1-read-specs, step-2-classify, step-3-output, step-4-user-confirm |
| 02 | step-1x-cross-review, step-1-review, step-2-user-resolve, step-3-output, step-4-review-gate, step-5-user-confirm |
| 03 | step-1-explore, step-2-output, step-3-self-review, step-3x-cross-review, step-4-review-gate, step-5-fix-verify, step-5-review-gate-result, step-6-user-confirm |
| 04 | step-0-sql-gen, step-0-sql-review, step-0-sql-exec, step-1-task-list, step-1-5-review, step-1-5x-cross-review, step-1-6-user-confirm, step-3-team-code, step-4-csproj, step-5-build, step-6-spec, step-7-code-review |
| 05 | step-0-frontend-build, step-1-generate-cases, step-2-user-review, step-3-execute, step-4-output |
| 06 | step-1-deploy-stage1, step-2-spec-update, step-3-archive, step-4-archive-check |
| 07 | step-1-summary, step-2-issues, step-3-patterns, step-4-actions, step-5-lessons, step-6-archive |

### Engine 文件清单（12个）

| # | 文件名 | 用途 |
|---|--------|------|
| 1 | workflow-engine.md | 七阶段流程定义 |
| 2 | state-protocol.md | 状态文件读写协议 |
| 3 | phase-steps.md | 步骤清单唯一真相源 |
| 4 | gate-protocol.md | 三道门禁规则 |
| 5 | cross-review-protocol.md | 独立Agent交叉审查协议 |
| 6 | complexity-scoring.md | 复杂度评估算法 |
| 7 | delta-marking.md | Delta标记体系 |
| 8 | naming-conflict-check.md | 命名冲突预检规则 |
| 9 | startup-protocol.md | 启动协议 |
| 10 | team-agent-strategy.md | Team Agent并行决策 |
| 11 | template-injection.md | 变量注入协议 |
| 12 | lessons-learned.md | 复盘与模式库 |

---

## 检查清单

### C1: 文件存在性
- [ ] C1.1: startup-protocol.md 中引用的所有 engine/ 文件是否存在？

### C2: 步骤命名一致性
- [ ] C2.1: workflow-engine.md 中 01-07 各阶段的步骤清单是否与 phase-steps.md 完全一致？
  - 逐阶段比对步骤ID、名称、强制标记、触发条件
- [ ] C2.2: complexity-scoring.md §二 步骤 mandatory 默认值表中的步骤ID是否与 phase-steps.md 一致？
- [ ] C2.3: state-protocol.md §8.5 引用的 phase-steps.md 步骤是否存在？

### C3: 产出文档名一致性
- [ ] C3.1: workflow-engine.md 目录结构示例（行12-33）中的文件名是否与标准命名表一致？
- [ ] C3.2: workflow-engine.md 各阶段"产出"行引用的文档名是否与标准表一致？
  - 行212-213（01产出）
  - 行235（02输入）
  - 行256（02产出）
  - 行283（03产出）
  - 行336（03交叉审查{{方案文档路径}}）
  - 行593（04产出）
  - 行597（04审查对照）
  - 行761（05产出）
  - 行811（06产出）
  - 行912（07产出）
- [ ] C3.3: cross-review-protocol.md §4.1 的 `{{方案文档路径}}` 替换逻辑与标准表一致？
- [ ] C3.4: complexity-scoring.md §3.1 🟢简化的产出文档引用是否与标准表一致？
- [ ] C3.5: CLAUDE.md / .cursorrules 目录约定与标准命名表是否一致？
- [ ] C3.6: phase-steps.md §阶段二的 step-4-review-gate 引用的评审记录文件名是否标准？
- [ ] C3.7: state-protocol.md §3.1 review_gate 中的文档引用是否标准？

### C4: 阶段数一致性
- [ ] C4.1: startup-protocol.md 引擎索引表中阶段数描述为"七阶段"（已修复验证）
- [ ] C4.2: 所有文件中的阶段数描述均为 7（搜索"N阶段"、"六阶段"等模式）

### C5: 行号引用准确性
- [ ] C5.1: state-protocol.md 行260 引用 "workflow-engine.md 第38-82行" → 实际应为行122-165（阶段回退检查协议）
- [ ] C5.2: 其他跨文件行号引用是否准确？

### C6: 并行约定一致性
- [ ] C6.1: workflow-engine.md §03（行341）并行约定描述是否与 cross-review-protocol.md §六一致？
- [ ] C6.2: workflow-engine.md §04（行548）并行约定描述是否与 cross-review-protocol.md §六一致？
- [ ] C6.3: cross-review-protocol.md §六 行182 步骤清单序号说明是否与 phase-steps.md 中的编号一致？
- [ ] C6.4: 所有文件中 "(step-3x/step-1-5x)" 的表述是否完整一致？

### C7: 交叉审查触发条件一致性
- [ ] C7.1: cross-review-protocol.md §二 触发条件表与 phase-steps.md 各阶段步骤的触发条件是否一致？
- [ ] C7.2: complexity-scoring.md §二 mandatory表中的交叉审查步骤是否与 trigger 条件一致？
- [ ] C7.3: workflow-engine.md 各阶段交叉审查步骤的触发条件是否一致？

### C8: 门禁协议引用
- [ ] C8.1: workflow-engine.md 行187-196 门禁引用是否指向正确文件（gate-protocol.md）？
- [ ] C8.2: gate-protocol.md 行92 迭代门禁协议引用是否正确？
- [ ] C8.3: gate-protocol.md 行155 引用 "workflow-engine.md#迭代门禁协议" 是否存在？

### C9: review_gate 字段一致性
- [ ] C9.1: state-protocol.md §3.1 review_gate 允许值与 gate-protocol.md §三-A 是否一致？
- [ ] C9.2: phase-steps.md 阶段二/三的 step-x-review-gate 执行要求与 state-protocol.md 是否一致？

### C10: 模板文件路径
- [ ] C10.1: workflow-engine.md 各阶段引用的模板文件路径（engine/templates/phase-XX-*.md）是否存在对应模板文件？
- [ ] C10.2: 模板文件名是否与标准命名表一致？

### C11: 版本号/变更记录
- [ ] C11.1: cross-review-protocol.md 变更记录版本号是否连续？
- [ ] C11.2: phase-steps.md 变更记录版本号是否连续？

### C12: 无孤立/断链引用
- [ ] C12.1: 所有 `详见 xxx.md` 类型的引用文件是否真实存在？
- [ ] C12.2: 所有锚点引用（`#xxx`）是否在目标文件中存在对应章节？

---

## 执行方法

1. 逐项检查，每项输出 ✅（通过）或 ❌（发现问题，附详情）
2. 所有 ❌ 项汇总于报告末尾
3. 修复所有 ❌ 后重新执行本清单，直到全部 ✅

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-07-12 | 1.0 | 初始版本，建立12大类固定检查清单 |
| 2026-07-12 | 1.1 | 执行首轮扫描并修复全部11项问题：C2.2步骤ID / C3.1目录结构 / C3.2产出引用(9处) / C3.3运行时路径 / C3.6 phase-steps引用 / C3.7 state-protocol示例 / C4.1六→七阶段 / C5.1行号引用 / C10.2模板重命名(4个+4引用+3个lite交叉引用) |
