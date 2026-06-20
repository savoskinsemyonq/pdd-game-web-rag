#!/usr/bin/env python3
"""
Build mission1-map.png from per-second gameplay screenshots in screens/lvl1.

Pipeline: crop letterboxing -> phase-correlation pairwise shifts -> accumulate
canvas -> per-row nanmedian across aligned frames (removes moving objects / popups).

Does not edit the plan file. See repo docs / plan for semantics of mission1-map.meta.json.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]


def list_pngs(folder: Path) -> list[Path]:
    files = list(folder.glob("*.png")) + list(folder.glob("*.PNG"))
    seen: set[str] = set()
    out: list[Path] = []
    for p in sorted(files, key=lambda x: x.name.lower()):
        k = str(p.resolve())
        if k not in seen:
            seen.add(k)
            out.append(p)
    return out


def crop_black_letterbox(bgr: np.ndarray, thresh: int = 10) -> np.ndarray:
    """Remove near-black borders (pillarboxing)."""
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    col_ok = np.where(g.max(axis=0) > thresh)[0]
    row_ok = np.where(g.max(axis=1) > thresh)[0]
    if col_ok.size == 0 or row_ok.size == 0:
        return bgr
    x0, x1 = int(col_ok[0]), int(col_ok[-1]) + 1
    y0, y1 = int(row_ok[0]), int(row_ok[-1]) + 1
    return bgr[y0:y1, x0:x1]


def load_mission_my_car_positions(
    missions_path: Path,
    mission_id: str,
) -> dict[str, tuple[int, int]]:
    data = json.loads(missions_path.read_text(encoding="utf-8"))
    m1 = next(m for m in data["missions"] if m["id"] == mission_id)
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


def load_mission_node_ids(missions_path: Path, mission_id: str) -> list[str]:
    data = json.loads(missions_path.read_text(encoding="utf-8"))
    mission = next(m for m in data["missions"] if m["id"] == mission_id)
    return [str(n["nodeId"]) for n in mission["nodes"]]


def phase_shift_pair(
    prev_g: np.ndarray,
    curr_g: np.ndarray,
    scale: float,
    max_shift: int,
    min_resp: float,
) -> tuple[float, float, float]:
    """Return (dx, dy, response) to align curr with prev: curr(x,y) ~ prev(x+dx, y+dy)."""
    if scale != 1.0:
        h, w = prev_g.shape[:2]
        nw, nh = max(16, int(w * scale)), max(16, int(h * scale))
        pg = cv2.resize(prev_g, (nw, nh), interpolation=cv2.INTER_AREA)
        cg = cv2.resize(curr_g, (nw, nh), interpolation=cv2.INTER_AREA)
    else:
        pg, cg = prev_g, curr_g

    pgf = pg.astype(np.float32)
    cgf = cg.astype(np.float32)
    # curr vs prev -> delta matches top-left += delta when curr is prev rolled left (positive dx).
    (sx, sy), resp = cv2.phaseCorrelate(cgf, pgf)
    dx, dy = sx / scale, sy / scale
    if float(resp) < min_resp or abs(dx) > max_shift or abs(dy) > max_shift:
        return 0.0, 0.0, float(resp)
    return float(dx), float(dy), float(resp)


def accumulate_positions(
    grays: list[np.ndarray],
    scale: float,
    max_shift: int,
    invert: bool,
    min_resp: float,
) -> tuple[list[tuple[float, float]], list[tuple[float, float, float]]]:
    """Top-left of each frame on a virtual canvas; deltas[i] = shift from i-1 to i."""
    n = len(grays)
    deltas = [(0.0, 0.0)]
    debug: list[tuple[float, float, float]] = [(0.0, 0.0, 1.0)]
    for i in range(1, n):
        dx, dy, resp = phase_shift_pair(
            grays[i - 1], grays[i], scale, max_shift, min_resp
        )
        if invert:
            dx, dy = -dx, -dy
        deltas.append((dx, dy))
        debug.append((dx, dy, resp))

    pos: list[tuple[float, float]] = [(0.0, 0.0)]
    for i in range(1, n):
        px, py = pos[i - 1]
        dx, dy = deltas[i]
        pos.append((px + dx, py + dy))
    return pos, debug


def bbox_frames(pos: list[tuple[float, float]], w: int, h: int, pad: int) -> tuple[int, int, int, int]:
    min_x = min(int(p[0]) for p in pos) - pad
    min_y = min(int(p[1]) for p in pos) - pad
    max_x = max(int(p[0]) + w for p in pos) + pad
    max_y = max(int(p[1]) + h for p in pos) + pad
    return min_x, min_y, max_x, max_y


def median_row(
    y: int,
    bgr_frames: list[np.ndarray],
    pos: list[tuple[float, float]],
    canvas_w: int,
    h: int,
    w: int,
    exclude: set[int],
) -> np.ndarray:
    """One scanline y in canvas [0, canvas_h); returns (canvas_w, 3) uint8."""
    n = len(bgr_frames)
    stack = np.full((n, canvas_w, 3), np.nan, dtype=np.float32)
    for i in range(n):
        if i in exclude:
            continue
        py = int(pos[i][1])
        px = int(pos[i][0])
        fy = y - py
        if fy < 0 or fy >= h:
            continue
        row = bgr_frames[i][fy].astype(np.float32)
        x0 = max(0, -px)
        x1 = min(w, canvas_w - px)
        if x0 >= x1:
            continue
        dst_lo = px + x0
        dst_hi = px + x1
        stack[i, dst_lo:dst_hi] = row[x0:x1]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        out = np.nanmedian(stack, axis=0)
    out = np.nan_to_num(out, nan=0.0)
    out = np.clip(np.round(out), 0, 255).astype(np.uint8)
    return out


def build_median_atlas(
    bgr_frames: list[np.ndarray],
    pos: list[tuple[float, float]],
    min_x: int,
    min_y: int,
    max_x: int,
    max_y: int,
    exclude: set[int],
    workers: int,
) -> np.ndarray:
    h, w = bgr_frames[0].shape[:2]
    canvas_w = max_x - min_x
    canvas_h = max_y - min_y
    pos_adj = [(p[0] - min_x, p[1] - min_y) for p in pos]
    fn = partial(
        median_row,
        bgr_frames=bgr_frames,
        pos=pos_adj,
        canvas_w=canvas_w,
        h=h,
        w=w,
        exclude=exclude,
    )
    workers = max(1, min(workers, canvas_h))
    out = np.empty((canvas_h, canvas_w, 3), dtype=np.uint8)
    chunk = max(1, min(32, canvas_h // (workers * 2) or 1))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for y, row in enumerate(
            ex.map(fn, range(canvas_h), chunksize=chunk),
        ):
            out[y] = row
            if (y + 1) % 400 == 0 or y + 1 == canvas_h:
                print(f"  median row {y + 1}/{canvas_h}", flush=True)
    return out


def write_meta(
    meta_out: Path,
    meta_template_path: Path,
    missions_path: Path,
    mission_id: str,
    atlas_w: int,
    atlas_h: int,
    viewport_w: int,
    viewport_h: int,
    atlas_file: str,
    car_center_in_atlas: tuple[float, float],
    init_node: str,
) -> None:
    """
    world_x = minX + atlas_x, world_y = minY + atlas_y (y downward in both).
    First-frame car center in atlas maps to MY_CAR world for init_node.
    Merges onto full JSON from meta_template_path so keys like tilemapFile are kept.
    """
    raw = json.loads(meta_template_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("meta template must be a JSON object")
    meta = copy.deepcopy(raw)

    car_by_node = load_mission_my_car_positions(missions_path, mission_id)
    if init_node not in car_by_node:
        raise ValueError(f"init node {init_node!r} not in missions")
    cwx, cwy = car_by_node[init_node]
    acx, acy = car_center_in_atlas
    min_x = int(round(cwx - acx))
    min_y = int(round(cwy - acy))
    max_x = min_x + atlas_w
    max_y = min_y + atlas_h

    template_placements = meta.get("placements") or []
    template_matches_mission = str(meta.get("missionId", "")) == mission_id
    placements_out: list[dict] = []
    for p in template_placements:
        if not isinstance(p, dict):
            continue
        row = dict(p)
        nid = row.get("nodeId", "")
        if nid in car_by_node:
            cx, cy = car_by_node[nid]
            row["anchor"] = {"cx": cx, "cy": cy}
        elif "anchor" not in row:
            row["anchor"] = {}
        placements_out.append(row)
    if not template_matches_mission:
        placements_out = []
        if "tilemapFile" in meta:
            del meta["tilemapFile"]
        for i, nid in enumerate(load_mission_node_ids(missions_path, mission_id)):
            cx, cy = car_by_node.get(nid, (0, 0))
            placements_out.append(
                {
                    "file": f"{i + 1}.0.png",
                    "nodeId": nid,
                    "anchor": {"cx": cx, "cy": cy},
                }
            )

    meta["missionId"] = mission_id
    meta["minX"] = min_x
    meta["minY"] = min_y
    meta["maxX"] = max_x
    meta["maxY"] = max_y
    meta["widthPx"] = atlas_w
    meta["heightPx"] = atlas_h
    meta["viewportW"] = viewport_w
    meta["viewportH"] = viewport_h
    meta["atlasFile"] = atlas_file
    meta["atlasMissing"] = False
    meta["placements"] = placements_out

    meta_out.parent.mkdir(parents=True, exist_ok=True)
    meta_out.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Stitch mission map from screenshots.")
    ap.add_argument(
        "--mission-id",
        type=str,
        default="mission1",
        help="Mission id from missions.json (e.g. mission1, mission2)",
    )
    ap.add_argument(
        "--input",
        type=Path,
        default=REPO_ROOT / "screens" / "lvl1",
        help="Folder with PNG sequence",
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
    ap.add_argument(
        "--meta-template",
        type=Path,
        default=REPO_ROOT / "web" / "public" / "maps" / "mission1" / "mission1-map.meta.json",
        help="Existing meta for placements[].file order (anchors overwritten from missions.json).",
    )
    ap.add_argument(
        "--missions",
        type=Path,
        default=REPO_ROOT / "web" / "src" / "data" / "missions.json",
    )
    ap.add_argument("--pad", type=int, default=64, help="Canvas margin around drift")
    ap.add_argument("--phase-scale", type=float, default=0.35, help="Downscale for phase correlate")
    ap.add_argument("--max-shift", type=int, default=420, help="Clamp |dx|,|dy| per frame pair")
    ap.add_argument(
        "--min-phase-response",
        type=float,
        default=0.08,
        help="Below this correlation, treat shift as 0 (reduces UI glitch jumps)",
    )
    ap.add_argument(
        "--invert-phase",
        action="store_true",
        help="Flip accumulated shift direction if panorama drifts wrong way",
    )
    ap.add_argument(
        "--exclude-frames",
        type=str,
        default="",
        help="Comma-separated 0-based frame indices to skip in median (e.g. 12,13,14)",
    )
    ap.add_argument(
        "--skip-median",
        action="store_true",
        help="Debug: last frame alpha-blend stack instead of full median (fast, lower quality)",
    )
    ap.add_argument(
        "--workers",
        type=int,
        default=max(1, min(8, (os.cpu_count() or 4))),
        help="Parallel threads for median (row-wise)",
    )
    ap.add_argument(
        "--init-node",
        type=str,
        default="1-0_InitMis1",
        help="Node id for first frame MY_CAR world anchor",
    )
    args = ap.parse_args()

    pngs = list_pngs(args.input)
    if not pngs:
        print(f"No PNG files in {args.input.resolve()}", file=sys.stderr)
        print("Add screenshots, then re-run.", file=sys.stderr)
        return 2

    exclude: set[int] = set()
    if args.exclude_frames.strip():
        for part in args.exclude_frames.split(","):
            part = part.strip()
            if part:
                exclude.add(int(part))

    print(f"Loading {len(pngs)} frames...")
    bgr_frames: list[np.ndarray] = []
    for p in pngs:
        im = cv2.imread(str(p), cv2.IMREAD_COLOR)
        if im is None:
            print(f"Skip unreadable: {p}", file=sys.stderr)
            continue
        im = crop_black_letterbox(im)
        bgr_frames.append(im)

    if not bgr_frames:
        return 2

    # Same size: min common crop (shave to min H/W across frames)
    mh = min(f.shape[0] for f in bgr_frames)
    mw = min(f.shape[1] for f in bgr_frames)
    bgr_frames = [f[:mh, :mw].copy() for f in bgr_frames]
    h, w = mh, mw
    print(f"Cropped viewport size: {w}x{h}")

    grays = [cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (0, 0), 1.2) for f in bgr_frames]

    pos, dbg = accumulate_positions(
        grays,
        args.phase_scale,
        args.max_shift,
        args.invert_phase,
        args.min_phase_response,
    )
    print("Pairwise shifts (dx, dy, resp) first 8:", dbg[:8])

    min_x, min_y, max_x, max_y = bbox_frames(pos, w, h, args.pad)
    canvas_w = max_x - min_x
    canvas_h = max_y - min_y
    print(f"Canvas bbox (pre-shift): {min_x},{min_y} .. {max_x},{max_y} -> {canvas_w}x{canvas_h}")

    pos_adj = [(p[0] - min_x, p[1] - min_y) for p in pos]

    if args.skip_median:
        print("skip-median: blending stacked frames (quick preview)")
        acc = np.zeros((canvas_h, canvas_w, 3), dtype=np.float32)
        cnt = np.zeros((canvas_h, canvas_w), dtype=np.float32)
        for i, f in enumerate(bgr_frames):
            if i in exclude:
                continue
            px, py = int(pos_adj[i][0]), int(pos_adj[i][1])
            acc[py : py + h, px : px + w] += f.astype(np.float32)
            cnt[py : py + h, px : px + w] += 1.0
        cnt = np.maximum(cnt, 1.0)[:, :, None]
        atlas = np.clip(acc / cnt, 0, 255).astype(np.uint8)
    else:
        print("Building median atlas (slow)...")
        atlas = build_median_atlas(
            bgr_frames, pos, min_x, min_y, max_x, max_y, exclude, args.workers
        )

    args.atlas_out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.atlas_out), atlas)
    print(f"Wrote {args.atlas_out}")

    # First frame top-left in atlas coords (after bbox shift)
    f0x, f0y = pos_adj[0]
    car_center_atlas = (f0x + w / 2.0, f0y + h / 2.0)

    write_meta(
        args.meta_out,
        args.meta_template,
        args.missions,
        args.mission_id,
        atlas.shape[1],
        atlas.shape[0],
        w,
        h,
        args.atlas_out.name,
        car_center_atlas,
        args.init_node,
    )
    print(f"Wrote {args.meta_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
