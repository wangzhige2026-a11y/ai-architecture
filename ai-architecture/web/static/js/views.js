/* ============================================================
   views.js —— 视图渲染、路由、侧栏
   ============================================================ */
"use strict";

let ChatAutoScroll = true;

/* ================= 工具 ================= */
function emptyState(text) {
  return `<div class="empty">${esc(text)}</div>`;
}
function statCard(v, k, cls) {
  return `<div class="stat ${cls || ""}"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;
}

/* ================= 侧栏 ================= */
function renderSidebar(viewId) {
  const sc = $("#sidebar-content");
  const title = $("#sidebar-title");
  const action = $("#sidebar-action");
  const v = VIEWS.find((x) => x.id === viewId);
  title.textContent = (v ? v.name : "") + " · 上下文";

  let html = "";
  if (viewId === "chat") {
    // 问题③：原标题栏里的小「＋」不再显示（index.html 不在本次白名单，故在此直接隐藏），
    //         新建入口改为会话列表上方的独立整行按钮。
    action.style.display = "none";
    html = `<button class="side-new-chat" type="button" id="side-new-chat">＋ 新建对话</button>
      <div class="side-section" style="display:flex;justify-content:space-between;align-items:center;">会话<span id="side-clear-empty" class="side-clear-empty" title="清理所有空对话" role="button" tabindex="0">清理空对话</span></div>`;
    if (!State.chat.sessions.length) {
      html += `<div class="fs-sm" style="color:var(--dim);padding:8px 10px">暂无会话，点击上方「＋ 新建对话」</div>`;
    }
    State.chat.sessions.forEach((s) => {
      const empty = !(s.messages && s.messages.length);
      // 问题①：行布局收进 .side-item-row，不再用 .side-item 做全局覆盖
      html += `<div class="side-item side-item-row ${s.id === State.chat.activeId ? "active" : ""}" data-session="${s.id}">
        <div class="side-item-main"><div class="t">${esc(s.title)}${empty ? '<span class="side-empty-tag">空</span>' : ""}</div><div class="s">${esc(s.sub)}</div></div>
        <button class="side-del" data-del="${s.id}" title="删除此对话" aria-label="删除此对话" type="button">×</button></div>`;
    });
  } else if (viewId === "data") {
    action.style.display = "none";
    html = `<div class="side-section">分析流程</div>
      <div style="padding:4px 4px 8px;">${renderStepList()}</div>
      <div class="side-section">当前参数</div>
      <div class="side-item"><div class="t">主体</div><div class="s">${esc(State.pipeline.subject)}</div></div>
      <div class="side-item"><div class="t">关键词</div><div class="s">${esc(State.pipeline.keywords.join("、"))}</div></div>
      <div class="side-item"><div class="t">模式</div><div class="s">${State.pipeline.demo ? "演示模式" : "实时华为"}</div></div>`;
  } else if (viewId === "agents") {
    action.style.display = "none";
    html = `<div class="side-section">工作流角色</div>`;
    State.agents.forEach((a) => {
      html += `<div class="side-item" data-goto="agents"><div class="t"><span style="margin-right:5px;">${a.ic}</span>${esc(a.name)}</div><div class="s">${esc(a.role)}</div></div>`;
    });
    html += `<div class="side-section">运行日志</div><div class="fs-xs" style="color:var(--dim);padding:4px 10px">共 ${State.pipeline.logs.length} 条</div>`;
  } else if (viewId === "canvas") {
    action.style.display = "none";
    html = `<div class="side-section">工作流节点</div>`;
    FLOW_STEPS.forEach((s) => {
      const st = State.pipeline.steps.find((x) => x.step === s.n);
      const ic = st ? (st.status === "done" ? "✅" : st.status === "run" ? "⏳" : st.status === "fail" ? "❌" : "○") : "○";
      html += `<div class="side-item" data-goto="canvas"><div class="t">${ic} ${s.n}. ${esc(s.name)}</div><div class="s">${esc(s.desc)}</div></div>`;
    });
  } else if (viewId === "engineering") {
    action.style.display = "none";
    html = `<div class="side-section">结构概念验算</div>
      <div class="fs-sm" style="padding:4px 10px;color:var(--muted);line-height:1.6">荷载组合 · 材料强度 · 变形控制 · 抗倾覆稳定性 四维概念级校验</div>
      <div class="side-section">支持方案</div>
      <div class="side-item"><div class="t">悬挑方案</div><div class="s">cantilever</div></div>
      <div class="side-item"><div class="t">简支梁方案</div><div class="s">simple_beam</div></div>`;
  } else if (viewId === "inspection") {
    action.style.display = "none";
    html = `<div class="side-section">检测基础</div><div class="fs-sm" style="padding:8px 10px;line-height:1.7;color:var(--muted)">方法认识、记录整理和单位校验。外部AI可以辅助抽取，计算由程序完成。</div><div class="side-section">处理顺序</div><div class="side-item"><div class="t">1. 明确方法</div><div class="s">核对测量对象与能力边界</div></div><div class="side-item"><div class="t">2. 整理原始记录</div><div class="s">构件、测区、数字与单位</div></div><div class="side-item"><div class="t">3. 复核与保存</div><div class="s">问题清单和原文依据随记录保存</div></div>`;
  } else if (viewId === "disease") {
    action.style.display = "none";
    html = `<div class="side-section">病害检测</div>
      <div class="fs-sm" style="padding:4px 10px;color:var(--muted);line-height:1.6">上传表面照片，选择小模型或规则方法提取裂缝。小模型仅在路面照片上验证，桥梁构件效果尚未验证。</div>
      <div class="side-section">怎么做更准</div>
      <div class="side-item"><div class="t">同框放标尺</div><div class="s">放一把已知长度的尺子，才能输出毫米</div></div>
      <div class="side-item"><div class="t">垂直拍摄</div><div class="s">减少透视变形，宽度估算更接近真实</div></div>
      <div class="side-item"><div class="t">避免强反光</div><div class="s">强反光会影响裂缝判读，可换角度重拍</div></div>`;
  } else if (viewId === "settings") {
    action.style.display = "none";
    html = `<div class="side-section">设置入口</div>
      <div class="side-item"><div class="t">工作台设置</div><div class="s">当前为静态设置入口</div></div>`;
  } else if (viewId === "skills") {
    action.style.display = "none";
    const installed = State.skills.items.filter((s) => s.installed).length;
    html = `<div class="side-section">已安装 Skill</div>
      <div class="side-item"><div class="t">${installed} 个项目级 Skill</div><div class="s">扫描 .codex/skills/manifest.json</div></div>`;
    State.skills.items.forEach((s) => {
      html += `<div class="side-item"><div class="t">${esc(s.icon || "🧩")} ${esc(s.name || s.id)}</div><div class="s">Skill ${esc(s.version || "未知")} · ${s.cli?.installed ? "CLI 可用" : "CLI 未安装"}</div></div>`;
    });
    html += `<div class="side-section">安全说明</div><div class="fs-sm" style="padding:4px 10px;color:var(--dim);line-height:1.6">只展示版本、能力和状态，不显示密钥原文。</div>`;
  } else if (viewId === "files") {
    action.style.display = "none";
    html = `<div class="side-section">输出目录</div>
      <div class="side-item"><div class="t">output/</div><div class="s">${State.files.length} 个文件</div></div>`;
  } else if (viewId === "report") {
    action.style.display = "none";
    html = `<div class="side-section">成果报告</div>`;
    const r = State.pipeline.report;
    if (r) {
      html += `<div class="side-item"><div class="t">${esc(r.project_name || r.meta?.project || "分析报告")}</div><div class="s">${esc(r.generated_at || "")}</div></div>`;
    } else {
      html += `<div class="fs-sm" style="padding:4px 10px;color:var(--dim)">运行分析后生成</div>`;
    }
  } else {
    // workspace
    action.style.display = "none";
    html = `<div class="side-section">项目</div>
      <div class="side-item"><div class="t">AI_Architecture_System</div><div class="s">华为认知 → 建筑设计</div></div>
      <div class="side-section">核心链路</div>
      <div class="fs-sm" style="padding:4px 10px;color:var(--muted);line-height:1.8">华为公众认知 → 数据分析 → 建筑问题识别 → AI 设计策略 → 工程逻辑验证 → 可视化设计 → 方案迭代</div>`;
  }
  sc.innerHTML = html;

  $$(".side-item", sc).forEach((it) => {
    it.addEventListener("click", () => {
      const sid = it.dataset.session;
      if (sid) { State.chat.activeId = sid; renderSidebar("chat"); renderChatView(); }
      const g = it.dataset.goto;
      if (g) switchView(g);
    });
  });

  // 问题③：新建对话按钮（独立整行，键盘可聚焦后 Enter/Space 触发由 button 原生负责）
  const newChatBtn = $("#side-new-chat", sc);
  if (newChatBtn) {
    newChatBtn.addEventListener("click", () => {
      newSession();
      renderSidebar("chat");
      renderChatView();
    });
  }

  // 会话删除按钮（缺陷③）：阻止冒泡，避免触发切换会话
  $$(".side-del", sc).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(btn.dataset.del);
    });
  });

  // 清理所有空对话入口
  const clearEmpty = $("#side-clear-empty");
  if (clearEmpty) {
    clearEmpty.addEventListener("click", (e) => {
      e.stopPropagation();
      clearEmptySessions();
    });
    clearEmpty.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clearEmptySessions(); }
    });
  }
}

function renderStepList() {
  const steps = State.pipeline.steps;
  if (!steps.length) {
    // 问题 ④：右侧已有数据时，左侧不能还显示「尚未运行」
    const scored = State.pipeline.scored || [];
    if (scored.length) {
      return `<div class="fs-sm" style="color:var(--muted);padding:6px 10px">✅ 已加载内置案例（${scored.length} 条评分数据）</div>`;
    }
    return `<div class="fs-sm" style="color:var(--dim);padding:6px 10px">尚未运行分析</div>`;
  }
  return steps.map((s) => {
    const ic = s.status === "done" ? "✅" : s.status === "run" ? "⏳" : s.status === "fail" ? "❌" : "○";
    return `<div class="fs-sm" style="display:flex;gap:8px;align-items:center;padding:4px 10px">
      <span>${ic}</span><span style="color:var(--muted);">${s.step}.</span><span>${esc(s.name)}</span></div>`;
  }).join("");
}

/* ============ 需求④：逐字弹出（前端节奏化揭示） ============
   事实核对：后端 workspace_app/python_bridge.py:162 把**整段回答**放进
   一个 chat_delta 发出（非逐 token 增量，且紧跟一条 result）。
   所以「把增量追加到气泡」本身不会产生逐字效果 —— 逐字节奏必须由前端控制。
   实现要点：
     · 只对「最后一条 assistant 消息」且「内容发生变化」的回答做揭示；
     · 首次加载 / 切换会话时不做动画（避免历史消息重播）；
     · 揭示期间气泡末尾显示暖金光标，揭示完成即移除，光标随新消息自然移走；
     · prefers-reduced-motion 命中时直接显示全文；
     · 每步只重绘目标气泡（不整屏重渲染），高频下不卡顿。
   不改后端协议；api.js 未改动。
   ------------------------------------------------------------ */
const REVEAL_INTERVAL_MS = 16;
const REVEAL_TARGET_TICKS = 180;      // 整段揭示约 120 帧，长文自动加大步长
const TYPING_CURSOR_HTML = '<span class="typing-cursor" aria-hidden="true"></span>';

/* 已「见过」的消息对象集合：会话首次渲染时把存量消息全部登记为已知，
   之后只有新冒出来的 assistant 消息才做逐字揭示 —— 这样页面刷新 / 切换会话
   时不会把历史回答重播一遍。 */
const RevealKnown = new WeakSet();
const RevealSeeded = new Set();
let RevealAnimatingMsg = null;
let RevealShown = 0;
let RevealTimer = null;

function prefersReducedMotion() {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function lastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && !m.thinking) return i;
  }
  return -1;
}

/* 会话首次出现时，把已有消息登记为「已知」（不触发动画） */
function seedReveal(sess) {
  if (RevealSeeded.has(sess.id)) return;
  (sess.messages || []).forEach((m) => { if (m) RevealKnown.add(m); });
  RevealSeeded.add(sess.id);
}

function stopReveal() {
  if (RevealTimer) { clearTimeout(RevealTimer); RevealTimer = null; }
}

/* 只重绘「正在揭示」的那一个气泡，不做整屏重渲染 */
function paintRevealBubble() {
  const m = RevealAnimatingMsg;
  const sess = activeSession();
  if (!sess || !m || State.view !== "chat") { stopReveal(); RevealAnimatingMsg = null; return; }
  const idx = sess.messages.indexOf(m);
  const el = idx >= 0 ? document.querySelector('#chat-scroll .msg[data-msg-index="' + idx + '"] .bubble') : null;
  if (!el) { stopReveal(); RevealAnimatingMsg = null; renderChatView(); return; }
  const full = m.content || "";
  const done = RevealShown >= full.length;
  el.innerHTML = mdRender(full.slice(0, RevealShown)) + (done ? "" : TYPING_CURSOR_HTML);
  if (done) { stopReveal(); RevealAnimatingMsg = null; return; }
  scheduleRevealTick();
}

function scheduleRevealTick() {
  if (RevealTimer) return;
  const m = RevealAnimatingMsg;
  if (!m) return;
  if (RevealShown >= (m.content || "").length) return;
  RevealTimer = setTimeout(() => {
    RevealTimer = null;
    const mm = RevealAnimatingMsg;
    if (!mm) return;
    const full = mm.content || "";
    RevealShown = Math.min(full.length, RevealShown + Math.max(1, Math.ceil(full.length / REVEAL_TARGET_TICKS)));
    paintRevealBubble();
  }, REVEAL_INTERVAL_MS);
}

/* 渲染时决定该气泡显示多少文字，并返回是否需要光标 */
function revealSliceFor(sess, m, i, isLast) {
  if (m.role !== "assistant" || m.thinking) return { text: m.content || "", cursor: false };
  const content = m.content || "";
  if (!isLast) return { text: content, cursor: false };

  if (RevealAnimatingMsg === m) {
    const done = RevealShown >= content.length;
    return { text: done ? content : content.slice(0, RevealShown), cursor: !done };
  }

  const known = RevealKnown.has(m);
  RevealKnown.add(m);
  if (!known && content && !prefersReducedMotion()) {
    RevealAnimatingMsg = m;
    RevealShown = 0;
    scheduleRevealTick();
    return { text: "", cursor: true };
  }
  return { text: content, cursor: !!m.streaming };
}

/* ================= 视图 1：对话 ================= */
function renderChatView() {
  const content = $("#content");
  const sess = activeSession();
  if (!sess) {
    // 无会话时显示空状态引导，不再自动创建空白会话（缺陷②③）
    // 任务C：删除此处重复的「新建对话」按钮 —— 新建入口只有侧栏那一个。
    //       按钮与它的 addEventListener 一并删除：若只删 DOM 不删监听，
    //       取值会拿到 null，空状态直接抛 TypeError 白屏。
    content.innerHTML = `<div class="view"><div style="text-align:center;padding:80px 0;">
      <div class="fs-3xl" style="margin-bottom:12px">🏛️</div>
      <div class="fs-lg" style="font-weight:700;margin-bottom:8px">还没有对话</div>
      <div class="fs-base" style="color:var(--muted)">点击左侧「＋ 新建对话」，开始描述你的建筑问题</div>
    </div></div>`;
    return;
  }
  seedReveal(sess);
  let html = `<div class="chat-layout">
    <div class="chat-scroll" id="chat-scroll">`;
  if (!sess.messages.length) {
    html += `<div style="text-align:center;padding:60px 0 30px;">
      <div class="fs-3xl" style="margin-bottom:12px">🏛️</div>
      <div class="fs-lg" style="font-weight:700;margin-bottom:8px">知筑 Agent · AI 建筑设计工作台</div>
      <div class="fs-base" style="color:var(--muted);margin-bottom:5px">让公众问题进入建筑设计决策</div>
      <div class="fs-sm" style="color:var(--dim)">描述你的建筑问题，我会结合已采集的资料给出分析</div>
      <div style="margin-top:22px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;" id="chat-suggests"></div>
    </div>`;
  } else {
    // 需求④：逐字弹出 —— 只对「最后一条 assistant 回答」做节奏化揭示；
    //         光标只出现在正在揭示的气泡上，新消息到达时光标自然移走。
    const lastAsyncIdx = lastAssistantIndex(sess.messages);
    sess.messages.forEach((m, i) => {
      const thinking = !!m.thinking;
      const rv = revealSliceFor(sess, m, i, i === lastAsyncIdx);
      const bodyHtml = thinking ? renderThinking(m) : mdRender(rv.text);
      html += `<div class="msg ${m.role === "user" ? "user" : "assistant"}${thinking ? " thinking" : ""}" data-msg-index="${i}">
        <div class="avatar">${m.role === "user" ? "我" : "AI"}</div>
        <div class="body">
          <div class="name">${m.role === "user" ? "你" : "知筑 Agent · 建筑设计助手"}</div>
          <div class="bubble">${bodyHtml}${!thinking && rv.cursor ? TYPING_CURSOR_HTML : ""}</div>
        </div></div>`;
    });
  }
  html += `</div>
    <div class="chat-input-wrap">
      <div class="chat-input-box">
        <textarea id="chat-input" rows="1" placeholder="输入你的建筑设计问题…输入 @ 可召唤 Agent"></textarea>
        <button class="send-btn" id="chat-send" title="发送">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 11.5l15-7-4.5 15-3-6-7.5-2z"/><path d="M10.5 13.5L21 4.5"/></svg>
        </button>
      </div>
    </div>
  </div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';

  // 快捷建议
  const sg = $("#chat-suggests");
  if (sg) {
    [
      ["景区大门太远、排队暴晒，怎么优化？", "入口动线优化"],
      ["新建一座体育中心，选址静安，要考虑周边交通与商业配套", "选址与配套分析"],
      ["帮我分析主题乐园排队问题的建筑优化策略", "AI 策略对话"],
    ].forEach(([t, sub]) => {
      const b = el("button", "btn", esc(t));
      b.title = sub;
      b.addEventListener("click", () => { $("#chat-input").value = t; focusInput(); });
      sg.appendChild(b);
    });
  }

  bindChatInput();
  const sc = $("#chat-scroll");
  if (sc && ChatAutoScroll) sc.scrollTop = sc.scrollHeight;
}

function bindChatInput() {
  const ta = $("#chat-input");
  const send = $("#chat-send");
  if (!ta) return;
  const resize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 150) + "px"; };
  ta.addEventListener("input", resize);
  resize();
  const doSend = () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    resize();
    sendUserMessage(text);
  };
  send.addEventListener("click", doSend);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
}

function sendUserMessage(text) {
  const sess = activeSession();
  sess.messages.push({ role: "user", content: text });
  sess.sub = text.slice(0, 26);
  renderChatView();
  scheduleCacheSave();
  // 【已移除】原先的「@分析 / @拆解」指令解析。
  // 移除原因：用户反馈输入 @ 后系统无法返回内容（命中指令就走流水线并 return，
  // 不进普通对话）。现所有输入一律走普通对话；
  // 全流程分析请用「数据分析」页的「运行分析」按钮。
  // 普通对话：固定请求与会话关联，异步结果不会写入用户后来切换到的会话。
  const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const sessionId = sess.id;
  const msgs = [
    { role: "system", content: "你是 AI 建筑设计工作台（AI Architecture Workspace）的智能助手，面向建筑设计师与竞赛团队。你擅长：把公众/用户反馈转化为建筑问题与设计策略；结合工程概念验算给出建议；输出结构化、可落地的方案。回答使用简体中文，简洁专业。涉及公式、单位换算、受力计算等数学表达时，一律使用纯文本或 Unicode 数学符号（如 × ÷ ≤ ≥ ≈ ≠ ± ² ³ √ Σ Δ · °），不要输出 LaTeX（如 \\frac{}{}、\\times、\\sqrt{}、$...$），因为界面不做公式渲染，LaTeX 会原样显示成字符串。" },
  ];
  sess.messages
    .filter((message) => !message.thinking && !message.streaming)
    .forEach((message) => msgs.push({ role: message.role, content: message.content }));
  pushThinking(sessionId, requestId);
  chatWithAI(msgs, sessionId, requestId);
}

function pushAssistantChat(content) {
  const sess = activeSession();
  sess.messages.push({ role: "assistant", content });
  renderChatView();
  renderSidebar("chat");
}

function activeSession() {
  return State.chat.sessions.find((s) => s.id === State.chat.activeId) || null;
}
function newSession() {
  const s = {
    id: "s" + Date.now(),
    title: "新对话",
    sub: "刚刚",
    ts: Date.now(),
    messages: [],
  };
  State.chat.sessions.unshift(s);
  State.chat.activeId = s.id;
  return s;
}

/* 删除单个会话（缺陷③）：二次确认 + 删除后切换 active 会话 + 同步缓存 */
function deleteSession(sessionId) {
  const idx = State.chat.sessions.findIndex((s) => s.id === sessionId);
  if (idx < 0) return;
  const sess = State.chat.sessions[idx];
  const msgCount = (sess.messages || []).length;
  const tip = msgCount > 0
    ? `该对话有 ${msgCount} 条消息，确认删除？`
    : "确认删除这个空对话？";
  if (!confirm(tip)) return;

  State.chat.sessions.splice(idx, 1);

  // 删的是当前 active 会话 → 切到最近的会话；已无会话 → activeId 置空
  if (State.chat.activeId === sessionId) {
    State.chat.activeId = State.chat.sessions.length
      ? State.chat.sessions[Math.min(idx, State.chat.sessions.length - 1)].id
      : null;
  }

  // 同步缓存 + 刷新侧栏与对话区
  CacheStore.save();
  renderSidebar("chat");
  renderChatView();
  toast(msgCount > 0 ? "已删除对话" : "已删除空对话", "ok");
}

/* 一键清理所有空对话（缺陷③） */
function clearEmptySessions() {
  const before = State.chat.sessions.length;
  const kept = State.chat.sessions.filter((s) => s.messages && s.messages.length > 0);
  const removed = before - kept.length;
  if (removed <= 0) {
    toast("没有空对话需要清理", "ok");
    return;
  }
  State.chat.sessions = kept;
  if (State.chat.activeId && !kept.some((s) => s.id === State.chat.activeId)) {
    State.chat.activeId = kept.length ? kept[0].id : null;
  }
  CacheStore.save();
  renderSidebar("chat");
  renderChatView();
  toast(`已清理 ${removed} 个空对话`, "ok");
}

/* ================= 视图 2：项目工作台 =================
   数据绑定原则：所有数字只取真实字段，取不到一律显示 —，绝不硬编码示意值。
   取值来源（逐项标注，便于核对）：
     流程进度   → State.pipeline.steps 中 status === "done" 的条数
     已采集认知 → report.summary.total_items（与 main.py 控制台「采集条目」同一字段）
     生成报告   → output 目录中报告类成果文件的份数
     上次运行   → 成果文件的真实 mtime（epoch 毫秒，跨时区可靠）
     单步平均耗时 / 预计剩余 → 本次会话前端观测到的 run→done 时长（State.pipeline.stepTimes）
   措辞约束：实际实现是「一个模型 + 工具循环」，不是多 Agent 系统，
             因此一律称「工作流角色」，不写「多 Agent」。
   ------------------------------------------------------------ */

const WS_NO_DATA = "—";
/* 报告类成果文件：result_generator.generate() 的实际产物 */
const WS_REPORT_FILE_NAMES = ["architecture_report.json", "architecture_report.html"];

/* 内联 SVG 图标：不依赖网络字体 / CDN；emoji 不作为唯一信息载体 */
const WS_ICONS = {
  column: '<path d="M4 4.5h16M3.5 7.5h17M4.5 19.5h15M3.5 16.5h17"/><path d="M7 7.5v9M10.5 7.5v9M13.5 7.5v9M17 7.5v9"/>',
  data: '<path d="M5 20V10M11 20V4M17 20v-7"/><path d="M3 20h18"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  canvas: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
  engineering: '<path d="M12 3 3 8v8l9 5 9-5V8Z"/><path d="M12 12 3 8M12 12l9-4M12 12v9"/>',
  agents: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.4 3.1-5.4 7-5.4s7 2 7 5.4"/>',
  report: '<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 5.5H5v2A3 3 0 0 0 8 10.5M16 5.5h3v2a3 3 0 0 1-3 3"/><path d="M12 13v3.5M9 20h6"/>',
  files: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  arrow: '<path d="M5 12h13M13 7l5 5-5 5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
};

function wsIcon(id, size) {
  const s = size || 16;
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${WS_ICONS[id] || ""}</svg>`;
}

function wsReportArtifacts() {
  const list = Array.isArray(State.files) ? State.files : [];
  return list.filter((f) => f && WS_REPORT_FILE_NAMES.indexOf(f.name) >= 0);
}

/* 汇总工作台需要的全部真实数据 */
function wsCollect() {
  const p = State.pipeline || {};
  const steps = Array.isArray(p.steps) ? p.steps : [];
  const report = p.report || null;
  const summary = (report && report.summary) || null;
  const files = Array.isArray(State.files) ? State.files : [];
  const artifacts = wsReportArtifacts();
  const times = Object.keys(p.stepTimes || {})
    .map((k) => p.stepTimes[k])
    .filter((t) => t && typeof t.ms === "number" && t.ms >= 0);

  // 任务E：只统计「已知步号」的步骤。
  //   后端 workspace_pipeline.py 在第 8 步之后还会补发一条 step 9「完成」事件，
  //   它携带 report 数据（不能删），但不在 FLOW_STEPS 的 1..8 里。
  //   此前直接 filter(status==="done") 会把它算进去 → 显示「9 / 8 步」。
  //   这里按 FLOW_STEPS 的 n 过滤，并对 done / failed 做「不得超过 total」的防御。
  const knownNums = FLOW_STEPS.map((s) => s.n);
  const known = steps.filter((s) => knownNums.indexOf(s.step) >= 0);
  const done = Math.min(known.filter((s) => s.status === "done").length, FLOW_STEPS.length);
  const failed = Math.min(known.filter((s) => s.status === "fail").length, FLOW_STEPS.length - done);

  // 上次运行：优先报告成果文件 mtime，退化为 output 目录最新文件
  let lastRunAt = null;
  const src = artifacts.length ? artifacts : files;
  if (src.length) {
    const max = Math.max.apply(null, src.map((f) => Number(f.mtime) || 0));
    if (max > 0) lastRunAt = max;
  }

  return {
    steps,
    total: FLOW_STEPS.length,
    started: known.length > 0,
    done,
    runningStep: known.filter((s) => s.status === "run")[0] || null,
    failed,
    collected: summary && typeof summary.total_items === "number" ? summary.total_items : null,
    reportCount: files.length ? artifacts.length : null,
    lastRunAt,
    avgMs: times.length ? Math.round(times.reduce((a, t) => a + t.ms, 0) / times.length) : null,
    observed: times.length,
    report,
  };
}

function wsRelTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60000) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + " 分钟前";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + " 小时前";
  const day = Math.floor(hr / 24);
  if (day < 30) return day + " 天前";
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function wsDur(ms) {
  if (ms == null) return WS_NO_DATA;
  if (ms < 1000) return "不足 1 秒";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + " 秒";
  const mm = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${mm} 分 ${rest} 秒` : `${mm} 分钟`;
}

/* 进度横幅：只在有真实依据时才给出时间数字 */
function wsBanner(m) {
  if (m.runningStep) {
    const remain = Math.max(0, m.total - m.done - 1);
    const eta = (m.avgMs != null && remain > 0) ? wsDur(m.avgMs * remain) : null;
    return {
      cls: "run",
      html: `分析进行中 · 已完成 <b>${m.done} / ${m.total}</b> 步，正在执行「${esc(m.runningStep.step)}. ${esc(m.runningStep.name)}」`
        + (eta ? `，按本次已观测平均耗时外推还需 <b>约 ${esc(eta)}</b>` : ""),
    };
  }
  if (m.failed) {
    return { cls: "fail", html: `分析中断 · <b>${m.failed}</b> 步执行失败，已完成 <b>${m.done} / ${m.total}</b> 步，请查看运行日志后重试` };
  }
  if (m.started && m.done === m.total) {
    return {
      cls: "ok",
      html: `上一次分析已完成 · 共 <b>${m.done} / ${m.total}</b> 步`
        + (m.lastRunAt ? `，结束于 ${esc(wsRelTime(m.lastRunAt))}` : ""),
    };
  }
  if (m.started) {
    return { cls: "run", html: `已记录 <b>${m.done} / ${m.total}</b> 步进度` };
  }
  return { cls: "idle", html: `尚未运行分析 · 从「数据分析」开始，将依次执行 <b>${m.total}</b> 步标准流程` };
}

function wsMetricCard(label, valueHtml, extra) {
  return `<div class="ws-metric">
    <div class="ws-metric-k">${esc(label)}</div>
    <div class="ws-metric-v">${valueHtml}</div>
    ${extra || ""}
  </div>`;
}

function wsEntryCard(iconId, name, desc, goto, extraAttrs) {
  return `<div class="ws-card" data-goto="${goto}" role="button" tabindex="0"${extraAttrs || ""}>
    <span class="ws-card-ic">${wsIcon(iconId, 15)}</span>
    <div class="ws-card-tx"><div class="ws-card-name">${esc(name)}</div><div class="ws-card-desc">${esc(desc)}</div></div>
  </div>`;
}

/* 8 步工作流（工作台专用，不复用画布视图的 renderFlowBar） */
function wsStepTrack(m) {
  const byStep = {};
  m.steps.forEach((s) => { byStep[s.step] = s; });
  const times = State.pipeline.stepTimes || {};
  return FLOW_STEPS.map((s, i) => {
    const st = byStep[s.n];
    const status = st ? st.status : "pending";
    const cls = status === "done" ? "done" : status === "run" ? "run" : status === "fail" ? "fail" : "pending";
    const t = times[s.n];
    const sub = (cls === "done" && t && t.ms != null) ? `耗时 ${wsDur(t.ms)}` : esc(s.desc);
    const arrow = i < FLOW_STEPS.length - 1 ? `<div class="ws-arrow">${wsIcon("arrow", 11)}</div>` : "";
    return `<div class="ws-step ${cls}" data-step="${s.n}">
      <div class="ws-step-top"><span class="ws-step-badge">${cls === "done" ? "✓" : s.n}</span><span class="ws-step-name">${esc(s.name)}</span></div>
      <div class="ws-step-sub">${sub}</div>
      ${cls === "run" ? '<div class="ws-step-prog"><i></i></div>' : ""}
    </div>${arrow}`;
  }).join("");
}

/* ---------- 任务F：华为回答横向滚动栏 --------------------------
   数据全部来自 output/architecture_report.json（report.admitted_items）：
     标题 → 已采集的知乎讨论主题 / 提问标题（真实字段 title）
     摘录 → 知筑生成的设计方向（真实字段 design_directions）
     标签 → ai_analysis.问题类型（真实字段）
   诚信约束：
     · 不编造知乎用户的回答；取不到数据就不渲染卡片，只显示中性说明
     · 示例数据的 url 是占位地址（demo1…demo6 形式），一律不放链接，
       来源统一标注「由知筑基于公众讨论生成」
   滚动实现：零依赖。卡片渲染两份，用 requestAnimationFrame 推进 scrollLeft，
     越过「一份的宽度」后回退同样距离 → 无缝循环。
     悬停暂停 / 指针拖动 / prefers-reduced-motion 均轻量实现。
   ------------------------------------------------------------ */
const WS_ANSWER_LIMIT = 12;

function wsAnswerCards(report, limit) {
  const max = limit || WS_ANSWER_LIMIT;
  const items = (report && Array.isArray(report.admitted_items)) ? report.admitted_items : [];
  const rounds = items.reduce((mx, it) => {
    const d = (it && Array.isArray(it.design_directions)) ? it.design_directions.length : 0;
    return Math.max(mx, d);
  }, 0);
  const cards = [];
  // 轮转取用：每一轮从各条目各取一条，保证 12 条在条目之间分布均衡
  for (let round = 0; round < rounds && cards.length < max; round++) {
    for (let i = 0; i < items.length && cards.length < max; i++) {
      const it = items[i] || {};
      const dirs = Array.isArray(it.design_directions) ? it.design_directions : [];
      const text = String(dirs[round] || "").trim();
      if (!text) continue;
      const ai = it.ai_analysis || {};
      cards.push({
        title: String(it.title || "").trim(),
        text: text,
        tag: String(ai["问题类型"] || "").trim(),
      });
    }
  }
  return cards;
}

function wsAnswerCardHtml(c, dup) {
  const tag = c.tag ? `<span class="ws-ans-tag">${esc(c.tag)}</span>` : "";
  const title = c.title ? esc(c.title) : "公众讨论";
  return `<article class="ws-ans-card"${dup ? ' aria-hidden="true"' : ""}>
    ${tag}
    <div class="ws-ans-title">${title}</div>
    <div class="ws-ans-div"></div>
    <p class="ws-ans-text">${esc(c.text)}</p>
    <div class="ws-ans-src"><i></i>由知筑基于公众讨论生成</div>
  </article>`;
}

function wsAnswerStrip(m) {
  const cards = wsAnswerCards(m.report, WS_ANSWER_LIMIT);
  if (!cards.length) {
    return `<div class="ws-sec"><h3>华为回答</h3></div>
      <div class="ws-answers-empty">${WS_NO_DATA} 暂无可展示的华为回答 —— 先运行一次分析，报告生成后这里会列出知筑基于公众讨论生成的回答。</div>`;
  }
  const once = cards.map((c) => wsAnswerCardHtml(c, false)).join("");
  const twice = cards.map((c) => wsAnswerCardHtml(c, true)).join("");
  return `<div class="ws-sec"><h3>华为回答</h3></div>
    <div class="ws-answers" id="ws-answers">
      <div class="ws-answers-track" id="ws-answers-track">
        <div class="ws-answers-set">${once}</div>
        <div class="ws-answers-set" aria-hidden="true">${twice}</div>
      </div>
    </div>`;
}

/* 无缝循环 + 悬停暂停 + 拖动；视图切走时自动停止，不泄漏 rAF */
let WsAnsRaf = null;
function wsStopAnswers() {
  if (WsAnsRaf) { cancelAnimationFrame(WsAnsRaf); WsAnsRaf = null; }
}
function wsStartAnswers() {
  wsStopAnswers();
  const el = document.getElementById("ws-answers");
  const track = document.getElementById("ws-answers-track");
  if (!el || !track) return;

  let paused = false, dragging = false, lastX = 0;
  el.addEventListener("mouseenter", () => { paused = true; });
  el.addEventListener("mouseleave", () => { if (!dragging) paused = false; });

  el.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX;
    el.classList.add("dragging");
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* 不支持则退化为普通拖动 */ }
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    el.scrollLeft -= (e.clientX - lastX);
    lastX = e.clientX;
  });
  const endDrag = () => { dragging = false; el.classList.remove("dragging"); };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("pointerleave", endDrag);

  // 系统开启「减少动态效果」→ 不自动滚动，仍可手动横滑
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  const SPEED = 0.45;                                  // px / 帧（约 27px/s）
  const tick = () => {
    WsAnsRaf = requestAnimationFrame(tick);
    if (!el.isConnected) { wsStopAnswers(); return; }   // 已切走视图 → 收工
    if (paused || dragging) return;
    const half = track.scrollWidth / 2;                 // 两份完全等宽
    if (half <= el.clientWidth + 8) return;             // 内容不足一屏，不滚
    el.scrollLeft += SPEED;
    if (el.scrollLeft >= half) el.scrollLeft -= half;   // 无缝回卷
  };
  WsAnsRaf = requestAnimationFrame(tick);
}

/* 「上次运行」相对时间自更新；元素不存在时自动停止，不泄漏定时器 */
let WsRelTimer = null;
function wsStartRelTimer() {
  if (WsRelTimer) { clearInterval(WsRelTimer); WsRelTimer = null; }
  WsRelTimer = setInterval(() => {
    const el = document.getElementById("ws-lastrun");
    if (!el) { clearInterval(WsRelTimer); WsRelTimer = null; return; }
    const at = Number(el.dataset.at) || 0;
    if (at) el.textContent = wsRelTime(at);
  }, 30000);
}

function renderWorkspaceView() {
  const content = $("#content");
  const m = wsCollect();
  const banner = wsBanner(m);
  const roleCount = (State.agents || []).length;

  const progressBar = m.total
    ? `<div class="ws-metric-bar"><i style="width:${Math.min(100, Math.round((m.done / m.total) * 100))}%"></i></div>`
    : "";

  const lastRunHtml = m.lastRunAt
    ? `<span id="ws-lastrun" data-at="${m.lastRunAt}">${esc(wsRelTime(m.lastRunAt))}</span>`
    : `<span id="ws-lastrun">暂无记录</span>`;

  let html = `<div class="view ws-view">

    <div class="ws-head">
      <div class="ws-head-l">
        <div class="ws-head-icon">${wsIcon("column", 22)}</div>
        <div>
          <div class="ws-title">AI 建筑设计工作台</div>
          <div class="ws-sub">从 <em>华为公众认知</em> 推导建筑设计策略，输出<em>可解释</em>的完整方案</div>
          <div class="ws-head-meta">
            <span><i></i>${m.total} 步标准流程</span>
            <span><i></i>${roleCount} 个工作流角色</span>
            <span><i></i>全链路可追溯</span>
          </div>
        </div>
      </div>
      <button class="ws-ghost" type="button" data-goto="canvas">${wsIcon("info", 14)}查看流程说明</button>
    </div>

    <div class="ws-banner ${banner.cls}">
      ${wsIcon("info", 15)}
      <p>${banner.html}</p>
      <button class="ws-linkbtn" type="button" data-goto="data">查看运行日志${wsIcon("arrow", 11)}</button>
    </div>

    <div class="ws-metrics">
      ${wsMetricCard("流程进度",
        m.started ? `<span class="hl">${m.done}</span><s>/ ${m.total} 步</s>` : `${WS_NO_DATA}<s>/ ${m.total} 步</s>`,
        progressBar)}
      ${wsMetricCard("已采集认知",
        m.collected == null ? WS_NO_DATA : `${m.collected}<s>条</s>`)}
      ${wsMetricCard("生成报告",
        m.reportCount == null ? WS_NO_DATA : `${m.reportCount}<s>份</s>`)}
      ${wsMetricCard("上次运行", lastRunHtml)}
    </div>

    <div class="ws-sec"><h3>快捷入口</h3></div>
    <div class="ws-quick">
      <div class="ws-hero">
        <div class="ws-hero-top">
          <span class="ws-hero-ic">${wsIcon("data", 18)}</span>
          <span class="ws-badge">推荐起点</span>
        </div>
        <div class="ws-hero-name">数据分析</div>
        <div class="ws-hero-desc">一键运行华为分析全流程 · 实时查看分步进度与中间结果</div>
        <div class="ws-hero-cfg">
          <div><span>分析主体</span><b>${esc(State.pipeline.subject || WS_NO_DATA)}</b></div>
          <div><span>搜索关键词</span><b>${State.pipeline.keywords && State.pipeline.keywords.length ? esc(State.pipeline.keywords.join("、")) : WS_NO_DATA}</b></div>
          <div><span>运行模式</span><b>${State.pipeline.demo ? "演示模式" : "实时华为"}</b></div>
        </div>
        <button class="ws-hero-run" type="button" id="ws-run" ${State.pipeline.running ? "disabled" : ""}>
          ${wsIcon("play", 12)}${State.pipeline.running ? "分析中…" : "开始分析"}<u>${m.total} 步流程</u>
        </button>
      </div>

      ${wsEntryCard("chat", "AI 对话", "自然语言描述项目，或 @Agent 直接调度", "chat")}
      ${wsEntryCard("canvas", "设计画布", "可视化 8 步工作流与问题—设计方向映射", "canvas")}
      ${wsEntryCard("engineering", "工程验证", "对结构方案做四维概念验算", "engineering")}
      ${wsEntryCard("agents", "Agent 工作流", `查看 ${roleCount} 个工作流角色能力与运行日志`, "agents")}
      ${wsEntryCard("report", "设计成果", "查看分析报告、统计与设计建议", "report")}
      ${wsEntryCard("files", "文件管理", "管理 output 目录的报表与数据文件", "files")}
    </div>

    <div class="ws-sec"><h3>核心工作流</h3></div>
    <div class="ws-flow">
      <div class="ws-track">${wsStepTrack(m)}</div>
      <div class="ws-flow-foot">
        <span><i class="sq done"></i>已完成 ${m.done}</span>
        <span><i class="sq run"></i>进行中 ${m.runningStep ? 1 : 0}</span>
        <span><i class="sq fail"></i>失败 ${m.failed}</span>
        <span><i class="sq pending"></i>待运行 ${Math.max(0, m.total - m.done - (m.runningStep ? 1 : 0) - m.failed)}</span>
        <span class="ws-foot-note">单步平均耗时 ${
          m.avgMs == null
            ? WS_NO_DATA + "（本次会话尚未观测到完整步骤区间）"
            : wsDur(m.avgMs) + `（基于本次会话观测到的 ${m.observed} 步）`
        }</span>
      </div>
    </div>

    ${wsAnswerStrip(m)}

  </div>`;

  content.innerHTML = html;

  // 跳转：鼠标 + 键盘（Enter / Space），保证不依赖鼠标也能操作
  $$("[data-goto]", content).forEach((elm) => {
    const go = () => switchView(elm.dataset.goto);
    elm.addEventListener("click", go);
    elm.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        go();
      }
    });
  });

  const runBtn = $("#ws-run", content);
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      if (State.pipeline.running) return;
      switchView("data");
      runPipeline(State.pipeline.subject, State.pipeline.keywords, State.pipeline.demo);
    });
  }

  wsStartAnswers();
  wsStartRelTimer();
}
function renderFlowBar() {
  return `<div class="flow-canvas">${FLOW_STEPS.map((s, i) => {
    const st = State.pipeline.steps.find((x) => x.step === s.n);
    const cls = st ? (st.status === "done" ? " done" : st.status === "run" ? " active" : "") : "";
    return `<div class="flow-node${cls}">${i ? "" : ""}<div class="fn-ic">${s.ic}</div><div class="fn-name">${s.n}. ${esc(s.name)}</div><div class="fn-desc">${esc(s.desc)}</div></div>${i < FLOW_STEPS.length - 1 ? '<div class="flow-link">→</div>' : ""}`;
  }).join("")}</div>`;
}

/* ================= 视图 3：数据分析 ================= */
function renderDataView() {
  const p = State.pipeline;
  const scored = p.scored;
  const admitted = scored.filter((x) => x.admitted);
  const r = p.report;
  const content = $("#content");
  let html = `<div class="view">
    <div class="card" style="margin-bottom:14px;">
      <div class="card-title">分析控制台 <span class="sub">华为公众认知 → 建筑问题识别 → 设计策略 → 工程约束</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <label class="fs-xs" style="display:flex;flex-direction:column;gap:4px;color:var(--dim)">分析主体
          <input class="input" id="subj-input" value="${esc(p.subject)}" style="width:200px;" placeholder="如：方特 / 火车站 / 体育中心"/>
        </label>
        <div style="flex:1;min-width:280px;">
          <div class="fs-xs" style="color:var(--dim);margin-bottom:4px">搜索关键词</div>
          <div class="kw-edit" id="kw-edit"></div>
        </div>
        <button class="btn primary" id="data-run" ${p.running ? "disabled" : ""}>${p.running ? "分析中…" : "▶ 运行全流程"}</button>
      </div>
    </div>`;

  // 步骤条 + 统计
  html += `<div style="display:grid;grid-template-columns:minmax(300px,380px) 1fr;gap:14px;align-items:start;">`;
  html += `<div class="card"><div class="card-title">流程进度 <span class="sub">${p.running ? "运行中" : "就绪"}</span></div>${renderStepsLarge()}</div>`;
  html += `<div><div class="stat-grid" style="margin-bottom:14px;">
      ${statCard(scored.length || "—", "参与评分", "b")}
      ${statCard(admitted.length || "—", "准入条目", "g")}
      ${statCard(r && r.summary && r.summary.admission_rate != null ? r.summary.admission_rate + "%" : "—", "准入率", "a")}
      ${statCard(p.demo ? "演示" : "实时", "数据模式", "p")}
    </div>
    <div class="card"><div class="card-title">评分条目（五维建筑相关性） <span class="sub">准入线 60 分；有强建筑问题证据的条目可破格准入</span></div>
      ${scored.length ? renderScoreTable(scored) : emptyState("运行分析后展示评分条目")}
    </div></div>`;
  html += `</div></div>`;
  content.innerHTML = html;

  // 关键词编辑
  const kw = $("#kw-edit");
  if (kw) {
    p.keywords.forEach((k) => {
      const c = el("span", "kw-chip", `<span>${esc(k)}</span><span class="x">×</span>`);
      c.querySelector(".x").addEventListener("click", () => {
        p.keywords = p.keywords.filter((x) => x !== k);
        renderDataView();
      });
      kw.appendChild(c);
    });
    const add = el("span", "kw-add", "+ 添加");
    add.addEventListener("click", () => {
      const v = prompt("输入关键词");
      if (v && v.trim()) { p.keywords.push(v.trim()); renderDataView(); }
    });
    kw.appendChild(add);
  }

  $("#subj-input").addEventListener("change", (e) => { p.subject = e.target.value.trim() || p.subject; });
  $("#data-run").addEventListener("click", () => {
    const subj = $("#subj-input").value.trim() || p.subject;
    p.subject = subj;
    runPipeline(subj, p.keywords, p.demo);
  });
}

function renderStepsLarge() {
  const steps = State.pipeline.steps;
  if (!steps.length) {
    return `<div class="fs-sm" style="color:var(--dim);padding:10px 0">点击「运行全流程」开始 8 步分析</div>`;
  }
  return `<div class="steps">${steps.map((s) => `
    <div class="step-row ${s.status}">
      <div class="rail"><div class="node">${s.status === "done" ? "✓" : s.status === "fail" ? "!" : ""}</div><div class="line"></div></div>
      <div class="sbody"><div class="sname">${s.step}. ${esc(s.name)}</div><div class="smsg">${esc(s.message || "")}</div></div>
    </div>`).join("")}
    ${FLOW_STEPS.filter((f) => !steps.some((s) => s.step === f.n)).map((f) => `
    <div class="step-row">
      <div class="rail"><div class="node"></div><div class="line"></div></div>
      <div class="sbody"><div class="sname" style="color:var(--dim);">${f.n}. ${esc(f.name)}</div></div>
    </div>`).join("")}
  </div>`;
}

function renderScoreTable(items) {
  const rows = items.slice(0, 30).map((it) => {
    const ai = it.ai_analysis || {};
    const q = ai["建筑问题"] || it.problem_types?.join("、") || "—";
    const dir = it.design_directions || [];
    return `<tr><td><div style="max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(it.title || "")}">${esc(it.title || it.content || "—")}</div></td>
      <td style="width:70px;">${it.score != null ? "<b>" + Math.round(it.score) + "</b>" : "—"}</td>
      <td style="width:80px;">${it.admitted ? '<span class="badge-ok">准入</span>' : '<span class="badge-no">未过</span>'}</td>
      <td style="width:230px;"><div style="max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(q)}">${esc(q)}</div></td>
      <td><div style="max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(dir.join("；"))}">${esc(dir.join("；") || "—")}</div></td></tr>`;
  }).join("");
  return `<table class="tbl"><thead><tr><th>内容标题</th><th>评分</th><th>准入 <span style="font-weight:normal;color:var(--dim);font-size:11px">（≥60 或强证据）</span></th><th>建筑问题</th><th>设计方向</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ================= 视图 4：Agent ================= */
function renderAgentsView() {
  const content = $("#content");
  let html = `<div class="section"><h3><span class="bar"></span>Agent 工作流</h3>
    <div class="fs-sm" style="color:var(--dim);margin:-4px 0 12px;line-height:1.6">单模型 + Python 工具循环编排的工作流角色，非独立多模型 Agent 系统。</div>
    <div class="agent-grid">`;
  State.agents.forEach((a) => {
    const logCount = State.pipeline.logs.filter((l) => (l.message || "").includes(a.name)).length;
    html += `<div class="agent-card">
      <div class="a-status">${logCount ? `<span class="tag g">已参与</span>` : `<span class="tag">就绪</span>`}</div>
      <div class="a-head"><div class="a-ic" style="background:${a.color};">${a.ic}</div>
        <div><div class="a-name">${esc(a.name)}</div><div class="a-role">${esc(a.role)}</div></div></div>
      <div class="a-desc">${esc(a.desc)}</div>
    </div>`;
  });
  html += `</div></div>`;
  html += `<div class="section"><h3><span class="bar"></span>协作编排</h3><div class="card">
    <div class="fs-sm" style="color:var(--muted);line-height:2;font-family:var(--mono)">
      需求拆解 → 华为采集 → 数据清洗 → 五维评分 → AI 建筑问题 → 设计方向 → 工程验算 → 报告输出</div>
    </div></div>`;
  html += `<div class="section"><h3><span class="bar"></span>运行日志</h3><div class="card">`;
  html += State.pipeline.logs.length
    ? State.pipeline.logs.slice(-30).map((l) => `<div class="fs-xs" style="font-family:var(--mono);color:var(--dim);padding:2px 0">${esc(l.message || "")}</div>`).join("")
    : emptyState("运行分析后此处展示日志");
  html += `</div></div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';
}

/* ================= 视图 5：画布 ================= */
function renderCanvasView() {
  const scored = State.pipeline.scored.filter((x) => x.admitted);
  const content = $("#content");
  let html = `
    <div class="section"><h3><span class="bar"></span>8 步工作流可视化</h3>
      <div class="card">${renderFlowBar()}
        <div class="legend">
          <span><i style="background:var(--accent);"></i>当前/高亮</span>
          <span><i style="background:var(--green);"></i>已完成</span>
          <span><i style="background:var(--border2);"></i>未执行</span>
        </div>
      </div>
    </div>
    <div class="section"><h3><span class="bar"></span>公众问题 → 设计方向映射</h3>`;
  html += scored.length
    ? `<div class="flow-map">${scored.slice(0, 24).map((it) => {
        const ai = it.ai_analysis || {};
        const q = ai["建筑问题"] || it.problem_types?.join("、") || "—";
        const dirs = it.design_directions || [];
        return `<div class="map-card">
          <div class="q">❓ ${esc(q)}</div>
          <div class="d">${dirs.map((d) => "<b>▸</b> " + esc(d)).join("<br>") || '<span style="color:var(--dim);">—</span>'}</div>
        </div>`;
      }).join("")}</div>`
    : `<div class="card">${emptyState("运行分析后展示问题→设计方向映射")}</div>`;
  html += `</div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';
  $$(".flow-node", content).forEach((n) => {
    n.addEventListener("click", () => switchView("data"));
  });
}

/* ================= 视图 6：工程验证 ================= */
function renderEngineeringView() {
  const f = State.engineering.form;
  const r = State.engineering.last;
  const content = $("#content");
  const isCantilever = f.scheme_type === "cantilever";
  const spanLabel = isCantilever ? "悬挑跨度 m" : "跨度 m";
  const anchorHidden = !isCantilever;
  let html = `<div class="eng-grid">
    <div class="card"><div class="card-title">结构方案参数</div>
      <div class="eng-form">
        <label>方案类型<select class="input" id="e-scheme">${["cantilever", "simple_beam"].map((x) => `<option ${f.scheme_type === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label id="e-span-label">${spanLabel}<input class="input" id="e-span" type="number" step="0.1" value="${f.span_m}"></label>
        <label>宽度 m<input class="input" id="e-width" type="number" step="0.1" value="${f.width_m}"></label>
        <label>恒载 kPa<input class="input" id="e-dead" type="number" step="0.1" value="${f.dead_load_kpa}"></label>
        <label>活载 kPa<input class="input" id="e-live" type="number" step="0.1" value="${f.live_load_kpa}"></label>
        <label>材料<select class="input" id="e-mat">${["Q235", "Q355", "timber"].map((x) => `<option ${f.material === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>截面宽 b(m)<input class="input" id="e-b" type="number" step="0.05" value="${f.b_m}"></label>
        <label>截面高 h(m)<input class="input" id="e-h" type="number" step="0.05" value="${f.h_m}"></label>
        <label class="full" id="e-anchor-field"${anchorHidden ? ' style="display:none;"' : ""}>锚固段长度 m<input class="input" id="e-anchor" type="number" step="0.1" value="${f.anchor_m}"></label>
      </div>
      <div style="margin-top:12px;"><button class="btn primary" id="e-run">开始验算</button></div>
      <div class="fs-xs" style="margin-top:10px;color:var(--dim);line-height:1.6">概念级估算，非施工依据；含荷载组合、材料强度、变形、抗倾覆四维校验。</div>
    </div>
    <div class="card"><div class="card-title">验算结果 <span class="sub">${r ? (r.passed ? "总体通过" : "存在风险") : "等待验算"}</span></div>
      ${r ? renderEngResult(r) : emptyState("填写左侧参数，点击「开始验算」")}
    </div>
  </div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';

  // 方案类型切换时：动态更新跨度标签 + 锚固段字段显隐
  $("#e-scheme").addEventListener("change", (ev) => {
    const cant = ev.target.value === "cantilever";
    $("#e-span-label").childNodes[0].textContent = cant ? "悬挑跨度 m" : "跨度 m";
    $("#e-anchor-field").style.display = cant ? "" : "none";
  });

  $("#e-run").addEventListener("click", () => {
    f.scheme_type = $("#e-scheme").value;
    f.span_m = Number($("#e-span").value);
    f.width_m = Number($("#e-width").value);
    f.dead_load_kpa = Number($("#e-dead").value);
    f.live_load_kpa = Number($("#e-live").value);
    f.material = $("#e-mat").value;
    f.b_m = Number($("#e-b").value);
    f.h_m = Number($("#e-h").value);
    f.anchor_m = Number($("#e-anchor").value);
    runCheckScheme(f);
  });
}

function renderEngResult(r) {
  let html = "";
  (r.dimension_results || []).forEach((d) => {
    // 三态：true=PASS / false=FAIL / null=UNKNOWN（缺参数无法判定）
    const state = d.pass === true ? "pass" : (d.pass === false ? "fail" : "neutral");
    const icon = d.pass === true ? "✅" : (d.pass === false ? "❌" : "⚠️");
    const badge = d.pass === true
      ? '<span class="badge-ok">通过</span>'
      : (d.pass === false ? '<span class="badge-no">不通过</span>' : '<span class="badge-warn">未判定</span>');
    html += `<div class="dim-result ${state}">
      <div class="d-title">${icon} ${esc(d.dimension)} <span class="d-badge">${badge}</span></div>
      <div class="d-detail">${esc(d.detail || "")}</div>
      ${d.message ? `<div class="d-msg">${esc(d.message)}</div>` : ""}
    </div>`;
  });
  if (r.risks && r.risks.length) html += `<div style="margin-top:6px;">${r.risks.map((x) => `<div class="tag r" style="margin:3px 4px 0 0;">${esc(x.slice(0, 40))}</div>`).join("")}</div>`;
  if (r.suggestions && r.suggestions.length) {
    html += `<div class="card-title" style="margin-top:10px;">优化建议</div>`;
    html += r.suggestions.map((s) => `<div class="fs-sm" style="color:var(--muted);margin-bottom:6px;line-height:1.6">▸ ${esc(s)}</div>`).join("");
  }
  return html;
}

/* ================= 视图：结构病害检测 ================= */
const DZ_MAX_BYTES = 8 * 1024 * 1024;

function dzFmtSize(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function renderDiseaseResult(r) {
  const s = r.stats || {};
  const model = r.model_info || {};
  const isModel = r.engine === "cracknet";
  const hasMm = typeof s.avg_width_mm === "number";
  const avgW = hasMm ? s.avg_width_mm : s.avg_width_px;
  const maxW = hasMm ? s.max_width_mm : s.max_width_px;
  const it = r.intermediate || {};
  const engineLabel = isModel ? "CrackNet 小模型（实验）" : "规则方法";
  const params = Number.isInteger(model.params) ? model.params.toLocaleString("en-US") : "43,265";

  let html = `<div class="dz-note" style="margin:0 0 12px;">检测方式：<b>${engineLabel}</b>${isModel ? ` · ${esc(params)} 个参数<br>已完成公开桥面图块测试，仍有误报和漏检；现场照片需人工复核。` : ""}</div>`;

  // 顶部大字：本图共几条
  const best = s.crack_count_best != null ? s.crack_count_best : s.crack_count;
  const lo = s.crack_count_lower != null ? s.crack_count_lower : s.crack_count;
  const hi = s.crack_count_upper != null ? s.crack_count_upper : s.crack_segment_count;
  html += `<div style="text-align:center;padding:10px 0 6px;">
    <div style="font-size:13px;color:var(--dim);">本图检出裂缝候选</div>
    <div style="font-size:48px;font-weight:800;line-height:1.1;color:var(--accent);">${best == null ? "—" : best} <span style="font-size:20px;font-weight:400;">条</span></div>
    <div style="font-size:12px;color:var(--dim);">估计值（可能是 ${lo}~${hi} 条）</div>
  </div>`;

  // 严重度分布
  const sev = s.severity_summary || {};
  if ((!sev["重"] && !sev["中"] && !sev["轻"]) && r.components) {
    r.components.filter(c => c.verdict === "crack").forEach(c => {
      const t = c.severity || "中";
      if (sev[t] !== undefined) sev[t]++;
      else sev[t] = 1;
    });
  }
  html += `<div style="display:flex;justify-content:center;gap:20px;margin:8px 0 14px;font-size:14px;">
    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ef4444;margin-right:4px;"></span>重 <b>${sev["重"] || 0}</b> 条</span>
    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;margin-right:4px;"></span>中 <b>${sev["中"] || 0}</b> 条</span>
    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#eab308;margin-right:4px;"></span>轻 <b>${sev["轻"] || 0}</b> 条</span>
    <span style="color:var(--dim);font-size:12px;">${esc(s.severity_method || "")}</span>
  </div>`;

  html += `<div class="dz-stats">
    <div class="dz-stat"><div class="k">裂缝连通域</div><div class="v">${s.crack_count == null ? "—" : s.crack_count}</div><div class="u">估计下限</div></div>
    <div class="dz-stat"><div class="k">骨架段数</div><div class="v">${s.crack_segment_count == null ? "—" : s.crack_segment_count}</div><div class="u">估计上限近似</div></div>
    <div class="dz-stat"><div class="k">裂缝占比</div><div class="v">${s.crack_pixel_ratio == null ? "—" : (s.crack_pixel_ratio * 100).toFixed(2) + "%"}</div><div class="u">占全图像素</div></div>
    <div class="dz-stat"><div class="k">平均宽度</div><div class="v">${avgW == null ? "—" : avgW.toFixed(2)}</div><div class="u">${hasMm ? "毫米" : "像素（估算上界）"}</div></div>
    <div class="dz-stat"><div class="k">最宽连通域均宽</div><div class="v">${maxW == null ? "—" : maxW.toFixed(2)}</div><div class="u">${hasMm ? "毫米" : "像素（估算上界）"}</div></div>
    ${isModel ? `<div class="dz-stat"><div class="k">结果性质</div><div class="v" style="font-size:20px;">分割候选</div><div class="u">需人工复核，未判别成因</div></div>` : `<div class="dz-stat"><div class="k">疑似非裂缝</div><div class="v">${s.suspect_count == null ? "—" : s.suspect_count}</div><div class="u">阴影带/污渍，已排除统计</div></div>`}
  </div>`;

  html += `<div class="dz-imgs">
    <figure><img src="data:image/png;base64,${r.overlay_b64 || ""}" alt="裂缝检测叠加标注图"><figcaption>叠加标注（红=裂缝候选，编号=严重度降序，黄框=连通域）</figcaption></figure>
    <figure><img src="data:image/png;base64,${r.mask_b64 || ""}" alt="裂缝掩膜图"><figcaption>裂缝掩膜</figcaption></figure>
  </div>`;

  html += `<div class="dz-detail"><div class="card-title">检测明细</div>
    <div class="dz-kv">
      <span>图像尺寸</span><b>${esc((s.image_size_px || []).join(" × "))} px</b>
      <span>裂缝面积</span><b>${s.crack_area_px == null ? "—" : s.crack_area_px} px</b>
      ${it.resize_scale == null ? "" : `<span>缩放系数</span><b>${it.resize_scale}</b>`}
      ${!isModel && s.detectable_width_upper_px != null ? `<span>可检出宽度上限</span><b>${s.detectable_width_upper_px} px</b>` : ""}
    </div></div>`;

  // 颜色图例
  html += `<div style="display:flex;justify-content:center;gap:24px;margin:10px 0 4px;font-size:13px;">
    <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#ef4444;vertical-align:middle;margin-right:4px;"></span>红 = 重</span>
    <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#f59e0b;vertical-align:middle;margin-right:4px;"></span>橙 = 中</span>
    <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#eab308;vertical-align:middle;margin-right:4px;"></span>黄 = 轻</span>
    <span style="color:var(--dim);">图上标注 = 编号 + 宽×长(px)</span>
  </div>`;

  if (r.components && r.components.length) {
    const crackList = r.components.filter(c => c.verdict === "crack");
    html += `<div class="dz-detail"><div class="card-title">裂缝清单（${crackList.length} 条）</div>`;
    crackList.slice(0, 24).forEach((c, i) => {
      const sevVal = c.severity || "—";
      const sevColor = sevVal === "重" ? "#ef4444" : sevVal === "中" ? "#f59e0b" : sevVal === "轻" ? "#eab308" : "var(--dim)";
      const sevIcon = sevVal === "重" ? "🔴" : sevVal === "中" ? "🟠" : sevVal === "轻" ? "🟡" : "";
      const conf = c.confidence;
      const confStr = conf && conf.calibrated_prob != null ? Math.round(conf.calibrated_prob * 100) + "%" : (conf && conf.score != null ? Math.round(conf.score * 100) + "%" : "—");
      const w = c.width_px != null ? c.width_px.toFixed(1) : "—";
      const l = c.length_px != null ? Math.round(c.length_px) : "—";
      html += `<div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--border,#333);font-size:13px;">
        <b style="width:28px;color:${sevColor};">${c.id || i + 1}</b>
        <span style="width:50px;color:${sevColor};font-weight:600;">${sevIcon} ${sevVal}</span>
        <span style="flex:1;">宽 <b>${w}</b> px · 长 <b>${l}</b> px</span>
        <span style="color:var(--dim);">把握度 <b style="color:var(--text,#fff);">${confStr}</b></span>
      </div>`;
    });
    html += `</div>`;
  }

  html += `<div class="dz-note" style="margin-top:12px;font-size:12px;color:var(--dim);">
    提示：严重度是同一张图内的<strong>相对排序</strong>（越粗越长→越重），不是规范定级。
    ${!hasMm ? "未填比例尺，宽度单位是像素。" : ""}
    超过 ${s.detectable_width_upper_px || 9}px 的宽裂缝可能漏检，请对照原图看。</div>`;
  return html;
}

function renderDiseaseView() {
  const content = $("#content");
  const d = State.disease;
  const r = d.last;
  const engine = d.engine === "rule" ? "rule" : "cracknet";
  d.engine = engine;

  let html = `<div class="section"><h3><span class="bar"></span>结构病害检测 · 表面裂缝初筛</h3>
    <div class="dz-grid">
      <div class="card">
        <div class="card-title">上传待检测照片</div>
        <label class="dz-drop" id="dz-drop" for="dz-file">
          <input type="file" id="dz-file" accept="image/*" hidden ${d.busy ? "disabled" : ""}>
          <div class="dz-drop-ic">🖼️</div>
          <div class="dz-drop-t" id="dz-drop-t">${d.fileName ? esc(d.fileName) : "点击选择图片，或把图片拖到这里"}</div>
          <div class="dz-drop-s">支持 JPG / PNG，单张不超过 8 MB</div>
        </label>
        <div class="dz-scale">
          <label class="dz-scale-l" for="dz-engine">检测方式</label>
          <select class="input" id="dz-engine" ${d.busy ? "disabled" : ""}>
            <option value="cracknet" ${engine === "cracknet" ? "selected" : ""}>CrackNet 小模型（实验）</option>
            <option value="rule" ${engine === "rule" ? "selected" : ""}>规则方法</option>
          </select>
          <div class="dz-scale-h">小模型含 43,265 个参数；公开桥面图块实测仍有误报和漏检，现场照片需人工复核。可切换方法对同一张照片检测。</div>
        </div>
        <div class="dz-scale">
          <label class="dz-scale-l" for="dz-mm">比例尺（mm/px，可选）</label>
          <input class="input" id="dz-mm" type="number" step="any" min="0" value="${esc(d.mmPerPx || "")}" placeholder="例如 0.35" ${d.busy ? "disabled" : ""}>
          <div class="dz-scale-h">同框放一把标尺，用「标尺实际长 mm ÷ 对应像素长 px」填写。<b>不填就只报像素。</b></div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center;">
          <button class="btn primary" id="dz-run" type="button" ${d.busy ? "disabled" : ""}>${d.busy ? "检测中…" : "开始检测"}</button>
          ${r || d.error ? `<button class="btn" id="dz-clear" type="button" ${d.busy ? "disabled" : ""}>清空结果</button>` : ""}
        </div>
        <div class="dz-note" style="margin-top:12px;">图片上传至当前应用处理，不会发送给第三方 AI 识图服务。</div>
      </div>
      <div class="card">
        <div class="card-title">检测结果 <span class="sub">${d.busy ? "检测中" : d.error ? "未完成" : r ? "已完成" : "等待图片"}</span></div>
        ${d.error ? `<div class="dz-note" role="alert">${esc(d.error)}</div>` : ""}
        ${r ? renderDiseaseResult(r) : emptyState(d.busy ? "正在提取裂缝…" : d.error ? "请检查提示后重试，也可手动切换检测方式。" : "先在左侧选择一张表面照片")}
      </div>
    </div></div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';

  const fileInput = $("#dz-file");
  const dropT = $("#dz-drop-t");
  const drop = $("#dz-drop");
  const engineInput = $("#dz-engine");
  const mmInput = $("#dz-mm");
  if (engineInput) engineInput.addEventListener("change", () => { d.engine = engineInput.value === "rule" ? "rule" : "cracknet"; });
  if (mmInput) mmInput.addEventListener("input", () => { d.mmPerPx = mmInput.value; });

  const pickFile = (f) => {
    if (!f || d.busy) return;
    if (f.type && !/^image\//.test(f.type)) { toast("请选择图片文件", "err"); return; }
    if (f.size > DZ_MAX_BYTES) { toast("图片超过 8 MB，请先压缩", "err"); return; }
    d.pickedFile = f;
    d.fileName = f.name + "（" + dzFmtSize(f.size) + "）";
    if (dropT) dropT.textContent = d.fileName;
  };
  if (fileInput) fileInput.addEventListener("change", () => pickFile(fileInput.files && fileInput.files[0]));
  if (drop) {
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); if (!d.busy) drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => pickFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
  }

  const runBtn = $("#dz-run");
  if (runBtn) runBtn.addEventListener("click", () => {
    if (d.busy) return;
    const file = d.pickedFile;
    if (!file) { toast("请先选择一张图片", "err"); return; }
    const mmRaw = (mmInput.value || "").trim();
    let mm = null;
    if (mmRaw) {
      mm = Number(mmRaw);
      if (!Number.isFinite(mm) || mm <= 0) { toast("比例尺必须是正数", "err"); return; }
    }
    const requestEngine = engineInput.value === "rule" ? "rule" : "cracknet";
    d.engine = requestEngine;
    d.mmPerPx = mmRaw;
    d.busy = true;
    d.error = "";
    d.last = null;
    renderDiseaseView();
    const fail = (message) => { d.busy = false; d.error = message; renderDiseaseView(); toast(message, "err"); };
    const fr = new FileReader();
    fr.onload = () => {
      try {
        Promise.resolve(Bridge.invoke("detect_disease", { image_b64: String(fr.result || ""), mm_per_px: mm, engine: requestEngine }))
          .then((reply) => { if (reply && reply.ok === false) fail(reply.message || reply.error || "检测请求未能发送，请重试"); })
          .catch((error) => fail(error && error.message ? error.message : "检测请求发送失败"));
      } catch (error) { fail(error && error.message ? error.message : "检测请求发送失败"); }
    };
    fr.onerror = () => fail("读取图片失败，请重新选择图片");
    fr.readAsDataURL(file);
  });

  const clearBtn = $("#dz-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    if (d.busy) return;
    d.last = null;
    d.error = "";
    d.fileName = "";
    d.pickedFile = null;
    d.mmPerPx = "";
    renderDiseaseView();
  });
}

/* ================= 视图 7：文件 ================= */
function renderFilesView() {
  const content = $("#content");
  let html = `<div class="section"><h3><span class="bar"></span>output / 输出文件</h3><div class="card">`;
  if (!State.files.length) {
    html += emptyState("output 目录为空，运行分析后生成");
  } else {
    html += `<div style="display:flex;flex-direction:column;gap:2px;">${State.files.map((f) => {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const ic = ext === "html" ? "🌐" : ext === "json" ? "📄" : ext === "png" ? "🖼️" : "📁";
      return `<div class="file-row">
        <div class="f-ic">${ic}</div>
        <div class="f-name">${esc(f.name)}</div>
        <div class="f-size">${fmtSize(f.size)}</div>
        <div class="f-size" style="color:var(--dim);">${fmtTime(f.mtime)}</div>
        <button class="btn" data-open="${esc(f.path)}">定位</button>
        ${ext === "html" ? `<button class="btn primary" data-view="${esc(f.path)}">打开报告</button>` : ""}
      </div>`;
    }).join("")}</div>`;
  }
  html += `</div></div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';
  $$("[data-open]", content).forEach((b) => {
    b.addEventListener("click", () => Bridge.openPath(b.dataset.open));
  });
  $$("[data-view]", content).forEach((b) => {
    b.addEventListener("click", () => Bridge.openPath(b.dataset.view));
  });
}

/* ================= 视图 8：成果 ================= */
function renderReportView() {
  const r = State.pipeline.report;
  const content = $("#content");
  if (!r) {
    content.innerHTML = `<div class="view"><div class="card" style="max-width:520px;margin:80px auto;text-align:center;padding:40px;">
      <div class="fs-3xl" style="margin-bottom:12px">🏆</div>
      <div class="fs-lg" style="font-weight:600;margin-bottom:8px">尚未生成设计成果</div>
      <div class="fs-base" style="color:var(--dim);margin-bottom:18px">运行分析流程后，此处将展示统计、问题与设计建议</div>
      <button class="btn primary" id="report-go">前往数据分析</button>
    </div></div>`;
    $("#report-go").addEventListener("click", () => switchView("data"));
    return;
  }
  const s = r.summary || {};
  const meta = r.meta || {};
  const scored = State.pipeline.scored;
  let html = `
    <div class="report-hero">
      <h2>🏛️ ${esc(meta.project || "建筑设计分析报告")}</h2>
      <div class="meta">主体：${esc(meta.subject || "—")} · 关键词：${esc((meta.keywords || []).join("、"))}</div>
      <div class="meta">生成时间：${esc(meta.generated_at || "")} · ${meta.demo ? "演示模式" : "实时华为数据"}</div>
    </div>
    <div class="stat-grid">
      ${statCard(s.total_items ?? "—", "原始条目", "b")}
      ${statCard(s.admitted_items ?? "—", "准入条目", "g")}
      ${statCard(s.admission_rate != null ? s.admission_rate + "%" : "—", "准入率", "a")}
      ${statCard(meta.ai_enabled ? "已启用" : "规则引擎", "AI 分析", "p")}
    </div>`;

  // 问题类型分布
  const typeDist = s.top_problem_types || [];
  if (typeDist.length) {
    const max = Math.max(...typeDist.map((x) => x.count || 0));
    html += `<div class="section"><h3><span class="bar"></span>建筑问题类型分布</h3><div class="card">`;
    typeDist.forEach((x) => {
      const v = x.count || 0;
      const pct = max ? Math.round((v / max) * 100) : 0;
      html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <span class="fs-sm" style="width:110px;color:var(--muted)">${esc(x.problem_type || "")}</span>
        <div class="bar-h" style="flex:1;"><i style="width:${pct}%;background:${pct > 70 ? "var(--red)" : pct > 40 ? "var(--amber)" : "var(--accent)"};"></i></div>
        <span class="fs-sm" style="width:36px;text-align:right;font-family:var(--mono)">${v}</span>
      </div>`;
    });
    html += `</div></div>`;
  }

  // AI 设计策略建议
  const dirs = s.aggregated_design_directions || [];
  if (dirs.length) {
    html += `<div class="section"><h3><span class="bar"></span>AI 设计策略建议</h3><div class="card">`;
    dirs.slice(0, 12).forEach((d, i) => {
      html += `<div style="padding:9px 0;border-bottom:1px solid var(--border);${i === Math.min(dirs.length, 12) - 1 ? "border:none;" : ""}">
        <div class="fs-base" style="line-height:1.6;color:var(--text)"><span style="color:var(--accent);font-weight:700;">▸</span> ${esc(d)}</div>
      </div>`;
    });
    html += `</div></div>`;
  }

  // 准入条目
  if (scored.length) {
    html += `<div class="section"><h3><span class="bar"></span>准入条目明细</h3><div class="card">${renderScoreTable(scored.slice(0, 30))}</div></div>`;
  }

  html += `<div class="section"><div style="display:flex;gap:10px;">
    <button class="btn primary" id="report-browser">在浏览器打开完整报告</button>
    <button class="btn" id="report-open">定位报告文件</button>
  </div></div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';

  $("#report-browser").addEventListener("click", async () => {
    const files = await Bridge.listFiles();
    const f = files.find((x) => x.name === "architecture_report.html");
    if (f) Bridge.openPath(f.path);
  });
  $("#report-open").addEventListener("click", async () => {
    const files = await Bridge.listFiles();
    const f = files.find((x) => x.name === "architecture_report.json");
    if (f) Bridge.openPath(f.path);
  });
  $$("[data-open]", content).forEach((b) => {
    b.addEventListener("click", () => Bridge.openPath(b.dataset.open));
  });
}

/* ================= Skill 工具箱 ================= */
function renderSkillsView() {
  const content = $("#content");
  const skills = State.skills.items || [];
  if (State.skills.loading && !State.skills.loaded) {
    content.innerHTML = `<div class="view"><div class="card">${emptyState("正在读取已安装 Skill…")}</div></div>`;
    return;
  }
  if (State.skills.error && !skills.length) {
    content.innerHTML = `<div class="view"><div class="card"><div class="empty">${esc(State.skills.error)}</div><div style="text-align:center;"><button class="btn primary" id="skills-retry">重试</button></div></div></div>`;
    $("#skills-retry").addEventListener("click", loadSkills);
    return;
  }

  const installed = skills.filter((s) => s.installed).length;
  const capabilityCount = skills.reduce((n, s) => n + (s.capabilities || []).length, 0);
  let html = `<div class="view">
    <div class="report-hero skills-hero">
      <div><h2>Skill 工具箱</h2><div class="meta">查看当前项目已安装的扩展能力；密钥、密码和 Token 永不显示。</div></div>
      <button class="btn primary" id="skills-refresh">${State.skills.loading ? "读取中…" : "刷新状态"}</button>
    </div>
    <div class="stat-grid">
      ${statCard(installed, "已安装 Skill", "g")}
      ${statCard(skills.length, "已发现 Skill", "b")}
      ${statCard(capabilityCount, "可用能力", "p")}
    </div>`;
  if (!skills.length) html += `<div class="card" style="margin-top:16px;">${emptyState("当前未发现项目级 Skill")}</div>`;
  else {
    html += `<div class="skill-grid">`;
    skills.forEach((skill) => {
      const cli = skill.cli || {};
      const caps = skill.capabilities || [];
      html += `<article class="skill-card">
        <div class="skill-head"><div class="skill-icon">${esc(skill.icon || "🧩")}</div><div class="skill-title"><div class="skill-name">${esc(skill.name || skill.id)}</div><div class="skill-version">${esc(skill.id)} · Skill ${esc(skill.version || "未知")}</div></div><span class="tag ${skill.installed ? "g" : "r"}">${skill.installed ? "已安装" : "不可用"}</span></div>
        <div class="skill-desc">${esc(skill.description || "暂无描述")}</div>
        <div class="skill-status"><span>CLI：<b class="${cli.installed ? "badge-ok" : "badge-no"}">${cli.installed ? esc(cli.version || "已安装") : "未安装"}</b></span><span>凭证：<b class="${cli.auth_configured ? "badge-ok" : "badge-no"}">${cli.auth_configured ? "已配置" : "未配置"}</b></span><span>来源：${esc(cli.source === "keychain" ? "本机凭证库" : cli.source || "无")}</span></div>
        <div class="skill-cap-title">能力清单</div><div class="skill-capabilities">${caps.length ? caps.map((cap) => `<span class="tag">${esc(cap.name || cap)}</span>`).join("") : `<span class="skill-muted">暂无可检测能力</span>`}</div>
      </article>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  content.innerHTML = '<div class="view">' + html + '</div>';
  $("#skills-refresh").addEventListener("click", loadSkills);
}

let SettingsData = { custom_api: { name: "", base_url: "", model: "", enabled: false, key_configured: false, status: "未配置" }, project_dir: "" };

/* 供应商预设表（纯前端，仅默认值参考；不含任何 API Key）
 * 来源标注：
 *   reliable = 取自 config.py / .env.example 的既有常量（可信）
 *   reference = 公开 OpenAI 兼容地址参考值，需以服务商文档为准
 * 豆包模型 config.py 默认值为空（需用户填模型名或推理接入点 ep-xxxx），故不预填模型。 */
const PROVIDER_PRESETS = [
  { key: "deepseek",  label: "DeepSeek",          base_url: "https://api.deepseek.com",                model: "deepseek-chat", source: "reliable", models: ["deepseek-chat", "deepseek-reasoner"] },
  { key: "doubao",    label: "火山方舟（豆包）",  base_url: "https://ark.cn-beijing.volces.com/api/v3", model: "",              source: "reliable", models: [] },
  { key: "zhipu",     label: "智谱 GLM",          base_url: "https://open.bigmodel.cn/api/paas/v4",    model: "",              source: "reference", models: ["glm-4", "glm-4-plus", "glm-4-flash"] },
  { key: "kimi",      label: "月之暗面 Kimi",     base_url: "https://api.moonshot.cn/v1",              model: "",              source: "reference", models: ["moonshot-v1-8k", "moonshot-v1-32k"] },
  { key: "qwen",      label: "通义千问",          base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "",    source: "reference", models: ["qwen-plus", "qwen-turbo", "qwen-max"] },
  { key: "openai",    label: "OpenAI",            base_url: "https://api.openai.com/v1",               model: "",              source: "reference", models: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"] },
];

function providerMatches(base_url, model) {
  if (!base_url) return null;
  const norm = (s) => String(s || "").trim().replace(/\/+$/, "");
  const u = norm(base_url);
  for (const p of PROVIDER_PRESETS) {
    if (norm(p.base_url) === u) {
      // 命中地址；若该预设模型非空，需模型也一致才认定命中（避免错标）
      if (p.model && norm(model) !== norm(p.model)) continue;
      return p;
    }
  }
  return null;
}

function renderProviderOptions(selectedKey) {
  let h = `<option value="">请选择</option>`;
  h += `<optgroup label="官方/可信预设">`;
  for (const p of PROVIDER_PRESETS) {
    if (p.source !== "reliable") continue;
    h += `<option value="${p.key}" ${selectedKey === p.key ? "selected" : ""}>${p.label}</option>`;
  }
  h += `</optgroup>`;
  h += `<optgroup label="参考预设（以服务商文档为准）">`;
  for (const p of PROVIDER_PRESETS) {
    if (p.source !== "reference") continue;
    h += `<option value="${p.key}" ${selectedKey === p.key ? "selected" : ""}>${p.label}</option>`;
  }
  h += `</optgroup>`;
  h += `<option value="custom" ${selectedKey === "custom" ? "selected" : ""}>自定义（手动填写）</option>`;
  return h;
}

function renderModelDatalist(providerKey) {
  if (!providerKey) return "";
  const p = PROVIDER_PRESETS.find((x) => x.key === providerKey);
  if (!p || !p.models || !p.models.length) return "";
  const opts = p.models.map((m) => `<option value="${esc(m)}"></option>`).join("");
  return `<datalist id="custom-model-list">${opts}</datalist>`;
}

function handleSettingsEvent(ev) {
  if (ev.cmd === "test_custom_api") {
    toast(ev.payload.status + (ev.payload.error ? "：" + ev.payload.error : ""), ev.payload.status.includes("成功") ? "ok" : "err");
    SettingsData.custom_api.status = ev.payload.status;
  } else if (ev.cmd === "save_settings" && ev.payload && ev.payload.reason === "web_local_only") {
    // 网页版拦截：服务端不落盘，前端已本地保存，这里只做提示
    toast("已保存到本机浏览器（不会写入服务器）", "ok");
  } else if (ev.cmd === "reset_settings" && ev.payload && ev.payload.reason === "web_local_only") {
    toast("网页版无法重置服务端配置；已清除本机记忆", "ok");
  } else if (ev.payload) {
    SettingsData = ev.payload;
    toast(ev.cmd === "reset_settings" ? "已恢复默认设置" : ev.cmd === "save_settings" ? "设置已保存" : "设置已加载", "ok");
  }
  if (State.view === "settings") renderSettingsView();
}

// 判断是否为本地/内网地址：网页版的模型调用由云端服务器发起，
// 云端与用户电脑不在同一网络，localhost / 内网地址永远连不通，
// 必须在保存时明确拦下并说明原因，不能让用户以为"再试一次就好了"。
function isLocalOrPrivateUrl(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"].includes(h)) return true;
    if (h.endsWith(".local") || h.endsWith(".internal")) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function renderSettingsView() {
  const content = $("#content");
  const serverApi = SettingsData.custom_api || {};
  // 本机配置优先：网页版服务端不保存访客配置（拦截为 web_local_only），
  // 若表单只读服务端状态，保存后重绘会把刚打开的开关画回"未启用"，
  // 表现为"启用后自动取消"。故本机有值时以本机为准，服务端实际生效值另用面板展示。
  const localFormCfg = (typeof ApiCfgStore !== "undefined" && ApiCfgStore.read()) || {};
  const hasLocal = !!(localFormCfg.base_url || localFormCfg.model || localFormCfg.name);
  const api = hasLocal ? {
    name: localFormCfg.name || "",
    base_url: localFormCfg.base_url || "",
    model: localFormCfg.model || "",
    enabled: !!localFormCfg.enabled,
    key_configured: !!localFormCfg.api_key,
    status: localFormCfg.enabled ? "已启用（本机配置，随每次请求发送）" : "已保存但未启用（本机配置）",
  } : serverApi;
  const defaultView = localStorage.getItem("defaultView") || "chat";
  content.innerHTML = `<div class="view settings-view">
    <div class="settings-head"><div><div class="eyebrow">WORKSPACE PREFERENCES</div><h1>设置</h1><p>知筑 Agent 工作台设置</p></div><button class="ghost-btn settings-close" type="button">×</button></div>
    <div class="settings-card card"><div class="card-title">外观</div><div class="settings-row"><span>外观主题</span><b>Agent 暖金主题 · 已启用</b></div></div>
    <div class="settings-card card"><div class="card-title">应用行为</div>
      <label class="settings-row"><span>演示模式</span><input id="settings-demo" type="checkbox" ${State.pipeline.demo ? "checked" : ""}></label>
      <label class="settings-row"><span>默认打开页面</span><select class="input" id="settings-default-view"><option value="chat" ${defaultView === "chat" ? "selected" : ""}>对话</option><option value="workspace" ${defaultView === "workspace" ? "selected" : ""}>项目工作台</option></select></label>
      <label class="settings-row"><span>本地缓存</span><button class="btn" id="settings-clear-cache" type="button">清空本地缓存</button></label>
      <button class="btn" id="settings-reset" type="button">恢复默认设置</button></div>
    <div class="settings-card card"><div class="card-title">系统状态</div><div class="settings-row"><span>Python bridge</span><b>${State.bridgeReady ? "已连接" : "未连接"}</b></div><div class="settings-row"><span>当前项目目录</span><b>${esc(SettingsData.project_dir || "读取中…")}</b></div></div>
    <div class="settings-card card"><div class="card-title">自定义 OpenAI 兼容 API</div>
      <label class="settings-field">供应商<select id="custom-provider" class="input">${renderProviderOptions("")}</select></label>
      <label class="settings-field">名称<input class="input" id="custom-name" value="${esc(api.name || "")}" placeholder="我的兼容接口"></label>
      <label class="settings-field">Base URL<input class="input" id="custom-url" value="${esc(api.base_url || "")}" placeholder="https://example.com/v1"></label>
      <label class="settings-field">模型<input class="input" id="custom-model" list="custom-model-list" value="${esc(api.model || "")}" placeholder="model-name"></label>
      <label class="settings-field">API Key<input class="input" id="custom-key" type="password" value="" placeholder="请输入 API Key"><span class="settings-key-note">配置保存在你的浏览器。使用自定义 API 时，配置会随单次请求发送给服务端用于本次调用，服务端不会保存，也不会用于其他用户的请求。</span></label>
      <label class="settings-row"><span>在本浏览器记住 API Key（仅存本机）</span><input class="input" id="custom-remember-key" type="checkbox"></label>
      <label class="settings-row"><span>启用自定义 API</span><input id="custom-enabled" type="checkbox" ${api.enabled ? "checked" : ""}></label>
      <div class="settings-note">状态：${esc(api.status || "未配置")}；密钥：${api.key_configured ? "已配置" : "未配置"}。保存不代表连接成功。</div>
      <div class="settings-note provider-note" style="display:none;">以下为常见参考地址与模型，请以你的服务商文档为准。</div>
      <div class="cfg-panels">
        <div class="cfg-panel cfg-local"><div class="cfg-panel-title">本机记住的配置</div><div class="cfg-panel-body" id="cfg-local-body">（尚未保存本机配置）</div></div>
        <div class="cfg-panel cfg-server"><div class="cfg-panel-title">服务端当前生效配置</div><div class="cfg-panel-body" id="cfg-server-body">${esc(api.name || api.base_url ? (api.name || api.base_url) + " · " + (api.model || "—") : "（服务端未配置自定义 API）")}</div></div>
      </div>
      <div class="settings-actions"><button class="primary-btn" id="settings-save" type="button">保存设置</button><button class="btn" id="settings-test" type="button">测试连接</button></div>
    </div><button class="primary-btn settings-back" type="button">返回工作台</button></div>`;
  $(".settings-close").addEventListener("click", () => switchView("workspace"));
  $(".settings-back").addEventListener("click", () => switchView("workspace"));
  $("#settings-demo").addEventListener("change", (e) => { State.pipeline.demo = e.target.checked; $("#demo-toggle").checked = e.target.checked; });
  $("#settings-default-view").addEventListener("change", (e) => localStorage.setItem("defaultView", e.target.value));
  const payload = () => ({ custom_api: { name: $("#custom-name").value, base_url: $("#custom-url").value, model: $("#custom-model").value, api_key: $("#custom-key").value, enabled: $("#custom-enabled").checked } });
  $("#settings-save").addEventListener("click", () => {
    // 网页版：先本地保存，再通知服务端（服务端会拦截 save_settings 返回 web_local_only）
    const wantEnable = $("#custom-enabled").checked;
    const baseUrl = $("#custom-url").value.trim();
    if (wantEnable && !baseUrl) {
      toast("已勾选「启用自定义 API」，但 Base URL 为空，未启用", "err");
      $("#custom-enabled").checked = false;
      return;
    }
    if (wantEnable && isLocalOrPrivateUrl(baseUrl)) {
      // 云端服务器访问不到用户电脑上的本地/内网地址：必须明确说明，不许"看起来能启用"
      toast("网页版无法访问本地/内网地址：模型调用由云端服务器发起，连不到你电脑上的 " + baseUrl +
            "。想用本地模型（Ollama / LM Studio 等）请使用桌面版工作台；网页版请改用公网可访问的 API。", "err");
      $("#custom-enabled").checked = false;
      return;
    }
    const rememberKey = $("#custom-remember-key").checked;
    // Key 读取：当前输入框优先；若为空且此前已「记住密钥」，则沿用上次记住的值
    // （保存后 renderSettingsView 会重渲染清空密码框，需从已存配置回填）
    let key = $("#custom-key").value;
    if (!key && rememberKey) {
      const prev = ApiCfgStore.read();
      if (prev && prev.remember_key && prev.api_key) key = prev.api_key;
    }
    ApiCfgStore.save({
      provider: $("#custom-provider").value,
      name: $("#custom-name").value,
      base_url: $("#custom-url").value,
      model: $("#custom-model").value,
      enabled: $("#custom-enabled").checked,
      remember_key: rememberKey,
      api_key: key,
    });
    renderCfgLocalPanel();
    Bridge.invoke("save_settings", payload());
  });
  $("#settings-test").addEventListener("click", () => Bridge.invoke("test_custom_api", payload()));
  $("#settings-reset").addEventListener("click", () => {
    localStorage.removeItem("defaultView");
    State.pipeline.demo = true;
    $("#demo-toggle").checked = true;
    ApiCfgStore.clear();
    renderCfgLocalPanel();
    Bridge.invoke("reset_settings", {});
  });
  $("#settings-clear-cache").addEventListener("click", () => {
    CacheStore.clear();
    ApiCfgStore.clear();
    renderCfgLocalPanel();
    toast("本地缓存已清空", "ok");
  });
  if (!SettingsData.project_dir) Bridge.invoke("get_settings", {});

  // ---- 供应商预设交互 ----
  const providerSel = $("#custom-provider");
  const urlInput = $("#custom-url");
  const modelInput = $("#custom-model");
  const modelList = $("#custom-model-list");
  const providerNote = document.querySelector(".provider-note");

  // 回填：当前保存值命中某个预设则选中它，否则显示"自定义（手动填写）"
  const savedMatch = providerMatches(api.base_url, api.model);
  if (savedMatch) {
    providerSel.value = savedMatch.key;
  } else if (api.base_url || api.model) {
    providerSel.value = "custom";
  }
  applyProvider(providerSel.value, { silent: true });

  // ---- 本机配置记忆：回填表单 + 渲染「本机/服务端」两个面板 ----
  function renderCfgLocalPanel() {
    const cfg = ApiCfgStore.read();
    const body = document.getElementById("cfg-local-body");
    if (!body) return;
    if (cfg && (cfg.name || cfg.base_url || cfg.model)) {
      const parts = [];
      if (cfg.name) parts.push("名称：" + esc(cfg.name));
      if (cfg.base_url) parts.push("地址：" + esc(cfg.base_url));
      if (cfg.model) parts.push("模型：" + esc(cfg.model));
      parts.push("启用：" + (cfg.enabled ? "是" : "否"));
      parts.push("记住密钥：" + (cfg.remember_key ? "是" : "否"));
      body.textContent = parts.join(" · ");
    } else {
      body.textContent = "（尚未保存本机配置）";
    }
  }

  // 恢复顺序（任务书 2.4）：先读 localStorage 回填，服务端 get_settings 的结果
  // 已在 SettingsData 中（renderSettingsView 顶部 api 变量），作为「服务端生效值」显示。
  const localCfg = ApiCfgStore.read();
  if (localCfg) {
    if (localCfg.name && !api.name) $("#custom-name").value = localCfg.name;
    if (localCfg.base_url && !api.base_url) $("#custom-url").value = localCfg.base_url;
    if (localCfg.model && !api.model) $("#custom-model").value = localCfg.model;
    if (localCfg.provider && providerSel && !providerSel.value) providerSel.value = localCfg.provider;
    if (localCfg.remember_key) {
      $("#custom-remember-key").checked = true;
      $("#custom-key").value = localCfg.api_key || "";
    }
  }
  renderCfgLocalPanel();

  function applyProvider(key, opts) {
    opts = opts || {};
    const p = PROVIDER_PRESETS.find((x) => x.key === key);
    // 更新模型 datalist 候选
    const dl = renderModelDatalist(key);
    if (modelList) modelList.remove();
    if (dl) modelInput.insertAdjacentHTML("afterend", dl);
    modelInput.setAttribute("list", dl ? "custom-model-list" : "");
    if (!p) {
      // "请选择" 或 "自定义"：不覆盖用户已填内容
      if (key === "custom") {
        if (!opts.silent) { urlInput.value = ""; modelInput.value = ""; }
      }
      if (providerNote) providerNote.style.display = "none";
      return;
    }
    // 覆盖 Base URL 与模型（用户手改过则先确认）
    if (!opts.silent) {
      const urlDirty = urlInput.value && urlInput.value.trim() !== p.base_url;
      const modelDirty = modelInput.value && modelInput.value.trim() !== (p.model || "");
      if ((urlDirty || modelDirty) && !confirm("切换供应商将按预设覆盖 Base URL 与模型，是否继续？（API Key 不受影响）")) {
        providerSel.value = savedMatch ? savedMatch.key : (api.base_url || api.model ? "custom" : "");
        return;
      }
    }
    urlInput.value = p.base_url;
    modelInput.value = p.model || "";
    if (providerNote) {
      providerNote.style.display = p.source === "reference" ? "" : "none";
    }
  }

  providerSel.addEventListener("change", (e) => applyProvider(e.target.value));
}

/* ================= 路由 ================= */
function switchView(viewId) {
  State.view = viewId;
  const v = VIEWS.find((x) => x.id === viewId);
  $$("#iconnav .icon-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === viewId));
  $("#crumb-view").textContent = v ? v.crumb : "";
  renderSidebar(viewId);
  renderCurrentView();
}

function renderCurrentView() {
  const map = {
      chat: renderChatView,
      workspace: renderWorkspaceView,
      data: renderDataView,
      agents: renderAgentsView,
      canvas: renderCanvasView,
      engineering: renderEngineeringView,
      inspection: renderInspectionView,
      drafting: renderDraftingView,
      disease: renderDiseaseView,
      files: renderFilesView,
      report: renderReportView,
      skills: renderSkillsView,
      settings: renderSettingsView,
    };
  const fn = map[State.view];
  if (fn) fn();
}

/* ================= 导出 ================= */
window.Views = {
  renderCurrentView,
  handleSettingsEvent,
  refresh(viewId) { if (State.view === viewId) renderCurrentView(); },
  tick() {},
};
window.pushAssistantChat = pushAssistantChat;
window.switchView = switchView;
