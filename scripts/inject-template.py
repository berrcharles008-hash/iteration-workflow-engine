#!/usr/bin/env python3
"""
inject-template.py — 模板变量注入脚本

读取 SKILL.template.md 和 project.manifest.yaml，
将模板中的 {{KEY}} 占位符替换为 manifest 中的值，
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
            result[full_key] = ', '.join(str(v) for v in value)
        elif value is not None:
            result[full_key] = str(value)
    
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
    
    args = parser.parse_args()

    # 1. 读取 manifest YAML
    if not os.path.exists(args.manifest):
        print(f"⚠  清单文件不存在: {args.manifest}")
        if not args.dry_run:
            # 无 manifest 时直接复制模板
            if os.path.exists(args.template):
                with open(args.template, 'r', encoding='utf-8') as f:
                    content = f.read()
                with open(args.output, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"✅ 已复制模板 → {args.output} (无清单文件)")
            return
        else:
            print("   清单文件不存在（dry-run 将继续显示无替换项）")
    
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
    
    with open(args.template, 'r', encoding='utf-8') as f:
        template = f.read()
    
    # 4. 替换所有 {{KEY}} 占位符
    changed = []
    
    def replacer(match):
        key = match.group(1).upper()
        if key in replacements:
            changed.append(key)
            return replacements[key]
        return match.group(0)  # 未找到 → 保持原样
    
    result = re.sub(r'\{\{(\w+(?:[\._-]\w+)*)\}\}', replacer, template)
    
    if args.dry_run:
        print("=== DRY RUN ===")
        print(f"清单文件: {args.manifest}")
        print(f"模板文件: {args.template}")
        print(f"输出文件: {args.output}")
        print(f"\n可用变量 ({len(replacements)} 个):")
        for k, v in sorted(replacements.items()):
            mark = ' ✓' if k in changed else ''
            print(f"  {{ {{{k}}} }} → {v}{mark}")
        print(f"\n已匹配占位符: {len(changed)} 个")
        if not changed:
            print("  （模板中无 {{...}} 占位符，输出将与模板相同）")
        return
    
    # 5. 写入输出
    with open(args.output, 'w', encoding='utf-8') as f:
        f.write(result)
    
    print(f"✅ Injected {len(changed)} variables → {args.output}")
    if not changed:
        print("   （模板无占位符，已直接复制）")


if __name__ == '__main__':
    main()
