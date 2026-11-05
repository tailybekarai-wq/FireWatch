"""HTTP client behaviour with a mocked transport (no network). Values are synthetic."""

from datetime import UTC, date, datetime

import httpx
import pytest

from firewatch_pipeline.sources.firms import PRODUCTS, FirmsClient, FirmsError
from firewatch_pipeline.sources.openmeteo import (
    OpenMeteoClient,
    OpenMeteoError,
    cell_for,
    parse_response,
)
from firewatch_shared.aoi import KAZAKHSTAN_BBOX

KEY = "0123456789abcdef0123456789abcdef"  # synthetic test key, not a secret  gitleaks:allow


def _firms(handler: httpx.MockTransport) -> FirmsClient:
    return FirmsClient(KEY, http=httpx.Client(transport=handler), backoff_s=0)


def test_firms_url_is_built_and_key_redacted() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, text="latitude,longitude\n")

    response = _firms(httpx.MockTransport(handler)).area_csv(
        PRODUCTS["FIRMS_VIIRS_NOAA20_NRT"], KAZAKHSTAN_BBOX, 2, date(2026, 1, 1)
    )
    assert seen == [
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/VIIRS_NOAA20_NRT/"
        "46.4,40.5,87.4,55.5/2/2026-01-01"
    ]
    assert KEY not in response.url_redacted
    assert "/api/area/csv/***/VIIRS_NOAA20_NRT/" in response.url_redacted
    assert len(response.sha256) == 64


def test_firms_retries_server_errors_then_succeeds() -> None:
    statuses = iter([503, 502, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(next(statuses), text="latitude\n")

    response = _firms(httpx.MockTransport(handler)).area_csv(
        PRODUCTS["FIRMS_MODIS_NRT"], KAZAKHSTAN_BBOX, 1
    )
    assert response.http_status == 200


def test_firms_client_error_is_not_retried_and_redacted() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(400, text=f"bad key {KEY}")

    with pytest.raises(FirmsError) as info:
        _firms(httpx.MockTransport(handler)).area_csv(
            PRODUCTS["FIRMS_MODIS_NRT"], KAZAKHSTAN_BBOX, 1
        )
    assert calls == 1
    assert info.value.kind == "http_error" and info.value.http_status == 400
    assert KEY not in str(info.value)


def test_firms_day_range_is_validated() -> None:
    client = _firms(httpx.MockTransport(lambda r: httpx.Response(200)))
    with pytest.raises(ValueError):
        client.area_csv(PRODUCTS["FIRMS_MODIS_NRT"], KAZAKHSTAN_BBOX, 6)


def test_cell_snaps_to_quarter_degree() -> None:
    cell = cell_for(51.13, 71.43)
    assert (cell.lat, cell.lon) == (51.25, 71.5)
    assert cell.cell_id == "g025_+51.25_+71.50"
    assert cell_for(51.20, 71.40) == cell


def test_openmeteo_multi_location_parse() -> None:
    cells = [cell_for(50, 70), cell_for(45, 80)]
    payload = [
        {
            "hourly": {
                "time": ["2026-01-01T00:00", "2026-01-01T01:00"],
                "temperature_2m": [-10.5, None],
                "relative_humidity_2m": [80, 81],
            }
        },
        {
            "hourly": {
                "time": ["2026-01-01T00:00", "2026-01-01T01:00"],
                "temperature_2m": [1.0, 2.0],
                "relative_humidity_2m": [50, 55],
            }
        },
    ]
    hours = parse_response(payload, cells, "era5")
    assert len(hours) == 4
    assert hours[0].valid_at == datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    assert hours[1].temperature_2m_c is None
    assert hours[0].vpd_kpa is None  # variable not requested
    assert {h.cell_id for h in hours} == {c.cell_id for c in cells}


def test_openmeteo_rejects_mismatched_series() -> None:
    payload = {"hourly": {"time": ["2026-01-01T00:00"], "temperature_2m": [1.0, 2.0]}}
    with pytest.raises(OpenMeteoError):
        parse_response(payload, [cell_for(50, 70)], "era5")


def test_openmeteo_archive_request_parameters() -> None:
    seen: list[httpx.QueryParams] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params)
        return httpx.Response(200, json={"hourly": {"time": []}})

    client = OpenMeteoClient(http=httpx.Client(transport=httpx.MockTransport(handler)))
    client.archive([cell_for(50, 70)], date(2025, 8, 1), date(2025, 8, 2))
    params = seen[0]
    assert params["models"] == "era5"
    assert params["timezone"] == "GMT"
    assert "soil_moisture_0_to_7cm" in params["hourly"]
    assert (params["latitude"], params["longitude"]) == ("50.00", "70.00")
