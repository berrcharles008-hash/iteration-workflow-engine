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
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
  if (IDE_ARG === 'codebuddy') {
    env.CODEBUDDY_PROJECT_DIR = PROJECT_DIR;
    delete env.CLAUDE_PROJECT_DIR;
  } else {
    env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    delete env.CODEBUDDY_PROJECT_DIR;
  }
  if (testCase.gateBypass) {
    env.GATE_BYPASS = '1';
  }

  try {
    execFileSync('node', [HOOK], {
      input: stdinInput,
      env,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    const result = runHook(tc);
    cleanupBypassFile(tc);
    
    const isPass = result.exitCode === tc.expectExit;
    // 已知漏洞用例须在用例定义上显式标注 knownIssue: true（当前无）
    const isKnownIssue = !!tc.knownIssue;
    
    if (isPass) {
      console.log('✅ PASS');
      passed++;
    } else if (isKnownIssue) {
      console.log(`🟡 KNOWN (exit=${result.exitCode}, expect=${tc.expectExit})`);
      knownFails++;
    } else {
      console.log(`❌ FAIL (exit=${result.exitCode}, expect=${tc.expectExit})`);
      failed++;
    }

    results.push({
      id: tc.id,
      exitCode: result.exitCode,
      expectExit: tc.expectExit,
      isPass,
      isKnownIssue,
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
