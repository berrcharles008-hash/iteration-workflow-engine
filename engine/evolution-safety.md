# 引擎演进安全协议（Engine Evolution Safety）

> **本文件 = 引擎自身修改纪律的唯一载体**：① 前置审批（四件套）→ ② 执行安全（快照 / 影响声明 / 回滚）→ ③ 收口验证（三个脚本 + 回流）。
> 关联：审计维度 = `engine/consistency-checklist.md`｜门禁 = `engine/gate-protocol.md`｜元层待办 = `runtime/TOOLING-TODO.md`

---

## 一、适用范围与核心文件

**任何**对本引擎的修改都在本协议范围内：`engine/**` · `scripts/**` · `hooks/**` · `SKILL.md` · `SKILL.template.md` · `engine/templates/**` · 根级文档。

**核心文件**（改动需执行 §三 的快照与影响声明）：

| 文件 | 路径（相对 Skill 根） | 角色 |
|------|------|------|
| gate-check.mjs | 入口 `hooks/gate-check.mjs`（`.claude/hooks/` 或 `.codebuddy/hooks/`，随宿主，转发 shim）→ 实现 `engine/gate/gate-check.mjs` | L3 物理拦截层 |
| gate-protocol.md | `engine/gate-protocol.md` | 门禁规则唯一真相源 |
| state-protocol.md | `engine/state-protocol.md` | 状态文件读写规则 |
| SKILL.md | `SKILL.md` | Skill 入口 + 路由表 + 门禁摘要 |

> ★ **以 `scripts/audit-engine.py` 的 `CORE_FILES` 常量为准**（本表仅为可读副本，避免双源漂移）。
> ★ 原 §一 的手工清单已废止 —— 实测（2026-09-19/20）实改 **12+ 个**引擎文件**无一命中**旧清单 ⇒ 快照从未被触发过。

---

## 二、★ 前置：四件套（硬性前置，2026-09-20 用户立法）

**禁止「先改后报」。** 任何修改前必须先提交：

| # | 内容 | 要求 |
|:--:|------|------|
| ① | **合理性论证** | 须举**真实失效案例**或结构性证据（举不出 = 臆测，当场作废） |
| ② | **关联影响分析** | 列全联动文件与残留引用；★ **逐个 `read_file` 实证** —— 禁止只凭全文检索断言（实证其会漏报） |
| ③ | **完整方案** | 逐文件「现值 → 改为 → 理由」 |
| ④ | **方案准确性自评** | 自证薄弱点 / 不确定项 |

⇒ **等用户明确确认后方可动手**。改完必须给出**可观测、可评估**的验证方式与判据（命令 + 期望输出）。

> **来由实证**（2026-09-20）：P0 因跳过 ①② 直接改 ⇒ 把"应执行"误当 `mandatory` 强制 + 漏扫 2 处联动。

---

## 三、执行安全（核心文件）

### 3.1 修改前快照

```
1. 创建快照目录（如不存在）：runtime/snapshots/
2. 复制当前版本：cp <核心文件> runtime/snapshots/{YYYY-MM-DD}-{文件名}.bak
```

命名规范：路径中的 `/`、`\` 替换为 `-`（例：`engine/gate-protocol.md` → `gate-protocol.md.bak`）。快照不自动清理，07 阶段可清理已验证无用的旧快照。

### 3.2 变更影响声明

```
╔═══════════════════════════════════════════════════════╗
║  ⚠️ 核心文件变更影响声明                              ║
║                                                       ║
║  文件：engine/gate-protocol.md                        ║
║  变更类型：修改门禁规则                                ║
║  影响范围：所有迭代的代码修改门禁检查                  ║
║  快照位置：runtime/snapshots/xxx-gate-protocol.md.bak  ║
║  回滚方式：cp snapshots/xxx.bak engine/gate-protocol.md║
║                                                       ║
║  是否继续？[Y/n]                                      ║
╚═══════════════════════════════════════════════════════╝
```

### 3.3 回滚

```bash
# 1. 从快照恢复（按宿主选对应快照）
cp runtime/snapshots/{YYYY-MM-DD}-{文件}.bak <目标路径>
# 2. 复位 state.yaml 中该次变更涉及的步骤为 pending
# 3. 跑回归验证
node scripts/run-gate-tests.mjs
```

无快照时的恢复来源：`git show HEAD~1:<文件>` · 源仓库副本 · 其他项目实例的 `engine/`（须确认版本一致）。

---

## 四、★ 收口验证（改完必跑，缺一不可）

> ★ **执行前提（2026-09-20 实测补充）**：下表命令**一律从项目根执行**（IDE 终端的默认 CWD）。
> 原行 1~3 写成 `scripts/…` 相对路径、行 2 写 `--skill-dir .` —— 二者都**默认 CWD = skill 根**，
> 从项目根照抄执行必崩（实测：`FileNotFoundError: .\engine\startup-protocol.md`）。

| # | 命令 | 期望判据 |
|:--:|------|------|
| 1 | `python {IDE}/skills/iteration-workflow/scripts/audit-engine.py` | **ERR 0**（WARN 需登记 `runtime/TOOLING-TODO.md`） |
| 2 | `python {IDE}/skills/iteration-workflow/scripts/validate-template-coverage.py --skill-dir {IDE}/skills/iteration-workflow` | `ERR:0` |
| 3 | `node {IDE}/skills/iteration-workflow/scripts/run-gate-tests.mjs` | BASE 0 失败 / FIX 全过 |
| 4 | `python {IDE}/skills/iteration-workflow/scripts/memory_quota.py --index-check` | **新增（MAINT-3 P-4 · 2026-09-22）**：`RESULT: PASS`（errs=0）—— 外置分片索引一致性（§一登记路径 / 分片无孤儿 / 单分片 ≤20KB / `MEMORY.md` 指针可达） |
| 5 | 回流水位 | `python {IDE}/skills/iteration-workflow/scripts/audit-engine.py --src <源仓库>`；不一致 ⇒ **登记 `AUDIT-n`**（回流无自动化机制，须人工） |

> **收口结果写入** `runtime/TOOLING-TODO.md` 对应工单的「实施记录」；无对应工单 ⇒ **新建 `AUDIT-n`**。

---

## 五、逃生口纪律

- 改 `hooks/**` 等**不在** `EXEMPT_PATHS` 内的文件时，需用户**手动**开闸：`{IDE}/hooks/.gate-bypass`（或 `GATE_BYPASS=1`）。
- ★ **01-03 阶段改 `{IDE}/skills/iteration-workflow/**` 无需开闸**（`EXEMPT_PATHS` 放行；见 `gate-protocol.md` §四）。
- 逃生口**用完即删**；**收尾必检：标记已删**（2026-09-20 曾发生"空标记遗留 ⇒ 门禁长期全放行"）。

---

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-23 | 初版：核心文件快照 + 变更影响声明 + 回滚路径（解决新 clone 项目无版本历史时的回滚困境） |
| 2026-09-20 | ★ **与「先批后改」合并为本协议**：四件套升为 §二**硬性前置**；核心文件清单改为"以 `audit-engine.py` 的 `CORE_FILES` 为准"（旧 4 文件手工清单实测裸奔 59 天、从未触发）；新增 **§四 收口验证**（3 脚本 + 回流水位）；新增 **§五 逃生口纪律**（含 01-03 免开闸口径） |
| 2026-09-20 | §四 命令行的 **CWD 前提** 补注 + 三行改为项目根可执行的全路径：原 `--skill-dir .` 从项目根执行必崩（实测 `FileNotFoundError: .\engine\startup-protocol.md`，即按文档照抄 → 收口第 2 项**永远失败**） |
| 2026-09-23 | ★ **首次按「四件套 + 快照 + 收口」全流程执行元层改造**（工单 `runtime/TOOLING-TODO.md` `DEFECT-1`，**12 文件** = 引擎 8 + 模板 3 + `SKILL.md`）：用户**手动开闸**（PHASE=05）→ 3 个 `CORE_FILES` 快照 → 落盘 → 收口（`audit-engine.py` **ERR 0** · `validate-template-coverage.py` **ERR:0** · `run-gate-tests.mjs` **28/28** · `memory_quota.py --index-check` **PASS**）→ 删标记复核。★ 实测补正：`skills/**` 在 **05-07 阶段同样需开闸**（原 `SESSION-HANDOFF.md` 表述遗漏）⇒ 已同步该页 |
| 2026-09-29 | ★ **本文件纳入 P0 路径变量化**（`.codebuddy` 前缀 → `{IDE}`）：§四 收口验证表 1~5 条命令（6 处）；同时按记账纪律补本行，避免 A5「引擎已改、规范未跟」告警（迭代 `2026-09-29-001-Team协作模式与宿主抽象`；`{IDE}` 解析约定见 `startup-protocol.md` Step A） |
| 2026-10-02 | ★ **§一「核心文件清单以 `CORE_FILES` 为准」在实现外置后首次校正**：`engine/gate/gate-check.mjs` 取代 `hooks/gate-check.mjs`（后者自 HOOK-SLIM-1 起仅为转发 shim）；即「改实现」自此在快照 + 影响声明覆盖内。同步记账（迭代 `2026-10-01-002-引擎窄放行与遗留收口`，E-0/E-3；`audit-engine.py:41-46` 已改）。★ 另记：skill 内 `engine/**`、`scripts/**` **不入版本库**（`.gitignore`）⇒ §3.3 的 `git show HEAD~1` 回滚路径**不成立**，快照是唯一回滚源 |
| 2026-10-03 | ★ PERF-1 同批 engine 联动**补记（原漏记，触发 A5-b WARN 2 个，ENG-AUD-A5）**：`state-protocol.md`（§9.6 脚本通道 + §6.2 `UPDATED` 字段）· `phase-04.md` · `team-agent-strategy.md`（Team 并发上限）——内容详见 `runtime/TOOLING-TODO.md` PERF-1 实施记录 |
| 2026-10-07 | ★ **TOOL-QQGATE 甲档实施**（用户拍板，元层工单）：`engine/gate/gate-check.mjs`（**CORE_FILE，快照 `2026-10-07-gate-check.mjs.bak`**）新增 `checkUnregisteredUserConfirm()` ≈100 行纯新增——G1 观测期确认点 QQ 门登记校验（pending `-user-confirm` 步骤 + service.log `[ASK #N]` 行 vs `last_updated`，未登记 ⇒ notify.qqbot.js 直发单向提醒；超时态豁免；独立去重 `qq-g1-notify.json`；全程独立 try/catch 不影响既有阻断通知链）+ `runStopCheck()` 开头挂接 + import 补 3 个 fs 方法；同批 `waiting-protocol.md` §5 补判定入口指针。验证：`node --check` 0 错 + run-gate-tests **48/48** + audit ERR 0 + template PASSED + memory_quota PASS。3 路评审/四件套/分档：`runtime/TOOL-QQGATE-*.md`。同批补记 2026-10-03 行（清偿 ENG-AUD-A5） |
| 2026-10-09 | ★ **TOOL-07PH 规程增补**（元层工单 · 用户指令即时处理 · 3 路评审裁定 = **零代码方案**，撤销 `phase-close` 新命令提案）：`phase-07.md` §6.2 新增「① 登记 07 完成条目」——07 归档先手写 `phase_history` 07 条目（2/4 空格缩进 / 值带双引号 / 分钟级 completed_at）+ `phase_status→completed` + `validate-state.py` 显式 canonical 路径校验 + `state-apply summary` 归一（P-130 模式，隔离演练 2026-10-09 实证双副本镜像），之后才释放 ACTIVE；★ 根治 = 07 归档漏写条目 ⇒ align 无 07 窗 ⇒ 阶段消耗永无 07 行（2026-10-08-001 实证）；3 路评审记录 `runtime/TOOL-07PH-评审-3路.md`；本行补记清偿 A5 联动 |
| 2026-10-10 | ★ **TOOL-INTV A 批实施**（元层工单 · 用户拍板分两批 · 开闸实施〔QQ 确认 #19，ttl 240，收口后 revoke〕）：**6 文件** = `engine/phase-01.md`（step-2-5「复述确认 → 动态追问 → 5W2H 兜底」）· `engine/phase-steps.md`（v1.9 同名同步，零新增步骤 ID）· `engine/templates/phase-01-需求记录.md`（附录 C 改名 + §4.1「业务规则」栏）· `engine/phase-02.md`（必须/建议分层 + 需求歧义消解 + 澄清复审轮）· `engine/cross-review-protocol.md`（v2.3 适用域注记）· `engine/templates/phase-02-需求评审.md`（澄清轮次行 + §3.1 业务规则确认表 + 等待指针）。收口（开闸态实跑）：`audit-engine.py` **ERR 0 / WARN 2**（= 基线，零新增）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47**（= 基线）· `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` **ACTIVE=19**（基线 17，+2 为 S4 迭代 `2026-10-10-001` 模式沉淀 P-139/P-140，**非本批引入**；DUP=none）。依据 `runtime/TOOL-INTV-四件套.md` v2 + 探针 `runtime/TOOL-INTV-实施探针-2026-10-10.md`；B 批（9 文件）顺延下个 01-03 窗口 |
| 2026-10-10 | ★ **TOOL-INTV B 批实施**（元层工单 · 用户拍板分两批 · none 态开闸实施〔QQ 确认 #20，ttl 240，收口后 revoke〕）：**前置 = 第四批模式蒸馏**（活跃 19 → 10 条，移入 P-108 / P-116 / P-123 / P-124 / P-126~P-130；脚本 `runtime/distill-2026-10-10.mjs`）。**9 文件** = `engine/phase-04.md`（Step 5.5b 模式候选登记：代码块行 + 新小节 + 交付标准）· `engine/phase-07.md`（Step 3 附节「知识资产抽取」+ 交付标准）· `engine/startup-protocol.md`（惰性加载表新增 `project/lessons-learned.md` 行；engine 行不动）· `engine/lessons-learned.md`（置信度列 14 行 + §七 触发条件改 01-03 窗口 + 置信度维护段 + 顺带项 3 处）· `project/lessons-learned.md`（第四批蒸馏 + 模式候选区新增 + 置信度列 10 行 + 顺带项 :8 计数归一）· `engine/templates/project-lessons-learned.example.md`（置信度列）· `engine/context-discipline.md`（01 行模式库注入）· `engine/templates/phase-07-迭代回顾报告.md`（:60 指向 engine→project）· `engine/consistency-checklist.md`（变更记录补行）。**并入 A 批复核遗留 N1/N3/N5**（`phase-01.md` ×2 · `phase-02.md` · `templates/phase-02-需求评审.md`）。收口（开闸态实跑）：`audit-engine.py` **ERR 0 / WARN 2**（= 基线，零新增；四件套预期 WARN 3 中 A4 新增项**未触发**）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47**（= 基线；R1 七 phase 全 clean）· `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` **ACTIVE=10 / DUP=none**（蒸馏后）。回流水位：A6 WARN 17 项（源仓库滞后，含 A+B 批 15 文件 ⇒ 待回流窗口）。快照（**改动前**全量 15 文件）：`runtime/snapshots/2026-10-10-intv-b/`。依据 `runtime/TOOL-INTV-四件套.md` v2 §③ B 批 + `runtime/TOOL-INTV-B批开工交接.md`。★ **同日复核（7 维度）2 处 🔵 前缀项已开闸修正**（QQ #21 / ttl 60）：`phase-04.md` §5.5b 与 `startup-protocol.md` 惰性加载行的 phase 引用补 `engine/` 前缀（对齐同文件惯例）；修正后 audit/validate 复跑 = 基线 |
| 2026-10-10 | ★ **BOARD-1 落地**（元层工单 · 用户拍板「选 B：规程 + 代码加固」· 04 窗口免开闸〔#23 `2026-10-10-002` PHASE=04〕）：`engine/phase-07.md` §6.2 新增「③ 刷新机器投影」（② 释放 ACTIVE 之后：`refresh-metrics.mjs --force` 全链 + `gen_doc_index.py`；三条判据 = 07 行出现 / BOARD.md 不再指向本迭代 / INDEX.md 终态一致；含 06 口径备忘、失败兜底、P-088 次序说明）· `engine/phase-steps.md` step-6-archive 描述补"刷新机器投影"（保 ID）· `runtime/metrics/refresh-metrics.mjs` **代码加固** = 6h 节流叠加「`phase-aggregates.csv` 结构 hash 未变」条件（`.last-board` 升级双行；旧格式/缺 hash ⇒ 触发一次重刷，向后兼容）。根治：迭代收尾投影过期（10-08-001 / 10-10-001 两次用户误判为统计缺陷）。收口：`audit-engine.py` **ERR 0 / WARN 2**（= 基线，A4 零新增）· `validate-template-coverage.py` ERR:0/WARN:1 · `run-gate-tests.mjs` **48/48** · `memory_quota --index-check` **PASS** · A6 回流水位 42 项（源仓库滞后，含本批 3 文件 ⇒ 待回流窗口）· 三路径实测 T1/T2/T3 全绿 + board 耗时复测 2.9s。依据 `runtime/BOARD-1-四件套.md` v2 + `runtime/BOARD-1-评审-3路.md`；快照 `snapshots/2026-10-10-board1/` |
| 2026-10-10 | ★ **TOOL-CAPMAP 实施**（元层工单 · 04 窗口**免开闸**〔#23 `2026-10-10-002` PHASE=04 + 无 dispatch_whitelist，实施前重读双副本确认〕· 用户拍板）：**新建** `engine/capability-map.md`（11 域 · 78 项能力索引 + 状态标记 + 缺口汇总；索引层，细则以落点文件为准）+ `engine/startup-protocol.md` 惰性加载表 +1 行 + skill 根 `README.md` **中英双版各 4 处**（目录树新增 capability-map / doc-style-guide / gate/ + templates 段 agent-prompt-examples 子项〔原 `└──` 行同步改 `├──`〕= 3 处 drift 修复；双版各 1 指针句）+ `SKILL.md` 1 行指针（**CORE_FILE ⇒ 已入快照**）。收口实测：`audit-engine.py` **ERR 0 / WARN 2**（= 基线零新增；A1 42/42、A4 零新增实证 = 地图 49 引用全存在）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47**（= 基线）· `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` **ACTIVE=10 / DUP=none** · doc_lint 地图 **ERROR 0 / WARN 23**（D4 🆕 + D1 长格，登记不修）· 行尾全绿 · 回流水位 **A6 WARN 19 项**（engine 16 + scripts 3；源仓库最后提交 2026-10-09 17:17；本批 3 文件在面内；较 B 批记录 17 项 +2 = 本批新建 1 + 1 项 B 批未存逐项名单待核 ⇒ 回流窗口统一）。快照 `runtime/snapshots/2026-10-10-capmap/`（before/ 5 文件 + ROLLBACK-PATCH.md）
| 2026-10-10 | ★ **METRICS-6 实施**（元层工单 · 用户拍板「全量采纳 O1~O7」· 04 免闸窗口〔#23 `2026-10-10-002` PHASE=04 + state 无 `dispatch_whitelist`〕）：`runtime/metrics/phase-align.mjs` **输出层 +6 行** = 0 轮实做窗补占位行（遍历 `it.wins`、`rec.wins.has(w)` 跳过有轮窗 ⇒ `newBucket()` + note「该阶段窗内无模型轮次」；各列恒 0 ⇒ 每迭代 Σ 对账恒等不涉；头注 +1 句）· `engine/phase-07.md` §6.2 ③ 口径备忘改「两类看不到行」（有窗 0 轮 ⇒ 占位行；零宽窗 ⇒ 无窗可占位、仍无逐阶段行 + 指向 METRICS-7）· `tools/gen_iteration_board.py` 口径行 +1 句（阶段消耗投影与 `board.html` 孪生文案）+ `fmt_note` 连续分隔符折叠（本批引入的 `;;` 渲染瑕疵根治）· `docs/iterations/README.md` +1 行口径。动机：用户**两次**追问「06 走了阶段却没有统计」（`2026-10-10-001` 实证：06 窗在、窗内 0 落轮 ⇒ 旧口径不出行）。收口实测（免闸态实跑）：CSV 181 → **211** 行（键级 **新增 30 / 删除 0**，新增行各列全 0；重复键 delta 0；33 迭代 Σ(阶段+unphased)==iteration-total 全 PASS）· `refresh-metrics --force` 汇总 `sanity=PASS phase=ok board=ok` · `audit-engine.py` **ERR 0 / WARN 2**（= 基线，A4 零新增）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47** · `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` ACTIVE=10 / DUP=none · A6 回流水位 **42 项**（源仓库滞后，`engine/phase-07.md` 在面内 ⇒ 待回流窗口）。依据 `runtime/METRICS-6-四件套.md` v2 + `runtime/METRICS-6-评审-3路.md`；快照 `runtime/snapshots/2026-10-10-board1-ext/`（before/ 7 文件 + evidence/ 10 件） |
| 2026-10-10 | ★ **回流 2026-10-01~10-10 批次 + A6 口径护栏**（元层维护 · 开闸窗口）：26 文件回流（engine 50 / scripts / domain-plugins / SKILL.md / README.md 全层 0 差异）；**并回源侧独有夹带**（`phase-04.md` / `waiting-protocol.md` 的「可选工具前置判据」+ `audit-engine.py` EXTERNAL_TARGETS 补 4 个 qqbot 脚本）；`scripts/audit-engine.py` 新增 **A6 上级目录误传护栏**（`--src` 传 `D:\sj-skills` 而非引擎仓库根 ⇒ 此前恒定「42 项源仓库缺失」假水位，同日修正）；口径同步 `consistency-checklist.md` §一/§二 与本节 §四 第 5 项。回流后实测 `audit-engine.py --src <引擎仓库根>` = **[OK] A6 与源仓库一致** |
