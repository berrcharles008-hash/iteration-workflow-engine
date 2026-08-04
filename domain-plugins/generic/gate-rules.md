# Generic Domain Rules

> 默认空规则集 — 零额外规则，适用于通用软件项目。

## 说明

此文件为 `generic` 领域插件的门禁规则占位。

当你安装 iteration-workflow 引擎后，引擎会默认加载此规则集。
通用项目无需额外规则约束，因此本文件保持为空。

## 自定义规则

如需添加项目特定的门禁规则（如特定技术栈铁律、命名规范、禁止 API 等），
请创建新的领域插件目录（如 `domain-plugins/my-project/`）
并在 `project.manifest.yaml` 中指定：

```yaml
domain_plugin: "my-project"
```

自定义规则格式请参考：`domain-plugins/enterprise-legacy/gate-rules.md`（Phase D 实现）

---

> **Phase D**：`enterprise-legacy/gate-rules.md` 将从 MEMORY.md 抽离的技术栈铁律（Oracle全大写/.csproj编译/SVN工作流等）迁移至此。
