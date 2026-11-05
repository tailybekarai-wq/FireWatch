"""Weather enrichment: assign 0.25 degree cells and store weather for detection hours.

Only the (cell, hour) pairs that actually have detections are stored, not whole
hourly series: that keeps ``weather_observations`` roughly the size of
``detections`` instead of growing by 24 rows per cell per day.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg

from firewatch_pipeline.sources.openmeteo import (
    OpenMeteoClient,
    WeatherCell,
    WeatherHour,
    cell_for,
)

# ERA5 lags ~5 days; newer hours come from the forecast API (past_days).
ARCHIVE_LAG = timedelta(days=6)
MAX_PAST_DAYS = 92


@dataclass(frozen=True)
class WeatherStats:
    cells_assigned: int
    hours_requested: int
    rows_written: int


def assign_cells(conn: psycopg.Connection[Any], since: datetime, until: datetime) -> int:
    rows = conn.execute(
        "SELECT id, latitude, longitude FROM detections "
        "WHERE weather_cell_id IS NULL AND observed_at >= %s AND observed_at < %s",
        (since, until),
    ).fetchall()
    if not rows:
        return 0
    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            "UPDATE detections SET weather_cell_id = %s WHERE id = %s",
            [(cell_for(lat, lon).cell_id, i) for i, lat, lon in rows],
        )
    return len(rows)


def _missing_hours(
    conn: psycopg.Connection[Any], since: datetime, until: datetime
) -> dict[WeatherCell, set[datetime]]:
    """Detection hours in a cell that have no stored weather yet (any model)."""
    rows = conn.execute(
        """SELECT DISTINCT d.latitude, d.longitude, date_trunc('hour', d.observed_at) AS hour
           FROM detections d
           WHERE d.observed_at >= %s AND d.observed_at < %s AND d.weather_cell_id IS NOT NULL
             AND NOT EXISTS (
                 SELECT 1 FROM weather_observations w
                 WHERE w.cell_id = d.weather_cell_id
                   AND w.valid_at = date_trunc('hour', d.observed_at))""",
        (since, until),
    ).fetchall()
    wanted: dict[WeatherCell, set[datetime]] = defaultdict(set)
    for lat, lon, hour in rows:
        wanted[cell_for(lat, lon)].add(hour.astimezone(UTC))
    return wanted


def _write(conn: psycopg.Connection[Any], source_id: int, hours: list[WeatherHour]) -> int:
    if not hours:
        return 0
    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO weather_observations (source_id, cell_id, cell_center, valid_at,
                   temperature_2m_c, relative_humidity_2m_pct, wind_speed_10m_kmh,
                   wind_direction_10m_deg, precipitation_mm, vpd_kpa, soil_moisture_0_7_m3m3,
                   model)
               VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s, %s, %s, %s,
                       %s, %s, %s, %s)
               ON CONFLICT (source_id, cell_id, valid_at, model) DO NOTHING""",
            [
                (
                    source_id,
                    h.cell_id,
                    h.cell_lon,
                    h.cell_lat,
                    h.valid_at,
                    h.temperature_2m_c,
                    h.relative_humidity_2m_pct,
                    h.wind_speed_10m_kmh,
                    h.wind_direction_10m_deg,
                    h.precipitation_mm,
                    h.vpd_kpa,
                    h.soil_moisture_0_7_m3m3,
                    h.model,
                )
                for h in hours
            ],
        )
    return len(hours)


def _cell(hour: WeatherHour) -> WeatherCell:
    return WeatherCell(hour.cell_id, hour.cell_lat, hour.cell_lon)


def enrich(
    conn: psycopg.Connection[Any],
    client: OpenMeteoClient,
    source_ids: dict[str, int],
    since: datetime,
    until: datetime,
    now: datetime | None = None,
) -> WeatherStats:
    """Fill weather for detections observed in [since, until)."""
    now = now or datetime.now(UTC)
    assigned = assign_cells(conn, since, until)
    wanted = _missing_hours(conn, since, until)
    archive_cutoff = now - ARCHIVE_LAG
    recent = {c: hs for c, hs in wanted.items() if max(hs) >= archive_cutoff}
    old = {c: hs for c, hs in wanted.items() if c not in recent}
    written = 0

    if recent:
        oldest = min(min(hs) for hs in recent.values())
        past_days = min(MAX_PAST_DAYS, (now - oldest).days + 1)
        fetched = client.recent(list(recent), past_days=past_days)
        keep = [h for h in fetched if h.valid_at in recent[_cell(h)]]
        written += _write(conn, source_ids["OPEN_METEO_FORECAST"], keep)
    if old:
        start = min(min(hs) for hs in old.values()).date()
        end = max(max(hs) for hs in old.values()).date()
        fetched = client.archive(list(old), start, end)
        keep = [h for h in fetched if h.valid_at in old[_cell(h)]]
        written += _write(conn, source_ids["OPEN_METEO_ARCHIVE"], keep)

    return WeatherStats(
        cells_assigned=assigned,
        hours_requested=sum(len(hs) for hs in wanted.values()),
        rows_written=written,
    )
