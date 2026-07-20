# sj-iteration-workflow-engine

<p align="center">
  <a href="#中文">🇨🇳 中文</a> · <a href="#english">🇬🇧 English</a>
</p>

---

<a name="中文"></a>

## 🇨🇳 迭代开发工作流引擎

> 七阶段标准化流程，为 AI 驱动的开发协作而生。

将代码变更纳入结构化迭代流程，解决"AI 直接改代码 → 无法追踪 → 反复出同类问题"的困境。通过**门禁协议**、**状态文件**、**自动复盘**三大机制，确保每次修改都有记录、有审查、有沉淀。

### 核心概念

```
┌─────────────────────────────────────────────────────────┐
│                   七阶段工作流                            │
│                                                         │
│  01       02       03       04       05       06       07│
│ 需求 →  评审 →  方案 →  开发 →  测试 →  发布 →  回顾    │
│                                                         │
│  ───── 门禁协议 ──── 状态文件 ──── 自动复盘 ──────────  │
└─────────────────────────────────────────────────────────┘
```

| 阶段 | 产出 | 核心动作 |
|:----:|------|---------|
| 01-需求分析 | 需求文档 | 读取 Spec 活文档 → 与用户确认需求 |
| 02-需求评审 | 评审记录 | Reviewer 视角审阅 → 提出问题 → 用户决议 |
| 03-技术方案 | 技术方案设计 | 代码探索 → 方案 → Delta 标记 → 命名冲突预检 |
| 04-开发实现 | 任务清单 + 代码 | 清单生成 → 审查 → 确认 → Team Agent 并行编码 → 构建 → 代码审查 |
| 05-测试验证 | 测试报告 | 构建验证 → 用例生成 → 自动执行 → 降级手动 |
| 06-发布上线 | 上线记录 | 编译 → 部署 → Spec 活文档更新 → 归档 |
| 07-迭代回顾 | 迭代回顾报告 | 总结反思 → 问题清单 → 模式沉淀 → 归档释放 |

### 目录结构

```
sj-iteration-workflow-engine/
├── engine/                          ← 核心引擎文件
│   ├── startup-protocol.md          ← 启动协议（Step A-E）
│   ├── workflow-engine.md           ← 七阶段流程详细定义
│   ├── gate-protocol.md             ← 门禁协议
│   ├── state-protocol.md            ← 状态文件读写规范
│   ├── complexity-scoring.md        ← 复杂度自适应评估
│   ├── phase-steps.md               ← 各阶段步骤清单
│   ├── cross-review-protocol.md     ← 独立 Agent 交叉审查
│   ├── multi-story-workflow.md      ← 多 Story 并行模式
│   ├── naming-conflict-check.md     ← 命名冲突预检
│   ├── team-agent-strategy.md       ← Team Agent 并行决策
│   ├── delta-marking.md             ← Delta 标记体系
│   ├── template-injection.md        ← 变量注入协议
│   ├── consistency-checklist.md     ← 文件一致性检查清单
│   ├── lessons-learned.md           ← 事故案例库 + 复盘机制
│   ├── startup-protocol-step-e.md   ← 每日工作日志协议
│   ├── engine-version.template.txt  ← 版本号模板
│   └── templates/                   ← 阶段文档模板
│       ├── phase-01-需求记录.md
│       ├── phase-01-需求文档-lite.md
│       ├── phase-02-需求评审.md
│       ├── phase-03-技术方案.md
│       ├── phase-04-开发任务清单.md
│       ├── phase-05-测试验证报告.md
│       ├── phase-05-测试报告-lite.md
│       ├── phase-06-发布上线记录.md
│       ├── phase-06-上线记录-lite.md
│       ├── phase-07-迭代回顾报告.md
│       ├── phase-07-迭代回顾-lite.md
│       ├── bug-requirement-template.md
│       ├── project-lessons-learned.example.md
│       └── review-models.example.json
├── design/                          ← 设计文档（分层架构、方案分析等）
├── scripts/                         ← 工具脚本
│   ├── review-models-configurator.py
│   └── review-gateway.py
├── SKILL.md                         ← Claude Code 入口
├── SKILL.template.md                ← 新项目初始化模板
└── sync-to-codebuddy.sh             ← 项目内同步脚本（.claude ↔ .codebuddy）
```

### 核心机制

#### 三道门禁

| 门禁 | 拦截时机 | 拦截条件 |
|:----:|---------|---------|
| **修改门禁** | Agent 准备写入文件时 | 无活跃迭代 或 不在 04 阶段 |
| **迭代门禁** | 用户请求新迭代时 | 当前迭代未完成 |
| **步骤门禁** | 跳转阶段时 | 前置步骤未完成 |

#### 状态持久化

每次操作后自动写入 `runtime/{ITERATION_ID}.state.yaml`，对话重启后自动恢复上下文。

#### 自动复盘

每个阶段结束时自动执行五步复盘，提炼模式写入 `lessons-learned.md`，持续进化。

### 快速开始

#### 在项目中接入

引擎代码已直接内嵌在 `.claude/skills/iteration-workflow/` 中，无需额外安装。首次使用 Skill 时会自动引导配置。

项目级配置位于 `project/` 目录下，请根据项目实际情况编辑：

- `project.manifest.yaml` — 项目路径和技术栈配置
- `coding-conventions.md` — 项目编码规范
- `code-review-rules.md` — 代码审查规则矩阵
- `deploy-config.yaml` — 部署配置

### 项目级覆盖

项目可在 `.claude/skills/iteration-workflow/project/` 下创建以下文件覆盖引擎默认行为：

| 文件 | 用途 | Git 跟踪 |
|------|------|:--------:|
| `project.manifest.yaml` | 项目路径和技术栈配置 | ✅ |
| `coding-conventions.md` | 项目编码规范 | ✅ |
| `code-review-rules.md` | 项目代码审查规则矩阵 | ✅ |
| `context-conventions.md` | 项目上下文约定 | ✅ |
| `deploy-config.yaml` | 部署配置 | ✅ |
| `lessons-learned.md` | 项目级模式库 | ❌ 本地 |
| `review-models.json` | 外部审查模型 API 配置 | ❌ 本地 |

### 设计原则

1. **文档驱动** — 每个阶段的产出文档是下一阶段的输入
2. **门禁强制** — 所有代码修改必须经过门禁检查
3. **渐进采用** — 不强制配置外部模型，不配置则自动降级为默认行为
4. **自我进化** — 引擎自身也遵循七阶段工作流迭代改进
5. **与工具无关** — 设计上不绑定 Claude Code，可适配其他 AI 编码工具

---

<a name="english"></a>

## 🇬🇧 Iteration Workflow Engine

> A 7-phase standardized workflow engine designed for AI-driven development collaboration.

Structure code changes into a disciplined iteration process, solving the "AI modifies code directly → no traceability → same issues recur" dilemma. Three core mechanisms — **Gate Protocol**, **State Persistence**, and **Auto Retrospective** — ensure every change is tracked, reviewed, and learned from.

### Core Concepts

```
┌─────────────────────────────────────────────────────────┐
│                  7-Phase Workflow                        │
│                                                         │
│  01       02       03       04       05       06       07│
│ Req. →  Review →  Design →  Code →  Test →  Deploy →   │
│                                                         │
│  ─── Gate Protocol ─ State File ─ Auto Retrospect ───  │
└─────────────────────────────────────────────────────────┘
```

| Phase | Output | Key Actions |
|:-----:|--------|-------------|
| 01-Requirement | Requirement doc | Read spec docs → confirm with user |
| 02-Review | Review record | Reviewer perspective → raise issues → user resolution |
| 03-Technical Design | Design doc | Code exploration → solution → Delta tags → naming conflict check |
| 04-Implementation | Task list + code | Task list generation → review → confirm → Team Agent parallel coding → build → code review |
| 05-Verification | Test report | Build verification → test case generation → auto execution → manual fallback |
| 06-Release | Release record | Compile → deploy → spec doc update → archive |
| 07-Retrospective | Retro report | Summary → issue list → pattern extraction → archive release |

### Directory Structure

```
sj-iteration-workflow-engine/
├── engine/                          ← Core engine files
│   ├── startup-protocol.md          ← Startup protocol (Step A-E)
│   ├── workflow-engine.md           ← 7-phase workflow definition
│   ├── gate-protocol.md             ← Gate check protocol
│   ├── state-protocol.md            ← State file R/W specification
│   ├── complexity-scoring.md        ← Adaptive complexity scoring
│   ├── phase-steps.md               ← Phase step checklist (SSOT)
│   ├── cross-review-protocol.md     ← Cross-review protocol
│   ├── multi-story-workflow.md      ← Multi-story parallel mode
│   ├── naming-conflict-check.md     ← Naming conflict pre-check
│   ├── team-agent-strategy.md       ← Team Agent strategy
│   ├── delta-marking.md             ← Delta marking system
│   ├── template-injection.md        ← Variable injection protocol
│   ├── consistency-checklist.md     ← Consistency check list
│   ├── lessons-learned.md           ← Incident case library
│   ├── startup-protocol-step-e.md   ← Daily work log protocol
│   ├── engine-version.template.txt  ← Version template
│   └── templates/                   ← Phase document templates
├── design/                          ← Design documents (layering, analysis, etc.)
├── scripts/                         ← Tool scripts
│   ├── review-models-configurator.py
│   └── review-gateway.py
├── SKILL.md                         ← Claude Code SKILL entry
├── SKILL.template.md                ← Project init template
└── sync-to-codebuddy.sh             ← Project sync script (.claude ↔ .codebuddy)
```

### Core Mechanisms

#### Three Gates

| Gate | Trigger | Block Condition |
|:----:|---------|-----------------|
| **Modification Gate** | Agent about to write files | No active iteration or not in phase 04 |
| **Iteration Gate** | User requests new iteration | Current iteration not completed |
| **Step Gate** | Phase transition requested | Prerequisite steps incomplete |

#### State Persistence

State is automatically written to `runtime/{ITERATION_ID}.state.yaml` after each operation, enabling context recovery across conversation restarts.

#### Auto Retrospective

At the end of each phase, a 5-step retrospective runs automatically, extracting patterns into `lessons-learned.md` for continuous improvement.

### Quick Start

#### Add to Your Project

The engine code is already embedded in `.claude/skills/iteration-workflow/` — no additional installation required. Configuration is auto-prompted on first Skill load.

Project-level configuration lives in `project/`. Edit these files to match your project:

- `project.manifest.yaml` — Project paths & tech stack
- `coding-conventions.md` — Project coding conventions
- `code-review-rules.md` — Code review rules matrix
- `deploy-config.yaml` — Deploy configuration

### Project-Level Overrides

Projects can override engine defaults by creating files under `.claude/skills/iteration-workflow/project/`:

| File | Purpose | Git Tracked |
|------|---------|:-----------:|
| `project.manifest.yaml` | Project paths & tech stack | ✅ |
| `coding-conventions.md` | Project coding conventions | ✅ |
| `code-review-rules.md` | Code review rules matrix | ✅ |
| `context-conventions.md` | Project context conventions | ✅ |
| `deploy-config.yaml` | Deploy configuration | ✅ |
| `lessons-learned.md` | Project pattern library | ❌ Local |
| `review-models.json` | External review model config | ❌ Local |

### Design Principles

1. **Document-Driven** — Each phase's output is the next phase's input
2. **Gate-Enforced** — All code changes must pass gate checks
3. **Progressive Adoption** — External models are optional; zero-config defaults to built-in behavior
4. **Self-Evolving** — The engine itself follows the same 7-phase workflow for improvements
5. **Tool-Agnostic** — Designed for Claude Code but adaptable to any AI coding assistant