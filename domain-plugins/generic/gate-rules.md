# Generic Gate Rules

> 通用项目门禁规则（默认加载，零额外规则）。

## 默认规则

本项目无额外技术栈约束。门禁仅检查迭代阶段状态：

- **阶段 04**：放行所有文件写入
- **阶段 01-03**：仅允许迭代文档目录写入
- **其他阶段**：阻止所有业务代码写入

## 自定义

如需添加企业特定规则（如 Oracle 表名规范、SVN 工作流约定等），
请复制 `domain-plugins/enterprise-legacy/gate-rules.md` 作为参考模板，
并在 `project/project.manifest.yaml` 中引用你的规则文件。

## 逃生口

- `GATE_BYPASS=1` 环境变量
- `hooks/.gate-bypass` 标记文件

> 此文件默认加载。无规则可安全删除，引擎会自动退化为纯阶段门禁。
