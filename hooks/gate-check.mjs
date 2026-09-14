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
 * 1. ALWAYS_ALLOW（runtime/）→ 无条件放行
 * 2. 逃生口（GATE_BYPASS 环境变量 或 .gate-bypass 标记文件）→ 放行
 * 3. execute_command → 命令风险分级：纯读放行，危险命令走门禁
 * 4. 无活跃迭代 → 阻止
 * 5. 04-开发实现 → 放行（合法修改业务代码窗口）
 * 6. 01-03 阶段 → 仅 EXEMPT_PATHS 放行，其余阻止
 * 7. 其他阶段 → 阻止
 *
 * 退出码：0=放行  2=阻止（阻塞错误，工具不执行）
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

/** 任何阶段都无条件放行的路径（状态维护） */
const ALWAYS_ALLOW = ['runtime/'];

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

/** 需要检查的写入工具名（兼容多平台） */
const WATCHED_TOOLS = [
  // CodeBuddy
  'write_to_file', 'replace_in_file', 'delete_file',
  // Claude Code
  'Write', 'Edit',
  // 终端命令（命令级风险分级，非全部拦截）
  'execute_command',
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
if (toolName === 'execute_command') {
  const cmd = (hookInput.tool_input || {}).command || '';

  // ★ FIX-7：先按「段」找危险，再决定放行 —— 顺序不可颠倒。
  // 旧实现先判 SAFE（^ 锚定整条命令行首）再判 DANGEROUS，导致首段为
  // cd / echo / dir 等安全前缀时，后续的 del / Remove-Item / 重定向 /
  // 解释器内联（node -e、python -c）被整条放行。
  const segments = splitCommandChain(cmd);
  const dangerSeg = segments.find((seg) => isDangerousSegment(seg));

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
  process.exit(0);
}

// ── 标准化路径 ─────────────────────────────────────────
const projectDirNorm = PROJECT_DIR.replace(/\\/g, '/');
const filePathNorm = filePath.replace(/\\/g, '/');
const relativePath = filePathNorm.startsWith(projectDirNorm)
  ? filePathNorm.slice(projectDirNorm.length + 1)
  : filePathNorm;

// ── 第1关：ALWAYS_ALLOW ────────────────────────────────
for (const pattern of ALWAYS_ALLOW) {
  if (relativePath.includes(pattern)) {
    process.exit(0);
  }
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
