#!/usr/bin/env node
/**
 * vcs-profile.mjs — VCS 判定表的**单源**（G12 · 迭代 `2026-10-25-002-引擎VCS归位与脚本去项目化`）
 *
 * 背景（根因）：`gate-check.mjs` 此前把 VCS 相关判定写成**内联字面量**（危险表 git/svn 两行、
 *   `GIT_CHANGE_VERBS` 动词集、`isDeleteSegment` 的 svn 分支），项目无法按自身 VCS 取值调整放行面。
 *   本模块把「一族一表」抽出来，按 `project/project.manifest.yaml` 的 `vcs.type` 派生。
 *
 * ★ 三条安全不变量（缺一即破坏放行面）：
 *   ① **缺省档逐元素等价**：未配置 / 空串 / 非法值 ⇒ 等价于改前的全量表（含 flags、含顺序）。
 *      方向性：任何取值相对现值**只会更少拦截**，不会更多。
 *   ② **只搬既有字面量**：每个元素都是 `gate-check.mjs` 里的原 RegExp 字面量，
 *      **禁止** `new RegExp([...].join('|'))` 式拼接（极易造出 `^(?:)` 之类的全匹配正则 ⇒ 放行面全开）。
 *   ③ **探针守卫**：产物正则必须**不匹配**探针串 `__gate_probe_no_match__`；
 *      仅靠「source 非空」拦不住 `^(?:)`（其 source 非空）。
 *
 * 纯函数、零 IO：配置由调用方（`gate-check.mjs`）读好后传入 `cfg`（扁平点号键）。
 */

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/** `<skill>/engine/gate` → 上溯 2 级 = `<skill>`（本模块自身不用，仅为可追溯性保留定位信息） */
const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = resolve(HERE, '..', '..');

/**
 * 探针串 —— 用于断言「产物正则不会匹配任意文本」。
 * 失效形态：`/^(?:)/` 这类 source 非空但全匹配的表达式会让所有命令落入危险表 ⇒ 静默放行。
 */
export const PROBE = '__gate_probe_no_match__';

/**
 * VCS 子动词集（svn / git 共用）—— 搬运自 `gate-check.mjs:1690` 与 `:1688` 的**同一枚字面量**
 * （两处原本逐字相同 ⇒ 单一常量不改变行为）。
 * 锚定 `^...$` ⇒ 对探针串不匹配 ⇒ 探针守卫天然通过。
 */
const DELETE_SUBS_RE = /^(?:rm|mv|delete|move|remove|rename|del)$/;

/** git 变更动词集 —— 搬运自 `gate-check.mjs:1017`（`GIT_CHANGE_VERBS`） */
const GIT_CHANGE_VERB_LIST = ['commit', 'push', 'reset', 'rebase', 'merge', 'cherry-pick', 'stash'];

/**
 * 危险命令表（搬运自 `gate-check.mjs:752-762`）—— **有序**带 tag 元素表。
 *
 * ⚠️ **顺序即语义**：过滤（按 tag）保持相对顺序 ⇒ 缺省档（svn+git+base）的产物与改前数组
 * **逐元素、逐顺序**相等。改动本表顺序 ⇒ 破坏不变量 ①。
 *
 * tag 语义：`base` = 与 VCS 族无关的通用项；`git`/`svn` = 该族专属项。
 */
const DANGEROUS_ELEMENTS = [
  { tag: 'base', re: /[^=>-]>\s*\S/ },                                                     // 输出重定向（排除 >> / -> / =>）
  { tag: 'base', re: />>\s*\S/ },                                                          // 追加重定向
  { tag: 'git', re: /\bgit\s+(?:commit|push|reset|rebase|merge|cherry-pick|stash)\b/i },  // Git 变更类
  { tag: 'svn', re: /\bsvn\s+(?:commit|ci|delete|rm|move|mv|copy|cp|import)\b/i },        // SVN 变更类
  { tag: 'base', re: /\b(?:Compress-Archive|Expand-Archive)\b/i },                         // 打包/压缩（可能覆盖文件）
];

/**
 * 纯读命令表（搬运自 `gate-check.mjs:854-864`）—— **死表**（全文零代码引用，M-1）⇒ 搬而不拆。
 *
 * ⚠️ `:860` 是 git+svn **合并**条目：因该表当前无消费者，拆分为两条对本迭代零收益，
 *   故**原样搬入**并标 `base`（保持「无条件存在」的现值语义），注释标注拆分预留。
 *   ★ 拆分预留：若日后该表复活，需拆成 `git`/`svn` 两个 tag 条目并复核 §一 语义矩阵。
 */
const SAFE_ELEMENTS = [
  { tag: 'base', re: /^(?:echo|cat|type|dir|ls|pwd|whoami|hostname|date|time|ver|uname|printenv|env)\b/i },
  { tag: 'base', re: /^(?:where|which|find|grep|Select-String|sls)\b/i },                     // 文本搜索
  { tag: 'base', re: /^(?:head|tail|sort|uniq|wc)\b/i },                                      // 流处理
  { tag: 'base', re: /^(?:Get-Content|gc|Get-ChildItem|gci|Get-Location|gl)\b/i },             // PowerShell 只读
  { tag: 'base', re: /^(?:Get-Process|gps|Get-Service|gsv)\b/i },                             // 进程/服务查看
  { tag: 'base', re: /^(?:git\s+(?:status|log|diff|show|branch|remote|stash\s+list)|svn\s+(?:status|log|info|list|ls|cat|diff|update|up|checkout|co|export))\b/i }, // ★ 拆分预留（git+svn 合并条）
  { tag: 'base', re: /^(?:npm|yarn|pnpm|dotnet|msbuild|node|python|ruby|java)\b/i },           // 构建/运行工具
  { tag: 'base', re: /^(?:code\s+--|code\s+-r\s)/i },                                        // VS Code 控制
  { tag: 'base', re: /^(?:cd|chdir|pushd|popd|Set-Location|sl)\b/i },                         // 目录切换
];

/**
 * 归一化 `vcs.type` 取值。
 * @param {*} raw 原始值（可能是 undefined / null / 字符串）
 * @returns {{type: 'svn'|'git'|'none', valid: boolean, error: string|null}}
 */
export function normalizeVcsType(raw) {
  if (raw === undefined || raw === null) {
    return { type: 'svn', valid: false, error: 'VCS_TYPE_MISSING' };
  }
  const s = String(raw).trim();
  if (s === '') {
    // P-198：空串等同缺键（回落 svn = 现值），但**留痕**不静默
    return { type: 'svn', valid: false, error: 'VCS_TYPE_EMPTY' };
  }
  const low = s.toLowerCase();
  if (low === 'svn' || low === 'git' || low === 'none') {
    // 大小写 / 前后空格 ⇒ 归一化，不报错（V1-H）
    return { type: low, valid: true, error: null };
  }
  return { type: 'svn', valid: false, error: 'VCS_TYPE_INVALID:' + s.slice(0, 40) };
}

/** 该 vcs 档启用的族（tag 集合）—— 缺省 svn 档 = base + svn + git（= 现值） */
function enabledTags(type) {
  if (type === 'none') return ['base'];
  if (type === 'git') return ['base', 'git'];
  return ['base', 'svn', 'git'];   // svn（缺省/非法回落）
}

/** 按 tag 过滤 + 空 source 过滤 + 探针断言（保持原顺序） */
function pick(elements, tags) {
  const out = [];
  for (const el of elements) {
    if (!tags.includes(el.tag)) continue;
    if (!el.re || String(el.re.source || '').trim() === '') continue;   // 空 source 守卫
    if (el.re.test(PROBE)) {
      throw new Error('VCS_PROFILE_ALLMATCH:' + String(el.re.source));  // 探针守卫（命中 ⇒ 抛错 ⇒ 回落全量现值）
    }
    out.push(el.re);
  }
  return out;
}

/**
 * 解析 VCS 档 —— **纯函数**、永不 throw（内部异常一律回落为「等价现值」的缺省档）。
 * @param {Object} cfg 扁平点号键配置（`{ 'vcs.type': 'svn', ... }`）
 * @returns {{vcsType: string, source: string, patterns: {dangerous: RegExp[], safe: RegExp[]},
 *            deleteSegmentSubs: Map<string, RegExp>, gitChangeVerbs: Set<string>,
 *            gitDeleteSubs: RegExp|null, errors: string[]}}
 */
export function resolveVcsProfile(cfg) {
  try {
    const raw = cfg && typeof cfg === 'object' ? cfg['vcs.type'] : undefined;
    const { type, valid, error } = normalizeVcsType(raw);
    const tags = enabledTags(type);

    // source：manifest = 显式配置且合法；default = 缺键/空串；invalid = 非法值
    const source = valid ? 'manifest' : (error && error.indexOf('INVALID') >= 0 ? 'invalid' : 'default');

    const patterns = {
      dangerous: pick(DANGEROUS_ELEMENTS, tags),
      safe: pick(SAFE_ELEMENTS, tags),
    };

    // 删除段子命令表：★ **不得含 git 键** —— `gate-check.mjs:1684-1688` 的 git 只读例外
    //   （clean -n / restore --staged / checkout --）必须先于查表，否则只读例外被短路。
    const deleteSegmentSubs = new Map();
    if (tags.includes('svn')) deleteSegmentSubs.set('svn', DELETE_SUBS_RE);

    // git 族启用时：变更动词集 + 删除子动词正则（未启用 ⇒ 空集 / null）
    const gitOn = tags.includes('git');
    const gitChangeVerbs = new Set(gitOn ? GIT_CHANGE_VERB_LIST : []);
    const gitDeleteSubs = gitOn ? DELETE_SUBS_RE : null;

    const errors = error ? [error] : [];
    return { vcsType: type, source, patterns, deleteSegmentSubs, gitChangeVerbs, gitDeleteSubs, errors };
  } catch (e) {
    // 内部异常（含探针命中）⇒ 回落**等价现值**的缺省档（收紧方向，绝不放宽）
    return literalProfile('VCS_PROFILE_INTERNAL_ERROR:' + String(e && e.message ? e.message : e));
  }
}

/** 未过滤全量现值（回退用）—— 与改前的两张表逐元素、逐顺序相等 */
export const LITERAL_VCS_PATTERNS = {
  dangerous: DANGEROUS_ELEMENTS.map((el) => el.re),
  safe: SAFE_ELEMENTS.map((el) => el.re),
};

/**
 * 全量现值档（回退用）—— `gate-check.mjs` 的 IIFE catch 分支直接消费本对象。
 * ★ 必须是**等价现值**（含 svn 删除段生效、git 族生效）⇒ 不得缺项，否则回退方向会变成「放宽」。
 */
export function literalProfile(note) {
  const deleteSegmentSubs = new Map();
  deleteSegmentSubs.set('svn', DELETE_SUBS_RE);
  return {
    vcsType: 'svn',
    source: 'default',
    patterns: LITERAL_VCS_PATTERNS,
    deleteSegmentSubs,
    gitChangeVerbs: new Set(GIT_CHANGE_VERB_LIST),
    gitDeleteSubs: DELETE_SUBS_RE,
    errors: note ? [String(note).slice(0, 140)] : [],
  };
}
