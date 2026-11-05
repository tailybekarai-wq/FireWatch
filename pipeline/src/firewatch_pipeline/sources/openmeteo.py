"""Open-Meteo weather client (archive = ERA5 reanalysis, forecast = recent hours).

Docs: https://open-meteo.com/en/docs/historical-weather-api and /en/docs.
Free tier: non-commercial use, CC BY 4.0, 600/min, 5000/h, 10000/day per IP.
To stay well inside those limits, weather is requested per 0.25 degree grid cell
(the ERA5 resolution), several cells per request, never per detection.

Weather is a fire-danger factor shown next to detections, not evidence of fire.
"""

from __future__ import annotations

import math
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

import httpx

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
USER_AGENT = "FireWatch/0.1 (+https://github.com/tailybekarai-wq/FireWatch)"
CELL_DEG = 0.25
MAX_CELLS_PER_REQUEST = 50
RETRY_STATUSES = {429, 500, 502, 503, 504}

COMMON_HOURLY = (
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "wind_direction_10m",
    "precipitation",
    "vapour_pressure_deficit",
)
# Soil moisture layers differ between the APIs; 0-7 cm exists only in the archive (ERA5).
ARCHIVE_HOURLY = (*COMMON_HOURLY, "soil_moisture_0_to_7cm")
ARCHIVE_MODEL = "era5"
FORECAST_MODEL = "best_match"


@dataclass(frozen=True)
class WeatherCell:
    cell_id: str
    lat: float
    lon: float


def cell_for(lat: float, lon: float) -> WeatherCell:
    """Nearest 0.25 degree grid point; detections in the same cell share one series."""
    cell_lat = round(lat / CELL_DEG) * CELL_DEG
    cell_lon = round(lon / CELL_DEG) * CELL_DEG
    return WeatherCell(f"g025_{cell_lat:+.2f}_{cell_lon:+.2f}", cell_lat, cell_lon)


@dataclass(frozen=True)
class WeatherHour:
    cell_id: str
    cell_lat: float
    cell_lon: float
    valid_at: datetime
    model: str
    temperature_2m_c: float | None
    relative_humidity_2m_pct: float | None
    wind_speed_10m_kmh: float | None
    wind_direction_10m_deg: float | None
    precipitation_mm: float | None
    vpd_kpa: float | None
    soil_moisture_0_7_m3m3: float | None


class OpenMeteoError(Exception):
    pass


def _value(series: dict[str, list[Any]], name: str, i: int) -> float | None:
    values = series.get(name)
    if values is None:
        return None
    v = values[i]
    if v is None:
        return None
    f = float(v)
    return None if math.isnan(f) else f


def parse_response(payload: Any, cells: Sequence[WeatherCell], model: str) -> list[WeatherHour]:
    """Parse a single- or multi-location response; locations come back in request order."""
    locations = payload if isinstance(payload, list) else [payload]
    if len(locations) != len(cells):
        raise OpenMeteoError(f"expected {len(cells)} locations, got {len(locations)}")
    hours: list[WeatherHour] = []
    for cell, location in zip(cells, locations, strict=True):
        if location.get("error"):
            raise OpenMeteoError(str(location.get("reason")))
        series: dict[str, list[Any]] = location.get("hourly") or {}
        times = series.get("time")
        if times is None:
            raise OpenMeteoError("response has no hourly.time")
        for name, values in series.items():
            if len(values) != len(times):
                raise OpenMeteoError(f"hourly.{name} length differs from hourly.time")
        for i, stamp in enumerate(times):
            hours.append(
                WeatherHour(
                    cell_id=cell.cell_id,
                    cell_lat=cell.lat,
                    cell_lon=cell.lon,
                    valid_at=datetime.fromisoformat(stamp).replace(tzinfo=UTC),
                    model=model,
                    temperature_2m_c=_value(series, "temperature_2m", i),
                    relative_humidity_2m_pct=_value(series, "relative_humidity_2m", i),
                    wind_speed_10m_kmh=_value(series, "wind_speed_10m", i),
                    wind_direction_10m_deg=_value(series, "wind_direction_10m", i),
                    precipitation_mm=_value(series, "precipitation", i),
                    vpd_kpa=_value(series, "vapour_pressure_deficit", i),
                    soil_moisture_0_7_m3m3=_value(series, "soil_moisture_0_to_7cm", i),
                )
            )
    return hours


def _chunks(cells: Sequence[WeatherCell], size: int) -> Iterable[Sequence[WeatherCell]]:
    for start in range(0, len(cells), size):
        yield cells[start : start + size]


class OpenMeteoClient:
    def __init__(
        self, http: httpx.Client | None = None, attempts: int = 3, backoff_s: float = 5.0
    ) -> None:
        self._http = http or httpx.Client(
            headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(60.0, connect=10.0)
        )
        self._attempts = attempts
        self._backoff_s = backoff_s

    def _get(self, url: str, params: dict[str, str]) -> Any:
        last = ""
        for attempt in range(1, self._attempts + 1):
            try:
                response = self._http.get(url, params=params)
            except httpx.HTTPError as exc:
                last = f"{type(exc).__name__}: {exc}"
            else:
                if response.status_code == 200:
                    return response.json()
                last = f"HTTP {response.status_code}: {response.text[:200]}"
                if response.status_code not in RETRY_STATUSES:
                    break
            if attempt < self._attempts:
                time.sleep(self._backoff_s * attempt)
        raise OpenMeteoError(last)

    @staticmethod
    def _location_params(cells: Sequence[WeatherCell]) -> dict[str, str]:
        return {
            "latitude": ",".join(f"{c.lat:.2f}" for c in cells),
            "longitude": ",".join(f"{c.lon:.2f}" for c in cells),
            "timezone": "GMT",
        }

    def archive(self, cells: Sequence[WeatherCell], start: date, end: date) -> list[WeatherHour]:
        """ERA5 hourly series (available with a ~5 day delay)."""
        hours: list[WeatherHour] = []
        for chunk in _chunks(cells, MAX_CELLS_PER_REQUEST):
            params = self._location_params(chunk) | {
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "hourly": ",".join(ARCHIVE_HOURLY),
                "models": ARCHIVE_MODEL,
            }
            hours += parse_response(self._get(ARCHIVE_URL, params), chunk, ARCHIVE_MODEL)
        return hours

    def recent(self, cells: Sequence[WeatherCell], past_days: int) -> list[WeatherHour]:
        """Recent hours from the forecast API, for detections newer than the archive."""
        if not 1 <= past_days <= 92:
            raise ValueError("past_days must be 1..92")
        hours: list[WeatherHour] = []
        for chunk in _chunks(cells, MAX_CELLS_PER_REQUEST):
            params = self._location_params(chunk) | {
                "past_days": str(past_days),
                "forecast_days": "1",
                "hourly": ",".join(COMMON_HOURLY),
            }
            hours += parse_response(self._get(FORECAST_URL, params), chunk, FORECAST_MODEL)
        return hours
