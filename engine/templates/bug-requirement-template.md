# Bug 需求文档标准规范

> **适用场景**：前端/后端 Bug 修复迭代的需求分析阶段
> **核心原则**：Bug 文档的目标不是解释问题，而是让别人"按步骤能复现 + 按步骤能修复 + 按步骤能验证"
> **版本**：v1.0 | **最后更新**：2026-07-06

---

## 1. 基本信息（必须）

```md
| 项目 | 内容 |
|------|------|
| Bug ID / 迭代编号 | YYYY-MM-DD-NNN-标题 |
| 模块/页面 | 受影响的页面或模块路径 |
| 优先级 | P0（阻塞）/ P1（严重）/ P2（一般） |
| 是否影响线上 | 是 / 否 |
| 发现人 / 日期 | xxx / YYYY-MM-DD |
```

---

## 2. 问题现象（必须）

> **只描述"看到什么错了"，不要分析原因**

```md
### 现象描述
- xxx页面，执行xxx操作后，出现xxx异常表现
- select 下拉框显示为空
- input-select 弹窗显示的数据不正确
- 弹窗数据包含其他单位的科室（应只显示本单位）
```

---

## 3. 复现步骤（必须）

> **这是 Bug 文档最关键的部分 —— 任何人按步骤操作都能复现**

```md
### 复现步骤
1. 登录系统（单位：xxx）
2. 进入 xxx 页面
3. 选择分诊去向为 xxx
4. 观察 xxx 组件的表现
5. 预期结果 vs 实际结果
```

**格式要求**：
- 每一步必须可操作，不能用模糊描述（如"随便点几下"）
- 必须注明使用的测试数据（单位、患者、配置等）
- 如果有多种触发路径，都要列出

---

## 4. 当前错误行为（必须）

> **和"现象"区分开**：现象是用户看到的，这里是逻辑层的错误路径

```md
### 当前行为（代码层）
- 实际调用了 xxx 方法/字典
- 未触发 xxx 异步调用
- where 条件缺少 unit_id 过滤
- 分支逻辑走到了错误的 default 值
```

**三层检查清单**（适用于 UI → 逻辑 → 数据源类 Bug）：

```
UI 层     ：组件渲染方式是否正确？显示什么数据？
逻辑层    ：方法调用链是否正确？分支判断是否进入正确路径？
数据源层  ：使用的字典/接口是否正确？过滤条件是否完整？
```

---

## 5. 期望行为（必须）

```md
### 期望行为
- input-select 弹窗应使用 xxx 字典
- select 下拉框应正确加载 xxx 数据
- 数据仅限当前 unit_id
- 各分支使用各自正确的数据源
```

---

## 6. 根因定位（必须）

> **必须精确定位到"是没调用 / 调用错了 / 调用了没生效"**

```md
### 根因定位

#### BugX：xxx 问题
- **根因**：xxx 方法中 [缺少 / 错误] 调用了 xxx
- **错误路径**：代码执行到了 xxx 分支，但该分支 [未调用 GetDictionaryItems / 使用了错误字典 / 缺少过滤条件]
- **影响**：导致 xxx 数据源 [为空 / 数据不正确 / 跨单位]
```

**定位精度要求**：

| 不够精确 ❌ | 精确 ✔ |
|------------|--------|
| "未正确异步加载" | "select 模式下 InHospital 分支未调用 GetDictionaryItems，lstTriageDestinationItems 保持初始空数组" |
| "字典用错了" | "OutHospital 分支未定义，走了默认值 ET_DICT_DEPT_COME（科室字典），应使用 ET_DICT_TRIAGE_TRANSFER_HOSPITAL（转出入医院字典）" |
| "缺少过滤" | "where 参数为空字符串，未包含 unit_id='${currUserUnitId}' 条件" |

---

## 7. 修复方案（必须）

> **必须拆成"可执行步骤"，每步包含：文件、方法、具体改动**

```md
### 修复点

#### 修复点1：xxx
- **文件**：`src/pages/et/xxx/xxx.ts`
- **方法**：`MethodName`（第 X-Y 行）
- **改动**：在 xxx 分支中增加 xxx 调用
- **代码示例**：
  ```ts
  // 修复前
  // ... 错误代码（可选，帮助理解）
  
  // 修复后
  if (destCode == xxx) {
      this.xxxDS.GetDictionaryItems(unitId, DICT_KEY).then(items => {
          this.lstXxxItems = items;
      });
  }
  ```
```

**方案要求**：
- 每个修复点独立编号
- 如果有依赖关系（如修复A必须在修复B之前），需要标注
- 涉及多处修改时，标注改动行号范围

---

## 8. 改动范围（必须）

```md
### 涉及文件
| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/pages/et/xxx/xxx.ts` | 修改 | 修复 xxx 方法 |

### 不涉及
- [x] 后端接口
- [x] 数据库
- [x] 字典配置
- [x] VUE 模板文件
- [x] 其他页面
```

---

## 9. 数据源优先级规则（必须 — 当涉及多数据源时）

> **当 Bug 涉及多个数据源在不同场景下切换时，必须有此章节**

```md
### 数据源优先级规则

| 渲染模式 | 分诊去向 | 数据源 | 过滤条件 |
|----------|----------|--------|----------|
| select（下拉框） | InHospital | ET_DICT_IN_HOSPITAL_DEPT | unit_id（GetDictionaryItems 内部处理） |
| select（下拉框） | OutPatient | ET_DICT_OUT_PATIENT_DEPT | unit_id（GetDictionaryItems 内部处理） |
| select（下拉框） | OutHospital | lstTransferHospital（已有缓存） | 无需过滤 |
| input-select（弹窗） | InHospital | ET_DICT_IN_HOSPITAL_DEPT | where: unit_id='${currUserUnitId}' |
| input-select（弹窗） | OutPatient | ET_DICT_OUT_PATIENT_DEPT | where: unit_id='${currUserUnitId}' |
| input-select（弹窗） | OutHospital | ET_DICT_TRIAGE_TRANSFER_HOSPITAL | where: unit_id='${currUserUnitId}' |
```

**关键定义**：
- `currUserUnitId` = `sj.globalVar.UnitID`（当前登录用户所属单位，非患者单位）
- `GetDictionaryItems(unitId, dictKey)` 内部通过 `ETUtil.GetDictDataByUnitId` 按 unitId 过滤
- `Dict` 弹窗通过 `where` 参数过滤

---

## 10. 测试用例（必须）

> **每个 Bug 至少 1 条正向 + 1 条边界用例**

```md
### 测试用例

#### TC1：input-select - InHospital 数据隔离
- **前置条件**：单位A有科室K1/K2，单位B有科室K3/K4
- **步骤**：以单位A登录 → 选择分诊去向"转住院" → 点击去向详情输入框
- **预期**：弹窗只显示 K1/K2，不显示 K3/K4

#### TC2：input-select - OutHospital 字典正确
- **步骤**：选择分诊去向"转出院" → 点击去向详情输入框
- **预期**：弹窗显示转出入医院字典（ET_DICT_TRIAGE_TRANSFER_HOSPITAL），而非科室字典

#### TC3：select - InHospital 下拉不为空
- **步骤**：选择分诊去向"转住院"（配置为 select 渲染）
- **预期**：下拉框正确加载当前单位住院科室列表

#### TC4：select - OutPatient 下拉不为空
- **步骤**：选择分诊去向"转门诊"（配置为 select 渲染）
- **预期**：下拉框正确加载当前单位门诊科室列表

#### TC5：边界 - 无科室单位
- **步骤**：以没有配置科室的单位登录
- **预期**：下拉框/弹窗为空但不报错

#### TC6：回归 - OutHospital select 模式
- **步骤**：选择分诊去向"转出院"（配置为 select 渲染）
- **预期**：下拉框仍使用 lstTransferHospital 缓存数据，不受修复影响
```

---

## 11. 回归范围（建议）

```md
### 回归检查项
- [ ] 分诊结果页 — 所有分诊去向切换正常
- [ ] 分诊结果页 — 已有数据的编辑/查看模式不受影响
- [ ] 分诊列表页 — 分诊去向显示正常
- [ ] 打印 — 分诊去向信息打印正确
```

---

## 附录：文档自检清单

在提交需求文档前，逐项确认：

- [ ] 每个 Bug 都有**精确定位**（没调用 / 调用错了 / 调用了没生效）
- [ ] 每个 Bug 都有**当前错误路径**（走了哪个错误分支 / 用了哪个错误默认值）
- [ ] 每个 Bug 都有**可执行的修复方案**（文件 + 方法 + 具体改动）
- [ ] 所有关键术语有**明确定义**（如 unit_id 来源、currUserUnitId 含义）
- [ ] **复现步骤**可独立执行（不需要猜测操作）
- [ ] **测试用例**覆盖正向 + 边界 + 回归
- [ ] 多数据源场景有**数据源优先级规则表**
- [ ] **不涉及范围**明确标注

---

## 参考：本系统三层数据链

本项目 Bug 通常涉及三层，需求分析时必须逐层检查：

```
UI 层（select / input-select 组件渲染）
        ↓
前端逻辑层（SetTriageDestinationDetailDisplay / TriageHospitalDeptInputSelect_Changed）
        ↓
字典/接口层（GetDictionaryItems + where 条件 / Dict 弹窗）
```

**检查规则**：三层中任何一层的修复遗漏都可能导致 Bug 残留。
