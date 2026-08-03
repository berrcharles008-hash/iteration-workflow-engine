# 自修改安全协议

> 当迭代工作流修改自身的核心文件时，自动快照 + 变更影响声明 + 回滚路径。
> 解决新 clone 项目无 SVN/git 历史时的回滚困境。

---

## 一、核心文件清单

以下文件被认定为"核心文件"，修改时必须执行快照：

| 文件 | 路径（相对于 Skill 根目录） | 角色 |
|------|------|------|
| gate-check.mjs | `hooks/gate-check.mjs`（`.claude/hooks/` 或 `.codebuddy/hooks/` 取决于 AI 工具，由环境变量自动检测） | L3 物理拦截层 |
| gate-protocol.md | `engine/gate-protocol.md` | 门禁规则唯一真相源 |
| state-protocol.md | `engine/state-protocol.md` | 状态文件读写规则 |
| SKILL.md | `SKILL.md` | Skill 入口 + 路由表 + 门禁摘要 |

> 此清单可随引擎演进扩展。新增核心文件时，同步更新本清单。

---

## 二、修改前快照规则

### 2.1 自动快照

Agent 在任何迭代中修改上述核心文件时，**修改前**必须先执行：

```
1. 创建快照目录（如不存在）：
   runtime/snapshots/

2. 复制当前版本到快照：
   cp 目标文件 runtime/snapshots/{YYYY-MM-DD}-{filename}.bak
```

**示例**：
```bash
# 修改 gate-check.mjs 前（备份两处，auto-detect 自动选择运行方对应的路径）
mkdir -p runtime/snapshots/
cp .claude/hooks/gate-check.mjs runtime/snapshots/2026-07-23-gate-check.mjs.claude.bak
cp .codebuddy/hooks/gate-check.mjs runtime/snapshots/2026-07-23-gate-check.mjs.codebuddy.bak
```

### 2.2 快照命名规范

```
{YYYY-MM-DD}-{相对路径转文件名}.bak
```

路径中的 `/` 和 `\` 替换为 `-`：
- `.claude/hooks/gate-check.mjs` → `gate-check.mjs.claude.bak`
- `.codebuddy/hooks/gate-check.mjs` → `gate-check.mjs.codebuddy.bak`
- `engine/gate-protocol.md` → `gate-protocol.md.bak`

### 2.3 快照保留策略

- 快照文件不自动清理
- 同一文件多次修改产生多个时间戳快照，按日期区分
- 建议在迭代回顾（07 阶段）时手动清理测试通过后不再需要的旧快照

---

## 三、变更影响声明

修改核心文件时，Agent 必须同步输出变更影响声明（格式参考 F13 机制）：

```
╔═══════════════════════════════════════════════════════╗
║  ⚠️ 核心文件变更影响声明                              ║
║                                                       ║
║  文件：engine/gate-protocol.md                        ║
║  变更类型：修改门禁规则                                ║
║  影响范围：所有迭代的代码修改门禁检查                  ║
║  快照位置：runtime/snapshots/xxx-gate-protocol.md.bak  ║
║  回滚方式：cp snapshots/xxx.bak engine/gate-protocol.md║
║                                                       ║
║  是否继续？[Y/n]                                      ║
╚═══════════════════════════════════════════════════════╝
```

用户确认后继续执行修改。

---

## 四、回滚步骤

### 4.1 从快照恢复

```bash
# 1. 恢复文件（根据运行方选择对应的快照）
cp runtime/snapshots/2026-07-23-gate-check.mjs.claude.bak .claude/hooks/gate-check.mjs
cp runtime/snapshots/2026-07-23-gate-check.mjs.codebuddy.bak .codebuddy/hooks/gate-check.mjs

# 2. 清理 state.yaml 中该次变更的步骤标记
#    编辑 runtime/{ITERATION_ID}.state.yaml
#    将对应 phase_steps 中涉及核心文件变更的步骤重置为 pending

# 3. 运行回归测试验证
node scripts/run-gate-tests.mjs
```

### 4.2 无快照时的恢复

如果快照文件丢失（如 `runtime/` 目录被清理），可从以下来源恢复：
- SVN 历史：`svn cat -r {PREV} 目标文件@`
- Git 历史：`git show HEAD~1:目标文件`
- 其他项目副本的 engine/ 目录（确认版本一致）
- 最后手段：重新从引擎源拉取该文件的原始版本

---

> **变更记录（2026-07-23 S4.2）**：新增自修改安全协议，定义核心文件快照机制、变更影响声明模板和回滚路径。
