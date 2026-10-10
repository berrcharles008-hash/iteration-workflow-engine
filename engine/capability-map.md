# Skill 能力地图（capability-map）

> 用途：**一页看清本 skill 具备哪些能力、各自落在哪个文件、当前处于什么状态**。
> 定位：**索引层**——只回答"有什么 / 在哪 / 什么状态"；细则一律以落点文件为准（单点权威，本图不复制细则）。
> 阅读顺序：本图 → `engine/startup-protocol.md`（惰性加载表 = 文件视角）→ 落点文件。
> ★ 维护义务：任何引擎机制新增/变更/退役后**同批更新本图**；本图随引擎回流源仓库。
> ★ 基准：skill 内文件 = 相对 skill 根（反引号）；**项目侧文件（tools/、docs/ 等）以文字给出，不加反引号**。
> ★ 锚约定：落点用**文件 + 节名/标题串**（禁用行号——写入即漂移，P-139）。
> ★ 状态列 = **落盘时点快照**；权威状态见 `runtime/TOOLING-TODO.md` 观察项与实测（本列由维护义务更新，不烧录细节）。

## 状态图例

| 标记 | 含义 |
|:--:|:--|
| ✅ | 长期运行（已多迭代验证） |
| 🆕 | TOOL-INTV A+B 批（2026-10-10）新增 |
| ⏳ | 待业务迭代实测（观察项） |
| ⚠️ | 已知缺口 / 边界 |

---

## 1. 流程主干（9）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 七阶段流程与阶段推进 | 01→07 标准流程 + 阶段确认门 | `workflow-engine.md` · `phase-01.md`~`phase-07.md` · `phase-steps.md` | ✅ |
| 复杂度自适应 | 9 因素评分决定审查/流程强度 | `complexity-scoring.md` | ✅ |
| 步骤清单 SSOT | phase_steps 单权威 | `phase-steps.md` · `state-protocol.md` §八 | ✅ |
| 迭代门禁 | 新建/废弃/暂停/删除约束 | `gate-protocol.md` §二 | ✅ |
| 中断恢复 | ACTIVE + state 双副本 + 断点续跑 | `state-protocol.md` §四/§六 | ✅ |
| 轻量查询快速退出 | 只读查询不启流程 | `SKILL.md` §轻量查询 | ✅ |
| 多 Story 并行 | 单迭代多故事并行编排 | `multi-story-workflow.md` | ✅ |
| 每日工作日志 | Step E（对话结束前） | `startup-protocol-step-e.md` | ✅ |
| 本地文件自检 | Step A.5（缺文件/微核过旧时） | `startup-protocol-step-a5.md` | ✅ |

## 2. 需求澄清（01-02）（9）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 复述确认 | 先复述意图请确认，未确认不进追问 | `phase-01.md` §step-2-5 步 0 | 🆕⏳ |
| 动态追问 | 每轮 ≤3 问，无新暴露即收敛 | `phase-01.md` §step-2-5 步 1 | 🆕⏳ |
| 5W2H 兜底校验 | 七维完备性下限 | `phase-01.md` §step-2-5 步 2 | ✅ |
| 需求歧义消解 | ≥2 种解释 ⇒ 列候选选 | `phase-02.md` §需求歧义消解 | 🆕⏳ |
| 必须/建议分层 | 必须项缺失 ⇒ 🟡 不放过（正文两段） | `phase-02.md` "★ 必须明确 / 建议明确"两段 | 🆕⏳ |
| 澄清复审轮 | 新信息 ⇒ 复审；上限 3 | `phase-02.md` §澄清复审轮 | 🆕⏳ |
| 业务规则三段式 | 功能点/业务规则/验收标准闭环 | `templates/phase-01-需求记录.md` §4.1 · `templates/phase-02-需求评审.md` §3.1 | 🆕⏳ |
| 共享语言 CONTEXT | 术语映射快照 | `phase-01.md` §step-2-6 | ✅ |
| 目录对比 dir-diff | 起点扫目录 vs L1 | `phase-01.md` §step-1.6-dir-diff | ✅ |

## 3. 知识蒸馏（04-07）（8）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 模式候选现场登记 | 审查问题即记 `PC-xxx`（4 类） | `phase-04.md` §Step 5.5b | 🆕⏳ |
| 候选区清池 | 07 逐条转正/丢弃 | `phase-07.md` §Step 3 附 · `project/lessons-learned.md` 候选区 | 🆕⏳ |
| 置信度维护 | 0~1 分档 + 07 升降档 + 蒸馏剥离 | `lessons-learned.md` §七 | 🆕⏳ |
| 知识资产抽取 | 骨架/问答 → 项目层模板（两段式） | `phase-07.md` §Step 3 附 | 🆕⏳⚠️ |
| 端到端复盘 | 07 全等级 + 立即写入 + 落地验证 | `phase-07.md` §Step 5 / §6.1 | ✅ |
| 模式库蒸馏 | 活跃 >15 ⇒ 01-03 窗口 | `lessons-learned.md` §七 | ✅ |
| 前置注入 | 01 起点全量注入活跃区（≤20/≤10K） | `phase-01.md` 前置步骤 3 | 🆕⏳ |
| 事故案例库 | 编号/根因/内化位置 | `project/lessons-learned.md` 事故记录区 | ✅ |

## 4. 门禁与安全（9）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 修改门禁 | PreToolUse hook 阶段化放行面 | `engine/gate/gate-check.mjs` · `gate-protocol.md` §一 | ✅ |
| 门禁决策表 | 判定场景速查 | `gate-decision-table.md` | ✅ |
| 逃生口 | 手动标记（用户创建） | `gate-protocol.md` §一/§四 | ✅ |
| QQ 开闸通道 | 确认卡 ⇒ 服务执行 ⇒ revoke | 项目侧 tools/qqbot/request-confirm.js · tools/gate/open-bypass.js | ✅ |
| 关闸验证三件套 | 复现/负向对照/回归（措辞源 P-118） | `gate-protocol.md` §一/§四 · `project/lessons-learned.md` P-118 | ✅ |
| 删除类清单锚定 | delete_allow + `- path:` 结构 | `gate-protocol.md` §04 阶段的删除类操作校验 | ✅ |
| 多会话写者互斥 | 同文件并发写保护（CONC） | `engine/gate/gate-check.mjs` | ✅ |
| 不可逆动作决策回路 | 授权 + 登记双要件 | `engine/gate/gate-check.mjs`（IRREVERSIBLE_RE）· `gate-protocol.md` | ✅ |
| 记忆配额守卫 | MEMORY.md 写前估算 + 拦截 | `engine/gate/gate-check.mjs` | ✅ |

## 5. 状态与恢复（5）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| state 双副本 | `.codebuddy`/`.claude` + 判定源 | `state-protocol.md` §三/§六 | ✅ |
| state-apply 意图通道 | 10 命令 | `scripts/state-apply.py` · `state-protocol.md` §9.6 | ✅ |
| 严格校验 | YAML + 字段/枚举 | `scripts/validate-state.py` | ✅ |
| 备份与留痕 | 每次写 state 自动备份 | `state-protocol.md` | ✅ |
| ACTIVE 指针协议 | 2 行格式 + 释放铁律 | `state-protocol.md` §六 | ✅ |

## 6. 协作与异步（7）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| Team 并行决策 | 四维判据 + ≤3 / ≤15 万 | `team-agent-strategy.md` | ✅ |
| 成员直写白名单 | dispatch_whitelist | `phase-04.md` · `engine/gate/gate-check.mjs` | ✅ |
| 成员增量落盘 | team-out + 完成标记 | `phase-04.md` | ✅ |
| 等待协议 A/B/D | 工位/headless/QQ 唤醒 | `waiting-protocol.md` | ✅ |
| QQ 指令集 | /help · 开新迭代 · 继续 · 模型列表 | 项目侧 tools/qqbot/ | ✅ |
| 确认门 QQ 登记 | 未登记 ⇒ 单向提醒（G1） | `engine/gate/gate-check.mjs` | ✅ |
| 接管会话面板 | hub 确认/接管/派发 | 项目侧 tools/session-hub/ | ✅ |

## 7. 质量与审计（12）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 交叉审查 | 02/03/04 独立 Agent | `cross-review-protocol.md` | ✅ |
| 外部审查模型路由 | 多模型配置 + 降级（原则 13） | `cross-review-protocol.md` §八 · `scripts/review-models-configurator.py` · `scripts/review-gateway.py` | ✅ |
| Spec 合规验证 | 04 Step 4.7 | `phase-04.md` §Step 4.7 | ✅ |
| 代码审查矩阵 | 层触发 + 铁律 | `project/code-review-rules.md` · `phase-04.md` §Step 5 | ✅ |
| 一致性审计 A1~A8 | 引擎自审 | `scripts/audit-engine.py` · `consistency-checklist.md` | ✅ |
| 模板覆盖校验 | R1~R5/W1~W5 | `scripts/validate-template-coverage.py` | ✅ |
| 门禁回归 | 48 例（`run-gate-tests.mjs` 实测；"157/157" 为另一历史口径） | `scripts/run-gate-tests.mjs` | ✅ |
| 状态机回归 | T1~T10 | `scripts/run-state-tests.py` | ✅ |
| 记忆配额检查 | 索引 + 分片 | `scripts/memory_quota.py` | ✅ |
| 文档版式 | doc_lint | `scripts/doc_lint.py` · `doc-style-guide.md` | ✅ |
| 缺陷台账 | defects[] 即时登记 | `state-protocol.md` · `phase-05.md` | ✅ |
| 引擎自演进安全 | 四件套 + 快照 + 收口 + 回流 | `evolution-safety.md` | ✅ |

## 8. 度量与看板（4）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 迭代看板 | BOARD.md + board.html | 项目侧 tools/gen_iteration_board.py | ✅ |
| 阶段消耗 | 净工时 + wall-clock | 项目侧 docs/iterations/{id}/阶段消耗.md（机器生成） | ✅ |
| metrics 链 | phase-align → refresh | `runtime/metrics/` | ✅ |
| 崩溃监控 | HostStarvation 采样 | 项目侧 tools/eh-monitor.ps1 | ✅ |

## 9. 上下文与文档纪律（8）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 定点读纪律 | R1~R5 + ≤500 行/轮 | `context-discipline.md` | ✅ |
| 大文件定点读映射 | 6 文件场景 → 节 | `startup-protocol.md` §引擎大文件定点读映射 | ✅ |
| 知识库生成 | L1/L2/L3 + 过时检测 | `scripts/gen-knowledge-base.py` | ✅ |
| 变量注入 | `{{占位符}}` 协议 | `template-injection.md` | ✅ |
| Delta 标记 | ADDED/MODIFIED | `delta-marking.md` | ✅ |
| 版式规范 | D1~D10 | `doc-style-guide.md` | ✅ |
| 模板解析优先级 | project 覆盖 engine | `startup-protocol.md` §模板解析优先级 | ✅ |
| 命名冲突预检 | 03 阶段必做 | `naming-conflict-check.md` | ✅ |

## 10. 项目层可配置面（2）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 项目配置文件 | manifest / build-verify / deploy-config / 规范 / 审查矩阵 / context / 模式库 / review-models | `project/` | ✅ |
| 项目层模板覆盖 | 同名覆盖（路线 5；目录**未创建**，首次抽取时建） | `startup-protocol.md` §模板解析优先级 | 🆕⚠️ |

## 11. 安装与初始化（5）

| 能力 | 说明 | 落点 | 状态 |
|:--|:--|:--|:--:|
| 安装/初始化向导 | 项目接入与配置引导 | `scripts/init-checklist.ps1` | ✅ |
| 门禁注入 | 微核/钩子安装 | `scripts/setup-gate.py` | ✅ |
| 领域插件 | 领域门禁规则（enterprise-legacy / generic） | `domain-plugins/*/gate-rules.md` | ✅ |
| 回流同步 | 工作副本 → 源仓库 | `scripts/sync-back-to-engine-repo.ps1` | ✅ |
| 引擎版本号 | 版本模板 | `engine-version.template.txt` | ✅ |

## 缺口与边界（汇总）

1. 🆕 机制均**待业务迭代实测**（观察项：B1 候选区首登记/07 清池 · B5 置信度 07 升降档 · B6 首迭代注入）；
2. ⚠️ **覆盖不到的三种情形**：🟢 迭代 07 Step 3 跳过 · 无候选的迭代 B1 只走"无候选声明"分支 · 纯文档迭代无 04；
3. ⚠️ `project/templates/` **未创建**（裁定 C-07：首次真实抽取才建，无强制钩子）；
4. ⚠️ **源仓库回流水位**滞后（A6 含 A+B 批 15 文件 + 本批 3 文件 ⇒ 待回流窗口）；
5. ⚠️ 既有 drift（非本批引入，登记观察项）：惰性加载表自称"全部资源文件清单"但漏 9 个 engine md；`rules/` 上游内容未核；
6. ⚠️ 本图自身 drift 风险 ⇒ 维护义务 + 状态快照声明；**"落点存在性校验"已登记为后续工单**（audit 扩展候选）。

---

## 变更记录

| 日期 | 内容 |
|:--|:--|
| 2026-10-10 | 首次落盘：11 域 · 78 项能力索引 + 状态标记 + 缺口汇总（TOOL-CAPMAP；含 TOOL-INTV A+B 批 7 项新机制） |
| 2026-10-10 | v2（评审后）：补 11 项（外部审查路由/知识库/Step E/Step A.5/门禁决策表/状态机回归/安装初始化×2/领域插件/回流/版本号）· 修 4 处错锚（须/建议分层 → 正文两段；关闸三件套 → §一/§四+P-118；不可逆回路 → 补 gate-check.mjs；接管面板 → session-hub）· 项目侧路径去反引号 · 基准/状态快照声明 |
