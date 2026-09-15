# L2 模块 Wiki — {{MODULE_NAME}}

> 本文件骨架由 `scripts/gen-knowledge-base.py --level L2` 自动生成。
> **自动生成段**（文件清单/符号索引）可被 `--force` 覆盖刷新。
> **人工补充段**（业务语义）请将对应 `auto-generated` 改为 `false` 后编辑。

<!--
auto-generated: true
generated_at: {{GENERATED_AT}}
generator: gen-knowledge-base.py
module: {{MODULE_NAME}}
root_dirs:
{{ROOT_DIRS}}
-->

## 一、模块概要

<!-- auto-generated: false -->
> 人工填写：业务职责、核心流程、依赖关系

## 二、文件清单（自动生成）

<!-- auto-generated: true -->

### 后端

| # | 文件路径 | 类型 | 类名 | 说明 |
|---|---------|------|------|------|
{{BACKEND_FILE_ROWS}}

### 前端

| # | 文件路径 | 类型 | 说明 |
|---|---------|------|------|
{{FRONTEND_FILE_ROWS}}

## 三、符号索引（自动生成）

<!-- auto-generated: true -->

### 后端类名

| 类名 | 文件 | 类型 | 命名空间 |
|------|------|------|---------|
{{BACKEND_CLASS_ROWS}}

### 后端方法名

| 方法名 | 所属类 | 文件 | 签名摘要 |
|------|--------|------|---------|
{{BACKEND_METHOD_ROWS}}

### 前端组件

| 组件名 | 文件 | 类型 |
|--------|------|------|
{{FRONTEND_COMPONENT_ROWS}}

## 四、业务语义（人工填写）

<!-- auto-generated: false -->
> 人工填写：模块内核心业务概念、状态流转、约束规则

## 五、变更记录

| 日期 | 操作 | 说明 |
|------|------|------|
| {{GENERATED_AT}} | auto-gen | 初始骨架生成 |
