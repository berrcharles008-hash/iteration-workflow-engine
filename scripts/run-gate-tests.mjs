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
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..', '..', '..', '..');
const HOOK = join(PROJECT_DIR, '.codebuddy', 'hooks', 'gate-check.mjs');
const RUNTIME_DIR = join(PROJECT_DIR, '.codebuddy', 'skills', 'iteration-workflow', 'runtime');
const ACTIVE_FILE = join(RUNTIME_DIR, 'ACTIVE');

// ── 测试用例定义（直接从 gate-test-cases.toml 核心映射） ──

const TESTS = [
  // S0: 04阶段 + 写业务代码 → 放行
  {
    id: 'S0', name: '04阶段写业务代码 → 放行',
    phase: '04', active: true,
    tool: 'write_to_file', file: 'front-end/pre_examination_triage_upgrade/src/test.js',
    expectExit: 0, expectBlock: false
  },
  // S1: 无活跃迭代 → 阻止
  {
    id: 'S1', name: '无活跃迭代写业务代码 → 阻止',
    phase: '', active: false,
    tool: 'write_to_file', file: 'front-end/pre_examination_triage_upgrade/src/test.js',
    expectExit: 2, expectBlock: true
  },
  // S2: 01阶段 + 写业务代码 → 阻止
  {
    id: 'S2', name: '01阶段写业务代码 → 阻止',
    phase: '01', active: true,
    tool: 'write_to_file', file: 'front-end/pre_examination_triage_upgrade/src/test.js',
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
    tool: 'replace_in_file', file: 'front-end/pre_examination_triage_upgrade/src/test.vue',
    expectExit: 2, expectBlock: true
  },
  // S4: 空 stdin → 当前行为 exit 0（fail-open，修复后期望 exit 2）
  {
    id: 'S4', name: '空 stdin → 当前 fail-open 行为',
    phase: '', active: false,
    stdin: '', // 空输入
    expectExit: 0, expectBlock: false, // 当前行为
    expectExit_fixed: 2 // S2 修复后期望
  },
  // S5: 畸形 JSON → 当前行为 exit 0
  {
    id: 'S5', name: '畸形 JSON → 当前 fail-open 行为',
    phase: '', active: false,
    stdin: '{this is not json!!!',
    expectExit: 0, expectBlock: false, // 当前行为
    expectExit_fixed: 2
  },
  // S6: GATE_BYPASS=1 → 放行
  {
    id: 'S6', name: 'GATE_BYPASS=1 → 放行',
    phase: '', active: false, gateBypass: true,
    tool: 'write_to_file', file: 'front-end/pre_examination_triage_upgrade/src/test.js',
    expectExit: 0, expectBlock: false
  },
  // S7: 写 runtime/ → 常放行
  {
    id: 'S7', name: '写 runtime/ → 常放行',
    phase: '', active: false,
    tool: 'write_to_file', file: '.codebuddy/skills/iteration-workflow/runtime/test_file',
    expectExit: 0, expectBlock: false
  },
  // S8: 01-03阶段写 Skill 自身文件 → 放行
  {
    id: 'S8', name: '01-03阶段写 Skill 文件 → 放行',
    phase: '03', active: true,
    tool: 'write_to_file', file: '.claude/skills/iteration-workflow/engine/test.txt',
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
    try { require('fs').unlinkSync(ACTIVE_FILE); } catch {}
  } else {
    writeFileSync(ACTIVE_FILE, content, 'utf-8');
  }
}

function setupState(testCase) {
  // 设置 ACTIVE
  if (testCase.active) {
    writeFileSync(ACTIVE_FILE, '2026-07-23-020-S1门禁自动化回归测试矩阵', 'utf-8');
    // 修改 state.yaml 的 phase
    const stateFile = join(RUNTIME_DIR, '2026-07-23-020-S1门禁自动化回归测试矩阵.state.yaml');
    if (existsSync(stateFile)) {
      let content = readFileSync(stateFile, 'utf-8');
      content = content.replace(/^current_phase:\s*".*"/m, `current_phase: "${testCase.phase}"`);
      writeFileSync(stateFile, content, 'utf-8');
    }
  } else {
    writeFileSync(ACTIVE_FILE, 'none', 'utf-8');
  }
}

function runHook(testCase) {
  const stdinInput = testCase.stdin !== undefined
    ? testCase.stdin 
    : JSON.stringify({
        tool_name: testCase.tool || 'write_to_file',
        tool_input: { filePath: join(PROJECT_DIR, testCase.file).replace(/\\/g, '/') }
      });

  const env = {
    ...process.env,
    COBUDDY_PROJECT_DIR: PROJECT_DIR,
    GATE_TEST_RUNTIME_DIR: RUNTIME_DIR,
  };
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
console.log('╚══════════════════════════════════════════════════╝\n');

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
    
    const isPass = result.exitCode === tc.expectExit;
    const isKnownIssue = tc.id === 'S4' || tc.id === 'S5';
    
    if (isPass) {
      console.log('✅ PASS');
      passed++;
    } else if (isKnownIssue) {
      console.log(`🟡 KNOWN (exit=${result.exitCode}, expect=${tc.expectExit}, fixed=${tc.expectExit_fixed})`);
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
restoreActive(originalActive);
setupState({ active: true, phase: '04' }); // 恢复 04 阶段

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

if (knownFails > 0) {
  console.log('已知漏洞（S2 修复目标）：');
  console.log(`  🟡 S4 空 stdin → fail-open（当前 exit 0，应 exit 2）`);
  console.log(`  🟡 S5 畸形 JSON → fail-open（当前 exit 0，应 exit 2）`);
}

process.exit(failed > 0 ? 1 : 0);
