# design/ · 设计文档目录

本目录存放迭代流程引擎的设计文档（分层架构、方案分析、评测报告、路线图等）。

## ★ 路径口径声明（2026-11-24 起）

**本目录内文档引用的 `engine/<文件>.md` 路径，以该文档写作时的引擎结构为准。**

2026-11-24 的「引擎目录重组」迭代（`2026-11-24-001`）把 `engine/` 顶层 30 个 `.md`
按 8 组分区收纳：`flow/` `startup/` `gate/` `state/` `collab/` `governance/` `context/` `domain/`。

- 因此本目录下**历史文档**中形如 `engine/phase-04.md` 的写法，现行落点为
  `engine/flow/phase-04.md`；其余同理（组名映射见仓库根 `README.md` 的目录结构段）。
- 这段历史引用**有意不做批量改写**：这些文档同时是决策留痕与评审证据，
  改写路径会让当时的目录形态失真，无法复核当时的判断依据。
- 需要现行权威路径时，一律以仓库根 `README.md` 目录结构段、
  `engine/rules/manifest.json` 与磁盘实际结构为准，**不要以本目录文档为准**。

## 现行结构速查

| 组 | 收纳内容 |
|:--|:--|
| `engine/flow/` | `workflow-engine` · `phase-steps` · `phase-01`~`phase-07` · `complexity-scoring` |
| `engine/startup/` | `startup-protocol` + `-step-a5` / `-step-e` |
| `engine/gate/` | `gate-protocol` · `gate-decision-table` + 门禁实现（`*.mjs`） |
| `engine/state/` | `state-protocol` |
| `engine/collab/` | `waiting` · `team-agent` · `cross-review` · `multi-story` · `self-heal` |
| `engine/governance/` | `evolution-safety` · `consistency-checklist` · `capability-map` · `lessons-learned` |
| `engine/context/` | `context-discipline` · `template-injection` |
| `engine/domain/` | `naming-conflict-check` · `delta-marking` · `doc-style-guide` |
