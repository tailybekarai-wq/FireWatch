"""Validate and normalize FIRMS Area API CSV into rows for the ``detections`` table.

Formats were checked against real responses on 2026-11-03
(docs/findings/firms_schema_check.md):

* ``acq_time`` is HHMM UTC without leading zeros ("32" = 00:32, "555" = 05:55);
* NRT ``version`` ends with NRT/RT/URT ("2.0NRT", "6.1NRT"); SP has none ("2", "61.03");
* satellite codes are N20/N21/N (VIIRS) and Terra/Aqua (MODIS);
* VIIRS confidence is l/n/h, MODIS confidence is 0-100;
* only SP products carry the ``type`` column (0 vegetation fire, 1 volcano,
  2 other static land source, 3 offshore).

Any header change raises :class:`FirmsSchemaError` instead of silently
mis-reading columns; bad rows are returned as rejections with a reason.
"""

from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from firewatch_pipeline.sources.firms import FirmsProduct
from firewatch_shared.enums import ConfidenceLevel, DayNight, ProcessingLevel

VIIRS_COLUMNS = (
    "latitude",
    "longitude",
    "bright_ti4",
    "scan",
    "track",
    "acq_date",
    "acq_time",
    "satellite",
    "instrument",
    "confidence",
    "version",
    "bright_ti5",
    "frp",
    "daynight",
)
MODIS_COLUMNS = (
    "latitude",
    "longitude",
    "brightness",
    "scan",
    "track",
    "acq_date",
    "acq_time",
    "satellite",
    "instrument",
    "confidence",
    "version",
    "bright_t31",
    "frp",
    "daynight",
)
# Satellite code expected for each FIRMS product.
EXPECTED_SATELLITES: dict[str, frozenset[str]] = {
    "VIIRS_NOAA20_NRT": frozenset({"N20"}),
    "VIIRS_NOAA20_SP": frozenset({"N20"}),
    "VIIRS_NOAA21_NRT": frozenset({"N21"}),
    "VIIRS_NOAA21_SP": frozenset({"N21"}),
    "VIIRS_SNPP_NRT": frozenset({"N"}),
    "VIIRS_SNPP_SP": frozenset({"N"}),
    "MODIS_NRT": frozenset({"Terra", "Aqua"}),
    "MODIS_SP": frozenset({"Terra", "Aqua"}),
}
# MODIS 0-100 confidence -> classes, per the FIRMS FAQ (low < 30 <= nominal < 80 <= high).
MODIS_NOMINAL_FROM = 30
MODIS_HIGH_FROM = 80
VIIRS_CONFIDENCE = {
    "l": ConfidenceLevel.LOW,
    "n": ConfidenceLevel.NOMINAL,
    "h": ConfidenceLevel.HIGH,
}


class FirmsSchemaError(Exception):
    """The response is not the expected CSV (``source_fetches.status``)."""

    def __init__(self, kind: Literal["parse_error", "schema_changed"], message: str) -> None:
        super().__init__(message)
        self.kind = kind


class _RawRow(BaseModel):
    """Common columns, with VIIRS/MODIS brightness names mapped by the caller."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    bright_main: float = Field(gt=0)
    bright_aux: float = Field(gt=0)
    scan: float = Field(gt=0)
    track: float = Field(gt=0)
    acq_date: date
    acq_time: int = Field(ge=0, le=2359)
    satellite: str
    instrument: Literal["VIIRS", "MODIS"]
    confidence: str
    version: str = Field(min_length=1)
    frp: float = Field(ge=0)
    daynight: DayNight
    type: int | None = Field(default=None, ge=0, le=3)

    @field_validator("acq_time")
    @classmethod
    def _minutes(cls, value: int) -> int:
        if value % 100 >= 60:
            raise ValueError("acq_time minutes must be < 60")
        return value


@dataclass(frozen=True)
class NormalizedDetection:
    dedup_key: str
    source_code: str
    satellite: str
    instrument: str
    observed_at: datetime
    latitude: float
    longitude: float
    bright_main_k: float
    bright_aux_k: float
    frp_mw: float
    confidence_raw: str
    confidence_level: ConfidenceLevel
    scan_km: float
    track_km: float
    daynight: DayNight
    product_version: str
    processing_level: ProcessingLevel
    fire_type: int | None


@dataclass(frozen=True)
class RejectedRow:
    raw: dict[str, str]
    reason: str


@dataclass(frozen=True)
class ParseResult:
    rows: list[NormalizedDetection]
    rejected: list[RejectedRow]

    @property
    def received(self) -> int:
        return len(self.rows) + len(self.rejected)


def dedup_key(
    source_code: str, satellite: str, observed_at: datetime, lat: float, lon: float
) -> str:
    """Stable identity of one detection; deliberately excludes ``version`` so that
    URT/RT records are updated in place when the NRT version arrives."""
    material = f"{source_code}|{satellite}|{observed_at:%Y-%m-%dT%H:%MZ}|{lat:.4f}|{lon:.4f}"
    return hashlib.sha1(material.encode(), usedforsecurity=False).hexdigest()


def _processing_level(product: FirmsProduct, version: str) -> ProcessingLevel:
    if product.processing == "SP":
        return ProcessingLevel.SP
    for suffix in (ProcessingLevel.URT, ProcessingLevel.NRT, ProcessingLevel.RT):
        if version.endswith(suffix.value):  # URT and NRT before RT: both end with "RT"
            return suffix
    raise ValueError(f"NRT version without NRT/RT/URT suffix: {version!r}")


def _confidence(instrument: str, raw: str) -> ConfidenceLevel:
    if instrument == "VIIRS":
        if raw not in VIIRS_CONFIDENCE:
            raise ValueError(f"VIIRS confidence must be l/n/h, got {raw!r}")
        return VIIRS_CONFIDENCE[raw]
    if not raw.isdigit() or not 0 <= int(raw) <= 100:
        raise ValueError(f"MODIS confidence must be 0-100, got {raw!r}")
    value = int(raw)
    if value >= MODIS_HIGH_FROM:
        return ConfidenceLevel.HIGH
    if value >= MODIS_NOMINAL_FROM:
        return ConfidenceLevel.NOMINAL
    return ConfidenceLevel.LOW


def expected_header(product: FirmsProduct) -> tuple[str, ...]:
    columns = VIIRS_COLUMNS if product.instrument == "VIIRS" else MODIS_COLUMNS
    return (*columns, "type") if product.processing == "SP" else columns


def _normalize(product: FirmsProduct, raw: dict[str, str]) -> NormalizedDetection:
    bright = (
        ("bright_ti4", "bright_ti5")
        if product.instrument == "VIIRS"
        else ("brightness", "bright_t31")
    )
    values: dict[str, Any] = {k: v for k, v in raw.items() if k not in bright}
    values["bright_main"] = raw[bright[0]]
    values["bright_aux"] = raw[bright[1]]
    row = _RawRow.model_validate(values)
    if row.instrument != product.instrument:
        raise ValueError(f"instrument {row.instrument} does not match product")
    if row.satellite not in EXPECTED_SATELLITES[product.api_product]:
        raise ValueError(f"unexpected satellite {row.satellite!r} for {product.api_product}")
    observed_at = datetime.combine(
        row.acq_date, time(row.acq_time // 100, row.acq_time % 100), tzinfo=UTC
    )
    return NormalizedDetection(
        dedup_key=dedup_key(
            product.source_code, row.satellite, observed_at, row.latitude, row.longitude
        ),
        source_code=product.source_code,
        satellite=row.satellite,
        instrument=row.instrument,
        observed_at=observed_at,
        latitude=row.latitude,
        longitude=row.longitude,
        bright_main_k=row.bright_main,
        bright_aux_k=row.bright_aux,
        frp_mw=row.frp,
        confidence_raw=row.confidence,
        confidence_level=_confidence(row.instrument, row.confidence),
        scan_km=row.scan,
        track_km=row.track,
        daynight=row.daynight,
        product_version=row.version,
        processing_level=_processing_level(product, row.version),
        fire_type=row.type,
    )


def parse_firms_csv(product: FirmsProduct, text: str) -> ParseResult:
    lines = text.lstrip("﻿").splitlines()
    if not lines or "," not in lines[0]:
        raise FirmsSchemaError("parse_error", f"not a CSV response: {text[:200]!r}")
    reader = csv.reader(io.StringIO("\n".join(lines)))
    header = tuple(h.strip() for h in next(reader))
    if header != expected_header(product):
        raise FirmsSchemaError(
            "schema_changed",
            f"{product.api_product} header changed: got {','.join(header)}",
        )
    rows: list[NormalizedDetection] = []
    rejected: list[RejectedRow] = []
    for values in reader:
        if not any(v.strip() for v in values):
            continue
        raw = dict(zip(header, values, strict=False))
        if len(values) != len(header):
            rejected.append(RejectedRow(raw, f"expected {len(header)} fields, got {len(values)}"))
            continue
        try:
            rows.append(_normalize(product, raw))
        except (ValidationError, ValueError) as exc:
            reason = (
                "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors())
                if isinstance(exc, ValidationError)
                else str(exc)
            )
            rejected.append(RejectedRow(raw, reason))
    return ParseResult(rows=rows, rejected=rejected)
