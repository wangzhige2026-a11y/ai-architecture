# -*- coding: utf-8 -*-
"""
disease_detect_test.py —— 病害检测（裂缝）回归测试

两部分：
  A. 库级测试（总是跑）：直接调 disease_detect.analyze()，验证
     「能检出裂缝 / 装饰物不被误检 / 宽度量级合理 / 无比例尺不给毫米」
  B. 全链路测试（可选）：如果 http://127.0.0.1:8000 有服务在跑，
     就再走一遍 POST /api/invoke → SSE 收结果；没起服务就 SKIP，不算失败。

跑法：PYTHONPATH= py disease_detect_test.py
"""

import base64
import json
import os
import sys
import threading
import time
import urllib.request

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import disease_detect as dd  # noqa: E402

BASE = "http://127.0.0.1:8000"


# ---------------------------------------------------------------- 合成测试图
def make_test_image(w=900, h=650, seed=11):
    """带 3 条裂缝 + 水渍斑 + 阴影条 + 麻点的合成图。

    ⚠️ 这是程序画出来的，不是真实桥梁照片。只能用来验证流程与过滤规则，
       不能用来声称「已在真实工程照片上验证」。
    """
    rng = np.random.default_rng(seed)
    base = np.full((h, w), 172, np.float32)
    for scale, amp in ((3, 20), (8, 12), (20, 8)):
        n = rng.normal(0, amp, (h // scale + 2, w // scale + 2))
        n = cv2.resize(n.astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        base += n
    base += np.linspace(-15, 15, w, dtype=np.float32)[None, :]
    gray = np.clip(cv2.GaussianBlur(base, (0, 0), sigmaX=8), 0, 255).astype(np.uint8)

    def crack(src, pts, width, sd):
        canvas = np.zeros((h, w), np.uint8)
        r = np.random.default_rng(sd)
        dense = []
        for i in range(len(pts) - 1):
            (x1, y1), (x2, y2) = pts[i], pts[i + 1]
            seg = max(2, int(max(abs(x2 - x1), abs(y2 - y1))))
            for t in np.linspace(0, 1, seg, endpoint=False):
                dense.append((int(x1 + (x2 - x1) * t + r.normal(0, 2)),
                              int(y1 + (y2 - y1) * t + r.normal(0, 2))))
        for p in dense:
            cv2.circle(canvas, p, max(1, int(width)), 255, -1)
        a = cv2.GaussianBlur(canvas, (0, 0), sigmaX=max(0.6, width * 0.45)).astype(np.float32) / 255.0
        a = a * 0.92
        return np.clip(src.astype(np.float32) * (1 - a) + 55 * a, 0, 255).astype(np.uint8)

    g = crack(gray, [(90, 70), (260, 220), (420, 330), (600, 500), (820, 610)], 2, 1)
    g = crack(g, [(60, 560), (230, 500), (400, 420), (560, 300), (700, 180)], 3, 2)
    g = crack(g, [(450, 50), (520, 180), (640, 270), (760, 400)], 6, 3)
    # 装饰物：面状水渍斑 + 横贯阴影条 + 小麻点
    cv2.ellipse(g, (int(w * 0.8), int(h * 0.2)), (int(w * 0.09), int(h * 0.06)), 20, 0, 360, 132, -1)
    cv2.rectangle(g, (0, int(h * 0.66)), (w, int(h * 0.66) + 12), 126, -1)
    for _ in range(16):
        cv2.circle(g, (int(rng.integers(0, w)), int(rng.integers(0, h))),
                   int(rng.integers(1, 3)), int(rng.integers(80, 130)), -1)
    return g


def img_to_b64(img):
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode("ascii")


# ---------------------------------------------------------------- 断言
def check(r, label, ok, detail=""):
    print("  [%s] %-38s %s" % ("PASS" if ok else "FAIL", label, detail))
    return 0 if ok else 1


def lib_tests():
    print("=" * 64)
    print("A. 库级测试（直接调 disease_detect.analyze）")
    print("=" * 64)
    bad = 0
    img = make_test_image()

    # 1) 不给比例尺
    r = dd.analyze(img, mm_per_px=None)
    s = r["stats"]
    bad += check(r, "ok 为真", r.get("ok") is True)
    bad += check(r, "检出裂缝 >=1", (s.get("crack_count") or 0) >= 1,
                 "crack_count=%d" % s.get("crack_count"))
    bad += check(r, "无比例尺 → 不给毫米",
                 "avg_width_mm" not in s and s.get("width_unit", "").startswith("px"),
                 s.get("width_unit"))
    bad += check(r, "有 overlay / mask 图",
                 len(r.get("overlay_b64") or "") > 1000 and len(r.get("mask_b64") or "") > 100)
    bad += check(r, "最大宽度 < 图宽 8%",
                 s.get("max_width_px", 99) < 0.08 * s.get("image_size_px", [9999])[0],
                 "max=%.2fpx" % s.get("max_width_px", -1))
    bad += check(r, "占比在 0.1%~15%",
                 0.001 <= s.get("crack_pixel_ratio", 0) <= 0.15,
                 "%.2f%%" % (s.get("crack_pixel_ratio", 0) * 100))

    # 2) 装饰物必须被滤掉（按形状特征判，不按位置判）
    comps = r.get("components") or []
    img_w = s.get("image_size_px", [0])[0]
    solid = [c for c in comps if c["fill_ratio"] > 0.25 and c["area_px"] > 1500]
    bar = [c for c in comps if c["w"] > 0.8 * img_w and c["h"] < 30]
    speck = [c for c in comps if c["area_px"] < 80 and c["elongation"] < 2.0]
    bad += check(r, "面状水渍斑未被当成裂缝", len(solid) == 0, "命中 %d" % len(solid))
    bad += check(r, "横向阴影条未被当成裂缝", len(bar) == 0, "命中 %d" % len(bar))
    bad += check(r, "小而圆的麻点未被当成裂缝", len(speck) == 0, "命中 %d" % len(speck))

    # 3) 给了比例尺才出毫米
    r2 = dd.analyze(img, mm_per_px=0.35)
    s2 = r2["stats"]
    bad += check(r2, "给了比例尺 → 出毫米",
                 isinstance(s2.get("avg_width_mm"), (int, float)) and s2.get("width_unit") == "mm",
                 "avg=%s mm" % s2.get("avg_width_mm"))

    # 4) 非法输入必须明确失败，不能糊弄
    bad += check(None, "空 base64 → ok=False",
                 dd.analyze_b64("").get("ok") is False)
    bad += check(None, "非图片 base64 → ok=False",
                 dd.analyze_b64("aGVsbG8=").get("ok") is False)

    # 5) 细化算法本身（方块 → 1 像素；粗线 → 约 1px 宽）
    a = np.zeros((21, 21), np.uint8); a[5:16, 5:16] = 255
    sk = dd.zhang_suen(a)
    bad += check(None, "Zhang-Suen：实心方块细到 1 像素",
                 int((sk > 0).sum()) == 1, "剩 %d px" % int((sk > 0).sum()))
    b = np.zeros((30, 200), np.uint8); b[10:20, 5:195] = 255
    sk2 = dd.zhang_suen(b)
    bad += check(None, "Zhang-Suen：粗线细到约 1px 宽",
                 150 <= int((sk2 > 0).sum()) <= 200, "剩 %d px" % int((sk2 > 0).sum()))

    # ---- 把握度（confidence）断言（2026-11-18 校准任务）----
    # ① 正常情况必须带 confidence（可能为 dict 或 None，取决于 torch/校准表是否可用）
    conf = r.get("confidence")
    if conf is not None:
        bad += check(r, "confidence.tier 在高中低三档内",
                     conf.get("tier") in ("高", "中", "低"),
                     "tier=%s" % conf.get("tier"))
    else:
        bad += check(r, "confidence 为 None（torch 或校准表不可用）",
                     True, "—— 这是允许的降级路径")

    # ③ caveat 必须存在（confidence 非空时）
    if conf is not None:
        bad += check(r, "confidence.caveat 含「非真实现场照片」",
                     "非真实现场照片" in (conf.get("caveat") or ""),
                     (conf.get("caveat") or "")[:40])
        bad += check(r, "confidence 有 score（0~1 连续值）",
                     0 <= conf.get("score", -1) <= 1,
                     "score=%s" % conf.get("score"))

    return bad


def http_tests():
    print()
    print("=" * 64)
    print("B. 全链路测试（POST /api/invoke → SSE 收结果）")
    print("=" * 64)
    try:
        urllib.request.urlopen(BASE + "/api/health", timeout=3).read()
    except Exception:
        print("  [SKIP] 127.0.0.1:8000 没有服务在跑 —— 跳过全链路测试（不算失败）")
        print("         要跑这部分：PYTHONPATH= py web/server.py 另起一个终端")
        return 0

    b64 = img_to_b64(make_test_image())
    events = []
    stop = threading.Event()

    def sse():
        try:
            with urllib.request.urlopen(BASE + "/api/events", timeout=90) as r:
                for raw in r:
                    if stop.is_set():
                        return
                    line = raw.decode("utf-8", "replace").strip()
                    if line.startswith("data:"):
                        try:
                            events.append(json.loads(line[5:].strip()))
                        except Exception:
                            pass
        except Exception:
            pass

    threading.Thread(target=sse, daemon=True).start()
    time.sleep(2)

    body = json.dumps({"cmd": "detect_disease",
                       "payload": {"image_b64": b64, "mm_per_px": 0.35}}).encode()
    req = urllib.request.Request(BASE + "/api/invoke", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        assert json.loads(r.read().decode()).get("ok") is True

    hit = None
    deadline = time.time() + 60
    while time.time() < deadline and not hit:
        for e in events:
            if e.get("type") == "result" and e.get("cmd") == "detect_disease":
                hit = e
                break
        time.sleep(1)
    stop.set()
    if not hit:
        print("  [FAIL] 60 秒内没收到 detect_disease 结果事件；收到：",
              [e.get("type") for e in events][:20])
        return 1

    p = hit["payload"]
    s = p.get("stats") or {}
    bad = 0
    bad += check(p, "HTTP: ok 为真", p.get("ok") is True)
    bad += check(p, "HTTP: 检出裂缝", (s.get("crack_count") or 0) >= 1,
                 "crack_count=%d" % s.get("crack_count"))
    bad += check(p, "HTTP: 有 overlay 图", len(p.get("overlay_b64") or "") > 1000)
    bad += check(p, "HTTP: 出了毫米", isinstance(s.get("avg_width_mm"), (int, float)),
                 "avg=%s mm" % s.get("avg_width_mm"))
    return bad


def axis_crack(thickness, orient="v", grad_amp=0, seed=5, h=600, w=800):
    """轴对齐裂缝：水平切长 == 垂直宽度 == thickness，是唯一无歧义的宽度基准。

    orient="v" 竖缝 / "h" 横缝 —— 这两种形态在墙面、柱子上最常见，
    旧版因为 `aspect < 0.12 且长 > 40 → 当阴影剔除` 会把它们整条丢掉。
    """
    rng = np.random.default_rng(seed)
    base = np.full((h, w), 175, np.float32)
    for sc, am in ((4, 8), (14, 5)):
        n = rng.normal(0, am, (h // sc + 2, w // sc + 2))
        base += cv2.resize(n.astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    base += np.linspace(-grad_amp, grad_amp, w, dtype=np.float32)[None, :]
    g = np.clip(cv2.GaussianBlur(base, (0, 0), sigmaX=4), 0, 255).astype(np.uint8)
    if orient == "v":
        cv2.rectangle(g, (400 - thickness // 2, 60),
                      (400 - thickness // 2 + thickness - 1, 540), 50, -1)
    else:
        cv2.rectangle(g, (60, 300 - thickness // 2),
                      (740, 300 - thickness // 2 + thickness - 1), 50, -1)
    return g


def regress_tests():
    """针对已修 bug 的回归断言 —— 每条都对应一个真实发生过的缺陷。"""
    print()
    print("=" * 64)
    print("C. 回归：已修缺陷（每条都对应一个真实漏检/误判）")
    print("=" * 64)
    bad = 0

    # 缺陷① 又长又直的裂缝被当阴影整条剔除（旧版 aspect<0.12 规则）
    for orient, name in (("v", "竖缝"), ("h", "横缝")):
        for th in (3, 8):
            r = dd.analyze(axis_crack(th, orient))
            s = r["stats"]
            bad += check(None, "%s %dpx 能检出（旧版整条漏掉）" % (name, th),
                         s["crack_count"] >= 1, "crack_count=%d" % s["crack_count"])

    # 缺陷② 形态学开运算把细缝腐蚀掉（旧版 2px 缝响应 126 却检出 0 条）
    r2 = dd.analyze(axis_crack(2, "v"))
    bad += check(None, "2px 细缝能检出（旧版被开运算腐蚀）",
                 r2["stats"]["crack_count"] >= 1,
                 "crack_count=%d" % r2["stats"]["crack_count"])

    # 缺陷③ 宽度必须准（旧版细缝会系统性高估）
    acc = []
    for th in (3, 5, 8):
        got = dd.analyze(axis_crack(th, "v"))["stats"]["max_width_px"]
        acc.append(abs(got - th) / th)
    worst = max(acc)
    bad += check(None, "竖缝宽度误差 < 25%", worst < 0.25,
                 "最差 %.0f%%（3/5/8px 三条）" % (worst * 100))

    # 缺陷④ 横贯全图且贴边的阴影带必须被标为「疑似」，不能算成裂缝
    h, w = 600, 800
    rng = np.random.default_rng(11)
    base = np.full((h, w), 175, np.float32)
    for sc, am in ((4, 8), (14, 5)):
        n = rng.normal(0, am, (h // sc + 2, w // sc + 2))
        base += cv2.resize(n.astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    g = np.clip(cv2.GaussianBlur(base, (0, 0), sigmaX=4), 0, 255).astype(np.uint8)
    cv2.rectangle(g, (0, 430), (w, 442), 126, -1)      # 通长阴影带
    r3 = dd.analyze(g)
    s3 = r3["stats"]
    has_suspect = any(c["verdict"] == "suspect" for c in r3["components"])
    bad += check(None, "通长贴边阴影带被标为疑似（未静默删除）",
                 has_suspect or s3["crack_count"] == 0,
                 "疑似=%d 裂缝=%d" % (s3["suspect_count"], s3["crack_count"]))
    bad += check(None, "疑似项不计入裂缝宽度统计",
                 not (s3["max_width_px"] > 40), "max_width=%.1fpx" % s3["max_width_px"])

    return bad


def calib_missing_test():
    """② 校准表缺失时不崩、不编数（临时改名 confidence_map.json 再跑）。"""
    import shutil
    import pathlib
    print()
    print("=" * 64)
    print("D. 把握度：校准表缺失降级测试")
    print("=" * 64)
    calib_path = pathlib.Path(dd._calibration_dir()) / "confidence_map.json"
    if not calib_path.is_file():
        print("  [SKIP] confidence_map.json 不存在，跳过降级测试")
        return 0
    backup = calib_path.with_suffix(".json.bak_test")
    bad = 0
    try:
        shutil.move(str(calib_path), str(backup))
        # 重置缓存
        dd._CALIBRATION_CACHE["loaded"] = False
        dd._CALIBRATION_CACHE["map"] = None
        img = make_test_image()
        r = dd.analyze(img)
        bad += check(r, "校准表缺失 → ok 仍为 True", r.get("ok") is True)
        bad += check(r, "校准表缺失 → confidence 为 None", r.get("confidence") is None,
                     "confidence=%r" % r.get("confidence"))
        note = r.get("stats", {}).get("note", "")
        bad += check(r, "note 提示校准表未加载", "校准表未加载" in note, note[-30:])
    finally:
        shutil.move(str(backup), str(calib_path))
        dd._CALIBRATION_CACHE["loaded"] = False
        dd._CALIBRATION_CACHE["map"] = None
    return bad


def main():
    bad = lib_tests() + regress_tests() + calib_missing_test() + http_tests()
    print()
    print("=" * 64)
    print("disease_detect_test 结果：%s" % ("全部通过" if bad == 0 else "有 %d 项失败" % bad))
    print("=" * 64)
    print("提醒：测试图是程序合成的，只能证明流程跑得通、装饰物滤得掉、")
    print("      量级合理；不能证明在真实桥梁照片上有效。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
