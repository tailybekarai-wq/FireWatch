"""Unit tests for OSM boundary assembly. Geometries here are synthetic test shapes."""

from typing import Any

import pytest

from firewatch_pipeline.regions import (
    build_records,
    osm_full_to_relation,
    relation_to_multipolygon,
    select_regions,
)


def _way(role: str, coords: list[tuple[float, float]]) -> dict[str, Any]:
    return {
        "type": "way",
        "role": role,
        "geometry": [{"lon": x, "lat": y} for x, y in coords],
    }


def _square_relation(rel_id: int, tags: dict[str, str]) -> dict[str, Any]:
    # 4x4 square split into two outer ways, with a 2x2 inner hole.
    return {
        "type": "relation",
        "id": rel_id,
        "tags": tags,
        "members": [
            _way("outer", [(0, 0), (4, 0), (4, 4)]),
            _way("outer", [(4, 4), (0, 4), (0, 0)]),
            _way("inner", [(1, 1), (3, 1), (3, 3), (1, 3), (1, 1)]),
            {"type": "node", "role": "admin_centre", "lat": 2, "lon": 2},
        ],
    }


def test_relation_assembles_split_outer_ring_and_hole() -> None:
    geom = relation_to_multipolygon(_square_relation(1, {}))
    assert geom.is_valid
    assert len(geom.geoms) == 1
    assert geom.area == pytest.approx(16 - 4)


def test_relation_without_closed_ring_is_rejected() -> None:
    relation = {"type": "relation", "id": 2, "members": [_way("outer", [(0, 0), (1, 0)])]}
    with pytest.raises(ValueError, match="no closed outer ring"):
        relation_to_multipolygon(relation)


def test_select_keeps_country_and_kz_units_only() -> None:
    elements = [
        _square_relation(10, {"admin_level": "2", "ISO3166-1": "KZ", "name": "Қазақстан"}),
        _square_relation(
            11,
            {
                "admin_level": "4",
                "ISO3166-2": "KZ-AKM",
                "name": "Ақмола облысы",
                "name:ru": "Акмолинская область",
                "name:kk": "Ақмола облысы",
            },
        ),
        _square_relation(12, {"admin_level": "4", "ISO3166-2": "RU-OMS", "name": "Омская"}),
        _square_relation(13, {"admin_level": "4", "name": "no iso code"}),
        {"type": "way", "id": 14, "tags": {"admin_level": "4", "ISO3166-2": "KZ-X"}},
    ]
    records = select_regions(elements)
    assert [(r.level, r.code, r.osm_relation_id) for r in records] == [
        (0, "KZ", 10),
        (1, "KZ-AKM", 11),
    ]
    assert records[1].name_ru == "Акмолинская область"
    assert records[1].name_en is None


def test_osm_api_full_document_is_converted() -> None:
    full = {
        "elements": [
            {"type": "node", "id": 1, "lat": 0, "lon": 0},
            {"type": "node", "id": 2, "lat": 0, "lon": 2},
            {"type": "node", "id": 3, "lat": 2, "lon": 2},
            {"type": "node", "id": 4, "lat": 2, "lon": 0},
            {"type": "way", "id": 10, "nodes": [1, 2, 3]},
            {"type": "way", "id": 11, "nodes": [3, 4, 1]},
            {
                "type": "relation",
                "id": 100,
                "tags": {"admin_level": "4", "ISO3166-2": "KZ-AKM", "name": "a"},
                "members": [
                    {"type": "way", "ref": 10, "role": "outer"},
                    {"type": "way", "ref": 11, "role": "outer"},
                    {"type": "node", "ref": 1, "role": "admin_centre"},
                ],
            },
        ]
    }
    relation = osm_full_to_relation(full, 100)
    assert [m["role"] for m in relation["members"]] == ["outer", "outer"]
    assert relation_to_multipolygon(relation).area == pytest.approx(4)


def test_country_is_built_from_units_when_absent() -> None:
    left = _square_relation(1, {"admin_level": "4", "ISO3166-2": "KZ-A", "name": "a"})
    right = _square_relation(2, {"admin_level": "4", "ISO3166-2": "KZ-B", "name": "b"})
    for member in right["members"]:
        for point in member.get("geometry", []):
            point["lon"] += 4
    doc = {"country_tags": {"name": "Қазақстан", "ISO3166-1": "KZ"}, "elements": [left, right]}

    records = build_records(doc)

    country = records[0]
    assert (country.level, country.code, country.name) == (0, "KZ", "Қазақстан")
    assert country.geometry.area == pytest.approx(2 * 12)


def test_select_rejects_duplicate_codes() -> None:
    tags = {"admin_level": "4", "ISO3166-2": "KZ-AKM", "name": "a"}
    with pytest.raises(ValueError, match="duplicate"):
        select_regions([_square_relation(1, tags), _square_relation(2, tags)])
