#!/usr/bin/env python3
"""
inject-template.py — 模板变量注入脚本

读取 SKILL.template.md 和 project.manifest.yaml，
将模板中的 <KEY> 占位符（双花括号写法）替换为 manifest 中的值，
写入 SKILL.md。

用法:
  python scripts/inject-template.py
  python scripts/inject-template.py --manifest project/project.manifest.yaml
  python scripts/inject-template.py --template SKILL.template.md --manifest project/project.manifest.yaml --output SKILL.md
  python scripts/inject-template.py --dry-run
"""

import yaml
import sys
import argparse
import re
import os
import json


# ── 占位符 schema · 五类 51 种全闭合（单一 SSOT）──────────────────────────
#
# 为什么集中声明在这里：注入器（解析 + 残留判定）、`scan-placeholders.py`（分类 / 归零）、
# `audit-engine.py` A10-b（engine 内占位符是否全在 schema 内）三处消费同一份定义。
# 各写一份必然漂移成「文档一套、正则一套、判据一套」—— 正是本迭代要治的根因之一。
#
# 分类口径（协议见 engine/template-injection.md）：
#   ① a 短名别名 ALIAS          —— 历史短名，须映射到 manifest 展平键（应解析；未解析 = ERR）
#   ① b 路径式   PATH_STYLE     —— 含 '.' 的 manifest 路径（`.`→`_` + upper 查展平键；未解析 = ERR）
#   ② 运行时     RUNTIME_VARS   —— Agent 在 Step B/C 动态确定（允许保留原样）
#   ③ 脚本渲染   SCRIPT_RENDERED—— 由 scripts/*.py 等渲染（允许保留原样）
#   ④ 内容槽     CONTENT_SLOT   —— 文档语法示例，必须改写成 <...> 占位说明
#
# 为何 ④ 要单列白名单而不是「不认识就报错」：engine/ 里有大量中文占位符
# （如 {{方案文档路径}}）供人读，不属于本 schema；本文件的正则只匹配 ASCII 标识符，
# 故中文占位符天然不参与判定。④ 白名单用于让 `--verify` 能区分
# 「已归类但待改写」与「真正未归类」，避免把 11 处语法示例当成漏注册。
ALIAS = {
    'KB_DIR': 'PATHS_KB_DIR',
    'SPECS_DIR': 'PATHS_SPECS_DIR',
    'ITERATIONS_DIR': 'PATHS_DOCS_ITERATIONS',
    'PROJECT_ROOT': 'PROJECT_WORKSPACE_ROOT',
    'frontend_framework': 'FRONTEND_FRAMEWORK',
}

PATH_STYLE = (
    'backend_layers.bll.base_class',
    'backend_layers.bll.dir',
    'build.frontend.dev_command',
    'database.type',
    'deploy.stage1.frontend_target',
    'frontend_layers.net.base_class',
    'frontend_layers.page.dir',
    'paths.frontend_root',
    'sql_conventions.dml_wrapper',
    'sql_conventions.language',
)

RUNTIME_VARS = (
    'DOC_01_REQUIREMENT',
    'DOC_02_REVIEW',
    'DOC_03_TECHNICAL',
    'DOC_04_TASK_LIST',
    'ITERATION_ID',
)

SCRIPT_RENDERED = (
    'ALL_BACKEND_ROOTS',
    'ALL_BACKEND_SLNS',
    'ALL_FRONTEND_ROOTS',
    'BACKEND_CLASS_ROWS',
    'BACKEND_FILE_ROWS',
    'BACKEND_METHOD_ROWS',
    'BACKEND_MODULE_ROWS',
    'FRONTEND_COMPONENT_ROWS',
    'FRONTEND_FILE_ROWS',
    'FRONTEND_MODULE_ROWS',
    'GENERATED_AT',
    'HAS_MULTI_PROJECTS',
    'IDE_DIR',
    'INTERFACE_FILE',
    'MENU_FILE',
    'MODULE_FILE_MATRIX',
    'MODULE_NAME',
    'ROOT_DIRS',
    'ROUTER_FILE',
    'TARGET_DIR',
    'TARGET_FILE',
    'TARGET_PATH',
    'WEBAPI_FILE',
)

CONTENT_SLOT = (
    'backend.xxx',
    'database.xxx',
    'deploy.xxx',
    'frontend.xxx',
    'key',
    'paths.xxx',
    'project.xxx',
    'sql_conventions.xxx',
)

# 占位符正则：**只匹配 ASCII 标识符**（支持点号族）。
# 用 `\w` 会因 re.UNICODE 命中中文占位符（如 {{方案文档路径}}）⇒ 误判为「未定义」，
# 使 --check 在引擎自身文档上恒定失败。这是必须的边界，不是风格选择。
PLACEHOLDER_RE = re.compile(r'\{\{([A-Za-z0-9_]+(?:[\._-][A-Za-z0-9_]+)*)\}\}')


def flatten_name(raw):
    """把占位符原文映射为 manifest 展平键（ALIAS 优先，其次 `.`→`_` + upper）。"""
    mapped = ALIAS.get(raw)
    if mapped:
        return mapped
    return raw.replace('.', '_').upper()


def classify(raw):
    """返回占位符所属类别：'alias' / 'path' / 'runtime' / 'script' / 'slot'；未归类返回 None。"""
    if raw in ALIAS:
        return 'alias'
    if raw in PATH_STYLE:
        return 'path'
    if raw in RUNTIME_VARS:
        return 'runtime'
    if raw in SCRIPT_RENDERED:
        return 'script'
    if raw in CONTENT_SLOT:
        return 'slot'
    return None


def schema():
    """五类 schema 的稳定结构（--schema-dump / scan-placeholders.py 消费）。

    `placeholder_re` 一并导出：消费方（audit-engine A10-b）**不要另抄一份正则**——
    抄出来的第二份迟早与本体不一致，而正则一不一致就会在判据上开出「看不见」的洞
    （2026-10-25 step-7 审查 V-4：副本漏了 `-`，含连字符的占位符在注入侧报错、在判据侧隐形）。
    """
    return {
        'alias': dict(sorted(ALIAS.items())),
        'path_style': list(PATH_STYLE),
        'runtime_vars': list(RUNTIME_VARS),
        'script_rendered': list(SCRIPT_RENDERED),
        'content_slot': list(CONTENT_SLOT),
        'placeholder_re': PLACEHOLDER_RE.pattern,
    }


def residual_errors(text):
    """扫描注入结果，返回 (errs, passed)。

    errs   = ① 类未解析 + 未归类 + `{{` 残片（必须失败）
    passed = ②③④ 类残留（允许保留）
    """
    errs = []
    passed = []
    seen = set()
    for m in PLACEHOLDER_RE.finditer(text):
        raw = m.group(1)
        if raw in seen:
            continue
        seen.add(raw)
        cls = classify(raw)
        if cls in ('alias', 'path'):
            errs.append('① 类占位符未解析（schema 要求解析，但 manifest 缺展平键 %s）: {{%s}}'
                        % (flatten_name(raw), raw))
        elif cls is None:
            errs.append('未定义占位符（不属于五类 schema）: {{%s}}' % raw)
        else:
            passed.append('{{%s}}(%s)' % (raw, cls))

    # 兜底：任何双花括号前导都必须被上面的正则整段识别。
    # 正则只收 ASCII 标识符族 ⇒ 带空格、多余花括号、中文的写法全部匹配不到，
    # 结果是「不替换、也不报错」—— 最危险的隐形分支（2026-10-25 step-7 审查 V-9）。
    # 只报第一条：同一模板里大量同形残片时，一条足以定位。
    # ★ 本段刻意不写字面占位符示例：写了会被 scan-placeholders.py --include-scripts 扫成未归类。
    #   需要看具体反例时看 05 报告 TC-S-10（含空格写法实测 exit 1）。
    spans = [m.span() for m in PLACEHOLDER_RE.finditer(text)]
    for i in range(len(text) - 1):
        if text[i:i + 2] != '{{':
            continue
        if any(s0 <= i < s1 for s0, s1 in spans):
            continue
        errs.append('`{{` 前导未被识别为合法占位符（含空格 / 中文 / 多余花括号？）: %s'
                    % text[i:i + 30].replace('\n', ' ⏎ '))
        break
    return errs, passed


def flatten_manifest(manifest, prefix=''):
    """展平多层 YAML 为单层键值对: section/key → SECTION_KEY"""
    result = {}
    if not isinstance(manifest, dict):
        return result
    
    for key, value in manifest.items():
        full_key = f'{prefix}{key}'.upper() if prefix else key.upper()
        
        if isinstance(value, dict):
            result.update(flatten_manifest(value, f'{full_key}_'))
        elif isinstance(value, list):
            text = ', '.join(str(v) for v in value)
            if text.strip():
                result[full_key] = text
        elif value is not None:
            text = str(value)
            # ★ 空串等同缺键（与 `project.manifest.yaml` 自述口径、`gate/exempt-tables.mjs` 一致）：
            #   若把空串当有效值，`specs_dir: {{SPECS_DIR}}/` 会注入成 `specs_dir: /`，
            #   而首次安装（manifest 由 .template 复制、★项全空）正是必经路径 ⇒ exit 0、
            #   零告警地产出腐化 SKILL.md。改造前该占位符根本不命中、残留扫描会报错中断；
            #   别名映射修好之后若不补这条，等于把「响亮的失败」换成「静默腐化」
            #   （2026-10-25 step-7 审查 BLOCKER-1）。
            if text.strip():
                result[full_key] = text
    
    return result


def main():
    parser = argparse.ArgumentParser(
        description='Inject project manifest values into SKILL template',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python inject-template.py
  python inject-template.py --dry-run
  python inject-template.py --manifest my-project.yaml --template custom.md --output out.md
  python inject-template.py --check --compare SKILL.md     # A10-e：产物与现网一致
  python inject-template.py --schema-dump                  # A10-b：五类 schema
        """
    )
    parser.add_argument('--manifest', '-m',
                        default='project/project.manifest.yaml',
                        help='Path to project manifest YAML (default: project/project.manifest.yaml)')
    parser.add_argument('--template', '-t',
                        default='SKILL.template.md',
                        help='Path to SKILL template (default: SKILL.template.md)')
    parser.add_argument('--output', '-o',
                        default='SKILL.md',
                        help='Output path (default: SKILL.md)')
    parser.add_argument('--dry-run', '-n',
                        action='store_true',
                        help='Only show what would be injected, without writing output')
    parser.add_argument('--check', action='store_true',
                        help='只做注入判定不写盘：① 类未解析 / 未定义占位符 ⇒ exit 1')
    parser.add_argument('--compare', metavar='FILE',
                        help='与 FILE 按字节比较注入结果（自动隐含 --check；A10-e 用）')
    parser.add_argument('--force', action='store_true',
                        help='跳过残留判定强制写盘（应急逃生口；判定结论仍会打印）')
    parser.add_argument('--schema-dump', action='store_true',
                        help='输出五类占位符 schema（JSON 稳定排序）；供 A10-b / 扫描器消费')

    args = parser.parse_args()

    # 参数组合收敛：歧义组合一律显式报错，别让「静默忽略某个参数」变成假绿来源
    # （2026-10-25 step-7 审查 V-8：`--check --dry-run` 曾走 dry-run 提前 return、判定被整个跳过）。
    if args.compare and not args.check:
        args.check = True                      # --compare 只在判定语境下有意义，缺 --check 就补上
    if args.check and args.dry_run:
        print('[ERROR] --check 与 --dry-run 互斥：前者要产出判定结论，后者只打印替换明细。')
        sys.exit(2)

    # 编码兜底：Windows 中文控制台默认 GBK，历史上有 emoji 触发 UnicodeEncodeError 的先例
    # （裸崩会让「注入失败」看起来像「脚本不存在」）。'replace' 保证诊断信息仍打得出来。
    try:
        sys.stdout.reconfigure(errors='replace')
    except Exception:
        pass

    # --schema-dump 不依赖 manifest：任何项目、任何工作目录都必须能跑（A10-b 的前置）
    if args.schema_dump:
        print(json.dumps(schema(), ensure_ascii=False, sort_keys=True, indent=2))
        sys.exit(0)

    # 1. 读取 manifest YAML
    if not os.path.exists(args.manifest):
        print(f"[WARN] 清单文件不存在: {args.manifest}")
        if args.dry_run:
            print("   清单文件不存在（dry-run 将继续显示无替换项）")
        elif args.check:
            print("[ERROR] 无清单文件，无法判定注入结果（--check 要求 manifest 存在）")
            sys.exit(1)
        elif args.force:
            # 逃生口：仅显式 --force 才允许「原样复制模板」（占位符会留在产物里，自担风险）
            if not os.path.exists(args.template):
                print(f"[ERROR] 模板文件不存在: {args.template}")
                sys.exit(1)
            with open(args.template, 'r', encoding='utf-8', newline='') as f:
                content = f.read()
            with open(args.output, 'w', encoding='utf-8', newline='') as f:
                f.write(content)
            print(f"[OK] --force 已复制模板 → {args.output} (无清单文件，占位符原样保留)")
            sys.exit(0)
        else:
            # 本分支历史上是「直接复制模板写盘」⇒ 模板占位符原样落进 SKILL.md，
            # 用户得到「看起来装好了」的腐化产物（失效案例 3）。改为写盘前失败。
            print("[ERROR] 无清单文件，拒绝写盘 —— 模板占位符会被原样写入产物。")
            print("        先创建 project/project.manifest.yaml（或从 .template 复制）；"
                  "确需复制模板请加 --force。")
            sys.exit(1)
    
    manifest = {}
    if os.path.exists(args.manifest):
        with open(args.manifest, 'r', encoding='utf-8') as f:
            manifest = yaml.safe_load(f)
    
    # 2. 展平 manifest
    replacements = flatten_manifest(manifest)
    
    # 3. 读取模板
    if not os.path.exists(args.template):
        print(f"❌ 模板文件不存在: {args.template}")
        sys.exit(1)
    
    # newline='' 保留原始换行字节，避免文本模式把孤立 \r 规范化成 \r\n，
    # 从而保证「模板无占位符时注入结果与模板字节恒等」
    with open(args.template, 'r', encoding='utf-8', newline='') as f:
        template = f.read()
    
    # 4. 替换所有双花括号占位符（原文 token 见 match.group(1)）
    changed = []

    def replacer(match):
        raw = match.group(1)
        # 解析序：ALIAS 短名 → 展平键。`flatten_manifest` 产出的是展平名
        # （paths.kb_dir → PATHS_KB_DIR），而文档写的是 {{KB_DIR}}；
        # 不做这一层映射 ⇒ 占位符 0 处命中、注入恒空且不报错（本迭代失效案例 1）。
        key = flatten_name(raw)
        if key not in replacements:
            return match.group(0)  # 未找到 → 保持原样（残留判定统一在写盘前处理）
        changed.append(key)
        value = replacements[key]
        # 尾斜杠归一：占位符紧跟 '/' 且值本身以 '/' 结尾 ⇒ 去掉值的尾斜杠，避免拼出 '//'
        # （manifest 里 paths.* 是否带尾斜杠由用户填写，不能假定）
        if value.endswith('/') and template[match.end():match.end() + 1] == '/':
            value = value.rstrip('/')
        return value

    result = PLACEHOLDER_RE.sub(replacer, template)
    
    if args.dry_run:
        print("=== DRY RUN ===")
        print(f"清单文件: {args.manifest}")
        print(f"模板文件: {args.template}")
        print(f"输出文件: {args.output}")
        print(f"\n可用变量 ({len(replacements)} 个):")
        for k, v in sorted(replacements.items()):
            mark = ' [hit]' if k in changed else ''
            print(f"  {{ {{{k}}} }} → {v}{mark}")
        print(f"\n已匹配占位符: {len(changed)} 个")
        if not changed:
            print("  （模板中无 {{...}} 占位符，输出将与模板相同）")
        return
    
    # 5. 残留判定（写盘前失败）
    # 顺序是关键：历史上是「先写盘、再由安装器扫残留」，误跑一次就把产物回退成旧模板。
    # 判定口径：① 类（应解析却未解析）+ 未归类 ⇒ ERR；②③④ ⇒ 放行。
    errs, passed = residual_errors(result)
    if errs and not args.force:
        print("[ERROR] 注入结果含不可接受残留，已拒绝写盘：")
        for e in errs:
            print(f"   - {e}")
        print("   修复 manifest 或模板后重跑；确需强写请加 --force。")
        sys.exit(1)
    if errs:
        # 能走到这里必然是 --force。仍要把残留摊开：逃生口不等于「结论是通过」
        # （2026-10-25 step-7 审查 V-7：此前强写路径仍打印「0 个不可接受残留」）。
        print("[WARN] --force 跳过判定，但残留 %d 项依然存在：" % len(errs))
        for e in errs:
            print(f"   - {e}")
    if passed:
        print(f"[INFO] 允许保留的占位符 {len(passed)} 个（②运行时/③脚本渲染/④内容槽）："
              + ', '.join(passed))

    if args.check:
        # 只判定不写盘；给了 --compare 则额外做逐字节比较（A10-e 判据）
        if errs:
            print("[WARN] 判定结论：残留 %d 项（--force 强制放行，不计为通过）" % len(errs))
        else:
            print(f"[OK] 注入判定通过（替换 {len(changed)} 个占位符，0 个不可接受残留）")
        if args.compare:
            if not os.path.exists(args.compare):
                print(f"[ERROR] 比较目标不存在: {args.compare}")
                sys.exit(1)
            with open(args.compare, 'r', encoding='utf-8', newline='') as f:
                actual = f.read()
            if actual == result:
                print(f"[OK] 与 {args.compare} 逐字节一致")
                sys.exit(0)
            print(f"[ERROR] 与 {args.compare} 不一致（注入结果 ≠ 磁盘现网文件）")
            sys.exit(1)
        sys.exit(0)

    # 6. 写入输出
    with open(args.output, 'w', encoding='utf-8', newline='') as f:
        f.write(result)

    print(f"[OK] Injected {len(changed)} variables → {args.output}")
    if not changed:
        print("   （模板无占位符，已直接复制）")


if __name__ == '__main__':
    main()
