"""Labels from MODIS Burned Area MCD64A1 v6.1 (ML_STRATEGY §2.1).

Burn_Date rasters (sinusoidal tiles, 463 m pixels, day of year; 0 unburned, -1 unmapped,
-2 water) are read from the Microsoft Planetary Computer STAC catalogue: free, no account,
anonymous SAS token. Files are cached under ``data/raw/ml/mcd64a1`` (gitignored).

For a detection at (lat, lon, t):
- positive (1): a burned pixel within 1 pixel (3x3, ~500 m) with BurnDate in [t-5, t+16] d;
- negative (0): no burned pixel within 2 pixels (5x5, ~1 km) with |BurnDate - t| <= 60 d;
- ambiguous (-1): anything else, or the pixel is water / unmapped in the month of t.
Ambiguous rows are excluded from training and evaluation and counted in the report.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import httpx
import numpy as np
import pandas as pd
import rasterio

from firewatch_pipeline.run import REPO_ROOT
from firewatch_shared.aoi import KAZAKHSTAN_BBOX

COLLECTION = "modis-64A1-061"
STAC_SEARCH = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SAS_API = "https://planetarycomputer.microsoft.com/api/sas/v1/token"
CACHE_DIR = REPO_ROOT / "data/raw/ml/mcd64a1"

# MODIS sinusoidal grid
R_EARTH = 6371007.181
TILE_M = 1111950.5197665554
PIXELS = 2400
PIXEL_M = TILE_M / PIXELS
X_MIN = -20015109.354
Y_MAX = 10007554.677

POS_BEFORE, POS_AFTER = 5, 16
NEG_WINDOW = 60
POS_RADIUS, NEG_RADIUS = 1, 2  # pixels

POSITIVE, NEGATIVE, AMBIGUOUS = 1, 0, -1


@dataclass(frozen=True)
class Granule:
    tile: tuple[int, int]
    month: date
    href: str
    item_id: str


def sinusoidal_pixel(
    lat: np.ndarray, lon: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(h, v, row, col) of the MODIS sinusoidal pixel containing each point."""
    y = R_EARTH * np.radians(lat)
    x = R_EARTH * np.radians(lon) * np.cos(np.radians(lat))
    h, col = np.divmod(np.floor((x - X_MIN) / PIXEL_M).astype(np.int64), PIXELS)
    v, row = np.divmod(np.floor((Y_MAX - y) / PIXEL_M).astype(np.int64), PIXELS)
    return h, v, row, col


def next_month(m: date) -> date:
    return date(m.year + (m.month == 12), m.month % 12 + 1, 1)


def months(start: date, end: date) -> Iterator[date]:
    m = date(start.year, start.month, 1)
    while m <= end:
        yield m
        m = next_month(m)


def find_granules(start: date, end: date, client: httpx.Client) -> list[Granule]:
    """All Burn_Date granules over the project bbox with month start in [start, end]."""
    b = KAZAKHSTAN_BBOX
    out = []
    for month in months(start, end):
        r = client.post(
            STAC_SEARCH,
            json={
                "collections": [COLLECTION],
                "bbox": [b.west, b.south, b.east, b.north],
                "datetime": f"{month.isoformat()}T00:00:00Z/{month.isoformat()}T23:59:59Z",
                "limit": 100,
            },
        )
        r.raise_for_status()
        for f in r.json()["features"]:
            props = f["properties"]
            tile = (int(props["modis:horizontal-tile"]), int(props["modis:vertical-tile"]))
            out.append(Granule(tile, month, f["assets"]["Burn_Date"]["href"], f["id"]))
    return out


def _container(href: str) -> tuple[str, str]:
    """(storage account, container) of a blob URL; SAS tokens are issued per container."""
    url = httpx.URL(href)
    return url.host.split(".")[0], url.path.lstrip("/").split("/")[0]


def _token(client: httpx.Client, account: str, container: str) -> str:
    r = client.get(f"{SAS_API}/{account}/{container}").raise_for_status()
    return str(r.json()["token"])


def fetch(granule: Granule, client: httpx.Client, tokens: dict[tuple[str, str], str]) -> Path:
    path = CACHE_DIR / f"{granule.item_id}.Burn_Date.tif"
    if path.exists():
        return path
    key = _container(granule.href)
    if key not in tokens:
        tokens[key] = _token(client, *key)
    r = client.get(f"{granule.href}?{tokens[key]}")
    if r.status_code == 403:  # anonymous tokens expire; get a fresh one once
        tokens[key] = _token(client, *key)
        r = client.get(f"{granule.href}?{tokens[key]}")
    r.raise_for_status()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(r.content)
    tmp.replace(path)
    return path


def label(frame: pd.DataFrame, log_every: int = 50) -> tuple[np.ndarray, dict[str, int]]:
    """Label every row of ``frame`` (observed_at UTC, latitude, longitude)."""
    t_day = frame["observed_at"].dt.tz_convert("UTC").dt.tz_localize(None)
    t_day = t_day.to_numpy().astype("datetime64[D]")
    h, v, row, col = sinusoidal_pixel(frame["latitude"].to_numpy(), frame["longitude"].to_numpy())
    n = len(frame)
    pos = np.zeros(n, dtype=bool)
    near = np.zeros(n, dtype=bool)
    invalid = np.zeros(n, dtype=bool)
    seen = np.zeros(n, dtype=bool)  # the month of t was mapped for this tile

    offsets = np.arange(-NEG_RADIUS, NEG_RADIUS + 1)
    dr, dc = (a.ravel() for a in np.meshgrid(offsets, offsets, indexing="ij"))
    inner = (np.abs(dr) <= POS_RADIUS) & (np.abs(dc) <= POS_RADIUS)
    center = len(dr) // 2

    first = (pd.Timestamp(t_day.min()) - pd.Timedelta(days=NEG_WINDOW)).date()
    last = (pd.Timestamp(t_day.max()) + pd.Timedelta(days=NEG_WINDOW)).date()
    stats = {"granules": 0}
    with httpx.Client(timeout=180, follow_redirects=True) as client:
        granules = find_granules(first, last, client)
        tokens: dict[tuple[str, str], str] = {}
        for i, g in enumerate(granules):
            m0 = np.datetime64(g.month, "D")
            m1 = np.datetime64(next_month(g.month), "D")
            sel = np.flatnonzero(
                (h == g.tile[0])
                & (v == g.tile[1])
                & (t_day >= m0 - NEG_WINDOW)
                & (t_day < m1 + NEG_WINDOW)
            )
            if not len(sel):
                continue
            with rasterio.open(fetch(g, client, tokens)) as src:
                burn = src.read(1)
            rr = np.clip(row[sel, None] + dr[None, :], 0, PIXELS - 1)
            cc = np.clip(col[sel, None] + dc[None, :], 0, PIXELS - 1)
            win = burn[rr, cc].astype(np.int64)
            jan1 = np.datetime64(date(g.month.year, 1, 1), "D")
            burned = win > 0
            delta = ((jan1 + (win - 1)) - t_day[sel, None]).astype(np.int64)
            pos[sel] |= np.any(
                burned & inner[None, :] & (delta >= -POS_BEFORE) & (delta <= POS_AFTER), axis=1
            )
            near[sel] |= np.any(burned & (np.abs(delta) <= NEG_WINDOW), axis=1)
            own = (t_day[sel] >= m0) & (t_day[sel] < m1)
            seen[sel[own]] = True
            invalid[sel[own]] |= win[own, center] < 0
            stats["granules"] += 1
            if log_every and (i + 1) % log_every == 0:
                print(f"labels: {i + 1}/{len(granules)} granules", flush=True)

    y = np.full(n, AMBIGUOUS, dtype=np.int8)
    y[~near] = NEGATIVE
    y[pos] = POSITIVE
    unusable = invalid | ~seen
    y[unusable] = AMBIGUOUS
    stats.update(
        positive=int((y == POSITIVE).sum()),
        negative=int((y == NEGATIVE).sum()),
        ambiguous=int((y == AMBIGUOUS).sum()),
        unmapped_or_water=int(unusable.sum()),
    )
    return y, stats
