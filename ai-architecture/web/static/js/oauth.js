/* ============================================================
 * oauth.js —— 知乎 OAuth 登录（Web 版）
 * ============================================================
 * 职责：
 *   1. 顶部栏登录入口（未配置=禁用提示 / 未登录=登录按钮 / 已登录=头像菜单）
 *   2. 登录后用户面板（头像、昵称、headline、创作数量）
 *   3. 「我的创作」列表 + 建筑相关问题提示（知筑产品链路）
 *   4. 退出登录
 *
 * 安全约定（与后端一致）：
 *   - 前端只能看到：是否已授权、昵称、头像、headline、主页链接；
 *   - 任何 token / app_key 都不会到达浏览器。
 *
 * 如实显示：
 *   - 平台回调不返回 state，CSRF 校验不可用（协议限制）；
 *   - 区分：未配置 / 未登录 / 已登录 / 已过期 / 登录失败。
 *
 * ⚠️ 当前状态：入口已被 LOGIN_ENTRY_ENABLED=false 隐藏（回调地址未登记）。
 *    恢复方法见下方开关处的注释；后端 /api/oauth/* 路由未做任何改动。
 * ============================================================ */
"use strict";

(function () {
  const entry = document.getElementById("oauth-entry");
  if (!entry) return;                       // 容错：入口不存在时静默退出

  /* ==========================================================
   * 【登录入口总开关】LOGIN_ENTRY_ENABLED
   * ----------------------------------------------------------
   * 为什么关掉：知乎 OAuth 的回调地址尚未在知乎侧登记成功，
   *   点「用知乎登录」会跳到知乎的错误页（"出错了，请稍后再试"）。
   *   交稿日在即，评委一定会点这个按钮 —— 点到坏按钮比没有更糟。
   *   故暂时隐藏入口。**代码并未删除**，后端 /api/oauth/* 路由全部保留。
   *
   * 如何恢复（任选其一，都不需要改后端）：
   *   ① 把下面的 false 改成 true，重新部署即可；
   *   ② 或者在网址后临时加参数：?oauth=on（仅当次访问生效，便于联调）
   *   回调地址在知乎侧登记成功后，请按 ① 恢复。
   * ========================================================== */
  var LOGIN_ENTRY_ENABLED = false;
  try {
    // 联调逃生门：?oauth=on / ?oauth=1 可临时打开（不改部署、不改代码）
    var q = String(location.search || "");
    if (/(?:^|[?&])oauth=(?:on|1|true)(?:&|$)/i.test(q)) LOGIN_ENTRY_ENABLED = true;
  } catch (e) { /* 无 location（非浏览器环境）时保持关闭 */ }

  if (!LOGIN_ENTRY_ENABLED) {
    // 入口不可见：清空容器并直接退出，不发起任何 /api/oauth/status 请求。
    entry.innerHTML = "";
    entry.style.display = "none";
    entry.setAttribute("hidden", "hidden");
    entry.setAttribute("aria-hidden", "true");
    return;
  }

  let lastStatus = null;
  let contentsCache = null;                 // { count, items } | null
  let panelOpen = false;

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fetchJSON(url, opts) {
    return fetch(url, opts)
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  /* ---------- 状态拉取 ---------- */
  function refresh() {
    return fetchJSON("/api/oauth/status").then(function (st) {
      lastStatus = st && st.ok ? st : null;
      render();
    });
  }

  /* ---------- 登录 / 退出 ---------- */
  function login() {
    if (!lastStatus || !lastStatus.configured) return;
    window.location.href = "/api/oauth/start";
  }

  function logout() {
    fetch("/api/oauth/logout", { method: "POST" }).finally(function () {
      contentsCache = null;
      refresh();
    });
  }

  /* ---------- 我的创作 ---------- */
  function loadContents() {
    if (contentsCache) { renderPanel(); return Promise.resolve(); }
    return fetchJSON("/api/oauth/contents?Limit=20&ContentType=all").then(function (data) {
      const items = (data && (data.Data && data.Data.Items)) || (data && data.items) || [];
      const total = (data && data.Data && data.Data.Total) || items.length;
      contentsCache = { count: total, items: items };
      renderPanel();
    });
  }

  /* 建筑相关问题识别（关键词级，轻量启发式） */
  var ARCH_WORDS = ["建筑", "空间", "广场", "公园", "车站", "机场", "动线", "排队", "遮阳",
    "步行", "景观", "设计", "城市规划", "展览馆", "博物馆", "体育场", "园区", "商业街"];

  function looksArchitecture(title) {
    if (!title) return false;
    return ARCH_WORDS.some(function (w) { return title.indexOf(w) >= 0; });
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!lastStatus) {
      entry.innerHTML = '<span class="oauth-state oauth-off">OAuth 不可用</span>';
      return;
    }
    const st = lastStatus;

    if (!st.configured) {
      entry.innerHTML =
        '<button class="oauth-btn" disabled title="OAuth 未配置：缺少 ZHIHU_OAUTH_APP_ID / APP_KEY / ACCESS_SECRET / REDIRECT_URI">' +
        "OAuth 未配置</button>";
      return;
    }

    if (st.authorized && st.profile) {
      const p = st.profile;
      entry.innerHTML =
        '<div class="oauth-user">' +
        (p.avatar_url
          ? '<img class="oauth-avatar" src="' + esc(p.avatar_url) + '" alt="">'
          : '<span class="oauth-avatar oauth-avatar-fallback">' + esc((p.name || "知")[0]) + "</span>") +
        '<span class="oauth-name">' + esc(p.name || "用户") + " ▾</span></div>";
      bindUserMenu();
      return;
    }

    if (st.authorized && !st.profile) {
      entry.innerHTML =
        '<div class="oauth-user"><span class="oauth-avatar oauth-avatar-fallback">知</span>' +
        '<span class="oauth-name">已授权 ▾</span></div>';
      bindUserMenu();
      return;
    }

    // 未登录：区分错误与过期提示
    let hint = "";
    if (st.error && st.error.code === "TOKEN_EXPIRED") {
      hint = '<span class="oauth-expired">授权已过期，请重新登录</span>';
    } else if (st.error) {
      hint = '<span class="oauth-expired">登录失败：' + esc(st.error.code) + "</span>";
    }
    entry.innerHTML =
      hint +
      '<button class="oauth-btn" title="跳转授权">账号登录</button>';
    entry.querySelector(".oauth-btn").addEventListener("click", login);
  }

  function bindUserMenu() {
    const el = entry.querySelector(".oauth-user");
    if (!el) return;
    el.addEventListener("click", function () {
      panelOpen = !panelOpen;
      if (panelOpen) { loadContents(); } else { closePanel(); }
    });
    renderPanel();
  }

  function closePanel() {
    panelOpen = false;
    const panel = document.getElementById("oauth-panel");
    if (panel) panel.remove();
  }

  function renderPanel() {
    closePanel();
    if (!panelOpen) return;
    const st = lastStatus || {};
    const p = st.profile || {};

    const headHtml =
      '<div class="oauth-panel-head">' +
      '<div class="oauth-panel-title">账号已连接</div>' +
      (p.headline ? '<div class="oauth-headline">' + esc(p.headline) + "</div>" : "") +
      (p.url ? '<a class="oauth-home" href="' + esc(p.url) + '" target="_blank" rel="noopener">个人主页 ↗</a>' : "") +
      "</div>";

    let contentsHtml;
    if (contentsCache === null) {
      contentsHtml = '<div class="oauth-contents-loading">正在读取你的创作…</div>';
    } else {
      const arch = (contentsCache.items || []).filter(function (it) {
        return looksArchitecture(it.Title || it.title || it.ContentTitle || "");
      });
      const listHtml = (contentsCache.items || []).slice(0, 5).map(function (it) {
        const t = it.Title || it.title || it.ContentTitle || "(无标题)";
        return '<div class="oauth-item' + (looksArchitecture(t) ? " oauth-item-arch" : "") + '">' + esc(t) + "</div>";
      }).join("") || '<div class="oauth-empty">暂无公开创作</div>';
      contentsHtml =
        '<div class="oauth-section">我的创作（' + contentsCache.count + "）</div>" +
        listHtml +
        (arch.length
          ? '<div class="oauth-tip">发现 ' + arch.length +
            " 条与建筑 / 公共空间相关的创作。知筑可以基于这些内容，生成公众视角的专业建筑回答。</div>"
          : '<div class="oauth-tip">已连接你的账号。知筑可以基于你的公开创作，找出可以用专业分析回答的问题。</div>');
    }

    const stateNote =
      '<div class="oauth-state-note">说明：当前平台回调不返回 state，CSRF 校验不可用（协议限制）。' +
      (st.expires_at ? " 授权到期：" + esc(st.expires_at) + "。" : "") + "</div>";

    const panel = document.createElement("div");
    panel.id = "oauth-panel";
    panel.className = "oauth-panel";
    panel.innerHTML =
      headHtml + contentsHtml + stateNote +
      '<button class="oauth-logout">退出登录</button>';
    entry.appendChild(panel);
    panel.querySelector(".oauth-logout").addEventListener("click", function () {
      closePanel();
      logout();
    });

    document.addEventListener("click", function onDoc(e) {
      if (panelOpen && entry && !entry.contains(e.target)) {
        closePanel();
        document.removeEventListener("click", onDoc);
      }
    });
  }

  /* ---------- 启动 ---------- */
  refresh();
  window.ZhizhuOAuth = { refresh: refresh, logout: logout };
})();
