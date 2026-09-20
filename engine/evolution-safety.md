# 引擎演进安全协议（Engine Evolution Safety）

> **本文件 = 引擎自身修改纪律的唯一载体**：① 前置审批（四件套）→ ② 执行安全（快照 / 影响声明 / 回滚）→ ③ 收口验证（三个脚本 + 回流）。
> 关联：审计维度 = `engine/consistency-checklist.md`｜门禁 = `engine/gate-protocol.md`｜元层待办 = `runtime/TOOLING-TODO.md`

---

## 一、适用范围与核心文件

**任何**对本引擎的修改都在本协议范围内：`engine/**` · `scripts/**` · `hooks/**` · `SKILL.md` · `SKILL.template.md` · `engine/templates/**` · 根级文档。

**核心文件**（改动需执行 §三 的快照与影响声明）：

| 文件 | 路径（相对 Skill 根） | 角色 |
|------|------|------|
| gate-check.mjs | `hooks/gate-check.mjs`（`.claude/hooks/` 或 `.codebuddy/hooks/`，随宿主） | L3 物理拦截层 |
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
| 1 | `python .codebuddy/skills/iteration-workflow/scripts/audit-engine.py` | **ERR 0**（WARN 需登记 `runtime/TOOLING-TODO.md`） |
| 2 | `python .codebuddy/skills/iteration-workflow/scripts/validate-template-coverage.py --skill-dir .codebuddy/skills/iteration-workflow` | `ERR:0` |
| 3 | `node .codebuddy/skills/iteration-workflow/scripts/run-gate-tests.mjs` | BASE 0 失败 / FIX 全过 |
| 4 | 回流水位 | `python .codebuddy/skills/iteration-workflow/scripts/audit-engine.py --src <源仓库>`；不一致 ⇒ **登记 `AUDIT-n`**（回流无自动化机制，须人工） |

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
