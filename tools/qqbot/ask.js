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
//   ★ `--no-wait` = 关闭等待（逃生口）：只登记即退出。**仅供自动化 / 门禁回路使用**（如
//     `engine/gate/gate-check.mjs` 的不可逆分支以 detached spawn 调本脚本 —— hook 15s 超时后
//     子进程会变孤儿，若默认等待会白挂 300s）。Agent 在 IDE 内登记时**禁止**用它。
//     ★ 默认等待的动因（2026-10-26 第 4 例空转实证）：opt-in 缺省关闭时，Agent 漏带 `--wait`
//       即「只登记不等待」⇒ QQ 答复无人消费。默认值改为等待 ⇒ 漏带参数的失效方向从
//       「静默空转」翻转为「多等 5 分钟」（可观测、可续等）。
//   ★★ `--no-wait` 现为**环境变量门控**（2026-10-26 第 5 例空转后加固）：必须
//      `QQ_ASK_AUTOMATION=1` 才生效，否则 exit 1（见下方 NO_WAIT_ENV 校验）。
//      动因：默认等待是 opt-out ⇒ 一次「担心工具调用超时」的自我说服即可绕过 —— 第 5 例
//      正是 IDE 会话显式带 `--json --no-wait` 登记 #3 后跳过轮询直接结束回合，用户 7 秒后
//      回 A 却无人消费。⇒ 把逃生口从「命令行即可触发」收紧为「须由调用方注入环境变量」，
//      使「默认等待」成为**不可被提示词绕过的机制**而非建议。
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
    else if (k === '--no-wait') a.noWait = true;                                 // ★ 2026-10-26：关闭默认等待（自动化专用）
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
  console.error('       QQ_ASK_AUTOMATION=1 node ask.js --prompt "…" --no-wait   # 关闭等待（仅自动化/门禁回路）');
  process.exit(1);
}
// ★★ 2026-10-26（第 5 例空转后加固）：`--no-wait` 须 `QQ_ASK_AUTOMATION=1` 门控 —— fail-closed。
//   事故：IDE 会话以 `--json --no-wait` 登记 #3（11:18:37）→ 跳过轮询、11:19:01 结束回合
//         → 用户 11:18:44 在 QQ 回 A，无人消费（"默认等待"被命令行参数绕过）。
//   本校验必须放在**任何 HTTP 请求之前**：被拒时不得留下待确认项（否则更糟 —— 卡片已发但无人等）。
//   失效形态（防回归）：若退化为"只打警告仍继续"⇒ 静默空转复发，等于本加固无效。
//   合法调用方：`engine/gate/gate-check.mjs` 不可逆分支（detached spawn，已同批注入该变量）。
const NO_WAIT_ENV = 'QQ_ASK_AUTOMATION';
if (a.noWait && String(process.env[NO_WAIT_ENV] || '') !== '1') {
  console.error('[ERR] --no-wait 仅限自动化 / 门禁回路：须显式注入环境变量 ' + NO_WAIT_ENV + '=1');
  console.error('      IDE 内登记必须等待（默认 300s/片，可重入续等）；要改秒数用 --wait <秒>。');
  console.error('      理由：登记 ≠ 等待（waiting-protocol §2）—— 只登记不等待的答复必然无人消费。');
  process.exit(1);
}
// ★ 等待秒数归一（非法/缺省 = 300 = 1 片，可重入续等）
const WAIT_SEC = (a.waitSec > 0 ? a.waitSec : 300);
// ★ 2026-10-26：默认等待（`--no-wait` 才关闭）—— 见文件头「默认等待的动因」
const SHOULD_WAIT = !a.noWait;
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
    if (SHOULD_WAIT) {
      // ★ 登记 + 等待在同一进程内完成 —— waiting-protocol §2「登记 ≠ 等待」铁律的机制保证。
      //   2026-10-26 起**默认走本分支**（`--no-wait` 才落到下方只登记路径）。
      if (!a.json) {
        console.log('已登记 "#' + j.id + '" 并推送 QQ；进入同进程等待（' + WAIT_SEC + 's/片，片满可重入续等）');
        console.log('#id=' + j.id);
        console.log('#ts=' + regTs);
      }
      waitAnswer(j.id, regTs, WAIT_SEC).then((r) => {
        if (r.ok) {
          if (!isAuthorized(r.j)) {
            // ★ TOOL-ANSWERKIND：有答复 ≠ 有授权（defer-ide / cancel / timeout 一律不得推进）
            if (!a.json) console.log('⚠ 收到答复但**不构成授权**（' + (r.j.answerKind || r.j.answer) + '）：' + (r.j.hint || '禁止按本项推进'));
            console.log(JSON.stringify(r.j));
            process.exit(4);
          }
          if (!a.json) console.log('已收到答复 #' + j.id + '：');
          console.log(JSON.stringify(r.j));
          process.exit(0);
        }
        if (!a.json) console.log('本片等待已用尽（' + WAIT_SEC + 's）。可重入续等：再跑一次同命令即可（服务端待确认项仍在）。');
        console.log(JSON.stringify({ id: j.id, answer: 'wait-timeout' }));
        process.exit(2);
      });
      return;
    }
    if (a.json) {
      // ★ 2026-10-26（第 5 例空转）：`--json` 不允许吞掉「谁在等」告警 —— 原来此处直接 return，
      //   调用方只看到 {"id","status","ts"}，零提示（第 5 例的会话甚至没意识到必须派 waiter）。
      //   口径：stdout 保持纯 JSON（脚本可解析），告警一律走 stderr。
      console.error('[WARN] --no-wait：已登记但**无等待者** —— 必须自行派 waiter 成员或用 poll-answer 读回，否则答复必然空转');
      console.log(JSON.stringify(Object.assign({}, j, { ts: regTs })));
      return;
    }
    console.log('已登记 "#' + j.id + '" 并推送到 QQ（--no-wait：只登记、不等待；须自行派 waiter 或用 poll-answer 读回）'
      + (OPTIONS.length
        ? '；选择题：回 ' + OPTIONS.map((o) => o.key).join('/') + ' 或带编号如 ' + OPTIONS[0].key + '#' + j.id
        : '；回复「确认#' + j.id + '」或「取消#' + j.id + '」'));
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
