from __future__ import annotations

from dataclasses import dataclass


def _normalize_paragraph(value: str) -> str:
    cleaned = value.strip().replace(" ", "").lower()
    if "(" in cleaned:
        cleaned = cleaned.split("(", 1)[0]
    return cleaned


def paragraph_in_text(paragraph: str, text: str) -> bool:
    needle = _normalize_paragraph(paragraph)
    hay = text.lower()
    if needle in hay.replace(" ", ""):
        return True
    if paragraph and paragraph in hay:
        return True
    return False


def extract_paragraphs_from_chunks(chunks: list[dict]) -> set[str]:
    refs: set[str] = set()
    for chunk in chunks:
        paragraph = str(chunk.get("paragraph", "")).strip()
        if paragraph:
            refs.add(_normalize_paragraph(paragraph))
        text = str(chunk.get("text", ""))
        for token in ("п. ", "пункт ", "ст. ", "статья "):
            if token in text.lower():
                refs.add(text[:80].lower())
    return refs


@dataclass
class RetrievalScores:
    paragraph_recall_at_k: float
    paragraph_precision_at_k: float
    any_paragraph_hit: bool
    matched_paragraphs: list[str]
    missing_paragraphs: list[str]


def score_retrieval(
    retrieved_chunks: list[dict],
    reference_paragraphs: list[str],
) -> RetrievalScores:
    if not reference_paragraphs:
        return RetrievalScores(0.0, 0.0, False, [], [])

    normalized_refs = [_normalize_paragraph(p) for p in reference_paragraphs]
    matched: list[str] = []
    hit_positions: set[int] = set()

    for idx, chunk in enumerate(retrieved_chunks):
        paragraph = _normalize_paragraph(str(chunk.get("paragraph", "")))
        text = str(chunk.get("text", ""))
        for ref in reference_paragraphs:
            ref_norm = _normalize_paragraph(ref)
            if paragraph == ref_norm or paragraph_in_text(ref, text):
                matched.append(ref)
                hit_positions.add(idx)
                break

    matched_unique = sorted(set(matched), key=reference_paragraphs.index if matched else str)
    missing = [p for p in reference_paragraphs if p not in matched_unique]

    recall = len(matched_unique) / len(reference_paragraphs)
    precision = len(hit_positions) / len(retrieved_chunks) if retrieved_chunks else 0.0

    return RetrievalScores(
        paragraph_recall_at_k=recall,
        paragraph_precision_at_k=precision,
        any_paragraph_hit=len(matched_unique) > 0,
        matched_paragraphs=matched_unique,
        missing_paragraphs=missing,
    )


def aggregate_retrieval_scores(scores: list[RetrievalScores]) -> dict[str, float]:
    if not scores:
        return {
            "paragraph_recall_at_k": 0.0,
            "paragraph_precision_at_k": 0.0,
            "paragraph_hit_rate": 0.0,
        }
    n = len(scores)
    return {
        "paragraph_recall_at_k": sum(s.paragraph_recall_at_k for s in scores) / n,
        "paragraph_precision_at_k": sum(s.paragraph_precision_at_k for s in scores) / n,
        "paragraph_hit_rate": sum(1 for s in scores if s.any_paragraph_hit) / n,
    }
