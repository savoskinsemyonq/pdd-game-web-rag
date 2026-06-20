#!/usr/bin/env python3
"""Audit and update game PDD questions/error texts against полные_pdd.rtf and штрафы_ПДД.csv."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PDD_RAG = ROOT / "pdd-rag"
sys.path.insert(0, str(PDD_RAG))

from ingestion.loaders.rtf_loader import parse_pdd_structure, rtf_to_plain  # noqa: E402

DUMP_PATH = ROOT / "game_logic_dump.json"
CSV_PATH = ROOT / "штрафы_ПДД.csv"
RTF_PATH = ROOT / "полные_pdd.rtf"
OUT_MD = ROOT / "docs" / "pdd-content-comparison.md"
UPDATES_JSON = ROOT / "docs" / "pdd-content-updates.json"
BASELINE_JSON = ROOT / "docs" / "pdd-content-baseline.json"

# Legacy sanctions before 2024+ KoAP updates (for baseline reconstruction)
LEGACY_PENALTIES: dict[tuple[str, str], str] = {
    ("12.13", "2"): "Штраф от 100 до 200 рублей (12.13 ч.2).",
    ("12.16", "1"): "Предупреждение или штраф 300 рублей (12.16 ч.1).",
    ("12.16", "2"): "Штраф от 1000 до 1500 рублей (12.16 ч.2).",
    ("12.12", "1"): "Штраф 700 рублей (12.12).",
    ("12.18", ""): "Штраф от 800 до 1000 рублей (12.18).",
    ("12.9", "2"): "Штраф 300 рублей (12.9 ч.2).",
    ("12.10", "1"): "Штраф 500 рублей или лишение права управления транспортным средством на срок от 3 до 6 месяцев (12.10 ч.1).",
    ("12.10", "2"): "Штраф 100 рублей (12.10.2).",
    ("12.15", "1"): "Штраф 500 рублей (12.15 ч.1).",
    ("12.17", "2"): "Штраф от 300 до 500 рублей или лишение права управления транспортным средством на срок от 1 до 3 месяцев (12.17 ч.2).",
    ("12.19", "1"): "Предупреждение или штраф 100 рублей (12.19 ч.1).",
    ("12.14", "3"): "Предупреждение или штраф 100 рублей (12.14 ч.3).",
    ("12.14", "1.1"): "Предупреждение или штраф 100 рублей (12.14.1 ч.1).",
}

LEGACY_FINES: dict[tuple[str, str], int] = {
    ("12.13", "2"): 150,
    ("12.16", "1"): 300,
    ("12.16", "2"): 1500,
    ("12.12", "1"): 700,
    ("12.18", ""): 1000,
    ("12.9", "2"): 300,
    ("12.10", "1"): -1,
    ("12.10", "2"): 100,
    ("12.15", "1"): 500,
    ("12.17", "2"): 500,
    ("12.19", "1"): 100,
    ("12.14", "3"): 100,
    ("12.14", "1.1"): 100,
}

LEGACY_QUESTIONS: dict[str, str] = {
    "2.7": "\\t  Должны ли вы уступить дорогу? \\n 1. Да. \\n 2. Нет.",
}

LEGACY_PDD_ERRORS: dict[tuple[str, int], str] = {
    ("2.7", 2): (
        "Здесь кольцо является главной дорогой, значит, вы должны уступить дорогу "
        "машине, двигающейся по кольцу (п. 13.9). Штраф от 100 до 200 рублей (12.13 ч.2)."
    ),
}

KOAP_IN_TEXT = re.compile(
    r"\((12\.[\d.]+(?:\s*ч\.?\s*[\d.\-]+(?:\s*[\-–]\s*[\d.]+)?)?)\)",
    re.IGNORECASE,
)
PDD_REF = re.compile(r"п\.?\s*([\d()]+(?:\([\d]+\))?)", re.IGNORECASE)
PENALTY_TAIL = re.compile(
    r"(Предупреждение или штраф|Предупреждение|Штраф|Лишение права управления).*$",
    re.IGNORECASE | re.DOTALL,
)
NUM_RANGE = re.compile(
    r"(\d[\d\s]*)\s*(?:-|–|—)\s*(\d[\d\s]*)",
)
NUM_SINGLE = re.compile(r"(\d[\d\s]*)\s*(?:тыс\.?\s*)?руб", re.IGNORECASE)


@dataclass
class KoapEntry:
    article: str
    part: str
    sanction: str
    key: str


@dataclass
class ErrorRow:
    scene_id: str
    scene_file: str
    case: int
    question: str
    old_error: str
    old_fine: int | None
    new_error: str
    new_fine: int | None
    koap_ref: str
    pdd_refs: list[str]
    change_type: str
    pdd_note: str = ""


# Manual PDD explanation overrides (scene_id, case) -> new explanation prefix before sanction
PDD_OVERRIDES: dict[tuple[str, int], str] = {
    ("2.7", 2): (
        "При выезде на перекрёсток с круговым движением (знак 4.3) вы обязаны уступить дорогу "
        "транспортным средствам, уже движущимся по кольцу (п. 13.11(1))."
    ),
}

# Scene question updates
QUESTION_OVERRIDES: dict[str, str] = {
    "2.7": "\\t  Должны ли вы уступить дорогу машине, уже движущейся по кольцу? \\n 1. Да. \\n 2. Нет.",
}


def normalize_koap_ref(raw: str) -> tuple[str, str]:
    s = raw.strip().lower().replace(" ", "")
    s = s.replace("ч.", "ч.").replace("ч", "ч.")
    s = re.sub(r"^12\.", "12.", s)

    fixes = {
        "12.13.2": ("12.13", "2"),
        "12.10.2": ("12.10", "2"),
        "12.19ч1": ("12.19", "1"),
        "12.19ч.1": ("12.19", "1"),
        "12.14.1ч.1": ("12.14", "1.1"),
        "12.12": ("12.12", "1"),
        "12.16": ("12.16", "1"),
        "12.18": ("12.18", ""),
    }
    compact = s.replace("ч.", "").replace(".", "")
    for k, v in fixes.items():
        if s.replace(" ", "") == k.replace(" ", "") or compact == k.replace(".", "").replace("ч", ""):
            return v

    m = re.match(r"12\.(\d+(?:\.\d+)?)(?:ч\.([\d.\-]+))?", s)
    if not m:
        m = re.match(r"12\.(\d+(?:\.\d+)?)(?:ч([\d.\-]+))?", s)
    if not m:
        return raw, ""
    article = f"12.{m.group(1)}"
    part = (m.group(2) or "").strip().lstrip(".")
    if part.endswith("."):
        part = part[:-1]
    return article, part


def load_koap() -> dict[str, KoapEntry]:
    entries: dict[str, KoapEntry] = {}
    with CSV_PATH.open(encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=";")
        next(reader, None)
        for row in reader:
            if len(row) < 4:
                continue
            m = re.search(r"(12\.\d+(?:\.\d+)?)", row[0])
            if not m:
                continue
            article = m.group(1)
            part = row[1].strip().replace("ч.", "").strip()
            sanction = "; ".join(row[3:]).strip()
            key = f"{article}|{part}"
            entries[key] = KoapEntry(article, part, sanction, key)
            # alias for 12.17 ч.2 -> ч.2-3 row
            if part == "2-3":
                entries[f"{article}|2"] = entries[key]
    return entries


def load_pdd() -> dict[str, str]:
    text = rtf_to_plain(str(RTF_PATH))
    docs = parse_pdd_structure(text)
    out: dict[str, str] = {}
    for d in docs:
        out[d.paragraph] = d.text
        # alias 13.11(1) embedded in 13.11 body
        if d.paragraph == "13.11" and "13.11(1)" in d.text:
            m = re.search(r"13\.11\(1\)\.\s*(.+?)(?:\n|$)", d.text)
            if m:
                out["13.11(1)"] = m.group(0)
    return out


def parse_numbers_from_sanction(sanction: str) -> int | None:
    """Mid-range monetary fine; -1 for license revocation."""
    low = sanction.lower()
    if "лишение" in low:
        return -1

    def to_int(num: str, ctx: str) -> int:
        val = int(re.sub(r"\s", "", num))
        if "тыс" in ctx.lower():
            val *= 1000
        return val

    nums: list[int] = []
    for m in NUM_RANGE.finditer(sanction):
        tail = sanction[m.end() : min(len(sanction), m.end() + 20)].lower()
        if re.search(r"мес", tail):
            continue
        ctx = sanction[max(0, m.start() - 5) : min(len(sanction), m.end() + 15)]
        a = to_int(m.group(1), ctx)
        b = to_int(m.group(2), ctx)
        nums.append((a + b) // 2)
    if nums:
        return nums[0]

    for m in NUM_SINGLE.finditer(sanction):
        return to_int(m.group(1), m.group(0))

    return 0


def format_sanction_for_game(koap: KoapEntry) -> str:
    s = koap.sanction.strip()
    if koap.part:
        part_label = koap.part if koap.part.startswith("ч.") else f"ч.{koap.part}"
        ref = f"({koap.article} {part_label})"
    else:
        ref = f"({koap.article})"

    low = s.lower()
    if low.startswith("предупреждение или штраф"):
        body = s[0].upper() + s[1:]
        return f"{body} {ref}"
    if low.startswith("штраф"):
        return f"{s[0].upper() + s[1:]} {ref}"
    if "лишение" in low:
        return f"{s[0].upper() + s[1:]} {ref}"
    return f"Санкция: {s} {ref}"


def extract_koap_from_error(error: str) -> str:
    matches = KOAP_IN_TEXT.findall(error)
    if not matches:
        return ""
    return matches[-1]


def split_explanation_and_penalty(error: str) -> tuple[str, str]:
    m = PENALTY_TAIL.search(error)
    if not m:
        return error.strip(), ""
    return error[: m.start()].strip(), m.group(0).strip()


def build_new_error(
    old_error: str,
    scene_id: str,
    case: int,
    koap_map: dict[str, KoapEntry],
) -> tuple[str, int | None, str, str]:
    koap_raw = extract_koap_from_error(old_error)
    article, part = normalize_koap_ref(koap_raw) if koap_raw else ("", "")
    key = f"{article}|{part}"
    koap = koap_map.get(key)

    explanation, _old_penalty = split_explanation_and_penalty(old_error)
    override = PDD_OVERRIDES.get((scene_id, case))
    if override:
        explanation = override
        pdd_changed = True
    else:
        pdd_changed = False

    if not koap:
        return old_error, None, "без изменений", ""

    new_penalty = format_sanction_for_game(koap)
    new_fine = parse_numbers_from_sanction(koap.sanction)
    expl = explanation.rstrip(".")
    if expl:
        expl += "."
    new_error = f"{expl} {new_penalty}."

    old_fine_guess = parse_numbers_from_sanction(_old_penalty) if _old_penalty else None
    text_changed = old_error.strip() != new_error.strip()
    fine_changed = old_fine_guess != new_fine and new_fine is not None
    penalty_changed = _old_penalty.strip() != new_penalty.strip() if _old_penalty else text_changed

    if override and (penalty_changed or fine_changed):
        change = "ПДД + штраф"
    elif override:
        change = "только ПДД"
    elif pdd_changed and (penalty_changed or fine_changed):
        change = "ПДД + штраф"
    elif penalty_changed or fine_changed or text_changed:
        change = "только штраф"
    else:
        change = "без изменений"

    if change == "без изменений":
        new_error = old_error
        new_fine = None
    elif old_error.strip() == new_error.strip():
        change = "без изменений"
        new_error = old_error
        new_fine = None

    return new_error, new_fine, change, koap_raw


def reverse_to_legacy(
    error: str, fine: int | None, scene_id: str, case: int
) -> tuple[str, int | None]:
    legacy = LEGACY_PDD_ERRORS.get((scene_id, case))
    if legacy:
        return legacy, LEGACY_FINES.get(("12.13", "2"), 150)

    koap_raw = extract_koap_from_error(error)
    if not koap_raw:
        return error, fine
    article, part = normalize_koap_ref(koap_raw)
    key = (article, part)
    legacy_pen = LEGACY_PENALTIES.get(key)
    if not legacy_pen:
        return error, fine
    explanation, _ = split_explanation_and_penalty(error)
    legacy_fine = LEGACY_FINES.get(key, fine)
    expl = explanation.rstrip(".") + "." if explanation else ""
    return f"{expl} {legacy_pen}".replace("..", "."), legacy_fine


def build_baseline_rows(dump: dict) -> list[ErrorRow]:
    koap_map = load_koap()
    rows: list[ErrorRow] = []
    for scene in dump["scenes"]:
        if scene.get("question_text_raw") == "Init":
            continue
        q = scene.get("question_text_raw", "")
        sid = scene["scene_id"]
        for case in scene.get("cases", []):
            err = case.get("error_info")
            if not err:
                continue
            old_err, old_fine = reverse_to_legacy(err, case.get("fine"), sid, case["case"])
            new_err, new_fine, _change, koap_raw = build_new_error(
                old_err, sid, case["case"], koap_map
            )
            cur_err = err
            cur_fine = case.get("fine")
            old_expl, old_pen = split_explanation_and_penalty(old_err)
            cur_expl, cur_pen = split_explanation_and_penalty(cur_err)
            pdd_changed = old_expl.strip() != cur_expl.strip()
            penalty_changed = old_pen.strip() != cur_pen.strip() or old_fine != cur_fine

            if not pdd_changed and not penalty_changed:
                change = "без изменений"
            elif pdd_changed and penalty_changed:
                change = "ПДД + штраф"
            elif pdd_changed:
                change = "только ПДД"
            else:
                change = "только штраф"
            rows.append(
                ErrorRow(
                    scene_id=sid,
                    scene_file=scene["scene_file"],
                    case=case["case"],
                    question=short_question(LEGACY_QUESTIONS.get(sid, q)),
                    old_error=old_err,
                    old_fine=old_fine,
                    new_error=cur_err,
                    new_fine=cur_fine,
                    koap_ref=koap_raw or extract_koap_from_error(cur_err),
                    pdd_refs=list(dict.fromkeys(PDD_REF.findall(cur_err))),
                    change_type=change,
                )
            )
    return rows


def baseline_question_rows(dump: dict) -> list[dict]:
    out = []
    for scene in dump["scenes"]:
        if scene.get("question_text_raw") == "Init" or not scene.get("cases"):
            continue
        sid = scene["scene_id"]
        if sid not in LEGACY_QUESTIONS:
            continue
        out.append(
            {
                "scene_id": sid,
                "scene_file": scene["scene_file"],
                "old": LEGACY_QUESTIONS[sid],
                "new": scene.get("question_text_raw", ""),
                "change_type": "только ПДД",
            }
        )
    return out


def short_question(raw: str) -> str:
    q = raw.replace("\\t", " ").replace("\\n", " ").strip()
    q = re.sub(r"\s+", " ", q)
    return q[:80] + ("…" if len(q) > 80 else "")


def collect_rows(dump: dict, koap_map: dict[str, KoapEntry]) -> list[ErrorRow]:
    rows: list[ErrorRow] = []
    for scene in dump["scenes"]:
        if scene.get("question_text_raw") == "Init":
            continue
        q = scene.get("question_text_raw", "")
        for case in scene.get("cases", []):
            err = case.get("error_info")
            if not err:
                continue
            new_err, new_fine, change, koap_raw = build_new_error(
                err, scene["scene_id"], case["case"], koap_map
            )
            pdd_refs = list(dict.fromkeys(PDD_REF.findall(err)))
            rows.append(
                ErrorRow(
                    scene_id=scene["scene_id"],
                    scene_file=scene["scene_file"],
                    case=case["case"],
                    question=short_question(q),
                    old_error=err,
                    old_fine=case.get("fine"),
                    new_error=new_err,
                    new_fine=new_fine if new_fine is not None else case.get("fine"),
                    koap_ref=koap_raw,
                    pdd_refs=pdd_refs,
                    change_type=change,
                )
            )
    return rows


def collect_question_rows(dump: dict) -> list[dict]:
    out = []
    for scene in dump["scenes"]:
        if scene.get("question_text_raw") == "Init":
            continue
        if not scene.get("cases"):
            continue
        sid = scene["scene_id"]
        old_q = scene.get("question_text_raw", "")
        new_q = QUESTION_OVERRIDES.get(sid, old_q)
        if new_q != old_q:
            out.append(
                {
                    "scene_id": sid,
                    "scene_file": scene["scene_file"],
                    "old": old_q,
                    "new": new_q,
                    "change_type": "только ПДД",
                }
            )
    return out


def apply_updates(dump: dict, rows: list[ErrorRow], question_updates: list[dict]) -> dict:
    err_map = {(r.scene_file, r.case): r for r in rows}
    q_map = {q["scene_id"]: q["new"] for q in question_updates}

    for scene in dump["scenes"]:
        sid = scene["scene_id"]
        if sid in q_map:
            scene["question_text_raw"] = q_map[sid]
            for case in scene.get("cases", []):
                for cmd_i, cmd in enumerate(case.get("commands", [])):
                    if cmd.startswith("TEXT"):
                        case["commands"][cmd_i] = f"TEXT   {q_map[sid]}"

        for case in scene.get("cases", []):
            key = (scene["scene_file"], case["case"])
            row = err_map.get(key)
            if not row or row.change_type == "без изменений":
                continue
            case["error_info"] = row.new_error
            if row.new_fine is not None:
                case["fine"] = row.new_fine
            for cmd_i, cmd in enumerate(case.get("commands", [])):
                if cmd.startswith("C_ERRORINFO"):
                    case["commands"][cmd_i] = f"C_ERRORINFO {row.new_error}"
                elif cmd.startswith("fine ") and row.new_fine is not None:
                    case["commands"][cmd_i] = f"fine {row.new_fine}"
    return dump


def sync_scripts(dump: dict) -> int:
    updated = 0
    for scene in dump["scenes"]:
        script_path = ROOT / scene["scene_file"]
        if not script_path.exists():
            continue
        raw = script_path.read_bytes()
        for enc in ("utf-8", "cp1251", "latin-1"):
            try:
                content = raw.decode(enc)
                break
            except UnicodeDecodeError:
                content = None
        if content is None:
            content = raw.decode("utf-8", errors="replace")

        content = content.replace("\r\n", "\n").replace("\r", "\n")
        orig = content
        if scene.get("question_text_raw") and scene["question_text_raw"] != "Init":
            q = scene["question_text_raw"]
            content = re.sub(
                r"^TEXT\s+.*?(?=^TEXTPOS)",
                f"TEXT   {q}\n",
                content,
                count=1,
                flags=re.MULTILINE | re.DOTALL,
            )

        for case in scene.get("cases", []):
            err = case.get("error_info")
            fine = case.get("fine")
            case_num = case["case"]
            if err:
                pattern = rf"(CASE {case_num}[\s\S]*?)C_ERRORINFO[^\n]*"
                repl = rf"\1C_ERRORINFO {err}"
                new_content = re.sub(pattern, repl, content, count=1)
                if new_content != content:
                    content = new_content
            if fine is not None and err:
                pattern = rf"(CASE {case_num}[\s\S]*?)fine -?\d+"
                repl = rf"\1fine {fine}"
                new_content = re.sub(pattern, repl, content, count=1)
                if new_content != content:
                    content = new_content

        if content != orig:
            script_path.write_text(content, encoding="utf-8")
            updated += 1
    return updated


def write_markdown(rows: list[ErrorRow], question_updates: list[dict]) -> None:
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r.change_type] = counts.get(r.change_type, 0) + 1

    lines = [
        "# Сравнение контента ПДД: было → стало",
        "",
        f"Всего error-веток: **{len(rows)}**",
        "",
        "## Сводка по типам изменений (ошибки)",
        "",
        "| Тип | Количество |",
        "|-----|------------|",
    ]
    for t in ["без изменений", "только штраф", "только ПДД", "ПДД + штраф"]:
        lines.append(f"| {t} | {counts.get(t, 0)} |")

    if question_updates:
        lines.extend(["", "## Изменения вопросов", ""])
        lines.append("| Сцена | Тип | Было | Стало |")
        lines.append("|-------|-----|------|-------|")
        for q in question_updates:
            lines.append(
                f"| {q['scene_id']} | {q['change_type']} | {short_question(q['old'])} | {short_question(q['new'])} |"
            )

    lines.extend(["", "## Все error-ветки", ""])
    lines.append(
        "| Сцена | Вопрос | Case | Тип | fine было | fine стало | КоАП | ПДД п. | Было | Стало |"
    )
    lines.append(
        "|-------|--------|------|-----|-----------|------------|------|--------|------|-------|"
    )

    def esc(s: str) -> str:
        return s.replace("|", "\\|").replace("\n", " ")

    for r in rows:
        pdd = ", ".join(r.pdd_refs[:3])
        lines.append(
            f"| {r.scene_id} | {esc(r.question)} | {r.case} | {r.change_type} | "
            f"{r.old_fine} | {r.new_fine} | {esc(r.koap_ref)} | {esc(pdd)} | "
            f"{esc(r.old_error[:120])}{'…' if len(r.old_error)>120 else ''} | "
            f"{esc(r.new_error[:120])}{'…' if len(r.new_error)>120 else ''} |"
        )

    changed = [r for r in rows if r.change_type != "без изменений"]
    if changed:
        lines.extend(["", "## Подробности изменённых веток", ""])
        for r in changed:
            lines.extend(
                [
                    f"### {r.scene_id} / case {r.case} — {r.change_type}",
                    "",
                    f"**КоАП:** {r.koap_ref or '—'} | **ПДД:** {', '.join(r.pdd_refs) or '—'}",
                    "",
                    f"**Было** (fine={r.old_fine}):",
                    "",
                    f"> {r.old_error}",
                    "",
                    f"**Стало** (fine={r.new_fine}):",
                    "",
                    f"> {r.new_error}",
                    "",
                ]
            )

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Apply updates to dump and scripts")
    parser.add_argument("--sync-scripts", action="store_true", help="Sync scripts from dump")
    parser.add_argument(
        "--report",
        action="store_true",
        help="Generate comparison report from current dump vs reconstructed legacy baseline",
    )
    args = parser.parse_args()

    koap_map = load_koap()
    dump = json.loads(DUMP_PATH.read_text(encoding="utf-8"))

    if args.report or not args.apply:
        rows = build_baseline_rows(dump)
        question_updates = baseline_question_rows(dump)
    else:
        rows = collect_rows(dump, koap_map)
        question_updates = collect_question_rows(dump)

    write_markdown(rows, question_updates)
    updates_payload = {
        "errors": [
            {
                "scene_id": r.scene_id,
                "scene_file": r.scene_file,
                "case": r.case,
                "change_type": r.change_type,
                "old_error": r.old_error,
                "new_error": r.new_error,
                "old_fine": r.old_fine,
                "new_fine": r.new_fine,
            }
            for r in rows
        ],
        "questions": question_updates,
    }
    UPDATES_JSON.parent.mkdir(parents=True, exist_ok=True)
    UPDATES_JSON.write_text(json.dumps(updates_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {OUT_MD}")
    print(f"Wrote {UPDATES_JSON}")
    for t in ["без изменений", "только штраф", "только ПДД", "ПДД + штраф"]:
        n = sum(1 for r in rows if r.change_type == t)
        print(f"  {t}: {n}")

    if args.apply:
        BASELINE_JSON.parent.mkdir(parents=True, exist_ok=True)
        BASELINE_JSON.write_text(
            json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        rows = collect_rows(dump, koap_map)
        question_updates = collect_question_rows(dump)
        dump = apply_updates(dump, rows, question_updates)
        DUMP_PATH.write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Applied updates to {DUMP_PATH}")

    if args.apply or args.sync_scripts:
        n = sync_scripts(json.loads(DUMP_PATH.read_text(encoding="utf-8")))
        print(f"Synced {n} script files")


if __name__ == "__main__":
    main()
