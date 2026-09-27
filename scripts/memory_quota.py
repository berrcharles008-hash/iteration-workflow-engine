#!/usr/bin/env python3
"""MEMORY.md 注入配额自检 + 分片索引一致性校验（UTF-16 码元，含 CRLF）—— 常驻工具。

用法：
  python .codebuddy/skills/iteration-workflow/scripts/memory_quota.py [路径]
  python .codebuddy/skills/iteration-workflow/scripts/memory_quota.py --index-check [项目根]

判据（默认模式，配额）：IDE getWorkingMemoryContent() 以 JS String.length（UTF-16 码元）计，
      > 8000 时从头部截断 8000，**尾部丢失**。
退出码（★ GAP-4/加固②，2026-09-16）：
      0 = 健康（余量 >= 10%）
      2 = WARN（余量 < 10%，建议安排瘦身）
      1 = TRUNCATED（已超限，尾部必丢）
      install.ps1 的 Step 7b 依赖该分级做安装期自检。

--index-check（★ MAINT-3 P-4，2026-09-22）外置分片索引一致性校验：
      A. `context-conventions.md` §一登记表内的路径全部可解析
         （`runtime/`·`scripts/`·`project/` 前缀映射到 skill 根；其余相对项目根；IDE 前缀通用兜底）；
      B. 速查分片（`PIVAS-速查*.md`）与登记表双向一致（无孤儿）；
      C. 单分片体积 <= SIZE_LIMIT_KB（默认 20KB —— MAINT-3 建议值 ⇒ 超限仅 WARN）；
      D. `MEMORY.md` 中出现的文件型路径指针全部可达。
退出码：0 = 无 ERR；1 = 存在 ERR。

判定口径（防误报，2026-09-22 首跑实测收敛）：
      - 仅接受白名单前缀路径（IDE 前缀 / `runtime/`·`scripts/`·`project/`·`engine/`·`hooks/` /
        `skills/` / 项目顶层目录），正文里的代码内相对路径（`mgr/`、`src/net/pivas/`）一律跳过；
      - 裸名（无 `/`）仅 §一登记表（allow_bare）放行，或 memory 目录已知前缀（`PIVAS-速查*`）；
      - 跳过：含 `{}`·`*`·`<>`·`…`·空格·`YYYY`/`MM-DD` 占位、仅扩展名（`.cs`）、点文件、带 `:行号` 的写法。

注意：勿用 PowerShell `(Get-Content -Raw).Length` —— PS 5.1 对无 BOM UTF-8
      按 ANSI 解码，实测虚高 ~900（会误报 TRUNCATED）。
"""
import glob
import io
import os
import re
import sys

LIM = 8000
WARN_LIM = int(LIM * 0.9)          # 7200 = 余量 10%
SIZE_LIMIT_KB = 20                 # 单分片上限（--index-check）
INDEX_HEADING = '## 一、项目上下文文件清单'
PATH_SUFFIX_RE = re.compile(r'\.(?:md|py|mjs|js|json|yaml|yml|sql|cs|ts|vue|ps1|txt|csv)$', re.I)
PLACEHOLDER_RE = re.compile(r'YYYY|MM-DD|\{[^}]*\}')
SKILL_PREFIXES = ('runtime/', 'scripts/', 'project/', 'engine/', 'hooks/',
                  'SKILL.md', 'SKILL.template.md')
IDE_PREFIXES = ('.codebuddy/', '.claude/', '.cursor/', '.codex/')
PATH_PREFIXES = IDE_PREFIXES + SKILL_PREFIXES + (
    'skills/', 'tools/', 'sql/', 'docs/', 'requirements/', 'feasibility/',
    'back-end/', 'front-end/', 'pivas-prototype/')
MEM_BARE_PREFIXES = ('PIVAS-速查',)     # memory/ 目录下的裸名指针（允许解析）
LINE_SUFFIX_RE = re.compile(r':\d+(?:-\d+)?$')


def code_units(text):
    return len(text.encode('utf-16-le')) // 2


def read_text(path):
    with io.open(path, encoding='utf-8', newline='') as fh:
        return fh.read()


# ── 默认模式：配额自检 ──────────────────────────────────────

def quota_check(path):
    n = code_units(read_text(path))
    if n > LIM:
        status, code = 'TRUNCATED (tail will be lost)', 1
    elif n > WARN_LIM:
        status, code = 'WARN (margin < 10%, plan a slimming pass)', 2
    else:
        status, code = 'FULL', 0
    print('file      :', path)
    print('codeunits :', n, '/', LIM, ' margin:', LIM - n)
    print('status    :', status)
    return code


# ── --index-check：分片索引一致性 ───────────────────────────

def looks_like_path(token, allow_bare=False):
    """判定反引号内容是否为「可按文件系统校验」的路径。

    allow_bare=False（正文/指针场景）仅接受带白名单前缀的路径 + memory 目录已知裸名前缀；
    allow_bare=True（§一登记表）额外接受项目根裸名文件（如 `README.md`）。
    """
    raw = token.strip()
    if not raw or raw != token:
        return False
    if any(ch in raw for ch in '{}*<>…|'):
        return False
    if ' ' in raw or '　' in raw:
        return False
    if raw.startswith('http'):
        return False
    if PLACEHOLDER_RE.search(raw):
        return False
    s = LINE_SUFFIX_RE.sub('', raw)                        # 剥离 `路径:行号[-行号]`
    if re.match(r'^\.[A-Za-z0-9]+$', s):                   # 仅扩展名形态（`.cs` / `.md`）
        return False
    if os.path.basename(s.rstrip('/')).startswith('.'):    # 点文件（可选存在的标记）
        return False
    if '/' not in s:
        if not PATH_SUFFIX_RE.search(s):
            return False
        return True if allow_bare else s.startswith(MEM_BARE_PREFIXES)
    return s.startswith(PATH_PREFIXES)


def resolve_candidates(project_root, skill_root, token):
    """按前缀规则给出候选绝对路径（任一存在即视为可达）。"""
    norm = LINE_SUFFIX_RE.sub('', token.strip()).replace('\\', '/')
    cands = []
    if norm.startswith(IDE_PREFIXES):
        cands.append(os.path.join(project_root, norm))
    elif norm.startswith(SKILL_PREFIXES):
        cands.append(os.path.join(skill_root, norm))
    else:
        cands.append(os.path.join(project_root, norm))
        if '/' not in norm:
            cands.append(os.path.join(project_root, '.codebuddy', 'memory', norm))
    # 通用兜底：短写形态（如 `skills/iteration-workflow/...`）补 IDE 前缀
    for ide in IDE_PREFIXES:
        cands.append(os.path.join(project_root, ide.rstrip('/'), norm))
    return cands


def _reachable(project_root, skill_root, token):
    return any(os.path.exists(c) for c in resolve_candidates(project_root, skill_root, token))


def extract_table_paths(section_text):
    out = []
    for line in section_text.split('\n'):
        if not line.lstrip().startswith('|'):
            continue
        for m in re.finditer(r'`([^`\n]+)`', line):
            tok = m.group(1)
            if looks_like_path(tok, allow_bare=True):
                out.append(tok)
    return out


def index_check(project_root):
    project_root = os.path.abspath(project_root)
    skill_root = os.path.join(project_root, '.codebuddy', 'skills', 'iteration-workflow')
    mem_dir = os.path.join(project_root, '.codebuddy', 'memory')
    cc_path = os.path.join(skill_root, 'project', 'context-conventions.md')
    mem_path = os.path.join(mem_dir, 'MEMORY.md')
    errs, warns = [], []

    print('mode      : --index-check')
    print('project   :', project_root)

    # A. §一登记表内路径可解析
    if not os.path.isfile(cc_path):
        errs.append('A: 缺文件 %s' % cc_path)
        tokens = []
    else:
        cc = read_text(cc_path)
        m = re.search(r'^' + re.escape(INDEX_HEADING) + r'.*?$(.*?)(?=^## |\Z)', cc, re.M | re.S)
        if not m:
            errs.append('A: 未找到章节「%s」' % INDEX_HEADING)
            section = ''
        else:
            section = m.group(1)
        tokens = sorted(set(extract_table_paths(section)))
        bad_a = [t for t in tokens if not _reachable(project_root, skill_root, t)]
        print('  A index refs : %d checked, broken=%d' % (len(tokens), len(bad_a)))
        for b in bad_a:
            errs.append('A: 索引登记路径不可解析 -> %s' % b)

    # B. 分片与登记双向一致
    actual = sorted(os.path.basename(p) for p in glob.glob(os.path.join(mem_dir, 'PIVAS-速查*.md')))
    declared = sorted(set(os.path.basename(t) for t in tokens
                          if os.path.basename(t).startswith('PIVAS-速查')))
    orphans = [a for a in actual if a not in declared]
    ghosts = [d for d in declared if d not in actual]
    print('  B parts      : actual=%d declared=%d orphans=%s' %
          (len(actual), len(declared), orphans or 'none'))
    for o in orphans:
        errs.append('B: 孤儿分片（存在但未登记）-> %s' % o)
    for g in ghosts:
        errs.append('B: 登记的分片不存在 -> %s' % g)

    # C. 单分片体积
    biggest = None
    for name in actual:
        kb = os.path.getsize(os.path.join(mem_dir, name)) / 1024.0
        if biggest is None or kb > biggest[1]:
            biggest = (name, kb)
        if kb > SIZE_LIMIT_KB:
            warns.append('C: 分片超上限 %dKB -> %s %.1fKB' % (SIZE_LIMIT_KB, name, kb))
    if biggest:
        print('  C sizes      : max=%s %.1fKB / limit %dKB' % (biggest[0], biggest[1], SIZE_LIMIT_KB))

    # D. MEMORY.md 指针可达
    if not os.path.isfile(mem_path):
        errs.append('D: 缺文件 %s' % mem_path)
        bad_d = []
        n_d = 0
    else:
        mem = read_text(mem_path)
        toks_d = sorted(set(m.group(1) for m in re.finditer(r'`([^`\n]+)`', mem)
                            if looks_like_path(m.group(1))))
        bad_d = [t for t in toks_d if not _reachable(project_root, skill_root, t)]
        n_d = len(toks_d)
        print('  D mem refs   : %d checked, broken=%d' % (n_d, len(bad_d)))
        for b in bad_d:
            errs.append('D: MEMORY.md 指针不可达 -> %s' % b)

    for w in warns:
        print('[WARN]', w)
    for e in errs:
        print('[ERR ]', e)
    print('RESULT    : %s (errs=%d warns=%d)' % ('PASS' if not errs else 'FAIL', len(errs), len(warns)))
    return 0 if not errs else 1


def main(argv):
    args = list(argv[1:])
    if args and args[0] == '--index-check':
        root = args[1] if len(args) > 1 else '.'
        return index_check(root)
    path = args[0] if args else '.codebuddy/memory/MEMORY.md'
    return quota_check(path)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
