#!/usr/bin/env node
/**
 * exempt-tables.mjs — 门禁三张豁免表的**唯一数据源**（字面量 + manifest 派生 + 深比对）
 *
 * ★ 2026-10-24 迭代 `2026-10-24-001-引擎A10自检与门禁真值源`（批次 1A · G01）
 *
 * 为什么把三张表从 gate-check.mjs **搬到这里**（D-03-1 决议）：
 *   `derive-exempt.mjs --print` 必须拿到「字面量现值」才能做等价对账，而
 *   `import gate-check.mjs` 是不可行的 —— 那个文件在模块顶层就消费 stdin 并执行门禁
 *   （还有 process.exit）。若把字面量复制一份给对账用，就变成双源，改一处漏一处即静默漂移。
 *   ⇒ 数据搬家、判定逻辑留在 gate-check.mjs（`matchStageExempt` / `isMetaWriteExempt` 不动）。
 *
 * ★ 本迭代只上 **shadow**：`resolveExemptTables()` 在 shadow 下返回**字面量**，
 *   派生结果只进审计（`EXEMPT_SHADOW`）。因此「放行面零变化」是**构造性**保证，
 *   不依赖测试通过与否。切 `derive` 另开窗口（需独占验证）。
 *
 * ★ 等价性口径（附录 E）：24 项字面量 = 12 项 manifest 派生 + 12 项常量。
 *   派生**保序**（数组顺序即判定顺序，diff 按「集合 + 顺序」双判据）。
 *   缺键**或空串**一律回落现值（`falsy` 语义，两侧实现同口径 —— R-09 决议）。
 */

import { loadProjectConfig } from './project-config.mjs';

/** 引擎自引用（常量 4）—— 与项目配置无关 */
export const SELF_REF_DIRS = [
  '.codebuddy/skills/iteration-workflow/',
  '.claude/skills/iteration-workflow/',
  '.cursor/skills/iteration-workflow/',
  '.codex/skills/iteration-workflow/',
];

/** 工作记忆目录（常量 2）—— 元层写入，与阶段/项目无关 */
export const MEMORY_DIRS = ['.codebuddy/memory/', '.claude/memory/'];

/** 可行性目录（常量 1）—— manifest 至今无 `feasibility_dir` 键（R3 决议：不新增键） */
export const FEASIBILITY_DIR = 'feasibility/';

/**
 * 旧 headless 身份变量名 —— **唯一保留的项目字面量**，登记在 A10_ALLOW #1。
 * 兼容期一版（D3 决议）；删除前置 = 项目侧 `tools/qqbot` 双投递。
 */
export const LEGACY_HANDOFF_ENV = 'PIVAS_HANDOFF_OWNER';

/** 不参与派生的结构常量（files / runtimeFiles 属「匹配形态」，不是目录配置） */
const STAGE_FILES = ['skills/iteration-workflow/project/lessons-learned.md'];
const RUNTIME_FILES = ['ACTIVE', '*.state.yaml'];

/** 缺键/空串回落值 —— 与 2026-10 前门禁的现值逐字节一致 */
export const DEFAULTS = {
  docs_iterations: 'docs/iterations',
  kb_dir: 'docs/knowledge-base',
  specs_dir: 'requirements',
};

/**
 * 冻结的**字面量现值**（改码前快照 `runtime/snapshots/2026-10-24-a10/before/` 逐项对应）。
 * ⚠ 任何取值变更都会改变放行面 ⇒ 必须走四件套 + 3 路评审；`Object.freeze` 只防误赋值。
 */
const rawLiteral = {
  exemptPaths: [
    ...SELF_REF_DIRS,
    'docs/iterations/',
    'docs/knowledge-base/',
    '.codebuddy/memory/',
    '.claude/memory/',
  ],
  exemptPathsMdOnly: ['requirements/iteration-context/'],
  stageExempt: {
    '05': { dirs: ['docs/iterations/', 'docs/knowledge-base/'], mdDirs: ['requirements/'] },
    '06': {
      dirs: ['docs/iterations/', 'docs/knowledge-base/'],
      mdDirs: ['requirements/', 'feasibility/'],
      files: [...STAGE_FILES],
    },
    '07': { dirs: ['docs/iterations/'], files: [...STAGE_FILES] },
    NONE: {
      dirs: ['docs/iterations/'],
      mdDirs: ['requirements/', 'feasibility/'],
      runtimeFiles: [...RUNTIME_FILES],
    },
  },
};

function deepFreeze(obj) {
  Object.values(obj).forEach((v) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  });
  return Object.freeze(obj);
}

export const LITERAL = deepFreeze(rawLiteral);

/** 目录值归一：反斜杠→正斜杠、去尾斜杠、补一个尾斜杠（幂等） */
export function dirOf(value, fallback) {
  const pick = typeof value === 'string' && value.trim() ? value : fallback;
  return String(pick).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

function pathOf(cfg, dotted, fallback) {
  return dirOf(cfg ? cfg[dotted] : undefined, fallback);
}

/**
 * 派生三表（**保序**）。入参是 `loadProjectConfig().cfg`（扁平点号键）。
 * @returns {{exemptPaths: string[], exemptPathsMdOnly: string[], stageExempt: Object}}
 */
export function deriveExemptTables(cfg) {
  const docs = pathOf(cfg, 'paths.docs_iterations', DEFAULTS.docs_iterations);
  const kb = pathOf(cfg, 'paths.kb_dir', DEFAULTS.kb_dir);
  const specs = pathOf(cfg, 'paths.specs_dir', DEFAULTS.specs_dir);
  return {
    exemptPaths: [...SELF_REF_DIRS, docs, kb, ...MEMORY_DIRS],
    exemptPathsMdOnly: [specs + 'iteration-context/'],
    stageExempt: {
      '05': { dirs: [docs, kb], mdDirs: [specs] },
      '06': { dirs: [docs, kb], mdDirs: [specs, FEASIBILITY_DIR], files: [...STAGE_FILES] },
      '07': { dirs: [docs], files: [...STAGE_FILES] },
      NONE: { dirs: [docs], mdDirs: [specs, FEASIBILITY_DIR], runtimeFiles: [...RUNTIME_FILES] },
    },
  };
}

/** 把 stageExempt 摊平成 `05.dirs[0]=docs/iterations/` 形态，便于逐项对账与报错定位 */
export function flattenStage(stageExempt) {
  const out = [];
  const stage = stageExempt || {};
  for (const phase of Object.keys(stage)) {
    const rule = stage[phase] || {};
    for (const field of ['files', 'dirs', 'mdDirs', 'runtimeFiles']) {
      const arr = rule[field];
      if (!Array.isArray(arr)) continue;
      arr.forEach((v, i) => out.push(`${phase}.${field}[${i}]=${v}`));
    }
  }
  return out;
}

function diffList(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  const onlyLiteral = left.filter((x) => !right.includes(x));
  const onlyDerived = right.filter((x) => !left.includes(x));
  // 同集合不同顺序也算差异（数组顺序即判定顺序 ⇒ 等价性按逐项对齐判定）
  const orderMismatch = onlyLiteral.length === 0 && onlyDerived.length === 0
    && left.join('\u0000') !== right.join('\u0000');
  return { onlyLiteral, onlyDerived, orderMismatch };
}

/**
 * 深比对两张三表结构。
 * @returns {{equal: boolean, count: number, exemptPaths: Object, exemptPathsMdOnly: Object, stageExempt: Object}}
 */
export function diffTables(literal, derived) {
  const a = literal || LITERAL;
  const b = derived || a;
  const ep = diffList(a.exemptPaths, b.exemptPaths);
  const md = diffList(a.exemptPathsMdOnly, b.exemptPathsMdOnly);
  const fl = flattenStage(a.stageExempt);
  const fr = flattenStage(b.stageExempt);
  const st = diffList(fl, fr);
  const count = ep.onlyLiteral.length + ep.onlyDerived.length
    + md.onlyLiteral.length + md.onlyDerived.length
    + st.onlyLiteral.length + st.onlyDerived.length;
  const equal = count === 0 && !ep.orderMismatch && !md.orderMismatch && !st.orderMismatch;
  return { equal, count, exemptPaths: ep, exemptPathsMdOnly: md, stageExempt: st };
}

/**
 * 解析出「本模式生效的三表」。
 * shadow（缺省）⇒ 返回**字面量**；derive ⇒ 返回派生。派生/比较结果始终随返回值给出，
 * 供审计（EXEMPT_SHADOW）与 A10-c 对账消费。
 * @param {{mode?: string, projectDir?: string}} opts
 */
export function resolveExemptTables(opts) {
  const options = opts || {};
  const rawMode = String(options.mode == null ? 'shadow' : options.mode).trim().toLowerCase();
  const effMode = rawMode === 'derive' ? 'derive' : 'shadow';
  const errors = [];
  if (rawMode !== 'derive' && rawMode !== 'shadow') {
    errors.push(`非法 GATE_EXEMPT_MODE="${options.mode}" ⇒ 按 shadow 处理（只收紧，不放宽）`);
  }

  const manifest = loadProjectConfig(options.projectDir);
  const derived = deriveExemptTables(manifest.cfg);
  const diff = diffTables(LITERAL, derived);

  return {
    mode: effMode,
    rawMode,
    manifest,
    literal: LITERAL,
    derived,
    diff,
    tables: effMode === 'derive' ? derived : LITERAL,
    errors: errors.concat(manifest.errors || []),
  };
}

/**
 * 派生 headless 身份变量名：`{SHORT_NAME}_HANDOFF_OWNER`。
 * 本项目的 short_name 与旧名前缀同串 ⇒ 行为零变化；新项目才有区分（G03 的收益点）。
 * @returns {string|null} 无 short_name ⇒ null（调用方只认旧名 = 现状）
 */
export function handoffOwnerEnv(cfg) {
  const sn = String((cfg && cfg['project.short_name']) || '').trim().toUpperCase();
  return sn ? `${sn}_HANDOFF_OWNER` : null;
}
