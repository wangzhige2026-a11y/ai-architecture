/* Basic inspection methods and reviewable data records. Shared desktop/Web UI. */
"use strict";
State.inspection = {
  methods: [], catalogLoaded: false, pending: {}, dataBusy: false, lookupBusy: false,
  engine: "local", text: "", query: "", selected: "sonreb", defaultMethod: "sonreb",
  answer: null, result: null, saved: null, error: "", catalogError: "", lookupError: "", dirty: false,
};
const INSPECTION_COMMANDS = ["list_inspection_methods", "ask_inspection_method", "process_inspection_records", "save_inspection_records"];
VIEWS.splice(VIEWS.findIndex(v => v.id === "disease"), 0, {id:"inspection", ic:"📋", name:"检测基础", crumb:"检测方法与数据处理"});
const INSPECTION_SAMPLE = "测区编号,构件编号,检测方法,回弹值,测距(mm),声时(us),测量方式,碳化深度(mm),龄期(d)\nQ1,梁B1,超声回弹综合法,32|33|34,500,125,对测,1.5,28\nQ2,梁B1,超声回弹综合法,31|32|33,480,120,对测,1.2,28";
const INSPECTION_FIELD_NAMES = {record_id:"测区编号",component_id:"构件编号",method_id:"方法",component_type:"构件类型",inspection_date:"检测日期",instrument_id:"仪器编号",material:"材料或骨料",surface_state:"表面或含水状态",test_direction:"测试方向",test_mode:"测量布置",rebound_values:"原始回弹读数",path_length:"测距",transit_time:"声时",pulse_velocity:"声速",carbonation_depth:"碳化深度",age:"龄期",crack_width:"裂缝宽度",crack_length:"裂缝长度",frequency:"频率",two_way_time:"双程时间",core_diameter:"芯样直径",core_height:"芯样高度",failure_load:"破坏荷载",reported_strength:"来源报告的强度（未复算）",scan_file:"扫描文件",reference_standard:"所填标准",curve_id:"所填曲线",note:"备注"};
function inspectionRefresh() { if (State.view === "inspection") renderInspectionView(); }
function inspectionRequest(command, data) {
  const d=State.inspection;
  const requestId="inspection_"+Date.now()+"_"+Math.random().toString(16).slice(2);
  const payload=Object.assign({},data,{request_id:requestId});
  if (payload.engine==="ai" && typeof buildAiOverride==="function") {
    const override=buildAiOverride();
    if (override) payload.ai_override=override;
  }
  d.pending[requestId]=command;
  const fail=message=>handleInspectionEvent({type:"error",cmd:command,request_id:requestId,message});
  try {
    Promise.resolve(Bridge.invoke(command,payload)).then(reply=>{
      if (reply && reply.ok===false && d.pending[requestId]) fail(reply.error||reply.message||"请求未能发出");
    }).catch(error=>fail(error&&error.message ? error.message : "连接未完成，请重试"));
  } catch(error) { fail(error&&error.message ? error.message : "连接未完成，请重试"); }
}
function handleInspectionEvent(event) {
  const d=State.inspection;
  if (!d.pending[event.request_id] || d.pending[event.request_id]!==event.cmd) return;
  delete d.pending[event.request_id];
  if (event.cmd==="ask_inspection_method") d.lookupBusy=false;
  if (["process_inspection_records","save_inspection_records"].includes(event.cmd)) d.dataBusy=false;
  if (event.type==="error") {
    if (event.cmd==="list_inspection_methods") d.catalogError=event.message||"方法目录暂不可用";
    else if (event.cmd==="ask_inspection_method") d.lookupError=event.message||"问题暂未完成";
    else d.error=event.message||"记录处理未完成";
    inspectionRefresh(); return;
  }
  const result=event.payload||{};
  if (event.cmd==="list_inspection_methods") {
    d.methods=Array.isArray(result.methods)?result.methods:[];
    d.catalogLoaded=true; d.catalogError="";
  } else if (event.cmd==="ask_inspection_method") {
    d.answer=result; d.lookupError=result.ok===false ? result.error||"知识库未覆盖" : "";
  } else if (event.cmd==="process_inspection_records") {
    d.result=result; d.saved=null; d.error=""; d.dirty=d.text!==result.source_text;
  } else if (event.cmd==="save_inspection_records") { d.saved=result; d.error=""; }
  inspectionRefresh();
}
const inspectionBaseEventHandler=handlePyEvent;
handlePyEvent=function(event) {
  if (INSPECTION_COMMANDS.includes(event.cmd)) { handleInspectionEvent(event); return; }
  inspectionBaseEventHandler(event);
};
function inspectionMethodName(id) {
  const method=State.inspection.methods.find(m=>m.id===id);
  return method ? method.name : id||"待确认";
}
function inspectionSources(method) {
  return (method.sources||[]).map(source=>{
    const href=/^https?:\/\//i.test(String(source.url||"")) ? source.url : "#";
    return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>`;
  }).join("<br>");
}
function inspectionMethodCard(method) {
  if (!method) return "";
  const list=items=>`<ul>${(items||[]).map(item=>`<li>${esc(item)}</li>`).join("")}</ul>`;
  return `<article class="ik-method"><h4>${esc(method.name)}</h4><p>${esc(method.principle)}</p>
    <h5>可提供什么</h5>${list(method.measures)}<h5>能力边界</h5>${list(method.cannot)}
    <h5>需要记录</h5>${list(method.inputs)}<h5>影响因素与限制</h5>${list(method.limitations)}
    <details><summary>基本流程与依据</summary>${list(method.workflow)}<div class="ik-sources">${inspectionSources(method)}</div></details></article>`;
}
function inspectionQuantity(value) {
  if (value && typeof value==="object" && "value" in value) return value.value+" "+value.unit;
  return Array.isArray(value) ? value.join("、") : String(value==null?"":value);
}
function inspectionResultHtml(result) {
  const d=State.inspection, summary=result.summary||{};
  let html=`<div class="ik-status-row"><span>共 ${summary.total||0} 条</span><span class="ik-valid">基础校验通过 ${summary.valid||0}</span><span class="ik-review">待复核 ${summary.needs_review||0}</span><span class="ik-invalid">输入问题 ${summary.invalid||0}</span></div>
    <p class="ik-hint">${esc(result.interpretation||"")} ${result.engine==="ai"?"本次使用外部AI抽取，保留了原文依据。":"本次使用本地解析，未调用外部AI。"}</p>
    <p id="ik-dirty" class="ik-review">${d.dirty?"原文已修改，请重新解析；保存按钮暂不可用。":""}</p>
    <div class="ik-scroll"><table class="ik-table"><thead><tr><th>测区 / 构件</th><th>方法</th><th>状态</th><th>原始回弹均值<br>未作规范修正</th><th>声速 km/s</th><th>校验问题</th></tr></thead><tbody>`;
  (result.records||[]).forEach(row=>{
    const n=row.normalized||{}, c=row.computed||{}, issues=(row.errors||[]).concat(row.warnings||[]);
    const status={valid:"基础通过",needs_review:"待复核",invalid:"输入问题"}[row.status]||"待复核";
    const velocity=c.pulse_velocity||n.pulse_velocity;
    const fields=Object.entries(n).map(([key,value])=>`<div><span>${esc(INSPECTION_FIELD_NAMES[key]||key)}</span><b>${esc(inspectionQuantity(value))}</b></div>`).join("");
    html+=`<tr><td>${esc(row.record_id)}<small>${esc(n.component_id||"构件缺失")}</small></td><td>${esc(inspectionMethodName(n.method_id))}</td><td class="ik-${row.status==="valid"?"valid":row.status==="invalid"?"invalid":"review"}">${status}</td><td>${c.rebound_raw_summary?esc(c.rebound_raw_summary.mean):"—"}</td><td>${velocity?esc(velocity.value)+(c.pulse_velocity?"（复算）":"（记录）"):"—"}</td><td>${issues.length?issues.map(i=>esc(i.message)).join("<br>"):"未发现本工具覆盖的字段问题"}</td></tr>
      <tr><td colspan="6"><details><summary>查看 ${esc(row.record_id)} 的统一单位、计算说明及原文依据</summary><div class="ik-values">${fields}</div>${c.pulse_velocity?`<p>${esc(c.pulse_velocity.formula)}；${esc(c.pulse_velocity.note)}</p>`:""}${c.strength?`<p class="ik-hint">${esc(c.strength.reason)}</p>`:""}
      ${result.engine==="ai"?`<pre>${esc(JSON.stringify(((result.extracted_records||[]).find(r=>r&&String(r.record_id)===row.record_id)||{}).evidence||{},null,2))}</pre>`:""}</details></td></tr>`;
  });
  html+='</tbody></table></div>';
  html+=`<div class="ik-actions"><button class="btn" id="ik-save" ${d.dataBusy||d.dirty?"disabled":""}>保存处理记录（含问题清单）</button></div>`;
  if (d.saved) html+=`<div class="ik-note">${esc(d.saved.message)}<br>${esc(d.saved.json_path||"")}<br>${esc(d.saved.csv_path||"")}</div>`;
  return html;
}
function renderInspectionView() {
  const d=State.inspection;
  if (!d.catalogLoaded && !d.catalogError && !Object.values(d.pending).includes("list_inspection_methods")) inspectionRequest("list_inspection_methods",{});
  const selected=d.methods.find(m=>m.id===d.selected)||d.methods[0];
  const cards=d.answer&&d.answer.ok ? (d.answer.methods||[]) : selected?[selected]:[];
  $("#content").innerHTML=`<div class="view"><section class="section ik-root"><h3><span class="bar"></span>检测基础 · 方法认识与数据处理</h3>
    <p class="ik-intro">核对方法、整理记录、统一单位并复算基础量。可选外部AI辅助抽取，字段与计算仍由程序校验。</p>
    <div class="ik-layout"><div class="card"><div class="card-title">8 类基础检测方法</div>
      ${d.catalogError?`<p class="ik-invalid">${esc(d.catalogError)}</p>`:""}
      <div class="ik-method-buttons">${d.methods.map(m=>`<button class="btn ${d.selected===m.id?"primary":""}" data-ik-method="${esc(m.id)}">${esc(m.name)}</button>`).join("")}</div>
      <label for="ik-query">方法问题</label><input class="input ik-wide" id="ik-query" placeholder="例如：回弹值能直接当作强度吗？" value="${esc(d.query)}">
      <div class="ik-actions"><button class="btn" id="ik-ask" ${d.lookupBusy?"disabled":""}>${d.lookupBusy?"检索中…":"检索方法依据"}</button></div>
      ${d.lookupError?`<p class="ik-invalid" role="alert">${esc(d.lookupError)}</p>`:""}
      ${d.answer&&d.answer.engine==="ai_router"?'<p class="ik-hint">外部AI只辅助识别问题，答案来自下列知识条目。</p>':""}
      ${cards.map(inspectionMethodCard).join("")}</div>
      <div class="card"><div class="card-title">检测记录整理</div>
      <div class="ik-input-row"><label>处理方式<select class="input" id="ik-engine"><option value="local" ${d.engine==="local"?"selected":""}>本地解析（不联网）</option><option value="ai" ${d.engine==="ai"?"selected":""}>外部AI抽取（发送当前文本）</option></select></label>
      <label>记录缺少方法时采用<select class="input" id="ik-default-method"><option value="">不指定，要求记录明确</option>${d.methods.map(m=>`<option value="${esc(m.id)}" ${d.defaultMethod===m.id?"selected":""}>${esc(m.name)}</option>`).join("")}</select></label></div>
      <p class="ik-hint">本地支持带表头的 CSV/TSV、JSON，或“字段名:数值 单位”。复杂叙述可选外部AI；使用当前已配置服务。AI不补缺失数字或单位。</p>
      <label class="ik-block" for="ik-text">待处理原始记录</label><textarea class="input ik-text" id="ik-text" maxlength="100000" placeholder="粘贴检测记录，或点击下方填入示例">${esc(d.text)}</textarea>
      <div class="ik-actions"><button class="btn" id="ik-example" ${d.dataBusy?"disabled":""}>填入示例数据</button><label class="btn ik-file">读取本地文本/表格<input id="ik-file" type="file" accept=".csv,.tsv,.json,.txt" hidden ${d.dataBusy?"disabled":""}></label><button class="btn primary" id="ik-process" ${d.dataBusy?"disabled":""}>${d.dataBusy?"处理中…":"解析并校验"}</button></div>
      <p class="ik-hint">CSV回弹读数可用 32|33|34；量值应带单位或在表头标注单位。统计不自动套用测强曲线。</p>
      ${d.error?`<div class="ik-error" role="alert">${esc(d.error)}</div>`:""}
      ${d.result?inspectionResultHtml(d.result):'<div class="empty">处理后显示统一单位、基础量、原文依据与需复核的问题。</div>'}</div></div></section></div>`;
  $$("[data-ik-method]").forEach(button=>button.addEventListener("click",()=>{d.selected=button.dataset.ikMethod;d.answer=null;d.lookupError="";renderInspectionView();}));
  const textInput=$("#ik-text"), queryInput=$("#ik-query");
  const setDirty=()=>{d.dirty=!!d.result&&d.text!==d.result.source_text;const note=$("#ik-dirty"), save=$("#ik-save");if(note)note.textContent=d.dirty?"原文已修改，请重新解析；保存按钮暂不可用。":"";if(save)save.disabled=d.dirty||d.dataBusy;};
  textInput.addEventListener("input",()=>{d.text=textInput.value;setDirty();});
  queryInput.addEventListener("input",()=>{d.query=queryInput.value;});
  $("#ik-engine").addEventListener("change",event=>{d.engine=event.target.value;});
  $("#ik-default-method").addEventListener("change",event=>{d.defaultMethod=event.target.value;});
  $("#ik-example").addEventListener("click",()=>{d.text=INSPECTION_SAMPLE;d.engine="local";d.defaultMethod="sonreb";d.result=null;d.saved=null;d.error="";d.dirty=false;renderInspectionView();});
  $("#ik-file").addEventListener("change",event=>{
    const file=event.target.files&&event.target.files[0];if(!file)return;
    if(file.size>300000){d.error="文本文件过大，请控制在300KB以内";renderInspectionView();return;}
    const reader=new FileReader();reader.onload=()=>{d.text=String(reader.result||"");d.result=null;d.saved=null;d.error=d.text.length>100000?"文本超过100000字符，请分批处理":"";renderInspectionView();};reader.onerror=()=>{d.error="文本读取失败，请使用UTF-8文本";renderInspectionView();};reader.readAsText(file,"utf-8");
  });
  $("#ik-ask").addEventListener("click",()=>{d.query=queryInput.value.trim();if(!d.query){d.lookupError="请先填写方法问题";renderInspectionView();return;}d.lookupBusy=true;d.lookupError="";inspectionRequest("ask_inspection_method",{question:d.query,engine:d.engine});renderInspectionView();});
  $("#ik-process").addEventListener("click",()=>{d.text=textInput.value;if(!d.text.trim()){d.error="请先填入检测记录";renderInspectionView();return;}d.dataBusy=true;d.error="";d.saved=null;d.result=null;d.dirty=false;inspectionRequest("process_inspection_records",{text:d.text,engine:d.engine,method_id:d.defaultMethod||null});renderInspectionView();});
  const save=$("#ik-save");if(save)save.addEventListener("click",()=>{if(!d.result||d.dirty)return;d.dataBusy=true;d.error="";inspectionRequest("save_inspection_records",{receipt_id:d.result.receipt_id});renderInspectionView();});
}
