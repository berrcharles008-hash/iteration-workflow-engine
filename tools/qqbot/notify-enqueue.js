#!/usr/bin/env node
// notify-enqueue.js —— 把一条通知优先送入「合并服务」的待确认队列（带 #id，可在 QQ 回复 #N），
// 服务不可用时自动回退为直接发送（完全兼容原 notify.qqbot.js 行为，不丢通知）。
//
// 用法（与 notify.qqbot.js 参数兼容，取最后一个参数为 payload）：
//   node notify-enqueue.js --json '{"title":"…","rows":[["k","v"]],"prompt":"人类可读请求","kind":"gate"}'
//   node notify-enqueue.js '{"prompt":"…"}'          # 直接给 payload 亦可
//
// 设计要点：
//   - 入队 ⇒ 服务端发「#N 待确认：<prompt>…」，你可回「确认#N / 取消#N」；
//   - kind='gate' 时，若 daemon.config.json 配了 gateCommand 且 dryRun=false，确认后会执行该命令；
//     默认 gateCommand 为空 + dryRun=true ⇒ 只回执 + 落 inbox.jsonl 审计（安全默认）。
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const raw = process.argv[process.argv.length - 1] || '';
let payload = null;
try { payload = JSON.parse(raw); } catch (e) { payload = null; }

// ★ FIX-19（2026-09-18）：结构化 rows **必须渲染进 prompt** —— 原实现只把 payload.prompt（单行）
//   发给服务，服务端 `registerRequest` 用它拼 `#N 待确认：…` ⇒ title/rows/next 被整体丢弃，
//   QQ 上只剩一句「门禁拦截：…」，完全看不出当时在处理什么。此处复用 notify.qqbot.js 的渲染器
//   （版式与直发通道一致），渲染失败再回退旧逻辑。
let prompt = '';
try {
  if (payload && (payload.rows || payload.next || payload.title)) {
    prompt = require('./notify.qqbot.js').renderStructured(payload) || '';
  }
} catch (e) { prompt = ''; }
if (!prompt) prompt = (payload && (payload.prompt || payload.status)) || raw || 'CodeBuddy 通知';
const kind = (payload && payload.kind) || 'gate';
const command = (payload && payload.command) || '';
const timeoutMs = (payload && payload.timeoutMs) || 600000;

function fallback(reason) {
  console.log('[FALLBACK] ' + reason + ' -> direct send');
  const notify = path.join(__dirname, 'notify.qqbot.js');
  const child = spawn(process.execPath, [notify, '--json', raw], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

const body = JSON.stringify({ prompt, command, kind, timeoutMs });
const req = http.request({
  host: '127.0.0.1', port: 18765, path: '/request', method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
}, (res) => {
  let d = ''; res.on('data', (c) => d += c);
  res.on('end', () => {
    if (res.statusCode === 200) { console.log('[QUEUED] HTTP ' + res.statusCode + ' ' + d.slice(0, 200)); process.exit(0); }
    fallback('HTTP ' + res.statusCode);
  });
});
req.setTimeout(4000, () => req.destroy(new Error('timeout')));   // 服务端偶发同步扫描会短暂阻塞，留足余量
req.on('error', (e) => fallback(e.message));
req.write(body); req.end();
