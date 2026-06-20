from __future__ import annotations

import os
from dataclasses import dataclass

from ingestion.chunkers.metadata import Chunk, ChunkMetadata
from retrieval.vector_store import ScoredPoint

DEFAULT_MODEL = os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
SCORE_THRESHOLD = float(os.environ.get("RERANKER_THRESHOLD", "0.3"))


@dataclass
class RankedChunk:
    chunk: Chunk
    score: float


class Reranker:
    def __init__(self, model_name: str | None = None):
        self.model_name = model_name or DEFAULT_MODEL
        self._model = None

    @property
    def model(self):
        if self._model is None:
            if os.environ.get("SKIP_ML_MODELS") == "1":
                raise RuntimeError("ML models disabled")
            from sentence_transformers import CrossEncoder

            self._model = CrossEncoder(self.model_name)
        return self._model

    def rerank(self, query: str, points: list[ScoredPoint], top_k: int = 5) -> list[RankedChunk]:
        if not points:
            return []
        pairs = [(query, p.text) for p in points]
        scores = self.model.predict(pairs)
        ranked = sorted(zip(points, scores), key=lambda x: float(x[1]), reverse=True)
        result: list[RankedChunk] = []
        for point, score in ranked[:top_k]:
            if float(score) < SCORE_THRESHOLD:
                continue
            meta = point.payload
            result.append(
                RankedChunk(
                    chunk=Chunk(
                        text=point.text,
                        metadata=ChunkMetadata(
                            chunk_id=meta.get("chunk_id", point.id),
                            source_type=meta.get("source_type", ""),
                            section_title=meta.get("section_title", ""),
                            paragraph=meta.get("paragraph", ""),
                            law_ref=meta.get("law_ref", ""),
                            source_file="",
                            token_count=0,
                            char_count=len(point.text),
                            title=meta.get("title", ""),
                        ),
                    ),
                    score=float(score),
                )
            )
        return result

_reranker: Reranker | None = None


def get_reranker() -> Reranker:
    global _reranker
    if _reranker is None:
        _reranker = Reranker()
    return _reranker
