# -*- coding: utf-8 -*-
"""CFD corrected protocol: label 2 positive, 1 negative, 3/4 ignored; 042 excluded.

Run: .venv-train/Scripts/python.exe -B train_crack_model.py --epochs 40 --jobs 3 --threads 4
Each outer fold selects its primary checkpoint on validation IoU only. The fixed
last epoch is a prespecified secondary result. Existing experiment files are never overwritten.
"""
import argparse
import hashlib
import json
import os
import platform
import random
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

from crack_data import (POLICY, aggregate, dataset_manifest, load_samples,
                        make_splits, manifest_digest, metrics, validate_splits)
from crack_model import CrackNet

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "crackforest"
OUT = ROOT / "output_crack_model_cfd_v2"
CROP = 192


class CropDS(Dataset):
    def __init__(self, samples, crop=CROP):
        self.samples, self.crop = samples, crop

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, i):
        s = self.samples[i]
        img, mask, valid = s["image"], s["mask"], s["valid"]
        h, w = img.shape
        c = self.crop
        if h < c or w < c:
            raise ValueError("Training image is smaller than the configured crop")
        y, x = random.randint(0, h-c), random.randint(0, w-c)
        a = img[y:y+c, x:x+c].astype(np.float32) / 255.0
        b = mask[y:y+c, x:x+c]
        v = valid[y:y+c, x:x+c]
        if random.random() < 0.5:
            a, b, v = a[:, ::-1], b[:, ::-1], v[:, ::-1]
        if random.random() < 0.5:
            a, b, v = a[::-1], b[::-1], v[::-1]
        k = random.randint(0, 3)
        if k:
            a, b, v = np.rot90(a, k), np.rot90(b, k), np.rot90(v, k)
        if random.random() < 0.7:
            a = np.clip(a * random.uniform(0.75, 1.3) + random.uniform(-0.12, 0.12), 0, 1)
        if random.random() < 0.3:
            a = np.clip(a + np.random.normal(0, 0.04, a.shape).astype(np.float32), 0, 1)
        return tuple(torch.from_numpy(np.ascontiguousarray(z, dtype=np.float32))[None]
                     for z in (a, b, v))


def bce_dice(logits, target, valid):
    """Ignored pixels contribute to neither loss nor gradient."""
    pixel_loss = F.binary_cross_entropy_with_logits(logits, target, reduction="none")
    bce = (pixel_loss * valid).sum() / valid.sum().clamp_min(1)
    p = torch.sigmoid(logits) * valid
    t = target * valid
    num = 2 * (p * t).sum(dim=(2, 3)) + 1e-6
    den = p.sum(dim=(2, 3)) + t.sum(dim=(2, 3)) + 1e-6
    has_valid = valid.sum(dim=(2, 3)) > 0
    dice = ((1-num/den) * has_valid).sum() / has_valid.sum().clamp_min(1)
    return 0.5 * bce + 0.5 * dice


@torch.no_grad()
def evaluate(model, samples, thr=0.5):
    model.eval()
    rows = []
    for s in samples:
        x = torch.from_numpy(s["image"].astype(np.float32) / 255.0)[None, None]
        pred = (torch.sigmoid(model(x))[0, 0].numpy() > thr)
        if pred.shape != s["mask"].shape:
            raise ValueError("Model output shape does not match the full image")
        rows.append(dict(id=s["id"], **metrics(pred, s["mask"] > 0.5, s["valid"])))
    return aggregate(rows), rows


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def setup_worker(threads):
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)


def train_fold(data_dir, run_dir, split, training, digest):
    seed = training["seed"] + split["fold"] - 1
    torch.manual_seed(seed)
    np.random.seed(seed)
    random.seed(seed)
    samples = {s["id"]: s for s in load_samples(data_dir)}
    tr, va, te = ([samples[i] for i in split[k]] for k in ("train", "val", "test"))
    model = CrackNet()
    opt = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=training["epochs"])
    dl = DataLoader(CropDS(tr), batch_size=8, shuffle=True, num_workers=0,
                    drop_last=len(tr) > 8)
    best_iou, best_state, best_epoch, history = -1.0, None, None, []
    t0 = time.perf_counter()
    f = split["fold"]
    print(f"fold{f}: train={len(tr)} val={len(va)} test={len(te)} seed={seed}", flush=True)
    for ep in range(1, training["epochs"]+1):
        model.train()
        total, seen = 0.0, 0
        for x, y, v in dl:
            opt.zero_grad(set_to_none=True)
            loss = bce_dice(model(x), y, v)
            loss.backward()
            opt.step()
            total += loss.item() * x.size(0)
            seen += x.size(0)
        sched.step()
        val, _ = evaluate(model, va, training["threshold"])
        score = val["mean"]["iou"]
        history.append(dict(epoch=ep, loss=total/max(1, seen), validation=val["mean"]))
        if score > best_iou:
            best_iou, best_epoch = score, ep
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        if ep == 1 or ep % 5 == 0:
            print(f"fold{f} ep{ep:02d} loss={total/max(1,seen):.4f} val_iou={score:.4f} elapsed={time.perf_counter()-t0:.0f}s", flush=True)
    run_dir = Path(run_dir)
    last_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
    output = dict(fold=f, seed=seed, best_epoch=best_epoch, best_val_iou=best_iou,
                  history=history, test={}, elapsed_seconds=time.perf_counter()-t0)
    for selection, state, epoch in (("best", best_state, best_epoch), ("last", last_state, training["epochs"])):
        model.load_state_dict(state)
        agg, rows = evaluate(model, te, training["threshold"])
        bundle = dict(schema_version=2, policy=POLICY, state_dict=state,
                      manifest_digest=digest, fold=f, selection=selection, epoch=epoch)
        torch.save(bundle, run_dir / f"fold{f}_{selection}.pt")
        output["test"][selection] = dict(aggregate=agg, per_image=rows)
        print(f"fold{f} {selection}: test_iou={agg['mean']['iou']:.6f}", flush=True)
    write_json(run_dir / f"fold{f}.json", output)
    return output


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--seed", type=int, default=20261026)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--run-dir", type=Path, default=OUT)
    args = ap.parse_args()
    if min(args.epochs, args.threads, args.jobs) < 1:
        ap.error("epochs, threads and jobs must be positive")
    samples = load_samples(DATA)
    names = [s["id"] for s in samples]
    splits = make_splits(names, args.folds, args.seed)
    validate_splits(splits, names, require_oof=args.folds > 1)
    if args.run_dir.exists() and any(args.run_dir.iterdir()):
        ap.error("run-dir must be empty; choose a new directory to preserve existing results")
    args.run_dir.mkdir(parents=True, exist_ok=True)
    training = dict(epochs=args.epochs, seed=args.seed, folds=args.folds, crop=CROP,
                    batch_size=8, threshold=0.5, threads_per_fold=args.threads, jobs=args.jobs,
                    primary_selection="best_validation_iou", secondary_selection="last_fixed_epoch",
                    optimizer="Adam(lr=0.001, weight_decay=0.0001)", scheduler="CosineAnnealingLR",
                    loss="0.5 masked BCE + 0.5 masked Dice")
    manifest = dict(schema_version=2, policy=POLICY, dataset=dataset_manifest(samples),
                    excluded={"042": "Image/annotation mismatch; original 042.seg refers to 039.jpg"},
                    splits=splits, training=training,
                    environment=dict(python=platform.python_version(), numpy=np.__version__,
                                     torch=torch.__version__, device="cpu"),
                    source_sha256={n: hashlib.sha256((ROOT/n).read_bytes()).hexdigest()
                                   for n in ("crack_data.py", "crack_model.py", "train_crack_model.py")})
    digest = manifest_digest(manifest)
    write_json(args.run_dir / "manifest.json", manifest)
    print(f"Protocol {POLICY}; images={len(samples)}; manifest={digest}; run={args.run_dir}", flush=True)
    results = []
    if args.jobs == 1:
        setup_worker(args.threads)
        for split in splits:
            results.append(train_fold(str(DATA), str(args.run_dir), split, training, digest))
    else:
        with ProcessPoolExecutor(max_workers=min(args.jobs, len(splits)),
                                 initializer=setup_worker, initargs=(args.threads,)) as pool:
            futs = [pool.submit(train_fold, str(DATA), str(args.run_dir), s, training, digest) for s in splits]
            for fut in as_completed(futs):
                results.append(fut.result())
    results.sort(key=lambda r: r["fold"])
    summary = dict(schema_version=2, policy=POLICY, manifest_digest=digest, n=sum(len(s["test"]) for s in splits),
                   params=sum(p.numel() for p in CrackNet().parameters()), receptive_field=CrackNet().receptive_field(),
                   epochs=args.epochs, selections={})
    for selection in ("best", "last"):
        rows = [r for fold in results for r in fold["test"][selection]["per_image"]]
        per_fold = [fold["test"][selection]["aggregate"]["mean"] for fold in results]
        summary["selections"][selection] = dict(aggregate=aggregate(rows), per_fold=per_fold,
            fold_std={k: float(np.std([r[k] for r in per_fold])) for k in per_fold[0]})
    write_json(args.run_dir / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
