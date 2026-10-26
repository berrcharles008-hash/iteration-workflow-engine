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

> **实施记录（2026-10-25 · 迭代 `2026-10-25-003`）**：本轮 2 个核心文件（`engine/gate-protocol.md` / `engine/state-protocol.md`）
> 改动前已做**目录式快照** `runtime/snapshots/2026-10-25-003/before/`（26 路径 = 24 修改 + 2 待删；含两核心文件）。
> 为什么不用逐文件 `.bak`：本次同时改 24 个文件，逐文件命名会在快照根散落 26 个文件且丢失目录语义；
> 目录式可按相对路径一次性回滚（`cp -r before/* <skill 根>/`），删除项也在快照内。

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

> **实施记录（2026-10-25 · 迭代 `2026-10-25-003`）**：四脚本全绿 —— `audit-engine.py` **ERR 0**
> （A10: `t7=0` / `f1=OK` / `const=17≤22` / `d=139/139`）· `validate-template-coverage.py` **ERR:0** ·
> `run-gate-tests.mjs` **81/81** · `memory_quota.py --index-check` **PASS**。

---

## 五、逃生口纪律

- 改 `hooks/**` 等**不在** `EXEMPT_PATHS` 内的文件时，需用户**手动**开闸：`{IDE}/hooks/.gate-bypass`（或 `GATE_BYPASS=1`）。
- ★ **01-03 阶段改 `{IDE}/skills/iteration-workflow/**` 无需开闸**（`EXEMPT_PATHS` 放行；见 `gate-protocol.md` §四）。
- 逃生口**用完即删**；**收尾必检：标记已删**（2026-09-20 曾发生"空标记遗留 ⇒ 门禁长期全放行"）。
- ★★ **逃生口的盲区（2026-10-24 实证 · 迭代 `2026-10-24-001`）**：`.gate-bypass` / `GATE_BYPASS=1`
  由**实现层**（`engine/gate/gate-check.mjs`）读取。一旦该文件自身语法错误，入口 shim 的
  `await import()` 失败即 fail-closed(exit 2) ⇒ **连只读工具都被拦，开闸也救不回来**，
  唯一恢复通道 = 用 `runtime/snapshots/**` 快照覆盖或手工修正该文件。
  ⇒ 纪律：**每次编辑 `gate-check.mjs` 后立刻 `node --check`**（本次实测：1 次注释笔误即锁死 4 轮作业）。

---

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-10-24 | ★ **G01/G03/G10 + A10 实施**（批次 0+1A · 迭代 `2026-10-24-001-引擎A10自检与门禁真值源` · 用户确认任务清单后实施）：**新增 3 模块** = `engine/gate/project-config.mjs`（运行时 manifest 读取，永不 throw）· `engine/gate/exempt-tables.mjs`（三表字面量 + 派生 + 深比对，字面量搬家不改值）· `engine/gate/derive-exempt.mjs`（`--print` JSON `schema:1` 对账出口）；**gate-check.mjs** = 三表改绑解析结果（`GATE_EXEMPT_MODE` 缺省 shadow ⇒ 放行面构造性零变化）+ 解析异常降级 LITERAL + `EXEMPT_SHADOW` 审计（`WATCHED_TOOLS` 早退后）+ `handoffOwnerActive()` 收敛 3 处 + 拦截话术去字面量；**audit-engine.py** = 新增 **A10**（a 项目 token 黑名单由 manifest 派生 / c 派生表三重对账 / d 落点存在性；b/e 显式 SKIP）+ `--a10-baseline`；**run-gate-tests.mjs** = `--json` 结果落盘 + 沙箱实现副本改**整目录 `.mjs`** 复制（修 H3/H4/H6/H7/H11 五例崩溃）。收口：`run-gate-tests` **63/63** · `audit-engine` **ERR 0** · A10 `a=hits=58 baseline=52 allow=6 err=0 c=OK d=127/127` · shadow 前后 63 例判定 **diff=0**。★ 本节 §五 新增「逃生口盲区」（实现语法错误时开闸失效，本次自锁 4 轮）。 |

| 2026-07-23 | 初版：核心文件快照 + 变更影响声明 + 回滚路径（解决新 clone 项目无版本历史时的回滚困境） |
| 2026-09-20 | ★ **与「先批后改」合并为本协议**：四件套升为 §二**硬性前置**；核心文件清单改为"以 `audit-engine.py` 的 `CORE_FILES` 为准"（旧 4 文件手工清单实测裸奔 59 天、从未触发）；新增 **§四 收口验证**（3 脚本 + 回流水位）；新增 **§五 逃生口纪律**（含 01-03 免开闸口径） |
| 2026-09-20 | §四 命令行的 **CWD 前提** 补注 + 三行改为项目根可执行的全路径：原 `--skill-dir .` 从项目根执行必崩（实测 `FileNotFoundError: .\engine\startup-protocol.md`，即按文档照抄 → 收口第 2 项**永远失败**） |
| 2026-09-23 | ★ **首次按「四件套 + 快照 + 收口」全流程执行元层改造**（工单 `runtime/TOOLING-TODO.md` `DEFECT-1`，**12 文件** = 引擎 8 + 模板 3 + `SKILL.md`）：用户**手动开闸**（PHASE=05）→ 3 个 `CORE_FILES` 快照 → 落盘 → 收口（`audit-engine.py` **ERR 0** · `validate-template-coverage.py` **ERR:0** · `run-gate-tests.mjs` **28/28** · `memory_quota.py --index-check` **PASS**）→ 删标记复核。★ 实测补正：`skills/**` 在 **05-07 阶段同样需开闸**（原 `SESSION-HANDOFF.md` 表述遗漏）⇒ 已同步该页 |
| 2026-09-29 | ★ **本文件纳入 P0 路径变量化**（`.codebuddy` 前缀 → `{IDE}`）：§四 收口验证表 1~5 条命令（6 处）；同时按记账纪律补本行，避免 A5「引擎已改、规范未跟」告警（迭代 `2026-09-29-001-Team协作模式与宿主抽象`；`{IDE}` 解析约定见 `startup-protocol.md` Step A） |
| 2026-10-02 | ★ **§一「核心文件清单以 `CORE_FILES` 为准」在实现外置后首次校正**：`engine/gate/gate-check.mjs` 取代 `hooks/gate-check.mjs`（后者自 HOOK-SLIM-1 起仅为转发 shim）；即「改实现」自此在快照 + 影响声明覆盖内。同步记账（迭代 `2026-10-01-002-引擎窄放行与遗留收口`，E-0/E-3；`audit-engine.py:41-46` 已改）。★ 另记：skill 内 `engine/**`、`scripts/**` **不入版本库**（`.gitignore`）⇒ §3.3 的 `git show HEAD~1` 回滚路径**不成立**，快照是唯一回滚源 |
| 2026-10-25 | ★ **G12/G11 + G07/G08/G09 实施**（迭代 `2026-10-25-002-引擎VCS归位与脚本去项目化`，🟡 5 分）：**新增 3 文件** = `engine/gate/vcs-profile.mjs`（VCS 判定单源；tag 过滤 + 空 source 守卫 + 探针断言 + `literalProfile()` 回退）· `engine/gate/notify-adapter.mjs`（`send()` 同步返回永不 throw · `mode` 分 notify/enqueue · 静默判定下沉）· `scripts/project_config.py`（`read_scalars`/`read_pairs`/`read_bare`）；**gate-check.mjs 九处改绑** = `VCS_PROFILE` IIFE（紧跟 `EXEMPT_RESOLUTION`）· 危险表 · `GIT_CHANGE_VERBS` · `isDeleteSegment`（Map + 无 git 键 + M-6 未启用即 false）· 两张死表搬移 · 死常量 `QQ_NOTIFY_MIN_INTERVAL_MS` 清理 · `notifyPhaseGuard`/G1 出站走 `NOTIFIER.send()` · `sendGateNotify` 早退下移至 ask 之后；**project-config.mjs** = 只增诊断（indent≥4 与中文冒号入 `errors[]`，判定零变化）；**三脚本** = `doc_lint.py` 迭代目录三级取值 · `memory_quota.py` 白名单外置（两处消费点同源 + 空表 SKIP）· `gen-knowledge-base.py` 词表外置（41/27/43，`Adapter` 双列）；**配置 4+2** = `kb-terms.yaml(+example)` · `memory-audit.yaml(+example)` · manifest `vcs.type: "svn"` / `notifications.adapter: "qqbot"`（模板中性值 `none`）。收口：`run-gate-tests` **81/81**（+V1 组 9 + AD 组 3）· `audit-engine` **ERR 0 / WARN 15** · `memory_quota --index-check` **PASS** · `validate-state` **PASS** · 知识库 34 文件剔时间戳行 **diff=0**。★ 本次全窗开闸（`.gate-bypass` TTL 240）—— 逃生口盲区仍适用（实现语法错时开闸失效，`node --check` 逐笔前置） |
| 2026-10-03 | ★ PERF-1 同批 engine 联动**补记（原漏记，触发 A5-b WARN 2 个，ENG-AUD-A5）**：`state-protocol.md`（§9.6 脚本通道 + §6.2 `UPDATED` 字段）· `phase-04.md` · `team-agent-strategy.md`（Team 并发上限）——内容详见 `runtime/TOOLING-TODO.md` PERF-1 实施记录 |
| 2026-10-07 | ★ **TOOL-QQGATE 甲档实施**（用户拍板，元层工单）：`engine/gate/gate-check.mjs`（**CORE_FILE，快照 `2026-10-07-gate-check.mjs.bak`**）新增 `checkUnregisteredUserConfirm()` ≈100 行纯新增——G1 观测期确认点 QQ 门登记校验（pending `-user-confirm` 步骤 + service.log `[ASK #N]` 行 vs `last_updated`，未登记 ⇒ notify.qqbot.js 直发单向提醒；超时态豁免；独立去重 `qq-g1-notify.json`；全程独立 try/catch 不影响既有阻断通知链）+ `runStopCheck()` 开头挂接 + import 补 3 个 fs 方法；同批 `waiting-protocol.md` §5 补判定入口指针。验证：`node --check` 0 错 + run-gate-tests **48/48** + audit ERR 0 + template PASSED + memory_quota PASS。3 路评审/四件套/分档：`runtime/TOOL-QQGATE-*.md`。同批补记 2026-10-03 行（清偿 ENG-AUD-A5） |
| 2026-10-09 | ★ **TOOL-07PH 规程增补**（元层工单 · 用户指令即时处理 · 3 路评审裁定 = **零代码方案**，撤销 `phase-close` 新命令提案）：`phase-07.md` §6.2 新增「① 登记 07 完成条目」——07 归档先手写 `phase_history` 07 条目（2/4 空格缩进 / 值带双引号 / 分钟级 completed_at）+ `phase_status→completed` + `validate-state.py` 显式 canonical 路径校验 + `state-apply summary` 归一（P-130 模式，隔离演练 2026-10-09 实证双副本镜像），之后才释放 ACTIVE；★ 根治 = 07 归档漏写条目 ⇒ align 无 07 窗 ⇒ 阶段消耗永无 07 行（2026-10-08-001 实证）；3 路评审记录 `runtime/TOOL-07PH-评审-3路.md`；本行补记清偿 A5 联动 |
| 2026-10-10 | ★ **TOOL-INTV A 批实施**（元层工单 · 用户拍板分两批 · 开闸实施〔QQ 确认 #19，ttl 240，收口后 revoke〕）：**6 文件** = `engine/phase-01.md`（step-2-5「复述确认 → 动态追问 → 5W2H 兜底」）· `engine/phase-steps.md`（v1.9 同名同步，零新增步骤 ID）· `engine/templates/phase-01-需求记录.md`（附录 C 改名 + §4.1「业务规则」栏）· `engine/phase-02.md`（必须/建议分层 + 需求歧义消解 + 澄清复审轮）· `engine/cross-review-protocol.md`（v2.3 适用域注记）· `engine/templates/phase-02-需求评审.md`（澄清轮次行 + §3.1 业务规则确认表 + 等待指针）。收口（开闸态实跑）：`audit-engine.py` **ERR 0 / WARN 2**（= 基线，零新增）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47**（= 基线）· `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` **ACTIVE=19**（基线 17，+2 为 S4 迭代 `2026-10-10-001` 模式沉淀 P-139/P-140，**非本批引入**；DUP=none）。依据 `runtime/TOOL-INTV-四件套.md` v2 + 探针 `runtime/TOOL-INTV-实施探针-2026-10-10.md`；B 批（9 文件）顺延下个 01-03 窗口 |
| 2026-10-10 | ★ **TOOL-INTV B 批实施**（元层工单 · 用户拍板分两批 · none 态开闸实施〔QQ 确认 #20，ttl 240，收口后 revoke〕）：**前置 = 第四批模式蒸馏**（活跃 19 → 10 条，移入 P-108 / P-116 / P-123 / P-124 / P-126~P-130；脚本 `runtime/distill-2026-10-10.mjs`）。**9 文件** = `engine/phase-04.md`（Step 5.5b 模式候选登记：代码块行 + 新小节 + 交付标准）· `engine/phase-07.md`（Step 3 附节「知识资产抽取」+ 交付标准）· `engine/startup-protocol.md`（惰性加载表新增 `project/lessons-learned.md` 行；engine 行不动）· `engine/lessons-learned.md`（置信度列 14 行 + §七 触发条件改 01-03 窗口 + 置信度维护段 + 顺带项 3 处）· `project/lessons-learned.md`（第四批蒸馏 + 模式候选区新增 + 置信度列 10 行 + 顺带项 :8 计数归一）· `engine/templates/project-lessons-learned.example.md`（置信度列）· `engine/context-discipline.md`（01 行模式库注入）· `engine/templates/phase-07-迭代回顾报告.md`（:60 指向 engine→project）· `engine/consistency-checklist.md`（变更记录补行）。**并入 A 批复核遗留 N1/N3/N5**（`phase-01.md` ×2 · `phase-02.md` · `templates/phase-02-需求评审.md`）。收口（开闸态实跑）：`audit-engine.py` **ERR 0 / WARN 2**（= 基线，零新增；四件套预期 WARN 3 中 A4 新增项**未触发**）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47**（= 基线；R1 七 phase 全 clean）· `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` **ACTIVE=10 / DUP=none**（蒸馏后）。回流水位：A6 WARN 17 项（源仓库滞后，含 A+B 批 15 文件 ⇒ 待回流窗口）。快照（**改动前**全量 15 文件）：`runtime/snapshots/2026-10-10-intv-b/`。依据 `runtime/TOOL-INTV-四件套.md` v2 §③ B 批 + `runtime/TOOL-INTV-B批开工交接.md`。★ **同日复核（7 维度）2 处 🔵 前缀项已开闸修正**（QQ #21 / ttl 60）：`phase-04.md` §5.5b 与 `startup-protocol.md` 惰性加载行的 phase 引用补 `engine/` 前缀（对齐同文件惯例）；修正后 audit/validate 复跑 = 基线 |
| 2026-10-10 | ★ **BOARD-1 落地**（元层工单 · 用户拍板「选 B：规程 + 代码加固」· 04 窗口免开闸〔#23 `2026-10-10-002` PHASE=04〕）：`engine/phase-07.md` §6.2 新增「③ 刷新机器投影」（② 释放 ACTIVE 之后：`refresh-metrics.mjs --force` 全链 + `gen_doc_index.py`；三条判据 = 07 行出现 / BOARD.md 不再指向本迭代 / INDEX.md 终态一致；含 06 口径备忘、失败兜底、P-088 次序说明）· `engine/phase-steps.md` step-6-archive 描述补"刷新机器投影"（保 ID）· `runtime/metrics/refresh-metrics.mjs` **代码加固** = 6h 节流叠加「`phase-aggregates.csv` 结构 hash 未变」条件（`.last-board` 升级双行；旧格式/缺 hash ⇒ 触发一次重刷，向后兼容）。根治：迭代收尾投影过期（10-08-001 / 10-10-001 两次用户误判为统计缺陷）。收口：`audit-engine.py` **ERR 0 / WARN 2**（= 基线，A4 零新增）· `validate-template-coverage.py` ERR:0/WARN:1 · `run-gate-tests.mjs` **48/48** · `memory_quota --index-check` **PASS** · A6 回流水位 42 项（源仓库滞后，含本批 3 文件 ⇒ 待回流窗口）· 三路径实测 T1/T2/T3 全绿 + board 耗时复测 2.9s。依据 `runtime/BOARD-1-四件套.md` v2 + `runtime/BOARD-1-评审-3路.md`；快照 `snapshots/2026-10-10-board1/` |
| 2026-10-10 | ★ **TOOL-CAPMAP 实施**（元层工单 · 04 窗口**免开闸**〔#23 `2026-10-10-002` PHASE=04 + 无 dispatch_whitelist，实施前重读双副本确认〕· 用户拍板）：**新建** `engine/capability-map.md`（11 域 · 78 项能力索引 + 状态标记 + 缺口汇总；索引层，细则以落点文件为准）+ `engine/startup-protocol.md` 惰性加载表 +1 行 + skill 根 `README.md` **中英双版各 4 处**（目录树新增 capability-map / doc-style-guide / gate/ + templates 段 agent-prompt-examples 子项〔原 `└──` 行同步改 `├──`〕= 3 处 drift 修复；双版各 1 指针句）+ `SKILL.md` 1 行指针（**CORE_FILE ⇒ 已入快照**）。收口实测：`audit-engine.py` **ERR 0 / WARN 2**（= 基线零新增；A1 42/42、A4 零新增实证 = 地图 49 引用全存在）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47**（= 基线）· `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` **ACTIVE=10 / DUP=none** · doc_lint 地图 **ERROR 0 / WARN 23**（D4 🆕 + D1 长格，登记不修）· 行尾全绿 · 回流水位 **A6 WARN 19 项**（engine 16 + scripts 3；源仓库最后提交 2026-10-09 17:17；本批 3 文件在面内；较 B 批记录 17 项 +2 = 本批新建 1 + 1 项 B 批未存逐项名单待核 ⇒ 回流窗口统一）。快照 `runtime/snapshots/2026-10-10-capmap/`（before/ 5 文件 + ROLLBACK-PATCH.md）
| 2026-10-10 | ★ **METRICS-6 实施**（元层工单 · 用户拍板「全量采纳 O1~O7」· 04 免闸窗口〔#23 `2026-10-10-002` PHASE=04 + state 无 `dispatch_whitelist`〕）：`runtime/metrics/phase-align.mjs` **输出层 +6 行** = 0 轮实做窗补占位行（遍历 `it.wins`、`rec.wins.has(w)` 跳过有轮窗 ⇒ `newBucket()` + note「该阶段窗内无模型轮次」；各列恒 0 ⇒ 每迭代 Σ 对账恒等不涉；头注 +1 句）· `engine/phase-07.md` §6.2 ③ 口径备忘改「两类看不到行」（有窗 0 轮 ⇒ 占位行；零宽窗 ⇒ 无窗可占位、仍无逐阶段行 + 指向 METRICS-7）· `tools/gen_iteration_board.py` 口径行 +1 句（阶段消耗投影与 `board.html` 孪生文案）+ `fmt_note` 连续分隔符折叠（本批引入的 `;;` 渲染瑕疵根治）· `docs/iterations/README.md` +1 行口径。动机：用户**两次**追问「06 走了阶段却没有统计」（`2026-10-10-001` 实证：06 窗在、窗内 0 落轮 ⇒ 旧口径不出行）。收口实测（免闸态实跑）：CSV 181 → **211** 行（键级 **新增 30 / 删除 0**，新增行各列全 0；重复键 delta 0；33 迭代 Σ(阶段+unphased)==iteration-total 全 PASS）· `refresh-metrics --force` 汇总 `sanity=PASS phase=ok board=ok` · `audit-engine.py` **ERR 0 / WARN 2**（= 基线，A4 零新增）· `validate-template-coverage.py` **ERR:0 WARN:1 OK:47** · `run-gate-tests.mjs` **48/48** · `memory_quota.py --index-check` **PASS** · `check-distill.mjs` ACTIVE=10 / DUP=none · A6 回流水位 **42 项**（源仓库滞后，`engine/phase-07.md` 在面内 ⇒ 待回流窗口）。依据 `runtime/METRICS-6-四件套.md` v2 + `runtime/METRICS-6-评审-3路.md`；快照 `runtime/snapshots/2026-10-10-board1-ext/`（before/ 7 文件 + evidence/ 10 件） |
| 2026-10-10 | ★ **回流 2026-10-01~10-10 批次 + A6 口径护栏**（元层维护 · 开闸窗口）：26 文件回流（engine 50 / scripts / domain-plugins / SKILL.md / README.md 全层 0 差异）；**并回源侧独有夹带**（`phase-04.md` / `waiting-protocol.md` 的「可选工具前置判据」+ `audit-engine.py` EXTERNAL_TARGETS 补 4 个 qqbot 脚本）；`scripts/audit-engine.py` 新增 **A6 上级目录误传护栏**（`--src` 传 `D:\sj-skills` 而非引擎仓库根 ⇒ 此前恒定「42 项源仓库缺失」假水位，同日修正）；口径同步 `consistency-checklist.md` §一/§二 与本节 §四 第 5 项。回流后实测 `audit-engine.py --src <引擎仓库根>` = **[OK] A6 与源仓库一致** |
| 2026-10-11 | ★ **FIX-48 实施**（元层工单 · 用户裁定 R1=A「纯⑤」· 开闸实施〔QQ 确认 #7，ttl 180〕）：① `{IDE}/hooks/gate-check.mjs` **两副本**（项目 + 引擎仓库，MD5 对齐）= 候选全空时读 worktree `.git`（`gitdir:` 反推主仓库）加载主仓库实现 + `await import()` 包 try/catch（加载抛错原为非 2 码=静默放行 ⇒ 现 exit 2）；② `engine/gate-protocol.md` L9-10 补 FIX-48 分层描述（**CORE_FILE** · 快照 `runtime/snapshots/2026-10-11-fix48/before/`，9 文件）；③ `engine/templates/cold-start-gate-nucleus.md` v1.15→v1.16（补 headless 与隔离区口径）+ `setup-gate.py --force` 重注入；④ `tools/qqbot/qqbot-service.js` 两副本 = 任务书 ×2 追加「隔离区铁律」+ `finishServeHandoff` worktree 残留探测（QQ 回执）· `daemon.config.json` handoffPrompt 同步；⑤ `scripts/run-gate-tests.mjs` = runHook 清 `PIVAS_HANDOFF_OWNER`（防 headless 假绿）+ hook/projectDir 用例级覆盖 + **SHIM 组 3 用例**。收口：`run-gate-tests` **51/51**（48+3）· `audit-engine` **ERR 0 / WARN 2**（=基线）· `validate-template-coverage` PASSED（1 warn=基线）· `memory_quota` **PASS**。★ 生效前提 = **git commit 至项目 master**（worktree 为 git 检出；用户授权 R2）。依据 `runtime/FIX-48-四件套.md` v2 + `runtime/FIX-48-评审-3路.md`（3 路 37 项）。|
| 2026-10-14 | ★ **FIX-50 实施**（元层工单 · 迭代 `2026-10-14-001-门禁切段引号感知修复` · 用户立项拍板 · 04 窗口免开闸〔`.codebuddy/skills/iteration-workflow/**` 属 `EXEMPT_PATHS`〕）：**3 文件** = `engine/gate/gate-check.mjs`（`splitCommandChain` 改游标扫描型引号感知 —— 引号内分隔符不切分 / 段内保原文 / 未闭合回退原 split〔fail-closed 六约束〕；注释 L851、L1137-1138 改述）· `engine/gate-protocol.md`（L217 例句精化「未引号 `;`」/ L227 基线追加 176/176 / GATE-A② 段后新增 ★FIX-50 沿革块）· `runtime/gate-regression-test.py`（SCENARIOS +`04A2`；CASES +FIX-50 组 13 条）。收口：`audit-engine.py` **ERR 0 / WARN 4**（A4×2 + A5 + 1，WARN 登记 TOOLING-TODO）· `validate-template-coverage.py` PASSED（1 warn=基线）· `run-gate-tests.mjs` **51/51** · `gate-regression-test.py` **BASE 0 失败 / FIX 146/146 / GATEA 30/30** · `memory_quota --index-check` **PASS** · 沙箱 T1~T6 全符（T1 拦→放行，T3/T6 保持拦）。依据 `runtime/FIX-50-四件套.md` + 3 路独立评审 + step-3x 交叉审查（证伪 2 条被 T4/T5 实测驳回）；快照 `runtime/snapshots/2026-10-14-fix50/before/`（3 文件）。`hooks/gate-check.mjs` shim **零改动**（定向复核 0 命中）。 |
| 2026-10-14 | ★ **#67 迭代工作量预估与偏差度量 实施**（迭代 `2026-10-14-002-迭代工作量预估与偏差度量` · 3 路评审 B 批 11 项全采纳 · 04 窗口免开闸〔`.codebuddy/skills/iteration-workflow/**` 属 `EXEMPT_PATHS`〕）：**Delta 8 实体 + 2 新增（= 10 文件）** = `engine/state-protocol.md`（§三 5 字段块 + §3.3「预估字段校验」四条 + 准确度四指标脚注）· `scripts/validate-state.py`（**新增 [R9] `check_estimate`** = 头注索引行 + 38 行函数 + main 调用置于 `check_reconcile` 之后 + SCOPE 改 R1-R9；`REQUIRED` 不动）· `engine/complexity-scoring.md`（唯一权威源声明 + 预防性禁用因子段 + 3 新步骤登记 §二）· `engine/phase-steps.md`（阶段一/三/七表各 +1 行）· `engine/phase-01.md`（step-2-7-estimate 初估）· `engine/phase-03.md`（step-3-5-reestimate 复估）· `engine/phase-07.md`（step-3-6-attribution 偏差归因；§6.2 ③ 自检判据 三条 → 四条 + d. 偏差项）· 项目侧 tools/gen_iteration_board.py（三列 + 偏差现算 + `—` 降级 + 色阶）；**新增** `runtime/metrics/gen-estimate-baseline.mjs` · `runtime/metrics/estimate-baseline.json`。**决策 A（不落 state）**：`actual` / `deviation` 为派生值，由看板与 07 按需即算 —— 规避 `state-apply` 写历史迭代时无条件覆盖 ACTIVE Line2 的污染链。治理联动同批记账（T8 5 处）：本行 + `engine/consistency-checklist.md` §五 · `engine/capability-map.md`（§5 +1 行「预估与偏差」+ 节计数 （5）→（6））· `scripts/run-state-tests.py`（SEED +5 字段 + **T11a~d**）· 04 任务清单 §四。收口实测：`audit-engine.py` **ERR 0 / WARN 4**（= 基线，A4×4 零新增）· `run-state-tests.py` **14/14**（连续 2 次：原 T1~T10 + T11a 链路保留 / T11b 枚举负向 / T11c 区间负向 / T11d 引号陷阱 `estimate_stage: 1` int 判红〔T2/T3 裁定维持严格〕）。快照 `runtime/snapshots/2026-10-14-002-before/`（13 文件）。本行同批清偿 A5-b/A5-c。 |
| 2026-10-15 | ★ **FIX-49 v2.4 实施（宿主自适应 runtime 解析 · 方案 B＝单写本侧 + sync 收敛）**（元层工单 · 前迭代 `2026-10-11-001` 收口后 **none 态开闸实施**〔QQ 确认 **#11** ttl 240，收口后 `--revoke`；回流窗口 **#12** ttl 30〕· 用户裁定 R1~R9）：**CORE_FILES 命中 3** = `engine/gate/gate-check.mjs`（三级解析 `HOST_IDE`〔shim 注入 ＞ `*_PROJECT_DIR` ＞ 实现自身位置〕+ **解析失败 fail-closed exit 2（R1 不兜底）** + `RUNTIME_DIR` 恒本侧 + `HOOK_ENTER` 加 `host=`/`runtime=` + **R8 甲** `otherSideMirrorFace()` 他侧镜像面直写拦截 + α/β 态跨侧只读提示 + 双宿主复活检测留痕）· `engine/state-protocol.md`（§9.0 canonical 改写：本宿主侧 / 单写 + `sync-runtime.py` 收敛 / 镜像面白名单 / 跨宿主并发禁则 / 宿主共享点清单 / 审计非完备账本 / 切换规程；§8.6 会话日志落点改 `{IDE}/memory/`）· `engine/gate-protocol.md`（`$RUNTIME_DIR` = 当前宿主侧 注）。**同批** = shim 两副本注入（项目 + 引擎仓库 MD5 对齐）· `scripts/state-apply.py`（四级侧解析 + `STATE_APPLY_SIDE` R44 同现加固 + **单写本侧**，删 mirror/回落护栏/双副本写）· **新增** `scripts/sync-runtime.py`（全侧自动发现 / 新者胜双判 / 并列拒绝 + 双侧备份 / 幂等 / 自举建 runtime / 留痕）· `scripts/run-state-tests.py`（夹具对调 + 另一侧零触碰断言 + T12a/b + T13~T15）· `scripts/run-gate-tests.mjs`（**HOST 组 12 例**：白名单式清 4 env + SENTINEL 判读侧 + 真实 shim 端到端 + MD5 分发自证 + H10b 负向对照）· `scripts/install.ps1/.sh`（探测反转 + 双目录并存需显式 `-Ide`/`--ide` 或 `-Force`/`--force`）· 文档 8 处（startup-protocol §B.3 重写 + `:30-31` 约定解除 / step-a5 / step-e / phase-04 + team-agent-strategy 判定源 / phase-07 / phase-05 规则 2 / capability-map / gate-decision-table / audit-engine 注释 + `settings.json` 登记）· `project/lessons-learned.md` 4 条 SOP 注记 · `tools/qqbot/qqbot-service.js` 任务书第 7/8 条。**收口实测（关闸前后各一轮）**：`audit-engine.py` **ERR 0 / WARN 5** · `validate-template-coverage.py` PASSED（1 warn=基线）· `run-gate-tests.mjs` **63/63**（改造前基线 **51/51** ⇒ +12 HOST）· `run-state-tests.py` **20/20** · `memory_quota --index-check` **PASS** · `gate-regression-test.py` **BASE 0 失败 / FIX 146/146 / GATEA 30/30**。**实测项①** = 真实会话审计新行 `HOOK_ENTER host=codebuddy runtime=.codebuddy/…` 且 `.claude` 侧静止（16:44:14 后零写入）；**关闸三件套** = 业务区探针 BLOCK ✓ / 他侧镜像面直写 BLOCK（R8 文案）✓ / 本侧 runtime 放行 ✓。**切换规程** = 旧侧 `gate-audit.log`（125,194 行）+ `write-claims.jsonl`（5,270 行）归档 `*.pre-fix49` + 新侧 `FIX49_SWITCH` 分段留痕。**快照** `runtime/snapshots/fix49/before/`（23 文件 + MANIFEST）。依据 `runtime/FIX-49-四件套.md` **v2.4** + 3 路评审 + 再论证 + 2 路复核（R1~R45）；实施收口报告 `runtime/FIX-49-实施-2026-10-15-收口报告.md`。 |
| 2026-10-16 | ★ **TEAM-2 实施**（04 免开闸）：4 文件 = phase-04.md / team-agent-strategy.md / capability-map.md / consistency-checklist.md；依据四件套 v2 + 3 路评审；快照 2026-10-16-team2/before；收口见 TOOLING-TODO |
| 2026-10-25 | ★ **G02/G06/G13/G16/G17/G18 实施（文档层去项目化 · 批次 4+5）**（迭代 `2026-10-25-003`，🟡 3 分 · 24 改 + 1 新增 + 2 删除 · **零 `engine/gate/**` 改动**）：**判据侧** = `scripts/audit-engine.py` 新增 A10-f 双档（f-1 调用形态 ERR、首版豁免空 / f-2 常量形态计数守门 const=17≤22）+ A10-a **T7**（黑名单由 manifest `audit.doc_deny_tokens` 驱动、仅 `.md`、**独立计数不参与「首个命中即 break」**，否则已被 T1~T6 覆盖的行内项目词永远不计入 ⇒ 判据恒绿）+ 缺键 warn 守卫 + 汇总串补 `t7`/`f1`/`f2` + `A10_BASELINE` 删 G02/G16/G17/G18（纯记账：该 4 项在 `A10_HIT_MAP` 无映射行）；**声明层** = manifest 删 `domain_plugin` 键（0 消费者）+ 新增 `project/domain-rules.example.md`（2 个 gate-rules 合并迁出，声明「不被任何代码加载」）+ `install.ps1`/`install.sh` 去 domain-plugins 复制项；**分发层** = `sync-back-to-engine-repo.ps1` 参数化（`-RepoPath` / `$env:IWF_ENGINE_SRC` 三级优先，两者皆空 ⇒ exit 1 + 两种设置方法提示；`-SkipDirs` 可覆盖）；**文档层** = README 删 2 处 quickstart 死链 + 4 处 `.claude/skills/`→`{IDE}/skills/`、能力地图 §8 剥离项目侧 3 项（状态 ⚠️）+ 新增 §8-A 纯文字、gate-protocol 14 处实现符号去点名 + `state-protocol` 1 处、G06 文档层实改 25 行（A13+B7+E5）+ 2 处脚本 docstring 中性化。收口：`audit-engine.py` **ERR 0**（`a=hits=34 baseline=26 allow=8 err=0 t7=0` / `f1=OK const=17/22` / `d=139/139`）· `run-gate-tests.mjs` **81/81** · `validate-template-coverage.py` **ERR:0** · `memory_quota --index-check` **PASS**。负向用例：临时点名任一门禁函数（带括号）⇒ `f1=ERR` 并精确报行号，还原归零。快照 `runtime/snapshots/2026-10-25-003/before/`（26 路径）。★ 三处方案口径订正与处置见 `docs/iterations/2026-10-25-003-引擎文档层去项目化与分发归位/04-开发实现/04-开发任务清单.md` 附录 A |
| 2026-10-19 | ★ **TOOL-QQWAIT 第一步实施（引擎协议层）**（元层工单 · 用户裁定「按 v2 实施 / C 只留草案不排期 / QQWAIT 与 QQCONSUME 同窗口合并」· 迭代 `2026-10-19-001-M3标签管理页` PHASE=03 免开闸〔`skills/**` 属 `EXEMPT_PATHS`〕）：`engine/waiting-protocol.md`（**CORE_FILE** · 快照 `runtime/snapshots/2026-10-19-tool-qqwait/before/`）**4 处** = §1 模式 A 首选实现改 `ask.js --wait <秒>`（`wait-answer.ps1` 降为等价退化）· §2 新增铁律「**登记 ≠ 等待**」（三种合法等待形态只取其一；只登记后结束回合 = 答复无人消费，已实证 3 次）· §4 新增 invariant（`--wait` 命中后不得同回合 `poll-answer --consume`；ts/mtime/consumedAt 三判据差异注记）· **新增 §6「有无等待者」判据草案（仅登记、未实施、不排期）** + §7 `ask.js --wait` 实施状态（防"引擎推荐一个不存在的参数" + 分层回流声明）。同批记账：`engine/consistency-checklist.md` §五 · `engine/capability-map.md` §6 表态 · 本行。**工具层（`tools/qqbot/ask.js --wait`）尚未实施** —— 属项目业务区，03 阶段被门禁拦，须等本迭代 04 窗口或用户开闸。依据 `runtime/TOOL-QQWAIT-四件套.md` **v2** + `runtime/TOOL-QQWAIT-评审-3路.md`（R1 12 成立/2 部分/1 证伪 · R2 必纳入 12 项 · R3 2 项证伪成功）。 |
| 2026-10-23 | ★ MOTIV-RECHECK 撤回 §F0 收益估算（>600k 轮次实测=0）+ 03 新增 §3.0 改动点锚点表（必填）+ phase-steps v1.12；audit ERR 0 / validate PASS；详见 `_跨迭代专题/2026-10-23-FIX-SHORTSESS-A-B验证清单` |
| 2026-10-23 | ★ **P-T5 定案（不做降频，改做标注）**：`phase-06.md` §阶段1 增 3 行 —— 无发布窗口时 `step-1-deploy-stage1` 记录须显式写「未实际部署」（**发布窗口定义 = 发布到公司测试服务器 / 三大中心口径**）。**收益重估**：原估 15~20min/迭代属高估（06 的 5 个强制步骤里只有 step-1 与发布相关）⇒ 真实可省约 5~8min（1.5%~2%），不值得为它改流程 ⇒ 只做标注（防「命令清单被读成已上线」的跨迭代状态误读） |
| 2026-10-19 | ★ **FIX-ALLOW-1 方案 A（05 期阶段级预授权）**：6 文件 + 快照；零代码（GAP-4 不变）；元层开闸 QQ#16 ttl 240。详见 `runtime/TOOLING-TODO.md`。 |
