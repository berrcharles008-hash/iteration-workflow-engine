#!/usr/bin/env node
// qqbot-daemon.js —— 常驻监听 + 人机确认闭环（方案 C）
//
// 常驻 WebSocket 监听你的 C2C 消息，按 daemon.config.json 路由到「确认/取消」动作：
//   - 命中「确认#编号 / 取消#编号」→ 精确执行对应待确认项（方案 B：待确认队列）
//   - 命中全局关键词 → 发送回执；若 dryRun=false 且配置了 command，则执行该 shell 命令
//   - 未命中 → 发送 fallbackReply 提示
// 另起本地 HTTP 口（默认 127.0.0.1:18765）接收 /request 注册待确认项，供 genie/其他进程调用。
// 仅响应你自己（OPENID）的消息，其他 openid 一律忽略。所有消息落入 inbox.jsonl（审计）。
//
// 用法：
//   node qqbot-daemon.js --appid <id> --secret <sec> --openid <oid> [--config path] [--port 18765]
//   node qqbot-daemon.js --test          # 仅验证连接，连上 5s 后退出
// 注册待确认项（genie/其他进程调用）：
//   curl -X POST http://127.0.0.1:18765/request -H "Content-Type: application/json" \
//     -d "{\"prompt\":\"即将删除 build 目录\",\"command\":\"rmdir /s /q build\"}"
//
// 说明：
//   - 常驻运行，断线自动重连，access_token 每 90 分钟刷新；Ctrl+C 退出。
//   - dryRun 默认 true：只回执不执行命令，安全可先用。
//   - 若要"自动续上 genie 正在跑的任务"，genie 会话式架构做不到；
//     本 daemon 的"执行"只能是它自己能跑的命令/脚本（即任务逻辑需独立于 genie）。

const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const { URL } = require('url');

let WebSocket;
try { WebSocket = require('ws'); }
catch (e) { console.error('缺少依赖 ws，请先在本目录执行： npm install'); process.exit(1); }

function parseArgs() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--appid') a.appId = argv[++i];
    else if (k === '--secret') a.secret = argv[++i];
    else if (k === '--openid') a.openId = argv[++i];
    else if (k === '--config') a.config = argv[++i];
    else if (k === '--test') a.test = true;
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
  }
  return a;
}
const args = parseArgs();
const TEST = !!args.test;

const DEFAULT_CFG = {
  openId: '', dryRun: true,
  listenPort: 18765, httpKey: '', requestTimeoutMs: 600000,
  actions: {
    confirm: { keywords: ['确认', '继续', '是', 'yes', 'ok', '好', 'go', '同意'], reply: '✅ 已收到确认，开始执行后续任务。', command: '' },
    cancel: { keywords: ['取消', '否', 'no', 'stop', '不要', '中止'], reply: '⛔ 已取消，任务中止。', command: '' }
  },
  fallbackReply: '未识别指令。如需确认某条待办，请回复「确认#编号」或「取消#编号」。'
};
let cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
function loadCfg(p) { if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); return null; }
const loaded = loadCfg(args.config) || loadCfg(path.join(__dirname, 'daemon.config.json'));
if (loaded) cfg = Object.assign(cfg, loaded);

const appId = args.appId || process.env.QQ_BOT_APPID;
const secret = args.secret || process.env.QQ_BOT_SECRET;
const OPENID = args.openId || process.env.QQ_BOT_OPENID || cfg.openId;
if (!appId || !secret) { console.error('缺少 AppID/Secret（--appid/--secret 或 setx）'); process.exit(1); }
if (!OPENID) { console.error('缺少 openid（--openid 或 setx QQ_BOT_OPENID 或 daemon.config.json.openId）'); process.exit(1); }

const INBOX = path.join(__dirname, 'inbox.jsonl');
function logInbox(o) { try { fs.appendFileSync(INBOX, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, o)) + '\n'); } catch (e) {} }

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

let token = null;
async function getToken() {
  const r = await postJson('bots.qq.com', '/app/getAppAccessToken', { appId, clientSecret: secret });
  if (!r.json || !r.json.access_token) throw new Error('获取 token 失败: ' + r.raw);
  token = r.json.access_token; return token;
}
async function send(content) {
  return (await postJson('api.sgroup.qq.com', '/v2/users/' + OPENID + '/messages',
    { content, msg_type: 0 }, { Authorization: 'QQBot ' + token, 'X-UnionAppid': appId })).status;
}

function route(content) {
  const c = (content || '').toLowerCase();
  for (const name of ['confirm', 'cancel']) {
    const act = cfg.actions[name];
    if (act && act.keywords && act.keywords.some(k => c.includes(k.toLowerCase()))) return name;
  }
  return null;
}
function doAction(name) {
  const act = cfg.actions[name];
  if (!act) return;
  send(act.reply).then(st => console.log('[REPLY] ' + name + ' HTTP ' + st)).catch(e => console.error('[REPLY ERR]', e.message));
  if (!cfg.dryRun && act.command) {
    console.log('[EXEC] ' + act.command);
    exec(act.command, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) console.error('[EXEC ERR]', err.message);
      else console.log('[EXEC OUT]', (stdout || '').slice(0, 500));
    });
  } else if (cfg.dryRun && act.command) {
    console.log('[DRYRUN] 配置命令未执行（dryRun=true）：' + act.command);
  }
}
// ---- 方案 B：待确认队列 + 精确 #id ----
const pending = new Map();
let nextId = 1;
function registerRequest(prompt, command, id, timeoutMs) {
  id = id || nextId++;
  while (pending.has(id)) id = nextId++;
  const t = timeoutMs || cfg.requestTimeoutMs || 600000;
  const rec = { id, prompt: prompt || '', command: command || '', createdAt: Date.now(), status: 'pending', timer: null };
  rec.timer = setTimeout(() => {
    const p = pending.get(id);
    if (p && p.status === 'pending') {
      p.status = 'expired';
      send('⏰ #' + id + ' 等待已超时（无回复），已停止等待。回工位可在 IDE 原会话继续；若需代跑，静置后会再发接管邀请（受静默/冷却影响，不承诺时间）。').catch(() => {});
      logInbox({ taskId: id, result: 'expired' });
    }
  }, t);
  pending.set(id, rec);
  const text = '#' + id + ' 待确认：\n' + (prompt || '') + '\n回复「确认#' + id + '」执行，或「取消#' + id + '」中止。';
  send(text).then(st => console.log('[ASK #' + id + '] HTTP ' + st)).catch(e => console.error('[ASK ERR]', e.message));
  return id;
}
function parseReply(content) {
  const m = (content || '').trim().match(/^(确认|取消|confirm|cancel)\s*#\s*(\d+)$/i);
  if (!m) return null;
  const type = (m[1].toLowerCase() === 'cancel' || m[1] === '取消') ? 'cancel' : 'confirm';
  return { type, id: parseInt(m[2], 10) };
}
function doPending(id, type) {
  const p = pending.get(id);
  if (!p) { send('⚠️ 没有待确认的 #' + id + '（可能已完成或超时）。').catch(() => {}); return; }
  if (p.status !== 'pending') { send('#' + id + ' 已处理过（' + p.status + '）。').catch(() => {}); return; }
  clearTimeout(p.timer);
  if (type === 'cancel') {
    p.status = 'cancelled';
    send('⛔ #' + id + ' 已取消，未执行。').catch(() => {});
    logInbox({ taskId: id, result: 'cancelled' });
    return;
  }
  p.status = 'confirmed';
  send('✅ #' + id + ' 已确认，开始执行：' + (p.prompt || '')).catch(() => {});
  if (!cfg.dryRun && p.command) {
    console.log('[EXEC #' + id + '] ' + p.command);
    exec(p.command, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) { console.error('[EXEC ERR #' + id + ']', err.message); send('❌ #' + id + ' 执行失败：' + err.message.slice(0, 200)).catch(() => {}); }
      else { console.log('[EXEC OUT #' + id + ']', (stdout || '').slice(0, 500)); send('✔️ #' + id + ' 执行完成。').catch(() => {}); }
    });
  } else if (cfg.dryRun && p.command) {
    console.log('[DRYRUN #' + id + '] ' + p.command);
    send('🟡 #' + id + ' dryRun=true，未执行命令。').catch(() => {});
  }
  logInbox({ taskId: id, result: 'confirmed', command: p.command });
}
function startHttp() {
  const port = cfg.listenPort || args.port || 18765;
  const key = cfg.httpKey || '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pending: [...pending.values()].filter(p => p.status === 'pending').length })); return;
    }
    if (req.method === 'GET' && u.pathname === '/pending') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...pending.values()].map(p => ({ id: p.id, status: p.status, prompt: p.prompt })))); return;
    }
    if (req.method === 'POST' && u.pathname === '/request') {
      if (key && u.searchParams.get('key') !== key) { res.writeHead(403); res.end('forbidden'); return; }
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        let data; try { data = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
        const id = registerRequest(data.prompt, data.command, data.id, data.timeoutMs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, status: 'pending' }));
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(port, '127.0.0.1', () => console.log('[HTTP] 确认注册口已启动 http://127.0.0.1:' + port + '/request'));
}

function handleMessage(m) {
  const d = m.d || {};
  const oid = d.author && d.author.user_openid;
  if (oid !== OPENID) { console.log('[IGNORE] 非本人 openid: ' + oid); return; }
  const content = (d.content || '').trim();
  logInbox({ openid: oid, content, msgId: d.id });
  console.log('[MSG] ' + content);
  const r = parseReply(content);
  if (r) { doPending(r.id, r.type); return; }
  const name = route(content);
  if (name === 'confirm' && pending.size > 0) {
    send('当前有 ' + pending.size + ' 条待确认，请回复「确认#编号」指定哪一条。').catch(() => {});
    return;
  }
  if (name) doAction(name);
  else send(cfg.fallbackReply).catch(e => console.error('[FB ERR]', e.message));
}

let wsRef = null, hb = null, reconnectTimer = null, tokenTimer = null;
function cleanup() { if (hb) clearInterval(hb); if (wsRef) { try { wsRef.close(); } catch (e) {} } }
function scheduleReconnect(reason) {
  if (TEST) return;
  if (reconnectTimer) return;
  console.log('[RECONNECT in 5s] ' + reason);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
}
function connect() {
  https.get({ hostname: 'api.sgroup.qq.com', path: '/gateway', headers: { Authorization: 'QQBot ' + token } }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => {
      let url; try { url = JSON.parse(d).url; } catch (e) { return scheduleReconnect('gateway parse'); }
      if (!url) return scheduleReconnect('no url');
      const ws = new WebSocket(url, { headers: { Authorization: 'QQBot ' + token, 'X-UnionAppid': appId } });
      wsRef = ws;
      ws.on('message', buf => {
        const mm = JSON.parse(buf.toString());
        if (mm.op === 10) {
          const iv = (mm.d && mm.d.heartbeat_interval ? mm.d.heartbeat_interval : 30000) - 2000;
          hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })); } catch (e) {} }, iv);
          ws.send(JSON.stringify({ op: 2, d: { token: 'QQBot ' + token, intents: 1 << 25 } }));
          console.log('[READY] 监听中，等待你的回复...');
          if (TEST) setTimeout(() => { console.log('[TEST] 连接就绪，退出测试'); cleanup(); process.exit(0); }, 5000);
        } else if (mm.op === 0 && mm.t === 'C2C_MESSAGE_CREATE') {
          handleMessage(mm);
        } else if (mm.op === 7) {
          console.log('[RECONNECT] 收到重连指令'); scheduleReconnect('op7');
        }
      });
      ws.on('error', e => { console.error('[WS ERR]', e.message); scheduleReconnect('ws error'); });
      ws.on('close', () => { if (!TEST) scheduleReconnect('close'); });
    });
  }).on('error', e => { console.error('[GW ERR]', e.message); scheduleReconnect('gw error'); });
}

(async () => {
  await getToken();
  tokenTimer = setInterval(() => { getToken().catch(e => console.error('[TOKEN REFRESH ERR]', e.message)); }, 90 * 60 * 1000);
  startHttp();
  connect();
  process.on('SIGINT', () => { console.log('\n[EXIT]'); cleanup(); process.exit(0); });
})().catch(e => { console.error('❌', e.message); process.exit(1); });
