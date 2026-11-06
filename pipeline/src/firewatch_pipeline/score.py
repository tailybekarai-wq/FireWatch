"""Score recent VIIRS detections with the active model (ADR-6, ML_STRATEGY §9).

Nothing is scored while no model has status ``active``: the UI then shows FIRMS levels
only. The model file is the one registered in ``ml_model_versions``; it is loaded from
the repository checkout and its SHA-256 must match, and the registered feature list must
equal ``firewatch_ml.features.FEATURES``; otherwise scoring stops with an error.

Sensor features come from the shared ``firewatch_ml.features.sensor_features``; context
features are computed here in SQL with the same definitions as the KD-tree version used
for training (sphere distance, NOAA-20 context, windows strictly before t).
``firewatch_ml.parity`` compares both on real rows.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
import psycopg

from firewatch_ml import features

LOOKBACK = timedelta(days=7)
BATCH = 500
TOP_CONTRIBUTIONS = 5
DETAIL_COLUMNS = (
    "observed_at",
    "latitude",
    "longitude",
    "bright_main_k",
    "bright_aux_k",
    "frp_mw",
    "confidence_level",
    "scan_km",
    "track_km",
    "daynight",
    "satellite",
)

FEATURE_SQL = f"""
SELECT t.id, {", ".join("t." + c for c in DETAIL_COLUMNS)},
       n.n_1km_24h, n.n_1km_72h, n.n_5km_24h, n.n_5km_72h, n.persist_500m_365d, n.frp_5km_72h
FROM detections t
CROSS JOIN LATERAL (
    SELECT
        count(*) FILTER (WHERE c.d <= 1000 AND c.age <= interval '24 hours') AS n_1km_24h,
        count(*) FILTER (WHERE c.d <= 1000 AND c.age <= interval '72 hours') AS n_1km_72h,
        count(*) FILTER (WHERE c.d <= 5000 AND c.age <= interval '24 hours') AS n_5km_24h,
        count(*) FILTER (WHERE c.d <= 5000 AND c.age <= interval '72 hours') AS n_5km_72h,
        count(*) FILTER (WHERE c.d <= 500 AND c.age > interval '30 days') AS persist_500m_365d,
        coalesce(sum(c.frp_mw) FILTER (WHERE c.d <= 5000 AND c.age <= interval '72 hours'), 0)
            AS frp_5km_72h
    FROM (
        SELECT t.observed_at - o.observed_at AS age, o.frp_mw,
               ST_Distance(o.geom::geography, t.geom::geography, false) AS d
        FROM detections o
        WHERE o.satellite = %(satellite)s
          AND o.observed_at >= t.observed_at - interval '365 days'
          AND o.observed_at < t.observed_at
          AND o.geom && ST_Expand(t.geom, 0.1)
    ) c
) n
WHERE t.id = ANY(%(ids)s)
"""  # noqa: S608 - only module-constant column names are interpolated


class ScoreError(Exception):
    pass


@dataclass(frozen=True)
class Model:
    id: int
    version: str
    booster: lgb.Booster
    calibration_x: np.ndarray
    calibration_y: np.ndarray
    thresholds: dict[str, float | None]

    def probability(self, x: pd.DataFrame) -> np.ndarray:
        raw = np.asarray(self.booster.predict(x), dtype=float)
        return np.asarray(np.interp(raw, self.calibration_x, self.calibration_y), dtype=float)

    def level(self, p: float) -> str:
        for name in ("very_high", "high", "moderate"):
            cut = self.thresholds.get(name)
            if cut is not None and p >= cut:
                return name
        return "low"


@dataclass(frozen=True)
class ScoreStats:
    model_version: str | None
    scored: int
    skipped_modis: int


def load_active(conn: psycopg.Connection[Any], repo_root: Path) -> Model | None:
    row = conn.execute(
        "SELECT id, version, features, params, thresholds, artifact_url, artifact_sha256 "
        "FROM ml_model_versions WHERE status = 'active'"
    ).fetchone()
    if row is None:
        return None
    model_id, version, feats, params, thresholds, url, sha = row
    if list(feats) != list(features.FEATURES):
        raise ScoreError(f"model {version}: feature list differs from firewatch_ml.features")
    path = repo_root / url
    if not path.is_file():
        raise ScoreError(f"model {version}: artifact {url} not found")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != sha:
        raise ScoreError(f"model {version}: SHA-256 mismatch for {url}")
    cal = params["calibration"]
    return Model(
        id=int(model_id),
        version=str(version),
        booster=lgb.Booster(model_str=data.decode("utf-8")),
        calibration_x=np.asarray(cal["x"], dtype=float),
        calibration_y=np.asarray(cal["y"], dtype=float),
        thresholds=dict(thresholds),
    )


def feature_frame(conn: psycopg.Connection[Any], ids: list[int]) -> pd.DataFrame:
    """Feature rows for detection ids, indexed by id, in ``features.FEATURES`` order."""
    cur = conn.execute(FEATURE_SQL, {"ids": ids, "satellite": features.CONTEXT_SATELLITE})
    names = [d.name for d in cur.description or []]
    raw = pd.DataFrame(cur.fetchall(), columns=names).set_index("id")
    raw["observed_at"] = pd.to_datetime(raw["observed_at"], utc=True)
    for c in ("latitude", "longitude", "bright_main_k", "bright_aux_k", "frp_mw"):
        raw[c] = raw[c].astype(float)
    context = raw[[c[0] for c in features.CONTEXT] + [features.FRP_CONTEXT[0]]].astype(float)
    frame = pd.concat([features.sensor_features(raw), context], axis=1)
    return frame[list(features.FEATURES)]


def _contributions(model: Model, x: pd.DataFrame) -> list[list[dict[str, Any]]]:
    contrib = np.asarray(model.booster.predict(x, pred_contrib=True))[:, :-1]
    out = []
    for i in range(len(x)):
        top = np.argsort(-np.abs(contrib[i]))[:TOP_CONTRIBUTIONS]
        out.append(
            [
                {
                    "feature": features.FEATURES[j],
                    "value": float(x.iat[i, j]),
                    "contribution": round(float(contrib[i, j]), 5),
                }
                for j in top
            ]
        )
    return out


def score(conn: psycopg.Connection[Any], now: datetime, repo_root: Path) -> ScoreStats:
    skipped = conn.execute(
        "UPDATE detections SET processing_status = 'score_skipped', updated_at = now() "
        "WHERE instrument = 'MODIS' AND processing_status IN ('ingested', 'enriched') "
        "AND observed_at >= %s",
        (now - LOOKBACK,),
    ).rowcount
    model = load_active(conn, repo_root)
    if model is None:
        return ScoreStats(None, 0, skipped)
    ids = [
        int(r[0])
        for r in conn.execute(
            """SELECT d.id FROM detections d
               WHERE d.instrument = 'VIIRS' AND d.observed_at >= %s
                 AND NOT EXISTS (SELECT 1 FROM ml_predictions p
                                 WHERE p.detection_id = d.id AND p.model_version_id = %s)
               ORDER BY d.observed_at""",
            (now - LOOKBACK, model.id),
        )
    ]
    scored = 0
    for start in range(0, len(ids), BATCH):
        batch = ids[start : start + BATCH]
        x = feature_frame(conn, batch)
        p = model.probability(x)
        contributions = _contributions(model, x)
        rows = [
            (
                int(det_id),
                model.id,
                float(p[i]),
                model.level(float(p[i])),
                json.dumps({k: float(v) for k, v in x.iloc[i].items()}),
                json.dumps(contributions[i]),
            )
            for i, det_id in enumerate(x.index)
        ]
        with conn.transaction(), conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO ml_predictions (detection_id, model_version_id, probability,
                       risk_level, features, top_contributions)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (detection_id, model_version_id) DO NOTHING""",
                rows,
            )
            cur.execute(
                "UPDATE detections SET processing_status = 'scored', updated_at = now() "
                "WHERE id = ANY(%s)",
                (batch,),
            )
        scored += len(rows)
    return ScoreStats(model.version, scored, skipped)
