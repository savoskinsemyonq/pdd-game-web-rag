"""Cut buildings/trees/decorative blobs from mission2-map.png as transparent PNGs.

Reads:
  web/public/maps/mission2/mission2-map.png
  web/public/maps/mission2/mission2-map.meta.json
  web/public/maps/mission2/mission2-composite.json   (must exist — run extract-mission2-composite.py first)

Writes:
  web/public/maps/mission2/sprites/sprite_NNN.png    (transparent PNG per blob)
  web/public/maps/mission2/mission2-composite.json   (sprites[] array repopulated)
  web/public/maps/mission2/sprite-catalog.json       (templates for the map editor picker)

The script reuses the same color masks the composite extractor uses to mark grass
and roads, then takes the leftover (≈ buildings, trees, parked decoration cars)
as candidate sprites. Each candidate's bounding box is cropped from the original
PNG and either:
  - run through `rembg.remove()` for a clean alpha matte, or
  - alpha-keyed against the sampled grass color (fallback when rembg is missing).

Re-run any time mission2-map.png changes. The sprites/ folder is wiped first so
old crops never accumulate.
"""
from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MAP_DIR = ROOT / "public" / "maps" / "mission2"
PNG_PATH = MAP_DIR / "mission2-map.png"
META_PATH = MAP_DIR / "mission2-map.meta.json"
COMPOSITE_PATH = MAP_DIR / "mission2-composite.json"
SPRITES_DIR = MAP_DIR / "sprites"
SPRITE_CATALOG_PATH = MAP_DIR / "sprite-catalog.json"

# Discard any blob smaller than this (atlas pixels²) — kills speckle noise.
MIN_SPRITE_AREA_PX = 400
# Padding around each blob's bbox before cropping.
SPRITE_PAD_PX = 4
# Strict grass-color match for halo cleanup. Δ ≤ 4 trims the 1-pixel
# anti-aliased lawn fringe without biting into tree foliage greens. Was 8,
# which was too aggressive and dyed the edge of small sprites green-ish
# after the halo-fill changes in the composite extractor.
GRASS_TOLERANCE = 4
# Reject candidate blobs whose bbox overlaps surface labels by more than this
# fraction — they are surface artefacts (specular highlights on roads etc.),
# not buildings/trees.
SURFACE_OVERLAP_REJECT = 0.7
# Disable rembg: it destroys game-tile sprites (top-down art is not photo).
# The blob-mask + grass-key fallback gives correct results for this content.
USE_REMBG = False


def main() -> None:
    if not PNG_PATH.exists() or not META_PATH.exists() or not COMPOSITE_PATH.exists():
        raise SystemExit(
            "missing inputs — run extract-mission2-composite.py first and ensure mission2-map.png exists"
        )

    composite = json.loads(COMPOSITE_PATH.read_text(encoding="utf-8"))
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    min_x = int(meta["minX"])
    min_y = int(meta["minY"])
    grass_hex = composite.get("background", "#3aa454")
    grass_rgb = hex_to_rgb(grass_hex)
    print(f"[sprites] grass={grass_hex} ({grass_rgb})")

    bgr = cv2.imread(str(PNG_PATH), cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"cv2 failed to read {PNG_PATH}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]

    grass_mask = build_grass_mask(rgb)
    road_mask = build_road_mask(rgb)
    white_mask = build_white_mask(rgb)
    sidewalk_mask = build_sidewalk_mask(rgb)
    sand_mask = build_sand_mask(rgb)
    water_mask = build_water_mask(rgb)
    # Halo-fill road and sidewalk by 1 px (close + dilate) — mirrors the same
    # operation the composite extractor performs, so the dark anti-aliased
    # fringe at road/sidewalk edges is treated as surface (and excluded from
    # sprites) instead of becoming a green-rimmed sprite blob.
    kernel3 = np.ones((3, 3), np.uint8)
    road_mask = cv2.dilate(
        cv2.morphologyEx(road_mask, cv2.MORPH_CLOSE, kernel3, iterations=1),
        kernel3,
        iterations=1,
    )
    sidewalk_mask = cv2.dilate(
        cv2.morphologyEx(sidewalk_mask, cv2.MORPH_CLOSE, kernel3, iterations=1),
        kernel3,
        iterations=1,
    )
    # Every "drawable surface" label — sprites must NOT include any of these.
    surface_mask = cv2.bitwise_or(road_mask, white_mask)
    surface_mask = cv2.bitwise_or(surface_mask, sidewalk_mask)
    surface_mask = cv2.bitwise_or(surface_mask, sand_mask)
    surface_mask = cv2.bitwise_or(surface_mask, water_mask)
    surface_mask = cv2.morphologyEx(
        surface_mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=2
    )

    black_mask = (rgb.sum(axis=2) < 30).astype(np.uint8) * 255  # off-map (atlas padding)
    sprite_mask = (
        np.full((h, w), 255, dtype=np.uint8)
        & ~grass_mask
        & ~surface_mask
        & ~black_mask
    )
    # Tiny noise: open with 2x2 to remove single-pixel speckle. NO close, NO
    # dilate — both used to grow the mask into the surrounding grass and that's
    # exactly the green-halo bug we're fixing.
    sprite_mask = cv2.morphologyEx(
        sprite_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8), iterations=1
    )

    rembg_remove = None if not USE_REMBG else try_load_rembg()
    if rembg_remove is None:
        print("[sprites] using blob-mask + grass-key alpha (rembg disabled)")
    else:
        print("[sprites] rembg available - using ML alpha matte")

    if SPRITES_DIR.exists():
        shutil.rmtree(SPRITES_DIR)
    SPRITES_DIR.mkdir(parents=True, exist_ok=True)

    num_labels, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        sprite_mask, connectivity=8
    )
    sprites: list[dict] = []
    written = 0
    skipped_overlap = 0
    for label_id in range(1, num_labels):
        x, y, bw, bh, area = stats[label_id]
        if area < MIN_SPRITE_AREA_PX:
            continue
        x0 = max(0, x - SPRITE_PAD_PX)
        y0 = max(0, y - SPRITE_PAD_PX)
        x1 = min(w, x + bw + SPRITE_PAD_PX)
        y1 = min(h, y + bh + SPRITE_PAD_PX)

        # Reject blobs whose bbox is mostly surface — those are artefacts of
        # mask noise (a few rogue pixels in a road), not sprites.
        bbox_area = (x1 - x0) * (y1 - y0)
        surface_in_bbox = (surface_mask[y0:y1, x0:x1] > 0).sum()
        if surface_in_bbox / max(1, bbox_area) > SURFACE_OVERLAP_REJECT:
            skipped_overlap += 1
            continue

        crop_rgb = rgb[y0:y1, x0:x1]
        # Local mask of *this* blob (needed both for tile detection and alpha).
        blob_mask = (labels[y0:y1, x0:x1] == label_id).astype(np.uint8) * 255

        # Skip game-tile objects that should not be static sprites.
        if is_game_tile(crop_rgb, blob_mask, x1 - x0, y1 - y0):
            skipped_overlap += 1
            continue

        sprite_img = build_sprite_png(crop_rgb, blob_mask, grass_rgb, rembg_remove)
        if sprite_img is None:
            continue

        fname = f"sprite_{label_id:04d}.png"
        out_path = SPRITES_DIR / fname
        sprite_img.save(out_path, format="PNG", optimize=True)

        cx_world = (x0 + (x1 - x0) / 2) + min_x
        cy_world = (y0 + (y1 - y0) / 2) + min_y
        sprites.append(
            {
                "file": f"sprites/{fname}",
                "cx": float(cx_world),
                "cy": float(cy_world),
                "w": int(x1 - x0),
                "h": int(y1 - y0),
            }
        )
        written += 1

    composite["sprites"] = sprites
    COMPOSITE_PATH.write_text(json.dumps(composite, indent=2), encoding="utf-8")
    catalog_obj = {
        "version": 1,
        "sprites": [{"file": s["file"], "w": s["w"], "h": s["h"]} for s in sprites],
    }
    SPRITE_CATALOG_PATH.write_text(json.dumps(catalog_obj, indent=2), encoding="utf-8")
    print(f"[sprites] wrote {written} sprites -> {SPRITES_DIR}")
    print(f"[sprites] skipped {skipped_overlap} blobs (surfaces / game tiles / thin)")
    print(f"[sprites] updated {COMPOSITE_PATH}")
    print(f"[sprites] wrote sprite catalog -> {SPRITE_CATALOG_PATH}")


def is_game_tile(
    crop_rgb: np.ndarray, blob_mask: np.ndarray, w: int, h: int
) -> bool:
    """Return True for game-engine tile objects that should not be static sprites.

    Color stats use only blob pixels (not bbox background) for accuracy.
    """
    # Thin stripes / poles: extreme dimension.
    if w < 20 or h < 20:
        return True
    aspect = max(w, h) / max(min(w, h), 1)

    # Stats on blob pixels only — ignores surrounding grass in the bbox.
    blob_px = crop_rgb[blob_mask > 0].astype(np.int16)
    if len(blob_px) == 0:
        return True
    r, g, b = blob_px[:, 0], blob_px[:, 1], blob_px[:, 2]
    total = len(blob_px)
    mr, mg, mb = float(r.mean()), float(g.mean()), float(b.mean())
    std = float(blob_px.std())

    # Red-dominant: road signs (triangles), barrier tape, stop poles. Only
    # reject SMALL red blobs — large red shapes are typically buildings with
    # red roofs and must stay as sprites. The earlier broader rule ate them
    # and was the main reason "some sprites changed colour".
    if mr > 140 and mg < mr * 0.65 and mb < mr * 0.65 and w < 64 and h < 64:
        return True

    # Yellow/golden dominant: yield signs, warning diamonds, caution tape, barriers.
    # Same size guard as red — preserve large yellow buildings / awnings.
    if mr > 150 and mg > 100 and mb < 110 and w < 64 and h < 64:
        return True

    # Traffic light: red signal co-existing with green or yellow signal.
    br = int(((r > 160) & (g < 100) & (b < 100)).sum()) / total
    bg = int(((r < 100) & (g > 140) & (b < 100)).sum()) / total
    by = int(((r > 160) & (g > 120) & (b < 100)).sum()) / total
    if br > 0.02 and (bg > 0.015 or by > 0.02):
        return True

    # Building facade tiles: large dark-brownish (maroon brick) blob.
    dark_m = int(((r >= 60) & (r < 160) & (g < r * 0.65) & (b < r * 0.65)).sum())
    if dark_m / total > 0.45 and w * h > 2000:
        return True

    # Dark near-neutral uniform blobs: building shadows, tile elements.
    # Vegetation always has clear green dominance (mg > mr+8, mg > mb+8); tiles don't.
    if std < 20 and max(mr, mg, mb) < 60 and not (mg > mr + 8 and mg > mb + 8):
        return True

    # Colored non-vegetation artifacts (magenta, cyan, etc.): high blue relative to red,
    # very low green relative to red.
    if mb > mr * 0.6 and mg < mr * 0.45 and mr > 100:
        return True

    # Very elongated uniform blob (pole, stripe).
    if aspect > 6 and std < 60:
        return True

    return False


def build_sprite_png(
    crop_rgb: np.ndarray,
    blob_mask: np.ndarray,
    grass_rgb: tuple[int, int, int],
    rembg_remove,
) -> Image.Image | None:
    """Produce a transparent PNG for the cropped blob.

    Path 1 (rembg): pre-mask off pixels not in the blob (so rembg only sees this object),
    then run rembg for a smooth alpha matte. Path 2 (no rembg): build alpha from the
    blob mask directly, then key out any residual grass pixels.
    """
    h, w = crop_rgb.shape[:2]
    rgba = np.dstack([crop_rgb, blob_mask]).astype(np.uint8)
    if rembg_remove is not None:
        try:
            buf = io.BytesIO()
            Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
            cleaned = rembg_remove(buf.getvalue())
            return Image.open(io.BytesIO(cleaned)).convert("RGBA")
        except Exception as exc:  # pragma: no cover - depends on user env
            print(f"  [sprites] rembg failed on {w}x{h} crop: {exc}; falling back")

    # Fallback: alpha = blob_mask, then strict grass key only on edge pixels
    # (those that touch a transparent neighbour). Interior tree-foliage greens
    # are protected — we only key out grass that already sits on the boundary.
    alpha = blob_mask.copy()
    if alpha.max() == 0:
        return None
    # Edge pixels: blob pixels with at least one transparent neighbour.
    inv = (alpha == 0).astype(np.uint8)
    edge_neighbours = cv2.dilate(inv, np.ones((3, 3), np.uint8), iterations=1)
    on_edge = (alpha > 0) & (edge_neighbours > 0)
    diff = np.abs(crop_rgb.astype(np.int16) - np.asarray(grass_rgb)[None, None, :]).max(axis=2)
    grass_edge = on_edge & (diff < GRASS_TOLERANCE)
    alpha[grass_edge] = 0
    if alpha.max() == 0:
        return None
    return Image.fromarray(np.dstack([crop_rgb, alpha]).astype(np.uint8), mode="RGBA")


def build_sidewalk_mask(rgb: np.ndarray) -> np.ndarray:
    """Sidewalk: medium-grey, low saturation, brighter than road. Tuned to
    match `build_label_map` in extract-mission2-composite.py so sprite and
    composite extractors agree on which pixels are sidewalk."""
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    spread = np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])
    mean = (r + g + b) / 3.0
    mask = (spread < 22) & (mean >= 86) & (mean < 130)
    return (mask.astype(np.uint8)) * 255


def build_sand_mask(rgb: np.ndarray) -> np.ndarray:
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mask = (r > 140) & (r < 230) & (g > 120) & (g < 200) & (b < 140) & (r > g) & (g > b)
    return (mask.astype(np.uint8)) * 255


def build_water_mask(rgb: np.ndarray) -> np.ndarray:
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mask = (b > r + 30) & (b > g + 10) & (b > 120)
    return (mask.astype(np.uint8)) * 255


def build_grass_mask(rgb: np.ndarray) -> np.ndarray:
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mask = (g > r + 10) & (g > b + 10) & (g > 70) & (g < 200)
    return (mask.astype(np.uint8)) * 255


def build_road_mask(rgb: np.ndarray) -> np.ndarray:
    """Road: dark desaturated grey (asphalt). Mean cap ≤ 88 keeps clear of
    sidewalk so the sprite mask doesn't double-cover boundary pixels."""
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    spread = np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])
    mean = (r + g + b) / 3.0
    mask = (spread < 30) & (mean > 50) & (mean < 88)
    return (mask.astype(np.uint8)) * 255


def build_white_mask(rgb: np.ndarray) -> np.ndarray:
    r = rgb[:, :, 0]
    g = rgb[:, :, 1]
    b = rgb[:, :, 2]
    mask = (r > 215) & (g > 215) & (b > 215)
    return (mask.astype(np.uint8)) * 255


def try_load_rembg():
    try:
        from rembg import remove  # type: ignore[import-not-found]
        return remove
    except ImportError:
        return None


def hex_to_rgb(s: str) -> tuple[int, int, int]:
    s = s.lstrip("#")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


if __name__ == "__main__":
    main()
