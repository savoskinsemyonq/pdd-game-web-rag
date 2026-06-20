"""Color-segment mission2-map.png into a multi-surface composite scene JSON.

Reads:
  web/public/maps/mission2/mission2-map.png
  web/public/maps/mission2/mission2-map.meta.json

Writes:
  web/public/maps/mission2/mission2-composite.json   (schema version 2)
  web/public/maps/mission2/_debug-labels.png         (when --dump-labels passed)

Each pixel is classified into one of:
  void / grass / water / sand / sidewalk / road / trolleybus_rails / rails
plus a separate `white_marking` mask for road paint.

Anti-aliased dark borders that previously fell into VOID (and therefore showed
through as the green grass <rect>, producing the "green halo" around roads /
sidewalks / white paint) are now folded into the nearest real surface via
two passes:

  1. Per-mask MORPH_CLOSE then dilate by 1-2 px so the surface absorbs its
     own anti-aliased fringe.
  2. Distance-transform extension into atlas VOID uses a fixed radius (world /
     atlas px) so road/sidewalk absorb nearby VOID fringe near stitched edges.

  3. `heal_surface_cliffs()` snaps adjacent GRASS/VOID pixels that still match
     asphalt/sidewalk colour back onto the nearest road/sidewalk blob.

White paint pixels with a VOID label underneath are also forced to ROAD so
markings sit on asphalt rather than on the grass <rect>.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MAP_DIR = ROOT / "public" / "maps" / "mission2"
PNG_PATH = MAP_DIR / "mission2-map.png"
META_PATH = MAP_DIR / "mission2-map.meta.json"
OUT_PATH = MAP_DIR / "mission2-composite.json"
DEBUG_PATH = MAP_DIR / "_debug-labels.png"

# Label IDs used in the per-pixel label map.
L_VOID = 0
L_GRASS = 1
L_WATER = 2
L_SAND = 3
L_SIDEWALK = 4
L_ROAD = 5
L_TROLLEYBUS = 6
L_RAILS = 7

# Painter z-order — lower IDs first when written to the JSON. The renderer
# applies the same order, so trolleybus stripes draw on top of road, and
# train rails draw on top of trolleybus.
SURFACE_LABELS: list[tuple[int, str]] = [
    (L_WATER, "water"),
    (L_SAND, "sand"),
    (L_SIDEWALK, "sidewalk"),
    (L_ROAD, "road"),
    (L_TROLLEYBUS, "trolleybus_rails"),
    (L_RAILS, "rails"),
]

# Detection toggles. Both rails kinds are best-effort and DISABLED by default
# for mission 2 because the source PNG doesn't contain actual rail tiles in a
# uniform colour signature — the dark anti-aliased pair-of-lines pattern that
# our pixel-level detector latches onto also appears at every road border, so
# running the detector greedily turns half the map into "trolleybus_rails".
#
# Flip these flags to True for missions where rails are visible (uniform
# wood-tie/asphalt strips); otherwise rely on the in-game MapCompositeEditor
# to hand-paint rail surfaces — they will render correctly with the matching
# textures via the renderer's <pattern> defs.
DETECT_TROLLEYBUS = False
DETECT_RAILS = False

# How far (atlas px) road/sidewalk labels propagate into VOID via distance fill.
# Not tied to game viewport — adjust manually if halos at map edges need more/less fill.
VOID_EXTENSION_RADIUS_PX = 16

# Heal misclassified GRASS / residual VOID fringes that still look like pavement
# in RGB and sit within this distance (px) of an existing road/sidewalk blob.
HEAL_ASPHALT_NEAR_ROAD_PX = 16
HEAL_PAVING_NEAR_SIDEWALK_PX = 12

# Per-kind minimum polygon area (atlas pixels²) and Douglas-Peucker epsilon.
MIN_AREAS = {
    L_WATER: 400,
    L_SAND: 400,
    L_SIDEWALK: 400,
    L_ROAD: 1200,
    L_TROLLEYBUS: 60,
    L_RAILS: 200,
}
EPSILONS = {
    L_WATER: 1.5,
    L_SAND: 1.5,
    L_SIDEWALK: 1.0,
    L_ROAD: 1.5,
    L_TROLLEYBUS: 0.6,
    L_RAILS: 0.8,
}
HOLE_MIN_AREA = 800

MIN_MARKING_AREA_PX = 8
# Douglas–Peucker for marking contours: lower ⇒ более «прямые» углы, ближе к линиям на PNG.
MARKING_EPSILON_PX = 0.35


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dump-labels",
        action="store_true",
        help="Save a colourised _debug-labels.png next to the JSON for visual inspection.",
    )
    args = parser.parse_args()

    if not PNG_PATH.exists() or not META_PATH.exists():
        raise SystemExit(f"missing inputs: {PNG_PATH} or {META_PATH}")

    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    min_x = int(meta["minX"])
    min_y = int(meta["minY"])
    max_x = int(meta["maxX"])
    max_y = int(meta["maxY"])

    bgr = cv2.imread(str(PNG_PATH), cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"cv2 failed to read {PNG_PATH}")
    h, w = bgr.shape[:2]
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    print(f"[extract] image {w}x{h}; world ({min_x},{min_y})..({max_x},{max_y})")

    grass_color = sample_grass_color(rgb)
    print(f"[extract] grass=#{grass_color[0]:02x}{grass_color[1]:02x}{grass_color[2]:02x}")

    label_map, white_mask = build_label_map(rgb)
    print_label_stats(label_map, "raw")

    void_rad = VOID_EXTENSION_RADIUS_PX
    print(f"[extract] void extension radius {void_rad}px (fixed)")
    label_map = extend_into_void(label_map, void_rad)
    print_label_stats(label_map, "after extension")

    label_map = force_road_under_markings(label_map, white_mask)
    print_label_stats(label_map, "after marking-fill")

    label_map = heal_surface_cliffs(rgb, label_map)
    print_label_stats(label_map, "after cliff-heal")

    if DETECT_TROLLEYBUS or DETECT_RAILS:
        label_map = detect_rail_like(rgb, label_map)
        print_label_stats(label_map, "after rails")

    if args.dump_labels:
        dump_labels(label_map, white_mask)

    surfaces: list[dict] = []
    for kind_id, kind_name in SURFACE_LABELS:
        mask = (label_map == kind_id).astype(np.uint8) * 255
        if not mask.any():
            continue
        polys = mask_to_polygons(mask, MIN_AREAS[kind_id], EPSILONS[kind_id])
        for poly in polys:
            entry: dict = {
                "kind": kind_name,
                "points": shift_to_world(poly["points"], min_x, min_y),
            }
            if poly.get("holes"):
                entry["holes"] = [shift_to_world(hh, min_x, min_y) for hh in poly["holes"]]
            surfaces.append(entry)
    by_kind = Counter(s["kind"] for s in surfaces)
    print(f"[extract] surfaces emitted: {len(surfaces)} ({dict(by_kind)})")

    markings: list[dict] = []
    for poly in mask_to_polygons(white_mask, MIN_MARKING_AREA_PX, MARKING_EPSILON_PX):
        m: dict = {
            "type": "polygon",
            "points": shift_to_world(poly["points"], min_x, min_y),
        }
        if poly.get("holes"):
            m["holes"] = [shift_to_world(hh, min_x, min_y) for hh in poly["holes"]]
        markings.append(m)
    print(f"[extract] markings: {len(markings)}")

    composite = {
        "version": 2,
        "world": {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y},
        "background": rgb_hex(grass_color),
        "surfaces": surfaces,
        "markings": markings,
        "sprites": [],
    }
    OUT_PATH.write_text(json.dumps(composite, indent=2), encoding="utf-8")
    print(f"[extract] wrote {OUT_PATH}")


def sample_grass_color(rgb: np.ndarray) -> tuple[int, int, int]:
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mask = (g > r + 10) & (g > b + 10) & (g > 70) & (g < 200)
    if not mask.any():
        return (58, 138, 78)
    pix = rgb[mask]
    quantized = (pix // 16).astype(np.uint8)
    keys = (
        quantized[:, 0].astype(np.uint32) * 256
        + quantized[:, 1].astype(np.uint32) * 16
        + quantized[:, 2].astype(np.uint32)
    )
    counts = Counter(keys.tolist())
    top_key, _ = counts.most_common(1)[0]
    qr = (top_key // 256) & 0xF
    qg = (top_key // 16) & 0xF
    qb = top_key & 0xF
    bucket = (
        (quantized[:, 0] == qr) & (quantized[:, 1] == qg) & (quantized[:, 2] == qb)
    )
    sample = pix[bucket]
    mean = sample.mean(axis=0).astype(int)
    return int(mean[0]), int(mean[1]), int(mean[2])


def build_label_map(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (label_map uint8, white_marking_mask uint8).

    Each pixel ends up with one of L_VOID, L_GRASS, L_WATER, L_SAND, L_SIDEWALK,
    or L_ROAD. Trolleybus / rails are added by detect_rail_like() in a later
    pass once road has been finalised. White paint is reported separately so
    it can be drawn on top of any underlying surface.
    """
    h, w = rgb.shape[:2]
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)

    void = (rgb.sum(axis=2) < 30)
    spread = np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])
    mean = (r + g + b) / 3.0

    grass = (g > r + 10) & (g > b + 10) & (g > 70) & (g < 200)
    water = (b > r + 30) & (b > g + 10) & (b > 120)
    sand = (r > 140) & (r < 230) & (g > 120) & (g < 200) & (b < 140) & (r > g) & (g > b)

    # Sidewalk: medium-grey, low saturation, brighter than road. Tuned against
    # web/assets/sidewalk.png (mean ~98, spread ~9) and the actual histogram of
    # mission2-map.png where sidewalks cluster around mean 95..115.
    sidewalk_seed = (spread < 22) & (mean >= 86) & (mean < 130) & ~void & ~grass

    # Road: dark desaturated grey (asphalt). Mean cap of 88 keeps clear water
    # of sidewalk so we don't double-label.
    road_seed = (spread < 30) & (mean > 50) & (mean < 88) & ~void

    white = (r > 215) & (g > 215) & (b > 215)

    # ---- Halo absorption -------------------------------------------------
    # Anti-aliased dark fringes at the road / sidewalk boundary often have
    # spread > 30 or mean > 88 (they sit on the line between asphalt and
    # surrounding green). MORPH_CLOSE 3x3 fills 1-2 px gaps, then a single
    # dilate ×1 grows the surface outward by one pixel so the dark fringe is
    # absorbed instead of falling into VOID. This is the main fix for the
    # "green halo around roads / sidewalks / paint" complaint.
    kernel3 = np.ones((3, 3), np.uint8)
    road_seed_u8 = road_seed.astype(np.uint8) * 255
    road_seed_u8 = cv2.morphologyEx(road_seed_u8, cv2.MORPH_CLOSE, kernel3, iterations=1)
    road_seed_u8 = cv2.dilate(road_seed_u8, kernel3, iterations=1)
    road_filled = (road_seed_u8 > 0) & ~void

    sidewalk_seed_u8 = sidewalk_seed.astype(np.uint8) * 255
    sidewalk_seed_u8 = cv2.morphologyEx(sidewalk_seed_u8, cv2.MORPH_CLOSE, kernel3, iterations=1)
    sidewalk_seed_u8 = cv2.dilate(sidewalk_seed_u8, kernel3, iterations=1)
    sidewalk_filled = (sidewalk_seed_u8 > 0) & ~void & ~grass
    # --------------------------------------------------------------------

    label = np.full((h, w), L_VOID, dtype=np.uint8)
    label[grass] = L_GRASS
    label[water] = L_WATER
    label[sand] = L_SAND
    label[sidewalk_filled & ~water & ~sand] = L_SIDEWALK
    # Road wins over sidewalk at the boundary — their dilations overlap by 1 px,
    # and we want road to extend cleanly across the dilation seam.
    label[road_filled & ~water & ~sand] = L_ROAD

    white_mask = (white.astype(np.uint8)) * 255
    return label, white_mask


def force_road_under_markings(label_map: np.ndarray, white_mask: np.ndarray) -> np.ndarray:
    """White paint with a VOID label underneath gets promoted to ROAD.

    White marking pixels are not assigned a surface kind by build_label_map();
    they live in `white_mask` and the renderer draws them on top. If the
    underlying label is VOID, the green grass <rect> shows through instead of
    asphalt — that's the "green halo around the white line" effect. Forcing
    those pixels to ROAD removes the halo without affecting interior grass.
    """
    out = label_map.copy()
    paint = white_mask > 0
    voided_paint = paint & (out == L_VOID)
    out[voided_paint] = L_ROAD
    return out


def heal_surface_cliffs(rgb: np.ndarray, label_map: np.ndarray) -> np.ndarray:
    """Grow road/sidewalk labels onto neighbouring GRASS or VOID pixels whose
    colour still matches asphalt / paving.

    Segmentation sometimes stops short of the stitched atlas boundary (leave a
    band labelled GRASS though the PNG looks grey), or leaves a thin VOID fringe
    where sum(rgb) is just above the pure-black threshold. Distance-constrained
    colour snapping joins those pixels back to the nearest surface blob.
    """
    out = label_map.copy()
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    spread = np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])
    mean = (r + g + b) / 3.0
    void_dark = rgb.sum(axis=2) < 30

    asphalt = (spread < 34) & (mean > 48) & (mean < 93) & ~void_dark
    paving = (spread < 26) & (mean >= 80) & (mean < 134) & ~void_dark

    patchable = (out == L_GRASS) | (out == L_VOID)
    protect = (out == L_WATER) | (out == L_SAND)

    rd = (out == L_ROAD).astype(np.uint8)
    if rd.any():
        inv = (rd == 0).astype(np.uint8)
        dist_r = cv2.distanceTransform(inv, cv2.DIST_L2, 5)
        heal = patchable & ~protect & asphalt & (dist_r <= HEAL_ASPHALT_NEAR_ROAD_PX)
        out[heal] = L_ROAD

    sw = (out == L_SIDEWALK).astype(np.uint8)
    if sw.any():
        inv = (sw == 0).astype(np.uint8)
        dist_s = cv2.distanceTransform(inv, cv2.DIST_L2, 5)
        heal = patchable & ~protect & paving & (dist_s <= HEAL_PAVING_NEAR_SIDEWALK_PX)
        heal &= out != L_ROAD
        out[heal] = L_SIDEWALK

    return out


def extend_into_void(label_map: np.ndarray, radius_px: int) -> np.ndarray:
    """For VOID pixels within radius_px of road/sidewalk, inherit the nearest
    of those kinds.

    Sidewalk now extends too (in addition to road) so sidewalk slabs no longer
    cut off into a grass cliff at the L-shape boundary. Other surfaces stay
    where they are — extending sand/water/grass would bleed into road.
    """
    if radius_px <= 0:
        return label_map.copy()
    out = label_map.copy()
    void_only = (out == L_VOID)
    if not void_only.any():
        return out

    extend_kinds = {L_ROAD, L_SIDEWALK}

    dists: list[np.ndarray] = []
    kinds: list[int] = []
    for kind_id, _name in SURFACE_LABELS:
        if kind_id not in extend_kinds:
            continue
        mask = (out == kind_id).astype(np.uint8)
        if not mask.any():
            continue
        inv = (mask == 0).astype(np.uint8)
        dist = cv2.distanceTransform(inv, cv2.DIST_L2, 3)
        dists.append(dist)
        kinds.append(kind_id)

    if not dists:
        return out

    stack = np.stack(dists, axis=0)
    nearest = stack.argmin(axis=0)
    nearest_dist = stack.min(axis=0)
    fill_zone = void_only & (nearest_dist <= radius_px)

    kinds_arr = np.array(kinds, dtype=np.uint8)
    out[fill_zone] = kinds_arr[nearest[fill_zone]]
    return out


def detect_rail_like(rgb: np.ndarray, label_map: np.ndarray) -> np.ndarray:
    """Find pairs of long thin parallel dark runs and label them as either
    train rails (with sleepers between) or trolleybus rails (no sleepers,
    sit inside a road).

    Strict heuristics — false positives are worse than misses, since the user
    can hand-paint missing rails in the in-game editor while a wrongly-labelled
    building roof can't easily be recovered.
    """
    out = label_map.copy()
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    spread = np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])
    mean = (r + g + b) / 3.0

    very_dark = (spread < 18) & (mean < 50) & (out != L_VOID)
    nb = cv2.morphologyEx(very_dark.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    # Build per-axis "thin & long" maps. A pixel passes when it lies on a run
    # ≥ 40 px in the primary direction and ≤ 6 px in the perpendicular.
    horiz = cv2.morphologyEx(nb, cv2.MORPH_OPEN, np.ones((1, 40), np.uint8))
    horiz_thick = cv2.erode(horiz, np.ones((7, 1), np.uint8))
    horiz_thin = cv2.subtract(horiz, horiz_thick)

    vert = cv2.morphologyEx(nb, cv2.MORPH_OPEN, np.ones((40, 1), np.uint8))
    vert_thick = cv2.erode(vert, np.ones((1, 7), np.uint8))
    vert_thin = cv2.subtract(vert, vert_thick)

    out = _emit_rail_pairs(out, horiz_thin, nb, axis="h")
    out = _emit_rail_pairs(out, vert_thin, nb, axis="v")
    return out


def _emit_rail_pairs(
    label_map: np.ndarray,
    thin_runs: np.ndarray,
    all_dark: np.ndarray,
    axis: str,
) -> np.ndarray:
    """Group connected thin-run components into pairs and decide between
    train rails (sleeper validation succeeds) and trolleybus rails (pair sits
    inside road, tight gauge, no sleepers).

    `thin_runs`: 1-pixel mask of runs that are ≥40 px long in the primary
    direction and ≤6 px thick in the perpendicular.
    `all_dark`: 1-pixel mask of ALL very-dark pixels — used to detect sleeper
    stripes between the rails.
    """
    if thin_runs.max() == 0:
        return label_map
    out = label_map.copy()
    n, _, stats, _ = cv2.connectedComponentsWithStats(thin_runs, connectivity=8)
    runs: list[tuple[int, int, int, int]] = []
    for lid in range(1, n):
        x, y, ww, hh, area = stats[lid]
        length = ww if axis == "h" else hh
        thickness = hh if axis == "h" else ww
        if length < 60 or thickness > 6 or area < length * 0.55:
            continue
        runs.append((int(x), int(y), int(ww), int(hh)))
    if len(runs) < 2:
        return out

    used: set[int] = set()
    for i in range(len(runs)):
        if i in used:
            continue
        xi, yi, wi, hi = runs[i]
        best_j = -1
        best_dist = 1e9
        for j in range(i + 1, len(runs)):
            if j in used:
                continue
            xj, yj, wj, hj = runs[j]
            if axis == "h":
                a0, a1 = max(xi, xj), min(xi + wi, xj + wj)
                if a1 - a0 < 0.7 * min(wi, wj):
                    continue
                d = abs((yi + hi / 2) - (yj + hj / 2))
            else:
                a0, a1 = max(yi, yj), min(yi + hi, yj + hj)
                if a1 - a0 < 0.7 * min(hi, hj):
                    continue
                d = abs((xi + wi / 2) - (xj + wj / 2))
            # Allow gauge in the [10, 200] px range — narrow enough to skip
            # accidental "pairs" formed by far-apart unrelated dark lines, wide
            # enough to cover both trolleybus (~14 px) and train rails (~150 px).
            if 10 < d < 200 and d < best_dist:
                best_dist = d
                best_j = j
        if best_j < 0:
            continue
        j = best_j
        xj, yj, wj, hj = runs[j]
        used.add(i)
        used.add(j)

        rx0 = max(0, min(xi, xj) - 2)
        rx1 = min(out.shape[1], max(xi + wi, xj + wj) + 2)
        ry0 = max(0, min(yi, yj) - 2)
        ry1 = min(out.shape[0], max(yi + hi, yj + hj) + 2)
        strip_label = out[ry0:ry1, rx0:rx1]
        strip_dark = all_dark[ry0:ry1, rx0:rx1]
        if strip_label.size == 0:
            continue

        road_share = float((strip_label == L_ROAD).sum()) / strip_label.size
        sleeper_score = _sleeper_score(strip_dark, axis)

        kind: int | None = None
        # Train rails: sleepers detected. Sleeper validation tolerates the
        # rails sitting on grass / void / sand (a railway corridor).
        if DETECT_RAILS and sleeper_score >= 4 and best_dist >= 30:
            kind = L_RAILS
        # Trolleybus: tight gauge, sits inside road, no sleepers required.
        elif DETECT_TROLLEYBUS and road_share > 0.7 and best_dist < 30:
            kind = L_TROLLEYBUS

        if kind is None:
            continue

        # Don't overwrite grass/water/sand — keep them visible. We only paint
        # over VOID and ROAD pixels (the natural substrate of rails).
        write_mask = (strip_label == L_VOID) | (strip_label == L_ROAD)
        strip_label[write_mask] = kind
        out[ry0:ry1, rx0:rx1] = strip_label
    return out


def _sleeper_score(strip_dark: np.ndarray, axis: str) -> int:
    """Count perpendicular dark stripes inside the strip — these are sleepers
    on a railway. Higher = more confident this is train rails.

    For a horizontal-rail pair (axis="h"), sleepers are vertical stripes.
    """
    if strip_dark.size == 0:
        return 0
    if axis == "h":
        col_density = strip_dark.mean(axis=0)
    else:
        col_density = strip_dark.mean(axis=1)
    threshold = 0.6
    above = col_density > threshold
    transitions = 0
    prev = False
    for v in above:
        if v and not prev:
            transitions += 1
        prev = bool(v)
    return transitions


def mask_to_polygons(
    mask: np.ndarray, min_area: float, epsilon: float
) -> list[dict]:
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    hier = hierarchy[0]
    polys: list[dict] = []
    for i, cnt in enumerate(contours):
        if hier[i][3] != -1:
            continue
        if cv2.contourArea(cnt) < min_area:
            continue
        outer = cv2.approxPolyDP(cnt, epsilon, True)
        if len(outer) < 3:
            continue
        outer_pts = [[int(p[0][0]), int(p[0][1])] for p in outer]
        holes: list[list[list[int]]] = []
        child = hier[i][2]
        while child != -1:
            child_cnt = contours[child]
            if cv2.contourArea(child_cnt) >= max(min_area, HOLE_MIN_AREA):
                approx = cv2.approxPolyDP(child_cnt, epsilon, True)
                if len(approx) >= 3:
                    holes.append([[int(p[0][0]), int(p[0][1])] for p in approx])
            child = hier[child][0]
        entry: dict = {"points": outer_pts}
        if holes:
            entry["holes"] = holes
        polys.append(entry)
    return polys


def shift_to_world(poly: list[list[int]], min_x: int, min_y: int) -> list[list[int]]:
    return [[p[0] + min_x, p[1] + min_y] for p in poly]


def rgb_hex(rgb: tuple[int, int, int]) -> str:
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def print_label_stats(label_map: np.ndarray, tag: str) -> None:
    counts = {
        "void": int((label_map == L_VOID).sum()),
        "grass": int((label_map == L_GRASS).sum()),
        "water": int((label_map == L_WATER).sum()),
        "sand": int((label_map == L_SAND).sum()),
        "sidewalk": int((label_map == L_SIDEWALK).sum()),
        "road": int((label_map == L_ROAD).sum()),
        "trolleybus": int((label_map == L_TROLLEYBUS).sum()),
        "rails": int((label_map == L_RAILS).sum()),
    }
    parts = " ".join(f"{k}={v}" for k, v in counts.items() if v > 0)
    print(f"[extract] labels ({tag}): {parts}")


def dump_labels(label_map: np.ndarray, white_mask: np.ndarray) -> None:
    palette = {
        L_VOID: (0, 0, 0),
        L_GRASS: (60, 160, 80),
        L_WATER: (60, 120, 200),
        L_SAND: (200, 180, 100),
        L_SIDEWALK: (180, 170, 165),
        L_ROAD: (60, 60, 60),
        L_TROLLEYBUS: (220, 60, 200),
        L_RAILS: (220, 200, 60),
    }
    out = np.zeros((*label_map.shape, 3), dtype=np.uint8)
    for kind_id, color in palette.items():
        out[label_map == kind_id] = color
    out[white_mask > 0] = (255, 255, 255)
    cv2.imwrite(str(DEBUG_PATH), cv2.cvtColor(out, cv2.COLOR_RGB2BGR))
    print(f"[extract] wrote {DEBUG_PATH}")


if __name__ == "__main__":
    main()
