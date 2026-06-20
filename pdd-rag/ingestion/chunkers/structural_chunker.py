from __future__ import annotations

import re

import tiktoken

from ingestion.chunkers.metadata import Chunk, ChunkMetadata
from ingestion.loaders.rtf_loader import PddDocument

try:
    _ENC = tiktoken.get_encoding("cl100k_base")
except Exception:
    _ENC = None

MAX_TOKENS = 600
MIN_TOKENS = 80


def count_tokens(text: str) -> int:
    if _ENC:
        return len(_ENC.encode(text))
    return max(1, len(text) // 4)


SUBPARAGRAPH_SPLIT = re.compile(r"(?<=\n)([а-яё]\)\s)", re.IGNORECASE)


class PddStructuralChunker:
    def chunk_all(self, documents: list[PddDocument], source_file: str) -> list[Chunk]:
        chunks: list[Chunk] = []
        for doc in documents:
            chunks.extend(self.chunk(doc, source_file))
        return self._merge_small_chunks(chunks)

    def chunk(self, document: PddDocument, source_file: str) -> list[Chunk]:
        header = document.section
        body = document.text
        if document.source_type == "КоАП":
            return [self._make_chunk(document.id, body, document, source_file)]

        tokens = count_tokens(body)
        if tokens <= MAX_TOKENS:
            return [self._make_chunk(document.id, body, document, source_file)]

        parts = SUBPARAGRAPH_SPLIT.split(body)
        if len(parts) <= 1:
            return [self._make_chunk(document.id, body, document, source_file)]

        result: list[Chunk] = []
        for i, part in enumerate(parts):
            part = part.strip()
            if not part:
                continue
            chunk_text = f"{header}\n\n{part}" if not part.startswith(header) else part
            chunk_id = f"{document.id}_sub{i}"
            result.append(self._make_chunk(chunk_id, chunk_text, document, source_file))
        return result

    def _make_chunk(
        self, chunk_id: str, text: str, document: PddDocument, source_file: str
    ) -> Chunk:
        tokens = count_tokens(text)
        return Chunk(
            text=text,
            metadata=ChunkMetadata(
                chunk_id=chunk_id,
                source_type=document.source_type,
                section_title=document.section,
                paragraph=document.paragraph,
                law_ref=document.law_ref,
                source_file=source_file,
                token_count=tokens,
                char_count=len(text),
                title=document.title,
            ),
        )

    def _merge_small_chunks(self, chunks: list[Chunk]) -> list[Chunk]:
        if not chunks:
            return chunks
        merged: list[Chunk] = []
        buffer: Chunk | None = None
        for chunk in chunks:
            if chunk.metadata.token_count >= MIN_TOKENS:
                if buffer:
                    merged.append(buffer)
                    buffer = None
                merged.append(chunk)
                continue
            if buffer is None:
                buffer = chunk
            else:
                combined_text = buffer.text + "\n\n" + chunk.text
                buffer = Chunk(
                    text=combined_text,
                    metadata=ChunkMetadata(
                        chunk_id=buffer.metadata.chunk_id,
                        source_type=buffer.metadata.source_type,
                        section_title=buffer.metadata.section_title,
                        paragraph=buffer.metadata.paragraph,
                        law_ref=buffer.metadata.law_ref,
                        source_file=buffer.metadata.source_file,
                        token_count=count_tokens(combined_text),
                        char_count=len(combined_text),
                        title=buffer.metadata.title,
                    ),
                )
        if buffer:
            merged.append(buffer)
        return merged
