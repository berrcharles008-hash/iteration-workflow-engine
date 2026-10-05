// qqbot-listen-once.js —— 一次性监听 C2C 事件，打印你的 openid 后退出
//
// 前置：
//   1) 已 setx QQ_BOT_APPID / QQ_BOT_SECRET
//   2) 运行目录装 ws： cd tools/qqbot && npm i ws --no-save
//   3) 在 QQ 开放平台点「扫码聊天」，让手机 QQ 能给该机器人发私信
//
// 用法： node qqbot-listen-once.js
//   然后手机 QQ 给机器人发一条消息，控制台打印 [OPENID] xxxx 后自动退出。
//   复制该值执行： setx QQ_BOT_OPENID "xxxx"

const https = require('https');
const WebSocket = require('ws');

const appId = process.env.QQ_BOT_APPID;
const secret = process.env.QQ_BOT_SECRET;
if (!appId || !secret) {
    console.error('缺少环境变量 QQ_BOT_APPID / QQ_BOT_SECRET，请先 setx 配置。');
    process.exit(1);
}

// 1) 获取 access_token
function getToken(cb) {
    const body = JSON.stringify({ appId: appId, clientSecret: secret });
    const req = https.request({
        hostname: 'bots.qq.com',
        path: '/app/getAppAccessToken',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
            let json;
            try { json = JSON.parse(d); } catch (e) { console.error('token 解析失败:', d); process.exit(1); }
            if (!json.access_token) { console.error('access_token 为空:', d); process.exit(1); }
            cb(json.access_token);
        });
    });
    req.on('error', e => { console.error('token 请求失败:', e.message); process.exit(1); });
    req.write(body);
    req.end();
}

getToken(token => {
    const auth = 'QQBot ' + token;

    // 2) 获取 WebSocket 网关地址
    https.get({
        hostname: 'api.sgroup.qq.com',
        path: '/gateway',
        headers: { Authorization: auth }
    }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
            let json;
            try { json = JSON.parse(d); } catch (e) { console.error('gateway 解析失败:', d); process.exit(1); }
            if (!json.url) { console.error('gateway 未返回 url:', d); process.exit(1); }
            connectWs(json.url, auth);
        });
    }).on('error', e => { console.error('gateway 请求失败:', e.message); process.exit(1); });
});

function connectWs(url, auth) {
    const ws = new WebSocket(url, { headers: { Authorization: auth, 'X-UnionAppid': appId } });
    let hb = null;

    ws.on('message', buf => {
        const m = JSON.parse(buf.toString());
        if (m.op === 10) {
            // Hello：启动心跳（interval 毫秒）
            const interval = (m.d && m.d.heartbeat_interval ? m.d.heartbeat_interval : 30000) - 2000;
            hb = setInterval(() => {
                try { ws.send(JSON.stringify({ op: 1, d: null })); } catch (e) {}
            }, interval);
            // Identify：订阅 群聊+单聊 事件（1 << 25）
            ws.send(JSON.stringify({ op: 2, d: { token: auth, intents: 1 << 25 } }));
            console.log('[READY] 已连接，请用手机 QQ 给机器人发一条消息...');
        } else if (m.op === 0 && (m.t === 'C2C_MESSAGE_CREATE' || m.t === 'AT_MESSAGE_CREATE')) {
            const d = m.d || {};
            const openid = d.author && d.author.user_openid;
            const guildId = d.guild_id;
            const channelId = d.channel_id;
            if (openid) console.log('[OPENID] ' + openid);
            else console.log('[OPENID] (无)');
            if (guildId) console.log('[GUILD] ' + guildId);
            if (channelId) console.log('[CHANNEL] ' + channelId);
            console.log('复制： setx QQ_BOT_OPENID "' + (openid || '') + '"');
            if (guildId) console.log('私聊 dms 用： setx QQ_BOT_GUILD_ID "' + guildId + '"');
            if (channelId) console.log('频道发送用： setx QQ_BOT_CHANNEL_ID "' + channelId + '"');
            if (hb) clearInterval(hb);
            try { ws.close(); } catch (e) {}
            process.exit(0);
        } else if (m.op === 7) {
            console.log('[RECONNECT] 收到重连指令，请重跑脚本。');
            if (hb) clearInterval(hb);
            process.exit(0);
        }
    });

    ws.on('error', e => { console.error('WS error:', e.message); process.exit(1); });
    ws.on('close', () => { if (hb) clearInterval(hb); });

    // 60s 超时
    setTimeout(() => {
        console.error('[TIMEOUT] 60s 内未收到消息，请确认：① 已 setx 凭据 ② 已在平台开启扫码聊天 ③ 手机 QQ 已给机器人发消息');
        if (hb) clearInterval(hb);
        process.exit(1);
    }, 60000);
}
