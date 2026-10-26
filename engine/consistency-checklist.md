# Engine 一致性审计规范（v2.1）

> ★ **v2.0（2026-09-20）**：明细清单已交由 **`scripts/audit-engine.py`** 执行，本页只写维度、判据与触发点。
> 旧 v1.x 的手工清单（「12 个 engine 文件」表、`workflow-engine.md` 行号断言、步骤 ID 清单）**已废止**——
> 行号与文件数类内容必腐；实证：该清单**未被任何加载路径引用**，停摆 40+ 天且前置数据全部失效。
>
> ★ **v2.1（2026-09-23）**：新增 **A7 状态字段登记闭环**（**规范维度，脚本尚未实现** ⇒ 收口 / 评审时人工核；
> 实现登记见 `runtime/TOOLING-TODO.md` `DEFECT-1`）。

---

## 一、审计维度

| ID | 维度 | 判据 | 级别 |
|:--:|------|------|:--:|
| A1 | 孤儿文件 | `engine/*.md` 与 `scripts/*` 至少被「引擎加载路径」（`engine/` · `scripts/` · 根级 `*.md`）引用；有意孤立者登记脚本内 `ORPHAN_ALLOW` | WARN |
| A2 | 步骤 ID 闭环 | `phase-steps.md` 步骤表为**唯一权威**；`phase-0X.md` · `complexity-scoring.md` · `cross-review-protocol.md` · `SKILL.md` 中出现的完整步骤 ID 必须命中权威表（前缀式简写视为引用） | ERR |
| A3 | 产出物名 | `workflow-engine.md` §标准文件命名表声明的产出名须在对应 `phase-0X.md` 出现 | WARN |
| A4 | 引用存在 | 引擎层反引号内的跨文件引用目标须存在（**收窄为「文件存在」**，不校验锚点 / `§`） | WARN |
| A5 | 治理文档时效 | a 内容日期 > 7 天；b 自其 mtime 以来 `engine/` 有文件更新（联动）；c **mtime 与内容日期背离 > 3 天**（记账一致性） | WARN |
| A6 | 回流水位 | 与源仓库逐文件比对（路径缺失 ⇒ SKIP） | WARN |
| A7 | 状态字段登记闭环（★ 2026-09-23 新增） | `state.yaml` 的顶层字段须在 `state-protocol.md` §三（格式）**且** §3.3（枚举）登记；出现未登记字段 ⇒ WARN。**历史反例**：`delete_allow` 仅见于门禁协议、Schema 未登记 ⇒ 静默漂移（本次 `defects[]` 已按此规则登记） | WARN（★ 脚本未实现，人工核） |
| A8 | 等待点指针完备（★ 2026-10-01 新增 · RESUME-3 批次 1） | 含"等待用户"类确认表述的 engine md（含 templates/）须挂 `waiting-protocol.md` 指针；漏挂 ⇒ ERR。**背景**：等待机制曾只挂 phase-04，09-30 真实迭代确认门主动登记 0 次 | ERR |
| A9 | 缺陷修复短会话留痕（★ 2026-10-12 新增 · FIX-SHORTSESS） | 迭代内 `defects[]` 有 `fixed` 条目 ⇒ 每窗口 `phase_steps` 含 `step-fix-1-5-handoff` 且 `fix-handoff-D<n>.md` 存在；微修豁免 = note 注明「微修未交接」。仅对 2026-10-12 后的新迭代生效 | WARN（★ 脚本未实现，人工核；工单 `FIX-SHORTSESS-AUD`） |
| A10 | 通用性自检（★ 2026-10-24 新增 · 批次 0 · 迭代 `2026-10-24-001`；**b/e 于批次 2 实检上线，2026-10-25**） | **a** 项目 token：黑名单全部由 `project.manifest.yaml` 派生（短名/全名/工作区路径/业务根），脚本内零项目字面量；**b** 占位符 schema：engine 内 `{{}}` 须全在五类 schema 内 **且** `template-injection.md` §2.4 协议表成员集合与 schema 双向一致（SSOT = `inject-template.py` 五常量；已实现）；**c** 派生表对账：Python 独立算期望 + 冻结基线 + 变异沙箱（不采信被测模块自报 `diff`）；**d** 落点存在性：capability-map 落点与 README 相对链接按路径校验；**e** 模板漂移：`inject-template.py --check --compare SKILL.md` 逐字节一致（已实现）。已登记基线（`A10_BASELINE` 15 条；G02/G16/G17/G18 结案后移除）⇒ WARN 带 G 编号+批次；未登记 ⇒ ERR；`A10_ALLOW` ≤10 条逐条带理由；**f**（2026-10-25 新增）实现符号耦合：文档内函数调用形态命中门禁实现 ⇒ 未登记 ERR（豁免表首版为空）、常量形态超基线 ERR（基线内单条 WARN，不阻塞）。负向用例：临时点名任一门禁函数（带括号）应报 ERR，还原后归零；已知盲区 = 只认无参调用、只认门禁实现顶层常量 | ERR（未登记命中 / b·e·f 失败）/ WARN（基线命中） |

> A5 对象 = `engine/evolution-safety.md` · `engine/consistency-checklist.md` · `runtime/SESSION-HANDOFF.md`（三份元层规范）。

---

## 二、判据与处置

- **退出码**：有 ERR ⇒ `1`；WARN 不影响（`--strict` 可选纳入）。
- **★ ERR / WARN 不阻塞归档**：审计结果**只登记**，不作为 07 阶段归档的前置条件——
  否则会形成「引擎有问题 ⇒ 业务迭代无法归档」的死锁。
- ERR = 确定性不一致（步骤 ID 未登记 / 治理文档缺失）；WARN = 提示项，登记 `runtime/TOOLING-TODO.md` 后延后处置。

---

## 三、运行

```bash
python scripts/audit-engine.py                 # 项目侧 skill 实例（纯读，不写文件）
python scripts/audit-engine.py --src <引擎仓库根>  # 追加 A6 回流水位（根须含 engine/ 与 scripts/；可省，读 IWF_ENGINE_SRC）
```

---

## 四、触发点

| # | 触发点 | 位置 | 结果落档 |
|:--:|:--|:--|:--|
| ① | **改 skill 收口** | `engine/evolution-safety.md` | 写入 `runtime/TOOLING-TODO.md` 对应工单的「实施记录」；无对应工单 ⇒ **新建 `AUDIT-n`** |
| ② | **迭代回顾** | `engine/phase-07.md` 的 `step-3-5-workflow-audit` | 写入本迭代 07 回顾报告（通过 ⇒ 一句话；否则附 ERR/WARN 摘要）+ ❌ **登记 `runtime/TOOLING-TODO.md`** |

> ★ **脚本只判定、不写文件**（纯读，故可在任何阶段运行）⇒「读输出 → 登记落档」这一步**必须由 Agent 完成**。
> 落档处只有两处：**`runtime/TOOLING-TODO.md`**（元层工单，❌ 的唯一归宿）与**本迭代 07 回顾报告**（过程留痕）。
>
> **触发点① 收口同批跑**（见 `engine/evolution-safety.md` §四）：`audit-engine.py`（本审计）·
> `validate-template-coverage.py`（模板覆盖）· `run-gate-tests.mjs`（门禁回归）· 回流水位比对（`audit-engine.py --src <引擎仓库根>`）。

---

## 五、变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-07-12 | 1.0 ~ 1.1 | 初始手工清单（12 大类）；首轮扫描修 11 项 |
| 2026-09-20 | **2.0** | 手工清单 →「本规范页 + `scripts/audit-engine.py`」（A1~A6）；新增两个挂载点（07 `step-3-5-workflow-audit` + 改 skill 收口） |
| 2026-09-23 | **2.1** | 新增 **A7 状态字段登记闭环**（规范维度，脚本待实现）；由 `runtime/TOOLING-TODO.md` `DEFECT-1` 驱动（`defects[]` 落地 + `delete_allow` 历史漂移反例） |
| 2026-10-02 | **2.2** | ① **A5 新增「按需刷新」口径**（`A5-ON-DEMAND` 标记；`runtime/SESSION-HANDOFF.md` 为交接快照，不适用 7 天时效/联动判据 ⇒ 消除每迭代复报）；② **A4 `EXTERNAL_TARGETS` 显式登记 3 项**外部/宿主侧目标（`gen_doc_index.py` / `wait-answer.ps1` / `probe-readonly-gate.mjs`）；③ **`CORE_FILES` 改列** `engine/gate/gate-check.mjs`（实现外置后校正，原列 `hooks/` 侧已为 shim）；④ 登记观察项：A2 `STEP_ID_RE` 不匹配 `step-fix-*` 家族（闭环盲区，待排期）。依据：迭代 `2026-10-01-002-引擎窄放行与遗留收口`（W-1 / W-2 / E-3） |
| 2026-10-10 | 补记 | **TOOL-INTV A+B 批联动记账**（A5-a 预防，防"引擎已改、规范未跟"）：A 批 6 文件（phase-01 / phase-steps / phase-02 / cross-review-protocol + 2 模板）+ B 批 9 文件（phase-04 新增 Step 5.5b 模式候选登记 / phase-07 Step 3 附节「知识资产抽取」/ startup-protocol 惰性加载新增 `project/lessons-learned.md` 行 / lessons-learned（engine+project）置信度列 + 01-03 蒸馏窗口 + 模式候选区 / context-discipline 01 行 / 2 模板 / 本文件）——全文见 `engine/evolution-safety.md` 变更记录 2026-10-10 两行。收口实测：A8 扫描 46 个 engine md = OK（等待点指针完备）；A4 本项目侧零新增（B2/B3 兜底文档"不写全路径反引号"约束生效）；模板 doc_lint 不做（评审 A#12） |
| 2026-10-19 | 补记 | **TOOL-QQWAIT 第一步（引擎协议层）联动记账**：`engine/waiting-protocol.md` 4 处（§1 模式 A 首选 `ask.js --wait` / §2 铁律「登记 ≠ 等待」/ §4 invariant `--wait` 不得与 `poll-answer --consume` 同回合混用 / 新增 §6「有无等待者」判据草案〔仅登记未实施〕 + §7 `--wait` 实施状态与分层回流）。A8 自检：新措辞已避开「等待用户确认 / 待用户拍板 / 须用户确认」触发词，且文内含 `waiting-protocol.md` 自指针 ⇒ 零新增 ERR。工具层 `tools/qqbot/ask.js --wait` **未实施**（项目业务区，待 04 窗口或开闸）。全文见 `engine/evolution-safety.md` 变更记录 2026-10-19 行 |
| 2026-10-25 | 补记 | **G12/G11 + G07/G08/G09 联动记账**（A5-a 预防，防"引擎已改、规范未跟"）：新增 `engine/gate/vcs-profile.mjs`（VCS 判定单源）· `engine/gate/notify-adapter.mjs`（出站通知适配）· `scripts/project_config.py`（Python 侧配置读取器）；`gate-check.mjs` 九处改绑 + `project-config.mjs` 只增诊断 + 三脚本外置（`doc_lint.py` 迭代目录 / `memory_quota.py` 白名单 / `gen-knowledge-base.py` 词表）+ 四份配置落地。收口：`run-gate-tests` **81/81** · `audit-engine` **ERR 0** · `memory_quota --index-check` **PASS** · `validate-state` **PASS**；A4/A8 零新增 ERR（A10-c 因未传 `--a10-baseline` 仍为已登记 WARN）。全文见 `engine/evolution-safety.md` 变更记录 2026-10-25 行 |
| 2026-10-12 | **2.3** | 新增 **A9 缺陷修复短会话留痕**（工单 `FIX-SHORTSESS-AUD`） |
| 2026-10-14 | 补记 | **#67 治理联动记账**（A5-b/c 预防，同批清偿）：engine 侧 8 实体（`state-protocol.md` 5 字段 + §3.3「预估字段校验」· `validate-state.py` 新增 **[R9] `check_estimate`** · `complexity-scoring.md` · `phase-steps.md` · `phase-01.md` · `phase-03.md` · `phase-07.md`）+ 2 新增（`runtime/metrics/gen-estimate-baseline.mjs` · `runtime/metrics/estimate-baseline.json`）——全文见 `engine/evolution-safety.md` 变更记录 2026-10-14 行。治理面 4 件同批 = 本文件 · `evolution-safety.md` · `capability-map.md`（§5 +1 行「预估与偏差」+ 节计数 （5）→（6））· `scripts/run-state-tests.py`（SEED +5 字段 + T11a~d ⇒ **14/14**）。A1~A9 脚本侧零改（`audit-engine.py` **ERR 0 / WARN 4** = 基线，A4×4 零新增） |
| 2026-10-16 | 补记 | **TEAM-2 治理联动记账**：engine 侧 3 实体（phase-04 人工唤醒协议→成员等待协议 · team-agent-strategy §三 Step 7.5 + §九④ · capability-map §6 +1 行）；依据四件套 v2 + 3 路评审；收口见 TOOLING-TODO → TEAM-2 |
