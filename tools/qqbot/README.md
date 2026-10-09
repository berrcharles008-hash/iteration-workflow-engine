# QQ 机器人通知接入工具

通过 QQ 官方机器人，把「任务完成」等通知推送到你的手机 QQ（C2C 单聊）。

## 分发与兼容声明（引擎仓库工具包版，2026-10-05）

> 本目录由 `D:\sj-skills\iteration-workflow-engine` 顶层 `tools/qqbot` 作为唯一源，经 `sync-skills.ps1` 分发维护；0010 静配中心项目为唯一活跃实例（日常同步方向 project2engine）。工具包为 0010 血统，跨项目复用前请通读本节。

### 兼容性（安装前必读）
- Windows + Node.js ≥ 16；npm 依赖仅 `ws ^8.18.0`：**必须先在项目根或本目录 `npm install ws`**。⚠ ws 缺失时服务会「静默半死」——进程存活、心跳照写（watchdog 不告警），但 18765 HTTP 与 QQ WebSocket 全灭，service.log 仅一行「确认模块跳过」；健壮化修复（FATAL 退出）落地前，请以「/health 可访问」为健康判据。
- `headless` 接管依赖 PATH 中的 `codebuddy` CLI；`handoffPrompt`/`watcher.snoozeFile` 依赖 iteration-workflow skill 的标准 runtime 布局（`.codebuddy/skills/iteration-workflow/runtime`），未部署该 skill 的项目相应降级。
- 端口占用：18765（服务 HTTP，仅回环）/ 18766（session-hub，可选）/ 19000（headless serve，可选）。
- **单机单实例**：登录自启快捷方式为固定名（`CodeBuddyQQWatcher.lnk`），同机第二个项目执行 install 会**静默顶替**第一个的自启（叠加 18765 端口冲突）。
- 无凭据（`qqbot.creds.json` 缺失或空 appId）时服务启动即 `[FATAL]` + exit(1)，watchdog 同样不告警——这是预期行为，先完成步骤 3 再启动。

### 安装到新项目（engine2project 之后）
1. `npm install ws`（项目根或本目录）
2. `copy daemon.config.example.json daemon.config.json`，按需改端口/quietHours/handoffPrompt
3. `node qqbot-setup.js` 初始化凭据（生成 `qqbot.creds.json`；**含 secret，绝不入库/提交**）
4. `powershell -NoProfile -ExecutionPolicy Bypass -File install-service.ps1`（注册登录自启 + 停旧 + 立即启动）
5. 验证：`http://127.0.0.1:18765/health` 返回 200；service.log 无「确认模块跳过」；QQ 实发一条
6. 卸载顺序：先移除宿主 `.codebuddy/settings.json` 中对 `tools/qqbot/notify.qqbot.js` 的 hook 注册，再删目录

### 运维约定（sync 口径）
- 不随包文件（仅存在于项目实例）：`daemon.config.json`（实例配置，本目录 example 为模板）、`qqbot.creds.json`（凭据）、`DECOUPLING-PLAN.md`（0010 内部架构评估记录，**勿当操作指南**，其中 fail-open 规划与现行门禁口径不同）、`*.log`/`inbox.jsonl`/`runtime/`（运行时产物）。
- 引擎侧新增/更新文件**不会**随日常 project2engine 自动下发——需要一次性 engine2project（0010 已禁用全量方向，用 `-SyncItems tools/qqbot` 限定范围）。

## 文件说明
| 文件 | 作用 |
|---|---|
| `qqbot-setup.js` | 一键接入向导（推荐新人/他人使用） |
| `qqbot-listen-once.js` | 仅监听获取 openid（底层） |
| `notify.qqbot.ps1` | 发送通知（底层，PowerShell 版） |
| `notify.qqbot.js` | 发送通知（Node 版，供 **hooks/命令行** 调用；凭据 env > `qqbot.creds.json`） |
| `qqbot.creds.json` | 本地凭据文件（appId/secret/openId；**含 secret，已进 .gitignore，绝不提交**） |
| `qqbot-service.js` | **★ 合并服务（推荐）**：单进程 = IDE 静置推送 + QQ 双向确认，共享 token / 凭据 / 日志（取代下面两个 legacy） |
| `start-service.ps1` | 启动合并服务（后台；已在跑则自动跳过） |
| `install-service.ps1` | 注册登录自启（覆盖同名快捷方式，无需管理员）+ 停旧组件 + 立即启动 |
| `notify-enqueue.js` | 通知「可回复」入口：优先把通知送进服务待确认队列（带 #id），服务不可用时回退直发（门禁拦截通知走它） |
| `ask.js` | **等待式确认登记器**：`node ask.js --prompt "…"` → 推送 QQ 并输出 `#id=<n>`（agent 用它替代"停下来等输入"） |
| `wait-answer.ps1` | **等待答案**：`-Id <n> -TimeoutSec 300` 轮询答案文件，拿到即打印答案 JSON（exit 0）；分片超时 → `wait-timeout`（exit 2） |
| `notify-watcher.ps1` | （legacy，已被合并服务取代）IDE 自动推送兜底：轮询会话历史目录，写入静止即推 QQ |
| `install-watcher.ps1` | （legacy）注册 watcher 自启并立即启动 |
| `watcher.log` | watcher 运行日志（发现路径 / 每次 PUSH 结果） |
| `qqbot-daemon.js` | 常驻确认 daemon（方案 C/B）：WebSocket 监听 + 本地 HTTP 注册口（方案 B） |
| `request-confirm.js` | 向 daemon 注册一条待确认项（方案 B 的 genie/进程侧调用） |
| `daemon.config.json` | daemon 配置（关键词/回复/command/dryRun/listenPort/httpKey/requestTimeoutMs） |
| `inbox.jsonl` | 运行时生成的审计日志（每条消息 + taskId） |
| `package.json` | 依赖声明（ws） |

## ⚠ `/status` 人类状态页已下线（2026-10-03，session-hub 上线）
- 监控界面统一迁移至 **session-hub**：`http://127.0.0.1:18766/`（组件：`tools/session-hub/`，SSOT 见 `项目管理/PIVAS-会话监控中心（session-hub）方案分析.md`）。
- `GET /status` 现在的行为：hub 运行中 → **302 跳转** hub（老书签不断链）；hub 未运行 → 降级提示页（含启动方式）。目标 URL 可配（`daemon.config.json` → `hub.redirectUrl`）。
- 机器接口 **`/health`、`/pending` 原样保留**（watchdog/脚本/hub 在用）；`/pending` 新增 httpKey 校验（与 `/request` 同款：配置了 key 才校验，未配置保持放行）。
- hub 侧数据源：接管状态/serve 直链（hub 渲染期现读 `~/.codebuddy/settings.json` 口令，不在 qqbot 侧暴露）、待确认（/pending）、最近答复与 service.log 尾（hub 服务端直读）。

## ⚠ 本地消息注入端点 `POST /simulate-message`（2026-10-04，session-hub 方案 A）
- 用途：session-hub 页面上的「确认 / 取消 / 选项 / 回复」按钮——**与真实 QQ 消息等价**（注入 `handleMessage` 同一处理链，不绕过任何守卫）。
- 安全口径：**仅回环** + **独立 `hub.simulateKey` 必配**（`daemon.config.json` → `hub.simulateKey`；空 = 端点关闭）+ 预检拦截：命令类口令（心跳/关机/待机/中止关机/开新迭代/继续迭代/查看迭代/模型列表）一律 403；带编号目标项的 kind 白名单 `{ask, decision, gate, idle, new-iteration, continue-iteration}`，其余（如 shutdown/sleep）403 kind-blocked。
- ★ TOOL-QQNEWITER（2026-10-08）：`POST /request` 同步加 **命令类 kind default-deny**（`new-iteration`/`shutdown`/`sleep` 403）—— 该端点无条件透传 kind+handoff+handoffPrompt（且 httpKey 默认为空），不拦则可被本机任意进程伪造命令类项借用户一次确认执行任意 handoffPrompt；命令类 kind 只能由服务内部口令路径登记。`handoffFile` 亦收口（必须在 `headless.handoffDir` 内，否则丢弃回落默认）。★ TOOL-QQCONT（2026-10-09）：deny 清单扩为 `new-iteration`/`continue-iteration`/`shutdown`/`sleep` —— 同理，不拦则可借用户一次「确认#N」塞任意 handoffPrompt 起接管。
- 调用：`POST http://127.0.0.1:18765/simulate-message?key=<simulateKey>`，body `{"content":"确认#3"}`；hub 侧同值配置在 `tools/session-hub/hub.config.json` → `qq.simulateKey`。
- 审计：`inbox.jsonl` 记 `simulate-inject` / `simulate-blocked-command` / `simulate-blocked-kind`（hub 侧另有 hub-audit.jsonl 两行）。

## 前置条件
1. 安装 Node.js（建议 16+）。
2. 在 QQ 开放平台创建机器人，拿到 **AppID** 和 **AppSecret**。
3. 在平台「扫码聊天」中开启，使手机 QQ 能给该机器人发私信。

## 快速接入（其他人照做）
```powershell
cd tools/qqbot
npm install
node qqbot-setup.js
```
按提示键入 `AppID` / `AppSecret`；首次会启动监听，用手机 QQ 给机器人**发一条消息**，自动拿到 `openid`；再输入一条测试消息，发到你的 QQ。收到即接入成功。脚本末尾会打印 `setx` 命令，复制执行即可持久化凭据。

## 命令行参数（自动化 / 代跑）
```powershell
node qqbot-setup.js --appid <id> --secret <secret> --openid <oid> --message "内容"
```
缺哪一项就回退到环境变量，再没有才交互询问。

## 之后如何发通知
```powershell
pwsh -File notify.qqbot.ps1 -Message "你的任务完成通知"
```

## 平台限制
- 主动消息 20 条/分钟、每好友 1000 条/天。
- 若你近期未与机器人互动，主动消息可能被平台拦截 → 先发一条消息「保活」再试。

## 说明
- 发送内容使用 UTF-8，中文无乱码（早期 PowerShell 版乱码已修复为「字节数组 + `charset=utf-8`」）。
- 凭据（AppID / Secret / openid）从环境变量 `QQ_BOT_APPID/SECRET/OPENID` 读取；未设时回退同目录 `qqbot.creds.json`。禁止硬编码或提交入库（creds 文件已在 `.gitignore`）。

## 任务完成通知：自动推送 vs 主动推送（2026-09-17 实测）

| 场景 | 方式 | 状态 |
|---|---|---|
| **CodeBuddy Code CLI** 会话 | **Stop 钩子自动推**：`.codebuddy/settings.json` 注册 `Stop → node "$CODEBUDDY_PROJECT_DIR/tools/qqbot/notify.qqbot.js" "CodeBuddy 任务已完成"`；首次需在 CLI 会话输入 `/hooks` 审批 | ✅ 已端到端实测（含凭据文件修复） |
| **IDE（插件版）** 会话 | IDE 不触发 hooks（多轮实测无推送）→ 由 **agent 主动调** `node tools/qqbot/notify.qqbot.js "…"` 兜底 | ✅ 实测 HTTP 200 |

要点：
- 钩子触发但报 `Hook Stop [warning]` = 脚本 exit 1（典型原因：进程缺凭据环境变量 → 用 `qqbot.creds.json` 回退解决）。
- `notify.qqbot.js` 会读 stdin 的 `transcript_path`，本轮无工具调用（纯闲聊）则跳过推送，避免骚扰。
- 改动凭据/脚本**无需重启** CLI——钩子每次触发都重新调脚本。

## ★ 合并服务 `qqbot-service.js`（推荐 · 2026-09-17 实施）

把「IDE 静置推送（原 watcher）」与「QQ 双向确认（原 daemon）」合并为**单进程**，共享一套凭据、一份 access_token（90 分钟复用）、一套日志。

```powershell
cd tools\qqbot
powershell -File install-service.ps1 -IdleSeconds 30   # 注册登录自启（覆盖同名快捷方式）+ 停旧组件 + 立即启动
powershell -File start-service.ps1                     # 仅启动（后台；已在跑则自动跳过）
```

| 项 | 位置 / 命令 |
|---|---|
| 日志 | `tools/qqbot/service.log`（带 UTF-8 BOM，`Get-Content` 可直接看中文） |
| 健康/状态 | `curl http://127.0.0.1:18765/health`（含 `watch.idleSec` / `dirs` / `dryRun`） |
| 待确认队列 | `curl http://127.0.0.1:18765/pending` |
| 注册待确认 | `node request-confirm.js --prompt "…"`（亦可 curl POST `/request`） |
| 只测 QQ 网关连接 | `node qqbot-service.js --test`（连上 5s 后退出） |
| 只跑 watcher（排查用） | `node qqbot-service.js --no-daemon --idle 8 --watch-root <dir>` |
| 关模块 / 换端口 | `--no-watch` · `--no-daemon` · `--port 18766` |

说明：

- 静置判定与旧 watcher **完全一致**：5s 轮询 / 60s 重发现 history 目录 / 2min 全量扫 / 未来时间戳过滤 / sticky 会话 / 单周期去重；IDE 里持续活动时不推，停满 `IdleSeconds` 才推。
- 你在 QQ 回复「确认#N」「取消#N」由本服务路由；`daemon.config.json` 的 `dryRun: true` 时只回执**不执行命令**。
- ★ PowerShell 里 `curl.exe -d '{"k":"v"}'` 会因参数引号被吞而报 `bad json` ⇒ 请用 `node request-confirm.js` 或 `Invoke-RestMethod`。
- 手动停止：`Stop-Process -Id <pid>`（或任务管理器结束命令行含 `qqbot-service.js` 的 `node.exe`）。
- 回退：旧 `notify-watcher.ps1` / `qqbot-daemon.js` **仍保留**（未被删除），可单独运行。

### 档 3（2026-09-17）：通知「可回复」

- **门禁拦截优先入队**：`gate-check.mjs` 的 `notifyOnBlock` 现在 spawn `notify-enqueue.js` —— 先 POST 到 `127.0.0.1:18765/request` 入队，你会收到「`#N` 待确认：门禁拦截：…」；服务不可用（未启动/端口不通）时自动回退为直接发送，**不丢通知**。
- **回「确认#N」会做什么**：默认只回执 + 落 `inbox.jsonl` 审计。若要让确认真正执行命令：把 `daemon.config.json` 的 `dryRun` 改为 `false`，并配置 `gateCommand`（门禁类）或 `actions.confirm/cancel.command`（关键词类）。
- **号码书写兼容**：`#` 与全角 `＃`、半角/全角数字均可；待确认项**唯一**时回「确认」或「取消」即直通（多条时仍须带编号，避免误操作）。
- ⚠️ **边界**：QQ 回复**不能**替你在 IDE 里点「允许」（门禁弹窗是会话内交互）；它能做的是回执、审计、以及执行它自身能跑的本机命令。
- **性能约束（已修）**：目录发现 = 固定层级快扫 + 受限递归校正（实测 ≈142ms）；文件扫描有「深度 ≤2 / 文件 ≤3000」上限 —— 曾因全量扫描阻塞 event loop 导致入队请求超时重发。

## 「确认#N 执行命令」配置指南（2026-09-17）

### 执行闸：`dryRun`

| 值 | 行为 |
|---|---|
| `true` | 任何确认都只回执；`[DRYRUN]` 记日志（安全模式） |
| `false`（当前） | 配置内命令**真正执行**；成功/失败均回执（✔️ / ❌ 带错误摘要） |

影响面：① 编号确认「确认#N」→ 执行该待确认项的 command；② 无编号关键词（「确认 / 继续」）→ 执行 `actions.confirm.command`。
命令以**服务进程权限**（当前用户，非提权）、在**项目根目录**（cwd）下静默执行（`windowsHide`）。

### 三种命令来源（优先级从高到低）

| 来源 | 触发条件 | 说明 |
|---|---|---|
| 请求体 `command` | `/request` body 或 `request-confirm.js --command "…"` | **默认被拒**：`commandAllowlist` 为空 = 不接受请求体命令（仅日志留痕）。放行需配前缀白名单，如 `["powershell -File tools/qqbot/actions/"]` |
| `gateCommand` | `kind: "gate"` 的项被「确认#N」 | **全局单条**，适合"所有门禁确认都做同一件事"（当前指向 `actions/log-confirm.ps1`，把确认追加到 `gate-confirmations.log`） |
| `actions.confirm/cancel.command` | **不带编号**的关键词回复，且**当前无待确认项** | 把 QQ 当遥控开关（回「确认」跑一个固定脚本）；`cancel` 同理 |

### 上下文传递（给动作脚本）

服务经**环境变量**传上下文（不拼命令行 ⇒ 无注入面）：`QQ_CONFIRM_ID` / `QQ_CONFIRM_KIND` / `QQ_CONFIRM_PROMPT`。
示例脚本 `tools/qqbot/actions/log-confirm.ps1` 可直接复制改造；改完在 `daemon.config.json` 替换 `gateCommand` 即生效。

> 提示：动作脚本**建议 stdout 只输出 ASCII 摘要**，中文写文件（`-Encoding UTF8`）。子进程输出按系统代码页编码、服务按 UTF-8 解码 ⇒ 中文字符串走 stdout 会在 `service.log` 的 `[EXEC OUT]` 行显示为乱码（**文件内容不受影响**）。

### 链路

```
登记 #N → 发「#N 待确认… ⚠️ 将执行：<command>」
  → 你回「确认#N」→ parseReply → doPending(confirm)
    → 回执「✅ #N 已确认，开始执行：<prompt>」
    → dryRun=false 且 command 非空 → exec(command, {cwd=项目根, env=QQ_CONFIRM_*})
        成功 → 「✔️ #N 执行完成。」 ｜ 失败 → 「❌ #N 执行失败：<摘要>」
    → command 为空 → 「ℹ️ #N 已登记确认（该项未绑定命令，无动作执行）。」
```

### 安全须知

- 「取消#N」**永不执行**命令（只标记 cancelled）。
- 待确认消息会**原样展示将执行的命令**（`⚠️ 将执行：…`），确认前请核对。
- 白名单默认空 ⇒ 只有**你写进配置文件**的命令能执行；Agent / 其它本机进程无法经 HTTP 塞命令。
- 待确认项超时自动取消：**`ask.js` 默认 1800s（30 分钟）**；直接走 HTTP `/request` 且未带 `timeoutMs` 时才用 `requestTimeoutMs`（默认 600000=10 分钟）。同一编号只能被处理一次。
- ⚠️ 本机制**不能**替你在 IDE 里点「允许」，也不能唤醒 IDE 会话 —— 它执行的是服务自身能跑的本机命令。

### 门禁开闸命令（★ 2026-10-07 用户拍板：需要开闸时提示确认 → 确认后自动开闸）

- **唯一受白名单许可的请求体命令**：`node tools/gate/open-bypass.js --ttl <分钟>`（`daemon.config.json → commandAllowlist` 仅此一条）。
- 登记示例（Agent 侧）：
  `node tools/qqbot/request-confirm.js --prompt "开闸请求：<用途 / 迭代 / 改动范围>，TTL 240 分钟" --command "node tools/gate/open-bypass.js --ttl 240"`
  你回「确认#N」→ 服务执行 → 门禁开闸（`.codebuddy/hooks/.gate-bypass` = `ttlMinutes=240`）。
- **执行器三重护栏**：① `QQ_CONFIRM_ID` 环境令牌 —— Agent 直跑 ⇒ `REFUSED no_confirm_token`（exit 2），保住「Agent 不得自建逃生口」；② 答复回执 `.codebuddy/temp/qq-answers/<id>.json` 须 `answer=confirm`、≤3 分钟新鲜、未被用过（用后打 `bypassUsedAt`）；③ TTL 有界 2~480 分钟，写完按 hook 同款正则复解析，解析不到**立即删标记**（防内容不合规被 hook 当 forever 处理）。
- 可选参数：`--status`（只读看标记状态）、`--revoke`（关闸，免确认）。
- **留痕**：`.codebuddy/temp/open-bypass.log`（OPEN / REVOKE / REFUSE）+ `service.log` 的 `[EXEC #N]` / `[EXEC OUT #N]` + 门禁侧 `gate-audit.log` 的 `BYPASS reason=… ttl until=…`；到期自动失效，标记由门禁自清（`gate-check.mjs` GATE-TRV-DEL）。
- 改 `commandAllowlist` / `gateCommand` **须重启服务**（配置在启动时读取，不热加载）：`stop-service.ps1` → `start-service.ps1`。
- 首次实测（2026-10-07）：QQ 确认 → 自动开闸 → 闸开期越界写入放行 → TTL 到期自动恢复拦截，8 项正负向取证全绿。
- **QQ 故障兜底（2026-10-07 补 · 同日补齐 UI）**：本机 **session-hub 页面**（`http://127.0.0.1:18766/`）「待确认明细」里每一项带「确认 / 取消」按钮 —— 走 hub `POST /qq-reply` → qqbot `POST /simulate-message` → `handleMessage`，**与 QQ 回复等价、同一处理链**（服务侧 kind 白名单 `['', 'ask', 'decision', 'gate', 'idle', 'new-iteration', 'continue-iteration']`；hub 前端 `public/index.html` 同源白名单已同步）。★ 该按钮 **2026-10-07 新增**：此前 hub 只有只读列表，兜底得手工 `POST /qq-reply`。开闸请求自动带 `kind=gate`，页面会高亮为「🔓 开闸/门禁请求」。首次点击会弹 **hub httpKey 输入框**（`tools/session-hub/hub.config.json` → `httpKey`；写入 sessionStorage，本标签页记住）。
  ★ **实测状态（2026-10-07 晚）**：**按钮真实点击已端到端通过**（#6：`hub-audit` 记 `action:"confirm" id:6` + `qq-reply-result http:200` → `[EXEC #6] node tools/gate/open-bypass.js --ttl 5` → `bypass OPEN`）。同日另修：公网面板"永远停在加载中"（四请求各 8s 独立超时 + 提示文案）、`pending` 才渲染按钮且全为历史项时给出说明文案。
  ★ **判别证据（哪条路径提交的）**：`inbox.jsonl` 的 `msgId` —— **`hub-local-…` = hub 按钮注入**，**`ROBOT1.0_…` = 真实 QQ 消息**。真失败时兜底 = 手敲 `Set-Content <hooks>/.gate-bypass` 或直接 `POST /simulate-message?key=<simulateKey>` body `{"content":"确认#N"}`。
- **登记工具自带送达核验**（`request-confirm.js`，2026-10-07 加）：登记后回读 `service.log` 新增行 —— `[ASK #id] HTTP …` = 已发出；`[ASK ERR] …`（**服务侧不带编号**，故按"登记后新增行"界定）= 发送失败。输出 `REGISTERED / DELIVERY ok|FAILED|UNKNOWN`，**退出码 0=已送达、3=未确认送达** ⇒ 失败不再静默等超时。`--no-verify` 可跳过；`--kind` 可覆盖自动判定。
- **失败模式与处置**：① **服务未运行** ⇒ `request-confirm.js` 直接 `exit 2`（"连接 daemon 失败"）且**不登记任何编号**，需先 `start-service.ps1`；② **服务在跑但 QQ 发不出** ⇒ 项已登记（退出码 3），用 hub 页面确认或让用户手动开闸；③ 已登记但无人应答 ⇒ `ask.js` 默认 30 分钟、直接 `/request` 用 `requestTimeoutMs`（默认 10 分钟）后自动置 `expired`。IDE 内**没有**自动确认兜底（IDE 不向本机进程暴露点击事件）。

## 方案 B：QQ 确认 → headless 接管（2026-09-17）

适用：**会话已经停在输入框等确认**，而你在工位外想让它继续 —— 用一个 CLI 非交互会话把剩余任务接着跑完（原会话上下文不继承，靠 handoff 文件传递）。

- **触发**：待确认项带 `handoff: true`（登记时指定）且 `headless.enabled = true`。
- **配置**（`daemon.config.json`）：

  ```json
  "headless": {
    "enabled": true,
    "command": "codebuddy -p --permission-mode acceptEdits \"{prompt}\"",
    "timeoutMs": 1800000,
    "replyChars": 600,
    "handoffDir": ".codebuddy/temp/handoff"
  }
  ```

  占位符 `{prompt}` / `{handoff}` / `{id}`；执行 cwd = 项目根；超时默认 30 分钟。
- **handoff 文件**：登记 `handoffFile` 可指定既有文件；缺省由服务生成 `handoffDir/qq-<id>.md`，其 `## 剩余工作` 小节 = 登记的 `handoffPrompt`；**未提供则指令降级为「只输出摘要、不要改文件」**（安全默认）。
- **登记**（带 handoff 请用 HTTP，`request-confirm.js` 目前只透传 prompt）：

  ```powershell
  Invoke-RestMethod -Uri http://127.0.0.1:18765/request -Method POST -ContentType 'application/json' `
    -Body '{"prompt":"待确认事项…","kind":"manual","handoff":true,"handoffPrompt":"剩余工作：…"}'
  ```

- **流程**：`你回「确认#N」→ 服务写 handoff → exec codebuddy -p … → QQ 回执「✅ #N headless 接管完成：<输出尾部>」`（失败/超时 → ❌ 回执）。
- ⚠️ **限制**：CLI 与 IDE 会话**存储不共享**（实测：本项目 CLI 侧只有独立的一条会话）⇒ 接管是"**新会话继续**"，不是"复活原会话"；原 IDE 会话仍显示为等待中，需你回工位时手动收尾或忽略。
- ⚠️ headless 会话同样受门禁约束（PreToolUse hook 生效）：04 阶段放行，其它阶段该拦就拦；`--permission-mode acceptEdits` 只免"常规编辑确认"，不绕过高危项。

## 方案 A：等待式确认（agent 不停机，QQ 回复驱动继续）（2026-09-17）

适用：**会话正在跑、需要用户拍板**（例如"是否按此预览批量落盘？"）—— 让 agent **不要停下来等输入**，而是"登记 + 轮询等待"；你在 QQ 回复后它立刻继续。这是让**原会话**在工位外继续的唯一可行方式。

- **登记**（输出 `#id=<n>`）：

  ```powershell
  node tools\qqbot\ask.js --prompt "是否按此预览批量落盘（含 Δ 补充 4 项 + fmtStatus 改灰）？"
  # 已登记 "#3" 并推送到 QQ（回复「确认#3」或「取消#3」）
  # #id=3
  ```

- **等待**（**模式 A** 分片 ≤5 分钟/次，**总时限与 D 同为 30 分钟**（≤6 片）；**模式 D** 单片 900s、一轮 2 片 = 30 分钟 —— 细则唯一来源：`.codebuddy/skills/iteration-workflow/engine/waiting-protocol.md`；另见文末「方案 D」）：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\qqbot\wait-answer.ps1 -Id 3 -TimeoutSec 300
  # exit 0 + {"id":3,"answer":"confirm","ts":"…","prompt":"…","kind":"ask"}
  # exit 2 + {"id":3,"answer":"wait-timeout"}      ← 本片未拿到，再调一次继续等
  ```

- **答案取值**：`confirm` / `cancel` / `timeout`（超时由服务写入；`ask.js --timeoutSec` 可覆盖 `requestTimeoutMs`）。
- **答案文件**：`.codebuddy/temp/qq-answers/<id>.json`（含 `prompt` 原文，便于对账）。
- **确认后要"接管继续"**：登记时加 `--handoff --handoffPrompt "剩余工作：…"`，走方案 B 的 headless 路径。
- **agent 侧约定**：需要用户确认时**优先用 ask + wait**（而非直接提问后停下）；`MEMORY.md` 已登记该约定。
- ⚠️ **A 与 B 的分工**：**A = 让原会话继续**（会话必须仍在运行/轮询中）；**B = 换新会话继续**（适用已停会话）。两者可组合：A 等待超时后可转 B 接管。
- ✅ **端到端实测（2026-09-17）**：`ask.js` 登记 → QQ 回「确认#1」→ 服务写答案 → `wait-answer.ps1` 返回 `{"answer":"confirm"}` 且 exit 0。

### FIX-17e：headless 接管锁（2026-09-18）

- **目的**：headless 接管运行期间，防止 IDE 侧会话继续写业务区（两个"干活者"并行改同一迭代 ⇒ `state.yaml` 互相覆盖）。
- **机制**：服务启动 headless 前写锁 `.codebuddy/temp/handoff/RUNNING.json`（含 `id`/`startedAt`/`expiresAt`），回调时释放；`gate-check.mjs` 读锁 ⇒ **锁有效期内拦截一切业务区写入**（拦截消息含「接管 #N 起于 … 剩余约 M 分钟」与解除方式）。
- **豁免与安全**：① headless 自身（服务 exec 注入 `PIVAS_HANDOFF_OWNER`，随 CLI → hook 继承）② 锁文件本身允许删除（用于解除锁定）③ `expiresAt` 超时自动失效（崩溃残留不锁死 IDE）④ **fail-open**（无锁 / 过期 / 解析失败 ⇒ 视为无锁）⑤ **逃生口优先于锁**（人开闸 = 人接管）。
- **相关配置/健康项**：`daemon.config.json` 的 `watcher.handoffGuardSec`（默认 120s，启动前的活动闸门）；`/health` 的 `handoffGuardSec` / `handoffRunning` / `handoffLock`。
- **实测（09-18）**：模拟锁 `#99` ⇒ 05 本职目录（本应放行）写入**被拦**；`Delete` 删锁后重试**恢复放行** ✅

## ★ FIX-17：静置通知可回复 + token 自愈 + 统一出口（2026-09-17 晚）

**起因（事故取证）**：17:44 你在 QQ 回复「方案通过」但 IDE 无任何处理。取证结论 = 那条是**单向通知**（无 `#id`、服务 `pending` 为空），回复既不被 `parseReply`（只认 `确认#N`）也不被关键词识别 ⇒ 死信；同时服务侧 `PUSH` 自 17:32 起全 `HTTP 401`（token 被 `notify.qqbot.js` 直发顶号）。详见 `.codebuddy/memory/2026-09-17.md`。

**三项改动**：

1. **静置推送自动入队**（配置 `watcher.autoQueue` / `autoHandoff` / `handoffPrompt`；默认 `autoQueue=true`、`autoHandoff=false`）
   - 静置到阈值 → 走 `registerRequest(..., kind='idle', {handoff})` ⇒ 你收到「`#N` 待确认：会话已静置…」，回「确认#N」即可驱动；
   - `autoHandoff=true` ⇒ 确认后自动 `codebuddy -p` **新会话接管**（按 `handoffPrompt` 读 runtime state 从接续入口继续；**遇到确认门自停**）；
   - 已有未决 idle 项时跳过登记，避免刷屏堆积。
2. **关键词兼容 + 否定词优先**
   - `confirm` 增「通过 / 方案通过 / 评审通过 / 批准 / 可以 / 没问题 / 认可」；`cancel` 增「驳回 / 不通过 / 未通过 / 拒绝 / 否决」；
   - `route()` 改为 **cancel 先判** —— 否则「不通过」会被 confirm 的「通过」子串劫持（误执行）。
3. **统一发送出口 + 401 自愈**
   - 服务新增 `POST /notify`；`notify.qqbot.js` **优先经此发送**（复用服务长连接 token），服务不可用自动回退直发（且**凭据缺失不再立即退出**，先试服务）；
   - `send()` 遇 `401` → 强制刷 token 重试一次 ⇒ 根治「多进程各取 token 互相顶号」。

**实测**：`node --check` ×3 通过；重启后 `/health` = `autoQueue:true, autoHandoff:true, headless:true`；`notify.qqbot.js` 实发 → `[OK] QQ 通知已发送（via service） HTTP 200`。

> ⚠️ **本质边界（未变）**：IDE 会话**不能被注入**（CLI/IDE 存储不共享）⇒ 方案 A 只在 agent 挂着 `wait-answer.ps1` 的窗口期内有效；会话已停时唯一可行的是 **B（CLI 新会话接管）**，而 watcher 自动入队 = 它的兜底入口。
> 📌 **Agent 约定（铁律）**：需要用户拍板时**必须** `ask.js`（带 `--handoff`）+ `wait-answer.ps1` 分片轮询；**禁止**只发单向通知却在文案里写"等你确认"。

### FIX-17b：静置消息带定位上下文（2026-09-18）

**起因**：静置推送只有「CodeBuddy 会话已静置：任务完成，或在等待你确认」——工位外或多会话并行时，**无法判断是哪个任务在等确认**。

**改动**：

- 静置消息改为动态拼装（`buildIdlePrompt()`）：`会话静置 Ns（时间）` → `会话：<会话名> [<convId 前 8 位>]` → `工作区：<项目名>` → `迭代：<ID>（阶段 X · status）` → `待办步骤：<最多 3 条 pending>`。
  - 会话名取自 `history/{conversationId}/index.json` 的 `conversations[].name`（实证存在，如「静配中心管理系统迭代启动」）；
  - 迭代信息取自 `runtime/ACTIVE` + `{ID}.state.yaml`（`current_phase` / `phase_status` / `status: "pending"` 的步骤）；
  - 读取失败自动降级（缺哪段就少哪段，不阻塞推送）。
- **去重粒度从「全局」改为「按会话」**：同一会话已有未决 idle 项才跳过；多会话并行各自登记，不再互相吞并。
- `registerRequest` 记录 `session` 字段（供去重与审计）；`PUSH(QUEUE)` 日志增 `session=` 短码。

样例：

```
#3 待确认：
会话静置 32s（2026-09-18 09:12:03）
会话：药品字典布局风格对齐 [1546e1f3]
工作区：0010静配中心管理系统
迭代：2026-09-17-002-药品字典布局风格对齐（阶段 05 · in_progress）
待办步骤：step-0-baseline 基线复验 ｜ step-1-… 
🤖 确认后由 headless 接管继续执行
回复「确认#3」执行，或「取消#3」中止。
```

### handoffPrompt 口径（2026-09-18 用户拍板）：带护栏的自动推进

平衡「工位外推不动」与「越过用户确认门」：**可逆的、方案已确认的工作直接做完；不可逆的必须停下**。

- **可直接做**：04 编码、05 验证、文档/状态回写（无需逐门等待）。
- **必须停下报告**：① 不可逆/破坏性（写库 DDL/DML、删除或移动文件、SVN/git 提交推送、部署发布）；② 改变已确认口径（需求取舍、范围调整、影响面扩大）；③ 互斥选项且文档无依据。
- **越权自证**：完成后简报必须列明「做了什么 ｜ 改了哪些文件 ｜ **越过了哪些确认门及依据** ｜ 下一步建议」⇒ 把事前审批换成事后可复核。

> ⚠️ 前提认知：`gate-check.mjs` 对 headless 会话同样生效（删除/危险命令/阶段外写入照样硬拦）——**红线由 hook 守，prompt 只覆盖 hook 管不住的部分**（写库、提交、发布）。

### FIX-17c：防「headless 代跑」与「人工操作」撞车（2026-09-18）

**起因（实测事故）**：静置自动登记 `#N` 后你在 QQ 回「确认#N」启动 headless；与此同时人（或原会话）也在动手 ⇒ **两个"干活者"并行改同一迭代**（`state.yaml` 互相覆盖、内容互斥）。

**三道闸**：

1. **活动即作废**（`supersedeIdlePending()`）：watcher 检测到会话从「静置」回到「活动」（IDE 又有写入）⇒ 未决 idle 项立即标 `superseded`（写答案文件 + QQ 提示「会话已恢复活动，该项自动作废」）⇒ 你回工位一动，那条待确认就失效，不会误点。
2. **接管前活动闸门**（`watcher.handoffGuardSec`，默认 `120`）：即便先回了确认，若会话在窗口内仍有写入 ⇒ **拒绝启动** headless，回执「检测到会话仍在活动，已取消接管，请在 IDE 内继续」。
3. **接管互斥**（`handoffRunning`）：已有 headless 在跑时，新确认不重复启动（回执说明），避免双 headless 并行。

`/health` 增 `handoffGuardSec` / `handoffRunning` 两个字段便于排查。

> 设计意图：**人在工位 → 永远人在干；人离开 → 才由 headless 代跑**，两者不再重叠。

### FIX-17d：自由文本答复回路（2026-09-18）

**起因（实测事故）**：headless 把「请选 A / B / C」写成**纯文本菜单**，用户在 QQ 回「B」→ 服务只认 `确认#N / 取消#N / 通过 / 驳回` ⇒ 回「未识别指令」。**问题发得出、答案回不来。**

**三步闭环**：

1. **提问方必须登记**（已写进 `handoffPrompt`）：需要用户在多个选项中拍板时**禁止**只写菜单文本，必须
   `node tools/qqbot/ask.js --prompt "<问题+选项>" --handoff --handoffPrompt "<按答复继续执行的指令>"` 登记成可回复项；
2. **服务接受内容型回答**（`doFreeReply()`）：收到非命令文本且**存在唯一未决项**时，视为对该项的答复 ——
   写答案文件（`{"answer":"text","text":"B"}`）＋ 若该项带 `handoff` 则**用你的答复起新一轮 headless**
   （handoff 文件含「★ 用户本轮在 QQ 的答复：B」；护栏不变 = `handoffGuardSec` 活动闸门 + 接管互斥）；
3. **回执**：「✅ #N 已记录你的答复「B」，并交新一轮 headless 继续执行」；无未决项时保持原 fallback 提示（闲聊不会被误当指令）。

**配套 `poll-answer.js`（IDE 侧主动拉取）**：IDE 会话无法被推送唤醒 ⇒ 回到工位后由 agent 主动读答复（避免与 headless 重复劳动）：

```powershell
node tools/qqbot/poll-answer.js            # 列出未消费答复（--all / --since / --json）
node tools/qqbot/poll-answer.js --consume  # 标记已消费（写 consumedAt）
```

> ★ **消费约定（2026-09-30 新增 · QQ-WAKE-1）**：**处理完毕才消费**——答复内容落入本轮动作后再跑 `--consume`（幂等，只标未消费项）；
> **不得**与 `wait-answer.ps1 -SinceIso` **同回合混用**：`--consume` 会整文件重写答案 JSON ⇒ **mtime 前移到现在**，
> 而 `-SinceIso` 的新鲜度判据是「mtime ≥ since」⇒ 已消费的旧答复会被**误判为新鲜**（FIX-40 护栏被削弱）。
> 另：`poll-answer.js` 只做**读回**——**不唤醒**已静置会话；回读到的答复若属**不可逆动作**仍走 FIX-20 决策回路，不得自动执行。

配置：`actions.freeText.enabled`（默认 `true`）· `actions.freeText.maxChars`（默认 `300`，超长视为普通消息、不触发）。

### FIX-17e：headless 接管锁 ——「IDE ⇄ headless」双向互斥（2026-09-18）

**起因（实测事故）**：你在 QQ 确认 `#N` 触发 headless 接管的同时，人（或原会话）也在动手 ⇒ **两个"干活者"并行改同一迭代**（`state.yaml` 互相覆盖）。FIX-17c 的三道闸方向都是「**防启动**」，**没有一条管「headless 已在跑、IDE 又动手」**；且 `handoffRunning` 是**进程内**计数，服务重启即归零。

**机制**：

| 端 | 行为 |
|---|---|
| 服务 `qqbot-service.js` | `runHeadless` 启动前**检锁**（拒绝重复启动，跨进程有效，顺带修掉重启盲区）+ 启动时写 `<handoffDir>/RUNNING.json`（`{id, startedAt, expiresAt, pid}`）+ `exec` 回调**无论成败都释放**；`exec` 注入 `PIVAS_HANDOFF_OWNER`；`/health` 增 `handoffLock` |
| hook `gate-check.mjs` | 「**第0关**」：锁有效 ⇒ 拦截 Write/Edit/Delete/危险 Bash，提示「接管 #N … 剩余 X 分钟」+ 解除方式。豁免三种：① headless 自身（`PIVAS_HANDOFF_OWNER`，随 CLI → hook 继承）② **锁文件自身删除**（自救口）③ 逃生口（人开闸 = 人接管，优先级最高） |

**安全设计**：`expiresAt` 超时自动失效（headless 崩溃**不会**把 IDE 永久锁死）｜**fail-open**（无锁 / 过期 / 解析失败一律视为无锁）｜人要接管随时可删锁。

**实测（2026-09-18）**：模拟锁 `#99`（TTL 15min）→ 写 `docs/iterations/**`（05 本职目录，**本应放行**）**被拦**（消息含接管中提示 + 解除方式）→ `Delete` 删锁**放行** → 重试同样写入**恢复放行** ✅

**手动解除**（任选其一）：

```powershell
Remove-Item .codebuddy\temp\handoff\RUNNING.json    # 或用 IDE 的删除操作（该删除已在 hook 中豁免）
```

### FIX-19：门禁通知不再误报 + 消息带上下文（2026-09-18）

**起因（实测事故）**：2026-09-18 09:53 连发 4 条「#34~#37 待确认」，但 IDE 侧**并无任何需要人工确认**的操作；且每条只有一句「门禁拦截：当前阶段 0X 不允许…」，**看不出当时在处理什么**。

**根因**：

| # | 现象 | 根因 |
|---|---|---|
| ① | 出现 `迭代: test-iter` 的假拦截 | `gate-regression-test.py` 以**合成 stdin** 调 hook，拦截是**预期结果**；hook 对所有 `block()` 无条件发 QQ。`test-iter` 只存在于测试夹具 `SCENARIOS` |
| ② | 审计日志里查不到这几条 | `audit()` 写的是 `GATE_TEST_RUNTIME_DIR/gate-audit.log`（= 临时夹具，跑完 `rmtree`）⇒ 主工作区**无痕**，只有 QQ 留下消息 |
| ③ | 消息无上下文 | `notify-enqueue.js` 只取 `payload.prompt` 发给服务，服务端 `registerRequest` 用它拼 `#N 待确认：…` ⇒ `title/status/rows/next` 被**整体丢弃** |
| ④ | 不同拦截被吞 | 「全局 60s」去重会把**不同目标**的连续拦截一并吞掉 |

**改动**：

| 文件 | 改动 |
|---|---|
| `.codebuddy/hooks/gate-check.mjs` | ① **测试态静默**：`GATE_TEST_RUNTIME_DIR` / `GATE_TEST_DISABLE_BYPASS` 存在 ⇒ 只审计 `QQ_NOTIFY_SKIP(test)`（**无需改测试脚本**即生效）；② 手动总开关 `QQ_NOTIFY=0` 或 `hooks/.qq-notify-off` 标记；③ 去重升级为「全局 20s 防连发 + 同指纹 10min 防刷屏」（指纹 = 原因行 + 目标；窗口起点不刷新 ⇒ 持续发生时每 10min 必定再提醒一次）；④ **上下文**：工具 / 目标或命令原文 / 迭代·阶段 / 待办步骤（口径同 `qqbot-service.js` 的 `readIterationContext`） |
| `tools/qqbot/notify-enqueue.js` | 结构化 `title/status/rows/next` **渲染进 prompt** 再入队（复用 `notify.qqbot.js` 的 `renderStructured`），渲染失败回退旧逻辑 |
| `tools/qqbot/notify.qqbot.js` | 主流程加 `require.main === module` 守卫并导出 `renderStructured` ⇒ 复用渲染函数**不会**触发发送 |

**新消息样例**（QQ 实收）：

```
#53 待确认：
【CodeBuddy 需你确认】
当前阶段 05 不允许进行文件写入操作。
──────────────
工具：Write
目标：back-end/a.cs
迭代：2026-09-17-002-药品字典布局风格对齐（阶段 05）
待办：step-0-baseline 基线复验
──────────────
➡️ 下一步：确认动作在 IDE 侧（放行=开逃生口/切换阶段；QQ 回「确认#N」仅登记意图）
回复「确认#53」执行，或「取消#53」中止。
```

**实测（2026-09-18）**：`node --check` ×3 通过；测试态探针（夹具 `test-iter` + `Delete back-end/a.cs`）⇒ audit 命中 `QQ_NOTIFY_SKIP reason=test` 且**无** `QQ_NOTIFY`（不再发 QQ）✅；渲染样例入队 `#53` ⇒ QQ 收到多行上下文 ✅

**静默开关用法**：

```powershell
$env:QQ_NOTIFY = '0'                                    # 当前会话静默（维护 / 批量期）
New-Item .codebuddy\hooks\.qq-notify-off -ItemType File  # 全局静默（含其它会话），用完删除
```

### FIX-20：推送策略口径 —— 任务结束才推 · 决策必带 #N · 中间环节静默（2026-09-18）

**起因**：用户口径 = 「只在**每个任务结束后**推；需用户决策 → 带回执（`#N`）；其余 → 完成通知；**中间环节模型自动推理不推送**」。核查发现三处违规：① `Stop` 钩子**每回合**都发「任务已完成」（只跳纯问答，无节流）；② watcher「文件静止 30s」是启发式（闲聊/长思考也推）；③ 完成类与决策类无显式分类，静默开关只管门禁。

**口径表**（`--kind`）：

| kind | 含义 | 何时用 | 发送策略 |
|---|---|---|---|
| `done` | **任务结束** | agent 显式声明（主信号） | 入合并队列（90s / 满 5 条）· 同会话 10min 去重 |
| `done --fallback` | **本轮结束**（多步任务可能未完） | `Stop` 钩子兜底（防漏推） | 同上；且「已发过 done」时**跳过**（根治双发） |
| `fail` | 失败 / 异常（需决策） | 编译失败、hook 报错、任务中断 | **立即发**，不受免打扰限制 |
| `progress` | 长任务心跳 | 超长任务（>20min）怕被当卡死 | 入合并队列 |
| `decision` | 需你拍板 | **必须**先 `ask.js` 拿到 `#N` | **立即发**；**缺 `--id` 直接报错退出**（机制保障） |

**用不到的场景一律不推**：中间推理、单步完成、纯问答/闲聊静置（watcher 读最后一条 assistant 是否含 `tool_use`，无产出即跳过）。

**用法**：

```powershell
node tools/qqbot/notify.qqbot.js --kind done "M4 贴签核对改造完成（13/13）"
node tools/qqbot/notify.qqbot.js --kind fail "msbuild 失败：CS0246 ×3"
node tools/qqbot/notify.qqbot.js --kind decision --id 12 "已登记 #12：是否按方案 A 落盘？"   # 缺 --id ⇒ exit 1
node tools/qqbot/ask.js --prompt "是否执行 DDL？" --kind irreversible                        # 不可逆动作（hook 已强制）
```

**配置**（`daemon.config.json` → `notify`）：

| 项 | 默认 | 说明 |
|---|---|---|
| `mergeWindowMs` | `90000` | done/progress 合并窗口（**单条 ⇒ 直发原文**；多条才攒成「【汇总 · N 条】」摘要，见 FIX-39） |
| `mergeMax` | `5` | 达到条数立即 flush |
| `quietHours` | `{from:23,to:8}` | 免打扰：**只放行 `fail`/`decision`**，done/progress 顺延到时段结束 |
| `skipNoToolUse` | `true` | watcher 跳过「无工具产出」的会话 |
| `watcher.idleSeconds` | `90`（原 30） | 30s 会把长思考停顿误判成「回合结束」 |
| `heartbeatMs` | `1200000`（20min，`0`=关） | ★ FIX-24：会话持续活跃却久无推送 ⇒ 自动发一条 `progress` 心跳（入合并队列，免打扰顺延） |

**统一静默开关**（与门禁共用，**本出口此前不认**）：`QQ_NOTIFY=0` 或建 `.codebuddy/hooks/.qq-notify-off`；客户端 + 服务 `/notify` 双侧检查。

**不可逆动作强制决策**（`gate-check.mjs`）：拦截原因命中 `svn commit / git push / run_ddl / drop|truncate table / 部署|发布 / 删除文件` ⇒ 不再发普通拦截通知，而是 **spawn `ask.js --kind irreversible --timeoutSec 7200`** 登记成必答项（此前只靠 `handoffPrompt` 文字约定）。

### FIX-21：门禁通知去误报 —— 只有「会话结束仍被阻断」才推（2026-09-18）

**起因**：原实现在 `block()` 的**瞬间**就发 QQ（`notifyOnBlock`）。而 `block()` 只要「判定为越界」就触发 —— 包括 agent 推理中**自判门禁**、实际**已开闸**、或**换个路径就绕过去**的情况 ⇒ 大量误报（2026-09-18 用户反馈）。

**新机制**：拦截**只留痕不发**，判定推迟到会话结束。

1. `block()` → 追加 `.codebuddy/temp/gate-events.jsonl` 一条 `{ts, kind:'block', tool, target, reason}`；
2. 写类工具**最终放行** → 追加一条 `kind:'allow'`（`process.on('exit')`，退出码非 2 且工具属 `WATCHED_TOOLS`）；
3. `Stop` 钩子新增 `node .codebuddy/hooks/gate-check.mjs --stop-check`（**必须早于逃生口块**，否则开闸态下 `process.exit(0)` 直接放行、永远执行不到）：
   **命中通知** ⇔ ① 有 block；② block **之后没有 allow**（没开闸、没绕成功）；③ block 距会话结束 ≤ 10min。

| 场景 | 判定 |
|---|---|
| 推理中自判门禁 / 已开闸 / 换路径成功 | `no-real-block` ⇒ **不推** |
| 会话末段确实被拦、之后无成功写入 | `real-block` ⇒ 推一条（带工具/目标/拦截时刻/迭代/待办） |
| 很久以前的拦截（>10min） | 与本次无关 ⇒ 不推 |

### FIX-22：完成通知必须带「当时正在处理的具体事项」（2026-09-18）

**起因**：默认文案 `CodeBuddy 任务已完成` 没有上下文；且粒度常常写成「迭代任务完成 / 布局对齐」，看不出刚做了什么。

**规则（机制保障，不是靠自觉）**：

- `--kind done|fail` **必须**有具体事项：① 显式 `--what`；② 或 `--json` 的 `title`；③ 否则从 transcript **自动推断**（结果标 `[推断]`）；**三者都取不到 ⇒ exit 1 拒发**；`--fallback` 兜底取不到 ⇒ 静默跳过。
- **粒度校验**：长度 <8、纯泛词（迭代/阶段/项目/布局对齐…）、或不含「文件名 / 路径 / `→` 差异 / 数字」⇒ **exit 1 拒发**并给出改写示例。
- 推断来源（已实证）：工具调用是**独立行** `{"type":"function_call","name":"Edit","arguments":"<JSON字符串>"}`，取最近 3 条 → `动作 + 目标文件 + 首个不同行差异`。

```powershell
node tools/qqbot/notify.qqbot.js --kind done --what "drug_list.vue 第342行 dosage 列宽 120→90" --detail "同步改 drug_list.less 表头"
node tools/qqbot/notify.qqbot.js --kind done "布局对齐"            # ⇒ exit 1：粒度过粗
node tools/qqbot/notify.qqbot.js --kind done --dry-run             # 只渲染不发送（自测用，不写去重状态）
```

**连带修复**：旧「纯问答/闲聊跳过」判定 `o.type === 'assistant'` + `/tool_use/` **恒不匹配**（实测 `type` 是 `message`，`assistant` 是 `role`；工具调用是独立行）⇒ 该保护一直失效。客户端与 `qqbot-service.js` 双侧已改为扫描 `function_call` 行（格式不识别时 fail-open，宁可误推不可漏推）。

### FIX-23：静默开关 TTL（2026-09-18）

`.qq-notify-off` 内容支持 `ttlMinutes=60` 或 `expire=2026-09-18T23:00`（起点 = 文件 mtime）；**过期 ⇒ 视为未静默**，防「开完忘记删」永久静默。空标记 = 永久（旧语义不变）。客户端与服务双侧同步。

### FIX-24：长任务自动心跳（2026-09-18）

会话**一直活跃**（`idle < idleMs`）却超过 `notify.heartbeatMs`（默认 20min）没任何推送 ⇒ 自动入队一条 `progress`：当前动作 → 迭代阶段/待办 → 会话定位。避免长任务期间完全失联；与 done 同走合并队列，免打扰顺延。

**自测记录（2026-09-18）**：

| 项 | 结果 |
|---|---|
| FIX-21 三场景（仅 block / block 后 allow / 超窗 block） | `real-block` · `no-real-block` · `no-real-block` ✔（静默态只留审计） |
| FIX-22 四场景（无 what / 过粗 / 显式 / 自动推断） | exit 1 · exit 1 · 渲染通过 · `改 …/2026-09-17-002-….state.yaml（(空) → - phase: "05"）` ✔ |
| FIX-23 TTL（过期 / 永久 / 无标记） | `muted=` · `muted=marker` · `muted=` ✔ |
| ⑤ 免打扰顺延（隔离实例 18766 · dryRun） | 免打扰：入队 **无 FLUSH**；非免打扰：入队 → `[MERGE FLUSH] HTTP 200` ✔ |
| 端到端实发（生产 18765） | `[MERGE] +1` → 90s 后 `[MERGE FLUSH] HTTP 200 n=1` ✔（真发 1 条） |
| `node --check` ×2 + config 解析 | 通过 |

**自测记录（2026-09-18 · 全程在静默标记下执行，未真发 QQ）**：

| 项 | 结果 |
|---|---|
| `node --check` ×3（notify / service / gate-check） | 通过 |
| 静默探针 `--kind done` | `[SKIP] QQ 推送已静默（marker）` exit 0 |
| `--kind decision` 缺 `--id` | `[ERR] …必须带 --id` **exit 1**（校验前置，不受静默影响） |
| 完成类去重（单元） | 兜底首次 `false` → 再次 `true`；**显式 done 之后兜底 = `true`**（双发已根治）；显式 done 自身不被吞 |
| 服务重启后 `/health` | `watcher.idleSeconds=90`｜`notify={queued:0, quiet:false, muted:"marker", mergeWindowMs:90000, mergeMax:5}` |
| 门禁回归 `gate-regression-test.py` | BASE failures **0** · FIX **80/80** |

> ⚠️ 静默期内**无法**实发验证的两项（仅代码级验证，待恢复推送后观察）：合并队列 flush 出的「【汇总 · N 条】」摘要、免打扰时段对 `done/progress` 的顺延。

### FIX-25：「用户已回 IDE」判定不区分会话 ⇒ 按会话分桶（2026-09-18）

**起因（用户提问）**：QQ 发了待确认消息，人回到 IDE，但**进的可能不是那条消息对应的会话**，
机制却当成「用户已接管」⇒ 待确认项被作废、接管被拦。

**根因（3 处）**：

| # | 位置 | 问题 |
|---|---|---|
| ① | `newestWriteTime()` 原 L333-358 | 跨**全部 14 个** history 根只取**一个全局 max** mtime，且 `WATCH.lastSession` 是单一全局变量 |
| ② | `supersedeIdlePending()` 原 L763-777 | 「静置→活动」即**无差别作废所有 `kind==='idle'` 未决项**，不比对 `p.session`（登记侧 FIX-17b 已按会话去重 ⇒ 两处口径不一致） |
| ③ | 闸门 `doPending()` / `doFreeReply()` | 读同一个全局 `lastActivity` ⇒ 别的会话一动就拒绝接管，回执「请在 IDE 内继续」却不指明哪个会话 |

**粒度事实**：`history/<hash>/` 一级目录 = **工作区容器**（其 `index.json` 的 `conversations[]` 才是会话）
⇒ `p.session` 存的是工作区路径 ⇒ **同一工作区内另开会话**同样分不开。

**改动（5 项 + 2 项防护）**：

1. **分桶**：`WATCH.activity = Map<sessionDir, {lastActivity, lastNotified, seen}>`；
   `newestWriteTime()` 由「取全局 max」改为「每个被扫描会话各记一次」（`maxMtimeUnder` 本就算过，只是原先丢弃非最大者）；
   全局 `lastActivity` 降级为镜像（`/health` · 心跳 · 会话定位）。
2. **作废按会话**：`supersedeIdlePending(session)` 只作废 `p.session === session` 的项；
   被跳过的项记 `[SUPERSEDE skip] N 条属于其它会话 … ⇒ 保持 pending`。
   ★ **撞车防护不削弱** —— 改由「闸门按该项所属会话判定」承担：同会话在动 ⇒ 拦；别的会话在动 ⇒ 放行
   （headless 启动后仍由 FIX-17e 接管锁拦住 IDE 侧写入）。
3. **闸门按会话**：新增 `sessionIdleMs(p)`；**无桶 ⇒ 返回 -1 ⇒ fail-open**（视为静止，放行接管）。
4. **登记按会话 + `seen` 门控**：每个会话各自判定静置并登记（旧逻辑只看全局最新会话）；
   ★ 但**只有「本次运行期内观察到过活动」的会话才会登记**（见下方事故）。
5. **全量周期 ~120s → ~60s**：分桶后漏扫会使桶值陈旧 ⇒ 误判静置，须 < `idleMs`；另加 24h 桶清理。
6. **`/health` 可观测**：新增 `lastSession` / `sessions` / `sessIdleSec`（各会话静置秒数）。
7. **阈值单一来源**：`install-service.ps1` 默认 `-IdleSeconds 30` → **0**（0 = 不传 `--idle`，由
   `daemon.config.json` 的 `watcher.idleSeconds=90` 决定）⇒ 根治「配置 90 / 实际 30」的漂移（实测 `/health` 原为 30）。

**⚠️ 本轮事故与修复（如实记录）**：
首次以新代码启动后**一次性登记 100+ 条待确认项并真发 QQ**（日志 `#205~#237 …`）。
根因 = 新桶初始化为 `lastActivity=0 / lastNotified=0` ⇒ 启动时全量扫出的历史会话全部满足
「静置超阈值且未通知过」⇒ 批量登记（旧逻辑是单一全局值，天然不会）。
修法 = ① 新桶只建基线（`lastActivity=lastNotified=m`，不登记、不作废）② 加 `seen` 门控。
止损 = 立即停服务 + 清理本轮误写的 **198 个** `.codebuddy/temp/qq-answers/*.json`。

**P1（会话级指纹）结论：不成立，已撤回**。
实证：`index.json` 的 mtime **等于**其 `current` 会话的 `lastMessageAt`（实测同为 `13:58:22.518`），
而 **agent 跑工具不刷新它**（该会话持续活动 48 分钟，`index.json` 未更新）⇒
若用 `lastMessageAt` 判活跃，会把「正在干活但没新消息」的会话误判为静置 ⇒ 误登记 + 误放行接管（撞车）。
⇒ 维持工作区级分桶（P0）。

**自测结果（2026-09-18）**：

| # | 用例 | 结果 |
|---|---|---|
| 1 | 隔离实例（`--watch-root` 两个假会话 wsA/wsB，`--idle 8`，`openId=none`）：A、B 各自登记 | `#1 session=wsA` · `#2 session=wsB` ✅ |
| 2 | **只在 wsB 制造活动** | `[SUPERSEDE #2]` + **`[SUPERSEDE skip] 1 条属于其它会话（本次活动来自 wsB）⇒ 保持 pending`** ⇒ **wsA 的 #1 保住** ✅ |
| 3 | 只在 wsA 制造活动 | `[SUPERSEDE #1]`（它自己的项被作废）✅ 回归通过 |
| 4 | 生产重启后静置 110s | **仅登记 1 条** `#1 session=1546e1f3`（`pending=1`），无批量风暴 ✅ |
| 5 | `/health` | `idleSeconds:90`（漂移已修）· `sessions:135→40`（24h 清理生效）· `lastSession:1546e1f3` ✅ |
| 6 | 真实链路 | 用户回「取消#1」⇒ `[ANSWER #1] cancel` 正常处理 ✅ |
| 7 | `node --check` | 通过 ✅（未跑门禁回归：本次未改 `hooks/`） |

**待观察**：① 多会话真并行时各自登记是否刷屏（可用 `watcher.idleSeconds` 上调）
② 「别的会话在动 ⇒ 放行接管」是否引发新的撞车（FIX-17e 接管锁兜底）。

### FIX-26：指纹下沉到**会话级**（`{convId}`）——「同工作区新开会话」不再被误判（2026-09-18）

**失效案例（用户实测复现 23:10~23:12）**：收到 `#2 待确认 … 最近会话 [5a2d08cb] …` 后**新开一个会话**（未输入任何任务内容）
⇒ 立刻收到「#2 会话已恢复活动，该项自动作废」。用户指出：**我未必就是要处理 #2 ⇒ 误判**。
⇒ 证明 FIX-25 的**工作区级**分桶不足以覆盖（同容器内所有会话共享一个指纹）。

**★ 实证（会话级指纹可行）**：

| 观测 | 数据 |
|---|---|
| `history/<ws>/` 下的会话子目录 | **176 个** `{convId}` 目录 |
| conv 目录 mtime vs `index.json` 中该会话 `lastMessageAt` | `c3d06149` 13:58:22.**509** vs .**518**｜`e74c545c` 09:08:59.**459** vs .**469**｜`b279b297` 08:45:45.**925** vs .**937** |
| `index.json` mtime | = `current` 会话目录 mtime ⇒ **只在「新建/切换会话」时写** |

⇒ 绕开 FIX-25 中 P1 的否决点：P1 想用 `lastMessageAt` **元数据值**（agent 跑工具不刷新它），
P2 改用 **`{convId}` 目录 mtime**（随消息前进），且 `index.json` **不在任何会话目录内** ⇒ 天然不算活动证据。

**改动（5 处，均在 `qqbot-service.js`）**：

1. `newestWriteTime()`：对每个工作区容器**下钻**其 `{convId}` 子目录，`per` 的 key 改为会话目录；
2. 活动证据 = `max(会话目录 mtime, maxMtimeUnder(convDir, 深度1, 300))`；无 conv 子目录才退回容器级；
3. 新增 `topConvDirs(wsDir, n)`（按目录 mtime 取 top-N，`CONV_SCAN_N` 默认 10，可用 `watcher.convScanN` 覆盖）——性能护栏；
4. `readConversationMeta(wsDir, convId)` 支持**精确**取该会话（不再用「最近活跃者」顶替）；
   `buildIdlePrompt` 凭 `index.json` 判层级，自动区分「会话目录 / 容器目录」；
5. `/health` 增 `lastConv`；`WATCH.lastConv` 记录最活跃会话目录。

**自测结果（2026-09-18 · 隔离实例 `wsTest/{convA,convB}` + `index.json`）**：

| # | 用例 | 结果 |
|---|---|---|
| 1 | 两个会话各自登记 | `#1 session=convA` · `#2 session=convB`（**指纹已下沉**，FIX-25 时是容器名）✅ |
| 2 | **只写 `index.json`**（模拟新开会话 + 切换 `current`） | **14 秒内无任何 `[SUPERSEDE]`** ⇒ #1/#2 全部保住 ✅ **（本案例的直接回归）** |
| 3 | 只动 `convB` | `[SUPERSEDE #2]` + `[SUPERSEDE skip] 1 条属于其它会话（本次活动来自 convB）` ⇒ #1 保住 ✅ |
| 4 | 生产重启后 `/health` | `lastConv=5a2d08cb`（**正是 #2 所属会话**）· `sessions=254` · `sessIdleSec={5a2d08cb:21, 350b904b:1044}` ⇒ **同工作区内两个会话各自独立计时** ✅ |
| 5 | `node --check` | 通过 ✅（未改 `hooks/` ⇒ 未跑门禁回归） |

**待观察**：① 全量扫描耗时（新增 conv 下钻；已有 `WATCH discover slow` 日志，基线 300~470ms，恶化则下调 `CONV_SCAN_N`）
② 会话数多的容器是否漏掉非 top-10 的活跃会话（可上调 `watcher.convScanN`）。

### FIX-27：`/status` 状态页 —— 回到工位一眼看清「谁在干活 / 等什么」（2026-09-18）

**背景**：headless 接管 = `codebuddy -p` **独立 CLI 进程**（IDE 会话列表看不到它）；`runHeadless` 用 `exec`
**完成时才回调** ⇒ 运行期 stdout 不落盘 ⇒ 此前只有"状态"、没有"进度"，也没有任何界面。

**用法**：浏览器打开 **`http://127.0.0.1:18765/status`**（5 秒自动刷新）。

**六个区块**：
1. **headless 接管** —— `#id` / 起始时间 / **剩余约 N 分钟** / 对应 `qq-<id>.md` 的「剩余工作」前 5 行；空闲时显示「（空闲）」
2. **待确认** —— 全量 pending（id / kind / 会话短码 / 事项首行 / **📋 确认后将执行**）
3. **最近答复** —— `qq-answers/` 最近 8 条（id / answer / ts / 事项首行）
4. **会话活动** —— `idleSeconds` / `sessions` / `lastConv` / 各会话静置秒数
5. **推送** —— 免打扰 / 静默 / 合并队列
6. **service.log 尾部 30 行**

**实现**：`startHttp()` 内新增一个**只读**路由 + `escapeHtml()` + `tailLines()`（64KB 尾部字节切片，不全量加载）；
所有文件读取 try/catch（缺文件显示「（无）」而非 500）；**未改 `runHeadless`** ⇒ 对接管链路零行为风险。

**实测（2026-09-18）**：隔离实例六区块渲染 OK（中文正常、3126 字节）；生产渲染正常（2914 字节）；
⚠️ 「有锁」分支未实测（造 `RUNNING.json` 会触发 gate-check 第 0 关拦 IDE 写入）—— 该分支与 `/health.handoffLock`
同源（同一 `readHandoffLock()`），待首次真实接管时观察。

### FIX-28：待确认消息必须说明「确认后将执行什么」（2026-09-18）

**起因（用户实测）**：`#3 待确认：会话静置 93s … 回「确认#3」由新会话接管执行…` —— **没有任何内容说明**。
确认后 headless 会执行 `watcher.handoffPrompt`（几百字指令），但消息里一个字都不带 ⇒ **回复确认等于盲签**。

**改动**：
- `registerRequest()` 新增 `brief` 摘要：**显式 `handoffBrief` > `handoffPrompt` 首行**（截 120 字）；
  QQ 文案 handoff 分支追加 `📋 确认后将执行：<brief>`；
- `daemon.config.json` 新增 `watcher.handoffBrief`（一句话口径）⇒ idle 自动登记项的消息也带说明；
- `/status` 待确认区块同步显示 brief。

**实测（2026-09-18）**：① 隔离实例 HTTP 登记（带 handoffBrief）⇒ `/status` 显示「📋 确认后将执行：测试摘要…」✅
② 生产静置登记 `#1 [handoff] session=5a2d08cb` ⇒ **真发 QQ（HTTP 200）且带摘要** ✅

### FIX-29：待确认消息加 🔔 前缀（2026-09-18）

用户要求「在 `#x 待确认` 前加一个图标」⇒ 选定 **🔔**（表示"需要你拍板"，与消息里已有的 🤖 / 📋 / ⚠️ / ✅ 不冲突）。
改动 1 行 —— `registerRequest()` 的文案首行 ⇒ **一处覆盖所有来源**（`ask.js` 登记 / 门禁拦截 / 静置自动登记）。

```
🔔 #1 待确认：
会话静置 90s（…）
…
📋 确认后将执行：…
回复「确认#1」执行，或「取消#1」中止。
```

**实测（2026-09-18 23:57）**：生产静置登记 `#1 [handoff] session=5a2d08cb` ⇒ **真发 QQ（HTTP 200）**，首行即 `🔔 #1 待确认：`；`/status` 渲染正常。

### FIX-30 / FIX-31：待确认消息结构化 + 选择题协议（2026-09-19）

**起因（用户审查实收消息）**：① 未交待「具体待确认事项」；② 未明确「选项 → 操作」对应关系。代码取证确认两点成立，另有 4 项：来源类型无标记（idle 与 ask 外形相同）、`#N` 重启撞号、有效期未预告、定位短码不可行动。

**★ 核心取证（选择题类比静置类更硬 —— 协议层不匹配）**：
- `ask.js` 原**无选项参数** ⇒ A/B/C 及含义靠 `prompt` 自由拼写，服务端零解析；
- **两条路径互为残缺**：回「确认#N」⇒ handoff 文件含原题面但**没有"选了哪个"**；回自由文本「B」⇒ `doFreeReply` 的 `np.prompt` 覆盖原题面 ⇒ **知道答案、不知道 B 的含义**（`qq-35-reply.md` 实证：L4 只剩"用户在 QQ 的答复：进入02"，L5 还硬编码"确认（QQ）"）；
- 自由文本兜底**有条件**（仅唯一未决项）+ **有副作用**（起 headless）且消息不写 ⇒ **"多条并存 + 选择题"无解**（fallback 只教「确认#N」，对选择题无效）。

**改动**：

| 文件 | 改动 |
|---|---|
| `qqbot-service.js` | 新增 `renderRequestText()` 结构化渲染（来源标记 / 问题句 / 选项→后果对照 / 前置条件 / 有效期）+ `buildNextHint()`；`registerRequest` 记录 `options`·`recommend`·`nextHint`·`timeoutMs`·`originPrompt`·`replyLabel` 并改用新渲染；新增 `parseChoiceReply()` + `doChoice()`；`handleMessage` 接入选项语法；`runHeadless` 保留原题面 + 「你的回复」按路径渲染（修硬编码）；`writeAnswer` 支持 `answer:"choice"`（含 `choice` + `options`）；cancel 文案由「中止」纠正为「本项作废，不执行任何操作」；新增离线自测 `--render` / `--parse` |
| `ask.js` | 新增 `--options "A=…;B=…"` / `--recommend B`（带选项时默认 `kind=decision`） |
| `daemon.config.json` | `fallbackReply` 补选项语法 |

**回复语法（四类，互不干扰）**：

| 语法 | 适用 | 效果 |
|---|---|---|
| `确认#N` / `取消#N` | 二元项（命令 / 门禁 / 接管邀请） | 执行 / 不执行 |
| `选项#N`（如 `B#12`）；唯一未决选择题时 `B` | 选择题 | 落 `answer:"choice"` + `choice` + `options`；带 handoff 则按选择起接管 |
| `回IDE#N`；唯一未决非 idle 项时 `回IDE` | ask / 选择题（模板固定选项） | QQ 侧作废本项，落 `answer:"ide"` ⇒ waiter 读回后回 IDE 原会话拍板；idle 项不适用（其「回 IDE 操作」= 不影响邀请） |
| 其他文本（≤ `freeText.maxChars`） | 唯一未决项 | 作为指示交接管（`originPrompt` 保留原题面） |

**消息样例**：

```
🔔 #13 待确认 · [需你拍板]
────────────────────
❓ AutoMapper 的引入方式选哪个？
 🅰 A → 私服 NuGet 6.2.2（推荐）
 🅱 B → 手工 DTO 映射（零依赖）
 🅲 C → 暂不引入，登记二期
────────────────────
你的回复 → 结果
 ✓ 回 A / B / C（多条并存时带编号：A#13）→ 记录选择并交新会话按选择执行
 ✗ 取消#13 → 本项作废，不执行
 ↩ 回IDE#13 → QQ 侧作废本项，回 IDE 原会话拍板
⏳ 30 分钟内有效，超时自动取消
```

**登记（选择题）**：
```powershell
node tools\qqbot\ask.js --prompt "AutoMapper 的引入方式选哪个？" `
  --options "A=私服 NuGet 6.2.2;B=手工 DTO 映射;C=暂不引入" --recommend A `
  --handoff --handoffPrompt "按用户在 QQ 的选择继续执行 Q3 决议落地"
```

**离线自测（不启动服务，FIX-30 新增）**：
```powershell
node tools/qqbot/qqbot-service.js --render rec.json     # 渲染消息文本
node tools/qqbot/qqbot-service.js --parse "B#12"        # 解析（打印 reply/choice/route 三类判定）
```

**本批未含（待用户拍板）**：idle 项超时时长 —— 现走默认 `requestTimeoutMs`（600s），与"人不在工位"场景偏短。

## 阶段文档链接自动附加（方式2 · 2026-10-06）

QQ 待确认消息（`sleep`/`shutdown` 除外）尾部自动附「📄 拍板依据」链接 → hub 只读视图，手机看阶段产物后再拍板；QQ 内置浏览器拦未备案 .cn 域名 ⇒ 按消息提示复制链接到系统浏览器打开。

**配置单源**：域名+key 唯一源 = `tools/session-hub/hub.config.json → doc.publicUrl / doc.key`；每次登记现读不缓存，换 key 免重启。`daemon.config.json → docLink {baseUrl, key}` 仅为非标准部署的显式覆盖段（一般不配）；两者都缺 = 不附链接（fail-open，未部署 session-hub 的项目自动跳过）。

**登记精确页**（缺省自动推断「当前阶段文档」；两者都无 ⇒ **整段不附链接** —— 见下方「方式2c」）：
```powershell
node tools\qqbot\ask.js --prompt "03 技术方案是否通过？" --options "A=通过;B=驳回" `
  --docPath "2026-xx-xx-001/03-技术方案/03-技术方案.md"
```
`--docPath` 相对 `docs/iterations/`（也可写 `--doc-path`）；服务端登记时校验：统一正斜杠、拒 `..`/绝对路径/`\0`、后缀 .md/.txt、文件须存在。**非法或未传 ⇒ 自动降级为「当前阶段文档」**（2026-10-07 修 R2，见「方式2c」）；阶段文档也落空 ⇒ **整段不附**（2026-10-07 修 R3：立项期等无依据文档场景不带链接）。

**消息尾部样例**：
```
⏳ 30 分钟内有效，超时自动取消
📄 拍板依据：https://hub.haohaowaner.cn/doc?path=2026-xx-xx-001%2F03-%E6%8A%80%E6%9C%AF%E6%96%B9%E6%A1%88.md&key=…
（QQ 内若打不开 → 复制链接到系统浏览器打开）
```

### 方式2b：静置邀请自动附「当前阶段文档」（2026-10-07）

**缺口**：方式2 只覆盖 `ask.js --docPath` 显式登记；watcher 自动登记的 idle 静置邀请从不传 docPath ⇒ 恒回退列表页（实测 #14 邀请只给 `/doc/list`），而静置恰是最需要在工位外看阶段产物的场景。

**根因**：`state.yaml current_phase` 是纯数字（`"06"`），文档目录名带中文（`06-回顾归档`）⇒ 无静态映射，当时留 fail-open 回退列表页。

**修复**（`qqbot-service.js`）：
- `pickPhaseDoc(iterDirAbs, phase)`：扫 `docs/iterations/<迭代ID>/<NN>-*/` 取 mtime 最新 `.md/.txt`（可注入目录 ⇒ 离线自测）；
- `buildPhaseDocPath()`：ACTIVE 迭代 ID + `current_phase` 组装相对路径；
- idle 登记处补传 `docPath: buildPhaseDocPath()`。

兜底链不变：推断落空 ⇒ `''` → `normalizeDocPath()` 再校验（含文件存在性）→ 渲染回退列表页。**边界**：阶段无文档目录（如 06 回顾归档）时仍回退列表页 = 预期行为。

**验收**：离线自测 21/21（pickPhaseDoc 单元 8 + 实态冒烟 2 + docPath 校验/链接 6 + 渲染层 5）+ 服务重启 `/health ok`。

### 方式2c：全登记口统一兜底 + 列表页标注修复 + 无依据文档不附链接 + 正文完整渲染（2026-10-07 修 R1~R4）

**触发**：用户实测 #3（新迭代立项拍板）——消息附列表页链接，但打开显示「（当前无活跃迭代）」、无 ★当前，与文案「（列表页·★当前迭代）」矛盾。查证三层：① 该条为 `ask.js` 手登记（decision 类），原先只有 idle 静置邀请走 `buildPhaseDocPath` 自动推断 ⇒ 恒列表页；② 发送时迭代刚立项（01 起步），`docs/iterations/<ID>/` 目录尚未创建 ⇒ 即便有兜底也落空；③ 真缺陷在 hub 侧：`readActiveIteration()` 要求目录存在才认活跃迭代 ⇒ 列表页退化为「（当前无活跃迭代）」。

**修复**：
- 修 R2（`qqbot-service.js`）：新增 `resolveDocPath(explicit, phaseDocFn)` —— 显式指定 → 阶段文档（惰性求值，仅缺省时调用）→ `''`（列表页），出口统一过 `normalizeDocPath`，异常 fail-open；`registerRequest` 全部登记来源（ask.js/notify/门禁/watcher）统一走它，不再只有 idle 有兜底。
- 修 R1（`tools/session-hub/server.js`）：`readActiveIteration()` 去掉「目录必须存在」门（口径对齐 qqbot 侧 `readActiveIterationId`：只读 ACTIVE 首行、显式判 `none`、剥 BOM）；`docListHtml()` 目录未建时顶部标「当前迭代：<ID>（尚无文档）」+ 列表首行补「★当前（尚无文档）」占位 ⇒ 任何阶段文案「（列表页·★当前迭代）」都兑现。

**验收**：R1 = hub 重启后 HTTP 级 **11/11**（正向 4：顶部标注/不误标「尚无文档」/列表 ★当前；回归 2：精确页 200 / 缺 key 403；负向 5：目录未建 ⇒「（尚无文档）」+ 占位行、ACTIVE=none ⇒「（当前无活跃迭代）」、ACTIVE 字节级恢复）；R2 = 离线自测 **13/13**（`resolveDocPath` 7 用例：显式优先+惰性/缺省降级/非法降级/非函数/抛异常 fail-open/undefined + 2b 既有链回归 6）+ 实态链路 PASS（缺省登记在真实 ACTIVE 下 ⇒ `2026-10-07-001-打印模板配置页/01-需求分析与设计/01-需求记录.md` 精确页，含 key 可外网直开）；两服务重启后 `/health ok`。

**边界**：立项拍板早于 01 产出文档 ⇒ **R3 起不再附链接**（原列表页兜底已废）；如需让立项类拍板直指需求池/计划文档，须扩 hub 白名单（当前只读 `docs/iterations/`，属安全面扩大，未做）。

**★ R3/R4 追加（2026-10-07 20:0x，用户实测 #2「立项期不该带链接 + 范围详情要在对话里」）**：
- 修 R3（`renderRequestText` 链接门）：由「非 sleep/shutdown 就附」改为「**仅 `docPath` 非空才附**」⇒ 无依据文档整段不附；列表页兜底废除（此时列表页无当前迭代内容可看，且「（列表页·★当前迭代）」承诺与实况不符）。R1 的「（尚无文档）」占位对其它入口仍有效。
- 修 R4（正文完整渲染）：新增 `clipPrompt()`（上限 900 字符、超限必留「…」，对齐 FIX-39 痕迹原则）；decision 类正文由 `firstLine`（首行硬切 120 且无痕迹 —— 实测 258 字符立项范围只显示到「…+组级」）改为**完整多行渲染**（首行进 ❓ 行、其余行缩进），普通提问分支同护栏。
- 验收：离线自测 **16/16**（clipPrompt 4 + 链接门 7 + 正文渲染 5）+ 实态渲染演示（#2 真实 258 字符 prompt 完整显示至「详情见IDE。」、无任何链接行）。

## IDE 自动推送兜底：会话历史 Watcher（已被合并服务取代，保留说明供参考）

IDE（插件）版**不提供 hooks**，无法在回合结束时自动触发。本 watcher 作为**机制级兜底**：常驻监控 IDE 会话历史目录（`%LOCALAPPDATA%\CodeBuddyExtension\Data\*\CodeBuddyIDE\*\history`），每 5 秒取最近活跃会话目录下文件的最新修改时间，若写入静止达到 `IdleSeconds`（默认 30s）即判定"一轮完成"，调用 `notify.qqbot.js` 推 QQ。

安装（用户级、无需管理员）：
```powershell
cd tools/qqbot
powershell -File install-watcher.ps1 -IdleSeconds 30
```
- 会在「启动」文件夹创建 `CodeBuddyQQWatcher.lnk`（登录自启），并立即后台启动 watcher。
- 运行日志：`tools/qqbot/watcher.log`。
- 卸载自动启动：删除该快捷方式 `C:\Users\<你>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\CodeBuddyQQWatcher.lnk`。
- 若想用计划任务（需管理员）：`Register-ScheduledTask` 在本机被拒（Access denied），故改用启动文件夹方案。

注意点（与 hooks 的取舍）：
- watcher 是"文件静止=回合结束"的**启发式**，无法精确区分"有实质产出"——长思考中途若停顿超阈值可能误推；纯闲聊静置也会推。可接受，若嫌烦可调大 `IdleSeconds`。
- IDE 升级若改动历史目录结构，watcher 的自动发现（`*CodeBuddyIDE*\history`）可能失效，需重跑 `install-watcher.ps1`。
- 与 CLI 互不影响：CLI 走 Stop 钩子（路径不含 `CodeBuddyIDE`），两者不会重复推送。
- 安全：Secret 属敏感信息，切勿在群聊/公开渠道明文张贴。

## 方案 C：常驻确认 daemon（人机闭环）
适用：机器人发消息问你，你在 QQ 回复后**自动**执行后续动作（无需回到 genie 对话）。

```powershell
node qqbot-daemon.js --appid <id> --secret <sec> --openid <oid>
```
默认读取同目录 `daemon.config.json`：
- `actions.confirm / cancel`：关键词列表 + 回执文案 + 可选 `command`（要执行的 shell 命令）。
- `dryRun: true`（默认）：仅回执、**不执行命令**，安全先用；改为 `false` 才真正执行 `command`。
- `fallbackReply`：未识别指令时的提示。

行为：
- 只响应你自己 `openid` 的消息，其他人忽略。
- 所有收到的回复落入 `inbox.jsonl`（审计日志）。
- 常驻运行：断线自动重连，access_token 每 90 分钟刷新；`Ctrl+C` 退出。

测试连接（连上 5 秒后退出，不处理消息）：
```powershell
node qqbot-daemon.js --appid <id> --secret <sec> --openid <oid> --test
```

重要边界：genie 是会话式、非常驻，无外部事件触发能力，因此本 daemon **无法自动续上 genie 正在跑的会话任务**。「执行后续任务」只能是 daemon 自身能跑的命令/脚本（即任务逻辑需独立于 genie 常驻）。若需开放式 AI 决策，应在 daemon 内另接 LLM/agent 服务。

## 方案 B：多任务确认（待确认队列 + 精确 #id）【新增】
适用：同一时段可能有**多条**需要你确认的事项，避免 daemon 把"确认"误执行到错误的任务上。每个确认请求拿到唯一编号，QQ 消息写明「确认#1 / 取消#1」，你回带编号的指令，daemon 精确路由到对应项。

### 1. 启动 daemon（同方案 C，多开一个本地 HTTP 注册口）
```powershell
node qqbot-daemon.js --appid <id> --secret <sec> --openid <oid>
```
默认在 `127.0.0.1:18765` 监听 `/request`。可用 `--port` 覆盖，或用 `daemon.config.json` 的：
- `listenPort`：HTTP 注册口端口（默认 18765）
- `httpKey`：注册口密钥（留空=不校验；本机 localhost 调用可留空）
- `requestTimeoutMs`：待确认项超时自动取消（默认 600000=10 分钟；★ `ask.js` 默认传 1800s 覆盖之 —— 模式 D 时限口径见文末「方案 D」）

### 2. 注册一条待确认（genie / 其他进程调用）
```powershell
node request-confirm.js --prompt "即将删除 build 目录" --command "rmdir /s /q build"
# 返回：{ "id": 1, "status": "pending" }
```
daemon 随即发 QQ：「#1 待确认：即将删除 build 目录。回复「确认#1」执行，或「取消#1」中止。」

也可用 curl：
```powershell
curl -X POST http://127.0.0.1:18765/request -H "Content-Type: application/json" -d "{\"prompt\":\"...\",\"command\":\"...\"}"
```

### 3. 你在 QQ 回复
- `确认#1` → daemon 在本机执行 `command`（dryRun=true 时只回执不执行；`dryRun:false` 才真执行）
- `取消#1` → 标记取消，不执行
- 超时未回 → 自动取消

### 4. 查询状态
```powershell
curl http://127.0.0.1:18765/pending    # 列出所有待确认
curl http://127.0.0.1:18765/health     # { ok:true, pending:N }
```

### 与 genie 的协作
genie 执行危险操作前，可先调 `request-confirm.js` 把命令注册为待确认项并交给你在 QQ 确认；daemon 在你回「确认#编号」后在本机执行该命令。注意：daemon 执行的是它自身进程能跑的命令（本机环境），genie 会话本身不会被 QQ 回复自动唤醒（同方案 C 边界）。

### 多任务区分验证
并发注册 #1/#2/#3，分别回「取消#2」「确认#1」「确认#3」，daemon 只会按编号精确执行对应项，互不干扰（inbox.jsonl 每条带 taskId 便于审计）。

> 已端到端实测：常驻 daemon 注册 #1/#2，用户回「确认#2 / 确认#1 / 取消#2」，inbox 落 `taskId:1`、`taskId:2` 均 `result:confirmed`，证明带编号回复精确命中对应项、多任务不串；后发的「取消#2」因 #2 已确认而命中 `status!=='pending'` 防护（已处理过不重复执行）。`health` 的 `pending` 计数仅统计真正未决项。

### FIX-35：取消「自动作废接管邀请」+ 判定移交确认闸门（方案 G · 档 2）（2026-09-19）

**起因（用户第三轮报障）**：收到 `#N 待确认（接管邀请）` 后，人回到 IDE **只是聊别的事 / 问密码 / 发图**，就立刻收到「`#N` 会话已恢复活动 ⇒ 自动接管已取消」。用户口径：「我并没有处理这个任务」⇒ 要求**只有在 IDE 中明确处理对应任务时，才算"会话恢复活动"**。

**根因**：`watchLoop`（L613 旧）把「**会话**被用了」当成「**任务**被推进」—— 判据 = 会话目录内任意文件 mtime 前进（闲聊/别的话题也会写消息文件）⇒ 必然误报。FIX-25/26 只改判定粒度、FIX-32 只补复活入口，**判据本身未动**。

**改动（方案 G）**：

1. **自动作废下线**：`supersedeIdlePending` 不再由 watcher 自动触发；`watcher.autoSupersede=true` 可回滚旧行为；恢复活动仅记 `[WATCH] 会话恢复活动（仅记录…）`；
2. **判定移交「确认#N」时的 `handoffGuard(p)` 双条件**（`doPending` / `doFreeReply` / `doChoice` 统一走它）：
   - **条件①（档 2 `write-tool`）**：该会话在 `handoffGuardSec`（默认 120s）窗口内有**写类工具调用**（`write/edit/replace/create/delete/move/rename/patch/execute/run/bash/shell/mkdir/install…` 前缀）⇒ 拒；**纯问答/闲聊不计**（`isWriteTool` 纯函数 + `sessionRecentWriteTool` 读窗口内 `messages/*.json`）。档位可配：`session`（档1 旧语义，任何写入）/ `write-tool`（档2 默认）/ `task-only`（档3）；
   - **条件②（所有档位）**：**任务域水位**自登记以来前进 ⇒ 拒 —— `runtime/{ACTIVE}.state.yaml` 与 `docs/iterations/{ID}/**` 被写 = 有人真在推进该迭代（含别的会话/别的工具）。已知边界：state.yaml 是**步骤级回写点**、非心跳，单步执行中途可能不写 ⇒ 该条件仅作附加判定，不单独承担安全。
3. **拒绝可重试**：回执写明命中原因 + 「停手 120s 后再回『确认#N』即可（会重查）」；fail-open（数据读不到 ⇒ 不据此拒绝，安全由接管锁 FIX-17e 兜底）。

**配置**（`daemon.config.json` → `watcher`）：

| 项 | 默认 | 说明 |
|---|---|---|
| `autoSupersede` | `false` | 恢复 `true` = 回滚 FIX-17c① 自动作废 |
| `handoffGuardMode` | `"write-tool"` | `session`(档1) / `write-tool`(档2) / `task-only`(档3) |

**行为对照**（同一会话内）：

| 你在 IDE 的行为 | 旧行为 | FIX-35 后 |
|---|---|---|
| 什么都不做 | — | — |
| 聊别的（问密码/发图，无写类工具） | **自动作废 + 推送（误报）** | 不推送；回「确认#N」**不拒**（可接管） |
| 聊别的但 agent 在写文件/跑命令 | 自动作废 + 推送 | 回「确认#N」被拒（防同项目互改），停手 120s 后可重试 |
| 推进该迭代（写 state.yaml / 迭代文档） | 自动作废 + 推送 | 回「确认#N」被拒（正确；条件②命中） |

**离线自测**：`node .codebuddy\temp\fix35-verify.js`（`isWriteTool` 30+ 用例 + 渲染回归 + FIX-30/31/32 回归）。

### FIX-34：headless 接管可视化与双向续接（serve 模式）（2026-09-19）

**起因（用户诉求）**：QQ 回「确认#N」后 headless 用 `-p` 黑盒代跑，回到工位无法像聊天窗口一样看到它在执行什么、无法等它执行、无法处理确认、无法续聊。

**方案**：headless 从「一次性 `-p`」改为「`--serve` Web UI 会话」，新增 `tools/qqbot/adapter-headless.js` 单一持有 CLI 字面量，业务层不散落 `codebuddy`。

**分级**（能力探测两级制：help/存在性解析 + 冒烟实测）：
| 档 | 形态 | 状态 |
|---|---|---|
| A `serve` | Web UI 可视化 + 原生续聊 | ✅ 已取证（P0 探针 + P1 闭环） |
| B `-p --session-id` + `-r` | 仅续聊 | ⚠️ 未实测，只留位 |
| C `print` | 一次性无状态（现状） | ✅ 现状 fallback |

**配置**（`daemon.config.json` → `headless`）：
```json
"mode": "serve",
"serve": {
  "port": 19000,
  "idleTtlMs": 1800000,
  "coldStartMs": 3000,
  "maxRestart": 2,
  "instanceFile": "runtime/serve-instance.json"
}
```

- `idleTtlMs=1800000` = 策略③「首接起 + idle 超时回收」；置 `0` = 策略①（逐次起、收尾即回收）。
- 回收双条件：`idle > idleTtlMs` 且无 `.codebuddy/temp/handoff/RUNNING.json`。
- 有界重启 ≤ `maxRestart`（2 次），超限降级 `print` + QQ 告知（禁周期拉起）。
- 实例指针文件 `runtime/serve-instance.json`（`{pid, port, startedAt, lastUsedAt, tier}`，**不含口令**）。

**行为**：QQ 回「确认#N」→ 服务 spawn `--serve --port X --auth password`（复用已有实例）→ 写 handoff 锁（含 `webUrl/mode`，TTL 放大到 4h）→ 回执给 Web UI 入口（**不带口令明文**）→ `handoffAliveWatch` 端口探活代替 `exec` 回调收尾。任务由用户在 Web UI 输入框继续（可视化 + 双向续接）。

**安全**：`--serve` 默认 `--host 127.0.0.1`（仅回环）；口令每次启动重新生成，读 `~/.codebuddy/settings.json → gateway.password`，**不落任何我方文件**；`/status` 给明文直链（渲染期现读口令 + 渲染前探活 + host 恒 `127.0.0.1`），**QQ 回执只给地址 + 口令位置提示**（手机访问不了 localhost，带口令链接零收益）。

**展示**：`/health` 增 `headlessMode` + `serve`（含 `webUrl/alive/pid/port/tier`，**不含口令**）；`/status` 区块 1 展示 `Web UI 运行中 · <直链>` 与 alive。

**回滚**：`daemon.config.json` 改 `headless.mode: "print"` + 重启服务，即回到现状（零代码改动）。

**离线自测**：`node tools/qqbot/adapter-headless.js --selfcheck`（路径/口令/默认命令）；`node tools/qqbot/adapter-headless.js --detect`（两级探测冒烟实测）。

## ★ FIX-36：静置邀请「误报 + 无法静默」治理（2026-09-20）

**起因（用户报障 + 全天取证）**：「迭代已进入 04 在正常干活，QQ 却一直发『会话静置，是否起新会话接管』」。

**取证（全部可复现）**：

| # | 现象 | 证据 |
|---|---|---|
| ① | **阈值从未起"区分"作用，只是"到点即发"的扳机** | 全天 55 条登记，`idle` 值**全部落在 90~100s**（无一条 >100s）；同会话 `PUSH skip` 值长期在 91~95s 徘徊（被新写入反复重置） |
| ② | 在干活被判静置 | `#49` = 会话最后写入 17:04:16 后 92s；`#51/#52/#53`（17:11）指向 17:09~17:10 仍在写的会话 |
| ③ | **用户明确要求静默被丢弃** | 16:45:31「取消。1小时内不要再听」· 16:46:00「取消，并且1h内不再提醒」→ 被 `route()` 的 cancel 关键词吞掉（只回「请带编号」）⇒ 16:50:03 再发 `#46` |
| ④ | 邀请注定被拒（自相矛盾） | `idleSeconds(90) < handoffGuardSec(120)` ⇒ 收到即回「确认#N」时条件①必命中 |
| ⑤ | 超时噪音 | 全天 **42 条**「⏰ #N 超时未确认」；同会话结算后立刻可重发（`#46` 17:00:03 超时 → `#49` 17:05:49） |
| ⑥ | **心跳路径 ReferenceError** | `service.log` 16:13:36 / 16:53:40 `WATCH ERR: wsDir is not defined` —— `buildHeartbeatText` 引用未定义变量 ⇒ **该 tick 的登记被整体跳过** |
| ⑦ | 非法指纹 | `#48/#55` `session=index.js`（`path.basename(sess).slice(0,8)` 取到了名为 `index.json.lock` 的**目录**） |

**改动（`daemon.config.json` 8 键 + `qqbot-service.js` 8 处）**：

| 项 | 现值 | 内容 |
|---|---|---|
| `watcher.idleSeconds` | `900`（原 90） | 会话落盘是"分钟级"⇒ 阈值必须超过单次长工具调用/Team 波次；**不变式**：启动时若 `idleMs <= handoffGuardMs` 自动抬到 `handoffGuardMs + 60s` 并告警 |
| `watcher.snoozeFile` / `snoozeDefaultSec` / `snoozeMaxSec` | `.codebuddy/temp/qqbot-snooze.json` · 3600 · 86400 | 静默状态持久化（重启不丢）；无时长默认 1h；上限 24h（超出截断并在回执标注） |
| `watcher.idleInviteCooldownSec` | `1800` | 同一会话**结算后**（confirm/cancel/超时/superseded/replied/choice）冷却期不重发 |
| `watcher.idleInviteMinGapSec` | `600` | 全局两条 idle 邀请的最小间隔（多会话并发时不连环刷屏） |
| `watcher.taskGate` / `taskGateRecheckSec` | `true` / `60` | **任务域闸门**：`readTaskMark(ACTIVE迭代)` 若在 `idleMs` 内被写过 ⇒ 判定"有人在推进"⇒ 不登记（含 Team 波次 / 别的会话）；结果按 60s 缓存 |

**登记前三闸**（`watchLoop`，命中即 `continue`，**不写 `lastNotified`** ⇒ 条件消失后自动补发）：① 会话冷却 → ② 全局最小间隔 → ③ 任务域闸门。
**idle 静默闸**（`registerRequest`）：`notifyMuted()` / `inQuietHours()` / `snoozeActive('idle')` 任一命中 ⇒ **不登记、不发 QQ、不占 `#N` 号**（此前 idle 邀请完全绕过这三道闸）。
**超时通知**：`kind==='idle'` 不再推「⏰ 超时未确认」（保留 `writeAnswer('timeout')` 与日志）。
**文案/指纹**：「工作区标识」→「会话标识」（值实为 convId，FIX-26 已下沉）+ 容器级兜底标注；指纹形态白名单 `isSessionShape()` 排除含 `.` 的目录。

### 静默用法（用户口径：收到「xxh / xxmin 内不再提醒」必须照办）

| 你回 | 效果 | 回复范围 |
|---|---|---|
| `静默2h` / `120min内不再提醒` / `1.5h 别提醒` / `静默` | 静默指定时长（无时长 = `snoozeDefaultSec`，默认 1h） | **只掐静置邀请** |
| `全部静默1h` | 连完成通知 + 门禁通知一并静默 | 全部 |
| `取消静默` | 提前解除 | — |

- **解析规则**：`意图词`（静默/免打扰/勿扰/别提醒/不再提醒/…）**与** `时长`（`h`/`hr`/`hour`/`小时`/`min`/`m`/`分钟`，支持小数）**必须同时命中**；仅当整条消息就是静默词时用默认时长 ⇒ 「静默安装依赖」「静默处理一下」**不会**误触。
- **优先级**：`确认#N` / `取消#N` / `B#12` **不受影响**；静默分支**必须早于 `route()`** —— 否则「取消，并且1h内不再提醒」会被 cancel 关键词吞掉（案例③的根因）。
- **不被静默**：`fail` / `decision` / `irreversible` / `ask.js` 登记项一律照发（除非 `全部静默`）。
- **落盘**：`snoozeFile`（默认 `.codebuddy/temp/qqbot-snooze.json`）；`/health.watch.snooze` 与 `/status` 区块 5 可见。

**离线自测（不启动服务、不真发 QQ）**：

```powershell
node tools/qqbot/qqbot-service.js --snooze-parse "静默2h"
node tools/qqbot/qqbot-service.js --snooze-parse "取消，并且1h内不再提醒"   # 回归：这条以前会被 cancel 吞掉
node tools/qqbot/qqbot-service.js --snooze-parse "确认#12"                 # 回归：不得被静默分支劫持
node --check tools/qqbot/qqbot-service.js
```

**实测（2026-09-20）**：`node --check` 通过；`--snooze-parse` 14 用例全对（`静默2h`→7200/idle · `120min内不再提醒`→7200 · `取消，并且1h内不再提醒`→3600 · `1.5h 别提醒`→5400 · `全部静默30min`→1800/all · `静默`→3600 · `静默48h`→86400/capped · `静默处理一下`/`静默安装依赖`/`5分钟后给我答复`→null · `确认#12`/`取消#12`/`B#12` 解析不受影响 · `取消静默`→clear）；重启后 `/health` = `idleSeconds:900 · idleMinGapSec:600 · idleCooldownSec:1800 · taskGate:true · snooze:null`。

**回滚**：`daemon.config.json` 把 `idleSeconds` 改回 `90`（其余键留空即取默认/关闭）+ 重启服务；静默用「取消静默」或删 `snoozeFile`。

**待观察**：① 阈值 900s 后「人真离开工位」场景会晚 15 分钟收到邀请（拍板通道不受影响）；② 任务域闸门在「主 Agent 跑长 Team 波次且期间零落盘」时需靠阈值兜底。

## ★ FIX-37：命令口令「心跳」/「关机」（2026-09-21）

**起因（真实失效实证）**：`inbox.jsonl` 2026-09-19T07:15:39.276Z 记录用户已真发过「关机」，因无匹配分支落到 `fallbackReply`（**零处理**）。

### 用法

| 你回 | 效果 |
|---|---|
| `心跳`（或 `状态` / `ping`） | 立即回一条**状态探针**（只读：不登记、不执行命令、不受静默/免打扰影响） |
| `关机`（或 `关闭电脑` / `关闭计算机` / `shutdown`） | **只登记**「🔔 #N 待确认 · [关机·需确认]」+ 强告警；**不关机** |
| `确认#N` | 执行 `shutdown /s /t 90` → 回执「已确认：90 秒后关闭本机 + 中止方式」 |
| `取消#N` | 作废本项，**不执行关机** |
| `中止关机`（或 `取消关机` / `abort`） | 执行 `shutdown /a` 中止已安排的关机（**不随 enabled 开关关闭** —— 中止属安全方向） |

### 状态探针字段

服务/端口/待确认数 → 迭代（阶段·状态·待办）→ 接管（锁 / `handoffRunning`）→ Web UI 实例 → 推送/静默/免打扰 → 最近会话（静置秒数）。

**不含**关机口令开关（★ FIX-37b：心跳 = 纯状态自检。2026-09-21 09:26 用户实测反馈「只发心跳却收到关机配置行」⇒ 已从消息中移除，改查 `GET /health` → `commands.shutdown`）。

`send()` 无截断 ⇒ 超长会被平台拒收，故 `--probe` 会打印字数（实测 394 字仍可送达）。

### 消息样例 / 格式口径（★ FIX-37c）

```
💓 手动心跳 · 2026-09-21 09:37:09（服务已运行 10 分钟）
────────────────────
服务：在线 · 端口 18765 · 待确认 0 条
迭代：2026-09-21-001-S1前端四屏（阶段 02 · in_progress）
待办：step-2-user-resolve 用户逐项确认或驳回问题 ｜ step-3-output 生成02-需求评审.md …（另 N 项）
接管：空闲（handoffRunning=0）
Web UI：（无 serve 实例）
推送：正常 · 免打扰时段外
最近会话：92f53947（静置 41s）
```

- **图标**：💓 = 心跳类（手动 `💓 手动心跳 · <时间>` · FIX-24 自动 `💓 进度心跳 · 会话持续活跃 N 分钟`）；🔔 = 待确认；🤖 = 接管；📋 = 确认后将执行。
- **分割线统一 20 字符**（`MSG_SEP = '─'.repeat(20)`）：`qqbot-service.js`（待确认 / 手动心跳）/ `qqbot-service.js` 的 FIX-24 进度心跳 / `notify.qqbot.js`（完成·失败·进度通知）**同值** —— 此前 14 与 20 混用，2026-09-21 用户实测指出不一致后统一。用 `.repeat(20)` 而非字面量，避免手抄 glyph 个数出错。
- 图标占用清单（避免撞车）：🔔 🤖 📋 ⚠️ ✅ ✔️ ❌ 🟡 ℹ️ ⛔ ⏰ 🛑 ⏸ ▶️ 🪜 🕐 ❓ 🅰-🅷 💬 ↩ ⇒ **💓 为心跳专用**。

### 安全设计（四条，均有实现对应）

| # | 机制 | 说明 |
|---|---|---|
| ① | **默认不启用** | `commands.shutdown.enabled=false` ⇒ 回「关机」只回「🔒 远程关机未启用」，**不登记任何待办** |
| ② | **二次确认** | 口令只登记；必须回 `确认#N` 才执行（有效期 120s，超时自动取消） |
| ③ | **禁止免编号直通** | 关机项**必须带编号** —— confirm 关键词含「好/可以/没问题/ok」，若唯一未决项是关机项，一句闲聊式应答就会断电（方案评估 P0-1） |
| ④ | **倒计时 + 可中止** | `shutdown /s /t 90`（**不带 `/f`** ⇒ 不强杀未保存内容）+ 「中止关机」口令 / 本机 `shutdown /a` |

另：口令 = **整条精确匹配**（「别关机」「关机日志」「看下状态」不触发）；仅响应本人 openid（`handleMessage` 首行校验）；关机项被自由文本误触时会明确回执「已作废、**未执行关机**」。

### 配置（`daemon.config.json` → `commands`）

| 键 | 默认 | 说明 |
|---|---|---|
| `heartbeat.keywords` | `["心跳","状态","ping"]` | 状态探针口令（精确匹配） |
| `shutdown.enabled` | `false` | **opt-in**：改 `true` 并重启服务后生效 |
| `shutdown.keywords` | `["关机","关闭电脑","关闭计算机","shutdown"]` | 关机口令 |
| `shutdown.delaySec` | `90` | 倒计时秒数（夹取 1~3600） |
| `shutdown.confirmWindowSec` | `120` | 待确认有效期（独立于 `requestTimeoutMs`） |
| `shutdown.command` | `shutdown /s /t {delay}` | 命令模板；`{delay}` 替换为**纯数字**（⇒ 无注入面） |
| `shutdown.cancelCommand` | `shutdown /a` | 中止命令 |
| `cancelShutdown.keywords` | `["中止关机","取消关机","abort"]` | 中止口令 |

> 配置为**二级深合并**：文件里只写 `shutdown` 不会顶掉 `heartbeat` / `cancelShutdown` 的默认值。

### 离线自测（不启动服务、不发 QQ）

```powershell
node --check tools/qqbot/qqbot-service.js
node tools/qqbot/qqbot-service.js --cmd-parse "关机"        # → action=shutdown · plan=shutdown /s /t 90
node tools/qqbot/qqbot-service.js --cmd-parse "别关机"      # → action=null（反向用例）
node tools/qqbot/qqbot-service.js --cmd-parse "中止关机"    # → action=shutdown-abort（route=cancel ⇒ 证明必须先行拦截）
node tools/qqbot/qqbot-service.js --probe                   # 渲染状态探针 + 字数
```

### 链路验证（**不真关机**）

1. 先指向**替身脚本**（`enabled` 设 `true`）+ 重启服务：
   `"command": "powershell -NoProfile -ExecutionPolicy Bypass -File tools/qqbot/actions/shutdown-stub.ps1"`
2. QQ 回「关机」→ 收「🔔 #N 待确认 · [关机·需确认]」→ 回「确认#N」→ 收回执，`actions/shutdown-stub.log` 出现一条记录；
3. 反向用例：关机项为**唯一未决项**时回「好」⇒ 必须收到「必须带编号」提示（**不得执行**）；
4. 验完把 `command` 改回 `shutdown /s /t {delay}`；**真关机在你在场时测**（关机后需现场上电，不支持远程开机）。

### 回滚

`commands.shutdown.enabled=false` + 重启服务（零代码改动）。

### 启动日志（可观测）

```
FIX-37 commands: heartbeat=["心跳","状态","ping"] · shutdown=OFF · abort=["中止关机","取消关机","abort"]
```

启用后为：`shutdown=ON → shutdown /s /t 90（窗口 120s）`。

### FIX-37d：中文回执乱码 + 1190 语义（2026-09-21 实机验证发现）

**实测时间线（09:44~09:49）**：09:44:39 `确认#2` → `shutdown /s /t 90` **exit 0 成功**（Windows 事件 Id=1074）→ 09:45:15 `确认#3` 在**倒计时中**再次执行 ⇒ 返回 **1190**，回执显示为 `❌ 执行失败：Command failed: shutdown /s /t 90 / �Ѿ��ƻ�ϵͳ�ػ���(1190)` → **09:46:31 机器真关机**（事件 Id=6006）→ **09:48:55 开机后服务自启**。⇒ **功能端到端成立**，问题只在回执文案。

| 缺陷 | 根因 | 修法 |
|---|---|---|
| 中文乱码 | `shutdown.exe` 等 Windows 命令按 **GBK(CP936)** 输出，Node `exec` 默认按 UTF-8 解码 | 新增 `execDecoded()` = `encoding:'buffer'` + `TextDecoder('gbk')`（无 ICU 自动回退 UTF-8）；`doAction` / `doPending` / `doShutdownAbort` 三处调用点改用；并剥掉 `Command failed: <cmd>` 前缀 |
| 1190 被当失败 | `1190 = ERROR_SHUTDOWN_IS_SCHEDULED`（已经计划系统关机）：本机已在倒计时中，Windows 拒绝重复排定且**不重置原倒计时** | `kind==='shutdown' && err.code===1190` ⇒ 回执 `ℹ️ 本机已有排定的关机（Windows 1190：已经计划系统关机），本次未重复排定…`；`中止关机` 遇 `1116` 明确回「本机没有进行中的关机」 |

```powershell
# 离线自测（无副作用；默认跑 net helpmsg 1190）
node tools/qqbot/qqbot-service.js --dec-test
# → decodedGBK="已经计划系统关机。" (gbkOk=true) ／ decodedUTF8="�Ѿ��ƻ�ϵͳ�ػ���" (utf8Ok=false)
node tools/qqbot/qqbot-service.js --dec-test "net helpmsg 1116"
```

> `node -e "…"` 属「解释器内联」⇒ 会被修改门禁拦（02 阶段实测），故行内验证一律走「自有文件 + flag」形式（`--dec-test` 即为此设计）。

## ★ 口令：开新迭代（TOOL-QQNEWITER · 2026-10-08 · opt-in）

**用途**：工位外「从零开工」—— 上一迭代结案、下一迭代未开的窗口期（ACTIVE=none 时静置邀请也被第⑤闸抑制），用 QQ 口令启动新迭代（创建目录/state/ACTIVE 并进入 01 阶段）。

**用法**：

| 你回 | 效果 |
|---|---|
| `开新迭代 #23`（或 `新开迭代 23`） | 前置校验（ACTIVE 必须 none）→ 登记待确认项 → 收到 `🔔 #N 待确认 · [开新迭代·需确认]` |
| **`开新迭代`（不带编号）** | ★ 不知道编号时用：接管会话读 04 §3.3 + 现有迭代现状，列出接下来 3~5 个可开项 → 你回选项（A/B/C）选号 → 复核确认 → 创建迭代 |
| `确认#N` | 派发 CLI 接管会话：读 04 登记表定位 #23 → 复述确认（闸 1.5）→ 建迭代 → 跑 01 阶段 → 01 交付即停并 notify |
| `取消#N` | 作废本项（不创建任何迭代） |
| 自由文本（「嗯」等） | **不作答**：项作废 + 明确回执（防误开工） |
| 回「好/ok」（免编号） | **拒绝**（受限 kind，必须带编号） |

**三重防护**：① opt-in（`commands.newIteration.enabled` 默认 `false`）；② 前置闸 ACTIVE 必须 `none`（严格口径：已结案但未释放 ACTIVE 也拒）；③ 二次确认 + 禁免编号直通 + 自由文本不作答。

**启用**：`daemon.config.json` → `commands.newIteration.enabled: true` → `stop-service.ps1` → `start-service.ps1`（配置不热加载）。

**边界**：IDE 无需开着（CLI 独立进程）；服务重启会清 pending（口令项需重发）；派发后 `RUNNING.json` 锁**续期**（job 存活期间有效，回工位想接管可删锁）；job 结束/失败会推 QQ 回执（V2-9）；命令类 kind 禁止经 `/request` 登记（V2-3，防伪造）。

**离线自测**：`node tools/qqbot/qqbot-service.js --newiter-parse "#23"` / `--cmd-parse "开新迭代 #23"`。

**回滚**：`enabled: false` + 重启（零代码改动）。

**评审记录**：`runtime/TOOL-QQNEWITER-四件套.md`（§⑦ v2 修订）+ `runtime/TOOL-QQNEWITER-评审-{A,B,C}.md`。

## ★ 口令：继续迭代 [模型名] / 查看迭代 / 模型列表（TOOL-QQCONT · 2026-10-09）

**用途**：工位外「续推当前迭代」的**确定性入口**（此前只有静置邀请这条启发式通道），以及两个只读口令（看状态、看模型清单）。与「开新迭代」互为镜像：开新迭代要求 ACTIVE=none，继续迭代要求 ACTIVE **存在**。

**用法**：

| 你回 | 效果 |
|---|---|
| `继续迭代` | 前置闸 → 登记待确认项 → 收到 `🔔 #N 待确认 · [继续迭代·需确认]`（模型 = CLI 默认） |
| `继续迭代 glm-5.3-flash`（或 `推进迭代 …`） | 同上；模型须**命中清单**（回「模型列表」看全量），否则拒绝登记 |
| `确认#N` | 派发 CLI 接管会话（Web UI 可视化）：读 handoff 文件按「剩余工作」继续推进**登记时快照的那个迭代** |
| `取消#N` | 作废本项（不启动任何会话） |
| 自由文本（「嗯」等） | **不作答**：项作废 + 明确回执（「未启动任何接管会话、未推进迭代」） |
| 回「好/ok」（免编号） | **拒绝**（受限 kind，必须带编号） |
| `查看迭代`（`迭代状态` / `当前迭代`） | 只读回执：迭代 ID / 阶段+状态 / blocked 卡点 / **全量待办步骤** / 接管状态（lock 的 #N·剩余分钟·mode·模型）/ Web UI 端口 |
| `模型列表`（`模型清单`） | 只读回执：支持模型清单（**单一来源 = CLI `--help`**，TTL 缓存 600s）+ 来源标注 |

**前提与防护**：
1. **opt-in**：`commands.continueIteration.enabled` 默认 `false`（写类动作；两个只读口令默认 `true` —— 与 `/help` 同口径）。
2. **模型硬校验（D-2=A）**：CLI 对错模型名**静默接受**（实测：`--model not-a-model` 起服 stderr 空、照跑）⇒ 不校验就等于用户拼错时静默跑默认模型。清单不可用时**不静默报空**（回执区分「清单暂不可用（CLI 探测失败）」/「不在支持清单（附清单）」/「内置兜底清单」）。
3. **模型下发形态（D-1 收敛）**：随 job payload **逐 job** 下发（`POST /api/v1/jobs {model}` → CLI 自行 `--model`）—— 探针实证该字段被消费（API 契约 + handler 双证）⇒ **serve 实例不换型、不重启**（换型族整族取消）。print 降级路径走 `adapter.applyModelToCommand`（注入失败会在回执里**如实说明**）。
4. **幂等 + 防漂移**：进入即同步预检 dup，异步校验回调内**复检**（防校验窗口内连发双登记）；确认时**复读 ACTIVE** 与登记快照比对，不符 ⇒ 拒绝派发并回执两个 ID；handoffPrompt 前缀注入目标迭代 ID 自检（接管会话发现不符即停止报告）。
5. **命令类口径**：`/simulate-message` 注入本口令被预检①自动 403（命令类只能走 QQ）；`/request` 命令类 default-deny 已含 `continue-iteration`；「继续迭代」在 `parseCommandAction` 内解析（**早于** `route()`）⇒ 不会被 confirm 的「继续」子串吞掉，而裸「继续」仍走 confirm。
6. **回显红线**：只读回执与消息**不含** Web UI 明文直链/口令（只给端口）。

**启用**：`daemon.config.json` → `commands.continueIteration.enabled: true` → `stop-service.ps1` → `start-service.ps1`（配置不热加载）。

**边界**：IDE 无需开着；服务重启清 pending（口令项需重发）；模型清单来自 CLI `--help` 解析（CLI 升级导致措辞变化 ⇒ 回落 `headless.fallbackModels`，再不可用 ⇒ 明确拒绝而非放行）。

**离线自测**：
```powershell
node tools/qqbot/qqbot-service.js --cmd-parse "继续迭代 glm-5.3-flash"   # 口令解析 + 三开关可见性
node tools/qqbot/qqbot-service.js --contparse "glm 5.3"                  # 形态非法 ⇒ ok:false
node tools/qqbot/qqbot-service.js --contparse "glm-5.3-flash"           # 清单校验（冷启 ~4.4s）
node tools/qqbot/adapter-headless.js --modellist --no-cache              # 清单提取（22 项）
```

**回滚**：`enabled: false` + 重启（零代码改动）；模型能力无需回滚（不传 model 即旧行为）。

**评审记录**：`runtime/TOOL-QQCONT-四件套.md`（§⑦ v2 必修 15 项 + §4.2.1 探针实测）+ `runtime/TOOL-QQCONT-评审-{A,B,C}.md`。

## ★ /help：QQ 指令清单（2026-10-09）

**起因（实证，非臆测）**：`inbox.jsonl` 2026-10-08T10:34:48 用户真发「指令」、10:34:56 再发「有哪些指令」（间隔 8 秒，两条均无有效响应）；同日 10:05~10:42 还在连续摸索「开新迭代 / 开机 / 关机 / 确认#3」。QQ 侧指令已达 15 类语法族、50+ 写法 ⇒ 靠人记不可行（README 1300+ 行亦无速查）。

**用法**：QQ 里回 `/help`（或 `help` / `帮助` / `指令` / `指令清单` / `有哪些指令`）→ 立即收到分组指令清单（实测 258 字）。

**特性**：
- 只读自检：不登记 `#N`、不落 pending、不受静默/免打扰影响（与「心跳」同路径，直发 `send()`）。
- 开关**现读配置**：关机/待机/开新迭代/继续迭代未启用时清单自动标注「（未启用）」；改 `commands.*.keywords` 后 `/help` 自动同步（无第二真相）。
- 触发词 = **整条精确匹配**（`hitKeyword`）⇒「帮助我改代码」「按指令执行」「别关机」均不误触。
- 未识别兜底带引导：`fallbackReply` 已改为「回 /help（或「指令」）查看全部指令…」⇒ 忘了口令随便发一句也能自愈。
- 分支位置在 `parseCommandAction`（**早于 `route()` / 自由文本兜底**）⇒ 有待办挂着时回「指令」不会被当成答复吃掉。

**指令速查表**（工位侧对照；活口径 = `qqbot-service.js` 的 `buildHelpText()` —— 改口令必须同步该函数与 `--help-test` 探针）：

| 组 | 口令 | 效果 |
|---|---|---|
| 待办 | `确认#编号` / `取消#编号` | 执行 / 作废第 N 项 |
| 待办 | `回IDE#编号`（唯一非 idle 待办可免编号） | QQ 侧作废本项，回 IDE 原会话拍板 |
| 待办 | `A` / `A#编号` | 选择题作答（多条并存时带编号） |
| 查询 | `心跳`（`状态` / `ping`） | 状态探针：服务/迭代/接管/静默 |
| 查询 | `查看迭代`（`迭代状态` / `当前迭代`） | ★ TOOL-QQCONT：迭代 ID/阶段/卡点/全量待办/接管状态（只读） |
| 查询 | `模型列表`（`模型清单`） | ★ TOOL-QQCONT：支持模型清单（来源 = CLI `--help`，只读） |
| 查询 | `静默2h` ｜ `全部静默1h` ｜ `取消静默` | 静置邀请 / 全部通知 的静默与解除 |
| 电源 | `待机 30min` ｜ `开机 07:30` | S3 待机（带定时唤醒）/ 注册唤醒并立即待机 |
| 电源 | `关机` ｜ `中止关机` | 90s 倒计时关机 / 取消倒计时 |
| 迭代 | `开新迭代 #23`（不带编号先列候选） | ACTIVE=none 时从工位外启动新迭代 |
| 迭代 | `继续迭代 [模型名]` | ★ TOOL-QQCONT：ACTIVE 存在时续推当前迭代（模型可选，须命中清单） |
| 帮助 | `/help`（`指令` / `帮助`） | 本清单 |

> 电源与迭代口令均需二次确认（回 `确认#编号`）；关机/待机/开新迭代/继续迭代项**禁止免编号直通**（回「好/ok」不生效），继续迭代项的自由文本按作废处理。

**配置**（`daemon.config.json → commands.help`）：`enabled`（默认 true；false = 不识别本口令、落回兜底）、`keywords`（触发词表，整条精确匹配；含全角 `／help`）。

**离线自测**：
```powershell
node tools/qqbot/qqbot-service.js --help-render   # 渲染清单 + 字数（上限 600）
node tools/qqbot/qqbot-service.js --help-test     # 探针：清单每条语法被对应解析器识别 + 负向不误触 + 分发优先级 + 长度护栏（现 39 项）
```

**实测（2026-10-09）**：`--help-test` 26/26 PASS；★ TOOL-QQCONT 落地后 **39/39 PASS**（新增三口令 8 项 + 分发优先级 3 项 + 负向 2 项 + 长度护栏）；既有回归 `--parse` / `--cmd-parse`（关机/待机/开新迭代）/ `--snooze-parse` / `--newiter-parse` / `--probe` / `--merge-test` 全绿；服务重启后真实 QQ 端到端（`/help`、`心跳`、未识别兜底）见 `service.log`。

## ★ FIX-38：「待机 + 定时唤醒」与「上/下线通知」（2026-09-21）

### 背景（硬件实测）

本机 `powercfg -a` **仅支持 待机(S3)**（休眠未启用）；`wake_armed` 含**有线网卡**但**网线未插**、Wi-Fi（Intel AC 9461）**不支持唤醒** ⇒ 远程"开机"只能走**服务端定时唤醒**，WOL 需硬件前提（插网线 + BIOS + 常开中介，本方案不含）。

### 用法

| 你回 | 效果 |
|---|---|
| `待机` | 进入 S3，**默认 30 分钟后自动唤醒**（裸待机也带定时器 ⇒ 不会睡死） |
| `待机 30min` / `待机 2h` | 指定唤醒时长（支持 `m/min/分钟/h/小时`；上限 `maxWakeMin`） |
| `开机` / `开机 07:30` | = 注册定时唤醒 + 立即待机（不带时间 = `defaultWakeMin` 分钟后；时间已过 ⇒ 顺延到明天） |
| `确认#N` | 先建唤醒定时器（**失败则不待机**）→ 回执 → 再执行待机命令 |
| `取消#N` | 本项作废，不待机 |

- 与「关机」同款安全骨架：**二次确认 + 关机/待机项禁止免编号直通**（回「好/可以/ok」不生效）。
- **待机期间机器人也离线**（进程被挂起），到点自动恢复且**进程继续**（无需登录）；关机（S5）则只能靠 WOL/BIOS。
- 唤醒定时器 = `schtasks /Create /XML`（XML 含 `<WakeToRun>true</WakeToRun>`）——**实测免管理员可用**（本机 2026-09-21 验证：建/查/删全通过）。

### 上/下线通知（三种停止场景）

| 停止方式 | 通知 | 机制 |
|---|---|---|
| 服务启动 | 🟢「机器人已上线」+ 迭代/待确认/口令开关/**上次退出方式** | 启动块直接发（含 `queryWakeTimer` 结果） |
| 优雅停（`stop-service.ps1` / `POST /shutdown` / Ctrl+C） | 🔴「机器人已下线（原因）」 | 服务发完通知再退出，并写 `stoppedAt` |
| 由机器人发动的「关机」/「待机」 | ✅ 确认回执里带 🔴 预告行 | 执行前发出（关机后进程已死，发不了） |
| **硬杀 / 系统关机 / 崩溃** | ⚠️ 由**看门狗**补发（"心跳中断 N 分钟，预计异常退出"） | 心跳文件过期判定；**只通知不重启** |

### 新增文件 / 命令

| 文件 | 作用 |
|---|---|
| `stop-service.ps1` | **优雅停**（推荐用法）：POST `/shutdown` → 等 ≤12s → 仍在则强杀 |
| `qqbot-watchdog.js` | 心跳看门狗（60s 轮询；只通知不重启）；日志 `watchdog.log` |
| `start-watchdog.ps1` / `install-watchdog.ps1` | 后台启动 / 注册登录自启（`CodeBuddyQQWatchdog.lnk`，已注册） |
| `POST /shutdown` | 仅回环（127.0.0.1/::1）；`stop-service.ps1` 调用 |

### 配置（`daemon.config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `commands.sleep.enabled` | `true` | 待机开关（**默认开**：可自动唤醒；关机仍默认关） |
| `commands.sleep.command` | `rundll32.exe powrprof.dll,SetSuspendState 0,1,0` | 进入 S3（本机休眠未启用 ⇒ 确实是 S3） |
| `commands.sleep.defaultWakeMin` / `maxWakeMin` | `30` / `1440` | 默认/上限唤醒时长（分钟） |
| `commands.wake.taskName` | `PIVAS-WakeTimer` | 唤醒定时器的计划任务名 |
| `notify.onlineNotice` / `offlineNotice` | `true` | 上线/下线通知开关 |
| `notify.liveness.writeSec` / `staleSec` / `watchPollSec` | `30` / `180` / `60` | 心跳写入间隔 / 判定阈值 / 看门狗轮询 |

### 离线自测（不待机、不发 QQ）

```powershell
node tools/qqbot/qqbot-service.js --cmd-parse "待机 30min"    # → action=sleep sleepMinutes=30 wakeAt=…
node tools/qqbot/qqbot-service.js --cmd-parse "开机 07:30"    # → action=wake  wakeAt=次日 07:30
node tools/qqbot/qqbot-service.js --cmd-parse "待机 abc"      # → sleepMinutes=null（会被拒并提示格式）
node tools/qqbot/qqbot-service.js --wake-test 3               # 建→查→删 唤醒定时器（不待机）
node tools/qqbot/qqbot-service.js --wake-query                # 查当前定时器
# 看门狗告警路径自测（用独立测试文件，不污染真实心跳）：
$env:QQBOT_WD_SELFTEST='1'; node tools/qqbot/qqbot-watchdog.js --once
```

### 已知边界

- **开机 ≠ 服务可用**：合并服务是「登录自启」⇒ 唤醒/开机后需登录（或配自动登录）机器人才回话；**S3 唤醒**例外（进程未重启，直接续跑）。
- 看门狗**只通知不重启**（按用户 2026-09-21 决策）；机器关机期间看门狗同样不在线，该次中断由下次「上线通知」标注。
- `node -e` 属解释器内联会被门禁拦 ⇒ 所有自测都提供 `--flag` 形式；异步自测（`--wake-*`）已在 `require.main` 守卫中排除，避免误启动整套服务（实测踩过）。

## ★ FIX-39：「汇总」把完成通知截成半句（2026-09-21）

**起因（用户报障）**：手机 QQ 收到

> 【汇总 · 1 条 · done】
> 1. 【完成：迭代 2026-09-21-001 的 03-技术方案已结清（用户确认「A 方案通过」）⇒ 推进 04 并预置 13 步（7 待执行 + 6 not_applicable）。03 交付含 30 文件改动范围、11 项决策 D-1~D

第 2 行在 `D-1~D` 处**无任何收尾标记**中断 ⇒ 疑似被截断。

**取证（逐字复现）**：

| 项 | 值 |
|---|---|
| 原文（`--what`） | 175 字；`【完成：…】` 渲染后首行 **177 字** |
| 砍法 | `firstLine()` = 取首行 `.slice(0, 120)` —— **硬切 120、不加省略号** |
| 被丢弃的尾部 | `-11；术语整改「HIS 编码」→「来源编码」已落盘并回写 CONTEXT/01/02；doc_lint 0/0】` |
| 复现结果 vs 用户实收 | **逐字相等 = true**（用原文离线复现） |
| 发送侧 | `[MERGE FLUSH] HTTP 200 n=1` ⇒ 发出成功，**不是网络/平台截断** |

**连带的安静落差**：`/notify` 对 `done`/`progress` **一律入合并队列**（`n=1` 也套「【汇总 · 1 条】」壳）⇒ 每条完成通知都只剩首行，`status`（`--detail`）/「本次动作」/「迭代步骤」/「下一步」全部丢失；即 **`notify.qqbot.js --dry-run` 看到的完整多行 ≠ 手机实收**（此前未暴露：旧 `--what` 都短于 120 字）。

**修法（口径 A）**：

| # | 改动 | 说明 |
|---|---|---|
| ① | `n=1` **直发原文** | 不套「汇总」壳、不截断 ⇒ 与 `--dry-run` 所见一致（队列的"延迟窗口"仍保留，用于等待后续条目） |
| ② | `n≥2` 才摘要；每条超 120 ⇒ `slice(0,117) + '…'` | **截断必留痕迹**，与网络截断区分（新函数 `summaryLine()`；`firstLine()` 语义不动，其它 19 处调用不受影响） |
| ③ | `[MERGE FLUSH]` 日志补 `len=` | 对齐 `[NOTIFY] … len=`，日后取证不必再翻会话记录 |

**离线自测（不发送、不启动服务）**：

```powershell
node tools/qqbot/qqbot-service.js --merge-test
```

期望：① `n=1` 段与原文**逐字相等 true** 且长度 = 原文长度；② `n=2` 段套壳、每条 ≤120、超长以 `…` 收尾；③ 边界 120 无省略号 / 121 ⇒ 117 字 + `…`。

**回滚**：`renderMergeText()` 改回「套壳 + `firstLine()`」两行拼接即可（无配置项、无需迁移）。

## ★ FIX-40：编号复用撞号治理（2026-09-29）

**起因（实测事故）**：方案 D 端到端验收登记 `#6` 后，`wait-answer.ps1` **秒退**并返回 09-27 的旧答复
（`{"id":6,"answer":"timeout",...}`）——服务重启后 `nextId` 复位为 1，与历史 `#6` 撞号，而旧答案文件仍在
⇒ 等待方把**两天前的旧答复**当真答复。

**根因**：① `wait-answer.ps1` 只判「文件存在」，不校验新鲜度；② 服务与 `ask.js` 登记时都不清理同号残留。

**改动（3 文件）**：

| 文件 | 改动 |
|---|---|
| `qqbot-service.js` | `registerRequest()` 分配 id 后立即 `clearStaleAnswer(id)`（覆盖全部登记来源：ask.js / notify-enqueue / 门禁 / watcher）；新增 `answerDirAbs()`/`answerFilePath()` 路径单一来源，`writeAnswer` 复用 |
| `ask.js` | 登记后**双保险**清理同号文件（服务未重启时兜底）；输出 `#ts=<ISO>`（登记时刻）；等待命令自动带 `-SinceIso <ISO>`；`--json` 增 `ts` 字段 |
| `wait-answer.ps1` | 新增**可选** `-SinceIso`：忽略 mtime 早于该时刻的答案文件（判为残留、继续等待）；不传 = 旧行为（向后兼容） |

**实证（2026-09-29）**：

| # | 用例 | 结果 |
|---|---|---|
| 1 | 造同号假残留 `2.json` → 登记 `#2` | 目录清空 + 日志 `[ANSWER CLEAR #2]` ✅ |
| 2 | `-SinceIso 2026-09-29T00:00:00Z`（文件新于该时刻） | 命中答案 exit 0 ✅ |
| 3 | `-SinceIso 2026-10-01`（文件早于该时刻 = 残留） | 判残留并继续等待 → exit 2 timeout ✅ |
| 4 | 服务重启后 `nextId` 复位 | 新登记 = `#1`（实锤撞号根因）✅ |

**旁证**：`gate-check.mjs` spawn `ask.js` 时 `stdio:'ignore'`（不解析输出）⇒ `#ts=` 新增零影响。

**顺带清理**：`.codebuddy/temp/qq-answers/` 内 57 个历史文件（09-17~09-20）已归档到同目录同级 `qq-answers-archive/`。

**建议用法**（等待方）：
```powershell
node tools/qqbot/ask.js --prompt "…"          # 输出 #id=N 与 #ts=<ISO>
powershell -File tools/qqbot/wait-answer.ps1 -Id N -TimeoutSec 300 -SinceIso <ISO>
```

## ★ 方案 D：成员代等 —— QQ 回复唤醒 **IDE 原会话**（2026-09-29 端到端实测）

**适用**：会话正在跑、需要用户拍板，且**用户离开工位**（窗口 15 分钟~数小时），但 **IDE 会话仍存活**。

**与 A/B 的分工（三模式判据）**：

| 模式 | 谁承担等待 | 续跑的是 | 等待期主 Agent 成本 | 前置 |
|---|---|---|---|---|
| A 自轮询 | 主 Agent（`wait-answer.ps1` 分片） | 原会话 | 每片 1 回合 | 无 |
| **D 成员代等** | **团队成员（waiter）** | **原会话** | **0（唤醒后 1 回合）** | **IDE 会话存活** |
| B headless | qqbot 服务 | CLI **新**会话（handoff 传上下文） | 0 | `headless.enabled` |

**链路**：
```
① 主 Agent: ask.js --prompt "…"            → 记下 #id=N 与 #ts=<ISO>
② 主 Agent: 派 waiter 成员（prompt 模板见下）
③ 主 Agent: 结束回合（= 等待；不再轮询、不再做写操作）
④ 用户 QQ 回「确认#N」→ 服务写答案文件
⑤ waiter: wait-answer.ps1 命中 → send_message 给 main
⑥ 主 Agent 被唤醒 → 校验答案 ts ≥ 登记 ts → 继续执行
```

**waiter prompt 模板**（复制即用；把 `N` / `TS` 换成实际值）：
```
【QQ 答案等待者 · 只做等待与回报】
片 1 / 片 2：执行（原样；每片一次工具调用）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\qqbot\wait-answer.ps1 -Id N -TimeoutSec 900 -SinceIso TS
- exit 0 且 stdout 的 ts 为本次（≥ TS）⇒ send_message 给 main：答案原文 <stdout 逐字>，然后结束
- exit 0 但 ts 早于 TS ⇒ 视为残留（FIX-40）⇒ 继续等下一片
- exit 2（wait-timeout）⇒ 执行下一片
两片均超时 ⇒ send_message 给 main：「等待超时未获答复（一轮 30 分钟已用尽）」⇒ **主 Agent 停止等待**
约束：不得改参数；不得读写其它文件；不得重试超过 2 片。
```
> ★ **一轮 = 2 片 × 15 分钟 = 30 分钟**（单片 `-TimeoutSec 900`；H2 实测单次长跑 ≥15 分钟可行）。
> ★ **片满未回复即停止等待**（2026-09-29 定案）：**不再续派下一轮** —— 等待窗口越长，误确认起 headless
> 与原会话撞车的风险敞口越大；停止等待后交既有静置通道按需接管（见下「等待时限与超时退化」）。

**边界与纪律**：
- **IDE 会话必须存活**（关 IDE/重启 ⇒ 链断 ⇒ 转 B）。
- 等待期**必然表现为会话静置**：`watcher.skipIdleWhenOpenAsk`（默认 `true`）会在"**本会话**存在未决拍板项"时跳过静置邀请，避免误确认起 headless 与原会话撞车；该闸**按会话过滤**，别的会话的未决项不影响你。
- 等待期若停服/待机（`关机`/`待机` 口令）：pending 队列在进程内存、**重启即丢**（实测 `nextId` 亦复位到 1）⇒ 恢复后需重新登记；恢复方须先核对是否已执行过（可用 `state.yaml` 的 `phase_status: blocked` 标注"等待用户"，零改动承载）。
- 宿主崩溃（EH）会一并带走成员与主 Agent ⇒ 按 `.codebuddy/skills/iteration-workflow/engine/team-agent-strategy.md` §八 恢复。

### ★ 等待时限与超时退化（2026-09-29 定案）

> ★ **细则唯一来源（2026-10-01 起）= `.codebuddy/skills/iteration-workflow/engine/waiting-protocol.md`**（RESUME-3 批次 1 正本化）。本节为工具侧实现口径记录，与正本冲突时以正本为准。

| 环节 | 口径 |
|---|---|
| 登记 | `ask.js --prompt "…" --timeoutSec 1800`（**勿带 `--handoff`**，理由见下） |
| 等待 | waiter 2 片 × 900s = 30 分钟；等待期主 Agent 零 token |
| 片满未回复 | **停止等待**：waiter 退出，主 Agent 记 `phase_status: blocked` + `pause_reason=等待用户超时`，**不再续派** |
| 超时回执 | 服务推「⏰ #N 等待已超时（无回复），已停止等待…静置后会再发接管邀请」 |
| 退化 | 会话继续静置 ⇒ `autoQueue` 自动登记 idle 项（自带 session、带 handoff）⇒ 用户回「确认#M」⇒ headless（B） |
| 未超时即回复 | 服务写答案 → waiter 命中 → `send_message` 唤醒原会话；自由文本（如「进 02」）原样交原会话执行（★ 仅"唯一未决项"时生效） |

**★ 红线：D 等待项禁止带 `--handoff`** —— `doPending` 确认后会 `runHeadless`（`qqbot-service.js:1904`），
而模式 D 的回复本就是要唤醒**原会话**继续执行 ⇒ 带上即"原会话 + headless 双干活"（FIX-17c/17e 事故类）。
`handoffGuard`（`:1741-1759`）**兜不住**这种误配（它只在会话 120s 内无写、任务域未推进时放行）。
⇒ B 路径**只由超时后的静置邀请承接**，不要在同一项上混用。

**★ 为什么要补 session（P0，2026-09-29 修复）**：`ask.js` 登记项原本**不含 session** ⇒ 第 ④ 闸按
`p.session === sess` 过滤 ⇒ **永不命中** ⇒ 等待期仍会被静置邀请打断。现由 `/request` 路由对
`kind ∈ {ask, decision}` **白名单兜底**（取 `WATCH.lastConv || WATCH.lastSession`）；门禁类
（`gate` / `irreversible`，可达 2h）**不补** —— 否则一条 2h 项会压掉该会话静置邀请 2 小时。

**其它已知项**：
- **服务重启清空 pending**（进程内存）⇒ waiter 空等 ⇒ 恢复后需重新登记（见上「边界与纪律」）。
- **超时→B 邀请的延迟不承诺**：snooze（`:1219-1226`，只拦 `kind==='idle'`）可能吞掉后续邀请；
  且 `idleSeconds(900) + idleInviteMinGapSec(600) + idleInviteCooldownSec(1800)` 叠加 ⇒ 实际远超 30 分钟。
- **主 Agent 恢复工作后该 #N 作废**；waiter 若随后命中，主 Agent 须先校验该项仍是当前待办再执行。

**实测记录（2026-09-29）**：手机 QQ 回「确认#7」→ 服务写答案（ts 校验通过）→ waiter 片 1 命中 → `send_message` → **IDE 原会话被唤醒并继续**；H1（成员消息唤醒空闲主 Agent）当日复现 3 次。
