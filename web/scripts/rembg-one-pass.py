#!/usr/bin/env python3
"""One PNG through rembg.remove — called from remove-mission2-sprite-background.mjs (--rembg).

Install: pip install -r scripts/requirements-rembg.txt
(first run downloads the ONNX model).
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image
from rembg import remove


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: rembg-one-pass.py input.png output.png", file=sys.stderr)
        sys.exit(2)
    inp = Path(sys.argv[1])
    outp = Path(sys.argv[2])
    img = Image.open(inp).convert("RGBA")
    out = remove(img)
    if out.mode != "RGBA":
        out = out.convert("RGBA")
    outp.parent.mkdir(parents=True, exist_ok=True)
    out.save(outp, format="PNG")


if __name__ == "__main__":
    main()
