#!/usr/bin/env node
/**
 * 修改门禁检查钩子 — PreToolUse 层（硬约束）
 *
 * 在 write_to_file / replace_in_file / delete_file / execute_command 执行前进行阶段门禁检查。
 * 此脚本由 IDE PreToolUse hook 触发，Agent 无法绕过。
 *
 * 规则 SSOT：{TARGET}/skills/iteration-workflow/engine/gate-protocol.md
 *
 * === 门禁逻辑 ===
 * 1. ALWAYS_ALLOW（本迭代 runtime/ 目录）→ 无条件放行（★ FIX-9：段前缀匹配，不再用子串 includes）
 * 2. 逃生口（GATE_BYPASS 环境变量 或 .gate-bypass 标记文件）→ 放行
 * 3. execute_command → 命令风险分级：纯读放行，危险命令走门禁
 * 4. 无活跃迭代 → 阻止
 * 5. 04-开发实现 → **写入**放行（合法修改业务代码窗口）
 *    ★ FIX-9：**删除/移动类**（Delete 工具 ／ Bash 段含 del/rm/Remove-Item/move/ren/svn delete…）
 *      改为「清单锚定」——仅放行 {ID}.state.yaml 的 delete_allow 内路径（= 任务清单 DELETED/ADDED 项）；
 *      命中删除豁免（node_modules//dist//obj//bin//.vs//temp//memory//*.bak* 等）亦放行；
 *      delete_allow 缺失或为空 = 一律拦（fail-closed）。
 * 6. 01-03 阶段 → 仅 EXEMPT_PATHS 放行，其余阻止（删除类同受此限）
 * 7. 其他阶段 → 阻止
 *
 * 退出码：0=放行  2=阻止（阻塞错误，工具不执行）
 *
 * 变更历史：FIX-7 段级危险判定 ｜ FIX-8 工具名规范化 ｜ FIX-9 删除类清单锚定 + ALWAYS_ALLOW 收紧 + 拦截留痕
 *           ｜ FIX-14（2026-09-17）stdin BOM 剥离 + HOOK_RAW_INPUT 留痕 + 拦截话术优化 + QQ 结构化通知
 *           ｜ MAINT-3 P-5（2026-09-22）MEMORY.md 写入侧配额守卫（memoryQuotaGuard · fail-open）
 *           ｜ GATE-5（2026-09-23）META_WRITE_EXEMPT 增「外置项目记忆」模式
 *              （~/{IDE}/projects/<slug>/memory/**；删除豁免同口径；与 FIX-11 同层）
 *           ｜ GATE-7（2026-09-27 用户批准）豁免表对齐实际产出，消合法写入误拦：
 *              ① 05 阶段放行 requirements/*.md（规格回写）+ docs/knowledge-base/；
 *              ② 06 阶段放行 project/lessons-learned.md（模式沉淀提前至 06）；
 *              ③ 无活跃迭代（none）放行纯文档路径 docs/iterations/ · requirements|feasibility 的 .md
 *                （立项前需求登记；业务代码仍然全拦）。
 *              依据：2026-09-14~09-27 gate-audit.log 实测 BLOCK 317 次，05 占 81 次，
 *              其中 requirements/*.md 22 次 + knowledge-base 33 次均为合法产出。
 *           ｜ GATE-A（2026-10-01 用户拍板「方案 A」）只读命令误拦收口（回归 SSOT §一 FIX-25 口径）：
 *              ① `powershell|pwsh -Command|-c "…"` / `cmd /c "…"` **整条剥壳**后再判（最多 3 层；
 *                 解析不出即放弃 ⇒ fail-closed）—— 消除「宿主本就在 PowerShell 里跑」的包装误判；
 *                 `node -e` / `python -c` / `bash -c` **不剥**（真·任意代码执行，保持拦）。
 *              ② 写/删/移动**动词**改「命令位」判定（WRITE_DELETE_VERB_AT_POS_RE）+ 判定前剔除
 *                 成对引号内文本（stripQuotedText）—— 消除 `-Pattern 'move'` / `--grep=move` /
 *                 `-Pattern 'a > b'` 等**数据**被当命令（实测 26 条只读样本误拦 10 条）。
 *              ③ 拦截话术分流：`[CMD] …` 伪路径不再复用文件话术（原提示「仅允许修改迭代产出目录」
 *                 对只读命令完全误导），改为报**命中规则** + 只读替代路径。
 *           ｜ GATE-A2（2026-10-01 同日补口）拾回 GATE-A② 收窄出的 1 处放行窗口：
 *              `$x=Remove-Item y`（`=` 两侧无空格）原整坨成为子句首 ⇒ 零成本绕过；
 *              现由 PS_ASSIGN_PREFIX_RE 先剥 PowerShell 变量赋值前缀再判（只剥 `$var=`，
 *              不碰 `--grep=move` 参数值）。回归 GATE-A 组随之上调（负向对照恢复满拦）。
 *           ｜ FIX-26（2026-10-01 用户批准·开闸实施）state 归档命令误拦收口，三处：
 *              ① resolveRenameNewName —— `Rename-Item -NewName '<裸名>'` 按源文件父目录展开
 *                 （PowerShell 语义：-NewName 只能给名称），消除「源已豁免、目标被判越界」的自相矛盾；
 *              ② runtimeMaintenanceTargets —— 所有危险段的目标都在 ALWAYS_ALLOW（runtime/）内时
 *                 命令通道放行，关闭「文件工具放行 / 命令一律拦」的通道不一致（归档维护被迫开闸）；
 *              ③ isAlwaysAllow 补「上跳段 `..`」守卫（只收紧）：防配合 ② 的放行面被路径穿越利用。
 *              实测依据：gate-audit.log 2026-10-01T08:47:27Z（裸名误拦）/ 08:48:37Z（删除层已放行、被阶段层拦）。
 *           ｜ HOOK-SLIM-1（2026-10-01 用户拍板）实现与入口分层：
 *              本文件（engine/gate/gate-check.mjs）承接全部门禁逻辑；
 *              .codebuddy/hooks/gate-check.mjs 降为转发 shim（5 个候选路径 + fail-closed）。
 *              动机（实测）：IDE 对 .codebuddy/hooks/** 的写入强制人工确认，且该确认独立于
 *              autoApprovalSettings（editFiles/executeCommands 全开、maxRequests=-1 仍弹），
 *              disabledSecurityCategories 亦不覆盖（其可选类别仅 injection/scriptExec/powershell）。
 *              实测 .codebuddy/skills/** 写入不触发确认（探针 A/B/C 三组）⇒ 策略改动移到本文件后
 *              迭代中不再需要用户手点「运行」。
 *              分发零改动：install.ps1 Step 2 以 Copy-Item -Recurse 整目录复制 engine/；
 *                          install.sh Step 4 复制单文件 shim；sync-back 以 -Recurse 回流。
 *              回归：run-gate-tests.mjs 40/40 通过（2026-10-01）。
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';

// ── 配置 ──────────────────────────────────────────────
const PROJECT_DIR = process.env.CODEBUDDY_PROJECT_DIR
  || process.env.CLAUDE_PROJECT_DIR
  || process.cwd();
const RUNTIME_DIR = process.env.GATE_TEST_RUNTIME_DIR
  || (existsSync(join(PROJECT_DIR, '.claude/skills/iteration-workflow/runtime'))
    ? join(PROJECT_DIR, '.claude/skills/iteration-workflow/runtime')
    : join(PROJECT_DIR, '.codebuddy/skills/iteration-workflow/runtime'));

// ── ★GATE-1①（2026-09-20）：调用留痕 —— 让「静默放行」变成可对账的事实 ──
//   背景：实测 2 次删除类调用既无 block 也无 allow 留痕（`deleteGate` 的审计同样缺失）
//   ⇒ 无法事后判定「hook 未触发」还是「早退静默放行」。本行在**读取 stdin 之前**留痕，
//   故超时 / 被 kill / 空 stdin 等早退路径**同样**留下证据。
//   对账判据：count(HOOK_ENTER) == count(allow) + count(BLOCK) + count(BYPASS)（差值 = 0 ⇒ 无幽灵调用）
if (!process.argv.includes('--stop-check')) {
  audit('HOOK_ENTER', `pid=${process.pid} ppid=${process.ppid} tty=${process.stdin.isTTY === true} argv=${process.argv.slice(1).join(' ')}`);
}

// ── ★GATE-1①（2026-09-20）：exit 留痕 —— **注册点上移**（原位于逃生口分支之后）──
//   原因：逃生口分支直接 `process.exit(0)` 早退，原注册点在其后 ⇒ 逃生口生效期间
//   **零事件留痕**（实测：HOOK_ENTER 有、HOOK_EXIT / allow / block 全无）。
//   上移到逃生口之前后，bypass 早退同样留下 HOOK_EXIT 证据。
//   安全：处理器体全部包 try/catch —— `WATCHED_TOOLS` / `toolName` 此刻可能仍在 TDZ，
//         抛出即被吞掉，**行为完全不变**（未赋值 ⇒ 不写 allow，与上移前一致）。
process.on('exit', (code) => {
  try {
    if (!process.argv.includes('--stop-check')) {
      let _t = '';
      try { _t = toolName || '(unset)'; } catch (e) { _t = '(tdz)'; }
      audit('HOOK_EXIT', `code=${code} tool=${_t}`);
    }
  } catch { /* 留痕失败不影响判定 */ }
  try {
    if (code === 2) return;                     // 2 = block（已记 block）
    if (process.argv.includes('--stop-check')) return;
    const t = (() => { try { return toolName || ''; } catch { return ''; } })();
    if (!WATCHED_TOOLS.includes(t)) return;      // 仅写类/命令类工具算「成功的写」
    recordGateEvent('allow', { reason: 'ALLOW' });
  } catch { /* 忽略 */ }
});

/** 任何阶段都无条件放行的目录段（状态维护）；★ FIX-9：由 includes() 子串匹配收紧为段前缀匹配 */
const ALWAYS_ALLOW_SEGMENTS = ['/skills/iteration-workflow/runtime/'];

/**
 * ★ FIX-9 删除类操作豁免（工程性/维护性删除，无需清单登记）
 * 判据：项目相对路径、正斜杠、小写比较
 */
const DELETE_EXEMPT_PATTERNS = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)obj\//,
  /(?:^|\/)bin\//,
  /(?:^|\/)\.vs\//,
  /(?:^|\/)\.codebuddy\/temp\//,
  /(?:^|\/)\.codebuddy\/memory\//,
  // ★ GATE-5（2026-09-23）：外置「项目记忆」目录（~/{IDE}/projects/<slug>/memory/**）同口径豁免
  /(?:^|\/)\.(?:codebuddy|claude|cursor|codex)\/projects\/[^/]+\/memory\//,
  /\.bak(?:[-.][\w.-]+)?$/,
  /\.(?:tmp|log|orig|rej|swp|old)$/,
];

/** ★ FIX-9 删除/移动类命令段（一并管重命名/移动：原路径将消失） */
const DELETE_CMD_PATTERNS = [
  /\b(?:Remove-Item|erase|rmdir|del|delete|delete_files)\b/i,
  /\brm\b/i,
  /\brd\b/i,
  /\b(?:Move-Item|Rename-Item|mv|move|ren|rename)\b/i,
  /\bsvn\s+(?:delete|rm|remove|move|mv|rename)\b/i,
];

/**
 * ★ FIX-21（2026-09-18）：门禁事件流（block / allow）—— 判定推迟到「会话结束」的唯一依据。
 *   block = 本次工具调用被拦截；allow = 写类工具调用最终放行（说明已开闸/换路径成功）。
 */
const GATE_EVENTS_FILE = join(PROJECT_DIR, '.codebuddy/temp/gate-events.jsonl');
const STOP_GATE_WINDOW_MS = 10 * 60 * 1000;   // 拦截距「会话结束」超过 10 分钟 ⇒ 与本次无关，不通知
// ★ FIX-21：上移自 notify 区（Stop 判定分支在逃生口块之前执行，晚声明会 TDZ）
const QQ_NOTIFY_MIN_INTERVAL_MS = 20000;    // 全局最小间隔（防并发 spawn 连发）
const QQ_NOTIFY_FP_WINDOW_MS = 600000;      // 同指纹窗口（10 分钟）
const QQ_NOTIFY_OFF_MARKERS = [
  '.codebuddy/hooks/.qq-notify-off',
  '.claude/hooks/.qq-notify-off',
];

/** 项目/运行时目录的规范化形式（供路径判定复用；★ FIX-9 提前定义，避免 Bash 分支 TDZ） */
const PROJECT_DIR_NORM = PROJECT_DIR.replace(/\\/g, '/');
const RUNTIME_DIR_NORM = RUNTIME_DIR.replace(/\\/g, '/');
const RUNTIME_REL = RUNTIME_DIR_NORM.startsWith(PROJECT_DIR_NORM)
  ? RUNTIME_DIR_NORM.slice(PROJECT_DIR_NORM.length + 1).replace(/\/?$/, '/')
  : null;

/** 01-03 阶段内允许写入的目录 */
const EXEMPT_PATHS = [
  '.codebuddy/skills/iteration-workflow/',
  '.claude/skills/iteration-workflow/',
  '.cursor/skills/iteration-workflow/',
  '.codex/skills/iteration-workflow/',
  'docs/iterations/',
  // ★ FIX-23（2026-09-20）：知识库为纯生成物（gen-knowledge-base.py 产出，非业务代码）。
  //   phase-01 前置步骤/step-1.6 要求"过时即刷新"，而该目录原不在放行表 ⇒ Agent 用 Write/Edit
  //   维护知识库时与门禁互斥（消除口径冲突；脚本执行本就可跑，见 gate-protocol.md §四）。
  //   放行口径与 06 阶段 STAGE_EXEMPT_PATHS['06'].dirs 一致。Bash 命令仍不享本豁免（FIX-24）。
  'docs/knowledge-base/',
  '.codebuddy/memory/',
  '.claude/memory/',
];

/**
 * ★ E-6（2026-10-02 迭代 2026-10-01-002 · 工单 R-14）：01-03 阶段「**仅 .md**」放行目录。
 * 依据：`phase-01.md` step-2-6 规定 CONTEXT.md 落点 = `{{SPECS_DIR}}/iteration-context/`，
 *   但该目录不在 EXEMPT_PATHS ⇒ 01 阶段写 CONTEXT.md 被拦（实测 2026-09-30-002 与本次迭代各 1 次）。
 * 口径：**仅 .md**（与 05/06/NONE 的 mdDirs 一致）⇒ 同目录 .cs/.sql 等仍拦（负向对照见回归）。
 */
const EXEMPT_PATHS_MD_ONLY = [
  'requirements/iteration-context/',
];

/**
 * ★ FIX-12②（2026-09-17）：05/06/07 阶段化文档豁免 —— 各阶段的「本职文档产出」放行 + 审计留痕。
 *
 * 依据：phase-05/06/07 均强制产出迭代文档；phase-06 更强制「spec 活文档更新（SPECS_DIR）」+ 知识库刷新。
 * 原实现仅在 01-03 分支做 EXEMPT_PATHS 判定，05/06/07 走裸 block ⇒ 与 SSOT §四 豁免表不一致，
 * 导致每次归档都需人工开逃生口（2026-09-17 实证：06/07 各需开闸一次）。
 *
 * 最小授权（仅文档路径，绝不含业务代码；★ GATE-7 2026-09-27 对齐实际产出）：
 *   05 → docs/iterations/ · docs/knowledge-base/ · requirements/*.md   （测试报告/知识库刷新/规格回写）
 *   06 → docs/iterations/ · docs/knowledge-base/ · requirements|feasibility 的 .md
 *        · project/lessons-learned.md
 *        （上线记录 / 知识库刷新 / spec 活文档回写 / 模式沉淀；★ mdDirs 限 .md，不放行同目录其它文件）
 *   07 → docs/iterations/ · project/lessons-learned.md             （回顾报告 / 模式沉淀）
 *   NONE → docs/iterations/ · requirements|feasibility 的 .md      （立项前需求登记 / 迭代文档预写）
 *
 * 明确仍拦（fail-closed）：00 全部、none 态的 knowledge-base 与业务区（back-end/ front-end/ sql/ …）、
 * requirements 非 .md 文件（全阶段）、07 的 project/ 其它文件、以及所有 Bash 命令。
 */
const STAGE_EXEMPT_PATHS = {
  // ★ GATE-7（2026-09-27）：05 增 knowledge-base（测试期知识库刷新）与 requirements/*.md
  //   （走查/测试期的规格回写）—— 实测 05 期误拦 requirements md 22 次、KB 33+ 次。
  '05': { dirs: ['docs/iterations/', 'docs/knowledge-base/'], mdDirs: ['requirements/'] },
  '06': {
    dirs: ['docs/iterations/', 'docs/knowledge-base/'],
    mdDirs: ['requirements/', 'feasibility/'],
    // ★ GATE-7：模式沉淀自 06 开始（实测 06 期 lessons-learned 被拦；07 原已放行）
    files: ['skills/iteration-workflow/project/lessons-learned.md'],
  },
  // ★ FIX-16（2026-09-17）：07 回顾的「模式沉淀」为强制本职动作（phase-07 step-3/step-5，
  //   AP-1/AP-4 明禁"仅报告声称"）⇒ 放行写 project/lessons-learned.md。
  //   判定走 files 精确后缀（自动跨 IDE 前缀），不放行 project/ 下其它文件。
  '07': { dirs: ['docs/iterations/'], files: ['skills/iteration-workflow/project/lessons-learned.md'] },
  // ★ GATE-7（2026-09-27）：无活跃迭代期的纯文档放行 —— 立项前需求登记
  //   （实测 requirements/待排期需求登记.md 被拦 2 次）与迭代文档预写。
  //   业务代码 / docs 其它子目录 / knowledge-base 在 none 态仍然全拦（fail-closed）。
  'NONE': { dirs: ['docs/iterations/'], mdDirs: ['requirements/', 'feasibility/'] },
};

/**
 * 阶段化文档豁免判定：命中返回命中的模式串（供审计），未命中返回 null。
 * ★ 排除 Bash 伪路径（`[CMD] …`）—— 命令不享受本豁免，仍由原阶段分支拦截。
 */
function matchStageExempt(phase, relPath) {
  const rule = STAGE_EXEMPT_PATHS[String(phase)];
  if (!rule) return null;
  const raw = String(relPath || '');
  if (!raw || raw.startsWith('[')) return null;
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  // ★ TRAVERSAL-1：含上跳段 ⇒ 不认定豁免（防 `docs/iterations/../../back-end/…` 借前缀越权）
  if (hasTraversal(p)) return null;
  const hit = (pat) => p.startsWith(pat) || p.includes('/' + pat);
  for (const f of rule.files || []) if (p === f || p.endsWith('/' + f)) return f;
  for (const d of rule.dirs || []) if (hit(d)) return d;
  if (/\.md$/i.test(p)) {
    for (const d of rule.mdDirs || []) if (hit(d)) return d;
  }
  return null;
}

/**
 * ★ FIX-11（2026-09-16）元层写入豁免：工作记忆目录 —— 与迭代状态无关。
 * 依据：① 系统级要求「每次完成任务必须写记忆」；② 元层原则（记忆维护 ≠ 业务迭代）；
 *      ③ 与 01-03 的 EXEMPT_PATHS、SSOT 删除豁免清单中的 {IDE}/memory/ 对齐。
 * 范围严格限定 memory/：不含 temp/（门禁探测点）、skills/、hooks/（元层改动仍走逃生口）。
 */
const META_WRITE_EXEMPT_PATHS = [
  '.codebuddy/memory/',
  '.claude/memory/',
  '.cursor/memory/',
  '.codex/memory/',
];

/**
 * ★ GATE-5（2026-09-23 用户批准）：外置「项目记忆」目录 —— 与 FIX-11 同层（元层写入，与阶段无关）。
 * 背景：CodeBuddy 系 IDE 把**项目级**记忆落在用户目录 `~/{IDE}/projects/<slug>/memory/**`，不在工作区内
 *      ⇒ 原 `{IDE}/memory/` 前缀恒不命中，01-03 写记忆被判越界（2026-09-23 实测 2 次；GATE-5 登记）。
 * 范围严格限定 `projects/<slug>/memory/`：不放行 `projects/<slug>/` 下其它内容（会话记录 / 转录等）。
 */
const META_WRITE_EXEMPT_RE = [
  /(?:^|\/)\.(?:codebuddy|claude|cursor|codex)\/projects\/[^/]+\/memory\//i,
];

/** ★ FIX-11：工作记忆路径判定。排除 Bash 伪路径（`[CMD] …`），
 *  避免命令文本里含 memory 字样被误当豁免目标放行。 */
/** ★ FIX-17e：headless 接管锁 —— 锁有效期内禁止其它会话写入业务区（服务写锁、本 hook 读锁）。
 *  豁免：① headless 自身（服务 exec 注入 PIVAS_HANDOFF_OWNER，随 CLI → hook 继承）
 *        ② 锁文件本身（允许删除以解除锁定）
 *  fail-open：无锁 / 已过期 / 解析失败一律视为无锁，避免残留锁把 IDE 永久锁死。 */
const HANDOFF_LOCK_REL = '.codebuddy/temp/handoff/RUNNING.json';
function handoffLockActive() {
  if (process.env.PIVAS_HANDOFF_OWNER) return null;
  try {
    const raw = readFileSync(join(PROJECT_DIR, HANDOFF_LOCK_REL), 'utf-8');
    const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (j && j.expiresAt && Date.now() < Number(j.expiresAt)) return j;
  } catch { /* 无锁 / 过期 / 解析失败 ⇒ 视为无锁 */ }
  return null;
}
function isMetaWriteExempt(relPath) {
  const raw = String(relPath || '');
  if (!raw || raw.startsWith('[')) return false;
  // ★ TRAVERSAL-1：含上跳段 ⇒ 不认定记忆豁免（防 `.codebuddy/memory/../../temp/…` 跳板）
  if (hasTraversal(raw)) return false;
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  // ★ GATE-5（2026-09-23）：外置项目记忆（绝对路径，带盘符 / 用户目录前缀）—— 与阶段无关
  if (META_WRITE_EXEMPT_RE.some((re) => re.test(p))) return true;
  return META_WRITE_EXEMPT_PATHS.some((x) => p.startsWith(x) || p.includes('/' + x));
}

// ─────────────────────────────────────────────────────────────────────────
// ★ MAINT-3 P-5（2026-09-22 用户批准）：MEMORY.md 写入侧配额守卫
//   背景：`{IDE}/memory/` 在 META_WRITE_EXEMPT_PATHS ⇒ 零写入约束 ⇒ 三次逼近/越限
//   （2026-09-14 截断丢尾 151 行 / 09-17 余量 4.5% / 09-22 距 WARN 线 88 码元）全靠人工发现。
//   规则：写 MEMORY.md 前估算「写后 UTF-16 码元」—— > LIMIT 拦一次；> WARN 仅 stderr 告警。
//   语义：fail-open（估算失败 / 未知工具 ⇒ 放行 + MEMORY_QUOTA_SKIP 留痕）；
//         逃生口天然优先（上游已放行）；开关 MEMORY_QUOTA_GUARD=0。
// ─────────────────────────────────────────────────────────────────────────
const MEMORY_QUOTA_LIMIT = 8000;                  // IDE 注入阈值（超 ⇒ 从头部截断，尾部丢失）
const MEMORY_QUOTA_WARN = 7200;                   // 余量 < 10% 告警线
const MEMORY_QUOTA_RE = /(?:^|\/)(?:\.codebuddy|\.claude|\.cursor|\.codex)\/memory\/MEMORY\.md$/i;

/** UTF-16 码元数（= JS String.length；IDE 截断判定口径）
 *  ★ 禁 `Buffer.byteLength(s,'utf16-le')` —— Node 不认该别名（抛 Unknown encoding），
 *    且会被守卫 catch 吞成 fail-open ⇒ 静默失效（2026-09-22 回归 P5-A 实测根因）。 */
function memoryCodeUnits(s) {
  return String(s).length;
}

/** 估算写入后 MEMORY.md 码元；无法估算（读失败 / 非唯一匹配 / 未知工具）⇒ null */
function estimateMemoryUnits(fsPath, tool, hi) {
  const ti = (hi && hi.tool_input) || {};
  const t = String(tool || '');
  if (t === 'write_to_file' || t === 'Write') {
    if (typeof ti.content !== 'string') return null;
    return memoryCodeUnits(ti.content);           // 全量写入 ⇒ 无需读旧文件
  }
  if (t === 'replace_in_file' || t === 'Edit') {
    const rel = String(fsPath || '').replace(/\\/g, '/');
    const abs = rel.startsWith(PROJECT_DIR_NORM) ? rel : join(PROJECT_DIR, rel);
    let cur;
    try {
      cur = readFileSync(abs, 'utf-8');
    } catch {
      return null;
    }
    const oldStr = typeof ti.old_str === 'string' ? ti.old_str : ti.old_string;
    const newStr = typeof ti.new_str === 'string' ? ti.new_str : ti.new_string;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string' || !oldStr) return null;
    let used = oldStr;
    let first = cur.indexOf(oldStr);
    if (first < 0) {
      const crlf = oldStr.replace(/\r?\n/g, '\r\n');       // 行尾形态兼容（\n ⇄ \r\n）
      if (crlf !== oldStr && cur.indexOf(crlf) >= 0) { used = crlf; first = cur.indexOf(crlf); }
    }
    if (first < 0) return null;
    if (cur.indexOf(used, first + used.length) >= 0) return null;      // 非唯一 ⇒ 无法估算
    return memoryCodeUnits(cur.slice(0, first) + newStr + cur.slice(first + used.length));
  }
  return null;
}

function memoryQuotaGuard(fsPath, tool, hi) {
  try {
    if (String(process.env.MEMORY_QUOTA_GUARD || '') === '0') return;
    const p = String(fsPath || '').replace(/\\/g, '/');
    if (!MEMORY_QUOTA_RE.test(p)) return;
    const n = estimateMemoryUnits(fsPath, tool, hi);
    if (n === null) {
      audit('MEMORY_QUOTA_SKIP', p);
      return;
    }
    if (n > MEMORY_QUOTA_LIMIT) {
      audit('MEMORY_QUOTA_BLOCK', p + ' ' + n + '/' + MEMORY_QUOTA_LIMIT);
      block(
        'MEMORY.md 写入后估算超配额（' + n + ' / ' + MEMORY_QUOTA_LIMIT + ' 码元）—— 超限会被 IDE 截断并丢弃尾部内容。',
        '目标: ' + p,
        '（估算含 ±行尾差异；可用 memory_quota.py 复核实际值）',
        '',
        '处理方式:',
        '  python .codebuddy/skills/iteration-workflow/scripts/memory_quota.py',
        '  压缩措辞，或把细节外移到速查分片（PIVAS-速查-env/backend/frontend/spec.md）',
        '',
        '确需原样写入：由用户开闸后重试。'
      );
    }
    if (n > MEMORY_QUOTA_WARN) {
      audit('MEMORY_QUOTA_WARN', p + ' ' + n + '/' + MEMORY_QUOTA_LIMIT);
      process.stderr.write('[gate] WARNING: MEMORY.md 写入后估算 ' + n + ' 码元（>'
        + MEMORY_QUOTA_WARN + '，余量 <10%）-- 建议先瘦身（memory_quota.py）。\n');
    }
  } catch (e) { /* fail-open：守卫自身异常不得阻断写入（★ 必须留痕，防静默失效） */
    audit('MEMORY_QUOTA_ERR', String((e && e.message) || e).slice(0, 140));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ★ RESUME-3 批次 3 路线 I（2026-10-01）：phaseAdvanceGuard（阶段推进留痕观测 · fail-open）
//   背景：§三-B 提示词门禁被穿透实锤——2026-10-01 01:40 的 04→05 由离机指令「完成后关机」
//   连续收口（state.yaml:39），phase_history[04] 无 review_gate、无确认字段，事后无法审计。
//   语义：检测 {ID}.state.yaml 写入是否变更 current_phase；变更而缺合法 phase_confirm 留痕
//   ⇒ **放行但推 QQ 告警**（决策表 S8 = ALLOW+NOTIFY）；强制化（BLOCK）另行拍板（路线 I → G1）。
//   挂载：concLockCheck 之后、第 1 关 ALWAYS_ALLOW 之前——state.yaml 命中 ALWAYS_ALLOW 段，
//   挂在第 3 关之后是**死代码**（评审片 1/2 实证 :833-836 早退）。
//   手法：现值读 RUNTIME_DIR（活跃侧）；新值 write_to_file=ti.content、replace_in_file=
//   old_str+new_str 模拟替换（CRLF 兼容同 memoryQuotaGuard；模拟失败 ⇒ audit 留痕放行，不误伤）。
//   已知残留绕过面：04 期 execute_command 直写 state.yaml（E2_CMD_04_PASS 留痕放行）。
const PHASE_STATE_FILE_RE = /\/skills\/iteration-workflow\/runtime\/[^/]+\.state\.yaml$/i;

function extractPhase(text) {
  const m = String(text || '').match(/^current_phase:\s*"?([^"\r\n]+?)"?\s*$/m);
  return m ? m[1] : null;
}

function extractPhaseConfirm(text) {
  const t = String(text || '');
  if (!/^\s*phase_confirm\s*:/m.test(t)) return null;
  const pick = (k) => {
    const m = t.match(new RegExp('^\\s*' + k + ':\\s*"?([^"\\r\\n]+?)"?\\s*$', 'm'));
    return m ? m[1].trim() : '';
  };
  return { from: pick('from'), to: pick('to'), by: pick('by'), quote: pick('quote') };
}

function notifyPhaseGuard(reason, fromPhase, toPhase) {
  try {
    // 测试沙箱 / 显式关闭 ⇒ 不真发 QQ（同 notifySilentReason 口径），仅 audit 留痕可断言
    if (process.env.GATE_TEST_RUNTIME_DIR || process.env.QQ_NOTIFY === '0' || process.env.QQ_NOTIFY === 'off') {
      audit('PHASE_GUARD_NOTIFY_SKIP', 'silent');
      return;
    }
    const enqueuePath = join(PROJECT_DIR, 'tools/qqbot/notify-enqueue.js');
    const notifyPath = join(PROJECT_DIR, 'tools/qqbot/notify.qqbot.js');
    const notifyTarget = existsSync(enqueuePath) ? enqueuePath : notifyPath;
    if (!existsSync(notifyTarget)) { audit('PHASE_GUARD_NOTIFY_SKIP', 'no-notify-script'); return; }
    let iterLabel = '-';
    try { const c = readIterContext(); if (c && c.id) iterLabel = c.id + '（阶段 ' + (c.phase || '?') + '）'; } catch { /* 忽略 */ }
    const payload = {
      rows: [
        ['事件', '阶段推进留痕告警（观测态 · 未拦截）'],
        ['推进', (fromPhase || '?') + ' → ' + (toPhase || '(current_phase 行被删除)')],
        ['原因', reason],
        ['迭代', iterLabel],
        ['依据', 'gate-protocol.md §三-B「确认留痕」/ 决策表 S8'],
      ],
      next: '推进已放行（观测态 fail-open）。补留痕 = state.yaml 增 phase_confirm{from,to,by,at[,quote]}（by=ide 须附 quote）。强制化另行拍板（RESUME-3 批次 3 G1）。',
      prompt: '阶段推进留痕告警：' + reason,
      kind: 'gate',
    };
    const child = spawn(process.execPath, [notifyTarget, '--json', JSON.stringify(payload)], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    audit('PHASE_GUARD_NOTIFY', reason + ' ' + fromPhase + '->' + toPhase);
  } catch (e) {
    audit('PHASE_GUARD_ERR', String((e && e.message) || e).slice(0, 140));
  }
}

async function phaseAdvanceGuard(relPath) {
  try {
    if (String(process.env.PHASE_ADVANCE_GUARD || '') === '0') return;
    const norm = '/' + String(relPath || '').replace(/\\/g, '/');
    if (!PHASE_STATE_FILE_RE.test(norm)) return;
    if (toolName === 'Delete' || toolName === 'delete_file' || toolName === 'delete_files') return;
    const ti = (typeof hookInput !== 'undefined' && hookInput && hookInput.tool_input) || {};
    const stateBase = relPath.replace(/\\/g, '/').split('/').pop();
    const stateAbs = join(RUNTIME_DIR, stateBase);
    let curText = null;
    try { curText = readFileSync(stateAbs, 'utf-8'); } catch { return; }   // 新建/无现值 ⇒ 观测态不评
    const oldPhase = extractPhase(curText);
    if (oldPhase === null) return;
    let newText = null;
    if (toolName === 'write_to_file' || toolName === 'Write') {
      newText = typeof ti.content === 'string' ? ti.content : null;
      if (newText === null) { audit('PHASE_GUARD_SKIP', relPath + ' (no-content)'); return; }
    } else if (toolName === 'replace_in_file' || toolName === 'Edit') {
      const edits = Array.isArray(ti.edits) && ti.edits.length
        ? ti.edits
        : [{ old_str: typeof ti.old_str === 'string' ? ti.old_str : ti.old_string,
             new_str: typeof ti.new_str === 'string' ? ti.new_str : ti.new_string }];
      let sim = curText, failed = false;
      for (const ed of edits) {
        const o = typeof ed.old_str === 'string' ? ed.old_str : ed.old_string;
        const n = typeof ed.new_str === 'string' ? ed.new_str : ed.new_string;
        if (typeof o !== 'string' || typeof n !== 'string' || !o) { failed = true; break; }
        let used = o, first = sim.indexOf(o);
        if (first < 0) { const crlf = o.replace(/\r?\n/g, '\r\n'); if (crlf !== o && sim.indexOf(crlf) >= 0) { used = crlf; first = sim.indexOf(crlf); } }
        if (first < 0) { failed = true; break; }
        sim = sim.slice(0, first) + n + sim.slice(first + used.length);
      }
      if (failed) { audit('PHASE_GUARD_SKIP', relPath + ' (sim-fail)'); return; }
      newText = sim;
    } else {
      return;   // 其余写工具不判（命令通道 = 已知残留绕过面，见决策表 S8 备注）
    }
    const newPhase = extractPhase(newText);
    if (newPhase === null) {
      notifyPhaseGuard('写入内容不含 current_phase 行（结构性破坏风险）', oldPhase, null);
      return;
    }
    if (String(newPhase) === String(oldPhase)) return;   // 未变更
    const c = extractPhaseConfirm(newText);
    const okConfirm = !!c
      && String(c.from) === String(oldPhase)
      && String(c.to) === String(newPhase)
      && ['qq#', 'ide', 'handoff', 'bypass'].some((k) => String(c.by || '').indexOf(k) === 0)
      && (String(c.by) !== 'ide' || String(c.quote || '').length > 0);
    if (okConfirm) {
      audit('PHASE_ADVANCE_CONFIRMED', oldPhase + '->' + newPhase + ' by=' + c.by);
      return;
    }
    audit('PHASE_GUARD_MISS', oldPhase + '->' + newPhase + ' confirm=' + (c ? JSON.stringify(c).slice(0, 120) : 'none'));
    notifyPhaseGuard('current_phase 变更但无合法 phase_confirm 留痕', oldPhase, newPhase);
  } catch (e) {
    audit('PHASE_GUARD_ERR', String((e && e.message) || e).slice(0, 140));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ★ CONC-1（2026-09-20 用户批准）多会话写者互斥（软锁 · fail-open）
//   背景：同一工作区可同时打开多个 IDE 会话（2026-09-20 实证：5 秒内观测到
//   两个不同 session_id 同时调用本 hook）。追加式编辑冲突只会「old_str 失配」，
//   但**整文件重写（Write）会静默吞掉对方改动**（2026-08-19 有真实案底）。
//   设计：写类调用按 (session_id, 文件) 登记声明；他会话在 TTL 内命中 ⇒ **拦一次**
//        并提示先重读；同 (sid, 文件) 在 GRACE 内再试 ⇒ 放行（避免对方崩溃后死锁）。
//   关闭：env `CONC_LOCK=0|off` 或标记文件 `hooks/.conc-off`。
//   ★ 与阶段门禁**正交**：本关 fail-open —— 任何自身异常都不得阻断写入。
//   声明文件：$RUNTIME_DIR/write-claims.jsonl（append-only，读取仅取末 N 行）
// ─────────────────────────────────────────────────────────────────────────
const CONC_TTL_MS = 10 * 60 * 1000;      // 声明有效期
const CONC_GRACE_MS = 5 * 60 * 1000;     // 「拦一次」窗口：同 (sid,路径) 重试即放行
const CONC_MAX_LINES = 800;              // 读取上限（防文件无限增长拖慢 hook）
const CONC_WRITE_TOOLS = ['Write', 'Edit', 'write_to_file', 'replace_in_file'];
const CONC_OFF_MARKERS = ['.codebuddy/hooks/.conc-off', '.claude/hooks/.conc-off'];
/** 排除「追加式 / 构建产物 / 保护自身存储」——其余一律纳入保护 */
const CONC_EXCLUDE_RES = [
  /(?:^|\/)runtime\//,
  /(?:^|\/)\.codebuddy\/memory\//,
  /(?:^|\/)\.claude\/memory\//,
  // ★ E-4（2026-09-30-001）：补齐 .cursor/.codex（与 META_WRITE_EXEMPT_PATHS 对齐）
  /(?:^|\/)\.cursor\/memory\//,
  /(?:^|\/)\.codex\/memory\//,
  // ★ E-4：外置「项目记忆」—— 与 META_WRITE_EXEMPT_RE 逐字一致（含 i；concInScope 不做小写归一）
  /(?:^|\/)\.(?:codebuddy|claude|cursor|codex)\/projects\/[^/]+\/memory\//i,
  /(?:^|\/)\.codebuddy\/temp\//,
  /(?:^|\/)(?:node_modules|dist|obj|bin|\.vs)\//,
  /\.(?:log|tmp|bak)$/i,
];
function concClaimsPath() { return join(RUNTIME_DIR, 'write-claims.jsonl'); }
/** 会话标识：stdin.session_id ＞ env ＞ transcript_path 中的 convId 段（三源兜底） */
function resolveSessionId(hi) {
  try {
    if (hi && hi.session_id) return String(hi.session_id);
    if (process.env.CODEBUDDY_SESSION_ID) return String(process.env.CODEBUDDY_SESSION_ID);
    if (process.env.CLAUDE_SESSION_ID) return String(process.env.CLAUDE_SESSION_ID);
    const tp = hi && hi.transcript_path ? String(hi.transcript_path).replace(/\\/g, '/') : '';
    const m = tp.match(/\/([0-9a-f]{16,})\/[^/]*$/i);
    if (m) return m[1];
  } catch (e) { /* 取不到 ⇒ 调用方 fail-open */ }
  return '';
}
function concInScope(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.startsWith('[')) return false;
  return !CONC_EXCLUDE_RES.some((re) => re.test(p));
}
/** 读声明文件 → { w: Map<路径,{sid,ts}>, b: Map<"sid|路径",ts> } */
function concReadClaims() {
  const w = new Map();
  const b = new Map();
  try {
    const lines = readFileSync(concClaimsPath(), 'utf-8').split(/\r?\n/).filter(Boolean).slice(-CONC_MAX_LINES);
    for (const ln of lines) {
      let r = null;
      try { r = JSON.parse(ln); } catch (e) { continue; }
      if (!r || !r.p || !r.s) continue;
      if (r.k === 'b') b.set(r.s + '|' + r.p, r.t || 0);
      else w.set(r.p, { sid: r.s, ts: r.t || 0 });
    }
  } catch (e) { /* 无文件 / 读失败 ⇒ 视为无声明 */ }
  return { w, b };
}
function concAppend(rec) {
  try {
    mkdirSync(dirname(concClaimsPath()), { recursive: true });
    appendFileSync(concClaimsPath(), JSON.stringify(rec) + '\n', 'utf-8');
  } catch (e) { /* 登记失败不影响放行 */ }
}
/**
 * 写前检查：他会话在 TTL 内写过同一文件 ⇒ 拦一次并要求重读；
 * 同会话 / 声明过期 / 本会话已被告知过（GRACE 内重试）⇒ 放行。
 */
async function concLockCheck(rel, tool) {
  try {
    if (CONC_WRITE_TOOLS.indexOf(String(tool || '')) < 0) return;
    if (process.env.CONC_LOCK === '0' || process.env.CONC_LOCK === 'off') return;
    for (const m of CONC_OFF_MARKERS) if (existsSync(join(PROJECT_DIR, m))) return;
    const p = String(rel || '').replace(/\\/g, '/');
    if (!concInScope(p)) return;
    const sid = resolveSessionId(hookInput);
    if (!sid) { audit('CONC_NO_SID', p); return; }
    const { w, b } = concReadClaims();
    const prev = w.get(p);
    const stale = !prev || (Date.now() - prev.ts) > CONC_TTL_MS;
    const mine = !!prev && prev.sid === sid;
    if (!stale && !mine) {
      if (Date.now() - (b.get(sid + '|' + p) || 0) < CONC_GRACE_MS) {
        audit('CONC_ALLOW_RETRY', sid.slice(0, 8) + ' ' + p);         // 本会话已被告知过 ⇒ 放行
      } else {
        concAppend({ k: 'b', t: Date.now(), s: sid, p, tool: String(tool || '') });
        audit('CONC_BLOCK', String(sid).slice(0, 8) + ' <- ' + String(prev.sid).slice(0, 8) + ' ' + p);
        block(
          '该文件可能正被另一个会话编辑（多会话并发写保护）',
          '目标: ' + p,
          '最近写入: ' + Math.round((Date.now() - prev.ts) / 1000) + 's 前 · 会话 ' + String(prev.sid).slice(0, 8),
          '',
          '请先 read_file 重读该文件（确认对方改动是否已并入）后再写；',
          '★ 直接重试一次即放行（本保护只在首次提示时拦截）。',
          '关闭本保护: CONC_LOCK=0 或创建 hooks/.conc-off'
        );
      }
    }
    // 放行 ⇒ 登记/续期本次声明（append-only，读取取最新；同一记录流无需额外状态）
    concAppend({ k: 'w', t: Date.now(), s: sid, p, tool: String(tool || '') });
  } catch (e) { /* fail-open：保护自身异常不得阻断写入 */ }
}

/**
 * 需要检查的工具名。
 * ★ FIX-8（2026-09-14）：CodeBuddy IDE 在调用 hook 前会经 normalizeToolName() 把内部工具名
 * 映射为 Claude Code 风格名（IDE 内 TOOL_NAME_CRAFT_TO_CLI），实际收到的是：
 *   write_to_file → Write ／ replace_in_file → Edit ／ delete_file → Delete ／ execute_command → Bash
 * 旧列表只写内部名 ⇒ delete_file / execute_command 从未命中，删除与终端命令实际不受门禁约束。
 * 现两种命名都收，兼容其他宿主与未规范化场景。
 */
const WATCHED_TOOLS = [
  // CodeBuddy（IDE 实际传入的规范化名）
  'Write', 'Edit', 'Delete', 'Bash',
  // CodeBuddy 内部名 + Claude Code 原生名（兼容/兜底）
  'write_to_file', 'replace_in_file', 'delete_file', 'delete_files', 'execute_command',
];

/** Shell 命令：危险模式（触发门禁）。
 *  ★ GATE-A②（2026-10-01）：写/删/移动类**动词**已移出本表，改由 hasWriteDeleteAtCommandPos()
 *    做「命令位」判定 + stripQuotedText() 剔除成对引号内文本 —— 消除只读查询误拦
 *    （实证：`Select-String -Pattern 'move'`、`git log --grep=move` 被全文词匹配判危险）。
 *    依据：SSOT §一 FIX-25 订正口径「只读命令在任何阶段都放行」，本改动即实现回归该口径。
 *  本表保留「命令/工具级」模式（重定向 / git 变更 / svn 变更 / 打包压缩）。 */
const DANGEROUS_CMD_PATTERNS = [
  // ── 文件写入/重定向（★ GATE-A②：判定前先剔引号内文本，见 stripQuotedText） ──
  /[^=>-]>\s*\S/,                                                  // 输出重定向（排除 >> / -> / =>）
  />>\s*\S/,                                                       // 追加重定向
  // ── Git 变更类 ──
  /\bgit\s+(?:commit|push|reset|rebase|merge|cherry-pick|stash)\b/i,
  // ── SVN 变更类 ──
  /\bsvn\s+(?:commit|ci|delete|rm|move|mv|copy|cp|import)\b/i,
  // ── 打包/压缩（可能覆盖文件） ──
  /\b(?:Compress-Archive|Expand-Archive)\b/i,
];

/**
 * ★ GATE-A②（2026-10-01）：写/删/移动类动词 —— 仅在**命令位**判定。
 * 命令位 = 段首（wrapper 前缀剥离后）/ 语句分隔符后 / `{}` `()` 后 / 带空格的赋值等号后。
 * 依据：`Select-String -Pattern 'move'`、`git log --grep=move` 中的 move 是**数据**非命令；
 *       原全文 `\b` 词匹配把两者一并判危险 ⇒ 只读查询被拦（2026-10-01 实测 26 条只读样本拦 10 条）。
 * 补口（GATE-A2 · 2026-10-01 同日）：原 `$x=Remove-Item y`（`=` 两侧无空格）会漏 ——
 *       子句首整坨 `$x=Remove-Item` 不匹配 `^remove-item`；现由 PS_ASSIGN_PREFIX_RE 先剥
 *       PowerShell 变量赋值前缀再判（只剥 `$var=`，不影响 `--grep=move` 等参数值）。
 */
const WRITE_DELETE_VERB_AT_POS_RE =
  /^(?:remove-item(?:property)?|move-item|copy-item|rename-item|new-item(?:property)?|set-item(?:property)?|set-content|add-content|clear-content|out-file|tee-object|compress-archive|expand-archive|erase|rmdir|delete_files|delete|unlink|truncate|del|rm|rd|ri|rni|mi|mv|move|ren|rename|ni|md|mkdir|copy)(?:\.exe)?(?=\s|$|[;|&,)}])/i;

/**
 * ★ GATE-A2（2026-10-01）：PowerShell 变量赋值前缀（`$x=` / `$env:NAME=` / `$a[0]=` / `$o.Prop=`）。
 * 为什么需要：切子句用 `\s=\s`（等号两侧须有空白）⇒ `$x=Remove-Item y` 不被切分，
 *   子句首整坨 `$x=Remove-Item` 使 `^remove-item` 永不命中 ⇒ **零成本绕过**
 *   （2026-10-01 探针实测：3 条取证样本全 allow；带空格形态对照 = BLOCK）。
 * 边界：**只剥 `$` 开头的变量**（PowerShell 变量必带 `$`）—— 不碰 `FOO=bar`（bash 风格前缀）、
 *   不碰 `--grep=move`（参数值）⇒ 不引入新的误判/漏放面。
 */
const PS_ASSIGN_PREFIX_RE = /^\$[\w:.]+(?:\[[^\]]*\])?\s*=\s*/;

/** 段内是否存在「命令位」的写/删/移动动词（切子句 → 剥 wrapper 前缀 / 残留引号 / PS 赋值前缀） */
function hasWriteDeleteAtCommandPos(s) {
  for (const clause of String(s || '').split(/[;|&\n]|[(){}]|\s=\s/)) {
    const t = clause.trim()
      .replace(CMD_WRAPPER_PREFIX_RE, ' ')
      .replace(/^[`"']+/, ' ')
      .trim()
      .replace(PS_ASSIGN_PREFIX_RE, '')      // ★ GATE-A2：剥 PowerShell 变量赋值前缀
      .trim();
    if (t && WRITE_DELETE_VERB_AT_POS_RE.test(t)) return true;
  }
  return false;
}

/**
 * ★ GATE-A②（2026-10-01）：引号内文本 = 数据，不参与危险判定。
 * 依据：`Select-String -Pattern 'a > b'`（模式串里的比较符）、`echo "Remove-Item x"`（文案）——
 *       引号内是**数据**，原判定将其当命令。保守边界：仅剔除**成对**引号；
 *       跨段未闭合的引号原样保留 ⇒ 仍走 fail-closed（例：`powershell -Command "del x` ⇒ 不剥壳 ⇒ 拦）。
 */
function stripQuotedText(s) {
  return String(s || '')
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ');
}

/**
 * ★ GATE-A①（2026-10-01）：shell 包装剥壳 —— `powershell|pwsh … -Command|-c "…"` 与 `cmd /c "…"`。
 * 背景：宿主本身就在 PowerShell 中执行命令，显式包装不增加能力，却让只读查询
 *       （实证 2026-10-01：`powershell -NoProfile -Command "Get-Process …"` / `Get-ChildItem …`）
 *       被判「解释器内联 = 任意代码执行」而整条拦截（01-03/none/05-07 一律 block）。
 * 语义：**仅当整条命令就是一个可完整解析的包装**时才剥壳（最多 3 层），内层交回原判定链；
 *       解析不出即返回 null ⇒ 保持原逻辑（fail-closed）：引号未闭合 / 包装后有其它语句 /
 *       `-EncodedCommand`（无法静态解析）/ 非白名单包装（`bash -c`、`node -e`、`python -c` 不剥）。
 */
function unwrapWholeShellCommand(cmd) {
  const raw = String(cmd || '');
  if (!raw.trim()) return null;

  // ① cmd /c "…"（cmd 包装内层可为任意命令）
  const cmdHead = raw.match(/^\s*cmd(?:\.exe)?\s+\/[a-zA-Z]\s+/i);
  if (cmdHead) return unwrapQuotedPayload(raw.slice(cmdHead[0].length));

  // ② powershell|pwsh … -Command|-c "…"
  const psHead = raw.match(/^\s*(?:powershell|pwsh)(?:\.exe)?\s+/i);
  if (!psHead) return null;
  const rest = raw.slice(psHead[0].length);
  const flag = rest.match(/(?:^|\s)(?:-command|-c)(?=\s|$|["'])/i);
  if (!flag) return null;
  return unwrapQuotedPayload(rest.slice(flag.index + flag[0].length));
}

/** 剥掉整体包裹的一对引号（无引号则原样返回；解析存疑 ⇒ null = 放弃剥壳） */
function unwrapQuotedPayload(text) {
  const p = String(text || '').trim();
  if (!p) return null;
  const q = p[0];
  if (q === '"' || q === "'") {
    const last = p.lastIndexOf(q);
    if (last <= 0) return null;                          // 引号未闭合
    if (p.slice(last + 1).trim() !== '') return null;    // 闭合引号后仍有内容 ⇒ 结构不完整
    const inner = p.slice(1, last).trim();
    return inner || null;
  }
  return p;
}

/** Shell 命令：纯读类模式（直接放行，不检查门禁） */
const SAFE_CMD_PATTERNS = [
  /^(?:echo|cat|type|dir|ls|pwd|whoami|hostname|date|time|ver|uname|printenv|env)\b/i,
  /^(?:where|which|find|grep|Select-String|sls)\b/i,              // 文本搜索
  /^(?:head|tail|sort|uniq|wc)\b/i,                               // 流处理
  /^(?:Get-Content|gc|Get-ChildItem|gci|Get-Location|gl)\b/i,    // PowerShell 只读
  /^(?:Get-Process|gps|Get-Service|gsv)\b/i,                      // 进程/服务查看
  /^(?:git\s+(?:status|log|diff|show|branch|remote|stash\s+list)|svn\s+(?:status|log|info|list|ls|cat|diff|update|up|checkout|co|export))\b/i,
  /^(?:npm|yarn|pnpm|dotnet|msbuild|node|python|ruby|java)\b/i,  // 构建/运行工具
  /^(?:code\s+--|code\s+-r\s)/i,                                   // VS Code 控制
  /^(?:cd|chdir|pushd|popd|Set-Location|sl)\b/i,                  // 目录切换
];

// ── 逃生口 ────────────────────────────────────────────
// ★ 回归测试专用（FIX-10 补）：GATE_TEST_DISABLE_BYPASS=1 时忽略逃口 —— 只会更严格，
//   不构成绕过通道；用于「逃口标记存在时仍能跑回归」（否则逃口会把所有用例短路放行）。
const BYPASS_DISABLED_FOR_TEST = process.env.GATE_TEST_DISABLE_BYPASS === '1';
if (!BYPASS_DISABLED_FOR_TEST
    && (process.env.GATE_BYPASS === '1' || process.env.GATE_BYPASS === 'true')) {
  auditBypass('GATE_BYPASS_env');
  process.exit(0);
}
// 检查所有主流 IDE 的 gate-bypass 标记文件
const GATE_BYPASS_PATHS = [
  join(PROJECT_DIR, '.codebuddy/hooks/.gate-bypass'),
  join(PROJECT_DIR, '.claude/hooks/.gate-bypass'),
  join(PROJECT_DIR, '.cursor/hooks/.gate-bypass'),
  join(PROJECT_DIR, '.codex/hooks/.gate-bypass'),
];
/** ★ FIX-12①（2026-09-18）时效逃生口：标记内容可写 `ttlMinutes=N`（按文件 mtime 起算）
 *  或 `expire=ISO8601`；过期即视为不存在（记 BYPASS_EXPIRED）—— 避免“忘了删 ⇒ 永久放行”。
 *  空标记（0 字节，历史惯用）保持“永久有效”以兼容既有用法。 */
function bypassFileState() {
  for (const p of GATE_BYPASS_PATHS) {
    if (!existsSync(p)) continue;
    let raw = '';
    try { raw = String(readFileSync(p, 'utf-8') || '').trim(); } catch { /* 读失败按空处理 */ }
    if (!raw) return { path: p, active: true, until: null, mode: 'forever(empty)' };
    let until = null;
    try {
      const exp = raw.match(/expire\s*[=:]\s*([0-9T:+\-.Zz ]{8,})/i);
      const ttl = raw.match(/ttl\s*(?:minutes?)?\s*[=:]\s*(\d+)/i);
      if (exp) until = Date.parse(exp[1].trim().replace(' ', 'T'));
      else if (ttl) until = statSync(p).mtimeMs + Number(ttl[1]) * 60000;
    } catch { until = null; }
    if (until && Date.now() > until) return { path: p, active: false, until, mode: 'expired' };
    return { path: p, active: true, until, mode: until ? 'ttl' : 'forever' };
  }
  return null;
}
// ── ★ FIX-21：会话结束（Stop）门禁判定入口 ──────────────────────
// 必须**早于逃生口块**（逃生口激活时会直接 process.exit(0) 放行，放后面就永远执行不到）。
// Stop 钩子入参不含工具调用信息，本分支只判定「本次会话是否真被门禁阻断」并决定是否通知。
if (process.argv.includes('--stop-check')) {
  await runStopCheck();
  process.exit(0);
}

if (!BYPASS_DISABLED_FOR_TEST) {
  const bp = bypassFileState();
  if (bp && bp.active) {
    auditBypass('.gate-bypass_file ' + bp.mode + (bp.until ? ' until=' + new Date(bp.until).toISOString() : ''));
    // ★ FIX-12① 放行可见（b）：每次工具调用都在 stderr 提示“当前处于开闸态”
    process.stderr.write('[gate] WARNING: bypass marker ACTIVE: ' + bp.path
      + (bp.until ? ' (until ' + new Date(bp.until).toISOString() + ')' : ' (forever, empty marker)')
      + ' -- delete it right after meta maintenance.' + '\n');
    process.exit(0);
  }
  if (bp && !bp.active) {
    audit('BYPASS_EXPIRED', bp.path + ' mode=' + bp.mode);
    // GATE-TRV-DEL（2026-10-02-002 收敛案 S-A · QQ#30 用户确认）：过期标记由门禁自清理。
    // 删除 = 关闸（fail-safe 方向），零新增放行面；根治「会话删不掉过期标记」与
    // 「rebuild it to open」矛盾话术（原 L811 诱导重建，而重建在 05/06 仍被阶段层拦）。
    try {
      unlinkSync(bp.path);
      process.stderr.write('[gate] NOTE: bypass marker EXPIRED -> auto-removed by gate (reopen via escape hatch by user if needed).' + '\n');
    } catch {
      process.stderr.write('[gate] NOTE: bypass marker EXPIRED -> treated as inactive (auto-remove failed; ask user to delete it).' + '\n');
    }
  }
}

// ── 读取 stdin ────────────────────────────────────────
// ── FIX-7：复合命令拆分 + 解释器内联执行判定 ─────────────
// 旧实现只对「整条命令」做 SAFE_CMD_PATTERNS 前缀匹配（^ 锚定行首），
// 首段为 cd / echo / dir 等安全前缀时整条放行 ⇒ 后续危险动作可无声绕过。
/** 解释器内联执行 —— 等价任意代码执行，且绕过文件路径豁免判定，一律视为危险 */
const INTERPRETER_INLINE_PATTERNS = [
  /\b(?:node|nodejs|deno|bun)\s+(?:--?\w+\s+)*-e\b/i,
  /\b(?:python|python3|py)\s+(?:--?\w+\s+)*-c\b/i,
  /\b(?:ruby|perl|php)\s+(?:--?\w+\s+)*-e\b/i,
  /\b(?:powershell|pwsh)\b[^|;&]*(?:-c\b|-command\b|-encodedcommand\b)/i,
  /\b(?:bash|sh|zsh)\s+-c\b/i,
];

/** 按链式分隔符拆分复合命令（&& || ; & | 换行） */
function splitCommandChain(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||[;&|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ★ FIX-10：PowerShell 短别名（ni/md/mi/ri/rd/rni）只在「命令名位置」判定 ——
 * 避免只读命令里的 `.md` 文件名（`.` 提供词边界）被误判为 mkdir 而整段拦下。
 * 命令名位置 = 段首，允许 cmd /c、powershell -Command 等包装前缀。
 */
const CMD_WRAPPER_PREFIX_RE = /^(?:(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:\/[a-z]\s+|-\w+\s+)*)/i;
const SHORT_ALIAS_AT_CMD_POS_RE = /^(?:ni|md|mi|ri|rd|rni)(?=\s|$)/i;

// ── ★ E-2（迭代 2026-09-30-001）：git 变更类动词的**词元化**判定 ──
// 病根：DANGEROUS_CMD_PATTERNS 的 git 行要求动词**紧跟** `git` ⇒ `git -C <dir> commit`
//       静默放行（2026-09-29 回流提交实命中）。评审实测 ≥8 类前置全局选项可继续挡住动词
//       ⇒ 扫描式跳过全量前置选项 + 未知选项结构兜底 fail-closed（宁拦只读，不漏变更）。
const GIT_BOOL_OPTS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects',
  '--no-lazy-fetch', '--no-optional-locks', '--no-advice',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--html-path', '--man-path', '--info-path', '-v', '--version', '-h', '--help',
]);
const GIT_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path',
]);
const GIT_CHANGE_VERBS = new Set(['commit', 'push', 'reset', 'rebase', 'merge', 'cherry-pick', 'stash']);

/** 引号感知分词：`"a b"` / 'a b' 视为单 token（含空格的选项值） */
function tokenizeQuoteAware(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) {
    out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return out;
}

/**
 * 段内是否为 git 变更类命令（词元判定）。hit=true 才危险。
 * suspect=true = 命中未知全局选项 ⇒ 结构兜底 fail-closed（调用方可留痕 AUDIT_SUSPECT）。
 */
function gitChangeVerb(seg) {
  const s = String(seg || '').replace(CMD_WRAPPER_PREFIX_RE, ' ').trim();
  const tokens = tokenizeQuoteAware(s);
  const gi = tokens.findIndex((t) => /^git(?:\.exe)?$/i.test(t));
  if (gi < 0) return { hit: false };
  let i = gi + 1;
  let suspect = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') { i += 1; break; }                                        // 选项终止符：其后首词元即命令
    if (!t.startsWith('-')) break;
    const eqName = t.match(/^(--[a-z][a-z-]*)=/i);
    if (eqName && GIT_VALUE_OPTS.has(eqName[1].toLowerCase())) { i += 1; continue; }   // --opt=value
    if (GIT_VALUE_OPTS.has(t)) {
      const nxt = tokens[i + 1];
      // 取值类吞下一 token；`--exec-path` 无值形态不得吞命令词（评审 M1）
      if (t === '--exec-path' && (!nxt || !/[\\/]/.test(nxt))) { i += 1; continue; }
      i += 2; continue;
    }
    if (/^-C.+/.test(t)) { i += 1; continue; }                                 // 粘连 -C<path>
    if (GIT_BOOL_OPTS.has(t)) { i += 1; continue; }
    suspect = true; i += 1; continue;                                          // 未知选项 ⇒ 结构兜底
  }
  const verb = String(tokens[i] || '').toLowerCase();
  if (suspect) return { hit: true, verb, suspect: true };                      // fail-closed
  if (!GIT_CHANGE_VERBS.has(verb)) return { hit: false, verb };
  if (verb === 'stash' && String(tokens[i + 1] || '').toLowerCase() === 'list') return { hit: false, verb: 'stash list' };
  return { hit: true, verb };
}

/** 任意文本（含 `[CMD]` 伪路径 / 多段拼接）内是否含 git 变更类命令；容忍 80 字符截断（决策侧复用） */
function textHasGitChange(text) {
  const segs = String(text || '').replace(/\[CMD\]\s*/gi, ' ').split(/[\n;]+| {2,}/);
  return segs.some((seg) => gitChangeVerb(seg).hit);
}

/**
 * 单段危险判定 → 命中原因（null = 安全）。
 * ★ GATE-A③（2026-10-01）：由「返回布尔」改为「返回原因」—— 拦截话术与审计
 *   得以显示**实际命中规则**（原实现把只读命令也提示成「仅允许修改迭代产出目录」，误导排查）。
 * 判定链（顺序即优先级）：命令位短别名 → 命令位写删动词 → 危险模式（引号感知）
 *   → 解释器内联 → git 变更词元。
 */
function dangerousSegmentReason(seg) {
  const raw = String(seg || '').trim();
  if (!raw) return null;
  const s = stripQuotedText(raw);                              // ★ GATE-A②：引号内 = 数据
  const head = s.replace(CMD_WRAPPER_PREFIX_RE, ' ').trim();
  if (SHORT_ALIAS_AT_CMD_POS_RE.test(head)) {
    return { rule: 'SHORT-ALIAS@CMD-POS', detail: head.slice(0, 80) };
  }
  if (hasWriteDeleteAtCommandPos(s)) {
    return { rule: 'WRITE/DELETE@CMD-POS', detail: s.slice(0, 80) };
  }
  if (DANGEROUS_CMD_PATTERNS.some((p) => p.test(s))) {
    return { rule: 'DANGEROUS-PATTERN', detail: s.slice(0, 80) };
  }
  if (INTERPRETER_INLINE_PATTERNS.some((p) => p.test(s))) {
    return { rule: 'INTERPRETER-INLINE', detail: s.slice(0, 80) };
  }
  if (gitChangeVerb(raw).hit) {
    return { rule: 'GIT-CHANGE', detail: raw.slice(0, 80) };
  }
  return null;
}

/** 布尔包装（兼容既有调用点） */
function isDangerousSegment(seg) {
  return dangerousSegmentReason(seg) !== null;
}

/**
 * ★ GAP-4/加固①（2026-09-16）：逃生口「自建」判定 —— 段内是否在**创建** .gate-bypass 标记。
 * 背景：`fsutil file createnew .codebuddy\hooks\.gate-bypass 0` 不命中任何危险模式
 *       （既有通道，A/B 落地即用），Agent 可据此自行开启逃生口 ⇒ 门禁被静默绕过。
 * 语义边界：只匹配「创建/写入」；「删除标记」不受此判定约束 —— 标记存在时上游逃生口检查
 *       已 exit(0) 放行，本判定根本不会被触达。
 * 与 DANGEROUS_CMD_PATTERNS 的区别：本判定**绝对拦截**（不经阶段门禁）⇒ 04 阶段同样拒绝。
 */
const BYPASS_CREATE_PATTERNS = [
  /\bfsutil\s+file\s+createnew\b[^\n]*\.gate-bypass/i,                        // fsutil 建文件（已知通道）
  /(?:^|\s)>{1,2}\s*[^\n]*\.gate-bypass/i,                                    // 重定向写入：> / >>
  /\b(?:copy|Copy-Item|xcopy|robocopy|tee|Tee-Object)\b[^\n]*\.gate-bypass/i,
  /\b(?:New-Item|ni|Set-Content|Add-Content|Out-File|touch)\b[^\n]*\.gate-bypass/i,
];
/**
 * ★ FIX-14（2026-09-18）：解释器 + 文件名的判定，由「整行提及即拦」收窄为「邻近出现**写入迹象**才拦」。
 * 两例实测假阳性：① 通知文案 `node notify.qqbot.js "…（.gate-bypass 已不在位）"` 被误拦（通知发不出）；
 *   ② 只读检查 `python …memory_quota.py` 与 `Test-Path …\.gate-bypass` 同处一行命令亦被误拦。
 * 语义：**提及 ≠ 创建** ⇒ 无写入迹象时仅记 `AUDIT_SUSPECT` 供回溯，不再阻断。
 */
const BYPASS_INTERP_RE = /\b(?:python|python3|py|node|nodejs|ruby|perl|php)\b/i;
const BYPASS_WRITE_HINT_RE = /(?:writeFileSync|appendFileSync|writeFile|\.write\s*\(|open\s*\([^)]*[\x27\x22]w|openSync|createWriteStream|WriteAllText|WriteAllBytes|copyFileSync|shutil\.|os\.remove|unlink|>{1,2}[^\n]*\.gate-bypass)/i;
function isBypassCreateCommand(cmd) {
  const s = String(cmd || '');
  if (!s) return false;
  if (BYPASS_CREATE_PATTERNS.some((p) => p.test(s))) return true;
  const i = s.indexOf('.gate-bypass');
  if (i >= 0 && BYPASS_INTERP_RE.test(s)) {
    const near = s.slice(Math.max(0, i - 140), i + 80);      // 邻近窗口（允许跨段）
    if (BYPASS_WRITE_HINT_RE.test(near)) return true;
    audit('AUDIT_SUSPECT', '[BYPASS-MENTION] ' + s.slice(0, 160));
  }
  return false;
}

// ★ FIX-21：写类工具「最终放行」也记一条 allow —— 用于判定「拦截后是否又成功写入」
//   （= 已开闸 / 换路径成功 ⇒ 会话并未被阻断）。非写类工具（读文件等）不记，避免误判为已放行。
let stdinIsTTY = false;
const input = await new Promise((resolve) => {
  let data = '';
  const timeout = setTimeout(() => resolve(data), 3000);
  process.stdin.setEncoding('utf-8');
  // ★ FIX-14①（2026-09-17）：宿主可能带 UTF-8 BOM（\uFEFF）送入 stdin ⇒ 逐块剥离，
  //   否则 JSON.parse 抛错 → fail-closed 误拦正常工具调用（用户侧表现为无意义的「解析失败」弹窗）。
  process.stdin.on('data', (chunk) => { data += String(chunk).replace(/^\uFEFF/, ''); });
  process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
  if (process.stdin.isTTY) {
    stdinIsTTY = true;
    clearTimeout(timeout);
    resolve('');
  }
});

// ── 空输入处理 ────────────────────────────────────────
if (!input || !input.trim()) {
  audit('HOOK_NO_STDIN', `isTTY=${stdinIsTTY}`);      // ★GATE-1①：静默放行路径补留痕（行为不变）
  if (stdinIsTTY) {
    // TTY 无 pipe 输入：正常情况，放行
    process.exit(0);
  }
  // pipe 模式下空数据（timeout 或异常）：阻止
  block(
    'Hook 未收到有效的工具调用信息。',
    'stdin 在 3 秒内无数据输入。',
    '如非工具调用场景请忽略；如误拦截请检查管道配置。'
  );
}

// ── 解析 hook 输入 ─────────────────────────────────────
let toolName, filePath, hookInput;
try {
  // ★ FIX-14①（2026-09-17）：解析前再度剥离 BOM（可能跨 chunk 被拆开）+ 去首尾空白
  const raw = (input || '').replace(/^\uFEFF+/, '').trim();
  hookInput = JSON.parse(raw);
  toolName = hookInput.tool_name;
  const toolInput = hookInput.tool_input || {};
  filePath = toolInput.filePath || toolInput.file_path || toolInput.target_file || '';
} catch {
  // JSON 解析失败 → fail-closed：阻止而非放行（拦截行为不变）
  // ★ FIX-14①：完整原始输入留痕，便于区分「真异常」与「BOM / 编码类误拦」
  audit('HOOK_RAW_INPUT', input);
  block(
    '门禁收到无法识别的输入，已安全拦截。',
    '如果你正在执行正常操作却看到此提示，属误拦；请查看 .codebuddy/hooks/gate-audit.log 中的 HOOK_RAW_INPUT 原始内容核查。'
  );
}

// ── 非写入工具放行 ────────────────────────────────────
if (!WATCHED_TOOLS.includes(toolName)) {
  process.exit(0);
}

// ── execute_command 命令风险分级 ──────────────────────
if (toolName === 'execute_command' || toolName === 'Bash') {
  // ★ FIX-8：CodeBuddy 传入的规范化名是 'Bash'（非 'execute_command'），必须一并接受。
  const cmd = (hookInput.tool_input || {}).command || '';

  // ★ FIX-7：先按「段」找危险，再决定放行 —— 顺序不可颠倒。
  // 旧实现先判 SAFE（^ 锚定整条命令行首）再判 DANGEROUS，导致首段为
  // cd / echo / dir 等安全前缀时，后续的 del / Remove-Item / 重定向 /
  // 解释器内联（node -e、python -c）被整条放行。
  // ★ GATE-A①（2026-10-01）：shell 包装剥壳 —— `powershell|pwsh -Command|-c "…"` · `cmd /c "…"`。
  //   配合 SSOT §一「只读命令在任何阶段都放行」：包装本身不再等价「任意代码执行」，
  //   内层文本交回判定链；解析不出 ⇒ 原样走下方逻辑（fail-closed），不放宽任何写语义。
  let effectiveCmd = cmd;
  let unwrapDepth = 0;
  for (let i = 0; i < 3; i++) {
    const inner = unwrapWholeShellCommand(effectiveCmd);
    if (inner === null) break;
    effectiveCmd = inner;
    unwrapDepth += 1;
  }
  if (unwrapDepth > 0) {
    audit('CMD_UNWRAP', `depth=${unwrapDepth} | ${effectiveCmd.replace(/\s+/g, ' ').substring(0, 140)}`);
  }

  const segments = splitCommandChain(effectiveCmd);

  // ★ GAP-4/加固①（2026-09-16）：逃生口「自建」绝对拦截 —— 任何阶段一律拒绝（含 04）。
  //   逃生口是「人开的闸」；Agent 自建即等于自行解除门禁，故不走阶段门禁、直接 block。
  if (isBypassCreateCommand(cmd)) {
    audit('BLOCK', `[BYPASS-CREATE] ${cmd.substring(0, 140)}`);
    block(
      '检测到「创建逃生口标记」的命令（.gate-bypass）。',
      `命令: ${cmd.substring(0, 80)}`,
      '逃生口只能由用户手动开启：请用户创建标记文件，或由用户设置 GATE_BYPASS=1。'
    );
  }

  // ★ GATE-A③（2026-10-01）：取「命中原因」而非仅布尔 —— 供拦截话术/审计显示实际规则
  const dangerHit = segments.map((seg) => ({ seg, reason: dangerousSegmentReason(seg) })).find((x) => x.reason);
  const dangerSeg = dangerHit ? dangerHit.seg : undefined;

  // ★ E-2 结构兜底留痕（2026-09-30）：命中未知 git 全局选项 ⇒ fail-closed 判危险并留痕
  if (dangerSeg) {
    const gitProbe = gitChangeVerb(dangerSeg);
    if (gitProbe.suspect) audit('AUDIT_SUSPECT', `[GIT-OPT-UNKNOWN] ${String(dangerSeg).substring(0, 120)}`);
  }

  // ★ FIX-9：删除/移动类段先走「清单锚定」校验（04 阶段不再无条件放行删除）
  const deleteSeg = segments.find((seg) => isDeleteSegment(seg));
  if (deleteSeg) {
    // ★ GATE-6：传入整条 cmd —— 变量赋值可能与 Move/Remove 段分处不同段
    // ★ GATE-A①：目标提取改用**剥壳后**命令（`cmd /c "del /q x"` ⇒ 段内即 `del /q x`）
    await deleteGate(extractPathsFromCommand(deleteSeg, effectiveCmd), deleteSeg);
  }

  // ★ FIX-26（2026-10-01）：runtime/ 状态维护命令豁免（与第 1 关 ALWAYS_ALLOW 对齐）。
  //   置于逃生口「自建」硬拦之后、阶段门禁之前；目标不满足条件即返回 null ⇒ 行为不变。
  const rtTargets = runtimeMaintenanceTargets(effectiveCmd, segments);
  if (rtTargets) {
    audit('STAGE_ALLOW', `[CMD-RUNTIME] ${rtTargets.join(' , ')}`);
    process.exit(0);
  }

  // ★ FIX-9d：解释器内联「疑似删除」仅审计留痕（不拦截，理由见 isInlineDeleteSuspect 注释）
  //   ★ 用**整条命令**判定：内联代码含 `;` 会被 splitCommandChain 拆段，逐段判定会漏检
  if (isInlineDeleteSuspect(cmd)) {
    audit('AUDIT_SUSPECT', `[CMD] ${cmd.substring(0, 140)}`);
  }

  if (!dangerSeg) {
    // 无任何危险段 → 放行（含纯读命令与未知命令，保持原「不阻塞未知」策略）。
    // SAFE_CMD_PATTERNS 保留供人工查阅，实际已由本分支统一覆盖。
    process.exit(0);
  }

  // 命中危险段 → 走门禁（命令无文件路径可参与豁免判定，标识取命令文本）
  // ★ GATE-A③：携带命中规则 / 剥壳信息 ⇒ 拦截话术不再复用文件话术
  await gateCheck(`[CMD] ${cmd.substring(0, 80)}`, {
    rule: dangerHit.reason.rule,
    hit: dangerHit.reason.detail,
    effectiveCmd,
    unwrapDepth,
  });
}

// ── 无文件路径放行（防御） ────────────────────────────
if (!filePath) {
  // ★ FIX-9：Delete 工具缺路径 ⇒ fail-closed（无法核验删除目标）
  if (toolName === 'Delete' || toolName === 'delete_file' || toolName === 'delete_files') {
    block('删除操作未提供目标路径，无法核验。', '工具: ' + toolName);
  }
  process.exit(0);
}

// ── 标准化路径 ─────────────────────────────────────────
const projectDirNorm = PROJECT_DIR_NORM;
const filePathNorm = filePath.replace(/\\/g, '/');
const relativePath = filePathNorm.startsWith(projectDirNorm)
  ? filePathNorm.slice(projectDirNorm.length + 1)
  : filePathNorm;

// ── ★CONC-1：多会话写者互斥（软锁；与阶段门禁正交，fail-open）──────────
await concLockCheck(relativePath, toolName);

// ── ★ RESUME-3 批次 3 路线 I：阶段推进留痕观测（S8 · ALLOW+NOTIFY · fail-open）──
// 必须挂在第 1 关 ALWAYS_ALLOW 之前（state.yaml 命中 runtime/ 豁免段，挂后面=死代码）。
await phaseAdvanceGuard(relativePath);

// ── 第1关：ALWAYS_ALLOW（★ FIX-9：段前缀匹配，不再子串 includes）────
if (isAlwaysAllow(relativePath)) {
  process.exit(0);
}

// ── 第1.5关：删除类操作（Delete 工具）→ 清单锚定 ★ FIX-9 ──
if (toolName === 'Delete' || toolName === 'delete_file' || toolName === 'delete_files') {
  await deleteGate([relativePath], relativePath);
}

// ── 第0关：★ FIX-17e headless 接管锁 ──────────────────────
if (relativePath === HANDOFF_LOCK_REL) {
  audit('HANDOFF_LOCK_REL', relativePath);      // 允许解除锁（用户自助逃生）
  process.exit(0);
}
const hLock = handoffLockActive();
if (hLock) {
  block(
    '当前有 headless 接管在运行，写入已暂停（防并发改同一迭代）。',
    `接管 #${hLock.id} 起于 ${hLock.startedAt || '?'}，剩余约 ${Math.max(0, Math.round((Number(hLock.expiresAt) - Date.now()) / 60000))} 分钟`,
    `本次尝试: ${relativePath}`,
    '若确需手动继续：结束该接管，或删除 .codebuddy/temp/handoff/RUNNING.json（该删除已豁免）'
  );
}

await gateCheck(relativePath);

// ── ★ E-3（迭代 2026-09-30-001）：N-1 文件级白名单（dispatch_whitelist）────
// 语义：默认关闭；命中白名单 ⇒ 继续既有分支（不阻断）；未命中 ⇒ block（越界即回收）。
// 覆盖：仅写类工具（Write/Edit 的真实 fsPath）；Bash 伪路径与 Delete 显式跳过
//       （Bash 提取启发式不可靠 — 评审片 2 F1；删除走 deleteGate SSOT — F6）。
// ★ 函数形态（不可用 const —— 顶层 `await gateCheck(...)` 先于本段声明执行，const 会触发 TDZ）
function isE3BuiltinExempt(norm) {
  return [
    '.codebuddy/memory/', '.claude/memory/', '.cursor/memory/', '.codex/memory/',
    '.codebuddy/temp/', '.claude/temp/',
  ].some((pre) => String(norm || '').startsWith(pre));
}

/** 归一：`\`→`/` / 剥 `./` / 小写 / 去 `..` 段（防白名单前缀逃逸；评审片 3 🟡5） */
function e3Normalize(p) {
  const parts = [];
  const segs = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase().split('/');
  for (const seg of segs) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * 解析 state.yaml 的 dispatch_whitelist 段 —— 四档判定（评审片 2 F5：三态 + 异常）。
 * 返回 { state: 'none' | 'empty' | 'ok' | 'error', items, lines }；lines = 段原始行数（留痕用）。
 */
function readDispatchWhitelist(stateContent) {
  try {
    const lines = String(stateContent || '').split(/\r?\n/);
    let saw = false;
    let sectionLines = 0;
    let malformed = false;
    const items = [];
    for (const line of lines) {
      if (!saw) {
        if (/^dispatch_whitelist\s*:/.test(line)) {
          saw = true;
          sectionLines = 1;
          const inline = line.match(/\[(.*)\]/);
          if (inline) {
            for (const m of inline[1].matchAll(/"([^"]+)"/g)) items.push(e3Normalize(m[1]));
          }
        }
        continue;
      }
      if (/^\S/.test(line)) break;                       // 下一个顶层键 ⇒ 段结束（/^\S/ 防引号/数字开头键）
      sectionLines += 1;
      if (!line.trim() || /^\s*#/.test(line)) continue;  // 空行 / 注释
      const m = line.match(/^\s*-\s*"?([^"\s#]+)"?\s*(?:#.*)?$/);
      if (m) items.push(e3Normalize(m[1]));
      else malformed = true;                             // 形如列表项但无法解析 ⇒ 异常
    }
    if (!saw) return { state: 'none', items: [], lines: 0 };
    if (malformed) return { state: 'error', items, lines: sectionLines };
    return items.length
      ? { state: 'ok', items, lines: sectionLines }
      : { state: 'empty', items: [], lines: sectionLines };
  } catch {
    return { state: 'error', items: [], lines: 0 };
  }
}

/**
 * 白名单命中：条目为精确路径或目录前缀（条目以 `/` 结尾或作为目录前缀）。
 * ★ E-7（2026-10-02 迭代 2026-10-01-002）：**条目 + `.tmp` 后缀豁免**
 *   —— 原子写（先写 `<目标>.tmp` → 改名覆盖）是派发纪律的要求（`team-agent-strategy.md` §七），
 *   否则成员按纪律落盘反而被 WHITELIST_BLOCK（实测 2026-10-01 试点）。
 *   边界：仅「同条目 + `.tmp`」，不放行其它后缀；Bash 通道本不参与本判定（`:1313` 仅文件工具）。
 */
function matchDispatchWhitelist(target, items) {
  if (!target) return false;
  return items.some((pat) => {
    const p = String(pat || '').replace(/\/+$/, '');
    if (!p) return false;
    return target === p || target.startsWith(p + '/') || target === p + '.tmp';
  });
}

// ── 门禁检查（活跃迭代 + 阶段判定） ──────────────────
/**
 * ★ GATE-A③（2026-10-01）：命令类拦截话术。
 * 原实现对 `[CMD] …` 伪路径复用文件话术（「仅允许修改迭代产出目录」）——
 * 对只读/查询类误拦完全误导（2026-10-01 实证：两条 Get-Process / Get-ChildItem 拦截即此形态）。
 */
function cmdGateLines(cmdCtx) {
  const ctx = cmdCtx || {};
  return [
    '该命令被判「写/删/变更」语义，已拦截（只读查询不受门禁限制）。',
    '命中规则: ' + (ctx.rule || '(未记录)'),
    ...(ctx.unwrapDepth ? ['剥壳后命令: ' + String(ctx.effectiveCmd || '').replace(/\s+/g, ' ').slice(0, 120)] : []),
    '',
    '只读查询请优先用 read_file / search_content（不受门禁约束）；',
    '命令建议直接写 Get-ChildItem · Select-String · git log · git status（无需 powershell -Command 包装）。',
    '确需写操作：进入 04-开发实现 阶段，或由用户手动开闸（.gate-bypass）。',
  ];
}

async function gateCheck(fsPath, cmdCtx) {
  // ★ FIX-11：工作记忆写入/维护与迭代状态解耦（ACTIVE=none / 00 / 05 / 06 / 07 一并放行）。
  if (isMetaWriteExempt(fsPath)) {
    // ★ MAINT-3 P-5（2026-09-22）：MEMORY.md 写入侧配额守卫（fail-open；逃生口上游优先）
    memoryQuotaGuard(fsPath, toolName, hookInput);
    audit('META_ALLOW', fsPath);
    process.exit(0);
  }

  const activeFile = join(RUNTIME_DIR, 'ACTIVE');
  let activeId = null;
  if (existsSync(activeFile)) {
    activeId = readFileSync(activeFile, 'utf-8').split('\n')[0].trim();
  }

  if (!activeId || activeId === 'none') {
    // ★ GATE-7（2026-09-27）：none 态放行纯文档路径（立项前需求登记 / 迭代文档预写）。
    //   Bash 伪路径不享豁免（matchStageExempt 内 `[` 守卫，与 FIX-24 口径一致）。
    const noneHit = matchStageExempt('NONE', fsPath);
    if (noneHit) {
      audit('STAGE_ALLOW', `[NONE] ${fsPath} (pattern=${noneHit})`);
      process.exit(0);
    }
    if (cmdCtx) {
      block(
        '当前无活跃迭代：该命令含「写/删/变更」语义，已拒绝。',
        `本次尝试: ${fsPath}`,
        ...cmdGateLines(cmdCtx)
      );
    }
    block(
      '当前无活跃迭代。',
      '所有代码修改必须经过迭代工作流。',
      `本次尝试: ${fsPath}`,                       // ★ FIX-11：拦截留痕带目标，便于回溯
      '',
      'none 态仅放行纯文档: docs/iterations/ · requirements/*.md · feasibility/*.md',
      '业务代码修改请先创建新迭代（开始迭代 / 进入01阶段）。'
    );
  }

  // ── 第3关：读取迭代状态 ─────────────────────────────────
  const stateFile = join(RUNTIME_DIR, `${activeId}.state.yaml`);
  if (!existsSync(stateFile)) {
    block(`活跃迭代「${activeId}」的状态文件丢失。`);
  }

  const stateContent = readFileSync(stateFile, 'utf-8');
  const phaseMatch = stateContent.match(/^current_phase:\s*"(\d+)"/m);
  if (!phaseMatch) {
    block(`无法读取迭代「${activeId}」的 current_phase。`);
  }

  const currentPhase = phaseMatch[1];

  // ── 第4关：阶段判断 ─────────────────────────────────────
  // 04 阶段：放行全部写入（开发窗口）
  if (currentPhase === '04') {
    // ★ E-3（2026-09-30）：N-1 文件级白名单校验（纯增量拦截；未启用 ⇒ 逐字旧行为）
    const rawPath04 = String(fsPath || '');
    const isPseudoPath04 = rawPath04.startsWith('[');
    const isDeleteTool04 = toolName === 'Delete' || toolName === 'delete_file' || toolName === 'delete_files';
    const wl = readDispatchWhitelist(stateContent);
    if (wl.state === 'ok' && !isPseudoPath04 && !isDeleteTool04) {
      // 项目外绝对路径（toProjectRelative 口径的 null 分支）⇒ 判越界拦（fail-closed；评审片 2 F7）
      const isOutsideAbs = /^[A-Za-z]:[\\/]/.test(rawPath04) || rawPath04.startsWith('/');
      const norm04 = e3Normalize(rawPath04);
      const builtinOk = isE3BuiltinExempt(norm04);
      if (!builtinOk && !matchDispatchWhitelist(isOutsideAbs ? null : norm04, wl.items)) {
        audit('WHITELIST_BLOCK', `[04] ${rawPath04} | whitelist=${wl.items.join(',')}`);
        block(
          'N-1 白名单校验：写入越界（越界即回收白名单）。',
          `越界文件: ${rawPath04}`,
          `白名单（${wl.items.length} 条）: ${wl.items.join(' · ')}`,
          '处置：由主编排 Agent 回收/修正白名单，或将该路径列入派发白名单后重试。'
        );
      }
    } else if (wl.state === 'empty') {
      audit('WHITELIST_DISABLED', `[04] activeId=${activeId || '-'} (empty-section, lines=${wl.lines})`);
    } else if (wl.state === 'error') {
      audit('WHITELIST_PARSE_FAIL', `[04] activeId=${activeId || '-'} lines=${wl.lines} path=${rawPath04}`);
    }
    // ★ E-2 留痕（评审片 3 🔴）：04 期危险段放行无 block 事件 ⇒ 补 audit，防「授权在、留痕无」；仅 E-2 命中段
    if (isPseudoPath04 && gitChangeVerb(rawPath04.replace(/^\[CMD\]\s*/, '')).hit) {
      audit('E2_CMD_04_PASS', rawPath04.substring(0, 140));
    }
    process.exit(0);
  }

  // ★ FIX-12②（2026-09-17）：05/06/07 阶段化文档豁免（本职产出放行 + STAGE_ALLOW 审计留痕）。
  //   置于 01-03 分支之前：三阶段互斥，无重叠风险；未命中者继续走下方各分支（fail-closed）。
  const stagePattern = matchStageExempt(currentPhase, fsPath);
  if (stagePattern) {
    audit('STAGE_ALLOW', `[${currentPhase}] ${fsPath} (pattern=${stagePattern})`);
    process.exit(0);
  }

  // 01-03 阶段：窄放行——仅豁免目录可写
  // ★ FIX-24（2026-09-20）：Bash 伪路径（`[CMD] …`）**不享**路径豁免。
  //   原实现用 `includes('/' + pattern)` 兜"绝对路径 / IDE 前缀"，但缺少 `[` 守卫 ⇒
  //   命令文本里只要出现 `/docs/knowledge-base/` 之类的片段就整车放行（可被路径穿越规避）。
  //   现与 05/06/07 的 matchStageExempt 守卫口径对齐。
  if (currentPhase === '01' || currentPhase === '02' || currentPhase === '03') {
    const isPseudoPath = String(fsPath || '').startsWith('[');
    // ★ TRAVERSAL-1：含上跳段 ⇒ 不进入豁免（防 `docs/iterations/../../back-end/…` 借前缀写业务码）
    const hasJump = hasTraversal(String(fsPath || ''));
    if (!isPseudoPath && !hasJump) {
      for (const pattern of EXEMPT_PATHS) {
        if (fsPath.startsWith(pattern) || fsPath.includes('/' + pattern)) {
          // ★ FIX-23 配套：放行留痕（与 05/06/07 的 STAGE_ALLOW 对齐，便于事后回溯）
          audit('EXEMPT_ALLOW', `[${currentPhase}] ${fsPath} (pattern=${pattern})`);
          process.exit(0);
        }
      }
      // ★ E-6（2026-10-02 · R-14）：仅 .md 的放行目录（`requirements/iteration-context/`）
      if (/\.md$/i.test(fsPath)) {
        for (const pattern of EXEMPT_PATHS_MD_ONLY) {
          if (fsPath.startsWith(pattern) || fsPath.includes('/' + pattern)) {
            audit('EXEMPT_ALLOW', `[${currentPhase}] ${fsPath} (pattern=${pattern} · md-only)`);
            process.exit(0);
          }
        }
      }
    }
    if (cmdCtx) {
      block(
        `当前处于 ${currentPhase} 阶段：该命令含「写/删/变更」语义，已拒绝。`,
        `本次尝试: ${fsPath}`,
        ...cmdGateLines(cmdCtx)
      );
    }
    if (hasJump) {
      block(
        '当前阶段写入被拒：路径含上跳段（..），不认定迭代目录豁免。',
        `本次尝试: ${fsPath}`,
        '★ 门禁只能字面判定（GATE-6 同口径）：请将路径改写成不含 .. 的字面路径后重试。'
      );
    }
    block(
      `当前处于 ${currentPhase} 阶段，仅允许修改迭代产出目录。`,
      `本次尝试: ${fsPath}`,
      '',
      '允许写入的目录:',
      '  docs/iterations/          — 迭代文档（需求/评审/方案）',
      '  {IDE}/skills/.../         — Skill 自身文件',
      '  {IDE}/memory/             — 工作记忆',
      '',
      '业务代码修改需进入 04-开发实现 阶段。'
    );
  }

  // 其他阶段（00/05/06/07）：阻止
  // GATE-TRV-DEL（2026-10-02-002 收敛案 S-B · QQ#30 用户确认）：06 阶段追加开闸指引，
  // 消除「建议 rebuild → rebuild 仍被拦」的矛盾话术（★禁用「走 05 回补」措辞——05 同拦 hooks/）。
  const stageBlockHints = currentPhase === '06'
    ? ['如需开闸（.gate-bypass）请由用户手动处理；会话内不建议重建。']
    : [];
  if (cmdCtx) {
    block(
      `当前阶段 ${currentPhase}：该命令含「写/删/变更」语义，已拒绝。`,
      `本次尝试: ${fsPath}`,
      ...cmdGateLines(cmdCtx),
      ...stageBlockHints
    );
  }
  block(`当前阶段 ${currentPhase} 不允许进行文件写入操作。`, ...stageBlockHints);
}

// ── ★ FIX-9：删除类操作校验（清单锚定 + 豁免 + 默认禁删）──────
/**
 * 段是否为删除/移动类。
 * ★ FIX-9b：只看「命令名位置」——避免 commit message 等文本中出现 delete/move 等词被误判。
 * ★ FIX-9d：追加 Git 丢弃类（clean / restore / checkout --|.），并保留只读例外
 *   （`clean -n|--dry-run` 仅预演、`restore --staged` 仅动索引 ⇒ 不算删除）。
 */
function isDeleteSegment(seg) {
  const rawTokens = String(seg || String())
    .replace(/[\x27\x22]/g, String.fromCharCode(32))
    .split(/\s+/)
    .map((t) => t.replace(/^[;&|]+|[;,)]+$/g, String()))
    .filter(Boolean);
  const tokens = rawTokens.filter((t) => !/^[-/]/.test(t));                 // 跳过 -Recurse /q 等选项
  const has = (v) => rawTokens.some((t) => t.toLowerCase() === v);
  for (let i = 0; i < tokens.length && i < 4; i++) {
    const low = tokens[i].toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, String());
    if (/^(?:cmd|powershell|pwsh|bash|sh|zsh|call|start|exec|sudo|env|npx)(?:\.exe)?$/.test(low)) continue;
    const sub = (tokens[i + 1] || String()).toLowerCase();
    if (low === 'git') {
      if (sub === 'clean') return !(has('-n') || has('--dry-run'));
      if (sub === 'restore') return !(has('--staged') && !has('--worktree'));
      if (sub === 'checkout') return has('--') || tokens.indexOf('.') >= 0;
      return /^(?:rm|mv|delete|move|remove|rename|del)$/.test(sub);
    }
    if (low === 'svn') return /^(?:rm|mv|delete|move|remove|rename|del)$/.test(sub);
    return /^(?:del|erase|rm|rmdir|rd|ri|unlink|remove-item|remove-itemproperty|remove|delete|delete_files|move-item|rename-item|mi|mv|move|ren|rni|rename)$/.test(low);
  }
  return false;
}

/**
 * ★ FIX-9d：解释器内联「疑似删除」判定（**仅审计、不拦截**）。
 * 硬拦必须扫描整段文本 ⇒ 与 FIX-9b 修掉的误判同源（代码片段、注释、message 中的
 * `os.remove(` / `rmtree(` 字样会被误伤），故只记 `AUDIT_SUSPECT` 供回溯。
 */
function isInlineDeleteSuspect(seg) {
  const s = String(seg || String());
  if (!/\b(?:python|python3|py|node|nodejs|deno|bun|ruby|perl|php|powershell|pwsh)\b/i.test(s)) return false;
  if (!/(?:rmtree|unlink|unlinkSync|rmSync|rmdir|os\.remove|shutil|Remove-Item)\s*\(/i.test(s)) return false;
  return /[\\/]/.test(s) || /\.[A-Za-z0-9]{1,8}\b/.test(s);                  // 含路径或文件名
}

/**
 * ★ TRAVERSAL-1（2026-10-02 · 迭代 2026-10-02-001）：路径是否含「上跳段」(`..`)。
 *   正则与 FIX-26 在 `isAlwaysAllow` 内已验证的实现**逐字一致**，此处抽出为公共函数。
 *   语义：只认**完整路径段**的 `..`（`a/../b`、`../x`、`x/..`），不误伤 `a..b` / `v1.2..3`。
 *   用途：所有「前缀 / 包含」型豁免判定**前置调用** ⇒ 含上跳段**不认定豁免**（只收紧、不放宽）。
 *   依据（探针实测 2026-10-02）：`docs/iterations/../../back-end/…cs` 曾命中豁免直接放行
 *   （01-03 与 05 均成立）⇒ 存在无需开闸、无 `gate_window` 留痕的写业务码通道。
 */
function hasTraversal(p) {
  return /(?:^|\/)\.\.(?:\/|$)/.test(String(p || ''));
}

/** 相对路径是否落在工作流 runtime 目录（ALWAYS_ALLOW） */
function isAlwaysAllow(relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  // ★ FIX-26（2026-10-01）：含「上跳段」(`..`) 的路径不认定豁免（fail-closed 收紧）。
  //   原实现只看前缀 ⇒ `<runtime>/../../hooks/x` 会被判为「在 runtime 内」而放行。
  //   本改动只收紧、不放宽：合法 runtime 路径不含 `..`，回归不受影响。
  // ★ TRAVERSAL-1：改用公共函数 `hasTraversal()`（正则与行为均不变）。
  if (hasTraversal(raw)) return false;
  const p = '/' + raw;
  if (RUNTIME_REL && p.startsWith('/' + RUNTIME_REL)) return true;
  return ALWAYS_ALLOW_SEGMENTS.some((seg) => p.includes(seg));
}

/** 删除豁免判定（工程性/维护性删除） */
function isDeleteExempt(relPath) {
  const raw = String(relPath || '');
  if (!raw) return false;
  // ★ TRAVERSAL-1：含上跳段 ⇒ 不认定删除豁免（防 `…/../../node_modules/x` 命中豁免模式）
  if (hasTraversal(raw)) return false;
  if (isAlwaysAllow(raw)) return true;
  const p = raw.replace(/\\/g, '/').toLowerCase();
  const pSlash = p.endsWith('/') ? p : p + '/';   // 目录本体（如 node_modules）按目录判定
  return DELETE_EXEMPT_PATTERNS.some((re) => re.test(p) || re.test(pSlash));
}

/** 绝对/相对路径 → 项目相对路径；项目外绝对路径返回 null */
function toProjectRelative(p) {
  const s = String(p || '').replace(/\\/g, '/').trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (/^[a-zA-Z]:\//.test(s) || s.startsWith('//')) {
    const low = s.toLowerCase();
    const base = PROJECT_DIR_NORM.toLowerCase();
    if (low === base) return '';
    if (low.startsWith(base + '/')) return s.slice(base.length + 1);
    return null;
  }
  return s.replace(/^\.?\/+/, '');
}

/**
 * ★ GATE-6（2026-09-24）：命令内 shell 变量赋值收集 —— **字面收集，不求值、不执行、不读环境**
 *
 * 背景（门禁变量路径坑）：Agent 做原子落盘常写
 *   `$d=".codebuddy/temp"; … Move-Item "$d\x.md" "$d\x.md.bak"`
 * 静态解析只能拿到 `$d\x.md` ⇒ 命中不了 temp/ 目录豁免 ⇒ 被拦（fail-closed）；
 * 而同一命令若目标叫 `.tmp` 又会被「扩展名豁免」放行 ⇒ 判定自相矛盾、不可预测。
 *
 * 语义边界：仅在**同一条命令文本内**做字面替换；解析不出的变量原样保留 ⇒ 仍走
 *           fail-closed 拦截（本改动**不扩大放行面**，只消除「能解析却被误拦」的假阳性）。
 */
function collectShellAssignments(cmd) {
  const map = Object.create(null);
  const re = /(?:^|[;&|\s])(?:\$(\w+)|(?:set\s+)?(\w+))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;|&]+))/g;
  const src = String(cmd || '');
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] || m[2];
    const val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
    if (name && val) map[name] = val;
  }
  return map;
}

/** 展开 `$name` / `${name}`（多轮 —— 支持变量套变量）；未赋值变量原样保留 */
function expandShellVars(text, map) {
  let s = String(text || '');
  for (let i = 0; i < 3; i++) {
    let next = s;
    for (const k of Object.keys(map)) {
      const rx = new RegExp('\\$\\{' + k + '\\}|\\$' + k + '(?![\\w])', 'g');
      next = next.replace(rx, map[k]);
    }
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * ★ FIX-26（2026-10-01）：`Rename-Item -NewName` 的同目录语义解析。
 *
 * 背景（实测 gate-audit.log 2026-10-01T08:47:27Z）：归档 state 文件的标准写法
 *   `Rename-Item -LiteralPath '<abs>/runtime/2026-09-18-001-…state.yaml' -NewName '…state.archived.yaml'`
 * 被拦，理由是「删除/移动类操作未在任务清单登记」，报的目标是**裸文件名**
 * `2026-09-18-001-…state.archived.yaml` —— 它不含目录分量 ⇒ 不匹配 runtime/ 前缀、
 * 也不在删除豁免表 ⇒ fail-closed 误拦；而同一命令的**源**路径已按 runtime/ 豁免放行，
 * 即同一条命令两个端点判定自相矛盾。
 *
 * 依据（非启发式猜测）：PowerShell 官方语义规定 `-NewName` 只能给**名称**、不能给路径，
 *   故其所在目录 ≡ `-Path` / `-LiteralPath` 值的父目录 —— 可静态确定。
 *
 * 边界（不扩大放行面）：仅认 `Rename-Item` / `rni`；`-NewName` 值须为裸名（无 `/` `\`）；
 *   同段须**恰好一个**带目录分量的目标作锚点；任一条件不满足 ⇒ 原样返回（继续 fail-closed）。
 *   Move-Item / Copy-Item / Remove-Item **不适用** —— 其路径参数是完整路径，裸名按 CWD 解析，
 *   不能假定与同段的绝对路径同目录。
 */
function resolveRenameNewName(segText, targets) {
  const seg = String(segText || '');
  if (!/\b(?:Rename-Item|rni)\b/i.test(seg)) return targets;
  const m = seg.match(/-NewName\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&)]+))/i);
  if (!m) return targets;
  const newName = String(m[1] || m[2] || m[3] || '').trim();
  if (!newName || /[\\/]/.test(newName)) return targets;      // 带路径 ⇒ 按 CWD 语义判，不代解析
  const anchors = targets.filter((t) => /[\\/]/.test(String(t)) && String(t) !== newName);
  if (anchors.length !== 1) return targets;                   // 无锚点 / 多锚点 ⇒ 不猜
  const anchor = String(anchors[0]).replace(/\\/g, '/');
  const cut = anchor.lastIndexOf('/');
  if (cut <= 0) return targets;
  const dir = anchor.slice(0, cut);
  const resolved = targets.map((t) => (String(t) === newName ? dir + '/' + newName : t));
  audit('RENAME_SAMEDIR', `${newName} -> ${dir}/${newName}`);
  return resolved;
}

/** 从删除类命令段提取候选路径 token（★ GATE-6：cmd = 整条命令，供变量赋值收集） */
function extractPathsFromCommand(seg, cmd) {
  let s = String(seg || '').replace(/["']/g, ' ');
  const vars = collectShellAssignments(cmd || seg);
  if (Object.keys(vars).length) s = expandShellVars(s, vars);
  s = s.replace(/\s-[a-zA-Z][\w-]*/g, ' ');                 // -Recurse / -Force / -LiteralPath
  s = s.replace(/(?:^|\s)\/[a-zA-Z]{1,3}(?=\s|$)/g, ' ');   // cmd 开关 /q /s /f /y
  // ★ FIX-15（2026-09-18）：命令名 / shell 前缀词**只从段首剥离**（原为全文 `\b…\b` 删除，
  //   会把路径里的同名片段当命令名吃掉：实测 `…\temp\patch-exec.mjs` → `…\temp\patch-` + `.mjs`，
  //   碎片不在豁免清单 ⇒ 整条删除命令被误拦并报「目标: .mjs」）。
  s = s.replace(/^\s*(?:(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|sh|zsh|call|start|exec|xargs)\b[\s/]*)+/i, ' ');
  s = s.replace(/^\s*(?:Remove-Item|Remove-ItemProperty|Move-Item|Rename-Item|Copy-Item|erase|rmdir|del|delete_files|delete|remove|rename|move|ren|rni|ri|mi|rm|rd|mv|svn)\b/i, ' ');
  const tokens = s.split(/\s+/).map((t) => t.replace(/[;,)]+$/, '')).filter((t) => t && !/^-/.test(t));
  // ★ 优先只校验「像路径」的 token（含分隔符或扩展名），避免 cmd/shell 前缀或裸词干扰豁免判定
  // ★ FIX-15 补强：丢弃「扩展名碎片」（形如 `.mjs`）—— 只可能来自路径被误切，非真实删除目标
  const isExtFragment = (t) => /^\.[A-Za-z0-9]{1,8}$/.test(t);
  const pathLike = tokens.filter((t) => !isExtFragment(t) && (/[\\/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t)));
  const picked = (pathLike.length ? pathLike : tokens).slice(0, 40);
  // ★ FIX-26：Rename-Item 的 -NewName（裸名）按源文件父目录展开后再交 deleteGate 判定
  return resolveRenameNewName(seg, picked);
}

/** delete_allow 匹配：精确路径 / 目录前缀（以 / 结尾）/ 通配 / basename 后缀 */
function matchDeleteAllow(rel, allowed) {
  const a = String(allowed || '').replace(/\\/g, '/').toLowerCase();
  const r = String(rel || '').replace(/\\/g, '/').toLowerCase();
  if (!a || !r) return false;
  if (a.endsWith('/')) return r === a.slice(0, -1) || r.startsWith(a);
  if (a.indexOf('*') >= 0) {
    const rx = new RegExp('^' + a.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return rx.test(r);
  }
  if (r === a) return true;
  if (r.indexOf('/') < 0 && a.endsWith('/' + r)) return true;   // 仅给出文件名（如 svn delete X.cs）
  return false;
}

/** 读取 state.yaml 的 delete_allow（= 任务清单 DELETED/ADDED 项） */
function readDeleteAllow(activeId) {
  try {
    const sf = join(RUNTIME_DIR, `${activeId}.state.yaml`);
    if (!existsSync(sf)) return null;
    const lines = readFileSync(sf, 'utf-8').split(/\r?\n/);
    let inSection = false;
    const allow = [];
    for (const line of lines) {
      if (/^delete_allow\s*:/.test(line)) {
        inSection = true;
        const inline = line.match(/\[(.*)\]/);
        if (inline) {
          const re = /\bpath\s*:\s*"([^"]+)"/g;
          let m;
          while ((m = re.exec(inline[1])) !== null) allow.push(m[1]);
        }
        continue;
      }
      if (inSection) {
        if (/^[A-Za-z_]/.test(line)) break;                     // 下一个顶层键
        const m = line.match(/\bpath\s*:\s*"?([^",}\s]+)"?/);
        if (m) allow.push(m[1]);
      }
    }
    return allow;
  } catch {
    return null;
  }
}

/** 删除类操作统一校验入口：任一目标越界即 block（fail-closed） */
async function deleteGate(paths, label) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (list.length === 0) {
    block(
      '删除/移动类命令无法自动核验目标路径。',
      `命令: ${label}`,
      '请给出明确路径，或改用「登记 delete_allow + 明确路径」的方式执行。'
    );
  }

  // ★ FIX-11：豁免过滤前置 —— 全部命中删除豁免清单时直接交回阶段门禁。
  //   原实现把「无活跃迭代」检查放在豁免循环之前 ⇒ 删 {IDE}/memory/ 也被拒，
  //   与 SSOT 删除豁免清单矛盾。现仅对「未豁免目标」做 none 检查与 delete_allow 校验。
  const pending = list.filter((raw) => !isDeleteExempt(raw));
  if (pending.length === 0) {
    audit('DELETE_EXEMPT', `${label} → ${list.join(' , ')}`);
    return;
  }

  const activeFile = join(RUNTIME_DIR, 'ACTIVE');
  let activeId = null;
  if (existsSync(activeFile)) {
    activeId = readFileSync(activeFile, 'utf-8').split('\n')[0].trim();
  }
  if (!activeId || activeId === 'none') {
    block(
      '当前无活跃迭代，删除/移动类操作被拒绝。',
      `本次尝试: ${label}`,
      '维护性删除请走逃生口（.gate-bypass），留痕于 gate-audit.log。'
    );
  }

  const allow = readDeleteAllow(activeId);
  audit('DELETE_TARGETS', `${label} -> [${list.join(' , ')}]`);
  for (const raw of pending) {
    const rel = toProjectRelative(raw);
    if (rel && Array.isArray(allow) && allow.some((a) => matchDeleteAllow(rel, a))) continue;
    // ★ GATE-6：目标含未展开 shell 变量时，明确告知「门禁只能字面判定」，
    //   避免 Agent 反复重试同一形态命令（2026-09-24 门禁变量路径坑）。
    const unresolved = /\$\{?\w+\}?/.test(String(raw));
    const hints = [
      '登记方式: 任务清单增补 DELETED 项 → 用户确认 → 写入 state.yaml 的 delete_allow。',
      '豁免: runtime/ · temp/ · memory/ · node_modules/ · dist/ · obj/ · bin/ · *.bak*',
      '★ 目标含未展开的 shell 变量：门禁只能做字面判定、无法求值 ⇒ 请把变量写成字面路径后重试。',
    ];
    block(
      '删除/移动类操作未在任务清单登记。',
      `目标: ${rel === null ? raw + '（项目外路径）' : rel}`,
      `迭代: ${activeId}`,
      ...(unresolved ? hints : hints.slice(0, 2))
    );
  }

  // ★ 删除白名单校验通过 → 交回调用方继续走「阶段门禁」（不得直接 exit）：
  //   01-03 仍受 EXEMPT_PATHS 约束；00/05/06/07 仍一律阻止；04 放行。
  audit('DELETE_ALLOW', `${label} → ${pending.join(' , ')}`);
}

/**
 * ★ FIX-26（2026-10-01）：runtime/ 状态维护命令豁免 —— 关闭「文件通道 vs 命令通道」口径不一致。
 *
 * 背景（实测 2026-10-01T08:48:37Z）：文件工具写/删 runtime/ 在第 1 关无条件放行（ALWAYS_ALLOW），
 *   而命令通道在 01-03 阶段一律拦（FIX-24「Bash 不享豁免」）—— 同一条路径两种结果。
 *   归档 state 文件那次的实录：删除层已放行（`DELETE_EXEMPT Move-Item … → 两个目标均在 runtime/`），
 *   随后被阶段层以「01 阶段：该命令含写/删/变更语义」拦下 ⇒ 维护动作只能开闸或绕道，
 *   与「runtime/ = 状态维护目录」的设计意图冲突。
 *
 * 判定：**所有危险段**的目标都必须落在 ALWAYS_ALLOW（runtime/）内 ——
 *   目标解析不出（0 个）/ 属项目外绝对路径 / 含上跳段 / 落在任何非 runtime 目录 ⇒ 返回 null，
 *   继续走原阶段门禁（fail-closed，不放宽任何写语义）。
 *   返回目标清单仅用于审计留痕。
 */
function runtimeMaintenanceTargets(cmd, segments) {
  const dangerSegs = (Array.isArray(segments) ? segments : []).filter((seg) => dangerousSegmentReason(seg));
  if (dangerSegs.length === 0) return null;
  const all = [];
  for (const seg of dangerSegs) {
    const targets = extractPathsFromCommand(seg, cmd);
    if (!targets.length) return null;
    for (const raw of targets) {
      const rel = toProjectRelative(raw);
      if (!rel || !isAlwaysAllow(rel)) return null;
      all.push(rel);
    }
  }
  return all;
}

/** ★ FIX-9：通用审计留痕（放行与拦截均记录） */
function audit(kind, detail) {
  try {
    const logFile = join(RUNTIME_DIR, 'gate-audit.log');
    appendFileSync(logFile, `[${new Date().toISOString()}] ${kind} ${detail}\n`, 'utf-8');
  } catch { /* 审计失败不阻断判定 */ }
}

// ── 逃生口审计 ─────────────────────────────────────────
function auditBypass(reason) {
  try {
    const logFile = join(RUNTIME_DIR, 'gate-audit.log');
    const ts = new Date().toISOString();
    let activeId = 'unknown', phase = 'unknown';
    try {
      const af = join(RUNTIME_DIR, 'ACTIVE');
      if (existsSync(af)) {
        activeId = readFileSync(af, 'utf-8').split('\n')[0].trim() || 'none';
        if (activeId !== 'none') {
          const sf = join(RUNTIME_DIR, `${activeId}.state.yaml`);
          if (existsSync(sf)) {
            const sc = readFileSync(sf, 'utf-8');
            const pm = sc.match(/^current_phase:\s*"(\d+)"/m);
            if (pm) phase = pm[1];
          }
        }
      }
    } catch { /* 状态读取失败不阻止逃生口 */ }
    const entry = `[${ts}] BYPASS reason=${reason} active=${activeId} phase=${phase}\n`;
    appendFileSync(logFile, entry, 'utf-8');
  } catch {
    // 审计日志写入失败不阻止逃生口
  }
}

// ── 拦截即发 QQ 确认提醒（事件驱动，零延迟）── 2026-09-17 ──
// gate 的 block() 是所有"需你确认"弹窗（无活跃迭代 / 阶段不允许 / 删除未登记 /
// 危险命令）的唯一触发点。在弹确认的那一刻直接发 QQ，弥补 watcher 仅"轮询空闲"的延迟。
//
// ★ FIX-19（2026-09-18）：四处修正（起因：2026-09-18 09:53 连发 4 条「待确认」全是误报）
//   ① 测试态静默 —— gate-regression-test.py 以合成 stdin 调本 hook，拦截是**预期结果**而非
//      真实待确认（铁证：通知里 `迭代: test-iter` 只来自测试夹具 SCENARIOS）。故
//      GATE_TEST_RUNTIME_DIR / GATE_TEST_DISABLE_BYPASS 存在时只审计 QQ_NOTIFY_SKIP(test)。
//   ② 手动总开关 —— QQ_NOTIFY=0 或 hooks/.qq-notify-off 标记 ⇒ 静默（批量维护期免打扰）。
//   ③ 去重升级 —— 原「全局 60s」会把**不同目标**的连续拦截一并吞掉（信息缺失），
//      改为「同指纹 10min 防刷屏」（判定已推迟到 Stop，不再需要全局 20s 连发保护）；指纹 = 原因 + 目标。

/** 静默原因（null = 正常发送） */
function notifySilentReason() {
  if (process.env.GATE_TEST_RUNTIME_DIR || process.env.GATE_TEST_DISABLE_BYPASS) return 'test';
  if (process.env.QQ_NOTIFY === '0' || process.env.QQ_NOTIFY === 'off') return 'env';
  for (const rel of QQ_NOTIFY_OFF_MARKERS) {
    if (existsSync(join(PROJECT_DIR, rel))) return 'marker';
  }
  return null;
}

/** 当前工具名（block 可能在 stdin 解析前被触发 ⇒ try 兜住 let 的 TDZ） */
function blockToolLabel() {
  try { return toolName || '?'; } catch { return '?'; }
}

/** 当前目标（相对路径 > filePath > Bash 命令原文）—— 逐段 try，避免一处 TDZ 吃掉全部 */
function blockTargetLabel() {
  const pick = (fn) => { try { return fn() || ''; } catch { return ''; } };
  return pick(() => relativePath)
      || pick(() => filePath)
      || pick(() => ((hookInput && hookInput.tool_input && hookInput.tool_input.command) || ''));
}

/**
 * 迭代上下文（ACTIVE + {ID}.state.yaml）—— 口径与 qqbot-service.js 的 readIterationContext 同源。
 * 目的：通知要回答「当前在处理什么」——迭代 · 阶段 · 待办步骤，而不是只有一句「被拦截」。
 */
function readIterContext() {
  const out = { id: '', phase: '', pending: '' };
  try {
    const af = join(RUNTIME_DIR, 'ACTIVE');
    let id = '';
    try { id = String(readFileSync(af, 'utf-8') || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim(); } catch { /* 无 ACTIVE */ }
    if (!id || id === 'none') return out;
    out.id = id;
    let raw = '';
    try { raw = readFileSync(join(RUNTIME_DIR, `${id}.state.yaml`), 'utf-8'); } catch { return out; }
    const pm = raw.match(/^current_phase:\s*"?([^"\r\n]+?)"?\s*$/m);
    if (pm) out.phase = pm[1];
    const list = [];
    let curId = '', curName = '';
    for (const ln of raw.split(/\r?\n/)) {
      const mi = ln.match(/^\s*-\s*id:\s*"([^"]+)"/);
      if (mi) { curId = mi[1]; curName = ''; continue; }
      const mn = ln.match(/^\s*name:\s*"([^"]+)"/);
      if (mn) { curName = mn[1]; continue; }
      if (/^\s*status:\s*"?pending"?\s*$/.test(ln) && curId) list.push(curId + (curName ? ' ' + curName : ''));
    }
    out.pending = list.slice(0, 3).join(' ｜ ');
  } catch { /* 上下文缺失不影响拦截判定 */ }
  return out;
}

/**
 * ★ FIX-21：门禁事件留痕 —— 只写事件流，**不发通知**。
 *   通知判定推迟到会话结束（`--stop-check`）：推理中自判门禁 / 已开闸 / 换路径绕过 ⇒ 一律不打扰。
 */
function recordGateEvent(kind, extra) {
  try {
    mkdirSync(dirname(GATE_EVENTS_FILE), { recursive: true });
    const ev = Object.assign({
      ts: Date.now(), kind,
      tool: blockToolLabel(),
      target: String(blockTargetLabel() || '').slice(0, 200),
    }, extra || {});
    appendFileSync(GATE_EVENTS_FILE, JSON.stringify(ev) + '\n', 'utf-8');
  } catch { /* 留痕失败不影响门禁判定 */ }
}

/** 事件流 → { lastBlock, lastAllow }（各取时间最新的一条） */
function readGateEvents() {
  const out = { lastBlock: null, lastAllow: null };
  try {
    for (const ln of readFileSync(GATE_EVENTS_FILE, 'utf-8').split(/\r?\n/).filter(Boolean)) {
      let ev = null;
      try { ev = JSON.parse(ln); } catch { continue; }
      if (!ev || !ev.ts) continue;
      if (ev.kind === 'block') { if (!out.lastBlock || ev.ts >= out.lastBlock.ts) out.lastBlock = ev; }
      else if (ev.kind === 'allow') { if (!out.lastAllow || ev.ts >= out.lastAllow.ts) out.lastAllow = ev; }
    }
  } catch { /* 无事件文件 = 未被拦截 */ }
  return out;
}

/**
 * 「会话是否确实被门禁阻断」的唯一判定（Stop 时调用）：
 *   ① 存在 block；② block 之后没有 allow（没开闸、没换路径成功）；③ block 在会话末段时间窗内。
 * 三者皆真才算真阻断 —— 满足用户口径「只有会话结束后确实有门禁阻断才通知」。
 */
function resolveSessionBlocked() {
  const { lastBlock, lastAllow } = readGateEvents();
  if (!lastBlock) return null;
  if (lastAllow && lastAllow.ts >= lastBlock.ts) return null;
  if (Date.now() - lastBlock.ts > STOP_GATE_WINDOW_MS) return null;
  return lastBlock;
}

/** Stop 入口：node .codebuddy/hooks/gate-check.mjs --stop-check */
async function runStopCheck() {
  try {
    const ev = resolveSessionBlocked();
    if (!ev) {
      audit('GATE_STOP_CHECK', 'no-real-block（无拦截 / 拦截后已放行 / 超窗）⇒ 不通知');
      return;
    }
    // ① 测试态 / ② 手动开关 ⇒ 静默（仅审计留痕）
    const silent = notifySilentReason();
    if (silent) {
      audit('QQ_NOTIFY_SKIP', `reason=${silent} :: ${String(ev.reason || '').slice(0, 80)}`);
      return;
    }
    // ③ 去重：同指纹（原因+目标）窗口内只提醒一次
    const fp = String(ev.reason || '') + '|' + String(ev.target || '');
    const now = Date.now();
    const stateFile = join(RUNTIME_DIR, 'qq-gate-notify.json');
    let st = { last: 0, fp: '', fpAt: 0 };
    try { st = Object.assign(st, JSON.parse(readFileSync(stateFile, 'utf-8'))); } catch { /* 无痕 */ }
    if (st.fp === fp && st.fpAt && now - st.fpAt < QQ_NOTIFY_FP_WINDOW_MS) {
      audit('QQ_NOTIFY_SKIP', 'dedupe 同指纹窗口内 :: ' + String(fp).slice(0, 80));
      return;
    }
    try { writeFileSync(stateFile, JSON.stringify({ last: now, fp, fpAt: now }), 'utf-8'); } catch { /* 忽略 */ }
    audit('GATE_STOP_CHECK', 'real-block ⇒ 通知 :: ' + String(fp).slice(0, 120));
    sendGateNotify(ev);
  } catch (e) {
    audit('GATE_STOP_CHECK_ERR', String((e && e.message) || e));
  }
}

/** 由「阻断事件」构造并发送门禁通知（不可逆 → ask 回路；其余 → 入队带 #N） */
function sendGateNotify(ev) {
  try {
    const notifyPath = join(PROJECT_DIR, 'tools/qqbot/notify.qqbot.js');
    if (!existsSync(notifyPath)) return;
    const reason = ev.reason || '操作被门禁拦截';
    const target = ev.target || '';

    // ★ FIX-19 上下文：工具 / 目标 / 拦截时刻 / 迭代·阶段 / 待办步骤
    const ctx = readIterContext();
    const detail = String(ev.detail || '');
    const payload = {
      title: '会话结束仍被门禁阻断',
      status: reason,
      rows: [
        ['工具', ev.tool || '?'],
        ['目标', target ? String(target).slice(0, 120) : '(未提供)'],
        ['拦截于', new Date(ev.ts || Date.now()).toLocaleString('zh-CN', { hour12: false })],
        ['迭代', ctx.id ? `${ctx.id}（阶段 ${ctx.phase || '?'}）` : '(无活跃迭代)'],
        ['待办', ctx.pending || '(state.yaml 未读到 pending 步骤)'],
        ...(detail ? [['详情', detail.slice(0, 120)]] : []),
      ],
      next: '本条在「会话结束」时判定：此前所有拦截若已被放行/绕开均不计。处理 = 开逃生口或切换阶段；QQ 回「确认#N」仅登记意图，默认只回执不执行',
      prompt: '门禁阻断（会话结束时仍未放行）：' + reason,   // 降级用；notify-enqueue.js 会用 rows 渲染成多行
      kind: 'gate',
    };
    const msg = '门禁阻断：' + reason;   // 仅用于审计留痕 / 解析降级

    // ★ FIX-20：不可逆动作（提交/推送/发布/写库/删除）⇒ **强制走 ask.js 决策回路**（必带 #N，
    //   超时 2h，且不会自动执行）—— 此前只靠 handoffPrompt 里的文字约定，无机制保障。
    const IRREVERSIBLE_RE = /svn\s+commit|git\s+push|git\s+commit|run_ddl|drop\s+table|truncate\s+table|deploy|部署|发布|提交推送|删除文件/i;
    // ★ E-2 决策侧（2026-09-30）：`git -C … commit` 等带前置全局选项形态不被旧正则命中
    //   ⇒ 复用词元判定（strip `[CMD] ` 前缀 + 容忍 80 字符截断；评审片 3 🔴 FIX-20 只修一半问题）。
    const irreversibleText = reason + ' ' + String(target || '') + ' ' + detail;
    if (IRREVERSIBLE_RE.test(irreversibleText) || textHasGitChange(irreversibleText)) {
      const askPath = join(PROJECT_DIR, 'tools/qqbot/ask.js');
      if (existsSync(askPath)) {
        const askPrompt = [
          '【不可逆操作 · 需你本人确认】',
          String(reason).slice(0, 200),
          '工具：' + (ev.tool || '?'),
          '目标：' + (target ? String(target).slice(0, 120) : '(未提供)'),
          '迭代：' + (ctx.id ? `${ctx.id}（阶段 ${ctx.phase || '?'}）` : '(无活跃迭代)'),
          '',
          '此类操作不会自动执行，也不会被 headless 代跑；请在 IDE 内确认，或回「确认#N」登记意图。',
        ].join('\n');
        const askChild = spawn(process.execPath,
          [askPath, '--prompt', askPrompt, '--kind', 'irreversible', '--timeoutSec', '7200'],
          { detached: true, stdio: 'ignore', windowsHide: true });
        askChild.unref();
        audit('QQ_ASK_IRREVERSIBLE', msg + ` | 工具=${ev.tool || '?'} 目标=${target || '-'}`);
        return;
      }
    }
    // 优先送「合并服务」入队（带 #id，可在 QQ 回「确认#N」）；
    // 服务不可用时 notify-enqueue.js 自身会回退为直接发送，原能力不受影响。
    const enqueuePath = join(PROJECT_DIR, 'tools/qqbot/notify-enqueue.js');
    const notifyTarget = existsSync(enqueuePath) ? enqueuePath : notifyPath;
    // detached + unref + stdio:ignore → 父进程 exit(2) 后子进程仍独立把 QQ 发出去
    const child = spawn(process.execPath, [notifyTarget, '--json', JSON.stringify(payload)], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    audit('QQ_NOTIFY', msg + ` | 工具=${ev.tool || '?'} 目标=${target || '-'}`);
  } catch (e) {
    audit('QQ_NOTIFY_ERR', String((e && e.message) || e));
  }
}

// ── 阻止输出 ───────────────────────────────────────────
function block(...lines) {
  audit('BLOCK', lines.join(' | '));   // ★ FIX-9：拦截留痕（原仅 BYPASS 有记录）
  // ★ FIX-21：此处**只留痕不通知** —— 是否真的「阻断了会话」由 Stop 时 --stop-check 判定。
  recordGateEvent('block', {
    reason: String(lines[0] || '操作被门禁拦截').slice(0, 200),
    detail: String(lines.slice(1).join(' ')).slice(0, 300),
  });
  const box = [
    '╔══════════════════════════════════════════════════╗',
    '║  🛑 修改门禁：操作已被拦截                        ║',
    '║                                                  ║',
  ];
  for (const line of lines) {
    box.push(`║  ${padVisual(line, 46)}║`);
  }
  box.push(
    '║                                                  ║',
    '║  紧急绕过：GATE_BYPASS=1 环境变量 或              ║',
    '║  在 hooks/ 目录创建 .gate-bypass 标记文件          ║',
    '╚══════════════════════════════════════════════════╝'
  );
  process.stderr.write(box.join('\n') + '\n');
  process.exit(2);
}

// 视觉宽度填充（中文字符占2位）
function padVisual(str, width) {
  let visualLen = 0;
  for (const ch of str) {
    visualLen += /[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  }
  const padLen = width - visualLen;
  return str + (padLen > 0 ? ' '.repeat(padLen) : '');
}
