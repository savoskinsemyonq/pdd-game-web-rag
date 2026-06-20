#!/usr/bin/env python3
"""
Build mission1-tilemap.json from the stitched atlas.

For each 64x64 cell of the atlas:
  - find the closest tile in `map_analyse/tiles/` (sum of squared diffs on 16x16 thumbnails)
  - classify a semantic `kind` from dominant colour (grass / road / road_marking / building / unknown)
  - infer a passable flag for AI / collision use

Output: web/public/maps/mission1/mission1-tilemap.json (same coordinate system
as mission1-map.meta.json — `originWorld = (minX, minY)` from that file).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]

TILE_SIZE = 64
MATCH_RES = 16  # downsampled size for SSD matching
MATCH_THRESHOLD = 3_000_000.0  # SSD on 16x16x3 (max ~50M); empirical sweet spot
EMPTY_PX_RATIO = 0.9  # ratio of near-black pixels to declare cell "empty" (out of atlas)


def imread_unicode(path: Path) -> np.ndarray | None:
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def load_tile_bank(tiles_dir: Path) -> tuple[list[int], np.ndarray, np.ndarray]:
    """Return (ids, full_64x64_bank[N,64,64,3], thumb_bank[N,16,16,3])."""
    paths = sorted(tiles_dir.glob("tile_*.png"))
    if not paths:
        raise SystemExit(f"No tiles in {tiles_dir}")
    ids: list[int] = []
    fulls: list[np.ndarray] = []
    thumbs: list[np.ndarray] = []
    for p in paths:
        try:
            tid = int(p.stem.split("_")[1])
        except (ValueError, IndexError):
            continue
        im = imread_unicode(p)
        if im is None:
            print(f"[tiles] FAIL read {p}", file=sys.stderr)
            continue
        if im.shape[0] != TILE_SIZE or im.shape[1] != TILE_SIZE:
            im = cv2.resize(im, (TILE_SIZE, TILE_SIZE), interpolation=cv2.INTER_AREA)
        ids.append(tid)
        fulls.append(im)
        thumbs.append(cv2.resize(im, (MATCH_RES, MATCH_RES), interpolation=cv2.INTER_AREA))
    full_arr = np.stack(fulls, axis=0)  # [N, 64, 64, 3]
    thumb_arr = np.stack(thumbs, axis=0).astype(np.int32)  # [N, 16, 16, 3]
    return ids, full_arr, thumb_arr


def classify_kind(cell_bgr: np.ndarray) -> tuple[str, bool]:
    """Heuristic colour classifier on a 64x64 BGR cell. Returns (kind, passable)."""
    flat = cell_bgr.reshape(-1, 3).astype(np.int32)
    mean_b, mean_g, mean_r = flat.mean(axis=0)
    std = flat.std(axis=0).mean()

    # grass: green dominant
    if mean_g > mean_r + 15 and mean_g > mean_b + 15 and mean_g > 60:
        return "grass", False

    # road: low saturation, mid-dark
    if mean_r < 90 and mean_g < 90 and mean_b < 90 and std < 35:
        return "road", True

    # road marking: dark base + bright pixels (white/yellow)
    bright = (
        (cell_bgr[:, :, 0] > 180)
        & (cell_bgr[:, :, 1] > 180)
        & (cell_bgr[:, :, 2] > 100)
    )
    if bright.sum() > 40 and mean_r < 130 and mean_g < 130 and mean_b < 130:
        return "road_marking", True

    # sidewalk-ish: light gray
    if abs(mean_r - mean_g) < 20 and abs(mean_g - mean_b) < 20 and 100 < mean_r < 180:
        return "sidewalk", True

    # building: saturated colours, high std
    if std > 35 and (max(mean_r, mean_g, mean_b) > 100):
        return "building", False

    return "unknown", False


def is_empty_cell(cell_bgr: np.ndarray) -> bool:
    """Cells outside atlas content (canvas padding) are near-black."""
    g = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2GRAY)
    return float((g < 8).mean()) >= EMPTY_PX_RATIO


def best_tile_match(
    cell_bgr: np.ndarray, thumb_bank: np.ndarray, ids: list[int]
) -> tuple[int | None, float]:
    """Return (tileId or None, confidence in [0, 1])."""
    thumb = cv2.resize(cell_bgr, (MATCH_RES, MATCH_RES), interpolation=cv2.INTER_AREA).astype(
        np.int32
    )
    diff = thumb_bank - thumb[None, :, :, :]
    ssd = (diff * diff).sum(axis=(1, 2, 3))
    best = int(ssd.argmin())
    score = float(ssd[best])
    if score > MATCH_THRESHOLD:
        return None, max(0.0, 1.0 - score / (MATCH_THRESHOLD * 5))
    confidence = max(0.0, min(1.0, 1.0 - score / MATCH_THRESHOLD))
    return ids[best], confidence


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--atlas",
        type=Path,
        default=REPO_ROOT / "web" / "public" / "maps" / "mission1" / "mission1-map.png",
    )
    ap.add_argument(
        "--meta",
        type=Path,
        default=REPO_ROOT / "web" / "public" / "maps" / "mission1" / "mission1-map.meta.json",
    )
    ap.add_argument(
        "--tiles-dir",
        type=Path,
        default=REPO_ROOT / "map_analyse" / "tiles",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "web" / "public" / "maps" / "mission1" / "mission1-tilemap.json",
    )
    args = ap.parse_args()

    atlas = imread_unicode(args.atlas)
    if atlas is None:
        print(f"[fatal] cannot read {args.atlas}", file=sys.stderr)
        return 2
    meta = json.loads(args.meta.read_text(encoding="utf-8"))
    origin_x = int(meta["minX"])
    origin_y = int(meta["minY"])

    h, w = atlas.shape[:2]
    cols = (w + TILE_SIZE - 1) // TILE_SIZE
    rows = (h + TILE_SIZE - 1) // TILE_SIZE
    print(f"[atlas] {w}x{h} -> grid {cols}x{rows} = {cols * rows} cells")

    ids, _full_bank, thumb_bank = load_tile_bank(args.tiles_dir)
    print(f"[tiles] {len(ids)} tiles loaded ({TILE_SIZE}x{TILE_SIZE})")

    cells: list[dict] = []
    counters = {"empty": 0, "matched": 0, "no_match": 0}
    kind_counts: dict[str, int] = {}

    for row in range(rows):
        y0 = row * TILE_SIZE
        y1 = min(h, y0 + TILE_SIZE)
        for col in range(cols):
            x0 = col * TILE_SIZE
            x1 = min(w, x0 + TILE_SIZE)
            cell = atlas[y0:y1, x0:x1]
            # pad to 64x64 if right/bottom edge
            if cell.shape[0] != TILE_SIZE or cell.shape[1] != TILE_SIZE:
                pad = np.zeros((TILE_SIZE, TILE_SIZE, 3), dtype=np.uint8)
                pad[: cell.shape[0], : cell.shape[1]] = cell
                cell = pad

            if is_empty_cell(cell):
                counters["empty"] += 1
                cells.append(
                    {
                        "col": col,
                        "row": row,
                        "tileId": None,
                        "kind": "empty",
                        "passable": False,
                        "confidence": 1.0,
                    }
                )
                kind_counts["empty"] = kind_counts.get("empty", 0) + 1
                continue

            tile_id, conf = best_tile_match(cell, thumb_bank, ids)
            kind, passable = classify_kind(cell)
            if tile_id is None:
                counters["no_match"] += 1
            else:
                counters["matched"] += 1
            kind_counts[kind] = kind_counts.get(kind, 0) + 1
            cells.append(
                {
                    "col": col,
                    "row": row,
                    "tileId": tile_id,
                    "kind": kind,
                    "passable": passable,
                    "confidence": round(conf, 3),
                }
            )
        if (row + 1) % 25 == 0 or row + 1 == rows:
            print(f"  row {row + 1}/{rows}", flush=True)

    out = {
        "missionId": "mission1",
        "tileSize": TILE_SIZE,
        "cols": cols,
        "rows": rows,
        "originWorld": {"x": origin_x, "y": origin_y},
        "summary": {
            "cells": len(cells),
            "empty": counters["empty"],
            "matched": counters["matched"],
            "noTileMatch": counters["no_match"],
            "byKind": kind_counts,
        },
        "cells": cells,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[write] {args.out}")
    print(f"[summary] {out['summary']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
