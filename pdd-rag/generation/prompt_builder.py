from __future__ import annotations

from retrieval.reranker import RankedChunk

SYSTEM_BASE = """Ты — эксперт по Правилам дорожного движения Российской Федерации.
Отвечай СТРОГО на основе предоставленных фрагментов ПДД.
Правила:
1. Если ответ есть в контексте — дай чёткий ответ и укажи пункт ПДД или статью КоАП.
2. Если информации недостаточно — скажи "В предоставленных данных ПДД ответа нет."
3. НЕ добавляй информацию из своих знаний — только из контекста.
4. Форматируй ответ: сначала суть (1-2 предложения), затем детали.
5. Всегда указывай ссылку: "Согласно п. X.X ПДД РФ" или "Статья X.X КоАП РФ".
"""

KID_ERROR_EXTRA = """
Ты — инспектор ГИБДД. Аудитория: школьники 10–17 лет.
Правила ответа:
- Кратко и по делу: 2–3 коротких предложения (первый ответ — максимум 3).
- Пиши обычным текстом: без markdown, без **, *, #, __ и других знаков форматирования.
- Сначала суть: что не так и как правильно.
- Один пункт ПДД в конце, без воды и юридического языка.
- Не запугивай — акцент на безопасности.
"""

KID_ANALYSIS_EXTRA = """
Ты — инспектор ГИБДД. Аудитория: школьники 10–17 лет.
Правила ответа:
- Кратко и по делу: 2–3 коротких предложения.
- Пиши обычным текстом: без markdown, без **, *, #, __ и других знаков форматирования.
- Сначала суть: что не так и как правильно.
- Один пункт ПДД в конце, без воды и юридического языка.
- Не повторяй вопрос ученика. Не лекции.
"""


def build_context_xml(chunks: list[RankedChunk], max_tokens: int = 3000) -> str:
    parts: list[str] = []
    total = 0
    for ranked in sorted(chunks, key=lambda c: c.score, reverse=True):
        meta = ranked.chunk.metadata
        block = (
            f'<source id="{meta.chunk_id}" paragraph="{meta.paragraph}">'
            f"{ranked.chunk.text}</source>"
        )
        est = len(block) // 4
        if total + est > max_tokens:
            break
        parts.append(block)
        total += est
    return "\n".join(parts)


def build_messages(
    query: str,
    chunks: list[RankedChunk],
    *,
    mode: str = "error",
    error_context: str = "",
) -> list[dict[str, str]]:
    context = build_context_xml(chunks)
    extra = KID_ERROR_EXTRA if mode == "error" else KID_ANALYSIS_EXTRA
    system = SYSTEM_BASE + extra
    if error_context:
        system += f"\n\nКонтекст ошибки / анализа ученика:\n{error_context}"
    if context:
        system += f"\n\nФрагменты ПДД:\n{context}"

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": query},
    ]


def chunks_to_sources(chunks: list[RankedChunk]) -> list[dict]:
    sources = []
    seen: set[str] = set()
    for ranked in chunks:
        meta = ranked.chunk.metadata
        key = meta.chunk_id
        if key in seen:
            continue
        seen.add(key)
        sources.append(
            {
                "paragraph": meta.paragraph,
                "section": meta.section_title,
                "source_type": meta.source_type,
                "score": ranked.score,
            }
        )
    return sources
