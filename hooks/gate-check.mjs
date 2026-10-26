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
 *
 * ★ FIX-48（2026-10-11 · 用户裁定 R1=A；依据 runtime/FIX-48-四件套.md v2）：
 *   背景：CLI bg 会话的隔离工作区（git worktree：<根>/.codebuddy/worktrees/bg-<id>）只含
 *   git 检出文件，而 engine/** 不在 .gitignore 白名单 ⇒ 原 5 候选全空 ⇒ fail-closed
 *   拦死 headless job 的全部工具（2026-10-11 job 508d73bf 实证）。
 *   ①②两步改动见下方内联注释（反推主仓库实现 + import 失败收窄）。
 * ★ FIX-49（2026-10-15 · 用户裁定 R1/R9；依据 runtime/FIX-49-四件套.md v2.4）：
 *   背景：实现层 RUNTIME_DIR 原按「`.claude` 存在即优先」解析 ⇒ CodeBuddy 宿主恒读写 legacy 侧
 *   （2026-09-28 §B.3 同步触发确定性翻转；10-11 双副本死锁 / 10-10 canonical 静默覆盖）。
 *   本文件新增**宿主身份注入**（`GATE_HOST_IDE`），供实现层三级解析第 ① 层消费。
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { basename, dirname, join } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';

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

// ★ F5（2026-10-26）：引擎仓库布局兜底 —— 仓库里 hooks/ 直接挂在仓库根
//   （不是 `<proj>/.{ide}/hooks/`），上面 5 个候选全指向「已装 skill」路径
//   ⇒ 在引擎仓库内跑回归/自检时实现恒缺失 ⇒ 全量 fail-closed(2)
//   （实测 45 红：41 例 expect=0 被拒 + 4 例退出码正确但审计行未落）。
//   仅在「hooks 的父目录不是 IDE 目录」时追加 `<repo>/engine/gate/gate-check.mjs`：
//   · 安装态 IDE_DIR = `<proj>/.codebuddy` ⇒ 本分支不进入，该路径本也不存在 ⇒ 对已装项目零影响；
//   · 始终排在 5 个标准候选**之后** ⇒ 不改变任何既有解析优先级；
//   · 解析失败时不追加任何东西 ⇒ fail-closed 语义不变（改名/删除实现仍会 exit 2）。
const IDE_DIR_NAME = basename(IDE_DIR).replace(/^\./, '');
if (!['codebuddy', 'claude', 'cursor', 'codex'].includes(IDE_DIR_NAME)) {
  candidates.push(join(IDE_DIR, 'engine', 'gate', 'gate-check.mjs'));
}

// ★ FIX-48①：git worktree 反推主仓库实现 —— worktree 根的 .git 是**文件**
//   （单行 `gitdir: <主仓库>/.git/worktrees/<id>`；4/4 实测绝对路径/正斜杠），
//   主仓库根 = gitdir 路径中 `/.git/worktrees/` 之前的部分 ⇒ 加载主仓库权威实现。
//   主仓库运行时 .git 是目录 ⇒ isFile() 为假 ⇒ 本段零影响。
//   解析失败 ⇒ 不追加候选 ⇒ 维持原 fail-closed（安全，绝不放大放行面）。
try {
  const dotGit = join(IDE_DIR, '..', '.git');              // worktree 根（.codebuddy 的父目录）
  if (existsSync(dotGit) && statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf-8').replace(/^\uFEFF/, ''));
    if (m) {
      const gd = m[1].trim().replace(/\\/g, '/');
      const k = gd.indexOf('/.git/worktrees/');
      if (k > 0) candidates.push(join(gd.slice(0, k), '.codebuddy', ...REL));
    }
  }
} catch (e) { /* 反推失败 ⇒ 不追加候选（fail-closed 不变） */ }

const impl = candidates.find((p) => existsSync(p));

if (!impl) {
  const inWorktree = String(IDE_DIR).replace(/\\/g, '/').includes('/.codebuddy/worktrees/');
  process.stderr.write(
    '[gate] 门禁实现文件缺失，已按 fail-closed（exit 2）阻止本次操作。\n'
    + '  已查找：\n'
    + candidates.map((p) => '    ' + p).join('\n') + '\n'
    + (inWorktree
      // ★ FIX-48：隔离区内 install.ps1 不可达（不在 worktree），给出可行指引
      ? '  提示：你在 CLI 隔离工作区（.codebuddy/worktrees/）内——产出请改用主仓库绝对路径；并上报该状态。\n'
      : '  修复：重跑 skill 安装脚本 scripts/install.ps1（Step 2 会整目录复制 engine/）。\n')
  );
  process.exit(2);
}

// ★ FIX-49（2026-10-15 实施 · 四件套 v2.4 ③-1 · 用户裁定 R1/R9）：把**宿主身份**显式传给实现层。
//   依据：shim 位置 = 宿主位置（`.codebuddy/hooks/` ⇒ CodeBuddy 宿主；worktree / FIX-48 反推
//   主仓库实现时 basename 仍为 `.codebuddy` ⇒ 语义正确：**被谁加载不重要，被谁调起才重要**）。
//   白名单（codebuddy/claude）之外**不注入** ⇒ 由实现层三级解析继续（env / 自身位置），
//   全失败即 fail-closed（R1：不做兜底，暴露问题而非"猜一侧"）。
//   生效点：实现层 `engine/gate/gate-check.mjs` 的 `HOST_IDE` 解析第 ① 层。
const HOST_IDE_SHIM = basename(IDE_DIR).replace(/^\./, '');
if (HOST_IDE_SHIM === 'codebuddy' || HOST_IDE_SHIM === 'claude') {
  process.env.GATE_HOST_IDE = HOST_IDE_SHIM;
}

// 转发：不消费 stdin、不改 argv，实现层行为与拆分前完全一致
// ★ FIX-48②：加载抛错原为非 2 码退出（=静默放行，与文件头「避免 Hook 静默失效」相悖）
//   ⇒ 收窄为 fail-closed（exit 2），仅失败形态的收紧、不涉及放行面
try {
  await import(pathToFileURL(impl).href);
} catch (e) {
  process.stderr.write('[gate] 门禁实现加载失败，已按 fail-closed（exit 2）阻止本次操作：'
    + (e && e.message ? e.message : e) + '\n');
  process.exit(2);
}
