#!/usr/bin/env python3
"""
Build mission1-tilemap.json directly from gameplay video.

Pipeline:
  1) Load anchor images from 1лвл/ with world positions from missions.json.
  2) Extract frames from videos/lvl1.mp4 at ~5 fps.
  3) For each frame: ORB-match against anchors -> RANSAC affine -> world position.
  4) For each 64x64 grid cell visible in frame: SSD-match against tile bank -> vote.
  5) Argmax votes per cell -> tilemap JSON.

Output:
  web/public/maps/mission1/mission1-tilemap.json
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]

ANCHOR_MAP: list[tuple[str, str]] = [
    ("1-0_InitMis1", "1.0.png"),
    ("1-1_1", "2.0.png"),
    ("1-1_2", "3.0.png"),
    ("1-1_3", "4.0.png"),
    ("1-1_4", "5.0.png"),
    ("1-1_5", "6.0.png"),
    ("1-1_6", "7.0.png"),
    ("1-1_7", "8.0.png"),
    ("1-1_8", "9.0.png"),
    ("1-1_9", "10.0.png"),
    ("1-1_10", "10.0.png"),
    ("1-1_11", "finish.png"),
]

TILE_SIZE = 64
MATCH_RES = 16
MATCH_THRESHOLD = 3_000_000.0
EMPTY_PX_RATIO = 0.9
FRAME_INTERVAL_SEC = 0.2  # ~5 fps
ORB_FEATURES = 4000
MATCH_RATIO = 0.75
MIN_GOOD_MATCHES = 15
MIN_INLIERS = 8
SCALE_RANGE = (0.3, 3.0)
MIN_VOTE = 0.3
COVERAGE_MIN = 0.5  # min fraction of tile area that must be in-frame


# ---------------------------------------------------------------------------
# Image I/O helpers (Unicode-safe on Windows)
# ---------------------------------------------------------------------------

def imread_unicode(path: Path) -> np.ndarray | None:
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def crop_black_letterbox(bgr: np.ndarray, thresh: int = 10) -> np.ndarray:
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    col_ok = np.where(g.max(axis=0) > thresh)[0]
    row_ok = np.where(g.max(axis=1) > thresh)[0]
    if col_ok.size == 0 or row_ok.size == 0:
        return bgr
    return bgr[int(row_ok[0]):int(row_ok[-1]) + 1,
               int(col_ok[0]):int(col_ok[-1]) + 1]


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_mission1_my_car_positions(missions_path: Path) -> dict[str, tuple[int, int]]:
    data = json.loads(missions_path.read_text(encoding="utf-8"))
    m1 = next(m for m in data["missions"] if m["id"] == "mission1")
    out: dict[str, tuple[int, int]] = {}
    for node in m1["nodes"]:
        nid = node["nodeId"]
        for a in node["variants"][0]["actors"]:
            if a.get("kind") == "MY_CAR":
                p = a["position"]
                out[nid] = (int(p["x"]), int(p["y"]))
                break
    return out


def load_tile_bank(tiles_dir: Path) -> tuple[list[int], np.ndarray]:
    """Return (ids, thumb_bank[N, MATCH_RES, MATCH_RES, 3])."""
    paths = sorted(tiles_dir.glob("tile_*.png"))
    if not paths:
        raise SystemExit(f"No tiles found in {tiles_dir}")
    ids: list[int] = []
    thumbs: list[np.ndarray] = []
    for p in paths:
        try:
            tid = int(p.stem.split("_")[1])
        except (ValueError, IndexError):
            continue
        im = imread_unicode(p)
        if im is None:
            continue
        if im.shape[0] != TILE_SIZE or im.shape[1] != TILE_SIZE:
            im = cv2.resize(im, (TILE_SIZE, TILE_SIZE), interpolation=cv2.INTER_AREA)
        ids.append(tid)
        thumbs.append(cv2.resize(im, (MATCH_RES, MATCH_RES), interpolation=cv2.INTER_AREA))
    if not ids:
        raise SystemExit(f"Could not load any tile images from {tiles_dir}")
    return ids, np.stack(thumbs, axis=0).astype(np.int32)


# ---------------------------------------------------------------------------
# Tile matching & classification (same as build-mission1-tilemap.py)
# ---------------------------------------------------------------------------

def best_tile_match(
    cell_bgr: np.ndarray,
    thumb_bank: np.ndarray,
    ids: list[int],
) -> tuple[int | None, float]:
    thumb = cv2.resize(
        cell_bgr, (MATCH_RES, MATCH_RES), interpolation=cv2.INTER_AREA
    ).astype(np.int32)
    diff = thumb_bank - thumb[None, :, :, :]
    ssd = (diff * diff).sum(axis=(1, 2, 3))
    best = int(ssd.argmin())
    score = float(ssd[best])
    if score > MATCH_THRESHOLD:
        return None, max(0.0, 1.0 - score / (MATCH_THRESHOLD * 5))
    return ids[best], max(0.0, min(1.0, 1.0 - score / MATCH_THRESHOLD))


def classify_kind(cell_bgr: np.ndarray) -> tuple[str, bool]:
    flat = cell_bgr.reshape(-1, 3).astype(np.int32)
    mean_b, mean_g, mean_r = flat.mean(axis=0)
    std = flat.std(axis=0).mean()
    if mean_g > mean_r + 15 and mean_g > mean_b + 15 and mean_g > 60:
        return "grass", False
    if mean_r < 90 and mean_g < 90 and mean_b < 90 and std < 35:
        return "road", True
    bright = (
        (cell_bgr[:, :, 0] > 180)
        & (cell_bgr[:, :, 1] > 180)
        & (cell_bgr[:, :, 2] > 100)
    )
    if bright.sum() > 40 and mean_r < 130 and mean_g < 130 and mean_b < 130:
        return "road_marking", True
    if abs(mean_r - mean_g) < 20 and abs(mean_g - mean_b) < 20 and 100 < mean_r < 180:
        return "sidewalk", True
    if std > 35 and max(mean_r, mean_g, mean_b) > 100:
        return "building", False
    return "unknown", False


def is_empty_cell(cell_bgr: np.ndarray) -> bool:
    g = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2GRAY)
    return float((g < 8).mean()) >= EMPTY_PX_RATIO


# ---------------------------------------------------------------------------
# Anchor loading
# ---------------------------------------------------------------------------

def build_anchors(
    anchors_dir: Path,
    car_by_node: dict[str, tuple[int, int]],
    orb: cv2.ORB,
) -> list[dict]:
    records: list[dict] = []
    seen_files: set[str] = set()
    for nid, fname in ANCHOR_MAP:
        if nid not in car_by_node:
            continue
        if fname in seen_files:
            continue
        seen_files.add(fname)
        path = anchors_dir / fname
        bgr = imread_unicode(path)
        if bgr is None:
            print(f"[anchor] FAIL read {path}", file=sys.stderr)
            continue
        bgr = crop_black_letterbox(bgr)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        kp, des = orb.detectAndCompute(gray, None)
        if des is None or len(kp) < 8:
            print(f"[anchor] FAIL features {fname}", file=sys.stderr)
            continue
        cx, cy = car_by_node[nid]
        records.append({
            "nodeId": nid,
            "file": fname,
            "world_center": (cx, cy),
            "h": bgr.shape[0],
            "w": bgr.shape[1],
            "kp": kp,
            "des": des,
        })
        print(f"[anchor] {fname} -> {nid} @ world ({cx},{cy})  kp={len(kp)}")
    return records


# ---------------------------------------------------------------------------
# Video processing — core pipeline
# ---------------------------------------------------------------------------

def process_video(
    video_path: Path,
    anchors: list[dict],
    tile_ids: list[int],
    thumb_bank: np.ndarray,
    orb: cv2.ORB,
    bf: cv2.BFMatcher,
    frame_interval_sec: float,
    min_good_matches: int,
    min_inliers: int,
) -> tuple[dict, dict]:
    """
    Single-pass over video.

    Returns:
      votes:   {(abs_col, abs_row): {tileId: float_weight}}
               abs_col = floor(world_x / TILE_SIZE) — absolute world-grid coords.
               tileId -1 is used as a sentinel for "no matching tile".
      samples: {(abs_col, abs_row): (best_conf, bgr_64x64)}
               The best (highest-confidence) 64x64 sample seen for each cell.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise SystemExit(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_skip = max(1, int(round(fps * frame_interval_sec)))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(
        f"[video] {total} frames @ {fps:.1f} fps — "
        f"sampling every {frame_skip} frames (~{frame_interval_sec:.1f}s)"
    )

    votes: dict = defaultdict(lambda: defaultdict(float))
    samples: dict = {}  # key -> (best_conf, bgr_64x64)

    frame_idx = 0
    extracted = 0
    positioned = 0
    votes_cast = 0

    while True:
        ret, frame_bgr = cap.read()
        if not ret:
            break
        frame_idx += 1
        if (frame_idx - 1) % frame_skip != 0:
            continue
        extracted += 1

        frame_bgr = crop_black_letterbox(frame_bgr)
        if frame_bgr.size == 0:
            continue
        frame_gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        kp_f, des_f = orb.detectAndCompute(frame_gray, None)
        if des_f is None or len(kp_f) < 8:
            continue

        # Match frame against every anchor; keep the best (most inliers)
        best_a: dict | None = None
        best_M: np.ndarray | None = None
        best_n = 0

        for a in anchors:
            knn = bf.knnMatch(des_f, a["des"], k=2)
            good = []
            for pair in knn:
                if len(pair) < 2:
                    continue
                m, n = pair
                if m.distance < MATCH_RATIO * n.distance:
                    good.append(m)
            if len(good) < min_good_matches:
                continue
            src_pts = np.float32(
                [kp_f[m.queryIdx].pt for m in good]
            ).reshape(-1, 1, 2)
            dst_pts = np.float32(
                [a["kp"][m.trainIdx].pt for m in good]
            ).reshape(-1, 1, 2)
            # M maps frame pixel -> anchor pixel
            M, inl = cv2.estimateAffinePartial2D(
                src_pts, dst_pts,
                method=cv2.RANSAC,
                ransacReprojThreshold=3.0,
                confidence=0.99,
            )
            if M is None or inl is None:
                continue
            n_inl = int(inl.sum())
            if n_inl < min_inliers or n_inl <= best_n:
                continue
            best_a, best_M, best_n = a, M, n_inl

        if best_a is None:
            continue
        positioned += 1

        a = best_a
        M = best_M  # type: ignore[assignment]
        # Scale: M maps frame -> anchor; s = how many anchor px per frame px.
        # s < 1 means the frame has higher resolution than anchor for same world area.
        # 1 frame pixel = s world units; 1 world unit = 1/s frame pixels.
        s = float(np.sqrt(M[0, 0] ** 2 + M[0, 1] ** 2))
        if not (SCALE_RANGE[0] < s < SCALE_RANGE[1]):
            positioned -= 1
            continue

        F_H, F_W = frame_bgr.shape[:2]
        A_W, A_H = a["w"], a["h"]
        wx_a, wy_a = a["world_center"]

        # Frame top-left in anchor pixel space = M @ [0, 0, 1] = M[:, 2]
        ax_tl = float(M[0, 2])
        ay_tl = float(M[1, 2])
        # Frame top-left in world coordinates
        wtl_x = wx_a + ax_tl - A_W / 2.0
        wtl_y = wy_a + ay_tl - A_H / 2.0

        # Tile footprint in frame pixels: 64 world units / s frame-pixels-per-world-unit
        tile_px = max(4, int(round(TILE_SIZE / s)))

        # World extent of this frame
        w_world = F_W * s
        h_world = F_H * s

        # Absolute world-grid cells covered by this frame
        c_min = int(np.floor(wtl_x / TILE_SIZE))
        c_max = int(np.floor((wtl_x + w_world) / TILE_SIZE))
        r_min = int(np.floor(wtl_y / TILE_SIZE))
        r_max = int(np.floor((wtl_y + h_world) / TILE_SIZE))

        # Pre-invert M once per frame for anchor_px -> frame_px conversion
        M2 = M[:2, :2]
        t2 = M[:, 2]
        try:
            inv_M2 = np.linalg.inv(M2)
        except np.linalg.LinAlgError:
            continue

        for rg in range(r_min, r_max + 1):
            for cg in range(c_min, c_max + 1):
                # World top-left of this grid cell
                twx = cg * float(TILE_SIZE)
                twy = rg * float(TILE_SIZE)

                # Tile TL in anchor pixel space
                anch_x = twx - wx_a + A_W / 2.0
                anch_y = twy - wy_a + A_H / 2.0

                # Tile TL in frame pixel space
                fp = inv_M2 @ (np.array([anch_x, anch_y]) - t2)
                fx0 = int(round(float(fp[0])))
                fy0 = int(round(float(fp[1])))
                fx1 = fx0 + tile_px
                fy1 = fy0 + tile_px

                # Clamp to frame bounds; require minimum coverage
                cx0 = max(0, fx0)
                cy0 = max(0, fy0)
                cx1 = min(F_W, fx1)
                cy1 = min(F_H, fy1)
                if cx1 <= cx0 or cy1 <= cy0:
                    continue
                if (cx1 - cx0) * (cy1 - cy0) < tile_px * tile_px * COVERAGE_MIN:
                    continue

                cell_raw = frame_bgr[cy0:cy1, cx0:cx1]
                if cell_raw.size == 0:
                    continue

                cell_64 = cv2.resize(
                    cell_raw, (TILE_SIZE, TILE_SIZE), interpolation=cv2.INTER_AREA
                )
                if is_empty_cell(cell_64):
                    continue

                tid, conf = best_tile_match(cell_64, thumb_bank, tile_ids)
                key = (cg, rg)
                if tid is not None:
                    votes[key][tid] += conf
                else:
                    # sentinel for "seen but no tile match" — keeps the cell from being no_data
                    votes[key][-1] += max(0.01, conf)

                if key not in samples or conf > samples[key][0]:
                    samples[key] = (conf, cell_64.copy())
                votes_cast += 1

        if positioned % 50 == 0 and positioned > 0:
            pct = frame_idx * 100 // max(1, total)
            print(
                f"  video {pct}% | positioned={positioned}/{extracted} | votes={votes_cast}",
                flush=True,
            )

    cap.release()
    print(
        f"[video] done: {frame_idx} raw frames, "
        f"{extracted} extracted, {positioned} positioned, "
        f"{votes_cast} tile votes"
    )
    return dict(votes), samples


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--video",
        type=Path,
        default=REPO_ROOT / "videos" / "lvl1.mp4",
    )
    ap.add_argument(
        "--anchors-dir",
        type=Path,
        default=REPO_ROOT / "1лвл",
    )
    ap.add_argument(
        "--missions",
        type=Path,
        default=REPO_ROOT / "web" / "src" / "data" / "missions.json",
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
    ap.add_argument("--frame-interval", type=float, default=FRAME_INTERVAL_SEC)
    ap.add_argument("--min-good-matches", type=int, default=MIN_GOOD_MATCHES)
    ap.add_argument("--min-inliers", type=int, default=MIN_INLIERS)
    ap.add_argument(
        "--min-vote",
        type=float,
        default=MIN_VOTE,
        help="Minimum total vote weight for a cell to get a tileId (vs null).",
    )
    ap.add_argument(
        "--pad-cells",
        type=int,
        default=1,
        help="Grid padding in cells around the voted area.",
    )
    args = ap.parse_args()

    if not args.video.is_file():
        print(f"[fatal] video not found: {args.video}", file=sys.stderr)
        return 2

    car_by_node = load_mission1_my_car_positions(args.missions)
    print(f"[init] {len(car_by_node)} MY_CAR positions from missions.json")

    tile_ids, thumb_bank = load_tile_bank(args.tiles_dir)
    print(f"[tiles] {len(tile_ids)} tiles loaded")

    orb = cv2.ORB_create(nfeatures=ORB_FEATURES)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)

    anchors = build_anchors(args.anchors_dir, car_by_node, orb)
    if not anchors:
        print("[fatal] no anchors loaded", file=sys.stderr)
        return 2
    print(f"[anchors] {len(anchors)} unique anchor images loaded")

    votes, samples = process_video(
        args.video,
        anchors,
        tile_ids,
        thumb_bank,
        orb,
        bf,
        args.frame_interval,
        args.min_good_matches,
        args.min_inliers,
    )

    if not votes:
        print("[fatal] no tile votes collected — check video path and anchor matching", file=sys.stderr)
        return 2

    print(f"[grid] {len(votes)} cells received at least one vote")

    # Derive grid bounds from voted cells + padding
    all_cg = [c for c, _ in votes]
    all_rg = [r for _, r in votes]
    min_cg = min(all_cg) - args.pad_cells
    max_cg = max(all_cg) + args.pad_cells
    min_rg = min(all_rg) - args.pad_cells
    max_rg = max(all_rg) + args.pad_cells

    grid_cols = max_cg - min_cg + 1
    grid_rows = max_rg - min_rg + 1
    origin_x = min_cg * TILE_SIZE
    origin_y = min_rg * TILE_SIZE
    print(
        f"[grid] {grid_cols} x {grid_rows} = {grid_cols * grid_rows} cells, "
        f"origin world ({origin_x}, {origin_y})"
    )

    # Build output cells in row-major order (required by renderer's cells[row*cols+col] indexing)
    cells: list[dict] = []
    counters = {"matched": 0, "no_match": 0, "no_data": 0}
    kind_counts: dict[str, int] = {}

    for rg in range(min_rg, max_rg + 1):
        for cg in range(min_cg, max_cg + 1):
            col_rel = cg - min_cg
            row_rel = rg - min_rg
            key = (cg, rg)

            if key not in votes:
                counters["no_data"] += 1
                cells.append({
                    "col": col_rel, "row": row_rel,
                    "tileId": None, "kind": "empty",
                    "passable": False, "confidence": 0.0,
                })
                kind_counts["empty"] = kind_counts.get("empty", 0) + 1
                continue

            cell_votes = votes[key]
            total_weight = sum(cell_votes.values())
            real_votes = {tid: w for tid, w in cell_votes.items() if tid != -1}

            if real_votes and total_weight >= args.min_vote:
                best_tid: int | None = max(real_votes, key=lambda k: real_votes[k])
                conf = round(real_votes[best_tid] / total_weight, 3)
                counters["matched"] += 1
            else:
                best_tid = None
                conf = 0.0
                counters["no_match"] += 1

            sample_bgr = samples[key][1] if key in samples else None
            if sample_bgr is not None:
                kind, passable = classify_kind(sample_bgr)
            else:
                kind, passable = "unknown", False

            kind_counts[kind] = kind_counts.get(kind, 0) + 1
            cells.append({
                "col": col_rel, "row": row_rel,
                "tileId": best_tid,
                "kind": kind,
                "passable": passable,
                "confidence": conf,
            })

    out_data = {
        "missionId": "mission1",
        "tileSize": TILE_SIZE,
        "cols": grid_cols,
        "rows": grid_rows,
        "originWorld": {"x": origin_x, "y": origin_y},
        "summary": {
            "cells": len(cells),
            "matched": counters["matched"],
            "noTileMatch": counters["no_match"],
            "noData": counters["no_data"],
            "byKind": kind_counts,
        },
        "cells": cells,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(out_data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[write] {args.out}")
    print(f"[summary] {out_data['summary']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
