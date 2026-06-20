from __future__ import annotations

import re
from dataclasses import dataclass

from pydantic import BaseModel, Field


class PddDocument(BaseModel):
    id: str
    source_type: str
    section: str
    paragraph: str
    text: str
    law_ref: str
    title: str = ""
    metadata: dict = Field(default_factory=dict)


@dataclass
class ParsedBlock:
    kind: str  # section | paragraph | subparagraph | text
    number: str
    title: str
    lines: list[str]


SECTION_RE = re.compile(
    r"^(\d+)\.\s+([А-ЯЁа-яё][А-ЯЁа-яёA-Za-z ,\-–—]+?)\.?\s*$"
)
PARAGRAPH_RE = re.compile(r"^(\d+\.\d+)\.\s+(.+)$")
SUBPARAGRAPH_RE = re.compile(r"^([а-яё])\)\s+(.+)$", re.IGNORECASE)


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def rtf_to_plain(path: str) -> str:
    from striprtf.striprtf import rtf_to_text

    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    return normalize_text(rtf_to_text(raw))


def parse_pdd_structure(text: str) -> list[PddDocument]:
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    documents: list[PddDocument] = []
    current_section = ""
    current_section_num = ""
    current_paragraph = ""
    current_paragraph_lines: list[str] = []

    def flush_paragraph() -> None:
        nonlocal current_paragraph, current_paragraph_lines
        if not current_paragraph or not current_paragraph_lines:
            current_paragraph = ""
            current_paragraph_lines = []
            return
        body = "\n".join(current_paragraph_lines).strip()
        para_id = current_paragraph.replace(".", "_")
        full_text = f"{current_section}\n\n{current_paragraph}. {body}".strip()
        documents.append(
            PddDocument(
                id=f"pdd_{para_id}",
                source_type="ПДД",
                section=current_section,
                paragraph=current_paragraph,
                title=body.split("\n")[0][:120],
                text=full_text,
                law_ref="Постановление Правительства РФ № 1090",
            )
        )
        current_paragraph = ""
        current_paragraph_lines = []

    for line in lines:
        sec = SECTION_RE.match(line)
        if sec and "." not in sec.group(1):
            flush_paragraph()
            current_section_num = sec.group(1)
            title = sec.group(2).strip().rstrip(".")
            current_section = f"{current_section_num}. {title}"
            continue

        para = PARAGRAPH_RE.match(line)
        if para:
            flush_paragraph()
            current_paragraph = para.group(1)
            rest = para.group(2).strip()
            current_paragraph_lines = [rest] if rest else []
            continue

        if current_paragraph:
            sub = SUBPARAGRAPH_RE.match(line)
            if sub:
                current_paragraph_lines.append(f"{sub.group(1)}) {sub.group(2)}")
            else:
                current_paragraph_lines.append(line)

    flush_paragraph()

    if not documents:
        return fallback_paragraph_chunks(text)

    return documents


def fallback_paragraph_chunks(text: str) -> list[PddDocument]:
    paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 40]
    docs: list[PddDocument] = []
    for i, para in enumerate(paragraphs):
        docs.append(
            PddDocument(
                id=f"pdd_fallback_{i}",
                source_type="ПДД",
                section="ПДД РФ",
                paragraph=str(i + 1),
                title=para[:80],
                text=para,
                law_ref="Постановление Правительства РФ № 1090",
            )
        )
    return docs


class RtfLoader:
    def __init__(self, path: str):
        self.path = path

    def load(self) -> list[PddDocument]:
        plain = rtf_to_plain(self.path)
        return parse_pdd_structure(plain)
