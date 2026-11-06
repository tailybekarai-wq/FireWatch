"""Training objects: the VIIRS NOAA-20 SP archive for the project bbox, kept outside the DB.

Responses are cached as CSV under ``data/raw/ml/firms`` (gitignored) and parsed with the
same validator as the scheduled pipeline, so training rows pass identical checks.

Usage::

    python -m firewatch_ml.data --start 2018-04-01 --end 2025-12-31
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date
from pathlib import Path

import pandas as pd

from firewatch_pipeline.backfill import cache_path, chunks
from firewatch_pipeline.firms_parse import parse_firms_csv
from firewatch_pipeline.run import REPO_ROOT, log
from firewatch_pipeline.sources.firms import PRODUCTS, FirmsClient, FirmsError
from firewatch_shared.aoi import KAZAKHSTAN_BBOX
from firewatch_shared.envfile import load_env_files, repo_env_files

PRODUCT = PRODUCTS["FIRMS_VIIRS_NOAA20_SP"]
CACHE_DIR = REPO_ROOT / "data/raw/ml/firms"
PAUSE_S = 0.5

COLUMNS = (
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


def download(start: date, end: date, cache_dir: Path = CACHE_DIR) -> list[Path]:
    """Fetch missing 5-day chunks; returns the cached paths covering [start, end]."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    client: FirmsClient | None = None
    paths = []
    for day, span in chunks(start, end):
        path = cache_path(cache_dir, PRODUCT, day, span)
        if not path.exists():
            client = client or FirmsClient(os.environ.get("FIRMS_MAP_KEY", ""))
            response = client.area_csv(PRODUCT, KAZAKHSTAN_BBOX, span, day)
            path.write_bytes(response.body)
            time.sleep(PAUSE_S)
        paths.append(path)
    return paths


def load(paths: list[Path]) -> pd.DataFrame:
    rows: list[tuple[object, ...]] = []
    rejected = 0
    for path in paths:
        result = parse_firms_csv(PRODUCT, path.read_text(encoding="utf-8"))
        rejected += len(result.rejected)
        rows.extend(
            (
                r.observed_at,
                r.latitude,
                r.longitude,
                r.bright_main_k,
                r.bright_aux_k,
                r.frp_mw,
                r.confidence_level.value,
                r.scan_km,
                r.track_km,
                r.daynight.value,
                r.satellite,
            )
            for r in result.rows
        )
    frame = pd.DataFrame(rows, columns=list(COLUMNS))
    frame["observed_at"] = pd.to_datetime(frame["observed_at"], utc=True)
    frame = frame.drop_duplicates(["observed_at", "latitude", "longitude"])
    frame = frame.sort_values("observed_at", kind="stable").reset_index(drop=True)
    frame.attrs["rejected"] = rejected
    return frame


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download the VIIRS NOAA-20 SP archive")
    parser.add_argument("--start", required=True, type=date.fromisoformat)
    parser.add_argument("--end", required=True, type=date.fromisoformat)
    args = parser.parse_args(argv)
    load_env_files(repo_env_files(REPO_ROOT))
    try:
        paths = download(args.start, args.end)
    except FirmsError as exc:
        log("ml_download_failed", error=str(exc))
        return 1
    log("ml_download_done", files=len(paths))
    return 0


if __name__ == "__main__":
    sys.exit(main())
