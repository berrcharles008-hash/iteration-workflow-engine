# 迭代 Skill 分层架构分析

> 日期：2026-07-09（更新）
> 背景：当前 Skill 文件同时存在于项目级 `.codebuddy/` 和全局 `~/.claude/`，两者内容大部分相同，只有少量项目级差异。目标是实现共性引擎跨项目复用，项目只保留个性化部分。更新：补充 Git Subtree（方案 D）和同步脚本（方案 E）两种更务实的跨仓库共享方案。

---

## 一、现状分析

### 1.1 Skill 目录结构

```
iteration-workflow/
├── SKILL.md              ← 元数据（name/description/version）
├── engine/               ← 核心引擎（7个 .md + templates/）
├── project/              ← 项目个性化配置（4个 .md）
├── runtime/              ← 运行时状态（state.yaml + ACTIVE）
├── design/               ← 设计文档
└── assets/               ← 静态资源
```

### 1.2 全局 vs 项目级文件对比

| 目录 | 文件数 | 差异情况 |
|------|--------|---------|
| `engine/` | 10 个文件 | 2 个有差异（`lessons-learned.md`、`templates/phase-05-测试验证报告.md`） |
| `project/` | 4 个文件 | **全部相同**，无差异 |
| `design/` | 若干 | 项目级有 `archived/` 子目录，全局没有 |
| `runtime/` | 若干 | **完全不同**（运行时状态，不应共享） |

### 1.3 差异文件详情

| 文件 | 差异内容 | 是否应留在项目级 |
|------|---------|:---:|
| `engine/lessons-learned.md` | 经验教训沉淀，项目特有 | 是 |
| `engine/templates/phase-05-测试验证报告.md` | 测试报告模板，可能项目定制 | 视情况 |
| `design/archived/` | 归档的设计文档 | 是 |

---

## 二、分层模型

将 Skill 文件分为三层：

| 层级 | 内容 | 存储位置 | 共享方式 |
|------|------|---------|---------|
| **L1 引擎层** | 核心工作流引擎（门禁/状态/步骤/模板） | 独立引擎仓库 → 通过 Subtree/脚本同步到各项目 | 所有项目共用 |
| **L2 项目层** | 项目个性化配置（`project/`、`design/`） | 项目 `.codebuddy/` | 项目独占 |
| **L3 运行时层** | 迭代状态（`runtime/`） | 项目 `.codebuddy/` | 项目独占 |

### 2.1 各层职责

#### L1 引擎层（独立引擎仓库）

```
sj-iteration-workflow-engine/engine/
├── gate-protocol.md          ← 门禁协议
├── state-protocol.md         ← 状态协议
├── phase-steps.md            ← 步骤清单
├── workflow-engine.md        ← 工作流引擎
├── startup-protocol.md       ← 启动协议
├── complexity-scoring.md     ← 复杂度评分
├── naming-conflict-check.md  ← 命名冲突检查
├── delta-marking.md          ← 改动标记
├── team-agent-strategy.md    ← Team 策略
├── template-injection.md     ← 模板注入
└── templates/                ← 通用模板
```

**特点**：
- 所有项目共用同一套
- 更新引擎仓库后，各项目通过 `git subtree pull` 或同步脚本拉取
- 项目差异通过 `engine-local/` 覆盖，不影响共性引擎

#### L2 项目层（项目级）

```
项目/.codebuddy/skills/iteration-workflow/
├── engine/
│   ├── lessons-learned.md    ← 项目经验沉淀
│   └── templates/
│       └── phase-05-测试验证报告.md  ← 项目定制模板
├── project/                  ← 项目配置
├── design/                   ← 设计文档
└── SKILL.md                  ← 入口文件
```

**特点**：
- 每个项目独立
- 覆盖或扩展 L1 引擎
- 不随全局引擎更新

#### L3 运行时层（项目级）

```
项目/.codebuddy/skills/iteration-workflow/runtime/
├── ACTIVE                    ← 活跃迭代指针
└── *.state.yaml              ← 迭代状态
```

**特点**：
- 完全独立，不共享
- 每次对话启动时读取

---

## 三、实施方案

### 方案 A：符号链接

#### 3.1 原理

```
项目/.codebuddy/skills/iteration-workflow/engine/
        ↑ 符号链接
        |
全局/~/.claude/skills/iteration-workflow/engine/
```

#### 3.2 实施步骤

```bash
# Step 1: 备份项目级 engine 目录
mv .codebuddy/skills/iteration-workflow/engine .codebuddy/skills/iteration-workflow/engine.project

# Step 2: 将项目差异文件移到 engine-local/
mkdir engine-local
mv engine.project/lessons-learned.md engine-local/
mv engine.project/templates/phase-05-测试验证报告.md engine-local/templates/
rm -rf engine.project/

# Step 3: 创建符号链接指向全局 engine
mklink /D .codebuddy\skills\iteration-workflow\engine %USERPROFILE%\.claude\skills\iteration-workflow\engine

# Step 4: 清理 SKILL.md 中的相对路径引用，改为先读 engine/ 再读 engine-local/
```

#### 3.3 项目结构（实施后）

```
.codebuddy/skills/iteration-workflow/
├── SKILL.md              ← 入口：先读 engine/，再叠加 engine-local/
├── engine/               ← [符号链接] → 全局 engine
├── engine-local/         ← 项目级差异化文件
│   ├── lessons-learned.md
│   └── templates/
├── project/              ← 项目配置
├── runtime/              ← 运行时状态
└── design/               ← 设计文档
```

#### 3.4 换项目时

```bash
# 只需创建符号链接 + 初始化项目级目录
mklink /D .codebuddy\skills\iteration-workflow\engine %USERPROFILE%\.claude\skills\iteration-workflow\engine
mkdir .codebuddy\skills\iteration-workflow\engine-local
mkdir .codebuddy\skills\iteration-workflow\runtime
mkdir .codebuddy\skills\iteration-workflow\project
```

#### 3.5 注意事项

- **Windows 符号链接需要管理员权限**：`mklink` 需要在管理员模式下运行
- **Git Bash 可能不支持 mklink**：需要用 CMD 或 PowerShell
- **Git 不会跟踪符号链接的内容**：需要在 `.gitignore` 中排除链接，或在 `.gitattributes` 中设置 `core.symlinks=true`

### 方案 B：Git Submodule

#### 3.1 原理

将全局 Skill 作为一个独立的 git 仓库，项目通过 submodule 引用：

```bash
# 初始化全局 Skill 为 git 仓库（如果还不是的话）
cd %USERPROFILE%\.claude\skills\iteration-workflow
git init
git add .
git commit -m "initial: iteration-workflow engine"

# 项目中添加 submodule
git submodule add <全局skill仓库地址> .codebuddy/skills/iteration-workflow/engine
```

#### 3.2 项目结构

```
.codebuddy/skills/iteration-workflow/
├── SKILL.md
├── engine/               ← [git submodule] → 全局 engine 仓库
├── engine-local/         ← 项目级差异化文件
├── project/
├── runtime/
└── design/
```

#### 3.3 优势

- **版本可控**：每个项目可以锁定不同的引擎版本
- **更新灵活**：`git submodule update` 拉取最新版本
- **Git 友好**：submodule 是 git 原生支持的

#### 3.4 劣势

- **需要 git 仓库**：全局 Skill 必须是 git 仓库
- **网络依赖**：如果全局仓库在远程，需要网络访问
- **学习成本**：submodule 操作对不熟悉 git 的人有门槛

### 方案 C：双来源共存（最简单）

#### 3.1 原理

不修改项目结构，而是让两个来源并存：

- 全局 Skill 通过 `~/.claude/skills/` 加载
- 项目 Skill 通过 `.codebuddy/skills/` 加载
- SKILL.md 中明确声明加载优先级

#### 3.2 项目结构

```
.codebuddy/skills/iteration-workflow/
├── SKILL.md              ← 声明：优先使用全局 engine
├── engine/               ← 项目级副本（与全局相同）
├── engine-local/         ← 项目差异文件
├── project/
├── runtime/
└── design/
```

#### 3.3 SKILL.md 修改

```markdown
## 引擎来源声明

> 核心引擎来自全局 Skill：`~/.claude/skills/iteration-workflow/engine/`
> 项目级差异化文件位于：`.codebuddy/skills/iteration-workflow/engine-local/`
>
> **加载优先级**：
> 1. `engine-local/`（项目级覆盖，同名优先）
> 2. `engine/`（全局引擎）
> 3. `project/`（项目配置）
```

#### 3.4 优势

- **零依赖**：不需要符号链接或 submodule
- **简单直接**：改几个文件即可
- **Git 友好**：所有文件都是普通文件，git 正常跟踪

#### 3.5 劣势

- **需要同步**：全局引擎更新后，项目级需要手动同步
- **冗余存储**：每个项目都有一份 engine 副本

### 方案 D：Git Subtree（★ 推荐）

#### 3.1 原理

将共性引擎放在独立 Git 仓库中，各项目通过 `git subtree` 拉入。`engine/` 目录由 Subtree 管理，项目 clone 即可用，不需要额外操作。

```
sj-iteration-workflow-engine/          ← 独立 Git 仓库（只有共性内容）
  └── engine/
      ├── gate-protocol.md
      ├── state-protocol.md
      ├── phase-steps.md
      ├── templates/
      └── ...

项目/.codebuddy/skills/iteration-workflow/
  ├── engine/          ← [git subtree] 拉自引擎仓库
  ├── engine-local/    ← 项目级覆盖（本项目 Git 管理）
  ├── project/         ← 项目配置
  ├── runtime/         ← 运行时状态
  └── SKILL.md         ← 入口
```

#### 3.2 实施步骤

```bash
# Step 1: 创建独立引擎仓库（一次性，引擎维护者执行）
# 在 SVN 或 Git 服务器上创建 sj-iteration-workflow-engine 仓库
# 将 engine/ 目录内容提交到该仓库

# Step 2: 各项目首次添加 subtree
git subtree add --prefix=.codebuddy/skills/iteration-workflow/engine \
    <引擎仓库地址> main --squash

# Step 3: 引擎更新后，各项目拉取
git subtree pull --prefix=.codebuddy/skills/iteration-workflow/engine \
    <引擎仓库地址> main --squash
```

#### 3.3 项目结构

```
.codebuddy/skills/iteration-workflow/
├── SKILL.md              ← 入口
├── engine/               ← [git subtree] → 独立引擎仓库
├── engine-local/         ← 项目级差异化文件
│   ├── lessons-learned.md
│   └── templates/
├── project/              ← 项目配置
├── runtime/              ← 运行时状态
└── design/               ← 设计文档
```

#### 3.4 对比 Submodule

| 维度 | Subtree | Submodule |
|------|:-------:|:---------:|
| clone 后 engine 立即可用 | ✅ 是 | ❌ 需 `--recursive` |
| 产生额外元数据文件 | ❌ 无 | `.gitmodules` |
| 更新命令 | `git subtree pull` | `git submodule update` |
| Windows 兼容性 | ✅ 无特殊要求 | ✅ 无特殊要求 |
| 管理员权限 | ❌ 不需要 | ❌ 不需要 |
| 项目可修改 engine 并回推 | ✅ 可以 | ✅ 可以 |

#### 3.5 注意事项

- 引擎仓库建议用 SVN（团队现有基础设施）或 Git
- `--squash` 参数将引擎历史压缩为一个提交，避免项目提交历史膨胀
- 引擎文件更新频率低，`git subtree pull` 只需在引擎有变更时执行

### 方案 E：简易同步脚本

#### 3.1 原理

不引入额外 Git 仓库，引擎源头放在约定好的固定目录（共享盘或本地固定路径），通过 `robocopy` 脚本同步。

#### 3.2 实施步骤

```powershell
# sync-engine.ps1（每个项目根目录一份）
$source = "D:\sj-shared\iteration-workflow-engine\engine"
$target = ".codebuddy\skills\iteration-workflow\engine"

# 同步：仅更新共性文件，排除项目差异
robocopy $source $target /MIR /XD engine-local /XF lessons-learned.md
```

#### 3.3 优势

- **零学习成本**：一个脚本文件，任何人理解
- **零依赖**：不需要 Git/SVN 新仓库
- **简单可靠**：`robocopy` 是 Windows 内置命令

#### 3.4 劣势

- **路径依赖**：依赖固定源路径（`D:\sj-shared\`），换机器需调整
- **无版本历史**：无法追溯引擎变更历史
- **手动触发**：需要手动运行脚本（但引擎变更频率低，可接受）

---

## 八、方案 D vs E 对比分析

### 8.1 核心差异

| 维度 | D: Git Subtree | E: robocopy 同步脚本 |
|------|:--------------:|:--------------------:|
| **引擎存储** | 独立 Git/SVN 仓库 | 共享盘/固定路径目录 |
| **clone 即用** | ✅ 自动拉入 engine/ | ❌ 需手动运行脚本 |
| **版本历史** | ✅ 可追溯每次引擎变更 | ❌ 无版本记录 |
| **变更通知** | ✅ `git log` 可见 | ❌ 需人工通知 |
| **回退能力** | ✅ `git revert` 即可 | ❌ 需手动覆盖 |
| **学习成本** | 中（需懂 subtree 命令） | **低**（一个批处理文件） |
| **依赖** | Git/SVN 服务器 | 共享盘挂载 + robocopy |
| **Windows 兼容** | ✅ 原生支持 | ✅ 原生支持 |
| **管理员权限** | 不需要 | 不需要 |
| **团队协作** | 新人 clone 即用 | 新人需额外配置脚本 |
| **CI/CD 集成** | ✅ 可自动 pull | ❌ 需额外编排 |

### 8.2 适用场景矩阵

```
                    引擎变更频率
                   低 ───────────── 高
                ┌─────────────────────────────┐
  团队规模  小  │    E (同步脚本)              │
                │                              │
                │    D (Subtree) ★ 推荐        │
  ──────────────┼──────────────────────────────┤
                │    D (Subtree)               │
  大    大      │                              │
                └──────────────────────────────┘
```

### 8.3 针对你们团队的评估

| 评估项 | D (Subtree) | E (同步脚本) |
|--------|:-----------:|:------------:|
| 有 Git/SVN 服务器 | ✅ 已有基础设施 | ⚠️ 仍需维护共享盘路径 |
| 引擎变更频率低 | ✅ 一年几次 pull 足够 | ✅ 也够用 |
| 新人上手 | ✅ clone 即用 | ❌ 需配脚本+路径 |
| 版本追溯 | ✅ `git log` 一目了然 | ❌ 无法追溯 |
| 回退能力 | ✅ `git revert` | ❌ 需手动覆盖 |
| 变更通知 | ✅ `git pull` 自动提示 | ❌ 需人工通知 |
| 团队规模适中 | ✅ 适合中小团队 | ⚠️ 适合极小团队 |

### 8.4 结论

**推荐 D (Git Subtree)**，理由：

1. **基础设施匹配**：你们已有 Git/SVN 服务器，Subtree 天然利用现有设施
2. **零额外配置**：clone 项目后 engine/ 立即可用，新人无学习成本
3. **可追溯**：每次引擎变更都有 commit 记录，出问题可回溯
4. **回退安全**：引擎变更不合适时，一条 `git revert` 即可
5. **变更通知**：`git subtree pull` 自动提示有新版本，不会漏掉引擎更新

**E 的适用场景**（不推荐你们用）：
- 团队 < 3 人，且引擎几乎不变更
- 没有 SCM 服务器，只有共享盘
- 追求极致简单，不愿引入任何 Git 概念

### 8.5 实施建议（Subtree）

```bash
# Step 1: 引擎仓库初始化（一次性）
# 在 SVN/Git 服务器上创建 sj-iteration-workflow-engine 仓库
# 将 engine/ 目录内容提交

# Step 2: 各项目首次拉入
git subtree add --prefix=.codebuddy/skills/iteration-workflow/engine \
    <引擎仓库地址> main --squash

# Step 3: 日常维护（引擎有变更时执行）
git subtree pull --prefix=.codebuddy/skills/iteration-workflow/engine \
    <引擎仓库地址> main --squash

# Step 4: 项目差异文件（每个项目独立管理）
mkdir -p .codebuddy/skills/iteration-workflow/engine-local
# 将 lessons-learned.md 等差异文件放入 engine-local/
```

**关键原则**：`engine/` 目录只由 Subtree 管理，项目级不要手动修改 `engine/` 下的文件。如需覆盖，放入 `engine-local/`。

| 维度 | A 符号链接 | B Submodule | C 双来源 | **D Subtree** | E 同步脚本 |
|------|:---:|:---:|:---:|:---:|:---:|
| **真正解决"多处维护"** | ✅ | ✅ | ❌ | ✅ | ✅ |
| **项目 clone 即用** | ❌ 需建链接 | ❌ 需 --recursive | ✅ | ✅ | ❌ 需跑脚本 |
| **Windows 兼容** | ⚠️ 需管理员 | ✅ | ✅ | ✅ | ✅ |
| **自动同步** | ✅ | ❌ 手动 | ❌ 手动 | ❌ 手动 | ❌ 手动 |
| **版本可控** | ❌ | ✅ | ❌ | ✅ | ❌ |
| **学习成本** | 中 | 高 | 低 | 中 | **低** |
| **Git 友好** | ⚠️ | ⚠️ | ✅ | ✅ | ✅ |
| **适合团队规模** | 个人 | 大团队 | — | 中小团队 | 小团队 |

---

## 五、推荐方案

**首选 D（Git Subtree）**，理由：

1. 项目 clone 即可用，不增加新成员心智负担
2. 更新只需一条 `git subtree pull`
3. 不需要管理员权限、不需要额外配置文件
4. 与现有 Git/SVN 工作流完全兼容
5. engine 文件变更频率低，`git subtree pull` 一年只需几次
6. **版本可追溯**：每次引擎变更都有 commit 记录，出问题可回溯
7. **回退安全**：引擎变更不合适时，`git revert` 即可
8. **变更通知**：`git subtree pull` 自动提示有新版本，不会漏掉引擎更新

**备选 E（同步脚本）**，如果：
- 团队不想引入额外的 Git/SVN 仓库
- 引擎变更极少（季度级别）
- 追求最大简单性
- 团队规模 < 3 人

---

## 六、SKILL.md 修改建议

无论选择哪个方案，SKILL.md 都需要修改为分层声明：

```markdown
---
name: iteration-workflow
version: "1.6.0"
---

# 迭代开发工作流

## 引擎来源

> 核心引擎来自独立引擎仓库，通过 git subtree 同步至 `engine/`
> 项目级差异化文件位于：`engine-local/`
> 项目级运行时文件位于：`runtime/`

## 文件加载优先级

1. `engine-local/`（项目级覆盖，同名文件优先）
2. `engine/`（共性引擎，git subtree 管理）
3. `project/`（项目配置）
4. `runtime/`（运行时状态）

## ★ 门禁规则

**任何代码修改前必须先过门禁。** 门禁协议完整规则见 `engine/gate-protocol.md`。
...
```

---

## 七、实施清单

| 步骤 | 操作 | 状态 |
|------|------|:----:|
| 1 | 确定采用方案（D/E） | 待定 |
| 2 | 创建独立引擎仓库（`sj-iteration-workflow-engine`） | - |
| 3 | 将共性 `engine/` 内容提交到引擎仓库 | - |
| 4 | 各项目执行 `git subtree add` 或配置同步脚本 | - |
| 5 | 提取项目差异文件到 `engine-local/` | - |
| 6 | 修改 SKILL.md 为分层声明 | - |
| 7 | 验证引擎加载 + 项目差异覆盖生效 | - |
| 8 | 日常：引擎变更后执行 `git subtree pull` 或运行同步脚本 | - |
