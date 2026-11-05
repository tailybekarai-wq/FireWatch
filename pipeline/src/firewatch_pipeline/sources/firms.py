"""NASA FIRMS Area API client.

Docs: https://firms.modaps.eosdis.nasa.gov/api/area/ . Limits: 5000 transactions per
10 minutes per MAP_KEY, DAY_RANGE 1..5. The MAP_KEY is part of the URL path, so every
URL that leaves this module (logs, the database) is redacted first.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Literal

import httpx

from firewatch_shared.aoi import BBox

BASE_URL = "https://firms.modaps.eosdis.nasa.gov"
USER_AGENT = "FireWatch/0.1 (+https://github.com/tailybekarai-wq/FireWatch)"
MAX_DAY_RANGE = 5
RETRY_STATUSES = {429, 500, 502, 503, 504}

Instrument = Literal["VIIRS", "MODIS"]
Processing = Literal["NRT", "SP"]


@dataclass(frozen=True)
class FirmsProduct:
    source_code: str  # data_sources.code
    api_product: str  # FIRMS SOURCE path segment
    instrument: Instrument
    processing: Processing


PRODUCTS: dict[str, FirmsProduct] = {
    p.source_code: p
    for p in (
        FirmsProduct("FIRMS_VIIRS_NOAA20_NRT", "VIIRS_NOAA20_NRT", "VIIRS", "NRT"),
        FirmsProduct("FIRMS_VIIRS_NOAA21_NRT", "VIIRS_NOAA21_NRT", "VIIRS", "NRT"),
        FirmsProduct("FIRMS_MODIS_NRT", "MODIS_NRT", "MODIS", "NRT"),
        FirmsProduct("FIRMS_VIIRS_SNPP_NRT", "VIIRS_SNPP_NRT", "VIIRS", "NRT"),
        FirmsProduct("FIRMS_VIIRS_NOAA20_SP", "VIIRS_NOAA20_SP", "VIIRS", "SP"),
        FirmsProduct("FIRMS_VIIRS_NOAA21_SP", "VIIRS_NOAA21_SP", "VIIRS", "SP"),
        FirmsProduct("FIRMS_VIIRS_SNPP_SP", "VIIRS_SNPP_SP", "VIIRS", "SP"),
        FirmsProduct("FIRMS_MODIS_SP", "MODIS_SP", "MODIS", "SP"),
    )
}


class FirmsError(Exception):
    """A request that did not produce a usable response.

    ``kind`` matches ``source_fetches.status``: http_error | timeout.
    """

    def __init__(
        self, kind: Literal["http_error", "timeout"], message: str, http_status: int | None = None
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.http_status = http_status


@dataclass(frozen=True)
class FirmsResponse:
    product: FirmsProduct
    url_redacted: str
    params: dict[str, str]
    requested_at: datetime
    responded_at: datetime
    http_status: int
    body: bytes

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.body).hexdigest()

    @property
    def text(self) -> str:
        return self.body.decode("utf-8")


class FirmsClient:
    def __init__(
        self,
        map_key: str,
        *,
        base_url: str = BASE_URL,
        http: httpx.Client | None = None,
        attempts: int = 3,
        backoff_s: float = 5.0,
    ) -> None:
        if not map_key or not map_key.strip():
            raise ValueError("FIRMS MAP_KEY is empty")
        self._key = map_key.strip()
        self._base = base_url.rstrip("/")
        self._http = http or httpx.Client(
            headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(60.0, connect=10.0)
        )
        self._attempts = attempts
        self._backoff_s = backoff_s

    def redact(self, text: str) -> str:
        return text.replace(self._key, "***")

    def _get(self, path: str) -> tuple[httpx.Response, datetime]:
        url = f"{self._base}{path}"
        last: Exception | None = None
        for attempt in range(1, self._attempts + 1):
            try:
                response = self._http.get(url)
            except httpx.TimeoutException as exc:
                last = FirmsError("timeout", self.redact(f"timeout: {exc}"))
            except httpx.HTTPError as exc:
                last = FirmsError("http_error", self.redact(f"{type(exc).__name__}: {exc}"))
            else:
                if response.status_code not in RETRY_STATUSES:
                    return response, datetime.now(UTC)
                last = FirmsError(
                    "http_error", f"HTTP {response.status_code}", response.status_code
                )
            if attempt < self._attempts:
                time.sleep(self._backoff_s * attempt)
        if last is None:  # unreachable: the loop runs at least once
            raise RuntimeError("no request attempts were made")
        raise last

    def area_csv(
        self, product: FirmsProduct, bbox: BBox, day_range: int, start: date | None = None
    ) -> FirmsResponse:
        """Detections in ``bbox`` for ``day_range`` days (ending today, or from ``start``)."""
        if not 1 <= day_range <= MAX_DAY_RANGE:
            raise ValueError(f"day_range must be 1..{MAX_DAY_RANGE}")
        path = (
            f"/api/area/csv/{self._key}/{product.api_product}/{bbox.to_firms_param()}/{day_range}"
        )
        if start is not None:
            path += f"/{start.isoformat()}"
        params = {
            "source": product.api_product,
            "bbox": bbox.to_firms_param(),
            "day_range": str(day_range),
            "date": start.isoformat() if start else "",
        }
        requested_at = datetime.now(UTC)
        response, responded_at = self._get(path)
        if response.status_code != 200:
            raise FirmsError(
                "http_error",
                self.redact(f"HTTP {response.status_code}: {response.text[:200]}"),
                response.status_code,
            )
        return FirmsResponse(
            product=product,
            url_redacted=self.redact(f"{self._base}{path}"),
            params=params,
            requested_at=requested_at,
            responded_at=responded_at,
            http_status=response.status_code,
            body=response.content,
        )

    def data_availability(self) -> dict[str, tuple[date, date]]:
        response, _ = self._get(f"/api/data_availability/csv/{self._key}/ALL")
        if response.status_code != 200:
            raise FirmsError("http_error", f"HTTP {response.status_code}", response.status_code)
        result: dict[str, tuple[date, date]] = {}
        lines = response.text.strip().splitlines()
        if not lines or lines[0].strip() != "data_id,min_date,max_date":
            raise FirmsError("http_error", self.redact(f"unexpected body: {response.text[:200]}"))
        for line in lines[1:]:
            data_id, min_date, max_date = line.strip().split(",")
            result[data_id] = (date.fromisoformat(min_date), date.fromisoformat(max_date))
        return result
