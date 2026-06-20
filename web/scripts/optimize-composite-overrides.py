"""Shrink committed `*-composite.overrides.json` files.

Editor exports use indented JSON; thousands of small painted surfaces turn into
multi-megabyte files with ~1 line per coordinate. This script:

  - rounds floats (default 2 fractional digits; enough at world-map scale)
  - writes compact JSON (no extra whitespace)

Does not change polygon topology or merge shapes — only serialization."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def round_float(x: float, ndigits: int) -> float | int:
    r = round(x, ndigits)
    if float(r).is_integer():
        return int(r)
    return r


def round_deep(obj: object, ndigits: int) -> object:
    if isinstance(obj, float):
        return round_float(obj, ndigits)
    if isinstance(obj, list):
        return [round_deep(v, ndigits) for v in obj]
    if isinstance(obj, dict):
        return {k: round_deep(v, ndigits) for k, v in obj.items()}
    return obj


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "path",
        type=Path,
        nargs="?",
        default=Path(__file__).resolve().parent.parent / "public/maps/mission2/mission2-composite.overrides.json",
        help="Overrides JSON path",
    )
    parser.add_argument(
        "--ndigits",
        type=int,
        default=2,
        help="Decimal places for floats (default 2)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print sizes only; do not write",
    )
    args = parser.parse_args()
    path: Path = args.path
    if not path.is_file():
        raise SystemExit(f"not found: {path}")

    raw_in = path.read_text(encoding="utf-8")
    data = json.loads(raw_in)
    data = round_deep(data, args.ndigits)
    raw_out = json.dumps(data, ensure_ascii=False, separators=(",", ":"))

    in_lines = raw_in.count("\n") + (0 if raw_in.endswith("\n") else 1)
    print(f"[optimize] {path}")
    print(f"  bytes: {len(raw_in):,} -> {len(raw_out):,} ({100 * len(raw_out) / len(raw_in):.1f}%)")
    print(f"  lines: {in_lines:,} -> {raw_out.count(chr(10)) + 1:,}")

    if args.dry_run:
        return

    path.write_text(raw_out + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
