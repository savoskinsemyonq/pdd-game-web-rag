from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from qdrant_client import QdrantClient

from retrieval.vector_store import COLLECTION, QDRANT_URL

DATASET_PATH = Path(__file__).resolve().parent / "dataset.json"


@dataclass
class EvalCase:
    id: str
    category: str
    question: str
    error_context: str
    reference_paragraphs: list[str]
    ground_truth: str
    mission_id: str | None = None
    scene_id: str | None = None
    tags: list[str] | None = None


def load_dataset(path: Path | None = None) -> list[EvalCase]:
    raw_path = path or DATASET_PATH
    payload = json.loads(raw_path.read_text(encoding="utf-8"))
    cases: list[EvalCase] = []
    for item in payload["cases"]:
        cases.append(
            EvalCase(
                id=item["id"],
                category=item["category"],
                question=item["question"],
                error_context=item.get("error_context", ""),
                reference_paragraphs=list(item.get("reference_paragraphs", [])),
                ground_truth=item["ground_truth"],
                mission_id=item.get("mission_id"),
                scene_id=item.get("scene_id"),
                tags=item.get("tags"),
            )
        )
    return cases


def _normalize_paragraph(value: str) -> str:
    cleaned = value.strip().replace(" ", "").lower()
    # 13.11(1) in game scripts often indexed as 13.11 in Qdrant chunks.
    if "(" in cleaned:
        cleaned = cleaned.split("(", 1)[0]
    return cleaned


def load_reference_contexts(
    paragraphs: list[str],
    *,
    qdrant_url: str | None = None,
    limit_per_paragraph: int = 2,
) -> list[str]:
    """Load gold passage texts from Qdrant by paragraph metadata."""
    if not paragraphs:
        return []

    client = QdrantClient(url=qdrant_url or QDRANT_URL)
    normalized_targets = {_normalize_paragraph(p) for p in paragraphs}
    found: list[str] = []
    seen: set[str] = set()

    offset = None
    while True:
        points, offset = client.scroll(
            collection_name=COLLECTION,
            limit=256,
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        if not points:
            break

        for point in points:
            payload = point.payload or {}
            paragraph = str(payload.get("paragraph", "")).strip()
            if _normalize_paragraph(paragraph) not in normalized_targets:
                continue
            text = str(payload.get("text", "")).strip()
            if not text or text in seen:
                continue
            seen.add(text)
            found.append(text)

        if offset is None:
            break

    if not found:
        return []

    # Prefer shorter unique texts per paragraph when many chunks exist.
    return found[: max(len(paragraphs), limit_per_paragraph * len(paragraphs))]


def attach_reference_contexts(
    cases: list[EvalCase],
    *,
    qdrant_url: str | None = None,
) -> list[dict]:
    rows: list[dict] = []
    for case in cases:
        reference_contexts = load_reference_contexts(
            case.reference_paragraphs,
            qdrant_url=qdrant_url,
        )
        rows.append(
            {
                **case.__dict__,
                "reference_contexts": reference_contexts,
            }
        )
    return rows
