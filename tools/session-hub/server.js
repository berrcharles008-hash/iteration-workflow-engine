#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════════════
// server.js —— session-hub 常驻服务（127.0.0.1:18766，SSOT: 方案分析.md §11）
//
// 端点：
//   GET  /                    单页 UI（public/index.html）
//   GET  /health              hub 自身状态
//   GET  /sessions            会话清单（按开始时间倒序）
//   GET  /session?id=         单条详情 + 回放（日志尾解码，超长截断）
//   GET  /stream?id=&offset=  SSE 实时 tail（Last-Event-ID 为重连锚点）
//   GET  /serve-direct        codebuddy Web UI 直链（渲染期现读口令，修订②）
//   GET  /proxy/qq/health     QQ 服务 /health 代理（2.5s 超时，离线占位，修订⑩）
//   GET  /proxy/qq/pending    QQ 服务 /pending 代理（带 qqKey）
//   GET  /proxy/qq/answers    最近答复（服务端直读 qq-answers 目录）
//   GET  /proxy/qq/logtail    service.log 尾部（服务端直读）
//   POST /spawn               登记并启动会话（四重防护，修订①⑬）
//   POST /kill?id=            终止会话（四重防护 + taskkill /T /F 树杀，禁裸 pid）
//   POST /shutdown            优雅停止（仅回环，stop-hub.ps1 用）
//   GET  /takeover/models     CLI 支持模型清单（★ 2026-11-18；全局，10min TTL）
//   POST /takeover/new        新建 job（body.model 可选；serve 不在跑时自动拉起一次）
//
// 安全口径（修订①）：写操作（spawn/kill）= httpKey 必配 + key 校验 + Host/Origin 同源 +
//   注册表 id 校验（禁裸 pid）；全操作写 hub-audit.jsonl（修订⑮）。
// ══════════════════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const runner = require('./runner.js');

const HUB_DIR = __dirname;
const SESSIONS_DIR = runner.SESSIONS_DIR;
const LOGS_DIR = runner.LOGS_DIR;
const INPUTS_DIR = runner.INPUTS_DIR;
const cfg = runner.loadConfig();

const PORT = Number(cfg.port || 18766);
// ★ P2（2026-11-18）：顶层 httpKey 只作 per-project 回落值，读点在 buildCtx → ctx.httpKey。
//   不再有全局 HTTP_KEY 常量（否则 /p/0003 会被 0010 的密钥放行）。
const MAX_SESSIONS = Math.max(10, Number(cfg.maxSessions || 200));
const MAX_AGE_DAYS = Math.max(1, Number(cfg.maxAgeDays || 14));
const LOG_HARD_CAP = Math.max(1024 * 1024, Number(cfg.logHardCapBytes || 67108864));
const REPLAY_TAIL = Math.max(4096, Number(cfg.replayTailBytes || 262144));
const POLL_MS = Math.max(200, Number(cfg.pollMs || 500));
const BOOT_AT = Date.now();

// ══ ★ 多项目（2026-11-18，hub 迁至 %LOCALAPPDATA%\codebuddy-hub）══════════════
//   原实现是「模块级单例」：PROJ_ROOT / QQ / QQ_URL / DOC_* / TAKEOVER 都是全局常量，
//   一份 hub 只能盯一个项目根。改为**项目上下文（ctx）**：
//     · 项目根、qqbot 端点、docKey、serve 端口、归档目录、takeover 缓存 —— 全部 per-ctx
//     · 请求路由前缀 `/p/<id>/…`；无前缀 = 缺省项目（向后兼容旧书签 / 公网链接 / watchdog）
//     · 全局共享：端口、sessions/logs/inputs 目录（session id 全局唯一）
//     · 写操作 httpKey **per-ctx**（P2）：projects[].httpKey 优先，回落顶层 cfg.httpKey（旧书签兼容）
//   配置 schema 见 hub.config.json → projects[]。
function buildCtx(p) {
  const root = path.resolve(String(p.root));
  const qq = Object.assign({
    origin: 'http://127.0.0.1:18765', key: '', healthTimeoutMs: 2500,
    serveInstanceFile: 'tools/qqbot/runtime/serve-instance.json',
    answersDir: '.codebuddy/temp/qq-answers',
    serviceLog: 'tools/qqbot/service.log',
    answersLimit: 8, logTailLines: 30, simulateKey: '',
  }, p.qq || {});
  const doc = Object.assign({ key: '', publicUrl: '', extraFiles: [], title: '' }, p.doc || {});
  const serve = Object.assign({}, p.serve || {});
  let pub = null;
  try { const s = String(doc.publicUrl || '').trim(); if (s) pub = new URL(s); } catch (e) { pub = null; }
  return {
    id: String(p.id), name: String(p.name || p.id), root: root,
    // ★ per-project 写操作密钥：项目自己配了就用自己的，没配回落顶层 httpKey（旧书签/单项目遗留）
    httpKey: String(p.httpKey || cfg.httpKey || ''),
    qq: qq, qqUrl: new URL(qq.origin), pub: pub,
    doc: doc, docKey: String(doc.key || ''),
    docRoot: path.join(root, 'docs', 'iterations'),
    docTitle: String(doc.title || (String(p.name || p.id) + ' 迭代文档')),
    docExtra: new Set((Array.isArray(doc.extraFiles) ? doc.extraFiles : []).map(String)),
    activeFile: path.join(root, '.codebuddy', 'skills', 'iteration-workflow', 'runtime', 'ACTIVE'),
    serve: serve,
    archiveDir: path.join(HUB_DIR, 'dialog-archive', String(p.id)),
    tkCache: { port: 0, at: 0, alive: false },
    // raw 通道内的相对链接重写（项目产物结构可配；缺省只处理 docs/iterations 内看板）
    linkRewrite: (Array.isArray(doc.linkRewrite) && doc.linkRewrite.length)
      ? doc.linkRewrite
      : [{ from: '../docs/iterations/board.html', to: 'board.html' }],
  };
}
// ★ 注意：必须用 cfg.projects 的**原始对象**（含 qq/doc/serve）；
//   runner.projectList() 只保留 {id,name,root}（runner 侧只关心 cwd），拿它建 ctx 会丢 qq/doc/serve。
const RAW_PROJECTS = (Array.isArray(cfg.projects) ? cfg.projects : []).filter((p) => p && p.id && p.root);
if (!RAW_PROJECTS.length && cfg.root) {
  RAW_PROJECTS.push({ id: cfg.projectId || 'default', name: cfg.projectName || 'default', root: cfg.root });
}
const CTX = new Map();
for (const p of RAW_PROJECTS) {
  try { CTX.set(String(p.id), buildCtx(p)); }
  catch (e) { process.stderr.write('[hub] 项目 ' + p.id + ' 配置无效：' + e.message + '\n'); }
}
if (!CTX.size) {
  process.stderr.write('[hub] 无可用项目：hub.config.json 需形如 {"projects":[{"id":"0010","name":"静配中心","root":"E:/…"}]}\n'
    + '      （运行实例已迁至 ' + HUB_DIR + '，项目根不再从目录推导）\n');
  process.exit(1);
}
const DEFAULT_CTX = CTX.get(String(cfg.default || '')) || CTX.values().next().value;
const PREFIX_RE = /^\/p\/([A-Za-z0-9_-]{1,32})(?=\/|$)/;
/** 从 URL 解析项目上下文：/p/<id>/… > ?p=<id> > 缺省项目；未知 id ⇒ null（调用方回 404） */
function resolveCtx(u) {
  const m = PREFIX_RE.exec(u.pathname);
  if (m) return CTX.get(m[1]) || null;
  const q = String(u.searchParams.get('p') || '');
  if (q) return CTX.get(q) || null;
  return DEFAULT_CTX;
}
/** 剥掉 /p/<id> 前缀，返回等价路径（无前缀原样返回） */
function stripPrefix(pathname) {
  const m = PREFIX_RE.exec(pathname);
  if (!m) return pathname;
  const rest = pathname.slice(m[0].length);
  return rest || '/';
}
/** 生成带项目前缀的路径（渲染链接用） */
function pfx(ctx, p) { return '/p/' + ctx.id + (p || '/'); }

// ── 日志与审计（修订⑮：hub-audit.jsonl）────────────────────────────────
const AUDIT_FILE = path.join(HUB_DIR, 'hub-audit.jsonl');
// ★ v2 加固（2026-10-04 实测 hub 静默崩溃排查）：未捕获异常留痕 + 退出（watchdog 探活会告警）
process.on('uncaughtException', (e) => {
  const line = '[' + new Date().toISOString() + '] UNCAUGHT ' + ((e && e.stack) || e) + '\n';
  try { fs.appendFileSync(path.join(HUB_DIR, 'hub-crash.log'), line); } catch (e2) {}
  try { process.stderr.write(line); } catch (e2) {}
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  const line = '[' + new Date().toISOString() + '] UNHANDLED-REJECTION ' + ((e && e.stack) || e) + '\n';
  try { fs.appendFileSync(path.join(HUB_DIR, 'hub-crash.log'), line); } catch (e2) {}
});
function audit(action, detail) {
  const rec = Object.assign({ ts: new Date().toISOString(), action: action }, detail || {});
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n'); } catch (e) {}
}

// ── 解码（修订⑥：复用 qqbot-service decodeConsoleBytes 模式 —— GBK 优先，UTF-8 回退不劣化）──
let _gbkDecoder = null, _gbkTried = false;
function decodeBytes(buf, enc) {
  if (buf == null) return '';
  if (!Buffer.isBuffer(buf)) return String(buf);
  if (!buf.length) return '';
  if (enc === 'gbk') {
    if (!_gbkTried) {
      _gbkTried = true;
      try { _gbkDecoder = new TextDecoder('gbk'); } catch (e) { _gbkDecoder = null; }
    }
    if (_gbkDecoder) { try { return _gbkDecoder.decode(buf); } catch (e) {} }
  }
  return buf.toString('utf8');
}

// ── 会话注册表 ────────────────────────────────────────────────────────────
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function validId(id) { return ID_RE.test(String(id || '')) && String(id).indexOf('..') < 0; }
function readSession(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id + '.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return null; }
}
function writeSession(entry) { runner.writeJsonAtomic(path.join(SESSIONS_DIR, entry.id + '.json'), entry); }
function listSessions() {
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const f of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8').replace(/^\uFEFF/, ''))); } catch (e) {}
  }
  out.sort((a, b) => Number(b.startedAtMs || 0) - Number(a.startedAtMs || 0));
  return out;
}

// ── 启动对账（修订④）：pid 存活探测，幽灵 running → failed ─────────────
function reconcile() {
  let fixed = 0;
  for (const s of listSessions()) {
    if (s.status !== 'running' || !s.pid) continue;
    let alive = false;
    try { process.kill(Number(s.pid), 0); alive = true; } catch (e) { alive = (e.code === 'EPERM'); }
    if (!alive) {
      s.status = 'failed'; s.exitCode = null; s.signal = null;
      s.endedAt = new Date().toISOString();
      s.note = 'reconciled: pid ' + s.pid + ' dead（hub 重启对账）';
      writeSession(s); fixed++;
    }
  }
  if (fixed) audit('reconcile', { fixed: fixed });
  return fixed;
}

// ── 启动清扫（修订⑫）：超龄 14 天删除；总量 cap 淘汰最旧 ────────────────
function sweep() {
  const now = Date.now();
  let list = listSessions();
  let removed = 0;
  for (const s of list) {
    const endMs = Number(s.endedAtMs || s.startedAtMs || 0);
    if (s.status !== 'running' && endMs && now - endMs > MAX_AGE_DAYS * 86400000) {
      try { fs.unlinkSync(path.join(SESSIONS_DIR, s.id + '.json')); } catch (e) {}
      try { fs.unlinkSync(path.join(LOGS_DIR, s.id + '.log')); } catch (e) {}
      try { fs.unlinkSync(path.join(INPUTS_DIR, s.id + '.in')); } catch (e) {}   // ★ v2：连带清理输入中继
      removed++;
    }
  }
  if (removed) audit('sweep-age', { removed: removed, maxAgeDays: MAX_AGE_DAYS });
  // ★ v2：对话归档超龄清理（按文件 mtime）—— ★ 多项目：逐项目归档目录
  for (const c of CTX.values()) {
    try {
      for (const f of fs.readdirSync(c.archiveDir)) {
        const fp = path.join(c.archiveDir, f);
        try { if (now - fs.statSync(fp).mtimeMs > MAX_AGE_DAYS * 86400000) fs.unlinkSync(fp); } catch (e) {}
      }
    } catch (e) { /* 目录不存在 */ }
  }
  list = listSessions().filter((s) => s.status !== 'running');
  if (list.length > MAX_SESSIONS) {
    list.sort((a, b) => Number(a.startedAtMs || 0) - Number(b.startedAtMs || 0));   // 最旧在前
    const kill = list.slice(0, list.length - MAX_SESSIONS);
    for (const s of kill) {
      try { fs.unlinkSync(path.join(SESSIONS_DIR, s.id + '.json')); } catch (e) {}
      try { fs.unlinkSync(path.join(LOGS_DIR, s.id + '.log')); } catch (e) {}
      try { fs.unlinkSync(path.join(INPUTS_DIR, s.id + '.in')); } catch (e) {}   // ★ v2：连带清理输入中继
    }
    audit('sweep-cap', { removed: kill.length, cap: MAX_SESSIONS });
  }
}

// ── hub 内存 child（POST /spawn 派生的会话，修订① child 句柄校验）────────
const children = new Map();   // id → child

// ── SSE tail 客户端（修订⑧：offset 重置 / 尾行缓存 / Last-Event-ID 锚点）──
function startStream(req, res, id, startOffset) {
  const s = readSession(id);
  if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"session-not-found"}'); return; }
  const enc = s.encoding || 'utf8';
  const logPath = path.join(LOGS_DIR, id + '.log');
  let offset = Math.max(0, Number(startOffset) || 0);
  let pending = Buffer.alloc(0);              // 尾部残行缓存（防截断多字节字符）
  let lastDataAt = Date.now();
  let closed = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  const sendFrame = (event, text, offsetNow) => {
    if (closed) return;
    try {
      if (offsetNow != null) res.write('id: ' + offsetNow + '\n');
      if (event) res.write('event: ' + event + '\n');
      res.write('data: ' + String(text).replace(/\r/g, '').replace(/\n/g, '\ndata: ') + '\n\n');
    } catch (e) { closed = true; }                                              // timer 可能尚未初始化，清理由 req close 兜底
  };
  sendFrame('meta', JSON.stringify({ id: id, tool: s.tool, status: s.status, encoding: enc }), null);

  const tickTail = () => {
    if (closed) return;
    let size = 0;
    try { size = fs.statSync(logPath).size; } catch (e) { return; }         // 日志尚未创建
    if (size < offset) {                                                     // 日志重建/截断 ⇒ 全量重置
      offset = 0; pending = Buffer.alloc(0);
      sendFrame('reset', 'log rotated/truncated — replay from 0', null);
    }
    if (size === offset) {                                                   // 无增量：30s 心跳注释帧
      if (Date.now() - lastDataAt > 30000) { res.write(': ping\n\n'); lastDataAt = Date.now(); }
      return;
    }
    let from = offset;
    if (size - from > LOG_HARD_CAP) { from = size - LOG_HARD_CAP; sendFrame('reset', 'log > hard cap — tail only', null); }
    let buf;
    try {
      const fd = fs.openSync(logPath, 'r');
      try {
        buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
      } finally { fs.closeSync(fd); }
    } catch (e) { return; }
    offset = size;
    pending = Buffer.concat([pending, buf]);
    // 按最后一个 \n 切（GBK 第二字节 ≥0x40、UTF-8 续字节 ≥0x80，均不会是 0x0A ⇒ 按行切安全）
    const nl = pending.lastIndexOf(0x0A);
    if (nl < 0) return;                                                      // 整段无行界 ⇒ 全部留缓存
    const lines = pending.slice(0, nl);                                      // 不含结尾 \n
    pending = pending.slice(nl + 1);
    const text = decodeBytes(lines, enc);
    if (text.length) { sendFrame(null, text, offset); lastDataAt = Date.now(); }
    // 终态提示（会话已结束且日志追平 ⇒ 一次性 end 帧）
    const cur = readSession(id);
    if (cur && cur.status !== 'running') {
      sendFrame('end', JSON.stringify({ status: cur.status, exitCode: cur.exitCode, endedAt: cur.endedAt }), null);
      closed = true; clearInterval(timer);
      try { res.end(); } catch (e) {}
    }
  };
  const timer = setInterval(tickTail, POLL_MS);
  req.on('close', () => { closed = true; clearInterval(timer); });
  tickTail();
}

// ── 回放（修订⑫：超长截断保留尾部）────────────────────────────────────
function replayText(s) {
  const logPath = path.join(LOGS_DIR, s.id + '.log');
  let size = 0;
  try { size = fs.statSync(logPath).size; } catch (e) { return { text: '（无日志）', truncated: false, size: 0 }; }
  const readBytes = Math.min(size, REPLAY_TAIL, LOG_HARD_CAP);
  let buf;
  try {
    const fd = fs.openSync(logPath, 'r');
    try { buf = Buffer.alloc(readBytes); fs.readSync(fd, buf, 0, readBytes, size - readBytes); }
    finally { fs.closeSync(fd); }
  } catch (e) { return { text: '（日志读取失败: ' + e.message + '）', truncated: false, size: size }; }
  return { text: decodeBytes(buf, s.encoding || 'utf8'), truncated: size > readBytes, size: size };
}

// ── codebuddy Web UI 直链（修订②：渲染期现读 settings.json，口令不落日志）──
function readGatewayPassword() {
  try {
    const p = path.join(os.homedir(), '.codebuddy', 'settings.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    const v = j && j.gateway && j.gateway.password;
    return v ? String(v) : '';
  } catch (e) { return ''; }
}
function probePort(port, timeoutMs, cb) {
  let done = false;
  const finish = (v) => { if (done) return; done = true; cb(v); };
  const req = http.request({ host: '127.0.0.1', port: port, path: '/', method: 'GET', timeout: timeoutMs }, (r) => {
    r.resume(); finish(true);
  });
  req.on('error', () => finish(false));
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
  req.end();
}
function serveDirect(ctx, cb) {
  let inst = null;
  try {
    inst = JSON.parse(fs.readFileSync(path.join(ctx.root, String(ctx.qq.serveInstanceFile || 'tools/qqbot/runtime/serve-instance.json')), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { inst = null; }
  if (!inst || !inst.port) { cb({ alive: false, reason: 'no-instance', project: ctx.id }); return; }
  probePort(Number(inst.port), 2000, (alive) => {
    if (!alive) { cb({ alive: false, reason: 'port-dead', port: inst.port, project: ctx.id }); return; }
    const pw = readGatewayPassword();
    const webUrl = 'http://127.0.0.1:' + inst.port;
    cb({
      alive: true, pid: inst.pid, port: inst.port, tier: inst.tier || 'A', project: ctx.id,
      startedAt: inst.startedAt || '', lastUsedAt: inst.lastUsedAt || null,
      webUrl: webUrl,
      directUrl: pw ? (webUrl + '/?password=' + encodeURIComponent(pw)) : webUrl,
      hasPassword: !!pw,
    });
  });
}

// ── QQ 服务代理（修订⑩：2.5s 超时 + 离线占位；修订⑮：/pending 带 key）────
function proxyQq(ctx, qqPath, withKey, cb) {
  let done = false;
  const finish = (v) => { if (done) return; done = true; cb(v); };
  const fullPath = qqPath + (withKey && ctx.qq.key ? (qqPath.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(ctx.qq.key) : '');
  // ★ 注意用 hostname（URL.host 含端口，传给 http.request 的 host 会连不上 —— 实测修正）
  const req = http.request({ host: ctx.qqUrl.hostname, port: ctx.qqUrl.port || 80, path: fullPath, method: 'GET', timeout: Number(ctx.qq.healthTimeoutMs || 2500) }, (r) => {
    let d = '';
    r.setEncoding('utf8');
    r.on('data', (c) => { d += c; });
    r.on('end', () => {
      if (r.statusCode !== 200) { finish({ offline: true, reason: 'http-' + r.statusCode }); return; }
      try { finish(JSON.parse(d)); } catch (e) { finish({ offline: true, reason: 'bad-json' }); }
    });
  });
  req.on('error', () => finish({ offline: true, reason: 'unreachable' }));
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish({ offline: true, reason: 'timeout' }); });
  req.end();
}
/** qq-answers 绝对路径（单一来源；dialogFlow/sessionDialogs/answersList 共用） */
const answerDirAbs = (ctx) => path.join(ctx.root, String(ctx.qq.answersDir || '.codebuddy/temp/qq-answers'));
/**
 * ★ v2 加固（2026-10-04 实测暴露）：答复归档 —— qqbot 服务重启后 nextId 归 1 + 登记即
 *   clearStaleAnswer（防 wait-answer 误读，FIX-40）⇒ **同 id 的历史答复会被覆盖**（实测
 *   早间 #1 confirm 被测试的 #1 timeout 顶掉，对话流历史丢失）。
 *   归档策略：hub 读到答复文件即幂等复制到 dialog-archive/<id>-<mtimeMs>.json（同 mtime 不重复），
 *   时间线合并「归档全量 + 当前目录」，同 id 多条按时间并存展示（能看出编号复用）。
 */
function archiveAnswerFile(ctx, srcFile) {
  try {
    const st = fs.statSync(srcFile);
    fs.mkdirSync(ctx.archiveDir, { recursive: true });      // ★ 多项目：dialog-archive/<proj>/（编号复用不串台）
    const dest = path.join(ctx.archiveDir, path.basename(srcFile, '.json') + '-' + Math.round(st.mtimeMs) + '.json');
    if (!fs.existsSync(dest)) fs.copyFileSync(srcFile, dest);
  } catch (e) {}
}
/** 读答复集合：归档全量 + 当前目录（key = id@ts 去重，当前目录优先） */
function readAllAnswers(ctx) {
  const out = new Map();
  const load = (dir) => {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let a = null;
      try { a = JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { continue; }
      if (!a || a.id == null) continue;
      out.set(String(a.id) + '@' + String(a.ts || ''), a);
    }
  };
  load(ctx.archiveDir);                       // ★ 多项目：只读本项目归档（不串台）
  const cur = answerDirAbs(ctx);
  load(cur);
  // 当前目录的文件做归档（幂等）
  let curFiles = [];
  try { curFiles = fs.readdirSync(cur).filter((f) => f.endsWith('.json')); } catch (e) {}
  for (const f of curFiles) archiveAnswerFile(ctx, path.join(cur, f));
  return [...out.values()];
}
function answersList(ctx) {
  const dir = answerDirAbs(ctx);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) {}
  }
  out.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return out.slice(-Number(ctx.qq.answersLimit || 8)).reverse();
}
/**
 * ★ v2（增补①）：对话流 —— `/pending`（进行中的问，含 session/createdAt）+ qq-answers（已结算的问+答，
 *   含新增 session 字段）按 id 合并为时间线；无新增持久化（两侧本就带 prompt 全文）。
 *   配对语义：status = pending / answered / timeout / cancelled；answer 携带 text（自由文本）与 choice（选项键）。
 */
function dialogFlow(ctx, cb) {
  proxyQq(ctx, '/pending', true, (pend) => {
    const offline = !!(pend && pend.offline);
    const byId = new Map();
    // 1) 已结算（归档全量 + 当前目录；key = id@ts —— 编号复用场景下多代记录并存）
    for (const a of readAllAnswers(ctx)) {
      byId.set(String(a.id) + '@' + String(a.ts || ''), {
        id: a.id, prompt: a.prompt || '', kind: a.kind || '', options: a.options || [], recommend: '',
        session: a.session || '', ts: a.ts || '', createdAt: 0,
        // ★ TOOL-ANSWERKIND（2026-10-20）：defer-ide（回 IDE 拍板）曾被一律显示成 answered（已答复），
        //   人读"已答复"很容易再演"已确认"的同类误读（事故复盘时正是这条把线索带偏）。单列 deferred 态。
        status: (a.answer === 'timeout' ? 'timeout'
          : ((a.answer === 'cancel' || a.answer === 'cancelled') ? 'cancelled'
            : ((a.answerKind === 'no-decision' || a.answer === 'defer-ide' || a.answer === 'ide') ? 'deferred' : 'answered'))),
        answer: a.answer || '', text: a.text || '', choice: a.choice || '',
      });
    }
    // 2) 进行中（pending 追加为独立条目；同 id 历史项若有空 session 则补齐，不覆盖历史）
    if (!offline && Array.isArray(pend)) {
      for (const p of pend) {
        if (p.status !== 'pending') continue;
        const idKey = String(p.id);
        for (const kv of byId) { if (kv[0].startsWith(idKey + '@') && !kv[1].session && p.session) kv[1].session = p.session; }
        const createdAt = Number(p.createdAt || 0);
        byId.set(idKey + '@pending', {
          id: p.id, prompt: p.prompt || '', kind: p.kind || '', options: p.options || [],
          recommend: p.recommend || '', session: p.session || '',
          ts: createdAt ? new Date(createdAt).toISOString() : '', createdAt: createdAt,
          status: 'pending', answer: '', text: '', choice: '',
        });
      }
    }
    const items = [...byId.values()].sort((a, b) => (b.createdAt || Date.parse(b.ts) || 0) - (a.createdAt || Date.parse(a.ts) || 0));
    cb({ offline: offline, count: items.length, items: items });
  });
}

/** ★ v2（增补②）：某会话关联的已结算问答（qq-answers 按 session 过滤；进行中的项在 /dialog 区块看） */
function sessionDialogs(ctx, id) {
  const out = [];
  for (const a of readAllAnswers(ctx)) {
    if (!a || a.session !== id) continue;
    out.push({ id: a.id, ts: a.ts || '', prompt: a.prompt || '', kind: a.kind || '',
      answer: a.answer || '', text: a.text || '', choice: a.choice || '' });
  }
  out.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return out;
}

function logTail(ctx) {
  const fp = path.join(ctx.root, String(ctx.qq.serviceLog || 'tools/qqbot/service.log'));
  const n = Number(ctx.qq.logTailLines || 30);
  try {
    const st = fs.statSync(fp);
    const size = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(fp, 'r');
    try { fs.readSync(fd, buf, 0, size, st.size - size); } finally { fs.closeSync(fd); }
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch (e) { return []; }
}

// ── 安全：Host/Origin 校验 + 写操作四重防护（修订①）─────────────────────
// ★ 2026-10-06：公网域名上线后（Cloudflare 隧道 → doc.publicUrl），浏览器写操作的
//   Host/Origin = 公网域名，原回环-only 白名单必拒（表象：WebUI 新建会话报 bad-host）。
//   白名单扩展为 回环 + doc.publicUrl 派生域名（单源 hub.config.json；缺省时行为同旧）。
//   写防护主闸仍是 httpKey + 审计；/shutdown 走 remoteAddress 回环判定，不受影响。
function hostOk(req, ctx) {
  const h = String(req.headers.host || '');
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h)) return true;
  const pub = ctx && ctx.pub;                                                  // ★ 多项目：白名单取本项目 doc.publicUrl
  if (!pub) return false;
  return h.toLowerCase() === pub.host.toLowerCase();                            // host 含端口（443/80 默认端口省略时仅域名）
}
function originOk(req, ctx) {
  const o = String(req.headers.origin || '');
  if (!o) return true;                                                         // 非浏览器调用（curl/脚本）无 Origin
  if (o === ('http://127.0.0.1:' + PORT) || o === ('http://localhost:' + PORT)) return true;
  const pub = ctx && ctx.pub;
  if (!pub) return false;
  return o.toLowerCase() === (pub.protocol + '//' + pub.host).toLowerCase();
}
function requestKey(req, u) {
  return String(u.searchParams.get('key') || req.headers['x-hub-key'] || '');
}
/** 写操作四重防护（修订①）：返回 null=通过，否则已写响应 */
function writeAuth(req, res, u, ctx) {
  if (!hostOk(req, ctx)) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"bad-host"}'); return 'host'; }
  if (!originOk(req, ctx)) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"bad-origin"}'); return 'origin'; }
  // ★ P2：密钥 per-project（ctx.httpKey 已在 buildCtx 里完成 项目值 → 顶层回落 的解析）
  const expect = String(ctx.httpKey || '');
  if (!expect) {                                                                // 空 key 拒写（必须显式配置）
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"error":"key-not-configured","hint":"hub.config.json projects[].httpKey（或顶层 httpKey）未配置 ⇒ 写操作被拒绝"}');
    return 'key-missing';
  }
  if (requestKey(req, u) !== expect) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"bad-key"}');
    return 'key';
  }
  return null;
}

// ── /kill（修订①/⑯：注册表 id + taskkill /T /F 树杀，禁裸 pid）──────────
function killSession(id, res) {
  const s = readSession(id);
  if (!s) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"session-not-found"}'); return; }
  if (s.status !== 'running') { res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"already-ended","status":' + JSON.stringify(s.status) + '}'); return; }
  const pid = Number(s.pid);
  if (!pid) { res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"no-pid"}'); return; }
  audit('kill', { id: id, pid: pid, tool: s.tool });
  // hub 自派生的会话：先占位终态 killed（finalize 防重入 ⇒ taskkill 后的 exit 事件不会覆盖为 failed）
  const mem = children.get(id);
  if (mem && mem.finalize) mem.finalize('killed', null, 'taskkill', 'killed via /kill');
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    .on('error', () => { try { process.kill(pid); } catch (e) {} });           // taskkill 不可用兜底
  // hub 自派生的 child：exit 事件会写终态（finalize 防重入）；1.2s 后条目仍 running（如 runner 已死）⇒ 兜底补终态
  setTimeout(() => {
    const cur = readSession(id);
    if (cur && cur.status === 'running') {
      cur.status = 'killed'; cur.signal = 'taskkill'; cur.exitCode = null;
      cur.endedAt = new Date().toISOString();
      cur.note = 'killed via /kill（runner 未落终态，hub 兜底）';
      writeSession(cur);
      audit('kill-finalize', { id: id });
    }
  }, 1200).unref();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, id: id, pid: pid, via: 'taskkill /T /F' }));
}

// ── /qq-reply（★ 方案 A，2026-10-04）：hub 页面上直接回复/确认 #N ─────────────
//   链路：hub（四重防护）→ qqbot `POST /simulate-message`（loopback + simulateKey 必配 +
//   命令类/kind 白名单预检）→ handleMessage（与真实 QQ 消息同一处理链 → 落答案/触发接管）。
//   action：confirm → 「确认#N」；cancel → 「取消#N」；choice → 「<key>#N」；text → 自由文本（原样注入）。
function qqReply(ctx, body, res) {
  const id = Number(body.id);
  const action = String(body.action || '').trim();
  if (!id || ['confirm', 'cancel', 'choice', 'text'].indexOf(action) < 0) {
    json(res, 400, { error: 'bad-params', hint: 'id + action ∈ {confirm,cancel,choice,text}' });
    return;
  }
  let content = '';
  if (action === 'confirm') content = '确认#' + id;
  else if (action === 'cancel') content = '取消#' + id;
  else if (action === 'choice') {
    const k = String(body.key || '').trim().toUpperCase().slice(0, 1);
    if (!/^[A-Z]$/.test(k)) { json(res, 400, { error: 'bad-choice-key' }); return; }
    content = k + '#' + id;
  } else content = String(body.text || '').trim();
  if (!content || content.length > 500) { json(res, 400, { error: 'empty-or-too-long' }); return; }
  const simKey = String((ctx.qq.simulateKey || ''));
  if (!simKey) {
    json(res, 403, { error: 'simulate-disabled', hint: 'qqbot daemon.config.json → hub.simulateKey 与 hub.config.json → projects[].qq.simulateKey 需配置同值' });
    return;
  }
  audit('qq-reply', { p: ctx.id, id: id, action: action, content: content.slice(0, 60) });   // ★ 全审计（模拟身份能力必须留痕）
  const payload = JSON.stringify({ content: content });
  const r = http.request({
    host: ctx.qqUrl.hostname, port: ctx.qqUrl.port || 80,
    path: '/simulate-message?key=' + encodeURIComponent(simKey), method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 8000,
  }, (qr) => {
    let d = '';
    qr.setEncoding('utf8');
    qr.on('data', (c) => { d += c; });
    qr.on('end', () => {
      let j = null; try { j = JSON.parse(d); } catch (e) {}
      audit('qq-reply-result', { id: id, http: qr.statusCode });
      if (qr.statusCode === 200 && j && j.ok) { json(res, 200, { ok: true, id: id, action: action, content: content }); return; }
      json(res, qr.statusCode === 200 ? 500 : qr.statusCode, Object.assign({ id: id, action: action }, j || { error: 'bad-upstream', raw: String(d).slice(0, 200) }));
    });
  });
  r.on('error', (e) => json(res, 502, { error: 'qqbot-unreachable', message: e.message }));
  r.on('timeout', () => { try { r.destroy(); } catch (e) {} json(res, 504, { error: 'qqbot-timeout' }); });
  r.write(payload); r.end();
}

// ── /input（★ v2 增补③）：向运行中会话注入 stdin（四重防护 + running 校验）─────
//   双通道：hub 自派会话（内存 child 句柄）→ child.stdin 直写；runner 会话 → inputs/<id>.in 中继
//   （runner 侧 500ms 轮询增量转发，见 runner.js inputTick）。
function inputSession(id, data, res) {
  const s = readSession(id);
  if (!s) { json(res, 404, { error: 'session-not-found' }); return; }
  if (s.status !== 'running') { json(res, 409, { error: 'not-running', status: s.status }); return; }
  const text = String(data == null ? '' : data);
  if (!text.length) { json(res, 400, { error: 'empty-data' }); return; }
  if (text.length > 2000) { json(res, 400, { error: 'data-too-long', limit: 2000 }); return; }
  audit('input', { id: id, chars: text.length });
  const mem = children.get(id);
  if (mem && mem.child && mem.child.stdin && !mem.child.stdin.destroyed) {
    try {
      mem.child.stdin.write(text + '\n');
      json(res, 200, { ok: true, id: id, via: 'memory-stdin', chars: text.length });
      return;
    } catch (e) { /* 落到文件中继兜底 */ }
  }
  try {
    fs.mkdirSync(INPUTS_DIR, { recursive: true });
    fs.appendFileSync(path.join(INPUTS_DIR, id + '.in'), JSON.stringify({ ts: Date.now(), data: text }) + '\n', 'utf8');
    json(res, 200, { ok: true, id: id, via: 'file-relay', chars: text.length });
  } catch (e) {
    json(res, 500, { error: 'relay-failed', message: e.message });
  }
}

// ── /spawn（修订⑬：与 runner 同约定；cmd 只收数组，execFile 语义无 shell）──
function spawnSession(ctx, body, res) {
  const tool = String(body.tool || '').trim();
  const cmdArr = Array.isArray(body.cmd) ? body.cmd.map(String) : [];
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(tool)) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"bad-tool"}'); return; }
  if (!cmdArr.length || cmdArr.some((c) => !c)) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"bad-cmd"}'); return; }
  let r;
  try {
    r = runner.registerAndSpawn({
      tool: tool, cmd: cmdArr,
      project: ctx.id,                                        // ★ 多项目：登记到该项目（缺省 cwd = 项目根）
      cwd: body.cwd ? String(body.cwd) : ctx.root,
      tags: Array.isArray(body.tags) ? body.tags : [],
      encoding: body.encoding ? String(body.encoding) : '',
    });
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'spawn-failed', message: e.message }));
    return;
  }
  children.set(r.entry.id, { child: r.child, finalize: r.finalize });
  r.child.on('exit', () => children.delete(r.entry.id));
  audit('spawn', { id: r.entry.id, tool: tool, pid: r.entry.pid });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, id: r.entry.id, pid: r.entry.pid, logPath: r.entry.logPath }));
}

// ── takeover 代理（★ 2026-10-04）：serve Jobs API → hub 两栏接管面板 ─────
//   口令只在服务端（readGatewayPassword 现读 settings.json），前端一律走 /takeover/*。
//   serve 端口解析：serve-instance.json（若探活）→ cfg.serve.port（默认 19000）→ 都死 = serve-down。
//   形状实证（probe-takeover.js 2026-10-04）：
//     GET  /api/v1/jobs           → {data:{jobs:[{id,sessionId,state,tempo,detail,name,intent,cwd,kind,startedAt,updatedAt,...}]}}
//     POST /api/v1/jobs/<id>/reply {text} → {data:{delivered:true,notice:"Reply sent"}}
//     GET  /api/v1/jobs/<id>/transcript → {data:{sessionId,updates:[{sessionUpdate,messageId,content,_meta:{timestamp}}]}}
//     GET  /api/v1/jobs/<id>/stream → SSE：event: keepalive / message（role/content/type）
//     DELETE /api/v1/jobs/<id>    → 客户端 10s 可能超时但服务端最终生效 ⇒ 本代理用 30s 长超时
// ★ 多项目：serve 端口与探活缓存改为 per-ctx（ctx.serve / ctx.tkCache —— 两项目 serve 端口不同）
const TAKEOVER_DEFAULT = { port: 19000, probeTimeoutMs: 5000, cacheMs: 3000, jobPermissionMode: 'bypassPermissions' };
function tkCfg(ctx) { return Object.assign({}, TAKEOVER_DEFAULT, ctx.serve || {}); }
// ★ probeTimeoutMs=5000：job working 时 serve 事件循环忙碌，GET / 可能 >2s（同 FIX-34c 教训）；
function takeoverPort(ctx, cb) {
  const tk = tkCfg(ctx);
  const now = Date.now();
  if (now - ctx.tkCache.at < tk.cacheMs) { cb(ctx.tkCache.alive ? ctx.tkCache.port : 0); return; }
  let inst = null;
  try {
    inst = JSON.parse(fs.readFileSync(path.join(ctx.root, String(ctx.qq.serveInstanceFile || 'tools/qqbot/runtime/serve-instance.json')), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { inst = null; }
  const instPort = inst && inst.port ? Number(inst.port) : 0;
  const tryProbe = (p, next) => { if (!p) { next(0); return; } probePort(p, Number(tk.probeTimeoutMs) || 2000, (alive) => next(alive ? p : 0)); };
  tryProbe(instPort, (p1) => {
    if (p1) { ctx.tkCache.port = p1; ctx.tkCache.at = now; ctx.tkCache.alive = true; cb(p1); return; }
    tryProbe(Number(tk.port) || 19000, (p2) => {
      ctx.tkCache.port = p2; ctx.tkCache.at = now; ctx.tkCache.alive = !!p2;
      cb(p2);
    });
  });
}
function takeoverHeaders() {
  return { 'Authorization': 'Bearer ' + readGatewayPassword(), 'x-codebuddy-request': '1' };
}

// ══ ★ 2026-11-18：serve 自动拉起 + 模型清单（MVP）════════════════════════════════
//  ① serve-down 补位：hub 的 /takeover/new 依赖 serve，但 hub 自身没有拉起能力
//     （qqbot 有 ensureServeInstance，hub 没有）⇒ 实测两项目 serve 均 ECONNREFUSED 时新建会话必 502。
//     手法 = 复用同目录 start-serve.ps1（内部 Start-Process 起独立进程）。**不能**在此直接
//     spawn CLI 且 stdio:'ignore' —— stdin EOF 会让 serve 秒退（qqbot/adapter-headless.js:15 P0 铁律）。
//  ② 模型：POST /api/v1/jobs 请求体原生支持 model（qqbot 2026-10-09 探针实证），逐 job 生效，
//     serve 实例不换型、不重启；清单唯一来源 = CLI `--help` 的 "Currently supported: (…)"。
//     ★ CLI 对错模型名**静默接受**（照跑默认模型，stderr 空）⇒ 必须前置白名单校验，不能靠手输。
const MODEL_RE = /^[\w.:\-]{1,64}$/;
const MODEL_TTL_MS = 600 * 1000;                 // 单次 --help 冷启 ~4.4s，10 分钟内复用
const CLI_PKG_REL = path.join('node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
let _modelCache = { at: 0, models: [], source: 'none' };
let _modelProbe = null;                          // 并发合流：同时多个请求只冷启一次
const _serveLaunch = new Map();                  // ctx.id → { busy, waiters[] }

/** CLI 位置：cfg.cli{nodeExe,entryJs} > 真探测（node 同级全局包 / %APPDATA%\npm / PATH）> 兜底 */
function resolveCliPaths() {
  const c = (cfg && cfg.cli) || {};
  const nodeExe = String(c.nodeExe || '').trim() || process.execPath;
  let entry = String(c.entryJs || '').trim();
  if (!entry) {
    const cands = [];
    try { cands.push(path.join(path.dirname(process.execPath), CLI_PKG_REL)); } catch (e) {}
    try { if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', CLI_PKG_REL)); } catch (e) {}
    try {
      for (const d of String(process.env.PATH || '').split(';')) {
        if (d && /npm|nodejs|node/i.test(d)) cands.push(path.join(d, CLI_PKG_REL));
      }
    } catch (e) {}
    cands.push('C:\\nvm4w\\nodejs\\' + CLI_PKG_REL);
    entry = cands.find((p) => { try { return !!p && fs.existsSync(p); } catch (e) { return false; } }) || '';
  }
  return { nodeExe: nodeExe, entry: entry };
}
function parseModelList(text) {
  const m = String(text || '').match(/Currently supported:\s*\(([^)]+)\)/);
  if (!m) return [];
  const out = [];
  for (const raw of m[1].split(/[,\r\n]+/)) {
    const s = String(raw).trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}
/** 取模型清单（cb 只回调一次；失败必须显式 ok:false，不得静默回空清单） */
function getModelList(force, cb) {
  cb = cb || (() => {});
  if (!force && _modelCache.models.length && (Date.now() - _modelCache.at) < MODEL_TTL_MS) {
    cb({ ok: true, models: _modelCache.models.slice(), source: _modelCache.source, cached: true });
    return;
  }
  if (_modelProbe) { _modelProbe.push(cb); return; }
  _modelProbe = [cb];
  const fin = (r) => {
    const ws = _modelProbe || []; _modelProbe = null;
    for (const w of ws) { try { w(r); } catch (e) {} }
  };
  const p = resolveCliPaths();
  if (!p.entry || !fs.existsSync(p.entry)) { fin({ ok: false, models: [], source: 'none', reason: 'CLI entry 不存在：' + p.entry }); return; }
  let child;
  try { child = spawn(p.nodeExe, [p.entry, '--help'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { fin({ ok: false, models: [], source: 'none', reason: 'spawn 失败：' + e.message }); return; }
  const out = [], err = [];
  let done = false;
  const timer = setTimeout(() => {
    if (done) return; done = true;
    try { child.kill(); } catch (e) {}
    fin({ ok: false, models: [], source: 'none', reason: '--help 超时（15s）' });
  }, 15000);
  if (child.stdout) child.stdout.on('data', (d) => out.push(Buffer.from(d)));
  if (child.stderr) child.stderr.on('data', (d) => err.push(Buffer.from(d)));
  child.on('error', (e) => {
    if (done) return; done = true; clearTimeout(timer);
    fin({ ok: false, models: [], source: 'none', reason: 'spawn error：' + e.message });
  });
  child.on('exit', () => {
    if (done) return; done = true; clearTimeout(timer);
    const models = parseModelList(decodeBytes(Buffer.concat(out), 'utf8'));
    if (models.length) {
      _modelCache = { at: Date.now(), models: models.slice(), source: 'help' };
      fin({ ok: true, models: models, source: 'help', cached: false });
      return;
    }
    const et = decodeBytes(Buffer.concat(err), 'utf8').trim();
    fin({ ok: false, models: [], source: 'none', reason: '未能从 --help 解析清单' + (et ? ('；stderr：' + et.slice(0, 120)) : '') });
  });
}
function powershellExe() {
  const sr = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const p = path.join(sr, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(p)) return p; } catch (e) {}
  return 'powershell';
}
/** 直探 serve（绕过 tkCache 3s 缓存）：instance 文件端口 → 配置端口 */
function probeServe(ctx, cb) {
  const tk = tkCfg(ctx);
  let inst = null;
  try {
    inst = JSON.parse(fs.readFileSync(path.join(ctx.root, String(ctx.qq.serveInstanceFile || 'tools/qqbot/runtime/serve-instance.json')), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { inst = null; }
  const cands = [];
  if (inst && Number(inst.port)) cands.push(Number(inst.port));
  if (Number(tk.port) && cands.indexOf(Number(tk.port)) < 0) cands.push(Number(tk.port));
  const next = (i) => {
    if (i >= cands.length) { cb(0); return; }
    probePort(cands[i], Number(tk.probeTimeoutMs) || 3000, (alive) => { if (alive) cb(cands[i]); else next(i + 1); });
  };
  next(0);
}
/**
 * 确保 serve 在跑：活 ⇒ 复用；死 ⇒ start-serve.ps1 -NoWait 拉起后轮询探活（≤90s，实测冷启 >31s）。
 * 同一项目并发只冷启一次（waiters 合流）。
 * @returns cb({ok, port?, reused?|spawned?, reason?, hint?})
 */
function ensureServe(ctx, cb) {
  probeServe(ctx, (port) => {
    if (port) { ctx.tkCache = { port: port, at: Date.now(), alive: true }; cb({ ok: true, port: port, reused: true }); return; }
    const st = _serveLaunch.get(ctx.id) || { busy: false, waiters: [] };
    _serveLaunch.set(ctx.id, st);
    if (st.busy) { st.waiters.push(cb); return; }
    const script = path.join(HUB_DIR, 'start-serve.ps1');
    if (!fs.existsSync(script)) { cb({ ok: false, reason: 'no-launcher', hint: '缺少 ' + script }); return; }
    st.busy = true; st.waiters = [cb];
    const done = (r) => {
      st.busy = false;
      const ws = st.waiters.slice(); st.waiters = [];
      for (const w of ws) { try { w(r); } catch (e) {} }
    };
    let child;
    try {
      child = spawn(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Project', ctx.id, '-NoWait'],
        { cwd: HUB_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { audit('serve-launch-error', { p: ctx.id, message: e.message }); done({ ok: false, reason: 'spawn-error', hint: e.message }); return; }
    let psOut = '';
    if (child.stdout) child.stdout.on('data', (d) => { psOut += String(d); });
    if (child.stderr) child.stderr.on('data', (d) => { psOut += String(d); });
    child.on('error', (e) => { audit('serve-launch-error', { p: ctx.id, message: e.message }); });
    audit('serve-launch', { p: ctx.id, port: Number(tkCfg(ctx).port) || 19000 });
    let tries = 0;
    const tick = () => {
      probeServe(ctx, (port2) => {
        if (port2) {
          ctx.tkCache = { port: port2, at: Date.now(), alive: true };
          audit('serve-launched', { p: ctx.id, port: port2 });
          done({ ok: true, port: port2, spawned: true });
          return;
        }
        if (++tries >= 90) {                     // ★ 实测（2026-11-18）：冷启 >31s（Start-Process + CLI 就绪）⇒ 90s 窗口
          audit('serve-launch-fail', { p: ctx.id, out: psOut.slice(0, 300) });
          done({ ok: false, reason: 'not-listening', hint: (psOut.trim().slice(0, 300) || ('端口 ' + (Number(tkCfg(ctx).port) || 19000) + ' 在 90s 内未监听')) });
          return;
        }
        setTimeout(tick, 1000);
      });
    };
    setTimeout(tick, 1200);                       // 给 Start-Process 一点时间再开始探
  });
}

// ══ ★ 2026-11-19：hub 侧 serve idle 回收 ══════════════════════════════════════
//  为什么 hub 自己写（2026-11-19 实测三重失效，qqbot 回收器对 hub 拉起的 serve 完全无覆盖）：
//   ① 文件不同：qqbot 的 serveInstanceFile = <root>/.codebuddy/skills/iteration-workflow/
//      runtime/serve-instance.json（watcher.contextDir 缺省值）；hub/start-serve.ps1 写的是
//      <root>/tools/qqbot/runtime/serve-instance.json ⇒ 两文件互不可见（实测两份并存、内容不同）。
//   ② 即便同文件也判不出来：start-serve.ps1 写 lastUsedAt=null 且无 startedAtMs ⇒ qqbot 的
//      idleMs = Date.now() - (lastUsedAt || startedAtMs) = NaN ⇒ `NaN > ttl` 恒 false ⇒ 永不回收。
//   ③ qqbot 的 ticker 只在 serve 接管时启动（ensureServeTicker ← handoffAliveWatch）⇒ 无接管时
//      根本没有回收循环在跑（service.log 最后一次 "[SERVE] ticker 启动" = 2026-10-12）。
//  ⇒ 口径：**谁写 lastUsedAt 谁负责回收**。hub 只碰自己那份 instance 文件，不动 qqbot 那份；
//    回收四条件全满足才杀：① 端口活且等于本文件登记端口 ② GET /api/v1/jobs 为空
//    （查询失败 ⇒ 放弃本轮，宁漏不误，同 qqbot orphanSweep 红线）③ 无未过期的 handoff RUNNING.json
//    ④ idle > serve.idleTtlMs。idle 基线缺失 ⇒ 不杀（fail-closed）。
const SERVE_REAP_DEFAULT = { idleTtlMs: 1800000, reapIntervalMs: 300000, reapEnabled: true };
const _reapTimers = new Map();                   // ctx.id → interval（防重复启动）

/** 项目自己的 serve 实例指针文件（与 start-serve.ps1 同路径） */
function serveInstFile(ctx) {
  return path.join(ctx.root, String(ctx.qq.serveInstanceFile || 'tools/qqbot/runtime/serve-instance.json'));
}
function readServeInst(ctx) {
  try { return JSON.parse(fs.readFileSync(serveInstFile(ctx), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return null; }
}
/** 原子写（tmp + rename；写失败不致命——回收判据一律 fail-closed） */
function writeServeInst(ctx, inst) {
  const fp = serveInstFile(ctx);
  const tmp = fp + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(inst, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} }
}
/** 真实使用打点：只并写 lastUsedAt（绝不覆盖 pid/port/startedAt；无实例文件则不造） */
function markServeUsed(ctx) {
  const inst = readServeInst(ctx);
  if (!inst || !inst.port) return;
  inst.lastUsedAt = Date.now();
  writeServeInst(ctx, inst);
}
function reapCfg(ctx) { return Object.assign({}, SERVE_REAP_DEFAULT, ctx.serve || {}); }
/** 接管锁：<root>/.codebuddy/temp/handoff/RUNNING.json（与 qqbot handoffLockFile 同路径同语义） */
function handoffLockActive(ctx) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ctx.root, '.codebuddy', 'temp', 'handoff', 'RUNNING.json'), 'utf8').replace(/^\uFEFF/, ''));
    return !!(j && j.expiresAt && Date.now() < Number(j.expiresAt));
  } catch (e) { return false; }
}
/** 端口 owner pid（netstat 解析；取不到返回 0）——仅用于「认领无 instance 文件的 serve」 */
function findPortPid(port, cb) {
  let out = '', child = null, done = false;
  const fin = (v) => { if (done) return; done = true; cb(v); };
  try { child = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { fin(0); return; }
  if (child.stdout) child.stdout.on('data', (d) => { out += String(d); if (out.length > 2 * 1024 * 1024) { try { child.kill(); } catch (e) {} } });
  child.on('error', () => fin(0));
  child.on('exit', () => {
    const m = new RegExp(':' + Number(port) + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i').exec(out);
    fin(m ? Number(m[1]) : 0);
  });
}
/** 认领：端口活着但实例文件缺失/漂移 ⇒ 现探 pid 补登记（同时修「/serve-direct 假死」） */
function adoptServeInst(ctx, port, cb) {
  cb = cb || (() => {});
  const cur = readServeInst(ctx);
  if (cur && Number(cur.port) === Number(port) && cur.pid) { cb(cur); return; }
  findPortPid(port, (sPid) => {
    if (!sPid) { cb(null); return; }
    const now = Date.now();
    const inst = {
      pid: sPid, port: Number(port), tier: 'A', project: ctx.id,
      startedAt: new Date(now).toISOString(), lastUsedAt: now, restartCount: 0, adopted: true,
    };
    writeServeInst(ctx, inst);
    audit('serve-adopt', { p: ctx.id, port: Number(port), pid: sPid });
    cb(inst);
  });
}
/** 活跃 job 数：查询失败 ⇒ ok:false（调用方 fail-closed，不杀） */
function serveActiveJobs(ctx, port, cb) {
  let done = false;
  const fin = (r) => { if (done) return; done = true; cb(r); };
  const up = http.request({
    host: '127.0.0.1', port: port, path: '/api/v1/jobs', method: 'GET',
    headers: takeoverHeaders(), timeout: 10000,
  }, (ur) => {
    let d = '';
    ur.on('data', (c) => { d += c; if (d.length > 4 * 1024 * 1024) { try { ur.destroy(); } catch (e) {} } });
    ur.on('error', () => fin({ ok: false, reason: 'response-error' }));
    ur.on('end', () => {
      if (ur.statusCode !== 200) { fin({ ok: false, reason: 'http-' + ur.statusCode }); return; }
      try {
        const j = JSON.parse(d);
        fin({ ok: true, count: ((j && j.data && j.data.jobs) || []).length });
      } catch (e) { fin({ ok: false, reason: 'bad-json' }); }
    });
  });
  up.on('error', (e) => fin({ ok: false, reason: 'unreachable:' + (e && e.message) }));
  up.on('timeout', () => { try { up.destroy(); } catch (e) {} fin({ ok: false, reason: 'timeout' }); });
  up.end();
}
/** 单轮回收判定（把 skipped 原因一路带出来，便于排查「为什么没杀」） */
function serveReapOnce(ctx, cb) {
  cb = cb || (() => {});
  const rc = reapCfg(ctx);
  if (!rc.reapEnabled) { cb({ ok: false, skipped: 'disabled' }); return; }
  probeServe(ctx, (port) => {
    if (!port) { cb({ ok: false, skipped: 'serve-down' }); return; }
    const judge = (inst) => {
      // 只回收「本文件登记端口」的实例：端口不符 ⇒ 不是 hub 的账，不碰
      if (!inst || Number(inst.port) !== Number(port) || !inst.pid) { cb({ ok: false, skipped: 'not-owner' }); return; }
      serveActiveJobs(ctx, port, (jr) => {
        if (!jr.ok) { audit('serve-reap-skip', { p: ctx.id, reason: 'jobs-query-failed:' + jr.reason }); cb({ ok: false, skipped: 'jobs-query-failed', detail: jr.reason }); return; }
        if (jr.count > 0) { cb({ ok: false, skipped: 'jobs-active', count: jr.count }); return; }
        if (handoffLockActive(ctx)) { cb({ ok: false, skipped: 'handoff-lock' }); return; }
        const base = Number(inst.lastUsedAt) || Number(inst.startedAtMs) || Date.parse(inst.startedAt) || 0;
        if (!base) { audit('serve-reap-skip', { p: ctx.id, reason: 'no-idle-baseline' }); cb({ ok: false, skipped: 'no-baseline' }); return; }
        const ttl = Number(rc.idleTtlMs) || 0;
        const idleMs = Date.now() - base;
        if (!(ttl > 0) || idleMs <= ttl) { cb({ ok: false, skipped: 'idle-under-ttl', idleMs: idleMs, ttlMs: ttl }); return; }
        audit('serve-reap', { p: ctx.id, port: port, pid: inst.pid, idleMin: Math.round(idleMs / 60000), ttlMin: Math.round(ttl / 60000) });
        try { spawn('taskkill', ['/T', '/F', '/PID', String(inst.pid)], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
        inst.stoppedAtMs = Date.now();
        inst.reapedAt = new Date().toISOString();
        writeServeInst(ctx, inst);
        ctx.tkCache = { port: 0, at: 0, alive: false };
        cb({ ok: true, reaped: true, pid: inst.pid, port: port, idleMs: idleMs });
      });
    };
    const inst = readServeInst(ctx);
    if (inst && Number(inst.port) === Number(port) && inst.pid) { judge(inst); return; }
    // 实例文件缺失/漂移：仅当端口 = 本项目配置端口时才认领（防认错别人的 serve）
    if (Number(port) !== Number(tkCfg(ctx).port)) { cb({ ok: false, skipped: 'port-mismatch', port: port }); return; }
    adoptServeInst(ctx, port, (ad) => {
      if (!ad) { cb({ ok: false, skipped: 'no-instance' }); return; }
      judge(ad);
    });
  });
}
/** 启动各项目回收定时器（listen 回调里调；单个项目异常不影响其他） */
function startServeReapers() {
  for (const ctx of CTX.values()) {
    const rc = reapCfg(ctx);
    if (!rc.reapEnabled) continue;
    if (_reapTimers.has(ctx.id)) continue;
    const ms = Math.max(30000, Number(rc.reapIntervalMs) || 300000);
    _reapTimers.set(ctx.id, setInterval(() => {
      try { serveReapOnce(ctx, () => {}); } catch (e) { audit('serve-reap-error', { p: ctx.id, message: e && e.message }); }
    }, ms));
  }
}
/** 启动时认领已在跑的 serve（无实例文件 ⇒ 补登记；顺带修 /serve-direct 的 no-instance 假死） */
function adoptAliveServes() {
  for (const ctx of CTX.values()) {
    try { probeServe(ctx, (port) => { if (port) adoptServeInst(ctx, port, () => {}); }); } catch (e) {}
  }
}
/** 通用 JSON 转发（防重入：error/timeout/end 三路只写一次响应）
 *  onResult（可选）：提供时调用方全权接管响应写出（本函数不再写 res），统一回调 once(upCode, rawText)；
 *  upCode=0 表示 serve-down/unreachable/timeout。
 *  ★ 2026-10-06 回归修正：end 分支必须透传上游原始 body（此前误走 json(res,code,null) ⇒ 旧调用方
 *    transcript/new/reply/stop 全部返回字面 "null"、丢上游 1573B 正文——实测复现后修复）。 */
function takeoverProxy(ctx, method, apiPath, bodyObj, timeoutMs, res, onResult) {
  takeoverPort(ctx, (port) => {
    if (!port) {
      if (onResult) { onResult(0, '{"error":"serve-down"}'); return; }
      json(res, 502, { error: 'serve-down', project: ctx.id, hint: 'serve 未运行（serve-instance.json 与 ' + tkCfg(ctx).port + ' 均探活失败）' }); return;
    }
    const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const headers = takeoverHeaders();
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    let done = false;
    const once = (code, obj) => {
      if (done) return; done = true;
      if (onResult) { onResult(code, JSON.stringify(obj)); return; }
      json(res, code, obj);
    };
    const up = http.request({ host: '127.0.0.1', port: port, path: apiPath, method: method, headers: headers, timeout: timeoutMs }, (ur) => {
      let d = '';
      ur.on('data', (c) => { d += c; if (d.length > 8 * 1024 * 1024) { try { ur.destroy(); } catch (e) {} } });
      ur.on('end', () => {
        if (done) return; done = true;
        // ★ 2026-11-19：成功拿到 serve 响应 ⇒ 记一次「真实使用」（idle 回收的唯一基线来源）
        if (ur.statusCode >= 200 && ur.statusCode < 300) markServeUsed(ctx);
        if (onResult) { onResult(ur.statusCode || 502, d); return; }
        try {
          res.writeHead(ur.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(d);
        } catch (e) {}
      });
    });
    up.on('error', (e) => once(502, { error: 'serve-unreachable', message: e.message }));
    up.on('timeout', () => { try { up.destroy(); } catch (e) {} once(504, { error: 'serve-timeout', ms: timeoutMs }); });
    if (payload) up.write(payload);
    up.end();
  });
}
/** SSE 透传（上游 pipe → 客户端；客户端断开即销毁上游） */
function takeoverStream(ctx, id, req, res) {
  if (!ID_RE.test(String(id || ''))) { json(res, 400, { error: 'bad-id' }); return; }
  takeoverPort(ctx, (port) => {
    if (!port) { json(res, 502, { error: 'serve-down' }); return; }
    let up;
    try {
      up = http.request({
        host: '127.0.0.1', port: port, method: 'GET',
        path: '/api/v1/jobs/' + encodeURIComponent(id) + '/stream',
        headers: Object.assign({ 'Accept': 'text/event-stream' }, takeoverHeaders()),
      }, (ur) => {
        try {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          markServeUsed(ctx);                                          // ★ 2026-11-19：订阅流也算真实使用
          ur.on('error', () => { try { res.end(); } catch (e) {} });   // ★ response 流 error 必须接住（v3 崩溃教训同源）
          ur.pipe(res);
        } catch (e) { try { up.destroy(); } catch (e2) {} }
      });
    } catch (e) { json(res, 502, { error: 'serve-unreachable', message: e.message }); return; }
    up.on('error', () => { try { res.end(); } catch (e) {} });
    req.on('close', () => { try { up.destroy(); } catch (e) {} });
    up.end();
  });
}

// ── provider 层（★ v3，2026-10-04 深夜）：统一多工具会话源 ────────────────
//   codebuddy：serve Jobs API（活跃）+ ~/.codebuddy/jobs/<id>/state.json（历史，只有元数据无 transcript）
//   claude   ：~/.claude/projects/<slug>/<uuid>.jsonl 直读（2026-10-04 实测：type=user/assistant 行，
//              message.content[] 标准格式；isSidechain 为 subagent 内部流须跳过）——只读回放
const JOBS_DIR = path.join(os.homedir(), '.codebuddy', 'jobs');
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

/** DeepSeek/CodeBuddy 式默认命名：取首条用户消息，去标签/Markdown 符号、折叠空白、截 20 字（2026-10-05）
 *  ★ 2026-10-11 第二轮：maxLen 可选（hub /takeover/new 默认名 = "MM-DD HH:mm 摘要"，摘要限 16 字） */
function deriveTitle(raw, fallback, maxLen) {
  let t = String(raw || '')
    .replace(/<[^>]{0,120}>/g, ' ')            // 去除 <ide_opened_file>…</ide_opened_file> 等标签
    .replace(/[#*`_>~\[\]()"']/g, ' ')         // 去 Markdown/引号符号
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) t = String(fallback || '');
  if (!t) return '(未命名会话)';
  const lim = Number(maxLen) > 0 ? Number(maxLen) : 20;
  return t.length > lim ? t.slice(0, lim) + '…' : t;
}

/** ★ 多项目：job 归属判定 —— state.json 的 cwd 必须在项目根之内（大小写不敏感、防前缀误伤） */
function inProject(cwd, root) {
  if (!cwd) return false;
  try {
    const a = path.resolve(String(cwd)).toLowerCase().replace(/[\\/]+$/, '');
    const b = path.resolve(String(root)).toLowerCase().replace(/[\\/]+$/, '');
    return a === b || a.startsWith(b + path.sep.toLowerCase()) || a.startsWith(b + '/');
  } catch (e) { return false; }
}
/** 读某个 job 的 state.json（跨项目操作前校验用；不存在 ⇒ null） */
function jobStateOf(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, id, 'state.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return null; }
}
function scanJobHistory(ctx, liveIds) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(JOBS_DIR).filter((f) => ID_RE.test(f)); } catch (e) { return out; }
  for (const d of dirs) {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, d, 'state.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { continue; }
    if (!st || !st.shortId) continue;
    if (!inProject(st.cwd, ctx.root)) continue;              // ★ 多项目隔离：别项目 / 临时目录的 job 不列（防点开跨项目 reply）
    out.push({
      provider: 'codebuddy',
      id: st.shortId,
      // ★ 2026-10-11：name 为空则置空（前端 dispName 回落 title）—— 原 "(未命名)" 占位会盖过可读的 title
      name: st.name || '',
      title: deriveTitle(st.intent || st.initialPrompt || '', st.name || ''),
      state: st.state || 'unknown',
      detail: st.detail || '',
      needs: st.needs || '',
      intent: st.intent || st.initialPrompt || '',
      startedAt: st.createdAt ? Date.parse(st.createdAt) : null,
      updatedAt: st.updatedAt ? Date.parse(st.updatedAt) : null,
      live: !!(liveIds && liveIds.indexOf(st.shortId) >= 0),
    });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

/** ★ 2026-11-19：一次头读拿 标题 + cwd + entrypoint —— 原实现只取标题，导致「项目归属不可知」
 *  被写成硬限制（README「slug 不可靠」）。实测每行都带 cwd（首条 user/assistant 行即项目根）
 *  ⇒ 归属其实可靠，不必依赖 slug 反解。 */
function claudeHeadMeta(fp) {
  const out = { title: '', cwd: '', entrypoint: '' };
  try {
    const size = fs.statSync(fp).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(fp, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      let o = null; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o) continue;
      if (!out.cwd && o.cwd) out.cwd = String(o.cwd);
      if (!out.entrypoint && o.entrypoint) out.entrypoint = String(o.entrypoint);
      if (!out.title && o.type === 'user' && !o.isSidechain && o.message && Array.isArray(o.message.content)) {
        const txt = o.message.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join(' ').trim();
        if (txt) out.title = txt.slice(0, 60);
      }
      if (out.title && out.cwd) break;
    }
  } catch (e) {}
  return out;
}
/** ★ 2026-11-19：尾读 64KB 取最后一条真实 assistant 型号。
 *  `<synthetic>` = CLI 本地合成行（API 错误/系统注入），不是模型 ⇒ 必须跳过，
 *  否则「有会话但显示 synthetic」会被误读成"拿不到型号"。 */
function claudeLastModel(fp) {
  try {
    const size = fs.statSync(fp).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(fp, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let o = null; try { o = JSON.parse(line); } catch (e) { continue; }   // 首行常被截断 ⇒ 跳过
      const m = (o && o.type === 'assistant' && o.message && o.message.model) ? String(o.message.model) : '';
      if (m && m !== '<synthetic>') return m;
    }
  } catch (e) {}
  return '';
}
/** cwd → 目录名（侧栏不展示整条绝对路径） */
function dirBaseName(p) {
  try { return path.basename(path.resolve(String(p))); } catch (e) { return ''; }
}

function scanClaudeSessions(limit) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(CLAUDE_DIR).filter((f) => f.charAt(0) !== '.'); } catch (e) { return out; }
  for (const proj of projects) {
    const pdir = path.join(CLAUDE_DIR, proj);
    let files = [];
    try { files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch (e) { continue; }
    for (const f of files) {
      const fp = path.join(pdir, f);
      let mtimeMs = 0, size = 0;
      try { const stt = fs.statSync(fp); mtimeMs = stt.mtimeMs; size = stt.size; } catch (e) { continue; }
      if (size < 256) continue;                          // 空会话/近空跳过
      out.push({ provider: 'claude', id: f.replace(/\.jsonl$/, ''), project: proj, mtimeMs: mtimeMs, size: size, title: '', path: fp });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = out.slice(0, limit || 25);
  for (const it of top) {
    const head = claudeHeadMeta(it.path);
    it.title = deriveTitle(head.title, '');
    it.cwd = head.cwd;
    it.projName = dirBaseName(head.cwd);                 // ★ 归属：项目根目录名（无 cwd 则空）
    it.entrypoint = head.entrypoint;                     // claude-vscode / cli …（判断会话来源）
    it.model = claudeLastModel(it.path);                 // ★ 真实型号（已滤 <synthetic>），取不到为空
  }
  return top;
}

function takeoverOverview(ctx, res) {
  takeoverPort(ctx, (port) => {
    let done = false;                                     // ★ 防重入：error/timeout/end 多路径只 build 一次（2026-10-04 崩溃教训：双写响应 → uncaughtException → hub 退出）
    const build = (liveIds) => {
      if (done) return;
      done = true;
      json(res, 200, {
        project: ctx.id,                                  // ★ 多项目：前端可断言数据归属
        serve: { alive: !!port, port: port || null },
        groups: [
          { provider: 'codebuddy', label: 'CodeBuddy', items: scanJobHistory(ctx, liveIds) },
          // P1 决策保留全局只读（不按项目过滤，避免历史会话消失）；★ 2026-11-19：slug 不可靠的限制
          // 已绕开 —— 每项自带 cwd 派生的 projName + 真实 model，由侧栏/头部展示，误读风险已消除。
          { provider: 'claude', label: 'Claude Code（只读·全局，标注项目/型号）', items: scanClaudeSessions(25) },
        ],
      });
    };
    if (!port) { build(null); return; }
    const up = http.request({ host: '127.0.0.1', port: port, path: '/api/v1/jobs', method: 'GET', headers: takeoverHeaders(), timeout: 8000 }, (ur) => {
      let d = '';
      ur.on('data', (c) => { d += c; });
      ur.on('error', () => build(null));                  // response 流 error 也必须接住
      ur.on('end', () => {
        let liveIds = null;
        try { const j = JSON.parse(d); liveIds = ((j.data && j.data.jobs) || []).map((x) => x.id); } catch (e) {}
        build(liveIds);
      });
    });
    up.on('error', () => build(null));
    up.on('timeout', () => { try { up.destroy(); } catch (e) {} build(null); });
    up.end();
  });
}

/** Claude JSONL → 统一 updates 格式（user/assistant/tool_use 映射；system/attachment/queue 等跳过） */
function claudeTranscript(id, res) {
  if (!ID_RE.test(String(id || ''))) { json(res, 400, { error: 'bad-id' }); return; }
  let hit = null;
  try {
    for (const proj of fs.readdirSync(CLAUDE_DIR)) {
      const fp = path.join(CLAUDE_DIR, proj, id + '.jsonl');
      let ok = false;
      try { ok = fs.statSync(fp).isFile(); } catch (e) { ok = false; }
      if (ok) { hit = fp; break; }
    }
  } catch (e) {}
  if (!hit) { json(res, 404, { error: 'claude-session-not-found' }); return; }
  let lines = [];
  try { lines = fs.readFileSync(hit, 'utf8').split(/\r?\n/); } catch (e) { json(res, 500, { error: 'read-failed', message: e.message }); return; }
  const updates = [];
  let seq = 0;
  for (const line of lines) {
    if (!line || line.length > 2 * 1024 * 1024) continue;
    let o = null; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || o.isSidechain) continue;                     // subagent 内部流不入主时间线
    if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
      const txt = o.message.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n').trim();
      if (txt) updates.push({ sessionUpdate: 'user_message_chunk', messageId: o.uuid || ('u' + (++seq)), content: { type: 'text', text: txt }, _meta: { timestamp: o.timestamp } });
    } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      let buf = '';
      const flush = () => {
        if (buf.trim()) updates.push({ sessionUpdate: 'agent_message_chunk', messageId: o.uuid || ('a' + (++seq)), content: { type: 'text', text: buf }, _meta: { timestamp: o.timestamp } });
        buf = '';
      };
      for (const c of o.message.content) {
        if (c && c.type === 'text') buf += (c.text || '');
        else if (c && c.type === 'tool_use') { flush(); updates.push({ sessionUpdate: 'tool_call', toolCallId: c.id || '', title: c.name || 'tool', status: 'completed', rawInput: c.input || null, _meta: { timestamp: o.timestamp } }); }
      }
      flush();
    }
  }
  json(res, 200, { data: { provider: 'claude', updates: updates } });
}

// ── HTTP 服务 ─────────────────────────────────────────────────────────────
function readBody(req, cb) {
  // ★ 2026-10-05 加固：Buffer 收集后统一 utf8 解码 —— 原 `d += c` 在多 chunk 时
  //   会把跨包截断的 UTF-8 多字节字符（中文 3 字节）拆坏成乱码。
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(''));
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

// ── 只读文档视图（P1 · 2026-10-06）：/doc/list + /doc —— 仅读 docs/iterations/** ──
// 安全口径（SSOT: 项目管理/PIVAS-阶段产物外网阅读方案评估（hub只读视图+公网穿透）.md §4.2）：
//   ① 白名单根 docs/iterations + realpath 穿越防护（拒绝对绝对路径/.. /白名单外）
//   ② 后缀白名单 .md/.txt  ③ 2MB 上限  ④ 纯 GET 无口令（不进 writeAuth，与写端点隔离）
//   ⑤ 全部访问（含被拒）记 hub-audit.jsonl
// XSS 信任边界：md 正文来自本机 agent 产出的内部文档（非外部用户输入），marked 渲染不消毒——
//   若未来 /doc 面向不可信内容，须先加 DOMPurify。
// ★ 多项目：doc 根 / docKey / extra 白名单 / ACTIVE 文件位置全部 per-ctx（buildCtx 内构造）
const DOC_MAX_BYTES = 2 * 1024 * 1024;
const DOC_EXT_OK = new Set(['.md', '.txt']);
// ── 搭车 Story（2026-10-07，迭代 2026-10-07-002）：raw 直出通道 ──
// ★ 后缀白名单分层：DOC_EXT_OK（列表枚举 + marked 渲染）保持 .md/.txt 不动；
//   DOC_RAW_EXT_OK 仅 raw=1 通道使用（.html 只能 raw 直出，防误入 marked 渲染管线）。
const DOC_RAW_EXT_OK = new Set(['.md', '.txt', '.html']);
const DOC_CSS = 'body{max-width:860px;margin:0 auto;padding:12px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.65;color:#222;word-wrap:break-word}'
  + 'table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border:1px solid #ccc;padding:5px 8px;font-size:13px}'
  + 'code{background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:13px}pre{background:#f6f8fa;padding:10px;overflow-x:auto;border-radius:4px}pre code{background:none}'
  + 'h1,h2,h3{line-height:1.3}blockquote{border-left:3px solid #bbb;margin:0;padding-left:10px;color:#555}'
  + '.meta{color:#888;font-size:12px;margin:8px 0}.it{font-size:13px;color:#666;margin-top:14px;border-bottom:1px solid #eee}a{word-break:break-all}';
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/**
 * ★ 修 R1（2026-10-07）：不再要求 `docs/iterations/<ID>` 目录存在。
 *   缺口（实测 2026-10-07 #3 立项拍板）：迭代刚立项（01 起步、文档目录未建）时旧实现返回 '' ⇒
 *   列表页显示「（当前无活跃迭代）」，与 QQ 消息文案「（列表页·★当前迭代）」自相矛盾。
 *   口径对齐 qqbot 侧 readActiveIterationId（只读 ACTIVE 首行、显式判 none、剥 BOM）。
 */
function readActiveIteration(ctx) {
  try {
    const line = fs.readFileSync(ctx.activeFile, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim();
    return (line && line !== 'none') ? line : '';
  } catch (e) { return ''; }
}
/** docKey 校验（P2-加固·方案B）：配置了 doc.key 则 query 必须携带；未配置 = 校验关闭（本地直连兼容） */
function docKeyOk(ctx, u, res) {
  if (!ctx.docKey) return true;
  if (u.searchParams.get('key') === ctx.docKey) return true;
  audit('doc-reject', { p: ctx.id, why: 'bad-or-missing docKey', path: u.pathname });
  json(res, 403, { error: 'docKey required' });
  return false;
}
/** 穿越防护核心：返回 {abs,rel,size} 或 {code,why} */
function docResolve(ctx, rel, rawMode) {
  const raw = String(rel || '').trim();
  if (!raw) return { code: 400, why: 'missing path' };
  if (raw.includes('\0')) return { code: 400, why: 'bad path' };
  if (/^([a-zA-Z]:)?[\\/]/.test(raw)) return { code: 400, why: 'absolute path rejected' };
  // ★ 搭车 Story：extra 精确白名单（基准切 ctx.root）；rawMode 决定后缀白名单档位
  const norm = raw.replace(/\\/g, '/');
  const isExtra = ctx.docExtra.has(norm);
  const base = isExtra ? ctx.root : ctx.docRoot;
  const extOk = rawMode ? DOC_RAW_EXT_OK : DOC_EXT_OK;
  if (path.extname(norm).toLowerCase() === '.html' && !rawMode) return { code: 400, why: 'html-needs-raw (append &raw=1)' };
  let real, baseReal;
  try {
    real = fs.realpathSync(path.join(base, norm));   // path.join 已忽略 raw 前导 ..? 否——join 不清洗，realpath 才是权威防线
    baseReal = fs.realpathSync(base);
  } catch (e) { return { code: 404, why: 'not found' }; }
  const withSep = baseReal.endsWith(path.sep) ? baseReal : baseReal + path.sep;
  if (real !== baseReal && !real.startsWith(withSep)) return { code: 403, why: 'outside doc root' };
  if (!extOk.has(path.extname(real).toLowerCase())) return { code: 403, why: 'extension not allowed' };
  let st;
  try { st = fs.statSync(real); } catch (e) { return { code: 404, why: 'not found' }; }
  if (!st.isFile()) return { code: 403, why: 'not a file' };
  if (st.size > DOC_MAX_BYTES) return { code: 413, why: 'file too large (>2MB)' };
  return { abs: real, rel: isExtra ? norm : path.relative(baseReal, real), size: st.size, extra: isExtra };
}
/** ★ 搭车 Story（2026-10-07）：raw 通道内链接重写 —— 生成物相对链接 → hub 路由；未命中保持原样（fail-open） */
function rewriteDocLinks(ctx, text) {
  const key = ctx.docKey ? '&key=' + encodeURIComponent(ctx.docKey) : '';
  let out = String(text || '');
  for (const m of (ctx.linkRewrite || [])) {
    const href = pfx(ctx, '/doc') + '?path=' + encodeURIComponent(m.to) + '&raw=1' + key;
    out = out.split("'" + m.from + "'").join("'" + href + "'").split('"' + m.from + '"').join('"' + href + '"');
  }
  return out;
}
function docLink(ctx, relUnderIter, iterName) {
  const full = iterName + '/' + relUnderIter;
  const k = ctx.docKey ? '&key=' + encodeURIComponent(ctx.docKey) : '';
  return '<div><a href="' + pfx(ctx, '/doc') + '?path=' + encodeURIComponent(full) + k + '">' + escapeHtml(relUnderIter) + '</a></div>';
}
function docListHtml(ctx) {
  const active = readActiveIteration(ctx);
  let iters = [];
  try {
    iters = fs.readdirSync(ctx.docRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name)
      .filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n)).sort().reverse();
  } catch (e) {}
  // ★ 修 R1（2026-10-07）：当前迭代已立项但文档目录未建（01 起步期）⇒ 列表尚无该项，补「尚无文档」标注
  //   + 首行占位，使 QQ 消息文案「（列表页·★当前迭代）」在任何阶段都兑现。
  const hasDir = !!active && fs.existsSync(path.join(ctx.docRoot, active));
  const p = [];
  p.push('<h2>' + escapeHtml(ctx.docTitle) + '（只读）</h2>');
  p.push('<div class="meta">项目：<b>' + escapeHtml(ctx.name) + '</b>（' + escapeHtml(ctx.id) + '）· 路径 ' + escapeHtml(ctx.root) + '</div>');
  // ★ 搭车 Story（2026-10-07）：顶部固定入口 —— 看板（raw 直出）+ 根级总览/索引（存在才渲染，无死链）
  const kq = ctx.docKey ? '&key=' + encodeURIComponent(ctx.docKey) : '';
  if (fs.existsSync(path.join(ctx.docRoot, 'board.html'))) {
    p.push('<div class="it">📊 迭代看板（执行视图）</div>');
    p.push('<div><a href="' + pfx(ctx, '/doc') + '?path=board.html&raw=1' + kq + '">board.html</a></div>');
  }
  const rootDocs = ['BOARD.md', 'INDEX.md', 'README.md'].filter((f) => { try { return fs.statSync(path.join(ctx.docRoot, f)).isFile(); } catch (e) { return false; } });
  if (rootDocs.length) {
    p.push('<div class="it">📄 迭代总览 / 索引</div>');
    for (const f of rootDocs) p.push('<div><a href="' + pfx(ctx, '/doc') + '?path=' + encodeURIComponent(f) + kq + '">' + escapeHtml(f) + '</a></div>');
  }
  p.push('<div class="meta">' + (active ? '当前迭代：<b>' + escapeHtml(active) + '</b>' + (hasDir ? '' : '（尚无文档）') : '（当前无活跃迭代）') + ' · 共 ' + iters.length + ' 个迭代</div>');
  if (active && !hasDir) p.push('<div class="it">' + escapeHtml(active) + ' ★当前（尚无文档）</div>');
  for (const it of iters) {
    const root = path.join(ctx.docRoot, it);
    p.push('<div class="it">' + escapeHtml(it) + (it === active ? ' ★当前' : '') + '</div>');
    try {
      for (const f of fs.readdirSync(root).filter((f) => DOC_EXT_OK.has(path.extname(f).toLowerCase()) && fs.statSync(path.join(root, f)).isFile())) {
        p.push(docLink(ctx, f, it));
      }
    } catch (e) {}
    let subs = [];
    try {
      subs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{2}-/.test(d.name)).map((d) => d.name).sort();
    } catch (e) {}
    for (const sub of subs) {
      let mds = [];
      try { mds = fs.readdirSync(path.join(root, sub)).filter((f) => DOC_EXT_OK.has(path.extname(f).toLowerCase())); } catch (e) {}
      for (const f of mds) p.push(docLink(ctx, sub + '/' + f, it));
    }
  }
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(ctx.docTitle) + '</title><style>' + DOC_CSS + '</style></head><body>' + p.join('') + '</body></html>';
}
/** 整篇 md → 手机适配 HTML（浏览器端 marked 渲染；CDN 失败降级原文 pre） */
function docHtml(ctx, rel, md) {
  const cdnA = 'https://registry.npmmirror.com/marked/12.0.2/files/lib/marked.umd.js';
  const cdnB = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.umd.js';
  const mdJson = JSON.stringify(md).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const script =
    'var md=' + mdJson + ';var c=document.getElementById("c");'
    + 'function raw(){c.innerHTML="<pre>"+md.replace(/[&<>]/g,function(x){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[x]})+"</pre>";}'
    + 'try{if(window.marked&&marked.parse){c.innerHTML=marked.parse(md)}else{raw()}}catch(e){raw()}';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml(rel) + '</title><style>' + DOC_CSS + '</style></head><body>'
    + '<div class="meta"><a href="' + pfx(ctx, '/doc/list') + (ctx.docKey ? '?key=' + encodeURIComponent(ctx.docKey) : '') + '">← 文档列表</a> ｜ ' + escapeHtml(rel) + '</div>'
    + '<div id="c">加载渲染器…</div>'
    + '<script src="' + cdnA + '"><\/script>'
    + '<script>window.marked||document.write(\'<script src="' + cdnB + '"><\\/script>\')<\/script>'
    + '<script>' + script + '<\/script></body></html>';
}

let stopping = false;
function gracefulStop(reason) {
  if (stopping) return;
  stopping = true;
  audit('shutdown', { reason: String(reason || '').slice(0, 60) });
  setTimeout(() => process.exit(0), 200);
}

/** 会话归属校验：条目无 project（迁移前历史）⇒ 归缺省项目；有则必须相等 */
function sessionIn(ctx, s) {
  if (!s) return false;
  if (!s.project) return ctx.id === DEFAULT_CTX.id;
  return s.project === ctx.id;
}
function sessionsOf(ctx) { return listSessions().filter((s) => sessionIn(ctx, s)); }

const server = http.createServer((req, res) => {
  if (stopping) { res.writeHead(503); res.end('stopping'); return; }
  let u;
  try { u = new URL(req.url, 'http://127.0.0.1:' + PORT); } catch (e) { res.writeHead(400); res.end(); return; }
  const pn0 = u.pathname;

  // 优雅停止（仅回环；stop-hub.ps1 调用）—— 全局端点，先于项目解析
  if (req.method === 'POST' && pn0 === '/shutdown') {
    const ra = String(req.socket.remoteAddress || '');
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ra)) { json(res, 403, { ok: false, error: 'loopback-only' }); return; }
    json(res, 200, { ok: true, stopping: true, reason: u.searchParams.get('reason') || 'manual-stop' });
    gracefulStop(u.searchParams.get('reason'));
    return;
  }

  // ★ 多项目：/p/<id>/… 前缀 > ?p=<id> > 缺省项目；未知 id ⇒ 404（绝不静默回落，防串台）
  const ctx = resolveCtx(u);
  if (!ctx) {
    json(res, 404, { error: 'unknown-project', hint: '未知项目 id（/p/<id>/… 或 ?p=<id>）', projects: [...CTX.keys()] });
    return;
  }
  const pn = stripPrefix(pn0);

  // 单页
  if (req.method === 'GET' && (pn === '/' || pn === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(HUB_DIR, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(500); res.end('index.html missing'); }
    return;
  }
  if (req.method === 'GET' && pn === '/health') {
    const mine = sessionsOf(ctx);
    json(res, 200, {
      ok: true, name: 'session-hub', port: PORT,
      project: ctx.id, projectName: ctx.name, root: ctx.root,
      uptimeSec: Math.round((Date.now() - BOOT_AT) / 1000),
      sessions: mine.length,
      running: mine.filter((s) => s.status === 'running').length,
      keyConfigured: !!ctx.httpKey,
      qq: ctx.qq.origin,
      projects: [...CTX.values()].map((c) => ({
        id: c.id, name: c.name, root: c.root, qq: c.qq.origin,
        docKeyConfigured: !!c.docKey, keyConfigured: !!c.httpKey,
        default: c.id === DEFAULT_CTX.id,
      })),
    });
    return;
  }
  if (req.method === 'GET' && pn === '/projects') {
    json(res, 200, { default: DEFAULT_CTX.id, projects: [...CTX.values()].map((c) => ({
      id: c.id, name: c.name, root: c.root, qq: c.qq.origin, default: c.id === DEFAULT_CTX.id,
    })) });
    return;
  }
  if (req.method === 'GET' && pn === '/sessions') { json(res, 200, sessionsOf(ctx)); return; }
  if (req.method === 'GET' && pn === '/session') {
    const s = readSession(u.searchParams.get('id'));
    if (!sessionIn(ctx, s)) { json(res, 404, { error: 'session-not-found' }); return; }
    const rp = replayText(s);
    json(res, 200, Object.assign({ entry: s }, rp, { dialogs: sessionDialogs(ctx, s.id) }));   // ★ v2②：附带关联问答
    return;
  }
  if (req.method === 'GET' && pn === '/stream') {
    const s0 = readSession(u.searchParams.get('id'));
    if (!sessionIn(ctx, s0)) { json(res, 404, { error: 'session-not-found' }); return; }
    const anchor = req.headers['last-event-id'] != null ? Number(req.headers['last-event-id']) : Number(u.searchParams.get('offset') || 0);
    startStream(req, res, u.searchParams.get('id'), anchor);
    return;
  }
  if (req.method === 'GET' && pn === '/serve-direct') {
    serveDirect(ctx, (r) => json(res, 200, r));                                 // 修订②：渲染期现读口令
    return;
  }
  // ── 只读文档视图（P1）──────────────────────────────────────────────
  if (req.method === 'GET' && pn === '/doc/list') {
    if (!docKeyOk(ctx, u, res)) return;
    audit('doc-list', { p: ctx.id });
    html(res, 200, docListHtml(ctx));
    return;
  }
  // ★ 搭车 Story（2026-10-07）：/board 短链 → 302 到看板 raw 直出（服务端拼 key）
  if (req.method === 'GET' && pn === '/board') {
    if (!docKeyOk(ctx, u, res)) return;
    audit('doc-board', { p: ctx.id });
    res.writeHead(302, { Location: pfx(ctx, '/doc') + '?path=board.html&raw=1' + (ctx.docKey ? '&key=' + encodeURIComponent(ctx.docKey) : '') });
    res.end();
    return;
  }
  if (req.method === 'GET' && pn === '/doc') {
    if (!docKeyOk(ctx, u, res)) return;
    const rel = u.searchParams.get('path');
    const rawMode = u.searchParams.get('raw') === '1';
    const r = docResolve(ctx, rel, rawMode);
    if (!r.abs) {
      audit('doc-reject', { p: ctx.id, path: String(rel || '').slice(0, 200), why: r.why, code: r.code });
      json(res, r.code, { error: r.why });
      return;
    }
    if (rawMode) {                       // ★ 原样直出（.html 链接重写；.md/.txt 原文）
      try {
        let body = fs.readFileSync(r.abs, 'utf8');
        if (path.extname(r.abs).toLowerCase() === '.html') body = rewriteDocLinks(ctx, body);
        const ctype = (path.extname(r.abs).toLowerCase() === '.html' ? 'text/html' : 'text/plain') + '; charset=utf-8';
        res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(body);
        audit('doc-read', { p: ctx.id, path: r.rel, bytes: r.size, raw: true });
      } catch (e) { json(res, 500, { error: 'read-failed', message: e.message }); }
      return;
    }
    try {
      const md = fs.readFileSync(r.abs, 'utf8');
      audit('doc-read', { p: ctx.id, path: r.rel, bytes: r.size });
      html(res, 200, docHtml(ctx, r.rel, md));
    } catch (e) { json(res, 500, { error: 'read-failed', message: e.message }); }
    return;
  }
  if (req.method === 'GET' && pn === '/proxy/qq/health') { proxyQq(ctx, '/health', false, (r) => json(res, 200, r)); return; }
  if (req.method === 'GET' && pn === '/proxy/qq/pending') { proxyQq(ctx, '/pending', true, (r) => json(res, 200, r)); return; }   // 修订⑮：带 key
  if (req.method === 'GET' && pn === '/proxy/qq/answers') { json(res, 200, answersList(ctx)); return; }
  if (req.method === 'GET' && pn === '/proxy/qq/logtail') { json(res, 200, { lines: logTail(ctx) }); return; }
  if (req.method === 'GET' && pn === '/dialog') { dialogFlow(ctx, (r) => json(res, 200, r)); return; }   // ★ v2①：对话流
  if (req.method === 'GET' && pn === '/audit') {
    let lines = [];
    try { lines = fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean).slice(-20); } catch (e) {}
    json(res, 200, { lines: lines });
    return;
  }

  // 写操作：四重防护
  if (req.method === 'POST' && pn === '/spawn') {
    if (writeAuth(req, res, u, ctx)) return;
    readBody(req, (d) => {
      let body;
      try { body = JSON.parse(d || '{}'); } catch (e) { json(res, 400, { error: 'bad-json' }); return; }
      spawnSession(ctx, body, res);
    });
    return;
  }
  if (req.method === 'POST' && pn === '/kill') {
    if (writeAuth(req, res, u, ctx)) return;
    const s0 = readSession(u.searchParams.get('id'));
    if (!sessionIn(ctx, s0)) { json(res, 404, { error: 'session-not-found' }); return; }
    killSession(u.searchParams.get('id'), res);
    return;
  }
  if (req.method === 'POST' && pn === '/input') {                    // ★ v2③：会话 stdin 注入
    if (writeAuth(req, res, u, ctx)) return;
    readBody(req, (d) => {
      let body = {};
      try { body = JSON.parse(d || '{}'); } catch (e) {}
      const data = (body && typeof body.data === 'string') ? body.data : u.searchParams.get('data');
      const s0 = readSession(u.searchParams.get('id'));
      if (!sessionIn(ctx, s0)) { json(res, 404, { error: 'session-not-found' }); return; }
      inputSession(u.searchParams.get('id'), data, res);
    });
    return;
  }
  if (req.method === 'POST' && pn === '/qq-reply') {                 // ★ 方案 A：回复/确认 QQ 待确认项
    if (writeAuth(req, res, u, ctx)) return;
    readBody(req, (d) => {
      let body = {};
      try { body = JSON.parse(d || '{}'); } catch (e) {}
      qqReply(ctx, body, res);
    });
    return;
  }

  // ── takeover 代理（★ 2026-10-04）：读操作无 key（口令在服务端），写操作四重防护 ──
  if (req.method === 'GET' && pn === '/takeover/status') {
    takeoverPort(ctx, (port) => json(res, 200, { alive: !!port, port: port || null, project: ctx.id }));
    return;
  }
  // ★ 2026-11-18：CLI 模型清单（全局 —— 同一 CLI 安装，不随项目变；只读端点无需 key）
  if (req.method === 'GET' && pn === '/takeover/models') {
    const force = String(u.searchParams.get('force') || '') === '1';
    getModelList(force, (r) => json(res, 200, Object.assign({ project: ctx.id }, r)));
    return;
  }
  // ★ 2026-11-19：手动触发一次 serve 回收判定（与定时器同一函数；返回 skipped 原因便于排查"为什么没杀"）
  if (req.method === 'POST' && pn === '/serve-reap') {
    if (writeAuth(req, res, u, ctx)) return;
    serveReapOnce(ctx, (r) => json(res, 200, Object.assign({ project: ctx.id }, r)));
    return;
  }
  if (req.method === 'GET' && pn === '/takeover/jobs') { takeoverProxy(ctx, 'GET', '/api/v1/jobs', null, 20000, res); return; }   // ★ job working 时上游慢（实测 504@8s），放宽
  if (req.method === 'GET' && pn === '/takeover/job') {
    const id = String(u.searchParams.get('id') || '');
    if (!ID_RE.test(id)) { json(res, 400, { error: 'bad-id' }); return; }
    takeoverProxy(ctx, 'GET', '/api/v1/jobs/' + encodeURIComponent(id), null, 20000, res);
    return;
  }
  if (req.method === 'GET' && pn === '/takeover/transcript') {
    const id = String(u.searchParams.get('id') || '');
    const provider = String(u.searchParams.get('provider') || 'codebuddy');
    if (!ID_RE.test(id)) { json(res, 400, { error: 'bad-id' }); return; }
    if (provider === 'claude') { claudeTranscript(id, res); return; }      // v3：Claude JSONL 直读映射（全局，见 overview 标注）
    takeoverProxy(ctx, 'GET', '/api/v1/jobs/' + encodeURIComponent(id) + '/transcript', null, 25000, res);
    return;
  }
  if (req.method === 'GET' && pn === '/takeover/overview') { takeoverOverview(ctx, res); return; }   // v3：统一多工具列表
  if (req.method === 'POST' && pn === '/takeover/new') {                                            // v3：新建会话
    if (writeAuth(req, res, u, ctx)) return;
    readBody(req, (d) => {
      let b = {}; try { b = JSON.parse(d || '{}'); } catch (e) {}
      const prompt = String((b && b.prompt) || '').trim();
      if (!prompt || prompt.length > 8000) { json(res, 400, { error: 'bad-prompt', hint: 'prompt(1..8000) 必填' }); return; }
      // ★ 2026-10-05：job 创建带 permissionMode —— acceptEdits 只放行编辑类，WebFetch/Bash 会卡审批
      //   （实证：4c59f403 blocked on WebFetch）。bypassPermissions 跳过常规提示，HIGH/CRITICAL 仍询问
      //   （CLI help: -y 描述）；枚举见 --permission-mode help。可经 hub.config.json serve.jobPermissionMode 覆盖。
      // ★ 2026-10-11 第二轮（用户拍板）：默认名 = 「MM-DD HH:mm 任务摘要」（日期在前；摘要取自用户输入 prompt）
      //   与 qqbot buildJobName 命名口径一致 —— 便于在 CodeBuddy 智能体列表 / hub 中按主题查找
      // ★ 2026-11-18：模型（可选）—— 逐 job 下发，serve 不换型不重启。
      //   给了就必须在 CLI 支持清单内（CLI 对错名静默接受 ⇒ 只能在此硬校验）；
      //   清单暂不可用时放行但在 audit 标注 unverified（空值 = CLI 默认，不传字段）。
      const model = String((b && b.model) || '').trim();
      if (model && !MODEL_RE.test(model)) { json(res, 400, { error: 'bad-model', model: model, hint: '模型名仅允许字母/数字/._:-（1..64）' }); return; }
      const proceed = (modelState) => {
        const _d0 = new Date(), _p0 = (n) => (n < 10 ? '0' : '') + n;
        const _stamp = _p0(_d0.getMonth() + 1) + '-' + _p0(_d0.getDate()) + ' ' + _p0(_d0.getHours()) + ':' + _p0(_d0.getMinutes());
        const tk = tkCfg(ctx);
        const body = { prompt: prompt, name: String((b && b.name) || '').slice(0, 60) || (_stamp + ' ' + deriveTitle(prompt, 'webui', 16)), cwd: String((b && b.cwd) || ctx.root), permissionMode: tk.jobPermissionMode };
        if (model) body.model = model;
        audit('takeover-new', { p: ctx.id, name: body.name, chars: prompt.length, head: prompt.slice(0, 60), mode: tk.jobPermissionMode, model: model || '', modelState: modelState || '' });
        takeoverProxy(ctx, 'POST', '/api/v1/jobs', body, 30000, res);
      };
      // 服务端补位（★ 2026-11-18）：serve 不在跑时先自动拉起一次，再提交（首次冷启 3~20s）
      const withServe = (modelState) => {
        takeoverPort(ctx, (port) => {
          if (port) { proceed(modelState); return; }
          ensureServe(ctx, (r) => {
            if (r && r.ok && r.port) { proceed(modelState); return; }
            json(res, 502, {
              error: 'serve-down', project: ctx.id,
              hint: '已尝试自动拉起 serve 失败：' + ((r && r.reason) || 'unknown'),
              message: (r && r.hint) || '',
            });
          });
        });
      };
      if (!model) { withServe(''); return; }
      getModelList(false, (ml) => {
        if (ml && ml.ok && ml.models.indexOf(model) < 0) {
          json(res, 400, { error: 'bad-model', model: model, hint: '不在 CLI 支持清单', models: ml.models.slice(0, 12) });
          return;
        }
        withServe(ml && ml.ok ? 'verified' : 'unverified');
      });
    });
    return;
  }
  if (req.method === 'GET' && pn === '/takeover/stream') { takeoverStream(ctx, u.searchParams.get('id'), req, res); return; }
  if (req.method === 'POST' && pn === '/takeover/reply') {
    if (writeAuth(req, res, u, ctx)) return;
    readBody(req, (d) => {
      let b = {}; try { b = JSON.parse(d || '{}'); } catch (e) {}
      const id = String((b && b.id) || '');
      const text = String((b && b.text) || '').trim();
      if (!ID_RE.test(id) || !text || text.length > 4000) { json(res, 400, { error: 'bad-params', hint: 'id + text(1..4000) 必填' }); return; }
      const j = jobStateOf(id);
      if (j && !inProject(j.cwd, ctx.root)) { json(res, 403, { error: 'cross-project-job', project: ctx.id }); return; }   // ★ 防跨项目注入
      audit('takeover-reply', { p: ctx.id, id: id, chars: text.length, head: text.slice(0, 60) });
      takeoverProxy(ctx, 'POST', '/api/v1/jobs/' + encodeURIComponent(id) + '/reply', { text: text }, 15000, res);
    });
    return;
  }
  if (req.method === 'POST' && pn === '/takeover/stop') {
    if (writeAuth(req, res, u, ctx)) return;
    const id = String(u.searchParams.get('id') || '');
    if (!ID_RE.test(id)) { json(res, 400, { error: 'bad-id' }); return; }
    const j = jobStateOf(id);
    if (j && !inProject(j.cwd, ctx.root)) { json(res, 403, { error: 'cross-project-job', project: ctx.id }); return; }
    audit('takeover-stop', { p: ctx.id, id: id });
    takeoverProxy(ctx, 'POST', '/api/v1/jobs/' + encodeURIComponent(id) + '/stop', null, 15000, res);
    return;
  }
  if (req.method === 'POST' && pn === '/takeover/respawn') {
    // ★ 2026-11-19：续聊 —— worker 已退出（done/stopped/failed）的 job 用 serve 的 respawn 复活：
    //   停止旧进程 → 消费 pending reply → 基于原会话（sessionId 不变）恢复 worker，不重放 prompt。
    //   契约（codebuddy-headless.js 内 OpenAPI）：POST /api/v1/jobs/{id}/respawn → {data:{job}}。
    //   实测 2026-11-19：job 86d8306e（done）→ 200，state done→working、alive false→true、detail "resuming…"。
    //   边界：serve 重启过后的更老 job 可能 404（serve 内存无该条目）⇒ 前端提示改新建会话
    //   （归档会话另有 GET /api/v1/jobs/resumable + POST /api/v1/jobs/resume{sessionId}，未接）。
    if (writeAuth(req, res, u, ctx)) return;
    const id = String(u.searchParams.get('id') || '');
    if (!ID_RE.test(id)) { json(res, 400, { error: 'bad-id' }); return; }
    const j = jobStateOf(id);
    if (j && !inProject(j.cwd, ctx.root)) { json(res, 403, { error: 'cross-project-job', project: ctx.id }); return; }
    audit('takeover-respawn', { p: ctx.id, id: id, fromState: (j && j.state) || '' });
    takeoverProxy(ctx, 'POST', '/api/v1/jobs/' + encodeURIComponent(id) + '/respawn', null, 60000, res);
    return;
  }
  if (req.method === 'POST' && pn === '/takeover/delete') {
    if (writeAuth(req, res, u, ctx)) return;
    const id = String(u.searchParams.get('id') || '');
    if (!ID_RE.test(id)) { json(res, 400, { error: 'bad-id' }); return; }
    const jPre = jobStateOf(id);
    if (jPre && !inProject(jPre.cwd, ctx.root)) { json(res, 403, { error: 'cross-project-job', project: ctx.id }); return; }
    audit('takeover-delete', { p: ctx.id, id: id });
    // ★ 2026-10-06 删除兜底：worker 已退出的 job 只剩 ~/.codebuddy/jobs/<id>/ 磁盘残留，
    //   serve 对其 DELETE 一律非 2xx（内存列表也无此 job）⇒ UI 永远报"失败"（实证 ef35e3b1）。
    //   策略：磁盘终态(done/stopped/…)残留 → 无论 serve 结果本地清理
    //   （★ 2026-11-19 修正旧注释：原写「respawn 只恢复 working/blocked」不准确 —— 显式
    //     POST /jobs/{id}/respawn 对 done 也会复活（实测 86d8306e）。但那是**显式调用**；
    //     本条删记录路径只删磁盘残留，不会触发 respawn，故该策略仍成立）；
    //         非终态残留 → 维持 serve 原响应（working/blocked 重启会恢复，不可本地删）；
    //         无磁盘残留 → 幂等 200（claude 只读条目/已清理过的 id）。
    const jdir = path.join(JOBS_DIR, id);
    let jst = null;
    try { jst = JSON.parse(fs.readFileSync(path.join(jdir, 'state.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { jst = null; }
    const jFin = !!(jst && jst.shortId && /^(done|stopped|failed|error|cancelled|completed)$/i.test(String(jst.state || '')));
    takeoverProxy(ctx, 'DELETE', '/api/v1/jobs/' + encodeURIComponent(id), null, 30000, res, function (upCode, upRaw) {
      if (jFin) {                                          // serve 不认账也照清（worker 早已退出）
        try {
          fs.rmSync(jdir, { recursive: true, force: true });
          audit('takeover-delete-fallback', { id: id, state: jst.state, upstream: upCode });
          json(res, 200, { ok: true, mode: 'fallback-local', state: jst.state, upstream: upCode });
        } catch (e) { json(res, 500, { error: 'rm-failed', message: e.message }); }
        return;
      }
      if (!jst) { json(res, 200, { ok: true, mode: 'already-gone' }); return; }
      if (upCode >= 200 && upCode < 300) {                 // live job：serve 已删（含其目录）；顺手清可能残留
        try { if (jst) fs.rmSync(jdir, { recursive: true, force: true }); } catch (e) {}
        try { res.writeHead(upCode, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(upRaw || '{"ok":true}'); } catch (e) {}
        return;
      }
      try { res.writeHead(upCode > 0 ? upCode : 502, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(upRaw || '{"error":"serve-error"}'); } catch (e) {}
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end('{"error":"not-found"}');
});

// EADDRINUSE 显式报错退出（修订⑪：端口占用不是静默失败）
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    process.stderr.write('[session-hub] 端口 ' + PORT + ' 已被占用（EADDRINUSE）—— 已有实例在跑或端口冲突，退出。\n');
    process.exit(3);
  }
  process.stderr.write('[session-hub] server error: ' + (e && e.message) + '\n');
  process.exit(3);
});

server.listen(PORT, '127.0.0.1', () => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(INPUTS_DIR, { recursive: true });                                       // ★ v2：输入中继目录
  for (const c of CTX.values()) { try { fs.mkdirSync(c.archiveDir, { recursive: true }); } catch (e) {} }
  const fixed = reconcile();
  sweep();
  audit('boot', { port: PORT, reconciled: fixed, pid: process.pid, projects: [...CTX.keys()], default: DEFAULT_CTX.id });
  // ★ 2026-11-19：serve idle 回收（每项目独立定时器）+ 启动认领已在跑的 serve
  try { adoptAliveServes(); } catch (e) {}
  try { startServeReapers(); } catch (e) {}
  process.stdout.write('[session-hub] listening http://127.0.0.1:' + PORT + '/（reconciled=' + fixed + '）\n');
  for (const c of CTX.values()) {
    process.stdout.write('  · ' + c.id + ' ' + c.name + ' → ' + pfx(c, '/') + '  root=' + c.root + '  qq=' + c.qq.origin + '\n');
  }
  process.stdout.write('  · 缺省项目 = ' + DEFAULT_CTX.id + '（无前缀请求）\n');
});

process.on('SIGINT', () => gracefulStop('SIGINT'));
process.on('SIGTERM', () => gracefulStop('SIGTERM'));
