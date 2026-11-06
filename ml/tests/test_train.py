"""Threshold and calibration helpers on synthetic scores."""

from __future__ import annotations

import numpy as np

from firewatch_ml import train


def test_thresholds_reach_target_precision_and_are_ordered() -> None:
    rng = np.random.default_rng(0)
    p = rng.random(5000)
    y = (rng.random(5000) < p).astype(float)  # calibrated by construction
    thr = train.thresholds(p, y)
    cuts = [thr["very_high"], thr["high"], thr["moderate"]]
    assert all(c is not None for c in cuts)
    assert cuts == sorted(cuts, reverse=True)  # type: ignore[type-var]
    for level, cut in thr.items():
        assert cut is not None
        assert y[p >= cut].mean() >= train.TARGET_PRECISION[level]


def test_unreachable_precision_gives_no_level() -> None:
    p = np.linspace(0, 1, 1000)
    y = np.zeros(1000)
    y[::4] = 1.0  # 25 % positives everywhere
    thr = train.thresholds(p, y)
    assert thr == {"very_high": None, "high": None, "moderate": None}
    assert set(train.risk_levels(p, thr)) == {"low"}


def test_calibrator_round_trip_is_monotone() -> None:
    rng = np.random.default_rng(1)
    p = rng.random(2000)
    y = (rng.random(2000) < p**2).astype(float)
    cal = train.Calibrator.fit(p, y)
    again = train.Calibrator(**cal.to_json())
    q = np.linspace(0, 1, 101)
    out = again(q)
    assert np.all(np.diff(out) >= -1e-12)
    assert np.allclose(out, cal(q), atol=1e-7)
