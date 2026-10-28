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

function handleStop(inp, file) {
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
  try { if (existsSync(file)) writeFileSync(file, '{"sessions":{}}', 'utf-8'); } catch { /* ignore */ }
  const reset = () => { try { writeFileSync(file, '{"sessions":{}}', 'utf-8'); } catch { /* ignore */ } };
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
