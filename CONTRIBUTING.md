# 贡献指南 / Contributing Guide

感谢您对 iteration-workflow-engine 项目的关注！本文档描述了参与贡献的流程和规范。

Thank you for your interest in contributing to iteration-workflow-engine! This document describes the process and conventions for participation.

---

## 🇨🇳 中文

### 1. 提交 Issue

- 在提交 Issue 前，请先搜索是否已有类似问题
- 使用 Issue 模板（如有）填写完整信息
- 描述清楚：问题现象、复现步骤、期望行为、实际行为、环境信息

### 2. 提交 Pull Request

#### 流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature-name`
3. 提交变更：`git commit -m 'feat: 添加 XXX 功能'`
4. 推送分支：`git push origin feature/your-feature-name`
5. 在 GitHub 上创建 Pull Request

#### PR 规范

- 一个 PR 只做一件事，保持变更范围最小
- PR 标题使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式
- PR 描述包含：变更内容、变更原因、测试方式
- 如有关联 Issue，在 PR 描述中引用（如 `Closes #123`）

### 3. Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

| type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构（非新功能、非修复） |
| `test` | 测试相关 |
| `chore` | 构建/工具/依赖等杂项 |

示例：
```
feat(engine): 添加多 Story 并行模式支持
fix(gate-protocol): 修复 ACTIVE 失同步时未回退扫描的问题
docs(readme): 更新快速入门指南
```

### 4. 代码规范

- Markdown 文档使用中文 + 英文双语（如适用）
- 文件名使用 kebab-case（如 `gate-protocol.md`）
- 引擎文件放在 `engine/` 目录下
- 项目配置放在 `project/` 目录下
- 新增协议文件需在 `SKILL.md` 中注册引用

### 5. 引擎自身演进

本引擎**可采用**自身的七阶段迭代工作流进行演进：

> ★ **适用场景（2026-09-20 明确）**：本仓库是**通用模板**，面向外部贡献者 —— 走七阶段是**推荐路径**。
> 而**下游项目实例**对引擎的维护采用**元层通道**：**不创建迭代、不占用迭代编号、不进 01-07 流程**，
> 待办登记 `runtime/TOOLING-TODO.md`（见实例侧 `runtime/SESSION-HANDOFF.md`）。
> 两条通道**目标读者不同，不构成矛盾**。

1. **01-需求分析** — 在 `design/` 目录下产出需求文档
2. **02-需求评审** — 评审通过后进入下一阶段
3. **03-技术方案** — 产出技术方案设计
4. **04-开发实现** — 任务清单 + 代码实现
5. **05-测试验证** — 构建验证 + 门禁回归测试
6. **06-发布上线** — 版本发布
7. **07-迭代回顾** — 复盘 + 模式沉淀

贡献者在修改引擎核心协议（`engine/` 下文件）时，建议遵循此流程。

- ★ **硬性前置（2026-09-20 起）**：对本引擎的**任何**修改（含 `engine/`、`scripts/`、`hooks/`、`SKILL.md`、模板）**必须先向用户提交「合理性论证 + 关联影响分析 + 完整方案 + 方案准确性自评」四件套，取得明确确认后方可动手**；完成后必须提供**可观测、可评估**的验证方式与判据（命令 + 期望输出）。其中关联影响分析须**逐个 `read_file` 实证**（禁止只凭全文检索结果断言——检索可能漏报）。

---

## 🇬🇧 English

### 1. Reporting Issues

- Before submitting, please search for existing similar issues
- Use the Issue template (if available) and fill in all fields
- Clearly describe: symptom, reproduction steps, expected behavior, actual behavior, environment

### 2. Submitting Pull Requests

#### Process

1. Fork this repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Commit changes: `git commit -m 'feat: add XXX feature'`
4. Push branch: `git push origin feature/your-feature-name`
5. Create a Pull Request on GitHub

#### PR Guidelines

- One PR does one thing — keep changes minimal
- PR title follows [Conventional Commits](https://www.conventionalcommits.org/) format
- PR description includes: what changed, why, how to test
- Reference related issues (e.g., `Closes #123`)

### 3. Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

| type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `style` | Code formatting (no functional change) |
| `refactor` | Refactoring (not feat, not fix) |
| `test` | Test related |
| `chore` | Build/tools/dependencies etc. |

### 4. Code Standards

- Markdown docs in bilingual (Chinese + English) where applicable
- File names in kebab-case (e.g., `gate-protocol.md`)
- Engine files go under `engine/`
- Project config goes under `project/`
- New protocol files must be registered in `SKILL.md`

### 5. Engine Self-Evolution

This engine **may** evolve following its own 7-phase iteration workflow:

> ★ **Scope (clarified 2026-09-20)**: this repository is the **generic template** for external contributors — the 7-phase path is **recommended** here.
> **Downstream project instances** maintain the engine via a **meta channel**: no iteration is created, no iteration ID is consumed, and the 01-07 flow is skipped; pending items are logged in `runtime/TOOLING-TODO.md` (see the instance-side `runtime/SESSION-HANDOFF.md`). The two paths target different audiences and are **not in conflict**.

- ★ **Hard prerequisite (since 2026-09-20)**: ANY change to this engine (including `engine/`, `scripts/`, `hooks/`, `SKILL.md`, templates) MUST first be submitted to the user as a **four-part package** — (1) rationale backed by real failure cases, (2) impact analysis over all linked files, **verified by reading each file individually** (never rely on search results alone — they can miss matches), (3) complete per-file plan (current → target → reason), (4) self-assessment of the plan's weak points — and may only be executed **after explicit user confirmation**. Afterwards, an **observable and assessable** verification method (command + expected output) must be provided.

---

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
