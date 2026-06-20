#!/usr/bin/env bash
# Full A/B RAG eval: reranker on/off × max_tokens 800/1536, RU RAGAS judge.
# Run from repo root: bash pdd-rag/scripts/run_full_ab_eval.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CONTAINER="${RAG_EVAL_CONTAINER:-pddv2-rag-api-1}"
RESULTS_HOST="$ROOT/pdd-rag/rag_eval/results"
RESULTS_CONTAINER="/tmp/rag_eval_results"

export LLM_PROVIDER=gemini
export RAGAS_LLM_PROVIDER="${RAGAS_LLM_PROVIDER:-mistral}"
export RAGAS_PROMPT_LANG="${RAGAS_PROMPT_LANG:-ru}"
export RAG_EVAL_SLEEP_SECS="${RAG_EVAL_SLEEP_SECS:-5}"
export RAG_EVAL_TEMPERATURE="${RAG_EVAL_TEMPERATURE:-0.1}"
export RERANKER_THRESHOLD="${RERANKER_THRESHOLD:-0}"
export RAG_EVAL_OUTPUT="$RESULTS_CONTAINER"

mkdir -p "$RESULTS_HOST"

echo "=== Preflight ==="
if ! docker compose ps rag-api --status running -q 2>/dev/null | grep -q .; then
  echo "Starting qdrant + rag-api..."
  docker compose up -d qdrant rag-api
  echo "Waiting for rag-api health..."
  sleep 15
fi

HEALTH=$(curl -sf http://localhost:8000/health || echo "FAIL")
echo "Health: $HEALTH"
if echo "$HEALTH" | grep -q '"qdrant_points":0'; then
  echo "ERROR: Qdrant empty"
  exit 1
fi

echo "Installing eval deps (if needed)..."
docker compose exec rag-api bash /app/scripts/install_eval.sh

echo "Validating dataset..."
docker compose exec rag-api python -m rag_eval.validate_dataset

SMOKE="${SMOKE_ONLY:-0}"
if [ "$SMOKE" = "1" ]; then
  LIMIT="--limit 2"
  echo "=== Smoke test (2 cases each mode) ==="
else
  LIMIT=""
  echo "=== Full eval (45 cases × 4 runs) ==="
fi

run_eval() {
  local reranker_flag="$1"
  local suffix="$2"
  local skip_reranker="$3"
  local max_tokens="$4"
  echo ""
  echo ">>> Run: reranker=$reranker_flag max_tokens=$max_tokens ($suffix)"
  docker compose exec \
    -e SKIP_RERANKER="$skip_reranker" \
    -e RERANKER_THRESHOLD="${RERANKER_THRESHOLD}" \
    -e RAG_EVAL_MAX_TOKENS="$max_tokens" \
    -e RAGAS_PROMPT_LANG="${RAGAS_PROMPT_LANG}" \
    -e LLM_PROVIDER=gemini \
    -e RAGAS_LLM_PROVIDER="${RAGAS_LLM_PROVIDER}" \
    -e RAG_EVAL_OUTPUT="$RESULTS_CONTAINER" \
    rag-api \
    python -m rag_eval.run_ragas \
      --with-generation \
      --reranker "$reranker_flag" \
      --output-suffix "$suffix" \
      $LIMIT
}

run_eval off no_reranker_t800 1 800
run_eval on with_reranker_t800 0 800
run_eval off no_reranker_t1536 1 1536
run_eval on with_reranker_t1536 0 1536

echo ""
echo "=== Copying results to host ==="
docker cp "$CONTAINER:$RESULTS_CONTAINER/." "$RESULTS_HOST/" 2>/dev/null || {
  CID=$(docker compose ps -q rag-api)
  docker cp "$CID:$RESULTS_CONTAINER/." "$RESULTS_HOST/"
}

echo "Results in $RESULTS_HOST"
ls -la "$RESULTS_HOST"/*.json 2>/dev/null || true

echo ""
echo "=== Comparison ==="
python3 "$ROOT/pdd-rag/scripts/compare_eval_results.py" "$RESULTS_HOST" || \
  python "$ROOT/pdd-rag/scripts/compare_eval_results.py" "$RESULTS_HOST"
