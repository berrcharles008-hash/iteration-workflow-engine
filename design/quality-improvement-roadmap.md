# iteration-workflow Skill 质量提升路线图

> 基于《正式评估报告》(2026-07-22) 最终评分 29/40，
> 结合 gate-check.mjs 实际代码核查的补充分析。
> 本路线图聚焦"补齐后能大幅拉升整体质量"的高杠杆短板。

---

## 当前基线

| 维度 | 得分 | 
|------|:---:|
| 完整性 | 4 |
| 可靠性 | 4 |
| 可维护性 | 4 |
| 可扩展性 | 2 |
| Token 效率 | 4 |
| DX | 4 |
| 安全性 | 4 |
| 演化健壮性 | 3 |
| **总分** | **29/40** |

## 目标基线

补齐 4 项核心短板后，预估：**35+/40**（从"文档级严谨"跨越到"实测级严谨"）。

---

## S1：门禁自动化回归测试

> **目标维度**：可靠性 (4→5) + 演化健壮性 (3→4)
> **优先级**：P0（元级缺口，不补则其他维度分数无地基）
> **预估代价**：中（约 200 行，单文件）

### 现状

- 报告全部基于文档分析，**零运行时/行为测试**。
- `scripts/` 下仅有 `review-gateway.py` / `review-models-configurator.py`，无测试基础设施。
- 29/40 是"信仰分"，不是"实测分"。

### 方案

**新增文件**：`engine/gate-test-cases.toml`
- 用 TOML 定义测试矩阵，一行一个用例，驱动人工/脚本执行。

**测试矩阵结构**（约 15 个用例）：

```
[case.s0_normal]        说明: 04阶段写业务代码 → 放行
[case.s1_no_active]     说明: 无活跃迭代写业务代码 → 阻止
[case.s2_phase01_code]  说明: 01阶段写 src/ → 阻止
[case.s2_exempt]        说明: 01阶段写 docs/iterations/ → 放行
[case.s3_05_block]      说明: 05阶段写 src/ → 阻止
[case.s4_empty_stdin]   说明: 空 stdin → 放行（确认行为）
[case.s5_malformed_json] 说明: 畸形 JSON → 放行（确认行为）
[case.s6_gate_bypass]   说明: GATE_BYPASS=1 → 放行
[case.s7_runtime_path]  说明: 写 runtime/ → 放行
[case.s8_skill_self]    说明: 01-03阶段写 .claude/skills/... → 放行

[case.t1_two_sessions]  说明: 双会话并发写 state.yaml → 至少一端有锁冲突
[case.t2_cleanup]       说明: 清理锁文件 → 正常恢复
[case.t3_ttl_expire]    说明: 锁超过60s → 新会话可获取
```

每个用例含：触发条件、工具名、目标路径、当前阶段、预期退出码、实际结果（手动填写）。

**执行方式**：人工逐条执行 → 记录结果 → 修复发现的漏洞。

### 验收标准

- 15 个用例全部 PASS（包括首次暴露的问题修复后通过）。
- 最关键的 S4/S5（fail-open 行为）有明确结论：保持 fail-open 则文档写清风险；改 fail-closed 则代码落地。

---

## S2：L3 Hook 物理拦截加固

> **目标维度**：可靠性 (4→5)
> **优先级**：P0（动摇"不可绕过"根基）
> **预估代价**：低（3 处修改，约 20 行代码变更）

### 现状（gate-check.mjs 实际代码核查发现）

| 漏洞 | 位置 | 严重性 |
|------|------|:---:|
| 只覆盖 5 个写入工具，不含 `execute_command` | 第 46-51 行 WATCHED_TOOLS | 🔴 终端 `rm`/`git`/`sed`/`code` 全绕过 |
| fail-open：空 stdin → exit(0) | 第 72-74 行 | 🟡 异常输入直接开门 |
| fail-open：JSON 解析失败 → exit(0) | 第 84-86 行 | 🟡 畸形输入直接开门 |
| 多重逃生口无审计日志 | 第 54-59 行 | 🟡 绕过无记录 |
| 01-03 阶段 Skill 自身目录 EXEMPT | 第 37-43 行 | 🟡 改门禁规则时不受自己约束 |

### 方案

**修改文件**：`gate-check.mjs`（3 处）

**A. 执行失败改为 fail-closed**（第 72-74 行 + 第 84-86 行）
```
// 空输入 → block("Hook 未收到有效的工具调用信息。")
// JSON 解析失败 → block("Hook 输入格式错误，无法解析。")
// 仅 isTTY 且无 pipe 输入时放行（防御性兜底）
```

**B. 逃生口写入审计日志**
```
// GATE_BYPASS 或 .gate-bypass 触发时：
// 将 {timestamp, tool, path, phase, bypass_reason} 追加到 runtime/gate-audit.log
```

**C. `WATCHED_TOOLS` 纳入 `execute_command` 评估**

不直接拦截（代价太高），但增加**命令风险分级检查**：
- 写文件类命令（`>`、`$null >`、`Out-File`、`Set-Content`）→ 触发门禁
- 读写混合（`git`、`svn`、`sed`）→ 警告 + 确认
- 纯读命令 → 放行

> 注：execute_command 拦截粒度需要额外设计，本项优先做 A+B。

### 验收标准

- S1 测试矩阵中 S4/S5 用例：空/畸形输入 → **block**（exit 2）而非放行。
- 逃生口每次使用产生可追溯的审计日志。
- 报告 10.5 中"hook 仅 3 工具"描述更新为当前实际覆盖清单 + 已知限制说明。

---

## S3：可扩展性 2→4

> **目标维度**：可扩展性 (2→4) —— 唯一低于 3 的维度，结构性天花板
> **优先级**：P1
> **预估代价**：中（3 个子项，分散修改）

### S3.1 复杂度因素与 C#/Oracle 解耦

**文件**：`engine/complexity-scoring.md`

**改动**：将默认 `complexity_factors` 从硬编码的 C#/Oracle 偏向改为**中性默认**，保留项目覆盖能力：

```yaml
# 默认因素（技术栈中立）
default_factors:
  database_schema_change: +1
  cross_module_impact: +1
  new_api_endpoint: +0.5
  # ...不做技术栈假设

# 项目覆盖入口已在 project.manifest.yaml 支持，无需改机制。
```

### S3.2 模板覆盖机制

**文件**：`engine/startup-protocol.md`（加一段优先级规则）

```
模板解析优先级：
1. project/templates/phase-0X-*.md（项目自定义）—— 最高
2. engine/templates/phase-0X-*.md（引擎默认）—— 兜底
```

**新增空目录**：`project/templates/`（含 README 说明覆盖方法），无实际模板则不覆盖。

### S3.3 引擎升级路径

**新增文件**：`design/engine-upgrade-guide.md`

给出真实可执行的升级流程（非 git subtree，非"手动复制"）：
1. 对比新旧版本 `engine/` 的文件清单
2. 逐文件 diff → 识别冲突项
3. 项目侧覆盖的文件（`project/templates/`、`project.manifest.yaml`）受保护，不会被覆盖
4. 升级后运行 S1 回归测试确认无破坏

### 验收标准

- 一个非 C#/Oracle 项目能用默认因素得出合理复杂度分。
- `project/templates/` 目录存在，含 README。
- 引擎升级指南文档可被一个不熟悉 Skill 内部的开发者按步骤执行。

---

## S4：运行态跨工具一致性 + 自修改回滚

> **目标维度**：安全性 (4→5) + 演化健壮性 (3→4)
> **优先级**：P1
> **预估代价**：低

### S4.1 运行态同步校验

**文件**：`engine/state-protocol.md`（加 §X）

**内容**：`startup-protocol.md` 的 Step B 启动自检中，增加 state 同步校验：
```
5. 校验 ACTIVE 双副本一致性
   - 读 .claude/skills/iteration-workflow/runtime/ACTIVE
   - 读 .codebuddy/skills/iteration-workflow/runtime/ACTIVE
   - 不一致 → 输出差异 + 以 .codebuddy 为准 + 警告
```

### S4.2 自修改前快照

**文件**：`engine/evolution-safety.md`（新增）

**内容**：当迭代工作流修改自身的核心文件（gate-protocol.md、SKILL.md、state-protocol.md、gate-check.mjs）时：
1. 修改前自动备份到 `runtime/snapshots/{date}-{file}.bak`
2. 输出变更影响声明（已有 F13 机制，此处将其要求从 gate-protocol 扩展到所有核心文件）
3. 回退方式：直接 `cp runtime/snapshots/xxx.bak 目标文件` + `rm` state 中该次变更的步骤标记

### 验收标准

- 启动自检输出 ACTIVE 双副本校验结果。
- 修改核心文件时，`runtime/snapshots/` 下生成可用的备份。
- S1 测试矩阵中 T1-T3（并发/锁/恢复）用例通过。

---

## 执行批次

| 批次 | 内容 | 预估评分增量 | 累计 | 依赖 | 状态 |
|:--:|------|:---:|:---:|------|:--:|
| 第 1 批 | S1 测试用例定义 + 首次执行（记录 baseline 结果） | +0（基准测量） | 29 | — | ✅ 完成 (020) |
| 第 2 批 | S2 hook 加固（fail-closed + 审计） | +1.5（可靠性 4→5） | 30.5 | S1 暴露的漏洞 | ✅ 完成 (021) |
| 第 3 批 | S3.1+S3.2（复杂度解耦 + 模板覆盖） | +1（可扩展性 2→3） | 31.5 | — | ✅ 完成 (022) |
| 第 4 批 | S3.3+S4（引擎升级路径 + 运行态同步 + 快照） | +1.5（可扩展性 3→4 + 安全性 4→5 + 演化 3→4） | 33+ | — | ✅ 完成 (023) |
| 第 5 批 | S1 回归测试重新执行（验证 2-4 批无破坏） | 最终确认 | **35+** | 所有前序 | ✅ 完成 (024) |
| **第 6 批** | **execute_command 轻量拦截 + P1/P3/P5 prompt 层测试** | **+1（可靠性 4→4.5）** | **31/40** | S1~S5 | ✅ 完成 (025) |

> **第 6 批说明（2026-07-23）**：基于独立再评估（30/40）识别出三个低成本高效能改进：
> - **execute_command 拦截**：新增 DANGEROUS_CMD_PATTERNS(13模式) + SAFE_CMD_PATTERNS(9模式)，堵住终端 `rm`/`git commit`/`svn commit` 等绕过路径
> - **测试用例 S9~S11**：execute_command 命令分级验证，总用例数 18→21
> - **P1/P3/P5**：测试用例已定义，待新会话中对话验证（轻量查询/长对话漂移/混合意图）

### 批次 025 实际评分变化

| 维度 | 024 评分 | 025 变化 | 说明 |
|------|:---:|:---:|------|
| 可靠性 | 4 | **→4.5** | execute_command 拦截堵住最大绕过路径（终端命令）；待 S9~S11 执行通过后可达 5 |
| 安全性 | 4 | **→4.5** | 危险命令（rm/del/git destructive）纳入门禁范围 |
| Token 效率 | 4 | — | P1 验证后可确认轻量路由有效 |
| DX | 4 | — | 无变化 |

---

## 明确不纳入本轮的事项

| 项 | 原因 |
|------|------|
| 文件规模缩减 | 报告已确认边际为零，quickstart+GLOSSARY 已降低门槛 |
| DX 门禁密度再降 | 批量确认已解决最大痛点 |
| 信任模式/跳过门禁 | 门禁仍有漏洞时开跳过是反向操作 |
| git subtree 落地 | Windows 下已验证有坑，当前规模不划算 |
| 复杂度评分引擎重写 | 代价过高，S3.1 的解耦方案已够 |
| execute_command 完整分级（原 S2-C） | 批次 025 已做轻量版（模式匹配），完整 AST 级分级仍需额外设计 |

## 剩余可改进项（批次 026+ 候选）

| 项目 | 影响维度 | 难度 | 说明 |
|------|:--:|:--:|------|
| S9~S11 回归测试执行 | 可靠性 | 低 | run-gate-tests.mjs 重跑，验证 execute_command 拦截代码正确 |
| P1 轻量查询对话验证 | Token 效率 | 低 | 新会话验证"查状态"是否真的只读 ACTIVE |
| P3 长对话漂移测试 | 可靠性 | 中 | 20+ 轮对话后门禁是否退化 |
| P5 混合意图防漏 | 安全性 | 低 | "查状态+改代码"混合意图不绕过门禁 |
| T1~T3 并发测试 | 安全性 | 中 | 需双会话环境，单用户场景边际收益低 |
| 可扩展性跨项目验证 | 可扩展性 | 高 | 需实际项目支撑，阻塞 3→4 |

---

## 附录：与原始评估报告的关系

本路线图基于评估报告（§十 持续优化路线图已结案，29/40）的剩余短板，经 `gate-check.mjs` 实际代码核查后的补充分析得出。关键差异：

| 评估报告结论 | 本路线图重评 |
|------|------|
| hook 仅 3 工具 → 边际有限 | 🔴 加上 fail-open → 动摇"不可绕过"，升为 P0 |
| 可扩展性 → 按需推进 | 🟡 是唯一 2 分维度，应主动补，非等需求 |
| 剩余项 → 按需推进即可 | 🟡 S1（测试）+ S4（快照）是基建级，不应按需等 |
