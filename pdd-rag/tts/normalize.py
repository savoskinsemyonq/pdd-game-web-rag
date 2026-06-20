from __future__ import annotations

import re

from num2words import num2words

from tts.abbreviations import expand_abbreviations, expand_standalone_units
from tts.declension import amount_with_unit, expand_years, rubles_to_speech, transport_count_to_speech

P_POINT_RANGE_RE = re.compile(
    r"(?<![\w])п\.?\s*(\d+(?:\.\d+)?(?:\(\d+\))?)\s*[–\-]\s*(\d+(?:\.\d+)?(?:\(\d+\))?)(?![\w])",
    re.IGNORECASE,
)
P_POINT_RE = re.compile(
    r"(?<![\w])п\.?\s*(\d+(?:\.\d+)?(?:\(\d+\))?)(?![\w])",
    re.IGNORECASE,
)
ARTICLE_DATIVE_RE = re.compile(
    r"(?<![\w])по\s+ст\.?\s*(\d+(?:\.\d+)?)(?![\w])",
    re.IGNORECASE,
)
ARTICLE_RE = re.compile(
    r"(?<![\w])ст\.?\s*(\d+(?:\.\d+)?)(?![\w])",
    re.IGNORECASE,
)
PART_RE = re.compile(
    r"(?<![\w])ч\.?\s*(\d+)(?![\w])",
    re.IGNORECASE,
)
SIGN_RE = re.compile(
    r"(?<![\w])знак\s+(\d+(?:\.\d+)?)(?![\w])",
    re.IGNORECASE,
)
RANGE_RE = re.compile(
    r"(?<![\w])(\d+(?:\.\d+)?(?:\(\d+\))?)\s*[–\-]\s*(\d+(?:\.\d+)?(?:\(\d+\))?)(?![\w])",
)
NUMBER_WITH_UNIT_RE = re.compile(
    r"(?<![\w])(\d+(?:[.,]\d+)?)\s*"
    r"(км/ч|км|м/с|м|см|мм|кг|л|ч|мин|руб\.?|%|₽)(?![\w])",
    re.IGNORECASE,
)
DECIMAL_RE = re.compile(r"(?<![\w])(\d+\.\d+(?:\(\d+\))?)(?![\w])")
INTEGER_RE = re.compile(r"(?<![\w])(\d+)(?![\w])")
NUMBER_SIGN_RE = re.compile(r"№\s*(\d+(?:[.,]\d+)?)", re.IGNORECASE)
TS_COUNT_RE = re.compile(r"(?<![\w])(\d+)\s+ТС\b", re.IGNORECASE)

_UNIT_FORMS: dict[str, tuple[tuple[str, str, str], str, bool]] = {
    "км/ч": (("километр", "километра", "километров"), "m", True),
    "км": (("километр", "километра", "километров"), "m", False),
    "м/с": (("метр", "метра", "метров"), "m", False),
    "м": (("метр", "метра", "метров"), "m", False),
    "см": (("сантиметр", "сантиметра", "сантиметров"), "m", False),
    "мм": (("миллиметр", "миллиметра", "миллиметров"), "m", False),
    "кг": (("килограмм", "килограмма", "килограммов"), "m", False),
    "л": (("литр", "литра", "литров"), "m", False),
    "ч": (("час", "часа", "часов"), "m", False),
    "мин": (("минута", "минуты", "минут"), "f", False),
    "%": (("процент", "процента", "процентов"), "m", False),
}


def _int_to_words(value: int) -> str:
    return num2words(value, lang="ru")


def _digits_to_words(fragment: str) -> str:
    return " ".join(_int_to_words(int(char)) for char in fragment if char.isdigit())


def _rule_number_to_words(raw: str) -> str:
    match = re.fullmatch(r"(\d+)(?:\.(\d+))?(?:\((\d+)\))?", raw)
    if not match:
        return raw

    whole, fraction, sub = match.groups()
    parts = [_int_to_words(int(whole))]

    if fraction:
        parts.append("точка")
        parts.append(_digits_to_words(fraction))

    if sub:
        parts.append("подпункт")
        parts.append(_int_to_words(int(sub)))

    return " ".join(parts)


def _number_token_to_words(raw: str) -> str:
    normalized = raw.replace(",", ".")
    if re.fullmatch(r"\d+\.\d+(?:\(\d+\))?", normalized):
        return _rule_number_to_words(normalized)
    if re.fullmatch(r"\d+", normalized):
        return _int_to_words(int(normalized))
    return raw


def _parse_amount(raw: str) -> int:
    return int(float(raw.replace(",", ".")))


def _expand_ts_counts(text: str) -> str:
    return TS_COUNT_RE.sub(lambda match: transport_count_to_speech(int(match.group(1))), text)


def _expand_number_signs(text: str) -> str:
    return NUMBER_SIGN_RE.sub(lambda match: f"номер {_number_token_to_words(match.group(1))}", text)


def _expand_p_points(text: str) -> str:
    text = P_POINT_RANGE_RE.sub(
        lambda match: (
            f"пункт от {_rule_number_to_words(match.group(1))} "
            f"до {_rule_number_to_words(match.group(2))}"
        ),
        text,
    )
    return P_POINT_RE.sub(
        lambda match: f"пункт {_rule_number_to_words(match.group(1))}",
        text,
    )


def _expand_articles(text: str) -> str:
    text = ARTICLE_DATIVE_RE.sub(
        lambda match: f"по статье {_rule_number_to_words(match.group(1))}",
        text,
    )
    return ARTICLE_RE.sub(
        lambda match: f"статья {_rule_number_to_words(match.group(1))}",
        text,
    )


def _expand_parts(text: str) -> str:
    return PART_RE.sub(
        lambda match: f"часть {_int_to_words(int(match.group(1)))}",
        text,
    )


def _expand_signs(text: str) -> str:
    return SIGN_RE.sub(
        lambda match: f"знак {_rule_number_to_words(match.group(1))}",
        text,
    )


def _expand_ranges(text: str) -> str:
    return RANGE_RE.sub(
        lambda match: (
            f"от {_rule_number_to_words(match.group(1))} "
            f"до {_rule_number_to_words(match.group(2))}"
        ),
        text,
    )


def _expand_numbers_with_units(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        amount = _parse_amount(match.group(1))
        unit = match.group(2).lower().rstrip(".")
        if unit in {"руб", "₽"}:
            return rubles_to_speech(amount)

        unit_spec = _UNIT_FORMS.get(unit)
        if unit_spec is None:
            return f"{_number_token_to_words(match.group(1))} {match.group(2)}"

        forms, gender, per_hour = unit_spec
        if unit == "м/с":
            return f"{amount_with_unit(amount, forms, gender=gender)} в секунду"
        return amount_with_unit(amount, forms, gender=gender, per_hour=per_hour)

    return NUMBER_WITH_UNIT_RE.sub(repl, text)


def _expand_decimals(text: str) -> str:
    return DECIMAL_RE.sub(lambda match: _rule_number_to_words(match.group(1)), text)


def _expand_integers(text: str) -> str:
    return INTEGER_RE.sub(lambda match: _int_to_words(int(match.group(1))), text)


def _collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def normalize_for_tts(text: str) -> str:
    """Prepare Russian text for Silero: expand abbreviations and speak numbers aloud."""
    if not text.strip():
        return ""

    result = text.replace("–", "-").replace("—", "-")
    result = _expand_ts_counts(result)
    result = expand_abbreviations(result)
    result = _expand_number_signs(result)
    result = _expand_p_points(result)
    result = _expand_articles(result)
    result = _expand_parts(result)
    result = _expand_signs(result)
    result = _expand_ranges(result)
    result = _expand_numbers_with_units(result)
    result = expand_years(result)
    result = _expand_decimals(result)
    result = _expand_integers(result)
    result = expand_standalone_units(result)
    return _collapse_whitespace(result)
