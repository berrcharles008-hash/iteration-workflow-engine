# 等待方式协议（waiting-protocol）—— 全部确认等待点的统一细则

> **细则唯一来源 = 本文件**（2026-10-01 自 `phase-04.md` Step 1.6 迁移正本化 · RESUME-3 批次 1）。
> **适用范围**：引擎**全部**"停下等用户"确认点——各 phase 交付确认（01/03/04/05/06/07）、阶段推进门禁（`gate-protocol.md` §三-B）、startup 门禁（迭代门禁 / 复杂度等级）、迭代门禁（`gate-protocol.md` §一/§二）、workflow-engine 阶段完成模板。各确认点以一行指针引用本文件，**不得**复制细则（防漂移）。
> 工具判据与模板：`tools/qqbot/README.md` 方案 A/B/D；headless 边界口径与 `hooks/gate-check.mjs`（"不会自动执行、不会被 headless 代跑"）互引。
> ★ **可选工具前置判据（2026-10-05 tools/qqbot 入库分发后适用全部 QQ 途径）**：本文件所有 `tools/qqbot/*` 命令均以「项目存在 `tools/qqbot/`」为前提——无该目录的项目（引擎分发未装工具包）**静默跳过** QQ 途径：A/B/D 不可用，等待退化为回合内直接等待用户回复或既有静置通道，**不得**对不存在的脚本发出调用。

## 1. 等待方式（三选一）

- 用户在工位（通常 <5 分钟）→ **A**：`ask.js` 登记后自轮询答案文件（**2026-10-26 起 `ask.js` 默认等待 300s/片：登记与等待在同一进程内完成，无需再传 `--wait`**；等价退化 = 登记后跑 `wait-answer.ps1` 分片轮询）。分片 ≤5 分钟/片；`--no-wait` 仅限自动化 / 门禁回路；
- 用户离开工位、**本会话存活且可派 team** → **D**：派 waiter 成员代等（**一轮 = 2 片 × 15 分钟 = 30 分钟**；等待期主 Agent 零 token，QQ 回复经 waiter `send_message` 唤醒本会话）；
- 本会话已停 / **headless 或无 team 能力会话** → **B**：headless 接管（新会话 + handoff 传上下文）。
  ★ 非 team 会话（headless、`-p` 单发、Claude Code 无队友宿主）**跳过 D**，退 A 或交静置通道走 B（宿主退化另见 `team-agent-strategy.md` Step 7.5 / §六-b）。

## 2. 铁律

- 登记必须用 `ask.js`（输出 `#N` + `#ts`，可回复）；**禁止**只发单向通知却在文案里写"等你确认"。
- 阶段推进类确认（§三-B、workflow-engine 模板选择）用 `--options` 传结构化选项（如 `"A=进入下一阶段;B=留在本阶段修改"` ⇒ kind=decision，QQ 端渲染对照表，FIX-31）。
- 等待期用 `phase_status: blocked` 标注（恢复方据此区分"等待中"与"未开始"，避免重复执行）。
- ★ **登记 ≠ 等待**（2026-10-19 TOOL-QQWAIT 新增铁律）：只登记不等待 = **本次登记无效**。
  三种合法等待形态只能取其一，且不得都省 ——
  ① 模式 A：`ask.js --wait <秒>` 或登记后立即挂 `wait-answer.ps1` 分片轮询；
  ② 模式 D：登记后立即派 waiter 成员；③ 模式 B：登记时带 `--handoff` 交由 headless。
  **只登记然后结束回合 = 答复必然无人消费**（IDE 会话唯一唤醒通道 = team 成员 `send_message`；
  已实证 4 次：2026-09-29 / 10-01 / 10-19 / 10-26）。
- ★ **不存在「模式 E：用户在 IDE 聊天窗口直接回」**（2026-10-26 第 4 例实证，`#1` 答复 9 秒到达仍空转）：
  - 本会话结束回合后，用户在 **IDE 内发言** 能唤醒会话，但 **QQ 答复不能** —— IDE 会话无外部注入通道。
  - 非 `--handoff` 卡在服务端**只落盘、不做任何唤醒尝试**（`qqbot-service.js` 的 `doChoice()` `!p.handoff` 分支）。
  - ⇒「反正他在 IDE，会直接回我」**不构成**等待方式；仍须 A / D / B 三选一。
- ★ **判定口径（结束回合前自查一句）**：必须能指着某一具体对象说「它在等」——
  `--wait` 进程 / waiter 成员 / 已派 `--handoff`。指不出来即视为「只登记不等待」，先补齐再结束回合。

## 3. 等待时限与退化

- **A 与 D 同限：至多 30 分钟**（A = 分片 ≤5 分钟 × ≤6 片；D = 2 片 × 15 分钟）；片满仍未收到回复 ⇒ **停止等待**（不再续派），
  保留 `blocked` 标注并在 `pause_reason` 写明"等待用户超时"，此后交既有静置通道按需接管（超时推送文案已含后续路径指引，`qqbot-service.js` / `qqbot-daemon.js`，RESUME-1 T1/T2）。
- ★ 等待项**不得绑定"回复即起新会话"**——否则回复唤醒本会话的同时会另起一个干活者（双写撞车）。

## 4. 跨节点 invariant（QQ-WAKE-1）

- **每个新回合开工的第一动作** = 跑 `node tools/qqbot/poll-answer.js` 读回**未消费答复**（判定 = 答案文件无 `consumedAt`；`--json` 可编程消费）；
  ★ 前置判据：项目存在 `tools/qqbot/poll-answer.js` 才执行，无该可选工具的项目**跳过本步**（见头部可选工具前置判据）；
  适用于全部"等待后重开"路径（各 phase 确认点、§三-B、**宿主中断恢复后重开回合**）。
- ★ **能力边界**：读回 ≠ 唤醒会话 ≠ 自动执行 —— 答复**不唤醒**已静置会话；答复若属**不可逆动作**（提交/推送/发布/删除），仍须走 FIX-20 决策回路，**不得**因"读到了答复"就自动执行。
- ★ **消费动作**：处理完毕跑 `node tools/qqbot/poll-answer.js --consume`（写 `consumedAt`，幂等）；**不得**与 `wait-answer.ps1 -SinceIso` 同回合混用（`--consume` 会前移 mtime ⇒ 已消费答复会被误判新鲜）。
- ★ **新增 invariant（2026-10-19 TOOL-QQWAIT）**：`ask.js --wait` 命中后**不得**同回合再跑 `poll-answer.js --consume` —— `--wait` 不写 `consumedAt`，重复消费会让同一答复被再次读到。三套新鲜度判据并存且语义不同，勿混用：`wait-answer.ps1` 判**文件 mtime**、`poll-answer.js` 判 **`consumedAt` 字段**、`ask.js --wait` 判 **JSON 内 `ts` 字段**（服务端写入，`qqbot-service.js:1578`）。

## 5. 与阶段推进留痕的关系（批次 3 · 观测期）

- 阶段推进（`current_phase` 变更）须在**同一次写入**中落 `phase_confirm` 留痕段（schema 与 `by` 取值口径见 `state-protocol.md` §phase_confirm；执行条款见 `gate-protocol.md` §三-B）。
- `by:"ide"` 必须附 `quote:`（用户通过语**逐字原文** + 时间戳）——无 quote 的 ide 留痕视为无效。
- ★ **无原话的答复不构成 `by:"ide"` 的合法来源**（TOOL-ANSWERKIND · 2026-10-20）：`defer-ide` / `cancel` / `timeout` / `superseded` 天生没有"用户通过语"，**不得**用「通道 + 时间戳 + 转述」充当原话。事故原文 = 「用户 IDE 确认评审通过（ask#2 answer=ide @…）」= 自撰。
- ★ **命名撞车警告**：答案值 `defer-ide`（= QQ 侧作废、**未作答**）与留痕值 `by:"ide"`（= 用户经 IDE **确认**）**同源不同义**，禁止据答案值反推 `by`；答复类型处置见 §8。
- ★ **机器校验（TOOL-ANSWERKIND ④ · 2026-10-20 已落地）**：`state-apply.py phase-advance` 现强制三条 ——（a）给了 `--quote-src <文件>` 则 quote 须**逐字命中**该文件；（b）quote 含 `answer=` / `allowed=` / `answerKind` 等元数据 ⇒ 拒绝（用户不会这么说）；（c）quote 点名 `ask#N` 而该答案 `allowed=false` ⇒ 拒绝。此前该铁律只有文档、无执行点。
- 观测期（RESUME-3 批次 3 路线 I）：`gate-check.mjs` 仅通知不拦截；强制化（G1 fail-closed）另行拍板。★ **G1 观测期判定入口已落地（2026-10-07，TOOL-QQGATE 甲档）**：`--stop-check` 时校验 pending `-user-confirm` 步骤的 ask.js 登记证据（service.log `[ASK #N]` 行 vs `last_updated`），未登记 ⇒ notify.qqbot.js 直发单向提醒；超时静置态豁免；独立去重 `runtime/qq-g1-notify.json`。评审与转拦截前置：`runtime/TOOL-QQGATE-评审记录-3路.md`。

## 6. 「有无等待者」判据草案（★仅登记，未实施，不排期）

> 背景（2026-10-19 `#3` 空档）：登记后回合结束、答复落盘无人消费。现有 Stop 侧 G1 首关即 `ACTIVE=none` 直接 return（`engine/gate/gate-check.mjs:2161-2162`），覆盖不到"过程性确认点 + 无活跃迭代"场景。
> **本节为草案**，属 `TOOL-QQGATE` 乙档范围扩容（须重开评审或单立工单），**未拍板前不得实现**。

- **候选判据**：`ask.js --wait` / `wait-answer.ps1` 在等待期间落 `<id>.waiting` 心跳文件；Stop 时若无心跳且该 `#N` 无答案 ⇒ 判定"登记后无等待者" ⇒ 单向提醒。
- **三项未解前置**（解不掉不得实施）：① `ACTIVE=none` 时提醒 payload 的「迭代 / 确认步骤」两行无值可填，文案须重设计；② 去重指纹三要素全空 ⇒ 会重复提醒，须重定义；③ 新增读 `.codebuddy/temp/qq-answers/` 依赖 ⇒ 须加 `existsSync` 探测（未装 qqbot 的项目要能跳过），且 Stop hook 有 15s 超时上限。
- **明确不做**：Stop 侧**不能唤醒/续跑**原会话（IDE 不可外部注入）⇒ 只能是"事后提醒 + 防丢"，不替代模式 A 的同进程消费。
- **弃用判据**：不得改用 service.log `[ASK #N]` 裸解析 —— 该判据漂白风险已由 `TOOL-QQGATE` 三路评审实证（S1/S2/S6）。

## 7. `ask.js --wait` 实施状态（防"引擎推荐一个不存在的参数"）

- **工具实现已落地**（2026-10-19 实施 · 2026-10-20 复核对齐，本节原写"尚未落地"已过期）：
  `tools/qqbot/ask.js` 支持 `--wait [秒]`；`--wait` 无值或省略时等待 300s（= 1 片，可重入续等）。
  命中**授权**答复 exit 0 / **有答复但无授权** exit 4 / 片满无答复 exit 2（口径见 §8）。
- ★ **2026-10-26 改默认等待**（原 opt-in、缺省关闭）：第 4 例空转实证（QQ `#1` 答复 9 秒到达仍无人消费）
  表明「漏带参数」是主要失效面 ⇒ 默认值翻转为**等待**，`--no-wait` 才只登记。
  `--no-wait` 仅限自动化 / 门禁回路（`gate-check.mjs` 不可逆 spawn 已同批加 `--no-wait`）。
  失效方向随之翻转：漏带参数 = 多等 5 分钟（可观测、可续等），而不是静默空转。
- 工具层与引擎层**回流通道不同**：`engine/**` 随 skill 回流；`tools/qqbot/**` 当前无回流通道（随项目侧方案文档处理）⇒ 新项目装到新版协议但拿到旧 `ask.js` 时，按本节降级为 `wait-answer.ps1` 分片轮询（§1 已列为等价退化）。

## 8. 答复类型 → 允许动作（★ TOOL-ANSWERKIND · 2026-10-20）

> 事故：用户 QQ 回选项 D「回 IDE 原会话拍板（QQ 侧作废本项）」，答案文件为 `{"answer":"defer-ide","answerKind":"no-decision","allowed":false}`（历史值 `ide`）；会话把它读成「用户已在 IDE 确认通过」，连做两次 `phase-advance --confirm-by ide`（01→02 / 02→03）并自撰 quote。**2 次 `ide` 答复 = 2 次误判**。
> **铁律：读回答复先判类型、再决定动作。`answer` 不是布尔值 ——「有答复」≠「有授权」。**

**机器判据 = 答案文件的 `allowed`（boolean）**；`answerKind` 仅供展示与人读：

| answer | answerKind | allowed | 允许动作 |
|---|---|---|---|
| `confirm` | approve | true | 可按登记事项推进 |
| `choice`（附 `choice` 键） | approve | true | 只按该选项语义推进 |
| `text` | free-text | true | 按文本内容判断；**exit 0 仅表示"有答复可人读"，不等于可推进**，不得默认视为同意 |
| `cancel` | reject | false | 禁止按本项推进（本项作废） |
| `defer-ide`（历史值 `ide`） | no-decision | false | **禁止任何推进与阶段留痕**；结束回合并等用户在 IDE 直接发言 |
| `timeout` | no-answer | false | 停止等待，保留 `blocked`（§3） |
| `superseded` | no-decision | false | 不得据此推进 |
| 其他/未知 | unknown | false | fail-closed：不得据此推进 |

- ★ `defer-ide` **不是**「用户已在 IDE 确认」，而是「本次无结论」。把它当确认 = 伪造用户意图（§5 三条机器校验兜底）。
- ★ 工具侧口径（`tools/qqbot/` 存在时）：`wait-answer.ps1` / `ask.js --wait` 对 `allowed=false` 的答复输出 JSON 后 **exit 4**（0=授权 / 2=片满无答复 / 4=有答复但无授权）。不用 3 —— 该码已被 `request-confirm.js`（送达核验）占用。
- ★ 与 `phase_confirm.by` 的边界：答案值 `defer-ide` ≠ 留痕值 `by:"ide"`，见 §5 命名撞车警告。
