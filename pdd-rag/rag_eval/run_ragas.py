#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rag_eval.llm_factory import create_ragas_evaluator_embeddings, create_ragas_evaluator_llm
from rag_eval.metrics import aggregate_retrieval_scores, score_retrieval
from rag_eval.ragas_prompts_ru import build_ragas_metrics
from rag_eval.reference_loader import EvalCase, attach_reference_contexts, load_dataset
from retrieval.rag_pipeline import get_pipeline, reset_pipeline
from retrieval.vector_store import VectorStore
from retrieval.warmup import warmup_models

EMPTY_RAG_ANSWER = "В предоставленных данных ПДД ответа нет. Попробуйте переформулировать вопрос."


def _chunk_dicts(chunks) -> list[dict]:
    return [
        {
            "text": c.chunk.text,
            "paragraph": c.chunk.metadata.paragraph,
            "section": c.chunk.metadata.section_title,
            "source_type": c.chunk.metadata.source_type,
            "score": c.score,
        }
        for c in chunks
    ]


def _ensure_ready() -> int:
    store = VectorStore()
    count = store.count_points()
    if count <= 0:
        print("Qdrant collection is empty. Running warmup/ingest…")
        warmup_models()
        count = store.count_points()
    if count <= 0:
        raise RuntimeError(
            "Qdrant has no indexed chunks. Start rag-api or run: python -m ingestion.pipeline"
        )
    print(f"Qdrant points: {count}")
    return count


def _cases_to_rows(cases: list[EvalCase], *, attach_refs: bool) -> list[dict]:
    if attach_refs:
        return attach_reference_contexts(cases)
    return [case.__dict__ for case in cases]


def _apply_reranker_flag(reranker: str | None) -> bool:
    """Configure SKIP_RERANKER before pipeline init. Returns True if reranker enabled."""
    if reranker is None:
        return os.environ.get("SKIP_RERANKER", "1") != "1"
    skip = "1" if reranker == "off" else "0"
    os.environ["SKIP_RERANKER"] = skip
    reset_pipeline()
    enabled = reranker == "on"
    print(f"Reranker: {'on' if enabled else 'off'} (SKIP_RERANKER={skip})")
    return enabled


def _build_metadata(*, reranker_enabled: bool, qdrant_points: int, top_k: int) -> dict:
    return {
        "skip_reranker": not reranker_enabled,
        "reranker_enabled": reranker_enabled,
        "llm_provider": os.environ.get("LLM_PROVIDER", "gemini"),
        "generation_model": os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite"),
        "generation_temperature": float(os.environ.get("RAG_EVAL_TEMPERATURE", "0.1")),
        "generation_max_tokens": int(os.environ.get("RAG_EVAL_MAX_TOKENS", "800")),
        "ragas_llm_provider": os.environ.get("RAGAS_LLM_PROVIDER", "mistral"),
        "ragas_judge_model": os.environ.get(
            "RAGAS_MISTRAL_MODEL",
            os.environ.get("MISTRAL_MODEL", "mistral-small-2506"),
        ),
        "ragas_judge_temperature": 0,
        "ragas_prompt_lang": os.environ.get("RAGAS_PROMPT_LANG", "ru"),
        "embedding_model": os.environ.get("EMBEDDING_MODEL", "intfloat/multilingual-e5-base"),
        "reranker_model": os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3"),
        "reranker_threshold": float(os.environ.get("RERANKER_THRESHOLD", "0.3")),
        "top_k": top_k,
        "qdrant_points": qdrant_points,
    }


def _assert_non_empty_retrieval(rows: list[dict]) -> None:
    failures: list[str] = []
    for row in rows:
        if not row.get("retrieved_contexts"):
            failures.append(row["id"])
    if failures:
        raise RuntimeError(
            f"Empty retrieval for {len(failures)} case(s) — RAG pipeline must not fall back. "
            f"IDs: {', '.join(failures)}"
        )


def _assert_generated_answers(rows: list[dict]) -> None:
    failures: list[str] = []
    for row in rows:
        answer = (row.get("answer") or "").strip()
        if not answer:
            failures.append(f"{row['id']}: empty answer")
        elif answer == EMPTY_RAG_ANSWER:
            failures.append(f"{row['id']}: no-context fallback answer")
    if failures:
        raise RuntimeError(
            f"Generation failed for {len(failures)} case(s):\n  " + "\n  ".join(failures)
        )


def run_retrieval_eval(cases: list[dict], *, top_k: int) -> tuple[list[dict], dict[str, float]]:
    pipeline = get_pipeline()
    rows: list[dict] = []
    scores = []

    for case in cases:
        chunks = pipeline.retrieve(
            case["question"],
            error_context=case.get("error_context", ""),
            top_k=top_k,
        )
        chunk_dicts = _chunk_dicts(chunks)
        retrieval = score_retrieval(chunk_dicts, case["reference_paragraphs"])
        scores.append(retrieval)

        rows.append(
            {
                "id": case["id"],
                "category": case["category"],
                "question": case["question"],
                "error_context": case.get("error_context", ""),
                "reference_paragraphs": case["reference_paragraphs"],
                "retrieved_contexts": [c["text"] for c in chunk_dicts],
                "retrieved_paragraphs": [c["paragraph"] for c in chunk_dicts if c.get("paragraph")],
                "reference_contexts": case.get("reference_contexts", []),
                "ground_truth": case["ground_truth"],
                "paragraph_recall_at_k": retrieval.paragraph_recall_at_k,
                "paragraph_precision_at_k": retrieval.paragraph_precision_at_k,
                "any_paragraph_hit": retrieval.any_paragraph_hit,
                "matched_paragraphs": retrieval.matched_paragraphs,
                "missing_paragraphs": retrieval.missing_paragraphs,
            }
        )

    return rows, aggregate_retrieval_scores(scores)


async def _generate_answers(rows: list[dict]) -> None:
    import time

    pipeline = get_pipeline()
    delay = float(os.environ.get("RAG_EVAL_SLEEP_SECS", "4"))
    max_tokens = int(os.environ.get("RAG_EVAL_MAX_TOKENS", "800"))
    for i, row in enumerate(rows, start=1):
        print(f"  Generating [{i}/{len(rows)}] {row['id']}… (max_tokens={max_tokens})")
        result = await pipeline.query(
            row["question"],
            error_context=row.get("error_context", ""),
            mode="error",
            skip_guard=True,
            max_tokens=max_tokens,
        )
        row["answer"] = result.answer
        row["sources"] = result.sources
        if i < len(rows) and delay > 0:
            time.sleep(delay)


def run_ragas_metrics(rows: list[dict], *, with_semantic: bool) -> dict:
    from ragas import EvaluationDataset, evaluate

    evaluator_llm = create_ragas_evaluator_llm()
    prompt_lang = os.environ.get("RAGAS_PROMPT_LANG", "ru").lower()
    print(f"RAGAS judge prompts: {prompt_lang}")
    metrics = build_ragas_metrics(evaluator_llm, lang=prompt_lang)

    if with_semantic:
        from ragas.metrics import SemanticSimilarity

        embeddings = create_ragas_evaluator_embeddings()
        metrics.append(SemanticSimilarity(embeddings=embeddings))

    eval_rows = []
    for row in rows:
        answer = row.get("answer")
        if not answer:
            raise RuntimeError(
                f"Case {row['id']}: missing generated answer — ground_truth fallback is not allowed"
            )
        if not row.get("retrieved_contexts"):
            raise RuntimeError(f"Case {row['id']}: missing retrieved_contexts for RAGAS")
        eval_rows.append(
            {
                "user_input": row["question"],
                "retrieved_contexts": row["retrieved_contexts"],
                "reference": row["ground_truth"],
                "response": answer,
            }
        )

    dataset = EvaluationDataset.from_list(eval_rows)
    results = evaluate(dataset=dataset, metrics=metrics)
    scores = _ragas_to_dict(results)
    _validate_ragas_scores(scores)
    return scores


def _validate_ragas_scores(scores: dict) -> None:
    import math

    if not scores:
        raise RuntimeError("RAGAS returned empty scores")
    bad = [k for k, v in scores.items() if isinstance(v, float) and math.isnan(v)]
    if bad:
        raise RuntimeError(
            f"RAGAS metrics are NaN ({', '.join(bad)}). "
            "Likely LLM quota/rate limit — retry later or set RAGAS_LLM_PROVIDER=groq."
        )


def _ragas_to_dict(results) -> dict:
    """Convert ragas EvaluationResult to plain dict of mean scores."""
    if hasattr(results, "to_pandas"):
        df = results.to_pandas()
        numeric = df.select_dtypes(include="number")
        if not numeric.empty:
            return {col: float(numeric[col].mean()) for col in numeric.columns}
    if hasattr(results, "_scores_dict"):
        raw = results._scores_dict
        if isinstance(raw, dict):
            out: dict = {}
            for key, val in raw.items():
                if isinstance(val, (int, float)):
                    out[str(key)] = float(val)
                elif hasattr(val, "score"):
                    out[str(key)] = float(val.score)
            if out:
                return out
    if isinstance(results, dict):
        return {str(k): float(v) for k, v in results.items() if isinstance(v, (int, float))}
    raise RuntimeError(f"Cannot parse RAGAS results: {type(results)}")


def _print_summary(deterministic: dict[str, float], ragas_scores: dict | None, total: int) -> None:
    print("\n=== Deterministic retrieval metrics ===")
    for key, value in deterministic.items():
        print(f"  {key}: {value:.3f}")

    if ragas_scores:
        print("\n=== RAGAS metrics ===")
        for key, value in ragas_scores.items():
            if isinstance(value, (int, float)):
                print(f"  {key}: {value:.3f}")
            else:
                print(f"  {key}: {value}")

    print(f"\nEvaluated cases: {total}")


def _default_output_dir() -> Path:
    env_dir = os.environ.get("RAG_EVAL_OUTPUT")
    if env_dir:
        return Path(env_dir)
    local = Path(__file__).parent / "results"
    try:
        local.mkdir(parents=True, exist_ok=True)
        probe = local / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return local
    except OSError:
        return Path("/tmp/rag_eval_results")


def _filter_cases(cases: list[dict], category: str | None, limit: int | None) -> list[dict]:
    filtered = cases
    if category:
        filtered = [c for c in filtered if c["category"] == category]
    if limit is not None:
        filtered = filtered[:limit]
    return filtered


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate PDD RAG with deterministic + RAGAS metrics")
    parser.add_argument("--dataset", type=Path, default=Path(__file__).parent / "dataset.json")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--output-suffix", type=str, default=None, help="e.g. no_reranker, with_reranker")
    parser.add_argument("--top-k", type=int, default=int(os.environ.get("RAG_EVAL_TOP_K", "5")))
    parser.add_argument("--category", choices=["analyze", "chat", "koap"], default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--skip-ragas", action="store_true", help="Only deterministic paragraph metrics")
    parser.add_argument("--with-generation", action="store_true", help="Generate answers via RagPipeline.query")
    parser.add_argument(
        "--skip-generation",
        action="store_true",
        help="Skip LLM generation (answers must already be in --from-checkpoint or rows)",
    )
    parser.add_argument(
        "--from-checkpoint",
        type=Path,
        default=None,
        help="Reuse retrieval+answers from a prior checkpoint JSON (RAGAS retry)",
    )
    parser.add_argument(
        "--reranker",
        choices=["on", "off"],
        default=None,
        help="Enable/disable BGE reranker (sets SKIP_RERANKER before pipeline init)",
    )
    parser.add_argument("--with-semantic", action="store_true", help="Add RAGAS SemanticSimilarity metric")
    parser.add_argument("--attach-references", action="store_true", help="Load reference_contexts from Qdrant")
    args = parser.parse_args()
    output_dir = args.output or _default_output_dir()

    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT.parent / "web" / ".env")

    reranker_enabled = _apply_reranker_flag(args.reranker)
    qdrant_points = _ensure_ready()
    metadata = _build_metadata(
        reranker_enabled=reranker_enabled,
        qdrant_points=qdrant_points,
        top_k=args.top_k,
    )

    if not args.skip_ragas and not args.with_generation and not args.skip_generation:
        print("Full RAGAS eval requires --with-generation (auto-enabled).")
        args.with_generation = True

    eval_cases = load_dataset(args.dataset)
    cases = _cases_to_rows(eval_cases, attach_refs=args.attach_references)
    cases = _filter_cases(cases, args.category, args.limit)
    if not cases:
        print("No cases selected.")
        return 1

    if args.from_checkpoint:
        checkpoint = json.loads(args.from_checkpoint.read_text(encoding="utf-8"))
        rows = checkpoint["cases"]
        deterministic = checkpoint["deterministic"]
        print(f"Loaded checkpoint: {args.from_checkpoint} ({len(rows)} cases)")
    else:
        print(f"Running retrieval eval on {len(cases)} cases (top_k={args.top_k})…")
        rows, deterministic = run_retrieval_eval(cases, top_k=args.top_k)
        _assert_non_empty_retrieval(rows)

    ragas_scores = None
    if not args.skip_ragas:
        if not args.skip_generation:
            print("Generating answers via full RAG pipeline (Gemini)…")
            asyncio.run(_generate_answers(rows))
            _assert_generated_answers(rows)
        else:
            print("Skipping generation (--skip-generation); using existing answers.")
            _assert_generated_answers(rows)

        checkpoint_path = output_dir / f"checkpoint_{args.output_suffix or ('with_reranker' if reranker_enabled else 'no_reranker')}.json"
        output_dir.mkdir(parents=True, exist_ok=True)
        checkpoint_path.write_text(
            json.dumps(
                {
                    "deterministic": deterministic,
                    "metadata": metadata,
                    "cases": rows,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Checkpoint saved: {checkpoint_path}")

        print("Running RAGAS judge metrics…")
        ragas_scores = run_ragas_metrics(rows, with_semantic=args.with_semantic)

    _print_summary(deterministic, ragas_scores, len(rows))

    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = args.output_suffix or ("with_reranker" if reranker_enabled else "no_reranker")
    out_file = output_dir / f"rag_eval_{stamp}_{suffix}.json"
    payload = {
        "timestamp": stamp,
        "top_k": args.top_k,
        "category": args.category,
        "metadata": metadata,
        "deterministic": deterministic,
        "ragas": ragas_scores,
        "cases": rows,
    }
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved report: {out_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
