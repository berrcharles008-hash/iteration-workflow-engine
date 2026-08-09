# Enterprise Legacy Gate Rules

> 企业技术栈铁律（脱敏版）。
> 适用于有遗留系统约束的团队，如 Oracle + .NET Framework + SVN 场景。
> 本文不含任何企业内部 IP、密码、服务器地址、项目名、人员姓名。

## 数据库规范

### 表名/列名全大写

所有 ORM Entity 属性标注和手写 SQL 中，表名和列名必须全大写。

```
正确: [Table("PATIENT_INFO")], FROM "PATIENT_INFO"
错误: [Table("PatientInfo")], FROM "patient_info"
```

- ORM (Dos.ORM / Entity Framework) 的 `[Table]` 和 `[Field]` 注解：表名/列名全大写
- 手写 SQL 的 FROM / JOIN / DELETE / ALTER 等：表名全大写
- 存储过程名称：全大写

### 列名不加引号

建表语句中列名不加双引号（部分 ORM 会自动加引号导致 ORA-00904 错误）。

## 版本控制规范

### SVN 工作流

- 提交前必须执行 `svn update` 获取最新代码
- 禁止 force push（SVN 不支持，但禁止删除远程历史）
- SVN 中文路径（亚洲字符）在 CI/脚本中须用 `--xml` 参数避免编码问题
- Checkout 到中文路径需用 `EscapeUriString` 编码 URL

### Git 安全

- 禁止 `git sparse-checkout disable`（不可逆操作）
- 禁止 force push 到 main/master
- 提交信息遵循语义化格式：`[模块] 变更描述`

## 代码审查清单

在 Code Review 中必须检查：

- [ ] 数据库表名/列名全大写
- [ ] SQL 语句 FROM/JOIN 表名全大写
- [ ] 无硬编码 IP 地址/密码
- [ ] 存储过程变更保留 `.bak` 备份
- [ ] 新增文件已加入编译单元注册（`.csproj` / `tsconfig`）
- [ ] SVN/Git 提交不包含二进制产物

## 逃生口

- `GATE_BYPASS=1` 环境变量
- `hooks/.gate-bypass` 标记文件

> **脱敏声明**：本文由企业内部规范脱敏生成，不包含任何敏感信息。
> 如需启用，请在 `project/project.manifest.yaml` 中将 `domain_plugin` 设为 `enterprise-legacy`。
