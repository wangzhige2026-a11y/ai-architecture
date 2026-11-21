# -*- coding: utf-8 -*-
"""
================================================================
 server.py —— 知筑 Web 版后端服务
================================================================
 目标：把现有的 Electron 桌面版原样搬到浏览器，用户访问一个网址
       即可使用，无需安装任何东西。

 设计原则：
   1. 不修改任何现有业务代码（main.py / ai_tools.py / python_bridge.py）
   2. 完整复用 python_bridge.py 的 13 个 HANDLERS
   3. 前端代码零改动，只替换 preload.js 那一层桥

 架构对照：
   桌面版： renderer ──Electron IPC──> main.js ──stdin/stdout──> python_bridge
   Web版：  renderer ──HTTP POST─────> server.py ──直接函数调用──> python_bridge

 通信协议：
   POST /api/invoke   {"cmd": "...", "payload": {...}}  -> 立即返回 {ok: true}
   GET  /api/events   Server-Sent Events 流，推送后端事件
   GET  /api/report   读取 output/architecture_report.json
   GET  /api/files    列出 output/ 目录文件

 运行：
   pip install flask
   python web/server.py
   浏览器打开 http://127.0.0.1:8000
================================================================
"""

import os
import sys
import json
import hmac
import hashlib
import secrets
import queue
import threading
import traceback
import time
import urllib.parse

# ---- 路径准备：让 python_bridge 及其依赖可被导入 ----
WEB_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(WEB_DIR)
WORKSPACE_APP = os.path.join(PROJECT_ROOT, "workspace_app")
for p in (PROJECT_ROOT, WORKSPACE_APP):
    if p not in sys.path:
        sys.path.insert(0, p)

try:
    from flask import Flask, request, jsonify, Response, send_from_directory
except ImportError:
    print("缺少依赖，请先运行：pip install flask")
    sys.exit(1)

import config                # noqa: E402  读取 .env / 环境变量
import python_bridge as pb   # noqa: E402  复用全部业务 handler


# =========================================================
# 事件总线
#   桌面版用 stdout 逐行输出事件，Web 版改为放进队列，
#   再通过 SSE 推给浏览器。每个浏览器连接一个独立队列。
# =========================================================
class EventBus:
    def __init__(self):
        self._clients = []
        self._lock = threading.Lock()

    def register(self):
        q = queue.Queue(maxsize=1000)
        with self._lock:
            self._clients.append(q)
        return q

    def unregister(self, q):
        with self._lock:
            if q in self._clients:
                self._clients.remove(q)

    def publish(self, event):
        with self._lock:
            targets = list(self._clients)
        for q in targets:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass  # 慢客户端丢弃，不阻塞业务


BUS = EventBus()


def web_emit(event):
    """替换 python_bridge.emit —— 事件不再写 stdout，而是进事件总线。"""
    BUS.publish(event)


# 关键一步：把 python_bridge 的输出函数换成我们的，业务代码完全不用改
pb.emit = web_emit


app = Flask(__name__, static_folder=None)


# =========================================================
# 静态页面
# =========================================================
STATIC_DIR = os.path.join(WEB_DIR, "static")


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


# =========================================================
# 指令入口：对应桌面版的 ipcMain.handle('invoke')
# =========================================================
@app.route("/api/invoke", methods=["POST"])
def api_invoke():
    # ---- 限流（默认关闭，配置 ZHIZHU_RATE_* 环境变量后启用）----
    try:
        import rate_limit as _rl
        _ok, _retry, _reason = _rl.allow_detail(request.remote_addr or "unknown")
        if not _ok:
            resp = jsonify({"ok": False, "error": _reason or "请求过于频繁，请稍后再试"})
            resp.status_code = 429
            if _retry:
                resp.headers["Retry-After"] = str(int(_retry))
            return resp
    except ImportError:
        pass  # 限流模块不存在时静默跳过

    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "请求必须是JSON对象"}), 400
    cmd = body.get("cmd")
    payload = body.get("payload") or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "payload必须是JSON对象"}), 400

    # ---- 安全拦截：网页版禁止把访客设置写入服务端 .env ----
    # 桌面版（Electron）本机单用户，写 .env 是正确的；网页版是共享多访客，
    # 若放行 save_settings / reset_settings 会导致访客的配置写入共享容器 .env
    # （串号 / 滥用 / 数据易失）。因此网页版对这两个指令一律只返回
    # web_local_only，不调用后端写盘逻辑，也绝不回传任何密钥。
    if cmd == "save_settings":
        web_emit({
            "type": "result",
            "cmd": "save_settings",
            "payload": {
                "saved": False,
                "reason": "web_local_only",
                "message": "网页版配置仅保存在你的浏览器，不会写入服务器。",
            },
        })
        return jsonify({"ok": True})

    if cmd == "reset_settings":
        web_emit({
            "type": "result",
            "cmd": "reset_settings",
            "payload": {
                "reset": False,
                "reason": "web_local_only",
                "message": "网页版无法重置服务端配置；如需清除本机记忆，请在设置页点「清空本地缓存」。",
            },
        })
        return jsonify({"ok": True})

    handler = pb.HANDLERS.get(cmd)
    if not handler:
        return jsonify({"ok": False, "error": f"未知指令：{cmd}"}), 400

    # 请求级 AI 配置覆盖（用完即弃，不落盘）：
    # 前端把本机自定义 API 配置随单次请求传入 ai_override，服务端在该线程内
    # set 后调用 handler，finally 清除。线程局部 → 天然互不干扰（不串号）。
    ai_override = body.get("ai_override")
    override_cfg = None

    def _local_or_private(u: str) -> bool:
        """判断 base_url 是否指向本地/内网 —— 云端容器访问不到，必须拒绝。"""
        import ipaddress
        from urllib.parse import urlparse
        try:
            h = (urlparse(u).hostname or "").lower()
        except Exception:
            return False
        if not h:
            return False
        if h in ("localhost", "0.0.0.0", "::1", "host.docker.internal"):
            return True
        if h.endswith(".local") or h.endswith(".internal"):
            return True
        try:
            ip = ipaddress.ip_address(h)
        except ValueError:
            return False
        return bool(ip.is_private or ip.is_loopback or ip.is_link_local)

    if isinstance(ai_override, dict):
        base_url = str(ai_override.get("base_url") or "").strip()
        model = str(ai_override.get("model") or "").strip()
        api_key = str(ai_override.get("api_key") or "").strip()
        name = str(ai_override.get("name") or "").strip()
        # 只接受字段完整、base_url 为 http(s)、api_key 非空的覆盖；否则忽略
        if (base_url and model and api_key
                and (base_url.startswith("http://") or base_url.startswith("https://"))):
            if _local_or_private(base_url):
                # 明确拒绝：不发注定失败的请求，也不让失败伪装成"配置未生效"
                web_emit({
                    "type": "error",
                    "level": "warn",
                    "cmd": cmd,
                    "message": ("网页版无法访问本地/内网地址（%s）：模型调用由云端服务器发起，"
                                "连不到你电脑上的地址。本地模型请使用桌面版工作台；"
                                "网页版请改用公网可访问的 API。" % base_url),
                })
            else:
                override_cfg = {"base_url": base_url, "model": model,
                                "api_key": api_key, "name": name or "custom"}

    # 新检测记录不经过共享SSE总线，避免向其他浏览器广播原文与结果。
    if cmd in {"list_inspection_methods", "ask_inspection_method", "process_inspection_records", "save_inspection_records"}:
        request_id = str(payload.get("request_id") or "")[:100]
        if payload.get("engine") == "ai" and ai_override is not None and not override_cfg:
            message = "本次AI配置不完整或地址不适用于Web入口，请核对设置；不会改用其他服务发送记录"
            return jsonify({"ok": False, "error": message, "event": {"type": "error", "cmd": cmd,
                            "request_id": request_id, "message": message}})
        if override_cfg:
            config.set_ai_override(override_cfg)
        try:
            import inspection_service
            result = inspection_service.dispatch(cmd, payload)
            return jsonify({"ok": True, "event": {"type": "result", "cmd": cmd,
                            "request_id": request_id, "payload": result}})
        except Exception as exc:
            message = str(exc) if isinstance(exc, ValueError) else "检测基础处理未完成，请检查输入后重试"
            return jsonify({"ok": False, "event": {"type": "error", "cmd": cmd,
                            "request_id": request_id, "message": message}, "error": message})
        finally:
            if override_cfg:
                config.clear_ai_override()

    # 业务可能耗时较久（调模型、抓知乎），放后台线程，事件通过 SSE 实时回流
    def run():
        if override_cfg:
            config.set_ai_override(override_cfg)
        try:
            handler(payload)
        except Exception as e:
            web_emit({
                "type": "error",
                "cmd": cmd,
                "message": f"{type(e).__name__}: {e}",
            })
            traceback.print_exc()
        finally:
            if override_cfg:
                config.clear_ai_override()

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"ok": True})


# =========================================================
# 事件流：对应桌面版的 ipcRenderer.on('py:event')
# =========================================================
@app.route("/api/events")
def api_events():
    def stream():
        q = BUS.register()
        try:
            # 先发一个就绪信号，让前端把"后端连接中…"改成已连接
            yield "data: " + json.dumps(
                {"type": "log", "level": "info", "message": "Web 后端已连接"},
                ensure_ascii=False,
            ) + "\n\n"
            while True:
                try:
                    ev = q.get(timeout=20)
                    yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"   # 心跳，防止代理断开
        finally:
            BUS.unregister(q)

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # 关闭 nginx 缓冲，保证实时
            "Connection": "keep-alive",
        },
    )


# =========================================================
# 文件能力：对应桌面版的 fs:readReport / fs:listOutput
#   注意：Web 版不提供 openPath（打开本地文件夹），
#         浏览器没有这个权限，前端会自动降级。
# =========================================================
@app.route("/api/report")
def api_report():
    f = os.path.join(PROJECT_ROOT, "output", "architecture_report.json")
    try:
        with open(f, "r", encoding="utf-8") as fp:
            return jsonify(json.load(fp))
    except Exception:
        return jsonify(None)


@app.route("/api/files")
def api_files():
    d = os.path.join(PROJECT_ROOT, "output")
    items = []
    try:
        for n in os.listdir(d):
            fp = os.path.join(d, n)
            if os.path.isfile(fp):
                st = os.stat(fp)
                items.append({
                    "name": n,
                    "path": n,               # Web 版只给文件名，不暴露绝对路径
                    "size": st.st_size,
                    "mtime": st.st_mtime * 1000,
                })
        items.sort(key=lambda x: x["mtime"], reverse=True)
    except Exception:
        pass
    return jsonify(items)


@app.route("/api/download/<path:name>")
def api_download(name):
    """让用户能下载 output/ 里的成果文件（替代桌面版的"打开文件夹"）。"""
    if "/" in name or "\\" in name or ".." in name:
        return jsonify({"error": "非法文件名"}), 400
    return send_from_directory(os.path.join(PROJECT_ROOT, "output"), name,
                               as_attachment=True)


@app.route("/api/health")
def api_health():
    return jsonify({
        "ok": True,
        "mode": "web",
        "handlers": sorted(pb.HANDLERS.keys()),
    })


# =========================================================
# 知乎 OAuth 登录（第九轮）
#   协议要点（来自官方参考实现，实测行为）：
#   - 授权：GET openapi.zhihu.com/authorize?redirect_uri&app_id&response_type=code&state
#   - 回调：?authorization_code=...（不是 code；兼容两者，主路径 authorization_code）
#   - 换 token：POST openapi.zhihu.com/access_token 表单字段名是 code
#   - 用户信息：GET openapi.zhihu.com/user（Bearer AccessSecret + X-OAuth-Token）
#   - 用户数据：GET developer.zhihu.com/api/v1/user/contents 等
#   - 实测回调不返回 state -> CSRF 校验不可用，如实记录
#   安全约束：
#   - token / app_key 只存服务端内存会话，绝不出现在任何响应、日志
#   - Cookie 只放随机 session id（HttpOnly, SameSite=Lax）
# =========================================================

try:
    import requests as _requests
except ImportError:
    _requests = None


OAUTH_AUTHORIZE_URL = "https://openapi.zhihu.com/authorize"
OAUTH_TOKEN_URL = "https://openapi.zhihu.com/access_token"
OAUTH_USER_URL = "https://openapi.zhihu.com/user"
OAUTH_CONTENTS_URL = "https://developer.zhihu.com/api/v1/user/contents"

SESSION_COOKIE = "zhizhu_session"
SESSION_MAX_AGE = 8 * 3600          # 8 小时，与参考实现一致


def _oauth_env(name):
    """凭证读取：环境变量优先；config.py 已把 .env 装入 os.environ。"""
    return (os.environ.get(name) or "").strip()


def _oauth_creds():
    return {
        "app_id": _oauth_env("ZHIHU_OAUTH_APP_ID"),
        "app_key": _oauth_env("ZHIHU_OAUTH_APP_KEY"),
        "access_secret": _oauth_env("ZHIHU_ACCESS_SECRET"),
        "redirect_uri": _oauth_env("ZHIHU_REDIRECT_URI"),
    }


def _sha12(value):
    """凭证指纹：仅 sha256 前 12 位，用于诊断，绝不输出原值。"""
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _cred_diag(value, source_env):
    if not value:
        return {"configured": False, "source": "missing"}
    return {
        "configured": True,
        "source": "env" if source_env else "env:.env",
        "length": len(value),
        "sha256_prefix": _sha12(value),
    }


def _credential_warnings(creds):
    warnings = []
    if creds["app_key"] and len(creds["app_key"]) <= 8:
        warnings.append({
            "code": "APP_KEY_TOO_SHORT",
            "message": "ZHIHU_OAUTH_APP_KEY 长度过短，可能误填成 App ID。",
        })
    if (creds["app_key"] and creds["app_id"]
            and hmac.compare_digest(creds["app_key"], creds["app_id"])):
        warnings.append({
            "code": "APP_ID_USED_AS_APP_KEY",
            "message": "ZHIHU_OAUTH_APP_KEY 与 App ID 相同，请检查是否填错。",
        })
    if (creds["app_key"] and creds["access_secret"]
            and hmac.compare_digest(creds["app_key"], creds["access_secret"])):
        warnings.append({
            "code": "APP_KEY_USED_AS_ACCESS_SECRET",
            "message": "ZHIHU_ACCESS_SECRET 与 OAuth App Key 相同，请检查是否填错。",
        })
    for w in warnings:
        print("[OAuth][凭证警告]", w["code"], w["message"])
    return warnings


# ---- 服务端内存会话 ----
SESSIONS = {}                       # session_id -> dict
SESSIONS_LOCK = threading.Lock()


def _get_session():
    """从 Cookie 取会话；没有则新建并写 Cookie（HttpOnly）。"""
    sid = request.cookies.get(SESSION_COOKIE)
    with SESSIONS_LOCK:
        sess = SESSIONS.get(sid) if sid else None
    if sess is None:
        sid = secrets.token_urlsafe(24)
        sess = {
            "token": None, "expires_at": None, "profile": None,
            "state": None, "state_returned": False, "state_verified": False,
            "error": None,
        }
        with SESSIONS_LOCK:
            SESSIONS[sid] = sess
    return sid, sess


def _set_session_cookie(resp, sid):
    resp.set_cookie(
        SESSION_COOKIE, sid,
        max_age=SESSION_MAX_AGE, httponly=True,
        samesite="Lax", path="/",
    )
    return resp


def _session_expired(sess):
    """token 过期自动失效，返回是否已过期（并清理）。"""
    if sess["expires_at"] and sess["expires_at"] <= time.time():
        sess["token"] = None
        sess["profile"] = None
        sess["error"] = {"code": "TOKEN_EXPIRED", "message": "授权已过期，请重新登录。"}
        return True
    return False


def _oauth_error(code, message, status=400):
    """结构化错误：只含错误码与简短说明，绝不泄露 token / app_key。"""
    return jsonify({"ok": False, "error": {"code": code, "message": message[:200]}}), status


# ---- 网络层（独立函数，便于测试时 mock，不发真实请求） ----

def _http_post_token(form):
    """POST access_token 换取 token。

    始终返回 dict：知乎在业务失败时 data 可能是字符串，
    非 dict 会让上层 .get() 抛 AttributeError，把真实错误盖成 500。
    """
    r = _requests.post(OAUTH_TOKEN_URL, data=form, timeout=20)
    r.raise_for_status()
    try:
        payload = r.json()
    except ValueError:
        return {"code": "NON_JSON_RESPONSE", "data": (r.text or "")[:200]}
    if not isinstance(payload, dict):
        return {"code": "UNEXPECTED_RESPONSE", "data": str(payload)[:200]}
    return payload


def _http_get_user(access_secret, token):
    """GET /user 拉取用户信息。返回 dict。"""
    r = _requests.get(
        OAUTH_USER_URL,
        headers={
            "Authorization": "Bearer " + access_secret,
            "X-OAuth-Token": token,
            "X-Request-Timestamp": str(int(time.time())),
        },
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def _http_get_contents(access_secret, token, params):
    """GET /api/v1/user/contents 读取用户创作。返回 dict。"""
    r = _requests.get(
        OAUTH_CONTENTS_URL,
        params=params,
        headers={
            "Authorization": "Bearer " + access_secret,
            "X-OAuth-Token": token,
            "X-Request-Timestamp": str(int(time.time())),
        },
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def _extract_user(payload):
    """从 /user 响应中提取 profile（容错多种字段命名）。"""
    src = payload.get("data") or payload.get("Data") or payload.get("user") or {}
    if not isinstance(src, dict):
        return None
    if not any(src.get(k) for k in ("name", "Fullname", "fullname", "url")):
        return None
    return {
        "name": src.get("name") or src.get("Fullname") or src.get("fullname"),
        "avatar_url": src.get("avatar_url") or src.get("AvatarUrl"),
        "headline": src.get("headline") or src.get("Headline"),
        "url": src.get("url") or src.get("Url"),
    }


# ---- 路由 ----

@app.route("/api/oauth/status")
def api_oauth_status():
    """安全状态：不含任何 token。凭证诊断只输出长度与 sha256 前 12 位。"""
    sid, sess = _get_session()
    creds = _oauth_creds()
    _session_expired(sess)
    configured = bool(creds["app_key"] and creds["access_secret"] and creds["redirect_uri"])
    resp = jsonify({
        "ok": True,
        "configured": configured,
        "authorized": bool(sess["token"]),
        "app_id": creds["app_id"] or None,
        "redirect_uri": creds["redirect_uri"] or None,
        "profile": sess["profile"],
        "state_sent": bool(sess.get("state_sent", False)),
        "state_returned": bool(sess["state_returned"]),
        "state_verified": bool(sess["state_verified"]),
        "expires_at": (
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sess["expires_at"]))
            if sess["expires_at"] else None
        ),
        "error": sess["error"],
        "credential_diagnostics": {
            "app_id": _cred_diag(creds["app_id"], bool(os.environ.get("ZHIHU_OAUTH_APP_ID"))),
            "app_key": _cred_diag(creds["app_key"], bool(os.environ.get("ZHIHU_OAUTH_APP_KEY"))),
            "access_secret": _cred_diag(creds["access_secret"], bool(os.environ.get("ZHIHU_ACCESS_SECRET"))),
        },
        "credential_warnings": _credential_warnings(creds),
    })
    return _set_session_cookie(resp, sid)


@app.route("/api/oauth/start")
def api_oauth_start():
    """发起授权：生成 state，302 跳转知乎授权页。"""
    sid, sess = _get_session()
    creds = _oauth_creds()

    def fail(code, message, status):
        sess["error"] = {"code": code, "message": message[:200]}
        resp = app.make_response(_oauth_error_json(code, message, status))
        return _set_session_cookie(resp, sid)

    if not creds["redirect_uri"]:
        return fail("DEPLOYMENT_REQUIRED",
                    "回调地址未配置（ZHIHU_REDIRECT_URI），无法发起登录。", 400)
    if not creds["app_key"]:
        return fail("APP_KEY_REQUIRED",
                    "OAuth 未配置（缺 ZHIHU_OAUTH_APP_KEY），请联系管理员配置后再登录。", 400)

    sess["state"] = secrets.token_urlsafe(24)
    sess["state_sent"] = True
    sess["state_returned"] = False
    sess["state_verified"] = False
    sess["error"] = None

    q = urllib.parse.urlencode({
        "redirect_uri": creds["redirect_uri"],
        "app_id": creds["app_id"],
        "response_type": "code",
        "state": sess["state"],
    })
    resp = app.make_response(("", 302))
    resp.headers["Location"] = OAUTH_AUTHORIZE_URL + "?" + q
    return _set_session_cookie(resp, sid)


def _oauth_error_json(code, message, status):
    """生成 JSON 错误响应体（字符串），配合 make_response 使用。"""
    return json.dumps(
        {"ok": False, "error": {"code": code, "message": message[:200]}},
        ensure_ascii=False,
    ), status, {"Content-Type": "application/json; charset=utf-8"}


@app.route("/auth/callback")
@app.route("/api/oauth/callback")
def api_oauth_callback():
    """回调：换 token -> 拉取 profile -> 302 回首页。

    两个路径都能进：
      - /auth/callback      —— 对齐知乎黑客松 Skill 模板约定（登记用这个）
      - /api/oauth/callback —— 本服务早期路径，保留兼容
    """
    sid, sess = _get_session()

    # 兼容 authorization_code（实测主路径）与 code（协议预留）
    code = request.args.get("authorization_code") or request.args.get("code")
    returned_state = request.args.get("state")
    sess["state_returned"] = bool(returned_state)

    if not code:
        sess["error"] = {"code": "CODE_MISSING", "message": "回调缺少授权码。"}
        resp = app.make_response((_oauth_error_page("登录失败：回调缺少授权码"), 400))
        return _set_session_cookie(resp, sid)

    # state：实测平台不返回。若返回则必须校验；未返回时如实记录不可用。
    if returned_state:
        if not sess["state"] or not hmac.compare_digest(returned_state, sess["state"]):
            sess["error"] = {"code": "STATE_MISMATCH", "message": "state 校验失败，已拒绝。"}
            resp = app.make_response((_oauth_error_page("登录失败：state 校验失败"), 400))
            return _set_session_cookie(resp, sid)
        sess["state_verified"] = True
    else:
        sess["state_verified"] = False   # 不声称已通过 CSRF 校验

    creds = _oauth_creds()
    if not (creds["app_id"] and creds["app_key"] and creds["access_secret"]):
        sess["error"] = {"code": "CREDENTIALS_INCOMPLETE", "message": "后端凭证配置不完整。"}
        resp = app.make_response((_oauth_error_page("登录失败：后端凭证配置不完整"), 500))
        return _set_session_cookie(resp, sid)

    # 换 token（表单字段名是 code）
    form = {
        "app_id": creds["app_id"],
        "app_key": creds["app_key"],
        "grant_type": "authorization_code",
        "redirect_uri": creds["redirect_uri"],
        "code": code,
    }
    try:
        payload = _http_post_token(form)
    except Exception as e:
        print("[OAuth][token] 交换失败：", type(e).__name__)   # 不打印表单（含密钥）
        sess["error"] = {"code": "TOKEN_EXCHANGE_FAILED",
                         "message": "换取访问令牌失败，请重试。"}
        resp = app.make_response((_oauth_error_page("登录失败：换取令牌失败"), 502))
        return _set_session_cookie(resp, sid)

    # 知乎出错时 data 可能是字符串（如 "Access denied: not exists"），
    # 必须先判类型，否则 .get() 会抛 AttributeError -> 500，把真实错误盖掉。
    data = payload.get("data")
    if not isinstance(data, dict):
        data = {}

    token = payload.get("access_token") or data.get("access_token")
    if not token:
        biz_code = payload.get("code")
        detail = payload.get("data")
        if not isinstance(detail, str):
            detail = payload.get("message") or payload.get("Message") or ""
        detail = str(detail)[:120]
        sess["error"] = {
            "code": "NO_ACCESS_TOKEN",
            "message": "平台未返回访问令牌（业务码 %s：%s）" % (biz_code, detail),
        }
        # 把知乎的真实错误显示出来，不再吞成空白 500
        resp = app.make_response((_oauth_error_page(
            "登录失败：平台返回 %s —— %s" % (biz_code, detail)), 502))
        return _set_session_cookie(resp, sid)

    expires_in = payload.get("expires_in") or data.get("expires_in")
    try:
        expires_in = int(expires_in)
    except (TypeError, ValueError):
        expires_in = None
    sess["token"] = token
    sess["expires_at"] = (time.time() + expires_in) if expires_in else None
    sess["state"] = None
    sess["error"] = None

    # 拉取用户信息（失败不阻断登录，profile 为空即可）
    try:
        profile_payload = _http_get_user(creds["access_secret"], token)
        sess["profile"] = _extract_user(profile_payload)
    except Exception as e:
        print("[OAuth][profile] 拉取失败：", type(e).__name__)
        sess["profile"] = None

    resp = app.make_response(("", 302))
    resp.headers["Location"] = "/"
    return _set_session_cookie(resp, sid)


@app.route("/api/oauth/logout", methods=["POST"])
def api_oauth_logout():
    """退出登录：清空会话 token 与 profile。"""
    sid, sess = _get_session()
    sess["token"] = None
    sess["expires_at"] = None
    sess["profile"] = None
    sess["state"] = None
    sess["state_returned"] = False
    sess["state_verified"] = False
    sess["error"] = None
    resp = jsonify({"ok": True})
    return _set_session_cookie(resp, sid)


@app.route("/api/oauth/contents")
def api_oauth_contents():
    """代理读取用户知乎创作（需先登录）。参数透传 Limit/Offset/ContentType。"""
    sid, sess = _get_session()
    if not sess["token"] or _session_expired(sess):
        return _oauth_error("LOGIN_REQUIRED", "请先完成账号授权。", 401)
    creds = _oauth_creds()
    if not creds["access_secret"]:
        return _oauth_error("ACCESS_SECRET_MISSING", "开放平台 Access Secret 未配置。", 500)

    params = {}
    for k in ("Limit", "Offset", "ContentType", "SortField", "SortOrder"):
        v = request.args.get(k)
        if v is not None:
            params[k] = v
    if "Limit" not in params:
        params["Limit"] = "10"
    if "ContentType" not in params:
        params["ContentType"] = "all"

    try:
        payload = _http_get_contents(creds["access_secret"], sess["token"], params)
    except Exception as e:
        print("[OAuth][contents] 读取失败：", type(e).__name__)
        return _oauth_error("CONTENTS_FETCH_FAILED", "读取用户创作失败。", 502)

    # 只回传数据本身，不带任何凭证
    return jsonify(payload)


def _oauth_error_page(message):
    """回调失败时返回的极简错误页 HTML（不含任何敏感值）。"""
    return (
        "<!DOCTYPE html><html lang=zh-CN><head><meta charset=utf-8>"
        "<title>登录失败 · 知筑</title></head>"
        "<body style='font-family:sans-serif;background:#111214;color:#f0efeb;"
        "display:flex;align-items:center;justify-content:center;height:100vh'>"
        "<div style='text-align:center'><h2>账号登录失败</h2>"
        f"<p style='color:#aaa8a1'>{message}</p>"
        "<p><a href='/' style='color:#d6a45b'>返回知筑首页</a></p></div></body></html>"
    )


# =========================================================
# 启动
# =========================================================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    print("=" * 56)
    print(" 知筑 Web 版已启动")
    print(f" 本机访问：http://127.0.0.1:{port}")
    print(f" 可用指令：{len(pb.HANDLERS)} 个")
    print("=" * 56)
    # threaded=True：SSE 长连接与业务请求并行
    app.run(host=host, port=port, threaded=True, debug=False)
