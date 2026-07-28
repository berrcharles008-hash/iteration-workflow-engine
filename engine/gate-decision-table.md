# 门禁决策表

> **用途**：修改门禁规则（`gate-protocol.md` §一~§三 或 `gate-check.mjs`）后，对照本表逐条验证行为未退化。
> **核心理念**：主表（S0~S7）机械可验证，附录 A 人工验证。
> **最后更新**：2026-07-23

---

## 主表：L3 Hook 层（`gate-check.mjs`）

> 每个场景均可通过管道输入 JSON 到 `node gate-check.mjs` 验证，退出码 0=放行，2=阻止。

| # | 场景 | 活跃迭代 | 阶段 | 写入路径 | 预期 | 备注 |
|:--:|------|:--:|:--:|------|:---:|------|
| **S0** | 无工具上下文的防御放行 | 任意 | 任意 | — | **ALLOW** | stdin 空 / JSON 解析失败 / 非写入工具（`read_file`等）/ 无 filePath。exit 0 |
| **S1** | 正常开发窗口 | ✅ in_progress | 04 | `front-end/src/pages/foo.vue` | **ALLOW** | 04 阶段=合法写码窗口，hook 无条件放行全部写入 |
| **S2** | 无活跃迭代 | ❌ none | — | `back-end/.../SomeBLL.cs` | **BLOCK** | ACTIVE=none → "当前无活跃迭代" |
| **S3** | 设计阶段写豁免目录 | ✅ in_progress | 01/02/03 | `docs/iterations/2026-07-23-020/需求分析.md` | **ALLOW** | EXEMPT_PATHS 匹配：`docs/iterations/`、`.codebuddy/skills/`、`.codebuddy/memory/` |
| **S4** | 设计阶段越权写业务代码 | ✅ in_progress | 01/02/03 | `back-end/.../Entity.cs` | **BLOCK** | 非 04 阶段 + 非豁免路径 → "仅允许修改迭代产出目录" |
| **S5** | GATE_BYPASS 逃生口 | 任意 | 任意 | 任意 | **ALLOW** | 环境变量 `GATE_BYPASS=1` 或 `.codebuddy/hooks/.gate-bypass` 标记文件存在。exit 0，先于所有门禁检查 |
| **S6a** | ACTIVE 指向已完结迭代 | ✅ 但 completed/abandoned | — | 任意 | **BLOCK** | state.yaml 中无 `current_phase: "04"` 匹配 → "无法读取 current_phase"。**自修复由 prompt 层处理**（gate-protocol.md §一 fallback 扫描→修复 ACTIVE="none"） |
| **S6b** | ACTIVE 指向缺失的 state.yaml | ✅ 但文件不存在 | — | 任意 | **BLOCK** | `existsSync(stateFile)` = false → "状态文件丢失" |
| **S7** | 开发窗口已关闭 | ✅ in_progress | 05/06/07 | `front-end/src/...` | **BLOCK** | 非 01-04 阶段 → "当前阶段 {N} 不允许进行文件写入操作" |

### 主表验证命令模板

```bash
# Windows PowerShell（设置运行时目录 + 模拟项目目录）
$env:GATE_TEST_RUNTIME_DIR = "path/to/runtime"
$env:CODEBUDDY_PROJECT_DIR = "path/to/project"

# S0：空输入
echo '' | node .codebuddy/hooks/gate-check.mjs; $LASTEXITCODE

# S1-S7：写入工具
'{"tool_name":"write_to_file","tool_input":{"filePath":"/path/to/target.ts"}}' `
  | node .codebuddy/hooks/gate-check.mjs; $LASTEXITCODE
```

---

## 附录 A：L1/L2 Prompt 层门禁（人工验证）

> 以下门禁不在 `gate-check.mjs` 中，依赖 prompt 层（SKILL.md + CLAUDE.md）执行。修改 `gate-protocol.md` §二/§三 后需人工评审确认行为。

| 场景 | 协议位置 | 触发条件 | 预期行为 | 验证方式 |
|------|---------|---------|---------|:---:|
| **迭代门禁：新迭代前检查** | `gate-protocol.md` §二 | 用户请求"新迭代"/"开始迭代" | ACTIVE 非空且 in_progress/paused → 弹出 BLOCK 框，包含 1/2/3 选项（继续/归档/暂停） | 人工评审 |
| **迭代门禁：废弃/暂停确认** | `gate-protocol.md` §二 | 用户说"取消/废弃/砍掉" | 弹出 1/2/3 确认框（暂停/废弃/取消），不直接执行 | 人工评审 |
| **迭代门禁：删除已归档** | `gate-protocol.md` §二 | 用户请求删除迭代 | 已归档→不可删除 BLOCK；进行中/暂停/废弃→警告+用户确认 | 人工评审 |
| **步骤门禁：强制步骤结清** | `gate-protocol.md` §三-C | current_phase 推进 M→M+1 | `mandatory: true` 步骤须全为 completed/skipped，否则先结清再推进 | 人工评审 |
| **步骤门禁：条件重武装** | `gate-protocol.md` §三 | 跳步意图 / 恢复后首轮 / Agent 自检 | 拦截并提示当前第一个 pending 强制步骤 | 人工评审 |
| **阶段推进确认门禁** | `gate-protocol.md` §三-B | current_phase 变更 | 检查本轮用户指令含"通过/确认/没问题/进入XX阶段"等明确通过语 | 人工评审 |
| **评审门禁** | `gate-protocol.md` §三-A | 推进 02→03 或 03→04 | 检查 `review_gate.result` ≠ "rejected" | 人工评审 |
| **修改门禁：迭代归属校验** | `gate-protocol.md` §一 | 04 阶段写 `docs/iterations/{id}/` 下文件 | id 须与活跃迭代一致，不一致→BLOCK | 人工评审 |

---

## 修改门禁规则后的验证流程

1. 修改了 `gate-check.mjs` → 对照**主表 S0~S7** 逐条跑机械验证，确认退出码符合预期
2. 修改了 `gate-protocol.md` §一 → 对照**主表 S0~S7** + **附录 A 最后一行（迭代归属校验）**
3. 修改了 `gate-protocol.md` §二 → 对照**附录 A 前三行（迭代门禁）**
4. 修改了 `gate-protocol.md` §三 → 对照**附录 A 后四行（步骤门禁/确认门禁/评审门禁）**
5. 自修改影响声明引用本表验证结果（格式）：`"决策表验证：已对照 engine/gate-decision-table.md 逐条确认，S0~S7 全部通过"`
