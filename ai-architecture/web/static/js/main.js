/* ============================================================
   main.js —— 应用启动、导航、桥接事件注册
   ============================================================ */
"use strict";

function initIconNav() {
  const nav = $("#iconnav");
  VIEWS.forEach((v) => {
    const b = el("button", "icon-btn" + (v.id === "chat" ? " active" : ""), `
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${iconPath(v.id)}</svg>`);
    b.dataset.view = v.id;
    b.title = v.name;
    b.addEventListener("click", () => switchView(v.id));
    nav.appendChild(b);
  });
}

function iconPath(id) {
  const paths = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    workspace: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    data: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    agents: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    canvas: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><circle cx="11" cy="11" r="2"/>',
    inspection: '<path d="M4 3h16v18H4zM8 7h8M8 11h8M8 15h5"/>',
    engineering: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    drafting: '<path d="M2 20h20M4 16l8-12 8 12"/><path d="M8 16l4-6 4 6"/>',
    disease: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 8l3 3-3 3M13 14l3 3"/><path d="M6 12h2M16 8h2"/>',
    files: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    skills: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.3-2.3z"/><path d="M18 3l3 3M17 7l2-2"/>',
    report: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  };
  return paths[id] || "";
}

function initEvents() {
  // 演示模式开关
  $("#demo-toggle").addEventListener("change", (e) => {
    State.pipeline.demo = e.target.checked;
    toast(State.pipeline.demo ? "已切换为演示模式（不请求外部 API）" : "已切换为实时数据模式", "ok");
  });

  // 顶栏运行按钮
  $("#run-btn").addEventListener("click", () => {
    if (State.pipeline.running) return;
    switchView("data");
    runPipeline(State.pipeline.subject, State.pipeline.keywords, State.pipeline.demo);
  });

  // 侧栏新建会话
  $("#sidebar-action").addEventListener("click", () => {
    newSession();
    renderSidebar("chat");
    renderChatView();
  });

  // 设置按钮已移入 VIEWS，无需单独绑定
}

async function boot() {
  initIconNav();
  initEvents();

  // 恢复顺序（修复缺陷①：必须在首次渲染前恢复缓存，否则旧对话不会显示）：
  //   1. 先读 localStorage 缓存（对话 + 上次分析结果）
  //   2. 再用 /api/report 的服务端结果补充/覆盖（服务端优先，可能更新）
  //   3. 都没有 → 保持空状态（前端已有"点运行分析"引导）
  CacheStore.restore();

  // 首次渲染（此时 State.chat 已含缓存会话，无需用户再点「新对话」）
  renderSidebar("chat");
  renderCurrentView();
  setBridgeBusy(false);

  // 注册后端事件
  Bridge.onEvent(handlePyEvent);

  // 连接探活：invoke 返回值仅代表指令已写入桥进程，
  // 真正的就绪信息由后端 system_info 结果事件回填（见 api.js handlePyEvent）。
  const markBridgeUnavailable = (message) => {
    State.bridgeReady = false;
    $("#bridge-dot").className = "dot off";
    $("#bridge-text").textContent = "后端未连接";
    updateAgentStatus();
    toast(message, "err");
  };
  try {
    const sent = await Bridge.invoke("system_info", {});
    if (!sent || !sent.ok) {
      markBridgeUnavailable("Python 后端未连接，请重启应用");
    } else {
      BridgeReadyTimer = setTimeout(() => {
        BridgeReadyTimer = null;
        if (!State.bridgeReady) {
          markBridgeUnavailable("Python 后端响应超时，请重启应用");
        }
      }, 6000);
    }
  } catch (e) {
    markBridgeUnavailable("Python 后端连接失败：" + (e.message || e));
  }

  // 预读文件列表
  refreshFiles();

  // 读取已安装 Skill 状态
  loadSkills();

  // 读取已有报告（服务端结果覆盖缓存报告，服务端优先）
  try {
    const rep = await Bridge.readReport();
    if (rep && (rep.summary || rep.admitted_items)) {
      State.pipeline.report = rep;
      State.pipeline.scored = normalizeScored(rep.admitted_items);
      Views.refresh("data");
      Views.refresh("report");
      // 问题 ④：数据加载后刷新侧栏，让「分析流程」状态同步
      if (State.view === "data") renderSidebar("data");
    }
  } catch (e) { /* 无报告则忽略 */ }

  const defaultView = localStorage.getItem("defaultView");
  if (defaultView === "workspace") switchView("workspace");
}

document.addEventListener("DOMContentLoaded", boot);
