from __future__ import annotations

import re

from ingestion.loaders.rtf_loader import PddDocument

ARTICLE_RE = re.compile(r"(12\.\d+(?:\.\d+)?)")


class CsvLoader:
    def __init__(self, path: str, sep: str = ";"):
        self.path = path
        self.sep = sep

    def load(self) -> list[PddDocument]:
        rows = self._read_rows()
        documents: list[PddDocument] = []
        for idx, row in enumerate(rows):
            if idx == 0:
                continue
            if len(row) < 4:
                continue
            article_raw = row[0].strip()
            match = ARTICLE_RE.search(article_raw)
            article = match.group(1) if match else article_raw[:20]
            part = row[1].strip()
            title = row[2].strip()
            sanction = "; ".join(row[3:]).strip()

            text = (
                f"Статья {article} КоАП РФ"
                + (f", {part}" if part else "")
                + f". {title}."
                + (f" Санкция: {sanction}." if sanction else "")
            )

            doc_id = f"fine_{article.replace('.', '_')}_{idx}"
            documents.append(
                PddDocument(
                    id=doc_id,
                    source_type="КоАП",
                    section="Штрафы за нарушения ПДД",
                    paragraph=article,
                    title=title,
                    text=text,
                    law_ref="КоАП РФ",
                    metadata={"part": part, "sanction": sanction},
                )
            )
        return documents

    def _read_rows(self) -> list[list[str]]:
        rows: list[list[str]] = []
        with open(self.path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parts = line.split(self.sep)
                if len(parts) < 4:
                    continue
                rows.append([parts[0], parts[1], parts[2], self.sep.join(parts[3:])])
        return rows
