#!/usr/bin/env python3
"""
review-gateway.py — 外部审查模型路由网关

职责:
  1. 读取 review-models.json（模型优先级列表）
  2. 读取 runtime/review-circuit.json（熔断状态）
  3. 按优先级尝试每个可用模型，熔断的跳过
  4. 成功 → 返回审查结果 + 使用的模型名
  5. 全部失败 → 返回 {"ok": false}，Skill 层降级用默认 Agent

用法:
  python review-gateway.py --prompt-file <审查prompt文件路径> [--skill-dir <Skill根目录>]

配置路径:
  - 模型配置: {skill_dir}/project/review-models.json
  - 熔断状态: {skill_dir}/runtime/review-circuit.json

返回 (JSON 到 stdout):
  成功: {"ok": true, "used": "模型名", "model": "实际model id", "text": "审查结果文本", "tried": [...]}
  失败: {"ok": false, "reason": "all review models unavailable", "tried": [...]}

设计原则:
  - 零外部依赖（仅使用 Python3 标准库）
  - 熔断 TTL 自动恢复（默认 5 分钟）
  - API Key 通过环境变量注入，不硬编码
  - 所有状态文件读写有错误保护
"""

import sys
import os
import json
import time
import argparse
import traceback
import urllib.request
import urllib.error
import ssl
from datetime import datetime, timezone

# Windows GBK 控制台兼容：强制 stdout/stderr 使用 UTF-8
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


# ============================================================
# 文件读写
# ============================================================

def read_json(path, default=None):
    """安全读取 JSON 文件，不存在则返回 default。"""
    try:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
    except (json.JSONDecodeError, OSError):
        pass
    return default if default is not None else {}


def write_json(path, data):
    """安全写入 JSON 文件，自动创建父目录。"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError:
        pass  # 写入失败不阻塞主流程


# ============================================================
# 熔断逻辑
# ============================================================

def load_circuit(path):
    """读取熔断状态文件。"""
    return read_json(path, {"version": 1, "circuits": {}})


def save_circuit(path, data):
    """写入熔断状态文件。"""
    write_json(path, data)


def is_circuit_open(circuit, name):
    """检查指定模型的熔断器是否打开（未过期）。"""
    c = circuit.get("circuits", {}).get(name)
    if not c:
        return False
    open_since = c.get("open_since", "")
    if not open_since:
        return False
    try:
        # 解析 ISO 时间串，不假定有时区标记
        if open_since.endswith('Z'):
            open_time = datetime.fromisoformat(open_since.replace('Z', '+00:00'))
        else:
            open_time = datetime.fromisoformat(open_since)
            if open_time.tzinfo is None:
                open_time = open_time.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        elapsed_minutes = (now - open_time).total_seconds() / 60.0
        ttl = c.get("ttl_minutes", 5)
        return elapsed_minutes < ttl
    except (ValueError, TypeError):
        return False  # 解析异常，安全起见不阻止


def open_circuit(circuit, name, error_msg, ttl_minutes=5):
    """打开熔断器（记录失败）。"""
    entry = circuit.setdefault("circuits", {}).setdefault(name, {})
    entry["open_since"] = datetime.now(timezone.utc).isoformat()
    entry["fail_count"] = entry.get("fail_count", 0) + 1
    entry["last_error"] = error_msg[:500]
    entry["ttl_minutes"] = ttl_minutes


def clear_circuit(circuit, name):
    """清除熔断器（调用成功时）。"""
    if name in circuit.get("circuits", {}):
        del circuit["circuits"][name]


# ============================================================
# 模型调用
# ============================================================

def call_model(base_url, api_key, model, prompt, timeout=120):
    """向指定模型发送 Chat Completions 请求，返回文本。"""
    url = f"{base_url.rstrip('/')}/chat/completions"

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 4096,
        "temperature": 0.3
    }).encode('utf-8')

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')

    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        msg = result.get("choices", [{}])[0].get("message", {})
        # 兼容 sensenova/DeepSeek 系列：部分模型把内容放在 reasoning 而非 content
        return msg.get("content") or msg.get("reasoning") or ""


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="审查模型路由网关 — 按优先级试每个模型，熔断跳过，全部失败则降级"
    )
    parser.add_argument("--prompt-file", required=True, help="审查 prompt 文件路径（纯文本）")
    parser.add_argument("--skill-dir", default=None,
                        help="Skill 根目录（默认自动从脚本位置向上两级推算）")
    args = parser.parse_args()

    # ---- 路径推导 ----
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # scripts/  → skill 根目录
    skill_dir = args.skill_dir or os.path.dirname(script_dir)

    config_path = os.path.join(skill_dir, "project", "review-models.json")
    circuit_path = os.path.join(skill_dir, "runtime", "review-circuit.json")
    prompt_path = os.path.abspath(args.prompt_file)

    # ---- 加载配置 ----
    config = read_json(config_path, {})
    models = config.get("models", [])
    if not models:
        print(json.dumps({"ok": False, "reason": "no models configured in review-models.json", "tried": []},
                         ensure_ascii=False))
        return

    # 按 priority 排序
    models.sort(key=lambda m: m.get("priority", 99))
    default_ttl = config.get("default_ttl_minutes", 5)

    # ---- 读取 prompt ----
    try:
        with open(prompt_path, 'r', encoding='utf-8') as f:
            prompt = f.read()
        if not prompt.strip():
            print(json.dumps({"ok": False, "reason": "prompt file is empty", "tried": []},
                             ensure_ascii=False))
            return
    except OSError as e:
        print(json.dumps({"ok": False, "reason": f"cannot read prompt file: {e}", "tried": []},
                         ensure_ascii=False))
        return

    # ---- 加载熔断状态 ----
    circuit = load_circuit(circuit_path)
    tried = []

    # ---- 依次尝试每个模型 ----
    for m in models:
        name = m.get("name", "unknown")

        # ① 检查熔断
        if is_circuit_open(circuit, name):
            tried.append({"name": name, "status": "circuit_open", "skipped": True})
            continue

        # ② 获取 API Key
        api_key_env = m.get("api_key_env", "")
        api_key = os.environ.get(api_key_env, "") or m.get("api_key", "")
        if not api_key:
            tried.append({"name": name, "status": "no_api_key", "skipped": True})
            continue

        base_url = m.get("base_url", "")
        model_id = m.get("model", "")
        if not base_url or not model_id:
            tried.append({"name": name, "status": "missing_config", "skipped": True})
            continue

        # ③ 调用
        try:
            text = call_model(base_url, api_key, model_id, prompt)

            # 成功 → 清除熔断，返回结果
            clear_circuit(circuit, name)
            save_circuit(circuit_path, circuit)

            print(json.dumps({
                "ok": True,
                "used": name,
                "model": model_id,
                "text": text,
                "tried": tried + [{"name": name, "status": "success"}]
            }, ensure_ascii=False))
            return

        except Exception as e:
            err_msg = f"{type(e).__name__}: {str(e)[:300]}"
            open_circuit(circuit, name, err_msg, ttl_minutes=default_ttl)
            save_circuit(circuit_path, circuit)
            tried.append({"name": name, "status": "failed", "error": err_msg})

    # ---- 全部失败 ----
    print(json.dumps({
        "ok": False,
        "reason": "all review models unavailable",
        "tried": tried
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
