#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════════════
// runner.js —— session-hub 会话包装器（工具无关）
// SSOT: 项目管理/PIVAS-会话监控中心（session-hub）方案分析.md（§11 三路评审修订）
//
// 用法: node runner.js --tool <name> [--tags a,b] [--cwd <dir>] [--encoding gbk|utf8] -- <cmd...>
//   `--` 之后的所有参数原样作为目标命令（不做 shell 拼接，execFile 语义）。
//
// 职责（评审修订③/⑥/⑦/⑪）：
//   - spawn 目标 CLI，stdout/stderr 以 **文件 fd 直写** logs/<id>.log（stdio:['pipe',fd,fd]），
//     零 tee 循环、零输出搬运；日志落盘为原始字节，encoding 仅作为声明写入条目。
//   - stdin 保持 open-pipe（修订⑦：serve 型 CLI stdin EOF 即秒退 —— adapter-headless.js:15 实证）。
//   - 登记 sessions/<id>.json：started → 终态（status/exitCode/endedAt），原子写（tmp+rename，O_EXCL）。
//   - 登记（含终态）完成后本进程即无职责；CLI 模式下仅挂起等 exit（持有 stdin），透传退出码。
//
// 可被 server.js require：registerAndSpawn(opts) 返回 { entry, child }。
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HUB_DIR = __dirname;
const SESSIONS_DIR = path.join(HUB_DIR, 'sessions');
const LOGS_DIR = path.join(HUB_DIR, 'logs');
const INPUTS_DIR = path.join(HUB_DIR, 'inputs');      // ★ v2：stdin 中继目录（hub → 会话交互输入）

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'hub.config.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return {}; }
}

// ── ★ 多项目（2026-11-18，hub 迁至 %LOCALAPPDATA%\codebuddy-hub）─────────────
//   迁出项目目录后 `HUB_DIR/../..` 不再等于项目根 ⇒ 项目根一律来自配置：
//     hub.config.json → projects[{ id, name, root }]，default = 缺省项目 id。
//   兼容：无 projects 但顶层有 root 时按单项目处理（迁移期）。
//   判据：**只用配置，不做目录推导**（防止把 %LOCALAPPDATA% 当项目根）。
function projectList(cfg) {
  const raw = Array.isArray(cfg && cfg.projects) ? cfg.projects : [];
  const out = raw
    .filter((p) => p && p.id && p.root)
    .map((p) => ({ id: String(p.id), name: String(p.name || p.id), root: String(p.root) }));
  if (out.length) return out;
  if (cfg && cfg.root) return [{ id: String(cfg.projectId || 'default'), name: String(cfg.projectName || 'default'), root: String(cfg.root) }];
  return [];
}
function resolveProject(cfg, id) {
  const list = projectList(cfg);
  if (!list.length) return null;
  const want = String(id == null ? '' : id).trim() || String((cfg && cfg.default) || '') || list[0].id;
  return list.find((p) => p.id === want) || null;
}
function resolveProjectRoot(cfg, id) {
  const p = resolveProject(cfg, id);
  return p ? path.resolve(p.root) : '';
}
/** 缺省项目根（无 projects 配置 ⇒ ''，调用方必须显式给 cwd） */
const PROJ_ROOT = resolveProjectRoot(loadConfig(), '');

function pad(n) { return (n < 10 ? '0' : '') + n; }
function tsLocal(d) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function randChars(n) {
  // crypto 随机（≥6 字符，修订⑪熵增要求）
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  try {
    const b = require('crypto').randomBytes(n);
    for (let i = 0; i < n; i++) s += abc[b[i] % abc.length];
  } catch (e) {
    for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
  }
  return s;
}

/** 会话 id（修订⑪）：s-YYYYMMDD-HHmmss-<ms>-<pid>-<rand6> */
function makeId(now) {
  now = now || Date.now();
  return 's-' + tsLocal(new Date(now)) + '-' + (now % 1000) + '-' + process.pid + '-' + randChars(6);
}

/** 原子写 JSON（修订⑪）：同目录 tmp（O_EXCL 创建防冲突）→ rename（同盘原子） */
function writeJsonAtomic(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.' + process.pid + '.tmp';
  const data = JSON.stringify(obj, null, 1);
  let fd;
  try { fd = fs.openSync(tmp, 'wx'); fs.writeSync(fd, data); fs.closeSync(fd); fd = null; }
  finally { try { if (fd != null) fs.closeSync(fd); } catch (e) {} }
  try { fs.renameSync(tmp, fp); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
}

/** 按工具名取编码声明（修订⑥/⑬）：--encoding 显式 > encodingByTool 表 > default */
function resolveEncoding(tool, explicit, cfg) {
  if (explicit === 'gbk' || explicit === 'utf8') return explicit;
  const table = (cfg && cfg.encodingByTool) || {};
  if (table[tool]) return table[tool];
  return table['default'] || 'gbk';
}

/** 解析 CLI 参数：-- 后为 cmd 数组 */
function parseArgs(argv) {
  const out = { tool: '', tags: [], cwd: '', encoding: '', project: '', cmd: [] };
  const dd = argv.indexOf('--');
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === '--tool') out.tool = head[++i] || '';
    else if (a === '--tags') out.tags = String(head[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--cwd') out.cwd = head[++i] || '';
    else if (a === '--encoding') out.encoding = head[++i] || '';
    else if (a === '--project') out.project = head[++i] || '';       // ★ 多项目：缺省 = config.default
  }
  out.cmd = rest;
  return out;
}

/**
 * 登记并 spawn 一个会话。
 * @param {object} opts { tool, cmd[], cwd?, tags?[], encoding? }
 * @returns {{entry: object, child: object}}
 */
function registerAndSpawn(opts) {
  const cfg = loadConfig();
  const tool = String(opts.tool || '').trim() || 'unknown';
  const cmd = (opts.cmd || []).map(String);
  if (!cmd.length) throw new Error('registerAndSpawn: cmd 为空');
  // ★ 多项目：项目根必须能解析（配置缺失 ⇒ 明确抛错，不再回落到目录推导）
  const proj = resolveProject(cfg, opts.project);
  if (!proj) throw new Error('registerAndSpawn: 未解析到项目（hub.config.json → projects[] / default）；请检查配置或传 --project');
  const projRoot = path.resolve(proj.root);
  let cwd = String(opts.cwd || '').trim() || projRoot;
  const st = fs.statSync(cwd);                                    // 不存在/非目录 → 抛错
  if (!st.isDirectory()) throw new Error('cwd 不是目录: ' + cwd);
  const encoding = resolveEncoding(tool, opts.encoding, cfg);
  const tags = (opts.tags || []).map(String).slice(0, 8);

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  // id 唯一性：O_EXCL 创建日志文件（冲突即重生成 id，修订⑪）
  let id = '', logFd = -1, logPath = '';
  for (let i = 0; i < 5; i++) {
    id = makeId();
    logPath = path.join(LOGS_DIR, id + '.log');
    try { logFd = fs.openSync(logPath, 'wx'); break; } catch (e) { if (e.code !== 'EEXIST') throw e; id = ''; }
  }
  if (!id) throw new Error('registerAndSpawn: id 生成冲突重试耗尽');

  const entry = {
    id: id, tool: tool, cmd: cmd, cwd: cwd, project: proj.id, projectName: proj.name,
    pid: null, startedAt: new Date().toISOString(), startedAtMs: Date.now(),
    endedAt: null, status: 'running', exitCode: null, signal: null,
    logPath: logPath,                                 // ★ 多项目：hub 已迁出项目目录 ⇒ 绝对路径（原 'tools/session-hub/logs/…' 失效）
    encoding: encoding, tags: tags, meta: {}, note: '',
  };

  // 终态登记：kill 树优先 taskkill（Windows），写条目后透传退出码（finalized 防重入）
  let finalized = false;
  const finalize = (status, exitCode, signal, note) => {
    if (finalized) return;
    finalized = true;
    entry.status = status;
    entry.exitCode = (typeof exitCode === 'number') ? exitCode : null;
    entry.signal = signal || null;
    entry.endedAt = new Date().toISOString();
    if (note) entry.note = String(note).slice(0, 200);
    writeJsonAtomic(path.join(SESSIONS_DIR, id + '.json'), entry);
  };

  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: cwd,
    windowsHide: true,
    stdio: ['pipe', logFd, logFd],          // ★ 修订③ fd 直写 + 修订⑦ stdin open-pipe（不 end）
  });
  entry.pid = child.pid;
  writeJsonAtomic(path.join(SESSIONS_DIR, id + '.json'), entry);   // started 登记（原子写）
  try { fs.closeSync(logFd); } catch (e) {}                        // spawn 后父进程侧 fd 即可关闭（子进程持有自己的句柄）

  // ★ v2 加固（2026-10-04 实测）：stdin 管道 EPIPE / ERR_STREAM_DESTROYED 是**异步 error 事件**，
  //   无监听器会升级为 uncaughtException 炸掉父进程（hub 崩溃实证）。挂空处理器吞掉（写失败由调用方 catch 兜底）。
  if (child.stdin) child.stdin.on('error', () => {});

  child.on('exit', (code, signal) => {
    finalize(code === 0 ? 'done' : (code == null && signal ? 'killed' : 'failed'), code, signal, '');
  });
  child.on('error', (e) => {
    finalize('failed', null, null, 'spawn-error: ' + (e && e.message));
  });

  // ★ v2（session-hub 增补③）：stdin 中继 —— hub POST /input 追加 inputs/<id>.in（每行一条 JSON {data}），
  //   本进程 500ms 轮询增量、按行解析后转发到 child.stdin（stdin 管道保持 open，见修订⑦）。
  //   说明：这是「输入侧」轻量轮询（仅 statSync 增量读，无输出搬运），与会话存活同生命周期，随 exit 清理。
  let inOffset = 0;
  let inTail = Buffer.alloc(0);
  const inputFile = path.join(INPUTS_DIR, id + '.in');
  const inputTick = () => {
    let size = 0;
    try { size = fs.statSync(inputFile).size; } catch (e) { return; }        // 文件不存在 = 尚无输入
    if (size < inOffset) { inOffset = 0; inTail = Buffer.alloc(0); }         // 文件被重建 ⇒ 重置读位
    if (size === inOffset) return;
    let buf;
    try {
      const fd = fs.openSync(inputFile, 'r');
      try { buf = Buffer.alloc(size - inOffset); fs.readSync(fd, buf, 0, buf.length, inOffset); }
      finally { fs.closeSync(fd); }
    } catch (e) { return; }
    inOffset = size;
    inTail = Buffer.concat([inTail, buf]);
    const nl = inTail.lastIndexOf(0x0A);
    if (nl < 0) return;
    const chunk = inTail.slice(0, nl).toString('utf8');
    inTail = inTail.slice(nl + 1);
    for (const line of chunk.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let data = t;
      try { const j = JSON.parse(t); if (j && typeof j.data === 'string') data = j.data; } catch (e) {}
      try { if (child.stdin && !child.stdin.destroyed) child.stdin.write(data + '\n'); } catch (e) {}
    }
  };
  const inputTimer = setInterval(inputTick, 500);
  child.on('exit', () => clearInterval(inputTimer));
  child.on('error', () => clearInterval(inputTimer));

  return { entry: entry, child: child, finalize: finalize };
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.cmd.length) {
    process.stderr.write('usage: node runner.js --tool <name> [--project <id>] [--tags a,b] [--cwd <dir>] [--encoding gbk|utf8] -- <cmd...>\n');
    process.exit(2);
  }
  let r;
  try {
    r = registerAndSpawn({ tool: a.tool, cmd: a.cmd, cwd: a.cwd, tags: a.tags, encoding: a.encoding, project: a.project });
  } catch (e) {
    process.stderr.write('[runner] 登记失败: ' + e.message + '\n');
    process.exit(2);
  }
  // Ctrl+C / kill：树终止子进程（禁裸句柄杀 —— taskkill /T /F，修订①口径）并写终态
  const killTree = () => {
    try { spawn('taskkill', ['/PID', String(r.entry.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
    r.finalize('killed', null, 'SIGINT', 'runner interrupted');
  };
  process.on('SIGINT', () => { killTree(); setTimeout(() => process.exit(130), 500); });
  process.on('SIGTERM', () => { killTree(); setTimeout(() => process.exit(130), 500); });
  process.stdout.write('[runner] id=' + r.entry.id + ' pid=' + r.entry.pid + ' tool=' + r.entry.tool + '\n');
  r.child.on('exit', (code, signal) => {
    process.exit(typeof code === 'number' ? code : (signal ? 130 : 1));
  });
  r.child.on('error', () => process.exit(1));
}

module.exports = {
  registerAndSpawn, writeJsonAtomic, loadConfig, makeId, resolveEncoding,
  SESSIONS_DIR, LOGS_DIR, INPUTS_DIR, HUB_DIR,
  PROJ_ROOT,                      // 缺省项目根（无 projects 配置时为 ''）
  projectList, resolveProject, resolveProjectRoot,
};
