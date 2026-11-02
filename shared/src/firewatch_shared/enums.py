"""Enumerations shared by the database layer, the pipeline and the API.

Values are the exact strings stored in the database and returned by the API
(docs/DATABASE_SCHEMA.md, docs/API_SPECIFICATION.md).
"""

from enum import StrEnum


class ConfidenceLevel(StrEnum):
    """Normalized detection confidence (VIIRS l/n/h; MODIS 0-100 mapped to classes)."""

    LOW = "low"
    NOMINAL = "nominal"
    HIGH = "high"


class RiskLevel(StrEnum):
    """Level derived from a validated ML model's calibrated probability."""

    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    VERY_HIGH = "very_high"


class ProcessingLevel(StrEnum):
    """FIRMS processing level, taken from the suffix of the ``version`` field."""

    URT = "URT"
    RT = "RT"
    NRT = "NRT"
    SP = "SP"


class DayNight(StrEnum):
    DAY = "D"
    NIGHT = "N"


class RunStatus(StrEnum):
    RUNNING = "running"
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
