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
];

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
          tool_input: { filePath: join(PROJECT_DIR, testCase.file).replace(/\\/g, '/') }
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
