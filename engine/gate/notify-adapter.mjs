#!/usr/bin/env node
/**
 * notify-adapter.mjs — 出站通知的**统一适配层**（G11 · 迭代 `2026-10-25-002-引擎VCS归位与脚本去项目化`）
 *
 * 背景（根因）：`gate-check.mjs` 有三处出站通知（阶段推进守卫 / G1 观测提醒 / 会话结束阻断通知），
 *   各自实现「静默预检 + 脚本存在性判定 + spawn」，口径不一致：
 *   · `:530` 的阶段守卫只看 env（`GATE_TEST_RUNTIME_DIR` / `QQ_NOTIFY`）⇒ **漏** `.qq-notify-off` 手动标记；
 *   · `:2266-2289` 的 G1 只认 `notify.qqbot.js` 单向提醒（不带 `#N`）；
 *   · `:2330-2396` 的阻断通知走「入队带 #N」。
 *   ⇒ 新增调用点若忘写预检，就会绕过手动静默开关。
 *
 * 本模块把三处收敛为**一个** `send()` 契约：
 *   · 静默判定**下沉**（test / env / marker 三档）⇒ 调用点不再各自预检；
 *   · `mode` 区分通道（`notify` 单向提醒 / `enqueue` 入队待回执）⇒ 不再靠调用点拼脚本路径；
 *   · 同步返回、永不 throw ⇒ 调用点无需 try/catch，也不会因通知失败影响门禁判定。
 *
 * ★ R3 边界（禁改）：`gate-check.mjs:2375` 的 `ask.js` **不可逆决策回路不入本适配器** ——
 *   理由：`adapter: none` 时不可逆操作会**静默**（用户收不到「需你本人确认」）。
 *   故入站（ask）方向与出站（notify）方向必须分离。
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

/** 静默判定用的**手动标记**相对路径（通道无关；清单本体不在本模块维护） */
export const DEFAULT_OFF_MARKERS = [
  '.codebuddy/hooks/.qq-notify-off',
  '.claude/hooks/.qq-notify-off',
];

/** 通知脚本相对路径（相对项目根） */
const SCRIPT_NOTIFY = 'tools/qqbot/notify.qqbot.js';
const SCRIPT_ENQUEUE = 'tools/qqbot/notify-enqueue.js';

/**
 * 归一化 `notifications.adapter` 取值。
 * @param {*} raw 原始值
 * @returns {{adapter: 'qqbot'|'none', valid: boolean, error: string|null}}
 */
export function normalizeAdapter(raw) {
  if (raw === undefined || raw === null) {
    return { adapter: 'none', valid: false, error: 'NOTIFY_ADAPTER_MISSING' };
  }
  const s = String(raw).trim();
  if (s === '') {
    return { adapter: 'none', valid: false, error: 'NOTIFY_ADAPTER_EMPTY' };
  }
  const low = s.toLowerCase();
  if (low === 'qqbot' || low === 'none') return { adapter: low, valid: true, error: null };
  return { adapter: 'none', valid: false, error: 'NOTIFY_ADAPTER_INVALID:' + s.slice(0, 40) };
}

/**
 * 静默原因（null = 正常发送）—— 下沉自 `gate-check.mjs:2099-2106`。
 * @param {Object} opts
 * @returns {string|null} 'test' | 'env' | 'marker'
 */
export function notifySilentReason({ projectDir, offMarkers } = {}) {
  if (process.env.GATE_TEST_RUNTIME_DIR || process.env.GATE_TEST_DISABLE_BYPASS) return 'test';
  if (process.env.QQ_NOTIFY === '0' || process.env.QQ_NOTIFY === 'off') return 'env';
  const markers = Array.isArray(offMarkers) && offMarkers.length ? offMarkers : DEFAULT_OFF_MARKERS;
  for (const rel of markers) {
    try {
      if (projectDir && existsSync(join(String(projectDir), rel))) return 'marker';
    } catch { /* 读失败按未命中处理 */ }
  }
  return null;
}

/** 按 mode 解析通知脚本（不存在 ⇒ null） */
export function resolveNotifyScript(projectDir, mode) {
  const root = String(projectDir || '');
  if (!root) return null;
  const notifyPath = join(root, SCRIPT_NOTIFY);
  if (mode === 'notify') return existsSync(notifyPath) ? notifyPath : null;
  // enqueue：优先入队脚本（带 #N，可回「确认#N」）；缺失时回落单向提醒
  const enqueuePath = join(root, SCRIPT_ENQUEUE);
  if (existsSync(enqueuePath)) return enqueuePath;
  return existsSync(notifyPath) ? notifyPath : null;
}

/**
 * 创建通知器。
 * @param {Object} opts
 * @param {'qqbot'|'none'} opts.adapter 适配器
 * @param {string} opts.projectDir 项目根（脚本与标记的定位基准）
 * @param {string[]} [opts.offMarkers] 手动静默标记相对路径
 * @param {Function} [opts.audit] 审计回调 `(kind, detail) => void`
 * @returns {{send: Function, adapter: string, errors: string[]}}
 */
export function createNotifier({ adapter, projectDir, offMarkers, audit } = {}) {
  const errors = [];
  const seen = new Set();          // ★ 进程内幂等保险（语义幂等，非防刷屏）
  const log = (kind, detail) => {
    try { if (typeof audit === 'function') audit(kind, detail); } catch { /* 审计失败不影响通知 */ }
  };

  const norm = (adapter === 'qqbot' || adapter === 'none') ? adapter : 'none';
  if (norm !== adapter) errors.push('NOTIFY_ADAPTER_FALLBACK:' + String(adapter));

  return {
    adapter: norm,
    errors,

    /**
     * 发送通知 —— **同步返回、永不 throw**。
     * @param {Object} payload `{mode:'notify'|'enqueue', kind, prompt, rows, ...}`
     * @returns {{sent: boolean, skipped: string|null, target: string}}
     */
    send(payload) {
      const p = payload && typeof payload === 'object' ? payload : {};
      const mode = p.mode === 'notify' ? 'notify' : 'enqueue';
      const fp = String(p.kind || '') + '|' + String(p.prompt || '');

      try {
        // ① adapter:none ⇒ 不投递（语义幂等保险：同 kind+prompt 进程内只留痕一次）
        if (norm === 'none') {
          if (!seen.has(fp)) {
            seen.add(fp);
            log('NOTIFY_NOOP', fp.slice(0, 120));
          }
          return { sent: false, skipped: 'noop', target: '' };
        }

        // ② 静默判定（test / env / marker 三档）—— 下沉后调用点无需各自预检
        const silent = notifySilentReason({ projectDir, offMarkers });
        if (silent) {
          log('NOTIFY_SKIP', 'silent=' + silent + ' :: ' + fp.slice(0, 100));
          return { sent: false, skipped: 'silent', target: '' };
        }

        // ③ 脚本解析（按 mode 分离）
        const target = resolveNotifyScript(projectDir, mode);
        if (!target) {
          log('NOTIFY_SKIP', 'no-script :: mode=' + mode + ' :: ' + fp.slice(0, 100));
          return { sent: false, skipped: 'no-script', target: '' };
        }

        // ④ 投递：detached + unref + stdio:ignore ⇒ 父进程 exit(2) 后子进程仍能把 QQ 发出去
        const child = spawn(process.execPath, [target, '--json', JSON.stringify(p)], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
        log('NOTIFY_SENT', fp.slice(0, 120) + ' :: ' + target);
        return { sent: true, skipped: null, target };
      } catch (e) {
        log('NOTIFY_FAIL', String(e && e.message ? e.message : e).slice(0, 140));
        return { sent: false, skipped: 'spawn-error', target: '' };
      }
    },
  };
}
