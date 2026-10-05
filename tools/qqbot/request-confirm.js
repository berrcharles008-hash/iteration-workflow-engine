#!/usr/bin/env node
// request-confirm.js —— 供 genie / 其他进程调用，向本地 qqbot-daemon 注册一条待确认项。
// 调用后 daemon 会发 QQ 询问用户，用户回「确认#编号」后由 daemon 在本机执行 command。
//
// 用法：
//   node request-confirm.js --prompt "即将删除 build 目录" --command "rmdir /s /q build"
//   node request-confirm.js --prompt "..." --command "..." --port 18765 --key <httpKey> --timeoutMs 600000
//
// 返回 JSON：{ "id": 1, "status": "pending" }
// 退出码：0=成功注册，1=daemon 返回非 200，2=连不上 daemon。
const http = require('http');
const { URL } = require('url');

function parseArgs() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--command') a.command = argv[++i];
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--key') a.key = argv[++i];
    else if (k === '--timeoutMs') a.timeoutMs = parseInt(argv[++i], 10);
  }
  return a;
}
const args = parseArgs();
const port = args.port || 18765;
const q = new URL('http://localhost');
if (args.key) q.searchParams.set('key', args.key);
const body = JSON.stringify({ prompt: args.prompt || '', command: args.command || '', timeoutMs: args.timeoutMs });

const req = http.request({
  hostname: '127.0.0.1', port, path: '/request' + (q.search || ''), method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
}, res => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => { process.stdout.write(d + '\n'); process.exit(res.statusCode === 200 ? 0 : 1); });
});
req.on('error', e => { console.error('连接 daemon 失败：' + e.message); process.exit(2); });
req.write(body); req.end();
