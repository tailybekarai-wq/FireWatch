"""One scheduled run: FIRMS NRT -> validate -> load -> weather -> foci -> ML score -> stats.

Usage (repo root or GitHub Actions)::

    python -m firewatch_pipeline.run --trigger schedule

Each source is fetched and loaded independently: one failing source makes the run
``partial``, all failing make it ``failed`` (non-zero exit, so the workflow shows red).
Every outcome is written to ``ingestion_runs`` / ``source_fetches``; an unexpected
crash still closes the run as ``failed`` with the error text.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg

from firewatch_pipeline import cluster, load, score, weather
from firewatch_pipeline.firms_parse import FirmsSchemaError, parse_firms_csv
from firewatch_pipeline.sources.firms import PRODUCTS, FirmsClient, FirmsError, FirmsResponse
from firewatch_pipeline.sources.openmeteo import OpenMeteoClient, OpenMeteoError
from firewatch_shared.aoi import KAZAKHSTAN_BBOX, BBox
from firewatch_shared.enums import RunStatus
from firewatch_shared.envfile import load_env_files, repo_env_files

REPO_ROOT = Path(__file__).resolve().parents[3]
DB_LIMIT_BYTES = 512 * 1024 * 1024  # Neon Free: 0.5 GB per project
DB_WARN_FRACTION = 0.8


def log(event: str, **fields: Any) -> None:
    """One JSON object per line (GitHub Actions log, easy to grep)."""
    print(
        json.dumps(
            {"ts": datetime.now(UTC).isoformat(timespec="seconds"), "event": event, **fields},
            default=str,
        ),
        flush=True,
    )


def run_status(source_outcomes: Sequence[bool], weather_ok: bool) -> RunStatus:
    if source_outcomes and not any(source_outcomes):
        return RunStatus.FAILED
    if not all(source_outcomes) or not weather_ok:
        return RunStatus.PARTIAL
    return RunStatus.SUCCESS


def ingest_response(
    conn: psycopg.Connection[Any], run_id: int, source_id: int, response: FirmsResponse
) -> dict[str, Any]:
    """Parse and load one successful HTTP response in its own transaction."""

    def insert_fetch(status: str, error: str | None = None) -> int:
        return load.insert_fetch(
            conn,
            run_id=run_id,
            source_id=source_id,
            url_redacted=response.url_redacted,
            params=response.params,
            requested_at=response.requested_at,
            responded_at=response.responded_at,
            http_status=response.http_status,
            body_bytes=len(response.body),
            body_sha256=response.sha256,
            status=status,
            error=error,
        )

    try:
        result = parse_firms_csv(response.product, response.text)
    except FirmsSchemaError as exc:
        insert_fetch(exc.kind, str(exc)[:2000])
        raise
    with conn.transaction():
        fetch_id = insert_fetch("ok")
        load.insert_rejected(conn, fetch_id, result.rejected)
        stats = load.load_detections(conn, fetch_id=fetch_id, source_id=source_id, rows=result.rows)
        load.finish_fetch(conn, fetch_id, stats, len(result.rejected))
    return {"fetch_id": fetch_id, "rejected": len(result.rejected), **stats.__dict__}


def _ingest_sources(
    conn: psycopg.Connection[Any],
    run_id: int,
    firms: FirmsClient,
    bbox: BBox,
    day_range: int,
    ids: dict[str, int],
    per_source: dict[str, Any],
    errors: list[str],
) -> list[bool]:
    outcomes: list[bool] = []
    for code in load.enabled_fire_sources(conn):
        product = PRODUCTS.get(code)
        if product is None or product.processing != "NRT":
            continue
        requested_at = datetime.now(UTC)
        params = {
            "source": product.api_product,
            "bbox": bbox.to_firms_param(),
            "day_range": str(day_range),
            "date": "",
        }
        failure: FirmsError | FirmsSchemaError
        try:
            response = firms.area_csv(product, bbox, day_range)
            per_source[code] = ingest_response(conn, run_id, ids[code], response)
        except FirmsError as exc:
            failure = exc
            load.insert_fetch(
                conn,
                run_id=run_id,
                source_id=ids[code],
                url_redacted=firms.redact(f"FIRMS area/csv {product.api_product}"),
                params=params,
                requested_at=requested_at,
                responded_at=None,
                http_status=exc.http_status,
                body_bytes=None,
                body_sha256=None,
                status=exc.kind,
                error=str(exc)[:2000],
            )
        except FirmsSchemaError as exc:
            failure = exc  # ingest_response already logged the fetch with its status
        else:
            outcomes.append(True)
            log("source_loaded", source=code, **per_source[code])
            continue
        outcomes.append(False)
        errors.append(f"{code}: {failure}")
        log("source_failed", source=code, kind=failure.kind, error=str(failure))
    return outcomes


def _execute(
    conn: psycopg.Connection[Any],
    run_id: int,
    firms: FirmsClient,
    bbox: BBox,
    args: argparse.Namespace,
) -> RunStatus:
    ids = load.source_ids(conn)
    per_source: dict[str, Any] = {}
    errors: list[str] = []
    outcomes = _ingest_sources(conn, run_id, firms, bbox, args.day_range, ids, per_source, errors)

    weather_ok = True
    now = datetime.now(UTC)
    try:
        w = weather.enrich(
            conn,
            OpenMeteoClient(),
            ids,
            since=now - timedelta(days=args.weather_days),
            until=now + timedelta(hours=1),
        )
        per_source["weather"] = w.__dict__
        log("weather_done", **w.__dict__)
    except (OpenMeteoError, psycopg.Error) as exc:
        weather_ok = False
        errors.append(f"weather: {exc}")
        log("weather_failed", error=str(exc))

    try:
        c = cluster.recent(conn, now)
        per_source["clusters"] = c.__dict__
        log("clusters_done", **c.__dict__)
    except psycopg.Error as exc:
        weather_ok = False
        errors.append(f"clusters: {exc}")
        log("clusters_failed", error=str(exc))

    try:
        s = score.score(conn, now, REPO_ROOT)
        per_source["scoring"] = s.__dict__
        log("scoring_done", **s.__dict__)
    except (score.ScoreError, psycopg.Error) as exc:
        weather_ok = False
        errors.append(f"scoring: {exc}")
        log("scoring_failed", error=str(exc))

    load.refresh_daily_stats(conn)
    size = load.database_size_bytes(conn)
    if size > DB_LIMIT_BYTES * DB_WARN_FRACTION:
        log("db_size_warning", bytes=size, limit=DB_LIMIT_BYTES)
    status = run_status(outcomes, weather_ok)
    load.finish_run(
        conn, run_id, status, {"sources": per_source, "db_bytes": size}, "\n".join(errors) or None
    )
    log("run_finished", run_id=run_id, status=status.value, db_bytes=size)
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FireWatch ingestion run")
    parser.add_argument("--trigger", choices=["schedule", "manual"], default="manual")
    parser.add_argument(
        "--day-range",
        type=int,
        default=2,
        help="days requested per source; >1 overlaps the previous run",
    )
    parser.add_argument(
        "--weather-days", type=int, default=3, help="enrich detections observed in the last N days"
    )
    args = parser.parse_args(argv)

    load_env_files(repo_env_files(REPO_ROOT))
    map_key = os.environ.get("FIRMS_MAP_KEY", "")
    db_url = os.environ.get("DATABASE_URL", "")
    missing = [n for n, v in (("FIRMS_MAP_KEY", map_key), ("DATABASE_URL", db_url)) if not v]
    if missing:
        log("config_error", missing=missing)
        return 2
    bbox = BBox.parse(os.environ["AOI_BBOX"]) if os.environ.get("AOI_BBOX") else KAZAKHSTAN_BBOX
    firms = FirmsClient(map_key)

    # autocommit: each conn.transaction() is a real BEGIN/COMMIT, so one source's failure
    # never rolls back another and ON COMMIT DROP temp tables are dropped per source.
    with psycopg.connect(db_url, autocommit=True) as conn:
        run_id = load.start_run(
            conn, args.trigger, os.environ.get("GITHUB_SHA"), os.environ.get("GITHUB_RUN_ID")
        )
        log("run_started", run_id=run_id, trigger=args.trigger, bbox=bbox.to_firms_param())
        try:
            status = _execute(conn, run_id, firms, bbox, args)
        except Exception as exc:
            load.finish_run(conn, run_id, RunStatus.FAILED, {}, f"unexpected: {exc!r}"[:4000])
            log("run_crashed", run_id=run_id, error=repr(exc))
            raise
    return 1 if status is RunStatus.FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
