# L3 语义桥 — 高频术语速查（示例模板）

> 业务术语 ↔ 代码命名的双向映射，五维搜索矩阵。
> 来源：L1 模块总览 + L2 wiki + specs 4 文件交叉提取
> 
> **使用说明**：将此文件复制到 `.codebuddy/specs/L3-glossary.md`，
> 然后根据项目实际情况填充术语。Phase 01 step-2-6 会自动生成初始版本。

## 一、术语↔代码 映射表

| # | 业务术语 | 代码命名 | 所属模块 | 类型 | 上下文 |
|:--:|---------|---------|---------|------|------|
| 1 | 用户 | User / SysUser | user-mgmt | Entity | 系统用户主表 |
| 2 | 订单 | Order / SalesOrder | order-mgmt | Entity | 销售订单核心表 |
| 3 | 状态枚举 | OrderStatus / DictOrderStatus | order-mgmt | Dict | 待支付/已支付/已发货/已完成 |

> 提示：每行包含 term → code_name → module → type → context 五个维度。
> 类型取值：Entity（数据表）、Dict（字典）、Config（配置）、API Route、Page、Component、Report、Field、Method。

## 二、按模块分组（模块→术语）

| 模块 | 术语关键词 |
|------|-----------|
| user-mgmt | 用户、角色、权限 |
| order-mgmt | 订单、状态、支付 |

## 三、按代码命名类型分组

| 类型 | 术语示例（≥3） |
|------|---------|
| Entity（数据表） | User, Order, Product |
| Dict（字典） | OrderStatus, UserRole, PaymentMethod |
| Config（配置） | AppSettings, FeatureFlags |

## 四、从代码命名反查术语

| 代码片段 | → 业务含义 |
|---------|-----------|
| `Order` / `SalesOrder` | 销售订单 |
| `OrderStatus` | 订单状态枚举 |

## 五、从业务需求定位代码

| 业务需求 | → 定位路径 |
|---------|-----------|
| 修改订单状态流转 | `BLL/OrderMgr.cs` → `ChangeStatus()` |
| 添加新支付方式 | `DictPaymentMethod` + `payment_config.ts` |
