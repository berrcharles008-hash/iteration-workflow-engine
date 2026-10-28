#!/usr/bin/env node
// poll-answer.js —— IDE / agent 侧「主动拉取 QQ 答复」
//
// 背景（2026-09-18 FIX-17d）：服务会把你的 QQ 回复落盘到 `.codebuddy/temp/qq-answers/<id>.json`
//   （answer = confirm / choice / cancel / defer-ide / timeout / superseded / text；text 型附带 `text` 原文）。
//   ★ TOOL-ANSWERKIND（2026-10-20）：答案文件另带自述字段 answerKind / allowed / hint
//     —— allowed=false（defer-ide · cancel · timeout · superseded）**不构成任何授权**：不得推进阶段、
//     不得写 phase_confirm。历史值 `ide` 等同 `defer-ide`（QQ 侧作废、回 IDE 拍板），**不是**「IDE 已确认」。
//   但 IDE 会话**无法被推送唤醒** ⇒ 由 agent 在合适时机**主动读取**这些答案，
//   回到工位后即可凭此接续（无需重复劳动，也不会与 headless 撞车）。
//
// 用法：
//   node tools/qqbot/poll-answer.js                 # 列出「未消费」的答复
//   node tools/qqbot/poll-answer.js --all           # 列出全部（含已消费）
//   node tools/qqbot/poll-answer.js --id 1          # 只看 #1（`--id 1,3` / 重复传参均可）
//   node tools/qqbot/poll-answer.js --since 2026-09-18T01:00:00.000Z
//   node tools/qqbot/poll-answer.js --id 1 --consume      # 只消费 #1（写 consumedAt）
//   node tools/qqbot/poll-answer.js --json          # 机器可读输出
//
// ★ TOOL-QQCONSUME（2026-10-26 实施，工单 `runtime/TOOLING-TODO.md`）：
//   答案目录**跨会话共享**，而旧的 `--consume` 是「把本次列出的**全部**项标为已消费」——
//   实测 2026-10-26 一次列出 8 条（含他会话 #3/#6/#7/#8）⇒ 直接消费会把别人的答复吃掉。
//   现口径（fail-closed）：
//     ① `--consume` **必须**限定范围（`--id` 或 `--since` 至少一个），否则**拒绝执行**（exit 2）；
//     ② `--id` 用于精确消费本会话登记的编号（首选；id 来自 `ask.js` 返回的 `#id=`）；
//     ③ 消费后回显「已消费 #N …」清单（替代只报条数）。
//
// ★ TOOL-QQWAIT invariant（2026-10-19，引擎侧 waiting-protocol.md §4 同文）：
//   `ask.js` 命中答复后**不得**同回合再跑本脚本 `--consume` —— `ask.js` 不写 `consumedAt`，
//   重复消费会让同一答复被再次读到（`ask.js` 判 JSON 内 `ts`，本脚本判 `consumedAt`，
//   `wait-answer.ps1` 判文件 mtime ⇒ 三套新鲜度判据并存，勿混用）。
//
// ★ 测试隔离：`QQ_ANSWER_DIR` 可覆盖答案目录（与 `ask.js` 同口径）——仅供隔离测试，
//   生产不传；否则隔离测试的写入/消费会打到真实答复上。
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PROJ = path.resolve(DIR, '..', '..');

/** 答案目录（可用 QQ_ANSWER_DIR 覆盖，供隔离测试） */
function answerDir() {
  const ov = process.env.QQ_ANSWER_DIR;
  if (ov && String(ov).trim()) return path.resolve(String(ov).trim());
  return path.join(PROJ, '.codebuddy', 'temp', 'qq-answers');
}

function parseArgs() {
  const a = { all: false, consume: false, json: false, since: '', ids: [] };
  const argv = process.argv.slice(2);
  const pushIds = (raw) => {
    for (const seg of String(raw || '').split(/[,\s]+/)) {
      if (!seg) continue;
      const n = parseInt(seg, 10);
      if (n > 0) a.ids.push(n);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--all') a.all = true;
    else if (k === '--consume') a.consume = true;
    else if (k === '--json') a.json = true;
    else if (k === '--since') a.since = argv[++i] || '';
    else if (k === '--id' || k === '--ids') pushIds(argv[++i]);
  }
  return a;
}
const args = parseArgs();
const dir = answerDir();

// ── fail-closed：无限定的 --consume 拒绝执行（防吃他会话答复）──────────────
if (args.consume && !args.ids.length && !args.since) {
  console.error('[拒绝] --consume 必须限定范围：--id <n[,n]> 或 --since <ISO 时间>（TOOL-QQCONSUME）');
  console.error('  原因：答案目录跨会话共享，无限定消费会把**其它会话**的答复一并标记为已消费。');
  console.error('  正确用法：');
  console.error('    node tools/qqbot/poll-answer.js --id 1 --consume            # 只消费 #1（首选）');
  console.error('    node tools/qqbot/poll-answer.js --since 2026-10-26T00:00:00.000Z --consume');
  process.exit(2);
}

let files = [];
try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { /* 目录不存在 = 无答复 */ }

const rows = [];
for (const f of files) {
  try {
    const p = path.join(dir, f);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.__file = p;
    rows.push(j);
  } catch (e) { /* 坏文件跳过 */ }
}
rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

let list = rows;
if (args.since) list = list.filter((r) => String(r.ts || '') > args.since);
if (args.ids.length) list = list.filter((r) => args.ids.indexOf(Number(r.id)) >= 0);
if (!args.all) list = list.filter((r) => !r.consumedAt);

// 指定了 --id 但未命中 ⇒ 显式提示（防「以为消费了」的静默）
const missed = args.ids.filter((id) => !rows.some((r) => Number(r.id) === id));

const consumed = [];
if (args.consume) {
  const now = new Date().toISOString();
  for (const r of list) {
    try {
      const { __file, ...clean } = r;
      clean.consumedAt = now;
      fs.writeFileSync(__file, JSON.stringify(clean), 'utf8');
      consumed.push(r.id);
    } catch (e) { /* 忽略单个失败 */ }
  }
}

if (args.json) {
  console.log(JSON.stringify(list.map(({ __file, ...r }) => r)));
} else if (!list.length) {
  console.log('（无未消费的 QQ 答复）');
} else {
  console.log('共 ' + list.length + ' 条' + (args.consume ? '（已标记 consumedAt）' : ''));
  for (const r of list) {
    const t = r.answer === 'text' ? ('text: ' + (r.text || '')) : String(r.answer || '');
    const tag = r.answerKind ? (' ⟨' + r.answerKind + (r.allowed === false ? ' · 禁止推进' : '') + '⟩') : '';
    console.log('#' + r.id + ' [' + r.kind + '] ' + (r.ts || '') + ' ⇒ ' + t + tag);
    if (r.allowed === false && r.hint) console.log('    ⚠ ' + r.hint);
    if (r.prompt) console.log('    事项：' + String(r.prompt).split('\n')[0].slice(0, 100));
  }
}

if (args.consume && !args.json) {
  console.log(consumed.length ? ('已消费：' + consumed.map((i) => '#' + i).join(' ')) : '已消费：（无）');
}
if (missed.length && !args.json) {
  console.log('⚠ 未找到这些编号（不存在或已被清理）：' + missed.map((i) => '#' + i).join(' '));
}
