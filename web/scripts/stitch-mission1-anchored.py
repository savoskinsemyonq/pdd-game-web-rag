#!/usr/bin/env python3
"""
Anchored mission1 stitcher.

Pipeline:
1) For each scene of mission 1, take the canonical screenshot from `1лвл/`
   (e.g. 2.0.png ↔ 1-1_1) and anchor it to the world via MY_CAR.position
   in `web/src/data/missions.json`.
2) For each clean frame in `screens/lvl1_clean/`, find the best-matching
   anchor via ORB feature matching -> RANSAC partial-affine transform.
3) Resize each clean frame to anchor-pixel scale (= world-pixel scale,
   since anchor center maps 1:1 to MY_CAR world position) and place it
   on a world-aligned canvas.
4) Build the final atlas by per-row nanmedian over all placed clean frames
   (kills residual noise / movers).

Outputs:
  web/public/maps/mission1/mission1-map.png        — clean atlas
  web/public/maps/mission1/mission1-map.meta.json  — placements + bbox
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]

# nodeId -> file in 1лвл/ ; canonical mapping copied from existing meta.json placements.
# 10.0.png appears for both 1-1_9 and 1-1_10; the file is loaded once and anchored
# to the FIRST nodeId (1-1_9). Coverage of 1-1_10 then comes from clean frames.
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


def imread_unicode(path: Path) -> np.ndarray | None:
    """cv2.imread that survives non-ASCII paths on Windows."""
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def imwrite_unicode(path: Path, img: np.ndarray) -> bool:
    ext = path.suffix or ".png"
    ok, buf = cv2.imencode(ext, img)
    if not ok:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.tobytes())
    return True


def crop_black_letterbox(bgr: np.ndarray, thresh: int = 10) -> np.ndarray:
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    col_ok = np.where(g.max(axis=0) > thresh)[0]
    row_ok = np.where(g.max(axis=1) > thresh)[0]
    if col_ok.size == 0 or row_ok.size == 0:
        return bgr
    x0, x1 = int(col_ok[0]), int(col_ok[-1]) + 1
    y0, y1 = int(row_ok[0]), int(row_ok[-1]) + 1
    return bgr[y0:y1, x0:x1]


def load_mission1_my_car_positions(missions_path: Path) -> dict[str, tuple[int, int]]:
    data = json.loads(missions_path.read_text(encoding="utf-8"))
    m1 = next(m for m in data["missions"] if m["id"] == "mission1")
    out: dict[str, tuple[int, int]] = {}
    for node in m1["nodes"]:
        nid = node["nodeId"]
        actors = node["variants"][0]["actors"]
        for a in actors:
            if a.get("kind") == "MY_CAR":
                p = a["position"]
                out[nid] = (int(p["x"]), int(p["y"]))
                break
    return out


def build_anchor_records(
    anchors_dir: Path,
    car_by_node: dict[str, tuple[int, int]],
    orb: cv2.ORB,
) -> list[dict]:
    """Load each unique anchor file once; bind to first nodeId from ANCHOR_MAP."""
    records: list[dict] = []
    cache: dict[str, dict] = {}
    for nid, fname in ANCHOR_MAP:
        if nid not in car_by_node:
            print(f"[anchor] skip {nid}: missing in missions.json", file=sys.stderr)
            continue
        path = anchors_dir / fname
        key = str(path)
        if key in cache:
            continue  # one record per file; first nodeId wins
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
        rec = {
            "nodeId": nid,
            "file": fname,
            "world_center": car_by_node[nid],
            "h": bgr.shape[0],
            "w": bgr.shape[1],
            "kp": kp,
            "des": des,
        }
        cache[key] = rec
        records.append(rec)
        cx, cy = car_by_node[nid]
        print(
            f"[anchor] {fname} {bgr.shape[1]}x{bgr.shape[0]} -> {nid} @ world ({cx},{cy})  kp={len(kp)}"
        )
    return records


def match_clean_to_anchor(
    des_c: np.ndarray,
    kp_c,
    anchor: dict,
    bf: cv2.BFMatcher,
    ratio: float,
    min_matches: int,
) -> tuple[np.ndarray | None, int]:
    """Return (M_clean->anchor partial-affine, n_inliers)."""
    knn = bf.knnMatch(des_c, anchor["des"], k=2)
    good: list = []
    for pair in knn:
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance < ratio * n.distance:
            good.append(m)
    if len(good) < min_matches:
        return None, 0
    src = np.float32([kp_c[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([anchor["kp"][m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0, confidence=0.99
    )
    if M is None or inl is None:
        return None, 0
    return M, int(inl.sum())


def median_row(
    y: int,
    bgr_frames: list[np.ndarray],
    positions: list[tuple[int, int]],
    sizes: list[tuple[int, int]],
    canvas_w: int,
) -> np.ndarray:
    n = len(bgr_frames)
    stack = np.full((n, canvas_w, 3), np.nan, dtype=np.float32)
    for i in range(n):
        px, py = positions[i]
        w, h = sizes[i]
        fy = y - py
        if fy < 0 or fy >= h:
            continue
        row = bgr_frames[i][fy].astype(np.float32)
        x0 = max(0, -px)
        x1 = min(w, canvas_w - px)
        if x0 >= x1:
            continue
        stack[i, px + x0 : px + x1] = row[x0:x1]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        out = np.nanmedian(stack, axis=0)
    out = np.nan_to_num(out, nan=0.0)
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def build_atlas(
    bgr_frames: list[np.ndarray],
    positions: list[tuple[int, int]],
    sizes: list[tuple[int, int]],
    canvas_w: int,
    canvas_h: int,
    workers: int,
) -> np.ndarray:
    out = np.empty((canvas_h, canvas_w, 3), dtype=np.uint8)
    workers = max(1, min(workers, canvas_h))
    chunk = max(1, min(32, canvas_h // (workers * 2) or 1))

    def fn(y: int) -> tuple[int, np.ndarray]:
        return y, median_row(y, bgr_frames, positions, sizes, canvas_w)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for y, row in ex.map(fn, range(canvas_h), chunksize=chunk):
            out[y] = row
            if (y + 1) % 400 == 0 or y + 1 == canvas_h:
                print(f"  median row {y + 1}/{canvas_h}", flush=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--anchors-dir", type=Path, default=REPO_ROOT / "1лвл")
    ap.add_argument("--clean-dir", type=Path, default=REPO_ROOT / "screens" / "lvl1_clean")
    ap.add_argument(
        "--missions",
        type=Path,
        default=REPO_ROOT / "web" / "src" / "data" / "missions.json",
    )
    ap.add_argument(
        "--atlas-out",
        type=Path,
        default=REPO_ROOT / "web" / "public" / "maps" / "mission1" / "mission1-map.png",
    )
    ap.add_argument(
        "--meta-out",
        type=Path,
        default=REPO_ROOT / "web" / "public" / "maps" / "mission1" / "mission1-map.meta.json",
    )
    ap.add_argument("--pad", type=int, default=64)
    ap.add_argument("--orb-features", type=int, default=4000)
    ap.add_argument("--match-ratio", type=float, default=0.78)
    ap.add_argument("--min-matches", type=int, default=12)
    ap.add_argument("--min-inliers", type=int, default=8)
    ap.add_argument(
        "--coverage-radius",
        type=int,
        default=400,
        help="Each scene must have a placed frame whose center is within this many world px.",
    )
    ap.add_argument(
        "--strict-coverage",
        action="store_true",
        help="Fail (exit 3) on uncovered scenes instead of warning.",
    )
    ap.add_argument(
        "--workers",
        type=int,
        default=max(1, min(8, os.cpu_count() or 4)),
    )
    args = ap.parse_args()

    car_by_node = load_mission1_my_car_positions(args.missions)
    print(f"[init] missions.json: {len(car_by_node)} MY_CAR positions")

    orb = cv2.ORB_create(nfeatures=args.orb_features)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)

    anchors = build_anchor_records(args.anchors_dir, car_by_node, orb)
    if not anchors:
        print("[fatal] no anchors loaded", file=sys.stderr)
        return 2

    clean_paths = sorted(args.clean_dir.glob("*.png"))
    if not clean_paths:
        print(f"[fatal] no clean frames in {args.clean_dir}", file=sys.stderr)
        return 2
    print(f"[init] {len(clean_paths)} clean frames in {args.clean_dir}")

    placed_bgr: list[np.ndarray] = []
    placed_positions: list[tuple[int, int]] = []  # canvas top-left (filled after bbox)
    placed_world_tl: list[tuple[float, float]] = []
    placed_sizes: list[tuple[int, int]] = []
    placed_meta: list[dict] = []

    for cp in clean_paths:
        bgr = imread_unicode(cp)
        if bgr is None:
            print(f"[clean] FAIL read {cp.name}", file=sys.stderr)
            continue
        bgr = crop_black_letterbox(bgr)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        kp_c, des_c = orb.detectAndCompute(gray, None)
        if des_c is None or len(kp_c) < 8:
            print(f"[clean] {cp.name} no features", file=sys.stderr)
            continue

        best: dict | None = None
        for ai, a in enumerate(anchors):
            M, n_inl = match_clean_to_anchor(
                des_c, kp_c, a, bf, args.match_ratio, args.min_matches
            )
            if M is None or n_inl < args.min_inliers:
                continue
            if best is None or n_inl > best["n_inl"]:
                best = {"ai": ai, "M": M, "n_inl": n_inl}

        if best is None:
            print(f"[clean] {cp.name} no anchor match (skip)", file=sys.stderr)
            continue

        a = anchors[best["ai"]]
        M = best["M"]
        # Affine: anchor_pt = M @ [clean_pt, 1].T
        # Scale s such that |M @ [1,0,0]| ~= s.
        s = float(np.sqrt(M[0, 0] ** 2 + M[0, 1] ** 2))
        if not (0.4 < s < 2.5):
            print(f"[clean] {cp.name} scale {s:.2f} out of range, skip", file=sys.stderr)
            continue

        # Resize clean BGR by s so 1 px == 1 world unit.
        if abs(s - 1.0) > 0.005:
            new_w = max(1, int(round(bgr.shape[1] * s)))
            new_h = max(1, int(round(bgr.shape[0] * s)))
            interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_LINEAR
            bgr_r = cv2.resize(bgr, (new_w, new_h), interpolation=interp)
        else:
            bgr_r = bgr

        # World position of resized top-left:
        # clean (0,0) maps to anchor (M[0,2], M[1,2]).
        # anchor (ax, ay) -> world: world_center + (ax - aw/2, ay - ah/2).
        ax_tl, ay_tl = float(M[0, 2]), float(M[1, 2])
        wx = a["world_center"][0] + ax_tl - a["w"] / 2.0
        wy = a["world_center"][1] + ay_tl - a["h"] / 2.0

        placed_bgr.append(bgr_r)
        placed_world_tl.append((wx, wy))
        placed_sizes.append((bgr_r.shape[1], bgr_r.shape[0]))
        placed_meta.append(
            {
                "name": cp.name,
                "anchor_node": a["nodeId"],
                "anchor_file": a["file"],
                "scale": round(s, 4),
                "n_inliers": best["n_inl"],
                "world_top_left": [round(wx, 1), round(wy, 1)],
            }
        )
        print(
            f"[clean] {cp.name} -> {a['nodeId']} (s={s:.3f}, inl={best['n_inl']}) "
            f"world TL=({wx:.0f},{wy:.0f})"
        )

    if not placed_bgr:
        print("[fatal] no clean frames placed", file=sys.stderr)
        return 2

    # Coverage check
    coverage: dict[str, bool] = {nid: False for nid in car_by_node}
    radius_sq = args.coverage_radius ** 2
    for (wx, wy), (w, h) in zip(placed_world_tl, placed_sizes):
        fcx, fcy = wx + w / 2.0, wy + h / 2.0
        for nid, (cx, cy) in car_by_node.items():
            if (fcx - cx) ** 2 + (fcy - cy) ** 2 <= radius_sq:
                coverage[nid] = True

    missing = [nid for nid, ok in coverage.items() if not ok]
    if missing:
        print("\n[coverage] WARN: uncovered scenes:", file=sys.stderr)
        for nid in missing:
            cx, cy = car_by_node[nid]
            print(
                f"  - {nid} @ world ({cx},{cy}) — добавь clean-кадр или ослабь --coverage-radius",
                file=sys.stderr,
            )
        if args.strict_coverage:
            return 3
    else:
        print(f"[coverage] OK: all {len(car_by_node)} scenes covered (r={args.coverage_radius})")

    # Compute world bbox (with padding) and convert to canvas coords
    min_x = int(min(wx for wx, _ in placed_world_tl)) - args.pad
    min_y = int(min(wy for _, wy in placed_world_tl)) - args.pad
    max_x = int(max(wx + w for (wx, _), (w, _) in zip(placed_world_tl, placed_sizes))) + args.pad
    max_y = int(max(wy + h for (_, wy), (_, h) in zip(placed_world_tl, placed_sizes))) + args.pad
    canvas_w = max_x - min_x
    canvas_h = max_y - min_y
    print(
        f"[canvas] world bbox ({min_x},{min_y}) -> ({max_x},{max_y}) = {canvas_w}x{canvas_h}"
    )

    positions = [(int(round(wx - min_x)), int(round(wy - min_y))) for wx, wy in placed_world_tl]

    print(f"[median] building atlas {canvas_w}x{canvas_h} from {len(placed_bgr)} frames...")
    atlas = build_atlas(placed_bgr, positions, placed_sizes, canvas_w, canvas_h, args.workers)

    if not imwrite_unicode(args.atlas_out, atlas):
        print(f"[fatal] write failed {args.atlas_out}", file=sys.stderr)
        return 2
    print(f"[write] {args.atlas_out}  ({canvas_w}x{canvas_h})")

    placements = []
    for nid, fname in ANCHOR_MAP:
        if nid not in car_by_node:
            continue
        cx, cy = car_by_node[nid]
        placements.append({"file": fname, "nodeId": nid, "anchor": {"cx": cx, "cy": cy}})

    viewport_w = max(w for w, _ in placed_sizes)
    viewport_h = max(h for _, h in placed_sizes)

    meta = {
        "missionId": "mission1",
        "minX": int(min_x),
        "minY": int(min_y),
        "maxX": int(max_x),
        "maxY": int(max_y),
        "widthPx": int(canvas_w),
        "heightPx": int(canvas_h),
        "viewportW": int(viewport_w),
        "viewportH": int(viewport_h),
        "atlasFile": "mission1-map.png",
        "tilemapFile": "mission1-tilemap.json",
        "atlasMissing": False,
        "placements": placements,
        "_debug": {
            "anchorsLoaded": len(anchors),
            "cleanPlaced": len(placed_bgr),
            "coverageMissing": missing,
            "frames": placed_meta,
        },
    }
    args.meta_out.parent.mkdir(parents=True, exist_ok=True)
    args.meta_out.write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"[write] {args.meta_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
