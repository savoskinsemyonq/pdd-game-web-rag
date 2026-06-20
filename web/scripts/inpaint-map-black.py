#!/usr/bin/env python3
"""
Fill black/empty areas in a mission map PNG using OpenCV inpainting.

Black areas are defined as pixels where all RGB channels are below a threshold.
Uses Telea inpainting algorithm which extrapolates from neighbouring pixels.

Usage:
    python inpaint-map-black.py
    python inpaint-map-black.py --input mission1-map.png --output mission1-map.png
    python inpaint-map-black.py --black-thresh 20 --radius 15 --preview
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
MAPS_DIR = REPO_ROOT / "web" / "public" / "maps" / "mission1"


def imread_unicode(path: Path) -> np.ndarray | None:
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


def build_black_mask(bgr: np.ndarray, thresh: int) -> np.ndarray:
    """Return uint8 mask: 255 where all channels are <= thresh (black area)."""
    dark = np.all(bgr <= thresh, axis=2).astype(np.uint8) * 255
    return dark


def inpaint_image(
    bgr: np.ndarray,
    mask: np.ndarray,
    radius: int,
    method: str,
) -> np.ndarray:
    flag = cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS
    return cv2.inpaint(bgr, mask, radius, flag)


def save_preview(original: np.ndarray, mask: np.ndarray, result: np.ndarray, path: Path) -> None:
    """Save a side-by-side comparison, downscaled to fit in ~1200px width."""
    scale = min(1.0, 400 / original.shape[1])
    h = int(original.shape[0] * scale)
    w = int(original.shape[1] * scale)

    def rs(img: np.ndarray) -> np.ndarray:
        return cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)

    mask_bgr = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
    # tint mask red for visibility
    mask_vis = mask_bgr.copy()
    mask_vis[:, :, 0] = 0  # zero blue
    mask_vis[:, :, 1] = 0  # zero green
    # red channel stays

    panel = np.concatenate([rs(original), rs(mask_vis), rs(result)], axis=1)
    imwrite_unicode(path, panel)
    print(f"  Preview saved: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Inpaint black areas in a map PNG")
    parser.add_argument("--input", default="mission1-map.png",
                        help="Input filename inside maps/mission1/ (default: mission1-map.png)")
    parser.add_argument("--output", default="mission1-map.png",
                        help="Output filename (default: overwrites input)")
    parser.add_argument("--black-thresh", type=int, default=15,
                        help="Max channel value to consider a pixel black (default: 15)")
    parser.add_argument("--radius", type=int, default=20,
                        help="Inpainting neighbourhood radius in pixels (default: 20)")
    parser.add_argument("--method", choices=["telea", "ns"], default="telea",
                        help="Inpainting algorithm: telea (default) or ns (Navier-Stokes)")
    parser.add_argument("--preview", action="store_true",
                        help="Save before/mask/after preview PNG next to output")
    parser.add_argument("--dry-run", action="store_true",
                        help="Analyse only, do not write output")
    args = parser.parse_args()

    in_path = MAPS_DIR / args.input
    out_path = MAPS_DIR / args.output

    print(f"Loading {in_path} …")
    bgr = imread_unicode(in_path)
    if bgr is None:
        raise SystemExit(f"Could not load image: {in_path}")
    h, w = bgr.shape[:2]
    total_px = h * w
    print(f"  Size: {w}x{h} px  ({total_px:,} pixels)")

    print(f"Building black mask (thresh={args.black_thresh}) …")
    mask = build_black_mask(bgr, args.black_thresh)
    black_px = int(mask.sum() // 255)
    print(f"  Black pixels: {black_px:,} ({100 * black_px / total_px:.1f}% of image)")

    if black_px == 0:
        print("No black areas found — nothing to do.")
        return

    if args.dry_run:
        print("Dry-run mode, skipping inpainting.")
        if args.preview:
            preview_path = out_path.with_stem(out_path.stem + "_preview")
            dummy = bgr.copy()
            save_preview(bgr, mask, dummy, preview_path)
        return

    # Inpainting large images can be slow; warn if image is very tall.
    if total_px > 5_000_000:
        print(f"  Large image ({total_px:,} px) — inpainting may take a minute …")

    print(f"Inpainting (method={args.method}, radius={args.radius}) …")
    result = inpaint_image(bgr, mask, args.radius, args.method)
    print("  Done.")

    if args.preview:
        preview_path = out_path.with_stem(out_path.stem + "_preview")
        save_preview(bgr, mask, result, preview_path)

    print(f"Saving: {out_path}")
    if not imwrite_unicode(out_path, result):
        raise SystemExit(f"Failed to write {out_path}")
    print("  Saved.")


if __name__ == "__main__":
    main()
