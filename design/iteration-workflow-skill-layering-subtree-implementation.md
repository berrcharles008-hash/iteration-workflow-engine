# 方案 D：Git Subtree 实施方案

> 日期：2026-07-09（修订）
> 目标：将共性引擎放入独立 Git 仓库，各项目通过 `git subtree` 拉入，项目只保留差异化文件。实施后 Skill 功能不受影响。
> 版本控制：Skill/引擎文件使用 Git（独立于项目 SVN），`engine-local/` 和 `runtime/` 由项目 Git 管理。

---

## 一、前置准备

### 1.1 确认引擎仓库地址

假设引擎仓库地址为：
```
<ENGINE_REPO_URL>
```
（引擎仓库使用 Git，替换为实际的 Git 仓库地址）

### 1.2 备份当前项目 Skill

```bash
# 在项目根目录执行
cd E:\SJYL\三佳工程\master-pre\0002预检分诊管理系统\temp-branch

# 备份整个 iteration-workflow Skill
xcopy /E /I .codebuddy\skills\iteration-workflow .codebuddy\skills\iteration-workflow.bak
```

### 1.3 确认当前 Skill 功能正常

在实施前，确认当前迭代工作流能正常工作：
- 启动协议正常加载
- 门禁协议正常拦截
- 阶段切换正常

---

## 二、提取差异文件

### 2.1 识别需要保留在项目级的文件

| 文件 | 差异原因 | 处理方式 |
|------|---------|---------|
| `engine/lessons-learned.md` | 项目经验沉淀，内容不同 | 移入 `engine-local/` |
| `engine/templates/phase-05-测试验证报告.md` | 项目定制模板，内容不同 | 移入 `engine-local/templates/` |
| `engine/templates/phase-05-测试报告-lite.md` | 与全局一致 | **不保留，由 Subtree 提供** |
| `project/` 下所有文件 | 项目配置（当前与引擎仓库模板一致） | **由项目 Git 管理，保留不动。新项目从模板复制** |
| `design/archived/` | 项目独有 | **保留在项目级** |

> **`project/` 说明**：`project/` 和 `SKILL.md` 属于项目级文件（L2），由项目 Git 独立管理，不在引擎仓库中。新建项目时从模板复制初始版本即可。

### 2.2 执行提取

```bash
# 在项目根目录执行
cd .codebuddy\skills\iteration-workflow

# 创建 engine-local 目录
mkdir engine-local
mkdir engine-local\templates

# 移动差异文件
move engine\lessons-learned.md engine-local\
move engine\templates\phase-05-测试验证报告.md engine-local\templates\

# 验证 engine-local 内容
dir engine-local
dir engine-local\templates
```

### 2.3 验证差异文件完整性

```bash
# 确保 engine-local 中有以下文件
# engine-local/lessons-learned.md
# engine-local/templates/phase-05-测试验证报告.md
```

---

## 三、准备引擎仓库

### 3.1 创建引擎仓库（一次性）

在 Git 服务器上创建 `sj-iteration-workflow-engine` 仓库，提交共性引擎文件：

```
sj-iteration-workflow-engine/
├── gate-protocol.md
├── state-protocol.md
├── phase-steps.md
├── workflow-engine.md
├── startup-protocol.md
├── complexity-scoring.md
├── naming-conflict-check.md
├── delta-marking.md
├── team-agent-strategy.md
├── template-injection.md
├── lessons-learned.md          ← 通用经验（项目额外经验见 engine-local/）
└── templates/
    ├── phase-01-需求记录.md
    ├── phase-01-需求文档-lite.md
    ├── phase-02-需求评审.md
    ├── phase-03-技术方案.md
    ├── phase-04-开发任务清单.md
    ├── phase-05-测试验证报告.md
    ├── phase-05-测试报告-lite.md
    ├── phase-06-发布上线记录.md
    ├── phase-06-上线记录-lite.md
    ├── phase-07-迭代回顾报告.md
    ├── phase-07-迭代回顾-lite.md
    └── bug-requirement-template.md
```

> **注意**：引擎仓库**只包含 `engine/` 内容**（不含外层 `engine/` 目录名本身）。通过 Subtree 以 `--prefix=.codebuddy/skills/iteration-workflow/engine` 拉入后，自动形成 `engine/` 目录结构。
>
> `project/` 和 `SKILL.md` 由**项目 Git 独立管理**，不在引擎仓库中。新建项目时从已有项目复制 `project/` 和 `SKILL.md` 模板即可。

### 3.2 提交引擎仓库

```bash
cd <引擎仓库目录>
# 引擎仓库根目录就是引擎文件本身，没有外层 engine/ 目录
git add .
git commit -m "initial: iteration-workflow engine v1.5.0"
git push
```

---

## 四、在项目中添加 Subtree

### 4.1 移除项目级 engine 目录

```bash
# 在项目根目录执行
cd E:\SJYL\三佳工程\master-pre\0002预检分诊管理系统\temp-branch

# 备份当前 engine 目录（以防万一）
cd .codebuddy\skills\iteration-workflow
ren engine engine.project
cd ..\..\..\..

# 添加 Subtree（--prefix 相对于 Git 仓库根目录）
git subtree add --prefix=.codebuddy/skills/iteration-workflow/engine <引擎仓库地址> main --squash
```

### 4.2 验证 engine 目录

```bash
# 确认 engine 目录已恢复，内容来自 Subtree
dir .codebuddy\skills\iteration-workflow\engine
dir .codebuddy\skills\iteration-workflow\engine\templates

# 确认 engine-local 中的差异文件仍然存在
dir .codebuddy\skills\iteration-workflow\engine-local
dir .codebuddy\skills\iteration-workflow\engine-local\templates
```

### 4.3 验证 Skill 功能

```bash
# 检查 SKILL.md 中的路径引用是否仍然正确
# 由于 engine/ 目录结构不变，所有相对路径引用应该不受影响
```

---

## 五、修改 SKILL.md

### 5.1 添加引擎来源声明

在 SKILL.md 的 frontmatter 后添加声明：

```markdown
---
name: iteration-workflow
description: |
  迭代开发工作流 Skill...
version: "1.6.0"
---

# 迭代开发工作流

## 引擎来源

> 核心引擎来自独立引擎仓库，通过 `git subtree` 同步至 `engine/`
> 项目级差异化文件位于：`engine-local/`
> 项目级运行时文件位于：`runtime/`

## 文件加载规则

### 替换型文件（模板类）
同名文件以 `engine-local/` 优先，覆盖 `engine/` 版本：
1. 先检查 `engine-local/` 是否存在同名文件 → 有则用
2. 否则用 `engine/` 通用版本

### 追加型文件（经验教训类）
`engine/lessons-learned.md` 和 `engine-local/lessons-learned.md` **都要读取**：
- `engine/lessons-learned.md`：引擎仓库维护的通用经验
- `engine-local/lessons-learned.md`：本项目特有的经验沉淀

## ★ 门禁规则

**任何代码修改前必须先过门禁。** 门禁协议完整规则见 `engine/gate-protocol.md`。
...
```

### 5.2 验证所有路径引用

SKILL.md 中引用 `engine/` 下的文件路径保持不变，因为 Subtree 将 `engine/` 目录恢复到了项目级 `.codebuddy/skills/iteration-workflow/engine/`。

---

## 六、验证清单

### 6.1 功能验证

| 验证项 | 预期结果 | 状态 |
|--------|---------|:----:|
| engine/ 目录存在 | ✅ 目录存在，包含所有引擎文件 | |
| engine/templates/ 目录存在 | ✅ 包含所有模板文件 | |
| engine-local/lessons-learned.md 存在 | ✅ 项目差异文件保留 | |
| engine-local/templates/phase-05-测试验证报告.md 存在 | ✅ 项目差异模板保留 | |
| SKILL.md 中 engine/ 路径引用 | ✅ 所有引用正常工作 | |
| 启动协议正常 | ✅ Skill 加载正常 | |
| 门禁协议正常 | ✅ 修改门禁正常拦截 | |
| 阶段切换正常 | ✅ 01→02→03 正常流转 | |

### 6.2 文件完整性验证

```bash
# 方法1：对比 engine/ 与引擎仓库（克隆引擎仓库后执行）
git clone <引擎仓库地址> engine-repo-temp
diff -rq .codebuddy\skills\iteration-workflow\engine\ engine-repo-temp\
# 预期：完全一致（engine-local/ 是独立目录，不存在覆盖关系）

# 方法2：对比 engine/ 与 engine-local/ 覆盖文件
# engine-local/lessons-learned.md  ≠ engine/lessons-learned.md（通用版）
# engine-local/templates/phase-05-测试验证报告.md ≠ engine/templates/phase-05-测试验证报告.md（通用版）
```

### 6.3 Git 状态验证

```bash
# 确认 engine/ 目录由 git subtree 管理
git log --oneline -- .codebuddy/skills/iteration-workflow/engine/
# 应看到 subtree 提交的记录

# 确认 engine-local/ 目录由项目 Git 管理
git log --oneline -- .codebuddy/skills/iteration-workflow/engine-local/
# 应看到项目级提交记录
```

---

## 七、日常维护

### 7.1 引擎更新

当引擎仓库有变更后，各项目执行：

```bash
git subtree pull --prefix=.codebuddy/skills/iteration-workflow/engine \
    <引擎仓库地址> main --squash
```

### 7.2 引擎回退

如果更新的引擎有问题：

```bash
# 找到 subtree pull 产生的 merge commit
git log --oneline --merges -- .codebuddy/skills/iteration-workflow/engine/

# 直接 revert 该 merge commit
git revert -m 1 <subtree-merge-commit-hash>
```

### 7.3 添加新差异文件

如需在项目级覆盖更多引擎文件：

```bash
# 1. 复制全局版本到 engine-local/
cp .codebuddy\skills\iteration-workflow\engine\templates\新模板.md \
   .codebuddy\skills\iteration-workflow\engine-local\templates\

# 2. 修改 engine-local/ 中的文件
# 3. 提交到项目 Git
git add .codebuddy/skills/iteration-workflow/engine-local/
git commit -m "feat: 覆盖模板 新模板.md"
```

---

## 八、风险与应对

### 8.1 风险：Subtree 冲突

**场景**：engine/ 和 engine-local/ 中的文件同名，Subtree 更新时可能冲突。

**应对**：
- engine-local/ 是项目级目录，不在 Subtree 管理范围内
- Subtree 只管理 engine/ 目录
- 两者是独立的 Git 路径，不会产生冲突

### 8.2 风险：引擎仓库地址变更

**场景**：引擎仓库迁移到新地址。

**应对**：
```bash
# 移除旧的 subtree
git subtree remove --prefix=.codebuddy/skills/iteration-workflow/engine <旧地址>

# 添加新的 subtree
git subtree add --prefix=.codebuddy/skills/iteration-workflow/engine <新地址> main --squash
```

### 8.3 风险：engine-local/ 文件丢失

**场景**：误删 engine-local/ 目录。

**应对**：
- engine-local/ 由项目 Git 管理，有完整历史记录
- 可通过 `git checkout HEAD -- .codebuddy/skills/iteration-workflow/engine-local/` 恢复

---

## 九、换项目时的操作

### 9.1 新项目初始化

```bash
# 1. Clone 项目
git clone <项目仓库地址>
cd <项目目录>

# 2. 添加引擎 Subtree
git subtree add --prefix=.codebuddy/skills/iteration-workflow/engine \
    <引擎仓库地址> main --squash

# 3. 创建 engine-local 目录结构（空目录，后续按需添加差异文件）
mkdir .codebuddy\skills\iteration-workflow\engine-local
mkdir .codebuddy\skills\iteration-workflow\engine-local\templates

# 4. 创建项目级 engine-local/lessons-learned.md（空模板）
echo # 本项目经验教训 > .codebuddy\skills\iteration-workflow\engine-local\lessons-learned.md

# 5. 复制 project/ 和 SKILL.md 模板（从已有项目或引擎仓库模板复制）
# cp <模板来源>\project\ .codebuddy\skills\iteration-workflow\project\
# cp <模板来源>\SKILL.md .codebuddy\skills\iteration-workflow\SKILL.md

# 6. 初始化运行时目录
mkdir .codebuddy\skills\iteration-workflow\runtime

# 7. 提交到项目 Git
git add .codebuddy/skills/iteration-workflow/
git commit -m "init: iteration-workflow skill with engine subtree"
```

### 9.2 已有项目迁移

```bash
# 在项目根目录执行
cd <项目目录>

# 1. 备份当前 engine 目录（ren 不支持带路径的目标名，先 cd）
cd .codebuddy\skills\iteration-workflow
ren engine engine.project
cd ..\..\..\..

# 2. 提取差异文件到 engine-local/
mkdir .codebuddy\skills\iteration-workflow\engine-local
mkdir .codebuddy\skills\iteration-workflow\engine-local\templates
move ".codebuddy\skills\iteration-workflow\engine.project\lessons-learned.md" ".codebuddy\skills\iteration-workflow\engine-local\"
move ".codebuddy\skills\iteration-workflow\engine.project\templates\phase-05-测试验证报告.md" ".codebuddy\skills\iteration-workflow\engine-local\templates\"
rmdir /s /q .codebuddy\skills\iteration-workflow\engine.project

# 3. 添加 Subtree（--prefix 相对于 Git 仓库根目录）
git subtree add --prefix=.codebuddy/skills/iteration-workflow/engine \
    <引擎仓库地址> main --squash

# 4. 验证
dir .codebuddy\skills\iteration-workflow\engine
dir .codebuddy\skills\iteration-workflow\engine-local
```
