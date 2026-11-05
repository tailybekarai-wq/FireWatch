"""FIRMS CSV parsing. All rows below are SYNTHETIC test values in the real column format."""

from datetime import UTC, datetime

import pytest

from firewatch_pipeline.firms_parse import (
    FirmsSchemaError,
    dedup_key,
    expected_header,
    parse_firms_csv,
)
from firewatch_pipeline.sources.firms import PRODUCTS
from firewatch_shared.enums import ConfidenceLevel, ProcessingLevel

N20_NRT = PRODUCTS["FIRMS_VIIRS_NOAA20_NRT"]
N20_SP = PRODUCTS["FIRMS_VIIRS_NOAA20_SP"]
MODIS_NRT = PRODUCTS["FIRMS_MODIS_NRT"]

VIIRS_HEADER = ",".join(expected_header(N20_NRT))
MODIS_HEADER = ",".join(expected_header(MODIS_NRT))


def test_viirs_nrt_row_is_normalized() -> None:
    text = (
        f"{VIIRS_HEADER}\n50.1,70.2,330.5,0.5,0.6,2026-01-02,32,N20,VIIRS,h,2.0NRT,290.1,4.25,N\n"
    )
    result = parse_firms_csv(N20_NRT, text)
    assert result.rejected == []
    (row,) = result.rows
    assert row.observed_at == datetime(2026, 1, 2, 0, 32, tzinfo=UTC)  # "32" means 00:32
    assert (row.bright_main_k, row.bright_aux_k, row.frp_mw) == (330.5, 290.1, 4.25)
    assert row.confidence_level is ConfidenceLevel.HIGH
    assert row.processing_level is ProcessingLevel.NRT
    assert row.fire_type is None
    assert row.dedup_key == dedup_key("FIRMS_VIIRS_NOAA20_NRT", "N20", row.observed_at, 50.1, 70.2)


@pytest.mark.parametrize(
    ("version", "level"),
    [
        ("2.0NRT", ProcessingLevel.NRT),
        ("2.0RT", ProcessingLevel.RT),
        ("2.0URT", ProcessingLevel.URT),
    ],
)
def test_nrt_processing_level_from_version_suffix(version: str, level: ProcessingLevel) -> None:
    text = f"{VIIRS_HEADER}\n50,70,330,0.5,0.6,2026-01-02,1205,N20,VIIRS,n,{version},290,1,D\n"
    assert parse_firms_csv(N20_NRT, text).rows[0].processing_level is level


def test_sp_row_has_type_and_sp_level() -> None:
    header = ",".join(expected_header(N20_SP))
    text = f"{header}\n45,60,340,0.4,0.5,2025-08-15,555,N20,VIIRS,l,2,295,9.5,D,2\n"
    (row,) = parse_firms_csv(N20_SP, text).rows
    assert row.processing_level is ProcessingLevel.SP
    assert row.fire_type == 2
    assert row.observed_at == datetime(2025, 8, 15, 5, 55, tzinfo=UTC)
    assert row.confidence_level is ConfidenceLevel.LOW


@pytest.mark.parametrize(
    ("raw", "level"),
    [
        ("0", ConfidenceLevel.LOW),
        ("29", ConfidenceLevel.LOW),
        ("30", ConfidenceLevel.NOMINAL),
        ("79", ConfidenceLevel.NOMINAL),
        ("80", ConfidenceLevel.HIGH),
        ("100", ConfidenceLevel.HIGH),
    ],
)
def test_modis_confidence_classes(raw: str, level: ConfidenceLevel) -> None:
    text = f"{MODIS_HEADER}\n51,52,301,1.1,1.0,2026-01-02,111,Aqua,MODIS,{raw},6.1NRT,266,12,N\n"
    assert parse_firms_csv(MODIS_NRT, text).rows[0].confidence_level is level


@pytest.mark.parametrize(
    ("line", "reason"),
    [
        ("95,70,330,0.5,0.6,2026-01-02,32,N20,VIIRS,n,2.0NRT,290,4,N", "latitude"),
        ("50,70,330,0.5,0.6,2026-01-02,1260,N20,VIIRS,n,2.0NRT,290,4,N", "minutes"),
        ("50,70,330,0.5,0.6,2026-01-02,32,N21,VIIRS,n,2.0NRT,290,4,N", "unexpected satellite"),
        ("50,70,330,0.5,0.6,2026-01-02,32,N20,VIIRS,x,2.0NRT,290,4,N", "l/n/h"),
        ("50,70,330,0.5,0.6,2026-01-02,32,N20,VIIRS,n,2.0,290,4,N", "suffix"),
        ("50,70,330,0.5,0.6,2026-01-02,32,N20,VIIRS,n,2.0NRT,290,-1,N", "frp"),
        ("50,70,330,0.5,0.6,2026-01-02,32,N20,VIIRS,n,2.0NRT,290,4", "fields"),
    ],
)
def test_bad_rows_are_rejected_with_reason(line: str, reason: str) -> None:
    good = "50,70,330,0.5,0.6,2026-01-02,32,N20,VIIRS,n,2.0NRT,290,4,N"
    result = parse_firms_csv(N20_NRT, f"{VIIRS_HEADER}\n{good}\n{line}\n")
    assert len(result.rows) == 1
    assert len(result.rejected) == 1
    assert reason in result.rejected[0].reason
    assert result.received == 2


def test_header_only_means_no_detections() -> None:
    result = parse_firms_csv(N20_NRT, VIIRS_HEADER + "\n")
    assert result.rows == [] and result.rejected == []


def test_changed_header_is_a_schema_error() -> None:
    text = VIIRS_HEADER.replace("bright_ti5", "bright_t5") + "\n"
    with pytest.raises(FirmsSchemaError) as info:
        parse_firms_csv(N20_NRT, text)
    assert info.value.kind == "schema_changed"


def test_error_text_is_a_parse_error() -> None:
    with pytest.raises(FirmsSchemaError) as info:
        parse_firms_csv(N20_NRT, "Invalid MAP_KEY.")
    assert info.value.kind == "parse_error"


def test_dedup_key_ignores_version_but_not_position() -> None:
    t = datetime(2026, 1, 2, 0, 32, tzinfo=UTC)
    assert dedup_key("S", "N20", t, 50.12341, 70.0) == dedup_key("S", "N20", t, 50.12344, 70.0)
    assert dedup_key("S", "N20", t, 50.1234, 70.0) != dedup_key("S", "N20", t, 50.1235, 70.0)
