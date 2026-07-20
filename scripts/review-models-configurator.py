#!/usr/bin/env python3
"""
review-models-configurator.py — 外部审查模型可视化配置器

功能:
  1. 启动本地 HTTP 服务（localhost:8769）
  2. 自动打开浏览器进入配置页面
  3. 可视化 CRUD 管理 review-models.json
  4. 一键设置 Windows 环境变量（setx）
  5. 操作日志记录（runtime/configurator.log）
  6. 查看当前熔断状态

用法:
  python scripts/review-models-configurator.py

依赖: 零外部依赖，仅 Python3 标准库
"""

import sys
import os
import json
import time
import socket
import webbrowser
import threading
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone

# ============================================================
# 路径推导
# ============================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(SKILL_DIR, "project", "review-models.json")
CIRCUIT_PATH = os.path.join(SKILL_DIR, "runtime", "review-circuit.json")
LOG_PATH = os.path.join(SKILL_DIR, "runtime", "configurator.log")

HOST = "localhost"
PORT = 8769

# 异步测试状态（内存字典，key=模型名，value={"status":"testing"|"ok"|"fail",...}）
TEST_STATUS = {}


# ============================================================
# 工具函数
# ============================================================

def read_json(path, default=None):
    try:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
    except (json.JSONDecodeError, OSError):
        pass
    return default if default is not None else {}


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def append_log(action, target, detail=""):
    """追加操作日志"""
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} | {action:8s} | {target:30s} | {detail}\n"
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(line)


def read_logs(limit=100, date_from="", date_to=""):
    """读取最近 N 条日志，支持日期范围过滤"""
    if not os.path.exists(LOG_PATH):
        return []
    lines = []
    with open(LOG_PATH, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(" | ", 3)
            if len(parts) < 4:
                continue
            ts = parts[0]  # "2026-07-18 15:10:36"
            # 日期范围过滤（时间戳字符串比较天然支持字典序）
            if date_from and ts < date_from:
                continue
            if date_to and ts > date_to + " 23:59:59":
                continue
            lines.append({
                "time": ts,
                "action": parts[1].strip(),
                "target": parts[2].strip(),
                "detail": parts[3]
            })
    return lines[-limit:]


def read_circuit():
    """读取熔断状态"""
    return read_json(CIRCUIT_PATH, {"version": 1, "circuits": {}})


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


def read_env_from_registry(var_name):
    """直接从注册表读取用户环境变量（绕过 os.environ 缓存）"""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ)
        value, _ = winreg.QueryValueEx(key, var_name)
        winreg.CloseKey(key)
        return value or ""
    except FileNotFoundError:
        return ""
    except Exception:
        return ""


def scan_env_by_names(var_names):
    """按指定变量名列表扫描注册表，返回 {变量名: 值(脱敏)}

    只查询 var_names 中列出的变量，不会遍历全部系统环境变量。
    若某变量在注册表中不存在，则对应值为空字符串。
    安全考虑：API Key 值只暴露前4位+后4位省略号。
    """
    result = {}
    if not var_names:
        return result
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ)
        for name in var_names:
            try:
                value, _ = winreg.QueryValueEx(key, name)
                # 安全脱敏：值超过12字符的只显示前4位+...
                if len(value) > 12:
                    display = value[:4] + "..." + value[-4:]
                else:
                    display = value
                result[name] = display
            except FileNotFoundError:
                result[name] = ""  # 变量存在注册表但无值
            except Exception:
                result[name] = ""
        winreg.CloseKey(key)
    except Exception:
        # 整个 key 打开失败（如非 Windows），全部返回空
        for name in var_names:
            result[name] = ""
    return result


def try_set_env(var_name, var_value):
    """通过 Windows 注册表设置用户环境变量（绕过 setx 避免超时）"""
    import re
    if sys.platform != "win32":
        return False, "仅支持 Windows 系统"
    if not var_name or not var_value:
        return False, "变量名和值不能为空"
    # Windows 环境变量名只允许字母、数字、下划线，且不能以数字开头
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', var_name):
        return False, "变量名格式非法：只能包含字母、数字、下划线，且不能以数字开头（如 SENSENOVA_API_KEY）"
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, var_name, 0, winreg.REG_EXPAND_SZ, var_value)
        winreg.CloseKey(key)
        append_log("SETENV", var_name, "环境变量设置成功")
        return True, f"环境变量 {var_name} 已设置（需重启终端生效）"
    except PermissionError:
        msg = "权限不足：请以管理员身份运行配置器"
        append_log("SETENV", var_name, f"失败: {msg}")
        return False, msg
    except Exception as e:
        msg = str(e)
        append_log("SETENV", var_name, f"异常: {msg}")
        return False, msg


def delete_env_from_registry(var_name):
    """从注册表删除用户环境变量"""
    if sys.platform != "win32":
        return False, "仅支持 Windows 系统"
    if not var_name:
        return False, "变量名不能为空"
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE)
        winreg.DeleteValue(key, var_name)
        winreg.CloseKey(key)
        append_log("DELENV", var_name, "环境变量已删除")
        return True, f"环境变量 {var_name} 已删除（需重启终端生效）"
    except FileNotFoundError:
        msg = f"环境变量 {var_name} 不存在"
        append_log("DELENV", var_name, f"失败: {msg}")
        return False, msg
    except PermissionError:
        msg = "权限不足：请以管理员身份运行配置器"
        append_log("DELENV", var_name, f"失败: {msg}")
        return False, msg
    except Exception as e:
        msg = str(e)
        append_log("DELENV", var_name, f"异常: {msg}")
        return False, msg


# ============================================================
# HTTP 请求处理器
# ============================================================

class ConfiguratorHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        """抑制默认日志输出到 stderr（我们用自己的日志）"""
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html):
        body = html.encode('utf-8')
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 0:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        return {}

    # ---- 路由 ----

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)

        if path == "/" or path == "":
            self._serve_page()
        elif path == "/api/models":
            self._get_models()
        elif path == "/api/circuit":
            self._get_circuit()
        elif path == "/api/logs":
            self._get_logs(qs)
        elif path == "/api/model-key":
            self._get_model_key(qs)
        elif path == "/api/test-status":
            self._test_status()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/models":
            self._save_model()
        elif path == "/api/models/delete":
            self._delete_model()
        elif path == "/api/set-env":
            self._set_env()
        elif path == "/api/env-scan":
            self._scan_env()
        elif path == "/api/env-delete":
            self._delete_env()
        elif path == "/api/clear-circuit":
            self._clear_circuit()
        elif path == "/api/models/reorder":
            self._reorder_models()
        elif path == "/api/test-model":
            self._test_model()
        elif path == "/api/list-models":
            self._list_models()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ---- API 实现 ----

    def _get_models(self):
        config = read_json(CONFIG_PATH, {})
        models = config.get("models", [])
        # 标注正在测试的模型（前端据此在刷新后保持"测试中…"按钮态）
        for m in models:
            m["testing"] = TEST_STATUS.get(m.get("name"), {}).get("status") == "testing"
        self._send_json(models)

    def _get_circuit(self):
        self._send_json(read_circuit())

    def _get_logs(self, qs):
        limit = int(qs.get("limit", [100])[0])
        date_from = qs.get("date_from", [""])[0]
        date_to = qs.get("date_to", [""])[0]
        self._send_json(read_logs(limit, date_from, date_to))

    def _get_model_key(self, qs):
        """查看模型的实际 API Key（仅响应有 Key 的模型）"""
        name = qs.get("name", [""])[0].strip()
        if not name:
            self._send_json({"ok": False, "error": "缺少模型名称参数"}, 400)
            return

        config = read_json(CONFIG_PATH, {})
        models = config.get("models", [])
        target = None
        for m in models:
            if m.get("name") == name:
                target = m
                break
        if not target:
            self._send_json({"ok": False, "error": "模型不存在"}, 404)
            return

        # 优先级：环境变量 > 直接写入
        api_key_env = target.get("api_key_env", "")
        api_key = read_env_from_registry(api_key_env) if api_key_env else ""
        source = f"环境变量 {api_key_env}" if api_key else ""
        if not api_key:
            api_key = target.get("api_key", "")
            source = "直写文件" if api_key else ""

        if not api_key:
            self._send_json({"ok": False, "error": "该模型没有配置 API Key"})
            return

        append_log("VIEWKEY", name, f"查看 Key (来源: {source})")
        self._send_json({"ok": True, "key": api_key, "source": source})

    def _save_model(self):
        body = self._read_body()
        name = body.get("name", "").strip()
        if not name:
            self._send_json({"ok": False, "error": "模型名称不能为空"}, 400)
            return

        config = read_json(CONFIG_PATH, {})
        models = config.get("models", [])

        # 查找是否已存在同名模型
        existing_idx = None
        for i, m in enumerate(models):
            if m.get("name") == name:
                existing_idx = i
                break

        # 构建模型条目（只保留有效字段）
        entry = {"name": name, "model": body.get("model", "").strip(),
                 "priority": int(body.get("priority", 99)),
                 "base_url": body.get("base_url", "https://token.sensenova.cn/v1").strip(),
                 "review_types": body.get("review_types", ["all"])}
        if body.get("api_key_env", "").strip():
            entry["api_key_env"] = body["api_key_env"].strip()
        if body.get("api_key", "").strip() and not body.get("api_key", "").startswith("sk-请替换"):
            entry["api_key"] = body["api_key"].strip()

        if existing_idx is not None:
            # 更新
            old = models[existing_idx]
            models[existing_idx] = entry
            append_log("EDIT", name, f"更新模型配置")
            action = "更新"
        else:
            # 新增
            models.append(entry)
            append_log("ADD", name, f"新增模型")
            action = "新增"

        config["models"] = models
        write_json(CONFIG_PATH, config)
        self._send_json({"ok": True, "action": action, "model": entry})

    def _delete_model(self):
        body = self._read_body()
        name = body.get("name", "").strip()
        if not name:
            self._send_json({"ok": False, "error": "模型名称不能为空"}, 400)
            return

        config = read_json(CONFIG_PATH, {})
        models = config.get("models", [])
        new_models = [m for m in models if m.get("name") != name]

        if len(new_models) == len(models):
            self._send_json({"ok": False, "error": f"模型 {name} 不存在"}, 404)
            return

        config["models"] = new_models
        write_json(CONFIG_PATH, config)
        append_log("DELETE", name, "删除模型")
        self._send_json({"ok": True, "action": "删除", "name": name})

    def _reorder_models(self):
        """拖曳排序：接收模型名称数组，按顺序重新分配 priority 1,2,3..."""
        body = self._read_body()
        ordered_names = body.get("order", [])
        if not ordered_names:
            self._send_json({"ok": False, "error": "order 数组不能为空"}, 400)
            return

        config = read_json(CONFIG_PATH, {})
        models = config.get("models", [])

        # 按传入顺序重建，重新分配 priority
        name_to_model = {m.get("name"): m for m in models}
        reordered = []
        for i, name in enumerate(ordered_names):
            m = name_to_model.get(name)
            if m:
                m["priority"] = i + 1
                reordered.append(m)

        # 追加不在排序列表中的模型（保持原 priority）
        remaining = [m for m in models if m.get("name") not in ordered_names]
        reordered.extend(remaining)

        config["models"] = reordered
        write_json(CONFIG_PATH, config)
        append_log("REORDER", ",".join(ordered_names[:5]) + ("..." if len(ordered_names) > 5 else ""),
                    f"拖曳重排 {len(ordered_names)} 个模型")
        self._send_json({"ok": True, "action": "排序完成", "count": len(reordered)})

    def _set_env(self):
        body = self._read_body()
        var_name = body.get("var_name", "").strip()
        var_value = body.get("var_value", "").strip()
        ok, msg = try_set_env(var_name, var_value)
        self._send_json({"ok": ok, "message": msg})

    def _scan_env(self):
        """按模型引用的变量名列表扫描注册表"""
        body = self._read_body()
        var_names = body.get("var_names", [])
        env_vars = scan_env_by_names(var_names)
        self._send_json({"ok": True, "vars": env_vars})

    def _delete_env(self):
        body = self._read_body()
        var_name = body.get("var_name", "").strip()
        ok, msg = delete_env_from_registry(var_name)
        self._send_json({"ok": ok, "message": msg})

    def _clear_circuit(self):
        body = self._read_body()
        name = body.get("name", "").strip()
        circuit = read_circuit()
        circuits = circuit.get("circuits", {})
        if name:
            if name in circuits:
                del circuits[name]
                circuit["circuits"] = circuits
                write_json(CIRCUIT_PATH, circuit)
                append_log("UNCIRCUIT", name, "手动清除熔断")
                self._send_json({"ok": True, "action": f"已清除 {name} 的熔断状态"})
            else:
                self._send_json({"ok": False, "error": f"模型 {name} 无熔断记录"})
        else:
            # 清除全部
            circuit["circuits"] = {}
            write_json(CIRCUIT_PATH, circuit)
            append_log("UNCIRCUIT", "(all)", "手动清除全部熔断")
            self._send_json({"ok": True, "action": "已清除全部熔断状态"})

    def _test_model(self):
        body = self._read_body()
        name = body.get("name", "").strip()
        config = read_json(CONFIG_PATH, {})
        models = config.get("models", [])
        target = None
        for m in models:
            if m.get("name") == name:
                target = m
                break
        if not target:
            self._send_json({"ok": False, "error": "模型不存在"}, 404)
            return

        api_key_env = target.get("api_key_env", "")
        api_key = read_env_from_registry(api_key_env) or target.get("api_key", "")
        if not api_key:
            self._send_json({"ok": False, "error": "无 API Key 可测试"}, 400)
            return

        # 异步执行：立即返回 testing 状态，前端轮询 /api/test-status 获取结果
        TEST_STATUS[name] = {"status": "testing"}
        t = threading.Thread(target=self._run_test, args=(name, target, api_key), daemon=True)
        t.start()
        self._send_json({"ok": True, "testing": True})

    def _run_test(self, name, target, api_key):
        """后台线程：真正执行连通性测试，结果写入 TEST_STATUS[name] 与 CIRCUIT_PATH"""
        import ssl
        import urllib.request
        import urllib.error

        base_url = target.get("base_url", "")
        model_id = target.get("model", "")
        url = f"{base_url.rstrip('/')}/chat/completions"
        prompt = "请用一句话回答：什么是代码审查？"

        try:
            body_bytes = json.dumps({
                "model": model_id,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 256, "temperature": 0.3
            }).encode('utf-8')
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, data=body_bytes, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                text = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            append_log("TEST", name, "连通性测试通过")
            # 测试通过：清除该模型熔断记录
            circuit = read_circuit()
            clear_circuit(circuit, name)
            write_json(CIRCUIT_PATH, circuit)
            TEST_STATUS[name] = {"status": "ok", "message": text}
        except Exception as e:
            msg = f"{type(e).__name__}: {str(e)[:200]}"
            append_log("TEST", name, f"连通性测试失败: {msg}")
            # 测试失败：打开熔断并记录错误信息
            circuit = read_circuit()
            open_circuit(circuit, name, msg, ttl_minutes=5)
            write_json(CIRCUIT_PATH, circuit)
            TEST_STATUS[name] = {"status": "fail", "error": msg}

    def _test_status(self):
        """返回某模型的异步测试状态，供前端轮询"""
        qs = parse_qs(urlparse(self.path).query)
        name = qs.get("name", [""])[0].strip()
        if not name:
            self._send_json({"ok": False, "error": "缺少模型名称参数"}, 400)
            return
        status = TEST_STATUS.get(name, {})
        self._send_json({"ok": True, "status": status})

    def _list_models(self):
        """调用 provider 的 /v1/models 端点获取可用模型列表"""
        body = self._read_body()
        base_url = body.get("base_url", "").strip()
        api_key_env = body.get("api_key_env", "").strip()
        api_key_direct = body.get("api_key", "").strip()

        if not base_url:
            self._send_json({"ok": False, "error": "请先填写 Base URL"}, 400)
            return

        # 优先从环境变量获取 Key，其次从表单直接传入（用winreg直读注册表，绕过os.environ缓存）
        api_key = read_env_from_registry(api_key_env) if api_key_env else ""
        if not api_key:
            api_key = api_key_direct

        import ssl
        import urllib.request
        import urllib.error

        url = f"{base_url.rstrip('/')}/models"
        try:
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, headers=headers, method='GET')
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                models = [m.get("id", "") for m in result.get("data", [])]
                models = [m for m in models if m]  # 过滤空值
            append_log("LIST", base_url, f"获取到 {len(models)} 个模型")
            self._send_json({"ok": True, "models": models})
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode('utf-8', errors='replace')[:200]
            except Exception:
                pass
            msg = f"HTTP {e.code}: {err_body}" if err_body else f"HTTP {e.code}"
            append_log("LIST", base_url, f"失败: {msg}")
            self._send_json({"ok": False, "error": f"获取模型列表失败: {msg}"})
        except Exception as e:
            msg = f"{type(e).__name__}: {str(e)[:200]}"
            append_log("LIST", base_url, f"失败: {msg}")
            self._send_json({"ok": False, "error": f"获取模型列表失败: {msg}"})

    # ---- 页面 ----

    def _serve_page(self):
        self._send_html(HTML_PAGE)


# ============================================================
# HTML 页面（内嵌 CSS/JS，零外部依赖）
# ============================================================

HTML_PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>外部审查模型配置器</title>
<style>
:root {
  --bg: #f0f2f5;
  --card-bg: #ffffff;
  --text: #1d2129;
  --text-secondary: #86909c;
  --text-tertiary: #c9cdd4;
  --border: #e5e6eb;
  --primary: #165dff;
  --primary-light: #e8f0ff;
  --primary-hover: #4080ff;
  --danger: #f53f3f;
  --danger-light: #ffece8;
  --danger-hover: #f76560;
  --success: #00b42a;
  --success-light: #e8ffea;
  --warning: #ff7d00;
  --warning-light: #fff7e8;
  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 4px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.08);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.6; padding: 20px 24px;
}

/* Header */
.header {
  background: var(--card-bg); border-radius: var(--radius); padding: 24px 28px 20px;
  margin-bottom: 16px; box-shadow: var(--shadow); border: 1px solid var(--border);
}
.header-top { display: flex; justify-content: space-between; align-items: flex-start; }
.header-title h1 { font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
.header-title p {
  font-size: 13px; color: var(--text-secondary); margin-top: 4px;
  display: flex; align-items: center; gap: 6px;
}
.header-title p .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); display: inline-block; }
.header-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* Stats bar (inside header) */
.stats-bar {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
  margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border);
}
.stat-item { text-align: center; }
.stat-value { font-size: 24px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.stat-label { font-size: 12px; color: var(--text-secondary); margin-top: 2px; font-weight: 500; }
.stat-value.ok { color: var(--success); }
.stat-value.warn { color: var(--warning); }
.stat-value.bad { color: var(--danger); }

/* Tabs */
.tabs {
  display: flex; gap: 0; margin-bottom: 16px;
  background: var(--card-bg); border-radius: var(--radius);
  padding: 4px; box-shadow: var(--shadow); border: 1px solid var(--border);
}
.tab-btn {
  flex: 1; padding: 9px 16px; border: none; border-radius: var(--radius-sm);
  background: transparent; cursor: pointer; font-size: 13px; font-weight: 500;
  color: var(--text-secondary); transition: all 0.2s; text-align: center;
}
.tab-btn:hover { color: var(--text); background: #f5f5f5; }
.tab-btn.active { background: var(--primary); color: #fff; box-shadow: 0 1px 3px rgba(22,93,255,0.3); }

.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* Card */
.card { background: var(--card-bg); border-radius: var(--radius); padding: 20px 24px;
  margin-bottom: 16px; box-shadow: var(--shadow); border: 1px solid var(--border); }
.card-header { display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.card-header h2 { font-size: 15px; font-weight: 600; }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 16px; border: none; border-radius: var(--radius-sm);
  font-size: 13px; cursor: pointer; transition: all 0.15s; font-weight: 500;
  white-space: nowrap;
}
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover { background: var(--danger-hover); }
.btn-success { background: var(--success); color: #fff; }
.btn-outline { background: var(--card-bg); border: 1px solid var(--border); color: var(--text-secondary); }
.btn-outline:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.btn-xs { padding: 2px 8px; font-size: 11px; }
.btn-icon { padding: 6px 10px; }

/* Table */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th {
  background: #f7f8fa; padding: 8px 12px; text-align: left;
  border-bottom: 1px solid var(--border); font-weight: 600; color: var(--text-secondary);
  white-space: nowrap; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px;
}
tbody td { padding: 9px 12px; border-bottom: 1px solid #f2f3f5; }
tbody tr:hover { background: #f7f8fa; }
tbody tr:last-child td { border-bottom: none; }

/* Drag & Drop */
.drag-handle {
  cursor: grab; color: var(--text-tertiary); font-size: 14px; user-select: none;
  padding: 0 2px; transition: color 0.15s; display: inline-block; vertical-align: middle;
}
.drag-handle:hover { color: var(--primary); }
.drag-handle:active { cursor: grabbing; }
tr.dragging { opacity: 0.35; background: var(--primary-light) !important; }
tr.drag-over { border-top: 2px solid var(--primary) !important; }
tr.drag-over td { background: var(--primary-light); }

.reorder-hint {
  font-size: 12px; color: var(--text-secondary); margin-left: 12px;
  display: inline-flex; align-items: center; gap: 4px;
}

.badge {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px;
  font-size: 11px; font-weight: 600;
}
.badge-env { background: var(--success-light); color: #009a29; }
.badge-direct { background: var(--warning-light); color: #d25f00; }
.badge-none { background: #f2f3f5; color: var(--text-secondary); }
.badge-circuit { background: var(--danger-light); color: #c92e2e; }
.badge-ok { background: var(--success-light); color: #009a29; }

.code { font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: 12px; background: #f0f2f5; padding: 2px 6px; border-radius: 3px; }
.code-link { color: var(--primary); cursor: pointer; text-decoration: none; }
.code-link:hover { text-decoration: underline; background: #e8f0fe; }
.link-danger { color: var(--danger); cursor: pointer; text-decoration: none; font-size: 12px; }
.link-danger:hover { text-decoration: underline; }

/* Form */
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group.full { grid-column: 1 / -1; }
.form-group label { font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.3px; }
.form-group input, .form-group select, .form-group textarea {
  padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: 13px; transition: border-color 0.15s, box-shadow 0.15s; outline: none; font-family: inherit;
  background: #fafbfc;
}
.form-group input:focus, .form-group select:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(22,93,255,0.1); background: #fff; }
.form-group textarea { resize: vertical; min-height: 60px; }
.form-hint { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

.form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }

/* Toast */
.toast-container { position: fixed; top: 20px; right: 20px; z-index: 9999;
  display: flex; flex-direction: column; gap: 8px; }
.toast {
  padding: 12px 20px; border-radius: var(--radius); color: #fff; font-size: 13px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15); animation: slideIn 0.3s ease;
  max-width: 400px;
}
.toast-success { background: var(--success); }
.toast-error { background: var(--danger); }
.toast-info { background: var(--primary); }
.toast-warning { background: #ff7d00; }
@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* Loading */
.loading-area { position: relative; min-height: 60px; }
.loading-overlay {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(255,255,255,0.75); display: flex; align-items: center;
  justify-content: center; z-index: 10; border-radius: var(--radius);
  backdrop-filter: blur(2px);
}
.spinner {
  width: 28px; height: 28px; border: 3px solid var(--border);
  border-top-color: var(--primary); border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Modal */
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.4); display: flex; align-items: center;
  justify-content: center; z-index: 1000; animation: fadeIn 0.2s ease;
}
.modal {
  background: var(--card-bg); border-radius: var(--radius); padding: 24px;
  width: 90%; max-width: 700px; max-height: 85vh; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
}
.modal h2 { font-size: 18px; margin-bottom: 16px; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

/* Log */
.log-list { font-family: "SF Mono", Consolas, monospace; font-size: 12px;
  max-height: 400px; overflow-y: auto; }
.log-entry { padding: 6px 10px; border-bottom: 1px solid #f5f5f5; display: flex; gap: 12px; }
.log-entry:hover { background: #fafbfc; }
.log-time { color: var(--text-secondary); min-width: 140px; }
.log-action { min-width: 70px; font-weight: 600; }
.log-action.ADD { color: #2e7d32; }
.log-action.EDIT { color: #1565c0; }
.log-action.DELETE { color: #c62828; }
.log-action.SETENV { color: #6a1b9a; }
.log-action.TEST { color: #e65100; }
.log-action.REORDER { color: #00838f; }
.log-action.UNCIRCUIT { color: #4a148c; }
.log-target { min-width: 200px; }
.log-detail { color: var(--text-secondary); flex: 1; }

/* Key display toggle */
.key-hidden { font-family: monospace; color: var(--text-secondary); }
.key-visible { font-family: monospace; color: var(--text); }

/* Responsive */
@media (max-width: 768px) {
  body { padding: 12px; }
  .form-grid { grid-template-columns: 1fr; }
  .header { padding: 16px 20px; }
}

/* Key mode radio */
.radio-group { display: flex; gap: 16px; align-items: center; }
.radio-group label { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>

<div class="header">
  <div class="header-top">
    <div class="header-title">
      <h1>外部审查模型配置器</h1>
      <p><span class="dot"></span> 管理多供应商、多模型的审查配置与熔断状态</p>
    </div>
    <div class="header-actions">
      <button class="btn btn-outline btn-sm" onclick="refreshAll()">刷新</button>
      <button class="btn btn-primary btn-sm" onclick="openModelModal()">+ 新增模型</button>
      <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger);" onclick="clearCircuit('')" title="清除所有熔断">清除熔断</button>
    </div>
  </div>
  <div class="stats-bar" id="stats-bar">
    <div class="stat-item">
      <div class="stat-value" id="stat-total">—</div>
      <div class="stat-label">已配置模型</div>
    </div>
    <div class="stat-item">
      <div class="stat-value ok" id="stat-ok">—</div>
      <div class="stat-label">正常运行</div>
    </div>
    <div class="stat-item">
      <div class="stat-value bad" id="stat-circuit">—</div>
      <div class="stat-label">熔断中</div>
    </div>
    <div class="stat-item">
      <div class="stat-value" id="stat-last" style="font-size:14px;">—</div>
      <div class="stat-label">最近操作</div>
    </div>
  </div>
</div>

<div class="tabs">
  <button class="tab-btn active" onclick="switchTab('models')">模型列表</button>
  <button class="tab-btn" onclick="switchTab('env')">API Key 管理</button>
  <button class="tab-btn" onclick="switchTab('logs')">操作日志</button>
</div>

<!-- ========= Tab: 模型列表 ========= -->
<div id="tab-models" class="tab-panel active">
  <div class="card">
    <div class="card-header">
      <h2>
        已配置模型
        <span class="reorder-hint">&#x2630; 拖曳左侧手柄可排序优先级</span>
      </h2>
    </div>
    <div class="table-wrap loading-area" id="model-loading-area">
      <table id="model-table">
        <thead>
          <tr>
            <th style="width:36px;"></th><th>优先级</th><th>名称</th><th>模型ID</th><th>Base URL</th>
            <th>Key 方式</th><th>熔断状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody id="model-table-body"
          ondragover="event.preventDefault(); event.dataTransfer.dropEffect='move';"
          ondrop="onDrop(event)">
          <tr><td colspan="8" style="text-align:center;color:var(--text-secondary);">加载中...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- ========= Tab: API Key 管理 ========= -->
<div id="tab-env" class="tab-panel">
  <div class="card">
    <div class="card-header"><h2>设置环境变量（Windows setx）</h2></div>
    <div class="form-grid">
      <div class="form-group">
        <label>变量名 <span style="font-weight:normal;color:var(--text-secondary);">（不是模型名，如 SENSENOVA_API_KEY）</span></label>
        <input id="env-var-name" placeholder="例如 SENSENOVA_API_KEY" />
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">
          格式要求：只能包含字母、数字、下划线，不能以数字开头
        </div>
      </div>
      <div class="form-group">
        <label>变量值（API Key）</label>
        <input id="env-var-value" placeholder="sk-..." type="password" />
      </div>
    </div>
    <div class="form-hint" style="margin-top:8px;">
      通过 <span class="code">setx</span> 命令写入 Windows 用户环境变量，需重启终端后生效。
      Key 不会存储在配置文件中，安全性更高。
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" onclick="setEnvVar()">一键设置环境变量</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>当前系统环境变量（已知 Key）</h2></div>
    <div class="form-actions">
      <button class="btn btn-outline btn-sm" onclick="detectEnvVars()">检测环境变量</button>
    </div>
    <div id="env-list" class="loading-area" style="font-size:13px;color:var(--text-secondary);min-height:40px;">
      点击「检测」按钮查看当前已设置的环境变量
    </div>
  </div>
</div>

<!-- ========= Tab: 操作日志 ========= -->
<div id="tab-logs" class="tab-panel">
  <div class="card">
    <div class="card-header">
      <h2>操作日志</h2>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="date" id="log-date-from" style="width:130px;padding:4px 8px;border:1px solid #d0d5dd;border-radius:6px;font-size:13px;" />
        <span style="color:var(--text-secondary);">至</span>
        <input type="date" id="log-date-to" style="width:130px;padding:4px 8px;border:1px solid #d0d5dd;border-radius:6px;font-size:13px;" />
        <button class="btn btn-outline btn-sm" onclick="loadLogs()">查询</button>
      </div>
    </div>
    <div id="log-list" class="log-list loading-area">加载中...</div>
  </div>
</div>

<!-- ========= 模型编辑弹窗 ========= -->
<div id="model-modal" class="modal-overlay" style="display:none;" onclick="closeModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <h2 id="modal-title">新增模型</h2>
    <div class="form-grid">
      <div class="form-group">
        <label>名称 *</label>
        <input id="m-name" autocomplete="off" placeholder="自定义名称，如 sensenova-v4-flash" />
      </div>
      <div class="form-group">
        <label>模型ID *</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="m-model" autocomplete="off" placeholder="如 deepseek-v4-flash" style="flex:1;" />
          <button type="button" class="btn btn-outline btn-sm" onclick="listModels()" id="btn-list-models">获取模型列表</button>
        </div>
        <div id="model-list-area" style="display:none;margin-top:8px;max-height:150px;overflow-y:auto;background:#f5f7fa;border:1px solid #e5e6eb;border-radius:6px;padding:8px;font-size:13px;line-height:1.8;"></div>
      </div>
      <div class="form-group">
        <label>Base URL *</label>
        <input id="m-url" autocomplete="off" placeholder="https://token.sensenova.cn/v1" value="https://token.sensenova.cn/v1" />
      </div>
      <div class="form-group">
        <label>优先级（数字越小越优先）*</label>
        <input id="m-priority" autocomplete="off" type="number" placeholder="1" value="1" min="1" max="99" />
      </div>
      <div class="form-group full">
        <label>Key 来源方式</label>
        <div class="radio-group" style="margin-top:4px;">
          <label><input type="radio" name="key-mode" value="env" checked onchange="toggleKeyMode()" /> 环境变量（推荐）</label>
          <label><input type="radio" name="key-mode" value="direct" onchange="toggleKeyMode()" /> 直接写入文件</label>
          <label><input type="radio" name="key-mode" value="none" onchange="toggleKeyMode()" /> 无 Key（本地模型）</label>
        </div>
      </div>
      <div class="form-group" id="key-env-group">
        <label>环境变量名</label>
        <input id="m-api-key-env" autocomplete="off" placeholder="如 SENSENOVA_API_KEY" />
      </div>
      <div class="form-group" id="key-direct-group" style="display:none;">
        <label>API Key（将明文写入配置文件，注意安全）</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="m-api-key" autocomplete="off" placeholder="sk-..." type="password" style="flex:1;" />
          <span onclick="toggleKeyVisibility()" title="显示/隐藏" style="cursor:pointer;font-size:18px;opacity:0.6;user-select:none;" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='0.6'">&#x1F441;</span>
        </div>
      </div>
    </div>
    <div class="form-hint" style="margin-top:8px;">
      <strong>Key 优先级</strong>：环境变量 &gt; 直接写入。建议使用环境变量方式保管密钥。
    </div>
    <div class="form-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveModel()">保存</button>
    </div>
  </div>
</div>

<!-- Toast 容器 -->
<div class="toast-container" id="toast-container"></div>

<script>
// ============================================================
// 全局状态
// ============================================================
let modelsData = [];
let circuitData = {};
let editingName = null;   // 编辑模式下的原名称
const testingModels = new Set();  // 正在测试中的模型集合（保持"测试中…"按钮态，避免被自动刷新重置）

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  refreshAll();
  startAutoRefresh();
});

// ============================================================
// Tab 切换
// ============================================================
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab-btn[onclick*="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
  if (tab === 'logs') loadLogs();
  if (tab === 'env') detectEnvVars();
}

// ============================================================
// 加载动画
// ============================================================
function showLoading(areaId) {
  const el = document.getElementById(areaId);
  if (!el || document.getElementById(areaId + '-spinner')) return;
  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';
  overlay.id = areaId + '-spinner';
  overlay.innerHTML = '<div class="spinner"></div>';
  el.appendChild(overlay);
}
function hideLoading(areaId) {
  const el = document.getElementById(areaId + '-spinner');
  if (el) el.remove();
}

// ============================================================
// 统计面板
// ============================================================
function updateStats() {
  const total = modelsData.length;
  const circuits = circuitData.circuits || {};
  const circuitCount = Object.keys(circuits).filter(k => circuits[k]).length;
  const okCount = total - circuitCount;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-ok').textContent = okCount;
  document.getElementById('stat-circuit').textContent = circuitCount;

  // 更新颜色
  document.getElementById('stat-circuit').className =
    'stat-value ' + (circuitCount > 0 ? 'bad' : '');

  // 最近操作
  try {
    const logs = JSON.parse(localStorage.getItem('_config_last_action') || 'null');
    if (logs) {
      const elapsed = Math.floor((Date.now() - logs.ts) / 60000);
      const timeStr = elapsed < 1 ? '刚刚' : elapsed < 60 ? `${elapsed}分钟前` : `${Math.floor(elapsed/60)}小时前`;
      document.getElementById('stat-last').textContent = timeStr;
    } else {
      document.getElementById('stat-last').textContent = '—';
    }
  } catch(e) {
    document.getElementById('stat-last').textContent = '—';
  }
}
function recordLastAction() {
  localStorage.setItem('_config_last_action', JSON.stringify({ts: Date.now()}));
}

// ============================================================
// 数据加载
// ============================================================
async function refreshAll(caller) {
  showLoading('model-loading-area');
  await Promise.all([loadModels(), loadCircuit()]);
  hideLoading('model-loading-area');
  renderModelTable();
  if (caller) recordLastAction();
  updateStats();
}

async function loadModels() {
  try {
    const r = await fetch('/api/models');
    modelsData = await r.json();
    // 同步正在测试的模型集合（覆盖"手动刷新打断测试"后从后端恢复的场景）
    applyTestingStatus(modelsData);
    // 按优先级排序
    modelsData.sort((a, b) => (a.priority || 99) - (b.priority || 99));
  } catch (e) {
    toast('加载模型列表失败: ' + e.message, 'error');
  }
}

function applyTestingStatus(models) {
  testingModels.clear();
  models.forEach(m => { if (m.testing) testingModels.add(m.name); });
}

async function syncTestingStatus() {
  try {
    const r = await fetch('/api/models');
    applyTestingStatus(await r.json());
  } catch (e) { /* 静默：失败不影响用户操作 */ }
}

async function loadCircuit() {
  try {
    const r = await fetch('/api/circuit');
    circuitData = await r.json();
  } catch (e) { circuitData = { circuits: {} }; }
}

// 持续自动刷新熔断状态（每 5 秒轮询一次）
// 覆盖场景：测试失败、网关运行中自动熔断、以及"手动刷新打断了测试轮询"的边界
let autoRefreshTimer = null;
const AUTO_REFRESH_MS = 5000;
async function autoRefreshCircuit() {
  try {
    await loadCircuit();
    await syncTestingStatus();  // 同步测试状态，清掉已完成的测试，避免按钮卡在"测试中…"
    // 编辑弹窗打开时不重渲染表格，避免干扰正在进行的编辑
    if (editingName === null) {
      renderModelTable();
    }
    updateStats();
  } catch (e) { /* 静默：轮询失败不影响用户操作 */ }
}
function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(autoRefreshCircuit, AUTO_REFRESH_MS);
}

// ============================================================
// 模型表格渲染
// ============================================================
function renderModelTable() {
  const tbody = document.getElementById('model-table-body');
  if (!modelsData.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary);padding:32px;">暂无配置模型，点击「新增模型」添加</td></tr>';
    return;
  }
  tbody.innerHTML = modelsData.map((m, idx) => {
    const circuits = circuitData.circuits || {};
    const c = circuits[m.name];
    const circuitBadge = c
      ? `<span class="badge badge-circuit" title="上次失败: ${c.last_error || ''}">熔断中</span>
         <button class="btn btn-outline btn-sm" style="margin-left:4px;" onclick="clearCircuit('${esc(m.name)}')" title="手动清除熔断">清除</button>`
      : '<span style="color:var(--success);font-size:12px;">正常</span>';

    let keyBadge = '';
    if (m.api_key_env && m.api_key) {
      keyBadge = '<span class="badge badge-env">环境变量优先</span>';
    } else if (m.api_key_env) {
      keyBadge = `<span class="badge badge-env">环境变量: ${esc(m.api_key_env)}</span>`;
    } else if (m.api_key) {
      keyBadge = '<span class="badge badge-direct">直写文件</span>';
    } else {
      keyBadge = '<span class="badge badge-none">无 Key</span>';
    }

    const hasKey = m.api_key_env || m.api_key;
    const keyEye = hasKey
      ? ` <span onclick="event.stopPropagation();viewKey('${esc(m.name)}')" title="查看并复制 Key" style="cursor:pointer;font-size:14px;opacity:0.6;" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='0.6'">&#x1F441;</span>`
      : '';

    const baseUrl = m.base_url || 'https://token.sensenova.cn/v1';

    return `<tr draggable="true"
      data-model-name="${esc(m.name)}"
      ondragstart="onDragStart(event)"
      ondragover="onDragOver(event)"
      ondragleave="onDragLeave(event)"
      ondrop="onDrop(event)"
      ondragend="onDragEnd(event)">
      <td><span class="drag-handle" title="拖曳排序">&#x2630;</span></td>
      <td><strong>#${m.priority || '?'}</strong></td>
      <td><strong>${esc(m.name)}</strong></td>
      <td><span class="code">${esc(m.model || '')}</span></td>
      <td style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(baseUrl)}">${esc(baseUrl)}</td>
      <td>${keyBadge}${keyEye}</td>
      <td>${circuitBadge}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-outline btn-sm" onclick="editModel('${esc(m.name)}')">编辑</button>
        <button class="btn btn-outline btn-sm" onclick="copyModel('${esc(m.name)}')">复制</button>
        ${testingModels.has(m.name)
          ? '<button class="btn btn-outline btn-sm" disabled style="opacity:0.6;cursor:not-allowed;">测试中…</button>'
          : `<button class="btn btn-outline btn-sm" onclick="testModel(this, '${esc(m.name)}')">测试</button>`}
        <button class="btn btn-danger btn-sm" onclick="deleteModel('${esc(m.name)}')">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ============================================================
// 拖曳排序
// ============================================================
let dragSrcName = null;

function onDragStart(e) {
  dragSrcName = e.target.closest('tr').dataset.modelName;
  e.target.closest('tr').classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragSrcName);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.target.closest('tr');
  if (row && row.dataset.modelName !== dragSrcName) {
    // 清除其他行的 drag-over
    document.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
  }
}

function onDragLeave(e) {
  const row = e.target.closest('tr');
  if (row) row.classList.remove('drag-over');
}

function onDragEnd(e) {
  document.querySelectorAll('tr.dragging').forEach(r => r.classList.remove('dragging'));
  document.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
}

async function onDrop(e) {
  e.preventDefault();
  let targetRow = e.target.closest('tr');

  // 拖到表格空白区域（tbody 而非 tr）：追加到末尾
  if (!targetRow) {
    const rows = document.querySelectorAll('#model-table-body tr[draggable]');
    if (rows.length === 0) return;
    // 取最后一行作为"插入到末尾"的参照
    targetRow = rows[rows.length - 1];
    if (!targetRow) return;
    // 标记为"追加模式"：src 移到 targetRow 之后
    const targetName = targetRow.dataset.modelName;
    if (!targetName || targetName === dragSrcName) return;
    const srcIdx = modelsData.findIndex(m => m.name === dragSrcName);
    const tgtIdx = modelsData.findIndex(m => m.name === targetName);
    if (srcIdx === -1 || tgtIdx === -1) return;
    const [moved] = modelsData.splice(srcIdx, 1);
    // 追加到末尾
    modelsData.push(moved);
  } else {
    const targetName = targetRow.dataset.modelName;
    if (!targetName || targetName === dragSrcName) return;

    // 重新排序 modelsData
    const srcIdx = modelsData.findIndex(m => m.name === dragSrcName);
    let tgtIdx = modelsData.findIndex(m => m.name === targetName);
    if (srcIdx === -1 || tgtIdx === -1) return;

    const [moved] = modelsData.splice(srcIdx, 1);
    // 修复：src 在 target 之前移除后，target 索引左移一位
    if (srcIdx < tgtIdx) tgtIdx--;
    modelsData.splice(tgtIdx, 0, moved);
  }

  // 重分配 priority
  modelsData.forEach((m, i) => { m.priority = i + 1; });

  // 立即渲染（乐观更新）
  renderModelTable();

  // 持久化到后端
  try {
    const r = await fetch('/api/models/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: modelsData.map(m => m.name) })
    });
    const result = await r.json();
    if (result.ok) {
      toast('排序已保存');
      recordLastAction();
      updateStats();
    } else {
      toast('排序保存失败: ' + (result.error || ''), 'error');
      await refreshAll(); // 回退
    }
  } catch (e) {
    toast('排序请求失败: ' + e.message, 'error');
    await refreshAll();
  }
}

// ============================================================
// 模型 CRUD
// ============================================================
function resetModelForm() {
  // 新增/关闭时清空表单，防止上一次的名称、模型列表、placeholder 等残留
  document.getElementById('m-name').value = '';
  document.getElementById('m-name').placeholder = '自定义名称，如 sensenova-v4-flash';
  document.getElementById('m-model').value = '';
  document.getElementById('model-list-area').innerHTML = '';
  document.getElementById('model-list-area').style.display = 'none';
  document.getElementById('m-url').value = 'https://token.sensenova.cn/v1';
  document.getElementById('m-priority').value = modelsData.length + 1;
  document.getElementById('m-api-key-env').value = '';
  document.getElementById('m-api-key').value = '';
  document.querySelector('input[name="key-mode"][value="env"]').checked = true;
}

function openModelModal(name) {
  editingName = name || null;
  document.getElementById('modal-title').textContent = name ? '编辑模型' : '新增模型';

  if (name) {
    const m = modelsData.find(x => x.name === name);
    if (m) {
      document.getElementById('m-name').value = m.name || '';
      document.getElementById('m-model').value = m.model || '';
      document.getElementById('m-url').value = m.base_url || 'https://token.sensenova.cn/v1';
      document.getElementById('m-priority').value = m.priority || 1;
      document.getElementById('m-api-key-env').value = m.api_key_env || '';
      document.getElementById('m-api-key').value = m.api_key || '';

      if (m.api_key_env && m.api_key) {
        document.querySelector('input[name="key-mode"][value="env"]').checked = true;
      } else if (m.api_key_env) {
        document.querySelector('input[name="key-mode"][value="env"]').checked = true;
      } else if (m.api_key) {
        document.querySelector('input[name="key-mode"][value="direct"]').checked = true;
      } else {
        document.querySelector('input[name="key-mode"][value="none"]').checked = true;
      }
    }
  } else {
    resetModelForm();
  }
  toggleKeyMode();
  document.getElementById('model-modal').style.display = 'flex';
}

function toggleKeyMode() {
  const mode = document.querySelector('input[name="key-mode"]:checked').value;
  document.getElementById('key-env-group').style.display = (mode === 'env') ? '' : 'none';
  document.getElementById('key-direct-group').style.display = (mode === 'direct') ? '' : 'none';
}

function toggleKeyVisibility() {
  const input = document.getElementById('m-api-key');
  const icon = input.parentElement.querySelector('span');
  if (input.type === 'password') {
    input.type = 'text';
    icon.title = '隐藏';
  } else {
    input.type = 'password';
    icon.title = '显示';
  }
}

function closeModal(e) {
  // 任何由点击 overlay 背景触发的调用（e 存在）一律不关闭，
  // 避免"切换窗口再切回浏览器时激活点击落到背景""复制粘贴右键操作点到背景"等误触丢失已填内容。
  // 新增(editingName===null)与编辑(editingName!==null)模式都受此保护。
  // 只有"取消"/"保存成功"按钮的无参调用才真正关闭弹窗。
  if (e) return;
  document.getElementById('model-modal').style.display = 'none';
  editingName = null;
  // 关闭时重置表单，避免下次打开（尤其是新增模式）时残留上次数据
  resetModelForm();
}

async function saveModel() {
  const name = document.getElementById('m-name').value.trim();
  const modelId = document.getElementById('m-model').value.trim();
  if (!name) { toast('请输入模型名称', 'error'); return; }
  if (!modelId) { toast('请输入模型ID', 'error'); return; }

  const keyMode = document.querySelector('input[name="key-mode"]:checked').value;
  const body = {
    name: name,
    model: modelId,
    base_url: document.getElementById('m-url').value.trim() || 'https://token.sensenova.cn/v1',
    priority: parseInt(document.getElementById('m-priority').value) || 99,
    review_types: ["all"]
  };
  if (keyMode === 'env') {
    body.api_key_env = document.getElementById('m-api-key-env').value.trim();
    body.api_key = '';  // 清空直写 Key
  } else if (keyMode === 'direct') {
    body.api_key_env = '';
    body.api_key = document.getElementById('m-api-key').value.trim();
  } else {
    body.api_key_env = '';
    body.api_key = '';
  }

  try {
    const r = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await r.json();
    if (result.ok) {
      toast(`模型 ${result.action}成功`);
      closeModal();
      await refreshAll('save');
    } else {
      toast(result.error || '操作失败', 'error');
    }
  } catch (e) {
    toast('请求失败: ' + e.message, 'error');
  }
}

function editModel(name) { openModelModal(name); }

function generateUniqueModelName(baseName) {
  const existing = new Set(modelsData.map(m => m.name));
  // 编辑模式下，原名称不算重复（保存时会覆盖）
  if (editingName && baseName === editingName) return baseName;
  if (!existing.has(baseName)) return baseName;
  let suffix = 1;
  let candidate = baseName + ' (副本)';
  while (existing.has(candidate)) {
    suffix++;
    candidate = baseName + ' (副本' + suffix + ')';
  }
  return candidate;
}

function selectModel(id) {
  document.getElementById('m-model').value = id;
  document.getElementById('model-list-area').style.display = 'none';
  document.getElementById('m-name').value = generateUniqueModelName(id);
}

async function listModels() {
  const baseUrl = document.getElementById('m-url').value.trim();
  if (!baseUrl) { toast('请先填写 Base URL', 'error'); return; }

  const btn = document.getElementById('btn-list-models');
  const area = document.getElementById('model-list-area');
  const origText = btn.textContent;
  btn.textContent = '获取中...';
  btn.disabled = true;

  // 收集 API Key
  const keyMode = document.querySelector('input[name="key-mode"]:checked').value;
  const body = { base_url: baseUrl };
  if (keyMode === 'env') {
    body.api_key_env = document.getElementById('m-api-key-env').value.trim();
  } else if (keyMode === 'direct') {
    body.api_key = document.getElementById('m-api-key').value.trim();
  }

  try {
    const r = await fetch('/api/list-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await r.json();
    if (result.ok && result.models && result.models.length > 0) {
      const items = result.models.map(id =>
        `<span style="cursor:pointer;color:#165dff;display:inline-block;margin:0 6px 2px 0;padding:1px 6px;border-radius:3px;background:#e8f0ff;"
              onclick="selectModel('${id.replace(/'/g, "\\'")}');"
              title="点击填入">${id}</span>`
      ).join(' ');
      area.innerHTML = items;
      area.style.display = 'block';
      toast(`获取到 ${result.models.length} 个模型，点击即可填入`, 'success');
    } else {
      area.style.display = 'none';
      toast(result.error || '该服务不支持列出模型，请手动输入', 'warning');
    }
  } catch (e) {
    area.style.display = 'none';
    toast('请求失败: ' + e.message, 'error');
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

function copyModel(name) {
  const src = modelsData.find(m => m.name === name);
  if (!src) return;
  // 打开新增模式的弹窗，预填所有字段（名称为空，建议改名）
  openModelModal(null);
  document.getElementById('m-name').value = '';
  document.getElementById('m-name').placeholder = `${src.name} (副本)`;
  document.getElementById('m-model').value = src.model || '';
  document.getElementById('m-url').value = src.base_url || 'https://token.sensenova.cn/v1';
  document.getElementById('m-priority').value = src.priority || (modelsData.length + 1);
  document.getElementById('m-api-key-env').value = src.api_key_env || '';
  document.getElementById('m-api-key').value = src.api_key || '';

  if (src.api_key && src.api_key_env) {
    document.querySelector('input[name="key-mode"][value="env"]').checked = true;
  } else if (src.api_key_env) {
    document.querySelector('input[name="key-mode"][value="env"]').checked = true;
  } else if (src.api_key) {
    document.querySelector('input[name="key-mode"][value="direct"]').checked = true;
  } else {
    document.querySelector('input[name="key-mode"][value="none"]').checked = true;
  }
  toggleKeyMode();
  toast(`已复制「${name}」配置，请填写新名称后保存`, 'info');
}

async function viewKey(name) {
  try {
    const r = await fetch('/api/model-key?name=' + encodeURIComponent(name));
    const result = await r.json();
    if (result.ok) {
      await navigator.clipboard.writeText(result.key);
      toast(`Key 已复制到剪贴板（来源: ${result.source}）`, 'success');
    } else {
      toast(result.error || '无法获取 Key', 'warning');
    }
  } catch (e) {
    toast('请求失败: ' + e.message, 'error');
  }
}

async function deleteModel(name) {
  if (!confirm(`确定删除模型「${name}」？此操作不可撤销。`)) return;
  try {
    const r = await fetch('/api/models/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const result = await r.json();
    if (result.ok) {
      toast('删除成功');
      await refreshAll('delete');
    } else {
      toast(result.error || '删除失败', 'error');
    }
  } catch (e) {
    toast('请求失败: ' + e.message, 'error');
  }
}

async function clearCircuit(name) {
  try {
    const r = await fetch('/api/clear-circuit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const result = await r.json();
    if (result.ok) {
      toast(result.action);
      await refreshAll('uncircuit');
    } else {
      toast(result.error || '操作失败', 'error');
    }
  } catch (e) {
    toast('请求失败: ' + e.message, 'error');
  }
}

async function testModel(btn, name) {
  const origText = btn ? btn.textContent : '测试';
  testingModels.add(name);
  if (btn) { btn.textContent = '测试中…'; btn.disabled = true; }
  renderModelTable();  // 整行一致渲染为禁用态，避免被自动刷新重置
  try {
    const r = await fetch('/api/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const result = await r.json();
    if (!result.ok) {
      toast('连通测试失败: ' + result.error, 'error');
      if (btn) { btn.textContent = origText; btn.disabled = false; }
      return;
    }
    // 异步执行：轮询状态直到完成
    pollTestStatus(btn, name, origText);
  } catch (e) {
    toast('请求失败: ' + e.message, 'error');
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

async function pollTestStatus(btn, name, origText) {
  try {
    const r = await fetch('/api/test-status?name=' + encodeURIComponent(name));
    const result = await r.json();
    const st = (result && result.status) || {};
    if (st.status === 'testing') {
      setTimeout(() => pollTestStatus(btn, name, origText), 800);
      return;
    }
    if (st.status === 'ok') {
      toast('连通测试通过: ' + (st.message || '').substring(0, 200), 'success');
    } else if (st.status === 'fail') {
      toast('连通测试失败: ' + st.error, 'error');
    } else {
      toast('测试状态未知', 'warning');
    }
    // 终态：先移除 testing 标记，再刷新（按钮恢复为普通"测试"）
    testingModels.delete(name);
    // 刷新熔断状态，让列表显示最新错误/正常（即时刷新，持续轮询会兜底）
    await loadCircuit();
    renderModelTable();
    updateStats();
  } catch (e) {
    toast('状态轮询失败: ' + e.message, 'error');
    testingModels.delete(name);
    if (editingName === null) renderModelTable();
  } finally {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

// ============================================================
// 环境变量
// ============================================================
async function setEnvVar() {
  const varName = document.getElementById('env-var-name').value.trim();
  const varValue = document.getElementById('env-var-value').value.trim();
  if (!varName || !varValue) { toast('请填写变量名和值', 'error'); return; }

  try {
    const r = await fetch('/api/set-env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ var_name: varName, var_value: varValue })
    });
    const result = await r.json();
    if (result.ok) {
      toast(result.message, 'success');
      document.getElementById('env-var-value').value = '';
      detectEnvVars();
    } else {
      toast(result.message, 'error');
    }
  } catch (e) {
    toast('请求失败: ' + e.message, 'error');
  }
}

function fillEnvVar(name) {
  document.getElementById('env-var-name').value = name;
  document.getElementById('env-var-value').value = '';
  document.getElementById('env-var-value').focus();
  // 自动切换到 API Key 管理 Tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[onclick*="tab-key"]').classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  document.getElementById('tab-key').style.display = 'block';
}

async function deleteEnvVar(name) {
  if (!confirm(`确定要删除环境变量 ${name} 吗？\n\n删除后需重启终端生效。`)) return;
  try {
    const r = await fetch('/api/env-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ var_name: name })
    });
    const result = await r.json();
    if (result.ok) {
      toast(result.message, 'success');
      detectEnvVars();  // 刷新列表
    } else {
      toast(result.message, 'error');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function detectEnvVars() {
  const container = document.getElementById('env-list');
  // 只扫描模型配置中引用的环境变量
  const modelEnvNames = [...new Set(modelsData.map(m => m.api_key_env).filter(Boolean))];
  if (!modelEnvNames.length) {
    container.innerHTML = '<p style="color:var(--text-secondary);">暂未配置任何环境变量引用。先在模型列表中添加使用环境变量的模型。</p>';
    return;
  }
  container.innerHTML = '<p style="color:var(--text-secondary);">正在扫描注册表...</p>';
  try {
    const r = await fetch('/api/env-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ var_names: modelEnvNames })
    });
    const result = await r.json();
    if (!result.ok) {
      container.innerHTML = '<p style="color:var(--danger);">扫描失败: ' + esc(result.message || '未知错误') + '</p>';
      return;
    }
    const envVars = result.vars || {};
    const varNames = Object.keys(envVars);
    if (!varNames.length) {
      container.innerHTML = '<p style="color:var(--text-secondary);">注册表中未找到匹配的环境变量。</p>';
      return;
    }
    // 按变量名排序
    varNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    container.innerHTML = '<table style="margin-top:8px;"><thead><tr><th>变量名</th><th>值（脱敏）</th><th>引用模型</th><th>操作</th></tr></thead><tbody>'
      + varNames.map(n => {
        const usedBy = modelsData.filter(m => m.api_key_env === n).map(m => m.name).join(', ') || '<span style="color:var(--text-secondary);">无</span>';
        return `<tr><td><a href="#" onclick="fillEnvVar('${esc(n)}');return false;" class="code code-link" title="点击填入编辑表单">${esc(n)}</a></td>
          <td style="font-family:monospace;font-size:12px;">${envVars[n] ? esc(envVars[n]) : '<span style="color:var(--danger);">未设置</span>'}</td>
          <td style="font-size:12px;">${usedBy}</td>
          <td><a href="#" onclick="deleteEnvVar('${esc(n)}');return false;" class="link-danger" title="删除此环境变量">删除</a></td></tr>`;
      }).join('') + '</tbody></table>';
  } catch (e) {
    container.innerHTML = '<p style="color:var(--danger);">扫描失败: ' + esc(e.message) + '</p>';
  }
}

// ============================================================
// 日志
// ============================================================
async function loadLogs() {
  showLoading('log-list');
  try {
    const dateFrom = document.getElementById('log-date-from').value;
    const dateTo = document.getElementById('log-date-to').value;
    let url = '/api/logs?limit=100';
    if (dateFrom) url += '&date_from=' + encodeURIComponent(dateFrom);
    if (dateTo) url += '&date_to=' + encodeURIComponent(dateTo);
    const r = await fetch(url);
    const logs = await r.json();
    const container = document.getElementById('log-list');
    if (!logs.length) {
      container.innerHTML = '<p style="padding:16px;color:var(--text-secondary);">暂无操作日志</p>';
      return;
    }
    container.innerHTML = logs.reverse().map(l => `
      <div class="log-entry">
        <span class="log-time">${esc(l.time)}</span>
        <span class="log-action ${esc(l.action)}">${esc(l.action)}</span>
        <span class="log-target">${esc(l.target)}</span>
        <span class="log-detail">${esc(l.detail)}</span>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('log-list').innerHTML = '<p style="color:var(--danger);">加载失败: ' + esc(e.message) + '</p>';
  } finally {
    hideLoading('log-list');
  }
}

// ============================================================
// Toast 通知
// ============================================================
function toast(msg, type) {
  type = type || 'info';
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 3000);
  setTimeout(() => el.remove(), 3500);
}
</script>
</body>
</html>"""


# ============================================================
# 启动
# ============================================================

def find_free_port(start=8769):
    """找可用端口"""
    for port in range(start, start + 20):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind((HOST, port))
                return port
        except OSError:
            continue
    return start


def open_browser(port):
    """延迟打开浏览器"""
    time.sleep(0.5)
    webbrowser.open(f"http://{HOST}:{port}")


def main():
    port = find_free_port(PORT)
    server = HTTPServer((HOST, port), ConfiguratorHandler)

    print(f"\n{'='*60}")
    print(f"  外部审查模型配置器")
    print(f"  地址: http://{HOST}:{port}")
    print(f"  配置文件: {CONFIG_PATH}")
    print(f"  日志文件: {LOG_PATH}")
    print(f"  按 Ctrl+C 停止服务")
    print(f"{'='*60}\n")

    append_log("START", f"port:{port}", "配置器服务启动")

    # 自动打开浏览器
    threading.Thread(target=open_browser, args=(port,), daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
        append_log("STOP", f"port:{port}", "配置器服务关闭")
        server.server_close()


if __name__ == "__main__":
    main()
