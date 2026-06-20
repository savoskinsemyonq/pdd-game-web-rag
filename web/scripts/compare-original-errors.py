#!/usr/bin/env python3
"""Compare C_ERRORINFO texts in pddv2/scripts vs original «Игра по правилам 2/scripts»."""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ORIGINAL = ROOT.parent / "Игра по правилам 2" / "scripts"
CURRENT = ROOT / "scripts"
OUT_MD = ROOT / "docs" / "pdd-error-text-comparison.md"

# Mirrors audit-pdd-content.py PDD_OVERRIDES — keyed by (scene_id, case)
INTENTIONAL_OVERRIDES: dict[tuple[str, int], str] = {
    ("2.7", 2): (
        "При выезде на перекрёсток с круговым движением (знак 4.3) вы обязаны уступить дорогу "
        "транспортным средствам, уже движущимся по кольцу (п. 13.11(1))."
    ),
}

PENALTY_START = re.compile(
    r"(Предупреждение или штраф|Предупреждение|Штраф|Лишение права управления|Лишение прав)",
    re.IGNORECASE,
)
KOAP_IN_TEXT = re.compile(
    r"\((12\.[\d.]+(?:\s*ч\.?\s*[\d.\-]+(?:\s*[\-–]\s*[\d.]+)?)?)\)",
    re.IGNORECASE,
)


@dataclass
class CaseError:
    node: str
    case: int
    scene_id: str
    error: str
    fine: int | None


@dataclass
class ComparisonRow:
    node: str
    case: int
    scene_id: str
    category: str
    orig_explanation: str
    curr_explanation: str
    orig_sanction: str
    curr_sanction: str
    orig_fine: int | None
    curr_fine: int | None
    reason: str = ""


def read_script(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8", "cp1251", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def extract_scene_id(content: str) -> str:
    m = re.search(r"^-SCENE\s+(\S+)", content, re.MULTILINE)
    return m.group(1) if m else "?"


def extract_case_errors(content: str, node: str) -> list[CaseError]:
    scene_id = extract_scene_id(content)
    out: list[CaseError] = []
    for m in re.finditer(r"CASE\s+(\d+)([\s\S]*?)(?=CASE\s+\d+|END_FILE|$)", content, re.IGNORECASE):
        case = int(m.group(1))
        block = m.group(2)
        em = re.search(r"C_ERRORINFO\s+(.+)", block)
        if not em:
            continue
        fm = re.search(r"fine\s+(-?\d+)", block, re.IGNORECASE)
        out.append(
            CaseError(
                node=node,
                case=case,
                scene_id=scene_id,
                error=em.group(1).strip(),
                fine=int(fm.group(1)) if fm else None,
            )
        )
    return out


def split_explanation_sanction(text: str) -> tuple[str, str]:
    m = PENALTY_START.search(text)
    if not m:
        return text.strip(), ""
    explanation = text[: m.start()].strip(" .")
    sanction = text[m.start() :].strip(" .")
    return explanation, sanction


def normalize_words(text: str) -> str:
    t = text.lower().strip()
    t = re.sub(r"(?<=\w)\(", " (", t)
    t = re.sub(r"\s+\(", " (", t)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"[^\w\s()]", "", t)
    return t


def normalize_for_minor(text: str) -> str:
    t = normalize_words(text)
    t = t.replace("автомобиль", "машина")
    return t


def fine_label(fine: int | None) -> str:
    if fine is None:
        return "—"
    if fine == -1:
        return "лишение (-1)"
    return str(fine)


def find_duplicate_scene_ids(original_dir: Path) -> dict[str, list[str]]:
    by_sid: dict[str, list[str]] = defaultdict(list)
    for p in sorted(original_dir.glob("*/0.script")):
        sid = extract_scene_id(read_script(p))
        by_sid[sid].append(p.parent.name)
    return {k: v for k, v in by_sid.items() if len(v) > 1}


def compare_all(original_dir: Path, current_dir: Path) -> list[ComparisonRow]:
    rows: list[ComparisonRow] = []
    orig_paths = {p.parent.name: p for p in original_dir.glob("*/0.script")}

    for node, orig_path in sorted(orig_paths.items()):
        curr_path = current_dir / node / "0.script"
        if not curr_path.exists():
            continue

        orig_cases = {c.case: c for c in extract_case_errors(read_script(orig_path), node)}
        curr_cases = {c.case: c for c in extract_case_errors(read_script(curr_path), node)}

        for case in sorted(set(orig_cases) & set(curr_cases)):
            o, n = orig_cases[case], curr_cases[case]
            oe, os_ = split_explanation_sanction(o.error)
            ne, ns = split_explanation_sanction(n.error)

            override_key = (n.scene_id, case)
            if override_key in INTENTIONAL_OVERRIDES:
                rows.append(
                    ComparisonRow(
                        node=node,
                        case=case,
                        scene_id=n.scene_id,
                        category="intentional_override",
                        orig_explanation=oe,
                        curr_explanation=ne,
                        orig_sanction=os_,
                        curr_sanction=ns,
                        orig_fine=o.fine,
                        curr_fine=n.fine,
                        reason="PDD_OVERRIDES в audit-pdd-content.py",
                    )
                )
                continue

            if normalize_words(oe) == normalize_words(ne):
                if o.error.strip() == n.error.strip() and o.fine == n.fine:
                    continue
                rows.append(
                    ComparisonRow(
                        node=node,
                        case=case,
                        scene_id=n.scene_id,
                        category="ok_sanction_only",
                        orig_explanation=oe,
                        curr_explanation=ne,
                        orig_sanction=os_,
                        curr_sanction=ns,
                        orig_fine=o.fine,
                        curr_fine=n.fine,
                    )
                )
                continue

            # Minor wording: same meaning after normalization (spacing, synonyms)
            if normalize_for_minor(oe) == normalize_for_minor(ne):
                rows.append(
                    ComparisonRow(
                        node=node,
                        case=case,
                        scene_id=n.scene_id,
                        category="minor_wording",
                        orig_explanation=oe,
                        curr_explanation=ne,
                        orig_sanction=os_,
                        curr_sanction=ns,
                        orig_fine=o.fine,
                        curr_fine=n.fine,
                        reason="мелкая правка формулировки",
                    )
                )
                continue

            # Legacy: punctuation-only diff
            if re.sub(r"[^\w\s]", "", oe.lower()) == re.sub(r"[^\w\s]", "", ne.lower()):
                rows.append(
                    ComparisonRow(
                        node=node,
                        case=case,
                        scene_id=n.scene_id,
                        category="minor_wording",
                        orig_explanation=oe,
                        curr_explanation=ne,
                        orig_sanction=os_,
                        curr_sanction=ns,
                        orig_fine=o.fine,
                        curr_fine=n.fine,
                        reason="мелкая правка формулировки",
                    )
                )
                continue

            reason = ""
            if node == "1-1_3" and case == 2:
                reason = "подмена из-за дубликата SCENE 2.3 + неверный ручной фикс (исправлено)"
            rows.append(
                ComparisonRow(
                    node=node,
                    case=case,
                    scene_id=n.scene_id,
                    category="content_mismatch",
                    orig_explanation=oe,
                    curr_explanation=ne,
                    orig_sanction=os_,
                    curr_sanction=ns,
                    orig_fine=o.fine,
                    curr_fine=n.fine,
                    reason=reason,
                )
            )

    return rows


def esc(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def write_markdown(rows: list[ComparisonRow], original_dir: Path, out_path: Path) -> None:
    dups = find_duplicate_scene_ids(original_dir)
    critical = [r for r in rows if r.category == "content_mismatch"]
    overrides = [r for r in rows if r.category == "intentional_override"]
    minor = [r for r in rows if r.category == "minor_wording"]
    ok = [r for r in rows if r.category == "ok_sanction_only"]

    lines: list[str] = [
        "# Сравнение пояснений C_ERRORINFO с оригинальной игрой",
        "",
        "Источник оригинала: `Игра по правилам 2/scripts`.",
        "Текущая версия: `pddv2/scripts`.",
        "",
        "**Обновление штрафов и санкций по КоАП — нормальное изменение.**",
        "В отчёте «критичными» считаются только расхождения **пояснения правила** (п. ПДД, описание ситуации).",
        "",
        "---",
        "",
        "## Причина подмены текста в 1-1_3 (сцена 1.3)",
        "",
        "1. В оригинальной игре `scripts/1-1_3/0.script` имел `-SCENE 2.3` (legacy ID),",
        "   хотя вопрос про обгон трактора. Тот же `-SCENE 2.3` — у `scripts/2-2_3/0.script`",
        "   (перекрёсток, «уступить обеим машинам»).",
        "2. При первом запуске `audit-pdd-content.py --apply` обновления ключевались по `(scene_id, case)`,",
        "   поэтому текст case 2 из `2-2_3` перезаписал `1-1_3`.",
        "3. После переименования в `-SCENE 1.3` вместо восстановления оригинала был вставлен",
        "   синтезированный текст (трактор + выезд на главную, п. 13.9).",
        "",
        "**Исправление:** восстановлено оригинальное пояснение (п. 11.4, ограниченная видимость)",
        "с актуальной санкцией 12.15 ч.4 (7500 руб. или лишение 4–6 мес.), `fine: -1`.",
        "",
        "---",
        "",
        f"## Критические расхождения пояснения ({len(critical)})",
        "",
    ]

    if critical:
        lines += [
            "| Узел | Case | Сцена | Оригинал (пояснение) | Сейчас (пояснение) | Причина |",
            "|------|------|-------|----------------------|--------------------|---------|",
        ]
        for r in critical:
            lines.append(
                f"| {r.node} | {r.case} | {r.scene_id} | {esc(r.orig_explanation[:120])} | "
                f"{esc(r.curr_explanation[:120])} | {esc(r.reason)} |"
            )
    else:
        lines.append("_Критических расхождений нет._")

    lines += [
        "",
        f"## Намеренные изменения пояснения ({len(overrides)})",
        "",
    ]
    if overrides:
        lines += [
            "| Узел | Case | Сцена | Оригинал | Сейчас |",
            "|------|------|-------|----------|--------|",
        ]
        for r in overrides:
            lines.append(
                f"| {r.node} | {r.case} | {r.scene_id} | {esc(r.orig_explanation[:100])} | "
                f"{esc(r.curr_explanation[:100])} |"
            )
    else:
        lines.append("_Нет._")

    lines += [
        "",
        f"## Мелкие правки формулировки ({len(minor)})",
        "",
    ]
    if minor:
        lines += [
            "| Узел | Case | Оригинал | Сейчас |",
            "|------|------|----------|--------|",
        ]
        for r in minor:
            lines.append(
                f"| {r.node} | {r.case} | {esc(r.orig_explanation[:90])} | {esc(r.curr_explanation[:90])} |"
            )
    else:
        lines.append("_Нет._")

    lines += [
        "",
        f"## Только обновление штрафов / санкций — норма ({len(ok)})",
        "",
        "| Узел | Case | Сцена | Штраф было | Штраф стало | Пояснение (без изменений) |",
        "|------|------|-------|------------|-------------|---------------------------|",
    ]
    for r in ok:
        lines.append(
            f"| {r.node} | {r.case} | {r.scene_id} | {fine_label(r.orig_fine)} | {fine_label(r.curr_fine)} | "
            f"{esc(r.orig_explanation[:80])} |"
        )

    lines += [
        "",
        "---",
        "",
        "## Дубликаты `-SCENE` в оригинальной игре",
        "",
        "| SCENE ID | Узлы |",
        "|----------|------|",
    ]
    for sid, nodes in sorted(dups.items()):
        lines.append(f"| {sid} | {', '.join(nodes)} |")

    lines += [
        "",
        "---",
        "",
        f"_Сгенерировано `web/scripts/compare-original-errors.py`. Всего строк с отличиями: {len(rows)}._",
        "",
    ]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--original",
        type=Path,
        default=Path(os.environ.get("ORIGINAL_SCRIPTS_DIR", DEFAULT_ORIGINAL)),
        help="Path to original game scripts directory",
    )
    parser.add_argument(
        "--current",
        type=Path,
        default=CURRENT,
        help="Path to pddv2 scripts directory",
    )
    parser.add_argument(
        "--write",
        type=Path,
        default=OUT_MD,
        help="Write markdown report to this path",
    )
    parser.add_argument("--json", action="store_true", help="Print summary counts as JSON")
    args = parser.parse_args()

    if not args.original.is_dir():
        print(f"Original scripts dir not found: {args.original}", file=sys.stderr)
        return 1
    if not args.current.is_dir():
        print(f"Current scripts dir not found: {args.current}", file=sys.stderr)
        return 1

    rows = compare_all(args.original, args.current)
    write_markdown(rows, args.original, args.write)

    counts: dict[str, int] = defaultdict(int)
    for r in rows:
        counts[r.category] += 1

    print(f"Wrote {args.write}")
    for cat in ("content_mismatch", "intentional_override", "minor_wording", "ok_sanction_only"):
        print(f"  {cat}: {counts[cat]}")

    if args.json:
        import json

        print(json.dumps(dict(counts), ensure_ascii=False))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
