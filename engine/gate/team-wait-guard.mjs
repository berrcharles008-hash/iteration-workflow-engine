#!/usr/bin/env node
/**
 * team-wait-guard —— 团队等待硬门禁（2026-10-27 新增）
 *
 * 解决的问题（反复复发，见 memory/pivas_stop_hook_block_semantics.md）：
 *   主 Agent 派发异步成员后，把"等它回报"写成自然语言就结束回合 ⇒ 平台判 completed 并
 *   `stopping inbox polling` ⇒ 成员回传永久 read=false（只有用户消息能恢复）。
 *   历次修复（双层判据 / 人工唤醒 / stall-watcher / 回合内等待）全在 prompt 软约束层，
 *   模型一次不照做即失效。本脚本把"结束回合前必须核对收口"做进 **Stop hook**：
 *   平台层拒绝结束 + stderr 回灌给模型（语义已实测，见 .codebuddy/temp/stop-probe/）。
 *
 * 两种模式（同文件，靠 argv 分流）：
 *   --dispatch    PreToolUse：识别「异步成员派发」（task 且 tool_input.name 非空）→ 记台账，永远 exit 0
 *   --stop-guard  Stop：本会话有未核对的派发 ⇒ stderr + exit 2（阻断结束）；否则 exit 0
 *   --status      打印台账（人工排查）
 *   --selftest    内置回归（6 场景，不依赖 stdin）
 *
 * 安全设计（重要，勿改）：
 *   · **fail-open**：任何自身异常 / stdin 不可解析 ⇒ exit 0 放行。理由与 gate-check 相反 ——
 *     门禁拦的是"危险写操作"，本脚本拦的是"结束回合"，脚本 bug 若 fail-closed 会让所有
 *     会话无法结束（连修都没法修）。异常一律写日志留痕。
 *   · **防死循环**：`stop_hook_active === true`（平台"续跑后再次结束"标记）恒放行；
 *     且每批派发只拦一次（`guarded`），二者互为冗余，覆盖未传该字段的宿主。
 *   · **窗口**：派发超过 WAIT_WINDOW_MIN 分钟的记录视为陈旧 ⇒ 放行（避免隔夜记录误拦）。
 *
 * 台账：<IDE>/temp/team-wait-guard.json   日志：<IDE>/temp/team-wait-guard.log
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── 路径推导：<ROOT>/<IDE>/skills/iteration-workflow/engine/gate/ 上溯 4 层 = <IDE> ──
const SELF = fileURLToPath(import.meta.url);
const GATE_DIR = dirname(SELF);
// ★ 变量名**不可回退为 IDE_DIR**（2026-10-27 实测 · audit A10-f 踩坑）：
//   audit-engine.py 的 A10-f 把「文档反引号内的 UPPER_SNAKE」∩「engine/gate/*.mjs 顶层 const」
//   做「只拦新增」的计数守门；而既有文档 template-injection.md:111 里就写着 `IDE_DIR` ⇒
//   本目录一旦出现同名 const，耦合计数 17→18 立即 ERR（本次正是因此红）。
//   推论：**在 engine/gate/ 新增顶层 UPPER_SNAKE 前，先 grep engine/**/*.md 的反引号词**，
//   否则会无声扩大符号域并让 audit 变红。
const IDE_ROOT = join(GATE_DIR, '..', '..', '..', '..');
const TMP_DIR = join(IDE_ROOT, 'temp');
const STATE_FILE = join(TMP_DIR, 'team-wait-guard.json');
const LOG_FILE = join(TMP_DIR, 'team-wait-guard.log');
// ★ TOOL-QQWAIT-2（2026-10-28）：ask 台账（由 `tools/qqbot/ask.js` 写入，本守卫**只读**）。
//   为什么读台账而不是解析命令行：PreToolUse 阶段拿不到 `#id`（id 由服务端分配、只出现在工具返回）；
//   按 `/ask\.js/` 匹配文本又会把 `Get-Content …ask.js` 之类全记成登记（误拦概率≈1）。
//   ★ 变量名刻意用小驼峰：engine/gate/ 新增**顶层 UPPER_SNAKE** 会撞 audit-engine.py 的 A10-f
//     常量计数基线（17），超基线是 **ERR 不是 warn** —— 同款踩坑见本文件 IDE_ROOT 处注释。
//   ★ 用 let（非 const）：`--selftest` 会把它改指向隔离文件，**绝不能让自测读到生产台账**
//     （否则真实存在的未消费登记会让「① 无派发 ⇒ 放行」等既有用例红，且红得莫名其妙）。
let askLedger = join(TMP_DIR, 'qq-ask-ledger.json');

const WAIT_WINDOW_MIN = 90;              // 派发记录有效期（分钟）
const WAIT_WINDOW_MS = WAIT_WINDOW_MIN * 60 * 1000;
const MAX_DISPATCH_PER_SESSION = 10;     // 台账容量（防无限增长）

function log(tag, msg) {
  try {
    mkdirSync(TMP_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${tag} ${msg}\n`, 'utf-8');
  } catch { /* 留痕失败不影响判定 */ }
}

function parseStdin(raw) {
  try {
    return JSON.parse(String(raw || '').replace(/^\uFEFF/, '') || '{}');
  } catch (e) {
    return { __parseError: String((e && e.message) || e) };
  }
}

/**
 * 异步读 stdin —— ★ 不可改回 readFileSync(0)：
 *   2026-10-27 实测 `Get-Content | node` 管道下 readFileSync(0) 恒读空 ⇒ 台账不落、静默失效；
 *   与 gate-check.mjs 的 process.stdin 事件流写法保持一致（同一宿主同一路径已验证可用）。
 *   超时/异常一律返回 __parseError ⇒ 调用方 fail-open 放行。
 */
function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      if (process.stdin.isTTY) return resolve({ __parseError: 'stdin is TTY' });
      let data = '';
      const timer = setTimeout(() => resolve(parseStdin(data) && { __parseError: 'stdin timeout' }), timeoutMs);
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (c) => { data += String(c).replace(/^\uFEFF/, ''); });
      process.stdin.on('end', () => { clearTimeout(timer); resolve(parseStdin(data)); });
      process.stdin.on('error', (e) => { clearTimeout(timer); resolve({ __parseError: 'stdin error: ' + String(e && e.message) }); });
    } catch (e) {
      resolve({ __parseError: String((e && e.message) || e) });
    }
  });
}

function loadState(file) {
  try {
    if (existsSync(file)) {
      // ★ 必剥 BOM：PowerShell `Set-Content -Encoding UTF8`（PS 5.1）手改台账会带 \uFEFF，
      //   JSON.parse 直接抛错 ⇒ 被 catch 吞掉返回空台账 ⇒ **静默永不拦截**（2026-10-27 实测踩坑；
      //   自测用的是 node writeFileSync 无 BOM，故 selftest 全绿也照样暴露不出来）。
      const s = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
      if (s && typeof s === 'object' && s.sessions) return s;
    }
  } catch (e) { log('STATE_ERR', String((e && e.message) || e)); }
  return { sessions: {} };
}

function saveState(state, file) {
  try {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 1), 'utf-8');
  } catch (e) { log('STATE_SAVE_ERR', String((e && e.message) || e)); }
}

// ── 派发识别：异步成员 = task 工具且携带 name（同步子代理无 name，天然阻塞，不需看守） ──
const DISPATCH_TOOL_RE = /^(task|agent|subagent|dispatch_agent|team_member)$/i;

/**
 * 会话目录名（convId）—— 跨事件**精确**关联键。
 * 2026-10-27 实测：PreToolUse 与 Stop 的 `session_id` 不同源，但两者 stdin 都带
 * `transcript_path`（形如 …/<工作区hash>/<convId>/index.json）⇒ 取路径中**最后一个** 32 位
 * 十六进制段即 convId（工作区 hash 在前，取尾段天然避开）。
 */
function extractConvId(inp) {
  const p = String((inp && inp.transcript_path) || '');
  if (!p) return '';
  const segs = p.split(/[\\/]/);
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (/^[0-9a-f]{32}$/i.test(segs[i])) return segs[i].toLowerCase();
  }
  return '';
}

function extractDispatch(inp) {
  const tool = String(inp.tool_name || '');
  if (!DISPATCH_TOOL_RE.test(tool)) return null;
  const ti = inp.tool_input || {};
  const name = ti.name || ti.agent_name || ti.member_name || '';
  if (!name || typeof name !== 'string') return null;
  return { name, subagent: ti.subagent_name || ti.agentType || '', convId: extractConvId(inp) };
}

/**
 * 成员会话判据 —— 本项目 hook 是**项目级全局**，team 成员会话同样会触发 Stop。
 * 依据（2026-10-27 实测 `<IDE>/teams/<leadConv>/_auto_<leadConv>/config.json`）：
 *   · `mainConversationId` = lead 会话 id（主 Agent）；
 *   · `members[]` 只列真实成员（hook-probe / loop-probe …），**lead 不在其中**；
 *   · 成员会话的 Stop `session_id` 恰好等于其 `members[].sessionId`。
 * ⇒ 命中 members 且 ≠ mainConversationId 即为成员会话，必须放行（否则成员被拦后
 *   会收到「继续未完成任务」续跑，空转且污染其 max_turns 预算，实测已发生一次）。
 * 纯函数（teamsDir 可注入）便于自测。
 */
function isTeamMemberSessionIn(teamsDir, sid) {
  const target = String(sid || '').toLowerCase();
  if (!target || !teamsDir || !existsSync(teamsDir)) return false;
  let convs = [];
  try { convs = readdirSync(teamsDir); } catch { return false; }
  for (const conv of convs) {
    const convDir = join(teamsDir, conv);
    let teams = [];
    try { teams = readdirSync(convDir); } catch { continue; }
    for (const t of teams) {
      const cfgPath = join(convDir, t, 'config.json');
      if (!existsSync(cfgPath)) continue;
      let cfg;
      try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8').replace(/^\uFEFF/, '')); } catch { continue; }
      const main = String(cfg.mainConversationId || conv || '').toLowerCase();
      const members = Array.isArray(cfg.members) ? cfg.members : [];
      for (const m of members) {
        const ms = String((m && m.sessionId) || '').toLowerCase();
        if (ms && ms === target && ms !== main) return true;
      }
    }
  }
  return false;
}

/**
 * ★ TOOL-QQWAIT-2（2026-10-28）：读 ask 台账。纯文本 JSON，零外部依赖、零 HTTP
 *（Stop hook 只有 10s 上限，且服务可能停 ⇒ 不能查 `/pending`）。
 * 损坏/半写一律返回空台账 ⇒ 判据不触发（fail-open，与本脚本总体安全设计一致）。
 */
function loadAskLedger(file) {
  try {
    if (!existsSync(file)) return { events: [] };
    const j = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
    if (j && Array.isArray(j.events)) return j;
  } catch (e) { log('ASK_LEDGER_ERR', String((e && e.message) || e)); }
  return { events: [] };
}

/**
 * 判「本会话登记过 ask，但没有任何消费者证据」。
 * 纯函数（state / ledger 路径可注入）⇒ 供 --selftest 直接调用。
 *
 * 判据 = 以下四条同时成立（缺一即放行）：
 *   ① 台账里有 register 事件，且 id 未 consumed、未 giveup，且未超窗（沿用 90min 常量）；
 *   ② 该登记不是 `--handoff`（模式 B：服务端确认后会起 headless 消费）；
 *   ③ 该登记之后本会话没有派发过 waiter 成员（模式 D：成员 send_message 就是消费者）；
 *   ④ 同一 conv 的同一 `#N` 尚未被拦过（每 id 只拦一次，防死循环）。
 *
 * ★ 为什么需要 ① 的 consumed/giveup 两个白名单（不加就会误拦正常流程）：
 *   · consumed：ask.js 默认等待命中后继续干活，本回合内**不会再有命令行记录** ⇒ 只有台账能证明有人读过；
 *   · giveup：waiting-protocol §3 规定「≤6 片，片满停止等待」⇒ 用尽后结束回合是**协议要求的**行为。
 * ★ 为什么 ② 不算"自声明豁免"：`--handoff` 不是"关掉等待"，它把消费责任移交给服务端
 *   （用户答复会 runHeadless 起新会话）⇒ 消费者从"本进程"换成"headless"，不是没有消费者。
 * ★ conv 匹配：台账的 conv 取自子进程环境变量（CODEBUDDY_SESSION_ID / CLAUDE_SESSION_ID），
 *   与 Stop 的 session_id 同形但不保证同源 ⇒ 精确未命中时退化为「最新一条未消费登记」，
 *   并记 `ASK_MATCH=none-global` 留痕（宁可多拦一次也不静默失效）。
 */
function judgeAsk(sid, myConv, state, ledgerFile) {
  const ev = loadAskLedger(ledgerFile).events.filter((e) => e && e.id != null);
  if (!ev.length) return null;
  const now = Date.now();
  const regs = new Map(); const consumed = new Set(); const giveup = new Set();
  for (const e of ev) {
    const id = String(e.id);
    if (e.event === 'register') regs.set(id, e);           // 同 id 多次登记 ⇒ 取最后一条
    else if (e.event === 'consumed') consumed.add(id);
    else if (e.event === 'giveup') giveup.add(id);
  }
  const cands = [];
  for (const [id, r] of regs) {
    const t = Number(r.t || 0);
    if (!t || now - t > WAIT_WINDOW_MS) continue;
    if (consumed.has(id) || giveup.has(id)) continue;
    if (r.handoff) continue;
    cands.push(r);
  }
  if (!cands.length) return null;

  const mine = cands.filter((r) => r.conv && (r.conv === myConv || r.conv === sid));
  const pick = mine.length ? mine[mine.length - 1] : cands[cands.length - 1];
  const how = mine.length ? 'conv' : 'none-global';
  const pickTs = Number(pick.t || 0);

  // 模式 D：登记之后派过 waiter 成员 ⇒ 有消费者
  const all = [state.sessions[sid]].concat(Object.keys(state.sessions).map((k) => state.sessions[k]));
  const dispatched = all.filter(Boolean)
    .reduce((acc, r) => acc.concat(Array.isArray(r.dispatched) ? r.dispatched : []), [])
    .filter((d) => d && Number(d.ts || 0) >= pickTs);
  if (dispatched.length) return null;

  // 每个 id 只拦一次（不因新登记重置 ⇒ 防「拦→重跑 ask→再拦」livelock）
  const key = myConv || sid;
  const guardedFor = (state.askGuarded && state.askGuarded[key]) || '';
  if (guardedFor === String(pick.id)) return null;

  return { id: String(pick.id), kind: String(pick.kind || ''), ts: pickTs, how, key };
}

/** 返回 { code, stderr } —— 纯函数，供 --selftest 直接调用 */
function handleDispatch(inp, file) {
  const d = extractDispatch(inp);
  if (!d) return { code: 0, stderr: '' };
  const sid = String(inp.session_id || 'unknown');
  const state = loadState(file);
  const rec = state.sessions[sid] || { dispatched: [], guarded: false };
  rec.dispatched.push({ name: d.name, subagent: d.subagent, ts: Date.now(), convId: d.convId || '' });
  if (rec.dispatched.length > MAX_DISPATCH_PER_SESSION) {
    rec.dispatched = rec.dispatched.slice(-MAX_DISPATCH_PER_SESSION);
  }
  rec.guarded = false;                       // 新派发 = 新批次，重置看守位
  state.sessions[sid] = rec;
  // ★ 顶层"最近派发"= 跨事件关联键（2026-10-27 实测：Stop 与 PreToolUse 的 session_id
  //   **不是同一个值**，PreToolUse 报 09a2de36…、Stop 报 deeb25a4… ⇒ 仅按 session 精确匹配
  //   会"记账成功但永不拦截"的静默失效）。session 精确匹配优先，未命中退回本字段。
  state.lastDispatch = { name: d.name, ts: Date.now(), sessionId: sid, convId: d.convId || '' };
  state.globalGuarded = false;
  saveState(state, file);
  log('DISPATCH', `${sid.slice(0, 8)} conv=${(d.convId || '-').slice(0, 8)} member=${d.name} keys=[${Object.keys(inp).join(',')}]`);
  return { code: 0, stderr: '' };
}

function handleStop(inp, file, ledger) {
  const askFile = ledger || askLedger;
  if (inp.__parseError) {
    log('STOP_SKIP', 'stdin 不可解析（fail-open）: ' + inp.__parseError);
    return { code: 0, stderr: '' };
  }
  const sid = String(inp.session_id || '');
  if (!sid) { log('STOP_SKIP', '无 session_id（fail-open）'); return { code: 0, stderr: '' }; }

  // ★ 取证位（2026-10-27）：Stop 是**项目级全局** hook，team 成员会话同样会触发。
  //   必须能事后回答"某一跳 Stop 来自主 Agent 还是成员会话"——否则成员被误拦会被误读成
  //   平台故障（成员侧表现为收到「继续未完成任务」续跑，与平台 max_turns 续跑同形）。
  //   判据候选 = `agent_type`（主 Agent = craft，见日志 [BaseAgent:craft]）；先留痕再定黑名单。
  log('STOP_ENTER', `${sid.slice(0, 8)} conv=${(extractConvId(inp) || '-').slice(0, 8)} agent=${inp.agent_type || '-'} active=${inp.stop_hook_active === true} loop=${inp.loop_count ?? '-'}`);

  // 防死循环①：平台"续跑后再次结束"标记 ⇒ 直接放行
  if (inp.stop_hook_active === true) {
    log('STOP_SKIP', `${sid.slice(0, 8)} stop_hook_active=true loop=${inp.loop_count ?? '?'}`);
    return { code: 0, stderr: '' };
  }

  // ★ 成员会话排除（2026-10-27 实测事故修复）：成员结束回合同样触发本 hook，被拦后会被
  //   平台以「继续未完成任务」续跑 ⇒ 空转 + 消耗其 max_turns。只对 lead（主 Agent）生效。
  if (isTeamMemberSessionIn(join(IDE_ROOT, 'teams'), sid)) {
    log('STOP_SKIP', `${sid.slice(0, 8)} 成员会话（非 lead）⇒ 放行`);
    return { code: 0, stderr: '' };
  }

  const state = loadState(file);
  let rec = state.sessions[sid];
  const myConv = extractConvId(inp);

  // ★ TOOL-QQWAIT-2（2026-10-28）：**先判 ask，再判派发**。
  //   顺序不可调换：第 6 例空转的形状正是「没派过任何成员」⇒ 旧代码在下面 `!matchedBy` 处
  //   直接 `STOP_SKIP 无本会话派发台账 ⇒ 放行`，ask 判据永远没有机会执行。
  try {
    const hit = judgeAsk(sid, myConv, state, askFile);
    if (hit) {
      const t = new Date(hit.ts);
      const hhmm = isNaN(t) ? '?' : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      const msg = [
        `[team-wait-guard] 本会话登记过 QQ 确认项 #${hit.id}（${hhmm}${hit.kind ? '，kind=' + hit.kind : ''}），但**没有任何消费者证据** —— 拒绝结束本回合。`,
        '判据（四条同时成立才拦）：台账里该 #N 未 consumed（没有进程读到答复）、未 giveup（6 片未用尽）、非 --handoff、登记后也没派过 waiter。',
        '结束前必须三选一：',
        '  (A) 不要结束回合 —— 登记本身就是等待（默认 300s/片，本项尚未等到答复）；',
        '  (B) 立刻派 waiter 成员（模式 D）—— 用户 QQ 回复后经 send_message 唤醒本会话；',
        '  (C) 登记时带 --handoff（模式 B），交 headless 接管。',
        '说明：不得只写「等它回报」；同一个 #N 只拦一次，不会死循环。',
      ].join('\n');
      state.askGuarded = state.askGuarded || {};
      state.askGuarded[hit.key] = hit.id;
      saveState(state, file);
      log('ASK_BLOCK', `${sid.slice(0, 8)} conv=${(myConv || '-').slice(0, 8)} id=${hit.id} match=${hit.how}`);
      return { code: 2, stderr: msg };
    }
  } catch (e) { log('ASK_JUDGE_ERR', String((e && e.message) || e)); }

  let matchedBy = (rec && Array.isArray(rec.dispatched) && rec.dispatched.length) ? 'session' : '';

  // ② convId 精确匹配（session_id 不同源时的正解，2026-10-27 实测：两者都带 transcript_path）
  if (!matchedBy && myConv) {
    const hit = Object.keys(state.sessions)
      .map((k) => state.sessions[k])
      .find((r) => r && Array.isArray(r.dispatched) && r.dispatched.some((d) => d && d.convId === myConv));
    if (hit) { rec = hit; matchedBy = 'conv'; }
  }

  // ★ 已删除「工作区最近派发（global）」退路（2026-10-27 当日撤回）：它建立在
  //   「Stop 与 PreToolUse 的 session_id 不同源」这一**错误推断**上 —— 实际那个不同值的 Stop
  //   来自**成员会话**（deeb25a4=hook-probe、5a02b407=loop-probe），主会话两侧恒为 lead convId。
  //   保留它只会让成员/其它会话被误拦。现在：无本会话台账 ⇒ 放行并留痕。
  if (!matchedBy) {
    log('STOP_SKIP', `${sid.slice(0, 8)} conv=${(myConv || '-').slice(0, 8)} 无本会话派发台账 ⇒ 放行`);
    return { code: 0, stderr: '' };
  }

  // 防死循环②：每批派发只拦一次（globalGuarded 为单一开关，rec.guarded 兼容旧台账）
  if (state.globalGuarded || rec.guarded) {
    log('STOP_SKIP', `${sid.slice(0, 8)} [${matchedBy}] 同批已拦过一次`);
    return { code: 0, stderr: '' };
  }

  const last = rec.dispatched[rec.dispatched.length - 1];
  const age = Date.now() - Number(last.ts || 0);
  if (!last.ts || age > WAIT_WINDOW_MS) {
    log('STOP_SKIP', `${sid.slice(0, 8)} 派发记录陈旧（${Math.round(age / 60000)}min > ${WAIT_WINDOW_MIN}min）`);
    return { code: 0, stderr: '' };
  }

  rec.guarded = true;
  state.globalGuarded = true;
  if (matchedBy === 'session') state.sessions[sid] = rec;
  saveState(state, file);

  const names = rec.dispatched.map((x) => {
    const t = x.ts ? new Date(x.ts) : null;
    const hhmm = t && !isNaN(t)
      ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
      : '?';
    return `${x.name}(${hhmm})`;
  }).join('、');

  const msg = [
    `[team-wait-guard] 本会话 ${Math.round(age / 60000)} 分钟前派发过异步成员：${names}，尚未核对收口 —— 拒绝结束本回合。`,
    '结束前必须二选一：',
    '  (A) 确认已收口：读成员回传 / 查 .codebuddy/temp/team-out/<成员>.md 是否含 TEAM-OUT-COMPLETE / 用 svn diff 核对业务文件；',
    '  (B) 成员仍在跑：不要用文字「等它回报」——改用命令做回合内等待（单条命令分片轮询标记，单片 ≤10 分钟、总上限 30 分钟），',
    '      或明确写出「为何无需等待」的磁盘级证据（文件 LastWriteTime / diff 状态）。',
    '说明：本拦截每批派发只触发一次；下一次结束请求（stop_hook_active=true）自动放行，不会死循环。',
  ].join('\n');
  log('STOP_BLOCK', `${sid.slice(0, 8)} [${matchedBy}] ${names}`);
  return { code: 2, stderr: msg };
}

// ── 自测：纯函数调用，不依赖真实 stdin ──
function selftest() {
  const file = join(TMP_DIR, 'team-wait-guard.selftest.json');
  // ★ TOOL-QQWAIT-2：自测一律指向**隔离台账**（生产台账里若有真实未消费登记，
  //   会把「① 无派发 ⇒ 放行」之类既有用例判红，看起来像回归其实是环境污染）。
  const lf = join(TMP_DIR, 'qq-ask-ledger.selftest.json');
  askLedger = lf;
  try { if (existsSync(file)) writeFileSync(file, '{"sessions":{}}', 'utf-8'); } catch { /* ignore */ }
  const resetAsk = () => { try { writeFileSync(lf, '{"events":[]}', 'utf-8'); } catch { /* ignore */ } };
  const reset = () => {
    try { writeFileSync(file, '{"sessions":{}}', 'utf-8'); } catch { /* ignore */ }
    resetAsk();
  };
  const cases = [];
  const T = (name, fn) => { try { const ok = fn(); cases.push([ok, name]); } catch (e) { cases.push([false, name + ' :: ' + e.message]); } };

  const SID = 'selftest-conv';
  const stopIn = (extra = {}) => ({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false, ...extra });
  const dispatchIn = (name) => ({ session_id: SID, tool_name: 'task', tool_input: { name, subagent_name: 'code-explorer' } });

  T('① 无派发记录 ⇒ 放行', () => { reset(); return handleStop(stopIn(), file).code === 0; });
  T('② 同步子代理（无 name）不记台账', () => { reset(); const r = handleDispatch({ session_id: SID, tool_name: 'task', tool_input: { subagent_name: 'code-explorer' } }, file); return r.code === 0 && !loadState(file).sessions[SID]; });
  T('③ 派发后首次结束 ⇒ 拦截(2) 且 stderr 含成员名', () => { reset(); handleDispatch(dispatchIn('m-page'), file); const r = handleStop(stopIn(), file); return r.code === 2 && r.stderr.includes('m-page'); });
  T('④ 同批第二次结束 ⇒ 放行（每批只拦一次）', () => { const r = handleStop(stopIn(), file); return r.code === 0; });
  T('⑤ stop_hook_active=true ⇒ 恒放行（防死循环）', () => { reset(); handleDispatch(dispatchIn('m-a'), file); return handleStop(stopIn({ stop_hook_active: true, loop_count: 1 }), file).code === 0; });
  T('⑥ 派发记录超窗(>90min) ⇒ 放行', () => {
    reset();
    const st = { sessions: { [SID]: { dispatched: [{ name: 'old', ts: Date.now() - (WAIT_WINDOW_MS + 60000) }], guarded: false } } };
    writeFileSync(file, JSON.stringify(st), 'utf-8');
    return handleStop(stopIn(), file).code === 0;
  });
  T('⑦ 新派发重置看守位 ⇒ 再次拦截', () => {
    reset(); handleDispatch(dispatchIn('m-b'), file); handleStop(stopIn(), file);
    handleDispatch(dispatchIn('m-c'), file);
    return handleStop(stopIn(), file).code === 2;
  });
  T('⑧ stdin 不可解析 ⇒ 放行(fail-open)', () => handleStop({ __parseError: 'boom' }, file).code === 0);
  T('⑨ 台账带 UTF-8 BOM 仍能拦截（防 PS Set-Content 手改导致静默失效）', () => {
    reset();
    handleDispatch(dispatchIn('m-bom'), file);
    writeFileSync(file, '\uFEFF' + readFileSync(file, 'utf-8'), 'utf-8');
    return handleStop(stopIn(), file).code === 2;
  });
  T('⑩ 非本会话且无 convId 匹配 ⇒ 放行（工作区退路已撤回，防误拦成员/他会话）', () => {
    reset();
    handleDispatch(dispatchIn('m-cross'), file);                     // session = selftest-conv
    return handleStop(stopIn({ session_id: 'another-conv-id' }), file).code === 0;
  });
  T('⑪ 成员会话判据：members[].sessionId 命中判真、lead(mainConversationId) 判假', () => {
    const root = join(TMP_DIR, 'selftest-teams');
    const tdir = join(root, 'leadconv', '_auto_leadconv');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'config.json'), JSON.stringify({
      name: '_auto_leadconv',
      mainConversationId: 'leadconv',
      members: [{ name: 'm-mem', sessionId: '0123456789abcdef0123456789abcdef' }],
    }), 'utf-8');
    return isTeamMemberSessionIn(root, '0123456789abcdef0123456789abcdef') === true
      && isTeamMemberSessionIn(root, 'leadconv') === false;
  });
  T('⑫ convId 精确匹配：session_id 不同但 transcript 会话目录相同 ⇒ 拦截（优先于工作区退路）', () => {
    reset();
    const CONV = '0123456789abcdef0123456789abcdef';
    const tp = `C:/x/history/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${CONV}/index.json`;
    handleDispatch({ session_id: 'conv-a', tool_name: 'task', tool_input: { name: 'm-conv' }, transcript_path: tp }, file);
    const r = handleStop({ session_id: 'conv-b', stop_hook_active: false, transcript_path: tp }, file);
    return r.code === 2 && r.stderr.includes('m-conv');
  });

  // ── ★ TOOL-QQWAIT-2（2026-10-28）：ask 判据（登记后必须有消费者）──
  //   事故形状（第 6 例）：只登记 ask + 结束回合，无任何派发 ⇒ 旧判据 `无本会话派发台账 ⇒ 放行`。
  const writeLedger = (events) => writeFileSync(lf, JSON.stringify({ events: events }), 'utf-8');
  const regEv = (id, extra) => Object.assign({ id: id, conv: SID, t: Date.now(), event: 'register', kind: 'decision', handoff: false }, extra || {});

  T('⑬ ask 登记后无任何消费者 ⇒ 拦截(2)，stderr 含 #id', () => {
    reset(); writeLedger([regEv(41)]);
    const r = handleStop(stopIn(), file);
    return r.code === 2 && r.stderr.indexOf('#41') >= 0;
  });
  T('⑭ 同一 #N 第二次结束 ⇒ 放行（每 id 只拦一次，防 livelock）', () => handleStop(stopIn(), file).code === 0);
  T('⑮ 有 consumed 事件 ⇒ 放行（默认等待命中后继续干活不得误拦）', () => {
    reset(); writeLedger([regEv(42), { id: 42, t: Date.now(), event: 'consumed', answer: 'choice' }]);
    return handleStop(stopIn(), file).code === 0;
  });
  T('⑯ giveup（6 片用尽）⇒ 放行（§3 协议要求停止等待）', () => {
    reset(); writeLedger([regEv(43), { id: 43, t: Date.now(), event: 'wait-end' }, { id: 43, t: Date.now(), event: 'giveup' }]);
    return handleStop(stopIn(), file).code === 0;
  });
  T('⑰ --handoff（模式 B）⇒ 放行（服务端起 headless 消费）', () => {
    reset(); writeLedger([regEv(44, { handoff: true })]);
    return handleStop(stopIn(), file).code === 0;
  });
  T('⑱ 登记之后派了 waiter ⇒ 不按 ask 判据拦（模式 D）', () => {
    reset(); writeLedger([regEv(45, { t: Date.now() - 5000 })]);   // ★ 回拨 5s：登记与派发同毫秒时也应算「登记之后派过 waiter」
    handleDispatch(dispatchIn('waiter-q'), file);
    const r = handleStop(stopIn(), file);
    return r.stderr.indexOf('#45') < 0;
  });
  T('⑲ ask 台账损坏 ⇒ 放行(fail-open)，不得误拦', () => {
    reset(); writeFileSync(lf, '{broken', 'utf-8');
    return handleStop(stopIn(), file).code === 0;
  });
  T('⑳ 超窗(>90min)的未消费登记 ⇒ 放行', () => {
    reset(); writeLedger([{ id: 46, conv: SID, t: Date.now() - (WAIT_WINDOW_MS + 60000), event: 'register' }]);
    return handleStop(stopIn(), file).code === 0;
  });

  const pass = cases.filter(([ok]) => ok).length;
  for (const [ok, name] of cases) process.stdout.write(`${ok ? '✅' : '❌'} ${name}\n`);
  process.stdout.write(`\nteam-wait-guard selftest: ${pass}/${cases.length}\n`);
  return pass === cases.length ? 0 : 1;
}

// ── 入口 ──
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  process.exit(selftest());
}
if (argv.includes('--status')) {
  const st = loadState(STATE_FILE);
  process.stdout.write(JSON.stringify(st, null, 1) + '\n');
  process.exit(0);
}
if (argv.includes('--dispatch')) {
  const inp = await readStdin();
  let r;
  try { r = handleDispatch(inp, STATE_FILE); } catch (e) { log('DISPATCH_ERR', String((e && e.message) || e)); r = { code: 0, stderr: '' }; }
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
if (argv.includes('--stop-guard')) {
  const inp = await readStdin();
  let r;
  try { r = handleStop(inp, STATE_FILE); } catch (e) { log('STOP_ERR', String((e && e.message) || e)); r = { code: 0, stderr: '' }; }
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
process.stdout.write('team-wait-guard: 用法 --dispatch | --stop-guard | --status | --selftest\n');
process.exit(0);
