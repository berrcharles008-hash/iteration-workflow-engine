# 阶段五：05-测试验证（★ 自动生成用例 + 能跑则跑）

**目标**：自动生成测试用例 + 能自动化则执行 + 不能则降级手动。

### Step 0：前端构建验证（涉前端变更时强制）

> 详细命令见 `project/build-verify.yaml` → `frontend`。

```
1. 检查是否有新增依赖 → 有则执行安装命令（`frontend.install_command`），无则跳过
2. 执行构建命令（`frontend.build_command`）→ 必须满足 `frontend.success_criteria`
3. 执行开发服务器启动命令（`frontend.dev_command`）→ 必须能正常运行
```

若构建环境不可达，按 `frontend.fallback` 降级处理。

### Step 1：自动生成测试用例

每条用例标注：编号（TC-{层}-{序号}）、验证目标、自动化标记（自动/手动）、验证方式、预期结果。

生成规则从 `project/build-verify.yaml` → `test_strategy` 读取：
- 每个新增文件 → `test_strategy.new_file_check`
- 每个新增 API → `test_strategy.new_api_check`
- 每个 CRUD 页面 → `test_strategy.crud_page_check`（自动化标记由 `e2e_framework` 决定）
- 物理设备/第三方依赖 → `test_strategy.hardware_third_party`（标记为手动）

### Step 2：用户审核用例（可选）

### Step 3：自动执行【自动】用例

先探测环境（文件系统/后端 API/dev server），就绪则执行，不就绪则降级手动并记录原因。

### Step 4：生成测试报告

输出 `05-测试验证/05-测试验证报告.md`（模板：`phase-05-测试验证报告.md`，🟢简单用 `phase-05-测试报告-lite.md`，优先级见启动协议 §模板解析优先级）。

**交付标准**：所有自动用例 ✅ 通过或 ⚠️ 跳过（有解释），手动用例 ⏳ 待验证，用户确认"测试通过"

### 步骤清单（进入阶段时写入 phase_steps）

| 步骤ID | 步骤名称 | 强制 | 触发条件 |
|--------|---------|:--:|---------|
| step-0-frontend-build | 前端构建验证 | ✅ | 涉前端变更 |
| step-1-generate-cases | 自动生成测试用例 | ✅ | 始终 |
| step-2-user-review | 用户审核用例 | — | 可选 |
| step-3-execute | 自动执行【自动】用例 | ✅ | 始终 |
| step-4-output | 生成测试报告 | ✅ | 始终 |
