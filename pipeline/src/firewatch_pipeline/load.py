"""Database writes for ingestion: run log, fetch log, rejected rows, detections.

Only detections inside Kazakhstan (the level-0 row in ``regions``) are stored; the
rest of the bounding box is counted as filtered. Loading is idempotent: rows are
upserted by ``dedup_key`` and an existing row is only rewritten when a tracked value
changed, in which case the old/new values go to ``detection_history``.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg

from firewatch_pipeline.firms_parse import NormalizedDetection, RejectedRow
from firewatch_shared.enums import RunStatus

# Values that may legitimately change for the same detection (URT/RT -> NRT, reprocessing).
TRACKED = (
    "product_version",
    "processing_level",
    "frp_mw",
    "confidence_raw",
    "confidence_level",
    "bright_main_k",
    "bright_aux_k",
    "scan_km",
    "track_km",
    "fire_type",
)
INCOMING_COLUMNS = (
    "dedup_key",
    "satellite",
    "instrument",
    "observed_at",
    "latitude",
    "longitude",
    "bright_main_k",
    "bright_aux_k",
    "frp_mw",
    "confidence_raw",
    "confidence_level",
    "scan_km",
    "track_km",
    "daynight",
    "product_version",
    "processing_level",
    "fire_type",
)


@dataclass(frozen=True)
class LoadStats:
    received: int
    outside_aoi: int
    duplicates_in_batch: int
    inserted: int
    updated: int
    unchanged: int


def start_run(
    conn: psycopg.Connection[Any], trigger: str, git_sha: str | None, github_run_id: str | None
) -> int:
    row = conn.execute(
        "INSERT INTO ingestion_runs (trigger, git_sha, github_run_id) VALUES (%s, %s, %s) "
        "RETURNING id",
        (trigger, git_sha, github_run_id),
    ).fetchone()
    conn.commit()
    assert row is not None  # noqa: S101 - INSERT ... RETURNING always yields a row
    return int(row[0])


def finish_run(
    conn: psycopg.Connection[Any],
    run_id: int,
    status: RunStatus,
    stats: dict[str, Any],
    error: str | None,
) -> None:
    conn.execute(
        "UPDATE ingestion_runs SET finished_at = now(), status = %s, stats = %s, error = %s "
        "WHERE id = %s",
        (status.value, json.dumps(stats), error, run_id),
    )
    conn.commit()


def source_ids(conn: psycopg.Connection[Any]) -> dict[str, int]:
    return {code: int(i) for i, code in conn.execute("SELECT id, code FROM data_sources")}


def enabled_fire_sources(conn: psycopg.Connection[Any]) -> list[str]:
    return [
        code
        for (code,) in conn.execute(
            "SELECT code FROM data_sources WHERE enabled AND data_type = 'active_fire' "
            "ORDER BY code"
        )
    ]


def insert_fetch(
    conn: psycopg.Connection[Any],
    *,
    run_id: int,
    source_id: int,
    url_redacted: str,
    params: dict[str, str],
    requested_at: datetime,
    responded_at: datetime | None,
    http_status: int | None,
    body_bytes: int | None,
    body_sha256: str | None,
    status: str,
    error: str | None = None,
) -> int:
    row = conn.execute(
        """INSERT INTO source_fetches (run_id, source_id, request_url_redacted, params,
               requested_at, responded_at, http_status, bytes, body_sha256, status, error)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (
            run_id,
            source_id,
            url_redacted,
            json.dumps(params),
            requested_at,
            responded_at,
            http_status,
            body_bytes,
            body_sha256,
            status,
            error,
        ),
    ).fetchone()
    assert row is not None  # noqa: S101
    return int(row[0])


def finish_fetch(
    conn: psycopg.Connection[Any], fetch_id: int, stats: LoadStats, rejected: int
) -> None:
    conn.execute(
        """UPDATE source_fetches SET rows_received = %s, rows_inserted = %s, rows_updated = %s,
               rows_unchanged = %s, rows_rejected = %s,
               params = params || jsonb_build_object('outside_aoi', %s::int,
                                                     'duplicates_in_batch', %s::int)
           WHERE id = %s""",
        (
            stats.received + rejected,
            stats.inserted,
            stats.updated,
            stats.unchanged,
            rejected,
            stats.outside_aoi,
            stats.duplicates_in_batch,
            fetch_id,
        ),
    )


def insert_rejected(
    conn: psycopg.Connection[Any], fetch_id: int, rejected: Sequence[RejectedRow]
) -> None:
    if not rejected:
        return
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO rejected_records (fetch_id, raw, reason) VALUES (%s, %s, %s)",
            [(fetch_id, json.dumps(r.raw), r.reason) for r in rejected],
        )


_CHANGED = " OR ".join(f"d.{c} IS DISTINCT FROM b.{c}" for c in TRACKED)
_CHANGES_JSON = ", ".join(
    f"'{c}', CASE WHEN d.{c} IS DISTINCT FROM b.{c} "
    f"THEN jsonb_build_array(to_jsonb(d.{c}), to_jsonb(b.{c})) END"
    for c in TRACKED
)
_UPDATE_SET = ", ".join(f"{c} = EXCLUDED.{c}" for c in TRACKED)
_UPDATE_WHERE = " OR ".join(f"detections.{c} IS DISTINCT FROM EXCLUDED.{c}" for c in TRACKED)


def load_detections(
    conn: psycopg.Connection[Any],
    *,
    fetch_id: int,
    source_id: int,
    rows: Sequence[NormalizedDetection],
) -> LoadStats:
    """Filter to the AOI polygon, upsert and record history. Runs in the caller's transaction."""
    conn.execute(
        """CREATE TEMP TABLE incoming (
               dedup_key text, satellite text, instrument text, observed_at timestamptz,
               latitude double precision, longitude double precision, bright_main_k real,
               bright_aux_k real, frp_mw real, confidence_raw text, confidence_level text,
               scan_km real, track_km real, daynight char(1), product_version text,
               processing_level text, fire_type smallint
           ) ON COMMIT DROP"""
    )
    with conn.cursor().copy(f"COPY incoming ({', '.join(INCOMING_COLUMNS)}) FROM STDIN") as copy:
        for r in rows:
            copy.write_row(
                (
                    r.dedup_key,
                    r.satellite,
                    r.instrument,
                    r.observed_at,
                    r.latitude,
                    r.longitude,
                    r.bright_main_k,
                    r.bright_aux_k,
                    r.frp_mw,
                    r.confidence_raw,
                    r.confidence_level.value,
                    r.scan_km,
                    r.track_km,
                    r.daynight.value,
                    r.product_version,
                    r.processing_level.value,
                    r.fire_type,
                )
            )
    inside = conn.execute(
        """CREATE TEMP TABLE batch ON COMMIT DROP AS
           WITH pts AS (
               SELECT i.*, ST_SetSRID(ST_MakePoint(i.longitude, i.latitude), 4326) AS pt
               FROM incoming i
           ), kz AS (
               SELECT p.* FROM pts p
               JOIN regions c ON c.level = 0 AND ST_Intersects(c.geom, p.pt)
           )
           SELECT DISTINCT ON (k.dedup_key) k.*, (
                      SELECT r.id FROM regions r
                      WHERE r.level = 1 AND ST_Intersects(r.geom, k.pt)
                      ORDER BY r.id LIMIT 1
                  ) AS region_id
           FROM kz k
           ORDER BY k.dedup_key, k.observed_at"""
    ).rowcount
    counts = conn.execute(
        """SELECT (SELECT count(*) FROM incoming),
                  (SELECT count(*) FROM incoming i WHERE EXISTS (
                       SELECT 1 FROM regions c WHERE c.level = 0 AND ST_Intersects(
                           c.geom, ST_SetSRID(ST_MakePoint(i.longitude, i.latitude), 4326))))"""
    ).fetchone()
    assert counts is not None  # noqa: S101
    received, inside_with_dups = int(counts[0]), int(counts[1])

    conn.execute(
        f"""INSERT INTO detection_history (detection_id, fetch_id, changes)
            SELECT d.id, %s, jsonb_strip_nulls(jsonb_build_object({_CHANGES_JSON}))
            FROM batch b JOIN detections d ON d.dedup_key = b.dedup_key
            WHERE {_CHANGED}""",
        (fetch_id,),
    )
    result = conn.execute(
        f"""WITH up AS (
                INSERT INTO detections (dedup_key, source_id, first_fetch_id, last_fetch_id,
                    satellite, instrument, observed_at, latitude, longitude, bright_main_k,
                    bright_aux_k, frp_mw, confidence_raw, confidence_level, scan_km, track_km,
                    daynight, product_version, processing_level, fire_type, region_id)
                SELECT b.dedup_key, %(source)s, %(fetch)s, %(fetch)s, b.satellite, b.instrument,
                       b.observed_at, b.latitude, b.longitude, b.bright_main_k, b.bright_aux_k,
                       b.frp_mw, b.confidence_raw, b.confidence_level, b.scan_km, b.track_km,
                       b.daynight, b.product_version, b.processing_level, b.fire_type,
                       b.region_id
                FROM batch b
                ON CONFLICT (dedup_key) DO UPDATE SET {_UPDATE_SET},
                    last_fetch_id = EXCLUDED.last_fetch_id, updated_at = now(),
                    processing_status = 'ingested'
                WHERE {_UPDATE_WHERE}
                RETURNING (xmax = 0) AS inserted
            )
            SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
            FROM up""",
        {"source": source_id, "fetch": fetch_id},
    ).fetchone()
    assert result is not None  # noqa: S101
    inserted, updated = int(result[0]), int(result[1])
    return LoadStats(
        received=received,
        outside_aoi=received - inside_with_dups,
        duplicates_in_batch=inside_with_dups - inside,
        inserted=inserted,
        updated=updated,
        unchanged=inside - inserted - updated,
    )


def replace_nrt_with_sp(
    conn: psycopg.Connection[Any],
    nrt_source_id: int,
    sp_source_id: int,
    start: datetime,
    end: datetime,
) -> int:
    """Delete NRT detections in [start, end) that the SP archive now covers (R-13).

    NRT and SP rows of one satellite have different dedup keys, so both would be counted.
    Only NRT up to the last SP observation in the window is removed: a window where SP is
    not published yet (or holds no fires) keeps its NRT rows.
    """
    with conn.transaction():
        cur = conn.execute(
            """DELETE FROM detections
               WHERE source_id = %(nrt)s AND observed_at >= %(start)s AND observed_at < %(end)s
                 AND observed_at <= (SELECT max(observed_at) FROM detections
                                     WHERE source_id = %(sp)s AND observed_at >= %(start)s
                                       AND observed_at < %(end)s)""",
            {"nrt": nrt_source_id, "sp": sp_source_id, "start": start, "end": end},
        )
        return cur.rowcount


def delete_empty_clusters(conn: psycopg.Connection[Any]) -> int:
    with conn.transaction():
        return conn.execute(
            """DELETE FROM hotspot_clusters h
               WHERE NOT EXISTS (SELECT 1 FROM detections d WHERE d.cluster_id = h.id)
                 AND NOT EXISTS (SELECT 1 FROM burned_area_assessments b
                                 WHERE b.cluster_id = h.id)"""
        ).rowcount


def refresh_daily_stats(conn: psycopg.Connection[Any]) -> None:
    conn.execute("SELECT refresh_daily_stats()")
    conn.commit()


def database_size_bytes(conn: psycopg.Connection[Any]) -> int:
    row = conn.execute("SELECT pg_database_size(current_database())").fetchone()
    assert row is not None  # noqa: S101
    return int(row[0])
