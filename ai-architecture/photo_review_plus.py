# -*- coding: utf-8 -*-
"""
photo_review_plus.py — human-in-the-loop review closure (task line B, 2026-11-17).

Builds on photo_review.py (which is NOT modified; this module imports and reuses
its inspect_file / f_directory / cell helpers) and adds the three things the
review said were missing:

  1. registry join  — read the field-photo registry CSV and inject structure_id /
     structure_type / lighting / disturbance / mm_per_px ... by sha256 (fallback:
     original_filename), so every candidate is tied to a component id
  2. interactive verdict UI — 有裂缝 / 无裂缝 / 不确定 + note, written back as a
     downloadable CSV/JSON from the browser (no server, no network)
  3. funnel metric — rank by candidate strength, adjustable threshold, live
     "N 张里筛出 M 张待复核" counter, so the "1000 -> 120" story is demonstrable

Everything stays on F:. No network. Human labels are never auto-assigned:
the model output is always called 候选 (candidate), the human verdict is separate.

Run:
  .venv-train/Scripts/python.exe photo_review_plus.py <photo_dir> \
      --registry data/field_photos/采集登记表.csv --out output/real_photo_review
  .venv-train/Scripts/python.exe photo_review_plus.py --demo
"""
from pathlib import Path
import argparse
import base64
import csv
import json
import math
import os
import sys
from datetime import datetime

ROOT = Path(__file__).resolve().parent
os.environ.update({'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'})
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))

import cv2
import numpy as np

import photo_review as base


# ---------------------------------------------------------------- registry
REG_FIELDS = ('photo_id', 'source_photo_id', 'structure_id', 'structure_type',
              'surface_material', 'lighting', 'shooting_distance', 'angle',
              'scale_reference', 'mm_per_px', 'device', 'photographer',
              'disturbance', 'pair_photo_id', 'human_label', 'capture_date', 'notes')


def load_registry(path):
    """Return (by_sha, by_name, rows). Missing file -> empty maps, not an error."""
    path = Path(path)
    by_sha, by_name, rows = {}, {}, []
    if not path.is_file():
        return by_sha, by_name, rows
    with path.open('r', encoding='utf-8-sig', newline='') as fh:
        for r in csv.DictReader(fh):
            rows.append(r)
            sha = str(r.get('sha256', '')).strip().lower()
            if sha:
                by_sha[sha] = r
            name = str(r.get('original_filename', '')).strip()
            if name:
                by_name.setdefault(name, r)
    return by_sha, by_name, rows


def enrich(record, by_sha, by_name):
    sha = str(record.get('sha256', '')).strip().lower()
    row = by_sha.get(sha) or by_name.get(record.get('file_name', ''))
    meta = {k: '' for k in REG_FIELDS}
    join = 'none'
    if row is not None:
        meta = {k: str(row.get(k, '') or '').strip() for k in REG_FIELDS}
        join = 'sha256' if (sha and by_sha.get(sha) is row) else 'original_filename'
    record['registry'] = meta
    record['registry_join'] = join
    return record


# ---------------------------------------------------------------- funnel
def suspect_score(record):
    """0..1 heuristic strength of the model's candidate, for ranking only.

    Combines candidate area ratio and skeleton length when available. Never a
    probability, never a verdict; used purely to order the review queue.
    """
    best = 0.0
    for result in record.get('results', {}).values():
        if not result.get('ok'):
            continue
        s = result.get('stats', {}) or {}
        area = s.get('crack_area_px')
        w, h = record.get('image_size_px') or [0, 0]
        total = max(1, (w or 0) * (h or 0))
        try:
            area = float(area)
        except (TypeError, ValueError):
            area = 0.0
        ratio = min(1.0, area / total * 40.0)          # 2.5% of pixels saturates
        length = 0.0
        try:
            length = float(s.get('skeleton_length_px') or 0.0)
        except (TypeError, ValueError):
            length = 0.0
        length_score = min(1.0, length / 400.0)
        best = max(best, 0.65 * ratio + 0.35 * length_score)
    return round(best, 4)


def build_funnel(records, threshold):
    total = len(records)
    scored = [r for r in records if r.get('processing_status') == 'processed']
    suspects = [r for r in scored if r.get('suspect_score', 0) >= threshold]
    invalid = sum(1 for r in records if r.get('processing_status') == 'invalid')
    attention = sum(1 for r in records if r.get('processing_status') == 'needs_attention')
    if not scored:
        reduction = '—'
        reduction_note = '无成功处理样本，不计筛除率'
    else:
        reduction = '%.1f%%' % (100.0 * (1 - len(suspects) / len(scored)))
        reduction_note = '以成功处理的 %d 张为分母' % len(scored)
    return dict(total=total, processed=len(scored), suspects=len(suspects),
                needs_attention=attention, invalid=invalid,
                threshold=threshold,
                reduction=reduction, reduction_note=reduction_note)


# ---------------------------------------------------------------- html
def build_html_plus(records, funnel, registry_rows, output):
    import html as H
    e = H.escape
    threshold = funnel['threshold']

    items = []
    for r in records:
        meta = r.get('registry', {}) or {}
        rid = r['record_id']
        score = r.get('suspect_score', 0.0)
        flags = []
        if r.get('registry_join') == 'none':
            flags.append('<span class="tag warn">登记表未匹配</span>')
        if meta.get('human_label'):
            flags.append('<span class="tag">登记表已有标签：%s</span>' % e(meta['human_label']))
        if r.get('processing_status') == 'invalid':
            flags.append('<span class="tag warn">处理失败</span>')
        parts = []
        if r.get('preview_b64'):
            parts.append('<figure><img src="%s"><figcaption>原图预览</figcaption></figure>' % r['preview_b64'])
        for engine, result in (r.get('results') or {}).items():
            if result.get('ok') and result.get('overlay_path'):
                p = output / result['overlay_path']
                if p.is_file():
                    src = 'data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode()
                    st = result.get('stats', {}) or {}
                    parts.append(
                        '<figure><img src="%s"><figcaption>%s 候选掩膜 · %s 候选像素 · 均宽 %s px</figcaption></figure>'
                        % (src, e(engine), e(str(st.get('crack_area_px', '—'))),
                           e(str(st.get('avg_width_px', '—')))))
            elif not result.get('ok'):
                parts.append('<p role="alert">%s：%s</p>' % (e(engine), e(result.get('error', '未完成'))))

        meta_rows = ''.join(
            '<tr><th>%s</th><td>%s</td></tr>' % (e(k), e(meta.get(k, '') or '—'))
            for k in ('structure_id', 'structure_type', 'surface_material', 'lighting',
                      'shooting_distance', 'angle', 'disturbance', 'mm_per_px',
                      'device', 'photographer', 'capture_date', 'notes')
        )
        items.append(f'''
<article class="card" data-record="{e(rid)}" data-score="{score}" data-status="{e(r.get('processing_status',''))}"
         data-label="{e(meta.get('human_label',''))}" data-join="{e(r.get('registry_join',''))}">
  <header>
    <h2>{e(rid)} · {e(r['file_name'])}</h2>
    <div class="meta-line">
      <span class="tag score">候选强度 {score:.3f}</span>
      <span class="tag">sha256 {e((r.get('sha256') or '')[:12])}…</span>
      {''.join(flags)}
    </div>
  </header>
  <div class="body">
    <div class="images">{''.join(parts)}</div>
    <div class="side">
      <table class="kv">{meta_rows}</table>
      <div class="verdict">
        <div class="verdict-title">人工复核（模型输出只是候选，你说了算）</div>
        <div class="btns">
          <button type="button" data-v="有裂缝">有裂缝</button>
          <button type="button" data-v="无裂缝">无裂缝</button>
          <button type="button" data-v="不确定">不确定</button>
          <button type="button" data-v="">清空</button>
        </div>
        <textarea placeholder="备注（伪裂缝类型、遮挡、比例尺说明等）" rows="2"></textarea>
      </div>
    </div>
  </div>
</article>''')

    doc = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>现场照片人工复核闭环</title>
<style>
:root{{color-scheme:light}}
body{{font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1d2a36;background:#f6f8fa;margin:0;padding:24px 18px}}
main{{max-width:1280px;margin:auto}}
h1{{font-size:23px;margin:0 0 6px}} .sub{{color:#5b6a78;font-size:13px;margin-bottom:16px}}
.bar{{position:sticky;top:0;z-index:9;background:#fff;border:1px solid #dbe3ea;border-radius:10px;padding:12px 16px;margin:0 0 18px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}}
.bar label{{font-size:13px;color:#3c4b5a}} input[type=range]{{width:180px;vertical-align:middle}}
.funnel{{display:flex;gap:22px;flex-wrap:wrap}}
.funnel div{{text-align:center}} .funnel b{{display:block;font-size:21px;color:#8e2b20}} .funnel span{{font-size:12px;color:#5b6a78}}
button, .bar button{{font:13px/1 inherit;padding:7px 13px;border:1px solid #c9d3dc;background:#fff;border-radius:7px;cursor:pointer}}
button:hover{{background:#eef3f8}} button[data-v="有裂缝"]{{border-color:#c0392b;color:#c0392b}}
button[data-v="无裂缝"]{{border-color:#2e8b57;color:#2e8b57}} button[data-v="不确定"]{{border-color:#c98a1b;color:#c98a1b}}
.card{{background:#fff;border:1px solid #dbe3ea;border-radius:11px;padding:16px 18px;margin:0 0 18px}}
.card h2{{font-size:16px;margin:0 0 6px}} .meta-line{{margin-bottom:10px}} .tag{{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:#eef2f6;color:#41525f;margin-right:6px}}
.tag.warn{{background:#fdecea;color:#b3261e}} .tag.score{{background:#e8f0fb;color:#1f4e8c}}
.body{{display:flex;gap:18px;flex-wrap:wrap}} .images{{display:flex;gap:12px;flex-wrap:wrap;flex:2 1 460px}}
figure{{margin:0;flex:1 1 210px;max-width:430px}} img{{width:100%;height:auto;border-radius:6px;border:1px solid #e3e9ee}}
figcaption{{color:#5b6a78;font-size:11px;margin-top:4px}}
.side{{flex:1 1 300px;min-width:280px}}
table.kv{{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:12px}}
table.kv th{{text-align:left;color:#5b6a78;font-weight:500;padding:3px 8px 3px 0;white-space:nowrap;vertical-align:top}}
table.kv td{{padding:3px 0}}
.verdict{{background:#f8fafc;border:1px dashed #c9d3dc;border-radius:9px;padding:11px}}
.verdict-title{{font-size:12px;color:#41525f;margin-bottom:8px}}
.btns{{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:8px}} textarea{{width:100%;box-sizing:border-box;font:12px/1.5 inherit;border:1px solid #c9d3dc;border-radius:6px;padding:6px}}
.done-有裂缝{{box-shadow:inset 4px 0 0 #c0392b}} .done-无裂缝{{box-shadow:inset 4px 0 0 #2e8b57}} .done-不确定{{box-shadow:inset 4px 0 0 #c98a1b}}
.hidden{{display:none}}
</style></head><body><main>
<h1>现场照片人工复核闭环</h1>
<div class="sub">模型输出一律只是<b>候选</b>，人工确认/驳回才是最终口径 · 原图不修改 · 全部本机运行，无网络调用 · {funnel['total']} 张</div>

<div class="bar">
  <div class="funnel">
    <div><b>{funnel['total']}</b><span>投递总数</span></div>
    <div><b>{funnel['processed']}</b><span>推理成功</span></div>
    <div><b id="f-suspect">{funnel['suspects']}</b><span>待复核（疑似）</span></div>
    <div><b id="f-done">0</b><span>已人工判定</span></div>
    <div><b>{funnel['invalid']}</b><span>处理失败</span></div>
    <div><b id="f-cut">{e(funnel['reduction'])}</b><span>筛掉比例</span></div>
  </div>
  <div class="sub" style="margin:4px 0 0">{e(funnel.get('reduction_note',''))}</div>
  <label>疑似阈值（候选强度 ≥）<input type="range" id="thr" min="0" max="1" step="0.01" value="{threshold}"><b id="thr-val">{threshold}</b></label>
  <label>排序<select id="sort"><option value="score">按候选强度降序</option><option value="id">按编号</option></select></label>
  <label><input type="checkbox" id="only-suspect" checked> 只看疑似</label>
  <label><input type="checkbox" id="only-undone"> 只看未判定</label>
  <button type="button" id="export-csv">导出人工复核 CSV</button>
  <button type="button" id="export-json">导出 JSON</button>
</div>

{''.join(items)}

<div class="bar" style="margin-top:22px">
  <b>三态口径</b>：有裂缝＝线状、连续、可追踪、有破损边缘；无裂缝＝含接缝/污渍/阴影/修补痕等干扰物也算无裂缝；
  不确定＝失焦/过曝/遮挡，单独归档，<b>不进任何训练集合</b>。
  伪裂缝清单见《真实照片采集与标注规范》§4.2。
</div>
</main>
<script>
const CARDS=[...document.querySelectorAll('.card')];
const STATE={{}};
function currentLabel(c){{const k=c.dataset.record;return STATE[k]?.label ?? (c.dataset.label||'');}}
function render(){{
  const thr=parseFloat(document.getElementById('thr').value);
  document.getElementById('thr-val').textContent=thr.toFixed(2);
  const onlyS=document.getElementById('only-suspect').checked;
  const onlyU=document.getElementById('only-undone').checked;
  const sort=document.getElementById('sort').value;
  let suspect=0,done=0;
  const list=CARDS.slice().sort((a,b)=> sort==='score'
      ? parseFloat(b.dataset.score)-parseFloat(a.dataset.score)
      : a.dataset.record.localeCompare(b.dataset.record));
  list.forEach(c=>document.querySelector('main').appendChild(c));
  CARDS.forEach(c=>{{
    const sc=parseFloat(c.dataset.score);
    const lab=currentLabel(c);
    if(lab)done++;
    const isSuspect=sc>=thr;
    if(isSuspect)suspect++;
    let show=true;
    if(onlyS && !isSuspect)show=false;
    if(onlyU && lab)show=false;
    c.classList.toggle('hidden',!show);
    c.classList.remove('done-有裂缝','done-无裂缝','done-不确定');
    if(lab)c.classList.add('done-'+lab);
  }});
  document.getElementById('f-suspect').textContent=suspect;
  document.getElementById('f-done').textContent=done;
  const processed=CARDS.filter(c=>c.dataset.status==='processed').length;
  const total=CARDS.length;
  if(processed===0){{
    document.getElementById('f-cut').textContent='全部处理失败';
  }} else {{
    const pSuspect=CARDS.filter(c=>c.dataset.status==='processed'&&parseFloat(c.dataset.score)>=thr).length;
    document.getElementById('f-cut').textContent=(100*(1-pSuspect/processed)).toFixed(1)+'%';
  }}
}}
document.addEventListener('click',ev=>{{
  const b=ev.target.closest('button[data-v]'); if(!b)return;
  const card=b.closest('.card'); const rid=card.dataset.record;
  STATE[rid]=STATE[rid]||{{label:'',note:''}};
  STATE[rid].label=b.dataset.v;
  render();
}});
document.addEventListener('input',ev=>{{
  if(ev.target.matches('.verdict textarea')){{
    const card=ev.target.closest('.card');
    const rid=card.dataset.record;
    STATE[rid]=STATE[rid]||{{label:'',note:''}};
    STATE[rid].note=ev.target.value;
  }}
  if(ev.target.id==='thr')render();
}});
document.getElementById('sort').onchange=render;
document.getElementById('only-suspect').onchange=render;
document.getElementById('only-undone').onchange=render;
function collect(){{
  return CARDS.map(c=>{{
    const rid=c.dataset.record;
    const st=STATE[rid]||{{}};
    return {{record_id:rid, file_name:c.querySelector('h2').textContent.split('·').pop().trim(),
      sha256:c.querySelector('.tag:nth-child(2)').textContent.replace('sha256','').replace('…','').trim(),
      suspect_score:parseFloat(c.dataset.score),
      human_label: st.label ?? (c.dataset.label||''),
      review_note: st.note ?? '',
      structure_id: (c.querySelector('table.kv th')?.nextElementSibling?.textContent)||''}};
  }});
}}
function download(name,text,type){{
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([text],{{type}}));
  a.download=name; a.click(); URL.revokeObjectURL(a.href);
}}
document.getElementById('export-csv').onclick=()=>{{
  const rows=collect();
  const head=['record_id','file_name','sha256','structure_id','suspect_score','human_label','review_note'];
  const csv=[head.join(',')].concat(rows.map(r=>head.map(k=>{{
    let v=String(r[k]??''); if(/^[=+\\-@]/.test(v))v="'"+v; return '"'+v.replace(/"/g,'""')+'"';}}).join(','))).join('\\n');
  download('人工复核_导出.csv','\\ufeff'+csv,'text/csv;charset=utf-8');
}};
document.getElementById('export-json').onclick=()=>{{
  download('人工复核_导出.json',JSON.stringify({{schema_version:1,exported:new Date().toISOString(),records:collect()}},null,2),'application/json');
}};
render();
</script></body></html>'''
    return doc


# ------------------------------------------------------------------- run
def run(input_dir, output_parent, registry_path, engines=('cracknet', 'rule'),
        mm_per_px=None, threshold=0.18):
    source = Path(input_dir).resolve()
    if not source.is_dir():
        raise ValueError('照片文件夹不存在：%s' % source)
    by_sha, by_name, reg_rows = load_registry(registry_path)
    parent = base.f_directory(output_parent)
    output = parent / (datetime.now().strftime('%Y%m%d_%H%M%S') + '_plus')
    output.mkdir(exist_ok=True)

    photos = sorted(p for p in source.iterdir()
                    if p.is_file() and p.suffix.lower() in base.EXTENSIONS)
    if not photos:
        raise ValueError('文件夹没有 JPG/JPEG/PNG 照片；先放入照片再运行')

    records = []
    for i, path in enumerate(photos, 1):
        rec = base.inspect_file(path, engines, output, 'R%04d' % i, mm_per_px)
        rec = enrich(rec, by_sha, by_name)
        rec['suspect_score'] = suspect_score(rec)
        records.append(rec)
        print(json.dumps(dict(completed=i, total=len(photos), file=path.name,
                              status=rec['processing_status'],
                              suspect=rec['suspect_score'],
                              structure=rec['registry'].get('structure_id', '')),
                         ensure_ascii=False), flush=True)

    funnel = build_funnel(records, threshold)

    serial = [{k: v for k, v in r.items() if k != 'preview_b64'} for r in records]
    base.write_json(output / 'records_plus.json', dict(
        schema_version=2, input_directory=str(source),
        registry=str(registry_path), registry_rows=len(reg_rows),
        original_files_modified=False, mm_per_px=mm_per_px,
        suspect_threshold=threshold, funnel=funnel, records=serial))

    with (output / '人工复核.csv').open('w', encoding='utf-8-sig', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['record_id', 'file_name', 'sha256', 'structure_id', 'structure_type',
                    'suspect_score', 'processing_status', 'human_label', 'review_note',
                    'registry_join', 'source_path'])
        for r in records:
            m = r.get('registry', {}) or {}
            w.writerow([base.cell(v) for v in (
                r['record_id'], r['file_name'], r.get('sha256', ''),
                m.get('structure_id', ''), m.get('structure_type', ''),
                r.get('suspect_score', 0), r['processing_status'], '', '',
                r.get('registry_join', ''), r['source_path'])])

    (output / '现场照片复核.html').write_text(
        build_html_plus(records, funnel, reg_rows, output), encoding='utf-8')
    base.write_json(output / 'summary.json', dict(
        funnel=funnel, engines=list(engines),
        registry_joined=sum(1 for r in records if r.get('registry_join') != 'none'),
        human_labels_assigned=0,
        note='human labels are never auto-assigned; model output is candidate only',
        output_directory=str(output)))
    return output, funnel


# ------------------------------------------------------------------ demo
def make_demo_photos(folder):
    """Synthetic concrete-like tiles with and without dark lines. Test only."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(11)
    for i in range(8):
        img = rng.integers(120, 165, (300, 380), dtype=np.uint8)
        img = cv2.GaussianBlur(img, (5, 5), 0)
        if i % 2 == 0:
            # draw a dark meandering line (a synthetic "crack")
            pts = []
            y = 40 + 10 * i
            for x in range(20, 360, 12):
                y += int(rng.integers(-7, 8))
                pts.append((x, max(10, min(290, y))))
            for j in range(len(pts) - 1):
                cv2.line(img, pts[j], pts[j + 1], int(rng.integers(18, 42)), 2)
        else:
            # a distractor: a straight seam (should NOT be a crack)
            cv2.line(img, (30, 200), (350, 205), 70, 3)
        ok, data = cv2.imencode('.png', img)
        assert ok
        (folder / ('demo_%02d.png' % i)).write_bytes(data.tobytes())
    return folder


def main():
    ap = argparse.ArgumentParser(description='现场照片人工复核闭环（登记表关联 + 交互判定 + 漏斗）')
    ap.add_argument('input_dir', nargs='?', default=str(ROOT / 'data/field_photos'))
    ap.add_argument('--registry', default=str(ROOT / 'data/field_photos/采集登记表.csv'))
    ap.add_argument('--out', default=str(ROOT / 'output/real_photo_review'))
    ap.add_argument('--engine', choices=('both', 'cracknet', 'rule'), default='both')
    ap.add_argument('--mm-per-px', type=float)
    ap.add_argument('--threshold', type=float, default=None,
                    help='疑似阈值（候选强度 0..1）；真实照片默认 0.18，--demo 用 0.72（按演示图分布选的，非工程值）')
    ap.add_argument('--demo', action='store_true',
                    help='生成合成照片自测，输出到 output/（绝不写入 data/field_photos）')
    ap.add_argument('--open-report', action='store_true')
    a = ap.parse_args()

    runtime = base.f_directory(ROOT / '.cache/runtime')
    os.environ['TEMP'] = str(runtime)
    os.environ['TMP'] = str(runtime)

    if a.demo:
        demo_photos = ROOT / 'output' / 'photo_review_plus_demo_20261117' / 'photos'
        make_demo_photos(demo_photos)
        a.input_dir = str(demo_photos)
        a.out = str(ROOT / 'output' / 'photo_review_plus_demo_20261117' / 'review')
        print('demo photos:', demo_photos)

    if a.threshold is None:
        a.threshold = 0.72 if a.demo else 0.18

    engines = ('cracknet', 'rule') if a.engine == 'both' else (a.engine,)
    output, funnel = run(a.input_dir, a.out, a.registry, engines, a.mm_per_px, a.threshold)
    print(json.dumps(funnel, ensure_ascii=False))
    print(str(output / '现场照片复核.html'))
    if a.open_report:
        os.startfile(str(output / '现场照片复核.html'))


if __name__ == '__main__':
    main()
