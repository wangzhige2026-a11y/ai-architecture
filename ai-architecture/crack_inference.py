# -*- coding: utf-8 -*-
"""Local CrackNet application backend. No network, training, or output-file writes.

The bundled fixed fold-1 validation-selected checkpoint is a 43,265-parameter
experimental road-crack segmenter. Large images use full-resolution tiles with
16-pixel context, rather than shrinking away thin cracks.
"""
import base64
import binascii
import hashlib
import json
import math
import os
from pathlib import Path
import threading
import time

import cv2
import numpy as np

import disease_detect as dd

MODEL_DIR = Path(__file__).resolve().parent / 'models' / 'cracknet_cfd_v2'
POLICY = 'cfd_label2_ignore34_exclude042_v1'
PARAMS = 43265
MAX_PIXELS = 16_000_000
MAX_B64_LENGTH = 12 * 1024 * 1024
_MODEL_CACHE = {}
_LOAD_LOCK = threading.Lock()
_INFERENCE_LOCK = threading.Lock()


class ModelUnavailableError(RuntimeError):
    pass


def _scale(value):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError('比例尺必须是有限正数，单位 mm/px')
    try:
        value = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError('比例尺必须是有限正数，单位 mm/px') from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError('比例尺必须是有限正数，单位 mm/px')
    return value


def load_model(model_dir=None):
    """Load and cache a hash-checked, manifest-bound CPU checkpoint."""
    directory = Path(model_dir) if model_dir is not None else MODEL_DIR
    meta_path, weight_path = directory / 'model.json', directory / 'weights.pt'
    with _LOAD_LOCK:
        try:
            key = (str(directory.resolve()), meta_path.stat().st_mtime_ns,
                   weight_path.stat().st_mtime_ns, weight_path.stat().st_size)
        except OSError as exc:
            raise ModelUnavailableError('模型文件缺失，请恢复 models/cracknet_cfd_v2 后重试；也可选择规则方法') from exc
        if key in _MODEL_CACHE:
            return _MODEL_CACHE[key]
        try:
            metadata = json.loads(meta_path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            raise ModelUnavailableError('模型说明文件损坏，请恢复已验证的模型文件') from exc
        required = {'schema_version','name','params','policy','threshold','source_fold',
                    'selection','epoch','checkpoint_id','training_samples','weights_sha256','manifest_digest'}
        if not isinstance(metadata, dict) or not required <= set(metadata):
            raise ModelUnavailableError('模型说明文件缺少必要信息，拒绝加载')
        if (not isinstance(metadata['checkpoint_id'], str) or not metadata['checkpoint_id']
                or type(metadata['epoch']) is not int or metadata['epoch'] < 1
                or type(metadata['training_samples']) is not int or metadata['training_samples'] < 1
                or type(metadata['source_fold']) is not int):
            raise ModelUnavailableError('模型说明文件包含无效参数，拒绝加载')
        if (metadata.get('schema_version') != 1 or metadata.get('name') != 'CrackNet'
                or metadata.get('params') != PARAMS or metadata.get('policy') != POLICY
                or metadata.get('threshold') != 0.5 or metadata.get('source_fold') != 1
                or metadata.get('selection') != 'best'):
            raise ModelUnavailableError('模型版本或标注协议不匹配，拒绝加载')
        try:
            digest = hashlib.sha256(weight_path.read_bytes()).hexdigest()
        except OSError as exc:
            raise ModelUnavailableError('无法读取模型权重') from exc
        if digest != metadata.get('weights_sha256'):
            raise ModelUnavailableError('模型权重校验失败，拒绝使用已变更的权重')
        try:
            import torch
            from crack_model import CrackNet
        except ImportError as exc:
            raise ImportError('CrackNet 需要可选 torch 依赖；请使用项目内 .venv-train 环境，或选择规则方法') from exc
        try:
            bundle = torch.load(weight_path, map_location='cpu', weights_only=True)
            if (bundle.get('schema_version') != 2 or bundle.get('policy') != POLICY
                    or bundle.get('manifest_digest') != metadata.get('manifest_digest')
                    or bundle.get('fold') != 1 or bundle.get('selection') != 'best'
                    or bundle.get('epoch') != metadata.get('epoch')):
                raise ValueError('checkpoint provenance mismatch')
            model = CrackNet()
            model.load_state_dict(bundle['state_dict'], strict=True)
            if sum(p.numel() for p in model.parameters()) != PARAMS:
                raise ValueError('parameter count mismatch')
            model.eval()
            torch.set_num_threads(min(4, os.cpu_count() or 1))
        except Exception as exc:
            raise ModelUnavailableError('模型权重格式或来源不匹配，拒绝加载') from exc
        _MODEL_CACHE.clear()
        _MODEL_CACHE[key] = (model, metadata)
        return model, metadata


def predict_probability(gray, model=None, core_size=512, halo=16):
    """Predict at original resolution; tile halos cover the 33px receptive field."""
    import torch
    if not isinstance(gray, np.ndarray) or gray.ndim != 2 or gray.dtype != np.uint8:
        raise ValueError('模型输入必须为 uint8 灰度图')
    if not gray.size or gray.size > MAX_PIXELS:
        raise ValueError('图片尺寸无效或超过1600万像素，请裁剪待检测区域')
    if type(core_size) is not int or not 32 <= core_size <= 1024 or type(halo) is not int or halo < 16:
        raise ValueError('分块尺寸或上下文范围无效')
    if model is None:
        model, _ = load_model()
    h, w = gray.shape
    probability = np.empty((h, w), np.float32)
    with _INFERENCE_LOCK, torch.inference_mode():
        model.eval()
        for y in range(0, h, core_size):
            y_end = min(h, y + core_size)
            ya, yb = max(0, y - halo), min(h, y_end + halo)
            for x in range(0, w, core_size):
                x_end = min(w, x + core_size)
                xa, xb = max(0, x - halo), min(w, x_end + halo)
                patch = np.ascontiguousarray(gray[ya:yb, xa:xb], dtype=np.float32) / 255.0
                tensor = torch.from_numpy(patch)[None, None]
                pred = torch.sigmoid(model(tensor))[0, 0].cpu().numpy()
                if pred.shape != patch.shape or not np.isfinite(pred).all():
                    raise ModelUnavailableError('模型返回了无效的像素预测')
                probability[y:y_end, x:x_end] = pred[y-ya:y_end-ya, x-xa:x_end-xa]
    return probability


def _summarize(gray, mask, mm_per_px, probability=None,
               min_area=25, min_elongation=2.5, min_extent=20):
    n, labels, cc, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    components = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in cc[i])
        # ① 面积门槛：滤掉孤立噪点（阈值与 disease_detect 一致）
        if area < min_area:
            continue
        bw_len = max(w, h)
        short_len = max(1, min(w, h))
        fill = area / float(w * h) if w * h else 0.0
        elong = bw_len / float(short_len)
        # ② 小而圆的实心斑点 → 麻点 / 锈斑，不是裂缝
        if fill > 0.92 and bw_len < 6:
            continue
        # ③ 不够细长、也不够长 → 碎片。
        #    ⚠️ 必须用 and：两个条件同时不满足才滤。
        #    用 or / 或拿 min_extent 当填充率会把细裂缝全部滤掉 ——
        #    细缝 fill 天然很低（2px 宽 200px 长的线 fill≈0.04），
        #    而细裂缝恰恰是早期预警最该报的。这是严重缺陷。
        if elong < min_elongation and bw_len < min_extent:
            continue
        components.append(dict(x=x, y=y, w=w, h=h, area_px=area,
            fill_ratio=round(fill, 3), elongation=round(elong, 2),
            verdict='crack', reason='',
            touches_border=bool(x==0 or y==0 or x+w==gray.shape[1] or y+h==gray.shape[0])))
    skeleton = dd.zhang_suen(mask)
    core = skeleton > 0
    skel_len = int(core.sum())
    area = int((mask > 0).sum())
    endpoint = branch = segment_count = 0
    if skel_len:
        thin = core.astype(np.uint8)
        neighbors = cv2.filter2D(thin, -1, np.ones((3,3), np.uint8), borderType=cv2.BORDER_CONSTANT) - thin
        endpoint = int((core & (neighbors == 1)).sum())
        branch = int((core & (neighbors >= 3)).sum())
        segments = (core & (neighbors < 3)).astype(np.uint8)
        _, _, sc, _ = cv2.connectedComponentsWithStats(segments, connectivity=8)
        segment_count = int(sum(int(s[cv2.CC_STAT_AREA]) >= 4 for s in sc[1:]))
    average_width = area/float(skel_len) if skel_len else 0.0

    # 用 CrackNet 概率图算该连通域的平均把握度（无概率图则 0.5）
    def _conf(comp):
        if probability is None:
            return 0.5
        y0, y1 = comp['y'], comp['y'] + comp['h']
        x0, x1 = comp['x'], comp['x'] + comp['w']
        patch = probability[y0:y1, x0:x1]
        sub_mask = mask[y0:y1, x0:x1] > 0
        if not sub_mask.any():
            return 0.5
        return float(patch[sub_mask].mean())

    # 公共函数补齐 id/center/length/width/severity（与规则路径同口径）
    components, extra = dd.finalize_crack_components(
        components, mask, segment_count, conf_resolver=_conf)

    # 把握度字段：CrackNet 概率图均值，未经校准（calibrated_prob 留 None，不编数）
    for c in components:
        conf_value = float(_conf(c))
        c['confidence'] = {
            'score': round(conf_value, 4),
            'tier': '高' if conf_value >= 0.7 else ('中' if conf_value >= 0.4 else '低'),
            'calibrated_prob': None,
            'tier_note': 'CrackNet 概率图均值，未经校准',
        }

    # max_width 只在过滤后的裂缝上算（与 disease_detect 口径一致）
    max_width = float(max((c['width_px'] for c in components), default=0.0))

    stats = dict(image_size_px=[int(gray.shape[1]), int(gray.shape[0])],
        crack_pixel_ratio=round(area/float(gray.size), 5), connected_domains=n-1,
        crack_count=len(components), suspect_count=None, crack_segment_count=segment_count,
        skeleton_length_px=skel_len, crack_area_px=area, avg_width_px=round(average_width,3),
        max_width_px=round(max_width,3),
        width_unit='px（未提供比例尺，不换算毫米）',
        note='像素掩膜由CrackNet预测；connected_domains 是过滤前的全部连通域数，'
             'crack_count 是通过面积/细长比/填充度三重过滤后的裂缝条数（与清单长度一致）。'
             '连通域与骨架段数是估计，不代表真实裂缝条数。'
             '平均宽度为面积除以骨架像素长度，max_width_px为各连通域平均宽度中的最大值，均非局部最大实测宽度。'
             '已完成公开桥面图块的图级测试，仍存在误报和漏检；现场照片及毫米量测精度仍需复核。')
    stats.update(extra)
    if mm_per_px is not None:
        stats.update(mm_per_px=mm_per_px, avg_width_mm=round(average_width*mm_per_px,3),
                     max_width_mm=round(max_width*mm_per_px,3), width_unit='mm')
    intermediate = dict(resize_scale=1.0, work_size=stats['image_size_px'],
        components_before_filter=n-1, components_after_filter=len(components), components_crack=len(components),
        skeleton_endpoints=endpoint, skeleton_branch_points=branch, crack_segments=segment_count,
        inference_threshold=0.5, tile_core_px=512, context_halo_px=16)
    return stats, intermediate, components


def analyze(image, mm_per_px=None):
    scale = _scale(mm_per_px)
    if not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.size == 0:
        return dict(ok=False, error='图片解码失败：需要有效的8位图片')
    if image.ndim == 2:
        gray = image
    elif image.ndim == 3 and image.shape[2] == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        return dict(ok=False, error='图片必须是灰度或RGB照片')
    if gray.size > MAX_PIXELS:
        return dict(ok=False, error='图片超过1600万像素，请裁剪待检测区域后重试')
    started = time.perf_counter()
    model, metadata = load_model()
    probability = predict_probability(gray, model=model)
    mask = (probability > metadata['threshold']).astype(np.uint8) * 255
    stats, intermediate, components = _summarize(gray, mask, scale, probability=probability)
    intermediate['inference_seconds'] = round(time.perf_counter()-started, 3)
    info = {key: metadata[key] for key in ('name','params','checkpoint_id','threshold','policy','source_fold','training_samples')}
    info.update(validation_scope='CFD路面分割与SDNET桥面图级测试；现场照片需复核', device='cpu')
    return dict(ok=True, engine='cracknet', model_info=info, stats=stats,
        intermediate=intermediate, components=components,
        overlay_b64=dd.encode_image_b64(dd.make_overlay(gray, mask)),
        mask_b64=dd.encode_image_b64(mask), mask_crack_b64=dd.encode_image_b64(mask))


def analyze_b64(image_b64, mm_per_px=None):
    if not isinstance(image_b64, str) or not image_b64 or len(image_b64) > MAX_B64_LENGTH:
        return dict(ok=False, error='图片数据为空或超过8MB文件限制')
    encoded = image_b64
    if encoded.startswith('data:'):
        header, separator, encoded = encoded.partition(',')
        if not separator or not header.startswith('data:image/') or ';base64' not in header:
            return dict(ok=False, error='图片数据格式无效')
    try:
        raw = base64.b64decode(encoded, validate=True)
        if not raw:
            raise ValueError('empty bytes')
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    except (ValueError, binascii.Error, cv2.error):
        return dict(ok=False, error='图片解码失败：请确认是有效的base64图片')
    if image is None:
        return dict(ok=False, error='图片解码失败：不是有效图片')
    return analyze(image, mm_per_px=mm_per_px)