# 引擎升级指南

> 当 Skill 引擎发布新版本时，按本指南升级项目中的引擎副本，同时保护项目自定义配置不被覆盖。

---

## 一、前置条件

### 1.1 确认当前版本

```bash
# 查看引擎版本
cat project/engine-version.txt
# 或从 engine/engine-version.template.txt 获取基线版本号
```

### 1.2 确认新版本来源

引擎更新通常来自以下渠道之一：
- 官方发布包（zip/tarball）
- Git 仓库拉取（如 `D:\sj-skills\iteration-workflow-engine`）
- 手动补丁（patch 文件）

### 1.3 升级前备份

```bash
# 完整备份当前 engine/ 目录
cp -r engine/ engine.backup.$(date +%Y%m%d)/
# 备份 project/ 下自定义文件
cp -r project/ project.backup.$(date +%Y%m%d)/
```

---

## 二、升级 4 步流程

### Step 1：对比文件清单

列出新旧 `engine/` 目录的文件清单，识别差异：

```bash
# 旧版文件清单
ls engine/ > /tmp/old_files.txt

# 新版文件清单（假设新版在 /tmp/new-engine/）
ls /tmp/new-engine/ > /tmp/new_files.txt

# 差异分析
diff /tmp/old_files.txt /tmp/new_files.txt
```

关注三类差异：
| 类型 | 含义 | 处理 |
|------|------|------|
| 仅旧版有 | 已删除的文件 | 确认是否需要手动删除 |
| 仅新版有 | 新增的文件 | 直接复制到 engine/ |
| 两版都有 | 已修改的文件 | 进入 Step 2 逐文件 diff |

### Step 2：逐文件 diff 识别冲突

对"两版都有"的文件，逐文件执行 diff：

```bash
for file in $(comm -12 /tmp/old_files.txt /tmp/new_files.txt); do
    echo "=== $file ==="
    diff engine/$file /tmp/new-engine/$file || true
done
```

**冲突分类处理**：

| 场景 | 处理方式 |
|------|---------|
| 新版仅格式调整（空格/换行） | 直接采用新版 |
| 新版有新增功能/章节 | 采用新版 |
| 项目曾手动修改过该文件 | ⚠️ 标记为冲突，需手动合并 |
| 该文件在 `project/` 下有覆盖版本 | ✅ 自动受保护，不需要手动处理 |

**受保护文件**（升级时自动跳过，不会被覆盖）：
- 所有 `project/` 目录下的文件（`project.manifest.yaml`、`project/templates/*`、`coding-conventions.md` 等）
- `runtime/` 目录下的状态文件

### Step 3：执行升级

```bash
# 1. 复制新文件（跳过受保护的 project/ 和 runtime/）
cp -r /tmp/new-engine/engine/* engine/

# 2. 删除已废弃的旧文件（根据 Step 1 的"仅旧版有"清单）
# rm engine/obsolete-file.md   # 逐文件确认后删除

# 3. 更新版本记录
echo "v{新版本号}" > project/engine-version.txt
```

**重要**：不要覆盖 `project/` 或 `runtime/` 目录的任何内容。

### Step 4：回归验证

```bash
# 运行门禁回归测试
node scripts/run-gate-tests.mjs

# 预期：全部通过（与升级前一致）
```

若测试失败：
1. 检查是否误覆盖了受保护文件
2. 检查新版引擎是否有破坏性变更（API 不兼容、配置格式变更）
3. 必要时回滚（见 §三）

---

## 三、回滚方案

```bash
# 1. 恢复 engine/ 备份
rm -rf engine/
cp -r engine.backup.YYYYMMDD/ engine/

# 2. 恢复 project/ 备份（如果被误覆盖）
rm -rf project/
cp -r project.backup.YYYYMMDD/ project/

# 3. 恢复版本号
echo "v{旧版本号}" > project/engine-version.txt

# 4. 重新验证
node scripts/run-gate-tests.mjs
```

---

## 四、常见问题

### Q1：引擎升级后门禁行为变化怎么办？

对比新旧 `gate-check.mjs`（如有差异），确认变更是否为预期的修复。运行 `run-gate-tests.mjs` 做回归验证。

### Q2：自定义模板在新版引擎中冲突了？

`project/templates/` 下的模板优先级高于引擎默认模板，升级不会覆盖。若新引擎模板增加了必填字段，需要同步更新项目模板。

### Q3：windows 下 diff 命令不可用？

使用 PowerShell 替代：
```powershell
Compare-Object (Get-Content engine/file.md) (Get-Content /tmp/new-engine/file.md)
```

---

> **变更记录（2026-07-23 S3.3）**：新增引擎升级指南，定义 4 步升级流程、冲突处理规则和回滚方案。
