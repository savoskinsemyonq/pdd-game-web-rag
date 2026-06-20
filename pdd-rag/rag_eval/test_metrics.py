from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rag_eval.metrics import score_retrieval


def test_paragraph_recall_full_hit() -> None:
    chunks = [
        {"paragraph": "3.2", "text": "3.2. Водители должны уступить дорогу..."},
        {"paragraph": "6.2", "text": "6.2. Красный сигнал запрещает..."},
    ]
    score = score_retrieval(chunks, ["3.2", "6.2"])
    assert score.paragraph_recall_at_k == 1.0
    assert score.any_paragraph_hit


def test_paragraph_recall_partial() -> None:
    chunks = [{"paragraph": "10.3", "text": "10.3. Вне населённого пункта..."}]
    score = score_retrieval(chunks, ["10.3", "10.2"])
    assert score.paragraph_recall_at_k == 0.5
    assert score.missing_paragraphs == ["10.2"]


def test_koap_paragraph_match() -> None:
    chunks = [{"paragraph": "12.12", "text": "Статья 12.12. Проезд на красный..."}]
    score = score_retrieval(chunks, ["12.12"])
    assert score.paragraph_recall_at_k == 1.0


if __name__ == "__main__":
    test_paragraph_recall_full_hit()
    test_paragraph_recall_partial()
    test_koap_paragraph_match()
    print("rag_eval.metrics: all tests passed")
