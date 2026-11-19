#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════════════
// probe-takeover.js —— 接管会话面板前置探针（2026-10-04）
// 目的：采集 Jobs API 原始事件样本（transcript / stream 粒度 / reply 行为），
//       为 hub 两栏接管面板的 UI 渲染提供实证依据（勿凭猜测渲染）。
// 用法: node probe-takeover.js [port]   （默认 19000；serve 须已在跑）
// 产出: probe-out/*.json（0-编号命名，按阶段）
// ══════════════════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.argv[2] || 19000);
const OUT_DIR = path.join(__dirname, 'probe-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const log = (m) => process.stdout.write('[' + new Date().toISOString().slice(11, 19) + '] ' + m + '\n');

function readPassword() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codebuddy', 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    return String((j && j.gateway && j.gateway.password) || '');
  } catch (e) { return ''; }
}
const PW = readPassword();

// 认证双头（FIX-34b 实证）：Bearer + x-codebuddy-request: 1
function api(method, p, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { 'Authorization': 'Bearer ' + PW, 'x-codebuddy-request': '1' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method, headers: headers, timeout: timeoutMs || 10000 }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve({ code: r.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ code: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ code: 0, body: 'ERR timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// SSE 抓取 durationMs 毫秒（原始 chunk 带时序落盘）
function grabStream(jobId, durationMs) {
  return new Promise((resolve) => {
    const events = [];
    let buf = '';
    let settled = false;
    const finish = (code) => { if (settled) return; settled = true; resolve({ code: code, events: events, raw: buf }); };
    const req = http.get({
      host: '127.0.0.1', port: PORT, path: '/api/v1/jobs/' + jobId + '/stream',
      headers: { 'Authorization': 'Bearer ' + PW, 'x-codebuddy-request': '1', 'Accept': 'text/event-stream' },
    }, (r) => {
      r.setEncoding('utf8');
      r.on('data', (c) => { buf += c; events.push({ t: Date.now(), bytes: c.length, head: c.slice(0, 160) }); });
      r.on('end', () => finish(r.statusCode));
    });
    req.on('error', (e) => finish('ERR ' + e.message));
    setTimeout(() => { try { req.destroy(); } catch (e) {} finish('timeout-ok'); }, durationMs);
  });
}

const save = (name, obj) => {
  try { fs.writeFileSync(path.join(OUT_DIR, name + '.json'), JSON.stringify(obj, null, 1)); log('saved ' + name); }
  catch (e) { log('save-fail ' + name + ': ' + e.message); }
};

async function main() {
  log('probe start, port=' + PORT + ' pw=' + (PW ? 'yes' : 'NO'));
  // 0) 探活 + 存量 jobs 列表
  const root = await api('GET', '/');
  log('GET / -> ' + root.code);
  const list0 = await api('GET', '/api/v1/jobs');
  log('GET /api/v1/jobs -> ' + list0.code);
  save('0-jobs-before', { code: list0.code, body: list0.body.slice(0, 40000) });

  // 1) 建测试 job（POST 即执行）
  const prompt = '请执行 PowerShell 命令 ping 127.0.0.1 -n 8，结束后只回复两个字：完成。不要做任何其他事情。';
  const create = await api('POST', '/api/v1/jobs', { prompt: prompt, name: 'takeover-probe', cwd: process.cwd() }, 30000);
  log('POST /api/v1/jobs -> ' + create.code);
  save('1-job-created', { code: create.code, body: create.body.slice(0, 8000) });
  let jobId = '';
  try {
    const j = JSON.parse(create.body);
    const d = j.data || j;
    jobId = d.id || (d.job && d.job.id) || '';
  } catch (e) {}
  if (!jobId) { log('FAIL: no job id, abort'); return; }
  log('jobId = ' + jobId);

  // 2) 立即连 stream 抓 20s（working 态事件样本）
  const streamP = grabStream(jobId, 20000);

  // 3) 第 3 秒对 working 态 job POST reply（行为 + 响应形状实证）
  setTimeout(() => {
    api('POST', '/api/v1/jobs/' + jobId + '/reply', { text: '如果 ping 尚未结束可以跳过，直接回复完成' }, 15000)
      .then((rep) => {
        save('2-reply-working', { code: rep.code, body: rep.body.slice(0, 4000) });
        log('reply(working) -> ' + rep.code);
      });
  }, 3000);

  // 4) 轮询 state 至终态（cap ~120s）
  let final = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await api('GET', '/api/v1/jobs/' + jobId);
    let jj = null; try { jj = JSON.parse(st.body); } catch (e) {}
    const d = (jj && (jj.data || jj)) || {};
    const state = String(d.state || '');
    if (i % 3 === 0 || (state && state !== 'working')) log('poll ' + i + ' state=' + (state || '?') + ' code=' + st.code);
    if (state && state !== 'working' && state !== 'queued' && state !== 'pending') { final = { code: st.code, body: st.body }; break; }
  }
  save('3-job-final', final || { note: 'poll-timeout-120s' });

  // 5) transcript 全量
  const tr = await api('GET', '/api/v1/jobs/' + jobId + '/transcript', null, 15000);
  save('4-transcript', { code: tr.code, body: tr.body });

  // 6) 等 stream 抓取窗结束，落盘样本
  const stream = await streamP;
  save('5-stream-sample', { code: String(stream.code), chunkCount: stream.events.length, raw: stream.raw.slice(0, 120000) });

  // 7) DELETE 清理测试 job
  const del = await api('DELETE', '/api/v1/jobs/' + jobId);
  save('6-deleted', { code: del.code, body: del.body.slice(0, 2000) });
  log('DELETE -> ' + del.code);
  log('DONE');
}
main().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
