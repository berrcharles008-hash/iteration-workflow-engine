#!/usr/bin/env node
/**
 * 门禁回归测试执行器
 * 
 * 读取 engine/gate-test-cases.toml 中的 L3 用例，
 * 逐一模拟 stdin 输入 → 调用 gate-check.mjs → 比较退出码。
 * 
 * 用法: node scripts/run-gate-tests.mjs
 * 输出: 各用例 PASS/FAIL + 汇总统计
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, rmSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');

// ── 参数解析 ──────────────────────────────────────────
// --project-root <path>  用指定项目根（默认为隔离沙箱）
// --runtime-dir  <path>  指定 ACTIVE/state.yaml 读写目录
// --ide <name>           claude-code | codebuddy（默认自动）
// --quick                install 脚本会传入，接受（仅精简明细输出）
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const QUICK = argv.includes('--quick');
const IDE_ARG = argOf('--ide');

// ── 项目根 ────────────────────────────────────────────
// 注意：hook 以 PROJECT_DIR 判定 GATE_BYPASS_PATHS 与相对路径，
// 故测试进程与 hook 必须收到同一个值。
// 默认使用隔离沙箱，避免在真实项目里创建 .gate-bypass 等临时文件。
// 旧的 join(__dirname,'..','..','..','..') 只在「部署布局」下成立
// （skill 位于 {PROJECT}/{IDE}/skills/iteration-workflow），
// 在引擎仓库内运行会解析成盘符根（如 D:\），故改为显式/隔离策略。
const SANDBOX = join(tmpdir(), `iwf-gate-selftest-${process.pid}`);
const REAL_PROJECT_DIR = argOf('--project-root');
const PROJECT_DIR = REAL_PROJECT_DIR || SANDBOX;
const ISOLATED = !REAL_PROJECT_DIR;
if (ISOLATED) mkdirSync(PROJECT_DIR, { recursive: true });

// ── Hook 定位 ─────────────────────────────────────────
// 1) skill 自带 hooks/（引擎仓库与「hooks 已随 skill 部署」的项目都存在）
// 2) 真实项目下项目级 hooks/（install Step 4 的安装位置）
function resolveHook() {
  const local = join(SKILL_ROOT, 'hooks', 'gate-check.mjs');
  if (existsSync(local)) return local;

  const projReal = REAL_PROJECT_DIR
    || process.env.CODEBUDDY_PROJECT_DIR
    || process.env.CLAUDE_PROJECT_DIR
    || process.cwd();
  const ide = IDE_ARG || (process.env.CODEBUDDY_PROJECT_DIR ? 'codebuddy' : 'claude-code');
  const ordered = ide === 'codebuddy' ? ['.codebuddy', '.claude'] : ['.claude', '.codebuddy'];
  for (const d of ordered) {
    const p = join(projReal, d, 'hooks', 'gate-check.mjs');
    if (existsSync(p)) return p;
  }
  console.error('❌ 未找到 gate-check.mjs，已尝试:');
  console.error('   ' + local);
  for (const d of ordered) console.error('   ' + join(projReal, d, 'hooks', 'gate-check.mjs'));
  process.exit(3);
}
const HOOK = resolveHook();

// ── 运行时目录 ────────────────────────────────────────
// 始终隔离（可用 --runtime-dir 或 GATE_TEST_RUNTIME_DIR 覆盖），
// 因此本脚本不会再改写真实项目的 runtime/ACTIVE。
const RUNTIME_DIR = argOf('--runtime-dir')
  || process.env.GATE_TEST_RUNTIME_DIR
  || join(SANDBOX, 'runtime');
mkdirSync(RUNTIME_DIR, { recursive: true });
const ACTIVE_FILE = join(RUNTIME_DIR, 'ACTIVE');

// hook 只取 ACTIVE 首行作为迭代 ID，再从 {id}.state.yaml 读 current_phase
const TEST_ITERATION_ID = 'selftest-gate-regression';

// ── 测试用例定义（直接从 gate-test-cases.toml 核心映射） ──

// ★ FIX-26（2026-10-01）：命令通道用例的绝对路径前缀。
//   用「部署布局」形态 `{PROJECT_DIR}/{IDE}/skills/iteration-workflow/runtime/` —— 与真实项目一致；
//   ALWAYS_ALLOW 的段字面量 `/skills/iteration-workflow/runtime/` 正是按该形态匹配**绝对路径**的。
const PROJ_ABS = PROJECT_DIR.replace(/\\/g, '/');
const RT_ABS = `${PROJ_ABS}/.codebuddy/skills/iteration-workflow/runtime`;
/** 构造 Bash 用例的 stdin（固定 tool_name=Bash + command） */
const bashCase = (id, name, phase, command, expectExit) => ({
  id, name, phase, active: true,
  stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
  expectExit, expectBlock: expectExit === 2,
});

const TESTS = [
  // S0: 04阶段 + 写业务代码 → 放行
  {
    id: 'S0', name: '04阶段写业务代码 → 放行',
    phase: '04', active: true,
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/test.js',
    expectExit: 0, expectBlock: false
  },
  // S1: 无活跃迭代 → 阻止
  {
    id: 'S1', name: '无活跃迭代写业务代码 → 阻止',
    phase: '', active: false,
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/test.js',
    expectExit: 2, expectBlock: true
  },
  // S2: 01阶段 + 写业务代码 → 阻止
  {
    id: 'S2', name: '01阶段写业务代码 → 阻止',
    phase: '01', active: true,
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/test.js',
    expectExit: 2, expectBlock: true
  },
  // S2b: 01阶段 + 写豁免目录 → 放行
  {
    id: 'S2b', name: '01阶段写豁免目录 → 放行',
    phase: '01', active: true,
    tool: 'write_to_file', file: 'docs/iterations/test.md',
    expectExit: 0, expectBlock: false
  },
  // S3: 05阶段 + 写业务代码 → 阻止
  {
    id: 'S3', name: '05阶段写业务代码 → 阻止',
    phase: '05', active: true,
    tool: 'replace_in_file', file: 'front-end/my-app-upgrade/src/test.vue',
    expectExit: 2, expectBlock: true
  },
  // S4: 空 stdin → fail-closed 阻止（hook 已完成 fail-closed 修复）
  {
    id: 'S4', name: '空 stdin → fail-closed 阻止',
    phase: '', active: false,
    stdin: '', // 空输入
    expectExit: 2, expectBlock: true
  },
  // S5: 畸形 JSON → fail-closed 阻止
  {
    id: 'S5', name: '畸形 JSON → fail-closed 阻止',
    phase: '', active: false,
    stdin: '{this is not json!!!',
    expectExit: 2, expectBlock: true
  },
  // S6: GATE_BYPASS=1 → 放行
  {
    id: 'S6', name: 'GATE_BYPASS=1 → 放行',
    phase: '', active: false, gateBypass: true,
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/test.js',
    expectExit: 0, expectBlock: false
  },
  // S7: 写 runtime/ → 常放行
  {
    id: 'S7', name: '写 runtime/ → 常放行',
    phase: '', active: false,
    tool: 'write_to_file', file: 'runtime/test_file',
    expectExit: 0, expectBlock: false
  },
  // S8: 01-03阶段写 Skill 自身文件 → 放行
  {
    id: 'S8', name: '01-03阶段写 Skill 文件 → 放行',
    phase: '03', active: true,
    tool: 'write_to_file', file: '.claude/skills/iteration-workflow/engine/test.txt',
    expectExit: 0, expectBlock: false
  },

  // ── Phase E: 多IDE场景测试（去平台化验证）────────────────
  // E1: .claude/hooks/.gate-bypass → 放行（验证多路径检测）
  {
    id: 'E1', name: '.claude .gate-bypass → 放行',
    phase: '', active: false,
    gateBypassFile: '.claude/hooks/.gate-bypass',
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/test.js',
    expectExit: 0, expectBlock: false
  },
  // E2: .cursor/hooks/.gate-bypass → 放行（验证 cursor 路径）
  {
    id: 'E2', name: '.cursor .gate-bypass → 放行',
    phase: '', active: false,
    gateBypassFile: '.cursor/hooks/.gate-bypass',
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/test.js',
    expectExit: 0, expectBlock: false
  },
  // E3: 01阶段写 .cursor/skills/... → 放行（验证 EXEMPT_PATHS 含 cursor）
  {
    id: 'E3', name: '01阶段写 Cursor Skill → 放行',
    phase: '01', active: true,
    tool: 'write_to_file', file: '.cursor/skills/iteration-workflow/test.txt',
    expectExit: 0, expectBlock: false
  },
  // E4: 01阶段写 .codex/skills/... → 放行（验证 EXEMPT_PATHS 含 codex）
  {
    id: 'E4', name: '01阶段写 Codex Skill → 放行',
    phase: '01', active: true,
    tool: 'write_to_file', file: '.codex/skills/iteration-workflow/test.txt',
    expectExit: 0, expectBlock: false
  },
  // E5: .codex/hooks/.gate-bypass → 放行（验证 codex 路径）
  {
    id: 'E5', name: '.codex .gate-bypass → 放行',
    phase: '', active: false,
    gateBypassFile: '.codex/hooks/.gate-bypass',
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/test.js',
    expectExit: 0, expectBlock: false
  },

  // ── Phase CONC（★CONC-1 多会话写者互斥）──────────────────────────────
  // phase 一律 04（全放行）⇒ 任何拦截只可能来自 CONC 保护本身（隔离变量）。
  // 声明文件在 $RUNTIME_DIR 内跨用例持久 ⇒ 顺序敏感，勿重排、勿并行。
  // CONC-1 会话A 首次写 → 放行 + 登记声明
  {
    id: 'CONC-1', name: '会话A首次写 → 放行（登记声明）',
    phase: '04', active: true, sid: 'sidAAAAAAAAAAAAAAAA',
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/conc-test.js',
    expectExit: 0, expectBlock: false
  },
  // CONC-2 同会话再写同文件 → 放行（不拦自己）
  {
    id: 'CONC-2', name: '同会话再写同文件 → 放行（不拦自己）',
    phase: '04', active: true, sid: 'sidAAAAAAAAAAAAAAAA',
    tool: 'replace_in_file', file: 'front-end/my-app-upgrade/src/conc-test.js',
    expectExit: 0, expectBlock: false
  },
  // CONC-3 他会话写同文件 → 阻止（拦一次）
  {
    id: 'CONC-3', name: '他会话写同文件 → 阻止（拦一次）',
    phase: '04', active: true, sid: 'sidBBBBBBBBBBBBBBBB',
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/conc-test.js',
    expectExit: 2, expectBlock: true
  },
  // CONC-4 他会话重试同文件 → 放行（「拦一次」语义，防对方崩溃后死锁）
  {
    id: 'CONC-4', name: '他会话重试同文件 → 放行（拦一次语义）',
    phase: '04', active: true, sid: 'sidBBBBBBBBBBBBBBBB',
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/conc-test.js',
    expectExit: 0, expectBlock: false
  },
  // CONC-5 第三方会话 + CONC_LOCK=0 → 关闭保护，放行
  {
    id: 'CONC-5', name: 'CONC_LOCK=0 → 关闭保护放行',
    phase: '04', active: true, sid: 'sidCCCCCCCCCCCCCCCC', env: { CONC_LOCK: '0' },
    tool: 'write_to_file', file: 'front-end/my-app-upgrade/src/conc-test.js',
    expectExit: 0, expectBlock: false
  },

  // ★ MAINT-3 P-5（2026-09-22）：MEMORY.md 写入侧配额守卫（与迭代阶段无关）
  {
    id: 'P5-A', name: 'MEMORY.md 写后估算 8200 → 阻止（超配额）',
    phase: '', active: false,
    tool: 'write_to_file', file: '.codebuddy/memory/MEMORY.md',
    toolInput: { content: 'x'.repeat(8200) },
    expectExit: 2, expectBlock: true
  },
  {
    id: 'P5-B', name: 'MEMORY.md 写后估算 7300 → 放行（仅告警）',
    phase: '', active: false,
    tool: 'write_to_file', file: '.codebuddy/memory/MEMORY.md',
    toolInput: { content: 'x'.repeat(7300) },
    expectExit: 0, expectBlock: false
  },
  {
    id: 'P5-C', name: 'MEMORY.md 写后估算 1000 → 放行（常规）',
    phase: '', active: false,
    tool: 'write_to_file', file: '.codebuddy/memory/MEMORY.md',
    toolInput: { content: 'x'.repeat(1000) },
    expectExit: 0, expectBlock: false
  },
  {
    id: 'P5-D', name: '逃生口优先：超配额 + 开闸 → 放行',
    phase: '', active: false, gateBypass: true,
    tool: 'write_to_file', file: '.codebuddy/memory/MEMORY.md',
    toolInput: { content: 'x'.repeat(8200) },
    expectExit: 0, expectBlock: false
  },

  // ★ GATE-5（2026-09-23 用户批准）：外置「项目记忆」目录（~/{IDE}/projects/<slug>/memory/**）
  //   与迭代阶段无关（FIX-11 同层）；放行面严格限定 memory/ 子目录。
  {
    id: 'G5-A', name: '01阶段写外置项目记忆 → 放行（GATE-5 修复点）',
    phase: '01', active: true,
    tool: 'write_to_file', file: 'C:/Users/tester/.codebuddy/projects/proj-slug/memory/note.md',
    toolInput: { content: 'x' },
    expectExit: 0, expectBlock: false
  },
  {
    id: 'G5-B', name: '01阶段写项目目录非 memory 子目录 → 仍阻止（放行面严格）',
    phase: '01', active: true,
    tool: 'write_to_file', file: 'C:/Users/tester/.codebuddy/projects/proj-slug/sessions/transcript.jsonl',
    toolInput: { content: 'x' },
    expectExit: 2, expectBlock: true
  },
  {
    id: 'G5-C', name: '无活跃迭代写外置项目记忆 → 放行（元层，与迭代状态无关）',
    phase: '', active: false,
    tool: 'write_to_file', file: 'C:/Users/tester/.codebuddy/projects/proj-slug/memory/MEMORY.md',
    toolInput: { content: 'x' },
    expectExit: 0, expectBlock: false
  },
  {
    id: 'G5-D', name: '01阶段删外置项目记忆 → 放行（删除豁免同口径）',
    phase: '01', active: true,
    tool: 'delete_file', file: 'C:/Users/tester/.codebuddy/projects/proj-slug/memory/old-note.md',
    expectExit: 0, expectBlock: false
  },

  // ── ★ FIX-26（2026-10-01）：state 归档命令误拦收口（同目录改名解析 + runtime/ 维护命令豁免）──
  // 起因：`Rename-Item -LiteralPath '<runtime>/x.state.yaml' -NewName 'x.state.archived.yaml'`
  //   被以「目标 2026-…state.archived.yaml 未登记 delete_allow」拦下（裸名不含目录分量）。
  //   ★ 锚定：A 组=放行（含两端均在 runtime/），B/C/D/E/G 组=负向对照（必须仍然拦）。
  bashCase('F26-A', '01阶段 Rename-Item 裸名(源+目标均在 runtime/) → 放行',
    '01', `Rename-Item -LiteralPath '${RT_ABS}/2026-09-18-001-x.state.yaml' -NewName '2026-09-18-001-x.state.archived.yaml'`, 0),
  bashCase('F26-B', '01阶段 Rename-Item 裸名(源在业务目录) → 阻止',
    '01', `Rename-Item -LiteralPath '${PROJ_ABS}/back-end/a.cs' -NewName 'a.archived.cs'`, 2),
  bashCase('F26-C', '01阶段 Rename-Item -NewName 带路径(../业务) → 阻止（不代解析）',
    '01', `Rename-Item -LiteralPath '${RT_ABS}/x.state.yaml' -NewName '../back-end/a.cs'`, 2),
  bashCase('F26-D', '01阶段 命令目标含上跳段 runtime/../hooks → 阻止（.. 守卫）',
    '01', `Remove-Item '${RT_ABS}/../hooks/x.mjs'`, 2),
  bashCase('F26-E', '01阶段 删业务文件 → 阻止（命令通道未放宽）',
    '01', `Remove-Item '${PROJ_ABS}/back-end/a.cs'`, 2),
  bashCase('F26-F', '01阶段 Move-Item 两端均在 runtime/ → 放行（通道对齐）',
    '01', `Move-Item -LiteralPath '${RT_ABS}/x.state.yaml' -Destination '${RT_ABS}/x.state.archived.yaml'`, 0),
  bashCase('F26-G', '01阶段 混合目标(runtime/ + 业务) → 阻止（全目标判定）',
    '01', `Remove-Item '${RT_ABS}/x.tmp' '${PROJ_ABS}/back-end/a.cs'`, 2),
  bashCase('F26-H', '04阶段 runtime/ 归档 → 放行（与旧行为一致）',
    '04', `Rename-Item -LiteralPath '${RT_ABS}/y.state.yaml' -NewName 'y.state.archived.yaml'`, 0),
];

// ── S8：阶段推进留痕观测（RESUME-3 批次 3 路线 I · ALLOW+NOTIFY · 2026-10-01）──
  // 写 state.yaml 且 current_phase 变更：观测态一律放行（exit 0），QQ 告警在沙箱内静默
  // （notifyPhaseGuard 见 GATE_TEST_RUNTIME_DIR ⇒ 仅 audit 留痕）。断言重点是「不误拦」。
  {
    const rtRel = '.codebuddy/skills/iteration-workflow/runtime/' + TEST_ITERATION_ID + '.state.yaml';
    TESTS.push(
      { // S8a: 推进无留痕 → 放行 + 告警（观测态核心语义）
        id: 'S8a', name: '阶段推进(04→05)无 phase_confirm → 放行(观测态告警)',
        phase: '04', active: true,
        tool: 'write_to_file', file: rtRel,
        toolInput: { content: 'iteration_status: "active"\ncurrent_phase: "05"\n' },
        expectExit: 0, expectBlock: false
      },
      { // S8b: 推进 + 合法留痕（ide 带 quote）→ 放行（CONFIRMED 路径）
        id: 'S8b', name: '阶段推进(04→05)含合法 phase_confirm(ide+quote) → 放行',
        phase: '04', active: true,
        tool: 'write_to_file', file: rtRel,
        toolInput: { content: 'iteration_status: "active"\ncurrent_phase: "05"\nphase_confirm:\n  from: "04"\n  to: "05"\n  by: "ide"\n  at: "2026-10-01T14:10:00"\n  quote: "通过，进入05"\n' },
        expectExit: 0, expectBlock: false
      },
      { // S8c: 留痕 by=ide 无 quote → 仍放行但告警（无效留痕口径）
        id: 'S8c', name: '阶段推进(04→05)phase_confirm(ide 无 quote=无效) → 放行(告警)',
        phase: '04', active: true,
        tool: 'write_to_file', file: rtRel,
        toolInput: { content: 'iteration_status: "active"\ncurrent_phase: "05"\nphase_confirm:\n  from: "04"\n  to: "05"\n  by: "ide"\n  at: "2026-10-01T14:10:00"\n' },
        expectExit: 0, expectBlock: false
      },
      { // S8d: replace_in_file 模拟替换路径：phase 行未变更 → 无告警放行
        id: 'S8d', name: 'replace_in_file 写 state.yaml 但 current_phase 未变更 → 放行(无告警)',
        phase: '04', active: true,
        tool: 'replace_in_file', file: rtRel,
        toolInput: { old_str: 'iteration_status: "active"', new_str: 'iteration_status: "active"\n# touch' },
        expectExit: 0, expectBlock: false
      }
    );
  }

// ── 06T：`..` 穿越守卫（TRAVERSAL-1 · 2026-10-02 · 迭代 2026-10-02-001）──
//   背景：探针实测 `docs/iterations/../../back-end/…` 曾命中豁免**直接放行**（01-03 与 05 均成立）
//   ⇒ 存在无需开闸、无 `gate_window` 留痕的写业务码通道。本组为「只收紧」改动的双向回归。
//   ★ 用例必须用 `toolInput.filePath` 覆盖 —— `file` 会经 `path.join` 归一化而**丢失** `..` 形态。
{
  const jump = (sub) => `${PROJ_ABS}/docs/iterations/../../${sub}`;
  TESTS.push(
    { // A：01-03 主路径，穿越写业务码 ⇒ 拦（本组核心）
      id: '06T-A', name: '03阶段 穿越 docs/iterations/../../back-end/… → 拦截',
      phase: '03', active: true,
      tool: 'write_to_file', file: 'docs/iterations/t.md',
      toolInput: { filePath: jump('back-end/my-app-upgrade/src/t.js') },
      expectExit: 2, expectBlock: true
    },
    { // B：防误伤 —— 合法迭代文档仍放行
      id: '06T-B', name: '03阶段 合法 docs/iterations/t.md → 放行（防误伤）',
      phase: '03', active: true,
      tool: 'write_to_file', file: 'docs/iterations/t.md',
      expectExit: 0, expectBlock: false
    },
    { // C：05 阶段同款穿越 ⇒ 拦
      id: '06T-C', name: '05阶段 穿越 docs/iterations/../../back-end/… → 拦截',
      phase: '05', active: true,
      tool: 'write_to_file', file: 'docs/iterations/t.md',
      toolInput: { filePath: jump('back-end/my-app-upgrade/src/t.js') },
      expectExit: 2, expectBlock: true
    },
    { // D：防误伤 —— 05 本职文档仍放行
      id: '06T-D', name: '05阶段 合法 docs/iterations/t.md → 放行（防误伤）',
      phase: '05', active: true,
      tool: 'write_to_file', file: 'docs/iterations/t.md',
      expectExit: 0, expectBlock: false
    },
    { // E：memory 前缀跳板 ⇒ 拦
      id: '06T-E', name: 'memory 跳板 .codebuddy/memory/../../temp/t.md → 拦截',
      phase: '03', active: true,
      tool: 'write_to_file', file: 'docs/iterations/t.md',
      toolInput: { filePath: `${PROJ_ABS}/.codebuddy/memory/../../temp/t.md` },
      expectExit: 2, expectBlock: true
    },
    { // F：防误伤 —— memory 本目录仍放行
      id: '06T-F', name: 'memory 合法 .codebuddy/memory/t.md → 放行（防误伤）',
      phase: '03', active: true,
      tool: 'write_to_file', file: '.codebuddy/memory/t.md',
      expectExit: 0, expectBlock: false
    },
    { // G：误伤负向 —— `..` 非完整段不得误判
      id: '06T-G', name: '误伤负向 docs/iterations/a..b/t.md → 放行',
      phase: '03', active: true,
      tool: 'write_to_file', file: 'docs/iterations/a..b/t.md',
      expectExit: 0, expectBlock: false
    },
    { // H：误伤负向 —— `v1.2..3` 含 `..` 但非段
      id: '06T-H', name: '误伤负向 docs/iterations/v1.2..3/t.md → 放行',
      phase: '03', active: true,
      tool: 'write_to_file', file: 'docs/iterations/v1.2..3/t.md',
      expectExit: 0, expectBlock: false
    }
  );
}

// ── SHIM：转发层「反推 / fail-closed」三态（FIX-48 · 2026-10-11；四件套见 runtime/FIX-48-四件套.md v2）──
//   背景：CLI bg worktree 隔离区缺 engine/** ⇒ 原 5 候选全空 ⇒ fail-closed 拦死 headless job；
//   修复 = shim 从 `<根>/.git`（`gitdir: <主仓库>/.git/worktrees/<id>`）反推主仓库实现。
//   ★ 用例直调「sandbox 内 shim 副本」+ 显式 projectDirOverride —— 否则本地候选会命中真实项目实现，测不到边界。
{
  const implRel = join('.codebuddy', 'skills', 'iteration-workflow', 'engine', 'gate', 'gate-check.mjs');
  const implProj = dirname(dirname(dirname(HOOK)));   // 项目布局：<proj>/.codebuddy/hooks/x → <proj>
  const mkShimSb = (n) => {
    const sb = join(SANDBOX, n);
    mkdirSync(join(sb, '.codebuddy', 'hooks'), { recursive: true });
    copyFileSync(HOOK, join(sb, '.codebuddy', 'hooks', 'gate-check.mjs'));
    return sb;
  };
  const sbEmpty = mkShimSb('shim-empty');             // ② 无 .git 且无实现（负向）
  const sbBad = mkShimSb('shim-bad');                 // ③ .git 内容损坏 → 反推失败回落
  writeFileSync(join(sbBad, '.git'), 'not-a-gitdir-line\n', 'utf-8');
  const shimOf = (sb) => join(sb, '.codebuddy', 'hooks', 'gate-check.mjs');
  const passInput = JSON.stringify({ tool_name: 'write_to_file', tool_input: { filePath: 'front-end/x/y.js' } });
  const cases = [
    { // ② 候选全空 → fail-closed（负向对照）
      id: 'SHIM-2', name: 'shim 无实现(无.git) → fail-closed(2)',
      phase: '04', active: true,
      hookOverride: shimOf(sbEmpty), projectDirOverride: sbEmpty, stdin: passInput,
      expectExit: 2, expectBlock: true
    },
    { // ③ .git 损坏 → 反推失败 ⇒ 不追加候选 ⇒ fail-closed（不放大放行面）
      id: 'SHIM-3', name: 'shim .git 损坏 → 反推失败回落(2)',
      phase: '04', active: true,
      hookOverride: shimOf(sbBad), projectDirOverride: sbBad, stdin: passInput,
      expectExit: 2, expectBlock: true
    }
  ];
  if (existsSync(join(implProj, implRel))) {          // ① 反推命中（仅当本仓库布局下可定位实现时启用）
    const sbWt = mkShimSb('shim-wt');
    writeFileSync(join(sbWt, '.git'),
      'gitdir: ' + implProj.replace(/\\/g, '/') + '/.git/worktrees/fake-selftest\n', 'utf-8');
    cases.unshift({
      id: 'SHIM-1', name: 'shim worktree 反推命中主仓库实现 → 放行(0)',
      phase: '04', active: true,
      hookOverride: shimOf(sbWt), projectDirOverride: sbWt, stdin: passInput,
      expectExit: 0, expectBlock: false
    });
  } else {
    console.log('  [SHIM] ⚠ 未能定位项目实现（' + join(implProj, implRel) + '），SHIM-1 跳过（SHIM-2/3 仍跑）');
  }
  TESTS.push(...cases);
}

// ── HOST：宿主自适应 runtime 解析（★ FIX-49 v2.4 · 四件套 ③-12 · R1/R18/R25）──────
//   背景：改造前 51 例**全部**经 `GATE_TEST_RUNTIME_DIR` 短路 + harness 强制注入 PROJECT_DIR env
//   ⇒ 宿主解析三层（注入/环境/自身位置）零覆盖（三处假绿，R1/R18）。
//   判据设计（SENTINEL，P2）：两侧 runtime 同置 ACTIVE + state，但**阶段不同** ——
//     本侧 `.codebuddy` = `04`（写业务码放行）/ 另一侧 `.claude` = `01`（写业务码拦截）
//     ⇒ **exit code 即可判定"读的是哪一侧"**（0=读本侧 / 2=读另一侧）。
//   组内统一**白名单式清 4 变量**：GATE_TEST_RUNTIME_DIR（第一优先级短路）/ GATE_HOST_IDE /
//     CODEBUDDY_PROJECT_DIR / CLAUDE_PROJECT_DIR（身份源）—— 随后各用例按需显式设置（hostEnv）。
{
  const HOST_SB = join(SANDBOX, 'host');
  const RUNTIME_REL = join('skills', 'iteration-workflow', 'runtime');
  const IMPL_IN_SIDE = join('skills', 'iteration-workflow', 'engine', 'gate', 'gate-check.mjs');
  const IMPL_SRC = join(dirname(dirname(dirname(HOOK))), '.codebuddy', IMPL_IN_SIDE);  // 项目实现（真源）
  const HAS_IMPL = existsSync(IMPL_SRC);
  const SENTINEL_ID = 'SENTINEL-ITER';
  const BIZ = JSON.stringify({ tool_name: 'write_to_file', tool_input: { filePath: 'front-end/x/y.js' } });

  /** 建 HOST 隔离小根；spec = { '.codebuddy': {phase, seed, rt}, '.claude': {...} } */
  const mkHost = (name, spec) => {
    const sb = join(HOST_SB, name);
    for (const dot of ['.codebuddy', '.claude']) {
      const cfg = spec[dot];
      if (!cfg) continue;
      if (cfg.rt === false) continue;
      const rt = join(sb, dot, RUNTIME_REL);
      mkdirSync(rt, { recursive: true });
      if (cfg.seed === false) continue;
      writeFileSync(join(rt, 'ACTIVE'), SENTINEL_ID + '\n', 'utf-8');
      writeFileSync(join(rt, SENTINEL_ID + '.state.yaml'),
        ['iteration_status: "active"', `current_phase: "${cfg.phase || '04'}"`, ''].join('\n'), 'utf-8');
    }
    return sb;
  };
  const BOTH = { '.codebuddy': { phase: '04' }, '.claude': { phase: '01' } };
  const auditPath = (sb, dot) => join(sb, dot, RUNTIME_REL, 'gate-audit.log');
  const auditText = (sb, dot) => (existsSync(auditPath(sb, dot)) ? readFileSync(auditPath(sb, dot), 'utf-8') : '');
  const auditCount = (sb, dot) => auditText(sb, dot).split('\n').filter(Boolean).length;
  /** 把实现副本装到指定侧（用于「实现自身位置」层：5 级上溯 = `.codebuddy`/`.claude`） */
  const mkImplIn = (sb, dot) => {
    const dst = join(sb, dot, IMPL_IN_SIDE);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(IMPL_SRC, dst);
    return dst;
  };
  /** 把实现副本装到**不可识别**目录（`_impl` ⇒ 身份层③ 失效；用于测 ①② 层与 H11） */
  const mkImplForeign = (sb) => {
    const dst = join(sb, '_impl', IMPL_IN_SIDE);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(IMPL_SRC, dst);
    return dst;
  };
  const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

  const cases = [];
  if (!HAS_IMPL) {
    console.log('  [HOST] ⚠ 未能定位项目实现（' + IMPL_SRC + '）—— HOST 组跳过');
  } else {
    // H1 注入层（本侧）
    {
      const sb = mkHost('h1', BOTH);
      cases.push({
        id: 'H1', name: 'HOST 注入=codebuddy → 读 .codebuddy(04) 放行(0)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: IMPL_SRC, stdin: BIZ, expectExit: 0,
        hostEnv: { GATE_HOST_IDE: 'codebuddy' },
        assert: () => ({
          ok: auditText(sb, '.codebuddy').includes('host=codebuddy') && auditCount(sb, '.claude') === 0,
          detail: 'cb=' + auditCount(sb, '.codebuddy') + ' cl=' + auditCount(sb, '.claude'),
        }),
      });
    }
    // H2 注入层（另一侧）—— 与 H1 同形异侧 ⇒ 证明判据有区分性
    {
      const sb = mkHost('h2', BOTH);
      cases.push({
        id: 'H2', name: 'HOST 注入=claude → 读 .claude(01) 拦截(2)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: IMPL_SRC, stdin: BIZ, expectExit: 2,
        hostEnv: { GATE_HOST_IDE: 'claude' },
        assert: () => ({
          ok: auditText(sb, '.claude').includes('host=claude') && auditCount(sb, '.codebuddy') === 0,
          detail: 'cb=' + auditCount(sb, '.codebuddy') + ' cl=' + auditCount(sb, '.claude'),
        }),
      });
    }
    // H3 环境变量层（CODEBUDDY_PROJECT_DIR）—— 实现装在不可识别目录 ⇒ 层③ 失效，只剩 ②
    {
      const sb = mkHost('h3', BOTH);
      cases.push({
        id: 'H3', name: 'HOST 无注入+CODEBUDDY_PROJECT_DIR → codebuddy(0)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: mkImplForeign(sb), stdin: BIZ, expectExit: 0,
        hostEnv: { CODEBUDDY_PROJECT_DIR: sb },
        assert: () => ({
          ok: auditText(sb, '.codebuddy').includes('host=codebuddy') && auditCount(sb, '.claude') === 0,
          detail: 'cb=' + auditCount(sb, '.codebuddy') + ' cl=' + auditCount(sb, '.claude'),
        }),
      });
    }
    // H4 实现自身位置层（R1 修正后可达：不再被 harness 强制注入遮蔽）
    {
      const sb = mkHost('h4', BOTH);
      cases.push({
        id: 'H4', name: 'HOST 全清 env → 实现自身位置层 ⇒ codebuddy(0)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: mkImplIn(sb, '.codebuddy'), stdin: BIZ, expectExit: 0,
        assert: () => ({
          ok: auditText(sb, '.codebuddy').includes('host=codebuddy') && auditCount(sb, '.claude') === 0,
          detail: 'cb=' + auditCount(sb, '.codebuddy') + ' cl=' + auditCount(sb, '.claude'),
        }),
      });
    }
    // H5 身份已知 + 本侧 runtime 缺失 ⇒ **不消费另一侧**（fail-closed 分支；另一侧是 04 放行态）
    {
      const sb = mkHost('h5', { '.claude': { phase: '04' } });
      cases.push({
        id: 'H5', name: 'HOST 本侧缺失 → 不消费另一侧(0→2)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: IMPL_SRC, stdin: BIZ, expectExit: 2,
        hostEnv: { GATE_HOST_IDE: 'codebuddy' },
        assert: () => ({
          ok: auditCount(sb, '.claude') === 0,
          detail: 'cl=' + auditCount(sb, '.claude') + '（另一侧 04 放行态未被消费）',
        }),
      });
    }
    // H6 端到端（P1）：经**真实 shim** 副本跑一次写入 ⇒ 审计行含 host=codebuddy 且落本侧
    {
      const sb = mkHost('h6', BOTH);
      mkdirSync(join(sb, '.codebuddy', 'hooks'), { recursive: true });
      const shimCopy = join(sb, '.codebuddy', 'hooks', 'gate-check.mjs');
      copyFileSync(HOOK, shimCopy);
      mkImplIn(sb, '.codebuddy');
      cases.push({
        id: 'H6', name: 'HOST 端到端：真实 shim → 本侧审计 host=codebuddy',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: shimCopy, stdin: BIZ, expectExit: 0,
        assert: () => ({
          ok: auditText(sb, '.codebuddy').includes('host=codebuddy') && auditCount(sb, '.claude') === 0,
          detail: 'cb=' + auditCount(sb, '.codebuddy') + ' cl=' + auditCount(sb, '.claude'),
        }),
      });
    }
    // H7 旧 shim 负向（R14）：无注入的转发 shim（模拟 FIX-49 前的部署）⇒ 层③ 仍判本侧
    {
      const sb = mkHost('h7', BOTH);
      const impl = mkImplIn(sb, '.codebuddy');
      const legacy = join(sb, '_legacy-shim.mjs');
      writeFileSync(legacy, "await import('" + pathToFileURL(impl).href + "');\n", 'utf-8');
      cases.push({
        id: 'H7', name: 'HOST 旧 shim（无注入）→ 层③ 仍读本侧(0)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: legacy, stdin: BIZ, expectExit: 0,
        assert: () => ({
          ok: auditText(sb, '.codebuddy').includes('host=codebuddy') && auditCount(sb, '.claude') === 0,
          detail: 'cb=' + auditCount(sb, '.codebuddy') + ' cl=' + auditCount(sb, '.claude'),
        }),
      });
    }
    // H8 分发完整性（P5）：shim 源含 FIX-49 注入段 + 沙箱副本与源逐字节一致 + 实现含 FIX-49 标记
    {
      cases.push({
        id: 'H8', name: 'HOST 分发完整性：shim 含注入 + MD5 一致',
        phase: '04', active: true, hostMode: true, expectExit: undefined,
        customRun: () => ({ exitCode: 0, stderr: '' }),
        assert: () => {
          const shimTxt = readFileSync(HOOK, 'utf-8');
          const sb6Shim = join(HOST_SB, 'h6', '.codebuddy', 'hooks', 'gate-check.mjs');
          const same = existsSync(sb6Shim) && md5(HOOK) === md5(sb6Shim);
          const ok = shimTxt.includes('GATE_HOST_IDE') && readFileSync(IMPL_SRC, 'utf-8').includes('FIX-49') && same;
          return { ok, detail: 'shim注入=' + shimTxt.includes('GATE_HOST_IDE') + ' md5一致=' + same };
        },
      });
    }
    // H9 α 态（R38/P0-6）：本侧 runtime 空 + 另一侧有活跃迭代 ⇒ NONE 分支 + 纠偏文案（不消费另一侧）
    {
      const sb = mkHost('h9', { '.codebuddy': { seed: false }, '.claude': { phase: '04' } });
      cases.push({
        id: 'H9', name: 'HOST α 态：本侧空 → 不消费另一侧 + 纠偏文案',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: IMPL_SRC, stdin: BIZ, expectExit: 2,
        hostEnv: { GATE_HOST_IDE: 'codebuddy' },
        assert: (r) => ({
          ok: String(r.stderr || '').includes('检测到另一侧') && String(r.stderr || '').includes('请勿新建迭代')
            && auditCount(sb, '.claude') === 0,
          detail: 'stderr文案=' + String(r.stderr || '').includes('请勿新建迭代') + ' cl=' + auditCount(sb, '.claude'),
        }),
      });
    }
    // H10 写侧路由（R8 甲）：直写**非本侧**镜像面文件 ⇒ block + 指引
    {
      const sb = mkHost('h10', BOTH);
      const otherActive = join(sb, '.claude', RUNTIME_REL, 'ACTIVE').replace(/\\/g, '/');
      cases.push({
        id: 'H10', name: 'HOST 直写非本侧镜像面(另一侧 ACTIVE) → block(2)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: IMPL_SRC, expectExit: 2,
        stdin: JSON.stringify({ tool_name: 'write_to_file', tool_input: { filePath: otherActive } }),
        hostEnv: { GATE_HOST_IDE: 'codebuddy' },
        assert: (r) => ({
          ok: String(r.stderr || '').includes('镜像面') && String(r.stderr || '').includes('sync-runtime'),
          detail: '文案命中=' + String(r.stderr || '').includes('镜像面'),
        }),
      });
    }
    // H10b 负向对照：**本侧**镜像面写入维持放行（证明 H10 拦的是"非本侧"而非"镜像面"）
    {
      const sb = mkHost('h10b', BOTH);
      const ownActive = join(sb, '.codebuddy', RUNTIME_REL, 'ACTIVE').replace(/\\/g, '/');
      cases.push({
        id: 'H10b', name: 'HOST 负向对照：写本侧镜像面 → 放行(0)',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: IMPL_SRC, expectExit: 0,
        stdin: JSON.stringify({ tool_name: 'write_to_file', tool_input: { filePath: ownActive } }),
        hostEnv: { GATE_HOST_IDE: 'codebuddy' },
      });
    }
    // H11 fail-closed（R1）：身份三级全空（实现装在不可识别目录）⇒ exit 2 + 明确 stderr + 零审计
    {
      const sb = mkHost('h11', BOTH);
      cases.push({
        id: 'H11', name: 'HOST 身份解析失败 → fail-closed(2) + 零审计',
        phase: '04', active: true, hostMode: true, cwdOverride: sb,
        hookOverride: mkImplForeign(sb), stdin: BIZ, expectExit: 2,
        assert: (r) => {
          const se = String(r.stderr || '');
          return {
            ok: se.includes('FIX-49') && se.includes('fail-closed')
              && auditCount(sb, '.codebuddy') === 0 && auditCount(sb, '.claude') === 0,
            detail: 'stderr=' + se.slice(0, 60) + ' cb=' + auditCount(sb, '.codebuddy'),
          };
        },
      });
    }
  }
  TESTS.push(...cases);
}

// ── 工具函数 ──────────────────────────────────────────

function backupActive() {
  if (existsSync(ACTIVE_FILE)) {
    return readFileSync(ACTIVE_FILE, 'utf-8').trim();
  }
  return null;
}

function restoreActive(content) {
  if (content === null) {
    // 文件原本不存在，清理
    try { unlinkSync(ACTIVE_FILE); } catch {}
  } else {
    writeFileSync(ACTIVE_FILE, content, 'utf-8');
  }
}

function setupState(testCase) {
  // 设置 ACTIVE
  if (testCase.active) {
    writeFileSync(ACTIVE_FILE, TEST_ITERATION_ID, 'utf-8');
    // state.yaml 必须「创建」而非仅在已存在时改写：
    // hook 在状态文件缺失时会直接阻止，导致所有 active 用例误判为 exit 2。
    const stateFile = join(RUNTIME_DIR, `${TEST_ITERATION_ID}.state.yaml`);
    writeFileSync(stateFile, [
      'iteration_status: "active"',
      `current_phase: "${testCase.phase}"`,
      '',
    ].join('\n'), 'utf-8');
  } else {
    writeFileSync(ACTIVE_FILE, 'none', 'utf-8');
  }

  // 创建 gate-bypass 标记文件（Phase E: 多IDE路径测试）
  if (testCase.gateBypassFile) {
    const bypassPath = join(PROJECT_DIR, testCase.gateBypassFile);
    mkdirSync(dirname(bypassPath), { recursive: true });
    writeFileSync(bypassPath, '', 'utf-8');
  }
}

/** 清理 gate-bypass 标记文件 */
function cleanupBypassFile(testCase) {
  if (testCase.gateBypassFile) {
    const bypassPath = join(PROJECT_DIR, testCase.gateBypassFile);
    try { unlinkSync(bypassPath); } catch {}
    // 尝试删除父目录（如果为空）
    try { rmdirSync(dirname(bypassPath)); } catch {}
  }
}

function runHook(testCase) {
  const stdinInput = testCase.stdin !== undefined
    ? testCase.stdin 
    : JSON.stringify(Object.assign(
        {
          tool_name: testCase.tool || 'write_to_file',
          tool_input: Object.assign(
            { filePath: join(PROJECT_DIR, testCase.file).replace(/\\/g, '/') },
            // ★ MAINT-3 P-5（2026-09-22）：配额守卫用例需注入 content / old_str / new_str
            testCase.toolInput || {}
          )
        },
        // ★CONC-1：按用例注入会话标识（2026-09-20 探针实证 stdin 含 session_id）
        testCase.sid ? { session_id: testCase.sid } : {}
      ));

  const env = {
    ...process.env,
    GATE_TEST_RUNTIME_DIR: RUNTIME_DIR,
  };
  // ★ FIX-48（2026-10-11）：清 headless 身份变量 —— 否则在 headless job 内跑回归时，
  //   实现层 FIX-47 豁免会把一切放行 ⇒ 全绿假象（评审片3 风险项 R13）。
  //   需测 headless 语义时用 testCase.env 显式注入（Object.assign 在其后）。
  delete env.PIVAS_HANDOFF_OWNER;
  // ★CONC-1：会话标识须可判定 —— 指定 sid 时同步设 env（双源一致）；
  //   未指定时**清空继承值**，避免真实会话 id 泄漏进沙箱用例（保证可复现）。
  if (testCase.sid) env.CODEBUDDY_SESSION_ID = testCase.sid;
  else { delete env.CODEBUDDY_SESSION_ID; delete env.CLAUDE_SESSION_ID; }
  // ★CONC-1：按用例注入额外环境变量（如 CONC_LOCK=0 关闭保护）
  if (testCase.env) Object.assign(env, testCase.env);
  // ★ RESUME-3（2026-10-01）：非逃生口用例一律禁用逃口（FIX-10 开关，只更严格不构成绕道）——
  //   否则 .gate-bypass 标记存在期间（如本次实施开闸）全部用例被逃口短路放行 = 假绿（实测复现）。
  //   逃生口用例（gateBypass=env / gateBypassFile=标记文件）保留真实逃生口语义。
  if (!testCase.gateBypass && !testCase.gateBypassFile) env.GATE_TEST_DISABLE_BYPASS = '1';
  // hook 的项目根优先级：CODEBUDDY_PROJECT_DIR > CLAUDE_PROJECT_DIR > cwd。
  // 旧代码写入的是 COBUDDY_PROJECT_DIR（少一个 E），hook 不识别，等于从未传递；
  // 这里显式设置目标变量并清除另一个，避免外部环境变量抢占优先级。
  // ★ FIX-48：SHIM 组用例需把 hook 视角的项目根指向沙箱（默认 = PROJECT_DIR）
  const hookProjDir = testCase.projectDirOverride || PROJECT_DIR;
  if (IDE_ARG === 'codebuddy') {
    env.CODEBUDDY_PROJECT_DIR = hookProjDir;
    delete env.CLAUDE_PROJECT_DIR;
  } else {
    env.CLAUDE_PROJECT_DIR = hookProjDir;
    delete env.CODEBUDDY_PROJECT_DIR;
  }
  if (testCase.gateBypass) {
    env.GATE_BYPASS = '1';
  }

  // ★ FIX-49 HOST 组（R1/R18）：**白名单式清 4 变量**后再按用例显式设置 ——
  //   ① `GATE_TEST_RUNTIME_DIR`：RUNTIME_DIR 第一优先级短路（不清 ⇒ 读侧恒为沙箱 runtime，宿主解析零覆盖）
  //   ② `GATE_HOST_IDE` / `CODEBUDDY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR`：身份源（上方刚被强制写入
  //      其一，不清则身份层②恒命中、层③永不可达）
  if (testCase.hostMode) {
    delete env.GATE_TEST_RUNTIME_DIR;
    delete env.GATE_HOST_IDE;
    delete env.CODEBUDDY_PROJECT_DIR;
    delete env.CLAUDE_PROJECT_DIR;
    if (testCase.hostEnv) Object.assign(env, testCase.hostEnv);
  }

  const opts = {
    input: stdinInput,
    env,
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  // ★ FIX-49 HOST 组：cwd = 隔离小根 ⇒ 无 env 时 PROJECT_DIR 由 cwd 兜底（层③ 用例可达）
  if (testCase.cwdOverride) opts.cwd = testCase.cwdOverride;

  try {
    // ★ FIX-48：SHIM 组用例直调沙箱内 shim 副本（默认 = 项目 shim/实现）
    execFileSync('node', [testCase.hookOverride || HOOK], opts);
    return { exitCode: 0, stderr: '' };
  } catch (err) {
    // 非零退出码
    return { exitCode: err.status || 1, stderr: err.stderr || '' };
  }
}

// ── 主流程 ────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  门禁回归测试 — L3 Hook 层                        ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`  Hook        : ${HOOK}`);
console.log(`  PROJECT_DIR : ${PROJECT_DIR}${ISOLATED ? '   (隔离沙箱)' : '   (⚠ 真实项目)'}`);
console.log(`  RUNTIME_DIR : ${RUNTIME_DIR}\n`);

const originalActive = backupActive();
let passed = 0;
let failed = 0;
let knownFails = 0; // 已知漏洞（S4/S5 fail-open）
const results = [];

for (const tc of TESTS) {
  process.stdout.write(`  [${tc.id}] ${tc.name.padEnd(40, ' ')} `);
  
  try {
    setupState(tc);
    // ★ FIX-49 HOST 组：支持自定义 runner（H8 为静态分发完整性检查，无 hook 调用）
    const result = tc.customRun ? tc.customRun() : runHook(tc);
    cleanupBypassFile(tc);

    // ★ FIX-49 HOST 组：expectExit === undefined ⇒ 只跑 assert（静态检查类用例）
    let isPass = tc.expectExit === undefined || result.exitCode === tc.expectExit;
    let assertDetail = '';
    if (isPass && typeof tc.assert === 'function') {
      const a = tc.assert(result) || { ok: true };
      isPass = !!a.ok;
      assertDetail = a.detail || '';
    }
    // 已知漏洞用例须在用例定义上显式标注 knownIssue: true（当前无）
    const isKnownIssue = !!tc.knownIssue;

    if (isPass) {
      console.log('✅ PASS');
      passed++;
    } else if (isKnownIssue) {
      console.log(`🟡 KNOWN (exit=${result.exitCode}, expect=${tc.expectExit})`);
      knownFails++;
    } else {
      console.log(`❌ FAIL (exit=${result.exitCode}, expect=${tc.expectExit})${assertDetail ? ' | ' + assertDetail : ''}`);
      failed++;
    }

    results.push({
      id: tc.id,
      exitCode: result.exitCode,
      expectExit: tc.expectExit,
      isPass,
      isKnownIssue,
      assertDetail,
      stderr: result.stderr ? result.stderr.substring(0, 200) : '',
    });
  } catch (err) {
    console.log(`💥 ERROR: ${err.message}`);
    failed++;
    results.push({ id: tc.id, exitCode: -1, error: err.message });
  }
}

// 恢复现场
// 原先此处还会执行 setupState({active:true, phase:'04'})，
// 会把「无活跃迭代」误改为「04 阶段活跃迭代」，属破坏性副作用，已移除。
restoreActive(originalActive);
if (ISOLATED) {
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
}

// ── 汇总 ──────────────────────────────────────────────

console.log(`\n───────────────────────────────────────────────────`);
console.log(`  TOTAL: ${TESTS.length}  |  ✅ ${passed}  |  🟡 ${knownFails}  |  ❌ ${failed}`);
console.log(`  通过率: ${((passed + knownFails) / TESTS.length * 100).toFixed(0)}%（含已知漏洞 ${knownFails} 例）`);
console.log(`───────────────────────────────────────────────────\n`);

if (failed > 0) {
  console.log('待修复的意外失败：');
  results.filter(r => !r.isPass && !r.isKnownIssue).forEach(r => {
    console.log(`  ❌ [${r.id}] exit=${r.exitCode} expect=${r.expectExit}`);
  });
}

if (knownFails > 0 && !QUICK) {
  console.log('已知漏洞（待修复，不计入失败）：');
  results.filter(r => r.isKnownIssue).forEach(r => {
    console.log(`  🟡 [${r.id}] exit=${r.exitCode} expect=${r.expectExit}`);
  });
}

process.exit(failed > 0 ? 1 : 0);
