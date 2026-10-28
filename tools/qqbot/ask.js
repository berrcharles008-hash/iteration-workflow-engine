#!/usr/bin/env node
// ask.js —— 「等待式确认」登记器：把一条待确认事项推送到 QQ，并打印可直接用于等待的 #id
//
// 用法（agent / 脚本调用）：
//   node tools/qqbot/ask.js --prompt "是否按此预览批量落盘？"
//   node tools/qqbot/ask.js --prompt "…" --kind ask --timeoutSec 1800 --json
//   node tools/qqbot/ask.js --prompt "…" --handoff --handoffPrompt "剩余工作：…"
//   ★ 选择题（FIX-31）：--options "A=立即实施;B=先实证;C=仅记录" [--recommend B]
//     ⇒ QQ 端渲染「A/B/C → 后果」对照表；用户回「B」或带编号「B#12」即可（不必回「确认#12」）
//   ★ 方式2（2026-10-06）：--docPath "<迭代ID>/<文档>.md"（相对 docs/iterations，也可写 --doc-path）
//     ⇒ QQ 消息尾部自动附「拍板依据」链接（手机可直接打开 hub 只读视图；缺省附列表页）
//   ★ 等待（2026-10-19 TOOL-QQWAIT 上线；★ 2026-10-26 改**默认等待**）：
//     登记后**同一进程内**轮询答案文件，命中即输出答案 JSON
//        · 构成授权（confirm / choice / text）⇒ exit 0
//        · 有答复但不构成授权（defer-ide · cancel · timeout）⇒ 输出 JSON + exit 4（★ TOOL-ANSWERKIND 2026-10-20）
//          （★ 不用 3：`request-confirm.js` 已占用 3 = 已登记但送达未确认，同家族双义；评审 R3 提出）
//        · 片满无答复 ⇒ 输出 wait-timeout + exit 2（可重入续等）
//     秒数：缺省 300（1 片）；`--wait 600` = 600；与 waiting-protocol §3「A = ≤5 分钟/片 × ≤6 片」口径一致
//   ★★ `--no-wait` 已**删除**（2026-10-28 TOOL-QQWAIT-2 · 第 6 例空转后）：
//     恒 exit 1 且**不登记**（在任何 HTTP 请求之前返回）。三条合法出路：
//       ① 默认等待（本脚本行为，300s/片、可重入）② 登记后立刻派 waiter 成员 ③ `--handoff` 交模式 B。
//     动因（两次加固都被同一形状绕过）：10-26 第 4 例 = 漏带参数；第 5 例 = `--json --no-wait`
//       顺手绕过；第 6 例 = `$env:QQ_ASK_AUTOMATION="1"; ask.js … --no-wait` —— **豁免的声明方
//       与被约束方是同一个模型** ⇒ 凡由调用方自己声明的豁免，等于没有豁免。
//     ⇒ 不再保留任何「关掉等待」的开关；不可逆动作的知会改由 gate-check 直接调
//       `notify.qqbot.js`（单向通知，不产生待确认项、不落答案文件，因此也没有"无人消费"问题）。
//   ★ 审计台账（2026-10-28 TOOL-QQWAIT-2）：登记 / 消费 / 片满 / 放弃 四类事件写入
//     `<IDE>/temp/qq-ask-ledger.json`，供 `team-wait-guard --stop-guard` 判「登记后有没有消费者」。
//     该台账**不参与**答案新鲜度判据（不写 consumedAt、不碰 mtime），只做 Stop 侧判据与审计。
//   ★ 消费证据（2026-10-28 TOOL-QQWAIT-2）：命中答复后写 `<answerDir>/<id>.done`（审计标记，
//     只写不读、不参与任何等待语义）。它证明「有进程读过这份答复」，**不等于**「会话能被唤醒」。
//
// 输出：人类可读两行 + `#id=<n>`（供脚本解析）；加 --json 则只输出 {"id":n,"status":"pending"}
// 配套：`tools/qqbot/wait-answer.ps1 -Id <n> -TimeoutSec 300`（轮询答案文件，拿到即返回 JSON）
// 典型流程（agent 不停机等待）：
//   ask.js 登记（默认已等待）→ 你在 QQ 回「确认#N」→ 服务写答案文件 → 同一进程返回 → agent 继续
// ★ **登记 ≠ 等待**（waiting-protocol.md §2 铁律）：只登记不等待 = 本次登记无效。
//   三种合法等待形态只取其一：① 本脚本默认等待或登记后立即挂 wait-answer.ps1（模式 A）
//   ② 登记后立即派 waiter 成员（模式 D）③ 登记时带 `--handoff`（模式 B）。
//   只登记然后结束回合 ⇒ 答复必然无人消费（IDE 会话唯一唤醒通道 = 成员 send_message）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
// ★ FIX-40（2026-09-29）：登记时刻 + 同号残留清理。
//   项目根 = tools/qqbot 上两级；答案目录须与 qqbot-service.js 的 cfg.answerDir 默认值一致。
// ★ TOOL-QQWAIT（2026-10-19）：答案目录可被 `QQ_ANSWER_DIR` 覆盖 —— 仅用于测试隔离
//   （测试绝不能让 clearStaleAnswer 删到生产答案目录里的真实答复）；生产环境不传该变量。
function answerDir() {
  const ov = process.env.QQ_ANSWER_DIR;
  return (ov && String(ov).trim()) ? path.resolve(String(ov).trim()) : ANSWER_DIR;
}
const PROJ_ROOT = path.resolve(DIR, '..', '..');
const ANSWER_DIR = path.join(PROJ_ROOT, '.codebuddy', 'temp', 'qq-answers');
function clearStaleAnswer(id) {
  try {
    const f = path.join(answerDir(), String(id) + '.json');
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.error('[WARN] 已清理同号历史答案文件 #' + id + '.json（防撞号误读）');
    }
  } catch (e) { console.error('[WARN] 清理同号答案文件失败：' + e.message); }
  // ★ TOOL-QQWAIT-2（2026-10-28）：同号 `.done` 必须一并清理。
  //   失效形态（勿删本段）：id 会在服务重启后从 1 复用，上轮的 `3.done` 若残留 ⇒ Stop 侧
  //   「本 id 已有消费者」判据恒真 ⇒ 守卫静默 fail-open，且日志里看不出任何异常。
  try {
    const d = path.join(answerDir(), String(id) + '.done');
    if (fs.existsSync(d)) fs.unlinkSync(d);
  } catch (e) { /* 清理失败不致命（.done 仅供审计与 Stop 判据，非主通道） */ }
}
/**
 * ★ TOOL-QQWAIT-2（2026-10-28）：Ask 台账（供 Stop 侧判断「登记后有没有消费者」）。
 *   为什么由 ask.js 自己写，而不是让 hook 解析命令行：
 *     ① hook 在 PreToolUse 阶段**拿不到** `#id`（id 由服务端分配、只出现在工具返回里）；
 *     ② 按命令文本匹配 `/ask\.js/` 会把 `Get-Content …ask.js` / `Select-String …` 全记成登记
 *        （误拦概率≈1）；③ 脚本被包装（`$s='ask'; node …/$s.js`）时又完全不命中。
 *   ⇒ 唯一同时解决三者的做法 = 登记方自己落结构化记录。
 *   目录固定为项目 temp（**不随 QQ_ANSWER_DIR 漂移**——那是测试隔离用的答案目录）；
 *   测试需要隔离时用 QQ_ASK_LEDGER 显式指定。
 */
function ledgerFile() {
  const ov = process.env.QQ_ASK_LEDGER;
  return (ov && String(ov).trim())
    ? path.resolve(String(ov).trim())
    : path.join(PROJ_ROOT, '.codebuddy', 'temp', 'qq-ask-ledger.json');
}
function convId() {
  const v = process.env.CODEBUDDY_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  return String(v).trim().toLowerCase();
}
const LEDGER_MAX = 400;
function ledgerAppend(ev) {
  try {
    const f = ledgerFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let doc = { events: [] };
    try {
      const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.events)) doc = j;
    } catch (e) { /* 不存在 / 半写 / 损坏 ⇒ 重建（台账损坏只会少一条判据，不阻断登记） */ }
    doc.events.push(Object.assign({ id: null, t: Date.now(), ts: new Date().toISOString() }, ev));
    if (doc.events.length > LEDGER_MAX) doc.events = doc.events.slice(-LEDGER_MAX);
    fs.writeFileSync(f, JSON.stringify(doc), 'utf8');
  } catch (e) { /* fail-open：台账写失败不得影响登记/等待主链 */ }
}
/** 本 id 已出现过几次「片满」——用于判定协议是否已用尽（§3：≤6 片） */
function sliceCount(id) {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8').replace(/^\uFEFF/, ''));
    return (j.events || []).filter((x) => x && x.id === id && x.event === 'wait-end').length;
  } catch (e) { return 0; }
}
/** 消费证据（审计标记）：只写不读、不参与等待语义、不写 consumedAt */
function writeDone(id, extra) {
  try {
    const f = path.join(answerDir(), String(id) + '.done');
    fs.writeFileSync(f, JSON.stringify(Object.assign({ id: id, by: 'ask-wait', ts: new Date().toISOString() }, extra || {})), 'utf8');
  } catch (e) { /* 与主链无关 */ }
}
/**
 * ★ TOOL-QQWAIT（2026-10-19）：同进程等待答复（模式 A 的首选实现）。
 *   判据 = 答案文件存在 + JSON `ts` >= 登记时刻 regTs（等价 `wait-answer.ps1 -SinceIso`）+ `answer` 非空。
 *   半写文件（JSON 解析失败）按"未到"处理、下一 tick 重读 —— 不会误判成超时。
 *   返回 Promise<{ok:true,j}|{ok:false}>；超时不抛错，由调用方按 exit 2 处理。
 */
function waitAnswer(id, sinceIso, sec) {
  const file = path.join(answerDir(), String(id) + '.json');
  const deadline = Date.now() + sec * 1000;
  return new Promise((resolve) => {
    const tick = () => {
      try {
        if (fs.existsSync(file)) {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (j && j.answer && String(j.ts || '') >= sinceIso) { resolve({ ok: true, j: j }); return; }
        }
      } catch (e) { /* 半写文件 ⇒ 下一 tick 再读 */ }
      if (Date.now() >= deadline) { resolve({ ok: false }); return; }
      setTimeout(tick, 1000);
    };
    tick();
  });
}
/**
 * ★ TOOL-ANSWERKIND（2026-10-20）：答复是否构成「授权」。
 *   事故：2026-10-20 用户回选项 D「回 IDE 原会话拍板（QQ 侧作废本项）」，服务端正确落盘 answer='ide'，
 *   下游 Agent 读成「用户在 IDE 已确认通过」，连做两次 phase-advance 并自撰 quote（2/2 全中）。
 *   口径：服务端已在答案 JSON 里写 answerKind / allowed / hint（见 qqbot-service.js ANSWER_SEMANTICS）；
 *   本函数只在**旧答案文件**（无 allowed 字段）时做兼容回退 —— 旧值 'ide' 一律视为无授权。
 *   退出码：0=授权答复 ｜ 2=本片等待用尽 ｜ 4=已收到答复但**不构成授权**（reject / no-decision / no-answer）。
 *   ★ 不用 3：`request-confirm.js` 的 exit 3 = 「已登记但送达未确认」（同家族双义，评审 R3 ②）。
 */
const ANSWER_ALLOWED = {
  confirm: true, choice: true, text: true,
  cancel: false, 'defer-ide': false, ide: false, superseded: false, timeout: false,
};
function isAuthorized(j) {
  if (j && typeof j.allowed === 'boolean') return j.allowed;
  return ANSWER_ALLOWED[String((j && j.answer) || '')] === true;
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
    else if (k === '--docPath' || k === '--doc-path') a.docPath = argv[++i]; // ★ 方式2：拍板依据文档（相对 docs/iterations，如 "2026-10-06-001/03-技术方案.md"；非法/缺省 ⇒ QQ 消息附列表页链接）
    else if (k === '--wait') {                                                   // ★ 显式指定等待（默认已等待，仅用于改秒数）
      a.wait = true;
      const nx = argv[i + 1];
      if (nx != null && /^\d+$/.test(nx)) { a.waitSec = parseInt(nx, 10); i++; } // `--wait` 无值 = 300；`--wait 600` = 600
    }
    else if (k === '--no-wait') a.noWait = true;                                 // ★ TOOL-QQWAIT-2：已废弃，见下方硬拒绝
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
  console.error('       node ask.js --prompt "问题" --wait [秒]        # 默认已等待（缺省 300）；本参数只用于改秒数');
  process.exit(1);
}
// ★★ TOOL-QQWAIT-2（2026-10-28 · 第 6 例空转后）：`--no-wait` 删除 —— **恒 exit 1、不登记**。
//   为什么不是「删掉这个 else-if 分支就行」：`parseArgs` 对未知参数是**静默忽略**，
//     连解析一起删 ⇒ 带该参数的调用会落到默认等待 ⇒ 白等 300s；而 gate-check 是 detached
//     spawn + stdio:'ignore' + unref ⇒ 变孤儿进程挂 300s，且**没有任何报错**。
//   ⇒ 必须显式识别并硬拒（本段位于任何 HTTP 请求之前：被拒时不得留下待确认项）。
//   为什么连 env 门控也一起删：豁免的声明方与被约束方是**同一个模型**（一条 `$env:` 前缀即自证），
//     故任何「由调用方自己声明」的豁免都等于没有豁免 —— 不再保留开关，只保留三条合法出路。
if (a.noWait) {
  console.error('[ERR] --no-wait 已删除：登记必须自带消费者（2026-10-28 第 6 例空转后移除）。');
  console.error('      三条合法出路：① 默认等待（300s/片，可重入续等） ② 登记后立刻派 waiter 成员');
  console.error('                    ③ 用 --handoff 交模式 B（headless 接管）。');
  console.error('      不可逆动作的知会不走本脚本：gate-check 直接调 notify.qqbot.js（单向通知，无待确认项）。');
  console.error('      本次**未登记任何编号**（在 HTTP 请求之前返回）。');
  process.exit(1);
}
// ★ 等待秒数归一（非法/缺省 = 300 = 1 片，可重入续等）
const WAIT_SEC = (a.waitSec > 0 ? a.waitSec : 300);
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
  docPath: a.docPath || '',                                // ★ 方式2：拍板依据文档链接（服务端校验 + 渲染到 QQ 消息尾部）
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
    // ★ TOOL-QQWAIT-2：登记即入台账 —— Stop 侧据此判「本会话登记了 ask 但无人消费」。
    //   台账由**登记方自己写**（不是 hook 解析命令行）：hook 在 PreToolUse 拿不到 #id，
    //   且文本匹配会把 Get-Content/Select-String 之类全记成登记。
    ledgerAppend({ id: j.id, conv: convId(), event: 'register', kind: (a.kind || (OPTIONS.length ? 'decision' : 'ask')), handoff: !!a.handoff, waitSec: WAIT_SEC });
    // ★ 登记 + 等待在同一进程内完成 —— waiting-protocol §2「登记 ≠ 等待」铁律的机制保证。
    //   `--no-wait` 已在文件头硬拒 ⇒ 本分支是**唯一**路径（代码里不再存在"只登记"的分支）。
    if (!a.json) {
      console.log('已登记 "#' + j.id + '" 并推送 QQ；进入同进程等待（' + WAIT_SEC + 's/片，片满可重入续等）');
      console.log('#id=' + j.id);
      console.log('#ts=' + regTs);
      console.log(OPTIONS.length
        ? '选择题：回 ' + OPTIONS.map((o) => o.key).join('/') + ' 或带编号如 ' + OPTIONS[0].key + '#' + j.id
        : '回复「确认#' + j.id + '」或「取消#' + j.id + '」');
    }
    waitAnswer(j.id, regTs, WAIT_SEC).then((r) => {
      if (r.ok) {
        // ★ TOOL-QQWAIT-2：答到即"有消费者"（本进程读到了）⇒ 落台账 + 审计标记。
        //   ★ 边界（勿据此放宽判断）：`.done` 只证明「有进程读过这份答复」，
        //     **不证明**「会话能被唤醒」—— 后台化的 ask.js 同样会写 .done 但模型看不到答案。
        const allowed = isAuthorized(r.j);
        ledgerAppend({ id: j.id, conv: convId(), event: 'consumed', answer: String(r.j.answer || ''), answerKind: String(r.j.answerKind || ''), allowed: allowed });
        writeDone(j.id, { answer: String(r.j.answer || ''), allowed: allowed });
        if (!allowed) {
          // ★ TOOL-ANSWERKIND：有答复 ≠ 有授权（defer-ide / cancel / timeout 一律不得推进）
          if (!a.json) console.log('⚠ 收到答复但**不构成授权**（' + (r.j.answerKind || r.j.answer) + '）：' + (r.j.hint || '禁止按本项推进'));
          console.log(JSON.stringify(r.j));
          process.exit(4);
        }
        if (!a.json) console.log('已收到答复 #' + j.id + '：');
        console.log(JSON.stringify(r.j));
        process.exit(0);
      }
      // ★ TOOL-QQWAIT-2：片满记账 —— 按 waiting-protocol §3「≤6 片」累积；
      //   用尽即记 giveup，Stop 侧据此**放行**（否则「按协议停止等待」会被判成违规 = 正常流程误拦）。
      const slice = sliceCount(j.id) + 1;
      ledgerAppend({ id: j.id, conv: convId(), event: 'wait-end', reason: 'timeout', slice: slice });
      if (slice >= 6) ledgerAppend({ id: j.id, conv: convId(), event: 'giveup', reason: 'slices-exhausted', slice: slice });
      if (!a.json) console.log('本片等待已用尽（' + WAIT_SEC + 's，第 ' + slice + '/6 片）。可重入续等：再跑一次同命令即可（服务端待确认项仍在）。');
      console.log(JSON.stringify({ id: j.id, answer: 'wait-timeout' }));
      process.exit(2);
    });
  });
});
req.setTimeout(5000, () => req.destroy(new Error('timeout')));
req.on('error', (e) => {
  console.error('[ERR] 服务不可用：' + e.message + '（先运行 tools/qqbot/start-service.ps1）');
  process.exit(1);
});
req.write(body); req.end();
