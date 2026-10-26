#!/usr/bin/env node
/**
 * derive-exempt.mjs — 豁免表派生结果的对账出口（`--print` 输单行 JSON）
 *
 * ★ 2026-10-24 迭代 `2026-10-24-001-引擎A10自检与门禁真值源`（批次 1A · G01 / D4 决议）
 *
 * 消费方 = `scripts/audit-engine.py` 的 **A10-c**。定位是「**被检对象**」而非「期望值」：
 *   A10-c 在 Python 侧用自己的二级 YAML 解析**独立**算出期望三表，再与本文件输出比对；
 *   同时把输出与改码前的**冻结基线**（`runtime/snapshots/2026-10-24-a10/before/exempt-tables.json`）
 *   比对。两道比对分别覆盖「派生算错」与「本体自证」两类失效（3 路评审 R-06/R-08）。
 *
 * 契约（`schema: 1`，字段变更即视为破坏性 ⇒ A10-c 报 ERR）：
 *   { schema, project_root, skill_root, manifest{path,source,found,errors[]},
 *     mode, tables{...派生三表...}, literal{...字面量三表...},
 *     diff{equal,count,exemptPaths{onlyLiteral,onlyDerived,orderMismatch},exemptPathsMdOnly{...},stageExempt{...}},
 *     errors[] }
 *
 * 退出码：`0` = 已输出（**含 manifest 缺失**，此时 `manifest.found=false`）；`2` = 缺 `--print`（用法错误）。
 * 之所以 manifest 缺失不报非零：派生回落现值是**合法状态**（D2），不是故障。
 */

import { pathToFileURL } from 'url';
import { resolveExemptTables } from './exempt-tables.mjs';
import { SKILL_ROOT } from './project-config.mjs';

export const SCHEMA = 1;

const norm = (p) => String(p == null ? '' : p).replace(/\\/g, '/');

function argOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

/**
 * 组装对账报告（纯函数，便于单测/被 import）。
 * @param {{projectDir?: string, mode?: string}} opts
 */
export function buildReport(opts) {
  const options = opts || {};
  const resolved = resolveExemptTables({ mode: options.mode, projectDir: options.projectDir });
  const mf = resolved.manifest || {};
  return {
    schema: SCHEMA,
    project_root: norm(options.projectDir || process.cwd()),
    skill_root: norm(SKILL_ROOT),
    manifest: {
      path: norm(mf.path),
      source: mf.source || 'none',
      found: Boolean(mf.found),
      errors: Array.isArray(mf.errors) ? mf.errors : [],
    },
    mode: resolved.mode,
    tables: resolved.derived,
    literal: resolved.literal,
    diff: resolved.diff,
    errors: resolved.errors || [],
  };
}

function main(argv) {
  if (!argv.includes('--print')) {
    process.stderr.write(
      '用法：node engine/gate/derive-exempt.mjs --print [--mode shadow|derive] [--project-root <dir>]\n'
      + '  输出单行 JSON（schema=1），供 audit-engine.py 的 A10-c 对账。\n'
    );
    return 2;
  }
  const report = buildReport({
    projectDir: argOf(argv, '--project-root') || process.cwd(),
    mode: argOf(argv, '--mode') || process.env.GATE_EXEMPT_MODE || 'shadow',
  });
  process.stdout.write(JSON.stringify(report) + '\n');
  return 0;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
