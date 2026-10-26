#!/usr/bin/env node
/**
 * project-config.mjs — 运行时项目配置读取器（manifest 的**运行时**消费者）
 *
 * ★ 2026-10-24 迭代 `2026-10-24-001-引擎A10自检与门禁真值源`（批次 1A · G01/G03/G10 共同母机制）
 *
 * 背景（根因）：`project.manifest.yaml` 的消费者此前只有安装期两件（install.ps1/.sh +
 *   inject-template.py），门禁/审计/回归三个**运行时**组件零消费者 ⇒ 想按项目取值只能写字面量
 *   （`manifest.yaml:101-103` 自认「须与 hook 保持一致、不宜改 Hook」）。本模块把配置链接上。
 *
 * 设计约束（三条，均为安全不变量）：
 *   ① **零依赖**：不用 YAML 库（引擎要能被整目录复制到任意项目，不假设 node_modules）。
 *      只解析「顶级键 + 二级标量」——本迭代的消费面（paths.* / project.short_name）正好在二级。
 *   ② **永不 throw**（D2 决议）：任何异常（文件缺失/读失败/结构怪）⇒ 返回 `{found:false, cfg:{}}`，
 *      由调用方回落到现值。**配置读不到 ≠ 放行面放宽**，也绝不能让门禁因本机制抛错而被
 *      入口 shim 的 fail-closed（exit 2）拦死全部工具调用。
 *   ③ **定位顺序**（R-01 决议）：实测项目根**没有** `project/` 目录，权威源在 skill 内
 *      （`<skill>/project/project.manifest.yaml`）。测试态可用 `GATE_MANIFEST_PATH` 覆盖，
 *      但**必须**与 `GATE_TEST_RUNTIME_DIR` 同现 —— 否则该变量就是一个「改配置即改放行面」的
 *      隐式开关（会被误用为绕道），故单现时显式忽略并留痕。
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/** `<skill>/engine/gate` → 上溯 2 级 = `<skill>` */
const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = resolve(HERE, '..', '..');

/** manifest 相对 skill 根 / 项目根的固定位置 */
export const MANIFEST_REL = 'project/project.manifest.yaml';

/** 去掉行内注释与引号；`#` 仅在引号外且前面是空白时才算注释起点 */
function unquote(raw) {
  const v = String(raw == null ? '' : raw);
  let out = '';
  let q = null;
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i];
    if (q) {
      if (ch === q) q = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      out += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(v[i - 1]))) break;
    out += ch;
  }
  let s = out.trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) s = s.slice(1, -1);
  }
  return s.trim();
}

/**
 * 已知顶层段（其下的键被门禁/脚本按**二级标量**消费）—— 用于 indent≥4 的误写诊断。
 * ★ 诊断只进 `errors[]`，**不改解析结果**（放行面零变化）。
 */
const KNOWN_SECTIONS = ['vcs', 'notifications', 'paths'];

/**
 * 解析「顶级键 + 二级标量」为**扁平点号键**（`paths.docs_iterations`）。
 * 三级及以下（如 `database.connections.cis.name`）**有意不解析** —— 消费面不到三级，
 * 解析得更深只会扩大键面与出错面。列表项（`- xxx`）忽略。
 *
 * ★ 2026-10-25（迭代 2026-10-25-002 · C-11）：**只增诊断**（不改判定/返回值）——
 *   ① 已知段下的键若出现在 `indent >= 4` ⇒ 记 error（该键**不会生效**，静默忽略 = 配置陷阱）；
 *   ② 整行含**中文冒号** `：` ⇒ 记 error（YAML 须用 ASCII 冒号 `:`）。
 *   失效形态：4 空格缩进的 `notifications.adapter` ⇒ 回落 `none` ⇒ QQ 通知全静默且**零报错**。
 * @returns {{cfg: Object, errors: string[]}}
 */
export function parseScalars(text) {
  const cfg = {};
  const errors = [];
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let section = null;

  lines.forEach((line, idx) => {
    const no = idx + 1;
    if (/^\s*(#|$)/.test(line)) return;
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      if (/^\s*-/.test(line)) return;                       // 列表项：有意忽略
      if (line.indexOf('：') >= 0) {
        errors.push(`L${no}: 含中文冒号（：），YAML 须用 ASCII 冒号（:）⇒ 该行被忽略`);
        return;
      }
      errors.push(`L${no}: 无法解析（忽略）`);
      return;
    }
    const indent = m[1].length;
    const key = m[2];
    const raw = m[3];

    if (indent === 0) {
      if (raw === '' || raw.startsWith('#')) {
        section = key;
        return;
      }
      cfg[key] = unquote(raw);
      section = null;
      return;
    }
    if (indent <= 2 && section) {
      cfg[`${section}.${key}`] = unquote(raw);
      return;
    }
    // indent >= 4：三级及以下，本读取器不解析（见模块头 ①）—— 但**已知段**下须留诊断
    if (indent >= 4 && section && KNOWN_SECTIONS.indexOf(section) >= 0) {
      errors.push(
        `L${no}: 疑似缩进过深（${indent} 空格）：${section}.${key} —— `
        + '本读取器只解析二级标量（indent<=2）⇒ 该键不会生效',
      );
    }
  });

  return { cfg, errors };
}

/**
 * 按「测试态覆盖 → skill 内权威 → 项目根约定」定位 manifest。
 * @returns {{path: string, source: string, found: boolean, errors: string[]}}
 */
export function resolveManifestPath(projectDir) {
  const errors = [];
  const candidates = [];
  const testMode = Boolean(process.env.GATE_TEST_RUNTIME_DIR);
  const envPath = process.env.GATE_MANIFEST_PATH;

  if (envPath) {
    if (testMode) {
      candidates.push({ path: resolve(String(envPath)), source: 'env:test' });
    } else {
      errors.push('EXEMPT_MANIFEST_IGNORED：GATE_MANIFEST_PATH 须与 GATE_TEST_RUNTIME_DIR 同现（防被当作放行面开关）');
    }
  }
  candidates.push({ path: join(SKILL_ROOT, MANIFEST_REL), source: 'skill' });
  if (projectDir) candidates.push({ path: join(String(projectDir), MANIFEST_REL), source: 'project' });

  for (const c of candidates) {
    if (existsSync(c.path)) return { path: c.path, source: c.source, found: true, errors };
  }
  return { path: candidates[candidates.length - 1].path, source: 'none', found: false, errors };
}

/**
 * 读 manifest → 扁平配置。**永不 throw**（见模块头 ②）。
 * @returns {{found: boolean, path: string, source: string, cfg: Object, errors: string[]}}
 */
export function loadProjectConfig(projectDir) {
  const loc = resolveManifestPath(projectDir);
  if (!loc.found) {
    return { found: false, path: loc.path, source: loc.source, cfg: {}, errors: loc.errors };
  }
  try {
    const text = readFileSync(loc.path, 'utf-8');
    const parsed = parseScalars(text);
    const errors = loc.errors.concat(parsed.errors);
    if (Object.keys(parsed.cfg).length === 0) errors.push('manifest 未解析出任何键（结构可能已变）');
    return { found: true, path: loc.path, source: loc.source, cfg: parsed.cfg, errors };
  } catch (e) {
    return {
      found: false,
      path: loc.path,
      source: loc.source,
      cfg: {},
      errors: loc.errors.concat(['读取失败: ' + String(e && e.message ? e.message : e)]),
    };
  }
}
