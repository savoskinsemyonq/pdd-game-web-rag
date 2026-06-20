from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from ingestion.chunkers.structural_chunker import PddStructuralChunker
from ingestion.loaders.csv_loader import CsvLoader
from ingestion.loaders.rtf_loader import RtfLoader
from retrieval.embedder import Embedder
from retrieval.vector_store import VectorStore

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
PDD_PATH = Path(os.environ.get("PDD_PATH", DATA_DIR / "pdd.rtf"))
FINES_PATH = Path(os.environ.get("FINES_PATH", DATA_DIR / "fines.csv"))


def resolve_data_paths() -> tuple[Path, Path]:
    repo_root = Path(__file__).resolve().parents[2]
    pdd = PDD_PATH if PDD_PATH.exists() else repo_root / "полные_pdd.rtf"
    fines = FINES_PATH if FINES_PATH.exists() else repo_root / "штрафы_ПДД.csv"
    return pdd, fines


def run_ingestion(*, dry_run: bool = False, reset: bool = False) -> None:
    pdd_path, fines_path = resolve_data_paths()
    logger.info("Loading PDD from %s", pdd_path)
    logger.info("Loading fines from %s", fines_path)

    if not pdd_path.exists():
        raise FileNotFoundError(f"PDD file not found: {pdd_path}")
    if not fines_path.exists():
        raise FileNotFoundError(f"Fines file not found: {fines_path}")

    pdd_docs = RtfLoader(str(pdd_path)).load()
    fine_docs = CsvLoader(str(fines_path)).load()
    logger.info("Loaded %d PDD docs, %d fine docs", len(pdd_docs), len(fine_docs))

    chunker = PddStructuralChunker()
    chunks = chunker.chunk_all(pdd_docs, pdd_path.name)
    chunks.extend(chunker.chunk_all(fine_docs, fines_path.name))
    logger.info("Created %d chunks", len(chunks))

    by_type: dict[str, int] = {}
    for c in chunks:
        by_type[c.metadata.source_type] = by_type.get(c.metadata.source_type, 0) + 1
    for source_type, count in by_type.items():
        logger.info("  %s: %d chunks", source_type, count)

    token_stats = [c.metadata.token_count for c in chunks]
    if token_stats:
        logger.info(
            "Token stats: min=%d avg=%d max=%d",
            min(token_stats),
            sum(token_stats) // len(token_stats),
            max(token_stats),
        )

    if dry_run:
        logger.info("Dry run — skipping index write")
        return

    embedder = Embedder()
    texts = [c.text for c in chunks]
    logger.info("Embedding %d chunks...", len(texts))
    embeddings = embedder.embed_documents(texts)

    store = VectorStore()
    if reset:
        store.reset_collection()
    store.ensure_collection()
    store.upsert(chunks, embeddings)
    logger.info("Indexed %d chunks into Qdrant", len(chunks))


def main() -> None:
    parser = argparse.ArgumentParser(description="PDD RAG ingestion pipeline")
    parser.add_argument("--dry-run", action="store_true", help="Show stats without indexing")
    parser.add_argument("--reset", action="store_true", help="Reset Qdrant collection before upload")
    args = parser.parse_args()
    run_ingestion(dry_run=args.dry_run, reset=args.reset)


if __name__ == "__main__":
    main()
