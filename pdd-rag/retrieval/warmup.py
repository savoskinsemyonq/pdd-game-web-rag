from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_warmup_done = False
_warmup_error: str | None = None
_qdrant_points: int | None = None
_embedding_model: str | None = None
_embedding_dim: int | None = None
_qdrant_vector_dim: int | None = None


def is_warmed_up() -> bool:
    return _warmup_done


def get_warmup_error() -> str | None:
    return _warmup_error


def get_qdrant_points() -> int | None:
    return _qdrant_points


def get_embedding_model() -> str | None:
    return _embedding_model


def get_embedding_dim() -> int | None:
    return _embedding_dim


def get_qdrant_vector_dim() -> int | None:
    return _qdrant_vector_dim


def get_tts_ready() -> bool:
    try:
        from tts.silero import is_tts_ready

        return is_tts_ready()
    except Exception:
        return False


def _maybe_auto_ingest(store, expected_vector_size: int) -> None:
    if os.environ.get("AUTO_INGEST", "1") != "1":
        logger.info("Auto-ingest disabled (AUTO_INGEST!=1)")
        return

    points = store.count_points()
    existing_size = store.collection_vector_size()
    if points > 0 and existing_size and existing_size != expected_vector_size:
        logger.warning(
            "Qdrant vector size %d != embedding model %d — resetting collection for re-index",
            existing_size,
            expected_vector_size,
        )
        store.reset_collection()
        points = 0

    if points > 0:
        logger.info("Qdrant already has %d points — skipping auto-ingest", points)
        return

    logger.info("Qdrant is empty — starting auto-ingest…")
    from ingestion.pipeline import run_ingestion

    run_ingestion()
    new_count = store.count_points()
    logger.info("Auto-ingest complete: %d points indexed", new_count)


def warmup_models() -> None:
    """Load ML models at startup so the first chat request is fast."""
    global _warmup_done, _warmup_error, _qdrant_points
    global _embedding_model, _embedding_dim, _qdrant_vector_dim

    if os.environ.get("WARMUP_MODELS", "1") != "1":
        logger.info("Model warmup disabled (WARMUP_MODELS!=1)")
        _warmup_done = True
        return

    if os.environ.get("SKIP_ML_MODELS") == "1":
        logger.info("ML models skipped (SKIP_ML_MODELS=1)")
        _warmup_done = True
        return

    try:
        from retrieval.embedder import get_embedder, get_embedding_model_name

        _embedding_model = get_embedding_model_name()
        logger.info("Loading embedding model %s…", _embedding_model)
        embedder = get_embedder()
        _ = embedder.model
        probe_vec = embedder.embed_query("прогрев модели для поиска по ПДД")
        vector_size = int(probe_vec.shape[0])
        _embedding_dim = vector_size
        logger.info("Embedding model ready: %s (dim=%d)", _embedding_model, vector_size)

        if os.environ.get("SKIP_RERANKER") != "1":
            logger.info("Loading reranker…")
            from retrieval.reranker import get_reranker

            reranker = get_reranker()
            _ = reranker.model
            logger.info("Reranker ready")
        else:
            logger.info("Reranker skipped (SKIP_RERANKER=1)")

        try:
            from retrieval.vector_store import VectorStore

            store = VectorStore()
            store.ensure_collection(vector_size=vector_size)
            _qdrant_vector_dim = store.collection_vector_size()
            logger.info(
                "Qdrant connection OK (collection dim=%s, points=%d)",
                _qdrant_vector_dim,
                store.count_points(),
            )
            _maybe_auto_ingest(store, vector_size)
            _qdrant_points = store.count_points()
            _qdrant_vector_dim = store.collection_vector_size()
            logger.info("Qdrant points: %d", _qdrant_points)
        except Exception as exc:
            logger.warning("Qdrant not ready during warmup: %s", exc)
            _qdrant_points = None

        _warmup_done = True
        _warmup_error = None
        logger.info("RAG models warmup complete")

        if os.environ.get("TTS_WARMUP", "1") != "0":
            from tts.silero import warmup_tts

            warmup_tts()
    except Exception as exc:
        _warmup_done = False
        _warmup_error = str(exc)
        logger.exception("Model warmup failed")
