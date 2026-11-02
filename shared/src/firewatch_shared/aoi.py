"""Area of interest (bounding box) handling.

The same parser is used for the pipeline's ``AOI_BBOX`` setting and for the
API's ``bbox`` query parameter, so both reject malformed input identically.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator


class BBox(BaseModel):
    """Geographic bounding box in WGS84 degrees, ordered west, south, east, north.

    Boxes crossing the antimeridian are not supported (not needed for Kazakhstan).
    """

    model_config = ConfigDict(frozen=True)

    west: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)

    @model_validator(mode="after")
    def _check_order(self) -> BBox:
        if self.west >= self.east:
            raise ValueError("west must be less than east")
        if self.south >= self.north:
            raise ValueError("south must be less than north")
        return self

    @classmethod
    def parse(cls, value: str) -> BBox:
        """Parse ``"W,S,E,N"`` (the order used by the FIRMS Area API)."""
        parts = [p.strip() for p in value.split(",")]
        if len(parts) != 4:
            raise ValueError("bbox must have exactly 4 comma-separated numbers: W,S,E,N")
        try:
            west, south, east, north = (float(p) for p in parts)
        except ValueError as exc:
            raise ValueError("bbox values must be numbers") from exc
        return cls(west=west, south=south, east=east, north=north)

    def to_firms_param(self) -> str:
        """Format for the ``AREA_COORDINATES`` path segment of the FIRMS Area API."""
        return f"{self.west:g},{self.south:g},{self.east:g},{self.north:g}"

    def contains(self, lon: float, lat: float) -> bool:
        return self.west <= lon <= self.east and self.south <= lat <= self.north


# Kazakhstan with a small margin around the national border (docs/PROJECT_OVERVIEW.md §6).
KAZAKHSTAN_BBOX = BBox(west=46.4, south=40.5, east=87.4, north=55.5)
