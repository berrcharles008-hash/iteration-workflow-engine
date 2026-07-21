# 复杂度自适应策略

> 本文件定义了主 Agent 在面对不同复杂度需求时，如何自动调整输出深度、跳过不必要的生成步骤。

---

## 一、复杂度评估算法

### 1.1 评估因素（通用分类 + 项目定制）

> 以下为**通用默认因素**，适用于大多数项目。项目可在 `project.manifest.yaml` 的 `complexity_factors` 段覆盖或扩展。

```yaml
# 通用因素（默认）
factors:
  - id: "new_db_table"
    weight: 2
    description: "是否涉及新数据库表"
  - id: "new_api"
    weight: 2
    description: "是否涉及新 API 接口"
  - id: "affected_files"
    weight_dynamic: true
    rules:
      - condition: "1-2 个文件"
        score: 0
      - condition: "3-5 个文件"
        score: 1
      - condition: "6+ 个文件"
        score: 2
    description: "涉及的源文件数量"
  - id: "new_module"
    weight: 1
    description: "是否涉及新模块/页面/界面"
  - id: "new_layer_file"
    weight: 1
    description: "是否需要新增分层架构中的文件（如数据层/业务层/表现层）"
  - id: "layer_modification"
    weight_dynamic: true
    rules:
      - condition: "新增方法/函数"
        score: 1
      - condition: "仅改调用"
        score: 0
    description: "是否需要修改已有分层架构"
  - id: "stored_proc_modify"
    weight: 1
    description: "修改已有存储过程/数据库函数"
  - id: "stored_proc_new_small"
    weight: 1
    description: "新增存储过程/数据库函数 <50 行"
  - id: "stored_proc_new_large"
    weight: 2
    description: "新增存储过程/数据库函数 ≥50 行"
  - id: "ddl_change"
    weight: 1
    description: "DDL 变更（ALTER TABLE 等）"
```

> **项目定制**：在 `project.manifest.yaml` 中可定义 `complexity_factors` 段覆盖默认因素。
> 例如纯前端项目可删除 `stored_proc_*` 和 `ddl_change` 因素，新增 `new_route`、`new_component` 等因素。
> 若未定义 `complexity_factors`，则使用上述默认因素。

### 1.2 评分映射

```yaml
thresholds:
  simple:  { min: 0, max: 2, label: "🟢 简单" }
  medium:  { min: 3, max: 5, label: "🟡 中等" }
  complex: { min: 6, max: 99, label: "🔴 复杂" }
```

> **梯度调整说明**（2026-06-30）：
> 原梯度 0-1/2-3/4+ 过于敏感，2 分就到 🟡（如"新页面+新Net层"这种常见小改动）。
> 调整后 0-2/3-5/6+，让 🟡 门槛更合理，减少不必要的中等评级。

### 1.3 复杂度升降级机制

> 复杂度等级在 Step C 评估后写入 state.yaml。后续阶段如发现评估偏差，允许升降级，但必须记录原因。

**升降级流程**：
1. Agent 在任意阶段发现实际复杂度与初评不符 → 输出调整建议（新等级 + 理由）
2. 用户确认调整
3. Agent 写入 `complexity_adjustments` 字段（见 `state-protocol.md`）
4. 后续阶段按新等级执行

**典型场景**：
- 03 阶段发现存储过程实际 80 行（初评时未细看）→ 🟢 升级为 🟡
- 04 阶段发现前端改动比预期简单（复用现成组件）→ 🟡 降级为 🟢

---

## 二、步骤 mandatory 默认值表（★ 2026-06-30 新增）

> Agent 进入阶段时从此表自动初始化 `phase_steps[].mandatory` 值，**只能读取不能修改**。
> 用户仍可跳过 mandatory=true 的步骤，但需显式确认并记录 `skip_reason`。

| 步骤 ID | 步骤名称 | 🟢 简单 | 🟡 中等 | 🔴 复杂 |
|---------|---------|:-------:|:-------:|:-------:|
| step-0-sql-gen | 数据库脚本生成 | N/A | mandatory=true | mandatory=true |
| step-0-sql-review | 脚本审查 | N/A | mandatory=true | mandatory=true |
| step-0-sql-exec | 脚本执行 | N/A | mandatory=true | mandatory=true |
| step-1-task-list | 任务清单生成 | mandatory=true | mandatory=true | mandatory=true |
| step-1-review | 需求评审 | mandatory=false | mandatory=true | mandatory=true |
| step-2-output | 技术方案 | mandatory=false | mandatory=true | mandatory=true |
| step-1x-cross-review | 需求格式完整性检查（交叉审查） | N/A | mandatory=false | mandatory=false |
| step-3x-cross-review | 技术方案L1/L2交叉审查 | N/A | mandatory=true | mandatory=true |
| step-1-5x-cross-review | 任务清单交叉审查 | N/A | mandatory=true | mandatory=true |

> **N/A 含义**：该步骤在对应复杂度下不适用，Agent 初始化时设为 `status: not_applicable`。
> **mandatory=false 含义**：该步骤可选，Agent 提示但不阻塞。
> **mandatory=true 含义**：该步骤强制，用户跳过需显式确认并记录理由。

**初始化规则**：
1. Agent 进入阶段时，根据当前复杂度等级查表
2. 对每个步骤设置 `mandatory` 值（true/false）
3. N/A 的步骤直接设为 `status: not_applicable`
4. Agent 不得自行修改 mandatory 值，只能从表读取

---

## 三、各等级下各阶段的执行模板

### 3.1 🟢 简单需求 — 简化版

> ⚠️ **强制前置步骤（不可跳过，即使是最简单的需求）**：
> 在做任何代码改动之前，必须先完成以下两步：
> 1. 在 `docs/iterations/` 下创建迭代目录，格式：`YYYY-MM-DD-XXX-{简述}/`
> 2. 在目录内创建 `01-需求记录.md`（使用下方模板）
>
> **违反此规则 = 本次迭代无效**，即便代码已改完，也必须补建文档后才算完成。

#### 阶段一（01-需求分析）：一句话定位

只产出精简文档，不过度分析。

**模板**：
- **Bug 类需求** → 使用 `engine/templates/bug-requirement-template.md`（精简版：保留根因分析+影响范围+修复方案+验证方式，其余章节可按需精简）
- **功能类需求** → 使用下方精简模板

**功能类精简模板**：
```markdown
# 需求记录

## 问题
{一句话描述}

## 涉及文件
- {文件1路径} — {改动类型}
- {文件2路径} — {改动类型}

## 改动要点
1. {要点1}
2. {要点2}

## 状态
⏳ 进行中 / ✅ 已完成（{日期}）
```

#### 阶段二（02-需求评审）：极简模式（4 问合并到 01，不产出独立 02 文档）

简单需求不单独产出 02 文档，4 问评估直接记录在 01-需求记录.md 末尾。阶段逻辑仍执行（需求范围确认、是否需 03 方案的 4 问判断）。

#### 阶段三（03-技术方案）：极简模式（方案要点合并到 04，不产出独立 03 文档）

不单独写方案文档。在开发任务清单的备注列标注改动范围、接口签名等技术要点。阶段逻辑仍执行（代码探索、关键符号验证、命名冲突预检）。

#### 阶段四（04-开发实现）：主 Agent 直写，不用 Team

```
执行方式（★ 强制按序，不可跳过任何步骤）:
  1. 确认 01-需求记录.md 已存在       ← 前置检查，未建则先建
  2. 生成 04-开发任务清单.md           ← ★ 强制产出文件（即使只有1个任务）
  3. 审查任务清单（Step 1.5）          ← ★ 强制对照需求文档
     （🟢 简单需求不执行 Step 1.5x 交叉审查，token 成本 > 收益）
  4. 用户确认任务清单（Step 1.6）      ← ★ 强制等待用户确认后才能编码
  5. read_file(目标文件)              ← 读取当前内容
  6. replace_in_file(目标文件)        ← 精确修改
  7. read_lints(目标文件)             ← 检查语法
  8. 更新 01-需求记录.md 状态为 ✅
```

**关键约束**：
- 不用 `team_create`
- 不用 `task` 派发 Agent
- 直接在主 Agent 中用 `replace_in_file` / `write_to_file`
- **★ P-017 禁止行为（2026-07-06）**：不得在步骤 2-4 完成前执行步骤 5-7（即禁止跳过任务清单直接写代码）。事故案例：010 迭代中 Agent 标记 step-1 为 completed 但未产出清单文件，直接进入编码。
- **★ Step 5 代码审查（2026-07-08）**：🟢 简单需求也必须输出精简版审查结论（并入任务清单末尾），不得完全跳过。详见 [workflow-engine.md](workflow-engine.md) 复杂度分级表。

#### 阶段五（05-测试验证）：精简版

不写完整测试报告，只在 `01-需求记录.md` 状态行确认。

#### 阶段六（06-发布上线）：精简版

不写独立上线记录。

#### 阶段七（07-迭代回顾）：精简版

追加到 `01-需求记录.md` 末尾，300字以内。

---

### 3.2 🟡 中等需求 — 标准版

#### 阶段一～三：按常规流程，但减少文档深度

- 需求文档：标准版
- 需求评审：精简版（不列详细问题清单，直接确认）
- 技术方案：精简版（仅改动范围表 + API 描述，不需要完整代码示例）

#### 阶段四（04-开发实现）：Team 1-2 Agent

```
执行方式:
  1. team_create({name}-dev)
  2. task 派发 1-2 个 Agent（可并行）
  3. 校验 + 更新清单
```

中等需求通常不需要 5 层 Agent（net/bll/domain/page/route）/（Web/Inf/BLL），可能只需要 1-2 层。

#### 阶段五～六：标准版

---

### 3.3 🔴 复杂需求 — 完整版（当前 Skill 默认模式）

全部按完整流程执行。详见 SKILL.md 中各阶段的默认定义。

---

## 四、自适应模板对照

| 环节 | 🟢 简单 | 🟡 中等 | 🔴 复杂 |
|------|---------|---------|---------|
| 迭代目录 | 1个文件（任务清单） | 3个目录（01/03/04） | 7个目录全覆盖 |
| 文档总字数 | <300字 | <2000字 | <15000字 |
| 04阶段 Agent 数 | 0（主 Agent 直写） | 1-2 | 3-7 |
| 04阶段轮次 | 1轮 | 1-2轮 | 按依赖图动态 |
| 是否创建 Team | ❌ 不创建 | 按需 | ✅ 创建 |
| 07 回顾深度 | 精简版（追加到01） | 标准版（独立报告） | 完整版（报告+模式库） |

---

## 五、简易需求下的 Agent Prompt 简化模板

当需求为 🟢 简单级别时，如果仍然需要派发 Agent，prompt 应大幅简化：

```markdown
## 任务：{一句话描述}

### 文件
{绝对路径}

### 改动
{精确描述改动内容，如果有替换用的 old_str/new_str 则给出}

### 约束
- 只修改上述文件
- 不要引入新的 import（除非明确需要）
- 完成后报告"完成"
```

对比完整版删除了：
- ❌ 完整代码块（只需精确改动描述）
- ❌ 参考文件
- ❌ 方案文档引用
- ❌ 操作类型标注

---

## 六、主 Agent 进入阶段的决策流程图

```
用户请求 "进入04 / 开始开发实现"
            │
            ▼
    检查：03-技术方案是否存在？
            │
    ┌───────┴───────┐
    │ 存在           │ 不存在
    ▼                ▼
  从方案中读     检查：需求复杂度等级？
  取改动范围           │
                ┌─────┴─────┐
                │ 🟢简单    │ 🟡🟡/🔴
                ▼           ▼
          主 Agent 直写   提示：需要先完成03-技术方案
          （跳过build）
```