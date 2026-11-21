"""Shared, versioned CFD decoding, splitting and masked evaluation.

CFD region IDs are not ordered by their population.  This policy uses label 2
as the positive class, label 1 as background, and ignores labels 3 and 4.
Sample 042 is excluded because its supplied annotation is misaligned.
"""
from collections import Counter
import hashlib
from io import BytesIO
import json
from pathlib import Path
import random

import cv2
import numpy as np
import scipy.io as sio


POLICY = "cfd_label2_ignore34_exclude042_v1"
METRIC_NAMES = ("iou", "dice", "precision", "recall")
EPS = 1e-7


def load_samples(data_dir):
    """Load paired CFD samples; fail closed on missing or malformed data."""
    root = Path(data_dir)
    annotations = sorted((root / "groundTruth").glob("*.mat"))
    if not annotations:
        raise ValueError("No CFD groundTruth/*.mat annotations found: %s" % root)
    samples = []
    for annotation_path in annotations:
        sample_id = annotation_path.stem
        if sample_id == "042":
            continue
        image_path = root / "image" / (sample_id + ".jpg")
        try:
            image_bytes = image_path.read_bytes()
            annotation_bytes = annotation_path.read_bytes()
        except OSError as exc:
            raise ValueError("%s: missing/unreadable image or annotation" % sample_id) from exc
        try:
            image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        except cv2.error as exc:
            raise ValueError("%s: image decoding failed" % sample_id) from exc
        if image is None or image.ndim != 2 or image.dtype != np.uint8:
            raise ValueError("%s: image must decode to a uint8 grayscale image" % sample_id)
        try:
            gt = sio.loadmat(BytesIO(annotation_bytes), squeeze_me=True,
                             struct_as_record=False)["groundTruth"]
            seg = np.asarray(gt.Segmentation)
        except (KeyError, AttributeError, TypeError, ValueError, OSError) as exc:
            raise ValueError("%s: invalid CFD annotation structure" % sample_id) from exc
        if seg.ndim != 2 or seg.shape != image.shape:
            raise ValueError("%s: annotation/image shape mismatch: %s versus %s"
                             % (sample_id, seg.shape, image.shape))
        values = np.unique(seg)
        if not np.isin(values, (1, 2, 3, 4)).all():
            raise ValueError("%s: unknown CFD labels: %s" % (sample_id, values.tolist()))
        valid = np.isin(seg, (1, 2))
        if not valid.any():
            raise ValueError("%s: no evaluable pixels under %s" % (sample_id, POLICY))
        samples.append(dict(
            id=sample_id, image=image, mask=(seg == 2).astype(np.float32),
            valid=valid.astype(np.bool_),
            image_sha256=hashlib.sha256(image_bytes).hexdigest(),
            annotation_sha256=hashlib.sha256(annotation_bytes).hexdigest(),
            labels=[int(value) for value in values],
        ))
    if not samples:
        raise ValueError("No usable CFD samples remain after exclusions")
    return samples


def dataset_manifest(samples):
    """Return stable metadata only; image arrays never enter the JSON digest."""
    return [dict(
        id=sample["id"],
        sha256=dict(image=sample["image_sha256"], annotation=sample["annotation_sha256"]),
        shape=[int(value) for value in sample["image"].shape],
        labels=[int(value) for value in sample["labels"]],
        ignored_pixels=int((~sample["valid"]).sum()),
        crack_pixels=int(((sample["mask"] > 0.5) & sample["valid"]).sum()),
    ) for sample in samples]


def manifest_digest(manifest):
    """SHA256 of the entire canonical manifest (supply no mutable fields)."""
    encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _check_names(names):
    names = list(names)
    if not names or any(not isinstance(name, str) or not name for name in names):
        raise ValueError("Sample IDs must be nonempty strings")
    if len(names) != len(set(names)):
        raise ValueError("Duplicate sample IDs")
    return names


def make_splits(names, folds=5, seed=20261026):
    """Preserve the original seeded shuffle and strided outer-fold strategy."""
    names = _check_names(names)
    if not isinstance(folds, int) or isinstance(folds, bool) or not 1 <= folds <= len(names):
        raise ValueError("folds must be an integer in [1, sample count]")
    indices = list(range(len(names)))
    random.Random(seed).shuffle(indices)
    if folds == 1:
        test_count = max(10, int(len(indices) * 0.15))
        val_count = max(10, int(len(indices) * 0.15))
        test_folds = [indices[:test_count]]
        forced_val = indices[test_count:test_count + val_count]
    else:
        test_folds = [indices[i::folds] for i in range(folds)]
        forced_val = None
    splits = []
    for fold, test_indices in enumerate(test_folds, start=1):
        test_set = set(test_indices)
        rest = [i for i in indices if i not in test_set]
        val_indices = (forced_val if forced_val is not None
                       else rest[:max(8, int(len(rest) * 0.15))])
        val_set = set(val_indices)
        train_indices = [i for i in rest if i not in val_set]
        splits.append(dict(fold=fold, train=[names[i] for i in train_indices],
                           val=[names[i] for i in val_indices],
                           test=[names[i] for i in test_indices]))
    validate_splits(splits, names, require_oof=folds > 1)
    return splits


def validate_splits(splits, names, require_oof=True):
    """Require per-fold partitions, disjoint outer tests and optional full OOF."""
    names = _check_names(names)
    universe = set(names)
    if not isinstance(splits, list) or not splits:
        raise ValueError("No splits supplied")
    tests = []
    for expected_fold, split in enumerate(splits, start=1):
        if not isinstance(split, dict) or split.get("fold") != expected_fold:
            raise ValueError("Fold IDs must be consecutive and one-based")
        groups = []
        for key in ("train", "val", "test"):
            members = split.get(key)
            if not isinstance(members, list) or not members:
                raise ValueError("Fold %d: empty/missing %s set" % (expected_fold, key))
            if any(not isinstance(member, str) for member in members):
                raise ValueError("Fold %d: invalid sample ID" % expected_fold)
            if len(members) != len(set(members)):
                raise ValueError("Fold %d: duplicate %s IDs" % (expected_fold, key))
            groups.append(set(members))
        train, val, test = groups
        if train & val or train & test or val & test:
            raise ValueError("Fold %d: train/val/test overlap" % expected_fold)
        if train | val | test != universe:
            raise ValueError("Fold %d: IDs do not partition the dataset" % expected_fold)
        tests.extend(split["test"])
    counts = Counter(tests)
    if any(count != 1 for count in counts.values()):
        raise ValueError("Outer test IDs overlap across folds")
    if require_oof and set(tests) != universe:
        raise ValueError("OOF test sets must cover every sample exactly once")
    return True


def _from_counts(tp, fp, fn):
    return dict(iou=tp / (tp + fp + fn + EPS),
                dice=2 * tp / (2 * tp + fp + fn + EPS),
                precision=tp / (tp + fp + EPS),
                recall=tp / (tp + fn + EPS),
                tp=int(tp), fp=int(fp), fn=int(fn))


def metrics(pred, gt, valid=None):
    """Per-image metrics within valid pixels; undefined/empty metrics are zero."""
    pred = np.asarray(pred, dtype=np.bool_)
    gt = np.asarray(gt, dtype=np.bool_)
    if pred.shape != gt.shape:
        raise ValueError("Prediction/ground-truth shape mismatch")
    if valid is None:
        valid = np.ones(gt.shape, dtype=np.bool_)
    else:
        valid = np.asarray(valid, dtype=np.bool_)
        if valid.shape != gt.shape:
            raise ValueError("Validity/ground-truth shape mismatch")
    tp = int((pred & gt & valid).sum())
    fp = int((pred & ~gt & valid).sum())
    fn = int((~pred & gt & valid).sum())
    return _from_counts(tp, fp, fn)


def aggregate(rows):
    """Macro mean/population std plus metrics from pooled TP/FP/FN counts."""
    rows = list(rows)
    if not rows:
        raise ValueError("Cannot aggregate empty metrics")
    mean = {key: float(np.mean([row[key] for row in rows])) for key in METRIC_NAMES}
    std = {key: float(np.std([row[key] for row in rows])) for key in METRIC_NAMES}
    micro = _from_counts(*(sum(int(row[key]) for row in rows) for key in ("tp", "fp", "fn")))
    return dict(mean=mean, std=std, micro=micro)
