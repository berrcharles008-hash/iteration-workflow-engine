# 阶段五：05-测试验证（★ 自动生成用例 + 能跑则跑）

**目标**：自动生成测试用例 + 能自动化则执行 + 不能则降级手动。

### Step 0：前端构建验证（涉前端变更时强制）

> 详细命令见 `project/build-verify.yaml` → `frontend`。

```
1. 检查是否有新增依赖 → 有则执行安装命令（`frontend.install_command`），无则跳过
2. 执行构建命令（`frontend.build_command`）→ 必须满足 `frontend.success_criteria`
3. 执行开发服务器启动命令（`frontend.dev_command`）→ 必须能正常运行
```

若构建环境不可达，按 `frontend.fallback` 降级处理。

> ★ **执行方式注记（2026-09-25 SLIM-1 C-1）**：本步骤默认下沉 code-explorer 子代理执行 —— prompt 必附 `project/build-verify.yaml` 对应命令（含 msbuild 完整路径等环境事实）+ **禁改源码与文档文件**（依赖安装目录与构建产物 node_modules/dist/bin 等由命令自身写入除外）+ **dev server 启动不下沉（留主 Agent）**+ phase_steps 勾选、defects[] 登记、05 报告写入一律主 Agent + 构建环境不可达的 fallback 降级**决策**留主 Agent（子代理只回报现象）。
> **回报格式**：exit code + 成功判据逐条 + **逐条覆盖每条失败用例**的错误摘要 ≤50 行；日志文件路径仅当命令自身落盘（如 msbuild `/fl`）或主 Agent 预建路径时提供，否则 stdout 摘要为唯一证据——不回灌全量日志。
> **降级 fail-open（四态）**：子代理不可用 / 宿主异常 / 回报缺失或截断（视为不可信）/ 单路超时（墙钟上限 **10 分钟**）/ **命令需交互输入** ⇒ 主 Agent 直跑或重派；重跑前按 `team-agent-strategy.md` §八确认命令幂等，禁止假设已完成直接重派；执行方式在 05 报告注明。
> **并发红线随附**：单批 ≤3 路、单路上下文 ≤15 万 token、探索类 max_turns ≤2（同 `team-agent-strategy.md` §二维度五/§七，引用不复制）。

### Step 0.5：合规检查（★ 强制）

> 在 step-0-frontend-build（前端构建）之后、step-1-generate-cases（生成测试用例）之前执行。

**目的**：在测试阶段开始前，对交付物进行合规检查，避免低级错误遗留到后续阶段。

**规则集（4 条通用规则）**：

| # | 规则 | 检查方式 | 说明 |
|---|------|---------|------|
| 1 | 文件路径一致性 | `read_file` 逐个验证 | 文档中引用的所有文件路径是否都存在 |
| 2 | 镜像面自洽（★ SYNC-PASSIVE-1） | `read_file` 本侧 ACTIVE/state + `validate-state` | **不判两侧一致**：硬判据 = 本侧 `ACTIVE` 与 `<id>.state.yaml` 可解析且 `validate-state` ERR 0；跨侧 `version` 差异**只报告**（不判失败、不触发收敛）；单侧运行产物不参与判定；**Agent 不代跑 `sync`**（细则见 `startup-protocol.md` B.3） |
| 3 | 引擎 Markdown 结构规范 | `read_file` | 模板完整、标题层级正确、必填章节存在 |
| 4 | 跨文档引用一致性 | `read_file` + 人工校验 | 引用链接不悬空 |

**执行输出**：检查报告，列出每项规则的通过/失败状态：

```
📋 合规检查报告：
✅ 规则1：文件路径一致性 — 全部 N 个路径存在
✅ 规则2：镜像面自洽 — 本侧 ACTIVE + state 可解析（ERR 0）；跨侧 version 差异：无（仅报告，不判失败）
✅ 规则3：引擎 Markdown 结构规范 — 全部模板完整
⚠️ 规则4：跨文档引用一致性 — X 处链接需确认
```

**职责边界**（不与 04 阶段检查重复）：

| 阶段 | 检查项 | 目的 |
|------|--------|------|
| 04 `step-4-csproj` / `step-6-spec` | 命名空间、继承关系、目录位置、类名后缀 | 代码与技术方案一致 |
| 05 `step-0-5` 合规检查 | 文件路径一致性、镜像面**自洽**（本侧；跨侧 version 差异仅报告，不跑 sync）、文档结构、引用一致性 | 交付物与规范一致 |

### Step 0.6：后端真库冒烟（★强制 · 2026-10-30 新增）

> 详细命令与判据见 `project/build-verify.yaml` → `sql_smoke`。

**为什么强制**：NUnit 跑在独立测试 schema（`SJ_PIVAS_TEST`），E2E 全桩化（`installMock` 拦 `/webapi/**`）⇒
「真库 SQL 语法 / 列名 / 映射」这一层曾**没有任何自动手段**，D-3（`as ROWID` ⇒ ORA-00923）在四道防线全绿时完全不可见。

```
1. 编译 Console：msbuild "back-end/IntravenousAdmixtureCenter/SJ.PIVAS.AdmixtureCenter.Console.sln" /p:Configuration=Debug /t:Build /v:minimal
2. 业务库只读冒烟：bin\Console.SJ.PIVAS.AdmixtureCenter.exe --sql-smoke
3. 测试库写路径闭环：bin\Console.SJ.PIVAS.AdmixtureCenter.exe --sql-smoke --test-schema
```

**判据**：两条均 EXIT 0 且输出无 `FAIL` 行。`SKIP` 允许但必须附原因（鉴权前置 / 数据前置不足）。
**★改 `Console/Program.cs` 后必须编 Console.sln** —— Web.sln 不含 Console 项目，只编 Web.sln 会让新分支静默不生效。

### Step 1：自动生成测试用例

每条用例标注：编号（TC-{层}-{序号}）、验证目标、自动化标记（自动/手动）、验证方式、预期结果。

生成规则从 `project/build-verify.yaml` → `test_strategy` 读取：
- 每个新增文件 → `test_strategy.new_file_check`
- 每个新增 API → `test_strategy.new_api_check`
- 每个 CRUD 页面 → `test_strategy.crud_page_check`（自动化标记由 `e2e_framework` 决定）
- 物理设备/第三方依赖 → `test_strategy.hardware_third_party`（标记为手动）
- ★ 本轮改动影响的用户可见行为 → 用户动作链（2026-09-18 新增；内置规则，无需配置）：
  对每条被改动的路径追问「用户怎样走到它、走完之后会看什么」，把上下游动作纳入用例
  （例：改保存/提交逻辑 ⇒ 必测「保存 → 回列表/详情看结果」；改首屏渲染 ⇒ 必测「硬刷新」）。
  理由：改动可能落在既有文件的**副作用路径**上（不在"新增文件 / 新增 API"清单内），
  仅按结构规则生成用例会漏测。

### Step 2：用户审核用例（可选）

### Step 3：自动执行【自动】用例

先探测环境（文件系统/后端 API/dev server），就绪则执行，不就绪则降级手动并记录原因。

> ★ **执行方式注记（同 Step 0 SLIM-1 C-1 约束）**：自动用例执行默认下沉 code-explorer 子代理（prompt 同附 `build-verify.yaml` 命令与禁改约束 + 同一回报格式 + fail-open 四态）；★ **下沉派发前主 Agent 先验证 dev server/环境进程存活，不存活走既有降级**。

### Step 3.5：真链路全页面矩阵 + 端点覆盖对账（★强制 · 2026-10-30 新增）

> 详细命令、三级判据、棘轮口径见 `project/build-verify.yaml` → `real_link_pages`。

**为什么强制**：28 个 E2E spec 全桩化（`installMock` 拦 `/webapi/**`）⇒ 桩化 E2E **一行后端 SQL 都不执行**；
NUnit 直调 BLL **不经 Web 路由**（只做反射断形参）。于是「HTTP 路由名 / DTO 绑定 / 权限码位置」整层无人覆盖。
2026-10-30 实跑取证：界面调用 **138 个端点**，真链路仅覆盖 **35 个（25.36%）**。

```
1. node tools/gen-pivas-endpoints.mjs --check     # 端点清单与源码漂移 ⇒ 必须先重建再跑，否则分母错
2. npx playwright test r_real_smoke_pages --output ../../.codebuddy/temp/pw-results-<唯一后缀>
   （cwd = front-end/pivas_admixture_center；需 dev server 8080 + 后端 6337 同时常驻）
3. npx playwright test r_real_smoke               # 深链路（点动作）2 例
```

**判据（★三级不可合并）**：

| 级 | 现象 | 是否计入真覆盖 |
|:--:|:--|:--:|
| L2 | 有请求且 `C === 0` | ✅ |
| L2b | 有请求、`C !== 0` 但 `T` 不含 `AUTH_`（业务拒绝，其前 SQL 已执行） | ✅ |
| L1 | 有请求但 `T` 含 `AUTH_`（判码在取数之前，**SQL 未执行**） | ❌ 单列 |
| L0 | 无请求（前端前置拦截 / 动作未点） | ❌ 单列 |

**硬门禁**：① 全部页面 0 次 HTTP ≥ 400；② 0 次响应含 `ORA-`；③ 每页命中 > 0；④ 端点真覆盖数 ≥ 棘轮基线。

**报告义务**：L1 / L0 清单**逐条**写进 05 报告（可归并为分档表，但不得只写总数）；
本迭代 `03-技术方案` 涉及的端点必须全部落 L2/L2b，否则计缺陷。
写端点的真库覆盖走 `Step 0.6` 的 `--sql-smoke --test-schema`，**不**靠点写按钮。

### Step 4：生成测试报告

输出 `05-测试验证/05-测试验证报告.md`（模板：`phase-05-测试验证报告.md`，🟢简单用 `phase-05-测试报告-lite.md`，优先级见启动协议 §模板解析优先级）。

> **版式纪律**：产出文档须遵循 `engine/doc-style-guide.md`（用例表 ≤6 列、结果证据用列表不用长单元格）；生成后自检 `python scripts/doc_lint.py <文件>`（ERROR 必修）。

**缺陷分诊与台账登记（★ 强制 · 2026-09-23 DEFECT-1 新增）**：

> 每条「失败 / 待修复」用例都必须落到缺陷台账 —— 否则 06 推进会被三-C 拦（`gate-protocol.md` §三-C：存在 `open` 缺陷禁止推进）。

1. 逐条登记 `state.yaml` 的 `defects[]`（`id: "D-1"`… / `severity` / `root_cause_level` / `design_changed` —— ★ 后者**须用户确认**）；
2. 按根因档选通道（判据见 `workflow-engine.md` §缺陷根因判定判据）：**L1** → 回退 04 走 `step-fix-*` 修复窗口；**L2** → 回退 03（先改 03 再改码）；**L3** → 回退 01/02；
3. 修复后回归：**既有用例结果不回改**，新增用例**续接编号**；
4. 报告「五、缺陷记录」节与 `defects[]` 按 `D-xx` **双向对账**；未修者转「七、遗留问题」并置 `status: "deferred"` + `defer_reason`（用户裁决）；
5. **机制标记（★ 2026-11-01 批 2 新增）**：缺陷描述**末尾**追加 `[MECH:<码>]` —— **仅当**该缺陷本可被某个**已建机制**拦截（例：列表列与 03 §2.3.1 不一致 ⇒ `[MECH:M4]`）。码表**不在本文件复述**（SSOT = 项目侧《机制有效性台账》§2；`M1`~`M6` 依次 = 列定义表 / 检索条件表 / 契约落地 / spec-parity / 原型 parity / 渲染清单）。**前缀 `[MECH:` 是唯一判据**，与模块代号 `M1~M11` 无关；只标新登记缺陷，历史不追溯。

**交付标准**：所有自动用例 ✅ 通过或 ⚠️ 跳过（有解释），手动用例 ⏳ 待验证，用户确认"测试通过"；**文档版式自检 ERROR 0**（`python scripts/doc_lint.py <文档>`）；★ 缺陷台账与报告**对账一致**

★ **页面型迭代附加判据（2026-11-01 批 2 新增）**：03 方案含 §2.3 两表（列定义表 / 检索条件表）的迭代，05 报告**必须**含「平台渲染验收清单」节且 8 项逐项有勾选或证据 —— **缺节即视为 05 未完成**（模板见 `phase-05-测试验证报告.md` 同名小节）。
★ 本阶段确认点（测试通过 / design_changed / deferred 裁决）的等待方式（A/B/D + 时限/退化）见 `engine/waiting-protocol.md`。

**动作链覆盖**（2026-09-18 新增；标准版 / 精简版报告**均必填**）：

- 报告须含「改动路径 → 用户/调用方动作 → 用例编号」映射（模板见两份测试报告模板的「动作链覆盖」节）；
- **未覆盖的改动路径必须逐条写明理由**；
- 目的：把"改动影响的上下游动作"纳入用例（防副作用路径漏测），并留下可复核的覆盖证据。

### 步骤清单（进入阶段时写入 phase_steps）

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-0-frontend-build | 前端构建验证 | ✅ | 涉前端变更 |
| step-0-5 | 合规检查（4条规则集） | ✅ | 始终 |
| step-0-6-backend-sql-smoke | 后端真库冒烟（`--sql-smoke` + `--test-schema`） | ✅ | 始终（2026-10-30 强制化） |
| step-1-generate-cases | 自动生成测试用例 | ✅ | 始终 |
| step-2-user-review | 用户审核用例 | — | 可选 |
| step-3-execute | 自动执行【自动】用例 | ✅ | 始终 |
| step-3-5-real-link | 真链路全页面矩阵 + 端点覆盖对账 | ✅ | 始终（2026-10-30 强制化；需 8080+6337 常驻，不可达 ⇒ 降级手动并登记 `deferred` 理由） |
| step-4-output | 生成测试报告 | ✅ | 始终 |
| step-fix-05-1-register | 缺陷登记（`defects[]` + 根因分档 + `design_changed` + `[MECH:*]` 机制标记（可被已建机制拦截时必填）） | — | 存在 `open` 缺陷 |
| step-fix-05-2-code | 就地修复编码（**05 期预授权窗口内自主修**；窗口未开 ⇒ 先发一次预授权卡；涉后端码 ⇒ 回 04） | — | 上一步完成 |
| step-fix-05-3-regress | 失败用例回归（既有结果不回改、新增续接编号） | — | 上一步完成 |
| step-fix-05-4-reclose | 缺陷关闭（`fixed` + `verified_by` + `fix_files` 对账） | — | 回归通过 |

> ★ **05 侧缺陷修复窗口（2026-10-02 E-2 新增）**：SSOT 见 `phase-steps.md` §阶段五。要点：
> ① 仅 **L1 且不涉后端码**可就地修（`defects[].gate_window` + `fix_files` 必须成对，机器校验 = §3.3 R8）；
> ② 涉后端码 / 需 `/t:Rebuild` ⇒ **回 04** 走 `step-fix-*`；③ 禁止再自造游离步骤块。
>
> ★ **05 期开闸 = 阶段级一次预授权（2026-10-19 用户拍板方案 A · 工单 FIX-ALLOW-1）**：
> - **时机**：进入 05 阶段（或首个需就地修的缺陷出现）时发**一张**预授权卡，用户 QQ 确认**一次**：
>   `node tools/qqbot/request-confirm.js --prompt "05 期就地修复预授权：覆盖本迭代 05 期全部 L1 不涉后端码缺陷，TTL <N>" --command "node tools/gate/open-bypass.js --ttl <N>"`
> - **窗口内逐缺陷修复不再逐条发卡**（这是方案 A 的全部收益：确认次数 N ⇒ 1）；
> - **TTL**：240（半日）/ 480（全天，`open-bypass.js` 上限）；跨天或窗口被并行会话 `--revoke` 连坐关闭 ⇒ **重发同一预授权卡**（恢复同一授权，非新决策）；
> - **每缺陷仍必做**：`gate_window`（记 confirm id + 时段）+ `fix_files` + 回归 + 关闭（R8 对账不变）；
> - **收口（推进 06 前）必做**：`node tools/gate/open-bypass.js --revoke` + 关闸负向对照（05 期业务区探针被拦）+ `gate_window` 逐条对账；
> - **边界**：预授权**不**改变「Agent 不得自建 `.gate-bypass`」红线（GAP-4）；**不**覆盖 L2/L3、涉后端码、06/07 阶段或元层（`skills/**`、`hooks/**`）——元层改动仍单独确认；
> - **验收判据**（观察义务）：单迭代 05 期 OPEN 次数 ≈ 阶段天数（1 次/天）而非缺陷数；`gate_window`/`fix_files` 零缺失；收口 revoke + 对照有留痕。
>
> ★ **元层探针类动作（2026-10-26 新增）**：判据自证类用例需临时写 `engine/**` / `scripts/**`（元层），而 `stageExempt['05']` 不放行 `skills/**` ⇒ 该类动作须走**用户授权 TTL 窗口**，并做三件套：
> ① 授权留痕（TTL 时长；缺陷类另记 `gate_window`）；
> ② **立即还原**（探针零残留，用 `Select-String <探针标记>` 自证命中 0 处）；
> ③ `revoke` 后**关闸负向对照**（再发一条写语义命令应被拦，证明闸确实关回）。
> **禁止**把 `skills/**` 加进阶段豁免表 —— 那等于永久放开元层写入，与 GAP-4 红线反向；窗口式一次性授权才是正解。
