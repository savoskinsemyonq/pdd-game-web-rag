from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from retrieval.rag_pipeline import get_pipeline

router = APIRouter()


class QueryRequest(BaseModel):
    query: str
    error_context: str = ""
    mode: str = "error"
    stream: bool = True
    filters: dict[str, Any] | None = None
    skip_guard: bool = False


class RetrieveRequest(BaseModel):
    query: str
    error_context: str = ""
    top_k: int = 5
    filters: dict[str, Any] | None = None


@router.post("/query")
async def query_endpoint(body: QueryRequest):
    pipeline = get_pipeline()
    query = body.query.strip()
    if not query:
        return {"answer": "", "sources": [], "query_id": ""}

    if body.stream:
        async def event_stream():
            async for event in pipeline.stream_query(
                query,
                error_context=body.error_context,
                mode=body.mode,
                filters=body.filters,
                skip_guard=body.skip_guard,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    result = await pipeline.query(
        query,
        error_context=body.error_context,
        mode=body.mode,
        filters=body.filters,
        skip_guard=body.skip_guard,
    )
    return {
        "answer": result.answer,
        "sources": result.sources,
        "query_id": result.query_id,
        "latency_ms": result.latency_ms,
    }


@router.post("/retrieve")
async def retrieve_endpoint(body: RetrieveRequest):
    pipeline = get_pipeline()
    chunks = pipeline.retrieve(
        body.query,
        error_context=body.error_context,
        filters=body.filters,
        top_k=body.top_k,
    )
    return {
        "chunks": [
            {
                "text": c.chunk.text,
                "paragraph": c.chunk.metadata.paragraph,
                "section": c.chunk.metadata.section_title,
                "source_type": c.chunk.metadata.source_type,
                "score": c.score,
            }
            for c in chunks
        ]
    }
