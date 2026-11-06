"""Feature and label geometry on synthetic points (never real or production data)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from firewatch_ml import features, labels

T0 = datetime(2025, 8, 10, 8, 30, tzinfo=UTC)
LAT0, LON0 = 48.0, 67.0
M_PER_DEG_LAT = 111_195.08  # sphere, R = 6371008.8 m


def _row(dt: timedelta, north_m: float, frp: float = 10.0) -> dict[str, object]:
    return {
        "observed_at": T0 - dt,
        "latitude": LAT0 + north_m / M_PER_DEG_LAT,
        "longitude": LON0,
        "bright_main_k": 330.0,
        "bright_aux_k": 290.0,
        "frp_mw": frp,
        "confidence_level": "nominal",
        "scan_km": 0.4,
        "track_km": 0.4,
        "daynight": "D",
        "satellite": "N20",
    }


def _frame(rows: list[dict[str, object]]) -> pd.DataFrame:
    frame = pd.DataFrame(rows)
    frame["observed_at"] = pd.to_datetime(frame["observed_at"], utc=True)
    return frame.sort_values("observed_at").reset_index(drop=True)


def test_context_windows_and_radii() -> None:
    target = _frame([_row(timedelta(0), 0.0)])
    context = _frame(
        [
            _row(timedelta(hours=10), 900.0, frp=5.0),  # 1 km / 24 h
            _row(timedelta(hours=10), 1100.0, frp=7.0),  # 5 km / 24 h only
            _row(timedelta(hours=50), 4900.0, frp=11.0),  # 5 km / 72 h only
            _row(timedelta(hours=80), 100.0),  # past 72 h, inside the 30-day gap
            _row(timedelta(days=40), 400.0),  # persistence
            _row(timedelta(days=40), 600.0),  # too far for persistence
            _row(timedelta(days=400), 0.0),  # older than a year
            _row(timedelta(0), 0.0),  # same instant: not "before"
            _row(-timedelta(hours=1), 0.0),  # future
        ]
    )
    got = features.context_features(target, context).iloc[0].to_dict()
    assert got == {
        "n_1km_24h": 1.0,
        "n_1km_72h": 1.0,
        "n_5km_24h": 2.0,
        "n_5km_72h": 3.0,
        "persist_500m_365d": 1.0,
        "frp_5km_72h": 23.0,
    }


def test_build_has_feature_order_and_sensor_values() -> None:
    target = _frame([_row(timedelta(0), 0.0)])
    x = features.build(target, target.iloc[:0])
    assert list(x.columns) == list(features.FEATURES)
    row = x.iloc[0]
    assert row["ti4_minus_ti5"] == 40.0
    assert row["confidence"] == 1.0
    assert row["is_night"] == 0.0
    # 08:30 UTC at 67 E -> 8.5 + 67 / 15 = 12.97 local solar hours
    assert abs(row["solar_hour"] - 12.9667) < 1e-3


def test_sinusoidal_tile_matches_modis_grid() -> None:
    h, v, row, col = labels.sinusoidal_pixel(np.array([45.0, 52.0]), np.array([60.5, 70.0]))
    assert (int(h[0]), int(v[0])) == (22, 4)
    assert (int(h[1]), int(v[1])) == (22, 3)
    assert row.min() >= 0
    assert row.max() < labels.PIXELS
    assert col.min() >= 0
    assert col.max() < labels.PIXELS
