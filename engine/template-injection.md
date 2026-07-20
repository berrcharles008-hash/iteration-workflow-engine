# 变量注入协议

> **目的**：定义 Agent 如何将 `project/project.manifest.yaml` 中的运行时变量注入到 engine/ 和 project/ 文件的 `{{占位符}}` 中。
> **核心原则**：Agent 在内存中替换，不修改磁盘上的源文件。

---

## 一、注入时机

```
SKILL.md Step A（加载 manifest.yaml）
    ↓
构建运行时变量表（Key-Value Map）
    ↓
Step B / Step C / Step D（读取 engine/ 或 project/ 文件时）
    ↓
在内存中将 {{key}} 替换为对应 value
    ↓
后续所有操作使用替换后的内容
```

**关键约束**：
- 注入在 Step A 完成后、任何 engine/ 文件被读取前执行
- 注入仅影响 Agent 的**运行时理解**，不修改任何源文件

---

## 二、变量解析规则

### 2.1 占位符格式

```
{{路径.层级.字段}}
```

示例：
- `{{paths.frontend_root}}` → 解析为 manifest.yaml 中 `paths.frontend_root` 的值
- `{{database.type}}` → 解析为 `database.type`
- `{{deploy.stage1.frontend_target}}` → 解析为 `deploy.stage1.frontend_target`

### 2.2 解析作用域

| 占位符前缀 | 对应 manifest.yaml 路径 | 说明 |
|-----------|----------------------|------|
| `{{project.xxx}}` | `project.xxx` | 项目基础信息 |
| `{{paths.xxx}}` | `paths.xxx` | 目录路径 |
| `{{frontend.xxx}}` | `tech_stack.frontend.xxx` | 前端技术栈 |
| `{{backend.xxx}}` | `tech_stack.backend.xxx` | 后端技术栈 |
| `{{database.xxx}}` | `database.xxx` | 数据库配置 |
| `{{sql_conventions.xxx}}` | `sql_conventions.xxx` | SQL 编写规范 |
| `{{deploy.xxx}}` | `deploy.xxx` | 部署目标 |

### 2.3 特殊占位符

| 占位符 | 说明 | 来源 |
|--------|------|------|
| `{{ITERATIONS_DIR}}` | 迭代文档根目录 | `paths.docs_iterations` |
| `{{SPECS_DIR}}` | Spec 活文档目录 | `paths.specs_dir` |
| `{{ITERATION_ID}}` | 当前迭代编号 | 运行时动态（由 Step B/C 确定） |

---

## 三、注入优先级

```
manifest.yaml 显式值  >  engine/ 文件内默认值  >  Agent 硬编码兜底值（仅在 manifest 缺失字段时）
```

- 若 manifest.yaml 中某字段不存在，Agent 使用 engine/ 文件中的默认值（如有）
- 若 engine/ 文件也无默认值，Agent 提示用户补充 manifest.yaml 配置

---

## 四、Agent 执行伪代码

```
function load_runtime_variables():
    manifest = read_yaml("project/project.manifest.yaml")
    
    variables = {}
    // 路径变量（高频使用，直接平铺）
    variables["ITERATIONS_DIR"] = manifest.paths.docs_iterations
    variables["SPECS_DIR"]      = manifest.paths.specs_dir
    variables["FRONTEND_ROOT"]  = manifest.paths.frontend_root
    variables["BACKEND_SLN"]    = manifest.paths.backend_solution
    
    // 技术栈变量
    variables["frontend.package_manager"] = manifest.tech_stack.frontend.package_manager
    variables["frontend.build_tool"]      = manifest.tech_stack.frontend.build_tool
    variables["backend.build_tool"]       = manifest.tech_stack.backend.build_tool
    
    // 数据库变量
    variables["database.type"]    = manifest.database.type
    variables["database.connections.cis.name"] = manifest.database.connections.cis.name
    // ... 其他按需解析
    
    return variables

function resolve_placeholders(text, variables):
    for each {{key}} in text:
        if key in variables:
            replace {{key}} with variables[key]
        else:
            keep {{key}} as-is (未解析的占位符保留，方便人类发现缺失配置)
    return text
```

---

## 五、注入示例

### manifest.yaml 片段
```yaml
database:
  type: "Oracle"
  connections:
    cis:
      name: "sj_cis"
      mcp_server: "sj-cis-db"
sql_conventions:
  language: "PL/SQL"
  dml_wrapper: "EXECUTE IMMEDIATE"
```

### engine 文件原文
```
| **数据库兼容** | {{sql_conventions.language}} + q-quote 语法 + {{sql_conventions.dml_wrapper}} |
```

### Agent 运行时理解（内存替换后）
```
| **数据库兼容** | PL/SQL + q-quote 语法 + EXECUTE IMMEDIATE |
```

> **不修改源文件**：engine/ 文件中保持 `{{占位符}}` 原样，仅在 Agent 内存中替换。
>
> **注意**：以上为 Oracle 项目的示例。不同数据库项目的 `sql_conventions` 值不同（如 PostgreSQL 用 `DO $$ ... $$`，MySQL 用存储过程），`project.manifest.yaml` 中的值决定注入结果。

---

## 六、跨项目迁移指南

将 Skill 迁移到新项目时，只需：
1. 复制 `engine/` 和 `project/` 目录（占位符原样保留）
2. 修改 `project/project.manifest.yaml` 中的项目特定值
3. 删除 `project/` 下的旧项目特有文件（如 `agent-prompt-examples.md` 中的项目示例）
4. 无需修改 engine/ 中的任何一行代码

### 需要替换的项目特定文件

| 文件 | 用途 | 替换方式 |
|------|------|---------|
| `project/context-conventions.md` | 项目上下文约定（spec 文件清单 + 后端类型约定） | 按新项目约定重写，或删除后在 engine 文件中移除引用 |
| `project/code-review-rules.md` | 代码审查规则矩阵 | 按新项目技术栈重写 |
| `project/agent-prompt-examples.md` | Agent prompt 示例 | 按新项目分层模式重写 |

> **注意**：`engine/workflow-engine.md` 中引用 `context-conventions.md` 的地方（Step 1.5 / Step 4.7）是**引用性**的，不是硬编码。如果新项目没有后端类型约定（如纯前端项目），可以删除 `context-conventions.md` 中的二、三节，并在 workflow-engine.md 中将对应引用改为"无后端类型约定"。
