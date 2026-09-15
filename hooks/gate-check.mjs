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
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

// ── 配置 ──────────────────────────────────────────────
const PROJECT_DIR = process.env.CODEBUDDY_PROJECT_DIR
  || process.env.CLAUDE_PROJECT_DIR
  || process.cwd();
const RUNTIME_DIR = process.env.GATE_TEST_RUNTIME_DIR
  || (existsSync(join(PROJECT_DIR, '.claude/skills/iteration-workflow/runtime'))
    ? join(PROJECT_DIR, '.claude/skills/iteration-workflow/runtime')
    : join(PROJECT_DIR, '.codebuddy/skills/iteration-workflow/runtime'));

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
  '.codebuddy/memory/',
  '.claude/memory/',
];

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

/** Shell 命令：写/删除类模式（触发门禁） */
const DANGEROUS_CMD_PATTERNS = [
  // ── 文件写入/重定向 ──
  /\b(?:Out-File|Set-Content|Add-Content|Tee-Object)\b/i,       // PowerShell 写入
  /\b(?:New-Item|ni|mkdir|md)\b/i,                                 // 创建文件/目录
  /[^>]>\s*\S/,                                                    // 输出重定向（排除 >>）
  />>\s*\S/,                                                       // 追加重定向
  // ── 文件删除 ──
  /\b(?:Remove-Item|ri|rm|del|erase|rmdir|rd)\b/i,               // 删除命令
  /\bdel\s+/i, /\berase\s+/i,                                      // cmd 删除
  // ── 文件修改/移动 ──
  /\b(?:Move-Item|mi|mv|move|Rename-Item|rni|ren|rename)\b/i,
  /\bcopy\s+/i,                                                    // 文件复制
  // ── Git 变更类 ──
  /\bgit\s+(?:commit|push|reset|rebase|merge|cherry-pick|stash)\b/i,
  // ── SVN 变更类 ──
  /\bsvn\s+(?:commit|ci|delete|rm|move|mv|copy|cp|import)\b/i,
  // ── 打包/压缩（可能覆盖文件） ──
  /\b(?:Compress-Archive|Expand-Archive)\b/i,
];

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
if (process.env.GATE_BYPASS === '1' || process.env.GATE_BYPASS === 'true') {
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
if (GATE_BYPASS_PATHS.some(p => existsSync(p))) {
  auditBypass('.gate-bypass_file');
  process.exit(0);
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

/** 单个命令段是否危险（危险模式 或 解释器内联） */
function isDangerousSegment(seg) {
  return DANGEROUS_CMD_PATTERNS.some((p) => p.test(seg))
      || INTERPRETER_INLINE_PATTERNS.some((p) => p.test(seg));
}

let stdinIsTTY = false;
const input = await new Promise((resolve) => {
  let data = '';
  const timeout = setTimeout(() => resolve(data), 3000);
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
  if (process.stdin.isTTY) {
    stdinIsTTY = true;
    clearTimeout(timeout);
    resolve('');
  }
});

// ── 空输入处理 ────────────────────────────────────────
if (!input || !input.trim()) {
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
  hookInput = JSON.parse(input);
  toolName = hookInput.tool_name;
  const toolInput = hookInput.tool_input || {};
  filePath = toolInput.filePath || toolInput.file_path || toolInput.target_file || '';
} catch {
  // JSON 解析失败 → fail-closed：阻止而非放行
  block(
    'Hook 输入格式错误，无法解析为 JSON。',
    `输入前100字符: ${(input || '').substring(0, 100)}`,
    '工具调用已拦截以保护代码安全。'
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
  const segments = splitCommandChain(cmd);
  const dangerSeg = segments.find((seg) => isDangerousSegment(seg));

  // ★ FIX-9：删除/移动类段先走「清单锚定」校验（04 阶段不再无条件放行删除）
  const deleteSeg = segments.find((seg) => isDeleteSegment(seg));
  if (deleteSeg) {
    await deleteGate(extractPathsFromCommand(deleteSeg), deleteSeg);
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
  await gateCheck(`[CMD] ${cmd.substring(0, 80)}`);
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

// ── 第1关：ALWAYS_ALLOW（★ FIX-9：段前缀匹配，不再子串 includes）────
if (isAlwaysAllow(relativePath)) {
  process.exit(0);
}

// ── 第1.5关：删除类操作（Delete 工具）→ 清单锚定 ★ FIX-9 ──
if (toolName === 'Delete' || toolName === 'delete_file' || toolName === 'delete_files') {
  await deleteGate([relativePath], relativePath);
}

await gateCheck(relativePath);

// ── 门禁检查（活跃迭代 + 阶段判定） ──────────────────
async function gateCheck(fsPath) {
  const activeFile = join(RUNTIME_DIR, 'ACTIVE');
  let activeId = null;
  if (existsSync(activeFile)) {
    activeId = readFileSync(activeFile, 'utf-8').split('\n')[0].trim();
  }

  if (!activeId || activeId === 'none') {
    block(
      '当前无活跃迭代。',
      '所有代码修改必须经过迭代工作流。',
      '请先创建新迭代（开始迭代 / 进入01阶段）。'
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
    process.exit(0);
  }

  // 01-03 阶段：窄放行——仅豁免目录可写
  // execute_command 无文件路径，不会被 EXEMPT_PATHS 放行（预期行为）
  if (currentPhase === '01' || currentPhase === '02' || currentPhase === '03') {
    for (const pattern of EXEMPT_PATHS) {
      if (fsPath.startsWith(pattern)) {
        process.exit(0);
      }
      if (fsPath.includes('/' + pattern)) {
        process.exit(0);
      }
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
  block(`当前阶段 ${currentPhase} 不允许进行文件写入操作。`);
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

/** 相对路径是否落在工作流 runtime 目录（ALWAYS_ALLOW） */
function isAlwaysAllow(relPath) {
  const p = '/' + String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (RUNTIME_REL && p.startsWith('/' + RUNTIME_REL)) return true;
  return ALWAYS_ALLOW_SEGMENTS.some((seg) => p.includes(seg));
}

/** 删除豁免判定（工程性/维护性删除） */
function isDeleteExempt(relPath) {
  const raw = String(relPath || '');
  if (!raw) return false;
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

/** 从删除类命令段提取候选路径 token */
function extractPathsFromCommand(seg) {
  let s = String(seg || '').replace(/["']/g, ' ');
  s = s.replace(/\s-[a-zA-Z][\w-]*/g, ' ');                 // -Recurse / -Force / -LiteralPath
  s = s.replace(/(?:^|\s)\/[a-zA-Z]{1,3}(?=\s|$)/g, ' ');   // cmd 开关 /q /s /f /y
  s = s.replace(/\b(?:Remove-Item|Remove-ItemProperty|Move-Item|Rename-Item|Copy-Item|erase|rmdir|del|delete_files|delete|remove|rename|move|ren|rni|ri|mi|rm|rd|mv|svn)\b/gi, ' ');
  s = s.replace(/\b(?:cmd|powershell|pwsh|bash|sh|zsh|call|start|exec|xargs)\b/gi, ' ');   // shell 前缀词（非路径）
  const tokens = s.split(/\s+/).map((t) => t.replace(/[;,)]+$/, '')).filter((t) => t && !/^-/.test(t));
  // ★ 优先只校验「像路径」的 token（含分隔符或扩展名），避免 cmd/shell 前缀或裸词干扰豁免判定
  const pathLike = tokens.filter((t) => /[\\/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t));
  return (pathLike.length ? pathLike : tokens).slice(0, 40);
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
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (list.length === 0) {
    block(
      '删除/移动类命令无法自动核验目标路径。',
      `命令: ${label}`,
      '请给出明确路径，或改用「登记 delete_allow + 明确路径」的方式执行。'
    );
  }

  for (const raw of list) {
    if (isDeleteExempt(raw)) continue;
    const rel = toProjectRelative(raw);
    if (rel && Array.isArray(allow) && allow.some((a) => matchDeleteAllow(rel, a))) continue;
    block(
      '删除/移动类操作未在任务清单登记。',
      `目标: ${rel === null ? raw + '（项目外路径）' : rel}`,
      `迭代: ${activeId}`,
      '登记方式: 任务清单增补 DELETED 项 → 用户确认 → 写入 state.yaml 的 delete_allow。',
      '豁免: runtime/ · temp/ · memory/ · node_modules/ · dist/ · obj/ · bin/ · *.bak*'
    );
  }

  // ★ 删除白名单校验通过 → 交回调用方继续走「阶段门禁」（不得直接 exit）：
  //   01-03 仍受 EXEMPT_PATHS 约束；00/05/06/07 仍一律阻止；04 放行。
  audit('DELETE_ALLOW', `${label} → ${list.join(' , ')}`);
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

// ── 阻止输出 ───────────────────────────────────────────
function block(...lines) {
  audit('BLOCK', lines.join(' | '));   // ★ FIX-9：拦截留痕（原仅 BYPASS 有记录）
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
