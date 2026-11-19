# 运行健康度评分（Run Health Scoring）

> 状态：**S1 已完成**（2026-11-19）。§1.1.1 形态定位、§1.2 三机制取舍、§1.2.1/§1.2.2 实测结构已定稿；§4 维度待 S3 定稿
> 建立：2026-11-19｜最后更新：2026-11-19（补 §1.1.1 形态定位）
> 来源：腾讯 LoopForge 对标分析（§1）
> 范围：iteration-workflow 引擎的**度量底座补齐** + **运行级评分新增**
> 不涉及：LoopForge 平台版能力的移植（见 §5）

## 0. 一句话

把「**skill 本身的质量评分**」（已有，`quality-improvement-roadmap.md`，40 分制）与「**单轮迭代的运行健康度评分**」（本文件新增）拆成两层。后者依赖前者没有的度量底座，而 0003 当前尚未安装该底座——这是本计划真正的工作量所在。

## 1. 背景：LoopForge 是什么，抄什么

### 1.1 事实速查（2026-11-19 核实）

| 项 | 值 |
|---|---|
| 仓库 | `Tencent/LoopForge`，MIT。**平台版 = Go**（`go.mod` / `cmd/` / `internal/` / `migrations/`），**Local CLI = Python 3.8+**（`src/devflow_cli`）+ Node 包装；此前按 GitHub 语言统计误记为"纯 Python"，2026-11-19 拿到完整仓库后更正 |
| 建仓 / 版本 | 2026-07 底 / v0.2.2（2026-09-16），npm `loopforge-cli` 同名同版本可下 |
| 体量 | 2026-11-02 第三方统计 48 star / 14 fork（同门 WeKnora 3.1 万星、BrowserSkill 7.9 千星） |
| 定位 | 不做编码 Agent，是**编排层/纪律层**：把 CodeBuddy、Claude Code、Codex、Cursor 等装进统一工作流 |
| 两种形态 | ① 平台版：Docker Compose，默认 8090，云端沙箱 + 多人共享会话 + SOP 画布 + 审批门禁 + 定时任务<br>② Local 版：`npx loopforge-cli skills install <host>` 装进本地 IDE，Node 20+ / Python 3.8+，6 段串行（理解需求→确认边界→设计→实现→独立评审→测试交付） |
| 六维评分 | 控制流健康 25%、耗时与等待 20%、工具浪费 20%、Token 效率 15%、错误恢复 10%、交付完整 10%；默认准入分 70 |
| 内部数据 | 20+ 业务、单月 200+ 需求（厂商自述，无第三方基线） |

### 1.1.1 形态定位：LoopForge 是「skill 外壳 + 声明式内核」（2026-11-19 定稿）

三个问题的结论，是本轮改造的总前提：

| 问题 | 结论 |
|---|---|
| LoopForge 是什么形态 | 两种并存：①**平台版**＝独立服务（Docker Compose，默认 8090，云端沙箱/多人共享会话/SOP 画布/审批队列/定时任务）②**Local 版＝skill**（`npx loopforge-cli skills install <host>`，83 文件）。不做编码 Agent，只做**编排层 + 纪律层** |
| 0003 与其是否同生态位 | **是**。两者 Local 版都是"装进 IDE 的 skill"；差别不在形态，在**壳里装了什么** |
| 是否需要换形态 | **否**。服务化 / MCP 化 / 多宿主适配都不解决任何一条现有问题（理由见 §5） |

**同生态位逐项对比**

| 维度 | LoopForge Local | 0003 iteration-workflow |
|---|---|---|
| 入口 | `SKILL.md` 4KB（只写"必须执行 / 不可绕过"） | `SKILL.md` ~12KB（含分级路由、加载优先级表） |
| 纪律载体 | **3 份 manifest 声明式**（agents / rules / templates） | **47 个 `engine/*.md` 叙述式** |
| 状态写入 | 统一 `workflow_state.py`；10 处 events append，**无手写路径** | `state-apply.py` + **仍存 Agent 手写 YAML 路径**（`phase-07.md:79-111`） |
| 产物校验 | `content_concepts` 章节合同 + `artifact_baseline` | 仅版式 lint（`doc_lint.py`），**无内容合同、无基线** |
| 门禁 | 进程级 `validate_artifacts.py` | **IDE 工具层 hooks**（比进程级硬一个量级） |
| 宿主适配 | 5 个 adapter | 2 个（`cursor/`、`generic/`，实际绑 CodeBuddy） |
| 度量 / 评分 | 六维评分，默认准入分 70 | **无**（本轮 S2~S4 在补） |

**核心判断（决定 §1.2 抄什么）**

> **skill 是包装层，不是护城河。** 真正的分野是「纪律写在文档里」还是「纪律写在代码里」——
> LoopForge 把纪律编译成 manifest + 可执行校验；0003 把纪律写成 47 个 md，靠 Agent 读到后自觉遵守。

**为什么"文档驱动内核"会随模型变强而更不可靠**（反直觉，但这是本轮最重要的一条）

现有纪律大量形如"禁全文回读""禁手写状态""禁跳过评审"。这些对人类读者是规范，对 Agent 只是一条**可被重新权衡的建议**。模型越强、越自主，"自觉遵守"的方差越大——强模型更倾向"我判断这样做更好"，从而绕过步骤。唯一稳的形态是把**"不该做"改写成"做不了"**：

| 纪律类型 | 现状 | 目标 |
|---|---|---|
| 能做但禁止 | 手写 `state.yaml`、复制旧报告过门禁 | 通道关闭 / 校验拒绝（M2 / M1） |
| 靠人判断该读什么 | 47 个 md 靠 `SKILL.md` 分级路由 | 脚本按证据确定性注入（M4） |
| 已经"做不了" | 业务区写入被 hooks 拦、绕过须用户手动开闸 | **保持**，这是现存最硬的一层 |

**因此 §1.2 的三项取舍不是"借鉴 advanced 功能"，而是同一命题的三个断面**：M1＝产物完整性从"应当"变"必须"；M2＝状态写入从"应当"变"必须"，并顺带产出评分数据源；M4＝上下文路由从"人的判断"变"脚本的确定性"。S2/S3/S4 补的是第三层——**没有度量就没有反馈信号，无法证明任何一次引擎改动是变好还是变坏**（`quality-improvement-roadmap.md` 的 40 分制是对 skill 这件产品的人工打分，替代不了运行级反馈闭环）。

**形态层的不做（与 §5 一致，此处只记理由）**：不换掉 skill；不上服务化；不做 MCP server 封装（单客户端单用户，多一层进程 + 版本同步面，收益为负）；不做多宿主适配——但 `engine/*.md` 保持**宿主机中立**、`adapters/` 保持薄，作为零成本期权。

### 1.2 三机制取舍（S1 已定稿）

逐阶段抄 LoopForge 的 6 段流程是无效功——与 0003 的 7 阶段高度重合且更细。真正有差异的只有三处，S1 判定结果如下：

| 编号 | LoopForge 做法 | 0003 现状（实测） | 取舍 | 落地动作 |
|:--:|---|---|---|---|
| **M1** | `templates/manifest.json` 声明每个产物的 `content_concepts`（必需章节）→ `validate_artifacts.py` 校验章节存在/非空/非占位；`prepare` 记录 `artifact_baseline`，`finish` **只接受 prepare 后新增或变化的产物** | `doc_lint.py` 只管**版式**（D1~D15：单元格字数/行宽/粗体密度），`scan-placeholders.py` 查占位符；**无内容合同、无产物基线** | **抄，且是本轮最高价值项** | ① 在 `engine/templates/` 增产物→必需章节声明；② 给 `state-apply.py` 或新增校验器加"基线比对"；③ 不抄 SHA-256（那是 LoopForge **平台版**产物抽屉的特性，Local 版没有） |
| **M2** | `workflow-state.json` v2.0 + `workflow_state.py`（56KB，仅标准库）子命令集：`init/prepare/start/assign/finish/approve/resume/validate/rotate-team`；`events[]` **append-only**；每阶段 `retry_count` + executor 绑定 | `state.yaml` + `state-apply.py` + `validate-state.py` + `runtime/ACTIVE`；审计留痕散在 `write-claims.jsonl` + `gate-audit.log` + `runtime/snapshots/*.bak`（106 个）；部分状态更新**靠 Agent 手写 YAML** | **抄三件（含 append-only events[]），不抄整体** | ① `resume`：**只读返回 next action**；② `rotate-team`；③ `events[]` 审计旁路 + 评分数据源（边界见 §1.2.3）。**不重写 56KB 状态机** |
| **M3** | `agents/manifest.json` 声明每角色的 `input_artifacts`（精确白名单）/ `workspace_evidence` / `access`（`write`/`report`/`read`/`test-write`）；REVIEW 为独立 Agent，`blocking issues = 0` 才放行；IMPLEMENT 每批最多 3 个计划任务 | `gate-check.mjs` 能拦 **IDE 工具层**（比 LoopForge 的进程级门禁更硬）+ `cross-review-protocol.md` + `review-gateway.py` | **门禁已更优；只抄「声明化」两处** | ① 抄 `input_artifacts` 白名单（下游只读清单内上游产物 ⇒ 省 token，与你「轻量查询不加载大文件」的口径同向）；② 抄 `approve --user-confirmed` 的纪律条文：「**不得由 Agent 自行推断用户确认**」，落到 02 评审确认 |

### 1.2.1 M4（S1 新增发现）：signals 驱动的规则注入

原以为只有三个可抄点，解包后发现第四件、且可能是最容易见效的一件：

| 机制 | 实现 | 为什么对 0003 有价值 |
|---|---|---|
| **证据驱动规则注入** | `rules/manifest.json` 给每条专项规则声明 `signals`：`filenames`（`go.mod`/`vite.config.ts`…）、`package_dependencies`、`evidence_extensions`（`.vue`/`.sql`…）、`path_parts`、`terms`、`state_flag`；`inspect_context.py` 探测项目约定 → `rule_registry.py` 命中 → `build_stage_prompt.py` **确定性注入**当前阶段 + 命中项，不注入"可能相关"的全集 | 0003 的 `engine/` 有 47 个 md，目前靠 `SKILL.md` 人工分级路由（你此前明确提出「查状态只读 ACTIVE，禁止加载 SKILL.md/引擎文件」）。LoopForge 把这层判断**下沉到脚本**，人能少做一次路由决策，且注入结果可复现 |

**注**：M4 属工程效率改造，不属运行健康度评分范围。记在此处只为不丢结论，**实施优先级排在 S1~S4 之后**，或单独开一笔。

### 1.2.2 LoopForge Local 的实际结构（v0.2.2 解包实测）

不是"6 段串行提示词"，而是一套带注册表 + 状态机脚本的完整实现（83 个文件）：

```
skills/devflow/
├── SKILL.md                    入口（4KB，只写"必须执行"与"不可绕过"）
├── agents/    manifest.json（角色唯一事实源）+ 10 个角色 md（218~506B，极薄）
├── rules/     manifest.json（stage_rules + profiles.signals）+ core/stages/*.md
├── templates/ manifest.json（产物唯一事实源）+ 11 个模板 + workflow-state.json
├── references/ workflow-contract / agent-execution / runtime-core / quality…
├── scripts/   14 个 py（workflow_state.py 56KB、build_stage_prompt.py 11KB…）
├── adapters/  claude / codebuddy / codex / cursor / shared
└── commands/  devflow.md
```

关键设计：**三份 manifest 各管一件事**（角色 / 产物 / 规则），彼此不复制；脚本只依赖 Python 3.8+ 标准库；Python 不可用时读 `manual-runtime.md` 跑等价门禁，**不得跳过**。

### 1.2.3 append-only events[] 的收益与边界（2026-11-19 决议：抄）

**LoopForge 实测**：`workflow_state.py` 共 10 处 `data["events"].append(...)`，事件类型为 `workflow_initialized` / `stage_prepared` / `stage_started` / `stage_{completed|failed|overflow}` / `stage_executor_assigned` / `research_helper_recorded` / `stage_approved` / `knowledge_decision` / `workflow_team_rotated` / `execution_policy_upgraded`，**全部只增，无删除与改写**，字段 = `at` + `event` + `stage` + 事件专有字段。

**0003 现状**：审计留痕**已有但分散三处**——`write-claims.jsonl`（CONC 口径）、`gate-audit.log`（`STATE_APPLY` tag）、`runtime/snapshots/*.bak`（现存 106 个快照）。状态字段本身是就地改写，无历史。

**收益（四条，按价值排序）**

| # | 收益 | 说明 |
|:--:|---|---|
| 1 | **解锁两个评分维度** | `控制流健康`（重试/失败/跳步）与 `错误恢复`（failed→completed 的转换次数）目前**无法自动算**，因为现状要跨三处文件 + 106 个快照做 diff。`events[]` 是最低成本的唯一数据源。没有它，这两维只能靠人工回顾打分 |
| 2 | **恢复时能答"为什么停"** | `resume` 只读返回「下一步是什么」；`events[]` 补上「上次为什么停、停过几次、谁批准的」。这是 M2 里 resume 语义的另一半 |
| 3 | **快照可降频，runtime 瘦身** | 现在每次状态写入都留 `.bak`。events 被信任后，快照可从「每次写」降为「每次迭代/每日」，直接压缩 runtime 体积（当前 106 个 .bak 是主要膨胀源） |
| 4 | **评分脚本免解析历史** | 直接 `filter(events)` 取数，不必 diff 快照序列或解析 YAML 历史 |

**边界（三条硬约束，防范围失控）**

1. **审计旁路，不做事件溯源**。状态字段仍是唯一真相源，events 只记录"改了什么"，**不由 events 重放推导 state**。做事件溯源等于重写整个状态机，明确不做。
2. **只允许脚本写入**。`events[]` 若允许 Agent 手写 YAML 追加，一旦漏写就名存实亡。这条与 M2 的"状态写入统一收进 `state-apply.py`"是同一件事——**手写路径必须关闭**（这本身就是收益：倒逼掉 `phase-07.md` 那段"手写追加 3 行、格式红线、错一字符即漏"的脆弱路径）。
3. **历史迭代 fail-open**。32 个既有 state 无 events 属正常态，评分侧输出 `—`（沿用 `estimate_*` 先例），不回溯补齐。

**事件最小集（首版，够喂评分即可，不追求覆盖全部动作）**：`iteration_started`、`phase_advanced`、`step_completed`、`validation_failed`、`gate_bypassed`、`iteration_archived`。预算 30~60 事件/迭代、3~6KB/迭代。

### 1.3 与 `quality-improvement-roadmap.md` 的边界（勿混）

| | 已有：skill 质量评分 | 本文件：运行健康度评分 |
|---|---|---|
| 对象 | skill 这件产品本身 | 单轮迭代的一次运行 |
| 触发 | 批次评估时人工/半自动 | 每个迭代 07 阶段自动算一次 |
| 维度 | 可靠性/安全性/Token 效率/DX/可扩展性/演化 | 见 §4（控制流、耗时、浪费、Token、恢复、交付） |
| 分值 | 40 分制，当前 31/40 | 0~100，待定准入分 |
| 谁来改 | 改引擎代码/文档 | 只出分数和建议，不改引擎（见 §5） |

两者不同层，不能互相替代；本文件不修改 `quality-improvement-roadmap.md` 的评分口径，只在其 §剩余可改进项 增一行指向本文件。

### 1.4 本地参考资料（2026-11-19 拉取）

后续实施借鉴时**不需要再联网**，两份参考物已在本地：

| 位置 | 内容 | 用途 |
|---|---|---|
| `D:\sj-skills\refs\LoopForge-main\` | **完整仓库**，3475 文件 / 109 MB。含 `cmd/`、`internal/`（Go 服务端）、`web/`（前端）、`skills/`（devflow skill 全文）、`migrations/`、`compose.yaml`、`design.md`、`AGENTS.md`、`CHANGELOG.md`、`e2e/`、`webtest/` | 要求证某个机制"原本怎么实现"时的权威源；平台版能力（沙箱/共享会话/Human Gate/RSI）的实现细节都在此 |
| `%TEMP%\lf-022\package\` | npm `loopforge-cli@0.2.2` 解包（83 个 skill 文件 + 9 个 CLI 源文件） | 只需看 Local 版工作流定义与安装器时用这份，体积小 |

**取数路径备忘**：`github.com:443` 在本机**不可达**（`git clone` 报 `curl 28` 超时），raw/codeload 亦超时。可行通道 = **`https://ghfast.top/` 前缀镜像**（`ghproxy.net` 会截断大文件、`ghps.cc` 404、`kkgithub.com` 证书过期、`github.moeyy.xyz` 超时）。下载命令：

```powershell
curl.exe -sSL -m 600 -o LoopForge-main.zip "https://ghfast.top/https://github.com/Tencent/LoopForge/archive/refs/heads/main.zip"
```

> 注意：`Expand-Archive` 只认 `.zip` 后缀，临时文件改名成别的扩展名会报"不是支持的存档文件格式"。
> 另有一个**同名不同源**的 npm 包 `loopforge@4.1.0`（`kyrielrving11/LoopForge`，描述为 "Durable round runtime for coding agents…"，319 文件），属该谱系的衍生实现，**不能当作腾讯官方源码引用**。

## 2. 现状取证表（2026-11-19 实测）

| # | 项 | 实测值 | 取证方式 | 影响 |
|:--:|---|---|---|---|
| 1 | 引擎源仓库 `D:\sj-skills\iteration-workflow-engine` | 无任何 `*metric*` 文件（递归零命中） | `Get-ChildItem -Recurse -Filter *metric*` | 度量实现**不随引擎分发**，属项目侧实现 |
| 2 | 0003 `runtime/` | 仅 `snapshots`、`temp`；`runtime/metrics` 不存在 | `Test-Path` = False | 见 #3 |
| 3 | 0003 `phase-07.md` §归档 ③ 三条命令 | **全部不可用**：`refresh-metrics.mjs`（无 metrics 目录）、`tools/gen_doc_index.py`（**脚本不存在**，0003 `tools/` 仅有 `fix_doc.py`/`gen_iteration_board.py`/`update_doc.py`/`verify_iteration_board.py`）、`tools/gen_iteration_board.py --report`（存在但 `--report` 恒 exit 2） | 目录枚举 + 历史记录 | 07 归档的自检判据 a/c 目前无法产出 |
| 4 | 0010 `runtime/metrics/` | 完整：`token-scanner.mjs`、`phase-align.mjs`、`iteration-align.mjs`、`refresh-metrics.mjs`、`gen-estimate-baseline.mjs`、`day-boundary-probe.mjs` + 4 个 csv + `sessions/` | 目录枚举 | **可移植素材现成**，S2 有解 |
| 5 | `npm view loopforge-cli` | v0.2.2，tarball `registry.npmjs.org/loopforge-cli/-/loopforge-cli-0.2.2.tgz` | 命令实测 | S1 取数无阻，不必访问 GitHub |
| 6 | 0003 `runtime/ACTIVE` | `none`，`STATUS=none`，更新于 2026-11-17T16:22 | 读文件 | 无活跃迭代，落档与改造不侵入在跑迭代 |
| 7 | 引擎仓库 git 状态 | 工作区干净，HEAD = `60b9c6d` | `git status --short` 空 | 可直接新增并提交 |
| 8 | 0003 `runtime/*.state*.yaml` | **仅 2 个**（`2026-11-17-001` 活跃 + `2026-11-17-002` 已归档）；全项目递归 `*.state*.yaml` 同样只此 2 个 | `search_file` 全库递归 | 历史迭代窗口**不可回算** ⇒ ① 轮次归属率 `assign` 实测仅 **1.69%**（3728/3792 轮落窗外，sessions/ 覆盖 06-17~11-19）；② §8 步骤 6 的"3~5 个历史迭代回测"**不可行**，须改为前向验证 |

### 2.1 移植风险（S2 必读）

| 风险 | 依据 | 对策 |
|---|---|---|
| **多库串味**（已解决，S2a） | 原版默认「多库发现」，扫 `Data/` 下**全部** uuid 库。实测本机有 **14 个**库、约 **28 万** json | 已在 `token-scanner.mjs` 开头加 `DEFAULT_WS='9528a857-99e6-409b-a532-3978e16d93df'`（0003 侧库），默认单库；传 `--all` 恢复多库，`METRICS_WS_UUID` 可临时换库 |
| **时间窗串味**（✅ 已解决，S2b 2026-11-19） | `iteration-align` 的归属判据是 `tsMs ∈ [startMs, endMs)`，**不看项目**；而 0003 与 0010 由同一账号在同一 IDE 并行工作，会话共存于同一 uuid 库 | 解法＝**派生窗尾裁剪**：`end` 非 `ended_at` 来源（兜底推导）且存在后继迭代时，窗尾收敛到后继 `startMs`。`iteration-align.mjs` 与 `phase-align.mjs` **同源同步**（后者复制了同一套窗口推导，漏改会对账恒等破裂）。实测：001 窗 `[11-17T09:45, 11-17T11:05)`、002 窗 `[11-17T11:05, …)`，`overlap-with-prev` 消失，轮次仍 12/52 **归属结果不变**，sanity=PASS |
| 硬编码绝对路径 | `day-boundary-probe.mjs` 内写死 `e:/SJYL/.../0010静配中心管理系统/...` | 该脚本是探针，**不移植**；若需要则改为参数化 |
| 看板生成器依赖 | `refresh-metrics.mjs` 调 `python tools/gen_iteration_board.py --html`，可用 `METRICS_BOARD_PYTHON` 覆盖解释器 | 0003 已有该脚本 ✅；`--report` 恒 exit 2 属已知欠账，不阻断 |
| 首次全量扫描耗时 | `refresh-metrics.mjs` 软超时默认 300s | 首跑放宽 `METRICS_REFRESH_SOFT_TIMEOUT_MS`；必要时分两步（先 `--board-only`） |

## 3. 阶段计划

范围已按 2026-11-19 决策扩为四项机制（M1 抄 / M2 含 events / M4 现在一起做 / S2~S4 原计划），执行序如下：

| 序 | 步骤 | 内容 | 动代码 | 预估 | 停止点 |
|:--:|:--:|---|:--:|:--:|---|
| — | **S1** | 三机制拆解 + 取舍定稿 | 否 | 1~1.5h | ✅ 已完成（2026-11-19） |
| **1** | **S2** | 度量底座移植（0010 → 0003 `runtime/metrics/`） | 是（新增目录 + `tools/`） | 1.5~2h | `refresh-metrics --force` 退出 0 |
| **2** | **M4** | signals 驱动规则注入（`rules/manifest.json` + `inspect_context.py` + 注入器） | 是 | 2~3h | 每个阶段只注入命中规则，且注入结果可复现 |
| **3** | **M2** | 状态写入统一（关闭手写 YAML 路径）+ `events[]` 审计旁路 + `resume` 只读返回 + `rotate-team` | 是 | 3~4h | 无手写 YAML 追加路径；`resume` 只读不改文件 |
| **4** | **M1** | 产物内容合同（`content_concepts` 声明 + 校验器）+ `artifact_baseline` | 是 | 2~3h | 旧报告无法过 `finish` 门禁 |
| **5** | **S3** | 评分维度/权重/阈值定稿（写回 §4） | 否 | 0.5h | ✅ 定稿后不再改 |
| **6** | **S4** | 评分脚本 + 07 接入 + 历史回测 | 是 | 2~3h | 3~5 个历史迭代回测有区分度 |

**排序依据（三条依赖关系，不可随意调换）**

1. **S2 必须最先**：它是评分的唯一数据源，且完全独立于引擎改造、零回归风险；同时是最大未知项（metrics 移植能否在 0003 跑通），先暴露风险。
2. **M2 必须早于 M1**：M1 的 `artifact_baseline` 要落进 `state.yaml` 并走统一写入路径。若 M1 先做，会先造一条"手写 baseline"的临时路径，随后被 M2 的写入统一推翻 ⇒ 返工。
3. **M4 排 M2/M1 之前**：它改动面最小（新增 `rules/manifest.json` + 探测/注入两个脚本，规则正文复用现有 47 个 md）、不依赖前两者、且落地后每次阶段加载都受益（降 token）。它的 `stage_rules` 映射到 7 个阶段文件，不受 M1/M2 改动影响。

**总预估**：11~16h，必然跨多次会话 ⇒ 每一步都回写 §6 勾选表。

### S1 对标拆解（只读）

1. `npm pack loopforge-cli@0.2.2` → 解包到 `%TEMP%`（不写工作区）
2. 只读三类文件：skill 模板（阶段定义/门禁）、artifacts schema、resume 状态机
3. 产出：回填本文件 §1.2 三行取舍结论 + §4 初稿
4. **不做**：逐阶段流程对比表（收益接近零）

### S2 度量底座移植（动代码）

1. **2a 最小链路**：先只移 `token-scanner.mjs` + `phase-align.mjs` + `refresh-metrics.mjs`，加 ws-uuid 限定，跑通一次
2. **2b 补齐**：`iteration-align.mjs` + `gen-estimate-baseline.mjs` + 初始 csv
3. **不移植**：`day-boundary-probe.mjs`、历史 csv（0003 首跑自然重建）、`refresh.log`、`sessions/`
4. 验收：`node <skill>/runtime/metrics/refresh-metrics.mjs --force` 退出 0，产出 `sessions.csv` / `phase-aggregates.csv`，`docs/iterations/阶段消耗.md` 出现本迭代行
5. 写入位置：`<项目根>/.codebuddy/skills/iteration-workflow/runtime/metrics/`（该目录在 `EXEMPT_PATHS` 内，无需开闸）

### S3 维度定稿（文档）

输入 = S1 取舍结论 + S2 实际能取到的字段。输出 §4 终稿：维度、权重、准入分、每维取数口径与降级规则（取不到数输出 `—` 而非 0，沿用 `estimate_*` 的既有先例）。

### S4 评分脚本 + 07 接入

| 决策 | 结论 | 理由 |
|---|---|---|
| 脚本放哪 | **`runtime/metrics/score-run.mjs`** | 数据源同目录；`scripts/` 会进 `audit-engine.py → a6_reflux()` 的对比面，被迫回流引擎仓库，而引擎不分发 metrics ⇒ 必然矛盾 |
| 引擎改动量 | 仅 `engine/phase-07.md` 增一小节 | 回流面积最小化（本节是唯一需回流引擎仓库的改动） |
| 门禁写法 | 「若 `runtime/metrics/score-run.mjs` 存在则执行；不存在打印 SKIP，不阻断」 | 未装 metrics 的实例（含引擎仓库自身）不能因此变红 |
| 是否自动回写 | **否**。只输出分数 + 建议清单，人工决定是否改 SOP/门禁 | 对标 LoopForge 的「一键应用」但降级为人工，理由见 §5 |
| 回测 | **改前向验证**（原「取最近 3~5 个已完成迭代」不可行） | 依据 §2 #8：历史 state 只剩 2 个，且其 `phase_history` 已固定 ⇒ 无样本可回算。替代：首批 2~3 个**新**迭代跑完再校准权重；首个迭代分数只作观测、不参与准入判定 |

## 4. 维度裁剪草案（待 S3 定稿）

| LoopForge 维度 | 权重 | 0003 取数可行性 | 候选处置 |
|---|:--:|---|---|
| 控制流健康 | 25% | 部分：`gate-check.mjs` 拦截记录 + `phase_history` 跳步 | 保留，口径改为「**门禁拦截 → 自愈 → 复发**」三段式 |
| 耗时与等待 | 20% | 可：`phase_history.completed_at` + `started_at` | 保留，需扣除人工等待（`waiting-protocol.md` 的挂起时长），否则长等待迭代被误判 |
| 工具浪费 | 20% | 部分：步骤重试计数 | 保留，降权（无云端工具调用轨迹可比） |
| Token 效率 | 15% | 可（S2 之后）：`token-scanner.mjs` | 保留，权重上调（这是 0003 唯一能硬取的成本指标） |
| 错误恢复 | 10% | 部分 | 保留 |
| 交付完整 | 10% | 可：07 交付标准 checklist | 保留 |

**0003 特有候选维度（LoopForge 没有）**

| 维度 | 取数来源 | 说明 |
|---|---|---|
| `门禁绕过率` | `hooks/.gate-bypass` 创建次数 + TTL 使用时长 | 0003 门禁能拦 IDE 工具层，绕过行为是真实质量信号 |
| `产物复用率` | **依赖 M1 落地**：`artifact_baseline` 记录 + `finish` 基线比对 | 度量"有多少产物是 prepare 后新写的、多少是拿旧报告过的门禁"。**M1 未落地前此维不可算** |

> ★ S1 联动结论：`交付完整` 与 `产物复用率` 两维的可信度**完全依赖 M1**。若 M1 不落地，则"交付完整"只能靠人工 checklist 打分（弱证据），建议届时将该维权重压到 5% 以下或直接删除。
> 权重、准入分、降级规则 **S3 定稿**；本表仅供 S1 判定取舍时参考，不作为实现依据。

## 5. 明确不做

| 项 | 理由 |
|---|---|
| Docker 云端沙箱 + 快照休眠 | 单仓本地开发，无「合盖断流」痛点；引入运维面得不偿失 |
| 多人共享会话 + Main Bot | 单人使用，会话模型重构成本远超收益 |
| Human Gate 审批队列 | 已有 `waiting-protocol.md` + 用户确认机制，且门禁本身更前置 |
| RSI「一键应用」自动改写 SOP | 引擎自改风险高，且与 `evolution-safety.md` 的变更纪律冲突；降级为「分数 + 建议清单，人工决定」 |
| 9 种执行器适配 | 只用 CodeBuddy |
| 照抄六维权重 | 为「云端多 Agent + 沙箱」调优，与单仓 IDE 口径不符 |
| 逐阶段抄 devflow 6 段流程 | 与 0003 的 7 阶段高度重合，无增量 |
| 走正式迭代流程管理本改造 | 自举问题：被改造对象即门禁本身，中途基准不稳（见 §7） |

## 6. 进度勾选（代替 state.yaml）

> ★ **下次开工 = §8 步骤 5（S3 评分维度定稿）—— 这是「停止点」，需用户先拍板维度与权重再动手**。
> M2 / M4 / M1 三机制已于 2026-11-19 全部落地并部署到 0003 实例。跨会话接手顺序：读本表看进度 → 读 §8 对应任务卡 → 直接执行，不要重新取证（取证结论已固化在 §2 / §2.1 / §1.2.2）。

| 阶段 | 状态 | 完成时间 | 备注 |
|:--:|:--:|---|---|
| 落档（本文件） | ✅ | 2026-11-19 | |
| §1.1.1 形态定位 | ✅ | 2026-11-19 | 结论：skill 形态不动，改内核；「应当 → 必须」是 M1/M2/M4 的共同命题 |
| S1 三机制拆解 | ✅ | 2026-11-19 | `npm pack loopforge-cli@0.2.2` 解包至 `%TEMP%\lf-022`，结论回写 §1.2 / §1.2.2 |
| S1 用户确认取舍 | ✅ | 2026-11-19 | 决议：**M1 抄**；**M2 含 append-only events[]**（边界见 §1.2.3）；**M4 现在一起做** |
| S2a 最小链路跑通 | ✅ | 2026-11-19 | `token-scanner` + `iteration-align` + `phase-align` + `refresh-metrics` 四件已移植；`--force` 输出 `OK … hit=96.70% sanity=PASS phase=ok board=ok`；产出 `sessions.csv`/`iterations.csv`/`phase-aggregates.csv`/`history.csv` + 两个迭代的 `docs/iterations/*/阶段消耗.md` |
| S2b 窗重叠修复 + hit 口径正名 | ✅ | 2026-11-19 | 派生窗尾裁剪（`iteration-align` + `phase-align` 同源改）；`history.csv` `hit_rate`→`cache_hit`，日志新增 `assign=`（归属率）。实测 `rounds=3792 unassigned=3728 cache_hit=96.70% assign=1.69% sanity=PASS phase=ok board=ok` |
| S2b 剩余：`gen-estimate-baseline` | ✖ 不移植 | 2026-11-19 | 该脚本是 0010 的 #67 工件：`SAMPLE_GATE=5` 且 `TYPE_MAP` 为 0010 专属迭代枚举。0003 现存 state 仅 2 个 ⇒ 输出必然全 `null`，无样本意义 |
| **T0 收益基线采集（§9.3）** | ⚠ 折价完成 | 2026-11-19 | **事后补采**（M1 之后），六项值见 §9.3「T0′ 折价基线」。1/3/5/6 未被污染、2 换替代口径（0 次手写）、4 的行为证据永久失去（只剩 12.4 KB 设计锚点） |
| M4 规则注入 | ✅ | 2026-11-19 | 三件产物：`engine/rules/manifest.json`（v1.1，`base_rules` + `stage_rules` + 13 profiles）、`scripts/inspect-context.py`（单次 walk 采证据）、`scripts/build-stage-prompt.py`（清单 + 命中理由）。验收：两次跑 04 输出**逐字一致**；00 阶段 0 基础规则 + 2 阶段文件（轻量查询不注入）；恒真信号已清除 |
| M2 状态写入统一 + events | ✅ | 2026-11-19 | `state-apply.py` 新增 `append-steps` / `rotate-team` / `resume`（只读）+ 每次成功写入自动 append `events[]`；`phase-07.md` 内联写盘模板已删除；`state-protocol.md` 新增 §9.7；门禁新增 `isStateYamlDirectWrite` 前置拦截。回归 **20/20 PASS** |
| M1 内容合同 + 基线 | ✅ | 2026-11-19 | `engine/templates/manifest.json`（7 产物 × full/lite 双档）+ `scripts/validate-artifacts.py`（6 判据）+ `state-apply.py` 的 `baseline-set` / `artifact-check`。真实两迭代 14 文件 0 ERROR；旧 07 报告复制必拒；`run-state-tests.py` 24/24 |
| S3 维度定稿（§4） | ☐ | | **停止点** |
| S4 评分脚本 + 07 接入 | ☐ | | 放 `runtime/metrics/score-run.mjs` |
| S4 历史回测 | ☐ | | |
| 回流引擎仓库 | ☐ | | 仅 `engine/` 与 `scripts/` 的改动；`runtime/metrics/` 不回流 |

## 7. 为何不走正式迭代流程

改造对象就是 iteration-workflow 引擎本身。若开一个正规迭代：S2 改 `runtime/metrics/`、S4 改 `engine/phase-07.md`，而 04~06 阶段的门禁、自检、归档判据都依赖这些文件——等于边开车边换轮胎，05/06 阶段的基准会在改造中途漂移。

替代：本文件的 §6 勾选表承担可恢复性。若将来需要更强可追溯性，必须拆成两笔：第一笔只补 metrics（不改引擎，可走迭代），第二笔才改引擎。

## 8. 后续实施清单（按序）

> 2026-11-19 决议已锁定：**M1 抄**；**M2 连 append-only `events[]` 一起抄**（边界见 §1.2.3）；**M4 现在一起做**。
> 本清单是跨会话执行入口。新会话接手：先读 §6 勾选表确认进度，再读本节对应任务卡，不要重新取证。

### 步骤 1 ｜ S2b：修时间窗串味 + 核对 hit 口径（✅ 已完成 2026-11-19）

**实测结论（收口）**

| 项 | 结果 |
|---|---|
| 裁剪实现 | `iteration-align.mjs`：`endFromEndedAt` 标记 + sort 后裁剪循环 + `localMin()` 输出时刻级 `windowEnd` + note 记「窗尾裁剪至后继立项 <id>@<ts>」；`phase-align.mjs` **同源同改**（该文件复制了整套窗口推导，漏改必然对账破裂） |
| 窗结果 | `001 [2026-11-17T09:45, 2026-11-17T11:05)` / `002 [2026-11-17T11:05, 2026-11-18)`；`overlap-with-prev` 消失 |
| 归属不变性 | 轮次仍 `12 / 52`，sanity S1/S2 双 PASS ⇒ 裁剪只收敛口径、不改分配 |
| hit 口径定论 | **确认为缓存命中率**：`cache_hit = 1 - sumCacheMissTokens/sumInputTokens`（实测 96.70%）。`history.csv` 表头已改 `cache_hit`（历史行同列同义，无需迁移）；日志改为 `cache_hit=…% assign=…%` 双口径并列 |
| 归属率新事实 | `assign = 1.69%`（3728/3792 轮落窗外）。根因见 §2 #8：**state 只剩 2 个**，非窗逻辑缺陷 ⇒ 影响 S3/S4 取样口径 |

**原任务卡（保留备查；实现口径以本节「实测结论」为准）**

**问题**（S2a 实测）：两个 11-17 迭代的窗都兜底到 `2026-11-18`，触发 `WARN:overlap-with-prev`，归属走"归 start 最大者"⇒ 001 只剩 12 轮、002 记 52 轮。

**根因**：`iteration-align.mjs` 兜底段——`ended_at` 缺失时 `endExcl` 由 `max(completed_at ∪ last_updated)+1d` 推导。而 `state-protocol.md:119-127` 明确 `ended_at` **不在必填清单**，所以这是常态而非异常。

**改法（原建议：兜底链，按优先级取第一个可用值）**

```
ended_at → 末条 phase_history.completed_at → 后继迭代的 started_at → start+1d（最后兜底）
```

> ★ 实施偏移：兜底链只解决"end 取哪个值"，**消不掉同日两迭代的结构性重叠**（两者的候选值都会拉到次日，冲突照旧）。实际改用**派生窗尾裁剪**：`end` 非 `ended_at` 来源时，窗尾直接收敛到后继迭代 `startMs`。既不引入新的日期猜测，又能把假重叠归零。

**核对项**：`refresh-metrics.mjs` 的 `hit=96.70%` 口径。按轮次算归属率仅 64/3788≈1.7%，与该值不符，疑为**缓存命中率**（`cachedInput/input`）。若确认是缓存口径 ⇒ 改名为 `cache_hit` 并在 `history.csv` 表头注明，**不得**当归属率使用。

**改动面**：原估「仅 `iteration-align.mjs`」**偏低** —— `phase-align.mjs` 复制了同一套窗口推导，必须同源同改，否则 `iterations.csv` 与 `phase-aggregates.csv` 的对账恒等破裂。实测改动 4 处：`iteration-align.mjs`、`phase-align.mjs`、`refresh-metrics.mjs`（命名 + 双口径日志）、`history.csv` 表头。不动引擎、不回流。

**验收**：`node runtime/metrics/refresh-metrics.mjs --force` 输出 `sanity=PASS`；`iterations.csv` 两行均无 `overlap-with-prev`；`phase-aggregates.csv` 中 001 的最大 `windowEnd` < 002 的最小 `windowStart`。

### 步骤 2 ｜ M4：signals 驱动规则注入（✅ 已完成 2026-11-19）

**实测结论（收口）**

| 项 | 结果 |
|---|---|
| 产物 | `engine/rules/manifest.json` v1.1｜`scripts/inspect-context.py`｜`scripts/build-stage-prompt.py` |
| manifest 结构 | `base_rules{files, exclude_stages}` + `stage_rules{primary, always}` + `profiles[]{id,title,file\|files,stages,signals}`；signals 支持 `filenames`/`package_dependencies`/`evidence_extensions`/`path_parts`/`terms`/`state_flag`（与 LoopForge 同名，便于未来对标） |
| 确定性 | 同项目 + 同 stage + 同 request 连跑两次，输出**逐字一致**（集合全程排序、理由固定序遍历、不读 mtime） |
| 轻量路径 | `--stage 00` 输出 0 条基础规则 + 2 条阶段文件（`startup-protocol` + `context-discipline`），不含任何 `phase-0X` ⇒ 满足"查状态不加载引擎"的既有口径 |
| 恒真信号清除 | 初版用 `path_parts:.codebuddy` 表达"always"，导致 4 条基建规则恒命中、且 `path_parts:iteration-workflow` 让 `evolution-safety` 每次误注入。已改为显式 `base_rules` + `evolution-safety` 仅 terms 命中 |
| 性能 | 单次 walk 1659 文件（忽略 `node_modules/dist/obj/bin/.git`，`MAX_DEPTH=6`，上限 20000 文件）；输出 `scan.truncated` 供降级判断 |
| 实际注入量（0003 · 04 阶段） | 基础 4 + 阶段 2 + 命中 5 = **11 件**；未命中 4 件（team-agent / multi-story / cross-review / evolution-safety）**不注入** |

**待办**：`SKILL.md` 接入点（"进入阶段 N 时先跑 `build-stage-prompt.py`，失败则回退分级路由"）尚未写入——属 §8 步骤 2 的收尾动作，与 M2 一起落。

**原任务卡（保留备查）**


**目标**：47 个 `engine/*.md` 从"人工分级路由"改为"脚本按证据确定性注入"。

**改动面**：新增 `engine/rules/manifest.json`（阶段→规则文件 + 每条规则的 `signals`：`filenames`/`dependencies`/`evidence_extensions`/`path_parts`/`terms`）+ `scripts/inspect-context.py`（扫项目证据）+ `scripts/build-stage-prompt.py`（阶段 + 命中 ⇒ 注入清单）。规则正文复用现有 md，不改写内容。

**验收**：① 同一项目连跑两次，注入清单逐字一致（确定性）；② 轻量请求（查状态）不注入 `phase-04/05` 等无关文件；③ `SKILL.md` 的分级路由保留为降级路径，双轨一段时间后再收。

### 步骤 3 ｜ M2：状态写入统一 + `events[]` + `resume` + `rotate-team`（✅ 已完成 2026-11-19）

**实测结论（收口）**

| 项 | 结果 |
|---|---|
| `events[]` | 每次成功写入自动块末追加 `at/event/version/detail`；块不存在时建在文件**末尾**（不打乱既有顶层顺序）；`validate-state.py` 对未知顶层键不设白名单 ⇒ 零改动通过 |
| 事件类型（12） | `session_summary` / `step_completed` / `step_skipped` / `task_completed` / `phase_advanced` / `blocker_added` / `blocker_removed` / `defect_opened` / `defect_closed` / `state_patched` / `steps_appended` / `workflow_team_rotated` |
| `append-steps` | 替代 `phase-07.md:79-111` 内联脚本；块末追加 + 重复 id ABORT；实测 `total=52`、`version 64→65`、validate exit 0 |
| `rotate-team` | `in_progress → pending`（本次 0 条，因该 state 无 in_progress）；实测 version 65→66 |
| `resume` | 在 `mkdir` 锁**之前**返回 ⇒ 实测 mtime 前后完全一致、无 `.lock` 残留；`completed` 迭代输出 `nothing-to-do` |
| 顺带修复 | `SNAPSHOTS.mkdir(exist_ok=True)` → `parents=True`：演练/新装实例 `runtime/` 整体不存在时原实现抛 `FileNotFoundError`（生产因目录恒在未暴露） |
| 既有回归 | `run-state-tests.py` **20 passed / 0 failed**（T1~T15，含幂等/锁/回滚/双侧单写） |
| 门禁 | `gate-check.mjs` 新增 `isStateYamlDirectWrite()`：目标命中 `runtime/*.state.yaml` **且文件已存在** ⇒ 拦；新建（立项初始化）仍放行；Bash 伪路径与 Delete 工具不在此拦 |
| 门禁验证（✅ 2026-11-19 沙箱实测） | 三态：已存在 `state.yaml` + Edit ⇒ **rc=2 拦截**；不存在 ⇒ rc=0（立项初始化不受影响）；Bash ⇒ rc=0。门禁回归 `run-gate-tests.mjs` **72/72 PASS（100%）** |
| ★ 位置坑（务必记住） | 拦截**不能**写在 `gateCheck()` 内：`runtime/<id>.state.yaml` 落在 `ALWAYS_ALLOW` 的 runtime/ 豁免段，第 1 关就 `exit 0` ⇒ **死代码**（初版即如此，沙箱探针恒 rc=0 才暴露）。正确位置 = 与 `phaseAdvanceGuard` 同层，紧随其后、`isAlwaysAllow` 之前 |
| ★ 沙箱验证的两个环境坑 | ① `.gate-bypass` 生效期间 hook 直接走 allow ⇒ 必须用不含标记的隔离根；② IDE 注入的 `CODEBUDDY_PROJECT_DIR` 会让 shim 回指真实项目（覆盖 `__dirname` 推导）⇒ 子进程 env 必须剔除 `CODEBUDDY_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`/`GATE_HOST_IDE` |

**原任务卡（保留备查）**


**改动面**：① `scripts/state-apply.py` 新增 `append-steps` 子命令（替换 `phase-07.md:79-111` 那段内联 python 手写脚本）；② `state.yaml` 增 `events:` 段，每个写操作 append；③ 新增只读子命令 `resume --read-only` 返回 next action；④ 新增 `rotate-team`（放弃旧 executor 绑定 + in-progress → pending）。

**验收**：含 events 的 state 过 `validate-state.py` 无 ERROR；手写 YAML 路径在门禁里被拦；`resume --read-only` 不改任何文件（用 mtime 验证）。

### 步骤 4 ｜ M1：产物内容合同 + `artifact_baseline`（✅ 已完成 2026-11-19）

**实测结论（收口）**

| 项 | 结果 |
|---|---|
| 合同 | `engine/templates/manifest.json`：7 个产物（01~07），每档 `content_concepts{full,lite}`；档位由 state 的 `complexity` 自动定（🟢=lite） |
| 校验器 | `scripts/validate-artifacts.py`：6 判据 `missing`/`no-concept`/`empty`/`placeholder`/`leftover`/`reuse`；`--iteration` 缺省读两侧 ACTIVE；`--json` |
| 判据复用 | 占位符正则 import `inject-template.py` 的 `PLACEHOLDER_RE`（加载失败降级兜底正则 + WARN）；`leftover` 跳过行内代码与围栏 |
| 为什么跳行内代码 | 002 的 04 有 4 处 `{{MODULE_TABLE_HEADER}}` 是在描述待改造项（合法引用），全文命中会误杀 |
| reuse 单向性 | 只比**更早**迭代目录（目录名字典序），防同内容两边互指；先按 size 预筛再算 sha256 前 16 位 |
| 基线 | `baseline-set --phase NN` 写 `artifact_baseline{phase,set_at,files[path,sha]}`（锚在 `last_session_summary` 后） |
| finish 判据 | `artifact-check` 只读（锁前返回）输出新增/变化/未变/消失；**未变即拒**（=阶段开始就有、结束没重写） |
| 只读性 | 实测 mtime 零变化、无 `.lock` 残留（与 `resume` 同口径）；缺基线默认 SKIP、`--require-baseline` 才拒 |
| 接入点 | `phase-07.md` §6.1 前置自检加两行 + 两时点注；`SKILL.md` 与 `SKILL.template.md` 双份加 M1 段（阶段开始 `baseline-set`） |
| 验收 | 002（🟡full）/ 001（🟢lite）各 7 文件 0 ERROR；旧 07 报告复制进新迭代 ⇒ `reuse` rc=1；空骨架/占位各报 `empty`/`placeholder` |
| 回归 | `run-state-tests.py` **24/24 PASS**（新增 T16 baseline 写入/未变即拒/变化放行、T17 缺基线两分支） |
| 顺带修复 ① | `run-state-tests.py` 的 `PROJECT=parents[4]` 在引擎源仓库少一级 ⇒ IndexError（回归在仓库内跑不起来，已加兜底） |
| 顺带修复 ② | `SKILL.template.md` 缺 M4 接入段 ⇒ A10-e 模板漂移 ERR；补 M4+M1 两段后 A10-e 转 OK（审计 ERR 17→16，余量均既有） |
| 已知遗留 | 引擎仓库 M2/M4/M1 改动**全部未提交**；0010 实例未同步。T0 已于 2026-11-19 折价补采（§9.3「T0′」），其中第 4 项行为证据永久失去 |

**原任务卡（保留备查）**

**改动面**：① `engine/templates/manifest.json` 声明每个产物的 `content_concepts`（必需章节）；② 校验器（扩 `doc_lint.py` 或新增 `scripts/validate-artifacts.py`）查章节存在/非空/非占位；③ `prepare` 记 `artifact_baseline`，`finish` 只接受基线后新增或变化的产物。

**验收**：把旧迭代的 07 报告复制进新迭代目录，`finish` 必须拒绝。

**取证锚点（2026-11-19 实测，新会话不必重跑）**

| 事实 | 值 |
|---|---|
| `engine/templates/` | 18 个 md（phase-01~07 各含 lite/full 两档）+ `review-models.example.json`；**无 `manifest.json`**（M1 需新建） |
| `scripts/doc_lint.py` 现有能力 | `is_produced_doc` / `is_iter_doc` / `check_ac_rules`（验收标准规则）/ `check_file`（单元格字数·行宽·粗体密度）/ `collect_targets` / `main`；**无章节存在性检查** |
| 阶段开始/结束钩子 | 只有 `state-apply.py phase-advance`（单命令完成"旧阶段入 `phase_history` + 推进 `current_phase`"）；**没有 LoopForge 那种 `prepare`/`finish` 双命令** ⇒ M1 的 baseline/finish 需自建等价物 |

**三个待拍板决策（开工前先定，别边写边改）**

| # | 决策 | 候选 | 建议与理由 |
|:--:|---|---|---|
| 1 | 校验器放哪 | ① 扩 `doc_lint.py` ② 新建 `scripts/validate-artifacts.py` | **②**：版式（D1~D15）与内容合同是两类规则，合并会让 `doc_lint` 既有回归面变大 |
| 2 | `artifact_baseline` 存哪 | ① `state.yaml` 的 `artifact_baseline:` 块 ② `runtime/temp/*.json` | **①**：M2 已把 state 写入统一进 `state-apply.py`（version + 备份 + events 全在链上）；放 temp 等于再开一条无审计旁路 |
| 3 | baseline 用 mtime 还是内容 hash | ① mtime ② 内容 sha256 前 16 位 | **②**：要拦的是"把旧迭代报告复制过来充数"——复制会刷新 mtime 但内容不变，mtime 判不出来 |

**落地骨架（建议顺序）**

1. `engine/templates/manifest.json`：`{ "<产物路径模式>": { "phase": "01", "tier": "full|lite", "content_concepts": [...] } }`；首版只声明 7 个 full 档，lite 档留空 = 不校验（避免一上来就拦死 lite 流程）
2. `scripts/validate-artifacts.py --phase 07 --root <项目根>`：扫当前迭代该阶段产物 ⇒ 逐条查章节存在/非空/非占位；占位判据复用既有实现，不另造一套
3. `state-apply.py` 增 `baseline-set`（`phase-advance` 之后调用，记内容 hash）与 `artifact-check`（只读比对，输出"基线后新增/变化/未变"三类）
4. `phase-07.md` 归档步骤前插一步：`validate-artifacts.py --phase 07` ⇒ 未过则**拒绝归档**

### 步骤 5 ｜ S3：评分维度定稿

依赖 S2 实测数据 + M1 是否落地（未落地则 `交付完整`/`产物复用率` 两维降权或删除，见 §4 联动结论）。

### 步骤 6 ｜ S4：评分脚本 + 07 接入 + 回测

**改动面**：`runtime/metrics/score-run.mjs`（不回流）+ `engine/phase-07.md` 增一小节（唯一需回流项，写成"若脚本存在则执行，否则 SKIP 不阻断"）+ 3~5 个历史迭代回测。

**验收**：分数有区分度（不全部挤在 85+ 或全部不及格）。

## 9. 收益论证方案

### 9.1 三个难点

1. **改造对象是流程本身，不是产品功能** ⇒ 没有用户指标、没有转化率可用。
2. **样本极少**：改造前有度量数据的迭代只有 2 个（`2026-11-17-001` / `002`）。
3. **收益类型不同**，不能用一把尺子：S2/S4 是"从无到有"（能力增量），M4 是"减少浪费"（效率），M1 是"防止事故"（质量）。

### 9.2 三种论证范式（按收益类型选，不要混用）

| 范式 | 适用项 | 论证方式 | 判定标准 |
|:--:|---|---|---|
| **A 能力增量** | S2 度量底座、S4 评分 | 不做 A/B，只证明"改前不可用、改后可用" | 覆盖率：有 `阶段消耗.md` 的迭代数 / 总迭代数。改前 = **0/2**（`runtime/metrics` 目录根本不存在，07 归档③ 三条命令全不可用）→ 改后 = **2/2** |
| **B 前后基线对比** | M4 规则注入、M2 写入统一 | 改造前采 N 次基线，改造后同口径再采 N 次 | M4：同类任务**注入字符数降幅 ≥ 30%**；M2：手写 YAML 路径次数 = **0**（硬指标，不做百分比） |
| **C 反事实举证** | M1 内容合同 | 无法证明"本来会漏"，只能举**真实可复现的实例** | ≥ 1 例：某个旧产物若不改造就能过门禁，且改造后确实被拦 |

### 9.3 基线必须在动手前采（T0，否则永久失去对照）

| # | 指标 | 采集方式 | 服务于 |
|:--:|---|---|---|
| 1 | metrics 覆盖率 | 数 `docs/iterations/*/阶段消耗.md` 存在数 ÷ 迭代总数 | S2 |
| 2 | 手写 YAML 状态更新次数 | 统计 `runtime/state-apply.log`（19.8 KB）与 `gate-audit.log`（4.79 MB）中的写入/校验失败记录 | M2 |
| 3 | 状态更新占用的 step 数 | 引用 `state-protocol.md:1040` 的既有实测：**一次更新 = 2 个 step ≈ 105 s，写入载荷生成占所在 step 11%~62%** | M2 |
| 4 | 轻量/中量请求的实际读取集 | 手工记 3 次（查状态 / 改代码 / 写文档）各自读了哪些文件、合计字节；对照 `SKILL.md` 12.4 KB 这个全量基线 | M4 |
| 5 | 旧产物复用实例数 | 扫 `docs/iterations/*/` 产物 mtime，与对应 state 的 `phase_history` 阶段窗比对：产物 mtime **早于**该阶段开始时间 ⇒ 复用 | M1 |
| 6 | 迭代返工 / 超时 / blockers | 从各 `state.yaml` 的 `blockers`、`phase_history` 重试记录、07 报告返工条目统计 | S4（作为评分的外部效标） |

> 第 4、5 项必须在改造前做，因为改造后环境已变，回溯不出"原本会读多少"和"原本会漏几次"。

#### T0′ 折价基线（2026-11-19 补采 · M4/M2/M1 之后）

> 采的时候三个机制已落地 ⇒ 只能叫「折价 T0」。六项里 4 项未被改动影响（1/3/5/6）、1 项换替代口径（2）、
> 1 项行为证据已失（4）。**凡本表数值受改造影响者，逐行注明口径**；引用时不得写成"改造前实测"。

| # | 指标 | T0′ 值 | 口径 / 折价说明 |
|:--:|---|---|---|
| 1 | metrics 覆盖率 | **2/2 = 100%** | `docs/iterations/*/ 阶段消耗.md` 存在数 ÷ 迭代数；M1/M2/M4 都不新增产品级 metrics ⇒ 与动手前等价 |
| 2 | 手写 YAML 次数 | **0 次** | 替代口径 = Σ`version` 增长（`63+43`=106）− `state-apply.log` 非测试行 **106**。原口径（"日志里数写入/失败记录"）无法反向识别手写 |
| 3 | 更新占用 step 数 | **2 step ≈ 105 s** | 直接引用 `state-protocol.md:1040` 的 PERF-1 实测，随时可复核 |
| 4 | 轻量/中量读取集 | 锚点 **12.4 KB**（SKILL.md 全量）；改造后 `--stage 04` = **0.9 KB / 26 行**、`--stage 00` = **0.2 KB / 14 行** | 行为证据（人工记 3 次读了哪些文件）**未采，永久失去**；只剩「设计基线 vs 清单体积」的可机械复现对照 |
| 5 | 旧产物复用实例 | **0 例** | 14 个产物逐一比 mtime vs `phase_history` 阶段窗（mtime < 阶段开始即复用）。M1 不改历史产物 ⇒ 值未污染 |
| 6 | 返工 / 超时 / blockers | blockers **0**、defects **0**、任务 **34/34**；"阶段完成后又被改"的文件 **5 个**（001 的 03/05、002 的 01/03/07） | 前四项读 state；末项是"回改"代理指标，不等于缺陷返工 |

**修正 §9.3 的注（实测后）**：第 5 项**可回溯**——产物 mtime 与阶段窗都还在，M1 只新增检查不改历史文件；
真正永久失去的只有**第 4 项**（行为观测未留档）。

**两个必须记住的结论**

- 第 2 项 = **0 次手写**、第 5 项 = **0 例复用** ⇒ M1 与 M2 在 0003 历史样本里**没有"改造前有问题"的实例**。
  §9.2 C 项的反事实举证**只能用人造探针**（把 002 的 07 报告复制进新迭代目录 → `reuse` rc=1），不得声称"修了 N 例"。
- 0003 只有 2 个迭代，且 `state-apply.py` 自 2026-10-03 起就在用 ⇒ M1/M2 在本项目内**注定无法被证明有收益**，
  只能算「防回归护栏」；效率结论必须等 T2/T3 的前向样本（≥3~5 个新迭代）。

**口径维护（第 2 项）**：统计前必须剔除测试行。`run-state-tests.py` 的旧实现把日志/备份写进**真实** runtime
（`LOG`/`SNAPSHOTS` 用脚本安装位置而非 `STATE_APPLY_ROOT`），2026-11-19 已修为跟随 `STATE_APPLY_ROOT`，
当日的 26 行 `iter=TEST-STATE-APPLY` 与 41 个测试备份已清除。今后若再看到 `iter=TEST-*`，属回归未隔离，
先修脚本再统计，不要把它算进基线。

### 9.4 时点与判定

| 时点 | 动作 | 结论性质 |
|:--:|---|---|
| **T0** 改造前 | 采 §9.3 六项基线（第 4、5 项为一次性手工） | 建立对照 |
| **T1** 每步改造完 | 只做**功能验收**（§8 各步骤的验收断言），不宣布收益 | 可用/不可用 |
| **T2** 改造后 3 个迭代 | 复采第 1、2、3、6 项，做范式 B 对比 | 效率结论（初步） |
| **T3** 改造后 5 个迭代 | 算评分与外部效标的**相关性**（Spearman：评分 vs 返工率 / 超时次数 / blockers） | 评分体系是否有效的唯一硬证据 |

**必须承认的边界**：T3 之前，"改造有效"只是**待验证假设**，不是结论。5 个迭代样本仍偏小，只能看方向不能算显著性。

### 9.5 控制变量（否则会被"你只是换了模型"一句话推翻）

对比时只允许同一条件内比较：**同复杂度等级**（🟢/🟡/🔴）+ **同模型版本** + **相近上下文长度**。跨模型、跨任务类型、跨复杂度等级的对比一律不采信。

### 9.6 回滚条件（先定，避免沉没成本绑架）

| 项 | 触发条件 | 回退动作 |
|:--:|---|---|
| M4 | 出现 ≥1 次"该加载的规则没加载"导致漏判 | 退回 `SKILL.md` 人工分级路由，manifest 仅作提示 |
| M2 | state 膨胀 > 20 KB/迭代，或 `validate-state.py` 明显变慢 | `events[]` 外置为 `runtime/events/<迭代ID>.jsonl` |
| M1 | 正确产物被误拒 > 10% | 校验降为 WARN，不阻断 `finish` |
| S4 | 评分全部挤在 85+ 或全部不及格（无区分度） | 权重回炉重定，不接入 07 |

## 附 A：取证命令留档

```powershell
# 1. npm 包可取性
npm view loopforge-cli version dist.tarball repository.url

# 2. 引擎仓库是否含度量实现（零命中 = 不随引擎分发）
Get-ChildItem 'D:\sj-skills\iteration-workflow-engine' -Recurse -Filter "*metric*"

# 3. 0003 是否已装度量底座（False = 未装）
Test-Path '<项目根>/.codebuddy/skills/iteration-workflow/runtime/metrics'

# 4. 0010 可移植素材清单
Get-ChildItem 'e:/SJYL/三佳工程/master-pre/branches/dev/0010静配中心管理系统/.codebuddy/skills/iteration-workflow/runtime/metrics'

# 5. 当前迭代状态
Get-Content '<项目根>/.codebuddy/skills/iteration-workflow/runtime/ACTIVE'
```
