# iteration-workflow 分层复用架构设计

> 目标：将通用流程引擎与项目特定配置分离，使得同一个 skill 能跨项目复用，各项目仅需维护自己的"配置文件"。

## ★ 当前状态（截至 2026-07-08）

**架构分离已完成**：Skill 引擎已从 SKILL.md 拆分，`engine/` 下形成多文件架构（workflow-engine、complexity-scoring、gate-protocol、state-protocol、startup-protocol、cross-review-protocol、delta-marking、team-agent-strategy、lessons-learned 等 12 个引擎文件 + 7 个 templates）。SKILL.md 已改造为薄入口。

**层2（项目适配层）** 已独立为 `project/` 目录（manifest、code-review-rules、deploy-config、agent-prompt-examples 等）。

**待完成**：
- SKILL.md「关键原则」可独立为 `engine/key-principles.md`
- `references/` 中旧版文件与新架构并存，待清理
- 跨项目复用测试（Java+Vue3 等）未执行

---

## 一、现状诊断

### 1.1 当前文件结构

```
.codebuddy/skills/iteration-workflow/
├── SKILL.md                              ← 主文件（6阶段流程 + 硬编码的三佳路径）
└── references/
    ├── complexity-adaptive-strategy.md   ← 复杂度评估算法
    ├── phase-01-需求文档模板.md           ← 通用模板
    ├── phase-02-评审记录模板.md           ← 通用模板
    ├── phase-03-技术方案模板.md           ← 通用模板
    ├── phase-04-agent-prompts模板.md      ← Agent prompt 模板
    ├── phase-04-开发任务清单模板.md       ← 通用模板
    ├── phase-04-代码审查规则.md           ← 代码审查规则矩阵
    ├── phase-05-测试报告模板.md           ← 通用模板
    ├── phase-05-自动测试与执行.md         ← 测试策略
    ├── phase-06-上线记录模板.md           ← 通用模板
    └── phase-06-deploy-reference.md       ← 部署流程
```

### 1.2 通用 vs 项目特定的分布现状

| 文件 | 通用 | 三佳特定 | 问题 |
|------|:----:|:-------:|------|
| SKILL.md | ~60% | ~40% | 6阶段框架通用，但 Step 4.5/4.6/Stage6 硬编码了三佳项目路径 |
| complexity-adaptive-strategy.md | 100% | 0% | ✅ 完全通用 |
| phase-01~06 文档模板（6个） | 100% | 0% | ✅ 完全通用 |
| phase-04-agent-prompts模板.md | ~70% | ~30% | 五段结构通用，示例代码是三佳的 |
| phase-04-代码审查规则.md | ~10% | ~90% | ❌ 规则深度绑定 Dos.ORM + SJMgrBase + Ajax + Vue2+ElementUI |
| phase-05-自动测试与执行.md | ~70% | ~30% | 用例生成算法通用，但执行器假设 .vue+NPM 前端 |
| phase-06-deploy-reference.md | 0% | 100% | ❌ FTP/内网IP/MSBuild 全是三佳环境 |

---

## 二、目标架构：三层分离模型

```
┌─────────────────────────────────────────────────────────────────┐
│  层0（Skill 元定义）: SKILL.md                                  │
│  - skill name / description / 触发方式                          │
│  - 加载规则：先加载层1，再加载层2，层2优先覆盖层1               │
│  - 简单需求下直接硬匹配，不进入复杂流程                         │
└─────────────────────────────────────────────────────────────────┘
        │
        ├── 加载 ──→ 层1（通用流程引擎）
        │            ├── workflow-engine.md         七阶段流水线引擎
        │            ├── complexity-scoring.md      复杂度评估算法+映射表
        │            ├── delta-marking.md           ADDED/MODIFIED/REMOVED 标记体系
        │            ├── team-agent-strategy.md     四维并行决策算法
        │            ├── naming-conflict-check.md   命名冲突预检规则
        │            ├── lessons-learned.md         自进化复盘机制
        │            └── templates/（文档模板）      阶段1-6标准模板
        │
        └── 叠加 ──→ 层2（项目适配层） —— 每个项目提供自己的
                     ├── project.manifest.yaml      项目元信息（名称、路径、技术栈）
                     ├── code-review-rules.yaml     代码审查规则矩阵（按技术栈定制）
                     ├── deploy-config.yaml         部署配置（构建命令、上传目标）
                     ├── agent-prompt-examples.md   Agent prompt 示例（用本项目代码）
                     ├── build-verify.yaml          构建验证命令（前端/后端）
                     └── project-structure.yaml     项目目录结构约定（Entity/BLL/Web位置）
```

**核心原则**：
- **层1 定义"做什么"和"怎么做"**（流程、算法、模板、规则框架）—— 跨项目通用，不需要改动
- **层2 填充"用什么"和"在哪"**（具体类名、方法名、路径、命令）—— 每个项目独立维护
- **运行时，层2 覆盖层1 的同名配置**，实现项目个性化而不修改引擎

---

## 三、层1：通用流程引擎（详细设计）

### 3.1 workflow-engine.md — 七阶段流水线引擎

> 从当前 SKILL.md 中剥离所有项目特定内容后的纯流程定义。

**内容**（与当前 SKILL.md 90% 相同，但做如下修改）：

| 当前位置 | 修改方式 | 说明 |
|---------|---------|------|
| Section "复杂度分级" 开篇 | → 移到 `complexity-scoring.md`，此处只引用 | 复杂度算法是通用的，评分公式固定 |
| Step 4.5 ".csproj 注册" | → 移除硬编码路径，改为从 `project-structure.yaml` 读取 | "后端 .csproj 注册" 改为 "编译单元注册" |
| Step 4.6 "MSBuild 编译" | → 改为通用步骤 "构建验证"，具体命令从 `build-verify.yaml` 读取 | 框架只定义"必须编译验证"，不定义用什么工具 |
| Step "部署阶段" | → 改为从 `deploy-config.yaml` 读取部署步骤 | 框架只定义"部署分两阶段"，不定义 FTTP 地址 |
| 所有绝对路径 | → 替换为 `{{PROJECT_ROOT}}` / `{{FRONTEND_DIR}}` 等占位符 | 运行时从 `project.manifest.yaml` 注入 |
| 关键原则 #6-7 | → 通用化为 "编译单元注册"+"构建验证"，不绑定 .csproj 和 MSBuild |

**从 SKILL.md 中移除的内容**（下沉到层2）：
- Step 4.5 中 `Inf/SJ.BLL.ET.xxxx.Inf.csproj` 等具体路径 → `project-structure.yaml`
- Step 4.6 中 `back-end/.../SJ.ET...Web.sln` 等具体路径 → `project-structure.yaml`  
- Stage 6 中 `front-end/pre_examination_triage_upgrade/` → `deploy-config.yaml`
- Stage 6 中 `192.168.195.71` FTP 信息 → `deploy-config.yaml`

### 3.2 complexity-scoring.md — 复杂度评估

> 从当前 `references/complexity-adaptive-strategy.md` 直接提升为层1

**现状**：已完全通用，无需改造。
- 7因素评分算法 → 通用
- 三级映射（🟢0-1/🟡2-3/🔴4+）→ 通用
- 各等级下阶段行为差异 → 通用

### 3.3 delta-marking.md — Delta 标记体系

> 从当前 SKILL.md "Delta 标记体系" 章节独立出来

**内容**：
- ADDED / MODIFIED-追加 / MODIFIED-修改 / MODIFIED-替换 / REMOVED 定义
- 每种标记对并行策略的影响
- 变更范围表格格式模板

**现状**：已完全通用，从 SKILL.md 直接提取即可。

### 3.4 team-agent-strategy.md — 四维并行决策

> 从当前 `phase-04-agent-prompts模板.md` 第一章独立出来

**内容**：
- 维度一：依赖类型表（导入/接口/探索/冲突）
- 维度二：操作类型风险表
- 维度三：方案完整度对并行的决定
- 维度四：文件数量阈值表
- 决策输出格式模板
- Batch 分组算法

**现状**：决策算法本身通用，不需要改动。与具体技术栈无关。

### 3.5 naming-conflict-check.md — 命名冲突预检

> 从当前 SKILL.md "命名冲突预检" 章节独立出来

**内容**：
- 检查项清单（方法名/类名/API端点/路由）
- 搜索命令模板
- 检查规则（同名→改名，相似签名→改名）

**需要泛化**：当前 `search_content` 示例用了三佳的文件名，改为使用模板变量。

### 3.6 templates/ — 文档模板

> 从当前 `references/phase-0X-*模板.md` 提升

6个模板全部通用，无需改动：
- `templates/phase-01-需求记录.md`
- `templates/phase-02-需求评审.md`
- `templates/phase-03-技术方案.md`
- `templates/phase-04-开发任务清单.md`
- `templates/phase-05-测试验证报告.md`
- `templates/phase-06-发布上线记录.md`

### 3.7 lessons-learned.md — 自进化机制

> 从当前 SKILL.md "自动复盘与进化机制" 章节独立出来

**内容**：复盘触发时机表、五步复盘流程、日志模板。完全通用。

---

## 四、层2：项目适配层（详细设计）

层2 是每个项目唯一的"配置区"——项目接入 `iteration-workflow` skill 时，只需创建这一层文件即可。

### 4.1 project.manifest.yaml

项目元信息，运行时所有占位符从此文件注入。

```yaml
# 项目基础信息
project:
  name: "三佳预检分诊管理系统"
  short_name: "PreExaminationTriage"
  workspace_root: "e:/SJYL/三佳工程/master-pre/0002预检分诊管理系统/temp-branch"

# 技术栈声明
tech_stack:
  frontend:
    framework: "Vue2"
    language: "TypeScript"
    ui_library: "ElementUI"
    build_tool: "webpack"          # npm run build 使用的工具
    package_manager: "npm"
    test_framework: "N/A"          # 如 jest, vitest
    e2e_framework: "playwright"    # 如 playwright, cypress
  backend:
    language: "C#"
    framework: ".NET Framework 4.x"
    orm: "Dos.ORM"
    build_tool: "MSBuild"
    test_framework: "NUnit"
    solution_pattern: "*.Web.sln"  # 解决方案文件匹配模式

# 目录结构约定
paths:
  frontend_root: "front-end/pre_examination_triage_upgrade"
  frontend_src: "front-end/pre_examination_triage_upgrade/src"
  frontend_dist: "front-end/pre_examination_triage_upgrade/dist"
  backend_root: "back-end/PreExaminationTriage"
  backend_solution: "back-end/PreExaminationTriage/SJ.ET.PreExaminationTriage.Web.sln"
  backend_build_output: "back-end/PreExaminationTriage/Web.Demo/bin/Release"
  docs_iterations: "docs/iterations"
  specs_dir: ".codebuddy/specs"

# 分层映射（前端）
frontend_layers:
  net:
    dir: "src/net/et"
    base_class: "api"
    http_get: "Ajax.Get"
    http_post: "Ajax.Post"
    super_param_source: "WebApi Route"
  bll:
    dir: "src/bll/et"
    base_class: "BaseMgr"
  domain:
    dir: "src/domain"
  page:
    dir: "src/pages"
    file_pattern: "*.vue"
    companion_file_pattern: "*.ts"
  route:
    files:
      - "src/router.ts"
      - "src/parameters_settings.ts"

# 分层映射（后端）
backend_layers:
  entity:
    dir: "Inf/Entity"
    base_class: "Dos.ORM.Entity"
    key_attributes: ["Table", "Field", "DataMember"]
  interface:
    dir: "Inf/IMgr"
    naming: "I{Name}Mgr"
    namespace: "SJ.BLL.ET"
    first_param: "BusinessContext context"
  bll:
    dir: "BLL"
    base_class: "SJMgrBase"
    key_methods: ["DoValidate", "DoBefore", "DoAfter"]
    constructor_params: ["SubSysId", "CnName", "DbSession"]
    id_generation: "Guid.NewGuid().ToString()"
    soft_delete_field: "DeletedMark"
    soft_delete_value: 0
  webapi:
    dir: "Web"
    attributes: ["WebApi", "WebApiMethod"]
    echo_method: "Echo"
    context_access: "SJC.Get<IGlobalVar>().GetBusinessContext()"
    mgr_access: "SJC.Get<I{EntityName}Mgr>()"

# 编译单元注册（原 .csproj 注册步骤）
compilation_units:
  type: "csproj"                                     # csproj | pom.xml | pyproject.toml
  registration_format: "xml"                         # xml | text | json
  registration_entry: '<Compile Include="{relative_path}" />'  # 新文件的注册模板
  mappings:                                           # 文件目录 → 编译单元
    - source_dir: "Inf"
      unit_file: "Inf/SJ.BLL.ET.PreExaminationTriage.Inf.csproj"
    - source_dir: "BLL"
      unit_file: "BLL/SJ.BLL.ET.PreExaminationTriage.csproj"
    - source_dir: "Web"
      unit_file: "Web/SJ.Web.ET.PreExaminationTriage.Web.csproj"

# 依赖注入/服务注册（可选 — 其他项目可能需要）
di_registration:
  type: "none"                                       # none | attribute | manual | spring_bean
  # 三佳项目使用特性 [Module]/[ContainerRegType] 自动注册，无需手动步骤
```

### 4.2 code-review-rules.yaml

将当前 `phase-04-代码审查规则.md` 中的规则矩阵声明式化。

```yaml
# 代码审查规则矩阵
# 每条规则格式: {id, description, trigger, operation_types, complexity_levels, severity}

rules:
  # === 后端 Entity 层 ===
  - id: "E1.1"
    trigger: "backend_layers.entity.dir 下有文件变更"
    operation_types: ["新建"]
    complexity: ["🟢", "🟡", "🔴"]
    severity: "🔴阻塞"
    description: |
      类是否继承 {{backend_layers.entity.base_class}}
    check_method: "read_file + search_content"
    category: "后端"
    layer: "Entity"

  - id: "E1.2"
    trigger: "backend_layers.entity.dir 下有文件变更"
    operation_types: ["新建"]
    complexity: ["🟢", "🟡", "🔴"]
    severity: "🔴阻塞"
    description: |
      [Table("表名")] 特性是否存在，表名是否正确
    check_method: "read_file"
    category: "后端"
    layer: "Entity"

  - id: "E1.3"
    trigger: "backend_layers.entity.dir 下有文件变更"
    operation_types: ["新建"]
    complexity: ["🟢", "🟡", "🔴"]
    severity: "🟡高"
    description: |
      属性 setter 是否使用 OnPropertyValueChange 模式
    check_method: "read_file"
    category: "后端"
    layer: "Entity"

  # === 后端 BLL 层 ===
  - id: "E3.1"
    trigger: "backend_layers.bll.dir 下有文件变更"
    operation_types: ["新建"]
    complexity: ["🟢", "🟡", "🔴"]
    severity: "🔴阻塞"
    description: |
      是否继承 {{backend_layers.bll.base_class}} 并实现对应接口
    check_method: "read_file + search_content"
    category: "后端"
    layer: "BLL"

  - id: "E3.4"
    trigger: "backend_layers.bll.dir 下有文件变更"
    operation_types: ["新建", "追加"]
    complexity: ["🟢", "🟡", "🔴"]
    severity: "🔴阻塞"
    description: |
      跨表/非本项目表查询是否使用 FromSql + AddInParameter（参数化），非字符串拼接
    check_method: "search_content 搜索 SQL 拼接模式"
    category: "后端"
    layer: "BLL"

  # ... 更多规则（将当前 .md 文件中的规则矩阵逐条迁移为 YAML）

  # === 前端 Net 层 ===
  - id: "F1.1"
    trigger: "frontend_layers.net.dir 下有文件变更"
    operation_types: ["新建"]
    complexity: ["🟢", "🟡", "🔴"]
    severity: "🔴阻塞"
    description: |
      是否继承 {{frontend_layers.net.base_class}}
    check_method: "read_file"
    category: "前端"
    layer: "Net"

  - id: "F1.2"
    trigger: "frontend_layers.net.dir 下有文件变更"
    operation_types: ["新建"]
    complexity: ["🟢", "🟡", "🔴"]
    severity: "🔴阻塞"
    description: |
      super() 参数是否与后端 WebApi Route 一致
    check_method: "跨层对比: 前端 super() vs 后端 [WebApi(\"Route\")]"
    category: "前端"
    layer: "Net"

  # === 跨层一致性（仅🔴复杂级） ===
  - id: "C1"
    trigger: "前端 Net + 后端 Web 同时有变更"
    operation_types: ["新建"]
    complexity: ["🔴"]
    severity: "🔴阻塞"
    description: |
      前端 Net /MethodName + 后端 Web [WebApiMethod("MethodName")] 方法名是否完全一致
    check_method: "跨层对比"
    category: "跨层"
    layer: "Net-Web"

  # ... 更多规则
```

**设计要点**：
- 规则描述中使用 `{{变量}}` 引用 `project.manifest.yaml` 中的值
- 运行时，引擎读取 `code-review-rules.yaml` + `project.manifest.yaml`，动态组装检查逻辑
- 每条规则标记 `complexity` 决定何时激活，`operation_types` 决定对哪种操作生效
- 新项目接入时，只需要按自己的技术栈重写这个 YAML

### 4.3 deploy-config.yaml

```yaml
# 部署配置

environments:
  - name: "开发测试服务器"
    stage: "stage1_auto"
    steps:
      - id: "build_frontend"
        description: "编译前端"
        commands:
          - working_dir: "{{paths.frontend_root}}"
            run: "npm install --legacy-peer-deps"
            condition: "package.json 有变更"
          - working_dir: "{{paths.frontend_root}}"
            run: "npm run build"
        output_dir: "{{paths.frontend_dist}}"

      - id: "build_backend"
        description: "编译后端"
        commands:
          - run: "msbuild {{paths.backend_solution}} /p:Configuration=Release /t:Build /v:minimal"
        output_dir: "{{paths.backend_build_output}}"
        artifact_pattern: "SJ.*.ET*.dll"

      - id: "upload_frontend"
        description: "上传前端到 FTP"
        type: "ftp"
        host: "192.168.195.71"
        port: 21
        user: "anonymous"
        password: ""
        source: "{{paths.frontend_dist}}/"
        target: "/sj_web_app/sj_web/"

      - id: "upload_backend"
        description: "上传后端 DLL 到 FTP"
        type: "ftp"
        host: "192.168.195.71"
        port: 21
        user: "anonymous"
        password: ""
        source: "{{temp_dir}}/"
        target: "/sj_web_app/sj_web/bin/"

    fallback: |
      若 npm registry 不可达（sjsrv:9091），列出命令清单供用户在内网环境执行

  - name: "客户生产服务器"
    stage: "stage2_manual"
    note: "暂手工制作，后续补充"
```

### 4.4 build-verify.yaml

```yaml
# 构建验证配置（原 Step 4.6 + phase-05 第七章）

frontend:
  check_new_deps:
    method: "scan_imports"
    file_patterns: ["*.ts", "*.vue"]
  install_command: "npm install --legacy-peer-deps"
  build_command: "npm run build"
  dev_command: "npm run dev"
  fallback: "read_lints"           # npm registry 不可达时的降级方案
  success_indicator: "0 error"     # 如何判断成功

backend:
  build_tool: "MSBuild"
  solution_pattern: "*.Web.sln"    # 查找解决方案文件的 glob
  build_command: 'msbuild "{sln}" /p:Configuration=Debug /t:Build /v:minimal'
  artifact_pattern: "SJ.*.ET*.dll"
  success_indicator: "0 error"
  max_retries: 3
  common_errors:
    - "命名空间错误: using 引用与实际命名空间不一致"
    - "csproj 注册遗漏: 新增文件未 Compile Include"
    - "方法签名不匹配: BLL 与 IMgr 不一致"
    - "第三方 DLL 缺失: packages 目录不完整"
```

### 4.5 agent-prompt-examples.md

替代当前 `phase-04-agent-prompts模板.md` 第六章的硬编码示例。

```markdown
# Agent Prompt 示例

> 以下示例展示本项目的标准代码模式，供主 Agent 生成 Agent prompt 时参考。
> 代码来自本项目的实际文件。

## Net 层示例

```typescript
// 参考文件: src/net/et/config_green_channel/config_green_channel.ts
import { Ajax, api } from 'sj.sys';

export class ConfigGreenChannelNet extends api {
  constructor() {
    super('ETGreenChannel');  // ← super() 参数 = 后端 [WebApi("Route")]
  }

  public async GetList(unitId: string) {
    const res = await Ajax.Get(this.baseUrl + this.mgrName + '/GetList?unitId=' + unitId);
    return res;
  }

  public async Save(data: string) {
    const res = await Ajax.Post(this.baseUrl + this.mgrName + '/Save', 'entity=' + data);
    return res;
  }
}
```

## Domain 层示例

```typescript
// 参考文件: src/domain/triage_emergency_config.ts
// 展示 Domain 层如何实例化 BLL Manager 并调用方法
```

## Page 层示例

```vue
<!-- 参考文件: src/pages/.../xxx.vue -->
<!-- 展示 @Component 装饰器、field-status-item 用法、el-select 配置 -->
```

## 后端 WebApi 示例

```csharp
// 参考文件: Web/Xxx.cs
// 展示 [WebApi], [WebApiMethod], BusinessContext 获取方式
```
```

### 4.6 project-structure.yaml

```yaml
# 项目目录结构约定

# 迭代文档存放位置
iterations_dir: "docs/iterations"
iteration_id_format: "YYYY-MM-DD-NNN-{短描述}"

# 前后端文件组织结构
structure:
  backend:
    description: "三层架构 (Inf → BLL → Web)"
    layers:
      - name: "Inf"
        subdirs: ["Entity", "IMgr", "Dtos", "Queries", "Enums", "Util"]
        compilation_unit: "Inf/SJ.BLL.ET.{ProjectName}.Inf.csproj"
      - name: "BLL"
        compilation_unit: "BLL/SJ.BLL.ET.{ProjectName}.csproj"
      - name: "Web"
        compilation_unit: "Web/SJ.Web.ET.{ProjectName}.Web.csproj"
    registration_rule: "新增文件必须 Compile Include 进对应 .csproj"

  frontend:
    description: "三层架构 (Net → BLL → Domain)"
    layers:
      - name: "Net"
        dir: "src/net/et/{module}/"
        naming: "{module}.ts"
      - name: "BLL"
        dir: "src/bll/et/{module}/"
        naming: "{module}.ts"
      - name: "Domain"
        dir: "src/domain/"
        naming: "{feature}.ts"
      - name: "Page"
        dir: "src/pages/{module}/"
        files: ["index.vue", "index.ts"]

# 新增模块的标准文件清单
new_module_checklist:
  backend:
    - "Inf/Entity/{EntityName}.cs         → Compile Include"
    - "Inf/IMgr/I{EntityName}Mgr.cs       → Compile Include"
    - "BLL/{EntityName}Mgr.cs             → Compile Include"
    - "Web/{EntityName}.cs                → Compile Include"
  frontend:
    - "src/net/et/{module}/{module}.ts"
    - "src/bll/et/{module}/{module}.ts"
    - "src/domain/{feature}.ts            → 追加方法"
    - "src/pages/{module}/index.vue"
    - "src/pages/{module}/index.ts"
    - "src/router.ts                      → 追加路由"
    - "src/parameters_settings.ts         → 追加菜单"
```

---

## 五、运行时加载机制

### 5.1 Skill 入口（SKILL.md）的改造

改造后的 SKILL.md 作为薄薄一层入口：

```markdown
---
name: iteration-workflow
description: |
  迭代开发工作流 Skill。覆盖 6 个标准阶段...
---

# 迭代开发工作流

## 前置加载

在进入任何阶段前，主 Agent 必须按顺序加载：

1. **项目清单** → 读取 `.codebuddy/skills/iteration-workflow/project.manifest.yaml`
   - 获取项目名、技术栈、路径映射、分层约定
2. **通用引擎** → 读取 `.codebuddy/skills/iteration-workflow/engine/workflow-engine.md`
   - 获取七阶段流程定义
3. **项目规则** → 读取 `.codebuddy/skills/iteration-workflow/project/code-review-rules.yaml`
   - 获取本项目的审查规则矩阵
4. **项目部署** → 按需读取 `.codebuddy/skills/iteration-workflow/project/deploy-config.yaml`
   - 06 阶段时才读取

## 运行时变量注入

引擎文件中的 `{{变量}}` 占位符在运行时代入 `project.manifest.yaml` 中的值。
Agent 应始终使用注入后的值，而非引擎中的占位符。

## 七阶段工作流

（引用 `engine/workflow-engine.md` 中定义的流程）

## 快速命令参考

（不变）
```

### 5.2 覆盖规则

```
优先级（从高到低）:
  1. 用户在对话中直接指定的值
  2. 项目层2配置文件中的值
  3. 引擎层1中的默认值

加载顺序:
  先读层1 → 建立流程骨架 → 再读层2 → 用层2覆盖骨架中的占位符

未覆盖的层2配置 → 使用层1默认行为（如果默认行为是"必须配置"，则报错提示用户补充）
```

### 5.3 新项目接入流程

```
步骤1: 在新项目的 .codebuddy/skills/iteration-workflow/ 目录下
步骤2: 从模板库复制 project/ 目录
步骤3: 编辑 project.manifest.yaml —— 填写项目路径和技术栈
步骤4: 编辑 code-review-rules.yaml —— 按自己的技术栈定制规则
        - Java + MyBatis → Entity 规则换成 JPA Entity / MyBatis Mapper 规则
        - React + Vite → 前端 Net 层规则换成 axios service 规则
        - Python + Django → 全部规则重写
步骤5: 编辑 deploy-config.yaml —— 填自己的 CI/CD 信息
步骤6: 编辑 agent-prompt-examples.md —— 用自己的代码示例
步骤7: 编辑 build-verify.yaml —— 填构建命令
步骤8: 运行一次简单迭代，验证 skill 正常工作
```

---

## 六、文件结构对比

### Before（现状）

```
.codebuddy/skills/iteration-workflow/
├── SKILL.md                              ← 含三佳路径
└── references/
    ├── complexity-adaptive-strategy.md    ← ✅ 通用
    ├── phase-0X-*模板.md (6个)            ← ✅ 通用
    ├── phase-04-agent-prompts模板.md      ← 含三佳示例
    ├── phase-04-代码审查规则.md           ← ❌ 全硬编码
    ├── phase-05-自动测试与执行.md         ← 含 .vue/NPM 假设
    └── phase-06-deploy-reference.md       ← ❌ FTP/内网/三佳
```

### After（目标）

```
.codebuddy/skills/iteration-workflow/
│
├── SKILL.md                                 ← 薄入口，只定义加载顺序
│
├── engine/                                  ← 层1：通用流程引擎（跨项目复制）
│   ├── workflow-engine.md                   ← 6阶段流程（无项目路径）
│   ├── complexity-scoring.md                ← 复杂度评估
│   ├── delta-marking.md                     ← ADDED/MODIFIED 体系
│   ├── team-agent-strategy.md               ← 四维并行决策
│   ├── naming-conflict-check.md             ← 命名冲突预检
│   ├── lessons-learned.md                   ← 复盘自进化机制
│   └── templates/
│       ├── phase-01-需求记录.md
│       ├── phase-02-需求评审.md
│       ├── phase-03-技术方案.md
│       ├── phase-04-开发任务清单.md
│       ├── phase-05-测试验证报告.md
│       └── phase-06-发布上线记录.md
│
├── project/                                 ← 层2：项目适配层（每个项目独立）
│   ├── project.manifest.yaml                ← 项目元信息 + 技术栈 + 路径
│   ├── project-structure.yaml               ← 目录结构约定
│   ├── code-review-rules.yaml               ← 审查规则矩阵（按技术栈）
│   ├── deploy-config.yaml                   ← 部署配置
│   ├── build-verify.yaml                    ← 构建验证命令
│   └── agent-prompt-examples.md             ← 本项目的 Agent prompt 示例
│
└── README.md                                ← 本设计文档 + 接入指南
```

### 层分布详情

| 原文件 | 新位置 | 层 |
|--------|--------|:--:|
| SKILL.md（流程部分） | engine/workflow-engine.md | 1 |
| SKILL.md（Delta标记） | engine/delta-marking.md | 1 |
| SKILL.md（命名冲突） | engine/naming-conflict-check.md | 1 |
| SKILL.md（复盘机制） | engine/lessons-learned.md | 1 |
| SKILL.md（快速命令） | SKILL.md（薄入口） | 0 |
| references/complexity-adaptive-strategy.md | engine/complexity-scoring.md | 1 |
| references/phase-0X-*模板.md（6个） | engine/templates/phase-0X-*.md | 1 |
| references/phase-04-agent-prompts模板.md | → 策略部分合并到 engine/team-agent-strategy.md | 1 |
| | → 示例部分下沉到 project/agent-prompt-examples.md | 2 |
| references/phase-04-代码审查规则.md | → 规则矩阵下沉到 project/code-review-rules.yaml | 2 |
| references/phase-05-自动测试与执行.md | → 策略部分保留为 engine/test-strategy.md（泛化 .vue→页面 假设） | 1 |
| references/phase-06-deploy-reference.md | → 部署流程泛化到 engine/workflow-engine.md | 1 |
| | → FTP/路径具体值下沉到 project/deploy-config.yaml | 2 |
| SKILL.md（Step 4.5/4.6 路径） | → project-structure.yaml + build-verify.yaml | 2 |

---

## 七、改造工作量估算

| 任务 | 工作量 | 说明 |
|------|:------:|------|
| 从 SKILL.md 提取通用流程到 engine/*.md | 中 | 主要是拆文件 + 替换硬编码为占位符 |
| 从 代码审查规则.md 迁移到 YAML | 大 | ~50条规则需逐条转换为 YAML 格式 |
| 编写 project.manifest.yaml | 中 | 路径、技术栈映射的收集和整理 |
| 编写 deploy-config.yaml | 小 | 从现有 deploy-reference.md 提取 |
| 编写 build-verify.yaml | 小 | 从 SKILL.md Step 4.6 + phase-05 Ch7 提取 |
| 泛化 phase-05-自动测试与执行.md | 小 | 移除 .vue/NPM 硬假设，改为模板变量 |
| 编写 agent-prompt-examples.md | 小 | 从现有代码中复制示例 |
| 编写 README.md（接入指南） | 小 | 本文档即 README 初稿 |
| 测试：在三佳项目中运行一次 | 中 | 验证层1+层2加载正确 |
| 测试：用另一个项目（如Java+Vue3）接入 | 大 | 验证跨技术栈复用能力 |

---

## 八、AI 编程行业类似实践参考

虽然不是本方案的全部来源，但以下行业趋势与分层思路一致：

### 8.1 .cursor/rules + .cursorrules 的分层

Cursor IDE 支持项目级 `.cursor/rules/` 和全局 `.cursorrules`，项目规则覆盖全局——与本方案的"层1通用+层2覆盖"思想同构。

### 8.2 CLAUDE.md 全局 vs 项目

Claude Code 的 `~/.claude/CLAUDE.md`（用户全局）和项目根目录的 `CLAUDE.md`（项目级），也是同样的分层思路。

### 8.3 Custom Instructions / System Prompts 分离

GitHub Copilot 的 `.github/copilot-instructions.md` 支持按文件类型配置——各项目独自维护，但指令格式通用。

### 8.4 本方案与上述实践的关系

上述实践提供了"全局 vs 项目"的**一级分离**。本方案在此基础上更进一步：将 Skill 内部的**流程逻辑**和**技术栈绑定规则**做了**二级分离**，使得同一个 Skill 可以跨项目、跨技术栈复用，每个项目只需维护轻量的层2配置。

---

## 九、下一步

1. **确认方案**：确认分离策略和文件结构
2. **创建 engine/ 目录**：编写 engine 下的通用文件（工作量最大）
3. **创建 project/ 目录**：为三佳项目编写层2配置文件
4. **改造 SKILL.md**：改为薄入口 + 变量注入
5. **就地测试**：在三佳项目上运行一个迭代，验证改造后行为不变
6. **跨项目测试**：在一个不同技术栈的项目上接入，验证复用性
