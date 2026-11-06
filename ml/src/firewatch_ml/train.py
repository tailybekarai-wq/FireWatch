"""Train, evaluate and package the model (ML_STRATEGY §4-§9).

Usage::

    python -m firewatch_ml.train            # reads data/ml/dataset.parquet

Splits are temporal: train 2019-2022, validation 2023 (early stopping, calibration,
thresholds), test 2024-2025 (evaluated once). Hyperparameters are chosen by GroupKFold
over 1-degree cells inside the training years. Confidence intervals: bootstrap over
approximate foci (1000 resamples). The gate of §8 decides ``active`` or ``rejected``.

Artifacts go to ``ml/models/<version>/``: model.txt, metadata.json (calibration,
thresholds, metrics, gate), feature_spec.json, evaluation.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

from firewatch_ml import features
from firewatch_ml.report import write_report
from firewatch_pipeline.run import REPO_ROOT, log

NAME = "firewatch-vegetation-fire"
VERSION = "1.0.0"
SEED = 20261106
DATASET = REPO_ROOT / "data/ml/dataset.parquet"
MODELS_DIR = REPO_ROOT / "ml/models"
TRAIN_YEARS, VAL_YEARS, TEST_YEARS = (2019, 2022), (2023, 2023), (2024, 2025)
TARGET_PRECISION = {"very_high": 0.9, "high": 0.75, "moderate": 0.5}
MIN_SUPPORT = 50
BOOTSTRAP = 1000
LOG_COLUMNS = ("frp_mw", "frp_5km_72h", *(c[0] for c in features.CONTEXT))
GRID = (
    {"num_leaves": 15, "min_child_samples": 100},
    {"num_leaves": 31, "min_child_samples": 100},
    {"num_leaves": 63, "min_child_samples": 200},
    {"num_leaves": 127, "min_child_samples": 500},
)
BASE_PARAMS: dict[str, Any] = {
    "objective": "binary",
    "learning_rate": 0.05,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "verbose": -1,
    "seed": SEED,
    "deterministic": True,
    "force_col_wise": True,
    "num_threads": 4,
}


class Calibrator:
    """Isotonic map stored as breakpoints; applied with np.interp (no sklearn at scoring)."""

    def __init__(self, x: list[float], y: list[float]) -> None:
        self.x, self.y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)

    @classmethod
    def fit(cls, p: np.ndarray, y: np.ndarray) -> Calibrator:
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(p, y)
        return cls(iso.X_thresholds_.tolist(), iso.y_thresholds_.tolist())

    def __call__(self, p: np.ndarray) -> np.ndarray:
        return np.asarray(np.interp(p, self.x, self.y), dtype=float)

    def to_json(self) -> dict[str, list[float]]:
        return {"x": self.x.round(8).tolist(), "y": self.y.round(8).tolist()}


def split(frame: pd.DataFrame, years: tuple[int, int]) -> pd.DataFrame:
    return frame[(frame["year"] >= years[0]) & (frame["year"] <= years[1])]


def lr_matrix(x: pd.DataFrame) -> np.ndarray:
    m = x.copy()
    for c in LOG_COLUMNS:
        m[c] = np.log1p(m[c])
    return np.asarray(m.to_numpy(dtype=float), dtype=float)


def scores(y: np.ndarray, p: np.ndarray, w: np.ndarray | None = None) -> dict[str, float]:
    return {
        "pr_auc": float(average_precision_score(y, p, sample_weight=w)),
        "roc_auc": float(roc_auc_score(y, p, sample_weight=w)),
        "brier": float(np.average((p - y) ** 2, weights=w)),
    }


def thresholds(p: np.ndarray, y: np.ndarray) -> dict[str, float | None]:
    """Lowest cutoff whose precision reaches each target (with >= MIN_SUPPORT objects)."""
    order = np.argsort(-p, kind="stable")
    ps, ys = p[order], y[order]
    k = np.arange(1, len(ps) + 1)
    precision = np.cumsum(ys) / k
    last_of_tie = np.r_[ps[1:] != ps[:-1], True]
    out: dict[str, float | None] = {}
    ceiling = np.inf
    for level, target in TARGET_PRECISION.items():
        ok = np.flatnonzero(last_of_tie & (precision >= target) & (k >= MIN_SUPPORT))
        cut = float(ps[ok[-1]]) if len(ok) else None
        if cut is not None and cut > ceiling:
            cut = None
        out[level] = cut
        if cut is not None:
            ceiling = cut
    return out


def risk_levels(p: np.ndarray, thr: dict[str, float | None]) -> np.ndarray:
    level = np.full(len(p), "low", dtype=object)
    for name in ("moderate", "high", "very_high"):
        cut = thr.get(name)
        if cut is not None:
            level[p >= cut] = name
    return level


def bootstrap(
    y: np.ndarray, groups: np.ndarray, models: dict[str, np.ndarray], rng: np.random.Generator
) -> dict[str, list[float]]:
    """Percentile CIs of each model's metrics and of the paired PR-AUC differences."""
    codes, uniq = pd.factorize(groups)
    n_groups = len(uniq)
    draws: dict[str, list[float]] = {}
    for _ in range(BOOTSTRAP):
        w = np.bincount(rng.integers(0, n_groups, n_groups), minlength=n_groups)[codes]
        keep = w > 0
        if y[keep].min() == y[keep].max():
            continue
        values = {name: scores(y[keep], p[keep], w[keep]) for name, p in models.items()}
        for name, metrics in values.items():
            for key, v in metrics.items():
                draws.setdefault(f"{name}.{key}", []).append(v)
        for other in ("baseline0", "baseline1"):
            draws.setdefault(f"diff_vs_{other}.pr_auc", []).append(
                values["lightgbm"]["pr_auc"] - values[other]["pr_auc"]
            )
    return {
        key: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]
        for key, v in draws.items()
    }


def git_sha() -> str:
    try:
        done = subprocess.run(
            ["git", "rev-parse", "HEAD"],  # noqa: S607
            capture_output=True,
            text=True,
            check=True,
            cwd=REPO_ROOT,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return done.stdout.strip()


def tune(train: pd.DataFrame, x: pd.DataFrame) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    y = train["label"].to_numpy(dtype=float)
    folds = list(GroupKFold(n_splits=5).split(x, y, groups=train["cell_1deg"]))
    results = []
    for grid in GRID:
        params = {**BASE_PARAMS, **grid}
        ap, rounds = [], []
        for fit_idx, hold_idx in folds:
            pos = y[fit_idx].sum()
            params["scale_pos_weight"] = (len(fit_idx) - pos) / max(pos, 1)
            booster = lgb.train(
                params,
                lgb.Dataset(x.iloc[fit_idx], y[fit_idx]),
                num_boost_round=2000,
                valid_sets=[lgb.Dataset(x.iloc[hold_idx], y[hold_idx])],
                callbacks=[lgb.early_stopping(100, verbose=False)],
            )
            ap.append(average_precision_score(y[hold_idx], booster.predict(x.iloc[hold_idx])))
            rounds.append(booster.best_iteration)
        result = {
            **grid,
            "cv_pr_auc": float(np.mean(ap)),
            "cv_pr_auc_std": float(np.std(ap)),
            "mean_rounds": float(np.mean(rounds)),
        }
        results.append(result)
        log("ml_cv", **result)
    best = max(results, key=lambda r: r["cv_pr_auc"])
    return {k: best[k] for k in GRID[0]}, results


def slice_metrics(
    test: pd.DataFrame, y: np.ndarray, test_p: dict[str, np.ndarray]
) -> dict[str, dict[str, Any]]:
    month = test["observed_at"].dt.month.to_numpy()
    season = np.select(
        [np.isin(month, (3, 4, 5)), np.isin(month, (6, 7, 8)), np.isin(month, (9, 10, 11))],
        ["spring", "summer", "autumn"],
        "winter",
    )
    out: dict[str, dict[str, Any]] = {}
    for name, key in (("daynight", test["daynight"].to_numpy()), ("season", season)):
        for value in np.unique(key):
            m = key == value
            if y[m].min() == y[m].max():
                continue
            out[f"{name}={value}"] = {
                "n": int(m.sum()),
                "positive_share": float(y[m].mean()),
                **{k: float(average_precision_score(y[m], p[m])) for k, p in test_p.items()},
            }
    return out


def level_table(
    p_val: np.ndarray,
    y_val: np.ndarray,
    p_test: np.ndarray,
    y_test: np.ndarray,
    thr: dict[str, float | None],
) -> dict[str, dict[str, Any]]:
    lv, lt = risk_levels(p_val, thr), risk_levels(p_test, thr)

    def share(levels: np.ndarray, y: np.ndarray, name: str) -> float | None:
        m = levels == name
        return float(y[m].mean()) if m.any() else None

    return {
        name: {
            "threshold": thr.get(name),
            "val_n": int((lv == name).sum()),
            "val_precision": share(lv, y_val, name),
            "test_n": int((lt == name).sum()),
            "test_precision": share(lt, y_test, name),
        }
        for name in ("very_high", "high", "moderate", "low")
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train and evaluate the FireWatch model")
    parser.add_argument("--dataset", type=Path, default=DATASET)
    args = parser.parse_args(argv)
    rng = np.random.default_rng(SEED)
    cols = list(features.FEATURES)

    full = pd.read_parquet(args.dataset)
    labelled = full[full["label"] >= 0]
    parts = {
        "train": split(labelled, TRAIN_YEARS),
        "val": split(labelled, VAL_YEARS),
        "test": split(labelled, TEST_YEARS),
    }
    xs = {k: v[cols] for k, v in parts.items()}
    ys = {k: v["label"].to_numpy(dtype=float) for k, v in parts.items()}
    log("ml_splits", **{k: len(v) for k, v in ys.items()})

    # Baseline 0: the FIRMS confidence level (calibrated on validation like every model).
    raw: dict[str, tuple[np.ndarray, np.ndarray]] = {
        "baseline0": (xs["val"]["confidence"].to_numpy(), xs["test"]["confidence"].to_numpy())
    }
    # Baseline 1: logistic regression on standardised, log-scaled features.
    scaler = StandardScaler().fit(lr_matrix(xs["train"]))
    lr = LogisticRegression(max_iter=5000).fit(
        scaler.transform(lr_matrix(xs["train"])), ys["train"]
    )
    raw["baseline1"] = tuple(
        lr.predict_proba(scaler.transform(lr_matrix(xs[k])))[:, 1] for k in ("val", "test")
    )
    # Random forest: comparison only (the pipeline scores LightGBM models).
    rf = RandomForestClassifier(
        n_estimators=300,
        min_samples_leaf=50,
        n_jobs=-1,
        random_state=SEED,
        class_weight="balanced_subsample",
    ).fit(xs["train"], ys["train"])
    raw["random_forest"] = tuple(rf.predict_proba(xs[k])[:, 1] for k in ("val", "test"))
    # Main candidate: LightGBM, early stopping on validation.
    best_grid, cv = tune(parts["train"], xs["train"])
    pos = ys["train"].sum()
    params = {**BASE_PARAMS, **best_grid, "scale_pos_weight": (len(ys["train"]) - pos) / pos}
    booster = lgb.train(
        params,
        lgb.Dataset(xs["train"], ys["train"]),
        num_boost_round=3000,
        valid_sets=[lgb.Dataset(xs["val"], ys["val"])],
        callbacks=[lgb.early_stopping(100, verbose=False)],
    )
    raw["lightgbm"] = tuple(  # type: ignore[assignment]
        booster.predict(xs[k], num_iteration=booster.best_iteration) for k in ("val", "test")
    )

    val_pr_auc = {k: float(average_precision_score(ys["val"], v[0])) for k, v in raw.items()}
    calibrators = {k: Calibrator.fit(v[0], ys["val"]) for k, v in raw.items()}
    test_p = {k: calibrators[k](v[1]) for k, v in raw.items()}
    val_p = calibrators["lightgbm"](raw["lightgbm"][0])
    thr = thresholds(val_p, ys["val"])

    test_metrics = {k: scores(ys["test"], p) for k, p in test_p.items()}
    ci = bootstrap(ys["test"], parts["test"]["focus"].to_numpy(), test_p, rng)
    slices = slice_metrics(parts["test"], ys["test"], test_p)
    best_val = max(val_pr_auc, key=val_pr_auc.__getitem__)
    gate = {
        "pr_auc_above_baselines": bool(
            ci["diff_vs_baseline0.pr_auc"][0] > 0 and ci["diff_vs_baseline1.pr_auc"][0] > 0
        ),
        "brier_not_worse_than_baseline1": bool(
            test_metrics["lightgbm"]["brier"] <= test_metrics["baseline1"]["brier"]
        ),
        "no_daynight_slice_below_baseline0": all(
            s["lightgbm"] >= s["baseline0"] for k, s in slices.items() if k.startswith("daynight")
        ),
        "lightgbm_best_on_validation": best_val == "lightgbm",
        "report_generated": True,
    }
    status = "active" if all(gate.values()) else "rejected"

    sample = xs["test"].iloc[:20000]
    contrib = booster.predict(sample, pred_contrib=True, num_iteration=booster.best_iteration)
    mean_abs = np.abs(np.asarray(contrib)[:, :-1]).mean(axis=0).round(5).tolist()
    importance = dict(sorted(zip(cols, mean_abs, strict=True), key=lambda kv: -kv[1]))
    calib = pd.DataFrame({"p": test_p["lightgbm"], "y": ys["test"]})
    calib["bin"] = pd.qcut(calib["p"], 10, duplicates="drop")
    calibration = (
        calib.groupby("bin", observed=True)
        .agg(n=("y", "size"), mean_p=("p", "mean"), observed=("y", "mean"))
        .reset_index(drop=True)
        .round(4)
    )

    out = MODELS_DIR / VERSION
    out.mkdir(parents=True, exist_ok=True)
    model_path = out / "model.txt"
    booster.save_model(model_path, num_iteration=booster.best_iteration)
    model_sha = hashlib.sha256(model_path.read_bytes()).hexdigest()
    dataset_info = json.loads((args.dataset.parent / "dataset.json").read_text(encoding="utf-8"))
    feature_spec = {
        "features": cols,
        "context_satellite": features.CONTEXT_SATELLITE,
        "context": [
            {
                "name": n,
                "radius_m": r,
                "lookback_h": lb.total_seconds() / 3600,
                "gap_h": g.total_seconds() / 3600,
            }
            for n, r, lb, g in (*features.CONTEXT, features.FRP_CONTEXT)
        ],
        "distance": "great circle on a sphere, R = 6371008.8 m",
        "scored_instrument": "VIIRS",
    }
    metadata: dict[str, Any] = {
        "name": NAME,
        "version": VERSION,
        "algorithm": "LightGBM (binary) + isotonic calibration",
        "status": status,
        "gate": gate,
        "trained_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_sha": git_sha(),
        "seed": SEED,
        "params": {**params, "best_iteration": booster.best_iteration},
        "calibration": calibrators["lightgbm"].to_json(),
        "thresholds": thr,
        "target_precision": TARGET_PRECISION,
        "splits": {
            "train": TRAIN_YEARS,
            "val": VAL_YEARS,
            "test": TEST_YEARS,
            "sizes": {k: len(v) for k, v in ys.items()},
            "positive_share": {k: float(v.mean()) for k, v in ys.items()},
        },
        "validation_pr_auc": val_pr_auc,
        "cv": cv,
        "test": test_metrics,
        "test_ci95": ci,
        "slices": slices,
        "levels": level_table(val_p, ys["val"], test_p["lightgbm"], ys["test"], thr),
        "importance": importance,
        "calibration_table": calibration.to_dict("records"),
        "dataset": dataset_info,
        "artifact": {"path": f"ml/models/{VERSION}/model.txt", "sha256": model_sha},
        "libraries": {
            "python": platform.python_version(),
            "lightgbm": lgb.__version__,
            "scikit-learn": sklearn.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
        },
    }
    (out / "feature_spec.json").write_text(json.dumps(feature_spec, indent=2), encoding="utf-8")
    (out / "metadata.json").write_text(
        json.dumps(metadata, indent=2, default=str), encoding="utf-8"
    )
    write_report(out / "evaluation.md", metadata, feature_spec)
    log(
        "ml_trained",
        version=VERSION,
        status=status,
        gate=gate,
        test_pr_auc=test_metrics["lightgbm"]["pr_auc"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
