from __future__ import annotations

import os
from functools import lru_cache

import numpy as np

DEFAULT_EMBEDDING_MODEL = "intfloat/multilingual-e5-base"


def get_embedding_model_name() -> str:
    return os.environ.get("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)


class Embedder:
    def __init__(self, model_name: str | None = None, device: str | None = None, batch_size: int = 32):
        self.model_name = model_name or get_embedding_model_name()
        self.batch_size = batch_size
        self.device = device or ("cuda" if self._has_cuda() else "cpu")
        self._model = None

    @staticmethod
    def _has_cuda() -> bool:
        try:
            import torch

            return torch.cuda.is_available()
        except ImportError:
            return False

    @property
    def model(self):
        if self._model is None:
            if os.environ.get("SKIP_ML_MODELS") == "1":
                raise RuntimeError("ML models disabled (SKIP_ML_MODELS=1)")
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self.model_name, device=self.device)
        return self._model

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        prefixed = [f"passage: {t}" for t in texts]
        return np.array(
            self.model.encode(
                prefixed,
                batch_size=self.batch_size,
                show_progress_bar=len(texts) > 50,
                normalize_embeddings=True,
            )
        )

    def embed_query(self, query: str) -> np.ndarray:
        return np.array(
            self.model.encode(
                f"query: {query}",
                normalize_embeddings=True,
            )
        )

@lru_cache(maxsize=1)
def get_embedder() -> Embedder:
    return Embedder()
