#!/usr/bin/env node
// request-confirm.js —— 供 genie / 其他进程调用，向本地 qqbot 服务注册一条待确认项，并**核验 QQ 是否真的送达**。
// 调用后 daemon 会发 QQ 询问用户，用户回「确认#编号」后由 daemon 在本机执行 command。
//
// 用法：
//   node request-confirm.js --prompt "..." --command "..." \
//        [--kind gate] [--timeoutMs 600000] [--verifySec 6] [--no-verify] [--port 18765] [--key <httpKey>]
//
// 退出码：0=已登记且 QQ 已送达 ｜ 3=已登记但未能确认送达（QQ 可能发不出 ⇒ 用 hub 兜底）
//         1=服务返回非 200 ｜ 2=连不上服务（**未登记任何编号**，先跑 start-service.ps1）
//
// 说明：
//   - command 必须命中 daemon.config.json → commandAllowlist 前缀；否则服务会丢弃并在 service.log 记
//     `[REQUEST] 请求体命令未通过白名单，已忽略：…`。
//   - 自动 kind：--command 命中 tools/gate/open-bypass.js ⇒ kind=gate（hub 页面标为「开闸/门禁请求」并可本页确认；
//     kind=gate 不会被当作「待接管」项，不改变会话静置邀请口径）。可用 --kind 显式覆盖。
//   - 送达核验 = 只看**登记后新增**的日志行：`[ASK #id] HTTP …`（已发）／`[ASK ERR] …`（发送失败，服务侧无编号）。
//   - QQ 故障兜底：打开 http://127.0.0.1:18766/ → 待确认明细 → 点「确认」（走 /simulate-message，与 QQ 回复同一处理链）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const LOG = path.join(__dirname, 'service.log');

function parseArgs() {
  const a = { verifySec: 6 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--command') a.command = argv[++i];
    else if (k === '--kind') a.kind = argv[++i];
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--key') a.key = argv[++i];
    else if (k === '--timeoutMs') a.timeoutMs = parseInt(argv[++i], 10);
    else if (k === '--verifySec') a.verifySec = parseInt(argv[++i], 10);
    else if (k === '--no-verify') a.verifySec = 0;
  }
  return a;
}
function logSize() { try { return fs.statSync(LOG).size; } catch (e) { return 0; } }
/** 读 [from, EOF)；文件被截断（轮转）时退化为整读 */
function readFrom(from) {
  try {
    const size = fs.statSync(LOG).size;
    const start = size >= from ? from : 0;
    const len = size - start;
    if (len <= 0) return '';
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) { return ''; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async function main() {
  const args = parseArgs();
  if (!args.prompt && !args.command) {
    console.error('Usage: node request-confirm.js --prompt "..." --command "..." [--kind gate] [--timeoutMs 600000] [--verifySec 6]');
    process.exit(2);
  }
  const isBypass = /tools[\\/]gate[\\/]open-bypass\.js/i.test(String(args.command || ''));
  const kind = (args.kind != null) ? String(args.kind) : (isBypass ? 'gate' : '');
  const port = args.port || 18765;
  const q = new URL('http://localhost');
  if (args.key) q.searchParams.set('key', args.key);
  const body = JSON.stringify({ prompt: args.prompt || '', command: args.command || '', timeoutMs: args.timeoutMs, kind });
  const offsetBefore = logSize();

  const res = await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/request' + (q.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve({ code: r.statusCode, raw: d })); });
    req.on('error', (e) => resolve({ code: 0, err: e.message }));
    req.write(body); req.end();
  });

  if (res.code === 0) {
    console.error('连接 daemon 失败：' + res.err);
    console.error('→ 服务未运行：先跑 tools/qqbot/start-service.ps1（本次未登记任何编号）');
    process.exit(2);
  }
  process.stdout.write(res.raw + (res.raw.endsWith('\n') ? '' : '\n'));
  if (res.code !== 200) process.exit(1);

  let id = 0;
  try { id = Number(JSON.parse(res.raw).id) || 0; } catch (e) { /* 保留 0 */ }
  console.log('REGISTERED id=' + id + ' kind=' + (kind || '""'));
  if (!id || !args.verifySec) process.exit(0);

  // ★ 送达核验：只看登记后新增的日志行（[ASK ERR] 服务侧不带编号，必须按时间窗界定）
  const deadline = Date.now() + args.verifySec * 1000;
  let verdict = '';
  while (Date.now() < deadline && !verdict) {
    const frag = readFrom(offsetBefore);
    if (new RegExp('\\[ASK #' + id + '\\]').test(frag)) verdict = 'ok';
    else if (/\[ASK ERR\]/.test(frag)) verdict = 'err';
    else await sleep(400);
  }
  if (verdict === 'ok') {
    console.log('DELIVERY ok id=' + id + ' (QQ ask sent)');
    process.exit(0);
  }
  if (verdict === 'err') console.log('DELIVERY FAILED id=' + id + ' ([ASK ERR] after register -> QQ push failed)');
  else console.log('DELIVERY UNKNOWN id=' + id + ' (no [ASK #' + id + '] within ' + args.verifySec + 's -> QQ may not have been pushed)');
  console.log('FALLBACK: open http://127.0.0.1:18766/ -> 待确认明细 -> 点「确认」/「取消」（与 QQ 回复同一处理链）');
  process.exit(3);
})();
