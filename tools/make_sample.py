#!/usr/bin/env python3
"""Generate synthetic Google Timeline exports for testing.

The simulated person lives in Bristol, commutes by bike and train, moves to
London part way through, takes holidays and a few long-haul flights. The same
itinerary is written out in each of the four export formats Google has used,
so the parser can be checked against all of them.

  python3 tools/make_sample.py --format all --years 3 --out sample/
"""
from __future__ import annotations

import argparse
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HOMES = [
    # (name, lat, lon, utc offset hours, work lat, work lon)
    ("Bristol", 51.4545, -2.5879, 0, 51.4585, -2.5940),
    ("London", 51.5072, -0.1276, 0, 51.5155, -0.0922),
]

# A handful of places each home has: the shops, the gym, friends, the park.
# Reusing them makes the drawn tracks overlap the way real ones do.
REGULARS = {
    "Bristol": [
        (51.4700, -2.6000), (51.4400, -2.6200), (51.4620, -2.5600),
        (51.4300, -2.5500), (51.4950, -2.6400), (51.4100, -2.6500),
    ],
    "London": [
        (51.5300, -0.1100), (51.4800, -0.1900), (51.5400, -0.0500),
        (51.4650, -0.1150), (51.5600, -0.1400), (51.4900, -0.0200),
    ],
}

HOLIDAYS = [
    ("Barcelona", 41.3874, 2.1686, 2),
    ("Edinburgh", 55.9533, -3.1883, 0),
    ("New York", 40.7128, -74.0060, -5),
    ("Lisbon", 38.7223, -9.1393, 1),
    ("Tokyo", 35.6762, 139.6503, 9),
    ("Reykjavik", 64.1466, -21.9426, 0),
]


def jitter(value: float, metres: float, rng: random.Random) -> float:
    return value + rng.gauss(0, metres / 111_320)


def great_circle(a, b, steps):
    """Interpolate along a great circle, so flights arc properly."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    d = 2 * math.asin(math.sqrt(
        math.sin((lat2 - lat1) / 2) ** 2 +
        math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2))
    if d == 0:
        return [a] * steps
    out = []
    for i in range(steps):
        f = i / max(1, steps - 1)
        A = math.sin((1 - f) * d) / math.sin(d)
        B = math.sin(f * d) / math.sin(d)
        x = A * math.cos(lat1) * math.cos(lon1) + B * math.cos(lat2) * math.cos(lon2)
        y = A * math.cos(lat1) * math.sin(lon1) + B * math.cos(lat2) * math.sin(lon2)
        z = A * math.sin(lat1) + B * math.sin(lat2)
        out.append((math.degrees(math.atan2(z, math.hypot(x, y))),
                    math.degrees(math.atan2(y, x))))
    return out


class Itinerary:
    """A list of (timestamp, lat, lon, activity) samples plus the visits and
    trips that produced them."""

    def __init__(self, seed: int = 7):
        self.rng = random.Random(seed)
        self.points: list[tuple[datetime, float, float, str, int]] = []
        self.visits: list[dict] = []
        self.trips: list[dict] = []

    def _route(self, a, b):
        """Two waypoints either side of the straight line, chosen from the
        endpoints alone so the same journey always takes the same route."""
        seed = (round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3))
        rng = random.Random(hash(seed) & 0xFFFF)
        via = []
        for fraction in (0.35, 0.7):
            lat = a[0] + (b[0] - a[0]) * fraction
            lon = a[1] + (b[1] - a[1]) * fraction
            sideways = rng.uniform(-0.12, 0.12)
            via.append((lat + (b[1] - a[1]) * sideways, lon - (b[0] - a[0]) * sideways))
        return via

    def stay(self, when, hours, lat, lon, offset, name, semantic=None, spread=40):
        rng = self.rng
        end = when + timedelta(hours=hours)
        self.visits.append({
            "start": when, "end": end, "lat": lat, "lon": lon,
            "name": name, "semantic": semantic, "offset": offset,
        })
        samples = max(2, int(hours))
        for i in range(samples):
            t = when + timedelta(hours=hours * i / samples)
            self.points.append((t, jitter(lat, spread, rng), jitter(lon, spread, rng), "STILL", offset))
        return end

    def travel(self, when, minutes, a, b, mode, offset, steps=None):
        rng = self.rng
        end = when + timedelta(minutes=minutes)
        steps = steps or max(3, min(40, minutes // 3))
        if mode == "FLYING":
            path = great_circle(a, b, steps)
        else:
            # Real journeys follow roads. Bend the route through a couple of
            # fixed dog-legs so the drawn tracks are not perfect straight
            # lines between every pair of places.
            path = []
            via = self._route(a, b)
            legs = list(zip([a] + via, via + [b]))
            for index, (start, finish) in enumerate(legs):
                leg = great_circle(start, finish, max(2, steps // len(legs)))
                path.extend(leg if index == 0 else leg[1:])
        spread = 400 if mode == "FLYING" else 25
        for i, (lat, lon) in enumerate(path):
            t = when + timedelta(minutes=minutes * i / max(1, steps - 1))
            self.points.append((t, jitter(lat, spread, rng), jitter(lon, spread, rng), mode, offset))
        km = sum(
            haversine(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1])
            for i in range(len(path) - 1)
        )
        self.trips.append({
            "start": when, "end": end, "a": a, "b": b,
            "mode": mode, "metres": km * 1000, "offset": offset,
        })
        return end


def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0088
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(a)))


def build(years: int, seed: int) -> Itinerary:
    it = Itinerary(seed)
    rng = it.rng
    start = datetime(2026 - years, 1, 1, tzinfo=timezone.utc)
    day = start
    end = datetime(2026, 1, 1, tzinfo=timezone.utc)
    move_day = start + timedelta(days=int(years * 365 * 0.55))
    next_holiday = start + timedelta(days=rng.randint(40, 90))

    while day < end:
        home_name, home_lat, home_lon, offset, work_lat, work_lon = HOMES[1 if day >= move_day else 0]
        home = (home_lat, home_lon)
        work = (work_lat, work_lon)

        if day >= next_holiday:
            place, lat, lon, tz = HOLIDAYS[rng.randrange(len(HOLIDAYS))]
            nights = rng.randint(2, 9)
            far = haversine(home_lat, home_lon, lat, lon) > 800
            mode = "FLYING" if far else "IN_TRAIN"
            leave = day.replace(hour=9)
            arrive = it.travel(leave, 90 if not far else int(haversine(home_lat, home_lon, lat, lon) / 12),
                               home, (lat, lon), mode, offset)
            cursor = it.stay(arrive, 2, lat, lon, tz, f"Hotel, {place}")
            for _ in range(nights):
                cursor = it.stay(cursor, 10, lat, lon, tz, f"Hotel, {place}")
                spot = (lat + 0.01 * (rng.randrange(5) - 2), lon + 0.012 * (rng.randrange(5) - 2))
                cursor = it.travel(cursor, 25, (lat, lon), spot, "WALKING", tz)
                cursor = it.stay(cursor, 6, spot[0], spot[1], tz, f"Somewhere in {place}")
                cursor = it.travel(cursor, 25, spot, (lat, lon), "WALKING", tz)
            back = it.travel(cursor, 90 if not far else int(haversine(home_lat, home_lon, lat, lon) / 12),
                             (lat, lon), home, mode, offset)
            day = back.replace(hour=20, minute=0, second=0, microsecond=0)
            it.stay(day, 12, home_lat, home_lon, offset, "Home", "Home")
            day = (day + timedelta(days=1)).replace(hour=0)
            next_holiday = day + timedelta(days=rng.randint(50, 130))
            continue

        weekday = day.weekday()
        if weekday < 5 and rng.random() < 0.85:
            morning = day.replace(hour=8, minute=rng.randint(0, 40))
            it.stay(day.replace(hour=0), 8, home_lat, home_lon, offset, "Home", "Home")
            mode = "CYCLING" if rng.random() < 0.5 else ("WALKING" if rng.random() < 0.4 else "IN_PASSENGER_VEHICLE")
            at_work = it.travel(morning, rng.randint(14, 35), home, work, mode, offset)
            evening = it.stay(at_work, rng.randint(7, 9), work_lat, work_lon, offset, "Work", "Work")
            if rng.random() < 0.25:
                pub = REGULARS[home_name][rng.randrange(len(REGULARS[home_name]))]
                after = it.travel(evening, 15, work, pub, "WALKING", offset)
                after = it.stay(after, 2, pub[0], pub[1], offset, "The Local")
                it.travel(after, 20, pub, home, "WALKING", offset)
            else:
                it.travel(evening, rng.randint(14, 35), work, home, mode, offset)
        else:
            it.stay(day.replace(hour=0), 11, home_lat, home_lon, offset, "Home", "Home")
            if rng.random() < 0.6:
                out = REGULARS[home_name][rng.randrange(len(REGULARS[home_name]))]
                leave = day.replace(hour=11, minute=rng.randint(0, 50))
                there = it.travel(leave, 30, home, out, "IN_PASSENGER_VEHICLE", offset)
                there = it.stay(there, 4, out[0], out[1], offset, "Out and about")
                back = it.travel(there, 30, out, home, "IN_PASSENGER_VEHICLE", offset)
                it.stay(back, 6, home_lat, home_lon, offset, "Home", "Home")
        day += timedelta(days=1)

    it.points.sort(key=lambda p: p[0])
    return it


def iso(dt: datetime, offset_hours: int) -> str:
    local = dt.astimezone(timezone(timedelta(hours=offset_hours)))
    return local.isoformat(timespec="seconds")


# ---------------------------------------------------------------- writers

def write_records(it: Itinerary, path: Path):
    locations = []
    for t, lat, lon, activity, offset in it.points:
        entry = {
            "latitudeE7": int(round(lat * 1e7)),
            "longitudeE7": int(round(lon * 1e7)),
            "accuracy": random.randint(5, 60),
            "source": "WIFI",
            "deviceTag": 123456789,
            "timestamp": t.isoformat(timespec="seconds").replace("+00:00", "Z"),
        }
        if activity != "STILL":
            entry["activity"] = [{
                "activity": [{"type": activity, "confidence": 85}],
                "timestamp": entry["timestamp"],
            }]
        locations.append(entry)
    path.write_text(json.dumps({"locations": locations}, separators=(",", ":")))


def write_semantic(it: Itinerary, path: Path):
    objects = []
    for v in it.visits:
        objects.append({"placeVisit": {
            "location": {
                "latitudeE7": int(round(v["lat"] * 1e7)),
                "longitudeE7": int(round(v["lon"] * 1e7)),
                "name": v["name"],
                "address": v["name"],
                "placeId": "ChIJ" + str(abs(hash(v["name"])) % 10**12),
            },
            "duration": {
                "startTimestamp": iso(v["start"], v["offset"]),
                "endTimestamp": iso(v["end"], v["offset"]),
            },
            "placeConfidence": "HIGH_CONFIDENCE",
        }})
    for tr in it.trips:
        objects.append({"activitySegment": {
            "startLocation": {"latitudeE7": int(round(tr["a"][0] * 1e7)), "longitudeE7": int(round(tr["a"][1] * 1e7))},
            "endLocation": {"latitudeE7": int(round(tr["b"][0] * 1e7)), "longitudeE7": int(round(tr["b"][1] * 1e7))},
            "duration": {"startTimestamp": iso(tr["start"], tr["offset"]), "endTimestamp": iso(tr["end"], tr["offset"])},
            "distance": int(tr["metres"]),
            "activityType": tr["mode"],
            "confidence": "HIGH",
        }})
    objects.sort(key=lambda o: list(o.values())[0]["duration"]["startTimestamp"])
    path.write_text(json.dumps({"timelineObjects": objects}, separators=(",", ":")))


def _deg(lat: float, lon: float) -> str:
    return f"{lat:.7f}°, {lon:.7f}°"


def write_timeline(it: Itinerary, path: Path):
    """The current Android export: semanticSegments plus rawSignals."""
    segments = []
    for v in it.visits:
        segments.append({
            "startTime": iso(v["start"], v["offset"]),
            "endTime": iso(v["end"], v["offset"]),
            "visit": {
                "hierarchyLevel": 0,
                "probability": 0.9,
                "topCandidate": {
                    "placeId": "ChIJ" + str(abs(hash(v["name"])) % 10**12),
                    "semanticType": v["semantic"] or "Inferred Place",
                    "probability": 0.85,
                    "placeLocation": {"latLng": _deg(v["lat"], v["lon"])},
                },
            },
        })
    for tr in it.trips:
        segments.append({
            "startTime": iso(tr["start"], tr["offset"]),
            "endTime": iso(tr["end"], tr["offset"]),
            "activity": {
                "distanceMeters": tr["metres"],
                "start": {"latLng": _deg(*tr["a"])},
                "end": {"latLng": _deg(*tr["b"])},
                "topCandidate": {"type": tr["mode"].lower().replace("_", " "), "probability": 0.8},
            },
        })
    segments.sort(key=lambda s: s["startTime"])
    raw = [{
        "position": {
            "LatLng": _deg(lat, lon),
            "accuracyMeters": random.randint(4, 40),
            "altitudeMeters": round(random.uniform(0, 120), 1),
            "source": "WIFI",
            "timestamp": iso(t, offset),
        }
    } for t, lat, lon, _activity, offset in it.points]
    path.write_text(json.dumps({
        "semanticSegments": segments,
        "rawSignals": raw,
        "userLocationProfile": {"frequentPlaces": []},
    }, separators=(",", ":"), ensure_ascii=False))


def write_ios(it: Itinerary, path: Path):
    """The current iOS export: a bare array, coordinates as geo: strings."""
    out = []
    for v in it.visits:
        out.append({
            "startTime": iso(v["start"], v["offset"]),
            "endTime": iso(v["end"], v["offset"]),
            "visit": {
                "hierarchyLevel": "0",
                "topCandidate": {
                    "probability": "0.85",
                    "semanticType": v["semantic"] or "Inferred Place",
                    "placeID": "ChIJ" + str(abs(hash(v["name"])) % 10**12),
                    "placeLocation": f"geo:{v['lat']:.6f},{v['lon']:.6f}",
                },
                "probability": "0.9",
            },
        })
    for tr in it.trips:
        minutes = max(1, int((tr["end"] - tr["start"]).total_seconds() / 60))
        path_points = great_circle(tr["a"], tr["b"], min(12, max(2, minutes // 5)))
        out.append({
            "startTime": iso(tr["start"], tr["offset"]),
            "endTime": iso(tr["end"], tr["offset"]),
            "activity": {
                "start": f"geo:{tr['a'][0]:.6f},{tr['a'][1]:.6f}",
                "end": f"geo:{tr['b'][0]:.6f},{tr['b'][1]:.6f}",
                "distanceMeters": f"{tr['metres']:.1f}",
                "topCandidate": {"type": tr["mode"].lower().replace("_", " "), "probability": "0.8"},
            },
        })
        out.append({
            "startTime": iso(tr["start"], tr["offset"]),
            "endTime": iso(tr["end"], tr["offset"]),
            "timelinePath": [
                {"point": f"geo:{lat:.6f},{lon:.6f}",
                 "durationMinutesOffsetFromStartTime": str(int(minutes * i / max(1, len(path_points) - 1)))}
                for i, (lat, lon) in enumerate(path_points)
            ],
        })
    out.sort(key=lambda s: s["startTime"])
    path.write_text(json.dumps(out, separators=(",", ":")))


WRITERS = {
    "records": ("Records.json", write_records),
    "semantic": ("Semantic-Location-History.json", write_semantic),
    "timeline": ("Timeline.json", write_timeline),
    "ios": ("location-history.json", write_ios),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--format", default="all", choices=["all", *WRITERS])
    ap.add_argument("--years", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="sample")
    args = ap.parse_args()

    random.seed(args.seed)
    out_dir = (ROOT / args.out) if not Path(args.out).is_absolute() else Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    it = build(args.years, args.seed)
    print(f"simulated {len(it.points):,} points, {len(it.visits):,} visits, {len(it.trips):,} trips")

    chosen = WRITERS if args.format == "all" else {args.format: WRITERS[args.format]}
    for key, (filename, writer) in chosen.items():
        target = out_dir / filename
        writer(it, target)
        print(f"{key:9s} -> {target} ({target.stat().st_size / 1024:.0f} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
