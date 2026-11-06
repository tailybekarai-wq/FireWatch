"""Group detections into potential fire foci (``hotspot_clusters``).

Detections observed within a sliding window are clustered with ST_ClusterDBSCAN
(eps ~750 m, two VIIRS pixels; minpoints 1). A window cluster that touches an existing
focus joins it (the smallest id wins), so focus ids stay stable between runs; otherwise a
new focus is created. Stats are then recomputed from the member detections, and foci
without detections in the last 24 h become ``inactive``. Static industrial sources
(VIIRS SP ``type=2``) are never clustered.

Distances: EPSG:3857 is used with eps scaled by 1/cos(48 deg) (the middle latitude of
Kazakhstan), which keeps the effective radius within ~15 % of 750 m across the country.

Usage::

    python -m firewatch_pipeline.cluster --since 2025-01-01   # history, day by day
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import psycopg

from firewatch_shared.envfile import load_env_files, repo_env_files

ALGORITHM = "dbscan_eps750m_72h_v1"
EPS_M = 750.0
WINDOW = timedelta(hours=72)
ACTIVE_FOR = timedelta(hours=24)


@dataclass(frozen=True)
class ClusterStats:
    detections: int
    foci_touched: int
    foci_created: int


def cluster_window(conn: psycopg.Connection[Any], start: datetime, end: datetime) -> ClusterStats:
    """Cluster detections observed in [start, end). Runs in its own transaction."""
    with conn.transaction():
        n = conn.execute(
            """CREATE TEMP TABLE w ON COMMIT DROP AS
               SELECT id, cluster_id,
                      ST_ClusterDBSCAN(ST_Transform(geom, 3857),
                                       eps := %s / cos(radians(48.0)), minpoints := 1) OVER () AS wc
               FROM detections WHERE observed_at >= %s AND observed_at < %s
                 AND fire_type IS DISTINCT FROM 2""",
            (EPS_M, start, end),
        ).rowcount
        if not n:
            return ClusterStats(0, 0, 0)
        conn.execute(
            """CREATE TEMP TABLE m ON COMMIT DROP AS
               SELECT wc, min(cluster_id) AS cid, min(cluster_id) IS NULL AS is_new
               FROM w GROUP BY wc"""
        )
        created = conn.execute(
            "UPDATE m SET cid = nextval(pg_get_serial_sequence('hotspot_clusters', 'id')) "
            "WHERE is_new"
        ).rowcount
        # Placeholder rows satisfy the constraints; real stats are recomputed below.
        conn.execute(
            """INSERT INTO hotspot_clusters (id, first_observed_at, last_observed_at,
                   detection_count, centroid, status, algorithm)
               OVERRIDING SYSTEM VALUE
               SELECT cid, now(), now(), 1, ST_SetSRID(ST_MakePoint(0, 0), 4326), 'active', %s
               FROM m WHERE is_new""",
            (ALGORITHM,),
        )
        conn.execute(
            """CREATE TEMP TABLE touched ON COMMIT DROP AS
               SELECT cid AS id FROM m
               UNION SELECT cluster_id FROM w WHERE cluster_id IS NOT NULL"""
        )
        conn.execute(
            """UPDATE detections d SET cluster_id = m.cid
               FROM w JOIN m USING (wc)
               WHERE d.id = w.id AND d.cluster_id IS DISTINCT FROM m.cid"""
        )
        conn.execute(
            """UPDATE hotspot_clusters h SET
                   first_observed_at = s.first_at, last_observed_at = s.last_at,
                   detection_count = s.n, total_frp_mw = s.total_frp, max_frp_mw = s.max_frp,
                   centroid = s.c,
                   hull = CASE WHEN GeometryType(s.hull) = 'POLYGON' THEN s.hull END,
                   region_id = (SELECT r.id FROM regions r
                                WHERE r.level = 1 AND ST_Intersects(r.geom, s.c) LIMIT 1),
                   status = CASE WHEN s.last_at >= now() - %s THEN 'active' ELSE 'inactive' END,
                   algorithm = %s, updated_at = now()
               FROM (SELECT cluster_id, min(observed_at) AS first_at, max(observed_at) AS last_at,
                            count(*)::int AS n, sum(frp_mw) AS total_frp, max(frp_mw) AS max_frp,
                            ST_Centroid(ST_Collect(geom)) AS c,
                            ST_ConvexHull(ST_Collect(geom)) AS hull
                     FROM detections WHERE cluster_id IN (SELECT id FROM touched)
                     GROUP BY cluster_id) s
               WHERE h.id = s.cluster_id""",
            (ACTIVE_FOR, ALGORITHM),
        )
        conn.execute(
            "DELETE FROM hotspot_clusters h WHERE h.id IN (SELECT id FROM touched) "
            "AND NOT EXISTS (SELECT 1 FROM detections d WHERE d.cluster_id = h.id)"
        )
        conn.execute(
            "UPDATE hotspot_clusters SET status = 'inactive', updated_at = now() "
            "WHERE status = 'active' AND last_observed_at < now() - %s",
            (ACTIVE_FOR,),
        )
        touched = conn.execute("SELECT count(*) FROM touched").fetchone()
    return ClusterStats(
        detections=n, foci_touched=int(touched[0]) if touched else 0, foci_created=created
    )


def recent(conn: psycopg.Connection[Any], now: datetime | None = None) -> ClusterStats:
    now = now or datetime.now(UTC)
    return cluster_window(conn, now - WINDOW, now + timedelta(hours=1))


def main(argv: list[str] | None = None) -> int:
    from firewatch_pipeline.run import REPO_ROOT, log

    parser = argparse.ArgumentParser(description="Cluster history into potential foci")
    parser.add_argument("--since", required=True, type=date.fromisoformat)
    args = parser.parse_args(argv)
    load_env_files(repo_env_files(REPO_ROOT))
    url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not url:
        log("config_error", missing=["DATABASE_URL"])
        return 2
    day = datetime.combine(args.since, datetime.min.time(), tzinfo=UTC)
    end = datetime.now(UTC)
    totals = [0, 0]
    with psycopg.connect(url, autocommit=True) as conn:
        while day < end:
            # 3-day windows advancing one day: every pair of detections closer than 72 h
            # shares at least one window, so chains spanning days are merged.
            stats = cluster_window(conn, day, day + WINDOW)
            totals[0] += stats.foci_created
            totals[1] += stats.detections
            day += timedelta(days=1)
        foci = conn.execute(
            "SELECT count(*), count(*) FILTER (WHERE status = 'active') FROM hotspot_clusters"
        ).fetchone()
    log(
        "cluster_history_done",
        created=totals[0],
        foci=foci[0] if foci else 0,
        active=foci[1] if foci else 0,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
