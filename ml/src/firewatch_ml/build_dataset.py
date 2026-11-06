"""Build the training table: archive -> Kazakhstan only -> features -> MCD64A1 labels.

Usage::

    python -m firewatch_ml.build_dataset --start 2019-01-01 --end 2025-12-31

Writes ``data/ml/dataset.parquet`` (gitignored) and ``data/ml/dataset.json`` (counts and
SHA-256, copied into the model metadata). Context for the features starts 365 days before
``--start``; the NOAA-20 archive itself starts on 2018-04-01, so the persistence feature of
the first months of 2019 sees less than a full year (stated in the report).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psycopg
import shapely

from firewatch_ml import data, features, labels
from firewatch_pipeline.run import REPO_ROOT, log
from firewatch_shared.envfile import load_env_files, repo_env_files

OUT_DIR = REPO_ROOT / "data/ml"
ARCHIVE_START = date(2018, 4, 1)


def country_polygon(cache: Path = OUT_DIR / "kazakhstan.wkb") -> shapely.Geometry:
    """Level-0 region from the database (the same polygon the pipeline filters with)."""
    if not cache.exists():
        load_env_files(repo_env_files(REPO_ROOT))
        url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]
        with psycopg.connect(url) as conn:
            row = conn.execute("SELECT ST_AsBinary(geom) FROM regions WHERE level = 0").fetchone()
        if row is None:
            raise RuntimeError("no level-0 region in the database")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(bytes(row[0]))
    return shapely.from_wkb(cache.read_bytes())


def inside(frame: pd.DataFrame, polygon: shapely.Geometry) -> np.ndarray:
    shapely.prepare(polygon)
    lon = frame["longitude"].to_numpy()
    lat = frame["latitude"].to_numpy()
    return np.asarray(shapely.contains_xy(polygon, lon, lat))


def focus_groups(frame: pd.DataFrame) -> np.ndarray:
    """Approximate fire foci for the grouped bootstrap: ~2 km cells x 3-day bins."""
    utc = frame["observed_at"].dt.tz_convert("UTC").dt.tz_localize(None)
    day = ((utc - pd.Timestamp(0)).dt.days // 3).to_numpy(dtype=np.int64)
    lat = np.floor(frame["latitude"].to_numpy() / 0.02).astype(np.int64)
    lon = np.floor(frame["longitude"].to_numpy() / 0.02).astype(np.int64)
    return np.asarray((lat * 100_000 + lon) * 100_000 + day, dtype=np.int64)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the FireWatch training table")
    parser.add_argument("--start", type=date.fromisoformat, default=date(2019, 1, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=date(2025, 12, 31))
    args = parser.parse_args(argv)

    paths = sorted(data.CACHE_DIR.glob(f"{data.PRODUCT.api_product}_*.csv"))
    archive = data.load(paths)
    log(
        "ml_archive_loaded", rows=len(archive), files=len(paths), rejected=archive.attrs["rejected"]
    )
    archive = archive[inside(archive, country_polygon())].reset_index(drop=True)
    context = archive[archive["satellite"] == features.CONTEXT_SATELLITE].reset_index(drop=True)
    day = archive["observed_at"].dt.date
    targets = archive[(day >= args.start) & (day <= args.end)].reset_index(drop=True)
    log("ml_targets", rows=len(targets), context=len(context))

    x = features.build(targets, context)
    log("ml_features_done", columns=len(x.columns))
    y, label_stats = labels.label(targets)
    log("ml_labels_done", **label_stats)

    table = pd.concat(
        [targets[["observed_at", "latitude", "longitude", "satellite", "daynight"]], x], axis=1
    )
    table["label"] = y
    table["year"] = table["observed_at"].dt.year
    table["cell_1deg"] = np.floor(table["latitude"]).astype(int) * 1000 + np.floor(
        table["longitude"]
    ).astype(int)
    table["focus"] = focus_groups(table)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "dataset.parquet"
    table.to_parquet(out, index=False)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    summary: dict[str, Any] = {
        "product": data.PRODUCT.source_code,
        "objects_period": [args.start.isoformat(), args.end.isoformat()],
        "context_from": max(ARCHIVE_START, args.start - timedelta(days=365)).isoformat(),
        "territory": "Kazakhstan (OSM level-0 polygon from the regions table)",
        "rows": len(table),
        "labels": label_stats,
        "by_year": {
            str(year): {str(int(k)): int(n) for k, n in g["label"].value_counts().items()}
            for year, g in table.groupby("year")
        },
        "label_rule": {
            "positive": f"burned pixel within {labels.POS_RADIUS} px (3x3), "
            f"BurnDate in [t-{labels.POS_BEFORE}, t+{labels.POS_AFTER}] d",
            "negative": f"no burned pixel within {labels.NEG_RADIUS} px (5x5), "
            f"|BurnDate - t| <= {labels.NEG_WINDOW} d",
            "source": f"MCD64A1 v6.1 Burn_Date ({labels.COLLECTION}, Microsoft Planetary Computer)",
        },
        "sha256": digest,
    }
    (OUT_DIR / "dataset.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log("ml_dataset_written", path=str(out), sha256=digest, rows=len(table))
    return 0


if __name__ == "__main__":
    sys.exit(main())
