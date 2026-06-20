from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes.query import router as query_router
from api.routes.tts import router as tts_router
from retrieval.warmup import (
    get_embedding_dim,
    get_embedding_model,
    get_qdrant_points,
    get_qdrant_vector_dim,
    get_tts_ready,
    get_warmup_error,
    is_warmed_up,
    warmup_models,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting model warmup in background…")
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, warmup_models)
    yield


app = FastAPI(title="PDD RAG API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(query_router, prefix="/api/v1")
app.include_router(tts_router, prefix="/api/v1")


@app.get("/health")
async def health():
    ready = is_warmed_up()
    qdrant_points = get_qdrant_points()
    if qdrant_points is None:
        try:
            from retrieval.vector_store import VectorStore

            qdrant_points = VectorStore().count_points()
        except Exception:
            qdrant_points = None
    return {
        "status": "ok" if ready else "starting",
        "models_ready": ready,
        "tts_ready": get_tts_ready(),
        "warmup_error": get_warmup_error(),
        "qdrant_points": qdrant_points,
        "embedding_model": get_embedding_model(),
        "embedding_dim": get_embedding_dim(),
        "qdrant_vector_dim": get_qdrant_vector_dim(),
    }


@app.get("/api/v1/health")
async def health_v1():
    return await health()
