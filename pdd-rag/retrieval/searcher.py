from __future__ import annotations

from collections import defaultdict

from retrieval.vector_store import ScoredPoint


def rrf_fusion(results_list: list[list[ScoredPoint]], k: int = 60) -> list[ScoredPoint]:
    scores: dict[str, float] = defaultdict(float)
    by_id: dict[str, ScoredPoint] = {}
    for results in results_list:
        for rank, point in enumerate(results):
            key = point.payload.get("chunk_id", point.id)
            scores[key] += 1.0 / (k + rank + 1)
            by_id[key] = point
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [
        ScoredPoint(
            id=by_id[key].id,
            score=score,
            text=by_id[key].text,
            payload=by_id[key].payload,
        )
        for key, score in ranked
    ]
