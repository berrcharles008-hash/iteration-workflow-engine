#!/usr/bin/env node
// poll-answer.js —— IDE / agent 侧「主动拉取 QQ 答复」
//
// 背景（2026-09-18 FIX-17d）：服务会把你的 QQ 回复落盘到 `.codebuddy/temp/qq-answers/<id>.json`
//   （answer = confirm / cancel / timeout / superseded / text；text 型附带 `text` 原文）。
//   但 IDE 会话**无法被推送唤醒** ⇒ 由 agent 在合适时机**主动读取**这些答案，
//   回到工位后即可凭此接续（无需重复劳动，也不会与 headless 撞车）。
//
// 用法：
//   node tools/qqbot/poll-answer.js                 # 列出「未消费」的答复
//   node tools/qqbot/poll-answer.js --all           # 列出全部
//   node tools/qqbot/poll-answer.js --since 2026-09-18T01:00:00.000Z
//   node tools/qqbot/poll-answer.js --consume       # 本次列出的项标记为已消费（写 consumedAt）
//   node tools/qqbot/poll-answer.js --json          # 机器可读输出
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PROJ = path.resolve(DIR, '..', '..');

function parseArgs() {
  const a = { all: false, consume: false, json: false, since: '' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--all') a.all = true;
    else if (k === '--consume') a.consume = true;
    else if (k === '--json') a.json = true;
    else if (k === '--since') a.since = argv[++i] || '';
  }
  return a;
}
const args = parseArgs();
const dir = path.join(PROJ, '.codebuddy', 'temp', 'qq-answers');

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
if (!args.all) list = list.filter((r) => !r.consumedAt);

if (args.consume) {
  const now = new Date().toISOString();
  for (const r of list) {
    try {
      const { __file, ...clean } = r;
      clean.consumedAt = now;
      fs.writeFileSync(__file, JSON.stringify(clean), 'utf8');
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
    console.log('#' + r.id + ' [' + r.kind + '] ' + (r.ts || '') + ' ⇒ ' + t);
    if (r.prompt) console.log('    事项：' + String(r.prompt).split('\n')[0].slice(0, 100));
  }
}
