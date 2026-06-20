#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rag_eval.reference_loader import load_dataset, load_reference_contexts
from retrieval.vector_store import VectorStore
from retrieval.warmup import warmup_models


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate eval dataset against Qdrant index")
    parser.add_argument("--dataset", type=Path, default=Path(__file__).parent / "dataset.json")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT.parent / "web" / ".env")

    store = VectorStore()
    count = store.count_points()
    if count <= 0:
        print("Qdrant empty — running warmup…")
        warmup_models()
        count = store.count_points()

    cases = load_dataset(args.dataset)
    print(f"Dataset cases: {len(cases)}")
    print(f"Qdrant points: {count}\n")

    missing_total = 0
    for case in cases:
        refs = load_reference_contexts(case.reference_paragraphs)
        if not refs:
            missing_total += 1
            print(f"MISSING  {case.id}: paragraphs {case.reference_paragraphs}")
        else:
            print(f"OK       {case.id}: {case.reference_paragraphs} -> {len(refs)} chunk(s)")

    print(f"\nCases without reference chunks in Qdrant: {missing_total}/{len(cases)}")
    return 1 if missing_total else 0


if __name__ == "__main__":
    raise SystemExit(main())
