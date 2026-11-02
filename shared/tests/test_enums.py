"""Contract test: enum values are the exact strings documented for the DB and API."""

from firewatch_shared.enums import ConfidenceLevel, DayNight, ProcessingLevel, RiskLevel, RunStatus


def test_values_match_documented_contract() -> None:
    assert [e.value for e in ConfidenceLevel] == ["low", "nominal", "high"]
    assert [e.value for e in RiskLevel] == ["low", "moderate", "high", "very_high"]
    assert [e.value for e in ProcessingLevel] == ["URT", "RT", "NRT", "SP"]
    assert [e.value for e in DayNight] == ["D", "N"]
    assert [e.value for e in RunStatus] == ["running", "success", "partial", "failed"]
