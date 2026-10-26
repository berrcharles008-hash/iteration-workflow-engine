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
在内存中将 <key> 替换为对应 value
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

> 下表**语法示例**一律写成 `<...>`，不写双花括号 —— 否则会与本协议自身的占位符扫描混淆
> （④ 内容槽类。历史版写成双花括号，导致 A10-b 无法判「未定义」，只能整块 SKIP）。

| 语法示例 | 对应 manifest.yaml 路径 | 说明 |
|-----------|----------------------|------|
| `<project.xxx>` | `project.xxx` | 项目基础信息 |
| `<paths.xxx>` | `paths.xxx` | 目录路径 |
| `<frontend.xxx>` | `tech_stack.frontend.xxx` | 前端技术栈 |
| `<backend.xxx>` | `tech_stack.backend.xxx` | 后端技术栈 |
| `<database.xxx>` | `database.xxx` | 数据库配置 |
| `<sql_conventions.xxx>` | `sql_conventions.xxx` | SQL 编写规范 |
| `<deploy.xxx>` | `deploy.xxx` | 部署目标 |

**①b 路径式实际使用清单（10 项，含点号；`. `→`_` + upper 查展平表）**：

| 占位符 | 展平键 | 用途 |
|--------|--------|------|
| `{{database.type}}` | `DATABASE_TYPE` | 数据库类型 |
| `{{paths.frontend_root}}` | `PATHS_FRONTEND_ROOT` | 前端工程根 |
| `{{sql_conventions.language}}` | `SQL_CONVENTIONS_LANGUAGE` | SQL 方言 |
| `{{sql_conventions.dml_wrapper}}` | `SQL_CONVENTIONS_DML_WRAPPER` | DML 包装语法 |
| `{{deploy.stage1.frontend_target}}` | `DEPLOY_STAGE1_FRONTEND_TARGET` | 前端发布目标 |
| `{{build.frontend.dev_command}}` | `BUILD_FRONTEND_DEV_COMMAND` | 前端 dev 命令 |
| `{{frontend_layers.net.base_class}}` | `FRONTEND_LAYERS_NET_BASE_CLASS` | 前端网络层基类 |
| `{{frontend_layers.page.dir}}` | `FRONTEND_LAYERS_PAGE_DIR` | 前端页面层目录 |
| `{{backend_layers.bll.dir}}` | `BACKEND_LAYERS_BLL_DIR` | 后端 BLL 目录 |
| `{{backend_layers.bll.base_class}}` | `BACKEND_LAYERS_BLL_BASE_CLASS` | 后端 BLL 基类 |

**多项目变量（`additional_projects` 非空时解析）**：

| 占位符 | 含义 | 来源 |
|--------|------|------|
| `{{ALL_FRONTEND_ROOTS}}` | 所有前端项目根目录（主+附加） | ③ 脚本渲染：`[paths.frontend_root]` + 附加中 `type=frontend` 的 root |
| `{{ALL_BACKEND_ROOTS}}` | 所有后端项目根目录（主+附加） | ③ 脚本渲染：`[paths.backend_root]` + 附加中 `type=backend` 的 root |
| `{{ALL_BACKEND_SLNS}}` | 所有后端 .sln 文件路径 | ③ 脚本渲染：`[paths.backend_solution]` + 附加中 `type=backend` 且有 solution 的 |
| `{{HAS_MULTI_PROJECTS}}` | 是否为多项目模式 | ③ 脚本渲染：`paths.additional_projects` 非空且长度>0 |

> **来源列口径（务必与 schema 一致）**：③ 脚本渲染 = **非模板注入变量** —— 由 `scripts/*.py`
> 渲染，或由 Step A 的派生逻辑（`load_runtime_variables`）算出；注入器对 ③ 一律**放行不判错**。
> 旧版来源列写的「运行时派生」口径与 schema 类名冲突，A10-b 判据② 因此无法成立
> （2026-10-25 统一为「③ 脚本渲染」）。

### 2.3 特殊占位符

| 占位符 | 类 | 说明 | 来源 |
|--------|:--:|------|------|
| `{{ITERATIONS_DIR}}` | ①a | 迭代文档根目录 | `paths.docs_iterations` |
| `{{SPECS_DIR}}` | ①a | Spec 活文档目录（冻结态人工规格） | `paths.specs_dir` |
| `{{KB_DIR}}` | ①a | 知识库目录（L1/L2/L3 自动生成 + 人工补充） | `paths.kb_dir` |
| `{{PROJECT_ROOT}}` | ①a | 工作区绝对根目录（交叉审查派发的「相关代码库」入参） | `project.workspace_root` |
| `{{frontend_framework}}` | ①a | 前端框架标识（用作文件名） | `frontend_framework`（manifest 顶级键） |
| `{{ITERATION_ID}}` | ② | 当前迭代编号 | 运行时动态（由 Step B/C 确定） |

> ★ ①a 短名**必须**走别名映射：`flatten_manifest` 产出的是展平名（`paths.kb_dir` → `PATHS_KB_DIR`），
> 与文档里写的短名 `KB_DIR` 不同名。不做映射 ⇒ 占位符 0 处命中、注入恒空且**不报错**
> （2026-10-25 前的实际失效形态）。映射表 SSOT = `scripts/inject-template.py` 的 `ALIAS`。

### 2.4 五类 schema（SSOT = `scripts/inject-template.py`）

> 机器可读版本：`python scripts/inject-template.py --schema-dump`。A10-b 判据② = **本表成员集合
> 与 schema 完全一致**（脚本解析本节表格比对，不靠人工维护两份清单）。
> 数量或成员变化时必须同步改本节，否则 audit-engine 立即报红。

| 类 | 数量 | 成员 | 处理 |
|:--|--:|:--|:--|
| ①a 短名别名 | 5 | `KB_DIR` `SPECS_DIR` `ITERATIONS_DIR` `PROJECT_ROOT` `frontend_framework` | 别名→展平名，**必须解析**（未解析 = ERR） |
| ①b 路径式 | 10 | `database.type` `paths.frontend_root` `sql_conventions.language` `sql_conventions.dml_wrapper` `deploy.stage1.frontend_target` `build.frontend.dev_command` `frontend_layers.net.base_class` `frontend_layers.page.dir` `backend_layers.bll.dir` `backend_layers.bll.base_class` | `.`→`_` + upper 查展平表，**必须解析**（未解析 = ERR） |
| ② 运行时 | 5 | `ITERATION_ID` `DOC_01_REQUIREMENT` `DOC_02_REVIEW` `DOC_03_TECHNICAL` `DOC_04_TASK_LIST` | 允许保留（Step B/C 确定） |
| ③ 脚本渲染 | 23 | `IDE_DIR` `ALL_FRONTEND_ROOTS` `ALL_BACKEND_ROOTS` `ALL_BACKEND_SLNS` `HAS_MULTI_PROJECTS` `GENERATED_AT` `MODULE_NAME` `MODULE_FILE_MATRIX` `ROOT_DIRS` `FRONTEND_MODULE_ROWS` `FRONTEND_FILE_ROWS` `FRONTEND_COMPONENT_ROWS` `BACKEND_MODULE_ROWS` `BACKEND_FILE_ROWS` `BACKEND_CLASS_ROWS` `BACKEND_METHOD_ROWS` `TARGET_DIR` `TARGET_FILE` `TARGET_PATH` `INTERFACE_FILE` `MENU_FILE` `ROUTER_FILE` `WEBAPI_FILE` | 允许保留（脚本/派生逻辑渲染） |
| ④ 内容槽 | 8 | `key` `<project.xxx>` `<paths.xxx>` `<frontend.xxx>` `<backend.xxx>` `<database.xxx>` `<sql_conventions.xxx>` `<deploy.xxx>` | 文档示例，**必须写成 `<...>`** |
| **合计** | **51** | — | — |

> **④ 为何单列白名单**：`engine/` 里还有大量中文占位符（如 `<方案文档路径>`）供人读，不属于本 schema。
> 占位符正则只匹配 ASCII 标识符，中文天然不参与判定；④ 白名单的作用是让
> `scan-placeholders.py --verify` 能区分「已归类但待改写」与「真正未归类」，避免把语法示例当漏注册。
> ★ 2026-10-25 已完成改写：`key` 类 ×4 + `*.xxx` 类 ×7 全部改为 `<...>`，engine 内 ④ 类占位符归零。


---

## 二·五、注入器 CLI 与写盘前失败（2026-10-25 上线）

| 命令 | 语义 | 退出码 |
|:--|:--|:--|
| `inject-template.py`（默认） | 注入 + **残留判定**；有 ERR 则不写盘 | 0 / 1 |
| `--dry-run` | 只打印替换明细，**不判定、不写盘** | 0 |
| `--check` | 只判定不写盘 | 0 / 1 |
| `--check --compare F` | 判定 + 与 F 逐字节比较（`newline=''`；A10-e 用）。**`--compare` 隐含 `--check`** | 0 / 1 |
| `--force` | 跳过判定强写（应急逃生口）。残留仍会打印，但**不返回非 0**；真正的失败只来自硬错误（模板/清单缺失） | 0 / 1 |
| `--schema-dump` | 输出五类 schema + `placeholder_re`（稳定排序；A10-b 用） | 0 |
| `--check --dry-run` | 互斥组合，显式报错 | 2 |

**残留判定口径**：①a / ①b 未解析、不属于任何一类、或存在**未识别的 `{{` 前导**
（含空格 / 中文 / 多余花括号）⇒ **ERR**（exit 1 且**不写盘**）；②③④ ⇒ 放行。
**manifest 值为空串 ⇒ 等同缺键**（与 `project.manifest.yaml` 自述口径、`gate/exempt-tables.mjs` 一致）：
空串若当有效值，`specs_dir: {{SPECS_DIR}}/` 会注入成 `specs_dir: /`，而首次安装正是拿全空的
`manifest.yaml.template` 走同一条路 ⇒ exit 0、零告警地产出腐化产物。**这是静默腐化，不是「配了空值」。**
**为什么必须在写盘前**：历史顺序是「先写盘、再由安装器扫残留」，误跑一次就把 `SKILL.md` 回退成旧模板
（失效案例 2/3）。安装器侧同步改造：无 Python 不再「复制模板兜底」；注入与最终校验一律
调本脚本（`--check --compare`）而非自带正则，任何一步失败即 `exit 1`（ps1/sh 同口径）。

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
    variables["KB_DIR"]         = manifest.paths.kb_dir
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

    // 多项目变量（附加项目列表存在时解析）
    additional = manifest.paths.additional_projects || []
    variables["HAS_MULTI_PROJECTS"]   = additional.length > 0
    variables["ALL_FRONTEND_ROOTS"]   = [manifest.paths.frontend_root] +
        additional.filter(p => p.type == "frontend").map(p => p.root)
    variables["ALL_BACKEND_ROOTS"]    = [manifest.paths.backend_root] +
        additional.filter(p => p.type == "backend").map(p => p.root)
    variables["ALL_BACKEND_SLNS"]     = [manifest.paths.backend_solution] +
        additional.filter(p => p.type == "backend" && p.solution).map(p => p.solution)
    
    return variables

function resolve_placeholders(text, variables):
    for each <key> in text:
        mapped = ALIAS[<key>] ?? <key>.replace(".","_").upper()   // ①a 别名 → ①b 展平
        if mapped in variables:
            replace <key> with variables[mapped]
        else:
            keep <key> as-is   // 残留判定统一在写盘前做，不在这里抛错
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
      name: "<YOUR_DB_NAME>"
      mcp_server: "<YOUR_MCP_SERVER>"
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
4. engine 内不含项目值（A10-a 机检）；新增项目取值须在 manifest 加键，不改 engine 文件

### 需要替换的项目特定文件

| 文件 | 用途 | 替换方式 |
|------|------|---------|
| `project/context-conventions.md` | 项目上下文约定（spec 文件清单 + 后端类型约定） | 按新项目约定重写，或删除后在 engine 文件中移除引用 |
| `project/code-review-rules.md` | 代码审查规则矩阵 | 按新项目技术栈重写 |
| `project/agent-prompt-examples.md` | Agent prompt 示例 | 按新项目分层模式重写 |

> **注意**：`engine/workflow-engine.md` 中引用 `context-conventions.md` 的地方（Step 1.5 / Step 4.7）是**引用性**的，不是硬编码。如果新项目没有后端类型约定（如纯前端项目），可以删除 `context-conventions.md` 中的二、三节，并在 workflow-engine.md 中将对应引用改为"无后端类型约定"。
