# Generic Adapter — 手动安装指引

> 本文档面向无法自动检测 IDE 的场景（如自定义开发环境、轻量编辑器）。
> 如果你使用的是 Claude Code / CodeBuddy / Cursor / Codex，请运行 `install.sh` 或 `install.ps1` 自动安装。

## 适用场景

- 使用不支持插件的文本编辑器（Vim/Emacs/Notepad 等）
- 自行实现 IDE 适配层
- 仅需引擎核心逻辑而不需要 IDE 集成

## 手动安装步骤

### 1. 复制核心引擎到目标项目

```bash
# 在你的目标项目中
mkdir -p .skills/iteration-workflow
cp -r engine/             .skills/iteration-workflow/engine/
cp -r project/            .skills/iteration-workflow/project/
cp -r domain-plugins/     .skills/iteration-workflow/domain-plugins/
cp -r scripts/            .skills/iteration-workflow/scripts/
cp SKILL.template.md       .skills/iteration-workflow/
cp README.md LICENSE CONTRIBUTING.md .skills/iteration-workflow/
```

### 2. 配置项目清单

编辑 `.skills/iteration-workflow/project/project.manifest.yaml`：

```yaml
project:
  name: "你的项目名"
  platform: "web"  # 可选：web / mobile / desktop / cli
```

### 3. 生成 SKILL.md

```bash
python scripts/inject-template.py --manifest .skills/iteration-workflow/project/project.manifest.yaml
```

### 4. 验证安装

```bash
node scripts/run-gate-tests.mjs --quick
```

## 注意事项

- Generic 模式使用 **prompt 层门禁**（无 Hook 硬拦截），门禁仅在 Agent 加载 Skill 时生效
- 重要修改前建议手动确认 `ACTIVE` 文件状态
- 如需 Hook 硬拦截，推荐迁移到 Claude Code CLI / CodeBuddy IDE

---

> **Phase C 完善**：本文由 `install.sh --ide generic` 自动复制到目标目录。
