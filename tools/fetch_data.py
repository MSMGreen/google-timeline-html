#!/usr/bin/env python3
"""Download the upstream geographic datasets this project embeds.

Everything is pulled from the npm registry, which ships both datasets as plain
tarballs:

  world-atlas     Natural Earth 1:110m / 1:50m country outlines as TopoJSON
                  (public domain)
  all-the-cities  GeoNames cities with population >= 1000, as a small protobuf
                  (CC BY 4.0)

The tarballs land in vendor/ (git-ignored). Run tools/build_assets.py next to
turn them into the compact blobs in assets/.
"""
from __future__ import annotations

import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"

PACKAGES = {
    "world-atlas": "2.0.2",
    "all-the-cities": "3.1.0",
}


def tarball_url(name: str, version: str) -> str:
    with urllib.request.urlopen(f"https://registry.npmjs.org/{name}") as resp:
        meta = json.load(resp)
    try:
        return meta["versions"][version]["dist"]["tarball"]
    except KeyError:
        raise SystemExit(f"{name}@{version} not found on the registry")


def fetch(name: str, version: str) -> Path:
    dest = VENDOR / name
    if dest.exists():
        print(f"{name}: already in vendor/, skipping")
        return dest
    url = tarball_url(name, version)
    print(f"{name}: downloading {url}")
    with urllib.request.urlopen(url) as resp:
        blob = resp.read()
    dest.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            # strip the leading "package/" directory npm wraps everything in
            rel = Path(*Path(member.name).parts[1:])
            if not rel.parts or ".." in rel.parts:
                continue
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            src = tar.extractfile(member)
            if src is not None:
                out.write_bytes(src.read())
    print(f"{name}: extracted to {dest.relative_to(ROOT)}")
    return dest


def main() -> int:
    VENDOR.mkdir(exist_ok=True)
    for name, version in PACKAGES.items():
        fetch(name, version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
