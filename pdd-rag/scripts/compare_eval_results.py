#!/usr/bin/env python3
"""Print comparison tables for RAG eval JSON reports (reranker × token limit)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

SUFFIXES = (
    ("no_reranker_t800", "with_reranker_t800"),
    ("no_reranker_t1536", "with_reranker_t1536"),
)


def _latest(results_dir: Path, suffix: str) -> Path | None:
    matches = sorted(results_dir.glob(f"rag_eval_*_{suffix}.json"), reverse=True)
    return matches[0] if matches else None


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _fmt(val) -> str:
    if isinstance(val, (int, float)):
        return f"{val:.3f}"
    return str(val)


def _print_pair_table(title: str, no_r: Path, with_r: Path) -> None:
    a = _load(no_r)
    b = _load(with_r)
    meta = a.get("metadata") or {}
    print(title)
    print(f"  no_reranker:   {no_r.name}")
    print(f"  with_reranker: {with_r.name}")
    if meta:
        print(
            f"  params: prompt_lang={meta.get('ragas_prompt_lang')}, "
            f"gen_max_tokens={meta.get('generation_max_tokens')}, "
            f"judge={meta.get('ragas_judge_model')}"
        )
    print()

    rows: list[tuple[str, str, str]] = []
    for key in sorted(set(a.get("deterministic", {})) | set(b.get("deterministic", {}))):
        rows.append((f"det.{key}", _fmt(a["deterministic"].get(key)), _fmt(b["deterministic"].get(key))))

    ragas_a = a.get("ragas") or {}
    ragas_b = b.get("ragas") or {}
    for key in sorted(set(ragas_a) | set(ragas_b)):
        rows.append((f"ragas.{key}", _fmt(ragas_a.get(key)), _fmt(ragas_b.get(key))))

    if not rows:
        print("  (no metrics)")
        print()
        return

    col_w = max(len(r[0]) for r in rows)
    print(f"  {'Metric':<{col_w}}  {'No reranker':>12}  {'With reranker':>14}")
    print("  " + "-" * (col_w + 30))
    for name, va, vb in rows:
        print(f"  {name:<{col_w}}  {va:>12}  {vb:>14}")
    print()


def main() -> int:
    results_dir = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(__file__).resolve().parents[1] / "rag_eval" / "results"
    )

    ok = True
    for no_suffix, with_suffix in SUFFIXES:
        no_r = _latest(results_dir, no_suffix)
        with_r = _latest(results_dir, with_suffix)
        if not no_r or not with_r:
            print(f"Missing reports for {no_suffix} / {with_suffix} in {results_dir}")
            if no_r:
                print(f"  found: {no_r.name}")
            if with_r:
                print(f"  found: {with_r.name}")
            ok = False
            continue
        token_label = "800" if "t800" in no_suffix else "1536"
        _print_pair_table(f"=== max_tokens={token_label} ===", no_r, with_r)

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
