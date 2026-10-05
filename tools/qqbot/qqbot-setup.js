#!/usr/bin/env node
// qqbot-setup.js —— QQ 机器人接入向导（一次跑通：配置凭据 → 获取 openid → 发送测试）
//
// 前置：
//   1) 已安装 Node.js（建议 16+）
//   2) 在本目录执行： npm install   （会安装 ws 依赖）
//   3) 在 QQ 开放平台「开发」→ 已创建机器人，拿到 AppID 和 AppSecret
//   4) 在平台「扫码聊天」里开启，让手机 QQ 能给该机器人发私信
//
// 用法一（交互）： node qqbot-setup.js
//   按提示输入 AppID / AppSecret（若已 setx 环境变量则自动读取，无需再输）
//   首次接入会启动监听，用手机 QQ 给机器人发一条消息自动拿到 openid
//   然后输入任意消息，直接发到你的 QQ，验证链路打通
//
// 用法二（参数，适合自动化/代跑）：
//   node qqbot-setup.js --appid <id> --secret <secret> --openid <oid> --message "内容"
//   参数缺哪项就回退到环境变量，再没有才交互询问
//
// 最后打印可 setx 持久化的命令，方便后续用 notify.qqbot.ps1 推送。
// 说明：node 发送 JSON 默认 UTF-8，无 PowerShell 版的中文乱码问题。

const https = require('https');
const readline = require('readline');

let WebSocket;
try { WebSocket = require('ws'); }
catch (e) {
  console.error('缺少依赖 ws，请先在本目录执行： npm install');
  process.exit(1);
}

function parseArgs() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--appid') a.appId = argv[++i];
    else if (k === '--secret') a.secret = argv[++i];
    else if (k === '--openid') a.openId = argv[++i];
    else if (k === '--message') a.message = argv[++i];
  }
  return a;
}
const args = parseArgs();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

function postJson(host, p, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: host, path: p, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, json, raw: d });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getToken(appId, secret) {
  const r = await postJson('bots.qq.com', '/app/getAppAccessToken', { appId, clientSecret: secret });
  if (!r.json || !r.json.access_token) throw new Error('获取 access_token 失败: ' + r.raw);
  return r.json.access_token;
}

function listenOpenId(appId, token) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.sgroup.qq.com', path: '/gateway',
      headers: { Authorization: 'QQBot ' + token }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let url;
        try { url = JSON.parse(d).url; } catch (e) { return reject(new Error('gateway 解析失败: ' + d)); }
        if (!url) return reject(new Error('gateway 未返回 url'));
        const ws = new WebSocket(url, { headers: { Authorization: 'QQBot ' + token, 'X-UnionAppid': appId } });
        let hb = null;
        ws.on('message', buf => {
          const m = JSON.parse(buf.toString());
          if (m.op === 10) {
            const iv = (m.d && m.d.heartbeat_interval ? m.d.heartbeat_interval : 30000) - 2000;
            hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })); } catch (e) {} }, iv);
            ws.send(JSON.stringify({ op: 2, d: { token: 'QQBot ' + token, intents: 1 << 25 } }));
            console.log('[READY] 请用手机 QQ 给机器人发一条消息...');
          } else if (m.op === 0 && m.t === 'C2C_MESSAGE_CREATE') {
            const oid = m.d && m.d.author && m.d.author.user_openid;
            if (hb) clearInterval(hb);
            try { ws.close(); } catch (e) {}
            if (oid) resolve(oid);
            else reject(new Error('事件未包含 openid'));
          } else if (m.op === 7) {
            if (hb) clearInterval(hb);
            reject(new Error('收到重连指令，请重跑'));
          }
        });
        ws.on('error', e => reject(new Error('WS error: ' + e.message)));
        setTimeout(() => { if (hb) clearInterval(hb); reject(new Error('60s 超时：未收到消息，请确认已开启扫码聊天并已发消息')); }, 60000);
      });
    }).on('error', e => reject(new Error('gateway 请求失败: ' + e.message)));
  });
}

async function sendMessage(appId, token, openId, content) {
  const r = await postJson('api.sgroup.qq.com', '/v2/users/' + openId + '/messages',
    { content, msg_type: 0 },
    { Authorization: 'QQBot ' + token, 'X-UnionAppid': appId });
  return r.status;
}

(async () => {
  let appId = args.appId || process.env.QQ_BOT_APPID;
  let secret = args.secret || process.env.QQ_BOT_SECRET;
  let openId = args.openId || process.env.QQ_BOT_OPENID;

  console.log('=== QQ 机器人接入向导 ===');
  if (!appId) appId = (await ask('AppID: ')).trim();
  if (!secret) secret = (await ask('AppSecret: ')).trim();
  if (!appId || !secret) throw new Error('AppID / AppSecret 不能为空');

  const token = await getToken(appId, secret);
  console.log('[OK] access_token 获取成功');

  if (!openId) {
    console.log('[INFO] 未检测到 openid，启动监听获取（首次接入）...');
    openId = await listenOpenId(appId, token);
    console.log('[OPENID] ' + openId);
  } else {
    console.log('[INFO] 使用已有 openid: ' + openId);
  }

  const msg = args.message ? args.message : (await ask('输入要发送的测试消息（回车发送）: '));
  const content = (msg && msg.trim()) ? msg.trim() : '测试通知：QQ 推送已接通';
  const st = await sendMessage(appId, token, openId, content);
  console.log('[SEND] HTTP ' + st);
  if (st === 200) {
    console.log('\n✅ 发送成功，链路已打通！如需后续用 notify.qqbot.ps1 推送，可执行以下命令持久化环境变量：');
    console.log('  setx QQ_BOT_APPID   "' + appId + '"');
    console.log('  setx QQ_BOT_SECRET  "' + secret + '"');
    console.log('  setx QQ_BOT_OPENID  "' + openId + '"');
  } else {
    console.log('[WARN] 发送返回非 200，若提示被拦截，请先与机器人互动保活再试。');
  }
  rl.close();
})().catch(e => {
  console.error('❌ 失败: ' + e.message);
  rl.close();
  process.exit(1);
});
