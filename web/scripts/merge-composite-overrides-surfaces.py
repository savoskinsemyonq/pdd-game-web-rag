"""Merge many tiny `addedSurfaces` polygons (stroke tiles + joint discs) per kind.

Rasterizes each surface kind into a binary mask, takes the union, then traces
outer contours back to world polygons. Requires OpenCV (same as extract-mission2-composite).

Example:
  python scripts/merge-composite-overrides-surfaces.py
  python scripts/merge-composite-overrides-surfaces.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OVERRIDES = ROOT / "public/maps/mission2/mission2-composite.overrides.json"

# Matches web/src/state/compositeStore.ts SURFACE_DRAW_ORDER (low → drawn first).
DRAW_ORDER = (
    "water",
    "sand",
    "sidewalk",
    "road",
    "trolleybus_rails",
    "tram_tracks",
    "rails",
    "grass",
)


def bbox_of_surfaces(surfaces: list[dict[str, Any]]) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for s in surfaces:
        for p in s["points"]:
            xs.append(float(p[0]))
            ys.append(float(p[1]))
    return min(xs), min(ys), max(xs), max(ys)


def round_float(x: float, ndigits: int) -> float | int:
    r = round(x, ndigits)
    return int(r) if float(r).is_integer() else r


def round_deep(obj: object, ndigits: int) -> object:
    if isinstance(obj, float):
        return round_float(obj, ndigits)
    if isinstance(obj, list):
        return [round_deep(v, ndigits) for v in obj]
    if isinstance(obj, dict):
        return {k: round_deep(v, ndigits) for k, v in obj.items()}
    return obj


def merge_surfaces_for_kind(
    surfaces: list[dict[str, Any]],
    kind: str,
    *,
    pixels_per_world: float,
    approx_epsilon_world: float,
    min_area_pixels: float,
    pad_world: float,
) -> list[dict[str, Any]]:
    if not surfaces:
        return []

    min_x, min_y, max_x, max_y = bbox_of_surfaces(surfaces)
    min_x -= pad_world
    min_y -= pad_world
    max_x += pad_world
    max_y += pad_world

    ppw = pixels_per_world
    w = max(1, int(math.ceil((max_x - min_x) * ppw)))
    h = max(1, int(math.ceil((max_y - min_y) * ppw)))

    mask = np.zeros((h, w), dtype=np.uint8)

    def to_px(xy: list[float]) -> tuple[int, int]:
        x = int(round((float(xy[0]) - min_x) * ppw))
        y = int(round((float(xy[1]) - min_y) * ppw))
        return x, y

    for s in surfaces:
        pts = [to_px(p) for p in s["points"]]
        if len(pts) < 3:
            continue
        arr = np.array([pts], dtype=np.int32)
        cv2.fillPoly(mask, arr, 255)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    eps_px = max(0.5, approx_epsilon_world * ppw)
    out: list[dict[str, Any]] = []

    for cnt in contours:
        area_px = cv2.contourArea(cnt)
        if area_px < min_area_pixels:
            continue
        approx = cv2.approxPolyDP(cnt, eps_px, closed=True)
        if approx.shape[0] < 3:
            continue
        ring: list[list[float]] = []
        for px, py in approx.reshape(-1, 2):
            ring.append([min_x + float(px) / ppw, min_y + float(py) / ppw])
        # close ring for SVG-style rings without duplicate last point (renderer matches composite schema)
        if ring[0] != ring[-1]:
            pass  # keep open ring — schema uses unique vertices per polygon ring
        out.append({"kind": kind, "points": ring})

    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, nargs="?", default=DEFAULT_OVERRIDES)
    parser.add_argument(
        "--pixels-per-world",
        type=float,
        default=1.0,
        help="Raster resolution: pixels per world unit (default 1). Higher ⇒ sharper edges, more RAM.",
    )
    parser.add_argument(
        "--approx-epsilon-world",
        type=float,
        default=1.5,
        help="Douglas–Peucker epsilon when simplifying contours (world units).",
    )
    parser.add_argument(
        "--min-area-pixels",
        type=float,
        default=80.0,
        help="Drop contour blobs smaller than this area in raster pixels².",
    )
    parser.add_argument("--pad-world", type=float, default=4.0, help="BBox padding in world units.")
    parser.add_argument("--round-digits", type=int, default=2)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    path: Path = args.path
    if not path.is_file():
        raise SystemExit(f"not found: {path}")

    raw_in = path.read_text(encoding="utf-8")
    data = json.loads(raw_in)
    added = data.get("addedSurfaces")
    if not added:
        print("[merge] no addedSurfaces; nothing to do")
        return

    by_kind: dict[str, list[dict[str, Any]]] = {}
    for s in added:
        k = s.get("kind")
        if not isinstance(k, str):
            continue
        by_kind.setdefault(k, []).append(s)

    merged_by_kind: dict[str, list[dict[str, Any]]] = {}
    print(f"[merge] input surfaces: {len(added)} across {len(by_kind)} kinds")

    for kind in sorted(by_kind.keys()):
        chunk = by_kind[kind]
        merged = merge_surfaces_for_kind(
            chunk,
            kind,
            pixels_per_world=args.pixels_per_world,
            approx_epsilon_world=args.approx_epsilon_world,
            min_area_pixels=args.min_area_pixels,
            pad_world=args.pad_world,
        )
        print(f"  {kind}: {len(chunk)} -> {len(merged)}")
        merged_by_kind[kind] = merged

    merged_list: list[dict[str, Any]] = []
    draw_set = set(DRAW_ORDER)
    for kind in DRAW_ORDER:
        if kind in merged_by_kind:
            merged_list.extend(merged_by_kind[kind])
    for kind in sorted(merged_by_kind.keys()):
        if kind not in draw_set:
            merged_list.extend(merged_by_kind[kind])

    print(f"[merge] total {len(added)} -> {len(merged_list)}")

    data["addedSurfaces"] = merged_list
    data = round_deep(data, args.round_digits)
    raw_out = json.dumps(data, ensure_ascii=False, separators=(",", ":"))

    print(f"  bytes: {len(raw_in):,} -> {len(raw_out):,}")

    if args.dry_run:
        return

    path.write_text(raw_out + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
