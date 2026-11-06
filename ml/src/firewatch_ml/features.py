"""Model features (ML_STRATEGY §3), computed only from information available at time t.

The same definitions are implemented twice: here with a KD-tree for the training archive
and in SQL in ``firewatch_pipeline.score`` for the scheduled scoring. ``firewatch_ml.parity``
checks on real database rows that both give identical values.

Context ("neighbours") always means VIIRS NOAA-20 detections inside Kazakhstan: the model
is trained on that one satellite, so counting other satellites at inference would shift
the distribution.
"""

from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

R_MEAN_M = 6371008.8
CONTEXT_SATELLITE = "N20"

# (name, radius_m, lookback, gap): neighbours with t - lookback <= t_j < t - gap
CONTEXT = (
    ("n_1km_24h", 1000.0, timedelta(hours=24), timedelta(0)),
    ("n_1km_72h", 1000.0, timedelta(hours=72), timedelta(0)),
    ("n_5km_24h", 5000.0, timedelta(hours=24), timedelta(0)),
    ("n_5km_72h", 5000.0, timedelta(hours=72), timedelta(0)),
    ("persist_500m_365d", 500.0, timedelta(days=365), timedelta(days=30)),
)
FRP_CONTEXT = ("frp_5km_72h", 5000.0, timedelta(hours=72), timedelta(0))
MAX_RADIUS_M = 5000.0
MAX_LOOKBACK = timedelta(days=365)

SENSOR = (
    "frp_mw",
    "bright_ti4",
    "bright_ti5",
    "ti4_minus_ti5",
    "confidence",
    "is_night",
    "scan_km",
    "track_km",
    "solar_hour",
    "doy_sin",
    "doy_cos",
)
FEATURES = SENSOR + tuple(c[0] for c in CONTEXT) + (FRP_CONTEXT[0],)
CONFIDENCE_CODE = {"low": 0, "nominal": 1, "high": 2}


def sensor_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Per-detection values; ``frame`` has the columns of ``firewatch_ml.data.COLUMNS``."""
    t = frame["observed_at"].dt.tz_convert("UTC")
    hours = t.dt.hour + t.dt.minute / 60.0
    doy = 2 * np.pi * (t.dt.day_of_year - 1) / 365.25
    return pd.DataFrame(
        {
            "frp_mw": frame["frp_mw"].astype(float),
            "bright_ti4": frame["bright_main_k"].astype(float),
            "bright_ti5": frame["bright_aux_k"].astype(float),
            "ti4_minus_ti5": (frame["bright_main_k"] - frame["bright_aux_k"]).astype(float),
            "confidence": frame["confidence_level"].map(CONFIDENCE_CODE).astype(float),
            "is_night": (frame["daynight"] == "N").astype(float),
            "scan_km": frame["scan_km"].astype(float),
            "track_km": frame["track_km"].astype(float),
            "solar_hour": ((hours + frame["longitude"] / 15.0) % 24.0).astype(float),
            "doy_sin": np.sin(doy).astype(float),
            "doy_cos": np.cos(doy).astype(float),
        },
        index=frame.index,
    )


def _xyz(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    la, lo = np.radians(lat), np.radians(lon)
    return R_MEAN_M * np.column_stack(
        (np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la))
    )


def _chord(m: float) -> float:
    """Straight-line distance through the sphere for a great-circle distance of m metres."""
    return float(2 * R_MEAN_M * np.sin(m / (2 * R_MEAN_M)))


def _utc_ns(s: pd.Series) -> np.ndarray:
    utc = s.dt.tz_convert("UTC").dt.tz_localize(None)
    return np.asarray(utc.to_numpy(dtype="datetime64[ns]"), dtype="datetime64[ns]")


def _seconds(td: timedelta) -> np.timedelta64:
    return np.timedelta64(int(td.total_seconds()), "s")


def context_features(targets: pd.DataFrame, context: pd.DataFrame) -> pd.DataFrame:
    """Neighbour counts of each target among ``context`` rows (sorted by time) before it."""
    names = [*(c[0] for c in CONTEXT), FRP_CONTEXT[0]]
    out = np.zeros((len(targets), len(names)))
    if len(targets) and len(context):
        ctx_t = _utc_ns(context["observed_at"])
        ctx_xyz = _xyz(context["latitude"].to_numpy(), context["longitude"].to_numpy())
        ctx_frp = context["frp_mw"].to_numpy(dtype=float)
        tgt_t = _utc_ns(targets["observed_at"])
        tgt_xyz = _xyz(targets["latitude"].to_numpy(), targets["longitude"].to_numpy())
        month = tgt_t.astype("datetime64[M]")
        for m in np.unique(month):
            ti = np.flatnonzero(month == m)
            lo = int(np.searchsorted(ctx_t, tgt_t[ti].min() - _seconds(MAX_LOOKBACK), "left"))
            hi = int(np.searchsorted(ctx_t, tgt_t[ti].max(), "left"))
            if hi <= lo:
                continue
            tree = cKDTree(ctx_xyz[lo:hi])
            lists = tree.query_ball_point(tgt_xyz[ti], r=_chord(MAX_RADIUS_M) * (1 + 1e-9))
            lens = np.fromiter((len(x) for x in lists), dtype=np.int64, count=len(lists))
            if not lens.sum():
                continue
            pair_t = np.repeat(np.arange(len(ti)), lens)
            pair_c = np.concatenate([np.asarray(x, dtype=np.int64) for x in lists if x]) + lo
            dist = np.linalg.norm(tgt_xyz[ti][pair_t] - ctx_xyz[pair_c], axis=1)
            age = tgt_t[ti][pair_t] - ctx_t[pair_c]
            for k, (name, radius, lookback, gap) in enumerate((*CONTEXT, FRP_CONTEXT)):
                ok = (dist <= _chord(radius)) & (age <= _seconds(lookback)) & (age > _seconds(gap))
                weights = ctx_frp[pair_c][ok] if name == FRP_CONTEXT[0] else None
                out[ti, k] = np.bincount(pair_t[ok], weights=weights, minlength=len(ti))
    return pd.DataFrame(out, index=targets.index, columns=names)


def build(targets: pd.DataFrame, context: pd.DataFrame) -> pd.DataFrame:
    """Feature matrix in ``FEATURES`` order."""
    frame = pd.concat([sensor_features(targets), context_features(targets, context)], axis=1)
    return frame[list(FEATURES)]
