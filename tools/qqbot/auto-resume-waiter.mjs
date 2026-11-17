#!/usr/bin/env node
/**
 * auto-resume-waiter.mjs —— 成员「上限暂停」自动注入续跑 · 判据引擎（TOOL-AUTORESUME，2026-10-27）
 *
 * 为什么存在：
 *   成员触顶（`isMaxStepLimit: true` / `isMaxTokenLimit: true`）后会话进入「执行已暂停」，
 *   平台**没有对外 API** 点「继续」；唯一可用通道 = 同队 `send_message` 注入固定文本
 *   （2026-10-27 P1 实测：注入后 0.5~0.7s 即 `onAgentStart: userInput=<teammate-message>` 恢复）。
 *   ★ 硬约束：恢复窗口仅 **1~4 分钟**（completed 成员 60s~2.7min 即 `cleanupSession`，
 *     cleanup 后注入**已反向实证无效**）⇒ "QQ 通知 → 人回 → 注入" 人工往返必超窗。
 *   正解 = **秒级自动注入**，QQ 卡降为兜底知会。
 *
 * 分工（本脚本**不含**任何注入动作，也不做自由判断）：
 *   本脚本只做「监控 → 归因 → 判定」，输出一行 JSON；`send_message` 由派出的常驻 waiter **成员**执行
 *   （waiter 零判据自由度，照 JSON 办事）。派发协议见 `engine/phase-04.md` Step 2 ⑦。
 *
 * 归因（工单 §方案①，补 MEMBERSTALL-2 遗留缺口「暂停信号行不带 conversationId」）：
 *   ① **reporter → conv 映射**：`onAgentStart/onAgentEnd` 行**同时**含 reporter id 与 conversationId
 *      （实测 `[AgentReporter] [<reporter 32hex>]  onAgentStart: … conversationId=<32hex>`）
 *      ⇒ 逐行学习；暂停锚 `[AgentReporter] [<reporter>] … Step N ended (… isMax*Limit: true)` 用同一
 *      reporter 反查 conv（该行**同时**含 reporter 与 isMax 标记 ⇒ 精准反查，胜过按时间猜）。
 *   ② **兜底** = 暂停前最后活动且**未收口**（`lastAt > endAt`）的本队成员会话。
 *   团队/成员来自 `Team restored` / `startTeamMemberAgent` 行 —— 非本队（无 member 名）一律不注入。
 *
 * 红线（工单 §护栏，全部落在判据里，调用方无法绕过）：
 *   - 目标会话已 `cleanupSession SUCCESS` / `Agent destroyed` ⇒ `GUARD`，**禁止注入**（反向已实证无效）；
 *   - 暂停后出现 IDE 恢复锚（`onAgentStart: userInput=请继续执行未完成的任务。`）⇒ 用户已手点 ⇒ 不注入；
 *   - **每暂停事件只注入一次**（subject = conv + 分钟号，跨重启持久）；
 *   - 只注入本队成员（无 member 名的会话不可达，天然被挡）。
 *
 * ★ 观察窗按「读到时刻」算（2026-10-27 真实验收）：IDE 日志有写缓冲，锚点时间戳可能比它在文件里**可见**的
 *   时刻早 25~110s ⇒ 120s 窗内 4 次 tick 也可能读不到 ⇒ 判 NO-RESUME 后仍保留 **600s 迟到锚纠正窗**
 *   （命中即改判 RESUME 并清 failedAt，避免 failed 粘滞导致后续真暂停被跳过发卡）。每 tick 写
 *   `temp/auto-resume-waiter.log`（含 newLines / lagSec）以便量化滞后。
 *
 * 心跳（供 stall-watcher「防双通道」读取，工单 §护栏④）：
 *   `{IDE}/temp/auto-resume-waiter.json` = `{ ts, onDuty, status, failed, failedAt, target, injectedAt }`。
 *   stall-watcher 见新鲜心跳（`autoResumeFreshSec`）且 `failed=false` ⇒ 抑制上限暂停卡；
 *   waiter 死亡（心跳过期）或 `NO-RESUME`（failed=true）⇒ 卡照发（不漏发）。
 *
 * 用法：
 *   node tools/qqbot/auto-resume-waiter.mjs --once        # 单轮（waiter 每 ~75s 调一次，stdout 一行 JSON）
 *   node tools/qqbot/auto-resume-waiter.mjs --selftest    # 离线自测（合成日志/时钟，不碰真实 state）
 *   node tools/qqbot/auto-resume-waiter.mjs --status      # 打印当前 state + 心跳（只读）
 *   node tools/qqbot/auto-resume-waiter.mjs --replay-file <log>   # 对真实日志空跑归因（不写 state）
 *
 * 退出码：0 = 正常（含 WAIT/OBSERVE/IDLE 等）；1 = selftest 失败；2 = 参数错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(__dirname, '..', '..');

/** 注入文本 —— 与 IDE「继续」按钮同文本（实测两处等价，日志锚可区分来源） */
export const INJECT_TEXT = '请继续执行未完成的任务。';

// ── 判据常量（全部预写于此；waiter 成员不得改写）──
const MAX_LINE = 2000;                    // ① 超长行截断（102K queue.full 行曾致误判）
const RECORD_RE = /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{1,3}\] \[\w+\]/;   // 记录行形态
// ★ 回显防护：我方查询/脚本自身的命令行会被日志回显（含 isMax*/onAgentStart 字面串）⇒ 整行不参与判定
const ECHO_RE = /Select-String|\[Tool:|参数解析完成|decodedPreview=|\[StreamParser\]|\[StandaloneTerminal|\[TerminalExecutor\]|auto-resume-waiter/;
const REPORTER_RE = /\[AgentReporter\]\s+\[([0-9a-f]{32})\]\s+(.*)$/;   // reporter + 行内容
const CONV_RE = /conversationId\s*[:=]\s*([0-9a-f]{32})/;   // 两种写法都出现（成员绑定行用冒号）
const STEP_END_RE = /Step \d+ ended/;
const MAX_LIMIT_RE = /isMaxStepLimit: true|isMaxTokenLimit: true/;      // 精确串（不用 isMax 子串）
const IDE_RESUME_RE = /onAgentStart:\s*userInput=请继续执行未完成的任务。/;   // 用户/IDE 点「继续」
const TEAMMATE_RESUME_RE = /onAgentStart:\s*userInput=<teammate-message>/;   // send_message 被消费
const MEMBER_START_RE = /startTeamMemberAgent START: memberId=([^@\s]+)@([^,\s]+), parentConversationId=([0-9a-f]{32}), conversationId=([0-9a-f]{32})/;
const TEAM_RESTORED_RE = /Team restored: ([^,]+), mainConversationId: ([0-9a-f]{32}), memberCount=(\d+)/;
const DEAD_RE = /(?:cleanupSession|removeSession) SUCCESS: conversationId=([0-9a-f]{32})|\[AcpAgent:([0-9a-f]{32})\] Agent destroyed/;

/**
 * 暂停后等待窗：窗内出现 IDE 恢复锚 ⇒ 用户已手点（红线②）。
 * ★ 2026-10-28 用户拍板 90s → **45s**：实测「暂停 → `cleanupSession`」窗口方差极大
 *   （10-27 为 145s，10-28 仅 **26s**），再叠加日志落盘滞后 25~110s ⇒ 90s 在短窗场景**必然救不回来**；
 *   45s 是在「留出人手点的避让期」与「抢在 cleanup 前注入」之间的折中。
 * 可用 `AUTORESUME_WAIT_SEC` 按场景覆盖（≥5 生效；不改红线语义，仅调时长）。
 */
const WAIT_SEC = 45;
function waitSec() {
  const v = Number(process.env.AUTORESUME_WAIT_SEC);
  return Number.isFinite(v) && v >= 5 ? v : WAIT_SEC;
}
const OBSERVE_SEC = 120;     // 注入后观察窗（工单：60~120s 内查 onAgentStart）
const ATTACH_TAIL_BYTES = 8 * 1024 * 1024;   // 首附着回读窗口（只用于**建映射**，不产信号）
const SUBJECT_TTL_SEC = 6 * 3600;            // 去重表保留时长（跨重启）
const MAX_PAUSES = 20;                       // ★2026-10-29 暂停队列上限（超出丢最旧，防状态膨胀）
/**
 * ★ 迟到锚纠正窗（2026-10-27 真实验收逼出）：IDE 日志有**写缓冲** —— 实测锚点时间戳是「注入+6s」，
 *   但脚本 4 次 tick（+13/+52/+91/+121s）都没在文件里读到它，直到 +25~110s 之后才可见 ⇒
 *   120s 观察窗按「读到时刻」算会踩空，误判 NO-RESUME（进而让 stall-watcher 发假卡、并把 failed 粘滞住）。
 *   修法：判 NO-RESUME 后**保留 lateCheck** 一段时间，期内若出现同 conv 锚点 ⇒ 改判 RESUME 并清 failedAt。
 *   为什么不清 failedAt 就够：stall-watcher 只认 `failed` 与心跳新鲜度（见 stall-watcher.js waiterState）。
 */
const LATE_ANCHOR_SEC = 600;

/**
 * ★2026-10-29 F4：暂停事件年龄上限。
 *   为什么必须加：F1 放宽 `dead` 后，`dead` 检查（:276 / 原 :457）不再兜底淘汰陈旧暂停条目
 *   ⇒ 用户已收队 / 主动关会话 / team_delete 之后，几分钟前的暂停仍会触发注入，把已关闭的成员拉起来。
 *   取值依据：会话存活实测 2.7~145s + 日志写缓冲 25~110s + 串行注入 3 目标最长 ~360s；
 *   900s 远大于上述窗口，又远小于「跨会话残留」。env `AUTORESUME_PAUSE_STALE_SEC` 覆盖须 ≥120。
 */
const PAUSE_STALE_SEC = 900;

/**
 * ★2026-10-29 D4：同一 conv 每小时注入上限（防 NO-RESUME 反复重试烧预算）。
 *   取值依据：4 步任务实测需 2 轮注入（测试卡 §6.4）× 3 倍余量 = 6；超限淘汰并落 decisions。
 */
const INJECT_RATE_LIMIT = 6;

/** 暂停过期阈值（env 覆盖须 ≥120s；<120 视为非法回落默认） */
function pauseStaleSec() {
  const v = Number(process.env.AUTORESUME_PAUSE_STALE_SEC);
  return Number.isFinite(v) && v >= 120 ? v : PAUSE_STALE_SEC;
}

// ── 路径（env 覆盖仅供自测/隔离实例；函数内求值 —— e2e 在 import 后才设 env）──
function stateFile() { return process.env.AUTORESUME_STATE_FILE || path.join(PROJ, '.codebuddy', 'temp', 'auto-resume-waiter.state.json'); }
export function heartbeatFile() { return process.env.AUTORESUME_HEARTBEAT || path.join(PROJ, '.codebuddy', 'temp', 'auto-resume-waiter.json'); }
function logRoot() {
  return process.env.AUTORESUME_LOG_ROOT || process.env.STALL_LOG_ROOT
    || path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Logs', 'CodeBuddyIDE');
}

// ── 基础工具 ────────────────────────────────────────────────
export function parseTs(line) {
  const m = String(line).match(/^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,3})\]/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
  return isNaN(t) ? null : t;
}
function blankState(now) {
  return {
  v: 2, file: '', offset: 0, lastTs: 0, startedAt: now,
    reportConv: {},     // reporter(32hex) → conv
    conv: {},           // conv → { member, team, isLead, lastAt, startAt, endAt, dead }
    pause: null,        // 最近一次暂停事件（兼容旧 state / 自测直接赋值用；权威来源见 pauses）
    pauses: [],         // ★2026-10-29 B'：暂停**队列**（并发多个触顶时逐个处理，不再后写覆盖前写）
    injected: null,     // { at, subject, conv, member, team, isLead, signalTs }
    ideResume: null,    // { ts, conv }（单槽，兼容保留）
    teammate: null,     // { ts, conv }（单槽，兼容保留）
    lateCheck: null,    // { at, conv, ... }（单槽，兼容保留）
    // ★2026-10-29 F3：三处单槽改按 conv 的 map —— 并发多目标时单槽会互相覆盖，
    //   导致「A 正在观察时 B 的锚落地 ⇒ A 判 NO-RESUME」的假失败，以及纠正窗被他人清空。
    ideResumes: {},     // conv → { ts, conv, reporter }
    teammates: {},      // conv → { ts, conv, reporter }
    lateChecks: {},     // conv → { at, conv, member, team, isLead, subject }
    subjects: {},       // subject → ts（每暂停事件只注入一次）
    lastResult: '', failedAt: 0, lastDetail: '', ticks: 0,
  };
}
function loadState() {
  let s = null;
  try { s = JSON.parse(String(fs.readFileSync(stateFile(), 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
  if (s) {
    // ★2026-10-29 迁移：旧 state 只有单槽 pause ⇒ 折进队列，避免升级后丢事件
    if (!Array.isArray(s.pauses)) s.pauses = [];
    if (!s.pauses.length && s.pause) s.pauses.push(s.pause);
    // ★2026-10-29 F3 迁移：三处单槽折进按 conv 的 map。折叠后**保留单槽**作读侧兜底
    //   （半升级态：别的进程/旧副本写回单槽时仍可用），不置 null。
    for (const pair of [['teammate', 'teammates'], ['lateCheck', 'lateChecks'], ['ideResume', 'ideResumes']]) {
      const slot = pair[0], mapKey = pair[1];
      if (!s[mapKey] || typeof s[mapKey] !== 'object') s[mapKey] = {};
      const v = s[slot];
      if (v && v.conv && !s[mapKey][v.conv]) s[mapKey][v.conv] = v;
    }
    // ★2026-10-29 v1→v2：去重键由 `conv:分钟桶` 改 `conv@pauseTs`，旧 subject 与旧队列都不再自洽
    //   ⇒ 整批作废重建（subjects 保留给 TTL 清理，其旧键自然过期）。
    if ((s.v || 1) < 2) {
      s.pauses = []; s.pause = null; s.lateChecks = {}; s.lateCheck = null; s.v = 2;
    }
    // 残缺 state 归一化 —— 否则 `--once` 对 undefined 取 keys 直接抛栈，破坏「stdout 一行 JSON」契约
    if (!Array.isArray(s.pauses)) s.pauses = [];
    if (!s.subjects || typeof s.subjects !== 'object') s.subjects = {};
    if (!s.conv || typeof s.conv !== 'object') s.conv = {};
    if (!s.reportConv || typeof s.reportConv !== 'object') s.reportConv = {};
  }
  return s;
}
/** 未处理暂停队列（pauses 优先；空则回落到单槽 pause，兼容自测直接赋值） */
function activePauses(st) {
  const q = Array.isArray(st.pauses) ? st.pauses : [];
  if (q.length) return q;
  return st.pause ? [st.pause] : [];
}
/** 从队列移除某个暂停事件，并同步单槽别名（st.pause 恒指向队尾） */
function removePause(st, pause) {
  if (Array.isArray(st.pauses)) {
    st.pauses = st.pauses.filter((p) => !(p && pause && p.conv === pause.conv && p.ts === pause.ts));
  }
  if (st.pause && pause && st.pause.conv === pause.conv && st.pause.ts === pause.ts) {
    st.pause = Array.isArray(st.pauses) && st.pauses.length ? st.pauses[st.pauses.length - 1] : null;
  }
}
function saveState(s) {
  const f = stateFile();
  const tmp = f + '.tmp';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, f);
}
function ensureConv(st, conv, init) {
  let c = st.conv[conv];
  if (!c) { c = { member: '', team: '', isLead: false, lastAt: 0, startAt: 0, endAt: 0, dead: 0 }; st.conv[conv] = c; }
  if (init) for (const k of Object.keys(init)) if (init[k]) c[k] = init[k];
  return c;
}

// ── 日志定位 / 增量读（沿用 stall-watcher 口径：mtime 最新 + 增量 offset，绝不整读）──
function resolveLog() {
  let best = null;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!/\.log$/i.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, size: st.size, mtimeMs: st.mtimeMs };
      } catch { /* 竞态跳过 */ }
    }
  };
  walk(logRoot(), 1);
  return best;
}
function readRange(file, from, to) {
  const size = Math.max(0, Math.min(to, fs.statSync(file).size));
  if (from >= size) return { lines: [], consumed: 0 };
  const len = size - from;
  const buf = Buffer.alloc(len);
  let got = 0;
  const fd = fs.openSync(file, 'r');
  try { got = fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
  const text = buf.subarray(0, got).toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { lines: [], consumed: 0 };
  return { lines: text.slice(0, lastNl).split('\n').map((s) => s.replace(/\r$/, '')), consumed: lastNl + 1 };
}

// ── 行 → 状态（hist=true 只建映射，不产信号 —— 防「附着尾部窗口把历史暂停当新事件」）──
export function ingestLine(st, line, now, hist) {
  if (!line) return;
  const head = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
  if (ECHO_RE.test(head)) return;                       // 回显行整行跳过
  const ts = parseTs(head);
  const at = ts == null ? (st.lastTs || now) : ts;      // 无时间戳续行继承上一条时间
  if (ts != null) st.lastTs = ts;

  let m = head.match(TEAM_RESTORED_RE);
  if (m) ensureConv(st, m[2], { team: m[1].trim(), member: 'team-lead', isLead: true, lastAt: at });

  m = head.match(MEMBER_START_RE);
  if (m) {
    const mc = ensureConv(st, m[4], { team: m[2], member: m[1], lastAt: at });
    // ★2026-10-29 F4：`startTeamMemberAgent` 就是「重建」锚，且重建**复用同一 conv**
    //   （测试卡 §6：ar2-t2 同 conv c8131f4a 重建）⇒ 这里是 `dead` 的**唯一复位点**。
    //   复位位置唯一性：DEAD_RE 分支只负责写 dead，不得在别处复位（防 reporter 回退映射把旧 conv 置活）。
    mc.dead = 0;
  }

  // 任一已知 conv 出现在本行 ⇒ 刷新活跃时间（团队窗/兜底归因依赖）
  for (const cv of Object.keys(st.conv)) if (head.indexOf(cv) >= 0) st.conv[cv].lastAt = at;

  m = head.match(DEAD_RE);
  if (m) {
    const cv = m[1] || m[2];
    if (cv) ensureConv(st, cv, {}).dead = at;
  }

  const r = head.match(REPORTER_RE);
  if (!r) return;
  const reporter = r[1];
  const rest = r[2];
  // ★ 实测（2026-10-27 真实日志）：**成员**会话的 `onAgentStart/onAgentEnd` 行**不带 conversationId**
  //   （只有 lead/主会话带）。成员会话的 reporter↔conv 绑定行是独立一行：
  //     `[AgentReporter] [<agentId>]  [AgentReporter] conversationId: <conv>, requestId: …, traceId: <agentId>`
  //   ⇒ ① 映射须同时认 `conversationId:` 与 `conversationId=` 两种写法；
  //      ② 本行无 conv 时用已学习的映射反解（否则锚点/暂停都归因不了）。
  const cm = rest.match(CONV_RE);
  if (cm) st.reportConv[reporter] = cm[1];               // ① reporter → conv 学习
  const conv = cm ? cm[1] : (st.reportConv[reporter] || '');
  if (conv) {
    const c = ensureConv(st, conv, {});
    c.lastAt = at;
    if (/onAgentStart:/.test(rest)) {
      c.startAt = at;
      // ★2026-10-29 F4 补：`onAgentStart` 是「会话已活」的**唯一直接证据**（注入重建走的就是这条，
      //   不一定伴随 `startTeamMemberAgent`）⇒ 复活锚晚于清理时刻即清 dead。
      //   这不违反「复位位置唯一性」：DEAD_RE 仍然只写不复位，此处是**基于活动证据**的反证。
      if (c.dead && at > c.dead) c.dead = 0;
    }
    if (/onAgentEnd:/.test(rest)) c.endAt = at;
    if (!hist) {
      // ★2026-10-29 F3：写侧**双写** —— 单槽保留（兼容旧读者/旧副本），map 供并发按 conv 取用。
      //   只改读侧不改写侧 = map 恒空 ⇒ F3 空转（交叉审查 #1 实证）。
      if (IDE_RESUME_RE.test(rest)) {
        st.ideResume = { ts: at, conv, reporter };
        if (!st.ideResumes || typeof st.ideResumes !== 'object') st.ideResumes = {};
        st.ideResumes[conv] = st.ideResume;
      }
      if (TEAMMATE_RESUME_RE.test(rest)) {
        st.teammate = { ts: at, conv, reporter };
        if (!st.teammates || typeof st.teammates !== 'object') st.teammates = {};
        st.teammates[conv] = st.teammate;
      }
    }
  }
  if (hist) return;
  if (RECORD_RE.test(head) && STEP_END_RE.test(rest) && MAX_LIMIT_RE.test(rest)) {
    // ★2026-10-29 B'：暂停事件入**队列**（原先单槽被后写覆盖 ⇒ 3 个并发触顶只记住最后 1 个）
    //   去重口径 = 同 conv + 同 reporter + 2s 内视为同一事件（同一暂停可能两种行各打一次）
    const ev = { ts: at, reporter, conv, raw: head.slice(0, 300), seenAt: now };
    if (!Array.isArray(st.pauses)) st.pauses = [];
    const dup = st.pauses.some((p) => p && p.conv === ev.conv && p.reporter === ev.reporter
      && Math.abs((p.ts || 0) - ev.ts) < 2000);
    if (!dup) {
      st.pauses.push(ev);
      if (st.pauses.length > MAX_PAUSES) st.pauses.splice(0, st.pauses.length - MAX_PAUSES);
      // 兼容别名（st.pause 恒指向最后一次**真正入队**的暂停）。
      // ★2026-10-29：别名必须在 `!dup` 内 —— 否则被判重复的事件只占别名、不入队，
      //   队列清空后 `activePauses()` 会把它当幽灵候选捞回来；旧「分钟桶」键会把它折叠成同一
      //   subject 从而被 SKIP_DEDUP 吸收，换成 `conv@pauseTs` 精确键后这层偶然保护消失
      //   ⇒ 同一次触顶会被注入两次并烧掉限速配额。
      st.pause = ev;
    }
  }
}

/** 归因：① pause.reporter → conv 精准；② 兜底 = 暂停前最后活动且未收口的本队成员 */
export function resolveTarget(st, pause) {
  const conv = (pause && pause.conv) || (pause && st.reportConv[pause.reporter]) || '';
  const mapped = conv && st.conv[conv] && st.conv[conv].member ? st.conv[conv] : null;
  if (mapped) return Object.assign({ conv }, mapped, { via: 'reporter' });
  let best = null;
  for (const cv of Object.keys(st.conv)) {
    const c = st.conv[cv];
    if (!c.member) continue;                       // 非本队会话（无成员名）⇒ 不可注入
    // ★ 兜底**不选 lead**：lead 长期处于「轮次进行中」（它在等成员），必然满足「最后活动 > 收口」
    //   ⇒ 会吞掉所有兜底归因，把「未知暂停」全注入 main（10-15 首轮「注入空闲 lead」误报同型）。
    //   lead 自身暂停只能靠 ① reporter 精准归因（该行 reporter 与 lead conv 有稳定映射）。
    if (c.isLead) continue;
    if (c.dead) continue;
    if (!c.lastAt || (pause && c.lastAt > pause.ts)) continue;
    if ((c.endAt || 0) >= (c.lastAt || 0)) continue;   // 轮次已收口 ⇒ 正常待命
    if (!best || c.lastAt > best.lastAt) best = Object.assign({ conv: cv }, c, { via: 'fallback' });
  }
  return best;
}

// ── 心跳（stall-watcher 防双通道的观测点）──
function writeHeartbeat(st, now, payload) {
  const f = heartbeatFile();
  const body = {
    v: 1, ts: now, pid: process.pid, onDuty: true, tool: 'auto-resume-waiter',
    status: (payload && payload.status) || 'IDLE',
    // ★ `failed` 的语义 = 「这件事我救不了，请 stall-watcher 发卡给用户」。
    //   2026-10-28 实测坑：只按 `failedAt`（NO-RESUME）置位时，waiter 走 GUARD（目标会话已 cleanup）
    //   或 SKIP（归因不到本队成员）**都不会**置位 ⇒ 心跳始终「在场且未失败」⇒ stall-watcher 持续抑制
    //   ⇒ 该发的卡一张都没发（真卡死无人知）。⇒ 终态失败类必须一起置位。
    failed: (!!st.failedAt && !st.injected) || ['GUARD', 'SKIP', 'ERR'].indexOf(String((payload && payload.status) || '')) >= 0,
    failedAt: st.failedAt || 0,
    target: (payload && payload.target) || null,
    signalTs: (st.pause && st.pause.ts) || 0,
    injectedAt: st.injected ? st.injected.at : 0,
    detail: (payload && payload.detail) || '',
  };
  try {
    const tmp = f + '.tmp';
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
    fs.renameSync(tmp, f);
  } catch { /* 心跳失败不致命（stall-watcher 侧表现为「不在场」⇒ 卡照发） */ }
  return body;
}

// ── 主单轮 ──────────────────────────────────────────────────
/** tick 日志（★ 2026-10-27 加：节奏/落盘滞后必须可观测 —— 之前的两次误判都是靠推的） */
function tickLog(now, out, ctx) {
  try {
    const f = process.env.AUTORESUME_TICKLOG || path.join(PROJ, '.codebuddy', 'temp', 'auto-resume-waiter.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const lag = (ctx && ctx.lastTs) ? Math.round((now - ctx.lastTs) / 1000) : '';
    const line = new Date(now).toISOString() + ' ' + String(out && out.status)
      + ' off=' + ((ctx && ctx.offset) || 0) + ' newLines=' + ((ctx && ctx.newLines) || 0)
      + ' lagSec=' + lag + ' queue=' + ((ctx && ctx.queue) || 0)
      + (out && out.quad ? ' detectLagSec=' + out.quad.detectLagSec + ' pauseTs=' + out.quad.pauseTs : '')
      + (out && out.detail ? ' :: ' + String(out.detail).slice(0, 160) : '')
      + '\n';
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) fs.writeFileSync(f, '', 'utf8');   // 2MB 自截断
    fs.appendFileSync(f, line, 'utf8');
  } catch { /* 日志失败不致命 */ }
}

/**
 * @param {number} [now] 时钟注入（自测用）
 * @returns {{status:string, [k:string]:any}}
 *   IDLE / WAIT / INJECT / OBSERVE / RESUME / NO-RESUME / SKIP / GUARD / ERR
 */
export function once(now = Date.now()) {
  const ctx = { offset: 0, newLines: 0, lastTs: 0 };
  const out = onceCore(now, ctx);
  tickLog(now, out, ctx);
  return out;
}

function onceCore(now, ctx) {
  let st = loadState() || blankState(now);
  st.ticks = (st.ticks || 0) + 1;

  const log = resolveLog();
  if (!log) {
    const hb = writeHeartbeat(st, now, { status: 'ERR', detail: 'no log under ' + logRoot() });
    return { status: 'ERR', detail: hb.detail };
  }

  // 首次附着 / 换文件：回读尾部窗口**只建映射**（历史暂停不回放），offset 落到 EOF
  if (st.file !== log.file) {
    const from = Math.max(0, log.size - ATTACH_TAIL_BYTES);
    const r0 = readRange(log.file, from, log.size);
    for (const ln of r0.lines) ingestLine(st, ln, now, true);
    st.file = log.file;
    st.offset = log.size;
    // ★2026-10-29 F4：换日志文件 ⇒ 旧暂停队列整体作废（旧实现只清单槽 pause，队列跨文件残留）。
    st.pause = null; st.injected = null; st.pauses = []; st.lateChecks = {}; st.lateCheck = null;
    saveState(st);
    const hb = writeHeartbeat(st, now, { status: 'IDLE', detail: 'attached ' + path.basename(log.file) + ' at EOF' });
    return { status: 'IDLE', detail: hb.detail, mappedConvs: Object.keys(st.conv).length };
  }

  const r = readRange(log.file, st.offset, Number.MAX_SAFE_INTEGER);
  st.offset += r.consumed;
  for (const ln of r.lines) ingestLine(st, ln, now, false);
  if (ctx) { ctx.offset = st.offset; ctx.newLines = r.lines.length; ctx.lastTs = st.lastTs || 0; ctx.queue = activePauses(st).length; }

  // 去重表过期清理
  for (const k of Object.keys(st.subjects)) if (now - st.subjects[k] > SUBJECT_TTL_SEC * 1000) delete st.subjects[k];

  // ①b 迟到锚纠正（写缓冲使得锚点可能在观察窗之后才落盘）
  //   ★2026-10-29 F3：由单槽改按 conv 的 `lateChecks` —— 并发多目标时，某个 conv 的纠正窗
  //   不得因别的 conv 事件被清空（旧实现 :477 每次新注入都 `st.lateCheck = null` ⇒ 误判固化）。
  {
    const lcs = (st.lateChecks && typeof st.lateChecks === 'object') ? st.lateChecks : {};
    // 单槽迁移：旧 state / 自测直接赋值
    if (st.lateCheck && st.lateCheck.conv && !lcs[st.lateCheck.conv]) lcs[st.lateCheck.conv] = st.lateCheck;
    st.lateCheck = null;
    st.lateChecks = lcs;
    let hitKey = null;
    for (const cv of Object.keys(lcs)) {
      const lc = lcs[cv];
      if (!lc) { delete lcs[cv]; continue; }
      const anchor = (st.teammates && st.teammates[cv]) || st.teammate;
      const hit = !!anchor && anchor.ts >= (lc.at || 0) - 3000
        && (!anchor.conv || anchor.conv === cv)
        && (now - lc.at) <= LATE_ANCHOR_SEC * 1000;
      if (hit) { hitKey = cv; break; }
      if ((now - lc.at) > LATE_ANCHOR_SEC * 1000) delete lcs[cv];   // 超期 ⇒ 放弃纠正（保持 NO-RESUME 结论）
    }
    if (hitKey) {
      const lc = lcs[hitKey];
      const anchor = (st.teammates && st.teammates[hitKey]) || st.teammate;
      st.lastResult = 'RESUME';
      st.lastDetail = 'late anchor corrected (+' + Math.round((now - lc.at) / 1000) + 's read lag) conv=' + String(hitKey).slice(0, 8) + ' lagMs=' + (anchor.ts - lc.at);
      st.failedAt = 0;                       // ★ 关键：不粘滞 failed，否则下一轮真暂停会被当「waiter 已失败」直接发卡
      delete lcs[hitKey];
      saveState(st);
      const hb = writeHeartbeat(st, now, { status: 'RESUME', detail: st.lastDetail, target: { conv: hitKey, member: lc.member, team: lc.team, isLead: lc.isLead } });
      return { status: 'RESUME', detail: st.lastDetail, conv: hitKey, member: lc.member, lagMs: anchor.ts - lc.at, late: true, heartbeat: hb };
    }
  }

  // ① 观察窗（上次注入的结果判定）—— 先收口再处理新暂停
  if (st.injected) {
    const inj = st.injected;
    // ★2026-10-29 F3：按 inj.conv 取锚（旧实现取单槽 ⇒ 观察 A 期间 B 的锚落地会把 A 判成
    //   NO-RESUME 的假失败）。conv 过滤条件原样保留（D1：禁止引入 startAt 辅判据）。
    const anchor = (st.teammates && st.teammates[inj.conv]) || st.teammate;
    const tm = !!anchor && anchor.ts >= inj.at - 3000 && (!anchor.conv || anchor.conv === inj.conv);
    if (tm) {
      st.lastResult = 'RESUME';
      st.lastDetail = 'teammate-message anchor conv=' + String(anchor.conv).slice(0, 8) + ' lagMs=' + (anchor.ts - inj.at);
      st.failedAt = 0;
      if (st.lateChecks && typeof st.lateChecks === 'object') delete st.lateChecks[inj.conv];
      st.lateCheck = null;
      st.injected = null;
      saveState(st);
      const hb = writeHeartbeat(st, now, { status: 'RESUME', detail: st.lastDetail, target: { conv: inj.conv, member: inj.member, team: inj.team, isLead: inj.isLead } });
      return { status: 'RESUME', detail: st.lastDetail, conv: inj.conv, member: inj.member, lagMs: anchor.ts - inj.at, heartbeat: hb };
    }
    const age = now - inj.at;
    if (age >= OBSERVE_SEC * 1000) {
      st.lastResult = 'NO-RESUME';
      st.lastDetail = 'no teammate-message anchor within ' + OBSERVE_SEC + 's after inject (conv=' + String(inj.conv).slice(0, 8) + ')';
      st.failedAt = now;                                     // ⇒ 心跳 failed=true ⇒ stall-watcher 补发 QQ 卡
      if (!st.lateChecks || typeof st.lateChecks !== 'object') st.lateChecks = {};
      st.lateChecks[inj.conv] = { at: inj.at, conv: inj.conv, member: inj.member, team: inj.team, isLead: !!inj.isLead, subject: inj.subject };
      st.lateCheck = null;
      st.injected = null;
      // ★2026-10-29 F2：NO-RESUME 也落账 —— 否则 decisions 的 status 值域里这一项没有写入点。
      appendDecision({ status: 'NO_RESUME', branch: 'observe', signalTs: inj.signalTs, detail: st.lastDetail, target: { conv: inj.conv, member: inj.member, team: inj.team, isLead: !!inj.isLead } }, now);
      saveState(st);
      const hb = writeHeartbeat(st, now, { status: 'NO-RESUME', detail: st.lastDetail, target: { conv: inj.conv, member: inj.member, team: inj.team, isLead: inj.isLead } });
      return { status: 'NO-RESUME', detail: st.lastDetail, conv: inj.conv, member: inj.member, heartbeat: hb };
    }
    saveState(st);
    const hb = writeHeartbeat(st, now, { status: 'OBSERVE', detail: 'observing conv=' + String(inj.conv).slice(0, 8), target: { conv: inj.conv, member: inj.member, team: inj.team, isLead: inj.isLead } });
    return { status: 'OBSERVE', remainSec: Math.max(0, Math.ceil((OBSERVE_SEC * 1000 - age) / 1000)), conv: inj.conv, member: inj.member, heartbeat: hb };
  }

  // ①c 暂停过期（★2026-10-29 F4 / F5）：`dead` 不再是陈旧条目的出口 ⇒ 必须显式过期，
  //    否则用户已收队/已关会话的旧暂停仍会触发注入把成员拉起来。
  //    年龄口径：`max(pause.ts, pause.seenAt)` —— ts 是日志事件时刻、seenAt 是首次入队时刻，
  //    取大者 ⇒ 至少等待「首次读到之后」的真实排队时长，不受写缓冲影响。
  //    ★F5（07 行动项②复评，2026-10-29）：固定阈值 + **排队预算**。
  //      实测依据：`detectLagSec` 18 样本 max=934s / avg=485s（写缓冲滞后），但计龄用 `max(ts,seenAt)`
  //      已吸收该滞后（首次读到即 seenAt=now ⇒ age≈0）⇒ 写缓冲**不是**误淘汰来源。
  //      真实残余缺口 = 串行处理：每条候选最多占用一个 `OBSERVE_SEC`(120s) 观察窗，
  //      第 N 条要等 (N-1) 个窗口 ⇒ `MAX_PAUSES`=20 时尾部等待可达 2280s ≫ 900s，
  //      会把「真实触顶但排在后面」的候选误判成陈旧而淘汰。
  //      落账证据：`auto-resume-decisions.jsonl` 18 条中 8 条 PAUSE_STALE（age 901~961s），
  //      目标全为已销毁的 `05-live-verify` 测试成员（无害），但同批若含活成员即静默误杀。
  //      取 `(queueLen - 1)`：队首零预算 ⇒ 单条场景阈值不变（S15 用例语义保持）。
  {
    const queueLen = activePauses(st).length;
    const staleSec = pauseStaleSec() + OBSERVE_SEC * Math.max(0, queueLen - 1);
    for (const p of activePauses(st).slice()) {
      const age = now - Math.max(p.ts || 0, p.seenAt || 0);
      if (age <= staleSec * 1000) continue;
      const t0 = resolveTarget(st, p);
      removePause(st, p);
      appendDecision({
        status: 'PAUSE_STALE', branch: 'stale', signalTs: p.ts,
        detail: 'pause older than ' + staleSec + 's (age=' + Math.round(age / 1000) + 's)',
        target: t0 ? { conv: t0.conv, member: t0.member, team: t0.team, isLead: !!t0.isLead } : null,
      }, now);
    }
  }

  // ② 无在途暂停 ⇒ 空闲
  const queue = activePauses(st);
  if (!queue.length) {
    saveState(st);
    writeHeartbeat(st, now, { status: 'IDLE', detail: 'no pause signal' });
    return { status: 'IDLE', mappedConvs: Object.keys(st.conv).length, lastResult: st.lastResult || '' };
  }

  // ★2026-10-29 B'：逐个候选处理 —— 先到的先试；某条不可用**只淘汰该条，不放弃整轮**。
  //   旧实现的致命点：单槽 + 判到已死目标 ⇒ 直接返回 GUARD ⇒ 同批其它还活着的候选永远没机会
  //   （2026-10-28 实测：3 个成员 32 秒内先后触顶，waiter 只看到最后一个且它已 cleanup ⇒ 0 注入）。
  // ★2026-10-29 护栏：避让期必须严格小于暂停过期阈值 —— 否则 env 把 WAIT 调到 ≥ stale 时，
  //   每个候选都会在避让期里被 PAUSE_STALE 淘汰，表现为「永远不注入」。
  const holdMs = Math.min(waitSec(), Math.floor(pauseStaleSec() / 2)) * 1000;
  let waiting = null;      // 仍在避让期（人手点「继续」的窗口）
  let lastWhy = null;      // 本轮最后一个「不可用」原因（无候选时回传）
  for (const pause of queue.slice()) {
    const target = resolveTarget(st, pause);
    const age = now - (pause.ts || now);

    // ③ 红线②：用户已手点「继续」（IDE 锚在暂停之后、同一会话或无法定位会话）⇒ 该事件作废
    //   ★2026-10-29 F3：优先读按 conv 的 `ideResumes`（`:440` 的 conv 过滤保留不变）。
    const ideAnchor = (target && st.ideResumes && st.ideResumes[target.conv]) || st.ideResume;
    // ★2026-10-29：`!target` **不再**短路成「用户已手点」—— 归因失败是 SKIP_NO_TARGET 的语义，
    //   旧写法会把「归因不到」记成「点了继续」（账本假账），并抢在 SKIP_NO_TARGET 之前吞掉事件。
    const ideHandled = !!ideAnchor && ideAnchor.ts > (pause.ts || 0)
      && (!ideAnchor.conv || (!!target && ideAnchor.conv === target.conv));
    if (ideHandled) {
      removePause(st, pause);
      lastWhy = { status: 'IDLE', detail: 'IDE resume anchor at ' + new Date(ideAnchor.ts).toTimeString().slice(0, 8) + ' ⇒ user already clicked, no inject', conv: ideAnchor.conv, target: target ? { conv: target.conv, member: target.member, team: target.team, isLead: !!target.isLead } : null };
      // ★2026-10-29 F2：淘汰分支逐条落账（纯可观测，不改判定）
      appendDecision({ status: 'IDE_HANDLED', branch: 'ide', signalTs: pause.ts, detail: lastWhy.detail, target: lastWhy.target }, now);
      continue;
    }

    if (age < holdMs) { waiting = { pause, target, age }; continue; }

    // ④ 归因失败 ⇒ 淘汰该条
    if (!target) {
      removePause(st, pause);
      lastWhy = { status: 'SKIP', detail: 'pause not attributable to own-team member (own team only)', signal: pause.raw };
      appendDecision({ status: 'SKIP_NO_TARGET', branch: 'no-target', signalTs: pause.ts, detail: lastWhy.detail, target: null }, now);
      continue;
    }

    // ⑤ ★2026-10-29 F1：`dead` 不再禁止注入 —— 实测 `removeSession` 后注入仍可重建
    //   （测试卡 §6.3：1.0s 重建；§6.4：3 并发 3/3）。改由**观察窗**判定成败，`dead` 只进记账。
    //   ★ 兜底归因的 dead 过滤（resolveTarget :276）保留不动（D8）—— 删掉会让已销毁会话
    //     因 cleanupSession 刷新 lastAt 而成为合格兜底候选。

    // ⑥ 红线③：每暂停事件只注入一次（跨重启）
    //   ★2026-10-29 D3：去重键由「conv + 分钟桶」改「conv@pauseTs」精确键 —— 分钟桶会把同一分钟内
    //   的**第二次真触顶**误判成重复；改精确键后一事件一键，跨分钟重复触发仍能被识别。
    const subject = target.conv + '@' + (pause.ts || now);
    //   ★2026-10-29 D4：同 conv 每小时注入上限（防 NO-RESUME 反复重试烧预算）。
    const hourAgo = now - 3600 * 1000;
    const recentInjects = Object.keys(st.subjects || {})
      .filter((k) => k.indexOf(target.conv + '@') === 0 && st.subjects[k] >= hourAgo).length;
    if (recentInjects >= INJECT_RATE_LIMIT) {
      removePause(st, pause);
      lastWhy = { status: 'SKIP', detail: 'conv hit inject rate limit ' + recentInjects + '/' + INJECT_RATE_LIMIT + ' per hour', member: target.member, target: { conv: target.conv, member: target.member, team: target.team, isLead: !!target.isLead } };
      appendDecision({ status: 'INJECT_RATE_LIMIT', branch: 'rate', signalTs: pause.ts, detail: lastWhy.detail, target: lastWhy.target }, now);
      continue;
    }
    if (st.subjects[subject]) {
      removePause(st, pause);
      lastWhy = { status: 'SKIP', detail: 'already injected for subject ' + subject, member: target.member, target: { conv: target.conv, member: target.member, team: target.team, isLead: !!target.isLead } };
      appendDecision({ status: 'SKIP_DEDUP', branch: 'dedup', signalTs: pause.ts, detail: lastWhy.detail, target: lastWhy.target }, now);
      continue;
    }

    // ⑦ 放行注入（动作由 waiter 成员的 send_message 执行）
    st.subjects[subject] = now;
    st.injected = { at: now, subject, conv: target.conv, member: target.member, team: target.team, isLead: !!target.isLead, signalTs: pause.ts };
    // ★2026-10-29 F3：只清**本 conv** 的纠正窗 —— 旧实现清全量，会把别的 conv 的 600s 纠正窗一起废掉。
    if (st.lateChecks && typeof st.lateChecks === 'object') delete st.lateChecks[target.conv];
    st.lateCheck = null;
    removePause(st, pause);
    st.lastResult = 'INJECT';
    st.lastDetail = 'injected to ' + (target.isLead ? 'main(lead)' : target.member) + ' via ' + target.via;
    saveState(st);
    const p = {
      status: 'INJECT', subject, text: INJECT_TEXT,
      recipient: target.isLead ? 'main' : target.member,
      target: { conv: target.conv, member: target.member, team: target.team, isLead: !!target.isLead, via: target.via },
      signalTs: pause.ts, signal: pause.raw,
      // ★2026-10-29 E：四元组埋点（触顶 / 首次读到 / 注入 / 清理），命中率从此可量测
      quad: {
        pauseTs: pause.ts, seenAt: pause.seenAt || 0, detectedTs: now, injectedTs: now,
        cleanupTs: target.dead || 0, detectLagSec: Math.round((now - (pause.ts || now)) / 1000),
        queueLeft: (Array.isArray(st.pauses) ? st.pauses.length : 0),
      },
    };
    writeHeartbeat(st, now, { status: 'INJECT', target: p.target, detail: p.recipient });
    return p;
  }

  // 队列里没有可注入的：还有在避让期的 ⇒ WAIT；否则回传最后一个原因
  if (waiting) {
    saveState(st);
    const t = waiting.target;
    const hb = writeHeartbeat(st, now, { status: 'WAIT', target: t ? { conv: t.conv, member: t.member, team: t.team, isLead: t.isLead } : null, detail: 'pause detected, holding ' + waitSec() + 's' });
    return { status: 'WAIT', remainSec: Math.max(0, Math.ceil((holdMs - waiting.age) / 1000)), target: t ? { member: t.member, conv: t.conv, via: t.via } : null, heartbeat: hb };
  }

  saveState(st);
  const why = lastWhy || { status: 'IDLE', detail: 'pause queue drained' };
  const hbStatus = why.status === 'GUARD' ? 'GUARD' : (why.status === 'SKIP' ? 'SKIP' : 'IDLE');
  // ★2026-10-29 D6：透传 `why.target` —— 旧实现恒写 null，而 :459~462 的注释要求「GUARD 必须带完整
  //   target」（stall-watcher 靠它归因到具体成员）；实测 09:54:29 的卡就因为丢 target 说不出成员名。
  writeHeartbeat(st, now, { status: hbStatus, target: why.target || null, detail: why.detail });
  return why;
}

// ── 离线自测（合成日志 + 注入时钟；不碰真实 state/心跳）──
function selftest() {
  let pass = 0; const fails = [];
  const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fails.push(name); console.log('  FAIL ' + name); } };

  const D = '2026/10/27 ';
  const rec = (hms, body) => '[' + D + hms + '.000] [Info] ' + body;
  const ms = (hms) => { const [h, m, s] = hms.split(':').map(Number); return new Date(2026, 9, 27, h, m, s).getTime(); };
  const LEAD = 'aaaaaa11111111111111111111111111';
  const M1 = 'bbbbbb22222222222222222222222222';
  const R_LEAD = 'cccccc33333333333333333333333333';
  const R_M1 = 'dddddd44444444444444444444444444';

  const TEAM = rec('10:00:00', '[TeamEventListener] Team restored: autors-team, mainConversationId: ' + LEAD + ', memberCount=2');
  const MSTART = rec('10:00:01', '[AgentSessionManager] startTeamMemberAgent START: memberId=be1@autors-team, parentConversationId=' + LEAD + ', conversationId=' + M1 + ', teamName=autors-team');
  const LEAD_START = rec('10:00:02', '[AgentReporter] [' + R_LEAD + ']  onAgentStart: userInput=开始干活 agent=craft mode=craft conversationId=' + LEAD + ' requestId=r1');
  const M1_START = rec('10:00:03', '[AgentReporter] [' + R_M1 + ']  onAgentStart: userInput=<teammate-message> agent=craft mode=craft conversationId=' + M1 + ' requestId=r2');
  const M1_PAUSE = rec('10:01:00', '[AgentReporter] [' + R_M1 + ']  [AgentReporter] Step 80 ended (messageId: x, isMaxTokenLimit: false, isMaxStepLimit: true, hasReactiveTool: false)');
  const TM_RSM = rec('10:03:00', '[AgentReporter] [' + R_M1 + ']  onAgentStart: userInput=<teammate-message> agent=craft mode=craft conversationId=' + M1 + ' requestId=r3');
  const IDE_RSM = rec('10:01:30', '[AgentReporter] [' + R_M1 + ']  onAgentStart: userInput=请继续执行未完成的任务。 agent=craft mode=craft conversationId=' + M1 + ' requestId=r4');
  const M1_DEAD = rec('10:01:20', '[AgentSessionManager] cleanupSession SUCCESS: conversationId=' + M1);
  const M1_ACT = rec('10:01:10', '[AgentReporter] [CHUNK_PERF] [SUMMARY] requestId=r9, conversationId=' + M1 + ', toolCallId=c9, toolName=execute_command');
  const LEAD_ACT = rec('10:01:05', '[AgentReporter] [CHUNK_PERF] [SUMMARY] requestId=r8, conversationId=' + LEAD + ', toolCallId=c8, toolName=execute_command');
  // ★2026-10-29：第二个成员（F3 并发按 conv 判定 / S18 交替复活用例用）
  const M2 = 'ffffaa66666666666666666666666666';
  const R_M2 = 'ffffaa77777777777777777777777777';
  const MSTART2 = rec('10:00:04', '[AgentSessionManager] startTeamMemberAgent START: memberId=be2@autors-team, parentConversationId=' + LEAD + ', conversationId=' + M2 + ', teamName=autors-team');
  const M2_START = rec('10:00:05', '[AgentReporter] [' + R_M2 + ']  onAgentStart: userInput=<teammate-message> agent=craft mode=craft conversationId=' + M2 + ' requestId=r5');
  const M2_ACT = rec('10:01:04', '[AgentReporter] [CHUNK_PERF] [SUMMARY] requestId=r10, conversationId=' + M2 + ', toolCallId=c10, toolName=execute_command');
  const M2_PAUSE = rec('10:06:00', '[AgentReporter] [' + R_M2 + ']  [AgentReporter] Step 40 ended (messageId: z, isMaxTokenLimit: false, isMaxStepLimit: true, hasReactiveTool: false)');

  /** 每个场景独立临时目录 + 独立 env（函数内求值 ⇒ import 后设置也生效） */
  function setup(histLines) {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'autors-'));
    process.env.AUTORESUME_STATE_FILE = path.join(dir, 'state.json');
    process.env.AUTORESUME_HEARTBEAT = path.join(dir, 'hb.json');
    process.env.AUTORESUME_LOG_ROOT = path.join(dir, 'logs');
    process.env.AUTORESUME_TICKLOG = path.join(dir, 'tick.log');
    process.env.AUTORESUME_DECISION_LOG = path.join(dir, 'decisions.jsonl');   // ★F2 隔离
    delete process.env.AUTORESUME_PAUSE_STALE_SEC;                             // 防跨用例串味
    fs.mkdirSync(process.env.AUTORESUME_LOG_ROOT, { recursive: true });
    const log = path.join(process.env.AUTORESUME_LOG_ROOT, 't.log');
    fs.writeFileSync(log, (histLines || []).join('\n') + '\n');
    return { dir, log };
  }
  const append = (log, lines) => fs.appendFileSync(log, lines.join('\n') + '\n');
  const hb = () => JSON.parse(fs.readFileSync(process.env.AUTORESUME_HEARTBEAT, 'utf8'));
  /** 决策账本读取（★F2：S3 起的落账断言都靠它） */
  const decs = () => {
    const f = process.env.AUTORESUME_DECISION_LOG;
    if (!f || !fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const hasDec = (status) => decs().some((d) => d && d.status === status);
  const stateNow = () => JSON.parse(fs.readFileSync(process.env.AUTORESUME_STATE_FILE, 'utf8'));

  // S1：reporter 精准归因 → INJECT → teammate 锚 ⇒ RESUME
  {
    console.log('S1 reporter attribution → INJECT → RESUME');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    const a0 = once(ms('10:00:30'));
    ok(a0.status === 'IDLE' && a0.mappedConvs >= 2, 'S1a attach at EOF, mapping built (' + JSON.stringify(a0) + ')');
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    const r1 = once(ms('10:01:20'));
    ok(r1.status === 'WAIT' && r1.target && r1.target.member === 'be1' && r1.target.via === 'reporter', 'S1b WAIT + attributed via reporter (' + JSON.stringify(r1.target) + ')');
    const r2 = once(ms('10:02:40'));
    ok(r2.status === 'INJECT' && r2.recipient === 'be1' && r2.text === INJECT_TEXT, 'S1c INJECT to member be1 (text ok)');
    append(log, [TM_RSM]);
    const r3 = once(ms('10:02:50'));
    ok(r3.status === 'RESUME' && /lagMs=20000/.test(r3.detail), 'S1d teammate anchor ⇒ RESUME (' + r3.detail + ')');
    ok(hb().failed === false && hb().status === 'RESUME', 'S1e heartbeat failed=false/status=RESUME');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S2：90s 窗内 IDE 恢复锚 ⇒ 不注入（红线②）
  {
    console.log('S2 IDE resume anchor ⇒ no inject');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    ok(once(ms('10:01:20')).status === 'WAIT', 'S2a WAIT before anchor');
    append(log, [IDE_RSM]);
    const r = once(ms('10:01:40'));
    ok(r.status === 'IDLE' && /user already clicked/.test(r.detail), 'S2b IDE anchor ⇒ IDLE, never injects');
    ok(once(ms('10:05:00')).status === 'IDLE', 'S2c stays IDLE (event dropped)');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S3：★2026-10-29 F1 语义变更 —— 目标会话已 cleanup **不再** GUARD（旧断言编码的是被有意推翻的行为），
  //    改为仍注入、由观察窗判成败；`dead` 只进记账（quad.cleanupTs）。
  {
    console.log('S3 target cleaned ⇒ still INJECT (F1)');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE, M1_DEAD]);
    const r = once(ms('10:02:40'));
    ok(r.status === 'INJECT' && r.recipient === 'be1', 'S3 cleanup before inject ⇒ still INJECT (' + r.status + ')');
    ok(r.quad && r.quad.cleanupTs > 0, 'S3b dead 只进记账：quad.cleanupTs>0（不再拦注入）');
    ok(hb().status === 'INJECT' && hb().failed === false, 'S3c 心跳仍 INJECT / failed=false（不误报失败卡）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S4：reporter 未知 ⇒ 兜底 = 暂停前最后活动且未收口的成员
  {
    console.log('S4 fallback attribution (unknown reporter)');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    const R_X = 'eeeeee55555555555555555555555555';
    const PAUSE_X = rec('10:01:00', '[AgentReporter] [' + R_X + ']  [AgentReporter] Step 3 ended (messageId: y, isMaxTokenLimit: true, isMaxStepLimit: false, hasReactiveTool: false)');
    // 兜底候选须「暂停前最后活动」⇒ 活动行时间必须早于暂停时刻
    append(log, [
      rec('10:00:50', '[AgentReporter] [CHUNK_PERF] [SUMMARY] requestId=r8, conversationId=' + LEAD + ', toolCallId=c8, toolName=execute_command'),
      rec('10:00:55', '[AgentReporter] [CHUNK_PERF] [SUMMARY] requestId=r9, conversationId=' + M1 + ', toolCallId=c9, toolName=execute_command'),
      PAUSE_X,
    ]);
    const r = once(ms('10:02:40'));
    ok(r.status === 'INJECT' && r.target && r.target.member === 'be1' && r.target.via === 'fallback', 'S4 unknown reporter ⇒ fallback to last active unclosed member (' + JSON.stringify(r.target) + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S5：同一暂停事件只注入一次（红线③，含跨重启）
  {
    console.log('S5 dedupe per pause event (across restart)');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    ok(once(ms('10:02:40')).status === 'INJECT', 'S5a first inject fires');
    // 模拟重启：清掉注入态但保留 subjects（真实重启从磁盘恢复）
    const st = JSON.parse(fs.readFileSync(process.env.AUTORESUME_STATE_FILE, 'utf8'));
    st.injected = null; st.pause = Object.assign({}, { ts: ms('10:01:00'), reporter: R_M1, conv: M1, raw: M1_PAUSE.slice(0, 120) });
    fs.writeFileSync(process.env.AUTORESUME_STATE_FILE, JSON.stringify(st), 'utf8');
    const r = once(ms('10:02:50'));
    ok(r.status === 'SKIP' && /already injected/.test(r.detail), 'S5b same event never re-injects (' + r.status + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S6：注入后无锚 ⇒ NO-RESUME + 心跳 failed=true（交 stall-watcher 补发 QQ 卡）
  {
    console.log('S6 no anchor ⇒ NO-RESUME + heartbeat failed');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    ok(once(ms('10:02:40')).status === 'INJECT', 'S6a inject fired');
    const r = once(ms('10:04:45'));
    ok(r.status === 'NO-RESUME', 'S6b no anchor within 120s ⇒ NO-RESUME');
    ok(hb().failed === true && hb().failedAt > 0, 'S6c heartbeat failed=true ⇒ stall-watcher 补发');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S7：非本队（无 member 名）不注入
  {
    console.log('S7 unknown conv (no member name) ⇒ SKIP');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    const R_Y = 'ffffff66666666666666666666666666';
    const CV_Y = '99999977777777777777777777777777';
    const PAUSE_Y = rec('10:01:00', '[AgentReporter] [' + R_Y + ']  [AgentReporter] Step 2 ended (messageId: z, isMaxTokenLimit: false, isMaxStepLimit: true, hasReactiveTool: false)');
    // 先让 reporter→conv 映射建立（该 conv 不在团队映射里），并把唯一本队成员收口（排除兜底命中）
    append(log, [
      rec('10:00:50', '[AgentReporter] [' + R_M1 + ']  onAgentEnd: agent=craft mode=craft conversationId=' + M1 + ' requestId=r7 error=false'),
      rec('10:00:51', '[AgentReporter] [' + R_Y + ']  onAgentStart: userInput=hi agent=craft conversationId=' + CV_Y),
      PAUSE_Y,
    ]);
    const r = once(ms('10:02:40'));
    ok(r.status === 'SKIP' && /own-team/.test(r.detail), 'S7 non-team conv ⇒ SKIP (' + r.status + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S8：判据负向 —— 回显行/超长行/isMax=false 都不成信号
  {
    const st = blankState(0);
    ingestLine(st, rec('10:00:00', '[Tool:bash] args={"pattern":"isMaxStepLimit: true"} 参数解析完成'), 0, false);
    ok(!st.pause, 'S8a echo line ignored');
    ingestLine(st, rec('10:00:00', '[AgentReporter] [' + R_M1 + ']  [AgentReporter] Step 2 ended (messageId: x, isMaxTokenLimit: false, isMaxStepLimit: false)'), 0, false);
    ok(!st.pause, 'S8b isMax*: false not a signal');
    ingestLine(st, '[' + D + '10:00:00.000] [Error] ' + 'x'.repeat(3000) + ' isMaxStepLimit: true', 0, false);
    ok(!st.pause, 'S8c over-long line truncated');
    ingestLine(st, M1_PAUSE, 0, false);
    ok(!!st.pause && st.pause.reporter === R_M1, 'S8d real pause line captured with reporter');
    ok(parseTs(M1_PAUSE) === ms('10:01:00'), 'S8e parseTs local time');
  }

  // S9：真实成员行形态 —— 绑定行走 `conversationId:`（冒号）+ 成员 onAgentStart 不带 conv
  {
    console.log('S9 real member shape (colon binding line, conv-less onAgentStart)');
    const { dir, log } = setup([TEAM, MSTART]);
    once(ms('10:00:30'));
    append(log, [
      rec('10:00:40', '[AgentReporter] [' + R_M1 + ']  [AgentReporter] conversationId: ' + M1 + ', requestId: 43d7ec9c0ed54fc4b926e23b72f0522b, traceId: ' + R_M1),
      rec('10:00:40', '[AgentReporter] [' + R_M1 + ']  onAgentStart: userInput=<teammate-message>'),   // ★ 无 conv（实测形态）
      M1_PAUSE,                                                                                       // ★ 暂停行也无 conv
    ]);
    const r = once(ms('10:02:40'));
    ok(r.status === 'INJECT' && r.target && r.target.member === 'be1' && r.target.via === 'reporter',
      'S9 member pause attributed via colon-binding mapping (' + JSON.stringify(r.target) + ')');
    append(log, [rec('10:03:00', '[AgentReporter] [' + R_M1 + ']  onAgentStart: userInput=<teammate-message>')]);
    const r2 = once(ms('10:03:10'));
    ok(r2.status === 'RESUME' && /conv=bbbbbb22/.test(r2.detail), 'S9b conv-less teammate anchor resolved via mapping (' + r2.detail + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S10：迟到锚纠正（★ 2026-10-27 真实验收逼出：日志写缓冲让锚点在观察窗之后才落盘）
  {
    console.log('S10 late anchor correction (log write-buffer lag)');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    ok(once(ms('10:02:40')).status === 'INJECT', 'S10a inject fired');
    const nr = once(ms('10:04:45'));
    ok(nr.status === 'NO-RESUME' && hb().failed === true, 'S10b window elapsed with no anchor ⇒ NO-RESUME + failed=true');
    // 锚点时间戳是「注入+6s」，但直到现在才被读到（模拟写缓冲）
    append(log, [TM_RSM]);
    const late = once(ms('10:05:00'));
    ok(late.status === 'RESUME' && late.late === true && /read lag/.test(late.detail), 'S10c late anchor within 600s ⇒ corrected to RESUME (' + late.status + ' / ' + (late.detail || '') + ')');
    ok(hb().failed === false && hb().status === 'RESUME', 'S10d sticky failed cleared (否则下一轮真暂停会被误判「waiter 已失败」)');
    // 超期后不再纠正
    const w2 = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(w2.log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    once(ms('10:02:40'));
    ok(once(ms('10:04:45')).status === 'NO-RESUME', 'S10e 2nd scenario NO-RESUME');
    append(w2.log, [TM_RSM]);
    const expired = once(ms('10:16:00'));       // > 600s 后
    ok(expired.status !== 'RESUME' && hb().failedAt > 0, 'S10f beyond 600s ⇒ no correction (stays NO-RESUME, failed keeps)');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(w2.dir, { recursive: true, force: true });
  }

  // S11：tick 日志（节奏/落盘滞后可观测）
  {
    console.log('S11 tick log');
    const { dir } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    once(ms('10:01:00'));
    const f = process.env.AUTORESUME_TICKLOG;
    const txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    ok(txt.split('\n').filter(Boolean).length >= 2, 'S11a 每 tick 一行（实际 ' + txt.split('\n').filter(Boolean).length + ' 行）');
    ok(/lagSec=/.test(txt) && / newLines=/.test(txt), 'S11b 行内含 lagSec/newLines（落盘滞后可量）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── S12~S19：★2026-10-29 F1~F4 新增用例（04 任务清单 T7）──

  // S12 归因失败 ⇒ SKIP_NO_TARGET 落账
  {
    console.log('S12 SKIP_NO_TARGET 落账');
    const { dir, log } = setup([TEAM]);   // 只有 lead（兜底不选 lead）⇒ 无本队成员可归因
    once(ms('10:00:30'));
    const R_X = 'eeeeee55555555555555555555555555';
    append(log, [rec('10:01:00', '[AgentReporter] [' + R_X + ']  [AgentReporter] Step 3 ended (messageId: y, isMaxTokenLimit: true, isMaxStepLimit: false, hasReactiveTool: false)')]);
    const r = once(ms('10:02:40'));
    ok(r.status === 'SKIP', 'S12a 无本队成员可归因 ⇒ SKIP (' + r.status + ')');
    ok(hasDec('SKIP_NO_TARGET'), 'S12b 落 decisions SKIP_NO_TARGET');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S13 同一暂停事件再来一次 ⇒ SKIP_DEDUP 落账（D3 精确键）
  {
    console.log('S13 SKIP_DEDUP 落账');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    ok(once(ms('10:01:20')).status === 'WAIT', 'S13a WAIT');
    ok(once(ms('10:02:40')).status === 'INJECT', 'S13b 首次注入');
    append(log, [TM_RSM]);
    ok(once(ms('10:02:50')).status === 'RESUME', 'S13c 观察窗收口');
    append(log, [M1_PAUSE]);              // 同一事件（同 conv 同 ts）再次入队
    const r = once(ms('10:03:10'));
    ok(r.status === 'SKIP' && /already injected/.test(r.detail || ''), 'S13d 同事件 ⇒ SKIP_DEDUP (' + r.status + ')');
    ok(hasDec('SKIP_DEDUP'), 'S13e 落 decisions SKIP_DEDUP');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S14 同 conv 每小时注入上限 ⇒ INJECT_RATE_LIMIT 落账（D4）
  {
    console.log('S14 INJECT_RATE_LIMIT 落账');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    const st0 = stateNow();
    st0.subjects = {};
    for (let i = 0; i < INJECT_RATE_LIMIT; i++) st0.subjects[M1 + '@' + (ms('10:01:00') + i)] = ms('10:01:00') + i;
    fs.writeFileSync(process.env.AUTORESUME_STATE_FILE, JSON.stringify(st0), 'utf8');
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    const r = once(ms('10:02:40'));
    ok(r.status === 'SKIP' && /rate limit/.test(r.detail || ''), 'S14a 已满 ' + INJECT_RATE_LIMIT + ' 次/小时 ⇒ 限速淘汰 (' + r.status + ')');
    ok(hasDec('INJECT_RATE_LIMIT'), 'S14b 落 decisions INJECT_RATE_LIMIT');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S15 陈旧暂停 ⇒ PAUSE_STALE，不注入（F4）
  {
    console.log('S15 PAUSE_STALE 不注入');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    process.env.AUTORESUME_WAIT_SEC = '1200';     // 撑住避让期，让候选停到过期
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    ok(once(ms('10:02:00')).status === 'WAIT', 'S15a 避让期内 WAIT');
    const r = once(ms('10:20:00'));                // seenAt=10:02:00 ⇒ age 1080s > 900
    ok(r.status !== 'INJECT', 'S15b 陈旧暂停不注入 (' + r.status + ')');
    ok(hasDec('PAUSE_STALE'), 'S15c 落 decisions PAUSE_STALE');
    delete process.env.AUTORESUME_WAIT_SEC;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S16 dead 后无锚 ⇒ NO-RESUME + NO_RESUME 落账（F1 + F2）
  {
    console.log('S16 dead 后无锚 ⇒ NO_RESUME 落账');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE, M1_DEAD]);
    ok(once(ms('10:02:40')).status === 'INJECT', 'S16a dead 目标仍注入');
    ok(once(ms('10:03:00')).status === 'OBSERVE', 'S16b 观察窗内 OBSERVE');
    const r = once(ms('10:05:00'));
    ok(r.status === 'NO-RESUME', 'S16c 120s 无锚 ⇒ NO-RESUME (' + r.status + ')');
    ok(hasDec('NO_RESUME'), 'S16d 落 decisions NO_RESUME（闭合 status 值域）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S17 重建锚 ⇒ dead 复位（F4）
  {
    console.log('S17 重建复位 dead');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE, M1_DEAD]);
    once(ms('10:02:40'));
    ok((stateNow().conv[M1].dead || 0) > 0, 'S17a 清理后 dead 已置位');
    append(log, [rec('10:06:00', '[AgentSessionManager] startTeamMemberAgent START: memberId=be1@autors-team, parentConversationId=' + LEAD + ', conversationId=' + M1 + ', teamName=autors-team')]);
    once(ms('10:06:10'));                          // 重建行被 ingest ⇒ dead 复位
    ok((stateNow().conv[M1].dead || 0) === 0, 'S17b 重建后 dead 复位为 0');
    append(log, [rec('10:07:00', '[AgentReporter] [' + R_M1 + ']  [AgentReporter] Step 90 ended (messageId: w, isMaxTokenLimit: false, isMaxStepLimit: true, hasReactiveTool: false)')]);
    const r = once(ms('10:08:10'));
    ok(r.status === 'INJECT', 'S17c 复位后新暂停照常注入 (' + r.status + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S18 两目标交替复活：给 B 注入不得清 A 的纠正窗（F3）
  {
    console.log('S18 纠正窗按 conv 互不清');
    const { dir, log } = setup([TEAM, MSTART, M1_START, LEAD_START, MSTART2, M2_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    once(ms('10:01:20'));
    ok(once(ms('10:02:40')).status === 'INJECT', 'S18a M1 注入');
    ok(once(ms('10:05:00')).status === 'NO-RESUME', 'S18b M1 无锚 ⇒ NO-RESUME，纠正窗建立');
    append(log, [M2_ACT, M2_PAUSE]);
    const r = once(ms('10:07:10'));
    ok(r.status === 'INJECT' && r.recipient === 'be2', 'S18c M2 照常注入 (' + r.status + ')');
    const st1 = stateNow();
    ok(!!(st1.lateChecks && st1.lateChecks[M1]), 'S18d M2 注入未清 M1 的纠正窗（旧实现会清空）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S19 IDE 已手点 ⇒ IDE_HANDLED 落账
  {
    console.log('S19 IDE_HANDLED 落账');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE]);
    ok(once(ms('10:01:20')).status === 'WAIT', 'S19a WAIT');
    append(log, [IDE_RSM]);
    ok(once(ms('10:01:40')).status === 'IDLE', 'S19b IDE 锚 ⇒ IDLE 不注入');
    ok(hasDec('IDE_HANDLED'), 'S19c 落 decisions IDE_HANDLED');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S20 队列积压时 stale 阈值含排队预算（F5 · 07 行动项②）
  //   构造要点：① 用 `AUTORESUME_WAIT_SEC=1200` 把避让期撑到 450s（holdMs 上限），使两条候选停在队列里；
  //   ② 必须有**第二次 once** 让 `seenAt` 落到 10:01:20 —— 否则 pause 在 10:17:50 才首次读到、age 归零（用例空转）。
  //   反向对照：把 `+ OBSERVE_SEC * Math.max(0, queueLen - 1)` 去掉（固定 900s），
  //   age=990s 时两条都被判 PAUSE_STALE ⇒ 本轮返回 IDLE ⇒ S20a 必红。
  {
    console.log('S20 排队预算：队列 2 条 + age 990s 不判陈旧');
    const { dir, log } = setup([TEAM, MSTART, M1_START, LEAD_START, MSTART2, M2_START]);
    process.env.AUTORESUME_WAIT_SEC = '1200';      // holdMs = min(1200, 900/2) = 450s
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE, M2_ACT, M2_PAUSE]);
    ok(once(ms('10:01:20')).status === 'WAIT', 'S20a 避让期内 WAIT（两条候选留队，seenAt=10:01:20）');
    const r = once(ms('10:17:50'));                // age = 990s：> 900 但 < 900+120（队列 2 条预算）
    ok(r.status === 'INJECT', 'S20b 队列 2 条 age 990s ⇒ 在预算内、照常注入 (' + r.status + ')');
    ok(!hasDec('PAUSE_STALE'), 'S20c 未误判 PAUSE_STALE');
    delete process.env.AUTORESUME_WAIT_SEC;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('SELFTEST ' + pass + '/' + (pass + fails.length) + (fails.length ? ' FAIL: ' + fails.join(' | ') : ' OK'));
  return fails.length ? 1 : 0;
}

// ── 回放：对真实日志空跑归因（不写 state/心跳）──
function replay(file) {
  // ★2026-10-29 F2：回放只走 ingestLine/resolveTarget（不产决策），但显式隔离决策文件 ——
  //   防未来把落账下沉到那两个函数后污染生产账本（03 §4.2 调用约束的兜底）。
  try {
    const rd = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'autors-replay-'));
    process.env.AUTORESUME_DECISION_LOG = path.join(rd, 'decisions.jsonl');
  } catch { /* 隔离失败不致命 */ }
  const st = blankState(0);
  const lines = String(fs.readFileSync(file, 'utf8')).split(/\r?\n/);
  let pauses = 0, attrib = 0;
  for (const ln of lines) {
    const before = st.pause && st.pause.raw;
    ingestLine(st, ln, 0, false);
    if (st.pause && st.pause.raw !== before) {
      pauses++;
      const t = resolveTarget(st, st.pause);
      const mapped = st.reportConv[st.pause.reporter];
      const tag = 'PAUSE ' + new Date(st.pause.ts).toTimeString().slice(0, 8)
        + ' reporter=' + String(st.pause.reporter).slice(0, 8) + ' → ' + (mapped ? 'conv' + mapped.slice(0, 8) : 'conv?');
      if (t) { attrib++; console.log(tag + ' ⇒ ' + (t.member || '?') + ' via ' + t.via); }
      else console.log(tag + ' ⇒ (unattributed)');
    }
  }
  console.log('replay summary: pauses=' + pauses + ' attributed=' + attrib + ' convs=' + Object.keys(st.conv).length + ' reporters=' + Object.keys(st.reportConv).length);
}

// ── 信号文件（★2026-10-29 A'：常驻检测 ─→ 阻塞等待者）────────────────────────
//   为什么必须这样分工：注入动作只能由**同队成员**的 send_message 执行，而「谁去盯」不能再是
//   一个每 75s 跑一次的 team 成员 —— 2026-10-28 实测它自己 max_turns=8 就触顶死掉（观察者成了被救对象）。
//   ⇒ 常驻进程（qqbot 服务内 tick 10~15s）只负责检测 + 写信号；
//     waiter 成员只跑一条**阻塞等待**命令（一次工具调用覆盖最长 300s ⇒ 8 步预算够覆盖 40 分钟）。
export function signalFile() {
  return process.env.AUTORESUME_SIGNAL || path.join(PROJ, '.codebuddy', 'temp', 'auto-resume-signal.json');
}
function signalCursorFile() { return signalFile().replace(/\.json$/, '') + '.cursor.json'; }
export function signalRead() {
  try {
    const j = JSON.parse(String(fs.readFileSync(signalFile(), 'utf8')).replace(/^\uFEFF/, ''));
    if (!Array.isArray(j.signals)) j.signals = [];
    return j;
  } catch { return { v: 1, seq: 0, signals: [] }; }
}
/** 把一次 INJECT 判定落成信号（同 subject 且未消费 ⇒ 不重复追加，防「两次 tick 双写」） */
export function appendSignal(payload, now = Date.now()) {
  const s = signalRead();
  if (payload && payload.subject && s.signals.some((x) => x && x.subject === payload.subject)) return s.seq || 0;
  s.v = 1;
  s.seq = (s.seq || 0) + 1;
  s.signals.push(Object.assign({ id: s.seq, ts: now }, payload));
  if (s.signals.length > 50) s.signals.splice(0, s.signals.length - 50);
  const f = signalFile();
  const tmp = f + '.tmp';
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    fs.renameSync(tmp, f);
  } catch { /* 写失败不致命：下一 tick 会重试 */ }
  return s.seq;
}
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = Date.now() + ms; while (Date.now() < t) { /* 兜底忙等 */ } }
}
/** 阻塞等待未消费信号（waiter 成员唯一动作）：命中 ⇒ 打印 JSON、退出 0；超时 ⇒ 退出 9 */
export function waitSignal(timeoutSec = 300) {
  let cursor = 0;
  try { cursor = JSON.parse(String(fs.readFileSync(signalCursorFile(), 'utf8'))).seq || 0; } catch { /* 首次运行 */ }
  const deadline = Date.now() + Math.max(5, timeoutSec) * 1000;
  while (Date.now() < deadline) {
    const s = signalRead();
    const next = s.signals.find((x) => x && (x.id || 0) > cursor);
    if (next) {
      try { fs.writeFileSync(signalCursorFile(), JSON.stringify({ seq: next.id, ts: Date.now() }), 'utf8'); } catch { /* 游标失败不致命 */ }
      console.log(JSON.stringify(next));
      return 0;
    }
    sleepSync(700);
  }
  console.log(JSON.stringify({ status: 'TIMEOUT', waitSec: timeoutSec }));
  return 9;
}

// ── 决策账本（★2026-10-29 F2：淘汰候选可观测）──────────────────────────────
//   为什么不复用 signals[]：① signals 的消费方 `waitSignal()` 只按 `id > cursor` 取第一条，
//   淘汰条目混进去会被当「可注入信号」读走（对已淘汰目标发 send_message）；
//   ② `appendSignal()` 按 subject 去重 ⇒ 同 bucket 已有 INJECT 条目时淘汰条目被静默吞掉；
//   ③ signals 只保留 50 条，淘汰噪音会把 INJECT/quad 账本挤掉。
//   ⇒ 物理隔离成独立文件，**JSONL 追加**（3 个调用源：服务 tick / --once / --daemon，
//     整文件 read-modify-write 会 lost update）。
export function decisionFile() {
  return process.env.AUTORESUME_DECISION_LOG
    || path.join(PROJ, '.codebuddy', 'temp', 'auto-resume-decisions.jsonl');
}
/**
 * 落一条决策账。★ 调用约束：**只允许在 onceCore 内调用** —— 禁止下沉到 ingestLine / resolveTarget，
 * 那两个函数是 `--replay-file` 的回放路径（blankState(0) + 无隔离），下沉会把 ts:0 脏条目写进生产账本。
 */
let decisionSeq = 0;
export function appendDecision(payload, now = Date.now()) {
  // id 用「时刻-序号」：同一 tick 内 stale 循环可连发 N 条，纯 ts 会重号；自测伪造时钟时还可能回退。
  const rec = Object.assign({ id: now + '-' + (++decisionSeq), ts: now }, payload);
  try {
    const f = decisionFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) {
      // 轮转而非原地清空：两个追加写者（服务 tick / --daemon）并存时，清空会丢对方刚写的记录。
      try { fs.renameSync(f, f + '.1'); } catch { fs.writeFileSync(f, '', 'utf8'); }
    }
    fs.appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 落账失败不致命：禁影响判定 */ }
  return rec.id;
}
/** 常驻检测循环（独立进程模式；服务内已走 import().once() + 信号写入） */
async function daemonLoop(intervalMs) {
  console.log('[AUTORESUME] daemon start interval=' + Math.round(intervalMs / 1000) + 's');
  for (;;) {
    try {
      const out = once();
      if (out && out.status === 'INJECT') {
        const id = appendSignal(out);
        console.log('[AUTORESUME] signal #' + id + ' → ' + out.recipient);
      }
    } catch (e) { console.log('[AUTORESUME ERR] ' + (e && e.message)); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
function numArg(args, name, dflt) {
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

// ── main（被 import 时不执行 —— 自测/隔离实例依赖）──
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) process.exit(selftest());
  else if (args[0] === '--replay-file' && args[1]) replay(args[1]);
  else if (args.includes('--status')) {
    const st = loadState();
    let hb = null;
    try { hb = JSON.parse(fs.readFileSync(heartbeatFile(), 'utf8')); } catch { /* 无心跳 */ }
    console.log(JSON.stringify({ state: st ? { file: path.basename(st.file || ''), convs: Object.keys(st.conv).length, reporters: Object.keys(st.reportConv).length, lastResult: st.lastResult, lastDetail: st.lastDetail, subjects: Object.keys(st.subjects || {}).length, pauses: (st.pauses || []).length } : null, heartbeat: hb }, null, 2));
  } else if (args.includes('--daemon')) {
    daemonLoop(Math.max(5000, numArg(args, '--interval-sec', 15) * 1000));
  } else if (args.includes('--wait-signal')) {
    process.exit(waitSignal(numArg(args, '--timeout', 300)));
  } else if (args.includes('--once')) {
    const out = once();
    if (out && out.status === 'INJECT') out.signalId = appendSignal(out);
    console.log(JSON.stringify(out));
  } else {
    console.log('usage: node auto-resume-waiter.mjs --once | --daemon [--interval-sec 15] | --wait-signal [--timeout 300] | --selftest | --status | --replay-file <log>');
    process.exit(2);
  }
}
