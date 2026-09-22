#!/usr/bin/env python3
"""Turn the vendored datasets into the compact blobs embedded in the page.

Outputs (both committed, both consumed by build.py):

  assets/basemap.json   country outlines, 1:50m Natural Earth, re-encoded as
                        zigzag varint strings instead of JSON number arrays
  assets/cities.json    GeoNames cities above a population cut-off, used to
                        name the places you spent time in

Run tools/fetch_data.py first.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
ASSETS = ROOT / "assets"

# Cities below this many inhabitants are dropped. 20k keeps the file small
# while still naming anywhere most people actually sleep.
MIN_POPULATION = 20_000
# Cities are stored at 1e-4 degrees, about 11 m -- far finer than we need to
# pick the nearest town.
CITY_PRECISION = 1e4

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def encode_ints(values) -> str:
    """Zigzag varint, five bits per character, base64url alphabet."""
    out = []
    for v in values:
        v = (v << 1) ^ (v >> 63) if v < 0 else (v << 1)
        while v >= 32:
            out.append(ALPHABET[(v & 31) | 32])
            v >>= 5
        out.append(ALPHABET[v])
    return "".join(out)


# --------------------------------------------------------------------------
# basemap
# --------------------------------------------------------------------------

def build_basemap() -> dict:
    src = json.loads((VENDOR / "world-atlas" / "countries-50m.json").read_text())
    transform = src["transform"]
    arcs = src["arcs"]

    flat: list[int] = []
    lengths: list[int] = []
    for arc in arcs:
        lengths.append(len(arc))
        # TopoJSON arcs are already delta encoded after the first point.
        for x, y in arc:
            flat.append(x)
            flat.append(y)

    countries = []
    for geom in src["objects"]["countries"]["geometries"]:
        name = geom.get("properties", {}).get("name")
        if not name:
            continue
        if geom["type"] == "Polygon":
            rings = geom["arcs"]
        elif geom["type"] == "MultiPolygon":
            rings = [ring for poly in geom["arcs"] for ring in poly]
        else:
            continue
        # Flatten to "ring lengths + arc ids" so the JSON stays shallow.
        ring_lengths = [len(r) for r in rings]
        ids = [i for r in rings for i in r]
        countries.append({
            "n": name,
            "r": ring_lengths,
            "a": encode_ints(ids),
        })

    return {
        "transform": [
            transform["scale"][0], transform["scale"][1],
            transform["translate"][0], transform["translate"][1],
        ],
        "arcLengths": encode_ints(lengths),
        "arcs": encode_ints(flat),
        "countries": countries,
    }


# --------------------------------------------------------------------------
# cities
# --------------------------------------------------------------------------

def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def read_cities_pbf(path: Path):
    """Decode all-the-cities' protobuf: a bare sequence of length-delimited
    city messages, with coordinates delta encoded across the whole stream."""
    buf = path.read_bytes()
    pos = 0
    last_lon = 0
    last_lat = 0
    end_of_file = len(buf)
    while pos < end_of_file:
        length, pos = read_varint(buf, pos)
        end = pos + length
        city = {"name": "", "country": "", "population": 0}
        while pos < end:
            key, pos = read_varint(buf, pos)
            field, wire = key >> 3, key & 7
            if wire == 2:
                slen, pos = read_varint(buf, pos)
                value = buf[pos:pos + slen].decode("utf-8", "replace")
                pos += slen
                if field == 2:
                    city["name"] = value
                elif field == 3:
                    city["country"] = value
            elif wire == 0:
                value, pos = read_varint(buf, pos)
                if field == 9:
                    city["population"] = value
                elif field == 10:
                    last_lon += (value >> 1) ^ -(value & 1)
                elif field == 11:
                    last_lat += (value >> 1) ^ -(value & 1)
                # fields 1 (id) and anything else are ignored
        city["lon"] = last_lon / 1e5
        city["lat"] = last_lat / 1e5
        yield city


def build_cities() -> dict:
    cities = [
        c for c in read_cities_pbf(VENDOR / "all-the-cities" / "cities.pbf")
        if c["population"] >= MIN_POPULATION
    ]
    # Sorting by longitude keeps the coordinate deltas small.
    cities.sort(key=lambda c: (round(c["lon"] * CITY_PRECISION), round(c["lat"] * CITY_PRECISION)))

    lons: list[int] = []
    lats: list[int] = []
    pops: list[int] = []
    names: list[str] = []
    countries: list[str] = []
    country_ids: dict[str, int] = {}
    last_lon = 0
    last_lat = 0
    for c in cities:
        lon = round(c["lon"] * CITY_PRECISION)
        lat = round(c["lat"] * CITY_PRECISION)
        lons.append(lon - last_lon)
        lats.append(lat - last_lat)
        last_lon, last_lat = lon, lat
        # Population in thousands is plenty for ranking candidates.
        pops.append(max(1, round(c["population"] / 1000)))
        names.append(c["name"])
        code = c["country"] or "??"
        if code not in country_ids:
            country_ids[code] = len(country_ids)
            countries.append(code)
        c["_cid"] = country_ids[code]

    return {
        "precision": CITY_PRECISION,
        "minPopulation": MIN_POPULATION,
        "countries": countries,
        "cityCountries": encode_ints([c["_cid"] for c in cities]),
        "lon": encode_ints(lons),
        "lat": encode_ints(lats),
        "pop": encode_ints(pops),
        "names": "\t".join(names),
    }


def main() -> int:
    if not VENDOR.exists():
        raise SystemExit("vendor/ is missing -- run tools/fetch_data.py first")
    ASSETS.mkdir(exist_ok=True)

    basemap = build_basemap()
    (ASSETS / "basemap.json").write_text(json.dumps(basemap, separators=(",", ":")))
    n_countries = len(basemap["countries"])
    size = (ASSETS / "basemap.json").stat().st_size
    print(f"basemap.json: {n_countries} countries, {size / 1024:.0f} KiB")

    cities = build_cities()
    (ASSETS / "cities.json").write_text(json.dumps(cities, separators=(",", ":"), ensure_ascii=False))
    n_cities = cities["names"].count("\t") + 1
    size = (ASSETS / "cities.json").stat().st_size
    print(f"cities.json: {n_cities} cities >= {MIN_POPULATION:,}, {size / 1024:.0f} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
