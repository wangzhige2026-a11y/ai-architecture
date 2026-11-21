# -*- coding: utf-8 -*-
"""
disease_detect.py —— 混凝土结构表面病害检测（裂缝）

定位：知筑项目里的「结构病害检测」能力模块。**只做裂缝这一类病害。**

设计原则（与项目整体风格一致）：
  - 不引入新框架，只用 numpy + opencv（已进 requirements.txt）
  - 每一步可解释：中间量全部回传，能逐条核对
  - 不编造：没有比例尺就不给毫米；交叉裂缝合并就明说条数是下限
  - 纯函数、无副作用、无网络、无落盘 —— 方便被 python_bridge 的 handler 调用

处理流程：
  灰度 → 归一化尺寸 → 双边滤波去噪
    → 黑帽变换（深色裂缝的标准反差增强）
    → Otsu 自适应阈值
    → 形态学开/闭运算
    → 连通域 + 形状过滤（面积 / 填充率 / 长宽比 / 细长度）
    → Zhang-Suen 细化取骨架
    → 宽度 = 面积 / 骨架长度
"""

import base64
import json
import math
import os

import cv2
import numpy as np

MAX_SIDE = 1200

# ---- 把握度校准（2026-11-18）------------------------------------------
# 校准表路径：output_calibration_20261118/confidence_map.json
# 加载后缓存；文件不存在时 confidence 字段为 None，不编数。
_CALIBRATION_CACHE = {"loaded": False, "map": None}
_CRACKNET_CACHE = {"loaded": False, "model": None, "available": False}


def _calibration_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "output_calibration_20261118")


def _load_calibration():
    """加载把握度映射表。缺失时返回 None（不编数）。"""
    if _CALIBRATION_CACHE["loaded"]:
        return _CALIBRATION_CACHE["map"]
    _CALIBRATION_CACHE["loaded"] = True
    path = os.path.join(_calibration_dir(), "confidence_map.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            _CALIBRATION_CACHE["map"] = json.load(fh)
    except (OSError, ValueError):
        _CALIBRATION_CACHE["map"] = None
    return _CALIBRATION_CACHE["map"]


def _load_cracknet():
    """懒加载 CrackNet。torch 不可用时返回 None。"""
    if _CRACKNET_CACHE["loaded"]:
        return _CRACKNET_CACHE["model"] if _CRACKNET_CACHE["available"] else None
    _CRACKNET_CACHE["loaded"] = True
    try:
        import torch
        from crack_model import CrackNet
        import crack_inference
        model, _ = crack_inference.load_model()
        _CRACKNET_CACHE["model"] = model
        _CRACKNET_CACHE["available"] = True
        return model
    except Exception:
        _CRACKNET_CACHE["available"] = False
        return None


def _cracknet_score_from_prob(prob):
    """mean of top 1% sigmoid — 与校准时的口径一致。"""
    n = max(1, math.ceil(prob.size * 0.01))
    return float(np.partition(prob.ravel(), prob.size - n)[-n:].mean())


def _tier_for_score(score, calib):
    """根据校准表把分数映射到三档。返回 (tier, tier_note, calibrated_prob)。"""
    for t in calib.get("tiers", []):
        lo, hi = t["score_range"]
        if lo <= score <= hi:
            return t["tier"], t["note"], t.get("actual_positive_rate")
    # 超出范围时取最近档
    tiers = calib.get("tiers", [])
    if tiers:
        best = min(tiers, key=lambda t: min(abs(score - t["score_range"][0]),
                                            abs(score - t["score_range"][1])))
        return best["tier"], best["note"], best.get("actual_positive_rate")
    return "中", "可能有裂缝，需要人看", None


# ---------------------------------------------------------------- 文件读写
# ⚠️ Windows 上 cv2.imread / cv2.imwrite 遇到含中文的绝对路径会静默失败
#    （返回 None / 写不出文件）。统一走 numpy 字节中转。
def imread_uni(path, flags=cv2.IMREAD_COLOR):
    try:
        data = np.fromfile(path, dtype=np.uint8)
    except Exception:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, flags)


def imwrite_uni(path, img):
    ext = path.rsplit(".", 1)[-1] if "." in path else "png"
    ok, buf = cv2.imencode("." + ext, img)
    if not ok:
        return False
    buf.tofile(path)
    return True


# ---------------------------------------------------------------- 图像解码
def decode_image_b64(image_b64):
    """接受 'data:image/png;base64,xxxx' 或纯 base64，返回 BGR ndarray 或 None。"""
    if not image_b64:
        return None
    s = str(image_b64)
    if "," in s and s[:5] == "data:":
        s = s.split(",", 1)[1]
    try:
        raw = base64.b64decode(s)
    except Exception:
        return None
    if not raw:
        return None
    arr = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def encode_image_b64(img, ext=".png"):
    ok, buf = cv2.imencode(ext, img)
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode("ascii")


# ---------------------------------------------------------------- 细化
def _thin_step_mask(img, step):
    """Zhang-Suen 单步可删点集合（向量化，避免 Python 双层循环跑不动）"""
    h, w = img.shape
    P = np.pad(img, 1, mode="constant")
    p2 = P[0:h,     1:w + 1]   # 上
    p3 = P[0:h,     2:w + 2]   # 右上
    p4 = P[1:h + 1, 2:w + 2]   # 右
    p5 = P[2:h + 2, 2:w + 2]   # 右下
    p6 = P[2:h + 2, 1:w + 1]   # 下
    p7 = P[2:h + 2, 0:w]       # 左下
    p8 = P[1:h + 1, 0:w]       # 左
    p9 = P[0:h,     0:w]       # 左上
    ps = (p2, p3, p4, p5, p6, p7, p8, p9)

    B = ps[0] + ps[1] + ps[2] + ps[3] + ps[4] + ps[5] + ps[6] + ps[7]
    A = np.zeros((h, w), np.uint8)
    for i in range(8):
        A += ((ps[i] == 0) & (ps[(i + 1) % 8] == 1)).astype(np.uint8)

    cond = (img == 1) & (B >= 2) & (B <= 6) & (A == 1)
    if step == 0:
        cond &= (p4 * p6 * p8 == 0)
        cond &= (p2 * p4 * p6 == 0)
    else:
        cond &= (p2 * p4 * p8 == 0)
        cond &= (p2 * p6 * p8 == 0)
    return cond


def zhang_suen(binary):
    """Zhang-Suen 细化 → 1px 宽骨架。binary: 0/255 uint8 → 返回 0/255"""
    img = (binary > 0).astype(np.uint8)
    while True:
        m0 = _thin_step_mask(img, 0)
        if m0.any():
            img[m0] = 0
        m1 = _thin_step_mask(img, 1)
        if m1.any():
            img[m1] = 0
        if not (m0.any() or m1.any()):
            break
    return (img * 255).astype(np.uint8)


# ---------------------------------------------------------------- 主流程
def finalize_crack_components(comps, mask, seg_count, conf_resolver=None):
    """给 components 补齐 id / center_px / length_px / width_px /
    width_kind / severity / severity_score / severity_basis。

    两条检测路径（规则 disease_detect / CrackNet crack_inference）共用，
    保证严重度口径一致。权重 0.80*宽度百分位 + 0.10*长度百分位 + 0.10*把握度。

    参数:
        comps:         连通域列表（每条需有 x, y, w, h, area_px, verdict）
        mask:          裂缝二值掩膜（uint8，0/255），bbox 内像素用于骨架
        seg_count:     骨架段数（crack_count_best 的对照量）
        conf_resolver: 可选 fn(comp) -> float(0~1)；不传则读
                       comp["confidence"]["score"]，缺省 0.5

    返回:
        (comps, stats_increment)
        stats_increment 含 crack_count_lower / crack_count_upper /
        crack_count_best / crack_count_note / severity_summary / severity_method
    """
    crack_comps = [c for c in comps if c["verdict"] == "crack"]

    # 1) 逐条精细化：质心 / 骨架长度 / 代表宽度（估算上界）
    for c in comps:
        cx = int(c["x"] + c["w"] / 2)
        cy = int(c["y"] + c["h"] / 2)
        c["center_px"] = [cx, cy]
        if c["verdict"] != "crack":
            c["length_px"] = 0.0
            c["width_px"] = 0.0
            c["width_kind"] = "n/a"
            c["severity"] = "—"
            c["severity_score"] = 0.0
            c["severity_basis"] = "非裂缝候选"
            continue
        # 用 mask ∩ bbox 作为该条裂缝的实际像素
        y0, y1 = c["y"], c["y"] + c["h"]
        x0, x1 = c["x"], c["x"] + c["w"]
        patch = mask[y0:y1, x0:x1]
        local_skel = zhang_suen(patch)
        local_len = int((local_skel > 0).sum())
        local_area = c["area_px"]
        if local_len > 0:
            c["length_px"] = round(float(local_len), 1)
            c["width_px"] = round(float(local_area) / local_len, 1)
        else:
            c["length_px"] = round(float(local_area) ** 0.5, 1)  # 备用近似
            c["width_px"] = round(float(local_area) / max(1.0, c["length_px"]), 1)
        c["width_kind"] = "estimate_upper"  # 估算上界，不是真值

    # 2) 严重度：百分位排名（只在 crack 之间比），宽度主导
    if crack_comps:
        wlist = [c.get("width_px", 0) for c in crack_comps]
        llist = [c.get("length_px", 0) for c in crack_comps]
        w_arr = np.array(wlist)
        l_arr = np.array(llist)
        for c in crack_comps:
            w_pct = float((w_arr <= c["width_px"]).sum()) / len(w_arr) if len(w_arr) > 1 else 0.5
            l_pct = float((l_arr <= c["length_px"]).sum()) / len(l_arr) if len(l_arr) > 1 else 0.5
            if conf_resolver is not None:
                try:
                    conf_val = float(conf_resolver(c))
                except (TypeError, ValueError):
                    conf_val = 0.5
                if not conf_val:
                    conf_val = 0.5
            else:
                conf_val = (c.get("confidence") or {}).get("score", 0.5) or 0.5
            sev_score = round(0.80 * w_pct + 0.10 * l_pct + 0.10 * conf_val, 3)
            c["severity_score"] = sev_score
            if len(crack_comps) == 1:
                c["severity"] = "中"
                c["severity_basis"] = "仅 1 条，无法比较"
            elif sev_score >= 0.67:
                c["severity"] = "重"
            elif sev_score >= 0.33:
                c["severity"] = "中"
            else:
                c["severity"] = "轻"
            # severity_basis
            w_rank = int((w_arr > c["width_px"]).sum()) + 1
            l_rank = int((l_arr > c["length_px"]).sum()) + 1
            conf_pct = int(round(conf_val * 100))
            c["severity_basis"] = (
                f"宽度 {c['width_px']}px（本图第 {w_rank} 宽）· "
                f"长度 {int(c['length_px'])}px（本图第 {l_rank} 长）· 把握度 {conf_pct}%"
            )
        # 按严重度降序排列，分配 id；suspect 的 id 继续编号
        crack_sorted = sorted(crack_comps, key=lambda x: x.get("severity_score", 0), reverse=True)
        for idx, c in enumerate(crack_sorted, 1):
            c["id"] = idx
        suspect_sorted = [c for c in comps if c["verdict"] == "suspect"]
        for idx, c in enumerate(suspect_sorted, len(crack_sorted) + 1):
            c["id"] = idx

    # 3) stats 增量：条数估计 + 严重度分布
    crack_count = len(crack_comps)
    seg_count_val = int(seg_count)
    if crack_count == 0:
        best_cnt = 0
    elif seg_count_val == 0:
        best_cnt = crack_count
    else:
        ratio = seg_count_val / crack_count
        best_cnt = seg_count_val if 0.7 <= ratio <= 1.5 else crack_count
    sev_summary = {"重": 0, "中": 0, "轻": 0}
    for c in crack_comps:
        sev = c.get("severity", "中")
        if sev in sev_summary:
            sev_summary[sev] += 1
    stats_increment = {
        "crack_count_lower": crack_count,
        "crack_count_upper": seg_count_val,
        "crack_count_best": best_cnt,
        "crack_count_note": "估计值。交叉裂缝会被并成 1 个连通域（少算），断裂可能被拆成多段（多算）。",
        "severity_summary": sev_summary,
        "severity_method": "相对排序（本图内百分位）· 非规范定级",
    }
    return comps, stats_increment


def analyze(bgr, mm_per_px=None, min_area=25, min_elongation=2.5, min_extent=20):
    """对一张 BGR 图做裂缝检测。

    返回 dict：
      ok / error
      stats          —— 可对外的量化结果（含 note 说明边界）
      intermediate   —— 每一步的中间量（可逐条核对）
      components     —— 每个连通域的 bbox / 面积 / 形状参数
      overlay_b64    —— 原图 + 红掩膜 + 黄框（给人看的那张）
      mask_b64       —— 纯掩膜
    """
    if bgr is None:
        return {"ok": False, "error": "图片解码失败"}

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
    steps = {}

    # 归一化尺寸：不同相机/分辨率的照片尺度拉到一致
    h, w = gray.shape[:2]
    scale = 1.0
    if max(h, w) > MAX_SIDE:
        scale = MAX_SIDE / float(max(h, w))
        gray = cv2.resize(gray, (int(round(w * scale)), int(round(h * scale))),
                          interpolation=cv2.INTER_AREA)
    steps["resize_scale"] = round(scale, 4)
    steps["work_size"] = [int(gray.shape[1]), int(gray.shape[0])]

    # 去噪（双边滤波保边）
    den = cv2.bilateralFilter(gray, d=7, sigmaColor=45, sigmaSpace=45)

    # 黑帽：闭合结果 - 原图 → 把「比周围暗的细长结构」顶出来
    #
    # ⚠️ 核必须**大于**裂缝宽度，否则闭合填不满缝，响应会掉到 0（粗缝直接漏检）。
    #    实测 600×800 图上：核=11 时 12px 缝响应仅 1，核=15 时响应 129。
    #    但核也不能过大：核=23 会把裂缝和旁边的阴影带连成一片，反而误报。
    #
    # 双核策略（2026-11-20）：单核有上限，超过核宽的粗缝整体漏检。
    #    小核 k  → 找 2~k*0.9 px 的细缝
    #    大核 k2 → 找 k*0.3~k2*0.9 px 的粗缝
    #    两个黑帽各自 Otsu 二值化后 OR 合并 → 兼顾细缝和粗缝。
    k = max(9, int(round(min(gray.shape) * 0.02)) | 1)      # 小核（奇数）
    k2 = min(k * 3, int(round(min(gray.shape) * 0.06)) | 1)  # 大核（奇数，最多短边 6%）
    kernel_s = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    kernel_l = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k2, k2))
    blackhat_s = cv2.morphologyEx(den, cv2.MORPH_BLACKHAT, kernel_s)
    blackhat_l = cv2.morphologyEx(den, cv2.MORPH_BLACKHAT, kernel_l)
    steps["blackhat_kernel_px"] = int(k)
    steps["blackhat_kernel_large_px"] = int(k2)
    steps["blackhat_max"] = int(max(blackhat_s.max(), blackhat_l.max()))

    # 各自 Otsu 二值化。大核提高阈值 1.4 倍——
    # 大核对任何暗区都响应，不加权就淹没小核的结果；提阈值后只留下
    # 真正粗的暗缝（宽裂缝中心黑度高，响应强），噪声暗区被滤掉。
    t_s, bw_s = cv2.threshold(blackhat_s, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    t_l, bw_l = cv2.threshold(blackhat_l, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, bw_l = cv2.threshold(blackhat_l, int(t_l * 1.4), 255, cv2.THRESH_BINARY)
    # 大核只补小核没找到的区域——防止大核响应淹没细缝
    k_dilate = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    bw_s_dilated = cv2.dilate(bw_s, k_dilate, iterations=1)
    bw_l_supplement = cv2.bitwise_and(bw_l, cv2.bitwise_not(bw_s_dilated))
    bw = cv2.bitwise_or(bw_s, bw_l_supplement)
    steps["otsu_threshold_small"] = float(t_s)
    steps["otsu_threshold_large"] = float(t_l)
    steps["otsu_threshold_large_boosted"] = float(t_l * 1.4)
    steps["otsu_threshold"] = round(float(t_s), 2)
    steps["bw_pixels_small"] = int((bw_s > 0).sum())
    steps["bw_pixels_large"] = int((bw_l > 0).sum())
    steps["bw_pixels_large_supplement"] = int((bw_l_supplement > 0).sum())
    steps["bw_pixels_merged"] = int((bw > 0).sum())

    # 形态学清理
    #
    # ⚠️ 这里**不能做开运算**。旧版用 3×3 椭圆核做 open 去斑点，结果是：
    #    任何比 3px 还细的裂缝会被整条腐蚀掉（2px 缝响应 126 却检出 0 条）。
    #    现在改为「不做 open，靠后面的连通域面积过滤去斑点」——
    #    面积过滤同样能去掉麻点，但不会破坏细缝的连续性。
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    closed = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, k3, iterations=1)

    # 连通域 + 形状过滤
    n, labels, stats_cc, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    keep = np.zeros_like(closed)          # 裂缝 + 疑似（用于显示）
    keep_crack = np.zeros_like(closed)    # 仅裂缝（用于统计，避免阴影带污染宽度）
    suspect_mask = np.zeros_like(closed)
    comps = []

    def _touches(size, start, length, tol=1):
        return start <= tol or (start + length) >= (size - tol)

    for i in range(1, n):
        x, y, cw, ch, area = [int(v) for v in stats_cc[i]]
        if area < min_area:
            continue
        bw_len = max(cw, ch)
        short_len = max(1, min(cw, ch))
        fill = area / float(cw * ch) if cw * ch else 0.0
        elongation = bw_len / float(short_len)

        # ① 小而圆的实心斑点 → 麻点 / 锈斑。不是裂缝，也没必要上报。
        if fill > 0.92 and bw_len < 6:
            continue
        # ② 不够细长、也不够长 → 碎片。
        if elongation < min_elongation and bw_len < min_extent:
            continue

        # ③ 剩下的**不丢弃**，改为「判读 + 标记」，交给人复核。
        #
        #   旧版这里有一条 `aspect < 0.12 且长边 > 40 → 当阴影剔除`，
        #   它会把「任何又长又直的裂缝」整条丢掉 —— 垂直 / 水平裂缝在墙面和
        #   柱子上恰恰是最常见的形态，等于系统性漏报。这是严重缺陷，已移除。
        #   现在只做标记，条目照样保留并计数，是否采信由人判断。
        reasons = []
        if (cw >= 0.85 * gray.shape[1] and _touches(gray.shape[1], x, cw)) or \
           (ch >= 0.85 * gray.shape[0] and _touches(gray.shape[0], y, ch)):
            reasons.append("贯穿整幅且贴边，疑为阴影带或图像边界")
        if fill > 0.45 and elongation < 3.0:
            reasons.append("接近实心的块状，疑为污渍或修补面")

        verdict = "suspect" if reasons else "crack"
        comp_mask = (labels == i).astype(np.uint8) * 255
        keep = cv2.bitwise_or(keep, comp_mask)
        if verdict == "crack":
            keep_crack = cv2.bitwise_or(keep_crack, comp_mask)
        else:
            suspect_mask = cv2.bitwise_or(suspect_mask, comp_mask)

        comps.append({"x": x, "y": y, "w": cw, "h": ch, "area_px": int(area),
                      "fill_ratio": round(fill, 3), "elongation": round(elongation, 2),
                      "verdict": verdict,
                      "reason": "；".join(reasons),
                      "touches_border": bool(_touches(gray.shape[1], x, cw) or
                                             _touches(gray.shape[0], y, ch))})
    steps["components_before_filter"] = int(n - 1)
    steps["components_after_filter"] = len(comps)
    steps["components_crack"] = sum(1 for c in comps if c["verdict"] == "crack")
    steps["components_suspect"] = sum(1 for c in comps if c["verdict"] == "suspect")

    # 骨架 + 宽度估算（细长结构：宽 ≈ 面积 / 骨架长度）
    # 注意：宽度只在「判定为裂缝」的掩膜上算，否则一条横贯全图的阴影带
    #       会把最大宽度直接拉到几十像素，结果不可信。
    skeleton = zhang_suen(keep_crack)
    skel_len = int((skeleton > 0).sum())
    total_area = int((keep_crack > 0).sum())
    avg_w_px = (total_area / float(skel_len)) if skel_len else 0.0

    # 骨架拓扑：端点数 / 分支点数。
    #   一条独立裂缝 → 2 个端点；两条裂缝交叉 → 多出分支点。
    #   连通域会把交叉的裂缝并成 1 个，所以「连通域数」会低估裂缝条数 ——
    #   用拓扑量把它讲清楚，不假装数得准。
    ep = bp = seg_count = 0
    if skel_len:
        P = np.pad((skeleton > 0).astype(np.uint8), 1, mode="constant")
        hh, ww = skeleton.shape
        p2 = P[0:hh,     1:ww + 1]; p3 = P[0:hh,     2:ww + 2]; p4 = P[1:hh + 1, 2:ww + 2]
        p5 = P[2:hh + 2, 2:ww + 2]; p6 = P[2:hh + 2, 1:ww + 1]; p7 = P[2:hh + 2, 0:ww]
        p8 = P[1:hh + 1, 0:ww];     p9 = P[0:hh,     0:ww]
        nb = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
        core = (skeleton > 0)
        ep = int((core & (nb == 1)).sum())
        bp = int((core & (nb >= 3)).sum())
        # 交叉裂缝计数：去掉骨架分叉点后，剩下几段彼此不连的骨架，
        # 就近似是「几段裂缝」。比单看连通域数更接近真实条数。
        seg_core = (core & ~(nb >= 3)).astype(np.uint8)
        nn, _, sst, _ = cv2.connectedComponentsWithStats(seg_core, connectivity=8)
        seg_count = sum(1 for k in range(1, nn) if int(sst[k][4]) >= 4)
    steps["skeleton_endpoints"] = ep
    steps["skeleton_branch_points"] = bp
    steps["crack_segments"] = int(seg_count)

    n2, lab2, _, _ = cv2.connectedComponentsWithStats(keep_crack, connectivity=8)
    widths = []
    for i in range(1, n2):
        m = (lab2 == i)
        a = int(m.sum())
        sl = int(((skeleton > 0) & m).sum())
        if sl > 0:
            widths.append(float(a) / sl)
    max_w_px = float(max(widths)) if widths else 0.0

    # ---- 逐条精细化 + 严重度 + id（公共函数，crack_inference 同用）----
    crack_comps = [c for c in comps if c["verdict"] == "crack"]
    suspect_comps = [c for c in comps if c["verdict"] == "suspect"]
    comps, extra1 = finalize_crack_components(comps, keep_crack, seg_count)

    crack_count = extra1["crack_count_lower"]
    seg_count_val = int(seg_count)

    stats_out = {
        "image_size_px": [int(gray.shape[1]), int(gray.shape[0])],
        "crack_pixel_ratio": round(total_area / float(gray.shape[0] * gray.shape[1]), 5),
        "connected_domains": len(comps),
        "crack_count": crack_count,
        "suspect_count": len(suspect_comps),
        "crack_segment_count": seg_count_val,
        "skeleton_length_px": skel_len,
        "crack_area_px": total_area,
        "avg_width_px": round(avg_w_px, 3),
        "max_width_px": round(max_w_px, 3),
        # 新增：裂缝条数估计 + 严重度（公共函数产出，两条路径同口径）
        "crack_count_lower": extra1["crack_count_lower"],
        "crack_count_upper": extra1["crack_count_upper"],
        "crack_count_best": extra1["crack_count_best"],
        "crack_count_note": extra1["crack_count_note"],
        "severity_summary": extra1["severity_summary"],
        "severity_method": extra1["severity_method"],
        # 新增：宽度高估说明
        "width_overestimate_note": "像素宽度为估算上界。合成图标定：真实 2px 检出 3.0px(+51%)、真实 8px 检出 9.1px(+14%)。越细高估越狠。",
        # 黑帽核必须大于缝宽才能检出，所以本图存在一个「可检出宽度上限」。
        "detectable_width_upper_px": int(round(k2 * 0.9)),
        "note": ("crack_count 是「判定为裂缝的连通域数」。交叉裂缝会被并成一个域，"
                 "crack_segment_count（去掉分叉点后的骨架段数）通常更接近真实条数；"
                 "两者都只是估计，最终条数必须人看原图确认。"
                 "suspect_count 是被标为「疑为阴影带/污渍」的连通域，"
                 "已从裂缝统计和宽度计算中排除，但仍会标在图上供复核。"
                 "detectable_width_upper_px 是本图可检出的最大裂缝宽度（像素）："
                 "采用双核检测（小核找细缝 + 大核找粗缝），比它更宽的缝仍可能漏检。"),
    }
    if mm_per_px and mm_per_px > 0:
        stats_out["mm_per_px"] = float(mm_per_px)
        stats_out["avg_width_mm"] = round(avg_w_px * float(mm_per_px), 3)
        stats_out["max_width_mm"] = round(max_w_px * float(mm_per_px), 3)
        stats_out["width_unit"] = "mm"
    else:
        stats_out["width_unit"] = "px（未提供比例尺，不换算毫米）"

    # ---- 把握度（confidence）------------------------------------------
    # 校准表缺失 → confidence=None，不编数。
    # CrackNet 不可用 → confidence=None，note 说明。
    calib = _load_calibration()
    cracknet = _load_cracknet() if calib is not None else None

    confidence = None
    if calib is not None and cracknet is not None:
        import torch
        # CrackNet 推理（256×256 灰度，与校准口径一致）
        gray256 = cv2.resize(gray, (256, 256), interpolation=cv2.INTER_AREA)
        x = torch.from_numpy(
            np.ascontiguousarray(gray256.astype(np.float32) / 255.0)
        )[None, None]
        with torch.inference_mode():
            prob256 = torch.sigmoid(cracknet(x))[0, 0].cpu().numpy()

        img_score = _cracknet_score_from_prob(prob256)
        tier, tier_note, calib_prob = _tier_for_score(img_score, calib)

        # 每个连通域的局部把握度
        # 把 prob256 resize 回工作尺寸，取每个组件 bbox 内的均值
        prob_work = cv2.resize(prob256, (gray.shape[1], gray.shape[0]),
                               interpolation=cv2.INTER_LINEAR)
        for c in comps:
            x0, y0, cw, ch = c["x"], c["y"], c["w"], c["h"]
            patch = prob_work[y0:y0 + ch, x0:x0 + cw]
            local_score = float(patch.mean()) if patch.size > 0 else 0.0
            c_tier, c_note, c_prob = _tier_for_score(local_score, calib)
            c["confidence"] = {
                "score": round(local_score, 4),
                "tier": c_tier,
                "tier_note": c_note,
                "calibrated_prob": c_prob,
            }
        for c in comps:
            if "confidence" not in c:
                c["confidence"] = None

        confidence = {
            "score": round(img_score, 4),
            "tier": tier,
            "tier_note": tier_note,
            "calibrated_prob": calib_prob,
            "n_samples": calib.get("n_samples", 0),
            "caveat": calib.get("caveat", ""),
        }
    elif calib is not None and cracknet is None:
        stats_out["note"] = stats_out.get("note", "") + "；校准表已加载但 CrackNet 不可用（缺 torch），未输出把握度"
        for c in comps:
            c["confidence"] = None
    elif calib is None:
        stats_out["note"] = stats_out.get("note", "") + "；校准表未加载，未输出把握度"
        for c in comps:
            c["confidence"] = None

    # ---- 严重度重算（在 confidence 就绪后）----------------------------
    if crack_comps:
        comps, extra2 = finalize_crack_components(comps, keep_crack, seg_count)
        stats_out["severity_summary"] = extra2["severity_summary"]

    return {
        "ok": True,
        "stats": stats_out,
        "intermediate": steps,
        "components": comps,
        "overlay_b64": encode_image_b64(make_overlay(gray, keep_crack, suspect_mask, comps)),
        "mask_b64": encode_image_b64(keep),
        # 只含判定为裂缝的像素（不含"疑似"）——与分割模型做公平对比时用这个，
        # 否则把阴影带也算进预测，基线会被冤枉。
        "mask_crack_b64": encode_image_b64(keep_crack),
        "confidence": confidence,
    }


def make_overlay(gray, crack_mask, suspect_mask=None, comps=None):
    """灰度原图 + 按严重度染色的裂缝 + 直接标注编号/长宽。

    严重度颜色：重=红(0,0,255)、中=橙(0,165,255)、轻=黄(0,255,255)。
    每条裂缝旁边直接标注「#编号 宽x长」，不用再去表格里对。
    """
    overlay = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    # 按严重度给每条裂缝染不同颜色
    sev_colors = {"重": (0, 0, 255), "中": (0, 165, 255), "轻": (0, 255, 255)}
    if comps:
        for c in comps:
            if c.get("verdict") != "crack":
                continue
            color = sev_colors.get(c.get("severity", "中"), (0, 0, 255))
            x, y, cw, ch = c["x"], c["y"], c["w"], c["h"]
            pad = 2
            roi_y0, roi_y1 = max(0, y - pad), min(overlay.shape[0], y + ch + pad)
            roi_x0, roi_x1 = max(0, x - pad), min(overlay.shape[1], x + cw + pad)
            roi = overlay[roi_y0:roi_y1, roi_x0:roi_x1]
            if roi.size == 0:
                continue
            # 只在裂缝像素上染色
            mask_roi = crack_mask[roi_y0:roi_y1, roi_x0:roi_x1] > 0
            if mask_roi.any():
                roi[mask_roi] = (0.35 * roi[mask_roi] + 0.65 * np.array(color, dtype=np.float64)).astype(np.uint8)
    else:
        # 没有 comps 时全染红
        m = crack_mask > 0
        if m.any():
            overlay[m] = (0.35 * overlay[m] + 0.65 * np.array([0, 0, 255], dtype=np.float64)).astype(np.uint8)

    # 疑似项用紫框
    if suspect_mask is not None:
        n2, _, st2, _ = cv2.connectedComponentsWithStats(suspect_mask, connectivity=8)
        for i in range(1, n2):
            x, y, cw, ch, area = [int(v) for v in st2[i]]
            if area < 20:
                continue
            cv2.rectangle(overlay, (x, y), (x + cw, y + ch), (255, 0, 255), 1)

    # 逐条标注：编号 + 宽×长，放在裂缝质心旁边
    if comps:
        for c in comps:
            if c.get("verdict") != "crack":
                continue
            cx, cy = c.get("center_px", [c["x"] + c["w"] // 2, c["y"] + c["h"] // 2])
            cx, cy = int(cx), int(cy)
            idx = c.get("id", 0)
            if idx <= 0:
                continue
            sev = c.get("severity", "")
            color = sev_colors.get(sev, (0, 0, 255))
            w_px = c.get("width_px", 0)
            l_px = c.get("length_px", 0)
            label = f"#{idx} {w_px:.0f}x{l_px:.0f}px"
            # 标签背景（按严重度颜色）
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            lx, ly = cx - tw // 2, cy - th - 8
            lx = max(2, min(lx, overlay.shape[1] - tw - 4))
            ly = max(2, min(ly, overlay.shape[0] - th - 4))
            cv2.rectangle(overlay, (lx - 2, ly - 2), (lx + tw + 2, ly + th + 4), color, -1)
            cv2.putText(overlay, label, (lx, ly + th),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    return overlay


def analyze_b64(image_b64, mm_per_px=None):
    """便捷入口：base64 进，结果 dict 出（含 overlay_b64 / mask_b64）"""
    img = decode_image_b64(image_b64)
    if img is None:
        return {"ok": False, "error": "图片解码失败：请确认是 base64 编码的图片数据"}
    return analyze(img, mm_per_px=mm_per_px)
