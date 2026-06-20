from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass

from generation.llm_client import get_llm
from generation.prompt_builder import build_messages, chunks_to_sources
from ingestion.chunkers.metadata import Chunk, ChunkMetadata
from retrieval.embedder import get_embedder
from retrieval.guardrails import is_pdd_related
from retrieval.reranker import RankedChunk, get_reranker
from retrieval.vector_store import VectorStore

logger = logging.getLogger(__name__)

OFF_TOPIC = "Я отвечаю только на вопросы по Правилам дорожного движения РФ."


@dataclass
class RagResult:
    answer: str
    sources: list[dict]
    query_id: str
    latency_ms: int


class RagPipeline:
    def __init__(self):
        self.embedder = get_embedder()
        self.store = VectorStore()
        self._reranker = None
        self.llm = get_llm()

    @property
    def reranker(self):
        if os.environ.get("SKIP_RERANKER") == "1":
            return None
        if self._reranker is None:
            self._reranker = get_reranker()
        return self._reranker

    def retrieve(
        self,
        query: str,
        *,
        error_context: str = "",
        filters: dict | None = None,
        top_k: int = 5,
    ) -> list[RankedChunk]:
        rag_query = f"{error_context} {query}".strip()
        try:
            vec = self.embedder.embed_query(rag_query)
            points = self.store.search_dense(vec, top_k=20, filters=filters)
            if os.environ.get("SKIP_RERANKER") == "1" or self.reranker is None:
                return [
                    RankedChunk(
                        chunk=Chunk(
                            text=p.text,
                            metadata=ChunkMetadata(
                                chunk_id=p.payload.get("chunk_id", p.id),
                                source_type=p.payload.get("source_type", ""),
                                section_title=p.payload.get("section_title", ""),
                                paragraph=p.payload.get("paragraph", ""),
                                law_ref=p.payload.get("law_ref", ""),
                                source_file="",
                                token_count=0,
                                char_count=len(p.text),
                                title=p.payload.get("title", ""),
                            ),
                        ),
                        score=float(p.score),
                    )
                    for p in points[:top_k]
                ]
            return self.reranker.rerank(rag_query, points, top_k=top_k)
        except Exception as exc:
            logger.warning("RAG retrieve failed: %s", exc)
            return []

    async def query(
        self,
        query: str,
        *,
        error_context: str = "",
        mode: str = "error",
        filters: dict | None = None,
        skip_guard: bool = False,
        max_tokens: int | None = None,
    ) -> RagResult:
        start = time.perf_counter()
        query_id = str(uuid.uuid4())

        if not skip_guard and not await is_pdd_related(query):
            return RagResult(
                answer=OFF_TOPIC,
                sources=[],
                query_id=query_id,
                latency_ms=int((time.perf_counter() - start) * 1000),
            )

        chunks = self.retrieve(query, error_context=error_context, filters=filters)
        if not chunks:
            return RagResult(
                answer="В предоставленных данных ПДД ответа нет. Попробуйте переформулировать вопрос.",
                sources=[],
                query_id=query_id,
                latency_ms=int((time.perf_counter() - start) * 1000),
            )

        messages = build_messages(
            query, chunks, mode=mode, error_context=error_context
        )
        answer = await self.llm.complete_text(
            messages,
            max_tokens=max_tokens if max_tokens is not None else 800,
        )
        return RagResult(
            answer=answer,
            sources=chunks_to_sources(chunks),
            query_id=query_id,
            latency_ms=int((time.perf_counter() - start) * 1000),
        )

    async def stream_query(
        self,
        query: str,
        *,
        error_context: str = "",
        mode: str = "error",
        filters: dict | None = None,
        skip_guard: bool = False,
    ):
        start = time.perf_counter()
        query_id = str(uuid.uuid4())

        if not skip_guard and not await is_pdd_related(query):
            yield {"type": "chunk", "text": OFF_TOPIC}
            yield {"type": "done", "query_id": query_id}
            return

        chunks = self.retrieve(query, error_context=error_context, filters=filters)
        sources = chunks_to_sources(chunks)
        if sources:
            yield {"type": "sources", "sources": sources}

        if not chunks:
            yield {
                "type": "chunk",
                "text": "В предоставленных данных ПДД ответа нет. Попробуйте переформулировать вопрос.",
            }
            yield {"type": "done", "query_id": query_id}
            return

        messages = build_messages(
            query, chunks, mode=mode, error_context=error_context
        )
        async for delta in self.llm.stream_text(messages):
            yield {"type": "chunk", "text": delta}

        yield {
            "type": "done",
            "query_id": query_id,
            "latency_ms": int((time.perf_counter() - start) * 1000),
        }


_pipeline: RagPipeline | None = None


def reset_pipeline() -> None:
    global _pipeline
    _pipeline = None


def get_pipeline() -> RagPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = RagPipeline()
    return _pipeline
