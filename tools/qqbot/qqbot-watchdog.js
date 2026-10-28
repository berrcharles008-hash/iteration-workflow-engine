#!/usr/bin/env node
// qqbot-watchdog.js —— 宿主服务看门狗（★ FIX-38 2026-09-21 · ★ TOOL-SELFHEAL 2026-10-28）
//
// 职责（三路分流）：
//   ① 端口通（GET 127.0.0.1:<listenPort>/health，超时 ≤2s）⇒ 正常，沿用 FIX-38 心跳告警逻辑；
//   ② 端口不通 + **进程在** ⇒ 半死态：**只告警一次，不杀、不重启**（交人工处置）；
//   ③ 端口不通 + 进程不在 ⇒ 调 start-service.ps1 自动拉起，带**单实例锁 + 冷却(≥5min) + 每小时上限(3)**。
//
// ★ 为什么判活用「端口」而不是「进程存在」：2026-10-28 实测 09:43 —— request-confirm.js 报
//   ECONNREFUSED 127.0.0.1:18765，而 start-service.ps1 因为「进程在」打印 already running 直接跳过，
//   入站全失却零告警。进程存活 ≠ 服务可用。
//
// ★ 为什么自动拉起必须加锁 + 冷却 + 上限：qqbot-service.js 对 EADDRINUSE **只记日志不退出**
//   ⇒ 第二个实例会带着 watcher + QQ WebSocket 继续跑 = 顶号 + 通知双发。锁 + 拉起前二次复检把这条堵死。
//
// ★ 为什么半死态不自动杀：用户 2026-10-28 拍板「杀半死进程必须经用户确认后才执行」。
//   杀进程只在人工 `--force` 分支里（且先用 CIM 校验 CommandLine 命中 qqbot-service.js 才动手），
//   **任何自动路径都不得进入 --force**。
//
// 判定口径（心跳部分，FIX-38）：
//   - 优雅停止（stop-service.ps1 / POST /shutdown / Ctrl+C）⇒ 心跳文件带 `stoppedAt` ⇒ **不告警、不拉起**；
//   - 机器关机导致的中断 ⇒ 本进程也随机器消失 ⇒ 下次开机由「上线通知」里标注「上次异常退出」；
//   - 启动首个 tick 只建立**基线**（避免"机器刚开机、心跳文件还是旧的"误报）。
//
// 用法：node qqbot-watchdog.js            （常驻；计划任务/ start-watchdog.ps1 拉起）
//       node qqbot-watchdog.js --once     （单次检查后退出，自测用）
//       node qqbot-watchdog.js --force    （★ 人工触发：端口不通且进程在 ⇒ 杀 + 拉起；自动路径永不调用）
// 日志：tools/qqbot/watchdog.log
//
// ★ 自测旋钮（默认值 = 生产口径；仅供离线验证，正常运行时不要设）：
//   QQBOT_WD_SELFTEST=1      用独立心跳/状态文件，且跳过启动基线判定（可验告警路径，不污染真实状态）
//   QQBOT_WD_PORT=<port>     探活端口（默认 notify.liveness.restart.port / listenPort / 18765）
//   QQBOT_WD_PROC_MATCH=<s>  进程命令行匹配串（默认 qqbot-service.js）
//   QQBOT_WD_START_PS1=<p>   拉起脚本（默认 tools/qqbot/start-service.ps1）；测试指向桩脚本 ⇒ 绝不启真服务
//   QQBOT_WD_NO_NOTIFY=1     不发 QQ，只留 [NOTIFY SKIP] 日志
//   QQBOT_WD_AUTO=0|1        覆盖自动拉起开关（SELFTEST 下默认 0，其余取配置 restart.enabled）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, execFile } = require('child_process');

const DIR = __dirname;
const PROJ = path.resolve(DIR, '..', '..');
const SELFTEST = process.env.QQBOT_WD_SELFTEST === '1';
const HB = path.join(PROJ, '.codebuddy', 'temp', SELFTEST ? 'qqbot-hb-test.json' : 'qqbot-heartbeat.json');
const STATE = path.join(PROJ, '.codebuddy', 'temp', SELFTEST ? 'qqbot-watchdog-state-test.json' : 'qqbot-watchdog-state.json');
const LOG = path.join(DIR, 'watchdog.log');
const LOCK = path.join(PROJ, '.codebuddy', 'temp', SELFTEST ? 'qqbot-watchdog-restart-test.lock' : 'qqbot-watchdog-restart.lock');
const FORCE = process.argv.indexOf('--force') >= 0;

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'daemon.config.json'), 'utf8')); } catch (e) { /* 用默认 */ }
const LV = (cfg.notify && cfg.notify.liveness) || {};
const STALE_MS = Math.max(60, Number(LV.staleSec || 180)) * 1000;
const POLL_MS = Math.max(15, Number(LV.watchPollSec || 60)) * 1000;

// ── ★ TOOL-SELFHEAL 参数 ─────────────────────────────────────
const RC = LV.restart || {};
const SVC_PORT = Math.max(1, Number(process.env.QQBOT_WD_PORT || RC.port || cfg.listenPort || 18765));
const PROBE_TIMEOUT_MS = Math.max(200, Math.min(10000, Number(RC.probeTimeoutMs || 2000)));
const PROC_MATCH = String(process.env.QQBOT_WD_PROC_MATCH || 'qqbot-service.js');
const START_PS1 = process.env.QQBOT_WD_START_PS1 || path.join(DIR, 'start-service.ps1');
const NO_NOTIFY = process.env.QQBOT_WD_NO_NOTIFY === '1';
const COOLDOWN_MS = Math.max(30, Number(RC.cooldownSec || 300)) * 1000;
const MAX_PER_HOUR = Math.max(1, Number(RC.maxPerHour || 3));
const LOCK_STALE_MS = 120 * 1000;
// ★ 降噪（2026-10-28 实测后补）：本机高负载时 /health 会数秒~数分钟不应答（重启后全量扫描、
//   40 万文件索引、112MB 日志增量读），而「单次探活失败即判半死并告警」会误报（当天 10:46 / 10:53 两次实发）。
//   ⇒ ① 单轮探活最多重试 PROBE_ATTEMPTS 次；② 半死须「持续」HALF_DEAD_ALERT_MS 才告警；
//   ③ 自动拉起后 GRACE_MS 内端口不通只等待（启动扫描期）；④ CIM 查询超时放宽到 60s（只在下行路径）。
const PROBE_ATTEMPTS = Math.max(1, Math.min(5, Number(RC.probeAttempts || 2)));
const HALF_DEAD_ALERT_MS = Math.max(10, Number(RC.halfDeadAlertSec || 120)) * 1000;
const GRACE_MS = Math.max(0, Number(RC.graceSec || 180)) * 1000;
const CIM_TIMEOUT_MS = Math.max(5000, Number(RC.cimTimeoutMs || 60000));
// 自动拉起期间抑制「心跳中断」告警的窗口（同一故障不双报；拉起后心跳会立刻续写）
const HB_ALERT_HOLD_MS = Math.max(COOLDOWN_MS, 180 * 1000);
const AUTO = (SELFTEST && process.env.QQBOT_WD_AUTO !== '1')
  ? false
  : (process.env.QQBOT_WD_AUTO != null ? process.env.QQBOT_WD_AUTO !== '0' : RC.enabled !== false);

function log(m) {
  const d = new Date(), p = (n) => (n < 10 ? '0' : '') + n;
  const line = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + m;
  try { console.log(line); } catch (e) { /* 无控制台 */ }
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* 日志失败不致命 */ }
}
function hb() { try { return JSON.parse(fs.readFileSync(HB, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } }
function st() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, ''));
    return (o && typeof o === 'object') ? o : {};
  } catch (e) { return {}; }
}
function saveSt(o) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o), 'utf8'); } catch (e) { /* 忽略 */ }
}
/** ★ TOOL-SELFHEAL：读-改-写合并（旧版 saveSt({...}) 是整体覆盖 ⇒ 会把新增字段清掉） */
function patchSt(patch) { saveSt(Object.assign({}, st(), patch || {})); }

/**
 * 经 notify.qqbot.js 发送（服务已死时自动回退直发，凭据取自 qqbot.creds.json / env）。
 * ★ 用 **execFileSync**（同步）而非 execFile —— 异步版在自测 `--once` 场景下父进程先退出，
 *   回调来不及落日志（实测 2026-09-21 10:40/10:41 两次：只有 [ALERT]，无 [NOTIFY] 行，无法判断是否真发出）。
 *   本进程是专职看门狗（60s 一次），同步阻塞几秒无副作用，换来**确定性的发送结果与日志**。
 * ★ `stdio[0]='ignore'`：notify.qqbot.js 会 `readFileSync(0)` 读 hook 入参，
 *   若 stdin 是被父进程持有的管道会**永久阻塞**（通知静默失败）。
 */
function notify(what) {
  if (NO_NOTIFY) { log('[NOTIFY SKIP] ' + what.slice(0, 120)); return; }
  try {
    const out = execFileSync(process.execPath, [path.join(DIR, 'notify.qqbot.js'), '--kind', 'fail', '--what', what],
      { cwd: PROJ, windowsHide: true, timeout: 60000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    log('[NOTIFY] ' + String(out || '').trim().slice(0, 200));
  } catch (e) {
    const so = String((e && e.stdout) || '').trim().slice(0, 160);
    log('[NOTIFY ERR] ' + ((e && e.message) || e) + (so ? (' ｜ out: ' + so) : ''));
  }
}

// ── ★ TOOL-SELFHEAL：端口探活 / 进程探活 / 单实例锁 ─────────────────
let pending = 0;            // 进行中的异步链计数（--once 收尾判定）
let svcDown = null;         // null=未知；true/false=端口状态
let restartInFlight = false;
let hbAlertSuppressed = false;

/** 单次 GET http://127.0.0.1:<SVC_PORT>/health（2xx 视为通；超时/拒连均为不通） */
function probeOnce(cb) {
  let done = false;
  const finish = (v, extra) => { if (!done) { done = true; cb(v, extra || {}); } };
  let req;
  try {
    req = http.request({ host: '127.0.0.1', port: SVC_PORT, path: '/health', method: 'GET', timeout: PROBE_TIMEOUT_MS }, (r) => {
      const code = r.statusCode || 0;
      r.resume();
      r.on('end', () => finish(code >= 200 && code < 300, { status: code }));
      r.on('error', () => finish(false, { status: code }));
    });
  } catch (e) { finish(false, { error: e.message }); return; }
  req.on('error', () => finish(false));
  req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } finish(false, { timeout: true }); });
  req.end();
}
/** 带重试的探活：单轮最多 PROBE_ATTEMPTS 次（间隔 300ms），全失败才判「不通」 */
function probeService(cb) {
  let attempt = 0;
  const tryOnce = () => {
    attempt++;
    probeOnce((up, extra) => {
      if (up) { cb(true, Object.assign({ attempt: attempt }, extra)); return; }
      if (attempt >= PROBE_ATTEMPTS) { cb(false, Object.assign({ attempt: attempt }, extra)); return; }
      setTimeout(tryOnce, 300);
    });
  };
  tryOnce();
}

/** PowerShell 命令：列出「命令行命中 PROC_MATCH」的 node 进程 pid（与 start-service.ps1 的 guard 同口径） */
function psProcCmd() {
  const safe = PROC_MATCH.replace(/[^\w.\-]/g, '');
  if (!safe) return '';
  return 'Get-CimInstance Win32_Process -Filter "Name like \'node%\'" -ErrorAction SilentlyContinue '
    + '| Where-Object { $_.CommandLine -like \'*' + safe + '*\' } '
    + '| ForEach-Object { $_.ProcessId }';
}
function parsePids(out) {
  return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}
function servicePids(cb) {
  const ps = psProcCmd();
  if (!ps) { cb([], new Error('QQBOT_WD_PROC_MATCH 非法')); return; }
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { cwd: PROJ, windowsHide: true, timeout: CIM_TIMEOUT_MS, encoding: 'utf8' },
    (err, stdout) => {
      if (err) { cb(null, err); return; }
      cb(parsePids(stdout), null);
    });
}
function servicePidsSync() {
  const ps = psProcCmd();
  if (!ps) return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { cwd: PROJ, windowsHide: true, timeout: 20000, encoding: 'utf8' });
    return parsePids(out);
  } catch (e) { return null; }
}

/** 单实例锁：`wx` 原子创建；>120s 的僵尸锁可接管（进程被杀会留下锁） */
function takeLock() {
  const body = JSON.stringify({ pid: process.pid, ts: Date.now() });
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeSync(fd, body);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    try {
      const ageMs = Date.now() - fs.statSync(LOCK).mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        fs.unlinkSync(LOCK);
        const fd = fs.openSync(LOCK, 'wx');
        fs.writeSync(fd, body);
        fs.closeSync(fd);
        log('[LOCK] 接管过期锁（' + Math.round(ageMs / 1000) + 's > ' + Math.round(LOCK_STALE_MS / 1000) + 's）');
        return true;
      }
    } catch (e2) { /* 并发删除等 → 视为拿不到 */ }
    return false;
  }
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch (e) { /* ignore */ } }

// ── 心跳判定（FIX-38，逻辑不变）────────────────────────────────
let baselined = false;
function hbTick() {
  try {
    const h = hb();
    const s = st();
    const ageMs = (h && h.ts) ? (Date.now() - Number(h.ts)) : -1;
    if (!baselined) {
      baselined = true;
      log('[BASE] 启动基线 hbAge=' + (ageMs < 0 ? 'nofile' : Math.round(ageMs / 1000) + 's') + (SELFTEST ? '（自测：跳过基线判定）' : ''));
      if (!SELFTEST && ageMs >= 0 && ageMs > STALE_MS) return;       // 历史遗留（如刚开机）⇒ 不告警
    }
    if (ageMs < 0) return;                              // 从未有过心跳 ⇒ 不告警（避免误报）
    const gracefully = !!(h.stoppedAt && Number(h.stoppedAt) >= Number(h.ts));
    if (ageMs > STALE_MS && !gracefully) {
      // ★ TOOL-SELFHEAL：自动拉起窗口内不重复报「心跳中断」（同一次故障不双报）
      if (restartInFlight || (s.lastRestartAt && Date.now() - Number(s.lastRestartAt) < HB_ALERT_HOLD_MS)) {
        if (!hbAlertSuppressed) { hbAlertSuppressed = true; log('[ALERT SKIP] 自动拉起窗口内，抑制心跳中断告警'); }
        return;
      }
      hbAlertSuppressed = false;
      const key = String(h.ts);
      if (s.notifiedFor !== key) {
        const ageSec = Math.round(ageMs / 1000);
        patchSt({ notifiedFor: key, at: Date.now(), ageSec: ageSec });
        log('[ALERT] 心跳中断 ' + ageSec + 's（pid ' + (h.pid || '?') + '）⇒ 发下线通知');
        notify('qqbot-service 心跳中断 ' + Math.max(1, Math.round(ageSec / 60)) + ' 分钟（pid ' + (h.pid || '?')
          + '，预计异常退出：机器关机或服务被强杀）');
      }
    } else if (s.notifiedFor) {
      patchSt({ notifiedFor: '' });
      hbAlertSuppressed = false;
      log('[RESET] 心跳恢复 / 已优雅停止 ⇒ 告警状态复位');
    }
  } catch (e) { log('[ERR] ' + e.message); }
}

// ── ★ TOOL-SELFHEAL：服务三路分流 ─────────────────────────────
function tryRestart(reason, finish) {
  const now = Date.now();
  const s = st();
  if (!AUTO) { log('[RESTART SKIP] 自动拉起已关闭（notify.liveness.restart.enabled=false 或 SELFTEST）'); finish(); return; }
  if (s.lastRestartAt && now - Number(s.lastRestartAt) < COOLDOWN_MS) {
    log('[RESTART SKIP] 冷却中：距上次拉起 ' + Math.round((now - Number(s.lastRestartAt)) / 1000)
      + 's < ' + Math.round(COOLDOWN_MS / 1000) + 's');
    finish();
    return;
  }
  const recent = (Array.isArray(s.restarts) ? s.restarts : []).map(Number).filter((t) => t && now - t < 3600 * 1000);
  if (recent.length >= MAX_PER_HOUR) {
    log('[RESTART SKIP] 已达每小时上限 ' + MAX_PER_HOUR + ' 次（近 1h 实拉 ' + recent.length + ' 次）⇒ 停止自动拉起，需人工处置');
    if (!s.budgetAlertAt || now - Number(s.budgetAlertAt) > 3600 * 1000) {
      patchSt({ budgetAlertAt: now });
      notify('qqbot-service 自动拉起已达每小时上限 ' + MAX_PER_HOUR + ' 次仍不健康 ⇒ 已停止自动拉起，需人工处置（看 service.log / 用 --force）');
    }
    finish();
    return;
  }
  if (!takeLock()) {
    log('[RESTART SKIP] 单实例锁被占用（另一实例正在拉起）⇒ 本次跳过');
    finish();
    return;
  }
  // 锁内二次复检：端口 + 进程（竞态下别人可能已经拉起来了，不能再起第二个）
  probeService((up) => {
    if (up) { log('[RESTART SKIP] 复检 /health 已通（并发已恢复）'); releaseLock(); finish(); return; }
    servicePids((pids, err) => {
      if (err) { log('[RESTART SKIP] 复检进程清单失败：' + err.message); releaseLock(); finish(); return; }
      if (pids && pids.length) {
        log('[RESTART SKIP] 复检发现进程 ' + pids.join(',') + '（半死态）⇒ 交人工，不自动拉起');
        releaseLock();
        finish();
        return;
      }
      spawnService(reason, { countBudget: true, recent: recent }, finish);
    });
  });
}

function spawnService(reason, opts, finish) {
  opts = opts || {};
  const now = Date.now();
  const s = st();
  const recent = Array.isArray(opts.recent) ? opts.recent
    : (Array.isArray(s.restarts) ? s.restarts : []).map(Number).filter((t) => t && now - t < 3600 * 1000);
  const patch = { lastRestartAt: now };
  if (opts.countBudget !== false) patch.restarts = recent.concat([now]).slice(-50);
  patchSt(patch);
  restartInFlight = true;
  if (opts.countBudget === false) {
    log('[RESTART] ' + reason + ' ⇒ 调 ' + path.basename(START_PS1) + '（人工触发，不计入自动配额）');
  } else {
    log('[RESTART] ' + reason + ' ⇒ 调 ' + path.basename(START_PS1) + '（本小时第 ' + (recent.length + 1) + '/' + MAX_PER_HOUR + ' 次）');
  }
  let out = '';
  try {
    out = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', START_PS1],
      { cwd: DIR, windowsHide: true, timeout: 90000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log('[RESTART ERR] ' + ((e && e.message) || e));
    const so = String((e && e.stdout) || '').trim();
    if (so) log('[RESTART ERR OUT] ' + so.slice(0, 200));
  }
  const first = String(out || '').trim().split(/\r?\n/)[0];
  if (first) log('[RESTART OUT] ' + first.slice(0, 160));
  // 锁的职责只覆盖「检-起」窗口；之后由 lastRestartAt 冷却兜住
  releaseLock();
  if (typeof finish === 'function') finish();
  // 3s 后复检：pid 变化留痕（不阻塞 tick 链）
  pending++;
  setTimeout(() => {
    try {
      probeService((up) => {
        const pid = (hb() || {}).pid || '?';
        if (up) log('[RESTART OK] /health 恢复，pid=' + pid);
        else log('[RESTART WAIT] 已拉起但 /health 仍不通，等下一 tick 复核（pid=' + pid + '）');
        restartInFlight = false;
      });
    } catch (e) { restartInFlight = false; }
    pending--;
  }, 3000);
}

function svcTick() {
  pending++;
  let done = false;
  const finish = () => { if (!done) { done = true; pending--; } };
  try {
    probeService((up) => {
      if (up) {
        if (svcDown === true) log('[SVC UP] /health 恢复（:' + SVC_PORT + '）');
        svcDown = false;
        const s0 = st();
        if (s0.halfDeadFor || s0.halfDeadKey || s0.halfDeadSince) {
          patchSt({ halfDeadFor: '', halfDeadKey: '', halfDeadSince: 0 });
          log('[RESET] 半死告警状态复位');
        }
        finish();
        return;
      }
      if (svcDown !== true) log('[SVC DOWN] /health 不通（:' + SVC_PORT + '，已重试 ' + PROBE_ATTEMPTS + ' 次）⇒ 区分半死 / 未运行');
      svcDown = true;
      servicePids((pids, err) => {
        if (err) { log('[PROC ERR] ' + err.message + ' ⇒ 本轮不动作'); finish(); return; }
        if (pids && pids.length) {
          const key = pids.slice().sort().join(',');
          const s = st();
          const now = Date.now();
          if (s.halfDeadFor === key) {
            log('[HALF-DEAD] 同一进程仍半死（pid ' + key + '）⇒ 已告警过，不重复、不自动杀');
            finish();
            return;
          }
          // ① 重启后宽限期：刚拉起时服务在做全量扫描（日志/索引），/health 可能数分钟不应答 ⇒ 只等待
          const sinceRestart = s.lastRestartAt ? now - Number(s.lastRestartAt) : Infinity;
          if (sinceRestart < GRACE_MS) {
            log('[SVC WAIT] 重启宽限期内（剩 ' + Math.ceil((GRACE_MS - sinceRestart) / 1000) + 's，pid ' + key + '）⇒ 暂不判半死');
            finish();
            return;
          }
          // ② 半死须「持续」达阈值才告警（单次探活失败多为高负载抖动；当天两次误报即此）
          if (s.halfDeadKey !== key || !s.halfDeadSince) {
            patchSt({ halfDeadKey: key, halfDeadSince: now });
            log('[HALF-DEAD?] 观察中（pid ' + key + '；需持续 ' + Math.round(HALF_DEAD_ALERT_MS / 1000) + 's 才告警）');
            finish();
            return;
          }
          const deadMs = now - Number(s.halfDeadSince);
          if (deadMs < HALF_DEAD_ALERT_MS) {
            log('[HALF-DEAD?] 持续 ' + Math.round(deadMs / 1000) + 's < ' + Math.round(HALF_DEAD_ALERT_MS / 1000) + 's ⇒ 继续观察（pid ' + key + '）');
            finish();
            return;
          }
          patchSt({ halfDeadFor: key });
          log('[HALF-DEAD] 进程在（pid ' + key + '）但端口 ' + SVC_PORT + ' 已持续 ' + Math.round(deadMs / 1000)
            + 's 不通 ⇒ 需人工处置（不自动杀、不自动拉起）');
          notify('qqbot-service 半死：进程在（pid ' + key + '）但 ' + SVC_PORT
            + ' 端口已持续 ' + Math.round(deadMs / 1000) + 's 不通，需人工处置（人工确认后可 stop-service.ps1 或 qqbot-watchdog.js --force）');
          finish();
          return;
        }
        const h = hb();
        const gracefully = !!(h && h.stoppedAt && Number(h.stoppedAt) >= Number(h.ts));
        if (gracefully) {
          const key = 'stop:' + String(h.stoppedAt);
          if (st().gracefulSkipFor !== key) {
            patchSt({ gracefulSkipFor: key });
            log('[RESTART SKIP] 服务已优雅停止（心跳 stoppedAt=' + h.stoppedAt + '）⇒ 不自动拉起');
          }
          finish();
          return;
        }
        if (st().gracefulSkipFor) patchSt({ gracefulSkipFor: '' });
        tryRestart('端口 ' + SVC_PORT + ' 不通且无服务进程', finish);
      });
    });
  } catch (e) { log('[SVC ERR] ' + e.message); finish(); }
}

function tick() {
  hbTick();
  hubTick();
  svcTick();
}

// ── ★ session-hub（2026-10-03，评审修订⑨）：hub 端口探活 —— 状态翻转记 watchdog.log；
//   QQ 告警仅在「曾探活成功后死亡」时发一次（hub 从未启用过不告警，避免部署外机器误报）。
const HUB_PORT = 18766;
let hubUp = null;
function probeHub(cb) {
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  const req = http.request({ host: '127.0.0.1', port: HUB_PORT, path: '/health', method: 'GET', timeout: 2000 }, (r) => {
    r.resume(); finish(true);
  });
  req.on('error', () => finish(false));
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
  req.end();
}
function hubTick() {
  try {
    probeHub((up) => {
      if (up === hubUp) return;
      const prev = hubUp;
      hubUp = up;
      if (up) log('[HUB UP] session-hub(:' + HUB_PORT + ') 探活恢复');
      else if (prev === true) {
        log('[HUB DOWN] session-hub(:' + HUB_PORT + ') 探活失败 ⇒ 发告警');
        notify('session-hub 服务（:' + HUB_PORT + '）失联（曾运行后失联，可能被强杀或崩溃；重启：tools/session-hub/start-hub.ps1）');
      } else log('[HUB DOWN] session-hub(:' + HUB_PORT + ') 未运行（从未探活成功，不告警）');
    });
  } catch (e) { log('[HUB ERR] ' + e.message); }
}

// ── ★ TOOL-SELFHEAL：人工 `--force`（★ 只有人能触发；自动路径不得调用）────
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}
function forceRecover() {
  log('=== watchdog --force（人工触发：杀半死进程 + 拉起；自动路径永不进入）===');
  probeService((up) => {
    if (up) { log('[FORCE] /health 正常（:' + SVC_PORT + '）⇒ 无需处置'); process.exit(0); return; }
    servicePids((pids, err) => {
      if (err) { log('[FORCE ERR] 进程清单读取失败：' + err.message); process.exit(2); return; }
      const targets = pids || [];
      log('[FORCE] /health 不通（:' + SVC_PORT + '）；命令行命中「' + PROC_MATCH + '」的进程：'
        + (targets.length ? targets.join(',') : '(无)'));
      for (const pid of targets) {
        log('[FORCE-KILL] taskkill /PID ' + pid + ' /F');
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
        } catch (e) {
          log('[FORCE-KILL ERR] pid ' + pid + '：' + ((e && e.message) || e));
        }
      }
      if (targets.length) {
        // 等进程真正退出（≤5s）—— 否则 start-service.ps1 的「进程在即跳过」guard 会静默不动
        for (let i = 0; i < 10; i++) {
          sleepSync(500);
          const left = servicePidsSync();
          if (!left || left.length === 0) break;
        }
      }
      if (!takeLock()) { log('[FORCE STOP] 单实例锁被占用 ⇒ 放弃（另一实例正在拉起）'); process.exit(2); return; }
      spawnService('人工 --force 处置', { countBudget: false }, () => {});
      setTimeout(() => process.exit(0), 4500);
    });
  });
}

log('=== watchdog start（stale=' + (STALE_MS / 1000) + 's poll=' + (POLL_MS / 1000) + 's'
  + '；端口探活 :' + SVC_PORT + ' 超时 ' + PROBE_TIMEOUT_MS + 'ms×' + PROBE_ATTEMPTS
  + '；自动拉起 ' + (AUTO ? 'ON' : 'OFF') + '（冷却 ' + (COOLDOWN_MS / 1000) + 's / 上限 ' + MAX_PER_HOUR + '次·h）'
  + '；半死须持续 ' + (HALF_DEAD_ALERT_MS / 1000) + 's、重启宽限 ' + (GRACE_MS / 1000) + 's、仅告警'
  + (SELFTEST ? '｜SELFTEST 模式（独立测试文件）' : '')
  + (FORCE ? '｜FORCE 人工处置' : '') + '）===');
// 为 watchdog.log 补 UTF-8 BOM（幂等）—— 否则 PowerShell 5.1 的 Get-Content 按系统代码页解码，中文显示为乱码
(function ensureLogBom() {
  try {
    const BOM = String.fromCharCode(0xFEFF);
    const exists = fs.existsSync(LOG);
    const has = exists && fs.readFileSync(LOG, 'utf8').slice(0, 1) === BOM;
    if (!has) fs.writeFileSync(LOG, BOM + (exists ? fs.readFileSync(LOG, 'utf8') : ''), 'utf8');
  } catch (e) { /* 不致命 */ }
})();

if (FORCE) {
  forceRecover();
} else {
  tick();
  if (process.argv.indexOf('--once') >= 0) {
    // 单次模式：等异步链跑完（探活 ≤2s + CIM ~0.5s），最多 25s
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pending <= 0 || Date.now() - t0 > 25000) { clearInterval(iv); process.exit(0); }
    }, 200);
  } else {
    setInterval(tick, POLL_MS);
  }
}
