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
