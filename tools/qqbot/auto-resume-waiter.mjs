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
/**
 * ★ 迟到锚纠正窗（2026-10-27 真实验收逼出）：IDE 日志有**写缓冲** —— 实测锚点时间戳是「注入+6s」，
 *   但脚本 4 次 tick（+13/+52/+91/+121s）都没在文件里读到它，直到 +25~110s 之后才可见 ⇒
 *   120s 观察窗按「读到时刻」算会踩空，误判 NO-RESUME（进而让 stall-watcher 发假卡、并把 failed 粘滞住）。
 *   修法：判 NO-RESUME 后**保留 lateCheck** 一段时间，期内若出现同 conv 锚点 ⇒ 改判 RESUME 并清 failedAt。
 *   为什么不清 failedAt 就够：stall-watcher 只认 `failed` 与心跳新鲜度（见 stall-watcher.js waiterState）。
 */
const LATE_ANCHOR_SEC = 600;

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
    v: 1, file: '', offset: 0, lastTs: 0, startedAt: now,
    reportConv: {},     // reporter(32hex) → conv
    conv: {},           // conv → { member, team, isLead, lastAt, startAt, endAt, dead }
    pause: null,        // { ts, reporter, conv, raw }
    injected: null,     // { at, subject, conv, member, team, isLead, signalTs }
    ideResume: null,    // { ts, conv }
    teammate: null,     // { ts, conv }
    lateCheck: null,    // { at, conv, member, team, isLead } —— NO-RESUME 后的迟到锚纠正窗口
    subjects: {},       // subject → ts（每暂停事件只注入一次）
    lastResult: '', failedAt: 0, lastDetail: '', ticks: 0,
  };
}
function loadState() {
  try { return JSON.parse(String(fs.readFileSync(stateFile(), 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
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
  if (m) ensureConv(st, m[4], { team: m[2], member: m[1], lastAt: at });

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
    if (/onAgentStart:/.test(rest)) c.startAt = at;
    if (/onAgentEnd:/.test(rest)) c.endAt = at;
    if (!hist) {
      if (IDE_RESUME_RE.test(rest)) st.ideResume = { ts: at, conv, reporter };
      if (TEAMMATE_RESUME_RE.test(rest)) st.teammate = { ts: at, conv, reporter };
    }
  }
  if (hist) return;
  if (RECORD_RE.test(head) && STEP_END_RE.test(rest) && MAX_LIMIT_RE.test(rest)) {
    st.pause = { ts: at, reporter, conv, raw: head.slice(0, 300) };
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
      + ' lagSec=' + lag + (out && out.detail ? ' :: ' + String(out.detail).slice(0, 160) : '')
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
    st.pause = null; st.injected = null;
    saveState(st);
    const hb = writeHeartbeat(st, now, { status: 'IDLE', detail: 'attached ' + path.basename(log.file) + ' at EOF' });
    return { status: 'IDLE', detail: hb.detail, mappedConvs: Object.keys(st.conv).length };
  }

  const r = readRange(log.file, st.offset, Number.MAX_SAFE_INTEGER);
  st.offset += r.consumed;
  for (const ln of r.lines) ingestLine(st, ln, now, false);
  if (ctx) { ctx.offset = st.offset; ctx.newLines = r.lines.length; ctx.lastTs = st.lastTs || 0; }

  // 去重表过期清理
  for (const k of Object.keys(st.subjects)) if (now - st.subjects[k] > SUBJECT_TTL_SEC * 1000) delete st.subjects[k];

  // ①b 迟到锚纠正（写缓冲使得锚点可能在观察窗之后才落盘）
  if (st.lateCheck) {
    const lc = st.lateCheck;
    const anchor = st.teammate;
    const hit = !!anchor && anchor.ts >= (lc.at || 0) - 3000
      && (!anchor.conv || anchor.conv === lc.conv)
      && (now - lc.at) <= LATE_ANCHOR_SEC * 1000;
    if (hit) {
      st.lastResult = 'RESUME';
      st.lastDetail = 'late anchor corrected (+' + Math.round((now - lc.at) / 1000) + 's read lag) conv=' + String(lc.conv).slice(0, 8) + ' lagMs=' + (anchor.ts - lc.at);
      st.failedAt = 0;                       // ★ 关键：不粘滞 failed，否则下一轮真暂停会被当「waiter 已失败」直接发卡
      st.lateCheck = null;
      saveState(st);
      const hb = writeHeartbeat(st, now, { status: 'RESUME', detail: st.lastDetail, target: { conv: lc.conv, member: lc.member, team: lc.team, isLead: lc.isLead } });
      return { status: 'RESUME', detail: st.lastDetail, conv: lc.conv, member: lc.member, lagMs: anchor.ts - lc.at, late: true, heartbeat: hb };
    }
    if ((now - lc.at) > LATE_ANCHOR_SEC * 1000) st.lateCheck = null;   // 超期 ⇒ 放弃纠正（保持 NO-RESUME 结论）
  }

  // ① 观察窗（上次注入的结果判定）—— 先收口再处理新暂停
  if (st.injected) {
    const inj = st.injected;
    const anchor = st.teammate;   // ★ 取对象本体（不可把布尔表达式当选言值用：tm.conv 会变 undefined）
    const tm = !!anchor && anchor.ts >= inj.at - 3000 && (!anchor.conv || anchor.conv === inj.conv);
    if (tm) {
      st.lastResult = 'RESUME';
      st.lastDetail = 'teammate-message anchor conv=' + String(anchor.conv).slice(0, 8) + ' lagMs=' + (anchor.ts - inj.at);
      st.failedAt = 0; st.lateCheck = null;
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
      st.lateCheck = { at: inj.at, conv: inj.conv, member: inj.member, team: inj.team, isLead: !!inj.isLead, subject: inj.subject };
      st.injected = null;
      saveState(st);
      const hb = writeHeartbeat(st, now, { status: 'NO-RESUME', detail: st.lastDetail, target: { conv: inj.conv, member: inj.member, team: inj.team, isLead: inj.isLead } });
      return { status: 'NO-RESUME', detail: st.lastDetail, conv: inj.conv, member: inj.member, heartbeat: hb };
    }
    saveState(st);
    const hb = writeHeartbeat(st, now, { status: 'OBSERVE', detail: 'observing conv=' + String(inj.conv).slice(0, 8), target: { conv: inj.conv, member: inj.member, team: inj.team, isLead: inj.isLead } });
    return { status: 'OBSERVE', remainSec: Math.max(0, Math.ceil((OBSERVE_SEC * 1000 - age) / 1000)), conv: inj.conv, member: inj.member, heartbeat: hb };
  }

  // ② 无在途暂停 ⇒ 空闲
  if (!st.pause) {
    saveState(st);
    writeHeartbeat(st, now, { status: 'IDLE', detail: 'no pause signal' });
    return { status: 'IDLE', mappedConvs: Object.keys(st.conv).length, lastResult: st.lastResult || '' };
  }

  const pause = st.pause;
  const target = resolveTarget(st, pause);
  const age = now - (pause.ts || now);

  // ③ 红线②：用户已手点「继续」（IDE 锚在暂停之后、同一会话或无法定位会话）—— 窗内即刻收口，不必等满 90s
  const ideHandled = !!st.ideResume && st.ideResume.ts > (pause.ts || 0)
    && (!target || !st.ideResume.conv || st.ideResume.conv === target.conv);
  if (ideHandled) {
    st.pause = null;
    saveState(st);
    writeHeartbeat(st, now, { status: 'IDLE', detail: 'IDE resume anchor ⇒ user already clicked continue' });
    return { status: 'IDLE', detail: 'IDE resume anchor at ' + new Date(st.ideResume.ts).toTimeString().slice(0, 8) + ' ⇒ user already clicked, no inject', conv: st.ideResume.conv };
  }

  const holdMs = waitSec() * 1000;
  if (age < holdMs) {
    saveState(st);
    const hb = writeHeartbeat(st, now, { status: 'WAIT', target: target ? { conv: target.conv, member: target.member, team: target.team, isLead: target.isLead } : null, detail: 'pause detected, holding ' + waitSec() + 's' });
    return { status: 'WAIT', remainSec: Math.max(0, Math.ceil((holdMs - age) / 1000)), target: target ? { member: target.member, conv: target.conv, via: target.via } : null, heartbeat: hb };
  }

  // ④ 归因失败
  if (!target) {
    st.pause = null;
    saveState(st);
    writeHeartbeat(st, now, { status: 'SKIP', detail: 'cannot attribute pause to a team member' });
    return { status: 'SKIP', detail: 'pause not attributable to own-team member (own team only)', signal: pause.raw };
  }

  // ⑤ 红线①：目标会话已销毁 ⇒ 注入无效（已反向实证）
  if (target.dead) {
    st.pause = null;
    saveState(st);
    writeHeartbeat(st, now, { status: 'GUARD', target: { conv: target.conv, member: target.member, team: target.team, isLead: target.isLead }, detail: 'target session destroyed/cleaned before inject' });
    return { status: 'GUARD', detail: 'target conv ' + String(target.conv).slice(0, 8) + ' destroyed/cleaned at ' + new Date(target.dead).toTimeString().slice(0, 8) + ' ⇒ inject forbidden', member: target.member };
  }

  // ⑥ 红线③：每暂停事件只注入一次（跨重启）
  const subject = target.conv + ':' + Math.floor((pause.ts || now) / 60000);
  if (st.subjects[subject]) {
    st.pause = null;
    saveState(st);
    writeHeartbeat(st, now, { status: 'SKIP', target: { conv: target.conv, member: target.member, team: target.team, isLead: target.isLead }, detail: 'already injected for this event' });
    return { status: 'SKIP', detail: 'already injected for subject ' + subject, member: target.member };
  }

  // ⑦ 放行注入（动作由 waiter 成员的 send_message 执行）
  st.subjects[subject] = now;
  st.injected = { at: now, subject, conv: target.conv, member: target.member, team: target.team, isLead: !!target.isLead, signalTs: pause.ts };
  st.lateCheck = null;                       // 新事件开始 ⇒ 上一轮的纠正窗口作废
  st.pause = null;
  st.lastResult = 'INJECT';
  st.lastDetail = 'injected to ' + (target.isLead ? 'main(lead)' : target.member) + ' via ' + target.via;
  saveState(st);
  const p = {
    status: 'INJECT', subject, text: INJECT_TEXT,
    recipient: target.isLead ? 'main' : target.member,
    target: { conv: target.conv, member: target.member, team: target.team, isLead: !!target.isLead, via: target.via },
    signalTs: pause.ts, signal: pause.raw,
  };
  writeHeartbeat(st, now, { status: 'INJECT', target: p.target, detail: p.recipient });
  return p;
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

  /** 每个场景独立临时目录 + 独立 env（函数内求值 ⇒ import 后设置也生效） */
  function setup(histLines) {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'autors-'));
    process.env.AUTORESUME_STATE_FILE = path.join(dir, 'state.json');
    process.env.AUTORESUME_HEARTBEAT = path.join(dir, 'hb.json');
    process.env.AUTORESUME_LOG_ROOT = path.join(dir, 'logs');
    process.env.AUTORESUME_TICKLOG = path.join(dir, 'tick.log');
    fs.mkdirSync(process.env.AUTORESUME_LOG_ROOT, { recursive: true });
    const log = path.join(process.env.AUTORESUME_LOG_ROOT, 't.log');
    fs.writeFileSync(log, (histLines || []).join('\n') + '\n');
    return { dir, log };
  }
  const append = (log, lines) => fs.appendFileSync(log, lines.join('\n') + '\n');
  const hb = () => JSON.parse(fs.readFileSync(process.env.AUTORESUME_HEARTBEAT, 'utf8'));

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

  // S3：目标会话已 cleanup ⇒ GUARD（红线①）
  {
    console.log('S3 target cleaned ⇒ GUARD');
    const { dir, log } = setup([TEAM, MSTART, LEAD_START, M1_START]);
    once(ms('10:00:30'));
    append(log, [LEAD_ACT, M1_ACT, M1_PAUSE, M1_DEAD]);
    const r = once(ms('10:02:40'));
    ok(r.status === 'GUARD' && /inject forbidden/.test(r.detail), 'S3 cleanup before inject ⇒ GUARD (' + r.status + ')');
    ok(hb().status === 'GUARD' && hb().failed === true, 'S3b heartbeat status=GUARD 且 failed=true（否则 watcher 会一直抑制 ⇒ 该发的卡发不出）');
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

  console.log('SELFTEST ' + pass + '/' + (pass + fails.length) + (fails.length ? ' FAIL: ' + fails.join(' | ') : ' OK'));
  return fails.length ? 1 : 0;
}

// ── 回放：对真实日志空跑归因（不写 state/心跳）──
function replay(file) {
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
    console.log(JSON.stringify({ state: st ? { file: path.basename(st.file || ''), convs: Object.keys(st.conv).length, reporters: Object.keys(st.reportConv).length, lastResult: st.lastResult, lastDetail: st.lastDetail, subjects: Object.keys(st.subjects || {}).length } : null, heartbeat: hb }, null, 2));
  } else if (args.includes('--once')) {
    console.log(JSON.stringify(once()));
  } else {
    console.log('usage: node auto-resume-waiter.mjs --once | --selftest | --status | --replay-file <log>');
    process.exit(2);
  }
}
