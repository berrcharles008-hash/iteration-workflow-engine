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
//   ★ node.exe / entry 路径当前硬编码本机 C:\nvm4w\；生产机器须探测（resolvePaths() 兜底）。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, exec } = require('child_process');

// ── P0 定型路径（本机）；生产机器由 resolvePaths() 探测兜底 ─────────────
const NODE_EXE = 'C:\\nvm4w\\nodejs\\node.exe';
const ENTRY_JS = 'C:\\nvm4w\\nodejs\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy';

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

// ── 路径探测：硬编码路径失效时，从 shim 反推（生产机器兜底）────────────
function resolvePaths() {
  if (fs.existsSync(NODE_EXE) && fs.existsSync(ENTRY_JS)) return { node: NODE_EXE, entry: ENTRY_JS };
  // 兜底：读 node_modules 下 shim 的 %dp0% 思路 —— 本机实测 .cmd/.ps1 都是包皮，真实入口 = 该 JS；
  // 此处仅做「同前缀猜测」级兜底（找到 codebuddy-code 包目录即认为可用）。
  try {
    const candidates = [
      'C:\\nvm4w\\nodejs\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy',
    ];
    for (const e of candidates) {
      if (fs.existsSync(e)) return { node: NODE_EXE, entry: e };
    }
  } catch (e) { /* ignore */ }
  return { node: NODE_EXE, entry: ENTRY_JS };
}

// ── print 模式默认命令模板（C 档现状；L106/L1070 兜底用）────────────
function defaultCommand() {
  return 'codebuddy -p --permission-mode acceptEdits "{prompt}"';
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
    options: { cwd: opts.cwd || process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
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
  const payload = JSON.stringify({
    prompt: String(opts.prompt || ''),
    name: String(opts.name || ''),
    cwd: String(opts.cwd || process.cwd()),
  });
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
}
