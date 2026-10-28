#!/usr/bin/env node
'use strict';
/**
 * stall-watcher.js —— 成员卡死检测 + QQ 定向通知（TOOL-MEMBERSTALL，2026-10-14）
 *
 * 背景（为什么需要它）：
 *   10-13 / 10-14 两次 Team 成员卡死后用户只能在 IDE 成员 tab 才能看到，
 *   QQ 零通知；旧修复做在 prompt 层（收窄触发面）= 降概率，与诉求（检测+通知）错位。
 *   10-14 三路评审定案：真实卡死是**多因**（API 限流中文文案 / 宿主资源耗尽 EMFILE /
 *   网络断连 / 审批挂起 / 2000 上限暂停），信号全部落在 IDE 日志里，但无人监控。
 *
 * 数据源：%LOCALAPPDATA%\CodeBuddyExtension\Logs\CodeBuddyIDE\<日期>\<工作区>__<hash>.log
 *   ★ 编码实测（2026-10-14）：文件是 **UTF-8**（`速率限制` UTF8 命中 33 / GBK 命中 0；
 *     `状态变更` 5445 / 0）⇒ 直接按 UTF-8 增量解码，**无需 GBK 字节锚 / iconv-lite**。
 *   ★ 定位口径：按 **mtime 最新** 的 .log（不是「今天日期目录」）——日志按创建日归档，
 *     跨午夜未重启的会话仍写旧文件（评审① P1 保留结论）。
 *   ★ 读法：增量 offset + 单 tick 上限 + 半行缓存（先例 tools/eh-monitor.ps1 的
 *     `Seek(offset)` + 共享读实证）——**绝不整文件读**（188MB 会拖住 event loop）。
 *
 * 信号面（6 类，v2 评审定稿）：
 *   ① pending 滞留   : `handleStateChange: parsing -> pending` 后 pendingStallSec 内无
 *                      `pending -> *`（单行关键词 needConfirm=true 是**回显噪音**，不用——
 *                      10-13/10-14 两日原生命中均为 0，见评审② P3）
 *   ② 限流           : AI_APICallError + 「速率限制」/`Too Many Requests`（**中英双锚**：
 *                      10-14 走中文文案，只 grep ASCII 会漏）
 *   ③ 沉默兜底       : 成员会话零新日志 ≥ silenceSec（默认 120s = 用户 10-14 拍板）
 *   ④ 映射/归因      : `Team restored` / `startTeamMemberAgent`（成员↔会话）——支撑面
 *   ⑤ 僵尸清理       : 仅计数佐证（298 次/日常规清理，**不作触发**——评审② P4）
 *   ⑥ 资源耗尽        : HostStarvation 主线程阻塞 / EMFILE / file limit（评审①②新增类）
 *
 * 沉默卡三重门控（评审③ D4，缺一不发）：
 *   a. 无 pending 滞留        b. 无近端平台信号（platformSuppressSec 内）
 *   c. 无未决 ask/decision（RESUME-1·D 的 30min 正常等待期 ⇒ 抑制，防双发误报）
 *   另加：团队活动窗仍在（teamActiveSec）+ 日志仍在写（logAliveSec）
 *   ⇒ 防「成员已收口/团队已结束/IDE 已关闭」三类误报。
 *   成员收尾另用 `removeSession|cleanupSession: conversationId=` 硬判 ended（10-14 实测行格式）。
 *
 * 升级阶梯（评审③ D5）：首卡 → +5min 二卡 → +10min 三卡 → 每 30min 长期档（longTermMax 封顶）。
 *   恢复判据 = 该会话出现新日志行 ⇒ 清零（下一轮重新计首卡）。
 *
 * 宿主：qqbot 合并服务（进程内 tick，登录自启 + watchdog 心跳看管 —— 2026-10-14 拍板，
 *   独立 ps1 重启即消失无看管，弃）。**tail 循环每 tick 续写心跳**：循环若同步阻塞卡死，
 *   心跳随之停摆 ⇒ watchdog 180s 内告警（否则「逻辑假死但进程活」对 watchdog 失明）。
 *
 * 自测 / 回放（离线，不发 QQ）：
 *   node stall-watcher.js --selftest              # 解析器 + 状态机 + 三重门控 + 阶梯
 *   node stall-watcher.js --replay <log 文件>      # 真实日志回放（模拟时钟），打印会发的卡
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');

const PROJ = path.resolve(__dirname, '..', '..');

/** 默认配置（daemon.config.json → stallWatcher 覆盖；键名与 README 一致） */
const DEF = {
  enabled: true,
  tickMs: 5000,             // 与既有 watch 同频
  logRoot: '',              // 空 = %LOCALAPPDATA%/CodeBuddyExtension/Logs/CodeBuddyIDE
  workspaceHash: '',        // 可选：钉死某个 <工作区名>__<hash>.log 的 hash 片段；空 = 全局 mtime 最新
  reattachSec: 60,          // 重新定位最新日志的周期（按天滚动 / 换文件）
  attachTailBytes: 8 * 1024 * 1024,  // 首次附着时回读的尾部窗口（拿团队映射等上下文，防漏且不整读）
  readChunkBytes: 4 * 1024 * 1024,   // 单 tick 读上限（评审③ D6）
  pendingStallSec: 90,      // ① pending 滞留阈值
  silenceSec: 120,          // ③ 沉默阈值（用户 2026-10-14 拍板：2 分钟）
  escalateSec: [300, 600],  // 二卡 / 三卡的相对首卡时间
  longTermSec: 1800,        // 长期档间隔（三卡封顶后）
  longTermMax: 4,           // 长期档总量上限（每日/每事件）
  teamActiveSec: 600,       // 团队活动窗（超过 ⇒ 视为团队已收口，整体停报）
  teamSilenceSec: 600,      // ③b 整队静默阈值（lead + 全员零输出）
  teamKeepSec: 1800,        // ③b 追踪窗：团队最后一次活动在此期内才追（防收口后长期误报）
  // ★ 阈值标定（2026-10-14 两天真实日志对照）：300s ⇒ 10-14 出 11 张（含 6.5~7.8 分钟档的
  //   waiter/正常待命类噪声）；600s ⇒ 10-14 仅 1 张、10-13 仍补 2 张真卡；900s ⇒ 10-14 归零但过钝。
  //   取 600s。快速类卡（①②⑥⑦）不受影响，仍在秒级。
  turnSilenceSec: 600,      // ③c 轮次未收口 + 静默阈值（容忍 msbuild 等长命令无输出）
  turnSilenceMaxSec: 900,   // ③c 上限：超过此后不再由本档告警（交阶梯/③b；实测 27min/200min 档全是误报）
  turnKeepSec: 1800,        // ③c 追踪窗：团队最后一次活动在此期内才追
  logAliveSec: 120,         // 日志必须仍在此窗口内有写入（IDE 关闭/整机静默不报）
  platformSuppressSec: 300, // 平台信号后抑制沉默卡
  signalFreshSec: 1800,     // 平台信号保鲜期（同 kind 在此期内视为同一事件，走阶梯去重）
  signalCoOccurSec: 180,    // 次级信号（EMFILE/file-limit）需与主信号共现的窗口
  // ★ 新鲜度判据（2026-10-14 15:46 实测补强）：真信号写入后几秒内就被读到；而「我方命令把日志内容
  //   打印出来，又被日志回显」的**跨行预览碎片**会带原时间戳（往往是几分钟前的旧内容），
  //   ECHO_RE 与 RECORD_RE 都拦不住。⇒ 只有 `读取时刻 - 信号时间戳 ≤ freshReadSec` 才告警。
  freshReadSec: 60,
  skipWhenOpenAsk: true,    // 有未决 ask/decision ⇒ 抑制沉默卡（RESUME-1·D）
  stateFile: '',            // 空 = .codebuddy/temp/stall-watch-state.json
  teamOutDir: '',           // 空 = .codebuddy/temp/team-out（成员完成 oracle）
  doneCacheSec: 30,         // 完成态缓存周期
  pendingStallEnabled: true,
  maxLinesPerTick: 20000,   // 单 tick 处理行数上限（防大 tail 拖慢；剩余下 tick 处理）
  lineMatchLimit: 2000,     // 单行参与正则的字符上限（防超长参数 dump）
  // ★ TOOL-AUTORESUME（2026-10-27）：上限暂停（steplimit/tokenlimit）另有「自动续跑 waiter」通道 ——
  //   waiter 在守时由它秒级注入续跑（暂停窗仅 1~4min，人工往返必超窗），本 watcher **不再重复发卡**
  //   （防双通道）；waiter 判 NO-RESUME 或心跳过期（waiter 已死/未派）时**必须补发**，不得漏。
  autoResumeHeartbeat: '',  // 空 = .codebuddy/temp/auto-resume-waiter.json
  autoResumeFreshSec: 180,  // 心跳新鲜期（waiter 每 ~75s 调一次；超期 ⇒ 视为不在场）
  autoResumeHoldSec: 900,   // 被抑制信号的保留时长（waiter 失败后据此补发；超过即丢弃）
  // ★ 启动静默（2026-10-14 实测教训）：附着时会回读尾部窗口，其中**历史**的平台信号/挂起态
  //   若当新事件处理 ⇒ 启动瞬间连发 4 张陈旧卡（filelimit/ratelimit/emfile/aborted）。
  //   口径：早于「启动时刻 - backfillQuietSec」的行只用于建映射（团队/成员/邮箱/活跃），
  //   不产生告警；且启动后 armAfterSec 内不出任何卡。
  backfillQuietSec: 90,
  armAfterSec: 60,
};

// ══════════════════════════════════════════════════════════════
// 解析器（纯函数，自测/回放共用；行格式取自 10-14 真实日志实测）
// ══════════════════════════════════════════════════════════════
const RE = {
  ts: /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/,
  teamRestored: /Team restored: ([^,]+), mainConversationId: ([0-9a-f]{32}), memberCount=(\d+)/,
  memberStart: /startTeamMemberAgent START: memberId=([^@\s]+)@([^,\s]+), parentConversationId=([0-9a-f]{32}), conversationId=([0-9a-f]{32})/,
  memberActive: /Team member ([0-9a-f]{32}) became active/,
  stateChange: /\[([^\][]+)\]\s+\[(chatcmpl-tool-[0-9a-z]+)\]\s+handleStateChange: ([a-z_]+) -> ([a-z_]+)/,
  reporter: /\[ToolCallReporter\]\s+\[([0-9a-f]{32})\]\s+\[ToolCallReporter\] toolCallId: (chatcmpl-tool-[0-9a-z]+), toolName: (\S+)/,
  sessEnd: /(?:removeSession|cleanupSession) (?:START|SUCCESS): conversationId=([0-9a-f]{32})/,
  // ★ ③c 轮次收口锚（2026-10-14 探针）：成员轮次「开始」行不带 conversationId（47/47 无），
  //   但「结束」行带 ⇒ 用「最后活动 > 最后收口」反向判定「轮次未收口」。
  turnEnd: /onAgentEnd:.*conversationId=([0-9a-f]{32})/,
  wrapperEnd: /TeamMemberSessionAdapter\] Cleaned up wrapper for (\S+)/,
  hostStarve: /\[HostStarvation\] extension host main thread was blocked for ([\d.]+)s/,
  emfile: /EMFILE|too many open files/,
  fileLimit: /Reached maximum file limit \((\d+)\)/,
  apiErr: /AI_APICallError|_handleStepError: state changed from running to error/,
  rateCn: /速率限制/,
  rateEn: /Too Many Requests/,
  aborted: /operation was aborted/,
  // ★ 第⑦类（2026-10-14 复现实证 · 用户报「成员要确认却没收到 QQ 通知」）：模型请求/Token 达上限
  //   ⇒ 会话「执行已暂停」等用户点「继续」。直达锚 = AgentReporter/BaseAgent 的字段
  //   `isMaxStepLimit: true` / `isMaxTokenLimit: true`（实测今日 6 / 3 次；暂停本身无其它日志，
  //   只有 resume 后才有 `onAgentStart: userInput=请继续执行未完成的任务。`）。
  stepLimit: /isMaxStepLimit: true/,
  tokenLimit: /isMaxTokenLimit: true/,
  netDown: /TLS socket disconnected|Client network socket disconnected/,
  zombie: /cancelOrphanedPendingPermissions clearing zombie/,
  mailbox: /\[TeamMailbox\]\s+Message sent from "([^"]+)" to "([^"]+)" in team "([^"]+)"/,
  conv: /\b[0-9a-f]{32}\b/,
};

/**
 * ★ 回显污染过滤（2026-10-14 实测事故）：agent 的工具参数/命令输出会把信号**字面串**写进日志 ——
 *   例：本模块自测代码里的 `'[Warning] Error: EMFILE: too many open files'`、
 *   `'[HostStarvation] extension host main thread was blocked for 12.1s'` 被 StreamParser
 *   参数转储回显 ⇒ 被当真实平台信号连发 4 张卡（11:56:55 实测）。
 *   口径：命中回显标记的行**整行不参与分类**（真实信号行不会含这些标记）。
 */
const ECHO_RE = /参数解析完成|decodedPreview=|执行普通命令|\[CMD\]|\[StreamParser\]|\[TerminalExecutor\]|\[StandaloneTerminal|\[Tool:|ChunkDebug|old_str|new_str|write_to_file|replace_in_file|ingestLine\(|=~|Select-String -Path/;

/**
 * ★ 结构化判据（2026-10-14 15:41 实测补强）：只有**真实日志记录行**才允许生成信号 ——
 *   形态 = `[YYYY/MM/DD HH:MM:SS.mmm] [Level] ...`。
 *   背景：终端命令文本会被分块转储成**多行碎片**，碎片里可能恰好含 `isMaxStepLimit: true`
 *   这类字面串（我的排查命令就含它）⇒ 黑名单式回显过滤（ECHO_RE）会漏。真实信号行永远带
 *   「时间戳 + 级别标签」，碎片没有 ⇒ 该判据能兜住整类（比逐个加关键词标记更抗漂移）。
 */
const RECORD_RE = /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{1,3}\] \[(Info|Warning|Warn|Error|Debug|Trace|Verbose)\]/;

/** 行首时间戳 → ms（本地时区；解析失败返回 null） */
/**
 * ★ SNOOZE-B（2026-10-20 用户拍板）：静默期仍需送达的 stall 档。
 *   判据 = 「卡住需要用户动手 / 需人工介入」而非「环境噪音」：
 *     ① pending 工具确认挂起（要人去 IDE 点允许）
 *     ③ silence 成员已派发未回音（真卡死，需人工介入）
 *     ⑦ signal:steplimit / tokenlimit 上限暂停（要人点「继续」）
 *   其余（③b 整队静默 / ③c 轮次未收口 / ratelimit·filelimit·hoststarvation·netdown·aborted / emfile）
 *   ⇒ 视为噪音，静默期丢弃（只留 service.log）。
 *   返回 true = 放行（send 不传 kind）；false = 交 send 静默门（kind='stall:…'）。
 */
function stallKeep(a) {
  if (!a) return false;
  if (a.type === 'pending') return true;
  if (a.type === 'silence') return true;
  if (a.type === 'signal' && (a.kind === 'steplimit' || a.kind === 'tokenlimit')) return true;
  return false;
}
function parseTs(line) {
  const m = String(line).match(RE.ts);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
  const t = d.getTime();
  return isNaN(t) ? null : t;
}

/**
 * 单行 → 事件数组（纯函数；无状态）。
 * 事件：team-restored | member-start | member-active | state | reporter | conv-end
 *       | member-end | signal | zombie | none
 */
function classify(line) {
  const out = [];
  const s = String(line || '');
  if (!s) return out;
  const head = s.length > DEF.lineMatchLimit ? s.slice(0, DEF.lineMatchLimit) : s;
  if (ECHO_RE.test(head)) return [{ t: 'none' }];      // ★ 回显行（工具参数/命令输出）不参与分类

  let m = head.match(RE.teamRestored);
  if (m) out.push({ t: 'team-restored', team: m[1].trim(), mainConv: m[2], memberCount: Number(m[3]) });

  m = head.match(RE.memberStart);
  if (m) out.push({ t: 'member-start', member: m[1], team: m[2], parentConv: m[3], conv: m[4] });

  m = head.match(RE.memberActive);
  if (m) out.push({ t: 'member-active', conv: m[1] });

  m = head.match(RE.stateChange);
  if (m) out.push({ t: 'state', tool: m[1].trim(), toolCallId: m[2], from: m[3], to: m[4] });

  m = head.match(RE.reporter);
  if (m) out.push({ t: 'reporter', conv: m[1], toolCallId: m[2], toolName: m[3] });

  m = head.match(RE.sessEnd);
  if (m) out.push({ t: 'conv-end', conv: m[1] });

  m = head.match(RE.mailbox);
  if (m) out.push({ t: 'mailbox', from: m[1], to: m[2], team: m[3] });

  m = head.match(RE.turnEnd);
  if (m) out.push({ t: 'turn-end', conv: m[1] });

  m = head.match(RE.wrapperEnd);
  if (m) out.push({ t: 'member-end', member: m[1] });

  // ── 平台信号（同类只取第一条匹配，避免一行多命中重复计数）──
  m = head.match(RE.hostStarve);
  if (m) out.push({ t: 'signal', kind: 'hoststarvation', detail: '扩展宿主主线程阻塞 ' + m[1] + 's' });

  m = head.match(RE.fileLimit);
  if (m) out.push({ t: 'signal', kind: 'filelimit', detail: '文件监视上限 ' + m[1] + '（file-watcher 打满）' });

  if (RE.emfile.test(head)) out.push({ t: 'signal', kind: 'emfile', detail: 'EMFILE 文件描述符耗尽' });

  if (RE.apiErr.test(head)) {
    if (RE.rateCn.test(head)) out.push({ t: 'signal', kind: 'ratelimit', detail: 'API 限流：' + cnTail(head, '速率限制') });
    else if (RE.rateEn.test(head)) out.push({ t: 'signal', kind: 'ratelimit', detail: 'API 限流（Too Many Requests）' });
  } else if (RE.rateEn.test(head)) {
    out.push({ t: 'signal', kind: 'ratelimit', detail: 'API 限流（Too Many Requests）' });
  }
  if (RE.aborted.test(head)) out.push({ t: 'signal', kind: 'aborted', detail: '请求被中断（operation was aborted）' });
  if (RE.netDown.test(head)) out.push({ t: 'signal', kind: 'netdown', detail: '网络断连（TLS/socket disconnected）' });

  if (RE.stepLimit.test(head)) out.push({ t: 'signal', kind: 'steplimit', detail: '模型请求已达上限（2000 次）· 执行已暂停等「继续」' });
  if (RE.tokenLimit.test(head)) out.push({ t: 'signal', kind: 'tokenlimit', detail: 'Token 已达上限 · 执行已暂停等「继续」' });

  if (RE.zombie.test(head)) out.push({ t: 'zombie' });

  if (!out.length) out.push({ t: 'none' });
  return out;
}

/** 取关键词前后文（中文短语在 UTF-8 下已可正常解码；仅用于卡片文案） */
function cnTail(s, kw) {
  const i = s.indexOf(kw);
  if (i < 0) return kw;
  const seg = s.slice(Math.max(0, i - 4), Math.min(s.length, i + kw.length + 4)).replace(/\s+/g, ' ').trim();
  return seg || kw;
}

/** 主信号（可直接告警）：本身即「平台/宿主确实出事了」；其余（emfile/filelimit）为次级 */
const PRIMARY_KINDS = { hoststarvation: 1, ratelimit: 1, netdown: 1, aborted: 1, steplimit: 1, tokenlimit: 1 };
/** ★ 事件型信号：**每次发生都单独成卡**（subject 带分钟号，不走同类 30min 阶梯合并）——
 *  理由：上限暂停每停一次都必须有人点「继续」，合并成「第 2 次」会漏掉后续每一次的处置需求。 */
const EVENT_KINDS = { steplimit: 1, tokenlimit: 1 };

// ══════════════════════════════════════════════════════════════
// 检测器
// ══════════════════════════════════════════════════════════════

/**
 * @param {object} o
 * @param {(msg:string)=>void} o.log            服务日志（service.log）
 * @param {(text:string)=>Promise<any>} o.send  QQ 直发
 * @param {()=>boolean} [o.hasOpenAsk]          未决 ask/decision 判定（RESUME-1·D 门控）
 * @param {()=>void} [o.hbWrite]                心跳续写（每 tick）
 * @param {object} [o.cfg]                      覆盖 DEF
 * @param {number} [o.now]                      时钟注入（自测用）
 */
function createStallWatcher(o) {
  const opt = o || {};
  const cfg = Object.assign({}, DEF, opt.cfg || {});
  // ★ 环境变量逃生口：STALL_CFG_JSON='{"turnSilenceSec":600}'（隔离实例 / 阈值对照 / 临时调参用，免重启）
  if (process.env.STALL_CFG_JSON) {
    try { Object.assign(cfg, JSON.parse(process.env.STALL_CFG_JSON)); } catch (e) { /* 忽略非法 JSON */ }
  }
  const log = typeof opt.log === 'function' ? opt.log : function () {};
  const send = typeof opt.send === 'function' ? opt.send : null;
  const hasOpenAsk = typeof opt.hasOpenAsk === 'function' ? opt.hasOpenAsk : function () { return false; };
  const hbWrite = typeof opt.hbWrite === 'function' ? opt.hbWrite : null;
  const nowFn = typeof opt.now === 'function' ? opt.now : function () { return Date.now(); };

  // 环境变量逃生口（隔离实例验证用，见 memory: qqbot 隔离实例端到端验证方法）
  const stateFile = cfg.stateFile || process.env.STALL_STATE_FILE || path.join(PROJ, '.codebuddy', 'temp', 'stall-watch-state.json');
  const S = {
    convs: new Map(),      // conv → {member, team, lastSeenAt, state:'active'|'ended'}
    pending: new Map(),    // toolCallId → {conv, tool, since}
    toolConv: new Map(),   // toolCallId → conv（有界）
    alerts: new Map(),     // subject → {type, firstAt, lastAt, count}
    signals: new Map(),    // kind → {at, detail, conv}
    teamLastActiveAt: 0,
    lastLineAt: 0,         // 最近一次「读到新行」的时刻（日志仍在写）
    zombieCount: 0,
    secondaryLogged: {},   // 次级信号「仅记录」留痕时刻（节流）
    sentCount: 0,
    startedAt: nowFn(),
  };
  const R = { file: '', offset: 0, dec: new StringDecoder('utf8'), partial: '', size: 0, nextResolveAt: 0, scanned: 0 };
  let lastTs = 0;   // 最近一条**带时间戳**记录的时间（供续行继承）
  /** 回填窗口内的历史行（只建映射，不产告警）；replay 模式 startedAt=0 ⇒ 恒 false */
  const isHistorical = (at) => S.startedAt > 0 && at < S.startedAt - Math.max(0, Number(cfg.backfillQuietSec) || 90) * 1000;
  /** 启动静默期（默认 60s）：期间不出任何卡（防回填期误报） */
  const isArmed = (now) => (now - S.startedAt) >= Math.max(0, Number(cfg.armAfterSec) || 60) * 1000;

  /**
   * ★ TOOL-AUTORESUME（2026-10-27）：读「自动续跑 waiter」心跳（`tools/qqbot/auto-resume-waiter.mjs` 每轮写）。
   *   返回 {present, failed, conv, status, ts}；文件缺失/损坏/过期 ⇒ present=false（**fail-open**：卡照发，
   *   宁可双通道也不能漏发）。2s 缓存防 /health 与 tick 重复读盘。
   */
  let waitCache = { at: -1, v: { present: false, failed: false, conv: '', status: '', ts: 0 } };
  function waiterState(now) {
    if (waitCache.at >= 0 && Math.abs(now - waitCache.at) < 2000) return waitCache.v;
    const f = cfg.autoResumeHeartbeat || process.env.AUTORESUME_HEARTBEAT
      || path.join(PROJ, '.codebuddy', 'temp', 'auto-resume-waiter.json');
    let v = { present: false, failed: false, conv: '', status: '', ts: 0, file: f };
    try {
      const b = JSON.parse(String(fs.readFileSync(f, 'utf8')).replace(/^\uFEFF/, ''));
      const ts = Number(b.ts) || 0;
      const fresh = ts > 0 && Math.abs(now - ts) <= Math.max(0, Number(cfg.autoResumeFreshSec) || 180) * 1000;
      v = Object.assign(v, {
        ts: ts,
        present: fresh && b.onDuty !== false,
        failed: !!b.failed,
        status: String(b.status || ''),
        conv: (b.target && b.target.conv) || '',
      });
    } catch (e) { /* 缺失/损坏 ⇒ 不在场 */ }
    waitCache = { at: now, v: v };
    return v;
  }

  // ── 状态落盘（重启不重复告警；异常不影响主流程）──
  let persistAt = 0;
  function persist(now, force) {
    if (!force && now - persistAt < 30000) return;
    persistAt = now;
    try {
      const body = {
        v: 1, savedAt: now,
        convs: Array.from(S.convs.entries()).map(([k, v]) => [k, { member: v.member, team: v.team, lastSeenAt: v.lastSeenAt, state: v.state }]),
        alerts: Array.from(S.alerts.entries()).map(([k, v]) => [k, v]),
        teamLastActiveAt: S.teamLastActiveAt,
      };
      const tmp = stateFile + '.tmp';
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (e) { /* 落盘失败不致命 */ }
  }
  function restore() {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '');
      const body = JSON.parse(raw);
      if (!body || body.v !== 1) return;
      for (const [k, v] of body.convs || []) S.convs.set(k, { member: v.member, team: v.team, lastSeenAt: v.lastSeenAt, state: v.state });
      for (const [k, v] of body.alerts || []) S.alerts.set(k, v);
      S.teamLastActiveAt = Number(body.teamLastActiveAt) || 0;
      log('[STALL] 状态恢复：会话 ' + S.convs.size + ' / 告警 ' + S.alerts.size);
    } catch (e) { /* 首次运行或损坏 ⇒ 忽略 */ }
  }

  // ── 日志定位 / 增量读（评审③ D1/D3/D6）──
  function logRoot() {
    if (cfg.logRoot) return cfg.logRoot;
    if (process.env.STALL_LOG_ROOT) return process.env.STALL_LOG_ROOT;
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'CodeBuddyExtension', 'Logs', 'CodeBuddyIDE');
  }
  function resolveLog(now) {
    if (R.file && now < R.nextResolveAt) {
      try { if (fs.existsSync(R.file)) return R.file; } catch (e) { /* 继续重扫 */ }
    }
    R.nextResolveAt = now + Math.max(5, Number(cfg.reattachSec) || 60) * 1000;
    let best = null;
    let dirs = [];
    try { dirs = fs.readdirSync(logRoot(), { withFileTypes: true }); } catch (e) { return R.file || null; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files = [];
      try { files = fs.readdirSync(path.join(logRoot(), d.name)); } catch (e) { continue; }
      for (const f of files) {
        if (!/\.log$/i.test(f)) continue;
        if (cfg.workspaceHash && f.indexOf(cfg.workspaceHash) < 0) continue;
        const fp = path.join(logRoot(), d.name, f);
        let st;
        try { st = fs.statSync(fp); } catch (e) { continue; }
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: fp, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    return best ? best.file : (R.file || null);
  }
  /** 附着到文件：从尾部窗口开始（拿团队映射，不整读） */
  function attach(file, now) {
    R.file = file;
    R.dec = new StringDecoder('utf8');
    R.partial = '';
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { size = 0; }
    R.size = size;
    R.offset = Math.max(0, size - Math.max(0, Number(cfg.attachTailBytes) || 0));
    R.scanned = 0;
    log('[STALL] 附着日志 ' + path.basename(file) + '（tail ' + Math.round((size - R.offset) / 1024) + 'KB @ ' + new Date(now).toTimeString().slice(0, 8) + '）');
  }
  /** 读增量 → 行数组（同步读，单 tick 有上限；返回 {lines, more}） */
  function readDelta(now) {
    const file = resolveLog(now);
    if (!file) return { lines: [], more: false };
    if (file !== R.file) attach(file, now);
    let size = 0;
    try { size = fs.statSync(R.file).size; } catch (e) { return { lines: [], more: false }; }
    if (size < R.offset) {                     // 截断/重建（换天归档）⇒ 从头重读
      log('[STALL] 日志被截断/重建 ⇒ offset 归零');
      R.offset = 0; R.partial = ''; R.dec = new StringDecoder('utf8');
    }
    R.size = size;
    const budget = Math.max(64 * 1024, Number(cfg.readChunkBytes) || 4 * 1024 * 1024);
    const remain = size - R.offset;
    if (remain <= 0) return { lines: [], more: false };
    const want = Math.min(remain, budget);
    const buf = Buffer.alloc(want);
    let got = 0;
    try {
      const fd = fs.openSync(R.file, 'r');
      try { got = fs.readSync(fd, buf, 0, want, R.offset); } finally { fs.closeSync(fd); }
    } catch (e) { return { lines: [], more: false }; }
    R.offset += got;
    const text = R.partial + R.dec.write(buf.slice(0, got));
    const parts = text.split(/\r?\n/);
    R.partial = parts.pop() || '';
    if (R.partial.length > 1024 * 1024) R.partial = R.partial.slice(-4096);   // 异常超长半行保护
    return { lines: parts, more: (size - R.offset) > 0 };
  }

  // ── 成员完成 oracle（引擎协议：`team-out/<成员>.md` 含 TEAM-OUT-COMPLETE = 已交付）──
  //   用途：抑制「成员已收口后仍在团队窗内」的沉默误报；只认当天产出，且仅在**阳性**时抑制（保守）。
  //   反证依据：10-13 `be.md`（18:08）无 COMPLETE 且用户确认为卡死 ⇒ 该标记与真实完成态一致。
  let doneCache = { at: 0, map: new Map() };
  function teamOutDir() { return cfg.teamOutDir || process.env.STALL_TEAM_OUT_DIR || path.join(PROJ, '.codebuddy', 'temp', 'team-out'); }
  function memberDone(member, now) {
    if (!member) return false;
    if (now - doneCache.at > Math.max(1000, Number(cfg.doneCacheSec || 30) * 1000)) doneCache = { at: now, map: new Map() };
    if (doneCache.map.has(member)) return doneCache.map.get(member);
    let done = false;
    try {
      const dir = teamOutDir();
      const pre = String(member).toLowerCase();
      const dayStr = new Date(now).toDateString();
      for (const f of fs.readdirSync(dir)) {
        if (!/\.md$/i.test(f) || f.toLowerCase().indexOf(pre) !== 0) continue;
        const fp = path.join(dir, f);
        let st; try { st = fs.statSync(fp); } catch (e) { continue; }
        if (new Date(st.mtimeMs).toDateString() !== dayStr) continue;   // 只认当天
        try { if (/TEAM-OUT-COMPLETE/.test(fs.readFileSync(fp, 'utf8'))) { done = true; break; } } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 目录缺失 ⇒ 视为未完成 */ }
    doneCache.map.set(member, done);
    return done;
  }

  // ── 事件消费 ──
  function touchConv(conv, at) {
    const c = S.convs.get(conv);
    if (c && c.state === 'active') { c.lastSeenAt = at; }
  }
  function ingestLine(line, now) {
    const head = line.length > DEF.lineMatchLimit ? line.slice(0, DEF.lineMatchLimit) : line;
    const t = parseTs(head);
    // ★ 无时间戳的**续行**（多行参数转储/多行堆栈的碎片）继承上一条记录的时间 ——
    //   若按「现在」处理，回填窗口里的历史碎片会被当成刚发生（2026-10-14 12:40 实测：
    //   StreamParser 多行 args 里的 `EMFILE` 碎片 ⇒ 误发 emfile/hoststarvation/filelimit 三卡）。
    const at = (t == null) ? (lastTs || now) : t;
    if (t != null) lastTs = t;
    S.lastLineAt = now;

    // 会话活跃：任一跟踪会话的 id 出现在本行
    if (S.convs.size) for (const conv of S.convs.keys()) if (line.indexOf(conv) >= 0) touchConv(conv, at);

    const evs = classify(head);
    for (const ev of evs) {
      switch (ev.t) {
        case 'team-restored':
          S.teamLastActiveAt = at;
          if (!S.convs.has(ev.mainConv)) S.convs.set(ev.mainConv, { member: 'team-lead', team: ev.team, lastSeenAt: at, state: 'active', awaiting: false, awaitingSince: 0, isLead: true });
          log('[STALL] 团队映射: ' + ev.team + ' main=' + ev.mainConv.slice(0, 8) + ' members=' + ev.memberCount);
          touchConv(ev.mainConv, at);
          break;
        case 'member-start':
          S.teamLastActiveAt = at;
          S.convs.set(ev.conv, { member: ev.member, team: ev.team, lastSeenAt: at, state: 'active', awaiting: false, awaitingSince: 0, turnClosedAt: 0 });
          log('[STALL] 成员登记: ' + ev.member + '@' + ev.team + ' conv=' + ev.conv.slice(0, 8));
          break;
        case 'turn-end':
          // ★ ③c：成员的 agent 轮次收口（onAgentEnd 带 conv）⇒ 之后无活动属**正常待命**
          if (RECORD_RE.test(line)) {
            const c = S.convs.get(ev.conv);
            if (c) c.turnClosedAt = at;
          }
          break;
        case 'mailbox':
          // ★「已派发未回音」——沉默卡的**必要前提**（10-14 反证：成员 09:19~10:43 静默一个半小时属**正常待命**，
          //   10:43:48 lead 群发派活后 60 秒内全员回信 ⇒ 无 outstanding 派发的静默一律不报）。
          S.teamLastActiveAt = at;
          for (const [, c] of S.convs) {
            if (c.isLead) continue;                       // ★ lead 既不是「被派发方」也不是成员（否则含 lead 会自锁）
            if (c.member && c.member === ev.to) { c.awaiting = true; c.awaitingSince = at; }
            else if (c.member && c.member === ev.from) { c.awaiting = false; c.awaitingSince = 0; }
          }
          break;
        case 'member-active':
          S.teamLastActiveAt = at;
          touchConv(ev.conv, at);
          break;
        case 'reporter':
          if (S.toolConv.size > 800) S.toolConv.clear();
          S.toolConv.set(ev.toolCallId, ev.conv);
          break;
        case 'state':
          if (ev.to === 'pending') {
            if (isHistorical(at)) break;                // 回填期历史挂起态 ⇒ 不计时（否则启动即报「挂起 N 分钟」）
            S.pending.set(ev.toolCallId, { conv: S.toolConv.get(ev.toolCallId) || '', tool: ev.tool, since: at });
          } else if (ev.from === 'pending') {
            S.pending.delete(ev.toolCallId);            // 收口（实测只有 event: user_confirmed）
          }
          break;
        case 'conv-end':
          // ★ 实测反证（10-14）：removeSession/cleanupSession **每轮都打**（成员会话 M1 在 09:06/09:07 被清理后
          //   又继续跑了半小时）⇒ **不能**当「成员收尾」判据。仅用于清掉该会话上已失效的 pending 滞留。
          for (const [id, p] of S.pending) if (p.conv === ev.conv) S.pending.delete(id);
          break;
        case 'member-end':
          // ★ 同理（10-14 实测：`Cleaned up wrapper for be2` 6 分钟内 4 次）⇒ 只留痕，不做状态迁移。
          break;
        case 'signal':
          {
            // ★ 不用平台信号续热团队窗（10-14 误报反证：主会话的 HostStarvation/EMFILE 把团队窗续热到 10:36，
            //   让早已待命的成员被判「静默 29.5 分钟」）。团队窗只认团队事件与邮箱事件。
            if (isHistorical(at)) break;                // 回填期历史信号 ⇒ 不告警（防启动连发陈旧卡）
            if (!RECORD_RE.test(line)) break;           // ★ 非「时间戳+级别」的记录行（命令回显碎片等）⇒ 不算信号
            let conv = '';
            for (const cv of S.convs.keys()) if (line.indexOf(cv) >= 0) { conv = cv; break; }
            S.signals.set(ev.kind, { at: at, detail: ev.detail, conv: conv });
          }
          break;
        case 'zombie':
          S.zombieCount++;
          break;
        default: break;
      }
    }
  }

  // ── 判定（纯函数：给定时钟 ⇒ 返回当前应告警项）──
  function evaluate(now) {
    const out = [];
    if (!isArmed(now)) return out;                    // ★ 启动静默期：不产任何卡
    const ms = (s) => Math.max(0, Number(s) || 0) * 1000;

    // ① pending 滞留
    for (const [id, p] of S.pending) {
      const waited = now - p.since;
      if (waited >= ms(cfg.pendingStallSec)) {
        out.push({ subject: 'pending', type: 'pending', key: id, conv: p.conv, tool: p.tool, toolCallId: id, since: p.since, minutes: waited / 60000 });
      }
    }

    // ★ 折叠预扫描（2026-10-14 用户拍板）：本轮将触发的主信号 ⇒ 次级（EMFILE/file limit）不再单独成卡。
    //   实测 16:16 限流与「文件监视上限」同轮各发一张 ⇒ 同一次事故重复噪声；折叠后只留主卡（次级仍在
    //   /health.stall.signals 与留痕日志里可见）。
    const firingPrimary = new Set();
    for (const [k, s] of S.signals) {
      if (!PRIMARY_KINDS[k]) continue;
      const age = now - s.at;
      if (age > ms(cfg.signalFreshSec) || age > ms(cfg.freshReadSec)) continue;
      firingPrimary.add(k);
    }

    // ⑥/②/网络 等平台信号（保鲜期内）
    for (const [kind, sig] of S.signals) {
      if (now - sig.at > ms(cfg.signalFreshSec)) { S.signals.delete(kind); continue; }
      // ★ TOOL-AUTORESUME（2026-10-27）：上限暂停事件归「自动续跑 waiter」负责（秒级注入复活），
      //   waiter 在场时不重复发卡（防双通道）；但**保留**该信号（deferredByWaiter），
      //   waiter 判 NO-RESUME（心跳 failed）或心跳过期后再补发 —— 抑制 ≠ 丢弃，防漏发。
      if (EVENT_KINDS[kind]) {
        const w = waiterState(now);
        if (w.present && !w.failed) {
          if (!sig.deferredByWaiter) sig.deferredByWaiter = now;
          if (!S.secondaryLogged['wait:' + kind] || now - S.secondaryLogged['wait:' + kind] > 600000) {
            S.secondaryLogged['wait:' + kind] = now;
            log('[STALL] 上限暂停卡已抑制（auto-resume waiter 在场 conv=' + shortConv(w.conv)
              + ' status=' + w.status + '）：' + sig.detail);
          }
          continue;
        }
      }
      // waiter 抑制超过保留期 ⇒ 丢弃（waiter 长时间无结论时不让该信号永久悬挂）
      if (sig.deferredByWaiter && now - sig.deferredByWaiter > ms(cfg.autoResumeHoldSec)) { S.signals.delete(kind); continue; }
      // ★ 新鲜度：时间戳远早于读取时刻 ⇒ 判为「回显进来的旧内容」，只留痕不告警
      //   （未来时间戳 = 回放/时钟偏移，now-at<0 ⇒ 不过期，天然放行）
      //   ★ 被 waiter 抑制过的信号已在「保鲜期」内登记，故不受 freshReadSec 约束（否则永远补发不出来）。
      if (!sig.deferredByWaiter && now - sig.at > ms(cfg.freshReadSec)) {
        if (!S.secondaryLogged['stale:' + kind] || now - S.secondaryLogged['stale:' + kind] > 600000) {
          S.secondaryLogged['stale:' + kind] = now;
          log('[STALL] 旧信号 ' + kind + '（时间戳 ' + new Date(sig.at).toTimeString().slice(0, 8) + '，读取时已过期）⇒ 不告警：' + sig.detail);
        }
        continue;
      }
      // ★ 折叠：主信号本轮已触发 / 已有在案告警 ⇒ 次级只留痕不单发（同一次事故一张卡）
      if (!PRIMARY_KINDS[kind] && (firingPrimary.size > 0 || primaryAlerted())) {
        if (!S.secondaryLogged['fold:' + kind] || now - S.secondaryLogged['fold:' + kind] > 600000) {
          S.secondaryLogged['fold:' + kind] = now;
          log('[STALL] 次级信号 ' + kind + ' 已折叠进主信号（不单独发卡）：' + sig.detail);
        }
        continue;
      }
      // ★ 次级信号（EMFILE / file limit）本工作区**常年复发**（>5 万文件 ⇒ 每次扫描打警告；
      //   2026-10-14 11:47/11:50 实测仍在打）⇒ 仅在与**主信号**（限流/宿主饥饿/断连/中断）
      //   ±signalCoOccurSec 内共现时才告警，否则只记录（防慢性噪声）。
      if (!PRIMARY_KINDS[kind] && !secondarySupported(sig)) {
        if (!S.secondaryLogged[kind] || now - S.secondaryLogged[kind] > 600000) {
          S.secondaryLogged[kind] = now;
          log('[STALL] 次级信号 ' + kind + '（无主信号伴随，仅记录）：' + sig.detail);
        }
        continue;
      }
      const skey = EVENT_KINDS[kind] ? (kind + ':' + Math.floor(sig.at / 60000)) : kind;   // 事件型 ⇒ 每次单独成卡
      out.push({ subject: 'signal:' + skey, type: 'signal', key: skey, kind: kind, conv: sig.conv, detail: sig.detail, since: sig.at, minutes: (now - sig.at) / 60000 });
      // ★ 事件型**只发一次**（发完即从保鲜表移除）：否则用户点「继续」后，信号仍在 30min 保鲜期内
      //   会按阶梯继续发「第 2/3 次」——实测节奏（15:31 触发 → 15:32 用户点继续）会立刻变成噪声。
      //   下一次真发生 = 新的日志行 ⇒ 重新入表 ⇒ 新卡。
      if (EVENT_KINDS[kind]) S.signals.delete(kind);
    }

    // ③b 整队静默（含 lead）—— 低置信档：团队刚活跃过（teamKeepSec 内）却整体零输出。
    //    依据（10-13 实证）：用户投诉的那次 = 成员 18:10:39 回过信（故 ③ 派发门控不成立）后 18:12 起全队静默、
    //    直到用户 18:42 关机都无任何 QQ 通知 ⇒ 该档正是「整队无输出且未收口」这一类。
    if (teamSilenceGates(now, out)) {
      let newest = 0;
      for (const [, c] of S.convs) if (c.lastSeenAt > newest) newest = c.lastSeenAt;
      const quiet = newest ? (now - newest) : 0;
      if (newest && quiet >= ms(cfg.teamSilenceSec)) {
        out.push({ subject: 'team-silence', type: 'team-silence', key: 'all', since: newest, minutes: quiet / 60000 });
      }
    }

    // ③c 「轮次未收口 + 静默」—— 兜住**无邮箱派发**的成员卡死（2026-10-14 15:31 上限暂停即此形态）。
    //    判据（探针实证）：成员轮次「开始」行不带 conv（无法归因），但 `onAgentEnd` 带 conv ⇒
    //    反向判定 = `最后活动 > 最后收口`（自上次收口后仍有活动，说明它这轮还没结束）。
    //    为什么能杀掉 10-14 那次误报：早间 4 成员是在**回信后轮次收口**（onAgentEnd 在场）
    //    ⇒ 最后活动 < 最后收口 ⇒ 不触发；而 15:31 那次轮次未收口（ab6af507 的 onAgentEnd
    //    直到 15:46 才出现）⇒ 会触发。阈值默认 300s（容忍 msbuild 等长命令无输出）。
    // ③ 沉默兜底（三重门控）
    if (silenceGates(now, out)) {
      for (const [conv, c] of S.convs) {
        if (c.state !== 'active' || !c.lastSeenAt || c.isLead) continue;   // lead 归 ③b 整队静默档，不按成员判
        if (!c.awaiting) continue;                      // ★ 正常待命（无 outstanding 派发）⇒ 不判卡死
        if (memberDone(c.member, now)) continue;        // 已交付（team-out 有 COMPLETE）⇒ 不判卡死
        const sil = now - c.lastSeenAt;
        if (sil >= ms(cfg.silenceSec)) {
          out.push({ subject: 'silence', type: 'silence', key: conv, conv: conv, member: c.member, team: c.team, since: c.lastSeenAt, awaitingSince: c.awaitingSince || 0, minutes: sil / 60000 });
        }
      }
    }

    // ③c 「轮次未收口 + 静默」—— 兜住**无邮箱派发**的成员卡死（2026-10-14 15:31 上限暂停即此形态）。
    //    判据：`最后活动 > 最后收口(onAgentEnd)`（自上次收口后仍有活动 ⇒ 这轮没结束）。
    //    两道护栏（10-14 回放实测逼出）：① **只在 [turnSilenceSec, turnSilenceMaxSec] 窗口**告警
    //    （27min/200min 档实测全是误报——成员早已收工，团队窗被后来的事件续热）；② 与 ③ 互斥（同成员不双发）。
    if (turnSilenceGates(now, out)) {
      for (const [conv, c] of S.convs) {
        if (c.isLead || c.state !== 'active' || !c.lastSeenAt) continue;
        if ((c.turnClosedAt || 0) >= c.lastSeenAt) continue;             // 轮次已收口 ⇒ 正常待命
        if (memberDone(c.member, now)) continue;                         // 已交付
        if (out.some((a) => a.conv === conv)) continue;                   // ③ 已报同成员 ⇒ 不双发
        const sil = now - c.lastSeenAt;
        if (sil >= ms(cfg.turnSilenceSec) && sil <= ms(cfg.turnSilenceMaxSec)) {
          out.push({ subject: 'turn-silence', type: 'turn-silence', key: conv, conv: conv, member: c.member, team: c.team, since: c.lastSeenAt, turnSince: c.turnClosedAt || 0, minutes: sil / 60000 });
        }
      }
    }
    return out;
  }
  function silenceGates(now, cur) {
    if (S.lastLineAt && now - S.lastLineAt > Math.max(0, Number(cfg.logAliveSec) || 120) * 1000) return false;   // 日志停写（IDE 关闭/整机静默）
    if (!S.teamLastActiveAt || now - S.teamLastActiveAt > Math.max(0, Number(cfg.teamActiveSec) || 600) * 1000) return false;  // 团队已收口
    const sup = Math.max(0, Number(cfg.platformSuppressSec) || 300) * 1000;
    for (const [, sig] of S.signals) if (now - sig.at <= sup) return false;    // 近端平台信号 ⇒ 由信号卡承担
    for (const a of cur) if (a.type === 'pending') return false;               // 已判 pending 滞留 ⇒ 不发沉默卡（避免双发）
    if (cfg.skipWhenOpenAsk) { try { if (hasOpenAsk()) return false; } catch (e) { /* fail-open */ } }
    return true;
  }

  /** 主信号是否已有在案告警主体（含事件型的「signal:<kind>:<分钟>」后缀键） */
  function primaryAlerted() {
    for (const k of S.alerts.keys()) {
      for (const pk of Object.keys(PRIMARY_KINDS)) {
        if (k === 'signal:' + pk || k.indexOf('signal:' + pk + ':') === 0) return true;
      }
    }
    return false;
  }

  /** 次级信号是否有主信号伴随（±signalCoOccurSec 内） */
  function secondarySupported(sig) {
    const win = Math.max(0, Number(cfg.signalCoOccurSec) || 180) * 1000;
    for (const [k, o] of S.signals) {
      if (!PRIMARY_KINDS[k]) continue;
      if (Math.abs(o.at - sig.at) <= win) return true;
    }
    return false;
  }

  /** ③c 门控：日志在写 + 团队近端活跃过（防收口后长期误报）+ 无近端平台信号 + 无 pending + 无未决 ask */
  function turnSilenceGates(now, cur) {
    if (S.lastLineAt && now - S.lastLineAt > Math.max(0, Number(cfg.logAliveSec) || 120) * 1000) return false;
    if (!S.teamLastActiveAt || now - S.teamLastActiveAt > Math.max(0, Number(cfg.turnKeepSec) || 1800) * 1000) return false;
    const sup = Math.max(0, Number(cfg.platformSuppressSec) || 300) * 1000;
    for (const [, sig] of S.signals) if (now - sig.at <= sup) return false;
    for (const a of cur) if (a.type === 'pending') return false;
    if (cfg.skipWhenOpenAsk) { try { if (hasOpenAsk()) return false; } catch (e) { /* fail-open */ } }
    return true;
  }

  function teamSilenceGates(now, cur) {
    if (S.lastLineAt && now - S.lastLineAt > Math.max(0, Number(cfg.logAliveSec) || 120) * 1000) return false;                       // IDE 关闭/整机静默
    if (!S.teamLastActiveAt || now - S.teamLastActiveAt > Math.max(0, Number(cfg.teamKeepSec) || 1800) * 1000) return false;        // 团队早已收口（不再追）
    const sup = Math.max(0, Number(cfg.platformSuppressSec) || 300) * 1000;
    for (const [, sig] of S.signals) if (now - sig.at <= sup) return false;                                                          // 近端平台信号 ⇒ 由信号卡承担
    for (const a of cur) if (a.type === 'pending') return false;
    if (cfg.skipWhenOpenAsk) { try { if (hasOpenAsk()) return false; } catch (e) { /* fail-open */ } }
    return true;
  }

  // ── 阶梯去重（首卡 → +5min → +10min → 每 30min，长期档封顶）──
  function decide(alerts, now) {
    const ms = (s) => Math.max(0, Number(s) || 0) * 1000;
    const due = [];
    const alive = new Set();
    for (const a of alerts) {
      alive.add(a.subject + ':' + a.key);
      const sk = a.subject + ':' + a.key;
      let st = S.alerts.get(sk);
      if (!st || st.type !== a.type) { st = { type: a.type, firstAt: now, lastAt: 0, count: 0 }; S.alerts.set(sk, st); }
      const esc = Array.isArray(cfg.escalateSec) ? cfg.escalateSec : DEF.escalateSec;
      let fire = false;
      if (st.count === 0) fire = true;
      else if (st.count === 1) fire = (now - st.firstAt) >= ms(esc[0] != null ? esc[0] : 300);
      else if (st.count === 2) fire = (now - st.firstAt) >= ms(esc[1] != null ? esc[1] : 600);
      else if (st.count >= 3) fire = (now - st.lastAt) >= ms(cfg.longTermSec) && (st.count - 3) < Math.max(0, Number(cfg.longTermMax) || 0);
      if (fire) { st.count++; st.lastAt = now; due.push(Object.assign({}, a, { seq: st.count })); }
    }
    // 恢复：本轮不再告警的主体 ⇒ 阶梯清零（下一轮重新计首卡）。
    // ★ 例外：③b 整队静默是**全局**主体（会话 id 会被 IDE 服务行偶然刷新 ⇒ 单轮缺席很常见），
    //   直接用 alertTtlSec 宽限，否则阶梯会反复从「第 1 次」重来（10-13 回放实测 18:23/18:29 两张首卡）。
    for (const sk of Array.from(S.alerts.keys())) {
      if (alive.has(sk)) { const st0 = S.alerts.get(sk); st0.gapAt = 0; continue; }
      const st = S.alerts.get(sk);
      if (sk.indexOf('team-silence:') === 0) {
        if (!st.gapAt) st.gapAt = now;
        if (now - st.gapAt > Math.max(0, Number(cfg.alertTtlSec) || 900) * 1000) S.alerts.delete(sk);
      } else S.alerts.delete(sk);
    }
    return due;
  }

  // ── 卡片文案 ──
  function shortConv(conv) { return conv ? String(conv).slice(0, 8) : ''; }
  function who(a) {
    if (a.member) return '团队 ' + (a.team || '?') + ' · 成员 ' + a.member + '（会话 ' + shortConv(a.conv) + '）';
    if (a.conv && S.convs.has(a.conv)) { const c = S.convs.get(a.conv); return '团队 ' + (c.team || '?') + ' · 成员 ' + (c.member || '?') + '（会话 ' + shortConv(a.conv) + '）'; }
    return a.conv ? '会话 ' + shortConv(a.conv) : '（会话未归因）';
  }
  function buildText(a, now) {
    const L = [];
    const seq = a.seq > 1 ? '（第 ' + a.seq + ' 次）' : '';
    if (a.type === 'silence') {
      L.push('⚠️ 成员疑似卡死' + seq + ' · 静默 ' + a.minutes.toFixed(1) + ' 分钟');
      L.push(who(a));
      L.push('信号：已派发未回音（lead → ' + (a.member || '?') + (a.awaitingSince ? ' @ ' + new Date(a.awaitingSince).toTimeString().slice(0, 5) : '')
        + '），且无审批/限流/资源信号');
      L.push('请到 IDE 成员 tab 查看并点「确认 / 继续」（QQ 无法代消解弹窗）');
      if (a.seq >= 3) L.push('（长期未恢复，可考虑 headless 接管或收队重派）');
    } else if (a.type === 'turn-silence') {
      L.push('⚠️ 成员轮次未收口但已静默' + seq + ' · ' + a.minutes.toFixed(1) + ' 分钟');
      L.push(who(a));
      L.push('信号：该成员自上次轮次收口后仍有活动，且轮次未结束（非正常待命）');
      L.push('可能：弹窗等你操作 / 上限暂停 / 未知挂起 ⇒ 请到 IDE 成员 tab 查看');
    } else if (a.type === 'team-silence') {
      L.push('⚠️ 团队整体静默' + seq + ' · ' + a.minutes.toFixed(1) + ' 分钟无任何输出');
      L.push('lead 与全部成员会话均无新日志（不只是等待确认）');
      L.push('可能：整队卡住 / 成员失联未收口 / 在等你回工位');
      L.push('请到 IDE 成员 tab 逐个查看状态');
    } else if (a.type === 'pending') {
      L.push('⚠️ 工具确认挂起' + seq + ' · ' + (a.tool || '?') + ' 已等 ' + a.minutes.toFixed(1) + ' 分钟');
      L.push(who(a));
      L.push('toolCallId ' + String(a.toolCallId || '').slice(0, 24));
      L.push('请到 IDE 成员 tab 点「允许 / 确认」（远程无法代消解）');
    } else {
      const head = a.kind === 'steplimit' ? '🛑 有会话触发「模型请求上限」已暂停'
        : a.kind === 'tokenlimit' ? '🛑 有会话触发「Token 上限」已暂停'
        : a.kind === 'hoststarvation' ? '⚠️ 宿主资源告警：扩展宿主主线程阻塞'
        : a.kind === 'emfile' ? '⚠️ 宿主资源告警：文件描述符耗尽（EMFILE）'
          : a.kind === 'filelimit' ? '⚠️ 宿主资源告警：文件监视上限打满'
            : a.kind === 'ratelimit' ? '⚠️ 平台侧暂停：API 限流'
              : a.kind === 'aborted' ? '⚠️ 请求被中断（可能整轮失败）'
                : '⚠️ 网络断连（可能整轮失败）';
      L.push(head + seq + ' · ' + (a.detail || a.kind));
      if (a.conv) L.push('涉及 ' + who(a));
      if (a.kind === 'steplimit' || a.kind === 'tokenlimit') L.push('请打开对应会话（成员 tab / 最近会话）点「继续」恢复执行（QQ 无法代点）');
      else L.push('成员无输出属预期（非卡在弹窗）；建议稍后重试 / 回工位查看');
    }
    L.push('[' + new Date(now).toTimeString().slice(0, 5) + ' · TOOL-MEMBERSTALL]');
    return L.join('\n');
  }

  // ── 主 tick ──
  let ticks = 0;
  function tick() {
    const now = nowFn();
    ticks++;
    try {
      const r = readDelta(now);
      if (r.lines.length) {
        const cap = Math.max(100, Number(cfg.maxLinesPerTick) || 20000);
        const use = r.lines.length > cap ? r.lines.slice(-cap) : r.lines;
        for (const ln of use) if (ln) ingestLine(ln, now);
      }
      const alerts = evaluate(now);
      for (const a of decide(alerts, now)) {
        const text = buildText(a, now);
        S.sentCount++;
        log('[STALL] 告警 ' + a.type + '/' + (a.kind || a.key || '') + ' seq=' + a.seq + ' ⇒ ' + text.split('\n')[0]);
        // ★ SNOOZE-B：需用户动手的档（pending / silence / 上限暂停）放行 ⇒ 不传 kind；
        //   环境噪音传 kind 交 send 静默门（scope=all 时丢弃并写 [SEND SKIP]）
        const sk = stallKeep(a) ? '' : ('stall:' + a.type + ':' + (a.kind || a.key || ''));
        if (send) send(text, sk).then((st) => log('[STALL] HTTP ' + st + (sk ? ' kind=' + sk : ''))).catch((e) => log('[STALL ERR] ' + e.message));
      }
      persist(now, false);
    } catch (e) {
      log('[STALL ERR] ' + e.message);
    }
    try { if (hbWrite) hbWrite({}); } catch (e) { /* 心跳失败不致命 */ }   // ★ 评审③ D6：循环假死 ⇒ 心跳停 ⇒ watchdog 告警
  }

  function status() {
    return {
      file: R.file ? path.basename(R.file) : '',
      offsetKB: Math.round(R.offset / 1024),
      convs: S.convs.size,
      active: Array.from(S.convs.values()).filter((c) => c.state === 'active').length,
      pending: S.pending.size,
      signals: S.signals.size,
      zombies: S.zombieCount,
      alertsOpen: S.alerts.size,
      sent: S.sentCount,
      ticks: ticks,
      lastLineAgoSec: S.lastLineAt ? Math.round((nowFn() - S.lastLineAt) / 1000) : null,
      // ★ TOOL-AUTORESUME：上限暂停卡是否被 waiter 接管（present=true ⇒ 不发卡）
      waiter: (function () { const w = waiterState(nowFn()); return { present: w.present, failed: w.failed, status: w.status, conv: shortConv(w.conv) }; })(),
    };
  }

  return { cfg: cfg, tick: tick, evaluate: evaluate, decide: decide, ingestLine: ingestLine, classify: classify, status: status, restore: restore, _state: S, _reader: R, _buildText: buildText };
}

// ══════════════════════════════════════════════════════════════
// CLI：--selftest / --replay（离线，不发 QQ）
// ══════════════════════════════════════════════════════════════
function runSelftest() {
  const fails = [];
  let pass = 0;
  const ok = (cond, name) => { if (cond) pass++; else fails.push(name); };
  // ── 时钟基线（模拟时钟 = 日志内时间轴；无时间戳行 ⇒ at = now）──
  const T0 = Date.parse('2026-10-14T08:00:00');
  let T = 0;

  // ── 解析器 ──
  ok(classify('Team restored: pivas-66-04, mainConversationId: 72426376fb844f7d9fd1cb3e46e8ecec, memberCount=4')[0].t === 'team-restored', 'P: team-restored');
  const ms = classify('startTeamMemberAgent START: memberId=be2@pivas-66-04, parentConversationId=72426376fb844f7d9fd1cb3e46e8ecec, conversationId=f667bebe7e124ffe9384a5f1a7d2dbc0, teamName=pivas-66-04')[0];
  ok(ms.t === 'member-start' && ms.member === 'be2' && ms.conv === 'f667bebe7e124ffe9384a5f1a7d2dbc0', 'P: member-start');
  ok(classify('[search-content] [chatcmpl-tool-8fd95a25bbbeb184]  handleStateChange: parsing -> pending')[0].to === 'pending', 'P: parsing->pending');
  const rep = classify('[ToolCallReporter] [6f19772a444bd57fa1556314adc95c91]  [ToolCallReporter] toolCallId: chatcmpl-tool-8fd95a25bbbeb184, toolName: search_content')[0];
  ok(rep.t === 'reporter' && rep.conv === '6f19772a444bd57fa1556314adc95c91', 'P: reporter 归因');
  ok(classify('removeSession START: conversationId=e8c2c727a70b4cfb8a6ddf622d52fd11')[0].t === 'conv-end', 'P: conv-end');
  ok(classify('_handleStepError: state changed from running to error, stack: AI_APICallError: 您已达到免费用户的 API 速率限制')[0].kind === 'ratelimit', 'P: 限流中文锚');
  ok(classify('fullStream error, detail: Too Many Requests')[0].kind === 'ratelimit', 'P: 限流英文锚');
  ok(classify('_handleStepError: state changed from running to error, stack: AI_APICallError: operation was aborted').some((e) => e.kind === 'aborted'), 'P: aborted');
  ok(classify('[HostStarvation] extension host main thread was blocked for 50.5s')[0].kind === 'hoststarvation', 'P: HostStarvation');
  ok(classify('Error: EMFILE: too many open files, open x')[0].kind === 'emfile', 'P: EMFILE');
  ok(classify('Reached maximum file limit (50000) in directory: file:///e%3A/')[0].kind === 'filelimit', 'P: filelimit');
  ok(classify('cancelOrphanedPendingPermissions clearing zombie: force-push')[0].t === 'zombie', 'P: zombie');
  // 负向：普通行不误触
  ok(classify('[Info] [TerminalExecutor] 执行普通命令: node -e "x"')[0].t === 'none', 'N: 普通行无信号');
  ok(classify('[Info] [TeamEventListener] Team member f667bebe7e124ffe9384a5f1a7d2dbc0 became active').length === 1, 'N: became active 只出一事件');

  // ── 状态机 + 三重门控 + 阶梯（时钟基线 = 日志内时间轴；无时间戳行 ⇒ at = now）──
  const MAIN = '72426376fb844f7d9fd1cb3e46e8ecec';
  const M1 = 'f667bebe7e124ffe9384a5f1a7d2dbc0';
  const M2 = '8f97cf59108942299f6bee66a8fc4926';   // 另一成员会话（保持团队窗热，不动 M1 的静默计时）
  const LK = '[Info] [keepalive] tick';   // 无会话 ⇒ 只推进「日志仍在写」门控
  const mk = (opts) => { T = T0; return createStallWatcher(Object.assign({ now: () => T, log: () => {}, hasOpenAsk: () => false, cfg: Object.assign({ stateFile: '' }, (opts || {}).cfg || {}) }, opts || {})); };
  const setup = (w, dispatch) => {
    w.ingestLine('[TeamEventListener] Team restored: pivas-66-04, mainConversationId: ' + MAIN + ', memberCount=4', T);
    w.ingestLine('[AgentSessionManager] startTeamMemberAgent START: memberId=be2@pivas-66-04, parentConversationId=' + MAIN + ', conversationId=' + M1 + ', teamName=pivas-66-04', T);
    if (dispatch !== false) w.ingestLine('[TeamMailbox]  Message sent from "team-lead" to "be2" in team "pivas-66-04"', T);   // 已派发未回音
  };
  const step = (w, ms) => { T += ms; w.ingestLine(LK, T); return w.decide(w.evaluate(T), T); };

  // 场景 1：成员静默 → 首卡 / 阶梯 / 长期档封顶
  {
    const w = mk();
    setup(w);
    const seqs = [];
    for (const min of [0, 2, 7, 17, 47, 77, 107, 137]) {
      T = T0 + min * 60000;
      w.ingestLine('[TeamEventListener] Team member ' + M2 + ' became active', T);   // 别成员活跃 ⇒ 团队窗保持热 + 日志在写
      const due = w.decide(w.evaluate(T), T);
      for (const d of due) if (d.type === 'silence') seqs.push(d.seq + '@' + min);   // 只统计成员级沉默卡（③b 另行验）
    }
    ok(seqs[0] === '1@2', '1: 2 分钟首卡（实际 ' + seqs[0] + '）');
    ok(seqs[1] === '2@7', '1: +5min 二卡（实际 ' + seqs[1] + '）');
    ok(seqs[2] === '3@17', '1: +10min 三卡（实际 ' + seqs[2] + '）');
    ok(seqs[3] === '4@47' && seqs[4] === '5@77', '1: 30min 长期档（实际 ' + seqs.slice(3).join(',') + '）');
    ok(seqs.length === 7, '1: 3+4 卡封顶后停发（实际 ' + seqs.length + '）');
  }
  // 场景 2：恢复后重新计首卡
  {
    const w = mk();
    setup(w);
    let due = step(w, 3 * 60000);
    ok(due.length === 1 && due[0].seq === 1, '2: 首卡');
    w.ingestLine('[search-content] [chatcmpl-tool-aaaaaaaaaaaa] activity ' + M1, T);   // 会话恢复出新行
    T += 1000; w.ingestLine(LK, T);
    due = w.decide(w.evaluate(T), T);
    ok(due.length === 0, '2: 恢复后无卡');
    due = step(w, 3 * 60000);
    ok(due.length === 1 && due[0].seq === 1, '2: 再次静默重新计首卡');
  }
  // 场景 3：每轮清理不误判成员收尾 + team-out 完成 oracle 抑制沉默
  {
    const w = mk();
    setup(w);
    w.ingestLine('[AgentSessionManager] removeSession START: conversationId=' + M1, T);
    ok(w._state.convs.get(M1).state === 'active', '3a: 每轮清理不判收尾');
    const dir = path.join(os.tmpdir(), 'stall-watcher-selftest-' + process.pid);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
    const fdone = path.join(dir, 'be2-out.md');
    fs.writeFileSync(fdone, 'report ... TEAM-OUT-COMPLETE ...', 'utf8');
    // ★ 修复（2026-10-20）：模拟时钟 vs 文件系统时钟解耦 —— `memberDone()` 只认「当天」的 team-out
    //   （生产语义：跨天的旧产出不得压制今天的卡），而自测模拟时钟固定 2026-10-14、临时文件 mtime 是
    //   真实当天 ⇒ 非 10-14 运行必红（实测 2026-10-20：simClockDay=Oct 14 vs fileMtimeDay=Oct 20 ⇒ 61/62）。
    //   修法 = 把文件 mtime 对齐模拟时钟（不动生产判据）。
    try { fs.utimesSync(fdone, new Date(T), new Date(T)); } catch (e) { /* 忽略 */ }
    const w2 = mk({ cfg: { teamOutDir: dir } });
    setup(w2);
    ok(step(w2, 5 * 60000).length === 0, '3b: team-out 含 COMPLETE ⇒ 抑制沉默卡');
    fs.writeFileSync(fdone, 'report without marker', 'utf8');     // 对照：10-13 be.md（有产出无 COMPLETE）
    try { fs.utimesSync(fdone, new Date(T), new Date(T)); } catch (e) { /* 忽略 */ }   // ★ 同上：保持「同年同日、仅缺 COMPLETE」这一唯一变量
    const w3 = mk({ cfg: { teamOutDir: dir } });
    setup(w3);
    ok(step(w3, 5 * 60000).length === 1, '3c: 无 COMPLETE ⇒ 仍判卡死');
    try { fs.unlinkSync(fdone); fs.rmdirSync(dir); } catch (e) { /* 忽略 */ }
  }
  // 场景 4：RESUME-1·D 门控（有未决 ask）⇒ 不判沉默
  {
    const w = mk({ hasOpenAsk: () => true });
    setup(w);
    ok(step(w, 5 * 60000).length === 0, '4: 有未决 ask ⇒ 抑制沉默卡');
  }
  // 场景 5：平台信号（限流）抑制沉默卡 + 自身带阶梯去重
  {
    const w = mk();
    setup(w);
    const rl = '[2026/10/14 09:34:41.000] [Info] [BaseAgent:iteration-workflow] _handleStepError: state changed from running to error, stack: AI_APICallError: 您已达到免费用户的 API 速率限制。';
    const T5 = T + 61000;                                          // 过启动静默期
    w.ingestLine(rl, T5);
    const due0 = w.decide(w.evaluate(T5), T5);                     // 新鲜度判据：信号需在读到后 60s 内告警
    ok(due0.length === 1 && due0[0].type === 'signal' && due0[0].kind === 'ratelimit', '5: 限流卡本身（实际 ' + JSON.stringify(due0.map((d) => d.type + '/' + d.kind)) + '）');
    // 旧信号（时间戳已过 60s 新鲜窗但未到历史窗）⇒ 只留痕不告警（回显内容兜底）
    const w2 = mk();
    setup(w2);
    const T5b = T + 61000;
    w2.ingestLine('[2026/10/14 07:59:00.000] [Info] [BaseAgent] AI_APICallError: 您已达到免费用户的 API 速率限制。', T5b);
    ok(w2.evaluate(T5b + 3 * 60000).every((a) => a.kind !== 'ratelimit'), '5b: 旧信号（时间戳过期）不告警');
    const due = step(w, 3 * 60000);
    ok(due.every((a) => a.type === 'signal'), '5: 平台信号抑制沉默卡');
  }
  // 场景 6：pending 滞留（①）与其收口
  {
    const w = mk();
    setup(w);
    w.ingestLine('[ToolCallReporter] [' + M1 + ']  [ToolCallReporter] toolCallId: chatcmpl-tool-8fd95a25bbbeb184, toolName: search_content', T);
    w.ingestLine('[search-content] [chatcmpl-tool-8fd95a25bbbeb184]  handleStateChange: parsing -> pending', T);
    ok(step(w, 100 * 1000).some((a) => a.type === 'pending'), '6: pending 滞留 90s 出卡');
    w.ingestLine('[search-content] [chatcmpl-tool-8fd95a25bbbeb184]  handleStateChange: pending -> stream_executing', T);
    ok(w.decide(w.evaluate(T), T).every((a) => a.type !== 'pending'), '6: 收口后不再出卡');
  }
  // 场景 7：团队活动窗过期 ⇒ 成员级沉默不再报（整队静默档 ③b 照报，属设计）
  {
    const w = mk();
    setup(w);
    const due = step(w, 20 * 60000);
    ok(due.every((a) => a.type !== 'silence'), '7a: 团队窗过期 ⇒ 成员级沉默不报');
    ok(due.some((a) => a.type === 'team-silence'), '7b: 整队静默档照报（③b）');
  }
  // 场景 8：日志停写（IDE 关闭）⇒ 不报
  {
    const w = mk();
    setup(w);
    T += 5 * 60000;                        // 期间日志零新行（不喂 keepalive）
    ok(w.decide(w.evaluate(T), T).length === 0, '8: 日志停写不报');
  }

  // 场景 9：「已派发未回音」门控 —— 无派发的静默不报；派发后静默才报；成员回信即恢复
  {
    const w = mk();
    setup(w, false);                       // 只登记成员，不派发
    w.ingestLine('[2026/10/14 08:00:01.000] [Info] [AgentReporter] [a]  onAgentEnd: agent=craft mode=craft conversationId=' + M1 + ' requestId=r0', T + 1000);
    ok(step(w, 5 * 60000).length === 0, '9a: 轮次已收口且无派发 ⇒ 静默不报（正常待命）');
    w.ingestLine('[TeamMailbox]  Message sent from "team-lead" to "be2" in team "pivas-66-04"', T);
    ok(step(w, 3 * 60000).length === 1, '9b: 派发后静默 3 分钟出卡');
    w.ingestLine('[TeamMailbox]  Message sent from "be2" to "team-lead" in team "pivas-66-04"', T);
    ok(step(w, 5 * 60000).every((a) => a.type !== 'silence'), '9c: 成员回信后成员级卡消失');
  }

  // 场景 10：整队静默档 ③b（lead + 全员零输出）
  {
    const w = mk();
    setup(w, false);                        // 无 outstanding 派发（③ 不报），只验 ③b
    ok(step(w, 9 * 60000).every((a) => a.type !== 'team-silence'), '10a: 未到 10 分钟不报');
    ok(step(w, 2 * 60000).some((a) => a.type === 'team-silence'), '10b: 整队静默 ≥10min 出低置信卡');
    T += 1000; w.ingestLine('[AgentSessionManager] activity ' + MAIN, T);       // lead 恢复
    ok(w.decide(w.evaluate(T), T).every((a) => a.type !== 'team-silence'), '10c: lead 活动即恢复');
    T += 40 * 60000; w.ingestLine(LK, T);                                      // 超团队追踪窗（30min）
    ok(w.decide(w.evaluate(T), T).every((a) => a.type !== 'team-silence'), '10d: 超追踪窗不再报');
  }

  // 场景 11：启动回填期「历史信号」不告警（10-14 实测：附着尾部窗口即连发 4 张陈旧卡）
  {
    T = T0;
    const w = createStallWatcher({ now: () => T, log: () => {}, hasOpenAsk: () => false, cfg: { stateFile: '' } });
    w.ingestLine('[2026/10/14 07:00:00.000] [Warning] [HostStarvation] extension host main thread was blocked for 50.5s', T);
    ok(w.evaluate(T).every((a) => a.type !== 'signal'), '11a: 历史平台信号不计');
    // 11c：无时间戳**续行**（多行参数转储碎片）继承上一条时间 ⇒ 不算新鲜（10-14 12:40 实测）
    w.ingestLine('  ...；另见 EMFILE: too many open files 说明（续行碎片）', T);
    ok(w.evaluate(T).every((a) => a.kind !== 'emfile'), '11c: 历史续行碎片不判信号');
    w.ingestLine('[2026/10/14 08:00:30.000] [Warning] [HostStarvation] extension host main thread was blocked for 12.1s', T + 61000);
    T += 61000;
    ok(w.evaluate(T).some((a) => a.type === 'signal'), '11b: 带时间戳的新鲜信号照报（过 arm 期）');
  }

  // 场景 12：次级信号（EMFILE / file-limit）需主信号伴随（本工作区慢性告警降噪）
  {
    T = T0;
    const w = createStallWatcher({ now: () => T, log: () => {}, hasOpenAsk: () => false, cfg: { stateFile: '' } });
    T += 61000;                                        // 过启动静默期
    w.ingestLine('[2026/10/14 08:00:30.000] [Warning] Error: EMFILE: too many open files', T);
    ok(w.evaluate(T).every((a) => a.kind !== 'emfile'), '12a: 无主信号伴随 ⇒ 次级信号不告警');
    w.ingestLine('[2026/10/14 08:00:31.000] [Warning] [HostStarvation] extension host main thread was blocked for 12.1s', T + 1000);
    const d12 = w.decide(w.evaluate(T), T);
    ok(d12.some((a) => a.kind === 'hoststarvation') && d12.every((a) => a.kind !== 'emfile'), '12b: 主信号出卡 ⇒ 次级折叠（不单发）');
    w.ingestLine('[2026/10/14 08:00:40.000] [Warning] Error: EMFILE: too many open files', T + 2000);
    ok(w.decide(w.evaluate(T + 2000), T + 2000).every((a) => a.kind !== 'emfile'), '12c: 主信号已在案 ⇒ 后续次级仍折叠');
  }

  // 场景 13：回显污染过滤（10-14 实测事故：自测代码字面串被 StreamParser 转储 ⇒ 误判平台信号）
  {
    ok(classify('[Info] [StreamParser]  参数解析完成: chatcmpl-tool-x - 参数: command - 值: w.ingestLine(\'[Warning] Error: EMFILE: too many open files\', T);')[0].t === 'none',
      '13a: StreamParser 参数转储里的 EMFILE 不判信号');
    ok(classify('[Info] [TerminalExecutor]  执行普通命令: "node -e \\"const s=\'[HostStarvation] extension host main thread was blocked for 12.1s\'\\""')[0].t === 'none',
      '13b: 终端命令回显里的 HostStarvation 不判信号');
    ok(classify('[Warning] [HostStarvation] extension host main thread was blocked for 12.1s')[0].kind === 'hoststarvation',
      '13c: 真实 HostStarvation 行照判（不过滤）');
  }

  // 场景 14：第⑦类 上限暂停直达检测（2026-10-14 复现实证：15:31 m67-t4-scoring 触发 2000 上限）
  {
    T = T0;
    const w = createStallWatcher({ now: () => T, log: () => {}, hasOpenAsk: () => false, cfg: { stateFile: '' } });
    T += 61000;   // 过启动静默期
    const real = '[2026/10/14 15:31:03.189] [Info] [AgentReporter] [b8f672f5966ea1a1b796833226bd840e]  [AgentReporter] Step 10 ended (messageId: 6891c1a043c74ce392733291efdd12ea, isMaxTokenLimit: false, isMaxStepLimit: true, hasReactiveTool: false)';
    ok(classify(real).some((e) => e.kind === 'steplimit'), '14a: 真实行分类为 steplimit');
    ok(classify('[2026/10/14 15:32:44.339] [Info] [AgentReporter] Step 20 ended (isMaxTokenLimit: false, isMaxStepLimit: false, hasReactiveTool: false)')[0].t === 'none',
      '14b: isMaxStepLimit: false 不误判');
    w.ingestLine(real, T);
    const d1 = w.decide(w.evaluate(T), T);
    ok(d1.some((a) => a.kind === 'steplimit' && a.seq === 1), '14c: 上限暂停 ⇒ 出卡');
    ok(w.evaluate(T + 5000).every((a) => a.kind !== 'steplimit'), '14d: 事件型只发一次（不发阶梯升级）');
    w.ingestLine('[2026/10/14 15:34:10.000] [Info] [AgentReporter] Step 4 ended (isMaxTokenLimit: false, isMaxStepLimit: true)', T + 190000);
    const d2 = w.decide(w.evaluate(T + 190000), T + 190000);
    ok(d2.some((a) => a.kind === 'steplimit' && a.seq === 1), '14e: 下一次发生重新成卡（新 subject）');
  }

  // 场景 15：结构化判据 —— 非「时间戳+级别」的记录行（命令回显碎片）不得生成信号
  {
    T = T0;
    const w = createStallWatcher({ now: () => T, log: () => {}, hasOpenAsk: () => false, cfg: { stateFile: '' } });
    T += 61000;
    const frag = "  -Pattern 'isMaxStepLimit: true' -Encoding UTF8) | Select-Object -Last 4";     // 终端命令被分块转储的碎片
    ok(classify(frag).some((e) => e.kind === 'steplimit'), '15a: 分类器按字面命中（黑名单式过滤挡不住碎片 ⇒ 靠 ingestLine 的结构性判据兜底）');
    w.ingestLine(frag, T);
    ok(w.evaluate(T).every((a) => a.kind !== 'steplimit'), '15b: 碎片行不产生 steplimit 信号');
  }

  // 场景 16：③c 轮次未收口 + 静默（2026-10-14 15:31 上限暂停形态；必须杀掉「回信后正常待命」误报）
  {
    const w = mk();
    setup(w);
    const TE = '[2026/10/14 08:00:10.000] [Info] [AgentReporter] [63acf8d71d46e08d5ac2f4487ac3887a]  onAgentEnd: agent=craft mode=craft conversationId=' + M1 + ' requestId=23a92c56417a4aa59bc1e30d37feb5dc';
    ok(classify(TE)[0].t === 'turn-end' && classify(TE)[0].conv === M1, '16a: onAgentEnd 解析为 turn-end（带 conv）');
    w.ingestLine(TE, T + 10000);
    ok(step(w, 10 * 60000).every((a) => a.type !== 'turn-silence'), '16b: 轮次已收口 ⇒ 不报（对应 10-14 早间 85 分钟正常待命）');
    w.ingestLine('[2026/10/14 08:11:00.000] [Info] [AgentReporter]  [CHUNK_PERF] [SUMMARY] requestId=r2, conversationId=' + M1 + ', toolCallId=call_01_k7, toolName=execute_command', T);
    ok(step(w, 11 * 60000).some((a) => a.type === 'turn-silence'), '16c: 收口后又有活动 + 再静默 11 分钟 ⇒ 出卡');
    const w2 = mk({ hasOpenAsk: () => true });
    setup(w2);
    w2.ingestLine(TE.replace('08:00:10', '08:00:10'), T + 10000);
    w2.ingestLine('[2026/10/14 08:11:00.000] [Info] [AgentReporter]  [CHUNK_PERF] [SUMMARY] requestId=r3, conversationId=' + M1 + ', toolCallId=call_01_k8, toolName=execute_command', T);
    ok(step(w2, 11 * 60000).every((a) => a.type !== 'turn-silence'), '16d: 有未决 ask ⇒ ③c 被抑制（RESUME-1·D 等待期）');
    // 16e：超上限窗的静默不报（10-14 回放实测 27min/200min 档全是误报）——团队窗保持热以隔离该判据
    const w3 = mk();
    setup(w3);
    w3.ingestLine('[2026/10/14 08:00:01.000] [Info] [AgentReporter] [a]  onAgentEnd: agent=craft mode=craft conversationId=' + M1 + ' requestId=r0', T + 1000);
    w3.ingestLine('[2026/10/14 08:05:00.000] [Info] [AgentReporter]  [CHUNK_PERF] [SUMMARY] requestId=r9, conversationId=' + M1 + ', toolCallId=c9, toolName=execute_command', T + 5 * 60000);
    w3.ingestLine('[2026/10/14 08:20:00.000] [Info] [TeamMailbox]  Message sent from "feX" to "team-lead" in team "pivas-66-04"', T + 20 * 60000);
    ok(step(w3, 12 * 60000).every((a) => a.type !== 'turn-silence'), '16e: 静默 27 分钟（超上限窗）不报');
  }

  // 场景 17：TOOL-AUTORESUME —— 上限暂停卡与 auto-resume waiter 的防双通道/补发联动
  //   依据（2026-10-27）：waiter 在场时会把暂停会话秒级注入复活 ⇒ 同一事件再发 QQ 卡 = 双通道噪声；
  //   但 waiter 判 NO-RESUME（failed）或 waiter 已死（心跳过期）时**必须补发**，否则真卡死无人知。
  {
    T = T0;
    const hbFile = path.join(os.tmpdir(), 'stall-waiter-hb-' + process.pid + '.json');
    const writeHb = (o) => fs.writeFileSync(hbFile, JSON.stringify(o), 'utf8');
    const mkHb = (o) => createStallWatcher({
      now: () => T, log: () => {}, hasOpenAsk: () => false,
      cfg: Object.assign({ stateFile: '', autoResumeHeartbeat: hbFile }, o || {}),
    });
    // ★ 成员会话的真实暂停行（AgentReporter + 第二段 [AgentReporter]，见 2026-10-27 实测）
    const PAUSE = '[2026/10/14 15:31:03.189] [Info] [AgentReporter] [b8f672f5966ea1a1b796833226bd840e]  [AgentReporter] Step 10 ended (messageId: x, isMaxStepLimit: true, isMaxTokenLimit: false, hasReactiveTool: false)';

    T = T0;
    const w1 = mkHb();                                            // startedAt = T0（须先建再加时，否则卡在 arm 静默期）
    T += 61000;                                                   // 过启动静默期
    writeHb({ ts: T, onDuty: true, status: 'OBSERVE', failed: false, target: { conv: M1 } });
    w1.ingestLine(PAUSE, T);
    ok(w1.decide(w1.evaluate(T), T).every((a) => a.kind !== 'steplimit'), '17a: waiter 在场 ⇒ 上限暂停卡抑制（防双通道）');
    ok(!!w1._state.signals.get('steplimit') && !!w1._state.signals.get('steplimit').deferredByWaiter, '17b: 抑制≠丢弃（signal 标记 deferredByWaiter 待补发）');
    T += 200 * 1000;                                              // 心跳过期（waiter 已死）
    ok(w1.decide(w1.evaluate(T), T).some((a) => a.kind === 'steplimit'), '17c: 心跳过期 ⇒ 补发上限暂停卡（不漏发）');

    // 17d：waiter 明确失败（NO-RESUME）⇒ 立刻补发
    T = T0;
    const w2 = mkHb();
    T += 61000;
    writeHb({ ts: T, onDuty: true, status: 'NO-RESUME', failed: true, failedAt: T, target: { conv: M1 } });
    w2.ingestLine(PAUSE, T);
    ok(w2.decide(w2.evaluate(T), T).some((a) => a.kind === 'steplimit'), '17d: waiter failed=true ⇒ 照发卡（waiter 不在场时应有的行为）');

    // 17e：无心跳文件（未派 waiter）⇒ 照发（fail-open，保持 TOOL-MEMBERSTALL 原行为）
    T = T0;
    try { fs.unlinkSync(hbFile); } catch (e) { /* 忽略 */ }
    const w3 = mkHb();
    T += 61000;
    w3.ingestLine(PAUSE, T);
    ok(w3.decide(w3.evaluate(T), T).some((a) => a.kind === 'steplimit'), '17e: 无 waiter 心跳 ⇒ 照发卡（fail-open）');
    ok(w3.status().waiter.present === false, '17f: /health.stall.waiter.present=false');
  }

  console.log('SELFTEST ' + pass + '/' + (pass + fails.length) + (fails.length ? ' FAIL: ' + fails.join(' | ') : ' OK'));
  return fails.length ? 1 : 0;
}

/** 真实日志回放（模拟时钟随行时间推进；不发 QQ，只打印） */
function runReplay(file, opts) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let sim = 0;
  const w = createStallWatcher({ now: () => sim, log: () => {}, hasOpenAsk: () => false, cfg: Object.assign({ stateFile: '' }, (opts || {}).cfg || {}) });
  const fired = [];
  for (const ln of lines) {
    if (!ln) continue;
    const t = parseTs(ln);
    if (t != null) sim = t;
    if (!sim) continue;
    w.ingestLine(ln, sim);
    const due = w.decide(w.evaluate(sim), sim);
    for (const d of due) {
      fired.push({ at: new Date(sim).toTimeString().slice(0, 8), type: d.type, kind: d.kind || '', member: d.member || '', conv: shortConvOf(d.conv), min: d.minutes.toFixed(1), seq: d.seq, head: w._buildText(d, sim).split('\n')[0] });
    }
  }
  console.log('REPLAY ' + path.basename(file) + ' lines=' + lines.length + ' alerts=' + fired.length);
  for (const f of fired) console.log('  ' + f.at + '  ' + f.head);
  console.log('status=' + JSON.stringify(w.status()));
  return 0;
}
function shortConvOf(c) { return c ? String(c).slice(0, 8) : ''; }

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(runSelftest());
  const ri = argv.indexOf('--replay');
  if (ri >= 0 && argv[ri + 1]) process.exit(runReplay(argv[ri + 1]));
  console.log('usage: node stall-watcher.js --selftest | --replay <logfile>');
  process.exit(2);
}

module.exports = { createStallWatcher: createStallWatcher, classify: classify, parseTs: parseTs, stallKeep: stallKeep, DEF: DEF, RE: RE };
