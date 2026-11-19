# session-hub · 多项目会话监控中心

统一登记 + 实时查看 + 回放各工具 headless 会话的自建 Web 界面（工具无关）。

## ★ 位置与主从（可选组件 · 共享型）

本目录是**引擎仓库里的唯一源码**（`tools/session-hub`，纳入 git）。session-hub 属于
**共享型可选组件**（`design/optional-component-distribution.md` L5）：一个进程服务 N 个项目，
实例清单在 `hub.config.json → projects[]`，**没有每项目副本** —— 第二份代码会抢同一端口。

| 位置 | 语义 |
|---|---|
| `<引擎仓库>/tools/session-hub` | **源**（唯一开发位置） |
| `%LOCALAPPDATA%\codebuddy-hub` | **活实例**（代码 + `hub.config.json` + `sessions/` `logs/` 等运行时） |
| `<项目根>/tools/session-hub` | **不留副本**（只允许一份指回本文件的说明） |

**改代码的唯一路径**：

1. 改本目录（源）
2. `install-all.ps1 -CopyOnly` —— 复制代码到活实例，**不覆盖** `hub.config.json`（排除清单只在安装器里写一处）
3. `stop-hub.ps1` → `start-hub.ps1`
4. 冒烟：`/health` + `/p/<id>/health`

> 历史：2026-11-18 运行实例从 `0010静配中心管理系统/tools/session-hub` 迁至 `%LOCALAPPDATA%\codebuddy-hub`；
> 2026-11-19 源码迁入引擎仓库 `tools/session-hub`（原项目目录降级为退役说明）。
> `hub.config.json` **不进库**：本仓库只有 `hub.config.example.json`（路径占位、密钥全空），
> 真实配置只存在于活实例目录，密钥永不回写仓库。

## 位置与端口

| 项 | 值 |
|---|---|
| 安装目录 | `%LOCALAPPDATA%\codebuddy-hub`（`-TargetDir` 可覆盖） |
| 监听 | `127.0.0.1:18766`（仅回环；公网访问请自建隧道/反代） |
| 缺省项目 | `hub.config.json → default`（无 `/p/<id>` 前缀的请求落到它） |
| 自启 | Startup `CodeBuddySessionHub.lnk` → `start-hub.ps1`（按端口探活，幂等） |

### 换机器要带什么

| 类别 | 随仓库走 | 说明 |
|---|---|---|
| 代码（`server.js` / `runner.js` / `public/` / `*.ps1`） | ✅ | clone 引擎仓库即得 |
| `hub.config.json`（含 4 类密钥） | ❌ | 只活在活实例目录；换机器用 `install-all.ps1` 逐项登记重建 |
| `sessions/` `inputs/` `dialog-archive/` `logs/` | ❌ | 运行时数据，需要历史就手工带走 |
| node 运行时 | ❌ | 先查 PATH，回落到 `C:\nvm4w\nodejs\node.exe` / `%LOCALAPPDATA%\nvm4w\nodejs\node.exe` |
| CodeBuddy CLI 入口 | ❌ | 默认 nvm4w 下的 `@tencent-ai/codebuddy-code/bin/codebuddy`；别种安装用 `CODEBUDDY_ENTRY` 覆盖 |

## 多项目模型

```
/p/<id-a>/…  → 项目 A   qqbot :<portA>   serve :<serveA>
/p/<id-b>/…  → 项目 B   qqbot :<portB>   serve :<serveB>
/…           → 缺省项目（config.default），保持旧书签/公网链接不断链
```

- 项目解析顺序：`/p/<id>/` 路径前缀 > `?p=<id>` > `default`；**未知 id ⇒ 404**（不静默回落，防串台）。
- 每个项目的上下文（`ctx`）：`root` / `qq`（origin、key、simulateKey、answersDir、serviceLog、serveInstanceFile）/ `doc`（root、key、publicUrl、extraFiles、linkRewrite）/ `serve`（port、jobPermissionMode）/ `archiveDir` / 探活缓存。
- **全局共享**：端口、`sessions/` `logs/` `inputs/` 目录（session id 全局唯一，条目带 `project` 字段）。
- **写操作密钥 per-project（P2，2026-11-18）**：`projects[].httpKey` 优先；项目未配时才回落顶层 `httpKey`。
  解析落在 `buildCtx → ctx.httpKey`，`writeAuth` 只比对 `ctx.httpKey`（不再有全局 `HTTP_KEY` 常量）。
  结果：用 A 的 key 写 `/p/B/…` ⇒ `403 bad-key`；未配 key 的项目 ⇒ `403 key-not-configured`。
  前端 `getKey()` 读 `sessionStorage['hubKey:<projId>']`，**仅无前缀页面**（旧书签）回落旧的 `hubKey`。

## 隔离边界（P1 已实现）

| 面 | 隔离方式 |
|---|---|
| 会话 | 条目 `project` 字段；`/sessions` `/session` `/stream` `/kill` `/input` 跨项目 ⇒ 404 |
| 问答流 | `dialog-archive/<proj>/` 分区 + 只读本项目 qqbot 的 `answersDir`；`/qq-reply` 用本项目 simulateKey |
| 文档 | 各自 `docs/iterations` + 各自 docKey（拿 A 的 key 读 B ⇒ 403）+ 各自 extraFiles/链接重写 |
| takeover | 各项目 serve 端口 + 独立探活缓存；job 按 `state.json → cwd` 前缀归属，**跨项目 reply/stop/delete ⇒ 403** |
| serve 直链 | 读各自 `<root>/tools/qqbot/runtime/serve-instance.json` |
| 前端 | 侧栏项目下拉 = 跳 `/p/<id>/`；置顶/重命名/折叠/docKey/httpKey 记忆均按项目分键 |

**已知限制（P1/P2 明确保留）**：
- Claude Code 会话目录（`~/.claude/projects/<slug>`）无可靠项目归属 ⇒ 全局只读，UI 标注「全局只读·未按项目过滤」。
- `sessions/logs` 的 200 条 / 14 天清理是**全局配额**（两项目共享）。

## 端点

`GET /`（UI）· `GET /health`（含当前项目 + projects 概览）· `GET /projects`（项目清单）·
`GET /sessions` · `GET /session?id=` · `GET /stream?id=&offset=`（SSE）· `GET /serve-direct` ·
`GET /dialog` · `GET /proxy/qq/{health,pending,answers,logtail}` · `GET /audit` ·
`GET /doc/list` · `GET /doc?path=&raw=` · `GET /board`（短链 302）·
`POST /spawn` · `POST /kill?id=` · `POST /input?id=` · `POST /qq-reply` ·
`GET /takeover/{status,jobs,job,transcript,overview,stream}` · `POST /takeover/{new,reply,respawn,stop,delete}` ·
`GET /takeover/models`（★ 2026-11-18 CLI 模型清单）· `POST /shutdown`

所有端点都接受 `/p/<id>` 前缀（缺省 = `default` 项目）。

### ★ 模型选择 + serve 自动拉起（2026-11-18 MVP）

- `GET /takeover/models` → `{ok, models[], source, cached, reason?}`：唯一来源 = CLI `--help` 的
  `Currently supported: (…)`，服务端解析 + **10min TTL** 缓存（冷启约 4~6s）。清单随 CLI 版本漂移
  （实测 22 → 24 项），**不得硬编码**；解析失败必须回 `ok:false`（不得静默空清单）。
- `POST /takeover/new` 的 body 可带 `model`：形态 `^[\w.:\-]{1,64}$` → 白名单校验（不在清单 ⇒ 400 `bad-model`）
  → 逐 job 透传（`POST /api/v1/jobs {model}` ⇒ CLI 侧 `--model`）。**serve 实例不换型、不重启**。
  空值 = 不传字段（用 `~/.codebuddy/settings.json → model`）。★ CLI 对错模型名**静默接受**，故必须前置校验。
- **serve 自动拉起**：`/takeover/new` 前置 `ensureServe()` —— 探活失败则调 `start-serve.ps1 -Project <id> -NoWait`
  拉起后轮询（≤90s；实测冷启 38s / 端到端 50s）。手法必须走 `Start-Process` 独立进程：
  直接 spawn CLI + `stdio:'ignore'` 会因 stdin EOF 让 serve 秒退（`qqbot/adapter-headless.js:15` P0 铁律）。
- 前端：新建会话框的模型下拉按项目存 `localStorage['hubModel:<id>']`；清单不可用时下拉禁用（禁止手输）。
- 待议：hub 拉起的 serve **没有 idle 回收**（qqbot 侧有 `idleTtlMs=30min`），长期会常驻一个 node 进程。

### ★ 续聊 = respawn（2026-11-19）

- 结论修正：2026-10-06 那条「serve 不会自动复活 stopped/done」**已过期**。serve 提供
  `POST /api/v1/jobs/{id}/respawn`（描述：停止旧进程、消费 pending reply、基于原会话恢复 worker），
  **不重放 prompt**，`sessionId` 不变 ⇒ 上下文不丢。
- hub 透传：`POST /takeover/respawn?id=`（写操作，同 `/takeover/stop` 的 `writeAuth` + `jobStateOf` 跨项目校验）。
- 实测 2026-11-19：job `86d8306e`（`done`）→ 200，`state done→working`、`alive false→true`、`detail "resuming…"`。
- 前端：`done/failed` 会话底部由「仅保留历史回放」改为「**继续对话（复活 worker）**」按钮；点后立即置 working
  重绘出输入框，再异步对账 overview / transcript。
- **边界**：serve 重启过后的更老 job 可能 404（serve 内存无该条目）⇒ 前端提示新建会话。归档会话另有
  `GET /api/v1/jobs/resumable` + `POST /api/v1/jobs/resume {sessionId}`（以 idle 新建常驻 worker，**未实测/未接**）。

## 配置（`hub.config.json`）

结构见 `hub.config.example.json`（**路径占位、密钥全空**）。真实配置只存在于活实例目录，**不进版本库**。

```jsonc
{
  "port": 18766,
  "httpKey": "",                  // 回落值：项目没配自己的 httpKey 时才用它
  "default": "<id-a>",
  "projects": [
    { "id": "<id-a>", "name": "项目 A", "root": "D:/path/to/project-a",
      "httpKey": "<write key>",   // ★ 本项目写操作密钥（P2）
      "qq": { "origin": "http://127.0.0.1:<portA>", "simulateKey": "<key>" },
      "doc": { "key": "<doc key>", "publicUrl": "https://your-domain", "extraFiles": [] },
      "serve": { "port": 19000 } }
  ]
}
```

**不要手写整份配置来加项目** —— 用安装器登记（upsert + 备份 + diff，不会写坏别的项目）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\session-hub\install-all.ps1 `
  -ProjectRoot "D:\path\to\project-a" -ProjectId <id-a> -ProjectName "项目 A" `
  -HttpKey "<write key>" -QqOrigin "http://127.0.0.1:<portA>" -ServePort 19000 `
  -DocKey "<doc key>" -DocTitle "迭代文档"
```

- `root` **必填**：hub 不在项目内，不从目录推导项目根（缺 root ⇒ 启动即报错）。
- `projects[].httpKey` **每项目一份，勿复用**；顶层 `httpKey` 只作回落。改完必须重启 hub 才生效。
- `qq.simulateKey` 必须与该项目 `daemon.config.json → hub.simulateKey` 同值（hub 按钮回复走 `POST /simulate-message`）。
- 各项目 `daemon.config.json` 中：`hub.redirectUrl = http://127.0.0.1:<hubPort>/p/<id>/`；`docLink = { baseUrl, key, projectId }`（QQ 待确认消息的「拍板依据」链接靠它带 `/p/<id>`）。

## 脚本

| 脚本 | 作用 |
|---|---|
| `install-all.ps1` | **唯一安装/登记入口**：`-CopyOnly` 只分发代码；`-ProjectRoot/-ProjectId` 登记项目（upsert）；`-DryRun` 查询三态；裸跑 ⇒ exit 1 |
| `start-hub.ps1` | 后台启动（读 config 端口、按端口探活幂等、日志写 `hub-out.log`/`hub-err.log`） |
| `stop-hub.ps1` | 优雅停止（`POST /shutdown`；超时按**端口 owner** 强杀） |
| `install-hub-autostart.ps1` | 重建 Startup 快捷方式（`-NoStart` 只注册不启动） |
| `start-serve.ps1 [-Project <id>]` | 按项目拉起 `codebuddy serve`（读 config 的 root/port，写该项目 serve-instance.json） |
| `runner.js --tool x [--project <id>] -- <cmd…>` | 登记 + 包装任意 CLI 会话（缺省项目 = config.default） |

## 契约测试（验收基线）

```powershell
# 健康 / 项目解析
curl.exe -s http://127.0.0.1:18766/health              # project=<config.default>
curl.exe -s http://127.0.0.1:18766/p/<id>/health       # project=<id>
curl.exe -s http://127.0.0.1:18766/p/__nope__/health   # 404 unknown-project
# 文档隔离（正/负）
curl.exe -s "http://127.0.0.1:18766/p/<id>/doc/list?key=<ownDocKey>"    # 200
curl.exe -s "http://127.0.0.1:18766/p/<id>/doc/list?key=<otherDocKey>"  # 403
# QQ 面板隔离
curl.exe -s http://127.0.0.1:18766/p/<id>/proxy/qq/health
# 302 落对项目（该项目的 qqbot origin）
curl.exe -s -o NUL -w "%{redirect_url}" http://127.0.0.1:<qqPort>/status   # → /p/<id>/
# takeover 概览（不应出现别项目的 job）
curl.exe -s http://127.0.0.1:18766/p/<id>/takeover/overview
```

### 三态与幂等（L5 追加验收）

```powershell
# 裸跑必须 exit 1（规范 §四.8 负向用例）
powershell -NoProfile -ExecutionPolicy Bypass -File install-all.ps1 ; $LASTEXITCODE  # 1
# 查询三态：missing / staged / enabled / enabled-degraded
powershell -NoProfile -ExecutionPolicy Bypass -File install-all.ps1 -DryRun
# 幂等：对已登记项目重跑登记，不应新增条目、不应改动别项目
powershell -NoProfile -ExecutionPolicy Bypass -File install-all.ps1 -ProjectRoot <same> -ProjectId <same>
# 清单里没有 ⇒ staged（不是 enabled）
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:18766/p/__nope__/health        # 404
```
