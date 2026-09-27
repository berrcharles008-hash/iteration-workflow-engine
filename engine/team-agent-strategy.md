# Team Agent 四维并行决策策略

> 从 SKILL.md 04 阶段 Step 2 提取。定义主 Agent 如何决定最优并行方案。
> **完全通用**，不包含项目特定内容。

---

## 一、核心原则

> 不要照搬固定的串行/并行模式。主 Agent 必须根据当前迭代的具体情况，按以下 4 个维度**动态决策**并行度。

---

## 二、四维决策算法

### 维度一：依赖类型

| 依赖类型 | 是否必须串行 | 判断标准 |
|---------|:---------:|---------|
| 导入依赖（A `import` B） | ❌ 不必 | 文件名和路径已在方案中确定，两个文件可同时写 |
| 接口依赖（A 调用 B 的方法，方案已定义签名） | ❌ 不必 | 方案已约定 API 形状，写 A 的 Agent 不需要 B 先存在 |
| 探索依赖（A 需要先读取 B 的当前内容才能写） | ✅ 必须串行 | 修改老文件追加/替换代码时 |
| 冲突依赖（A 和 B 修改同一文件） | ✅ 必须串行 | 同一文件不能被两个 Agent 同时修改 |

### 维度二：操作类型

| 操作类型 | 风险 | 并行建议 |
|---------|:--:|---------|
| 新建文件（从无到有） | 低 | ✅ 可大胆并行 |
| 追加到已有文件 | 中 | ⚠️ 每个 Agent 需先 `read_file`，但可并行读取 |
| 替换已有代码 | 高 | ❌ 建议串行，逐个确认 |
| 只读探索（code-explorer） | 无 | ✅ 可与其他任务完全并行 |

### 维度三：方案完整度

| 方案中代码的完整程度 | 并行策略 |
|-------------------|---------|
| 完整代码已写入方案 | **近乎全并行**——所有文件内容已知，Agent 只是"抄写" |
| 只有接口签名 | 按依赖关系分阶段串行，先底层后上层 |
| 只有描述没有代码 | 先派探索 Agent 读代码库，再串行实现 |

### 维度四：改动文件数量

| 文件数 | 策略 |
|-------|------|
| 1-2 个 | 不必建 Team，主 Agent 直接 `write_to_file` |
| 3-5 个 | 建 Team，2-3 Agent 并行 |
| 6+ 个 | 建 Team，按依赖图**分批**并行，**每批 ≤3**（受维度五硬约束，不再"最大化并行"） |

### 维度五：宿主承载上限（★ 硬约束，优先级高于维度一~四）

> **实测背景**：CodeBuddy 扩展宿主（Extension Host）在过载时会异常终止
> （平台注入提示原文：`the CodeBuddy extension host terminated unexpectedly ... its pending
> tool calls and any team members were stopped`）。终止瞬间**在途任务、待执行工具调用和所有
> Team 成员一并停止**，成员未回传的产出即丢失。
> 因此并行度不能只按依赖最大化，必须同时满足下列上限：

| 约束 | 阈值 | 依据（实测） |
|------|------|------|
| 同批并行成员数 | **≤ 3** | 09-24 六路并发 15 分钟内崩 3 次；09-23 四路 5 分钟内崩 1 次 |
| 单成员上下文 | **≤ 15 万 token** | 09-24 14:58 崩溃发生在单会话 15.7 万~28.6 万 token 时 |
| 单成员 max_turns | 新建 ≤3、追加 ≤8、探索 ≤2 | 见 §七 |

**超阈值处理**（不得硬闯）：
- 并行成员 > 3 → 拆成多个 Batch 串行派发，**不得**同批派发第 4 个
- 单成员上下文预计 > 15 万 token → 拆任务；或让成员 `read_file` 精准片段，禁止整仓扫描

---

## 三、决策执行流程

> **Step 0（★ 2026-09-24 新增，必做）**：派发前先挂载崩溃监控采样器
> （命令见 `phase-04.md` Step 2.0：`tools\eh-monitor.ps1`）。
> 理由：宿主崩溃**根因未定性**，平台抓取的 cpu profile 存于 `%TEMP%\codebuddy-starvat*`
> 且会被清理，不挂采样器则事后永远拿不到成因证据。

```
Step 1: 扫描技术方案，列出所有任务
Step 2: 标注每个任务：操作类型（新建/追加/替换）、文件是否已知内容
Step 3: 按 4 个维度计算最优派发方案
Step 4: 输出「任务依赖图」+「并行分组」→ 强制用户确认
Step 5: team_create → 按分组批量 task 派发（同批 ≤3，见维度五）
        ★ 每个成员 prompt 必须含【产出落盘】段（见 §七）：成员每完成一个文件即增量落盘
Step 6: 主 Agent 收集所有 Agent 输出 → 生成统一变更预览
Step 7: 用户一次确认 → 主 Agent 批量写入所有文件
Step 8: ★ 若出现「extension host terminated unexpectedly」提示或成员长时间无响应，
        立即转 §八 崩溃恢复协议；**禁止**假设已完成并直接重派全部任务
```

> ⚠️ **Step 5 的结构性风险**：成员"只输出不写文件"意味着产出**仅存在于回传消息中**，
> 一旦宿主终止即随消息丢失。因此 §七 的落盘要求是**强制补偿措施**——落盘的是产出记录
> （`.codebuddy/temp/team-out/`），业务代码仍由主 Agent 在 Step 7 统一写入，两者不冲突。

---

## 四、决策输出格式（主 Agent 必须输出此格式）

```
=== 并行策略分析 ===
文件数: {N}
方案完整度: {完整代码已知/只有签名/只有描述}
冲突检测: {无同文件修改/存在冲突 → 串行}

决策: 分 {N} 批并行
  Batch 1（并行，{N} 个 Agent）:
    {agent-name-1} → {操作类型} {文件}
    {agent-name-2} → {操作类型} {文件}
  Batch 2（并行，等 Batch1 全部完成）:
    {agent-name-3} → {操作类型} {文件}

效率对比: {N} 轮 vs 固定串行 {M} 轮，节省 {%}
```

---

## 五、示例：完整代码在方案中的最优并行（6 个文件）

```
分析结果：
  - 所有文件内容已在方案中 → 维度三=全并行
  - 新增文件5个、追加1个 → 维度二=低风险
  - 无冲突依赖（未修改同一文件）→ 维度一=无串行约束
  - 文件数=6 → 维度四=建 Team

决策：分2批并行！
  ┌─ Batch 1（并行派发，无依赖）─────────────────┐
  │ agent-net     → 新建 Net 层文件               │
  │ agent-bll     → 新建 BLL 层文件               │
  │ agent-explore → 读取目标 domain 文件当前内容   │
  └──────────────────────────────────────────────┘
            ↓ 全部完成后
  ┌─ Batch 2（并行派发）──────────────────────────┐
  │ agent-domain  → 追加 Domain 层方法（需探索结果）│
  │ agent-page    → 新建页面 .vue + .ts             │
  │ agent-route   → 修改路由配置文件                │
  └──────────────────────────────────────────────┘

对比固定模式（串行 Net→BLL→Domain→Page→Route，4轮）：
动态决策后只需2轮，效率翻倍。
```

---

## 六、Team 创建与 Agent 命名规则

```
team_create:
  team_name: "{迭代简称}-dev"    （如 "monitor-mapping-dev"）
  description: "开发团队：{技术方案标题}"
```

Agent 命名规则：`{文件/层级简写}`，例如：
- `net-file`（新建 Net 层文件）
- `bll-mapping`（BLL 映射管理）
- `domain-config`（Domain 配置层）
- `explore-domain`（只读探索 Domain 文件）

---

## 七、派发参数规范

```
task 参数：
  subagent_name: "code-explorer"   （只读探索时使用）
  mode: "default"                   （标准模式）
  name: "{角色名}"
  team_name: "{team_name}"
  max_turns: {新建=3, 追加=5~8, 探索=2}
```

> 注意：`mode` 不使用 `bypassPermissions` 或 `acceptEdits`。Team Agent 仅输出**业务代码**不写入业务文件，业务代码写入由主 Agent 在批量确认后统一执行（见 §三 Step 6-7）。
>
> **★ 例外：产出记录必须落盘**（宿主崩溃时回传消息会丢失，因此产出不能只存在于消息中）。

### 【产出落盘】段（每个成员 prompt 必含，原样复制）

```
【产出落盘（★ 强制，防宿主崩溃丢失）】
每完成 **一个** 文件，立即把该文件的完整产出追加写入：
    {PROJ}/.codebuddy/temp/team-out/<你的成员名>.md
原子写（防崩溃产生半截文件）：
    1) 先写同目录 <成员名>.md.tmp
    2) 再 rename 覆盖 <成员名>.md
每段格式：
~~~
## <文件相对路径>  操作：新建/修改  +行数
<代码块：完整内容或 diff>
- 自检：<本节自检结果>
~~~
全部完成后追加完成标记：
    <!-- TEAM-OUT-COMPLETE files=N -->
禁止：
- ❌ 产出只放在回传消息里、不落盘
- ❌ 全部做完后才一次性写（中途崩溃则全丢）
- ❌ 写入业务代码目录（业务代码仍由主 Agent 统一写入）
```

---

## 八、崩溃恢复协议（★ Extension Host 终止后必走）

> 依据平台注入提示原文：
> "the CodeBuddy extension host terminated unexpectedly, so the in-flight task, its pending
> tool calls and any team members were stopped. Before continuing, **verify what was actually
> produced (files on disk / member messages)**, then re-run or reassign whatever is still
> missing instead of assuming the previous work completed."

**适用触发**（命中任一即进入本协议）：
- 会话中出现 `extension host terminated unexpectedly` 提示
- 成员状态停在 `running` 但长时间无新产出、无回传
- 日志出现 `EH lifecycle — initialize phase begin, 31 components`（= 宿主冷启动，见排查入口）

**恢复步骤**（顺序不可颠倒）：

1. **先核对磁盘，不假设**：读 `.codebuddy/temp/team-out/*.md`，按 `TEAM-OUT-COMPLETE` 标记
   把成员产出分为「已完成 / 半截 / 未开始」三类
2. **再核对业务文件**：确认哪些目标文件已在磁盘上产生；半截文件须人工确认能否保留
3. **只重派未完成部分**：已完成的不重派，半截的从断点续，未开始的按原 prompt 重派
4. **重派时注入上下文**：把已落盘的 `<成员名>.md` 路径写进新成员 prompt，令其
   **读文件接续**，而非从零重新读代码
5. **留痕**：本次「崩溃 → 影响面 → 恢复动作」记入 `project/lessons-learned.md`

**禁止行为**：
- ❌ 假设上次已完成，直接推进下一步
- ❌ 不区分状态、重派全部成员（重复消耗 + 引入重复改动）
- ❌ 把半截文件当完成

**排查入口**：`{IDE}/logs/CodeBuddyIDE/<日期>/<workspace>__<hash>.log`
关键字：`HostStarvation`（主线程阻塞）、`"rss"`（内存峰值）、`Hook timed out`（门禁超时拦截）。
