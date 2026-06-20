from __future__ import annotations

import re

from num2words import num2words

# Длинные предлоги — раньше в alternation.
_GENITIVE_YEAR_PREP = (
    "из-под",
    "перед",
    "после",
    "без",
    "для",
    "при",
    "от",
    "до",
    "со",
    "из",
    "обо",
    "об",
    "во",
    "ко",
    "на",
    "по",
    "в",
    "к",
    "о",
    "у",
    "с",
)

GENITIVE_YEAR_RE = re.compile(
    rf"\b({'|'.join(_GENITIVE_YEAR_PREP)})\s+(\d{{4}})\s*г\.?(?!\w)",
    re.IGNORECASE,
)
NOMINATIVE_YEAR_RE = re.compile(r"(?<![\w])(\d{4})\s*г\.?(?![\w])", re.IGNORECASE)

# (1, 2-4, 5+) + род существительного для «один/одна», «два/две».
UnitForms = tuple[str, str, str]


def _pick_form(count: int, forms: UnitForms) -> str:
    n = abs(int(count)) % 100
    if 11 <= n <= 14:
        return forms[2]
    n = n % 10
    if n == 1:
        return forms[0]
    if 2 <= n <= 4:
        return forms[1]
    return forms[2]


def _cardinal(value: int, *, gender: str = "m") -> str:
    return num2words(value, lang="ru", gender=gender)


def _ordinal_year(value: int, *, genitive: bool = False) -> str:
    if genitive:
        return num2words(value, lang="ru", to="ordinal", case="g")
    return num2words(value, lang="ru", to="ordinal")


def year_to_speech(value: int, *, genitive: bool = False) -> str:
    year_words = _ordinal_year(value, genitive=genitive)
    return f"{year_words} {'года' if genitive else 'год'}"


def amount_with_unit(value: int, forms: UnitForms, *, gender: str = "m", per_hour: bool = False) -> str:
    amount_words = _cardinal(value, gender=gender)
    unit = _pick_form(value, forms)
    if per_hour:
        return f"{amount_words} {unit} в час"
    return f"{amount_words} {unit}"


def transport_count_to_speech(count: int) -> str:
    amount = _cardinal(count, gender="n")
    noun = _pick_form(count, ("транспортное средство", "транспортных средства", "транспортных средств"))
    return f"{amount} {noun}"


def rubles_to_speech(value: int) -> str:
    return amount_with_unit(
        value,
        ("рубль", "рубля", "рублей"),
        gender="m",
    )


def expand_years(text: str) -> str:
    text = GENITIVE_YEAR_RE.sub(
        lambda match: f"{match.group(1)} {year_to_speech(int(match.group(2)), genitive=True)}",
        text,
    )
    return NOMINATIVE_YEAR_RE.sub(
        lambda match: year_to_speech(int(match.group(1)), genitive=False),
        text,
    )
