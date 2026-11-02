"""Load Kazakhstan administrative boundaries from OpenStreetMap into ``regions``.

Level 0 is the country, level 1 the regions (oblystar) and cities of republican
significance. Data is (c) OpenStreetMap contributors, ODbL 1.0. Two download paths:

* Overpass API (one query, preferred);
* the main OSM API 0.6 (``/relation/{id}/full``), used when the public Overpass
  instances are overloaded. The level-1 units are the ``subarea`` members of the
  Kazakhstan relation, and the country outline is the union of those units.

The normalized download is cached under ``data/raw/`` (gitignored).

Usage (repo root)::

    python -m firewatch_pipeline.regions --dry-run   # download/parse/validate only
    python -m firewatch_pipeline.regions             # write to the database
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import psycopg
from shapely import LineString, MultiPolygon, Polygon, make_valid
from shapely.geometry.base import BaseGeometry
from shapely.ops import polygonize, unary_union

from firewatch_shared.envfile import load_env_files, repo_env_files

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OSM_API_URL = "https://api.openstreetmap.org/api/0.6"
USER_AGENT = "FireWatch/0.1 (+https://github.com/tailybekarai-wq/FireWatch)"
SOURCE_CODE = "OSM_BOUNDARIES"
KAZAKHSTAN_RELATION_ID = 214665
# 17 regions + 3 cities of republican significance (Astana, Almaty, Shymkent) after
# the 2022 reform (Abai, Jetisu and Ulytau regions created).
EXPECTED_LEVEL1 = 20
# ~50 m: well below the 375 m VIIRS pixel, keeps the table small.
DEFAULT_TOLERANCE_DEG = 0.0005
RETRY_STATUSES = {429, 502, 503, 504}
# OSM API usage policy: keep it to roughly one request per second.
OSM_API_PAUSE_S = 1.0

QUERY = """[out:json][timeout:600];
area["ISO3166-1"="KZ"][admin_level=2][boundary=administrative]->.kz;
(
  relation["ISO3166-1"="KZ"][admin_level=2][boundary=administrative];
  relation(area.kz)[boundary=administrative][admin_level=4];
);
out geom;"""


@dataclass(frozen=True)
class RegionRecord:
    level: int
    code: str
    name: str
    name_kk: str | None
    name_ru: str | None
    name_en: str | None
    osm_relation_id: int
    geometry: MultiPolygon


# --- geometry assembly -------------------------------------------------------------


def _way_lines(relation: dict[str, Any], roles: set[str]) -> list[LineString]:
    lines = []
    for member in relation.get("members", []):
        if member.get("type") != "way" or member.get("role", "") not in roles:
            continue
        coords = [(p["lon"], p["lat"]) for p in member.get("geometry") or [] if p]
        if len(coords) >= 2:
            lines.append(LineString(coords))
    return lines


def _polygons(geom: BaseGeometry) -> list[Polygon]:
    if isinstance(geom, Polygon):
        return [geom] if not geom.is_empty else []
    if hasattr(geom, "geoms"):
        return [p for part in geom.geoms for p in _polygons(part)]
    return []


def _as_multipolygon(geom: BaseGeometry, what: str) -> MultiPolygon:
    parts = _polygons(make_valid(geom))
    if not parts:
        raise ValueError(f"{what} produced an empty geometry")
    return MultiPolygon(parts)


def relation_to_multipolygon(relation: dict[str, Any]) -> MultiPolygon:
    """Assemble an OSM boundary relation (Overpass ``out geom`` shape) into a MultiPolygon."""
    outer = list(polygonize(unary_union(_way_lines(relation, {"outer", ""}))))
    inner = list(polygonize(unary_union(_way_lines(relation, {"inner"}))))
    if not outer:
        raise ValueError(f"relation {relation.get('id')} has no closed outer ring")
    shape = unary_union(outer)
    if inner:
        shape = shape.difference(unary_union(inner))
    return _as_multipolygon(shape, f"relation {relation.get('id')}")


def _record(
    level: int, code: str, tags: dict[str, str], rel_id: int, geom: MultiPolygon
) -> RegionRecord:
    return RegionRecord(
        level=level,
        code=code,
        name=tags.get("name") or code,
        name_kk=tags.get("name:kk"),
        name_ru=tags.get("name:ru"),
        name_en=tags.get("name:en"),
        osm_relation_id=rel_id,
        geometry=geom,
    )


def _check_unique(records: list[RegionRecord]) -> list[RegionRecord]:
    codes = [(r.level, r.code) for r in records]
    duplicates = {c for c in codes if codes.count(c) > 1}
    if duplicates:
        raise ValueError(f"duplicate region codes: {sorted(duplicates)}")
    return sorted(records, key=lambda r: (r.level, r.code))


def select_regions(elements: list[dict[str, Any]]) -> list[RegionRecord]:
    """Pick Kazakhstan (level 0) and its first-level units (ISO 3166-2 ``KZ-*``)."""
    records: list[RegionRecord] = []
    for element in elements:
        if element.get("type") != "relation":
            continue
        tags: dict[str, str] = element.get("tags", {})
        admin_level = tags.get("admin_level")
        if admin_level == "2" and tags.get("ISO3166-1") == "KZ":
            level, code = 0, "KZ"
        elif admin_level == "4" and tags.get("ISO3166-2", "").startswith("KZ-"):
            level, code = 1, tags["ISO3166-2"]
        else:
            continue
        records.append(
            _record(level, code, tags, int(element["id"]), relation_to_multipolygon(element))
        )
    return _check_unique(records)


# --- OSM API 0.6 path --------------------------------------------------------------


def osm_full_to_relation(full: dict[str, Any], relation_id: int) -> dict[str, Any]:
    """Convert an OSM API ``/relation/{id}/full.json`` document to the Overpass shape."""
    nodes = {e["id"]: e for e in full["elements"] if e["type"] == "node"}
    ways = {e["id"]: e for e in full["elements"] if e["type"] == "way"}
    relation = next(
        e for e in full["elements"] if e["type"] == "relation" and e["id"] == relation_id
    )
    members = []
    for member in relation.get("members", []):
        if member["type"] != "way" or member["ref"] not in ways:
            continue
        geometry = [
            {"lat": nodes[n]["lat"], "lon": nodes[n]["lon"]}
            for n in ways[member["ref"]]["nodes"]
            if n in nodes
        ]
        members.append({"type": "way", "role": member.get("role", ""), "geometry": geometry})
    return {
        "type": "relation",
        "id": relation_id,
        "tags": relation.get("tags", {}),
        "members": members,
    }


def country_from_units(tags: dict[str, str], units: list[RegionRecord]) -> RegionRecord:
    geom = _as_multipolygon(unary_union([u.geometry for u in units]), "country union")
    return _record(0, "KZ", tags, KAZAKHSTAN_RELATION_ID, geom)


def _get_json(client: httpx.Client, url: str, attempts: int = 4) -> dict[str, Any]:
    for attempt in range(1, attempts + 1):
        response = client.get(url)
        if response.status_code in RETRY_STATUSES and attempt < attempts:
            time.sleep(5 * attempt)
            continue
        response.raise_for_status()
        data: dict[str, Any] = response.json()
        return data
    raise RuntimeError("unreachable")


def download_osm_api() -> dict[str, Any]:
    """Return a normalized document: ``{"source", "snapshot", "country_tags", "elements"}``."""
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=120.0) as client:
        country = _get_json(client, f"{OSM_API_URL}/relation/{KAZAKHSTAN_RELATION_ID}.json")
        country_rel = country["elements"][0]
        if country_rel.get("tags", {}).get("ISO3166-1") != "KZ":
            raise ValueError(f"relation {KAZAKHSTAN_RELATION_ID} is not tagged ISO3166-1=KZ")
        sub_ids = [
            m["ref"]
            for m in country_rel.get("members", [])
            if m["type"] == "relation" and m.get("role") == "subarea"
        ]
        elements = []
        for rel_id in sub_ids:
            time.sleep(OSM_API_PAUSE_S)
            full = _get_json(client, f"{OSM_API_URL}/relation/{rel_id}/full.json")
            elements.append(osm_full_to_relation(full, rel_id))
    return {
        "source": "api.openstreetmap.org/api/0.6",
        "snapshot": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "country_tags": country_rel.get("tags", {}),
        "elements": elements,
    }


def download_overpass() -> dict[str, Any]:
    with httpx.Client(
        headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(900.0, connect=30.0)
    ) as client:
        for attempt in range(1, 4):
            response = client.post(OVERPASS_URL, data={"data": QUERY})
            if response.status_code in RETRY_STATUSES and attempt < 3:
                time.sleep(15 * attempt)
                continue
            response.raise_for_status()
            data: dict[str, Any] = response.json()
            break
    osm_base = data.get("osm3s", {}).get("timestamp_osm_base")
    if not osm_base:
        raise ValueError("Overpass response has no osm3s.timestamp_osm_base")
    return {
        "source": "overpass-api.de",
        "snapshot": osm_base,
        "country_tags": None,
        "elements": data.get("elements", []),
    }


def build_records(doc: dict[str, Any]) -> list[RegionRecord]:
    records = select_regions(doc["elements"])
    if doc.get("country_tags") is not None and not any(r.level == 0 for r in records):
        units = [r for r in records if r.level == 1]
        records = _check_unique([*records, country_from_units(doc["country_tags"], units)])
    return records


# --- database ----------------------------------------------------------------------

UPSERT = """
INSERT INTO regions (level, code, name, name_kk, name_ru, name_en, parent_id, osm_relation_id,
                     geom, source, source_version)
VALUES (%(level)s, %(code)s, %(name)s, %(name_kk)s, %(name_ru)s, %(name_en)s, %(parent_id)s,
        %(osm_relation_id)s,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(
            ST_SimplifyPreserveTopology(ST_GeomFromText(%(wkt)s, 4326), %(tolerance)s)), 3)),
        %(source)s, %(source_version)s)
ON CONFLICT (level, code) DO UPDATE SET
    name = EXCLUDED.name, name_kk = EXCLUDED.name_kk, name_ru = EXCLUDED.name_ru,
    name_en = EXCLUDED.name_en, parent_id = EXCLUDED.parent_id,
    osm_relation_id = EXCLUDED.osm_relation_id, geom = EXCLUDED.geom,
    source = EXCLUDED.source, source_version = EXCLUDED.source_version, loaded_at = now()
RETURNING id
"""


def write_regions(
    conn: psycopg.Connection[Any],
    records: list[RegionRecord],
    source_version: str,
    tolerance: float,
) -> None:
    parent_id: int | None = None
    with conn.transaction():
        for record in records:  # sorted: the country (level 0) comes first
            row = conn.execute(
                UPSERT,
                {
                    "level": record.level,
                    "code": record.code,
                    "name": record.name,
                    "name_kk": record.name_kk,
                    "name_ru": record.name_ru,
                    "name_en": record.name_en,
                    "parent_id": parent_id if record.level == 1 else None,
                    "osm_relation_id": record.osm_relation_id,
                    "wkt": record.geometry.wkt,
                    "tolerance": tolerance,
                    "source": SOURCE_CODE,
                    "source_version": source_version,
                },
            ).fetchone()
            if record.level == 0 and row is not None:
                parent_id = int(row[0])


# --- CLI ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", choices=["auto", "overpass", "osm-api"], default="auto")
    parser.add_argument("--refresh", action="store_true", help="ignore the local cache")
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE_DEG)
    parser.add_argument("--cache-file", type=Path, default=repo_root / "data/raw/osm_kz_admin.json")
    parser.add_argument("--dry-run", action="store_true", help="download/parse/validate only")
    args = parser.parse_args(argv)

    if args.cache_file.is_file() and not args.refresh:
        doc: dict[str, Any] = json.loads(args.cache_file.read_text(encoding="utf-8"))
    else:
        if args.source == "osm-api":
            doc = download_osm_api()
        else:
            try:
                doc = download_overpass()
            except (httpx.HTTPError, ValueError) as exc:
                if args.source == "overpass":
                    raise
                print(f"Overpass unavailable ({exc}); falling back to the OSM API", file=sys.stderr)
                doc = download_osm_api()
        args.cache_file.parent.mkdir(parents=True, exist_ok=True)
        args.cache_file.write_text(json.dumps(doc), encoding="utf-8")

    records = build_records(doc)
    level0 = [r for r in records if r.level == 0]
    level1 = [r for r in records if r.level == 1]
    for r in records:
        print(f"  L{r.level} {r.code:<8} {r.name_ru or r.name}  (osm r{r.osm_relation_id})")
    print(
        f"source {doc['source']}, snapshot {doc['snapshot']}: "
        f"country={len(level0)} level1={len(level1)}"
    )
    if len(level0) != 1 or len(level1) != EXPECTED_LEVEL1:
        print(
            f"expected 1 country and {EXPECTED_LEVEL1} level-1 units; nothing written",
            file=sys.stderr,
        )
        return 1
    if args.dry_run:
        return 0

    load_env_files(repo_env_files(repo_root))
    url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL_WRITER")
    if not url:
        print("Set DATABASE_URL_UNPOOLED or DATABASE_URL_WRITER", file=sys.stderr)
        return 1
    source_version = (
        f"{doc['source']} snapshot {doc['snapshot']}; loaded {datetime.now(UTC):%Y-%m-%dT%H:%MZ}"
    )
    with psycopg.connect(url) as conn:
        write_regions(conn, records, source_version, args.tolerance)
    print(f"written {len(records)} regions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
