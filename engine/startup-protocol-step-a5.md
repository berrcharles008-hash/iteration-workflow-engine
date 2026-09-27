# 启动协议 — Step A.5 本地配置文件自检（详情）

> **SSOT 关系**：本文件 = `engine/startup-protocol.md` Step A.5 的详情承载（2026-09-25 SLIM-3 拆出，原文 L37-124 逐字迁移）；启动摘要与触发时机见 `startup-protocol.md` Step A.5 节。
> **惰性加载时机**：Step A.5 检测到缺失文件**或微核版本过旧**时读取本文件。

### 检查逻辑

```
目标文件列表：
  1. {PROJECT_ROOT}/.claude/skills/iteration-workflow/project/lessons-learned.md
  2. {PROJECT_ROOT}/.claude/skills/iteration-workflow/project/review-models.json
  3. {PROJECT_ROOT}/.codebuddy/memory/MEMORY.md ← [仅 CodeBuddy IDE]

遍历目标文件：
  ├── 文件存在 → ✅ 跳过，继续下一个
  └── 文件不存在 → 加入"待创建"列表

第 3 项（MEMORY.md）特殊处理：
  └── 先判断环境：.codebuddy/memory/ 目录是否存在？
      ├── 否 → 非 CodeBuddy IDE（Claude Code CLI 等）
      │         → 静默跳过（Hook 层已提供硬拦截）
      └── 是 → CodeBuddy IDE → 执行正常检测
                ├── 文件存在 → 检查是否含微核段（版本标记）
                │   ├── 已含且版本匹配 → ✅ 静默通过
                │   └── 不含或版本过旧 → 加入"待注入"列表
                └── 文件不存在 → 加入"待创建并注入"列表

待创建列表为空？
  ├── 是 → 静默通过，继续 Step B
  └── 否 → 输出提示框，询问用户：
```

### 提示框模板

```
╔══════════════════════════════════════════════════════════════╗
║  检测到以下本地文件尚未创建：                                ║
║                                                              ║
║  ① project/lessons-learned.md                               ║
║     ── 项目级模式库，记录事故复盘经验沉淀                    ║
║  ② project/review-models.json                               ║
║     ── 外部审查模型 API 配置                                 ║
║  ③ .codebuddy/memory/MEMORY.md [CodeBuddy IDE 专属]         ║
║     ── 冷启动门禁微核，保护无 Hook 环境下的代码修改          ║
║                                                              ║
║  是否现在创建默认模板？[Y/n]                                 ║
║  （创建后请根据项目实际调整内容，文件不纳入 Git 跟踪）       ║
║  跳过不阻塞流程，后续可随时手动创建                          ║
╚══════════════════════════════════════════════════════════════╝
```

**微核过期提示**（当 MEMORY.md 已存在但微核版本过旧时）：

```
╔══════════════════════════════════════════════════════════════╗
║  ⚠️  冷启动门禁微核版本过旧                                  ║
║                                                              ║
║  当前版本: {old_version}  模板版本: {new_version}            ║
║  门禁规则可能已更新，建议同步微核段。                        ║
║                                                              ║
║  是否更新微核到最新版本？[Y/n]                               ║
║  （跳过不阻塞流程，但可能缺少最新的门禁保护）                ║
╚══════════════════════════════════════════════════════════════╝
```

### 用户响应处理

**用户确认（Y）**：
1. 检查 `engine/templates/project-lessons-learned.example.md` 是否存在
   - 存在 → 复制到 `project/lessons-learned.md`
   - 不存在 → 提示跳过（引擎模板缺失，需手动创建）
2. 检查 `engine/templates/review-models.example.json` 是否存在
   - 存在 → 复制到 `project/review-models.json`
   - 不存在 → 提示跳过（引擎模板缺失，需手动创建）
3. **[P-045 新增]** 检查 `engine/templates/cold-start-gate-nucleus.md` 是否存在
   - 仅当环境为 CodeBuddy IDE 时执行
   - MEMORY.md 不存在 → 创建 MEMORY.md 并写入微核模板内容
   - MEMORY.md 存在但无微核 → 追加微核段到文件顶部（保留原有内容）
   - 微核版本过旧 → 替换旧版微核段（保留其他内容不变）
   - 模板不存在 → 提示"引擎模板缺失，请运行 setup-gate.py 手动注入"
4. 输出结果摘要：
   ```
   ✅ project/lessons-learned.md 已创建
   ✅ project/review-models.json 已创建
   ✅ .codebuddy/memory/MEMORY.md 冷启动微核已注入
   ⚠ 请根据项目实际编辑内容后使用
   ```
5. 继续 Step B

**用户拒绝（N）**：
- 跳过自检，继续 Step B
- **下次 Skill 加载仍会检测缺失文件**（不设永久跳过标记）
