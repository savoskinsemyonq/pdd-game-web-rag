#!/usr/bin/env python3
"""Re-judge an existing RAG eval checkpoint with a different (stronger) judge model.

Reuses retrieval + generated answers from a prior checkpoint (so retrieval and
generation are held FIXED) and only swaps the RAGAS judge LLM. This isolates the
effect of the judge model and lets us cross-validate the metrics reported in the
thesis (judge = mistral-small-2506) against a stronger judge (e.g. Gemini 3.1 Pro).

No Qdrant / generation pipeline is touched.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rag_eval.llm_factory import create_ragas_evaluator_llm
from rag_eval.ragas_prompts_ru import build_ragas_metrics

_LIMIT: int | None = None


def run(checkpoint_path: Path, lang: str, max_workers: int, timeout: int) -> dict:
    from ragas import EvaluationDataset, evaluate
    from ragas.run_config import RunConfig

    data = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    rows = data["cases"]
    if _LIMIT is not None:
        rows = rows[:_LIMIT]

    eval_rows = []
    for row in rows:
        answer = (row.get("answer") or "").strip()
        if not answer:
            raise RuntimeError(f"Case {row['id']}: missing generated answer")
        if not row.get("retrieved_contexts"):
            raise RuntimeError(f"Case {row['id']}: missing retrieved_contexts")
        eval_rows.append(
            {
                "user_input": row["question"],
                "retrieved_contexts": row["retrieved_contexts"],
                "reference": row["ground_truth"],
                "response": answer,
            }
        )

    evaluator_llm = create_ragas_evaluator_llm()
    metrics = build_ragas_metrics(evaluator_llm, lang=lang)

    dataset = EvaluationDataset.from_list(eval_rows)
    run_config = RunConfig(max_workers=max_workers, timeout=timeout, max_retries=10, max_wait=90)
    results = evaluate(dataset=dataset, metrics=metrics, run_config=run_config)

    df = results.to_pandas()
    numeric = df.select_dtypes(include="number")
    scores = {col: float(numeric[col].mean()) for col in numeric.columns}
    return {"scores": scores, "n_cases": len(eval_rows), "per_case": df.to_dict(orient="records")}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--lang", default="ru")
    parser.add_argument("--label", default=None)
    parser.add_argument("--max-workers", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    global _LIMIT
    _LIMIT = args.limit

    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT.parent / "web" / ".env")

    provider = os.environ.get("RAGAS_LLM_PROVIDER", "?")
    judge_model = (
        os.environ.get("RAGAS_GEMINI_MODEL")
        or os.environ.get("RAGAS_GROQ_MODEL")
        or os.environ.get("RAGAS_MISTRAL_MODEL")
        or os.environ.get("RAGAS_OPENAI_MODEL")
        or "?"
    )
    print(f"Judge provider={provider} model={judge_model} lang={args.lang}")
    print(f"Checkpoint: {args.checkpoint}")

    out = run(args.checkpoint, args.lang, args.max_workers, args.timeout)
    out["judge_provider"] = provider
    out["judge_model"] = judge_model
    out["checkpoint"] = str(args.checkpoint)
    out["lang"] = args.lang

    print("\n=== RAGAS scores (judge = {} / {}) ===".format(provider, judge_model))
    for k, v in out["scores"].items():
        print(f"  {k}: {v:.3f}")
    print(f"  n_cases: {out['n_cases']}")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    label = args.label or f"{provider}_{judge_model}".replace("/", "_").replace(":", "_")
    out_file = args.checkpoint.parent / f"rejudge_{stamp}_{label}.json"
    out_file.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {out_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
