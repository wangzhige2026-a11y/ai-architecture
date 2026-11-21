/* ============================================================
   api.js —— 全局状态、桥接封装、工具函数
   ============================================================ */
"use strict";

/* ---------------- 全局状态 ---------------- */
const CHAT_THINKING_PHASES = ["请求已发送", "正在连接 AI 服务", "AI 正在分析问题", "正在生成回答"];
let ChatRenderTimer = null;
let BridgeReadyTimer = null;

const State = {
  view: "chat",
  bridgeReady: false,
  sysInfo: null,
  pipeline: {
    running: false,
    steps: [],
    // 真实步骤计时：记录后端步骤事件在前端「到达」的时刻。
    // 只统计本次会话实际观测到的 run→done 区间，页面刷新后未观测到的步骤
    // 不参与平均（宁可显示 —，也不编造耗时）。不写入 localStorage。
    stepTimes: {},
    report: null,
    scored: [],
    subject: "方特",
    keywords: ["方特", "体验", "排队", "主题乐园", "设计"],
    demo: true,
    logs: [],
  },
  chat: {
    sessions: [],
    activeId: null,
  },
  agents: [
    { id: "planner", ic: "🧭", name: "需求拆解 Agent", role: "问题理解", color: "var(--accent-soft)", desc: "解析客户问答，提取主体、区域与搜索关键词。" },
    { id: "collector", ic: "📡", name: "华为采集 Agent", role: "公众认知", color: "var(--green-soft)", desc: "按关键词检索公众讨论，抓取真实用户视角。" },
    { id: "analyst", ic: "📊", name: "数据分析 Agent", role: "认知建模", color: "var(--purple-soft)", desc: "五维建筑相关性评分，识别高频痛点与问题类型。" },
    { id: "ai", ic: "🤖", name: "AI 建筑师", role: "设计策略", color: "var(--amber-soft)", desc: "将公众体验问题转化为可落地的建筑优化策略。" },
    { id: "engineer", ic: "🧮", name: "工程验证 Agent", role: "逻辑校验", color: "var(--red-soft)", desc: "对结构方案做荷载/强度/变形/稳定性四维概念验算。" },
    { id: "renderer", ic: "🎨", name: "可视化 Agent", role: "成果呈现", color: "var(--accent-soft)", desc: "聚合输出设计报告、图纸与演示成果。" },
  ],
  engineering: { last: null, form: { scheme_type: "cantilever", span_m: 2.0, width_m: 1.0, dead_load_kpa: 2.0, live_load_kpa: 4.0, material: "Q235", b_m: 1.0, h_m: 0.2, anchor_m: 1.2 } },
  disease: { last: null, busy: false, fileName: "", pickedFile: null, mmPerPx: "", engine: "cracknet", error: "" },
  files: [],
  skills: { loading: false, loaded: false, items: [], error: "" },
};

/* 8 步工作流定义 */
const FLOW_STEPS = [
  { n: 1, name: "AI 问题拆解", ic: "🧭", desc: "理解客户问答" },
  { n: 2, name: "关键词生成", ic: "🔑", desc: "搜索词扩展" },
  { n: 3, name: "华为采集", ic: "📡", desc: "公众认知数据" },
  { n: 4, name: "数据清洗", ic: "🧹", desc: "去噪去重" },
  { n: 5, name: "建筑评分", ic: "📊", desc: "五维相关性" },
  { n: 6, name: "AI 文本分析", ic: "🤖", desc: "体验→建筑问题" },
  { n: 7, name: "设计方向", ic: "🏗️", desc: "策略生成" },
  { n: 8, name: "结果输出", ic: "📦", desc: "报告与图纸" },
];

/* ---------------- 视图定义 ---------------- */
const VIEWS = [
  { id: "chat", ic: "💬", name: "AI 对话", crumb: "对话工作台" },
  { id: "workspace", ic: "🏠", name: "项目", crumb: "项目工作台" },
  { id: "data", ic: "📊", name: "数据分析", crumb: "华为数据分析" },
  { id: "agents", ic: "🤖", name: "Agent", crumb: "Agent 工作流" },
  { id: "canvas", ic: "🎨", name: "画布", crumb: "设计画布" },
  { id: "engineering", ic: "🧮", name: "工程", crumb: "工程知识验证" },
  { id: "disease", ic: "🔍", name: "病害", crumb: "结构病害检测" },
  { id: "files", ic: "📁", name: "文件", crumb: "文件管理" },
  { id: "report", ic: "🏆", name: "成果", crumb: "设计成果展示" },
  { id: "skills", ic: "🧰", name: "工具箱", crumb: "Skill 工具箱" },
  { id: "settings", ic: "⚙", name: "设置", crumb: "设置" },
];

/* ============================================================
   本地缓存层（localStorage）—— 让刷新后不丢数据
   只存非敏感数据：对话消息、分析结果、视图偏好。
   硬性约束：
     - 绝不写入 API Key / token / 任何密钥；
     - 体积有上限（对话最多 50 条，report 按需精简）；
     - 所有读写包 try/catch，失败静默降级，不影响主流程。
   ============================================================ */
const CacheStore = {
  KEY: "zhizhu_cache_v1",
  MAX_MESSAGES: 50,

  // 安全读写，永不抛错
  read() {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  write(data) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;   // 配额满 / 隐私模式：静默降级
    }
  },

  clear() {
    try { localStorage.removeItem(this.KEY); } catch (e) { /* noop */ }
  },

  // 精简对话消息：只保留 role + content，去掉流式中间态字段，控制体积；
  // 过滤空会话（messages.length===0），避免刷新后堆积空白会话（缺陷②）。
  _slimSessions(sessions) {
    const arr = Array.isArray(sessions) ? sessions : [];
    const slim = arr.slice(0, this.MAX_MESSAGES).map((s) => {
      if (!s) return null;
      return {
        id: s.id,
        title: s.title,
        sub: s.sub,
        ts: s.ts,
        messages: (Array.isArray(s.messages) ? s.messages : [])
          .filter((m) => m && !m.thinking && !m.streaming)   // 只存已完成消息
          .map((m) => ({ role: m.role, content: m.content }))
          .slice(-this.MAX_MESSAGES),
      };
    }).filter((s) => s && s.messages && s.messages.length > 0);  // 空会话不持久化
    return slim;
  },

  // 保存当前 State 中需要持久化的部分
  save() {
    // 空会话不写入缓存；若 activeId 指向空会话，落到第一个有消息的会话或置空
    let activeId = State.chat.activeId;
    const nonEmpty = (Array.isArray(State.chat.sessions) ? State.chat.sessions : [])
      .filter((s) => s && s.messages && s.messages.length > 0);
    if (activeId && !nonEmpty.some((s) => s.id === activeId)) {
      activeId = nonEmpty.length ? nonEmpty[0].id : null;
    }
    const data = {
      v: 1,
      ts: Date.now(),
      sessions: this._slimSessions(State.chat.sessions),
      activeId: activeId,
      report: State.pipeline.report || null,
      scored: State.pipeline.scored || [],
      subject: State.pipeline.subject || "",
      keywords: State.pipeline.keywords || [],
    };
    this.write(data);
  },

  // 恢复：把缓存内容写回 State（不覆盖已由服务端填充的更新数据）
  restore() {
    const c = this.read();
    if (!c) return false;
    try {
      if (Array.isArray(c.sessions) && c.sessions.length) {
        // 恢复会话；过滤掉历史遗留的无消息会话（缺陷②兜底）
        const sessions = c.sessions.filter((s) => s && s.messages && s.messages.length > 0);
        State.chat.sessions = sessions;
        // activeId 指向被清理的会话时，落到第一个仍存在的会话，否则置空
        const activeId = c.activeId;
        State.chat.activeId = (activeId && sessions.some((s) => s.id === activeId))
          ? activeId
          : (sessions.length ? sessions[0].id : null);
      }
      if (c.report) State.pipeline.report = c.report;
      if (Array.isArray(c.scored) && c.scored.length) {
        State.pipeline.scored = normalizeScored(c.scored);
      }
      if (c.subject) State.pipeline.subject = c.subject;
      if (Array.isArray(c.keywords) && c.keywords.length) {
        State.pipeline.keywords = c.keywords;
      }
      return true;
    } catch (e) {
      return false;
    }
  },
};

// 节流保存：状态高频变化时避免频繁写 localStorage
let _cacheSaveTimer = null;
function scheduleCacheSave() {
  if (_cacheSaveTimer) return;
  _cacheSaveTimer = setTimeout(() => {
    _cacheSaveTimer = null;
    CacheStore.save();
  }, 800);
}

/* ============================================================
   本机 API 配置记忆（localStorage）—— 独立于 CacheStore
   网页版配置只存浏览器，绝不写服务端 .env。
   仅当用户显式勾选「记住 API Key」时才存 api_key。
   ============================================================ */
const ApiCfgStore = {
  KEY: "zhizhu_api_cfg_v1",

  read() {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  write(cfg) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(cfg));
      return true;
    } catch (e) {
      return false;
    }
  },

  clear() {
    try { localStorage.removeItem(this.KEY); } catch (e) { /* noop */ }
  },

  // 保存：remember_key 为 false 时绝不落 api_key
  save(data) {
    const cfg = {
      provider: data.provider || "",
      name: data.name || "",
      base_url: data.base_url || "",
      model: data.model || "",
      enabled: !!data.enabled,
      remember_key: !!data.remember_key,
      api_key: data.remember_key ? (data.api_key || "") : "",
    };
    this.write(cfg);
    // 同时写入内存持有：未勾「记住密钥」时，本次会话内仍可用（刷新后需重填）
    _memApiCfg = {
      provider: cfg.provider, name: cfg.name, base_url: cfg.base_url,
      model: cfg.model, enabled: cfg.enabled, remember_key: cfg.remember_key,
      api_key: data.api_key || "",   // 内存里保留真实 key（不落盘）
    };
  },
};

// 内存级 API 配置（不落 localStorage）：刷新即失，仅本次会话有效
let _memApiCfg = null;

/* ---------------- 桥接 ---------------- */
// 需要随请求携带 AI 配置的指令（这些指令会调用大模型）
const AI_OVERRIDE_CMDS = ["chat", "intake", "run_pipeline", "test_custom_api"];

// 计算本次请求的 ai_override（请求级配置，用完即弃，不落盘）
// 优先读内存（本次会话已保存的配置，含未落盘的 key），回退 localStorage。
// 仅当用户已启用自定义 API 且 base_url/model/api_key 齐全时才返回；
// 否则返回 null（走服务端环境变量配置）。
function buildAiOverride() {
  try {
    const cfg = _memApiCfg || ApiCfgStore.read();
    if (!cfg || !cfg.enabled) return null;
    const base_url = (cfg.base_url || "").trim();
    const model = (cfg.model || "").trim();
    const api_key = (cfg.api_key || "").trim();
    if (!base_url || !model || !api_key) return null;
    return {
      base_url: base_url,
      model: model,
      api_key: api_key,
      name: cfg.name || "custom",
    };
  } catch (e) {
    return null;
  }
}

const Bridge = {
  invoke(cmd, payload) {
    payload = payload || {};
    // 集中注入 ai_override：需要 AI 的指令携带请求级配置
    if (AI_OVERRIDE_CMDS.indexOf(cmd) >= 0) {
      const ov = buildAiOverride();
      if (ov) {
        // 深拷贝，避免污染原 payload；通过 payload.ai_override 透传给桥接层
        payload = Object.assign({}, payload);
        payload.ai_override = ov;
      }
    }
    return window.workspace.invoke(cmd, payload);
  },
  onEvent(cb) {
    window.workspace.onEvent(cb);
  },
  readReport() {
    return window.workspace.readReportFile();
  },
  listFiles() {
    return window.workspace.listOutputFiles();
  },
  openPath(p) {
    return window.workspace.openPath(p);
  },
  openExternal(url) {
    return window.workspace.openExternal(url);
  },
};

/* ---------------- DOM 工具 ---------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtSize(n) {
  if (n == null) return "-";
  if (n > 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n > 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
function fmtTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toast(msg, type) {
  const root = $("#toast-root");
  const t = el("div", "toast" + (type === "err" ? " err" : type === "ok" ? " ok" : ""));
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 3200);
  setTimeout(() => t.remove(), 3600);
}

/* ---------------- 轻量 Markdown ---------------- */
// 【数学符号兜底】模型偶尔仍会输出 LaTeX（\frac{qL^2}{8} 这类），
// 直接当普通文字显示就是一串看不懂的字符。这里做纯文本化转换，
// 不引入任何外部库（KaTeX/MathJax 体积大且需要额外资源）。
function mathClean(s) {
  if (!s) return s;
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, "$1").replace(/\$([^$\n]+)\$/g, "$1");
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
  const map = {
    "\\times": "×", "\\div": "÷", "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥",
    "\\approx": "≈", "\\neq": "≠", "\\pm": "±", "\\cdot": "·", "\\sum": "Σ", "\\Delta": "Δ",
    "\\delta": "δ", "\\sigma": "σ", "\\alpha": "α", "\\beta": "β", "\\pi": "π",
    "\\lambda": "λ", "\\mu": "μ", "\\rightarrow": "→", "\\to": "→", "\\infty": "∞",
  };
  Object.keys(map).forEach((k) => { s = s.split(k).join(map[k]); });
  const sup = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
  s = s.replace(/\^\{(\d+)\}/g, (m0, d) => String(d).split("").map((c) => sup[c] || c).join(""));
  s = s.replace(/\^(\d)\b/g, (m0, d) => sup[d] || m0);
  s = s.replace(/_\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");
  return s;
}

function mdRender(src) {
  if (!src) return "";
  let s = esc(mathClean(src));
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    return `<pre><code>${code.replace(/\n$/, "")}</code></pre>`;
  });
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  s = s.replace(/^- (.*)$/gm, "<li>$1</li>");
  s = s.replace(/(<li>[\s\S]*?<\/li>)(?!<\/?li>)/g, (m) => "<ul>" + m + "</ul>");
  s = s.replace(/^(\d+)\. (.*)$/gm, "<li>$2</li>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  s = s.replace(/^>(.*)$/gm, "<blockquote>$1</blockquote>");
  s = s.split(/\n{2,}/).map((p) => {
    if (/^\s*<(ul|ol|pre|h[123]|blockquote)/.test(p)) return p;
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  return s;
}

/* ---------------- 事件分发 ---------------- */
function handlePyEvent(ev) {
  switch (ev.type) {
    case "log":
      State.pipeline.logs.push(ev);
      if (State.pipeline.logs.length > 400) State.pipeline.logs.shift();
      if (ev.level === "start") { setBridgeBusy(true); }
      if (ev.level === "warn" || ev.level === "error") toast(ev.message, "err");
      break;
    case "step":
      upsertStep(ev);
      if (ev.status === "fail") {
        toast(ev.message || ("步骤" + ev.step + "失败"), "err");
        setBridgeBusy(false);
      }
      break;
    case "chat_phase":
      updateChatProgress(ev.phase, ev.step, ev.total, ev.session_id, ev.request_id);
      break;
    case "chat_delta":
      appendChatDelta(ev.content || "", ev.session_id, ev.request_id);
      break;
    case "items":
      if (Array.isArray(ev.items)) State.pipeline.scored = normalizeScored(ev.items);
      break;
    case "report":
      State.pipeline.report = ev.report;
      State.pipeline.scored = normalizeScored(ev.report && ev.report.admitted_items);
      break;
    case "done":
      setBridgeBusy(false);
      refreshFiles();
      if (ev.code === 0) {
        toast("分析流程完成", "ok");
      } else {
        toast("分析流程未完成（退出码 " + (ev.code == null ? "?" : ev.code) + "）", "err");
      }
      if (window.Views && typeof Views.refresh === "function") Views.refresh("data");
      break;
    case "files_refreshed":
      refreshFiles();
      break;
    case "error":
      stopChatThinking();
      if (ev.cmd === "detect_disease") {
        State.disease.busy = false;
        State.disease.error = ev.message || "裂缝检测未完成，请重试";
        if (window.Views && typeof Views.refresh === "function") Views.refresh("disease");
      }
      if (ev.cmd === "chat") {
        failPendingChat(ev.message || "AI 对话失败", ev.session_id, ev.request_id);
      }
      setBridgeBusy(false);
      toast(ev.message || "后端错误", "err");
      break;
    case "system":
      if (ev.level === "warn") toast(ev.message, "err");
      break;
    case "result":
      if (ev.cmd === "check_scheme") {
        State.engineering.last = ev.payload;
        if (window.Views && typeof Views.refresh === "function") Views.refresh("engineering");
      }
      if (ev.cmd === "detect_disease") {
        State.disease.last = ev.payload || null;
        State.disease.busy = false;
        State.disease.error = "";
        if (window.Views && typeof Views.refresh === "function") Views.refresh("disease");
      }
      if (ev.cmd === "chat") {
        stopChatThinking();
        flushChatRender();
        const content = ev.payload.content || "";
        const sess = chatSession(ev.session_id);
        const message = pendingChatMessage(ev.session_id, ev.request_id);
        if (message) {
          message.content = content;
          delete message.thinking;
          delete message.streaming;
          delete message.thinkingPhase;
          delete message.thinkingTotal;
        } else if (sess) {
          sess.messages.push({ role: "assistant", content, requestId: ev.request_id || "" });
        }
        refreshChatSession(ev.session_id);
      }
      if (ev.cmd === "intake") {
        applyIntake(ev.payload);
      }
      if (ev.cmd === "system_info") {
        if (BridgeReadyTimer) {
          clearTimeout(BridgeReadyTimer);
          BridgeReadyTimer = null;
        }
        State.sysInfo = ev.payload || null;
        State.bridgeReady = true;
        setBridgeBusy(false);
      }
      if (ev.cmd === "list_skills") {
        State.skills.items = ev.payload && Array.isArray(ev.payload.skills) ? ev.payload.skills : [];
        State.skills.loading = false;
        State.skills.loaded = true;
        State.skills.error = "";
        if (window.Views && typeof Views.refresh === "function") Views.refresh("skills");
        if (State.view === "skills") renderSidebar("skills");
      }
      if (["get_settings", "save_settings", "test_custom_api", "reset_settings"].includes(ev.cmd)) {
        if (window.Views && typeof Views.handleSettingsEvent === "function") Views.handleSettingsEvent(ev);
      }
      break;
  }
  // 状态可能已变化（报告/消息/评分），触发节流持久化
  scheduleCacheSave();
  if (window.Views && typeof Views.tick === "function") Views.tick();
}

function upsertStep(ev) {
  const list = State.pipeline.steps;
  const i = list.findIndex((s) => s.step === ev.step);
  const item = { step: ev.step, name: ev.name, status: ev.status, message: ev.message, data: ev.data };
  if (i >= 0) list[i] = item;
  else list.push(item);
  list.sort((a, b) => a.step - b.step);
  recordStepTiming(ev.step, ev.status);
}

/* 真实耗时记录：run 事件到达时记开始，done/fail 到达时记结束。
   数据来源只有前端事件时间戳，不引入任何估算值。 */
function recordStepTiming(step, status) {
  if (!State.pipeline.stepTimes) State.pipeline.stepTimes = {};
  const t = State.pipeline.stepTimes[step]
    || (State.pipeline.stepTimes[step] = { startedAt: null, endedAt: null, ms: null });
  const now = Date.now();
  if (status === "run" && t.startedAt == null) t.startedAt = now;
  if ((status === "done" || status === "fail") && t.endedAt == null) {
    t.endedAt = now;
    if (t.startedAt != null) t.ms = t.endedAt - t.startedAt;
  }
}

/* 归一化评分条目：兼容后端报告字段 */
function normalizeScored(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    ...it,
    score: it.total_score != null ? it.total_score : it.score,
    admitted: !!it.admitted,
    problem_types: Array.isArray(it.problem_types)
      ? it.problem_types.map((p) => (typeof p === "string" ? p : (p && p.problem_type) || "")).filter(Boolean)
      : [],
    design_directions: Array.isArray(it.design_directions) ? it.design_directions : [],
    ai_analysis: it.ai_analysis || {},
  }));
}

/* 初始占位，后续阶段完全由 Python 后端的真实执行节点驱动。 */
function pushThinking(sessionId, requestId) {
  const sess = chatSession(sessionId);
  if (!sess) return;
  sess.messages.push({
    role: "assistant",
    content: CHAT_THINKING_PHASES[0],
    requestId,
    thinking: true,
    thinkingPhase: 0,
    thinkingTotal: 3,
  });
  refreshChatSession(sessionId);
}

function stopChatThinking() { /* 阶段由后端事件驱动，无本地模拟定时器。 */ }

function scheduleChatRender() {
  if (State.view !== "chat" || ChatRenderTimer) return;
  ChatRenderTimer = setTimeout(() => {
    ChatRenderTimer = null;
    renderChatView();
  }, 45);
}

function flushChatRender() {
  if (ChatRenderTimer) {
    clearTimeout(ChatRenderTimer);
    ChatRenderTimer = null;
  }
}

function chatSession(sessionId) {
  const id = sessionId || State.chat.activeId;
  return State.chat.sessions.find((s) => s.id === id) || null;
}

function refreshChatSession(sessionId) {
  if (State.chat.activeId === (sessionId || State.chat.activeId) && State.view === "chat") {
    renderChatView();
  }
  renderSidebar("chat");
}

function pendingChatMessage(sessionId, requestId) {
  const sess = chatSession(sessionId);
  if (!sess) return null;
  return sess.messages.slice().reverse().find((message) => {
    if (!message || (!message.thinking && !message.streaming)) return false;
    return requestId ? message.requestId === requestId : true;
  }) || null;
}

function updateChatProgress(phase, step, total, sessionId, requestId) {
  const message = pendingChatMessage(sessionId, requestId);
  if (!message) return;
  message.thinking = true;
  message.content = phase || CHAT_THINKING_PHASES[Math.min(Number(step) || 0, CHAT_THINKING_PHASES.length - 1)];
  message.thinkingPhase = Number(step) || 0;
  message.thinkingTotal = Number(total) || 3;
  refreshChatSession(sessionId);
}

function appendChatDelta(delta, sessionId, requestId) {
  if (!delta) return;
  const message = pendingChatMessage(sessionId, requestId);
  if (!message) return;
  if (!message.streaming) message.content = "";
  message.streaming = true;
  message.thinking = false;
  message.content += delta;
  if (State.chat.activeId === sessionId) scheduleChatRender();
}

function failPendingChat(errorMessage, sessionId, requestId) {
  flushChatRender();
  const message = pendingChatMessage(sessionId, requestId);
  if (!message) return;
  message.content = `回答失败：${errorMessage}`;
  delete message.thinking;
  delete message.streaming;
  delete message.thinkingPhase;
  delete message.thinkingTotal;
  refreshChatSession(sessionId);
}

/* 只显示高层阶段，不呈现模型的隐藏推理链。 */
function renderThinking(message) {
  const phase = message && message.content ? message.content : CHAT_THINKING_PHASES[0];
  const step = message && message.thinkingPhase ? message.thinkingPhase : 0;
  const total = message && message.thinkingTotal ? message.thinkingTotal : 3;
  return `<div class="thinking-progress"><span class="thinking-step">${step ? `${step}/${total}` : "准备"}</span><span class="thinking-dots"><span class="thinking-text">${esc(phase)}</span><i>.</i><i>.</i><i>.</i></span></div>`;
}

function setBridgeBusy(busy) {
  State.pipeline.running = busy;
  const btn = $("#run-btn");
  if (btn) {
    btn.disabled = busy;
    btn.classList.toggle("busy", busy);
    $("#run-btn-text").textContent = busy ? "分析中…" : "运行分析";
  }
  const dot = $("#bridge-dot");
  if (dot) {
    dot.className = "dot" + (busy ? " busy" : State.bridgeReady ? " on" : " off");
    $("#bridge-text").textContent = busy ? "正在分析…" : State.bridgeReady ? "Python 后端就绪" : "后端连接中…";
  }
  updateAgentStatus();
}

/* 顶部 Agent 状态胶囊：真实反映后端就绪 / 运行中 / 未连接 */
function updateAgentStatus() {
  const wrap = $("#agent-status");
  const text = $("#agent-status-text");
  if (!wrap || !text) return;
  if (State.pipeline.running) {
    wrap.className = "agent-status busy";
    text.textContent = "AI Agent 分析中";
  } else if (State.bridgeReady) {
    wrap.className = "agent-status on";
    text.textContent = "AI Agent 就绪";
  } else {
    wrap.className = "agent-status off";
    text.textContent = "AI Agent 未连接";
  }
}

async function loadSkills() {
  State.skills.loading = true;
  State.skills.error = "";
  if (window.Views && typeof Views.refresh === "function") Views.refresh("skills");
  try {
    const res = await Bridge.invoke("list_skills", {});
    if (!res || !res.ok) throw new Error("无法请求 Skill 状态");
  } catch (e) {
    State.skills.loading = false;
    State.skills.loaded = true;
    State.skills.error = e.message || String(e);
    if (window.Views && typeof Views.refresh === "function") Views.refresh("skills");
  }
}

async function refreshFiles() {
  try {
    State.files = (await Bridge.listFiles()) || [];
    if (window.Views && typeof Views.refresh === "function") Views.refresh("files");
  } catch (e) { /* noop */ }
}

/* 工程验算表单提交 */
async function runCheckScheme(form) {
  const scheme = {
    scheme_type: form.scheme_type,
    span_m: Number(form.span_m),
    width_m: Number(form.width_m),
    dead_load_kpa: Number(form.dead_load_kpa),
    live_load_kpa: Number(form.live_load_kpa),
    material: form.material,
    section: { b_m: Number(form.b_m), h_m: Number(form.h_m) },
    anchor_m: Number(form.anchor_m),
  };
  await Bridge.invoke("check_scheme", { scheme });
}

/* 运行分析 */
async function runPipeline(subject, keywords, demo) {
  State.pipeline.steps = [];
  State.pipeline.stepTimes = {};
  State.pipeline.report = null;
  State.pipeline.scored = [];
  setBridgeBusy(true);
  const res = await Bridge.invoke("run_pipeline", {
    subject, keywords, demo: !!demo,
  });
  if (!res || !res.ok) {
    setBridgeBusy(false);
    toast("无法启动分析流程", "err");
  }
}

/* AI 对话（DeepSeek） */
async function chatWithAI(messages, sessionId, requestId) {
  try {
    const result = await Bridge.invoke("chat", {
      messages,
      session_id: sessionId,
      request_id: requestId,
    });
    if (!result || !result.ok) throw new Error("Python 后端未连接");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    failPendingChat(message, sessionId, requestId);
    toast("AI 对话请求发送失败：" + message, "err");
  }
}

/* 需求拆解 */
async function intakeQuestion(q) {
  await Bridge.invoke("intake", { question: q });
}

function applyIntake(payload) {
  if (!payload) return;
  const subj = payload.subject || payload["主体"] || "";
  const kws = Array.isArray(payload.keywords)
    ? payload.keywords
    : (payload["关键词"] || []);
  if (subj) State.pipeline.subject = subj;
  if (kws.length) State.pipeline.keywords = kws;
  toast("需求已拆解，已写入分析参数", "ok");
  if (window.Views && typeof Views.refresh === "function") Views.refresh("data");
}
