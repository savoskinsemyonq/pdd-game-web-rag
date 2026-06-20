from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from ingestion.chunkers.metadata import Chunk

COLLECTION = "pdd_chunks"
QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
VECTOR_SIZE = 768  # e5-base; updated on first embed if model size differs


@dataclass
class ScoredPoint:
    id: str
    score: float
    text: str
    payload: dict


class VectorStore:
    def __init__(self, url: str | None = None):
        self.url = url or QDRANT_URL
        self.client = QdrantClient(url=self.url)
        self._vector_size: int | None = None

    def ensure_collection(self, vector_size: int | None = None) -> None:
        size = vector_size or self._vector_size or VECTOR_SIZE
        collections = [c.name for c in self.client.get_collections().collections]
        if COLLECTION not in collections:
            self.client.create_collection(
                collection_name=COLLECTION,
                vectors_config=VectorParams(size=size, distance=Distance.COSINE),
            )
        self._vector_size = size

    def reset_collection(self) -> None:
        collections = [c.name for c in self.client.get_collections().collections]
        if COLLECTION in collections:
            self.client.delete_collection(COLLECTION)

    def upsert(self, chunks: list[Chunk], embeddings: np.ndarray) -> None:
        if len(chunks) == 0:
            return
        self.ensure_collection(vector_size=int(embeddings.shape[1]))
        points = []
        for chunk, vec in zip(chunks, embeddings):
            points.append(
                PointStruct(
                    id=str(uuid.uuid5(uuid.NAMESPACE_URL, chunk.metadata.chunk_id)),
                    vector=vec.tolist(),
                    payload={
                        "chunk_id": chunk.metadata.chunk_id,
                        "text": chunk.text,
                        "source_type": chunk.metadata.source_type,
                        "section_title": chunk.metadata.section_title,
                        "paragraph": chunk.metadata.paragraph,
                        "law_ref": chunk.metadata.law_ref,
                        "title": chunk.metadata.title,
                    },
                )
            )
        self.client.upsert(collection_name=COLLECTION, points=points)

    def collection_vector_size(self) -> int | None:
        try:
            collections = [c.name for c in self.client.get_collections().collections]
            if COLLECTION not in collections:
                return None
            info = self.client.get_collection(COLLECTION)
            vectors = info.config.params.vectors
            if vectors is not None:
                if isinstance(vectors, dict):
                    for params in vectors.values():
                        size = getattr(params, "size", None)
                        if size is not None:
                            return int(size)
                else:
                    size = getattr(vectors, "size", None)
                    if size is not None:
                        return int(size)

            points, _ = self.client.scroll(
                collection_name=COLLECTION,
                limit=1,
                with_vectors=True,
                with_payload=False,
            )
            if not points:
                return None
            vec = points[0].vector
            if isinstance(vec, dict):
                vec = next(iter(vec.values()), None)
            return len(vec) if vec is not None else None
        except Exception:
            return None

    def count_points(self) -> int:
        try:
            collections = [c.name for c in self.client.get_collections().collections]
            if COLLECTION not in collections:
                return 0
            info = self.client.get_collection(COLLECTION)
            return int(info.points_count or 0)
        except Exception:
            return 0

    def search_dense(
        self,
        query_vec: np.ndarray,
        top_k: int = 20,
        filters: dict | None = None,
    ) -> list[ScoredPoint]:
        qdrant_filter = None
        if filters and filters.get("source_type"):
            types = filters["source_type"]
            if isinstance(types, str):
                types = [types]
            qdrant_filter = Filter(
                should=[
                    FieldCondition(key="source_type", match=MatchValue(value=t))
                    for t in types
                ]
            )

        response = self.client.query_points(
            collection_name=COLLECTION,
            query=query_vec.tolist(),
            limit=top_k,
            query_filter=qdrant_filter,
        )
        return [
            ScoredPoint(
                id=str(r.id),
                score=float(r.score or 0),
                text=(r.payload or {}).get("text", ""),
                payload=dict(r.payload or {}),
            )
            for r in response.points
        ]
