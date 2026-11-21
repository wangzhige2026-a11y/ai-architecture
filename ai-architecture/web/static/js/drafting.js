/* ============================================================
   drafting.js —— 制图视图（参数化生成 CAD 图纸 + 完成度记分卡）
   ------------------------------------------------------------
   接在「项目」视图的方案之后：方案 → 制图 → DXF/IFC + 记分卡。

   核心判断（写在最前面，因为它是整个能力的判定标准）：
     画到 80% 就是可交。但 80% 是十一项加权分，不是"看着差不多"。
     轴网对、墙有厚度、门窗有构件、尺寸能读、文字可读、单位是毫米 = 成功。

   硬边界（界面上要主动讲，别等用户踩坑）：
     ✗ AI 写不出 .rvt —— Revit 私有二进制
     ✓ 能交的是 .dxf 和 .ifc（Revit 可打开 .ifc 再另存 .rvt）
   ============================================================ */
"use strict";

State.drafting = {
  busy: false,
  standards: null,
  result: null,
  error: "",
  sheet: "A3",
  scale: 100,
  projectName: "",
  checkPath: "",
  checkResult: null,
  checkError: "",
  pending: {},
  tab: "card",          // card | uncertain | files
};

/* 在「病害」之前插一个视图，和 inspection.js 的插法一致 */
VIEWS.splice(VIEWS.findIndex(function (v) { return v.id === "disease"; }), 0,
  { id: "drafting", ic: "📐", name: "制图", crumb: "方案转施工图" });

const DRAFTING_CMDS = ["drafting_standards", "drafting_from_scheme", "drafting_check_dxf"];

function draftingRefresh() {
  if (State.view === "drafting") renderDraftingView();
}

function draftingRequest(command, data) {
  const d = State.drafting;
  const requestId = "drafting_" + Date.now() + "_" + Math.random().toString(16).slice(2);
  const payload = Object.assign({}, data, { request_id: requestId });
  d.pending[requestId] = command;
  d.busy = true;
  d.error = "";
  draftingRefresh();

  const fail = function (message) {
    if (!d.pending[requestId]) return;
    delete d.pending[requestId];
    d.busy = false;
    if (command === "drafting_check_dxf") d.checkError = message || "检查未完成";
    else d.error = message || "制图未完成";
    draftingRefresh();
  };

  try {
    Promise.resolve(Bridge.invoke(command, payload)).then(function (reply) {
      if (reply && reply.ok === false && d.pending[requestId]) {
        fail(reply.error || reply.message || "请求未能发出");
      }
    }).catch(function (err) {
      fail(err && err.message ? err.message : "连接未完成，请重试");
    });
  } catch (err) {
    fail(err && err.message ? err.message : "连接未完成，请重试");
  }
}

function handleDraftingEvent(ev) {
  const d = State.drafting;
  if (!ev || DRAFTING_CMDS.indexOf(ev.cmd) < 0) return;
  if (!d.pending[ev.request_id] || d.pending[ev.request_id] !== ev.cmd) return;
  delete d.pending[ev.request_id];
  d.busy = false;

  if (ev.type === "error") {
    if (ev.cmd === "drafting_check_dxf") d.checkError = ev.message || "检查未完成";
    else d.error = ev.message || "制图未完成";
    draftingRefresh();
    return;
  }
  const p = ev.payload || {};
  if (ev.cmd === "drafting_standards") {
    d.standards = p;
  } else if (ev.cmd === "drafting_from_scheme") {
    d.result = p;
    d.tab = "card";
    if (p.dxf) d.checkPath = p.dxf;
  } else if (ev.cmd === "drafting_check_dxf") {
    d.checkResult = p;
  }
  draftingRefresh();
}

/* -------------------------------------------------- 取当前方案 */
/* 「项目」视图里生成的方案存在 State.case 里；取推荐方案优先 */
function draftingCurrentScheme() {
  const c = (State && State.case) || null;
  if (!c) return null;
  const schemes = Array.isArray(c.schemes) ? c.schemes : [];
  if (!schemes.length) return null;
  const rec = c.recommendation && c.recommendation.scheme_id;
  const pick = schemes.filter(function (s) { return s.scheme_id === rec; })[0] || schemes[0];
  return pick || null;
}

/* -------------------------------------------------- 渲染 */
function renderDraftingView() {
  /* ★ 知筑的视图统一渲染到 #content，不是各自的 #view-xxx 容器。
     写错容器 = 视图点进去一片空白（实测踩过）。 */
  const host = $("#content");
  if (!host) return;
  const d = State.drafting;
  const scheme = draftingCurrentScheme();

  let html = "";
  html += '<div class="section dz-wrap">';
  html += '<h3><span class="bar"></span>制图 · 方案转施工图</h3>';

  /* 顶部：说明 + 硬边界 */
  html += '<div class="dz-head">';
  html += '<div><p class="dz-sub">把方案参数变成 <b>DXF</b> 和 <b>IFC</b>，同时给出十一项完成度记分卡和存疑清单。</p></div>';
  html += '<div class="dz-badge">成功线 80%</div>';
  html += '</div>';

  html += '<div class="dz-note">';
  html += '<b>能做什么：</b>.dxf（AutoCAD 直接开）、.ifc（Revit 能开，再另存 .rvt）、柱网/墙体/门窗/尺寸/图框。<br>';
  html += '<b>不能做什么：</b>AI 写不出 <code>.rvt</code>（Revit 私有二进制，不是文本）。任何声称能直接生成模型文件的说法都是假的。';
  html += '</div>';

  /* 来源方案 */
  html += '<div class="dz-card">';
  html += '<div class="dz-card-h">① 数据来源</div>';
  if (scheme) {
    const sp = scheme.structure_params || {};
    const cp = scheme.compliance_params || {};
    html += '<div class="dz-kv">';
    html += '<span>方案</span><b>' + esc(scheme.scheme_id || "-") + ' · ' + esc(scheme.name || "未命名") + '</b>';
    html += '<span>结构跨度</span><b>' + (sp.span_m != null ? esc(sp.span_m) + ' m' : '未给出') + '</b>';
    html += '<span>建筑面积</span><b>' + (cp.floor_area_m2 != null ? esc(cp.floor_area_m2) + ' m²' : '未给出') + '</b>';
    html += '</div>';
  } else {
    html += '<div class="dz-empty">还没有方案。先到「项目」视图点运行分析生成 A/B/C 三个方案，再回来制图。</div>';
  }
  html += '</div>';

  /* 参数 */
  html += '<div class="dz-card">';
  html += '<div class="dz-card-h">② 出图参数</div>';
  html += '<div class="dz-form">';
  html += '<label>图幅 <select id="dz-sheet">' +
    ["A3", "A2", "A1", "A4"].map(function (s) {
      return '<option value="' + s + '"' + (d.sheet === s ? " selected" : "") + '>' + s + '</option>';
    }).join("") + '</select></label>';
  html += '<label>比例 1: <select id="dz-scale">' +
    [50, 100, 150, 200].map(function (s) {
      return '<option value="' + s + '"' + (d.scale === s ? " selected" : "") + '>' + s + '</option>';
    }).join("") + '</select></label>';
  html += '<label>项目名 <input id="dz-name" type="text" placeholder="选填，会写进标题栏" value="' + esc(d.projectName) + '"></label>';
  html += '</div>';
  html += '<div class="dz-actions">';
  html += '<button id="dz-run" class="dz-btn dz-btn-main"' + (d.busy || !scheme ? " disabled" : "") + '>' +
    (d.busy ? "生成中…" : "生成图纸") + '</button>';
  html += '<button id="dz-std" class="dz-btn">看制图标准</button>';
  html += '</div>';
  if (d.error) html += '<div class="dz-err">' + esc(d.error) + '</div>';
  html += '</div>';

  /* 结果 */
  if (d.result) {
    const r = d.result;
    const card = r.card || {};
    const rows = card.rows || [];
    const unc = r.uncertainties || [];

    html += '<div class="dz-card">';
    html += '<div class="dz-card-h">③ 完成度记分卡</div>';

    /* 分数条 */
    const pct = Number(card.score || 0);
    const cls = pct >= 80 ? "ok" : (pct >= 60 ? "mid" : "bad");
    html += '<div class="dz-score">';
    html += '<div class="dz-score-num ' + cls + '">' + pct + '<small>%</small></div>';
    html += '<div class="dz-score-side">';
    html += '<div class="dz-verdict ' + cls + '">' + esc(card.verdict || "") + '</div>';
    html += '<div class="dz-bar"><i class="' + cls + '" style="width:' + Math.min(pct, 100) + '%"></i></div>';
    html += '<div class="dz-hint">成功线 ' + esc(card.success_line) + '%　·　共 ' + rows.length + ' 项</div>';
    html += '</div></div>';

    /* 逐项 */
    html += '<table class="dz-table"><thead><tr><th>项</th><th>权重</th><th>结果</th><th>证据</th></tr></thead><tbody>';
    rows.forEach(function (row) {
      html += '<tr class="' + (row.ok ? "" : "ng") + '">';
      html += '<td>' + esc(row.label) + '</td>';
      html += '<td>' + esc(row.weight) + '</td>';
      html += '<td>' + (row.ok ? '<span class="dz-ok">通过</span>' : '<span class="dz-ng">未过</span>') + '</td>';
      html += '<td class="dz-ev">' + esc(row.evidence || "") + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '</div>';

    /* 存疑清单 */
    html += '<div class="dz-card">';
    html += '<div class="dz-card-h">④ 存疑清单 <span class="dz-count">' + unc.length + ' 条</span></div>';
    html += '<p class="dz-warn">这一段比多画两个构件值钱。每一条都必须由人核过，才能当图纸用。</p>';
    if (unc.length) {
      html += '<table class="dz-table uncertain"><thead><tr><th>项目</th><th>推定值</th><th>依据</th><th>要核什么</th></tr></thead><tbody>';
      unc.forEach(function (u) {
        html += '<tr>';
        html += '<td><b>' + esc(u.item) + '</b></td>';
        html += '<td>' + esc(u.value || "") + '</td>';
        html += '<td class="dz-ev">' + esc(u.basis || "") + '</td>';
        html += '<td class="dz-ev">' + esc(u.check || "") + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<div class="dz-empty">没有存疑项。</div>';
    }
    html += '</div>';

    /* 成果文件 */
    html += '<div class="dz-card">';
    html += '<div class="dz-card-h">⑤ 成果文件</div>';
    html += '<table class="dz-table"><tbody>';
    html += '<tr><td>DXF</td><td class="dz-ev"><code>' + esc(r.dxf || "-") + '</code></td><td>AutoCAD 直接打开</td></tr>';
    html += '<tr><td>参数表</td><td class="dz-ev"><code>' + esc(r.spec_json || "-") + '</code></td><td>冻结数据，下游只读</td></tr>';
    if (r.ifc) {
      if (r.ifc.path) {
        const v = r.ifc.verify || {};
        html += '<tr><td>IFC</td><td class="dz-ev"><code>' + esc(r.ifc.path) + '</code></td><td>读回 ' +
          esc(v.good) + '/' + esc(v.total) + ' 道墙' + (v.all_ok ? ' ✔' : ' <b>有不符</b>') + '</td></tr>';
      } else {
        html += '<tr><td>IFC</td><td class="dz-ev">未生成</td><td>' + esc(r.ifc.error || "") + '</td></tr>';
      }
    }
    html += '<tr><td>RVT</td><td class="dz-ev">AI 无法生成</td><td>用 Revit 打开上面的 .ifc，再另存 .rvt</td></tr>';
    html += '</tbody></table>';
    html += '</div>';
  }

  /* 制图标准 */
  if (d.standards) {
    const st = d.standards;
    html += '<div class="dz-card">';
    html += '<div class="dz-card-h">⑥ 依据的制图标准</div>';
    html += '<table class="dz-table"><tbody>';
    (st.standards || []).forEach(function (s) {
      html += '<tr><td>' + esc(s.code) + '</td><td>' + esc(s.name) + '</td><td class="dz-ev">' + esc(s.used_for) + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '<div class="dz-hint">轴号规则：' + esc(st.axis_rule || "") + '</div>';
    html += '<div class="dz-hint">' + esc(st.note || "") + '</div>';
    html += '</div>';
  }

  html += '</div>';
  host.innerHTML = '<div class="view">' + html + '</div>';
  draftingBind();
}

function draftingBind() {
  const runBtn = $("#dz-run");
  if (runBtn) {
    runBtn.addEventListener("click", function () {
      const scheme = draftingCurrentScheme();
      if (!scheme) return toast("还没有方案，先到「项目」里运行分析", "err");
      State.drafting.sheet = ($("#dz-sheet") || {}).value || "A3";
      State.drafting.scale = Number(($("#dz-scale") || {}).value || 100);
      State.drafting.projectName = ($("#dz-name") || {}).value || "";
      draftingRequest("drafting_from_scheme", {
        scheme: scheme,
        sheet: State.drafting.sheet,
        scale: State.drafting.scale,
        project_name: State.drafting.projectName,
        make_ifc: true,
      });
    });
  }
  const stdBtn = $("#dz-std");
  if (stdBtn) {
    stdBtn.addEventListener("click", function () {
      draftingRequest("drafting_standards", {});
    });
  }
}

/* 转发后端事件：劫持 handlePyEvent，把制图指令截下来，其余照旧。
   和 inspection.js 的做法一致（inspection 也是这么接的）。 */
(function hookDraftingEvents() {
  if (typeof handlePyEvent !== "function") return;
  const baseHandler = handlePyEvent;
  handlePyEvent = function (ev) {
    if (ev && DRAFTING_CMDS.indexOf(ev.cmd) >= 0) {
      handleDraftingEvent(ev);
      return;
    }
    baseHandler(ev);
  };
})();