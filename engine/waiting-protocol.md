# 等待方式协议（waiting-protocol）—— 全部确认等待点的统一细则

> **细则唯一来源 = 本文件**（2026-10-01 自 `phase-04.md` Step 1.6 迁移正本化 · RESUME-3 批次 1）。
> **适用范围**：引擎**全部**"停下等用户"确认点——各 phase 交付确认（01/03/04/05/06/07）、阶段推进门禁（`gate-protocol.md` §三-B）、startup 门禁（迭代门禁 / 复杂度等级）、迭代门禁（`gate-protocol.md` §一/§二）、workflow-engine 阶段完成模板。各确认点以一行指针引用本文件，**不得**复制细则（防漂移）。
> 工具判据与模板：`tools/qqbot/README.md` 方案 A/B/D；headless 边界口径与 `hooks/gate-check.mjs`（"不会自动执行、不会被 headless 代跑"）互引。
> ★ **可选工具前置判据（2026-10-05 tools/qqbot 入库分发后适用全部 QQ 途径）**：本文件所有 `tools/qqbot/*` 命令均以「项目存在 `tools/qqbot/`」为前提——无该目录的项目（引擎分发未装工具包）**静默跳过** QQ 途径：A/B/D 不可用，等待退化为回合内直接等待用户回复或既有静置通道，**不得**对不存在的脚本发出调用。

## 1. 等待方式（三选一）

- 用户在工位（通常 <5 分钟）→ **A**：`ask.js` 登记后自轮询 `wait-answer.ps1`（分片 ≤5 分钟/片）；
- 用户离开工位、**本会话存活且可派 team** → **D**：派 waiter 成员代等（**一轮 = 2 片 × 15 分钟 = 30 分钟**；等待期主 Agent 零 token，QQ 回复经 waiter `send_message` 唤醒本会话）；
- 本会话已停 / **headless 或无 team 能力会话** → **B**：headless 接管（新会话 + handoff 传上下文）。
  ★ 非 team 会话（headless、`-p` 单发、Claude Code 无队友宿主）**跳过 D**，退 A 或交静置通道走 B（宿主退化另见 `team-agent-strategy.md` Step 7.5 / §六-b）。

## 2. 铁律

- 登记必须用 `ask.js`（输出 `#N` + `#ts`，可回复）；**禁止**只发单向通知却在文案里写"等你确认"。
- 阶段推进类确认（§三-B、workflow-engine 模板选择）用 `--options` 传结构化选项（如 `"A=进入下一阶段;B=留在本阶段修改"` ⇒ kind=decision，QQ 端渲染对照表，FIX-31）。
- 等待期用 `phase_status: blocked` 标注（恢复方据此区分"等待中"与"未开始"，避免重复执行）。

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

## 5. 与阶段推进留痕的关系（批次 3 · 观测期）

- 阶段推进（`current_phase` 变更）须在**同一次写入**中落 `phase_confirm` 留痕段（schema 与 `by` 取值口径见 `state-protocol.md` §phase_confirm；执行条款见 `gate-protocol.md` §三-B）。
- `by:"ide"` 必须附 `quote:`（用户通过语原文 + 时间戳）——无 quote 的 ide 留痕视为无效。
- 观测期（RESUME-3 批次 3 路线 I）：`gate-check.mjs` 仅通知不拦截；强制化（G1 fail-closed）另行拍板。★ **G1 观测期判定入口已落地（2026-10-07，TOOL-QQGATE 甲档）**：`--stop-check` 时校验 pending `-user-confirm` 步骤的 ask.js 登记证据（service.log `[ASK #N]` 行 vs `last_updated`），未登记 ⇒ notify.qqbot.js 直发单向提醒；超时静置态豁免；独立去重 `runtime/qq-g1-notify.json`。评审与转拦截前置：`runtime/TOOL-QQGATE-评审记录-3路.md`。
