#!/usr/bin/env node
// qqbot-service.js —— QQ 通知 + 确认「合并服务」（档 2，2026-09-17）
//
// 单进程双职责（取代 notify-watcher.ps1 + qqbot-daemon.js 两个独立进程）：
//   A) Watcher 模块：轮询 CodeBuddy IDE 会话历史目录，写入静置达阈值即推 QQ
//      （原 notify-watcher.ps1 的 Node 重写，含 6 个已验证的坑，见下方注释）
//   B) Confirm 模块：WebSocket 收你的 QQ 消息 + 本地 HTTP 注册口
//      （原 qqbot-daemon.js 逻辑，接口/协议保持不变）
// 共享：一套凭据、一份 access_token（90 分钟复用 + 到期兜底刷新）、一套日志
//
// 用法：
//   node qqbot-service.js                                             # 全功能常驻
//   node qqbot-service.js --test                                      # 仅验证 QQ 网关连接，5s 后退出
//   node qqbot-service.js --no-watch                                  # 只跑确认模块
//   node qqbot-service.js --no-daemon --idle 8 --watch-root <dir>     # 只跑 watcher（隔离测试用）
//   node qqbot-service.js --appid <id> --secret <sec> --openid <oid>
// 凭据优先级：命令行参数 > 环境变量 QQ_BOT_* > 同目录 qqbot.creds.json > daemon.config.json.openId
// 启动/自启：start-service.ps1（启动器）· install-service.ps1（注册登录自启）
//
// 依赖：ws（确认模块需要；watcher 单独可跑）。Node 16 兼容，CommonJS。

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec, execSync, spawn } = require('child_process');   // ★ FIX-34：spawn 用于 serve 模式托管；★ FIX-37d：execSync 供离线解码自测
const { URL } = require('url');

let WebSocket = null;
const DIR = __dirname;
const LOG = path.join(DIR, 'service.log');
const INBOX = path.join(DIR, 'inbox.jsonl');
const PROJ_ROOT = path.resolve(DIR, '..', '..');   // 命令执行 cwd = 项目根（便于配置相对路径）
const LF = String.fromCharCode(10);                // ★ FIX-17：runHeadless 生成 handoff 文件时使用（此前未定义 ⇒ ReferenceError 被 catch 静默吞掉）
// ★ FIX-34：headless 执行层适配器 —— 单一持有 CodeBuddy CLI 字面量（分级 A/B/C + 两级探测）
const adapter = require('./adapter-headless.js');

// ── 日志（本地时间，统一 service.log）────────────────────────────
function ts() {
  const d = new Date(), p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function log(m) {
  const line = ts() + ' ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* 日志失败不致命 */ }
}
// 为 service.log 补写 UTF-8 BOM（幂等）—— 否则 PowerShell 5.1 的 Get-Content 会按系统代码页
// （zh-CN = GBK）解码，中文日志显示为乱码；BOM 也能被 Node / VS Code 正常忽略。
(function ensureLogBom() {
  try {
    const BOM = String.fromCharCode(0xFEFF);
    const exists = fs.existsSync(LOG);
    const has = exists && fs.readFileSync(LOG, 'utf8').slice(0, 1) === BOM;
    if (!has) fs.writeFileSync(LOG, BOM + (exists ? fs.readFileSync(LOG, 'utf8') : ''), 'utf8');
  } catch (e) { /* 不致命 */ }
})();
function logInbox(o) {
  try { fs.appendFileSync(INBOX, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, o)) + '\n'); } catch (e) {}
}

// ── 参数 ──────────────────────────────────────────────────────
function parseArgs() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--appid') a.appId = argv[++i];
    else if (k === '--secret') a.secret = argv[++i];
    else if (k === '--openid') a.openId = argv[++i];
    else if (k === '--config') a.config = argv[++i];
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--idle') a.idle = parseInt(argv[++i], 10);
    else if (k === '--watch-root') a.watchRoot = argv[++i];
    else if (k === '--no-watch') a.noWatch = true;
    else if (k === '--no-daemon') a.noDaemon = true;
    else if (k === '--test') a.test = true;
    else if (k === '--render') a.render = argv[++i];   // ★ FIX-30：离线渲染自测（读 rec.json → 打印消息文本）
    else if (k === '--parse') a.parse = argv[++i];     // ★ FIX-31：离线解析自测（打印三类语法解析结果）
    else if (k === '--snooze-parse') a.snoozeParse = argv[++i];   // ★ FIX-36：离线静默解析自测
    else if (k === '--cmd-parse') a.cmdParse = argv[++i];         // ★ FIX-37：离线口令解析自测（心跳/关机/中止关机）
    else if (k === '--probe') a.probe = true;                     // ★ FIX-37：离线渲染状态探针（不发送）
    else if (k === '--dec-test') a.decTest = argv[++i] || true;   // ★ FIX-37d：离线解码自测（默认跑 net helpmsg 1190）
    else if (k === '--wake-test') a.wakeTest = argv[++i] || '3';  // ★ FIX-38：建 N 分钟后的唤醒定时器 → 查询 → 删除（不待机）
    else if (k === '--wake-query') a.wakeQuery = true;            // ★ FIX-38：查询当前唤醒定时器
    else if (k === '--wake-del') a.wakeDel = true;                // ★ FIX-38：删除唤醒定时器
    else if (k === '--merge-test') a.mergeTest = true;            // ★ FIX-39：离线汇总渲染自测（n=1 直发 / n≥2 摘要 / 超长截断）
  }
  return a;
}
const args = parseArgs();
const TEST = !!args.test;

// ── 配置（沿用 daemon.config.json，新增可选 watcher.idleSeconds）──
const DEFAULT_CFG = {
  openId: '', dryRun: true,
  listenPort: 18765, httpKey: '', requestTimeoutMs: 600000,
  // ★ FIX-20：推送策略（任务结束才推 · 决策必带 #N · 中间环节静默）
  notify: {
    mergeWindowMs: 90000,          // done/progress 合并窗口（同类多条攒成一条摘要）
    mergeMax: 5,                   // 达到条数立即 flush，不等窗口
    quietHours: { from: 23, to: 8 }, // 免打扰时段：期间 **只放行 fail/decision**，done/progress 延后到时段结束
    skipNoToolUse: true,           // watcher：会话无工具产出（纯问答/闲聊）不推
    onlineNotice: true,            // ★ FIX-38：服务启动发「🟢 已上线」
    offlineNotice: true,           // ★ FIX-38：优雅停止发「🔴 已下线」
    liveness: { writeSec: 30, staleSec: 180, watchPollSec: 60 },   // ★ FIX-38：心跳/看门狗阈值
  },
  watcher: {
    idleSeconds: 900,              // ★ FIX-36：90 → 900（实测 90s 只是「到点即发」的扳机 —— 2026-09-20 全天 55 条登记全落在 90~100s）
    autoQueue: true,        // ★ FIX-17：静置推送改为「登记可回复项」（QQ 回「确认#N」可驱动），不再只发单向通知
    autoHandoff: false,     // 默认安全；由 daemon.config.json 显式开启 ⇒ 确认后自动拉起 CLI 新会话接管继续
    handoffPrompt: '',      // autoHandoff=true 时写入 handoff 文件的「剩余工作」小节
  },
  gateCommand: '',        // 档3：门禁类待确认项被「确认#N」时执行的命令（默认空 = 只回执，安全默认）
  commandAllowlist: [],   // 请求体自带 command 的白名单前缀（默认空 = 不接受请求体命令，仅执行配置内命令）
  answerDir: '.codebuddy/temp/qq-answers',   // ★ A：等待式确认的答案文件目录（agent 用 wait-answer.ps1 读取）
  headless: {
    enabled: true,
    command: adapter.defaultCommand(),   // ★ FIX-34：codebuddy 字面量收敛到 adapter（原硬编码移走）
    timeoutMs: 1800000,
    replyChars: 600,
    handoffDir: '.codebuddy/temp/handoff',
  },
  // ★ FIX-37（2026-09-21）：QQ 命令口令 ——「心跳」（状态自检，只读）与「关机」（远程关机，二次确认）
  //   ① 口令 = **整条精确匹配**（避免「别关机 / 关机日志」误触发，也避免被 route() 的「中止」劫持）；
  //   ② 关机默认 enabled=false（opt-in）；命令模板含 {delay} 占位（便于先用替身脚本验链路）；
  //   ③ 关机项**禁止免编号直通**（confirm 关键词含「好/可以/ok」⇒ 一句闲聊式应答即断电）。
  commands: {
    heartbeat: { keywords: ['心跳', '状态', 'ping'] },
    shutdown: {
      enabled: false,                                     // opt-in：需显式改 true 并重启服务
      keywords: ['关机', '关闭电脑', '关闭计算机', 'shutdown'],
      delaySec: 90,                                       // 倒计时（不带 /f ⇒ 不强杀未保存内容）
      confirmWindowSec: 120,                              // 待确认有效期（独立于 requestTimeoutMs）
      command: 'shutdown /s /t {delay}',
      cancelCommand: 'shutdown /a',                       // 倒计时内中止
    },
    cancelShutdown: { keywords: ['中止关机', '取消关机', 'abort'] },
    // ★ FIX-38：待机（始终带唤醒定时器）+ 唤醒口令
    sleep: {
      enabled: true,                                      // 待机可自动唤醒 ⇒ 默认开（关机仍默认关）
      keywords: ['待机', '睡眠', 'sleep'],
      command: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
      defaultWakeMin: 30,
      maxWakeMin: 1440,
      confirmWindowSec: 120,
    },
    wake: { keywords: ['开机', '唤醒', 'wake'], taskName: 'PIVAS-WakeTimer' },
  },
  actions: {
    confirm: { keywords: ['确认', '继续', '是', 'yes', 'ok', '好', 'go', '同意'], reply: '✅ 已收到确认，开始执行后续任务。', command: '' },
    cancel: { keywords: ['取消', '否', 'no', 'stop', '不要', '中止'], reply: '⛔ 已取消，任务中止。', command: '' }
  },
  fallbackReply: '未识别指令。如需确认某条待办，请回复「确认#编号」或「取消#编号」。'
};
function loadCfgFile(p) { try { if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {} return null; }
const cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
const loadedCfg = loadCfgFile(args.config) || loadCfgFile(path.join(DIR, 'daemon.config.json'));
if (loadedCfg) {
  Object.assign(cfg, loadedCfg);
  if (loadedCfg.watcher) cfg.watcher = Object.assign(DEFAULT_CFG.watcher, loadedCfg.watcher);
  if (loadedCfg.headless) cfg.headless = Object.assign(DEFAULT_CFG.headless, loadedCfg.headless);
  // ★ FIX-37：commands 需**二级深合并** —— 顶层 Object.assign 是浅合并，
  //   文件里只写 shutdown 会把 heartbeat/cancelShutdown 的默认值整个顶掉（缺 keywords ⇒ 口令失效）。
  if (loadedCfg.commands) {
    const C = Object.assign({}, DEFAULT_CFG.commands, loadedCfg.commands);
    for (const k of ['heartbeat', 'shutdown', 'cancelShutdown']) {
      C[k] = Object.assign({}, DEFAULT_CFG.commands[k], loadedCfg.commands[k] || {});
    }
    cfg.commands = C;
  }
}

// ── 凭据（统一：args > env > qqbot.creds.json > daemon.config.json.openId）──
function loadCreds() {
  const out = {
    appId: args.appId || process.env.QQ_BOT_APPID,
    secret: args.secret || process.env.QQ_BOT_SECRET,
    openId: args.openId || process.env.QQ_BOT_OPENID,
    from: 'args/env'
  };
  if (!out.appId || !out.secret || !out.openId) {
    const f = loadCfgFile(path.join(DIR, 'qqbot.creds.json'));
    if (f) {
      if (!out.appId && f.appId) { out.appId = f.appId; out.from = 'creds.json'; }
      if (!out.secret && f.secret) out.secret = f.secret;
      if (!out.openId && f.openId) out.openId = f.openId;
    }
  }
  if (!out.openId && cfg.openId) out.openId = cfg.openId;
  return out;
}
const creds = loadCreds();
const appId = creds.appId, secret = creds.secret, OPENID = creds.openId;
if (!appId || !secret) { log('缺少凭据：AppID/Secret（--appid/--secret、QQ_BOT_* 或 tools/qqbot/qqbot.creds.json）'); process.exit(1); }
if (!OPENID) { log('缺少 openid（--openid、QQ_BOT_OPENID、qqbot.creds.json.openId 或 daemon.config.json.openId）'); process.exit(1); }
const mask = (s) => (s ? String(s).slice(0, 6) + '***' : '(空)');

// ── 共享 token / send ────────────────────────────────────────
function postJson(host, p, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: host, path: p, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
let token = null, tokenAt = 0;
async function getToken(force) {
  // 软过期 80 分钟（令牌实际 90 分钟）⇒ 到期兜底刷新；定时器只做主动续期
  if (!force && token && (Date.now() - tokenAt) < 80 * 60 * 1000) return token;
  const r = await postJson('bots.qq.com', '/app/getAppAccessToken', { appId, clientSecret: secret });
  if (!r.json || !r.json.access_token) throw new Error('获取 token 失败: ' + String(r.raw).slice(0, 200));
  token = r.json.access_token; tokenAt = Date.now();
  return token;
}
async function send(content) {
  if (!token) await getToken();
  const doPost = () => postJson('api.sgroup.qq.com', '/v2/users/' + OPENID + '/messages',
    { content, msg_type: 0 }, { Authorization: 'QQBot ' + token, 'X-UnionAppid': appId });
  let r = await doPost();
  // ★ FIX-17：401 = token 被顶/过期（notify.qqbot.js 等其它进程另取 token 会顶号）⇒ 强刷后重试一次
  if (r.status === 401) {
    log('[SEND 401] token 失效 → 强制刷新后重试');
    try { await getToken(true); } catch (e) { log('[SEND 401] 刷新失败: ' + e.message); }
    r = await doPost();
    if (r.status === 401) log('[SEND 401] 重试后仍 401（检查凭据/平台状态）');
  }
  return r.status;
}

// ══════════════════════════════════════════════════════════════
// ★ FIX-37d（2026-09-21）：子进程输出解码 —— Windows 命令的中文输出按 GBK(CP936) 写字节，
//   而 Node 默认按 UTF-8 解码 ⇒ 回执出现乱码（实测：`shutdown /s /t 90` 返回
//   `�Ѿ��ƻ�ϵͳ�ػ���(1190)`，真实文本 = 「已经计划系统关机。(1190)」）。
//   对策：以 encoding:'buffer' 取原始字节 → 优先 GBK 解码（Node 官方构建自带 full-icu），
//         解码器不可用时**回退 UTF-8**（行为 == 修复前，不劣化）；并把 exec 的
//         `Command failed: <cmd>\n<stderr>` 归一为 { message, code }，便于按退出码分支。
// ══════════════════════════════════════════════════════════════
let _gbkDecoder = null, _gbkTried = false;
/** 控制台字节 → 文本（GBK 优先，不可用则 UTF-8 回退） */
function decodeConsoleBytes(buf) {
  if (buf == null) return '';
  if (!Buffer.isBuffer(buf)) return String(buf);
  if (!buf.length) return '';
  if (!_gbkTried) {
    _gbkTried = true;
    try { _gbkDecoder = new TextDecoder('gbk'); }
    catch (e) { _gbkDecoder = null; log('[DEC] GBK 解码器不可用（无 ICU）⇒ 回退 UTF-8'); }
  }
  try { return _gbkDecoder ? _gbkDecoder.decode(buf) : buf.toString('utf8'); }
  catch (e) { return buf.toString('utf8'); }
}
/**
 * 执行外部命令并解码输出（★ FIX-37d）。
 * @param {string} cmd 命令行
 * @param {object} opts exec 选项（windowsHide/cwd 有默认值；env 等按需覆盖）
 * @param {function} cb 回调 `(err, stdout, stderr)`；err = `{ message, code }`（无错为 null）
 */
function execDecoded(cmd, opts, cb) {
  const o = Object.assign({ windowsHide: true, cwd: PROJ_ROOT, encoding: 'buffer' }, opts || {});
  exec(cmd, o, (err, outBuf, errBuf) => {
    const stdout = decodeConsoleBytes(outBuf).trim();
    const stderr = decodeConsoleBytes(errBuf).trim();
    if (!err) { cb(null, stdout, stderr); return; }
    const code = (typeof err.code === 'number') ? err.code : null;
    let msg = stderr;
    if (!msg) {
      msg = String(err.message || '')
        .replace(/^Command failed:[^\r\n]*[\r\n]*/, '')      // 去掉 exec 自带的命令行前缀
        .replace(/[\r\n]+/g, ' ')
        .trim();
    }
    cb({ message: msg || ('exit=' + code), code: code }, stdout, stderr);
  });
}

// ══════════════════════════════════════════════════════════════
// ★ FIX-20：推送策略层（统一出口 /notify 的策略判定）
//   kind：done = 任务结束 ｜ fail = 失败/异常（需决策）｜ progress = 长任务心跳 ｜ decision = 需拍板（已带 #N）
//   规则：① 全局静默开关（与门禁共用）② fail / decision **立即发**
//        ③ done / progress 入合并队列（窗口 90s 或满 5 条触发，攒成一条摘要）
//        ④ 免打扰时段只放行 fail / decision（done/progress 顺延到时段结束）
// ══════════════════════════════════════════════════════════════
const MERGE = { items: [], firstAt: 0 };
const NCFG = () => cfg.notify || {};
/** ★ FIX-23：静默标记支持 TTL（内容写 `ttlMinutes=60` 或 `expire=ISO`，起点 = 文件 mtime）；过期 ⇒ 视为未静默 */
function markerExpired(fp) {
  try {
    const txt = fs.readFileSync(fp, 'utf8') || '';
    const mMin = txt.match(/ttlMinutes\s*=\s*(\d+)/i);
    const mExp = txt.match(/expire\s*=\s*([0-9T:\-\s]+)/i);
    if (mExp) { const t = Date.parse(mExp[1].trim()); if (!isNaN(t)) return Date.now() > t; }
    if (mMin) return Date.now() - fs.statSync(fp).mtimeMs > Number(mMin[1]) * 60000;
    return false;   // 空标记 = 永久（沿用旧语义）
  } catch (e) { return false; }
}
function notifyMuted() {
  if (process.env.QQ_NOTIFY === '0' || process.env.QQ_NOTIFY === 'off') return 'env';
  for (const rel of ['.codebuddy/hooks/.qq-notify-off', '.claude/hooks/.qq-notify-off']) {
    try {
      const fp = path.join(PROJ_ROOT, rel);
      if (fs.existsSync(fp) && !markerExpired(fp)) return 'marker';
    } catch (e) {}
  }
  return null;
}
function inQuietHours() {
  const q = NCFG().quietHours;
  if (!q || typeof q.from !== 'number' || typeof q.to !== 'number') return false;
  const h = new Date().getHours();
  return q.from <= q.to ? (h >= q.from && h < q.to) : (h >= q.from || h < q.to);
}
// ══════════════════════════════════════════════════════════════
// ★ FIX-36（2026-09-20）：静默 snooze —— 「xxh / xxmin 内不再提醒」按用户要求执行
//   背景（用户实测失效）：16:45:31「取消。1小时内不要再听」· 16:46:00「取消，并且1h内不再提醒」
//     被 route() 的 cancel 关键词吞掉（只回「请带编号」）⇒ 16:50:03 同类邀请照发。
//   两层语义（互不混淆）：
//     scope='idle'（默认）只停「静置接管邀请」；fail / decision / 不可逆 一律照发
//     scope='all'  等价全局静默（完成通知 + 门禁通知 + idle 邀请）
//   持久化：watcher.snoozeFile（默认 .codebuddy/temp/qqbot-snooze.json）⇒ 服务重启不丢
// ══════════════════════════════════════════════════════════════
const SNOOZE_INTENT_RE = /(静默|免打扰|勿扰|别提醒|不要提醒|不再提醒|别再提醒|停止提醒|snooze)/i;
// 时长：long-first，避免 `m` 抢 `min`；h/hr/hour(s)→3600s，min/m→60s，中文同义
const SNOOZE_DUR_RE = /(\d+(?:\.\d+)?)\s*(个小时|小时|个?分钟|hrs|hr|hours|hour|mins|min|h|m)/i;
const SNOOZE_ALL_RE = /(全部|所有|一切|统统)/;
const SNOOZE_CLEAR_RE = /^(取消|解除|恢复)(静默|提醒|免打扰|勿扰)$/;
const SNOOZE = { until: 0, scope: '', raw: '', setAt: 0, loaded: false };
function snoozeFilePath() {
  const rel = (cfg.watcher && cfg.watcher.snoozeFile) || '.codebuddy/temp/qqbot-snooze.json';
  return path.join(PROJ_ROOT, rel.split(String.fromCharCode(92)).join('/'));
}
function loadSnooze() {
  if (SNOOZE.loaded) return;
  SNOOZE.loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(snoozeFilePath(), 'utf8').replace(/^\uFEFF/, ''));
    SNOOZE.until = Number(j.until || 0);
    SNOOZE.scope = String(j.scope || '');
    SNOOZE.raw = String(j.raw || '');
    SNOOZE.setAt = Number(j.setAt || 0);
  } catch (e) { /* 无文件 / 解析失败 ⇒ 视为未静默（fail-open） */ }
}
function saveSnooze() {
  try {
    const f = snoozeFilePath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ until: SNOOZE.until, scope: SNOOZE.scope, raw: SNOOZE.raw, setAt: SNOOZE.setAt }), 'utf8');
  } catch (e) { log('[SNOOZE WARN] 落盘失败（仅内存生效）：' + e.message); }
}
/**
 * ★ FIX-36：解析静默指令。**意图词与时长必须同时命中**（或显式「取消静默」）才生效，
 *   否则普通聊天（如「5分钟后给我答复」）会被误当指令。
 * 返回 { action:'set'|'clear', sec, scope, raw, capped } 或 null。
 */
function parseSnooze(text) {
  const s = normalizeCmd(text);
  if (SNOOZE_CLEAR_RE.test(s.replace(/\s+/g, ''))) return { action: 'clear', sec: 0, scope: '', raw: s, capped: false };
  if (!SNOOZE_INTENT_RE.test(s)) return null;
  const cfgW = cfg.watcher || {};
  const max = Number(cfgW.snoozeMaxSec || 86400);
  const def = Number(cfgW.snoozeDefaultSec || 3600);
  const m = s.match(SNOOZE_DUR_RE);
  if (!m) {
    // ★ 无时长 ⇒ 仅当**整条消息就是一个静默词**时用默认时长（防「静默安装 / 静默失败 / 静默重试」等
    //   技术用语被误当指令；用户口径要求的是「xxh / xxmin」形式）
    if (!/^(全部|所有|一切|统统)?(静默|免打扰|勿扰|snooze)$/i.test(s.replace(/\s+/g, ''))) return null;
    return { action: 'set', sec: def, scope: SNOOZE_ALL_RE.test(s) ? 'all' : 'idle', raw: String(text || '').trim(), capped: false };
  }
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  const unit = String(m[2]).toLowerCase();
  const per = /^(h|hr|hrs|hour|hours|小时|个小时)$/.test(unit) ? 3600 : 60;
  let sec = Math.round(n * per);
  if (!(sec > 0)) sec = def;
  let capped = false;
  if (sec > max) { sec = max; capped = true; }
  return { action: 'set', sec: sec, scope: SNOOZE_ALL_RE.test(s) ? 'all' : 'idle', raw: String(text || '').trim(), capped: capped };
}
function setSnooze(sec, scope, raw) {
  loadSnooze();
  SNOOZE.until = Date.now() + sec * 1000;
  SNOOZE.scope = scope || 'idle';
  SNOOZE.raw = raw || '';
  SNOOZE.setAt = Date.now();
  saveSnooze();
}
function clearSnooze() { loadSnooze(); SNOOZE.until = 0; SNOOZE.scope = ''; saveSnooze(); }
/** 当前生效的静默（scope 匹配才返回）；过期视为无。fail-open：读不到 ⇒ null */
function snoozeActive(scope) {
  loadSnooze();
  if (!SNOOZE.until || Date.now() >= SNOOZE.until) return null;
  if (SNOOZE.scope === 'all') return { scope: 'all', until: SNOOZE.until };
  return scope === 'idle' ? { scope: 'idle', until: SNOOZE.until } : null;
}
/** 人类可读「至 HH:MM（剩余 xx min）」 */
function snoozeLabel(until) {
  const d = new Date(until);
  const p = (n) => (n < 10 ? '0' : '') + n;
  const mins = Math.max(0, Math.round((until - Date.now()) / 60000));
  return p(d.getHours()) + ':' + p(d.getMinutes()) + '（剩余 ' + mins + 'min）';
}
function firstLine(s) { return String(s || '').split(/\r?\n/)[0].slice(0, 120); }
// ★ FIX-39（2026-09-21）：汇总摘要行 —— 取首行；超 120 字时截到 117 + '…'
//   起因（实证）：完成通知正文 177 字被 `slice(0,120)` 硬切成半句、**无任何收尾标记** ⇒ 用户误判「消息被截断」。
//   口径：只要发生截断，必须留下「…」痕迹，与网络/平台截断区分开。
const MERGE_LINE_MAX = 120;
function summaryLine(s) {
  const t = String(s || '').split(/\r?\n/)[0];
  return t.length > MERGE_LINE_MAX ? t.slice(0, MERGE_LINE_MAX - 3) + '…' : t;
}
/** ★ FIX-39：汇总文本渲染（纯函数，供离线自测复用）—— n=1 直发原文；n≥2 才摘要 */
function renderMergeText(items) {
  if (!items || !items.length) return '';
  if (items.length === 1) return String(items[0].content || '');   // 单条：不套「汇总」壳、不截断（与 --dry-run 所见一致）
  const kinds = Array.from(new Set(items.map((x) => x.kind))).join('/');
  return '【汇总 · ' + items.length + ' 条 · ' + kinds + '】\n'
    + items.map((x, i) => (i + 1) + '. ' + summaryLine(x.content)).join('\n');
}
function enqueueMerge(kind, content) {
  const now = Date.now();
  if (!MERGE.items.length) MERGE.firstAt = now;
  MERGE.items.push({ kind, content, at: now });
  log('[MERGE] +1 kind=' + kind + ' n=' + MERGE.items.length);
  if (MERGE.items.length >= (NCFG().mergeMax || 5)) flushMerge(true);
}
function flushMerge(force) {
  if (!MERGE.items.length) return;
  const win = NCFG().mergeWindowMs || 90000;
  if (!force && Date.now() - MERGE.firstAt < win) return;
  if (inQuietHours()) return;                    // 免打扰：等时段结束（fail/decision 不入队，不受此限）
  const items = MERGE.items; MERGE.items = []; MERGE.firstAt = 0;
  const text = renderMergeText(items);
  send(text)
    .then((st) => log('[MERGE FLUSH] HTTP ' + st + ' n=' + items.length + ' len=' + text.length))
    .catch((e) => log('[MERGE FLUSH ERR] ' + e.message));
}
setInterval(() => flushMerge(false), 15000);

// ══════════════════════════════════════════════════════════════
// A) Watcher 模块 —— IDE 会话静置检测（notify-watcher.ps1 的 Node 重写）
//    ★ 六个必须照搬的坑（均为既有实测教训）：
//      1. 逐文件过滤未来时间戳再取 max —— 否则时钟偏差文件使 idle 恒负、永不推送
//      2. 多 history 目录发现（一台机可达十余个）+ 每 ~60s 重发现
//      3. sticky session —— 活跃会话的深层写入不刷新祖先目录 mtime，按目录 mtime 取 top-N 会漏
//      4. 廉价档只扫 top-5 会话 + sticky；每 ~2min 全量扫一次（覆盖切换会话）
//      5. 去重：lastActivity > lastNotified 才推（一个静置周期只推一条）
//      6. 纯 Node 无需再处理 node 路径/代码页，但 LOCALAPPDATA 缺失需兜底
// ══════════════════════════════════════════════════════════════
const IDLE_TEXT = 'CodeBuddy 会话已静置：任务完成，或在等待你确认（运行命令/输入）';
const WATCH = {
  enabled: !args.noWatch,
  idleMs: (args.idle > 0 ? args.idle : (cfg.watcher && cfg.watcher.idleSeconds) || 30) * 1000,
  root: args.watchRoot || '',
  dirs: [],
  sticky: new Map(),
  tick: 0,
  lastActivity: Date.now(),
  lastNotified: Date.now(),
  // ★ FIX-17：静置推送策略（不再只发单向通知）
  autoQueue: !(cfg.watcher && cfg.watcher.autoQueue === false),   // 默认 true：登记成「#N 待确认」，QQ 可回复
  autoHandoff: !!(cfg.watcher && cfg.watcher.autoHandoff),        // 默认 false：开启后确认即自动 headless 接管
  handoffPrompt: (cfg.watcher && cfg.watcher.handoffPrompt) || '',
  handoffBrief: (cfg.watcher && cfg.watcher.handoffBrief) || '',   // ★ FIX-28：idle 消息里「确认后将执行」的一句话摘要
  // ★ FIX-35（方案 G）：接管邀请不再「会话一活动就自动作废」—— 误报根因 = 把「会话被用了」
  //   （含闲聊/别的话题）当成「任务被推进」。判定改在「确认#N」时由 handoffGuard() 双条件裁决。
  autoSupersede: !!(cfg.watcher && cfg.watcher.autoSupersede),     // 默认 false；true = 回滚 FIX-17c① 旧行为
  handoffGuardMode: (cfg.watcher && cfg.watcher.handoffGuardMode) || 'write-tool',  // session(档1) | write-tool(档2) | task-only(档3)
  lastSession: '',                                                // ★ FIX-17b：当前最活跃会话目录（定位 + 按会话去重）
  lastConv: '',                                                   // ★ FIX-26：当前最活跃的**会话**目录（{ws}/{convId}）
  lastHeartbeatAt: Date.now(),                                     // ★ FIX-24：上次心跳时刻
  // ★ FIX-25：按「会话（工作区容器目录）」分桶的活跃时间 —— 替代「全局单一 lastActivity」做判定，
  //   杜绝「别的会话/别的工作区在动 ⇒ 本会话的待确认项被误作废 / 接管被误拦」。
  //   Map<sessionDir, { lastActivity, lastNotified }>；全局 lastActivity 仅作镜像（/health · 心跳 · 定位）。
  activity: new Map(),
  // ★ FIX-17c：接管前活动闸门 —— 会话在该窗口内仍有写入时，视为「人还在」，拒绝 headless 代跑
  handoffGuardMs: ((cfg.watcher && cfg.watcher.handoffGuardSec != null ? Number(cfg.watcher.handoffGuardSec) : 120) * 1000),
  // ★ FIX-36（2026-09-20）：治「在干活也被判静置」的三闸 + 静默（详见 README FIX-36）
  //   取证：全天 55 条登记 idle 值全在 90~100s ⇒ 旧阈值只是「到点即发」的扳机，从未起区分作用
  idleMinGapMs: ((cfg.watcher && cfg.watcher.idleInviteMinGapSec != null ? Number(cfg.watcher.idleInviteMinGapSec) : 600) * 1000),
  idleCooldownMs: ((cfg.watcher && cfg.watcher.idleInviteCooldownSec != null ? Number(cfg.watcher.idleInviteCooldownSec) : 1800) * 1000),
  taskGate: !(cfg.watcher && cfg.watcher.taskGate === false),
  taskGateRecheckMs: ((cfg.watcher && cfg.watcher.taskGateRecheckSec != null ? Number(cfg.watcher.taskGateRecheckSec) : 60) * 1000),
  // ★ RESUME-1（2026-09-29）：第 ④ 闸 —— 模式 D（QQ 成员代等）等待期豁免。
  //   本会话有未决的非 idle 项 ⇒ agent 正在等用户在 QQ 回复（模式 D 的预期形态），
  //   静置不该被当成「人离开了」⇒ 不登记接管邀请（否则用户误确认会起 headless 与原会话撞车）。
  //   默认 true；watcher.skipIdleWhenOpenAsk=false 可关闭。
  skipIdleWhenOpenAsk: !(cfg.watcher && cfg.watcher.skipIdleWhenOpenAsk === false),
  lastIdleInviteAt: 0,
  taskQuiet: { at: 0, ms: -1 },
  taskGateSkips: 0,
};
// ★ FIX-36：不变式 —— 静置阈值必须 > 接管活动闸门，否则「邀请发出即注定被拒」（实测 90s < 120s）。
(function enforceIdleInvariant() {
  if (args.idle > 0) return;                       // 显式 --idle 视为调试覆盖，不干预
  if (WATCH.idleMs <= WATCH.handoffGuardMs) {
    const min = WATCH.handoffGuardMs + 60 * 1000;
    log('[WARN] watcher.idleSeconds=' + (WATCH.idleMs / 1000) + 's <= handoffGuardSec=' + (WATCH.handoffGuardMs / 1000)
      + 's ⇒ 自动抬到 ' + (min / 1000) + 's（FIX-36 不变式）');
    WATCH.idleMs = min;
  }
})();

function discoverHistoryDirs() {
  if (WATCH.root) return [WATCH.root];
  const base = path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data');
  const t0 = Date.now();
  const set = new Set();
  // ① 快扫：固定层级 Data/{l1}/CodeBuddyIDE/{l2}/history（覆盖绝大多数安装）
  try {
    for (const l1 of fs.readdirSync(base, { withFileTypes: true })) {
      if (!l1.isDirectory()) continue;
      const ideDir = path.join(base, l1.name, 'CodeBuddyIDE');
      if (!fs.existsSync(ideDir)) continue;
      for (const l2 of fs.readdirSync(ideDir, { withFileTypes: true })) {
        if (!l2.isDirectory()) continue;
        const h = path.join(ideDir, l2.name, 'history');
        if (fs.existsSync(h)) set.add(h);
      }
    }
  } catch (e) { /* 交由下方递归兜底 */ }
  // ② 校正：深度受限递归（覆盖层级变体；命中 history 即停）—— 防止目录数静默缩水
  const walk = (d, depth) => {
    if (depth > 5) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (e.name === 'history' && full.indexOf('CodeBuddyIDE') >= 0) { set.add(full); continue; }
      walk(full, depth + 1);
    }
  };
  walk(base, 0);
  const out = [...set];
  const ms = Date.now() - t0;
  if (ms > 300) log('WATCH discover slow: ' + ms + 'ms dirs=' + out.length);
  return out;
}

/** 目录下最大文件 mtime（毫秒）；跳过未来时间戳（坑 1）；
 *  ★ 性能：限制递归深度与文件数 —— 超大会话目录曾把 event loop 拖住数秒（HTTP 请求超时） */
function maxMtimeUnder(dir, now, maxDepth, maxFiles) {
  let max = null, seen = 0;
  const stack = [{ d: dir, lv: 0 }];
  while (stack.length) {
    const cur = stack.pop();
    let ents; try { ents = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const full = path.join(cur.d, e.name);
      if (e.isDirectory()) { if (cur.lv < maxDepth) stack.push({ d: full, lv: cur.lv + 1 }); continue; }
      if (++seen > maxFiles) return max;
      let st; try { st = fs.statSync(full); } catch (err) { continue; }
      const t = st.mtimeMs;
      if (t > now) continue;
      if (max === null || t > max) max = t;
    }
  }
  return max;
}

/**
 * 返回 { max, per }：
 *   max = 全局最新写入时间（镜像，/health · 心跳 · 会话定位用）
 *   per = Map<sessionDir, mtime> —— ★ FIX-25：每个被扫描会话目录各自的最新写入（此前只保留全局最大者，其余丢弃）
 */
function newestWriteTime(full) {
  const now = Date.now();
  let max = null;
  const per = new Map();
  for (const h of WATCH.dirs) {
    let names; try { names = fs.readdirSync(h, { withFileTypes: true }); } catch (e) { continue; }
    const sessions = names.filter((e) => e.isDirectory() && isSessionShape(e.name)).map((e) => path.join(h, e.name));
    let pick;
    if (full) {
      pick = sessions;
    } else {
      const withT = sessions.map((p) => { let t = 0; try { t = fs.statSync(p).mtimeMs; } catch (e) {} return { p, t }; });
      withT.sort((a, b) => b.t - a.t);
      pick = withT.slice(0, 5).map((x) => x.p);
      const st = WATCH.sticky.get(h);                                    // 坑 3
      if (st && pick.indexOf(st) < 0) pick.push(st);
    }
    for (const s of pick) {
      // ★ FIX-26：指纹下沉到 `{convId}` 子目录 —— 同一工作区内的不同会话不再共享指纹；
      //   `index.json`（新建/切换会话时写）不在任何会话目录内 ⇒ 天然不计入活动证据。
      const convs = topConvDirs(s, CONV_SCAN_N);
      const keys = convs.length ? convs : [s];
      for (const k of keys) {
        let m = null;
        try { m = fs.statSync(k).mtimeMs; } catch (er) {}
        // 会话目录只需深度 1（消息文件）；容器级回退才用深度 2
        const m2 = maxMtimeUnder(k, now, convs.length ? 1 : 2, convs.length ? 300 : 3000);
        if (m2 !== null && (m === null || m2 > m)) m = m2;
        if (m === null || m > now) continue;
        const prev = per.get(k);
        if (prev === undefined || m > prev) per.set(k, m);   // ★ FIX-25：分桶记录（不再丢弃非最大者）
        if (max === null || m > max) {
          max = m; WATCH.sticky.set(h, s);
          WATCH.lastSession = s;                  // ★ FIX-17b：容器级（会话名定位用）
          WATCH.lastConv = convs.length ? k : ''; // ★ FIX-26：会话级（/health 展示 + 对账）
        }
      }
    }
  }
  return { max: max, per: per };
}

// ★ FIX-17b：静置消息必须能定位「哪个会话 / 哪个迭代 / 卡在哪一步」——
//   多会话并行或工位外收到推送时，光有"会话已静置"无法判断该确认哪一条。
function readConversationMeta(wsDir, convId) {
  // wsDir = history 下的一级目录（工作区容器）；其 index.json 的 conversations[] 带 name + lastMessageAt
  // ⇒ 取 lastMessageAt 最大者 = 该工作区最近活跃的会话（ISO 字符串字典序 = 时间序）
  try {
    if (!wsDir) return null;
    const idx = JSON.parse(fs.readFileSync(path.join(wsDir, 'index.json'), 'utf8'));
    const list = ((idx && idx.conversations) || []).filter((c) => c && c.id);
    if (!list.length) return null;
    // ★ FIX-26：指纹已下沉到会话级 ⇒ 传 convId 时**精确**取该会话，不得再用「最近活跃者」顶替
    if (convId) {
      const hit = list.filter((c) => String(c.id) === String(convId))[0];
      if (hit) return { id: String(hit.id), name: hit.name ? String(hit.name) : '', at: hit.lastMessageAt || '' };
    }
    list.sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
    return { id: String(list[0].id), name: list[0].name ? String(list[0].name) : '', at: list[0].lastMessageAt || '' };
  } catch (e) { return null; }
}
/**
 * ★ FIX-26：工作区容器下「最近活跃的 N 个会话目录（{convId}）」，按目录 mtime 降序。
 *   实证（2026-09-18）：`history/<ws>/` 下每个会话一个子目录，**目录 mtime == 该会话的 lastMessageAt**（毫秒级吻合）；
 *   而 `index.json` 只在「新建 / 切换会话」时写 ⇒ **它不是任何会话的活动证据**（用户复现案例的根因）。
 *   返回空数组 = 非标准结构 ⇒ 调用方退回容器级。
 */
/**
 * ★ FIX-36：会话/容器指纹形态白名单 —— 排除形如 `index.json.lock` 的锁目录
 *   （实测被当成会话登记过：2026-09-20 #48/#55 `session=index.js`）。
 *   会话 id = 32 位 hex；容器 = GUID / base64 路径，**均不含 `.`** ⇒ 含点即非会话。
 */
function isSessionShape(name) {
  const n = String(name || '');
  return !!n && n.indexOf('.') < 0;
}
function topConvDirs(wsDir, n) {
  try {
    const ents = fs.readdirSync(wsDir, { withFileTypes: true });
    const dirs = [];
    for (const e of ents) {
      if (!e.isDirectory() || !isSessionShape(e.name)) continue;
      const full = path.join(wsDir, e.name);
      let t = 0;
      try { t = fs.statSync(full).mtimeMs; } catch (er) { continue; }
      dirs.push({ p: full, t: t });
    }
    dirs.sort((a, b) => b.t - a.t);
    return dirs.slice(0, n).map((x) => x.p);
  } catch (e) { return []; }
}
// ★ FIX-26：每个工作区容器最多下钻多少个会话目录（性能护栏；176 个会话的容器实测存在）
const CONV_SCAN_N = Number((cfg.watcher && cfg.watcher.convScanN) || 10);

function readIterationContext() {
  try {
    const rel = (cfg.watcher && cfg.watcher.contextDir) || '.codebuddy/skills/iteration-workflow/runtime';
    const rt = path.join(PROJ_ROOT, rel.split(String.fromCharCode(92)).join('/'));
    let id = '';
    try { id = fs.readFileSync(path.join(rt, 'ACTIVE'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim(); } catch (e) {}
    if (!id || id === 'none') return null;
    const out = { id, phase: '', status: '', pending: [], more: 0 };
    let raw = '';
    try { raw = fs.readFileSync(path.join(rt, id + '.state.yaml'), 'utf8'); } catch (e) { return out; }
    const pick = (re) => { const m = raw.match(re); return m ? String(m[1]).trim() : ''; };
    out.phase = pick(/^current_phase:\s*"?([^"\r\n]+?)"?\s*$/m);
    out.status = pick(/^phase_status:\s*"?([^"\r\n]+?)"?\s*$/m);
    out.pauseReason = pick(/^pause_reason:\s*"?([^"\r\n]+?)"?\s*$/m);   // ★ RESUME-3 批次 2（2026-10-01）：静置邀请携带"当前卡点"
    const list = [];
    let curId = '', curName = '';
    for (const ln of raw.split(/\r?\n/)) {
      const mi = ln.match(/^\s*-\s*id:\s*"([^"]+)"/);
      if (mi) { curId = mi[1]; curName = ''; continue; }
      const mn = ln.match(/^\s*name:\s*"([^"]+)"/);
      if (mn) { curName = mn[1]; continue; }
      if (/^\s*status:\s*"?pending"?\s*$/.test(ln) && curId) list.push(curId + (curName ? ' ' + curName : ''));
    }
    out.pending = list.slice(0, 3);
    out.more = Math.max(0, list.length - 3);
    return out;
  } catch (e) { return null; }
}
/**
 * ★ FIX-35：当前 ACTIVE 迭代 ID（取不到 ⇒ ''，调用方 fail-open）。
 */
function readActiveIterationId() {
  try {
    const rel = (cfg.watcher && cfg.watcher.contextDir) || '.codebuddy/skills/iteration-workflow/runtime';
    const rt = path.join(PROJ_ROOT, rel.split(String.fromCharCode(92)).join('/'));
    const id = fs.readFileSync(path.join(rt, 'ACTIVE'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim();
    return (id && id !== 'none') ? id : '';
  } catch (e) { return ''; }
}
/**
 * ★ FIX-35：任务域「水位」= max(runtime/{ID}.state.yaml mtime, docs/iterations/{ID}/** mtime)。
 *   语义：任务域被推进 ⇔ 有人在处理该迭代（agent 每步回写 state.yaml / 写迭代文档）。
 *   ⚠ 已知边界（用户确证）：state.yaml 是**步骤级回写点**、不是心跳 ⇒ 单步执行中途可能不写；
 *     故本条件只作为「确认闸门」的**附加**判定，会话写类条件与接管锁仍各自兜底。
 *   取不到 ⇒ null（调用方 fail-open，不据此拒绝）。
 */
function readTaskMark(iterId) {
  if (!iterId) return null;
  try {
    const rel = (cfg.watcher && cfg.watcher.contextDir) || '.codebuddy/skills/iteration-workflow/runtime';
    const rt = path.join(PROJ_ROOT, rel.split(String.fromCharCode(92)).join('/'));
    const now = Date.now();
    let max = null;
    const up = (t) => { if (t !== null && t !== undefined && (max === null || t > max)) max = t; };
    let st = null; try { st = fs.statSync(path.join(rt, iterId + '.state.yaml')); } catch (e) { st = null; }
    if (st) up(st.mtimeMs);
    up(maxMtimeUnder(path.join(PROJ_ROOT, 'docs', 'iterations', iterId), now, 2, 300));
    return max;
  } catch (e) { return null; }
}
/**
 * ★ FIX-36：任务域「静置时长」（毫秒）—— 把 readTaskMark 的 mtime 水位当作**第二个活动信号**：
 *   该迭代的 state/产出刚被写过 ⇒ 有人在推进（含 Team 波次 / 别的会话）⇒ 不该发静置邀请。
 *   返回 -1 = 取不到（fail-open，不据此拦截）；结果按 taskGateRecheckMs 缓存，避免 5s 轮询反复扫盘。
 */
function taskDomainQuietMs() {
  const now = Date.now();
  if (now - WATCH.taskQuiet.at < WATCH.taskGateRecheckMs) return WATCH.taskQuiet.ms;
  const cur = readTaskMark(readActiveIterationId());
  WATCH.taskQuiet = { at: now, ms: (cur === null ? -1 : (now - cur)) };
  return WATCH.taskQuiet.ms;
}
// ★ FIX-20：watcher 只看「文件 mtime」，纯问答/闲聊静置也会被当成"回合结束"⇒ 读会话最后一条
//   assistant 判断本轮是否真有工具产出；读不到/解析失败一律 fail-open（宁可误推，不可漏推）。
/** 会话目录下最新的会话文件（复用原查找逻辑：深度 ≤2，跳过 index.json） */
function newestSessionFile(wsDir) {
  let best = null, bt = 0;
  const stack = [{ d: wsDir, lv: 0 }];
  while (stack.length) {
    const cur = stack.pop();
    let ents; try { ents = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (e) { continue; }
    for (const en of ents) {
      const full = path.join(cur.d, en.name);
      if (en.isDirectory()) { if (cur.lv < 2) stack.push({ d: full, lv: cur.lv + 1 }); continue; }
      if (!/\.json$/i.test(en.name) || en.name === 'index.json') continue;
      let st; try { st = fs.statSync(full); } catch (err) { continue; }
      if (!best || st.mtimeMs > bt) { best = full; bt = st.mtimeMs; }
    }
  }
  return best;
}

/**
 * 扫描会话文件 → { sawKnown, calls:[{name,target}] }。
 * ★ FIX-22 实证（2026-09-18）：工具调用是**独立行** {"type":"function_call","name":"Edit","arguments":"<JSON字符串>"}，
 *   assistant 消息只有 output_text ⇒ 旧判定 `o.type==='assistant'` + /tool_use/ **恒不匹配**（"纯问答跳过"一直失效）。
 *   sawKnown=false = 该格式不认识 ⇒ 调用方 fail-open（宁可误推，不可漏推）。
 */
function scanSessionTools(file) {
  const out = { sawKnown: false, calls: [] };
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-400);
    for (const ln of lines) {
      let o = null;
      try { o = JSON.parse(ln); } catch (e) { continue; }
      if (!o || !o.type) continue;
      if (String(o.type) === 'function_call') {
        out.sawKnown = true;
        let args = o.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
        args = args || {};
        let target = String(args.file_path || args.filePath || args.command || args.pattern || '').replace(/\\/g, '/');
        const pn = PROJ_ROOT.replace(/\\/g, '/');
        const i = target.indexOf(pn);
        if (i >= 0) target = target.slice(i + pn.length + 1);
        out.calls.push({ name: String(o.name || '?'), target });
      } else if (['message', 'reasoning', 'function_call_result'].indexOf(String(o.type)) >= 0) {
        out.sawKnown = true;
      }
    }
  } catch (e) { /* 读不到 ⇒ sawKnown 保持 false */ }
  return out;
}

function sessionHasToolUse(wsDir) {
  try {
    const best = newestSessionFile(wsDir);
    if (!best) return true;
    const s = scanSessionTools(best);
    if (!s.sawKnown) return true;
    return s.calls.length > 0;
  } catch (e) { return true; }
}

// ══════════════════════════════════════════════════════════════
// ★ FIX-35（2026-09-19 · 方案 G · 档 2）：确认闸门「写类工具」条件
//   背景（用户三轮报障）：FIX-17c① 的「会话一有写入就作废接管邀请」把
//   「会话被用了」（闲聊/问密码/聊别的话题）误当成「任务被推进」⇒ 误报。
//   本函数族只回答一个问题：**该会话最近有没有「落盘/执行命令」类动作**——
//   纯问答一律不算（用户诉求：「明确在处理任务」才算有人在动）。
// ══════════════════════════════════════════════════════════════
/**
 * ★ FIX-35：写类工具判定（纯函数，供离线自测）。
 *   命中 = 会写文件/执行命令（headless 并行存在互改风险）；
 *   只读/导航类（read_file / search / list / lsp / task / todo_write / update_memory …）一律 false。
 *   保守口径：未识别的新工具名 ⇒ false（fail-open；安全由任务域条件 + 接管锁 FIX-17e 兜底）。
 */
const WRITE_TOOL_RE = /^(write|edit|replace|create|delete|remove|move|rename|apply|patch|multi_edit|str_replace|notebook_edit|execute|run|bash|shell|cmd|powershell|mkdir|install)/i;
function isWriteTool(name) {
  const n = String(name || '').trim();
  return !!n && WRITE_TOOL_RE.test(n);
}
/**
 * ★ FIX-35（档 2）：窗口内该会话是否出现过「写类工具调用」—— 命中返回工具名，未命中返回 ''。
 *   数据源 = 会话目录 `messages/*.json` 中 **mtime 在窗口内** 的文件（IDE 存储里消息体是转义 JSON 字符串，
 *   工具名形如 `\"toolName\":\"replace_in_file\"` ⇒ 先还原转义引号再正则提取）。
 *   ★ 只在「确认#N」/答复时调用（不在 watch 循环里）⇒ 无常态开销；fail-open：读不到 ⇒ ''（不据此拦）。
 */
//   ★ FIX-34c（2026-10-03）：新增 afterMs（基线）—— 传入时 cutoff 取 max(窗口, 基线)，
//     即「登记前的写类操作不再计数」（修「agent 问→用户秒答必被拦」）；不传 = 原口径（fail-safe）。
function sessionRecentWriteTool(sess, windowMs, afterMs) {
  try {
    if (!sess) return '';
    const cutoff = Math.max(Date.now() - (Number(windowMs) || 0), Number(afterMs) || 0);
    const files = [];
    for (const d of [path.join(sess, 'messages'), sess]) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
      for (const en of ents) {
        if (en.isDirectory() || !/\.json$/i.test(en.name) || en.name === 'index.json') continue;
        const full = path.join(d, en.name);
        let st; try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.mtimeMs >= cutoff) files.push({ p: full, t: st.mtimeMs });
      }
      if (files.length) break;                      // messages/ 命中即可；容器级回退仅用于非标准结构
    }
    files.sort((a, b) => b.t - a.t);
    const re = /"toolName"\s*:\s*"([^"]+)"/g;
    for (const f of files.slice(0, 20)) {           // 性能护栏
      let raw = ''; try { raw = fs.readFileSync(f.p, 'utf8'); } catch (e) { continue; }
      const s = raw.replace(/\\"/g, '"');
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        if (isWriteTool(m[1])) return m[1];
      }
    }
    return '';
  } catch (e) { return ''; }
}

/** ★ FIX-24：心跳文案里的「当前动作」（尽力而为，取不到返回空） */
function recentActionLabel(wsDir) {
  try {
    const best = newestSessionFile(wsDir);
    if (!best) return '';
    const calls = scanSessionTools(best).calls;
    const c = calls.filter((x) => x.target).slice(-1)[0] || calls.slice(-1)[0];
    if (!c) return '';
    let t = String(c.target || '');
    if (t.length > 60) { const i = t.lastIndexOf('/'); t = (i > 0 ? '…/' + t.slice(i + 1) : t.slice(0, 60)); }
    return c.name + ' ' + t;
  } catch (e) { return ''; }
}
function buildIdlePrompt(idleSec, sess, openIds) {
  // ★ FIX-26：sess 多为**会话目录** `{ws}/{convId}` ⇒ 容器 = 其父目录（凭 index.json 判层级，兼容容器级回退）
  let wsDir = sess || WATCH.lastSession || '';
  let convId = '';
  try {
    if (wsDir && !fs.existsSync(path.join(wsDir, 'index.json'))) {
      const parent = path.dirname(wsDir);
      if (parent && fs.existsSync(path.join(parent, 'index.json'))) { convId = path.basename(wsDir); wsDir = parent; }
    }
  } catch (e) { /* 判不了就按容器级处理 */ }
  const L = ['会话静置 ' + idleSec + 's（' + ts() + '）'];
  const meta = readConversationMeta(wsDir, convId);
  if (meta) L.push('最近会话：' + (meta.name || '(未命名)') + ' [' + meta.id.slice(0, 8) + ']');
  // ★ FIX-36：该值实为**会话** id（FIX-26 已把指纹下沉到 convId）⇒ 标签纠正 + 容器级兜底显式标注
  else if (wsDir) L.push('会话标识：' + path.basename(wsDir).slice(0, 8) + (convId ? '' : '（容器级；未能定位具体会话）'));
  L.push('工作区：' + path.basename(PROJ_ROOT));
  const it = readIterationContext();
  if (it) {
    L.push('迭代：' + it.id + '（阶段 ' + (it.phase || '?') + ' · ' + (it.status || '?') + '）');
    // ★ RESUME-3 批次 2（2026-10-01）：确认门等待期静置 ⇒ 邀请文案带"当前卡点"（恢复后知道停在哪；pattern-乙死亡空档缓解）
    if (it.status === 'blocked' && it.pauseReason) L.push('当前卡点：' + it.pauseReason);
    if (it.pending.length) L.push('待办步骤：' + it.pending.join(' ｜ ') + (it.more ? ' …（另 ' + it.more + ' 项）' : ''));
  }
  // ★ QQ-WAKE-1（2026-09-30）：未决项角标 —— 工位外可识别"还有 #N 等你回复"（不改变是否推送的判定）
  if (Array.isArray(openIds) && openIds.length) {
    L.push('★ 另有未决项：' + openIds.map((n) => '#' + n).join('、') + ' 等待你回复（回「确认#N」即可；主 agent 已停时答复仍会落盘，下一回合开工读回）');
  }
  return L.join('\n');
}
/**
 * ★ FIX-30（2026-09-19）：idle 消息的「接续入口」事实 —— 如实描述 state.yaml 现状，不臆断「下一阶段」。
 *   背景：`readIterationContext()` 只认 `status: "pending"` 的步骤 ⇒ 阶段已 completed 时该项为空，
 *   原消息整行静默省略 ⇒ 用户看不到"接管后会动什么"（恰是最需要交代的时刻）。
 */
function buildNextHint() {
  try {
    const it = readIterationContext();
    if (!it) return '';
    if (it.pending.length) return '从待办步骤继续：' + it.pending.join(' ｜ ') + (it.more ? ' …（另 ' + it.more + ' 项）' : '');
    // ★ RESUME-3 批次 2（2026-10-01）：blocked 优先交代卡点（确认门等待/超时退化场景）
    if (it.status === 'blocked' && it.pauseReason) return '阶段 ' + it.phase + ' 等待中（blocked）：' + it.pauseReason;
    if (it.phase && it.status === 'completed') return '当前阶段 ' + it.phase + ' 已 completed、无 pending 步骤 ⇒ 接管会话从「阶段推进」入口继续';
    if (it.phase) return '当前阶段 ' + it.phase + '（' + (it.status || '?') + '）';
    return '';
  } catch (e) { return ''; }
}
/**
 * ★ FIX-24（2026-09-18）：心跳文案 —— 长任务期间「在做什么」的可见性。
 *   顺序：当前动作（最细）→ 迭代阶段/待办 → 会话定位。动作取不到时降级不报错。
 */
function buildHeartbeatText(ms) {
  const L = ['💓 进度心跳 · 会话持续活跃 ' + Math.round(ms / 60000) + ' 分钟（' + ts() + '）'];
  L.push(MSG_SEP);                                   // ★ FIX-37c：与待确认 / 手动心跳统一（20 字符）
  const meta = readConversationMeta(WATCH.lastSession);
  if (meta) L.push('最近会话：' + (meta.name || '(未命名)') + ' [' + String(meta.id).slice(0, 8) + ']');
  const it = readIterationContext();
  if (it) {
    L.push('迭代：' + it.id + '（阶段 ' + (it.phase || '?') + '）');
    if (it.pending.length) L.push('待办步骤：' + it.pending.join(' ｜ ') + (it.more ? ' …（另 ' + it.more + ' 项）' : ''));
  }
  // ★ FIX-36：原引用未定义的 `wsDir` ⇒ ReferenceError 被 watchLoop 的 try/catch 吞掉
  //   （实测 2026-09-20 16:13:36 / 16:53:40 `WATCH ERR: wsDir is not defined`，该 tick 的静置登记被整体跳过）
  const act = recentActionLabel(WATCH.lastConv || WATCH.lastSession);
  if (act) L.push('当前动作：' + act);
  return L.join('\n');
}
function watchLoop() {
  setInterval(() => {
    if (!WATCH.enabled) return;
    WATCH.tick++;
    try {
      if (WATCH.tick % 12 === 0 && !WATCH.root) {                         // 坑 2：每 ~60s 重发现
        const red = discoverHistoryDirs();
        if (red.length) { WATCH.dirs = red; log('WATCH re-discovered historyDirs=' + red.length); }
      }
      // ★ FIX-25：全量周期 ~120s → ~60s —— 分桶后「漏扫」会使某个桶值陈旧 ⇒ 误判静置，须 < idleMs
      const full = (WATCH.tick === 1) || (WATCH.tick % 12 === 0);
      const nw = newestWriteTime(full);
      // ★ FIX-25：分桶更新 —— 每个会话各自判定「静置 → 活动」，且只作废它自己的 idle 项
      const per = (nw && nw.per) || null;
      if (per && per.size) {
        for (const kv of per) {
          const s = kv[0], m = kv[1];
          let b = WATCH.activity.get(s);
          // ★ 新桶只建立基线（lastNotified 同步 = m ⇒ 不会立即登记；seen=false ⇒ 未观察到活动前不推送）
          //   否则服务启动时全量扫描会一次性把所有历史会话都登记成待确认项（实测一次刷出 100+ 条）
          if (!b) { b = { lastActivity: m, lastNotified: m, seen: false }; WATCH.activity.set(s, b); continue; }
          if (m > b.lastActivity) {
            // ★ FIX-35（方案 G · 取代 FIX-17c①）：不再「会话一活动就自动作废接管邀请」——
            //   误报根因 = 把「会话被用了」（闲聊/问密码/聊别的话题）当成「任务被推进」。
            //   判定已移交「确认#N」时的 handoffGuard()（写类工具 / 任务域 双条件），此处仅记录。
            //   `watcher.autoSupersede=true` 可回滚到旧行为。
            const wasIdle = (Date.now() - b.lastActivity) >= WATCH.idleMs;
            b.lastActivity = m;
            b.seen = true;                       // ★ 本次运行期内观察到该会话活动过
            if (wasIdle) {
              if (WATCH.autoSupersede) supersedeIdlePending(s);
              else log('[WATCH] 会话恢复活动（仅记录，邀请保留 ⇒ 改由确认闸门裁决）session=' + path.basename(s).slice(0, 8));
            }
          }
        }
        // 桶清理：24h 未更新 ⇒ 丢弃（防长期运行内存增长）
        if (WATCH.tick % 12 === 0) {
          const cutoff = Date.now() - 24 * 3600 * 1000;
          for (const kv of WATCH.activity) if (kv[1].lastActivity < cutoff) WATCH.activity.delete(kv[0]);
        }
      }
      // 全局镜像（/health · 心跳 · 会话定位用）
      if (nw && nw.max && nw.max > WATCH.lastActivity) WATCH.lastActivity = nw.max;
      const idle = Date.now() - WATCH.lastActivity;
      // ★ FIX-24：长任务心跳 —— 会话一直在动（idle < idleMs）却超过 heartbeatMs 没任何推送
      //   ⇒ 自动发一条 progress（入合并队列 ⇒ 免打扰顺延、与 done 汇总），避免长任务期间完全失联。
      const hbMs = Number(NCFG().heartbeatMs || 0);
      const hbElapsed = Date.now() - WATCH.lastHeartbeatAt;
      if (hbMs > 0 && idle < WATCH.idleMs && hbElapsed >= hbMs) {
        WATCH.lastHeartbeatAt = Date.now();
        enqueueMerge('progress', buildHeartbeatText(hbElapsed));
        log('PUSH(QUEUE): heartbeat ' + Math.round(hbElapsed / 1000) + 's（会话持续活跃，非静置）');
      }
      // ★ FIX-25：按「会话」各自判定静置并登记（旧逻辑只看全局最新会话 ⇒ 其它会话静置永不推送）
      for (const kv of WATCH.activity) {
        const sess = kv[0], b = kv[1];
        // ★ 仅对「本次运行期内观察到过活动」的会话登记 —— 杜绝启动时把历史会话批量登记成待确认项
        if (!b.seen) continue;
        const idleS = Date.now() - b.lastActivity;
        if (idleS < WATCH.idleMs || b.lastActivity <= b.lastNotified) continue;   // 坑 5：去重
        b.lastNotified = Date.now();
        // ★ FIX-20：无工具产出 ⇒ 纯问答/闲聊静置，不算「任务结束」（后续真有活动会重新触发）
        if (NCFG().skipNoToolUse !== false && !sessionHasToolUse(sess)) {
          log('PUSH skip: 会话无工具产出（纯问答/闲聊）session=' + path.basename(sess).slice(0, 8));
          continue;
        }
        const idleSec = Math.round(idleS / 1000);
        // ★ FIX-17b：按「会话」去重（同一会话已有未决 idle 项才跳过）—— 多会话并行时各自登记、互不吞并
        const idlePending = [...pending.values()].some((p) => p.status === 'pending' && p.kind === 'idle' && p.session === sess);
        // ★ FIX-36（2026-09-20）：登记前三闸 —— 治「在干活也被判静置」；成本从低到高，命中即跳过。
        //   不写 lastNotified ⇒ 条件消失后下次扫描自动补发（自愈，无需人工干预）。
        if (b.cooldownUntil && Date.now() < b.cooldownUntil) {                    // ① 会话冷却（结算后 N 分钟不重发）
          log('IDLE SKIP: 会话冷却中（剩余 ' + Math.round((b.cooldownUntil - Date.now()) / 1000) + 's）session=' + path.basename(sess).slice(0, 8));
          continue;
        }
        if (WATCH.lastIdleInviteAt && (Date.now() - WATCH.lastIdleInviteAt) < WATCH.idleMinGapMs) {   // ② 全局最小间隔
          log('IDLE SKIP: 全局最小间隔（' + Math.round((Date.now() - WATCH.lastIdleInviteAt) / 1000) + 's < ' + (WATCH.idleMinGapMs / 1000) + 's）session=' + path.basename(sess).slice(0, 8));
          continue;
        }
        if (WATCH.taskGate) {                                                     // ③ 任务域闸门（含 Team 波次 / 别的会话在推进）
          const tq = taskDomainQuietMs();
          if (tq >= 0 && tq < WATCH.idleMs) {
            WATCH.taskGateSkips++;
            log('IDLE SKIP: 任务域 ' + Math.round(tq / 1000) + 's 前刚被推进 ⇒ 不登记 session=' + path.basename(sess).slice(0, 8));
            continue;
          }
        }
        // ★ RESUME-1（2026-09-29）：第 ④ 闸 —— 模式 D（QQ 成员代等）等待期豁免。
        //   本会话存在未决的非 idle 项 ⇒ agent 正在等用户在 QQ 回复（模式 D 的预期形态），
        //   此处的「静置」是等待态、不是「人离开」⇒ 不登记接管邀请（否则误确认会起 headless 与原会话撞车）。
        //   ★ 必须按会话过滤（p.session === sess）：否则别的会话一条 2h 期 irreversible 项会**全局**压掉本会话邀请
        //     （FIX-25/26 已修过的事故类）。watcher.skipIdleWhenOpenAsk=false 可关闭本闸。
        if (WATCH.skipIdleWhenOpenAsk) {
          const openAsk = [...pending.values()].some((p) =>
            p.status === 'pending' && p.kind !== 'idle' && p.session === sess);
          if (openAsk) {
            log('IDLE SKIP: 本会话有未决拍板项（agent 等回复 / 模式 D）⇒ 不登记 session=' + path.basename(sess).slice(0, 8));
            continue;
          }
        }
        // ★ FIX-17：默认「登记可回复项」——你回「确认#N」即可驱动（autoHandoff=true 时由 CLI 新会话接管继续）；
        //          原为每静置周期直发一条不可回复的通知（回复落入黑洞）。
        // ★ QQ-WAKE-1（2026-09-30）：静置角标数据 —— 未决项 id（全局去重；本会话被第④闸跳过时不触达此行，闸门判定不动）
        const idleOpenIds = [...new Set([...pending.values()]
          .filter((p) => p.status === 'pending' && p.kind !== 'idle')
          .map((p) => p.id))];
        if (WATCH.autoQueue && !idlePending) {
          const id = registerRequest(buildIdlePrompt(idleSec, sess, idleOpenIds), '', 0, 0, 'idle',
            { handoff: WATCH.autoHandoff, handoffPrompt: WATCH.handoffPrompt, handoffBrief: WATCH.handoffBrief,
              session: sess, nextHint: buildNextHint() });   // ★ FIX-30：接续入口（如实事实，取代静默省略）
          if (id) WATCH.lastIdleInviteAt = Date.now();   // ★ FIX-36：全局最小间隔基准（id=0 ⇒ 被静默闸拦下，不占基准）
          log('PUSH(QUEUE): idle ' + idleSec + 's → #' + id + (WATCH.autoHandoff ? ' [handoff]' : '')
            + ' session=' + path.basename(sess).slice(0, 8));
        } else if (!WATCH.autoQueue) {
          send(buildIdlePrompt(idleSec, sess))
            .then((st) => log('PUSH: idle ' + idleSec + 's HTTP ' + st))
            .catch((e) => log('PUSH ERR: ' + e.message));
        } else {
          log('PUSH skip: idle ' + idleSec + 's（该会话已有未决 idle 项）');
        }
      }
    } catch (e) { log('WATCH ERR: ' + e.message); }
  }, 5000);
}

// ══════════════════════════════════════════════════════════════
// B) Confirm 模块 —— QQ 双向确认（原 qqbot-daemon.js）
// ══════════════════════════════════════════════════════════════
function route(content) {
  const c = (content || '').toLowerCase();
  // ★ FIX-17：cancel 优先判定 —— 否则「不通过 / 驳回」会先被 confirm 的「通过」子串劫持
  for (const name of ['cancel', 'confirm']) {
    const act = cfg.actions[name];
    if (act && act.keywords && act.keywords.some((k) => c.indexOf(k.toLowerCase()) >= 0)) return name;
  }
  return null;
}
function doAction(name) {
  const act = cfg.actions[name];
  if (!act) return;
  log('[ACTION] ' + name);
  send(act.reply).then((st) => log('[REPLY] ' + name + ' HTTP ' + st)).catch((e) => log('[REPLY ERR] ' + e.message));
  if (!cfg.dryRun && act.command) {
    log('[EXEC] ' + act.command);
    execDecoded(act.command, { env: execEnv(null, 'action', name) }, (err, stdout) => {
      if (err) { log('[EXEC ERR] ' + err.message); send('❌ 执行失败：' + err.message.slice(0, 200)).catch(() => {}); }
      else { log('[EXEC OUT] ' + String(stdout || '').slice(0, 500)); send('✔️ 执行完成。').catch(() => {}); }
    });
  } else if (cfg.dryRun && act.command) {
    log('[DRYRUN] 配置命令未执行（dryRun=true）：' + act.command);
  }
}

const pending = new Map();
// ══════════════════════════════════════════════════════════════
// ★ FIX-30 / FIX-31（2026-09-19）：待确认消息结构化渲染
//   背景（用户实测审查）：原模板对所有来源套同一段二元文案，导致
//     ① idle 类：事项位放的是「事件描述」而非待决问题，后果取静态 brief（用户无从判断）；
//     ② 选择题类（ask --options）：无选项协议 ——「确认#N」对选择题无语义，
//        选项只能寄生自由文本兜底（有条件 + 有副作用 + 消息不写）；
//     ③ 前置条件（活动闸门 / 接管互斥）、有效期、各回复的实际后果均未告知。
//   本渲染器按 kind / options / command / handoff 生成「问题 + 来源 + 选项→后果对照」结构。
//   ★ 供 registerRequest 调用 + `--render` 离线自测（不启动服务）。
// ══════════════════════════════════════════════════════════════
// ★ FIX-37c：消息分割线统一口径（20 字符）—— 此前 待确认类 = 20 / 心跳与完成通知 = 14（用户实测指出不一致）；
//   用 '─'.repeat(20) 而非字面量，避免手抄 glyph 个数出错（跨文件同一口径：notify.qqbot.js 的 MSG_SEP）。
const MSG_SEP = '─'.repeat(20);
const KIND_LABEL = {
  idle: '自动·会话静置', ask: '人工提问', gate: '门禁·需授权',
  decision: '需你拍板', irreversible: '不可逆·需授权', manual: '人工登记', reply: '答复接管',
  shutdown: '关机·需确认',                 // ★ FIX-37
  sleep: '待机·需确认',                    // ★ FIX-38
};
const CHOICE_MARK = { A: '🅰', B: '🅱', C: '🅲', D: '🅳', E: '🅴', F: '🅵', G: '🅶', H: '🅷' };
function choiceMark(k) { return CHOICE_MARK[String(k || '').toUpperCase()] || '▪'; }
/** ★ FIX-31：选项清洗 —— 仅保留单字母 A~Z 键 + label（截 80 字），去重 */
function normOptions(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const o of list) {
    if (!o) continue;
    const k = String(o.key || '').trim().toUpperCase().slice(0, 1);
    if (!/^[A-Z]$/.test(k)) continue;
    if (out.some((x) => x.key === k)) continue;
    out.push({ key: k, label: String(o.label || '').trim().slice(0, 80) });
  }
  return out;
}
/** ★ 回IDE固定选项（2026-10-06）：取选项列表外第一个可用字母键（A 起），全占返回 null（不追加）。
 *  渲染（renderRequestText 追加选项行）与判定（doChoice 识别固定键）共用本函数，防双源漂移。 */
function ideOptionKey(options) {
  const used = new Set((options || []).map((o) => String(o && o.key || '').toUpperCase()));
  for (let i = 0; i < 26; i++) {
    const k = String.fromCharCode(65 + i);
    if (!used.has(k)) return k;
  }
  return null;
}
/** 毫秒 → 人类可读有效期（600000 → 「10 分钟」；7200000 → 「2 小时」） */
function timeoutLabel(ms) {
  const m = Math.round(Number(ms || 0) / 60000);
  if (!(m > 0)) return '';
  if (m < 60) return m + ' 分钟';
  const h = m / 60;
  return (h % 1 ? h.toFixed(1) : String(h)) + ' 小时';
}
/**
 * ★ FIX-30/31：渲染待确认消息（取代原内联拼接的二元文案）。
 * rec = { id, kind, prompt, command, brief, handoff, options, recommend, nextHint, timeoutMs }
 */
function renderRequestText(rec) {
  const id = rec.id;
  const opts = (rec.options || []).filter((o) => o && o.key);
  const label = KIND_LABEL[rec.kind] || rec.kind || '待办';
  const guardSec = Math.round((WATCH.handoffGuardMs || 120000) / 1000);
  const L = [];
  L.push('🔔 #' + id + ' 待确认 · [' + label + ']');
  L.push(MSG_SEP);
  const ideKey = opts.length ? ideOptionKey(opts) : null;   // ★ 回IDE固定选项键（与 doChoice 同源）
  if (opts.length) {                                    // ① 选择题（FIX-31）
    L.push('❓ ' + (firstLine(rec.prompt) || '请选择：'));
    for (const o of opts) {
      const tag = (rec.recommend && o.key === String(rec.recommend).toUpperCase()) ? '（推荐）' : '';
      L.push(' ' + choiceMark(o.key) + ' ' + o.key + ' → ' + (o.label || '') + tag);
    }
    if (ideKey) L.push(' ' + choiceMark(ideKey) + ' ' + ideKey + ' → 回 IDE 原会话拍板（QQ 侧作废本项）');
  } else if (rec.kind === 'idle') {                     // ② 静置自动类（FIX-30）
    L.push('❓ 需要你决定：是否启动新会话接管，继续推进本迭代？');
    L.push('🕐 触发：' + (firstLine(rec.prompt) || '会话静置'));
    const rest = String(rec.prompt || '').split(/\r?\n/).slice(1).filter((x) => x.trim());
    for (const ln of rest) L.push('   ' + ln);
    if (rec.nextHint) L.push('🪜 接续入口：' + rec.nextHint);
    if (rec.brief) L.push('📋 接管后将执行：' + rec.brief);
  } else if (rec.kind === 'sleep') {                    // ★ FIX-38：待机类（自动唤醒 ⇒ 不会睡死）
    L.push('❓ 需要你决定：是否让本机进入待机（S3）？');
    L.push('⏰ 自动唤醒：' + (rec.wakeAtMs ? fmtTsMs(rec.wakeAtMs) : '（未设置！）'));
    L.push('💤 待机期间机器人同样离线（进程挂起）；到点自动恢复，**无需登录**');
    if (rec.prompt) L.push('📎 来源：' + firstLine(rec.prompt));
  } else if (rec.kind === 'shutdown') {                 // ★ FIX-37：关机类（强告警 + 必须带编号）
    L.push('❓ 需要你决定：是否关闭宿主计算机？');
    L.push('⚠️ 将执行：' + (rec.command || '(未配置命令)'));
    L.push('⚠️ 关机后本机离线，需现场上电（不支持远程开机）');
    if (rec.prompt) L.push('📎 来源：' + firstLine(rec.prompt));
  } else if (rec.command) {                             // ③ 命令/门禁类
    L.push('❓ 需要你决定：是否执行下述命令？');
    L.push('⚠️ 将执行：' + rec.command);
    if (rec.prompt) L.push('📎 事项：' + firstLine(rec.prompt));
  } else {                                              // ④ 普通提问（原样多行）
    for (const ln of String(rec.prompt || '').split(/\r?\n/)) L.push(ln);
    if (rec.handoff && rec.brief) L.push('📋 确认后将执行：' + rec.brief);
  }
  const R = [];
  if (opts.length) {
    const keys = opts.map((o) => o.key).concat(ideKey || []).join(' / ');
    R.push(' ✓ 回 ' + keys + '（多条并存时带编号：' + opts[0].key + '#' + id + '）→ 记录选择'
      + (rec.handoff ? '并交新会话按选择执行' : '（落盘等 IDE 会话读取；原会话已停时需回 IDE 消费）'));
    R.push(' ✗ 取消#' + id + ' → 本项作废，不执行');
  } else if (rec.kind === 'sleep') {                    // ★ FIX-38：待机类（必须带编号）
    R.push(' ✓ 确认#' + id + ' → 进入待机；到 ' + (rec.wakeAtMs ? fmtTsMs(rec.wakeAtMs) : '?') + ' 自动唤醒');
    R.push(' ✗ 取消#' + id + ' → 不待机（机器保持运行）');
    R.push(' ⚠️ 本项不支持免编号回复（「好 / 可以 / ok」一律不生效，必须带 #' + id + '）');
  } else if (rec.kind === 'shutdown') {                 // ★ FIX-37：关机类（必须带编号；倒计时内可中止）
    R.push(' ✓ 确认#' + id + ' → ' + (rec.delaySec ? rec.delaySec + ' 秒后关闭本机' : '关闭本机')
      + '（倒计时内可回「中止关机」，或在本机运行 shutdown /a）');
    R.push(' ✗ 取消#' + id + ' → 不执行关机');
    R.push(' ⚠️ 本项不支持免编号回复（「好 / 可以 / ok」一律不生效，必须带 #' + id + '）');
  } else if (rec.command) {
    R.push(' ✓ 确认#' + id + ' → 执行上述命令，完成/失败均回执');
    R.push(' ✗ 取消#' + id + ' → 不执行（阻塞保持）');
  } else if (rec.kind === 'idle') {
    R.push(' ✓ 确认#' + id + ' → 起 headless 接管执行上述步骤（前置复查：该会话 ' + guardSec + 's 内无写类操作、该迭代未被其他会话推进、无其它接管），完成回执');
    R.push(' ✗ 取消#' + id + ' → 本邀请作废，不执行任何操作（IDE 会话保持原状）');
    R.push(' 💬 其他文本 → 作为指示交新会话执行（仅当只有 1 条未决项时）');
    R.push(' ↩ 回 IDE 操作 → 不影响本邀请（接管前自动复查：人仍在干活则拒绝并回执）');
    // ★ FIX-36：静默入口写进消息本身（用户要求「xxh/xxmin 内不再提醒」必须照办）
    R.push(' ⏸ 回「静默 2h」/「120min 内不再提醒」→ 期间不再发静置邀请（只掐本类；拍板/失败仍推）');
    R.push(' ⏸ 回「全部静默 1h」→ 连完成通知与门禁通知一并静默（回「取消静默」解除）');
  } else if (rec.handoff) {
    R.push(' ✓ 确认#' + id + ' → 由新会话接管执行（接管前自动复查是否有人在动）');
    R.push(' 💬 其他文本 → 作为指示交新会话执行（仅当只有 1 条未决项时）');
    R.push(' ✗ 取消#' + id + ' → 本项作废，不执行');
  } else {
    R.push(' ✓ 确认#' + id + ' → 登记确认（落盘等 IDE 会话读取；原会话已停时需回 IDE 消费）');
    R.push(' ✗ 取消#' + id + ' → 本项作废，不执行');
  }
  L.push(MSG_SEP);
  L.push('你的回复 → 结果');
  for (const r of R) L.push(r);
  const t = timeoutLabel(rec.timeoutMs);
  if (t) L.push('⏳ ' + t + '内有效，超时自动取消');
  return L.join('\n');
}
/** 请求体携带的命令是否被允许（默认空白名单 = 一律不接受） */
function isCommandAllowed(cmd) {
  const list = cfg.commandAllowlist;
  if (!Array.isArray(list) || list.length === 0) return false;
  const s = String(cmd || '').trim().toLowerCase();
  return list.some((p) => s.indexOf(String(p || '').trim().toLowerCase()) === 0);
}
/** 动作脚本上下文（经环境变量传递，不拼命令行 ⇒ 无注入面） */
function execEnv(id, kind, prompt) {
  return Object.assign({}, process.env, {
    QQ_CONFIRM_ID: id == null ? '' : String(id),
    QQ_CONFIRM_KIND: String(kind || ''),
    QQ_CONFIRM_PROMPT: String(prompt || ''),
  });
}
let nextId = 1;
function registerRequest(prompt, command, id, timeoutMs, kind, opts) {
  const o = opts || {};
  // ★ FIX-36：idle 邀请此前**完全绕过**静默/免打扰（notifyMuted() 只被 /notify 与 /status 调用，
  //   quietHours 只作用于合并队列）⇒ 命中即不登记、不发 QQ、不占 #N 号（放在 nextId++ 之前）。
  if ((kind || '') === 'idle') {
    const mute = notifyMuted();
    const sn = mute ? null : snoozeActive('idle');
    if (mute || inQuietHours() || sn) {
      const why = mute ? ('muted(' + mute + ')') : (inQuietHours() ? 'quiet-hours' : ('snooze→' + snoozeLabel(sn.until)));
      log('[IDLE SKIP] 不登记（' + why + '）');
      return 0;
    }
  }
  id = id || nextId++;
  while (pending.has(id)) id = nextId++;
  // ★ FIX-40（2026-09-29）：编号复用撞号治理 —— 服务重启后 nextId 归 1，而 answerDir 里
  //   历史答案文件（按 id 命名）仍在 ⇒ wait-answer.ps1 只判「文件存在」⇒ 调用方读到旧答复
  //   （实测 2026-09-29：#6 读到 09-27 的 timeout ⇒ waiter 秒退、真答复无人接收）。
  //   登记即清理同号残留，覆盖全部登记来源（ask.js / notify-enqueue / 门禁 / watcher）。
  clearStaleAnswer(id);
  const t = timeoutMs || cfg.requestTimeoutMs || 600000;
  // ★ FIX-35：登记「任务域水位」基线（仅 handoff 项需要；供确认时判断「该迭代是否被推进」）
  const iterId = (o.iterId !== undefined) ? o.iterId : (o.handoff ? readActiveIterationId() : '');
  const taskMarkAt = (o.taskMarkAt !== undefined) ? o.taskMarkAt : (o.handoff ? readTaskMark(iterId) : null);
  const rec = { id, kind: kind || '', prompt: prompt || '', command: command || '', handoff: !!o.handoff,
    handoffFile: o.handoffFile || '', handoffPrompt: o.handoffPrompt || '',
    session: o.session || '',                                  // ★ FIX-17b：来源会话（按会话去重 / 审计定位）
    iterId: iterId,                                            // ★ FIX-35：任务域基线（迭代 ID）
    taskMarkAt: taskMarkAt,                                    // ★ FIX-35：任务域基线（水位 mtime；null = 不可用）
    options: normOptions(o.options),                           // ★ FIX-31：选择题选项（A/B/C + 含义）
    recommend: o.recommend ? String(o.recommend).toUpperCase() : '',   // ★ FIX-31：推荐项
    nextHint: o.nextHint || '',                                // ★ FIX-30：接续入口（idle 类由 watcher 传入）
    timeoutMs: t,                                              // ★ FIX-30：供渲染「有效期」
    delaySec: Number(o.delaySec || 0),                         // ★ FIX-37：关机类倒计时（消息预告 + 执行回执用）
    wakeAtMs: Number(o.wakeAtMs || 0),                         // ★ FIX-38：待机类「计划唤醒」时刻（ms）
    originPrompt: '',                                          // ★ FIX-31：接管时保留原题面（doFreeReply/doChoice 填充）
    replyLabel: '',                                            // ★ FIX-31：接管文件里的「你的回复」（取代硬编码）
    createdAt: Date.now(), status: 'pending', timer: null };
  // ★ FIX-28：把「确认后会发生什么」讲清楚 —— 此前 QQ 只说「回确认#N 由新会话接管」，
  //   却不说明接管后会执行什么（用户实测：#3 完全没有内容说明，回复确认等于盲签）。
  //   摘要来源：显式 handoffBrief（idle 项由 config.watcher.handoffBrief 提供一句话口径）> handoffPrompt 首行。
  const brief = String(o.handoffBrief || (o.handoffPrompt ? String(o.handoffPrompt).split(/\r?\n/)[0] : '')).slice(0, 120);
  rec.brief = brief;
  rec.timer = setTimeout(() => {
    const p = pending.get(id);
    if (p && p.status === 'pending') {
      p.status = 'expired';
      writeAnswer(p, 'timeout');
      noteSettled(p);                       // ★ FIX-36：结算 ⇒ 会话冷却
      // ★ FIX-36：idle 超时不再推送（邀请本身已预告有效期 ⇒ 再来一条「超时」纯噪音；实测全天 42 条）
      // ★ RESUME-1·D（2026-09-29）：非 idle 超时 = 模式 D 等待结束 ⇒ 必须说清后续路径（原会话还在 / 静置后可代跑）。
      //   原文案「已自动取消」会被读成"没路了"；★ 不承诺具体时间（snooze `:1219-1226` 可能吞掉后续邀请、
      //   且冷却叠加 idleSeconds+idleInviteMinGapSec+idleInviteCooldownSec 使实际延迟远大于 30 分钟）。
      if (p.kind !== 'idle') send('⏰ #' + id + ' 等待已超时（无回复），已停止等待。回工位可在 IDE 原会话继续；若需代跑，静置后会再发接管邀请（受静默/冷却影响，不承诺时间）。').catch(() => {});
      logInbox({ taskId: id, result: 'expired' });
    }
  }, t);
  pending.set(id, rec);
  // ★ FIX-29：待确认消息统一加 🔔 前缀；★ FIX-30/31：统一结构化渲染
  //   （来源标记 + 问题句 + 选项→后果对照 + 前置条件/有效期；取代原二元文案内联拼接）
  const text = renderRequestText(rec);
  send(text).then((st) => log('[ASK #' + id + '] HTTP ' + st)).catch((e) => log('[ASK ERR] ' + e.message));
  return id;
}
// ★ 档3 兼容：中文输入法常打出全角「＃」与全角数字 —— 先归一化再解析
function normalizeCmd(s) {
  return String(s || '').trim()
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF03\uFE5F]/g, '#');
}
function parseReply(content) {
  // ★ 回IDE（2026-10-06）：「回IDE#N」= QQ 侧作废本项、回 IDE 原会话拍板（答案落盘 answer='ide'）
  const m = normalizeCmd(content).match(/^(确认|取消|回\s*IDE|confirm|cancel)\s*#\s*(\d+)$/i);
  if (!m) return null;
  const k = m[1].replace(/\s+/g, '').toLowerCase();
  const type = (k === 'cancel' || k === '取消') ? 'cancel' : (k === '回ide' ? 'ide' : 'confirm');
  return { type, id: parseInt(m[2], 10) };
}
/**
 * ★ FIX-31（2026-09-19）：选项答复解析 —— 选择题专用语法，不再寄生「自由文本兜底」。
 *   `B#12`（带编号，多条并存时唯一寻址）｜ `B`（唯一未决选择题时直通）。
 *   ★ 只识别单字母（`no`/`ok` 等双字母关键词不受影响）；是否生效由调用方按"该项是否为选择题"判定。
 *   ⚠️ 事故备注（2026-09-19）：本函数曾因插入丢失 ⇒ `module.exports` 求值抛 ReferenceError
 *      ⇒ 被 uncaughtException 吞掉后进程挂住（"服务起不来 / --parse 卡住"的共同根因）。
 *      教训：`node --check` 只查语法，捕获不到此类引用错误 ⇒ 改动后**必须实际运行**。
 */
function parseChoiceReply(content) {
  const s = normalizeCmd(content).trim();
  const m = s.match(/^([A-Za-z])\s*#\s*(\d+)$/);
  if (m) return { key: m[1].toUpperCase(), id: parseInt(m[2], 10) };
  const m2 = s.match(/^([A-Za-z])$/);
  if (m2) return { key: m2[1].toUpperCase(), id: null };
  return null;
}
/** ★ FIX-40（2026-09-29）：答案文件目录/路径单一来源（writeAnswer 与 clearStaleAnswer 共用，避免双源漂移） */
function answerDirAbs() {
  const rel = String(cfg.answerDir || '.codebuddy/temp/qq-answers').split(String.fromCharCode(92)).join('/');
  return path.join(PROJ_ROOT, rel);
}
function answerFilePath(id) {
  return path.join(answerDirAbs(), String(id) + '.json');
}
/**
 * ★ FIX-40：清理同号历史答案文件（编号复用撞号治理）。
 * 场景：服务重启 ⇒ nextId 归 1 ⇒ 新 #6 与历史 #6 撞号；旧答案文件仍在 ⇒ wait-answer.ps1
 * 只判「文件存在」⇒ 调用方读到旧答复（2026-09-29 实测：waiter 秒退，把 09-27 的 timeout 当真答复）。
 * 时机：registerRequest 分配 id 后立即执行（早于任何可能的用户回复）；fail-open。
 */
function clearStaleAnswer(id) {
  try {
    const f = answerFilePath(id);
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      log('[ANSWER CLEAR #' + id + '] 已清理同号历史答案文件（防撞号误读）');
    }
  } catch (e) { log('[ANSWER CLEAR ERR #' + id + '] ' + e.message); }
}
// ★ A：等待式确认 —— 把回答落盘（confirm / cancel / timeout），供 agent 的 wait-answer.ps1 轮询读取
function writeAnswer(p, answer, text, choice) {
  try {
    const dir = answerDirAbs();
    fs.mkdirSync(dir, { recursive: true });
    const rec = { id: p.id, answer: answer, ts: new Date().toISOString(), prompt: p.prompt || '', kind: p.kind || '',
      session: p.session || '' };                            // ★ session-hub v2：答复落盘带 session（hub 会话详情按此关联问答）
    // ★ FIX-17d：自由文本答复（answer='text'）时携带原文，供 wait-answer.ps1 / poll-answer.js 消费
    if (text != null) rec.text = String(text);
    // ★ FIX-31：选项答复（answer='choice'）携带所选键 + 选项定义（消费方可还原语义，不再只看到一个字母）
    if (choice != null) rec.choice = String(choice);
    if (p.options && p.options.length) rec.options = p.options;
    fs.writeFileSync(path.join(dir, p.id + '.json'), JSON.stringify(rec), 'utf8');
    log('[ANSWER #' + p.id + '] ' + answer);
  } catch (e) { log('[ANSWER ERR #' + p.id + '] ' + e.message); }
}
// ★ FIX-17e：headless 接管锁 —— 服务写 / gate-check.mjs 读 ⇒「IDE ⇄ headless」双向互斥
//   锁文件：<handoffDir>/RUNNING.json（含 expiresAt ⇒ 超时自动失效，避免崩溃残留把 IDE 永久锁死）
function handoffLockFile() {
  const hl = cfg.headless || {};
  const relDir = String(hl.handoffDir || '.codebuddy/temp/handoff').split(String.fromCharCode(92)).join('/');
  return path.join(PROJ_ROOT, relDir, 'RUNNING.json');
}
function readHandoffLock() {
  const f = handoffLockFile();
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    if (j && j.expiresAt && Date.now() < Number(j.expiresAt)) return j;
    try { fs.unlinkSync(f); } catch (e) { /* 过期锁清理失败不致命 */ }
  } catch (e) { /* 无锁 / 已删除 / 未写完 ⇒ 视为无锁 */ }
  return null;
}
function writeHandoffLock(p, extra) {
  try {
    const hl = cfg.headless || {};
    const f = handoffLockFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let ttl = Number(hl.timeoutMs || 1800000);
    const extra0 = extra || {};
    // ★ FIX-34：serve 模式下任务结束 = 「会话转 idle」而非进程退出 ⇒ 锁 TTL 放大到至少 4h，
    //   避免用户在 Web UI 里持续工作时锁中途失效（原 TTL = timeoutMs 是 print 一次性口径）。
    if (extra0.mode === 'serve') ttl = Math.max(ttl, 4 * 60 * 60 * 1000);
    const body = {
      id: p.id, kind: p.kind || '', startedAt: ts(), startedAtMs: Date.now(),
      expiresAt: Date.now() + ttl, ttlMs: ttl, pid: process.pid,
      note: 'headless 接管中：此锁由服务写入、gate-check.mjs 读取；需手动继续请删除本文件。'
    };
    // ★ FIX-34：锁体增 mode/webUrl/port（serve 模式供 /status 与回执展示入口；不含口令）
    if (extra0.mode) body.mode = extra0.mode;
    if (extra0.webUrl) body.webUrl = extra0.webUrl;
    if (extra0.port) body.port = extra0.port;
    fs.writeFileSync(f, JSON.stringify(body), 'utf8');
    log('[HANDOFF LOCK #' + p.id + '] 已加锁（TTL ' + Math.round(ttl / 60000) + 'min'
      + (extra0.mode ? ' · mode=' + extra0.mode : '') + ')');
  } catch (e) { log('[HANDOFF LOCK ERR] ' + e.message); }
}
function clearHandoffLock() {
  try { fs.unlinkSync(handoffLockFile()); log('[HANDOFF LOCK] 已释放'); }
  catch (e) { /* 已不存在即视为释放完成 */ }
}
// ★ B：headless 接管 —— QQ 确认后用 CLI 非交互会话继续执行剩余任务
function runHeadless(p) {
  const hl = cfg.headless || {};
  const BS = String.fromCharCode(92);
  if (!hl.enabled) { send('ℹ️ #' + p.id + ' headless 接管未启用（headless.enabled=false）。').catch(() => {}); return; }
  // ★ FIX-17e：跨进程锁检查（含服务重启后残留的锁）⇒ 拒绝重复启动
  const lockHit = readHandoffLock();
  if (lockHit) {
    log('[HANDOFF SKIP #' + p.id + '] 已有接管锁（#' + lockHit.id + '，expiresAt=' + lockHit.expiresAt + '）');
    send('⚠️ #' + p.id + ' 已有 headless 接管在运行（#' + lockHit.id + '）⇒ 本次未启动；如需重跑请等其结束，或删除 .codebuddy/temp/handoff/RUNNING.json。').catch(() => {});
    logInbox({ taskId: p.id, result: 'handoff-skipped-lock' });
    return;
  }
  const relDir = String(hl.handoffDir || '.codebuddy/temp/handoff').split(BS).join('/');
  const relFile = p.handoffFile || (relDir + '/qq-' + p.id + '.md');
  const absFile = path.join(PROJ_ROOT, relFile);
  try {
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    if (!fs.existsSync(absFile)) {
      const body = [
        '# QQ 确认 → headless 接管（#' + p.id + '）',
        '',
        '- 时间：' + ts(),
        '- 待确认事项：' + (p.originPrompt || p.prompt || ''),
        '- 你的回复：' + (p.replyLabel || '确认（QQ）'),
        '- 类别：' + (p.kind || 'pending'),
        '',
        '## 剩余工作',
        '',
        p.handoffPrompt ? String(p.handoffPrompt) : '（未提供 handoffPrompt —— 仅输出上下文摘要，不要修改任何文件）',
        '',
      ].join(LF);
      fs.writeFileSync(absFile, body, 'utf8');
      log('[HANDOFF #' + p.id + '] 已生成 ' + relFile);
    } else log('[HANDOFF #' + p.id + '] 使用既有 ' + relFile);
  } catch (e) {
    log('[HANDOFF ERR #' + p.id + '] ' + e.message);   // ★ FIX-17：此前仅发 QQ、不落日志 ⇒ 失败不可见
    send('❌ #' + p.id + ' handoff 文件生成失败：' + e.message).catch(() => {});
    return;
  }
  // ★ FIX-34：按 headless.mode 分支 —— serve 走 adapter 托管（可视化 + 续聊），print 走现逻辑（一次性 -p）
  const mode = String(hl.mode || 'print').toLowerCase();
  if (mode === 'serve') { runHeadlessServe(p, hl, relFile); return; }
  runHeadlessPrint(p, hl, relFile);
}
/**
 * ★ FIX-34：print 模式（C 档现状）—— 一次性 -p 自动代跑 + exec 回调收尾。
 *   从原 runHeadless 尾部抽出，供 serve 降级时复用。
 */
function runHeadlessPrint(p, hl, relFile) {
  const promptText = '读取 ' + relFile + ' 并严格按其「剩余工作」小节执行（若无该小节则只输出摘要、不要修改任何文件）。';
  const cmd = String(hl.command || adapter.defaultCommand())   // ★ FIX-34：兜底命令改调 adapter（原硬编码移走）
    .replace(/\{prompt\}/g, promptText).replace(/\{handoff\}/g, relFile).replace(/\{id\}/g, String(p.id));
  log('[HEADLESS #' + p.id + '] ' + cmd);
  send('🤖 #' + p.id + ' 已启动 headless 接管（CLI 新会话执行剩余任务），完成后回执。').catch(() => {});
  handoffRunning++;                                  // ★ FIX-17c③：接管互斥计数
  writeHandoffLock(p);                               // ★ FIX-17e：加跨进程锁（hook 据此拦其它会话写入）
  const hlEnv = Object.assign({}, execEnv(p.id, 'handoff', p.prompt), { PIVAS_HANDOFF_OWNER: String(p.id) });
  exec(cmd, { cwd: PROJ_ROOT, windowsHide: true, timeout: hl.timeoutMs || 1800000, maxBuffer: 20 * 1024 * 1024, env: hlEnv },
    (err, stdout) => {
      handoffRunning = Math.max(0, handoffRunning - 1);
      clearHandoffLock();                            // ★ FIX-17e：无论成败均释放锁
      const out = String(stdout || '').trim();
      const tail = out.slice(-(hl.replyChars || 600));
      if (err) {
        log('[HEADLESS ERR #' + p.id + '] ' + err.message);
        send('❌ #' + p.id + ' headless 接管失败/超时：' + String(err.message).slice(0, 160) + (tail ? '\n--- 输出尾部 ---\n' + tail : '')).catch(() => {});
        logInbox({ taskId: p.id, result: 'handoff-failed' });
      } else {
        log('[HEADLESS OUT #' + p.id + '] chars=' + out.length);
        send('✅ #' + p.id + ' headless 接管完成：\n' + (tail || '(无输出)')).catch(() => {});
        logInbox({ taskId: p.id, result: 'handoff-done', chars: out.length });
      }
    });
}
// ★ FIX-17c：headless 接管互斥计数 + 「会话恢复活动 ⇒ 作废未决 idle 项」
//   背景（用户实测）：静置自动登记 #N 后用户 QQ 回确认启动 headless，同时人（或原会话）也在动手
//   ⇒ 两个"干活者"并行改同一迭代（state.yaml 互相覆盖）。三道闸：① 活动即作废 ② 接管前活动闸门 ③ 互斥。
let handoffRunning = 0;

// ══════════════════════════════════════════════════════════════
// ★ FIX-34：serve 模式托管 —— 用 adapter spawn 一个 CodeBuddy `--serve` 进程，
//   提供「可视化 + 双向续聊」的 Web UI（回工位窗口）；print 保留为 fallback。
//   托管策略（决策 4）：参数化（serve.idleTtlMs 默认 1800000 = 策略③「首接起 + idle 超时回收」）。
//   三条必落：① 回收双条件（idle>TTL 且无 RUNNING.json）② idle 只认真实使用（新一轮接管命中）
//   ③ 有界重启 ≤ serve.maxRestart，超限降级 print + QQ 告知（禁周期拉起，防 daemon 弹窗覆辙）。
// ══════════════════════════════════════════════════════════════
let serveChild = null;        // 当前 serve 子进程句柄
let serveTick = null;         // serveTicker 定时器
let serveHandoff = null;      // 当前 serve 接管的 handoff 上下文 { id, port }

/** 迭代 runtime 目录（与 readActiveIterationId 同源定位） */
function runtimeDir() {
  const rel = (cfg.watcher && cfg.watcher.contextDir) || '.codebuddy/skills/iteration-workflow/runtime';
  return path.join(PROJ_ROOT, rel.split(String.fromCharCode(92)).join('/'));
}
/** serve 实例指针文件（决策 4：不含口令） */
function serveInstanceFile() {
  const hl = cfg.headless || {};
  const sv = hl.serve || {};
  const rel = String(sv.instanceFile || 'runtime/serve-instance.json');
  if (rel === 'runtime/serve-instance.json' || rel.indexOf('runtime/') === 0) {
    return path.join(runtimeDir(), rel.replace(/^runtime\//, ''));
  }
  return path.join(PROJ_ROOT, rel.split(String.fromCharCode(92)).join('/'));
}
function readServeInstance() {
  try { return JSON.parse(fs.readFileSync(serveInstanceFile(), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return null; }
}
function writeServeInstance(inst) {
  try {
    fs.mkdirSync(path.dirname(serveInstanceFile()), { recursive: true });
    fs.writeFileSync(serveInstanceFile(), JSON.stringify(inst), 'utf8');
  } catch (e) { log('[SERVE INST ERR] ' + e.message); }
}
/** 真实使用 = 新一轮接管命中已有实例 / 新 handoff 登记（不认 IDE 会话活动，FIX-35 同源） */
function markServeUsed() {
  const inst = readServeInstance();
  if (inst) { inst.lastUsedAt = Date.now(); writeServeInstance(inst); }
}

/** 确保 serve 实例在跑：已有实例端口活 ⇒ 复用；否则有界 spawn（≤ maxRestart） */
function ensureServeInstance(hl, cb) {
  const sv = hl.serve || {};
  const basePort = Number(sv.port || 19000);
  const existing = readServeInstance();
  if (existing && existing.port) {
    adapter.probe({ port: existing.port }, (alive) => {
      if (alive) {
        markServeUsed();
        cb({ ok: true, reused: true, inst: existing, webUrl: 'http://127.0.0.1:' + existing.port, port: existing.port });
      } else {
        spawnServe(sv, basePort, existing, cb);
      }
    });
    return;
  }
  spawnServe(sv, basePort, null, cb);
}

/** 有界 spawn serve 实例（决策 4：restartCount ≥ maxRestart ⇒ 降级 print） */
function spawnServe(sv, basePort, prevInst, cb) {
  const maxRestart = Number(sv.maxRestart != null ? sv.maxRestart : 2);
  const restartCount = prevInst ? Number(prevInst.restartCount || 0) : 0;
  if (restartCount >= maxRestart) {
    log('[SERVE] 重启 ' + restartCount + ' 次已达上限 ' + maxRestart + ' ⇒ 降级 print');
    cb({ ok: false, degrade: true, reason: 'restart-limit' });
    return;
  }
  const spec = adapter.start({ port: basePort, cwd: PROJ_ROOT });
  let child;
  try { child = spawn(spec.command, spec.args, spec.options); }
  catch (e) {
    log('[SERVE SPAWN ERR] ' + e.message);
    cb({ ok: false, degrade: true, reason: 'spawn-error' });
    return;
  }
  serveChild = child;
  const inst = {
    pid: child.pid, port: basePort,
    startedAt: ts(), startedAtMs: Date.now(), lastUsedAt: Date.now(),
    tier: 'A', restartCount: restartCount + 1,
  };
  // stdout 仅日志留痕；口令不缓存（credential() 每次现读 settings.json）
  if (child.stdout) child.stdout.on('data', (d) => { const s = String(d).trim(); if (s) log('[SERVE OUT] ' + s.slice(0, 300)); });
  if (child.stderr) child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log('[SERVE ERR] ' + s.slice(0, 300)); });
  child.on('error', (e) => log('[SERVE CHILD ERR] ' + e.message));
  child.on('exit', (code) => {
    log('[SERVE EXIT] code=' + code);
    if (serveChild === child) serveChild = null;
    const cur = readServeInstance();
    if (cur && Number(cur.pid) === Number(child.pid)) {
      cur.stoppedAtMs = Date.now();
      writeServeInstance(cur);
    }
  });
  writeServeInstance(inst);
  // 等端口就绪（T_open 实测 ≈7.6s；serve.coldStartMs 仅作判据门限，不阻塞）
  adapter.waitPort(basePort, 20000, (alive) => {
    if (alive) {
      cb({ ok: true, reused: false, inst: inst, webUrl: 'http://127.0.0.1:' + basePort, port: basePort, child: child });
    } else {
      log('[SERVE] 端口 ' + basePort + ' 未就绪 ⇒ 降级 print');
      cb({ ok: false, degrade: true, reason: 'port-not-ready', child: child });
    }
  });
}

/** serve 模式 runHeadless 入口：确保实例 + 写锁（含 webUrl/mode）+ 派发 job + 回执 + 存活监视
 *  ★ FIX-34b（2026-10-03）：修复「serve 起了但任务从不提交」的僵尸接管（#8 实证：空转 83min 零执行）。
 *    现在派发为 Agent Home job（POST /api/v1/jobs，探针 383329ea 闭环实证）：
 *    job = 常驻 PTY 托管的完整交互 CLI，Web UI 侧栏「智能体」可见、可打开续聊，
 *    状态经 GET /api/v1/jobs/<id> 可查（working→done，detail="result: <答复>"）。
 *    复用实例也可直接派发（jobs 为全局存储）⇒ 决策 4 的实例复用得以保留。 */
function runHeadlessServe(p, hl, relFile) {
  ensureServeInstance(hl, (res) => {
    if (!res || !res.ok) {
      log('[SERVE DEGRADE #' + p.id + '] ' + (res && res.reason) + ' ⇒ 降级 print');
      send('🟡 #' + p.id + ' Web UI 启动失败（' + (res && res.reason) + '），已降级 print 模式继续。').catch(() => {});
      runHeadlessPrint(p, hl, relFile);
      return;
    }
    handoffRunning++;                                  // ★ FIX-17c③：接管互斥计数
    writeHandoffLock(p, { mode: 'serve', webUrl: res.webUrl, port: res.port });
    const hint = adapter.humanHint({ webUrl: res.webUrl });
    // 与 print 模式完全同款的提交语（读 handoff 文件按「剩余工作」执行）
    const promptText = '读取 ' + relFile + ' 并严格按其「剩余工作」小节执行（若无该小节则只输出摘要、不要修改任何文件）。';
    adapter.dispatchJob({ port: res.port }, { prompt: promptText, name: 'qq-' + p.id + ' 接管', cwd: PROJ_ROOT },
      (err, job) => {
        if (err) {
          log('[HEADLESS SERVE #' + p.id + '] job 派发失败：' + err.message + ' ⇒ 降级 print');
          handoffRunning = Math.max(0, handoffRunning - 1);
          clearHandoffLock();
          send('🟡 #' + p.id + ' Web UI 任务派发失败（' + String(err.message).slice(0, 120) + '），已降级 print 模式继续。').catch(() => {});
          runHeadlessPrint(p, hl, relFile);
          return;
        }
        send('🖥 #' + p.id + ' headless 接管已派发：任务正在 Web UI 智能体「' + (job.name || '') + '」中执行。'
          + (hint.open ? hint.open + ' 可实时查看/继续（口令见 ~/.codebuddy/settings.json gateway.password）。' : '')).catch(() => {});
        log('[HEADLESS SERVE #' + p.id + '] job=' + job.id + ' state=' + (job.state || '?') + ' ' + res.webUrl + (res.reused ? ' (reused)' : ' (spawned)'));
        handoffAliveWatch(p, res);
      });
  });
}

/** serve 存活监视：HTTP 端口探活代替 exec 回调收尾（serve 死 ⇒ 释放锁 + 回执） */
function handoffAliveWatch(p, res) {
  serveHandoff = { id: p.id, port: res.port };
  ensureServeTicker();
}

function ensureServeTicker() {
  if (serveTick) return;
  const hl = cfg.headless || {};
  const sv = hl.serve || {};
  const pollMs = Number(sv.alivePollMs || 30000);
  serveTick = setInterval(serveTickerTick, pollMs);
  log('[SERVE] ticker 启动（' + Math.round(pollMs / 1000) + 's）');
}

function serveTickerTick() {
  const hl = cfg.headless || {};
  const sv = hl.serve || {};
  const inst = readServeInstance();
  if (!inst || !inst.port) return;
  adapter.probe({ port: inst.port }, (alive) => {
    if (!alive) { onServeDead(inst); return; }
    // 活 ⇒ idle 回收检查（决策 4：回收双条件 = idle>TTL 且无 RUNNING.json）
    const idleMs = Date.now() - (inst.lastUsedAt || inst.startedAtMs);
    const ttl = Number(sv.idleTtlMs != null ? sv.idleTtlMs : 1800000);
    if (ttl > 0 && idleMs > ttl && !readHandoffLock()) {
      log('[SERVE] idle ' + Math.round(idleMs / 60000) + 'min 超阈值且无接管锁 ⇒ 回收');
      killServe(inst);
    }
  });
}

function onServeDead(inst) {
  log('[SERVE] 实例已死（port=' + inst.port + '）');
  if (serveHandoff) { finishServeHandoff(serveHandoff); }
  serveHandoff = null;
  serveChild = null;
  if (serveTick) { clearInterval(serveTick); serveTick = null; }
}

function killServe(inst) {
  const child = serveChild;
  const port = inst && inst.port;
  const after = () => {
    serveChild = null;
    try { fs.unlinkSync(serveInstanceFile()); } catch (e) { /* ignore */ }
    if (serveTick) { clearInterval(serveTick); serveTick = null; }
  };
  if (child) {
    adapter.stopChild(child, port, () => { log('[SERVE] 已回收'); after(); });
  } else if (inst && inst.pid) {
    exec('taskkill /T /F /PID ' + inst.pid, { windowsHide: true }, () => after());
  } else {
    after();
  }
}

function finishServeHandoff(hf) {
  handoffRunning = Math.max(0, handoffRunning - 1);
  clearHandoffLock();
  log('[SERVE END #' + hf.id + '] serve 实例已退出，接管结束');
  send('ℹ️ #' + hf.id + ' Web UI（serve 实例）已退出，headless 接管结束。').catch(() => {});
  logInbox({ taskId: hf.id, result: 'serve-exited' });
}

// ★ FIX-34：serve 实例当前状态（供 /health 与 statusHtml 区块1 渲染；渲染前探活 + 现读口令）
function serveStatus(cb) {
  const inst = readServeInstance();
  if (!inst || !inst.port) { cb(null); return; }
  adapter.probe({ port: inst.port }, (alive) => {
    if (!alive) { cb(null); return; }
    const cred = adapter.credential();
    const webUrl = 'http://127.0.0.1:' + inst.port;
    cb({
      alive: true,
      pid: inst.pid,
      port: inst.port,
      startedAt: inst.startedAt || '',
      lastUsedAt: inst.lastUsedAt || null,
      tier: inst.tier || 'A',
      webUrl: webUrl,
      // ★ 决策 5：/status 给明文直链（渲染期现读口令，host 恒 127.0.0.1）；QQ 回执不给
      directUrl: (cred.scheme === 'query' && cred.value)
        ? (webUrl + '/?password=' + encodeURIComponent(cred.value)) : webUrl,
    });
  });
}

/**
 * ★ FIX-25：只作废「本次活动所属会话」的 idle 项 —— 别的会话在动 ⇒ 本项保持 pending。
 *   （此前无差别作废 ⇒ 用户回到 IDE 的任一会话，所有待确认项全被作废，QQ 回复落空。）
 */
function supersedeIdlePending(session) {
  let n = 0, skipped = 0;
  for (const p of pending.values()) {
    if (p.status !== 'pending' || p.kind !== 'idle') continue;
    if (session && p.session && p.session !== session) { skipped++; continue; }
    p.status = 'superseded';
    if (p.timer) clearTimeout(p.timer);
    writeAnswer(p, 'superseded');
    noteSettled(p);                                     // ★ FIX-36：结算 ⇒ 会话冷却
    log('[SUPERSEDE #' + p.id + '] 会话恢复活动 ⇒ 待确认项自动作废');
    logInbox({ taskId: p.id, result: 'superseded' });
    // ★ FIX-32：措辞说明「仍可手动接管」（该项保留入口 ⇒ 回「确认#N」会重查活动闸门）
    send('ℹ️ #' + p.id + ' 会话已恢复活动 ⇒ 自动接管已取消。如你已离开工位、仍需接管，回「确认#'
      + p.id + '」（会重查该会话是否仍在活动）。').catch(() => {});
    n++;
  }
  if (n) log('[SUPERSEDE] 共作废 ' + n + ' 条未决 idle 项');
  if (skipped) log('[SUPERSEDE skip] ' + skipped + ' 条属于其它会话（本次活动来自 '
    + (session ? path.basename(session).slice(0, 8) : '?') + '）⇒ 保持 pending');
}
/**
 * ★ FIX-25：取「该项所属会话」的静置时长（毫秒）。
 *   无桶（该会话久未被扫到）⇒ 返回 -1，调用方按 **fail-open** 处理（视为静止 ⇒ 放行接管），
 *   理由：无桶说明该会话近期无可见活动，人不在；保守拦会导致工位外永远无法接管。
 */
function sessionIdleMs(p) {
  const s = p && p.session;
  if (!s || !WATCH.activity.has(s)) return -1;
  return Date.now() - WATCH.activity.get(s).lastActivity;
}
/**
 * ★ FIX-36：待确认项「结算」⇒ 给所属会话打冷却。
 *   背景：旧逻辑只要「又有新写入 + 静置达阈值」就能立刻补发（实测 #46 17:00:03 超时 → #49 17:05:49 再发）。
 */
function noteSettled(p) {
  try {
    if (!p || p.kind !== 'idle' || !p.session) return;
    const b = WATCH.activity.get(p.session);
    if (b) b.cooldownUntil = Date.now() + WATCH.idleCooldownMs;
  } catch (e) {}
}
/**
 * ★ FIX-35（方案 G）：确认闸门 —— 取代 FIX-17c① 的「自动作废」，把判定推迟到「确认#N」这一刻。
 *   条件①（按 handoffGuardMode）：session(档1，旧语义) 会话有写入 ⇒ 拒；
 *     write-tool(档2，默认) 会话有**写类工具调用** ⇒ 拒（纯问答/闲聊不计）；task-only(档3) 跳过。
 *   条件②（所有档位）：任务域水位自登记以来前进（有人在推进该迭代，含别的会话/别的工具）⇒ 拒。
 *   返回 { block, reason }；未命中 ⇒ 放行。fail-open：数据取不到一律不据此拒绝（安全由接管锁兜底）。
 */
function taskMarkAdvanced(p) {
  if (!p || !p.iterId || p.taskMarkAt == null) return false;
  const cur = readTaskMark(p.iterId);
  return cur !== null && cur > p.taskMarkAt;
}
function handoffGuard(p) {
  if (!WATCH.enabled) return { block: false, reason: '' };
  const mode = WATCH.handoffGuardMode || 'write-tool';
  const gsec = Math.round((WATCH.handoffGuardMs || 120000) / 1000);
  if (mode !== 'task-only') {
    const since = sessionIdleMs(p);
    if (since >= 0 && since < WATCH.handoffGuardMs) {          // 会话窗口内有活动才深入检查（省 I/O）
      if (mode === 'session') {
        return { block: true, reason: '该会话 ' + Math.round(since / 1000) + 's 前有写入' };
      }
      // ★ FIX-34c（2026-10-03）：基线 = 登记时刻 +15s —— 只拦「登记之后」的新写入。
      //   动因（E2E 实测 #1/#2）：agent 经 ask.js 登记，登记命令自身的会话历史条目在登记后
      //   数秒内落盘 ⇒ 旧口径「最近 120s 有写类操作」必然命中 ⇒「agent 问→用户秒答」100% 被拦。
      //   +15s 缓冲吸收落盘竞态；该窗口内的并行写入风险由任务域条件（taskMark）+ 接管锁兜底。
      //   createdAt 缺失（旧内存项/异常路径）⇒ afterMs=0 ⇒ 维持原口径（fail-safe）。
      const afterMs = p.createdAt ? (Number(p.createdAt) + 15000) : 0;
      const wt = sessionRecentWriteTool(p.session, WATCH.handoffGuardMs, afterMs);
      if (wt) return { block: true, reason: '该会话登记后有新写类操作：' + wt };
    }
  }
  if (taskMarkAdvanced(p)) {
    return { block: true, reason: '该迭代任务域刚被推进（' + p.iterId + ' 的状态/产出有更新）' };
  }
  return { block: false, reason: '' };
}
// ★ FIX-17d：自由文本答复处理 —— 记录答案；若该项带 handoff，则用答复内容起新一轮 headless（护栏同前）
function doFreeReply(p, content) {
  const id = p.id;
  clearTimeout(p.timer);
  p.status = 'replied';
  writeAnswer(p, 'text', content);
  noteSettled(p);                                       // ★ FIX-36：结算 ⇒ 会话冷却
  log('[REPLY #' + id + '] 自由文本答复：' + String(content).slice(0, 80));
  logInbox({ taskId: id, result: 'text-reply', text: String(content).slice(0, 200) });
  const brief = String(content).slice(0, 80);
  if (!p.handoff) {
    // ★ FIX-37：关机项被自由文本「作废」必须显式告知 —— 否则用户以为还挂着，
    //   之后回「确认#N」只会得到「已处理过」，白白错过关机时机（评估 P1-3）。
    if (p.kind === 'shutdown') {
      logInbox({ taskId: id, result: 'shutdown-voided-by-freetext' });
      send('ℹ️ #' + id + ' 是「关机」确认项：已按作废处理，未执行关机。'
        + '如需关机请重发「关机」并回「确认#新编号」。').catch(() => {});
      return;
    }
    send('✅ #' + id + ' 已记录你的答复「' + brief + '」（该项未绑定接管，不启动新会话）。').catch(() => {});
    return;
  }
  if (WATCH.enabled) {                                  // ★ FIX-35：确认闸门（写类工具 / 任务域 双条件）
    const g = handoffGuard(p);
    if (g.block) {
      log('[REPLY SKIP #' + id + '] ' + g.reason);
      send('🟡 #' + id + ' 已记录你的答复，但未启动 headless：' + g.reason + '。本项已消费（重复确认无效）；如需重试请让 agent 确认工位安静后重新登记。').catch(() => {});
      logInbox({ taskId: id, result: 'reply-handoff-skipped-active', reason: g.reason });
      return;
    }
  }
  if (handoffRunning > 0) {                             // 沿用 FIX-17c③ 互斥
    send('⚠️ #' + id + ' 已记录你的答复，但已有 headless 在运行 ⇒ 未重复启动。').catch(() => {});
    logInbox({ taskId: id, result: 'reply-handoff-skipped-busy' });
    return;
  }
  const hl = cfg.headless || {};
  const relDir = String(hl.handoffDir || '.codebuddy/temp/handoff').split(String.fromCharCode(92)).join('/');
  const np = {
    id: p.id, kind: 'reply',
    prompt: '用户在 QQ 的答复：' + content,
    originPrompt: p.prompt || '',                       // ★ FIX-31：保留原题面（此前被覆盖 ⇒ 接管方看不到问题/选项定义）
    replyLabel: '自由文本答复（QQ）',                    // ★ FIX-31：取代接管文件里硬编码的「确认」
    handoff: true,
    handoffFile: relDir + '/qq-' + p.id + '-reply.md',
    handoffPrompt: String(p.handoffPrompt || '')
      + '\n\n★ 用户本轮在 QQ 的答复（以此为准，不要另作选择）：' + content,
  };
  send('✅ #' + id + ' 已记录你的答复「' + brief + '」，并交新一轮 headless 继续执行。').catch(() => {});
  logInbox({ taskId: id, result: 'handoff-started-from-reply' });
  runHeadless(np);
}
/**
 * ★ FIX-31（2026-09-19）：选项答复处理 —— 与 doFreeReply 同护栏（活动闸门 + 接管互斥），区别：
 *   ① 落 answer='choice' + choice 键（消费方可还原语义）；② 答复文本显式绑定选项定义；
 *   ③ 无 handoff 时明确告知"落盘等 IDE 会话读取"（原「未绑定命令」措辞对选择题语境错误）。
 */
function doChoice(p, key) {
  const id = p.id;
  // ★ 回IDE固定选项：命中追加键（如 A/B 被占时的 C）⇒ 不落 choice，走 ide 结算
  //   （QQ 侧作废本项 + answer='ide' ⇒ waiter 读回后主 Agent 转 IDE 内确认）
  const ik = ideOptionKey(p.options);
  if (ik && String(key || '').toUpperCase() === ik) { doPending(id, 'ide'); return; }
  const hit = (p.options || []).filter((o) => o.key === key)[0];
  if (!hit) {
    send('⚠️ #' + id + ' 无选项 ' + key + '（可选：' + (p.options || []).map((o) => o.key).join(' / ') + '）。').catch(() => {});
    return;
  }
  clearTimeout(p.timer);
  p.status = 'replied';
  p.replyLabel = '选项答复（QQ）：' + key;
  const desc = key + (hit.label ? ' = ' + hit.label : '');
  writeAnswer(p, 'choice', desc, key);
  noteSettled(p);                                       // ★ FIX-36：结算 ⇒ 会话冷却
  log('[CHOICE #' + id + '] ' + desc);
  logInbox({ taskId: id, result: 'choice-reply', choice: key });
  if (!p.handoff) {
    send('✅ #' + id + ' 已记录你的选择「' + desc + '」（落盘等 IDE 会话读取；原会话已停时需回 IDE 消费）。').catch(() => {});
    return;
  }
  if (WATCH.enabled) {                                  // ★ FIX-35：确认闸门（写类工具 / 任务域 双条件）
    const g = handoffGuard(p);
    if (g.block) {
      log('[CHOICE SKIP #' + id + '] ' + g.reason);
      send('🟡 #' + id + ' 已记录你的选择「' + desc + '」，但未启动 headless：' + g.reason + '。本项已消费（重复确认无效）；如需重试请让 agent 确认工位安静后重新登记。').catch(() => {});
      logInbox({ taskId: id, result: 'choice-handoff-skipped-active', reason: g.reason });
      return;
    }
  }
  if (handoffRunning > 0) {                             // 沿用 FIX-17c③ 互斥
    send('⚠️ #' + id + ' 已记录你的选择，但已有 headless 在运行 ⇒ 未重复启动。').catch(() => {});
    logInbox({ taskId: id, result: 'choice-handoff-skipped-busy' });
    return;
  }
  const hl = cfg.headless || {};
  const relDir = String(hl.handoffDir || '.codebuddy/temp/handoff').split(String.fromCharCode(92)).join('/');
  const np = {
    id: p.id, kind: 'reply',
    prompt: '用户在 QQ 的选择：' + desc,
    originPrompt: p.prompt || '',                       // ★ FIX-31：保留原题面 + 选项定义
    replyLabel: '选项答复（QQ）：' + key,
    handoff: true,
    handoffFile: relDir + '/qq-' + p.id + '-choice.md',
    handoffPrompt: String(p.handoffPrompt || '')
      + '\n\n★ 用户本轮在 QQ 的选择（以此为准，不要另作选择）：' + desc,
  };
  send('✅ #' + id + ' 已记录你的选择「' + desc + '」，并交新一轮 headless 按该选择执行。').catch(() => {});
  logInbox({ taskId: id, result: 'handoff-started-from-choice' });
  runHeadless(np);
}
/**
 * ★ FIX-32（2026-09-19）：被「会话恢复活动」作废的 idle 项，是否允许「确认#N」**复活**。
 *   背景（用户实测）：人回到 IDE（哪怕只是看消息/聊别的）即触发 supersede ⇒ 之后真想远程接管时已无入口。
 *   安全性不减：复活后仍走 FIX-17c② 活动闸门（该会话 handoffGuardSec 内无写入才放行）+ 接管互斥。
 *   ⇒ 人在会话里照样被拒；人真离开才允许接管（与 FIX-17c 设计意图一致，仅补回入口）。
 */
function canReviveSuperseded(p, type) {
  return !!(p && p.status === 'superseded' && p.kind === 'idle' && type === 'confirm');
}
function doPending(id, type) {
  const p = pending.get(id);
  if (!p) { send('⚠️ 没有待确认的 #' + id + '（可能已完成或超时）。').catch(() => {}); return; }
  if (p.status !== 'pending') {
    if (canReviveSuperseded(p, type)) {
      log('[REVIVE #' + id + '] 该项曾被会话活动作废，用户手动确认 ⇒ 重走接管流程（活动闸门兜底）');
      p.status = 'pending';
    } else {
      send('#' + id + ' 已处理过（' + p.status + '）。').catch(() => {});
      return;
    }
  }
  clearTimeout(p.timer);
  if (type === 'cancel') {
    p.status = 'cancelled';
    // ★ FIX-30：原「中止」措辞误导（cancel 实为"作废本项、不执行任何操作"，IDE 会话保持原状）
    send('⛔ #' + id + ' 已取消：本项作废，不执行任何操作。').catch(() => {});
    writeAnswer(p, 'cancel');
    noteSettled(p);                                     // ★ FIX-36：结算 ⇒ 会话冷却
    logInbox({ taskId: id, result: 'cancelled' });
    return;
  }
  // ★ 回IDE（2026-10-06）：QQ 侧作废本项、用户回 IDE 原会话拍板。
  //   与 cancel 的区别：答案落盘 answer='ide' ⇒ waiter 读回后主 Agent 知道是"回 IDE 处理"
  //   （应转 IDE 内确认），而非用户否决本项。
  if (type === 'ide') {
    p.status = 'ide';
    send('↩ #' + id + ' 已在 QQ 侧作废：请回 IDE 原会话拍板（本项不再等待 QQ 回复）。').catch(() => {});
    writeAnswer(p, 'ide');
    noteSettled(p);
    logInbox({ taskId: id, result: 'ide' });
    return;
  }
  p.status = 'confirmed';
  p.replyLabel = '确认（QQ）';                        // ★ FIX-31：接管文件「你的回复」（取代硬编码）
  writeAnswer(p, 'confirm');
  noteSettled(p);                                     // ★ FIX-36：结算 ⇒ 会话冷却
  send('✅ #' + id + ' 已确认，开始执行：' + firstLine(p.prompt || '')).catch(() => {});
  if (p.handoff) {
    // ★ FIX-35（方案 G）：确认闸门 —— 取代 FIX-17c① 的「自动作废」，把判定推迟到这一刻。
    //   条件①（档 2）= 该会话窗口内有写类工具调用；条件② = 该迭代任务域被推进；命中 ⇒ 拒绝（可重试）。
    if (WATCH.enabled) {
      const g = handoffGuard(p);
      if (g.block) {
        log('[HANDOFF SKIP #' + id + '] ' + g.reason);
        send('🟡 #' + id + ' 未启动 headless：' + g.reason + '。本项已消费（重复确认无效）；如需重试请让 agent 确认工位安静后重新登记。').catch(() => {});
        logInbox({ taskId: id, result: 'handoff-skipped-active', reason: g.reason });
        return;
      }
    }
    // ★ FIX-17c③：互斥 —— 已有接管在跑时不重复启动（防双 headless 并行改同一迭代）
    if (handoffRunning > 0) {
      log('[HANDOFF SKIP #' + id + '] 已有接管在运行（running=' + handoffRunning + '）');
      send('⚠️ #' + id + ' 已有一个 headless 接管在运行，本次确认不重复启动（等其完成后再试）。').catch(() => {});
      logInbox({ taskId: id, result: 'handoff-skipped-busy' });
      return;
    }
    logInbox({ taskId: id, result: 'handoff-started' });
    runHeadless(p);
    return;
  }
  // ★ FIX-38：待机类 —— **先建唤醒定时器**（失败则不待机，避免"睡死"），回执必须早于待机（否则进程已挂起发不出）
  if (p.kind === 'sleep') {
    const when = new Date(Number(p.wakeAtMs) || 0);
    const cmd = String((CMDCFG().sleep || {}).command || 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
    logInbox({ taskId: id, result: 'sleep-started', wakeAt: fmtTsMs(when.getTime()) });
    setWakeTimer(when, (r) => {
      if (!r.ok) {
        log('[WAKE ERR #' + id + '] ' + r.reason);
        send('❌ #' + id + ' 唤醒定时器创建失败，**已取消待机**（避免睡死）：' + r.reason).catch(() => {});
        logInbox({ taskId: id, result: 'sleep-aborted-timer-failed', reason: r.reason });
        return;
      }
      log('[EXEC #' + id + '] sleep：' + cmd + '（唤醒 ' + fmtTsMs(when.getTime()) + '）');
      send('✅ #' + id + ' 已确认：即将进入待机。定时唤醒已设：' + fmtTsMs(when.getTime()) + '（约 '
        + Math.round((Number(p.delaySec) || 0) / 60) + ' 分钟后）。\n🔴 机器人将随机器挂起（离线），到点自动恢复。').catch(() => {})
        .then(() => {
          execDecoded(cmd, {}, (err2, out2) => {
            log('[EXEC OUT #' + id + '] sleep ' + (err2 ? ('err: ' + err2.message) : 'ok') + (out2 ? (' / ' + out2.slice(0, 120)) : ''));
            if (err2) send('❌ #' + id + ' 待机命令执行失败：' + firstLine(err2.message) + '（唤醒定时器已建，可手动待机或删除任务）').catch(() => {});
          });
        });
    });
    return;
  }
  if (!cfg.dryRun && p.command) {
    log('[EXEC #' + id + '] ' + p.command);
    const pEnv = execEnv(p.id, p.kind || 'pending', p.prompt);
    const pOpts = { windowsHide: true, cwd: PROJ_ROOT, env: pEnv };
    execDecoded(p.command, { env: pEnv }, (err, stdout) => {
      // ★ FIX-37d：1190 = ERROR_SHUTDOWN_IS_SCHEDULED（已经计划系统关机）—— 本机已在倒计时中，
      //   Windows 拒绝重复排定且**不重置原倒计时** ⇒ 不是失败（实测 2026-09-21 09:45 被误判为 ❌ + 乱码）。
      if (err && p.kind === 'shutdown' && err.code === 1190) {
        log('[EXEC OUT #' + id + '] shutdown 1190：已有排定的关机（本次未重复排定）');
        send('ℹ️ #' + id + ' 本机已有排定的关机（Windows 1190：' + firstLine(err.message) + '），本次未重复排定。'
          + '中止方式：回「中止关机」，或在本机运行 shutdown /a。').catch(() => {});
      }
      else if (err) { log('[EXEC ERR #' + id + '] ' + err.message + '（code=' + err.code + '）'); send('❌ #' + id + ' 执行失败：' + err.message.slice(0, 200)).catch(() => {}); }
      // ★ FIX-37：关机类回执必须交代「多久后关 / 怎么中止」——
      //   通用「执行完成」在关机语境下等于没说（评估 §三-1）。
      else if (p.kind === 'shutdown') {
        log('[EXEC OUT #' + id + '] ' + String(stdout || '').slice(0, 500));
        send('✅ #' + id + ' 已确认：' + (p.delaySec ? p.delaySec + ' 秒后关闭本机' : '正在关闭本机')
          + '。中止方式：回「中止关机」，或在本机运行 shutdown /a。'
          + '\n🔴 机器人将随机器下线（上线时间 = 下次开机登录后）。').catch(() => {});
      }
      else { log('[EXEC OUT #' + id + '] ' + String(stdout || '').slice(0, 500)); send('✔️ #' + id + ' 执行完成。').catch(() => {}); }
    });
  } else if (cfg.dryRun && p.command) {
    log('[DRYRUN #' + id + '] ' + p.command);
    send('🟡 #' + id + ' dryRun=true，未执行命令' + (p.kind === 'shutdown' ? '（关机未安排）' : '') + '。').catch(() => {});
  } else {
    log('[NO-CMD #' + id + '] 未绑定命令，仅登记确认');
    send('ℹ️ #' + id + ' 已登记确认（该项未绑定命令，无动作执行）。').catch(() => {});
  }
  logInbox({ taskId: id, result: 'confirmed', command: p.command });
}

// ★ session-hub（2026-10-03）：/status 人类状态页已下线（hub 成为唯一监控界面，方案分析.md §9/§10）。
//   statusHtml/escapeHtml/tailLines 一并移除（约 93 行瘦身）；机器接口 /health、/pending 原样保留
//   （watchdog/脚本/hub 在用）。/status 改为 302 → hub（老书签不断链），hub 未起时降级提示页。
/** hub 探活（GET <hubUrl>/health，默认 1.5s 超时）—— /status 302 降级判定用 */
function probeHubAlive(hubUrl, timeoutMs, cb) {
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  try {
    const u = new URL(hubUrl);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: '/health', method: 'GET', timeout: timeoutMs }, (r) => {
      r.resume(); finish(true);
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
    req.end();
  } catch (e) { finish(false); }
}

function startHttp() {
  const port = cfg.listenPort || args.port || 18765;
  const key = cfg.httpKey || '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    // ★ FIX-38：优雅停止入口（仅回环；stop-service.ps1 调用 ⇒ 先发下线通知再退出）
    if (req.method === 'POST' && u.pathname === '/shutdown') {
      const ra = String(req.socket.remoteAddress || '');
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ra)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"error":"loopback-only"}');
        return;
      }
      const reason = String(u.searchParams.get('reason') || '手动停止').slice(0, 60);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, stopping: true, reason: reason }));
      log('[STOP] 收到 POST /shutdown（' + reason + '）');
      setTimeout(() => gracefulStop(reason), 200);      // 先让响应写回，再发通知并退出
      return;
    }
    // ★ session-hub 方案 A（2026-10-04）：本地注入「用户消息」—— hub 页面上直接回复/确认 #N。
    //   安全口径：仅回环 + **独立 simulateKey 必配**（空则端点关闭，零默认暴露）+ 命令类口令与非白名单
    //   kind 一律拦截。注入路径 = 与真实 QQ 消息**完全相同**的处理链（handleMessage → parseReply/
    //   parseChoiceReply → doPending → 落答案文件 / 触发 handoff 接管），不绕过任何守卫。
    if (req.method === 'POST' && u.pathname === '/simulate-message') {
      const raSim = String(req.socket.remoteAddress || '');
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(raSim)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"error":"loopback-only"}');
        return;
      }
      const simKey = String((cfg.hub && cfg.hub.simulateKey) || '');
      if (!simKey) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"error":"simulate-disabled","hint":"daemon.config.json → hub.simulateKey 未配置 ⇒ 本端点关闭"}');
        return;
      }
      if (String(u.searchParams.get('key') || req.headers['x-simulate-key'] || '') !== simKey) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"error":"bad-key"}');
        return;
      }
      let simBody = ''; req.on('data', (c) => simBody += c);
      req.on('end', () => {
        let simData; try { simData = JSON.parse(simBody); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"ok":false,"error":"bad-json"}'); return;
        }
        const simContent = String((simData && simData.content) || '').trim();
        if (!simContent || simContent.length > 500) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"ok":false,"error":"bad-content"}'); return;
        }
        // 预检①：命令口令（心跳/关机/待机/中止关机）→ 一律拒绝（只能走 QQ）
        if (parseCommandAction(simContent)) {
          logInbox({ taskId: 0, result: 'simulate-blocked-command', content: simContent.slice(0, 60) });
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"ok":false,"error":"command-blocked","hint":"命令类口令只能走 QQ"}'); return;
        }
        // 预检②：带编号的目标项 kind 白名单（命令类/shutdown/sleep 等一律拒绝）
        const SIM_KINDS = ['', 'ask', 'decision', 'gate', 'idle'];
        const simPr = parseReply(simContent) || null;
        const simPc = simPr ? null : parseChoiceReply(simContent);
        const simTargetId = simPr ? simPr.id : (simPc && simPc.id != null ? simPc.id : null);
        if (simTargetId != null) {
          const tp = pending.get(simTargetId);
          if (tp && SIM_KINDS.indexOf(String(tp.kind || '')) < 0) {
            logInbox({ taskId: simTargetId, result: 'simulate-blocked-kind', kind: tp.kind || '' });
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end('{"ok":false,"error":"kind-blocked","kind":' + JSON.stringify(String(tp.kind || '')) + ',"hint":"该类型只能走 QQ 回复"}');
            return;
          }
        }
        // 注入（同一处理链；同步部分完成后再响应 ⇒ 200 = 已落盘/已触发）
        log('[SIMULATE] 注入用户消息：' + simContent.slice(0, 80));
        logInbox({ taskId: simTargetId || 0, result: 'simulate-inject', content: simContent.slice(0, 200) });
        let simErr = '';
        try {
          handleMessage({ d: { author: { user_openid: OPENID }, content: simContent, id: 'hub-local-' + Date.now() } });
        } catch (e) { simErr = e.message; }
        if (simErr) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'inject-failed', message: simErr })); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, injected: simContent.slice(0, 200), targetId: simTargetId }));
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/health') {
      // ★ FIX-34：serve 实例状态异步探活后一并返回（渲染前探活；不含明文口令，只给 webUrl）
      serveStatus((serve) => {
        // ★ FIX-37b：补 charset —— 无 charset 时 PowerShell 5.1 的 Invoke-RestMethod 会把
        //   UTF-8 中文按本地代码页解码 ⇒ keywords 显示成「å¿è·³」（实为读取侧假象，易误判为配置损坏）
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          pending: [...pending.values()].filter((p) => p.status === 'pending').length,
          watch: {
            enabled: WATCH.enabled, idleSeconds: WATCH.idleMs / 1000,
            dirs: WATCH.dirs.length, root: WATCH.root || 'auto',
            idleSec: Math.round((Date.now() - WATCH.lastActivity) / 1000),
            autoQueue: WATCH.autoQueue, autoHandoff: WATCH.autoHandoff,
            handoffGuardSec: WATCH.handoffGuardMs / 1000, handoffRunning,
            // ★ FIX-36：治理参数与静默可观测
            idleMinGapSec: WATCH.idleMinGapMs / 1000, idleCooldownSec: WATCH.idleCooldownMs / 1000,
            taskGate: WATCH.taskGate, taskGateRecheckSec: WATCH.taskGateRecheckMs / 1000,
            skipIdleWhenOpenAsk: WATCH.skipIdleWhenOpenAsk,          // ★ RESUME-1：模式 D 等待期豁免（有未决拍板项则不登记静置邀请）
            taskGateSkips: WATCH.taskGateSkips,
            taskQuietSec: (WATCH.taskQuiet.ms >= 0 ? Math.round(WATCH.taskQuiet.ms / 1000) : -1),
            idleInviteLastAt: WATCH.lastIdleInviteAt ? Math.round((Date.now() - WATCH.lastIdleInviteAt) / 1000) : 0,
            snooze: (function () { const s = snoozeActive('idle'); return s ? { scope: s.scope, remainSec: Math.round((s.until - Date.now()) / 1000) } : null; })(),
            // ★ FIX-25：分桶可观测（排查「到底哪个会话在动」）
            lastSession: WATCH.lastSession ? path.basename(WATCH.lastSession).slice(0, 8) : '',
            lastConv: WATCH.lastConv ? path.basename(WATCH.lastConv).slice(0, 8) : '',
            sessions: WATCH.activity.size,
            sessIdleSec: (() => {
              const o = {}; const now = Date.now();
              for (const kv of WATCH.activity) {
                const d = Math.round((now - kv[1].lastActivity) / 1000);
                if (d < 3600) o[path.basename(kv[0]).slice(0, 8)] = d;
              }
              return o;
            })()
          },
          // ★ FIX-20：推送策略状态（自测/排查用）
          notify: {
            queued: MERGE.items.length, quiet: inQuietHours(),
            muted: notifyMuted() || null,
            mergeWindowMs: NCFG().mergeWindowMs || 90000, mergeMax: NCFG().mergeMax || 5,
          },
          dryRun: !!cfg.dryRun,
          liveness: { hbAgeSec: hbAgeSec(), onlineNotice: NCFG().onlineNotice !== false, offlineNotice: NCFG().offlineNotice !== false },   // ★ FIX-38
          cmdPolicy: (Array.isArray(cfg.commandAllowlist) && cfg.commandAllowlist.length) ? 'allowlist' : 'config-only',
          headless: !!(cfg.headless && cfg.headless.enabled),
          headlessMode: String((cfg.headless && cfg.headless.mode) || 'print'),   // ★ FIX-34
          serve: serve ? { alive: serve.alive, pid: serve.pid, port: serve.port, tier: serve.tier,
            webUrl: serve.webUrl, startedAt: serve.startedAt, lastUsedAt: serve.lastUsedAt } : null,  // ★ FIX-34（不含 directUrl/口令）
          handoffLock: (() => { const l = readHandoffLock(); return l ? { id: l.id, expiresAt: l.expiresAt, mode: l.mode || '' } : null; })(),
          // ★ FIX-37b：命令口令状态 —— 从 QQ 心跳消息移到这里（消息保持纯净，状态仍可查）
          commands: (function () {
            const C = CMDCFG();
            const sc = C.shutdown || {};
            const plan = shutdownPlan();
            return {
              heartbeat: (C.heartbeat && C.heartbeat.keywords) || [],
              shutdown: {
                enabled: !!sc.enabled,
                command: plan.command,
                delaySec: plan.delay,
                confirmWindowSec: Number(sc.confirmWindowSec) || 120,
                cancelCommand: String(sc.cancelCommand || 'shutdown /a'),
              },
              cancelShutdown: (C.cancelShutdown && C.cancelShutdown.keywords) || [],
              sleep: {                                          // ★ FIX-38
                enabled: !!(C.sleep && C.sleep.enabled),
                command: String((C.sleep && C.sleep.command) || ''),
                defaultWakeMin: Number((C.sleep && C.sleep.defaultWakeMin) || 30),
                confirmWindowSec: Number((C.sleep && C.sleep.confirmWindowSec) || 120),
              },
              wake: { keywords: (C.wake && C.wake.keywords) || [], taskName: wakeTaskName() },
              wakeTimer: LAST_WAKE || null,                     // ★ FIX-38：当前唤醒定时器（下次唤醒时刻）
            };
          })()
        }));
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/pending') {
      // ★ session-hub 评审修订⑮：与 /request 同款 httpKey 校验（key 未配置时跳过，保持旧行为）
      if (key && u.searchParams.get('key') !== key) { res.writeHead(403); res.end('forbidden'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // ★ FIX-31：一并返回 options/recommend/timeoutMs（排查"选择题到底传没传进来"）
      res.end(JSON.stringify([...pending.values()].map((p) => ({ id: p.id, status: p.status, prompt: p.prompt,
        kind: p.kind || '', options: p.options || [], recommend: p.recommend || '', timeoutMs: p.timeoutMs || 0,
        session: p.session || '', createdAt: p.createdAt || 0 }))));   // ★ session-hub v2：对话流需 session + 登记时间
      return;
    }
    // ★ session-hub（2026-10-03）：/status 人类页面下线 —— hub 是唯一监控界面（方案分析.md §9）。
    //   hub 活 ⇒ 302（老书签不断链）；hub 死 ⇒ 降级提示页（告知启动方式）。目标可配（cfg.hub.redirectUrl）。
    if (req.method === 'GET' && u.pathname === '/status') {
      const hubCfg = cfg.hub || {};
      const hubUrl = String(hubCfg.redirectUrl || 'http://127.0.0.1:18766/');
      probeHubAlive(hubUrl, Number(hubCfg.probeTimeoutMs || 1500), (alive) => {
        if (alive) {
          res.writeHead(302, { Location: hubUrl });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><head><meta charset="utf-8"><title>/status 已下线</title></head>'
            + '<body style="font-family:Consolas,monospace;margin:24px">'
            + '<h3>/status 状态页已下线</h3>'
            + '<p>监控界面已迁移至 session-hub（<code>' + hubUrl + '</code>），但 hub 当前未运行。</p>'
            + '<p>启动：<code>tools/session-hub/start-hub.ps1</code>（开机自启由 Startup 快捷方式 CodeBuddySessionHub.lnk 拉起）。</p>'
            + '<p>机器接口仍可用：<a href="/health">/health</a> · <a href="/pending">/pending</a></p>'
            + '</body></html>');
        }
      });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/request') {
      if (key && u.searchParams.get('key') !== key) { res.writeHead(403); res.end('forbidden'); return; }
      let body = ''; req.on('data', (c) => body += c);
      req.on('end', () => {
        let data; try { data = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
        // ★ 命令来源优先级：请求体 command（须过白名单）> kind=gate 时的 gateCommand > 空
        let cmd = data.command || '';
        if (cmd && !isCommandAllowed(cmd)) {
          log('[REQUEST] 请求体命令未通过白名单，已忽略：' + cmd);
          cmd = '';
        }
        if (!cmd && data.kind === 'gate') cmd = cfg.gateCommand || '';
        // ★ RESUME-1·D（2026-09-29）：session 白名单兜底 —— 修「第 ④ 闸断链」。
        //   现象：ask.js 登记项不含 session ⇒ p.session='' ⇒ 闸按 `p.session === sess` 过滤 ⇒ **永不命中**
        //   ⇒ 模式 D 等待期仍被静置邀请打断，用户误确认即起 headless 与原会话双写撞车。
        //   白名单只补「等待拍板」类（ask/decision）；门禁类（gate/irreversible，可达 2h）**保持空**，
        //   ⇒ 不会因补 session 而长时间压掉该会话的静置邀请（且门禁为 hook detached spawn，lastConv 未必是触发会话）。
        if (!data.session && (data.kind === 'ask' || data.kind === 'decision')) {
          data.session = WATCH.lastConv || WATCH.lastSession || '';
          log('[REQ SESSION] 兜底 kind=' + data.kind + ' → session='
            + (data.session ? path.basename(data.session).slice(0, 8) : '(空)'));
        }
        const id = registerRequest(data.prompt, cmd, data.id, data.timeoutMs, data.kind, data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ id, status: 'pending' }));
      });
      return;
    }
    // ★ FIX-17：统一发送出口 —— notify.qqbot.js 等外部调用优先经此发送，复用服务的长连接 token
    //          （根治「多进程各自取 token 互相顶号 → 401」；服务不可用时调用方自行回退直发）
    if (req.method === 'POST' && u.pathname === '/notify') {
      if (key && u.searchParams.get('key') !== key) { res.writeHead(403); res.end('forbidden'); return; }
      let body = ''; req.on('data', (c) => body += c);
      req.on('end', () => {
        let data; try { data = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
        const content = String((data && data.content) || '');
        if (!content) { res.writeHead(400); res.end('empty content'); return; }
        // ★ FIX-20：本出口也要认全局静默开关（此前只管门禁 ⇒ 完成通知在维护期照发）
        const m = notifyMuted();
        if (m) {
          log('[NOTIFY SKIP] muted(' + m + ') kind=' + ((data && data.kind) || 'done'));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, muted: true })); return;
        }
        const kind = String((data && data.kind) || 'done').toLowerCase();
        // fail / decision 立即发（要人马上知道 / 要人拍板）；其余入合并队列
        if (kind === 'done' || kind === 'progress') {
          enqueueMerge(kind, content);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, queued: true, kind })); return;
        }
        send(content)
          .then((st) => {
            log('[NOTIFY] HTTP ' + st + ' kind=' + kind + ' len=' + content.length);
            res.writeHead(st === 200 ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: st === 200, status: st, kind }));
          })
          .catch((e) => { log('[NOTIFY ERR] ' + e.message); res.writeHead(500); res.end(String(e.message)); });
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      log('[HTTP ERR] 端口 ' + port + ' 被占用 —— 可能已有实例在跑，或旧 qqbot-daemon.js 未停；'
        + '请先停旧进程，或用 --port 换端口（当前确认模块不可用，watcher 不受影响）');
    } else log('[HTTP ERR] ' + (e && e.message));
  });
  server.listen(port, '127.0.0.1', () => log('[HTTP] 确认注册口 http://127.0.0.1:' + port + '/request'));
}

// ══════════════════════════════════════════════════════════════
// ★ FIX-38（2026-09-21）：「待机 + 定时唤醒」与「上/下线通知」
//   背景：本机 `powercfg -a` 仅支持 S3（休眠未启用）；`wake_armed` 含有线网卡但**网线未插**、
//     Wi-Fi 不支持唤醒 ⇒ 远程开机只能走「服务端定时唤醒（S3）」，WOL 需硬件前提（另议）。
//   设计：① 待机口令始终**带唤醒定时器**（裸「待机」= 默认 N 分钟后唤醒）⇒ 不会出现"睡死"；
//         ② 唤醒定时器 = schtasks + XML(`<WakeToRun>true</WakeToRun>`)，免管理员（待实测）；
//         ③ 关机/待机前先发「即将下线」，优雅停（POST /shutdown）发「已下线」，
//            硬杀/系统关机由 qqbot-watchdog.js 依心跳补发。
// ══════════════════════════════════════════════════════════════
function pad2(n) { return (n < 10 ? '0' : '') + n; }
/** 本地时间 → schtasks StartBoundary 格式（无时区） */
function fmtTaskTime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T'
    + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':00';
}
function wakeTaskName() { return String((CMDCFG().wake || {}).taskName || 'PIVAS-WakeTimer'); }
let LAST_WAKE = '';                      // ★ FIX-38：最近一次「唤醒定时器」文本（供 /health 与心跳探针显示，避免每次查询）
function wakeXmlPath() { return path.join(PROJ_ROOT, '.codebuddy', 'temp', 'wake-timer.xml'); }
/** 生成计划任务 XML（WakeToRun=true ⇒ 到点从 S3/S4 唤醒；DisallowStartIfOnBatteries=false 适配笔记本） */
function buildWakeXml(when) {
  const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + String.fromCharCode(92) : '') + (process.env.USERNAME || '');
  const L2 = [];
  L2.push('<?xml version="1.0" encoding="UTF-16"?>');
  L2.push('<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
  L2.push('  <RegistrationInfo><Description>PIVAS QQ service wake timer (auto-created)</Description></RegistrationInfo>');
  L2.push('  <Triggers><TimeTrigger><StartBoundary>' + fmtTaskTime(when) + '</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>');
  L2.push('  <Principals><Principal id="Author"><UserId>' + user + '</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>');
  L2.push('  <Settings>');
  L2.push('    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  L2.push('    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  L2.push('    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  L2.push('    <AllowHardTerminate>true</AllowHardTerminate>');
  L2.push('    <StartWhenAvailable>false</StartWhenAvailable>');
  L2.push('    <WakeToRun>true</WakeToRun>');
  L2.push('    <Enabled>true</Enabled>');
  L2.push('    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>');
  L2.push('  </Settings>');
  L2.push('  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>/c exit</Arguments></Exec></Actions>');
  L2.push('</Task>');
  return L2.join(LF) + LF;
}
/** 写 XML（schtasks 要求 UTF-16 + BOM） */
function writeWakeXml(when) {
  const f = wakeXmlPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const xml = buildWakeXml(when);
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]));
  return f;
}
/** 创建/覆盖唤醒定时器（到 when 时刻唤醒；命令本身只是唤醒源，动作是无害的 cmd /c exit） */
function setWakeTimer(when, cb) {
  const task = wakeTaskName();
  let f = '';
  try { f = writeWakeXml(when); } catch (e) { cb({ ok: false, reason: '写 XML 失败：' + e.message }); return; }
  execDecoded('schtasks /Create /TN "' + task + '" /XML "' + f + '" /F', {}, (err, stdout) => {
    if (err) { cb({ ok: false, reason: firstLine(err.message), code: err.code }); return; }
    LAST_WAKE = fmtTsMs(when.getTime());
    log('[WAKE] 定时唤醒已建：' + task + ' → ' + fmtTaskTime(when));
    cb({ ok: true, task: task, at: when, out: firstLine(stdout) });
  });
}
/** 查询唤醒定时器（取「下次运行时间」；无任务 ⇒ cb(null)） */
function queryWakeTimer(cb) {
  execDecoded('schtasks /Query /TN "' + wakeTaskName() + '" /FO LIST /V', {}, (err, stdout) => {
    if (err) { cb(null); return; }
    const m = String(stdout).match(/(?:下次运行时间|Next Run Time)\s*[:：]\s*(.+)/);
    LAST_WAKE = m ? m[1].trim() : '';
    cb({ task: wakeTaskName(), next: m ? m[1].trim() : '' });
  });
}
function deleteWakeTimer(cb) {
  execDecoded('schtasks /Delete /TN "' + wakeTaskName() + '" /F', {}, (err) => {
    cb(err ? { ok: false, reason: firstLine(err.message) } : { ok: true });
  });
}
// ── 心跳文件（上线写、每 30s 续写、优雅退出补 stoppedAt；看门狗据此判「异常下线」）──
function hbFile() { return path.join(PROJ_ROOT, '.codebuddy', 'temp', 'qqbot-heartbeat.json'); }
function hbWrite(extra) {
  try {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(hbFile(), 'utf8')) || {}; } catch (e) { /* 首次 */ }
    const body = Object.assign({}, prev, { pid: process.pid, ts: Date.now(), startedAt: prev.startedAt || Date.now() }, extra || {});
    // 心跳续写/上线写入时清掉历史 stoppedAt（否则看门狗会把"当前这次运行"误判为已优雅停止）
    if (!extra || extra.stoppedAt === undefined) delete body.stoppedAt;
    fs.mkdirSync(path.dirname(hbFile()), { recursive: true });
    fs.writeFileSync(hbFile(), JSON.stringify(body), 'utf8');
    return body;
  } catch (e) { log('[HB ERR] ' + e.message); return null; }
}
function hbRead() { try { return JSON.parse(fs.readFileSync(hbFile(), 'utf8')); } catch (e) { return null; } }
/** 距上次心跳秒数（-1 = 无文件） */
function hbAgeSec() {
  const h = hbRead();
  if (!h || !h.ts) return -1;
  return Math.round((Date.now() - Number(h.ts)) / 1000);
}
/** ★ FIX-38：上线通知（服务启动时；含上次退出方式判定） */
function sendOnlineNotice(prev) {
  const it = readIterationContext();
  const sc = CMDCFG().shutdown || {}, sl = CMDCFG().sleep || {};
  const L = ['🟢 机器人已上线 · ' + ts() + '（pid ' + process.pid + '）'];
  L.push(MSG_SEP);
  L.push('服务：端口 ' + (cfg.listenPort || 18765) + ' · dryRun=' + !!cfg.dryRun);
  L.push('迭代：' + (it ? (it.id + '（阶段 ' + (it.phase || '?') + ' · ' + (it.status || '?') + '）') : '（无活跃迭代）'));
  L.push('待确认：' + [...pending.values()].filter((p) => p.status === 'pending').length + ' 条');
  L.push('口令：关机 ' + (sc.enabled ? 'ON' : 'OFF') + ' · 待机 ' + (sl.enabled ? 'ON' : 'OFF'));
  if (prev && prev.stoppedAt) L.push('上次退出：优雅停止（' + fmtTsMs(prev.stoppedAt) + (prev.reason ? ' · ' + prev.reason : '') + '）');
  else if (prev && prev.ts) L.push('⚠️ 上次退出：异常（心跳停在 ' + fmtTsMs(prev.ts) + '，无下线记录）');
  else L.push('上次退出：无记录');
  queryWakeTimer((q) => {
    if (q && q.next) L.push('唤醒定时器：' + q.next);
    log('[ONLINE] ' + L.join(' ｜ '));
    send(L.join('\n')).then((st) => log('[ONLINE] HTTP ' + st)).catch((e) => log('[ONLINE ERR] ' + e.message));
  });
}
/** ★ FIX-38：优雅停止（写 stoppedAt → 发下线通知 → 退出；5s 兜底强退） */
function gracefulStop(reason) {
  hbWrite({ stoppedAt: Date.now(), reason: reason });
  const doExit = () => { log('[EXIT] ' + reason); process.exit(0); };
  if (NCFG().offlineNotice === false) { doExit(); return; }
  const text = '🔴 机器人已下线 · ' + ts() + '（pid ' + process.pid + '）\n' + MSG_SEP + '\n原因：' + reason;
  log('[OFFLINE] 发送下线通知：' + reason);
  send(text).then((st) => { log('[OFFLINE] HTTP ' + st); doExit(); })
    .catch((e) => { log('[OFFLINE ERR] ' + e.message); doExit(); });
  setTimeout(doExit, 5000);      // 兜底：通知发不出去也要退出
}

// ══════════════════════════════════════════════════════════════
// ★ FIX-37（2026-09-21）：QQ 命令口令 ——「心跳」（状态自检）与「关机」（远程关机，二次确认）
//   起因（真实失效实证）：inbox.jsonl 2026-09-19T07:15:39.276Z 用户已真发过「关机」，
//     因无匹配分支落到 fallbackReply（零处理）⇒ 需求成立、非臆测。
//   设计约束（对应本轮方案评估的修法）：
//     ① 口令 = **整条精确匹配**（P1-2：「别关机 / 关机日志」不得误触发）；
//     ② 本分支**必须早于 route() 与自由文本兜底**（P1-2/P1-3：「中止关机」含「中止」∈ cancel 关键词；
//        「关机」「心跳」在有唯一未决项时会被 freeText 当成对该项的答复吃掉）；
//     ③ 关机项**禁止免编号直通**（P0-1：confirm 关键词含「好/可以/ok」⇒ 一句闲聊式应答即断电）；
//     ④ 默认 enabled=false（opt-in）+ 命令模板可配（先用替身脚本验链路，再换真命令）；
//     ⑤ 探针长度受控（send() 无截断，超长会被平台拒收）。
// ══════════════════════════════════════════════════════════════
function CMDCFG() { return (cfg && cfg.commands) || {}; }
/** 口令归一化：全角→半角 + 去所有空白 + 去尾部标点（「关机！」「关机。」等价「关机」） */
function normPhrase(s) {
  return normalizeCmd(s).replace(/[\s\u3000]+/g, '').replace(/[。！？!?，,、~～；;：:]+$/, '');
}
/** 整条**精确**命中关键词表（子串不算；空表 / 缺配 ⇒ false） */
function hitKeyword(list, s) {
  if (!Array.isArray(list)) return false;
  const t = normPhrase(s);
  return !!t && list.some((k) => normPhrase(k) === t);
}
/**
 * 口令 → 动作 `{ name, arg }`（无匹配 ⇒ null）。
 * 顺序：待机/开机（**前缀 + 参数**：`待机 30min` / `开机 07:30`）> 关机 > 中止关机 > 心跳（后三者整条精确匹配）。
 */
function parseCommandAction(content) {
  const C = CMDCFG();
  const t = normPhrase(content);
  const withArg = (list) => {
    if (!Array.isArray(list)) return null;
    for (const k of list) {
      const kk = normPhrase(k);
      if (kk && t.indexOf(kk) === 0) return t.slice(kk.length);   // 命中前缀 ⇒ 参数串（可为空）
    }
    return null;
  };
  const sl = withArg((C.sleep || {}).keywords);
  if (sl !== null) return { name: 'sleep', arg: sl };
  const wk = withArg((C.wake || {}).keywords);
  if (wk !== null) return { name: 'wake', arg: wk };
  if (hitKeyword((C.shutdown || {}).keywords, content)) return { name: 'shutdown', arg: '' };
  if (hitKeyword((C.cancelShutdown || {}).keywords, content)) return { name: 'shutdown-abort', arg: '' };
  if (hitKeyword((C.heartbeat || {}).keywords, content)) return { name: 'heartbeat', arg: '' };
  return null;
}
/** ★ FIX-38：会让机器离线的 kind（免编号直通拦截与关机同款） */
function isOfflineKind(kind) { return kind === 'shutdown' || kind === 'sleep'; }
/** 时长解析：`30` / `30min` / `30分钟` / `2h` / `1.5h` → 分钟；空 ⇒ 默认值；无法识别 ⇒ null */
function parseDurationMin(s, defMin) {
  const t = String(s || '').replace(/[\s\u3000]/g, '');
  if (!t) return defMin;
  const m = t.match(/^(\d+(?:\.\d+)?)(min|m|分钟|分|h|hr|小时|个小时)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  const unit = String(m[2] || '').toLowerCase();
  return Math.round(n * (/^(h|hr|小时|个小时)$/.test(unit) ? 60 : 1));
}
/** 时刻解析：`07:30` / `7:30` / `0730` → 最近一次未来时刻（已过或不足 1 分钟 ⇒ 次日）；无法识别 ⇒ null */
function parseClockAt(s) {
  const t = String(s || '').replace(/[\s\u3000]/g, '').replace(/：/g, ':');
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/) || t.match(/^(\d{3,4})$/);
  if (!m) return null;
  let h, mi;
  if (m[2] !== undefined) { h = parseInt(m[1], 10); mi = parseInt(m[2], 10); }
  else { const v = ('0000' + m[1]).slice(-4); h = parseInt(v.slice(0, 2), 10); mi = parseInt(v.slice(2), 10); }
  if (h > 23 || mi > 59) return null;
  const d = new Date(); d.setSeconds(0, 0); d.setMinutes(mi); d.setHours(h);
  if (d.getTime() <= Date.now() + 60000) d.setDate(d.getDate() + 1);
  return d;
}
/** 时间戳 → `YYYY-MM-DD HH:MM` */
function fmtTsMs(ms) {
  const d = new Date(Number(ms) || 0), p = pad2;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
/** 关机命令计划：模板 {delay} 替换（delay 强制 1~3600 整数 ⇒ 无注入面） */
function shutdownPlan() {
  const sc = CMDCFG().shutdown || {};
  const delay = Math.max(1, Math.min(3600, Math.round(Number(sc.delaySec) || 90)));
  const tpl = String(sc.command || 'shutdown /s /t {delay}');
  return { delay: delay, command: tpl.split('{delay}').join(String(delay)) };
}
/** 时长 → 「xx 分钟 / x.x 小时」 */
function fmtDuration(ms) {
  const m = Math.round(Number(ms || 0) / 60000);
  return m < 60 ? m + ' 分钟' : (m / 60).toFixed(1) + ' 小时';
}
/** 会话定位标签（容器级/会话级自适应；取不到返回空 —— 口径同 buildIdlePrompt） */
function conversationLabel(sess) {
  let wsDir = sess || '';
  let convId = '';
  try {
    if (wsDir && !fs.existsSync(path.join(wsDir, 'index.json'))) {
      const parent = path.dirname(wsDir);
      if (parent && fs.existsSync(path.join(parent, 'index.json'))) { convId = path.basename(wsDir); wsDir = parent; }
    }
  } catch (e) { /* 判不了就按容器级处理 */ }
  const meta = readConversationMeta(wsDir, convId);
  if (meta) return (meta.name || '(未命名)') + ' [' + String(meta.id).slice(0, 8) + ']';
  return wsDir ? path.basename(wsDir).slice(0, 8) : '';
}
/**
 * ★ FIX-37：「心跳」口令的回复体 —— 只读探针（不登记、不执行命令、不受静默/免打扰影响）。
 *   内容：服务与队列 → 迭代阶段/待办 → 接管 → Web UI → 推送/静默 → 最近会话。
 *   ★ FIX-37b（用户实测反馈 2026-09-21 09:26）：**不含**关机口令开关 ——
 *     心跳 = 纯状态自检；配置类信息（关机是否启用）改挂 `/health` 的 `commands` 字段，不混入 QQ 消息。
 */
function buildStatusProbe() {
  const L = [];
  L.push('💓 手动心跳 · ' + ts() + '（服务已运行 ' + fmtDuration(process.uptime() * 1000) + '）');
  L.push(MSG_SEP);
  const openList = [...pending.values()].filter((p) => p.status === 'pending');
  L.push('服务：在线 · 端口 ' + (cfg.listenPort || 18765) + ' · 待确认 ' + openList.length + ' 条');
  const it = readIterationContext();
  if (it) {
    L.push('迭代：' + it.id + '（阶段 ' + (it.phase || '?') + ' · ' + (it.status || '?') + '）');
    if (it.pending.length) L.push('待办：' + it.pending.join(' ｜ ') + (it.more ? ' …（另 ' + it.more + ' 项）' : ''));
  } else {
    L.push('迭代：（无活跃迭代）');
  }
  const lock = readHandoffLock();
  L.push('接管：' + (lock
    ? ('运行中 #' + lock.id + ' · 剩余约 ' + Math.max(0, Math.round((Number(lock.expiresAt) - Date.now()) / 60000)) + ' 分钟')
    : ('空闲（handoffRunning=' + handoffRunning + '）')));
  const inst = readServeInstance();
  L.push('Web UI：' + (inst && inst.port ? ('127.0.0.1:' + inst.port + (inst.pid ? '（pid ' + inst.pid + '）' : '')) : '（无 serve 实例）'));
  L.push('推送：' + (notifyMuted() ? ('已静默（' + notifyMuted() + '）') : '正常')
    + ' · ' + (inQuietHours() ? '免打扰时段内' : '免打扰时段外'));
  const all = snoozeActive('all'), idleSn = snoozeActive('idle');
  if (all) L.push('静默：全部通知至 ' + snoozeLabel(all.until));
  else if (idleSn) L.push('静默：静置邀请至 ' + snoozeLabel(idleSn.until));
  if (LAST_WAKE) L.push('唤醒定时器：' + LAST_WAKE);        // ★ FIX-38：仅在存在时显示（避免噪音）
  const label = conversationLabel(WATCH.lastConv || WATCH.lastSession);
  if (label) {
    const idleMs = WATCH.lastActivity ? (Date.now() - WATCH.lastActivity) : -1;
    L.push('最近会话：' + label + (idleMs >= 0 ? ('（静置 ' + Math.round(idleMs / 1000) + 's）') : ''));
  }
  return L.join('\n');
}
function doHeartbeat() {
  const text = buildStatusProbe();
  log('[CMD] heartbeat 探针 ' + text.length + ' 字');
  logInbox({ result: 'cmd-heartbeat' });
  send(text).then((st) => log('[CMD] heartbeat HTTP ' + st)).catch((e) => log('[CMD ERR] heartbeat: ' + e.message));
}
/** 「关机」口令 —— **只登记不执行**；确认#N 后才由 doPending 执行命令 */
function doShutdownRequest(content) {
  const sc = CMDCFG().shutdown || {};
  if (!sc.enabled) {
    log('[CMD] shutdown 口令被忽略（enabled=false）');
    logInbox({ result: 'shutdown-disabled', text: String(content).slice(0, 60) });
    send('🔒 远程关机未启用：daemon.config.json → commands.shutdown.enabled 现为 false。'
      + '如需启用请在本机改为 true 并重启合并服务。').catch(() => {});
    return;
  }
  const dup = [...pending.values()].filter((p) => p.status === 'pending' && p.kind === 'shutdown')[0];
  if (dup) {
    const left = Math.max(0, Math.round((dup.createdAt + dup.timeoutMs - Date.now()) / 1000));
    logInbox({ taskId: dup.id, result: 'shutdown-dup' });
    send('ℹ️ 已有待确认的关机项 #' + dup.id + '（剩余 ' + left + 's）。回「确认#' + dup.id
      + '」执行，或「取消#' + dup.id + '」作废。').catch(() => {});
    return;
  }
  const plan = shutdownPlan();
  const win = Math.max(30, Math.min(1800, Math.round(Number(sc.confirmWindowSec) || 120)));
  const id = registerRequest('QQ 口令「' + firstLine(content) + '」（' + ts() + '）',
    plan.command, 0, win * 1000, 'shutdown', { delaySec: plan.delay });
  log('[CMD #' + id + '] shutdown 登记：' + plan.command + ' · 窗口 ' + win + 's · 倒计时 ' + plan.delay + 's');
  logInbox({ taskId: id, result: 'shutdown-requested', command: plan.command });
}
/**
 * 「中止关机」口令 —— 执行 shutdown /a。
 *   ★ 不随 enabled 开关关闭（中止属安全方向）；本机无进行中的关机时命令自身报错 ⇒ 按信息回执而非失败告警。
 */
function doShutdownAbort() {
  const sc = CMDCFG().shutdown || {};
  const cmd = String(sc.cancelCommand || 'shutdown /a');
  log('[CMD] shutdown-abort：' + cmd);
  logInbox({ result: 'shutdown-abort' });
  send('🛑 收到「中止关机」，正在执行：' + cmd).catch(() => {});
  execDecoded(cmd, { env: execEnv(null, 'shutdown-abort', '') }, (err, stdout) => {
    if (err) {
      log('[CMD ERR] shutdown-abort: ' + err.message + '（code=' + err.code + '）');
      // ★ FIX-37d：1116 = 没有进行中的关机（Windows 原文经 GBK 解码后已是可读中文）
      const note = (err.code === 1116) ? '本机没有进行中的关机（1116）' : ('命令返回：' + firstLine(err.message));
      send('ℹ️ 中止结果：' + note + '（无待中止的关机时属正常）。').catch(() => {});
    } else {
      log('[CMD OK] shutdown-abort: ' + stdout.slice(0, 200));
      send('✅ 已执行中止：' + (stdout.slice(0, 140) || cmd)).catch(() => {});
    }
  });
}
/** ★ FIX-38：「待机」/「开机」共用登记（#N 二次确认 → 确认后**先建唤醒定时器**再待机） */
function registerSleepRequest(content, wakeAt, extraNote) {
  const sc = CMDCFG().sleep || {};
  if (!sc.enabled) {
    log('[CMD] sleep 口令被忽略（enabled=false）');
    logInbox({ result: 'sleep-disabled', text: String(content).slice(0, 60) });
    send('🔒 待机未启用：daemon.config.json → commands.sleep.enabled 现为 false。如需启用请改为 true 并重启合并服务。').catch(() => {});
    return;
  }
  const dup = [...pending.values()].filter((p) => p.status === 'pending' && p.kind === 'sleep')[0];
  if (dup) {
    send('ℹ️ 已有待确认的待机项 #' + dup.id + '（计划唤醒 ' + fmtTsMs(dup.wakeAtMs) + '）。'
      + '回「确认#' + dup.id + '」执行，或「取消#' + dup.id + '」作废。').catch(() => {});
    logInbox({ taskId: dup.id, result: 'sleep-dup' });
    return;
  }
  const win = Math.max(30, Math.min(1800, Math.round(Number(sc.confirmWindowSec) || 120)));
  const mins = Math.max(1, Math.round((wakeAt.getTime() - Date.now()) / 60000));
  const id = registerRequest(
    'QQ 口令「' + firstLine(content) + '」（' + ts() + '）｜计划唤醒：' + fmtTsMs(wakeAt.getTime())
      + '（约 ' + mins + ' 分钟后）' + (extraNote ? '｜' + extraNote : ''),
    '', 0, win * 1000, 'sleep', { delaySec: mins * 60, wakeAtMs: wakeAt.getTime() });
  log('[CMD #' + id + '] sleep 登记：唤醒 ' + fmtTsMs(wakeAt.getTime()) + '（' + mins + ' 分钟后）· 窗口 ' + win + 's');
  logInbox({ taskId: id, result: 'sleep-requested', wakeAt: fmtTsMs(wakeAt.getTime()) });
}
/** 「待机 [时长]」口令（裸「待机」= defaultWakeMin 分钟后唤醒 ⇒ 不会睡死） */
function doSleepRequest(content, arg) {
  const sc = CMDCFG().sleep || {};
  const defMin = Math.max(1, Math.min(1440, Math.round(Number(sc.defaultWakeMin) || 30)));
  const maxMin = Math.max(defMin, Math.min(10080, Math.round(Number(sc.maxWakeMin) || 1440)));
  const min = parseDurationMin(arg, defMin);
  if (min === null) {
    logInbox({ result: 'sleep-bad-duration', text: String(arg).slice(0, 40) });
    send('⚠️ 无法识别的时长「' + firstLine(arg) + '」：请用「待机 30min」/「待机 2h」；不带时长 = ' + defMin + ' 分钟后唤醒。').catch(() => {});
    return;
  }
  const capped = min > maxMin, useMin = capped ? maxMin : min;
  registerSleepRequest(content, new Date(Date.now() + useMin * 60000),
    capped ? ('时长超上限 ⇒ 已按 ' + maxMin + ' 分钟截断') : '');
}
/** 「开机 HH:MM」口令（= 设定时唤醒 + 立即待机；不带时间 ⇒ defaultWakeMin 分钟后） */
function doWakeRequest(content, arg) {
  const sc = CMDCFG().sleep || {};
  const defMin = Math.max(1, Math.min(1440, Math.round(Number(sc.defaultWakeMin) || 30)));
  if (!String(arg || '').trim()) {
    registerSleepRequest(content, new Date(Date.now() + defMin * 60000), '未指定时间 ⇒ 按默认 ' + defMin + ' 分钟');
    return;
  }
  const at = parseClockAt(arg);
  if (!at) {
    logInbox({ result: 'wake-bad-clock', text: String(arg).slice(0, 40) });
    send('⚠️ 无法识别的时间「' + firstLine(arg) + '」：请用「开机 07:30」（24 小时制；已过则顺延到明天）。').catch(() => {});
    return;
  }
  registerSleepRequest(content, at, '定时唤醒（到点自动恢复，无需登录）');
}
function handleMessage(m) {
  const d = m.d || {};
  const oid = d.author && d.author.user_openid;
  if (oid !== OPENID) { log('[IGNORE] 非本人 openid: ' + oid); return; }
  const content = String(d.content || '').trim();
  logInbox({ openid: oid, content, msgId: d.id });
  log('[MSG] ' + content);
  const openList = [...pending.values()].filter((p) => p.status === 'pending');
  const r = parseReply(content);
  if (r) { doPending(r.id, r.type); return; }                       // ① 二元确认语法（确认#N / 取消#N）
  // ★ FIX-31：② 选项答复语法（`B#12` 精确寻址 / `B` 唯一未决选择题直通）—— 先于关键词与自由文本
  const ch = parseChoiceReply(content);
  if (ch) {
    if (ch.id != null) {
      const p0 = pending.get(ch.id);
      if (p0 && p0.status === 'pending' && (p0.options || []).length) { doChoice(p0, ch.key); return; }
      if (!p0 || p0.status !== 'pending') {
        send('⚠️ 没有待确认的 #' + ch.id + '（可能已完成或超时）。').catch(() => {});
        return;
      }
      // 该编号存在但非选择题 ⇒ 落到后续（关键词 / 自由文本 / fallback）
    } else {
      const choiceList = openList.filter((p) => (p.options || []).length);
      if (choiceList.length === 1) { doChoice(choiceList[0], ch.key); return; }
      if (choiceList.length > 1) {
        send('当前有 ' + choiceList.length + ' 道选择题，请带编号回复（如 ' + ch.key + '#<编号>）。').catch(() => {});
        return;
      }
      // 无未决选择题 ⇒ 落到后续
    }
  }
  // ★ 回IDE（2026-10-06）：免编号直通 —— 唯一未决「非 idle」项时生效（须早于 route()/freeText，
  //   否则会被自由文本兜底当成对该项的文字答复）。idle 项不适用：其「回 IDE 操作」= 不影响邀请，语义不同。
  if (/^回\s*ide$/i.test(normalizeCmd(content))) {
    const ideList = openList.filter((p) => p.kind !== 'idle');
    if (ideList.length === 1) { doPending(ideList[0].id, 'ide'); return; }
    if (ideList.length > 1) {
      send('当前有 ' + ideList.length + ' 条待确认，请带编号回复（如 回IDE#' + ideList[0].id + '）。').catch(() => {});
      return;
    }
    // 无非 idle 未决项 ⇒ 落到后续（fallback 提示）
  }
  // ★ FIX-37：③ 命令口令（心跳 / 关机 / 中止关机）—— **必须早于 route() 与自由文本兜底**：
  //   否则「中止关机」会被 cancel 关键词（含「中止」）当成某条待办的取消；
  //   「关机」「心跳」在有唯一未决项时会被 freeText 当成对该项的答复吃掉。
  const ca = parseCommandAction(content);
  if (ca) {
    // （各 do* 自行落 inbox 审计，此处不重复记）★ FIX-38：`ca` 改为 {name, arg}
    if (ca.name === 'heartbeat') { doHeartbeat(); return; }
    if (ca.name === 'shutdown') { doShutdownRequest(content); return; }
    if (ca.name === 'shutdown-abort') { doShutdownAbort(); return; }
    if (ca.name === 'sleep') { doSleepRequest(content, ca.arg); return; }
    if (ca.name === 'wake') { doWakeRequest(content, ca.arg); return; }
  }
  // ★ FIX-36：③ 静默指令 —— **必须早于 route()**：否则「取消，并且1h内不再提醒」会被
  //   cancel 关键词的 indexOf('取消') 吞掉（只剩「请带编号」回执）—— 这正是用户实测失效的成因。
  const snz = parseSnooze(content);
  if (snz) {
    if (snz.action === 'clear') {
      clearSnooze();
      send('▶️ 静默已解除。').catch(() => {});
      log('[SNOOZE] clear by user');
    } else {
      setSnooze(snz.sec, snz.scope, snz.raw);
      const scopeLabel = (snz.scope === 'all') ? '全部通知（含完成/门禁）' : '静置接管邀请';
      send('⏸ 已按你的要求静默：' + scopeLabel + ' 至 ' + snoozeLabel(SNOOZE.until)
        + '｜需要你拍板的 #N、失败告警照常推送｜回「取消静默」提前解除。'
        + (snz.capped ? '（已按上限截断）' : '')).catch(() => {});
      log('[SNOOZE] set scope=' + snz.scope + ' sec=' + snz.sec + ' until=' + new Date(SNOOZE.until).toTimeString().slice(0, 8) + ' raw=' + snz.raw.slice(0, 60));
    }
    logInbox({ result: 'snooze-' + snz.action, scope: snz.scope, sec: snz.sec });
    return;
  }
  const name = route(content);
  if ((name === 'confirm' || name === 'cancel') && openList.length > 0) {
    if (openList.length === 1) {
      // ★ FIX-37（评估 P0-1）：关机项**禁止免编号直通** —— confirm 关键词含「好/可以/没问题/ok」，
      //   若唯一未决项恰是关机项，一句闲聊式应答就会断电。取消方向仍放行（不作废更安全）。
      const only = openList[0];
      if (name === 'confirm' && isOfflineKind(only.kind)) {
        const kLabel = (only.kind === 'sleep') ? '待机' : '关机';
        log('[GUARD #' + only.id + '] ' + kLabel + '项拒绝免编号直通（原文：' + firstLine(content) + '）');
        logInbox({ taskId: only.id, result: (only.kind === 'sleep' ? 'sleep' : 'shutdown') + '-bare-keyword-blocked', text: String(content).slice(0, 60) });
        send('⚠️ #' + only.id + ' 是「' + kLabel + '」确认：为避免误触，本项必须带编号回复「确认#' + only.id
          + '」；回「取消#' + only.id + '」则不作' + (only.kind === 'sleep' ? '待机' : '关机') + '处理。').catch(() => {});
        return;
      }
      doPending(only.id, name); return;                     // 唯一一条 → 免编号直通
    }
    send('当前有 ' + openList.length + ' 条待确认。回复「确认#编号 / 取消#编号」；选择题回「选项#编号」（如 B#12）指定哪一条。').catch(() => {});
    return;
  }
  if (name) { doAction(name); return; }
  // ★ FIX-17d：自由文本答复 —— 存在「唯一未决项」时，把内容型回答（如「B」「审查报告」）视为对该项的答复
  //   背景：headless 曾把选择题写成纯文本菜单，用户回「B」被 fallback 吞掉（问题发得出、答案回不来）。
  const ft = cfg.actions && cfg.actions.freeText;
  const ftEnabled = !(ft && ft.enabled === false);
  const ftMax = (ft && ft.maxChars) || 300;
  if (ftEnabled && content && content.length <= ftMax && openList.length === 1) {
    doFreeReply(openList[0], content);
    return;
  }
  send(cfg.fallbackReply).catch((e) => log('[FB ERR] ' + e.message));
}

let wsRef = null, hb = null, reconnectTimer = null;
function cleanup() { if (hb) clearInterval(hb); if (wsRef) { try { wsRef.close(); } catch (e) {} } }
function scheduleReconnect(reason) {
  if (TEST) return;
  if (reconnectTimer) return;
  log('[RECONNECT in 5s] ' + reason);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
}
function connect() {
  https.get({ hostname: 'api.sgroup.qq.com', path: '/gateway', headers: { Authorization: 'QQBot ' + token } }, (res) => {
    let d = ''; res.on('data', (c) => d += c);
    res.on('end', () => {
      let url; try { url = JSON.parse(d).url; } catch (e) { return scheduleReconnect('gateway parse'); }
      if (!url) return scheduleReconnect('no url');
      const ws = new WebSocket(url, { headers: { Authorization: 'QQBot ' + token, 'X-UnionAppid': appId } });
      wsRef = ws;
      ws.on('message', (buf) => {
        let mm; try { mm = JSON.parse(buf.toString()); } catch (e) { return; }
        if (mm.op === 10) {
          const iv = (mm.d && mm.d.heartbeat_interval ? mm.d.heartbeat_interval : 30000) - 2000;
          hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })); } catch (e) {} }, iv);
          ws.send(JSON.stringify({ op: 2, d: { token: 'QQBot ' + token, intents: 1 << 25 } }));
          log('[READY] 监听中，等待你的回复...');
          if (TEST) setTimeout(() => { log('[TEST] 连接就绪，退出测试'); cleanup(); process.exit(0); }, 5000);
        } else if (mm.op === 0 && mm.t === 'C2C_MESSAGE_CREATE') {
          handleMessage(mm);
        } else if (mm.op === 7) {
          log('[RECONNECT] 收到重连指令'); scheduleReconnect('op7');
        }
      });
      ws.on('error', (e) => { log('[WS ERR] ' + e.message); scheduleReconnect('ws error'); });
      ws.on('close', () => { if (!TEST) scheduleReconnect('close'); });
    });
  }).on('error', (e) => { log('[GW ERR] ' + e.message); scheduleReconnect('gw error'); });
}

// ── 启动 ────────────────────────────────────────────────────
process.on('uncaughtException', (e) => log('UNCAUGHT: ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => log('UNHANDLED: ' + ((e && e.message) || e)));
// ★ FIX-38：Ctrl+C 也走优雅停（发下线通知 + 写 stoppedAt）；硬杀/系统关机由看门狗兜底
process.on('SIGINT', () => { cleanup(); gracefulStop('SIGINT/Ctrl+C'); });

// ★ FIX-30：离线渲染自测入口 —— `node qqbot-service.js --render <rec.json>`（不启动服务，直接打印消息文本）
if (args.render) {
  try {
    const recJson = JSON.parse(fs.readFileSync(args.render, 'utf8').replace(/^\uFEFF/, ''));
    process.stdout.write(renderRequestText(recJson) + '\n');
    process.exit(0);
  } catch (e) { console.error('[ERR] --render: ' + e.message); process.exit(1); }
}
// ★ FIX-31：离线解析自测入口 —— `node qqbot-service.js --parse "B#13"`（不启动服务，打印三类语法的解析结果）
if (args.parse) {
  process.stdout.write(JSON.stringify({
    reply: parseReply(args.parse), choice: parseChoiceReply(args.parse), route: route(args.parse)
  }) + '\n');
  process.exit(0);
}
// ★ FIX-36：离线静默解析自测入口 —— `node qqbot-service.js --snooze-parse "静默2h"`（不启动服务）
if (args.snoozeParse) {
  const r = parseSnooze(args.snoozeParse);
  process.stdout.write(JSON.stringify({
    input: args.snoozeParse,
    snooze: r,
    reply: parseReply(args.snoozeParse),                 // 回归：确认/取消#N 不得被静默分支劫持
    choice: parseChoiceReply(args.snoozeParse),
    route: route(args.snoozeParse),
  }) + '\n');
  process.exit(0);
}
// ★ FIX-37：离线口令解析自测 —— `node qqbot-service.js --cmd-parse "关机"`（不启动服务、不发 QQ）
if (args.cmdParse) {
  const ca = parseCommandAction(args.cmdParse);
  const nm = (ca && ca.name) || null, arg = (ca && ca.arg) || '';
  const sc = CMDCFG().sleep || {};
  const defMin = Math.max(1, Math.round(Number(sc.defaultWakeMin) || 30));
  const durMin = (nm === 'sleep') ? parseDurationMin(arg, defMin) : null;
  const clock = (nm === 'wake') ? parseClockAt(arg) : null;
  process.stdout.write(JSON.stringify({
    input: args.cmdParse, action: nm, arg: arg,
    shutdownPlan: (nm === 'shutdown') ? shutdownPlan() : null,
    sleepMinutes: durMin,
    wakeAt: (nm === 'sleep' && durMin) ? fmtTsMs(Date.now() + durMin * 60000) : (clock ? fmtTsMs(clock.getTime()) : null),
    shutdownEnabled: !!((CMDCFG().shutdown || {}).enabled),
    sleepEnabled: !!sc.enabled,
    route: route(args.cmdParse),          // 回归：口令不得被 route() 关键词吞掉（期望 null）
    reply: parseReply(args.cmdParse),     // 回归：口令不得被误解析成「确认#N」
  }) + '\n');
  process.exit(0);
}
// ★ FIX-37：离线渲染状态探针 —— `node qqbot-service.js --probe`（不发送；核对文案与长度）
if (args.probe) {
  const t = buildStatusProbe();
  process.stdout.write(t + '\n[长度 ' + t.length + ' 字]\n');
  process.exit(0);
}
// ★ FIX-39：离线汇总渲染自测 —— `node qqbot-service.js --merge-test`
//   核对三件事：① n=1 逐字直发原文 ② n≥2 套「汇总」壳且每条 ≤120 ③ 截断必带「…」
if (args.mergeTest) {
  const longText = '【完成：迭代 2026-09-21-001 的 03-技术方案已结清（用户确认「A 方案通过」）⇒ 推进 04 并预置 13 步（7 待执行 + 6 not_applicable）。03 交付含 30 文件改动范围、11 项决策 D-1~D-11；术语整改「HIS 编码」→「来源编码」已落盘并回写 CONTEXT/01/02；doc_lint 0/0】';
  const one = renderMergeText([{ kind: 'done', content: longText }]);
  const two = renderMergeText([
    { kind: 'done', content: longText },
    { kind: 'progress', content: '【进度心跳】会话持续活跃（FIX-24）\n────\n本次动作：replace_in_file src/xxx.ts' },
  ]);
  const out = [];
  out.push('— n=1（应逐字等于原文：不套壳、不截断）—');
  out.push(one);
  out.push('[长度 ' + one.length + ' · 与原文逐字相等 ' + (one === longText) + ']');
  out.push('');
  out.push('— n=2（应套「汇总」壳 + 每条超 120 以 … 收尾）—');
  out.push(two);
  out.push('[长度 ' + two.length + ']');
  out.push('');
  out.push('— 边界：120 / 121 字 —');
  out.push('120 → ' + JSON.stringify(summaryLine('x'.repeat(120))) + '（无省略号）');
  out.push('121 → ' + JSON.stringify(summaryLine('x'.repeat(121))) + '（117 字 + …）');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}
// ★ FIX-37d：离线解码自测 —— `node qqbot-service.js --dec-test ["net helpmsg 1190"]`
//   跑一条**无副作用**的中文输出命令，对比 GBK / UTF-8 解码（证明乱码根因与修法；同步执行，不会启动服务）。
if (args.decTest) {
  const cmd = (typeof args.decTest === 'string' && args.decTest) ? args.decTest : 'net helpmsg 1190';
  let raw = Buffer.alloc(0), code = 0;
  try {
    raw = execSync(cmd, { cwd: PROJ_ROOT, windowsHide: true, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] }) || Buffer.alloc(0);
  } catch (e) {
    raw = (e && e.stderr && e.stderr.length) ? e.stderr : ((e && e.stdout) || Buffer.alloc(0));
    code = (e && typeof e.status === 'number') ? e.status : -1;
  }
  const utf8 = raw.toString('utf8').trim(), gbk = decodeConsoleBytes(raw).trim();
  process.stdout.write(JSON.stringify({
    cmd: cmd, exitCode: code, rawBytes: raw.length,
    decodedGBK: gbk, gbkOk: !/\uFFFD/.test(gbk),
    decodedUTF8: utf8, utf8Ok: !/\uFFFD/.test(utf8),
  }, null, 2) + '\n');
  process.exit(0);
}

// ★ FIX-38：唤醒定时器离线自测（**不进入待机**）
//   `node qqbot-service.js --wake-test 3`  → 建「3 分钟后」的定时器 → 查询 → 删除（验证 schtasks 免管理员可行性）
//   `node qqbot-service.js --wake-query`   → 只查询
//   `node qqbot-service.js --wake-del`     → 删除
if (args.wakeTest || args.wakeQuery || args.wakeDel) {
  const done = (o) => { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); process.exit(0); };
  if (args.wakeDel) { deleteWakeTimer((r) => done({ op: 'delete', result: r })); }
  else if (args.wakeQuery) { queryWakeTimer((r) => done({ op: 'query', task: wakeTaskName(), result: r })); }
  else {
    const min = Math.max(1, Math.min(1440, Math.round(Number(args.wakeTest) || 3)));
    const when = new Date(Date.now() + min * 60000);
    setWakeTimer(when, (set) => {
      if (!set.ok) { done({ op: 'set', at: fmtTaskTime(when), result: set }); return; }
      queryWakeTimer((q) => {
        deleteWakeTimer((del) => done({
          op: 'set-query-delete', at: fmtTaskTime(when), xml: wakeXmlPath(),
          set: set, query: q, deleted: del,
        }));
      });
    });
  }
}

// ★ FIX-30/31：导出纯函数供离线自测（`require` 本文件不会启动服务 —— 见下方 require.main 守卫）
module.exports = {
  renderRequestText: renderRequestText,
  parseChoiceReply: parseChoiceReply,
  parseReply: parseReply,
  route: route,
  normOptions: normOptions,
  timeoutLabel: timeoutLabel,
  canReviveSuperseded: canReviveSuperseded,   // ★ FIX-32（供离线自测）
  isWriteTool: isWriteTool,                   // ★ FIX-35（供离线自测）
  parseSnooze: parseSnooze,                   // ★ FIX-36（供离线自测：snooze 语法）
  isSessionShape: isSessionShape,             // ★ FIX-36（供离线自测：指纹形态白名单）
  noteSettled: noteSettled,                   // ★ FIX-36（供离线自测：结算冷却）
  serveStatus: serveStatus,                   // ★ FIX-34（供离线自测：无实例时返回 null，不抛错）
  readServeInstance: readServeInstance,       // ★ FIX-34（供离线自测）
  serveInstanceFile: serveInstanceFile,       // ★ FIX-34（供离线自测）
  runtimeDir: runtimeDir,                     // ★ FIX-34（供离线自测）
  spawnServe: spawnServe,                     // ★ FIX-34（供离线自测：降级分支 restartCount≥maxRestart 不 spawn）
  ensureServeInstance: ensureServeInstance,   // ★ FIX-34（供离线自测）
  writeServeInstance: writeServeInstance,     // ★ FIX-34（供离线自测）
  parseCommandAction: parseCommandAction,     // ★ FIX-37（供离线自测：心跳/关机/中止关机 口令）
  shutdownPlan: shutdownPlan,                 // ★ FIX-37（供离线自测：命令模板与 {delay} 替换）
  buildStatusProbe: buildStatusProbe,         // ★ FIX-37（供离线自测：状态探针渲染）
  normPhrase: normPhrase,                     // ★ FIX-37（供离线自测：口令归一化）
  decodeConsoleBytes: decodeConsoleBytes,     // ★ FIX-37d（供离线自测：GBK 解码）
  execDecoded: execDecoded,                   // ★ FIX-37d（供离线自测：解码版 exec）
  renderMergeText: renderMergeText,           // ★ FIX-39（供离线自测：n=1 直发原文 / n≥2 摘要）
  summaryLine: summaryLine,                   // ★ FIX-39（供离线自测：超长截断带 …）
};

// ── 启动（仅直接运行时；被 require 时只导出纯函数，供自测脚本使用）──────
// ★ FIX-38：异步自测（`--wake-test` / `--wake-query` / `--wake-del`）在回调里才 process.exit，
//   若不在守卫里排除 ⇒ 会一路启动整套服务（实测：误起第二个实例并尝试抢占 18765 端口）。
if (require.main === module && !args.wakeTest && !args.wakeQuery && !args.wakeDel) {
(async () => {
  log('=== qqbot-service start pid=' + process.pid + ' ===');
  log('creds: appId=' + mask(appId) + ' openId=' + mask(OPENID) + ' source=' + creds.from + ' dryRun=' + !!cfg.dryRun);
  // ★ FIX-37：命令口令配置可见（排查「口令无响应 / 关机未启用」无需翻配置文件）
  const _sc = CMDCFG().shutdown || {};
  log('FIX-37 commands: heartbeat=' + JSON.stringify((CMDCFG().heartbeat || {}).keywords || [])
    + ' · shutdown=' + (_sc.enabled ? ('ON → ' + shutdownPlan().command + '（窗口 ' + (Number(_sc.confirmWindowSec) || 120) + 's）') : 'OFF')
    + ' · abort=' + JSON.stringify((CMDCFG().cancelShutdown || {}).keywords || []));
  await getToken();
  log('token OK');
  // ★ FIX-38：心跳 + 上线通知（先读上次心跳判断是否异常退出，再写新心跳）
  const prevHb = hbRead();
  hbWrite({ reason: 'start' });
  setInterval(() => hbWrite({}), Math.max(5, Number((NCFG().liveness || {}).writeSec || 30)) * 1000);
  if (NCFG().onlineNotice !== false) sendOnlineNotice(prevHb);
  setInterval(() => { getToken(true).catch((e) => log('TOKEN REFRESH ERR: ' + e.message)); }, 90 * 60 * 1000);

  if (WATCH.enabled) {
    WATCH.dirs = discoverHistoryDirs();
    if (!WATCH.root && WATCH.dirs.length === 0) log('WATCH 未发现 IDE history 目录（CodeBuddyIDE）');
    log('WATCH on idle=' + (WATCH.idleMs / 1000) + 's root=' + (WATCH.root || 'auto') + ' dirs=' + WATCH.dirs.length);
    // ★ FIX-36：治理参数与静默状态可见（重启后静默不丢 ⇒ 这里要能看出来）
    log('FIX-36 params: taskGate=' + WATCH.taskGate + ' minGap=' + (WATCH.idleMinGapMs / 1000) + 's cooldown='
      + (WATCH.idleCooldownMs / 1000) + 's taskGateRecheck=' + (WATCH.taskGateRecheckMs / 1000) + 's snoozeFile=' + snoozeFilePath());
    log('RESUME-1 params: skipIdleWhenOpenAsk=' + WATCH.skipIdleWhenOpenAsk);   // ★ 模式 D 等待期豁免（有未决拍板项则不登记静置邀请）
    loadSnooze();
    if (SNOOZE.until > Date.now()) log('[SNOOZE] 生效中 scope=' + SNOOZE.scope + ' 至 ' + snoozeLabel(SNOOZE.until));
    watchLoop();
  } else log('WATCH off (--no-watch)');

  if (!args.noDaemon) {
    try { WebSocket = require('ws'); } catch (e) {
      // ★ P3 健壮化（2026-10-05）：原为静默半死——wsOk=false 时 HTTP+QQ 双灭但心跳照写，
      //   watchdog（:77-79 无心跳才告警）永不触发。改 FATAL 退出，宁可崩给 watchdog 看。
      log('[FATAL] 缺少依赖 ws —— 确认模块无法启动（HTTP ' + (cfg.listenPort || 18765) + ' 与 QQ WebSocket 全灭）。' +
        '修复：在项目根或 tools/qqbot 执行 npm install ws 后重启服务。');
      process.exit(1);
    }
    startHttp(); connect();
  } else log('DAEMON off (--no-daemon)');
})().catch((e) => { log('[FATAL] ' + e.message); process.exit(1); });
}
