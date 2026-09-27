# -*- coding: utf-8 -*-
"""
validate-state.py — state.yaml §3.3 Schema 强制校验（SLIM-4 / D-1 脚本化）
SSOT：engine/state-protocol.md §3.3（规则本体）；本脚本为执行通道，规则逐条对应如下
（★ 锚 = §3.3 标题词；禁写行号——SLIM-5 ST-6 去行号化：state-protocol 节序可能对调、行号必漂移）：
  [R1] 必填字段 7 项            → §3.3「必填字段检查」
  [R2] started_at/ended_at 可选 → §3.3「必填字段检查」下 ★ 可选度量字段注记（缺失不报错，向后兼容）
  [R3] 枚举值校验表 11 条        → §3.3「枚举值校验」表
  [R4] 缺陷台账（defects 可选）  → §3.3「缺陷台账校验」（id 唯一 / fixed⇒fixed_at / L2L3⇒rollback_checks）
  [R5] 多 Story 聚合             → §3.3「多 Story 一致性校验」（tasks_total/tasks_completed 求和对账）
  [R6] phase_history 时间包含式匹配 → §3.3「必填字段检查」下 ★ PHASE-METRICS 注记（纯日期=WARN 不阻断）
  ★ 显式排除（脚本不覆盖，仍由 Agent 执行）：
    - 双向对账（05 报告「缺陷记录」节 vs defects[].id，§3.3「缺陷台账校验」第 3 条）——单文件入参无法读报告侧
      ⇒ 脚本 exit 0 ≠ §3.3 全过。
    - 多 Story 第 2 条「abandoned 的 pending 步骤不计入 04 完成门禁」（§3.3「多 Story 一致性校验」第 2 条）为行为语义，
      不在文件内可校验范围（仅输出 NOTE）。
    - 历史兼容（§3.3「历史兼容」）：已有 state 不做迁移校验；phase_history 缺失字段跳过。
用法：python validate-state.py [path]（省略 path = 经 runtime/ACTIVE 解析最新 in_progress state）
退出码：0 = PASS（可含 WARN）/ 1 = FAIL（存在 ERR）/ 2 = 用法或环境错误 / 3 = fail-open（PyYAML 缺失）
"""
import io
import os
import re
import sys

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../iteration-workflow
RUNTIME_DIR = os.path.join(SKILL_ROOT, "runtime")
IDE_ROOT = os.path.dirname(os.path.dirname(SKILL_ROOT))                    # .../.codebuddy

errs, warns, notes = [], [], []

def err(msg):
    errs.append(msg)

def warn(msg):
    warns.append(msg)

def note(msg):
    notes.append(msg)

def resolve_state(path_arg):
    if path_arg:
        p = os.path.abspath(path_arg)
        if not os.path.isfile(p):
            print("[ERR] 指定文件不存在: %s" % p)
            sys.exit(2)
        return p
    # 经 ACTIVE 解析（两行：Line1=迭代ID 或 none；Line2=STATUS=...）
    active = os.path.join(RUNTIME_DIR, "ACTIVE")
    if os.path.isfile(active):
        lines = io.open(active, encoding="utf-8").read().splitlines()
        if lines and lines[0].strip() not in ("", "none"):
            cand = os.path.join(RUNTIME_DIR, lines[0].strip() + ".state.yaml")
            if os.path.isfile(cand):
                return cand
    # 兜底扫描：取字典序最后（忽略 archived），与 startup-protocol B.1 口径一致
    cands = [f for f in os.listdir(RUNTIME_DIR)
             if f.endswith(".state.yaml") and ".archived." not in f]
    if not cands:
        print("[ERR] 未找到 state 文件（ACTIVE=none 且 runtime/ 无 .state.yaml）")
        sys.exit(2)
    return os.path.join(RUNTIME_DIR, sorted(cands)[-1])

# ── [R1] 必填字段（§3.3「必填字段检查」）──────────────────
REQUIRED = ["version", "iteration_id", "iteration_status", "complexity",
            "current_phase", "phase_status", "last_updated"]

# ── [R3] 枚举表（§3.3「枚举值校验」，11 条）─────────────────
def norm_phase(v):
    if isinstance(v, int):
        return "%02d" % v
    return str(v)

def check_enum(data):
    enum_map = [
        ("iteration_status", None, {"in_progress", "completed", "abandoned"}),
        ("complexity", None, {"🟢", "🟡", "🔴"}),
        ("current_phase", norm_phase, {"01", "02", "03", "04", "05", "06", "07"}),
        ("phase_status", None, {"in_progress", "completed", "blocked", "paused"}),
    ]
    for field, norm, allowed in enum_map:
        if field in data:
            v = norm(data[field]) if norm else data[field]
            if v not in allowed:
                err("[R3] %s = %r 不在允许值 %s" % (field, data[field], sorted(allowed)))
    steps = data.get("phase_steps") or []
    if not isinstance(steps, list):
        err("[R3] phase_steps 应为数组")
        steps = []
    for i, s in enumerate(steps):
        if not isinstance(s, dict):
            err("[R3] phase_steps[%d] 应为映射" % i)
            continue
        if s.get("status") not in {"pending", "completed", "skipped", "not_applicable"}:
            err("[R3] phase_steps[%d].status = %r 非法" % (i, s.get("status")))
    stories = data.get("stories") or []
    if not isinstance(stories, list):
        err("[R3] stories 应为数组")
        stories = []
    for i, st in enumerate(stories):
        if not isinstance(st, dict):
            err("[R3] stories[%d] 应为映射" % i)
            continue
        if st.get("status") not in {"in_progress", "completed", "blocked", "abandoned"}:
            err("[R3] stories[%d].status = %r 非法" % (i, st.get("status")))
        for j, ds in enumerate(st.get("dev_steps") or []):
            if isinstance(ds, dict) and ds.get("status") not in {
                "pending", "completed", "skipped", "not_applicable"}:
                err("[R3] stories[%d].dev_steps[%d].status = %r 非法" % (i, j, ds.get("status")))

# ── [R4] 缺陷台账（§3.3「缺陷台账校验」；defects 可选）─────
def check_defects(data):
    defects = data.get("defects")
    if defects is None:
        return  # 可选字段，缺失 = 无缺陷（向后兼容）
    if not isinstance(defects, list):
        err("[R4] defects 应为数组")
        return
    ids = set()
    for i, d in enumerate(defects):
        if not isinstance(d, dict):
            err("[R4] defects[%d] 应为映射" % i)
            continue
        did = d.get("id")
        if did in ids:
            err("[R4] defects id 重复: %r" % did)
        ids.add(did)
        if d.get("status") not in {"open", "fixed", "deferred"}:
            err("[R4] defects[%r].status = %r 非法" % (did, d.get("status")))
        if d.get("severity") not in {"P0", "P1", "P2"}:
            err("[R4] defects[%r].severity = %r 非法" % (did, d.get("severity")))
        if d.get("root_cause_level") not in {"L1", "L2", "L3", None}:
            err("[R4] defects[%r].root_cause_level = %r 非法" % (did, d.get("root_cause_level")))
        if not isinstance(d.get("design_changed", False), bool):
            err("[R4] defects[%r].design_changed 应为布尔" % did)
        if d.get("status") == "fixed" and not d.get("fixed_at"):
            err("[R4] defects[%r] status=fixed 但缺 fixed_at" % did)
        if d.get("root_cause_level") in ("L2", "L3"):
            rc = data.get("rollback_checks") or []
            if not isinstance(rc, list) or not rc:
                err("[R4] defects[%r] root_cause_level=%s 但 rollback_checks 为空"
                    % (did, d.get("root_cause_level")))

# ── [R5] 多 Story 聚合（§3.3「多 Story 一致性校验」）───────
def check_stories(data):
    stories = data.get("stories")
    if not stories:
        return
    if not isinstance(stories, list):
        return
    for field in ("tasks_total", "tasks_completed"):
        if field in data:
            top = data[field] or 0
            ssum = sum((s.get(field) or 0) for s in stories if isinstance(s, dict))
            if top != ssum:
                err("[R5] %s=%r ≠ Σ stories=%r" % (field, top, ssum))
    if any(isinstance(s, dict) and s.get("status") == "abandoned" for s in stories):
        note("[R5] stories 含 abandoned：其 pending dev_steps 不计入 04 完成门禁（行为语义，脚本不校验）")

# ── [R6] phase_history 时间包含式匹配（§3.3 ★ PHASE-METRICS 注记）──
TS_INCLUSIVE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
PURE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def check_phase_history(data):
    ph = data.get("phase_history")
    if not ph or not isinstance(ph, list):
        return  # 历史兼容：缺失/为空跳过
    for i, h in enumerate(ph):
        if not isinstance(h, dict):
            continue
        for f in ("completed_at", "skipped_at"):
            v = h.get(f)
            if v is None:
                continue
            s = str(v)
            if PURE_DATE.match(s):
                warn("[R6] phase_history[%d].%s = %r 为纯日期（WARN 不阻断，兼容历史 12 state 不回溯）"
                     % (i, f, s))
            elif not TS_INCLUSIVE.search(s):
                err("[R6] phase_history[%d].%s = %r 不满足包含式匹配 \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}"
                    % (i, f, s))

def main():
    path_arg = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        import yaml
    except ImportError:
        print("[FAIL-OPEN] PyYAML 不可用，无法机械校验 —— 请按 state-protocol §3.3 降级 read_file 人工校验（不阻塞）")
        sys.exit(3)
    state_path = resolve_state(path_arg)
    try:
        data = yaml.safe_load(io.open(state_path, encoding="utf-8"))
    except Exception as e:
        print("[ERR] YAML 解析失败: %s" % e)
        sys.exit(1)
    if not isinstance(data, dict):
        print("[ERR] state 文件顶层应为映射")
        sys.exit(1)

    for f in REQUIRED:
        if f not in data:
            err("[R1] 缺必填字段: %s" % f)
    # [R2] started_at/ended_at 为可选度量字段：缺失不视为校验失败（显式豁免，不检查）
    check_enum(data)
    check_defects(data)
    check_stories(data)
    check_phase_history(data)

    print("file   : %s" % state_path)
    for e in errs:
        print("[ERR] %s" % e)
    for w in warns:
        print("[WARN] %s" % w)
    for n in notes:
        print("[NOTE] %s" % n)
    print("RESULT : %s (errs=%d warns=%d)" % ("PASS" if not errs else "FAIL", len(errs), len(warns)))
    print("SCOPE  : 脚本覆盖 R1-R6；双向对账（05 报告 vs defects[].id）仍由 Agent 执行 —— exit 0 ≠ §3.3 全过")
    sys.exit(0 if not errs else 1)

if __name__ == "__main__":
    main()
