# L1 项目模块总览

> 本文件由 `scripts/gen-knowledge-base.py --level L1` 自动生成。
> frontmatter `auto-generated: true` 的文件可被 `--force` 覆盖刷新；
> 若需人工编辑，请将 `auto-generated` 改为 `false`。

<!--
auto-generated: true
generated_at: {{GENERATED_AT}}
generator: gen-knowledge-base.py
-->

## 一、前端模块

| # | 模块名 | 目录路径 | 主文件 | 文件数 |
|---|--------|---------|--------|--------|
{{FRONTEND_MODULE_ROWS}}

## 二、后端模块

| # | 模块名 | 目录路径 | 命名空间 | 文件数 |
|---|--------|---------|---------|--------|
{{BACKEND_MODULE_ROWS}}

## 三、模块-文件对照

| 模块 | 前端入口 | 后端 BLL | 后端 WebApi |
|------|---------|---------|------------|
{{MODULE_FILE_MATRIX}}

## 四、变更记录

| 日期 | 操作 | 说明 |
|------|------|------|
| {{GENERATED_AT}} | auto-gen | 初始生成 |
