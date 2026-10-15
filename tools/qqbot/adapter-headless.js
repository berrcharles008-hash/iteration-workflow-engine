#!/usr/bin/env node
// adapter-headless.js —— FIX-34：headless 执行层适配器（**单一持有 CodeBuddy CLI 字面量**）
//
// ★ 铁律（Q3 决策 1）：除本文件与 daemon.config.json 外，任何 .js 不得出现 `codebuddy` 字面量。
//   面向人的命令文案由 humanHint() 生成，业务层（qqbot-service.js）不得自行拼 CLI 参数字符串。
//
// 分级（Q3 决策 2）：
//   A = serve 可视化 + 原生续聊（★ 已取证：P0 探针 + P1 闭环）
//   B = -p --session-id + -r 仅续聊（**未实测**，只留位、不得声称支持）
//   C = -p print 一次性无状态（= 现状）
//
// P0 已定型 spawn recipe（2026-09-19 实测，直接照抄勿改）：
//   spawn(node.exe, [entry, '--serve', '--port', PORT, '--auth', 'password'],
//         { cwd: PROJ_ROOT, windowsHide: true, stdio: ['pipe','pipe','pipe'] })
//   ★ 严禁 child.stdin.end() 或 stdio 'ignore' —— stdin EOF 会让 serve 秒退（exit 1，实测）
//   ★ 口令每次启动重新生成：从 stdout 解析 "?password=" 或读 ~/.codebuddy/settings.json 取，
//     **不得跨实例缓存**（credential() 每次现读）。
//   ★ 停止：child.kill() 优先；taskkill /T /F 兜底；以端口释放为准（stopChild()）。
//   ★ node.exe / entry 路径解析（P3 可移植化 2026-10-05）：
//     config(headless.nodeExe/headless.entryJs) > 真探测（运行中 node 自身 + 全局包定位）> P0 硬编码兜底。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, exec } = require('child_process');

// ── P0 兜底路径（仅最后手段；解析顺序 = config > 真探测 > 此处，见 resolvePaths）──
const NODE_EXE = 'C:\\nvm4w\\nodejs\\node.exe';
const ENTRY_JS = 'C:\\nvm4w\\nodejs\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy';
// 全局包相对布局（nvm4w：全局包在 node.exe 同级 node_modules 下；标准 npm 全局在 %APPDATA%\npm 下）
const GLOBAL_PKG_REL = path.join('node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');

// 分级标签
const TIER = { A: 'serve', B: 'print-resume', C: 'print' };

// ── 口令单一真源：~/.codebuddy/settings.json → gateway.password（渲染期现读，不缓存）──
function settingsPath() {
  return path.join(os.homedir(), '.codebuddy', 'settings.json');
}
function readGatewayPassword() {
  try {
    const j = JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, ''));
    if (j && j.gateway && j.gateway.password) return String(j.gateway.password);
  } catch (e) { /* ignore */ }
  return null;
}

// ── 路径解析（P3 可移植化 2026-10-05）：config > 真探测 > P0 硬编码兜底 ────
//   旧实现为「假探测」：candidates 仅含与 P0 同源的单一硬编码路径，覆盖面为 0。
function readHeadlessPathConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'daemon.config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const h = (j && j.headless) || {};
    return { nodeExe: h.nodeExe ? String(h.nodeExe) : null, entryJs: h.entryJs ? String(h.entryJs) : null };
  } catch (e) { return { nodeExe: null, entryJs: null }; }
}

function probeEntryJs() {
  const candidates = [];
  // (a) 与运行本服务的 node.exe 同目录（nvm4w 布局：全局包位于 nodejs\node_modules 下）
  try { candidates.push(path.join(path.dirname(process.execPath), GLOBAL_PKG_REL)); } catch (e) { /* ignore */ }
  // (b) 标准 npm 全局根（Windows）
  try { if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', GLOBAL_PKG_REL)); } catch (e) { /* ignore */ }
  // (c) PATH 中疑似 npm/node 目录扫描
  try {
    const dirs = String(process.env.PATH || '').split(';');
    for (const d of dirs) {
      if (d && /npm|nodejs|node/i.test(d)) candidates.push(path.join(d, GLOBAL_PKG_REL));
    }
  } catch (e) { /* ignore */ }
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

let _resolvedPaths = null;
function resolvePaths() {
  if (_resolvedPaths) return _resolvedPaths;
  const cfg = readHeadlessPathConfig();
  const node = cfg.nodeExe || process.execPath;   // 真探测：运行本服务的 node 自身必然可用
  const entry = cfg.entryJs || probeEntryJs() || ENTRY_JS;
  _resolvedPaths = { node: node, entry: entry };
  return _resolvedPaths;
}

// ── print 模式默认命令模板（C 档现状；L106/L1070 兜底用）────────────
function defaultCommand() {
  return 'codebuddy -p --permission-mode acceptEdits "{prompt}"';
}

// ── 控制台字节 → 文本（GBK 优先，无 ICU 时回退 UTF-8；对齐 qqbot-service decodeConsoleBytes）──
let _gbkDecoder = null, _gbkTried = false;
function decodeConsoleBytes(buf) {
  if (buf == null) return '';
  if (!Buffer.isBuffer(buf)) return String(buf);
  if (!buf.length) return '';
  if (!_gbkTried) {
    _gbkTried = true;
    try { _gbkDecoder = new TextDecoder('gbk'); } catch (e) { _gbkDecoder = null; }
  }
  try { return _gbkDecoder ? _gbkDecoder.decode(buf) : buf.toString('utf8'); }
  catch (e) { return buf.toString('utf8'); }
}

// ── ★ TOOL-QQCONT（W2-1）：模型清单 —— 唯一来源 = CLI `--help` 内嵌清单 ──────────
//   取证（2026-10-09 探针，见 runtime/TOOL-QQCONT-四件套.md §4.2.1）：
//     `--model <model>` 描述行含 "Currently supported: (hy4-preview, hy3, …)"（22 项）。
//   ★ P-A1（高）：entry 是**无扩展名**的 node 脚本（…/bin/codebuddy）
//     ⇒ 必须 spawn(node, [entry,'--help'])；直接 spawn(entry) 在 Windows 不成立。
//   ★ 实测：冷启动 4.4s · exit 0 · stderr 空；清单为纯 ASCII ⇒ GBK/UTF-8 解码同结果
//     （仍统一走 decodeConsoleBytes —— CLI 其余输出含中文）。
//   ★ 失败必须**显式**（ok:false + reason），**不得静默回空清单** ——
//     否则 QQ 会回「清单为空」（误导用户以为 CLI 不支持任何模型）。
//   ★ 缓存：TTL 内存缓存（默认 600s）——单次调用 4.4s，不宜每次口令都冷启。
const HELP_MODEL_RE = /Currently supported:\s*\(([^)]+)\)/;
let _modelCache = { at: 0, models: [] };
/** 从 --help 全文提取模型清单（去重、保序；无匹配 ⇒ []） */
function parseModelList(text) {
  const m = String(text || '').match(HELP_MODEL_RE);
  if (!m) return [];
  const out = [];
  for (const raw of m[1].split(/[,\r\n]+/)) {
    const s = String(raw).trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}
/** 模型名形态校验（防串参；**白名单**校验在业务层做 —— D-2=A） */
function isValidModelName(m) {
  return /^[\w.:\-]{1,64}$/.test(String(m || ''));
}

// ── ★ FIX-41（2026-10-10）：job 级 permissionMode —— headless 接管卡死根治 ─────
//   根因实证（job f1f89abf / d6aad4b0，两份 state.json needs 字段）：
//   dispatchJob 不带 permissionMode ⇒ job 继承 serve 进程级 acceptEdits ⇒
//   首条 Bash（连 ls）即触发权限审批 ⇒ 后台自动化无审批 UI（bundle
//   "background-automation-no-approval-ui"）⇒ job 永久卡 blocked ⇒
//   hub reply 只进 inbox 不被消费（f1f89abf/inbox 堆 4 条实证）+ 锁不释放 +
//   后续 QQ 确认全被 HANDOFF SKIP。hub /takeover/new 早已带
//   jobPermissionMode=bypassPermissions（E2E job 32e3ddd8 实证），
//   仅 qqbot 派发路径漏配 ⇒ 本枚举与 hub.config serve.jobPermissionMode 对齐。
//   ★ bypassPermissions 语义：跳过常规审批，HIGH/CRITICAL 仍询问（CLI --help 原文）。
const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'default', 'plan', 'dontAsk', 'auto'];
function isValidPermissionMode(m) {
  return PERMISSION_MODES.indexOf(String(m || '')) >= 0;
}
/**
 * 取模型清单（异步；cb 只回调一次）。
 *   ok:true  ⇒ { ok, models:[…], source:'help'|'cache' }
 *   ok:false ⇒ { ok:false, models:[], source:'none', reason }（调用方决定是否回落内置兜底清单）
 */
function fetchModelList(cb, cacheSec, force) {
  cb = cb || (() => {});
  const ttl = Math.max(30, Number(cacheSec) || 600) * 1000;
  if (!force && _modelCache.models.length && (Date.now() - _modelCache.at) < ttl) {
    cb({ ok: true, models: _modelCache.models.slice(), source: 'cache' });
    return;
  }
  const p = resolvePaths();
  if (!p.node || !fs.existsSync(p.node)) { cb({ ok: false, models: [], source: 'none', reason: 'node.exe 不存在：' + p.node }); return; }
  if (!p.entry || !fs.existsSync(p.entry)) { cb({ ok: false, models: [], source: 'none', reason: 'CLI entry 不存在：' + p.entry }); return; }
  let child;
  try { child = spawn(p.node, [p.entry, '--help'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { cb({ ok: false, models: [], source: 'none', reason: 'spawn 失败：' + e.message }); return; }
  const outChunks = [], errChunks = [];
  let done = false;
  const fin = (r) => { if (done) return; done = true; clearTimeout(timer); cb(r); };
  const timer = setTimeout(() => {
    try { child.kill(); } catch (e) { /* ignore */ }
    fin({ ok: false, models: [], source: 'none', reason: '--help 超时（15s）' });
  }, 15000);
  if (child.stdout) child.stdout.on('data', (d) => outChunks.push(Buffer.from(d)));
  if (child.stderr) child.stderr.on('data', (d) => errChunks.push(Buffer.from(d)));
  child.on('error', (e) => fin({ ok: false, models: [], source: 'none', reason: 'spawn error：' + e.message }));
  child.on('exit', () => {
    const outText = decodeConsoleBytes(Buffer.concat(outChunks));
    const errText = decodeConsoleBytes(Buffer.concat(errChunks)).trim();
    const models = parseModelList(outText);
    if (models.length) {
      _modelCache = { at: Date.now(), models: models.slice() };
      fin({ ok: true, models: models, source: 'help' });
      return;
    }
    fin({ ok: false, models: [], source: 'none',
      reason: '未能从 --help 解析清单' + (errText ? ('；stderr：' + errText.slice(0, 120)) : '') });
  });
}

// ── ★ TOOL-QQCONT（F2-c）：print 降级路径的模型注入 ────────────────────────────
//   仅当命令行**以 CLI 名开头**时注入（正则锚定，CLI 字面量只在本文件）；
//   模板已自带 --model / 形态非法 / 非 CLI 开头 ⇒ applied:false（调用方据此**如实回执**，
//   不得静默假装生效）。
function applyModelToCommand(cmd, model) {
  const m = String(model || '');
  const s = String(cmd || '');
  if (!isValidModelName(m)) return { command: s, applied: false };
  if (/(^|\s)--model(\s|=)/.test(s)) return { command: s, applied: false };
  const mm = s.match(/^(\s*)(\S*codebuddy\S*)(\s+)/i);
  if (!mm) return { command: s, applied: false };
  return { command: mm[0] + '--model ' + m + ' ' + s.slice(mm[0].length), applied: true };
}

// ── 启动（A 档 serve）：返回 spawn 所需三要素（纯函数，spawn 由调用方执行）──
//    opts = { port, cwd }
//    ★ FIX-34b（2026-10-03）：args 增加 --permission-mode acceptEdits ——
//      CLI help 明示该模式作用域含 "--serve Web"（进程级默认，Web 会话/job 全继承）。
//      动因：headless 接管要写文件，default 模式会卡权限审批 ⇒ 与 print 档同信任级（acceptEdits）。
//      若在 UI 出更高风险审批（HIGH/CRITICAL），用户打开 Web UI 可见并可手动批。
function start(opts) {
  opts = opts || {};
  const p = resolvePaths();
  return {
    mode: 'spawn',
    command: p.node,
    args: [p.entry, '--serve', '--port', String(opts.port), '--auth', 'password',
           '--permission-mode', 'acceptEdits'],
    options: {
      cwd: opts.cwd || process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      // ★ FIX-45（2026-10-11）：PIVAS_HANDOFF_OWNER 随 serve 进程注入 —— FIX-17e 的锁豁免
      //   （gate-check 的 handoffLockActive 见此变量即直接放行）此前只在 print 档生效
      //   （qqbot-service 用 exec 起 CLI 时才注入）；serve 档的 job 由 serve spawn、无此变量
      //   ⇒ job 写入被自己的接管锁拦（2026-10-11 实证：job c10b6fe6 撞锁 20 分钟无法写立项文件）。
      //   serve 及其全部子进程（job CLI → hook）继承本变量。
      env: Object.assign({}, process.env, { PIVAS_HANDOFF_OWNER: '1' }),
    },
    tier: 'A',
  };
}

// ── FIX-34b：serve 实例 Job 派发（2026-10-03 探针实证，job 383329ea 闭环）────
//   POST /api/v1/jobs {prompt,name,cwd} → 200 {data:{id,sessionId,state,intent,...}}
//   job = 常驻 PTY 托管的完整交互 CLI：Web UI 侧栏「智能体」可见、可打开续聊，
//   state 流转 working→done（detail="result: <答复>"），另有 /reply /stop /stream 等。
//   认证（实证）：Authorization: Bearer <gateway.password> + x-codebuddy-request: 1
//   （缺 x-codebuddy-request 一律 403 —— 与浏览器端 d2()/Je() 头构造一致）。
function apiHeaders() {
  const headers = { 'x-codebuddy-request': '1' };
  const cred = credential();
  if (cred.scheme === 'query' && cred.value) headers['Authorization'] = 'Bearer ' + cred.value;
  return headers;
}
function dispatchJob(inst, opts, cb) {
  const port = Number(inst && inst.port);
  if (!port) { cb(new Error('dispatchJob: 缺 port')); return; }
  // ★ TOOL-QQCONT（D-1 收敛形态）：逐 job 模型 —— 探针实测（2026-10-09）
  //   POST /api/v1/jobs 请求体原生支持 `model`，CLI 侧 `el.model && eg.push("--model", el.model)`
  //   ⇒ 该 job 的 CLI 带 --model 启动；**serve 实例无需换型/重启**（原方案换型族已取消）。
  //   形态非法（含串参面）直接丢弃而非抛错：白名单校验已在业务层完成（D-2=A），此处只防串参。
  const body = {
    prompt: String(opts.prompt || ''),
    name: String(opts.name || ''),
    cwd: String(opts.cwd || process.cwd()),
  };
  const model = isValidModelName(opts.model) ? String(opts.model) : '';
  if (model) body.model = model;
  // ★ FIX-41：job 级权限档（缺省 = 不传 = 继承 serve 进程级，acceptEdits 会卡 Bash 审批）。
  //   非法值**显式丢弃**而非抛错：与 model 同哲学，形态校验在此，取值决策在业务层。
  const perm = String(opts.permissionMode || '');
  if (perm && isValidPermissionMode(perm)) body.permissionMode = perm;
  const payload = JSON.stringify(body);
  const headers = Object.assign(apiHeaders(), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  const req = http.request({
    host: '127.0.0.1', port: port, path: '/api/v1/jobs', method: 'POST',
    headers: headers, timeout: 30000,
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { buf += d; });
    res.on('end', () => {
      let job = null;
      try {
        const j = JSON.parse(buf);
        job = j && j.data ? (j.data.job || j.data) : null;
      } catch (e) { /* fallthrough */ }
      if (res.statusCode === 200 && job && job.id) cb(null, job);
      else cb(new Error('HTTP ' + res.statusCode + ' ' + String(buf).slice(0, 140)));
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { try { req.destroy(new Error('dispatch timeout')); } catch (e) {} });
  req.write(payload);
  req.end();
}

// ── ★ TOOL-QQNEWITER（V2-9）：job 状态查询（GET /api/v1/jobs → 按 id 匹配）────
//   端点契约（hub 已在用，session-hub/server.js:597）：{data:{jobs:[{id,sessionId,state,detail,name,...}]}}
//   用途：serve 接管的 job 终态轮询（done/error/… ⇒ 收尾回执 + 释锁 + 归零），替代"只探端口"的僵尸盲区。
function jobStatus(inst, jobId, cb) {
  const port = Number(inst && inst.port);
  if (!port || !jobId) { cb(new Error('jobStatus: 缺 port/jobId')); return; }
  const req = http.request({
    host: '127.0.0.1', port: port, path: '/api/v1/jobs', method: 'GET',
    headers: apiHeaders(), timeout: 15000,
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { buf += d; });
    res.on('end', () => {
      let job = null;
      try {
        const j = JSON.parse(buf);
        const arr = (j && j.data && (j.data.jobs || j.data)) || [];
        if (Array.isArray(arr)) job = arr.filter((x) => String(x && x.id) === String(jobId))[0] || null;
      } catch (e) { /* fallthrough */ }
      if (res.statusCode === 200 && job) cb(null, job);
      else {
        // ★ FIX-42（2026-10-10）：区分「job 不存在」与「真查询失败」——
        //   job 结束（done/failed…）后会被 serve 移出活跃列表 ⇒ HTTP 200 但匹配不到 id
        //   （= 终态信号，调用方据此收尾释锁；2026-10-10 锁僵尸实证）。真失败（超时/5xx/网络）
        //   不带此 code ⇒ 调用方保持 fail-open。
        const e = new Error('HTTP ' + res.statusCode + (job ? '' : ' job-not-found'));
        if (res.statusCode === 200 && !job) e.code = 'job_not_found';
        cb(e);
      }
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { try { req.destroy(new Error('jobStatus timeout')); } catch (e) {} });
  req.end();
}

// ── ★ FIX-43（2026-10-11）：列活跃 jobs（GET /api/v1/jobs 全量）──────────────
//   用途：孤儿 job 进程巡检（qqbot-service sweepOrphanJobs）——判定某 sessionId 是否仍活跃。
//   契约同 FIX-42 的 jobStatus（{data:{jobs:[…]}}；hub 已同款使用）。
//   ★ 失败必须显式（cb(err)）——调用方据此**放弃本轮巡检**（宁可不杀，绝不误杀进行中 job）。
function listJobs(inst, cb) {
  const port = Number(inst && inst.port);
  if (!port) { cb(new Error('listJobs: 缺 port')); return; }
  const req = http.request({
    host: '127.0.0.1', port: port, path: '/api/v1/jobs', method: 'GET',
    headers: apiHeaders(), timeout: 15000,
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { buf += d; });
    res.on('end', () => {
      let arr = null;
      try {
        const j = JSON.parse(buf);
        arr = (j && j.data && (j.data.jobs || j.data)) || [];
      } catch (e) { /* fallthrough */ }
      if (res.statusCode === 200 && Array.isArray(arr)) cb(null, arr);
      else cb(new Error('HTTP ' + res.statusCode + ' listJobs-bad-body'));
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { try { req.destroy(new Error('listJobs timeout')); } catch (e) {} });
  req.end();
}

// ── ★ FIX-45（2026-10-11）：job 注入答复（POST /api/v1/jobs/<id>/reply {text}）────────
//   契约（hub server.js:598 实证）：body {text} → {data:{delivered:true|false, saved:…}}。
//   用途：答案回传直连 —— QQ 答复落盘后由 qqbot 服务主动注入活跃 job。
//   背景：ask.js 只登记不等待；wait-answer.ps1 分片轮询在 job 侧常失败（PS 环境/工具超时）
//   ⇒ 答复写文件后无人读取、job 停在等输入（2026-10-11 实证：用户已回 A#3/A#4，job 20 分钟无反应）。
function replyJob(inst, jobId, text, cb) {
  const port = Number(inst && inst.port);
  if (!port || !jobId) { cb(new Error('replyJob: 缺 port/jobId')); return; }
  const payload = JSON.stringify({ text: String(text || '') });
  const req = http.request({
    host: '127.0.0.1', port: port, path: '/api/v1/jobs/' + encodeURIComponent(String(jobId)) + '/reply',
    method: 'POST',
    headers: Object.assign(apiHeaders(), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    }),
    timeout: 30000,
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { buf += d; });
    res.on('end', () => {
      let j = null;
      try { j = JSON.parse(buf); } catch (e) { /* fallthrough */ }
      const d = j && j.data ? j.data : null;
      if (res.statusCode === 200 && d && d.delivered) cb(null, d);
      else cb(new Error('HTTP ' + res.statusCode + ' delivered=' + (d ? d.delivered : '?') + ' ' + String(buf).slice(0, 100)));
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { try { req.destroy(new Error('replyJob timeout')); } catch (e) {} });
  req.write(payload);
  req.end();
}

// ── 口令（渲染期现读 settings.json.gateway.password，不跨实例缓存）────
function credential() {
  const value = readGatewayPassword();
  if (!value) return { scheme: 'none', key: '', value: '' };
  return { scheme: 'query', key: 'password', value: value };
}

// ── 判活：HTTP 端口探活（host 恒 127.0.0.1，不跟随 --host）────────────
//    inst = { port } 或直接传端口数字
//    ★ FIX-34c（2026-10-03）：timeout 2s→5s —— E2E 实测 serve 拉起 job PTY 时事件循环
//      忙碌，GET / 可能 >2s 才应答 ⇒ ticker 误报「实例已死」（20:57:00 假警报，锁被提前释放）。
//      端口空闲时连接被拒是即时的，超时仅在「监听但未应答」时发生 ⇒ 放宽不影响回收速度。
function probe(inst, cb) {
  const port = Number((inst && typeof inst === 'object') ? inst.port : inst);
  if (!port) { cb(false); return; }
  let done = false;
  const finish = (v) => { if (done) return; done = true; cb(v); };
  const req = http.request({ host: '127.0.0.1', port: port, path: '/', method: 'GET', timeout: 5000 }, (res) => {
    res.resume();
    finish(true);
  });
  req.on('error', () => finish(false));
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
  req.end();
}

// ── 端口就绪轮询（T_open 实测 ≈7.6s；默认 15s 超时）────────────────
function waitPort(port, timeoutMs, cb, intervalMs) {
  intervalMs = intervalMs || 500;
  const t0 = Date.now();
  (function tick() {
    probe(port, (alive) => {
      if (alive) { cb(true); return; }
      if (Date.now() - t0 >= timeoutMs) { cb(false); return; }
      setTimeout(tick, intervalMs);
    });
  })();
}

// ── 停止：child.kill() 优先，taskkill /T /F 兜底，以端口释放为准 ──────
function stopChild(child, port, cb) {
  cb = cb || (() => {});
  if (!child) { cb(); return; }
  try { child.kill(); } catch (e) { /* ignore */ }
  // 兜底 taskkill（实测偶返回非零但进程确实被杀，以端口释放为准）
  const force = () => {
    if (child.pid) {
      try { exec('taskkill /T /F /PID ' + child.pid, { windowsHide: true }, () => cb()); return; } catch (e) { /* ignore */ }
    }
    cb();
  };
  if (port) {
    // 等端口释放后再收尾（决定性判据）
    const t0 = Date.now();
    (function waitRelease() {
      probe(port, (alive) => {
        if (!alive) { cb(); return; }
        if (Date.now() - t0 >= 5000) { force(); return; }
        setTimeout(waitRelease, 300);
      });
    })();
  } else {
    setTimeout(force, 500);
  }
}

// ── 续聊能力（A 档 = Web UI 输入框原生续聊）────────────────
function resumeMode() {
  return 'webui';   // 'webui' | 'cli-resume' | 'restart'
}

// ── 面向人的提示文案（业务层不得自行拼 CLI 参数）────────────────
//    inst = { webUrl, port }
function humanHint(inst) {
  const webUrl = inst && inst.webUrl ? String(inst.webUrl) : '';
  return {
    open: webUrl ? '回工位打开 Web UI：' + webUrl : '',
    password: '口令位置：~/.codebuddy/settings.json（gateway.password，每次启动重新生成）',
  };
}

// ── 两级能力探测（Q3 决策 3）── ① help/存在性解析 ② 冒烟实测 ──────────
//    冒烟实测 = spawn 临时 serve + 端口探活 + kill（零 token 问答已在 P0 完成，运行期不重复）。
//    返回 { tier, tierLabel, reason, detectedAt }；tier 由调用方写入实例指针文件。
function detect(cb) {
  cb = cb || (() => {});
  // ① 存在性解析（help 解析的轻量等价：入口文件与 node.exe 存在）
  const p = resolvePaths();
  const nodeOk = fs.existsSync(p.node);
  const entryOk = fs.existsSync(p.entry);
  if (!nodeOk || !entryOk) {
    cb({ tier: 'C', tierLabel: TIER.C, reason: 'node.exe/entry 不存在', detectedAt: Date.now() });
    return;
  }
  // ② 冒烟实测（起临时 serve + 端口探活 + kill）
  const smokePort = 21800;
  const spec = start({ port: smokePort, cwd: process.cwd() });
  let child;
  try { child = spawn(spec.command, spec.args, spec.options); }
  catch (e) {
    cb({ tier: 'C', tierLabel: TIER.C, reason: 'spawn 失败：' + e.message, detectedAt: Date.now() });
    return;
  }
  // 临时探测进程：吞掉 stdout/stderr（避免污染调用方日志）
  if (child.stdout) child.stdout.on('data', () => {});
  if (child.stderr) child.stderr.on('data', () => {});
  child.on('error', () => {});
  waitPort(smokePort, 15000, (alive) => {
    stopChild(child, smokePort, () => {
      cb(alive
        ? { tier: 'A', tierLabel: TIER.A, reason: 'serve 冒烟实测端口就绪', detectedAt: Date.now() }
        : { tier: 'C', tierLabel: TIER.C, reason: 'serve 冒烟实测端口未就绪', detectedAt: Date.now() });
    });
  });
}

module.exports = {
  detect: detect,
  start: start,
  credential: credential,
  probe: probe,
  waitPort: waitPort,
  stopChild: stopChild,
  resumeMode: resumeMode,
  humanHint: humanHint,
  defaultCommand: defaultCommand,
  readGatewayPassword: readGatewayPassword,
  settingsPath: settingsPath,
  resolvePaths: resolvePaths,
  apiHeaders: apiHeaders,
  dispatchJob: dispatchJob,
  jobStatus: jobStatus,   // ★ TOOL-QQNEWITER（V2-9：job 终态轮询）
  listJobs: listJobs,     // ★ FIX-43（孤儿 job 进程巡检的活跃列表判定）
  replyJob: replyJob,     // ★ FIX-45（答案回传直连：QQ 答复注入活跃 job）
  decodeConsoleBytes: decodeConsoleBytes,   // ★ TOOL-QQCONT（供离线自测）
  fetchModelList: fetchModelList,           // ★ TOOL-QQCONT（W2-1：模型清单，TTL 缓存）
  parseModelList: parseModelList,           // ★ TOOL-QQCONT（纯函数，供离线自测）
  isValidModelName: isValidModelName,       // ★ TOOL-QQCONT（纯函数，供离线自测）
  applyModelToCommand: applyModelToCommand, // ★ TOOL-QQCONT（F2-c：print 降级路径模型注入）
  isValidPermissionMode: isValidPermissionMode, // ★ FIX-41（job 级权限档枚举，供离线自测）
  TIER: TIER,
};

// 离线自测入口：node adapter-headless.js --selfcheck（不 spawn 真实 serve，仅校验路径/口令/默认命令）
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--selfcheck') {
    const p = resolvePaths();
    const cred = credential();
    process.stdout.write(JSON.stringify({
      nodeExists: fs.existsSync(p.node),
      entryExists: fs.existsSync(p.entry),
      defaultCommand: defaultCommand(),
      credentialScheme: cred.scheme,
      hasPassword: !!(cred.value),
      resumeMode: resumeMode(),
      humanHint: humanHint({ webUrl: 'http://127.0.0.1:19000' }),
    }) + '\n');
    process.exit(0);
  }
  // 冒烟实测：node adapter-headless.js --detect
  if (arg === '--detect') {
    detect((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); });
  }
  // ★ TOOL-QQCONT：（不 spawn serve）模型清单提取自测 —— `node adapter-headless.js --modellist [--no-cache]`
  //   --no-cache 强制冷启（验证正则与 CLI 现值，不看缓存）；默认走缓存语义。
  if (arg === '--modellist') {
    const force = String(process.argv[3] || '') === '--no-cache';
    fetchModelList((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    }, 600, force);
  }
  // ★ TOOL-QQCONT：print 模板模型注入自测 —— `node adapter-headless.js --model-apply "<cmd>" [model]`
  if (arg === '--model-apply') {
    const cmd = String(process.argv[3] || defaultCommand());
    const model = String(process.argv[4] || 'glm-5.3-flash');
    process.stdout.write(JSON.stringify({ in: cmd, out: applyModelToCommand(cmd, model) }, null, 2) + '\n');
    process.exit(0);
  }
}
