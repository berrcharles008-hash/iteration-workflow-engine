#!/usr/bin/env node
// ask.js —— 「等待式确认」登记器：把一条待确认事项推送到 QQ，并打印可直接用于等待的 #id
//
// 用法（agent / 脚本调用）：
//   node tools/qqbot/ask.js --prompt "是否按此预览批量落盘？"
//   node tools/qqbot/ask.js --prompt "…" --kind ask --timeoutSec 1800 --json
//   node tools/qqbot/ask.js --prompt "…" --handoff --handoffPrompt "剩余工作：…"
//   ★ 选择题（FIX-31）：--options "A=立即实施;B=先实证;C=仅记录" [--recommend B]
//     ⇒ QQ 端渲染「A/B/C → 后果」对照表；用户回「B」或带编号「B#12」即可（不必回「确认#12」）
//
// 输出：人类可读两行 + `#id=<n>`（供脚本解析）；加 --json 则只输出 {"id":n,"status":"pending"}
// 配套：`tools/qqbot/wait-answer.ps1 -Id <n> -TimeoutSec 300`（轮询答案文件，拿到即返回 JSON）
// 典型流程（agent 不停机等待）：
//   ask.js 登记 → wait-answer.ps1 轮询（分片 ≤5 分钟/次）→ 你在 QQ 回「确认#N」→ 服务写答案文件 → agent 继续
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
// ★ FIX-40（2026-09-29）：登记时刻 + 同号残留清理。
//   项目根 = tools/qqbot 上两级；答案目录须与 qqbot-service.js 的 cfg.answerDir 默认值一致。
const PROJ_ROOT = path.resolve(DIR, '..', '..');
const ANSWER_DIR = path.join(PROJ_ROOT, '.codebuddy', 'temp', 'qq-answers');
function clearStaleAnswer(id) {
  try {
    const f = path.join(ANSWER_DIR, String(id) + '.json');
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.error('[WARN] 已清理同号历史答案文件 #' + id + '.json（防撞号误读）');
    }
  } catch (e) { console.error('[WARN] 清理同号答案文件失败：' + e.message); }
}

function parseArgs() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--kind') a.kind = argv[++i];
    else if (k === '--timeoutSec') a.timeoutSec = parseInt(argv[++i], 10);
    else if (k === '--handoff') a.handoff = true;
    else if (k === '--handoffPrompt') a.handoffPrompt = argv[++i];
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--json') a.json = true;
    else if (k === '--options') a.options = argv[++i];       // ★ FIX-31：`A=label;B=label;…`
    else if (k === '--recommend') a.recommend = argv[++i];   // ★ FIX-31：推荐项键（须在 --options 内）
    else if (k === '--session') a.session = argv[++i];       // ★ session-hub v2：显式关联会话 id（如 hub 的 s-xxx）
  }
  return a;
}
/**
 * ★ FIX-31（2026-09-19）：`--options "A=立即实施; B=先实证"` → [{key:'A',label:'立即实施'}, …]
 *   键取首字符并大写（A~Z）；`=` 可省略（仅键，label 为空）；分隔符 `;`/`；`；重复键取首个。
 *   ★ 选项结构化传参的意义：QQ 端可渲染「选项 → 后果」对照表，且服务端能解析「B」「B#12」答复。
 */
function parseOptions(s) {
  const out = [];
  for (const seg of String(s || '').split(/[;；]/)) {
    const t = seg.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    const key = (i >= 0 ? t.slice(0, i) : t).trim().toUpperCase().slice(0, 1);
    const label = i >= 0 ? t.slice(i + 1).trim() : '';
    if (!/^[A-Z]$/.test(key) || out.some((x) => x.key === key)) continue;
    out.push({ key, label: label.slice(0, 80) });
  }
  return out;
}
const a = parseArgs();
if (!a.prompt) {
  console.error('Usage: node ask.js --prompt "..." [--kind ask] [--timeoutSec 1800] [--json] [--handoff --handoffPrompt "..."]');
  console.error('       node ask.js --prompt "问题" --options "A=方案一;B=方案二" [--recommend A]');
  process.exit(1);
}
const OPTIONS = parseOptions(a.options);
const RECOMMEND = a.recommend ? String(a.recommend).trim().toUpperCase().slice(0, 1) : '';
if (RECOMMEND && !OPTIONS.some((o) => o.key === RECOMMEND)) {
  console.error('[ERR] --recommend ' + a.recommend + ' 不在 --options（' + OPTIONS.map((o) => o.key).join('/') + '）内');
  process.exit(1);
}

let port = a.port;
if (!port) {
  try { port = JSON.parse(fs.readFileSync(path.join(DIR, 'daemon.config.json'), 'utf8')).listenPort || 18765; }
  catch (e) { port = 18765; }
}

const body = JSON.stringify({
  prompt: a.prompt,
  kind: a.kind || (OPTIONS.length ? 'decision' : 'ask'),   // ★ FIX-31：带选项默认 kind=decision（渲染「需你拍板」）
  timeoutMs: (a.timeoutSec > 0 ? a.timeoutSec : 1800) * 1000,
  handoff: !!a.handoff,
  handoffPrompt: a.handoffPrompt || '',
  options: OPTIONS,                                        // ★ FIX-31
  recommend: RECOMMEND,                                    // ★ FIX-31
  session: a.session || '',                                // ★ session-hub v2：显式 session 优先于服务端兜底（/request 仅在缺失时补 WATCH.lastConv）
});

const req = http.request({
  host: '127.0.0.1', port, path: '/request', method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
}, (res) => {
  let d = ''; res.on('data', (c) => d += c);
  res.on('end', () => {
    if (res.statusCode !== 200) { console.error('[ERR] HTTP ' + res.statusCode + ' ' + String(d).slice(0, 200)); process.exit(1); }
    let j = null; try { j = JSON.parse(d); } catch (e) {}
    if (!j || j.id == null) { console.error('[ERR] 响应异常：' + String(d).slice(0, 200)); process.exit(1); }
    // ★ FIX-40：登记时刻（供 wait-answer.ps1 -SinceIso 判定「答复是否早于本次登记」）
    const regTs = new Date().toISOString();
    clearStaleAnswer(j.id);
    if (a.json) { console.log(JSON.stringify(Object.assign({}, j, { ts: regTs }))); return; }
    console.log('已登记 "#' + j.id + '" 并推送到 QQ（' + (OPTIONS.length
      ? '选择题：回 ' + OPTIONS.map((o) => o.key).join('/') + ' 或带编号如 ' + OPTIONS[0].key + '#' + j.id
      : '回复「确认#' + j.id + '」或「取消#' + j.id + '」') + '）');
    console.log('#id=' + j.id);
    console.log('#ts=' + regTs);
    console.log('等待回答: powershell -NoProfile -ExecutionPolicy Bypass -File tools\\qqbot\\wait-answer.ps1 -Id ' + j.id + ' -TimeoutSec 300 -SinceIso ' + regTs);
  });
});
req.setTimeout(5000, () => req.destroy(new Error('timeout')));
req.on('error', (e) => {
  console.error('[ERR] 服务不可用：' + e.message + '（先运行 tools/qqbot/start-service.ps1）');
  process.exit(1);
});
req.write(body); req.end();
