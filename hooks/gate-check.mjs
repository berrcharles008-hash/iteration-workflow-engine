#!/usr/bin/env node
/**
 * 修改门禁检查钩子 —— 入口转发层（薄壳）
 *
 * 真正的门禁实现位于 skill 包内：
 *   <IDE_DIR>/skills/iteration-workflow/engine/gate/gate-check.mjs
 *
 * 为何拆成两层（2026-10-01 用户拍板）：
 *   IDE 会对「CodeBuddy 自身的安全敏感配置」——`.codebuddy/hooks/**`、settings.json 等——
 *   的写入强制弹窗人工确认；该确认独立于 autoApprovalSettings（实测 editFiles/executeCommands
 *   全开、maxRequests=-1 仍会弹），也无法通过 codingcopilot.disabledSecurityCategories 关闭
 *   （实测其可选类别仅 injection / scriptExec / powershell，均为命令内容扫描，不含文件写入保护）。
 *   把易变的门禁逻辑放进 skill 包内（`.codebuddy/skills/**`，实测写入不触发确认），
 *   本文件从此基本不再改动 ⇒ 迭代中调整门禁策略无需人工点「运行」。
 *
 * 分发保证（改造时已逐项核对，install/sync-back 均零改动）：
 *   · install.ps1 Step 2：@("engine","domain-plugins","scripts") 用 Copy-Item -Recurse 整目录复制
 *   · install.sh       Step 4：cp 单文件复制本 shim 到 <IDE_DIR>/hooks/
 *   · sync-back        ：Get-ChildItem -Recurse -File 递归回流 engine/ 任意深度新增文件
 *   ⇒ 新项目安装 skill 时实现文件自动就位。
 *
 * 退出码：与实现一致（0=放行，2=阻止）；实现缺失时 fail-closed（2），
 *         避免出现 install.ps1 注释所警惕的「Hook 静默失效」。
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url)); // <ROOT>/.codebuddy/hooks
const IDE_DIR = dirname(HOOK_DIR);                        // <ROOT>/.codebuddy
const ROOT = process.env.CODEBUDDY_PROJECT_DIR
  || process.env.CLAUDE_PROJECT_DIR
  || process.cwd();

const REL = ['skills', 'iteration-workflow', 'engine', 'gate', 'gate-check.mjs'];
const candidates = [
  join(IDE_DIR, ...REL),          // 主路径：与本 shim 同 IDE 目录下的 skill 包
  join(ROOT, '.codebuddy', ...REL),
  join(ROOT, '.claude', ...REL),
  join(ROOT, '.cursor', ...REL),  // cursor 的 hook 在 ~/.cursor/hooks，靠 ROOT 兜底
  join(ROOT, '.codex', ...REL),
];

const impl = candidates.find((p) => existsSync(p));

if (!impl) {
  process.stderr.write(
    '[gate] 门禁实现文件缺失，已按 fail-closed（exit 2）阻止本次操作。\n'
    + '  已查找：\n'
    + candidates.map((p) => '    ' + p).join('\n') + '\n'
    + '  修复：重跑 skill 安装脚本 scripts/install.ps1（Step 2 会整目录复制 engine/）。\n'
  );
  process.exit(2);
}

// 转发：不消费 stdin、不改 argv，实现层行为与拆分前完全一致
await import(pathToFileURL(impl).href);
