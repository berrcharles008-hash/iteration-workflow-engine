# 脚本失败限次自愈协议（self-heal protocol）

> 定位：**「脚本失败之后怎么办」的唯一裁决源**。各阶段文档只引用本文件 §1 的判定表，不复制细则。
> 适用对象：三类**客观**脚本的失败 —— `msbuild` / `scripts/validate-artifacts.py` / `scripts/validate-state.py`。
> 不适用：一切带判断空间的失败（评审驳回、需求歧义、门禁拦截）—— 见 §2。
> 记账通道：`scripts/state-apply.py self-heal`（`events[]` 只增不改，禁 Agent 手写）。

## §1 判定表

| class | 判据（客观可判定） | 上限 | 超限动作 |
|:--|:--|:--:|:--|
| `compile` | `msbuild` rc≠0，且输出含 `error CS####` 或 `error MSB####` | 3 | `blocker-add` |
| `artifact` | `validate-artifacts.py` rc=1（内容合同六类判据之一） | 3 | `blocker-add` |
| `state` | `validate-state.py` rc=1（命中具名 `[R#]` 规则） | 3 | `blocker-add` |

计数口径：按 `subject`（文件名:行 或 步骤 id）分别计数；同一 subject **成功后即清零**，
换 subject 重新从 1 计。上限 3 指「同一 subject 连续修 3 次仍失败」。

## §2 禁止自愈清单（命中任一 ⇒ 直接 `blocker-add` / `defect-add`，不得重试）

1. `review_gate` result = `rejected` —— 判断类结论，不是脚本失败。
2. 需求歧义 / 设计冲突 —— 须回 01 / 03 改口径，重跑同一命令不产生新信息。
3. 修改门禁拦截（`gate-check.mjs` rc=2）—— 门禁说"不能改"，重试等于绕过门禁。
4. 环境不可用：rc ∈ {2,3}，或命令不存在（`is not recognized` / `No such file`）。
5. 同一 subject 已失败 3 次（已达 §1 上限）。
6. `state-apply.py` **写后**校验失败 —— 该命令已自动回滚 state + ACTIVE，
   同码 rc=1 但重试只会再回滚一次（判据：输出含 `已回滚本侧 state`）。
7. `validate-state.py` 的 `[R1]` 必填字段 / 历史兼容类 ERR（存量 state 缺字段等，
   属"改数据不属改代码"，须人工裁定）。

## §3 记账契约

每次自愈经 `state-apply.py self-heal` 记一条（**禁**手写 `events[]`）：

```bash
python scripts/state-apply.py self-heal --class compile --attempt 1 --subject "src/Foo.cs:118"
```

落盘形态：

```yaml
  - at: "2026-11-22T20:30"
    event: "self_heal"
    version: 42
    detail: "class=compile attempt=1/3 subject=src/Foo.cs:118"
```

- `detail` 格式固定：`class=<compile|artifact|state> attempt=<n>/3 subject=<文件名:行 或 步骤id>`。
- 第 4 次（超限）**不再写 `self_heal`**，改 `blocker-add`，detail 带
  `escalated_from=self_heal class=<…> subject=<…>`。
- `self-heal` 命令的 `--attempt` 只接受 1~3（越界 rc=2）；`--class` 只接受 §1 三类。
- 该命令**只写事件**，不改任何状态字段（`phase_status` / `phase_steps` 均不动）。

## §4 与阶段的关系

- **04 Step 4.6（后端构建验证）**：失败先查 §1 → 白名单内「修 → 重跑 → 记 `self_heal`」
  → 超限 `blocker-add`；判断类失败直接走 §2。
- **05 Step 3（自动执行）**：同上；**白名单外失败 ⇒ 直接登记缺陷 / blocker，不重试**。
- **07 回顾**：`events[]` 中 `self_heal` 条数 = 运行健康度「恢复维」的现成数据源
  （不需要再翻 `gate-audit.log` 或快照 diff）。

## 五、变更记录

| 日期 | 变更 |
|:--|:--|
| 2026-11-22 | 初版（迭代 `2026-11-22-003` · REQ-008）：3 类白名单 × 各 3 次、7 项禁止清单、`self_heal` 事件契约、与 04/05/07 的接入点 |
