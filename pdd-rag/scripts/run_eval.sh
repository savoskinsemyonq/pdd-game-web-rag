#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! docker compose ps rag-api --status running -q 2>/dev/null | grep -q .; then
  echo "Starting rag-api and qdrant…"
  docker compose up -d qdrant rag-api
fi

echo "Validating dataset against Qdrant…"
docker compose exec rag-api python -m rag_eval.validate_dataset

echo "Running RAG eval (deterministic + RAGAS)…"
docker compose exec rag-api python -m rag_eval.run_ragas "$@"
