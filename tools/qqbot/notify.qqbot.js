#!/usr/bin/env node
// notify.qqbot.js —— 通过 QQ 机器人发送「任务完成」等通知（Node 版，供 hooks / 命令行调用）
//
// 用法：
//   node notify.qqbot.js "自定义消息"
//   echo '{"transcript_path":"..."}' | node notify.qqbot.js   # hook(Stop)模式下读 stdin，自动判断本轮是否有实质产出
//   node notify.qqbot.js --json '{"title":"…","status":"…","rows":[["键","值"]],"next":"…"}'   # 结构化纯文本（msg_type:0）
//
// 凭据读取优先级：环境变量 QQ_BOT_APPID/SECRET/OPENID > 同目录 qqbot.creds.json（{"appId":"...","secret":"...","openId":"..."}）
// 发送使用 UTF-8（字节数组 + charset=utf-8），中文无乱码。
const fs = require('fs');
const https = require('https');
const path = require('path');

function loadCreds() {
  if (process.env.QQ_BOT_APPID && process.env.QQ_BOT_SECRET && process.env.QQ_BOT_OPENID) {
    return { appId: process.env.QQ_BOT_APPID, secret: process.env.QQ_BOT_SECRET, openId: process.env.QQ_BOT_OPENID };
  }
  try {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'qqbot.creds.json'), 'utf8'));
    if (f.appId && f.secret && f.openId) return f;
  } catch (e) {}
  return null;
}
// ★ FIX-17：凭据缺失不再立即退出 —— 合并服务可用时经其 /notify 统一出口代发（无需本进程凭据），
//          仅在「服务不可用 → 回退直发」时才要求本地凭据。
const creds = loadCreds() || {};
const appId = creds.appId;
const secret = creds.secret;
const openId = creds.openId;
const hasCreds = !!(appId && secret && openId);

function postJson(host, p, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: host, path: p, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, raw: d })); });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function getToken() {
  const r = await postJson('bots.qq.com', '/app/getAppAccessToken', { appId, clientSecret: secret });
  const j = JSON.parse(r.raw); if (!j.access_token) throw new Error('token 失败 ' + r.raw); return j.access_token;
}
async function send(content, token) {
  return (await postJson('api.sgroup.qq.com', '/v2/users/' + openId + '/messages',
    { content, msg_type: 0 }, { Authorization: 'QQBot ' + token, 'X-UnionAppid': appId })).status;
}

// ★ FIX-17：统一发送出口 —— 先请求合并服务的 /notify（复用其长连接 token），
// 服务不可用（未启动 / 端口不通 / 非 200）时返回 ok:false，由调用方回退直发。
function tryViaService(content, extra) {
  const http = require('http');
  return new Promise((resolve) => {
    let port = 18765;
    try { port = JSON.parse(fs.readFileSync(path.join(__dirname, 'daemon.config.json'), 'utf8')).listenPort || 18765; } catch (e) {}
    // ★ FIX-20：把 kind/session/fallback 透传服务端（合并队列 · 免打扰 · 兜底去重都由服务侧执行）
    const body = JSON.stringify(Object.assign({ content }, extra || {}));
    const req = http.request({
      host: '127.0.0.1', port, path: '/notify', method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, raw: 'HTTP ' + res.statusCode + ' ' + String(d).slice(0, 120) }));
    });
    req.setTimeout(4000, () => req.destroy(new Error('service timeout')));
    req.on('error', (e) => resolve({ ok: false, raw: e.message }));
    req.write(body); req.end();
  });
}

// ── 结构化纯文本渲染（★ 2026-09-17）────────────────────────────────────
// 背景：C2C 端点 api.sgroup.qq.com/v2/users/... 的 markdown 支持不确定 ⇒ 保持 msg_type:0 纯文本，
//       用「标题 + 分隔线 + 键值行 + 下一步」的版式提升可读性。
// 入参形状：{ title?, status?, rows?: [[键, 值], …], next? }
// 对齐：以「字符数」近似显示宽度（中文/全角空格均占 1 字符 ≈ 1 全角宽），CJK 场景下可对齐。
// ★ FIX-37c：分割线统一口径（20 字符）—— 与 qqbot-service.js 的 MSG_SEP 同值
//   （此前本文件为 14 字符，与「🔔 待确认」类消息不一致；用户 2026-09-21 实测指出）
const MSG_SEP = '─'.repeat(20);
function renderStructured(s) {
  const L = [];
  if (s && s.title) L.push('【' + s.title + '】');
  if (s && s.status) L.push(String(s.status));
  if (s && Array.isArray(s.rows) && s.rows.length) {
    L.push(MSG_SEP);
    const w = Math.max(...s.rows.map(r => [...String((r && r[0]) || '')].length));
    for (const r of s.rows) {
      const k = String((r && r[0]) || ''), v = String((r && r[1]) || '');
      L.push((k + '：').padEnd(w + 1, '　') + v);
    }
  }
  if (s && s.next) { L.push(MSG_SEP); L.push('➡️ 下一步：' + s.next); }
  return L.join('\n');
}

// ── FIX-20（2026-09-18）：推送策略口径 ──────────────────────────────────────
//   done = 任务结束（主信号，agent 显式声明）｜fail = 失败/异常（需决策）｜
//   progress = 长任务心跳｜decision = 需你拍板（**必须带 --id #N**，否则拒绝发送）
//   中间环节静默；全局静默开关对本出口同样生效（FIX-19 时它只管门禁拦截，完成通知照发）。
const PROJ = path.resolve(__dirname, '..', '..');
const KIND_LABEL = { done: '完成', fail: '失败', progress: '进度', decision: '需你确认' };
const DONE_DEDUPE_MS = 10 * 60 * 1000;   // 同会话「完成类」最小间隔（防 Stop 兜底与显式 done 双发 / 防刷屏）

/** 静默原因（null = 正常发送）：env QQ_NOTIFY=0|off，或 hooks/.qq-notify-off 标记 */
/**
 * 静默原因（null = 正常发送）。
 * ★ FIX-23（2026-09-18）：标记文件支持 TTL —— 内容可写 `ttlMinutes=60` 或 `expire=2026-09-18T23:00`
 *   （起点 = 文件 mtime）。过期 ⇒ 视为**未静默**（防"开完忘记删"永久静默）。
 */
function markerExpired(fp) {
  try {
    const txt = fs.readFileSync(fp, 'utf8') || '';
    const mMin = txt.match(/ttlMinutes\s*=\s*(\d+)/i);
    const mExp = txt.match(/expire\s*=\s*([0-9T:\-\s]+)/i);
    const start = fs.statSync(fp).mtimeMs;
    if (mExp) {
      const t = Date.parse(mExp[1].trim());
      if (!isNaN(t)) return Date.now() > t;
    }
    if (mMin) return Date.now() - start > Number(mMin[1]) * 60000;
    return false;   // 空标记 = 永久（沿用旧语义）
  } catch (e) { return false; }
}
function mutedReason() {
  if (process.env.QQ_NOTIFY === '0' || process.env.QQ_NOTIFY === 'off') return 'env';
  for (const rel of ['.codebuddy/hooks/.qq-notify-off', '.claude/hooks/.qq-notify-off']) {
    try {
      const fp = path.join(PROJ, rel);
      if (fs.existsSync(fp) && !markerExpired(fp)) return 'marker';
    } catch (e) {}
  }
  return null;
}
function stateFile() { return path.join(PROJ, '.codebuddy/temp/qqbot-notify-state.json'); }
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return {}; } }
function saveState(st) {
  try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(st), 'utf8'); } catch (e) {}
}
/** 完成类去重：显式 done 写 `done:<s>`；Stop 兜底（--fallback）只读两者 + 写 `fallback:<s>` */
function doneDedupe(session, isFallback) {
  const st = loadState(); const now = Date.now(); const s = session || 'unknown';
  const lastDone = st['done:' + s] || 0, lastFb = st['fallback:' + s] || 0;
  if (isFallback) {
    if (now - lastDone < DONE_DEDUPE_MS || now - lastFb < DONE_DEDUPE_MS) return true;
    st['fallback:' + s] = now;
  } else st['done:' + s] = now;
  saveState(st); return false;
}

// 判断本轮是否有实质产出（工具调用），避免纯闲聊也推送。
// hook(Stop) 模式下 CodeBuddy 通过 stdin 传入 JSON（含 transcript_path / session_id）。
let HOOK_INPUT = null;
function readHookInput() {
  if (HOOK_INPUT !== null) return HOOK_INPUT;
  HOOK_INPUT = false;
  try {
    if (process.stdin.isTTY) return HOOK_INPUT;
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return HOOK_INPUT;
    HOOK_INPUT = JSON.parse(raw) || false;
  } catch (e) {}
  return HOOK_INPUT;
}
/** 会话键：session_id > transcript 所在目录名（供完成类去重） */
function sessionKey() {
  const inp = readHookInput();
  if (inp && inp.session_id) return String(inp.session_id);
  if (inp && inp.transcript_path) return path.basename(path.dirname(String(inp.transcript_path)));
  return '';
}
// ═══ FIX-22（2026-09-18）：「具体事项」取证与推断 ═══════════════════════════
// 实测 transcript 结构（2026-09-18，本工作区）：
//   ① 工具调用是**独立行**：{"type":"function_call","name":"Edit","arguments":"{\"file_path\":…}"}
//   ② assistant 消息只有 output_text，**不含** tool_use ⇒ 旧判定 `o.type==='assistant'` + /tool_use/
//      全部失效（这正是「纯问答/闲聊不推送」一直没生效的根因，一并修掉）。
const TOOL_CALL_TYPE = 'function_call';

function parseToolArgs(a) {
  if (!a) return {};
  if (typeof a === 'object') return a;
  try { const v = JSON.parse(a); return (v && typeof v === 'object') ? v : {}; } catch (e) { return {}; }
}

/** 目标路径/命令 → 项目相对形式（便于一眼看出改的是哪个文件） */
function targetOfCall(args) {
  const raw = args.file_path || args.filePath || args.target_file || args.path || args.command || args.pattern || '';
  if (!raw) return '';
  const s = String(raw).replace(/\\/g, '/');
  const pn = PROJ.replace(/\\/g, '/');
  const i = s.indexOf(pn);
  return i >= 0 ? s.slice(i + pn.length + 1) : s;
}

/** Edit/Write 的**首个不同行** ⇒ `width:120px → width:90px`（细到「值」的粒度；完全相同则返回空） */
function diffOfCall(args) {
  const ol = String(args.old_string || args.old_str || '').split('\n');
  const nl = String(args.new_string || args.new_str || '').split('\n');
  if (!ol.length && !nl.length) return '';
  const cut = (s) => (s.length > 40 ? s.slice(0, 40) + '…' : s);
  for (let i = 0; i < Math.max(ol.length, nl.length); i++) {
    const a = String(ol[i] || '').trim(), b = String(nl[i] || '').trim();
    if (a !== b) return (cut(a) || '(空)') + ' → ' + (cut(b) || '(空)');
  }
  return '';
}

/** 读 transcript 最近的工具调用（倒序去重：同名+同目标只留最近一次） */
function readRecentToolCalls(tp, limit = 3) {
  const out = [];
  try {
    if (!tp || !fs.existsSync(tp)) return out;
    const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean).slice(-400);
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let o = null;
      try { o = JSON.parse(lines[i]); } catch (e) { continue; }
      if (!o || o.type !== TOOL_CALL_TYPE) continue;
      const args = parseToolArgs(o.arguments);
      const target = targetOfCall(args);
      const key = String(o.name || '') + '|' + target;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: String(o.name || '?'), target, diff: diffOfCall(args) });
    }
  } catch (e) { /* 读不到 ⇒ 视为无轨迹 */ }
  return out;
}

/** 最近调用 → 「当时正在处理的具体事项」标题 */
function inferWhat(calls) {
  // 只认「能取到目标」的调用 —— 目标取不到就无从谈「具体事项」（交给调用方拒发/跳过）
  const usable = (calls || []).filter((c) => c.target);
  if (!usable.length) return '';
  const write = usable.find((c) => /^(?:edit|write|multiedit|notebookedit|write_to_file|replace_in_file)$/i.test(c.name));
  const c = write || usable[0];
  const verb = write ? '改' : (/^(?:bash|execute_command)$/i.test(c.name) ? '跑' : (/^(?:read|glob|grep|search)/i.test(c.name) ? '查' : '用'));
  let t = String(c.target || '');
  if (t.length > 70) { const i = t.lastIndexOf('/'); t = (i > 0 ? '…/' + t.slice(i + 1) : t.slice(0, 70)); }
  const d = c.diff ? '（' + c.diff + '）' : '';
  return verb + ' ' + t + d;
}

/** 粒度校验：必须落到具体文件 / 命令 / 参数差异，泛词或过短 ⇒ 拒发 */
const VAGUE_RE = /^(?:迭代|阶段|项目|任务|全部|整体|系统|功能|优化|修复|完成|布局|对齐)$/;
function tooVague(what) {
  const w = String(what || '').trim();
  if (w.length < 8) return true;
  if (VAGUE_RE.test(w)) return true;
  const concrete = /[\w-]+\.(?:vue|ts|js|mjs|cjs|json|ya?ml|md|cs|less|css|py|sql|ps1|sh)\b/i.test(w)
    || /[\\/]/.test(w) || /→/.test(w) || /\d/.test(w);
  return !concrete;
}

/** 迭代当前待办步骤（副标题用；取不到返回空，不作主标题） */
function iterationStep() {
  try {
    const rt = path.join(PROJ, '.codebuddy/skills/iteration-workflow/runtime');
    const id = String(fs.readFileSync(path.join(rt, 'ACTIVE'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '').trim();
    if (!id || id === 'none') return '';
    const raw = fs.readFileSync(path.join(rt, `${id}.state.yaml`), 'utf8');
    let name = '';
    for (const ln of raw.split(/\r?\n/)) {
      const mn = ln.match(/^\s*name:\s*"([^"]+)"/);
      if (mn) { name = mn[1]; continue; }
      if (/^\s*status:\s*"?pending"?\s*$/.test(ln) && name) return name;
    }
    return '';
  } catch (e) { return ''; }
}

function shouldSkip() {
  if (process.stdin.isTTY) return false; // 交互调用（无 stdin）→ 直接推送
  const input = readHookInput();
  if (!input) return false;
  try {
    const tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return false; // 无 transcript → fail-safe 推送
    // ★ FIX-22：工具调用是独立行 function_call（assistant 行里没有 tool_use）
    return readRecentToolCalls(tp, 1).length === 0;
  } catch (e) { return false; } // 解析失败 → fail-safe 推送
}

// ★ FIX-19（2026-09-18）：仅「直接执行」时才发消息 —— 被 require（如 notify-enqueue.js
//   复用 renderStructured）时不触发发送，避免复用渲染函数意外发出一条通知。
if (require.main === module) (async () => {
  const argv = process.argv;
  const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? String(argv[i + 1] || '') : ''; };
  const kind = (argOf('--kind') || 'done').toLowerCase();
  const isFallback = argv.indexOf('--fallback') >= 0;      // Stop 钩子兜底（语义 ≠ 任务结束）
  const dryRun = argv.indexOf('--dry-run') >= 0;           // ★ FIX-22：只渲染不发送（自测用，不写去重状态）
  const sess = argOf('--session') || sessionKey();

  // ① 决策类必须可回复 —— 没有 #N 就拒绝发送，倒逼走 ask.js（机制保障，非口头约定）
  if (kind === 'decision' && !argOf('--id')) {
    console.error('[ERR] --kind decision 必须带 --id <N>（决策类必须可回复）。请先登记：node tools/qqbot/ask.js --prompt "…"');
    process.exit(1);
  }
  // ② 全局静默开关（与门禁共用：QQ_NOTIFY=0 或 hooks/.qq-notify-off）
  const muted = mutedReason();
  if (muted) { console.log('[SKIP] QQ 推送已静默（' + muted + '） kind=' + kind); process.exit(0); }
  // ③ 完成类去重（Stop 兜底在「已发过 done」或「10 分钟内已兜过」时跳过 ⇒ 根治双发）
  if (kind === 'done' && !dryRun && doneDedupe(sess, isFallback)) {
    console.log('[SKIP] 同会话 10 分钟内已推送过完成通知（session=' + (sess || 'unknown') + '）'); process.exit(0);
  }
  if (shouldSkip()) { console.log('[SKIP] 本轮无工具调用（纯问答），不推送'); process.exit(0); }

  // ★ 2026-09-17：--json 结构化渲染模式；向后兼容 —— 旧 argv[2] / --preset idle 逻辑完全不变
  let payload = null;
  const ji = argv.indexOf('--json');
  if (ji >= 0 && argv[ji + 1]) {
    try { payload = JSON.parse(argv[ji + 1]); } catch (e) { payload = null; }
  }
  // ④ ★ FIX-22（2026-09-18）：完成/失败类**必须带「当时正在处理的具体事项」** ——
  //    光写「迭代任务完成/布局对齐」一律拒发；粒度须落到文件 / 命令 / 参数差异。
  if (kind === 'done' || kind === 'fail') {
    const explicit = argOf('--what');
    let what = explicit || '';
    if (!what && payload && payload.title) what = String(payload.title);
    const inp = readHookInput();
    const tp = argOf('--transcript') || (inp && inp.transcript_path) || '';
    let calls = [];
    if (!what) {
      calls = readRecentToolCalls(tp, 3);
      what = inferWhat(calls);
      if (what) what = '[推断] ' + what;
    }
    if (!what) {
      if (isFallback) { console.log('[SKIP] 兜底推送但推断不出具体事项（无工具轨迹），不推送'); process.exit(0); }
      console.error('[ERR] --kind ' + kind + ' 必须写明具体事项：加 --what "drug_list.vue 第342行 dosage 列宽 120→90"（须落到文件/命令/参数差异，不能只写「布局对齐」）');
      process.exit(1);
    }
    if (tooVague(String(what).replace(/^\[推断\]\s*/, ''))) {
      console.error('[ERR] 事项粒度过粗："' + what + '" ⇒ 请写明具体文件/行/参数变化（例：--what "drug_list.vue 第342行 dosage 列宽 120→90"）');
      process.exit(1);
    }
    if (!payload) {
      if (!calls.length) calls = readRecentToolCalls(tp, 3);
      const step = iterationStep();
      payload = {
        title: (kind === 'fail' ? '失败：' : '完成：') + what,
        status: argOf('--detail') || '',
        rows: [
          ['本次动作', calls.map((c) => c.name + ' ' + (c.target || '')).join(' ｜ ') || '(未取到)'],
          ...(step ? [['迭代步骤', step]] : []),
        ],
        next: argOf('--next') || '',
      };
    }
  }

  let msg = isFallback ? 'CodeBuddy 本轮结束（多步任务可能未完）' : 'CodeBuddy 任务已完成';
  if (payload && typeof payload === 'object') {
    msg = renderStructured(payload);
  } else {
    const pi = argv.indexOf('--preset');
    if (pi >= 0 && argv[pi + 1] === 'idle') {
      msg = 'CodeBuddy 会话已静置：任务完成，或在等待你确认（运行命令/输入）';
    } else if (argv[2] && !String(argv[2]).startsWith('--')) {
      msg = argv[2];
    }
  }
  // 非结构化消息加类别前缀（结构化由 title 自带；decision 的 #N 由调用方写在正文）
  const label = KIND_LABEL[kind];
  if (label && !payload && !/^【/.test(msg)) msg = '【' + label + '】' + msg;
  if (dryRun) { console.log('[DRY-RUN] kind=' + kind + ' fallback=' + isFallback + '\n' + msg); process.exit(0); }
  try {
    // ★ FIX-17：优先经合并服务统一出口（复用长连接 token，根治多进程抢 token 互踢导致的 401）
    const via = await tryViaService(msg, { kind, session: sess, fallback: isFallback });
    if (via.ok) { console.log('[OK] QQ 通知已发送（via service） ' + via.raw); return; }
    if (!hasCreds) { console.error('[ERR] 服务不可用且本机无凭据，无法发送：' + via.raw); process.exit(1); }
    const token = await getToken();
    const st = await send(msg, token);
    console.log('[OK] QQ 通知已发送, HTTP ' + st);
  } catch (e) { console.error('[ERR]', e.message); process.exit(1); }
})();

module.exports = {
  renderStructured, mutedReason, KIND_LABEL, doneDedupe, sessionKey,
  // ★ FIX-22：供 qqbot-service.js（心跳/静置）复用「具体事项」推断
  readRecentToolCalls, inferWhat, tooVague, iterationStep,
};
