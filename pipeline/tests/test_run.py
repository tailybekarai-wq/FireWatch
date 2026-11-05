"""Orchestration logic without a database or network (stubs only, synthetic values)."""

from datetime import date
from typing import Any

import pytest

from firewatch_pipeline import backfill, run
from firewatch_pipeline.firms_parse import FirmsSchemaError
from firewatch_pipeline.sources.firms import PRODUCTS, FirmsError
from firewatch_shared.aoi import KAZAKHSTAN_BBOX
from firewatch_shared.enums import RunStatus


@pytest.mark.parametrize(
    ("outcomes", "weather_ok", "expected"),
    [
        ([True, True, True], True, RunStatus.SUCCESS),
        ([True, False, True], True, RunStatus.PARTIAL),
        ([True, True], False, RunStatus.PARTIAL),
        ([False, False, False], True, RunStatus.FAILED),
        ([False, False], False, RunStatus.FAILED),
        ([], True, RunStatus.SUCCESS),
    ],
)
def test_run_status(outcomes: list[bool], weather_ok: bool, expected: RunStatus) -> None:
    assert run.run_status(outcomes, weather_ok) is expected


class _FailingFirms:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    def area_csv(self, *args: Any, **kwargs: Any) -> Any:
        raise self.exc

    def redact(self, text: str) -> str:
        return text


def _patch_load(monkeypatch: pytest.MonkeyPatch, fetches: list[dict[str, Any]]) -> None:
    monkeypatch.setattr(
        run.load, "enabled_fire_sources", lambda conn: ["FIRMS_MODIS_NRT", "FIRMS_VIIRS_NOAA20_SP"]
    )

    def insert_fetch(conn: Any, **kwargs: Any) -> int:
        fetches.append(kwargs)
        return len(fetches)

    monkeypatch.setattr(run.load, "insert_fetch", insert_fetch)


def test_http_failure_is_recorded_and_run_continues(monkeypatch: pytest.MonkeyPatch) -> None:
    fetches: list[dict[str, Any]] = []
    _patch_load(monkeypatch, fetches)
    per_source: dict[str, Any] = {}
    errors: list[str] = []

    outcomes = run._ingest_sources(
        object(),
        7,
        _FailingFirms(FirmsError("timeout", "read timeout")),  # type: ignore[arg-type]
        KAZAKHSTAN_BBOX,
        2,
        {"FIRMS_MODIS_NRT": 3},
        per_source,
        errors,
    )

    # SP products are skipped by the scheduled run; the NRT one failed and was logged.
    assert outcomes == [False]
    assert errors == ["FIRMS_MODIS_NRT: read timeout"]
    assert fetches[0]["status"] == "timeout" and fetches[0]["run_id"] == 7
    assert fetches[0]["source_id"] == 3 and fetches[0]["error"] == "read timeout"


def test_schema_failure_is_counted(monkeypatch: pytest.MonkeyPatch) -> None:
    fetches: list[dict[str, Any]] = []
    _patch_load(monkeypatch, fetches)
    errors: list[str] = []
    outcomes = run._ingest_sources(
        object(),
        1,
        _FailingFirms(FirmsSchemaError("schema_changed", "header changed")),  # type: ignore[arg-type]
        KAZAKHSTAN_BBOX,
        2,
        {"FIRMS_MODIS_NRT": 3},
        {},
        errors,
    )
    assert outcomes == [False]
    assert errors == ["FIRMS_MODIS_NRT: header changed"]


def test_backfill_chunks_cover_range_exactly() -> None:
    windows = list(backfill.chunks(date(2025, 1, 1), date(2025, 1, 12)))
    assert windows == [(date(2025, 1, 1), 5), (date(2025, 1, 6), 5), (date(2025, 1, 11), 2)]
    year = list(backfill.chunks(date(2025, 1, 1), date(2025, 12, 31)))
    assert sum(span for _, span in year) == 365


def test_cached_response_is_redacted_and_marked(tmp_path: Any) -> None:
    product = PRODUCTS["FIRMS_VIIRS_NOAA20_SP"]
    path = backfill.cache_path(tmp_path, product, date(2025, 8, 15), 5)
    path.write_text("latitude\n", encoding="utf-8")
    response = backfill.cached_response(product, KAZAKHSTAN_BBOX, date(2025, 8, 15), 5, path)
    assert "/api/area/csv/***/VIIRS_NOAA20_SP/" in response.url_redacted
    assert response.params["from_cache"] == "true"
    assert path.name == "VIIRS_NOAA20_SP_2025-08-15_5.csv"
