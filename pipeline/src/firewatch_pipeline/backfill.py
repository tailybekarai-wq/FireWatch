"""Load historical FIRMS data (SP archive or older NRT days) into the database.

Usage (repo root)::

    python -m firewatch_pipeline.backfill --source FIRMS_VIIRS_NOAA20_SP \\
        --start 2025-01-01 --end 2025-12-31

Requests go in 5-day chunks (the FIRMS DAY_RANGE limit). Responses are cached under
``data/raw/backfill/`` (gitignored); a cached chunk is not requested again, and its
``source_fetches`` row says so (``params.from_cache``) with the original request time.
Loading reuses the scheduled path, so the AOI filter, upsert and history are identical.

Weather is not fetched here: Open-Meteo counts every location as a call, so a year of
history would exceed the free daily limit. Historical weather for ML is built in stage 6.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg

from firewatch_pipeline import load
from firewatch_pipeline.firms_parse import FirmsSchemaError
from firewatch_pipeline.run import REPO_ROOT, ingest_response, log
from firewatch_pipeline.sources.firms import (
    BASE_URL,
    MAX_DAY_RANGE,
    PRODUCTS,
    FirmsClient,
    FirmsError,
    FirmsProduct,
    FirmsResponse,
)
from firewatch_shared.aoi import KAZAKHSTAN_BBOX, BBox
from firewatch_shared.enums import RunStatus
from firewatch_shared.envfile import load_env_files, repo_env_files

PAUSE_S = 0.5


def chunks(start: date, end: date, size: int = MAX_DAY_RANGE) -> Iterator[tuple[date, int]]:
    """Consecutive (first_day, day_count) windows covering [start, end] inclusive."""
    day = start
    while day <= end:
        span = min(size, (end - day).days + 1)
        yield day, span
        day += timedelta(days=span)


def cache_path(cache_dir: Path, product: FirmsProduct, day: date, span: int) -> Path:
    return cache_dir / f"{product.api_product}_{day.isoformat()}_{span}.csv"


def cached_response(
    product: FirmsProduct, bbox: BBox, day: date, span: int, path: Path
) -> FirmsResponse:
    fetched_at = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    return FirmsResponse(
        product=product,
        url_redacted=(
            f"{BASE_URL}/api/area/csv/***/{product.api_product}/"
            f"{bbox.to_firms_param()}/{span}/{day.isoformat()}"
        ),
        params={
            "source": product.api_product,
            "bbox": bbox.to_firms_param(),
            "day_range": str(span),
            "date": day.isoformat(),
            "from_cache": "true",
        },
        requested_at=fetched_at,
        responded_at=fetched_at,
        http_status=200,
        body=path.read_bytes(),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FireWatch historical backfill")
    parser.add_argument("--source", required=True, choices=sorted(PRODUCTS))
    parser.add_argument("--start", required=True, type=date.fromisoformat)
    parser.add_argument("--end", required=True, type=date.fromisoformat)
    parser.add_argument("--cache-dir", type=Path, default=REPO_ROOT / "data/raw/backfill")
    args = parser.parse_args(argv)
    if args.end < args.start:
        parser.error("--end is before --start")

    load_env_files(repo_env_files(REPO_ROOT))
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        log("config_error", missing=["DATABASE_URL"])
        return 2
    product = PRODUCTS[args.source]
    bbox = BBox.parse(os.environ["AOI_BBOX"]) if os.environ.get("AOI_BBOX") else KAZAKHSTAN_BBOX
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    firms: FirmsClient | None = None

    with psycopg.connect(db_url, autocommit=True) as conn:
        source_id = load.source_ids(conn)[product.source_code]
        run_id = load.start_run(
            conn, "backfill", os.environ.get("GITHUB_SHA"), os.environ.get("GITHUB_RUN_ID")
        )
        log(
            "backfill_started",
            run_id=run_id,
            source=product.source_code,
            start=args.start,
            end=args.end,
        )
        totals: dict[str, int] = {
            "chunks": 0,
            "failed_chunks": 0,
            "inserted": 0,
            "updated": 0,
            "unchanged": 0,
            "outside_aoi": 0,
            "rejected": 0,
        }
        errors: list[str] = []
        try:
            for day, span in chunks(args.start, args.end):
                path = cache_path(args.cache_dir, product, day, span)
                try:
                    if path.exists():
                        response = cached_response(product, bbox, day, span, path)
                    else:
                        firms = firms or FirmsClient(os.environ.get("FIRMS_MAP_KEY", ""))
                        response = firms.area_csv(product, bbox, span, day)
                        path.write_bytes(response.body)
                        time.sleep(PAUSE_S)
                    stats: dict[str, Any] = ingest_response(conn, run_id, source_id, response)
                except (FirmsError, FirmsSchemaError) as exc:
                    totals["failed_chunks"] += 1
                    errors.append(f"{day}: {exc}")
                    log("chunk_failed", day=day, error=str(exc))
                    continue
                totals["chunks"] += 1
                for key in ("inserted", "updated", "unchanged", "outside_aoi", "rejected"):
                    totals[key] += int(stats[key])
            load.refresh_daily_stats(conn)
        except Exception as exc:
            load.finish_run(conn, run_id, RunStatus.FAILED, totals, f"unexpected: {exc!r}"[:4000])
            log("backfill_crashed", run_id=run_id, error=repr(exc))
            raise
        if totals["failed_chunks"] == 0:
            status = RunStatus.SUCCESS
        elif totals["chunks"]:
            status = RunStatus.PARTIAL
        else:
            status = RunStatus.FAILED
        load.finish_run(conn, run_id, status, totals, "\n".join(errors)[:4000] or None)
        log("backfill_finished", run_id=run_id, status=status.value, **totals)
    return 1 if status is RunStatus.FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
