from __future__ import annotations

from generation.llm_client import get_llm


async def is_pdd_related(query: str) -> bool:
    try:
        llm = get_llm()
    except RuntimeError:
        return True

    try:
        answer = await llm.complete_text(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Определи, относится ли вопрос к теме ПДД, правил дорожного движения, "
                        "штрафов, дорожных знаков или вождения. Ответь только: YES или NO"
                    ),
                },
                {"role": "user", "content": query},
            ],
            max_tokens=8,
        )
        upper = answer.upper()
        return upper.startswith("YES") or "ДА" in upper
    except Exception:
        return True
