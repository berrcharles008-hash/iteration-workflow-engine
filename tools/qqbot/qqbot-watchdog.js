#!/usr/bin/env node
// qqbot-watchdog.js —— 宿主服务心跳看门狗（★ FIX-38，2026-09-21）
//
// 职责：**只通知、不重启**。宿主服务（qqbot-service.js）硬杀/系统关机时来不及发「下线通知」
//   （TerminateProcess ⇒ Node 的 exit/SIGINT 处理器不会跑），本进程独立存活，靠心跳文件判定：
//     心跳过期（> notify.liveness.staleSec）且**不是**优雅停止 ⇒ 发一条 QQ「🔴 服务异常下线」。
//
// 判定口径：
//   - 优雅停止（stop-service.ps1 / POST /shutdown / Ctrl+C）⇒ 心跳文件带 `stoppedAt` ⇒ **不告警**；
//   - 机器关机导致的中断 ⇒ 本进程也随机器消失 ⇒ 下次开机由「上线通知」里标注「上次异常退出」；
//   - 启动首个 tick 只建立**基线**（避免"机器刚开机、心跳文件还是旧的"误报）。
//
// 用法：node qqbot-watchdog.js            （常驻；start-watchdog.ps1 后台拉起）
//       node qqbot-watchdog.js --once     （单次检查后退出，自测用）
// 日志：tools/qqbot/watchdog.log
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const PROJ = path.resolve(DIR, '..', '..');
// ★ 自测口：QQBOT_WD_SELFTEST=1 ⇒ 用独立的测试心跳/状态文件且**跳过启动基线**（可验告警路径，不污染真实状态）
const SELFTEST = process.env.QQBOT_WD_SELFTEST === '1';
const HB = path.join(PROJ, '.codebuddy', 'temp', SELFTEST ? 'qqbot-hb-test.json' : 'qqbot-heartbeat.json');
const STATE = path.join(PROJ, '.codebuddy', 'temp', SELFTEST ? 'qqbot-watchdog-state-test.json' : 'qqbot-watchdog-state.json');
const LOG = path.join(DIR, 'watchdog.log');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'daemon.config.json'), 'utf8')); } catch (e) { /* 用默认 */ }
const LV = (cfg.notify && cfg.notify.liveness) || {};
const STALE_MS = Math.max(60, Number(LV.staleSec || 180)) * 1000;
const POLL_MS = Math.max(15, Number(LV.watchPollSec || 60)) * 1000;

function log(m) {
  const d = new Date(), p = (n) => (n < 10 ? '0' : '') + n;
  const line = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + m;
  try { console.log(line); } catch (e) { /* 无控制台 */ }
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* 日志失败不致命 */ }
}
function hb() { try { return JSON.parse(fs.readFileSync(HB, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } }
function st() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } }
function saveSt(o) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o), 'utf8'); } catch (e) { /* 忽略 */ }
}
/**
 * 经 notify.qqbot.js 发送（服务已死时自动回退直发，凭据取自 qqbot.creds.json / env）。
 * ★ 用 **execFileSync**（同步）而非 execFile —— 异步版在自测 `--once` 场景下父进程先退出，
 *   回调来不及落日志（实测 2026-09-21 10:40/10:41 两次：只有 [ALERT]，无 [NOTIFY] 行，无法判断是否真发出）。
 *   本进程是专职看门狗（60s 一次），同步阻塞几秒无副作用，换来**确定性的发送结果与日志**。
 * ★ `stdio[0]='ignore'`：notify.qqbot.js 会 `readFileSync(0)` 读 hook 入参，
 *   若 stdin 是被父进程持有的管道会**永久阻塞**（通知静默失败）。
 */
function notify(what) {
  try {
    const out = execFileSync(process.execPath, [path.join(DIR, 'notify.qqbot.js'), '--kind', 'fail', '--what', what],
      { cwd: PROJ, windowsHide: true, timeout: 60000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    log('[NOTIFY] ' + String(out || '').trim().slice(0, 200));
  } catch (e) {
    const so = String((e && e.stdout) || '').trim().slice(0, 160);
    log('[NOTIFY ERR] ' + ((e && e.message) || e) + (so ? (' ｜ out: ' + so) : ''));
  }
}

let baselined = false;
function tick() {
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
      const key = String(h.ts);
      if (s.notifiedFor !== key) {
        const ageSec = Math.round(ageMs / 1000);
        saveSt({ notifiedFor: key, at: Date.now(), ageSec: ageSec });
        log('[ALERT] 心跳中断 ' + ageSec + 's（pid ' + (h.pid || '?') + '）⇒ 发下线通知');
        notify('qqbot-service 心跳中断 ' + Math.max(1, Math.round(ageSec / 60)) + ' 分钟（pid ' + (h.pid || '?')
          + '，预计异常退出：机器关机或服务被强杀）');
      }
    } else if (s.notifiedFor) {
      saveSt({ notifiedFor: '' });
      log('[RESET] 心跳恢复 / 已优雅停止 ⇒ 告警状态复位');
    }
  } catch (e) { log('[ERR] ' + e.message); }
  hubTick();
}

// ★ session-hub（2026-10-03，评审修订⑨）：hub 端口探活 —— 状态翻转记 watchdog.log；
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

log('=== watchdog start（stale=' + (STALE_MS / 1000) + 's poll=' + (POLL_MS / 1000) + 's，只通知不重启'
  + (SELFTEST ? '｜SELFTEST 模式（独立测试文件）' : '') + '）===');
// 为 watchdog.log 补 UTF-8 BOM（幂等）—— 否则 PowerShell 5.1 的 Get-Content 按系统代码页解码，中文显示为乱码
(function ensureLogBom() {
  try {
    const BOM = String.fromCharCode(0xFEFF);
    const exists = fs.existsSync(LOG);
    const has = exists && fs.readFileSync(LOG, 'utf8').slice(0, 1) === BOM;
    if (!has) fs.writeFileSync(LOG, BOM + (exists ? fs.readFileSync(LOG, 'utf8') : ''), 'utf8');
  } catch (e) { /* 不致命 */ }
})();
tick();
if (process.argv.indexOf('--once') >= 0) { setTimeout(() => process.exit(0), 8000); return; }
setInterval(tick, POLL_MS);
