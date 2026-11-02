import pytest
from pydantic import ValidationError

from firewatch_shared.aoi import KAZAKHSTAN_BBOX, BBox


def test_parse_valid() -> None:
    bbox = BBox.parse(" 46.4, 40.5 ,87.4,55.5 ")
    assert bbox == KAZAKHSTAN_BBOX


def test_firms_param_roundtrip() -> None:
    assert KAZAKHSTAN_BBOX.to_firms_param() == "46.4,40.5,87.4,55.5"
    assert BBox.parse(KAZAKHSTAN_BBOX.to_firms_param()) == KAZAKHSTAN_BBOX


@pytest.mark.parametrize(
    "value",
    [
        "46.4,40.5,87.4",  # too few values
        "46.4,40.5,87.4,55.5,1",  # too many values
        "a,40.5,87.4,55.5",  # not a number
    ],
)
def test_parse_rejects_malformed(value: str) -> None:
    with pytest.raises(ValueError):
        BBox.parse(value)


@pytest.mark.parametrize(
    "value",
    [
        "87.4,40.5,46.4,55.5",  # west >= east
        "46.4,55.5,87.4,40.5",  # south >= north
        "-181,40.5,87.4,55.5",  # longitude out of range
        "46.4,40.5,87.4,91",  # latitude out of range
    ],
)
def test_parse_rejects_invalid_geometry(value: str) -> None:
    with pytest.raises(ValidationError):
        BBox.parse(value)


def test_contains_edges() -> None:
    assert KAZAKHSTAN_BBOX.contains(lon=71.43, lat=51.13)
    assert KAZAKHSTAN_BBOX.contains(lon=46.4, lat=40.5)
    assert not KAZAKHSTAN_BBOX.contains(lon=37.6, lat=55.7)
